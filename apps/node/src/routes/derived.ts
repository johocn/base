// 治理派生与公开读面共用的只读逻辑：逐行对齐 internal/store 的 contributor.go /
// directory.go / govern.go 的读路径，以及 internal/httpapi/identity.go 的 ipLimiter 令牌桶。
// 只做 `db.select` 读，不写库、不进事务（对齐 Go 的「派生值不落表」口径）。
import { sha256Hex, utf8 } from "@base/protocol-ts";
import type { Db } from "../db";
import { ENC_PREFIX, decText } from "../host/aesgcm";

// —— 质量门槛与名册截断（治理册 §4.3/§4.4，contributor.go:10-16） ——
export const ARTICLE_MIN_RUNES = 200;
export const VIDEO_MIN_SECONDS = 60;
export const QUIZ_MIN_QUESTIONS = 3;
export const ROSTER_TOP_N = 10;

// —— 治理动作 / 状态 / 门槛（govern.go:14-39） ——
export const GOVERN_ACTION_REMOVE = "remove";
export const GOVERN_ACTION_DIRECTORY_ADD = "directory_add";
export const GOVERN_STATUS_PENDING = "pending";
const GOVERN_REMOVE_THRESHOLD = 3;
const GOVERN_DEFAULT_THRESHOLD = 2;
const DIRECTORY_ADD_QUORUM = 2;
const DIRECTORY_SMALL_NODE_ROSTER_MAX = 10;

// —— 目录（directory.go:24-33） ——
const DIRECTORY_STATE_APPROVED = "approved";
const META_DIRECTORY_VERSION = "directory_version";

// —— 目录 kind 三值 / 词条键上限（directory.go:17-30） ——
export const DIRECTORY_KIND_CATEGORY = "category";
export const DIRECTORY_KIND_INSTRUCTOR = "instructor";
export const DIRECTORY_KIND_TAG = "tag";
export const TERM_KEY_MAX_RUNES = 64;

// —— 校验常量（httpapi/govern.go:28-29、submit.go:36） ——
const MAX_PROPOSAL_REASON_RUNES = 200;
export const MAX_TITLE_RUNES = 200;

// —— 治理面 IP 限速常量（httpapi/govern.go:19-26） ——
export const GOVERN_PER_MINUTE_PER_IP = 60;
export const GOVERN_BURST_PER_IP = 20;

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

export function toStr(value: unknown): string {
  return value == null ? "" : String(value);
}

export function placeholders(n: number): string {
  return Array(n).fill("?").join(",");
}

/** 对齐 strconv.ParseInt(s,10,64)：可选符号 + 十进制整数，越界即 null。 */
export function parseGoInt64(raw: string): number | null {
  if (!/^[+-]?[0-9]+$/.test(raw)) return null;
  let v: bigint;
  try {
    v = BigInt(raw);
  } catch {
    return null;
  }
  if (v < INT64_MIN || v > INT64_MAX) return null;
  return Number(v);
}

/** 64 位平台上 strconv.Atoi 即 ParseInt(s,10,64)。 */
export const parseGoInt = parseGoInt64;

/** 对齐 isHexN（identity.go:50-56）：长度恰为 2n 且全为十六进制（大小写皆可）。 */
export function isHexN(s: string, n: number): boolean {
  return s.length === n * 2 && /^[0-9a-fA-F]*$/.test(s);
}

/** 对齐 isHexNonEmptyEven（identity.go:58-64）：非空、偶数长度、全十六进制。 */
export function isHexNonEmptyEven(s: string): boolean {
  return s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(s);
}

/** 对齐 onlyKeys（govern_event.go:29-36）：m 的键是否全在允许集内。 */
export function onlyKeys(m: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const k of Object.keys(m)) {
    if (!allowed.has(k)) return false;
  }
  return true;
}

/**
 * 对齐 jsonInt（group.go:304-318）：把 body 里的数字读成 int64。
 * Go 有 float64 与 json.Number 两分支；Node 的 JSON.parse 只产出 number（float64 等价），
 * 故只需 number 分支：非整数、或越 int64 范围即 false。
 */
