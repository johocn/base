# base 编辑面修复设计（A 主线 第 5 册）

- 日期：2026-09-30
- 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`；直接上游 = `#40`（字段模型与编辑面）、`#44`（渲染口径边界）、`#45`（App 实测批次编排）
- 范围：**F3**（App 里图片 / 附件加不上：诊断三件套 + 预置双分支）+ **F4**（添加载体支持关键词搜索 + 点选，候选源 = 本机已下载条目）
- 本册子**不覆盖**：正文渲染与编辑器工具栏（`#44` / 计划 `#48`）；课程分类入口（`#49`）；治理可见性（`#51`）；图章与标题高亮（`#53`）；视频 / 音频播放器；正文内嵌图片上传面；iOS

## 0. 改版说明

### 0.1 2026-09-30 初版

**新增（本册子首次定义）：**

- **F3 诊断三件套**（§2）：运行时能力探测（接入既有自检能力标志体系）+ 可读错误（`error` 区出人读文案，不再静默）+ 本地日志（原始错误串落盘，供真机取证）。
- **F3 预置双分支**（§3）：App 支走**相册 / 拍照类 API**，H5 支走 `uni.chooseFile`，运行时探测决定走哪一支。
- **F4 载体候选源契约**（§4）：候选源 = `LocalRepo` 本机已下载条目，**零新 HTTP 接口**；关键词搜索 + kind 过滤 + 点选回填 `itemId` / `kind` 与只读标题。
- **真机复现步骤**（§2.4）：三种结局的判读口径（**根因待真机复测，本册不写根因**）。

**明确沿用、不改动：** `POST /v1/blob` 上传协议（单块 multipart、字段名 `file`、上限 8 MiB、内容寻址幂等，`#40 §3`）；`#40 §2.1` 槽位表与 `#40 §2.4` 载体 kind（course 收 `lesson`；lesson 收 `article` / `video` / `audio` / `quiz`）、`seq<0` 分配规则、两条哈希口径；`LocalRepo` 方法语义与 `items` / `segments` 表结构；自检「**只有明确 `fail` 才降级**」（`core/selfcheck.ts:24-30,53-67`）；编辑面「新建 + 编辑同页两模式」与表单 → 行集 → 台账 `my_submissions` 写路径（`#40 §4.1 / §6`）。

## 1. 范围与不做什么

| 做 | 不做 |
|---|---|
| F3：`pick.*` 探测计入能力标志，结果在「设置 → 基座自检」可读 | 不做「根因已定位」的断言——F3 根因**待真机复测** |
| F3：选文件 / 读文件 / 上传三段失败出人读文案进 `error` 区 | 不改取消行为（用户主动取消仍**静默返回**） |
| F3：三段失败的原始错误串追加落本地日志 | 不做日志上报接口 / 加密 / 自动清理调度；不假定 `uni.chooseFile` 在 App 端可用（§3） |
| F3：`pickLocalFile()` 预置双分支（App 相册 / 拍照；H5 `chooseFile`） | 零新 HTTP 接口；不改 `#40 §2.1` 槽位语义与 `buildContainerSegments` 的 seq 口径 |
| F4：候选源 = 本机已下载条目 + 关键词搜索 + kind 过滤 + 点选回填 | 不做远程搜索；不新建候选表；不做播放器；不做正文内嵌图片上传面（归 `#44`） |
| F4：取代 `lesson/edit.vue` 的 `addCarrier()` 与 `course/edit.vue` 课时清单的手填 | 不做 iOS；不改内容包规范 v1 |

**批次硬约束（沿用 `#45 §4`）：** 不改内容包规范 v1、不 bump `schema_version`、不新增 `source` / `type` 枚举值、不加配置项、**零新 HTTP 接口**、不改 `#40` 槽位语义与两条哈希口径。

## 2. F3 诊断契约

### 2.1 运行时能力探测

