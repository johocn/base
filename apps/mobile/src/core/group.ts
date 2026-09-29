/**
 * 学习小组（② 加密）：邀请码编解码、建组/入组/轮换、发言编排、读索引 + 取块解密。
 *
 * 只依赖注入的适配器 / `LocalRepo` / `core/identity`，不 import 'uni' / 'plus'，
 * 因此可在 Node 下用 `core/fakes.ts` 完整测试（与 core/comment.ts 同一约定）。
 * 密码学**零新代码**：全部经 `sealWithNonce` / `openWithNonce`（#4 定案）。
 */
import {
  bytesToHex,
  canonicalize,
  deriveIdentityId,
  hexToBytes,
  isIdentityId,
  openWithNonce,
  randomBytes,
  sealWithNonce,
  sign,
  utf8,
  verify,
  type Json,
} from '@base/protocol-ts';

import type { Adapters } from '../platform/adapter';
import type { LocalRepo } from './repo';
import type { GroupRow } from './types';
import { CommentError, sendComment } from './comment';
import { deviceKek, ensureLocalIdentity, type Identity } from './identity';
import { decodeUtf8 } from './sync';

/** 与 `CommentOptions` **同形**：这样 `flushPending`（补发）可直接喂进来，无需转换。 */
export interface GroupOptions {
  adapters: Adapters;
  repo: LocalRepo;
  nodeBaseUrl: string;
}

export type GroupErrorCode =
  | 'invite_invalid'
  | 'not_creator'
  | 'key_stale'
  | 'group_not_found'
  | 'unregistered'
  | 'rejected'
  | 'network'
  | 'server'
  | 'client';

export class GroupError extends Error {
  constructor(
    readonly code: GroupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GroupError';
  }
}

/** 移出后新消息读不出来时的**原位提示原文**（册子 §5.3 硬要求；禁止静默跳过）。 */
export const GROUP_KEY_STALE_NOTICE = '小组密钥已更新，请向创建者索取新邀请码。';

const GROUP_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64URL.charAt(b0 >> 2);
    out += B64URL.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    if (i + 1 < bytes.length) out += B64URL.charAt(((b1 & 0x0f) << 2) | (b2 >> 6));
    if (i + 2 < bytes.length) out += B64URL.charAt(b2 & 0x3f);
  }
  return out;
}

function base64UrlToBytes(s: string): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64URL.indexOf(s.charAt(i));
    if (v < 0) throw new Error('base64url: 非法字符');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** 组密钥落 `group_keys.key_cipher`：`nonceHex:ctHex`——与 `identity.ts:96` 的私钥密文**同一形态**。 */
async function sealGroupKey(storage: Adapters['storage'], keyBytes: Uint8Array): Promise<string> {
  const kek = await deviceKek(storage);
  const nonce = randomBytes(GCM_NONCE_BYTES);
  return `${bytesToHex(nonce)}:${bytesToHex(sealWithNonce(kek, nonce, keyBytes))}`;
}

async function openGroupKey(storage: Adapters['storage'], keyCipher: string): Promise<Uint8Array> {
  const kek = await deviceKek(storage);
  const [nonceHex, ctHex] = keyCipher.split(':');
  if (!nonceHex || !ctHex) throw new Error('group: 组密钥密文格式损坏');
  return openWithNonce(kek, hexToBytes(nonceHex), hexToBytes(ctHex));
}

/** 正文加密：`base64url(nonce12 || sealWithNonce(...))`（补充 3）。 */
function sealText(key: Uint8Array, plain: string): string {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const ct = sealWithNonce(key, nonce, utf8(plain));
  const buf = new Uint8Array(nonce.length + ct.length);
  buf.set(nonce, 0);
  buf.set(ct, nonce.length);
  return bytesToBase64Url(buf);
}

/** 正文解密；密钥不对 / 密文损坏一律抛错，由调用方降级为「提示 + 占位」（册子 §5.3）。 */
function openText(key: Uint8Array, textCipher: string): string {
  const buf = base64UrlToBytes(textCipher);
  if (buf.length < GCM_NONCE_BYTES + 16) throw new Error('group: 密文过短');
  return decodeUtf8(openWithNonce(key, buf.subarray(0, GCM_NONCE_BYTES), buf.subarray(GCM_NONCE_BYTES)));
}

export interface GroupInvite {
  v: number;
  groupId: string;
  targetId: string;
  name: string;
  epoch: number;
  groupKeyHex: string;
  creatorId: string;
  creatorPubHex: string;
  createdAt: number;
  sig: string;
}

