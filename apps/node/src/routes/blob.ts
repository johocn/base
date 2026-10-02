// 逐行对齐 internal/httpapi/content.go 的 handleBlob / handleBlobHead（:84-142），
// 以及 internal/httpapi/blob.go 的 handleBlobPost（:12-61）。
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ServerHandler } from "@base/core-ts";
import { blobId, isBlobId } from "@base/protocol-ts";
import type { Db } from "../db";
import { decrypt } from "../host/aesgcm";
import { putBlob } from "../store/events";
import { type AuthedHandler, writeAuthErr } from "./authmw";
import { trimGoSpace } from "./derived";
import { jsonResponse } from "./json";

/** 对齐 store.BlobPath：`<dataDir>/blobs/<前2>/<3-4>/<blob_id>`。 */
function blobPath(dataDir: string, blobID: string): string {
  return join(dataDir, "blobs", blobID.slice(0, 2), blobID.slice(2, 4), blobID);
}

export interface BlobDeps {
  dataDir?: string;
  /** 未提供 dataDir 时为 null，按「块不存在」404 处理。 */
  storeKey: Uint8Array | null;
}

/** handleBlob：读块文件 → AES-GCM 解密 → 重算哈希 → 返回明文。 */
export function blobGetHandler(deps: BlobDeps): ServerHandler {
  return async (req) => {
    const blobID = req.params.blob_id ?? "";
    if (!isBlobId(blobID)) {
      return jsonResponse(400, { error: "非法 blob_id" });
    }
    if (deps.dataDir === undefined || deps.storeKey === null) {
      return jsonResponse(404, { error: "块不存在" });
    }

    let raw: Buffer;
    try {
      raw = readFileSync(blobPath(deps.dataDir, blobID));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return jsonResponse(404, { error: "块不存在" });
      }
      return jsonResponse(500, { error: String(err) });
    }

    let data: Uint8Array;
    try {
      data = decrypt(deps.storeKey, new Uint8Array(raw));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, { error: `store: decrypt blob ${blobID}: ${msg}` });
    }
    if (blobId(data) !== blobID) {
      return jsonResponse(500, { error: "块内容与哈希不符" });
    }

    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(data.byteLength),
      ETag: `"${blobID}"`,
      "Cache-Control": "public, max-age=31536000, immutable",
    };
    if ((req.headers["if-none-match"] ?? "") === `"${blobID}"`) {
      return { status: 304, headers, body: new Uint8Array(0) };
    }
    return { status: 200, headers, body: data };
  };
}

/**
 * handleBlobHead：只做存在性判定，不读文件内容。
 * size 取自 blobs 表（明文大小），**不是** os.stat 的密文大小（多 28 字节）。
 */
export function blobHeadHandler(db: Db, deps: { dataDir?: string }): ServerHandler {
  return async (req) => {
    const blobID = req.params.blob_id ?? "";
    if (!isBlobId(blobID)) {
      return jsonResponse(400, { error: "非法 blob_id" });
    }
    if (deps.dataDir === undefined) {
      return jsonResponse(404, { error: "块不存在" });
    }

    // HasBlob：先查 blobs 表拿明文 size，再确认文件存在。
    let size: unknown;
    try {
      const rows = db.select(`SELECT size FROM blobs WHERE blob_id=?`, [blobID]);
      if (rows.length === 0) {
        return jsonResponse(404, { error: "块不存在" });
      }
      size = rows[0].size;
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
    try {
      statSync(blobPath(deps.dataDir, blobID));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return jsonResponse(404, { error: "块不存在" });
      }
      return jsonResponse(500, { error: String(err) });
    }

    return {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
        ETag: `"${blobID}"`,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    };
  };
}

// ==================== POST /v1/blob（blob.go:12-61 的 handleBlobPost）====================
//
// 本接口的身份由签名中间件 requireAuthLimit 承担（server.go:121），handleBlobPost **不使用** identityId。
// 核心难点是手写一个与 Go `net/http.Request.MultipartReader()` + `mime/multipart` 字节级对齐的
// multipart/form-data 解析器：只认第一个 name="file" 分片、取到即停，其余分片读掉丢弃。

