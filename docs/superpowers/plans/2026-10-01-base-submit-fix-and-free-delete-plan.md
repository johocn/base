# 基座投稿修复与免票选删除实现计划（册子 #60 → 计划）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地册子 `#60` 全部诉求——① `postGovernEvent` 补 5 个请求签名头（词条提案 / 投票不再 400）；② `errors.ts` 补 `item_segments_invalid` / `auth_body_too_large` 两条中文映射；③ 客户端新增 `validateContainerSegments` 行集预检（同构镜像 `validateSubmitSegments`，失败**指名到行**且不发网络请求）；④ 选文件能力收敛为唯一探针 `pickCapability`，自检 `pick.*` 按探针分支断言；⑤ `toPlusUrl` 支持 `file://` 前缀与裸绝对路径；⑥ 节点侧新增 `freeRemoveEligible` 免票选删除判据并接入 settle / vote 两条生效路径；⑦ 课程详情页新增「删除本课程」入口；⑧ nginx `client_max_body_size` 抬到 12m；⑨ 清理线上测试数据；⑩ 坐实编辑课程 400 的越界行；⑪ 门禁、版本与发布收口。覆盖册子 §8 的 AC 1–8。

**Architecture:** 客户端修复全部落在「薄封装 + 纯函数」层（`core/govern.ts`、`core/errors.ts`、`core/course-edit.ts`、`platform/uni.ts`、`core/selfcheck.ts`），可被 vitest 完整覆盖，不新增页面级状态机。节点侧删改走**既有 `govern.v1` 管线内旁路**（零新端点 / 零新表 / 零新枚举）：`remove` 提案在 settle 前用 `freeRemoveEligible` 判一次「创建者 + 无课时或无他人学习」，为真则门槛降 0、立即 effective、`executed_result='free_remove'`；为假或判定异常一律 fail-closed 退回既有 3 票。判定函数签名 `freeRemoveEligible(e sqlExec, itemID, actor string) (bool, error)`，第一参数取 `sqlExec` 以便「事务外（`s.db`）与事务内（`tx`）」两种调用点复用（`SetMaxOpenConns(1)` 下事务内只能用 `tx`）。

**Tech Stack:** Go 1.x（`internal/store`、`internal/httpapi`，纯 Go SQLite `modernc.org/sqlite`，`SetMaxOpenConns(1)`）／ Go 单测（`openTemp(t)` + 进程内 harness，**禁用 `httptest.NewServer`**）／ TypeScript + Vue 3 + uni-app（`apps/mobile`）／ vitest ／ `core/fakes.ts`（`MemoryRepo`/`FakeHttp`）。

**上游 spec:** `docs/superpowers/specs/2026-10-01-base-submit-fix-and-free-delete-design.md`（册子 `#60`，本册权威需求来源）；直接上游 `#27`（治理动作与门槛）、`#33`（`govern.v1` 事件化，`internal/store/govern_projection.go`）、`#40`（`seq<0` 槽位）、`#56`（容器编辑台账）、`#58`（目录治理，本册仅随其修 `postGovernEvent`）。上一计划 `docs/superpowers/plans/2026-10-01-base-directory-governance-plan.md`（`#59`）。

---

## 开工前已核实的现状（执行时直接用，不要重新调研）

| 事实 | 位置 |
| --- | --- |
| `postGovernEvent` 只发 `Content-Type`，注释含错误假设「事件路径只验内容签名，不需要签名头」 | `apps/mobile/src/core/govern.ts:124-154` |
| 对照实现：`sendComment` 同一 `/v1/event` 路径**带** 5 个签名头，`localStep` 私有 | `apps/mobile/src/core/comment.ts:96-102`、`:213-223` |
| `signRequestHeaders(ident,{method,path,body},ts?)` 返回 `X-Base-Id/Alg/Ts/Nonce/Sig` | `apps/mobile/src/core/identity.ts:238-258` |
| `SERVER_ERROR_TEXT`（28 条，第 10–37 行）+ `errorText(code, fallback)`（`auth_*`/`identity_*` 前缀回落「签名校验失败」） | `apps/mobile/src/core/errors.ts:9-59` |
| `buildContainerSegments` / `toLocalContainer` / `loadContainerForm` / `saveContainer` | `apps/mobile/src/core/course-edit.ts:114-134`、`:141-156`、`:159-177`、`:184-196` |
| `SubmitSegmentRow` / `AttrSlot` / `isAttrKind` / `attrSeqsCanonical` / `DIGEST_KIND` | `apps/mobile/src/core/attrs.ts:138-142`、`:81-85`、`:72-74`、`:126-131`、`:29` |
| `writeLedger`（**私有**，台账字段全集）/ `SubmitOutcome` / `enqueueOrSend` | `apps/mobile/src/core/submit.ts:276-295`、`:297-305`、`:312-332` |
| `pickLocalFile` 现判据 `plusRuntime() !== undefined && typeof uni.chooseImage === 'function'`；`PickHandle`/`pickHandle` | `apps/mobile/src/platform/uni.ts:476-483`、`:133-142` |
| `toPlusUrl` 现只折 `_doc` 前缀；`dirEntry` 按 `/` 切段下钻 | `apps/mobile/src/platform/uni.ts:283-287`、`:300-312` |
| 自检两条 `pick.*` 探测**无条件**断言 `chooseFile`/`chooseImage` 存在 | `apps/mobile/src/core/selfcheck.ts:355-378`、`:431-434` |
| `childKindsByContainer`（course 收 lesson；lesson 收 article/video/audio/quiz）/ `validateSubmitSegments` | `internal/httpapi/submit.go:70-76`、`:91-123` |
| `authenticate` 步骤 1（缺头 → 400 `auth_missing_header`）**先于**步骤 6 的体上限（413 `auth_body_too_large`） | `internal/httpapi/authmw.go:144-214` |
| `POST /v1/blob` 的 `maxBody = maxBlobBytes+(4<<10)` = 8 MiB+4 KiB | `internal/httpapi/server.go:121` |
| `sqlExec` 接口（`*sql.DB` 与 `*sql.Tx` 公共面） | `internal/store/store.go:38-42` |
| `GovernActionRemove` / `governRemoveThreshold=3` / `GovernThresholdForRoster` | `internal/store/govern.go:15-22`、`:54-59` |
| `addVoteTx`（写票置最前 → 读提案 → 计票 → 门槛 → 前置 → 应用 → 记 `executed_at`） | `internal/store/govern.go:465-527` |
| `governApplyTx` 的 `case GovernActionRemove`（`retireItemExec` → `"removed"`） | `internal/store/govern.go:552-590` |
| `SettleGovernProposal`（事务外派生名册 → 门槛判定 `:170` → `tx Begin` `:174` → 应用 → 记 `executed_at`） | `internal/store/govern_projection.go:149-207` |
| `UpsertSegmentSubmission`（同事务写 `items.author_id` + `segments` 全量替换） | `internal/store/submission.go:113-160` |
| `progress` 表列 `(id,item_id,position,done,day,updated_at,event_id,dirty)` | `internal/store/progress.go:72-74` |
| 测试 helper：`openTemp(t)` / `signedSubmission` / `authorOf` / `authorA|B|C` / `govRoster` / `seedCourse` 需新造 | `internal/store/store_test.go:9`、`submission_test.go:31`、`contributor_test.go:55-59`、`govern_test.go:183-189` |
| 手机端既有冲突用例：`govern.test.ts:104-106`（断言事件头**只有** `Content-Type`）、`selfcheck.test.ts:221-229`（缺 `chooseImage` 即 `pickOk:'fail'`） | `apps/mobile/src/core/govern.test.ts`、`apps/mobile/src/core/selfcheck.test.ts` |
| 课程详情页模板 `v-if="canEdit"` + `openEdit()`、`canEdit` 由台账 `state==='sent'` 设定 | `apps/mobile/src/pages/course/detail.vue:18`、`:261-263`、`:175` |
| 提案接线范式（`bootstrap()` → `createProposal`） | `apps/mobile/src/pages/directory/apply.vue:52-59` |
| `manifest.json` `versionName "0.19.0"` `:5` / `versionCode "24"` `:6` | `apps/mobile/src/manifest.json` |
| 文档清单表（列 `# / path / 描述 / 不做 / 依赖 / 状态`，最新为 #59） | `docs/README.md` |

**环境与工作区：** Windows PowerShell 5.1（**不支持 `&&` 与 heredoc**；多条命令用 `;` 分隔；`git commit` 用多个 `-m`）。Go 门禁需前缀 `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH;`。手机端用例在 `e:\code\base\apps\mobile` 下跑 `npx vitest run`（可带文件名过滤）。**本机 Go 无法完成同进程回环 TCP**，故一切需要 HTTP 的测试走 `httptest.NewRecorder()` / 进程内 harness，**不得**改用 `httptest.NewServer`。工作区可能有未提交的无关改动与未跟踪二进制——**不要动、不要 `git add`**，每次只 `git add` 本任务列出的确切文件；提交信息用 `fix: 中文描述` / `feat: 中文描述`。

**执行禁令（册子 §9 边界）：** 不新增删除专用端点、不新增资格读接口；不做客户端本地隐藏式「伪删除」；不改 `remove` 既有门槛常量与 `GovernAction` 取值域；不为免票选引入配置开关；不修 `governance.vue` 的 `ACTION_LABEL` 缺键；不做 `attr.body_md`/`attr.category` 的跨容器防御；不改 `POST /v1/submit` 的三区间铁律、`POST /v1/blob` 的 8 MiB 与 `blob_too_large`、`reason` 的 `1..200 rune` 契约、`GovernThreshold` 既有常量。

---

## 本计划的工程决策（核心价值；册子已定死的部分不得翻案）

