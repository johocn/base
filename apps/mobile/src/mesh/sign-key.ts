// 源端 mesh 签名私钥存储（spec §3.3）：catalog 签名复用节点 BASE_SIGN_KEY，
// KEK 加密落盘模式与 core/identity.ts 一致；执行期定案：node_id = deriveIdentityId(sign_pubkey)。
import {
  bytesToHex,
  deriveIdentityId,
  hexToBytes,
  keyPairFromSeed,
  openWithNonce,
  randomBytes,
  sealWithNonce,
} from '@base/protocol-ts';
import { deviceKek } from '@base/core-ts/identity';
import type { StorageAdapter } from '@base/core-ts';

export const MESH_SIGN_KEY_STORAGE = 'mesh.sign_key';
export const MESH_NODE_ID_STORAGE = 'mesh.node_id';

export interface MeshSignKey {
  /** 64 位 hex 种子（节点 BASE_SIGN_KEY）。 */
  seedHex: string;
  /** 签名公钥（64 位 hex）。 */
  pubHex: string;
  /** node_id = deriveIdentityId(sign_pubkey)，执行期定案。 */
  nodeId: string;
}

/** 录入并加密保存签名私钥（KEK = deviceKek(storage)，nonce:ct 十六进制拼接）。 */
export async function saveMeshSignKey(storage: StorageAdapter, seedHex: string): Promise<MeshSignKey> {
  const seed = seedHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(seed)) {
    throw new Error('mesh: 签名私钥必须为 64 位 hex 种子（BASE_SIGN_KEY）');
  }
  const kek = await deviceKek(storage);
  const nonce = randomBytes(12);
  const ct = sealWithNonce(kek, nonce, hexToBytes(seed));
  const pubHex = keyPairFromSeed(seed).pubHex;
  const nodeId = deriveIdentityId(pubHex);
  await storage.set(MESH_SIGN_KEY_STORAGE, `${bytesToHex(nonce)}:${bytesToHex(ct)}`);
  await storage.set(MESH_NODE_ID_STORAGE, nodeId);
  return { seedHex: seed, pubHex, nodeId };
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
  return { seedHex, pubHex, nodeId: deriveIdentityId(pubHex) };
}
