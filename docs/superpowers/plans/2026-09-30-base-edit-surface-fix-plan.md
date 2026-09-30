# 编辑面修复（F3 诊断 + F4 载体搜索）实施计划（A 主线 第 5 册）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 App 实测 **F3**（图片 / 附件加不上）的「诊断三件套 + 预置双分支」——能力探测进自检标志体系、三段失败出人读文案并落本地日志、`pickLocalFile()` 运行时在「App 相册 / 拍照」与「H5 `chooseFile`」两支间切换；落地 **F4**（添加载体）为「本机已下载条目候选 + 关键词搜索 + kind 过滤 + 点选回填」，**零新 HTTP 接口**。**本册不写 F3 根因**（待真机复测）。

**Architecture:** 只动 `apps/mobile`。新增窄接口 `pickHandle()`（`platform/uni.ts`）与日志出口 `core/editlog.ts`；`core/selfcheck.ts` 增两条 `pick.*` 探测项与新标志 `pickOk`（**只加不改**既有四标志语义）；`pickLocalFile()` 改运行时双分支但对外契约（`PickedFile | null`）不变；新增纯函数 `core/carrier-pick.ts` 提供候选查询。两页编辑面只消费 `LocalRepo` 与既有 `POST /v1/blob` / `POST /v1/submit`。**零新表、零新路由、零内容包变更。**

**Tech Stack:** TypeScript + Vue 3 + uni-app（`apps/mobile`）／ vitest ／ `core/fakes.ts`（Node 下假适配器）／ Vue SFC（`<template>` 禁 `.value` 写法）。

**上游 spec:** `docs/superpowers/specs/2026-09-30-base-edit-surface-fix-design.md`（#46）；批次编排 `docs/superpowers/plans/2026-09-30-base-batch-f3-f9-plan.md`（#45）；槽位与 kind 口径 `docs/superpowers/specs/2026-09-30-base-course-lesson-edit-design.md`（#40）。

---

## 开工前已核实的现状（执行时直接用，不要重新调研）