| # | 决策 | 理由 | 落点 |
| --- | --- | --- | --- |
| 1 | **`localStep` 在 `govern.ts` 内私有复刻**（抛 `GovernError('client', …)`），不 import `comment.ts` 的私有函数 | `comment.ts` 的 `localStep` 未导出、且抛的是 `CommentError`；跨模块复用需改其可见性，扩大范围 | `core/govern.ts` |
| 2 | **行集预检放 `saveContainer` 的 `enqueueOrSend` 之前**，失败走**本地自带**的 `writeFailedLedger`（不导出 `submit.ts` 的 `writeLedger`） | `writeLedger` 私有；台账字段照其逐字复刻即可，避免改 `submit.ts` 的可见性 | `core/course-edit.ts` |
| 3 | **镜像常量 `CHILD_KINDS_BY_CONTAINER` 用小写 camel 名**（值 = `{course:['lesson'], lesson:['article','video','audio','quiz']}`） | 客户端命名习惯 camel；值与 Go `childKindsByContainer` 同值同义 | `core/course-edit.ts` |
| 4 | **能力探针拆两层**：纯函数 `pickCapabilityOf(hasPlus, pick)`（可测）+ 薄封装 `pickCapability()` | 纯函数可在 vitest 无全局依赖地覆盖四种组合；薄封装供运行时用 | `platform/uni.ts` |
| 5 | **`pickLocalFile` 保留 `.none` 时抛可读错**（仍走 `pickByChooseFile`） | 原行为即「无 chooseFile → 抛『当前运行时不支持选择文件』」；改成静默 null 会吞掉真机线索 | `platform/uni.ts` |
| 6 | **`dirEntry` 对 `file://` 结果整串交 `resolveUrl`**，其余仍按 `/` 切段 | `'file:///a/b'.split('/')` 会切出 `'file:'` 段使下钻失败 | `platform/uni.ts` |
| 7 | **免票选判定函数置于新建 `internal/store/free_remove.go`、名 `freeRemoveEligible`（未导出）** | 与 `govern.go` / `govern_projection.go` 解耦、单文件可自洽测试；**此点与册子 §5 原文（`govern.go` + 导出名 `FreeRemoveEligible`）不一致，以本计划为准** | `internal/store/free_remove.go` |
| 8 | **`freeRemoveEligible` 第一参数用 `sqlExec`**：settle 用 `s.db`（在 `tx.Begin()` **之前**），vote 用 `tx` | `SetMaxOpenConns(1)`：事务内只能用 `tx`，事务外只能用 `s.db`；同一函数两处复用 | `internal/store/free_remove.go` |
| 9 | **判定异常 fail-closed = 不降门槛**（`ferr != nil` 时保持既有 3 票），**不** abort settle / vote | 册子 §5 第 5 条：异常时退回既有 3 票；abort 会让反熵 settle 报错、影响面更大 | `govern_projection.go`、`govern.go` |
| 10 | **`ExecutedResult` 在应用后覆盖为 `'free_remove'`**，不动 `retireItemExec` 的返回值 | `executed_result` 仅诊断、不构成契约；覆盖点集中在两处 UPDATE 前 | `govern_projection.go`、`govern.go` |
| 11 | **AC 2 口径修正**（见下「执行前必读」第 7 条）：9 MiB 无签名头实际回 **400 `auth_missing_header`**（步骤 1 先于步骤 6）；验证判据改为「2 MiB 响应是 Go 的 JSON 而非 nginx `<html>`」 | `authmw.go:151-154` 先于 `:211-213`；无合法签名头不可能走到体上限 | Task 8 |
| 12 | **Task 8/9/10 无仓库文件 ⇒ 不产生 commit**，证据统一登记到文末「执行实况」 | 三者均为线上操作 / 核实，不落仓库产物 | Task 8/9/10 |
| 13 | **版本落 `0.20.0` / `25`**（`#59` 已落 `0.19.0`/`24`） | 节点二进制与手机端均有改动 | `manifest.json`、Task 11 |

---

## 文件结构

**新增**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `apps/mobile/src/core/errors.test.ts` | 创建 | `SERVER_ERROR_TEXT` 新增两条映射 + 前缀回落 + `errorCodeOf`（AC 4） |
| `apps/mobile/src/platform/uni.test.ts` | 创建 | `pickCapabilityOf` 四组合（AC 3）+ `toPlusUrl` 三分支（§3 附带修） |
| `internal/store/free_remove.go` | 创建 | `freeRemoveEligible` + `isCourseID`/`isLessonID` + `courseLessonIDs` + `otherLearnerCount` + `freeRemoveExecutedResult`（AC 5） |
| `internal/store/free_remove_test.go` | 创建 | 免票选四组断言 + 立即生效/停留 pending 两条路径（AC 5/AC 6） |

**修改**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `apps/mobile/src/core/govern.ts` | 修改 | `postGovernEvent` 补签名头；新增私有 `localStep`；删错误注释（§1/AC 1） |
| `apps/mobile/src/core/govern.test.ts` | 修改 | 事件头断言由「只有 Content-Type」改为「含 5 个签名头」（既有冲突必改） |
| `apps/mobile/src/core/errors.ts` | 修改 | 补 `item_segments_invalid` / `auth_body_too_large`（§4/AC 4） |
| `apps/mobile/src/core/course-edit.ts` | 修改 | 新增 `CHILD_KINDS_BY_CONTAINER` + `validateContainerSegments` + `writeFailedLedger`；`saveContainer` 前置预检（§4/AC 4） |
| `apps/mobile/src/core/course-edit.test.ts` | 修改 | 新增预检 + 失败不发网络请求用例 |
| `apps/mobile/src/platform/uni.ts` | 修改 | 新增 `pickCapabilityOf`/`pickCapability`；`pickLocalFile` 读探针；`toPlusUrl` 三分支 + 导出；`dirEntry` 分支（§3/AC 3） |
| `apps/mobile/src/core/selfcheck.ts` | 修改 | 两条 `pick.*` 按探针分支断言（§3/AC 3） |
| `apps/mobile/src/core/selfcheck.test.ts` | 修改 | 更新 `pick.*` 既有用例（既有冲突必改） |
| `apps/mobile/src/pages/course/detail.vue` | 修改 | 新增「删除本课程」入口（§5/AC 5） |
| `internal/store/govern.go` | 修改 | `addVoteTx` 接入免票选旁路（§5） |
| `internal/store/govern_projection.go` | 修改 | `SettleGovernProposal` 接入免票选旁路（§5/AC 6） |
| `apps/mobile/src/manifest.json` | 修改 | 版本 `0.20.0`/`25`（Task 11） |
| `docs/README.md` | 修改 | 文档清单表末登记本计划行（Task 11） |

**不改动（硬边界）：** `internal/httpapi/submit.go` 的 `validateSubmitSegments`/`childKindsByContainer` 与错误码取值域；`internal/httpapi/server.go` 的 `maxBlobBytes`；`internal/httpapi/authmw.go` 的判据与文案；`internal/store/govern.go` 的 `GovernAction*` 取值域与 `GovernThreshold*` 既有常量；`core/govern.ts` 的事件体键集与 `directory_add` 载荷派生；`core/submit.ts` 的 `writeLedger`/`enqueueOrSend` 签名；`core/comment.ts`；`internal/protocol` 属性键与槽位；内容包规范 v1；`schema_version`。

---

### Task 1: `postGovernEvent` 补请求签名头（词条提案 / 投票不再 400）

**Files:** Modify `apps/mobile/src/core/govern.ts`；Modify `apps/mobile/src/core/govern.test.ts`

- [ ] **Step 1: 改既有失败用例** —— `apps/mobile/src/core/govern.test.ts` 第 104-106 行当前断言事件头**只有** `Content-Type`（注释还说「不带 5 个 reqsig 头」），本 Task 修好后必破。替换为：

  ```ts
      const wire = lastEventPosted(http);
      // 事件路径改为带 5 个请求签名头（本册 §1）：与 core/comment.ts 的 /v1/event 同口径，
      // 否则节点 authenticate 步骤 1 直接回 400 auth_missing_header。
      expect(wire.headers['Content-Type']).toBe('application/json');
      for (const k of ['X-Base-Id', 'X-Base-Alg', 'X-Base-Ts', 'X-Base-Nonce', 'X-Base-Sig']) {
        expect(wire.headers[k]).toBeTruthy();
      }
  ```

- [ ] **Step 2: 跑测试确认失败** —— 在 `e:\code\base\apps\mobile` 下执行：

  ```
  npx vitest run govern.test.ts
  ```

  判据：`govern.test.ts` 中「发起：走 POST /v1/event …」用例 **FAIL**（`X-Base-Id` 为 `undefined`）。

- [ ] **Step 3: 写实现** —— `apps/mobile/src/core/govern.ts`

  **（a）import 增加 `signRequestHeaders`**（第 13 行）：

  ```ts
  import { peekLocalIdentity, signRequestHeaders, type Identity } from './identity';
  ```

  **（b）新增私有 `localStep`**（放在 `ensureIdentity` 函数之后、`postGovernEvent` 之前）：

  ```ts
  /**
   * 把本地步骤（编码 / 签名）的裸错误包成带原因的可读错误。
   * 与 `core/comment.ts` 的 `localStep` 同口径，但抛 `GovernError`（本模块只暴露一种错误类型）。
   */
  function localStep<T>(what: string, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      throw new GovernError('client', `${what}失败：${(e as Error).message ?? String(e)}`);
    }
  }
  ```

  **（c）替换 `postGovernEvent` 的注释与函数体**（第 124-154 行整段）：

  ```ts
  /**
   * 构造并投递一条 `govern.v1` 事件。内容签名覆盖 `canonical({event_id, type, created_at, body})`
   * （与 `core/wire.ts` 的 `buildEventWire` 逐字同构），**且必须再带 5 个请求签名头**——
   * 节点 `authenticate` 第一步即判缺头（400 `auth_missing_header`），与事件内容签名无关（本册 §1）。
   * `event_id` 用 `randomBytes(16)` 保证幂等（同 id 重发由节点投影判重放、不报冲突）。
   * 返回节点的 `conflict` 标记：true = 同 `proposal_id` 已被更早的 `(created_at, event_id)` 占位。
   */
  async function postGovernEvent(o: GovernOptions, ident: Identity, body: Json): Promise<{ conflict: boolean }> {
    const eventId = bytesToHex(randomBytes(16));
    const payload: Json = { event_id: eventId, type: GOVERN_EVENT_TYPE, created_at: Date.now(), body };
    const sig = sign(ident.seedHex, utf8(canonicalize(payload)));
    const wire = JSON.stringify({ ...(payload as Record<string, Json>), sig });
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
      throw new GovernError('network', '需要联网才能完成该操作');
    }
    if (res.status >= 200 && res.status < 300) {
      let conflict = false;
      try {
        conflict = (JSON.parse(decodeUtf8(res.body)) as { conflict?: boolean }).conflict === true;
      } catch {
        conflict = false; // 200 但体不可解析：按「无冲突」处理，对齐以随后的重拉为准
      }
      return { conflict };
    }
    const code = errorCodeOf(decodeUtf8(res.body));
    if (res.status === 429) throw new GovernError('rate_limited', errorText(code, '操作过于频繁，请稍后再试'));
    if (res.status >= 500) throw new GovernError('server', `治理事件投递失败（HTTP ${res.status}）`);
    throw new GovernError('rejected', errorText(code, `治理事件投递失败（HTTP ${res.status}）`));
  }
  ```

