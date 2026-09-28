# base 创作与治理 UI 实施计划（治理主线 第 4 册 · #29 → 计划 #30）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `executing-plans` 逐 Task 执行。每个 Task 完成后做一次两阶段复核（① 对着册子核「做了什么 / 有没有少」；② 对着代码核「写的和计划是否一致」），通过后再进入下一个 Task。步骤用 `- [ ]` 复选框跟踪。

**Goal**：把 #29 册子落地为手机端四个页面（投稿编辑器 / 我的条目 / 提案与投票 / 我的贡献）、本地台账表 `my_submissions`、投稿编排（本地校验 → 身份登记 → 客户端算 `content_hash` → 作者签名 → 直发 / 入队 / 补发）、节点公开页只读看板 `/governance`、tabBar 八个图标。

**Architecture**：纯逻辑统一落 `apps/mobile/src/core/`（不 import `uni`/`plus`，配 vitest），页面只做渲染与跳转；节点看板是服务端渲染、直接读库、**不调接口**。**零新增 HTTP 接口**——写路径走 #25 的 `POST /v1/submit`、#27 的 `POST /v1/proposal` / `POST /v1/proposal/{id}/vote`、#23 的 `POST /v1/profile`，读路径走既有匿名接口。

**Tech Stack**：TypeScript + Vue 3 + uni-app（`apps/mobile`，workspace `@base/mobile`）；Go 1.25 + `html/template`（节点）；`@base/protocol-ts`（`sha256Hex` / `sign` / `authorSignBytes` / `canonicalize`）；测试 vitest + `go test`。

**上游 spec**：`docs/superpowers/specs/2026-09-28-base-creation-ui-design.md`（**唯一契约来源**）。与册子冲突时以册子为准；要改口径先改册子（走 `## 0. 改版说明`），并在本计划追加「执行期更正」。

**基线**：`e:\code\base` HEAD = `6be58c5`；工作区仅 `.gitignore` 未提交（**属其它任务，本计划一律不碰**）。移动端 `npx vitest run`（cwd `apps/mobile`）= **12 文件 / 112 项全绿**。

---

## 已核实的环境事实（勿再验证）

| 事实 | 值 |
|---|---|
| 本机 shell | Windows PowerShell 5.1，**不支持 `&&`**；多命令用 `;` 或分行写 |
| 中文读取 | PowerShell 5.1 按 ANSI 读 UTF-8 文件会把中文读成乱码；核对中文特征串必须用 `[System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)`，不要用 `Select-String` 直接读 |
| 图标光栅化 | 本机**没有** `magick` / `inkscape` / `rsvg-convert`；有 Node/npx（全局已装 `playwright@1.62.1`）、Python 3.10 + PIL（无 `cairosvg`）。仓库内无 svgexport/sharp/resvg 依赖（Task 8 的主路径见该 Task） |
| 节点侧公开页模板 | 真实路径是 `web/templates/`（`web/web.go` 里 `//go:embed templates/*.html`），**不是** `internal/httpapi/web/templates/` |
| 移动端测试基座 | `core/fakes.ts` 的 `MemoryRepo` / `FakeHttp` / `fakeAdapters`；`FakeHttp.post` 每调必记 `posted`；`CommentOptions = { adapters, repo, nodeBaseUrl }` |
| 本地建表机制 | `core/repo.ts` 的 `SCHEMA_SQL` 由 `platform/index.ts` 的 `bootstrap()` 逐条 `db.execute`，靠 `CREATE TABLE IF NOT EXISTS` 幂等，**无版本号机制** → 新表只追加、不写迁移 |
| 单连接 | 节点 `store.go` 有 `SetMaxOpenConns(1)`：游标未关闭时嵌套查询会死锁（`ListProposalViews` 已按此写法） |
| `proposal` 创建响应 | `handleProposalPost` 返回 **201 Created**（不是 200），体含 `proposal_id`（十进制字符串）/ `action` / `item_id` / `vote_count` / `threshold` / `status` |
| 错误响应形状 | `writeAuthErr` → `{"error": "<英文文案>", "code": "<错误码>"}`；`writeError` → `{"error": "<文案>"}`（**无 `code`**）。故客户端只读 `code`（读 `error` 会拿到英文散文） |
| 图标挂载点 | `apps/mobile/src/pages.json` 的 `tabBar.list` 四项，`color "#888888"` / `selectedColor "#2b6cb0"`，当前四项**均无** `iconPath` / `selectedIconPath` |
| 页面传参约定 | 全仓页面读 `query.itemId`（camelCase）：`article.vue`（L59）、`quiz.vue`（L45）都是。册子 §2.2 写的 `item_id` 指同一语义，本计划统一用 `itemId` |
| 当前版本 | `apps/mobile/src/manifest.json` = `versionName "0.7.0"` / `versionCode "8"` → 本册发 **0.8.0 / 9** |
| 发布约定 | `-min-version-name` 取上一版（0.6.0 发布时填 0.5.0、0.7.0 时填 0.6.0）→ 0.8.0 填 `0.7.0`；`-notes` 必须是**不含空格的一个 token**；证书 SHA1 与 0.6.0/0.7.0 一致 = `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`（仍以 `keytool` 实测为准） |

## 对册子的三处补充与两处口径填空（已登记，实施时照此执行）

册子未列、但实施必需，均为**纯客户端加法**，不触碰任何线上契约：

1. **`LocalRepo` 多一个 `getSubmission(itemId)`**（册子 §4.2 只列了 `saveSubmission` / `listSubmissions` / `markSubmissionSent` / `markSubmissionFailed` / `removeSubmission`）。更新模式要按 `item_id` 读一行，用 `listSubmissions()` 过滤是绕路。
2. **新增 `core/errors.ts`**（册子 §4.2 的模块表没有它）。§9.2 的 26 条映射被 `submit.ts` / `govern.ts` / `contribution.ts` 三处共用，复制三份必然漂移。
3. **新增 `core/identity.ts` 的 `peekLocalIdentity(storage)`**。`comment.ts` 的 `localIdentity` 是私有的、且「缺身份就现建」；「我的贡献」与「提案列表」只需要**读**本机 id 做展示判定（§2.3），不该顺手生成身份。
4. **5xx 的归属口径**：册子 §9.3 只写了「`429` 与网络失败 → 保持 `pending`；其余 4xx → `failed`」，未说 5xx。本计划按既有 `comment_out` 队列的同一口径处理：**5xx 视为暂时失败，保持 `pending`**（节点 500 不是客户端能修的错，直接判死会逼用户删掉重投）。
5. **`identity_unregistered`（403）按 §9.3 字面归入 `failed`**，不为它开例外——册子 §9.2 的文案「请稍后重试」是提示语，不是状态机口径。

---

## 文件结构

| 路径 | 动作 | 职责 |
|---|---|---|
| `apps/mobile/src/core/types.ts` | 修改 | 加 `MySubmissionRow` |
| `apps/mobile/src/core/repo.ts` | 修改 | `SCHEMA_SQL` 追加表与索引；`LocalRepo` 加 6 个方法；`SqlRepo` 实现；`toMySubmissionRow` |
| `apps/mobile/src/core/fakes.ts` | 修改 | `MemoryRepo` 的内存实现 |
| `apps/mobile/src/core/errors.ts` | 新建 | §9.2 错误码 → 中文提示（三模块共用） |
| `apps/mobile/src/core/quizdoc.ts` | 新建 | 结构化题目草稿 ↔ `question_json`（键序固定）+ 本地校验 |
| `apps/mobile/src/core/quizdoc.test.ts` | 新建 | 往返一致 + 非法输入拦截 |
| `apps/mobile/src/core/submit.ts` | 新建 | 投稿编排：生成 id、载荷构造、算 hash、签名、直发 / 入队 / 补发 |
| `apps/mobile/src/core/submit.test.ts` | 新建 | 契约断言（键序、无 `author_id`、可验签）+ 台账状态机 + 补发编排 |
| `apps/mobile/src/core/identity.ts` | 修改 | 加 `peekLocalIdentity` |
| `apps/mobile/src/pages/submit/submit.vue` | 新建 | 投稿编辑器（新建 / 更新双模式） |
| `apps/mobile/src/pages/myitems/myitems.vue` | 新建 | 我的条目（待发 / 已提交 / 失败三段） |
| `apps/mobile/src/core/govern.ts` | 新建 | 提案列表 / 发起 / 投票（薄封装、无本地状态） |
| `apps/mobile/src/core/govern.test.ts` | 新建 | 契约断言（升序反转、201、已投票判定） |
| `apps/mobile/src/pages/governance/governance.vue` | 新建 | 提案与投票页 |
| `apps/mobile/src/pages/article/article.vue` | 修改 | 加「治理」按钮 |
| `apps/mobile/src/core/contribution.ts` | 新建 | `putName` / `roster` |
| `apps/mobile/src/core/contribution.test.ts` | 新建 | 契约断言 |
| `apps/mobile/src/pages/contribution/contribution.vue` | 新建 | 我的贡献页 |
| `apps/mobile/src/pages/mine/mine.vue` | 修改 | 两组共四行入口 |
| `apps/mobile/src/pages.json` | 修改 | 四条新路由 + tabBar 四项补图标 |
| `internal/httpapi/server.go` | 修改 | 注册 `GET /governance` |
| `internal/httpapi/web.go` | 修改 | `governanceTmpl`、`pageData` 追加字段、`handleGovernancePage` |
| `web/templates/base.html` | 修改 | 看板所需样式类 |
| `web/templates/governance.html` | 新建 | 看板 content 块 |
| `internal/httpapi/web_test.go` | 修改 | 看板渲染 + 两条可见性护栏 |
| `apps/mobile/src/static/tabbar/src/*.svg` | 新建（8 个） | 图标源文件（册子 §8.2 / §8.3） |
| `apps/mobile/src/static/tabbar/*.png` | 新建（8 个，二进制） | 81×81 透明 PNG |
| `apps/mobile/src/manifest.json` | 修改 | `0.8.0` / `9` |
| `docs/README.md` | 修改 | §3 登记计划、§4 依赖顺序、§5 当前阶段与下一步 |

---

### Task 1: 本地台账 `my_submissions`

**Files:**
- Modify: `apps/mobile/src/core/types.ts`
- Modify: `apps/mobile/src/core/repo.ts`
- Modify: `apps/mobile/src/core/fakes.ts`

- [ ] **Step 1: `types.ts` 追加行类型**

在 `apps/mobile/src/core/types.ts` 末尾（`CommentOutRow` 之后）追加：

```ts
/**
 * 我的投稿台账（本地 `my_submissions` 表，本册 §4.1）。
 * **一张表兼两职**：既是「我的条目」的列表本体，也是投稿的离线队列。
 */
export interface MySubmissionRow {
  /** `<type>/<slug>`，与节点侧同一 id */
  itemId: string;
  type: 'article' | 'quiz';
  title: string;
  /** 文章正文（quiz 行为空串） */
  bodyMd: string;
  /** 题库 JSON 字符串（article 行为空串） */
  questionJson: string;
  state: 'pending' | 'sent' | 'failed';
  /** `state='failed'` 时的用户可读原因（错误码映射后的中文）；可空 */
  reason: string | null;
  /** 服务端 `created` 回填：1 新建、0 更新 */
  created: number;
  /** 入队时刻 ISO8601（补发排序键） */
  queuedAt: string;
  /** 送达时刻 ISO8601；未送达为空串 */
  sentAt: string;
}
```

- [ ] **Step 2: `repo.ts` 追加建表语句与索引**

在 `apps/mobile/src/core/repo.ts` 的 `SCHEMA_SQL` 数组**末尾追加**两条（紧跟在既有 `idx_segments_item` 之后）。**只追加**：数组靠 `CREATE TABLE IF NOT EXISTS` 幂等执行，没有版本号机制，不需要迁移代码。

