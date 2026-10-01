# 册子 #56 · 创作者可见性闭环（缺陷批次）

**日期：** 2026-10-01
**直接上游：** `specs/2026-09-30-base-governance-visibility-design.md`（`#51`：「我创建的」区、台账视图、去重口径）、`plans/2026-09-30-base-governance-visibility-plan.md`（`#52`：其实施计划）、`specs/2026-09-30-base-course-lesson-edit-design.md`（`#40`：容器投稿与 `seq<0` 槽位）、`specs/2026-09-28-base-submission-design.md`（`#25`：投稿拒绝口径）、`specs/2026-09-28-base-creation-ui-design.md`（`#29`：`my_submissions` 台账）
**范围：** 修掉「我创建的课程」两类可见性缺陷——**A** 历史台账行重放恒 HTTP 400；**B** 显示「已同步」但点进去提示「本地没有这门课程，请返回先同步」且同步按钮无效。
**本册不覆盖：** 节点侧投稿校验放宽（本册不动契约）；内容包重建口径；节点级目录与票选（归 `#58`）；分类中文化（归 `#58`）；真机验收执行。

---

## 1. 现状与根因（已核到行号，执行时不要重新调研）

| 事实 | 位置 |
| --- | --- |
| 保存容器 → `enqueueOrSend`；送达 `sent`、断网/429/5xx `pending`、**其余 4xx `failed`**；`flushSubmissions` 只重放 `pending` | `apps/mobile/src/core/submit.ts:310-328,340-395` |
| 台账 DDL 列：`item_id,type,title,body_md,question_json,links_json,segments_json,state,reason,created,queued_at,sent_at` | `apps/mobile/src/core/repo.ts:17-97,126-131` |
| 「我创建的」列表 = 台账行集 → `buildMyCreatedView(rows, packItemIds)`；去重判据 = `sent` 且 `packItemIds.has(itemId)` ⇒ 跳过 | `apps/mobile/src/core/my-created.ts:41-56` |
| 课程页 `load()` 用 `repo.listSubmissions()` + `all.map(i => i.itemId)` 喂视图 | `apps/mobile/src/pages/course/course.vue:200-203` |
| 点开「我创建的」行：`encodeURIComponent(row.itemId)` 后跳详情并带 `from=ledger` | `apps/mobile/src/pages/course/course.vue:284-300` |
| 详情页**台账入口只查未解码的 `raw`**：`repo.getSubmission(raw)`，失败即「本地没有这门课程，请返回先同步」 | `apps/mobile/src/pages/course/detail.vue:84-89` |
| 详情页**普通入口**却会补试解码态：`repo.getItem(raw) ?? repo.getItem(decodedId(raw))` | `apps/mobile/src/pages/course/detail.vue:112-116` |
| 同步按钮 → `syncOnce(opts)`；其**第一件事**是版本比对，`content_version <= localVersion` 直接 `noop` | `apps/mobile/src/pages/course/course.vue:231-245`、`apps/mobile/src/core/sync.ts:150-157` |
| 容器投稿落库只写 `items` + `segments` 两表（`dist_class='public'` / `state='active'`），**不触发内容包重建** | `internal/store/submission.go:110-159` |
| 节点侧容器校验三区间铁律 + `AttrSeqsCanonical`，失败回 400 `item_segments_invalid` | `internal/httpapi/submit.go:85-123,204-218` |
| 「条目已被他人占用」返回 **409** `ErrItemTaken`（含空归属存量条目），不是 400 | `internal/store/submission.go:130-138` |
| 台账行集可还原容器表单（与 `loadContainerForm` 逐字段同构） | `apps/mobile/src/core/my-created.ts:62-98` |
| 表单 → 行集唯一出口（属性行经 `assignAttrSeqs` 排布） | `apps/mobile/src/core/course-edit.ts:113-133` |

**A 的根因（中高置信）：** 老台账里的 `segments_json` 是按早期规则生成的，属性行 kind / seq 排布与现行 `AssignAttrSeqs` 不再逐字节同构，重放必被节点判 `item_segments_invalid`（400）。又因 400 属 4xx，台账被永久记为 `failed` 且不再进入重放队列 ⇒ 永远不会自愈。

**B 的根因（两个独立缺陷叠加）：**
1. `sent` 只表示「POST 被节点接受」，而节点收到容器后**不会重建内容包**（`content_version` 不变）⇒ `syncOnce` 恒 `noop`（同步按钮"无效"）⇒ 本地 `items` 永远拿不到这门课；
2. 详情页台账入口与普通入口**取键口径不一致**：跳转侧做了 `encodeURIComponent`，台账入口却不试解码态 ⇒ 直接落到「本地没有这门课程」。

**处置结论（用户已确认）：** 创作者自己创建的内容走**本地乐观落库**——本机立即可读、可点开、可编辑，不依赖节点重建内容包；历史失败行**自动重试一次，仍被拒则降级为「仅本地留存」**。

---

## 2. 契约

### 2.1 本地乐观落库

