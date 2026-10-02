// 投稿三写路径：逐行对齐 internal/store 的 submission.go（UpsertSubmission / UpsertSegmentSubmission）
// 与 tag.go（UpsertTagSubmission）。
//
// 事务边界用 `execute("BEGIN"/"COMMIT"/"ROLLBACK")`（Db 无事务 API）；`defer tx.Rollback()` 的
// 「提交后再回滚是 no-op」语义由 catch 里的忽略式 ROLLBACK 复刻。
// replaceTagLinksTx / segmentsContentHash 全部复用 governProjection.ts 的唯一实现，不另起口径。
import { sha256Hex, utf8 } from "@base/protocol-ts";
import type { Db } from "../db";
import { encText } from "../host/aesgcm";
import { toStr } from "../routes/derived";
import {
  replaceTagLinksTx,
  segmentsContentHash,
  type Segment,
  type TagLink,
} from "./governProjection";

/** ErrItemTaken：同 item_id 已被占用——含**空归属**的存量条目（册子 §3.1）。 */
export class ItemTakenError extends Error {
  constructor() {
    super("store: item_id taken");
    this.name = "ItemTakenError";
  }
}

/** ErrTagTargetTagged：直打涉及的某个目标**已有标签**（册子 §3.4）。 */
export class TagTargetTaggedError extends Error {
  constructor() {
    super("store: tag target already tagged");
    this.name = "TagTargetTaggedError";
  }
}