```ts
  `CREATE TABLE IF NOT EXISTS my_submissions(
     item_id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, body_md TEXT NOT NULL,
     question_json TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, created INTEGER NOT NULL,
     queued_at TEXT NOT NULL, sent_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_my_submissions_queued ON my_submissions(queued_at)`,
```

- [ ] **Step 3: `LocalRepo` 接口追加 6 个方法**

在 `apps/mobile/src/core/repo.ts` 的 `LocalRepo` 接口里，`removeCommentOut` 之后追加（注释一并照抄）：

```ts
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
```

同时把 `types.ts` 的导入改成：

```ts
import type { ArticleRow, CommentOutRow, FavoriteRow, ItemRow, LearningStats, MySubmissionRow, QuizRow, SegmentRow, TombstoneRow } from './types';
```

- [ ] **Step 4: `SqlRepo` 实现 6 个方法**

在 `SqlRepo` 的 `removeCommentOut` 之后追加：

```ts
  async saveSubmission(row: MySubmissionRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO my_submissions(item_id,type,title,body_md,question_json,state,reason,created,queued_at,sent_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(item_id) DO UPDATE SET type=excluded.type,title=excluded.title,body_md=excluded.body_md,
         question_json=excluded.question_json,state=excluded.state,reason=excluded.reason,
         created=excluded.created,queued_at=excluded.queued_at,sent_at=excluded.sent_at`,
      [row.itemId, row.type, row.title, row.bodyMd, row.questionJson, row.state, row.reason, row.created, row.queuedAt, row.sentAt],
    );
  }

  async listSubmissions(state?: 'pending' | 'sent' | 'failed'): Promise<MySubmissionRow[]> {
    const cols = `item_id,type,title,body_md,question_json,state,reason,created,queued_at,sent_at`;
    const rows = state
      ? await this.db.select(`SELECT ${cols} FROM my_submissions WHERE state=? ORDER BY queued_at ASC`, [state])
      : await this.db.select(`SELECT ${cols} FROM my_submissions ORDER BY queued_at ASC`);
    return rows.map(toMySubmissionRow);
  }

  async getSubmission(itemId: string): Promise<MySubmissionRow | null> {
    const rows = await this.db.select(
      `SELECT item_id,type,title,body_md,question_json,state,reason,created,queued_at,sent_at FROM my_submissions WHERE item_id=?`,
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
```

并在文件末尾的行映射 helper 区（`toCommentOutRow` 之后）追加：

```ts
function toMySubmissionRow(r: Record<string, unknown>): MySubmissionRow {
  const state = String(r.state);
  return {
    itemId: String(r.item_id),
    type: String(r.type) === 'quiz' ? 'quiz' : 'article',
    title: String(r.title ?? ''),
    bodyMd: String(r.body_md ?? ''),
    questionJson: String(r.question_json ?? ''),
    state: state === 'sent' ? 'sent' : state === 'failed' ? 'failed' : 'pending',
    reason: toNullableString(r.reason),
    created: Number(r.created ?? 0),
    queuedAt: String(r.queued_at ?? ''),
    sentAt: String(r.sent_at ?? ''),
  };
}
```

- [ ] **Step 5: `MemoryRepo` 内存实现**

`apps/mobile/src/core/fakes.ts`：把 `types` 导入改成含 `MySubmissionRow`：

```ts
import type { ArticleRow, CommentOutRow, FavoriteRow, ItemRow, LearningStats, MySubmissionRow, QuizRow, SegmentRow, TombstoneRow } from './types';
```

在 `MemoryRepo` 的 `removeCommentOut` 之后追加：

```ts
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
```

- [ ] **Step 6: 类型与回归自测**

Run（cwd `e:\code\base\apps\mobile`）: `npx tsc --noEmit`

Expected: 无输出（exit 0）。若报「`MemoryRepo` 缺少属性」即 Step 5 没补齐。

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run`

Expected: 12 文件 / 112 项全绿（本 Task 只加表与接口，不动既有逻辑）

- [ ] **Step 7: 提交**

```bash
git add apps/mobile/src/core/types.ts apps/mobile/src/core/repo.ts apps/mobile/src/core/fakes.ts
git commit -m "feat(mobile): 本地投稿台账 my_submissions（表、索引与 6 个读写方法）"
git push
```

---

### Task 2: `quizdoc.ts`（结构化题目 ↔ `question_json`）

**Files:**
- Create: `apps/mobile/src/core/quizdoc.ts`
- Create: `apps/mobile/src/core/quizdoc.test.ts`

- [ ] **Step 1: 写 `quizdoc.ts`**

```ts
/**
 * 题库编辑器与 `question_json` 之间的转换（本册 §5.2）。
 *
 * 结构化表单是**唯一出口**，不提供 JSON 手写框。只依赖 `core/types` 与 `core/quiz`，不 import 'uni'。
 *
 * 键序固定**不是契约约束**——节点把整串原样存库、从不重新序列化，字节序由客户端自定。
 * 固定键序只为让「重投同一份内容」不产生无意义的字节抖动（否则每次重开编辑器都会得到不同的
 * `content_hash`）。故测试只验自家 build → parse 往返，不写「与 Go 输出逐字节一致」的断言。
 */
import { parseQuestionDoc } from './quiz';
import type { Question, QuestionDoc } from './types';

/** 编辑器里的一道题（草稿态）：`answer` 为正确项下标，`-1` 表示未选。 */
export interface QuestionDraft {
  q: string;
  options: string[];
  answer: number;
  explain: string;
}

/** 新建题目的默认草稿：2 个空选项、未选答案（服务端要求 `options ≥ 2`）。 */
export function emptyDraft(): QuestionDraft {
  return { q: '', options: ['', ''], answer: -1, explain: '' };
}

/**
 * 生成 `question_json`。任一题不合法即返回 null（页面据此禁用提交）。
 *
 * 生成前的本地约束（比解析器严，因为编辑器不该产出解析器勉强容忍的东西）：
 * 题干去空白后非空、选项去空白后全部非空且 ≥ 2 个、`answer` 为合法下标。
 */
export function buildQuestionJSON(drafts: QuestionDraft[]): string | null {
  if (drafts.length === 0) return null;
  const questions: Question[] = [];
  for (const d of drafts) {
    const q = d.q.trim();
    const options = d.options.map((o) => o.trim());
    if (q === '') return null;
    if (options.length < 2) return null;
    if (options.some((o) => o === '')) return null;
    if (!Number.isInteger(d.answer) || d.answer < 0 || d.answer >= options.length) return null;
    questions.push({ q, options, answer: d.answer, explain: d.explain.trim() });
  }
  // 键序由对象字面量的书写顺序决定（JS 保证字符串键的插入序）：
  // 顶层 schema_version → questions；每题 q → options → answer → explain（explain 必出，空串也输出）。
  const doc: QuestionDoc = { schema_version: 1, questions };
  const raw = JSON.stringify(doc as unknown as Record<string, unknown>);
  // 往返自检：直接复用 core/quiz.ts 的解析口径，不另写一套规则（本册 §5.2）
  return parseQuestionDoc(raw) === null ? null : raw;
}

/** 台账里存的 `question_json` → 编辑器草稿（更新模式回填）。解析失败返回空数组。 */
export function draftsFromQuestionJSON(raw: string): QuestionDraft[] {
  const qs = parseQuestionDoc(raw);
  if (qs === null) return [];
  return qs.map((q) => ({ q: q.q, options: [...q.options], answer: q.answer, explain: q.explain }));
}
```

- [ ] **Step 2: 写 `quizdoc.test.ts`**

```ts
import { describe, expect, it } from 'vitest';

import { buildQuestionJSON, draftsFromQuestionJSON, emptyDraft, type QuestionDraft } from './quizdoc';
import { parseQuestionDoc } from './quiz';

function draft(over: Partial<QuestionDraft> = {}): QuestionDraft {
  return { q: '甲题', options: ['A', 'B'], answer: 1, explain: '因为 B', ...over };
}

describe('quizdoc', () => {
  it('键序固定：顶层 schema_version→questions，每题 q→options→answer→explain', () => {
    const raw = buildQuestionJSON([draft()]);
    expect(raw).toBe('{"schema_version":1,"questions":[{"q":"甲题","options":["A","B"],"answer":1,"explain":"因为 B"}]}');
  });

  it('explain 缺省也照样输出空串；无解析不影响解析回来', () => {
    const raw = buildQuestionJSON([draft({ explain: '' })])!;
    expect(raw).toContain('"explain":""');
    expect(parseQuestionDoc(raw)).toEqual([{ q: '甲题', options: ['A', 'B'], answer: 1, explain: '' }]);
  });

  it('往返一致：build → parse 得到与草稿同构的题组（含中文与多题）', () => {
    const drafts: QuestionDraft[] = [
      draft({ q: '甲', options: ['甲一', '甲二', '甲三'], answer: 2, explain: '' }),
      draft({ q: '乙', options: ['乙一', '乙二'], answer: 0, explain: '乙的解析' }),
    ];
    expect(parseQuestionDoc(buildQuestionJSON(drafts)!)).toEqual([
      { q: '甲', options: ['甲一', '甲二', '甲三'], answer: 2, explain: '' },
      { q: '乙', options: ['乙一', '乙二'], answer: 0, explain: '乙的解析' },
    ]);
  });

  it('本地拦下非法输入：题数 0 / 题干空 / 选项 < 2 / 选项空串 / answer 越界或未选', () => {
    expect(buildQuestionJSON([])).toBeNull();
    expect(buildQuestionJSON([draft({ q: '   ' })])).toBeNull();
    expect(buildQuestionJSON([draft({ options: ['A'] })])).toBeNull();
    expect(buildQuestionJSON([draft({ options: ['A', '  '] })])).toBeNull();
    expect(buildQuestionJSON([draft({ options: ['A', 'B'], answer: -1 })])).toBeNull();
    expect(buildQuestionJSON([draft({ options: ['A', 'B'], answer: 2 })])).toBeNull();
    // 多题里只要有一题不合法，整组不产出
    expect(buildQuestionJSON([draft(), draft({ q: '' })])).toBeNull();
  });

  it('去首尾空白：题干与选项入库即 trim 后形态', () => {
    const raw = buildQuestionJSON([draft({ q: ' 甲题 ', options: [' A ', ' B '] })])!;
    expect(parseQuestionDoc(raw)![0]).toEqual({ q: '甲题', options: ['A', 'B'], answer: 1, explain: '因为 B' });
  });

  it('回填：draftsFromQuestionJSON 是 build 的逆；坏串返回空数组', () => {
    const drafts = [draft({ explain: '' })];
    expect(draftsFromQuestionJSON(buildQuestionJSON(drafts)!)).toEqual(drafts);
    expect(draftsFromQuestionJSON('不是 JSON')).toEqual([]);
    expect(draftsFromQuestionJSON('{"schema_version":2,"questions":[]}')).toEqual([]);
  });

  it('emptyDraft 满足编辑器初始态：2 个空选项、未选答案', () => {
    expect(emptyDraft()).toEqual({ q: '', options: ['', ''], answer: -1, explain: '' });
  });
});
```

- [ ] **Step 3: 自测**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run src/core/quizdoc.test.ts`

Expected: 7 项全绿

Run: `npx tsc --noEmit`

Expected: 无输出

- [ ] **Step 4: 提交**

```bash
git add apps/mobile/src/core/quizdoc.ts apps/mobile/src/core/quizdoc.test.ts
git commit -m "feat(mobile): question_json 生成口径与本地校验（quizdoc）"
git push
```

---

### Task 3: `errors.ts` + `submit.ts`（投稿编排）

**Files:**
- Create: `apps/mobile/src/core/errors.ts`
- Modify: `apps/mobile/src/core/identity.ts`
- Create: `apps/mobile/src/core/submit.ts`
- Create: `apps/mobile/src/core/submit.test.ts`

- [ ] **Step 1: `identity.ts` 追加 `peekLocalIdentity`**

在 `apps/mobile/src/core/identity.ts` 的 `loadLocalIdentity` 之后追加：

```ts
/**
 * 只读本机身份：不存在返回 null，**不生成**。
 * 展示判定专用（「这条提案我投过没有」「我是否在名册内」），不用于任何写路径。
 * 与 `core/comment.ts` 的私有 `localIdentity` 的区别：那个缺身份就现建（写路径需要）。
 */
export async function peekLocalIdentity(storage: StorageAdapter): Promise<Identity | null> {
  const kek = await deviceKek(storage);
  return loadLocalIdentity(storage, kek);
}
```

- [ ] **Step 2: 写 `errors.ts`**

**只读 `code`，不读 `error`**：本节点 `writeAuthErr` 把 `error` 写成英文散文（`authErrText[code]`），当成码用只会命中兜底分支。

```ts
/**
 * 服务端错误码 → 中文提示（本册 §9.2）。界面不直接显示英文码。
 *
 * 只读响应体的 `code`：本节点的 `writeAuthErr` 把 `error` 写成英文文案（不是码），
 * `writeError` 则只有 `error` 没有 `code`——两者都留给调用方的兜底文案处理。
 */

/** 逐条对齐册子 §9.2 的映射表。 */
const SERVER_ERROR_TEXT: Record<string, string> = {
  item_title_invalid: '标题需 1–200 字且不含控制字符',
  item_body_too_large: '正文超过 32KB',
  item_question_invalid: '题组内容不合法（需合法 JSON、schema_version 为 1、questions 非空）',
  item_id_invalid: '条目 id 不合法',
  item_type_unsupported: '载体只能是文章或题库',
  item_type_mismatch: '载体与 id 前缀不一致',
  item_id_taken: '该条目已被他人创建',
  author_id_forbidden: '请求体不得携带身份字段',
  author_sig_invalid: '作者归属签名验证失败',
  identity_unregistered: '身份未在本节点登记，请稍后重试',
  item_rate_limited: '操作过于频繁，请稍后再试',
  event_rate_limited: '操作过于频繁，请稍后再试',
  govern_rate_limited: '操作过于频繁，请稍后再试',
  profile_name_invalid: '昵称需 1–32 字且不含控制字符',
  profile_id_forbidden: '请求体不得携带身份字段',
  proposal_action_unsupported: '只能选择下架 / 改写 / 复活三个动作',
  proposal_reason_invalid: '理由需 1–200 字且不含控制字符',
  proposal_edit_invalid: '改写提案需填标题与正文，且只支持文章',
  proposal_too_large: '标题与正文合计超过 32KB',
  item_not_found: '目标条目不存在',
  item_self_owned: '这是你自己的条目，请直接改用投稿',
  item_state_mismatch: '条目的当前状态不支持该动作',
  proposer_not_governor: '不在本节点治理者名册内',
  voter_not_governor: '不在本节点治理者名册内',
  proposal_not_found: '提案不存在',
  already_voted: '你已投过票',
};

/** 从响应体里取错误码；取不到返回空串。 */
export function errorCodeOf(raw: string): string {
  try {
    const body = JSON.parse(raw) as { code?: string };
    return body.code ?? '';
  } catch {
    return '';
  }
}

/**
 * 码 → 中文提示。`auth_*` / `identity_*`（除已单列的 `identity_unregistered`）属
 * 客户端实现异常，统一一条提示（册子 §9.2 末行）；其余未知码用调用方给的兜底文案。
 */
export function errorText(code: string, fallback: string): string {
  const hit = SERVER_ERROR_TEXT[code];
  if (hit) return hit;
  if (code.startsWith('auth_') || code.startsWith('identity_')) return '签名校验失败，请重试';
  return fallback;
}
```

- [ ] **Step 3: 写 `submit.ts`**

```ts
/**
 * 投稿编排（本册 §5）：本地校验 → 身份登记 → 客户端算 content_hash → 作者签名 → POST /v1/submit。
 *
 * 有网即直发；**只有网络不可达**才留在台账 `pending` 等补发；其余失败按 §9.3 转 `failed`。
 * 只依赖注入的 `Adapters` / `LocalRepo`，不 import 'uni'，因此可在 Node 下用 `core/fakes.ts` 完整测试。
 */
import { authorSignBytes, bytesToHex, randomBytes, sha256Hex, sign, utf8 } from '@base/protocol-ts';

import type { Adapters } from '../platform/adapter';
import { CommentError, ensureRegistered, type CommentErrorCode, type CommentOptions } from './comment';
import { errorCodeOf, errorText } from './errors';
import { signRequestHeaders, type Identity } from './identity';
import { parseQuestionDoc } from './quiz';
import type { LocalRepo } from './repo';
import { decodeUtf8 } from './sync';
import type { MySubmissionRow } from './types';

/** 与 `core/comment.ts` 同一组依赖（同一套 `ensureRegistered`，本册不另立会话模块）。 */
export type SubmitOptions = CommentOptions;

/** 一条待投内容：与台账行的可编辑字段一一对应。 */
export interface SubmitDraft {
  itemId: string;
  type: 'article' | 'quiz';
  title: string;
  bodyMd: string;
  /** quiz 专有；article 恒为空串 */
  questionJson: string;
}

/** 发表失败的用户可读错误。码沿用评论队列的词汇，避免两套同义词。 */
export class SubmitError extends Error {
  constructor(
    readonly code: CommentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SubmitError';
  }
}

/** 生成一个新条目的 id：`<type>/<16 位 hex>`（恒满足 `[a-z0-9][a-z0-9-]{0,63}`，本册 §3）。 */
export function newItemID(type: 'article' | 'quiz'): string {
  return `${type}/${bytesToHex(randomBytes(8))}`;
}

/** `content_hash` 与 #25 §2.2 同一口径：article 取 `body_md`、quiz 取 `question_json` 的 UTF-8 字节 sha256。 */
export function contentHashOf(draft: SubmitDraft): string {
  return sha256Hex(utf8(draft.type === 'quiz' ? draft.questionJson : draft.bodyMd));
}

/** `article` 请求体字节。键序固定：type → item_id → title → body_md → question_json → author_sig。 */
export function buildArticlePayload(itemId: string, title: string, bodyMd: string, authorSig: string): Uint8Array {
  return utf8(
    JSON.stringify({
      type: 'article',
      item_id: itemId,
      title,
      body_md: bodyMd,
      question_json: '',
      author_sig: authorSig,
    }),
  );
}

/** `quiz` 请求体字节。键序同上。 */
export function buildQuizPayload(itemId: string, title: string, questionJson: string, authorSig: string): Uint8Array {
  return utf8(
    JSON.stringify({
      type: 'quiz',
      item_id: itemId,
      title,
      body_md: '',
      question_json: questionJson,
      author_sig: authorSig,
    }),
  );
}

/** 本地校验；`ok=false` 时 `message` 即可直接展示的提示。 */
export interface DraftValidation {
  ok: boolean;
  message: string;
}

/**
 * 本地校验（本册 §5.2 要求题组必须先过本地校验，才序列化为字符串随请求发送）。
 * **只拦「客户端一定能判断」的东西**：标题非空、正文非空、题组能过 `parseQuestionDoc`。
 * 长度上限与控制字符一律交服务端裁决（本册 §2.3 的同一口径）。
 */
export function validateDraft(draft: SubmitDraft): DraftValidation {
  if (draft.title.trim() === '') return { ok: false, message: '请填写标题' };
  if (draft.type === 'quiz') {
    if (parseQuestionDoc(draft.questionJson) === null) return { ok: false, message: '题组内容不合法：每题需题干、至少 2 个选项并选定正确项' };
    return { ok: true, message: '' };
  }
  if (draft.bodyMd.trim() === '') return { ok: false, message: '请填写正文' };
  return { ok: true, message: '' };
}

/** 把本地步骤（随机数 / 签名 / 编码）的裸错误包成可读错误。 */
function localStep<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new SubmitError('client', `${what}失败：${(e as Error).message ?? String(e)}`);
  }
}

/** 身份准备：投稿走 `requireAuth`，未登记身份会被节点回 `403 identity_unregistered`（本册 §3）。 */
async function ensureIdentity(o: SubmitOptions): Promise<Identity> {
  try {
    return await ensureRegistered(o);
  } catch (e) {
    if (e instanceof CommentError) throw new SubmitError(e.code, e.message);
    throw new SubmitError('client', `身份准备失败：${(e as Error).message ?? String(e)}`);
  }
}

/** 按载体构造请求体（签名在内部现算，不落盘——本册 §4.1 取舍 1）。 */
export function buildSubmitBody(draft: SubmitDraft, ident: Identity): Uint8Array {
  const title = draft.title.trim();
  const contentHash = contentHashOf(draft);
  const sig = localStep('签名', () => sign(ident.seedHex, utf8(authorSignBytes(draft.itemId, contentHash, ident.id))));
  return draft.type === 'quiz'
    ? buildQuizPayload(draft.itemId, title, draft.questionJson, sig)
    : buildArticlePayload(draft.itemId, title, draft.bodyMd, sig);
}

/** 节点错误码 → 用户可读错误；`code` 决定它是「暂时」还是「永久」（本册 §9.3）。 */
function mapSubmitFailure(status: number, raw: string, itemId: string): SubmitError {
  const code = errorCodeOf(raw);
  if (status === 429 || code === 'item_rate_limited') {
    return new SubmitError('rate_limited', errorText(code, '提交过于频繁，请稍后再试'));
  }
  let message = errorText(code, `提交失败（HTTP ${status}）`);
  // `course/` 前缀单独补一句（本册 §6.2）
  if (code === 'item_id_invalid' && itemId.startsWith('course/')) {
    message = `${message}；投稿不能指定课程，请改用运营导入`;
  }
  // 4xx（除 429）= 永久失败；5xx = 节点侧问题，视为暂时（本计划口径填空 4）
  return new SubmitError(status >= 400 && status < 500 ? 'rejected' : 'server', message);
}

/** 永久失败：节点明确拒绝，重发无意义。`rejected` 即 4xx（除 429）。 */
export function isPermanentSubmitFailure(e: unknown): boolean {
  return e instanceof SubmitError && e.code === 'rejected';
}

export interface SubmitResult {
  itemId: string;
  created: boolean;
  contentHash: string;
}

/**
 * 直接发送一条投稿：登记 → 算 hash → 签名 → POST。失败抛 `SubmitError`，**不落台账**。
 * 本函数是补发与直发共用的唯一发送入口。
 */
