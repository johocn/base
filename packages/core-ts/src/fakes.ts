// 测试用假实现：只在 Node 下跑，App 代码不引用本文件。
import type { Adapters, FsAdapter, HttpAdapter, HttpResponse, LocalDb, PackReader, SqliteConnection, StorageAdapter } from './platform/adapter';
import { computeStats, favoriteNext, readAtNext } from './state';
import { searchPattern } from './search';
import type { ArticleRow, CheckinDayRow, CommentOutRow, DmKeyRow, FavoriteRow, GroupKeyRow, GroupRow, ItemRow, LearningStats, MySubmissionRow, ProgressRow, QuizRow, SegmentRow, TagLinkRow, TombstoneRow } from './types';
import type { LocalContainerInput, LocalRepo, PackApply } from './repo';
import type { SubmitSegmentRow } from '@base/protocol-ts';
import { progressWins } from '@base/protocol-ts';

export class MemoryFs implements FsAdapter {
  files = new Map<string, Uint8Array>();
  async rootDir(): Promise<string> {
    return '/work';
  }
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
  }
  async readFile(path: string): Promise<Uint8Array> {
    const v = this.files.get(path);
    if (!v) throw new Error(`no such file: ${path}`);
    return v;
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  async size(path: string): Promise<number> {
    return this.files.get(path)?.length ?? 0;
  }
}

export class MemoryStorage implements StorageAdapter {
  map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
}

export class MemoryRepo implements LocalRepo {
  config = new Map<string, string>();
  items = new Map<string, ItemRow>();
  articles = new Map<string, ArticleRow>();
  blobs = new Map<string, { ownerId: string; itemId: string; path: string; size: number; verifiedAt: string }>();
  tombstones = new Map<string, TombstoneRow>();
  segments = new Map<string, SegmentRow[]>();
  tagLinks = new Map<string, TagLinkRow>(); // `${tagId}\t${targetId}` -> row