| 事实 | 位置 |
| --- | --- |
| `UniGlobal.chooseFile?` 是**可选声明**（注释「App 端 3.4.0+ 提供」） | `apps/mobile/src/platform/uni.ts:88-96` |
| `uniGlobal()` 取全局 `uni`（缺失抛「uni 运行时不可用」）；`plusRuntime()` 取 `globalThis.plus`；`assertAppRuntime()` 在 H5 抛可读提示 | `apps/mobile/src/platform/uni.ts:110-132` |
| `PickedFile { name; bytes }`；`pickLocalFile()`：无 `chooseFile` ⇒ 抛「当前运行时不支持选择文件」；`fail` 含 `cancel` ⇒ `null`；读字节走 `PlusFs.readFile` | `apps/mobile/src/platform/uni.ts:446-483` |
| `toPlusUrl` 只认 `_doc` 前缀，其余原样传 `resolveLocalFileSystemURL` | `apps/mobile/src/platform/uni.ts:264-268` |
| `BlobError.code ∈ client｜network｜rejected｜server`；`uploadBlob` 三条 `client` 前置（未配地址 / 空文件 / > 8 MiB） | `apps/mobile/src/core/blob.ts:20,23-31,51-91,106-111` |
| `CapabilityFlags { cryptoOk, fsOk, dbOk, writeOk }` / `UNKNOWN_FLAGS` / `FLAG_KEYS`；`canSync` / `canPostComment` 写法 | `apps/mobile/src/core/selfcheck.ts:17-32,53-67` |
| `PROBES` 12 条；`standalone` 项只收 `plus` 句柄（范例 `net.open_url`）；`flags` 聚合：任一条 fail ⇒ fail、全 skip ⇒ unknown | `apps/mobile/src/core/selfcheck.ts:119-342,311-321,409-423` |
| `bootstrap()` 冷启动只定 `cryptoOk`，其余保持 `unknown`；`applySelfCheck(report)` 回写 `cached.capabilities` | `apps/mobile/src/platform/index.ts:21-68` |
| `LocalRepo` 接口（`getItem` / `listItems` / `listSegments` / `saveSubmission` / `listSubmissions` …） | `apps/mobile/src/core/repo.ts:17-97` |
| `ItemRow { itemId, source, type, title, rev, contentHash, state, updatedAt }`（`state`: `active｜removed`）；`SegmentRow` | `apps/mobile/src/core/types.ts:1-11,52-58` |
| `AttachmentRow` / `ChildRow { kind; itemId }` / `ContainerForm` / `buildContainerSegments` / `loadContainerForm` | `apps/mobile/src/core/course-edit.ts:35-45,48-66,99-114,117-132` |
| `attrsOf`（`seq<0` 属性行）/ `childrenRowsOf`（`seq>=1` 升序） | `apps/mobile/src/core/container-view.ts:47-79,88-93` |
| 课程编辑页：`uploadOne` / `pickCover` / `addAttachment`（失败只写 `error.value`，**无落盘日志**）`:127-159`；封面 UI `:17-22`；附件 UI `:47-55`；课时清单 `:57-73`；`addLesson` 生成新 id 并跳转 `:166-177`；`error` 区 `:75-77` | `apps/mobile/src/pages/course/edit.vue` |
| 课时编辑页：`uploadOne` / `pickCover` / `addAttachment`（无日志）`:148-178`；`CARRIER_KINDS` `:110`；`addCarrier()` 只 push 空 id 行 `:184-188`；载体卡片（chips 手点 kind + input 手填）`:63-90`；空 id 拦下 `:215-219`；`error` 区 `:92-93` | `apps/mobile/src/pages/lesson/edit.vue` |
| 载体 kind：course 收 `lesson`；lesson 收 `article｜video｜audio｜quiz` | `docs/superpowers/specs/2026-09-30-base-course-lesson-edit-design.md:105-110`（`#40 §2.4`） |
| 手机端门禁：`npx vitest run`（基线 **23 文件 / 230 用例**）、`npx tsc --noEmit`、`npm run build:h5` | `apps/mobile/package.json` |
| 发布前硬检查：`apps/mobile/src/pages/*/*.vue` 不得出现 `.value` 模板写法 | `docs/README.md:100`（更正 14 ①） |

**环境与工作区：** Windows PowerShell 5.1（无 `pwsh`，不支持 `&&` 与 heredoc，提交消息写临时文件 + `git commit -F`）；工作区有未提交的 `.gitignore` 改动与未跟踪的 `based-linux-amd64`——**不要动、不要 add**，每次只 `git add` 本任务文件。

**执行禁令（`#46 §1 / §7`）：** 不改内容包规范 v1、不 bump `schema_version`、不新增 `source` / `type` 枚举值、不加配置项、**零新 HTTP 接口**、不改 `#40` 槽位语义与两条哈希口径、不做播放器与正文内嵌图片上传面、不做 iOS、**不得把 F3 根因写成「已定位」**。

---

## 文件结构

**新增**

| 文件 | 职责 |
| --- | --- |
| `apps/mobile/src/core/editlog.ts` | `recordEditFailure(fs, workDir, stage, detail)`（JSON Lines 追加写 `edit-surface.log`，64 KiB 上限、写失败静默）+ `readEditLog(fs, workDir, maxBytes)` |
| `apps/mobile/src/core/editlog.test.ts` | 落盘格式 / 截断 / 静默失败 / 读回（用 `core/fakes.ts` 假 `FsAdapter`） |
| `apps/mobile/src/core/carrier-pick.ts` | `CarrierCandidate` + `kindOfItem` + `listCarrierCandidates(repo, kinds, keyword)` |
| `apps/mobile/src/core/carrier-pick.test.ts` | kind 过滤 / 关键词 / active 过滤 / 排序 / 空关键词 / 标题回落 |

**修改**

