# 创作者可见性闭环（缺陷批次）实施计划（册子 #56 → 计划 #57）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地册子 `#56` 的 §2.1–§2.6 全部契约——修掉 ① 本地乐观落库（`items.source='local'`，本机立即可读）；② 「我创建的」去重判据收窄为「非 local 来源」；③ 容器台账行重放**归一化重建**（`ledgerSegmentsOf → containerFormFromLedger → buildContainerSegments`，不用 `segments_json` 原文）；④ 一次性自愈迁移（幂等标志位 `creator_visibility_migrated` 落本地 `config`；仍被 4xx 拒 ⇒ 终态「仅本地留存」且不再进重放队列）；⑤ 详情页取键统一（台账入口与普通入口同口径：先试 `raw` 再试 `decodedId(raw)`）；⑥ 文案如实（`sent` → 「已提交 · 待节点收录」；同步按钮三态 `noop`/成功/失败）。覆盖册子 §5 的 AC 1–8。

**Architecture:** **只动 `apps/mobile`，零节点改动、零新 HTTP 接口、零新表、不 bump `schema_version`、不做 iOS。** `LocalRepo` 扩两个方法（`upsertLocalContainer` 同事务写 `items`+`segments`；`markSubmissionLocalOnly` 置终态标记）；`my_submissions` 仅**新增一列** `local_only`（既有列语义一字不改）；`submit.ts` 的容器重放改走归一化重建；新增纯编排模块 `core/creator-migrate.ts`（可 Node 单测）。页面层只做「去重实参收窄 + 三态反馈 + 取键统一 + 删除入口」，模板禁 `.value` 写法。

**Tech Stack:** TypeScript + Vue 3 + uni-app（`apps/mobile`）／ vitest ／ `core/fakes.ts`（`MemoryRepo` / `FakeHttp` 假适配器）／ SQLite（`plus.sqlite`，仅真机）／ Vue SFC（`<template>` 禁 `.value`）。

**上游 spec:** `docs/superpowers/specs/2026-10-01-base-creator-visibility-design.md`（册子 `#56`）；直接上游 `docs/superpowers/specs/2026-09-30-base-governance-visibility-design.md`（`#51`）与 `docs/superpowers/plans/2026-09-30-base-governance-visibility-plan.md`（`#52`）；容器契约 `docs/superpowers/specs/2026-09-30-base-course-lesson-edit-design.md`（`#40`）；投稿拒绝口径 `docs/superpowers/specs/2026-09-28-base-submission-design.md`（`#25`）；台账 `docs/superpowers/specs/2026-09-28-base-creation-ui-design.md`（`#29`）。

---

## 开工前已核实的现状（执行时直接用，不要重新调研）

| 事实 | 位置 |
| --- | --- |
| `LocalRepo` 接口（同步核心 + 台账六方法 + 进度四方法等） | `apps/mobile/src/core/repo.ts:19-115` |
| `SCHEMA_SQL` 建表语句；`my_submissions` DDL（列 `item_id,type,title,body_md,question_json,links_json,segments_json,state,reason,created,queued_at,sent_at`，**无** `local_only`） | `apps/mobile/src/core/repo.ts:118-168`（台账 DDL 在 `:144-148`） |
| `ensureSubmissionColumns`：`PRAGMA table_info` 查列名、缺则 `ALTER TABLE ... ADD COLUMN`（既有幂等补列手法） | `apps/mobile/src/core/repo.ts:188-196` |
| `ensureSubmissionColumns` 的调用点（建表之后） | `apps/mobile/src/platform/index.ts:31` |
| `SqlRepo` 实现自 `:219`；`getConfig/setConfig` `:222-232` | `apps/mobile/src/core/repo.ts:219-232` |
| 台账六方法实现：`saveSubmission` `:554-564`、`listSubmissions` `:566-572`、`getSubmission` `:574-580`、`markSubmissionSent` `:582-588`、`markSubmissionFailed` `:590-592`、`removeSubmission` `:594-596` | `apps/mobile/src/core/repo.ts:554-596` |
| `toMySubmissionRow`：`type` 归一化、`state` 归一化 `sent\|failed\|pending` | `apps/mobile/src/core/repo.ts:754-773` |
| `my-created.ts`：`statusLabelOf` `:24-33`（`sent` → 「已同步」）、`buildMyCreatedView` `:41-56`（去重判据在 `:45`）、`ledgerSegmentsOf` `:62-78`、`containerFormFromLedger` `:84-98` | `apps/mobile/src/core/my-created.ts:24-98` |
| `submit.ts`：`SubmitDraft` `:26-37`、`isPermanentSubmitFailure` `:229-231`、`writeLedger` `:275-293`、`enqueueOrSend` `:310-330`、`flushSubmissions` `:347-359`、`runFlushSubmissions` `:361-395`（**只取 `pending`**；永久失败 ⇒ `markSubmissionFailed` 后继续；暂时失败 ⇒ break）、`decodeLedgerSegments` `:410-419`（模块私有） | `apps/mobile/src/core/submit.ts:26-419` |
| `course-edit.ts`：`ContainerForm` `:53-77`、`emptyContainerForm` `:80-97`、`buildContainerSegments` `:113-133`（属性行经 `assignAttrSeqs`）、`loadContainerForm` `:136-154`、`saveContainer` `:161-169`（当前只 `enqueueOrSend`） | `apps/mobile/src/core/course-edit.ts:53-169` |
| `attrs.ts`：`assignAttrSeqs` `:96-120`、`SubmitSegmentRow` `:138-142`、`segmentsContentHash` `:148-151`（按 seq 升序拼 `"<kind>\t<text>\n"` 的 sha256，与 Go `store.SegmentsContentHash` 同构） | `apps/mobile/src/core/attrs.ts:96-151` |
| `types.ts`：`ItemRow` `:1-11`、`SegmentRow` `:52-58`、`MySubmissionRow` `:109-132`（`state ∈ pending\|sent\|failed`，**无**「仅本地留存」列） | `apps/mobile/src/core/types.ts:1-132` |
| `fakes.ts`：`MemoryRepo` `:43`+（`items` / `segments` / `submissions` 三个 Map 与台账五方法 `:259-284`）、`FakeHttp` `:325-346`（`postRoutes` / `posted`） | `apps/mobile/src/core/fakes.ts:43-346` |
| `course.vue`：`load()` `:154-209`（`repo.listItems()` → active → `splitCourses` → 分组 → 图章 → 完成度 → **喂入 `buildMyCreatedView(subs, new Set(all.map(i => i.itemId)))` 在 `:200-203`**）、`doSync()` `:231-251`（`noop` 文案「已是最新版本」）、`openMyCreated` `:284-300`（`encodeURIComponent(row.itemId)` + `from=ledger`）、`statusColor` `:276-278` | `apps/mobile/src/pages/course/course.vue:154-300` |
| `detail.vue`：`onLoad` `:78-173`；**台账分支 `:84-89`**（`repo.getSubmission(raw)`，失败即 `'本地没有这门课程，请返回先同步'`）；**普通分支 `:112-116`**（`repo.getItem(raw) ?? (cid === raw ? null : repo.getItem(cid))`）；`decodedId` `:175-181` | `apps/mobile/src/pages/course/detail.vue:78-181` |
| `sync.ts`：`syncOnce` `:150`；`noop` 分支 `:156`（`res.status === 'noop'`） | `apps/mobile/src/core/sync.ts:150-156` |
| `myitems.vue`：`onShow` 内 `flushSubmissions` 调用点（本册不改，仅参照其台账消费口径） | `apps/mobile/src/pages/myitems/myitems.vue:66-80` |
| `manifest.json`：`versionName "0.17.0"` `:5` / `versionCode "22"` `:6` | `apps/mobile/src/manifest.json:5-6` |

**环境与工作区：** Windows PowerShell 5.1（无 `pwsh`，**不支持 `&&` 与 heredoc**；多条命令用 `;` 分隔，一次只跑一条链路）。工作区有未提交的 `.gitignore` 改动与未跟踪的 `based-linux-amd64`——**不要动、不要 add**，每次只 `git add` 本任务的**确切文件列表**；提交用单行 `git commit -m "..."`（不要 heredoc）。

