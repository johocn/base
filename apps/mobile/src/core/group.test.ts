import { describe, expect, it } from 'vitest';

import { bytesToHex, hexToBytes, openWithNonce, utf8 } from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, MemoryStorage } from './fakes';
import type { Adapters } from '../platform/adapter';
import { deviceKek } from './identity';
import { CommentError, flushPending } from './comment';
import { decodeUtf8 } from './sync';
import {
  GROUP_KEY_STALE_NOTICE,
  GroupError,
  acceptInvite,
  createGroup,
  decodeInvite,
  encodeInvite,
  fetchGroupMessages,
  postGroupMessage,
  rotateGroup,
  type GroupOptions,
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
  };
  return state;
}

/** 用自己的设备 KEK 解开 `group_keys.key_cipher`，回原始 32 字节 hex（AC 1 的「组密钥相同」判定）。 */
async function groupKeyHex(storage: MemoryStorage, cipher: string): Promise<string> {
  const kek = await deviceKek(storage);
  const [n, ct] = cipher.split(':');
  return bytesToHex(openWithNonce(kek, hexToBytes(n!), hexToBytes(ct!)));
}

describe('group', () => {
  it('AC 1：A 断网建组出码，B 断网粘码入组，双方 epoch 与组密钥一致', async () => {
    const a = fixture();
    gateOffline(a.o);
    const created = await createGroup(a.o, { name: '夜间读书' });

    expect(created.queued).toBe(true); // 断网 → roster 入队，但邀请码已可用
    expect(created.inviteCode.startsWith('base1:')).toBe(true);
    expect(created.group.groupId).toMatch(/^[0-9a-f]{32}$/); // 16 字节，与 event_id 同形

    const b = fixture();
    gateOffline(b.o); // 入组**全程零网络**
    const joined = await acceptInvite(b.o, created.inviteCode);

    expect(joined.renewed).toBe(true);
    expect(joined.group.groupId).toBe(created.group.groupId);
    expect(joined.group.epoch).toBe(1);
    expect(joined.group.creatorId).toBe(created.group.creatorId);

    const ka = await a.repo.listGroupKeys(created.group.groupId);
    const kb = await b.repo.listGroupKeys(created.group.groupId);
    expect(kb).toHaveLength(1);
    expect(kb[0]!.epoch).toBe(ka[0]!.epoch);
    expect(await groupKeyHex(b.storage, kb[0]!.keyCipher)).toBe(await groupKeyHex(a.storage, ka[0]!.keyCipher));
  });

  it('AC 2：篡改 group_key 任一字符 → 入组被拒，文案统一', async () => {
    const a = fixture();
    gateOffline(a.o);
    const created = await createGroup(a.o, { name: '读书' });

    const inv = decodeInvite(created.inviteCode);
    const flipped = inv.groupKeyHex[0] === 'a' ? 'b' + inv.groupKeyHex.slice(1) : 'a' + inv.groupKeyHex.slice(1);
    expect(() => decodeInvite(encodeInvite({ ...inv, groupKeyHex: flipped }))).toThrowError('邀请码无效或已损坏');

    // creator_id 与 creator_pub 不自证同样被拒（自带公钥的理由就是这一步）
    const forged = { ...inv, creatorId: inv.creatorId.slice(0, 31) + (inv.creatorId.endsWith('0') ? '1' : '0') };
    expect(() => decodeInvite(encodeInvite(forged))).toThrowError('邀请码无效或已损坏');

    // 非 base1: 前缀 / 坏 base64 也不放行
    expect(() => decodeInvite('base2:xxxx')).toThrowError('邀请码无效或已损坏');
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
    const created = await createGroup(a.o, { name: '读书' });
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

  it('AC 9：未入组者能列出索引与 member_ids，取到的密文解不开且触发提示', async () => {
    const a = fixture();
    a.http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    a.http.postRoutes.set(`${BASE}/v1/event`, json({ event_id: 'ignored', payload_cid: 'c'.repeat(32) }));

    const { group } = await createGroup(a.o, { name: '读书' });
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

    // C（未入组、无密钥）能读索引与名单，但解不开——用的是**同一个节点**（桩都在 a.http 上）
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

    const { group } = await createGroup(a.o, { name: '读书' }); // 建组先走通，把 4xx 留给发言路径
    const before = (await a.repo.listCommentOut()).length;
    a.http.postRoutes.set(`${BASE}/v1/event`, { status: 403, body: utf8(JSON.stringify({ code: 'event_sig_invalid' })) });
    const err = await postGroupMessage(a.o, { groupId: group.groupId, text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommentError); // 复用 comment 的错误映射（'rejected'）
    expect((err as CommentError).code).toBe('rejected');
    expect((await a.repo.listCommentOut()).length).toBe(before);
  });

  it('轮换：新 epoch 用新密钥；被移出者解不开并提示；旧码不覆盖本地新 epoch', async () => {
    const a = fixture();
    a.http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    a.http.postRoutes.set(`${BASE}/v1/event`, json({ event_id: 'ignored', payload_cid: 'c'.repeat(32) }));

    const { group, inviteCode } = await createGroup(a.o, { name: '读书' });
    const b = fixture();
    const joined = await acceptInvite(b.o, inviteCode); // 入组零网络，b 不需任何桩

    // 6.1 非创建者不能轮换（b 的 creatorId 是 a 的 id，b 自己的身份不是创建者）
    const err = await rotateGroup(b.o, group.groupId, [joined.group.creatorId]).catch((e: unknown) => e);
    expect((err as GroupError).code).toBe('not_creator');

    // 6.2 创建者移出 b：新 epoch=2 + 续期码
    const rotated = await rotateGroup(a.o, group.groupId, [group.creatorId]);
    expect(rotated.group.epoch).toBe(2);
    expect((await a.repo.listGroupKeys(group.groupId)).map((k) => k.epoch)).toEqual([1, 2]);

    // 6.3 b 粘续期码 → epoch 跟进
    const renewed = await acceptInvite(b.o, rotated.inviteCode);
    expect(renewed.renewed).toBe(true);
    expect(renewed.group.epoch).toBe(2);

    // 6.4 b 再粘最初那张（epoch=1）→ 拒绝，不被拉回
    const stale = await acceptInvite(b.o, inviteCode).catch((e: unknown) => e);
    expect((stale as GroupError).code).toBe('key_stale');
    expect((await b.repo.getGroup(group.groupId))!.epoch).toBe(2);
  });

  it('msg 的回复键只在提供时入体；本地没有组时拒绝发言', async () => {
    const a = fixture();
    gateOffline(a.o);
    const { group } = await createGroup(a.o, { name: '读书' });

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
});
