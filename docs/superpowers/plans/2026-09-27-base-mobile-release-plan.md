# base 手机端 v1 发布实施计划（课程 · 答题 · 我的 · 升级通道）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 [2026-09-27-base-mobile-release-design.md](../specs/2026-09-27-base-mobile-release-design.md) 落成可发布的手机端：四 tab（课程/圈子/评论/我的）+ 课程阅读 + 本地答题 + 签名升级通道。

**Architecture:** 分四阶段各自可独立交付。Phase 1 纯 App 改动（本地表 + 页面 + 阅读器），Phase 2 贯通「题库导入 → 导出 → 配送 → 判分」四段管线（Go 与 TS 双侧），Phase 3 加签名 `release` 文档与只读升级接口，Phase 4 打包与真机验收。逻辑层跑在 app-plus 的老 WebView 里（无 `URLSearchParams` / `TextDecoder`），故纯逻辑写进 `src/core/*.ts` 在 Node 下测，SQL 落到 `SqlRepo` 由真机验收覆盖（与既有 `sql.ts` / `sync.ts` 的分工一致）。

**Tech Stack:** uni-app CLI（Vue3 + Vite，`apps/mobile`）· vitest · Go 1.x（`based` 单二进制）· `@base/protocol-ts`（Ed25519 + canonicalize）· 黄金向量 `vectors/v1/*.json`

---

## 执行前提（每个 Task 都假设这三条）

1. 所有命令在 `e:\code\base` 下执行。Windows PowerShell 5.1：**不支持 `&&`**，多命令用 `;` 分隔或分次执行。
2. 提交时**只 add 本 Task 列出的文件**，绝不 `git add -A`。
3. 测试命令：
   - TS：`npm test -w @base/mobile -- <文件名片段>`；全量 `npm test`
   - TS 类型：`npm run typecheck -w @base/mobile`
   - Go：`go test ./internal/<包>/ -run <用例> -v`；全量 `go test ./...`

---

## File Structure

### 新建

| 路径 | 职责 |
| --- | --- |
| `apps/mobile/src/core/state.ts` | 本地体验状态的**纯规则**：收藏取反、已读不覆盖、学习记录聚合 |
| `apps/mobile/src/core/state.test.ts` | 上者单测 |
| `apps/mobile/src/core/search.ts` | `escapeLike` / `searchPattern` / `SEARCH_SQL`（纯函数 + SQL 常量） |
| `apps/mobile/src/core/search.test.ts` | 上者单测 |
| `apps/mobile/src/core/quiz.ts` | 题库 JSON 解析、选项稳定打乱、判分（纯函数） |
| `apps/mobile/src/core/quiz.test.ts` | 上者单测 |
| `apps/mobile/src/core/update.ts` | `release` 验签后的版本比较与处置判定（纯函数） |
| `apps/mobile/src/core/update.test.ts` | 上者单测 |
| `apps/mobile/src/pages/course/course.vue` | 课程页（原 `pages/index/index` 改名 + 分组 + 搜索入口） |
| `apps/mobile/src/pages/circle/circle.vue` | 圈子占位页 |
| `apps/mobile/src/pages/comment/comment.vue` | 评论占位页 |
| `apps/mobile/src/pages/mine/mine.vue` | 我的（学习记录 + 收藏入口 + 设置入口） |
| `apps/mobile/src/pages/favorite/favorite.vue` | 收藏列表 |
| `apps/mobile/src/pages/search/search.vue` | 搜索页 |
| `apps/mobile/src/pages/quiz/quiz.vue` | 答题页 |
| `internal/importer/quiz.go` | 题库 md 解析（Go 侧） |
| `internal/importer/quiz_test.go` | 上者单测 |
| `internal/protocol/release.go` | `release` 文档结构与签名/验签 |
| `internal/protocol/release_test.go` | 上者单测 |
| `internal/httpapi/release.go` | `GET /v1/release` |
| `internal/httpapi/release_test.go` | 上者单测 |
| `cmd/based/release.go` | `based release` 子命令 |
| `packages/protocol-ts/src/release.ts` | TS 侧 `release` 验签 |
| `vectors/v1/release.json` | `release` 黄金向量（由 `genvectors` 生成，不手写） |

### 修改

| 路径 | 改动 |
| --- | --- |
| `apps/mobile/src/core/types.ts` | 新增 `FavoriteRow` / `LearningStats` / `QuizRow` / `Question` / `QuestionDoc` |
| `apps/mobile/src/core/repo.ts` | `SCHEMA_SQL` 加三张表；`PackApply` 加 `quizzes`；`LocalRepo` + `SqlRepo` 加 9 个方法 |
| `apps/mobile/src/core/fakes.ts` | `MemoryRepo` 补齐新方法；`FakePackReader` 支持 `FROM quizzes` |
| `apps/mobile/src/core/sync.ts` | 加 `readPackQuizzes`，行级校验与行数守卫覆盖 `quizzes` |
| `apps/mobile/src/pages.json` | 四 tab + 9 个页面 |
| `apps/mobile/src/pages/article/article.vue` | 收藏 / 字号 / 主题 / 进度条 |
| `apps/mobile/src/pages/setting/setting.vue` | 当前版本 + 检查更新 |
| `apps/mobile/src/platform/index.ts` | `AppContext` 暴露 `updateNodeBaseUrl` 之外的升级检查所需项（不加，保持原样） |
| `internal/importer/md.go` | `Doc` 加 `Type`；`Run` 按 `type` 分流到题库 |
| `internal/store/store.go` | `UpsertQuiz` / `GetQuiz` / `ListQuizzes` |
| `internal/packexport/export.go` | 白名单放行 `quizzes`，导出 `quizzes` 行 |
| `internal/httpapi/server.go` | 注册 `GET /v1/release` |
| `cmd/based/main.go` | 注册 `release` 子命令 |
| `tools/genvectors/main.go` | 生成 `release.json` |
| `packages/protocol-ts/src/index.ts` | 导出 `./release` |
| `packages/protocol-ts/src/vectors.test.ts` | 消费 `release.json` |

### 删除

| 路径 | 原因 |
| --- | --- |
| `apps/mobile/src/pages/index/index.vue` | 被 `pages/course/course.vue` 取代（spec §3、§11 红线 9） |

---

## Phase 1：骨架 · 课程 · 我的（纯 App，可独立发布）

### Task 1: 本地体验状态（新表 + 纯规则 + repo 方法）

**Files:**
- Create: `apps/mobile/src/core/state.ts`
- Test: `apps/mobile/src/core/state.test.ts`
- Modify: `apps/mobile/src/core/types.ts`
- Modify: `apps/mobile/src/core/repo.ts`
- Modify: `apps/mobile/src/core/fakes.ts`

- [ ] **Step 1: 写失败的测试**

创建 `apps/mobile/src/core/state.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import { computeStats, favoriteNext, readAtNext } from './state';

describe('favoriteNext', () => {
  it('未收藏时写入时间并返回已收藏', () => {
    expect(favoriteNext(null, '2026-09-27T10:00:00Z')).toEqual({
      favoritedAt: '2026-09-27T10:00:00Z',
      isFavorite: true,
    });
  });

  it('已收藏时置空且保留行（取消收藏不清 read_at）', () => {
    expect(favoriteNext('2026-09-27T10:00:00Z', '2026-09-27T11:00:00Z')).toEqual({
      favoritedAt: null,
      isFavorite: false,
    });
  });
});

describe('readAtNext', () => {
  it('首次阅读写入时间', () => {
    expect(readAtNext(null, '2026-09-27T10:00:00Z')).toBe('2026-09-27T10:00:00Z');
  });

  it('已读不覆盖（保留首次时间）', () => {
    expect(readAtNext('2026-09-20T08:00:00Z', '2026-09-27T10:00:00Z')).toBe('2026-09-20T08:00:00Z');
  });
});

describe('computeStats', () => {
  it('无作答时正确率为 null，不是 0', () => {
    expect(
      computeStats({ readCount: 3, attempts: 0, correct: 0, total: 0, readLast: '2026-09-27T10:00:00Z', quizLast: '' }),
    ).toEqual({ readCount: 3, quizAttempts: 0, correctRate: null, lastAt: '2026-09-27T10:00:00Z' });
  });

  it('正确率取累计 SUM(correct)/SUM(total)', () => {
    expect(
      computeStats({ readCount: 1, attempts: 2, correct: 5, total: 8, readLast: '', quizLast: '' }).correctRate,
    ).toBe(0.625);
  });

  it('最近学习时间取阅读与作答的较大者（ISO8601 字符串可比）', () => {
    expect(
      computeStats({ readCount: 1, attempts: 1, correct: 1, total: 1, readLast: '2026-09-20T08:00:00Z', quizLast: '2026-09-27T10:00:00Z' })
        .lastAt,
    ).toBe('2026-09-27T10:00:00Z');
    expect(
      computeStats({ readCount: 1, attempts: 1, correct: 1, total: 1, readLast: '2026-09-27T10:00:00Z', quizLast: '2026-09-20T08:00:00Z' })
        .lastAt,
    ).toBe('2026-09-27T10:00:00Z');
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -w @base/mobile -- state`
Expected: FAIL —— `Failed to resolve import "./state"`

- [ ] **Step 3: 写最小实现**

创建 `apps/mobile/src/core/state.ts`：

```ts
// 本地体验状态的纯规则：收藏取反 / 已读不覆盖 / 学习记录聚合。
// 单独成文件的原因：真机上这些规则写在 SQL 里，而 Node 下没有 SQLite 引擎，
// 把「怎么判定」抽成纯函数才能在 Node 下测（SQL 侧的落库由真机验收覆盖，spec §10 验收 4/5/8）。
import type { LearningStats } from './types';

/** 收藏取反：已收藏置 null（保留行，保留 read_at），未收藏写入时间。 */
export function favoriteNext(current: string | null, at: string): { favoritedAt: string | null; isFavorite: boolean } {
  if (current !== null && current !== '') return { favoritedAt: null, isFavorite: false };
  return { favoritedAt: at, isFavorite: true };
}

/** 已读幂等：只写首次时间。 */
export function readAtNext(current: string | null, at: string): string {
  return current !== null && current !== '' ? current : at;
}

export interface StatsInput {
  /** user_state 中 read_at 非空的行数 */
  readCount: number;
  /** quiz_attempt 行数 */
  attempts: number;
  /** SUM(correct) */
  correct: number;
  /** SUM(total) */
  total: number;
  /** MAX(read_at)，无则空串 */
  readLast: string;
  /** MAX(answered_at)，无则空串 */
  quizLast: string;
}

/** 「我的」的学习记录：正确率无作答时为 null（界面显示 `-` 而不是 0）。 */
export function computeStats(i: StatsInput): LearningStats {
  return {
    readCount: i.readCount,
    quizAttempts: i.attempts,
    correctRate: i.total > 0 ? i.correct / i.total : null,
    lastAt: i.readLast > i.quizLast ? i.readLast : i.quizLast,
  };
}
```

在 `apps/mobile/src/core/types.ts` 追加：

```ts
export interface FavoriteRow {
  itemId: string;
  title: string;
  favoritedAt: string;
}

export interface LearningStats {
  readCount: number;
  quizAttempts: number;
  /** null = 还没有任何作答（界面显示 `-`） */
  correctRate: number | null;
  /** 阅读与作答时间的较大者；从未学习则为空串 */
  lastAt: string;
}

/** 题库条目（与节点侧 quizzes 表同形的三列） */
export interface QuizRow {
  itemId: string;
  questionJson: string;
  contentHash: string;
}

/** question_json 里的一道题（spec §6.2） */
export interface Question {
  q: string;
  options: string[];
  /** 正确选项下标 */
  answer: number;
  explain: string;
}

export interface QuestionDoc {
  schema_version: number;
  questions: Question[];
}
```

在 `apps/mobile/src/core/repo.ts` 改三处。

① `PackApply` 加 `quizzes`：

```ts
export interface PackApply {
  version: number;
  packId: string;
  items: ItemRow[];
  articles: ArticleRow[];
  quizzes: QuizRow[];
  tombstones: TombstoneRow[];
  updatedAt: string;
}
```

② `SCHEMA_SQL` 追加三条（放在 `tombstone` 之后，逗号结尾）：