- `saveContainer(o, form)` 在 `enqueueOrSend` 之前/之后（**同一次调用内**）把 `buildContainerSegments(form)` 的行集写入本地 `items` + `segments`：
  - `items`：`item_id = form.itemId`、`type = form.type`、`title = form.title`、`dist_class='public'`、`state='active'`、`sqlite_table='segments'`、`source='local'`、`content_hash = SegmentsContentHash(ordered)` 的 TS 镜像；
  - `segments`：按 seq 升序逐行写入。
- **`source='local'` 是本册新增的枚举值**，语义 = 「本地乐观条目，尚未经任何节点回传」。它必须与内容包回填路径区分开（见 §2.2）。
- 节点内容包落库时同 `item_id` 自然覆盖本地版（既有 upsert 语义，无需额外处理）。

### 2.2 「我创建的」去重判据改口

- 现状判据「`sent` 且包表已有该 id ⇒ 跳过」**会把本地乐观条目误判为「已被节点收录」**，导致台账行从列表消失。
- 改口为：去重判据只吃**非 local 来源的 id 集**——即 `buildMyCreatedView(rows, packItemIds)` 的第二个实参由「全部 items」收窄为「`source !== 'local'` 的 items」。
- 语义：条目**真正被节点回传**后才从「我创建的」消失；本地乐观条目不影响台账展示。

### 2.3 重放归一化

- `flushSubmissions` 重放 **`type ∈ {course, lesson}`** 的台账行时，**不使用 `segments_json` 原文**，改走：

  ```
  ledgerSegmentsOf(row) → containerFormFromLedger(row) → buildContainerSegments(form)
  ```

  重建后的行集必然与现行 `AssignAttrSeqs` 逐字节同构，老数据由此自愈。非容器载体（`article` / `quiz` / `tag`）沿用原路径，一字不改。
- 重建失败（表单还原不出可用行集，例如 `segments_json` 是坏 JSON）⇒ 该行**不重放**，直接判为 §2.4 的「仅本地留存」。

### 2.4 一次性自愈迁移（幂等）

- 升级后首轮启动执行一次，把台账里 `type ∈ {course, lesson}` 且 `state ∈ {failed, pending}` 的行按 §2.3 归一化后重试一轮。
- **幂等靠台账标志位**：在本地 `config` 表写 `creator_visibility_migrated = '<版本号>'`；已存在即跳过，**不得每次启动重试**。
- 重试结果分流：
  - 送达 ⇒ `sent`（并清空 `reason`）；
  - 断网 / 429 / 5xx ⇒ 回 `pending`（进入正常重放队列）；
  - 其余 4xx ⇒ 置**「仅本地留存」**：`state='failed'` + `reason` 保留节点错误码，并**在台账新增一个标记**（`segments_json` 之外的独立列或复用 `reason` 前缀——具体落法见计划）使其**不再进入重放队列**；该行在「我创建的」区显示为「仅本地留存」并可删除。
- 「仅本地留存」的行**本地必须仍可见可编辑可删**（依赖 §2.1 的本地乐观落库，或迁移时顺带物化一次）。

### 2.5 取键统一

- 详情页台账入口（`from=ledger`）与普通入口同口径：先试 `raw`，再试 `decodedId(raw)`。
- 全页只保留**一处**取键规则，两条分支共用，避免再次分叉。

### 2.6 文案与同步反馈（如实）

- 台账状态标签：`sent` 由「已同步」改为 **「已提交 · 待节点收录」**（`my-created.ts` 的 `statusLabelOf`）；`pending`「待补发」、`failed`「失败」不变，新增「仅本地留存」。
- 同步按钮必须区分三种结果并如实反馈：`noop`（节点内容版本未变 ⇒ 提示「节点内容未更新」）、成功（显示新版本号）、失败（显示错误信息）。**不再静默**。

---

## 3. 落点

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `apps/mobile/src/core/repo.ts` | 改 | 本地乐观落库需要的写入方法（`items` + `segments` 同事务）；台账「仅本地留存」标记的读写 |
| `apps/mobile/src/core/course-edit.ts` | 改 | `saveContainer` 加本地乐观落库；抽出「表单 → 行集」的复用出口 |
| `apps/mobile/src/core/submit.ts` | 改 | 容器重放改走归一化重建；不重放「仅本地留存」行 |
| `apps/mobile/src/core/my-created.ts` | 改 | 去重判据收窄为「非 local」；状态标签新增「仅本地留存」、`sent` 改文案 |
| `apps/mobile/src/core/creator-migrate.ts` | 新建 | §2.4 的一次性自愈迁移（幂等，纯编排 + 可测） |
| `apps/mobile/src/pages/course/course.vue` | 改 | 去重实参收窄；同步按钮三态反馈 |
| `apps/mobile/src/pages/course/detail.vue` | 改 | 取键统一（台账入口与普通入口共用一处规则） |
| `apps/mobile/src/core/sync.ts` | 读 | 不改（`noop` 语义保留），只由调用方按 `SyncResult.status` 分流提示 |

