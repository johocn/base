/**
 * Go `encoding/json.Marshal`（默认 `SetEscapeHTML(true)`）的**等价序列化器**，
 * 只覆盖 importer 需要的形状：null / boolean / 整数 number / string / array / object。
 *
 * 为什么不能用 `JSON.stringify`：Go 会把 `<` `>` `&` 转义为 `\u003c` `\u003e` `\u0026`，
 * 并把 U+2028 / U+2029 转义（**不**转义 `/`）；JS 都不做。这些字节直接进导出包，
 * 任何一处差异都会让 `pack_id` / `merkle_root` 不同。
 *
 * 对象键按**插入顺序**输出（对齐 Go 结构体字段声明序）；数字只支持整数（对齐 Go `int`）。
 */
export type GoJSONValue =
  | null
  | boolean
  | number
  | string
  | GoJSONValue[]
  | { [k: string]: GoJSONValue };

/** 序列化为 Go `json.Marshal` 的精确字节等价串（escapeHTML 默认开启）。 */
export function marshalGoJSON(value: GoJSONValue): string {
  const out: string[] = [];
  writeGoJSON(value, out);
  return out.join("");
}

function writeGoJSON(v: GoJSONValue, out: string[]): void {
  if (v === null) {
    out.push("null");
    return;
  }
  switch (typeof v) {
    case "boolean":
      out.push(v ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(v) || !Number.isInteger(v)) {
        throw new Error(`go json: 仅支持整数（对齐 Go int），got ${String(v)}`);
      }
      out.push(v === 0 ? "0" : String(v)); // Go int 无 -0
      return;
    case "string":
      writeGoString(v, out);
      return;
    case "object": {
      if (Array.isArray(v)) {
        out.push("[");
        for (let i = 0; i < v.length; i++) {
          if (i > 0) out.push(",");
          writeGoJSON(v[i], out);
        }
        out.push("]");
        return;
      }
      const obj = v as { [k: string]: GoJSONValue };
      out.push("{");
      let first = true;
      for (const k of Object.keys(obj)) {
        if (!first) out.push(",");
        first = false;
        writeGoString(k, out);
        out.push(":");
        writeGoJSON(obj[k], out);
      }
      out.push("}");
      return;
    }
    default:
      throw new Error(`go json: 不支持的类型 ${typeof v}`);
  }
}

/** 对齐 Go `encoding/json` 的字符串转义表（escapeHTML 开启）。 */
function writeGoString(s: string, out: string[]): void {
  out.push('"');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      switch (c) {
        case 0x22: // "
          out.push('\\"');
          continue;
        case 0x5c: // \
          out.push("\\\\");
          continue;
        case 0x0a: // \n
          out.push("\\n");
          continue;
        case 0x0d: // \r
          out.push("\\r");
          continue;
        case 0x09: // \t
          out.push("\\t");
          continue;
        case 0x3c: // <
          out.push("\\u003c");
          continue;
        case 0x3e: // >
          out.push("\\u003e");
          continue;
        case 0x26: // &
          out.push("\\u0026");
          continue;
      }
      if (c < 0x20) {
        // 其余控制字符；\b \f **不**特殊化，对齐 Go。
        out.push("\\u" + c.toString(16).padStart(4, "0"));
        continue;
      }
      out.push(s[i]);
      continue;
    }
    // 非 ASCII：合法代理对原样输出，孤立代理 → \ufffd（对齐 Go 对非法 UTF-8 的处理）。
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        out.push(s[i], s[i + 1]);
        i++;
        continue;
      }
      out.push("\\ufffd");
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      out.push("\\ufffd");
      continue;
    }
    if (c === 0x2028 || c === 0x2029) {
      out.push("\\u202" + (c & 0xf).toString(16));
      continue;
    }
    out.push(s[i]);
  }
  out.push('"');
}