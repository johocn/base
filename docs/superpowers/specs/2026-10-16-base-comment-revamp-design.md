# base 评论改版：对象跳转与类型过滤设计

* 日期：2026-10-16

* 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`（唯一上游，冲突时先改总纲）

* 直接上游：

  * `specs/2026-09-27-base-comment-event-sync-design.md`（评论事件模型、公开读接口）

  * `specs/2026-09-28-base-comment-offline-queue-design.md`（离线队列与待发区，行为全部沿用）

* 范围：评论页改版——评论卡片挂「所属条目」并可点击跳转关联课程/课时/文章；过滤从「具体条目单级」升级为「类型 + 具体条目两级」；节点侧新增评论目标聚合接口与 `kind` 过滤参数

* 本册子**不覆盖**：评论事件协议（comment.v1 不动）、写入路径、墓碑机制、离线队列行为、点赞 / 举报、楼中楼树、课程详情与文章页既有评论入口

## 0. 定案记录（2026-10-16 问答结论）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 列表排序口径 | **最新发表在前（现状）**；评论不可编辑，无「更新时间」概念 |
| 2 | 过滤形态 | **类型 + 具体条目两级**：第一排类型 chips，第二排条目 chips + 搜索框 |
| 3 | 二级条目收敛 | **只列有评论的条目**（带评论数角标）+ 标题搜索；数据来自节点聚合接口，一次到位 |
| 4 | 数据来源方案 | **方案 B**：节点加聚合接口 + `kind` 过滤下推；客户端薄，分页准确 |
| 5 | 跳转降级 | 本地 catalog 查不到目标条目 → toast「该内容不可用」，**不跳转** |
| 6 | 发评论约束 | **必须有具体对象**：选中条目 chip 才启用输入框；类型不是合法评论对象 |
| 7 | 发版口径 | 客户端与节点二进制都发；版本号实施时定 |

## 1. 目标与判定

| # | 目标 | 判定 |
|---|---|---|
| 1 | 每条评论可见其所属内容 | 评论卡片正文下有「→《所属条目标题》」行 |
| 2 | 点击评论进入关联内容 | 点正文或所属行：课程→课程详情、课时→课时详情、文章→文章页 |
| 3 | 按类型过滤 | 选「课程 / 课时 / 文章」后列表只剩该类型目标的评论，分页正常 |
| 4 | 二级条目快速定位 | 第二排只出现有评论的条目（评论数角标），搜索框按标题过滤 chips |
| 5 | 目标不可用不误导 | 本地无该条目 → toast 提示，停留原页 |

## 2. 节点侧（Go）

### 2.1 聚合接口 `GET /v1/comment/targets`

匿名读（与 `/v1/comment` 同级，无签名要求）。store 层一条 GROUP BY：

```sql
SELECT e.target_id, i.type AS kind, i.title,
       COUNT(*) AS cnt, MAX(e.created_at) AS last_at
FROM events e
JOIN items i ON i.item_id = e.target_id
WHERE e.type = 'comment.v1'
  AND NOT EXISTS (SELECT 1 FROM comment_tombstone t WHERE t.event_id = e.event_id)
