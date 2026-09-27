# 评论离线发表队列与在线拉取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 断网也能写评论——离线发表入本地队列、进评论页自动补发、永久失败可见可删；同时把自检探测 10 的判定改为「网络不可达 = skip」，否则离线入队会被自检自己禁掉。

**Architecture:** 纯客户端。新增本地表 `comment_out`（`CREATE TABLE IF NOT EXISTS` 随 `bootstrap()` 自动补表，无迁移代码）与 `LocalRepo` 4 个方法；`core/comment.ts` 拆出纯发送 `sendComment`（自检探针与补发共用）与补发编排 `flushPending`，`postComment` 只在 `CommentError.code === 'network'` 且已配置节点时入队；`pages/comment/comment.vue` 加待发区与「立即补发」。节点侧零改动。

**Tech Stack:** uni-app（Vue 3 + TS）、plus.sqlite、vitest（node 环境）、`core/fakes.ts` 假适配器、`@base/protocol-ts`。

**上游 spec:** `docs/superpowers/specs/2026-09-28-base-comment-offline-queue-design.md`（本计划是它的实现展开，冲突时以 spec 为准）

**基线:** 移动端 85 项单测全绿（`npx vitest run`）；`protocol-ts` 51 项独立，本册子不动。

---

## 文件结构

| 路径 | 动作 | 职责 |
| --- | --- | --- |
| `apps/mobile/src/core/types.ts` | 修改 | 新增 `CommentOutRow`（待发评论行） |
| `apps/mobile/src/core/repo.ts` | 修改 | `SCHEMA_SQL` 加 `comment_out` 表与索引；`LocalRepo` 加 4 方法；`SqlRepo` 实现 + `toCommentOutRow` |
| `apps/mobile/src/core/fakes.ts` | 修改 | `MemoryRepo` 实现同 4 方法（手写假件，`MemoryDb` 不动） |
| `apps/mobile/src/core/comment.ts` | 修改 | `CommentInput` / `PostResult` / `FlushResult`；私有 `buildCommentWire`；`sendComment`（纯发送，支持重放）；`postComment` 离线兜底；`flushPending` + `isPermanentFailure` |
| `apps/mobile/src/core/comment.test.ts` | 修改 | spec §8 用例 1–9；改造既有「登记时断网」用例（断网行为由抛错改为入队） |
| `apps/mobile/src/core/selfcheck.ts` | 修改 | 探测 10 改调 `sendComment`，网络不可达抛 `ProbeSkip` |
| `apps/mobile/src/core/selfcheck.test.ts` | 修改 | 既有用例 2 改判 `skip`；新增用例 11（节点明确拒绝 → `fail`） |
| `apps/mobile/src/pages/comment/comment.vue` | 修改 | 待发区、失败项删除、「立即补发」、离线提示、composer 未配置禁用、`onShow` 补发编排 |
| `apps/mobile/src/manifest.json` | 修改 | `versionName 0.6.0` / `versionCode 7` |

约定：除非特别注明，命令的工作目录都是 `e:\code\base\apps\mobile`；git 与部署命令的工作目录是 `e:\code\base`。

**本机环境（0.5.0 册子踩过的坑，照做）**：PowerShell 5.1 **不支持 `&&`**，多条命令拆行执行；`git` 前先 `$env:Path += ";C:\Program Files\Git\cmd"`；`ssh` 远程命令里不要用双引号。

---

### Task 1: 本地队列表与 `LocalRepo` 新方法

**Files:**
- Modify: `apps/mobile/src/core/types.ts`
- Modify: `apps/mobile/src/core/repo.ts`
- Modify: `apps/mobile/src/core/fakes.ts`

本任务只加数据面（表 + 仓储方法 + 测试假件），行为由 Task 2/3 的用例覆盖；本步验证是类型检查与不回归。

- [ ] **Step 1: `types.ts` 末尾追加 `CommentOutRow`**

在 `apps/mobile/src/core/types.ts` 末尾（`QuestionDoc` 之后）追加：

```ts
/**
 * 待发评论（本地 `comment_out` 表，本册 §3.1）。
 * `wire` 是**已签名的完整请求体文本**：`event_id` / `created_at` / `sig` 全部冻结在内，
 * 补发时逐字节重放（`sig` 覆盖的是 canonical 出来的确定字节序，重排即失效）。
 */
export interface CommentOutRow {
  eventId: string;
  targetId: string;
  text: string;
  replyTo: string | null;
  wire: string;
  state: 'pending' | 'failed';
  /** state='failed' 时的用户可读原因 */
  reason: string | null;
  /** 入队时刻 ISO8601，排序用 */
  queuedAt: string;
}
```

- [ ] **Step 2: `repo.ts` 加建表语句**

把 `apps/mobile/src/core/repo.ts` 顶部的类型 import 改成：

```ts
import type { ArticleRow, CommentOutRow, FavoriteRow, ItemRow, LearningStats, QuizRow, TombstoneRow } from './types';
```

把 `SCHEMA_SQL` 数组的最后一项（`quiz_attempt` 那条）之后追加两项，即数组结尾变成：