/** 签名域的 **9 个固定键**：`name` 缺省写空串（补充 2，避免同一组 canonicalize 出两种字节序）。 */
function inviteSignFields(inv: GroupInvite): Record<string, Json> {
  return {
    v: inv.v,
    group_id: inv.groupId,
    target_id: inv.targetId,
    name: inv.name,
    epoch: inv.epoch,
    group_key: inv.groupKeyHex,
    creator_id: inv.creatorId,
    creator_pub: inv.creatorPubHex,
    created_at: inv.createdAt,
  };
}

function isHexN(s: string, n: number): boolean {
  return new RegExp(`^[0-9a-f]{${n}}$`).test(s);
}

/** 册子 §3.3：任一步失败即拒绝，**统一文案**，不区分原因（不泄漏「哪一步失败」）。 */
function invalidInvite(): GroupError {
  return new GroupError('invite_invalid', '邀请码无效或已损坏');
}

/** 编码为 `base1:` + base64url(canonical JSON)，单行可复制粘贴。 */
export function encodeInvite(inv: GroupInvite): string {
  const body: Json = { ...inviteSignFields(inv), sig: inv.sig };
  return `base1:${bytesToBase64Url(utf8(canonicalize(body)))}`;
}

/** 解码 + **离线自验**（册子 §3.3）：形态 → 自证 id → 验签名。全通过才返回。 */
export function decodeInvite(code: string): GroupInvite {
  const raw = code.trim();
  if (!raw.startsWith('base1:')) throw invalidInvite();
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(decodeUtf8(base64UrlToBytes(raw.slice('base1:'.length)))) as Record<string, unknown>;
  } catch {
    throw invalidInvite();
  }
  const inv: GroupInvite = {
    v: Number(m.v ?? 0),
    groupId: String(m.group_id ?? ''),
    targetId: String(m.target_id ?? ''),
    name: typeof m.name === 'string' ? m.name : '',
    epoch: Number(m.epoch ?? 0),
    groupKeyHex: String(m.group_key ?? ''),
    creatorId: String(m.creator_id ?? ''),
    creatorPubHex: String(m.creator_pub ?? ''),
    createdAt: Number(m.created_at ?? 0),
    sig: String(m.sig ?? ''),
  };
  if (inv.v !== 1) throw invalidInvite();
  // group_id 与 event_id 同形：16 字节 = 32 hex（节点侧 isHexN(id,16) 即 len==32）。
  if (!isHexN(inv.groupId, 32) || inv.targetId !== `group/${inv.groupId}`) throw invalidInvite();
  if (!isHexN(inv.groupKeyHex, 64)) throw invalidInvite();
  if (!isIdentityId(inv.creatorId) || !isHexN(inv.creatorPubHex, 64)) throw invalidInvite();
  if (!Number.isInteger(inv.epoch) || inv.epoch < 1 || !Number.isInteger(inv.createdAt)) throw invalidInvite();
  if (deriveIdentityId(inv.creatorPubHex) !== inv.creatorId) throw invalidInvite();
  if (!verify(inv.creatorPubHex, utf8(canonicalize(inviteSignFields(inv))), inv.sig)) throw invalidInvite();
  return inv;
}

/** 用创建者身份私钥对 9 个字段签名（不含 `sig` 自身）。 */
function signInvite(ident: Identity, fields: Omit<GroupInvite, 'sig'>): GroupInvite {
  const sig = sign(ident.seedHex, utf8(canonicalize(inviteSignFields({ ...fields, sig: '' }))));
  return { ...fields, sig };
}

/** 把邀请码落库：写 `group_keys`（该 epoch 一把）+ `groups`（名单留待读回，补充 7）。 */
async function saveInvite(o: GroupOptions, inv: GroupInvite): Promise<GroupRow> {
  const existing = await o.repo.getGroup(inv.groupId);
  const row: GroupRow = existing ?? {
    groupId: inv.groupId,
    name: inv.name,
    creatorId: inv.creatorId,
    epoch: inv.epoch,
    memberIdsJson: '[]', // 邀请码里只有创建者，没有全体成员 → 以节点读回为准
    joinedAt: new Date().toISOString(),
  };
  await o.repo.putGroupKey({
    groupId: inv.groupId,
    epoch: inv.epoch,
    keyCipher: await sealGroupKey(o.adapters.storage, hexToBytes(inv.groupKeyHex)),
    createdAt: new Date().toISOString(),
  });
  const merged: GroupRow = { ...row, name: inv.name || row.name, creatorId: inv.creatorId, epoch: inv.epoch };
  await o.repo.saveGroup(merged);
  return merged;
}

