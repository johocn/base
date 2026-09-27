# base 手机端 v1 发布设计（课程 · 答题 · 我的）

* 日期：2026-09-27

* 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`（唯一上游，冲突时先改总纲）

* 范围：**信息架构（四 tab）· 课程与阅读器 · 答题 · 我的 · 签名升级通道**

* 本册子**不覆盖**：评论与圈子（需先出「事件同步」册子，§7 只做占位页）；「活动」的概念定义（§11）；课程层级建模（#6）；② 类加密与组密钥（总纲排 C 阶段）；本地库加密（#4）

## 0. 改版说明

### 0.1 2026-09-27 初版

**新增（本册子首次定义）：**

* 手机端信息架构：四 tab（**课程 / 圈子 / 评论 / 我的**）+ 若干非 tab 子页（§3）

* 本地新表 `user_state`（收藏 / 已读）、`quiz_attempt`（作答记录）、`quizzes`（题库落地）（§4）

* 题库的**导入格式**与 `question_json` 结构（§6.1）

* 题库的导出与配送（节点侧 `packexport` 增一类表）（§6.2）

* 答题的客户端判分与作答记录口径（§6.4）

* 签名 `release` 文档与 `GET /v1/release`（§8）

* 评论 / 圈子的**占位页**与其阻塞条件（§7）

**明确沿用、不改动：**

* 内容包规范 v1（`manifest.json` 字段与类型），见总纲 §6

* `pack.sqlite` 五张表（`articles` / `segments` / `quizzes` / `media_meta` / `meta`）的列与语义（总纲 §6.2）

* 公开读接口 `GET /v1/catalog` / `/v1/manifest/:pack_id` / `/v1/pack/:pack_id` / `/v1/blob/:blob_id`（总纲 §7.3）

* 客户端↔节点**明文 HTTP**（F1 定案，总纲 §12.2）；签名而非传输层是资产完整性的信任来源

* 同步顺序不变量：验签 → 校验 pack → 拉块 → 一次性落库；任一步失败不留半截数据

* S1 已落地的身份与事件骨架（`POST /v1/event` 等）——本册子**不使用**它们

### 0.2 2026-09-27 与初稿的差异

本册子替代同日初稿（初稿的导航为「内容 / 搜索 / 收藏 / 设置」）。差异有三处，均为用户定案：

1. **导航改为四 tab：课程 / 圈子 / 评论 / 我的**。设置从 tab 降为「我的」的子页；搜索从 tab 降为课程页的入口；收藏从 tab 降为「我的」的子页。
2. **新增「答题」**：题库锚定 `item_id`，随内容包分发，本地判分，**零上行**。
3. **圈子 / 评论本版只做占位页**：这两个 tab 的真实内容依赖尚未实现的事件同步与 ② 类加密（§7、§11）。

## 1. 范围与不做什么

**做六件事：**

1. 信息架构：四 tab + 子页，一次定型。
2. 课程：文章列表（现有）、搜索、阅读器排版、收藏与已读。
3. 答题：题库导入 → 导出 → 配送 → 本地答题判分 → 作答记录。
4. 我的：学习记录、收藏入口、设置入口、当前版本。
5. 圈子 / 评论：占位页，明确写明未开放及其原因。
6. 升级通道：节点签发 `release` 文档，App 验签比对版本并提示下载。

**明确不做：**

* **不做评论与圈子的真实功能**（§7 只做占位页）。它们需要「事件同步」册子（事件类型登记、事件读接口、评论正文的 blob 上行写接口、反熵传播、审核），圈子还要再叠成员名单与组密钥。本册子不设计其中任何一步。

* **不做 markdown 解析**（App 侧）。正文按段落渲染；题库的 markdown 解析发生在**节点侧的导入命令**里，App 只接收结构化 `question_json`（§6.1）。

* **不做答题结果上报**：全部本地（这是 §4 与总纲 §8.1 `progress` 分离的直接结果）。

* **不做滚动位置恢复**：只做「已读」标记与顶部进度条。

* **不做全站深色主题**：只作用于阅读器页。

* **不做 FTS5**：内容量在几十至几百篇时 `LIKE` 足够，不赌 Android 系统 SQLite 是否编入 FTS5。

* **不做 wgt 资源包热更新**：service/view 版本错配的排查成本高于它省下的那次装机。

* **不做 App 内下载 APK 与** **`plus.runtime.install`**：本版走浏览器打开下载链接（§8.5）。

* **不做账号 / 设备身份上行**：本册子不产生任何上行写请求。

* **不做 tabBar 图标**：本版纯文字；补图标是同处配置改动，不预留结构。

* 不做节点侧分发与反熵的任何改动（除 §6.2 导出增一类表、§8.3 新增一个只读接口）。

## 2. 契约边界

### 2.1 不可改（任何实现都不得偏离）

| 项                | 约束                                                                              | 出处           |
| ---------------- | ------------------------------------------------------------------------------- | ------------ |
| 客户端↔节点传输         | **明文 HTTP**，不引入 TLS/HSTS                                                        | 总纲 §12.2（F1） |
| 公开读四接口           | 路径、响应结构、`ETag` 语义不变                                                             | 总纲 §7.3      |
| `manifest` 签名字节  | `canonicalize(去掉 signature)`；对象**键**必须 ASCII、数字必须为有限整数                          | 总纲 §6.4      |
| `pack.sqlite` 五表 | 表名与列不变；`quizzes(item_id, question_json, content_hash)` 按节点侧现状                   | 总纲 §6.2      |
| 行级校验口径           | 有 `content_hash` 列的表（`articles` / `quizzes`）逐行比对；`media_meta` 无该列，只比块数与 size 之和 | 分发册子 §6.2    |
| 版本裁决             | 内容以签名 `content_version` 为准，大者胜                                                  | 总纲 §1、§6.5   |
| 既有本地表            | `config` / `items` / `articles` / `blob_index` / `tombstone` 列不变                | 总纲 §8.1      |

### 2.2 允许新增（v1 之外）

* 本地新表 `user_state`、`quiz_attempt`、`quizzes`（§4）。

* `config` 新键 `reader_theme` / `reader_font_scale`（§4.2）。

* 节点侧 `packexport` 增导出 `quizzes` 一类表；`import-md` 按 `front-matter.type` 分流（不新增子命令）（§6.1、§6.3）。

* 节点只读接口 `GET /v1/release`；命令 `based release`（§8.3）。

* 协议侧新对象 `release` 文档与黄金向量 `vectors/v1/release.json`。

* 手机端页面与 `pages.json` 的 `tabBar` 段（§3）；手机端 `src/core/update.ts`、`src/core/quiz.ts`。

### 2.3 与总纲 §8.1 `progress` 的关系（定案）

总纲 §8.1 已有 `progress(item_id, position, updated_at, dirty)`，语义是**学习进度**，`dirty` 标志意味着它最终要向上报（归 #7–#10）。本册子的 `user_state` 与 `quiz_attempt` 只服务本地体验（收藏 / 已读 / 作答），**不写** **`dirty`、不参与任何上报**。

三者**不合并**：合并后同一张表里会同时存在「纯本地私有」与「待上报、需冲突合并」两种语义，后续 #7 落地时必须做数据迁移与语义拆分。分开建表，代价是几张空表。

### 2.4 客户端 `quizzes` 表的一处文档回填

总纲 §8.1 把客户端表列为 `quizzes(item_id, question_json)`，节点侧为 `quizzes(item_id, question_json, content_hash)`。客户端必须能逐行校验签名 manifest 声明的 `content_hash`（分发册子 §6.2），故本册子按**节点侧同形**建客户端表，即多一个 `content_hash` 列。这属「补文档」：总纲 §8.1 的那一行应同步补上该列，不改任何既有语义。

## 3. 信息架构与路由

`pages.json` 的 `pages` 顺序即启动页与 tab 顺序：

| # | 路径                        | tabBar 文字 | 说明                                                 |
| - | ------------------------- | --------- | -------------------------------------------------- |
| 1 | `pages/course/course`     | 课程        | 现有 `pages/index/index` 改名 + 扩容：文章/题库列表 + 同步 + 搜索入口 |
| 2 | `pages/circle/circle`     | 圈子        | 本版**占位页**（§7）                                      |
| 3 | `pages/comment/comment`   | 评论        | 本版**占位页**（§7）                                      |
| 4 | `pages/mine/mine`         | 我的        | 学习记录 + 收藏入口 + 设置入口（§5.3）                           |
| 5 | `pages/article/article`   | ——        | 非 tab，`navigateTo`                                 |
| 6 | `pages/quiz/quiz`         | ——        | 非 tab，答题                                           |
| 7 | `pages/favorite/favorite` | ——        | 非 tab，从「我的」进入                                      |
| 8 | `pages/setting/setting`   | ——        | 非 tab，从「我的」进入                                      |
| 9 | `pages/search/search`     | ——        | 非 tab，从课程页搜索框进入                                    |

`tabBar` 配置（不配 `iconPath` / `selectedIconPath`，纯文字）：

```json
{
  "color": "#888888",
  "selectedColor": "#2b6cb0",
  "backgroundColor": "#ffffff",
  "borderStyle": "black",
  "list": [
    { "pagePath": "pages/course/course", "text": "课程" },
    { "pagePath": "pages/circle/circle", "text": "圈子" },
    { "pagePath": "pages/comment/comment", "text": "评论" },
    { "pagePath": "pages/mine/mine", "text": "我的" }
  ]
}
```

两条硬约束（uni-app 平台行为，不是设计选择）：

1. **tab 页之间只能用** **`uni.switchTab`**。`navigateTo` / `redirectTo` 指向 tab 页会失败。
2. **tab 页不能带 query 参数**。详情页一律 `navigateTo`。

改名成本：`pages/index/index` → `pages/course/course`。这会让**已装机旧版的启动页路径消失**——但旧版本来就要靠装新包升级，不做兼容跳转。

## 4. 本地数据层

### 4.1 新表

`SCHEMA_SQL` 追加三条 `CREATE TABLE IF NOT EXISTS`，对已有库是幂等增量，**不需要迁移脚本**：

```sql
CREATE TABLE IF NOT EXISTS user_state (
  item_id      TEXT PRIMARY KEY,
  favorited_at TEXT,   -- ISO8601，NULL = 未收藏
  read_at      TEXT    -- ISO8601，NULL = 未读
);

