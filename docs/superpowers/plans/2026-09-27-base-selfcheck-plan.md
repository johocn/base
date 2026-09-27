# 基座自检与功能级降级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 App 加一个「基座自检」页：一次装机跑 12 条平台能力探测并显示真实原因，能力明确不可用时对应功能入口直接禁用并原位说明。

**Architecture:** 新增 `core/selfcheck.ts`（探测定义 + `runSelfCheck` + 能力标志与降级判定）与 `pages/selfcheck/selfcheck.vue`；`platform/index.ts` 的 `AppContext` 增加 `capabilities`，启动时只定 `cryptoOk`（随机池预填成败），自检页跑完用 `applySelfCheck` 写回；评论页与课程页只读标志做「禁用 + 说明」，不改既有同步/评论/升级语义。

**Tech Stack:** uni-app（Vue 3 + TS）、plus.sqlite / plus.io / uni.request、vitest（node 环境）、`core/fakes.ts` 假适配器、`@base/protocol-ts`。

**上游 spec:** `docs/superpowers/specs/2026-09-27-base-selfcheck-design.md`（本计划是它的实现展开，冲突时以 spec 为准）

---

## 文件结构

| 路径 | 动作 | 职责 |
| --- | --- | --- |
| `apps/mobile/src/core/selfcheck.ts` | 新增 | 能力标志类型、降级判定（`canPostComment` / `postBlockedReason` / `canSync`）、12 条探测、`runSelfCheck`、报告类型、`SELFCHECK_TARGET` |
| `apps/mobile/src/core/selfcheck.test.ts` | 新增 | 上者的单测（spec §8 的 5 条 + 1 条 pack 缺失分支） |
| `apps/mobile/src/core/fakes.ts` | 修改 | 加 `MemoryDb`（`LocalDb` 假实现）；`FakePackReader` 支持 `count(*) AS n` 查询 |
| `apps/mobile/src/platform/index.ts` | 修改 | `AppContext.capabilities`、`bootstrap()` 设 `cryptoOk` 初值、导出 `applySelfCheck` |
| `apps/mobile/src/pages/selfcheck/selfcheck.vue` | 新增 | 展示 12 条结果、重跑、复制结果；降级模式提示 |
| `apps/mobile/src/pages.json` | 修改 | 注册 `pages/selfcheck/selfcheck` |
| `apps/mobile/src/pages/setting/setting.vue` | 修改 | 「能力诊断」旁加「基座自检」入口 |
| `apps/mobile/src/pages/comment/comment.vue` | 修改 | 发表按钮按 `cryptoOk`/`writeOk` 禁用 + 原位原因；列表过滤 `target_id=selfcheck` |
| `apps/mobile/src/pages/course/course.vue` | 修改 | 同步按钮按 `fsOk` 禁用 + 说明 |
| `apps/mobile/src/manifest.json` | 修改 | `versionName 0.5.0` / `versionCode 6` |

约定：所有命令的工作目录都是 `e:\code\base\apps\mobile`（除 git 与部署步骤，它们用 `e:\code\base`）。

---

### Task 1: 能力标志与降级判定

**Files:**
- Create: `apps/mobile/src/core/selfcheck.ts`
- Test: `apps/mobile/src/core/selfcheck.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `apps/mobile/src/core/selfcheck.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import { UNKNOWN_FLAGS, canPostComment, canSync, postBlockedReason } from './selfcheck';

