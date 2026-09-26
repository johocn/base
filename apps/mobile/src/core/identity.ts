/**
 * 客户端身份：密钥生成、id 派生、本机密文存储、密码托管封装、签名头构造。
 *
 * 只依赖注入的 `StorageAdapter`，不 import 'uni' / 'plus'，因此可在 Node 下用
 * `core/fakes.ts` 的假适配器完整测试（与 core/sync.ts 同一约定）。
 */
import {
  ALG_ED25519,
  bytesToHex,
  DEFAULT_KDF,
  deriveIdentityId,
  deriveKek,
  hexToBytes,
  keyPairFromSeed,
  openWithNonce,
  randomBytes,
  sealWithNonce,
  sign,
  requestSignBytes,
  sha256Hex,
  type KdfParams,
  type RequestMeta,
} from '@base/protocol-ts';

import type { StorageAdapter } from '../platform/adapter';

/** KEK 来源（册子 §8 的 `kek_source`）。spike(#4) 结论回填后此枚举才可能收缩。 */
export type KekSource = 'device' | 'password' | 'device+password';

export const LOCAL_IDENTITY_KEY = 'identity.meta';
export const LOCAL_PRIV_CIPHER_KEY = 'identity.privkey_cipher';
export const LOCAL_DEVICE_KEK_KEY = 'identity.device_kek';

/** 本机身份记录（册子 §8 的 `identity` 表；这里是 StorageAdapter 上的等价表示）。 */
export interface LocalIdentityRecord {
  id: string;
  alg: string;
  pubHex: string;
  kekSource: KekSource;
  escrowUsername?: string;
  createdAt: number;
}

export interface Identity {
  id: string;
  alg: string;
  pubHex: string;
  seedHex: string;
}

/** 按册子 §2.1 从种子派生完整身份。id 自证，节点不参与。 */
export function identityFromSeed(seedHex: string): Identity {
  const { pubHex } = keyPairFromSeed(seedHex);
  return { id: deriveIdentityId(pubHex), alg: ALG_ED25519, pubHex, seedHex };
}

/** 首次需要写入时本地生成身份：无需注册、无需节点审批、无需联网（册子 §2.2）。 */
export function createIdentity(): Identity {
  return identityFromSeed(bytesToHex(randomBytes(32)));
}

/**
 * 设备侧 KEK。
 *
 * **S1 期实现（修正 8）**：随机 32 字节，存应用私有存储。KEK 与密文同库，
 * 不抗有 root/越狱能力的本地读取——这是 spike(#4) 结论回填前的最低可用形态。
 * spike 落地后只替换本函数（改走设备安全存储 / 用户口令派生），调用方契约不变。
 */
export async function deviceKek(storage: StorageAdapter): Promise<Uint8Array> {
  const existing = await storage.get(LOCAL_DEVICE_KEK_KEY);
  if (existing) {
    const kek = hexToBytes(existing);
    if (kek.length !== 32) {
      throw new Error(`identity: 设备 KEK 长度异常（${kek.length} 字节）`);
    }
    return kek;
  }
  const kek = randomBytes(32);
  await storage.set(LOCAL_DEVICE_KEK_KEY, bytesToHex(kek));
  return kek;
}

/**
 * 本机身份落盘。私钥只以 `nonce:ct` 形态写入，**永不落明文**（册子 §8）。
 * 与 §5 的 escrow 是两个独立密文，可各用不同 KEK，互不替代。
 */
export async function saveLocalIdentity(
  storage: StorageAdapter,
  ident: Identity,
  kek: Uint8Array,
  kekSource: KekSource,
  escrowUsername?: string,
): Promise<void> {
  const nonce = randomBytes(12);
  const ct = sealWithNonce(kek, nonce, hexToBytes(ident.seedHex));
  await storage.set(LOCAL_PRIV_CIPHER_KEY, `${bytesToHex(nonce)}:${bytesToHex(ct)}`);
  const rec: LocalIdentityRecord = {
    id: ident.id,
    alg: ident.alg,
    pubHex: ident.pubHex,
    kekSource,
    createdAt: Date.now(),
  };
  if (escrowUsername) {
    rec.escrowUsername = escrowUsername;
  }
  await storage.set(LOCAL_IDENTITY_KEY, JSON.stringify(rec));
}

