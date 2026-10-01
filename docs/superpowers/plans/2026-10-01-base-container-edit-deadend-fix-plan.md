# 容器编辑与失败行出路修复实施计划（册子 #61 → 计划 #62）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地册子 `#61` 全部诉求——① `loadContainerForm` 内下沉参数解码（`resolveId`，先原样后 `decodeURIComponent`，以命中真实 id 覆盖 `form.itemId`），一处同时消灭「编辑页回填空」与「保存 4xx」；② `pages/lesson/edit.vue` 的 `startNewLesson` 调用点先解码 `courseId`；③ 两个编辑页的日志出口 `ctx.adapters.fs` 改 `ctx.opts.adapters.fs`（不再掩码真实失败）；④ 台账失败行出路矩阵（编辑 / 重试 / 删除 / 复建，id 非法行优先级最高），新增 `LocalRepo.removeLocalContainer` 与 `core/submit.ts` 的 `retrySubmission`，详情页新增 `?rebuildFrom=<台账 id>` 复建分支；⑤ 封面上传预览（内存 dataURL 立即显示 + 落 `${workDir}/blobs/<blobId>` + `addBlob(..., '<itemId>/cover')` 供重进回显），出口抽 `uploadAndStoreBlob` 供封面 / 附件共用；⑥ 门禁补强（`apps/mobile` 加 `vue-tsc`，`typecheck` 直接替换为 `vue-tsc --noEmit`）；⑦ 版本 `0.20.1`/`26` 与四步发布收口。覆盖册子 §8 的 AC 1–15。

**Architecture:** 全部改动落在「纯函数 + 薄页面接线」两层：`core/course-edit.ts` 承担解码、id 形态判据、字节上传落盘登记三件纯/半纯职责；`core/my-created.ts` 承担台账行的出路矩阵与列表删除判据两个纯函数（详情页只消费，不自己写 if）；`core/repo.ts` 只加一个带 `source='local'` 守卫的删除方法；`core/submit.ts` 只加一个「读台账行 → 归一化重建 → 复用既有 `submitItem`」的重投出口。两个 `.vue` 编辑页与两个浏览页只做接线，零新状态机。**零新 HTTP 接口、零节点改动。**

**Tech Stack:** TypeScript + Vue 3 + uni-app（`apps/mobile`）／ vitest ／ `core/fakes.ts`（`MemoryRepo` / `FakeHttp` / `MemoryFs`）／ `vue-tsc@^2`（新增门禁）／ PowerShell 5.1。

**上游 spec:** `docs/superpowers/specs/2026-10-01-base-container-edit-deadend-fix-design.md`（册子 `#61`，本册权威需求来源）；直接上游 `#40`（容器字段模型与编辑面）、`#56`（本地乐观落库 + 台账 + 自愈迁移）、`#60`（行集预检 / 选文件探针 / `toPlusUrl` / 免票删除）。上一计划 `docs/superpowers/plans/2026-10-01-base-submit-fix-and-free-delete-plan.md`（`#60`）。

---

## 开工前已核实的现状（执行时直接用，不要重新调研）

| 事实 | 位置（仓库根 = `e:\code\base`） |
| --- | --- |
| `loadContainerForm` 直接 `repo.getItem(itemId)` + `repo.listSegments(itemId)`，`emptyContainerForm(type, itemId)` 把**入参原样**当身份 | `apps/mobile/src/core/course-edit.ts:212-230` |
| `startNewLesson(courseId)` 拼 `${courseId}/lesson/<hex>` | `apps/mobile/src/core/course-edit.ts:109-111` |
| 跳转方传编码态：课程编辑页 `openEdit` | `apps/mobile/src/pages/course/detail.vue:264-266` |
| 跳转方传编码态：课程编辑页 → 课时编辑页 `openLesson` | `apps/mobile/src/pages/course/edit.vue:355-359` |
| 两个编辑页直接拿原样 query 查库 | `apps/mobile/src/pages/course/edit.vue:204-215`、`apps/mobile/src/pages/lesson/edit.vue:265-282` |
| 日志出口字段错：`ctx.adapters.fs`（`AppContext` 无 `adapters`） | `apps/mobile/src/pages/course/edit.vue:284`、`apps/mobile/src/pages/lesson/edit.vue:329` |
| `AppContext` = `{ opts, repo, db, capabilities }`；适配器在 `opts.adapters`，`workDir` 在 `opts.workDir` | `apps/mobile/src/platform/index.ts:10-16`、`:61` |
| `recordEditFailure(fs, workDir, stage, detail)`，`stage ∈ pick\|read\|upload` | `apps/mobile/src/core/editlog.ts:20-28` |
| `pickLocalFile(): Promise<PickedFile\|null>`；`PickedFile = { name, bytes }`；`bytesToBase64(bytes)` | `apps/mobile/src/platform/uni.ts:490-509`、`:473-481` |
| `uploadBlob(o: BlobOptions, data, filename): Promise<string>`（`POST /v1/blob`） | `apps/mobile/src/core/blob.ts:51-91` |
| 块落盘路径口径 `${workDir}/blobs/<blob_id>` + `addBlob(blob_id, item_id, path, len, now)` | `apps/mobile/src/core/sync.ts:241-243` |
| 封面取键：`repo.findBlobPathByItem(\`${course.itemId}/cover\`)` + `path.startsWith('file://') ? path : 'file://'+path` | `apps/mobile/src/pages/course/detail.vue:142-143` |
| 列表页「我创建的」删除入口判据 = `row.localOnly` | `apps/mobile/src/pages/course/course.vue:19`、`removeMyCreated` `:350-355` |
| 详情页台账分支 `canEdit = row.state === 'sent'` | `apps/mobile/src/pages/course/detail.vue:119` |
| 详情页普通入口 `canEdit = (await repo.getSubmission(id))?.state === 'sent'` | `apps/mobile/src/pages/course/detail.vue:178` |
| `containerSegmentsFromLedger(row)` / `containerFormFromLedger(row)` / `buildMyCreatedView(rows, packIds)` | `apps/mobile/src/core/my-created.ts:110-113`、`:88-103`、`:44-60` |
| `runFlushSubmissions` 的容器重放判据：`containerSegmentsFromLedger === null` ⇒ `markSubmissionLocalOnly`，文案「本地数据无法还原，仅本地留存」 | `apps/mobile/src/core/submit.ts:370-382` |
| `writeLedger` **私有**；`submitItem` / `isPermanentSubmitFailure` / `SubmitError` 已导出；`decodeLedgerLinks` **私有** | `apps/mobile/src/core/submit.ts:276-295`、`:244-270`、`:230-232`、`:41-49`、`:413-422` |
| `LocalRepo` 接口 + `SqlRepo` 实现（`db.tx([...])` 做事务） | `apps/mobile/src/core/repo.ts:29-135`、`:621-644` |
| `MemoryRepo`（测试假实现，`items` / `segments` 为 `Map`） | `apps/mobile/src/core/fakes.ts:44-52`、`:287-298` |
| `Adapters` / `FsAdapter.writeFile(path, data)` | `apps/mobile/src/platform/adapter.ts:4-12`、`:51-56` |
| `typecheck = tsc --noEmit`（`tsc` **不解析 `.vue`**）；`tsconfig.json` 的 `include: ["src"]` | `apps/mobile/package.json:11`、`apps/mobile/tsconfig.json:12` |
| 版本 `0.20.0` / `25` | `apps/mobile/src/manifest.json:5-6` |
| 既有测试体例：`describe` + 中文用例名、`MemoryRepo` 直塞 `items`/`segments`、`json()` 造响应、`FakeHttp.postRoutes` | `apps/mobile/src/core/course-edit.test.ts`、`my-created.test.ts`、`creator-repo.test.ts` |
| 文档清单表（列 `# / path / 描述 / 不做 / 依赖 / 状态`），最新 #61 行 | `docs/README.md:87` |

**环境与工作区：** Windows PowerShell 5.1（**不支持 `&&` 与 heredoc**；多条命令用 `;` 分隔；`git commit` 用多个 `-m`）。手机端命令在 `e:\code\base\apps\mobile` 下跑。**工作区有其它未提交改动与未跟踪产物**（`.gitignore`、`apps/mobile/src/core/fakes.ts`、`apps/mobile/src/core/repo.ts`、`apps/mobile/src/core/types.ts`、`internal/httpapi/web.go`、未跟踪 `based-linux-amd64`）——**本册会改到 `fakes.ts` 与 `repo.ts`**，故这两个文件必须随本册一起 `git add`，其余（`.gitignore`、`types.ts`、`web.go`、`based-linux-amd64`）**一律不要动、不要 add**。每次只 `git add` 本任务列出的确切文件。

---

## 本计划的工程决策（册子已定死的部分不得翻案）