export async function submitItem(o: SubmitOptions, draft: SubmitDraft): Promise<SubmitResult> {
  const v = validateDraft(draft);
  if (!v.ok) throw new SubmitError('client', v.message);
  const ident = await ensureIdentity(o);
  const bytes = buildSubmitBody(draft, ident);
  const headers = localStep('签名请求', () =>
    signRequestHeaders(ident, { method: 'POST', path: '/v1/submit', body: bytes }),
  );

  let res;
  try {
    res = await o.adapters.http.post(`${o.nodeBaseUrl}/v1/submit`, bytes, {
      'Content-Type': 'application/json',
      ...headers,
    });
  } catch {
    throw new SubmitError('network', '无法连接节点，已保存，联网后自动发送');
  }
  if (res.status !== 200) throw mapSubmitFailure(res.status, decodeUtf8(res.body), draft.itemId);

  const out = localStep('解析响应', () => JSON.parse(decodeUtf8(res.body)) as { item_id?: string; content_hash?: string; created?: boolean });
  return {
    itemId: String(out.item_id ?? draft.itemId),
    created: out.created === true,
    contentHash: String(out.content_hash ?? contentHashOf(draft)),
  };
}

/**
 * 写台账（`item_id` 为键的 upsert）。**保留已有的 `created` 回填值**：
 * 一次重投失败不该把「这是我新建的条目」这个事实擦掉。
 */
async function writeLedger(o: SubmitOptions, draft: SubmitDraft, patch: Partial<MySubmissionRow>): Promise<void> {
  const prev = await o.repo.getSubmission(draft.itemId);
  await o.repo.saveSubmission({
    itemId: draft.itemId,
    type: draft.type,
    title: draft.title.trim(),
    bodyMd: draft.type === 'article' ? draft.bodyMd : '',
    questionJson: draft.type === 'quiz' ? draft.questionJson : '',
    state: 'pending',
    reason: null,
    created: prev?.created ?? 0,
    queuedAt: new Date().toISOString(),
    sentAt: '',
    ...patch,
  });
}

export interface SubmitOutcome {
  itemId: string;
  /** 服务端 `created` 回填；未送达恒为 false */
  created: boolean;
  /** 台账最终状态：`sent` 已送达 / `pending` 待发 / `failed` 永久失败 */
  ledgerState: 'sent' | 'pending' | 'failed';
  /** 未送达时可展示的提示文案 */
  message: string;
}

/**
 * 投一条：成功 → 台账 `sent`；网络失败 / 429 / 5xx → 台账 `pending`（联网后自动补发）；
 * 其余 4xx → 台账 `failed`（只可删，不自动重试）。三种结果都**会**留下台账行——
 * 「我的条目」的列表本体就是它（本册 §4.1）。
 */
export async function enqueueOrSend(o: SubmitOptions, draft: SubmitDraft): Promise<SubmitOutcome> {
  if (o.nodeBaseUrl === '') throw new SubmitError('client', '未配置节点地址，无法投稿');
  const v = validateDraft(draft);
  if (!v.ok) throw new SubmitError('client', v.message);

  try {
    const r = await submitItem(o, draft);
    await writeLedger(o, draft, {
      state: 'sent',
      reason: null,
      created: r.created ? 1 : 0,
      sentAt: new Date().toISOString(),
    });
    return { itemId: r.itemId, created: r.created, ledgerState: 'sent', message: '' };
  } catch (e) {
    if (!(e instanceof SubmitError)) throw e;
    const permanent = isPermanentSubmitFailure(e);
    await writeLedger(o, draft, permanent ? { state: 'failed', reason: e.message } : { state: 'pending', reason: e.message });
    return { itemId: draft.itemId, created: false, ledgerState: permanent ? 'failed' : 'pending', message: e.message };
  }
}

/** `flushSubmissions` 的结果。**只经返回值体现，绝不抛错**。 */
export interface FlushSubmissionsResult {
  sent: number;
  failed: number;
  remaining: number;
  error: string;
}

/** 进行中的补发：并发调用复用同一轮（进页面与「重试」可能撞在一起）。 */
let inflightFlush: Promise<FlushSubmissionsResult> | null = null;

/**
 * 补发台账里全部 `pending`：逐条串行、按 `queued_at ASC`（先入队先补发）。
 * **暂时失败即中止本轮**——网络刚断或已被限速时后续条目必然同错；已 `failed` 的行永不自动重试。
 */
export function flushSubmissions(o: SubmitOptions): Promise<FlushSubmissionsResult> {
  if (o.nodeBaseUrl === '') return Promise.resolve({ sent: 0, failed: 0, remaining: 0, error: '' });
  if (!inflightFlush) {
    inflightFlush = (async () => {
      try {
        return await runFlushSubmissions(o);
      } finally {
        inflightFlush = null;
      }
    })();
  }
  return inflightFlush;
}

async function runFlushSubmissions(o: SubmitOptions): Promise<FlushSubmissionsResult> {
  const rows = await o.repo.listSubmissions('pending');
  let sent = 0;
  let failed = 0;
  let remaining = 0;
  let error = '';
  for (const row of rows) {
    const draft: SubmitDraft = {
      itemId: row.itemId,
      type: row.type,
      title: row.title,
      bodyMd: row.bodyMd,
      questionJson: row.questionJson,
    };
    try {
      const r = await submitItem(o, draft);
      await o.repo.markSubmissionSent(row.itemId, r.created ? 1 : 0, new Date().toISOString());
      sent += 1;
    } catch (e) {
      const msg = e instanceof SubmitError ? e.message : `补发失败：${(e as Error).message ?? String(e)}`;
      if (isPermanentSubmitFailure(e)) {
        await o.repo.markSubmissionFailed(row.itemId, msg);
        failed += 1;
      } else {
        remaining += 1;
        error = msg;
        break;
      }
    }
  }
  return { sent, failed, remaining, error };
}
```

- [ ] **Step 4: 写 `submit.test.ts`**

测试基座照抄 `core/comment.test.ts` 的 `fixture()` / `json()` / `gatePost()` / `registeredPub()`（**同一套 helper，本 Task 首次定义在 `submit.test.ts` 内**）。

```ts
import { describe, expect, it } from 'vitest';

import { deriveIdentityId, sha256Hex, utf8, verify, verifyAuthorSig, type Json } from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { IDENTITY_REGISTERED_KEY } from './comment';
import { buildArticlePayload, buildQuizPayload, contentHashOf, enqueueOrSend, flushSubmissions, newItemID, submitItem, type SubmitDraft, type SubmitOptions } from './submit';
import { buildQuestionJSON } from './quizdoc';
import { decodeUtf8 } from './sync';

const BASE = 'https://node.test';
const ID = 'a'.repeat(64);

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function fixture() {
  const http = new FakeHttp();
  const repo = new MemoryRepo();
  const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
  const o: SubmitOptions = { adapters, repo, nodeBaseUrl: BASE };
  return { http, repo, o };
}

/** 可开关的「网络不可达」：只让 `POST /v1/submit` 抛错，其余照常走路由。 */
function gateSubmit(http: FakeHttp): { offline: boolean } {
  const real = http.post.bind(http);
  const state = { offline: true };
  http.post = async (url, body, headers) => {
    if (state.offline && url.endsWith('/v1/submit')) {
      http.posted.push({ url, body, headers: headers ?? {} });
      throw new Error('断网');
    }
    return real(url, body, headers);
  };
  return state;
}

function registeredPub(http: FakeHttp): string {
  const reg = http.posted.find((p) => p.url.endsWith('/v1/identity/register'));
  if (!reg) throw new Error('未发出登记请求');
  return (JSON.parse(decodeUtf8(reg.body)) as { pubkey: string }).pubkey;
}

function articleDraft(over: Partial<SubmitDraft> = {}): SubmitDraft {
  return { itemId: 'article/abc123', type: 'article', title: '甲', bodyMd: '甲正文', questionJson: '', ...over };
}

describe('投稿载荷', () => {
  it('newItemID：<type>/<16 位 hex>，恒满足 [a-z0-9][a-z0-9-]{0,63}', () => {
    for (const type of ['article', 'quiz'] as const) {
      for (let i = 0; i < 20; i++) {
        const id = newItemID(type);
        expect(id.startsWith(`${type}/`)).toBe(true);
        expect(/^[a-z0-9][a-z0-9-]{0,63}$/.test(id.slice(type.length + 1))).toBe(true);
      }
    }
  });

  it('载荷字段正确、键序固定、且不含 author_id（携带即 author_id_forbidden）', () => {
    const article = decodeUtf8(buildArticlePayload('article/a1', '甲', '正文', 'ff'.repeat(64)));
    expect(article).toBe(
      '{"type":"article","item_id":"article/a1","title":"甲","body_md":"正文","question_json":"","author_sig":"' + 'ff'.repeat(64) + '"}',
    );
    const quiz = decodeUtf8(buildQuizPayload('quiz/q1', '乙', '{"schema_version":1,"questions":[]}', 'ee'.repeat(64)));
    expect(quiz).toBe(
      '{"type":"quiz","item_id":"quiz/q1","title":"乙","body_md":"","question_json":"{\\"schema_version\\":1,\\"questions\\":[]}","author_sig":"' + 'ee'.repeat(64) + '"}',
    );
    expect(article.includes('author_id')).toBe(false);
    expect(quiz.includes('author_id')).toBe(false);
  });

  it('content_hash 口径：article 取 body_md、quiz 取 question_json 的 UTF-8 字节 sha256', () => {
    expect(contentHashOf(articleDraft({ bodyMd: '甲正文' }))).toBe(sha256Hex(utf8('甲正文')));
    const qj = buildQuestionJSON([{ q: '题', options: ['A', 'B'], answer: 1, explain: '' }])!;
    expect(contentHashOf({ itemId: 'quiz/q1', type: 'quiz', title: '乙', bodyMd: '', questionJson: qj })).toBe(
      sha256Hex(utf8(qj)),
    );
  });

  it('首投：先补登记，再带 5 个签名头 POST；作者签名可被节点按同一字节重建验证', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({ id: 'ignored', alg: 'ed25519', registered: true }));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'article/abc123', type: 'article', content_hash: 'x', created: true }));

    const res = await submitItem(o, articleDraft());
    expect(res.created).toBe(true);
    expect(http.posted.map((p) => p.url)).toEqual([`${BASE}/v1/identity/register`, `${BASE}/v1/submit`]);

    const wire = http.posted[1]!;
    const pub = registeredPub(http);
    const sent = JSON.parse(decodeUtf8(wire.body)) as Record<string, Json>;
    expect(wire.headers['X-Base-Alg']).toBe('ed25519');
    expect(wire.headers['X-Base-Method']).toBeUndefined();

    // 归属签名覆盖 canonical({alg,domain,item_id,content_hash,author_id})，与请求头无关（#23 §2.1）
    const hash = sha256Hex(utf8('甲正文'));
    const authorId = (JSON.parse(decodeUtf8(http.posted[0]!.body)) as { id: string }).id;
    expect(deriveIdentityId(pub)).toBe(authorId);
    expect(verifyAuthorSig(pub, 'article/abc123', hash, authorId, sent.author_sig as string)).toBe(true);
    // 请求体里的 content_hash 由客户端算，服务端会自己再算一遍（#25 §2.2）
    expect(sent.author_id).toBeUndefined();
    expect(await repo.getConfig(IDENTITY_REGISTERED_KEY)).toBe('1');
  });

  it('本地校验不过：不发任何请求', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const err = await enqueueOrSend(o, articleDraft({ title: '   ' })).catch((e: unknown) => e);
    expect((err as Error).message).toBe('请填写标题');
    expect(http.posted).toHaveLength(0);
  });
});

describe('台账状态机与补发', () => {
  it('200 → sent（created 回填）；429 → 保持 pending；4xx → failed 并记原因', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'article/abc123', created: false }));

    const ok = await enqueueOrSend(o, articleDraft());
    expect(ok.ledgerState).toBe('sent');
    expect((await repo.getSubmission('article/abc123'))!.state).toBe('sent');
    expect((await repo.getSubmission('article/abc123'))!.created).toBe(0);
    expect((await repo.getSubmission('article/abc123'))!.sentAt).not.toBe('');

    http.postRoutes.set(`${BASE}/v1/submit`, { status: 429, body: utf8(JSON.stringify({ code: 'item_rate_limited' })) });
    const limited = await enqueueOrSend(o, articleDraft({ itemId: 'article/rate1' }));
    expect(limited.ledgerState).toBe('pending');
    expect(limited.message).toBe('操作过于频繁，请稍后再试');

    http.postRoutes.set(`${BASE}/v1/submit`, { status: 403, body: utf8(JSON.stringify({ code: 'item_id_taken' })) });
    const taken = await enqueueOrSend(o, articleDraft({ itemId: 'article/taken1' }));
    expect(taken.ledgerState).toBe('failed');
    expect((await repo.getSubmission('article/taken1'))!.reason).toBe('该条目已被他人创建');

    // 5xx 视为暂时（口径填空 4）
    http.postRoutes.set(`${BASE}/v1/submit`, { status: 500, body: utf8('boom') });
    const srv = await enqueueOrSend(o, articleDraft({ itemId: 'article/srv1' }));
    expect(srv.ledgerState).toBe('pending');
    expect(srv.message).toBe('提交失败（HTTP 500）');
  });

  it('course/ 前缀：错误码提示后另加一句「不能指定课程」', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, { status: 400, body: utf8(JSON.stringify({ code: 'item_id_invalid' })) });
    const r = await enqueueOrSend(o, articleDraft({ itemId: 'course/c1' }));
    expect(r.ledgerState).toBe('failed');
    expect((await repo.getSubmission('course/c1'))!.reason).toBe('条目 id 不合法；投稿不能指定课程，请改用运营导入');
  });

  it('断网 → 入队 pending；补发成功转 sent（单向，不留 pending）', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const gate = gateSubmit(http);
    const offline = await enqueueOrSend(o, articleDraft());
    expect(offline.ledgerState).toBe('pending');
    expect(await repo.listSubmissions('pending')).toHaveLength(1);

    gate.offline = false;
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'article/abc123', created: true }));
    const res = await flushSubmissions(o);
    expect(res).toEqual({ sent: 1, failed: 0, remaining: 0, error: '' });
    expect((await repo.getSubmission('article/abc123'))!.state).toBe('sent');
    expect((await repo.getSubmission('article/abc123'))!.created).toBe(1);
  });

  it('补发：按 queued_at ASC 串行；暂时失败即中止本轮，不阻塞也不越过后续', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    for (const id of ['article/one', 'article/two', 'article/three']) {
      await repo.saveSubmission({
        itemId: id, type: 'article', title: id, bodyMd: '正文', questionJson: '',
        state: 'pending', reason: null, created: 0, queuedAt: `2026-09-28T00:00:0${id.slice(-1) === 'e' ? 1 : id.slice(-1) === 'o' ? 2 : 3}Z`, sentAt: '',
      });
    }
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, { status: 500, body: utf8('boom') });

    const res = await flushSubmissions(o);
    expect(res).toEqual({ sent: 0, failed: 0, remaining: 3, error: '提交失败（HTTP 500）' });
    // 只试了第一条（串行 + 暂时失败即中止）
    expect(http.posted.filter((p) => p.url.endsWith('/v1/submit'))).toHaveLength(1);
    expect(await repo.listSubmissions('pending')).toHaveLength(3);
  });

  it('补发：单飞——并发调用复用同一轮', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ created: true }));
    await repo.saveSubmission({
      itemId: 'article/one', type: 'article', title: '甲', bodyMd: '正文', questionJson: '',
      state: 'pending', reason: null, created: 0, queuedAt: '2026-09-28T00:00:01Z', sentAt: '',
    });
    const [a, b] = await Promise.all([flushSubmissions(o), flushSubmissions(o)]);
    expect(a).toEqual(b);
    expect(http.posted.filter((p) => p.url.endsWith('/v1/submit'))).toHaveLength(1);
  });

  it('未配置节点：投稿报错、补发直接返回空结果（不把队列变成发不出去的垃圾桶）', async () => {
    const { repo, o } = fixture();
    o.nodeBaseUrl = '';
    const err = await enqueueOrSend(o, articleDraft()).catch((e: unknown) => e);
    expect((err as Error).message).toBe('未配置节点地址，无法投稿');
    expect(await flushSubmissions(o)).toEqual({ sent: 0, failed: 0, remaining: 0, error: '' });
    expect(await repo.listSubmissions()).toHaveLength(0);
  });
});
```

> 注：`verify` 若未被用到就从导入里删掉（`tsc` 会报未使用）。

- [ ] **Step 5: 自测**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run src/core/submit.test.ts`

Expected: 全绿。若 `verifyAuthorSig` 报不存在 → 检查 `packages/protocol-ts/src/index.ts` 是否已导出 `./author`（`apps/mobile/src/core/*.ts` 一律从 `@base/protocol-ts` 顶层导入）。

Run: `npx tsc --noEmit`

Expected: 无输出

- [ ] **Step 6: 提交**

```bash
git add apps/mobile/src/core/errors.ts apps/mobile/src/core/identity.ts apps/mobile/src/core/submit.ts apps/mobile/src/core/submit.test.ts
git commit -m "feat(mobile): 投稿编排（载荷构造、作者签名、台账直发/入队/补发）与错误码中文映射"
git push
```

---

### Task 4: 投稿编辑器与「我的条目」

**Files:**
- Create: `apps/mobile/src/pages/submit/submit.vue`
- Create: `apps/mobile/src/pages/myitems/myitems.vue`
- Modify: `apps/mobile/src/pages.json`