| 文件 | 职责 |
| --- | --- |
| `apps/mobile/src/core/selfcheck.ts` | `pick.*` 两条 standalone 探测 + `pickOk` 标志 + `canPickFile` / `pickBlockedReason` + `SelfCheckOptions.pick` 旁路 |
| `apps/mobile/src/core/selfcheck.test.ts` | 新探测三态聚合与判据单测（**只增不减**既有用例） |
| `apps/mobile/src/platform/uni.ts` | 导出 `PickHandle` / `pickHandle()`；`pickLocalFile()` 改运行时双分支 |
| `apps/mobile/src/platform/index.ts` | `bootstrap()` 冷启动一并判定 `pickOk` |
| `apps/mobile/src/pages/selfcheck/selfcheck.vue` | 新增只读「编辑面日志」展示块（尾部 ≤ 4 KiB） |
| `apps/mobile/src/pages/course/edit.vue` | F3 文案 + 日志 + `pickOk` 门禁；F4「选已有课时」（kind=`lesson`） |
| `apps/mobile/src/pages/lesson/edit.vue` | F3 文案 + 日志 + `pickOk` 门禁；F4 载体搜索 + 点选 + 只读标题 |
| `docs/superpowers/specs/2026-09-30-base-course-lesson-edit-design.md` | `#40 §6` 补指向（Task 9） |

---

### Task 1: 编辑面日志出口 `core/editlog.ts`

**Files:** Create `apps/mobile/src/core/editlog.ts`；Create `apps/mobile/src/core/editlog.test.ts`

- [ ] **Step 1: 写失败的测试** —— 先读 `apps/mobile/src/core/fakes.ts` 确认真 `FsAdapter` 假实现的确切形态，据此写用例：① 首次写入即在 `${workDir}/edit-surface.log` 产生**一行 JSON Lines**（字段 `at` / `stage` / `detail`）；② 两次失败**追加**不覆盖（两行）；③ 写入 80 条长记录后文件 **≤ 64 KiB** 且**最新行仍在**；④ 写失败时 `recordEditFailure` **resolve 而非 reject**；⑤ `readEditLog` 文件不存在回 `''`、超长只回尾部 `maxBytes`。
- [ ] **Step 2: 跑测试确认失败** —— `cd apps/mobile; npx vitest run src/core/editlog.test.ts`。判据：报「找不到模块 `./editlog`」。
- [ ] **Step 3: 写实现** —— 只依赖注入的 `FsAdapter`（type-only import），不 import `'uni'`。导出 `EDIT_LOG_NAME = 'edit-surface.log'`、`EDIT_LOG_MAX_BYTES = 64 * 1024`、`type EditStage = 'pick' | 'read' | 'upload'`；`recordEditFailure(fs, workDir, stage, detail): Promise<void>` = 「读旧（不存在 / 读失败当空串）→ 拼 `JSON.stringify({at: new Date().toISOString(), stage, detail})` → 超上限从头部截断 → 回退到最近一个换行（避免半行 JSON）→ `fs.writeFile`」，**整段包 `try {} catch {}` 静默**；`readEditLog(fs, workDir, maxBytes)` 返回 `all.length <= maxBytes ? all : all.slice(all.length - maxBytes)`。
- [ ] **Step 4: 跑测试确认通过** —— `cd apps/mobile; npx vitest run src/core/editlog.test.ts; npx tsc --noEmit`。判据：本文件全绿、`tsc` 干净。

> 若既有 fakes 不支持「写失败」的构造，按 fakes 实际能力调整用例（如注入 `writeFile` 恒抛的匿名对象），**不要改 fakes 既有语义**。

---

### Task 2: 能力探测项与 `pickOk` 标志

**Files:** Modify `apps/mobile/src/core/selfcheck.ts`；Modify `apps/mobile/src/core/selfcheck.test.ts`