  async getConfig(key: string): Promise<string | null> {
    return this.config.get(key) ?? null;
  }
  async setConfig(key: string, value: string): Promise<void> {
    this.config.set(key, value);
  }
  async applyPack(p: PackApply): Promise<void> {
    for (const t of p.tombstones) {
      this.tombstones.set(t.itemId, t);
      this.items.delete(t.itemId);
      this.articles.delete(t.itemId);
      this.quizzes.delete(t.itemId);
      this.segments.delete(t.itemId);
      for (const [k, r] of [...this.tagLinks]) {
        if (r.tagId === t.itemId) this.tagLinks.delete(k);
      }
      for (const [id, b] of [...this.blobs]) {
        if (b.itemId === t.itemId) this.blobs.delete(id);
      }
    }
    for (const it of p.items) this.items.set(it.itemId, it);
    for (const a of p.articles) this.articles.set(a.itemId, a);
    for (const q of p.quizzes) this.quizzes.set(q.itemId, q);
    const segItems = new Set(p.segments.map((s) => s.itemId));
    for (const id of segItems) this.segments.set(id, []);
    for (const s of p.segments) this.segments.set(s.itemId, [...(this.segments.get(s.itemId) ?? []), s]);
    for (const [id, list] of this.segments) this.segments.set(id, [...list].sort((a, b) => a.seq - b.seq));
    const tagIds = new Set(p.segments.filter((s) => s.itemId.startsWith('tag/')).map((s) => s.itemId));
    for (const [k, r] of [...this.tagLinks]) {
      if (tagIds.has(r.tagId)) this.tagLinks.delete(k);
    }
    for (const s of p.segments) {
      if (!s.itemId.startsWith('tag/')) continue;
      this.tagLinks.set(`${s.itemId}\t${s.text}`, { tagId: s.itemId, targetId: s.text, kind: s.kind });
    }
    this.config.set('content_version', String(p.version));
    this.config.set('pack_id', p.packId);
  }
  async getItem(itemId: string): Promise<ItemRow | null> {
    return this.items.get(itemId) ?? null;
  }
  async listItems(): Promise<ItemRow[]> {
    return [...this.items.values()];
  }
  async getArticle(itemId: string): Promise<ArticleRow | null> {
    return this.articles.get(itemId) ?? null;
  }
  async listSegments(itemId: string): Promise<SegmentRow[]> {
    return [...(this.segments.get(itemId) ?? [])].sort((a, b) => a.seq - b.seq);
  }
  async listTagLinks(): Promise<TagLinkRow[]> {
    return [...this.tagLinks.values()].sort(cmpTagLink);
  }
  async listTagLinksOfTargets(targetIds: string[]): Promise<TagLinkRow[]> {
    const want = new Set(targetIds);
    return [...this.tagLinks.values()].filter((r) => want.has(r.targetId)).sort(cmpTagLink);
  }
  async listLocalItemIds(): Promise<string[]> {
    return [...this.items.keys()];
  }
  async renameItemId(from: string, to: string): Promise<void> {
    if (this.favorites.has(from)) {
      if (!this.favorites.has(to)) this.favorites.set(to, this.favorites.get(from)!);
      this.favorites.delete(from);
    }
    if (this.reads.has(from)) {
      if (!this.reads.has(to)) this.reads.set(to, this.reads.get(from)!);
      this.reads.delete(from);
    }
    const kept = this.attempts.filter((a) => !(a.itemId === from && this.attempts.some((b) => b.itemId === to && b.at === a.at)));
    this.attempts = kept.map((a) => (a.itemId === from ? { ...a, itemId: to } : a));
  }
  async hasBlob(id: string): Promise<boolean> {
    return this.blobs.has(id);
  }
  async addBlob(id: string, ownerId: string, path: string, size: number, verifiedAt: string, _originalName?: string, _contentType?: string, itemId?: string): Promise<void> {
    this.blobs.set(id, { ownerId, itemId: itemId ?? '', path, size, verifiedAt });
  }
  async findBlobPathByItem(itemId: string): Promise<string | null> {
    for (const b of this.blobs.values()) {
      if (b.itemId === itemId) return b.path;
    }
    return null;
  }
  async listBlobPathsByItem(itemId: string): Promise<string[]> {
    const out: string[] = [];
    for (const b of this.blobs.values()) {
      if (b.itemId === itemId) out.push(b.path);
    }
    return out;
  }
  async listTombstones(): Promise<TombstoneRow[]> {
    return [...this.tombstones.values()];
  }

  favorites = new Map<string, string>(); // itemId -> favorited_at
  reads = new Map<string, string>(); // itemId -> read_at
  quizzes = new Map<string, QuizRow>();
  attempts: Array<{ itemId: string; at: string; correct: number; total: number }> = [];

