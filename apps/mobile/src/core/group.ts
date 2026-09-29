/**
 * 学习小组（② 加密）：邀请码编解码、建圈/入圈/轮换、发言编排、读索引 + 取块解密。
 * 治理圈子 v2：双形态（开放 / 封闭）、多签收集（`base2:` / `base3:` 带外码）、信封链自动补钥、席位消费。
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
  sha256Hex,
  sign,
  utf8,
  verify,
  type Json,
} from '@base/protocol-ts';

import type { GroupRow } from './types';
import { ensureLocalIdentity, signRequestHeaders, type Identity } from './identity';
import { decodeUtf8 } from './sync';
import {
  base64UrlToBytes,
  buildEventWire,
  bytesToBase64Url,
  openKeyCipher,
  openText,
  sealKeyCipher,
  sealText,
  submitWire,
  type WireOptions,
} from './wire';

/** 与 `WireOptions` 同形（原样保留这个导出名，页面与测试的 import 不必改）。 */
export type GroupOptions = WireOptions;

export type GroupErrorCode =
  | 'invite_invalid'
  | 'not_creator'
  | 'key_stale'
  | 'group_not_found'
  | 'unregistered'
  | 'rejected'
  | 'network'
  | 'server'
  | 'client'
  | 'roster_request_invalid'
  | 'roster_quorum_missing';

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
/** `wire.ts` 里是未导出的模块内常量（=12）；此处自带一份，不改 wire.ts。 */
const GCM_NONCE_BYTES = 12;

export interface GroupInvite {
  v: number;
  groupId: string;
  targetId: string;
  name: string;
  epoch: number;
  groupKeyHex: string;
  /** = **签发者**身份 id（任一在册成员或治者均可签发，字段名沿用以保 v1 兼容）。 */
  creatorId: string;
  creatorPubHex: string;
  createdAt: number;
  /** v2 新增，**进签名域**：能解入圈前的历史（最多 32 个 epoch）。 */
  historyKeys?: string[];
  /** v2 新增，**进签名域**：0 = 开放圈，1 = 封闭圈。 */
  encrypted?: number;
  /** v2 新增，**进签名域**：签发时的成员变更计数。 */
  rosterRev?: number;
  sig: string;
}

/**
 * 签名域：v1 恒 9 键（老客户端能验），v2 把三个新键一起签进去
 * （`name` 缺省写空串，避免同一组 canonicalize 出两种字节序）。
 */
function inviteSignFields(inv: GroupInvite): Record<string, Json> {
  const f: Record<string, Json> = {
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
  if (inv.v >= 2) {
    f.history_keys = inv.historyKeys ?? [];
    f.encrypted = inv.encrypted ?? 1;
    f.roster_rev = inv.rosterRev ?? 1;
  }
  return f;
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
  if (inv.v !== 1 && inv.v !== 2) throw invalidInvite();
  // group_id 与 event_id 同形：16 字节 = 32 hex（节点侧 isHexN(id,16) 即 len==32）。
  if (!isHexN(inv.groupId, 32) || inv.targetId !== `group/${inv.groupId}`) throw invalidInvite();
  if (!isHexN(inv.groupKeyHex, 64)) throw invalidInvite();
  if (!isIdentityId(inv.creatorId) || !isHexN(inv.creatorPubHex, 64)) throw invalidInvite();
  if (!Number.isInteger(inv.epoch) || inv.epoch < 1 || !Number.isInteger(inv.createdAt)) throw invalidInvite();
  if (inv.v === 2) {
    const hk = m.history_keys;
    if (hk !== undefined) {
      if (!Array.isArray(hk) || hk.length > 32 || hk.some((s) => typeof s !== 'string' || !isHexN(s, 64))) {
        throw invalidInvite();
      }
      inv.historyKeys = hk.map(String);
    } else {
      inv.historyKeys = [];
    }
    const enc = Number(m.encrypted);
    if (enc !== 0 && enc !== 1) throw invalidInvite();
    inv.encrypted = enc;
    const rev = Number(m.roster_rev);
    if (!Number.isInteger(rev) || rev < 1) throw invalidInvite();
    inv.rosterRev = rev;
  }
  if (deriveIdentityId(inv.creatorPubHex) !== inv.creatorId) throw invalidInvite();
  if (!verify(inv.creatorPubHex, utf8(canonicalize(inviteSignFields(inv))), inv.sig)) throw invalidInvite();
  return inv;
}

/** 用创建者身份私钥对签名域字段签名（不含 `sig` 自身）。 */
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
    // v1 老码没有 encrypted 键 ⇒ 缺省封闭（存量语义，AC 13）；rosterRev 缺省 0
    encrypted: inv.encrypted ?? 1,
    rosterRev: inv.rosterRev ?? 0,
    memberIdsJson: '[]', // 邀请码里只有创建者，没有全体成员 → 以节点读回为准
    joinedAt: new Date().toISOString(),
  };
  await o.repo.putGroupKey({
    groupId: inv.groupId,
    epoch: inv.epoch,
    keyCipher: await sealKeyCipher(o.adapters.storage, hexToBytes(inv.groupKeyHex)),
    createdAt: new Date().toISOString(),
  });
  const merged: GroupRow = {
    ...row,
    name: inv.name || row.name,
    creatorId: inv.creatorId,
    epoch: inv.epoch,
    encrypted: inv.encrypted ?? row.encrypted,
    rosterRev: Math.max(inv.rosterRev ?? 0, row.rosterRev),
  };
  await o.repo.saveGroup(merged);
  return merged;
}

