import type { LocalDb } from '../platform/adapter';
import { computeStats, favoriteNext, readAtNext } from './state';
import { progressWins } from './progress';
import { SEARCH_SQL, searchPattern } from './search';
import type { ArticleRow, CheckinDayRow, CommentOutRow, DmKeyRow, FavoriteRow, GroupKeyRow, GroupRow, ItemRow, LearningStats, MySubmissionRow, ProgressRow, QuizRow, SegmentRow, TagLinkRow, TombstoneRow } from './types';

export interface PackApply {
  version: number;
  packId: string;
  items: ItemRow[];
  articles: ArticleRow[];
  quizzes: QuizRow[];
  segments: SegmentRow[];
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
  /** 某容器条目的 segments 行，按 seq 升序 */
  listSegments(itemId: string): Promise<SegmentRow[]>;
  /**
   * 全部标签关联行，按 `tag_id ASC, kind ASC, target_id ASC`。
   * 标签列表页与「待补标签」反查都用它（本地数据量在 1e3 量级，不做分页）。
   */
  listTagLinks(): Promise<TagLinkRow[]>;
  /** 给定目标集合的关联行（顺序同上）；空数组直接返回 `[]`，不拼 SQL。 */
  listTagLinksOfTargets(targetIds: string[]): Promise<TagLinkRow[]>;
  /** 本地全部条目 id（id 平移要先看全量集合） */
  listLocalItemIds(): Promise<string[]>;
  /** 把以旧 id 为键的用户数据（user_state / quiz_attempt）改指到新 id；目标已有行则保留目标 */
  renameItemId(from: string, to: string): Promise<void>;
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
  /** 写/更新一个小组成员行（入组、续期、读回写都走它）。 */
  saveGroup(row: GroupRow): Promise<void>;
  /** 全部小组，按 `joined_at ASC`。 */
  listGroups(): Promise<GroupRow[]>;
  /** 读一组；不存在返回 null。 */
  getGroup(groupId: string): Promise<GroupRow | null>;
  /** 写一把 epoch 组密钥（同 `(group_id, epoch)` 覆盖）。epoch 大小的裁决在 `core/group.ts`，不在仓储层。 */
  putGroupKey(row: GroupKeyRow): Promise<void>;
  /** 某组的全部 epoch 密钥，按 `epoch ASC`（会话页一次取出建内存 map）。 */
  listGroupKeys(groupId: string): Promise<GroupKeyRow[]>;
  /** 写/覆盖一条好友会话密钥（同 `peer_id` 覆盖密钥、保留首次 `created_at`）。幂等与冲突的裁决在 `core/dm.ts`，不在仓储层。 */
  putDmKey(row: DmKeyRow): Promise<void>;
  /** 读一条；不存在返回 null。 */
  getDmKey(peerId: string): Promise<DmKeyRow | null>;
  /** 全部行，按 `created_at ASC`（好友列表本体，私信册 §5.1）。 */
  listDmKeys(): Promise<DmKeyRow[]>;
  /**
   * 写一行投稿台账（同 `item_id` 即更新）。台账是「我的条目」的列表本体，
   * 状态由本册 §9.3 的流转规则驱动，不由本方法决定。
   */
  saveSubmission(row: MySubmissionRow): Promise<void>;
  /** 台账全部行，按 `queued_at ASC`（补发取序）；传 `state` 即只取该状态。 */
  listSubmissions(state?: 'pending' | 'sent' | 'failed'): Promise<MySubmissionRow[]>;
  /** 读一行；不存在返回 null（更新模式回填编辑器用）。 */
  getSubmission(itemId: string): Promise<MySubmissionRow | null>;
  /** 送达：置 `sent`（终态）并回填服务端的 `created` 与送达时刻。 */
  markSubmissionSent(itemId: string, created: number, sentAt: string): Promise<void>;
  /** 永久失败：置 `failed` 并记原因。单向——失败项不会回到 `pending`（本册 §9.3）。 */
  markSubmissionFailed(itemId: string, reason: string): Promise<void>;
  /** 删一行：用户对 `pending` / `failed` 项点「删除」。`sent` 不可删（它是台账本体）。 */
  removeSubmission(itemId: string): Promise<void>;
  /**
   * 写一条本地进度（#8 册子 §5.2）：同一事务 upsert `progress`（`dirty=1`）+ insert-or-ignore `checkin_days`。
   * upsert 受 §3.4 LWW 守卫（`progressWins`）；**打卡不受守卫**——打卡是**事件级**语义，
   * 即使进度行输了 LWW，该事件带来的打卡日照样写（否则同一 issue 的形态会丢打卡）。
   */
  saveProgressLocal(row: ProgressRow): Promise<void>;
  /**
   * 把 `GET /v1/me` 拉回的远程行按 §3.4 同一比较函数合并进本地（#8 册子 §5.5）。
   * 合并写入的 `dirty` 固定 0（已同步）；无一行变更时**不写库**。
   */
  mergeProgress(rows: ProgressRow[], days: CheckinDayRow[]): Promise<void>;
  /** 全部进度行，按 `item_id ASC`（页面渲染只读本地表）。 */
  listProgress(): Promise<ProgressRow[]>;
  /** 读一条；不存在返回 null（续位用）。 */
  getProgress(itemId: string): Promise<ProgressRow | null>;
  /** 全部打卡日，按 `day ASC`（连续天数回溯用）。 */
  listCheckinDays(): Promise<CheckinDayRow[]>;
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
  `CREATE TABLE IF NOT EXISTS segments(
     item_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
     content_hash TEXT NOT NULL, PRIMARY KEY(item_id, seq))`,
  `CREATE INDEX IF NOT EXISTS idx_segments_item ON segments(item_id)`,
  `CREATE TABLE IF NOT EXISTS my_submissions(
     item_id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, body_md TEXT NOT NULL,
     question_json TEXT NOT NULL, links_json TEXT NOT NULL DEFAULT '', segments_json TEXT NOT NULL DEFAULT '',
     state TEXT NOT NULL, reason TEXT, created INTEGER NOT NULL,
     queued_at TEXT NOT NULL, sent_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_my_submissions_queued ON my_submissions(queued_at)`,
  `CREATE TABLE IF NOT EXISTS groups(
     group_id TEXT PRIMARY KEY, name TEXT NOT NULL, creator_id TEXT NOT NULL, epoch INTEGER NOT NULL,
     encrypted INTEGER NOT NULL DEFAULT 1, roster_rev INTEGER NOT NULL DEFAULT 0,
     member_ids_json TEXT NOT NULL, joined_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS group_keys(
     group_id TEXT NOT NULL, epoch INTEGER NOT NULL, key_cipher TEXT NOT NULL, created_at TEXT NOT NULL,
     PRIMARY KEY(group_id, epoch))`,
  `CREATE TABLE IF NOT EXISTS dm_keys(
     peer_id TEXT PRIMARY KEY, key_cipher TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tag_links(
     tag_id TEXT NOT NULL, target_id TEXT NOT NULL, kind TEXT NOT NULL,
     PRIMARY KEY(tag_id, target_id))`,
  `CREATE INDEX IF NOT EXISTS idx_tag_links_target ON tag_links(target_id)`,
  `CREATE TABLE IF NOT EXISTS progress(
     item_id TEXT PRIMARY KEY, position INTEGER NOT NULL, done INTEGER NOT NULL,
     day TEXT NOT NULL, updated_at INTEGER NOT NULL, event_id TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS checkin_days(
     day TEXT PRIMARY KEY, first_event_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
];

/**
 * 存量库幂等补列（`CREATE TABLE IF NOT EXISTS` 对既有表不补列）。
 * 由 `platform/index.ts` 在建表之后调用；`PRAGMA table_info` 查列名，缺则 `ALTER`。
 */
export async function ensureGroupColumns(db: LocalDb): Promise<void> {
  const cols = new Set((await db.select(`PRAGMA table_info(groups)`)).map((r) => String(r.name)));
  if (!cols.has('encrypted')) {
    await db.execute(`ALTER TABLE groups ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 1`);
  }
  if (!cols.has('roster_rev')) {
    await db.execute(`ALTER TABLE groups ADD COLUMN roster_rev INTEGER NOT NULL DEFAULT 0`);
  }
}

/**
 * 存量库幂等补列（`my_submissions.links_json`，#37）。
 * `CREATE TABLE IF NOT EXISTS` 对既有表不补列，故与 `ensureGroupColumns` 同一手法。
 */
export async function ensureSubmissionColumns(db: LocalDb): Promise<void> {
  const cols = new Set((await db.select(`PRAGMA table_info(my_submissions)`)).map((r) => String(r.name)));
  if (!cols.has('links_json')) {
    await db.execute(`ALTER TABLE my_submissions ADD COLUMN links_json TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.has('segments_json')) {
    await db.execute(`ALTER TABLE my_submissions ADD COLUMN segments_json TEXT NOT NULL DEFAULT ''`);
  }
}