- [ ] **Step 1: 写失败的测试** —— 在 `selfcheck.test.ts` **追加**（不改既有用例）：① `canPickFile(UNKNOWN_FLAGS)` = true、`pickOk:'ok'` = true、`pickOk:'fail'` = false；② `pickBlockedReason` 在 `fail` 时**含「选择」**、非 fail 时 `''`；③ `runSelfCheck(null, { plus: FAKE_PLUS, pick: { chooseFile: () => {} } })` 的两条 `pick.*` 都在 `items` 里且 `flags.pickOk === 'fail'`（album 缺失 ⇒ 任一条 fail 即 fail）；④ `pick: {}` ⇒ `fail`；`pick: { chooseFile, chooseImage }` ⇒ `ok`。
- [ ] **Step 2: 跑测试确认失败** —— `cd apps/mobile; npx vitest run src/core/selfcheck.test.ts`。判据：`canPickFile` 不存在 / `flags.pickOk` 为 `undefined`。
- [ ] **Step 3: 改实现** —— 1. `CapabilityFlags` 增 `pickOk: Capability`；`UNKNOWN_FLAGS` 增 `pickOk: 'unknown'`；`FLAG_KEYS` 末尾加 `'pickOk'`（聚合逻辑 `:409-423` 零改动）。2. `PickHandle { chooseFile?: unknown; chooseImage?: unknown }` **从 `platform/uni` import 复用**（不重复定义）；`SelfCheckOptions` 增 `pick?: PickHandle`；`runSelfCheck` 内 `const pick = o.pick ?? pickHandle();`。3. `PROBES` 末尾追加两条 `standalone`：`pick.choose_file`（group「文件选择」、affects「选图片 / 附件」、flag `pickOk`、`typeof pick?.chooseFile !== 'function'` ⇒ 抛「uni.chooseFile 不存在（App 端为可选 API）」）、`pick.album`（同理判 `chooseImage`、affects「选图片 / 附件（App 支）」）；把 `Probe` 的 `run` 签名从收 `plus` 扩为收 `(plus, pick)`，**其余 12 条按新签名补一个未使用参数**（改动最小）。4. 新增 `canPickFile(flags)`（`pickOk !== 'fail'`）与 `pickBlockedReason(flags)`（fail ⇒「当前环境不支持选择文件，无法设置封面 / 附件（设置 → 基座自检 可看原因）」，否则 `''`），形态照抄 `canSync` / `postBlockedReason`。
- [ ] **Step 4: 跑测试确认通过** —— `cd apps/mobile; npx vitest run src/core/selfcheck.test.ts; npx tsc --noEmit`。判据：既有 12 条探测用例**仍全绿**、新增用例全绿。

---

### Task 3: `pickHandle()` 与 `pickLocalFile()` 运行时双分支

**Files:** Modify `apps/mobile/src/platform/uni.ts`；Modify `apps/mobile/src/platform/index.ts`

- [ ] **Step 1: 加 `pickHandle()`** —— 在 `uni.ts` 的 `uniGlobal()` 之后导出 `interface PickHandle { chooseFile?: unknown; chooseImage?: unknown }` 与 `pickHandle(): PickHandle`（`const u = g().uni as PickHandle | undefined; return u ?? {};`）——`uni` 缺失时**返回空对象**（探测项据此判 fail，而不是抛错）。随后把 Task 2 里 `selfcheck.ts` 的 `PickHandle` 改为从本文件 import。
- [ ] **Step 2: 改 `pickLocalFile()` 为双分支** —— 1. `UniGlobal` 补可选声明 `chooseImage?(o: { count: number; sourceType: string[]; success: (res: { tempFilePaths?: string[] }) => void; fail: (e: unknown) => void }): void`。2. `pickLocalFile()` 改为：`const uni = uniGlobal(); const app = plusRuntime() !== undefined && typeof uni.chooseImage === 'function'; const hit = app ? await pickByAlbum(uni) : await pickByChooseFile(uni); if (hit === null) return null; return { name: hit.name, bytes: await new PlusFs(assertAppRuntime()).readFile(hit.path) };`。3. 新增两个私有 helper（各返回 `Promise<{ path: string; name: string } | null>`）：`pickByAlbum` 调 `uni.chooseImage({ count: 1, sourceType: ['album','camera'] })`、取 `tempFilePaths[0]`、空路径 ⇒ `null`、`fail` 含 `cancel` ⇒ `null`、否则抛 `new Error('选择文件失败：' + JSON.stringify(e))`；`pickByChooseFile` **保持现状逻辑**（`:457-483`）。**对外契约不变**（取消 → `null`；非取消错误 → 抛 `Error`；成功 → `PickedFile`），页面 `uploadOne`（`course/edit.vue:127-138` / `lesson/edit.vue:148-158`）**不改**。
- [ ] **Step 3: `bootstrap()` 冷启动一并判定 `pickOk`** —— 在 `platform/index.ts` 的 `cryptoOk` 判定之后追加（同步 `typeof`，零 IO）：`const pick = pickHandle(); capabilities.pickOk = (typeof pick.chooseFile === 'function' || typeof pick.chooseImage === 'function') ? 'ok' : 'fail';`（`pickHandle` 一并从 `./uni` import）。
- [ ] **Step 4: 门禁** —— `cd apps/mobile; npx tsc --noEmit; npx vitest run; npm run build:h5`。判据：`tsc` 干净、全量 **≥ 23 文件 / 230 用例**全绿、`build:h5` 通过。