/**
 * 粘入邀请码（册子 §3.3）。**全程离线、零网络**（AC 1）。
 * 同一 epoch 视为幂等（重复粘同一张码不报错）；**比本地旧则拒绝**（否则旧码会把 epoch 拉回去）。
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

/* ------------------------------------------------------------------ *
 * 信封链（补充 3 / 12）：用旧 epoch 钥加密新 epoch 钥，对称链、零新算法
 * ------------------------------------------------------------------ */

export interface GroupEnvelope {
  fromEpoch: number;
  cipher: string;
}

/** 造一个信封：**用旧 epoch 钥加密新 epoch 钥**。 */
export function sealEnvelope(oldKey: Uint8Array, newKey: Uint8Array, fromEpoch: number): GroupEnvelope {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const ct = sealWithNonce(oldKey, nonce, newKey);
  const buf = new Uint8Array(nonce.length + ct.length);
  buf.set(nonce, 0);
  buf.set(ct, nonce.length);
  return { fromEpoch, cipher: bytesToBase64Url(buf) };
}

export function openEnvelope(oldKey: Uint8Array, env: GroupEnvelope): Uint8Array {
  const buf = base64UrlToBytes(env.cipher);
  if (buf.length < GCM_NONCE_BYTES + 16) throw new Error('group: 信封过短');
  return openWithNonce(oldKey, buf.subarray(0, GCM_NONCE_BYTES), buf.subarray(GCM_NONCE_BYTES));
}

/**
 * 从「本地已持有的 epoch 密钥 + 节点下发的信封」解链到 `targetEpoch`。
 * 先把 epoch 递减到「本地已有的一层」，再逐层向上解开；链长上限 32（与历史上限同值）。
 */
export function resolveKeyChain(
  have: Map<number, Uint8Array>,
  envelopes: GroupEnvelope[],
  targetEpoch: number,
): Uint8Array | null {
  const direct = have.get(targetEpoch);
  if (direct) return direct;
  const byFrom = new Map(envelopes.map((e) => [e.fromEpoch, e]));
  const chain: GroupEnvelope[] = [];
  let epoch = targetEpoch;
  while (!have.has(epoch)) {
    const env = byFrom.get(epoch - 1);
    if (!env || epoch <= 1 || chain.length >= 32) return null;
    chain.push(env);
    epoch -= 1;
  }
  let key = have.get(epoch)!;
  for (let i = chain.length - 1; i >= 0; i--) {
    try {
      key = openEnvelope(key, chain[i]!);
    } catch {
      return null; // 链上任一层解不开 ⇒ 整链放弃（不半途而废，避免写进错误的钥）
    }
  }
  return key;
}

/* ------------------------------------------------------------------ *
 * v1 名单形态（建圈）：`action: 'roster'` 且 body **无** `sigs` 键
 * ------------------------------------------------------------------ */

/** roster 的 body：**完整名单快照**；`name` 缺省不带该键（与 `reply_to` 同处置）。 */
function rosterBody(groupId: string, epoch: number, memberIds: string[], name: string, encrypted: number): Json {
  const body: Record<string, Json> = {
    group_id: groupId,
    action: 'roster',
    epoch,
    member_ids: [...memberIds],
    encrypted,
  };
  if (name) body.name = name;
  return body;
}

