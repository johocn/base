# base 运行路径落盘根与存量台账自愈设计（A 主线 第 11 册 · 缺陷批次）

- 日期：2026-10-01
- 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`；直接上游 = `#56`（创作者可见性闭环：本地乐观落库 + 台账三态 + 一次性自愈迁移）、`#60`（选文件能力探针 / `toPlusUrl` 的 `file://` 处理 / 免票删除）、`#61`+`#62`（容器编辑与失败行出路，已发布 `0.20.1`/`26`）
- 范围：`0.20.1` 真机复验暴露的 4 条 —— A「我创建的」课程无法删除（报「本地缺少该条目的内容哈希」）、B 编辑课程时课程名不回填、C 上传图片报「建目录失败 / code:15」、D 添加课时提交 HTTP 400
- 本册**不覆盖**：节点侧任何契约（`POST /v1/submit` 的校验顺序与错误码、治理门槛、名册）；内容包规范 v1；目录治理（`#58`）；其余页面的路径改写；iOS

## 0. 改版说明

### 0.1 2026-10-01 初版

**新增（本册首次定义）：**

- **落盘根候选链 + 实做式探测**（§3.2）：`PlusFs.rootDir()` 由「固定 `_doc/base`」改为「按候选链**实做一次**建子目录 → 写 1 字节 → 读回 → 删，首个通过者胜出并缓存」。候选 ① 取 `plus.android.runtimeMainActivity().getFilesDir()` + `/base`（应用运行路径），② 兜底现状 `_doc/base`。**DB 与 pack 随 `rootDir()` 一起落到胜出根**（用户已确认取舍，代价见 §6 风险 1）。
- **只读路径不建目录**（§3.3）：`fileEntry(path, create=false)` 下的 `dirEntry` 改用 `create:false`——读已存在文件不再 mkdir。
- **`file://` 输入不再丢 scheme**（§3.1）：`toPlusUrl` 先剥 `file://` 再统一判「能折 `_doc` 就折、否则整串 resolve」，不再把绝对路径交给 `dirEntry` 当相对路径逐段下钻。
- **存量台账自愈**（§2）：对「有 `my_submissions` 行、无 `items` 行」的容器 id，用既有 `toLocalContainer` 口径重建 `items` + `segments`；行集还原不出的落既有 `localOnly` 终态。幂等、单次启动跑一遍、独立标志位。
- **课时 400 取证与前置检查**（§4）：节点 `code` **原文**进错误文案（toast / 台账 `reason` / 编辑面日志一次贯通）；`EditStage` 增 `submit` 阶段；「加一课」入口前置检查父课程台账态。
- **自检新增明细**（§3.4）：报告新增一条「落盘根」探测，展示本次胜出路径与「建目录 / 写 / 读回 / 删」实做结果。

**明确沿用、不改动：** `#56 §2.3` 的台账行集归一化重放口径（`containerFormFromLedger` / `buildContainerSegments`）与 `#56 §2.4` 的三态 + `localOnly` 终态单向性；`#40 §2.1` 槽位表与两条哈希口径；`#58` 三态目录展示；`POST /v1/submit` / `POST /v1/blob` / `POST /v1/proposal` 全部节点契约；`my_submissions` / `items` / `segments` 表结构；`FsAdapter` 接口。

## 1. 范围与不做什么

| 做 | 不做 |
|---|---|
| §2：启动自愈，把「有台账行、无条目行」的历史数据补成本地乐观条目 | 不改台账三态语义；不给 `localOnly` 行开重试口；不清理 `source !== 'local'` 的条目行 |
| §2：自愈复用 `toLocalContainer` 的唯一哈希口径 | 不新造哈希函数、不引入新表、不做双向同步 |
| §3.1：`toPlusUrl` 对 `file://` 输入先剥 scheme，`_doc` 折算优先 | 不改 `POST /v1/blob` 单块 multipart 契约与 8 MiB 上限 |
| §3.2：落盘根候选链 + 实做探测 | 不改 `FsAdapter` 接口（唯一入口仍是 `rootDir()`）；不动 `core/*`（该层不 import `'uni'`）；零新 HTTP 接口 |
| §3.3：读路径 `create:false` | 不改写路径语义（写仍逐段 `create:true`） |
| §4：透出节点 `code` 原文 + 「加一课」前置检查 | **不预设课时 400 根因、不改节点校验、不改签名口径**；`#61` 的「编辑 / 重试 / 删除 / 复建」矩阵一字不动 |
| §5：`vue-tsc`（`#61` 已落地）继续把关 + 全门禁 | 不顺手清理无关页面的既有类型错 |