---

### Task 4: 课程编辑页 F3（错误可见 + 日志 + 门禁）

**Files:** Modify `apps/mobile/src/pages/course/edit.vue`

- [ ] **Step 1: 接日志与门禁** —— `<script setup>` 内：import `recordEditFailure`（`core/editlog`）、`canPickFile` / `pickBlockedReason` / `UNKNOWN_FLAGS`（`core/selfcheck`）；新增 `caps = ref<CapabilityFlags>(UNKNOWN_FLAGS)`；`onLoad` 里 `bootstrap()` 后取 `capabilities` 刷新 `caps.value`；新增计算属性 `pickBlocked = computed(() => pickBlockedReason(caps.value))` 与 `canPick = computed(() => canPickFile(caps.value))`；新增 `logFail(stage, e)` = `await recordEditFailure(opts.adapters.fs, opts.opts.workDir, stage, String((e as Error).message ?? e))`。
- [ ] **Step 2: 三段失败改为「文案 + 日志」** —— `pickCover` / `addAttachment`（`:140-159`）的 `catch` 在写 `error.value` 之外调 `logFail('pick', e)`；`uploadOne`（`:127-138`）内 `uploadBlob` 失败用 `logFail('upload', e)`、`pickLocalFile()` 抛错用 `logFail('pick', e)`。**取消（返回 `null`）时两条日志都不写**（`#46 §2.2`）。
- [ ] **Step 3: 模板门禁** —— 封面 UI（`:17-22`）与附件 UI（`:47-55`）的 `@click` 各自挂守卫：`if (!canPick.value) { error.value = pickBlocked.value; return; }`；`error` 区下方补 `<text v-if="pickBlocked" class="hint">{{ pickBlocked }}</text>`。**模板不得出现 `.value` 写法**（计算属性自动解包）。
- [ ] **Step 4: 门禁 + 硬检查** —— `cd apps/mobile; npx tsc --noEmit; npx vitest run; grep -nE '="[^"]*\.value|\{\{[^}]*\.value' src/pages/course/edit.vue`。判据：`tsc` 干净、用例全绿、`grep` 无输出。

---

### Task 5: 课时编辑页 F3（同 Task 4 逐条同构）

**Files:** Modify `apps/mobile/src/pages/lesson/edit.vue`

- [ ] **Step 1: 同 Task 4 的 Step 1–3** —— 落点：`uploadOne` / `pickCover` / `addAttachment`（`:148-178`）、封面 UI（`:23-29`）、附件 UI（`:54-61`）、`error` 区（`:92-93`）；同一份 `logFail` / `canPick` / `pickBlocked` 写法，日志 `stage` 取值同为 `pick` / `read` / `upload`。
- [ ] **Step 2: 门禁 + 硬检查** —— `cd apps/mobile; npx tsc --noEmit; npx vitest run; grep -nE '="[^"]*\.value|\{\{[^}]*\.value' src/pages/lesson/edit.vue`。判据：`tsc` 干净、用例全绿、`grep` 无输出。

---