/**
 * 建圈（册子 §5.5）：本地生成 `group_id` / 组密钥 / `epoch=1` → 发首个 `roster`（v1 形态）→ 出邀请码。
 * **定案（补充 16）**：建圈一律走 v1 形态 roster（无 `sigs`），`encrypted` 由节点 v1 分支按 body 取值（缺省 1）。
 * **离线可用**：发不出去就入队（AC 1 的「A 建圈出码」不依赖网络）。
 */
export async function createGroup(
  o: GroupOptions,
  opts: { name: string; encrypted: boolean },
): Promise<{ group: GroupRow; inviteCode: string; queued: boolean }> {
  const ident = await ensureLocalIdentity(o.adapters.storage);
  const groupId = bytesToHex(randomBytes(16)); // 16 字节 = 32 hex，与 event_id 同形（节点侧契约）
  const groupKeyHex = bytesToHex(randomBytes(GROUP_KEY_BYTES));
  const encrypted = opts.encrypted ? 1 : 0;
  const now = new Date().toISOString();
  const group: GroupRow = {
    groupId,
    name: opts.name,
    creatorId: ident.id,
    epoch: 1,
    encrypted,
    rosterRev: 1,
    memberIdsJson: JSON.stringify([ident.id]),
    joinedAt: now,
  };
  await o.repo.putGroupKey({
    groupId,
    epoch: 1,
    keyCipher: await sealKeyCipher(o.adapters.storage, hexToBytes(groupKeyHex)),
    createdAt: now,
  });
  await o.repo.saveGroup(group);

  const { eventId, wire } = buildEventWire(
    ident,
    'group.v1',
    rosterBody(groupId, 1, [ident.id], opts.name, encrypted),
  );
  const { queued } = await submitWire(o, { eventId, wire, targetId: `group/${groupId}`, queueText: opts.name });

  const inviteCode = encodeInvite(
    signInvite(ident, {
      v: 2,
      groupId,
      targetId: `group/${groupId}`,
      name: opts.name,
      epoch: 1,
      groupKeyHex,
      creatorId: ident.id,
      creatorPubHex: ident.pubHex,
      createdAt: Date.now(),
      historyKeys: [],
      encrypted,
      rosterRev: 1,
    }),
  );
  return { group, inviteCode, queued };
}

/* ------------------------------------------------------------------ *
 * v2 名单草稿、多签请求码 / 回执码、提交（册子 §3.4，补充 15）
 * ------------------------------------------------------------------ */

export type RosterSub = 'rename' | 'rotate' | 'leave' | 'join' | 'remove' | 'dissolve';

export interface RosterDraft {
  v: 2;
  eventId: string;
  groupId: string;
  sub: RosterSub;
  epoch: number;
  rosterRev: number;
  memberIds: string[];
  encrypted: number;
  createdAt: number;
  name?: string;
}

/** 节点侧同构的待签载荷（补充 4）：`domain` 只在签名时加，不进请求体。 */
function approvalFields(d: RosterDraft): Record<string, Json> {
  const f: Record<string, Json> = {
    domain: 'base/group-roster-v2',
    event_id: d.eventId,
    group_id: d.groupId,
    action: 'roster',
    sub: d.sub,
    epoch: d.epoch,
    roster_rev: d.rosterRev,
    member_ids: [...d.memberIds],
    encrypted: d.encrypted,
    created_at: d.createdAt,
  };
  if (d.name) f.name = d.name;
  return f;
}

/** 草稿码 `base2:`：**去掉 domain**（它是节点的验签域常量，不是协议字段）。 */
function draftFields(d: RosterDraft): Record<string, Json> {
  const f = { ...approvalFields(d) };
  delete f.domain;
  return f;
}

/** 两段码的前缀；本册的 `base2:` / `base3:`（补充 15）。 */
const ROSTER_REQUEST_PREFIX = 'base2:';
const SIG_RECEIPT_PREFIX = 'base3:';
const ROSTER_SUBS: RosterSub[] = ['rename', 'rotate', 'leave', 'join', 'remove', 'dissolve'];

/** 草稿的 canonical 字节（`base2:` 码体 / 回执里的 `request_hash` 都基于它）。 */
function draftBytes(d: RosterDraft): Uint8Array {
  return utf8(canonicalize({ v: 2, ...draftFields(d) }));
}

/**
 * 编码为 `base2:` 签名请求码。它**就是**那次名单变更的完整草稿：
 * 治者把它发给同伴，或贴进同一台机器的另一身份。
 */