**批次硬约束（沿用 `#45 §4`）：** 不改内容包规范 v1、不 bump `schema_version`、不新增 `source` / `type` 枚举值、不加配置项、**零新 HTTP 接口**。

## 2. 缺陷 A / B：存量台账自愈

### 2.1 症状与根因（已定位）

- 症状 A：「我创建的」里点删除 → 「本地缺少该条目的内容哈希，请同步后再试」；点同步无效。
- 症状 B：进「编辑课程」，标题 / 简介 / 课时清单全空（用户自述「是有问题的数据」）。

两条同一根因：**该行只有 `my_submissions`、没有对应的 `items` 行**。数据产生于 `#56` 本地乐观落库（`upsertLocalContainer`）上线之前，属纯存量。

代码级证据：

1. 删除走 `createProposal`（`core/govern.ts:209-231`）：非 `directory_add` 分支取 `repo.getItem(itemId)?.contentHash`，不匹配 `/^(?:[0-9a-fA-F]{2})+$/` 即抛 `GovernError('client', '本地缺少该条目的内容哈希，请同步后再试')`（`govern.ts:227-229`，即用户看到的原文）。与联网无关 ⇒「同步也无效」是预期行为。
2. 编辑页回填走 `loadContainerForm`（`core/course-edit.ts:246-266`）：`repo.getItem` 与 `repo.listSegments` 都查空 ⇒ 空表单（`#61 §2` 的 id 解码已修复，本条不是解码问题）。
3. 新数据不会缺：`saveContainer`（`core/course-edit.ts:302-319`）先 `upsertLocalContainer`，`toLocalContainer`（`course-edit.ts:210-225`）已写 `contentHash = segmentsContentHash(segments)`（`repo.ts` 的 `segmentsContentHash` 与节点 `store.SegmentsContentHash` 逐字节同构）。

### 2.2 处置

在既有一次性自愈模块里**增补一轮**，不新建模块、不新建表：

- 落点：`core/creator-migrate.ts` 新增导出 `runLedgerHealMigration(o: SubmitOptions): Promise<HealResult>`；调用点与既有迁移**同一处**（`pages/course/course.vue:167-170` 旁，串行执行）。
- 扫描范围：`repo.listSubmissions()` 中 `type ∈ {course, lesson}` 的行；对每行先 `repo.getItem(row.itemId)`，**已有条目行即跳过**（幂等核心）。
- 缺则重建：`containerFormFromLedger(row)` → `toLocalContainer(form, now)` → `repo.upsertLocalContainer(item, segments)`。**哈希口径、属性行排布全部复用既有出口**，本册不新算一份。
- 还原不出行集（`segments.length === 0`，含坏 JSON / 空）：走既有 `repo.markSubmissionLocalOnly(row.itemId, '本地数据无法还原，仅本地留存')`，终态只给删除 / 复建（`#61 §4.2` 矩阵已覆盖）。
- 幂等与安全：**标志位独立**（新键 `ledger_heal_migrated`，值 = 本册版本号），不动 `creator_visibility_migrated`；**绝不抛错**，只经返回值体现（升级首启不得因迁移失败阻断）。
- 状态不改：本函数**只补 `items` / `segments`**，不触碰 `my_submissions.state` / `localOnly`；`sent` 行同样补（其内容本就该在本机可读可编辑）。

```
HealResult = { skipped: boolean; scanned: number; healed: number; localOnly: number }
```

## 3. 缺陷 C：运行路径落盘根与路径归一化

### 3.1 主因（已定位，代码级）

