/**
 * 私信（② 加密）：好友码编解码与离线自验、建好友 / 收码、会话列表、发言、双 target_id 合并解密。
 *
 * 只依赖注入的适配器 / `LocalRepo` / `core/identity`，不 import 'uni' / 'plus'，
 * 因此可在 Node 下用 `core/fakes.ts` 完整测试（与 core/group.ts 同一约定）。
 * 密码学**零新代码**：wire 与密文原语来自 `core/wire.ts`（#32 §5.2）。
 */
import {
  bytesToHex,
  canonicalize,
  deriveIdentityId,
  hexToBytes,
  isIdentityId,
  randomBytes,
  sign,
  utf8,
  verify,
  type Json,
} from '@base/protocol-ts';

import type { Adapters } from '../platform/adapter';
import type { LocalRepo } from './repo';
import { ensureLocalIdentity, peekLocalIdentity, type Identity } from './identity';
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

/** 与 `WireOptions` **同形**：离线发言可直接把 `o` 喂给 `flushPending` 与 `submitWire`。 */
export type DmOptions = WireOptions;

export type DmErrorCode =
  | 'friend_code_invalid'
  | 'key_conflict'
  | 'not_friend'
  | 'too_long'
  | 'client'
  | 'network'
  | 'server'
  | 'rejected'
  | 'unregistered'
  | 'rate_limited'
  | 'revoked';

export class DmError extends Error {
  constructor(
    readonly code: DmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DmError';
  }
}

/** 好友码自验失败**统一文案**（册子 §3.2：不区分哪一步失败，不泄漏「哪一步失败」）。 */
export const FRIEND_CODE_INVALID_MESSAGE = '好友码无效或已损坏';
/** 本地无该 peer 密钥时的原位提示（册子 §5.3；密文原文永不进界面）。 */
export const DM_KEY_MISSING_NOTICE = '这是新好友的来信，请先与对方交换好友码。';
/** 密钥在但认证失败（或块取不到）时的原位提示。 */
export const DM_DECRYPT_FAILED_NOTICE = '这条私信解不开，可能与对方的好友码不一致。';
/** 客户端明文上限（册子 §3.3）：单条明文 ≤ 4096 字节（UTF-8），入队前校验。 */
export const DM_TEXT_MAX_BYTES = 4096;

const SESSION_KEY_BYTES = 32;
const B64URL_PREFIX = 'base1:';

export interface FriendCode {
  v: number;
  peerId: string;
  keyHex: string;
  ownerId: string;
  ownerName: string;
  ownerPubHex: string;
  createdAt: number;
  sig: string;
}

/** 签名域的 **7 个固定键**（册子 §3.2）：`owner_name` 缺省写空串（避免同一码 canonicalize 出两种字节序）。 */
function friendSignFields(c: FriendCode): Record<string, Json> {
  return {
    v: c.v,
    peer_id: c.peerId,
    key: c.keyHex,
    owner_id: c.ownerId,
    owner_name: c.ownerName,
    owner_pub: c.ownerPubHex,
    created_at: c.createdAt,
  };
}

/** 客户端侧第二参是 **hex 字符数**（与节点侧 `isHexN` 的「字节数」语义不同，见「补充 9」）。 */
function isHexN(s: string, n: number): boolean {
  return new RegExp(`^[0-9a-f]{${n}}$`).test(s);
}

/** 册子 §3.2：形态 → 定向 → 自证，任一步失败统一文案，不泄漏「哪一步失败」。 */
function invalidFriendCode(): DmError {
  return new DmError('friend_code_invalid', FRIEND_CODE_INVALID_MESSAGE);
}

/** 编码为 `base1:` + base64url(canonical(7 键 + sig))，单行可复制粘贴。 */
export function encodeFriendCode(c: FriendCode): string {
  const body: Json = { ...friendSignFields(c), sig: c.sig };
  return `${B64URL_PREFIX}${bytesToBase64Url(utf8(canonicalize(body)))}`;
}

/**
 * 解码 + **离线自验三步**（册子 §3.2）：形态 → 定向（`peer_id === myId`）→ 自证（id 派生 + 验签）。
 * `myId === ''`（本机尚无身份）一律按 `friend_code_invalid` 拒绝。
 */