export function encodeRosterRequest(d: RosterDraft): string {
  return `${ROSTER_REQUEST_PREFIX}${bytesToBase64Url(draftBytes(d))}`;
}

/**
 * `base2:` 的逆运算。任何形态不合法都统一报 `roster_request_invalid`（不猜、不修）。
 * `isHexN` 在本文件是**字符数**口径：id = 32 hex、pub = 64 hex、sig = 128 hex。
 */
export function decodeRosterRequest(code: string): RosterDraft {
  const raw = code.trim();
  if (!raw.startsWith(ROSTER_REQUEST_PREFIX)) {
    throw new GroupError('roster_request_invalid', '这不是签名请求码（应以 base2: 开头）');
  }
  let o: Record<string, any>;
  try {
    o = JSON.parse(decodeUtf8(base64UrlToBytes(raw.slice(ROSTER_REQUEST_PREFIX.length)))) as Record<string, any>;
  } catch {
    throw new GroupError('roster_request_invalid', '签名请求码不是合法的 base64url JSON');
  }
  const nameOK = o.name === undefined || typeof o.name === 'string';
  // `member_ids` 空数组只有 `dissolve` 放行（与节点补充 11 / 更正 18 同口径）
  const membersOK =
    Array.isArray(o.member_ids) &&
    (o.member_ids.length > 0 || o.sub === 'dissolve') &&
    o.member_ids.every((s: unknown) => typeof s === 'string' && isHexN(s, 32));
  const ok =
    o.v === 2 &&
    typeof o.event_id === 'string' &&
    isHexN(o.event_id, 32) &&
    typeof o.group_id === 'string' &&
    isHexN(o.group_id, 32) &&
    ROSTER_SUBS.includes(o.sub) &&
    Number.isInteger(o.epoch) &&
    o.epoch >= 1 &&
    Number.isInteger(o.roster_rev) &&
    o.roster_rev >= 1 &&
    membersOK &&
    (o.encrypted === 0 || o.encrypted === 1) &&
    Number.isInteger(o.created_at) &&
    o.created_at > 0 &&
    nameOK;
  if (!ok) throw new GroupError('roster_request_invalid', '签名请求码字段不合法');
  const d: RosterDraft = {
    v: 2,
    eventId: o.event_id,
    groupId: o.group_id,
    sub: o.sub,
    epoch: o.epoch,
    rosterRev: o.roster_rev,
    memberIds: [...o.member_ids],
    encrypted: o.encrypted,
    createdAt: o.created_at,
  };
  if (typeof o.name === 'string' && o.name !== '') d.name = o.name;
  return d;
}

/** 自己对草稿签名，产出 `base3:` 回执码。 */
export async function signSigRequest(o: GroupOptions, code: string): Promise<string> {
  const d = decodeRosterRequest(code);
  const ident = await ensureLocalIdentity(o.adapters.storage);
  const sig = sign(ident.seedHex, utf8(canonicalize(approvalFields(d))));
  const requestHash = sha256Hex(draftBytes(d)).slice(0, 16);
  return `${SIG_RECEIPT_PREFIX}${bytesToBase64Url(
    utf8(canonicalize({ v: 2, request_hash: requestHash, id: ident.id, pub: ident.pubHex, sig })),
  )}`;
}

/**
 * 校验一条回执是否针对**这份草稿**、且签名有效；返回 `{id, pub, sig}` 或 null（不抛错——收码入口只需过滤）。
 * `pub` 由本地推导的 id 自证（`deriveIdentityId(pub) === id`），故离线即可验签（补充 15）。
 */
export function readSigReceipt(code: string, d: RosterDraft): { id: string; pub: string; sig: string } | null {
  const raw = code.trim();
  if (!raw.startsWith(SIG_RECEIPT_PREFIX)) return null;
  let o: Record<string, any>;
  try {
    o = JSON.parse(decodeUtf8(base64UrlToBytes(raw.slice(SIG_RECEIPT_PREFIX.length)))) as Record<string, any>;
  } catch {
    return null;
  }
  if (
    o?.v !== 2 ||
    typeof o.request_hash !== 'string' ||
    typeof o.id !== 'string' ||
    !isIdentityId(o.id) ||
    typeof o.pub !== 'string' ||
    !isHexN(o.pub, 64) ||
    typeof o.sig !== 'string' ||
    !isHexN(o.sig, 128) ||
    deriveIdentityId(o.pub) !== o.id
  ) {
    return null;
  }
  const want = sha256Hex(draftBytes(d)).slice(0, 16);
  if (o.request_hash !== want) return null; // 回执是给别的草稿签的 ⇒ 丢弃（不报错）
  if (!verify(o.pub, utf8(canonicalize(approvalFields(d))), o.sig)) return null;
  return { id: o.id, pub: o.pub, sig: o.sig };
}