export function jsonInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  const b = BigInt(v);
  if (b < INT64_MIN || b > INT64_MAX) return null;
  return Number(b);
}

/** 对齐 unicode.IsSpace 的 White_Space 口径（不是 JS 的 `\s`）。 */
function isGoSpace(r: number): boolean {
  if (r <= 0xff) {
    return (
      r === 0x09 ||
      r === 0x0a ||
      r === 0x0b ||
      r === 0x0c ||
      r === 0x0d ||
      r === 0x20 ||
      r === 0x85 ||
      r === 0xa0
    );
  }
  return (
    r === 0x1680 ||
    (r >= 0x2000 && r <= 0x200a) ||
    r === 0x2028 ||
    r === 0x2029 ||
    r === 0x202f ||
    r === 0x205f ||
    r === 0x3000
  );
}

/** 去掉全部空白后的字符数（rune 计，contributor.go:51-60）。 */
export function countNonSpaceRunes(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (!isGoSpace(ch.codePointAt(0) as number)) n++;
  }
  return n;
}

export interface Contributor {
  id: string;
  count: number;
}

interface Candidate {
  itemId: string;
  authorId: string;
  type: string; // article | video | quiz（其余载体不计贡献）
  bodyMd: string; // type == article
  durationSeconds: number; // type == video
  questionCount: number; // type == quiz
}

/** meetsQualityGate（contributor.go:35-48）。 */
function meetsQualityGate(c: Candidate): boolean {
  switch (c.type) {
    case "article":
      return countNonSpaceRunes(c.bodyMd) >= ARTICLE_MIN_RUNES;
    case "video":
      return c.durationSeconds >= VIDEO_MIN_SECONDS;
    case "quiz":
      return c.questionCount >= QUIZ_MIN_QUESTIONS;
    default:
      return false;
  }
}