---

## 4. 边界（本册明确不做）

1. **不动节点侧契约**：`validateSubmitSegments`、`AttrSeqsCanonical`、三区间铁律、`POST /v1/submit` 错误码一律不改（老数据靠客户端归一化自愈，不靠节点放宽）。
2. **不改内容包重建口径**：节点收到容器投稿后**仍不重建 pack**；本册不引入 `content_version` 自增。
3. 不改 `my_submissions` 的既有列语义（`item_id`/`type`/`title`/`body_md`/`question_json`/`links_json`/`segments_json`/`state`/`reason`/`created`/`queued_at`/`sent_at`）；
4. 不做「我创建的」区的搜索 / 排序 / 分页；不新增独立「我的进度」类页面；
5. 不动 `#51` 登记的「不建审批闸门」现状口径；
6. 不做目录与票选（归 `#58`）；不做分类中文化（归 `#58`）；
7. 不改内容包规范 v1、不 bump `schema_version`、不加配置项；
8. 不做 iOS。

---

## 5. 验收

| # | 验收项 | 手段 |
| --- | --- | --- |
| AC 1 | 新建课程保存后，**本机立刻**能在课程页与详情页读到它（不依赖同步） | vitest（本地落库）+ 本机 H5 |
| AC 2 | 本地乐观条目**不会**让台账行从「我创建的」消失（去重只吃非 local 来源） | vitest（`buildMyCreatedView`）+ 本机 H5 |
| AC 3 | 构造一条早期排布的 `segments_json`（属性行 seq 非规范），迁移后重放成功、台账转 `sent` | vitest（归一化重建 + 迁移编排） |
| AC 4 | 归一化后仍被节点拒（4xx）⇒ 台账转「仅本地留存」，**再次启动不重试**，本地仍可见可编辑可删 | vitest（幂等标志位）+ 本机 H5 |
| AC 5 | 台账行点开详情**不再**出现「本地没有这门课程」（编码态与解码态两种 itemId 均可打开） | vitest（取键纯函数）+ 本机 H5 |
| AC 6 | 同步按钮在 `noop` 时提示「节点内容未更新」；成功时显示版本号；失败时显示错误串 | 本机 H5 |
| AC 7 | `sent` 的展示文案为「已提交 · 待节点收录」 | vitest（`statusLabelOf`） |
| AC 8 | 门禁全绿：`go build ./...` / `go vet ./...` / `go test ./...`；`npx vitest run` / `npx tsc --noEmit` / `npm run build:h5`；模板 `.value` 硬检查无命中 | 见 `plans/2026-09-30-base-batch-f3-f9-plan.md` §6 门禁 |

**真机项（登记不阻塞）：** 断网创建课程 → 恢复网络 → 本地仍可见且台账转 `sent`；升级后首次启动的一次性迁移在真机不重复触发。

---

## 6. 上游回填清单（写计划前必须完成）

| 上游 | 需要追加 | 状态 |
| --- | --- | --- |
| `#51` | §0.x 改版说明：**去重口径改口**——判据从「包表全部 id」收窄为「非 `source='local'` 的 id 集」；§3.3 就地渲染口径不变 | ✅ 已回填（2026-10-01） |
| `#40` | §0.x 改版说明：容器台账行的重放路径**改走归一化重建**（`buildContainerSegments`），不再原样重放 `segments_json`；槽位机制与两条哈希口径一字不改 | ✅ 已回填（2026-10-01） |
| `#29` | §0.x 改版说明：台账新增「仅本地留存」这一**终态**与一次性自愈迁移标志位（表 DDL 与六方法语义不变） | ✅ 已回填（2026-10-01） |
| `#25` | §0.x 改版说明：确认「4xx 永久失败」的客户端处置新增「归一化重试一次」与「降级为仅本地留存」两档；节点侧拒绝码与占用口径一字不改 | ✅ 已回填（2026-10-01） |
| 总纲 | 核对 §6.0 / §7.3 是否有缺口 | ✅ 已核对（同批 `#58` 立册时回填 §0.12，本册无缺口） |

---

## 7. 风险

1. **`source='local'` 是新枚举值**：需先确认没有按 `source` 做枚举校验或白名单过滤的路径（尤其内容包导出与跨节点比较），否则本地条目会被拒或漂移。
2. **本地乐观条目与节点回传条目的 `content_hash` 口径**必须逐字节一致（TS 侧需与 Go 的 `SegmentsContentHash` 同构），否则同一条目在两端算出版本差。
3. **一次性迁移的幂等**是本册最容易出事的地方：标志位必须落在本地持久表（`config`），不能靠内存或时间戳推断。
4. **「仅本地留存」是终态**：一旦置位就不再有自动路径把它送回重放队列，因此必须提供**手动删除**入口，否则脏数据永久占位。
5. **同步按钮三态反馈不能引入新网络请求**：`noop` 的判断只能来自 `SyncResult.status`，不得为此新增接口。