/** maxBlobBytes（blob.go:12）：单块上传的明文上限 8 MiB。 */
export const MAX_BLOB_BYTES = 8 << 20;

/** blobPostHandler 的依赖：Db + 落盘目录与 store 密钥（item_id 传 ""、seq 传 0）。 */
export interface BlobPostDeps {
  db: Db;
  /** 未提供时按空串落盘（生产由 serve.ts 注入 dataDir）。 */
  dataDir?: string;
  storeKey: Uint8Array | null;
}

// —— 字节工具（Go 用 []byte 做前缀/查找/比较，这里逐一对齐）——

function startsWithBytes(buf: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > buf.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buf[i] !== prefix[i]) return false;
  }
  return true;
}

function indexOfBytes(buf: Uint8Array, needle: Uint8Array, from = 0): number {
  const n = needle.length;
  if (n === 0) return from;
  const limit = buf.length - n;
  outer: for (let i = from; i <= limit; i++) {
    for (let j = 0; j < n; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function lastIndexOfByte(buf: Uint8Array, b: number): number {
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] === b) return i;
  }
  return -1;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function concatAll(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** skipLWSPChar（multipart.go:479-487）：去掉前导 SP/HTAB。 */
function skipLWSPBytes(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09)) i++;
  return b.subarray(i);
}

/** textproto.trim：去掉首尾 SP/HTAB。 */
function trimBothWS(b: Uint8Array): Uint8Array {
  let i = 0;
  let j = b.length;
  while (i < j && (b[i] === 0x20 || b[i] === 0x09)) i++;
  while (j > i && (b[j - 1] === 0x20 || b[j - 1] === 0x09)) j--;
  return b.subarray(i, j);
}

/** 原始字节 ⇄「字节串」：每个字节 ↔ 一个码点，避免 utf8/latin1 往返丢失二进制。 */
function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function byteString(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** ASCII 大小写折叠（strings.EqualFold 在纯 ASCII 上的等价；头值只可能是 latin1 字节）。 */
function foldAscii(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += String.fromCharCode(c >= 0x41 && c <= 0x5a ? c + 32 : c);
  }
  return out;
}

// —— mime.ParseMediaType 的最小复刻（mime/mediatype.go:142-343、mime/grammar.go）——
// 只服务本文件的 Content-Type / Content-Disposition：媒体类型 TrimSpace+ToLower、
// 参数名小写、值去引号；任何参数解析错误按 Go 口径整体判失败（ErrInvalidMediaParameter）。

const GO_WS_EXTRA = [0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];

function isGoSpace(cp: number): boolean {
  if (cp <= 0xff) {
    return (
      cp === 0x09 ||
      cp === 0x0a ||
      cp === 0x0b ||
      cp === 0x0c ||
      cp === 0x0d ||
      cp === 0x20 ||
      cp === 0x85 ||
      cp === 0xa0
    );
  }
  return GO_WS_EXTRA.includes(cp) || (cp >= 0x2000 && cp <= 0x200a);
}

function skipGoSpace(s: string, i: number): number {
  while (i < s.length && isGoSpace(s.codePointAt(i) as number)) i++;
  return i;
}

const TOKEN_EXTRA = "!#$%&'*+-.^_`{|}~";
const TSPECIALS = "()<>@,;:\\\"/[]?=";

/** isTokenChar（mime/grammar.go:40-71）。 */
function isTokenChar(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c < 0x80 && TOKEN_EXTRA.includes(String.fromCharCode(c)))
  );
}

/** isTSpecial（mime/grammar.go:9-36）。 */
function isTSpecial(c: number): boolean {
  return c < 0x80 && TSPECIALS.includes(String.fromCharCode(c));
}

function consumeToken(s: string, i: number): { token: string; next: number } {
  let j = i;
  while (j < s.length && isTokenChar(s.charCodeAt(j))) j++;
  return { token: s.slice(i, j), next: j };
}

