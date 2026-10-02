// 内容库访问层（节点壳）：SQL 文本/行映射来自 `@base/core-ts` 的纯层，
// 本文件只负责 SQLite 驱动、文件 IO、密钥解析与文本列加解密（宿主相关）。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex, utf8 } from "@base/protocol-ts";
import type { Tombstone } from "@base/protocol-ts";
import {
  articleFromRow,
  declaredChunks as coreDeclaredChunks,
  DELETE_SEGMENTS_SQL,
  GET_ITEM_SQL,
  GET_META_SQL,
  getMediaMetaSql,
  INSERT_SEGMENT_SQL,
  itemFromRow,
  listArticlesSql,
  listItemsSql,
  listQuizzesSql,
  listSegmentsSql,
  listTombstonesSql,
  lookupIdentitiesSql,
  mediaMetaFromRow,
  NEXT_CONTENT_VERSION_SQL,
  quizFromRow,
  RETIRE_STATE_SQL,
  RETIRE_TOMBSTONE_SQL,
  segmentFromRow,
  segmentsContentHash,
  tombstoneFromRow,
  UPSERT_ARTICLE_BODY_SQL,
  UPSERT_ARTICLE_ITEM_SQL,
  UPSERT_MEDIA_ITEM_SQL,
  UPSERT_MEDIA_META_SQL,
  UPSERT_META_SQL,
  UPSERT_PACK_SQL,
  UPSERT_QUIZ_ITEM_SQL,
  UPSERT_QUIZ_SQL,
  UPSERT_SEGMENT_ITEM_SQL,
} from "@base/core-ts";
import type {
  BlobRef,
  MediaItemInput,
  MediaMeta,
  PackRecord,
  QuizInput,
  SegmentItemInput,
  StoreArticle,
  StoreItem,
  StoreQuiz,
  StoreSegment,
} from "@base/core-ts";
import { decText, encText } from "../host/aesgcm";
import { openHostDb, normalizeJournalMode, type HostDb } from "../host/sqlite";
import {
  loadStoreKey,
  storeKeyStatus as hostStoreKeyStatus,
  toHex,
  type StoreKeyOptions,
  type StoreKeyStatusResult,
} from "../host/storekey";
import type { Db } from "../db";
import { seedDirectoryFromExisting } from "./directory";
import { hasBlob as hasBlobOf, hostDbAsDb, putBlob as putBlobOf } from "./peersync";
import { migrate, schemaStatements } from "./schema";

export type { StoreKeyOptions, StoreKeyStatusResult } from "../host/storekey";

const META_CONTENT_VERSION = "content_version";

