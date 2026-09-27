import type { LocalDb } from '../platform/adapter';
import { computeStats, favoriteNext, readAtNext } from './state';
import { SEARCH_SQL, searchPattern } from './search';
import type { ArticleRow, CommentOutRow, FavoriteRow, ItemRow, LearningStats, QuizRow, TombstoneRow } from './types';

export interface PackApply {
  version: number;
  packId: string;
  items: ItemRow[];
  articles: ArticleRow[];
  quizzes: QuizRow[];
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
  toggleFavorite(itemId: string, at: string): Promise<boolean>;
  isFavorite(itemId: string): Promise<boolean>;
  listFavorites(): Promise<FavoriteRow[]>;
  markRead(itemId: string, at: string): Promise<void>;
  searchArticles(q: string): Promise<ArticleRow[]>;
  listQuizItems(): Promise<ItemRow[]>;
  getQuiz(itemId: string): Promise<QuizRow | null>;
  addAttempt(itemId: string, correct: number, total: number, at: string): Promise<void>;
  learningStats(): Promise<LearningStats>;
  /**
   * 入队一条待发评论。同 `event_id` 重复入队无副作用（本册 §3.2）。
   * 只由「离线发表」调用；补发一律走 `flushPending`。
   */
  enqueueComment(row: CommentOutRow): Promise<void>;
  /** 全部待发项，按 `queued_at ASC`（先入队先补发）。 */
  listCommentOut(): Promise<CommentOutRow[]>;
  /** 置为永久失败并记原因。单向：失败项不会回到 pending（本册 §5.1）。 */
  markCommentOutFailed(eventId: string, reason: string): Promise<void>;
  /** 删一条：用户对失败项点「删除」，或补发成功后清行。 */
  removeCommentOut(eventId: string): Promise<void>;
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
  `CREATE TABLE IF NOT EXISTS user_state(
     item_id TEXT PRIMARY KEY, favorited_at TEXT, read_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS quizzes(
     item_id TEXT PRIMARY KEY, question_json TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS quiz_attempt(
     item_id TEXT NOT NULL, answered_at TEXT NOT NULL, correct INTEGER NOT NULL, total INTEGER NOT NULL,
     PRIMARY KEY(item_id, answered_at))`,
  `CREATE TABLE IF NOT EXISTS comment_out(
     event_id TEXT PRIMARY KEY, target_id TEXT NOT NULL, text TEXT NOT NULL, reply_to TEXT,
     wire TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, queued_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_comment_out_queued ON comment_out(queued_at)`,
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
      stmts.push({ sql: `DELETE FROM quizzes WHERE item_id=?`, params: [t.itemId] });
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
    for (const q of p.quizzes) {
      stmts.push({
        sql: `INSERT INTO quizzes(item_id,question_json,content_hash)
              VALUES(?,?,?)
              ON CONFLICT(item_id) DO UPDATE SET question_json=excluded.question_json,content_hash=excluded.content_hash`,
        params: [q.itemId, q.questionJson, q.contentHash],
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

  async toggleFavorite(itemId: string, at: string): Promise<boolean> {
    const rows = await this.db.select(`SELECT favorited_at FROM user_state WHERE item_id=?`, [itemId]);
    const cur = rows.length > 0 ? toNullableString(rows[0].favorited_at) : null;
    const next = favoriteNext(cur, at);
    await this.db.execute(
      `INSERT INTO user_state(item_id,favorited_at) VALUES(?,?)
       ON CONFLICT(item_id) DO UPDATE SET favorited_at=excluded.favorited_at`,
      [itemId, next.favoritedAt],
    );
    return next.isFavorite;
  }

  async isFavorite(itemId: string): Promise<boolean> {
    const rows = await this.db.select(
      `SELECT item_id FROM user_state WHERE item_id=? AND favorited_at IS NOT NULL`,
      [itemId],
    );
    return rows.length > 0;
  }

  async listFavorites(): Promise<FavoriteRow[]> {
    const rows = await this.db.select(
      `SELECT u.item_id AS item_id, i.title AS title, u.favorited_at AS favorited_at
       FROM user_state u INNER JOIN items i ON i.item_id=u.item_id
       WHERE u.favorited_at IS NOT NULL
       ORDER BY u.favorited_at DESC`,
    );
    return rows.map((r) => ({
      itemId: String(r.item_id),
      title: String(r.title ?? ''),
      favoritedAt: String(r.favorited_at ?? ''),
    }));
  }

  async markRead(itemId: string, at: string): Promise<void> {
    const rows = await this.db.select(`SELECT read_at FROM user_state WHERE item_id=?`, [itemId]);
    const cur = rows.length > 0 ? toNullableString(rows[0].read_at) : null;
    await this.db.execute(
      `INSERT INTO user_state(item_id,read_at) VALUES(?,?)
       ON CONFLICT(item_id) DO UPDATE SET read_at=excluded.read_at`,
      [itemId, readAtNext(cur, at)],
    );
  }

  async searchArticles(q: string): Promise<ArticleRow[]> {
    const pattern = searchPattern(q);
    if (pattern === null) return [];
    const rows = await this.db.select(SEARCH_SQL, [pattern, pattern, pattern]);
    return rows.map(toArticleRow);
  }

  async listQuizItems(): Promise<ItemRow[]> {
    const rows = await this.db.select(
      `SELECT item_id,source,type,title,rev,content_hash,state,updated_at FROM items WHERE type='quiz'`,
    );
    return rows.map(toItemRow);
  }

  async getQuiz(itemId: string): Promise<QuizRow | null> {
    const rows = await this.db.select(`SELECT item_id,question_json,content_hash FROM quizzes WHERE item_id=?`, [itemId]);
    if (rows.length === 0) return null;
    return {
      itemId: String(rows[0].item_id),
      questionJson: String(rows[0].question_json ?? ''),
      contentHash: String(rows[0].content_hash ?? ''),
    };
  }

  async addAttempt(itemId: string, correct: number, total: number, at: string): Promise<void> {
    await this.db.execute(`INSERT INTO quiz_attempt(item_id,answered_at,correct,total) VALUES(?,?,?,?)`, [
      itemId,
      at,
      correct,
      total,
    ]);
  }

  async learningStats(): Promise<LearningStats> {
    const readRows = await this.db.select(
      `SELECT count(*) AS n, MAX(read_at) AS m FROM user_state WHERE read_at IS NOT NULL`,
    );
    const quizRows = await this.db.select(
      `SELECT count(*) AS n, COALESCE(SUM(correct),0) AS c, COALESCE(SUM(total),0) AS t, MAX(answered_at) AS m FROM quiz_attempt`,
    );
    return computeStats({
      readCount: Number(readRows[0]?.n ?? 0),
      attempts: Number(quizRows[0]?.n ?? 0),
      correct: Number(quizRows[0]?.c ?? 0),
      total: Number(quizRows[0]?.t ?? 0),
      readLast: String(readRows[0]?.m ?? ''),
      quizLast: String(quizRows[0]?.m ?? ''),
    });
  }

  async enqueueComment(row: CommentOutRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO comment_out(event_id,target_id,text,reply_to,wire,state,reason,queued_at)
       VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`,
      [row.eventId, row.targetId, row.text, row.replyTo, row.wire, row.state, row.reason, row.queuedAt],
    );
  }

  async listCommentOut(): Promise<CommentOutRow[]> {
    const rows = await this.db.select(
      `SELECT event_id,target_id,text,reply_to,wire,state,reason,queued_at FROM comment_out ORDER BY queued_at ASC`,
    );
    return rows.map(toCommentOutRow);
  }

  async markCommentOutFailed(eventId: string, reason: string): Promise<void> {
    await this.db.execute(`UPDATE comment_out SET state='failed', reason=? WHERE event_id=?`, [reason, eventId]);
  }

  async removeCommentOut(eventId: string): Promise<void> {
    await this.db.execute(`DELETE FROM comment_out WHERE event_id=?`, [eventId]);
  }
}

function toNullableString(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
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

function toCommentOutRow(r: Record<string, unknown>): CommentOutRow {
  return {
    eventId: String(r.event_id),
    targetId: String(r.target_id),
    text: String(r.text),
    replyTo: toNullableString(r.reply_to),
    wire: String(r.wire),
    state: String(r.state) === 'failed' ? 'failed' : 'pending',
    reason: toNullableString(r.reason),
    queuedAt: String(r.queued_at),
  };
}