编辑面日志原文（`stage=pick`，目标路径 `…/Android/data/uni.app.UNI936A667/doc/uniapp_temp/compressed/…`，`code:15`，message = `targetSdkVersion设置>=29后在Android10+系统设备不支持当前路径…`，即 https://ask.dcloud.net.cn/article/36199 的原文）指向**读相册临时图**这一步，不是 `uni.chooseImage` 本身：

1. `pickLocalFile`（`platform/uni.ts:502-509`）拿到 `chooseImage` 的临时路径后调 `readFile`；
2. `readFile` → `fileEntry(path, false)` → `dirEntry(dirname)`（`uni.ts:340-349`、`323-338`）；
3. `dirEntry` 先过 `toPlusUrl`（`uni.ts:304-309`）：输入 `file:///storage/emulated/0/Android/data/<pkg>/doc/uniapp_temp/…` 命中第一分支，返回 `convertLocalFileSystemURL(path)` —— 该调用**把 `file://` scheme 剥掉**，返回 `/storage/emulated/0/Android/data/<pkg>/doc/uniapp_temp/…`；
4. `dirEntry` 因此判不出「这是绝对路径」（`url.startsWith('file://')` 为假），于是 `split('/')` 逐段下钻：第一段 `storage` 交给 `resolveLocalFileSystemURL`，之后对 `emulated`、`0`… 逐个 `getDirectory(..., {create:true})` ⇒ **在应用沙盒之外 mkdir** ⇒ 系统回 `code:15`，异常文案即 `建目录失败 <原绝对路径>/<段名>`。

对照：`_doc/base` 下的自检 fs 探测（`selfcheck` 子目录读写、1 MiB 大文件读写与删除）全绿 ⇒ DB 与 pack 本身健康，问题只在**路径形态**。

### 3.2 落盘根候选链 + 实做探测

`PlusFs.rootDir()`（`uni.ts:351-353`）由固定值改为候选链，**以实做结果定夺**：

| 序 | 候选 | 取值方式 |
|---|---|---|
| ① | `<getFilesDir()>/base` | `plus.android.runtimeMainActivity().getFilesDir().getAbsolutePath()`（应用运行路径，沙盒内） |
| ② | `_doc/base` | 现状：`${convertLocalFileSystemURL('_doc')}/base` |

- 探测动作：对候选根依次「`ensureDir(<根>/.rootprobe)` → `writeFile(…/p.bin, 1 字节)` → `readFile` 读回比对 → `remove`」，**全过即胜出**；任一步抛错即试下一候选。
- 胜出者**进程内缓存**（同一 `PlusFs` 实例不重复探测）；`rootDir()` 是唯一入口，`FsAdapter` 接口零改动。
- 候选全部失败：抛可读错误，由 `bootstrap`（`platform/index.ts:21-63`）既有路径承接（自检走降级模式）。
- `plus.android` 缺失或取值抛错（H5 / 老内核）：直接跳过候选 ①。
- 类型面：`PlusRuntime` 增可选 `android`（`{ runtimeMainActivity(): { getFilesDir(): { getAbsolutePath(): string } } }`），仅为取值用，不引 `plus` 全局。
- **DB 与 pack 随之落到胜出根**：`bootstrap` 仍用 `${root}/base.db`、`sync.ts` 仍用 `${workDir}/pack-*.sqlite`，**代码路径写法不变**；代价见 §6 风险 1。

### 3.3 读路径不建目录 + `file://` 输入归一化

- `toPlusUrl`（`uni.ts:304-309`）改为：先把输入统一成「无 scheme 的绝对路径」（`file:///x` 与 `file://x` 两种写法都剥干净并补前导 `/`），再按三分支返回：
  1. 落在 `convertLocalFileSystemURL('_doc')` 之下 ⇒ 折成 `_doc/…`（官方支持的相对形态，可安全下钻，且**不会新建目录** —— 段都已存在）；
  2. 其余绝对路径 ⇒ `file://<绝对路径>`，交 `dirEntry` **整串 resolve**，不再逐段下钻；
  3. 非绝对路径（已是 `_doc/…` 形态）⇒ 原样返回。