- [ ] **Step 4: 跑测试确认通过** —— 在 `e:\code\base\apps\mobile` 下执行：

  ```
  npx vitest run govern.test.ts
  ```

  判据：`govern.test.ts` 全绿（含「投票：POST /v1/event」等既有用例）。

- [ ] **Step 5: 提交** ——

  ```
  git add apps/mobile/src/core/govern.ts apps/mobile/src/core/govern.test.ts
  git commit -m "fix(mobile): 治理事件补请求签名头，词条提案与投票不再 400（#60 §1/AC1）"
  ```

---

### Task 2: `errors.ts` 补两条错误码中文映射

**Files:** Modify `apps/mobile/src/core/errors.ts`；Create `apps/mobile/src/core/errors.test.ts`

- [ ] **Step 1: 写失败的测试** —— 新建 `apps/mobile/src/core/errors.test.ts`：

  ```ts
  import { describe, expect, it } from 'vitest';

  import { errorCodeOf, errorText } from './errors';

  describe('错误码中文映射（本册 §4）', () => {
    it('item_segments_invalid → 行集不合法（此前落回裸兜底串）', () => {
      expect(errorText('item_segments_invalid', '提交失败（HTTP 400）')).toBe(
        '课程 / 课时的行集不合法：请检查属性与子项清单',
      );
    });

    it('auth_body_too_large → 体超限（不再被 auth_ 前缀吞成「签名校验失败」）', () => {
      expect(errorText('auth_body_too_large', '提交失败（HTTP 413）')).toBe('提交内容超过 64KB');
    });

    it('未单列的 auth_* / identity_* 仍回落「签名校验失败」', () => {
      expect(errorText('auth_nonce_replay', 'x')).toBe('签名校验失败，请重试');
      expect(errorText('identity_alg_unsupported', 'x')).toBe('签名校验失败，请重试');
    });

    it('未知码用调用方兜底文案', () => {
      expect(errorText('some_unknown_code', '提交失败（HTTP 400）')).toBe('提交失败（HTTP 400）');
    });

    it('errorCodeOf 解析 code；坏 JSON 得空串', () => {
      expect(errorCodeOf('{"code":"item_segments_invalid"}')).toBe('item_segments_invalid');
      expect(errorCodeOf('not json')).toBe('');
      expect(errorCodeOf('{}')).toBe('');
    });
  });
  ```

- [ ] **Step 2: 跑测试确认失败** —— 在 `e:\code\base\apps\mobile` 下执行：

  ```
  npx vitest run errors.test.ts
  ```

  判据：前两条用例 **FAIL**（`item_segments_invalid` 得兜底串；`auth_body_too_large` 得「签名校验失败，请重试」）。

- [ ] **Step 3: 写实现** —— `apps/mobile/src/core/errors.ts`，在 `SERVER_ERROR_TEXT`（第 9-38 行）内追加两条键：

  ```ts
    // 本册 §4：此前唯一落回裸兜底串的 400 码——补上等于把「无线索 400」变成可读原因。
    item_segments_invalid: '课程 / 课时的行集不合法：请检查属性与子项清单',
    // 本册 §4：auth_* 前缀原本一律回落「签名校验失败」，体超限需单独可读。
    auth_body_too_large: '提交内容超过 64KB',
  ```

  放在 `item_id_taken: '该条目已被他人创建',` 之后、`blob_too_large` 之前即可（表内顺序不影响语义）。

- [ ] **Step 4: 跑测试确认通过** —— 在 `e:\code\base\apps\mobile` 下执行：

  ```
  npx vitest run errors.test.ts
  ```

  判据：5 条用例全 `PASS`。

- [ ] **Step 5: 提交** ——

  ```
  git add apps/mobile/src/core/errors.ts apps/mobile/src/core/errors.test.ts
  git commit -m "fix(mobile): 补 item_segments_invalid / auth_body_too_large 中文映射（#60 §4）"
  ```

---

### Task 3: 客户端容器行集预检（`validateContainerSegments`）

**Files:** Modify `apps/mobile/src/core/course-edit.ts`；Modify `apps/mobile/src/core/course-edit.test.ts`

- [ ] **Step 1: 写失败的测试** —— 在 `apps/mobile/src/core/course-edit.test.ts` 末尾追加一个 `describe`（并把 `validateContainerSegments` 加入第 5-14 行的 import）：

  ```ts
  describe('validateContainerSegments / saveContainer 预检（本册 §4）', () => {
    it('合法行集 ⇒ ok', () => {
      expect(validateContainerSegments('lesson', buildContainerSegments(lessonForm())).ok).toBe(true);
      expect(validateContainerSegments('course', buildContainerSegments(emptyContainerForm('course', 'course/c1'))).ok).toBe(true);
    });

    it('course 挂 article 子项 ⇒ 指名到行，且 saveContainer 不发网络请求', async () => {
      const bad: ContainerForm = {
        ...emptyContainerForm('course', 'course/c1'),
        title: '课',
        children: [{ kind: 'article', itemId: 'course/c1/article/a1' }],
      };
      const check = validateContainerSegments('course', buildContainerSegments(bad));
      expect(check.ok).toBe(false);
      expect(check.message).toContain('第 1 个子项');
      expect(check.message).toContain('article');

      const http = new FakeHttp();
      const repo = new MemoryRepo();
      const o: SubmitOptions = { adapters: fakeAdapters(http, new MemoryFs(), new FakePackReader()), repo, nodeBaseUrl: BASE };
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'course/c1', created: true }));

      const out = await saveContainer(o, bad);
      expect(out.ledgerState).toBe('failed');
      expect(out.message).toContain('第 1 个子项');
      expect(http.posted.some((p) => p.url === `${BASE}/v1/submit`)).toBe(false);
      expect((await repo.getSubmission('course/c1'))!.state).toBe('failed');
    });

    it('seq 重复 ⇒ 判否；seq=0 非 digest ⇒ 判否（镜像三区间铁律）', () => {
      const dup = validateContainerSegments('course', [
        { seq: 0, kind: 'digest', text: 'x' },
        { seq: 0, kind: 'digest', text: 'y' },
      ]);
      expect(dup.ok).toBe(false);
      expect(dup.message).toContain('重复');

      const wrongDigest = validateContainerSegments('course', [{ seq: 0, kind: 'lesson', text: 'course/c1/lesson/l1' }]);
      expect(wrongDigest.ok).toBe(false);
    });
  });
  ```

- [ ] **Step 2: 跑测试确认失败** —— 在 `e:\code\base\apps\mobile` 下执行：

  ```
  npx vitest run course-edit.test.ts
  ```

  判据：编译失败（`validateContainerSegments` 未导出）。

