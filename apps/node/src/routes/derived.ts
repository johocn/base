// 治理派生与公开读面共用的只读逻辑：逐行对齐 internal/store 的 contributor.go /
// directory.go / govern.go 的读路径，以及 internal/httpapi/identity.go 的 ipLimiter 令牌桶。
// 只做 `db.select` 读，不写库、不进事务（对齐 Go 的「派生值不落表」口径）。
import { sha256Hex, utf8 } from "@base/protocol-ts";
import type { Db } from "../db";
import { ENC_PREFIX, decText } from "../host/aesgcm";

// —— 质量门槛与名册截断（治理册 §4.3/§4.4，contributor.go:10-20） ——
export const ARTICLE_MIN_RUNES = 200;
export const VIDEO_MIN_SECONDS = 60;
export const QUIZ_MIN_QUESTIONS = 3;
export const LESSON_MIN_ITEMS = 1;
export const COURSE_MIN_LESSONS = 3;
export const ROSTER_TOP_N = 10;

// —— 治理动作 / 状态 / 门槛（govern.go:14-39） ——
export const GOVERN_ACTION_REMOVE = "remove";
export const GOVERN_ACTION_REVIVE = "revive";
export const GOVERN_ACTION_EDIT = "edit";
export const GOVERN_ACTION_DIRECTORY_ADD = "directory_add";
// Spec v2 §3 新增细粒度动作
export const GOVERN_ACTION_EDIT_TITLE = "edit_title";
export const GOVERN_ACTION_EDIT_BODY = "edit_body";
export const GOVERN_ACTION_EDIT_CATEGORY = "edit_category";
export const GOVERN_ACTION_EDIT_TAGS = "edit_tags";
export const GOVERN_ACTION_EDIT_INSTRUCTOR = "edit_instructor";
// Spec v2 §3 新增 pin_level 系列（治理层给条目分级，enhanced 门槛）
export const GOVERN_ACTION_HIGHLIGHT = "highlight";
export const GOVERN_ACTION_PIN = "pin";
export const GOVERN_ACTION_RECOMMEND = "recommend";
export const GOVERN_ACTION_FEATURE = "feature";
export const GOVERN_STATUS_PENDING = "pending";
const GOVERN_REMOVE_THRESHOLD = 3;
const GOVERN_DEFAULT_THRESHOLD = 2;
const DIRECTORY_ADD_QUORUM = 2;
export const DIRECTORY_SMALL_NODE_ROSTER_MAX = 10;

// —— 目录（directory.go:24-33） ——
export const DIRECTORY_STATE_APPROVED = "approved";
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

// —— 治理写面按身份限速常量（httpapi/govern.go:21-24） ——
export const PROPOSAL_PER_MINUTE_PER_ID = 6;
export const PROPOSAL_BURST_PER_ID = 3;
export const VOTE_PER_MINUTE_PER_ID = 20;
export const VOTE_BURST_PER_ID = 10;

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
  type: string; // article | video | quiz | lesson | course
  bodyMd: string; // type == article
  durationSeconds: number; // type == video
  questionCount: number; // type == quiz
  childPassedCount: number; // type == lesson：达标子项数
  childPassedLessons: number; // type == course：达标课时数
}

/** meetsQualityGate（contributor.go:35-62）。 */
function meetsQualityGate(c: Candidate): boolean {
  switch (c.type) {
    case "article":
      return countNonSpaceRunes(c.bodyMd) >= ARTICLE_MIN_RUNES;
    case "video":
      return c.durationSeconds >= VIDEO_MIN_SECONDS;
    case "quiz":
      return c.questionCount >= QUIZ_MIN_QUESTIONS;
    case "lesson":
      return c.childPassedCount >= LESSON_MIN_ITEMS;
    case "course":
      return c.childPassedLessons >= COURSE_MIN_LESSONS;
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
      childPassedCount: 0,
      childPassedLessons: 0,
    };
    index.set(c.itemId, cands.length);
    cands.push(c);
  }
  return { cands, index };
}

/** ContributorRoster（contributor.go:102-229）：只看 state='active' AND author_id<>''。
 * T5 扩展：新增 course / lesson 两类贡献载体，按「合并计 1」规则折叠父子。 */
