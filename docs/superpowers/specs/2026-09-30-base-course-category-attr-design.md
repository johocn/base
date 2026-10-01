# base 课程分类属性槽位设计（A 主线 第 6 册）

- 日期：2026-09-30
- 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`（唯一上游，冲突时先改总纲）
- 直接上游：`specs/2026-09-29-base-course-category-design.md`（`#36`：分类契约——单级扁平 · 单归属 · 分类侧单向清单 · `category/<slug>` 形态 · slug 规则）；`specs/2026-09-30-base-course-lesson-edit-design.md`（`#40`：§2.1 槽位表与两条哈希口径）；批次编排 `plans/2026-09-30-base-batch-f3-f9-plan.md`（`#45`）
- 范围：**课程分类降为课程自身的属性槽位 `attr.category`**——新增槽位常量（Go / TS / 向量三处同步）+ 取值 = 分类 slug + **分组读取的双来源与优先级** + 课程编辑页「分类」入口（App 落点）+ 课程页分组展示改走双来源读取
- 本册子**不覆盖**：分类多级树与多归属；节点侧分类管理接口；App 内新建 `category/<slug>` 容器；`#36` 的导入器契约与 `category/<slug>` 形态；`#40` 的两条哈希口径；`#37` 标签体系；`#8` 学习进度；读取鉴权；iOS

## 0. 改版说明

### 0.1 2026-09-30 初版

**动机**：App 实测问题清单（`#45` 编排）的 **F6 =「课程分类没有看到在哪里输入」**——用户在建课程时找不到分类入口，建完也看不出归属。既有分类（`#36`）**只由导入器按 front-matter 产出**，投稿 / 编辑面（`#40`）无写入路径，故 App 自建课程恒进「未归类」。

**新增（本册子首次定义）：**

- **属性槽位 `attr.category`**（§2）：`kind = "attr.category"`，落 `segments` 的 `seq<0` 区间——`#40 §2.1` 槽位机制内的**新 kind**，零新表零新字段。**课程专用**、可选（空则**不产该行**）。
- **取值 = 分类 slug**（§2.2）：与 `category/<slug>` 用**同一 slug 规则**（`[a-z0-9][a-z0-9-]{0,63}`，`#25 §2.4` / `#36 §3.1`）。用户已确认。
- **分组读取的双来源与优先级**（§3）：读取分组时**优先 `attr.category`**；该课程**不再**出现在导入器产 `category/<slug>` 清单行给出的另一个分类里（冲突口径 = **attr.category 优先、清单行忽略**）；**缺失才回退**清单行。回退 / 忽略都只发生在**读取分组时**，**库与清单行都不动**。
- **组标题解析**（§3.3）：优先取已存在的 `category/<slug>` **容器条目的 title**；该容器不存在（自建课程、未跑导入器）时**直接显示 slug 本身**。
- **App 落点**（§4）：课程编辑页 `pages/course/edit.vue` 新增「分类」输入（手填 slug；本机已有 `category/<slug>` 时提供候选点选，**零新接口**）；课程页 `pages/course/course.vue` 的分类分组改走双来源读取。

**明确沿用、不改动：**

- 内容包规范 v1：**不新增表、不新增字段、不新增 `source` / `type` 枚举值、不 bump `schema_version`、不加配置项**。
- **两条哈希口径一字不改**（`#14 §3.3` / `#40 §2.1` 铁律 2）：`seq<0` 仍按 `kind` 字典序从 `-1` 起递减；`attr.category` 加入后其排序落在 `attr.body_md` 与 `attr.cover` 之间。
- **老条目不破哈希**（§5）：无 `attr.category` 行的老课程，`AssignAttrSeqs` 排布与既有**完全一致**，`AttrSeqsCanonical` 仍通过，**不产生新版本**。
- **`#36` 的导入器契约与 `category/<slug>` 形态一字不改**：`internal/importer/*` **一行不改**。
- 可见性仍只有 `dist_class` 一维；标签权威仍在 `tag_links`、不进包（`#37`）。

### 0.2 2026-10-01 上游回填（#58 立册）

