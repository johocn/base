// 最小 DER 编码器：只覆盖自签 X.509 证书所需的结构（Node 20 无内置证书生成，不引第三方依赖）。
// 公钥（SPKI）与私钥（SEC1）的 DER 直接取 node:crypto 的导出，本文件不重复实现。

function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** 通用 TLV：tag 为完整首字节（含 class / constructed 位）。 */
export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

export function seq(...items: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(items));
}

export function set(...items: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(items));
}

/** INTEGER：非负整数，去前导零，最高位为 1 时补 0x00（DER 最简编码）。 */
export function int(bytes: Buffer): Buffer {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const body = bytes.subarray(i);
  if ((body[0] & 0x80) !== 0) return tlv(0x02, Buffer.concat([Buffer.from([0]), body]));
  return tlv(0x02, body);
}

export function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map((p) => Number.parseInt(p, 10));
  // 首字节 = 40 * arc1 + arc2；本文件用到的 OID 其值均 < 128，无需多字节拆分。
  const out: number[] = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [];
    let v = part;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

export function bool(value: boolean): Buffer {
  return tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
}

export function octet(bytes: Buffer): Buffer {
  return tlv(0x04, bytes);
}

/** BIT STRING：unusedBits 为末尾未用位数。 */
export function bitString(unusedBits: number, bytes: Buffer): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]));
}

export function utf8(value: string): Buffer {
  return tlv(0x0c, Buffer.from(value, "utf8"));
}

export function ia5(value: string): Buffer {
  return tlv(0x16, Buffer.from(value, "ascii"));
}

/** 上下文相关显式标签 [tagNo]。 */
export function explicit(tagNo: number, inner: Buffer): Buffer {
  return tlv(0xa0 | tagNo, inner);
}

/** Time：1950–2049 用 UTCTime，其余用 GeneralizedTime（RFC 5280）。 */
export function time(d: Date): Buffer {
  const iso = d.toISOString();
  const year = d.getUTCFullYear();
  if (year >= 1950 && year < 2050) {
    return tlv(0x17, Buffer.from(`${iso.slice(2, 19).replace(/[-:T]/g, "")}Z`, "ascii"));
  }
  return tlv(0x18, Buffer.from(`${iso.slice(0, 19).replace(/[-:T]/g, "")}Z`, "ascii"));
}

/** 输出 PEM（64 字符一行，与 Go `pem.EncodeToMemory` 同形）。 */
export function pem(label: string, der: Buffer): string {
  const b64 = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
