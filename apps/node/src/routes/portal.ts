// 逐字节移植 internal/httpapi/web.go 的三条门户路由（`GET /`、`GET /a/{item_id...}`、`GET /governance`）。
//
// 要点：Go 的 html/template 是**上下文感知转义**，同一字段在文本 / 属性 / URL / CSS 上下文中
// 转义结果不同。为了与 Go 输出逐字节一致，这里自带一个极小的 text/template 子集解析器 +
// 一次扫描的状态机（只覆盖 web/templates 实际出现的语法与上下文，不做通用实现）。
// 模板运行时从同仓 web/templates/ 读取（单一真源，不复制、不预编译）。
import { readFileSync } from "node:fs";
import type { ServerHandler, ServerResponse } from "@base/core-ts";
import { normalizeTermKey } from "@base/core-ts/directory";
import { ATTR_BADGE, ATTR_TITLE_COLOR, renderMarkdown } from "@base/protocol-ts";
import type { Db } from "../db";
import { ENC_PREFIX, decText } from "../host/aesgcm";
import {
  cleanDisplayName,
  contributorRoster,
  governRoster,
  governThreshold,
  listApprovedDirectory,
  listProposalViews,
  nameOrShortID,
  toStr,
  type ProposalView,
} from "./derived";
import { jsonResponse } from "./json";

/** Go `template.HTML`：标记为安全 HTML 的值原样输出，不转义。本仓唯一一处 = 文章正文。 */
export class SafeHTML {
  constructor(readonly html: string) {}
}

// —— pageData（web.go:26-98） ——

export interface PageItem {
  ItemID: string;
  Type: string;
  Title: string;
  Rev: string;
}

export interface PageTag {
  Name: string;
  Pending: boolean;
}

export interface PageArticle {
  ItemID: string;
  Title: string;
  Digest: string;
  PublishedAt: string;
  TagViews: PageTag[];
  Body: SafeHTML;
  CoverBlobID: string;
  Badges: string[];
  TitleColor: string;
}

export interface PageContributor {
  ID: string;
  Name: string;
  Count: number;
}

export interface PageProposalEdit {
  Title: string;
  BodyMD: string;
}

export interface PageProposal {
  Action: string;
  ActionLabel: string;
  ItemID: string;
  Title: string;
  TermName: string;
  TermPending: boolean;
  Linkable: boolean;
  ItemState: string;
  ItemStateLabel: string;
  Reason: string;
  VoteCount: number;
  Threshold: number;
  Percent: number;
  Status: string;
  StatusLabel: string;
  CreatedAt: string;
  Voters: PageContributor[];
  Edit?: PageProposalEdit | null;
}

export interface PageData {
  Title: string;
  Issuer: string;
  PairingCode: string;
  Fingerprint: string;
  Items?: PageItem[];
  Article?: PageArticle | null;
  Proposals?: PageProposal[];
  Roster?: PageContributor[];
  RosterReady?: boolean;
  RemoveThreshold?: number;
  EditThreshold?: number;
}

// —— 模板引擎（text/template + html/template 子集） ——

type Operand =
  | { kind: "dot" }
  | { kind: "var"; name: string }
  | { kind: "str"; value: string }
  | { kind: "field"; base: Operand; name: string };

type Command =
  | { kind: "value"; operand: Operand }
  | { kind: "not"; operand: Operand }
  | { kind: "eq"; a: Operand; b: Operand };

interface TextNode {
  kind: "text";
  text: string;
}
interface ActionNode {
  kind: "action";
  cmd: Command;
}
interface IfNode {
  kind: "if";
  cond: Command;
  then: TplNode[];
  else: TplNode[];
}
interface WithNode {
  kind: "with";
  expr: Command;
  body: TplNode[];
  else: TplNode[];
}
interface RangeNode {
  kind: "range";
  indexVar: string | null;
  valueVar: string | null;
  expr: Command;
  body: TplNode[];
  else: TplNode[];
}
interface TemplateNode {
  kind: "template";
  name: string;
  arg: Operand | null;
}
type TplNode = TextNode | ActionNode | IfNode | WithNode | RangeNode | TemplateNode;

interface TplToken {
  isText: boolean;
  value: string;
}