- [ ] **Step 3: 写实现** —— `apps/mobile/src/core/course-edit.ts`

  **（a）扩张 `attrs` 的 import**（第 9-26 行）追加 `attrSeqsCanonical`、`isAttrKind`、`type AttrSlot`：

  ```ts
  import {
    ATTR_ATTACHMENT,
    ATTR_BADGE,
    ATTR_BODY_MD,
    ATTR_CATEGORY,
    ATTR_COVER,
    ATTR_DIFFICULTY,
    ATTR_DURATION,
    ATTR_INSTRUCTOR,
    ATTR_TITLE_COLOR,
    DIGEST_KIND,
    assignAttrSeqs,
    attrSeqsCanonical,
    isAttrKind,
    isTitleColor,
    segmentsContentHash,
    serializeBadge,
    type AttrLine,
    type AttrSlot,
    type SubmitSegmentRow,
  } from './attrs';
  ```

  **（b）新增镜像常量与预检函数**（放在 `buildContainerSegments` 之后、`toLocalContainer` 之前）：

  ```ts
  /**
   * 容器子项词表（与 `internal/httpapi/submit.go` 的 `childKindsByContainer` **同值同义**）。
   * 这是「客户端可判」与「节点裁决」的唯一交集，改一处必须改两处。
   */
  const CHILD_KINDS_BY_CONTAINER: Record<ContainerType, string[]> = {
    course: ['lesson'],
    lesson: ['article', 'video', 'audio', 'quiz'],
  };

  /**
   * 行集预检（本册 §4）：判据与节点 `validateSubmitSegments` 同构，**失败指名到行**。
   * 目的是把「提交后只看到兜底 400」提前到「保存前看到是哪一行」——尤其是 `loadContainerForm`
   * 会把库里原样的 kind 带回表单、原样发回，而客户端新增行恒合法，故非法来源只能是既有清单行。
   */
  export function validateContainerSegments(
    type: ContainerType,
    rows: SubmitSegmentRow[],
  ): { ok: boolean; message: string } {
    const ordered = [...rows].sort((a, b) => a.seq - b.seq);
    const allowed = new Set(CHILD_KINDS_BY_CONTAINER[type]);
    const attrs: AttrSlot[] = [];
    let childNo = 0;
    for (let i = 0; i < ordered.length; i++) {
      const s = ordered[i]!;
      if (i > 0 && s.seq === ordered[i - 1]!.seq) {
        return { ok: false, message: `第 ${i + 1} 行的 seq=${s.seq} 与上一行重复` };
      }
      if (s.seq < 0) {
        if (!isAttrKind(s.kind)) {
          return { ok: false, message: `属性行的 kind=${s.kind} 不合法（seq=${s.seq}）` };
        }
        attrs.push({ seq: s.seq, kind: s.kind, text: s.text });
      } else if (s.seq === 0) {
        if (s.kind !== DIGEST_KIND) {
          return { ok: false, message: `seq=0 的简介行 kind 必须是 ${DIGEST_KIND}，实际是 ${s.kind}` };
        }
      } else {
        childNo += 1;
        if (!allowed.has(s.kind)) {
          const scope = type === 'course' ? '课程只能挂课时' : '课时只能挂文章 / 视频 / 音频 / 测验';
          return { ok: false, message: `第 ${childNo} 个子项的 kind=${s.kind} 不合法：${scope}` };
        }
      }
    }
    if (!attrSeqsCanonical(attrs)) {
      return { ok: false, message: '属性行未按规范排布（seq<0 须按 kind 字典序分配）' };
    }
    return { ok: true, message: '' };
  }
  ```

  **（c）新增私有 `writeFailedLedger`**（放在 `loadContainerForm` 之后、`saveContainer` 之前），字段照 `core/submit.ts:276-295` 的 `writeLedger` 逐字复刻：

  ```ts
  /**
   * 预检失败写台账 `failed`（字段与 `core/submit.ts` 的 `writeLedger` 同口径）。
   * 本函数**不导出**、也**不发网络请求**：行集非法时提交必然被节点判 `item_segments_invalid`，
   * 与其等一个兜底 400，不如本地就写明是哪一行（AC 4）。
   */
  async function writeFailedLedger(
    o: SubmitOptions,
    form: ContainerForm,
    segments: SubmitSegmentRow[],
    reason: string,
  ): Promise<void> {
    const prev = await o.repo.getSubmission(form.itemId);
    await o.repo.saveSubmission({
      itemId: form.itemId,
      type: form.type,
      title: form.title.trim(),
      bodyMd: '',
      questionJson: '',
      linksJson: '',
      segmentsJson: JSON.stringify([...segments].sort((a, b) => a.seq - b.seq)),
      state: 'failed',
      reason,
      created: prev?.created ?? 0,
      queuedAt: new Date().toISOString(),
      sentAt: '',
      localOnly: false,
    });
  }
  ```

  **（d）改写 `saveContainer`**（第 184-196 行整段）：

  ```ts
  export async function saveContainer(o: SubmitOptions, form: ContainerForm): Promise<SubmitOutcome> {
    const { item, segments } = toLocalContainer(form, new Date().toISOString());
    // 先本地乐观落库（册子 #56 §2.1）：本机立刻可读、可点开、可编辑，不依赖节点重建内容包。
    await o.repo.upsertLocalContainer(item, segments);
    // 行集预检（本册 §4）：客户端能判的先判、指名到行、不发网络请求。
    const check = validateContainerSegments(form.type, segments);
    if (!check.ok) {
      await writeFailedLedger(o, form, segments, check.message);
      return { itemId: form.itemId, created: false, ledgerState: 'failed', message: check.message };
    }
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

- [ ] **Step 4: 跑测试确认通过** —— 在 `e:\code\base\apps\mobile` 下执行：

  ```
  npx vitest run course-edit.test.ts
  ```

  判据：全绿（含既有 `buildContainerSegments` / `loadContainerForm` / `saveContainer` 用例）。

- [ ] **Step 5: 提交** ——

  ```
  git add apps/mobile/src/core/course-edit.ts apps/mobile/src/core/course-edit.test.ts
  git commit -m "feat(mobile): 容器行集预检，非法行指名到行且不发请求（#60 §4/AC4）"
  ```

---

### Task 4: 选文件能力探针 + 自检分支化

**Files:** Modify `apps/mobile/src/platform/uni.ts`；Modify `apps/mobile/src/core/selfcheck.ts`；Modify `apps/mobile/src/core/selfcheck.test.ts`；Create `apps/mobile/src/platform/uni.test.ts`

- [ ] **Step 1: 写失败的测试** —— 新建 `apps/mobile/src/platform/uni.test.ts`：

  ```ts
  import { describe, expect, it } from 'vitest';

  import { pickCapabilityOf } from './uni';

  describe('选文件能力探针（本册 §3）', () => {
    it('App 端（有 plus）优先相册（chooseImage）', () => {
      expect(pickCapabilityOf(true, { chooseImage: () => undefined })).toBe('album');
      expect(pickCapabilityOf(true, { chooseImage: () => undefined, chooseFile: () => undefined })).toBe('album');
    });

    it('无相册时：有 chooseFile 走 chooseFile，都没有则 none', () => {
      expect(pickCapabilityOf(true, { chooseFile: () => undefined })).toBe('chooseFile');
      expect(pickCapabilityOf(true, {})).toBe('none');
    });

    it('无 plus（H5 / 老内核）不选相册，只认 chooseFile', () => {
      expect(pickCapabilityOf(false, { chooseImage: () => undefined })).toBe('none');
      expect(pickCapabilityOf(false, { chooseFile: () => undefined })).toBe('chooseFile');
    });
  });
  ```

  同时改既有冲突用例 `apps/mobile/src/core/selfcheck.test.ts` 第 221-229 行（分支化后 `{chooseFile}` + 有 plus ⇒ 探针 `'chooseFile'` ⇒ 两项都 ok）：

  ```ts
    it('按运行时探针分支：仅有 chooseFile（无相册）时两项都 ok', async () => {
      const r = await runSelfCheck(null, { plus: FAKE_PLUS, pick: { chooseFile: () => undefined } });
      const ids = r.items.map((i) => i.id);
      expect(ids).toContain('pick.choose_file');
      expect(ids).toContain('pick.album');
      expect(r.items.find((i) => i.id === 'pick.choose_file')?.status).toBe('ok');
      expect(r.items.find((i) => i.id === 'pick.album')?.status).toBe('ok');
      expect(r.flags.pickOk).toBe('ok');
    });
  ```

  （第 231-236 行「都缺 ⇒ fail；都在 ⇒ ok」在新语义下仍成立，**不改**：`{}` + 有 plus ⇒ `'none'` ⇒ 两项 fail；`FAKE_PICK` 含 `chooseImage` ⇒ `'album'` ⇒ 两项 ok。）

- [ ] **Step 2: 跑测试确认失败** —— 在 `e:\code\base\apps\mobile` 下执行：

  ```
  npx vitest run uni.test.ts selfcheck.test.ts
  ```

  判据：`uni.test.ts` 编译失败（`pickCapabilityOf` 未导出）；`selfcheck.test.ts` 第 221 行用例 FAIL。

- [ ] **Step 3: 写实现**

  **（a）`apps/mobile/src/platform/uni.ts` 新增探针**（放在 `pickHandle()` 之后、`assertAppRuntime` 之前）：

  ```ts
  /**
   * 选文件能力探针（本册 §3）：App 端（有 plus）优先相册（`uni.chooseImage`），
   * 否则退回 `uni.chooseFile`，都没有则 `'none'`。纯函数，供 `pickLocalFile` 与自检**同源**判定。
   */
  export function pickCapabilityOf(hasPlus: boolean, pick: PickHandle): 'album' | 'chooseFile' | 'none' {
    if (hasPlus && typeof pick.chooseImage === 'function') return 'album';
    if (typeof pick.chooseFile === 'function') return 'chooseFile';
    return 'none';
  }

  /** 取当前运行时的选文件能力（唯一判定源，本册 §3）。 */
  export function pickCapability(): 'album' | 'chooseFile' | 'none' {
    return pickCapabilityOf(plusRuntime() !== undefined, pickHandle());
  }
  ```

  **（b）改写 `pickLocalFile`**（第 476-483 行）：

  ```ts
  export async function pickLocalFile(): Promise<PickedFile | null> {
    const uni = uniGlobal();
    // 能力判定与自检同源（本册 §3）；'none' 时仍走 pickByChooseFile 以抛既有的可读错误。
    const hit = pickCapability() === 'album' ? await pickByAlbum(uni) : await pickByChooseFile(uni);
    if (hit === null) return null;
    const bytes = await new PlusFs(assertAppRuntime()).readFile(hit.path);
    return { name: hit.name, bytes };
  }
  ```

  **（c）`apps/mobile/src/core/selfcheck.ts` import 增 `pickCapabilityOf`**（第 10 行）：

  ```ts
  import { base64ToBytes, bytesToBase64, pickCapabilityOf, pickHandle, plusRuntime, type PickHandle } from '../platform/uni';
  ```

  **（d）替换两条 `pick.*` 探测**（第 355-378 行整段）：

  ```ts
    {
      id: 'pick.choose_file',
      group: '文件选择',
      name: '选择文件能力（按运行时探针）',
      affects: '选图片 / 附件',
      flag: 'pickOk',
      scope: 'standalone',
      async run(plus, pick) {
        const cap = pickCapabilityOf(plus !== undefined, pick);
        if (cap === 'none') throw new Error('运行时不提供 uni.chooseImage 或 uni.chooseFile');
        if (cap === 'album') return 'App 端以相册选取为准（uni.chooseImage）';
        return 'uni.chooseFile 可用';
      },
    },
    {
      id: 'pick.album',
      group: '文件选择',
      name: '选择图片能力（相册支，按运行时探针）',
      affects: '选图片 / 附件（App 支）',
      flag: 'pickOk',
      scope: 'standalone',
      async run(plus, pick) {
        const cap = pickCapabilityOf(plus !== undefined, pick);
        if (cap === 'none') throw new Error('运行时不提供 uni.chooseImage 或 uni.chooseFile');
        if (cap === 'album') return 'uni.chooseImage 可用';
        return '当前运行时以 uni.chooseFile 为准';
      },
    },
  ```

  （两项 `id` / `flag` / `scope` 不变，故 `selfcheck.test.ts` 的 `ALL_IDS` 与第 185 行断言不受影响。）

- [ ] **Step 4: 跑测试确认通过** —— 在 `e:\code\base\apps\mobile` 下执行：

  ```
  npx vitest run uni.test.ts selfcheck.test.ts
  ```

  判据：两个文件全绿（含降级模式 `runSelfCheck(null,{plus:FAKE_PLUS})` 的 `pickOk:'fail'` 用例——Node 下 `pickHandle()` 回 `{}`、探针为 `'none'`）。

- [ ] **Step 5: 提交** ——

  ```
  git add apps/mobile/src/platform/uni.ts apps/mobile/src/core/selfcheck.ts apps/mobile/src/core/selfcheck.test.ts apps/mobile/src/platform/uni.test.ts
  git commit -m "fix(mobile): 选文件能力收敛为唯一探针，自检按探针分支（#60 §3/AC3）"
  ```

---

### Task 5: `toPlusUrl` 支持 `file://` 与裸绝对路径

**Files:** Modify `apps/mobile/src/platform/uni.ts`；Modify `apps/mobile/src/platform/uni.test.ts`