/** 治理人席位数 k(m)（册子 §3.2）：m ≤ 10 ⇒ 1 席；否则 min(10, 3 + ⌊(m−11)/10⌋)。纯函数，客户端可算。 */
export function governorSeats(m: number): number {
  return m <= 10 ? 1 : Math.min(10, 3 + Math.floor((m - 11) / 10));
}

const ceil2of3 = (k: number): number => Math.ceil((2 * k) / 3);

/** 客户端侧的门槛镜像（仅用于「凑够没凑够」的原位提示；节点侧才是裁决者）。 */
function quorumOf(sub: RosterSub, k: number, m: number): { proposer: number; votes: number; label: string } {
  if (sub === 'dissolve') {
    return { proposer: Math.min(2, k), votes: Math.min(30, Math.floor(m / 3) + 1), label: '解散圈子' };
  }
  if (sub === 'remove') return { proposer: 1, votes: ceil2of3(k), label: '移出成员' };
  return { proposer: 1, votes: 1, label: '改名 / 轮换 / 退出' };
}

/**
 * 与 `buildEventWire` 同构，但 **`event_id` / `created_at` 由调用方给定**（补充 17）。
 *
 * 为什么不能用 `buildEventWire`：v2 名单的多签载荷由节点按 `req.EventID` + `req.CreatedAt`
 * 重建（`rosterApprovalPayload`），而这两个值来自**外层信封**。若信封里的 `event_id` 现生成，
 * 就与签名者签进草稿的那个 `event_id` 不一致 ⇒ 全部签名验不过。故 v2 名单必须用本函数。
 */
function buildGroupWireAt(ident: Identity, eventId: string, createdAt: number, body: Json): string {
  const payload: Json = { event_id: eventId, type: 'group.v1', created_at: createdAt, body };
  const sig = sign(ident.seedHex, utf8(canonicalize(payload)));
  return JSON.stringify({ ...(payload as Record<string, Json>), sig });
}

/**
 * 提交一次名单变更（册子 §3.4）。`receipts` 里只保留**验过的**那几条；门槛不足时**原地报错**——
 * 错误文案按册子 §6 的原位提示口径（「需 N 名签名（…），当前 M 名」）。
 */
export async function submitRoster(
  o: GroupOptions,
  requestCode: string,
  receipts: string[],
): Promise<{ queued: boolean; epoch: number }> {
  const d = decodeRosterRequest(requestCode);
  // 1. 只留「针对这份草稿、签名有效」的回执；同一 id 只算一签（节点侧也去重，这里只是镜像）
  const signers = new Map<string, { id: string; sig: string }>();
  for (const code of receipts) {
    const r = readSigReceipt(code, d);
    if (r) signers.set(r.id, { id: r.id, sig: r.sig });
  }
  // 2. 门槛镜像：k 只依赖 m（纯函数，客户端算得出）；「谁算治者」依赖贡献度排名，客户端算不出 ⇒ 留给节点裁决
  const m = d.memberIds.length;
  const q = quorumOf(d.sub, governorSeats(m), m);
  if (signers.size < q.votes) {
    throw new GroupError('roster_quorum_missing', `需 ${q.votes} 名签名（${q.label}），当前 ${signers.size} 名`);
  }
  // 3. 信封里的 `event_id` / `created_at` **必须等于草稿值**：节点按这两个值重建多签载荷（补充 4）
  const ident = await ensureLocalIdentity(o.adapters.storage);
  // `action` 固定 `'roster'`（更正 21）：节点按 `action:"roster"` + body 有无 `sigs` 分流。
  const body: Record<string, Json> = {
    group_id: d.groupId,
    action: 'roster',
    sub: d.sub,
    epoch: d.epoch,
    roster_rev: d.rosterRev,
    member_ids: [...d.memberIds],
    encrypted: d.encrypted,
    sigs: [...signers.values()],
  };
  if (d.name) body.name = d.name;
  const wire = buildGroupWireAt(ident, d.eventId, d.createdAt, body);
  const { queued } = await submitWire(o, {
    eventId: d.eventId,
    wire,
    targetId: `group/${d.groupId}`,
    queueText: q.label,
  });
  return { queued, epoch: d.epoch };
}