### Task 6: 候选源纯函数 `core/carrier-pick.ts`

**Files:** Create `apps/mobile/src/core/carrier-pick.ts`；Create `apps/mobile/src/core/carrier-pick.test.ts`

- [ ] **Step 1: 写失败的测试** —— 用 `core/fakes.ts`（先读其 `LocalRepo` 假实现构造与 `listItems()` 喂法）造 5 条 `ItemRow`：`article/a1`（title「Alpha 文章」）、`article/a2`（title 空）、`quiz/q1`、`course/c1/lesson/l1`（type `lesson`）、`article/gone`（`state:'removed'`）。用例：① `listCarrierCandidates(repo, ['article','video','audio','quiz'], '')` ⇒ `['article/a1','article/a2','quiz/q1']`，`listCarrierCandidates(repo, ['lesson'], '')` ⇒ `['course/c1/lesson/l1']` 且 `kind === 'lesson'`；② 关键词 `'gone'` ⇒ `[]`（active 过滤）；③ `'ALPHA'` 命中 `article/a1`、`'q1'` 命中 `quiz/q1`（大小写不敏感、命中 itemId 或 title）；④ `article/a2` 的 `title` 回落 `itemId`；⑤ 结果按 `itemId` 升序。
- [ ] **Step 2: 跑测试确认失败** —— `cd apps/mobile; npx vitest run src/core/carrier-pick.test.ts`。判据：报「找不到模块 `./carrier-pick`」。
- [ ] **Step 3: 写实现** —— 不 import `'uni'`，只 type-import `LocalRepo` 与 `ItemRow`。导出：`interface CarrierCandidate { kind: string; itemId: string; title: string }`；`kindOfItem(item): string`（`return item.type`——course 的子项 kind 即 `lesson`、lesson 的子项即 `article|video|audio|quiz`，与 `#40 §2.1` 清单口径同形）；`listCarrierCandidates(repo, kinds, keyword)` = `listItems()` → `state === 'active'` → `kinds` 集合命中（`Set`）→ 关键词 `trim().toLowerCase()` 子串匹配 `itemId` 或 `title`（空关键词不过滤）→ 按 `itemId` 升序 → `map` 成 `{ kind: kindOfItem(i), itemId: i.itemId, title: i.title || i.itemId }`。
- [ ] **Step 4: 跑测试确认通过** —— `cd apps/mobile; npx vitest run src/core/carrier-pick.test.ts; npx tsc --noEmit`。判据：全绿、`tsc` 干净。

---

### Task 7: 课时编辑页 F4（载体搜索 + 点选 + 只读标题）

**Files:** Modify `apps/mobile/src/pages/lesson/edit.vue`

- [ ] **Step 1: 加选择器状态与查询** —— import `listCarrierCandidates` 与 `type CarrierCandidate`；新增 ref `pickOpen` / `pickKeyword` / `pickKind` / `candidates`；`onLoad` 里把 `bootstrap()` 的 `repo` 存 ref，并把 `repo.listItems()` 结果建成 `Map<itemId, title>` 缓存（供 `carrierTitle`）。新增 `refresh()`（按 `pickKind === '' ? CARRIER_KINDS : [pickKind]` 与 `pickKeyword` 调 `listCarrierCandidates`）、`openPicker()`（置 `pickOpen` 并 `await refresh()`）、`carrierTitle(itemId)`（查缓存，**查不到回落 `itemId`**）、`chooseCarrier(c)`（同 `itemId` 已在 `form.children` 中则只关面板，否则 push `{ kind: c.kind, itemId: c.itemId }` 后关面板——与附件去重同向，`course/edit.vue:154-155`）。
- [ ] **Step 2: 模板替换载体卡片** —— 改 `:63-90` section：清单行只读展示「第 N 项 · `c.kind`」+ `carrierTitle(c.itemId)`（标题）+ `itemId`（小字）+ 上移 / 下移 / 删除；「+ 添加载体」改调 `openPicker`；面板内为 `input v-model="pickKeyword" @input="refresh"`、kind chips（「全部」+ `CARRIER_KINDS`）、空态文案「本机还没有可选的条目，先同步内容包」、候选行（`title` + `kind · itemId`，点击 `chooseCarrier`）、「收起」。**模板不得出现 `.value` 写法。**
- [ ] **Step 3: 删 `addCarrier()`、保留空 id 兜底** —— 删 `:184-188` 的 `addCarrier()`；`submit()` 的「空 id 拦下」校验（`:215-219`）**保留**。
- [ ] **Step 4: 门禁 + 硬检查** —— `cd apps/mobile; npx tsc --noEmit; npx vitest run; grep -nE '="[^"]*\.value|\{\{[^}]*\.value' src/pages/lesson/edit.vue`。判据：`tsc` 干净、用例全绿、`grep` 无输出。