- [ ] **Step 1: 写失败的测试** —— 在 `apps/mobile/src/platform/uni.test.ts` 追加（import 增 `toPlusUrl` 与 `type PlusRuntime`）：

  ```ts
  import { pickCapabilityOf, toPlusUrl, type PlusRuntime } from './uni';

  /** 假 io：'_doc' → 平台文档根；'file://…' → 去掉 scheme 的平台路径；其余原样。 */
  function fakeIo(): PlusRuntime['io'] {
    return {
      convertLocalFileSystemURL(path: string): string {
        if (path === '_doc') return '/storage/emulated/0/Android/data/base/doc';
        if (path.startsWith('file://')) return path.slice('file://'.length);
        return path;
      },
      resolveLocalFileSystemURL(): void {
        throw new Error('测试不调 resolve');
      },
      FileReader: class {},
    } as unknown as PlusRuntime['io'];
  }

  describe('toPlusUrl：路径 → plus.io URL（本册 §3 附带修）', () => {
    const io = fakeIo();

    it('file:// 前缀统一过 convertLocalFileSystemURL（真机相册 / 附件给的绝对 URL）', () => {
      expect(toPlusUrl(io, 'file:///storage/emulated/0/DCIM/a.jpg')).toBe('/storage/emulated/0/DCIM/a.jpg');
    });

    it('_doc 平台路径折成 _doc/…', () => {
      expect(toPlusUrl(io, '/storage/emulated/0/Android/data/base/doc/base/pack')).toBe('_doc/base/pack');
    });

    it('其余绝对路径补 file:// 前缀，避免被当相对 URL', () => {
      expect(toPlusUrl(io, '/storage/other/x')).toBe('file:///storage/other/x');
    });
  });
  ```

- [ ] **Step 2: 跑测试确认失败** —— 在 `e:\code\base\apps\mobile` 下执行：

  ```
  npx vitest run uni.test.ts
  ```

  判据：编译失败（`toPlusUrl` 未导出）。

- [ ] **Step 3: 写实现** —— `apps/mobile/src/platform/uni.ts`

  **（a）改写并导出 `toPlusUrl`**（第 283-287 行）：

  ```ts
  /**
   * 路径 → plus.io 认的 URL。三种形态（本册 §3 附带修）：
   *  1. `file://` 前缀（真机相册 / 附件选择器给的绝对 URL）→ 统一过 `convertLocalFileSystemURL`；
   *  2. `_doc` 平台路径（其实例绝对路径由 `convertLocalFileSystemURL('_doc')` 给出）→ 折成 `_doc/…`；
   *  3. 其余绝对路径 → 补 `file://` 前缀，否则 plus.io 会把裸 `/storage/…` 当相对 URL 而读取失败。
   */
  export function toPlusUrl(io: PlusRuntime['io'], absPath: string): string {
    if (absPath.startsWith('file://')) return io.convertLocalFileSystemURL(absPath);
    const doc = io.convertLocalFileSystemURL(DOC);
    if (absPath.startsWith(doc)) return DOC + absPath.slice(doc.length);
    return absPath.startsWith('/') ? `file://${absPath}` : absPath;
  }
  ```

  **（b）改写 `dirEntry` 首段**（第 301-313 行），`file://` 结果整串交 `resolveUrl`：

  ```ts
    private async dirEntry(absDir: string): Promise<PlusEntry> {
      const url = toPlusUrl(this.p.io, absDir);
      // `'file:///a/b'.split('/')` 会切出 `'file:'` 段使下钻失败，故 file:// 整串解析。
      if (url.startsWith('file://')) return resolveUrl(this.p.io, url);
      const parts = url.split('/').filter(Boolean);
      let entry = await resolveUrl(this.p.io, parts[0] as string);
      for (const name of parts.slice(1)) {
        const parent = entry;
        entry = await new Promise<PlusEntry>((resolve, reject) => {
          parent.getDirectory(name, { create: true, exclusive: false }, resolve, (e) =>
            reject(new Error(`建目录失败 ${absDir}/${name}: ${JSON.stringify(e)}`)),
          );
        });
      }
      return entry;
    }
  ```

- [ ] **Step 4: 跑测试确认通过** —— 在 `e:\code\base\apps\mobile` 下执行：

  ```
  npx vitest run uni.test.ts
  ```

  判据：`uni.test.ts` 全绿（探针 4 条 + `toPlusUrl` 3 条）。

- [ ] **Step 5: 提交** ——

  ```
  git add apps/mobile/src/platform/uni.ts apps/mobile/src/platform/uni.test.ts
  git commit -m "fix(mobile): toPlusUrl 支持 file:// 与裸绝对路径（#60 §3）"
  ```

---

### Task 6: 节点侧免票选删除判据（`freeRemoveEligible`）

**Files:** Create `internal/store/free_remove.go`；Create `internal/store/free_remove_test.go`；Modify `internal/store/govern.go`；Modify `internal/store/govern_projection.go`

- [ ] **Step 1: 写失败的测试** —— 新建 `internal/store/free_remove_test.go`：

  ```go
  package store

  import "testing"

  // seedCourse 造一门带归属的课程（author_id=author）；lessons 为 seq>=1 的课时 id 列表。
  // 直接走 UpsertSegmentSubmission：它同事务写 items.author_id 与 segments，且不验签。
  func seedCourse(t *testing.T, st *Store, courseID, author string, lessons []string) {
  	t.Helper()
  	segs := []Segment{}
  	for i, lid := range lessons {
  		segs = append(segs, Segment{ItemID: courseID, Seq: i + 1, Kind: "lesson", Text: lid})
  	}
  	if _, err := st.UpsertSegmentSubmission(SegmentSubmission{
  		ItemID: courseID, Type: "course", Title: "课", Segments: segs, AuthorID: author, AuthorSig: "00",
  	}); err != nil {
  		t.Fatalf("UpsertSegmentSubmission(%s): %v", courseID, err)
  	}
  }

  // seedProgress 直接写一行 progress（测试造数，绕过事件投影）。
  func seedProgress(t *testing.T, st *Store, learnerID, itemID string) {
  	t.Helper()
  	if _, err := st.db.Exec(`INSERT INTO progress(id,item_id,position,done,day,updated_at,event_id,dirty)
  		VALUES(?,?,?,?,?,?,?,0)`, learnerID, itemID, 0, 0, "2026-10-01", 1, "ev-"+learnerID+"-"+itemID); err != nil {
  		t.Fatalf("造 progress: %v", err)
  	}
  }

  func TestFreeRemoveEligible(t *testing.T) {
  	// 组 1：仅创建者、无课时 ⇒ true
  	st := openTemp(t)
  	seedCourse(t, st, "course/c1", authorA, nil)
  	if got, err := freeRemoveEligible(st.db, "course/c1", authorA); err != nil || !got {
  		t.Fatalf("无课时应可免票选: got=%v err=%v", got, err)
  	}
  	// 组 4：非创建者（如名册内治理者）⇒ false
  	if got, err := freeRemoveEligible(st.db, "course/c1", authorB); err != nil || got {
  		t.Fatalf("非创建者不应免票选: got=%v err=%v", got, err)
  	}
  	// 组 3：有课时、无他人 progress ⇒ true（此处同时验证「有课时」不短路为假）
  	st2 := openTemp(t)
  	seedCourse(t, st2, "course/c2", authorA, []string{"course/c2/lesson/l1"})
  	if got, err := freeRemoveEligible(st2.db, "course/c2", authorA); err != nil || !got {
  		t.Fatalf("有课时但无他人学习应可免票选: got=%v err=%v", got, err)
  	}
  	// 组 2：有他人 progress ⇒ false
  	seedProgress(t, st2, authorB, "course/c2/lesson/l1")
  	if got, err := freeRemoveEligible(st2.db, "course/c2", authorA); err != nil || got {
  		t.Fatalf("有他人学习不应免票选: got=%v err=%v", got, err)
  	}
  	// 创建者自己的 progress 不算「他人」
  	st3 := openTemp(t)
  	seedCourse(t, st3, "course/c3", authorA, []string{"course/c3/lesson/l1"})
  	seedProgress(t, st3, authorA, "course/c3/lesson/l1")
  	if got, err := freeRemoveEligible(st3.db, "course/c3", authorA); err != nil || !got {
  		t.Fatalf("仅创建者自己的 progress 仍应可免票选: got=%v err=%v", got, err)
  	}
  	// 课时同规则（册子 §5 第 4 条）：条件 2 不适用，只看条件 3
  	st4 := openTemp(t)
  	if _, err := st4.UpsertSegmentSubmission(SegmentSubmission{
  		ItemID: "course/c4/lesson/l1", Type: "lesson", Title: "课",
  		Segments: []Segment{{ItemID: "course/c4/lesson/l1", Seq: -1, Kind: "attr.cover", Text: "x"}},
  		AuthorID: authorA, AuthorSig: "00",
  	}); err != nil {
  		t.Fatalf("造课时: %v", err)
  	}
  	if got, err := freeRemoveEligible(st4.db, "course/c4/lesson/l1", authorA); err != nil || !got {
  		t.Fatalf("课时无他人学习应可免票选: got=%v err=%v", got, err)
  	}
  	seedProgress(t, st4, authorB, "course/c4/lesson/l1")
  	if got, err := freeRemoveEligible(st4.db, "course/c4/lesson/l1", authorA); err != nil || got {
  		t.Fatalf("课时有他人学习不应免票选: got=%v err=%v", got, err)
  	}
  	// 非容器（article）⇒ false
  	st5 := openTemp(t)
  	if got, err := freeRemoveEligible(st5.db, "article/x", authorA); err != nil || got {
  		t.Fatalf("非容器条目不应免票选: got=%v err=%v", got, err)
  	}
  }

  // 无课时课程：remove 提案投影后 settle 立即生效、executed_result 记 'free_remove'、条目下架（AC 5）。
  func TestFreeRemoveSettlesImmediately(t *testing.T) {
  	st := openTemp(t)
  	seedCourse(t, st, "course/c6", authorA, nil)
  	it, ok, err := st.GetItem("course/c6")
  	if err != nil || !ok {
  		t.Fatalf("GetItem: ok=%v err=%v", ok, err)
  	}
  	id, err := st.CreateProposal(Proposal{
  		Action: GovernActionRemove, ItemID: "course/c6", ProposerID: authorA,
  		BaseContentHash: it.ContentHash, CreatedAt: 1,
  	})
  	if err != nil {
  		t.Fatalf("CreateProposal: %v", err)
  	}
  	if err := st.SettleGovernProposal(id, govRoster(), false); err != nil {
  		t.Fatalf("SettleGovernProposal: %v", err)
  	}
  	p, _, err := st.GetProposal(id)
  	if err != nil {
  		t.Fatalf("GetProposal: %v", err)
  	}
  	if p.ExecutedAt == 0 || p.ExecutedResult != freeRemoveExecutedResult {
  		t.Fatalf("无课时应免票选立即生效且记 free_remove: %+v", p)
  	}
  	after, ok, err := st.GetItem("course/c6")
  	if err != nil || !ok || after.State != "removed" {
  		t.Fatalf("应已下架: ok=%v it=%+v err=%v", ok, after, err)
  	}
  }

  // 有他人学习的课程：即便已投影，settle 也停留 pending、门槛仍 3（AC 6）。
  func TestFreeRemoveNotAppliedWhenOthersLearned(t *testing.T) {
  	st := openTemp(t)
  	seedCourse(t, st, "course/c7", authorA, []string{"course/c7/lesson/l1"})
  	seedProgress(t, st, authorB, "course/c7/lesson/l1")
  	id, err := st.CreateProposal(Proposal{
  		Action: GovernActionRemove, ItemID: "course/c7", ProposerID: authorA,
  		BaseContentHash: "", CreatedAt: 1,
  	})
  	if err != nil {
  		t.Fatalf("CreateProposal: %v", err)
  	}
  	if err := st.SettleGovernProposal(id, govRoster(), false); err != nil {
  		t.Fatalf("SettleGovernProposal: %v", err)
  	}
  	p, _, err := st.GetProposal(id)
  	if err != nil {
  		t.Fatalf("GetProposal: %v", err)
  	}
  	if p.ExecutedAt != 0 || p.VoidedAt != 0 {
  		t.Fatalf("有他人学习不应定案（门槛仍 3、票不足）: %+v", p)
  	}
  	if got := GovernThreshold(GovernActionRemove); got != 3 {
  		t.Fatalf("remove 门槛应仍为 3，得 %d", got)
  	}
  }
  ```

