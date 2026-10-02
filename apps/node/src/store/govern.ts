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
  directoryKindOfItemId,
  filterRosterAtWatermarkSet,
  GOVERN_ACTION_REMOVE,
  governThresholdForRoster,
  proposalStatus,
  restoredRosterAuthors,
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

/** CreateProposal / CreateDirectoryProposal 的入参（govern.go:82-102 写路径实际消费的列）。 */
export interface ProposalInput {
  action: string;
  itemId: string;
  proposerId: string;
  reason: string;
  title: string;
  bodyMd: string;
  linksJson: string;
  baseContentHash: string;
  createdAt: number;
}

/** VoteResult（govern.go:432-438）：一次投票落库后的判定结果。 */
export interface VoteResult {
  proposalId: number;
  voteCount: number;
  threshold: number;
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

/** CreateProposal（govern.go:263-295）：单事务写提案行 + 提案人第 1 票，返回新 proposal_id。 */
export function createProposal(db: Db, p: ProposalInput): number {
  db.execute("BEGIN");
  try {
    // 提案建时固化快照水位（册子 §4.3）：content_version 记当前版本，revoked_rev 记当前墓碑高水位。
    const cv = contentVersion(db);
    const rv = maxRevokedRev(db);
    db.execute(
      `INSERT INTO govern_proposals(action,item_id,proposer_id,reason,title,body_md,links_json,base_content_hash,created_at,content_version,revoked_rev)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        p.action,
        p.itemId,
        p.proposerId,
        p.reason,
        p.title,
        p.bodyMd,
        p.linksJson,
        p.baseContentHash,
        p.createdAt,
        cv,
        rv,
      ],
    );
    const id = lastInsertRowId(db);
    db.execute(`INSERT INTO govern_votes(proposal_id,voter_id,created_at) VALUES(?,?,?)`, [
      id,
      p.proposerId,
      p.createdAt,
    ]);
    db.execute("COMMIT");
    return id;
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}

/**
 * CreateDirectoryProposal（govern.go:303-354）：写目录提案 + 第 1 票；autoApprove=true（小节点豁免）时
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
    db.execute(
      `INSERT INTO govern_proposals(action,item_id,proposer_id,reason,title,body_md,links_json,base_content_hash,created_at,content_version,revoked_rev)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        p.action,
        p.itemId,
        p.proposerId,
        p.reason,
        p.title,
        p.bodyMd,
        p.linksJson,
        p.baseContentHash,
        p.createdAt,
        cv,
        rv,
      ],
    );
    const id = lastInsertRowId(db);
    db.execute(`INSERT INTO govern_votes(proposal_id,voter_id,created_at) VALUES(?,?,?)`, [
      id,
      p.proposerId,
      p.createdAt,
    ]);
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
    // 写语句刻意置于最前（govern.go:462-464）：让 SQLite 先取写锁、串行化并发投票。
    db.execute(
      `INSERT INTO govern_votes(proposal_id,voter_id,created_at) VALUES(?,?,?)
        ON CONFLICT(proposal_id,voter_id) DO NOTHING`,
      [proposalId, voterId, now],
    );
    // already_voted 的唯一判据是受影响行数（不能用「先查再插」，并发语义不同）。
    const changed = db.select(`SELECT changes() AS n`);
    if (Number(changed[0]?.n ?? 0) === 0) throw new AlreadyVotedError();

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