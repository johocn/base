// 源端 mesh 签名私钥存储（spec §3.3）：catalog 签名复用节点 BASE_SIGN_KEY，
// KEK 加密落盘模式与 core/identity.ts 一致；执行期定案：node_id = deriveIdentityId(sign_pubkey)。
// 手机端录入：64 位 hex 私钥直接使用；否则按「口令 + 设备号」经 Argon2id 派生 32 字节种子。
import {
  bytesToHex,
  deriveIdentityId,
  deriveKek,
  hexToBytes,
  keyPairFromSeed,
  openWithNonce,
  randomBytes,
  sealWithNonce,
  sha256Hex,
  utf8,
  type KdfParams,
} from '@base/protocol-ts';
import { deviceKek } from '@base/core-ts/identity';
import type { StorageAdapter } from '@base/core-ts';

export const MESH_SIGN_KEY_STORAGE = 'mesh.sign_key';
export const MESH_NODE_ID_STORAGE = 'mesh.node_id';
/** 密钥来源：'raw' = 直接粘贴的 hex 私钥；'pass' = 口令派生。 */
export const MESH_SIGN_MODE_STORAGE = 'mesh.sign_key_mode';
/** plus.device.uuid 不可用时的持久化兜底设备号。 */
export const MESH_DEVICE_ID_STORAGE = 'mesh.device_id';

export const MIN_PASSPHRASE_LENGTH = 8;

/** 口令派生固定参数：手机一次性派生，16 MiB 把耗时压在 ~2s。改参数等于换钥，不可随意调整。 */
export const MESH_SEED_KDF: KdfParams = { alg: 'argon2id', m: 16384, t: 3, p: 1, len: 32 };

const SEED_SALT_PREFIX = 'base-mesh-sign-v1|';

export interface MeshSignKey {
  /** 64 位 hex 种子（节点 BASE_SIGN_KEY，或口令派生结果）。 */
  seedHex: string;
  /** 签名公钥（64 位 hex）。 */
  pubHex: string;
  /** node_id = deriveIdentityId(sign_pubkey)，执行期定案。 */
  nodeId: string;
  /** true = 由口令 + 设备号派生；false = 直接录入的节点私钥。 */
  derived: boolean;
}

/** 口令 + 设备号 → 32 字节种子 hex（纯函数，同设备同口令可复现）。 */
export function deriveMeshSeedHex(passphrase: string, deviceId: string): string {
  return bytesToHex(deriveKek(passphrase, utf8(`${SEED_SALT_PREFIX}${deviceId}`), MESH_SEED_KDF));
}

/** 设备号：优先 plus.device.uuid（真机），H5/测试环境退回持久化随机值。 */
export async function meshDeviceId(storage: StorageAdapter): Promise<string> {
  const plus = (globalThis as { plus?: { device?: { uuid?: string } } }).plus;
  const uuid = plus?.device?.uuid;
  if (typeof uuid === 'string' && uuid.trim() !== '') return uuid.trim();
  const saved = await storage.get(MESH_DEVICE_ID_STORAGE);
  if (saved) return saved;
  const id = bytesToHex(randomBytes(16));
  await storage.set(MESH_DEVICE_ID_STORAGE, id);
  return id;
}

/**
 * 派生身份没有线上 TLS 证书：enroll 的 tls_fingerprint 按公钥确定性生成 64 位 hex 占位。
 * 接收端只落库不校验（mesh 走明文，真锚是 sign_pubkey TOFU），因此不构成额外信任假设。
 */
export function derivedTlsFingerprint(pubHex: string): string {
  return sha256Hex(utf8(`base-mesh-enroll-v1|${pubHex}`));
}

/** 录入并加密保存签名私钥（KEK = deviceKek(storage)，nonce:ct 十六进制拼接）。 */
export async function saveMeshSignKey(storage: StorageAdapter, input: string): Promise<MeshSignKey> {
  const raw = input.trim();
  let seed: string;
  let derived: boolean;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    seed = raw.toLowerCase();
    derived = false;
  } else {
    if (Array.from(raw).length < MIN_PASSPHRASE_LENGTH) {
      throw new Error(`mesh: 口令至少 ${MIN_PASSPHRASE_LENGTH} 位（或粘贴 64 位 hex 节点私钥）`);
    }
    seed = deriveMeshSeedHex(raw, await meshDeviceId(storage));
    derived = true;
  }
  const kek = await deviceKek(storage);
  const nonce = randomBytes(12);
  const ct = sealWithNonce(kek, nonce, hexToBytes(seed));
  const pubHex = keyPairFromSeed(seed).pubHex;
  const nodeId = deriveIdentityId(pubHex);
  await storage.set(MESH_SIGN_KEY_STORAGE, `${bytesToHex(nonce)}:${bytesToHex(ct)}`);
  await storage.set(MESH_NODE_ID_STORAGE, nodeId);
  await storage.set(MESH_SIGN_MODE_STORAGE, derived ? 'pass' : 'raw');
  return { seedHex: seed, pubHex, nodeId, derived };
}

/** 读取签名私钥；未录入返回 null，密文损坏/KEK 变更抛错（不静默换钥）。 */
export async function loadMeshSignKey(storage: StorageAdapter): Promise<MeshSignKey | null> {
  const cipher = await storage.get(MESH_SIGN_KEY_STORAGE);
  if (!cipher) return null;
  const sep = cipher.indexOf(':');
  if (sep <= 0) throw new Error('mesh: 签名私钥密文格式损坏');
  const kek = await deviceKek(storage);
  const seedBytes = openWithNonce(kek, hexToBytes(cipher.slice(0, sep)), hexToBytes(cipher.slice(sep + 1)));
  const seedHex = bytesToHex(seedBytes);
  const pubHex = keyPairFromSeed(seedHex).pubHex;
  const derived = (await storage.get(MESH_SIGN_MODE_STORAGE)) === 'pass';
  return { seedHex, pubHex, nodeId: deriveIdentityId(pubHex), derived };
}