CREATE TABLE IF NOT EXISTS quizzes (
  item_id       TEXT PRIMARY KEY,
  question_json TEXT NOT NULL,
  content_hash  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quiz_attempt (
  item_id      TEXT NOT NULL,
  answered_at  TEXT NOT NULL,
  correct      INTEGER NOT NULL,
  total        INTEGER NOT NULL,
  PRIMARY KEY (item_id, answered_at)
);
```

* 不出现在 `user_state` 里的 `item_id` 等价于「未收藏、未读」。

* 取消收藏 = `favorited_at` 置 `NULL`（不删行，保留 `read_at`）。

* 收藏列表 `user_state INNER JOIN items`：条目被节点撤下（tombstone 删 `items` 行）后收藏自动消失；重新发布则自动回来。

* `quiz_attempt` **每次作答插一行**（不覆盖），正确率 = `SUM(correct) / SUM(total)`，可重复作答刷分，这是「学习记录」的原始数据。

### 4.2 阅读偏好

放现有 `config` k/v，不新增表：

| 键                   | 取值                         | 缺省      |
| ------------------- | -------------------------- | ------- |
| `reader_theme`      | `light` / `dark`           | `light` |
| `reader_font_scale` | `1` / `2` / `3`（小 / 中 / 大） | `2`     |

读取时任何非预期取值一律回落缺省值（不做校验报错）。

### 4.3 repo 新增方法

| 方法                                                                         | 语义                                     |
| -------------------------------------------------------------------------- | -------------------------------------- |
| `toggleFavorite(itemId, at): Promise<boolean>`                             | 取反并返回新状态（`true` = 已收藏）                 |
| `isFavorite(itemId): Promise<boolean>`                                     | ——                                     |
| `listFavorites(): Promise<{itemId, title, favoritedAt}[]>`                 | `favorited_at DESC`，`INNER JOIN items` |
| `markRead(itemId, at): Promise<void>`                                      | 幂等；已读不覆盖（保留首次时间）                       |
| `searchArticles(q): Promise<ArticleRow[]>`                                 | 见 §5.2                                 |
| `upsertQuizzes(rows, ...)`                                                 | 随 `applyPack` 一起落库（与 `articles` 同批次）   |
| `listQuizItems(): Promise<ItemRow[]>`                                      | `type === 'quiz'` 的条目                  |
| `getQuiz(itemId): Promise<QuizRow \| null>`                                | ——                                     |
| `addAttempt(itemId, correct, total, at): Promise<void>`                    | ——                                     |
| `learningStats(): Promise<{readCount, quizAttempts, correctRate, lastAt}>` | 供「我的」展示                                |

## 5. 课程 · 阅读器 · 我的

### 5.1 课程（`pages/course/course`）

* 列表：`listItems()`，按 `type` 分两组展示 —— 文章（进阅读器）与测验（进答题页）。

* 顶部：搜索框（只读，点击 `navigateTo` 搜索页，不在本页做输入）。

* 同步按钮与提示/错误行：沿用现有 `doSync` 逻辑与文案。

* 条目元信息沿用现状（`itemId · rev`）。

* 空态：「还没有内容，点「同步」从节点拉取」。

### 5.2 搜索（`pages/search/search`）

* 交互：输入即搜（`@input` 触发），纯本地查询，零网络。

* 查询（占位符只用匿名 `?`，因为 `sqlWithParams` 是单遍替换、不支持 `?1` 编号形式；同一模式串出现三次即传三个参数）：

```sql
SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev
FROM articles
WHERE title LIKE ? ESCAPE '\' OR body_md LIKE ? ESCAPE '\'
ORDER BY (title LIKE ? ESCAPE '\') DESC, published_at DESC
LIMIT 50
```

* 转义（必做）：模式串 = `'%' + escapeLike(q) + '%'`，`escapeLike` 把 `\` → `\\`、`%` → `\%`、`_` → `\_`。否则输入一个 `%` 会命中全部内容、`_` 会匹配任意单字符。

* 空输入：直接返回空数组，**不发查询**。

* 结果项：标题 + `digest`；点击进阅读器。

* 空态分两种：本地无内容 → 「还没有内容，先去课程页同步」；有内容但无命中 → 「没搜到」。

* 搜索域是 `articles` 表（含正文），与阅读器的数据来源一致。

### 5.3 我的（`pages/mine/mine`）

| 区块   | 内容                                                                |
| ---- | ----------------------------------------------------------------- |
| 学习记录 | 已读篇数 · 答题正确率（`SUM(correct)/SUM(total)`，无作答显示 `-`）· 最近学习时间         |
| 收藏   | 入口 → `pages/favorite/favorite`                                    |
| 设置   | 入口 → `pages/setting/setting`（节点地址 / 公钥 / 保存 / 能力诊断 / 当前版本 / 检查更新） |

* 无任何身份展示（本版不启用身份）。

* `onShow` 重算学习记录（从阅读器或答题页返回要立刻反映）。

### 5.4 收藏（`pages/favorite/favorite`，非 tab）

* `listFavorites()`，`favorited_at DESC`；结果项：封面缩略 + 标题 + 收藏时间。

* 空态：「还没有收藏，在文章页点收藏会出现在这里」。

* 点击进阅读器；`onShow` 重新加载（从阅读器取消收藏返回后立刻消失）。

### 5.5 阅读器（`pages/article/article`，非 tab）

自上而下：封面图（`cover:<slug>` blob，缺失则整块不渲染）→ 标题 / 发布时间 / tags → 操作行（**收藏**、**A** 循环切字号、**主题** 切换）→ 正文段落（沿用 `\n\n` 切分 + 去空段）→ 顶部 1px 阅读进度条（滚动比例，纯前端，不落库）。

* 进入即 `markRead(itemId, now)`，`read_at` 只写首次。

* 字号三档映射正文 `font-size`；行距固定 `1.8`；段间距用 `margin-bottom`。

* 深色主题只改本页颜色；tabBar 与其它页保持浅色。

* 收藏切换立即写库，不做二次确认、不做 toast。

* 保留现有 `decodedId` 兜底，以及「本地没有这篇正文，请返回先同步」这条错误文案（同步失败的可观察出口）。

## 6. 答题

### 6.1 题库导入格式（`based import-md` 扩展）

在现有 md 导入管线上扩展：`front-matter` 增加 `type: quiz`，正文按约定语法写题。解析发生在**节点侧**（Go），App 只接收结构化 JSON。

```md
---
type: quiz
slug: what-is-cid
title: 内容寻址小测
tags: 协议, 测验
published_at: 2026-09-27T00:00:00Z
---

### 内容寻址里，一份字节的标识是什么？
- 文件路径
- [x] 内容哈希
- 递增序号
> 标识即哈希，改一个 bit 哈希就变。

### 节点之间需要共识吗？
- [x] 不需要
- 需要
> 不需要：哈希即验真，故不需要共识、也不需要链。
```

语法规则（固定，不做 markdown 通用解析）：

| 元素 | 识别方式                             |
| -- | -------------------------------- |
| 题目 | 以 `### `   起首的行，其文本即题干           |
| 选项 | `- `   起首的行；`- [x] `   表示该项为正确答案 |
| 解析 | `> `   起首的行，可选；同一题内可多行           |

约束与失败语义：

* 每题必须有**恰好一个** `- [x]` 选项；题目/选项缺失、或答案数不为 1 → 该文件整体失败并报错（`import-md: <文件>: <原因>`），不落库、不部分导入。

* **不新增子命令**：在 `import-md` 里按 `front-matter.type` 分流（缺省 `article`，兼容既有种子与新导入）。这是为了让 `seed/` 一个目录既能放文章也能放题库。

* `item_id = lesson:<slug>`、`type = quiz`（与视频条目同口径：`source` 复用已声明枚举，不新增）。命名体系统一切换到路径式归 #6（§11）。

* `content_hash = hex(sha256(question_json 的 UTF-8 字节))`——与 `articles` 同口径（算原始字节，不走 `canonicalize`）。

### 6.2 `question_json` 结构

```json
{
  "schema_version": 1,
  "questions": [
    {
      "q": "内容寻址里，一份字节的标识是什么？",
      "options": ["文件路径", "内容哈希", "递增序号"],
      "answer": 1,
      "explain": "标识即哈希，改一个 bit 哈希就变。"
    }
  ]
}
```

* `answer` 是选项下标（整数）。

* 选项顺序即显示顺序；**不下发打乱指令**（打乱由客户端决定，见 §6.4）。

* 一个 quiz 条目 = 一个题组（`quizzes.item_id` 是主键，`question_json` 内含 N 题）。

### 6.3 导出与配送（节点侧两处改动）

1. `packexport`：`sqlite_table='quizzes'` 的条目与 `articles` 走同一条路径——写 `quizzes` 行 → `content_hash` 进 `merkle_root` → 进 `manifest.entries[]`。
2. 客户端：`readPackArticles` 同级增加 `readPackQuizzes`；`applyPack` 把 `quizzes` 与 `articles` **拼进同一个** **`stmts`** **数组**（同一批次提交）；行级校验按 `content_hash` 逐行比对，口径与 `articles` 完全一致。

不加 `chunks`、不加新块类型：题库是纯文本，整块进 pack。

### 6.4 答题页（`pages/quiz/quiz`，非 tab）

* 进入后一次显示一题；选择项后立即判分并显示对错 + 解析，再点「下一题」。

* 选项显示顺序在本页**打乱一次**（进入时按 `item_id` 派生一个稳定种子，避免同题每次顺序都变），正确答案按下标映射回去。

* 全部答完 → 结算页：`correct / total` + 「重做」。

* 结算时写入一行 `quiz_attempt`（`addAttempt`），**只写一次**（不在每题判分时写，避免半途退出产生半截记录）。

* 空态 / 异常：`question_json` 解析失败或 `schema_version != 1` → 显示「题目格式不支持，请升级节点内容」，不写任何记录。

* 不做计时、不做分数排名、不做错题本（§11）。

## 7. 圈子 / 评论（本版占位页）

两个 tab 页本版只渲染一个占位状态，**不接任何数据源**：

* 顶部一句说明：「本版未开放」。

* 下方写明原因与阻塞项，让用户知道**这不是 bug**：圈子需要节点支持成员名单与加密内容分发；评论需要节点支持内容讨论的读写与同步。

* 不显示订阅按钮、不显示「即将上线」倒计时、不做假数据列表。

* 占位页要能被复用为「可用状态」的壳：将来接入时只替换内容区，页头与 tabBar 不动。

**「活动」的落点（2026-09-27 定案）**：活动（共读、线下聚、打卡）本质是圈子里的一件事，**归入圈子**，不单开 tab、不单开入口。因此四 tab（课程 / 圈子 / 评论 / 我的）保持不变，本册子不为活动新增任何页面或数据表；活动随「事件同步」那本册子落地时，作为圈子内的一类事件出现。

**阻塞项（本册子不设计，逐条记录以便后续册子接手）：**

| 缺什么                | 现状                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------ |
| 事件类型登记             | `handleEventPost` 的 `knownEventTypes` 为空 → 一切 `POST /v1/event` 返回 400 `event_type_unknown` |
| 事件读接口              | **没有**。节点只有 `POST /v1/event`，客户端拿不到别人写的评论                                                  |
| 评论正文上行             | blob 只有 `GET`/`HEAD`，**没有写接口**                                                             |
| 事件传播               | 反熵目前只搬内容包与块，不搬事件                                                                           |
| 审核                 | 总纲定「先发后审（仅 ① 类）」，未实现                                                                       |
| 圈子成员 / 组密钥 / ② 类加密 | 总纲排 C 阶段，零实现                                                                               |

## 8. App 升级通道

### 8.1 约束来源

`release` 是**签名文档**，签名字节口径与 `manifest` 一致：`canonicalize(payload)`，其中 payload = 文档去掉 `signature`。由此继承两条硬约束：

* 对象**键**必须 ASCII（`canonicalize` 对非 ASCII 键直接抛错）；

* 数字必须是**有限整数**，不得用浮点。

值的限制只有一条要注意：**中文值没问题**——`manifest.entries[].title` 本身就是中文且真机验签已通，故 `notes` 可以直接进签名载荷，不需要拆到签名之外。

### 8.2 `release` 文档

```json
{
  "payload": {
    "schema_version": 1,
    "issuer": "base-node-1",
    "issued_at": "2026-09-27T00:00:00Z",
    "version_name": "0.2.0",
    "min_version_name": "0.1.0",
    "apk_url": "http://node.example.com/dl/base-0.2.0.apk",
    "apk_size": 12345678,
    "apk_sha256": "<64 hex>",
    "notes": "课程、答题与我的；四 tab 定稿"
  },
  "signature": "<128 hex>"
}
```

| 字段                 | 类型     | 语义                         |
| ------------------ | ------ | -------------------------- |
| `schema_version`   | int    | 固定 `1`，不符即判为不可用            |
| `issuer`           | string | 签发方标识                      |
| `issued_at`        | string | 签发时间（人可读）                  |
| `version_name`     | string | 最新版本名，三段数字 `x.y.z`         |
| `min_version_name` | string | 最低可用版本；本地低于它 → 强制更新        |
| `apk_url`          | string | APK 下载地址（绝对 URL）           |
| `apk_size`         | int    | APK 字节数                    |
| `apk_sha256`       | string | APK 的 sha256（64 hex），供人工核对 |
| `notes`            | string | 版本说明，**参与签名**，允许中文         |

`payload` 与 `signature` 分离（而非像 `manifest` 那样平铺 + 去字段）的原因：`notes` 是自由文本，平铺 + 去字段的口径要求签名方与验签方对「哪些字段参与」有完全一致的隐含约定，容易漂移；显式包一个 `payload` 对象后，签名域就是它的字面内容。

### 8.3 节点侧

**`GET /v1/release`**（公开读路由，挂在客户端监听上）

* 读 `<data>/release.json` 原样吐出（`Content-Type: application/json`）。

* 文件不存在 → **404**。App 把 404 当作「本节点无升级信息」，静默忽略。

* 节点不验签、不缓存、不合成：只把签发好的文件读出来。

**`based release`**（离线命令，在源节点机器上跑）

```
based release -version-name 0.2.0 [-min-version-name 0.1.0] -apk-url <url> -apk-file <本地 apk 路径> [-notes <文本>] [-out <path>] [-data <dir>]
```

* 从 `-apk-file` 计算 `apk_size` 与 `apk_sha256`（避免手填出错）。

* 用**源节点私钥**（与签发 manifest 同一把）对 `payload` 签名，写 `<data>/release.json`（`-out` 可覆盖）。

* 幂等：重复执行覆盖写，不追加历史。

### 8.4 客户端流程与失败语义

触发点：`onLaunch` 一次 + 设置页「检查更新」按钮。

1. `GET {nodeBaseUrl}/v1/release`。
2. 200 → 解析 → 用**装机时已填的节点公钥**（`config.pubkey_hex`）验签。
3. `plus.runtime.version` 与 `version_name` / `min_version_name` 做**三段数值比较**（按 `.` 切分，段数不等时缺位按 0；任一段非数字则该文档判为不可用）。
4. 判定：

| 情形                                             | 行为                       |
| ---------------------------------------------- | ------------------------ |
| 验签失败 / `schema_version != 1` / 版本串不合法          | 静默丢弃（可能是被篡改，也可能是未来版本）    |
| 网络失败 / 404 / 未配节点地址与公钥                         | 静默丢弃                     |
| `version_name <= 本地`                           | 无提示；设置页结果行显示「已是最新 0.1.0」 |
| `version_name > 本地` 且 `min_version_name <= 本地` | 可取消弹窗：说明 + 「去下载」/「以后再说」  |
| `version_name > 本地` 且 `min_version_name > 本地`  | 不可取消弹窗：只有「去下载」           |

**红线：升级通道的任何失败都不得阻断 App 使用。** 不弹错误框、不写 `error` 状态、不拦启动流程。节点是明文 HTTP，升级通道被中间人破坏的概率不为零，不能让它成为一个可被用来 DoS 客户端的入口。

### 8.5 下载方式与残余风险

弹窗确认后 `plus.runtime.openURL(apk_url)`，交给系统浏览器 / 下载器。

**残余风险（明确记录，不粉饰）**：App 无法校验下载到的 APK 字节，Android 的「安装未知应用」流程也不做完整性校验。因此一个主动的中间人可以：

* **不能**改 `apk_url`（它在签名载荷里）——无法把用户引到自己的服务器；

* **能**在用户从本节点下载 APK 的过程中替换 APK 字节。

缓解手段只有两个：设置页展示 `apk_sha256` 前 16 位供人工核对；以及实际的网络环境。彻底堵住需要 §1 明确不做的「App 内下载 + 校验 + `plus.runtime.install`」，留待下版评估。

## 9. 发布流程

1. HBuilderX 云打包出 APK（`manifest.json` 里 `versionName` / `versionCode` 递增）。
2. APK 上传到节点机器的静态目录（URL 前缀见 §11）。
3. 在节点机器上跑 `based release -version-name <新版本> -apk-file <上传后的 apk 路径> -apk-url <公网 URL>`。
4. 手机装新版 → 设置页「检查更新」应显示「已是最新」。
5. 反向验证：把 `release.json` 的 `version_name` 改成更高版本（应弹更新框）；改 `signature` 一位（应静默拒绝）。

## 10. 验收

| #  | 验收项    | 判定                                                                                                                      |
| -- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| 1  | 四 tab  | 装机后四个 tab 可互相切换；从任一 tab 进详情再返回，回到原 tab；无 tab 用 `navigateTo` 的报错                                                         |
| 2  | 占位页    | 圈子 / 评论 两页显示未开放说明，无报错、无假数据                                                                                              |
| 3  | 搜索     | 输入正文中出现过的词 → 命中；输入 `%` → 不返回全部；输入空串 → 结果为空且响应即时                                                                         |
| 4  | 收藏     | 收藏 → 「我的 → 收藏」出现；取消 → 立即消失；杀进程重进仍保持；文章被撤下并同步后自动消失                                                                       |
| 5  | 阅读器    | 字号三档与深色主题重启后均保持；进入文章后 `read_at` 只写首次                                                                                    |
| 6  | 题库配送   | 导入 1 个题库 → 导出 pack 后 `manifest.entries[]` 出现 `sqlite_table='quizzes'` 的条目；客户端同步后课程页出现该测验                                |
| 7  | 答题     | 全部答对 → 结算 `n/total` 正确；一次作答只写 **一行** `quiz_attempt`；重做后正确率按累计计算；题目格式非法 → 提示不支持且不写记录                                     |
| 8  | 我的     | 学习记录的已读篇数与正确率与实际操作一致；从阅读器/答题页返回后立即刷新                                                                                    |
| 9  | 升级·正常  | 节点 `release.json` 版本高于本地 → 弹可取消框；点「去下载」能打开 `apk_url`                                                                    |
| 10 | 升级·强制  | `min_version_name` 高于本地 → 弹不可取消框                                                                                        |
| 11 | 升级·拒绝  | 改 `signature` 一位 / 改 `version_name` 后不重签 → 静默无提示，App 正常可用                                                               |
| 12 | 升级·可用性 | 节点宕机 / 未配公钥 → 启动与设置页均不出现任何升级相关错误                                                                                        |
| 13 | 离线不回归  | 飞行模式下：课程列表、搜索、收藏、阅读器、答题全部可用                                                                                             |
| 14 | 单测与向量  | §4.3 各方法、`escapeLike` 与 `searchArticles`、题库解析（含非法题库拒绝）、`release` 验签与版本比较全绿；`vectors/v1/release.json` 在 Go 与 TS 两侧同时消费通过 |

## 11. 风险与红线

1. **升级通道是唯一的新入口，且跑在明文 HTTP 上**：处置 = 签名 + 静默失败（§8.4）。任何让升级检查阻断启动或弹出错误框的实现都视为红线。
2. **APK 字节无端到端校验**（§8.5）：本版接受的取舍；下版若要堵，须走 App 内下载 + 校验 + `install`。
3. **`min_version_name`** **是单点**：一旦签发一个高于现状的值，所有老客户端立刻被强更拦住。签发命令不提供默认值，必须显式传；它进签名载荷，改它必须重新签发。
4. **两个占位 tab 是产品风险**：四个 tab 里有两个是空的，用户可能判定为「坏了」。处置 = 占位页必须写清原因（§7），且圈子/评论的真实能力优先于任何新的内容功能。
5. **答题的题库管线是新的**：`import-md` 分流 → `packexport` → 客户端落库 → 判分，四段都要通才算可用；任何一段缺失都表现为「课程页看不到测验」，容易被误判为同步故障。处置 = 验收 6 单列一项。
6. **搜索的** **`LIKE`** **全表扫描**：正文总量进入几十 MB 量级后会变慢。届时处置优先级是「先在 `title` 上查，无命中再查 `body_md`」，而不是直接上 FTS5。
7. **`user_state`** **/** **`quiz_attempt`** **换机即丢**：这是 §2.3 的定案，不是缺陷。
8. **tabBar 纯文字的观感**：本版刻意接受；补图标是同处配置改动。
9. **`pages/index/index`** **→** **`pages/course/course`** **改名**：旧装机版本的启动页路径消失。不兼容旧版（旧版靠装新包升级）。

## 12. 待定与未闭环

* **「活动」是什么**：本册子无法定义。需要先明确形态（打卡挑战？报名？线上讲座？截止时间？参与记录？）才能定数据模型。自然落点是课程页顶部的一个入口或「我的」里的一项，**本版不建空入口**。

* **评论 / 圈子册子**：§7 的阻塞项清单即是该册子的大纲。事件读接口的形状（全量？按 `item_id` 分页？游标？）需要与反熵传播一并设计。

* **课程层级（course → lesson → 载体）**：归 #6；本册子沿用 `<source>:<slug>` 命名，届时统一切换为路径式。

* **错题本与答题记录上报**：本版只做本地正确率；错题本（`quiz_attempt` 需细化到每题）与上报（`dirty` 语义）分别归各自册子。

* **静态目录的 URL 前缀**：APK 在服务器上的目录与 nginx `location` 的对应关系尚未进仓库（当前只存在于服务器）。落地时确认后写入本节，并让 §9 用真实 URL。

* **`payload.issuer`** **的校验**：本版只作人可读标识，验签**不**校验它与节点公钥的绑定（`manifest.issuer` 由 `derived_pack_id` 间接绑定）。严格绑定需要 `pubkey_hex → issuer` 的映射来源，本版不做。

* **`notes`** **的展示形态**：弹窗里直接显示纯文本，不做换行与长度限制，超长会截断。

* **`versionCode`** **不参与判定**：Android 的 `versionCode` 只影响系统升级安装，App 侧判定只用 `version_name` 三段比较。两处必须人工保持同步递增。

* **选项打乱的稳定种子**：§6.4 用「按 `item_id` 派生」保证同题顺序稳定；具体派生方式（哈希取模 vs 简单累加）实现时定，不属契约。