- **入口**：`platform/uni.ts` 新增导出 `pickHandle(): PickHandle`（`{ chooseFile?: unknown; chooseImage?: unknown }`，取自 `uni` 全局）——与既有 `plusRuntime()`（`uni.ts:115-117`）同一手法：`core/*` 只依赖注入句柄，不 import `'uni'`。
- **两条探测项**：新增进 `core/selfcheck.ts` 的 `PROBES`（`scope: 'standalone'`，与 `net.open_url`（`:311-321`）同形）——`pick.choose_file` 判 `typeof h.chooseFile === 'function'`、`pick.album` 判 `typeof h.chooseImage === 'function'`；两条均计入新标志 `pickOk`。
- **标志扩展**：`CapabilityFlags`（`:17-22`）增一员 `pickOk`，同步 `UNKNOWN_FLAGS`（`:25-30`）与 `FLAG_KEYS`（`:32`）；聚合逻辑（`:409-423`）零改动照用。新增 `canPickFile(flags)`（`pickOk !== 'fail'`）与 `pickBlockedReason(flags)`，与既有 `canPostComment` / `postBlockedReason`（`:53-62`）同形。
- **时机**：① 启动——`platform/index.ts` 的 `bootstrap()` 在 `capabilities` 初始化处（`:34-46`）一并判定（同步 `typeof`，零 IO）；② 进编辑页——`onLoad` 再判一次写入页面局部状态（防 bootstrap 缓存过期），失败原因同时落日志（§2.3）。`pickOk === 'fail'` 时编辑页禁用「选择图片 / 添加附件」并原位显示 `pickBlockedReason`；`unknown` / `ok` 照常尝试。

### 2.2 可读错误

三段失败各有固定文案出口，一律写入页面既有 `error` 区（`course/edit.vue:75-77`、`lesson/edit.vue:92-93`）：**选择文件**用 `pickLocalFile()` 抛出的 `Error.message`（`uni.ts:459,476`，如「当前运行时不支持选择文件」）；**读文件**用 `PlusFs.readFile` 的 `Error.message`（`uni.ts:331-345`）；**上传**用 `BlobError.message`（`core/blob.ts:23-31,51-91`，如「文件超过 8 MiB」）——三者均**原样展示**，不另造文案。**硬规则**：非取消失败**必须**有文案，禁止静默；取消（返回 `null`）**不写 `error`、不写日志**；页面 `catch` 在写 `error` 的同时调日志出口。

### 2.3 本地日志

- **出口**：`core/editlog.ts` 新增 `recordEditFailure(fs, workDir, stage, detail)`，只依赖注入的 `FsAdapter`，**不 import `'uni'`**。
- **路径与格式**：`${workDir}/edit-surface.log`（`workDir` = `bootstrap().opts.workDir`，即 `_doc/base`）；JSON Lines，`{"at":"<ISO>","stage":"<pick|read|upload>","detail":"<原始串>"}`。
- **写入**：`FsAdapter` 无 append，故「读旧 → 拼接 → 整文件写回」；单文件上限 **64 KiB**，超限**从头部截断**保留尾部。
- **静默失败**：写失败**不得**抛给页面（否则日志自身成为新故障点），`error` 区仍如实展示原始错误。
- **取证入口**：自检页新增一段**只读**「编辑面日志」（读尾部 ≤ 4 KiB），与真机文件管理器路径互为备份。

### 2.4 真机复现步骤

1. 装本批次包（`0.16.0` / `21`），进「设置 → 基座自检」，记 `pickOk` 与 `pick.*` 两条的 `status` + `detail`。
2. 课程页 → 新建课程 → 点「选择图片」（`course/edit.vue:17-22`），记：弹的是**系统相册** / **文件选择器** / **无反应**，以及 `error` 区文案；附件重复一次（「+ 添加附件」，`course/edit.vue:47-55`）。
3. 若失败，取 `${workDir}/edit-surface.log`（或自检页「编辑面日志」），把 `stage` + `detail` 原文带回。

判读：`stage=pick`（选择器不弹）⇒ 该平台无对应选文件 API，按 §3 换支；`stage=read`（弹出但拿不到字节）⇒ `PlusFs.readFile` 路径问题（临时路径未被 `toPlusUrl` 认下，`uni.ts:264-268`）；`stage=upload`（读到字节但上传失败）⇒ `POST /v1/blob` 侧（签名 / 上限 / 网络），看 `BlobError.code`。

## 3. F3 预置双分支

`pickLocalFile()` 内**先探测后分支**（禁止按编译期常量写死某一支）：

- **App 支**：有 `plus` 运行时且 `typeof chooseImage === 'function'` ⇒ `uni.chooseImage({ count: 1, sourceType: ['album','camera'] })` 取 `tempFilePaths[0]`。
- **H5 支**：无 App 支能力且 `typeof chooseFile === 'function'` ⇒ 现状逻辑（`pickLocalFile()`，`uni.ts:457-483`）。
- **都不可用**：两者皆非函数 ⇒ 抛 `Error('当前运行时不支持选择文件')`（既有文案）。