---

### Task 8: 课程编辑页 F4（课时清单同样支持点选）

**Files:** Modify `apps/mobile/src/pages/course/edit.vue`

- [ ] **Step 1: 保留「+ 加一课」，新增「+ 选已有课时」** —— **保留** `addLesson()`（`:166-171`，生成新 id 并跳转课时编辑页）与既有按钮；section（`:57-73`）新增「+ 选已有课时」按钮，复用 Task 7 的选择器形态（候选 = `listCarrierCandidates(repo, ['lesson'], keyword)`）；点选后 `form.children.push({ kind: 'lesson', itemId: c.itemId })`（**不跳转**，用户可再点行内进入课时编辑页）。
- [ ] **Step 2: 行内标题优先本机标题** —— `lessonTitle(itemId)`（`:179-181`）改为**优先本机条目标题、其次「（新课时，未保存）」**（`onLoad` 已建 `lessonTitles` 映射，直接用）。
- [ ] **Step 3: 门禁 + 硬检查** —— `cd apps/mobile; npx tsc --noEmit; npx vitest run; npm run build:h5; grep -nE '="[^"]*\.value|\{\{[^}]*\.value' src/pages/course/edit.vue`。判据：`tsc` 干净、用例全绿、`build:h5` 通过、`grep` 无输出。

---

### Task 9: 自检页取证入口 + `#40 §6` 指向 + 收口

**Files:** Modify `apps/mobile/src/pages/selfcheck/selfcheck.vue`；Modify `docs/superpowers/specs/2026-09-30-base-course-lesson-edit-design.md`

- [ ] **Step 1: 自检页加只读「编辑面日志」** —— `runSelfCheck` 之后（`:72` 附近）追加 `logTail.value = await readEditLog(opts.adapters.fs, opts.opts.workDir, 4096)`；模板底部新增一段 `<pre>{{ logTail }}</pre>`（只读，空态「暂无编辑面失败记录」）。**不得**把日志内容写回任何能力标志。
- [ ] **Step 2: `#40 §6` 补指向** —— 在 `#40` 的 §6「编辑面（手机端）」末尾追加一条：**选文件诊断与载体选择归 `#46`**（运行时能力探测 / 双分支（App 相册·拍照 与 H5 `chooseFile`）/ 三段失败的可读文案与本地日志 / 载体候选源（本机已下载条目 + 搜索 + 点选）由 `#46` 定义；本册不改槽位与写路径）。
- [ ] **Step 3: 门禁全跑** —— `cd apps/mobile; npx vitest run; npx tsc --noEmit; npm run build:h5`；仓库根 `go build ./...; go vet ./...; go test ./...`；再跑 `scripts/acceptance-d.ps1`。判据：Go 三连全绿（本册不动 Go，应无变化）；mobile **≥ 23 文件 / 230 用例（只增不减）**、`tsc` 干净、`build:h5` 通过；D 组 TC-D01–TC-D07 全 PASS。
- [ ] **Step 4: 发布前硬检查（不执行发布）** —— `cd apps/mobile; grep -rnE '="[^"]*\.value|\{\{[^}]*\.value' src/pages`。判据：无输出。**版本号本册不改**（`manifest.json` 仍 `0.15.0` / `20`），随 `#45` 批次统一改 `0.16.0` / `21`。
- [ ] **Step 5: 登记执行实况** —— 把 Task 1–9 的 commit hash、偏差与真机取证结论回填「执行实况」节；**不得**把 F3 根因写成「已定位」。