/** 把模板源码切成「字面量文本」与「action 内容」两种 token（action 内容已 trim）。 */
function tokenize(src: string): TplToken[] {
  const toks: TplToken[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{{", i);
    if (open < 0) {
      if (i < src.length) toks.push({ isText: true, value: src.slice(i) });
      break;
    }
    if (open > i) toks.push({ isText: true, value: src.slice(i, open) });
    const close = src.indexOf("}}", open + 2);
    if (close < 0) {
      toks.push({ isText: true, value: src.slice(open) });
      break;
    }
    toks.push({ isText: false, value: src.slice(open + 2, close).trim() });
    i = close + 2;
  }
  return toks;
}

/** 按空白切词，引号内的空白不切（本批模板字面量无空格，够用）。 */
function tokenizeWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      cur += c;
      if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      cur += c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur !== "") {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += c;
  }
  if (cur !== "") out.push(cur);
  return out;
}

function unquote(tok: string): string {
  if (tok.length >= 2 && tok[0] === '"' && tok[tok.length - 1] === '"') {
    const body = tok.slice(1, -1);
    let out = "";
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "\\" && i + 1 < body.length) {
        const n = body[i + 1];
        if (n === "n") out += "\n";
        else if (n === "t") out += "\t";
        else out += n;
        i++;
        continue;
      }
      out += body[i];
    }
    return out;
  }
  return tok;
}

function parseOperand(tok: string | undefined): Operand {
  if (tok === undefined || tok === "" || tok === ".") return { kind: "dot" };
  if (tok[0] === '"') return { kind: "str", value: unquote(tok) };
  if (tok[0] === "$") {
    const parts = tok.slice(1).split(".");
    let op: Operand = { kind: "var", name: parts[0] };
    for (let i = 1; i < parts.length; i++) {
      if (parts[i] !== "") op = { kind: "field", base: op, name: parts[i] };
    }
    return op;
  }
  if (tok[0] === ".") {
    let op: Operand = { kind: "dot" };
    for (const p of tok.slice(1).split(".")) {
      if (p !== "") op = { kind: "field", base: op, name: p };
    }
    return op;
  }
  // 裸标识符：本批模板不出现，回退为字面量。
  return { kind: "str", value: tok };
}

function parseCommand(expr: string): Command {
  const w = tokenizeWords(expr);
  if (w[0] === "not") return { kind: "not", operand: parseOperand(w[1]) };
  if (w[0] === "eq") return { kind: "eq", a: parseOperand(w[1]), b: parseOperand(w[2]) };
  return { kind: "value", operand: parseOperand(w[0]) };
}

function firstWord(cmd: string): string {
  const sp = cmd.search(/\s/);
  return sp < 0 ? cmd : cmd.slice(0, sp);
}

function restAfterWord(cmd: string): string {
  const sp = cmd.search(/\s/);
  return sp < 0 ? "" : cmd.slice(sp + 1).trim();
}

class Parser {
  private i = 0;
  private defs = new Map<string, TplNode[]>();

  constructor(private readonly toks: TplToken[]) {}

  parse(): { body: TplNode[]; defs: Map<string, TplNode[]> } {
    const body = this.parseNodes(new Set());
    return { body, defs: this.defs };
  }

  private peekKw(): string {
    const t = this.toks[this.i];
    if (t === undefined || t.isText) return "";
    return firstWord(t.value);
  }

  private expectKw(kw: string): void {
    if (this.peekKw() === kw) this.i++;
  }