/** 载入本机身份；无记录返回 null（首次启动的正常路径）。KEK 不匹配即抛错。 */
export async function loadLocalIdentity(storage: StorageAdapter, kek: Uint8Array): Promise<Identity | null> {
  const metaRaw = await storage.get(LOCAL_IDENTITY_KEY);
  const cipherRaw = await storage.get(LOCAL_PRIV_CIPHER_KEY);
  if (!metaRaw || !cipherRaw) {
    return null;
  }
  const [nonceHex, ctHex] = cipherRaw.split(':');
  if (!nonceHex || !ctHex) {
    throw new Error('identity: 本机密文格式损坏');
  }
  const rec = JSON.parse(metaRaw) as LocalIdentityRecord;
  const ident = identityFromSeed(bytesToHex(openWithNonce(kek, hexToBytes(nonceHex), hexToBytes(ctHex))));
  if (ident.id !== rec.id) {
    throw new Error(`identity: 本机记录 id 与私钥不符（${rec.id} != ${ident.id}）`);
  }
  return ident;
}

/** `PUT /v1/identity/escrow/{username}` 的请求体（册子 §5.3）。 */
export interface EscrowPayload {
  id: string;
  alg: string;
  salt: string;
  kdf: KdfParams;
  encNonce: string;
  privCipher: string;
}

/**
 * 构造托管请求体：客户端侧加密，节点只存不解释（册子 §4.1 / §4.2）。
 * `salt` 与全部 KDF 参数随密文一起上传，换设备才能派生同一 KEK。
 */
export function buildEscrowPayload(
  ident: Identity,
  password: string,
  kdf: KdfParams = DEFAULT_KDF,
  salt?: Uint8Array,
): EscrowPayload {
  const s = salt ?? randomBytes(16);
  const kek = deriveKek(password, s, kdf);
  const nonce = randomBytes(12);
  const ct = sealWithNonce(kek, nonce, hexToBytes(ident.seedHex));
  return {
    id: ident.id,
    alg: ident.alg,
    salt: bytesToHex(s),
    kdf,
    encNonce: bytesToHex(nonce),
    privCipher: bytesToHex(ct),
  };
}

/**
 * 换设备取回：用同一口令解出私钥。密码错误与密文损坏在密码学上不可区分，
 * 统一报同一条消息（客户端判定，节点无从判断——册子 §4.2）。
 */
export function openEscrowPayload(p: EscrowPayload, password: string): Identity {
  const kek = deriveKek(password, hexToBytes(p.salt), p.kdf);
  let seedHex: string;
  try {
    seedHex = bytesToHex(openWithNonce(kek, hexToBytes(p.encNonce), hexToBytes(p.privCipher)));
  } catch {
    throw new Error('identity: 密码错误或托管密文损坏');
  }
  const ident = identityFromSeed(seedHex);
  if (ident.id !== p.id) {
    throw new Error(`identity: 解出的私钥与托管 id 不符（${ident.id} != ${p.id}）`);
  }
  return ident;
}

/**
 * 私钥导出（册子 §2.2「主动备份」）：返回可直接编成二维码 / 抄写的备份串。
 *
 * **调用即明文出设备**，只应在用户显式操作时触发；调用方负责不进日志、不被后台截图。
 * 不做助记词：BIP-39 要引入词表依赖，而 S1 的备份目的只是「换设备前把种子带走」，
 * 32 字节种子的 hex 已足够；若后续要做助记词，只改这两个函数。
 */
export function exportIdentityBackup(ident: Identity): string {
  return ident.seedHex;
}

/** 从备份串还原身份；容忍首尾空白与大小写差异（手抄/扫码的必然噪声）。 */
export function importIdentityBackup(backup: string): Identity {
  const seedHex = backup.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(seedHex)) {
    throw new Error('identity: 备份串必须是 64 位 hex 种子');
  }
  return identityFromSeed(seedHex);
}

/** 5 个签名头（册子 §3.1）。键名即线上契约。 */
export interface SignedHeaders {
  'X-Base-Id': string;
  'X-Base-Alg': string;
  'X-Base-Ts': string;
  'X-Base-Nonce': string;
  'X-Base-Sig': string;
}

/**
 * 为一次请求构造签名头。`ts` 可注入以便测试；生产不传即用当前毫秒。
 * `body` 传原始字节（不传 = 无请求体，用 `sha256("")`）。
 */
export function signRequestHeaders(
  ident: Identity,
  req: { method: string; path: string; query?: string; body?: Uint8Array },
  ts: number = Date.now(),
): SignedHeaders {
  const meta: RequestMeta = {
    method: req.method.toUpperCase(),
    path: req.path,
    query: req.query ?? '',
    bodySha256: sha256Hex(req.body ?? new Uint8Array(0)),
    ts,
    nonce: bytesToHex(randomBytes(16)),
  };
  return {
    'X-Base-Id': ident.id,
    'X-Base-Alg': ident.alg,
    'X-Base-Ts': String(meta.ts),
    'X-Base-Nonce': meta.nonce,
    'X-Base-Sig': sign(ident.seedHex, requestSignBytes(meta)),
  };
}