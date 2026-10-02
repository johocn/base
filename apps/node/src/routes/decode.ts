// 严格 JSON 解码：对齐 Go `json.NewDecoder(...).Decode(&struct)` 的口径
// （internal/httpapi/identity.go:40-48 的 decodeJSON），供 register / escrow PUT / profile 及后续 B2/B3 复用。
//
// 与 `JSON.parse` 的差异（逐条对齐 Go 已实证的行为）：
// - 只解**第一个** JSON 值、不拒绝尾随内容（Go Decoder.Decode 语义）；语法错误 → 400 bad_json。
// - 顶层 `null` 解进 struct 是 **no-op**（零值），不算错；顶层数组/数字/字符串/布尔 → bad_json。
// - 字段类型严格：string 字段收数字/数组 → bad_json；int64 字段收 `1.5` / `1e2` / 字符串 / 越界 → bad_json；
//   任意字段收 `null` 是 no-op（取零值）；未知字段忽略（Go 默认行为）。
// - `json.RawMessage` 字段：只要**出现**（含 `null`，Go 侧 `len(raw)>0`）即判为非空 → 解码为 `true`。
// - 指针三态（`opt(x)`，Go `*T`）：键**缺失或 `null`** → nil（返回 `null`，Go 零值）；
//   有值则按 `x` 递归解码（x 为 spec 时非对象、x 为 "string" 时非字符串 → bad_json）。
import type { ServerRequest, ServerResponse } from "@base/core-ts";
import { MAX_JSON_BODY } from "./authmw";
import { jsonResponse } from "./json";

/**
 * 叶子字段类型：
 * - string：Go string 字段；
 * - int64：Go int64 字段（须十进制整数字面量且不越界）；
 * - raw：json.RawMessage 的「只判存在性」用法，出现即 true（含 null）；
 * - number：json.Number 字段，返回**原始字面量文本**（裸数字保留字面，字符串须过 JSON 数字文法）；
 * - rawText：json.RawMessage 字段，返回该值在请求体里的**原始字节切片**（不含两侧空白）。
 */
export type StrictField =
  | "string"
  | "int64"
  | "raw"
  | "number"
  | "rawText"
  | StrictSpec
  | StrictList
  | StrictOpt;

/** 对象形状：键 → 字段规格；嵌套对象即再给一层 StrictSpec。 */
export interface StrictSpec {
  [field: string]: StrictField;
}

/**
 * 数组字段规格（Go `[]T`）：由 `listOf(spec)` 构造，`spec` 是每个元素的形状。
 * 用 Symbol 标记（不可枚举、不参与 `Object.keys`），避免与同名业务字段冲突。
 */
export interface StrictList {
  readonly [LIST_SPEC]: StrictSpec;
}

/**
 * 指针字段规格（Go `*T`）：由 `opt(inner)` 构造，复刻「键缺失 / `null` → nil；
 * 有值则按 `inner` 解码」的三态语义。同样用 Symbol 标记（不可枚举、不参与 `Object.keys`）。
 */
export interface StrictOpt {
  readonly [OPT_SPEC]: StrictField;
}

export type StrictResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; resp: ServerResponse };

/** 数组字段标记（唯一 symbol；不进对象键枚举）。 */
const LIST_SPEC = Symbol("strict_list_spec");

/** 构造一个「元素按 `spec` 解码」的数组字段规格。 */
export function listOf(spec: StrictSpec): StrictList {
  return { [LIST_SPEC]: spec };
}

/** 判定字段规格是否为 listOf 产出的数组规格。 */
function isStrictList(spec: StrictField): spec is StrictList {
  if (typeof spec !== "object" || spec === null) return false;
  return (spec as unknown as Record<symbol, unknown>)[LIST_SPEC] !== undefined;
}

/** 指针字段标记（唯一 symbol；不进对象键枚举）。 */
const OPT_SPEC = Symbol("strict_opt_spec");