| # | 决策 | 理由 | 落点 |
| --- | --- | --- | --- |
| 1 | **`resolveId` 为 `course-edit.ts` 内部私有函数**，返回命中的真实 id 或 `null`；`loadContainerForm` 用 `(await resolveId(...)) ?? rawId` | 保留「条目不存在也得空表单、不抛」既有语义（AC 2），且不新增导出面 | `core/course-edit.ts` |
| 2 | **`isLegalContainerId(type, id)` 用通用段规则**：每段匹配 `^[a-z0-9][a-z0-9-]{0,63}$`；`course` 恰 2 段且首段 `course`；`lesson` 恰 4 段且 `[0]==='course' && [2]==='lesson'` | 与 `submit.ts:51` 注释的节点 item_id 形态同源；**不写死 16 hex**——既有测试与真实数据里存在 `course/c1/lesson/l1` 这类短段，写死 16 hex 会误判真实行非法 | `core/course-edit.ts` |
| 3 | **出路矩阵做成纯函数 `ledgerActionsOf(type, itemId, state, localOnly)`**（返回 `{edit, retry, removeLocal, rebuild, proposeRemove}`）放在 `my-created.ts` | 详情页只消费不自己写 if；矩阵可直接单测（AC 15 同理） | `core/my-created.ts` |
| 4 | **列表页删除判据做成纯函数 `canRemoveMyCreated(row)`** 放 `my-created.ts` | 册子 §4.2 要求「只增不减」，纯函数可断言 | `core/my-created.ts`、`course.vue` |
| 5 | **`uploadAndStoreBlob` 的依赖类型在 `course-edit.ts` 内本地定义**（`BlobStoreOptions`，4 字段与 `SyncOptions` 同形），**不 import `core/sync.ts`** | `core/sync.ts` 与 `core/course-edit.ts` 之间存在潜在运行期环；用本地接口 + type-only `Adapters` 彻底断开 | `core/course-edit.ts` |
| 6 | **`uploadAndStoreBlob` 的 `slot` 参数 = `blob_index.item_id` 的后缀**（封面 `'cover'`、附件 `'attachment'`）；**不做附件缩略图**（册子 §5 明确） | 封面键 `<itemId>/cover` 与 `detail.vue:142` 逐字一致；附件多行共享 `item_id` 值无害（`blob_id` 才是主键，且附件不按 item 查路径） | `core/course-edit.ts` |
| 7 | **`retrySubmission` 的暂时失败（断网 / 429 / 5xx）不写台账、保持原状态**，只把永久 4xx 写 `markSubmissionFailed` | 册子 §4.3 要求「不引入新的状态流转」；把 `failed` 改回 `pending` 会违反 `#56 §2.4` 的终态单向性 | `core/submit.ts` |
| 8 | **`retrySubmission` 内私有复刻 `decodeLedgerLinks`**（tag 载体分支用），不改 `submit.ts` 里那个私有函数的可见性 | 与 `#60` 决策 1（私有 `localStep` 复刻）同一取舍：改可见性=扩大改动面 | `core/submit.ts` |
| 9 | **`removeLocalContainer` 只清 `segments` 与 `items(source='local')`，不动 `blob_index`** | 册子 §4.3 只列这两条；块文件清理属同步墓碑范畴（`#13` 既有口径），本册不越界 | `core/repo.ts` |
| 10 | **两个编辑页把 `uploadOne` 拆成 `pickFile` + `storeBlob`** | 册子 §5 要求「拿到字节**立即**出预览、不必等落盘或节点返回」；拆开后 `pickCover` 先置 `coverPreview` 再上传，封面与附件共用两个小函数 | `pages/*/edit.vue` |
| 11 | **`vue-tsc` 进 `typecheck` 需同时改 `tsconfig.json` 的 `include`**（补 `src/**/*.vue`），并把 `typecheck` **直接替换**为 `vue-tsc --noEmit` | 现状 `include: ["src"]` 不匹配 `.vue` 扩展，只加依赖等于门禁空转；册子 §6 明确「不新增第二个脚本」 | `apps/mobile/package.json`、`apps/mobile/tsconfig.json` |
| 12 | **`vue-tsc` 若翻出无关 `.vue` 的既有类型错，按册子 §7 风险 3 退化**：只保证本册改动的 4 个 `.vue` 干净，**不顺手清理无关页面** | 缺陷批次不做重构批次 | Task 8 |
| 13 | **Bug2 的真实失败仍未知**：本册只修掩码字段，**不预设、不改**读取实现；真机复测的判读口径见册子 §7 风险 1 | 册子 §3 明确 | Task 6、AC 13 |

---

## 文件结构

**新增**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| — | — | 本册**不新增任何文件**（测试全部并入既有 `*.test.ts`） |

**修改**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `apps/mobile/src/core/course-edit.ts` | 修改 | 私有 `resolveId` + `loadContainerForm` 解码；导出 `isLegalContainerId` / `PickedBytes` / `BlobStoreOptions` / `uploadAndStoreBlob`（§2 / §4.3 / §5） |
| `apps/mobile/src/core/course-edit.test.ts` | 修改 | 解码 4 例 + id 判据 2 例 + `uploadAndStoreBlob` 1 例（AC 1/2/3/14） |
| `apps/mobile/src/core/my-created.ts` | 修改 | 导出 `canRemoveMyCreated` + `ledgerActionsOf`（+ `LedgerActions` 类型）（§4.2） |
| `apps/mobile/src/core/my-created.test.ts` | 修改 | 删除判据 3 例 + 出路矩阵 5 例（AC 15 + AC 10/12 的纯函数面） |
| `apps/mobile/src/core/repo.ts` | 修改 | `LocalRepo` 接口 + `SqlRepo` 实现 `removeLocalContainer`（§4.3） |
| `apps/mobile/src/core/fakes.ts` | 修改 | `MemoryRepo` 实现 `removeLocalContainer`（否则 Task 4 测试与页面编译均破） |
| `apps/mobile/src/core/creator-repo.test.ts` | 修改 | `removeLocalContainer` 2 例（AC 5） |
| `apps/mobile/src/core/submit.ts` | 修改 | 导出 `retrySubmission` + 私有 `decodeLedgerLinks` 复刻（§4.3） |
| `apps/mobile/src/core/submit.test.ts` | 修改 | `retrySubmission` 3 例（AC 4） |
| `apps/mobile/src/pages/course/edit.vue` | 修改 | `logFail` 字段修正 + `pickFile`/`storeBlob` 拆分 + 封面预览 + 预览回显 + `rebuildFrom` 分支（§2 / §3 / §5 / §4.3） |
| `apps/mobile/src/pages/lesson/edit.vue` | 修改 | 同上（无 `rebuildFrom`）+ `courseId` 先解码（§2.2） |
| `apps/mobile/src/pages/course/course.vue` | 修改 | 删除入口判据改 `canRemoveMyCreated` + `removeMyCreated` 连带清本地乐观条目（§4.2） |
| `apps/mobile/src/pages/course/detail.vue` | 修改 | 台账分支改消费 `ledgerActionsOf`；新增 重试 / 删除这条记录 / 复建为新课程 三个入口（§4.2） |
| `apps/mobile/package.json` | 修改 | 加 `vue-tsc@^2` 依赖；`typecheck` 替换为 `vue-tsc --noEmit`（§6） |
| `apps/mobile/tsconfig.json` | 修改 | `include` 补 `src/**/*.vue`（决策 11） |
| `apps/mobile/src/manifest.json` | 修改 | 版本 `0.20.1`/`26`（Task 9） |
| `docs/README.md` | 修改 | 文档清单表末登记 #62 行 + §5 当前阶段（Task 9） |

**不改动（硬边界）：** 节点侧一切（`internal/**` 零改动，尤其 `validateSubmitSegments` / `childKindsByContainer` / `AttrSeqsCanonical` / 错误码 / `POST /v1/proposal`）；`core/submit.ts` 的 `submitItem` / `writeLedger` / `enqueueOrSend` / `flushSubmissions` 既有签名与语义；`core/blob.ts` 的 `uploadBlob` / `fetchBlob` 契约；`core/my-created.ts` 的 `buildMyCreatedView` / `containerFormFromLedger` / `containerSegmentsFromLedger` / `ledgerSegmentsOf` 既有行为；`core/course-edit.ts` 的 `buildContainerSegments` / `validateContainerSegments` / `toLocalContainer` / `saveContainer`；`platform/uni.ts` 的 `pickLocalFile` / `bytesToBase64` / `toPlusUrl`；其余 4 处已有 `decodedId` 的页面（article / quiz / tag / lesson-detail）；`attr.body_md` / `attr.category` 跨容器防御；内容包规范 v1 与 `schema_version`；`sent` 行的台账语义（永不可本地删除）。不做 iOS。

---

### Task 1: `loadContainerForm` 参数解码下沉（Bug1 + Bug4 同源根因）

**Files:** Modify `apps/mobile/src/core/course-edit.ts`；Modify `apps/mobile/src/core/course-edit.test.ts`