  private parseNodes(stops: Set<string>): TplNode[] {
    const nodes: TplNode[] = [];
    while (this.i < this.toks.length) {
      const t = this.toks[this.i];
      if (t.isText) {
        nodes.push({ kind: "text", text: t.value });
        this.i++;
        continue;
      }
      const cmd = t.value;
      if (cmd === "") {
        this.i++;
        continue;
      }
      const kw = firstWord(cmd);
      if (stops.has(kw)) return nodes;
      this.i++;
      switch (kw) {
        case "define": {
          const name = unquote(tokenizeWords(cmd)[1] ?? "");
          const inner = this.parseNodes(new Set(["end"]));
          this.expectKw("end");
          this.defs.set(name, inner);
          break;
        }
        case "if": {
          const cond = parseCommand(restAfterWord(cmd));
          const then = this.parseNodes(new Set(["else", "end"]));
          let els: TplNode[] = [];
          if (this.peekKw() === "else") {
            this.i++;
            els = this.parseNodes(new Set(["end"]));
          }
          this.expectKw("end");
          nodes.push({ kind: "if", cond, then, else: els });
          break;
        }
        case "with": {
          const expr = parseCommand(restAfterWord(cmd));
          const body = this.parseNodes(new Set(["else", "end"]));
          let els: TplNode[] = [];
          if (this.peekKw() === "else") {
            this.i++;
            els = this.parseNodes(new Set(["end"]));
          }
          this.expectKw("end");
          nodes.push({ kind: "with", expr, body, else: els });
          break;
        }
        case "range": {
          const rest = restAfterWord(cmd);
          let indexVar: string | null = null;
          let valueVar: string | null = null;
          let exprStr = rest;
          const assign = rest.indexOf(":=");
          if (assign >= 0) {
            const vars = rest
              .slice(0, assign)
              .split(",")
              .map((s) => s.trim().replace(/^\$/, ""))
              .filter((s) => s !== "");
            if (vars.length === 1) valueVar = vars[0];
            else if (vars.length >= 2) {
              indexVar = vars[0];
              valueVar = vars[1];
            }
            exprStr = rest.slice(assign + 2).trim();
          }
          const expr = parseCommand(exprStr);
          const body = this.parseNodes(new Set(["else", "end"]));
          let els: TplNode[] = [];
          if (this.peekKw() === "else") {
            this.i++;
            els = this.parseNodes(new Set(["end"]));
          }
          this.expectKw("end");
          nodes.push({ kind: "range", indexVar, valueVar, expr, body, else: els });
          break;
        }
        case "template": {
          const w = tokenizeWords(cmd);
          const name = unquote(w[1] ?? "");
          const arg = w.length >= 3 ? parseOperand(w[2]) : null;
          nodes.push({ kind: "template", name, arg });
          break;
        }
        default:
          nodes.push({ kind: "action", cmd: parseCommand(cmd) });
          break;
      }
    }
    return nodes;
  }
}

// —— 上下文感知转义 ——

type Mode =
  | "text"
  | "comment"
  | "bogus"
  | "tag"
  | "attrName"
  | "afterAttrName"
  | "beforeValue"
  | "valueDQ"
  | "valueSQ"
  | "valueUQ"
  | "rawtext"
  | "rcdata";

const RAWTEXT_TAGS = new Set(["style", "script", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
const RCDATA_TAGS = new Set(["title", "textarea"]);
// Go urlAttrs 的可控子集；本批模板只用到 href / src。
const URL_ATTRS = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "cite",
  "background",
  "longdesc",
  "usemap",
]);

const HEX2 = "0123456789abcdef";

function isHexByte(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
}

// Go urlFilter 的保留集（norm=true）：不可保留的一律 %XX 小写。
const URL_SAFE = ((): boolean[] => {
  const t = new Array<boolean>(256).fill(false);
  for (let c = 0x30; c <= 0x39; c++) t[c] = true;
  for (let c = 0x41; c <= 0x5a; c++) t[c] = true;
  for (let c = 0x61; c <= 0x7a; c++) t[c] = true;
  for (const ch of "!#$&*+,/:;=?@[]-._~") t[ch.charCodeAt(0)] = true;
  return t;
})();

/** processURLOnto(s, norm=true)：逐字节保留安全字节，`%` 仅在后续两位为十六进制时保留。 */
function urlNormalize(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (URL_SAFE[b]) {
      out += String.fromCharCode(b);
      continue;
    }
    if (b === 0x25 && i + 2 < bytes.length && isHexByte(bytes[i + 1]) && isHexByte(bytes[i + 2])) {
      out += "%";
      continue;
    }
    out += "%" + HEX2[(b >> 4) & 0xf] + HEX2[b & 0xf];
  }
  return out;
}

/** Go htmlReplacementTable（文本 / RCDATA / 带引号非 URL 属性值共用）。 */
function htmlEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    switch (ch) {
      case "\u0000":
        out += "\uFFFD";
        break;
      case '"':
        out += "&#34;";
        break;
      case "&":
        out += "&amp;";
        break;
      case "'":
        out += "&#39;";
        break;
      case "+":
        out += "&#43;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      default:
        out += ch;
    }
  }
  return out;
}

const CSS_TABLE: Record<string, string> = {
  "\u0000": "\\0 ",
  '"': '\\"',
  "&": "\\26 ",
  "'": "\\27 ",
  "(": "\\28 ",
  ")": "\\29 ",
  "*": "\\2a ",
  "/": "\\2f ",
  ":": "\\3a ",
  ";": "\\3b ",
  "<": "\\3c ",
  ">": "\\3e ",
  "@": "\\40 ",
  "\\": "\\5c ",
  "{": "\\7b ",
  "}": "\\7d ",
};

/** Go cssEscaper。 */
function cssEscape(s: string): string {
  let out = "";
  for (const ch of s) out += CSS_TABLE[ch] ?? ch;
  return out;
}

function isHtmlSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r";
}