export function decodeFriendCode(code: string, myId: string): FriendCode {
  const raw = code.trim();
  if (!raw.startsWith(B64URL_PREFIX)) throw invalidFriendCode();
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(decodeUtf8(base64UrlToBytes(raw.slice(B64URL_PREFIX.length)))) as Record<string, unknown>;
  } catch {
    throw invalidFriendCode();
  }
  const c: FriendCode = {
    v: Number(m.v ?? 0),
    peerId: String(m.peer_id ?? ''),
    keyHex: String(m.key ?? ''),
    ownerId: String(m.owner_id ?? ''),
    ownerName: typeof m.owner_name === 'string' ? m.owner_name : '',
    ownerPubHex: String(m.owner_pub ?? ''),
    createdAt: Number(m.created_at ?? 0),
    sig: String(m.sig ?? ''),
  };
  // ① 形态：7 键的类型与长度
  if (c.v !== 1) throw invalidFriendCode();
  if (!isHexN(c.peerId, 32) || !isHexN(c.keyHex, 64)) throw invalidFriendCode();
  if (!isIdentityId(c.ownerId) || !isHexN(c.ownerPubHex, 64)) throw invalidFriendCode();
  if (!Number.isInteger(c.createdAt)) throw invalidFriendCode();
  // ② 定向：本码指定的接收人必须是本机（与组码可任意转发的关键差别）
  if (myId === '' || c.peerId !== myId) throw invalidFriendCode();
  // ③ 自证：公钥派生的 id 必须等于 owner_id，且签名必须由该公钥验证通过
  if (deriveIdentityId(c.ownerPubHex) !== c.ownerId) throw invalidFriendCode();
  if (!verify(c.ownerPubHex, utf8(canonicalize(friendSignFields(c))), c.sig)) throw invalidFriendCode();
  return c;
}

/** 用生成者身份私钥对 7 个字段签名（不含 `sig` 自身）。 */
function signFriendCode(ident: Identity, fields: Omit<FriendCode, 'sig'>): FriendCode {
  const sig = sign(ident.seedHex, utf8(canonicalize(friendSignFields({ ...fields, sig: '' }))));
  return { ...fields, sig };
}

/**
 * 建立一条好友关系（册子 §3.2 单向发起）：生成 32 字节随机会话密钥 → 落 `dm_keys(peer_id)` → 出好友码。
 * **全程离线、零网络**（AC 1）。同一 peer 已有本地密钥时**复用**（重复出码不换钥，与「幂等」同口径）。
 * `ownerName` 即签名域里的 `owner_name`，缺省空串（册子 §3.2）。
 */
export async function createFriend(o: DmOptions, peerId: string, ownerName = ''): Promise<{ peerId: string; code: string }> {
  if (!isIdentityId(peerId)) throw new DmError('client', '对方身份 id 形态不对');
  const ident = await ensureLocalIdentity(o.adapters.storage);
  if (peerId === ident.id) throw new DmError('client', '不能添加自己为好友');
  const existing = await o.repo.getDmKey(peerId);
  let keyBytes: Uint8Array;
  if (existing) {
    keyBytes = await openKeyCipher(o.adapters.storage, existing.keyCipher); // 重复出码：复用已存密钥，保证码与本地一致
  } else {
    keyBytes = randomBytes(SESSION_KEY_BYTES);
    await o.repo.putDmKey({
      peerId,
      keyCipher: await sealKeyCipher(o.adapters.storage, keyBytes),
      createdAt: new Date().toISOString(),
    });
  }
  const code = encodeFriendCode(
    signFriendCode(ident, {
      v: 1,
      peerId,
      keyHex: bytesToHex(keyBytes),
      ownerId: ident.id,
      ownerName,
      ownerPubHex: ident.pubHex,
      createdAt: Date.now(),
    }),
  );
  return { peerId, code };
}

/**
 * 粘入好友码（册子 §3.2）。解码自验后落 `dm_keys(peer_id = 生成者)`。
 * 幂等：码里 `key` 与本地相同 ⇒ 通过且不覆盖；不同 ⇒ 拒 `key_conflict`。**全程离线、零网络**（AC 1）。
 */
