/**
 * 账号托管（escrow）HTTP 层：把 core/identity 的纯密码学操作和节点 API 串起来。
 *
 * 三条路径：
 *   setupEscrow     — 把当前本地身份的私钥用密码加密，PUT 到节点（需签名）
 *   fetchEscrow     — 匿名取回某用户名的托管密文（用于恢复）
 *   restoreEscrow   — fetchEscrow + openEscrowPayload + saveLocalIdentity + 注册公钥
 *
 * 本模块不 import 'uni'，Node 下用 fakes.ts 的假适配器可完整测试。
 */
import { utf8 } from '@base/protocol-ts';

import type { Adapters } from './platform/adapter';
import type { LocalRepo } from './repo';
import type { KdfParams } from '@base/protocol-ts';
import {
  buildEscrowPayload,
  createIdentity,
  deviceKek,
  identityFromSeed,
  importIdentityBackup,
  loadLocalIdentity,
  openEscrowPayload,
  saveLocalIdentity,
  signRequestHeaders,
  type EscrowPayload,
  type Identity,
} from './identity';
import { decodeUtf8 } from './sync';
import { IDENTITY_REGISTERED_KEY } from './comment';

/** 账号托管/恢复的失败分类（册子 §4.2）。 */
export class EscrowError extends Error {
  constructor(readonly code: EscrowErrorCode, message: string) {
    super(message);
    this.name = 'EscrowError';
  }
}

export type EscrowErrorCode =
  | 'network'
  | 'conflict'      // 该用户名已绑定到别的 id
  | 'rate_limited'  // 节点 60s 内限速
  | 'not_found'     // 用户名尚未托管
  | 'password'      // 密码错误或密文损坏
  | 'server'        // 非预期的 HTTP 5xx
  | 'client';       // 本地步骤（随机数 / KDF / 签名）抛错

export interface EscrowOptions {
  adapters: Adapters;
  repo: LocalRepo;
  nodeBaseUrl: string;
}

/**
 * 绑定/更新托管：用当前本地身份 + 给定密码构造密文，带签名头 PUT 到节点。
 * 若用户名已被别的身份占用，返回 conflict 让 UI 提示换名字。
 */
export async function setupEscrow(
  o: EscrowOptions,
  username: string,
  password: string,
): Promise<void> {
  if (!username || !/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    throw new EscrowError('client', '用户名必须是 3-32 位字母、数字或下划线');
  }
  if (!password || password.length < 4) {
    throw new EscrowError('client', '密码至少 4 位');
  }
  const ident = await currentLocalIdentity(o);
  const payload = tryLocal('构造托管请求', () => buildEscrowPayload(ident, password));
  const bodyBytes = utf8(JSON.stringify(payload));
  const path = `/v1/identity/escrow/${username}`;
  const headers = tryLocal('签名请求', () => signRequestHeaders(ident, { method: 'PUT', path, body: bodyBytes }));

  let res;
  try {
    res = await o.adapters.http.put(`${o.nodeBaseUrl}${path}`, bodyBytes, {
      'Content-Type': 'application/json',
      ...headers,
    });
  } catch {
    throw new EscrowError('network', '无法连接节点，请检查网络');
  }
  if (res.status === 200) return;
  const body = safeDecode(res.body);
  const code = extractCode(body);
  if (res.status === 409 && code === 'escrow_conflict') {
    throw new EscrowError('conflict', '该用户名已被别人使用，请换一个');
  }
  if (res.status === 429) {
    throw new EscrowError('rate_limited', '操作过于频繁，请稍后再试');
  }
  if (res.status >= 500) {
    throw new EscrowError('server', `节点异常（HTTP ${res.status}）`);
  }
  throw new EscrowError('client', `绑定失败（HTTP ${res.status} ${code}）`);
}