- [ ] **Step 1: `pages.json` 加两条路由**

在 `pages` 数组末尾（`pages/quiz/quiz` 之后）追加：

```json
    {
      "path": "pages/submit/submit",
      "style": { "navigationBarTitleText": "投稿" }
    },
    {
      "path": "pages/myitems/myitems",
      "style": { "navigationBarTitleText": "我的条目" }
    }
```

- [ ] **Step 2: 写 `pages/submit/submit.vue`**

同一页承担新建与更新两种模式（带 `itemId` 进入即更新模式）。

```vue
<template>
  <view class="wrap">
    <text class="title">{{ isUpdate ? '重投更新' : '新建投稿' }}</text>

    <view class="tabs">
      <text class="tab" :class="type === 'article' ? 'tab-on' : ''" @click="switchType('article')">文章</text>
      <text class="tab" :class="type === 'quiz' ? 'tab-on' : ''" @click="switchType('quiz')">题库</text>
    </view>
    <text v-if="isUpdate" class="hint">载体与条目 id 在更新模式下不可改（id 就是身份）</text>

    <view class="field">
      <text class="label">标题</text>
      <input v-model="title" class="input" placeholder="1–200 字" />
      <text v-if="isUpdate" class="hint">标题不参与作者签名，只有正文（题库为题组内容）受签名保护</text>
    </view>

    <view v-if="type === 'article'" class="field">
      <text class="label">正文（Markdown）</text>
      <textarea v-model="bodyMd" class="area" placeholder="正文内容" />
    </view>

    <block v-else>
      <view v-for="(q, i) in drafts" :key="i" class="qcard">
        <view class="qhead">
          <text class="label">第 {{ i + 1 }} 题</text>
          <text v-if="drafts.length > 1" class="del" @click="removeQuestion(i)">删除本题</text>
        </view>
        <input v-model="q.q" class="input" placeholder="题干" />
        <view v-for="(opt, j) in q.options" :key="j" class="opt">
          <text class="pick" :class="q.answer === j ? 'pick-on' : ''" @click="pick(i, j)">{{ q.answer === j ? '●' : '○' }}</text>
          <input v-model="q.options[j]" class="input opt-in" placeholder="选项" />
          <text v-if="q.options.length > 2" class="del" @click="removeOption(i, j)">✕</text>
        </view>
        <text class="add" @click="addOption(i)">+ 选项</text>
        <input v-model="q.explain" class="input" placeholder="解析（可空）" />
      </view>
      <text class="add" @click="addQuestion">+ 加一题</text>
    </block>

    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <button class="submit" :disabled="busy" @click="submit">{{ busy ? '提交中…' : '提交' }}</button>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { buildQuestionJSON, draftsFromQuestionJSON, emptyDraft, type QuestionDraft } from '../../core/quizdoc';
import { enqueueOrSend, newItemID, type SubmitDraft } from '../../core/submit';
import { bootstrap } from '../../platform';

const itemId = ref('');
const type = ref<'article' | 'quiz'>('article');
const title = ref('');
const bodyMd = ref('');
const drafts = ref<QuestionDraft[]>([emptyDraft()]);
const busy = ref(false);
const error = ref('');
const notice = ref('');

const isUpdate = computed(() => itemId.value !== '');

onLoad(async (query) => {
  const raw = String((query as Record<string, string> | undefined)?.itemId ?? '');
  if (raw === '') return;
  try {
    const { repo } = await bootstrap();
    const row = await repo.getSubmission(raw);
    if (!row) {
      error.value = '本地台账没有这条记录';
      return;
    }
    itemId.value = row.itemId;
    type.value = row.type;
    title.value = row.title;
    bodyMd.value = row.bodyMd;
    const loaded = row.type === 'quiz' ? draftsFromQuestionJSON(row.questionJson) : [];
    drafts.value = loaded.length > 0 ? loaded : [emptyDraft()];
  } catch (e) {
    error.value = (e as Error).message;
  }
});

/** 新建模式才允许切载体；更新模式的载体由 item_id 前缀固定（本册 §5.4） */
function switchType(next: 'article' | 'quiz') {
  if (!isUpdate.value) type.value = next;
}
function pick(i: number, j: number) {
  drafts.value[i]!.answer = j;
}
function addOption(i: number) {
  drafts.value[i]!.options.push('');
}
function removeOption(i: number, j: number) {
  const q = drafts.value[i]!;
  q.options.splice(j, 1);
  if (q.answer >= q.options.length) q.answer = -1;
}
function addQuestion() {
  drafts.value.push(emptyDraft());
}
function removeQuestion(i: number) {
  drafts.value.splice(i, 1);
}

async function submit() {
  error.value = '';
  notice.value = '';
  const draft: SubmitDraft = {
    itemId: itemId.value || newItemID(type.value),
    type: type.value,
    title: title.value,
    bodyMd: '',
    questionJson: '',
  };
  if (type.value === 'quiz') {
    const built = buildQuestionJSON(drafts.value);
    if (built === null) {
      error.value = '题组内容不合法：每题需题干、至少 2 个选项并选定正确项';
      return;
    }
    draft.questionJson = built;
  } else {
    draft.bodyMd = bodyMd.value;
  }

  busy.value = true;
  try {
    const { opts, repo } = await bootstrap();
    const out = await enqueueOrSend({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl }, draft);
    itemId.value = out.itemId;
    if (out.ledgerState === 'sent') {
      uni.showToast({ title: out.created ? '已提交' : '已更新', icon: 'success' });
      setTimeout(() => uni.navigateBack(), 600);
      return;
    }
    // 未送达：pending 会自动补发，failed 需回「我的条目」删除后重投
    notice.value = out.message;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 12px; }
.tabs { display: flex; margin-bottom: 8px; }
.tab { padding: 6px 16px; border: 1px solid #dddddd; border-radius: 16px; margin-right: 10px; color: #666666; font-size: 14px; }
.tab-on { border-color: #2b6cb0; color: #2b6cb0; }
.field { margin-bottom: 14px; }
.label { display: block; font-size: 14px; color: #666666; margin-bottom: 6px; }
.hint { display: block; font-size: 12px; color: #999999; margin-top: 4px; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: 14px; }
.opt-in { flex: 1; }
.area { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 220px; font-size: 14px; }
.qcard { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 12px; }
.qhead { display: flex; justify-content: space-between; }
.opt { display: flex; align-items: center; margin: 6px 0; }
.pick { width: 28px; color: #888888; }
.pick-on { color: #2b6cb0; }
.add { display: block; color: #2b6cb0; font-size: 14px; padding: 6px 0; }
.del { color: #c53030; font-size: 13px; }
.error { display: block; color: #c53030; font-size: 13px; margin: 8px 0; }
.notice { display: block; color: #b7791f; font-size: 13px; margin: 8px 0; }
.submit { margin-top: 16px; background: #2b6cb0; color: #ffffff; }
</style>
```

- [ ] **Step 3: 写 `pages/myitems/myitems.vue`**

三段：待发（可改可删）/ 已提交（可查看、可重投更新）/ 失败（显示原因、只可删）；进入页面触发一次补发。

```vue
<template>
  <view class="wrap">
    <text class="title">我的条目</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <view class="sec">
      <text class="sec-title">待发（{{ pending.length }}）</text>
      <text v-if="pending.length === 0" class="empty">没有待发条目</text>
      <view v-for="row in pending" :key="row.itemId" class="card">
        <text class="t">{{ row.title }}</text>
        <text class="meta">{{ row.itemId }}</text>
        <text v-if="row.reason" class="meta">{{ row.reason }}</text>
        <view class="acts">
          <text class="act" @click="edit(row)">修改</text>
          <text class="act" @click="remove(row)">删除</text>
        </view>
      </view>
    </view>

    <view class="sec">
      <text class="sec-title">已提交（{{ sent.length }}）</text>
      <text class="note">重投不会恢复已被治理下架的条目；如需恢复请到「提案与投票」发起复活提案。</text>
      <text v-if="sent.length === 0" class="empty">还没有提交过条目</text>
      <view v-for="row in sent" :key="row.itemId" class="card">
        <text class="t">{{ row.title }}</text>
        <text class="meta">{{ row.itemId }} · {{ row.created === 1 ? '首投' : '更新' }} · {{ row.sentAt.slice(0, 10) }}</text>
        <view class="acts">
          <text class="act" @click="open(row)">查看</text>
          <text class="act" @click="edit(row)">重投更新</text>
        </view>
      </view>
    </view>

    <view class="sec">
      <text class="sec-title">失败（{{ failed.length }}）</text>
      <text class="note">失败项的 item_id 就是身份，改字段救不回；只能删除后以新 id 重投。</text>
      <text v-if="failed.length === 0" class="empty">没有失败条目</text>
      <view v-for="row in failed" :key="row.itemId" class="card">
        <text class="t">{{ row.title }}</text>
        <text class="meta">{{ row.itemId }}</text>
        <text class="reason">{{ row.reason }}</text>
        <view class="acts">
          <text class="act" @click="remove(row)">删除</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { flushSubmissions } from '../../core/submit';
import type { MySubmissionRow } from '../../core/types';
import { bootstrap } from '../../platform';

const pending = ref<MySubmissionRow[]>([]);
const sent = ref<MySubmissionRow[]>([]);
const failed = ref<MySubmissionRow[]>([]);
const error = ref('');
const notice = ref('');

// onShow 而不是 onLoad：从编辑器返回后必须立刻反映；同一轮补发由模块级单飞标志兜住
onShow(async () => {
  error.value = '';
  notice.value = '';
  try {
    const { opts, repo } = await bootstrap();
    const res = await flushSubmissions({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl });
    if (res.sent > 0) notice.value = `已补发 ${res.sent} 条`;
    else if (res.error) notice.value = res.error;
    pending.value = await repo.listSubmissions('pending');
    sent.value = (await repo.listSubmissions('sent')).reverse();
    failed.value = await repo.listSubmissions('failed');
  } catch (e) {
    error.value = (e as Error).message;
  }
});

function edit(row: MySubmissionRow) {
  uni.navigateTo({ url: `/pages/submit/submit?itemId=${encodeURIComponent(row.itemId)}` });
}

function open(row: MySubmissionRow) {
  const page = row.type === 'quiz' ? 'quiz/quiz' : 'article/article';
  uni.navigateTo({ url: `/pages/${page}?itemId=${encodeURIComponent(row.itemId)}` });
}

async function remove(row: MySubmissionRow) {
  const { repo } = await bootstrap();
  await repo.removeSubmission(row.itemId);
  pending.value = await repo.listSubmissions('pending');
  failed.value = await repo.listSubmissions('failed');
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 12px; }
.sec { margin-bottom: 22px; }
.sec-title { display: block; font-size: 15px; font-weight: 600; margin-bottom: 8px; }
.note { display: block; font-size: 12px; color: #999999; margin-bottom: 8px; }
.empty { display: block; color: #999999; font-size: 13px; padding: 6px 0; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.t { display: block; font-size: 15px; }
.meta { display: block; color: #888888; font-size: 12px; }
.reason { display: block; color: #c53030; font-size: 13px; margin-top: 4px; }
.acts { display: flex; margin-top: 8px; }
.act { margin-right: 18px; color: #2b6cb0; font-size: 14px; }
.error { display: block; color: #c53030; font-size: 13px; margin-bottom: 8px; }
.notice { display: block; color: #b7791f; font-size: 13px; margin-bottom: 8px; }
</style>
```

- [ ] **Step 4: 自测**

Run（cwd `e:\code\base\apps\mobile`）: `npx tsc --noEmit`

Expected: 无输出（`.vue` 不参与 tsc，但 `core` 的类型改动会在这里暴露）

Run: `npx vitest run`

Expected: 全绿（本 Task 不动 core 逻辑）

Run: `npm run build:h5`

Expected: 构建成功——H5 构建会真正编译这两个 `.vue`，是「模板语法 / 导入路径写错」的兜底检查

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/pages/submit/submit.vue apps/mobile/src/pages/myitems/myitems.vue apps/mobile/src/pages.json
git commit -m "feat(mobile): 投稿编辑器与我的条目页（双模式、三段台账、进入即补发）"
git push
```

---

### Task 5: 提案与投票（`govern.ts` + 页面 + 文章页入口）

**Files:**
- Create: `apps/mobile/src/core/govern.ts`
- Create: `apps/mobile/src/core/govern.test.ts`
- Create: `apps/mobile/src/pages/governance/governance.vue`
- Modify: `apps/mobile/src/pages/article/article.vue`
- Modify: `apps/mobile/src/pages.json`

- [ ] **Step 1: 写 `govern.ts`**

```ts
/**
 * 治理：提案列表（匿名读）、发起提案（签名写）、投票（签名写）。
 *
 * **薄封装、无本地状态**（本册 §4.2）：票数 / 门槛 / 状态一律来自当次响应，
 * 不缓存、不增量推算（#27 风险 3）。只依赖注入的 `Adapters` / `LocalRepo`，不 import 'uni'。
 */
import { utf8 } from '@base/protocol-ts';

import { CommentError, ensureRegistered, type CommentOptions } from './comment';
import { errorCodeOf, errorText } from './errors';
import { peekLocalIdentity, signRequestHeaders, type Identity } from './identity';
import { decodeUtf8 } from './sync';

/** 与 `core/comment.ts` 同一组依赖（同一套 `ensureRegistered`，本册不另立会话模块）。 */
export type GovernOptions = CommentOptions;

/** 三个受审动作（#27 §2.1）。 */
export type GovernAction = 'remove' | 'edit' | 'revive';

/** 提案状态三值（#27 §4.4）。 */
export type GovernStatus = 'pending' | 'effective' | 'void';

export interface ProposalItem {
  /** 十进制整数字符串，与节点侧同一 id */
  proposalId: string;
  action: GovernAction;
  itemId: string;
  proposerId: string;
  reason: string;
  /** 仅 `edit` 提案非空 */
  title: string;
  /** 仅 `edit` 提案非空 */
  bodyMd: string;
  status: GovernStatus;
  /** 当前有效票的投票人 id（已按名册实时复判） */
  votes: string[];
  voteCount: number;
  threshold: number;
  createdAt: number;
  executedAt: number;
  voidedAt: number;
}

export class GovernError extends Error {
  constructor(
    readonly code: 'network' | 'rejected' | 'rate_limited' | 'server' | 'client',
    message: string,
  ) {
    super(message);
    this.name = 'GovernError';
  }
}

/** 本机身份 id（不联网、不生成）；无身份返回空串。只用于「已投 / 名册内」的展示判定（本册 §2.3）。 */
export async function myIdentityId(o: GovernOptions): Promise<string> {
  try {
    const ident = await peekLocalIdentity(o.adapters.storage);
    return ident?.id ?? '';
  } catch {
    return '';
  }
}

function toProposalItem(p: Record<string, unknown>): ProposalItem {
  return {
    proposalId: String(p.proposal_id ?? ''),
    action: String(p.action ?? 'remove') as GovernAction,
    itemId: String(p.item_id ?? ''),
    proposerId: String(p.proposer_id ?? ''),
    reason: String(p.reason ?? ''),
    title: String(p.title ?? ''),
    bodyMd: String(p.body_md ?? ''),
    status: String(p.status ?? 'pending') as GovernStatus,
    votes: Array.isArray(p.votes) ? p.votes.map((v) => String(v)) : [],
    voteCount: Number(p.vote_count ?? 0),
    threshold: Number(p.threshold ?? 0),
    createdAt: Number(p.created_at ?? 0),
    executedAt: Number(p.executed_at ?? 0),
    voidedAt: Number(p.voided_at ?? 0),
  };
}

/**
 * 拉提案列表。接口按 `proposal_id` 升序（旧 → 新）返回；这里只做**纯展示反转**（新提案在前），
 * 除此之外不排序、不派生任何字段（本册 §5.6）。
 */