/** 在 rawtext / rcdata 中找匹配的结束标签起点（`</tag` 后须为空白 / `>` / `/`）。 */
function indexOfCloseTag(text: string, from: number, tag: string): number {
  const needle = "</" + tag;
  const lower = text.toLowerCase();
  let idx = from;
  for (;;) {
    const j = lower.indexOf(needle, idx);
    if (j < 0) return -1;
    const after = text[j + needle.length];
    if (after === undefined) return -1;
    if (after === ">" || after === "/" || isHtmlSpace(after)) return j;
    idx = j + 1;
  }
}

/** 一次扫描的字面量文本状态机：决定每个「产出值」的 action 该用哪张转义表。 */
class EscapeState {
  private mode: Mode = "text";
  private tagName = "";
  private attrName = "";
  private rawTag = "";

  advance(text: string): void {
    let i = 0;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      switch (this.mode) {
        case "text": {
          if (ch !== "<") {
            i++;
            break;
          }
          if (text.startsWith("<!--", i)) {
            this.mode = "comment";
            i += 4;
            break;
          }
          if (text.startsWith("<!", i)) {
            this.mode = "bogus";
            i += 2;
            break;
          }
          const close = /^<\/\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(text.slice(i));
          if (close) {
            this.tagName = close[1].toLowerCase();
            this.mode = "bogus";
            i += close[0].length;
            break;
          }
          const open = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(text.slice(i));
          if (open) {
            this.tagName = open[1].toLowerCase();
            this.attrName = "";
            this.mode = "tag";
            i += open[0].length;
            break;
          }
          i++;
          break;
        }
        case "comment": {
          const idx = text.indexOf("-->", i);
          if (idx < 0) i = n;
          else {
            this.mode = "text";
            i = idx + 3;
          }
          break;
        }
        case "bogus": {
          const idx = text.indexOf(">", i);
          if (idx < 0) i = n;
          else {
            this.mode = "text";
            i = idx + 1;
          }
          break;
        }
        case "tag": {
          if (ch === ">") {
            this.finishTag();
            i++;
            break;
          }
          if (ch === "/") {
            i++;
            break;
          }
          if (isHtmlSpace(ch)) {
            this.mode = "afterAttrName";
            i++;
            break;
          }
          this.mode = "attrName";
          break;
        }
        case "attrName": {
          if (ch === "=") {
            this.mode = "beforeValue";
            i++;
            break;
          }
          if (ch === ">") {
            this.finishTag();
            i++;
            break;
          }
          if (ch === "/") {
            i++;
            break;
          }
          if (isHtmlSpace(ch)) {
            this.attrName = "";
            this.mode = "afterAttrName";
            i++;
            break;
          }
          this.attrName += ch.toLowerCase();
          i++;
          break;
        }
        case "afterAttrName": {
          if (ch === "=") {
            this.mode = "beforeValue";
            i++;
            break;
          }
          if (ch === ">") {
            this.finishTag();
            i++;
            break;
          }
          if (ch === "/") {
            i++;
            break;
          }
          if (isHtmlSpace(ch)) {
            i++;
            break;
          }
          this.attrName = ch.toLowerCase();
          this.mode = "attrName";
          i++;
          break;
        }
        case "beforeValue": {
          if (isHtmlSpace(ch)) {
            i++;
            break;
          }
          if (ch === '"') {
            this.mode = "valueDQ";
            i++;
            break;
          }
          if (ch === "'") {
            this.mode = "valueSQ";
            i++;
            break;
          }
          if (ch === ">") {
            this.finishTag();
            i++;
            break;
          }
          this.mode = "valueUQ";
          break;
        }
        case "valueDQ": {
          if (ch === '"') {
            this.mode = "afterAttrName";
            this.attrName = "";
          }
          i++;
          break;
        }
        case "valueSQ": {
          if (ch === "'") {
            this.mode = "afterAttrName";
            this.attrName = "";
          }
          i++;
          break;
        }
        case "valueUQ": {
          if (isHtmlSpace(ch) || ch === ">") {
            this.mode = "afterAttrName";
            this.attrName = "";
          }
          i++;
          break;
        }
        case "rawtext":
        case "rcdata": {
          const idx = indexOfCloseTag(text, i, this.rawTag);
          if (idx < 0) {
            i = n;
            break;
          }
          const gt = text.indexOf(">", idx);
          if (gt < 0) {
            i = n;
            break;
          }
          this.mode = "text";
          i = gt + 1;
          break;
        }
      }
    }
  }

  private finishTag(): void {
    if (RCDATA_TAGS.has(this.tagName)) {
      this.mode = "rcdata";
      this.rawTag = this.tagName;
    } else if (RAWTEXT_TAGS.has(this.tagName)) {
      this.mode = "rawtext";
      this.rawTag = this.tagName;
    } else {
      this.mode = "text";
    }
    this.attrName = "";
  }

  escapeValue(s: string): string {
    switch (this.mode) {
      case "valueDQ":
      case "valueSQ":
        if (this.attrName === "style") return cssEscape(s);
        if (URL_ATTRS.has(this.attrName)) return htmlEscape(urlNormalize(s));
        return htmlEscape(s);
      case "rawtext":
        return this.rawTag === "style" ? cssEscape(s) : s;
      case "rcdata":
        return htmlEscape(s);
      default:
        return htmlEscape(s);
    }
  }
}

