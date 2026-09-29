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
import { ensureLocalIdentity, type Identity } from './identity';
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