export async function listProposals(o: GovernOptions): Promise<ProposalItem[]> {
  let res;
  try {
    res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/proposal`);
  } catch {
    throw new GovernError('network', '需要联网才能查看提案');
  }
  if (res.status !== 200) throw new GovernError('server', `读取提案失败（HTTP ${res.status}）`);
  const page = JSON.parse(decodeUtf8(res.body)) as { proposals?: Array<Record<string, unknown>> };
  return (page.proposals ?? []).map(toProposalItem).reverse();
}

/** 身份准备；`CommentError` 统一换成 `GovernError`，页面只处理一种错误类型。 */
async function ensureIdentity(o: GovernOptions): Promise<Identity> {
  try {
    return await ensureRegistered(o);
  } catch (e) {
    if (e instanceof CommentError) {
      throw new GovernError(e.code === 'network' ? 'network' : 'rejected', e.message);
    }
    throw new GovernError('client', `身份准备失败：${(e as Error).message ?? String(e)}`);
  }
}

/** 带 5 个签名头 POST 一次（三个签名写路径共用；不解析响应）。 */
async function signedPost(
  o: GovernOptions,
  ident: Identity,
  path: string,
  bytes: Uint8Array,
  fallback: string,
): Promise<{ status: number; body: string }> {
  const headers = signRequestHeaders(ident, { method: 'POST', path, body: bytes });
  let res;
  try {
    res = await o.adapters.http.post(`${o.nodeBaseUrl}${path}`, bytes, {
      'Content-Type': 'application/json',
      ...headers,
    });
  } catch {
    throw new GovernError('network', '需要联网才能完成该操作');
  }
  const body = decodeUtf8(res.body);
  if (res.status >= 200 && res.status < 300) return { status: res.status, body };
  const code = errorCodeOf(body);
  if (res.status === 429) throw new GovernError('rate_limited', errorText(code, '操作过于频繁，请稍后再试'));
  if (res.status >= 500) throw new GovernError('server', `${fallback}（HTTP ${res.status}）`);
  throw new GovernError('rejected', errorText(code, `${fallback}（HTTP ${res.status}）`));
}

export interface CreateProposalInput {
  action: GovernAction;
  itemId: string;
  reason: string;
  /** 仅 `edit` 需要（#27 §3.1） */
  edit?: { title: string; bodyMd: string };
}

/** 发起提案。**不做本地资格预判**（本册 §2.3）：资格一律由服务端裁决。 */
export async function createProposal(o: GovernOptions, input: CreateProposalInput): Promise<{ proposalId: string }> {
  const ident = await ensureIdentity(o);
  const payload: Record<string, unknown> = { action: input.action, item_id: input.itemId, reason: input.reason };
  // 只有 edit 才带 edit 块（remove / revive 带了会被判 proposal_edit_invalid）
  if (input.action === 'edit') {
    payload.edit = { title: input.edit?.title ?? '', body_md: input.edit?.bodyMd ?? '' };
  }
  // 命中 201 Created（本计划的「已核实的环境事实」写了这一点）
  const r = await signedPost(o, ident, '/v1/proposal', utf8(JSON.stringify(payload)), '发起提案失败');
  const out = JSON.parse(r.body) as Record<string, unknown>;
  return { proposalId: String(out.proposal_id ?? '') };
}

export interface VoteResult {
  proposalId: string;
  voteCount: number;
  threshold: number;
  status: GovernStatus;
}

/** 投一票。达门槛当场生效，响应用来就地刷新那一条；调用方随后应重拉一次列表对齐（本册 §5.6）。 */
export async function vote(o: GovernOptions, proposalId: string): Promise<VoteResult> {
  const ident = await ensureIdentity(o);
  // 请求体可为空对象：节点侧「空体与 {} 等价」（#27 §3.2）
  const r = await signedPost(
    o,
    ident,
    `/v1/proposal/${encodeURIComponent(proposalId)}/vote`,
    utf8('{}'),
    '投票失败',
  );
  const out = JSON.parse(r.body) as Record<string, unknown>;
  return {
    proposalId: String(out.proposal_id ?? proposalId),
    voteCount: Number(out.vote_count ?? 0),
    threshold: Number(out.threshold ?? 0),
    status: String(out.status ?? 'pending') as GovernStatus,
  };
}
```

- [ ] **Step 2: 写 `govern.test.ts`**

```ts
import { describe, expect, it } from 'vitest';

import { requestSignBytes, sha256Hex, utf8, verify, type RequestMeta } from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { createProposal, listProposals, myIdentityId, vote, GovernError, type GovernOptions } from './govern';
import { decodeUtf8 } from './sync';

const BASE = 'https://node.test';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function fixture() {
  const http = new FakeHttp();
  const repo = new MemoryRepo();
  const o: GovernOptions = { adapters: fakeAdapters(http, new MemoryFs(), new FakePackReader()), repo, nodeBaseUrl: BASE };
  return { http, repo, o };
}

function registeredPub(http: FakeHttp): string {
  const reg = http.posted.find((p) => p.url.endsWith('/v1/identity/register'));
  if (!reg) throw new Error('未发出登记请求');
  return (JSON.parse(decodeUtf8(reg.body)) as { pubkey: string }).pubkey;
}

const ROW = {
  proposal_id: '7',
  action: 'remove',
  item_id: 'article/aaa',
  proposer_id: 'p1',
  reason: '内容不准确',
  title: '',
  body_md: '',
  status: 'pending',
  votes: ['p1'],
  vote_count: 1,
  threshold: 3,
  created_at: 1790000000000,
  executed_at: 0,
  voided_at: 0,
};

describe('govern', () => {
  it('列表：字段逐个映射、votes 数组原样、按 proposal_id 升序返回后做纯展示反转', async () => {
    const { http, o } = fixture();
    http.routes.set(`${BASE}/v1/proposal`, json({ proposals: [{ ...ROW, proposal_id: '1' }, { ...ROW, proposal_id: '2', status: 'void' }] }));
    const items = await listProposals(o);
    expect(items.map((p) => p.proposalId)).toEqual(['2', '1']);
    expect(items[1]).toEqual({
      proposalId: '1', action: 'remove', itemId: 'article/aaa', proposerId: 'p1', reason: '内容不准确',
      title: '', bodyMd: '', status: 'pending', votes: ['p1'], voteCount: 1, threshold: 3,
      createdAt: 1790000000000, executedAt: 0, voidedAt: 0,
    });
    // 空列表返回 []
    http.routes.set(`${BASE}/v1/proposal`, json({ proposals: [] }));
    expect(await listProposals(o)).toEqual([]);
  });

  it('列表：断网 → GovernError(network)，不做离线兜底（本册 §9.1）', async () => {
    const { o } = fixture();
    o.adapters.http = { get: () => Promise.reject(new Error('断网')), post: () => Promise.reject(new Error('断网')) };
    const err = (await listProposals(o).catch((e: unknown) => e)) as GovernError;
    expect(err).toBeInstanceOf(GovernError);
    expect(err.code).toBe('network');
    expect(err.message).toBe('需要联网才能查看提案');
  });

  it('发起：请求体只含 action/item_id/reason，签名头可被节点按同一字节重建', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/proposal`, { status: 201, body: utf8(JSON.stringify({ proposal_id: '9' })) });
    const res = await createProposal(o, { action: 'remove', itemId: 'article/aaa', reason: '内容不准确' });
    expect(res.proposalId).toBe('9');

    const wire = http.posted[1]!;
    expect(JSON.parse(decodeUtf8(wire.body))).toEqual({ action: 'remove', item_id: 'article/aaa', reason: '内容不准确' });
    const h = wire.headers;
    const meta: RequestMeta = {
      method: 'POST', path: '/v1/proposal', query: '', bodySha256: sha256Hex(wire.body),
      ts: Number(h['X-Base-Ts']), nonce: h['X-Base-Nonce']!,
    };
    expect(verify(registeredPub(http), requestSignBytes(meta), h['X-Base-Sig']!)).toBe(true);
  });

  it('发起：edit 才带 edit 块；remove / revive 不带', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/proposal`, { status: 201, body: utf8(JSON.stringify({ proposal_id: '1' })) });
    await createProposal(o, { action: 'edit', itemId: 'article/aaa', reason: '改写', edit: { title: '新题', bodyMd: '新正文' } });
    expect(JSON.parse(decodeUtf8(http.posted[1]!.body))).toEqual({
      action: 'edit', item_id: 'article/aaa', reason: '改写', edit: { title: '新题', body_md: '新正文' },
    });
    await createProposal(o, { action: 'revive', itemId: 'article/aaa', reason: '复活' });
    expect(JSON.parse(decodeUtf8(http.posted[2]!.body))).toEqual({ action: 'revive', item_id: 'article/aaa', reason: '复活' });
  });

  it('失败映射：错误码转中文；429 与 5xx 各归其类', async () => {
    const cases: Array<[number, string, string, string]> = [
      [403, 'proposer_not_governor', 'rejected', '不在本节点治理者名册内'],
      [400, 'item_self_owned', 'rejected', '这是你自己的条目，请直接改用投稿'],
      [404, 'item_not_found', 'rejected', '目标条目不存在'],
      [429, 'govern_rate_limited', 'rate_limited', '操作过于频繁，请稍后再试'],
    ];
    for (const [status, code, wantCode, wantMsg] of cases) {
      const { http, o } = fixture();
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      http.postRoutes.set(`${BASE}/v1/proposal`, { status, body: utf8(JSON.stringify({ code })) });
      const err = (await createProposal(o, { action: 'remove', itemId: 'article/a', reason: 'x' }).catch((e: unknown) => e)) as GovernError;
      expect(err.code).toBe(wantCode);
      expect(err.message).toBe(wantMsg);
    }
  });

  it('投票：POST 到 /v1/proposal/{id}/vote、体为 {}、响应解析；重复投票 409 → 你已投过票', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/proposal/7/vote`, json({ proposal_id: '7', vote_count: 3, threshold: 3, status: 'effective' }));
    const res = await vote(o, '7');
    expect(res).toEqual({ proposalId: '7', voteCount: 3, threshold: 3, status: 'effective' });
    expect(http.posted[1]!.url).toBe(`${BASE}/v1/proposal/7/vote`);
    expect(decodeUtf8(http.posted[1]!.body)).toBe('{}');

    http.postRoutes.set(`${BASE}/v1/proposal/7/vote`, { status: 409, body: utf8(JSON.stringify({ code: 'already_voted' })) });
    const err = (await vote(o, '7').catch((e: unknown) => e)) as GovernError;
    expect(err.code).toBe('rejected');
    expect(err.message).toBe('你已投过票');
  });

  it('myIdentityId：本机无身份返回空串（不生成身份）', async () => {
    const { o } = fixture();
    expect(await myIdentityId(o)).toBe('');
  });
});
```

- [ ] **Step 3: 写 `pages/governance/governance.vue`**

列表每次 `onShow` 实时拉取，**不缓存**；已投（`votes` 含我的 id）不显示投票按钮；非 `pending` 不显示投票按钮；带 `itemId` 进入即展开发起表单。

```vue
<template>
  <view class="wrap">
    <text class="title">提案与投票</text>
    <text class="note">下架 3 票、改写与复活各 2 票；票数按名册实时复判。名册人数不足门槛时提案挂起。</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <view class="card">
      <text class="sec-title">{{ formOpen ? '发起提案' : '发起提案' }}</text>
      <text v-if="!formOpen" class="act" @click="formOpen = true">＋ 发起</text>
      <block v-else>
        <input v-model="form.itemId" class="input" placeholder="目标条目 id（如 article/abc）" />
        <view class="actions">
          <text v-for="a in ACTIONS" :key="a.key" class="act" :class="form.action === a.key ? 'act-on' : ''" @click="form.action = a.key">{{ a.label }}</text>
        </view>
        <input v-model="form.reason" class="input" placeholder="理由（1–200 字）" />
        <block v-if="form.action === 'edit'">
          <input v-model="form.editTitle" class="input" placeholder="拟改标题（仅改写需要）" />
          <textarea v-model="form.editBody" class="area" placeholder="拟改正文（仅改写需要）" />
        </block>
        <text class="act" @click="submitProposal">提交提案</text>
      </block>
    </view>

    <text v-if="loading" class="empty">加载中…</text>
    <text v-else-if="items.length === 0" class="empty">本节点暂无提案</text>
    <view v-for="p in items" :key="p.proposalId" class="card">
      <view class="row">
        <text class="badge">{{ ACTION_LABEL[p.action] }}</text>
        <text class="t">{{ p.itemId }}</text>
      </view>
      <text class="meta">#{{ p.proposalId }} · {{ STATUS_LABEL[p.status] }} · {{ createdText(p.createdAt) }}</text>
      <text class="meta">{{ p.reason }}</text>
      <text class="meta">{{ p.voteCount }} / {{ p.threshold }} 票</text>
      <text v-if="p.status === 'pending' && p.threshold > p.voteCount" class="meta">挂起中：达到 {{ p.threshold }} 票才生效</text>
      <view v-if="p.action === 'edit'" class="diff">
        <text class="meta">拟改标题：{{ p.title }}</text>
        <text class="meta">拟改正文：{{ p.bodyMd }}</text>
      </view>
      <text
        v-if="p.status === 'pending' && !hasVoted(p)"
        class="act"
        @click="castVote(p)"
      >投票</text>
      <text v-else-if="p.status === 'pending'" class="meta">你已投票</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';

import { createProposal, listProposals, myIdentityId, vote, type GovernAction, type ProposalItem } from '../../core/govern';
import { bootstrap } from '../../platform';

const ACTION_LABEL: Record<GovernAction, string> = { remove: '下架', edit: '改写', revive: '复活' };
const STATUS_LABEL: Record<ProposalItem['status'], string> = { pending: '待决', effective: '已生效', void: '已作废' };
const ACTIONS: Array<{ key: GovernAction; label: string }> = [
  { key: 'remove', label: '下架' },
  { key: 'edit', label: '改写' },
  { key: 'revive', label: '复活' },
];

const items = ref<ProposalItem[]>([]);
const myId = ref('');
const loading = ref(false);
const error = ref('');
const notice = ref('');
const formOpen = ref(false);
const form = reactive({ action: 'remove' as GovernAction, itemId: '', reason: '', editTitle: '', editBody: '' });

onLoad((query) => {
  const q = query as Record<string, string> | undefined;
  const itemId = String(q?.itemId ?? '');
  const action = String(q?.action ?? '');
  if (itemId !== '') {
    formOpen.value = true;
    form.itemId = itemId;
  }
  if (action === 'remove' || action === 'edit' || action === 'revive') form.action = action;
});

// 每次 onShow 实时拉取：票数、门槛、状态全部来自这一次拉取，本地不缓存、不推算（本册 §5.6）
onShow(async () => {
  await refresh();
});

async function opts() {
  const { opts: o, repo } = await bootstrap();
  return { adapters: o.adapters, repo, nodeBaseUrl: o.nodeBaseUrl };
}

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const o = await opts();
    myId.value = await myIdentityId(o);
    items.value = await listProposals(o);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function hasVoted(p: ProposalItem): boolean {
  return myId.value !== '' && p.votes.includes(myId.value);
}

function createdText(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : '';
}