- [ ] **Step 2: 跑测试确认失败** ——

  ```
  $env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go test ./internal/store/ -run FreeRemove
  ```

  判据：编译失败（`freeRemoveEligible` / `freeRemoveExecutedResult` 未定义）。

- [ ] **Step 3: 写实现**

  **（a）新建 `internal/store/free_remove.go`**：

  ```go
  package store

  import (
  	"database/sql"
  	"errors"
  	"fmt"
  	"strings"
  )

  // freeRemoveExecutedResult 是免票选删除生效后的 executed_result（诊断信息，不构成契约，本册 §5）。
  const freeRemoveExecutedResult = "free_remove"

  // freeRemoveEligible 判定一条 remove 提案是否可不经票选直接生效（本册 §5「免票选自由删除」）。
  //
  // 判据（顺序即短路顺序）：
  //  1. 目标须是容器（course/<cid> 或 course/<cid>/lesson/<lid>），否则 false；
  //  2. actor 必须是创建者：items.author_id 为空（导入器产出 / 老数据）或不等于 actor ⇒ false；
  //  3. course 且无任何 seq>=1 行（无课时）⇒ true（**短路**，不再查 progress）；
  //  4. 否则：progress 中 item_id ∈ {目标自身 ∪ 课程全部课时 id} 且 id != actor 的行为空 ⇒ true。
  //
  // 课时（条件 3 不适用）退化为只看条件 4。任何查询异常 ⇒ 返回 error，调用方 fail-closed 退回既有 3 票。
  // 第一参数取 sqlExec：settle 传 s.db（事务外）、vote 传 tx（事务内）——SetMaxOpenConns(1) 下两者不可互换。
  func freeRemoveEligible(e sqlExec, itemID, actor string) (bool, error) {
  	if !isCourseID(itemID) && !isLessonID(itemID) {
  		return false, nil
  	}
  	// 条件 2：创建者判定。
  	var authorID string
  	err := e.QueryRow(`SELECT author_id FROM items WHERE item_id=?`, itemID).Scan(&authorID)
  	if errors.Is(err, sql.ErrNoRows) {
  		return false, nil
  	}
  	if err != nil {
  		return false, fmt.Errorf("store: 读创建者 %s: %w", itemID, err)
  	}
  	if authorID == "" || authorID != actor {
  		return false, nil
  	}
  	targets := []string{itemID}
  	if isCourseID(itemID) {
  		lessons, err := courseLessonIDs(e, itemID)
  		if err != nil {
  			return false, err
  		}
  		// 条件 3：无课时 ⇒ true（短路跳过 progress 检查）。
  		if len(lessons) == 0 {
  			return true, nil
  		}
  		targets = append(targets, lessons...)
  	}
  	// 条件 4：无他人学习。
  	others, err := otherLearnerCount(e, targets, actor)
  	if err != nil {
  		return false, err
  	}
  	return others == 0, nil
  }

  // isCourseID 判 item_id 是否为 course/<cid>（两段）。
  func isCourseID(itemID string) bool {
  	parts := strings.Split(itemID, "/")
  	return len(parts) == 2 && parts[0] == "course" && parts[1] != ""
  }

  // isLessonID 判 item_id 是否为 course/<cid>/lesson/<lid>（四段）。
  func isLessonID(itemID string) bool {
  	parts := strings.Split(itemID, "/")
  	return len(parts) == 4 && parts[0] == "course" && parts[2] == "lesson" && parts[1] != "" && parts[3] != ""
  }

  // courseLessonIDs 读一门课程的全部课时 id（segments 中 seq>=1 行的 text，按 seq 升序）。
  func courseLessonIDs(e sqlExec, courseID string) ([]string, error) {
  	rows, err := e.Query(`SELECT text FROM segments WHERE item_id=? AND seq>=1 ORDER BY seq ASC`, courseID)
  	if err != nil {
  		return nil, fmt.Errorf("store: 读课时清单 %s: %w", courseID, err)
  	}
  	defer rows.Close()
  	var ids []string
  	for rows.Next() {
  		var id string
  		if err := rows.Scan(&id); err != nil {
  			return nil, err
  		}
  		ids = append(ids, id)
  	}
  	return ids, rows.Err()
  }

  // otherLearnerCount 统计 progress 中「item_id ∈ targets 且 id != actor」的行数。
  func otherLearnerCount(e sqlExec, targets []string, actor string) (int, error) {
  	placeholders := make([]string, len(targets))
  	args := make([]any, 0, len(targets)+1)
  	for i, id := range targets {
  		placeholders[i] = "?"
  		args = append(args, id)
  	}
  	args = append(args, actor)
  	q := `SELECT COUNT(*) FROM progress WHERE item_id IN (` + strings.Join(placeholders, ",") + `) AND id<>?`
  	var n int
  	if err := e.QueryRow(q, args...).Scan(&n); err != nil {
  		return 0, fmt.Errorf("store: 统计他人学习: %w", err)
  	}
  	return n, nil
  }
  ```

  **（b）`internal/store/govern_projection.go` `SettleGovernProposal`** —— 替换第 168-172 行：

  ```go
  	effective := filterRosterAtWatermarkSet(voters, roster, restored)
  	// 门槛按名册语境分档（册子 #58 §3.2）；remove 另加免票选旁路（本册 §5）。
  	threshold := GovernThresholdForRoster(p.Action, len(roster), rosterReady)
  	freeResult := ""
  	if p.Action == GovernActionRemove {
  		// 在 Begin 之前用 s.db 判定：单连接池下事务内再发查询会死锁。
  		// 判定异常按「不可免票选」处理（fail-closed），退回既有 3 票。
  		if free, ferr := freeRemoveEligible(s.db, p.ItemID, p.ProposerID); ferr == nil && free {
  			threshold = 0
  			freeResult = freeRemoveExecutedResult
  		}
  	}
  	if len(effective) < threshold {
  		return nil // 未达门槛
  	}
  ```

  并把第 199-207 行的应用与记 `executed_at` 改为：

  ```go
  	result, err := governApplyTx(tx, s, cur)
  	if err != nil {
  		return err
  	}
  	if freeResult != "" {
  		result = freeResult // 免票选删除：executed_result 记 'free_remove'（仅诊断，不影响读路径）
  	}
  	if _, err := tx.Exec(`UPDATE govern_proposals SET executed_at=?,executed_result=? WHERE proposal_id=?`,
  		now, result, proposalID); err != nil {
  		return fmt.Errorf("store: 记 executed_at: %w", err)
  	}
  	return tx.Commit()
  ```

  **（c）`internal/store/govern.go` `addVoteTx`** —— 替换第 488-493 行的 `out` 构造并追加旁路：

  ```go
  	out := VoteResult{
  		ProposalID: proposalID,
  		VoteCount:  len(filterRoster(voters, roster)),
  		// HTTP 投票路径的名册由 handler 派生；派生失败按空名册参与（rosterReady 恒 true，不因空名册而豁免）。
  		Threshold: GovernThresholdForRoster(p.Action, len(roster), true),
  	}
  	// 免票选删除（本册 §5）：remove 提案若可免票选，门槛降为 0 并立即生效。
  	// 用 **tx** 判定（本函数已在事务内，走 exec 版本查询符合 SetMaxOpenConns(1)）；异常 fail-closed 退回 3 票。
  	freeResult := ""
  	if p.Action == GovernActionRemove {
  		if free, ferr := freeRemoveEligible(tx, p.ItemID, p.ProposerID); ferr == nil && free {
  			out.Threshold = 0
  			freeResult = freeRemoveExecutedResult
  		}
  	}
  ```

  并把第 517-526 行的应用与记 `executed_at` 改为：

  ```go
  	result, err := governApplyTx(tx, st, p)
  	if err != nil {
  		return VoteResult{}, err
  	}
  	if freeResult != "" {
  		result = freeResult // 免票选删除：executed_result 记 'free_remove'（仅诊断）
  	}
  	if _, err := tx.Exec(`UPDATE govern_proposals SET executed_at=?,executed_result=? WHERE proposal_id=?`,
  		now, result, proposalID); err != nil {
  		return VoteResult{}, fmt.Errorf("store: 记 executed_at: %w", err)
  	}
  	out.Status = GovernStatusEffective
  	return out, nil
  ```