- `fileEntry(absPath, create)`：`create === false` 时 `dirEntry` 内部一律 `getDirectory(name, { create: false })`，失败文案为「打开目录失败」（与写路径的「建目录失败」区分）。写路径（`create === true`）语义不变。
- 二者合力后，`_doc/uniapp_temp/compressed/<file>` 形态的临时图按「折 `_doc` + 只读下钻」处理，**不产生任何 mkdir**。

### 3.4 自检明细

`core/selfcheck.ts` 的 `PROBES` 新增一条 `scope: 'local'` 探测（紧随两条 `fs.*` 之后）：

- id `fs.root`；组「文件/库」；名「落盘根可用（建目录 / 写 / 读回 / 删）」；affects「封面 / 附件上传、编辑面日志」；`flag: 'fsOk'`。
- 动作用 `c.adapters.fs` 在 `c.workDir` 下实做一次（`selfcheck-root` 子目录 + 1 字节文件），detail 给出 `c.workDir` 全路径 + 结果 ⇒ **哪条候选胜出一眼可读**（内部路径 vs `_doc` 路径）。
- **零接口改动**：沿用既有 `CheckContext.workDir`，不给 `CheckContext` 加字段。

## 4. 缺陷 D：课时 400 的取证与前置检查

### 4.1 已核实（不预设根因）

- **节点侧不存在「父课程必须已收录」的校验**：`handleSubmitPost`（`internal/httpapi/submit.go:181-352`）对 `course` / `lesson` 只判 id 形态（`containerShapeOf`）、行集（`validateSubmitSegments`）、标题（`validItemTitle`）与签名；`UpsertSegmentSubmission`（`internal/store/submission.go:113-159`）只判「同 id 已被他人占用」。
- 因此课时 400 的码域只有：`item_id_invalid` / `item_type_mismatch` / `item_segments_invalid` / `item_title_invalid` / `item_body_too_large` / `item_question_invalid` / `author_sig_invalid`（`submit.go` 各分支；文案表 `internal/httpapi/authmw.go:42-49`）。
- 客户端**现状**：`mapSubmitFailure`（`core/submit.ts:222-230`）把码经 `errorText` 映射成中文，找不到码就回「提交失败（HTTP 400）」——**码原文既不进文案也不落日志** ⇒ 真机上无法定位是哪一条。

### 4.2 处置（只取证 + 只挡「注定失败」的请求）

1. **码原文贯通**：`mapSubmitFailure` 在 `errorCodeOf(raw)` 非空时把码追加进文案，形如 `<中文提示>（<code>）`。该文案自动流经 toast（编辑页）、台账 `reason`（`writeLedger`）、「我创建的」列表与失败行，**一处改动全链路可见**。
2. **日志阶段扩展**：`core/editlog.ts` 的 `EditStage` 增 `'submit'`；两个编辑页（`pages/course/edit.vue`、`pages/lesson/edit.vue`）在保存失败分支调 `recordEditFailure(ctx.opts.adapters.fs, ctx.opts.workDir, 'submit', message)`（`ctx.opts.adapters` 是 `#61 §3` 已修正的字段）。
3. **「加一课」前置检查**：`pages/course/edit.vue` 的 `addLesson()`（`course/edit.vue:374-379`）先查父课程台账行 `repo.getSubmission(form.itemId)`：
   - 无台账行（新课程 / 已从包内同步的课程）⇒ 放行；
   - 有台账行且 `state === 'sent'` ⇒ 放行；
   - 有台账行且 `state !== 'sent'`（`pending` / `failed` / `localOnly`）⇒ **阻断**，提示「课程尚未提交成功（当前：<状态文案>）。请先保存课程，提交成功后再添加课时」。
   - 判据用既有 `statusLabelOf`（`core/my-created.ts:27-36`）取状态文案，不另造词。

**为何阻断而不是放行：** 父课程未收录时课时会成为节点上的孤立条目（节点不校验父存在，所以拦不住它）；同时这正是用户报「添加课时失败」的场景，先在入口给出可操作原因，比再发一次注定失败的请求更有信息量。**本册不宣称这就是 400 的根因**（§6 风险 2）。

## 5. 门禁与发布