/** deriveRoster（contributor.go:64-86）：空归属与未达门槛跳过；条数降序 + author_id 升序；取前 10。 */
function deriveRoster(cands: Candidate[]): Contributor[] {
  const counts = new Map<string, number>();
  for (const c of cands) {
    if (c.authorId === "" || !meetsQualityGate(c)) continue;
    counts.set(c.authorId, (counts.get(c.authorId) ?? 0) + 1);
  }
  const out: Contributor[] = [];
  for (const [id, count] of counts) out.push({ id, count });
  out.sort((a, b) => (a.count !== b.count ? b.count - a.count : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.length > ROSTER_TOP_N ? out.slice(0, ROSTER_TOP_N) : out;
}

/** 对齐 ListArticles 的解密口径（store.go:509-515）：解密失败即整表失败。 */
function decArticleBody(storeKey: Uint8Array | null, stored: string, itemId: string): string {
  if (storeKey === null) {
    // 无密钥（dataDir 未提供）：仅历史明文行可读，加密列按解密失败口径抛出。
    if (stored.startsWith(ENC_PREFIX)) throw new Error(`store: decrypt body_md ${itemId}: 无 store 密钥`);
    return stored;
  }
  try {
    return decText(storeKey, stored);
  } catch (err) {
    throw new Error(`store: decrypt body_md ${itemId}: ${String(err)}`);
  }
}

/** 把候选条目按载体系补齐度量（ContributorRoster / restoredRosterAuthors 共用的那段）。 */
function fillCandidateMetrics(
  db: Db,
  storeKey: Uint8Array | null,
  cands: Candidate[],
  index: Map<string, number>,
): void {
  const articleIds: string[] = [];
  const videoIds: string[] = [];
  const quizIds: string[] = [];
  for (const c of cands) {
    if (c.type === "article") articleIds.push(c.itemId);
    else if (c.type === "video") videoIds.push(c.itemId);
    else if (c.type === "quiz") quizIds.push(c.itemId);
  }

  // 注意：ListArticles / ListQuizzes / ListMediaDurations 的「ids 为空 = 全部」语义，
  // 在无该类载体时必须整个跳过（contributor.go:120-122）。
  if (articleIds.length > 0) {
    const rows = db.select(
      `SELECT item_id,body_md FROM articles WHERE item_id IN (${placeholders(articleIds.length)})`,
      articleIds,
    );
    for (const r of rows) {
      const itemId = toStr(r.item_id);
      const i = index.get(itemId);
      if (i !== undefined) cands[i].bodyMd = decArticleBody(storeKey, toStr(r.body_md), itemId);
    }
  }
  if (quizIds.length > 0) {
    const rows = db.select(
      `SELECT item_id,question_json FROM quizzes WHERE item_id IN (${placeholders(quizIds.length)})`,
      quizIds,
    );
    for (const r of rows) {
      const i = index.get(toStr(r.item_id));
      if (i === undefined) continue;
      let count = 0;
      // 题组 JSON 不可解析即计 0 题 → 未达门槛 → 跳过，不中断整张名册（contributor.go:146-149）。
      try {
        const doc = JSON.parse(toStr(r.question_json)) as { questions?: unknown };
        if (doc !== null && typeof doc === "object" && Array.isArray(doc.questions)) {
          count = doc.questions.length;
        }
      } catch {
        count = 0;
      }
      cands[i].questionCount = count;
    }
  }
  if (videoIds.length > 0) {
    const rows = db.select(
      `SELECT item_id,duration FROM media_meta WHERE item_id IN (${placeholders(videoIds.length)})`,
      videoIds,
    );
    for (const r of rows) {
      const i = index.get(toStr(r.item_id));
      if (i !== undefined) cands[i].durationSeconds = Number(r.duration ?? 0);
    }
  }
}

function gatherRosterCandidates(rows: Record<string, unknown>[]): {
  cands: Candidate[];
  index: Map<string, number>;
} {
  const cands: Candidate[] = [];
  const index = new Map<string, number>();
  for (const r of rows) {
    const c: Candidate = {
      itemId: toStr(r.item_id),
      authorId: toStr(r.author_id),
      type: toStr(r.type),
      bodyMd: "",
      durationSeconds: 0,
      questionCount: 0,
    };
    index.set(c.itemId, cands.length);
    cands.push(c);
  }
  return { cands, index };
}

/** ContributorRoster（contributor.go:88-164）：只看 state='active' AND author_id<>''。 */
export function contributorRoster(db: Db, storeKey: Uint8Array | null): Contributor[] {
  const rows = db.select(
    `SELECT item_id,author_id,type FROM items WHERE state='active' AND author_id<>'' ORDER BY item_id ASC`,
  );
  const { cands, index } = gatherRosterCandidates(rows);
  fillCandidateMetrics(db, storeKey, cands, index);
  return deriveRoster(cands);
}

/** restoredRosterAuthors（govern.go:179-258）：水位之后才退役且当前仍达门槛的作者集合。 */
export function restoredRosterAuthors(
  db: Db,
  storeKey: Uint8Array | null,
  revokedRev: number,
): Set<string> {
  const rows = db.select(
    `SELECT item_id,author_id,type FROM items
      WHERE author_id<>'' AND state<>'active'
        AND EXISTS(SELECT 1 FROM tombstones t WHERE t.item_id=items.item_id AND t.revoked_rev>?)
      ORDER BY item_id ASC`,
    [revokedRev],
  );
  const { cands, index } = gatherRosterCandidates(rows);
  fillCandidateMetrics(db, storeKey, cands, index);
  const set = new Set<string>();
  for (const c of deriveRoster(cands)) set.add(c.id);
  return set;
}

/** GovernThreshold（govern.go:42-50）。 */
export function governThreshold(action: string): number {
  if (action === GOVERN_ACTION_REMOVE) return GOVERN_REMOVE_THRESHOLD;
  if (action === GOVERN_ACTION_DIRECTORY_ADD) return DIRECTORY_ADD_QUORUM;
  return GOVERN_DEFAULT_THRESHOLD;
}

/** GovernThresholdForRoster（govern.go:54-59）。 */
export function governThresholdForRoster(
  action: string,
  rosterLen: number,
  rosterReady: boolean,
): number {
  if (action === GOVERN_ACTION_DIRECTORY_ADD && rosterReady && rosterLen < DIRECTORY_SMALL_NODE_ROSTER_MAX) {
    return 1;
  }
  return governThreshold(action);
}

/** ProposalStatus（govern.go:70-79）。 */
export function proposalStatus(executedAt: number, voidedAt: number): string {
  if (executedAt !== 0) return "effective";
  if (voidedAt !== 0) return "void";
  return "pending";
}

/** proposalVotersExec（govern.go:128-143）：按 voter_id 升序读某提案的全部投票人（未过滤名册）。 */
function proposalVoters(db: Db, proposalId: number): string[] {
  const rows = db.select(
    `SELECT voter_id FROM govern_votes WHERE proposal_id=? ORDER BY voter_id ASC`,
    [proposalId],
  );
  return rows.map((r) => toStr(r.voter_id));
}

/** filterRosterAtWatermarkSet（govern.go:169-177）：roster ∪ restored。 */
export function filterRosterAtWatermarkSet(
  ids: string[],
  roster: Set<string>,
  restored: Set<string>,
): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (roster.has(id) || restored.has(id)) out.push(id);
  }
  return out;
}