/**
 * 粘入邀请码 / 续期码（册子 §3.3、§5.3）。**全程离线、零网络**（AC 1）。
 * 同一 epoch 视为幂等（重复粘同一张码不报错）；**比本地旧则拒绝**（否则续期码之后又粘旧码会把 epoch 拉回去）。
 */
export async function acceptInvite(o: GroupOptions, code: string): Promise<{ group: GroupRow; renewed: boolean }> {
  const inv = decodeInvite(code);
  const existing = await o.repo.getGroup(inv.groupId);
  if (existing && inv.epoch < existing.epoch) {
    throw new GroupError('key_stale', '这是旧邀请码，本地密钥已更新，无需重复入组');
  }
  const group = await saveInvite(o, inv);
  return { group, renewed: inv.epoch > (existing?.epoch ?? 0) };
}

/** 我参与的全部小组（零网络）。 */
export function listMyGroups(o: GroupOptions): Promise<GroupRow[]> {
  return o.repo.listGroups();
}

/** 构造一条 `group.v1` 请求体并签名（与 `buildCommentWire` 同构，只有 type/body 不同）。 */
function buildGroupWire(ident: Identity, body: Json): { eventId: string; wire: string } {
  const eventId = bytesToHex(randomBytes(16));
  const payload: Json = { event_id: eventId, type: 'group.v1', created_at: Date.now(), body };
  const sig = sign(ident.seedHex, utf8(canonicalize(payload)));
  return { eventId, wire: JSON.stringify({ ...(payload as Record<string, Json>), sig }) };
}

/**
 * 发一条已签名组事件；**只有网络不可达**才入 `comment_out`（册子 §5.4、AC 10）。
 * 节点给了任何 HTTP 响应（4xx/5xx）都原样抛出、不入队——与 `postComment` 同一口径。
 * 复用 `sendComment`（comment.ts 的补发入口）⇒ 签名头、错误码映射、`wire` 重放全部零新代码。
 */
async function submitWire(
  o: GroupOptions,
  input: { eventId: string; wire: string; targetId: string; queueText: string },
): Promise<{ queued: boolean }> {
  try {
    await sendComment(o, { targetId: input.targetId, text: input.queueText, wire: input.wire, eventId: input.eventId });
    return { queued: false };
  } catch (e) {
    if (e instanceof CommentError && e.code === 'network') {
      await o.repo.enqueueComment({
        eventId: input.eventId,
        targetId: input.targetId,
        text: input.queueText,
        replyTo: null,
        wire: input.wire,
        state: 'pending',
        reason: null,
        queuedAt: new Date().toISOString(),
      });
      return { queued: true };
    }
    throw e;
  }
}

/** roster 的 body：**完整名单快照**；`name` 缺省不带该键（与 `reply_to` 同处置）。 */
function rosterBody(groupId: string, epoch: number, memberIds: string[], name: string): Json {
  const body: Record<string, Json> = { group_id: groupId, action: 'roster', epoch, member_ids: [...memberIds] };
  if (name) body.name = name;
  return body;
}

/**
 * 建组（册子 §5.5）：本地生成 `group_id` / 组密钥 / `epoch=1` → 发首个 `roster` → 出邀请码。
 * **离线可用**：发不出去就入队（AC 1 的「A 建组出码」不依赖网络）。
 */
export async function createGroup(
  o: GroupOptions,
  opts: { name: string },
): Promise<{ group: GroupRow; inviteCode: string; queued: boolean }> {
  const ident = await ensureLocalIdentity(o.adapters.storage);
  const groupId = bytesToHex(randomBytes(16)); // 16 字节 = 32 hex，与 event_id 同形（节点侧契约）
  const groupKeyHex = bytesToHex(randomBytes(GROUP_KEY_BYTES));
  const now = new Date().toISOString();
  const group: GroupRow = {
    groupId,
    name: opts.name,
    creatorId: ident.id,
    epoch: 1,
    memberIdsJson: JSON.stringify([ident.id]),
    joinedAt: now,
  };
  await o.repo.putGroupKey({
    groupId,
    epoch: 1,
    keyCipher: await sealGroupKey(o.adapters.storage, hexToBytes(groupKeyHex)),
    createdAt: now,
  });
  await o.repo.saveGroup(group);

  const { eventId, wire } = buildGroupWire(ident, rosterBody(groupId, 1, [ident.id], opts.name));
  const { queued } = await submitWire(o, { eventId, wire, targetId: `group/${groupId}`, queueText: opts.name });

  const inviteCode = encodeInvite(
    signInvite(ident, {
      v: 1,
      groupId,
      targetId: `group/${groupId}`,
      name: opts.name,
      epoch: 1,
      groupKeyHex,
      creatorId: ident.id,
      creatorPubHex: ident.pubHex,
      createdAt: Date.now(),
    }),
  );
  return { group, inviteCode, queued };
}