/* ------------------------------------------------------------------ *
 * 便捷入口（建圈请求 / 开放圈自加入 / 改名 / 轮换 / 移出 / 退出 / 解散）
 * ------------------------------------------------------------------ */

/** 读本地 `groups` 行 → 组草稿 → `base2:` 码。`bumpEpoch` 表达这次的名单变更是否同步前推 epoch。 */
export async function buildRosterRequest(
  o: GroupOptions,
  groupId: string,
  input: { sub: RosterSub; memberIds: string[]; name?: string; bumpEpoch?: boolean },
): Promise<string> {
  const cur = await o.repo.getGroup(groupId);
  if (!cur) throw new GroupError('group_not_found', '本地没有这个圈子');
  const d: RosterDraft = {
    v: 2,
    eventId: bytesToHex(randomBytes(16)),
    groupId,
    sub: input.sub,
    epoch: input.bumpEpoch ? cur.epoch + 1 : cur.epoch,
    rosterRev: (cur.rosterRev || 0) + 1,
    memberIds: [...input.memberIds],
    encrypted: cur.encrypted,
    createdAt: Date.now(),
  };
  if (input.name) d.name = input.name;
  return encodeRosterRequest(d);
}

/** 开放圈自助自加入：`sub='join'`、`encrypted=0`、只有自己一签（节点侧要求签名者恒等于 actor）。 */
export async function joinOpenGroup(o: GroupOptions, groupId: string): Promise<{ queued: boolean }> {
  const ident = await ensureLocalIdentity(o.adapters.storage);
  const cur = await o.repo.getGroup(groupId);
  const memberIds = cur ? (JSON.parse(cur.memberIdsJson) as string[]) : [];
  if (!memberIds.includes(ident.id)) memberIds.push(ident.id);
  const d: RosterDraft = {
    v: 2,
    eventId: bytesToHex(randomBytes(16)),
    groupId,
    sub: 'join',
    epoch: (cur?.epoch ?? 0) + 1, // 节点要求 epoch 严格递增；本机未知的圈子按首个 epoch 出草稿
    rosterRev: (cur?.rosterRev ?? 0) + 1,
    memberIds,
    encrypted: 0,
    createdAt: Date.now(),
  };
  const requestCode = encodeRosterRequest(d);
  const mine = await signSigRequest(o, requestCode);
  const { queued } = await submitRoster(o, requestCode, [mine]);
  return { queued };
}

/** 改名：`sub='rename'`、不带新名以外的东西。 */
export async function renameGroup(o: GroupOptions, groupId: string, name: string): Promise<{ requestCode: string }> {
  const cur = await o.repo.getGroup(groupId);
  if (!cur) throw new GroupError('group_not_found', '本地没有这个圈子');
  const requestCode = await buildRosterRequest(o, groupId, {
    sub: 'rename',
    memberIds: JSON.parse(cur.memberIdsJson) as string[],
    name,
  });
  return { requestCode };
}

/**
 * 轮换：新 epoch 钥 → 用旧钥封一个信封 → 本地写钥并前推 epoch → 组 `sub='rotate'` 草稿。
 * 返回 `envelopes` 供分发（节点读接口的 `envelopes` 字段即由它落库）。
 */
export async function rotateGroup(
  o: GroupOptions,
  groupId: string,
  opts: { memberIds: string[] },
): Promise<{ requestCode: string; envelopes: GroupEnvelope[] }> {
  const cur = await o.repo.getGroup(groupId);
  if (!cur) throw new GroupError('group_not_found', '本地没有这个圈子');
  // 先出草稿（epoch = cur+1、rosterRev = cur+1），本地换钥再前推到**同一个** epoch（顺序不可反）
  const requestCode = await buildRosterRequest(o, groupId, {
    sub: 'rotate',
    memberIds: opts.memberIds,
    bumpEpoch: true,
  });
  const { envelope } = await localRotate(o, cur, opts.memberIds);
  return { requestCode, envelopes: envelope ? [envelope] : [] };
}

/** 移出成员：`sub='remove'` 草稿（**不**换钥、**不**推 epoch——换钥走 `rotateGroup`）。 */
export async function removeMember(
  o: GroupOptions,
  groupId: string,
  memberId: string,
): Promise<{ requestCode: string }> {
  const cur = await o.repo.getGroup(groupId);
  if (!cur) throw new GroupError('group_not_found', '本地没有这个圈子');
  const members = (JSON.parse(cur.memberIdsJson) as string[]).filter((id) => id !== memberId);
  return { requestCode: await buildRosterRequest(o, groupId, { sub: 'remove', memberIds: members }) };
}