  async toggleFavorite(itemId: string, at: string): Promise<boolean> {
    const next = favoriteNext(this.favorites.get(itemId) ?? null, at);
    if (next.favoritedAt === null) {
      this.favorites.delete(itemId);
    } else {
      this.favorites.set(itemId, next.favoritedAt);
    }
    return next.isFavorite;
  }
  async isFavorite(itemId: string): Promise<boolean> {
    return this.favorites.has(itemId);
  }
  async listFavorites(): Promise<FavoriteRow[]> {
    const out: FavoriteRow[] = [];
    for (const [itemId, favoritedAt] of this.favorites) {
      const it = this.items.get(itemId);
      if (!it) continue; // 条目被 tombstone 撤下后收藏自动消失
      out.push({ itemId, title: it.title, favoritedAt });
    }
    return out.sort((a, b) => (a.favoritedAt < b.favoritedAt ? 1 : -1));
  }
  async markRead(itemId: string, at: string): Promise<void> {
    this.reads.set(itemId, readAtNext(this.reads.get(itemId) ?? null, at));
  }
  async searchArticles(q: string): Promise<ArticleRow[]> {
    const pattern = searchPattern(q);
    if (pattern === null) return [];
    const needle = pattern.slice(1, -1).replace(/\\(.)/g, '$1').toLowerCase();
    return [...this.articles.values()]
      .filter((a) => a.title.toLowerCase().includes(needle) || a.bodyMd.toLowerCase().includes(needle))
      .slice(0, 50);
  }
  async listQuizItems(): Promise<ItemRow[]> {
    return [...this.items.values()].filter((i) => i.type === 'quiz');
  }
  async getQuiz(itemId: string): Promise<QuizRow | null> {
    return this.quizzes.get(itemId) ?? null;
  }
  async addAttempt(itemId: string, correct: number, total: number, at: string): Promise<void> {
    this.attempts.push({ itemId, at, correct, total });
  }
  async learningStats(): Promise<LearningStats> {
    const readLast = [...this.reads.values()].sort().at(-1) ?? '';
    const quizLast = this.attempts.map((a) => a.at).sort().at(-1) ?? '';
    return computeStats({
      readCount: this.reads.size,
      attempts: this.attempts.length,
      correct: this.attempts.reduce((n, a) => n + a.correct, 0),
      total: this.attempts.reduce((n, a) => n + a.total, 0),
      readLast,
      quizLast,
    });
  }

  commentOut = new Map<string, CommentOutRow>(); // eventId -> row