// 只选读路径用到的列（对齐 proposalColumns 的取值口径；links_json 等与目录派生无关）。
const PROPOSAL_COLUMNS = `proposal_id,action,item_id,proposer_id,reason,title,body_md,created_at,executed_at,voided_at,revoked_rev`;

export interface ProposalView {
  proposalId: number;
  action: string;
  itemId: string;
  proposerId: string;
  reason: string;
  title: string;
  bodyMd: string;
  createdAt: number;
  status: string;
  votes: string[];
  threshold: number;
  revokedRev: number;
}

/** ListProposalViews（govern.go:385-427）：按 proposal_id 升序，票按快照水位复判过滤。 */
export function listProposalViews(
  db: Db,
  storeKey: Uint8Array | null,
  roster: Set<string>,
): ProposalView[] {
  const rows = db.select(`SELECT ${PROPOSAL_COLUMNS} FROM govern_proposals ORDER BY proposal_id ASC`);
  // Go 单连接池要求「先读尽提案行再逐条取票」；Node 的 select 无此约束，仍按同序读取，口径一致。
  const proposals = rows.map((r) => ({
    proposalId: Number(r.proposal_id ?? 0),
    action: toStr(r.action),
    itemId: toStr(r.item_id),
    proposerId: toStr(r.proposer_id),
    reason: toStr(r.reason),
    title: toStr(r.title),
    bodyMd: toStr(r.body_md),
    createdAt: Number(r.created_at ?? 0),
    executedAt: Number(r.executed_at ?? 0),
    voidedAt: Number(r.voided_at ?? 0),
    revokedRev: Number(r.revoked_rev ?? 0),
  }));
  const out: ProposalView[] = [];
  for (const p of proposals) {
    const voters = proposalVoters(db, p.proposalId);
    const restored = restoredRosterAuthors(db, storeKey, p.revokedRev);
    out.push({
      proposalId: p.proposalId,
      action: p.action,
      itemId: p.itemId,
      proposerId: p.proposerId,
      reason: p.reason,
      title: p.title,
      bodyMd: p.bodyMd,
      createdAt: p.createdAt,
      status: proposalStatus(p.executedAt, p.voidedAt),
      votes: filterRosterAtWatermarkSet(voters, roster, restored),
      threshold: governThreshold(p.action),
      revokedRev: p.revokedRev,
    });
  }
  return out;
}

/**
 * governRoster（httpapi/govern.go:84-95）：派生失败按空名册降级、ok=false（fail-closed 不豁免）。
 */
export function governRoster(
  db: Db,
  storeKey: Uint8Array | null,
): { set: Set<string>; ok: boolean } {
  try {
    const rows = contributorRoster(db, storeKey);
    return { set: new Set(rows.map((c) => c.id)), ok: true };
  } catch {
    return { set: new Set(), ok: false };
  }
}