- **Go**：本册零节点改动，仍跑 `go test ./...` 全包作为回归保险。
- **mobile**：既有全用例 + 本册新增用例；`vue-tsc --noEmit`（`#61 §6` 已把 `typecheck` 换成 `vue-tsc`）；`build:h5` / `build:app`。
- **版本**：`manifest.json` 升到 `versionName 0.20.2` / `versionCode 27`。
- **四步发布**（沿用 `0.20.1` 已验证口径）：HBuilderX CLI 打包 → `scp` APK 到 `/opt/appdl/base-0.20.2.apk` → 整页重写 `/opt/appdl/index.html` → `based release` 签发到 `/opt/base-cache/data/release.json`。
- **线上核对**：`GET /v1/release`、`HEAD /dl/base-0.20.2.apk`、`GET /` 三处与本地一致；证书 SHA1 与 `0.6.0`–`0.20.1` 一致（`19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`）。

## 6. 已知边界与风险

1. **落盘根搬迁会带走本地库与 pack（最大取舍，用户已确认）**：候选 ① 通过即胜出 ⇒ 升级后 `base.db` 位于应用运行路径，旧 `_doc/base/base.db` 不再被读取：节点地址（`config.node_base_url`）、台账、本地缓存、已下载 pack 需重建。**身份不受影响**（私钥在 `uni` storage，不经路径）。须在真机验收里显式覆盖「升级后重填节点地址 → 同步 → 台账恢复」。
2. **课时 400 根因仍未定**：本册只保证「码可见 + 不注定失败的前置检查」。真机复测若仍 400，按码判读：`item_segments_invalid` ⇒ 行集（回 `#40 §2.1` 三区间）；`item_id_invalid` ⇒ id 形态 / 解码；`author_sig_invalid` ⇒ 签名口径。**不得在无码的情况下猜改节点或客户端校验。**
3. **候选 ① 的路径能否被 plus.io 认下未知**：`getFilesDir()` 给出的是 Java 侧绝对路径，经 `file://` 前缀交给 `resolveLocalFileSystemURL` 是否成功，取决于内核实现——正因如此才**实做探测**；失败即退候选 ②（与现状一致，不劣化）。
4. **`toPlusUrl` 语义变更会改既有断言**：`src/platform/uni.test.ts:41` 现断言 `file:///storage/…` → `/storage/…`（丢 scheme 的当前行为）。本册改为「剥 scheme 后按 `_doc`/绝对路径重排」，该断言必然更新，属预期；改动后需补「`_doc` 可折形态」与「非 `_doc` 绝对路径整串 resolve」两条用例。
5. **读路径 `create:false` 的错误文案变化**：父目录不存在时由「建目录失败」改为「打开目录失败」，更准；不引入新失败面（原本也读不到）。
6. **自愈迁移的时间成本**：逐行 `getItem` + 重建，仅在标志位为空时执行一次；行数即台账行数（本地量级），不做批处理优化。

## 7. 验收（AC）

| # | 验收点 | 判据 |
|---|---|---|
| AC 1 | 删除 | 「我创建的」里删除该课程不再报「本地缺少该条目的内容哈希」；按门槛返回票数或直接生效 |
| AC 2 | 回填 | 进「编辑课程」，标题 / 简介 / 课时清单全部回填，保存后节点回 200 |
| AC 3 | 上传 | 选图 → 上传成功 → 缩略图出现；自检页「编辑面日志」不再出现 `建目录失败` |
| AC 4 | 落盘根 | 自检页新增「落盘根可用」明细为 ok，且 detail 给出胜出全路径 |
| AC 5 | 课时 400 | 若仍失败，界面 toast 与 `edit-surface.log` 均含节点 `code` 原文与 message |
| AC 6 | 前置检查 | 父课程台账非 `sent` 时「加一课」给可操作提示且**不发请求**；`sent` / 无台账行照常进入 |
| AC 7 | 幂等 | 二次启动自愈迁移零动作（标志位生效）；已具备条目行的 id 一字不改 |
| AC 8 | 门禁 | Go 全包 ok、mobile 全用例绿、`vue-tsc` 干净、`build:h5` / `build:app` 通过 |
| AC 9 | 发布 | `0.20.2`/`27` 上线，`GET /v1/release`、`HEAD /dl/base-0.20.2.apk`、`GET /` 三处核对一致 |