// —— 渲染 ——

function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function evalOperand(op: Operand, dot: unknown, vars: Map<string, unknown>): unknown {
  switch (op.kind) {
    case "dot":
      return dot;
    case "str":
      return op.value;
    case "var":
      return vars.get(op.name);
    case "field": {
      const base = evalOperand(op.base, dot, vars);
      if (base === null || base === undefined || typeof base !== "object") return undefined;
      return (base as Record<string, unknown>)[op.name];
    }
  }
}

function evalCommand(cmd: Command, dot: unknown, vars: Map<string, unknown>): unknown {
  switch (cmd.kind) {
    case "value":
      return evalOperand(cmd.operand, dot, vars);
    case "not":
      return !truthy(evalOperand(cmd.operand, dot, vars));
    case "eq":
      return evalOperand(cmd.a, dot, vars) === evalOperand(cmd.b, dot, vars);
  }
}

class Renderer {
  private out = "";
  private readonly state = new EscapeState();

  constructor(private readonly defs: Map<string, TplNode[]>) {}

  render(nodes: TplNode[], data: PageData): string {
    this.renderNodes(nodes, data, new Map([["$", data]]));
    return this.out;
  }

  private renderNodes(nodes: TplNode[], dot: unknown, vars: Map<string, unknown>): void {
    for (const node of nodes) {
      switch (node.kind) {
        case "text":
          this.state.advance(node.text);
          this.out += node.text;
          break;
        case "action":
          this.writeValue(evalCommand(node.cmd, dot, vars));
          break;
        case "if":
          this.renderNodes(
            truthy(evalCommand(node.cond, dot, vars)) ? node.then : node.else,
            dot,
            vars,
          );
          break;
        case "with": {
          const v = evalCommand(node.expr, dot, vars);
          if (truthy(v)) this.renderNodes(node.body, v, vars);
          else this.renderNodes(node.else, dot, vars);
          break;
        }
        case "range": {
          const v = evalCommand(node.expr, dot, vars);
          const arr = Array.isArray(v) ? v : [];
          if (arr.length === 0) {
            this.renderNodes(node.else, dot, vars);
            break;
          }
          for (let idx = 0; idx < arr.length; idx++) {
            const childVars = new Map(vars);
            if (node.indexVar !== null) childVars.set(node.indexVar, idx);
            if (node.valueVar !== null) childVars.set(node.valueVar, arr[idx]);
            this.renderNodes(node.body, arr[idx], childVars);
          }
          break;
        }
        case "template": {
          const sub = this.defs.get(node.name);
          if (sub === undefined) break;
          const arg = node.arg === null ? undefined : evalOperand(node.arg, dot, vars);
          this.renderNodes(sub, arg, new Map());
          break;
        }
      }
    }
  }

  private writeValue(v: unknown): void {
    if (v instanceof SafeHTML) {
      this.out += v.html;
      return;
    }
    const s = v === undefined || v === null ? "" : String(v);
    this.out += this.state.escapeValue(s);
  }
}

interface TemplateSet {
  base: TplNode[];
  defs: Map<string, TplNode[]>;
}

// 模板目录（单一真源：同仓 web/templates/，不复制、不预编译）。
// 源码运行时按相对路径解析；**打包产物的层级与源码不同**（`dist/based-node.mjs` 比
// `src/routes/portal.ts` 少一层 ⇒ 相对路径会落到文件系统根），故部署时用 `BASE_WEB_DIR`
// 显式指定模板目录（绝对路径，结尾斜杠可有可无）；未设置时行为与源码模式完全一致。
const TPL_DIR = resolveTemplateDir();