- [ ] **Step 1: 写失败测试** —— 在 `apps/mobile/src/core/course-edit.test.ts` 末尾追加（`MemoryRepo` / `loadContainerForm` 已在文件头 import）：

  ```ts
  describe('loadContainerForm：参数解码（册子 #61 §2）', () => {
    /** 造一门已在本地库里的课程（items + segments 直塞，与 my-created.test.ts 同手法）。 */
    function seeded(): MemoryRepo {
      const repo = new MemoryRepo();
      repo.items.set('course/c1', {
        itemId: 'course/c1', source: 'course', type: 'course', title: '数学',
        rev: 'r', contentHash: 'h', state: 'active', updatedAt: '',
      });
      repo.segments.set('course/c1', [
        { itemId: 'course/c1', seq: -1, kind: 'attr.instructor', text: '李老师', contentHash: '' },
        { itemId: 'course/c1', seq: 0, kind: 'digest', text: '课程简介', contentHash: '' },
        { itemId: 'course/c1', seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1', contentHash: '' },
      ]);
      return repo;
    }

    it('传编码态 id（course%2Fc1）⇒ 回填真实内容，且 form.itemId 为解码后的真 id', async () => {
      const form = await loadContainerForm(seeded(), 'course%2Fc1', 'course');
      expect(form.itemId).toBe('course/c1');
      expect(form.title).toBe('数学');
      expect(form.instructor).toBe('李老师');
      expect(form.digest).toBe('课程简介');
      expect(form.children).toEqual([{ kind: 'lesson', itemId: 'course/c1/lesson/l1' }]);
    });

    it('传解码态 id 或原样命中 ⇒ 行为不变（首次 getItem 即命中）', async () => {
      const form = await loadContainerForm(seeded(), 'course/c1', 'course');
      expect(form.itemId).toBe('course/c1');
      expect(form.title).toBe('数学');
    });

    it('条目不存在 ⇒ 仍得空表单、不抛（保留语义，AC 2）', async () => {
      const form = await loadContainerForm(new MemoryRepo(), 'course%2Fnope', 'course');
      expect(form.title).toBe('');
      expect(form.type).toBe('course');
      expect(form.itemId).toBe('course%2Fnope');
    });

    it('坏编码（course%ZZ）不抛，回落原样得空表单', async () => {
      const form = await loadContainerForm(new MemoryRepo(), 'course%ZZ', 'course');
      expect(form.itemId).toBe('course%ZZ');
      expect(form.title).toBe('');
    });
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  Run（cwd `apps/mobile`）: `npx vitest run src/core/course-edit.test.ts`
  Expected: 第 1 例 FAIL —— `form.itemId` 实得 `'course%2Fc1'`、`form.title` 实得 `''`。

- [ ] **Step 3: 实现 `resolveId` + 改 `loadContainerForm`** —— 在 `apps/mobile/src/core/course-edit.ts` 的 `loadContainerForm` 之前插入私有函数，并把 `loadContainerForm` 的函数体首两行改掉：

  ```ts
  /**
   * 解码参数取真 id（册子 #61 §2）：先原样 `getItem`，未命中且解码形态不同时再试 `decodeURIComponent`。
   * 跳转方传的是 `encodeURIComponent(id)`，`course/<hex>` 到页面就成了 `course%2F<hex>`；
   * 命中即返回真实 id（调用方据此覆盖 `form.itemId`），都不命中返回 `null`（调用方回落原样入参）。
   */
  async function resolveId(repo: LocalRepo, raw: string): Promise<string | null> {
    if (raw === '') return null;
    if ((await repo.getItem(raw)) !== null) return raw;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null; // 坏编码（如 course%ZZ）不是错误，回落原样即可
    }
    if (decoded === raw) return null;
    return (await repo.getItem(decoded)) !== null ? decoded : null;
  }

  /** 从本地包回填表单：标题取 `items`，其余取 `segments` 的三区间。条目不存在也得空表单，不抛。 */
  export async function loadContainerForm(repo: LocalRepo, rawId: string, type: ContainerType): Promise<ContainerForm> {
    // 解码下沉（册子 #61 §2）：以命中的真实 id 覆盖 form.itemId —— 修好回填（Bug1）与保存 4xx（Bug4）两个症状。
    const itemId = (await resolveId(repo, rawId)) ?? rawId;
    const item = await repo.getItem(itemId);
    const segs = await repo.listSegments(itemId);
    const attrs = attrsOf(segs);
    const form = emptyContainerForm(type, itemId);
    form.title = item?.title ?? '';
    form.digest = digestOf(segs);
    form.cover = attrs.cover;
    form.instructor = attrs.instructor;
    form.difficulty = attrs.difficulty;
    form.durationSec = attrs.duration;
    form.attachments = attrs.attachments.map((a) => ({ blobId: a.blobId, name: a.name }));
    form.bodyMd = type === 'lesson' ? attrs.bodyMd : '';
    form.category = type === 'course' ? attrs.category : '';
    form.badge = attrs.badge;
    form.titleColor = attrs.titleColor;
    form.children = childrenRowsOf(segs).map((r) => ({ kind: r.kind, itemId: r.text }));
    return form;
  }
  ```

- [ ] **Step 4: 跑测试确认通过**

  Run: `npx vitest run src/core/course-edit.test.ts`
  Expected: 全绿（原 4 例 `loadContainerForm` 用例也保持绿）。

- [ ] **Step 5: Commit**

  ```powershell
  git add apps/mobile/src/core/course-edit.ts apps/mobile/src/core/course-edit.test.ts
  git commit -m "fix: loadContainerForm 下沉参数解码（修编辑页回填空与保存 4xx）" -m "册子 #61 §2：先原样后 decodeURIComponent，以命中真实 id 覆盖 form.itemId"
  ```

---

### Task 2: `isLegalContainerId` 容器 id 形态判据

**Files:** Modify `apps/mobile/src/core/course-edit.ts`；Modify `apps/mobile/src/core/course-edit.test.ts`

- [ ] **Step 1: 写失败测试** —— 追加到 `course-edit.test.ts`（import 处需补 `isLegalContainerId`）：

  先把文件头 import 改为：

  ```ts
  import {
    buildContainerSegments,
    emptyContainerForm,
    isLegalContainerId,
    loadContainerForm,
    saveContainer,
    startNewCourse,
    startNewLesson,
    toLocalContainer,
    validateContainerSegments,
    type ContainerForm,
  } from './course-edit';
  ```

  再追加：

  ```ts
  describe('isLegalContainerId：容器 id 形态判据（册子 #61 §4.3）', () => {
    it('合法形态：course/<段> 与 course/<段>/lesson/<段>', () => {
      expect(isLegalContainerId('course', 'course/0123456789abcdef')).toBe(true);
      expect(isLegalContainerId('lesson', 'course/0123456789abcdef/lesson/fedcba9876543210')).toBe(true);
      expect(isLegalContainerId('course', 'course/c1')).toBe(true);
      expect(isLegalContainerId('lesson', 'course/c1/lesson/l1')).toBe(true);
      expect(isLegalContainerId('course', 'course/a-b-9')).toBe(true);
    });

    it('含 % / 大写 / 空段 / 段长越界 / 段结构不符 ⇒ 非法', () => {
      expect(isLegalContainerId('course', 'course%2Fc1')).toBe(false);
      expect(isLegalContainerId('course', 'Course/c1')).toBe(false);
      expect(isLegalContainerId('course', 'course//c1')).toBe(false);
      expect(isLegalContainerId('course', `course/${'a'.repeat(65)}`)).toBe(false);
      expect(isLegalContainerId('course', 'article/a1')).toBe(false);
      expect(isLegalContainerId('course', 'course')).toBe(false);
      expect(isLegalContainerId('lesson', 'course/c1')).toBe(false);
      expect(isLegalContainerId('lesson', 'course/c1/lesson')).toBe(false);
      expect(isLegalContainerId('lesson', 'course/c1/article/a1')).toBe(false);
      expect(isLegalContainerId('lesson', 'course/c1/lesson/l1/x')).toBe(false);
    });
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  Run: `npx vitest run src/core/course-edit.test.ts`
  Expected: FAIL —— `isLegalContainerId is not a function`。

- [ ] **Step 3: 实现** —— 在 `apps/mobile/src/core/course-edit.ts` 的 `emptyContainerForm` 之后插入：

  ```ts
  /** id 段形态：与 `submit.ts` 注释的节点 item_id 口径同源（`[a-z0-9][a-z0-9-]{0,63}`）。 */
  const ID_SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;

  /**
   * 容器 id 形态判据（册子 #61 §4.3）：段级字符与长度 + 容器段结构。
   * 用于详情页/编辑页判「这条台账行能不能原样重投」——含 `%` 或段结构不符者不可救，只能复建为新 id。
   */
  export function isLegalContainerId(type: ContainerType, id: string): boolean {
    const segs = id.split('/');
    if (!segs.every((s) => ID_SEGMENT.test(s))) return false;
    if (type === 'course') return segs.length === 2 && segs[0] === 'course';
    return segs.length === 4 && segs[0] === 'course' && segs[2] === 'lesson';
  }
  ```

- [ ] **Step 4: 跑测试确认通过**

  Run: `npx vitest run src/core/course-edit.test.ts`
  Expected: 全绿。

- [ ] **Step 5: Commit**

  ```powershell
  git add apps/mobile/src/core/course-edit.ts apps/mobile/src/core/course-edit.test.ts
  git commit -m "feat: 新增 isLegalContainerId 容器 id 形态判据" -m "册子 #61 §4.3：供失败行出路矩阵与复建分支共用"
  ```

---

### Task 3: `uploadAndStoreBlob` 字节上传落盘登记出口（Bug3 的一半）

**Files:** Modify `apps/mobile/src/core/course-edit.ts`；Modify `apps/mobile/src/core/course-edit.test.ts`

- [ ] **Step 1: 写失败测试** —— 追加到 `course-edit.test.ts`（import 处补 `uploadAndStoreBlob`；顶部 `MemoryFs` / `fakeAdapters` / `FakeHttp` / `FakePackReader` 已 import；`MemoryFs` 需从 `./fakes` 引入——检查文件头已有 `import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';`，已具备）：

  ```ts
  describe('uploadAndStoreBlob：上传 + 落盘 + 登记（册子 #61 §5）', () => {
    it('字节写 workDir/blobs/<blobId>，并登记 blob_index 使 <itemId>/cover 可回显', async () => {
      const http = new FakeHttp();
      const fs = new MemoryFs();
      const repo = new MemoryRepo();
      const adapters = fakeAdapters(http, fs, new FakePackReader());
      const blobId = 'a'.repeat(32);
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      http.postRoutes.set(`${BASE}/v1/blob`, json({ blob_id: blobId }));

      const got = await uploadAndStoreBlob(
        { adapters, repo, nodeBaseUrl: BASE, workDir: '/work' },
        'course/c1',
        'cover',
        { name: 'c.png', bytes: utf8('hello') },
      );

      expect(got.blobId).toBe(blobId);
      expect(got.path).toBe(`/work/blobs/${blobId}`);
      expect(await fs.exists(got.path)).toBe(true);
      expect(await repo.findBlobPathByItem('course/c1/cover')).toBe(got.path);
      expect(await repo.hasBlob(blobId)).toBe(true);
    });
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  Run: `npx vitest run src/core/course-edit.test.ts`
  Expected: FAIL —— `uploadAndStoreBlob is not a function`。

- [ ] **Step 3: 实现** —— 在 `apps/mobile/src/core/course-edit.ts` 顶部补 import，并在文件末尾（`saveContainer` 之后）追加类型与函数：

  import 区新增两行（`Adapters` 只作类型用，不会引入运行期环）：

  ```ts
  import type { Adapters } from '../platform/adapter';
  import { uploadBlob } from './blob';
  ```

  追加：

  ```ts
  /** 待上传的字节（与 `platform/uni.ts` 的 `PickedFile` 同形；core 不 import 平台层）。 */
  export interface PickedBytes {
    name: string;
    bytes: Uint8Array;
  }

  /** `uploadAndStoreBlob` 的依赖（与 `core/sync.ts` 的 `SyncOptions` 同形，本模块只取用这四项）。 */
  export interface BlobStoreOptions {
    adapters: Adapters;
    repo: LocalRepo;
    nodeBaseUrl: string;
    workDir: string;
  }

  /**
   * 上传一块并把字节落到本机（册子 #61 §5）：`POST /v1/blob` → `${workDir}/blobs/<blobId>` →
   * `addBlob(blobId, '<itemId>/<slot>')`。封面（slot=`cover`）与附件（slot=`attachment`）共用这一出口；
   * 封面键 `<itemId>/cover` 与 `pages/course/detail.vue` 的取键**逐字一致**，重进编辑页即可回显。
   * 「字节 → 预览 src」留页面（`bytesToBase64` 属平台层）。
   */
  export async function uploadAndStoreBlob(
    o: BlobStoreOptions,
    itemId: string,
    slot: string,
    picked: PickedBytes,
  ): Promise<{ blobId: string; path: string }> {
    const blobId = await uploadBlob({ adapters: o.adapters, repo: o.repo, nodeBaseUrl: o.nodeBaseUrl }, picked.bytes, picked.name);
    const path = `${o.workDir}/blobs/${blobId}`;
    await o.adapters.fs.writeFile(path, picked.bytes);
    await o.repo.addBlob(blobId, `${itemId}/${slot}`, path, picked.bytes.length, new Date().toISOString());
    return { blobId, path };
  }
  ```

- [ ] **Step 4: 跑测试确认通过**

  Run: `npx vitest run src/core/course-edit.test.ts`
  Expected: 全绿。

- [ ] **Step 5: Commit**

  ```powershell
  git add apps/mobile/src/core/course-edit.ts apps/mobile/src/core/course-edit.test.ts
  git commit -m "feat: 新增 uploadAndStoreBlob（上传 + 落盘 + 登记）" -m "册子 #61 §5：封面与附件共用出口，封面键 <itemId>/cover
  ```

---

### Task 4: `LocalRepo.removeLocalContainer` 本地删除（Bug5 的一半）

**Files:** Modify `apps/mobile/src/core/repo.ts`；Modify `apps/mobile/src/core/fakes.ts`；Modify `apps/mobile/src/core/creator-repo.test.ts`

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/mobile/src/core/creator-repo.test.ts` 末尾（`MemoryRepo` 已 import）：

  ```ts
  describe('removeLocalContainer：失败行的本地删除（册子 #61 §4.3）', () => {
    it('清 segments 与 items（source=local）', async () => {
      const repo = new MemoryRepo();
      await repo.upsertLocalContainer(
        { itemId: 'course/c1', type: 'course', title: 'A', contentHash: 'h', updatedAt: 't' },
        [{ seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1' }],
      );
      await repo.removeLocalContainer('course/c1');
      expect(await repo.getItem('course/c1')).toBeNull();
      expect(await repo.listSegments('course/c1')).toEqual([]);
    });

    it('source!=local 时 items 保留（守卫：绝不误删节点已收录内容）', async () => {
      const repo = new MemoryRepo();
      repo.items.set('course/c1', {
        itemId: 'course/c1', source: 'course', type: 'course', title: '同步来的',
        rev: '1', contentHash: 'h', state: 'active', updatedAt: '',
      });
      repo.segments.set('course/c1', [{ itemId: 'course/c1', seq: 1, kind: 'lesson', text: 'x', contentHash: '' }]);
      await repo.removeLocalContainer('course/c1');
      expect((await repo.getItem('course/c1'))!.title).toBe('同步来的');
      expect(await repo.listSegments('course/c1')).toEqual([]);
    });
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  Run: `npx vitest run src/core/creator-repo.test.ts`
  Expected: FAIL —— `repo.removeLocalContainer is not a function`。

- [ ] **Step 3: 三处实现**

  3a) `apps/mobile/src/core/repo.ts` —— 在 `LocalRepo` 接口的 `upsertLocalContainer` 之后（`:112` 之后）插入：

  ```ts
    /**
     * 删一条「本地乐观条目」（册子 #61 §4.3）：同事务清 `segments` 与 `items`。
     * `items` 带 `source='local'` 守卫——万一 id 与包内条目撞车，绝不误删节点已收录内容
     * （取舍：宁可留一份包内数据，也不误删；见册子 §7 风险 5）。
     */
    removeLocalContainer(itemId: string): Promise<void>;
  ```

  3b) `apps/mobile/src/core/repo.ts` —— 在 `SqlRepo` 的 `upsertLocalContainer` 实现之后（`:640` 之后、`markSubmissionLocalOnly` 之前）插入：

  ```ts
    async removeLocalContainer(itemId: string): Promise<void> {
      await this.db.tx([
        { sql: `DELETE FROM segments WHERE item_id=?`, params: [itemId] },
        { sql: `DELETE FROM items WHERE item_id=? AND source='local'`, params: [itemId] },
      ]);
    }
  ```

  3c) `apps/mobile/src/core/fakes.ts` —— 在 `MemoryRepo` 的 `upsertLocalContainer` 之后（`:298` 之后）插入：

  ```ts
    async removeLocalContainer(itemId: string): Promise<void> {
      this.segments.delete(itemId);
      if (this.items.get(itemId)?.source === 'local') this.items.delete(itemId);
    }
  ```

- [ ] **Step 4: 跑测试确认通过**

  Run: `npx vitest run src/core/creator-repo.test.ts`
  Expected: 全绿。

- [ ] **Step 5: Commit**（注意本任务必须 add `fakes.ts` 与 `repo.ts` 这两个工作区已有改动的文件——它们同时承载本册改动）

  ```powershell
  git add apps/mobile/src/core/repo.ts apps/mobile/src/core/fakes.ts apps/mobile/src/core/creator-repo.test.ts
  git commit -m "feat: LocalRepo 新增 removeLocalContainer（带 source=local 守卫）" -m "册子 #61 §4.3：失败行删除 = 台账行 + 本机乐观条目一起清"
  ```

---

### Task 5: `retrySubmission` 失败行重投（Bug5 的一半）

**Files:** Modify `apps/mobile/src/core/submit.ts`；Modify `apps/mobile/src/core/submit.test.ts`

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/mobile/src/core/submit.test.ts` 末尾。先核对文件头已有的 import；若缺则补齐：

  ```ts
  import { utf8 } from '@base/protocol-ts';
  import { describe, expect, it } from 'vitest';

  import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
  import { retrySubmission, type SubmitOptions } from './submit';
  import type { MySubmissionRow } from './types';

  /** 造一条容器台账行（除需断言的字段外给中性默认值）。 */
  function containerRow(over: Partial<MySubmissionRow> = {}): MySubmissionRow {
    return {
      itemId: 'course/c1', type: 'course', title: '课程', bodyMd: '', questionJson: '', linksJson: '',
      segmentsJson: JSON.stringify([
        { seq: -1, kind: 'attr.instructor', text: '李老师' },
        { seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1' },
      ]),
      state: 'pending', reason: '网络不可达', created: 0,
      queuedAt: '2026-10-01T00:00:00Z', sentAt: '', localOnly: false,
      ...over,
    };
  }

  /** 造一套依赖；`submit` 路由由调用方按需设置。 */
  function env() {
    const http = new FakeHttp();
    const repo = new MemoryRepo();
    const o: SubmitOptions = { adapters: fakeAdapters(http, new MemoryFs(), new FakePackReader()), repo, nodeBaseUrl: BASE };
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    return { http, repo, o };
  }

  describe('retrySubmission：失败行重投（册子 #61 §4.3）', () => {
    it('pending 容器行重建后重投成功 ⇒ 台账转 sent', async () => {
      const { http, repo, o } = env();
      http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'course/c1', created: false }));
      await repo.saveSubmission(containerRow());

      const out = await retrySubmission(o, 'course/c1');

      expect(out.ledgerState).toBe('sent');
      expect((await repo.getSubmission('course/c1'))!.state).toBe('sent');
      expect(http.posted.some((p) => p.url === `${BASE}/v1/submit`)).toBe(true);
    });

    it('节点永久 4xx ⇒ 台账转 failed，且保留节点文案', async () => {
      const { http, repo, o } = env();
      http.postRoutes.set(`${BASE}/v1/submit`, { status: 400, body: utf8(JSON.stringify({ code: 'item_segments_invalid' })) });
      await repo.saveSubmission(containerRow({ state: 'failed', reason: '旧原因' }));

      const out = await retrySubmission(o, 'course/c1');

      expect(out.ledgerState).toBe('failed');
      expect(out.message).not.toBe('');
      const got = (await repo.getSubmission('course/c1'))!;
      expect(got.state).toBe('failed');
      expect(got.reason).toBe(out.message);
    });

    it('容器行集还原不出（空 segments_json）⇒ 降级为「仅本地留存」终态，不发网络请求', async () => {
      const { http, repo, o } = env();
      await repo.saveSubmission(containerRow({ state: 'failed', segmentsJson: '' }));

      const out = await retrySubmission(o, 'course/c1');

      expect(out.ledgerState).toBe('failed');
      expect(out.message).toBe('本地数据无法还原，仅本地留存');
      const got = (await repo.getSubmission('course/c1'))!;
      expect(got.localOnly).toBe(true);
      expect(http.posted.some((p) => p.url === `${BASE}/v1/submit`)).toBe(false);
    });
  });
  ```

  同时把 `json()` helper 补齐（若文件内已存在同名 helper 则复用、不要重复定义）：

  ```ts
  const BASE = 'https://node.test';
  function json(v: unknown) {
    return { status: 200, body: utf8(JSON.stringify(v)) };
  }
  ```

- [ ] **Step 2: 跑测试确认失败**

  Run: `npx vitest run src/core/submit.test.ts`
  Expected: FAIL —— `retrySubmission is not a function`。

- [ ] **Step 3: 实现** —— 在 `apps/mobile/src/core/submit.ts` 的 `runFlushSubmissions` 之后、`decodeLedgerLinks` 之前追加：

  ```ts
  /** 台账 `links_json` → 草稿 `links`（`decodeLedgerLinks` 的同一实现，本模块内两处调用共用私有版）。 */

  /**
   * 重投一条台账行（册子 #61 §4.3）：读台账行 → 容器行重用 `containerSegmentsFromLedger` 归一化重建
   * （与 `runFlushSubmissions` 同一判据、同一文案）→ 走既有 `submitItem`。
   * **不引入新的状态流转**：成功 `sent`；永久 4xx → `failed`；还原不出 → 终态「仅本地留存」；
   * 暂时失败（断网 / 429 / 5xx）**不改台账状态**（把 `failed` 改回 `pending` 会违反 #56 §2.4 的单向性）。
   */
  export async function retrySubmission(o: SubmitOptions, itemId: string): Promise<SubmitOutcome> {
    if (o.nodeBaseUrl === '') throw new SubmitError('client', '未配置节点地址，无法投稿');
    const row = await o.repo.getSubmission(itemId);
    if (row === null) throw new SubmitError('client', '本地没有这条投稿记录');

    let segments: SubmitSegmentRow[] | undefined;
    if (row.type === 'course' || row.type === 'lesson') {
      const rebuilt = containerSegmentsFromLedger(row);
      if (rebuilt === null) {
        await o.repo.markSubmissionLocalOnly(row.itemId, LOCAL_ONLY_REASON);
        return { itemId: row.itemId, created: false, ledgerState: 'failed', message: LOCAL_ONLY_REASON };
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
      return { itemId: row.itemId, created: r.created, ledgerState: 'sent', message: '' };
    } catch (e) {
      const msg = e instanceof SubmitError ? e.message : `补发失败：${(e as Error).message ?? String(e)}`;
      if (isPermanentSubmitFailure(e)) {
        await o.repo.markSubmissionFailed(row.itemId, msg);
        return { itemId: row.itemId, created: false, ledgerState: 'failed', message: msg };
      }
      // 暂时失败：只回文案，不动台账状态
      return { itemId: row.itemId, created: false, ledgerState: row.state === 'failed' ? 'failed' : 'pending', message: msg };
    }
  }
  ```

  并在 `apps/mobile/src/core/submit.ts` 顶部常量区（`TAG_KIND_RANK` 之前）新增共享文案常量，同时把 `runFlushSubmissions` 里那句字面量改为引用它：

  ```ts
  /** 「仅本地留存」的固定原因文案（重放与重投两处共用，册子 #56 §2.4 / #61 §4.3）。 */
  const LOCAL_ONLY_REASON = '本地数据无法还原，仅本地留存';
  ```

  并把 `runFlushSubmissions` 中（`:377`）：

  ```ts
        await o.repo.markSubmissionLocalOnly(row.itemId, '本地数据无法还原，仅本地留存');
  ```

  改为：

  ```ts
        await o.repo.markSubmissionLocalOnly(row.itemId, LOCAL_ONLY_REASON);
  ```

- [ ] **Step 4: 跑测试确认通过**

  Run: `npx vitest run src/core/submit.test.ts`
  Expected: 全绿（`flushSubmissions` 既有用例保持绿）。

- [ ] **Step 5: Commit**

  ```powershell
  git add apps/mobile/src/core/submit.ts apps/mobile/src/core/submit.test.ts
  git commit -m "feat: 新增 retrySubmission 失败行重投（复用归一化重建与 submitItem）" -m "册子 #61 §4.3：不改三态语义，暂时失败不动台账状态"
  ```

---

### Task 6: 台账出路矩阵与列表删除判据（纯函数）

**Files:** Modify `apps/mobile/src/core/my-created.ts`；Modify `apps/mobile/src/core/my-created.test.ts`

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/mobile/src/core/my-created.test.ts`（import 处补 `canRemoveMyCreated, ledgerActionsOf`）：

  ```ts
  describe('canRemoveMyCreated：列表删除入口判据（册子 #61 §4.2，只增不减）', () => {
    it('localOnly 行原样保留删除入口', () => {
      expect(canRemoveMyCreated(mrow({ state: 'failed', localOnly: true }))).toBe(true);
    });

    it('pending / failed 行新增删除入口', () => {
      expect(canRemoveMyCreated(mrow({ state: 'pending' }))).toBe(true);
      expect(canRemoveMyCreated(mrow({ state: 'failed' }))).toBe(true);
    });

    it('sent 且非 localOnly ⇒ 不出删除入口', () => {
      expect(canRemoveMyCreated(mrow({ state: 'sent', localOnly: false }))).toBe(false);
    });
  });

  describe('ledgerActionsOf：失败行出路矩阵（册子 #61 §4.2）', () => {
    it('sent + id 合法 ⇒ 编辑 + 提案下架（不给本地删除）', () => {
      expect(ledgerActionsOf('course', 'course/c1', 'sent', false)).toEqual({
        edit: true, retry: false, removeLocal: false, rebuild: false, proposeRemove: true,
      });
    });

    it('pending + id 合法 ⇒ 编辑 + 重试 + 本地删除', () => {
      expect(ledgerActionsOf('course', 'course/c1', 'pending', false)).toEqual({
        edit: true, retry: true, removeLocal: true, rebuild: false, proposeRemove: false,
      });
    });

    it('failed + id 合法 ⇒ 编辑 + 重试 + 本地删除（无复建）', () => {
      expect(ledgerActionsOf('course', 'course/c1', 'failed', false)).toEqual({
        edit: true, retry: true, removeLocal: true, rebuild: false, proposeRemove: false,
      });
    });

    it('id 非法 ⇒ 任意 state 都只剩 本地删除 + 复建（最高优先级）', () => {
      for (const s of ['pending', 'sent', 'failed'] as const) {
        expect(ledgerActionsOf('course', 'course%2Fc1', s, false)).toEqual({
          edit: false, retry: false, removeLocal: true, rebuild: true, proposeRemove: false,
        });
      }
    });

    it('「仅本地留存」终态 ⇒ 不给重试（永不自动重放）', () => {
      const a = ledgerActionsOf('course', 'course/c1', 'failed', true);
      expect(a.retry).toBe(false);
      expect(a.removeLocal).toBe(true);
    });
  });
  ```

  并把文件内既有的 `row()` helper 改名以避免与新 helper 冲突——**不要改名**，直接复用既有的 `row()`；把上面测试里的 `mrow(...)` 全部替换为 `row(...)`：

  Run（改完确认）: `npx vitest run src/core/my-created.test.ts`

- [ ] **Step 2: 跑测试确认失败**

  Run: `npx vitest run src/core/my-created.test.ts`
  Expected: FAIL —— `ledgerActionsOf is not a function`。

- [ ] **Step 3: 实现** —— `apps/mobile/src/core/my-created.ts`：

  3a) import 处补 `isLegalContainerId`：

  ```ts
  import { buildContainerSegments, emptyContainerForm, isLegalContainerId, type ContainerForm, type ContainerType } from './course-edit';
  ```

  3b) 文件末尾追加：

  ```ts
  /**
   * 「我创建的」行的删除入口判据（册子 #61 §4.2）：**只增不减**——
   * `localOnly` 行原有的删除入口一字不动保留，`pending` / `failed` 行新增。
   */
  export function canRemoveMyCreated(row: MyCreatedRow): boolean {
    return row.state !== 'sent' || row.localOnly;
  }

  /** 台账失败行在详情页可用的动作集（册子 #61 §4.2）。 */
  export interface LedgerActions {
    /** 进入编辑页 */
    edit: boolean;
    /** 立即重投这一条 */
    retry: boolean;
    /** 本地删除（台账行 + 本机乐观条目） */
    removeLocal: boolean;
    /** 复建为新课程（内容照搬、身份重生成） */
    rebuild: boolean;
    /** 走既有 `remove` 提案下架（仅已收录内容） */
    proposeRemove: boolean;
  }

  /**
   * 出路矩阵（册子 #61 §4.2）：**id 非法优先级最高**——任何 state 下都不给「编辑 / 重试」
   * （原样重投只会再被拒一次），只剩「删除」与「复建」。
   * `localOnly` 是终态（#56 §2.4），故不给重试。
   */
  export function ledgerActionsOf(
    type: MyCreatedType,
    itemId: string,
    state: MySubmissionRow['state'],
    localOnly: boolean,
  ): LedgerActions {
    if (!isLegalContainerId(type as ContainerType, itemId)) {
      return { edit: false, retry: false, removeLocal: true, rebuild: true, proposeRemove: false };
    }
    if (state === 'sent') {
      return { edit: true, retry: false, removeLocal: false, rebuild: false, proposeRemove: true };
    }
    return { edit: true, retry: !localOnly, removeLocal: true, rebuild: false, proposeRemove: false };
  }
  ```

- [ ] **Step 4: 跑测试确认通过**

  Run: `npx vitest run src/core/my-created.test.ts`
  Expected: 全绿。

- [ ] **Step 5: Commit**

  ```powershell
  git add apps/mobile/src/core/my-created.ts apps/mobile/src/core/my-created.test.ts
  git commit -m "feat: 台账失败行出路矩阵与列表删除判据（纯函数）" -m "册子 #61 §4.2：id 非法优先级最高；删除判据只增不减"
  ```

---

### Task 7: 两个编辑页接线（Bug2 修 + 封面预览 + 复建 + 课时解码）

**Files:** Modify `apps/mobile/src/pages/course/edit.vue`；Modify `apps/mobile/src/pages/lesson/edit.vue`

> 本任务无 vitest 覆盖（`.vue` 页面层），验收依赖 Task 10 的 `vue-tsc` + 模板 `.value` 硬检查 + 真机 AC 7–9/13。

- [ ] **Step 1: `pages/course/edit.vue` —— 模板加封面预览** —— 把封面字段块（`edit.vue:16-22`）替换为：

  ```html
      <view class="field">
        <text class="label">封面</text>
        <view class="row">
          <text class="val">{{ form.cover === '' ? '未设置' : form.cover }}</text>
          <text class="act" @click="pickCover">{{ form.cover === '' ? '选择图片' : '更换' }}</text>
        </view>
        <image v-if="coverPreview" :src="coverPreview" mode="widthFix" class="cover-preview" />
      </view>
  ```

- [ ] **Step 2: `pages/course/edit.vue` —— import 补齐** —— 把三条 import 改为：

  ```ts
  import { loadContainerForm, saveContainer, startNewCourse, uploadAndStoreBlob, type ChildRow, type ContainerForm } from '../../core/course-edit';
  import { containerFormFromLedger } from '../../core/my-created';
  import { bytesToBase64, pickLocalFile, type PickedFile } from '../../platform/uni';
  ```

  （原 `import { uploadBlob } from '../../core/blob';` 整行**删除**——本页不再直接用 `uploadBlob`；原 `import { pickLocalFile, type PickedFile } from '../../platform/uni';` 整行被上面第三条替换。）

- [ ] **Step 3: `pages/course/edit.vue` —— 新增 `coverPreview` ref** —— 在 `const busy = ref(false);` 之后插入：

  ```ts
  /** 封面预览 src：刚上传 = 内存 dataURL，重进页 = 本地 `file://` 路径（册子 #61 §5）。 */
  const coverPreview = ref('');
  ```

- [ ] **Step 4: `pages/course/edit.vue` —— `onLoad` 整段替换**（`edit.vue:204-234`）：

  ```ts
  onLoad(async (query) => {
    const q = (query as Record<string, string> | undefined) ?? {};
    const courseId = String(q.courseId ?? '');
    const rebuildFrom = String(q.rebuildFrom ?? '');
    try {
      ctx = await bootstrap();
      caps.value = ctx.capabilities;
      pickRepo = ctx.repo;
      if (rebuildFrom !== '') {
        // 复建（册子 #61 §4.3）：内容照搬台账行，身份换成新 id —— 坏 id 不可救时的唯一出路。
        const row = await ctx.repo.getSubmission(rebuildFrom);
        if (row) {
          const rebuilt = containerFormFromLedger(row);
          rebuilt.itemId = startNewCourse().itemId;
          form.value = rebuilt;
        }
      } else if (courseId !== '') {
        isEdit.value = true;
        form.value = await loadContainerForm(ctx.repo, courseId, 'course');
      }
      durationMin.value = form.value.durationSec > 0 ? String(Math.round(form.value.durationSec / 60)) : '';
      categoryInput.value = form.value.category;
      // 封面回显（册子 #61 §5）：与详情页取键逐字一致（`<itemId>/cover`）
      const coverFile = await ctx.repo.findBlobPathByItem(`${form.value.itemId}/cover`);
      coverPreview.value = coverFile ? (coverFile.startsWith('file://') ? coverFile : `file://${coverFile}`) : '';
      const items = await ctx.repo.listItems();
      lessonTitles.value = Object.fromEntries(items.map((i) => [i.itemId, i.title || i.itemId]));
      categoryAll.value = splitCategories(items).map((c) => {
        const slug = c.itemId.replace(/^category\//, '');
        return { slug, label: c.title || slug };
      });
      // 治理者身份按 #23 名册实时派生；联网失败一律按作者档（4 种），不阻塞编辑
      try {
        const o = { adapters: ctx.opts.adapters, repo: ctx.repo, nodeBaseUrl: ctx.opts.nodeBaseUrl };
        const myId = await myIdentityId(o);
        const list = await roster(o);
        isGovernor.value = myId !== '' && list.some((c) => c.id === myId);
      } catch {
        isGovernor.value = false;
      }
    } catch (e) {
      error.value = (e as Error).message;
    }
  });
  ```

- [ ] **Step 5: `pages/course/edit.vue` —— `logFail` + 上传两函数整段替换**（`edit.vue:281-325`，即 `logFail` / `uploadOne` / `pickCover`）：

  ```ts
  /** 失败落本地日志（`workDir/edit-surface.log`）；取消不落，日志写失败静默不影响主流程。 */
  async function logFail(stage: 'pick' | 'upload', e: unknown) {
    if (!ctx) return;
    // 适配器在 `ctx.opts.adapters`（`AppContext` 没有 `adapters`）——写错会二次抛错掩码真实失败（册子 #61 §3）
    await recordEditFailure(ctx.opts.adapters.fs, ctx.opts.workDir, stage, String((e as Error)?.message ?? e));
  }

  /** 选文件（取消 → null）；pick 阶段失败落日志并原样抛出。 */
  async function pickFile(): Promise<PickedFile | null> {
    try {
      return await pickLocalFile();
    } catch (e) {
      await logFail('pick', e);
      throw e;
    }
  }

  /** 上传 + 落盘 + 登记（册子 #61 §5）；失败落 upload 阶段日志并原样抛出，成功返回 blob_id。 */
  async function storeBlob(slot: string, picked: PickedFile): Promise<string> {
    const { opts, repo } = await bootstrap();
    try {
      const up = await uploadAndStoreBlob(
        { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl, workDir: opts.workDir },
        form.value.itemId,
        slot,
        { name: picked.name, bytes: picked.bytes },
      );
      return up.blobId;
    } catch (e) {
      await logFail('upload', e);
      throw e;
    }
  }

  async function pickCover() {
    if (!canPick.value) {
      error.value = pickBlocked.value;
      return;
    }
    error.value = '';
    try {
      const picked = await pickFile();
      if (!picked) return;
      // 立即出缩略图（册子 #61 §5）：内存 dataURL，不必等落盘或节点返回
      coverPreview.value = `data:image/*;base64,${bytesToBase64(picked.bytes)}`;
      form.value.cover = await storeBlob('cover', picked);
    } catch (e) {
      // 日志已由 pickFile / storeBlob 按阶段落盘，此处只出人读文案（避免同一失败写两行）
      error.value = (e as Error).message;
    }
  }
  ```

- [ ] **Step 6: `pages/course/edit.vue` —— `addAttachment` 整段替换**（`edit.vue:327-341`）：

  ```ts
  async function addAttachment() {
    if (!canPick.value) {
      error.value = pickBlocked.value;
      return;
    }
    error.value = '';
    try {
      const picked = await pickFile();
      if (!picked) return;
      const blobId = await storeBlob('attachment', picked);
      // 内容寻址：同 blob 只留一行（重复上传同一文件不该出现两条附件行）
      if (!form.value.attachments.some((a) => a.blobId === blobId)) {
        form.value.attachments.push({ blobId, name: picked.name });
      }
    } catch (e) {
      // 同 pickCover：日志只在 pickFile / storeBlob 一处落，这里只出文案
      error.value = (e as Error).message;
    }
  }
  ```

- [ ] **Step 7: `pages/course/edit.vue` —— 样式补一条** —— 在 `<style>` 的 `.card { ... }` 之前插入：

  ```css
  .cover-preview { width: 180px; margin-top: 8px; border-radius: 6px; }
  ```

- [ ] **Step 8: `pages/lesson/edit.vue` —— 模板加封面预览** —— 把封面字段块（`lesson/edit.vue:56-62`）替换为：

  ```html
      <view class="field">
        <text class="label">封面</text>
        <view class="row">
          <text class="val">{{ form.cover === '' ? '未设置' : form.cover }}</text>
          <text class="act" @click="pickCover">{{ form.cover === '' ? '选择图片' : '更换' }}</text>
        </view>
        <image v-if="coverPreview" :src="coverPreview" mode="widthFix" class="cover-preview" />
      </view>
  ```

- [ ] **Step 9: `pages/lesson/edit.vue` —— import 补齐** —— 把两条 import 改为（并删除 `import { uploadBlob } from '../../core/blob';` 整行）：

  ```ts
  import { loadContainerForm, saveContainer, startNewLesson, uploadAndStoreBlob, type ContainerForm } from '../../core/course-edit';
  import { bytesToBase64, pickLocalFile, type PickedFile } from '../../platform/uni';
  ```

- [ ] **Step 10: `pages/lesson/edit.vue` —— `coverPreview` ref** —— 在 `const busy = ref(false);` 之后插入：

  ```ts
  /** 封面预览 src：刚上传 = 内存 dataURL，重进页 = 本地 `file://` 路径（册子 #61 §5）。 */
  const coverPreview = ref('');
  ```

- [ ] **Step 11: `pages/lesson/edit.vue` —— `onLoad` 整段替换**（`lesson/edit.vue:265-295`）：

  ```ts
  onLoad(async (query) => {
    const q = (query as Record<string, string> | undefined) ?? {};
    // 先解码（册子 #61 §2.2）：跳转方传 `encodeURIComponent(courseId)`，不解码会拼出 `course%2F…/lesson/…` 的坏 id
    courseId.value = decodedId(String(q.courseId ?? ''));
    const lessonId = String(q.lessonId ?? '');
    try {
      ctx = await bootstrap();
      caps.value = ctx.capabilities;
      const repo = ctx.repo;
      pickRepo = repo;
      for (const it of await repo.listItems()) carrierTitles.set(it.itemId, it.title || it.itemId);
      if (lessonId !== '') {
        form.value = await loadContainerForm(repo, lessonId, 'lesson');
      } else if (courseId.value !== '') {
        form.value = startNewLesson(courseId.value);
      } else {
        error.value = '缺少课程 id，无法定位课时';
      }
      durationMin.value = form.value.durationSec > 0 ? String(Math.round(form.value.durationSec / 60)) : '';
      // 封面回显（册子 #61 §5）：与详情页取键逐字一致（`<itemId>/cover`）
      const coverFile = await repo.findBlobPathByItem(`${form.value.itemId}/cover`);
      coverPreview.value = coverFile ? (coverFile.startsWith('file://') ? coverFile : `file://${coverFile}`) : '';
      // 治理者身份按 #23 名册实时派生；联网失败一律按作者档（4 种），不阻塞编辑
      try {
        const o = { adapters: ctx.opts.adapters, repo, nodeBaseUrl: ctx.opts.nodeBaseUrl };
        const myId = await myIdentityId(o);
        const list = await roster(o);
        isGovernor.value = myId !== '' && list.some((c) => c.id === myId);
      } catch {
        isGovernor.value = false;
      }
    } catch (e) {
      error.value = (e as Error).message;
    }
  });

  /** 解码路由参数；坏编码回落原样（与详情页 `resolveBy` 同口径）。 */
  function decodedId(raw: string): string {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  ```

- [ ] **Step 12: `pages/lesson/edit.vue` —— 上传三函数整段替换**（`lesson/edit.vue:326-370`，即 `logFail` / `uploadOne` / `pickCover`）与 `addAttachment`（`:372-385`）：

  ```ts
  /** 失败落本地日志（`workDir/edit-surface.log`）；取消不落，日志写失败静默不影响主流程。 */
  async function logFail(stage: 'pick' | 'upload', e: unknown) {
    if (!ctx) return;
    // 适配器在 `ctx.opts.adapters`（`AppContext` 没有 `adapters`）——写错会二次抛错掩码真实失败（册子 #61 §3）
    await recordEditFailure(ctx.opts.adapters.fs, ctx.opts.workDir, stage, String((e as Error)?.message ?? e));
  }

  /** 选文件（取消 → null）；pick 阶段失败落日志并原样抛出。 */
  async function pickFile(): Promise<PickedFile | null> {
    try {
      return await pickLocalFile();
    } catch (e) {
      await logFail('pick', e);
      throw e;
    }
  }

  /** 上传 + 落盘 + 登记（册子 #61 §5）；失败落 upload 阶段日志并原样抛出，成功返回 blob_id。 */
  async function storeBlob(slot: string, picked: PickedFile): Promise<string> {
    const { opts, repo } = await bootstrap();
    try {
      const up = await uploadAndStoreBlob(
        { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl, workDir: opts.workDir },
        form.value.itemId,
        slot,
        { name: picked.name, bytes: picked.bytes },
      );
      return up.blobId;
    } catch (e) {
      await logFail('upload', e);
      throw e;
    }
  }

  async function pickCover() {
    if (!canPick.value) {
      error.value = pickBlocked.value;
      return;
    }
    error.value = '';
    try {
      const picked = await pickFile();
      if (!picked) return;
      // 立即出缩略图（册子 #61 §5）：内存 dataURL，不必等落盘或节点返回
      coverPreview.value = `data:image/*;base64,${bytesToBase64(picked.bytes)}`;
      form.value.cover = await storeBlob('cover', picked);
    } catch (e) {
      // 日志已由 pickFile / storeBlob 按阶段落盘，此处只出人读文案（避免同一失败写两行）
      error.value = (e as Error).message;
    }
  }

  async function addAttachment() {
    if (!canPick.value) {
      error.value = pickBlocked.value;
      return;
    }
    error.value = '';
    try {
      const picked = await pickFile();
      if (!picked) return;
      const blobId = await storeBlob('attachment', picked);
      if (!form.value.attachments.some((a) => a.blobId === blobId)) {
        form.value.attachments.push({ blobId, name: picked.name });
      }
    } catch (e) {
      error.value = (e as Error).message;
    }
  }
  ```

- [ ] **Step 13: `pages/lesson/edit.vue` —— 样式补一条** —— 在 `<style>` 的 `.card { ... }` 之前插入：

  ```css
  .cover-preview { width: 180px; margin-top: 8px; border-radius: 6px; }
  ```

- [ ] **Step 14: 静态自检**

  Run（cwd `apps/mobile`）: `npx vitest run`
  Expected: 全绿（页面层改动不影响既有用例）。
  Run（仓库根）: `git grep -n "ctx.adapters" -- apps/mobile/src/pages`
  Expected: 无输出。

- [ ] **Step 15: Commit**

  ```powershell
  git add apps/mobile/src/pages/course/edit.vue apps/mobile/src/pages/lesson/edit.vue
  git commit -m "fix: 编辑页日志出口字段修正 + 封面预览 + 复建分支 + 课时 id 解码" -m "册子 #61 §2/§3/§5：ctx.opts.adapters.fs；pickFile/storeBlob 拆分；rebuildFrom 复建"
  ```

---

### Task 8: 列表页删除入口 + 详情页出路矩阵接线

**Files:** Modify `apps/mobile/src/pages/course/course.vue`；Modify `apps/mobile/src/pages/course/detail.vue`

- [ ] **Step 1: `pages/course/course.vue` —— 模板删除入口判据** —— 把 `:19` 一行替换为：

  ```html
        <text v-if="canRemoveMyCreated(row)" class="act" @click.stop="removeMyCreated(row)">删除</text>
  ```

- [ ] **Step 2: `pages/course/course.vue` —— import 补 `canRemoveMyCreated`** —— 把 `:91` 一行替换为：

  ```ts
  import { buildMyCreatedView, canRemoveMyCreated, containerFormFromLedger, type MyCreatedRow, type MyCreatedType } from '../../core/my-created';
  ```

- [ ] **Step 3: `pages/course/course.vue` —— `removeMyCreated` 连带清本地乐观条目** —— 把 `:350-355` 替换为：

  ```ts
  /** 删除台账行（册子 #61 §4.3）：台账行 + 本机乐观条目一起清，否则课程列表里仍留着它。 */
  async function removeMyCreated(row: MyCreatedRow) {
    const { repo } = await bootstrap();
    await repo.removeSubmission(row.itemId);
    await repo.removeLocalContainer(row.itemId);
    await load();
  }
  ```

- [ ] **Step 4: `pages/course/detail.vue` —— 模板动作区替换** —— 把 `:18-19` 两行替换为：

  ```html
        <text v-if="canEdit" class="act" @click="openEdit">编辑本课程</text>
        <text v-if="fromLedger && actions.retry" class="act" @click="retrySubmit">{{ busy ? '重试中…' : '重试提交' }}</text>
        <text v-if="fromLedger && actions.rebuild" class="act" @click="rebuildCourse">复建为新课程</text>
        <text v-if="fromLedger && actions.removeLocal" class="act danger" @click="removeLocal">{{ busy ? '删除中…' : '删除这条记录' }}</text>
        <text v-if="canProposeRemove" class="act danger" @click="removeCourse">{{ busy ? '删除中…' : '删除本课程' }}</text>
  ```

- [ ] **Step 5: `pages/course/detail.vue` —— import 补齐** —— 把 `:53` 一行替换为：

  ```ts
  import { containerFormFromLedger, ledgerActionsOf, type LedgerActions } from '../../core/my-created';
  ```

  并在 `import { bootstrap } from '../../platform';` 之后插入：

  ```ts
  import { retrySubmission, SubmitError } from '../../core/submit';
  ```

- [ ] **Step 6: `pages/course/detail.vue` —— 新增状态与计算** —— 把 `:83` 的 `const canEdit = ref(false);` 一行替换为：

  ```ts
  const canEdit = ref(false);
  /** 「删除本课程」（既有 `remove` 提案）是否出现；台账分支按矩阵、普通入口随 `canEdit` */
  const canProposeRemove = ref(false);
  /** 台账入口标记：仅该分支启用出路矩阵动作 */
  const fromLedger = ref(false);
  /** 台账行出路矩阵（册子 #61 §4.2）：纯函数算，模板只消费 */
  const actions = ref<LedgerActions>({ edit: false, retry: false, removeLocal: false, rebuild: false, proposeRemove: false });
  ```

- [ ] **Step 7: `pages/course/detail.vue` —— 台账分支接线** —— 把 `:119` 的 `canEdit.value = row.state === 'sent';` 一行替换为：

  ```ts
        fromLedger.value = true;
        actions.value = ledgerActionsOf(form.type, row.itemId, row.state, row.localOnly);
        canEdit.value = actions.value.edit;
        canProposeRemove.value = actions.value.proposeRemove;
  ```

- [ ] **Step 8: `pages/course/detail.vue` —— 普通入口接线** —— 把 `:178` 一行替换为：

  ```ts
      canEdit.value = (await repo.getSubmission(course.itemId))?.state === 'sent';
      canProposeRemove.value = canEdit.value;
  ```

- [ ] **Step 9: `pages/course/detail.vue` —— 新增三个动作函数** —— 在 `removeCourse` 之后（`:292` 之后）插入：

  ```ts
  /** 重投这一条（册子 #61 §4.3）：成功即离开本页（台账行已转 `sent`，列表会自动去重）。 */
  async function retrySubmit() {
    if (busy.value) return;
    busy.value = true;
    error.value = '';
    try {
      const { opts } = await bootstrap();
      const out = await retrySubmission(opts, courseId.value);
      uni.showToast({ title: out.ledgerState === 'sent' ? '已提交' : out.message || '仍未成功', icon: 'none' });
      setTimeout(() => uni.navigateBack(), 600);
    } catch (e) {
      error.value = e instanceof SubmitError ? e.message : (e as Error).message;
    } finally {
      busy.value = false;
    }
  }

  /** 本地删除这一条（册子 #61 §4.3）：台账行 + 本机乐观条目一起清，否则课程列表里仍留着它。 */
  async function removeLocal() {
    if (busy.value) return;
    busy.value = true;
    error.value = '';
    try {
      const { repo } = await bootstrap();
      await repo.removeSubmission(courseId.value);
      await repo.removeLocalContainer(courseId.value);
      uni.showToast({ title: '已删除', icon: 'success' });
      setTimeout(() => uni.navigateBack(), 600);
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      busy.value = false;
    }
  }

  /** 复建为新课程（册子 #61 §4.3）：内容照搬台账行、身份在编辑页重生成。 */
  function rebuildCourse() {
    uni.navigateTo({ url: `/pages/course/edit?rebuildFrom=${encodeURIComponent(courseId.value)}` });
  }
  ```

- [ ] **Step 10: 静态自检**

  Run（仓库根）: `git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- apps/mobile/src/pages`
  Expected: 无输出（模板里不得手写 `.value`——`#30` 更正 14 的硬检查）。

- [ ] **Step 11: Commit**

  ```powershell
  git add apps/mobile/src/pages/course/course.vue apps/mobile/src/pages/course/detail.vue
  git commit -m "feat: 失败行出路矩阵接线（列表删除入口 + 详情重试/删除/复建）" -m "册子 #61 §4.2/§4.3：消费 ledgerActionsOf，sent 行仍走既有 remove 提案"
  ```

---

### Task 9: 门禁补强（`vue-tsc` 进 `typecheck`）

**Files:** Modify `apps/mobile/package.json`；Modify `apps/mobile/tsconfig.json`

- [ ] **Step 1: 装依赖** —— Run（cwd `apps/mobile`）: `npm install --save-dev vue-tsc@^2`
  Expected: `package.json` 的 `devDependencies` 出现 `"vue-tsc": "^2.x.y"` 行；`package-lock.json` 若被一并更新则**随本任务一起 add**（它是本任务产物）。

- [ ] **Step 2: 改脚本** —— 把 `apps/mobile/package.json:11` 的

  ```json
      "typecheck": "tsc --noEmit"
  ```

  替换为（**直接替换，不新增第二个脚本**）：

  ```json
      "typecheck": "vue-tsc --noEmit"
  ```

- [ ] **Step 3: 改 `include`** —— 把 `apps/mobile/tsconfig.json:12` 的

  ```json
    "include": ["src"]
  ```

  替换为：

  ```json
    "include": ["src/**/*.ts", "src/**/*.d.ts", "src/**/*.vue"]
  ```

- [ ] **Step 4: 跑门禁**

  Run（cwd `apps/mobile`）: `npm run typecheck`
  Expected: 无输出（exit 0）。
  **若翻出本册改动之外的既有 `.vue` 类型错**：按册子 §7 风险 3 退化为「只保证本册改动的 4 个 `.vue` 干净」——对该文件跑
  `npx vue-tsc --noEmit` 后手工核对输出，仅当错误落在 `pages/course/edit.vue` / `pages/lesson/edit.vue` / `pages/course/course.vue` / `pages/course/detail.vue` 时才修；**不顺手清理无关页面**，并在「执行实况」如实登记。

- [ ] **Step 5: 跑完整门禁四件套**

  Run（cwd `apps/mobile`）: `npx vitest run`
  Expected: 全绿，用例数 **只增不减**（基线 **36 文件 / 416 用例**）。
  Run（cwd `apps/mobile`）: `npm run build:h5`
  Expected: 构建成功。
  Run（仓库根）: `git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- apps/mobile/src/pages`
  Expected: 无输出。

- [ ] **Step 6: Commit**

  ```powershell
  git add apps/mobile/package.json apps/mobile/tsconfig.json apps/mobile/package-lock.json
  git commit -m "chore: mobile 门禁补 vue-tsc（typecheck 覆盖 .vue）" -m "册子 #61 §6：tsc 不解析 .vue，Bug2 这类不存在的字段由此穿闸"
  ```

  （若 `package-lock.json` 未被改动，则从 `git add` 列表中去掉它。）

---

### Task 10: 版本号、文档登记与四步发布

**Files:** Modify `apps/mobile/src/manifest.json`；Modify `docs/README.md`

- [ ] **Step 1: 版本号** —— 把 `apps/mobile/src/manifest.json:5-6` 替换为：

  ```json
      "versionName" : "0.20.1",
      "versionCode" : "26",
  ```

- [ ] **Step 2: 文档登记** —— 在 `docs/README.md` 的文档清单表末尾（`#61` 行即 `:87` 之后）插入一行，列结构与 `#61` 行逐字对齐（`# / path / 描述 / 不做 / 依赖 / 状态`）：

  ```markdown
  | 62 | `plans/2026-10-01-base-container-edit-deadend-fix-plan.md` | **A 主线第 10 册（缺陷批次）实施计划**（Task 1–10：`loadContainerForm` 下沉参数解码（私有 `resolveId`：先原样后 `decodeURIComponent`，以命中真实 id 覆盖 `form.itemId`）、`isLegalContainerId` 容器 id 形态判据、`uploadAndStoreBlob`（上传 + 落 `${workDir}/blobs/<blobId>` + `addBlob('<itemId>/<slot>')`）、`LocalRepo.removeLocalContainer`（`DELETE segments` + `DELETE items ... AND source='local'` 守卫）、`core/submit.ts` 的 `retrySubmission`（复用归一化重建与 `submitItem`，暂时失败不动台账状态）、`my-created.ts` 的 `canRemoveMyCreated` / `ledgerActionsOf` 纯函数、两个编辑页接线（日志出口 `ctx.opts.adapters.fs` + `pickFile`/`storeBlob` 拆分 + 封面预览与回显 + `?rebuildFrom=` 复建 + 课时 `courseId` 解码）、列表页删除入口放宽 + 详情页出路矩阵接线、门禁补 `vue-tsc`（`typecheck` 直接替换为 `vue-tsc --noEmit` + `tsconfig.json` 补 `.vue` include）、版本 `0.20.1`/`26` 与四步发布）；含开工前已核实的现状表（含真实行号）、**本计划的工程决策 13 条**、文件结构两表与不改动硬边界清单 | 见册子 #61 的「不做」表 | 册子 #61、`#40`（容器字段模型与编辑面）/ `#56`（本地乐观落库 + 台账 + 自愈迁移）/ `#60`（行集预检 / 选文件探针 / `toPlusUrl` / 免票删除） | 已出（实施计划；Task 1–10） |
  ```

- [ ] **Step 3: §5 当前阶段追加** —— 在 `docs/README.md` 的 `#61` 那一条（`:131`）末尾、句号之前追加一句：

  ```markdown
  **实施计划 #62 已出**（`plans/2026-10-01-base-container-edit-deadend-fix-plan.md`，Task 1–10；登记为文档清单表第 #62 行）。
  ```

- [ ] **Step 4: 门禁全跑（发布前）**

  Run（cwd `apps/mobile`）: `npx vitest run`
  Expected: 全绿，用例数只增不减。
  Run（cwd `apps/mobile`）: `npm run typecheck`
  Expected: 无输出。
  Run（cwd `apps/mobile`）: `npm run build:h5`
  Expected: 构建成功。
  Run（cwd `apps/mobile`）: `npm run build:app`
  Expected: 构建成功。
  Run（仓库根）: `git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- apps/mobile/src/pages`
  Expected: 无输出。
  Run（仓库根）: `git diff --stat -- internal/`
  Expected: **无输出**（本册零节点改动，故不交叉编译、不部署节点二进制）。

- [ ] **Step 5: Commit + push**

  ```powershell
  git add apps/mobile/src/manifest.json docs/README.md
  git commit -m "chore: 版本 0.20.1/26 并登记计划 #62" -m "仅动 apps/mobile，零节点改动"
  git push
  ```

- [ ] **Step 6: 四步发布（沿用既有口径，一气呵成）**

  1. HBuilderX `cli pack` 云打包（产物核对以**包内** `version.name=0.20.1` / `version.code=26` 为准，不看构建目录）。
  2. 上传 `/opt/appdl/base-0.20.1.apk`（核对远端 sha256 与本地逐字一致）。
  3. `/opt/appdl/index.html` **整页重写**改指 0.20.1（不得残留 `0.20.0`）。
  4. 服务器上 `based release` 签发落 `/opt/base-cache/data/release.json`（确认无游离副本）。
  5. 线上核对：`GET /v1/release` → `0.20.1`（`apk_size` / `apk_sha256` 逐字一致）、`HEAD /dl/base-0.20.1.apk` = 200（`Content-Length` 与本地一致）。
  6. 只读探活无回归：`/v1/comment` → 200、`/v1/proposal` → 200、`POST /v1/blob` → 400、`/v1/blobzzz` → 404。
  7. 记录 APK 字节数 / sha256 / 证书 SHA1（应与 0.6.0–0.20.0 一致，可覆盖安装）到本计划文末「执行实况」。

  证据（APK 大小 / sha256 / 证书 SHA1 / 线上 `GET /v1/release` 与 `HEAD /dl/...` 原文）全部回填到文末「执行实况」，**不落仓库产物**。

---

## 自检（写完计划后已核）

**1. 册子覆盖：** §2 → Task 1（`resolveId` 下沉）+ Task 7 Step 11（`startNewLesson` 调用点先解码）；§3 → Task 7 Step 5/12（`ctx.opts.adapters.fs`）；§4.2 → Task 6（两个纯函数）+ Task 8（两个页面接线）；§4.3 → Task 4（删除）+ Task 5（重试）+ Task 7 Step 4（复建）+ Task 2（id 判据）；§5 → Task 3（`uploadAndStoreBlob`）+ Task 7 Step 1/3/4/8/10/11（预览与回显）；§6 → Task 9；§9 → Task 10。**无遗漏**。

**2. 占位符扫描：** 无 TBD / TODO / 「类似 Task N」；每个改代码的步骤都给了完整替换文本与确切行号。

**3. 类型一致性：** `resolveId`（Task 1 私有）/ `isLegalContainerId`（Task 2 导出，Task 6 复用）/ `PickedBytes`、`BlobStoreOptions`、`uploadAndStoreBlob`（Task 3 导出，Task 7 复用）/ `removeLocalContainer`（Task 4，Task 7/8 复用）/ `retrySubmission`、`LOCAL_ONLY_REASON`（Task 5，Task 8 复用）/ `canRemoveMyCreated`、`ledgerActionsOf`、`LedgerActions`（Task 6 导出，Task 8 复用）——**签名与命名在定义处与使用处逐字一致**。

---

## AC 对照（册子 §8）

| AC | 内容 | 落点 |
|---|---|---|
| 1 | 编码 id 能回填、`form.itemId` 为解码后合法 id | Task 1 Step 1 第 1 例 |
| 2 | 不存在 / 非法 id 仍得空表单、不抛 | Task 1 Step 1 第 3、4 例 |
| 3 | `isLegalContainerId` 正反例 | Task 2 Step 1 |
| 4 | `retrySubmission` 三态 + 不改三态语义 | Task 5 Step 1 |
| 5 | `removeLocalContainer` 清两表 + `source!='local'` 守卫 | Task 4 Step 1 |
| 6 | 门禁全绿 + 模板 `.value` 硬检查无输出 | Task 9 Step 5、Task 10 Step 4 |
| 7 | 真机 1：编辑已有课程 → 标题 / 简介 / 封面 / 课时清单全部回填 | Task 1 + Task 7（真机） |
| 8 | 真机 2：选封面 → 立即出缩略图；退出再进仍在 | Task 3 + Task 7 Step 1/4/5 |
| 9 | 真机 3：改完保存成功，不再 400 | Task 1 |
| 10 | 真机 4：失败行详情页出现 编辑 / 重试 / 删除 | Task 6 + Task 8 |
| 11 | 真机 5：删除该失败行 → 「我创建的」与课程列表都消失 | Task 4 + Task 8 Step 3/9 |
| 12 | 真机 6：id 非法行复建为新课程成功，新 id 合法 | Task 2 + Task 7 Step 4 + Task 8 Step 9 |
| 13 | 真机 7：若选图仍失败 → `edit-surface.log` 有 `stage` + `detail` 原文 | Task 7 Step 5/12（真机取证，判读口径见册子 §7 风险 1） |
| 14 | `uploadAndStoreBlob` 落盘 + `findBlobPathByItem('<itemId>/cover')` 可回取 | Task 3 Step 1 |
| 15 | 删除入口只增不减 | Task 6 Step 1 |

---

## 执行实况

（执行时逐 Task 回填：commit 哈希、用例数、门禁原文、APK 字节数 / sha256 / 证书 SHA1、线上核对原文、执行期更正。**待填**。）
