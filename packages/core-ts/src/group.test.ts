import { describe, expect, it } from 'vitest';

import {
  bytesToHex,
  canonicalize,
  hexToBytes,
  openWithNonce,
  randomBytes,
  sign,
  utf8,
} from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, MemoryStorage } from './fakes';
import type { Adapters } from './platform/adapter';
import { deviceKek, ensureLocalIdentity } from './identity';
import { CommentError, flushPending } from './comment';
import { decodeUtf8 } from './sync';
import { sealText } from './wire';
import {
  GROUP_KEY_STALE_NOTICE,
  GroupError,
  acceptInvite,
  buildRosterRequest,
  createGroup,
  decodeInvite,
  decodeRosterRequest,
  dissolveGroup,
  encodeInvite,
  encodeRosterRequest,
  fetchGroupMessages,
  governorSeats,
  joinOpenGroup,
  leaveGroup,
  openEnvelope,
  postGroupMessage,
  readSigReceipt,
  removeMember,
  renameGroup,
  resolveKeyChain,
  rotateGroup,
  sealEnvelope,
  signSigRequest,
  submitRoster,
  type GroupEnvelope,
  type GroupOptions,
  type RosterDraft,
} from './group';

const BASE = 'https://node.test';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function fixture() {
  const http = new FakeHttp();
  const storage = new MemoryStorage();
  const repo = new MemoryRepo();
  const adapters: Adapters = { fs: new MemoryFs(), storage, http, packReader: new FakePackReader() };
  const o: GroupOptions = { adapters, repo, nodeBaseUrl: BASE };
  return { http, storage, repo, o };
}

/**
 * 可开关的「网络不可达」模拟（AC 1 / AC 8）：只挡 http，本地存储与仓储照常走。
 * 照 `comment.test.ts:48-59` 的 `gatePost` 写法——**同一个 `o` 先离线后联网**，不重建 fixture
 * （重建会丢掉 `MemoryStorage`，也就丢了本机身份与组密钥）。
 */
function gateOffline(o: GroupOptions): { offline: boolean } {
  const real = o.adapters.http;
  const state = { offline: true };
  o.adapters.http = {
    get: (url, headers) => (state.offline ? Promise.reject(new Error('断网')) : real.get(url, headers)),
    post: (url, body, headers) => (state.offline ? Promise.reject(new Error('断网')) : real.post(url, body, headers)),
    put: (url, body, headers) => (state.offline ? Promise.reject(new Error('断网')) : real.put(url, body, headers)),
  };
  return state;
}

/** 用自己的设备 KEK 解开 `group_keys.key_cipher`，回原始 32 字节 hex（AC 1 的「组密钥相同」判定）。 */
async function groupKeyHex(storage: MemoryStorage, cipher: string): Promise<string> {
  const kek = await deviceKek(storage);
  const [n, ct] = cipher.split(':');
  return bytesToHex(openWithNonce(kek, hexToBytes(n!), hexToBytes(ct!)));
}

/** 节点读接口的桩响应（含 v2 的五个 group 字段）。 */
function groupPage(
  groupId: string,
  creatorId: string,
  epoch: number,
  memberIds: string[],
  envelopes: GroupEnvelope[] = [],
  events: Array<Record<string, unknown>> = [],
) {
  return json({
    group: {
      group_id: groupId,
      creator_id: creatorId,
      epoch,
      member_ids: memberIds,
      name: '读书',
      encrypted: 1,
      roster_rev: epoch,
      seat_count: 1,
      governors: [creatorId],
      envelopes: envelopes.map((e) => ({ from_epoch: e.fromEpoch, cipher: e.cipher })),
    },
    events,
    next_cursor: null,
  });
}

/** 手工构造一张 **v1 老码**（9 键签名域，无 encrypted / roster_rev / history_keys）。 */
async function legacyInviteV1(storage: MemoryStorage, groupId: string, keyHex: string, name: string): Promise<string> {
  const ident = await ensureLocalIdentity(storage);
  const createdAt = Date.now();
  const fields = {
    v: 1,
    group_id: groupId,
    target_id: `group/${groupId}`,
    name,
    epoch: 1,
    group_key: keyHex,
    creator_id: ident.id,
    creator_pub: ident.pubHex,
    created_at: createdAt,
  };
  const sig = sign(ident.seedHex, utf8(canonicalize(fields)));
  return encodeInvite({
    v: 1,
    groupId,
    targetId: `group/${groupId}`,
    name,
    epoch: 1,
    groupKeyHex: keyHex,
    creatorId: ident.id,
    creatorPubHex: ident.pubHex,
    createdAt,
    sig,
  });
}