**执行禁令（册子 `#56 §4` 八条压缩）：** ① 不动节点侧契约（`validateSubmitSegments` / `AttrSeqsCanonical` / 三区间铁律 / `POST /v1/submit` 错误码一律不改）；② 不改内容包重建口径（节点收到容器后仍不重建 pack，不引入 `content_version` 自增）；③ 不改 `my_submissions` 既有列语义（仅**新增** `local_only` 一列）；④ 不做「我创建的」搜索 / 排序 / 分页，不新增「我的进度」类页面；⑤ 不动 `#51` 的「不建审批闸门」口径；⑥ 不做目录与票选、不做分类中文化（归 `#58`）；⑦ 不改内容包规范 v1、不 bump `schema_version`、不加配置项；⑧ 不做 iOS。**零节点改动 ⇒ 本册不交叉编译、不部署节点二进制（`/opt/base/based` 不动）。**

---

## 文件结构

**新增**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `apps/mobile/src/core/creator-migrate.ts` | 创建 | §2.4 一次性自愈迁移：横读台账、归一化重建、三态分流（`sent` / `pending` / 仅本地留存）、幂等标志位落 `config` |
| `apps/mobile/src/core/creator-migrate.test.ts` | 创建 | 迁移四象限（成功 / 4xx / 断网）+ 幂等跳过 + 本地物化 |
| `apps/mobile/src/core/creator-repo.test.ts` | 创建 | `MemoryRepo` 新方法语义：`upsertLocalContainer`（`items`+`segments` 同事务、覆盖写）、`markSubmissionLocalOnly`（终态、不进 `pending`） |

**修改**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `apps/mobile/src/core/repo.ts` | 修改 | `LocalContainerInput` 类型 + `upsertLocalContainer` / `markSubmissionLocalOnly` 两方法；`local_only` 列（DDL + `ensureSubmissionColumns` + `saveSubmission` + `SELECT` + `toMySubmissionRow`） |
| `apps/mobile/src/core/types.ts` | 修改 | `MySubmissionRow` 增 `localOnly: boolean` |
| `apps/mobile/src/core/fakes.ts` | 修改 | `MemoryRepo` 同步实现两新方法；`saveSubmission` 保留 `localOnly` |
| `apps/mobile/src/core/submit.ts` | 修改 | `writeLedger` 补 `localOnly:false`；`runFlushSubmissions` 容器行归一化重放 + 跳过 local-only；删死代码 `decodeLedgerSegments` |
| `apps/mobile/src/core/submit.test.ts` | 修改 | 两处台账行字面量补 `localOnly:false`；新增归一化重放 / 坏数据 / local-only 三用例 |
| `apps/mobile/src/core/course-edit.ts` | 修改 | 抽出 `toLocalContainer(form, updatedAt)` 复用出口；`saveContainer` 先落本地乐观条目再 `enqueueOrSend` |
| `apps/mobile/src/core/course-edit.test.ts` | 修改 | 新增 `toLocalContainer` 纯测 + `saveContainer` 本地落库用例 |
| `apps/mobile/src/core/my-created.ts` | 修改 | `statusLabelOf('sent')` 改文案；`MyCreatedRow` 增 `localOnly`；`buildMyCreatedView` 出「仅本地留存」标签；新增 `containerSegmentsFromLedger` |
| `apps/mobile/src/core/my-created.test.ts` | 修改 | `row()` 补 `localOnly:false`；更新 `toEqual` 断言语义；新增归一化重建用例 |
| `apps/mobile/src/pages/course/course.vue` | 修改 | 迁移调用；去重实参收窄（`source !== 'local'`）；`noop` 文案；「仅本地留存」删除入口 |
| `apps/mobile/src/pages/course/detail.vue` | 修改 | 取键统一 `resolveBy(raw, get)`，台账入口与普通入口共用 |
| `apps/mobile/src/manifest.json` | 修改 | 版本 `0.17.0`/`22` → `0.18.0`/`23`（Task 8） |

**不改动（硬边界）：** `internal/**`、`vectors/**`、`apps/mobile/src/core/sync.ts`（`noop` 语义保留）、`apps/mobile/src/core/container-view.ts`、`apps/mobile/src/core/tags.ts`、`apps/mobile/src/core/course-tree.ts`、`apps/mobile/src/pages/{lesson,article,quiz,myitems}/**`、内容包规范 v1、`schema_version`、`docs/**`（除本计划回填）、节点二进制与交叉编译。

---

### Task 1: `LocalRepo` 扩本地乐观落库 + 台账「仅本地留存」标记

**Files:** Modify `apps/mobile/src/core/repo.ts`；Modify `apps/mobile/src/core/types.ts`；Modify `apps/mobile/src/core/fakes.ts`；Modify `apps/mobile/src/core/submit.ts`；Modify `apps/mobile/src/core/submit.test.ts`；Modify `apps/mobile/src/core/my-created.test.ts`；Create `apps/mobile/src/core/creator-repo.test.ts`

- [ ] **Step 1: 写失败的测试** —— 新建 `apps/mobile/src/core/creator-repo.test.ts`（仓储语义用 `MemoryRepo` 断言，与 `progress-repo.test.ts` 同一手法）：

  ```ts
  import { describe, expect, it } from 'vitest';

  import { segmentsContentHash } from './attrs';
  import { MemoryRepo } from './fakes';
  import type { MySubmissionRow } from './types';

  function sub(over: Partial<MySubmissionRow> = {}): MySubmissionRow {
    return {
      itemId: 'course/c1', type: 'course', title: '课程', bodyMd: '', questionJson: '',
      linksJson: '', segmentsJson: '', state: 'pending', reason: null, created: 0,
      queuedAt: '2026-10-01T00:00:00Z', sentAt: '', localOnly: false,
      ...over,
    };
  }

  describe('upsertLocalContainer：本地乐观落库（册子 #56 §2.1）', () => {
    it('同事务写 items（source=local / state=active / rev 空）+ 覆盖 segments（按 seq 升序）', async () => {
      const repo = new MemoryRepo();
      const segments = [
        { seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1' },
        { seq: -1, kind: 'attr.cover', text: 'b1' },
      ];
      await repo.upsertLocalContainer(
        { itemId: 'course/c1', type: 'course', title: 'A', contentHash: segmentsContentHash(segments), updatedAt: '2026-10-01T00:00:00Z' },
        segments,
      );
      expect(await repo.getItem('course/c1')).toEqual({
        itemId: 'course/c1', source: 'local', type: 'course', title: 'A',
        rev: '', contentHash: segmentsContentHash(segments), state: 'active', updatedAt: '2026-10-01T00:00:00Z',
      });
      expect((await repo.listSegments('course/c1')).map((s) => s.seq)).toEqual([-1, 1]);
    });

    it('再次写入覆盖同 id：items 与 segments 皆以新值为准，旧行不残留', async () => {
      const repo = new MemoryRepo();
      await repo.upsertLocalContainer({ itemId: 'course/c1', type: 'course', title: 'A', contentHash: 'h1', updatedAt: 't1' }, [{ seq: 1, kind: 'lesson', text: 'x' }]);
      await repo.upsertLocalContainer({ itemId: 'course/c1', type: 'course', title: 'B', contentHash: 'h2', updatedAt: 't2' }, [{ seq: 2, kind: 'lesson', text: 'y' }]);
      expect((await repo.getItem('course/c1'))!.title).toBe('B');
      expect((await repo.listSegments('course/c1')).map((s) => s.seq)).toEqual([2]);
    });
  });

  describe('markSubmissionLocalOnly：终态标记（册子 #56 §2.4）', () => {
    it('置 failed + reason + localOnly=true，且不再出现在 pending 列表', async () => {
      const repo = new MemoryRepo();
      await repo.saveSubmission(sub());
      await repo.markSubmissionLocalOnly('course/c1', 'item_segments_invalid');
      const got = (await repo.getSubmission('course/c1'))!;
      expect(got.state).toBe('failed');
      expect(got.reason).toBe('item_segments_invalid');
      expect(got.localOnly).toBe(true);
      expect(await repo.listSubmissions('pending')).toHaveLength(0);
      expect(await repo.listSubmissions('failed')).toHaveLength(1);
    });

    it('saveSubmission 原样保留 localOnly（可凭它把「仅本地留存」重新写回普通行）', async () => {
      const repo = new MemoryRepo();
      await repo.saveSubmission(sub({ localOnly: true, state: 'failed' }));
      expect((await repo.getSubmission('course/c1'))!.localOnly).toBe(true);
      await repo.saveSubmission(sub({ localOnly: false, state: 'pending' }));
      expect((await repo.getSubmission('course/c1'))!.localOnly).toBe(false);
    });
  });
  ```

  同时把既有 `MySubmissionRow` 字面量补上新字段，否则 `npx tsc --noEmit` 会在本步失败（这正是「先失败」的一部分）：
  - `apps/mobile/src/core/my-created.test.ts` 的 `row()` 工厂，`sentAt: '',` 后加 `localOnly: false,`。
  - `apps/mobile/src/core/submit.test.ts:263-266` 与 `:282-285` 两处 `repo.saveSubmission({ ... })` 字面量，`sentAt: ''` 后加 `localOnly: false`。