/** `time.Now().UTC().Format(time.RFC3339)`：无毫秒。 */
function nowUTC(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 一条待落库的容器行（submitSegment + items.item_id）。 */
export interface SegmentRow extends Segment {
  itemId: string;
}

/** Submission（submission.go:16-26）：一条在线投稿。 */
export interface Submission {
  itemId: string;
  type: string; // article | quiz
  title: string;
  bodyMd: string; // type == article
  questionJson: string; // type == quiz
  contentHash: string; // 由调用方按册子 §2.2 算好
  authorId: string;
  authorSig: string;
  updatedAt?: string; // 空则由本函数取当前 UTC
}

/** SegmentSubmission（submission.go:100-108）：一条容器投稿。 */
export interface SegmentSubmission {
  itemId: string;
  type: string; // course | lesson
  title: string;
  segments: SegmentRow[];
  authorId: string;
  authorSig: string;
  updatedAt?: string;
}

/** TagSubmission（tag.go:25-32）：一条标签直打。 */
export interface TagSubmission {
  tagId: string;
  title: string; // 由调用方按 protocol.TagTitle 重建好
  links: TagLink[];
  authorId: string;
  authorSig: string;
  updatedAt?: string;
}

/**
 * 事务内占用判定（submission.go:52-60 / 131-138 / tag.go:108-115）：只读 items.author_id。
 * 已存在且 author_id 不等于投稿者——**包括空归属的存量条目**——抛 ItemTakenError。
 */
function checkItemOwnership(db: Db, itemId: string, authorId: string): boolean {
  const rows = db.select(`SELECT author_id FROM items WHERE item_id=?`, [itemId]);
  if (rows.length === 0) return true; // 新建
  if (toStr(rows[0].author_id) !== authorId) throw new ItemTakenError();
  return false;
}

/** 提交失败时回滚（提交成功后不会走到这里；对齐 `defer tx.Rollback()` 的忽略式语义）。 */
function rollbackQuietly(db: Db): void {
  try {
    db.execute("ROLLBACK");
  } catch {
    // 无活动事务时忽略：Go 的 `_ = tx.Rollback()` 亦然。
  }
}

/**
 * UpsertSubmission（submission.go:31-96）：写 items + articles|quizzes 同事务，created=true 表示新建。
 * 占用判定只看 items.author_id（含空归属存量条目一律拒），ON CONFLICT 刻意不写 state / dist_class。
 */
export function upsertSubmission(db: Db, storeKey: Uint8Array | null, sub: Submission): boolean {
  let table: string;
  switch (sub.type) {
    case "article":
      table = "articles";
      break;
    case "quiz":
      table = "quizzes";
      break;
    default:
      throw new Error(`store: 不支持的投稿类型 ${JSON.stringify(sub.type)}`);
  }
  const updated = sub.updatedAt === undefined || sub.updatedAt === "" ? nowUTC() : sub.updatedAt;
  db.execute("BEGIN");
  try {
    const created = checkItemOwnership(db, sub.itemId, sub.authorId);
    db.execute(
      `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(item_id) DO UPDATE SET
				title=excluded.title, source_rev=excluded.source_rev, content_hash=excluded.content_hash,
				updated_at=excluded.updated_at, author_id=excluded.author_id, author_sig=excluded.author_sig`,
      [
        sub.itemId,
        sub.type,
        sub.type,
        sub.title,
        sub.contentHash.slice(0, 16),
        sub.contentHash,
        table,
        "public",
        "active",
        updated,
        sub.authorId,
        sub.authorSig,
      ],
    );
    if (sub.type === "article") {
      if (storeKey === null && sub.bodyMd !== "") {
        throw new Error(`store: encrypt body_md ${sub.itemId}: 无 store 密钥`);
      }
      const bodyEnc = encText(storeKey as Uint8Array, sub.bodyMd);
      db.execute(
        `INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev)
				VALUES(?,?,?,?,?,?,?,?)
				ON CONFLICT(item_id) DO UPDATE SET
					title=excluded.title, body_md=excluded.body_md,
					content_hash=excluded.content_hash, source_rev=excluded.source_rev`,
        [sub.itemId, sub.title, "", "", "[]", bodyEnc, sub.contentHash, sub.contentHash.slice(0, 16)],
      );
    } else {
      db.execute(
        `INSERT INTO quizzes(item_id,question_json,content_hash)
				VALUES(?,?,?)
				ON CONFLICT(item_id) DO UPDATE SET question_json=excluded.question_json, content_hash=excluded.content_hash`,
        [sub.itemId, sub.questionJson, sub.contentHash],
      );
    }
    db.execute("COMMIT");
    return created;
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}

/**
 * UpsertSegmentSubmission（submission.go:113-159）：写 items + segments 同事务，created=true 表示新建。
 * content_hash 走容器口径（SegmentsContentHash）；segments 全量替换（先 DELETE 再逐行 INSERT）。
 */
export function upsertSegmentSubmission(db: Db, sub: SegmentSubmission): boolean {
  if (sub.type !== "course" && sub.type !== "lesson") {
    throw new Error(`store: 不支持的容器类型 ${JSON.stringify(sub.type)}`);
  }
  const ordered = sub.segments.slice().sort((a, b) => a.seq - b.seq);
  const hash = segmentsContentHash(ordered);
  const updated = sub.updatedAt === undefined || sub.updatedAt === "" ? nowUTC() : sub.updatedAt;
  db.execute("BEGIN");
  try {
    const created = checkItemOwnership(db, sub.itemId, sub.authorId);
    db.execute(
      `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
			VALUES(?,?,?,?,?,?,?,'public','active',?,?,?)
			ON CONFLICT(item_id) DO UPDATE SET
				title=excluded.title, source_rev=excluded.source_rev, content_hash=excluded.content_hash,
				updated_at=excluded.updated_at, author_id=excluded.author_id, author_sig=excluded.author_sig`,
      [
        sub.itemId,
        sub.type,
        sub.type,
        sub.title,
        hash.slice(0, 16),
        hash,
        "segments",
        updated,
        sub.authorId,
        sub.authorSig,
      ],
    );
    db.execute(`DELETE FROM segments WHERE item_id=?`, [sub.itemId]);
    for (const seg of ordered) {
      db.execute(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`, [
        sub.itemId,
        seg.seq,
        seg.kind,
        seg.text,
        sha256Hex(utf8(seg.text)),
      ]);
    }
    db.execute("COMMIT");
    return created;
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}

/**
 * UpsertTagSubmission（tag.go:96-142）：items + tag_links + segments 同事务。
 * 直打条件：本次涉及的**每一个**目标当前都不得被**别的标签**占用（排除自身，保证重试幂等），
 * 否则整体拒绝（TagTargetTaggedError）。
 */
export function upsertTagSubmission(db: Db, sub: TagSubmission): boolean {
  const updated = sub.updatedAt === undefined || sub.updatedAt === "" ? nowUTC() : sub.updatedAt;
  db.execute("BEGIN");
  try {
    const created = checkItemOwnership(db, sub.tagId, sub.authorId);
    for (const l of sub.links) {
      const rows = db.select(
        `SELECT COUNT(*) AS n FROM tag_links WHERE target_id=? AND tag_id<>?`,
        [l.targetId, sub.tagId],
      );
      if (Number(rows[0]?.n ?? 0) > 0) throw new TagTargetTaggedError();
    }
    const hash = replaceTagLinksTx(db, sub.tagId, sub.links);
    db.execute(
      `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
			VALUES(?,?,?,?,?,?,?,'public','active',?,?,?)
			ON CONFLICT(item_id) DO UPDATE SET
				title=excluded.title, source_rev=excluded.source_rev, content_hash=excluded.content_hash,
				updated_at=excluded.updated_at, author_id=excluded.author_id, author_sig=excluded.author_sig`,
      [
        sub.tagId,
        "tag",
        "tag",
        sub.title,
        hash.slice(0, 16),
        hash,
        "segments",
        updated,
        sub.authorId,
        sub.authorSig,
      ],
    );
    db.execute("COMMIT");
    return created;
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}