  async enqueueComment(row: CommentOutRow): Promise<void> {
    // 同 event_id 重复入队无副作用（与 SqlRepo 的 ON CONFLICT DO NOTHING 对齐）
    if (!this.commentOut.has(row.eventId)) this.commentOut.set(row.eventId, row);
  }
  async listCommentOut(): Promise<CommentOutRow[]> {
    // Array.prototype.sort 是稳定排序：queued_at 相同时保持入队先后
    return [...this.commentOut.values()].sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0));
  }
  async markCommentOutFailed(eventId: string, reason: string): Promise<void> {
    const r = this.commentOut.get(eventId);
    if (r) this.commentOut.set(eventId, { ...r, state: 'failed', reason });
  }
  async removeCommentOut(eventId: string): Promise<void> {
    this.commentOut.delete(eventId);
  }

  groups = new Map<string, GroupRow>(); // groupId -> row
  groupKeys = new Map<string, GroupKeyRow>(); // `${groupId}:${epoch}` -> row

  async saveGroup(row: GroupRow): Promise<void> {
    const cur = this.groups.get(row.groupId);
    // joined_at 保留首次值（与 SqlRepo 的 UPDATE 列表一致）
    this.groups.set(row.groupId, cur ? { ...row, joinedAt: cur.joinedAt } : { ...row });
  }
  async listGroups(): Promise<GroupRow[]> {
    return [...this.groups.values()].sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1 : 0));
  }
  async getGroup(groupId: string): Promise<GroupRow | null> {
    return this.groups.get(groupId) ?? null;
  }
  async putGroupKey(row: GroupKeyRow): Promise<void> {
    this.groupKeys.set(`${row.groupId}:${row.epoch}`, { ...row });
  }
  async listGroupKeys(groupId: string): Promise<GroupKeyRow[]> {
    return [...this.groupKeys.values()].filter((k) => k.groupId === groupId).sort((a, b) => a.epoch - b.epoch);
  }

  dmKeys = new Map<string, DmKeyRow>(); // peerId -> row

  async putDmKey(row: DmKeyRow): Promise<void> {
    const cur = this.dmKeys.get(row.peerId);
    // created_at 保留首次值（与 SqlRepo 的 ON CONFLICT UPDATE 列表一致）
    this.dmKeys.set(row.peerId, cur ? { ...row, createdAt: cur.createdAt } : { ...row });
  }
  async getDmKey(peerId: string): Promise<DmKeyRow | null> {
    return this.dmKeys.get(peerId) ?? null;
  }
  async listDmKeys(): Promise<DmKeyRow[]> {
    return [...this.dmKeys.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  submissions = new Map<string, MySubmissionRow>(); // itemId -> row

  async saveSubmission(row: MySubmissionRow): Promise<void> {
    this.submissions.set(row.itemId, { ...row });
  }
  async listSubmissions(state?: 'pending' | 'sent' | 'failed'): Promise<MySubmissionRow[]> {
    // Array.prototype.sort 稳定：queued_at 相同时保持写入先后（与 SqlRepo 的 ORDER BY 同义）
    const all = [...this.submissions.values()].sort((a, b) =>
      a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0,
    );
    return state ? all.filter((r) => r.state === state) : all;
  }
  async getSubmission(itemId: string): Promise<MySubmissionRow | null> {
    return this.submissions.get(itemId) ?? null;
  }
  async markSubmissionSent(itemId: string, created: number, sentAt: string): Promise<void> {
    const r = this.submissions.get(itemId);
    if (r) this.submissions.set(itemId, { ...r, state: 'sent', reason: null, created, sentAt });
  }
  async markSubmissionFailed(itemId: string, reason: string): Promise<void> {
    const r = this.submissions.get(itemId);
    if (r) this.submissions.set(itemId, { ...r, state: 'failed', reason });
  }
  async removeSubmission(itemId: string): Promise<void> {
    this.submissions.delete(itemId);
  }

  async upsertLocalContainer(item: LocalContainerInput, segments: SubmitSegmentRow[]): Promise<void> {
    this.items.set(item.itemId, {
      itemId: item.itemId, source: 'local', type: item.type, title: item.title,
      rev: '', contentHash: item.contentHash, state: 'active', updatedAt: item.updatedAt,
      authorId: '', authorSig: '',
    });
    this.segments.set(
      item.itemId,
      [...segments]
        .sort((a, b) => a.seq - b.seq)
        .map((s) => ({ itemId: item.itemId, seq: s.seq, kind: s.kind, text: s.text, contentHash: '' })),
    );
  }

  async removeLocalContainer(itemId: string): Promise<void> {
    this.segments.delete(itemId);
    if (this.items.get(itemId)?.source === 'local') this.items.delete(itemId);
  }

  async markSubmissionLocalOnly(itemId: string, reason: string): Promise<void> {
    const r = this.submissions.get(itemId);
    if (r) this.submissions.set(itemId, { ...r, state: 'failed', reason, localOnly: true });
  }

  progress = new Map<string, ProgressRow>(); // itemId -> row
  checkinDays = new Map<string, CheckinDayRow>(); // day -> row

  async saveProgressLocal(row: ProgressRow): Promise<void> {
    const cur = this.progress.get(row.itemId);
    // 与 SqlRepo 同一守卫：赢才写进度行；打卡与守卫无关，永远写
    if (cur === undefined || progressWins(row.updatedAt, row.eventId, cur.updatedAt, cur.eventId)) {
      this.progress.set(row.itemId, { ...row, dirty: true });
    }
    if (!this.checkinDays.has(row.day)) {
      this.checkinDays.set(row.day, { day: row.day, firstEventId: row.eventId, createdAt: row.updatedAt });
    }
  }

  async mergeProgress(rows: ProgressRow[], days: CheckinDayRow[]): Promise<void> {
    for (const row of rows) {
      const cur = this.progress.get(row.itemId);
      if (cur !== undefined && !progressWins(row.updatedAt, row.eventId, cur.updatedAt, cur.eventId)) continue;
      this.progress.set(row.itemId, { ...row, dirty: false });
    }
    for (const d of days) {
      if (!this.checkinDays.has(d.day)) this.checkinDays.set(d.day, { ...d });
    }
  }

  async listProgress(): Promise<ProgressRow[]> {
    return [...this.progress.values()].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  }

  async getProgress(itemId: string): Promise<ProgressRow | null> {
    return this.progress.get(itemId) ?? null;
  }

  async listCheckinDays(): Promise<CheckinDayRow[]> {
    return [...this.checkinDays.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }
}

/** 按 URL 精确应答；再按「同路径 + 同查询参数（解码后）」应答；最后忽略 query 兜底。 */
export class FakeHttp implements HttpAdapter {
  routes = new Map<string, HttpResponse>();
  /** POST 按 URL 精确应答；可记录请求体与头，供签名断言 */
  postRoutes = new Map<string, HttpResponse>();
  putRoutes = new Map<string, HttpResponse>();
  posted: Array<{ url: string; body: Uint8Array; headers: Record<string, string> }> = [];
  putCalls: Array<{ url: string; body: Uint8Array; headers: Record<string, string> }> = [];
  async get(url: string): Promise<HttpResponse> {
    const exact = this.routes.get(url);
    if (exact) return exact;
    const [path, query] = splitUrl(url);
    for (const [route, res] of this.routes) {
      const [routePath, routeQuery] = splitUrl(route);
      if (routePath === path && sameQuery(routeQuery, query)) return res;
    }
    const byPath = this.routes.get(path);
    if (byPath) return byPath;
    return { status: 404, body: new Uint8Array() };
  }
  async post(url: string, body: Uint8Array, headers?: Record<string, string>): Promise<HttpResponse> {
    this.posted.push({ url, body, headers: headers ?? {} });
    return this.postRoutes.get(url) ?? { status: 404, body: new Uint8Array() };
  }
  async put(url: string, body: Uint8Array, headers?: Record<string, string>): Promise<HttpResponse> {
    this.putCalls.push({ url, body, headers: headers ?? {} });
    return this.putRoutes.get(url) ?? { status: 404, body: new Uint8Array() };
  }
}

function splitUrl(url: string): [string, string] {
  const i = url.indexOf('?');
  return i < 0 ? [url, ''] : [url.slice(0, i), url.slice(i + 1)];
}

/** 解码后比较查询串，避免 URLSearchParams 把 ':' 编码成 '%3A' 导致 route 匹配不上。 */
function sameQuery(a: string, b: string): boolean {
  const norm = (q: string) => {
    const parts: string[] = [];
    new URLSearchParams(q).forEach((v, k) => parts.push(`${k}=${v}`));
    return parts.sort().join('&');
  };
  return norm(a) === norm(b);
}

function cmpTagLink(a: TagLinkRow, b: TagLinkRow): number {
  if (a.tagId !== b.tagId) return a.tagId < b.tagId ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.targetId !== b.targetId) return a.targetId < b.targetId ? -1 : 1;
  return 0;
}

/**
 * 只实现同步核心会用到的那一条 SELECT。
 * pack 存储按路径共享：同一测试内 buildNode 可能新建 Reader 实例（旧的仍被 opts 持有），
 * 共享后二者视为同一份只读分发产物。
 */
interface PackRows {
  articles: ArticleRow[];
  quizzes: QuizRow[];
  segments: SegmentRow[];
}
const PACK_STORE = new Map<string, PackRows>();

export class FakePackReader implements PackReader {
  set(path: string, articles: ArticleRow[], quizzes: QuizRow[] = [], segments: SegmentRow[] = []): void {
    PACK_STORE.set(path, { articles, quizzes, segments });
  }
  async open(path: string): Promise<SqliteConnection> {
    const rows = PACK_STORE.get(path);
    if (!rows) throw new Error(`fake pack 未登记: ${path}`);
    return {
      select: async (sql: string) => {
        // 自检条目 7 用的是 count 查询；真实 pack 是真 SQLite，这里只需给出正确行数
        const cnt = /count\(\*\)\s+AS\s+n\s+FROM\s+(\w+)/i.exec(sql);
        if (cnt) {
          const t = String(cnt[1]);
          if (t === 'articles') return [{ n: rows.articles.length }];
          if (t === 'quizzes') return [{ n: rows.quizzes.length }];
          if (t === 'segments') return [{ n: new Set(rows.segments.map((s) => s.itemId)).size }];
          throw new Error(`fake pack 不支持的计数: ${sql}`);
        }
        if (sql.includes('FROM quizzes')) {
          return rows.quizzes.map((q) => ({
            item_id: q.itemId,
            question_json: q.questionJson,
            content_hash: q.contentHash,
          }));
        }
        if (sql.includes('FROM segments')) {
          return [...rows.segments]
            .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : a.seq - b.seq))
            .map((s) => ({
              item_id: s.itemId,
              seq: s.seq,
              kind: s.kind,
              text: s.text,
              content_hash: s.contentHash,
            }));
        }
        if (!sql.includes('FROM articles')) throw new Error(`fake pack 不支持的查询: ${sql}`);
        return rows.articles.map((r) => ({
          item_id: r.itemId,
          title: r.title,
          digest: r.digest,
          published_at: r.publishedAt,
          tags_json: r.tagsJson,
          body_md: r.bodyMd,
          content_hash: r.contentHash,
          source_rev: r.rev,
        }));
      },
      execute: async () => {
        throw new Error('pack 是只读分发产物');
      },
    };
  }
  async close(): Promise<void> {}
}