/**
 * 存量库幂等补列（`progress` 表，#8 册子 §5.1）。
 * 总纲 §9 早已预留 `progress(item_id, position, updated_at, dirty)` 四列形态，
 * 本册补 `done` / `day` / `event_id` 三列；`CREATE TABLE IF NOT EXISTS` 对既有表不补列，故沿用同款手法。
 * 表本身不存在（`PRAGMA table_info` 返回空）说明是首启前的空库，直接跳过，等 DDL 建全。
 */
export async function ensureProgressColumns(db: LocalDb): Promise<void> {
  const cols = new Set((await db.select(`PRAGMA table_info(progress)`)).map((r) => String(r.name)));
  if (cols.size === 0) return;
  if (!cols.has('done')) {
    await db.execute(`ALTER TABLE progress ADD COLUMN done INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.has('day')) {
    await db.execute(`ALTER TABLE progress ADD COLUMN day TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.has('event_id')) {
    await db.execute(`ALTER TABLE progress ADD COLUMN event_id TEXT NOT NULL DEFAULT ''`);
  }
}

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
      stmts.push({ sql: `DELETE FROM segments WHERE item_id=?`, params: [t.itemId] });
      stmts.push({ sql: `DELETE FROM tag_links WHERE tag_id=?`, params: [t.itemId] });
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
    const segItems = new Set(p.segments.map((s) => s.itemId));
    for (const id of segItems) {
      stmts.push({ sql: `DELETE FROM segments WHERE item_id=?`, params: [id] });
    }
    for (const s of p.segments) {
      stmts.push({
        sql: `INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`,
        params: [s.itemId, s.seq, s.kind, s.text, s.contentHash],
      });
    }
    // 标签派生表：包里的 tag/* 条目的 segments 行 = (kind, target_id)。与 segments 同一取舍：先删后插。
    const incomingTagIds = new Set(p.segments.filter((s) => s.itemId.startsWith('tag/')).map((s) => s.itemId));
    for (const id of incomingTagIds) {
      stmts.push({ sql: `DELETE FROM tag_links WHERE tag_id=?`, params: [id] });
    }
    for (const s of p.segments) {
      if (!s.itemId.startsWith('tag/')) continue;
      stmts.push({
        sql: `INSERT INTO tag_links(tag_id,target_id,kind) VALUES(?,?,?)
              ON CONFLICT(tag_id,target_id) DO UPDATE SET kind=excluded.kind`,
        params: [s.itemId, s.text, s.kind],
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

  async listSegments(itemId: string): Promise<SegmentRow[]> {
    const rows = await this.db.select(
      `SELECT item_id,seq,kind,text,content_hash FROM segments WHERE item_id=? ORDER BY seq ASC`,
      [itemId],
    );
    return rows.map(toSegmentRow);
  }

  async listTagLinks(): Promise<TagLinkRow[]> {
    const rows = await this.db.select(
      `SELECT tag_id,target_id,kind FROM tag_links ORDER BY tag_id ASC, kind ASC, target_id ASC`,
    );
    return rows.map(toTagLinkRow);
  }

  async listTagLinksOfTargets(targetIds: string[]): Promise<TagLinkRow[]> {
    if (targetIds.length === 0) return [];
    const marks = targetIds.map(() => '?').join(',');
    const rows = await this.db.select(
      `SELECT tag_id,target_id,kind FROM tag_links WHERE target_id IN (${marks}) ORDER BY tag_id ASC, kind ASC, target_id ASC`,
      targetIds,
    );
    return rows.map(toTagLinkRow);
  }

  async listLocalItemIds(): Promise<string[]> {
    const rows = await this.db.select(`SELECT item_id FROM items`);
    return rows.map((r) => String(r.item_id));
  }

  async renameItemId(from: string, to: string): Promise<void> {
    await this.db.tx([
      { sql: `UPDATE OR IGNORE user_state SET item_id=? WHERE item_id=?`, params: [to, from] },
      { sql: `DELETE FROM user_state WHERE item_id=?`, params: [from] },
      { sql: `UPDATE OR IGNORE quiz_attempt SET item_id=? WHERE item_id=?`, params: [to, from] },
      { sql: `DELETE FROM quiz_attempt WHERE item_id=?`, params: [from] },
    ]);
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

  async saveGroup(row: GroupRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO groups(group_id,name,creator_id,epoch,encrypted,roster_rev,member_ids_json,joined_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(group_id) DO UPDATE SET name=excluded.name,creator_id=excluded.creator_id,
         epoch=excluded.epoch,encrypted=excluded.encrypted,roster_rev=excluded.roster_rev,
         member_ids_json=excluded.member_ids_json`,
      [row.groupId, row.name, row.creatorId, row.epoch, row.encrypted, row.rosterRev, row.memberIdsJson, row.joinedAt],
    );
  }

  async listGroups(): Promise<GroupRow[]> {
    const rows = await this.db.select(`SELECT group_id,name,creator_id,epoch,encrypted,roster_rev,member_ids_json,joined_at FROM groups ORDER BY joined_at ASC`);
    return rows.map(toGroupRow);
  }

  async getGroup(groupId: string): Promise<GroupRow | null> {
    const rows = await this.db.select(`SELECT group_id,name,creator_id,epoch,encrypted,roster_rev,member_ids_json,joined_at FROM groups WHERE group_id=?`, [groupId]);
    return rows.length > 0 ? toGroupRow(rows[0]) : null;
  }

  async putGroupKey(row: GroupKeyRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO group_keys(group_id,epoch,key_cipher,created_at) VALUES(?,?,?,?)
       ON CONFLICT(group_id,epoch) DO UPDATE SET key_cipher=excluded.key_cipher`,
      [row.groupId, row.epoch, row.keyCipher, row.createdAt],
    );
  }

  async listGroupKeys(groupId: string): Promise<GroupKeyRow[]> {
    const rows = await this.db.select(`SELECT group_id,epoch,key_cipher,created_at FROM group_keys WHERE group_id=? ORDER BY epoch ASC`, [groupId]);
    return rows.map(toGroupKeyRow);
  }

  async putDmKey(row: DmKeyRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO dm_keys(peer_id,key_cipher,created_at) VALUES(?,?,?)
       ON CONFLICT(peer_id) DO UPDATE SET key_cipher=excluded.key_cipher`,
      [row.peerId, row.keyCipher, row.createdAt],
    );
  }

  async getDmKey(peerId: string): Promise<DmKeyRow | null> {
    const rows = await this.db.select(`SELECT peer_id,key_cipher,created_at FROM dm_keys WHERE peer_id=?`, [peerId]);
    return rows.length > 0 ? toDmKeyRow(rows[0]) : null;
  }

  async listDmKeys(): Promise<DmKeyRow[]> {
    const rows = await this.db.select(`SELECT peer_id,key_cipher,created_at FROM dm_keys ORDER BY created_at ASC`);
    return rows.map(toDmKeyRow);
  }

  async saveSubmission(row: MySubmissionRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO my_submissions(item_id,type,title,body_md,question_json,links_json,segments_json,state,reason,created,queued_at,sent_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(item_id) DO UPDATE SET type=excluded.type,title=excluded.title,body_md=excluded.body_md,
         question_json=excluded.question_json,links_json=excluded.links_json,segments_json=excluded.segments_json,
         state=excluded.state,reason=excluded.reason,
         created=excluded.created,queued_at=excluded.queued_at,sent_at=excluded.sent_at`,
      [row.itemId, row.type, row.title, row.bodyMd, row.questionJson, row.linksJson, row.segmentsJson, row.state, row.reason, row.created, row.queuedAt, row.sentAt],
    );
  }

  async listSubmissions(state?: 'pending' | 'sent' | 'failed'): Promise<MySubmissionRow[]> {
    const cols = `item_id,type,title,body_md,question_json,links_json,segments_json,state,reason,created,queued_at,sent_at`;
    const rows = state
      ? await this.db.select(`SELECT ${cols} FROM my_submissions WHERE state=? ORDER BY queued_at ASC`, [state])
      : await this.db.select(`SELECT ${cols} FROM my_submissions ORDER BY queued_at ASC`);
    return rows.map(toMySubmissionRow);
  }

  async getSubmission(itemId: string): Promise<MySubmissionRow | null> {
    const rows = await this.db.select(
      `SELECT item_id,type,title,body_md,question_json,links_json,segments_json,state,reason,created,queued_at,sent_at FROM my_submissions WHERE item_id=?`,
      [itemId],
    );
    return rows.length > 0 ? toMySubmissionRow(rows[0]) : null;
  }

  async markSubmissionSent(itemId: string, created: number, sentAt: string): Promise<void> {
    await this.db.execute(`UPDATE my_submissions SET state='sent', reason=NULL, created=?, sent_at=? WHERE item_id=?`, [
      created,
      sentAt,
      itemId,
    ]);
  }

  async markSubmissionFailed(itemId: string, reason: string): Promise<void> {
    await this.db.execute(`UPDATE my_submissions SET state='failed', reason=? WHERE item_id=?`, [reason, itemId]);
  }

  async removeSubmission(itemId: string): Promise<void> {
    await this.db.execute(`DELETE FROM my_submissions WHERE item_id=?`, [itemId]);
  }

  async saveProgressLocal(row: ProgressRow): Promise<void> {
    // LocalDb.tx 只写不读 ⇒ 先单独读当前行，再在一个事务里落下两条语句。
    const cur = await this.getProgress(row.itemId);
    const stmts: Array<{ sql: string; params?: unknown[] }> = [];
    if (cur === null || progressWins(row.updatedAt, row.eventId, cur.updatedAt, cur.eventId)) {
      stmts.push({
        sql: `INSERT INTO progress(item_id,position,done,day,updated_at,event_id,dirty) VALUES(?,?,?,?,?,?,1)
              ON CONFLICT(item_id) DO UPDATE SET position=excluded.position,done=excluded.done,
                day=excluded.day,updated_at=excluded.updated_at,event_id=excluded.event_id,dirty=1`,
        params: [row.itemId, row.position, row.done ? 1 : 0, row.day, row.updatedAt, row.eventId],
      });
    }
    stmts.push({
      sql: `INSERT INTO checkin_days(day,first_event_id,created_at) VALUES(?,?,?) ON CONFLICT(day) DO NOTHING`,
      params: [row.day, row.eventId, row.updatedAt],
    });
    await this.db.tx(stmts);
  }

  async mergeProgress(rows: ProgressRow[], days: CheckinDayRow[]): Promise<void> {
    const cur = new Map((await this.listProgress()).map((r) => [r.itemId, r]));
    const stmts: Array<{ sql: string; params?: unknown[] }> = [];
    for (const row of rows) {
      const prev = cur.get(row.itemId);
      if (prev !== undefined && !progressWins(row.updatedAt, row.eventId, prev.updatedAt, prev.eventId)) continue;
      stmts.push({
        sql: `INSERT INTO progress(item_id,position,done,day,updated_at,event_id,dirty) VALUES(?,?,?,?,?,?,0)
              ON CONFLICT(item_id) DO UPDATE SET position=excluded.position,done=excluded.done,
                day=excluded.day,updated_at=excluded.updated_at,event_id=excluded.event_id,dirty=0`,
        params: [row.itemId, row.position, row.done ? 1 : 0, row.day, row.updatedAt, row.eventId],
      });
      cur.set(row.itemId, { ...row, dirty: false });
    }
    for (const d of days) {
      stmts.push({
        sql: `INSERT INTO checkin_days(day,first_event_id,created_at) VALUES(?,?,?) ON CONFLICT(day) DO NOTHING`,
        params: [d.day, d.firstEventId, d.createdAt],
      });
    }
    if (stmts.length === 0) return;
    await this.db.tx(stmts);
  }

  async listProgress(): Promise<ProgressRow[]> {
    const rows = await this.db.select(
      `SELECT item_id,position,done,day,updated_at,event_id,dirty FROM progress ORDER BY item_id ASC`,
    );
    return rows.map(toProgressRow);
  }

  async getProgress(itemId: string): Promise<ProgressRow | null> {
    const rows = await this.db.select(
      `SELECT item_id,position,done,day,updated_at,event_id,dirty FROM progress WHERE item_id=?`,
      [itemId],
    );
    return rows.length > 0 ? toProgressRow(rows[0]) : null;
  }

  async listCheckinDays(): Promise<CheckinDayRow[]> {
    const rows = await this.db.select(`SELECT day,first_event_id,created_at FROM checkin_days ORDER BY day ASC`);
    return rows.map(toCheckinDayRow);
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

function toSegmentRow(r: Record<string, unknown>): SegmentRow {
  return {
    itemId: String(r.item_id),
    seq: Number(r.seq),
    kind: String(r.kind ?? ''),
    text: String(r.text ?? ''),
    contentHash: String(r.content_hash),
  };
}

function toTagLinkRow(r: Record<string, unknown>): TagLinkRow {
  return {
    tagId: String(r.tag_id ?? ''),
    targetId: String(r.target_id ?? ''),
    kind: String(r.kind ?? ''),
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

function toGroupRow(r: Record<string, unknown>): GroupRow {
  return {
    groupId: String(r.group_id),
    name: String(r.name ?? ''),
    creatorId: String(r.creator_id ?? ''),
    epoch: Number(r.epoch ?? 1),
    // 读时容错：老 DB 无这两列 ⇒ 缺省封闭（AC 13）、roster_rev 缺省 0
    encrypted: r.encrypted === undefined || r.encrypted === null ? 1 : Number(r.encrypted),
    rosterRev: r.roster_rev === undefined || r.roster_rev === null ? 0 : Number(r.roster_rev),
    memberIdsJson: String(r.member_ids_json ?? '[]'),
    joinedAt: String(r.joined_at ?? ''),
  };
}

function toGroupKeyRow(r: Record<string, unknown>): GroupKeyRow {
  return {
    groupId: String(r.group_id),
    epoch: Number(r.epoch),
    keyCipher: String(r.key_cipher ?? ''),
    createdAt: String(r.created_at ?? ''),
  };
}

function toDmKeyRow(r: Record<string, unknown>): DmKeyRow {
  return {
    peerId: String(r.peer_id ?? ''),
    keyCipher: String(r.key_cipher ?? ''),
    createdAt: String(r.created_at ?? ''),
  };
}

function toMySubmissionRow(r: Record<string, unknown>): MySubmissionRow {
  const state = String(r.state);
  const raw = String(r.type);
  const type: MySubmissionRow['type'] =
    raw === 'quiz' || raw === 'tag' || raw === 'course' || raw === 'lesson' ? raw : 'article';
  return {
    itemId: String(r.item_id),
    type,
    title: String(r.title ?? ''),
    bodyMd: String(r.body_md ?? ''),
    questionJson: String(r.question_json ?? ''),
    linksJson: String(r.links_json ?? ''),
    segmentsJson: String(r.segments_json ?? ''),
    state: state === 'sent' ? 'sent' : state === 'failed' ? 'failed' : 'pending',
    reason: toNullableString(r.reason),
    created: Number(r.created ?? 0),
    queuedAt: String(r.queued_at ?? ''),
    sentAt: String(r.sent_at ?? ''),
  };
}

function toProgressRow(r: Record<string, unknown>): ProgressRow {
  return {
    itemId: String(r.item_id),
    position: Number(r.position ?? 0),
    done: Number(r.done ?? 0) !== 0,
    day: String(r.day ?? ''),
    updatedAt: Number(r.updated_at ?? 0),
    eventId: String(r.event_id ?? ''),
    dirty: Number(r.dirty ?? 0) !== 0,
  };
}

function toCheckinDayRow(r: Record<string, unknown>): CheckinDayRow {
  return {
    day: String(r.day),
    firstEventId: String(r.first_event_id ?? ''),
    createdAt: Number(r.created_at ?? 0),
  };
}
