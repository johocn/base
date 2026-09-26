import { argon2id } from "@noble/hashes/argon2";

import { utf8 } from "./hash";

/**
 * 密码托管用的 KDF 参数（册子 §4.1 / §5.3）。
 *
 * **参数由客户端决定并随密文一起上传，节点原样存原样返**（§4.1「参数的归属」）。
 * 换设备必须拿回同一组参数才能派生同一 kek，因此字段名与取值即线上契约，
 * 与服务端 `escrow.kdf_json` 逐字段对应，不可改。
 */
export interface KdfParams {
  alg: "argon2id";
  /** 内存成本，单位 KiB */
  m: number;
  /** 迭代次数 */
  t: number;
  /** 并行度 */
  p: number;
  /** 派生长度，字节 */
  len: number;
}

/** 册子 §4.1 规定的唯一默认值：m=65536 KiB, t=3, p=1, len=32。 */
export const DEFAULT_KDF: KdfParams = { alg: "argon2id", m: 65536, t: 3, p: 1, len: 32 };

/** 从口令与盐派生 KEK。`salt` 长度由调用方决定（册子 §4.1 用随机 16 字节）。 */
export function deriveKek(password: string, salt: Uint8Array, kdf: KdfParams = DEFAULT_KDF): Uint8Array {
  if (kdf.alg !== "argon2id") {
    throw new Error(`kdf: 不支持的算法 ${kdf.alg}`);
  }
  if (salt.length === 0) {
    throw new Error("kdf: 盐不能为空");
  }
  return argon2id(utf8(password), salt, { t: kdf.t, m: kdf.m, p: kdf.p, dkLen: kdf.len });
}

/** 校验从节点取回的 kdf_json 形状；坏值必须显式报错，不能静默退回默认参数。 */
export function parseKdfParams(raw: unknown): KdfParams {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("kdf: 参数必须是对象");
  }
  const o = raw as Record<string, unknown>;
  if (o.alg !== "argon2id") {
    throw new Error(`kdf: 不支持的算法 ${String(o.alg)}`);
  }
  const nums: Array<"m" | "t" | "p" | "len"> = ["m", "t", "p", "len"];
  for (const k of nums) {
    const v = o[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new Error(`kdf: 字段 ${k} 必须是正整数，实得 ${String(v)}`);
    }
  }
  return { alg: "argon2id", m: o.m as number, t: o.t as number, p: o.p as number, len: o.len as number };
}