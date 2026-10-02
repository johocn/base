/**
 * 节点内容库的**纯** SQL 文本与行映射纯函数：SQL 字面量逐字对齐 `internal/store/*.go`，
 * 行映射只做列→字段的搬运（不含解密、不含 IO）。解密在宿主层（`apps/node/src/store/store.ts`）。
 */
import { sha256Hex, utf8 } from "@base/protocol-ts";
import type { Tombstone } from "@base/protocol-ts";

import type {
  MediaMeta,
  StoreArticle,
  StoreItem,
  StoreQuiz,
  StoreSegment,
} from "./types";

/** 驱动返回的一行：列名 → 标量。 */
export type Row = Record<string, unknown>;

const ITEMS_SELECT =
  "SELECT item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig FROM items";
const ARTICLES_SELECT =
  "SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev FROM articles";
const QUIZZES_SELECT = "SELECT item_id,question_json,content_hash FROM quizzes";
const IDENTITIES_SELECT = "SELECT id,pubkey FROM identities";

/** `?` 占位符序列（对齐 Go `placeholders`）。 */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

/** `ListItems`：state 为空表示全部；按 item_id 升序。 */
export function listItemsSql(state: string): string {
  let sql = ITEMS_SELECT;
  if (state !== "") sql += " WHERE state=?";
  return `${sql} ORDER BY item_id ASC`;
}

/** `ListArticles`：ids 为空表示全部。 */
export function listArticlesSql(ids: readonly string[]): string {
  let sql = ARTICLES_SELECT;
  if (ids.length > 0) sql += ` WHERE item_id IN (${placeholders(ids.length)})`;
  return sql;
}

/** `ListQuizzes`：ids 为空表示全部。 */
export function listQuizzesSql(ids: readonly string[]): string {
  let sql = QUIZZES_SELECT;
  if (ids.length > 0) sql += ` WHERE item_id IN (${placeholders(ids.length)})`;
  return sql;
}

/** `LookupIdentities`：ids 为空表示全部。 */
export function lookupIdentitiesSql(ids: readonly string[]): string {
  let sql = IDENTITIES_SELECT;
  if (ids.length > 0) sql += ` WHERE id IN (${placeholders(ids.length)})`;
  return sql;
}

export const getMediaMetaSql =
  "SELECT mime,size,duration,chunk_size,chunk_hashes_json FROM media_meta WHERE item_id=?";

export const listSegmentsSql =
  "SELECT item_id,seq,kind,text,content_hash FROM segments WHERE item_id=? ORDER BY seq ASC";

export const listTombstonesSql = "SELECT item_id,revoked_rev FROM tombstones ORDER BY item_id ASC";

/** `UpsertArticle` 写 items 的语句（逐字对齐 `store.go:201-205`）。 */
export const UPSERT_ARTICLE_ITEM_SQL = `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			title=excluded.title, source_rev=excluded.source_rev, content_hash=excluded.content_hash,
			sqlite_table=excluded.sqlite_table, dist_class=excluded.dist_class, state=excluded.state, updated_at=excluded.updated_at`;

/** `UpsertArticle` 写 articles 的语句；body_md 由宿主层加密后传入（逐字对齐 `store.go:213-217`）。 */
export const UPSERT_ARTICLE_BODY_SQL = `INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev)
		VALUES(?,?,?,?,?,?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			title=excluded.title, digest=excluded.digest, published_at=excluded.published_at,
			tags_json=excluded.tags_json, body_md=excluded.body_md, content_hash=excluded.content_hash, source_rev=excluded.source_rev`;

/** `InsertPack`：同 pack_id 覆盖。 */
export const UPSERT_PACK_SQL = `INSERT INTO packs(pack_id,content_version,dir,merkle_root,signature,issued_at,item_count,created_at)
		VALUES(?,?,?,?,?,?,?,?)
		ON CONFLICT(pack_id) DO UPDATE SET
			content_version=excluded.content_version, dir=excluded.dir, merkle_root=excluded.merkle_root,
			signature=excluded.signature, issued_at=excluded.issued_at, item_count=excluded.item_count`;

export const GET_META_SQL = "SELECT value FROM meta WHERE key=?";
export const UPSERT_META_SQL =
  "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value";

/** `UpsertSegmentItem` 写 items 的语句（逐字对齐 `segments.go:68-73`）。 */
export const UPSERT_SEGMENT_ITEM_SQL = `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
		VALUES(?,?,?,?,?,?,?,'public','active',?)
		ON CONFLICT(item_id) DO UPDATE SET
			source=excluded.source, type=excluded.type, title=excluded.title, source_rev=excluded.source_rev,
			content_hash=excluded.content_hash, sqlite_table=excluded.sqlite_table,
			dist_class=excluded.dist_class, state=excluded.state, updated_at=excluded.updated_at`;

/** `UpsertSegmentItem` 清旧 segments 行（逐字对齐 `segments.go:77`）。 */
export const DELETE_SEGMENTS_SQL = "DELETE FROM segments WHERE item_id=?";

/** `UpsertSegmentItem` 写单行 segments（逐字对齐 `segments.go:81`）。 */
export const INSERT_SEGMENT_SQL =
  "INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)";