- [ ] **Step 4: 跑测试确认通过** ——

  ```
  $env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go test ./internal/store/ ; go build ./...
  ```

  判据：`internal/store` 全绿（含 `TestFreeRemoveEligible` / `TestFreeRemoveSettlesImmediately` / `TestFreeRemoveNotAppliedWhenOthersLearned` 与既有治理用例）；`go build ./...` 通过。

- [ ] **Step 5: 提交** ——

  ```
  git add internal/store/free_remove.go internal/store/free_remove_test.go internal/store/govern.go internal/store/govern_projection.go
  git commit -m "feat(store): 免票选删除判据 freeRemoveEligible 接入 settle/vote（#60 §5/AC5/AC6）"
  ```

---

### Task 7: 课程详情页「删除本课程」入口

**Files:** Modify `apps/mobile/src/pages/course/detail.vue`

- [ ] **Step 1: 模板加入口** —— 在 `apps/mobile/src/pages/course/detail.vue` 第 18 行「编辑本课程」之后插入一行：

  ```html
          <text v-if="canEdit" class="act danger" @click="removeCourse">{{ busy ? '删除中…' : '删除本课程' }}</text>
  ```

- [ ] **Step 2: 脚本接 `createProposal`** —— 第 54 行 `import { bootstrap } from '../../platform';` 之前追加 import：

  ```ts
  import { createProposal, GovernError, listProposals } from '../../core/govern';
  ```

  在第 79 行 `const loaded = ref(false);` 之后追加 `busy`：

  ```ts
  const busy = ref(false);
  ```

  在 `openEdit()`（第 261-263 行）之后追加删除函数：

  ```ts
  /**
   * 创建者删除本课程（本册 §5）：复用既有 `remove` 提案通道。
   * 节点侧若判为「无课时 / 无他人学习」，门槛降 0、立即 effective；否则回落到 3 票。
   */
  async function removeCourse() {
    if (busy.value) return;
    busy.value = true;
    error.value = '';
    try {
      const { opts, repo } = await bootstrap();
      const { proposalId } = await createProposal(
        { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl },
        { action: 'remove', itemId: courseId.value, reason: '创建者删除' },
      );
      const fresh = (await listProposals({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl })).find(
        (p) => p.proposalId === proposalId,
      );
      uni.showToast({ title: fresh?.status === 'effective' ? '已删除' : '已提交，需 3 票', icon: 'none' });
      setTimeout(() => uni.navigateBack(), 600);
    } catch (e) {
      error.value = e instanceof GovernError ? e.message : (e as Error).message;
    } finally {
      busy.value = false;
    }
  }
  ```

- [ ] **Step 3: 样式** —— 在 `<style>` 的 `.act`（第 310 行）之后追加：

  ```css
  .act.danger { color: #c53030; }
  ```

- [ ] **Step 4: 构建与模板硬检查** —— 在 `e:\code\base\apps\mobile` 下执行：

  ```
  npx tsc --noEmit ; npm run build:h5
  ```

  判据：`tsc` 无输出、退出码 0；`build:h5` 输出含 `Build complete.`。再执行：

  ```
  Get-ChildItem apps/mobile/src/pages -Recurse -Filter *.vue | Select-String -Pattern '="[^"]*\.value|\{\{[^}]*\.value'
  ```

  判据：**无输出**（`<template>` 内绝不写 `.value`）。

- [ ] **Step 5: 提交** ——

  ```
  git add apps/mobile/src/pages/course/detail.vue
  git commit -m "feat(mobile): 课程详情页新增创建者删除入口（#60 §5/AC5）"
  ```

---

### Task 8: 线上 nginx `client_max_body_size` 抬到 12m

**Files:** 无仓库文件（纯线上操作，**不产生 commit**；证据登记到文末「执行实况」）

> **AC 2 口径更正（册子原文不实）：** `authmw.go` 步骤 1（缺头 → 400 `auth_missing_header`）**先于**步骤 6 的体上限（413 `auth_body_too_large`），且 `POST /v1/blob` 的 `maxBody = 8 MiB + 4 KiB`。故 **9 MiB 请求在无合法签名头时也只会回 400 `auth_missing_header`**，不可能出现 `blob_too_large`。本 Task 的验证判据因此改为：**2 MiB 响应是 Go 的 JSON（含 `auth_missing_header`），而不再是 nginx 的 `<html>` 413 页**——这即证明 nginx 已放行 2 MiB 体。

- [ ] **Step 1: 定位 nginx server 块** ——

  ```
  ssh root@118.190.217.242 "nginx -T 2>/dev/null | grep -nE 'server_name|client_max_body_size|listen' | head -40"
  ```

  判据：输出里 `listen 80` 的 server 块**没有** `client_max_body_size` 行（走内置默认 1 MiB）。记下其配置文件路径（`nginx -T` 每段前的 `# configuration file …`）。

- [ ] **Step 2: 备份并插入指令** —— 设 `$CONF` 为上一步的配置文件绝对路径（例：`/etc/nginx/conf.d/base.conf`），执行：

  ```
  ssh root@118.190.217.242 "cp $CONF $CONF.bak-20261001"
  ssh root@118.190.217.242 "sed -i '/listen 80;/a \    client_max_body_size 12m;' $CONF"
  ```

  判据：`ssh root@118.190.217.242 "grep -n 'client_max_body_size' $CONF"` 输出含 `client_max_body_size 12m;`。

- [ ] **Step 3: 校验并 reload** ——

  ```
  ssh root@118.190.217.242 "nginx -t"
  ssh root@118.190.217.242 "systemctl reload nginx"
  ```

  判据：第二条命令输出 `configuration file … test is successful`；reload 无报错（`systemctl is-active nginx` 为 `active`）。

- [ ] **Step 4: 造 2 MiB 测体并验证放行** —— 在 Windows PowerShell 本地：

  ```
  $b = New-Object byte[] (2*1024*1024); [System.IO.File]::WriteAllBytes("$env:TEMP\2m.bin", $b)
  curl.exe -s -o "$env:TEMP\blob2m.txt" -w "%{http_code}`n" -X POST --data-binary "@$env:TEMP\2m.bin" http://118.190.217.242/v1/blob
  Get-Content "$env:TEMP\blob2m.txt" -Raw
  ```

  判据：状态码为 **`400`**，响应体是 **Go 的 JSON**（含 `auth_missing_header`），**不是** `413` + `<html>`。
  （若仍见 `413` 且体为 `<html>`，说明 nginx 未生效：回到 Step 1 确认改的是 `:80` 那个 server 块，且 `reload` 已执行。）

- [ ] **Step 5: 反向对照（可选，确认改前是 nginx 拦）** —— 无需提交，仅在报告中登记观察。本 Task 无 `git add`。

---

### Task 9: 线上测试数据清理

**Files:** 无仓库文件（不可逆生产写操作，**不产生 commit**；证据登记到文末「执行实况」）

> **口径：先取证后删除，全程可回溯；禁用任何前缀 / 模糊批量删除。** 锚点 = 四个**精确标题** `复现用课程` / `复现E` / `复现F` / `复现J全属性`。**注意：`schema.go` 全表清单里没有 `submissions` 表**（册子 §6 所列该名不存在），实际涉及表为 `identities` / `items` / `segments` / `progress` / `blobs`。

- [ ] **Step 1: 定位线上库文件路径** ——

  ```
  ssh root@118.190.217.242 "systemctl cat base | grep -E 'ExecStart|WorkingDirectory|Environment' ; systemctl cat base-cache | grep -E 'ExecStart|WorkingDirectory|Environment'"
  ```

  判据：两条 `ExecStart` 指向同一 `/opt/base/based`；从 `Environment=` / 工作目录推出数据目录（含 `base.db`）。记 `$DB` = 库文件绝对路径（例：`/opt/base-cache/data/base.db`）。**只清源节点一处**（缓存节点由源节点重建）。

- [ ] **Step 2: 确认 `sqlite3` 可用并备份整库** ——

  ```
  ssh root@118.190.217.242 "which sqlite3 ; ls -l $DB $DB-wal $DB-shm 2>/dev/null"
  ssh root@118.190.217.242 "cp -a $DB /tmp/base-backup-20261001.db ; ls -l /tmp/base-backup-20261001.db"
  ```

  判据：`which sqlite3` 有路径；备份文件大小与 `$DB` 一致。**备份留在 `/tmp`，用户确认前不删。**

- [ ] **Step 3: 取证（dry-run，先看命中行）** ——

  ```
  ssh root@118.190.217.242 "sqlite3 $DB \"SELECT item_id,type,title,author_id,state FROM items WHERE title IN ('复现用课程','复现E','复现F','复现J全属性');\""
  ```

  判据：列出 4 门测试课程（标题与 §6 一致）；同时记下其 `author_id` 集合（下一步用于身份清理）。若为空，**停止并报告**。

- [ ] **Step 4: 事务内精确删除**（子查询锚定标题，无需手抄 id）——

  ```
  ssh root@118.190.217.242 "sqlite3 $DB \"BEGIN; DELETE FROM segments WHERE item_id IN (SELECT item_id FROM items WHERE title IN ('复现用课程','复现E','复现F','复现J全属性')); DELETE FROM progress WHERE item_id IN (SELECT item_id FROM items WHERE title IN ('复现用课程','复现E','复现F','复现J全属性')); DELETE FROM blobs WHERE item_id IN (SELECT item_id FROM items WHERE title IN ('复现用课程','复现E','复现F','复现J全属性')); DELETE FROM identities WHERE id IN (SELECT author_id FROM items WHERE title IN ('复现用课程','复现E','复现F','复现J全属性') AND author_id<>''); DELETE FROM items WHERE title IN ('复现用课程','复现E','复现F','复现J全属性'); COMMIT;\""
  ```

  判据：命令无报错。**顺序固定**：`segments`/`progress`/`blobs` 先于 `items`，`identities` 必须先于 `items`（否则拿不到 `author_id`）。

- [ ] **Step 5: 删后核对** ——

  ```
  ssh root@118.190.217.242 "sqlite3 $DB \"SELECT COUNT(*) FROM items WHERE title IN ('复现用课程','复现E','复现F','复现J全属性');\""
  curl.exe -s -o NUL -w "%{http_code}`n" http://118.190.217.242/v1/release
  curl.exe -s http://118.190.217.242/v1/directory | Select-Object -First 1
  ```

  判据：`COUNT` 为 `0`；`GET /v1/release` 返回 `200`；`GET /v1/directory` 返回 `200` 且 JSON 正常（正式词条目录不受影响）。若任一异常，停止并报告。

---

### Task 10: 核实编辑课程 400 的越界行

**Files:** 无仓库文件（核实，**不产生 commit**；结论登记到文末「执行实况」）

> 本 Task 是册子 §4「待坐实的一步」：拿线上 `segments` 直接看有没有「已存在清单行 kind 不在容器词表内」。**即使查出数据问题，Task 3 的预检也已让用户能看到是哪一行、自行移除即可保存**；数据修复需用户确认后再定。

- [ ] **Step 1: 查课程里非 `lesson` 的子项行** ——

  ```
  ssh root@118.190.217.242 "sqlite3 $DB \"SELECT s.item_id, s.seq, s.kind, s.text FROM segments s JOIN items i ON i.item_id=s.item_id WHERE i.type='course' AND s.seq>=1 AND s.kind<>'lesson' ORDER BY s.item_id, s.seq;\""
  ```

  判据：输出课程容器里 kind 非 `lesson` 的清单行（若为空则问题不在课程层）。

- [ ] **Step 2: 查课时里非法 kind 的子项行** ——

  ```
  ssh root@118.190.217.242 "sqlite3 $DB \"SELECT s.item_id, s.seq, s.kind, s.text FROM segments s JOIN items i ON i.item_id=s.item_id WHERE i.type='lesson' AND s.seq>=1 AND s.kind NOT IN ('article','video','audio','quiz') ORDER BY s.item_id, s.seq;\""
  ```

  判据：输出课时容器里越界的清单行（录下 `item_id` 与 `kind`）。这就是用户那门课保存时被节点判 `item_segments_invalid` 的具体行。

- [ ] **Step 3: 判断来源并登记结论** —— 依据上两步的 `item_id`（`course/<hex>` 为 App 建课 / 含导入特征为导入器产出）与用户提供的课程 id 对照，在文末「执行实况」写明：命中的 `item_id`、越界的 `kind`、判定结论（导入课程 / App 历史课程）、是否需数据修复。**不在此 Task 直接改数据。**

- [ ] **Step 4: （条件执行）若用户确认需修复** —— 由用户给出确切 `item_id` 与目标动作（改 kind 还是删该行）后，按同 Task 9 的「备份 → 事务内精确改 → 核对」口径执行；本计划不预置具体 SQL，避免误伤。

---

### Task 11: 门禁、版本、文档与发布收口

**Files:** Modify `apps/mobile/src/manifest.json`；Modify `docs/README.md`；Modify `docs/superpowers/plans/2026-10-01-base-submit-fix-and-free-delete-plan.md`（执行实况回填）

- [ ] **Step 1: Go 门禁三件套** ——

  ```
  $env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go build ./... ; go vet ./... ; go test ./...
  ```

  判据：三者全绿（`go test ./...` 无 FAIL）。

- [ ] **Step 2: 手机端三连** —— 在 `e:\code\base\apps\mobile` 下：

  ```
  npx vitest run ; npx tsc --noEmit ; npm run build:h5
  ```

  判据：`vitest` 全绿（含新增 `errors.test.ts` / `uni.test.ts`，并已改 `govern.test.ts` / `selfcheck.test.ts` / `course-edit.test.ts`）；`tsc` 无输出；`build:h5` 输出 `Build complete.`。

- [ ] **Step 3: 版本号** —— `apps/mobile/src/manifest.json`：`versionName` `"0.19.0"` → `"0.20.0"`（`:5`），`versionCode` `"24"` → `"25"`（`:6`）。（若执行时此处仍为 `0.18.0`/`23`，说明 `#59` 未合入，**先停并报告**。）