/**
 * `LocalDb` 的假实现：只实现自检探测会用到的那几条语句。
 * 不认识的 SQL 一律抛错——假实现悄悄放过新语句，比测试失败更难查（与 FakePackReader 同一取舍）。
 */
export class MemoryDb implements LocalDb {
  private tables = new Map<string, Array<Record<string, unknown>>>([['selfcheck_probe', []]]);

  async select(sql: string): Promise<Record<string, unknown>[]> {
    const rb = /randomblob\((\d+)\)/i.exec(sql);
    // 照抄真实 SQLite：hex() 输出**大写**。假实现返回小写会掩盖探测的大小写缺陷（2026-09-29 真机暴露）。
    if (rb) return [{ b: 'AB'.repeat(Number(rb[1])) }];
    const cnt = /count\(\*\)\s+AS\s+n\s+FROM\s+(\w+)/i.exec(sql);
    if (cnt) return [{ n: (this.tables.get(String(cnt[1])) ?? []).length }];
    throw new Error(`MemoryDb 不支持的查询: ${sql}`);
  }

  async execute(sql: string): Promise<void> {
    await this.tx([{ sql }]);
  }

  /** 先存快照，任一条语句失败即整体还原（真实事务的回滚语义）。 */
  async tx(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void> {
    const before = new Map<string, Array<Record<string, unknown>>>();
    for (const [k, v] of this.tables) before.set(k, v.map((r) => ({ ...r })));
    try {
      for (const s of statements) this.apply(s.sql, s.params ?? []);
    } catch (e) {
      this.tables = before;
      throw e;
    }
  }

  private apply(sql: string, params: unknown[]): void {
    const create = /CREATE TABLE IF NOT EXISTS\s+(\w+)/i.exec(sql);
    if (create) {
      const name = String(create[1]);
      if (!this.tables.has(name)) this.tables.set(name, []);
      return;
    }
    const ins = /INSERT INTO\s+(\w+)/i.exec(sql);
    if (ins) {
      const name = String(ins[1]);
      const rows = this.tables.get(name);
      if (!rows) throw new Error(`no such table: ${name}`);
      rows.push({ k: params[0] ?? null });
      return;
    }
    throw new Error(`MemoryDb 不支持的语句: ${sql}`);
  }
}

export function fakeAdapters(
  http: HttpAdapter,
  fs: FsAdapter,
  packReader: PackReader,
  storage: StorageAdapter = new MemoryStorage(),
): Adapters {
  return { http, fs, packReader, storage };
}