/** 退出圈子（需要一名治者确认，册子 §3.4）：名单去掉自己。 */
export async function leaveGroup(o: GroupOptions, groupId: string): Promise<{ requestCode: string }> {
  const ident = await ensureLocalIdentity(o.adapters.storage);
  const cur = await o.repo.getGroup(groupId);
  if (!cur) throw new GroupError('group_not_found', '本地没有这个圈子');
  const members = (JSON.parse(cur.memberIdsJson) as string[]).filter((id) => id !== ident.id);
  return { requestCode: await buildRosterRequest(o, groupId, { sub: 'leave', memberIds: members }) };
}

/** 解散圈子：名单清空（补充 11）。 */
export async function dissolveGroup(o: GroupOptions, groupId: string): Promise<{ requestCode: string }> {
  return { requestCode: await buildRosterRequest(o, groupId, { sub: 'dissolve', memberIds: [] }) };
}

/** 轮换：新 epoch 钥 → 用旧钥封一个信封 → 本地写钥并前推 epoch（册子 §3.5）。 */
async function localRotate(
  o: GroupOptions,
  cur: GroupRow,
  memberIds: string[],
): Promise<{ group: GroupRow; envelope: GroupEnvelope | null; newKeyHex: string }> {
  const epoch = cur.epoch + 1;
  const newKeyHex = bytesToHex(randomBytes(GROUP_KEY_BYTES));
  const oldRow = (await o.repo.listGroupKeys(cur.groupId)).find((r) => r.epoch === cur.epoch);
  let envelope: GroupEnvelope | null = null;
  if (oldRow) {
    try {
      const oldKey = await openKeyCipher(o.adapters.storage, oldRow.keyCipher);
      envelope = sealEnvelope(oldKey, hexToBytes(newKeyHex), cur.epoch);
    } catch {
      envelope = null; // 本地旧钥解不开 ⇒ 不产信封（成员需重贴邀请码，UI 原位提示）
    }
  }
  await o.repo.putGroupKey({
    groupId: cur.groupId,
    epoch,
    keyCipher: await sealKeyCipher(o.adapters.storage, hexToBytes(newKeyHex)),
    createdAt: new Date().toISOString(),
  });
  const group: GroupRow = {
    ...cur,
    epoch,
    rosterRev: (cur.rosterRev || 0) + 1,
    memberIdsJson: JSON.stringify(memberIds),
  };
  await o.repo.saveGroup(group);
  return { group, envelope, newKeyHex };
}

/* ------------------------------------------------------------------ *
 * 发言与读索引
 * ------------------------------------------------------------------ */

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
  const key = await openKeyCipher(o.adapters.storage, row.keyCipher);
  const textCipher = sealText(key, input.text);

  const body: Record<string, Json> = {
    group_id: input.groupId,
    action: 'msg',
    epoch: group.epoch,
    text_cipher: textCipher,
  };
  if (input.replyTo) body.reply_to = input.replyTo;

  const ident = await ensureLocalIdentity(o.adapters.storage);
  const { eventId, wire } = buildEventWire(ident, 'group.v1', body);
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
  encrypted: number;
  rosterRev: number;
  seatCount: number;
  governors: string[];
  envelopes: GroupEnvelope[];
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

/** 读权分支（册子 §4.3）：已知封闭圈 ⇒ 直接带签名头；未知（或开放圈）⇒ 先匿名，404 后再带签名头重试一次。 */
export async function fetchGroup(
  o: GroupOptions,
  groupId: string,
  opts: { cursor?: string | null } = {},
): Promise<{ group: GroupInfo; events: GroupMessage[]; nextCursor: string | null }> {
  const local = await o.repo.getGroup(groupId);
  const first = await getGroupPage(o, groupId, opts, local?.encrypted === 1);
  if (first.status === 404) {
    if (local?.encrypted === 1) throw new GroupError('group_not_found', '圈子不存在或你没有读权');
    const retry = await getGroupPage(o, groupId, opts, true); // 本机不认识这个圈子：可能是封闭圈且我是成员
    if (retry.status !== 200) throw new GroupError('group_not_found', '圈子不存在或你没有读权');
    return parseGroupPage(retry, groupId);
  }
  if (first.status !== 200) throw new GroupError('server', `读取圈子失败（HTTP ${first.status}）`);
  return parseGroupPage(first, groupId);
}

