# base 课程体系主线设计（A 主线）

- 日期：2026-09-28
- 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`（唯一上游，冲突时先改总纲）
- 范围：**课程体系 `course → lesson → (article | video | quiz)` 的归属与排序落地** —— 含 item_id 路径式命名空间切换、course/lesson 内容承载、本地导入器按归属产出、手机端三级浏览
- 本册子**不覆盖**：视频分块与节点间分发（已由 #5 落地）；任何互动形态（评论 / 进度 / 小组 / 私信，归 #7–#10）；手机端本地库加密（归 #4）；手机端视频播放器（总纲明确不做）；读取鉴权与权限维度

## 0. 改版说明

### 0.1 2026-09-28 初版

**新增（本册子首次定义）：**

- `item_id` 的**路径式命名空间切换**与旧 id 退役口径（§2.1、§2.4）
- course / lesson 的**内容承载方式**：借 `segments` 表，零新表零新字段（§3）
- 排序模型：`segments.seq` 承载顺序，与 item_id 解耦（§3.2）
- segments 的**端到端打通**：`packexport` 白名单、`ImportPack` 入库、手机端建表与读取（§4）
- 本地导入器按 front-matter 归属产出课程层级（§4.2）
- 手机端旧 id 用户数据的**启发式平移**（§5.3）
- 手机端三级浏览形态与「未归类」分组（§6）

**明确沿用、不改动：**

- 内容包规范 v1：`manifest.json` 的字段名与类型、`pack.sqlite` 的表结构（总纲 §6.1 / §6.2）
- `blob_id = hex(sha256(逻辑字节))[0:32]` 与磁盘布局（总纲 §3.2 / §6.3）
- `Entries[].source` / `type` 的既有取值集合，**不新增枚举值**（总纲 §6.0）
- 可见性一律由 `dist_class` 承载，**不引入新的权限维度**（总纲 §3）
- 三级层级只表达「归属与顺序」，**不表达权限**（总纲 §6.0）
- P0 与 #5 已落地的导入 / 导出 / 公开读 / 手机端下载 / 分发链路全部保留，不重写

### 0.2 2026-09-28 补充（治理主线第 2 册立册时）

**新增：**

- `quiz/<qid>` 独立题库形态补入 §2.1 形态表：`source=quiz` / `type=quiz` / `sqlite_table=quizzes`，与既有的独立文章 `article/<aid>` 对称 —— 两者都是**不属于任何课程**的独立形态。投稿写入（README #25）需要它，故本册补此一行定义。

**明确不变：**

- **不新增任何 `source` / `type` 枚举值**：`quiz` 本就在总纲 §6.0 的取值集合内，本次只是把它与「不属于任何课程」的路径形态对应起来。
- 课程内题库 `course/<cid>/lesson/<lid>/quiz/<qid>` 不变，仍记 `source=lesson` / `type=quiz`；两种形态**互不混用**，各自的 `item_id` 前缀即判据。
- §2.1 其余形态、§3 承载与排序、§4 落地改动面均不变。

### 0.3 2026-09-29 容器形态扩两类（课程分类与统一标签立册时）

**补充：** §3.1 的 `segments` 容器承载**不止 course / lesson 两种**，本册落地的通用形态（`seq=0` 简介 + `seq>=1` 子项清单 + 条目级哈希口径）原样适用于另外两类容器（2026-09-29 总纲 §0.8 已回填 §6.0）：

| 容器 | 子项 `kind` | 子项 `text` | 出处 |
|---|---|---|---|
| `category/<slug>` | 只允许 `course` | 该分类下 `course/<cid>` 的 `item_id` | #36 册子 |
| `tag/<名称>/<章>/<节>` | 只允许 `course` / `lesson` / `article` / `comment` | 被关联目标的 `item_id`（评论为 `comment/<event_id>`） | #37 册子 |

**明确不变：**

- §3.3 的**两条哈希口径一字不改**（行级 `sha256(UTF-8(text))`、条目级按 `seq` 升序拼 `"<kind>\t<text>\n"`）——新容器直接复用，确定性导出性质不变。
- §3.2「顺序 = `seq`、重排不改 `item_id`」同样适用；分类之间无上级容器，**不引入排序字段**。
- §2.1 的 `item_id` 形态表由总纲 §6.0 统一补齐（`category/<slug>`、`tag/<名称>/<章>/<节>`），本册不再复述。
- §4 落地改动面、§5 手机端三级浏览、§6 验收均不变：**#36 在 §6 之上加一层分类分组并另立册子**；标签不进课程树，#37 另立册子。

## 1. 范围与不做什么

**做五件事：**

1. `item_id` 从 `<source>:<slug>` 切换到总纲 §6.0 的路径式命名空间，并让旧条目以墓碑方式退役。
2. course / lesson 容器条目的落地：归属由前缀表达，内容（简介 + 子项顺序清单）借 `segments` 承载。
3. `segments` 全链打通：节点侧写读、`packexport` 放行并导出、`ImportPack` 入库、手机端建表与读取。
4. 本地导入器（`internal/importer`）支持按 front-matter 声明课程归属，据此产出新命名空间与顺序清单。
5. 手机端三级浏览：课程列表 → 课时列表 → 载体页，另有「未归类」分组承载无课程归属的独立内容。

**明确不做：**

- **不新增任何表与字段**：`manifest.json` 与 `pack.sqlite` 均保持 v1 原样（总纲 §6.0「manifest 保持扁平，不新增表、不新增字段」）。
- **不新增 `source` / `type` 枚举值**：视频沿用 `source=lesson` + `type=video`。
- **不做权限**：无课程级授权、无课时级可见性；可见性只有 `dist_class` 一维。
- **不做学习进度**：课时内完成标记、进度条、打卡一律归 #8，本册子不落任何学习态字段。
- **不做手机端视频播放器**：视频条目在课时列表里以条目形式出现，播放留待后续；本册子不碰播放器。
- **不改 `tools/migrate`**：源站 `zhao-website` 只暴露扁平 `articles` 接口（无 course / lesson 端点），故归属数据一律由本地导入器产出；Strapi 迁移路径保持现状。
- **不做容量上限与 LRU 淘汰**（归 #5 之后的阶段）。

## 2. 契约边界

### 2.1 item_id 命名空间（本册唯一的契约变更）

```
course/<cid>
course/<cid>/lesson/<lid>
course/<cid>/lesson/<lid>/article/<aid>
course/<cid>/lesson/<lid>/video/<vid>
course/<cid>/lesson/<lid>/quiz/<qid>
course/<cid>/lesson/<lid>/article/<aid>/cover    # 封面挂在所属文章下
article/<aid>                                    # 不属于任何课程的独立文章
```

铁律：

1. **末段一律沿用旧 slug**。这是 §5.3 启发式映射成立的前提，也是「切换可被平滑吸收」的唯一依据。
2. 层级**只靠 `/` 前缀表达**，`manifest.entries[]` 保持扁平；按 `<cid>/` 前缀扫描即得该课程全部课时与载体，无需递归查询。
3. `source` / `type` **不新增枚举值**，按下表取值：

| item_id 形态 | source | type | sqlite_table |
|---|---|---|---|
| `course/<cid>` | `course` | `course` | `segments` |
| `course/<cid>/lesson/<lid>` | `lesson` | `lesson` | `segments` |
| `.../article/<aid>` | `article` | `article` | `articles` |
| `.../video/<vid>` | `lesson` | `video` | `media_meta` |
| `.../quiz/<qid>` | `lesson` | `quiz` | `quizzes` |
| `.../article/<aid>/cover` | `article` | `cover` | `media_meta` |
| `article/<aid>` | `article` | `article` | `articles` |
| `quiz/<qid>` | `quiz` | `quiz` | `quizzes` |

`article/<aid>` 与 `quiz/<qid>` 是两种**不属于任何课程**的独立形态；课程内的题库（`course/<cid>/lesson/<lid>/quiz/<qid>`）仍记 `source=lesson`，两者不混用。

4. **旧 id 不改写、不复用**：切换到新命名空间后，旧 `<source>:<slug>` 条目不是被就地改名，而是走「新条目 + 新 `content_version` + 旧条目墓碑」——与总纲 §3.1 第 5 条「改标签 = 发一个新 `content_version`，不得原地改」同一口径。

### 2.2 旧 id 的退役

- 旧形态的判定：`item_id` 含 `:`（P0 全部形态为 `<source>:<slug>`，新命名空间只含 `/`，两者互斥）。
- 退役动作：由导入器显式开关 `-retire-legacy` 触发，把仍为 `active` 的旧形态条目写进 `tombstones` 并置 `state='removed'`；**默认关闭**，避免误伤。
- 墓碑随签名 manifest 传播，节点与客户端两侧按 #5 §9 既有口径落地（节点删块文件「先收集后删」，客户端删 `items` / `articles` / `quizzes` / `blob_index`）。

### 2.3 不可改

- `manifest.json` 的字段名、字段类型、`entries[]` 结构。
- `pack.sqlite` 的五张表 DDL 与列顺序（`articles` / `segments` / `quizzes` / `media_meta` / `meta`）。
- `blob_id` 算法与其输入。
- 任何 `dist_class` 之外的可见性维度。

### 2.4 与 #5 的接口

#5 册子 §1 明确「不做课程层级建模，`item_id` 重命名归 #6」。本册子只做这件事，**不触碰 #5 的任何接口**：`inventory` / `sync` / `fetch` / `scrub` 四个内部接口、对端监听路由隔离、副本登记、反熵与墓碑同步全部原样。

## 3. 内容承载与排序（借 segments，零新表）

### 3.1 承载表

| 条目 | sqlite_table | 行语义 |
|---|---|---|
| `course/<cid>` | `segments` | `kind=digest, seq=0` 的 `text` = 课程简介；`kind=lesson, seq=1..n` 的 `text` = 子 lesson 的 `item_id` |
| `course/<cid>/lesson/<lid>` | `segments` | `kind=digest, seq=0` 的 `text` = 课时简介；`kind=article\|video\|quiz, seq=1..n` 的 `text` = 子载体 `item_id` |

- course 的子项 `kind` 只允许 `lesson`；lesson 的子项 `kind` 只允许 `article` / `video` / `quiz`。
- `seq=0` 固定留给简介，`seq>=1` 固定为子项清单 —— 顺序即 `seq` 升序。
- 条目标题走 `items.title`（已在 `manifest.entries[].title` 内），不进 segments。
- 封面不进 segments，仍是独立 cover 条目，走既有 `media_meta` + blob 路径。

### 3.2 排序模型

- **顺序 = `segments.seq`**。重排课时/载体只改 `seq`，**不改任何 `item_id`**。
- 由此与总纲 §3.2 的寻址护栏不冲突：`blob_id` 只依赖逻辑字节，`seq` 变化不产生任何块级影响，不破坏去重、秒传、副本因子、反熵、Merkle 清单五项。
- P0 每课时只承载单个载体，此时清单仍必须是显式的一行（`seq=1`）——**不做「单载体隐式化」的省略优化**，否则多载体课时会引入两套读取路径。

### 3.3 哈希口径（必须写死，否则导出不确定）

| 层级 | 口径 |
|---|---|
| 行级 `segments.content_hash` | `hex(sha256(UTF-8(text)))`，与 `articles` 的行级口径一致 |
| 条目级 `items.content_hash` | `hex(sha256(按 seq 升序拼接的 "<kind>\t<text>\n" 的 UTF-8 字节))` |

- 拼接串的固定形状是确定性导出的前提：同一份内容重复导出必须字节一致。
- 条目级口径只在 `segments` 类条目上生效；`articles` / `quizzes` / `media_meta` 类条目沿用各自既有口径，不迁移、不改写。

## 4. 落地改动面

### 4.1 节点侧（Go）

| 位置 | 改动 |
|---|---|
| `internal/store` | 新增 segments 读写：`UpsertSegmentItem`（一个事务内写 `items` + `segments`，先删同 `item_id` 旧行再按 `seq` 写入，幂等）与 `ListSegments(itemID)`；`ImportPack` 的 `sqlite_table` 分支增加 `segments` |
| `internal/packexport` | 可导出表改为显式白名单常量 `exportableTables`（`articles` / `media_meta` / `quizzes` / `segments`），非白名单仍报错；`writePackSQLite` 增加 segments 写出分支，按 `seq` 升序写，保证确定性 |
| `internal/importer/md.go` | `ParseMD` 增读 front-matter 键 `course` / `course_title` / `lesson` / `lesson_title` / `order`；`Run` 按 (course, lesson) 分组后生成容器条目与清单；无 `course` 键的文档走 `article/<slug>`；`importQuiz` 的 `item_id` 由 `lesson:<slug>` 改为 `course/<cid>/lesson/<lid>/quiz/<slug>`；新增 `-retire-legacy` 开关 |
| `internal/importer/video.go` | `ImportVideo` 的条目 `item_id` 由 `lesson:<slug>` 改为 `course/<cid>/lesson/<lid>/video/<slug>`；`VideoOptions` 增加 `Course` / `Lesson` 字段，**两者缺省即报错**（总纲 §6.0 无顶层 `video` 命名空间） |
| `internal/httpapi/web.go` | 封面查找由 `strings.TrimPrefix(item_id,"article:")` + `"cover:"+slug` 改为 `item_id + "/cover"` |

### 4.2 本地导入器的归属声明

归属用 **front-matter 声明**，不改目录遍历（`Run` 仍只读顶层 `*.md`）：

```markdown
---
title: 内容寻址为什么能去重
course: content-addressing
course_title: 内容寻址入门
course_digest: 从哈希寻址讲到 Merkle 清单
lesson: l1
lesson_title: 第一讲 哈希与寻址
order: 1
---
正文…
```

规则：

1. `course` 缺省 → 本文档是独立文章，`item_id = article/<slug>`。
2. `course` 有值、`lesson` 缺省 → 报错（不允许只有课程没有课时的载体）。
3. `lesson` 有值、`order` 缺省 → 排在该课时清单末尾（`order` 相同的按文件名升序，保证确定性）。
4. `course_title` / `lesson_title` / `course_digest` / `lesson_digest` 缺省 → 容器条目 `title` 取 `<cid>` / `<lid>`，`digest` 行省略。
5. 题组（`type: quiz`）走同一套 front-matter 键，产出 `.../quiz/<slug>`；视频不走 front-matter，改由 `import-video` 的 `-course` / `-lesson` 命令行参数声明归属，产出 `.../video/<slug>`。
6. 一次 `Run` 结束后统一重建受影响课程的清单（先收集受影响的 (cid) 与 (cid,lid) 集合，再逐个重算 course 条目与 lesson 条目的 segments），避免边扫边写导致顺序抖动。

### 4.3 手机端（TS）

| 位置 | 改动 |
|---|---|
| `core/repo.ts` | `SCHEMA_SQL` 增加 `segments(item_id, seq, kind, text, content_hash, PRIMARY KEY(item_id,seq))`（`IF NOT EXISTS` 幂等）；`applyPack` 写入 segments，并**在墓碑分支一并 `DELETE FROM segments WHERE item_id=?`**（与 articles / quizzes 同口径） |
| `core/sync.ts` | 增加 `readPackSegments(conn)`，读内容包 `segments` 表 |
| `core/course-tree.ts`（新） | 纯逻辑模块：按 `item_id` 前缀切出 `course → lesson → 载体` 树，按 segments 的 `seq` 排序，产出「未归类」集合。不依赖 UI，可单测 |
| `core/id-migrate.ts`（新） | 一次性幂等迁移，见 §5.3 |
| `pages/course/course.vue` | 主页改为「课程」列表 + 「未归类」分组 |
| `pages/course/detail.vue`（新） | 课程详情：按 `seq` 列出课时，显示「第 N 讲 + 标题」 |

**已知副作用（明写，勿当 bug）：** `apps/mobile/src/core/quiz.ts` 的选项打乱种子 `seedFrom(item_id)` 来自 `item_id`，id 一变同一题库的**选项显示顺序会变**。判分按 `answerIndex` 比对，不影响正确性；但升级前后同一题的选项排列可能不同。

## 5. 兼容与迁移

### 5.1 切换是一次性的

- 切换语义 = **新 item_id + 新 `content_version` + 旧条目墓碑**（§2.1 第 4 条）。
- 节点侧由导入器 `-retire-legacy` 触发一次；客户端侧由 #5 既有墓碑落地路径吸收，**无新增同步协议**。

### 5.2 节点侧无用户数据

节点不持有学习态（收藏 / 进度 / 答题），故切换在节点侧只涉及内容条目与块归属，无用户数据风险。

### 5.3 手机端旧 id 用户数据的启发式平移

**受影响的本地表：`user_state`（收藏 / 已读）、`quiz_attempt`（答题记录）。** 两者都以 `item_id` 为键，id 一变即成孤儿行。

平移规则（幂等、一次性）：

1. 触发时机：应用新包成功后（`applyPack` 返回新 `content_version`）执行一次。
2. 匹配规则：旧 id 按第一个 `:` 切成 `(旧前缀, slug)`；在新 id 集合里找**末段等于 slug** 的条目，即视为同一条。
3. 适用范围**只有** `article` / `video` / `quiz` 三类（`cover` 与 `comment` 不涉及用户数据，不参与匹配）。
4. 多个候选命中时**放弃平移并保留旧行**（宁可留孤儿也不张冠李戴）。
5. 执行打标：`config` 表写 `id_migrate_v2=done`，重复进入直接跳过。
6. 未命中（内容已下架）的旧行**保留不删**：用户数据只增不损；孤儿行不参与任何 UI 展示。

### 5.4 不做的兼容

- 不做「旧 id 别名读取」：不保留 `<source>:<slug>` 作为可读别名，旧条目一律墓碑退役，避免两套 id 长期并存。
- 不做服务端 id 重定向：节点不感知新旧对应关系，映射完全在客户端完成。

## 6. 手机端三级浏览

```
主页（course.vue）
 ├─ 「课程」分组：course/<cid> 列表，按 course 条目 item_id 升序
 └─ 「未归类」分组：article/<aid> 等无归属条目，按既有平铺口径
      ↓ 点课程