export function contributorRoster(db: Db, storeKey: Uint8Array | null): Contributor[] {
  const rows = db.select(
    `SELECT item_id,author_id,type FROM items WHERE state='active' AND author_id<>'' ORDER BY item_id ASC`,
  );
  const { cands, index } = gatherRosterCandidates(rows);

  const courseIds: string[] = [];
  const lessonIds: string[] = [];
  const articleIds: string[] = [];
  const videoIds: string[] = [];
  const quizIds: string[] = [];
  for (const c of cands) {
    if (c.type === "course") courseIds.push(c.itemId);
    else if (c.type === "lesson") lessonIds.push(c.itemId);
    else if (c.type === "article") articleIds.push(c.itemId);
    else if (c.type === "video") videoIds.push(c.itemId);
    else if (c.type === "quiz") quizIds.push(c.itemId);
  }

  fillCandidateMetrics(db, storeKey, cands, index, articleIds, videoIds, quizIds);

  // T5：course / lesson 按合并计 1 规则装配候选度量。
  if (courseIds.length > 0 || lessonIds.length > 0) {
    computeContainerPassedTs(db, cands, index, courseIds, lessonIds);
  }

  // accumulateCounts + 合并计 1：article/video/quiz 直接计；lesson 父 course 达标则跳过；course 达标计 1。
  const counts = accumulateCountsTs(db, cands);
  const out: Contributor[] = [];
  for (const [id, n] of counts) out.push({ id, count: n });
  out.sort((a, b) => (a.count !== b.count ? b.count - a.count : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.length > ROSTER_TOP_N ? out.slice(0, ROSTER_TOP_N) : out;
}

/** fillCandidateMetrics（contributor.go:134-183）：article/video/quiz 度量补齐。
 * TS 版提供两种签名：显式传 ids（性能更佳），不传时内部从 cands 分类型扫描（兼容 restoredRosterAuthors）。 */
function fillCandidateMetrics(
  db: Db,
  storeKey: Uint8Array | null,
  cands: Candidate[],
  index: Map<string, number>,
  articleIds?: string[],
  videoIds?: string[],
  quizIds?: string[],
): void {
  const aIds = articleIds ?? cands.filter((c) => c.type === "article").map((c) => c.itemId);
  const vIds = videoIds ?? cands.filter((c) => c.type === "video").map((c) => c.itemId);
  const qIds = quizIds ?? cands.filter((c) => c.type === "quiz").map((c) => c.itemId);

  if (aIds.length > 0) {
    const rows = db.select(
      `SELECT item_id,body_md FROM articles WHERE item_id IN (${placeholders(aIds.length)})`,
      aIds,
    );
    for (const r of rows) {
      const itemId = toStr(r.item_id);
      const i = index.get(itemId);
      if (i !== undefined) cands[i].bodyMd = decArticleBody(storeKey, toStr(r.body_md), itemId);
    }
  }
  if (qIds.length > 0) {
    const rows = db.select(
      `SELECT item_id,question_json FROM quizzes WHERE item_id IN (${placeholders(qIds.length)})`,
      qIds,
    );
    for (const r of rows) {
      const i = index.get(toStr(r.item_id));
      if (i === undefined) continue;
      let count = 0;
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
  if (vIds.length > 0) {
    const rows = db.select(
      `SELECT item_id,duration FROM media_meta WHERE item_id IN (${placeholders(vIds.length)})`,
      vIds,
    );
    for (const r of rows) {
      const i = index.get(toStr(r.item_id));
      if (i !== undefined) cands[i].durationSeconds = Number(r.duration ?? 0);
    }
  }
}

/** computeContainerPassed（contributor.go:286-441）：反查 segments 批量计算 lesson→达标布尔 / course→达标布尔；回写到 Candidate。 */
function computeContainerPassedTs(
  db: Db,
  cands: Candidate[],
  index: Map<string, number>,
  courseIds: string[],
  lessonIds: string[],
): void {
  // courseLessons：course → lessonIDs[]（segments.item_id=course AND kind='lesson'）
  const courseLessons = new Map<string, string[]>();
  if (courseIds.length > 0) {
    const rows = db.select(
      `SELECT item_id,text FROM segments WHERE item_id IN (${placeholders(courseIds.length)}) AND seq>=1 AND kind='lesson' ORDER BY item_id ASC, seq ASC`,
      courseIds,
    );
    for (const r of rows) {
      const cid = toStr(r.item_id);
      const lid = toStr(r.text);
      const arr = courseLessons.get(cid) ?? [];
      arr.push(lid);
      courseLessons.set(cid, arr);
    }
  }

  // lessonChildren：lesson → [{kind, childId}]
  const lessonChildren = new Map<string, { kind: string; childId: string }[]>();
  if (lessonIds.length > 0) {
    const rows = db.select(
      `SELECT item_id,kind,text FROM segments WHERE item_id IN (${placeholders(lessonIds.length)}) AND seq>=1 AND kind IN ('article','video','quiz') ORDER BY item_id ASC, seq ASC`,
      lessonIds,
    );
    for (const r of rows) {
      const lid = toStr(r.item_id);
      const kind = toStr(r.kind);
      const cid = toStr(r.text);
      const arr = lessonChildren.get(lid) ?? [];
      arr.push({ kind, childId: cid });
      lessonChildren.set(lid, arr);
    }
  }

  // 收集所有子项 item_id 批量查 type。
  const childIDs = new Set<string>();
  for (const children of lessonChildren.values()) {
    for (const ch of children) childIDs.add(ch.childId);
  }
  const childType = new Map<string, string>();
  const childList = [...childIDs];
  if (childList.length > 0) {
    const rows = db.select(
      `SELECT item_id,type FROM items WHERE item_id IN (${placeholders(childList.length)})`,
      childList,
    );
    for (const r of rows) childType.set(toStr(r.item_id), toStr(r.type));
  }

  // 批量查子项 article body / quiz question_json / video duration。
  const articleBatch: string[] = [];
  const videoBatch: string[] = [];
  const quizBatch: string[] = [];
  for (const id of childList) {
    const t = childType.get(id);
    if (t === "article") articleBatch.push(id);
    else if (t === "video") videoBatch.push(id);
    else if (t === "quiz") quizBatch.push(id);
  }
  const articleBody = new Map<string, string>();
  if (articleBatch.length > 0) {
    const rows = db.select(
      `SELECT item_id,body_md FROM articles WHERE item_id IN (${placeholders(articleBatch.length)})`,
      articleBatch,
    );
    for (const r of rows) articleBody.set(toStr(r.item_id), toStr(r.body_md));
  }
  const quizCount = new Map<string, number>();
  if (quizBatch.length > 0) {
    const rows = db.select(
      `SELECT item_id,question_json FROM quizzes WHERE item_id IN (${placeholders(quizBatch.length)})`,
      quizBatch,
    );
    for (const r of rows) {
      let count = 0;
      try {
        const doc = JSON.parse(toStr(r.question_json)) as { questions?: unknown };
        if (doc !== null && typeof doc === "object" && Array.isArray(doc.questions)) {
          count = doc.questions.length;
        }
      } catch {
        count = 0;
      }
      quizCount.set(toStr(r.item_id), count);
    }
  }
  const videoDur = new Map<string, number>();
  if (videoBatch.length > 0) {
    const rows = db.select(
      `SELECT item_id,duration FROM media_meta WHERE item_id IN (${placeholders(videoBatch.length)})`,
      videoBatch,
    );
    for (const r of rows) videoDur.set(toStr(r.item_id), Number(r.duration ?? 0));
  }

  // 判定每个子项是否达标。
  const childPassed = new Map<string, boolean>();
  for (const id of childList) {
    const t = childType.get(id);
    let passed = false;
    if (t === "article") {
      passed = countNonSpaceRunes(articleBody.get(id) ?? "") >= ARTICLE_MIN_RUNES;
    } else if (t === "video") {
      passed = (videoDur.get(id) ?? 0) >= VIDEO_MIN_SECONDS;
    } else if (t === "quiz") {
      passed = (quizCount.get(id) ?? 0) >= QUIZ_MIN_QUESTIONS;
    }
    childPassed.set(id, passed);
  }

  // 判定每个 lesson 达标并回写。
  const lessonPassedCount = new Map<string, number>();
  const lessonPassed = new Map<string, boolean>();
  for (const [lessonId, children] of lessonChildren) {
    let n = 0;
    for (const ch of children) {
      if (childPassed.get(ch.childId)) n++;
    }
    lessonPassedCount.set(lessonId, n);
    if (n >= LESSON_MIN_ITEMS) lessonPassed.set(lessonId, true);
  }
  for (const c of cands) {
    if (c.type === "lesson") c.childPassedCount = lessonPassedCount.get(c.itemId) ?? 0;
  }

  // 判定每个 course 达标并回写。
  for (const [courseId, lessons] of courseLessons) {
    let n = 0;
    for (const l of lessons) {
      if (lessonPassed.get(l)) n++;
    }
    const i = index.get(courseId);
    if (i !== undefined && cands[i].type === "course") cands[i].childPassedLessons = n;
  }
}

/** accumulateCounts（contributor.go:236-282）：合并计 1 → author→count。 */
function accumulateCountsTs(db: Db, cands: Candidate[]): Map<string, number> {
  const coursePassed = new Map<string, boolean>();
  for (const c of cands) {
    if (c.type === "course") coursePassed.set(c.itemId, meetsQualityGate(c));
  }

  const allLessonIds: string[] = [];
  const lessonPassed = new Map<string, boolean>();
  for (const c of cands) {
    if (c.type === "lesson") {
      allLessonIds.push(c.itemId);
      lessonPassed.set(c.itemId, meetsQualityGate(c));
    }
  }

  // lesson→父 course（segments.text=lesson AND kind='lesson' → item_id=父 course）。
  const lessonCourse = new Map<string, string>();
  if (allLessonIds.length > 0) {
    const rows = db.select(
      `SELECT item_id,text FROM segments WHERE text IN (${placeholders(allLessonIds.length)}) AND kind='lesson' AND seq>=1`,
      allLessonIds,
    );
    for (const r of rows) {
      const cid = toStr(r.item_id);
      const lid = toStr(r.text);
      if (!lessonCourse.has(lid)) lessonCourse.set(lid, cid);
    }
  }

  const counts = new Map<string, number>();
  const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const c of cands) {
    if (c.authorId === "") continue;
    switch (c.type) {
      case "article":
      case "video":
      case "quiz":
        if (meetsQualityGate(c)) bump(c.authorId);
        break;
      case "lesson": {
        const parent = lessonCourse.get(c.itemId);
        if (parent && coursePassed.get(parent)) break; // 父 course 达标 → 跳过
        if (meetsQualityGate(c)) bump(c.authorId);
        break;
      }
      case "course":
        if (meetsQualityGate(c)) bump(c.authorId);
        break;
    }
  }
  return counts;
}

// ========= Spec v2 §2.4 DeriveContributionRoster（contributor.go:497-524） =========

/**
 * earliestRegisteredIDs（contributor.go:631-662）：取 identities 表里最早注册的 n 个身份 ID，排除 exclude 集合。
 * 返回数量可能 < n（identities 总数不足或表不存在）。
 */
export function earliestRegisteredIDs(db: Db, n: number, exclude: string[]): string[] {
  if (n <= 0) return [];
  const excludeSet = new Set(exclude);
  let q = `SELECT id FROM identities`;
  const args: unknown[] = [];
  if (excludeSet.size > 0) {
    q += ` WHERE id NOT IN (${placeholders(excludeSet.size)})`;
    args.push(...excludeSet);
  }
  q += ` ORDER BY created_at ASC LIMIT ?`;
  args.push(n);
  let rows: Record<string, unknown>[];
  try {
    rows = db.select(q, args);
  } catch {
    // identities 表不存在 → 返回空（与 Go 侧「零贡献者时前 10 注册身份全额生效」一致）
    return [];
  }
  return rows.map((r) => toStr(r.id));
}

/**
 * deriveContributionRoster 返回贡献层恒 10 人（治理重构 Spec v2 §2.4）：
 * 贡献者前 N（N ≤ 10，按贡献数降序 + author_id tiebreak）+ 初创期 ID 补齐到 10。
 * 零贡献者时前 10 注册身份全额生效；贡献者 ≥ 10 时初创期 ID 不出现。
 */
export function deriveContributionRoster(db: Db, storeKey: Uint8Array | null): { ids: string[]; contribSet: Set<string> } {
  const topN = contributorRoster(db, storeKey);
  const ids = topN.map((c) => c.id);
  const contribSet = new Set<string>(ids);

  if (ids.length < ROSTER_TOP_N) {
    const earliest = earliestRegisteredIDs(db, ROSTER_TOP_N - ids.length, ids);
    ids.push(...earliest);
  }

  const end = ids.length > ROSTER_TOP_N ? ROSTER_TOP_N : ids.length;
  ids.length = end;
  return { ids, contribSet };
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

// ========= Spec v2 §4 动态门槛公式 =========

/**
 * GovernThreshold（Spec v2 §4，govern.go:73-89）。
 * level: 'base' | 'enhanced'
 * m = 活跃 7 天用户数，P = 他人学习去重数，F = 他人收藏去重数。
 * base:     10 + ⌊m/3⌋ + ⌊(P+F)/3⌋
 * enhanced: 20 + ⌊m/3⌋ + ⌊2*(P+F)/3⌋
 * Go 整数除法对正数向零截断等于 ⌊x⌋，Node Math.floor 同。
 */
export function GovernThreshold(level: string, m: number, P: number, F: number): number {
  const mPrime = Math.floor(m / 3);
  if (level === "enhanced") {
    return 20 + mPrime + Math.floor((2 * (P + F)) / 3);
  }
  return 10 + mPrime + Math.floor((P + F) / 3);
}

/**
 * GovernQuorum（Spec v2 §4，govern.go:91-114）。
 * quorum = min(max(threshold, ⌈m/2⌉), m)
 * ⌈m/2⌉ = (m+1)/2 在整数域（对正数）。
 */
export function GovernQuorum(threshold: number, m: number): number {
  if (threshold <= 0) return 0;
  if (m <= 0) return threshold;
  const half = Math.floor((m + 1) / 2);
  if (threshold > half) {
    return threshold > m ? m : threshold;
  }
  return half > m ? m : half;
}

/** NetWeight（Spec v2 §4，govern.go:117-119）= approve_sum - reject_sum。 */
export function NetWeight(approveSum: number, rejectSum: number): number {
  return approveSum - rejectSum;
}

// ========= Spec v2 §6 governContextParams（govern.go:976-1055） =========

/** countActiveInIDs（govern.go:1024-1039）：给定 id 列表内活跃的独立身份数。 */
function countActiveInIDs(db: Db, ids: string[], cutoff: number): number {
  if (ids.length === 0) return 0;
  const rows = db.select(
    `SELECT COUNT(DISTINCT id) AS c FROM identities WHERE last_seen_at > ? AND id IN (${placeholders(ids.length)})`,
    [cutoff, ...ids],
  );
  return Number(rows[0]?.c ?? 0);
}

/** countItemInIDs（govern.go:1042-1055）：给定表 (progress / favorites) 中 item_id=? AND id!=proposer AND id IN (ids) 的去重 id 数。 */
function countItemInIDs(
  db: Db,
  table: "progress" | "favorites",
  itemId: string,
  proposerID: string,
  ids: string[],
): number {
  if (ids.length === 0) return 0;
  const rows = db.select(
    `SELECT COUNT(DISTINCT id) AS c FROM ${table} WHERE item_id=? AND id != ? AND id IN (${placeholders(ids.length)})`,
    [itemId, proposerID, ...ids],
  );
  return Number(rows[0]?.c ?? 0);
}

/** governNodeParams（govern.go:1012-1021）：节点级默认口径。容错：表不存在时 m/P/F 降级为 0。 */
function governNodeParams(db: Db, itemId: string, proposerId: string, now: number, sevenDaysMs: number): { m: number; P: number; F: number } {
  let m = 0;
  try {
    m = Number(
      db.select(`SELECT COUNT(DISTINCT id) AS c FROM identities WHERE last_seen_at > ?`, [
        now - sevenDaysMs,
      ])[0]?.c ?? 0,
    );
  } catch {
    m = 0;
  }
  let P = 0;
  let F = 0;
  if (itemId !== "") {
    try {
      P = Number(
        db.select(`SELECT COUNT(DISTINCT id) AS c FROM progress WHERE item_id=? AND id != ?`, [
          itemId,
          proposerId,
        ])[0]?.c ?? 0,
      );
    } catch {
      P = 0;
    }
    try {
      F = Number(
        db.select(`SELECT COUNT(DISTINCT id) AS c FROM favorites WHERE item_id=? AND id != ?`, [
          itemId,
          proposerId,
        ])[0]?.c ?? 0,
      );
    } catch {
      F = 0;
    }
  }
  return { m, P, F };
}

/**
 * governContextParams（govern.go:981-1008）：按提案语境查 V2 门槛公式的 m/P/F。
 * category='circle' + circle_id != "" → 圈内活跃成员 + 圈内成员对该 item 的互动；否则 → 节点级全局。
 * 容错：groups 表不存在/解析失败 → fallback 到节点级。
 */
export function governContextParams(
  db: Db,
  category: string,
  circleId: string,
  itemId: string,
  proposerId: string,
  now: number,
): { m: number; P: number; F: number } {
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  if (category === "circle" && circleId !== "") {
    try {
      const gRows = db.select(`SELECT member_ids_json FROM groups WHERE group_id=?`, [circleId]);
      if (gRows.length > 0) {
        let members: string[] = [];
        try {
          const raw = toStr(gRows[0].member_ids_json);
          if (raw !== "") {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) members = parsed.map((x) => String(x));
          }
        } catch {
          // fallback below
        }
        if (members.length > 0) {
          const m = countActiveInIDs(db, members, now - sevenDaysMs);
          let P = 0;
          let F = 0;
          if (itemId !== "") {
            P = countItemInIDs(db, "progress", itemId, proposerId, members);
            F = countItemInIDs(db, "favorites", itemId, proposerId, members);
          }
          return { m, P, F };
        }
      }
    } catch {
      // groups 表不存在 → fallback 到节点级
    }
  }
  return governNodeParams(db, itemId, proposerId, now, sevenDaysMs);
}

// ========= Spec v2 §3.5 免票选 shouldFreeExec（free_remove.go:22-...） =========

/** isCourseID（free_remove.go:60-63）。 */
function isCourseId(itemId: string): boolean {
  const parts = itemId.split("/");
  return parts.length === 2 && parts[0] === "course" && parts[1] !== "";
}

/** isLessonID（free_remove.go:66-69）。 */
function isLessonId(itemId: string): boolean {
  const parts = itemId.split("/");
  return (
    parts.length === 4 && parts[0] === "course" && parts[2] === "lesson" && parts[1] !== "" && parts[3] !== ""
  );
}

/** courseLessonIDs（free_remove.go:72-87）。 */
function courseLessonIds(db: Db, courseId: string): string[] {
  const rows = db.select(
    `SELECT text FROM segments WHERE item_id=? AND seq>=1 ORDER BY seq ASC`,
    [courseId],
  );
  return rows.map((r) => toStr(r.text));
}

/**
 * shouldFreeExec（free_remove.go:22-75）：判据 = 目录条款否 + 作者本人 + active + 无他人互动 (progress + favorites)。
 * 异常 fail-closed（返回 false + 错误，由上层退回正常投票路径）。
 */
export function shouldFreeExec(db: Db, itemId: string, proposerId: string, action: string): {
  free: boolean;
  err: Error | null;
} {
  // 目录条款永不免票选
  if (action === GOVERN_ACTION_DIRECTORY_ADD) return { free: false, err: null };
  // 读 author_id / state
  let rows: Record<string, unknown>[];
  try {
    rows = db.select(`SELECT author_id,state FROM items WHERE item_id=?`, [itemId]);
  } catch (e) {
    return { free: false, err: e as Error };
  }
  if (rows.length === 0) return { free: false, err: null };
  const authorId = toStr(rows[0].author_id);
  const state = toStr(rows[0].state);
  if (authorId === "" || authorId !== proposerId) return { free: false, err: null };
  if (state !== "active") return { free: false, err: null };

  // 构造 progress/favorites 查询范围
  const targets = [itemId];
  if (isCourseId(itemId)) {
    const lessons = courseLessonIds(db, itemId);
    targets.push(...lessons);
  }
  const ph = placeholders(targets.length);
  let P = 0;
  let F = 0;
  try {
    const pRows = db.select(
      `SELECT COUNT(DISTINCT id) AS n FROM progress WHERE item_id IN (${ph}) AND id<>?`,
      [...targets, proposerId],
    );
    P = Number(pRows[0]?.n ?? 0);
    const fRows = db.select(
      `SELECT COUNT(DISTINCT id) AS n FROM favorites WHERE item_id IN (${ph}) AND id<>?`,
      [...targets, proposerId],
    );
    F = Number(fRows[0]?.n ?? 0);
  } catch (e) {
    return { free: false, err: e as Error };
  }
  return { free: P === 0 && F === 0, err: null };
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
const PROPOSAL_COLUMNS = `proposal_id,action,item_id,proposer_id,reason,title,body_md,content_version,created_at,executed_at,voided_at,revoked_rev,COALESCE(governance_level,'base') AS governance_level,COALESCE(category,'') AS category,COALESCE(circle_id,'') AS circle_id`;

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
  executedAt: number;
  voidedAt: number;
  contentVersion: number;
  revokedRev: number;
  // Spec v2 字段
  governanceLevel: string;
  category: string;
  circleId: string;
  quorum: number;
  voterCount: number;
  approveWeight: number;
  rejectWeight: number;
  netWeight: number;
}

/** ListProposalViews（govern.go:385-427 + Spec v2）：按 proposal_id 升序，票按快照水位复判过滤。
 * V2：同时返回 quorum / voter_count / approve_weight / reject_weight / net_weight / governance_level / category / circle_id。 */
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
    contentVersion: Number(r.content_version ?? 0),
    revokedRev: Number(r.revoked_rev ?? 0),
    governanceLevel: toStr(r.governance_level) || "base",
    category: toStr(r.category),
    circleId: toStr(r.circle_id),
  }));
  const out: ProposalView[] = [];
  const now = Date.now();
  for (const p of proposals) {
    const voters = proposalVoters(db, p.proposalId);
    const restored = restoredRosterAuthors(db, storeKey, p.revokedRev);

    // V2 实时指标：语境化 m/P/F → Threshold → Quorum；独立 voter + 票权聚合
    const { m, P, F } = governContextParams(db, p.category, p.circleId, p.itemId, p.proposerId, now);
    const gl = p.governanceLevel || "base";
    let v2Threshold = GovernThreshold(gl, m, P, F);
    // 小节点豁免（目录动作）——同 settleGovernProposal
    if (p.action === GOVERN_ACTION_DIRECTORY_ADD && roster.size < DIRECTORY_SMALL_NODE_ROSTER_MAX) {
      v2Threshold = 0;
    }
    const quorum = GovernQuorum(v2Threshold, m);
    const voterCount = Number(
      db.select(`SELECT COUNT(DISTINCT voter_id) AS c FROM govern_votes WHERE proposal_id=?`, [
        p.proposalId,
      ])[0]?.c ?? 0,
    );
    const sumRow = db.select(
      `SELECT
        COALESCE(SUM(CASE WHEN vote_type='approve' THEN vote_weight ELSE 0 END),0) AS a,
        COALESCE(SUM(CASE WHEN vote_type='reject' THEN vote_weight ELSE 0 END),0) AS r
        FROM govern_votes WHERE proposal_id=?`,
      [p.proposalId],
    )[0];
    const approveSum = Number(sumRow?.a ?? 0);
    const rejectSum = Number(sumRow?.r ?? 0);
    const net = NetWeight(approveSum, rejectSum);

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
      threshold: v2Threshold,
      executedAt: p.executedAt,
      voidedAt: p.voidedAt,
      contentVersion: p.contentVersion,
      revokedRev: p.revokedRev,
      // Spec v2 字段
      governanceLevel: gl,
      category: p.category,
      circleId: p.circleId,
      quorum,
      voterCount,
      approveWeight: approveSum,
      rejectWeight: rejectSum,
      netWeight: net,
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

/** validProposalAction（govern.go:33-39 + Spec v2 §3）：12 种治理动作枚举。 */
export function validProposalAction(a: string): boolean {
  return (
    a === GOVERN_ACTION_REMOVE ||
    a === GOVERN_ACTION_EDIT ||
    a === GOVERN_ACTION_REVIVE ||
    a === GOVERN_ACTION_DIRECTORY_ADD ||
    a === GOVERN_ACTION_EDIT_TITLE ||
    a === GOVERN_ACTION_EDIT_BODY ||
    a === GOVERN_ACTION_EDIT_CATEGORY ||
    a === GOVERN_ACTION_EDIT_TAGS ||
    a === GOVERN_ACTION_EDIT_INSTRUCTOR ||
    a === GOVERN_ACTION_HIGHLIGHT ||
    a === GOVERN_ACTION_PIN ||
    a === GOVERN_ACTION_RECOMMEND ||
    a === GOVERN_ACTION_FEATURE
  );
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