- [ ] **Step 2: 跑测试确认失败** —— `cd apps/mobile; npx vitest run src/core/creator-repo.test.ts`。判据：报 `repo.upsertLocalContainer is not a function`（且 `tsc` 报 `MySubmissionRow` 缺 `localOnly` / `LocalRepo` 未实现新方法）。

- [ ] **Step 3: 写实现**

  **（a）`types.ts`** —— `MySubmissionRow` 末尾（`sentAt: string;` 之后）追加：

  ```ts
  /**
   * 「仅本地留存」终态标记（册子 #56 §2.4）：为 true 时该行**不再进入重放队列**
   * （其 `state` 恒为 `failed`，`runFlushSubmissions` 只取 `pending`，双保险）。
   * 独立列而非复用 `reason` 前缀——文案可改、标记不可改。
   */
  localOnly: boolean;
  ```

  **（b）`repo.ts`** —— 顶部 `import type` 区加 `import type { SubmitSegmentRow } from './attrs';`（type-only，不产生运行时环）。在 `PackApply` 之后新增输入类型：

  ```ts
  /** 本地乐观落库的条目输入（册子 #56 §2.1）：`source='local'` / `rev=''` / `state='active'` 由仓储层补齐。 */
  export interface LocalContainerInput {
    itemId: string;
    type: string;
    title: string;
    contentHash: string;
    updatedAt: string;
  }
  ```

  `LocalRepo` 接口在台账六方法（`:97` `removeSubmission` 之后）追加：

  ```ts
  /**
   * 同事务落一条「本地乐观条目」（册子 #56 §2.1）：upsert `items`（写死 `source='local'` / `rev=''` / `state='active'`）
   * 并**整体覆盖**该 id 的 `segments`（先删后插，按 seq 升序）。节点内容包后续同 id 落库即自然覆盖它。
   */
  upsertLocalContainer(item: LocalContainerInput, segments: SubmitSegmentRow[]): Promise<void>;
  /**
   * 置「仅本地留存」终态（册子 #56 §2.4）：`state='failed'` + 记原因 + `local_only=1`。
   * 单向：置位后无任何自动路径把它送回重放队列。
   */
  markSubmissionLocalOnly(itemId: string, reason: string): Promise<void>;
  ```

  `SCHEMA_SQL` 的 `my_submissions` DDL（`:144-148`）改为结尾追加 `local_only`：

  ```ts
  `CREATE TABLE IF NOT EXISTS my_submissions(
     item_id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, body_md TEXT NOT NULL,
     question_json TEXT NOT NULL, links_json TEXT NOT NULL DEFAULT '', segments_json TEXT NOT NULL DEFAULT '',
     state TEXT NOT NULL, reason TEXT, created INTEGER NOT NULL,
     queued_at TEXT NOT NULL, sent_at TEXT NOT NULL, local_only INTEGER NOT NULL DEFAULT 0)`,
  ```

  `ensureSubmissionColumns`（`:188-196`）末尾追加幂等补列：

  ```ts
  if (!cols.has('local_only')) {
    await db.execute(`ALTER TABLE my_submissions ADD COLUMN local_only INTEGER NOT NULL DEFAULT 0`);
  }
  ```

  `SqlRepo` 在 `removeSubmission`（`:594-596`）之后新增两方法：

  ```ts
  async upsertLocalContainer(item: LocalContainerInput, segments: SubmitSegmentRow[]): Promise<void> {
    const ordered = [...segments].sort((a, b) => a.seq - b.seq);
    const stmts: Array<{ sql: string; params?: unknown[] }> = [
      {
        sql: `INSERT INTO items(item_id,source,type,title,rev,content_hash,state,updated_at)
              VALUES(?,?,?,?,?,?,?,?)
              ON CONFLICT(item_id) DO UPDATE SET source=excluded.source,type=excluded.type,title=excluded.title,
                rev=excluded.rev,content_hash=excluded.content_hash,state=excluded.state,updated_at=excluded.updated_at`,
        params: [item.itemId, 'local', item.type, item.title, '', item.contentHash, 'active', item.updatedAt],
      },
      { sql: `DELETE FROM segments WHERE item_id=?`, params: [item.itemId] },
    ];
    for (const s of ordered) {
      stmts.push({
        sql: `INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`,
        params: [item.itemId, s.seq, s.kind, s.text, ''],
      });
    }
    await this.db.tx(stmts);
  }

  async markSubmissionLocalOnly(itemId: string, reason: string): Promise<void> {
    await this.db.execute(`UPDATE my_submissions SET state='failed', reason=?, local_only=1 WHERE item_id=?`, [reason, itemId]);
  }
  ```

  `saveSubmission`（`:554-564`）把 `local_only` 纳入形参与 upsert 列表：

  ```ts
  async saveSubmission(row: MySubmissionRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO my_submissions(item_id,type,title,body_md,question_json,links_json,segments_json,state,reason,created,queued_at,sent_at,local_only)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(item_id) DO UPDATE SET type=excluded.type,title=excluded.title,body_md=excluded.body_md,
         question_json=excluded.question_json,links_json=excluded.links_json,segments_json=excluded.segments_json,
         state=excluded.state,reason=excluded.reason,
         created=excluded.created,queued_at=excluded.queued_at,sent_at=excluded.sent_at,local_only=excluded.local_only`,
      [row.itemId, row.type, row.title, row.bodyMd, row.questionJson, row.linksJson, row.segmentsJson, row.state, row.reason, row.created, row.queuedAt, row.sentAt, row.localOnly ? 1 : 0],
    );
  }
  ```

  `listSubmissions`（`:566-572`）与 `getSubmission`（`:574-580`）的列串加 `local_only`：

  ```ts
  const cols = `item_id,type,title,body_md,question_json,links_json,segments_json,state,reason,created,queued_at,sent_at,local_only`;
  ```
  ```ts
  async getSubmission(itemId: string): Promise<MySubmissionRow | null> {
    const rows = await this.db.select(
      `SELECT item_id,type,title,body_md,question_json,links_json,segments_json,state,reason,created,queued_at,sent_at,local_only FROM my_submissions WHERE item_id=?`,
      [itemId],
    );
    return rows.length > 0 ? toMySubmissionRow(rows[0]) : null;
  }
  ```

  `toMySubmissionRow`（`:754-773`）返回对象尾部（`sentAt` 之后）追加：

  ```ts
  localOnly: Number(r.local_only ?? 0) !== 0,
  ```

  **（c）`fakes.ts`** —— 顶部 `import type { LocalRepo, PackApply } from './repo';` 改为 `import type { LocalContainerInput, LocalRepo, PackApply } from './repo';`，并新增 `import type { SubmitSegmentRow } from './attrs';`。`MemoryRepo` 台账五方法区（`:259-284`）追加：

  ```ts
  async upsertLocalContainer(item: LocalContainerInput, segments: SubmitSegmentRow[]): Promise<void> {
    this.items.set(item.itemId, {
      itemId: item.itemId, source: 'local', type: item.type, title: item.title,
      rev: '', contentHash: item.contentHash, state: 'active', updatedAt: item.updatedAt,
    });
    this.segments.set(
      item.itemId,
      [...segments]
        .sort((a, b) => a.seq - b.seq)
        .map((s) => ({ itemId: item.itemId, seq: s.seq, kind: s.kind, text: s.text, contentHash: '' })),
    );
  }

  async markSubmissionLocalOnly(itemId: string, reason: string): Promise<void> {
    const r = this.submissions.get(itemId);
    if (r) this.submissions.set(itemId, { ...r, state: 'failed', reason, localOnly: true });
  }
  ```

  **（d）`submit.ts`** —— `writeLedger`（`:278-292`）`saveSubmission({ ... })` 字面量内补 `localOnly: false,`（放在 `sentAt: '',` 之后）。

- [ ] **Step 4: 跑测试确认通过** —— `cd apps/mobile; npx vitest run src/core/creator-repo.test.ts; npx tsc --noEmit`。判据：本文件全绿、`tsc` 干净（既有 `my-created.test.ts` / `submit.test.ts` 因 Step 1 补字段也应通过）。

- [ ] **Step 5: 提交** —— `git add apps/mobile/src/core/repo.ts apps/mobile/src/core/types.ts apps/mobile/src/core/fakes.ts apps/mobile/src/core/submit.ts apps/mobile/src/core/submit.test.ts apps/mobile/src/core/my-created.test.ts apps/mobile/src/core/creator-repo.test.ts` 然后 `git commit -m "feat(mobile): 台账新增 local_only 列与本地乐观落库仓储方法（#56 §2.1/§2.4）"`。

---

### Task 2: `course-edit.ts` 抽出复用出口 + `saveContainer` 先落本地乐观

**Files:** Modify `apps/mobile/src/core/course-edit.ts`；Modify `apps/mobile/src/core/course-edit.test.ts`

- [ ] **Step 1: 写失败的测试** —— 在 `apps/mobile/src/core/course-edit.test.ts` 顶部 import 增补（`./attrs` 行加 `segmentsContentHash`，`./course-edit` 行加 `toLocalContainer`）：

  ```ts
  import { attrSeqsCanonical, segmentsContentHash } from './attrs';
  ```
  ```ts
  import {
    buildContainerSegments,
    emptyContainerForm,
    loadContainerForm,
    saveContainer,
    startNewCourse,
    startNewLesson,
    toLocalContainer,
    type ContainerForm,
  } from './course-edit';
  ```

  文件末尾追加：

  ```ts
  describe('toLocalContainer：表单 → 本地乐观条目（册子 #56 §2.1）', () => {
    it('items 输入为 source/rev/state 之外的四字段，content_hash 等于现行 segmentsContentHash', () => {
      const { item, segments } = toLocalContainer(lessonForm(), '2026-10-01T00:00:00Z');
      expect(item).toEqual({
        itemId: 'course/c1/lesson/l1', type: 'lesson', title: '第一讲',
        contentHash: segmentsContentHash(segments), updatedAt: '2026-10-01T00:00:00Z',
      });
      expect(item.contentHash).not.toBe('');
      expect(segments).toEqual(buildContainerSegments(lessonForm()));
    });
  });

  describe('saveContainer：本地乐观落库 + 投稿（册子 #56 §2.1）', () => {
    it('保存后本机立即可读（items.source=local，segments 落库），台账照旧 sent', async () => {
      const http = new FakeHttp();
      const repo = new MemoryRepo();
      const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
      const o: SubmitOptions = { adapters, repo, nodeBaseUrl: BASE };
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'course/c1/lesson/l1', created: true }));

      const out = await saveContainer(o, lessonForm());
      expect(out.ledgerState).toBe('sent');
      expect((await repo.getItem('course/c1/lesson/l1'))!.source).toBe('local');
      expect((await repo.getItem('course/c1/lesson/l1'))!.title).toBe('第一讲');
      expect((await repo.listSegments('course/c1/lesson/l1')).map((s) => s.kind)).toEqual(
        buildContainerSegments(lessonForm()).map((s) => s.kind),
      );
    });

    it('未配置节点（enqueueOrSend 抛错）也先落本地乐观条目', async () => {
      const repo = new MemoryRepo();
      const o: SubmitOptions = {
        adapters: fakeAdapters(new FakeHttp(), new MemoryFs(), new FakePackReader()),
        repo,
        nodeBaseUrl: '',
      };
      await expect(saveContainer(o, lessonForm())).rejects.toThrow('未配置节点地址，无法投稿');
      expect((await repo.getItem('course/c1/lesson/l1'))!.source).toBe('local');
    });
  });
  ```

- [ ] **Step 2: 跑测试确认失败** —— `cd apps/mobile; npx vitest run src/core/course-edit.test.ts`。判据：`toLocalContainer is not a function`；`saveContainer` 用例报 `repo.getItem(...)` 为 `null`（未落库）。

- [ ] **Step 3: 写实现** —— `course-edit.ts` 顶部 `./attrs` 的 import 加 `segmentsContentHash`（`SubmitSegmentRow` 已在列）；新增 `import type { LocalContainerInput } from './repo';`。在 `buildContainerSegments` 之后新增复用出口：

  ```ts
  /**
   * 容器表单 → 本地乐观条目 + 行集（册子 #56 §2.1）：`content_hash` 用现行
   * `segmentsContentHash(orderedRows)` 算（与节点 `store.SegmentsContentHash` 逐字节同构）。
   * `saveContainer` 与 `core/creator-migrate.ts` 共用这一出口，避免两处各算一份哈希。
   */
  export function toLocalContainer(
    form: ContainerForm,
    updatedAt: string,
  ): { item: LocalContainerInput; segments: SubmitSegmentRow[] } {
    const segments = buildContainerSegments(form);
    return {
      item: {
        itemId: form.itemId,
        type: form.type,
        title: form.title.trim(),
        contentHash: segmentsContentHash(segments),
        updatedAt,
      },
      segments,
    };
  }
  ```

  改写 `saveContainer`（`:161-169`）：

  ```ts
  export async function saveContainer(o: SubmitOptions, form: ContainerForm): Promise<SubmitOutcome> {
    const { item, segments } = toLocalContainer(form, new Date().toISOString());
    // 先本地乐观落库（册子 #56 §2.1）：本机立刻可读、可点开、可编辑，不依赖节点重建内容包。
    await o.repo.upsertLocalContainer(item, segments);
    return enqueueOrSend(o, {
      itemId: form.itemId,
      type: form.type,
      title: form.title,
      bodyMd: '',
      questionJson: '',
      segments,
    });
  }
  ```

- [ ] **Step 4: 跑测试确认通过** —— `cd apps/mobile; npx vitest run src/core/course-edit.test.ts; npx tsc --noEmit`。判据：本文件全绿、`tsc` 干净。

- [ ] **Step 5: 提交** —— `git add apps/mobile/src/core/course-edit.ts apps/mobile/src/core/course-edit.test.ts` 然后 `git commit -m "feat(mobile): saveContainer 抽出 toLocalContainer 并先落本地乐观条目（#56 §2.1）"`。

---

### Task 3: `my-created.ts` 去重标签改口 + 归一化重建出口

**Files:** Modify `apps/mobile/src/core/my-created.ts`；Modify `apps/mobile/src/core/my-created.test.ts`

- [ ] **Step 1: 写失败的测试** —— `apps/mobile/src/core/my-created.test.ts`：`./attrs` import 增 `attrSeqsCanonical`，`./my-created` import 增 `containerSegmentsFromLedger`。

  更新既有断言（册子 §2.6 文案改口 + `MyCreatedRow` 新增 `localOnly` 字段）：
  - `statusLabelOf('sent')` 期望由 `'已同步'` 改为 `'已提交 · 待节点收录'`（describe 标题同步改为「`sent` 改为『已提交 · 待节点收录』，`pending` / `failed` 不变」）。
  - `buildMyCreatedView` 中所有 `toEqual` 期望对象补 `localOnly: false`，且 `statusLabel` 期望中 `'已同步'` → `'已提交 · 待节点收录'`。例如 `:60-65` 改为：

    ```ts
    it('sent 且不含 ⇒ 列出且 statusLabel 为「已提交 · 待节点收录」', () => {
      const rows = [row({ itemId: 'article/a1', state: 'sent', title: 'A' })];
      expect(buildMyCreatedView(rows, new Set())).toEqual([
        { itemId: 'article/a1', type: 'article', title: 'A', state: 'sent', reason: '', localOnly: false, statusLabel: '已提交 · 待节点收录' },
      ]);
    });
    ```
    `:76-83` 的 `failed` 期望对象同理补 `localOnly: false`（`statusLabel` 仍为 `'失败'`）。

  新增用例：

  ```ts
  describe('buildMyCreatedView：仅本地留存行（册子 #56 §2.4）', () => {
    it('localOnly 行无论包表是否含该 id 都列出，标签为「仅本地留存」', () => {
      const rows = [row({ itemId: 'course/c1', type: 'course', state: 'failed', reason: 'item_segments_invalid', localOnly: true })];
      for (const pack of [new Set(['course/c1']), new Set<string>()]) {
        expect(buildMyCreatedView(rows, pack)).toEqual([
          { itemId: 'course/c1', type: 'course', title: '标题', state: 'failed', reason: 'item_segments_invalid', localOnly: true, statusLabel: '仅本地留存' },
        ]);
      }
    });
  });

  describe('containerSegmentsFromLedger：老台账行归一化重建（册子 #56 §2.3）', () => {
    it('属性行 seq 非规范 ⇒ 重建为现行 assignAttrSeqs 排布', () => {
      const legacy = row({
        itemId: 'course/c1', type: 'course', title: '课程',
        segmentsJson: JSON.stringify([
          { seq: -2, kind: 'attr.cover', text: 'b1' },
          { seq: -1, kind: 'attr.instructor', text: '李老师' },
        ]),
      });
      const segs = containerSegmentsFromLedger(legacy);
      expect(segs).not.toBeNull();
      const attrs = segs!.filter((s) => s.seq < 0).map((s) => ({ seq: s.seq, kind: s.kind, text: s.text }));
      expect(attrSeqsCanonical(attrs)).toBe(true);
      // 现行字典序：attr.cover 在前 ⇒ seq=-1；attr.instructor ⇒ seq=-2
      expect(attrs.sort((a, b) => a.seq - b.seq)).toEqual([
        { seq: -2, kind: 'attr.instructor', text: '李老师' },
        { seq: -1, kind: 'attr.cover', text: 'b1' },
      ]);
    });

    it('坏 JSON / 空行集 ⇒ null（不重放，判为仅本地留存）', () => {
      expect(containerSegmentsFromLedger(row({ type: 'course', segmentsJson: '{ not json' }))).toBeNull();
      expect(containerSegmentsFromLedger(row({ type: 'course', segmentsJson: '' }))).toBeNull();
    });
  });
  ```

- [ ] **Step 2: 跑测试确认失败** —— `cd apps/mobile; npx vitest run src/core/my-created.test.ts`。判据：`containerSegmentsFromLedger is not a function`；文案与 `localOnly` 断言不匹配。

- [ ] **Step 3: 写实现** —— `my-created.ts`：`./course-edit` import 增 `buildContainerSegments`，新增 `import type { SubmitSegmentRow } from './attrs';`。

  `statusLabelOf` 的 `sent` 分支改文案：

  ```ts
  export function statusLabelOf(s: MySubmissionRow['state']): string {
    switch (s) {
      case 'pending':
        return '待补发';
      case 'failed':
        return '失败';
      case 'sent':
        return '已提交 · 待节点收录';
    }
  }
  ```

  `MyCreatedRow` 增字段：

  ```ts
  export interface MyCreatedRow {
    itemId: string;
    type: MyCreatedType;
    title: string;
    state: 'pending' | 'sent' | 'failed';
    reason: string;
    /** 仅本地留存终态（册子 #56 §2.4）：为 true 时展示「仅本地留存」并提供删除入口 */
    localOnly: boolean;
    statusLabel: string;
  }
  ```

  `buildMyCreatedView` 改写：

  ```ts
  export function buildMyCreatedView(rows: MySubmissionRow[], packItemIds: Set<string>): MyCreatedRow[] {
    const out: MyCreatedRow[] = [];
    for (const r of rows) {
      if (r.type === 'tag') continue;
      if (r.state === 'sent' && !r.localOnly && packItemIds.has(r.itemId)) continue;
      out.push({
        itemId: r.itemId,
        type: r.type,
        title: r.title,
        state: r.state,
        reason: r.reason ?? '',
        localOnly: r.localOnly,
        statusLabel: r.localOnly ? '仅本地留存' : statusLabelOf(r.state),
      });
    }
    return out;
  }
  ```

  文件末尾新增：

  ```ts
  /**
   * 台账容器行 → 现行规范行集（册子 #56 §2.3 重放归一化）：
   * 走 `containerFormFromLedger` → `buildContainerSegments` 重建，属性行必然经 `assignAttrSeqs` 排布。
   * 还原不出可用行集（坏 JSON / 空）⇒ 返回 `null`，调用方据此判为「仅本地留存」。
   */
  export function containerSegmentsFromLedger(row: MySubmissionRow): SubmitSegmentRow[] | null {
    const segs = buildContainerSegments(containerFormFromLedger(row));
    return segs.length === 0 ? null : segs;
  }
  ```

- [ ] **Step 4: 跑测试确认通过** —— `cd apps/mobile; npx vitest run src/core/my-created.test.ts; npx tsc --noEmit`。判据：全绿 + `tsc` 干净。

- [ ] **Step 5: 提交** —— `git add apps/mobile/src/core/my-created.ts apps/mobile/src/core/my-created.test.ts` 然后 `git commit -m "feat(mobile): 我创建的标签改口并新增归一化重建出口（#56 §2.3/§2.6）"`。

---

### Task 4: `submit.ts` 容器重放归一化 + 不重放仅本地留存行

**Files:** Modify `apps/mobile/src/core/submit.ts`；Modify `apps/mobile/src/core/submit.test.ts`

- [ ] **Step 1: 写失败的测试** —— `apps/mobile/src/core/submit.test.ts` 末尾追加（`fixture` / `json` / `decodeUtf8` / `BASE` 均为文件内既有帮手）：

  ```ts
  describe('补发：容器行归一化重放（册子 #56 §2.3）', () => {
    it('老 segments_json（属性行 seq 非规范）重放时被重建为规范排布，不用原文', async () => {
      const { http, repo, o } = fixture();
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'course/c1', created: true }));
      await repo.saveSubmission({
        itemId: 'course/c1', type: 'course', title: '课程', bodyMd: '', questionJson: '', linksJson: '',
        segmentsJson: JSON.stringify([
          { seq: -2, kind: 'attr.cover', text: 'b1' },
          { seq: -1, kind: 'attr.instructor', text: '李老师' },
        ]),
        state: 'pending', reason: null, created: 0, queuedAt: '2026-10-01T00:00:01Z', sentAt: '', localOnly: false,
      });

      const res = await flushSubmissions(o);
      expect(res.sent).toBe(1);
      const wire = JSON.parse(decodeUtf8(http.posted.at(-1)!.body)) as { segments: Array<{ seq: number; kind: string; text: string }> };
      // 归一化后：attr.instructor 占 -2、attr.cover 占 -1（原文是反的）
      expect(wire.segments).toEqual([
        { seq: -2, kind: 'attr.instructor', text: '李老师' },
        { seq: -1, kind: 'attr.cover', text: 'b1' },
      ]);
      expect((await repo.getSubmission('course/c1'))!.state).toBe('sent');
    });

    it('坏 segments_json ⇒ 不重放，直接转「仅本地留存」（failed + localOnly）', async () => {
      const { http, repo, o } = fixture();
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      await repo.saveSubmission({
        itemId: 'course/c1', type: 'course', title: '课程', bodyMd: '', questionJson: '', linksJson: '',
        segmentsJson: '{ not json', state: 'pending', reason: null, created: 0,
        queuedAt: '2026-10-01T00:00:01Z', sentAt: '', localOnly: false,
      });

      const res = await flushSubmissions(o);
      expect(res).toEqual({ sent: 0, failed: 1, remaining: 0, error: '' });
      const got = (await repo.getSubmission('course/c1'))!;
      expect(got.state).toBe('failed');
      expect(got.localOnly).toBe(true);
      expect(http.posted.filter((p) => p.url.endsWith('/v1/submit'))).toHaveLength(0);
    });

    it('仅本地留存行不进重放队列（即便 state 被误置为 pending）', async () => {
      const { http, repo, o } = fixture();
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      http.postRoutes.set(`${BASE}/v1/submit`, json({ created: true }));
      await repo.saveSubmission({
        itemId: 'course/c1', type: 'course', title: '课程', bodyMd: '', questionJson: '', linksJson: '',
        segmentsJson: JSON.stringify([{ seq: -1, kind: 'attr.cover', text: 'b1' }]),
        state: 'pending', reason: null, created: 0, queuedAt: '2026-10-01T00:00:01Z', sentAt: '', localOnly: true,
      });

      const res = await flushSubmissions(o);
      expect(res).toEqual({ sent: 0, failed: 0, remaining: 0, error: '' });
      expect(http.posted.filter((p) => p.url.endsWith('/v1/submit'))).toHaveLength(0);
    });
  });
  ```

- [ ] **Step 2: 跑测试确认失败** —— `cd apps/mobile; npx vitest run src/core/submit.test.ts`。判据：第一条断言失败（`wire.segments` 仍是原文 `cover@-2 / instructor@-1`）；第二条报 `localOnly` 为 `false` 且 `http.posted` 有记录。

- [ ] **Step 3: 写实现** —— `submit.ts`：新增 `import { containerSegmentsFromLedger } from './my-created';`（`SubmitSegmentRow` 已从 `./attrs` 导入）。改写 `runFlushSubmissions`（`:361-395`）为：

  ```ts
  async function runFlushSubmissions(o: SubmitOptions): Promise<FlushSubmissionsResult> {
    // 「仅本地留存」是终态（册子 #56 §2.4）：先剔出重放集合，语义上永不重放。
    const rows = (await o.repo.listSubmissions('pending')).filter((r) => !r.localOnly);
    let sent = 0;
    let failed = 0;
    let remaining = 0;
    let error = '';
    for (const row of rows) {
      let segments: SubmitSegmentRow[] | undefined;
      if (row.type === 'course' || row.type === 'lesson') {
        // 归一化重放（册子 #56 §2.3）：不用 segments_json 原文，改走
        // ledgerSegmentsOf → containerFormFromLedger → buildContainerSegments，老数据由此自愈。
        const rebuilt = containerSegmentsFromLedger(row);
        if (rebuilt === null) {
          await o.repo.markSubmissionLocalOnly(row.itemId, '本地数据无法还原，仅本地留存');
          failed += 1;
          continue;
        }
        segments = rebuilt;
      }
      const draft: SubmitDraft = {
        itemId: row.itemId,
        type: row.type,
        title: row.title,
        bodyMd: row.bodyMd,
        questionJson: row.questionJson,
        links: row.type === 'tag' ? decodeLedgerLinks(row.itemId, row.linksJson) : undefined,
        segments,
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
          remaining = rows.length - sent - failed;
          error = msg;
          break;
        }
      }
    }
    return { sent, failed, remaining, error };
  }
  ```

  删除不再被引用的 `decodeLedgerSegments`（`:410-419` 整段）。

  > 已知点：本步引入 `submit.ts → my-created.ts → course-edit.ts → submit.ts` 的函数级环。三者之间的引用全部发生在**函数调用时**（非模块顶层求值），ESM 下安全；若 vitest 报未初始化，改由 `my-created.ts` 导出并只从它取 `containerSegmentsFromLedger`（本步已是此形态）。

- [ ] **Step 4: 跑测试确认通过** —— `cd apps/mobile; npx vitest run src/core/submit.test.ts; npx tsc --noEmit`。判据：全绿 + `tsc` 干净。

- [ ] **Step 5: 提交** —— `git add apps/mobile/src/core/submit.ts apps/mobile/src/core/submit.test.ts` 然后 `git commit -m "fix(mobile): 容器台账行重放改走归一化重建并跳过仅本地留存（#56 §2.3/§2.4）"`。

---

### Task 5: 新建 `creator-migrate.ts` 一次性自愈迁移

**Files:** Create `apps/mobile/src/core/creator-migrate.ts`；Create `apps/mobile/src/core/creator-migrate.test.ts`

- [ ] **Step 1: 写失败的测试** —— 新建 `apps/mobile/src/core/creator-migrate.test.ts`：

  ```ts
  import { utf8 } from '@base/protocol-ts';
  import { describe, expect, it } from 'vitest';

  import { segmentsContentHash } from './attrs';
  import { CREATOR_VISIBILITY_MIGRATION_KEY, runCreatorVisibilityMigration } from './creator-migrate';
  import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
  import type { SubmitOptions } from './submit';
  import type { MySubmissionRow } from './types';

  const BASE = 'https://node.test';

  function json(v: unknown) {
    return { status: 200, body: utf8(JSON.stringify(v)) };
  }

  function opts(http: FakeHttp, repo: MemoryRepo): SubmitOptions {
    return { adapters: fakeAdapters(http, new MemoryFs(), new FakePackReader()), repo, nodeBaseUrl: BASE };
  }

  /** 历史 failed 行：属性行 seq 非规范（cover 占 -2、instructor 占 -1）。 */
  function courseRow(over: Partial<MySubmissionRow> = {}): MySubmissionRow {
    return {
      itemId: 'course/c1', type: 'course', title: '课程', bodyMd: '', questionJson: '', linksJson: '',
      segmentsJson: JSON.stringify([
        { seq: -2, kind: 'attr.cover', text: 'b1' },
        { seq: -1, kind: 'attr.instructor', text: '李老师' },
      ]),
      state: 'failed', reason: 'item_segments_invalid', created: 0,
      queuedAt: '2026-09-30T00:00:00Z', sentAt: '', localOnly: false,
      ...over,
    };
  }

  class OfflineHttp extends FakeHttp {
    override async post(url: string, body: Uint8Array, headers?: Record<string, string>) {
      if (url.endsWith('/v1/submit')) throw new Error('offline');
      return super.post(url, body, headers);
    }
  }

  describe('runCreatorVisibilityMigration：一次性自愈迁移（册子 #56 §2.4）', () => {
    it('历史 failed 行归一化重试成功 ⇒ sent，并写幂等标志位与物化本地条目', async () => {
      const http = new FakeHttp();
      const repo = new MemoryRepo();
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'course/c1', created: true }));
      await repo.saveSubmission(courseRow());

      const res = await runCreatorVisibilityMigration(opts(http, repo));
      expect(res).toEqual({ skipped: false, retried: 1, sent: 1, pending: 0, localOnly: 0 });
      expect((await repo.getSubmission('course/c1'))!.state).toBe('sent');
      expect(await repo.getConfig(CREATOR_VISIBILITY_MIGRATION_KEY)).toBe('0.18.0');
      const item = (await repo.getItem('course/c1'))!;
      expect(item.source).toBe('local');
      expect(item.contentHash).toBe(segmentsContentHash(await repo.listSegments('course/c1')));
    });

    it('幂等：标志位已存在 ⇒ 跳过（零请求、零改动）', async () => {
      const http = new FakeHttp();
      const repo = new MemoryRepo();
      await repo.setConfig(CREATOR_VISIBILITY_MIGRATION_KEY, '0.18.0');
      await repo.saveSubmission(courseRow());

      const res = await runCreatorVisibilityMigration(opts(http, repo));
      expect(res).toEqual({ skipped: true, retried: 0, sent: 0, pending: 0, localOnly: 0 });
      expect(http.posted).toHaveLength(0);
      expect((await repo.getSubmission('course/c1'))!.state).toBe('failed');
    });

    it('归一化后仍被 4xx 拒 ⇒ 转「仅本地留存」，本地已物化可编辑', async () => {
      const http = new FakeHttp();
      const repo = new MemoryRepo();
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      http.postRoutes.set(`${BASE}/v1/submit`, { status: 400, body: utf8('{"error":"item_segments_invalid"}') });
      await repo.saveSubmission(courseRow());

      const res = await runCreatorVisibilityMigration(opts(http, repo));
      expect(res).toEqual({ skipped: false, retried: 1, sent: 0, pending: 0, localOnly: 1 });
      const got = (await repo.getSubmission('course/c1'))!;
      expect(got.state).toBe('failed');
      expect(got.localOnly).toBe(true);
      expect((await repo.getItem('course/c1'))!.source).toBe('local');
    });

    it('断网 ⇒ 回 pending（进入正常重放队列），不置终态', async () => {
      const http = new OfflineHttp();
      const repo = new MemoryRepo();
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      http.postRoutes.set(`${BASE}/v1/submit`, json({ created: true }));
      await repo.saveSubmission(courseRow());

      const res = await runCreatorVisibilityMigration(opts(http, repo));
      expect(res).toEqual({ skipped: false, retried: 1, sent: 0, pending: 1, localOnly: 0 });
      const got = (await repo.getSubmission('course/c1'))!;
      expect(got.state).toBe('pending');
      expect(got.localOnly).toBe(false);
    });

    it('已完成终态的 localOnly 行不再被迁移选中', async () => {
      const http = new FakeHttp();
      const repo = new MemoryRepo();
      await repo.saveSubmission(courseRow({ localOnly: true }));
      const res = await runCreatorVisibilityMigration(opts(http, repo));
      expect(res.retried).toBe(0);
      expect(http.posted).toHaveLength(0);
    });
  });
  ```

- [ ] **Step 2: 跑测试确认失败** —— `cd apps/mobile; npx vitest run src/core/creator-migrate.test.ts`。判据：报「找不到模块 `./creator-migrate`」。

- [ ] **Step 3: 写实现** —— 新建 `apps/mobile/src/core/creator-migrate.ts`：

  ```ts
  /**
   * 创作者可见性一次性自愈迁移（册子 #56 §2.4）：升级后首轮启动执行一次，
   * 把台账里 `type ∈ {course,lesson}` 且 `state ∈ {failed,pending}` 的历史行按 §2.3 归一化后重试一轮。
   * **幂等靠本地 `config` 标志位**（不靠内存或时间戳推断）；**只经返回值体现结果，绝不抛错**——
   * 升级首启不能因迁移失败而阻断。只依赖注入的 `SubmitOptions`，故可在 Node 下用 `core/fakes.ts` 完整测试。
   */
  import { segmentsContentHash } from './attrs';
  import { buildContainerSegments } from './course-edit';
  import { containerFormFromLedger } from './my-created';
  import { SubmitError, isPermanentSubmitFailure, submitItem, type SubmitDraft, type SubmitOptions } from './submit';
  import type { MySubmissionRow } from './types';

  /** 本地 `config` 幂等标志位键。值 = 本册版本号。 */
  export const CREATOR_VISIBILITY_MIGRATION_KEY = 'creator_visibility_migrated';
  /** 标志位记录的版本号（与 `manifest.json` 同批版本）。 */
  export const CREATOR_VISIBILITY_MIGRATION_VERSION = '0.18.0';

  export interface MigrationResult {
    /** 已迁移过（标志位存在）⇒ 本轮零动作 */
    skipped: boolean;
    /** 参与重试的历史行数 */
    retried: number;
    sent: number;
    pending: number;
    localOnly: number;
  }

  /** 需迁移的台账行：容器载体 + 可重试态 + 尚未标记为仅本地留存。 */
  function isMigratable(r: MySubmissionRow): boolean {
    return (r.type === 'course' || r.type === 'lesson') && !r.localOnly && (r.state === 'failed' || r.state === 'pending');
  }

  export async function runCreatorVisibilityMigration(o: SubmitOptions): Promise<MigrationResult> {
    if ((await o.repo.getConfig(CREATOR_VISIBILITY_MIGRATION_KEY)) !== null) {
      return { skipped: true, retried: 0, sent: 0, pending: 0, localOnly: 0 };
    }
    const rows = (await o.repo.listSubmissions()).filter(isMigratable);
    let sent = 0;
    let pending = 0;
    let localOnly = 0;
    for (const row of rows) {
      const form = containerFormFromLedger(row);
      const segments = buildContainerSegments(form);
      // 顺带物化本地乐观条目（§2.4）：即便随后被拒，本地仍可见、可编辑、可删。
      await o.repo.upsertLocalContainer(
        {
          itemId: form.itemId,
          type: form.type,
          title: form.title.trim(),
          contentHash: segmentsContentHash(segments),
          updatedAt: new Date().toISOString(),
        },
        segments,
      );
      if (segments.length === 0) {
        await o.repo.markSubmissionLocalOnly(row.itemId, '本地数据无法还原，仅本地留存');
        localOnly += 1;
        continue;
      }
      const draft: SubmitDraft = { itemId: row.itemId, type: row.type, title: row.title, bodyMd: '', questionJson: '', segments };
      try {
        const r = await submitItem(o, draft);
        await o.repo.markSubmissionSent(row.itemId, r.created ? 1 : 0, new Date().toISOString());
        sent += 1;
      } catch (e) {
        if (isPermanentSubmitFailure(e)) {
          // 其余 4xx ⇒ 终态「仅本地留存」（reason 保留节点错误码映射后的文案）
          await o.repo.markSubmissionLocalOnly(row.itemId, e instanceof SubmitError ? e.message : String(e));
          localOnly += 1;
        } else {
          // 断网 / 429 / 5xx ⇒ 回 pending（进入正常重放队列）
          const msg = e instanceof SubmitError ? e.message : `迁移重试失败：${(e as Error).message ?? String(e)}`;
          await o.repo.saveSubmission({ ...row, state: 'pending', reason: msg, localOnly: false });
          pending += 1;
        }
      }
    }
    await o.repo.setConfig(CREATOR_VISIBILITY_MIGRATION_KEY, CREATOR_VISIBILITY_MIGRATION_VERSION);
    return { skipped: false, retried: rows.length, sent, pending, localOnly };
  }
  ```

- [ ] **Step 4: 跑测试确认通过** —— `cd apps/mobile; npx vitest run src/core/creator-migrate.test.ts; npx tsc --noEmit`。判据：全绿 + `tsc` 干净。

- [ ] **Step 5: 提交** —— `git add apps/mobile/src/core/creator-migrate.ts apps/mobile/src/core/creator-migrate.test.ts` 然后 `git commit -m "feat(mobile): 新增一次性自愈迁移（幂等标志位落 config，#56 §2.4）"`。

---

### Task 6: `course.vue` 接线（迁移调用 + 去重收窄 + 三态反馈 + 删除入口）

**Files:** Modify `apps/mobile/src/pages/course/course.vue`

> 页面层无 SFC 单测装置（仓内既有 `.vue` 任务同此），本任务以 `tsc` + `build:h5` + `.value` 硬检查收口；去重口径的 vitest 覆盖在 Task 3 的 `buildMyCreatedView`。

- [ ] **Step 1: 接入迁移并收窄去重实参** —— `course.vue` 顶部 import 追加 `import { runCreatorVisibilityMigration } from '../../core/creator-migrate';`。`load()`（`:154-209`）内：
  - `const { repo, capabilities } = await bootstrap();` 改为 `const { repo, capabilities, opts } = await bootstrap();`，紧随其后（`syncBlocked.value = ...` 之后）加：

    ```ts
    // 一次性自愈迁移（册子 #56 §2.4）：幂等——标志位已存在即零动作；未配置节点则跳过。
    if (opts.nodeBaseUrl !== '') {
      await runCreatorVisibilityMigration(opts);
    }
    ```
  - `:202-203` 的喂入改为（去重判据收窄为「非 local 来源的 id 集」，册子 §2.2）：

    ```ts
    const subs = await repo.listSubmissions();
    const packIds = new Set(all.filter((i) => i.source !== 'local').map((i) => i.itemId));
    myCreated.value = buildMyCreatedView(subs, packIds);
    ```

- [ ] **Step 2: 同步按钮三态如实反馈** —— `doSync()`（`:240-244`）的 `noop` 文案改为「节点内容未更新」（成功分支 `已更新到版本 ...` 与失败分支 `error.value = (e as Error).message` 保持不变）：

  ```ts
  const res = await syncOnce(opts);
  tip.value =
    res.status === 'noop'
      ? '节点内容未更新'
      : `已更新到版本 ${res.contentVersion}（条目 ${res.items}，块 ${res.blobs}）`;
  await load();
  ```
  > 三态只读 `SyncResult.status`，**不得为此新增任何网络请求**（册子 §2.6 / §7 风险 5）。

- [ ] **Step 3: 「仅本地留存」行显示与删除入口** —— 模板 `:14-18` 的「我创建的」行内，在 `reason` 行之后加删除入口：

  ```html
  <text v-if="row.localOnly" class="act" @click.stop="removeMyCreated(row)">删除</text>
  ```

  脚本区新增（放在 `openMyCreated` 之后）：

  ```ts
  /** 删除「仅本地留存」台账行（册子 #56 §2.4 / §7 风险 4：终态必须有手动删除入口）。 */
  async function removeMyCreated(row: MyCreatedRow) {
    const { repo } = await bootstrap();
    await repo.removeSubmission(row.itemId);
    await load();
  }
  ```

  样式区新增一行（`:325` 之前任意位置）：

  ```css
  .act { display: inline-block; color: #2b6cb0; font-size: 14px; margin-top: 4px; }
  ```
  > `<template>` 内**绝不写 `.value`**（用既有计算属性 / 方法）。

- [ ] **Step 4: 构建与硬检查** —— `cd apps/mobile; npx tsc --noEmit; npm run build:h5`。判据：`tsc` 干净、`build:h5` 输出 `DONE Build complete.`；再跑 `Get-ChildItem apps/mobile/src/pages -Recurse -Filter *.vue | Select-String -Pattern '="[^"]*\.value|\{\{[^}]*\.value'`，判据：无输出。

- [ ] **Step 5: 提交** —— `git add apps/mobile/src/pages/course/course.vue` 然后 `git commit -m "feat(mobile): 课程页接入自愈迁移、去重收窄并补同步三态反馈（#56 §2.2/§2.4/§2.6）"`。

---

### Task 7: `detail.vue` 取键统一（台账入口与普通入口共用一处规则）

**Files:** Modify `apps/mobile/src/pages/course/detail.vue`

> 同 Task 6：以 `tsc` + `build:h5` + `.value` 硬检查收口；`lesson/detail.vue` 已走自查 `wait(raw)` 解码助手、非册子 §3 落点，本册不动。

- [ ] **Step 1: 抽出唯一取键规则** —— `detail.vue` 的 `decodedId`（`:175-181`）之后新增：

  ```ts
  /**
   * 全页唯一的取键规则（册子 #56 §2.5）：先试原样 `raw`，再试解码态 `decodedId(raw)`。
   * 台账入口（`from=ledger`）与普通入口共用它，避免两处再分叉。
   */
  async function resolveBy<T>(raw: string, get: (id: string) => Promise<T | null>): Promise<T | null> {
    const first = await get(raw);
    if (first !== null) return first;
    const cid = decodedId(raw);
    return cid === raw ? null : await get(cid);
  }
  ```

- [ ] **Step 2: 两条分支改为共用** —— `onLoad` 内：
  - 台账分支（`:84-89`）改为：

    ```ts
    if (q.from === 'ledger') {
      const row = await resolveBy(raw, (id) => repo.getSubmission(id));
      if (!row) {
        error.value = '本地没有这门课程，请返回先同步';
        return;
      }
      const form = containerFormFromLedger(row);
      // ……（以下 `:90-111` 一字不改）
    ```
  - 普通分支（`:112-116`）改为：

    ```ts
    const course = await resolveBy(raw, (id) => repo.getItem(id));
    if (!course) {
      error.value = '本地没有这门课程，请返回先同步';
      return;
    }
    ```
  - 删除分支内已不需要的局部 `const cid = decodedId(raw);`（现由 `resolveBy` 内部持有）。

- [ ] **Step 3: 构建与硬检查** —— `cd apps/mobile; npx tsc --noEmit; npm run build:h5`。判据：`tsc` 干净、`build:h5` 通过；`.value` 硬检查（同 Task 6 Step 4）无命中。

- [ ] **Step 4: 提交** —— `git add apps/mobile/src/pages/course/detail.vue` 然后 `git commit -m "fix(mobile): 详情页台账入口与普通入口统一取键规则（#56 §2.5）"`。

---

### Task 8: 门禁与收口

**Files:** Modify `apps/mobile/src/manifest.json`；Modify `docs/superpowers/plans/2026-10-01-base-creator-visibility-plan.md`（执行实况回填）

- [ ] **Step 1: Go 三连（佐证零节点改动）** —— 仓库根 `go build ./...`；`go vet ./...`；`go test ./...`。判据：全绿；`git diff --stat -- internal/` **无输出**（`internal/**` 零改动）。

- [ ] **Step 2: 手机端三连** —— `cd apps/mobile` → `npx vitest run`（基线下限「只增不减」，本册至少新增 `creator-repo.test.ts` / `creator-migrate.test.ts` 与若干用例）/ `npx tsc --noEmit` / `npm run build:h5`。判据：全绿。

- [ ] **Step 3: 发布前模板 `.value` 硬检查** —— `Get-ChildItem apps/mobile/src/pages -Recurse -Filter *.vue | Select-String -Pattern '="[^"]*\.value|\{\{[^}]*\.value'`。判据：无输出；另 `npm run build:app` 产物 `\.value\.value` 计数应为 0（uni-app 框架自带文件除外）。

- [ ] **Step 4: 版本号** —— `apps/mobile/src/manifest.json`：`versionName` `"0.17.0"` → `"0.18.0"`，`versionCode` `"22"` → `"23"`。

- [ ] **Step 5: 四步发布（人工 / 服务器侧，本册零节点改动 ⇒ 不交叉编译、不部署节点二进制）** —— ① HBuilderX 云打包 APK；② 上传到 `/opt/appdl/base-0.18.0.apk`；③ 落地页**整页重写**改指 `base-0.18.0.apk`；④ 服务器 `based release` 签发落 `/opt/base-cache/data/release.json`。

- [ ] **Step 6: 线上核对** —— `GET /v1/release` 返回的 `version`/`url` 指向 `0.18.0`；`HEAD /dl/base-0.18.0.apk` 返回 200 与预期 `Content-Length`。

- [ ] **Step 7: 文档收口** —— 在本文末「执行实况」节回填：实际改动文件清单、`git diff --stat`（`internal/` 零改动佐证）、门禁跑分（文件数 / 用例数）、`.value` 硬检查结果、四步发布与线上核对结果、真机验收状态。

---

## 真机验收（登记不阻塞）

- 断网创建课程 → 恢复网络 → **本地仍可见**且台账转 `sent`（册子 §5 真机项）。
- 升级后**首次启动**的一次性迁移在真机**不重复触发**（`creator_visibility_migrated` 标志位生效）。
- 对应册子 AC：AC 1（本地乐观立即可读）、AC 4（仅本地留存本地仍可见可编辑可删）、AC 5（本地没有这门课程不再误报）、AC 6（同步按钮三态）。

## 执行实况（执行后回填）

> 执行后按本仓库惯例回填完整度与执行期更正（改动文件清单、`git diff --stat` 佐证、门禁跑分、发布与线上核对、真机验收状态）。