/**
 * 构造一个「指针三态」字段规格（Go `*T`）：键缺失或 `null` → nil（`null`）；
 * 有值则按 `inner` 递归解码。用于 `proposalReq.Edit` / `proposalEditReq.BodyMD` 等。
 */
export function opt(inner: StrictField): StrictOpt {
  return { [OPT_SPEC]: inner };
}

/** 判定字段规格是否为 opt 产出的指针规格。 */
function isStrictOpt(spec: StrictField): spec is StrictOpt {
  if (typeof spec !== "object" || spec === null) return false;
  return (spec as unknown as Record<symbol, unknown>)[OPT_SPEC] !== undefined;
}

// —— 下面是一段极简 JSON 解析器：产出带「原始字面量」的节点树，以判定 int64 是否可解 ——
// 用 JSON.parse 会把 `1e2` 归一成 100，无法区分，故必须保留数字的原始文本。

interface Parser {
  s: string;
  i: number;
  n: number;
}

/** 解析后的 JSON 结点树；`obj` 的条目带该值在原文里的**原始切片**（供 json.RawMessage 用）。 */
export type JsonNode =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "num"; raw: string }
  | { t: "str"; v: string }
  | { t: "arr"; v: JsonNode[] }
  | { t: "obj"; v: [string, JsonNode, string][] };

const ERR = Symbol("decode_err");
const WS = new Set([" ", "\t", "\n", "\r"]);
// JSON number 文法：-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?
const NUM_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
// json.Number 从**字符串**取值时的校验：Go 的 isValidNumber 即完整 JSON 数字文法（非仅字符集）。
const NUM_FULL_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const INT_RE = /^-?(?:0|[1-9][0-9]*)$/;
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

function skipWs(p: Parser): void {
  while (p.i < p.n && WS.has(p.s[p.i])) p.i++;
}

/** 从 `"` 起扫一个字符串，返回解码后的值；非法或未闭合返回 null。 */
function parseString(p: Parser): string | null {
  if (p.s[p.i] !== '"') return null;
  const start = p.i;
  p.i++;
  while (p.i < p.n) {
    const c = p.s[p.i];
    if (c === "\\") {
      p.i += 2;
      continue;
    }
    if (c === '"') {
      p.i++;
      // 交给引擎解码转义/代理对；非法转义由 JSON.parse 拒绝。
      try {
        return JSON.parse(p.s.slice(start, p.i)) as string;
      } catch {
        return null;
      }
    }
    p.i++;
  }
  return null;
}

function parseValue(p: Parser): JsonNode | null {
  const c = p.s[p.i];
  if (c === undefined) return null;
  if (c === "{") return parseObject(p);
  if (c === "[") return parseArray(p);
  if (c === '"') {
    const v = parseString(p);
    return v === null ? null : { t: "str", v };
  }
  if (p.s.startsWith("true", p.i)) {
    p.i += 4;
    return { t: "bool", v: true };
  }
  if (p.s.startsWith("false", p.i)) {
    p.i += 5;
    return { t: "bool", v: false };
  }
  if (p.s.startsWith("null", p.i)) {
    p.i += 4;
    return { t: "null" };
  }
  if (c === "-" || (c >= "0" && c <= "9")) {
    const m = NUM_RE.exec(p.s.slice(p.i));
    if (m === null) return null;
    p.i += m[0].length;
    return { t: "num", raw: m[0] };
  }
  return null;
}

function parseObject(p: Parser): JsonNode | null {
  p.i++; // {
  const entries: [string, JsonNode, string][] = [];
  skipWs(p);
  if (p.s[p.i] === "}") {
    p.i++;
    return { t: "obj", v: entries };
  }
  for (;;) {
    skipWs(p);
    const key = parseString(p);
    if (key === null) return null;
    skipWs(p);
    if (p.s[p.i] !== ":") return null;
    p.i++;
    skipWs(p);
    const start = p.i; // 值首字符（skipWs 之后）；供 RawMessage 的原始切片用
    const val = parseValue(p);
    if (val === null) return null;
    const raw = p.s.slice(start, p.i); // 不含两侧空白，保留内部空白与原始转义
    entries.push([key, val, raw]);
    skipWs(p);
    const c = p.s[p.i];
    if (c === ",") {
      p.i++;
      continue;
    }
    if (c === "}") {
      p.i++;
      return { t: "obj", v: entries };
    }
    return null;
  }
}

