// 测试用假实现：只在 Node 下跑，App 代码不引用本文件。
import type { Adapters, FsAdapter, HttpAdapter, HttpResponse, PackReader, SqliteConnection, StorageAdapter } from '../platform/adapter';
import { computeStats, favoriteNext, readAtNext } from './state';
import { searchPattern } from './search';
import type { ArticleRow, FavoriteRow, ItemRow, LearningStats, QuizRow, TombstoneRow } from './types';
import type { LocalRepo, PackApply } from './repo';

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
  blobs = new Map<string, { itemId: string; path: string; size: number; verifiedAt: string }>();
  tombstones = new Map<string, TombstoneRow>();

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
      for (const [id, b] of [...this.blobs]) {
        if (b.itemId === t.itemId) this.blobs.delete(id);
      }
    }
    for (const it of p.items) this.items.set(it.itemId, it);
    for (const a of p.articles) this.articles.set(a.itemId, a);
    for (const q of p.quizzes) this.quizzes.set(q.itemId, q);
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
  async hasBlob(id: string): Promise<boolean> {
    return this.blobs.has(id);
  }
  async addBlob(id: string, itemId: string, path: string, size: number, verifiedAt: string): Promise<void> {
    this.blobs.set(id, { itemId, path, size, verifiedAt });
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
}

/** 按 URL 精确应答；再按「同路径 + 同查询参数（解码后）」应答；最后忽略 query 兜底。 */
export class FakeHttp implements HttpAdapter {
  routes = new Map<string, HttpResponse>();
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

/**
 * 只实现同步核心会用到的那一条 SELECT。
 * pack 存储按路径共享：同一测试内 buildNode 可能新建 Reader 实例（旧的仍被 opts 持有），
 * 共享后二者视为同一份只读分发产物。
 */
interface PackRows {
  articles: ArticleRow[];
  quizzes: QuizRow[];
}
const PACK_STORE = new Map<string, PackRows>();

export class FakePackReader implements PackReader {
  set(path: string, articles: ArticleRow[], quizzes: QuizRow[] = []): void {
    PACK_STORE.set(path, { articles, quizzes });
  }
  async open(path: string): Promise<SqliteConnection> {
    const rows = PACK_STORE.get(path);
    if (!rows) throw new Error(`fake pack 未登记: ${path}`);
    return {
      select: async (sql: string) => {
        if (sql.includes('FROM quizzes')) {
          return rows.quizzes.map((q) => ({
            item_id: q.itemId,
            question_json: q.questionJson,
            content_hash: q.contentHash,
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

export function fakeAdapters(
  http: HttpAdapter,
  fs: FsAdapter,
  packReader: PackReader,
  storage: StorageAdapter = new MemoryStorage(),
): Adapters {
  return { http, fs, packReader, storage };
}