/**
 * 移出成员 / 轮换（册子 §5.3 的三步，全在创建者本地）：新密钥 → 新 epoch 的 `roster` → 新续期码。
 * **仅创建者**可调用。返回的 `inviteCode` 即**续期码**，由调用方带外发给剩余成员。
 */
export async function rotateGroup(
  o: GroupOptions,
  groupId: string,
  memberIds: string[],
): Promise<{ group: GroupRow; inviteCode: string; queued: boolean }> {
  const ident = await ensureLocalIdentity(o.adapters.storage);
  const cur = await o.repo.getGroup(groupId);
  if (!cur) throw new GroupError('group_not_found', '本地没有这个小组');
  if (cur.creatorId !== ident.id) throw new GroupError('not_creator', '只有创建者可以轮换密钥');

  const epoch = cur.epoch + 1;
  const groupKeyHex = bytesToHex(randomBytes(GROUP_KEY_BYTES));
  const now = new Date().toISOString();
  const group: GroupRow = { ...cur, epoch, memberIdsJson: JSON.stringify(memberIds) };
  await o.repo.putGroupKey({
    groupId,
    epoch,
    keyCipher: await sealGroupKey(o.adapters.storage, hexToBytes(groupKeyHex)),
    createdAt: now,
  });
  await o.repo.saveGroup(group);

  const { eventId, wire } = buildGroupWire(ident, rosterBody(groupId, epoch, memberIds, cur.name));
  const { queued } = await submitWire(o, { eventId, wire, targetId: `group/${groupId}`, queueText: cur.name });

  const inviteCode = encodeInvite(
    signInvite(ident, {
      v: 1,
      groupId,
      targetId: `group/${groupId}`,
      name: cur.name,
      epoch,
      groupKeyHex,
      creatorId: ident.id,
      creatorPubHex: ident.pubHex,
      createdAt: Date.now(),
    }),
  );
  return { group, inviteCode, queued };
}

/**
 * 发一条小组消息（册子 §3.4 A）：用**当前 epoch 组密钥**加密，节点负责落块。
 * 断网入队时 `text` 列存**密文**（§5.4：列名语义是「正文载荷」，不承诺明文）。
 */
export async function postGroupMessage(
  o: GroupOptions,
  input: { groupId: string; text: string; replyTo?: string },
): Promise<{ eventId: string; queued: boolean }> {
  const group = await o.repo.getGroup(input.groupId);
  if (!group) throw new GroupError('group_not_found', '还没有加入这个小组');
  const row = (await o.repo.listGroupKeys(input.groupId)).find((r) => r.epoch === group.epoch);
  if (!row) throw new GroupError('client', `本地缺少 epoch ${group.epoch} 的组密钥`);
  const key = await openGroupKey(o.adapters.storage, row.keyCipher);
  const textCipher = sealText(key, input.text);

  const body: Record<string, Json> = {
    group_id: input.groupId,
    action: 'msg',
    epoch: group.epoch,
    text_cipher: textCipher,
  };
  if (input.replyTo) body.reply_to = input.replyTo;

  const ident = await ensureLocalIdentity(o.adapters.storage);
  const { eventId, wire } = buildGroupWire(ident, body);
  const { queued } = await submitWire(o, {
    eventId,
    wire,
    targetId: `group/${input.groupId}`,
    queueText: textCipher,
  });
  return { eventId, queued };
}

export interface GroupInfo {
  groupId: string;
  creatorId: string;
  epoch: number;
  memberIds: string[];
  name: string;
}

export interface GroupMessage {
  eventId: string;
  actor: string;
  createdAt: number;
  replyTo: string | null;
  epoch: number;
  payloadCid: string;
  /** 解密成功为明文；密钥缺失或解不开为 null（**不是**空串，UI 据此显示提示而非空白）。 */
  text: string | null;
}