/** `UpsertQuiz` 写 items 的语句（逐字对齐 `store.go:235-239`）。 */
export const UPSERT_QUIZ_ITEM_SQL = `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			title=excluded.title, source_rev=excluded.source_rev, content_hash=excluded.content_hash,
			sqlite_table=excluded.sqlite_table, dist_class=excluded.dist_class, state=excluded.state, updated_at=excluded.updated_at`;

/** `UpsertQuiz` 写 quizzes 的语句（逐字对齐 `store.go:243-245`）。 */
export const UPSERT_QUIZ_SQL = `INSERT INTO quizzes(item_id,question_json,content_hash)
		VALUES(?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET question_json=excluded.question_json, content_hash=excluded.content_hash`;

/** `UpsertMediaItem` 写 items 的语句（逐字对齐 `store.go:311-316`）。 */
export const UPSERT_MEDIA_ITEM_SQL = `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			source=excluded.source, type=excluded.type, title=excluded.title, source_rev=excluded.source_rev,
			content_hash=excluded.content_hash, sqlite_table=excluded.sqlite_table, dist_class=excluded.dist_class,
			state=excluded.state, updated_at=excluded.updated_at`;

/** `UpsertMediaItem` 写 media_meta 的语句（逐字对齐 `store.go:320-324`）。 */
export const UPSERT_MEDIA_META_SQL = `INSERT INTO media_meta(item_id,mime,size,duration,chunk_size,chunk_hashes_json)
		VALUES(?,?,?,?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			mime=excluded.mime, size=excluded.size, duration=excluded.duration,
			chunk_size=excluded.chunk_size, chunk_hashes_json=excluded.chunk_hashes_json`;

/** `GetItem`（逐字对齐 `store.go:399-400`）。 */
export const GET_ITEM_SQL = `SELECT item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig
		FROM items WHERE item_id=?`;

/** `RetireItem` 写墓碑（逐字对齐 `segments.go:116-117`）。 */
export const RETIRE_TOMBSTONE_SQL = `INSERT INTO tombstones(item_id,revoked_rev) VALUES(?,?)
		ON CONFLICT(item_id) DO UPDATE SET revoked_rev=MAX(revoked_rev,excluded.revoked_rev)`;

/** `RetireItem` 置状态（逐字对齐 `segments.go:120`）。 */
export const RETIRE_STATE_SQL = "UPDATE items SET state='removed' WHERE item_id=?";

/** `NextContentVersion`（逐字对齐 `segments.go:135`）。 */
export const NEXT_CONTENT_VERSION_SQL = "SELECT value FROM meta WHERE key=?";

/**
 * `SegmentsContentHash`（segments.go:37-48）：按 seq 升序拼接 `<kind>\t<text>\n` 的 UTF-8 字节后取 sha256 十六进制。
 * 拼接形状写死是确定性导出的前提，勿改。
 */
export function segmentsContentHash(segs: readonly StoreSegment[]): string {
  const ordered = [...segs].sort((a, b) => a.seq - b.seq);
  let s = "";
  for (const seg of ordered) {
    s += seg.kind;
    s += "\t";
    s += seg.text;
    s += "\n";
  }
  return sha256Hex(utf8(s));
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function num(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}

export function itemFromRow(row: Row): StoreItem {
  return {
    itemId: str(row.item_id),
    source: str(row.source),
    type: str(row.type),
    title: str(row.title),
    sourceRev: str(row.source_rev),
    contentHash: str(row.content_hash),
    sqliteTable: str(row.sqlite_table),
    distClass: str(row.dist_class),
    state: str(row.state),
    updatedAt: str(row.updated_at),
    authorId: str(row.author_id),
    authorSig: str(row.author_sig),
  };
}

/** 映射为文章行；`bodyMd` 仍是**库中存储形态**（可能带 `enc:v1:` 前缀），解密在宿主层。 */
export function articleFromRow(row: Row): StoreArticle {
  return {
    itemId: str(row.item_id),
    title: str(row.title),
    digest: str(row.digest),
    publishedAt: str(row.published_at),
    tagsJson: str(row.tags_json),
    bodyMd: str(row.body_md),
    contentHash: str(row.content_hash),
    sourceRev: str(row.source_rev),
    // ListArticles 不取 updated_at（对齐 Go 的 8 列 SELECT）。
    updatedAt: "",
  };
}

export function quizFromRow(row: Row): StoreQuiz {
  return {
    itemId: str(row.item_id),
    questionJson: str(row.question_json),
    contentHash: str(row.content_hash),
  };
}

export function segmentFromRow(row: Row): StoreSegment {
  return {
    itemId: str(row.item_id),
    seq: num(row.seq),
    kind: str(row.kind),
    text: str(row.text),
    contentHash: str(row.content_hash),
  };
}

/** 映射 media_meta 行；chunk_hashes_json 非法直接抛错（对齐 Go 的 json.Unmarshal 失败）。 */
export function mediaMetaFromRow(row: Row): MediaMeta {
  const chunkHashes = JSON.parse(str(row.chunk_hashes_json) || "[]") as string[];
  return {
    mime: str(row.mime),
    size: num(row.size),
    duration: num(row.duration),
    chunkSize: num(row.chunk_size),
    chunkHashes,
  };
}

export function tombstoneFromRow(row: Row): Tombstone {
  return { item_id: str(row.item_id), revoked_rev: num(row.revoked_rev) };
}