```ts
  `CREATE TABLE IF NOT EXISTS user_state(
     item_id TEXT PRIMARY KEY, favorited_at TEXT, read_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS quizzes(
     item_id TEXT PRIMARY KEY, question_json TEXT NOT NULL, content_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS quiz_attempt(
     item_id TEXT NOT NULL, answered_at TEXT NOT NULL, correct INTEGER NOT NULL, total INTEGER NOT NULL,
     PRIMARY KEY(item_id, answered_at))`,
```

③ `LocalRepo` 接口追加（放在 `listTombstones` 之后）：

```ts
  toggleFavorite(itemId: string, at: string): Promise<boolean>;
  isFavorite(itemId: string): Promise<boolean>;
  listFavorites(): Promise<FavoriteRow[]>;
  markRead(itemId: string, at: string): Promise<void>;
  searchArticles(q: string): Promise<ArticleRow[]>;
  listQuizItems(): Promise<ItemRow[]>;
  getQuiz(itemId: string): Promise<QuizRow | null>;
  addAttempt(itemId: string, correct: number, total: number, at: string): Promise<void>;
  learningStats(): Promise<LearningStats>;
```

`import` 行改为：

```ts
import type { LocalDb } from '../platform/adapter';
import type { ArticleRow, FavoriteRow, ItemRow, LearningStats, QuizRow, TombstoneRow } from './types';
```

④ `SqlRepo` 实现（追加在 `listBlobPathsByItem` 之后；`applyPack` 里补 quizzes 分支）：

`applyPack` 的 `for (const a of p.articles)` 循环之后插入：

```ts
    for (const q of p.quizzes) {
      stmts.push({
        sql: `INSERT INTO quizzes(item_id,question_json,content_hash)
              VALUES(?,?,?)
              ON CONFLICT(item_id) DO UPDATE SET question_json=excluded.question_json,content_hash=excluded.content_hash`,
        params: [q.itemId, q.questionJson, q.contentHash],
      });
    }
```

`applyPack` 的墓碑段（`DELETE FROM articles` 之后）补一行：

```ts
      stmts.push({ sql: `DELETE FROM quizzes WHERE item_id=?`, params: [t.itemId] });
```

新增方法：

```ts
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
```

文件顶部 import 补上：

```ts
import { computeStats, favoriteNext, readAtNext } from './state';
import { SEARCH_SQL, searchPattern } from './search';
```

文件底部（`toArticleRow` 之前）加：

```ts
function toNullableString(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
```

- [ ] **Step 4: 跑测试与类型检查，确认通过**

Run: `npm test -w @base/mobile -- state`
Expected: PASS（`state.test.ts` 8 项全绿）

此时 `repo.ts` 引用了 `./search`，故本步会报模块缺失。**这就是下一步的驱动**：Step 4 只跑 `state`，若报 `./search` 解析失败，先做 Task 2 再回来跑全量。为避免顺序耦合，把 Task 2 与 Task 1 视为**同一提交前的连续两步**：

Run: `npm test -w @base/mobile -- state search`
Expected: PASS（Task 2 完成后）

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/core/state.ts apps/mobile/src/core/state.test.ts apps/mobile/src/core/types.ts apps/mobile/src/core/repo.ts apps/mobile/src/core/search.ts apps/mobile/src/core/search.test.ts apps/mobile/src/core/fakes.ts
git commit -m "feat(mobile): 本地体验状态（收藏/已读/学习记录）与题库落库表"
```

---

### Task 2: 本地搜索（转义 + 查询）

**Files:**
- Create: `apps/mobile/src/core/search.ts`
- Test: `apps/mobile/src/core/search.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `apps/mobile/src/core/search.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import { SEARCH_SQL, escapeLike, searchPattern } from './search';

describe('escapeLike', () => {
  it('转义 LIKE 通配符，避免一个 % 命中全部内容', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
  });

  it('先转义反斜杠本身，避免转义被吃', () => {
    expect(escapeLike('c:\\d')).toBe('c:\\\\d');
    expect(escapeLike('50%\\_x')).toBe('50\\%\\\\\\_x');
  });
});

describe('searchPattern', () => {
  it('去掉首尾空白后包 %', () => {
    expect(searchPattern('  内容  ')).toBe('%内容%');
  });

  it('空输入返回 null（调用方据此不发查询）', () => {
    expect(searchPattern('')).toBeNull();
    expect(searchPattern('   ')).toBeNull();
  });
});

describe('SEARCH_SQL', () => {
  it('只用匿名 ? 占位符（sqlWithParams 是单遍替换，不支持 ?1）', () => {
    expect(SEARCH_SQL.match(/\?/g)?.length).toBe(3);
    expect(SEARCH_SQL).not.toMatch(/\?\d/);
  });

  it('带 ESCAPE 子句且标题命中优先排序', () => {
    expect(SEARCH_SQL).toContain("ESCAPE '\\'");
    expect(SEARCH_SQL).toContain('ORDER BY (title LIKE');
    expect(SEARCH_SQL).toContain('LIMIT 50');
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -w @base/mobile -- search`
Expected: FAIL —— `Failed to resolve import "./search"`

- [ ] **Step 3: 写最小实现**

创建 `apps/mobile/src/core/search.ts`：

```ts
// 本地搜索的纯部分：转义与查询串。查询走 LIKE 全表扫描（内容量几十至几百篇足够，spec §11 风险 6）。

/** 转义 LIKE 里的特殊字符：反斜杠要先处理，否则会把后面新加的转义再转一次。 */
export function escapeLike(q: string): string {
  return q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** 空输入返回 null（调用方据此不发查询，spec §5.2）。 */
export function searchPattern(q: string): string | null {
  const t = q.trim();
  if (t === '') return null;
  return `%${escapeLike(t)}%`;
}

/**
 * 占位符只用匿名 `?`：sqlWithParams 是单遍替换，不支持 `?1` 编号形式。
 * 同一模式串出现三次（两次筛选 + 一次排序），故调用方要传三个参数。
 */
export const SEARCH_SQL =
  `SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev FROM articles` +
  ` WHERE title LIKE ? ESCAPE '\\' OR body_md LIKE ? ESCAPE '\\'` +
  ` ORDER BY (title LIKE ? ESCAPE '\\') DESC, published_at DESC LIMIT 50`;
```

- [ ] **Step 4: 跑测试与类型检查，确认通过**

Run: `npm test -w @base/mobile -- state search`
Expected: PASS

Run: `npm run typecheck -w @base/mobile`
Expected: 无输出（0 错误）。若报 `MemoryRepo` 未实现 `LocalRepo` 新方法，按 Step 5 补 `fakes.ts`。

- [ ] **Step 5: 补测试假实现并提交**

在 `apps/mobile/src/core/fakes.ts` 的 `MemoryRepo` 里补字段与方法（放在 `listTombstones` 之后）：

```ts
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
```

`MemoryRepo.applyPack` 里补 quizzes（放在 `for (const a of p.articles)` 之后）：

```ts
    for (const q of p.quizzes) this.quizzes.set(q.itemId, q);
```

`applyPack` 的墓碑段补：

```ts
      this.quizzes.delete(t.itemId);
```

`fakes.ts` 顶部 import 改为：

```ts
import type { Adapters, FsAdapter, HttpAdapter, HttpResponse, PackReader, SqliteConnection, StorageAdapter } from '../platform/adapter';
import { computeStats, favoriteNext, readAtNext } from './state';
import { searchPattern } from './search';
import type { ArticleRow, FavoriteRow, ItemRow, LearningStats, QuizRow, TombstoneRow } from './types';
```

Run: `npm test`
Expected: PASS（既有 30 项 = identity 15 + sync 10 + sql 5，加本次新增全绿）

```bash
git add apps/mobile/src/core/search.ts apps/mobile/src/core/search.test.ts apps/mobile/src/core/fakes.ts apps/mobile/src/core/repo.ts
git commit -m "feat(mobile): 本地搜索（LIKE 转义 + 单遍占位符查询）与假实现补齐"
```

---

### Task 3: 四 tab 骨架与页面搬迁

**Files:**
- Create: `apps/mobile/src/pages/course/course.vue`
- Create: `apps/mobile/src/pages/circle/circle.vue`
- Create: `apps/mobile/src/pages/comment/comment.vue`
- Create: `apps/mobile/src/pages/mine/mine.vue`
- Modify: `apps/mobile/src/pages.json`
- Delete: `apps/mobile/src/pages/index/index.vue`

- [ ] **Step 1: 先确认失败条件（无自动化测试，用构建与文件检查代替）**

Run: `npm run build:app -w @base/mobile`
Expected: 构建成功但产物里仍有 `pages/index/index`；`pages.json` 无 `tabBar`。这两点即本 Task 要消除的状态。

Run: `Test-Path e:\code\base\apps\mobile\dist\build\app\pages\index`
Expected: `True`（改造后应为 `False`，且出现 `pages\course\course.js`）

- [ ] **Step 2: 写页面与配置**

创建 `apps/mobile/src/pages/course/course.vue`（本步只做搬迁，分组与搜索入口在 Task 4）：

```vue
<template>
  <view class="wrap">
    <view class="bar">
      <text class="title">课程</text>
      <button size="mini" :disabled="busy" @click="doSync">{{ busy ? '同步中…' : '同步' }}</button>
    </view>
    <text v-if="tip" class="tip">{{ tip }}</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="items.length === 0 && !error" class="hint">还没有内容，点「同步」从节点拉取。</text>
    <view v-for="it in items" :key="it.itemId" class="item" @click="open(it.itemId)">
      <text class="item-title">{{ it.title }}</text>
      <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { syncOnce } from '../../core/sync';
import type { ItemRow } from '../../core/types';
import { bootstrap } from '../../platform';

const items = ref<ItemRow[]>([]);
const error = ref('');
const tip = ref('');
const busy = ref(false);

async function load() {
  try {
    const { repo } = await bootstrap();
    items.value = (await repo.listItems()).filter((i) => i.type === 'article');
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function doSync() {
  busy.value = true;
  tip.value = '';
  try {
    const { opts } = await bootstrap();
    if (!opts.nodeBaseUrl) {
      tip.value = '请先在「我的 → 设置」里填写节点地址与公钥';
      return;
    }
    const res = await syncOnce(opts);
    tip.value =
      res.status === 'noop'
        ? '已是最新版本'
        : `已更新到版本 ${res.contentVersion}（条目 ${res.items}，块 ${res.blobs}）`;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function open(itemId: string) {
  uni.navigateTo({ url: `/pages/article/article?itemId=${encodeURIComponent(itemId)}` });
}

onShow(() => {
  void load();
});
</script>

<style>
.wrap { padding: 16px; }
.bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.title { font-size: 20px; font-weight: 600; }
.item { padding: 12px 0; border-bottom: 1px solid #eeeeee; }
.item-title { font-size: 17px; }
.meta { display: block; color: #888888; font-size: 12px; }
.hint { color: #888888; }
.tip { color: #2f855a; font-size: 13px; }
.error { color: #c53030; font-size: 13px; }
</style>
```

创建 `apps/mobile/src/pages/circle/circle.vue`：

```vue
<template>
  <view class="wrap">
    <text class="title">圈子</text>
    <text class="state">本版未开放</text>
    <text class="why">圈子需要节点支持成员名单与加密内容分发，这两项尚未实现，所以现在没有内容可看。</text>
    <text class="why">这不是故障，是功能还没做。</text>
  </view>
</template>

<style>
.wrap { padding: 24px 16px; }
.title { display: block; font-size: 20px; font-weight: 600; }
.state { display: block; margin-top: 20px; font-size: 16px; color: #2b6cb0; }
.why { display: block; margin-top: 10px; color: #666666; font-size: 14px; line-height: 1.7; }
</style>
```

创建 `apps/mobile/src/pages/comment/comment.vue`：

```vue
<template>
  <view class="wrap">
    <text class="title">评论</text>
    <text class="state">本版未开放</text>
    <text class="why">评论需要节点支持内容讨论的读写与同步，这两项尚未实现，所以现在不能发言。</text>
    <text class="why">这不是故障，是功能还没做。</text>
  </view>
</template>

<style>
.wrap { padding: 24px 16px; }
.title { display: block; font-size: 20px; font-weight: 600; }
.state { display: block; margin-top: 20px; font-size: 16px; color: #2b6cb0; }
.why { display: block; margin-top: 10px; color: #666666; font-size: 14px; line-height: 1.7; }
</style>
```

创建 `apps/mobile/src/pages/mine/mine.vue`（本步只做壳，学习记录在 Task 6）：

```vue
<template>
  <view class="wrap">
    <text class="title">我的</text>
    <navigator url="/pages/favorite/favorite" class="link">我的收藏</navigator>
    <navigator url="/pages/setting/setting" class="link">设置</navigator>
  </view>
</template>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 20px; }
.link { display: block; padding: 14px 0; border-bottom: 1px solid #eeeeee; color: #2b6cb0; }
</style>
```

> 注意：`pages/favorite/favorite` 在 Task 7 才创建。uni-app 在 `pages.json` 未注册该路径时点击无反应但**不报错**，故此处先行；Task 5 会把 `search`、Task 7 把 `favorite`、Task 8 之后把 `quiz` 注册进 `pages.json`。

用下列内容**整体替换** `apps/mobile/src/pages.json`：

```json
{
  "pages": [
    {
      "path": "pages/course/course",
      "style": { "navigationBarTitleText": "课程" }
    },
    {
      "path": "pages/circle/circle",
      "style": { "navigationBarTitleText": "圈子" }
    },
    {
      "path": "pages/comment/comment",
      "style": { "navigationBarTitleText": "评论" }
    },
    {
      "path": "pages/mine/mine",
      "style": { "navigationBarTitleText": "我的" }
    },
    {
      "path": "pages/article/article",
      "style": { "navigationBarTitleText": "文章" }
    },
    {
      "path": "pages/setting/setting",
      "style": { "navigationBarTitleText": "设置" }
    }
  ],
  "tabBar": {
    "color": "#888888",
    "selectedColor": "#2b6cb0",
    "backgroundColor": "#ffffff",
    "borderStyle": "black",
    "list": [
      { "pagePath": "pages/course/course", "text": "课程" },
      { "pagePath": "pages/circle/circle", "text": "圈子" },
      { "pagePath": "pages/comment/comment", "text": "评论" },
      { "pagePath": "pages/mine/mine", "text": "我的" }
    ]
  },
  "globalStyle": {
    "navigationBarTextStyle": "black",
    "navigationBarBackgroundColor": "#ffffff",
    "backgroundColor": "#ffffff"
  }
}
```

删除旧启动页：

```bash
git rm apps/mobile/src/pages/index/index.vue
```

- [ ] **Step 3: 构建验证**

Run: `npm run build:app -w @base/mobile`
Expected: 构建成功。

Run: `Test-Path e:\code\base\apps\mobile\dist\build\app\pages\course`
Expected: `True`

Run: `Test-Path e:\code\base\apps\mobile\dist\build\app\pages\index`
Expected: `False`

- [ ] **Step 4: 手工核对硬约束**

打开 `apps/mobile/src/pages.json` 逐条核对：

1. `tabBar.list` 的 4 个 `pagePath` 都在 `pages` 数组里，且 `pages[0..3]` 与 tab 顺序一致（启动页 = 课程）。
2. 4 个 tab 均未配置 `iconPath` / `selectedIconPath`（纯文字，spec §1）。
3. 全仓库搜索 `navigateTo`，确认没有任何一处指向 tab 页（tab 间切换只能用 `switchTab`）：

Run: `git grep -n "navigateTo" -- apps/mobile/src`
Expected: 只有 `/pages/article/article`、`/pages/search/search`、`/pages/quiz/quiz` 三类非 tab 路径。

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/pages/course/course.vue apps/mobile/src/pages/circle/circle.vue apps/mobile/src/pages/comment/comment.vue apps/mobile/src/pages/mine/mine.vue apps/mobile/src/pages.json
git commit -m "feat(mobile): 四 tab 骨架（课程/圈子/评论/我的）与占位页，index 改名 course"
```

（`pages/index/index.vue` 的删除已由步骤 2 的 `git rm` 暂存，同属本次提交。）

---

### Task 4: 课程页扩容（分组 + 搜索入口）

**Files:**
- Modify: `apps/mobile/src/pages/course/course.vue`

> **本步不动 `pages.json`。** 页面注册一律由「创建该页 `.vue` 的那个 Task」负责（`pages.json` 里注册一个没有对应文件的路径会让 vite 构建直接失败）。因此 `pages/search/search` 的注册在 Task 5，`pages/quiz/quiz` 的注册在 Task 14。

- [ ] **Step 1: 写改动前的可观察基线**

Run: `Test-Path e:\code\base\apps\mobile\dist\build\app\pages\search`
Expected: `False`（尚未有搜索页）

> 核对方针：uni-app 把页面逻辑汇进单个 `app-service.js`，页面目录下只留 `.css`，**不存在** `pages/<name>/<name>.js`。故一律用**页面目录**是否存在来核对。

- [ ] **Step 2: 改课程页**

把 `apps/mobile/src/pages/course/course.vue` 的 `<template>` 与 `load()` / `open()` 换成下列内容，`doSync()` 保持不动：

```vue
<template>
  <view class="wrap">
    <view class="bar">
      <text class="title">课程</text>
      <button size="mini" :disabled="busy" @click="doSync">{{ busy ? '同步中…' : '同步' }}</button>
    </view>
    <view class="searchbox" @click="openSearch">
      <text class="searchtext">搜索标题与正文</text>
    </view>
    <text v-if="tip" class="tip">{{ tip }}</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="total === 0 && !error" class="hint">还没有内容，点「同步」从节点拉取。</text>
    <text v-if="articles.length > 0" class="group">文章</text>
    <view v-for="it in articles" :key="it.itemId" class="item" @click="openArticle(it.itemId)">
      <text class="item-title">{{ it.title }}</text>
      <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
    </view>
    <text v-if="quizzes.length > 0" class="group">答题</text>
    <view v-for="it in quizzes" :key="it.itemId" class="item" @click="openQuiz(it.itemId)">
      <text class="item-title">{{ it.title }}</text>
      <text class="meta">{{ it.itemId }}</text>
    </view>
  </view>
</template>
```

`<script setup lang="ts">` 的 `load()` / `open()` 段替换为：

```ts
const articles = ref<ItemRow[]>([]);
const quizzes = ref<ItemRow[]>([]);
const total = computed(() => articles.value.length + quizzes.value.length);

async function load() {
  try {
    const { repo } = await bootstrap();
    const all = await repo.listItems();
    articles.value = all.filter((i) => i.type === 'article');
    quizzes.value = all.filter((i) => i.type === 'quiz');
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function openSearch() {
  uni.navigateTo({ url: '/pages/search/search' });
}

function openArticle(itemId: string) {
  uni.navigateTo({ url: `/pages/article/article?itemId=${encodeURIComponent(itemId)}` });
}

function openQuiz(itemId: string) {
  uni.navigateTo({ url: `/pages/quiz/quiz?itemId=${encodeURIComponent(itemId)}` });
}
```

顶部 import 改为：

```ts
import { computed, ref } from 'vue';
```

样式追加：

```css
.searchbox { padding: 10px 12px; margin: 8px 0 12px; background: #f5f5f5; border-radius: 6px; }
.searchtext { color: #999999; font-size: 14px; }
.group { display: block; margin: 16px 0 4px; color: #888888; font-size: 13px; }
```

- [ ] **Step 3: 构建验证**

Run: `npm run build:app -w @base/mobile`
Expected: 构建成功。

Run: `Test-Path e:\code\base\apps\mobile\dist\build\app\pages\course`
Expected: `True`

- [ ] **Step 4: 人工核对搜索入口**

打开 `apps/mobile/src/pages/course/course.vue`，确认 `openSearch()` 指向 `/pages/search/search`（该页在 Task 5 创建并注册；在此之前点击无反应但不报错）。

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/pages/course/course.vue
git commit -m "feat(mobile): 课程页按 type 分组展示文章与测验，加搜索入口"
```

---

### Task 5: 搜索页

**Files:**
- Create: `apps/mobile/src/pages/search/search.vue`
- Modify: `apps/mobile/src/pages.json`（追加 `pages/search/search` —— 由创建该页的本 Task 注册，见 Task 4 顶部说明）

- [ ] **Step 1: 写失败条件**

Run: `Test-Path e:\code\base\apps\mobile\src\pages\search\search.vue`
Expected: `False`

- [ ] **Step 2: 写页面**

创建 `apps/mobile/src/pages/search/search.vue`：

```vue
<template>
  <view class="wrap">
    <input
      v-model="keyword"
      class="input"
      type="text"
      confirm-type="search"
      placeholder="搜索标题与正文"
      @input="onInput"
    />
    <text v-if="loaded && results.length === 0 && hasContent" class="hint">没搜到</text>
    <text v-if="loaded && !hasContent" class="hint">还没有内容，先去课程页同步。</text>
    <view v-for="r in results" :key="r.itemId" class="item" @click="open(r.itemId)">
      <text class="item-title">{{ r.title }}</text>
      <text class="meta">{{ r.digest }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import type { ArticleRow } from '../../core/types';
import { bootstrap } from '../../platform';

const keyword = ref('');
const results = ref<ArticleRow[]>([]);
const loaded = ref(false);
const hasContent = ref(false);

// onInput 而不是 watch：老 WebView 下 input 事件最稳，且避免同一输入触发两次查询
async function onInput() {
  try {
    const { repo } = await bootstrap();
    if (!hasContent.value) {
      hasContent.value = (await repo.listItems()).some((i) => i.type === 'article');
    }
    results.value = await repo.searchArticles(keyword.value);
    loaded.value = true;
  } catch {
    results.value = [];
    loaded.value = true;
  }
}

function open(itemId: string) {
  uni.navigateTo({ url: `/pages/article/article?itemId=${encodeURIComponent(itemId)}` });
}
</script>

<style>
.wrap { padding: 16px; }
.input { border: 1px solid #dddddd; border-radius: 6px; padding: 10px; font-size: 15px; }
.item { padding: 12px 0; border-bottom: 1px solid #eeeeee; }
.item-title { font-size: 17px; }
.meta { display: block; color: #888888; font-size: 12px; margin-top: 4px; }
.hint { display: block; margin-top: 16px; color: #888888; font-size: 14px; }
</style>
```

- [ ] **Step 3: 注册搜索页**

在 `apps/mobile/src/pages.json` 的 `pages` 数组末尾（`pages/setting/setting` 之后）追加（注意把上一项结尾的 `}` 补上逗号）：

```json
    {
      "path": "pages/search/search",
      "style": { "navigationBarTitleText": "搜索" }
    }
```

- [ ] **Step 4: 构建验证**

Run: `npm run build:app -w @base/mobile`
Expected: 构建成功。

Run: `Test-Path e:\code\base\apps\mobile\dist\build\app\pages\search`
Expected: `True`

- [ ] **Step 5: 人工核对空输入不发查询**

打开 `apps/mobile/src/core/repo.ts`，确认 `searchArticles` 第一句是 `if (pattern === null) return [];`——`searchPattern` 已把空串与纯空白判为 `null`，故空输入不会落库查询（spec §5.2、验收 3）。

- [ ] **Step 6: 提交**

```bash
git add apps/mobile/src/pages/search/search.vue apps/mobile/src/pages.json
git commit -m "feat(mobile): 搜索页（输入即搜，纯本地零网络）"
```

---

### Task 6: 我的（学习记录 + 收藏/设置入口）

**Files:**
- Modify: `apps/mobile/src/pages/mine/mine.vue`

- [ ] **Step 1: 写失败条件**

Run: `Test-Path e:\code\base\apps\mobile\dist\build\app\pages\mine`（Task 3 的构建产物存在）
打开 `apps/mobile/src/pages/mine/mine.vue`，确认此时只有两个 `<navigator>`，**没有**学习记录区。这就是本 Task 要补的状态。

- [ ] **Step 2: 写实现**

用下列内容整体替换 `apps/mobile/src/pages/mine/mine.vue`：

```vue
<template>
  <view class="wrap">
    <text class="title">我的</text>
    <view class="card">
      <view class="row"><text class="k">已读</text><text class="v">{{ stats.readCount }} 篇</text></view>
      <view class="row"><text class="k">答题正确率</text><text class="v">{{ rateText }}</text></view>
      <view class="row"><text class="k">最近学习</text><text class="v">{{ lastText }}</text></view>
    </view>
    <navigator url="/pages/favorite/favorite" class="link">我的收藏</navigator>
    <navigator url="/pages/setting/setting" class="link">设置</navigator>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import type { LearningStats } from '../../core/types';
import { bootstrap } from '../../platform';

const stats = ref<LearningStats>({ readCount: 0, quizAttempts: 0, correctRate: null, lastAt: '' });

// 无作答时显示 `-`，不显示 0%（0% 会被误读为「全错」）
const rateText = computed(() =>
  stats.value.correctRate === null ? '-' : `${Math.round(stats.value.correctRate * 100)}%`,
);
const lastText = computed(() => stats.value.lastAt.slice(0, 10) || '-');

// onShow 而不是 onLoad：从阅读器或答题页返回后必须立刻反映
onShow(async () => {
  try {
    const { repo } = await bootstrap();
    stats.value = await repo.learningStats();
  } catch {
    // 「我的」不因读库失败而报错，保持上一次的值
  }
});
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 16px; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 4px 12px; margin-bottom: 20px; }
.row { display: flex; justify-content: space-between; padding: 10px 0; }
.k { color: #666666; font-size: 14px; }
.v { font-size: 14px; }
.link { display: block; padding: 14px 0; border-bottom: 1px solid #eeeeee; color: #2b6cb0; }
</style>
```

- [ ] **Step 3: 构建验证**

Run: `npm run build:app -w @base/mobile`
Expected: 构建成功，产物含 `pages/mine/mine.js`。

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck -w @base/mobile`
Expected: 无输出（`LearningStats` 的四个字段全部来自 Task 1）。

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/pages/mine/mine.vue
git commit -m "feat(mobile): 我的页学习记录（已读/正确率/最近学习）与入口"
```

---

### Task 7: 收藏页

**Files:**
- Create: `apps/mobile/src/pages/favorite/favorite.vue`
- Modify: `apps/mobile/src/pages.json`

- [ ] **Step 1: 写失败条件**

Run: `Test-Path e:\code\base\apps\mobile\src\pages\favorite\favorite.vue`
Expected: `False`（故 Task 6 的「我的收藏」入口此时点了没反应——本 Task 修好）

- [ ] **Step 2: 写页面**

创建 `apps/mobile/src/pages/favorite/favorite.vue`：

```vue
<template>
  <view class="wrap">
    <text v-if="rows.length === 0" class="hint">还没有收藏，在文章页点收藏会出现在这里。</text>
    <view v-for="r in rows" :key="r.itemId" class="item" @click="open(r.itemId)">
      <text class="item-title">{{ r.title }}</text>
      <text class="meta">收藏于 {{ r.favoritedAt.slice(0, 10) }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import type { FavoriteRow } from '../../core/types';
import { bootstrap } from '../../platform';

const rows = ref<FavoriteRow[]>([]);

// onShow：从阅读器取消收藏返回后立刻消失
onShow(async () => {
  try {
    const { repo } = await bootstrap();
    rows.value = await repo.listFavorites();
  } catch {
    rows.value = [];
  }
});

function open(itemId: string) {
  uni.navigateTo({ url: `/pages/article/article?itemId=${encodeURIComponent(itemId)}` });
}
</script>

<style>
.wrap { padding: 16px; }
.item { padding: 14px 0; border-bottom: 1px solid #eeeeee; }
.item-title { font-size: 17px; }
.meta { display: block; color: #888888; font-size: 12px; margin-top: 4px; }
.hint { color: #888888; font-size: 14px; }
</style>
```

在 `apps/mobile/src/pages.json` 的 `pages` 数组里、`pages/search/search` 之后追加：

```json
    {
      "path": "pages/favorite/favorite",
      "style": { "navigationBarTitleText": "我的收藏" }
    },
```

- [ ] **Step 3: 构建验证**

Run: `npm run build:app -w @base/mobile`
Expected: 构建成功。

Run: `Test-Path e:\code\base\apps\mobile\dist\build\app\pages\favorite`
Expected: `True`

- [ ] **Step 4: 核对「撤下即消失」语义**

打开 `apps/mobile/src/core/repo.ts`，确认 `listFavorites()` 用的是 `INNER JOIN items`——条目被 tombstone 删掉 `items` 行后收藏自动消失，无需额外清理逻辑（spec §4.1）。

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/pages/favorite/favorite.vue apps/mobile/src/pages.json
git commit -m "feat(mobile): 收藏页（INNER JOIN items，条目撤下即消失）"
```

---

### Task 8: 阅读器增强（收藏 / 字号 / 主题 / 进度条）

**Files:**
- Modify: `apps/mobile/src/core/state.ts`
- Test: `apps/mobile/src/core/state.test.ts`
- Modify: `apps/mobile/src/pages/article/article.vue`

- [ ] **Step 1: 写失败的测试**

在 `apps/mobile/src/core/state.test.ts` 的 import 行补 `nextFontScale, normalizeFontScale, normalizeTheme`，并在文件末尾追加：

```ts
describe('阅读偏好', () => {
  it('主题未知取值回落 light', () => {
    expect(normalizeTheme(null)).toBe('light');
    expect(normalizeTheme('DARK')).toBe('light');
    expect(normalizeTheme('dark')).toBe('dark');
  });

  it('字号未知取值回落 2（中）', () => {
    expect(normalizeFontScale(null)).toBe(2);
    expect(normalizeFontScale('')).toBe(2);
    expect(normalizeFontScale('9')).toBe(2);
    expect(normalizeFontScale('1')).toBe(1);
    expect(normalizeFontScale('3')).toBe(3);
  });

  it('字号循环 1→2→3→1', () => {
    expect(nextFontScale(1)).toBe(2);
    expect(nextFontScale(2)).toBe(3);
    expect(nextFontScale(3)).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -w @base/mobile -- state`
Expected: FAIL —— `normalizeTheme is not a function`（或导入解析失败）

- [ ] **Step 3: 写实现**

在 `apps/mobile/src/core/state.ts` 末尾追加：

```ts
export type ReaderTheme = 'light' | 'dark';
export type ReaderFontScale = 1 | 2 | 3;

/** 字号三档 → 正文 px（spec §5.5） */
export const READER_FONT_SIZE: Record<ReaderFontScale, number> = { 1: 15, 2: 17, 3: 20 };

/** 非预期取值一律回落缺省值，不做校验报错（spec §4.2）。 */
export function normalizeTheme(v: string | null): ReaderTheme {
  return v === 'dark' ? 'dark' : 'light';
}

export function normalizeFontScale(v: string | null): ReaderFontScale {
  const n = Number(v);
  return n === 1 || n === 3 ? n : 2;
}

export function nextFontScale(cur: ReaderFontScale): ReaderFontScale {
  return cur === 3 ? 1 : ((cur + 1) as ReaderFontScale);
}
```

用下列内容整体替换 `apps/mobile/src/pages/article/article.vue`：

```vue
<template>
  <view class="wrap" :class="theme === 'dark' ? 'dark' : ''" :style="wrapStyle">
    <view v-if="progress > 0" class="progress" :style="`width:${progress}%`"></view>
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else>
      <image v-if="coverPath" :src="coverPath" mode="widthFix" class="cover" />
      <text class="title">{{ article?.title }}</text>
      <text class="meta">{{ article?.publishedAt }}</text>
      <view class="actions">
        <text class="act" :class="fav ? 'act-on' : ''" @click="toggleFav">{{ fav ? '已收藏' : '收藏' }}</text>
        <text class="act" @click="cycleFont">A {{ fontScale }}</text>
        <text class="act" @click="cycleTheme">{{ theme === 'dark' ? '浅色' : '深色' }}</text>
      </view>
      <text
        v-for="(p, i) in paragraphs"
        :key="i"
        class="para"
        :style="`font-size:${READER_FONT_SIZE[fontScale]}px`"
      >{{ p }}</text>
    </block>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onPageScroll } from '@dcloudio/uni-app';

import { READER_FONT_SIZE, nextFontScale, normalizeFontScale, normalizeTheme, type ReaderFontScale, type ReaderTheme } from '../../core/state';
import type { ArticleRow } from '../../core/types';
import { bootstrap } from '../../platform';

const article = ref<ArticleRow | null>(null);
const paragraphs = ref<string[]>([]);
const coverPath = ref('');
const error = ref('');
const fav = ref(false);
const theme = ref<ReaderTheme>('light');
const fontScale = ref<ReaderFontScale>(2);
const progress = ref(0);
const itemId = ref('');

const wrapStyle = computed(() =>
  theme.value === 'dark' ? 'background:#1a1a1a;color:#e6e6e6;min-height:100vh;' : '',
);

onLoad(async (query) => {
  const raw = String((query as Record<string, string> | undefined)?.itemId ?? '');
  itemId.value = raw;
  try {
    const { repo } = await bootstrap();
    const alt = decodedId(raw);
    const row = (await repo.getArticle(raw)) ?? (alt === raw ? null : await repo.getArticle(alt));
    if (!row) {
      error.value = '本地没有这篇正文，请返回先同步';
      return;
    }
    article.value = row;
    itemId.value = row.itemId;
    paragraphs.value = row.bodyMd
      .replace(/\r\n/g, '\n')
      .split('\n\n')
      .map((s) => s.trim())
      .filter((s) => s !== '');

    const slug = row.itemId.replace(/^article:/, '');
    const path = await repo.findBlobPathByItem(`cover:${slug}`);
    coverPath.value = path ? (path.startsWith('file://') ? path : `file://${path}`) : '';

    theme.value = normalizeTheme(await repo.getConfig('reader_theme'));
    fontScale.value = normalizeFontScale(await repo.getConfig('reader_font_scale'));
    fav.value = await repo.isFavorite(row.itemId);
    // 进入即标记已读；readAtNext 保证只写首次
    await repo.markRead(row.itemId, new Date().toISOString());
  } catch (e) {
    error.value = (e as Error).message;
  }
});

onPageScroll((e) => {
  progress.value = Math.min(100, Math.max(0, Math.round(e.scrollTop / 6)));
});

async function toggleFav() {
  const { repo } = await bootstrap();
  fav.value = await repo.toggleFavorite(itemId.value, new Date().toISOString());
}

async function cycleFont() {
  fontScale.value = nextFontScale(fontScale.value);
  const { repo } = await bootstrap();
  await repo.setConfig('reader_font_scale', String(fontScale.value));
}

async function cycleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  const { repo } = await bootstrap();
  await repo.setConfig('reader_theme', theme.value);
}

/** 页面间传参在个别机型上会保留百分号编码（itemId 含 `:` 会变成 %3A），按原样查不到就按解码后再查 */
function decodedId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.progress { position: fixed; top: 0; left: 0; height: 2px; background: #2b6cb0; z-index: 10; }
.title { font-size: 22px; font-weight: 600; }
.meta { display: block; color: #888888; font-size: 12px; margin-bottom: 12px; }
.cover { width: 100%; margin-bottom: 12px; }
.actions { display: flex; margin-bottom: 16px; }
.act { margin-right: 18px; color: #2b6cb0; font-size: 14px; }
.act-on { color: #b7791f; }
.para { display: block; margin-bottom: 12px; line-height: 1.8; }
.error { color: #c53030; font-size: 13px; }
.dark .title { color: #f0f0f0; }
.dark .meta { color: #999999; }
.dark .para { color: #e6e6e6; }
.dark .act { color: #63b3ed; }
</style>
```

- [ ] **Step 4: 跑测试、类型检查与构建**

Run: `npm test -w @base/mobile -- state`
Expected: PASS（含新增 3 项）

Run: `npm run typecheck -w @base/mobile`
Expected: 无输出

Run: `npm run build:app -w @base/mobile`
Expected: 构建成功

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/core/state.ts apps/mobile/src/core/state.test.ts apps/mobile/src/pages/article/article.vue
git commit -m "feat(mobile): 阅读器增强（收藏/字号三档/深色主题/进度条）"
```

---

## Phase 2：答题管线（导入 → 导出 → 配送 → 判分）

### Task 9: 题库导入（Go 侧解析 front-matter `type: quiz`）

**Files:**
- Modify: `internal/importer/md.go`
- Create: `internal/importer/quiz.go`
- Test: `internal/importer/quiz_test.go`

- [ ] **Step 1: 写失败的测试**

创建 `internal/importer/quiz_test.go`：

```go
package importer

import (
	"encoding/json"
	"strings"
	"testing"
)

const quizMD = `---
type: quiz
slug: what-is-cid
title: 内容寻址小测
---

### 内容寻址里，一份字节的标识是什么？
- 文件路径
- [x] 内容哈希
- 递增序号
> 标识即哈希，改一个 bit 哈希就变。

### 节点之间需要共识吗？
- [x] 不需要
- 需要
> 不需要：哈希即验真。
`

func TestParseQuiz(t *testing.T) {
	q, err := ParseQuiz("what-is-cid.md", []byte(quizMD))
	if err != nil {
		t.Fatalf("ParseQuiz: %v", err)
	}
	if q.Slug != "what-is-cid" || q.Title != "内容寻址小测" {
		t.Fatalf("front-matter 解析错误: %+v", q)
	}
	if len(q.Questions) != 2 {
		t.Fatalf("题目数 = %d，期望 2", len(q.Questions))
	}
	first := q.Questions[0]
	if first.Q != "内容寻址里，一份字节的标识是什么？" {
		t.Fatalf("题干 = %q", first.Q)
	}
	if len(first.Options) != 3 || first.Options[1] != "内容哈希" {
		t.Fatalf("选项 = %v", first.Options)
	}
	if first.Answer != 1 {
		t.Fatalf("答案下标 = %d，期望 1", first.Answer)
	}
	if first.Explain != "标识即哈希，改一个 bit 哈希就变。" {
		t.Fatalf("解析 = %q", first.Explain)
	}
}

func TestParseQuizRejectsIllegal(t *testing.T) {
	cases := []struct{ name, body, want string }{
		{"选项无正确答案", "### 题\n- 甲\n- 乙\n", "恰好一个正确答案"},
		{"两个正确答案", "### 题\n- [x] 甲\n- [x] 乙\n", "多个正确答案"},
		{"没有题目", "只有一段正文\n", "没有解析到任何题目"},
		{"选项少于两个", "### 题\n- [x] 甲\n", "至少两个选项"},
		{"题目出现在选项之前", "- [x] 甲\n", "选项出现在题目之前"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			md := "---\ntype: quiz\nslug: x\n---\n\n" + c.body
			_, err := ParseQuiz("x.md", []byte(md))
			if err == nil {
				t.Fatalf("期望失败，实际成功")
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("错误 = %q，期望包含 %q", err.Error(), c.want)
			}
		})
	}
}

// QuestionDoc 的 JSON 形状就是 spec §6.2 的 question_json，键名与顺序即契约。
func TestQuestionDocJSONShape(t *testing.T) {
	q, err := ParseQuiz("what-is-cid.md", []byte(quizMD))
	if err != nil {
		t.Fatalf("ParseQuiz: %v", err)
	}
	raw, err := json.Marshal(QuestionDoc{SchemaVersion: 1, Questions: q.Questions})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	want := `{"schema_version":1,"questions":[{"q":"内容寻址里，一份字节的标识是什么？","options":["文件路径","内容哈希","递增序号"],"answer":1,"explain":"标识即哈希，改一个 bit 哈希就变。"},{"q":"节点之间需要共识吗？","options":["不需要","需要"],"answer":0,"explain":"不需要：哈希即验真。"}]}`
	if string(raw) != want {
		t.Fatalf("question_json:\n got %s\nwant %s", raw, want)
	}
}
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `go test ./internal/importer/ -run TestParseQuiz -v`
Expected: FAIL —— `undefined: ParseQuiz`

- [ ] **Step 3: 写实现**

在 `internal/importer/md.go` 里**抽出 front-matter 解析**，并把 `ParseMD` 改为调用它。

把 `ParseMD` 开头这段：

```go
func ParseMD(filename string, raw []byte) (Doc, error) {
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	meta := map[string]string{}
	body := text
	if strings.HasPrefix(text, "---\n") {
		rest := text[len("---\n"):]
		if idx := strings.Index(rest, "\n---\n"); idx >= 0 {
			block := rest[:idx]
			body = rest[idx+len("\n---\n"):]
			for _, line := range strings.Split(block, "\n") {
				line = strings.TrimSpace(line)
				if line == "" || strings.HasPrefix(line, "#") {
					continue
				}
				k, v, ok := strings.Cut(line, ":")
				if !ok {
					continue
				}
				meta[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
			}
		}
	}
	body = strings.Trim(body, "\n")
```

替换为：

```go
func ParseMD(filename string, raw []byte) (Doc, error) {
	meta, body := SplitFrontMatter(raw)
	body = strings.Trim(body, "\n")
```

并在 `ParseMD` 之后插入：

```go
// SplitFrontMatter 拆出 front-matter（`key: value`）与剩余正文；正文未做首尾裁剪。
// 文章与题库共用这一段解析，避免两套 front-matter 规则漂移。
func SplitFrontMatter(raw []byte) (map[string]string, string) {
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	meta := map[string]string{}
	body := text
	if !strings.HasPrefix(text, "---\n") {
		return meta, body
	}
	rest := text[len("---\n"):]
	idx := strings.Index(rest, "\n---\n")
	if idx < 0 {
		return meta, body
	}
	block := rest[:idx]
	body = rest[idx+len("\n---\n"):]
	for _, line := range strings.Split(block, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		meta[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
	}
	return meta, body
}
```

创建 `internal/importer/quiz.go`：

```go
package importer

import (
	"fmt"
	"path/filepath"
	"strings"
)

// Question 是 question_json 里的一道题（spec §6.2）。键名即契约，勿改。
type Question struct {
	Q       string   `json:"q"`
	Options []string `json:"options"`
	Answer  int      `json:"answer"`
	Explain string   `json:"explain"`
}

// QuestionDoc 是一个题组的完整 question_json。
type QuestionDoc struct {
	SchemaVersion int        `json:"schema_version"`
	Questions     []Question `json:"questions"`
}

// Quiz 是一份待导入的题库。
type Quiz struct {
	Slug      string
	Title     string
	Questions []Question
}

// ParseQuiz 解析 front-matter 带 `type: quiz` 的 markdown（spec §6.1 的固定语法）。
// 语法：`### ` 题干 / `- ` 选项（`- [x] ` 为正确答案）/ `> ` 解析。
// 失败语义：整份文件拒绝，不做部分导入。
func ParseQuiz(filename string, raw []byte) (Quiz, error) {
	meta, body := SplitFrontMatter(raw)
	body = strings.Trim(body, "\n")
	if body == "" {
		return Quiz{}, fmt.Errorf("importer: %s 正文为空", filename)
	}
	stem := strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename))
	q := Quiz{Slug: meta["slug"], Title: meta["title"]}
	if q.Slug == "" {
		q.Slug = stem
	}
	if q.Title == "" {
		q.Title = q.Slug
	}
	questions, err := parseQuestions(filename, body)
	if err != nil {
		return Quiz{}, err
	}
	q.Questions = questions
	return q, nil
}

func parseQuestions(filename, body string) ([]Question, error) {
	out := []Question{}
	var cur *Question
	flush := func() error {
		if cur == nil {
			return nil
		}
		if len(cur.Options) < 2 {
			return fmt.Errorf("importer: %s 题目「%s」至少两个选项，实际 %d 个", filename, cur.Q, len(cur.Options))
		}
		if cur.Answer < 0 {
			return fmt.Errorf("importer: %s 题目「%s」必须有恰好一个正确答案", filename, cur.Q)
		}
		out = append(out, *cur)
		cur = nil
		return nil
	}
	for _, rawLine := range strings.Split(body, "\n") {
		line := strings.TrimSpace(rawLine)
		switch {
		case strings.HasPrefix(line, "### "):
			if err := flush(); err != nil {
				return nil, err
			}
			cur = &Question{Q: strings.TrimSpace(strings.TrimPrefix(line, "### ")), Answer: -1}
		case strings.HasPrefix(line, "> "):
			if cur == nil {
				return nil, fmt.Errorf("importer: %s 解析行出现在题目之前: %s", filename, line)
			}
			ex := strings.TrimSpace(strings.TrimPrefix(line, "> "))
			if cur.Explain == "" {
				cur.Explain = ex
			} else {
				cur.Explain += "\n" + ex
			}
		case strings.HasPrefix(line, "- "):
			if cur == nil {
				return nil, fmt.Errorf("importer: %s 选项出现在题目之前: %s", filename, line)
			}
			item := strings.TrimSpace(strings.TrimPrefix(line, "- "))
			switch {
			case strings.HasPrefix(item, "[x] "), strings.HasPrefix(item, "[X] "):
				if cur.Answer >= 0 {
					return nil, fmt.Errorf("importer: %s 题目「%s」有多个正确答案", filename, cur.Q)
				}
				cur.Answer = len(cur.Options)
				item = strings.TrimSpace(item[4:])
			case strings.HasPrefix(item, "[ ] "):
				item = strings.TrimSpace(item[4:])
			}
			if item == "" {
				return nil, fmt.Errorf("importer: %s 题目「%s」有空选项", filename, cur.Q)
			}
			cur.Options = append(cur.Options, item)
		case line == "":
			// 空行只作分隔
		default:
			return nil, fmt.Errorf("importer: %s 无法识别的行: %s", filename, line)
		}
	}
	if err := flush(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("importer: %s 没有解析到任何题目", filename)
	}
	return out, nil
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `go test ./internal/importer/ -v`
Expected: PASS（`ParseQuiz`、`ParseQuizRejectsIllegal` 5 个子用例、`QuestionDocJSONShape` 全绿）

Run: `go test ./...`
Expected: PASS（既有文章导入测试未回归）

- [ ] **Step 5: 提交**

```bash
git add internal/importer/md.go internal/importer/quiz.go internal/importer/quiz_test.go
git commit -m "feat(importer): 题库 md 解析（front-matter type: quiz 固定语法）"
```

---

### Task 10: 内容库题库读写与导入分流

**Files:**
- Modify: `internal/store/store.go`
- Modify: `internal/importer/md.go`（`Run` 按 type 分流）
- Test: `internal/store/quiz_test.go`

- [ ] **Step 1: 写失败的测试**

创建 `internal/store/quiz_test.go`：

```go
package store

import (
	"testing"
)

func TestUpsertQuizRoundTrip(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer st.Close()

	const qjson = `{"schema_version":1,"questions":[{"q":"甲？","options":["a","b"],"answer":1,"explain":"因为"}]}`
	err = st.UpsertQuiz(Quiz{
		ItemID: "lesson:cid", Title: "内容寻址小测", QuestionJSON: qjson,
		ContentHash: "hash-1", SourceRev: "rev-1",
	})
	if err != nil {
		t.Fatalf("UpsertQuiz: %v", err)
	}

	it, ok, err := st.GetItem("lesson:cid")
	if err != nil || !ok {
		t.Fatalf("GetItem: ok=%v err=%v", ok, err)
	}
	if it.Source != "lesson" || it.Type != "quiz" || it.SQLiteTable != "quizzes" || it.DistClass != "public" {
		t.Fatalf("items 行不符: %+v", it)
	}

	q, ok, err := st.GetQuiz("lesson:cid")
	if err != nil || !ok {
		t.Fatalf("GetQuiz: ok=%v err=%v", ok, err)
	}
	if q.QuestionJSON != qjson || q.ContentHash != "hash-1" {
		t.Fatalf("quizzes 行不符: %+v", q)
	}

	// 幂等：同 item_id 再写覆盖，不新增行
	if err := st.UpsertQuiz(Quiz{ItemID: "lesson:cid", Title: "改了标题", QuestionJSON: qjson, ContentHash: "hash-2"}); err != nil {
		t.Fatalf("再次 UpsertQuiz: %v", err)
	}
	all, err := st.ListQuizzes(nil)
	if err != nil {
		t.Fatalf("ListQuizzes: %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("题库条目数 = %d，期望 1", len(all))
	}
	if all["lesson:cid"].ContentHash != "hash-2" {
		t.Fatalf("覆盖失败: %+v", all["lesson:cid"])
	}
}

func TestListQuizzesByIDs(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer st.Close()
	for _, id := range []string{"lesson:a", "lesson:b"} {
		if err := st.UpsertQuiz(Quiz{ItemID: id, Title: id, QuestionJSON: "{}", ContentHash: "h"}); err != nil {
			t.Fatalf("UpsertQuiz %s: %v", id, err)
		}
	}
	got, err := st.ListQuizzes([]string{"lesson:b"})
	if err != nil {
		t.Fatalf("ListQuizzes: %v", err)
	}
	if len(got) != 1 || got["lesson:b"].ItemID != "lesson:b" {
		t.Fatalf("按 id 取失败: %+v", got)
	}
}
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `go test ./internal/store/ -run TestUpsertQuizRoundTrip -v`
Expected: FAIL —— `undefined: Quiz` / `st.UpsertQuiz undefined`

- [ ] **Step 3: 写实现**

在 `internal/store/store.go` 的 `Article` 结构体之后插入：

```go
// Quiz 是一个题组条目（question_json 是结构化 JSON，明文存储：
// quizzes 的 dist_class 恒为 public，pack 里也是明文，不需要 at-rest 加密）。
type Quiz struct {
	ItemID       string
	Title        string
	QuestionJSON string
	ContentHash  string
	SourceRev    string
	UpdatedAt    string
}
```

在 `UpsertArticle` 之后插入：

```go
// UpsertQuiz 幂等写入题库（items + quizzes 同事务），口径与文章一致。
func (s *Store) UpsertQuiz(q Quiz) error {
	updated := q.UpdatedAt
	if updated == "" {
		updated = nowUTC()
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			title=excluded.title, source_rev=excluded.source_rev, content_hash=excluded.content_hash,
			sqlite_table=excluded.sqlite_table, dist_class=excluded.dist_class, state=excluded.state, updated_at=excluded.updated_at`,
		q.ItemID, "lesson", "quiz", q.Title, q.SourceRev, q.ContentHash, "quizzes", "public", "active", updated); err != nil {
		return fmt.Errorf("store: upsert quiz item: %w", err)
	}
	if _, err := tx.Exec(`INSERT INTO quizzes(item_id,question_json,content_hash)
		VALUES(?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET question_json=excluded.question_json, content_hash=excluded.content_hash`,
		q.ItemID, q.QuestionJSON, q.ContentHash); err != nil {
		return fmt.Errorf("store: upsert quiz: %w", err)
	}
	return tx.Commit()
}

// GetQuiz 读取题库。
func (s *Store) GetQuiz(itemID string) (Quiz, bool, error) {
	row := s.db.QueryRow(`SELECT item_id,question_json,content_hash FROM quizzes WHERE item_id=?`, itemID)
	var q Quiz
	err := row.Scan(&q.ItemID, &q.QuestionJSON, &q.ContentHash)
	if errors.Is(err, sql.ErrNoRows) {
		return Quiz{}, false, nil
	}
	if err != nil {
		return Quiz{}, false, err
	}
	return q, true, nil
}

// ListQuizzes 返回指定 id 的题库；ids 为空表示全部。
func (s *Store) ListQuizzes(ids []string) (map[string]Quiz, error) {
	q := `SELECT item_id,question_json,content_hash FROM quizzes`
	args := []any{}
	if len(ids) > 0 {
		q += ` WHERE item_id IN (` + placeholders(len(ids)) + `)`
		for _, id := range ids {
			args = append(args, id)
		}
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Quiz{}
	for rows.Next() {
		var item Quiz
		if err := rows.Scan(&item.ItemID, &item.QuestionJSON, &item.ContentHash); err != nil {
			return nil, err
		}
		out[item.ItemID] = item
	}
	return out, rows.Err()
}
```

在 `internal/importer/md.go` 的 `Run` 里，把读文件后的处理改成按 `type` 分流。把现有循环体：

```go
		doc, err := ParseMD(name, raw)
		if err != nil {
			res.Failed++
			res.Errors = append(res.Errors, name+": "+err.Error())
			continue
		}
```

之前插入分流：

```go
		meta, _ := SplitFrontMatter(raw)
		if meta["type"] == "quiz" {
			if err := importQuiz(st, name, raw, meta); err != nil {
				res.Failed++
				res.Errors = append(res.Errors, name+": "+err.Error())
				continue
			}
			res.Imported++
			continue
		}
```

在 `Run` 之后插入：

```go
// importQuiz 把一份题库写进内容库：item_id = lesson:<slug>、type = quiz。
// content_hash 与 articles 同口径：hex(sha256(question_json 的 UTF-8 字节))，不走 canonicalize。
func importQuiz(st *store.Store, filename string, raw []byte, meta map[string]string) error {
	q, err := ParseQuiz(filename, raw)
	if err != nil {
		return err
	}
	doc := QuestionDoc{SchemaVersion: 1, Questions: q.Questions}
	questionJSON, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	hash := protocol.SHA256Hex(questionJSON)
	return st.UpsertQuiz(store.Quiz{
		ItemID:       "lesson:" + q.Slug,
		Title:        q.Title,
		QuestionJSON: string(questionJSON),
		ContentHash:  hash,
		SourceRev:    hash[:16],
	})
}
```

> `importQuiz` 的 `meta` 参数当前未使用（题库的 `tags` / `published_at` 在 `quizzes` 表里没有列可放，见 spec §6.2 的列定义）。保留参数是为了 `Run` 的调用点不因将来补列而改签名；若不接受未使用参数，可去掉该参数并同步改 `Run` 的调用。

- [ ] **Step 4: 跑测试，确认通过**

Run: `go test ./internal/store/ ./internal/importer/ -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add internal/store/store.go internal/store/quiz_test.go internal/importer/md.go
git commit -m "feat(store): 题库读写（quizzes 表）与 import-md 按 type 分流"
```

---

### Task 11: 内容包导出题库

**Files:**
- Modify: `internal/packexport/export.go`
- Test: `internal/packexport/quiz_test.go`

- [ ] **Step 1: 写失败的测试**

创建 `internal/packexport/quiz_test.go`：

```go
package packexport

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/johocn/base/internal/store"
	_ "modernc.org/sqlite"
)

const seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"

func TestExportIncludesQuizzes(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer st.Close()
	if err := st.UpsertArticle(store.Article{
		ItemID: "article:aaa", Title: "甲", Digest: "甲", PublishedAt: "2026-01-01T00:00:00Z",
		TagsJSON: "[]", BodyMD: "甲正文\n", ContentHash: "bodyhash",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	const qjson = `{"schema_version":1,"questions":[{"q":"甲？","options":["a","b"],"answer":1,"explain":"e"}]}`
	if err := st.UpsertQuiz(store.Quiz{ItemID: "lesson:cid", Title: "小测", QuestionJSON: qjson, ContentHash: "qhash"}); err != nil {
		t.Fatalf("UpsertQuiz: %v", err)
	}

	res, err := Export(st, Options{
		Issuer: "base-node-1", SignKeyHex: seed, Version: 7,
		IssuedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}

	var found bool
	for _, e := range res.Manifest.Entries {
		if e.ItemID == "lesson:cid" {
			found = true
			if e.SQLiteTable != "quizzes" || e.Type != "quiz" || e.ContentHash != "qhash" {
				t.Fatalf("条目不符: %+v", e)
			}
			if len(e.Chunks) != 0 {
				t.Fatalf("题库不应有块: %+v", e.Chunks)
			}
		}
	}
	if !found {
		t.Fatalf("manifest.entries 缺少 lesson:cid: %+v", res.Manifest.Entries)
	}

	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(res.PackPath))
	if err != nil {
		t.Fatalf("open pack: %v", err)
	}
	defer db.Close()
	var gotJSON, gotHash string
	if err := db.QueryRow(`SELECT question_json,content_hash FROM quizzes WHERE item_id=?`, "lesson:cid").Scan(&gotJSON, &gotHash); err != nil {
		t.Fatalf("pack 内 quizzes 行缺失: %v", err)
	}
	if gotJSON != qjson || gotHash != "qhash" {
		t.Fatalf("pack 内 quizzes 行不符: %q / %q", gotJSON, gotHash)
	}
	if _, err := os.Stat(res.ManifestPath); err != nil {
		t.Fatalf("manifest 未落盘: %v", err)
	}
}
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `go test ./internal/packexport/ -run TestExportIncludesQuizzes -v`
Expected: FAIL —— `packexport: 条目 lesson:cid 的 sqlite_table=quizzes 在 P0 未支持导出`

- [ ] **Step 3: 写实现**

在 `internal/packexport/export.go` 的白名单处：

```go
		if it.SQLiteTable != "articles" && it.SQLiteTable != "media_meta" {
			return Result{}, fmt.Errorf("packexport: 条目 %s 的 sqlite_table=%s 在 P0 未支持导出", it.ItemID, it.SQLiteTable)
		}
```

改为：

```go
		if it.SQLiteTable != "articles" && it.SQLiteTable != "media_meta" && it.SQLiteTable != "quizzes" {
			return Result{}, fmt.Errorf("packexport: 条目 %s 的 sqlite_table=%s 在 P0 未支持导出", it.ItemID, it.SQLiteTable)
		}
```

在 `writePackSQLite` 里，把收集文章 id 的段落：

```go
	articleIDs := []string{}
	for _, e := range entries {
		if e.SQLiteTable == "articles" {
			articleIDs = append(articleIDs, e.ItemID)
		}
	}
	articles, err := st.ListArticles(articleIDs)
	if err != nil {
		_ = tx.Rollback()
		_ = db.Close()
		return err
	}
```

改为：

```go
	articleIDs := []string{}
	quizIDs := []string{}
	for _, e := range entries {
		switch e.SQLiteTable {
		case "articles":
			articleIDs = append(articleIDs, e.ItemID)
		case "quizzes":
			quizIDs = append(quizIDs, e.ItemID)
		}
	}
	articles, err := st.ListArticles(articleIDs)
	if err != nil {
		_ = tx.Rollback()
		_ = db.Close()
		return err
	}
	quizzes, err := st.ListQuizzes(quizIDs)
	if err != nil {
		_ = tx.Rollback()
		_ = db.Close()
		return err
	}
```

在 `writePackSQLite` 的 `switch e.SQLiteTable` 里，`case "media_meta":` 之前插入：

```go
		case "quizzes":
			q, ok := quizzes[e.ItemID]
			if !ok {
				_ = tx.Rollback()
				_ = db.Close()
				return fmt.Errorf("packexport: 条目 %s 在 quizzes 表缺失", e.ItemID)
			}
			if _, err := tx.Exec(`INSERT INTO quizzes(item_id,question_json,content_hash) VALUES(?,?,?)`,
				q.ItemID, q.QuestionJSON, q.ContentHash); err != nil {
				_ = tx.Rollback()
				_ = db.Close()
				return err
			}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `go test ./internal/packexport/ -v`
Expected: PASS

Run: `go run ./tools/genvectors -out vectors/v1`
Expected: 输出 4 行 `wrote ...`；`git status` 显示 `vectors/v1/manifest.json` **未变化**（既有种子内容未受本次改动影响）。若 `manifest.json` 变了，说明改动影响了已有导出路径，**停下来查**，不要提交向量变更。

- [ ] **Step 5: 提交**

```bash
git add internal/packexport/export.go internal/packexport/quiz_test.go
git commit -m "feat(packexport): 导出 quizzes 类表（content_hash 进 manifest.entries）"
```

---

### Task 12: 客户端同步落题库

**Files:**
- Modify: `apps/mobile/src/core/sync.ts`
- Modify: `apps/mobile/src/core/fakes.ts`
- Test: `apps/mobile/src/core/sync.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `apps/mobile/src/core/sync.test.ts` 里做三处改动。

① import 补 `QuizRow`：

```ts
import type { ArticleRow, QuizRow } from './types';
```

② 在 `makeArticle` 之后加：

```ts
const QUIZ_JSON =
  '{"schema_version":1,"questions":[{"q":"内容寻址的标识是什么？","options":["路径","内容哈希"],"answer":1,"explain":"哈希即标识"}]}';

function makeQuiz(itemId: string): QuizRow {
  return { itemId, questionJson: QUIZ_JSON, contentHash: sha256Hex(utf8(QUIZ_JSON)) };
}
```

③ `NodeOptions` 加一项、`buildNode` 加两处：

```ts
interface NodeOptions {
  tombstones?: Tombstone[];
  omitArticles?: string[];
  withCover?: boolean;
  withQuiz?: boolean;
  http?: FakeHttp;
}
```

`buildNode` 里，在 `const entries: Entry[] = all...` 之前加：

```ts
  const quizRows: QuizRow[] = options.withQuiz ? [makeQuiz('lesson:cid')] : [];
```

在 `if (options.withCover) { ... }` 之后加：

```ts
  for (const q of quizRows) {
    entries.push({
      item_id: q.itemId,
      source: 'lesson',
      type: 'quiz',
      title: '内容寻址小测',
      source_rev: 'rev-1',
      content_hash: q.contentHash,
      sqlite_table: 'quizzes',
      dist_class: 'public',
    });
  }
```

把 catalog 的条目过滤：

```ts
    items: entries
      .filter((e) => e.type === 'article')
```

改为：

```ts
    items: entries
      .filter((e) => e.type === 'article' || e.type === 'quiz')
```

把 pack 登记：

```ts
  pack.set(`/work/pack-${packId}.sqlite`, articles);
```

改为：

```ts
  pack.set(`/work/pack-${packId}.sqlite`, articles, quizRows);
```

在 `describe('syncOnce', ...)` 里追加两个用例：

```ts
  it('题库：quizzes 与 articles 同批次落库', async () => {
    const fx = buildNode(7, { withQuiz: true });
    const { repo, opts } = setup(fx);
    await repo.setConfig('pubkey_hex', PUB);

    const res = await syncOnce(opts);

    expect(res).toEqual({ status: 'updated', contentVersion: 7, items: 3, blobs: 0 });
    expect((await repo.getQuiz('lesson:cid'))?.questionJson).toBe(QUIZ_JSON);
    expect((await repo.listQuizItems()).map((i) => i.itemId)).toEqual(['lesson:cid']);
    expect((await repo.getItem('lesson:cid'))?.type).toBe('quiz');
  });

  it('题库行被换过：拒收', async () => {
    const fx = buildNode(7, { withQuiz: true });
    const { repo, opts } = setup(fx);
    await repo.setConfig('pubkey_hex', PUB);
    const bad = '{"schema_version":1,"questions":[]}';
    fx.pack.set(`/work/pack-${fx.catalog.pack_id}.sqlite`, [], [
      { itemId: 'lesson:cid', questionJson: bad, contentHash: sha256Hex(utf8('别的字节')) },
    ]);

    await expect(syncOnce(opts)).rejects.toThrow(/行级 hash 不符/);
    expect(await repo.getConfig('content_version')).toBeNull();
  });
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -w @base/mobile -- sync`
Expected: FAIL —— 第一个新用例报 `expected 'lesson:cid' 未落库`（`getQuiz` 返回 null），第二个不报错但断言失败。

- [ ] **Step 3: 写实现**

① `apps/mobile/src/core/sync.ts`：加 `readPackQuizzes`（放在 `readPackArticles` 之后）：

```ts
async function readPackQuizzes(conn: SqliteConnection): Promise<QuizRow[]> {
  const rows = await conn.select(`SELECT item_id,question_json,content_hash FROM quizzes`);
  return rows.map((r) => ({
    itemId: String(r.item_id),
    questionJson: String(r.question_json ?? ''),
    contentHash: String(r.content_hash),
  }));
}
```

② 读取与校验。把：

```ts
  const conn = await o.adapters.packReader.open(packPath);
  let articles: ArticleRow[];
  try {
    articles = await readPackArticles(conn);
  } finally {
    await o.adapters.packReader.close(conn);
  }
```

改为：

```ts
  const conn = await o.adapters.packReader.open(packPath);
  let articles: ArticleRow[];
  let quizzes: QuizRow[];
  try {
    articles = await readPackArticles(conn);
    quizzes = await readPackQuizzes(conn);
  } finally {
    await o.adapters.packReader.close(conn);
  }
```

在 articles 的行级校验循环之后追加：

```ts
  for (const q of quizzes) {
    const signed = signedHashes.get(q.itemId);
    if (signed === undefined || q.contentHash !== signed || sha256Hex(utf8(q.questionJson)) !== signed) {
      throw new Error(`pack 行级 hash 不符: ${q.itemId}`);
    }
  }
```

在行数守卫之后追加：

```ts
  const declaredQuizzes = man.entries.filter((e) => e.sqlite_table === 'quizzes').length;
  if (quizzes.length < declaredQuizzes) {
    throw new Error(`pack 题库行数不符：manifest 声明 ${declaredQuizzes} 条，pack 读出 ${quizzes.length} 条（${packPath}）`);
  }
```

把落库调用：

```ts
  await o.repo.applyPack({ version: cat.content_version, packId: cat.pack_id, items, articles, tombstones, updatedAt: now });
```

改为：

```ts
  await o.repo.applyPack({ version: cat.content_version, packId: cat.pack_id, items, articles, quizzes, tombstones, updatedAt: now });
```

顶部 import 补 `QuizRow`：

```ts
import type { ArticleRow, ItemRow, QuizRow, TombstoneRow } from './types';
```

③ `apps/mobile/src/core/fakes.ts`：把 `FakePackReader` 换成支持两类行。整段替换：

```ts
const PACK_STORE = new Map<string, ArticleRow[]>();
```

改为：

```ts
interface PackRows {
  articles: ArticleRow[];
  quizzes: QuizRow[];
}
const PACK_STORE = new Map<string, PackRows>();
```

`FakePackReader` 的 `set` / `open` 替换为：

```ts
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
```

- [ ] **Step 4: 跑测试与类型检查，确认通过**

Run: `npm test -w @base/mobile -- sync`
Expected: PASS（含 2 个新用例）

Run: `npm test`
Expected: PASS（全量）

Run: `npm run typecheck -w @base/mobile`
Expected: 无输出

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/core/sync.ts apps/mobile/src/core/fakes.ts apps/mobile/src/core/sync.test.ts
git commit -m "feat(mobile): 同步落题库（readPackQuizzes + 行级校验 + 行数守卫）"
```

---

### Task 13: 答题纯逻辑（解析 / 稳定打乱 / 判分）

**Files:**
- Create: `apps/mobile/src/core/quiz.ts`
- Test: `apps/mobile/src/core/quiz.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `apps/mobile/src/core/quiz.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import { gradeAnswer, parseQuestionDoc, shuffleAll, shuffleQuestion } from './quiz';
import type { Question } from './types';

const GOOD =
  '{"schema_version":1,"questions":[{"q":"标识是什么？","options":["路径","内容哈希","序号"],"answer":1,"explain":"哈希即标识"}]}';

const one: Question = { q: '标识是什么？', options: ['路径', '内容哈希', '序号'], answer: 1, explain: '哈希即标识' };

describe('parseQuestionDoc', () => {
  it('合法文档返回题目数组', () => {
    const got = parseQuestionDoc(GOOD);
    expect(got).toHaveLength(1);
    expect(got?.[0]).toEqual(one);
  });

  it('非法文档一律返回 null（调用方据此提示不支持且不写记录）', () => {
    expect(parseQuestionDoc('不是 JSON')).toBeNull();
    expect(parseQuestionDoc('{"schema_version":2,"questions":[]}')).toBeNull();
    expect(parseQuestionDoc('{"schema_version":1,"questions":[]}')).toBeNull();
    expect(parseQuestionDoc('{"schema_version":1,"questions":[{"q":"甲","options":["只有一个"],"answer":0}]}')).toBeNull();
    expect(parseQuestionDoc('{"schema_version":1,"questions":[{"q":"甲","options":["a","b"],"answer":5}]}')).toBeNull();
    expect(parseQuestionDoc('{"schema_version":1,"questions":[{"q":"甲","options":["a","b"],"answer":-1}]}')).toBeNull();
  });

  it('缺 explain 时补空串，不判为非法', () => {
    const got = parseQuestionDoc('{"schema_version":1,"questions":[{"q":"甲","options":["a","b"],"answer":0}]}');
    expect(got?.[0].explain).toBe('');
  });
});

describe('shuffleQuestion', () => {
  it('同一 seed 结果稳定（同题顺序不会来回变）', () => {
    expect(shuffleQuestion(one, 42)).toEqual(shuffleQuestion(one, 42));
  });

  it('选项集合不变，且 answerIndex 指向正确文本', () => {
    const s = shuffleQuestion(one, 7);
    expect([...s.options].sort()).toEqual([...one.options].sort());
    expect(s.options[s.answerIndex]).toBe('内容哈希');
  });

  it('shuffleAll 按 item_id 派生种子，同一题库两次结果一致', () => {
    const a = shuffleAll([one, one], 'lesson:cid');
    const b = shuffleAll([one, one], 'lesson:cid');
    expect(a).toEqual(b);
  });
});

describe('gradeAnswer', () => {
  it('选中下标即判定', () => {
    const s = shuffleQuestion(one, 7);
    expect(gradeAnswer(s, s.answerIndex)).toBe(true);
    expect(gradeAnswer(s, (s.answerIndex + 1) % s.options.length)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -w @base/mobile -- quiz`
Expected: FAIL —— `Failed to resolve import "./quiz"`

- [ ] **Step 3: 写实现**

创建 `apps/mobile/src/core/quiz.ts`：

```ts
// 答题的纯逻辑：question_json 解析、选项稳定打乱、判分。
// 打乱放在客户端（spec §6.4）：question_json 的选项顺序是显示顺序，不下发打乱指令。
import type { Question, QuestionDoc } from './types';

/** 解析 question_json；任何格式不符返回 null（页面据此提示「题目格式不支持」且不写记录）。 */
export function parseQuestionDoc(raw: string): Question[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const doc = parsed as Partial<QuestionDoc>;
  if (doc.schema_version !== 1) return null;
  if (!Array.isArray(doc.questions) || doc.questions.length === 0) return null;
  const out: Question[] = [];
  for (const q of doc.questions) {
    if (typeof q?.q !== 'string' || q.q === '') return null;
    if (!Array.isArray(q.options) || q.options.length < 2) return null;
    if (!q.options.every((o) => typeof o === 'string')) return null;
    if (typeof q.answer !== 'number' || !Number.isInteger(q.answer)) return null;
    if (q.answer < 0 || q.answer >= q.options.length) return null;
    out.push({
      q: q.q,
      options: q.options.map((o) => String(o)),
      answer: q.answer,
      explain: typeof q.explain === 'string' ? q.explain : '',
    });
  }
  return out;
}

/** FNV-1a：由 item_id 派生稳定种子，保证同一题库每次进入的选项顺序一致。 */
export function seedFrom(itemId: string): number {
  let h = 2166136261;
  for (let i = 0; i < itemId.length; i++) {
    h ^= itemId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：小而确定的伪随机，不依赖 Math.random（否则顺序不可复现）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ShuffledQuestion {
  q: string;
  /** 显示顺序的选项文本 */
  options: string[];
  /** 正确项在 options 里的显示下标 */
  answerIndex: number;
  explain: string;
}

export function shuffleQuestion(question: Question, seed: number): ShuffledQuestion {
  const order = question.options.map((_, i) => i);
  const rand = rng(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  return {
    q: question.q,
    options: order.map((i) => question.options[i]!),
    answerIndex: order.indexOf(question.answer),
    explain: question.explain,
  };
}

export function shuffleAll(questions: Question[], itemId: string): ShuffledQuestion[] {
  const base = seedFrom(itemId);
  return questions.map((q, i) => shuffleQuestion(q, base + i));
}

export function gradeAnswer(q: ShuffledQuestion, pickedIndex: number): boolean {
  return pickedIndex === q.answerIndex;
}
```

- [ ] **Step 4: 跑测试与类型检查，确认通过**

Run: `npm test -w @base/mobile -- quiz`
Expected: PASS

Run: `npm run typecheck -w @base/mobile`
Expected: 无输出

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/core/quiz.ts apps/mobile/src/core/quiz.test.ts
git commit -m "feat(mobile): 答题纯逻辑（question_json 解析/稳定打乱/判分）"
```

---

### Task 14: 答题页

**Files:**
- Create: `apps/mobile/src/pages/quiz/quiz.vue`
- Modify: `apps/mobile/src/pages.json`

- [ ] **Step 1: 写失败条件**

Run: `Test-Path e:\code\base\apps\mobile\src\pages\quiz\quiz.vue`
Expected: `False`（课程页的「答题」分组此时点了没反应）

- [ ] **Step 2: 写页面**

创建 `apps/mobile/src/pages/quiz/quiz.vue`：

```vue
<template>
  <view class="wrap">
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else-if="current">
      <text class="progress">{{ index + 1 }} / {{ questions.length }}</text>
      <text class="q">{{ current.q }}</text>
      <view
        v-for="(opt, i) in current.options"
        :key="i"
        class="opt"
        :class="optClass(i)"
        @click="pick(i)"
      >
        <text class="opt-text">{{ opt }}</text>
      </view>
      <text v-if="picked !== null && current.explain" class="explain">解析：{{ current.explain }}</text>
      <button v-if="picked !== null && index + 1 < questions.length" size="mini" class="next" @click="next">下一题</button>
      <button v-if="picked !== null && index + 1 === questions.length" size="mini" class="next" @click="next">看结果</button>
    </block>
    <block v-else-if="finished">
      <text class="score">答对 {{ correct }} / {{ questions.length }}</text>
      <button size="mini" class="next" @click="restart">重做</button>
    </block>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { gradeAnswer, parseQuestionDoc, shuffleAll, type ShuffledQuestion } from '../../core/quiz';
import { bootstrap } from '../../platform';

const questions = ref<ShuffledQuestion[]>([]);
const index = ref(0);
const picked = ref<number | null>(null);
const correct = ref(0);
const finished = ref(false);
const error = ref('');
const itemId = ref('');

const current = computed<ShuffledQuestion | null>(() => questions.value[index.value] ?? null);

onLoad(async (query) => {
  const raw = String((query as Record<string, string> | undefined)?.itemId ?? '');
  try {
    const { repo } = await bootstrap();
    const alt = decodedId(raw);
    const row = (await repo.getQuiz(raw)) ?? (alt === raw ? null : await repo.getQuiz(alt));
    if (!row) {
      error.value = '本地没有这套题目，请返回先同步';
      return;
    }
    itemId.value = row.itemId;
    const parsed = parseQuestionDoc(row.questionJson);
    if (parsed === null) {
      error.value = '题目格式不支持，请升级节点内容';
      return;
    }
    questions.value = shuffleAll(parsed, row.itemId);
  } catch (e) {
    error.value = (e as Error).message;
  }
});

function pick(i: number) {
  if (picked.value !== null) return; // 每题只判一次
  picked.value = i;
  if (current.value && gradeAnswer(current.value, i)) correct.value++;
}

function optClass(i: number): string {
  if (picked.value === null) return '';
  if (i === current.value?.answerIndex) return 'opt-right';
  return i === picked.value ? 'opt-wrong' : '';
}

async function next() {
  if (index.value + 1 < questions.value.length) {
    index.value++;
    picked.value = null;
    return;
  }
  // 结算：只在这里写一行 quiz_attempt（不在每题判分时写，避免半途退出产生半截记录）
  try {
    const { repo } = await bootstrap();
    await repo.addAttempt(itemId.value, correct.value, questions.value.length, new Date().toISOString());
  } catch (e) {
    error.value = (e as Error).message;
    return;
  }
  finished.value = true;
}

function restart() {
  finished.value = false;
  index.value = 0;
  picked.value = null;
  correct.value = 0;
}

/** 页面间传参在个别机型上会保留百分号编码，按原样查不到就按解码后再查 */
function decodedId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.progress { display: block; color: #888888; font-size: 13px; margin-bottom: 8px; }
.q { display: block; font-size: 18px; font-weight: 600; margin-bottom: 16px; line-height: 1.6; }
.opt { padding: 12px; border: 1px solid #dddddd; border-radius: 6px; margin-bottom: 10px; }
.opt-text { font-size: 15px; }
.opt-right { border-color: #2f855a; background: #f0fff4; }
.opt-wrong { border-color: #c53030; background: #fff5f5; }
.explain { display: block; color: #666666; font-size: 14px; line-height: 1.7; margin: 12px 0; }
.score { display: block; font-size: 20px; font-weight: 600; margin-bottom: 20px; }
.next { margin-top: 8px; }
.error { color: #c53030; font-size: 13px; }
</style>
```

在 `apps/mobile/src/pages.json` 的 `pages` 数组里、`pages/favorite/favorite` 之后追加：

```json
    {
      "path": "pages/quiz/quiz",
      "style": { "navigationBarTitleText": "答题" }
    },
```

- [ ] **Step 3: 构建验证**

Run: `npm run build:app -w @base/mobile`
Expected: 构建成功。

Run: `Test-Path e:\code\base\apps\mobile\dist\build\app\pages\quiz`
Expected: `True`

- [ ] **Step 4: 核对「一题只判一次、一次作答只写一行」**

打开 `apps/mobile/src/pages/quiz/quiz.vue` 逐条核对：

1. `pick(i)` 第一句是 `if (picked.value !== null) return;`
2. `addAttempt` 只出现在 `next()` 里，且出现在 `finished.value = true` 之前

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/pages/quiz/quiz.vue apps/mobile/src/pages.json
git commit -m "feat(mobile): 答题页（稳定打乱/即时判分/结算写一行记录）"
```

---

## Phase 3：升级通道（签名 release 文档 → 只读接口 → App 检查）

### Task 15: Go 侧 release 文档与黄金向量

**Files:**
- Create: `internal/protocol/release.go`
- Test: `internal/protocol/release_test.go`
- Modify: `tools/genvectors/main.go`

- [ ] **Step 1: 写失败的测试**

创建 `internal/protocol/release_test.go`：

```go
package protocol

import (
	"strings"
	"testing"
)

const releaseSeed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"

func sampleRelease() ReleaseDoc {
	return ReleaseDoc{Payload: ReleasePayload{
		SchemaVersion: 1, Issuer: "base-node-1", IssuedAt: "2026-09-27T00:00:00Z",
		VersionName: "0.2.0", MinVersionName: "0.1.0",
		ApkURL: "http://node.example.com/dl/base-0.2.0.apk", ApkSize: 12345678,
		ApkSHA256: strings.Repeat("ab", 32), Notes: "课程、答题与我的；四 tab 定稿",
	}}
}

func TestReleaseSignAndVerify(t *testing.T) {
	kp, err := KeyPairFromSeed(releaseSeed)
	if err != nil {
		t.Fatalf("KeyPairFromSeed: %v", err)
	}
	doc := sampleRelease()
	if err := doc.SignWith(releaseSeed); err != nil {
		t.Fatalf("SignWith: %v", err)
	}
	ok, err := doc.Verify(kp.PubHex)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !ok {
		t.Fatalf("自签自验失败")
	}
}

// 中文 notes 参与签名：canonicalize 只限制对象键必须 ASCII，值不限（spec §8.1）。
func TestReleaseSignBytesAllowsChineseValues(t *testing.T) {
	doc := sampleRelease()
	b, err := doc.ReleaseSignBytes()
	if err != nil {
		t.Fatalf("ReleaseSignBytes: %v", err)
	}
	s := string(b)
	if !strings.Contains(s, "课程、答题与我的；四 tab 定稿") {
		t.Fatalf("notes 未进签名载荷: %s", s)
	}
	if strings.Contains(s, `"signature"`) {
		t.Fatalf("签名域不应包含 signature: %s", s)
	}
}

func TestReleaseVerifyRejects(t *testing.T) {
	kp, _ := KeyPairFromSeed(releaseSeed)

	// 改版本号后不重签
	tampered := sampleRelease()
	if err := tampered.SignWith(releaseSeed); err != nil {
		t.Fatalf("SignWith: %v", err)
	}
	tampered.Payload.VersionName = "9.9.9"
	if ok, _ := tampered.Verify(kp.PubHex); ok {
		t.Fatalf("改版本号后仍验签通过")
	}

	// 签名被改一位
	broken := sampleRelease()
	if err := broken.SignWith(releaseSeed); err != nil {
		t.Fatalf("SignWith: %v", err)
	}
	broken.Signature = "0" + broken.Signature[1:]
	if ok, _ := broken.Verify(kp.PubHex); ok {
		t.Fatalf("签名被改后仍验签通过")
	}

	// schema_version 不是 1
	wrongSchema := sampleRelease()
	wrongSchema.Payload.SchemaVersion = 2
	if err := wrongSchema.SignWith(releaseSeed); err != nil {
		t.Fatalf("SignWith: %v", err)
	}
	if ok, _ := wrongSchema.Verify(kp.PubHex); ok {
		t.Fatalf("schema_version=2 仍验签通过")
	}
}
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `go test ./internal/protocol/ -run TestRelease -v`
Expected: FAIL —— `undefined: ReleaseDoc`

- [ ] **Step 3: 写实现**

创建 `internal/protocol/release.go`：

```go
package protocol

import (
	"encoding/json"
	"fmt"
)

// ReleasePayload 是 release 文档的签名载荷（spec §8.2）。
// 继承 manifest 的签名字节约束：对象键必须 ASCII、数字必须为有限整数；值为中文没问题。
type ReleasePayload struct {
	SchemaVersion  int    `json:"schema_version"`
	Issuer         string `json:"issuer"`
	IssuedAt       string `json:"issued_at"`
	VersionName    string `json:"version_name"`
	MinVersionName string `json:"min_version_name"`
	ApkURL         string `json:"apk_url"`
	ApkSize        int64  `json:"apk_size"`
	ApkSHA256      string `json:"apk_sha256"`
	Notes          string `json:"notes"`
}

// ReleaseDoc 是签名文档本体。payload 与 signature 分离（而不是像 manifest 那样平铺 + 去字段）：
// notes 是自由文本，平铺口径要求签名方与验签方对「哪些字段参与」有一致的隐含约定，容易漂移。
type ReleaseDoc struct {
	Payload   ReleasePayload `json:"payload"`
	Signature string         `json:"signature"`
}

// ReleaseSignBytes 返回签名字节：payload 的规范化 JSON（signature 不在域内）。
func (d ReleaseDoc) ReleaseSignBytes() ([]byte, error) {
	raw, err := json.Marshal(d.Payload)
	if err != nil {
		return nil, fmt.Errorf("release sign bytes: %w", err)
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, fmt.Errorf("release sign bytes: %w", err)
	}
	return Canonicalize(obj)
}

// SignWith 用私钥种子对 ReleaseSignBytes 签名，并写入 Signature。
func (d *ReleaseDoc) SignWith(seedHex string) error {
	b, err := d.ReleaseSignBytes()
	if err != nil {
		return err
	}
	sig, err := Sign(seedHex, b)
	if err != nil {
		return err
	}
	d.Signature = sig
	return nil
}

// Verify 用公钥验签；schema_version 不是 1 直接判为不可用（未来版本不猜语义）。
func (d ReleaseDoc) Verify(pubHex string) (bool, error) {
	if d.Payload.SchemaVersion != 1 {
		return false, nil
	}
	b, err := d.ReleaseSignBytes()
	if err != nil {
		return false, err
	}
	return Verify(pubHex, b, d.Signature)
}

// MarshalCanonical 返回落盘字节：整个文档（payload + signature）的规范化 JSON。
func (d ReleaseDoc) MarshalCanonical() ([]byte, error) {
	raw, err := json.Marshal(d)
	if err != nil {
		return nil, fmt.Errorf("release marshal: %w", err)
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, fmt.Errorf("release marshal: %w", err)
	}
	return Canonicalize(obj)
}
```

在 `tools/genvectors/main.go` 里：import 段加 `"strings"`；`main()` 里 `writeRequestSig` 之后加：

```go
	if err := writeRelease(*out); err != nil {
		fail(err)
	}
```

在 `writeRequestSig` 之后插入：

```go
// writeRelease 产出一份确定性的 release 文档黄金向量：固定 payload → 待签字节 → 签名。
func writeRelease(out string) error {
	kp, err := protocol.KeyPairFromSeed(testSeed)
	if err != nil {
		return err
	}
	doc := protocol.ReleaseDoc{Payload: protocol.ReleasePayload{
		SchemaVersion: 1, Issuer: "base-node-1", IssuedAt: "2026-09-27T00:00:00Z",
		VersionName: "0.2.0", MinVersionName: "0.1.0",
		ApkURL: "http://node.example.com/dl/base-0.2.0.apk", ApkSize: 12345678,
		ApkSHA256: strings.Repeat("ab", 32), Notes: "课程、答题与我的；四 tab 定稿",
	}}
	if err := doc.SignWith(testSeed); err != nil {
		return err
	}
	signBytes, err := doc.ReleaseSignBytes()
	if err != nil {
		return err
	}
	raw, err := doc.MarshalCanonical()
	if err != nil {
		return err
	}
	return writeJSON(filepath.Join(out, "release.json"), map[string]any{
		"version": 1,
		"key":     map[string]any{"seed_hex": testSeed, "pub_hex": kp.PubHex},
		"cases": []any{map[string]any{
			"name":          "release_0_2_0",
			"sign_bytes":    string(signBytes),
			"signature_hex": doc.Signature,
			"doc_sha256":    protocol.SHA256Hex(raw),
			"doc":           doc,
		}},
	})
}
```

- [ ] **Step 4: 跑测试并生成向量**

Run: `go test ./internal/protocol/ -run TestRelease -v`
Expected: PASS

Run: `go run ./tools/genvectors -out vectors/v1`
Expected: 输出含 `wrote vectors\v1\release.json`；`git status` 显示 `vectors/v1/release.json` 为新增，其余向量文件未变化。

Run: `go test ./...`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add internal/protocol/release.go internal/protocol/release_test.go tools/genvectors/main.go vectors/v1/release.json
git commit -m "feat(protocol): release 签名文档与黄金向量（payload 与 signature 分离）"
```

---

### Task 16: TS 侧消费 release 向量

**Files:**
- Create: `packages/protocol-ts/src/release.ts`
- Modify: `packages/protocol-ts/src/index.ts`
- Modify: `packages/protocol-ts/src/vectors.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `packages/protocol-ts/src/vectors.test.ts` 的 import 块里补：

```ts
  releaseDocSha256,
  releaseSignBytes,
  signRelease,
  verifyRelease,
  type ReleaseDoc,
```

（按字母序插到现有 import 列表里，`canonicalize` 与 `deriveIdentityId` 之间、`sign` 与 `signBytes` 之间。）

在文件末尾追加：

```ts
describe("release.json", () => {
  const f = load("release.json");
  it("version 与密钥", () => {
    expect(f.version).toBe(1);
    expect(keyPairFromSeed(f.key.seed_hex).pubHex).toBe(f.key.pub_hex);
  });
  for (const c of f.cases) {
    it(c.name, () => {
      const doc = c.doc as ReleaseDoc;
      expect(verifyRelease(doc, f.key.pub_hex)).toBe(true);
      expect(releaseSignBytes(doc.payload)).toBe(c.sign_bytes);
      expect(doc.signature).toBe(c.signature_hex);
      expect(releaseDocSha256(doc)).toBe(c.doc_sha256);
      expect(signRelease(doc.payload, f.key.seed_hex)).toEqual(doc);
    });
    it(c.name + "：篡改后拒收", () => {
      const badVersion = JSON.parse(JSON.stringify(c.doc)) as ReleaseDoc;
      badVersion.payload.version_name = "9.9.9";
      expect(verifyRelease(badVersion, f.key.pub_hex)).toBe(false);

      const badSig = JSON.parse(JSON.stringify(c.doc)) as ReleaseDoc;
      badSig.signature = "0" + badSig.signature.slice(1);
      expect(verifyRelease(badSig, f.key.pub_hex)).toBe(false);

      const badSchema = JSON.parse(JSON.stringify(c.doc)) as ReleaseDoc;
      badSchema.payload.schema_version = 2;
      expect(verifyRelease(badSchema, f.key.pub_hex)).toBe(false);
    });
  }
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -w @base/protocol-ts -- vectors`
Expected: FAIL —— `verifyRelease is not a function` / 模块无导出

- [ ] **Step 3: 写实现**

创建 `packages/protocol-ts/src/release.ts`：

```ts
import { canonicalize, type Json } from "./canonical";
import { sign, verify } from "./ed25519";
import { sha256Hex, utf8 } from "./hash";

/** release 文档的签名载荷（spec §8.2）。 */
export interface ReleasePayload {
  schema_version: number;
  issuer: string;
  issued_at: string;
  version_name: string;
  min_version_name: string;
  apk_url: string;
  apk_size: number;
  apk_sha256: string;
  notes: string;
}

export interface ReleaseDoc {
  payload: ReleasePayload;
  signature: string;
}

/** 签名字节 = payload 的规范化 JSON（signature 不在域内，故无需删字段）。 */
export function releaseSignBytes(p: ReleasePayload): string {
  return canonicalize(p as unknown as Json);
}

export function signRelease(p: ReleasePayload, seedHex: string): ReleaseDoc {
  return { payload: p, signature: sign(seedHex, utf8(releaseSignBytes(p))) };
}

export function verifyRelease(doc: ReleaseDoc, pubHex: string): boolean {
  if (!doc || typeof doc !== "object" || !doc.payload) return false;
  if (doc.payload.schema_version !== 1) return false;
  try {
    return verify(pubHex, utf8(releaseSignBytes(doc.payload)), doc.signature);
  } catch {
    return false;
  }
}

/** 落盘字节的 sha256（与 Go 侧 MarshalCanonical 对齐）。 */
export function releaseDocSha256(doc: ReleaseDoc): string {
  return sha256Hex(utf8(canonicalize(doc as unknown as Json)));
}
```

在 `packages/protocol-ts/src/index.ts` 末尾追加：

```ts
export * from "./release";
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -w @base/protocol-ts`
Expected: PASS（既有向量用例 + `release.json` 用例全绿）

Run: `npm test`
Expected: PASS（Go 与 TS 两侧都消费同一份 `vectors/v1/release.json`）

- [ ] **Step 5: 提交**

```bash
git add packages/protocol-ts/src/release.ts packages/protocol-ts/src/index.ts packages/protocol-ts/src/vectors.test.ts
git commit -m "feat(protocol-ts): release 验签与向量消费"
```

---

### Task 17: 节点侧 `GET /v1/release` 与 `based release`

**Files:**
- Create: `internal/httpapi/release.go`
- Test: `internal/httpapi/release_test.go`
- Modify: `internal/httpapi/server.go`
- Create: `cmd/based/release.go`
- Modify: `cmd/based/main.go`

- [ ] **Step 1: 写失败的测试**

创建 `internal/httpapi/release_test.go`：

```go
package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestReleaseUnavailableIsNotFound(t *testing.T) {
	_, _, ts := newTestServer(t)
	resp, err := http.Get(ts.URL + "/v1/release")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("无文件时状态 = %d，期望 404", resp.StatusCode)
	}
}

func TestReleaseServedVerbatim(t *testing.T) {
	st, _, ts := newTestServer(t)
	doc := protocol.ReleaseDoc{Payload: protocol.ReleasePayload{
		SchemaVersion: 1, Issuer: "base-node-1", IssuedAt: "2026-09-27T00:00:00Z",
		VersionName: "0.2.0", MinVersionName: "0.1.0",
		ApkURL: "http://node.example.com/dl/base-0.2.0.apk", ApkSize: 12345678,
		ApkSHA256: "ab", Notes: "课程、答题与我的",
	}}
	if err := doc.SignWith(testSeed); err != nil {
		t.Fatalf("SignWith: %v", err)
	}
	raw, err := doc.MarshalCanonical()
	if err != nil {
		t.Fatalf("MarshalCanonical: %v", err)
	}
	path := filepath.Join(st.DataDir(), "release.json")
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatalf("写 release.json: %v", err)
	}

	resp, err := http.Get(ts.URL + "/v1/release")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("状态 = %d，期望 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", ct)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读响应: %v", err)
	}
	if string(body) != string(raw) {
		t.Fatalf("响应体与文件不一致\n got %s\nwant %s", body, raw)
	}
	// 客户端拿到的字节必须能验签通过（节点不做任何合成/改写）
	var back protocol.ReleaseDoc
	if err := json.Unmarshal(body, &back); err != nil {
		t.Fatalf("反序列化: %v", err)
	}
	kp, _ := protocol.KeyPairFromSeed(testSeed)
	if ok, err := back.Verify(kp.PubHex); err != nil || !ok {
		t.Fatalf("响应体验签失败: ok=%v err=%v", ok, err)
	}
}
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `go test ./internal/httpapi/ -run TestRelease -v`
Expected: FAIL —— `无文件时状态 = 200，期望 404`（路由未注册时是 404 但内容不同；若路由已存在会命中首页 handler）。以 `TestReleaseServedVerbatim` 失败为准。

- [ ] **Step 3: 写实现**

创建 `internal/httpapi/release.go`：

```go
package httpapi

import (
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

// handleRelease 原样吐出节点数据目录下的 release.json（spec §8.3）。
// 节点不验签、不缓存、不合成：只把签发好的文件读出来；文件不存在即 404，
// App 把 404 当作「本节点无升级信息」并静默忽略。
func (s *Server) handleRelease(w http.ResponseWriter, r *http.Request) {
	f, err := os.Open(filepath.Join(s.st.DataDir(), "release.json"))
	if errors.Is(err, os.ErrNotExist) {
		s.writeError(w, http.StatusNotFound, "本节点无升级信息")
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer f.Close()
	if err := writeFileResponse(w, f, "application/json; charset=utf-8", false); err != nil {
		log.Printf("httpapi: 写 release 响应失败: %v", err)
	}
}
```

在 `internal/httpapi/server.go` 的 `publicMux` 里，`GET /v1/blob/{blob_id}` 之后插入：

```go
	mux.HandleFunc("GET /v1/release", s.handleRelease)
```

创建 `cmd/based/release.go`：

```go
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/johocn/base/internal/protocol"
)

// runRelease 用源节点私钥签发 release 文档（spec §8.3）。
// -apk-file 用于计算 apk_size 与 apk_sha256，避免手填出错。
// -min-version-name 刻意不给默认值：它进签名载荷，一旦签高会让所有老客户端立刻被强更拦住（spec §11 风险 3）。
func runRelease(args []string) error {
	fs := flag.NewFlagSet("release", flag.ExitOnError)
	versionName := fs.String("version-name", "", "最新版本名 x.y.z（必填）")
	minVersionName := fs.String("min-version-name", "", "最低可用版本 x.y.z（必填；高于客户端本地版本即强制更新）")
	apkURL := fs.String("apk-url", "", "APK 下载地址，绝对 URL（必填）")
	apkFile := fs.String("apk-file", "", "本地 APK 路径（必填，用于算 size 与 sha256）")
	notes := fs.String("notes", "", "版本说明（允许中文，参与签名）")
	out := fs.String("out", "", "输出路径；空 = <data>/release.json")
	data := fs.String("data", envOr("BASE_DATA", "data"), "数据目录")
	issuer := fs.String("issuer", envOr("BASE_ISSUER", "base-node-1"), "签发方标识")
	key := fs.String("sign-key", os.Getenv("BASE_SIGN_KEY"), "Ed25519 私钥种子（hex64）；与签发 manifest 同一把")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *versionName == "" || *minVersionName == "" || *apkURL == "" || *apkFile == "" {
		return fmt.Errorf("release: -version-name、-min-version-name、-apk-url、-apk-file 均为必填")
	}
	if *key == "" {
		return fmt.Errorf("release: 缺少 -sign-key（或环境变量 BASE_SIGN_KEY）：没有私钥不能签发升级文档")
	}
	size, sum, err := fileSHA256(*apkFile)
	if err != nil {
		return fmt.Errorf("release: 读取 APK 失败: %w", err)
	}
	doc := protocol.ReleaseDoc{Payload: protocol.ReleasePayload{
		SchemaVersion:  1,
		Issuer:         *issuer,
		IssuedAt:       time.Now().UTC().Format("2006-01-02T15:04:05Z"),
		VersionName:    *versionName,
		MinVersionName: *minVersionName,
		ApkURL:         *apkURL,
		ApkSize:        size,
		ApkSHA256:      sum,
		Notes:          *notes,
	}}
	if err := doc.SignWith(*key); err != nil {
		return err
	}
	raw, err := doc.MarshalCanonical()
	if err != nil {
		return err
	}
	path := *out
	if path == "" {
		path = filepath.Join(*data, "release.json")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		return err
	}
	kp, err := protocol.KeyPairFromSeed(*key)
	if err != nil {
		return err
	}
	fmt.Printf("release: version_name=%s min_version_name=%s → %s\n", *versionName, *minVersionName, path)
	fmt.Printf("  apk_size=%d apk_sha256=%s\n", size, sum)
	fmt.Printf("  public_key   %s\n", kp.PubHex)
	return nil
}

func fileSHA256(path string) (int64, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return 0, "", err
	}
	return n, hex.EncodeToString(h.Sum(nil)), nil
}
```

在 `cmd/based/main.go` 里加子命令：

```go
	case "release":
		err = runRelease(os.Args[2:])
```

（放在 `case "export":` 之后。）

并把 `usage()` 的字符串改为：

```go
	fmt.Fprintln(os.Stderr, "usage: based <version|import-md|import-video|export|release|serve|pubkey|store-key|tls-cert|peer-sync|scrub> [flags]")
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `go test ./internal/httpapi/ -run TestRelease -v`
Expected: PASS

Run: `go test ./... && go build ./cmd/based`
Expected: PASS 且二进制编译通过

- [ ] **Step 5: 提交**

```bash
git add internal/httpapi/release.go internal/httpapi/release_test.go internal/httpapi/server.go cmd/based/release.go cmd/based/main.go
git commit -m "feat(node): GET /v1/release 与 based release 签发命令"
```

---

### Task 18: App 升级检查（判定 + 设置页 + 启动检查）

**Files:**
- Create: `apps/mobile/src/core/update.ts`
- Test: `apps/mobile/src/core/update.test.ts`
- Modify: `apps/mobile/src/platform/uni.ts`（补 `runtime.version` 类型）
- Modify: `apps/mobile/src/pages/setting/setting.vue`
- Modify: `apps/mobile/src/App.vue`

- [ ] **Step 1: 写失败的测试**

创建 `apps/mobile/src/core/update.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import { compareVersionName, decideUpdate, parseVersionName } from './update';

describe('parseVersionName', () => {
  it('三段数字合法', () => {
    expect(parseVersionName('0.2.0')).toEqual([0, 2, 0]);
  });

  it('非数字、空串、含字母一律 null', () => {
    expect(parseVersionName('')).toBeNull();
    expect(parseVersionName('0.2')).toEqual([0, 2]);
    expect(parseVersionName('0.2.0-beta')).toBeNull();
    expect(parseVersionName('v0.2.0')).toBeNull();
    expect(parseVersionName('0..2')).toBeNull();
  });
});

describe('compareVersionName', () => {
  it('三段数值比较，不是字符串比较', () => {
    expect(compareVersionName('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersionName('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersionName('0.2.0', '0.2.0')).toBe(0);
  });

  it('段数不等时缺位按 0', () => {
    expect(compareVersionName('0.1', '0.1.0')).toBe(0);
    expect(compareVersionName('0.1', '0.1.1')).toBe(-1);
  });

  it('任一侧非法返回 null（文档判为不可用）', () => {
    expect(compareVersionName('0.1.0', 'beta')).toBeNull();
  });
});

describe('decideUpdate', () => {
  const base = { schema_version: 1, version_name: '0.2.0', min_version_name: '0.1.0' };

  it('本地已是最新', () => {
    expect(decideUpdate('0.2.0', base)).toBe('latest');
    expect(decideUpdate('0.3.0', base)).toBe('latest');
  });

  it('可取消更新与强制更新由 min_version_name 分界', () => {
    expect(decideUpdate('0.1.0', base)).toBe('optional');
    expect(decideUpdate('0.1.0', { ...base, min_version_name: '0.2.0' })).toBe('forced');
  });

  it('schema_version 不符或版本串非法 → ignore', () => {
    expect(decideUpdate('0.1.0', { ...base, schema_version: 2 })).toBe('ignore');
    expect(decideUpdate('beta', base)).toBe('ignore');
    expect(decideUpdate('0.1.0', { ...base, version_name: 'beta' })).toBe('ignore');
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -w @base/mobile -- update`
Expected: FAIL —— `Failed to resolve import "./update"`

- [ ] **Step 3: 写实现**

创建 `apps/mobile/src/core/update.ts`：

```ts
// 升级判定：纯逻辑，不碰网络、不弹窗（spec §8.4 的判定表）。
// 红线：任何失败都不得阻断 App 使用——本文件不抛错，一律返回 ignore/latest。

/** 三段数值解析；任一段非数字或为空即 null。 */
export function parseVersionName(s: string): number[] | null {
  const t = s.trim();
  if (!/^\d+(\.\d+)*$/.test(t)) return null;
  return t.split('.').map((x) => Number(x));
}

/** 三段数值比较：段数不等时缺位按 0。任一侧非法返回 null。 */
export function compareVersionName(a: string, b: string): number | null {
  const pa = parseVersionName(a);
  const pb = parseVersionName(b);
  if (pa === null || pb === null) return null;
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export interface ReleasePayloadShape {
  schema_version: number;
  version_name: string;
  min_version_name: string;
}

export type UpdateDecision = 'ignore' | 'latest' | 'optional' | 'forced';

/**
 * ignore：静默丢弃（验签已由调用方负责；此处只判可判定的部分）
 * latest：已是最新；optional：可取消弹窗；forced：不可取消弹窗
 */
export function decideUpdate(localVersion: string, payload: ReleasePayloadShape): UpdateDecision {
  if (payload.schema_version !== 1) return 'ignore';
  const cmp = compareVersionName(localVersion, payload.version_name);
  if (cmp === null) return 'ignore';
  if (cmp >= 0) return 'latest';
  const minCmp = compareVersionName(localVersion, payload.min_version_name);
  if (minCmp === null) return 'ignore';
  return minCmp < 0 ? 'forced' : 'optional';
}
```

在 `apps/mobile/src/platform/uni.ts` 的 `PlusRuntime` 接口里补一项（若已有 `runtime` 则跳过）：

```ts
  /** App 版本号（plus.runtime.version），升级判定用；缺省时按空串处理 */
  runtime?: { version?: string };
```

在 `apps/mobile/src/pages/setting/setting.vue` 追加「当前版本 / 检查更新」区块。

`<template>` 末尾（`probeLines` 循环之后）插入：

```vue
    <view class="ver">
      <text class="meta">当前版本：{{ localVersion }}</text>
      <button size="mini" @click="checkUpdate">检查更新</button>
      <text v-if="updateLine" class="meta">{{ updateLine }}</text>
    </view>
```

`<script setup lang="ts">` 追加：

```ts
import { decideUpdate } from '../../core/update';
import { releaseSignBytes, verifyRelease, type ReleaseDoc } from '@base/protocol-ts';

const localVersion = ref(String(plusRuntime()?.runtime?.version ?? '0.0.0'));
const updateLine = ref('');

/**
 * 升级通道的任何失败都静默：节点是明文 HTTP，不能让它成为可被用来 DoS 客户端的入口（spec §8.4 红线）。
 * 只有「已是最新」写结果行，其余情形不写任何 error。
 */
async function checkUpdate() {
  updateLine.value = '';
  try {
    const { repo, opts } = await bootstrap();
    if (!opts.nodeBaseUrl) return;
    const pubHex = await repo.getConfig('pubkey_hex');
    if (!pubHex) return;
    const res = await opts.adapters.http.get(`${opts.nodeBaseUrl}/v1/release`);
    if (res.status !== 200) return;
    const doc = JSON.parse(decodeUtf8(res.body)) as ReleaseDoc;
    if (!verifyRelease(doc, pubHex)) return;
    const decision = decideUpdate(localVersion.value, doc.payload);
    if (decision === 'latest') {
      updateLine.value = `已是最新 ${localVersion.value}`;
      return;
    }
    if (decision === 'ignore') return;
    const shortSha = doc.payload.apk_sha256.slice(0, 16);
    const notes = doc.payload.notes ? `\n${doc.payload.notes}` : '';
    uni.showModal({
      title: `发现新版本 ${doc.payload.version_name}`,
      content: `${notes}\napk sha256(前16位)：${shortSha}`,
      showCancel: decision === 'optional',
      cancelText: '以后再说',
      confirmText: '去下载',
      success: (r) => {
        // 本版走浏览器打开下载链接（spec §8.5）；App 无法校验下载到的 APK 字节，故展示 sha256 供人工核对
        if (r.confirm) uni.navigateTo({ url: '/pages/setting/setting' }) || openApkUrl(doc.payload.apk_url);
      },
    });
  } catch {
    // 静默
  }
}

function openApkUrl(url: string) {
  const p = plusRuntime();
  if (p?.runtime && typeof (p as unknown as { runtime: { openURL?: (u: string) => void } }).runtime.openURL === 'function') {
    (p as unknown as { runtime: { openURL: (u: string) => void } }).runtime.openURL(url);
    return;
  }
  uni.setClipboardData({ data: url });
}
```

> 上面 `uni.navigateTo(...) || openApkUrl(...)` 是**错的写法**（`navigateTo` 返回 undefined）。落地时改为：

```ts
      success: (r) => {
        if (r.confirm) openApkUrl(doc.payload.apk_url);
      },
```

`decodeUtf8` 从 `../../core/sync` 导入（老 WebView 没有 `TextDecoder`）：

```ts
import { decodeUtf8 } from '../../core/sync';
```

在 `apps/mobile/src/App.vue` 的 `onLaunch` 里追加一次静默检查（与设置页同一个 `checkUpdate`，故把上面 `checkUpdate` 的函数体抽到 `apps/mobile/src/core/update.ts` 之外的一个新文件会引入循环依赖；**本版做法**：`App.vue` 只调用设置页同一段逻辑的最简副本——读取 `release` 并在 `optional`/`forced` 时弹窗。为避免重复代码，把它写进 `apps/mobile/src/core/update.ts` 里的 `fetchReleaseDoc(opts, pubHex)`，由两处调用）：

在 `apps/mobile/src/core/update.ts` 末尾追加：

```ts
import { decodeUtf8 } from './sync';
import { verifyRelease, type ReleaseDoc } from '@base/protocol-ts';
import type { HttpAdapter } from '../platform/adapter';

/** 拉取并验签 release 文档；任何失败返回 null（调用方一律静默）。 */
export async function fetchReleaseDoc(
  http: HttpAdapter,
  nodeBaseUrl: string,
  pubHex: string,
): Promise<ReleaseDoc | null> {
  try {
    const res = await http.get(`${nodeBaseUrl}/v1/release`);
    if (res.status !== 200) return null;
    const doc = JSON.parse(decodeUtf8(res.body)) as ReleaseDoc;
    return verifyRelease(doc, pubHex) ? doc : null;
  } catch {
    return null;
  }
}
```

`App.vue` 的 `onLaunch` 追加：

```ts
    // 启动即静默检查一次升级；红线：任何失败都不阻断启动（spec §8.4）
    void (async () => {
      try {
        const { repo, opts } = await bootstrap();
        if (!opts.nodeBaseUrl) return;
        const pubHex = await repo.getConfig('pubkey_hex');
        if (!pubHex) return;
        const doc = await fetchReleaseDoc(opts.adapters.http, opts.nodeBaseUrl, pubHex);
        if (!doc) return;
        const decision = decideUpdate(localVersion, doc.payload);
        if (decision !== 'optional' && decision !== 'forced') return;
        uni.showModal({
          title: `发现新版本 ${doc.payload.version_name}`,
          content: doc.payload.notes || '有新版本可用',
          showCancel: decision === 'optional',
          cancelText: '以后再说',
          confirmText: '去下载',
          success: (r) => {
            if (r.confirm) uni.setClipboardData({ data: doc.payload.apk_url });
          },
        });
      } catch {
        // 静默
      }
    })();
```

（`localVersion` 在 `App.vue` 里取 `String(plusRuntime()?.runtime?.version ?? '0.0.0')`。）

- [ ] **Step 4: 跑测试、类型检查与构建，确认通过**

Run: `npm test -w @base/mobile -- update`
Expected: PASS

Run: `npm run typecheck -w @base/mobile`
Expected: 无输出

Run: `npm run build:app -w @base/mobile`
Expected: 构建成功

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/core/update.ts apps/mobile/src/core/update.test.ts apps/mobile/src/platform/uni.ts apps/mobile/src/pages/setting/setting.vue apps/mobile/src/App.vue
git commit -m "feat(mobile): 升级检查（验签 + 三段版本判定 + 静默失败）"
```

---

## Phase 4：打包与验收

### Task 19: 出包、签发升级文档、真机验收

**Files:**
- Modify: `apps/mobile/src/manifest.json`（版本递增）

- [ ] **Step 1: 递增版本号**

先看当前值：

Run: `git grep -n "versionName\|versionCode" -- apps/mobile/src/manifest.json`
Expected: 当前为 `"versionName" : "0.1.0"`、`"versionCode" : "1"`

把 `apps/mobile/src/manifest.json` 改为：

```json
    "versionName" : "0.2.0",
    "versionCode" : "2",
```

- [ ] **Step 2: 云打包**

在 HBuilderX 里对本项目执行「发行 → 原生 App-云打包」，Android 出 APK。包名与其它出包前置配置已在此前的 `9ccc152` 提交里定好（AndroidManifest 放行明文流量 + 固定包名 `uni.app.UNI936A667`），本次不改。

Expected: 打包成功，得到 `base-0.2.0.apk`。

- [ ] **Step 3: 上传 APK 并签发升级文档**

把 APK 上传到节点机器的静态目录后，在节点机器上执行（`-min-version-name` 必须显式给，且**只给到本次要求的最低可用版本**）：

```bash
BASE_SIGN_KEY=<源节点私钥> based release \
  -version-name 0.2.0 \
  -min-version-name 0.1.0 \
  -apk-url http://118.190.217.242/dl/base-0.2.0.apk \
  -apk-file /path/to/base-0.2.0.apk \
  -notes "课程、答题与我的；四 tab 定稿"
```

Expected: 打印 `release: version_name=0.2.0 ...`、`apk_size`、`apk_sha256`，并写出 `<data>/release.json`。

Run（在客户端能访问的位置验证）：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://118.190.217.242/v1/release
```

Expected: `200`

- [ ] **Step 4: 真机验收（逐条打勾，对应 spec §10）**

| # | 验收项 | 判定 |
| --- | --- | --- |
| 1 | 四 tab | 四个 tab 可互相切换；从任一 tab 进详情再返回回到原 tab；无「navigateTo 不能跳 tab」报错 |
| 2 | 占位页 | 圈子 / 评论显示未开放说明，无报错、无假数据 |
| 3 | 搜索 | 输入正文中出现过的词 → 命中；输入 `%` → 不返回全部；输入空串 → 无结果且即时 |
| 4 | 收藏 | 收藏 → 「我的 → 收藏」出现；取消 → 立即消失；杀进程重进仍保持；文章撤下并同步后自动消失 |
| 5 | 阅读器 | 字号三档与深色主题重启后均保持；`read_at` 只写首次 |
| 6 | 题库配送 | 导入 1 个题库（`based import-md -dir seed`）→ 导出后 `manifest.entries[]` 出现 `sqlite_table='quizzes'` 条目；客户端同步后课程页出现该测验 |
| 7 | 答题 | 全对 → 结算 `n/total` 正确；一次作答只写**一行** `quiz_attempt`（设置页诊断可查行数）；重做后正确率按累计计算；题目格式非法 → 提示不支持且不写记录 |
| 8 | 我的 | 已读篇数与正确率与实际操作一致；从阅读器/答题页返回后立即刷新 |
| 9 | 升级·正常 | 节点 `release.json` 版本高于本地 → 弹可取消框；「去下载」能打开 `apk_url` |
| 10 | 升级·强制 | 把 `min_version_name` 改成高于本地并重签 → 弹不可取消框 |
| 11 | 升级·拒绝 | 改 `signature` 一位 / 改 `version_name` 后不重签 → 静默无提示，App 正常可用 |
| 12 | 升级·可用性 | 节点宕机 / 未配公钥 → 启动与设置页均不出现任何升级相关错误 |
| 13 | 离线不回归 | 飞行模式下：课程列表、搜索、收藏、阅读器、答题全部可用 |
| 14 | 单测与向量 | `npm test` 与 `go test ./...` 全绿；`vectors/v1/release.json` 在 Go 与 TS 两侧同时消费通过 |

其中第 7 条的 `quiz_attempt` 行数，用设置页「能力诊断」核对；若诊断里没有这一行，在 `probe()` 的 `lines` 里补：

```ts
    lines.push(`答题记录行数：${Number((await db.select('SELECT count(*) AS n FROM quiz_attempt'))[0]?.n ?? 0)}`);
```

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/manifest.json apps/mobile/src/pages/setting/setting.vue
git commit -m "chore(mobile): 版本递增到 0.2.0（四 tab + 答题 + 升级通道）"
```

---

## 完成后的自查记录（写计划时已核对）

1. **spec 覆盖**：§3 路由 → T3/T4/T5/T7/T14；§4 本地数据层 → T1（`user_state`/`quizzes`/`quiz_attempt` + §4.3 全部方法）、T8（`reader_theme`/`reader_font_scale`）；§5 → T4/T5/T6/T7/T8；§6.1 → T9/T10；§6.2 → T9（键名即契约，用 JSON 形状测试锁死）；§6.3 → T11/T12；§6.4 → T13/T14；§7 → T3（占位页）；§8.1/8.2 → T15/T16；§8.3 → T17；§8.4 → T18；§8.5 → T18（`openURL` + 展示 sha256 前 16 位）；§9 → T19；§10 → T19 Step 4 的 14 条表。**未覆盖**：§12 的 9 条待定项，本计划按 spec 刻意不做。
2. **占位扫描**：无 `TODO` / `TBD` / 「类似 Task N」；每个代码步骤都给了可直接粘贴的完整代码。
3. **类型一致性**：`QuizRow{itemId,questionJson,contentHash}` 在 T1 定义、T12 落库、T13 解析、T14 取用一致；`PackApply.quizzes` 在 T1 定义、T12 传参一致；`releaseSignBytes` 在 Go 叫 `ReleaseSignBytes`、TS 叫 `releaseSignBytes`，语义都是「payload 的 canonicalize」；`decideUpdate` 返回值 `'ignore'|'latest'|'optional'|'forced'` 在 T18 的测试与设置页 `if (decision === 'latest')` / `if (decision === 'ignore') return` 一致。
4. **顺序耦合**：T1 与 T2 需在同一提交前一起完成（`repo.ts` 依赖 `./search`）；页面注册一律由「创建该页 `.vue` 的 Task」负责（`search` → T5、`favorite` → T7、`quiz` → T14），因为 `pages.json` 里注册一个没有对应文件的路径会让 vite 构建失败；T15 必须先跑 `genvectors` 再提交，否则 T16 的向量测试无数据。

## 执行期更正（已实施后回填，后续 Task 请以本节为准）

1. **T1 `fakes.ts` 的 import 漏了一行**：计划给的 import 里没有 `import type { LocalRepo, PackApply } from './repo';`，但 `MemoryRepo implements LocalRepo` 与 `applyPack(p: PackApply)` 需要它。已按既有文件保留该行（提交 `3fca406`）。
2. **`PackApply.quizzes` 必填引发 T1 之外的连锁**：计划把 `quizzes` 定为必填数组，于是 `sync.ts` 里 `applyPack({...})` 的调用点 typecheck 报 TS2345，而 T1 的文件清单与 commit 清单都没列 `sync.ts`。已在调用点最小化补 `quizzes: []`（提交 `3fca406`）；**T12 落地 `readPackQuizzes` 时用它替换这一行**，不要再新增调用点。
3. **全量测试的既有基线是 30 项**（identity 15 + sync 10 + sql 5），不是 75；文中已更正。
4. **T4 原先要注册 `pages/search/search`，而 `search.vue` 在 T5 才创建** —— 那样 T4 的 `npm run build:app` 必然失败。已改为「谁建文件谁注册」：T4 只改 `course.vue`，T5 自己建页并注册。全计划统一这条规则。
5. **`dist` 页面级 `.js` 不存在**：实测 uni-app 把页面逻辑汇进单个 `app-service.js`，页面目录下只有 `.css`。所有 `Test-Path ...pages/<name>/<name>.js` 的核对已改成 `Test-Path ...pages/<name>`（页面目录）。
6. **T8 阅读器进度条的算法是坏的，已替换**：计划原文 `progress = Math.min(100, Math.round(e.scrollTop / 6))` —— 滚过 600px 就顶到 100%，长文里几乎全程假满格，会误导读者的阅读进度感。已改为**实测可滚动高度**：`scrollable = .wrap 高度 − uni.getSystemInfoSync().windowHeight`，进度 = `已滚 / scrollable`，并在正文渲染完（`nextTick` 后）与每次改字号后重新测量（字号变则总高变）。量不到时 `scrollable = 0`，进度条不显示（`v-if="progress > 0"`）而不是显示错的值。

7. **T9 计划内部的用例与实现自相矛盾，已按「改实现不改测试」收敛**：用例「没有题目」给的是纯文本 `只有一段正文`，而计划 Step 3 的实现里 `default` 分支无条件报「无法识别的行」，永远走不到 `len(out) == 0` 的「没有解析到任何题目」。已把 `default` 收窄为**只在题目块内**（`cur != nil`）报错，题目开始前的普通文本视作前言忽略（提交 `dd93084`）。这样既满足 spec §6.1「只认三种元素、不部分导入」的失败语义，也保留了「题目块内写错行必须报错」的护栏（漏写 `- ` 的选项仍会失败）。

8. **T10 `importQuiz` 去掉未使用的 `meta` 参数**：计划给的签名带 `meta map[string]string`，计划自己的注里也承认当前用不上（`quizzes` 表没有 `tags` / `published_at` 列）。按「拒绝冗余、不为假想需求留参数」收敛为 `importQuiz(st *store.Store, filename string, raw []byte) error`，`Run` 的调用点同步改为 `importQuiz(st, name, raw)`（提交 `40bea8f`）。分流判断仍在 `Run` 里用 `meta["type"] == "quiz"`。

9. **T15 顺带 `gofmt -w` 了 `tools/genvectors/main.go` 里既存的 6 行对齐**：`writeManifest` 的两处 map 字面量在改动前就是 gofmt 违规（`git show HEAD:tools/genvectors/main.go | gofmt -l` 可复现）。为满足「改动的文件 gofmt 干净」，对该文件整体跑了一次 `gofmt -w`，除新增的 `writeRelease` 外只多出这 6 行的空白重排，无语义变化（提交 `8e22004`）。

10. **T18 三处收敛（提交 `322c090`）**：①计划把 `import { decodeUtf8 } from './sync'` 等写在 `update.ts` **文件末尾**，那是错的，已合并到文件顶部的 import 块；②`PlusRuntime` 只补**一个**字段 `runtime?: { version?: string; openURL?: (url: string) => void }`，避免计划里 `openApkUrl` 那两处 `as unknown as` 强制转换；③把设置页与 `App.vue` 里各写一份的「拉取验签 + 打开下载链接 + 弹窗」抽成 `fetchReleaseDoc` / `openApkUrl` / `promptUpdate` 三个函数放在 `update.ts`，两处调用点复用——否则计划原文会出现「设置页用浏览器打开、App.vue 复制到剪贴板」的行为漂移（计划自己标注的 `uni.navigateTo(...) || openApkUrl(...)` 错写法也已按注改为直接调 `openApkUrl`）。`uni` 全局有 `@dcloudio/types` 的 `declare const uni`，故这三个函数可以留在 `core/` 而不需要挪回页面。

11. **T19 Step 3 的部署实况与计划假设不符，已按实际执行**：
    - **主机**：分发节点是 `ssh me`（`HostName 118.190.217.242`，root）；`ssh joho` 是另一台机器（39.97.54.5，Strapi 那台），与分发无关。
    - **同机双节点**：源节点 `base.service`（`/opt/base`，客户端监听 **:443 TLS**，对端 :8081）+ 缓存节点 `base-cache.service`（`/opt/base-cache`，客户端监听 `127.0.0.1:8083` **明文**，对端 127.0.0.1:8082）。两个单元 `ExecStart` 都指向 `/opt/base/based`；`/opt/base-cache/based` 是历史遗留副本，替换时需一并覆盖，否则哪条路径生效取决于单元文件，容易只换一半。
    - **nginx :80**：`location /` → `http://127.0.0.1:8083`（**缓存节点**）；`location /dl/` → `127.0.0.1:8080`（`appdl.service`，python3 静态服务，docroot `/opt/appdl`）。因此 `release.json` 必须落在**缓存节点**（`/opt/base-cache/data/release.json`）——写进源节点 `/opt/base/data` 客户端永远读不到。计划 Step 3 的 `based release` 默认输出 `<data>/release.json`，本次用 `-out` 显式指到缓存节点数据目录。
    - **Step 3 漏了「部署新二进制」这一步**：`GET /v1/release` 是 T17 才新增的路由，而节点上跑的是 2026-09-26 构建的旧二进制——它在 `/v1/release` 上返回 Go 默认的 `404 page not found`（无 CORS、`text/plain`），也就是「升级通道静默失效」，光签发 release.json 不会生效。已按 `scripts/build-release.ps1` 的口径交叉编译 linux/amd64（`CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=0.3.0"`，产物 14303392 字节），备份为 `based.bak-20260926` 后替换两处二进制、`systemctl daemon-reload` 并按 `base.service` → `base-cache.service` 顺序重启。上线判据是 `/v1/release` 返回**我们的** `{"error":"本节点无升级信息"}`（带 CORS + `application/json`），而不是 Go 的裸 404。
    - **APK 与落地页**：APK 用固定名放 `/opt/appdl/base-0.3.0.apk`（`/dl/base-0.3.0.apk`，与签名文档里的 `apk_url` 一致），`/opt/appdl/index.html` 同步从 0.1.0 改为指向它；0.1.0 的 APK 与页面内容保留不删。
    - **`-min-version-name` 取 0.2.0**：0.1.0 装机 → 强制更新；0.2.0 → 可取消；0.3.0 → 已是最新。这一条进签名载荷，改口径要重签。
    - **验证签名的落盘方式（踩坑）**：不要用 PowerShell 5.1 的 `Out-File -Encoding ascii|utf8` 保存从 HTTP 抓下来的 release 文档——`ascii` 会把 `notes` 里的中文写成 `?`，`utf8` 会加 BOM，两种都会让 TS 侧 `verifyRelease` 假阴性（本次先误判成 Go/TS 签名互操作有 bug，用 ASCII-notes 与中文-notes 各签一份对照才定位到是落盘环节）。正确做法：`ssh ... "curl -s <url> | base64 -w0"` 传输，本地 `[Convert]::FromBase64String` 写字节，再喂给客户端验签器。
    - **实测结果**：`/v1/catalog` 200、`/v1/manifest/{pack_id}` 200、`/v1/pack/{pack_id}` 200（45056 字节）、`/v1/release` 200 且 TS 侧验签通过（公钥=App 预置的 `48c33db9…24f4`）、`/dl/base-0.3.0.apk` 200 且 `size_download=27363355` 与签名文档 `apk_size`/`apk_sha256` 一致。APK 内嵌 `version.name=0.3.0`/`code=3`、tabBar 为课程/圈子/评论/我的，均与 spec §3 一致。
    - `/v1/pubkey` 在客户端侧返回 404 `{"error":"本节点未配置签名密钥（只读分发节点）"}` 是缓存节点的**正常**行为（客户端监听到的就是缓存节点），不是回归。

12. **0.4.1（发评论修复 + 阅读器增强）部署实况（提交 `618c7ee`）**：
    - 出包：`D:\HBuilderX\cli.exe pack --project e:\code\base\apps\mobile --platform android --android.packagename uni.app.UNI936A667 --android.androidpacktype 3`，云端打包完成后**必须自己把 APK 存到 `apps/mobile/dist/release/apk/`**（CLI 只回一个临时下载地址，5 次有效，`__UNI__936A667__<时间戳>.apk` 的命名文件不会自动落到该目录）。
    - **证书一致性要核**：APK 的签名证书指纹用 `keytool -printcert -jarfile` 比对上一版（本次 0.4.0 与 0.4.1 同为 DCloud 云证书 `19:95:21:ED…`）。注意 `META-INF/CERT.RSA` 的**文件字节哈希会因打包细节不同而变**，不能用它判断换没换证书——只看 `keytool` 的指纹。
    - 发布：APK → `/opt/appdl/base-0.4.1.apk`；`/opt/appdl/index.html` 指向新版本；`based release -version-name 0.4.1 -min-version-name 0.4.0 -apk-url http://118.190.217.242/dl/base-0.4.1.apk -apk-file /opt/appdl/base-0.4.1.apk -notes <无空格说明> -out /opt/base-cache/data/release.json`。
    - **`-notes` 带空格会吃掉后面的 flag（踩坑）**：Go 的 `flag` 在遇到第一个非 flag 参数后停止解析，`-notes 修复真机发表评论失败 阅读器字号四档与护眼主题 -out …` 会把第二个词当位置参数、`-out` 整条失效，文档被写到默认的 `/opt/base/data/release.json`（客户端读不到），且 `notes` 只剩半句。ssh 里没有引号可用，所以 `-notes` 必须写成**不含空格**的一个 token（用中文分号连接），或放到所有 flag 之后。
    - 验证：`/v1/release` 200、`/dl/base-0.4.1.apk` 200 且 `size_download=27370082` 与文档 `apk_size`/`apk_sha256`（`3908fbe5…`）一致；线上文档用客户端验签器（`verifyRelease` + 预置公钥 `48c33db9…24f4`）验过为 true。APK 内 `www/manifest.json` 为 `version.name=0.4.1`/`code=5`，`app-service.js` 含 `randomblob`、`兜底随机源`、`随机池不足`、`护眼` 四处特征串。

## 明确不做的（spec §1，任何实现都不得顺手加）

不做评论/圈子的真实功能、不做 App 侧 markdown 解析、不做答题结果上报、不做滚动位置恢复、不做全站深色主题、不做 FTS5、不做 wgt 热更新、不做 App 内下载 APK 与 `plus.runtime.install`、不做账号/设备身份上行、不做 tabBar 图标、不做节点侧分发与反熵改动（除 §6.3 导出增一类表与 §8.3 新增一个只读接口）。