---

## 自检清单

- [ ] **spec 覆盖**：`#46 §2.1` → Task 2/3；`§2.2` → Task 4/5；`§2.3` → Task 1/4/5/9；`§2.4` → 真机取证（不入代码）；`§3` → Task 3；`§4.1` → Task 6；`§4.2` → Task 6/7/8；`§4.3` → Task 7/8；`§6` AC 1–9 → Task 1–9。
- [ ] **占位符扫描**：全文无 `TODO` / `FIXME` / `xxx` / `待补`。
- [ ] **禁令扫描**：无新增 HTTP 路由、无 `LocalRepo` 之外的数据源、无 `#40` 槽位改动、无 `manifest` 版本改动。
- [ ] **目录不变式**：`core/*.ts` 不得 import `'uni'` / `'plus'`（`editlog.ts` / `carrier-pick.ts` 只依赖注入的 `FsAdapter` / `LocalRepo`）；平台能力一律经 `platform/uni.ts`。
- [ ] **模板不变式**：两页 `.vue` 模板无 `.value` 写法。

## 执行实况

> 已回填（2026-09-30 执行期实况）：Task 1–9 的 commit、门禁实测值、执行期更正与真机取证结论如下。

**Commit 序列（A 主线 第 5 册，Task 1–8 共 9 条，含 Task 4 收尾）：**

| Task | 内容 | commit |
| --- | --- | --- |
| 1 | 编辑面日志出口 `core/editlog.ts`（+ 测试 6 用例） | `7e4f2cc` |
| 2 | 自检 `pick.*` 两条探测 + `pickOk` + `canPickFile` / `pickBlockedReason` | `9a67650` |
| 3 | `pickLocalFile()` 运行时双分支（相册·拍照 与 `chooseFile`）+ `bootstrap()` 冷启动判 `pickOk` | `8d6ef7e` |
| 4 | 课程编辑页 F3（可读文案 + 本地日志 + 门禁） | `abdfec4` |
| 4′ | 课程编辑页 F3 收尾（日志只落一处） | `b9a66c8` |
| 5 | 课时编辑页 F3（同构） | `5ef3bf6` |
| 6 | 候选源纯函数 `core/carrier-pick.ts`（+ 测试 6 用例） | `b2ae27f` |
| 7 | 课时编辑页载体搜索 + 点选 + 只读标题 | `4da3849` |
| 8 | 课程编辑页「+ 选已有课时」（`lessonTitle` 现状已满足，无改动） | `1c133c6` |

**门禁实测值（Task 9 收口）：**

- mobile `npx vitest run`：**25 文件 / 246 用例**全绿（基线 25 / 246，只增不减）
- mobile `npx tsc --noEmit`：干净无输出
- mobile `npm run build:h5`：`DONE Build complete`
- 仓库根 `go build ./...` / `go vet ./...` / `go test ./...`：均 exit 0（本册不动 Go，无变化）
- `scripts/acceptance-d.ps1`：D 组推出「TC-D01–TC-D07 全绿」，**7 / 7 PASS**
- 发布前硬检查：`apps/mobile/src/pages` 全目录 `.value` 模板写法扫描**无输出**（acceptance D6 扫 24 个 `.vue`，无命中）
- 版本号：本册不改（`manifest.json` 仍 `0.15.0` / `20`，随 `#45` 批次统一改）

**执行期更正：**

- Task 4 收尾 `b9a66c8`：课程编辑页 F3 日志只落一处（避免同一失败重复写日志，`#46 §2.2` 取消时不写日志的口径保持）。

**真机取证结论：待真机复测。** 本册只预置运行时能力探测（`pickOk`）、三段失败的可读文案与本地日志、运行时双分支，供真机复测时按 `pickOk` 标志与失败 `stage` 原文取证；**F3 根因未定位，结论待真机复测补回**。