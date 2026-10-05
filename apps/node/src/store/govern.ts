// 治理**签名写路径**的 store 层：逐行对齐 internal/store 的
// govern.go（CreateProposal / CreateDirectoryProposal / AddVote / addVoteTx / EncodeTagLinks）、
// directory.go（GetDirectoryTerm / FindPendingDirectoryProposal / DirectoryPendingVotes）
// 与 store.go（GetItem）的写 / 读面。
//
// 事务边界用 `execute("BEGIN"/"COMMIT"/"ROLLBACK")`（Db 无事务 API）；`defer tx.Rollback()` 的
// 「提交后再回滚是 no-op」语义由忽略式 ROLLBACK 复刻（参照 submission.ts:4-5 的既有做法）。
// 生效判定 / 动作执行全部复用 governProjection.ts 的唯一实现，不另起口径。
import type { Db } from "../db";
import {
  contributorRoster,
  directoryKindOfItemId,
  filterRosterAtWatermarkSet,
  GOVERN_ACTION_REMOVE,
  GovernQuorum,
  GovernThreshold,
  governThresholdForRoster,
  NetWeight,
  proposalStatus,
  restoredRosterAuthors,
  shouldFreeExec,
  toStr,
} from "../routes/derived";
import {
  approveDirectoryTerm,
  bumpDirectoryVersion,
  freeRemoveEligible,
  getProposal,
  governApplyTx,
  governPreconditionTx,
  proposalVotersExec,
  type TagLink,
} from "./governProjection";

export { decodeTagLinks } from "./governProjection";

const META_CONTENT_VERSION = "content_version";
const GOVERN_STATUS_PENDING = "pending";
const GOVERN_STATUS_EFFECTIVE = "effective";
const GOVERN_STATUS_VOID = "void";
const DIRECTORY_EXECUTED_RESULT = "directory_approved";
const FREE_REMOVE_EXECUTED_RESULT = "free_remove";

/** ErrAlreadyVoted（govern.go:429-430）：该身份已对本提案投过票（409 already_voted）。 */
export class AlreadyVotedError extends Error {
  constructor() {
    super("store: already voted");
    this.name = "AlreadyVotedError";
  }
}

/** 提交失败时回滚（提交成功后不会走到这里；对齐 `defer tx.Rollback()` 的忽略式语义）。 */
function rollbackQuietly(db: Db): void {
  try {
    db.execute("ROLLBACK");
  } catch {
    // 无活动事务时忽略：Go 的 `_ = tx.Rollback()` 亦然。
  }
}

/** CreateProposal / CreateDirectoryProposal 的入参（govern.go:82-102 + Spec v2 §3 扩列）。 */
export interface ProposalInput {
  action: string;
  itemId: string;
  proposerId: string;
  reason: string;
  title: string;
  bodyMd: string;
  linksJson: string;
  /** Spec v2 §3: edit_tags 载荷 */
  tagsJson?: string;
  /** Spec v2 §3: edit_category 载荷 */
  distClass?: string;
  /** Spec v2 §3: edit_instructor 载荷 */
  instructor?: string;
  baseContentHash: string;
  createdAt: number;
  /** V2 动态门槛分类元信息，缺省 'base' */
  governanceLevel?: string;
  category?: string;
  circleId?: string;
}

/** VoteResult（govern.go:432-438）：一次投票落库后的判定结果。 */
export interface VoteResult {
  proposalId: number;
  voteCount: number;
  threshold: number;
  status: string;
}

/** VoteResultV2（Spec v2 §4，govern.go:923-933）：两阶段投票管线的响应体。 */
export interface VoteResultV2 {
  proposalId: number;
  voterCount: number;
  quorum: number;
  threshold: number;
  approveWeight: number;
  rejectWeight: number;
  netWeight: number;
  status: string;
}

/** DirectoryTerm（directory.go:35-44）：directory_terms 的一行。 */
export interface DirectoryTerm {
  kind: string;
  termKey: string;
  displayName: string;
  state: string;
  firstAuthorId: string;
  createdAt: string;
  updatedAt: string;
}