/** DirectoryVersion（directory.go:199-213）：meta 缺省视为 0；坏值即报错。 */
export function directoryVersion(db: Db): number {
  const rows = db.select(`SELECT value FROM meta WHERE key=?`, [META_DIRECTORY_VERSION]);
  if (rows.length === 0) return 0;
  const raw = toStr(rows[0].value);
  const n = parseGoInt64(raw);
  if (n === null) throw new Error(`store: bad directory_version ${JSON.stringify(raw)}`);
  return n;
}

export interface ApprovedTerm {
  kind: string;
  term_key: string;
  display_name: string;
}

/** ListDirectory 的第一个返回值（directory.go:175-196）：只取 approved 行，按 (kind,term_key) 升序。 */
export function listApprovedDirectory(db: Db): ApprovedTerm[] {
  const rows = db.select(
    `SELECT kind,term_key,display_name,state,first_author_id,created_at,updated_at
      FROM directory_terms ORDER BY kind ASC, term_key ASC`,
  );
  const out: ApprovedTerm[] = [];
  for (const r of rows) {
    if (toStr(r.state) !== DIRECTORY_STATE_APPROVED) continue;
    out.push({ kind: toStr(r.kind), term_key: toStr(r.term_key), display_name: toStr(r.display_name) });
  }
  return out;
}

/** DirectoryKindOfItemID（directory.go:143-149）：item_id = dir/<kind>/<hash16>。 */
export function directoryKindOfItemId(itemId: string): string | null {
  const parts = itemId.split("/");
  if (parts.length !== 3 || parts[0] !== "dir" || parts[1] === "" || parts[2] === "") return null;
  return parts[1];
}

interface Bucket {
  tokens: number;
  last: number;
}

/**
 * ipLimiter（httpapi/identity.go:288-344）的逐行复刻：极简令牌桶。
 * rate = perMinute/60 令牌/秒；burst 为桶容量；10 分钟无活动的桶被清扫。
 */
export class IpLimiter {
  private readonly rate: number;
  private readonly burst: number;
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  constructor(perMinute: number, burst: number) {
    this.rate = perMinute / 60;
    this.burst = burst;
  }

  allow(ip: string): boolean {
    const now = Date.now();
    this.sweepLocked(now);
    let b = this.buckets.get(ip);
    if (b === undefined) {
      b = { tokens: this.burst, last: now };
      this.buckets.set(ip, b);
    }
    b.tokens += ((now - b.last) / 1000) * this.rate;
    if (b.tokens > this.burst) b.tokens = this.burst;
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private sweepLocked(now: number): void {
    if (now - this.lastSweep < 10 * 60 * 1000) return;
    this.lastSweep = now;
    for (const [ip, b] of this.buckets) {
      if (now - b.last > 10 * 60 * 1000) this.buckets.delete(ip);
    }
  }
}

/** nameOrShortID（web.go:274-282）：与 GET /v1/contributors 同口径，缺昵称回退 id 前 8 位。 */
export function nameOrShortID(name: string, id: string): string {
  if (name !== "") return name;
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** 对应 Go `strings.TrimSpace`：去首尾 Go 空白（按 code point 迭代，不拆代理对）。 */
export function trimGoSpace(s: string): string {
  const rs = [...s];
  let i = 0;
  let j = rs.length;
  while (i < j && isGoSpace(rs[i].codePointAt(0) as number)) i++;
  while (j > i && isGoSpace(rs[j - 1].codePointAt(0) as number)) j--;
  return rs.slice(i, j).join("");
}

/** collapseSpaces（directory.go:85-101）：连续 Go 空白折叠为单个半角空格。 */
function collapseGoSpaces(s: string): string {
  let out = "";
  let prevSpace = false;
  for (const ch of s) {
    if (isGoSpace(ch.codePointAt(0) as number)) {
      if (!prevSpace) {
        out += " ";
        prevSpace = true;
      }
      continue;
    }
    out += ch;
    prevSpace = false;
  }
  return out;
}

/** stripControl（directory.go:117-...）：剥离控制字符 U+0000–U+001F 与 U+007F。 */
function stripControlChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp <= 0x1f || cp === 0x7f) continue;
    out += ch;
  }
  return out;
}