/** consumeValue（mediatype.go:279-316）：token 或 quoted-string；失败时 next===i。 */
function consumeValue(s: string, i: number): { value: string; next: number } {
  if (i >= s.length) return { value: "", next: i };
  if (s[i] !== '"') {
    const t = consumeToken(s, i);
    return { value: t.token, next: t.next };
  }
  let out = "";
  for (let k = i + 1; k < s.length; k++) {
    const ch = s[k];
    if (ch === '"') return { value: out, next: k + 1 };
    if (ch === "\\" && k + 1 < s.length && isTSpecial(s.charCodeAt(k + 1))) {
      out += s[k + 1];
      k++;
      continue;
    }
    if (ch === "\r" || ch === "\n") return { value: "", next: i };
    out += ch;
  }
  return { value: "", next: i };
}

function consumeMediaParam(
  s: string,
  start: number,
): { key: string; value: string; next: number } | null {
  let i = skipGoSpace(s, start);
  if (s[i] !== ";") return null;
  i = skipGoSpace(s, i + 1);
  const t = consumeToken(s, i);
  if (t.token === "") return null;
  const key = t.token.toLowerCase();
  i = skipGoSpace(s, t.next);
  if (s[i] !== "=") return null;
  i = skipGoSpace(s, i + 1);
  const cv = consumeValue(s, i);
  if (cv.next === i) return null;
  return { key, value: cv.value, next: cv.next };
}

/** checkMediaTypeDisposition（mediatype.go:98-118）：token "/" token 且无尾随。 */
function checkMediaTypeDisposition(s: string): boolean {
  const t = consumeToken(s, 0);
  if (t.token === "") return false;
  if (t.next === s.length) return true;
  if (s[t.next] !== "/") return false;
  const sub = consumeToken(s, t.next + 1);
  if (sub.token === "") return false;
  return sub.next === s.length;
}

interface ParsedMediaType {
  mediaType: string;
  params: Map<string, string>;
  /** 参数部分解析失败（Go 的 ErrInvalidMediaParameter）：媒体类型仍有效，参数视作空表。 */
  paramError: boolean;
}

/**
 * ParseMediaType。返回 null 表示媒体类型本身非法（Go 返回 ""+err）。
 * 注意：本实现不处理 RFC 2231 连续参数（`foo*` / `foo*0`），边界参数用不到。
 */
function parseMediaType(v: string): ParsedMediaType | null {
  const semi = v.indexOf(";");
  const base = semi < 0 ? v : v.slice(0, semi);
  const mediaType = trimGoSpace(base).toLowerCase();
  if (!checkMediaTypeDisposition(mediaType)) return null;

  const params = new Map<string, string>();
  let i = base.length;
  while (i < v.length) {
    i = skipGoSpace(v, i);
    if (i >= v.length) break;
    const p = consumeMediaParam(v, i);
    if (p === null) {
      // 忽略尾随的分号（mediatype.go:166-169），其余即参数错误。
      if (trimGoSpace(v.slice(i)) === ";") break;
      return { mediaType, params, paramError: true };
    }
    const prev = params.get(p.key);
    if (prev !== undefined && prev !== p.value) return { mediaType, params, paramError: true };
    params.set(p.key, p.value);
    i = p.next;
  }
  return { mediaType, params, paramError: false };
}

/** FormName（multipart.go:76-86）：Content-Disposition 必须是 form-data，取 name 参数。 */
function formNameOf(headers: Map<string, string>): string {
  const v = headers.get("content-disposition") ?? "";
  const parsed = parseMediaType(v);
  if (parsed === null) return "";
  if (parsed.mediaType !== "form-data") return "";
  if (parsed.paramError) return "";
  return parsed.params.get("name") ?? "";
}

/** validHeaderValueByte（textproto/reader.go:731-743）：禁 0x00-0x08 / 0x0A-0x1F / 0x7F。 */
function validHeaderValueByte(c: number): boolean {
  if (c === 0x09 || c === 0x20) return true;
  if (c >= 0x21 && c <= 0x7e) return true;
  return c >= 0x80;
}