function scanDirectoryTerm(r: Record<string, unknown>): DirectoryTerm {
  return {
    kind: toStr(r.kind),
    termKey: toStr(r.term_key),
    displayName: toStr(r.display_name),
    state: toStr(r.state),
    firstAuthorId: toStr(r.first_author_id),
    createdAt: toStr(r.created_at),
    updatedAt: toStr(r.updated_at),
  };
}

/** contentVersionTx（govern.go:356-364）：meta 缺省视为 0。 */
function contentVersion(db: Db): number {
  const rows = db.select(`SELECT CAST(value AS INTEGER) AS v FROM meta WHERE key=?`, [
    META_CONTENT_VERSION,
  ]);
  if (rows.length === 0) return 0;
  return Number(rows[0].v ?? 0);
}

/** maxRevokedRevTx（govern.go:366-371）：无墓碑视为 0。 */
function maxRevokedRev(db: Db): number {
  const rows = db.select(`SELECT COALESCE(MAX(revoked_rev),0) AS n FROM tombstones`);
  return Number(rows[0]?.n ?? 0);
}

/** 取新插入行 id（Go `res.LastInsertId()`）；同连接内 `last_insert_rowid()` 有效。 */
function lastInsertRowId(db: Db): number {
  const rows = db.select(`SELECT last_insert_rowid() AS id`);
  return Number(rows[0]?.id ?? 0);
}

/** filterRoster（govern.go:146-154）：只保留当前仍在名册内的投票人，保持原序。 */
function filterRoster(ids: string[], roster: Set<string>): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (roster.has(id)) out.push(id);
  }
  return out;
}

/** CreateProposal（govern.go:378-463 + Spec v2 §3/§4 扩列/shouldFreeExec）：
 * 正常路径写提案行 + 提案人自投（vote_weight=1, vote_type=approve, date=ISO yyyy-mm-dd）。
 * shouldFreeExec 快速路径（Spec v2 §3.5）：若作者本人 + 无他人互动 + active → 同事务直接执行 governApplyTx。 */