/** 匿名读索引（册子 §4.3；与 `GET /v1/comment` 同构，只列 `action=msg`）。 */
export async function fetchGroup(
  o: GroupOptions,
  groupId: string,
  opts: { cursor?: string | null } = {},
): Promise<{ group: GroupInfo; events: GroupMessage[]; nextCursor: string | null }> {
  const qs = opts.cursor ? `?cursor=${encodeURIComponent(opts.cursor)}` : '';
  let res;
  try {
    res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/group/${groupId}${qs}`);
  } catch {
    throw new GroupError('network', '无法连接节点，请稍后重试');
  }
  if (res.status === 404) throw new GroupError('group_not_found', '该小组在节点上还没有名单');
  if (res.status !== 200) throw new GroupError('server', `读取小组失败（HTTP ${res.status}）`);
  const page = JSON.parse(decodeUtf8(res.body)) as {
    group?: Record<string, unknown>;
    events?: Array<Record<string, unknown>>;
    next_cursor?: string | null;
  };
  const g = page.group ?? {};
  const events = (page.events ?? []).map((e) => ({
    eventId: String(e.event_id ?? ''),
    actor: String(e.actor ?? ''),
    createdAt: Number(e.created_at ?? 0),
    replyTo: e.reply_to === null || e.reply_to === undefined ? null : String(e.reply_to),
    epoch: Number(e.epoch ?? 1),
    payloadCid: String(e.payload_cid ?? ''),
    text: null as string | null,
  }));
  return {
    group: {
      groupId: String(g.group_id ?? groupId),
      creatorId: String(g.creator_id ?? ''),
      epoch: Number(g.epoch ?? 1),
      memberIds: Array.isArray(g.member_ids) ? (g.member_ids as unknown[]).map(String) : [],
      name: String(g.name ?? ''),
    },
    events,
    nextCursor: page.next_cursor ?? null,
  };
}

/**
 * 取密文块（`GET /v1/blob/{payload_cid}`）。返回**文本**而非字节：
 * 节点存的正是 `text_cipher` 字符串的 UTF-8 字节（Task 2 Step 4：`cipher := []byte(g.TextCipher)`）。
 */
async function fetchCipher(o: GroupOptions, payloadCid: string): Promise<string | null> {
  try {
    const res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/blob/${payloadCid}`);
    if (res.status !== 200) return null;
    return decodeUtf8(res.body);
  } catch {
    return null;
  }
}

export interface GroupFeed {
  group: GroupInfo;
  events: GroupMessage[];
  nextCursor: string | null;
  /** 非空即为册子 §5.3 的**显式提示原文**，UI 必须原位显示（禁止静默跳过）。 */
  notice: string;
}

/**
 * 会话页数据：读索引 → 逐条取块 → 用**该条自己的 epoch 密钥**解密（历史消息靠 `group_keys` 留档）。
 * 解密失败或被移出（本地无该 epoch 密钥）触发提示原文（册子 §5.3）。
 * 读成功后把节点名单写回本地，但**仅当节点 epoch ≥ 本地 epoch**（补充 7：续期码可能先于 roster 到达）。
 */
export async function fetchGroupMessages(o: GroupOptions, groupId: string): Promise<GroupFeed> {
  const page = await fetchGroup(o, groupId);
  const local = await o.repo.getGroup(groupId);
  const keyMap = new Map<number, Uint8Array>();
  for (const row of await o.repo.listGroupKeys(groupId)) {
    try {
      keyMap.set(row.epoch, await openGroupKey(o.adapters.storage, row.keyCipher));
    } catch {
      // 单把密钥解不开不影响其余 epoch
    }
  }
  const items: GroupMessage[] = [];
  let decryptFailed = false;
  for (const ev of page.events) {
    let text: string | null = null;
    const cipher = ev.payloadCid ? await fetchCipher(o, ev.payloadCid) : null;
    if (cipher !== null) {
      const key = keyMap.get(ev.epoch);
      if (!key) {
        decryptFailed = true; // 本地没有该 epoch 的密钥 ⇒ 被移出或还没收到续期码
      } else {
        try {
          text = openText(key, cipher);
        } catch {
          decryptFailed = true; // 有密钥但认证失败 ⇒ 密钥已轮换
        }
      }
    }
    items.push({ ...ev, text });
  }
  if (local && page.group.epoch >= local.epoch) {
    await o.repo.saveGroup({
      ...local,
      name: page.group.name || local.name,
      epoch: page.group.epoch,
      memberIdsJson: JSON.stringify(page.group.memberIds),
    });
  }
  const stale = page.group.epoch > (local?.epoch ?? 0);
  return {
    group: page.group,
    events: items,
    nextCursor: page.nextCursor,
    notice: stale || decryptFailed ? GROUP_KEY_STALE_NOTICE : '',
  };
}