export async function acceptFriendCode(o: DmOptions, code: string): Promise<{ peerId: string; idempotent: boolean }> {
  const myId = (await ensureLocalIdentity(o.adapters.storage)).id;
  const c = decodeFriendCode(code, myId);
  const existing = await o.repo.getDmKey(c.ownerId);
  if (existing) {
    const cur = await openKeyCipher(o.adapters.storage, existing.keyCipher);
    if (bytesToHex(cur) === c.keyHex) return { peerId: c.ownerId, idempotent: true };
    throw new DmError('key_conflict', '已有该好友的会话，本版本不支持更换密钥');
  }
  await o.repo.putDmKey({
    peerId: c.ownerId,
    keyCipher: await sealKeyCipher(o.adapters.storage, hexToBytes(c.keyHex)),
    createdAt: new Date().toISOString(),
  });
  return { peerId: c.ownerId, idempotent: false };
}

export interface FriendEntry {
  peerId: string;
  /** 本地是否有会话密钥（false = 只在收件箱见过来信，还没交换好友码）。 */
  hasKey: boolean;
}

export interface DmIndexItem {
  eventId: string;
  actor: string;
  createdAt: number;
  payloadCid: string;
}

interface DmIndexPage {
  events: DmIndexItem[];
  nextCursor: string | null;
}

/** 匿名读一人的收件箱索引（册子 §4.2）：`GET /v1/dm/{peer_id}`。**无 404 分支**（查无数据即空数组）。 */
export async function fetchDmIndex(o: DmOptions, peerId: string, cursor?: string | null): Promise<DmIndexPage> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  let res;
  try {
    res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/dm/${peerId}${qs}`);
  } catch {
    throw new DmError('network', '无法连接节点，请稍后重试');
  }
  if (res.status !== 200) throw new DmError('server', `读取私信失败（HTTP ${res.status}）`);
  const page = JSON.parse(decodeUtf8(res.body)) as {
    events?: Array<Record<string, unknown>>;
    next_cursor?: string | null;
  };
  return {
    events: (page.events ?? []).map((e) => ({
      eventId: String(e.event_id ?? ''),
      actor: String(e.actor ?? ''),
      createdAt: Number(e.created_at ?? 0),
      payloadCid: String(e.payload_cid ?? ''),
    })),
    nextCursor: page.next_cursor ?? null,
  };
}

/** 取密文块（`GET /v1/blob/{payload_cid}`）；失败返回 null，由调用方降级为提示（密文原文永不进界面）。 */
async function fetchDmCipher(o: DmOptions, payloadCid: string): Promise<string | null> {
  try {
    const res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/blob/${payloadCid}`);
    if (res.status !== 200) return null;
    return decodeUtf8(res.body);
  } catch {
    return null;
  }
}

/**
 * 好友列表（册子 §5.2）：本地 `dm_keys`（`hasKey: true`）与收件箱发件人（`hasKey: false`）取并集。
 * **拉收件箱失败静默回落为「仅本地好友」**（「补充 6」）：一次读失败不该让整页变空。
 * 顺序：本地好友在前（按 `created_at ASC`），收件箱新增的按首次出现顺序。
 */
export async function listFriends(o: DmOptions): Promise<FriendEntry[]> {
  const rows = await o.repo.listDmKeys();
  const out: FriendEntry[] = rows.map((r) => ({ peerId: r.peerId, hasKey: true }));
  const seen = new Set(out.map((e) => e.peerId));
  const myId = (await peekLocalIdentity(o.adapters.storage))?.id ?? '';
  if (myId === '' || o.nodeBaseUrl === '') return out;
  let page: DmIndexPage;
  try {
    page = await fetchDmIndex(o, myId);
  } catch {
    return out; // 收件箱读不到（断网 / 节点不可达）→ 只列本地好友
  }
  for (const ev of page.events) {
    if (ev.actor === myId || seen.has(ev.actor)) continue;
    seen.add(ev.actor);
    out.push({ peerId: ev.actor, hasKey: false });
  }
  return out;
}

/**
 * 发一条私信（册子 §3.3）。三条前置校验都在**入队前**（不产生事件、不入队，「补充 7」）：
 * `peerId` 非 32 hex → `client`；明文为空 → `client`；超 4096 字节（UTF-8）→ `too_long`；无本地密钥 → `not_friend`。
 * 正向走不通时**只有网络不可达**才入 `comment_out`（`wire` 存已签名请求体，补发零改动复用）。
 */