export function createProposal(db: Db, p: ProposalInput, storeKey: Uint8Array | null = null): number {
  // Should this default be 'base'? Yes — Go CreateProposal 里没显式给就 base。
  const governanceLevel = p.governanceLevel ?? "base";
  const category = p.category ?? "";
  const circleId = p.circleId ?? "";
  const tagsJson = p.tagsJson ?? "";
  const distClass = p.distClass ?? "";
  const instructor = p.instructor ?? "";

  // ============ Spec v2 §3.5 免票选快速路径 ============
  const freeCheck = shouldFreeExec(db, p.itemId, p.proposerId, p.action);
  if (freeCheck.err === null && freeCheck.free) {
    db.execute("BEGIN");
    try {
      const now = Date.now();
      const cv = contentVersion(db);
      const rv = maxRevokedRev(db);
      // 跑前置条件（同 Go governPreconditionTx：content_hash 匹配 / state 匹配 / 条目存在）
      const p2: Parameters<typeof governPreconditionTx>[1] = {
        proposalId: 0, action: p.action, itemId: p.itemId, proposerId: p.proposerId,
        reason: p.reason, title: p.title, bodyMd: p.bodyMd, linksJson: p.linksJson,
        tagsJson, distClass, instructor, baseContentHash: p.baseContentHash,
        createdAt: p.createdAt, executedAt: 0, voidedAt: 0, executedResult: "",
        sourceEventId: "", contentVersion: cv, revokedRev: rv, governanceLevel, category, circleId,
      };
      const met = governPreconditionTx(db, p2);
      if (!met) {
        // 前置不满足 → 直接记 void 提案
        db.execute(
          `INSERT INTO govern_proposals(action,item_id,proposer_id,reason,title,body_md,links_json,tags_json,dist_class,instructor,base_content_hash,created_at,voided_at,content_version,revoked_rev,governance_level,category,circle_id)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [p.action, p.itemId, p.proposerId, p.reason, p.title, p.bodyMd, p.linksJson,
            tagsJson, distClass, instructor,
            p.baseContentHash, p.createdAt, now, cv, rv,
            governanceLevel, category, circleId],
        );
        const id = lastInsertRowId(db);
        db.execute("COMMIT");
        return id;
      }
      // 前置满足 → 直接执行动作 + 记 executed_at
      const execRes = governApplyTx(db, storeKey, { ...p2, proposalId: 0 });
      db.execute(
        `INSERT INTO govern_proposals(action,item_id,proposer_id,reason,title,body_md,links_json,tags_json,dist_class,instructor,base_content_hash,created_at,executed_at,executed_result,content_version,revoked_rev,governance_level,category,circle_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [p.action, p.itemId, p.proposerId, p.reason, p.title, p.bodyMd, p.linksJson,
          tagsJson, distClass, instructor,
          p.baseContentHash, p.createdAt, now, "free_exec:" + execRes, cv, rv,
          governanceLevel, category, circleId],
      );
      const pid = lastInsertRowId(db);
      db.execute("COMMIT");
      return pid;
    } catch (err) {
      rollbackQuietly(db);
      throw err;
    }
  }

  // ============ 正常投票路径 ============
  db.execute("BEGIN");
  try {
    const cv = contentVersion(db);
    const rv = maxRevokedRev(db);
    db.execute(
      `INSERT INTO govern_proposals(action,item_id,proposer_id,reason,title,body_md,links_json,tags_json,dist_class,instructor,base_content_hash,created_at,content_version,revoked_rev,governance_level,category,circle_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        p.action, p.itemId, p.proposerId, p.reason, p.title, p.bodyMd, p.linksJson,
        tagsJson, distClass, instructor,
        p.baseContentHash, p.createdAt, cv, rv,
        governanceLevel, category, circleId,
      ],
    );
    const id = lastInsertRowId(db);
    // 提案人自投：vote_weight=1, vote_type=approve, date=ISO yyyy-mm-dd（UTC）
    const dateIso = new Date(p.createdAt).toISOString().slice(0, 10);
    db.execute(
      `INSERT INTO govern_votes(proposal_id,voter_id,vote_weight,vote_type,date,created_at) VALUES(?,?,?,?,?,?)`,
      [id, p.proposerId, 1, "approve", dateIso, p.createdAt],
    );
    db.execute("COMMIT");
    return id;
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}

/**
 * CreateDirectoryProposal（govern.go:471-525）：写目录提案 + 第 1 票；autoApprove=true（小节点豁免）时
 * **同事务**批准词条、推 directory_version、记 executed_at。返回 {id, status}。
 */
export function createDirectoryProposal(
  db: Db,
  p: ProposalInput,
  autoApprove: boolean,
): { id: number; status: string } {
  db.execute("BEGIN");
  try {
    const cv = contentVersion(db);
    const rv = maxRevokedRev(db);
    const governanceLevel = p.governanceLevel ?? "base";
    const category = p.category ?? "";
    const circleId = p.circleId ?? "";
    db.execute(
      `INSERT INTO govern_proposals(action,item_id,proposer_id,reason,title,body_md,links_json,tags_json,dist_class,instructor,base_content_hash,created_at,content_version,revoked_rev,governance_level,category,circle_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        p.action, p.itemId, p.proposerId, p.reason, p.title, p.bodyMd, p.linksJson,
        p.tagsJson ?? "", p.distClass ?? "", p.instructor ?? "",
        p.baseContentHash, p.createdAt, cv, rv,
        governanceLevel, category, circleId,
      ],
    );
    const id = lastInsertRowId(db);
    // 提案人自投：vote_weight=1, vote_type=approve, date=ISO yyyy-mm-dd（UTC）
    const dateIso = new Date(p.createdAt).toISOString().slice(0, 10);
    db.execute(
      `INSERT INTO govern_votes(proposal_id,voter_id,vote_weight,vote_type,date,created_at) VALUES(?,?,?,?,?,?)`,
      [id, p.proposerId, 1, "approve", dateIso, p.createdAt],
    );
    if (!autoApprove) {
      db.execute("COMMIT");
      return { id, status: GOVERN_STATUS_PENDING };
    }
    const kind = directoryKindOfItemId(p.itemId);
    if (kind === null) throw new Error(`store: 目录提案 item_id 形态非法 ${JSON.stringify(p.itemId)}`);
    approveDirectoryTerm(db, kind, p.bodyMd, p.title, p.proposerId);
    bumpDirectoryVersion(db);
    db.execute(`UPDATE govern_proposals SET executed_at=?,executed_result=? WHERE proposal_id=?`, [
      Date.now(),
      DIRECTORY_EXECUTED_RESULT,
      id,
    ]);
    db.execute("COMMIT");
    return { id, status: GOVERN_STATUS_EFFECTIVE };
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}

/**
 * AddVote（govern.go:445-459 + addVoteTx:465-539）：写一张票并在**同一事务内**做生效判定。
 * V2 schema 下 govern_votes 主键已改成自增 id，(proposal_id, voter_id) 不再是 UNIQUE；
 * 旧路径（handler 还在用）仍需一人一票，故先手动 COUNT 判重（对齐 Go addVoteTx）。
 * roster 由调用方在**事务外**派生；空名册 ⇒ 有效票 = 0（册子 §6.2 降级口径）。
 * storeKey 供 edit 动作加密正文用（Go 由 Store 自带，Node 侧显式传参，同 settleGovernProposal）。
 */
export function addVote(
  db: Db,
  storeKey: Uint8Array | null,
  proposalId: number,
  voterId: string,
  roster: Set<string>,
): VoteResult {
  db.execute("BEGIN");
  try {
    const now = Date.now();
    // V2 schema 不再有 (proposal_id,voter_id) 主键 → 手动判重
    const exist = db.select(
      `SELECT COUNT(*) AS n FROM govern_votes WHERE proposal_id=? AND voter_id=?`,
      [proposalId, voterId],
    );
    if (Number(exist[0]?.n ?? 0) > 0) throw new AlreadyVotedError();

    // 写语句刻意置于最前：让 SQLite 先取写锁、串行化并发投票。
    db.execute(
      `INSERT INTO govern_votes(proposal_id,voter_id,created_at,source_event_id,
          vote_weight,vote_type,date) VALUES(?,?,?,?,?,?,?)`,
      [proposalId, voterId, now, null, 1, "approve", ""],
    );

    const p = getProposal(db, proposalId);
    if (p === null) throw new Error(`store: 读提案 ${proposalId}: no rows`);
    const voters = proposalVotersExec(db, proposalId);
    const out: VoteResult = {
      proposalId,
      voteCount: filterRoster(voters, roster).length,
      // HTTP 投票路径的名册由 handler 派生；派生失败按空名册参与（rosterReady 恒 true）。
      threshold: governThresholdForRoster(p.action, roster.size, true),
      status: "",
    };
    // 免票选删除（本册 §5）：remove 提案若可免票选，门槛降为 0；查询异常 fail-closed 退回既有门槛。
    let freeResult = "";
    if (p.action === GOVERN_ACTION_REMOVE) {
      try {
        if (freeRemoveEligible(db, p.itemId, p.proposerId)) {
          out.threshold = 0;
          freeResult = FREE_REMOVE_EXECUTED_RESULT;
        }
      } catch {
        // 判定异常按「不可免票选」处理（fail-closed）。
      }
    }
    // 步 1：已定案 → 票已落库，不再判。
    if (p.executedAt !== 0 || p.voidedAt !== 0) {
      out.status = proposalStatus(p.executedAt, p.voidedAt);
      db.execute("COMMIT");
      return out;
    }
    // 步 3：未达门槛。
    if (out.voteCount < out.threshold) {
      out.status = GOVERN_STATUS_PENDING;
      db.execute("COMMIT");
      return out;
    }
    // 步 4 / 步 5：门槛已到，判前置条件（册子 §4.4）。
    if (!governPreconditionTx(db, p)) {
      db.execute(`UPDATE govern_proposals SET voided_at=? WHERE proposal_id=?`, [now, proposalId]);
      out.status = GOVERN_STATUS_VOID;
      db.execute("COMMIT");
      return out;
    }
    let result = governApplyTx(db, storeKey, p);
    if (freeResult !== "") result = freeResult; // 免票选删除：executed_result 记 'free_remove'（仅诊断）
    db.execute(`UPDATE govern_proposals SET executed_at=?,executed_result=? WHERE proposal_id=?`, [
      now,
      result,
      proposalId,
    ]);
    out.status = GOVERN_STATUS_EFFECTIVE;
    db.execute("COMMIT");
    return out;
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}

/**
 * AddVoteV2（Spec v2 §4，govern.go:938-1117）：V2 两阶段投票管线。
 *   - voteType: 'approve' | 'reject'
 *   - voteWeight: 1..10（非贡献层强制 1；贡献层每日 20 配额 + 单条目 ≤ 10）
 * 返回 VoteResultV2（含阈值/quorum/净票权/当前状态）。
 */
export function addVoteV2(
  db: Db,
  storeKey: Uint8Array | null,
  proposalId: number,
  voterId: string,
  voteWeight: number,
  voteType: string,
): VoteResultV2 {
  // 1. 参数校验
  if (voteType !== "approve" && voteType !== "reject") {
    throw new Error(`invalid vote_type: ${voteType} (need approve|reject)`);
  }
  if (voteWeight < 1 || voteWeight > 10) {
    throw new Error(`vote_weight must be [1,10], got ${voteWeight}`);
  }

  // 2. 查提案
  const p = getProposal(db, proposalId);
  if (p === null) throw new Error(`proposal not found: ${proposalId}`);
  if (p.executedAt !== 0 || p.voidedAt !== 0) {
    throw new Error(`proposal already settled (status=${proposalStatus(p.executedAt, p.voidedAt)})`);
  }

  // 3. 贡献层资格判定
  let isContributor = false;
  try {
    const roster = contributorRoster(db, storeKey);
    isContributor = roster.some((c) => c.id === voterId);
  } catch {
    // 名册派生失败：按空名册降级（fail-closed 资格判定）
  }

  // 4. 普通用户强制 voteWeight=1
  if (!isContributor) voteWeight = 1;

  // 5. 贡献层配额检查
  if (isContributor && voteWeight >= 2) {
    const today = new Date().toISOString().slice(0, 10);
    const usedDaily = Number(
      db.select(
        `SELECT COALESCE(SUM(vote_weight),0) AS c FROM govern_votes WHERE voter_id=? AND date=? AND vote_weight>=2`,
        [voterId, today],
      )[0]?.c ?? 0,
    );
    if (usedDaily + voteWeight > 20) {
      throw new Error(`quota_exceeded: daily contribution quota=20, used=${usedDaily}, add=${voteWeight}`);
    }
  }

  // 6. 单条目累计检查（贡献层）
  if (isContributor) {
    const usedItem = Number(
      db.select(
        `SELECT COALESCE(SUM(vote_weight),0) AS c FROM govern_votes WHERE voter_id=? AND proposal_id=?`,
        [voterId, proposalId],
      )[0]?.c ?? 0,
    );
    if (usedItem + voteWeight > 10) {
      throw new Error(`per_item_quota_exceeded: per-item limit=10, used=${usedItem}, add=${voteWeight}`);
    }
  }

  // 7. 事务内写票 + 两阶段判定
  const now = Date.now();
  const dateIso = new Date(now).toISOString().slice(0, 10);
  const gl = p.governanceLevel || "base";

  db.execute("BEGIN");
  try {
    // Step A: 写 govern_votes
    db.execute(
      `INSERT INTO govern_votes(proposal_id,voter_id,vote_weight,vote_type,date,created_at) VALUES(?,?,?,?,?,?)`,
      [proposalId, voterId, voteWeight, voteType, dateIso, now],
    );

    // Step B: 读提案（事务内）
    const pInner = getProposal(db, proposalId);
    if (pInner === null) throw new Error(`proposal ${proposalId} vanished mid-tx`);

    // Step C: m — 7 天活跃 identities
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const m = Number(
      db.select(`SELECT COUNT(DISTINCT id) AS c FROM identities WHERE last_seen_at > ?`, [
        now - sevenDaysMs,
      ])[0]?.c ?? 0,
    );

    // Step D: P + F（去重，排除 author/proposer）
    let P = 0;
    let F = 0;
    if (pInner.itemId !== "") {
      P = Number(
        db.select(`SELECT COUNT(DISTINCT id) AS c FROM progress WHERE item_id=? AND id!=?`, [
          pInner.itemId,
          pInner.proposerId,
        ])[0]?.c ?? 0,
      );
      F = Number(
        db.select(`SELECT COUNT(DISTINCT id) AS c FROM favorites WHERE item_id=? AND id!=?`, [
          pInner.itemId,
          pInner.proposerId,
        ])[0]?.c ?? 0,
      );
    }

    // Step E: 门槛 + quorum
    const threshold = GovernThreshold(gl, m, P, F);
    const quorum = GovernQuorum(threshold, m);

    // Step F: 独立 voter 数 + 净票权
    const voterCount = Number(
      db.select(`SELECT COUNT(DISTINCT voter_id) AS c FROM govern_votes WHERE proposal_id=?`, [
        proposalId,
      ])[0]?.c ?? 0,
    );
    const sumRow = db.select(
      `SELECT
        COALESCE(SUM(CASE WHEN vote_type='approve' THEN vote_weight ELSE 0 END),0) AS a,
        COALESCE(SUM(CASE WHEN vote_type='reject' THEN vote_weight ELSE 0 END),0) AS r
        FROM govern_votes WHERE proposal_id=?`,
      [proposalId],
    )[0];
    const approveSum = Number(sumRow?.a ?? 0);
    const rejectSum = Number(sumRow?.r ?? 0);
    const net = NetWeight(approveSum, rejectSum);

    // Step G: 阶段 1 — quorum 未达 → pending
    const out: VoteResultV2 = {
      proposalId,
      voterCount,
      quorum,
      threshold,
      approveWeight: approveSum,
      rejectWeight: rejectSum,
      netWeight: net,
      status: "",
    };
    if (voterCount < quorum) {
      out.status = GOVERN_STATUS_PENDING;
      db.execute("COMMIT");
      return out;
    }

    if (net <= 0) {
      // 失败 → void
      db.execute(`UPDATE govern_proposals SET voided_at=? WHERE proposal_id=?`, [now, proposalId]);
      out.status = GOVERN_STATUS_VOID;
      db.execute("COMMIT");
      return out;
    }

    // net > 0 — 前置条件 + 执行
    if (!governPreconditionTx(db, pInner)) {
      db.execute(`UPDATE govern_proposals SET voided_at=? WHERE proposal_id=?`, [now, proposalId]);
      out.status = GOVERN_STATUS_VOID;
      db.execute("COMMIT");
      return out;
    }

    const result = governApplyTx(db, storeKey, pInner);
    db.execute(`UPDATE govern_proposals SET executed_at=?,executed_result=? WHERE proposal_id=?`, [
      now,
      result,
      proposalId,
    ]);
    out.status = GOVERN_STATUS_EFFECTIVE;
    db.execute("COMMIT");
    return out;
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}

/** GetDirectoryTerm（directory.go:162-171）：不存在返回 ok=false（零值 term）。 */
export function getDirectoryTerm(
  db: Db,
  kind: string,
  termKey: string,
): { term: DirectoryTerm; ok: boolean } {
  const rows = db.select(
    `SELECT kind,term_key,display_name,state,first_author_id,created_at,updated_at FROM directory_terms WHERE kind=? AND term_key=?`,
    [kind, termKey],
  );
  if (rows.length === 0) {
    return {
      term: {
        kind: "",
        termKey: "",
        displayName: "",
        state: "",
        firstAuthorId: "",
        createdAt: "",
        updatedAt: "",
      },
      ok: false,
    };
  }
  return { term: scanDirectoryTerm(rows[0]), ok: true };
}

/** FindPendingDirectoryProposal（directory.go:217-228）：未定案（executed_at=0 AND voided_at=0）的提案 id。 */
export function findPendingDirectoryProposal(db: Db, itemId: string): { pid: number; ok: boolean } {
  const rows = db.select(
    `SELECT proposal_id FROM govern_proposals
      WHERE item_id=? AND executed_at=0 AND voided_at=0 ORDER BY proposal_id ASC LIMIT 1`,
    [itemId],
  );
  if (rows.length === 0) return { pid: 0, ok: false };
  return { pid: Number(rows[0].proposal_id ?? 0), ok: true };
}

/**
 * DirectoryPendingVotes（directory.go:233-251）：pending 提案的**名册内有效票数**（按快照水位复算）。
 * 无 pending ⇒ 0。storeKey 供 restoredRosterAuthors 派生水位作者用（形参顺序对齐 derived.ts）。
 */
export function directoryPendingVotes(
  db: Db,
  storeKey: Uint8Array | null,
  itemId: string,
  roster: Set<string>,
): number {
  const { pid, ok } = findPendingDirectoryProposal(db, itemId);
  if (!ok) return 0;
  const p = getProposal(db, pid);
  if (p === null) throw new Error(`store: 读提案 ${pid}: no rows`);
  const voters = proposalVotersExec(db, pid);
  const restored = restoredRosterAuthors(db, storeKey, p.revokedRev);
  return filterRosterAtWatermarkSet(voters, roster, restored).length;
}

const HEX = "0123456789abcdef";

/**
 * 对齐 Go `json.Marshal` 的字符串转义（**escapeHTML=true**，与 Encoder 的 SetEscapeHTML(false) 不同）：
 * `\b`/`\f`/`\n`/`\r`/`\t` 用短转义，其余 <0x20 转 `\u00xx`，`<`/`>`/`&` 转 `\u003c`/`\u003e`/`\u0026`，
 * U+2028/U+2029 无条件转义；0x7f（DEL）**不转义**；未配对代理折为 U+FFFD。
 */
function goJSONString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      } else {
        out += "\ufffd";
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      out += "\ufffd";
      continue;
    }
    switch (c) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0d:
        out += "\\r";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x3c:
        out += "\\u003c";
        break;
      case 0x3e:
        out += "\\u003e";
        break;
      case 0x26:
        out += "\\u0026";
        break;
      case 0x2028:
        out += "\\u2028";
        break;
      case 0x2029:
        out += "\\u2029";
        break;
      default:
        if (c < 0x20) out += "\\u00" + HEX[(c >> 4) & 0xf] + HEX[c & 0xf];
        else out += s[i];
    }
  }
  return out + '"';
}

/**
 * EncodeTagLinks（govern.go:641-647 + tag.go:18-22）：TagLink 无 json tag ⇒ 键名/键序 = 声明序
 * `TagID,TargetID,Kind`（**非字典序**），逐字节等于 Go `json.Marshal`。
 */
export function encodeTagLinks(links: TagLink[]): string {
  const parts = links.map(
    (l) =>
      `{"TagID":${goJSONString(l.tagId)},"TargetID":${goJSONString(l.targetId)},"Kind":${goJSONString(l.kind)}}`,
  );
  return `[${parts.join(",")}]`;
}

// items 列集合（store.go:399 的 GetItem / routes/portal.ts:929 的 ITEM_COLUMNS 同列）。
const ITEM_COLUMNS = `item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig`;

/** GetItem（store.go:398-409）的子集（camelCase）：无行返回 null。 */
export interface ItemRow {
  authorId: string;
  state: string;
  sqliteTable: string;
  type: string;
  contentHash: string;
}

export function getItemRow(db: Db, itemId: string): ItemRow | null {
  const rows = db.select(`SELECT ${ITEM_COLUMNS} FROM items WHERE item_id=?`, [itemId]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    authorId: toStr(r.author_id),
    state: toStr(r.state),
    sqliteTable: toStr(r.sqlite_table),
    type: toStr(r.type),
    contentHash: toStr(r.content_hash),
  };
}