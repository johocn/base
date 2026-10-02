// 文本列加解密（host 层）：复用 @base/protocol-ts 的 seal/open，**不重写 GCM**。
// 封装格式与 Go `store.Encrypt` 逐字节一致：nonce(12) || ciphertext || tag(16)；
// TEXT 列再套一层 `enc:v1:` + 标准 base64（带 `=` 填充，与 Go 的 base64.StdEncoding 一致）。
import { open, seal } from "@base/protocol-ts";

export const ENC_PREFIX = "enc:v1:";

/** 加密任意字节；返回 nonce(12) || ciphertext || tag(16)。 */
export function encrypt(key: Uint8Array, plain: Uint8Array): Uint8Array {
  return seal(key, plain);
}

/** 解密 nonce(12) || ciphertext || tag(16)；认证失败即抛错。 */
export function decrypt(key: Uint8Array, blob: Uint8Array): Uint8Array {
  return open(key, blob);
}

/** 加密 TEXT 列；空串保持空串（对齐 Go `encText`）。 */
export function encText(key: Uint8Array, plain: string): string {
  if (plain === "") return "";
  const ct = seal(key, new Uint8Array(Buffer.from(plain, "utf8")));
  return ENC_PREFIX + Buffer.from(ct).toString("base64");
}

/** 解密 TEXT 列；无前缀视为历史明文行，原样返回（对齐 Go `decText`）。 */
export function decText(key: Uint8Array, stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const raw = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
  const plain = open(key, new Uint8Array(raw));
  return Buffer.from(plain).toString("utf8");
}