/** `fetchGroup` 的唯一网络出口；非 2xx **不抛错**，把 `status` 交给调用方判 404 重试。 */
async function getGroupPage(
  o: GroupOptions,
  groupId: string,
  opts: { cursor?: string | null },
  signed: boolean,
): Promise<{ status: number; body: Uint8Array }> {
  const query = opts.cursor ? `cursor=${encodeURIComponent(opts.cursor)}` : '';
  const path = `/v1/group/${groupId}`;
  let headers: Record<string, string> | undefined;
  if (signed) {
    const ident = await ensureLocalIdentity(o.adapters.storage);
    // `path` 不含 query、`query` 传原串——与节点 `r.URL.Path` / `r.URL.RawQuery` 口径一致
    headers = { ...signRequestHeaders(ident, { method: 'GET', path, query }) };
  }
  try {
    return await o.adapters.http.get(`${o.nodeBaseUrl}${path}${query ? `?${query}` : ''}`, headers);
  } catch {
    throw new GroupError('network', '无法连接节点，请稍后重试');
  }
}

/** 解析一次读响应（含新增的五个 group 字段）；非 200 由调用方处理。 */
function parseGroupPage(
  res: { body: Uint8Array },
  groupId: string,
): { group: GroupInfo; events: GroupMessage[]; nextCursor: string | null } {
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
      encrypted: Number(g.encrypted ?? 1),
      rosterRev: Number(g.roster_rev ?? 0),
      seatCount: Number(g.seat_count ?? 1),
      governors: Array.isArray(g.governors) ? (g.governors as unknown[]).map(String) : [],
      envelopes: Array.isArray(g.envelopes)
        ? (g.envelopes as Array<Record<string, unknown>>).map((e) => ({
            fromEpoch: Number(e.from_epoch ?? 0),
            cipher: String(e.cipher ?? ''),
          }))
        : [],
    },
    events,
    nextCursor: page.next_cursor ?? null,
  };
}

/**
 * 取密文块（`GET /v1/blob/{payload_cid}`）。返回**文本**而非字节：
 * 节点存的正是 `text_cipher` 字符串的 UTF-8 字节。
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
 * 解密前先做「缺层钥补全」：用节点下发的信封链现解现写 `group_keys`（补充 12 的落地路径，AC 4）。
 * 解密失败或被移出（本地无该 epoch 密钥）触发提示原文（册子 §5.3）。
 * 读成功后把节点名单写回本地，但**仅当节点 epoch ≥ 本地 epoch**（补充 7）。
 */
export async function fetchGroupMessages(o: GroupOptions, groupId: string): Promise<GroupFeed> {
  const page = await fetchGroup(o, groupId);
  const local = await o.repo.getGroup(groupId);
  const keyMap = new Map<number, Uint8Array>();
  for (const row of await o.repo.listGroupKeys(groupId)) {
    try {
      keyMap.set(row.epoch, await openKeyCipher(o.adapters.storage, row.keyCipher));
    } catch {
      // 单把密钥解不开不影响其余 epoch
    }
  }
  // 节点下发的信封链：缺哪一层的钥就现解现写（AC 4）。链上任一层解不开 ⇒ 整链放弃（不写错钥）。
  const missing = new Set(page.events.map((e) => e.epoch).filter((n) => !keyMap.has(n)));
  if (missing.size > 0) {
    const resolved = resolveKeyChain(keyMap, page.group.envelopes, page.group.epoch);
    if (resolved) {
      await o.repo.putGroupKey({
        groupId,
        epoch: page.group.epoch,
        keyCipher: await sealKeyCipher(o.adapters.storage, resolved),
        createdAt: new Date().toISOString(),
      });
      keyMap.set(page.group.epoch, resolved);
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
        decryptFailed = true; // 本地没有该 epoch 的密钥 ⇒ 被移出或还没收到新钥
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
      rosterRev: Math.max(local.rosterRev, page.group.rosterRev),
      memberIdsJson: JSON.stringify(page.group.memberIds),
    });
  }
  // 节点 epoch 领先本地，且补钥之后仍**没有**当前 epoch 的钥 ⇒ 才提示（补钥成功即无需索取新码）
  const stale = page.group.epoch > (local?.epoch ?? 0) && !keyMap.has(page.group.epoch);
  return {
    group: page.group,
    events: items,
    nextCursor: page.nextCursor,
    notice: stale || decryptFailed ? GROUP_KEY_STALE_NOTICE : '',
  };
}