function parseArray(p: Parser): JsonNode | null {
  p.i++; // [
  const items: JsonNode[] = [];
  skipWs(p);
  if (p.s[p.i] === "]") {
    p.i++;
    return { t: "arr", v: items };
  }
  for (;;) {
    skipWs(p);
    const val = parseValue(p);
    if (val === null) return null;
    items.push(val);
    skipWs(p);
    const c = p.s[p.i];
    if (c === ",") {
      p.i++;
      continue;
    }
    if (c === "]") {
      p.i++;
      return { t: "arr", v: items };
    }
    return null;
  }
}

/** 对齐 Go 解进 int64：须是十进制整数字面量且落在 int64 范围内（`1e2` / `1.0` / 越界均拒绝）。 */
function goInt64(raw: string): number | null {
  if (!INT_RE.test(raw)) return null;
  let v: bigint;
  try {
    v = BigInt(raw);
  } catch {
    return null;
  }
  if (v < INT64_MIN || v > INT64_MAX) return null;
  return Number(v);
}

function defaultsOf(spec: StrictSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(spec)) out[k] = defaultOf(spec[k]);
  return out;
}

function defaultOf(spec: StrictField): unknown {
  if (isStrictList(spec)) return []; // Go slice 的零值（nil）
  if (isStrictOpt(spec)) return null; // Go 指针的零值（nil）
  if (spec === "string") return "";
  if (spec === "int64") return 0;
  if (spec === "raw") return false; // json.RawMessage 未出现 → 空
  if (spec === "number") return ""; // json.Number 零值即空串
  if (spec === "rawText") return ""; // json.RawMessage 未出现 → 空切片
  return defaultsOf(spec);
}

/**
 * 数组字段解码（Go `[]T`）：
 * - `null` → `[]`（Go slice 收 null 得 nil）；
 * - 非数组 → ERR（Go "cannot unmarshal ... into Go value of type []T"）；
 * - 元素 `null` → 该 spec 的零值（Go「null 对 struct 是 no-op」）；
 * - 元素非对象或字段类型不符 → ERR。
 */
function decodeListField(list: StrictList, node: JsonNode): unknown {
  if (node.t === "null") return [];
  if (node.t !== "arr") return ERR;
  const spec = list[LIST_SPEC];
  const out: unknown[] = [];
  for (const el of node.v) {
    if (el.t === "null") {
      out.push(defaultsOf(spec));
      continue;
    }
    const d = decodeObject(spec, el);
    if (d === ERR) return ERR;
    out.push(d);
  }
  return out;
}

/** 按 spec 解码单个字段：不匹配即 ERR。重复键按源码顺序逐个校验，后者覆盖前者（与 Go 一致）。 */
function decodeField(spec: StrictField, node: JsonNode, raw: string): unknown {
  // 指针三态（Go `*T`）：null → nil；有值则按 inner 递归解码（类型不符仍 ERR）。
  if (isStrictOpt(spec)) return node.t === "null" ? null : decodeField(spec[OPT_SPEC], node, raw);
  if (isStrictList(spec)) return decodeListField(spec, node);
  if (spec === "raw") return true; // 出现即非空（含 null）
  if (spec === "rawText") return raw; // json.RawMessage：原样返回值的原始字节切片（含 null 字面量）
  if (node.t === "null") return defaultOf(spec); // null 对其它字段是 no-op
  if (spec === "string") return node.t === "str" ? node.v : ERR;
  if (spec === "int64") {
    if (node.t !== "num") return ERR;
    const n = goInt64(node.raw);
    return n === null ? ERR : n;
  }
  if (spec === "number") {
    // json.Number：裸数字保留字面；字符串须过 JSON 数字文法（否则 bad_json）。
    if (node.t === "num") return node.raw;
    if (node.t === "str") return NUM_FULL_RE.test(node.v) ? node.v : ERR;
    return ERR;
  }
  if (node.t !== "obj") return ERR;
  return decodeObject(spec, node);
}