/**
 * 造一个「两人圈」：A 建圈（离线出码），再把名单补成 [创建者, B]。
 * 六个便捷入口都在**本地行**上读名单，故 remove / leave 需要第二名成员才不至于把名单清空
 * （空名单只有 dissolve 放行）。
 */
async function twoMemberGroup(): Promise<{
  a: ReturnType<typeof fixture>;
  gid: string;
  creatorId: string;
  bId: string;
}> {
  const a = fixture();
  gateOffline(a.o);
  const created = await createGroup(a.o, { name: '读书', encrypted: true });
  const bId = (await ensureLocalIdentity(fixture().storage)).id;
  await a.repo.saveGroup({
    ...created.group,
    memberIdsJson: JSON.stringify([created.group.creatorId, bId]),
  });
  return { a, gid: created.group.groupId, creatorId: created.group.creatorId, bId };
}

describe('group', () => {
  it('AC 1：A 断网建圈出码，B 断网粘码入圈，双方 epoch 与组密钥一致', async () => {
    const a = fixture();
    gateOffline(a.o);
    const created = await createGroup(a.o, { name: '夜间读书', encrypted: true });

    expect(created.queued).toBe(true); // 断网 → roster 入队，但邀请码已可用
    expect(created.inviteCode.startsWith('base1:')).toBe(true);
    expect(created.group.groupId).toMatch(/^[0-9a-f]{32}$/); // 16 字节，与 event_id 同形
    expect(created.group.encrypted).toBe(1);
    expect(created.group.rosterRev).toBe(1);

    const b = fixture();
    gateOffline(b.o); // 入圈**全程零网络**
    const joined = await acceptInvite(b.o, created.inviteCode);

    expect(joined.renewed).toBe(true);
    expect(joined.group.groupId).toBe(created.group.groupId);
    expect(joined.group.epoch).toBe(1);
    expect(joined.group.creatorId).toBe(created.group.creatorId);
    expect(joined.group.encrypted).toBe(1);

    const ka = await a.repo.listGroupKeys(created.group.groupId);
    const kb = await b.repo.listGroupKeys(created.group.groupId);
    expect(kb).toHaveLength(1);
    expect(kb[0]!.epoch).toBe(ka[0]!.epoch);
    expect(await groupKeyHex(b.storage, kb[0]!.keyCipher)).toBe(await groupKeyHex(a.storage, ka[0]!.keyCipher));
  });

  it('AC 2：篡改 group_key 任一字符 → 入圈被拒，文案统一', async () => {
    const a = fixture();
    gateOffline(a.o);
    const created = await createGroup(a.o, { name: '读书', encrypted: true });

    const inv = decodeInvite(created.inviteCode);
    const flipped = inv.groupKeyHex[0] === 'a' ? 'b' + inv.groupKeyHex.slice(1) : 'a' + inv.groupKeyHex.slice(1);
    expect(() => decodeInvite(encodeInvite({ ...inv, groupKeyHex: flipped }))).toThrowError('邀请码无效或已损坏');

    // creator_id 与 creator_pub 不自证同样被拒（自带公钥的理由就是这一步）
    const forged = { ...inv, creatorId: inv.creatorId.slice(0, 31) + (inv.creatorId.endsWith('0') ? '1' : '0') };
    expect(() => decodeInvite(encodeInvite(forged))).toThrowError('邀请码无效或已损坏');

    // 非 base1: 前缀 / 坏 base64 也不放行
    expect(() => decodeInvite('base3:xxxx')).toThrowError('邀请码无效或已损坏');
    expect(() => decodeInvite('base1:!!!!')).toThrowError('邀请码无效或已损坏');

    const b = fixture();
    gateOffline(b.o);
    const err = await acceptInvite(b.o, encodeInvite({ ...inv, groupKeyHex: flipped })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GroupError);
    expect((err as GroupError).code).toBe('invite_invalid');
  });

  it('AC 8：断网发言入队，联网后仅补发一条；队列行含密文不含明文', async () => {
    const a = fixture();
    const gate = gateOffline(a.o);
    const created = await createGroup(a.o, { name: '读书', encrypted: true });
    await a.repo.removeCommentOut((await a.repo.listCommentOut())[0]!.eventId); // 清掉 roster 行，只看发言

    const sent = await postGroupMessage(a.o, { groupId: created.group.groupId, text: '今晚九点开读' });
    expect(sent.queued).toBe(true);
    const rows = await a.repo.listCommentOut();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetId).toBe(`group/${created.group.groupId}`);
    expect(rows[0]!.wire).toContain('group.v1');
    expect(rows[0]!.wire).not.toContain('今晚九点开读'); // 明文不进 wire，只进 text_cipher

    // 联网：登记 + 收事件都打桩，在**同一个 o** 上补发
    gate.offline = false;
    a.http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    a.http.postRoutes.set(`${BASE}/v1/event`, json({ event_id: 'ignored', payload_cid: 'c'.repeat(32) }));

    const first = await flushPending(a.o);
    expect(first.sent).toBe(1);
    expect(await a.repo.listCommentOut()).toHaveLength(0);

    const second = await flushPending(a.o);
    expect(second.sent).toBe(0); // 仅一条，不重复
    expect(a.http.posted.filter((p) => p.url.endsWith('/v1/event'))).toHaveLength(1);
  });

  it('AC 9：未入圈者能列出索引与 member_ids，取到的密文解不开且触发提示', async () => {
    const a = fixture();
    a.http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    a.http.postRoutes.set(`${BASE}/v1/event`, json({ event_id: 'ignored', payload_cid: 'c'.repeat(32) }));

    // 匿名可读只对**开放圈**成立 ⇒ 该用例用 encrypted: false 建圈
    const { group } = await createGroup(a.o, { name: '读书', encrypted: false });
    const post = await postGroupMessage(a.o, { groupId: group.groupId, text: '九点开读' });
    const lastPost = a.http.posted[a.http.posted.length - 1]!;
    const wire = JSON.parse(decodeUtf8(lastPost.body)) as { event_id: string; body: { text_cipher: string } };

    // 节点读接口打桩：名单 = 创建者 + 自己
    a.http.routes.set(
      `${BASE}/v1/group/${group.groupId}`,
      json({
        group: { group_id: group.groupId, creator_id: group.creatorId, epoch: 1, member_ids: [group.creatorId], name: '读书' },
        events: [
          { event_id: wire.event_id, actor: group.creatorId, created_at: 1790000000000, payload_cid: post.eventId, epoch: 1, action: 'msg', reply_to: null },
        ],
        next_cursor: null,
      }),
    );
    a.http.routes.set(`${BASE}/v1/blob/${post.eventId}`, { status: 200, body: utf8(wire.body.text_cipher) });

    // A（有密钥）能读明文，且读回把名单写进本地
    const feed = await fetchGroupMessages(a.o, group.groupId);
    expect(feed.events[0]!.text).toBe('九点开读');
    expect(feed.notice).toBe('');
    expect(feed.group.memberIds).toEqual([group.creatorId]);

    // C（未入圈、无密钥）能读索引与名单，但解不开——用的是**同一个节点**（桩都在 a.http 上）
    const c = fixture();
    c.o.adapters.http = a.http;
    const stranger = await fetchGroupMessages(c.o, group.groupId);
    expect(stranger.group.memberIds).toEqual([group.creatorId]);
    expect(stranger.events[0]!.text).toBeNull();
    expect(stranger.notice).toBe(GROUP_KEY_STALE_NOTICE);
  });

  it('AC 10：节点返回 4xx → 原地报错、comment_out 行数不变', async () => {
    const a = fixture();
    a.http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    a.http.postRoutes.set(`${BASE}/v1/event`, json({ event_id: 'ignored', payload_cid: 'c'.repeat(32) }));

    const { group } = await createGroup(a.o, { name: '读书', encrypted: true }); // 建圈先走通，把 4xx 留给发言路径
    const before = (await a.repo.listCommentOut()).length;
    a.http.postRoutes.set(`${BASE}/v1/event`, { status: 403, body: utf8(JSON.stringify({ code: 'event_sig_invalid' })) });
    const err = await postGroupMessage(a.o, { groupId: group.groupId, text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommentError); // 复用 comment 的错误映射（'rejected'）
    expect((err as CommentError).code).toBe('rejected');
    expect((await a.repo.listCommentOut()).length).toBe(before);
  });

  it('AC 13：v1 老码仍可入圈，且被识别为封闭圈、roster_rev 缺省 0', async () => {
    const a = fixture();
    gateOffline(a.o);
    const created = await createGroup(a.o, { name: '读书', encrypted: true });
    const keyRow = (await a.repo.listGroupKeys(created.group.groupId))[0]!;
    const legacy = await legacyInviteV1(
      a.storage,
      created.group.groupId,
      await groupKeyHex(a.storage, keyRow.keyCipher),
      '读书',
    );

    const b = fixture();
    const { group } = await acceptInvite(b.o, legacy);
    expect(group.encrypted).toBe(1); // 老码没有 encrypted 键 ⇒ 缺省封闭（存量语义）
    expect(group.rosterRev).toBe(0);
    expect(group.epoch).toBe(1);
  });

  it('AC 4：轮换后同伴靠信封链自动补钥，无需粘贴任何续期码', async () => {
    const a = fixture();
    gateOffline(a.o); // 轮换只出草稿，不发网络（重点在本地钥 + 信封）
    const created = await createGroup(a.o, { name: '读书', encrypted: true });
    const b = fixture();
    await acceptInvite(b.o, created.inviteCode); // B 先持 epoch 1

    const rotated = await rotateGroup(a.o, created.group.groupId, { memberIds: [created.group.creatorId] });
    expect(rotated.requestCode.startsWith('base2:')).toBe(true);
    expect(rotated.envelopes).toHaveLength(1);
    expect((await a.repo.getGroup(created.group.groupId))!.epoch).toBe(2);
    expect((await a.repo.listGroupKeys(created.group.groupId)).map((k) => k.epoch)).toEqual([1, 2]);

    // 节点读接口下发 epoch 2 的信封与该 epoch 的一条消息（密文用 a 的 epoch 2 钥现造）
    const key2Row = (await a.repo.listGroupKeys(created.group.groupId)).find((k) => k.epoch === 2)!;
    const key2 = hexToBytes(await groupKeyHex(a.storage, key2Row.keyCipher));
    const cipher = sealText(key2, '新钥生效');
    b.o.adapters.http = a.http; // B 与桩共用同一个节点
    a.http.routes.set(
      `${BASE}/v1/group/${created.group.groupId}`,
      groupPage(
        created.group.groupId,
        created.group.creatorId,
        2,
        [created.group.creatorId],
        rotated.envelopes,
        [{ event_id: 'e'.repeat(32), actor: created.group.creatorId, created_at: 1, payload_cid: 'ev2', epoch: 2, action: 'msg', reply_to: null }],
      ),
    );
    a.http.routes.set(`${BASE}/v1/blob/ev2`, { status: 200, body: utf8(cipher) });

    const feed = await fetchGroupMessages(b.o, created.group.groupId);
    expect(feed.events[0]!.text).toBe('新钥生效'); // 解开了 epoch 2 的消息（没粘过任何码）
    expect(feed.notice).toBe('');
    expect((await b.repo.listGroupKeys(created.group.groupId)).map((k) => k.epoch).sort()).toEqual([1, 2]);
    expect((await b.repo.getGroup(created.group.groupId))!.epoch).toBe(2);
  });

  it('AC 5：链断（拿不到上一层钥）⇒ 解密失败并原位提示原文，且不落任何错钥', async () => {
    const a = fixture();
    gateOffline(a.o);
    const created = await createGroup(a.o, { name: '读书', encrypted: true });
    const out = fixture(); // 「已落伍者」：本地只有 epoch 1 的钥
    await acceptInvite(out.o, created.inviteCode);

    // 节点已到 epoch 3，但信封只给了 2→3 这一段，缺 1→2 ⇒ 链断
    const k1 = randomBytes(32);
    const broken = sealEnvelope(k1, randomBytes(32), 2);
    out.o.adapters.http = a.http;
    a.http.routes.set(
      `${BASE}/v1/group/${created.group.groupId}`,
      groupPage(
        created.group.groupId,
        created.group.creatorId,
        3,
        [created.group.creatorId],
        [broken],
        [{ event_id: 'f'.repeat(32), actor: created.group.creatorId, created_at: 1, payload_cid: 'ev3', epoch: 3, action: 'msg', reply_to: null }],
      ),
    );
    a.http.routes.set(`${BASE}/v1/blob/ev3`, { status: 200, body: utf8(sealText(randomBytes(32), 'x')) });

    const feed = await fetchGroupMessages(out.o, created.group.groupId);
    expect(feed.notice).toBe(GROUP_KEY_STALE_NOTICE); // 原文可核对（禁止静默）
    expect(feed.events.some((e) => e.text === null)).toBe(true);
    expect((await out.repo.listGroupKeys(created.group.groupId)).map((k) => k.epoch)).toEqual([1]); // 整链放弃
  });

  it('AC 6 / AC 7：门槛不足时 submitRoster 原地报错、不提交；凑够两签则成对入队', async () => {
    const a = fixture();
    gateOffline(a.o);
    const created = await createGroup(a.o, { name: '读书', encrypted: true });
    // 门槛用**变更前**人数：本地行放 11 人 ⇒ k = 3 ⇒ 移出成员需 ceil(2*3/3) = 2 签
    const memberIds = Array.from({ length: 11 }, (_, i) => i.toString(16).padStart(32, '0'));
    await a.repo.saveGroup({ ...created.group, memberIdsJson: JSON.stringify(memberIds) });
    const req = await buildRosterRequest(a.o, created.group.groupId, { sub: 'remove', memberIds });
    const mine = await signSigRequest(a.o, req);
    const before = (await a.repo.listCommentOut()).length;

    const err = await submitRoster(a.o, req, [mine]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GroupError);
    expect((err as GroupError).code).toBe('roster_quorum_missing');
    expect((err as GroupError).message).toBe('需 2 名签名（移出成员），当前 1 名');
    expect((await a.repo.listCommentOut()).length).toBe(before); // 未提交、未入队

    // 第二签来自**另一个身份**（同一台机器的另一身份，或代同伴回执）
    const other = fixture();
    const second = await signSigRequest(other.o, req);
    const ok = await submitRoster(a.o, req, [mine, second]);
    expect(ok.queued).toBe(true); // 断网 ⇒ 走既有 comment_out 队列
    expect((await a.repo.listCommentOut()).length).toBe(before + 1);
    const rows = await a.repo.listCommentOut();
    const row = rows[rows.length - 1]!;
    expect(row.targetId).toBe(`group/${created.group.groupId}`);
    const wire = JSON.parse(row.wire) as { event_id: string; body: Record<string, unknown> };
    expect(wire.body.action).toBe('roster'); // 更正 21：v2 名单的 action 固定 'roster'，不是 'roster_v2'
    expect(wire.body.sub).toBe('remove');
    expect((wire.body.sigs as unknown[]).length).toBe(2);
    expect(wire.event_id).toBe(decodeRosterRequest(req).eventId); // 信封复用草稿的 event_id
  });

  it('门槛镜像：governorSeats 与「谁是治者」无关，纯按 m 算席位', () => {
    expect(governorSeats(1)).toBe(1);
    expect(governorSeats(10)).toBe(1);
    expect(governorSeats(11)).toBe(3);
    expect(governorSeats(21)).toBe(4);
    expect(governorSeats(101)).toBe(10);
  });

  it('base2 / base3：编解码往返稳定，篡改或换草稿即被拒', async () => {
    const a = fixture();
    gateOffline(a.o);
    const created = await createGroup(a.o, { name: '读书', encrypted: true });
    const req = await buildRosterRequest(a.o, created.group.groupId, {
      sub: 'rename',
      memberIds: [created.group.creatorId],
      name: '新名',
    });
    const d = decodeRosterRequest(req);
    expect(d.sub).toBe('rename');
    expect(d.name).toBe('新名');
    expect(d.encrypted).toBe(1);
    expect(encodeRosterRequest(d)).toBe(req); // 往返稳定

    const receipt = await signSigRequest(a.o, req);
    expect(receipt.startsWith('base3:')).toBe(true);
    expect(readSigReceipt(receipt, d)?.id).toBe((await ensureLocalIdentity(a.storage)).id);
    expect(readSigReceipt(receipt, { ...d, name: '别的名' })).toBeNull(); // request_hash 不匹配 ⇒ 丢弃
    expect(readSigReceipt(receipt, { ...d, createdAt: d.createdAt + 1 })).toBeNull();
    expect(readSigReceipt('base2:' + receipt.slice(6), d)).toBeNull(); // 前缀不对

    // 形态不合法一律 `roster_request_invalid`
    expect(() => decodeRosterRequest('base1:xxxx')).toThrowError('这不是签名请求码（应以 base2: 开头）');
    expect(() => decodeRosterRequest(encodeRosterRequest({ ...d, rosterRev: 0 } as RosterDraft))).toThrowError(
      '签名请求码字段不合法',
    );
  });

  it('resolveKeyChain：逐层解链；缺层或目标不可达 ⇒ 整链放弃', () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const k3 = randomBytes(32);
    const e12 = sealEnvelope(k1, k2, 1);
    const e23 = sealEnvelope(k2, k3, 2);
    const have = new Map<number, Uint8Array>([[1, k1]]);

    expect(bytesToHex(openEnvelope(k1, e12))).toBe(bytesToHex(k2)); // 信封就是「旧钥封新钥」
    expect(bytesToHex(resolveKeyChain(have, [e12, e23], 3)!)).toBe(bytesToHex(k3));
    expect(resolveKeyChain(have, [e23], 3)).toBeNull(); // 缺 1→2
    expect(resolveKeyChain(have, [e12, e23], 4)).toBeNull(); // 目标不可达
    expect(() => openEnvelope(k3, e12)).toThrow(); // 钥不对 ⇒ 抛错（由 resolveKeyChain 兜成 null）
  });

  it('msg 的回复键只在提供时入体；本地没有圈时拒绝发言', async () => {
    const a = fixture();
    gateOffline(a.o);
    const { group } = await createGroup(a.o, { name: '读书', encrypted: true });

    await postGroupMessage(a.o, { groupId: group.groupId, text: '甲', replyTo: 'f'.repeat(32) });
    const rows = await a.repo.listCommentOut();
    const last = JSON.parse(rows[rows.length - 1]!.wire) as { body: Record<string, unknown> };
    expect(last.body.reply_to).toBe('f'.repeat(32));

    await postGroupMessage(a.o, { groupId: group.groupId, text: '乙' });
    const rows2 = await a.repo.listCommentOut();
    const last2 = JSON.parse(rows2[rows2.length - 1]!.wire) as { body: Record<string, unknown> };
    expect('reply_to' in last2.body).toBe(false);

    const err = await postGroupMessage(a.o, { groupId: 'a'.repeat(32), text: 'x' }).catch((e: unknown) => e);
    expect((err as GroupError).code).toBe('group_not_found');
  });

  it('六个 sub 的草稿码：epoch 与 roster_rev 都严格 +1（设计册 §3.8）', async () => {
    const run = async (
      sub: RosterDraft['sub'],
      fn: (o: GroupOptions, gid: string, creatorId: string, bId: string) => Promise<{ requestCode: string }>,
    ): Promise<RosterDraft> => {
      const { a, gid, creatorId, bId } = await twoMemberGroup();
      const cur = (await a.repo.getGroup(gid))!;
      const { requestCode } = await fn(a.o, gid, creatorId, bId);
      const d = decodeRosterRequest(requestCode);
      const after = (await a.repo.getGroup(gid))!;
      expect(d.sub).toBe(sub);
      expect(d.epoch).toBe(cur.epoch + 1);
      expect(d.rosterRev).toBe(cur.rosterRev + 1);
      expect(after.epoch).toBe(cur.epoch + 1); // 本地换钥前推到**同一个**值（不出现「草稿 2、本地 3」的双推）
      expect(after.rosterRev).toBe(cur.rosterRev + 1);
      return d;
    };

    await run('rename', (o, gid) => renameGroup(o, gid, '新名'));
    await run('rotate', (o, gid, c, b) => rotateGroup(o, gid, { memberIds: [c, b] }));
    await run('remove', (o, gid, _c, b) => removeMember(o, gid, b));
    await run('leave', (o, gid) => leaveGroup(o, gid));
    const diss = await run('dissolve', (o, gid) => dissolveGroup(o, gid));
    expect(diss.memberIds).toEqual([]); // 解散：名单清空（补充 11）
  });

  it('移出成员：提交的 body 带 envelopes，旧钥可解出新钥（AC 4 / M3 的提交侧镜像）', async () => {
    const { a, gid, bId } = await twoMemberGroup();
    const cur = (await a.repo.getGroup(gid))!;
    const oldRow = (await a.repo.listGroupKeys(gid)).find((k) => k.epoch === cur.epoch)!;
    const oldKey = hexToBytes(await groupKeyHex(a.storage, oldRow.keyCipher));

    const rm = await removeMember(a.o, gid, bId);
    expect(rm.envelopes).toHaveLength(1); // 名单变更 ⇒ 换钥并出信封

    // m=1（移出后只剩创建者）⇒ remove 需 1 签
    const mine = await signSigRequest(a.o, rm.requestCode);
    await submitRoster(a.o, rm.requestCode, [mine], rm.envelopes);

    const rows = await a.repo.listCommentOut(); // 断网 ⇒ 入队，wire 落在队列里
    const wire = JSON.parse(rows[rows.length - 1]!.wire) as { body: Record<string, unknown> };
    expect(wire.body.sub).toBe('remove');
    expect(wire.body.epoch).toBe(cur.epoch + 1);
    expect(wire.body.roster_rev).toBe(cur.rosterRev + 1);
    const envs = wire.body.envelopes as Array<{ from_epoch: number; cipher: string }>;
    expect(envs).toHaveLength(1);
    expect(envs[0]!.from_epoch).toBe(cur.epoch); // 旧 epoch 封新钥

    // 旧钥能解开信封 ⇒ 新钥，且与本地 epoch+1 的钥一致
    const env: GroupEnvelope = { fromEpoch: envs[0]!.from_epoch, cipher: envs[0]!.cipher };
    const newKey = openEnvelope(oldKey, env);
    const localNew = hexToBytes(
      await groupKeyHex(a.storage, (await a.repo.listGroupKeys(gid)).find((k) => k.epoch === cur.epoch + 1)!.keyCipher),
    );
    expect(bytesToHex(newKey)).toBe(bytesToHex(localNew));

    // 另一台设备：本地只有 epoch cur 的钥，靠这一条信封即可补到 cur+1（AC 4 / M3）
    const chain = resolveKeyChain(new Map([[cur.epoch, oldKey]]), [env], cur.epoch + 1);
    expect(bytesToHex(chain!)).toBe(bytesToHex(localNew));
  });

  it('开放圈自助自加入：先匿名读拿节点 epoch / 名单，草稿 +1 且含自己，落本地行', async () => {
    const a = fixture();
    const gid = 'a'.repeat(32);
    const creatorId = 'b'.repeat(32);
    // 匿名读桩：本地无该圈行（未入圈），GET 却能成功 ⇒ 证明走的是匿名路径
    a.http.routes.set(
      `${BASE}/v1/group/${gid}`,
      json({
        group: {
          group_id: gid,
          creator_id: creatorId,
          epoch: 4,
          member_ids: [creatorId],
          name: '开放读书',
          encrypted: 0,
          roster_rev: 7,
          seat_count: 1,
          governors: [creatorId],
          envelopes: [],
        },
        events: [],
        next_cursor: null,
      }),
    );
    expect(await a.repo.getGroup(gid)).toBeNull();
    // 提交态在线：登记 + 收事件都打桩
    a.http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    a.http.postRoutes.set(`${BASE}/v1/event`, json({ event_id: 'ignored', payload_cid: 'c'.repeat(32) }));

    const r = await joinOpenGroup(a.o, gid);
    expect(r.queued).toBe(false);

    const evPost = a.http.posted.find((p) => p.url.endsWith('/v1/event'))!;
    const wire = JSON.parse(decodeUtf8(evPost.body)) as { body: Record<string, unknown> };
    expect(wire.body.action).toBe('roster');
    expect(wire.body.sub).toBe('join');
    expect(wire.body.encrypted).toBe(0); // 开放圈
    expect(wire.body.epoch).toBe(5); // 节点值 4 + 1（epoch 猜错必被节点 409）
    expect(wire.body.roster_rev).toBe(8); // 节点值 7 + 1
    const me = (await ensureLocalIdentity(a.storage)).id;
    expect(wire.body.member_ids).toEqual([creatorId, me]); // 节点名单 ∪ 自己

    // 读回的名单落本地 ⇒ 出现在「我的圈子」；epoch / name 取自响应
    const row = (await a.repo.getGroup(gid))!;
    expect(row.encrypted).toBe(0);
    expect(row.name).toBe('开放读书');
    expect(row.epoch).toBe(4);
    expect(row.rosterRev).toBe(7);
    expect(JSON.parse(row.memberIdsJson)).toEqual([creatorId]);
  });

  it('门槛镜像用变更前人数：m=11 的圈子移出一人仍须 2 签（验收 M4）', async () => {
    const a = fixture();
    gateOffline(a.o);
    const created = await createGroup(a.o, { name: '读书', encrypted: true });
    const members = Array.from({ length: 11 }, (_, i) => i.toString(16).padStart(32, '0'));
    await a.repo.saveGroup({ ...created.group, memberIdsJson: JSON.stringify(members) });

    const rm = await removeMember(a.o, created.group.groupId, members[0]!);
    expect(decodeRosterRequest(rm.requestCode).memberIds).toHaveLength(10); // 草稿是变更后（10 人）
    expect((await a.repo.getGroup(created.group.groupId))!.memberIdsJson).toBe(JSON.stringify(members)); // 本地仍是变更前
    const mine = await signSigRequest(a.o, rm.requestCode);
    const before = (await a.repo.listCommentOut()).length;
    const err = await submitRoster(a.o, rm.requestCode, [mine], rm.envelopes).catch((e: unknown) => e);
    expect((err as GroupError).message).toBe('需 2 名签名（移出成员），当前 1 名'); // 用变更后 10 人算会误报「需 1 名」
    expect((await a.repo.listCommentOut()).length).toBe(before); // 未提交、未入队

    const second = await signSigRequest(fixture().o, rm.requestCode);
    expect((await submitRoster(a.o, rm.requestCode, [mine, second], rm.envelopes)).queued).toBe(true);
  });

  it('门槛镜像用变更前人数：m=3 的圈子解散须 2 签（验收 M5）', async () => {
    const a = fixture();
    gateOffline(a.o);
    const created = await createGroup(a.o, { name: '读书', encrypted: true });
    const members = [created.group.creatorId, 'a'.repeat(32), 'b'.repeat(32)];
    await a.repo.saveGroup({ ...created.group, memberIdsJson: JSON.stringify(members) });

    const diss = await dissolveGroup(a.o, created.group.groupId);
    expect(decodeRosterRequest(diss.requestCode).memberIds).toEqual([]); // 解散：名单清空（变更后 0 人）
    const mine = await signSigRequest(a.o, diss.requestCode);
    const before = (await a.repo.listCommentOut()).length;
    const err = await submitRoster(a.o, diss.requestCode, [mine], diss.envelopes).catch((e: unknown) => e);
    expect((err as GroupError).message).toBe('需 2 名签名（解散圈子），当前 1 名'); // 用变更后 0 人算会误报「需 1 名」
    expect((await a.repo.listCommentOut()).length).toBe(before);

    const second = await signSigRequest(fixture().o, diss.requestCode);
    expect((await submitRoster(a.o, diss.requestCode, [mine, second], diss.envelopes)).queued).toBe(true);
  });
});