function resolveTemplateDir(): URL {
  const raw = (process.env.BASE_WEB_DIR ?? "").trim();
  if (raw === "") return new URL("../../../../web/templates/", import.meta.url);
  return new URL(raw.endsWith("/") ? raw : `${raw}/`, "file:///");
}

const PAGE_FILE: Record<string, string> = {
  index: "index.html",
  article: "article.html",
  governance: "governance.html",
};

const templateCache = new Map<string, TemplateSet>();

function loadTemplateSet(page: string): TemplateSet {
  const cached = templateCache.get(page);
  if (cached !== undefined) return cached;
  const baseSrc = readFileSync(new URL("base.html", TPL_DIR), "utf8");
  const pageSrc = readFileSync(new URL(PAGE_FILE[page], TPL_DIR), "utf8");
  const baseParsed = new Parser(tokenize(baseSrc)).parse();
  const pageParsed = new Parser(tokenize(pageSrc)).parse();
  const defs = new Map(baseParsed.defs);
  for (const [k, v] of pageParsed.defs) defs.set(k, v);
  const set: TemplateSet = { base: baseParsed.body, defs };
  templateCache.set(page, set);
  return set;
}

/** 渲染入口（测试钩子）：page ∈ {index, article, governance}，data 为已组装的 pageData。 */
export function renderPortalPage(page: "index" | "article" | "governance", data: PageData): string {
  const set = loadTemplateSet(page);
  return new Renderer(set.defs).render(set.base, data);
}

// —— 取数与组装（web.go 三个 handler 的「读库 + 组装」部分） ——

export interface PortalDeps {
  db: Db;
  storeKey: Uint8Array | null;
  issuer: string;
  pairingCode: string;
  fingerprintHex: string;
}

/** 带 HTTP 状态码的门户错误（文章正文缺失等）。 */
export class PortalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const encoder = new TextEncoder();

function htmlResponse(html: string): ServerResponse {
  return {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: encoder.encode(html),
  };
}

const ITEM_COLUMNS =
  "item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig";

/** GetItem（store.go:398-409）：按主键单行；无行返回 null。 */
function getItem(db: Db, itemID: string): Record<string, unknown> | null {
  const rows = db.select(`SELECT ${ITEM_COLUMNS} FROM items WHERE item_id=?`, [itemID]);
  return rows.length > 0 ? rows[0] : null;
}

/** 解密 articles.body_md（对齐 store.decText 与 derived.decArticleBody 的口径）。 */
function decBody(storeKey: Uint8Array | null, stored: string, itemID: string): string {
  if (storeKey === null) {
    if (stored.startsWith(ENC_PREFIX)) {
      throw new Error(`store: decrypt body_md ${itemID}: 无 store 密钥`);
    }
    return stored;
  }
  try {
    return decText(storeKey, stored);
  } catch (err) {
    throw new Error(`store: decrypt body_md ${itemID}: ${String(err)}`);
  }
}

const BADGE_WORDS = new Set(["活动", "悬赏", "推荐", "热门", "精华", "置顶", "辩论"]);
const TITLE_COLORS = new Set(["red", "orange", "green", "blue", "purple", "gray"]);

/** articleMarks（web.go:173-200）：只取 seq<0 的属性行，取值域封闭、域外静默丢弃。 */
function articleMarks(segs: Record<string, unknown>[]): { badges: string[]; titleColor: string } {
  const badges: string[] = [];
  const seen = new Set<string>();
  let titleColor = "";
  for (const s of segs) {
    if (Number(s.seq ?? 0) >= 0) continue;
    const kind = toStr(s.kind);
    if (kind === ATTR_BADGE) {
      for (const raw of toStr(s.text).split(",")) {
        const w = raw.trim();
        if (BADGE_WORDS.has(w) && !seen.has(w)) {
          seen.add(w);
          badges.push(w);
        }
      }
    } else if (kind === ATTR_TITLE_COLOR) {
      const v = toStr(s.text);
      if (TITLE_COLORS.has(v)) titleColor = v;
    }
  }
  badges.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { badges, titleColor };
}

/** decodeTags（web.go:222-231）：坏数据 / 非字符串数组一律返回空。 */
function decodeTags(tagsJSON: string): string[] {
  if (tagsJSON === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(tagsJSON);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const t of parsed) {
    if (typeof t !== "string") return [];
    out.push(t);
  }
  return out;
}

/** approvedTermSet（web.go:295-305）：读失败返回空集（有意的降级）。 */
function approvedTermSet(db: Db): Set<string> {
  try {
    const set = new Set<string>();
    for (const t of listApprovedDirectory(db)) set.add(t.kind + "\x00" + t.term_key);
    return set;
  } catch {
    return new Set();
  }
}