/**
 * 键名匹配：精确优先，其次大小写不敏感（Go struct 字段匹配用 EqualFold）。
 * 同名折叠命中多个字段即视为歧义、不匹配（Go 亦然）；未命中即忽略（未知字段）。
 */
function matchField(spec: StrictSpec, key: string): string | null {
  if (Object.prototype.hasOwnProperty.call(spec, key)) return key;
  const lower = key.toLowerCase();
  let found: string | null = null;
  for (const k of Object.keys(spec)) {
    if (k.toLowerCase() === lower) {
      if (found !== null) return null;
      found = k;
    }
  }
  return found;
}

function decodeObject(spec: StrictSpec, node: JsonNode): Record<string, unknown> | typeof ERR {
  if (node.t !== "obj") return ERR;
  const out = defaultsOf(spec);
  for (const [key, val, raw] of node.v) {
    const field = matchField(spec, key);
    if (field === null) continue; // 未知字段忽略
    const d = decodeField(spec[field], val, raw);
    if (d === ERR) return ERR;
    out[field] = d;
  }
  return out;
}

function badJSON(): StrictResult {
  return { ok: false, resp: jsonResponse(400, { error: "bad_json" }) };
}

/**
 * 读请求体并按 `spec` 严格解码（体上限 64 KiB，超出部分被截断，对齐 Go 的 io.LimitReader）。
 * 失败时响应已构造好（400 `{"error":"bad_json"}`），调用方直接 return。
 */
export function decodeStrict(req: ServerRequest, spec: StrictSpec): StrictResult {
  const text = Buffer.from(req.body.subarray(0, MAX_JSON_BODY)).toString("utf8");
  const p: Parser = { s: text, i: 0, n: text.length };
  skipWs(p);
  if (p.i >= p.n) return badJSON();
  const node = parseValue(p);
  if (node === null) return badJSON();
  if (node.t === "null") return { ok: true, value: defaultsOf(spec) }; // 顶层 null：no-op
  const value = decodeObject(spec, node);
  if (value === ERR) return badJSON();
  return { ok: true, value };
}

/**
 * Go `json.Unmarshal([]byte(text), &doc)` 的**整段文本**口径：全串必须恰含一个 JSON 值，
 * 除 JSON 空白外不得有尾随内容（与 `decodeStrict` 的「只解首值、不拒尾随」不同）。
 * 语法错误或尾随内容 → `null`；顶层 `null` 返回 `{t:"null"}`（零值语义由调用方判）。
 */
export function parseJSONDocument(text: string): JsonNode | null {
  const p: Parser = { s: text, i: 0, n: text.length };
  skipWs(p);
  if (p.i >= p.n) return null;
  const node = parseValue(p);
  if (node === null) return null;
  skipWs(p);
  if (p.i < p.n) return null; // 尾随内容：Go json.Unmarshal 报错
  return node;
}

/**
 * Go 结构体字段取值口径：对顶层对象按**精确优先、其次唯一大小写不敏感**匹配键（同 `matchField`），
 * 重复键后者覆盖前者；非对象或未命中 → `undefined`（即 Go 的零值）。
 */
export function jsonObjectField(node: JsonNode, key: string): JsonNode | undefined {
  if (node.t !== "obj") return undefined;
  const spec: StrictSpec = { [key]: "raw" };
  let found: JsonNode | undefined;
  for (const [k, v] of node.v) {
    if (matchField(spec, k) !== null) found = v;
  }
  return found;
}