// —— quotedprintable.Reader 的最小复刻（mime/quotedprintable/reader.go:16-140）——
// NextPart 在 CTE=quoted-printable 时对分片体透明解码（multipart.go:159-165）。
// 逐行算法（含 Go 的 4 处 RFC 偏离）原样照抄；行窗口取 bufio.NewReader 默认缓冲 4096，
// 超窗即 ErrBufferFull（Go 侧同样会上抛为 bad_multipart）。

/** bufio 默认缓冲：quotedprintable.NewReader 内层 bufio.NewReader 的行长上限。 */
const QP_LINE_WINDOW = 4096;

/** isQPDiscardWhitespace（reader.go:57-63）：行尾被丢弃的字符集。 */
function isQPDiscardWhitespace(b: number): boolean {
  return b === 0x0a || b === 0x0d || b === 0x20 || b === 0x09;
}

/** fromHex（reader.go:30-41）：十六进制字节，非法返回 null。 */
function qpFromHex(b: number): number | null {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  return null;
}

/** readHexByte（reader.go:43-55）：不足两字节或非法即 null（对应 io.ErrUnexpectedEOF 与 hex 错误）。 */
function qpReadHex(v: Uint8Array): number | null {
  if (v.length < 2) return null;
  const hb = qpFromHex(v[0]);
  if (hb === null) return null;
  const lb = qpFromHex(v[1]);
  if (lb === null) return null;
  return (hb << 4) | lb;
}

/**
 * 解码 quoted-printable 分片体（Reader.Read 的 ReadAll 等价：输出缓冲无限大）。
 * 返回 error=true 表示 Go 会向上抛错（进而 400 bad_multipart）；io.EOF 不算错。
 */
function decodeQuotedPrintable(raw: Uint8Array): { body: Uint8Array; error: boolean } {
  const chunks: Uint8Array[] = [];
  let pos = 0;
  /** 当前待消费行（对应 r.line）；null 表示需读下一行。 */
  let line: Uint8Array | null = null;
  /** r.rerr == io.EOF（底层读到末尾）。 */
  let rerrEOF = false;
  /** r.rerr 为其它错误（ErrBufferFull / invalid bytes after =）。 */
  let rerrOther = false;

  for (;;) {
    if (line === null) {
      if (rerrOther) return { body: concatAll(chunks), error: true };
      if (rerrEOF) return { body: concatAll(chunks), error: false };
      // bufio.ReadSlice('\n')：窗口内找 '\n'；窗口满而无 '\n' 即 ErrBufferFull。
      const avail = raw.length - pos;
      const win = Math.min(avail, QP_LINE_WINDOW);
      let nl = -1;
      for (let k = 0; k < win; k++) {
        if (raw[pos + k] === 0x0a) {
          nl = k;
          break;
        }
      }
      let whole: Uint8Array;
      if (nl >= 0) {
        whole = raw.subarray(pos, pos + nl + 1);
        pos += nl + 1;
        rerrEOF = false;
      } else if (avail >= QP_LINE_WINDOW) {
        whole = raw.subarray(pos, pos + QP_LINE_WINDOW);
        pos += QP_LINE_WINDOW;
        rerrOther = true;
      } else {
        whole = raw.subarray(pos);
        pos = raw.length;
        rerrEOF = true;
      }
      if (whole.length === 0) continue; // 空读（EOF）：回到顶部走返回路径
      const hasLF = whole[whole.length - 1] === 0x0a;
      const hasCR = hasLF && whole.length >= 2 && whole[whole.length - 2] === 0x0d;
      let end = whole.length; // TrimRightFunc(isQPDiscardWhitespace)
      while (end > 0 && isQPDiscardWhitespace(whole[end - 1])) end--;
      let cur = whole.subarray(0, end);
      if (cur.length > 0 && cur[cur.length - 1] === 0x3d) {
        // 软换行：'=' 后只允许（可选 SP/HTAB 后）换行；末尾 '=' 仅在非空行尾才算合法。
        let rs = whole.subarray(end);
        let rsStart = 0;
        while (rsStart < rs.length && (rs[rsStart] === 0x20 || rs[rsStart] === 0x09)) rsStart++;
        rs = rs.subarray(rsStart);
        cur = cur.subarray(0, cur.length - 1);
        const ok =
          (rs.length > 0 && rs[0] === 0x0a) ||
          (rs.length >= 2 && rs[0] === 0x0d && rs[1] === 0x0a) ||
          (rs.length === 0 && cur.length > 0 && rerrEOF);
        if (!ok) rerrOther = true;
      } else if (hasLF) {
        cur = concatAll([cur, hasCR ? byteString("\r\n") : byteString("\n")]);
      }
      line = cur;
      continue;
    }

    // 逐字符消费 r.line（Go 的 for len(p)>0 循环体）。
    const out: number[] = [];
    while (line.length > 0) {
      const b = line[0];
      let outB: number;
      let consume = 1;
      if (b === 0x3d) {
        const h = qpReadHex(line.subarray(1, 3));
        if (h === null) {
          if (line.length >= 2 && line[1] !== 0x0d && line[1] !== 0x0a) {
            outB = 0x3d; // 非行尾的孤立 '=' 取字面量（issue 13219）
          } else {
            return { body: concatAll(chunks), error: true };
          }
        } else {
          outB = h;
          consume = 3;
        }
      } else if (b === 0x09 || b === 0x0d || b === 0x0a || b >= 0x80) {
        outB = b; // 制表/换行与 >=0x80 原样透传
      } else if (b < 0x20 || b > 0x7e) {
        return { body: concatAll(chunks), error: true };
      } else {
        outB = b;
      }
      out.push(outB);
      line = line.subarray(consume);
    }
    chunks.push(Uint8Array.from(out));
    line = null;
  }
}