**关键约束**：`UniGlobal.chooseFile` 在 `platform/uni.ts:88-96` 是**可选声明**（`chooseFile?`），注释称「App 端 3.4.0+ 提供」——故**不能假定它在 App 端可用**；App 支存在的理由正是「App 端可能取不到 `chooseFile`」。

**两支汇流**：都产出同一 `PickedFile`（`{ name, bytes }`，`uni.ts:446-450`），字节读取复用 `PlusFs.readFile`（`uni.ts:331-345`）——**选文件层唯一、读字节层唯一**，页面 `uploadOne`（`course/edit.vue:127-138` / `lesson/edit.vue:148-158`）零改动即可切支。**上传协议不动**：仍走 `uploadBlob`（`core/blob.ts:51-91`，`MAX_BLOB_BYTES = 8 << 20`）。

## 4. F4 载体候选源契约

### 4.1 候选源与过滤

- **候选源 = `LocalRepo.listItems()`**（本机已下载条目，`repo.ts:17-26`）——**零新 HTTP 接口**、零新表。
- **过滤链**：`state === 'active'`（`ItemRow.state`，`core/types.ts:1-11`）→ 按 **kind** → 按**关键词**。
- **kind 口径**（照抄 `#40 §2.4`）：**course 的载体 kind 为 `lesson`**；**lesson 的载体 kind 为 `article` / `video` / `audio` / `quiz`**。
- **标题**：`getItem(itemId)?.title`（`repo.ts:23`）；查不到或空串时**回落显示 `itemId`**。

### 4.2 查询与回填

新增 `core/carrier-pick.ts`（不 import `'uni'`，可在 Node 下用 `core/fakes.ts` 测试），导出 `CarrierCandidate { kind; itemId; title }` 与 `listCarrierCandidates(repo, kinds, keyword): Promise<CarrierCandidate[]>`。

- 实现：`listItems()` → `active` → kind ∈ `kinds`（**kind 由条目 `type` 派生**：`type === 'lesson'` ⇒ `lesson`，其余按 `type` 直取）→ 关键词大小写不敏感子串匹配（`itemId` **或** `title`）→ 按 `itemId` 升序。空关键词 = 不过滤（供「浏览即选」）。
- **点选即回填**：`form.children` 推入 `ChildRow { kind, itemId }`（`course-edit.ts:41-45`），行内**只读回显**标题；`kind` 来自候选行，**不由用户手填**；同 `itemId` 已在 `form.children` 中则不再推入（与附件去重同向，`course/edit.vue:154-155`）。

### 4.3 取代现状

- `pages/lesson/edit.vue:184-188`：`addCarrier()` 只 push 一个 `itemId` 可空的 `ChildRow`（**无搜索无点选**）⇒ 改走「搜索候选 → 点选 → 回填 `kind` + `itemId` + 只读标题」；`lesson/edit.vue:78-87` 的 kind chips 手点与 `itemId` input 手填下线或降级为只读展示。
- `pages/course/edit.vue:60,166-171`：**保留**「+ 加一课」新建入口（生成新 id 并跳转课时编辑页），**新增**「选已有课时」走同一选择器（kind = `lesson`）；`lesson/edit.vue:215-219` 的「空 id 拦下」校验保留。

## 5. 已知边界（登记，不在本册修）

1. **F3 根因未定**：`uni.chooseFile` 在 App 端是否提供**无法静态判定**（`uni.ts:88-96` 为可选声明）；真机复测前**不得**认定任一支正确。
2. **H5 端仅用于界面预览**：H5 无 `plus`，`assertAppRuntime()`（`uni.ts:126-132`）抛可读提示，H5 支主要服务预览。
3. **日志 64 KiB 上限会丢早期行**（取证优先「最近一次」）；**候选集只含本机已下载条目**——未同步条目不可选，F4「零新接口」的直接代价（明确取舍）。
4. **`audio` 候选可选但不可放**：选中后课时页仍走「暂不支持的类型」降级（`#40 §2.4`），须在提示文案里说清。
5. **正文内嵌图片仍无上传面**（归 `#44`；本册封面 / 附件是**条目级**槽位）；**iOS 不在范围**。

## 6. 验收