课程详情（course/detail.vue）
 └─ 课时列表：按 segments.seq 升序，显示「第 N 讲 + lesson 标题」
      ↓ 点课时
课时页（载体列表）
 ├─ 单载体（P0 常态）→ 直达载体页（article / quiz / video 页）
 └─ 多载体 → 列出载体清单，点击进入对应载体页
```

- 「未归类」分组保留总纲 §6.0 的 `article/<aid>` 独立文章形态，迁移后现有内容一条不丢。
- 课时序号 `N` 由 `segments.seq` 在课程清单里的位次决定（`seq` 升序，从 1 计）。
- 视频条目在课时页只出条目与标题/时长（`media_meta`），**不做播放器**。

## 7. 验收

### 7.1 契约锁测试

1. `packexport` 仍拒非白名单 `sqlite_table`（新增 `segments` 后白名单仍是**显式集合**，任意表名一律报错）。
2. segments「导出 → 导入 → 读回」往返一致：同一份内容两次导出字节一致，导入后 `ListSegments` 结果与源相同。
3. 条目级 `content_hash` 口径稳定：同一份 segments 重复计算的哈希相等（§3.3）。

### 7.2 端到端（本机可自测）

1. 本地 importer 造 **2 个课程 × 2 个课时**，课时内各 1 个载体，另有 1 篇独立文章。
2. 导出内容包（`content_version` 递增），手机端同步落地。
3. 主页出现「课程」与「未归类」两组；课程页课时顺序与 `order` 一致；独立文章落在「未归类」。
4. 跑 `-retire-legacy` 后再次导出，旧 `<source>:<slug>` 条目在客户端消失，新条目仍在。

### 7.3 真机验收（交用户执行）

1. 升级后旧收藏与答题记录仍在（§5.3 平移生效）。
2. 课程页课时顺序与 `order` 一致，「第 N 讲」序号正确。
3. 「未归类」里的独立文章可正常打开。

## 8. 版本与发布

- 手机端版本：**0.6.0 → 0.7.0**。
- 节点侧无版本号（沿用既有发行脚本产物），但导出包的 `content_version` 因条目重建自然递增。
- 发布走既有链路：云打包 → 线上验签 → 落地页指向升级。

## 9. 文档登记

本册子落成后须在 `docs/README.md` 同步：

1. §3 文档清单新增本册子行（职责 / 明确不做什么 / 依赖 / 状态）。
2. §3 **补登 2026-09-27 / 2026-09-28 的 7 份孤儿文档**：`specs/2026-09-27-base-selfcheck-design.md`、`specs/2026-09-27-base-mobile-release-design.md`、`specs/2026-09-27-base-comment-event-sync-design.md`、`specs/2026-09-28-base-comment-offline-queue-design.md`、`plans/2026-09-27-base-selfcheck-plan.md`、`plans/2026-09-27-base-mobile-release-plan.md`、`plans/2026-09-28-base-comment-offline-queue-plan.md`。
3. §4 依赖顺序图：`#5 ── #6` 一线补上计划节点。
4. §5 当前阶段：回填本册子与计划的落地状态。

## 10. 风险点

1. **放宽白名单是既有的硬校验**：`packexport` 现在对非 `articles/media_meta/quizzes` 直接报错，放行 `segments` 等于松掉一条护栏。缓解：白名单常量化 + §7.1 第 1 条测试锁住「仍是白名单而非任意表」。
2. **segments 是一条从未打通的链路**：节点导出、节点入库、手机端建表与读取四处全部是新增，任何一处漏改都会表现为「课程页空白」而非报错。缓解：§7.1 第 2 条的往返测试先行，且 §7.2 端到端必须覆盖「同步后可见」。
3. **启发式平移可能误配**：末段相等在多候选时会张冠李戴。缓解：§5.3 第 4 条「多候选即放弃并保留旧行」，宁可留孤儿不错配。
4. **`order` 缺省导致顺序不稳定**：若清单重建不幂等，同一批内容两次导出的 `seq` 可能不同，破坏导出确定性。缓解：§4.2 第 3 条与第 6 条的确定性排序规则。