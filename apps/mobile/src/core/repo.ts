import type { LocalDb } from '../platform/adapter';
import type { ArticleRow, ItemRow, TombstoneRow } from './types';

export interface PackApply {
  version: number;
  packId: string;
  items: ItemRow[];
  articles: ArticleRow[];
  tombstones: TombstoneRow[];
  updatedAt: string;
}

/** 本地仓储：同步核心只依赖这些语义方法，不直接写 SQL。 */
export interface LocalRepo {
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;
  /** 一个事务内：先按墓碑删除，再 upsert 条目与正文，最后写版本 */
  applyPack(p: PackApply): Promise<void>;
  getItem(itemId: string): Promise<ItemRow | null>;
  listItems(): Promise<ItemRow[]>;
  getArticle(itemId: string): Promise<ArticleRow | null>;
  hasBlob(blobId: string): Promise<boolean>;
  addBlob(blobId: string, itemId: string, path: string, size: number, verifiedAt: string): Promise<void>;
  /** 取某条目的本地块路径（文章页按 cover:<slug> 取封面，Task 19 用） */
  findBlobPathByItem(itemId: string): Promise<string | null>;
  /** 取某条目在 blob_index 中登记的全部块文件路径（墓碑删文件用，契约 §9.3） */
  listBlobPathsByItem(itemId: string): Promise<string[]>;
  listTombstones(): Promise<TombstoneRow[]>;
}