| AC | 内容（方式） |
|---|---|
| 1 | 能力探测：`pick.*` 两条进自检报告，`pickOk` 按「任一条 fail ⇒ fail、全 skip ⇒ unknown」聚合；`canPickFile` / `pickBlockedReason` 覆盖三态（vitest） |
| 2 | 双分支：无 `chooseFile` 走相册 / 拍照支、无 `chooseImage` 走 `chooseFile` 支、皆无时抛既有可读文案；**取消返回 `null` 不产 `error`**（vitest + 真机） |
| 3 | 可读错误：pick / read / upload 三段失败各一例断言 `error` 文案非空、非取消不静默（vitest + 真机） |
| 4 | 本地日志：一次失败在 `${workDir}/edit-surface.log` 追加一行 JSON Lines；超 64 KiB 头部截断；写失败不抛（vitest + fakes） |
| 5 | 真实取证：真机按 §2.4 走一遍，日志能定位到 `stage`（**允许**结论为「需换支」或「待进一步定位」，不要求本册给出根因）（真机） |
| 6 | F4 候选源：kind 过滤正确（course ⇒ `lesson`；lesson ⇒ 四 kind）、关键词命中 `itemId` 或 `title`、`active` 过滤、`itemId` 升序（vitest） |
| 7 | F4 回填：点选后 `children` 得 `{ kind, itemId }`、只读标题回显、查不到回落 `itemId`、同 id 去重（vitest + 真机） |
| 8 | 零新接口：只调 `LocalRepo` 与既有 `POST /v1/blob` / `POST /v1/submit`，无新增 HTTP 路由（代码审阅） |
| 9 | 门禁：Go `build` / `vet` / `test` 全绿；mobile `vitest run`（≥ 23 文件 / 230 用例，只增不减）/ `tsc --noEmit` 干净 / `build:h5` 通过；`acceptance-d.ps1` 全 PASS；模板 `.value` 硬检查无输出（命令） |

## 7. 版本与发布

- **本册不单独发布**：F3 + F4 随 `#45` 批次**单次发布** `0.16.0` / `21`（基线 `0.15.0` / `20`）；版本号与发布四步以 `#45 §5` / `§6` 为准，本册**不改写口径**。**节点侧**：本册只动手机端，**不动节点二进制**。
- **发布前硬检查**：`apps/mobile/src/pages/*/*.vue` 不得出现 `.value` 模板写法（`grep -nE '="[^"]*\.value|\{\{[^}]*\.value'` 必须无输出），并保留 `build:app` 产物 `\.value\.value` 计数为 0 的硬检查。

## 8. 文档登记与上游回填

- 本文档登记为 `docs/README.md` 第 **46** 行，配套实施计划为第 **47** 行；三处已同步：§3 清单行、§4「A 主线续册」批次分支、§5「当前阶段」立册条目与「下一步」。
- **上游回填结论**：`#40 §2.1 / §2.4 / §3` 经核对**无缺口不改**（F4 只读 `LocalRepo`，F3 不改上传面）；`#44` **无冲突**（不碰 `attr.body_md` 与渲染管线）；`#45 §4` 文件结构表已一致。仅需 `#40 §6` 补一处**指向**（编辑面选文件诊断与载体选择归 `#46`），由计划 Task 9 登记。

## 9. 风险点

1. **F3 根因误判**（最大风险）：把「选择器不弹」当成「上传失败」会修错地方。防线是 §2.1 的三段探测与 §2.3 的 `stage` 字段——**先取证再动手**。
2. **双分支路径形态不一致**：`chooseImage` 给相册临时路径（`file://` 或平台路径），`chooseFile` 给 `_doc` 相对路径；`toPlusUrl`（`uni.ts:264-268`）只认 `_doc` 前缀 ⇒ App 支须实测路径形态，必要时补 `file://` 归一——**未实测前不改读取实现**，先落日志取证。
3. **日志成为新故障点**：出口**必须全静默**且单文件有上限；**候选源为空时的体感**：本机未同步过条目时列表为空，必须给空态文案（「本机还没有可选的条目，先同步内容包」）。
4. **能力标志扩员的连带**：`CapabilityFlags` 增 `pickOk` 会改 `FLAG_KEYS` / `UNKNOWN_FLAGS` / 聚合表 / 既有单测；**只加不改**既有四标志语义，`canSync` / `canPostComment` 判据一字不动。