/** coverBlobID（web.go:203-209）：按 `<item_id>/cover` 取块；缺失或出错返回空串。 */
function coverBlobID(db: Db, itemID: string): string {
  try {
    const rows = db.select(`SELECT blob_id FROM blobs WHERE item_id=? ORDER BY seq ASC`, [
      itemID + "/cover",
    ]);
    return rows.length === 0 ? "" : toStr(rows[0].blob_id);
  } catch {
    return "";
  }
}

/** handleIndex 的取数组装（web.go:101-120）。 */
export function indexPageData(db: Db, deps: PortalDeps): PageData {
  const rows = db.select(
    `SELECT ${ITEM_COLUMNS} FROM items WHERE state=? ORDER BY item_id ASC`,
    ["active"],
  );
  const data: PageData = {
    Title: "内容目录",
    Issuer: deps.issuer,
    PairingCode: deps.pairingCode,
    Fingerprint: deps.fingerprintHex,
    Items: [],
  };
  for (const r of rows) {
    if (toStr(r.dist_class) !== "public" || toStr(r.type) !== "article") continue;
    data.Items!.push({
      ItemID: toStr(r.item_id),
      Type: toStr(r.type),
      Title: toStr(r.title),
      Rev: toStr(r.source_rev),
    });
  }
  return data;
}

/** handleArticlePage 的取数组装；条目护栏不过 → null（handler 侧 404 文章不存在）。 */
export function articlePageData(db: Db, deps: PortalDeps, itemID: string): PageData | null {
  const it = getItem(db, itemID);
  if (
    it === null ||
    toStr(it.type) !== "article" ||
    toStr(it.state) !== "active" ||
    toStr(it.dist_class) !== "public"
  ) {
    return null;
  }
  const artRows = db.select(
    `SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev FROM articles WHERE item_id=?`,
    [itemID],
  );
  if (artRows.length === 0) throw new PortalError(404, "文章正文不存在");
  const art = artRows[0];
  const bodyMd = decBody(deps.storeKey, toStr(art.body_md), itemID);
  // 属性行读失败不阻塞渲染，按空处理（web.go:144-147）。
  let segs: Record<string, unknown>[] = [];
  try {
    segs = db.select(
      `SELECT item_id,seq,kind,text,content_hash FROM segments WHERE item_id=? ORDER BY seq ASC`,
      [itemID],
    );
  } catch {
    segs = [];
  }
  const { badges, titleColor } = articleMarks(segs);
  const approved = approvedTermSet(db);
  const tagViews: PageTag[] = [];
  for (const name of decodeTags(toStr(art.tags_json))) {
    const key = normalizeTermKey(name);
    tagViews.push({ Name: name, Pending: key === null || !approved.has("tag\x00" + key) });
  }
  return {
    Title: toStr(art.title),
    Issuer: deps.issuer,
    PairingCode: deps.pairingCode,
    Fingerprint: deps.fingerprintHex,
    Article: {
      ItemID: toStr(art.item_id),
      Title: toStr(art.title),
      Digest: toStr(art.digest),
      PublishedAt: toStr(art.published_at),
      TagViews: tagViews,
      Body: new SafeHTML(renderMarkdown(bodyMd)),
      CoverBlobID: coverBlobID(db, itemID),
      Badges: badges,
      TitleColor: titleColor,
    },
  };
}

function governActionLabel(action: string): string {
  switch (action) {
    case "remove":
      return "下架";
    case "edit":
      return "改写";
    case "revive":
      return "复活";
    case "directory_add":
      return "新增词条";
    default:
      return action;
  }
}

function governStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "待决";
    case "effective":
      return "已生效";
    case "void":
      return "已作废";
    default:
      return status;
  }
}

function itemStateLabel(state: string): string {
  switch (state) {
    case "active":
      return "在架";
    case "removed":
      return "已下架";
    default:
      return "";
  }
}