/** 本地库建表语句（P0 只建用得到的 5 张表）。 */
export const SCHEMA_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS items(
     item_id TEXT PRIMARY KEY, source TEXT, type TEXT, title TEXT, rev TEXT,
     content_hash TEXT, state TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS articles(
     item_id TEXT PRIMARY KEY, title TEXT, digest TEXT, published_at TEXT,
     tags_json TEXT, body_md TEXT, content_hash TEXT, rev TEXT)`,
  `CREATE TABLE IF NOT EXISTS blob_index(
     blob_id TEXT PRIMARY KEY, item_id TEXT, path TEXT, size INTEGER, verified_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS tombstone(item_id TEXT PRIMARY KEY, revoked_rev INTEGER)`,
];

/** SqlRepo 把 LocalRepo 语义落到 SQLite 上（Task 19 注入 plus.sqlite 连接）。 */
export class SqlRepo implements LocalRepo {
  constructor(private readonly db: LocalDb) {}

  async getConfig(key: string): Promise<string | null> {
    const rows = await this.db.select(`SELECT value FROM config WHERE key=?`, [key]);
    return rows.length > 0 ? String(rows[0].value) : null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    await this.db.execute(`INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [
      key,
      value,
    ]);
  }

  async applyPack(p: PackApply): Promise<void> {
    const stmts: Array<{ sql: string; params?: unknown[] }> = [];
    for (const t of p.tombstones) {
      stmts.push({ sql: `INSERT INTO tombstone(item_id,revoked_rev) VALUES(?,?) ON CONFLICT(item_id) DO UPDATE SET revoked_rev=excluded.revoked_rev`, params: [t.itemId, t.revokedRev] });
      stmts.push({ sql: `DELETE FROM blob_index WHERE item_id=?`, params: [t.itemId] });
      stmts.push({ sql: `DELETE FROM articles WHERE item_id=?`, params: [t.itemId] });
      stmts.push({ sql: `DELETE FROM items WHERE item_id=?`, params: [t.itemId] });
    }
    for (const it of p.items) {
      stmts.push({
        sql: `INSERT INTO items(item_id,source,type,title,rev,content_hash,state,updated_at)
              VALUES(?,?,?,?,?,?,?,?)
              ON CONFLICT(item_id) DO UPDATE SET source=excluded.source,type=excluded.type,title=excluded.title,
                rev=excluded.rev,content_hash=excluded.content_hash,state=excluded.state,updated_at=excluded.updated_at`,
        params: [it.itemId, it.source, it.type, it.title, it.rev, it.contentHash, it.state, it.updatedAt],
      });
    }
    for (const a of p.articles) {
      stmts.push({
        sql: `INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,rev)
              VALUES(?,?,?,?,?,?,?,?)
              ON CONFLICT(item_id) DO UPDATE SET title=excluded.title,digest=excluded.digest,
                published_at=excluded.published_at,tags_json=excluded.tags_json,body_md=excluded.body_md,
                content_hash=excluded.content_hash,rev=excluded.rev`,
        params: [a.itemId, a.title, a.digest, a.publishedAt, a.tagsJson, a.bodyMd, a.contentHash, a.rev],
      });
    }
    stmts.push({ sql: `INSERT INTO config(key,value) VALUES('content_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, params: [String(p.version)] });
    stmts.push({ sql: `INSERT INTO config(key,value) VALUES('pack_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, params: [p.packId] });
    await this.db.tx(stmts);
  }

  async getItem(itemId: string): Promise<ItemRow | null> {
    const rows = await this.db.select(`SELECT item_id,source,type,title,rev,content_hash,state,updated_at FROM items WHERE item_id=?`, [itemId]);
    return rows.length > 0 ? toItemRow(rows[0]) : null;
  }

  async listItems(): Promise<ItemRow[]> {
    const rows = await this.db.select(`SELECT item_id,source,type,title,rev,content_hash,state,updated_at FROM items`);
    return rows.map(toItemRow);
  }

  async getArticle(itemId: string): Promise<ArticleRow | null> {
    const rows = await this.db.select(
      `SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,rev FROM articles WHERE item_id=?`,
      [itemId],
    );
    return rows.length > 0 ? toArticleRow(rows[0]) : null;
  }

  async hasBlob(blobId: string): Promise<boolean> {
    const rows = await this.db.select(`SELECT blob_id FROM blob_index WHERE blob_id=?`, [blobId]);
    return rows.length > 0;
  }

  async addBlob(blobId: string, itemId: string, path: string, size: number, verifiedAt: string): Promise<void> {
    await this.db.execute(
      `INSERT INTO blob_index(blob_id,item_id,path,size,verified_at) VALUES(?,?,?,?,?)
       ON CONFLICT(blob_id) DO UPDATE SET item_id=excluded.item_id,path=excluded.path,size=excluded.size,verified_at=excluded.verified_at`,
      [blobId, itemId, path, size, verifiedAt],
    );
  }

  async listTombstones(): Promise<TombstoneRow[]> {
    const rows = await this.db.select(`SELECT item_id,revoked_rev FROM tombstone`);
    return rows.map((r) => ({ itemId: String(r.item_id), revokedRev: Number(r.revoked_rev) }));
  }

  async findBlobPathByItem(itemId: string): Promise<string | null> {
    const rows = await this.db.select(`SELECT path FROM blob_index WHERE item_id=?`, [itemId]);
    return rows.length > 0 ? String(rows[0].path) : null;
  }

  async listBlobPathsByItem(itemId: string): Promise<string[]> {
    const rows = await this.db.select(`SELECT path FROM blob_index WHERE item_id=?`, [itemId]);
    return rows.map((r) => String(r.path));
  }
}

function toItemRow(r: Record<string, unknown>): ItemRow {
  return {
    itemId: String(r.item_id),
    source: String(r.source ?? ''),
    type: String(r.type ?? ''),
    title: String(r.title ?? ''),
    rev: String(r.rev ?? ''),
    contentHash: String(r.content_hash ?? ''),
    state: String(r.state ?? 'active'),
    updatedAt: String(r.updated_at ?? ''),
  };
}

function toArticleRow(r: Record<string, unknown>): ArticleRow {
  return {
    itemId: String(r.item_id),
    title: String(r.title ?? ''),
    digest: String(r.digest ?? ''),
    publishedAt: String(r.published_at ?? ''),
    tagsJson: String(r.tags_json ?? '[]'),
    bodyMd: String(r.body_md ?? ''),
    contentHash: String(r.content_hash ?? ''),
    rev: String(r.rev ?? ''),
  };
}