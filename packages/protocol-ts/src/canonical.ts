export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** 规范化 JSON v1（契约第 6 条），必须与 Go 侧 protocol.Canonicalize 字节一致。 */
export function canonicalize(value: Json): string {
  const out: string[] = [];
  writeCanon(value, out);
  return out.join("");
}

function writeCanon(v: Json, out: string[]): void {
  if (v === null) {
    out.push("null");
    return;
  }
  switch (typeof v) {
    case "boolean":
      out.push(v ? "true" : "false");
      return;
    case "string":
      writeCanonString(v, out);
      return;
    case "number": {
      if (!Number.isFinite(v) || !Number.isInteger(v)) {
        throw new Error(`canonical json: only integers allowed, got ${String(v)}`);
      }
      // 与 Go 一致：Go 的 json.Marshal(1e21) 产出 "1e+21" 会被拒，这里同样拒字符串化的指数形态
      const s = Object.is(v, -0) ? "0" : String(v);
      if (/[.eE]/.test(s)) {
        throw new Error(`canonical json: only integers allowed, got ${s}`);
      }
      out.push(s);
      return;
    }
    case "object": {
      if (Array.isArray(v)) {
        out.push("[");
        for (let i = 0; i < v.length; i++) {
          if (i > 0) out.push(",");
          writeCanon(v[i], out);
        }
        out.push("]");
        return;
      }
      const obj = v as { [k: string]: Json };
      const keys = Object.keys(obj);
      for (const k of keys) {
        if (!isASCII(k)) {
          throw new Error(`canonical json: non-ascii object key ${JSON.stringify(k)}`);
        }
      }
      keys.sort(); // 键全为 ASCII，码元序即 UTF-8 字节序
      out.push("{");
      for (let i = 0; i < keys.length; i++) {
        if (i > 0) out.push(",");
        writeCanonString(keys[i], out);
        out.push(":");
        writeCanon(obj[keys[i]], out);
      }
      out.push("}");
      return;
    }
    default:
      throw new Error(`canonical json: unsupported type ${typeof v}`);
  }
}

export function isASCII(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function writeCanonString(s: string, out: string[]): void {
  out.push('"');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22:
        out.push('\\"');
        break;
      case 0x5c:
        out.push("\\\\");
        break;
      case 0x08:
        out.push("\\b");
        break;
      case 0x0c:
        out.push("\\f");
        break;
      case 0x0a:
        out.push("\\n");
        break;
      case 0x0d:
        out.push("\\r");
        break;
      case 0x09:
        out.push("\\t");
        break;
      default:
        if (c >= 0xd800 && c <= 0xdbff) {
          const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
          if (d >= 0xdc00 && d <= 0xdfff) {
            out.push(s[i], s[i + 1]);
            i++;
            break;
          }
          out.push("\uFFFD"); // 与 Go 的 range over string 语义一致（孤立代理 → U+FFFD）
          break;
        }
        if (c >= 0xdc00 && c <= 0xdfff) {
          out.push("\uFFFD");
          break;
        }
        if (c < 0x20) {
          out.push("\\u" + c.toString(16).padStart(4, "0"));
          break;
        }
        out.push(s[i]);
    }
  }
  out.push('"');
}