- [ ] **Step 4: 交叉编译部署（节点侧有改动 ⇒ 必做）** —— 在仓库根：

  ```
  $env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; $env:GOOS='linux'; $env:GOARCH='amd64'; go build -o based-linux-amd64 ./cmd/based
  scp based-linux-amd64 root@118.190.217.242:/opt/base/based
  ssh root@118.190.217.242 "systemctl restart base base-cache ; sleep 2 ; systemctl is-active base base-cache"
  ssh root@118.190.217.242 "curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8083/healthz"
  ```

  判据：两单元 `active`；`healthz` 返回 `200`。（`based` 命令路径以仓库实际 `cmd/` 目录为准；若二进制名或端口与此不同，按线上 `systemctl cat base` 的 `ExecStart` 对齐。）

- [ ] **Step 5: 四步发布** —— ① HBuilderX 云打包 APK；② 上传到 `/opt/appdl/base-0.20.0.apk`；③ 落地页**整页重写**改指 `base-0.20.0.apk`；④ 服务器 `based release` 签发落 `/opt/base-cache/data/release.json`。

- [ ] **Step 6: 线上核对** ——

  ```
  curl.exe -s http://118.190.217.242/v1/release
  curl.exe -s -I http://118.190.217.242/dl/base-0.20.0.apk
  ```

  判据：`GET /v1/release` 的 `version_name` 为 `0.20.0`、`url` 指向 `base-0.20.0.apk`；`HEAD` 返回 `200`。

- [ ] **Step 7: 文档收口** —— `docs/README.md` 文档清单表末（`#59` 行之后）追加一行：

  ```
  | #60 | plans/2026-10-01-base-submit-fix-and-free-delete-plan.md | 基座投稿修复（治理事件签名头 / 错误码映射 / 行集预检 / 选文件探针 / file:// 路径）与免票选删除 | 不新增删除端点、不改既有门槛常量 | #27、#33、#40、#56、#58 | 已上线 |
  ```

  并在本文末「执行实况」节回填：实际改动文件清单、`git diff --stat`、门禁跑分、Task 8/9/10 的线上证据与结论、四步发布与核对结果、真机验收状态。

- [ ] **Step 8: 提交** ——

  ```
  git add apps/mobile/src/manifest.json docs/README.md docs/superpowers/plans/2026-10-01-base-submit-fix-and-free-delete-plan.md
  git commit -m "chore(mobile): 版本落 0.20.0 / 25 并登记 #60 计划（#60 §8）"
  ```

---

## 计划代码照抄会挂的地方（执行前必读）

1. **`SetMaxOpenConns(1)`** → `freeRemoveEligible` 在 **settle 用 `s.db`（必须在 `tx, _ := s.db.Begin()` 之前）**、在 **vote 用 `tx`**；事务内改调 `s.db` 或事务外改调 `tx` 都会死锁 / 拿不到连接。
2. **`govern.test.ts:104-106` 必改** → 修好签名头后，断言「事件头只有 `Content-Type`」必然失败；不连带改它，Task 1 无法通过。
3. **`selfcheck.test.ts:221-229` 必改** → 分支化后 `{chooseFile}` + 有 plus ⇒ 探针 `'chooseFile'` ⇒ 两项都 `ok`；旧断言「缺 chooseImage 即 fail」不再成立。
4. **`writeLedger` 私有** → `course-edit.ts` 必须自带 `writeFailedLedger`，**不要**去导出 `submit.ts` 的 `writeLedger`（会牵动 `submit.ts` 的可见性）。
5. **`pickLocalFile` 的 `'none'` 分支** → 若改成返回 `null`，会吞掉原有「当前运行时不支持选择文件」的可读错误；保持走 `pickByChooseFile`。
6. **`dirEntry` 必须对 `file://` 整串解析** → `'file:///a/b'.split('/')` 会切出 `'file:'` 段；只改 `toPlusUrl` 不改 `dirEntry` 会在 `file://` 路径上仍失败。
7. **AC 2 口径不实** → 无合法签名头时 `authmw` 步骤 1（400 `auth_missing_header`）先于步骤 6（413 `auth_body_too_large`），**9 MiB 拿不到 `blob_too_large`**；验证只以「2 MiB 回 Go 的 JSON 而非 nginx html」为放行证据（见 Task 8）。
8. **册子 §6 的 `submissions` 表不存在** → 线上清理按实际表名（`identities`/`items`/`segments`/`progress`/`blobs`）操作，锚点用四个精确标题。
9. **免票选短路风险** → 条件下「无课时 ⇒ true」会**短路跳过** progress 检查；故「有他人学习」的测试用例必须给课程挂 ≥1 个课时 + 一条他人 progress，否则会被误判为 true。
10. **`freeRemoveEligible` 判定异常的处置 = 不降门槛**（fail-closed）→ 两处调用都写成 `if free, ferr := …; ferr == nil && free { … }`，**不要** `return err`（那会让 settle/vote 直接失败）。
11. **`executed_result` 覆盖点在两处 UPDATE 之前** → 漏改任一处，`free_remove` 不会落库（`retireItemExec` 仍返回 `"removed"`）。
12. **`docs/README.md` 表列是 6 列**（`# / path / 描述 / 不做 / 依赖 / 状态`）→ 追加行必须 6 列对齐，否则门户文档解析错位。

---

## 真机验收（登记不阻塞）

- 提交一个讲师 / 分类词条 → 不再 400；对端可投票（AC 1）。
- App 端基座自检 `pick.*` 两项按探针为 `ok`；课程编辑页可成功选封面与附件（AC 3）。
- 编辑一门含非法子项的课程 → 保存时提示**指名到行**；移除该行后可提交成功（AC 4）。
- 线上删一门自建空课程 → toast「已删除」（effective）；删一门有他人学习的课程 → toast「已提交，需 3 票」（AC 5/AC 6）。
- 2 MiB 图片 / 附件可上传（AC 2）。
- 测试课程在线上查不到；正式课程、`GET /v1/directory`、`GET /v1/release` 均正常（AC 7）。

## 执行实况（执行后回填）

**状态：待执行。** 执行者按 Task 1 → 11 顺序落地，每个 Task 结束以其 `git add` 列表提交一次（Task 8/9/10 无仓库改动、不提交），并在本节回填：

- 提交序列表（Task → commit hash → 说明）。
- `git diff --stat`（基线 → 交付 HEAD）。
- 门禁跑分：`go test ./...` 与 `npx vitest run` 的文件 / 用例数。
- Task 8 线上证据：nginx `client_max_body_size 12m;` 落位 + 2 MiB `curl` 的 `400 auth_missing_header`（非 nginx html）。
- Task 9 清理证据：备份路径、删除前后 `COUNT`、`GET /v1/release` 与 `GET /v1/directory` 核对。
- Task 10 核实结论：越界行的 `item_id` / `kind` 与来源判定。
- 四步发布与线上核对结果、真机验收状态。