/** 匿名取回托管密文；失败抛 EscrowError（册子 §5.4 的 60s IP 限速）。 */
export async function fetchEscrow(o: EscrowOptions, username: string): Promise<EscrowPayload> {
  if (!username) throw new EscrowError('client', '用户名不能为空');
  let res;
  try {
    res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/identity/escrow/${username}`);
  } catch {
    throw new EscrowError('network', '无法连接节点，请检查网络');
  }
  if (res.status === 404) throw new EscrowError('not_found', '该用户名未在本节点托管过');
  if (res.status === 429) throw new EscrowError('rate_limited', '请求过于频繁，请 60 秒后再试');
  if (res.status !== 200) {
    const body = safeDecode(res.body);
    throw new EscrowError('server', `节点返回异常（HTTP ${res.status} ${extractCode(body)}）`);
  }
  const raw = safeDecode(res.body);
  const j = JSON.parse(raw) as Record<string, unknown>;
  return {
    id: String(j.id ?? ''),
    alg: String(j.alg ?? ''),
    salt: String(j.salt ?? ''),
    kdf: parseKdf(j.kdf),
    encNonce: String(j.enc_nonce ?? ''),
    privCipher: String(j.priv_cipher ?? ''),
  };
}

/**
 * 恢复整条链路：取密文 → 用密码解私钥 → 落本地 → 登记公钥。
 * 新手机第一次跑：本地没有 identity → 会被完全覆盖成恢复出来的那个。
 * 调用方**必须确认**用户知道会覆盖本地身份（UI 层负责弹窗确认）。
 */
export async function restoreEscrow(
  o: EscrowOptions,
  username: string,
  password: string,
): Promise<Identity> {
  const payload = await fetchEscrow(o, username);
  let ident: Identity;
  try {
    ident = openEscrowPayload(payload, password);
  } catch {
    throw new EscrowError('password', '密码错误，或托管密文已损坏');
  }
  const kek = await deviceKek(o.adapters.storage);
  await saveLocalIdentity(o.adapters.storage, ident, kek, 'device', username);
  // 覆盖：用户显式选了恢复，此前的本地身份（如果有）应让渡
  await o.repo.setConfig(IDENTITY_REGISTERED_KEY, '');

  // 登记公钥（匿名 POST）
  const body = utf8(JSON.stringify({ id: ident.id, alg: ident.alg, pubkey: ident.pubHex }));
  let res;
  try {
    res = await o.adapters.http.post(`${o.nodeBaseUrl}/v1/identity/register`, body, {
      'Content-Type': 'application/json',
    });
  } catch {
    // 身份已还原到本地，哪怕登记一时失败也不算致命——下次联网会自动补登记
    return ident;
  }
  if (res.status === 200) {
    await o.repo.setConfig(IDENTITY_REGISTERED_KEY, '1');
  }
  return ident;
}

/**
 * 直接粘贴 64 位 hex 备份串恢复（册子 §2.2「主动备份」路径）。
 * 不依赖节点：私钥在手就够。登记公钥走 best-effort。
 */
export async function restoreFromBackup(
  o: EscrowOptions,
  backup: string,
): Promise<Identity> {
  let ident: Identity;
  try {
    ident = importIdentityBackup(backup);
  } catch (e) {
    throw new EscrowError('client', (e as Error).message);
  }
  const kek = await deviceKek(o.adapters.storage);
  await saveLocalIdentity(o.adapters.storage, ident, kek, 'device');
  await o.repo.setConfig(IDENTITY_REGISTERED_KEY, '');

  const body = utf8(JSON.stringify({ id: ident.id, alg: ident.alg, pubkey: ident.pubHex }));
  try {
    const res = await o.adapters.http.post(`${o.nodeBaseUrl}/v1/identity/register`, body, {
      'Content-Type': 'application/json',
    });
    if (res.status === 200) await o.repo.setConfig(IDENTITY_REGISTERED_KEY, '1');
  } catch {
    // 同上：登记失败不阻断本地恢复
  }
  return ident;
}

// ---------------- 内部工具 ----------------

/** 取当前本地身份；没有就现建（和 comment.ts 的 localIdentity 同口径）。 */
async function currentLocalIdentity(o: EscrowOptions): Promise<Identity> {
  const kek = await deviceKek(o.adapters.storage);
  const existing = await loadLocalIdentity(o.adapters.storage, kek);
  if (existing) return existing;
  const ident = createIdentity();
  await saveLocalIdentity(o.adapters.storage, ident, kek, 'device');
  return ident;
}

function tryLocal<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new EscrowError('client', `${what}失败：${(e as Error).message ?? String(e)}`);
  }
}

function safeDecode(body: Uint8Array): string {
  try {
    return decodeUtf8(body);
  } catch {
    return '';
  }
}

function extractCode(body: string): string {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    return String(j.code ?? '');
  } catch {
    return '';
  }
}

function parseKdf(v: unknown): KdfParams {
  const j = v as Record<string, unknown>;
  return {
    alg: 'argon2id',
    m: Number(j.m ?? 0),
    t: Number(j.t ?? 0),
    p: Number(j.p ?? 0),
    len: Number(j.len ?? 32),
  };
}

// 把 identityFromSeed 挂上以便 restoreEscrow 后外部可以确认
export { identityFromSeed, importIdentityBackup };