本册 §3 的**双来源与优先级收敛为单来源**——归类**只认 `attr.category` + 节点级目录**；导入器产 `category/<slug>` 的 `seq>=1` 清单行**不再承担归属回退**。同时本册 §2.2 的取值语义由「分类 slug」改为「**分类词条键**」（可含中文），写入侧不再要求 `[a-z0-9][a-z0-9-]{0,63}`。`category/<slug>` 容器条目仍保留为展示容器与组标题来源（`#36` 的 `seq=0` 简介与 `title` 口径不变）。详见 `#58 §2.3`。

## 1. 范围与不做什么

| 做 | 不做 |
|---|---|
| 新增 `attr.category` 槽位（Go / TS / 向量三处同步） | 分类多级树与多归属 |
| 取值 = 分类 slug，随 course 容器一起提交 | 节点侧分类管理接口（增删改一律走导入器） |
| 分组读取的双来源 + 优先级 + 组标题解析（纯函数，只读） | 在 App 里新建 `category/<slug>` 容器（那会新开写面） |
| 课程编辑页「分类」输入 + 本机候选点选（零新接口） | 改 `#36` 的导入器契约与 `category/<slug>` 形态 |
| 课程页分组展示改走双来源读取 | 改 `#40` 两条哈希口径 |
| 老条目「无该行」不破排布（回归向量守） | 新增表 / 字段 / 枚举值 / 配置项；iOS |

## 2. 契约：属性槽位 `attr.category`

### 2.1 槽位定义

| 项 | 值 |
|---|---|
| `kind` | `attr.category` |
| `seq` | `<0`（属性区间，`#40 §2.1` 铁律 1） |
| 承载容器 | **仅 course**（lesson 不产该行；节点**不**按容器类型限制属性 kind——`validateSubmitSegments` 既有口径，**不新增校验**） |
| `text` | 分类 slug |
| 必填 | 否——**空则不产该行**（`#40 §2.1` 铁律 4：不写空行） |
| 至多行数 | 1（同 kind 至多一行，`#40 §2.1` 铁律 2） |

**三处常量必须同步**（`#40 §8 风险 2`：`seq<0` 排布进 `content_hash`，两端不一致会**静默出新版本而不报错**）：

| 位置 | 动作 |
|---|---|
| `internal/protocol/attrs.go` | 新增 `AttrKeyCategory = "attr.category"`，加入 `AttrKindSet` |
| `apps/mobile/src/core/attrs.ts` | 新增 `ATTR_CATEGORY = 'attr.category'`，加入 `ATTR_KIND_SET` |
| `vectors/v1/attrs.json` | 新增用例（含 `attr.category`，并保留/新增「无该行」回归） |

### 2.2 取值与排序

- 取值 = 分类 slug，**与 `category/<slug>` 用同一 slug 规则**（`#36 §3.1` / `#25 §2.4`）。
- 字典序位置：`attr.attachment` < `attr.body_md` < **`attr.category`** < `attr.cover` < `attr.difficulty` < `attr.duration` < `attr.instructor`。故加入该行时它排在 `attr.body_md` 与 `attr.cover` 之间，**不改变其它 kind 的相对次序**。
- 写入侧软约束：`text` 去首尾空白；空 ⇒ 不产该行；非空但**不是合法 slug** ⇒ 提示且**不产该行**（避免脏 slug 进库）。

## 3. 分组读取：双来源与优先级

### 3.1 双来源

| 来源 | 形态 | 优先级 |
|---|---|---|
| **课程侧属性（新）** | 该课程 `segments` 里的 `attr.category` 行 | **高**——有则以它为准 |
| **分类侧清单（既有 `#36`）** | 导入器产 `category/<slug>` 的 `seq>=1` 清单行（`kind=course`，`text = course/<cid>`） | 低——**缺失才回退** |

### 3.2 优先级与冲突口径（定死）

- 课程一旦有 `attr.category` 行，**就以它为准**；该课程**不再**出现在清单行给出的另一个分类里。
- **冲突口径 = `attr.category` 优先、清单行忽略**。
- 回退 / 忽略**都只发生在读取分组时**：**库与清单行都不动**，导入器路径**零改动**。

### 3.3 组标题解析

- 优先取**已存在的** `category/<slug>` 容器条目的 `title`（`items.title`，`#36 §3.1`）。
- 该容器**不存在**（自建课程、未跑导入器）⇒ **直接显示 slug 本身**。
- 分组集合 = 双来源出现的全部 slug ∪ 既有 `category/*` 容器（空组不显示，与 `#36 §5.2` 同口径）；排序按 `item_id`（`category/<slug>`）升序，与 `#36 §3.1` 一致。