/** formatMillis（web.go:284-290）：0 返回空串；否则按本机本地时区 `YYYY-MM-DD HH:mm`。 */
function formatMillis(ms: number): string {
  if (ms === 0) return "";
  const d = new Date(ms);
  const pad = (n: number): string => (n < 10 ? "0" + n : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ProfileNames(db, nil)：ids 为空 = 全部。 */
function profileNames(db: Db): Map<string, string> {
  const rows = db.select(`SELECT id,name FROM profiles`);
  const out = new Map<string, string>();
  for (const r of rows) out.set(toStr(r.id), toStr(r.name));
  return out;
}

/** proposalPageRow（web.go:347-389）。 */
function proposalPageRow(db: Db, v: ProposalView, names: Map<string, string>): PageProposal {
  const row: PageProposal = {
    Action: v.action,
    ActionLabel: governActionLabel(v.action),
    ItemID: v.itemId,
    Title: v.itemId, // 缺条目或非公开时回退显示 item_id（册子 §7.3 护栏 1）
    TermName: "",
    TermPending: false,
    Linkable: false,
    ItemState: "",
    ItemStateLabel: "",
    Reason: v.reason,
    VoteCount: v.voterCount,
    Threshold: v.threshold,
    Percent: 0,
    Status: v.status,
    StatusLabel: governStatusLabel(v.status),
    CreatedAt: formatMillis(v.createdAt),
    Voters: [],
  };
  if (row.Threshold > 0) {
    row.Percent = Math.trunc((row.VoteCount * 100) / row.Threshold);
    if (row.Percent > 100) row.Percent = 100;
  }
  for (const id of v.votes) {
    row.Voters.push({ ID: id, Name: nameOrShortID(names.get(id) ?? "", id), Count: 0 });
  }
  if (v.action === "edit") {
    row.Edit = { Title: v.title, BodyMD: v.bodyMd };
  }
  if (v.action === "directory_add") {
    row.TermName = cleanDisplayName(v.title);
    row.TermPending = v.status === "pending";
  }
  // 两条可见性护栏（册子 §7.3）：标题只在 public 时显示；链接只挂 active + public。
  let it: Record<string, unknown> | null = null;
  try {
    it = getItem(db, v.itemId);
  } catch {
    it = null;
  }
  if (it !== null) {
    const state = toStr(it.state);
    row.ItemState = state;
    row.ItemStateLabel = itemStateLabel(state);
    if (toStr(it.dist_class) === "public") {
      row.Title = toStr(it.title);
      row.Linkable = state === "active";
    }
  }
  return row;
}

/** handleGovernancePage 的取数组装（web.go:311-344）。 */
export function governancePageData(db: Db, deps: PortalDeps): PageData {
  const { set: rosterSet, ok: rosterOK } = governRoster(db, deps.storeKey);
  const views = listProposalViews(db, deps.storeKey, rosterSet);
  const names = profileNames(db);
  const data: PageData = {
    Title: "治理看板",
    Issuer: deps.issuer,
    PairingCode: deps.pairingCode,
    Fingerprint: deps.fingerprintHex,
    RosterReady: rosterOK,
    RemoveThreshold: governThreshold("remove"),
    EditThreshold: governThreshold("edit"),
    Roster: [],
    Proposals: [],
  };
  // 名册派生失败跳过（保持空数组），与接口侧降级口径一致（web.go:334-338）。
  try {
    for (const c of contributorRoster(db, deps.storeKey)) {
      data.Roster!.push({ ID: c.id, Name: nameOrShortID(names.get(c.id) ?? "", c.id), Count: c.count });
    }
  } catch {
    // 忽略：名册保持 []
  }
  // ListProposalViews 按 proposal_id 升序返回；这里纯展示反转（新提案在前）。
  for (let i = views.length - 1; i >= 0; i--) {
    data.Proposals!.push(proposalPageRow(db, views[i], names));
  }
  return data;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** GET /（web.go:101-120）。 */
export function indexPageHandler(deps: PortalDeps): ServerHandler {
  return async () => {
    try {
      return htmlResponse(renderPortalPage("index", indexPageData(deps.db, deps)));
    } catch (err) {
      return jsonResponse(500, { error: errorMessage(err) });
    }
  };
}

/** GET /a/{item_id...}（web.go:123-168）。 */
export function articlePageHandler(deps: PortalDeps): ServerHandler {
  return async (req) => {
    try {
      const data = articlePageData(deps.db, deps, req.params.item_id ?? "");
      if (data === null) return jsonResponse(404, { error: "文章不存在" });
      return htmlResponse(renderPortalPage("article", data));
    } catch (err) {
      if (err instanceof PortalError) return jsonResponse(err.status, { error: err.message });
      return jsonResponse(500, { error: errorMessage(err) });
    }
  };
}

/** GET /governance（web.go:311-344）。 */
export function governancePageHandler(deps: PortalDeps): ServerHandler {
  return async () => {
    try {
      return htmlResponse(renderPortalPage("governance", governancePageData(deps.db, deps)));
    } catch (err) {
      return jsonResponse(500, { error: errorMessage(err) });
    }
  };
}