```ts
  `CREATE TABLE IF NOT EXISTS quiz_attempt(
     item_id TEXT NOT NULL, answered_at TEXT NOT NULL, correct INTEGER NOT NULL, total INTEGER NOT NULL,
     PRIMARY KEY(item_id, answered_at))`,
  `CREATE TABLE IF NOT EXISTS comment_out(
     event_id TEXT PRIMARY KEY, target_id TEXT NOT NULL, text TEXT NOT NULL, reply_to TEXT,
     wire TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, queued_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_comment_out_queued ON comment_out(queued_at)`,
];
```

**迁移说明**：`bootstrap()` 每次启动逐条执行全部 `SCHEMA_SQL`（`platform/index.ts:29`），新表靠 `CREATE TABLE IF NOT EXISTS` 自动补上——这是**新增表**而非给旧表加列，故不需要列存在性检查。

- [ ] **Step 3: `repo.ts` 的 `LocalRepo` 接口加 4 个方法**

在 `apps/mobile/src/core/repo.ts` 的 `LocalRepo` 接口里、`learningStats(): Promise<LearningStats>;` 之后追加：

```ts
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
```

- [ ] **Step 4: `SqlRepo` 实现这 4 个方法**

在 `apps/mobile/src/core/repo.ts` 的 `SqlRepo` 类里、`learningStats()` 方法之后（类的收尾 `}` 之前）追加：

```ts
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
```

并在 `apps/mobile/src/core/repo.ts` 末尾、`toArticleRow` 之后追加：

```ts
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
```

- [ ] **Step 5: `MemoryRepo` 同步实现（`fakes.ts`）**

把 `apps/mobile/src/core/fakes.ts` 顶部的类型 import 改成（补 `CommentOutRow`）：

```ts
import type { ArticleRow, CommentOutRow, FavoriteRow, ItemRow, LearningStats, QuizRow, TombstoneRow } from './types';
```

在 `MemoryRepo` 类里、`learningStats()` 方法之后（类的收尾 `}` 之前）追加：

```ts
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
```

**不要给 `MemoryDb` 加任何 SQL 支持**：它是自检探测的假件；评论测试走 `MemoryRepo`，不经过 `MemoryDb` 的 SQL 解析。

- [ ] **Step 6: 类型检查**

Run（cwd `e:\code\base\apps\mobile`）: `npx tsc --noEmit`

Expected: 无输出（`SqlRepo` 与 `MemoryRepo` 都完整实现了 `LocalRepo`）

- [ ] **Step 7: 跑既有测试确认没回归**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run`

Expected: 全绿（既有 85 项）

- [ ] **Step 8: 提交**

```bash
git add apps/mobile/src/core/types.ts apps/mobile/src/core/repo.ts apps/mobile/src/core/fakes.ts
git commit -m "feat(mobile): 本地待发评论表 comment_out 与 LocalRepo 四方法（离线队列 spec §3）"
```

---

### Task 2: `sendComment` 拆分与 `postComment` 离线兜底

**Files:**
- Modify: `apps/mobile/src/core/comment.ts:152-193`
- Test: `apps/mobile/src/core/comment.test.ts`

**实现期细化（与 spec §4.1/§4.3 的差异，必须照本计划写）**：spec §4.3 的补发调用写的是 `sendComment(o, { targetId, text, replyTo })`，但 spec §3.1 与 §8 用例 5 要求补发**逐字节重放入队时存的 wire**（`sig` 不得重算）。二者靠给 `CommentInput` 加两个可选字段 `wire` / `eventId` 统一：传了即重放，不传即本地构造。`postComment` 与探针走「不传」，补发走「传」。

- [ ] **Step 1: 写失败的测试**

把 `apps/mobile/src/core/comment.test.ts` 的 import 段改成（补 `flushPending` / `sendComment` / `CommentOutRow` 相关不需要单独 import）：

```ts
import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import {
  IDENTITY_REGISTERED_KEY,
  CommentError,
  ensureRegistered,
  fetchCommentText,
  flushPending,
  listComments,
  postComment,
  sendComment,
  setPendingTarget,
  takePendingTarget,
  type CommentOptions,
} from './comment';
import { decodeUtf8 } from './sync';
```

在 `fixture()` 之后追加一个可开关的断网模拟器：

```ts
/**
 * 可开关的「网络不可达」模拟：只让 `POST /v1/event` 抛错，其余请求照常走路由。
 * `offline=true` 时失败尝试也会记进 `posted`，便于断言「只试了一条」（用例 7）。
 */
function gatePost(http: FakeHttp): { offline: boolean } {
  const real = http.post.bind(http);
  const state = { offline: true };
  http.post = async (url, body, headers) => {
    if (state.offline && url.endsWith('/v1/event')) {
      http.posted.push({ url, body, headers: headers ?? {} });
      throw new Error('断网');
    }
    return real(url, body, headers);
  };
  return state;
}
```

把既有用例「**失败映射**」尾部的「登记时断网」一段：

```ts
    // 登记时断网
    const off = fixture();
    off.o.adapters.http = {
      get: () => Promise.reject(new Error('断网')),
      post: () => Promise.reject(new Error('断网')),
    };
    const netErr = (await postComment(off.o, { targetId: 'article/a', text: 'x' }).catch((e: unknown) => e)) as CommentError;
    expect(netErr.code).toBe('network');
    expect(netErr.message).toBe('无法连接节点，请稍后重试');

    // 列表断网
    const listErr = (await listComments(off.o).catch((e: unknown) => e)) as CommentError;
    expect(listErr.code).toBe('network');
```

换成：

```ts
    // 登记时断网：不再抛错，改为离线入队（本册 §4.2）
    const off = fixture();
    off.o.adapters.http = {
      get: () => Promise.reject(new Error('断网')),
      post: () => Promise.reject(new Error('断网')),
    };
    const offRes = await postComment(off.o, { targetId: 'article/a', text: 'x' });
    expect(offRes.queued).toBe(true);
    expect(offRes.payloadCid).toBeNull();
    expect(await off.repo.listCommentOut()).toHaveLength(1);

    // 列表断网仍抛 CommentError（读取没有离线兜底）
    const listErr = (await listComments(off.o).catch((e: unknown) => e)) as CommentError;
    expect(listErr.code).toBe('network');
```

在同文件末尾（`describe('comment', ...)` 之后）追加新的 describe 与用例 1–4，以及 `sendComment` 的纯度用例：

```ts
describe('离线发表入队', () => {
  it('用例 1：离线发表入队，字段与入参一致', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const gate = gatePost(http);
    gate.offline = true;

    const res = await postComment(o, { targetId: 'article/a', text: '离线写的', replyTo: 'a'.repeat(32) });

    expect(res.queued).toBe(true);
    expect(res.payloadCid).toBeNull();
    const rows = await repo.listCommentOut();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetId).toBe('article/a');
    expect(rows[0]!.text).toBe('离线写的');
    expect(rows[0]!.replyTo).toBe('a'.repeat(32));
    expect(rows[0]!.state).toBe('pending');
    expect(rows[0]!.reason).toBeNull();
    expect(rows[0]!.eventId).toHaveLength(32);
    // wire 是已签名的完整请求体：内容签名与 event_id 都在里面
    expect(rows[0]!.wire).toContain('"type":"comment.v1"');
    expect(rows[0]!.wire).toContain('"sig"');
    expect(JSON.parse(rows[0]!.wire).event_id).toBe(rows[0]!.eventId);
  });

  it('用例 2：在线发表不入队', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({ payload_cid: 'cid1' }));
    const gate = gatePost(http);
    gate.offline = false;

    const res = await postComment(o, { targetId: 'article/a', text: '在线的' });

    expect(res.queued).toBe(false);
    expect(res.payloadCid).toBe('cid1');
    expect(await repo.listCommentOut()).toEqual([]);
  });

  it('用例 3：节点明确拒绝不入队（原文留给页面原地重试）', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, { status: 500, body: utf8('boom') });
    const gate = gatePost(http);
    gate.offline = false;

    const err = (await postComment(o, { targetId: 'article/a', text: 'x' }).catch((e: unknown) => e)) as CommentError;

    expect(err).toBeInstanceOf(CommentError);
    expect(err.code).toBe('server');
    expect(await repo.listCommentOut()).toEqual([]);
  });

  it('用例 4：未配置节点不入队', async () => {
    const { repo, o } = fixture();
    const err = (await postComment({ ...o, nodeBaseUrl: '' }, { targetId: 'article/a', text: 'x' }).catch(
      (e: unknown) => e,
    )) as CommentError;

    expect(err).toBeInstanceOf(CommentError);
    expect(err.code).toBe('client');
    expect(await repo.listCommentOut()).toEqual([]);
  });

  it('sendComment 是纯发送：断网抛 network，绝不入队（探针与补发共用它）', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const gate = gatePost(http);
    gate.offline = true;

    const err = (await sendComment(o, { targetId: 'article/a', text: 'x' }).catch((e: unknown) => e)) as CommentError;

    expect(err).toBeInstanceOf(CommentError);
    expect(err.code).toBe('network');
    expect(err.message).toBe('无法连接节点，请稍后重试');
    expect(await repo.listCommentOut()).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run src/core/comment.test.ts`

Expected: FAIL —— `does not provide an export named 'sendComment'`（或同类报错），且「登记时断网」改后的断言不通过。

- [ ] **Step 3: 写实现**

在 `apps/mobile/src/core/comment.ts` 的 `CommentErrorCode` 类型之后追加新类型：

```ts
/** 一条评论的入参。`wire` / `eventId` 只在补发时传入（逐字节重放冻结的请求体，本册 §3.1）。 */
export interface CommentInput {
  targetId: string;
  text: string;
  replyTo?: string;
  wire?: string;
  eventId?: string;
}

/** `postComment` 的结果。`queued=true` 即已落本地待发队列（本册 §4.2）。 */
export interface PostResult {
  eventId: string;
  payloadCid: string | null;
  queued: boolean;
}

/** `flushPending` 的结果。**只经返回值体现，绝不抛错**（本册 §4.3）。 */
export interface FlushResult {
  sent: number;
  failed: number;
  remaining: number;
  error: string;
}
```

把 `apps/mobile/src/core/comment.ts` 里从 `/** 发表一条评论：内容签名（归属）+ 请求签名头（准入）都要带。 */` 开始的整个 `postComment` 函数（原 152–193 行）替换成下面 4 段：

```ts
/**
 * 本地构造一条评论事件：`event_id` / `created_at` / 内容签名都在这里冻结。
 * `sig` 覆盖 `canonical({event_id,type,created_at,body})`，与请求头无关：事件搬到别的节点仍可独立验签。
 */
function buildCommentWire(ident: Identity, input: CommentInput): { eventId: string; wire: string } {
  const eventId = bytesToHex(randomBytes(16));
  const inner: Json = { target_id: input.targetId, text: input.text };
  if (input.replyTo) (inner as Record<string, Json>).reply_to = input.replyTo;
  const payload: Json = { event_id: eventId, type: 'comment.v1', created_at: Date.now(), body: inner };
  const sig = sign(ident.seedHex, utf8(canonicalize(payload)));
  return { eventId, wire: utf8(JSON.stringify({ ...(payload as Record<string, Json>), sig })) };
}
```

```ts
/**
 * 直接发送一条评论：登记 →（构造）→ 带签名头 POST `/v1/event`。失败抛 `CommentError`，**不落本地队列**。
 *
 * 传 `input.wire` 即逐字节重放该请求体（补发路径）：内容签名与 `event_id` 冻结在 wire 内，
 * 请求签名头每轮新算（`ts` 本就一次性、`nonce` 会被节点去重）。
 * 本函数是**补发与自检探针共用的唯一发送入口**。
 */
export async function sendComment(
  o: CommentOptions,
  input: CommentInput,
): Promise<{ eventId: string; payloadCid: string }> {
  const ident = await ensureRegistered(o);

  let eventId: string;
  let wire: string;
  if (input.wire !== undefined && input.eventId !== undefined) {
    eventId = input.eventId;
    wire = input.wire;
  } else {
    const built = localStep('构造请求', () => buildCommentWire(ident, input));
    eventId = built.eventId;
    wire = built.wire;
  }

  const bytes = localStep('编码请求', () => utf8(wire));
  const headers = localStep('签名请求', () =>
    signRequestHeaders(ident, { method: 'POST', path: '/v1/event', body: bytes }),
  );

  let res;
  try {
    res = await o.adapters.http.post(`${o.nodeBaseUrl}/v1/event`, bytes, {
      'Content-Type': 'application/json',
      ...headers,
    });
  } catch {
    throw new CommentError('network', '无法连接节点，请稍后重试');
  }
  if (res.status === 200) {
    const out = localStep('解析响应', () => JSON.parse(decodeUtf8(res.body)) as { event_id?: string; payload_cid?: string });
    return { eventId: String(out.event_id ?? eventId), payloadCid: String(out.payload_cid ?? '') };
  }
  throw mapPostFailure(res.status, decodeUtf8(res.body));
}
```

```ts
/**
 * 发表一条评论：正常走 `sendComment`；**只有网络不可达**才入本地待发队列（本册 §4.2）。
 *
 * 节点给了任何 HTTP 响应（4xx / 5xx）都不入队——用户就在页面上、草稿还在输入框里，
 * 立即原地重试比静默入队清楚。未配置节点同样不入队（否则队列会变成永远发不出去的垃圾桶）。
 */
export async function postComment(o: CommentOptions, input: CommentInput): Promise<PostResult> {
  if (o.nodeBaseUrl === '') throw new CommentError('client', '未配置节点地址，无法发表');

  try {
    const r = await sendComment(o, input);
    return { eventId: r.eventId, payloadCid: r.payloadCid, queued: false };
  } catch (e) {
    if (e instanceof CommentError && e.code === 'network') {
      // 身份生成本地可用、不需要节点，故断网时仍能冻结一条合法 wire 入队
      const ident = await localStepAsync('身份准备', () => localIdentity(o));
      const { eventId, wire } = localStep('构造请求', () => buildCommentWire(ident, input));
      await o.repo.enqueueComment({
        eventId,
        targetId: input.targetId,
        text: input.text,
        replyTo: input.replyTo ?? null,
        wire,
        state: 'pending',
        reason: null,
        queuedAt: new Date().toISOString(),
      });
      return { eventId, payloadCid: null, queued: true };
    }
    throw e;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run src/core/comment.test.ts`

Expected: PASS（既有 7 项 + 新增 5 项 = 12 项）

- [ ] **Step 5: 类型检查**

Run（cwd `e:\code\base\apps\mobile`）: `npx tsc --noEmit`

Expected: 无输出（注意：此步会因调用方未更新而报错，属正常——`selfcheck.ts` 与 `comment.vue` 分别在 Task 4 / Task 5 更新；若报错只应出现在这两处）

- [ ] **Step 6: 提交**

```bash
git add apps/mobile/src/core/comment.ts apps/mobile/src/core/comment.test.ts
git commit -m "feat(mobile): 拆出 sendComment、postComment 离线入队兜底（离线队列 spec §4.2）"
```

---

### Task 3: `flushPending` 补发编排与失败分类

**Files:**
- Modify: `apps/mobile/src/core/comment.ts`
- Modify: `apps/mobile/src/core/comment.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `apps/mobile/src/core/comment.test.ts` 末尾追加：

```ts
describe('flushPending', () => {
  it('用例 5：补发成功且逐字节重放入队时的 wire（sig 未被重算）', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({ payload_cid: 'cid' }));
    const gate = gatePost(http);
    gate.offline = true;
    await postComment(o, { targetId: 'article/a', text: '甲' });
    await postComment(o, { targetId: 'article/a', text: '乙', replyTo: 'b'.repeat(32) });
    const rows = await repo.listCommentOut();
    expect(rows).toHaveLength(2);

    gate.offline = false;
    http.posted.length = 0;
    const r = await flushPending(o);

    expect(r).toEqual({ sent: 2, failed: 0, remaining: 0, error: '' });
    expect(await repo.listCommentOut()).toEqual([]);
    const bodies = http.posted.filter((p) => p.url.endsWith('/v1/event')).map((p) => decodeUtf8(p.body));
    expect(bodies).toEqual(rows.map((x) => x.wire));
  });

  it('用例 6：补发永久失败标 failed、原文仍在、且不抛错', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({}));
    const gate = gatePost(http);
    gate.offline = true;
    await postComment(o, { targetId: 'article/a', text: '会被拒的' });

    gate.offline = false;
    http.postRoutes.set(`${BASE}/v1/event`, { status: 403, body: utf8(JSON.stringify({ code: 'event_sig_invalid' })) });
    const r = await flushPending(o);

    expect(r).toEqual({ sent: 0, failed: 1, remaining: 0, error: '' });
    const rows = await repo.listCommentOut();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('failed');
    expect(rows[0]!.reason).toContain('提交被拒绝');
    expect(rows[0]!.text).toBe('会被拒的');
  });

  it('用例 7：补发暂时失败即中止本轮（不空跑后续条目）', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({}));
    const gate = gatePost(http);
    gate.offline = true;
    await postComment(o, { targetId: 'article/a', text: '一' });
    await postComment(o, { targetId: 'article/a', text: '二' });
    await postComment(o, { targetId: 'article/a', text: '三' });

    http.posted.length = 0; // gate.offline 仍为 true
    const r = await flushPending(o);

    expect(r.sent).toBe(0);
    expect(r.error).toBe('无法连接节点，请稍后重试');
    const rows = await repo.listCommentOut();
    expect(rows).toHaveLength(3);
    expect(rows.every((x) => x.state === 'pending')).toBe(true);
    expect(http.posted.filter((p) => p.url.endsWith('/v1/event'))).toHaveLength(1);
  });

  it('用例 8：并发调用只跑一轮（不重复发送）', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({}));
    const gate = gatePost(http);
    gate.offline = true;
    await postComment(o, { targetId: 'article/a', text: '一' });
    await postComment(o, { targetId: 'article/a', text: '二' });

    gate.offline = false;
    http.posted.length = 0;
    await Promise.all([flushPending(o), flushPending(o)]);

    expect(http.posted.filter((p) => p.url.endsWith('/v1/event'))).toHaveLength(2);
    expect(await repo.listCommentOut()).toEqual([]);
  });

  it('用例 9：listCommentOut 按入队时刻升序；删除一条即少一条', async () => {
    const { repo } = fixture();
    const row = (id: string, at: string) => ({
      eventId: id,
      targetId: 'article/a',
      text: id,
      replyTo: null,
      wire: '{}',
      state: 'pending' as const,
      reason: null,
      queuedAt: at,
    });
    await repo.enqueueComment(row('e2', '2026-09-28T00:00:02.000Z'));
    await repo.enqueueComment(row('e1', '2026-09-28T00:00:01.000Z'));

    expect((await repo.listCommentOut()).map((r) => r.eventId)).toEqual(['e1', 'e2']);
    await repo.removeCommentOut('e1');
    expect((await repo.listCommentOut()).map((r) => r.eventId)).toEqual(['e2']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run src/core/comment.test.ts`

Expected: FAIL —— `does not provide an export named 'flushPending'`

- [ ] **Step 3: 写实现**

在 `apps/mobile/src/core/comment.ts` 的 `postComment` 之后追加：

```ts
/** 永久失败：节点明确拒绝，重发无意义（本册 §5.2）。 */
function isPermanentFailure(e: unknown): boolean {
  return e instanceof CommentError && (e.code === 'revoked' || e.code === 'rejected');
}

/** 进行中的补发：并发调用复用同一轮（进页面与「立即补发」可能撞在一起）。 */
let inflightFlush: Promise<FlushResult> | null = null;

/**
 * 补发待发队列。**不抛错**：结果只经返回值体现，绝不打断调用方（上上册 §6.4 红线）。
 *
 * 逐条顺序补发；**暂时失败即中止本轮**——网络刚断或已被限速时后续条目必然同错，
 * 中止省掉一串无用请求，下次进页面继续。已 `failed` 的行永不自动重试，只能由用户删除。
 * **不读能力标志**：`writeOk` 只由用户主动跑自检更新，用它拦补发会让「节点已恢复但标志过期」永久卡死。
 */
export function flushPending(o: CommentOptions): Promise<FlushResult> {
  if (o.nodeBaseUrl === '') return Promise.resolve({ sent: 0, failed: 0, remaining: 0, error: '' });
  if (!inflightFlush) {
    inflightFlush = (async () => {
      try {
        return await runFlush(o);
      } finally {
        inflightFlush = null;
      }
    })();
  }
  return inflightFlush;
}

async function runFlush(o: CommentOptions): Promise<FlushResult> {
  const rows = (await o.repo.listCommentOut()).filter((r) => r.state === 'pending');
  let sent = 0;
  let failed = 0;
  let remaining = 0;
  let error = '';
  for (const row of rows) {
    try {
      await sendComment(o, {
        targetId: row.targetId,
        text: row.text,
        replyTo: row.replyTo ?? undefined,
        wire: row.wire,
        eventId: row.eventId,
      });
      await o.repo.removeCommentOut(row.eventId);
      sent += 1;
    } catch (e) {
      const msg = e instanceof CommentError ? e.message : `补发失败：${(e as Error).message ?? String(e)}`;
      if (isPermanentFailure(e)) {
        await o.repo.markCommentOutFailed(row.eventId, msg);
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

- [ ] **Step 4: 跑测试确认通过**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run src/core/comment.test.ts`

Expected: PASS（17 项）

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/core/comment.ts apps/mobile/src/core/comment.test.ts
git commit -m "feat(mobile): flushPending 顺序补发、暂时失败中止本轮、永久失败标记（离线队列 spec §4.3/§5）"
```

---

### Task 4: 自检探测 10 的判定口径修正

**Files:**
- Modify: `apps/mobile/src/core/selfcheck.ts:11,286-302`
- Modify: `apps/mobile/src/core/selfcheck.test.ts:134-145`

**为什么必须改**：离线跑自检 → 探测 10 失败 → `writeOk='fail'` → 评论页发表按钮被禁用 → 本册子的离线入队直接被自己禁掉。改后：网络不可达判 `skip`（不计入标志 → `writeOk` 保持 `unknown` → 不降级 → 发表可用）。

- [ ] **Step 1: 改测试**

把 `apps/mobile/src/core/selfcheck.test.ts` 里的既有用例 2：

```ts
  it('用例 2：只坏一条时仅第 10 条 fail，writeOk 跟着降级', async () => {
    const env = makeEnv({ withPack: true });
    env.http.post = async () => {
      throw new Error('网络不可达');
    };
    const r = await runSelfCheck(env.ctx, { plus: FAKE_PLUS });

    const bad = r.items.filter((i) => i.status === 'fail');
    expect(bad.map((i) => i.id)).toEqual(['net.event_write']);
    expect(bad[0]?.detail).toContain('无法连接节点');
    expect(r.flags).toEqual({ cryptoOk: 'ok', fsOk: 'ok', dbOk: 'ok', writeOk: 'fail' });
  });
```

换成下面两条：

```ts
  it('用例 2：网络不可达时第 10 条 skip，writeOk 保持 unknown（离线入队不被自检禁掉）', async () => {
    const env = makeEnv({ withPack: true });
    env.http.post = async () => {
      throw new Error('网络不可达');
    };
    const r = await runSelfCheck(env.ctx, { plus: FAKE_PLUS });

    const p10 = r.items.find((i) => i.id === 'net.event_write');
    expect(p10?.status).toBe('skip');
    expect(p10?.detail).toBe('节点不可达，未探测');
    expect(r.flags).toEqual({ cryptoOk: 'ok', fsOk: 'ok', dbOk: 'ok', writeOk: 'unknown' });
    // unknown 不降级 → 发表可用 → 离线入队可用（本册 §7）
    expect(canPostComment(r.flags)).toBe(true);
    // 探针不污染队列：sendComment 是纯发送，不入队
    expect(await env.repo.listCommentOut()).toEqual([]);
  });

  it('用例 11：节点明确拒绝时第 10 条 fail，writeOk 跟着降级', async () => {
    const env = makeEnv({ withPack: true });
    env.http.postRoutes.set(`${NODE}/v1/event`, {
      status: 403,
      body: utf8(JSON.stringify({ code: 'event_sig_invalid' })),
    });
    const r = await runSelfCheck(env.ctx, { plus: FAKE_PLUS });

    const p10 = r.items.find((i) => i.id === 'net.event_write');
    expect(p10?.status).toBe('fail');
    expect(p10?.detail).toBe('提交被拒绝');
    expect(r.flags.writeOk).toBe('fail');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run src/core/selfcheck.test.ts`

Expected: FAIL —— 用例 2 期望 `skip` 实得 `fail`；用例 11 期望 `fail` 实得 `ok`（当前走 `postComment` 会吞掉错误入队）。

- [ ] **Step 3: 改实现**

把 `apps/mobile/src/core/selfcheck.ts:11` 的：

```ts
import { postComment } from './comment';
```

换成：

```ts
import { CommentError, sendComment } from './comment';
```

把探测 10（`id: 'net.event_write'`）的 `run` 方法：

```ts
    async run(c) {
      if (!c.nodeBaseUrl) throw new ProbeSkip('未配置节点地址');
      // 走真实发表链路：身份 → 签名 → POST /v1/event，正是 0.4.1 修坏过的那条
      const r = await postComment(
        { adapters: c.adapters, repo: c.repo, nodeBaseUrl: c.nodeBaseUrl },
        { targetId: SELFCHECK_TARGET, text: SELFCHECK_TARGET },
      );
      return `200 回执 event_id ${r.eventId.slice(0, 8)}`;
    },
```

换成：

```ts
    async run(c) {
      if (!c.nodeBaseUrl) throw new ProbeSkip('未配置节点地址');
      // 走真实发送链路：身份 → 签名 → POST /v1/event，正是 0.4.1 修坏过的那条。
      // 用 sendComment（纯发送）而不是 postComment：探针不得把 selfcheck 事件写进用户待发队列。
      try {
        const r = await sendComment(
          { adapters: c.adapters, repo: c.repo, nodeBaseUrl: c.nodeBaseUrl },
          { targetId: SELFCHECK_TARGET, text: SELFCHECK_TARGET },
        );
        return `200 回执 event_id ${r.eventId.slice(0, 8)}`;
      } catch (e) {
        // 网络不可达 ≠ 内容不可写：判 skip（不计入 writeOk），否则离线时自检会禁掉离线入队本身（本册 §7）
        if (e instanceof CommentError && e.code === 'network') throw new ProbeSkip('节点不可达，未探测');
        throw e;
      }
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run src/core/selfcheck.test.ts`

Expected: PASS（既有 8 项里的用例 2 改写为 2 条 → 共 9 项）

- [ ] **Step 5: 全量测试 + 类型检查**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run`

Expected: 全绿（85 → 85 - 1 + 2 = 86 项；加上 Task 2/3 的 comment 新增共 14 项，实际为 99 项，以全绿为准）

再跑 `npx tsc --noEmit`

Expected: 无输出（除 `comment.vue` 尚未更新外）

- [ ] **Step 6: 提交**

```bash
git add apps/mobile/src/core/selfcheck.ts apps/mobile/src/core/selfcheck.test.ts
git commit -m "fix(mobile): 自检探测 10 网络不可达改判 skip，改用 sendComment 不污染待发队列（离线队列 spec §7）"
```

---

### Task 5: 评论页待发区与离线提示

**Files:**
- Modify: `apps/mobile/src/pages/comment/comment.vue`

- [ ] **Step 1: 模板加待发区**

在 `apps/mobile/src/pages/comment/comment.vue` 的 `</scroll-view>` 之后、`<text v-if="unconfigured" class="hint">` 之前插入：

```html
    <view v-if="pending.length > 0" class="pending">
      <view class="pending-bar">
        <text class="pending-title">待发送 {{ pending.length }} 条</text>
        <text class="act" @click="retryPending">立即补发</text>
      </view>
      <view v-for="p in pending" :key="p.eventId" class="po">
        <text class="po-target">{{ targetTitle(p.targetId) }}</text>
        <text class="po-text">{{ p.text }}</text>
        <view class="po-foot">
          <text :class="p.state === 'failed' ? 'po-reason' : 'po-state'">{{ p.state === 'failed' ? '发送失败：' + p.reason : '待发送' }}</text>
          <text v-if="p.state === 'failed'" class="act" @click="dropPending(p.eventId)">删除</text>
        </view>
      </view>
    </view>
```

- [ ] **Step 2: 模板加离线提示与 composer 禁用**

把 `<text v-if="error" class="act" @click="reload">重试</text>` 之后插入一行：

```html
      <text v-if="error && pending.length > 0" class="hint">离线，仅显示待发送</text>
```

把 `<input ... :disabled="target === ''" :placeholder="target === '' ? '选择一项内容后可以评论' : '说点什么…'" />` 这段换成：

```html
      <input
        v-model="draft"
        class="input"
        :disabled="unconfigured || target === ''"
        :placeholder="unconfigured ? '未配置节点，暂不能评论' : target === '' ? '选择一项内容后可以评论' : '说点什么…'"
      />
```

- [ ] **Step 3: 脚本改 import 与 `canSend`**

把 import 段里的：

```ts
import {
  fetchCommentText,
  listComments,
  postComment,
  takePendingTarget,
  CommentError,
  type CommentItem,
  type CommentOptions,
} from '../../core/comment';
import type { ItemRow } from '../../core/types';
```

换成：

```ts
import {
  fetchCommentText,
  flushPending,
  listComments,
  postComment,
  takePendingTarget,
  CommentError,
  type CommentItem,
  type CommentOptions,
} from '../../core/comment';
import type { CommentOutRow, ItemRow } from '../../core/types';
```

把：

```ts
const canSend = computed(
  () => canPostComment(caps.value) && target.value !== '' && draft.value.trim() !== '' && !sending.value,
);
```

换成：

```ts
const canSend = computed(
  () =>
    canPostComment(caps.value) &&
    !unconfigured.value &&
    target.value !== '' &&
    draft.value.trim() !== '' &&
    !sending.value,
);

/** 待发区：不随 target 过滤——它是「尚未生效的本地状态」，过滤会让人误以为没待发了（本册 §6）。 */
const pending = ref<CommentOutRow[]>([]);
```

- [ ] **Step 4: 脚本加待发区逻辑**

在 `load()` 函数之后追加：

```ts
async function loadPending() {
  if (!opts.value) return;
  pending.value = await opts.value.repo.listCommentOut();
}

/** 目标标题取自已下载内容列表（零网络）；找不到就退化成 target_id。 */
function targetTitle(itemId: string): string {
  return items.value.find((i) => i.itemId === itemId)?.title || itemId;
}

/** 补发一轮并刷新：不 await 进页面（由 onShow 决定），页面按钮会 await。 */
async function flush() {
  if (!opts.value) return;
  const r = await flushPending(opts.value);
  if (r.sent + r.failed > 0) await loadPending();
  if (r.sent > 0) await refresh();
}

async function retryPending() {
  await flush();
}

async function dropPending(eventId: string) {
  if (!opts.value) return;
  await opts.value.repo.removeCommentOut(eventId);
  await loadPending();
}
```

- [ ] **Step 5: 脚本改 `send()` 与 `onShow`**

把 `send()` 换成：

```ts
async function send() {
  if (!canSend.value || !opts.value) return;
  const text = draft.value.trim();
  sending.value = true;
  notice.value = '';
  try {
    const r = await postComment(opts.value, { targetId: target.value, text });
    draft.value = '';
    if (r.queued) {
      notice.value = '已保存，联网后自动补发';
      await loadPending();
    } else {
      notice.value = '已发表';
      await refresh();
    }
  } catch (e) {
    // 不用 instanceof 兜成通用文案：非 CommentError 的裸错误也要把原因显示出来，否则真机无从排查
    notice.value = e instanceof CommentError ? e.message : `提交失败：${(e as Error).message ?? String(e)}`;
  } finally {
    sending.value = false;
  }
}
```

把 `onShow` 换成（**注意**：原变量 `pending` 与新的 `pending` ref 同名，必须改名为 `anchor`）：

```ts
onShow(async () => {
  // 文章页 → 评论 tab 的锚定态（tab 页不能带 query）
  const anchor = takePendingTarget();
  await load();
  if (anchor) target.value = anchor;
  await loadPending();
  await refresh();
  void flush(); // 不 await：补发不阻塞首屏（本册 §6）
});
```

- [ ] **Step 6: 样式**

在 `apps/mobile/src/pages/comment/comment.vue` 的 `<style>` 里、`.error` 规则之后插入：

```css
.pending { margin-bottom: 12px; padding: 10px; background: #fffaf0; border: 1px solid #f6e05e; border-radius: 6px; }
.pending-bar { display: flex; align-items: center; justify-content: space-between; }
.pending-title { font-size: 14px; font-weight: 600; }
.po { padding: 8px 0; border-top: 1px solid #f6e05e; }
.po-target { display: block; color: #888888; font-size: 12px; }
.po-text { display: block; margin-top: 2px; font-size: 15px; }
.po-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
.po-state { color: #888888; font-size: 12px; }
.po-reason { color: #c05621; font-size: 12px; }
```

- [ ] **Step 7: 类型检查 + 全量测试 + 构建**

Run（cwd `e:\code\base\apps\mobile`）: `npx tsc --noEmit`

Expected: 无输出

Run: `npx vitest run`

Expected: 全绿

Run: `npm run build:app`

Expected: 构建成功（`dist/build/app` 产出）

- [ ] **Step 8: 提交**

```bash
git add apps/mobile/src/pages/comment/comment.vue
git commit -m "feat(mobile): 评论页待发区、立即补发、失败删除与离线提示（离线队列 spec §6）"
```

---

### Task 6: 版本 0.6.0、全量自测与推送

**Files:**
- Modify: `apps/mobile/src/manifest.json`

- [ ] **Step 1: 改版本号**

把 `apps/mobile/src/manifest.json` 里的：

```json
    "versionName" : "0.5.0",
    "versionCode" : "6",
```

改成：

```json
    "versionName" : "0.6.0",
    "versionCode" : "7",
```

- [ ] **Step 2: 全量自测（逐条执行，PowerShell 5.1 不支持 `&&`）**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run`

Expected: 全绿（约 99 项）

Run: `npx tsc --noEmit`

Expected: 无输出

Run: `npm run build:app`

Expected: 构建成功

Run（cwd `e:\code\base\packages\protocol-ts`）: `npx vitest run`

Expected: 全绿（51 项，本册子未动协议包）

- [ ] **Step 3: 提交并推送**

```bash
git add apps/mobile/src/manifest.json
git commit -m "chore(mobile): 版本 0.6.0（评论离线发表队列）"
git push
```

- [ ] **Step 4: 复核产物含新代码（防「版本号新、功能旧」）**

Run（cwd `e:\code\base\apps\mobile`）:

```powershell
Select-String -Path dist\build\app\app-service.js -Pattern '待发送','comment_out','已保存，联网后自动补发','离线，仅显示待发送','节点不可达，未探测' -SimpleMatch | Select-Object -First 8
```

Expected: 五个串**全部命中**（前四个来自评论页与队列，最后一个来自自检探测 10）

---

### Task 7: 云打包与发布 0.6.0

**Files:**
- Create: `apps/mobile/dist/release/apk/base-0.6.0.apk`（云打包产物另存）

- [ ] **Step 1: 云打包**

Run（任意 cwd）:

```
D:\HBuilderX\cli.exe pack --project e:\code\base\apps\mobile --platform android --android.packagename uni.app.UNI936A667 --android.androidpacktype 3
```

Expected: 打印一个临时下载地址（5 次有效）。**必须自己把 APK 下载并另存到** `e:\code\base\apps\mobile\dist\release\apk\base-0.6.0.apk`——CLI 不会落到该目录。

下载用 `Invoke-WebRequest`（0.5.0 实测本地 `curl.exe` 报 `getaddrinfo() thread failed`）：

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri '<临时地址>' -OutFile 'e:\code\base\apps\mobile\dist\release\apk\base-0.6.0.apk'
```

- [ ] **Step 2: 记录本地包指纹**

Run（cwd `e:\code\base\apps\mobile`）:

```bash
certutil -hashfile dist\release\apk\base-0.6.0.apk SHA256
```

Expected: 打印 sha256（后面与线上 `apk_sha256` 比对）

- [ ] **Step 3: 核对签名证书未变（可覆盖安装）**

Run（cwd `e:\code\base\apps\mobile`）:

```bash
D:\HBuilderX\plugins\amazon-corretto\bin\keytool.exe -printcert -jarfile dist\release\apk\base-0.6.0.apk
```

Expected: `SHA1: 19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`（与 0.5.0 一致）。

**只用 `keytool` 指纹判断证书**：`META-INF/CERT.RSA` 的文件字节哈希会因打包细节不同而变。

- [ ] **Step 4: 上传 APK 并更新落地页**

```bash
scp e:\code\base\apps\mobile\dist\release\apk\base-0.6.0.apk me:/opt/appdl/base-0.6.0.apk
ssh me "sed -i 's/base-0.5.0.apk/base-0.6.0.apk/g' /opt/appdl/index.html && grep -o 'base-0.[0-9.]*.apk' /opt/appdl/index.html"
```

Expected: `grep` 输出 `base-0.6.0.apk`

- [ ] **Step 5: 签发升级文档**

`-notes` 必须是**不含空格的一个 token**（空格会被 Go flag 解析吃掉，导致后面的 `-out` 失效、文档落到源节点目录）：

```bash
ssh me "BASE_SIGN_KEY=37a6f57960600162228f272f0e33b062a9e5d06e33c218d932afb68c07feb0ce /opt/base/based release -version-name 0.6.0 -min-version-name 0.5.0 -apk-url http://118.190.217.242/dl/base-0.6.0.apk -apk-file /opt/appdl/base-0.6.0.apk -notes 离线可写评论：待发队列、联网自动补发、失败可删 -out /opt/base-cache/data/release.json"
```

Expected: 打印 `version_name=0.6.0`、`apk_size`、`apk_sha256`；`apk_sha256` 与 Step 2 的本地指纹一致。

若误写了副本，清掉：`ssh me "rm -f /opt/base/data/release.json"`

- [ ] **Step 6: 线上验证**

```bash
ssh me "curl -sS http://127.0.0.1/v1/release"
curl.exe -sSI http://118.190.217.242/dl/base-0.6.0.apk
```

Expected: `/v1/release` 返回 `version_name":"0.6.0"` 的文档；APK `200` 且 `Content-Length` 与文档 `apk_size` 一致。

用客户端验签器核对（仓库根跑一次性 TS 脚本或复用既有验证脚本），`verifyRelease(doc, '48c33db9cf859e107fe89651d15fc5faaa8b16ffbb7d4b483aa167a0cff824f4')` 为 `true`。

- [ ] **Step 7: 复核已发布 APK 内确实含本次改动**

从已发布的 APK 内取出 `app-service.js` 逐串核对（`assets/apps/__UNI__936A667__/www/app-service.js`）：`待发送`、`comment_out`、`已保存，联网后自动补发`、`节点不可达，未探测` 全部命中；`www/manifest.json` 为 `0.6.0`。

---

### Task 8: 真机验收与回填

**Files:**
- Modify: `docs/superpowers/plans/2026-09-28-base-comment-offline-queue-plan.md`（本文件「执行期更正」小节）
- Modify: `docs/superpowers/plans/2026-09-27-base-mobile-release-plan.md`（§执行期更正 追加一条）

- [ ] **Step 1: 装机验收（对照 spec §9 逐条打勾）**

| # | 验收项 | 判定 |
| --- | --- | --- |
| 1 | 断网发表 | 提示「已保存，联网后自动补发」，待发区出现该条，输入框清空 |
| 2 | 杀进程重开 | 待发区仍有该条（落盘验证） |
| 3 | 联网进评论页 | 自动补发 → 待发区清空 → 在线列表出现该条，且**只有一条**、时间显示为发表时刻 |
| 4 | 离线跑自检 | 探测 10 为 ➖（节点不可达，未探测），评论页发表按钮**仍可用** |
| 5 | 失败可见 | 造一条永久失败（篡改本地 wire 使 `sig` 失效后补发）→ 标「发送失败：提交被拒绝」，原文仍在，可「删除」 |
| 6 | 不干扰 | 离线与失败期间，课程 / 答题 / 我的三 tab 完全正常 |

第 5 项的取巧做法：先用断网发表攒一条待发项，再用 `adb shell run-as`（或调试页）把 `comment_out.wire` 里的某个正文字符改掉，联网后点「立即补发」，节点验签失败即永久失败。

- [ ] **Step 2: 回填执行期更正**

把 Step 1 六条的实际结果、与计划不符之处（命令、字段、判定口径）与 0.6.0 发布实况（APK 大小 / sha256 / 证书指纹 / `release.json` 内容）追加到本文件「执行期更正」小节，并在 `2026-09-27-base-mobile-release-plan.md` 的「§执行期更正」追加一条。

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/plans/2026-09-28-base-comment-offline-queue-plan.md docs/superpowers/plans/2026-09-27-base-mobile-release-plan.md
git commit -m "docs(plans): 回填 0.6.0 离线评论队列发布实况与执行期更正"
git push
```

---

## 自检清单（写完计划后核过）

**Spec 覆盖**

| spec 小节 | 落点 |
| --- | --- |
| §3.1 建表 | Task 1 Step 2（`CREATE TABLE IF NOT EXISTS` + 索引，靠 `bootstrap()` 自动补表） |
| §3.2 `LocalRepo` 4 方法 + `CommentOutRow` | Task 1 Step 1/3/4/5 |
| §4.1 `sendComment` / `buildCommentWire` | Task 2 Step 3（`sendComment` 同时是探针与补发的唯一入口） |
| §4.2 `postComment` 离线兜底 | Task 2 Step 3（未配置 → `client`；仅 `network` 入队） |
| §4.3 `flushPending` | Task 3 Step 3（模块级 inflight 守卫、顺序、暂时失败中止、不抛错） |
| §5.2 失败分类 | Task 3 Step 3 的 `isPermanentFailure` + 用例 6/7 |
| §6 评论页 | Task 5（待发区不过滤 target、离线提示、composer 禁用、`onShow` 顺序、失败删除） |
| §7 自检探测 10 | Task 4（三态、改走 `sendComment`、`ProbeSkip`） |
| §8 测试 1–9 / 10–11 | Task 2 Step 1（1–4 + 纯度）、Task 3 Step 1（5–9）、Task 4 Step 1（10–11） |
| §9 真机验收 | Task 8 Step 1 |
| §11 红线 | 未改节点、未改 `sync.ts` / `update.ts`、未加网络状态监听与后台任务、未加外部依赖、未缓存他人评论 |

**与 spec 的两处实现期细化（已在 Task 2 头注明，需同步回 spec）**

1. `CommentInput` 增加可选 `wire` / `eventId`——spec §3.1 与 §8 用例 5 要求补发逐字节重放（`sig` 不重算），而 §4.3 的调用只传 `targetId/text/replyTo`；加这两个可选字段是唯一能同时满足二者的最小改动。补发时**请求签名头每轮新算**（`ts` 一次性、`nonce` 会被节点去重），故只重放 body 字节。
2. `postComment` 的入队动作发生在捕获 `network` 之后**重新构造 wire**（`sendComment` 内部抛错时不向外暴露它构造的 wire）：离线时用本机身份（不需要节点）就地构造，与 spec §4.2「入队前 `event_id` 已生成且 `sig` 已算好」的语义一致。

**额外强调的实现约束**

- `MemoryDb` 一律不动：评论测试走 `MemoryRepo`，`MemoryDb` 只服务自检探测。
- `SqlRepo` 与 `MemoryRepo` 必须同时实现 4 个新方法，否则 `npx tsc --noEmit` 报错——这是两地实现不漂移的唯一保证。
- `comment.vue` 的 `onShow` 里原变量叫 `pending`，与新的 `pending` ref 冲突，必须改名 `anchor`（Task 5 Step 5 已写）。