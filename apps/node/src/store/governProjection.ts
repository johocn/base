// 治理事件的投影与生效判定：逐行对齐 internal/store 的 govern_projection.go、
// govern.go（governPreconditionTx / governApplyTx / editItemTx / editTagItemTx）、
// free_remove.go、tag.go（replaceTagLinksTx）、directory.go 写入面与 segments.go 的 retireItemExec。
import { sha256Hex, utf8 } from "@base/protocol-ts";
import type { Db } from "../db";
import { encText } from "../host/aesgcm";
import {
  directoryKindOfItemId,
  filterRosterAtWatermarkSet,
  GOVERN_ACTION_DIRECTORY_ADD,
  GOVERN_ACTION_REMOVE,
  governThresholdForRoster,
  parseGoInt64,
  restoredRosterAuthors,
  toStr,
} from "../routes/derived";

const META_CONTENT_VERSION = "content_version";
const META_DIRECTORY_VERSION = "directory_version";
const DIRECTORY_STATE_APPROVED = "approved";
const FREE_REMOVE_EXECUTED_RESULT = "free_remove";
const DIRECTORY_EXECUTED_RESULT = "directory_approved";

/** GovernProposalEvent（govern_projection.go:19-32）。 */
export interface GovernProposalEvent {
  proposalId: number;
  targetItemId: string;
  verb: string;
  contentHash: string;
  reason: string;
  title: string;
  bodyMd: string;
  contentVersion: number;
  revokedRev: number;
  createdAt: number;
  eventId: string;
  actor: string;
}

/** GovernVoteEvent（govern_projection.go:35-41）。 */
export interface GovernVoteEvent {
  proposalId: number;
  choice: string;
  createdAt: number;
  eventId: string;
  actor: string;
}

interface Proposal {
  proposalId: number;
  action: string;
  itemId: string;
  proposerId: string;
  reason: string;
  title: string;
  bodyMd: string;
  linksJson: string;
  baseContentHash: string;
  createdAt: number;
  executedAt: number;
  voidedAt: number;
  executedResult: string;
  sourceEventId: string;
  contentVersion: number;
  revokedRev: number;
}

export interface TagLink {
  tagId: string;
  targetId: string;
  kind: string;
}

export interface Segment {
  seq: number;
  kind: string;
  text: string;
}