### 3.4 实现形态（纯函数，零写入）

分组读取落在 `apps/mobile/src/core/course-tree.ts`（或新模块 `core/course-category.ts`）：输入 `items` 与各条目的 `segments`，输出「分组 + 未归类」。**只读**：不写库、不改清单、不发请求。课程页 `load()` 由「逐分类取清单」改为「逐课程取 `attr.category` + 逐分类取清单」的一次组装。

## 4. App 落点

### 4.1 课程编辑页（F6 的原始诉求）

- `pages/course/edit.vue` **新增「分类」字段**：一个可手填 slug 的输入；本机已有 `category/<slug>` 条目时**提供候选点选**（chips，点选回填 slug，再点取消）。
- 候选源 = **本机 `LocalRepo`**（`splitCategories(await repo.listItems())`），**零新 HTTP 接口**。
- 表单 `ContainerForm` 新增 `category` 字段；`buildContainerSegments` 对 `type==='course'` 且 `category` 合法非空时产 `attr.category` 行；`loadContainerForm` 回填；`container-view.ts` 的 `ContainerAttrs` 增 `category` 并解析该行。
- **不新建 `category/<slug>` 容器**：编辑页只写课程自己的属性行。

### 4.2 课程页

- `pages/course/course.vue` 的分类分组改走 §3 的双来源读取；组标题按 §3.3 解析。
- 「未归类」判定同步纳入双来源（被任一来源归入分类的课程不再进「未归类」）。

## 5. 老条目兼容

- **无 `attr.category` 行的老课程**：`AssignAttrSeqs` 只对**出现的** kind 分配 seq，故排布与既有**逐字节一致**；`AttrSeqsCanonical` 仍通过；`content_hash` 不变，**不产生新版本**。
- **老包 / 老客户端（≤ `0.15.0`）**：`attr.category` 是 `seq<0` 行，老客户端 `childrenOf` 只认 `seq>=1` ⇒ **天然不可见**，不产生幽灵课时（与 `#40 §7` 同口径）。
- **节点未升级**：含 `attr.category` 的课程会被 `validateSubmitSegments` 拒为 `item_segments_invalid`(400)（`IsAttrKind` 未含该 kind）⇒ **发布口径强制重编部署节点二进制**（§7）。

## 已知边界

登记，不在本册修。

1. 分类改名 / 删除仍走导入器；App 无分类管理面。
2. 组排序按 slug / `item_id` 升序，无自定义顺序（与 `#36` 一致）。
3. **「孤分类组」**：手填的 slug 合法但库中无对应 `category/<slug>` 容器时，仍以 slug 成组并显示 slug 本身（可读性下降，但一致、可复现）。
4. **冲突时清单行被忽略是「读时」行为**：节点与库不动 ⇒ 运营从清单仍能看到旧归属，可能困惑。
5. **悬空口径差异**：清单行指向不存在的课程 = **跳过**（`#36 §3.2`）；`attr.category` 指向不存在的分类容器 = **以 slug 成组**（本册 §3.3）。两者不冲突，是「课程侧声明」与「分类侧清单」两类来源的不同失效表现。

## 验收（AC）