describe('能力标志与降级判定', () => {
  it('unknown 不降级：功能照常可用', () => {
    expect(canPostComment(UNKNOWN_FLAGS)).toBe(true);
    expect(canSync(UNKNOWN_FLAGS)).toBe(true);
    expect(postBlockedReason(UNKNOWN_FLAGS)).toBe('');
  });

  it('只有明确 fail 才降级，且各标志互不牵连', () => {
    expect(canPostComment({ ...UNKNOWN_FLAGS, cryptoOk: 'fail' })).toBe(false);
    expect(postBlockedReason({ ...UNKNOWN_FLAGS, cryptoOk: 'fail' })).toContain('随机源不可用');
    expect(canPostComment({ ...UNKNOWN_FLAGS, writeOk: 'fail' })).toBe(false);
    expect(postBlockedReason({ ...UNKNOWN_FLAGS, writeOk: 'fail' })).toContain('节点未接受写入');
    expect(canSync({ ...UNKNOWN_FLAGS, fsOk: 'fail' })).toBe(false);
    // 文件不可用不影响发表评论（两条链路互不依赖）
    expect(canPostComment({ ...UNKNOWN_FLAGS, fsOk: 'fail' })).toBe(true);
  });

  it('全 ok 不降级', () => {
    const all = { cryptoOk: 'ok', fsOk: 'ok', dbOk: 'ok', writeOk: 'ok' } as const;
    expect(canPostComment(all)).toBe(true);
    expect(canSync(all)).toBe(true);
    expect(postBlockedReason(all)).toBe('');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run src/core/selfcheck.test.ts`

Expected: FAIL —— `Failed to resolve import "./selfcheck"` 或 `does not provide an export named 'UNKNOWN_FLAGS'`。

- [ ] **Step 3: 写最小实现**

创建 `apps/mobile/src/core/selfcheck.ts`：

```ts
/**
 * 基座自检：把「平台能力是否可用」从推断变成一次装机就能读到的证据。
 *
 * 全部通过注入的适配器与窄平台接口访问平台能力，不 import 'uni' 全局，
 * 因此能在 Node 下用 core/fakes.ts 完整测试（与 core/update.ts 同一惯例）。
 */
export type Capability = 'unknown' | 'ok' | 'fail';

export interface CapabilityFlags {
  cryptoOk: Capability;
  fsOk: Capability;
  dbOk: Capability;
  writeOk: Capability;
}

/** 未探测时的初值：`unknown` 不降级，功能照常尝试（spec §4）。 */
export const UNKNOWN_FLAGS: CapabilityFlags = {
  cryptoOk: 'unknown',
  fsOk: 'unknown',
  dbOk: 'unknown',
  writeOk: 'unknown',
};

export const FLAG_KEYS: Array<keyof CapabilityFlags> = ['cryptoOk', 'fsOk', 'dbOk', 'writeOk'];

export type CheckStatus = 'ok' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  group: string;
  name: string;
  affects: string;
  status: CheckStatus;
  detail: string;
}

export interface SelfCheckReport {
  at: string;
  degraded: boolean;
  items: CheckResult[];
  flags: CapabilityFlags;
}

/** 评论发表是否可用：**只有明确 fail 才拦**，unknown 与 ok 一律照常尝试（spec §4）。 */
export function canPostComment(flags: CapabilityFlags): boolean {
  return flags.cryptoOk !== 'fail' && flags.writeOk !== 'fail';
}

/** 评论发表被拦时的原位原因；可用时返回空串。详细原因在「设置 → 基座自检」。 */
export function postBlockedReason(flags: CapabilityFlags): string {
  if (flags.cryptoOk === 'fail') return '随机源不可用，无法发表评论（设置 → 基座自检 可看原因）';
  if (flags.writeOk === 'fail') return '节点未接受写入，无法发表评论（设置 → 基座自检 可看原因）';
  return '';
}

/** 课程页同步是否可用（同步必须把 pack 写到本地文件）。 */
export function canSync(flags: CapabilityFlags): boolean {
  return flags.fsOk !== 'fail';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/selfcheck.test.ts`

Expected: PASS（3 个用例）

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/core/selfcheck.ts apps/mobile/src/core/selfcheck.test.ts
git commit -m "feat(mobile): 能力标志与功能级降级判定（自检 spec §4）"
```

---

### Task 2: 测试假件扩展（MemoryDb + pack 计数）

**Files:**
- Modify: `apps/mobile/src/core/fakes.ts`

本任务只改测试假件，不引入生产代码；其行为由 Task 3 的用例 1/4/6 覆盖，本步的验证是类型检查。

- [ ] **Step 1: 在 `fakes.ts` 末尾（`fakeAdapters` 之前）加 `MemoryDb`**

先把文件顶部的 adapter 类型 import 里的 `LocalDb` 补上：

```ts
import type { Adapters, FsAdapter, HttpAdapter, HttpResponse, LocalDb, PackReader, SqliteConnection, StorageAdapter } from '../platform/adapter';
```

```ts
/**
 * `LocalDb` 的假实现：只实现自检探测会用到的那几条语句。
 * 不认识的 SQL 一律抛错——假实现悄悄放过新语句，比测试失败更难查（与 FakePackReader 同一取舍）。
 */
export class MemoryDb implements LocalDb {
  private tables = new Map<string, Array<Record<string, unknown>>>([['selfcheck_probe', []]]);

  async select(sql: string): Promise<Record<string, unknown>[]> {
    const rb = /randomblob\((\d+)\)/i.exec(sql);
    if (rb) return [{ b: 'ab'.repeat(Number(rb[1])) }];
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
```

- [ ] **Step 2: 让 `FakePackReader` 支持计数查询**

把 `apps/mobile/src/core/fakes.ts` 里 `FakePackReader.open` 的 `select` 改成（在原有 `FROM quizzes` / `FROM articles` 分支**之前**插入计数分支）：

```ts
      select: async (sql: string) => {
        // 自检条目 7 用的是 count 查询；真实 pack 是真 SQLite，这里只需给出正确行数
        const cnt = /count\(\*\)\s+AS\s+n\s+FROM\s+(\w+)/i.exec(sql);
        if (cnt) {
          const t = String(cnt[1]);
          if (t === 'articles') return [{ n: rows.articles.length }];
          if (t === 'quizzes') return [{ n: rows.quizzes.length }];
          throw new Error(`fake pack 不支持的计数: ${sql}`);
        }
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
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`

Expected: 无输出（`MemoryDb` 的 `LocalDb` 实现完整）

- [ ] **Step 4: 跑既有测试确认没回归**

Run: `npx vitest run`

Expected: 全绿（既有 77 项）

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/core/fakes.ts
git commit -m "test(mobile): fakes 加 MemoryDb，FakePackReader 支持 count 查询"
```

---

### Task 3: 12 条探测与 runSelfCheck

**Files:**
- Modify: `apps/mobile/src/core/selfcheck.ts`
- Modify: `apps/mobile/src/core/selfcheck.test.ts`

- [ ] **Step 1: 写失败的测试**

把 `apps/mobile/src/core/selfcheck.test.ts` 改成（保留 Task 1 的三个用例，追加以下内容）：

```ts
import { describe, expect, it } from 'vitest';

import { keyPairFromSeed, signRelease, utf8, type ReleaseDoc } from '@base/protocol-ts';

import {
  UNKNOWN_FLAGS,
  canPostComment,
  canSync,
  postBlockedReason,
  runSelfCheck,
  type CheckContext,
  type PlusHandle,
} from './selfcheck';
import { FakeHttp, FakePackReader, MemoryDb, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import type { ArticleRow } from './types';

describe('能力标志与降级判定', () => {
  it('unknown 不降级：功能照常可用', () => {
    expect(canPostComment(UNKNOWN_FLAGS)).toBe(true);
    expect(canSync(UNKNOWN_FLAGS)).toBe(true);
    expect(postBlockedReason(UNKNOWN_FLAGS)).toBe('');
  });

  it('只有明确 fail 才降级，且各标志互不牵连', () => {
    expect(canPostComment({ ...UNKNOWN_FLAGS, cryptoOk: 'fail' })).toBe(false);
    expect(postBlockedReason({ ...UNKNOWN_FLAGS, cryptoOk: 'fail' })).toContain('随机源不可用');
    expect(canPostComment({ ...UNKNOWN_FLAGS, writeOk: 'fail' })).toBe(false);
    expect(postBlockedReason({ ...UNKNOWN_FLAGS, writeOk: 'fail' })).toContain('节点未接受写入');
    expect(canSync({ ...UNKNOWN_FLAGS, fsOk: 'fail' })).toBe(false);
    // 文件不可用不影响发表评论（两条链路互不依赖）
    expect(canPostComment({ ...UNKNOWN_FLAGS, fsOk: 'fail' })).toBe(true);
  });

  it('全 ok 不降级', () => {
    const all = { cryptoOk: 'ok', fsOk: 'ok', dbOk: 'ok', writeOk: 'ok' } as const;
    expect(canPostComment(all)).toBe(true);
    expect(canSync(all)).toBe(true);
    expect(postBlockedReason(all)).toBe('');
  });
});

const NODE = 'http://node.test';
const ISSUER_SEED = '11'.repeat(32);
const ISSUER_PUB = keyPairFromSeed(ISSUER_SEED).pubHex;
const FAKE_PLUS: PlusHandle = { runtime: { version: '0.5.0', openURL: () => undefined } };

const RELEASE: ReleaseDoc = signRelease(
  {
    schema_version: 1,
    issuer: 'base-node-test',
    issued_at: '2026-09-27T00:00:00Z',
    version_name: '9.9.9',
    min_version_name: '0.0.1',
    apk_url: `${NODE}/dl/x.apk`,
    apk_size: 1,
    apk_sha256: 'ab'.repeat(32),
    notes: 'test',
  },
  ISSUER_SEED,
);

const ARTICLE: ArticleRow = {
  itemId: 'a1',
  title: '自检用文章',
  digest: '',
  publishedAt: '2026-09-27',
  tagsJson: '[]',
  bodyMd: '# hi',
  contentHash: 'cd'.repeat(32),
  rev: '1',
};

/** 12 条探测的展示顺序（spec §3）。 */
const ALL_IDS = [
  'crypto.sqlite_random',
  'crypto.pool',
  'crypto.sign',
  'fs.bigfile',
  'fs.meta',
  'db.tx',
  'db.pack',
  'net.tls_get',
  'net.release_verify',
  'net.event_write',
  'net.open_url',
  'render.memory',
];

function makeEnv(o: { withPack?: boolean } = {}) {
  const http = new FakeHttp();
  const fs = new MemoryFs();
  const repo = new MemoryRepo();
  const db = new MemoryDb();
  const packReader = new FakePackReader();
  const adapters = fakeAdapters(http, fs, packReader);

  repo.config.set('pubkey_hex', ISSUER_PUB);
  http.routes.set(`${NODE}/v1/comment?limit=1`, {
    status: 200,
    body: utf8(JSON.stringify({ comments: [], next_cursor: null })),
  });
  http.routes.set(`${NODE}/v1/release`, { status: 200, body: utf8(JSON.stringify(RELEASE)) });
  http.postRoutes.set(`${NODE}/v1/identity/register`, { status: 200, body: utf8('{}') });
  http.postRoutes.set(`${NODE}/v1/event`, {
    status: 200,
    body: utf8(JSON.stringify({ event_id: 'ab'.repeat(16), payload_cid: 'cd'.repeat(16) })),
  });

  if (o.withPack) {
    const packPath = '/work/pack-p1.sqlite';
    fs.files.set(packPath, new Uint8Array([1]));
    packReader.set(packPath, [ARTICLE], []);
    repo.config.set('pack_id', 'p1');
  }

  const ctx: CheckContext = { adapters, repo, db, nodeBaseUrl: NODE, workDir: '/work' };
  return { http, fs, repo, db, ctx };
}

describe('runSelfCheck', () => {
  it('用例 1：全可用时 12 条为 ok，标志全 ok，且不留探测残留', async () => {
    const env = makeEnv({ withPack: true });
    const r = await runSelfCheck(env.ctx, { plus: FAKE_PLUS });

    expect(r.degraded).toBe(false);
    expect(r.items.map((i) => i.id)).toEqual(ALL_IDS);
    expect(r.items.map((i) => i.status)).toEqual(new Array(12).fill('ok'));
    expect(r.flags).toEqual({ cryptoOk: 'ok', fsOk: 'ok', dbOk: 'ok', writeOk: 'ok' });
    // 污染控制：probe.bin / meta.bin 已删，只剩 pack 文件；事务探测未留行
    expect([...env.fs.files.keys()]).toEqual(['/work/pack-p1.sqlite']);
    expect(await env.ctx.db.select('SELECT count(*) AS n FROM selfcheck_probe')).toEqual([{ n: 0 }]);
  });

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

  it('用例 3：单条挂死只让该条超时，整页仍然出结果', async () => {
    const env = makeEnv({ withPack: true });
    env.http.get = () => new Promise<never>(() => undefined);
    const r = await runSelfCheck(env.ctx, { plus: FAKE_PLUS, timeoutMs: 10 });

    const timedOut = r.items.filter((i) => i.detail.includes('超时')).map((i) => i.id);
    expect(timedOut).toEqual(['net.tls_get', 'net.release_verify']);
    expect(r.items).toHaveLength(12);
    expect(r.flags.cryptoOk).toBe('ok');
  });

  it('用例 4：降级模式（无 ctx）只跑 3、11、12，其余原因写明', async () => {
    const r = await runSelfCheck(null, { plus: FAKE_PLUS });

    expect(r.degraded).toBe(true);
    expect(r.items.map((i) => i.id)).toEqual(ALL_IDS);
    expect(r.items.filter((i) => i.status === 'ok').map((i) => i.id)).toEqual([
      'crypto.sign',
      'net.open_url',
      'render.memory',
    ]);
    const skipped = r.items.find((i) => i.id === 'crypto.sqlite_random');
    expect(skipped?.status).toBe('fail');
    expect(skipped?.detail).toBe('本地库不可用，未探测');
    expect(r.flags).toEqual({ cryptoOk: 'fail', fsOk: 'fail', dbOk: 'fail', writeOk: 'fail' });
  });

  it('用例 6：本地无 pack 时第 7 条为 skip，dbOk 仍为 ok', async () => {
    const env = makeEnv();
    const r = await runSelfCheck(env.ctx, { plus: FAKE_PLUS });

    expect(r.items.find((i) => i.id === 'db.pack')?.status).toBe('skip');
    expect(r.flags.dbOk).toBe('ok');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/selfcheck.test.ts`

Expected: FAIL —— `does not provide an export named 'runSelfCheck'`

- [ ] **Step 3: 写实现**

在 `apps/mobile/src/core/selfcheck.ts` 顶部的文件注释之后追加 import（保留 Task 1 已写的全部内容）：

```ts
import { keyPairFromSeed, randomBytes, sign, utf8, verify } from '@base/protocol-ts';

import type { Adapters, LocalDb } from '../platform/adapter';
import { base64ToBytes, bytesToBase64, plusRuntime } from '../platform/uni';
import { postComment } from './comment';
import type { LocalRepo } from './repo';
import { fetchReleaseDoc } from './update';
```

在文件末尾追加：

```ts
/** 自检事件的 target_id：它进节点事件表，但不进任何客户端评论列表（spec §7）。 */
export const SELFCHECK_TARGET = 'selfcheck';

/** 探测上下文：与 AppContext 同源，页面负责组装（spec §2）。 */
export interface CheckContext {
  adapters: Adapters;
  repo: LocalRepo;
  db: LocalDb;
  nodeBaseUrl: string;
  workDir: string;
}

/** 平台句柄的窄接口：只用得到 `runtime.openURL`；测试传假对象即可。 */
export interface PlusHandle {
  runtime?: { version?: string; openURL?: (url: string) => void };
}

/** 前置条件不存在（如本地还没下载 pack）：标 skip，不计入标志。 */
export class ProbeSkip extends Error {}

interface ProbeBase {
  id: string;
  group: string;
  name: string;
  affects: string;
  /** 计入哪个能力标志；不填即不参与降级判定 */
  flag?: keyof CapabilityFlags;
}

/** 需要本地库与节点地址的条目：降级模式下不跑，直接标 fail。 */
interface LocalProbe extends ProbeBase {
  scope: 'local';
  run: (c: CheckContext, plus: PlusHandle | undefined) => Promise<string>;
}

/** 不依赖本地库的条目：降级模式下仍能跑。 */
interface StandaloneProbe extends ProbeBase {
  scope: 'standalone';
  run: (plus: PlusHandle | undefined) => Promise<string>;
}

type Probe = LocalProbe | StandaloneProbe;

const FIXED_SEED = '00'.repeat(32);
const PROBE_DIR = 'selfcheck';
const LOAD_DB_DOWN = '本地库不可用，未探测';
const RENDER_SEGMENTS = 800;
const B64_BYTES = 100 * 1024;

/** 12 条探测（spec §3）。顺序即自检页的展示顺序。 */
const PROBES: Probe[] = [
  {
    id: 'crypto.sqlite_random',
    group: '随机源',
    name: 'SQLite 随机源（randomblob）',
    affects: '发表评论、身份生成',
    flag: 'cryptoOk',
    scope: 'local',
    async run(c) {
      const rows = await c.db.select('SELECT hex(randomblob(32)) AS b');
      const hex = String(rows[0]?.b ?? '');
      if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`randomblob 返回异常（${hex.length} 字符）`);
      return '64 位 hex';
    },
  },
  {
    id: 'crypto.pool',
    group: '随机源',
    name: '随机池同步取数',
    affects: '发表评论、身份生成',
    flag: 'cryptoOk',
    scope: 'local',
    async run() {
      // 走真实链路：App 端 randomBytes 的兜底源就是启动预填的那个池
      const b = randomBytes(32);
      if (b.length !== 32) throw new Error(`取到 ${b.length} 字节，期望 32`);
      if (b.every((x) => x === 0)) throw new Error('取到全零字节');
      return '32 字节非全零';
    },
  },
  {
    id: 'crypto.sign',
    group: '随机源',
    name: 'ed25519 签名自洽',
    affects: '发表评论、升级验签',
    flag: 'cryptoOk',
    scope: 'standalone',
    async run() {
      // 固定种子：只验算法链路自洽，不消耗随机池（自检不能破坏被测对象）
      const kp = keyPairFromSeed(FIXED_SEED);
      const msg = utf8('selfcheck');
      if (!verify(kp.pubHex, msg, sign(FIXED_SEED, msg))) throw new Error('签名自验未通过');
      return '签名自验通过';
    },
  },
  {
    id: 'fs.bigfile',
    group: '文件/库',
    name: '大文件写读一致（1 MiB）',
    affects: '同步 pack、封面缓存',
    flag: 'fsOk',
    scope: 'local',
    async run(c) {
      const path = `${c.workDir}/${PROBE_DIR}/probe.bin`;
      // 不能用 randomBytes：App 端它会走随机池，1 MiB 会把池抽干
      const data = new Uint8Array(1 << 20);
      for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 8)) & 0xff;
      try {
        await c.adapters.fs.writeFile(path, data);
        const back = await c.adapters.fs.readFile(path);
        if (back.length !== data.length) throw new Error(`读回 ${back.length} 字节，写入 ${data.length} 字节`);
        for (let i = 0; i < data.length; i++) {
          if (back[i] !== data[i]) throw new Error(`第 ${i} 字节不符`);
        }
      } finally {
        await c.adapters.fs.remove(path);
      }
      return `${data.length} 字节读回一致`;
    },
  },
  {
    id: 'fs.meta',
    group: '文件/库',
    name: '文件元信息与删除',
    affects: '缓存清理、断点',
    flag: 'fsOk',
    scope: 'local',
    async run(c) {
      const path = `${c.workDir}/${PROBE_DIR}/meta.bin`;
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
      await c.adapters.fs.writeFile(path, data);
      try {
        if (!(await c.adapters.fs.exists(path))) throw new Error('写入后 exists 为假');
        const size = await c.adapters.fs.size(path);
        if (size !== data.length) throw new Error(`size 报 ${size}，写入 ${data.length}`);
      } finally {
        await c.adapters.fs.remove(path);
      }
      if (await c.adapters.fs.exists(path)) throw new Error('remove 后 exists 仍为真');
      return 'size / exists / remove 一致';
    },
  },
  {
    id: 'db.tx',
    group: '文件/库',
    name: '事务原子性（失败即回滚）',
    affects: 'applyPack 原子性',
    flag: 'dbOk',
    scope: 'local',
    async run(c) {
      await c.db.execute('CREATE TABLE IF NOT EXISTS selfcheck_probe(k TEXT)');
      const before = Number((await c.db.select('SELECT count(*) AS n FROM selfcheck_probe'))[0]?.n ?? 0);
      let failed = false;
      try {
        await c.db.tx([
          { sql: 'INSERT INTO selfcheck_probe(k) VALUES(?)', params: ['probe'] },
          { sql: 'INSERT INTO selfcheck_no_such_table(k) VALUES(?)', params: ['probe'] },
        ]);
      } catch {
        failed = true;
      }
      if (!failed) throw new Error('第二条语句本应失败，事务却成功了');
      const after = Number((await c.db.select('SELECT count(*) AS n FROM selfcheck_probe'))[0]?.n ?? 0);
      if (after !== before) throw new Error(`未回滚：行数 ${before} → ${after}`);
      return `回滚后行数不变（${before}）`;
    },
  },
  {
    id: 'db.pack',
    group: '文件/库',
    name: '已下载 pack 可只读打开',
    affects: '离线读书',
    flag: 'dbOk',
    scope: 'local',
    async run(c) {
      const packId = await c.repo.getConfig('pack_id');
      if (!packId) throw new ProbeSkip('本地尚无 pack（未同步过）');
      const path = `${c.workDir}/pack-${packId}.sqlite`;
      if (!(await c.adapters.fs.exists(path))) throw new ProbeSkip(`本地无 pack 文件 ${path}`);
      const conn = await c.adapters.packReader.open(path);
      let rows = 0;
      try {
        rows = Number((await conn.select('SELECT count(*) AS n FROM articles'))[0]?.n ?? 0);
      } finally {
        await c.adapters.packReader.close(conn);
      }
      return `articles ${rows} 行`;
    },
  },
  {
    id: 'net.tls_get',
    group: '网络',
    name: '节点读接口可访问',
    affects: '评论列表',
    scope: 'local',
    async run(c) {
      if (!c.nodeBaseUrl) throw new ProbeSkip('未配置节点地址');
      const res = await c.adapters.http.get(`${c.nodeBaseUrl}/v1/comment?limit=1`);
      if (res.status !== 200) throw new Error(`GET /v1/comment 返回 HTTP ${res.status}`);
      return 'HTTP 200';
    },
  },
  {
    id: 'net.release_verify',
    group: '网络',
    name: '升级文档拉取并验签',
    affects: '升级提示',
    scope: 'local',
    async run(c) {
      if (!c.nodeBaseUrl) throw new ProbeSkip('未配置节点地址');
      const pubHex = await c.repo.getConfig('pubkey_hex');
      if (!pubHex) throw new ProbeSkip('未配置节点公钥');
      const doc = await fetchReleaseDoc(c.adapters.http, c.nodeBaseUrl, pubHex);
      if (!doc) throw new Error('release 文档拉取或验签失败');
      return `version_name ${doc.payload.version_name}`;
    },
  },
  {
    id: 'net.event_write',
    group: '网络',
    name: '写入一条自检事件',
    affects: '发表评论',
    flag: 'writeOk',
    scope: 'local',
    async run(c) {
      if (!c.nodeBaseUrl) throw new ProbeSkip('未配置节点地址');
      // 走真实发表链路：身份 → 签名 → POST /v1/event，正是 0.4.1 修坏过的那条
      const r = await postComment(
        { adapters: c.adapters, repo: c.repo, nodeBaseUrl: c.nodeBaseUrl },
        { targetId: SELFCHECK_TARGET, text: SELFCHECK_TARGET },
      );
      return `200 回执 event_id ${r.eventId.slice(0, 8)}`;
    },
  },
  {
    id: 'net.open_url',
    group: '网络',
    name: '外部链接打开能力',
    affects: '升级下载',
    scope: 'standalone',
    async run(plus) {
      if (typeof plus?.runtime?.openURL !== 'function') throw new Error('plus.runtime.openURL 不存在');
      return 'plus.runtime.openURL 可用';
    },
  },
  {
    id: 'render.memory',
    group: '渲染',
    name: '长正文分段与 base64 往返',
    affects: '阅读器、封面',
    scope: 'standalone',
    async run() {
      const body = Array.from({ length: RENDER_SEGMENTS }, (_, i) => `p${i}${'x'.repeat(60)}`).join('\n\n');
      const segs = body.split('\n\n').length;
      if (segs !== RENDER_SEGMENTS) throw new Error(`分段数不符：${segs}`);
      const bin = new Uint8Array(B64_BYTES);
      for (let i = 0; i < bin.length; i++) bin[i] = (i * 31 + (i >> 8)) & 0xff;
      const back = base64ToBytes(bytesToBase64(bin));
      if (back.length !== bin.length) throw new Error(`base64 往返长度不符：${back.length} != ${bin.length}`);
      for (let i = 0; i < bin.length; i++) {
        if (back[i] !== bin[i]) throw new Error(`base64 往返第 ${i} 字节不符`);
      }
      return `${utf8(body).length} 字节正文分 ${segs} 段；${bin.length} 字节 base64 往返一致`;
    },
  },
];

export const DEFAULT_TIMEOUT_MS = 5000;

export interface SelfCheckOptions {
  /** 单条探测超时（毫秒），默认 5000：自签 TLS 挂死不能卡住整页 */
  timeoutMs?: number;
  /** plus 句柄；默认取 platform/uni 的 plusRuntime()，Node 测试传假对象 */
  plus?: PlusHandle | undefined;
}

class ProbeTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeout(`超时（>${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 把一次探测的成败收敛成一条结果：抛错即 fail，`ProbeSkip` 即 skip。 */
async function settle(
  base: Omit<CheckResult, 'status' | 'detail'>,
  work: () => Promise<string>,
  timeoutMs: number,
): Promise<CheckResult> {
  try {
    return { ...base, status: 'ok', detail: await withTimeout(work(), timeoutMs) };
  } catch (e) {
    if (e instanceof ProbeSkip) return { ...base, status: 'skip', detail: e.message };
    if (e instanceof ProbeTimeout) return { ...base, status: 'fail', detail: e.message };
    return { ...base, status: 'fail', detail: (e as Error).message ?? String(e) };
  }
}

/**
 * 跑一遍自检。
 *
 * `ctx` 为 null 即降级模式（bootstrap 失败）：只跑不依赖本地库的条目（3、11、12），
 * 其余标 fail 并写明原因——本地库坏了也要能出报告（spec §4）。
 */
export async function runSelfCheck(ctx: CheckContext | null, o: SelfCheckOptions = {}): Promise<SelfCheckReport> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const plus = 'plus' in o ? o.plus : plusRuntime();

  const items: CheckResult[] = [];
  for (const p of PROBES) {
    const base = { id: p.id, group: p.group, name: p.name, affects: p.affects };
    if (p.scope === 'standalone') {
      items.push(await settle(base, () => p.run(plus), timeoutMs));
    } else if (ctx === null) {
      items.push({ ...base, status: 'fail', detail: LOAD_DB_DOWN });
    } else {
      items.push(await settle(base, () => p.run(ctx, plus), timeoutMs));
    }
  }

  // 一个标志覆盖多条探测：任一条 fail → fail；skip 不影响；全部未跑 → 保持 unknown（spec §3）
  const byFlag: Record<keyof CapabilityFlags, CheckStatus[]> = {
    cryptoOk: [],
    fsOk: [],
    dbOk: [],
    writeOk: [],
  };
  PROBES.forEach((p, i) => {
    if (p.flag) byFlag[p.flag].push(items[i].status);
  });
  const flags: CapabilityFlags = { ...UNKNOWN_FLAGS };
  for (const key of FLAG_KEYS) {
    const st = byFlag[key].filter((s) => s !== 'skip');
    if (st.length === 0) continue;
    flags[key] = st.includes('fail') ? 'fail' : 'ok';
  }

  return { at: new Date().toISOString(), degraded: ctx === null, items, flags };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/selfcheck.test.ts`

Expected: PASS（8 个用例）

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`

Expected: 无输出

- [ ] **Step 6: 提交**

```bash
git add apps/mobile/src/core/selfcheck.ts apps/mobile/src/core/selfcheck.test.ts
git commit -m "feat(mobile): 12 条基座能力探测与 runSelfCheck（自检 spec §3/§5）"
```

---

### Task 4: 装配 capabilities 与 applySelfCheck

**Files:**
- Modify: `apps/mobile/src/platform/index.ts`

- [ ] **Step 1: 改 `AppContext` 与 `bootstrap()`**

把 `apps/mobile/src/platform/index.ts` 改成：

```ts
import { hexToBytes } from '@base/protocol-ts';

import { ENTROPY_FILL_BYTES, installRandomFallback } from '../core/entropy';
import { SCHEMA_SQL, SqlRepo, type LocalRepo } from '../core/repo';
import { UNKNOWN_FLAGS, type CapabilityFlags, type SelfCheckReport } from '../core/selfcheck';
import type { SyncOptions } from '../core/sync';
import type { Adapters, LocalDb } from './adapter';
import { PlusFs, PlusHttp, PlusLocalDb, PlusPackReader, PlusStorage, assertAppRuntime } from './uni';

export interface AppContext {
  opts: SyncOptions;
  repo: LocalRepo;
  db: LocalDb;
  /** 平台能力标志：只有明确 fail 才降级，unknown 与 ok 都照常尝试（selfcheck spec §4） */
  capabilities: CapabilityFlags;
}

let cached: AppContext | null = null;

/** 建表 + 组装适配器；重复调用复用同一实例。 */
export async function bootstrap(): Promise<AppContext> {
  if (cached) return cached;
  const p = assertAppRuntime();
  const fs = new PlusFs(p);
  const root = await fs.rootDir();
  await fs.ensureDir(root);

  const db = new PlusLocalDb(p, `${root}/base.db`);
  for (const sql of SCHEMA_SQL) await db.execute(sql);

  // 冷启动只定 cryptoOk：随机池预填的成败就是随机源可用与否的初值；其余标志保持 unknown
  const capabilities: CapabilityFlags = { ...UNKNOWN_FLAGS };

  // 逻辑层没有 WebCrypto，随机源改由 SQLite 提供（randomblob 的种子来自系统熵源）
  try {
    await installRandomFallback(async () => {
      const rows = await db.select(`SELECT hex(randomblob(${ENTROPY_FILL_BYTES})) AS b`);
      return hexToBytes(String(rows[0]?.b ?? ''));
    });
    capabilities.cryptoOk = 'ok';
  } catch {
    // 预填失败不阻断启动：评论页据此直接禁用发表并给出原因，不再等用户点一次才报错
    capabilities.cryptoOk = 'fail';
  }

  const repo = new SqlRepo(db);
  const adapters: Adapters = {
    fs,
    storage: new PlusStorage(),
    http: new PlusHttp(),
    packReader: new PlusPackReader(p),
  };
  const nodeBaseUrl = ((await repo.getConfig('node_base_url')) ?? '').replace(/\/+$/, '');
  cached = { repo, db, opts: { adapters, repo, nodeBaseUrl, workDir: root }, capabilities };
  return cached;
}

/** 节点地址保存后刷新缓存里的 baseUrl */
export function updateNodeBaseUrl(baseUrl: string): void {
  if (cached) cached.opts.nodeBaseUrl = baseUrl.replace(/\/+$/, '');
}

/** 自检跑完后把标志写回缓存：评论页与课程页据此决定是否禁用入口。 */
export function applySelfCheck(report: SelfCheckReport): void {
  if (cached) cached.capabilities = report.flags;
}
```

- [ ] **Step 2: 类型检查**

Run（cwd `e:\code\base\apps\mobile`）: `npx tsc --noEmit`

Expected: 无输出

- [ ] **Step 3: 确认没有循环依赖导致构建失败**

Run（cwd `e:\code\base\apps\mobile`）: `npm run build:app`

Expected: 构建成功（`dist/build/app` 产出），无 `Circular dependency` 警告

- [ ] **Step 4: 提交**

```bash
git add apps/mobile/src/platform/index.ts
git commit -m "feat(mobile): AppContext 装配能力标志，bootstrap 定 cryptoOk 初值"
```

---

### Task 5: 自检页与入口

**Files:**
- Create: `apps/mobile/src/pages/selfcheck/selfcheck.vue`
- Modify: `apps/mobile/src/pages.json`
- Modify: `apps/mobile/src/pages/setting/setting.vue`

- [ ] **Step 1: 新建页面**

创建 `apps/mobile/src/pages/selfcheck/selfcheck.vue`：

```vue
<template>
  <view class="wrap">
    <view class="bar">
      <text class="title">基座自检</text>
      <text class="act" @click="run">重跑</text>
    </view>

    <text v-if="running" class="hint">探测中…</text>
    <text v-if="degraded" class="warn">本地库不可用，本次为降级自检（只跑不依赖本地库的条目）</text>

    <view v-for="g in groups" :key="g.name" class="grp">
      <text class="grp-name">{{ g.name }}</text>
      <view v-for="r in g.items" :key="r.id" class="row">
        <text class="mark">{{ mark(r.status) }}</text>
        <view class="body">
          <text class="row-name">{{ r.name }}</text>
          <text class="row-detail">{{ r.detail }}</text>
          <text class="row-affects">影响：{{ r.affects }}</text>
        </view>
      </view>
    </view>

    <text v-if="flagsLine" class="meta">{{ flagsLine }}</text>
    <button size="mini" class="copy" :disabled="items.length === 0" @click="copy">复制结果</button>
    <text v-if="tip" class="hint">{{ tip }}</text>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { applySelfCheck, bootstrap } from '../../platform';
import { plusRuntime } from '../../platform/uni';
import { runSelfCheck, type CheckResult, type SelfCheckReport } from '../../core/selfcheck';

const report = ref<SelfCheckReport | null>(null);
const running = ref(false);
const tip = ref('');

const items = computed<CheckResult[]>(() => report.value?.items ?? []);
const degraded = computed(() => report.value?.degraded === true);

/** 按 group 聚合，保持探测表的原始顺序（不二次排序） */
const groups = computed(() => {
  const out: Array<{ name: string; items: CheckResult[] }> = [];
  for (const r of items.value) {
    const last = out[out.length - 1];
    if (last && last.name === r.group) last.items.push(r);
    else out.push({ name: r.group, items: [r] });
  }
  return out;
});

const flagsLine = computed(() => {
  const f = report.value?.flags;
  if (!f) return '';
  const show = (v: string) => (v === 'ok' ? 'ok' : v === 'fail' ? 'fail' : '未测');
  return `能力：随机源 ${show(f.cryptoOk)} / 文件 ${show(f.fsOk)} / 本地库 ${show(f.dbOk)} / 写入 ${show(f.writeOk)}`;
});

function mark(s: CheckResult['status']): string {
  return s === 'ok' ? '✅' : s === 'fail' ? '❌' : '➖';
}

async function run() {
  running.value = true;
  tip.value = '';
  try {
    // bootstrap 失败也得能出报告：此时以降级模式跑（spec §4）
    const app = await bootstrap().catch(() => null);
    const r = await runSelfCheck(
      app
        ? {
            adapters: app.opts.adapters,
            repo: app.repo,
            db: app.db,
            nodeBaseUrl: app.opts.nodeBaseUrl,
            workDir: app.opts.workDir,
          }
        : null,
      { plus: plusRuntime() },
    );
    report.value = r;
    applySelfCheck(r);
  } catch (e) {
    tip.value = `自检执行失败：${(e as Error).message}`;
  } finally {
    running.value = false;
  }
}

/** 复制文本与页面展示同源：贴回对话就能定位（spec §5）。 */
function copy() {
  const r = report.value;
  if (!r) return;
  const lines = r.items.map((i) => `${mark(i.status)} ${i.name} — ${i.detail}（影响：${i.affects}）`);
  lines.push(flagsLine.value);
  lines.push(`版本：${String(plusRuntime()?.runtime?.version ?? '未知')}`);
  uni.setClipboardData({
    data: lines.join('\n'),
    success: () => {
      tip.value = '已复制';
    },
  });
}

onLoad(() => {
  void run();
});
</script>

<style>
.wrap { padding: 16px; padding-bottom: 40px; }
.bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.title { font-size: 20px; font-weight: 600; }
.act { color: #2b6cb0; font-size: 14px; }
.hint { display: block; color: #888888; font-size: 13px; }
.warn { display: block; margin-bottom: 8px; color: #c05621; font-size: 13px; }
.grp { margin-top: 16px; }
.grp-name { display: block; color: #888888; font-size: 13px; margin-bottom: 4px; }
.row { display: flex; padding: 8px 0; border-bottom: 1px solid #eeeeee; }
.mark { width: 24px; font-size: 15px; }
.body { flex: 1; }
.row-name { display: block; font-size: 15px; }
.row-detail { display: block; color: #666666; font-size: 12px; margin-top: 2px; }
.row-affects { display: block; color: #999999; font-size: 12px; margin-top: 2px; }
.meta { display: block; margin-top: 16px; color: #666666; font-size: 12px; }
.copy { margin-top: 16px; }
</style>
```

- [ ] **Step 2: 注册路由**

把 `apps/mobile/src/pages.json` 的 `pages` 数组改成（在 `pages/setting/setting` 之后插入一项）：

```json
    {
      "path": "pages/setting/setting",
      "style": { "navigationBarTitleText": "设置" }
    },
    {
      "path": "pages/selfcheck/selfcheck",
      "style": { "navigationBarTitleText": "基座自检" }
    },
```

- [ ] **Step 3: 设置页加入口**

把 `apps/mobile/src/pages/setting/setting.vue` 的模板中这一段：

```html
    <button size="mini" class="probe" @click="probe">能力诊断</button>
```

换成：

```html
    <view class="acts">
      <button size="mini" class="probe" @click="probe">能力诊断</button>
      <button size="mini" class="probe" @click="openSelfCheck">基座自检</button>
    </view>
```

并在 `apps/mobile/src/pages/setting/setting.vue` 的 `<script setup lang="ts">` 里、`checkUpdate` 之后加：

```ts
/** 自检页承载 12 条探测与降级标志；本页的「能力诊断」保持开发向的原始行输出不变。 */
function openSelfCheck() {
  uni.navigateTo({ url: '/pages/selfcheck/selfcheck' });
}
```

并在底部 `<style>` 里把 `.probe { margin-top: 24px; }` 换成：

```css
.acts { display: flex; margin-top: 24px; }
.probe { margin-right: 8px; }
```

- [ ] **Step 4: 类型检查 + 构建**

Run（cwd `e:\code\base\apps\mobile`）: `npx tsc --noEmit && npm run build:app`

Expected: 无输出（类型）/ 构建成功

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/pages/selfcheck/selfcheck.vue apps/mobile/src/pages.json apps/mobile/src/pages/setting/setting.vue
git commit -m "feat(mobile): 自检页与设置页入口（自检 spec §6）"
```

---

### Task 6: 降级落点（评论页 / 课程页）

**Files:**
- Modify: `apps/mobile/src/pages/comment/comment.vue`
- Modify: `apps/mobile/src/pages/course/course.vue`

- [ ] **Step 1: 评论页读标志**

在 `apps/mobile/src/pages/comment/comment.vue` 的 import 段（`import { bootstrap } from '../../platform';` 之后）加：

```ts
import {
  UNKNOWN_FLAGS,
  canPostComment,
  postBlockedReason,
  SELFCHECK_TARGET,
  type CapabilityFlags,
} from '../../core/selfcheck';
```

把这一段：

```ts
const canSend = computed(() => target.value !== '' && draft.value.trim() !== '' && !sending.value);
```

换成：

```ts
/** 能力标志：启动时只有 cryptoOk 有值，其余 unknown（unknown 不降级） */
const caps = ref<CapabilityFlags>(UNKNOWN_FLAGS);
const blocked = computed(() => postBlockedReason(caps.value));
const canSend = computed(
  () => canPostComment(caps.value) && target.value !== '' && draft.value.trim() !== '' && !sending.value,
);
```

在 `load()` 里把这一段：

```ts
    opts.value = { adapters: ctx.opts.adapters, repo: ctx.repo, nodeBaseUrl: ctx.opts.nodeBaseUrl };
```

换成：

```ts
    opts.value = { adapters: ctx.opts.adapters, repo: ctx.repo, nodeBaseUrl: ctx.opts.nodeBaseUrl };
    caps.value = ctx.capabilities;
```

- [ ] **Step 2: 评论页过滤自检事件**

在 `apps/mobile/src/pages/comment/comment.vue` 的 `withText` 函数**之前**插入：

```ts
/** 自检事件是探测产物，不是用户内容：任何列表都不展示（selfcheck spec §7）。 */
function visible(rows: CommentItem[]): CommentItem[] {
  return rows.filter((r) => r.targetId !== SELFCHECK_TARGET);
}
```

把 `refresh()` 里的：

```ts
    list.value = await withText(page.items, opts.value);
```

换成：

```ts
    list.value = await withText(visible(page.items), opts.value);
```

把 `loadMore()` 里的：

```ts
    list.value = [...list.value, ...(await withText(page.items, opts.value))];
```

换成：

```ts
    list.value = [...list.value, ...(await withText(visible(page.items), opts.value))];
```

- [ ] **Step 3: 评论页原位显示原因**

在 `apps/mobile/src/pages/comment/comment.vue` 的模板里，把这一行：

```html
    <view class="composer">
```

改成：

```html
    <text v-if="blocked" class="blocked">{{ blocked }}</text>
    <view class="composer">
```

并在底部 `<style>` 里 `.composer` 规则**之前**加：

```css
.blocked { display: block; margin-bottom: 8px; color: #c05621; font-size: 13px; }
```

- [ ] **Step 4: 课程页读标志**

在 `apps/mobile/src/pages/course/course.vue` 的 `import { bootstrap } from '../../platform';` 之后加：

```ts
import { canSync } from '../../core/selfcheck';
```

在 `const busy = ref(false);` 之后加：

```ts
const syncBlocked = ref(false);
```

在 `load()` 里把：

```ts
    const { repo } = await bootstrap();
```

换成：

```ts
    const { repo, capabilities } = await bootstrap();
    syncBlocked.value = !canSync(capabilities);
```

把模板里的：

```html
      <button size="mini" :disabled="busy" @click="doSync">{{ busy ? '同步中…' : '同步' }}</button>
```

换成：

```html
      <button size="mini" :disabled="busy || syncBlocked" @click="doSync">{{ busy ? '同步中…' : '同步' }}</button>
```

并在 `<text v-if="error" class="error">{{ error }}</text>` 之后加：

```html
    <text v-if="syncBlocked" class="error">本地文件不可写，无法同步（设置 → 基座自检 可看原因）</text>
```

- [ ] **Step 5: 类型检查 + 构建**

Run（cwd `e:\code\base\apps\mobile`）: `npx tsc --noEmit && npm run build:app`

Expected: 无输出（类型）/ 构建成功

- [ ] **Step 6: 全量测试**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run`

Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add apps/mobile/src/pages/comment/comment.vue apps/mobile/src/pages/course/course.vue
git commit -m "feat(mobile): 评论与同步按能力标志禁用并原位说明（自检 spec §4）"
```

---

### Task 7: 版本 0.5.0、全量自测、提交与推送

**Files:**
- Modify: `apps/mobile/src/manifest.json`

- [ ] **Step 1: 改版本号**

把 `apps/mobile/src/manifest.json` 里的：

```json
    "versionName" : "0.4.1",
    "versionCode" : "5",
```

改成：

```json
    "versionName" : "0.5.0",
    "versionCode" : "6",
```

- [ ] **Step 2: 全量自测**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run && npx tsc --noEmit && npm run build:app`

Expected: 单测全绿、类型无输出、构建成功

再跑 protocol-ts（cwd `e:\code\base\packages\protocol-ts`）: `npx vitest run && npx tsc --noEmit`

Expected: 全绿（不回归）

- [ ] **Step 3: 提交并推送**

```bash
git add apps/mobile/src/manifest.json
git commit -m "chore(mobile): 版本 0.5.0（基座自检与功能级降级）"
git push
```

- [ ] **Step 4: 复核产物含新代码**

Run（cwd `e:\code\base\apps\mobile`）: `Select-String -Path dist\build\app\app-service.js -Pattern '基座自检','selfcheck','randomblob' -SimpleMatch | Select-Object -First 5`

Expected: 至少命中 `基座自检` 与 `selfcheck`（证明自检页进了产物）

---

### Task 8: 云打包与发布

**Files:**
- Create: `apps/mobile/dist/release/apk/base-0.5.0.apk`（由云打包产物另存）

- [ ] **Step 1: 云打包**

Run（任意 cwd）:

```
D:\HBuilderX\cli.exe pack --project e:\code\base\apps\mobile --platform android --android.packagename uni.app.UNI936A667 --android.androidpacktype 3
```

Expected: 打印一个临时下载地址（5 次有效）。**必须自己把 APK 下载并另存到** `e:\code\base\apps\mobile\dist\release\apk\base-0.5.0.apk` —— CLI 不会把它落到该目录（0.4.1 的坑）。

- [ ] **Step 2: 记录本地包指纹**

Run（cwd `e:\code\base\apps\mobile`）:

```bash
certutil -hashfile dist\release\apk\base-0.5.0.apk SHA256
```

Expected: 打印 sha256（后续与线上 `apk_sha256` 比对）

- [ ] **Step 3: 核对签名证书未变（可覆盖安装）**

Run（cwd `e:\code\base\apps\mobile`）:

```bash
keytool -printcert -jarfile dist\release\apk\base-0.5.0.apk
```

Expected: `SHA1: 19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`（与 0.4.1 一致）。

**只用 `keytool` 指纹判断证书**：`META-INF/CERT.RSA` 的文件字节哈希会因打包细节不同而变，不能用它判断换没换证书。

- [ ] **Step 4: 上传 APK 并更新落地页**

```bash
scp e:\code\base\apps\mobile\dist\release\apk\base-0.5.0.apk me:/opt/appdl/base-0.5.0.apk
ssh me "sed -i 's/base-0.4.1.apk/base-0.5.0.apk/g' /opt/appdl/index.html && grep -o 'base-0.[0-9.]*.apk' /opt/appdl/index.html"
```

Expected: `grep` 输出 `base-0.5.0.apk`

- [ ] **Step 5: 签发升级文档**

`-notes` 必须是**不含空格的一个 token**（空格会被 Go flag 解析吃掉，导致后面的 `-out` 失效、文档落到源节点目录）:

```bash
ssh me "BASE_SIGN_KEY=37a6f57960600162228f272f0e33b062a9e5d06e33c218d932afb68c07feb0ce /opt/base/based release -version-name 0.5.0 -min-version-name 0.4.0 -apk-url http://118.190.217.242/dl/base-0.5.0.apk -apk-file /opt/appdl/base-0.5.0.apk -notes 新增基座自检：12项平台能力探测、真实原因、不可用时功能级降级 -out /opt/base-cache/data/release.json"
```

Expected: 打印 `version_name=0.5.0`、`apk_size`、`apk_sha256`；`apk_sha256` 与 Step 2 的本地指纹一致。

若误写了副本，清掉：`ssh me "rm -f /opt/base/data/release.json"`

- [ ] **Step 6: 线上验证**

```bash
ssh me "curl -sS http://127.0.0.1/v1/release"
curl -sS -o NUL -w '%{http_code} %{size_download}\n' http://118.190.217.242/dl/base-0.5.0.apk
```

Expected: `/v1/release` 返回 `version_name":"0.5.0"` 的文档；APK `200` 且 `size_download` 与文档 `apk_size` 一致。

用客户端验签器核对（在仓库根跑一次性 TS 脚本或复用既有验证脚本），`verifyRelease(doc, '48c33db9cf859e107fe89651d15fc5faaa8b16ffbb7d4b483aa167a0cff824f4')` 为 `true`。

---

### Task 9: 真机验收与回填

**Files:**
- Modify: `docs/superpowers/plans/2026-09-27-base-selfcheck-plan.md`（回填执行期更正）
- Modify: `docs/superpowers/plans/2026-09-27-base-mobile-release-plan.md`（§执行期更正 加第 13 条）

- [ ] **Step 1: 装机跑自检（对照 spec §9 逐条打勾）**

| # | 验收项 | 判定 |
| --- | --- | --- |
| 1 | 12 条一屏出结果 | 无卡死、无「提交失败」式通用文案 |
| 2 | 第 10 条 | 页面显示 `200 回执 event_id …`；节点侧 `/v1/comment?target_id=selfcheck&limit=1` 能查到这条 |
| 3 | 列表过滤 | 评论页「全部最新」不出现 `selfcheck` |
| 4 | 复制结果 | 粘贴出来含 12 行 + flags + 版本号 |
| 5 | 降级可见 | 临时断网重跑 → 第 10 条 fail → 评论页发表按钮禁用并显示原因；恢复网络重跑后恢复可用 |
| 6 | 无污染 | 自检后 `_doc/base/selfcheck/` 为空；`selfcheck_probe` 行数为 0 |

- [ ] **Step 2: 回填执行期更正**

把上面 6 条的实际结果、与计划不符之处（命令、字段、判定口径）追加到本文件的「执行期更正」小节，并在 `2026-09-27-base-mobile-release-plan.md` 的「§执行期更正」里加第 13 条（0.5.0 发布实况：APK 大小与 sha256、证书指纹、`release.json` 内容、验证结果）。

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/plans/2026-09-27-base-selfcheck-plan.md docs/superpowers/plans/2026-09-27-base-mobile-release-plan.md
git commit -m "docs(plans): 回填 0.5.0 自检发布实况与执行期更正"
git push
```

---

## 执行期更正

**提交链（已 push 到 origin/master）**：T1 `b70f8ab` → T2 `30a306b` → T3 `4bf61b3` → T4 `2ff044e` → T5 `69b0f22` → T6 `a33080e` → T7 `a3571b5`（版本 0.5.0）。

**测试基线**：mobile 77 → **85**（本册子新增 `selfcheck.test.ts` 8 项：T1 的 3 条判定 + T3 的 5 条探测）；protocol-ts 保持 51 项。

1. **本机是 PowerShell 5.1，不支持 `&&`**：计划 T5/T6/T7 里的 `npx tsc --noEmit && npm run build:app`、`npx vitest run && npx tsc --noEmit` 要拆成逐条执行（`&&` 直接 ParserError）。
2. **「Step 2 跑测试确认失败」的实际报错文案与预期不同**（不影响结论，失败仍如期发生）：T1 报 `Cannot find module './selfcheck'`（计划预期 `Failed to resolve import`）；T3 报 `runSelfCheck is not a function`（计划预期 `does not provide an export named`）——因为文件已存在、只是缺导出。
3. **T6 的 `blocked` 文案落点**：`<text v-if="blocked">` 插在 `.composer` 之前，而 `.composer` 是 `position: fixed`，因此该文案落在列表末尾、固定输入栏上方（真机观感待 T9 第 5 项验收时确认）。
4. **T8 打包与下载的环境适配**（均为环境问题，未改业务参数）：
   - `keytool` 不在 PATH，用 HBuilderX 自带的 `D:\HBuilderX\plugins\amazon-corretto\bin\keytool.exe`。
   - APK 内嵌 manifest 的真实路径是 `assets/apps/__UNI__936A667__/www/manifest.json`（不是计划假设的 `www/manifest.json`）。
   - 本地 `curl.exe` 下载云打包临时地址报 `getaddrinfo() thread failed`（域名可解析），改用 `Invoke-WebRequest`（显式 TLS1.2）成功。
   - PowerShell 里 `curl.exe -w` 的占位符写**单** `%`（`%%` 会输出字面量）；`ssh` 远程命令内的**双引号会被剥掉**（`ssh me 'curl -w "%{http_code} %{size_download}"'` 实测被拆成非法参数并回吐二进制），核对下载用 `curl -sSI` 看 `Content-Length` 更省事。
5. **0.5.0 发布实况（对照计划 Task 8）**：
   - APK：`dist/release/apk/base-0.5.0.apk`，**27373900 字节**，sha256 `4a327647850eaa18b07cdcf393606d3182f6257248e11b9b6e25833da6d598d7`；内嵌 `version.name=0.5.0` / `version.code=6`。
   - 证书：DCloud 云证书 SHA1 `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`，与 0.4.1 一致（可覆盖安装）。
   - 上线：APK → `/opt/appdl/base-0.5.0.apk`，`/opt/appdl/index.html` 指向 `base-0.5.0.apk`；`release.json` 落 `/opt/base-cache/data/release.json`（`issued_at 2026-09-27T16:49:21Z`，`min_version_name 0.4.0`，`notes` 为不含空格的一个 token，按计划签发）；未产生误写副本。
   - 线上验证：`GET /v1/release` 200 且 `apk_size=27373900` 与文档一致；`/dl/base-0.5.0.apk` 200 / `Content-Length 27373900`；**验签用独立实现复核为 true**（Node 原生 ed25519 + JCS 规范化，不共享仓库 TS 验签器代码，公钥 `48c33db9…24f4`）。
   - **产物复核（防「版本号新、功能旧」）**：从**已发布的 APK** 内（`assets/apps/__UNI__936A667/www/`）取出 `app-service.js`（162910 字节）逐串核对，`基座自检`、`selfcheck`、`selfcheck_probe`、`randomblob`、降级文案 `随机源不可用` / `节点未接受写入`（评论页）与 `本地文件不可写`（课程页）**全部命中**；`app-config-service.js` 含路由 `pages/selfcheck/selfcheck`；`manifest.json` 为 `0.5.0`。即云打包抓到的确实是本次构建产物。
6. **T9 第 1 项（真机 6 条验收）待装机后回填**：计划 Step 1 的 6 条判定需要真机操作，本小节先记发布实况，真机结果待补。

---

## 自检清单（写完计划后核过）

**Spec 覆盖**：§3 的 12 条 → Task 3；§4 的标志/降级 → Task 1（判定）+ Task 4（初值）+ Task 6（落点）；§5 的报告结构 → Task 1（类型）+ Task 5（展示与复制）；§6 页面与入口 → Task 5；§7 污染控制 → Task 3 的探测实现与用例 1 断言；§8 测试 → Task 1/3；§9 真机验收 → Task 9；§11 红线 → 未改节点、未改 sync/update/comment 语义、未加外部依赖。

**与 spec 的两处实现期细化（已同步到 spec §4/§2）**：

1. 降级模式只跑 3、11、12 —— 第 8、9 条需要 `adapters` 与 `nodeBaseUrl`，而 `nodeBaseUrl` 存在本地库里，降级时拿不到。
2. 降级判定的入口是纯函数 `canPostComment(flags)` / `canSync(flags)`，只收标志，不持报告；原位原因给出「设置 → 基座自检」指引，具体原因在自检页读。

**额外一条用例**：spec §8 列了 5 条，本计划加了用例 6（本地无 pack → 第 7 条 `skip`，`dbOk` 仍 `ok`），覆盖 `skip 不影响标志` 这条约定。