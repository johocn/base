// 路由共享响应助手：逐字节镜像 Go `encoding/json` 的 Encoder（public.go:10-19）
// 与 `writeFileResponse`（content.go:145-163）。
import { readFileSync } from "node:fs";
import type { ServerResponse } from "@base/core-ts";

const encoder = new TextEncoder();
const HEX = "0123456789abcdef";

/**
 * 镜像 Go `enc.SetEscapeHTML(false)` 的字符串转义：
 * - `"` 与 `\` 正常转义；`\n`/`\r`/`\t` 用短转义，其余控制字符（含 DEL）转 `\u00xx`；
 * - `<`、`>`、`&` **不转义**；
 * - U+2028/U+2029 无条件转义（Go 与 escapeHTML 开关无关）。
 */
function encodeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // 代理对整体复制，不拆散
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
        continue;
      }
    }
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += "\\u00" + HEX[(c >> 4) & 0xf] + HEX[c & 0xf];
    else if (c === 0x2028) out += "\\u2028";
    else if (c === 0x2029) out += "\\u2029";
    else out += s[i];
  }
  return out + '"';
}

function encodeValue(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return encodeString(v as string);
  if (t === "number") {
    const n = v as number;
    return Number.isFinite(n) ? String(n) : "null";
  }
  if (t === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return "[" + v.map(encodeValue).join(",") + "]";
  if (t === "object") {
    // Go map[string]any 按 UTF-8 字典序排序键；TS 对象键序即插入序，调用方按序构造即可。
    const obj = v as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(obj)) parts.push(encodeString(k) + ":" + encodeValue(obj[k]));
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`json: 不支持的类型 ${t}`);
}

/** 镜像 json.Encoder.Encode：末尾带 `\n`。 */
export function encodeJSON(payload: unknown): Uint8Array {
  return encoder.encode(encodeValue(payload) + "\n");
}

/** 对齐 writeJSON：Content-Type + Cache-Control: no-store。 */
export function jsonResponse(status: number, payload: unknown): ServerResponse {
  return {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: encodeJSON(payload),
  };
}

/**
 * 对齐 `writeFileResponse`：读文件全量返回。
 * 文件不存在 → 404 `notFoundMessage`；其它错误 → 500 err.Error()；成功 → 200 + 原文。
 */
export function fileResponse(
  path: string,
  contentType: string,
  cacheable: boolean,
  notFoundMessage: string,
): ServerResponse {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return jsonResponse(404, { error: notFoundMessage });
    }
    return jsonResponse(500, { error: String(err) });
  }
  return {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(data.byteLength),
      "Cache-Control": cacheable ? "public, max-age=31536000, immutable" : "no-cache",
    },
    body: new Uint8Array(data),
  };
}