export async function postDM(o: DmOptions, peerId: string, text: string): Promise<{ eventId: string; queued: boolean }> {
  if (!isIdentityId(peerId)) throw new DmError('client', '对方身份 id 形态不对');
  if (text.length === 0) throw new DmError('client', '私信内容不能为空');
  if (utf8(text).length > DM_TEXT_MAX_BYTES) throw new DmError('too_long', `单条私信不超过 ${DM_TEXT_MAX_BYTES} 字节`);
  const row = await o.repo.getDmKey(peerId);
  if (!row) throw new DmError('not_friend', '还没有与该好友建立会话，请先交换好友码');
  const key = await openKeyCipher(o.adapters.storage, row.keyCipher);
  const textCipher = sealText(key, text);
  const ident = await ensureLocalIdentity(o.adapters.storage);
  const { eventId, wire } = buildEventWire(ident, 'dm.v1', { to: peerId, text_cipher: textCipher });
  const { queued } = await submitWire(o, {
    eventId,
    wire,
    targetId: `dm/${peerId}`,
    queueText: textCipher,
  });
  return { eventId, queued };
}

export interface DmMessage {
  eventId: string;
  actor: string;
  createdAt: number;
  /** 是否我发出的（`actor === 本机 id`），供会话页左右分栏。 */
  mine: boolean;
  /** 解密成功为明文；密钥缺失或解不开为 null（**不是**空串，UI 据此显示提示而非空白）。 */
  text: string | null;
}

export interface DmConversation {
  peerId: string;
  messages: DmMessage[];
  nextCursor: string | null;
  /** 非空即为册子 §5.3 的**显式提示原文**，UI 必须原位显示（禁止静默跳过）。 */
  notice: string;
}

/**
 * 会话页数据（册子 §5.3）：合并**两个 `target_id`**——发件箱 `dm/<peer>`（只留 `actor === 我`）与
 * 收件箱 `dm/<我>`（只留 `actor === peer`），按时间升序，逐条用该 peer 的会话密钥解密。
 * **过滤是硬要求**：`dm/<peer>` 里混有第三方发给 peer 的条目，不过滤就会进入本会话（AC 5）。
 * 无密钥 → `DM_KEY_MISSING_NOTICE`；有密钥但认证失败 / 块取不到 → `DM_DECRYPT_FAILED_NOTICE`。
 */
export async function fetchConversation(o: DmOptions, peerId: string): Promise<DmConversation> {
  if (!isIdentityId(peerId)) throw new DmError('client', '对方身份 id 形态不对');
  const myId = (await ensureLocalIdentity(o.adapters.storage)).id;

  const [inbox, outbox] = await Promise.all([fetchDmIndex(o, myId), fetchDmIndex(o, peerId)]);
  const picked: DmIndexItem[] = [
    ...inbox.events.filter((e) => e.actor === peerId),
    ...outbox.events.filter((e) => e.actor === myId),
  ];
  picked.sort((a, b) => (a.createdAt === b.createdAt ? (a.eventId < b.eventId ? -1 : 1) : a.createdAt - b.createdAt));

  const row = await o.repo.getDmKey(peerId);
  let key: Uint8Array | null = null;
  if (row) {
    try {
      key = await openKeyCipher(o.adapters.storage, row.keyCipher);
    } catch {
      key = null; // 本地密钥损坏 → 与「无密钥」同处置
    }
  }

  let missingKey = false;
  let decryptFailed = false;
  const messages: DmMessage[] = [];
  for (const ev of picked) {
    let text: string | null = null;
    const cipher = ev.payloadCid ? await fetchDmCipher(o, ev.payloadCid) : null;
    if (cipher === null) {
      decryptFailed = true; // 块取不到（断网 / 块缺失）：解不开
    } else if (!key) {
      missingKey = true; // 本地没有该 peer 密钥
    } else {
      try {
        text = openText(key, cipher);
      } catch {
        decryptFailed = true; // 有密钥但认证失败（密文损坏 / 密钥不符）
      }
    }
    messages.push({ eventId: ev.eventId, actor: ev.actor, createdAt: ev.createdAt, mine: ev.actor === myId, text });
  }

  const notice = missingKey ? DM_KEY_MISSING_NOTICE : decryptFailed ? DM_DECRYPT_FAILED_NOTICE : '';
  // 翻页口径：本版不做翻页，任一方向还有更早的消息就原位提示（「补充 8」）
  const nextCursor = inbox.nextCursor ?? outbox.nextCursor ?? null;
  return { peerId, messages, nextCursor, notice };
}
