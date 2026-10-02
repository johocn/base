// 内容库访问层（节点壳）：SQL 文本/行映射来自 `@base/core-ts` 的纯层，
// 本文件只负责 SQLite 驱动、文件 IO、密钥解析与文本列加解密（宿主相关）。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Tombstone } from "@base/protocol-ts";
import {
  articleFromRow,
  declaredChunks as coreDeclaredChunks,
  GET_META_SQL,
  getMediaMetaSql,
  itemFromRow,
  listArticlesSql,
  listItemsSql,
  listQuizzesSql,
  listSegmentsSql,
  listTombstonesSql,
  lookupIdentitiesSql,
  mediaMetaFromRow,
  quizFromRow,
  segmentFromRow,
  tombstoneFromRow,
  UPSERT_ARTICLE_BODY_SQL,
  UPSERT_ARTICLE_ITEM_SQL,
  UPSERT_META_SQL,
  UPSERT_PACK_SQL,
} from "@base/core-ts";
import type {
  BlobRef,
  MediaMeta,
  PackRecord,
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
  bumpContentVersion(): number;
  listTombstones(): Tombstone[];
  insertPack(rec: PackRecord): void;
  upsertArticle(a: StoreArticle): void;
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

  listTombstones(): Tombstone[] {
    const rows = this.db.all(listTombstonesSql);
    return rows.map((r) => tombstoneFromRow(r));
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
    for (const stmt of schemaStatements) db.exec(stmt);
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return new StoreImpl(db, dataDir, key, path);
}

/** 报告当前配置下的密钥状态，**不创建任何文件**（对齐 Go `StoreKeyStatus`）。 */
export function storeKeyStatus(
  dataDir: string,
  opts: StoreKeyOptions = {},
): StoreKeyStatusResult {
  return hostStoreKeyStatus(dataDir, opts);
}