/** maxMIMEHeaders（multipart.go:355-367）：godebug 未设时默认 10000 条头。 */
const MAX_MIME_HEADERS = 10000;

// —— multipart.Reader 的最小复刻（mime/multipart/multipart.go:113-487）——
// 整个请求体已在内存中，故把「逐行 ReadSlice + bufio 缓冲」等价收敛为对同一字节数组的游标扫描；
// scanUntilBoundary / matchAfterPrefix 逐字照抄，保证分片体边界与结构错误口径一致。

/** ScanErr：0=需继续读，1=io.EOF（分片体正常结束），2=readErr（结构错误）。 */
type ScanErr = 0 | 1 | 2;

/** matchAfterPrefix（multipart.go:295-323）逐字复刻。 */
function matchAfterPrefix(buf: Uint8Array, prefix: Uint8Array, readErrNonNil: boolean): number {
  if (buf.length === prefix.length) return readErrNonNil ? 1 : 0;
  const c = buf[prefix.length];
  if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a) return 1;
  if (c === 0x2d) {
    if (buf.length === prefix.length + 1) return readErrNonNil ? -1 : 0;
    if (buf[prefix.length + 1] === 0x2d) return 1;
  }
  return -1;
}

/** scanUntilBoundary（multipart.go:239-281）逐字复刻。 */
function scanUntilBoundary(
  buf: Uint8Array,
  dashBoundary: Uint8Array,
  nlDashBoundary: Uint8Array,
  total: number,
  readErrNonNil: boolean,
): { n: number; err: ScanErr } {
  if (total === 0) {
    if (startsWithBytes(buf, dashBoundary)) {
      const m = matchAfterPrefix(buf, dashBoundary, readErrNonNil);
      if (m === -1) return { n: dashBoundary.length, err: 0 };
      if (m === 0) return { n: 0, err: 0 };
      return { n: 0, err: 1 };
    }
    if (startsWithBytes(dashBoundary, buf)) return { n: 0, err: readErrNonNil ? 2 : 0 };
  }
  const i = indexOfBytes(buf, nlDashBoundary);
  if (i >= 0) {
    const m = matchAfterPrefix(buf.subarray(i), nlDashBoundary, readErrNonNil);
    if (m === -1) return { n: i + nlDashBoundary.length, err: 0 };
    if (m === 0) return { n: i, err: 0 };
    return { n: i, err: 1 };
  }
  if (startsWithBytes(nlDashBoundary, buf)) return { n: 0, err: readErrNonNil ? 2 : 0 };
  const j = lastIndexOfByte(buf, nlDashBoundary[0]);
  if (j >= 0 && startsWithBytes(nlDashBoundary, buf.subarray(j))) return { n: j, err: 0 };
  return { n: buf.length, err: readErrNonNil ? 2 : 0 };
}