/** `time.Now().UTC().Format(time.RFC3339)`：无毫秒。 */
function nowUTC(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface OpenStoreOptions extends StoreKeyOptions {
  /** true = 只读打开且不建目录/不建表、不写 pragma。仍会做一次性的 WAL→rollback 头归一化（见 normalizeJournalMode）。 */
  readOnly?: boolean;
}

export interface Store {
  readonly dataDir: string;
  close(): void;
  packsDir(): string;
  listItems(state?: string): StoreItem[];
  listArticles(ids?: readonly string[]): Record<string, StoreArticle>;
  listQuizzes(ids?: readonly string[]): Record<string, StoreQuiz>;
  getMediaMeta(itemId: string): MediaMeta | null;
  listSegments(itemId: string): StoreSegment[];
  lookupIdentities(ids?: readonly string[]): Record<string, string>;
  declaredChunks(itemId: string): BlobRef[];
  getItem(itemId: string): StoreItem | null;
  bumpContentVersion(): number;
  nextContentVersion(): number;
  listTombstones(): Tombstone[];
  retireItem(itemId: string, revokedRev: number): void;
  insertPack(rec: PackRecord): void;
  upsertArticle(a: StoreArticle): void;
  upsertSegmentItem(it: SegmentItemInput): void;
  upsertQuiz(q: QuizInput): void;
  upsertMediaItem(m: MediaItemInput): void;
  hasBlob(blobId: string): { exists: boolean; size: number };
  putBlob(blobId: string, data: Uint8Array, itemId: string, seq: number): void;
  storeKeyPath(): string;
  storeKeyHex(): string;
}

class StoreImpl implements Store {
  constructor(
    private readonly db: HostDb,
    readonly dataDir: string,
    private readonly storeKey: Uint8Array,
    private readonly keyPath: string,
  ) {}

  close(): void {
    this.db.close();
  }

  packsDir(): string {
    return join(this.dataDir, "packs");
  }

  listItems(state = ""): StoreItem[] {
    const rows = this.db.all(listItemsSql(state), state !== "" ? [state] : []);
    return rows.map((r) => itemFromRow(r));
  }

  listArticles(ids: readonly string[] = []): Record<string, StoreArticle> {
    const rows = this.db.all(listArticlesSql(ids), [...ids]);
    const out: Record<string, StoreArticle> = {};
    for (const r of rows) {
      const a = articleFromRow(r);
      try {
        a.bodyMd = decText(this.storeKey, a.bodyMd);
      } catch (err) {
        throw new Error(`store: decrypt body_md ${a.itemId}: ${String(err)}`);
      }
      out[a.itemId] = a;
    }
    return out;
  }

  listQuizzes(ids: readonly string[] = []): Record<string, StoreQuiz> {
    const rows = this.db.all(listQuizzesSql(ids), [...ids]);
    const out: Record<string, StoreQuiz> = {};
    for (const r of rows) {
      const q = quizFromRow(r);
      out[q.itemId] = q;
    }
    return out;
  }

  getMediaMeta(itemId: string): MediaMeta | null {
    const row = this.db.get(getMediaMetaSql, [itemId]);
    if (row === undefined) return null;
    return mediaMetaFromRow(row);
  }

  listSegments(itemId: string): StoreSegment[] {
    const rows = this.db.all(listSegmentsSql, [itemId]);
    return rows.map((r) => segmentFromRow(r));
  }

  lookupIdentities(ids: readonly string[] = []): Record<string, string> {
    const rows = this.db.all(lookupIdentitiesSql(ids), [...ids]);
    const out: Record<string, string> = {};
    for (const r of rows) out[String(r.id)] = String(r.pubkey);
    return out;
  }

  declaredChunks(itemId: string): BlobRef[] {
    const meta = this.getMediaMeta(itemId);
    if (meta === null) throw new Error(`store: media_meta 缺少条目 ${itemId}`);
    return coreDeclaredChunks(itemId, meta);
  }

  getItem(itemId: string): StoreItem | null {
    const row = this.db.get(GET_ITEM_SQL, [itemId]);
    if (row === undefined) return null;
    return itemFromRow(row);
  }

  bumpContentVersion(): number {
    this.db.exec("BEGIN");
    try {
      let cur = 0;
      const row = this.db.get(GET_META_SQL, [META_CONTENT_VERSION]);
      if (row !== undefined) {
        const raw = String(row.value);
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n)) {
          throw new Error(`store: bad content_version ${JSON.stringify(raw)}`);
        }
        cur = n;
      }
      const next = cur + 1;
      this.db.run(UPSERT_META_SQL, [META_CONTENT_VERSION, String(next)]);
      this.db.exec("COMMIT");
      return next;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** `NextContentVersion`（segments.go:128-146）：只读，不递增。无行 → 1；非整数 → 抛错。 */
  nextContentVersion(): number {
    const row = this.db.get(NEXT_CONTENT_VERSION_SQL, [META_CONTENT_VERSION]);
    if (row === undefined) return 1;
    const raw = String(row.value);
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new Error(`store: bad content_version ${JSON.stringify(raw)}`);
    }
    return n + 1;
  }

  listTombstones(): Tombstone[] {
    const rows = this.db.all(listTombstonesSql);
    return rows.map((r) => tombstoneFromRow(r));
  }

  /** `RetireItem`（segments.go:110-124）：写墓碑（revoked_rev 取大值覆盖）并置 state='removed'。 */
  retireItem(itemId: string, revokedRev: number): void {
    try {
      this.db.run(RETIRE_TOMBSTONE_SQL, [itemId, revokedRev]);
    } catch (err) {
      throw new Error(`store: 退役写墓碑 ${itemId}: ${String(err)}`);
    }
    try {
      this.db.run(RETIRE_STATE_SQL, [itemId]);
    } catch (err) {
      throw new Error(`store: 退役置状态 ${itemId}: ${String(err)}`);
    }
  }

  insertPack(rec: PackRecord): void {
    const createdAt = rec.createdAt === "" ? nowUTC() : rec.createdAt;
    this.db.run(UPSERT_PACK_SQL, [
      rec.packId,
      rec.contentVersion,
      rec.dir,
      rec.merkleRoot,
      rec.signature,
      rec.issuedAt,
      rec.itemCount,
      createdAt,
    ]);
  }

  upsertArticle(a: StoreArticle): void {
    const updated = a.updatedAt === "" ? nowUTC() : a.updatedAt;
    this.db.exec("BEGIN");
    try {
      try {
        this.db.run(UPSERT_ARTICLE_ITEM_SQL, [
          a.itemId,
          "article",
          "article",
          a.title,
          a.sourceRev,
          a.contentHash,
          "articles",
          "public",
          "active",
          updated,
        ]);
      } catch (err) {
        throw new Error(`store: upsert item: ${String(err)}`);
      }
      const bodyEnc = encText(this.storeKey, a.bodyMd);
      try {
        this.db.run(UPSERT_ARTICLE_BODY_SQL, [
          a.itemId,
          a.title,
          a.digest,
          a.publishedAt,
          a.tagsJson,
          bodyEnc,
          a.contentHash,
          a.sourceRev,
        ]);
      } catch (err) {
        throw new Error(`store: upsert article: ${String(err)}`);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** `UpsertSegmentItem`（segments.go:52-87）：items + segments 同事务，先删旧行再按 seq 升序写。 */
  upsertSegmentItem(it: SegmentItemInput): void {
    if (it.itemId.trim() === "") {
      throw new Error("store: segment item_id 不能为空");
    }
    const ordered = [...it.segments].sort((a, b) => a.seq - b.seq);
    const hash = segmentsContentHash(ordered);
    const updated = nowUTC();
    this.db.exec("BEGIN");
    try {
      try {
        this.db.run(UPSERT_SEGMENT_ITEM_SQL, [
          it.itemId,
          it.source,
          it.type,
          it.title,
          hash.slice(0, 16),
          hash,
          "segments",
          updated,
        ]);
      } catch (err) {
        throw new Error(`store: upsert segment item: ${String(err)}`);
      }
      try {
        this.db.run(DELETE_SEGMENTS_SQL, [it.itemId]);
      } catch (err) {
        throw new Error(`store: 清旧 segments: ${String(err)}`);
      }
      for (const seg of ordered) {
        try {
          this.db.run(INSERT_SEGMENT_SQL, [
            it.itemId,
            seg.seq,
            seg.kind,
            seg.text,
            sha256Hex(utf8(seg.text)),
          ]);
        } catch (err) {
          throw new Error(`store: 写 segments ${it.itemId} seq=${seg.seq}: ${String(err)}`);
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** `UpsertQuiz`（store.go:225-250）：items + quizzes 同事务。 */
  upsertQuiz(q: QuizInput): void {
    const updated = nowUTC();
    this.db.exec("BEGIN");
    try {
      try {
        this.db.run(UPSERT_QUIZ_ITEM_SQL, [
          q.itemId,
          "lesson",
          "quiz",
          q.title,
          q.sourceRev,
          q.contentHash,
          "quizzes",
          "public",
          "active",
          updated,
        ]);
      } catch (err) {
        throw new Error(`store: upsert quiz item: ${String(err)}`);
      }
      try {
        this.db.run(UPSERT_QUIZ_SQL, [q.itemId, q.questionJson, q.contentHash]);
      } catch (err) {
        throw new Error(`store: upsert quiz: ${String(err)}`);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** `UpsertMediaItem`（store.go:293-329）：items + media_meta 同事务。 */
  upsertMediaItem(m: MediaItemInput): void {
    const chunkJSON = JSON.stringify(m.chunkHashes ?? []);
    const updated = nowUTC();
    this.db.exec("BEGIN");
    try {
      try {
        this.db.run(UPSERT_MEDIA_ITEM_SQL, [
          m.itemId,
          m.source,
          m.type,
          m.title,
          m.sourceRev,
          m.contentHash,
          "media_meta",
          "public",
          "active",
          updated,
        ]);
      } catch (err) {
        throw new Error(`store: upsert media item: ${String(err)}`);
      }
      try {
        this.db.run(UPSERT_MEDIA_META_SQL, [
          m.itemId,
          m.mime,
          m.size,
          m.duration,
          m.chunkSize,
          chunkJSON,
        ]);
      } catch (err) {
        throw new Error(`store: upsert media_meta: ${String(err)}`);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** `PutBlob`（store.go:333-355）：复用 events.ts 的实现，经 HostDb→Db 适配。 */
  putBlob(blobId: string, data: Uint8Array, itemId: string, seq: number): void {
    putBlobOf(hostDbAsDb(this.db), this.dataDir, this.storeKey, blobId, data, itemId, seq);
  }

  /** `HasBlob`（store.go:360-379）：复用 events.ts 的实现。 */
  hasBlob(blobId: string): { exists: boolean; size: number } {
    return hasBlobOf(hostDbAsDb(this.db), this.dataDir, blobId);
  }

  storeKeyPath(): string {
    return this.keyPath;
  }

  storeKeyHex(): string {
    return toHex(this.storeKey);
  }
}

/** 打开/创建数据目录下的内容库（对齐 Go `store.Open`）。 */
export function openStore(dataDir: string, opts: OpenStoreOptions = {}): Store {
  const readOnly = opts.readOnly === true;
  if (!readOnly) {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, "blobs"), { recursive: true });
    mkdirSync(join(dataDir, "packs"), { recursive: true });
  }
  const { key, path } = loadStoreKey(dataDir, opts);
  const dbPath = join(dataDir, "base.db");
  // node-sqlite3-wasm 打不开 WAL 库（VFS 无 xShmMap），先把 Go 建的库头归一为 rollback。
  normalizeJournalMode(dbPath);
  const db = openHostDb(dbPath, { readOnly });
  if (readOnly) {
    // 只读连接不写 pragma。
    db.exec("PRAGMA busy_timeout=5000");
    return new StoreImpl(db, dataDir, key, path);
  }
  db.exec("PRAGMA busy_timeout=5000");
  // Node 全程 rollback：WAL 下本驱动既开不了也重开不了（见 normalizeJournalMode）。
  db.exec("PRAGMA journal_mode=DELETE");
  db.exec("PRAGMA foreign_keys=1");
  try {
    bootstrapStoreDb(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return new StoreImpl(db, dataDir, key, path);
}

/**
 * Go `store.Open` 的引导段（`store.go:155-168`）：`schemaStatements` → `migrate` →
 * `seedDirectoryFromExisting`。**读写库用**，只读打开不调。
 *
 * 目录 seed 失败只记 stderr、不阻断（册子 #58 §9 风险 1）；schema / migrate 失败照旧上抛。
 */
export function bootstrapStoreDb(db: HostDb): void {
  for (const stmt of schemaStatements) db.exec(stmt);
  migrate(db);
  try {
    seedDirectoryFromExisting(db);
  } catch (err) {
    process.stderr.write(
      `store: 目录 seed 迁移失败（目录端点开放前必须修好，#58 §9 风险 1）: ${String(err)}\n`,
    );
  }
}

/**
 * 打开 `base.db` 并跑引导段，返回路由层用的裸 `Db`（对齐 Go `store.Open` → `httpapi.Server`）。
 * 供 `main.ts` 的 `serve` 引导使用；journal / pragma 与 `openStore` 同口径。
 */
export function openBootstrapDb(dbPath: string): Db {
  normalizeJournalMode(dbPath);
  const host = openHostDb(dbPath);
  host.exec("PRAGMA busy_timeout=5000");
  host.exec("PRAGMA journal_mode=DELETE");
  host.exec("PRAGMA foreign_keys=1");
  try {
    bootstrapStoreDb(host);
  } catch (err) {
    host.close();
    throw err;
  }
  return hostDbAsDb(host);
}

/** 报告当前配置下的密钥状态，**不创建任何文件**（对齐 Go `StoreKeyStatus`）。 */
export function storeKeyStatus(
  dataDir: string,
  opts: StoreKeyOptions = {},
): StoreKeyStatusResult {
  return hostStoreKeyStatus(dataDir, opts);
}