async function submitProposal() {
  error.value = '';
  notice.value = '';
  try {
    const o = await opts();
    await createProposal(o, {
      action: form.action,
      itemId: form.itemId.trim(),
      reason: form.reason.trim(),
      edit: form.action === 'edit' ? { title: form.editTitle.trim(), bodyMd: form.editBody } : undefined,
    });
    formOpen.value = false;
    form.reason = '';
    form.editTitle = '';
    form.editBody = '';
    notice.value = '提案已发起（签名即第 1 票）';
    items.value = await listProposals(o);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function castVote(p: ProposalItem) {
  error.value = '';
  try {
    const o = await opts();
    const res = await vote(o, p.proposalId);
    notice.value = `${res.voteCount} / ${res.threshold} 票（${STATUS_LABEL[res.status]}）`;
    // 紧接着重拉一次对齐：可能同时存在他人投票（本册 §5.6）
    items.value = await listProposals(o);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 6px; }
.note { display: block; font-size: 12px; color: #999999; margin-bottom: 12px; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.row { display: flex; align-items: center; }
.sec-title { display: block; font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.badge { font-size: 12px; color: #2b6cb0; border: 1px solid #2b6cb0; border-radius: 10px; padding: 0 8px; margin-right: 8px; }
.t { font-size: 15px; }
.meta { display: block; color: #888888; font-size: 12px; margin-top: 2px; }
.diff { margin-top: 6px; padding-top: 6px; border-top: 1px dashed #eeeeee; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: 14px; margin-top: 8px; }
.area { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 140px; font-size: 14px; margin-top: 8px; }
.actions { display: flex; margin-top: 8px; }
.act { display: block; color: #2b6cb0; font-size: 14px; margin-top: 10px; }
.act-on { color: #b7791f; }
.empty { display: block; color: #999999; font-size: 13px; padding: 8px 0; }
.error { display: block; color: #c53030; font-size: 13px; margin: 6px 0; }
.notice { display: block; color: #b7791f; font-size: 13px; margin: 6px 0; }
</style>
```

- [ ] **Step 4: 文章详情页加「治理」按钮**

`apps/mobile/src/pages/article/article.vue`：在 `<view class="actions">` 里「评论」之后加一行：

```html
        <text class="act" @click="openGovernance">治理</text>
```

并在 `openComments` 之后加：

```ts
/**
 * 「治理」恒显：本地 `items` 表没有 `author_id`，判不出「这条是不是我写的」，
 * 资格一律由服务端回 `item_self_owned` / `item_state_mismatch` 后提示（本册 §2.3）。
 */
function openGovernance() {
  uni.navigateTo({ url: `/pages/governance/governance?itemId=${encodeURIComponent(itemId.value)}` });
}
```

- [ ] **Step 5: `pages.json` 加治理页路由**

在 `pages` 数组末尾追加：

```json
    {
      "path": "pages/governance/governance",
      "style": { "navigationBarTitleText": "提案与投票" }
    }
```

- [ ] **Step 6: 自测**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run src/core/govern.test.ts`

Expected: 7 项全绿

Run: `npx tsc --noEmit`

Expected: 无输出

Run: `npm run build:h5`

Expected: 构建成功（编译 `governance.vue` 与改过的 `article.vue`）

- [ ] **Step 7: 提交**

```bash
git add apps/mobile/src/core/govern.ts apps/mobile/src/core/govern.test.ts apps/mobile/src/pages/governance/governance.vue apps/mobile/src/pages/article/article.vue apps/mobile/src/pages.json
git commit -m "feat(mobile): 提案与投票页（实时拉取、已投判定、发起表单）与文章页治理入口"
git push
```

---

### Task 6: 我的贡献 + 「我的」页四行入口

**Files:**
- Create: `apps/mobile/src/core/contribution.ts`
- Create: `apps/mobile/src/core/contribution.test.ts`
- Create: `apps/mobile/src/pages/contribution/contribution.vue`
- Modify: `apps/mobile/src/pages/mine/mine.vue`
- Modify: `apps/mobile/src/pages.json`

- [ ] **Step 1: 写 `contribution.ts`**

```ts
/**
 * 我的贡献：昵称写入（签名写）与名册读取（匿名读）。
 *
 * 薄封装（本册 §4.2）。名册与昵称**不做跨节点同步**（#23 已定）。
 * 只依赖注入的 `Adapters` / `LocalRepo`，不 import 'uni'。
 */
import { utf8 } from '@base/protocol-ts';

import { CommentError, ensureRegistered, type CommentOptions } from './comment';
import { errorCodeOf, errorText } from './errors';
import { peekLocalIdentity, signRequestHeaders, type Identity } from './identity';
import { decodeUtf8 } from './sync';

/** 与 `core/comment.ts` 同一组依赖（同一套 `ensureRegistered`，本册不另立会话模块）。 */
export type ContributionOptions = CommentOptions;

export interface ContributorItem {
  id: string;
  /** 缺昵称时节点已回退成 `id[:8]`（#23 §5.1），客户端不再二次兜底 */
  name: string;
  count: number;
}

export class ContributionError extends Error {
  constructor(
    readonly code: 'network' | 'rejected' | 'server' | 'client',
    message: string,
  ) {
    super(message);
    this.name = 'ContributionError';
  }
}

/** 名册（匿名读、前 10、实时派生）。 */
export async function roster(o: ContributionOptions): Promise<ContributorItem[]> {
  let res;
  try {
    res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/contributors`);
  } catch {
    throw new ContributionError('network', '需要联网才能查看名册');
  }
  if (res.status !== 200) throw new ContributionError('server', `读取名册失败（HTTP ${res.status}）`);
  const page = JSON.parse(decodeUtf8(res.body)) as { contributors?: Array<Record<string, unknown>> };
  return (page.contributors ?? []).map((c) => ({
    id: String(c.id ?? ''),
    name: String(c.name ?? ''),
    count: Number(c.count ?? 0),
  }));
}

/** 本机身份 id（不联网、不生成）；无身份返回空串。只用于「在榜标出自己」。 */
export async function myIdentityId(o: ContributionOptions): Promise<string> {
  try {
    const ident = await peekLocalIdentity(o.adapters.storage);
    return ident?.id ?? '';
  } catch {
    return '';
  }
}

/** 写昵称。**请求体不得携带 `id`**（携带即 `profile_id_forbidden`，#23 §5.2）。 */
export async function putName(o: ContributionOptions, name: string): Promise<void> {
  let ident: Identity;
  try {
    ident = await ensureRegistered(o);
  } catch (e) {
    if (e instanceof CommentError) {
      throw new ContributionError(e.code === 'network' ? 'network' : 'rejected', e.message);
    }
    throw new ContributionError('client', `身份准备失败：${(e as Error).message ?? String(e)}`);
  }
  const bytes = utf8(JSON.stringify({ name }));
  const headers = signRequestHeaders(ident, { method: 'POST', path: '/v1/profile', body: bytes });
  let res;
  try {
    res = await o.adapters.http.post(`${o.nodeBaseUrl}/v1/profile`, bytes, {
      'Content-Type': 'application/json',
      ...headers,
    });
  } catch {
    throw new ContributionError('network', '需要联网才能保存昵称');
  }
  if (res.status !== 200) {
    const body = decodeUtf8(res.body);
    if (res.status >= 500) throw new ContributionError('server', `保存昵称失败（HTTP ${res.status}）`);
    throw new ContributionError('rejected', errorText(errorCodeOf(body), `保存昵称失败（HTTP ${res.status}）`));
  }
}
```

- [ ] **Step 2: 写 `contribution.test.ts`**

```ts
import { describe, expect, it } from 'vitest';

import { requestSignBytes, sha256Hex, utf8, verify, type RequestMeta } from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { myIdentityId, putName, roster, ContributionError, type ContributionOptions } from './contribution';
import { decodeUtf8 } from './sync';

const BASE = 'https://node.test';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function fixture() {
  const http = new FakeHttp();
  const repo = new MemoryRepo();
  const o: ContributionOptions = { adapters: fakeAdapters(http, new MemoryFs(), new FakePackReader()), repo, nodeBaseUrl: BASE };
  return { http, repo, o };
}

describe('contribution', () => {
  it('名册：字段映射；空名册返回 []', async () => {
    const { http, o } = fixture();
    http.routes.set(`${BASE}/v1/contributors`, json({ contributors: [{ id: 'a'.repeat(64), name: '甲', count: 3 }] }));
    expect(await roster(o)).toEqual([{ id: 'a'.repeat(64), name: '甲', count: 3 }]);
    http.routes.set(`${BASE}/v1/contributors`, json({ contributors: [] }));
    expect(await roster(o)).toEqual([]);
  });

  it('名册：断网 → ContributionError(network)', async () => {
    const { o } = fixture();
    o.adapters.http = { get: () => Promise.reject(new Error('断网')), post: () => Promise.reject(new Error('断网')) };
    const err = (await roster(o).catch((e: unknown) => e)) as ContributionError;
    expect(err.code).toBe('network');
    expect(err.message).toBe('需要联网才能查看名册');
  });

  it('写昵称：请求体只有 name、不带 id；签名头可被节点按同一字节重建', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/profile`, json({ id: 'x', name: '甲' }));
    await putName(o, '甲');

    const wire = http.posted[1]!;
    expect(decodeUtf8(wire.body)).toBe('{"name":"甲"}');
    expect(decodeUtf8(wire.body).includes('"id"')).toBe(false);

    const h = wire.headers;
    const meta: RequestMeta = {
      method: 'POST', path: '/v1/profile', query: '', bodySha256: sha256Hex(wire.body),
      ts: Number(h['X-Base-Ts']), nonce: h['X-Base-Nonce']!,
    };
    const reg = http.posted[0]!;
    const pub = (JSON.parse(decodeUtf8(reg.body)) as { pubkey: string }).pubkey;
    expect(verify(pub, requestSignBytes(meta), h['X-Base-Sig']!)).toBe(true);
  });

  it('写昵称失败：profile_name_invalid → 中文提示', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/profile`, { status: 400, body: utf8(JSON.stringify({ code: 'profile_name_invalid' })) });
    const err = (await putName(o, '').catch((e: unknown) => e)) as ContributionError;
    expect(err.code).toBe('rejected');
    expect(err.message).toBe('昵称需 1–32 字且不含控制字符');
  });

  it('myIdentityId：本机无身份返回空串', async () => {
    const { o } = fixture();
    expect(await myIdentityId(o)).toBe('');
  });
});
```

- [ ] **Step 3: 写 `pages/contribution/contribution.vue`**

```vue
<template>
  <view class="wrap">
    <text class="title">我的贡献</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <view class="card">
      <text class="label">公开昵称</text>
      <input v-model="name" class="input" placeholder="1–32 字" />
      <text class="act" @click="save">保存昵称</text>
      <text class="meta">昵称与名册不做跨节点同步</text>
    </view>

    <text class="sec-title">贡献前 10 名</text>
    <text v-if="contributors.length === 0" class="empty">暂无贡献者</text>
    <view v-for="c in contributors" :key="c.id" class="card" :class="c.id === myId ? 'me' : ''">
      <text class="t">{{ c.name }}</text>
      <text class="meta">{{ c.count }} 条 · {{ c.id.slice(0, 8) }}</text>
    </view>

    <view v-if="!inRoster" class="card">
      <text class="meta">未入前 10</text>
      <text class="meta">我的 id：{{ myIdShort }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { myIdentityId, putName, roster, type ContributorItem } from '../../core/contribution';
import { bootstrap } from '../../platform';

const contributors = ref<ContributorItem[]>([]);
const myId = ref('');
const name = ref('');
const error = ref('');
const notice = ref('');

const myIdShort = computed(() => (myId.value === '' ? '（本机还没有身份）' : myId.value.slice(0, 8)));
const inRoster = computed(() => myId.value !== '' && contributors.value.some((c) => c.id === myId.value));

onShow(async () => {
  error.value = '';
  try {
    const { opts, repo } = await bootstrap();
    const o = { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl };
    myId.value = await myIdentityId(o);
    contributors.value = await roster(o);
    const mine = contributors.value.find((c) => c.id === myId.value);
    if (mine) name.value = mine.name;
  } catch (e) {
    error.value = (e as Error).message;
  }
});

async function save() {
  error.value = '';
  notice.value = '';
  try {
    const { opts, repo } = await bootstrap();
    const o = { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl };
    await putName(o, name.value.trim());
    contributors.value = await roster(o);
    notice.value = '昵称已保存';
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 12px; }
.sec-title { display: block; font-size: 15px; font-weight: 600; margin: 14px 0 8px; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.me { border-color: #2b6cb0; }
.label { display: block; font-size: 14px; color: #666666; margin-bottom: 6px; }
.t { display: block; font-size: 15px; }
.meta { display: block; color: #888888; font-size: 12px; margin-top: 2px; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: 14px; }
.act { display: block; color: #2b6cb0; font-size: 14px; margin-top: 10px; }
.empty { display: block; color: #999999; font-size: 13px; padding: 6px 0; }
.error { display: block; color: #c53030; font-size: 13px; margin-bottom: 8px; }
.notice { display: block; color: #b7791f; font-size: 13px; margin-bottom: 8px; }
</style>
```

- [ ] **Step 4: `pages.json` 加贡献页路由**

在 `pages` 数组末尾追加：

```json
    {
      "path": "pages/contribution/contribution",
      "style": { "navigationBarTitleText": "我的贡献" }
    }
```

- [ ] **Step 5: 「我的」页两组四行入口**

`apps/mobile/src/pages/mine/mine.vue`：模板里在 `我的收藏` 之前插入两组入口；`script` 增加待发计数与名册提示。

模板（插在 `<navigator url="/pages/favorite/favorite" …>` 之前）：

```html
    <text class="group">创作</text>
    <navigator url="/pages/submit/submit" class="link">新建投稿</navigator>
    <navigator url="/pages/myitems/myitems" class="link">我的条目<text class="tail">{{ pendingText }}</text></navigator>

    <text class="group">治理</text>
    <navigator url="/pages/governance/governance" class="link">提案与投票<text class="tail">{{ rosterText }}</text></navigator>
    <navigator url="/pages/contribution/contribution" class="link">我的贡献</navigator>
```

`script`：把 `onShow` 改成同时读台账与名册状态，并加两个 computed：

```ts
import { myIdentityId, roster } from '../../core/contribution';

const pendingCount = ref(0);
/** 名册状态只作提示文案，不是资格判定（本册 §2.3） */
const rosterState = ref<'in' | 'out' | 'unknown'>('unknown');

const pendingText = computed(() => (pendingCount.value > 0 ? `（${pendingCount.value} 条待发）` : ''));
const rosterText = computed(() =>
  rosterState.value === 'unknown' ? '' : rosterState.value === 'in' ? '（名册内）' : '（未入名册）',
);

onShow(async () => {
  try {
    const { opts, repo } = await bootstrap();
    stats.value = await repo.learningStats();
    pendingCount.value = (await repo.listSubmissions('pending')).length;
    const o = { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl };
    const myId = await myIdentityId(o);
    const list = await roster(o);
    rosterState.value = myId !== '' && list.some((c) => c.id === myId) ? 'in' : 'out';
  } catch {
    // 「我的」不因读库 / 拉名册失败而报错，保持上一次的值（含 rosterState 保持 unknown）
  }
});
```

样式追加：

```css
.group { display: block; font-size: 13px; color: #999999; margin: 8px 0 4px; }
.tail { color: #2b6cb0; font-size: 13px; }
```

- [ ] **Step 6: 自测**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run`

Expected: 全绿（12 + 3 个新文件）

Run: `npx tsc --noEmit`

Expected: 无输出

Run: `npm run build:h5`

Expected: 构建成功

- [ ] **Step 7: 提交**

```bash
git add apps/mobile/src/core/contribution.ts apps/mobile/src/core/contribution.test.ts apps/mobile/src/pages/contribution/contribution.vue apps/mobile/src/pages/mine/mine.vue apps/mobile/src/pages.json
git commit -m "feat(mobile): 我的贡献页与「我的」页两组四行入口（含待发计数与名册提示）"
git push
```

---

### Task 7: 节点只读看板 `/governance`

**Files:**
- Modify: `internal/httpapi/web.go`
- Create: `web/templates/governance.html`
- Modify: `web/templates/base.html`
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/web_test.go`

- [ ] **Step 1: `web.go` 声明模板集合并追加页面数据字段**

`var` 块追加一行：

```go
	governanceTmpl = template.Must(template.New("governance").ParseFS(web.FS, "templates/base.html", "templates/governance.html"))
```

`pageData` 追加字段（**不改 `renderPage` 签名**）：

```go
	Proposals       []pageProposal
	Roster          []pageContributor
	RosterReady     bool
	RemoveThreshold int
	EditThreshold   int
```

新增三个小 struct 与四个纯展示辅助函数（与既有 `pageItem` / `pageArticle` 同风格）：

```go
// pageProposal 是看板的一行提案卡片（册子 §7.4）。
type pageProposal struct {
	Action         string
	ActionLabel    string
	ItemID         string
	Title          string
	Linkable       bool
	ItemState      string
	ItemStateLabel string
	Reason         string
	VoteCount      int
	Threshold      int
	Percent        int
	Status         string
	StatusLabel    string
	CreatedAt      string
	Voters         []pageContributor
	Edit           *pageProposalEdit
}

// pageProposalEdit 只在 Action == edit 时非空（匿名读接口本就返回这两个字段）。
type pageProposalEdit struct {
	Title  string
	BodyMD string
}

type pageContributor struct {
	ID    string
	Name  string
	Count int
}

// governActionLabel 是动作徽章的中文（看板不显示英文码）。
func governActionLabel(action string) string {
	switch action {
	case store.GovernActionRemove:
		return "下架"
	case store.GovernActionEdit:
		return "改写"
	case store.GovernActionRevive:
		return "复活"
	default:
		return action
	}
}

func governStatusLabel(status string) string {
	switch status {
	case store.GovernStatusPending:
		return "待决"
	case store.GovernStatusEffective:
		return "已生效"
	case store.GovernStatusVoid:
		return "已作废"
	default:
		return status
	}
}

func itemStateLabel(state string) string {
	switch state {
	case "active":
		return "在架"
	case "removed":
		return "已下架"
	default:
		return ""
	}
}

// nameOrShortID 与 GET /v1/contributors 同一口径：缺昵称回退 id 前 8 位。
func nameOrShortID(name, id string) string {
	if name != "" {
		return name
	}
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// formatMillis 把毫秒时间戳格式化为本地时间；0 返回空串（未发生的事不渲染）。
func formatMillis(ms int64) string {
	if ms == 0 {
		return ""
	}
	return time.UnixMilli(ms).Local().Format("2006-01-02 15:04")
}
```

`import` 追加 `"time"` 与 `"github.com/johocn/base/internal/store"`。

- [ ] **Step 2: `web.go` 写 handler**

```go
// handleGovernancePage 渲染治理看板：服务端直接读库，**不调接口**（册子 §7.2）。
//
// 复用 governRoster() 而不是自己建集合，是为了继承它的降级口径：
// 派生失败按空名册继续渲染（票数自然为 0），页面提示「名册暂不可用」，与接口侧一致。
func (s *Server) handleGovernancePage(w http.ResponseWriter, r *http.Request) {
	roster, rosterOK := s.governRoster()
	views, err := s.st.ListProposalViews(roster)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// ProfileNames(nil)：空 ids = 全部（store/contributor.go）
	names, err := s.st.ProfileNames(nil)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	data := pageData{
		Title:           "治理看板",
		Issuer:          s.opt.Issuer,
		PairingCode:     s.opt.PairingCode,
		Fingerprint:     s.opt.FingerprintHex,
		RosterReady:     rosterOK,
		RemoveThreshold: store.GovernThreshold(store.GovernActionRemove),
		EditThreshold:   store.GovernThreshold(store.GovernActionEdit),
	}
	if contribs, err := s.st.ContributorRoster(); err == nil {
		for _, c := range contribs {
			data.Roster = append(data.Roster, pageContributor{ID: c.ID, Name: nameOrShortID(names[c.ID], c.ID), Count: c.Count})
		}
	}
	// ListProposalViews 按 proposal_id 升序（旧 → 新）返回；这里只做纯展示反转（新提案在前，册子 §7.4）
	for i := len(views) - 1; i >= 0; i-- {
		data.Proposals = append(data.Proposals, s.proposalPageRow(views[i], names))
	}
	s.renderPage(w, governanceTmpl, data)
}

// proposalPageRow 把一条提案视图折成看板行。**票数与门槛一律用 ListProposalViews 给的**，看板不自己算。
func (s *Server) proposalPageRow(v store.ProposalView, names map[string]string) pageProposal {
	row := pageProposal{
		Action:      v.Action,
		ActionLabel: governActionLabel(v.Action),
		ItemID:      v.ItemID,
		Title:       v.ItemID, // 缺条目或非公开时回退显示 item_id（册子 §7.3 护栏 1）
		Reason:      v.Reason,
		VoteCount:   len(v.Votes),
		Threshold:   v.Threshold,
		Status:      v.Status,
		StatusLabel: governStatusLabel(v.Status),
		CreatedAt:   formatMillis(v.CreatedAt),
	}
	if row.Threshold > 0 {
		row.Percent = row.VoteCount * 100 / row.Threshold
		if row.Percent > 100 {
			row.Percent = 100
		}
	}
	for _, id := range v.Votes {
		row.Voters = append(row.Voters, pageContributor{ID: id, Name: nameOrShortID(names[id], id)})
	}
	if v.Action == store.GovernActionEdit {
		row.Edit = &pageProposalEdit{Title: v.Title, BodyMD: v.BodyMD}
	}
	// 两条可见性护栏（册子 §7.3）：标题只在 public 时显示；链接只挂 active + public
	if it, ok, err := s.st.GetItem(v.ItemID); err == nil && ok {
		row.ItemState = it.State
		row.ItemStateLabel = itemStateLabel(it.State)
		if it.DistClass == "public" {
			row.Title = it.Title
			row.Linkable = it.State == "active"
		}
	}
	return row
}
```

- [ ] **Step 3: `server.go` 注册路由**

在 `publicMux()` 末尾，`GET /{$}` 与 `GET /a/{item_id...}` 旁边加一行：

```go
	mux.HandleFunc("GET /governance", s.handleGovernancePage)
```

（放在 `mux.HandleFunc("GET /{$}", s.handleIndex)` 之前）

- [ ] **Step 4: `web/templates/base.html` 追加看板样式**

在 `<style>` 末尾（`.pair code` 之后）追加：

```css
.board { list-style: none; padding: 0; margin: 0; }
.board li { padding: 14px 0; border-bottom: 1px solid #eee; }
.board h2 { font-size: 16px; margin: 0 0 4px; font-weight: 600; }
.badge { display: inline-block; font-size: 12px; color: #666; border: 1px solid #ddd; border-radius: 10px; padding: 0 8px; margin-right: 6px; }
.badge-on { color: #2b6cb0; border-color: #2b6cb0; }
.badge-off { color: #c53030; border-color: #c53030; }
.bar { height: 6px; background: #eee; border-radius: 3px; margin: 6px 0; }
.bar i { display: block; height: 6px; background: #2b6cb0; border-radius: 3px; }
.small { color: #888; font-size: 13px; }
details { margin-top: 6px; }
details pre { white-space: pre-wrap; font-family: inherit; background: #fafafa; padding: 8px; border-radius: 6px; }
```

- [ ] **Step 5: 写 `web/templates/governance.html`**

```html
{{define "content"}}
<h1>治理看板</h1>
<p class="small">
	下架 {{.RemoveThreshold}} 票、改写与复活各 {{.EditThreshold}} 票 · 票数按当前名册实时复判
	{{if not .RosterReady}}· 名册暂不可用，按空名册计{{end}}
</p>

{{if .Proposals}}
<ul class="board">
{{range .Proposals}}
	<li>
		<h2>
			<span class="badge">{{.ActionLabel}}</span>
			{{if .Linkable}}<a href="/a/{{.ItemID}}">{{.Title}}</a>{{else}}{{.Title}}{{end}}
			{{if .ItemStateLabel}}<span class="badge {{if eq .ItemState "removed"}}badge-off{{else}}badge-on{{end}}">{{.ItemStateLabel}}</span>{{end}}
		</h2>
		<div class="small">{{.Reason}}</div>
		<div class="bar"><i style="width:{{.Percent}}%"></i></div>
		<div class="small">{{.VoteCount}} / {{.Threshold}} 票 · {{.StatusLabel}} · {{.CreatedAt}}</div>
		{{if .Voters}}
		<div class="small">投票人：{{range $i, $v := .Voters}}{{if $i}}、{{end}}{{$v.Name}}{{end}}</div>
		{{end}}
		{{if .Edit}}
		<details>
			<summary class="small">拟改标题与正文</summary>
			<pre>{{.Edit.Title}}</pre>
			<pre>{{.Edit.BodyMD}}</pre>
		</details>
		{{end}}
	</li>
{{end}}
</ul>
{{else}}
<p>本节点暂无提案。</p>
{{end}}

<h2>贡献者名册</h2>
{{if .Roster}}
<ul class="board">
{{range .Roster}}
	<li>{{.Name}} · {{.Count}} 条 <span class="small">{{.ID}}</span></li>
{{end}}
</ul>
{{else}}
<p>暂无贡献者。</p>
{{end}}
{{end}}
```

- [ ] **Step 6: `web_test.go` 加三条测试**

```go
func TestGovernanceBoardRendersProposal(t *testing.T) {
	st, _, ts := newTestServer(t)
	if _, err := st.CreateProposal(store.Proposal{
		Action: store.GovernActionRemove, ItemID: "article/aaa", ProposerID: "proposer-1",
		Reason: "内容不准确", BaseContentHash: "deadbeef", CreatedAt: 1790000000000,
	}); err != nil {
		t.Fatalf("CreateProposal: %v", err)
	}

	code, body := getText(t, ts.URL+"/governance")
	if code != http.StatusOK {
		t.Fatalf("看板状态 = %d", code)
	}
	// 动作徽章 / 理由 / 门槛（remove 3 票）/ 状态 / 公开条目的文章页链接
	for _, want := range []string{"治理看板", "下架", "内容不准确", "0 / 3 票", "待决", `href="/a/article/aaa"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("看板缺少 %q\n页面内容：\n%s", want, body)
		}
	}
}

func TestGovernanceBoardHidesRemovedItemLink(t *testing.T) {
	st, _, ts := newTestServer(t)
	if err := st.RetireItem("article/aaa", 1); err != nil {
		t.Fatalf("RetireItem: %v", err)
	}
	if _, err := st.CreateProposal(store.Proposal{
		Action: store.GovernActionRemove, ItemID: "article/aaa", ProposerID: "proposer-1",
		Reason: "已下架", BaseContentHash: "deadbeef", CreatedAt: 1790000000000,
	}); err != nil {
		t.Fatalf("CreateProposal: %v", err)
	}

	code, body := getText(t, ts.URL+"/governance")
	if code != http.StatusOK {
		t.Fatalf("看板状态 = %d", code)
	}
	if !strings.Contains(body, "已下架") {
		t.Fatalf("下架条目应显示状态徽章\n%s", body)
	}
	// 护栏 2：handleArticlePage 对 removed 条目回 404，看板不能给死链
	if strings.Contains(body, `href="/a/article/aaa"`) {
		t.Fatalf("下架条目不应给文章页死链\n%s", body)
	}
}

func TestGovernanceBoardEmptyState(t *testing.T) {
	_, _, ts := newTestServer(t)
	code, body := getText(t, ts.URL+"/governance")
	if code != http.StatusOK {
		t.Fatalf("看板状态 = %d", code)
	}
	for _, want := range []string{"本节点暂无提案。", "暂无贡献者。"} {
		if !strings.Contains(body, want) {
			t.Fatalf("空态缺少 %q\n%s", want, body)
		}
	}
}
```

> `seedStore` 的文章没有 `author_id`，故名册为空、有效票为 0（门槛仍按动作取 3）。这正是空名册降级口径的可见证据。

- [ ] **Step 7: 自测**

Run（cwd `e:\code\base`）: `go build ./...`

Expected: 无输出

Run: `go vet ./...`

Expected: 无输出

Run: `go test ./internal/httpapi/ -run 'TestGovernance|TestIndex|TestArticlePage' -v`

Expected: 全绿（含既有公开页测试，确认没破坏它们）

Run: `go test ./...`

Expected: 全包 ok

- [ ] **Step 8: 提交**

```bash
git add internal/httpapi/web.go internal/httpapi/server.go internal/httpapi/web_test.go web/templates/governance.html web/templates/base.html
git commit -m "feat(node): 公开页只读治理看板 /governance（单列流水、门槛进度、两条可见性护栏）"
git push
```

---

### Task 8: tabBar 八个图标

**Files:**
- Create: `apps/mobile/src/static/tabbar/src/{course,circle,comment,mine}.svg`
- Create: `apps/mobile/src/static/tabbar/src/{course,circle,comment,mine}-on.svg`
- Create: `apps/mobile/src/static/tabbar/{course,circle,comment,mine}.png`
- Create: `apps/mobile/src/static/tabbar/{course,circle,comment,mine}-on.png`
- Modify: `apps/mobile/src/pages.json`

- [ ] **Step 1: 写 8 个 SVG 源文件**

内容**逐字**取自册子 §8.2（未选中，线性 `#888888`）与 §8.3（选中，填充 `#2b6cb0`）。4 个未选中文件各只有一处差异：`stroke="#888888"` + `fill="none"` + `stroke-width="1.5"`；4 个选中文件是 `fill="#2b6cb0"`，路径末端补 `z` 闭合。

- [ ] **Step 2: 光栅化成 81×81 透明 PNG**

本机无 svg 光栅化 CLI，但有全局 Playwright。写一个**临时脚本到系统临时目录**（不进仓库），用 `deviceScaleFactor: 3` 渲染 27×27 元素后截图：

```js
// %TEMP%\tabbar-export.js（用完即删，不入库）
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SRC = 'e:/code/base/apps/mobile/src/static/tabbar/src';
const OUT = 'e:/code/base/apps/mobile/src/static/tabbar';
const NAMES = ['course', 'circle', 'comment', 'mine', 'course-on', 'circle-on', 'comment-on', 'mine-on'];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 27, height: 27 }, deviceScaleFactor: 3 });
  for (const name of NAMES) {
    const svg = fs.readFileSync(path.join(SRC, `${name}.svg`), 'utf8');
    await page.setContent(`<body style="margin:0">${svg}</body>`);
    await page.locator('svg').screenshot({ path: path.join(OUT, `${name}.png`), omitBackground: true });
  }
  await browser.close();
})();
```

Run（PowerShell；`NODE_PATH` 指向全局 node_modules 才能 `require('playwright')`）：

```powershell
$env:NODE_PATH = (npm root -g)
node "$env:TEMP\tabbar-export.js"
```

退路（Playwright 不可用时依次尝试）：`npx --yes svgexport <in.svg> <out.png> 3x` → `npx --yes sharp-cli -i <in.svg> -o <out.png>`。任一方案都必须**透明底**。

- [ ] **Step 3: 核验尺寸与体积**

Run（cwd `e:\code\base\apps\mobile`）:

```powershell
Get-ChildItem src\static\tabbar\*.png | ForEach-Object {
  $b = [System.IO.File]::ReadAllBytes($_.FullName)
  $w = [int]$b[16]*16777216 + [int]$b[17]*65536 + [int]$b[18]*256 + [int]$b[19]
  $h = [int]$b[20]*16777216 + [int]$b[21]*65536 + [int]$b[22]*256 + [int]$b[23]
  "{0} {1}x{2} {3} bytes" -f $_.Name, $w, $h, $b.Length
}
```

Expected: 8 行全部 `81x81`，单张 ≤ 40KB（PNG 第 16–23 字节即 IHDR 的宽高）

- [ ] **Step 4: `pages.json` 挂上图标**

`tabBar.list` 四项各补两个键（**tab 项数量与文字不变**，`color` / `selectedColor` 沿用现值）：

```json
      { "pagePath": "pages/course/course", "text": "课程", "iconPath": "static/tabbar/course.png", "selectedIconPath": "static/tabbar/course-on.png" },
      { "pagePath": "pages/circle/circle", "text": "圈子", "iconPath": "static/tabbar/circle.png", "selectedIconPath": "static/tabbar/circle-on.png" },
      { "pagePath": "pages/comment/comment", "text": "评论", "iconPath": "static/tabbar/comment.png", "selectedIconPath": "static/tabbar/comment-on.png" },
      { "pagePath": "pages/mine/mine", "text": "我的", "iconPath": "static/tabbar/mine.png", "selectedIconPath": "static/tabbar/mine-on.png" }
```

- [ ] **Step 5: 自测**

Run（cwd `e:\code\base\apps\mobile`）: `npm run build:app`

Expected: 构建成功且 `dist/build/app` 下出现 `static/tabbar/*.png`（资源没被漏掉才算挂对）

- [ ] **Step 6: 提交**

```bash
git add apps/mobile/src/static/tabbar apps/mobile/src/pages.json
git commit -m "feat(mobile): tabBar 四图标（未选中线性 / 选中填充，81×81 PNG + SVG 源）"
git push
```

---

### Task 9: 版本 0.8.0、全量自测、发布与文档回填

**Files:**
- Modify: `apps/mobile/src/manifest.json`
- Modify: `docs/README.md`

- [ ] **Step 1: 改版本号**

`apps/mobile/src/manifest.json`：

```json
    "versionName" : "0.8.0",
    "versionCode" : "9",
```

- [ ] **Step 2: 全量自测（逐条执行，PowerShell 5.1 不支持 `&&`）**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run`

Expected: 全绿（15 文件 / 约 130 项）

Run: `npx tsc --noEmit`

Expected: 无输出

Run: `npm run build:app`

Expected: 构建成功

Run（cwd `e:\code\base`）: `go build ./...` 然后 `go vet ./...` 然后 `go test ./...`

Expected: 全包 ok

- [ ] **Step 3: 复核产物含新代码（防「版本号新、功能旧」）**

Run（cwd `e:\code\base\apps\mobile`）：

```powershell
$p = 'dist\build\app\app-service.js'
$t = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
foreach ($s in @('投稿','我的条目','提案与投票','我的贡献','已保存，联网后自动发送','tabbar/course.png')) {
  "{0}: {1}" -f $s, ($t.Contains($s))
}
```

Expected: 六项全部 `True`（必须用 `ReadAllText(..., UTF8)`——PowerShell 5.1 默认按 ANSI 读，中文会读成乱码而误报 False）

- [ ] **Step 4: 提交并推送**

```bash
git add apps/mobile/src/manifest.json
git commit -m "chore(mobile): 版本 0.8.0（创作与治理 UI）"
git push
```

- [x] **Step 5: 云打包**（CLI 桥接失效，改走 GUI，见「Task 9 Step 5–9 执行实况」）

Run（任意 cwd）:

```
D:\HBuilderX\cli.exe pack --project e:\code\base\apps\mobile --platform android --android.packagename uni.app.UNI936A667 --android.androidpacktype 3
```

Expected: 打印一个临时下载地址（5 次有效）。**必须自己下载并另存到** `e:\code\base\apps\mobile\dist\release\apk\base-0.8.0.apk`——CLI 不会落到该目录。

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri '<临时地址>' -OutFile 'e:\code\base\apps\mobile\dist\release\apk\base-0.8.0.apk'
```

（本地 `curl.exe` 会报 `getaddrinfo() thread failed`，用 `Invoke-WebRequest`）

- [x] **Step 6: 记录指纹并核对证书**

Run（cwd `e:\code\base\apps\mobile`）:

```
certutil -hashfile dist\release\apk\base-0.8.0.apk SHA256
D:\HBuilderX\plugins\amazon-corretto\bin\keytool.exe -printcert -jarfile dist\release\apk\base-0.8.0.apk
```

Expected: sha256 记下备用；证书 `SHA1: 19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`（与 0.7.0 一致，才可覆盖安装）。**只用 `keytool` 指纹判断证书**，不看 `CERT.RSA` 文件字节。

- [x] **Step 7: 上传 APK 并更新落地页**（实测改为整页重写后 `scp`：`sed` 单行替换不会更新版本号与更新说明，会留陈旧文案）

```bash
scp e:\code\base\apps\mobile\dist\release\apk\base-0.8.0.apk me:/opt/appdl/base-0.8.0.apk
ssh me "sed -i 's/base-0.7.0.apk/base-0.8.0.apk/g' /opt/appdl/index.html && grep -o 'base-0.[0-9.]*.apk' /opt/appdl/index.html"
```

Expected: `grep` 输出 `base-0.8.0.apk`

- [x] **Step 8: 签发升级文档**

`-notes` 必须是**不含空格的一个 token**（空格会被 Go flag 解析吃掉，导致后面的 `-out` 失效、文档落到源节点目录）：

```bash
ssh me "BASE_SIGN_KEY=37a6f57960600162228f272f0e33b062a9e5d06e33c218d932afb68c07feb0ce /opt/base/based release -version-name 0.8.0 -min-version-name 0.7.0 -apk-url http://118.190.217.242/dl/base-0.8.0.apk -apk-file /opt/appdl/base-0.8.0.apk -notes 创作与治理UI：投稿编辑器_我的条目_提案投票_治理看板 -out /opt/base-cache/data/release.json"
```

Expected: 打印 `version_name=0.8.0`、`apk_size`、`apk_sha256`；`apk_sha256` 与 Step 6 的本地指纹一致。

若误写了副本，清掉：`ssh me "rm -f /opt/base/data/release.json"`

- [x] **Step 9: 线上验证**（首跑 `/governance` 404，补做节点二进制部署后通过，见「更正 3」）

```bash
ssh me "curl -sS http://127.0.0.1/v1/release"
curl.exe -sSI http://118.190.217.242/dl/base-0.8.0.apk
```

Expected: `/v1/release` 返回 `version_name":"0.8.0"` 的文档；APK `200` 且 `Content-Length` 与文档 `apk_size` 一致；客户端 `verifyRelease(doc, '48c33db9cf859e107fe89651d15fc5faaa8b16ffbb7d4b483aa167a0cff824f4')` 为 `true`。

同时用 curl 确认看板已上线：`curl.exe -sS http://118.190.217.242/governance | Select-String '治理看板'` 命中。

- [x] **Step 10: `docs/README.md` 回填三处**

1. §3 文档清单末尾追加一行（编号顺延为 **30**）。**注意**：按仓库「任何新增文档必须先在此登记」惯例，本行已在计划产出时提前登记（状态「已出（待执行）」），故本步是**把该行状态改为「已执行（完整度见计划「执行实况」）」**，不要重复插入第二行；职责描述可按实际落地范围微调。规范内容如下：

```
| 30 | `plans/2026-09-28-base-creation-ui-plan.md` | 治理主线第 4 册实施计划（Task 1–9：本地台账 `my_submissions`、`question_json` 生成口径与本地校验、投稿编排（载荷·签名·直发/入队/补发）与错误码中文映射、投稿编辑器与我的条目页、提案与投票页 + 文章页治理入口、我的贡献页与「我的」页四行入口、节点只读看板 `/governance`、tabBar 八图标、0.8.0 发布与文档回填） | 不新增任何 HTTP 接口；不做视频投稿与块上传；不做课程/课时编排；不做评论改删与标签写入；不做离线投票与草稿暂存；不改 `author_sig` 签名域与内容包规范 v1；不改 #15 的四 tab 信息架构；不 bump `schema_version`、不加配置项 | 册子 #29 | 已执行（完整度见计划「执行实况」） |
```

2. §4 依赖顺序末两行改成：

```
治理主线（依赖 S1 身份与三载体课程体系）：
贡献度量与动态角色 (#23 → #24) ── 投稿写入 (#25 → #26) ─┬─ 审批治理（第 3 册：#27 册子 + #28 计划）
                                                       └─ 创作 UI（第 4 册：#29 册子 + #30 计划）
```

3. §5 的「待人工」「新增」「下一步」三条追加本册实况：待人工增加「#30 的真机验收（四页跳转、断网投稿补发、tabBar 八图标两态、`/governance` 看板手机浏览器可读）」；「下一步」把「并行可做 `#4` 手机本地加密 spike 册子」保留，并注明治理主线四册**已全部出册出计划**。

- [x] **Step 11: 提交文档回填**

```bash
git add docs/README.md
git commit -m "docs: 回写 #29 册子对应的 #30 计划与新版本实况"
git push
```

---

## 自检清单（写完计划后核过）

- [ ] 每个 Task 的**文件路径与导入路径**都与仓库现状逐字对过（`core/*` 一律从 `@base/protocol-ts` 顶层导入；`authorSignBytes` / `verifyAuthorSig` 已由 `packages/protocol-ts/src/index.ts` 的 `export * from "./author"` 导出）
- [ ] 每个 Task 用到的**共享 helper** 都在**最早使用它的 Task** 里定义：`json()` / `fixture()` / `registeredPub()` 在 Task 3 的 `submit.test.ts` 首次出现，Task 5 / Task 6 各自重新定义在本地（三个测试文件互不依赖）
- [ ] 线上契约逐字核对过：`POST /v1/submit` 请求体键名（`type`/`item_id`/`title`/`body_md`/`question_json`/`author_sig`，**不得带 `author_id`**）、`POST /v1/proposal` 返回 **201**、`POST /v1/proposal/{id}/vote` 请求体可为 `{}`、`POST /v1/profile` 体只有 `name`、`GET /v1/proposal` 按 `proposal_id` **升序**
- [ ] 节点侧没有新增接口、没有改 `tools/migrate`、没有 bump `schema_version`、没有加配置项
- [ ] 移动端没有改既有页面行为（`article.vue` 只加一个按钮；`mine.vue` 只加入口与提示）
- [ ] 每个 Task 都以「只 add 本 Task 文件」的提交 + push 收尾

## 执行期更正（实施后回填，后续 Task 请以本节为准）

（执行时在此追加：与计划的偏差、实测发现、口径更正。每条写清「计划怎么写的 / 实际怎么做的 / 为什么」。）

### 更正 1（Task 3）：`flushSubmissions` 的 `remaining` 口径

- **计划怎么写的**：Step 3 的 `runFlushSubmissions` 逐字抄了 `core/comment.ts` 的 `runFlush`——暂时失败分支写 `remaining += 1; error = msg; break;`；但同 Task 的测试又断言该场景下 `remaining: 3`。**代码与测试自相矛盾**（照抄实现即得 1，测试要 3）。
- **实际怎么做的**：改实现不改断言——暂时失败分支改为 `remaining = rows.length - sent - failed;`（`break` / `error = msg` 不动）。测试保持计划原文（`remaining: 3`）。
- **为什么**：`remaining` 不被任何页面消费（全仓 `*.vue` 无引用），其唯一显式契约就是那条测试；字段名与测试名（「暂时失败即中止本轮」）表达的语义都是「还剩几条待发」，故以测试为准。`comment.ts` 的 `remaining += 1` 是同名口径的既有瑕疵，**属别册范围，本册不碰**——差异在此登记，不静默分裂。
- **附带**：`submit.test.ts` 从 `@base/protocol-ts` 的导入里删掉了未使用的 `verify`（计划脚注已授权，`tsc` 会报未使用）。
- **实测计数**：`npx vitest run` = **14 文件 / 130 项全绿**（基线 112 + Task 2 的 7 + Task 3 的 11 = 130；计划里若写 131 属预估误差）。

### 更正 2（Task 9 Step 3）：产物复核的第六项落在配置包，不在 `app-service.js`

- **计划怎么写的**：Step 3 让在 `dist\build\app\app-service.js` 里核对六个特征串，其中包含 `tabbar/course.png`，并期望六项全 `True`。
- **实际怎么做的**：前五项（`投稿` / `我的条目` / `提案与投票` / `我的贡献` / `已保存，联网后自动发送`）均为 `True`；第六项 `tabbar/course.png` 在 `app-service.js` 为 **`False`**——已核实是**包归属问题，不是构建缺陷**：`app-service.js` 全文不含 `tabbar` 字样，tabBar 配置被 uni-app 编译进 **`app-config-service.js`** 与 **`manifest.json`**，这两者用同一 `ReadAllText(..., UTF8)` 读法均为 `True`；而且图标实体 `dist\build\app\static\tabbar\course.png` 确实存在。
- **为什么**：`pages.json` 的 `tabBar` 属**应用级配置**，本就编到配置包而非页面逻辑包。Step 3 的第六项期望写偏了，功能完整。
- **后续核对口径**：要连图标一起校验时，改查 `app-config-service.js` / `manifest.json`，或直接 `Test-Path dist\build\app\static\tabbar\course.png`。
- **附带（全量自测实际计数）**：`npx vitest run` = **16 文件 / 142 项全绿**；`npx tsc --noEmit` 无输出；`npm run build:app` 成功；`go build ./...` / `go vet ./...` / `go test ./...` 全包 ok。（计划 Step 2 写的「15 文件 / 约 130 项」是旧预估，以实际为准。）

### 更正 3（Task 9 Step 9）：计划漏了「部署节点二进制」，`/governance` 首跑 404

- **计划怎么写的**：Step 6–9 只覆盖 APK 指纹核对 / 上传 / 改落地页 / 签发 `release.json` / 线上验证；Step 9 直接断言 `curl http://118.190.217.242/governance` 能命中「治理看板」，**没有列出任何部署节点二进制的步骤**。
- **实际怎么做的**：Step 9 首跑 `/governance` 返回 **404**。查明：nginx `location /` 的 `proxy_pass` 是 `http://127.0.0.1:8083`（缓存节点 `base-cache.service`），`location /dl/` 才指 8080 的 appdl 静态页；而线上两个节点二进制 `/opt/base/based`（源节点，443/8081）与 `/opt/base-cache/based`（缓存节点，8082/8083）**都是 2026-09-27 20:22 编译的旧版**，不含 Task 7（`bcb2d99`）新增的看板路由。遂本地交叉编译 `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o based ./cmd/based`，scp 到 `/opt/base/based.new` 与 `/opt/base-cache/based.new`，各 `cp -p` 备份为 `based.bak-0.8.0-deploy` 后替换，再依次 `systemctl restart base` / `systemctl restart base-cache`。
- **为什么**：看板是节点**服务端渲染**（Task 7 的服务端路由 + 模板），不部署新二进制就永远 404。Step 9 的验收项隐含了「节点已升级到本册代码」，计划把这步漏了——属计划缺陷，不是代码缺陷（`web_test.go` 的 `TestGovernanceBoard*` 早已 PASS）。
- **取证**：源节点 `curl -sk https://127.0.0.1:443/governance` = **200**；缓存节点 `curl http://127.0.0.1:8083/governance` = **200**；公网 `http://118.190.217.242/governance` = **200** 且含 `<title>治理看板</title>` 与 `<h1>治理看板</h1>`。两个节点页面均显示「本节点暂无提案 / 暂无贡献者」空态——**确属线上还没有提案与贡献者**（两节点输出一致，非路由串味或部署残缺），`/v1/release` 仍 200、`/governance` 与升级链路互不影响。
- **回滚**：`mv /opt/base/based.bak-0.8.0-deploy /opt/base/based && systemctl restart base`（缓存节点把路径换成 `/opt/base-cache/` 同理）。注意 `base-cache.service` 的 `ExecStart` 指的是 `/opt/base/based`（不是 `/opt/base-cache/based`），故**两个服务共用同一二进制**，回滚要一起回。
- **后续口径**：本册之后凡改节点侧代码（路由/模板/契约），发布清单必须含「交叉编译 + 两个节点各备份替换 + 依次 restart + 逐个探活」这一步。

## 执行实况（实施后回填）

**执行方式**：子代理驱动——每个 Task 派发一个全新子代理执行，Task 之间做两阶段复核（① 对册子核「做了什么 / 有没有少」；② 对代码核「写的与计划是否一致」）；每个 Task 只 `git add` 自身文件后提交 + 推送。全程未触碰工作区里 `.gitignore` 的既有未提交改动。

| Task | 内容 | commit | 实测结论 |
|---|---|---|---|
| 1 | 本地台账 `my_submissions`（表 + 索引 + 6 读写方法） | `e508001` | `tsc --noEmit` 干净；vitest 12 文件 / 112 项全绿（未加测试，不回归） |
| 2 | `quizdoc.ts` + `quizdoc.test.ts` | `bfcf8c4` | 7 用例全绿；`tsc` 干净 |
| 3 | `errors.ts` + `submit.ts` + `submit.test.ts` + `identity.ts` 的 `peekLocalIdentity` | `35673df` | 11 用例全绿；全量 14 文件 / 130 项；`tsc` 干净（另见「更正 1」） |
| 4 | `submit.vue` + `myitems.vue` + `pages.json` 两条路由 | `0cba1cf` | 全量 14 文件 / 130 项；`tsc` 干净；`build:h5` 通过 |
| 5 | `govern.ts` + `govern.test.ts` + `governance.vue` + `article.vue` 治理入口 | `b32cfb8` | 7 用例全绿；全量 15 文件 / 137 项；`build:h5` 通过 |
| 6 | `contribution.ts` + `contribution.test.ts` + `contribution.vue` + `mine.vue` 两组四行 | `69d0709` | 5 用例全绿；全量 16 文件 / 142 项；`build:h5` 通过 |
| 7 | Go 看板 `web.go` / `server.go` / `base.html` / `governance.html` / `web_test.go` | `bcb2d99` | `go build` / `go vet` / `go test ./...` 全包 ok；`TestGovernanceBoard*` 三条实跑 PASS |
| 8 | tabBar 八图标（8 SVG 源 + 8 个 81×81 RGBA 透明 PNG）+ `pages.json` 挂载 | `a9bb841` | 8 个 PNG 逐个核 IHDR = 81×81 / colorType=6；`build:h5` + `build:app` 通过、图标随包拷贝 |
| 9 | 版本 `0.8.0` / `9` + 全量自测 + 产物复核 | `8115e6a` | vitest 16 文件 / 142 项全绿；`tsc` 干净；`build:app` 通过；`go build`/`vet`/`test ./...` 全包 ok；产物复核见「更正 2」 |

**文档提交**：`7588d26`（计划 #30 落盘 + README 登记第 30 行）、`ce8dad9`（更正 1）、`fcf6fd7`（更正 2 + README 状态回填）、本次提交（更正 3 + 发布实况 + README 0.8.0 上线回填）。

### Task 9 Step 5–9 执行实况（0.8.0 发布，已全部完成）

**Step 5（云打包）**：CLI 路径不可用（`D:\HBuilderX\cli.exe` 任何子命令均返回「与主程序的连接已中断」，日志有 `last session is crashed!` / `plugin-manager/out.js exit with code 10001` / `QWindowsPipeWriter: asynchronous write failed`，详见下文「CLI 失效取证」）。改由用户在 **HBuilderX GUI**「发行 → 原生App-云打包」完成（Android / 包名 `uni.app.UNI936A667` / 自有证书），03:18:28 打包成功并给出临时下载地址（5 次有效）。

**Step 6（指纹与证书）**：临时地址下载另存为 `apps\mobile\dist\release\apk\base-0.8.0.apk`，**27403827 字节**。`certutil -hashfile ... SHA256` = `c01dd19cba9bcefb2e05cb8d6d023b527792ace029069f3caf3898a71a2ae123`；`keytool -printcert -jarfile` 的 **SHA1 = `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`**（与 0.7.0 / 0.6.0 一致 ⇒ 可覆盖安装）。**注意**：本地 `curl.exe` 下载报 `getaddrinfo() thread failed to start`，必须改用 `Invoke-WebRequest`（计划 Step 5 已预置该写法）。

**Step 7（上传 + 落地页）**：`scp` 上传至 `/opt/appdl/base-0.8.0.apk`，远端 `sha256sum` 与本地一致。落地页**未**按计划的 `sed` 单行替换，而是整页重写后 `scp` 覆盖——计划那条 `sed 's/base-0.7.0.apk/base-0.8.0.apk/'` 只换 APK 文件名，会留下「版本 0.4.1（versionCode 5）」的陈旧文案与过期更新说明。重写后第 27 行为 `./base-0.8.0.apk`、版本行改为「版本 0.8.0（versionCode 9）· 2026-09-29 · 创作与治理 UI：投稿编辑器、我的条目、提案投票、治理看板」。实测 `curl http://127.0.0.1/dl/index.html` 输出 `base-0.8.0.apk` / `versionCode 9`。

**Step 8（签发升级文档）**：`-out /opt/base-cache/data/release.json`（**必须是缓存节点数据目录**——nginx `/` 的后端是 8083 缓存节点，计划此处写对了）。输出 `version_name=0.8.0 min_version_name=0.7.0`、`apk_size=27403827`、`apk_sha256=c01dd19c…a2ae123`（与 Step 6 逐字一致）、`public_key=48c33db9cf859e107fe89651d15fc5faaa8b16ffbb7d4b483aa167a0cff824f4`。`-notes` 用不含空格的单 token（`_` 分隔）。

**Step 9（线上验证）**：全部通过——① `GET /v1/release` 返回 `version_name":"0.8.0"` 的文档；② `HEAD http://118.190.217.242/dl/base-0.8.0.apk` = **200** 且 `Content-Length: 27403827` == `apk_size`；③ 客户端 `verifyRelease(doc, '48c33db9…')` = **true**（用 `npx tsx` 直跑 `packages/protocol-ts/src/release.ts`，临时脚本用后即删）；④ `curl http://118.190.217.242/governance` = 200 且含「治理看板」。④ 首跑为 404，原因与处置见「更正 3」（补做节点二进制交叉编译与部署）。

**Step 5–9 的 CLI 失效取证（留档备查）**：`cli.exe --version` 需先 `cli open` 才可用（报 5.24.2026081301）；任何 `pack` 调用必崩——CLI 侧「与主程序的连接已中断」，主程序侧 `QWindowsPipeWriter: asynchronous write failed` + `plugin-manager/out.js exit with code 10001`，且会连带把 HBuilderX 主程序进程换掉（20644 → 15692）。现行可用路径只有 **GUI 云打包**。


### 待人工验收（真机）

- 四页跳转：`我的` → 新建投稿 / 我的条目 / 提案与投票 / 我的贡献
- 断网投稿入队后联网自动补发（仅一条、不重复）
- tabBar 八图标两态显示正确（未选中线性灰、选中填充蓝）
- `/governance` 看板在手机浏览器可读
- 投稿编辑器「新建 / 重投更新」双模式（更新模式载体与 id 不可改）