/** `time.Now().UTC().Format(time.RFC3339)`：无毫秒。 */
function nowUTC(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// proposalColumns（govern.go:114）的列顺序须与 scanProposal 一一对应；两处 COALESCE 加别名便于按名取值。
const PROPOSAL_COLUMNS = `proposal_id,action,item_id,proposer_id,reason,title,body_md,COALESCE(links_json,'') AS links_json,base_content_hash,created_at,executed_at,voided_at,executed_result,COALESCE(source_event_id,'') AS source_event_id,content_version,revoked_rev`;

/** scanProposal（govern.go:119-125）。 */
function scanProposal(r: Record<string, unknown>): Proposal {
  return {
    proposalId: Number(r.proposal_id ?? 0),
    action: toStr(r.action),
    itemId: toStr(r.item_id),
    proposerId: toStr(r.proposer_id),
    reason: toStr(r.reason),
    title: toStr(r.title),
    bodyMd: toStr(r.body_md),
    linksJson: toStr(r.links_json),
    baseContentHash: toStr(r.base_content_hash),
    createdAt: Number(r.created_at ?? 0),
    executedAt: Number(r.executed_at ?? 0),
    voidedAt: Number(r.voided_at ?? 0),
    executedResult: toStr(r.executed_result),
    sourceEventId: toStr(r.source_event_id),
    contentVersion: Number(r.content_version ?? 0),
    revokedRev: Number(r.revoked_rev ?? 0),
  };
}

/** GetProposal（govern.go:374-383）：无行返回 null。 */
export function getProposal(db: Db, id: number): Proposal | null {
  const rows = db.select(`SELECT ${PROPOSAL_COLUMNS} FROM govern_proposals WHERE proposal_id=?`, [id]);
  if (rows.length === 0) return null;
  return scanProposal(rows[0]);
}

/** proposalVotersExec（govern.go:128-143）：按 voter_id 升序读全部投票人（未过滤名册）。 */
export function proposalVotersExec(db: Db, proposalId: number): string[] {
  const rows = db.select(
    `SELECT voter_id FROM govern_votes WHERE proposal_id=? ORDER BY voter_id ASC`,
    [proposalId],
  );
  return rows.map((r) => toStr(r.voter_id));
}

/**
 * ProjectGovernProposal（govern_projection.go:50-96）。
 * 返回 true = 冲突（本次不是 (created_at,event_id) 首个，投影未改写）；真错误抛异常。
 */
export function projectGovernProposal(db: Db, e: GovernProposalEvent): boolean {
  db.execute("BEGIN");
  try {
    const rows = db.select(
      `SELECT created_at, COALESCE(source_event_id,'') AS source_event_id FROM govern_proposals WHERE proposal_id=?`,
      [e.proposalId],
    );
    if (rows.length === 0) {
      // 首次投影：事件是权威，按事件值落库（proposal_id 取事件值，不依赖本机自增）。
      db.execute(
        `INSERT INTO govern_proposals(
          proposal_id,action,item_id,proposer_id,reason,title,body_md,base_content_hash,created_at,source_event_id,content_version,revoked_rev)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          e.proposalId,
          e.verb,
          e.targetItemId,
          e.actor,
          e.reason,
          e.title,
          e.bodyMd,
          e.contentHash,
          e.createdAt,
          e.eventId,
          e.contentVersion,
          e.revokedRev,
        ],
      );
      // 提案人自投第 1 票；票的 created_at 用**事件值**，不是本机 now。
      db.execute(
        `INSERT INTO govern_votes(proposal_id,voter_id,created_at,source_event_id)
          VALUES(?,?,?,?) ON CONFLICT(proposal_id,voter_id) DO NOTHING`,
        [e.proposalId, e.actor, e.createdAt, e.eventId],
      );
      db.execute("COMMIT");
      return false;
    }
    const prevCreated = Number(rows[0].created_at ?? 0);
    const prevEventID = toStr(rows[0].source_event_id);
    // 同一条事件重放属幂等，不算冲突。
    if (prevEventID === e.eventId) {
      db.execute("ROLLBACK");
      return false;
    }
    // 事件来源的行按 (created_at,event_id) 字典序收敛；本地路径写入的行（source_event_id 为空）永不覆盖。
    if (
      prevEventID !== "" &&
      (e.createdAt < prevCreated || (e.createdAt === prevCreated && e.eventId < prevEventID))
    ) {
      db.execute(
        `UPDATE govern_proposals SET
          action=?,item_id=?,proposer_id=?,reason=?,title=?,body_md=?,base_content_hash=?,
          created_at=?,source_event_id=?,content_version=?,revoked_rev=?
          WHERE proposal_id=?`,
        [
          e.verb,
          e.targetItemId,
          e.actor,
          e.reason,
          e.title,
          e.bodyMd,
          e.contentHash,
          e.createdAt,
          e.eventId,
          e.contentVersion,
          e.revokedRev,
          e.proposalId,
        ],
      );
      db.execute("COMMIT");
      return false;
    }
    // prevEventID === ""（本地行）与「本次并非更早」都落这里 → 冲突。
    db.execute("ROLLBACK");
    return true;
  } catch (err) {
    db.execute("ROLLBACK");
    throw err;
  }
}

/**
 * ProjectGovernVote（govern_projection.go:113-140）：同 (proposal_id,voter_id) 取**最早**的
 * (created_at,event_id)；较晚的不覆盖，同事件重放幂等。**不返回冲突**（Go 无事务）。
 */
export function projectGovernVote(db: Db, e: GovernVoteEvent): void {
  const rows = db.select(
    `SELECT created_at, COALESCE(source_event_id,'') AS source_event_id FROM govern_votes WHERE proposal_id=? AND voter_id=?`,
    [e.proposalId, e.actor],
  );
  if (rows.length === 0) {
    db.execute(
      `INSERT INTO govern_votes(proposal_id,voter_id,created_at,source_event_id) VALUES(?,?,?,?)`,
      [e.proposalId, e.actor, e.createdAt, e.eventId],
    );
    return;
  }
  const prevCreated = Number(rows[0].created_at ?? 0);
  const prevEventID = toStr(rows[0].source_event_id);
  if (prevEventID === e.eventId) return;
  if (e.createdAt < prevCreated || (e.createdAt === prevCreated && e.eventId < prevEventID)) {
    db.execute(
      `UPDATE govern_votes SET created_at=?, source_event_id=? WHERE proposal_id=? AND voter_id=?`,
      [e.createdAt, e.eventId, e.proposalId, e.actor],
    );
  }
}

/** GovernRequiredState（govern.go:62-67）。 */
function governRequiredState(action: string): string {
  return action === "revive" ? "removed" : "active";
}

/** governPreconditionTx（govern.go:543-561）。 */
export function governPreconditionTx(db: Db, p: Proposal): boolean {
  // directory_add 的目标不是内容条目，items 表无对应行，直接放行。
  if (p.action === GOVERN_ACTION_DIRECTORY_ADD) return true;
  const rows = db.select(`SELECT state,content_hash FROM items WHERE item_id=?`, [p.itemId]);
  if (rows.length === 0) return false;
  if (toStr(rows[0].state) !== governRequiredState(p.action)) return false;
  return toStr(rows[0].content_hash) === p.baseContentHash;
}

/** nextContentVersionExec（segments.go:132-146）。 */
function nextContentVersion(db: Db): number {
  const rows = db.select(`SELECT value FROM meta WHERE key=?`, [META_CONTENT_VERSION]);
  if (rows.length === 0) return 1;
  const raw = toStr(rows[0].value);
  const cur = parseGoInt64(raw);
  if (cur === null) throw new Error(`store: bad content_version ${JSON.stringify(raw)}`);
  return cur + 1;
}

/** retireItemExec（segments.go:114-123）。 */
function retireItem(db: Db, itemId: string, revokedRev: number): void {
  db.execute(
    `INSERT INTO tombstones(item_id,revoked_rev) VALUES(?,?)
      ON CONFLICT(item_id) DO UPDATE SET revoked_rev=MAX(revoked_rev,excluded.revoked_rev)`,
    [itemId, revokedRev],
  );
  db.execute(`UPDATE items SET state='removed' WHERE item_id=?`, [itemId]);
}

/** bumpDirectoryVersionExec（directory.go:274-292）。 */
export function bumpDirectoryVersion(db: Db): number {
  let cur = 0;
  const rows = db.select(`SELECT value FROM meta WHERE key=?`, [META_DIRECTORY_VERSION]);
  if (rows.length > 0) {
    const raw = toStr(rows[0].value);
    const n = parseGoInt64(raw);
    if (n === null) throw new Error(`store: bad directory_version ${JSON.stringify(raw)}`);
    cur = n;
  }
  const next = cur + 1;
  db.execute(
    `INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    [META_DIRECTORY_VERSION, String(next)],
  );
  return next;
}

/** upsertDirectoryTermExec（directory.go:255-265）：first_author_id 保留首次值。 */
function upsertDirectoryTerm(
  db: Db,
  kind: string,
  termKey: string,
  display: string,
  author: string,
  state: string,
  now: string,
): void {
  db.execute(
    `INSERT INTO directory_terms(kind,term_key,display_name,state,first_author_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(kind,term_key) DO UPDATE SET
        display_name=excluded.display_name, state=excluded.state, updated_at=excluded.updated_at`,
    [kind, termKey, display, state, author, now, now],
  );
}

/** approveDirectoryTermExec（directory.go:268-270）。 */
export function approveDirectoryTerm(
  db: Db,
  kind: string,
  termKey: string,
  display: string,
  author: string,
): void {
  upsertDirectoryTerm(db, kind, termKey, display, author, DIRECTORY_STATE_APPROVED, nowUTC());
}

/** tagKindRank（tag.go:35-42）：固定序 course < lesson < article < comment，其余排最后。 */
function tagKindRank(kind: string): number {
  const order = ["course", "lesson", "article", "comment"];
  const i = order.indexOf(kind);
  return i === -1 ? 4 : i;
}

/** MaterializeTagSegments（tag.go:47-66）：seq 从 1 起，按 (kind 固定序, target_id 升序) 去重。 */
export function materializeTagSegments(links: TagLink[]): Segment[] {
  const ordered = links.slice();
  ordered.sort((a, b) => {
    const ra = tagKindRank(a.kind);
    const rb = tagKindRank(b.kind);
    if (ra !== rb) return ra - rb;
    return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0;
  });
  const segs: Segment[] = [];
  const seen = new Set<string>();
  for (const l of ordered) {
    if (seen.has(l.targetId)) continue;
    seen.add(l.targetId);
    segs.push({ seq: segs.length + 1, kind: l.kind, text: l.targetId });
  }
  return segs;
}

/** SegmentsContentHash（segments.go:37-48）：按 seq 升序拼 "kind\ttext\n" 再 sha256 hex。 */
export function segmentsContentHash(segs: Segment[]): string {
  const ordered = segs.slice().sort((a, b) => a.seq - b.seq);
  let b = "";
  for (const s of ordered) b += s.kind + "\t" + s.text + "\n";
  return sha256Hex(utf8(b));
}

/** DecodeTagLinks（govern.go:650-659）：空串按空关联集；不可解析返回 null。 */
export function decodeTagLinks(raw: string): TagLink[] | null {
  if (raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) return null;
  const out: TagLink[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") return null;
    const o = item as Record<string, unknown>;
    out.push({ tagId: toStr(o.TagID), targetId: toStr(o.TargetID), kind: toStr(o.Kind) });
  }
  return out;
}

/** replaceTagLinksTx（tag.go:71-92）：删旧 → 写新 tag_links → 重算物化 segments 行 → 条目级 hash。 */
export function replaceTagLinksTx(db: Db, tagId: string, links: TagLink[]): string {
  db.execute(`DELETE FROM tag_links WHERE tag_id=?`, [tagId]);
  const segs = materializeTagSegments(links);
  for (const s of segs) {
    db.execute(`INSERT INTO tag_links(tag_id,target_id,kind,created_at) VALUES(?,?,?,?)`, [
      tagId,
      s.text,
      s.kind,
      nowUTC(),
    ]);
  }
  db.execute(`DELETE FROM segments WHERE item_id=? AND seq>=1`, [tagId]);
  for (const s of segs) {
    db.execute(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`, [
      tagId,
      s.seq,
      s.kind,
      s.text,
      sha256Hex(utf8(s.text)),
    ]);
  }
  return segmentsContentHash(segs);
}

/** editTagItemTx（govern.go:663-677）。 */
function editTagItemTx(db: Db, p: Proposal): string {
  const links = decodeTagLinks(p.linksJson);
  if (links === null) throw new Error(`store: 标签提案 ${p.proposalId} 的 links_json 不可解析`);
  const hash = replaceTagLinksTx(db, p.itemId, links);
  db.execute(`UPDATE items SET content_hash=?,source_rev=?,updated_at=? WHERE item_id=?`, [
    hash,
    hash.slice(0, 16),
    nowUTC(),
    p.itemId,
  ]);
  return "edited_links";
}

/** editItemTx（govern.go:606-638）：只对 article 成立；tag/ 前缀转 editTagItemTx。 */
function editItemTx(db: Db, storeKey: Uint8Array | null, p: Proposal): string {
  if (p.itemId.startsWith("tag/")) return editTagItemTx(db, p);
  const hash = sha256Hex(utf8(p.bodyMd));
  const rows = db.select(`SELECT content_hash FROM items WHERE item_id=?`, [p.itemId]);
  if (rows.length === 0) throw new Error(`store: 读目标 content_hash ${p.itemId}: no rows`);
  const oldHash = toStr(rows[0].content_hash);
  if (storeKey === null && p.bodyMd !== "") {
    throw new Error(`store: 加密改写正文 ${p.itemId}: 无 store 密钥`);
  }
  const bodyEnc = encText(storeKey as Uint8Array, p.bodyMd);
  db.execute(`UPDATE articles SET title=?,body_md=?,content_hash=?,source_rev=? WHERE item_id=?`, [
    p.title,
    bodyEnc,
    hash,
    hash.slice(0, 16),
    p.itemId,
  ]);
  if (oldHash === hash) {
    db.execute(`UPDATE items SET title=?,content_hash=?,source_rev=?,updated_at=? WHERE item_id=?`, [
      p.title,
      hash,
      hash.slice(0, 16),
      nowUTC(),
      p.itemId,
    ]);
    return "edited";
  }
  db.execute(
    `UPDATE items SET title=?,content_hash=?,source_rev=?,updated_at=?,author_id='',author_sig='' WHERE item_id=?`,
    [p.title, hash, hash.slice(0, 16), nowUTC(), p.itemId],
  );
  return "edited_author_cleared";
}

/** governApplyTx（govern.go:564-602）：在事务内执行受审动作，返回 executed_result。 */
export function governApplyTx(db: Db, storeKey: Uint8Array | null, p: Proposal): string {
  switch (p.action) {
    case GOVERN_ACTION_REMOVE: {
      const rev = nextContentVersion(db);
      retireItem(db, p.itemId, rev);
      return "removed";
    }
    case "revive": {
      db.execute(`DELETE FROM tombstones WHERE item_id=?`, [p.itemId]);
      db.execute(`UPDATE items SET state='active' WHERE item_id=?`, [p.itemId]);
      return "revived";
    }
    case "edit":
      return editItemTx(db, storeKey, p);
    case GOVERN_ACTION_DIRECTORY_ADD: {
      const kind = directoryKindOfItemId(p.itemId);
      if (kind === null) throw new Error(`store: 目录提案 item_id 形态非法 ${JSON.stringify(p.itemId)}`);
      approveDirectoryTerm(db, kind, p.bodyMd, p.title, p.proposerId);
      bumpDirectoryVersion(db);
      return DIRECTORY_EXECUTED_RESULT;
    }
    default:
      throw new Error(`store: 不支持的治理动作 ${JSON.stringify(p.action)}`);
  }
}

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
  const rows = db.select(`SELECT text FROM segments WHERE item_id=? AND seq>=1 ORDER BY seq ASC`, [
    courseId,
  ]);
  return rows.map((r) => toStr(r.text));
}

/** otherLearnerCount（free_remove.go:90-104）。 */
function otherLearnerCount(db: Db, targets: string[], actor: string): number {
  const q = `SELECT COUNT(*) AS n FROM progress WHERE item_id IN (${targets
    .map(() => "?")
    .join(",")}) AND id<>?`;
  const rows = db.select(q, [...targets, actor]);
  return Number(rows[0]?.n ?? 0);
}

/** freeRemoveEligible（free_remove.go:23-57）：判据顺序即短路顺序，异常由调用方 fail-closed。 */
export function freeRemoveEligible(db: Db, itemId: string, actor: string): boolean {
  if (!isCourseId(itemId) && !isLessonId(itemId)) return false;
  const rows = db.select(`SELECT author_id FROM items WHERE item_id=?`, [itemId]);
  if (rows.length === 0) return false;
  const authorID = toStr(rows[0].author_id);
  if (authorID === "" || authorID !== actor) return false;
  const targets = [itemId];
  if (isCourseId(itemId)) {
    const lessons = courseLessonIds(db, itemId);
    if (lessons.length === 0) return true;
    targets.push(...lessons);
  }
  return otherLearnerCount(db, targets, actor) === 0;
}

/**
 * SettleGovernProposal（govern_projection.go:149-227）：名册 / restored / 免票选判定全在 BEGIN 之前
 * （单连接池下事务内再发查询会死锁）；BEGIN 后第一件事重读提案行做乐观锁。
 */
export function settleGovernProposal(
  db: Db,
  storeKey: Uint8Array | null,
  proposalId: number,
  roster: Set<string>,
  rosterReady: boolean,
): void {
  const p = getProposal(db, proposalId);
  if (p === null) return; // 乱序：vote 先到
  if (p.executedAt !== 0 || p.voidedAt !== 0) return; // 已定案：幂等
  const voters = proposalVotersExec(db, proposalId);
  const restored = restoredRosterAuthors(db, storeKey, p.revokedRev);
  const effective = filterRosterAtWatermarkSet(voters, roster, restored);
  let threshold = governThresholdForRoster(p.action, roster.size, rosterReady);
  if (threshold === 1) threshold = 0; // 小节点豁免
  let freeResult = "";
  if (p.action === GOVERN_ACTION_REMOVE) {
    try {
      if (freeRemoveEligible(db, p.itemId, p.proposerId)) {
        threshold = 0;
        freeResult = FREE_REMOVE_EXECUTED_RESULT;
      }
    } catch {
      // 判定异常按「不可免票选」处理（fail-closed），退回既有门槛。
    }
  }
  if (effective.length < threshold) return; // 未达门槛

  db.execute("BEGIN");
  try {
    const rows = db.select(`SELECT ${PROPOSAL_COLUMNS} FROM govern_proposals WHERE proposal_id=?`, [
      proposalId,
    ]);
    if (rows.length === 0) throw new Error(`store: 读提案 ${proposalId}: no rows`);
    const cur = scanProposal(rows[0]);
    if (cur.executedAt !== 0 || cur.voidedAt !== 0) {
      db.execute("COMMIT");
      return;
    }
    const now = Date.now();
    if (!governPreconditionTx(db, cur)) {
      db.execute(`UPDATE govern_proposals SET voided_at=? WHERE proposal_id=?`, [now, proposalId]);
      db.execute("COMMIT");
      return;
    }
    let result = governApplyTx(db, storeKey, cur);
    if (freeResult !== "") result = freeResult;
    db.execute(`UPDATE govern_proposals SET executed_at=?,executed_result=? WHERE proposal_id=?`, [
      now,
      result,
      proposalId,
    ]);
    db.execute("COMMIT");
  } catch (err) {
    db.execute("ROLLBACK");
    throw err;
  }
}