GROUP BY e.target_id
ORDER BY last_at DESC
```

响应：`{ "targets": [ { "target_id", "kind", "title", "count", "last_at" } ] }`

要点：

* **JOIN 不到 items 的 target 不进聚合结果**——条目已被治理删除的，不进二级 chips（点了也跳不过去）；这类条目的评论仍出现在普通评论列表（客户端点击时降级提示），评论数据独立于条目存亡的事件模型不变

* 墓碑排除与 `ListComments` 同口径

* `kind` 取值域 = items.type = `course | lesson | article`（评论的 target 不会是 quiz 等叶子载体吗——是可能存在的，此类行照实返回 type，客户端类型 chips 只映射三类，其余类型评论归入「全部」视图但不设独立 chip）

### 2.2 列表接口扩参 `GET /v1/comment?kind=`

`ListComments` 增加同样的 JOIN，`kind` 非空时追加 `AND i.type = ?`。游标、排序、`target_id` 参数全部不变。`kind` 与 `target_id` 可同传（类型内再选具体条目时客户端只传 `target_id`，本参数主要服务纯类型过滤视图）。

### 2.3 不做

* 不动 `POST /v1/event`、身份、限速、墓碑传播

* 不在列表 DTO 里联表返回 title（所属行标题由客户端聚合数据 + 本地 catalog 兜底解析）

## 3. 客户端 core-ts

* `listCommentTargets(o: CommentOptions)`：调聚合接口，解析为 `CommentTargetRow[] { targetId, kind, title, count, lastAt }`；失败抛 `CommentError`（同 `listComments` 风格）

* `listComments` 增加可选 `kind` 参数，拼查询串（沿用「手拼查询串」约定）

* 纯函数 `lessonParentCourseId(targetId: string): string | null`：`decodeSafe(targetId)` 后按容器 id 形态解析——4 段 `course/<cid>/lesson/<lid>` → 返回 `course/<cid>`；其余返回 null

## 4. 评论页交互（comment.vue）

### 4.1 过滤区（两排）

* 第一排类型 chips：`全部 / 课程 / 课时 / 文章`。选中非「全部」→ 列表请求带 `?kind=`，分页重置；类型 chips 与条目选择互斥生效（选类型清空条目选择，选条目按 `target_id` 过滤并保持类型 chip 状态仅作视觉）

* 第二排条目区：搜索框（标题子串过滤 chips）+ 条目 chips（标题 + 评论数角标，超长截断），数据来自聚合接口，按当前类型预过滤，最近评论时间倒序

* 聚合接口失败：第二排显示「条目列表加载失败 · 重试」，第一排与评论列表不受影响

### 4.2 评论卡片「所属行」与跳转

* 正文下小字一行：`→《所属条目标题》`；标题优先取聚合数据，聚合未覆盖（分页内新出现）时查本地 catalog，再不行显示 target_id

* 点击正文或所属行跳转：

| kind | 跳转 |
|---|---|
| course | `/pages/course/detail?courseId=<target_id>` |
| lesson | `/pages/lesson/detail?lessonId=<target_id>&courseId=<lessonParentCourseId 解析值>`；解析失败按不可用处理 |
| article | `/pages/article/article?itemId=<target_id>` |

* 跳转前本地 catalog 查目标条目，查不到 → toast「该内容不可用」，不跳

### 4.3 发评论与既有行为

* 输入框启用条件维持「选中具体条目」（target !== ''）；类型 chips 不改变 target

* 待发区、点赞、举报、楼中楼、昵称降级、`setPendingTarget` 锚定入口、刷新 / 触底分页：全部不动

## 5. 错误处理

| 场景 | 处置 |
|---|---|
| 聚合接口失败 | 二级区局部错误 + 重试；列表照常 |
| `?kind=` 列表失败 | 现有列表错误逻辑（错误文案 + 重试） |
| 课时解析不出父课程 / 本地查不到条目 | toast「该内容不可用」 |
| 聚合与列表 target 集合短暂不一致 | 允许；所属行标题按「聚合 → 本地 catalog → target_id」三级降级 |

## 6. 测试

* Go：store 聚合查询（分组计数 / last_at 排序 / 已删条目排除 / 墓碑排除）、handler 路由与 JSON 形、`ListComments` 的 kind 过滤

* core-ts：`listComments` kind 拼串、`listCommentTargets` 解析与错误映射、`lessonParentCourseId`（合法 / 扁平 id / 坏编码）

* mobile 门禁三连：`vue-tsc --noEmit` / `vitest run` / `build:h5`

## 7. 验收清单（真机）

1. 评论页默认「全部」：所有评论按时间倒序，每条可见所属条目
2. 点课程评论 → 课程详情；点课时评论 → 课时详情（父课程正确）；点文章评论 → 文章页
3. 选「课时」类型 → 列表只剩课时评论；二级 chips 只剩有评论的课时
4. 搜索框输入标题关键字 → 条目 chips 即时收敛
5. 目标条目被删（或本地无）的评论 → 点击 toast 不跳
6. 未选条目不能发评论；从课程/文章详情页锚定进评论页，行为不回归
7. 待发队列 / 点赞 / 举报 / 楼中楼不回归