/** NextPart 的结果：一个分片 / io.EOF / 结构错误。 */
type NextPartResult =
  | { kind: "part"; formName: string }
  | { kind: "eof" }
  | { kind: "error" };

class MultipartReader {
  private pos = 0;
  private nl: Uint8Array;
  private nlDashBoundary: Uint8Array;
  private readonly dashBoundary: Uint8Array;
  private readonly dashBoundaryDash: Uint8Array;
  private partsRead = 0;
  /** 当前分片是否为 `Content-Transfer-Encoding: quoted-printable`（NextPart 透明解码，见 newPart）。 */
  private partQP = false;

  constructor(
    private readonly data: Uint8Array,
    boundary: Uint8Array,
  ) {
    const dash = new Uint8Array(boundary.length + 2);
    dash[0] = 0x2d;
    dash[1] = 0x2d;
    dash.set(boundary, 2);
    this.dashBoundary = dash;
    this.dashBoundaryDash = concatAll([dash, new Uint8Array([0x2d, 0x2d])]);
    this.nl = new Uint8Array([0x0d, 0x0a]);
    this.nlDashBoundary = concatAll([this.nl, dash]);
  }

  /** Reader.NextPart（multipart.go:384-442）：跳过前导行直到边界行；结构错误即报错。 */
  nextPart(): NextPartResult {
    if (this.dashBoundary.length === 2) return { kind: "error" }; // 空 boundary
    let expectNewPart = false;
    for (;;) {
      const { line, eof } = this.readLineSlice();
      if (eof && this.isFinalBoundary(line)) return { kind: "eof" };
      if (eof) return { kind: "error" };
      if (this.isBoundaryDelimiterLine(line)) {
        this.partsRead++;
        const headers = this.readPartHeaders();
        if (headers === null) return { kind: "error" };
        // newPart（multipart.go:159-165）：rawPart=false 时，CTE 等于 quoted-printable（EqualFold）
        // 即删掉该头并让分片体走透明解码。
        this.partQP = foldAscii(headers.get("content-transfer-encoding") ?? "") === "quoted-printable";
        if (this.partQP) headers.delete("content-transfer-encoding");
        return { kind: "part", formName: formNameOf(headers) };
      }
      if (this.isFinalBoundary(line)) return { kind: "eof" };
      if (expectNewPart) return { kind: "error" };
      if (this.partsRead === 0) continue;
      if (equalBytes(line, this.nl)) {
        expectNewPart = true;
        continue;
      }
      return { kind: "error" };
    }
  }

  /** 读掉并丢弃当前分片体（Part.Close → io.Copy(io.Discard, part)；不走 CTE 解码）。 */
  drainPart(): void {
    this.readPartRaw(Number.MAX_SAFE_INTEGER);
  }

  /**
   * 取分片体（io.ReadAll(io.LimitReader(part, limit))）：error 表示结构错误。
   * Go 的 `part` 在 CTE=quoted-printable 时是 QP 解码器，**上限计在解码后的字节**上。
   */
  readPart(limit: number): { body: Uint8Array; error: boolean } {
    const raw = this.readPartRaw(Number.MAX_SAFE_INTEGER);
    if (raw.error) return raw;
    if (!this.partQP) return { body: raw.body.subarray(0, limit), error: false };
    const dec = decodeQuotedPrintable(raw.body);
    if (dec.error) return { body: dec.body, error: true };
    return { body: dec.body.subarray(0, limit), error: false };
  }