| AC | 内容 | 判定 |
|---|---|---|
| AC 1 | 三处同步：Go 常量 + `AttrKindSet` / TS 镜像 + `ATTR_KIND_SET` / `vectors/v1/attrs.json` 用例；双端共读同一向量全绿 | Go `go test ./internal/protocol/` + `npx vitest run src/core/attrs.test.ts` |
| AC 2 | **老条目不破哈希**：无 `attr.category` 行的课程排布与既有逐字节一致（既有向量用例仍过 + 新增「含 `attr.category`」用例 + 「无该行」回归），`AttrSeqsCanonical` 通过，不产生新版本 | 同上 + Go `AttrSeqsCanonical` 顺序无关回归 |
| AC 3 | 编辑页「分类」：合法 slug 保存后课程行集含 `attr.category`；空 / 非法不产该行；本机已有 `category/<slug>` 时显示候选可点选 | vitest（`course-edit.test.ts`）+ 本机 H5 |
| AC 4 | 双来源优先级：课程有 `attr.category` ⇒ 归该分类且**不出现**在清单行给出的另一分类；缺失才回退清单行 | vitest（分组纯函数）+ 本机 H5 |
| AC 5 | 组标题：优先取既有 `category/<slug>` 容器 `title`；容器不存在 ⇒ 显示 slug 本身 | vitest + 本机 H5 |
| AC 6 | 读取零写入：分组只读；库与清单行不动；`internal/importer/*` 无 diff | `git diff --stat internal/importer` 无输出 |
| AC 7 | 零新接口 / 零新表 / 零新字段 / 零配置 / 不 bump `schema_version` / 不新增 `source`·`type` 枚举 | 代码核对 |
| AC 8 | 门禁全绿（`#45 §6`）+ 发布前硬检查无输出；节点二进制重编部署 | `go build/vet/test ./...`、`npx vitest run`/`tsc`/`build:h5`、`acceptance-d.ps1` |
| AC 9 | 真机（交用户）：新建课程填分类 → 课程页见其新分组（标题按口径）→ 与导入器产分类冲突时 `attr.category` 优先 | 真机 |

## 版本与发布

- 版本：`0.16.0` / `21`（随 `#45` 批次**单次发布**，不单独发版；基线 `0.15.0` / `20`）。
- **节点二进制必须重新交叉编译部署**：本册改了 `internal/protocol/attrs.go`（新增常量与 `AttrKindSet` 条目，未部署则含 `attr.category` 的投稿被拒）。
- 发布四步（强制，缺一不可）：云打包 APK → 上传 `/opt/appdl/base-0.16.0.apk` → 落地页整页重写改指 → `based release` 签发落 `/opt/base-cache/data/release.json`。

## 文档登记与上游回填

登记为 `docs/README.md` 第 **49** 行（计划 `#50` 紧随其后）。

| 上游 | 动作 | 结果 |
|---|---|---|
| `#40 §2.1` 槽位表 | 新增 `attr.category` 一行（课程专用、取值 = 分类 slug、可选、空则不产该行） | ✅ 已加 |
| `#40 §0` 改版说明 | 追加一节（注明由 `#49` 立册引入、日期 2026-09-30） | ✅ 已加（`### 0.3 2026-09-30 上游回填（课程分类属性槽位 #49 立册）`） |
| `#36` | 追加一节（或改版说明条目）指向 `#49`：分类归属新增**课程侧属性来源** `attr.category`，双来源优先级与冲突口径见 `#49`；**明确 `#36` 的导入器契约与 `category/<slug>` 形态一字不改** | ✅ 已加（`### 0.3 2026-09-30 课程侧属性来源（#49 立册时回填）`） |
| 总纲 | 核对 §6.0 / 分类相关条款是否有缺口 | ✅ **经核对无缺口，不改**——§6.0 只定义 `source`·`type` 取值与 `category/<slug>` 形态；`attr.category` 是既有 `seq<0` 属性槽位机制（§0.9）内的新 kind，不新增取值、不改 `item_id` 形态、不动哈希口径 |
| `docs/README.md` | §3 新增 `#49` / `#50` 两行；§4 依赖顺序标 F6 已出；§5 当前阶段；`#36` / `#40` 行状态追加回填说明 | ✅ 已改 |

## 风险点

1. **双端漂移**（最大成本项）：`attr.category` 的 `seq<0` 排布进 `content_hash`，两端不一致会**静默出新版本而不报错**。压舱石是 `vectors/v1/attrs.json`；**老条目「无该行 ⇒ 排布不变、不破哈希」必须逐条验**（AC 2）。
2. **节点未重编**：`internal/protocol/attrs.go` 改了而未部署新二进制，含 `attr.category` 的课程投稿被拒为 `item_segments_invalid`(400)。发布口径强制重编部署（§7）。
3. **冲突口径的观感**：清单行被读时忽略、库不动 ⇒ 运营从清单仍能看到旧归属，可能困惑（已知边界 4）。
4. **手填 slug 拼写错误**：合法但不存在的 slug 会造出「孤分类组」（已知边界 3）；写入侧软校验只拦非法 slug，拦不住「合法但写错」。
5. **归因口径的静默性**：`attr.category` 优先是**读时**规则，不做节点侧实时判定；若将来要求「清单与属性一致」需另立册子。