/** CleanDisplayName（directory.go:63-65）：stripControl(collapseSpaces(TrimSpace(raw)))，不做全角/大小写折叠。 */
export function cleanDisplayName(raw: string): string {
  return stripControlChars(collapseGoSpaces(trimGoSpace(raw)));
}

/** foldFullWidthASCII（directory.go:69-83）：全角可见字符 U+FF01..U+FF5E 折半角，全角空格 U+3000 折半角空格。 */
function foldFullWidthASCII(s: string): string {
  let out = "";
  for (const ch of s) {
    const r = ch.codePointAt(0) as number;
    if (r >= 0xff01 && r <= 0xff5e) out += String.fromCodePoint(r - 0xfee0);
    else if (r === 0x3000) out += " ";
    else out += ch;
  }
  return out;
}

/** foldASCIILower（directory.go:105-115）：只折 ASCII 大写字母，非 ASCII 不动。 */
function foldASCIILower(s: string): string {
  let out = "";
  for (const ch of s) {
    const r = ch.codePointAt(0) as number;
    out += r >= 0x41 && r <= 0x5a ? String.fromCodePoint(r + 0x20) : ch;
  }
  return out;
}

/**
 * NormalizeTermKey（directory.go:50-60）：TrimSpace → 全角折半角 → 空白折叠 → ASCII 小写 → 剥离控制字符
 * → rune 长度 1..64。非法返回 null。
 */
export function normalizeTermKey(raw: string): string | null {
  let s = foldFullWidthASCII(trimGoSpace(raw));
  s = collapseGoSpaces(s);
  s = foldASCIILower(s);
  s = stripControlChars(s);
  const n = [...s].length;
  if (n < 1 || n > TERM_KEY_MAX_RUNES) return null;
  return s;
}

/** DirectoryPayloadHash（directory.go:132-134）：sha256("dir\0"+kind+"\0"+termKey) 的 64 hex。 */
export function directoryPayloadHash(kind: string, termKey: string): string {
  return sha256Hex(utf8("dir\x00" + kind + "\x00" + termKey));
}

/** DirectoryProposalItemID（directory.go:138-140）：dir/<kind>/<hash16>。 */
export function directoryProposalItemId(kind: string, termKey: string): string {
  return "dir/" + kind + "/" + directoryPayloadHash(kind, termKey).slice(0, 16);
}

/** validDirectoryKind（govern.go:42-48）：kind ∈ 三值。 */
export function validDirectoryKind(k: string): boolean {
  return (
    k === DIRECTORY_KIND_CATEGORY || k === DIRECTORY_KIND_INSTRUCTOR || k === DIRECTORY_KIND_TAG
  );
}

/** hasControlChars（govern.go:51-58）：含 U+0000–U+001F 或 U+007F。 */
export function hasControlChars(s: string): boolean {
  for (const ch of s) {
    const r = ch.codePointAt(0) as number;
    if (r <= 0x1f || r === 0x7f) return true;
  }
  return false;
}

/**
 * validProposalReason（govern.go:62-69）：去首尾空白后 1..200 rune 且不含控制字符。
 * 返回去空白后的存储值；ok=false 表示「已给定但不合规」。
 */
export function validProposalReason(raw: string): { value: string; ok: boolean } {
  const s = trimGoSpace(raw);
  const n = [...s].length;
  if (n < 1 || n > MAX_PROPOSAL_REASON_RUNES) return { value: "", ok: false };
  return { value: s, ok: !hasControlChars(s) };
}

/**
 * validItemTitle（submit.go:126-137）：去首尾空白后 1..200 rune，且**原串**不含控制字符
 * （控制字符判定走原串，与 reason 的「trim 后」口径不同，逐字照抄）。
 */
export function validItemTitle(title: string): boolean {
  const n = [...trimGoSpace(title)].length;
  if (n < 1 || n > MAX_TITLE_RUNES) return false;
  return !hasControlChars(title);
}

/** parseProposalID（govern.go:72-78）：十进制正整数（ParseInt64 且 >0）。 */
export function parseProposalId(raw: string): number | null {
  const n = parseGoInt64(raw);
  if (n === null || n <= 0) return null;
  return n;
}