  /** 原始分片体（partReader：不做 CTE 解码）：limit 为原始字节上限。 */
  private readPartRaw(limit: number): { body: Uint8Array; error: boolean } {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let readErrNonNil = false;
    for (;;) {
      if (total >= limit) break;
      let sr = scanUntilBoundary(
        this.data.subarray(this.pos),
        this.dashBoundary,
        this.nlDashBoundary,
        total,
        readErrNonNil,
      );
      // partReader.Read：n==0 且无错则强制再读（触底即 readErr=ErrUnexpectedEOF）。
      while (sr.n === 0 && sr.err === 0) {
        readErrNonNil = true;
        sr = scanUntilBoundary(
          this.data.subarray(this.pos),
          this.dashBoundary,
          this.nlDashBoundary,
          total,
          readErrNonNil,
        );
      }
      if (sr.n > 0) {
        const take = Math.min(sr.n, limit - total);
        chunks.push(this.data.subarray(this.pos, this.pos + take));
        this.pos += take;
        total += take;
        if (sr.err === 2) return { body: concatAll(chunks), error: true };
        if (sr.err === 1) return { body: concatAll(chunks), error: false };
        if (take < sr.n) break; // LimitReader 触顶
        continue;
      }
      if (sr.err === 1) return { body: concatAll(chunks), error: false };
      return { body: concatAll(chunks), error: true };
    }
    return { body: concatAll(chunks), error: false };
  }

  /** ReadSlice('\n')：返回含行尾 '\n' 的行；EOF 时返回残余并置 eof。 */
  private readLineSlice(): { line: Uint8Array; eof: boolean } {
    const start = this.pos;
    const idx = this.data.indexOf(0x0a, start);
    if (idx < 0) {
      this.pos = this.data.length;
      return { line: this.data.subarray(start), eof: true };
    }
    this.pos = idx + 1;
    return { line: this.data.subarray(start, idx + 1), eof: false };
  }

  /** isBoundaryDelimiterLine（multipart.go:456-477）：首分片处容忍裸 '\n' 结束并切换 nl。 */
  private isBoundaryDelimiterLine(line: Uint8Array): boolean {
    if (!startsWithBytes(line, this.dashBoundary)) return false;
    const rest = skipLWSPBytes(line.subarray(this.dashBoundary.length));
    if (this.partsRead === 0 && rest.length === 1 && rest[0] === 0x0a) {
      this.nl = this.nl.subarray(1);
      this.nlDashBoundary = this.nlDashBoundary.subarray(1);
    }
    return equalBytes(rest, this.nl);
  }

  /** isFinalBoundary（multipart.go:447-454）：`^--boundary--[ \t]*(\r\n)?$`。 */
  private isFinalBoundary(line: Uint8Array): boolean {
    if (!startsWithBytes(line, this.dashBoundaryDash)) return false;
    const rest = skipLWSPBytes(line.subarray(this.dashBoundaryDash.length));
    return rest.length === 0 || equalBytes(rest, this.nl);
  }

  /** readMIMEHeader（textproto/reader.go:523-608）：小写键的扁平表，重复键取首个。 */
  private readPartHeaders(): Map<string, string> | null {
    // 首个头行不得以 SP/HTAB 开头（reader.go:544-552）。
    if (
      this.pos < this.data.length &&
      (this.data[this.pos] === 0x20 || this.data[this.pos] === 0x09)
    ) {
      return null;
    }
    const headers = new Map<string, string>();
    let entryCount = 0;
    for (;;) {
      const first = this.readHeaderLine();
      if (first.eof) return null; // 头中途 EOF → 报错
      if (first.line.length === 0) return headers; // 空行 = 头结束
      if (first.line.indexOf(0x3a) < 0) return null; // mustHaveFieldNameColon

      let kv = trimBothWS(first.line);
      // 折叠续行：后续以 SP/HTAB 开头的行并入本行（单个空格分隔）。
      for (;;) {
        if (this.pos >= this.data.length) break;
        const nb = this.data[this.pos];
        if (nb !== 0x20 && nb !== 0x09) break;
        const cont = this.readHeaderLine();
        if (cont.eof) break;
        kv = concatAll([kv, byteString(" "), trimBothWS(cont.line)]);
      }

      const colon = kv.indexOf(0x3a);
      if (colon <= 0) return null; // 空键名（行首 ':'）→ canonicalMIMEHeaderKey("") 失败
      const keyBytes = kv.subarray(0, colon);
      // canonicalMIMEHeaderKey（reader.go:755-802）：键含非 token 且非空格字节即报错。
      for (let i = 0; i < keyBytes.length; i++) {
        if (keyBytes[i] !== 0x20 && !isTokenChar(keyBytes[i])) return null;
      }
      const rawValue = kv.subarray(colon + 1);
      for (let i = 0; i < rawValue.length; i++) {
        if (!validHeaderValueByte(rawValue[i])) return null;
      }
      // maxHeaders（multipart.go:355-367 默认 10000；reader.go:575-578）：超限即 ErrMessageTooLarge。
      entryCount++;
      if (entryCount > MAX_MIME_HEADERS) return null;
      const key = latin1(keyBytes).toLowerCase();
      const value = latin1(skipLWSPBytes(rawValue));
      if (!headers.has(key)) headers.set(key, value);
    }
  }

  /** bufio.ReadLine：返回去掉行尾 "\r\n"/"\n" 的行（仅去一个 '\r'）。 */
  private readHeaderLine(): { line: Uint8Array; eof: boolean } {
    const start = this.pos;
    const idx = this.data.indexOf(0x0a, start);
    if (idx < 0) {
      this.pos = this.data.length;
      return { line: this.data.subarray(start), eof: true };
    }
    let end = idx;
    if (end > start && this.data[end - 1] === 0x0d) end--;
    this.pos = idx + 1;
    return { line: this.data.subarray(start, end), eof: false };
  }
}

/** Request.MultipartReader（net/http/request.go:502-530）：allowMixed=true。 */
function newMultipartReader(body: Uint8Array, contentType: string): MultipartReader | null {
  if (contentType === "") return null;
  const parsed = parseMediaType(contentType);
  if (parsed === null || parsed.paramError) return null;
  const d = parsed.mediaType;
  // multipartReader(true)：form-data 与 mixed 均接受。
  if (d !== "multipart/form-data" && d !== "multipart/mixed") return null;
  const boundary = parsed.params.get("boundary");
  if (boundary === undefined) return null;
  return new MultipartReader(body, byteString(boundary));
}

/**
 * handleBlobPost（blob.go:17-61）：multipart 单块、字段名 file、上限 maxBlobBytes、内容寻址幂等。
 * identityId 不使用（Go 的该接口走签名中间件即可，处理体忽略身份）。
 */
export function blobPostHandler(deps: BlobPostDeps): AuthedHandler {
  return async (req) => {
    const mr = newMultipartReader(req.body, req.headers["content-type"] ?? "");
    if (mr === null) return writeAuthErr(400, "bad_multipart");

    let data: Uint8Array | null = null;
    for (;;) {
      const next = mr.nextPart();
      if (next.kind === "eof") break;
      if (next.kind === "error") return writeAuthErr(400, "bad_multipart");
      if (next.formName !== "file") {
        mr.drainPart();
        continue;
      }
      const res = mr.readPart(MAX_BLOB_BYTES + 1);
      if (res.error) return writeAuthErr(400, "bad_multipart");
      if (res.body.byteLength > MAX_BLOB_BYTES) return writeAuthErr(413, "blob_too_large");
      data = res.body;
      break;
    }
    if (data === null || data.byteLength === 0) return writeAuthErr(400, "bad_multipart");

    const blobID = blobId(data);
    // item_id / seq 留空：先传块、后投稿，块与条目的关联由投稿时的 attr.attachment 行建立。
    try {
      putBlob(deps.db, deps.dataDir ?? "", deps.storeKey, blobID, data, "", 0);
    } catch (err) {
      return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
    }
    return jsonResponse(200, { blob_id: blobID, size: data.byteLength });
  };
}
