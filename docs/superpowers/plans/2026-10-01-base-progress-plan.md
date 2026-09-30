# 学习进度与打卡（`progress.v1`）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 B 交流互动主线的最后一条形态——让学习者**离线也能记录**「学到哪 / 学完没」，联网后自动补发；跨设备、跨节点收敛到同一份进度；并由学习行为**自动**派生每日打卡与连续天数。

**Architecture:** 新增事件类型 `progress.v1`（`body = {item_id, position, done, day}`，**不带正文块**）。节点侧**一条事件、两张投影表**（`progress` + `checkin_days`，**同一事务**写入），`GET /v1/me` 三数组接真；手机端同构两张本地表，离线复用既有 `comment_out` 队列（`wire` 自带 type，**不加列**），补发走 `core/comment.ts#flushPending`。`position` 归一化与 LWW 判据是**双端写死口径**，由新增契约向量 `vectors/v1/progress.json` 约束 Go / TS 两份实现防漂。

**Tech Stack:** Go（`internal/protocol`、`internal/store`、`internal/httpapi`、`internal/peersync`）／ TypeScript + Vue 3 + uni-app（`apps/mobile`）／ vitest ／ `vectors/v1/*.json` 双端契约向量。

**上游 spec:** [2026-10-01-base-progress-design.md](file:///e:/code/base/docs/superpowers/specs/2026-10-01-base-progress-design.md)（本册，已定稿）；总纲 [2026-09-25-base-distributed-learning-design.md](file:///e:/code/base/docs/superpowers/specs/2026-09-25-base-distributed-learning-design.md) §0.11 / §9 / §10。

---

## 1. 开工前已核实的现状（执行时不要重新调研，直接用）

| 事实 | 位置 |
| --- | --- |
| 事件类型白名单是包级 map `eventTypeRegistry`（现 4 类型）；注释明示「新增类型 = 在此加一行 + 在 `handleEventPost` 的 switch 里加一个分支」 | `internal/httpapi/event.go:23-30` |
| `POST /v1/event`：先查 `s.knownEventTypes`（未知 → `400 event_type_unknown`），再校验 `event_id` 16 hex + `created_at > 0`（否则 `400 event_param_invalid`），再双维度限速（身份 30/min burst 10、IP 120/min burst 30，超限 `429 event_rate_limited`），最后按 type switch 分流 | `internal/httpapi/event.go:43-77` |
| 验签共用件 `verifyEventSig(w, actor, req, rawBody)`：canonicalize `{event_id,type,created_at:req.CreatedAt,body:rawBody}`，`isHexN(req.Sig,64)` + `LookupIdentity` + `protocol.Verify` | `internal/httpapi/event.go:168-198` |
| `validTargetID(s)`：ASCII、1..256 字节（路径式命名空间） | `internal/httpapi/event.go:242-252` |
| 严格键集工具 `onlyKeys(m, allowed)`；body 值容错取值 `anyString(v)`；整数取值 `jsonInt(v)` | `internal/httpapi/govern_event.go:26`、`:37`、`internal/httpapi/group.go:306` |
| `handleGovernEvent` 顺序：`parseGovernBody` → `verifyEventSig` → **投影** → 事件行 `BodyJSON: string(req.Body)`（**客户端原始键集**）→ 回读 `received_at` → `writeJSON` | `internal/httpapi/govern_event.go:127-185` |
| `GET /v1/me` 现返回写死空数组 `"events": []any{}, "progress": []any{}` | `internal/httpapi/identity.go:238-244` |
| `Store` 结构 `{db *sql.DB; dataDir string; storeKey []byte; storeKeyPath string}`；`Open(dataDir string, opts ...Option)`；`s.db.SetMaxOpenConns(1)` | `internal/store/store.go:24-29`、`:120` |
| store 单测范式 `st, err := Open(t.TempDir())` | `internal/store/quiz_test.go:8`、`contributor_test.go:139` |
| 事务内投影范式（先读水位 → 判幂等 → 判收敛 → 否则静默）`ProjectGovernProposal` + `existingProposalWatermarkTx` | `internal/store/govern_projection.go:50-109` |
| `schemaStatements` 全是 `CREATE TABLE/INDEX IF NOT EXISTS`；末尾为 `tag_links`(L217-225) + `idx_tag_links_target`(L225)；**新表可直接加进去，无后加列迁移需要** | `internal/store/schema.go:12-226` |
| `PutEvent` 幂等落事件行：同 `event_id` 覆盖，`received_at` 保留首值（0 时取本机 now） | `internal/store/event.go:23-37` |
| 按身份读事件的既有排序 `ORDER BY created_at DESC, event_id ASC`（本册 §3.4 的 LWW 口径与它逐字一致） | `internal/store/event.go:63` |
| 反熵 `pullEvents`：`parseEventProjection` → `PutEvent` → `applySyncedGroupEvent`（失败**阻断**）→ `applySyncedGovernEvent`（失败只 log） | `internal/peersync/eventsync.go:83-135` |
| `parseEventProjection(typ, bodyJSON) commentProjection` 现 3 支（comment/group/dm）+ `default` 零值 | `internal/peersync/eventsync.go:211-248` |
| `internal/store/blobs.go` 已 import `internal/protocol` ⇒ **store → protocol 无环**，store 可直接用 `protocol.ProgressWins` | `internal/store/blobs.go:10` |
| Go 向量消费范式：`os.ReadFile(filepath.Join("..","..","vectors","v1","X.json"))` + `Version != 1 || len(Cases)==0 → t.Fatalf` | `internal/protocol/attrs_vector_test.go:9-45` |
| `protocol.Sign(seedHex string, msg []byte) (string, error)`、`protocol.Canonicalize(v any) ([]byte, error)`、`protocol.KeyPairFromSeed(seedHex)` | `internal/protocol/sign.go:32`、`canonical.go:13`、`sign.go:18` |
| httpapi 测试造已签名事件体的范式（payload map + `Canonicalize` + `Sign` + `json.Marshal`） | `internal/httpapi/comment_test.go:49-73` |
| `newFullServer(t)` 用真实 `srv.Handler()`（真路由 + 真鉴权链） | `internal/httpapi/event_test.go:12-31` |
| ⚠️ **破坏点**：`TestEventUnknownTypeRejectedKnownTypePersisted` 用 `"progress.v1"` 当**未知类型**例子（L51/L63/L69/L74） | `internal/httpapi/event_test.go:48-78` |
| `TestMeReturnsEmptyArrays` 现断言 `events` / `progress` 都是长度 0 的 `[]any` ⇒ Task 4 必须改写 | `internal/httpapi/identity_test.go:287-299` |
| peersync 跨节点范式：`newSourceNode(t)` → `openTemp(t)` → `cfg.RunOnce(ctx, dst, []Peer{{URL: url}}, logf)`；种子件 `eventIDHex(i)` | `internal/peersync/eventsync_test.go:20`、`:46-53` |
| 手机端 `SCHEMA_SQL` 无 `progress` / `checkin_days`；末尾 `tag_links`(L141-144)；`ensureGroupColumns`(L151-159) / `ensureSubmissionColumns`(L165-173) 是幂等补列范式 | `apps/mobile/src/core/repo.ts:100-173` |
| `LocalRepo` 接口 30+ 语义方法；`SqlRepo` 用 `this.db.select/execute/tx`（**`tx` 只收写语句数组，不能读**） | `apps/mobile/src/core/repo.ts:18-97`、`:176-554` |
| 行转换器在文件尾（`toNullableString` / `toItemRow` / … / `toMySubmissionRow`） | `apps/mobile/src/core/repo.ts:556-667` |
| `MemoryRepo implements LocalRepo`：每个新方法**必须同步实现**（否则 TS 编译失败） | `apps/mobile/src/core/fakes.ts:42-284` |
| `FakeHttp`：`get(url)` **忽略 headers**；`post(url, body, headers?)` 只记录、从不抛错；`routes` / `postRoutes` | `apps/mobile/src/core/fakes.ts:287-308` |
| `fakeAdapters(http, fs, packReader, storage = new MemoryStorage())` 返回 `{http, fs, packReader, storage}` | `apps/mobile/src/core/fakes.ts:451-458` |
| `bootstrap()`：`for (const sql of SCHEMA_SQL) await db.execute(sql)` → `ensureGroupColumns(db)` → `ensureSubmissionColumns(db)`（**新补列函数的挂载点**） | `apps/mobile/src/platform/index.ts:29-31` |
| `buildEventWire(ident, type, body)` → `{eventId, wire}`，`created_at: Date.now()` 写在 wire 内，**不返回 createdAt** | `apps/mobile/src/core/wire.ts:102-107` |
| `submitWire(o, {eventId, wire, targetId, queueText})`：只有 `CommentError.code === 'network'` 才入 `comment_out`；节点给了任何 HTTP 响应都原样抛出 | `apps/mobile/src/core/wire.ts:113-136` |
| `ensureRegistered(o)`（**已 export**）：本地身份不存在就现建，并保证节点侧已登记（`identity.registered` 标记）；`CommentOptions` 与 `WireOptions` **同形** | `apps/mobile/src/core/comment.ts:116-131`、`wire.ts:28-32` |
| `flushPending(o)` 模块级 `inflightFlush` 去重；`runFlush` 逐条重放 `wire`，成功 `removeCommentOut`、永久失败 `markCommentOutFailed`、其余**中止本轮** | `apps/mobile/src/core/comment.ts:282-326` |
| `signRequestHeaders(ident, {method, path, query?, body?}, ts?)` 返回 5 头；`HttpAdapter.get(url, headers?)` **支持头** | `apps/mobile/src/core/identity.ts:238-258`、`apps/mobile/src/platform/adapter.ts:24-29` |
| `plus.ts` 里 `PlusHttp.get(url, headers?)` 已实现 | `apps/mobile/src/platform/uni.ts:392-394` |
| `article.vue`：`progress` ref + 顶部 2px 细条；`onPageScroll` → `scrolled` → `paintProgress()`；`measure()` 用 `uni.createSelectorQuery().select('.wrap').boundingClientRect()` − `windowHeight`；仅 import `onLoad, onPageScroll` | `apps/mobile/src/pages/article/article.vue:3`、`:68`、`:84-85`、`:89-191` |
| `quiz.vue`：refs `questions/index/picked/correct/finished/itemId`；模板 `{{ index + 1 }} / {{ questions.length }}`；仅 import `onLoad` | `apps/mobile/src/pages/quiz/quiz.vue:5`、`:29`、`:34-81` |
| `course.vue`：三处课程列表（`g.courses` / `unclassified` / `courses`）；`load()` 已建 `segsByItemId`（只含 `type==='course'` 与 `source==='category'`）；仅 import `groupCoursesByCategory, splitCourses` | `apps/mobile/src/pages/course/course.vue:30-64`、`:111-155`、`:82` |
| `mine.vue`：三行 stats 卡 + 各组 navigator；`onShow` 里 `bootstrap()` → `stats` → `pendingCount` → `const o = {adapters, repo, nodeBaseUrl}` → `myIdentityId(o)` / `roster(o)`，异常静默 | `apps/mobile/src/pages/mine/mine.vue:4-8`、`:54-66` |
| `childrenOf(segs)`：取 `seq>=1` 按 seq 升序的 `text`（容器子项 id 清单） | `apps/mobile/src/core/course-tree.ts:22-27` |
| TS 侧向量读法（层深 4）：`new URL('../../../../vectors/v1/X.json', import.meta.url)` | `apps/mobile/src/core/attrs.test.ts:24-40` |
| 手机端版本现值 `0.16.0` / `21` | `apps/mobile/src/manifest.json:5-6` |
| 门禁基线：mobile vitest **28 文件 / 343 用例**全绿 + `tsc --noEmit` + `build:h5` / `build:app` + 模板 `.value` 硬检查；仓库根 `go build ./...` / `go vet ./...` / `go test ./...` | `docs/README.md` §5 |

**环境注意（Windows PowerShell 5.1，无 `pwsh`）：** 不支持 `&&`（用 `;`）与 heredoc（commit 消息写临时文件 + `git commit -F`，或用单行 `git commit -m "..."`）。

**工作区注意：** 工作区有未提交的 ` M .gitignore` 与未跟踪的 `based-linux-amd64`，**不要动、不要 add**。每次提交只 `git add` 本任务涉及的具体文件。

**本册两条口径裁定（写计划时定死，执行时不要另立）：**

1. **`done` 谓词只在 TS 侧实现**（`articleDone` / `quizDone`）——册子 §3.2 表格的「`done` 判定」列表头已写明判据主体是「**客户端：**」，节点只信 `done` 值、不反推（§3.1）。Go 侧实现会成死代码，违反「拒绝冗余」。`position` 归一化 + LWW 判据（`ProgressWins`）**两侧都实现**——§3.4 明文要求双端消费同一向量防漂。
2. **容器完成度分母为 0 时不显示该行**（而非显示「已学 0 / 0 讲」）——§6 那条「分母为 0 时完成度按 0 处理，不显示 `NaN`」是**防 NaN 的实现护栏**，不要求产出 0/0 的文案。

---

## 2. 文件结构（先定边界，再拆任务）

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `internal/store/schema.go` | 修改 | `schemaStatements` 末尾追加 `progress` / `checkin_days` 两表 + `idx_progress_item` |
| `internal/store/progress.go` | 创建 | `ProgressEvent` / `ProgressRow` / `CheckinDayRow`；`PutProgressProjection`（同事务双投影）+ `ListProgressByID` + `CheckinDaysOf` |
| `internal/store/progress_test.go` | 创建 | 首写 / LWW 平局取 event_id 升序 / checkin insert-or-ignore / 同 event_id 幂等 |
| `internal/protocol/progress.go` | 创建 | `ArticlePosition` / `VideoPosition` / `QuizPosition` / `ProgressWins`（**不含 `done` 谓词**） |
| `vectors/v1/progress.json` | 创建 | 双端共用契约向量（position 归一化 + LWW 平局） |
| `internal/protocol/progress_vector_test.go` | 创建 | 消费 `vectors/v1/progress.json` |
| `internal/httpapi/event.go` | 修改 | `eventTypeRegistry` 加 `progress.v1`；`handleEventPost` switch 加分支 |
| `internal/httpapi/progress.go` | 创建 | `progressKeys` / `dayRe` / `validDay` / `parseProgressBody` / `handleProgressEvent` |
| `internal/httpapi/progress_test.go` | 创建 | 放行 + 校验拒绝 + 双投影落库 + `/v1/me` 真数据 |
| `internal/httpapi/event_test.go` | 修改 | 未知类型例子 `progress.v1` → `bogus.v1`（4 处） |
| `internal/httpapi/identity.go` | 修改 | `handleMe` 三数组接真 |
| `internal/httpapi/identity_test.go` | 修改 | `TestMeReturnsEmptyArrays` 改写为「三数组非 null + 真数据」 |
| `internal/peersync/eventsync.go` | 修改 | `parseEventProjection` 加 `progress.v1` 分支；新增 `applySyncedProgressEvent`；`pullEvents` 调用它（阻断式） |
| `internal/peersync/eventsync_test.go` | 修改 | 跨节点 `progress` / `checkin_days` 逐字一致 + 重复投递幂等 |
| `apps/mobile/src/core/progress.ts` | 创建 | 量纲归一化 + LWW + 打卡日/连续天数 + 节流 + 完成度聚合（纯函数） |
| `apps/mobile/src/core/progress.test.ts` | 创建 | 消费同一向量 + 连续天数 + 节流 + done 判定 |
| `apps/mobile/src/core/types.ts` | 修改 | `ProgressRow` / `CheckinDayRow` |
| `apps/mobile/src/core/repo.ts` | 修改 | 两表 DDL + `ensureProgressColumns` + `LocalRepo` 5 方法 + `SqlRepo` 实现 + 2 个行转换器 |
| `apps/mobile/src/core/fakes.ts` | 修改 | `MemoryRepo` 同步实现 5 方法 |
| `apps/mobile/src/core/progress-repo.test.ts` | 创建 | 仓储层语义（LWW 守卫 / 幂等 / checkin 保留首次 / 合并） |
| `apps/mobile/src/core/progress-store.ts` | 创建 | `reportProgress`（本地双写 → 发或入队）+ `pullProgress`（`GET /v1/me` → 合并） |
| `apps/mobile/src/core/progress-store.test.ts` | 创建 | 上报写入 / 节流丢帧 / 离线入队 / 拉取合并 / 吞错 |
| `apps/mobile/src/platform/index.ts` | 修改 | bootstrap 里挂 `ensureProgressColumns` |
| `apps/mobile/src/pages/article/article.vue` | 修改 | 进入续位 + 细进度条读本地 + `onHide`/`onUnload` 上报 |
| `apps/mobile/src/pages/quiz/quiz.vue` | 修改 | 续位到上次题号 + `onHide`/`onUnload` 上报 |
| `apps/mobile/src/pages/course/course.vue` | 修改 | 每门课显示「已学 a / b 讲」 |
| `apps/mobile/src/pages/mine/mine.vue` | 修改 | 进度卡（今日打卡 / 连续天数 / 在学中）+ `pullProgress` + `flushPending` |
| `apps/mobile/src/manifest.json` | 修改 | `0.17.0` / `22` |
| `docs/README.md` | 修改 | §3 第 8 行状态、§4 依赖图、§5 当前阶段与待人工 |
| `docs/superpowers/specs/2026-10-01-base-progress-design.md` | 已改 | 6 处笔误更正（**本阶段已完成，不再动**） |

**明确不动的文件：** `internal/store/comment.go` 的 `EventBlobIndex()`（进度不带 `payload_cid`，`type IN (…)` 白名单保持不变）、`internal/store/dm.go`（不跟 `event_id DESC` 口径）、`apps/mobile/src/core/submit.ts`（进度不走投稿台账）、`apps/mobile/src/pages/lesson/detail.vue`（§3.2 明确 course/lesson **不上报**，§6 清单是通用样板，lesson 无进度落点）。

---

## 3. 执行顺序与依赖

```
Task 1 (store 两表) ──> Task 2 (protocol + 向量) ──> Task 3 (httpapi 放行) ──> Task 4 (/v1/me)
                                                          │
                                                          └──> Task 5 (peersync 反熵)

Task 2 (向量) ──> Task 6 (TS progress.ts)
Task 7 (本地两表 + 仓储) ──> Task 8 (progress-store) ──> Task 9 (内容页) ──> Task 10 (课程页) ──> Task 11 (我的页)
Task 12 (版本 + 门禁 + 发布) 最后
```

依赖理由：

1. **Task 1 → 2 → 3 → 4 → 5 是节点侧骨架链**：表先有、量纲再定、再放行、再读接口、再反熵。Task 2 独立于 1（纯函数 + 向量），但放在 1 之后可让 Task 3 一次性拿到 `PutProgressProjection` 与 `ProgressWins`。
2. **Task 6 只依赖 Task 2**：TS 量纲镜像消费同一向量，可与 Task 3–5 并行（但本计划按序号执行，避免多人抢同一批文件）。
3. **Task 7 → 8 是手机端骨架链**：本地表与仓储语义先行，编排层（`reportProgress` / `pullProgress`）才能落笔。
4. **Task 9/10/11 是三个互不重叠的页面**：9 只碰 `article.vue` / `quiz.vue`，10 只碰 `course.vue`，11 只碰 `mine.vue`。11 依赖 7+8（要 `pullProgress`）；10 依赖 6+7（要 `lessonCompleted` 与 `listProgress`）；9 依赖 6+8。
5. **Task 12 最后**：版本号与发布是全局动作，必须在全部改动落库后做；真机项**只登记不消耗**（用户明确「真机测试延后」）。

**硬规则：** 若某步与册子冲突，**先改册子再改代码**，不得只改代码。本册已定稿，执行期若发现新冲突，先在本册新增「勘误」小节。

---

## Task 1: 节点侧两张投影表 + `PutProgressProjection`

**Files:**
- Modify: `internal/store/schema.go:225`
- Create: `internal/store/progress.go`
- Test: `internal/store/progress_test.go`

- [ ] **Step 1: 写失败测试**

创建 `internal/store/progress_test.go`：

```go
package store

import (
	"reflect"
	"testing"
)

func TestPutProgressProjectionFirstWriteAndCheckin(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()

	if err := st.PutProgressProjection(ProgressEvent{
		ID: "actor1", ItemID: "article/a", Position: 640, Done: false,
		Day: "2026-10-01", CreatedAt: 100, EventID: "ev1",
	}); err != nil {
		t.Fatalf("PutProgressProjection: %v", err)
	}

	rows, err := st.ListProgressByID("actor1")
	if err != nil || len(rows) != 1 {
		t.Fatalf("progress 行数 err=%v rows=%+v", err, rows)
	}
	want := ProgressRow{ItemID: "article/a", Position: 640, Done: false, Day: "2026-10-01", UpdatedAt: 100, EventID: "ev1"}
	if !reflect.DeepEqual(rows[0], want) {
		t.Fatalf("progress 行: got=%+v want=%+v", rows[0], want)
	}

	days, err := st.CheckinDaysOf("actor1")
	if err != nil || len(days) != 1 {
		t.Fatalf("checkin 行数 err=%v days=%+v", err, days)
	}
	if days[0].Day != "2026-10-01" || days[0].FirstEventID != "ev1" || days[0].CreatedAt != 100 {
		t.Fatalf("checkin 行: %+v", days[0])
	}
}

// LWW（#8 册子 §3.4）：created_at 降序、平局取 event_id 升序，首条即胜者。
func TestPutProgressProjectionLWW(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()

	seed := func(createdAt int64, eventID string, position int64) {
		t.Helper()
		if err := st.PutProgressProjection(ProgressEvent{
			ID: "actor1", ItemID: "article/a", Position: position, Done: false,
			Day: "2026-10-01", CreatedAt: createdAt, EventID: eventID,
		}); err != nil {
			t.Fatalf("PutProgressProjection(%s): %v", eventID, err)
		}
	}

	// 更晚的 created_at 胜
	seed(100, "ev1", 100)
	seed(200, "ev2", 200)
	rows, _ := st.ListProgressByID("actor1")
	if rows[0].Position != 200 || rows[0].EventID != "ev2" || rows[0].UpdatedAt != 200 {
		t.Fatalf("更晚者未胜: %+v", rows[0])
	}
	// 更早的 created_at 不覆盖（即使后到达）
	seed(150, "ev3", 300)
	rows, _ = st.ListProgressByID("actor1")
	if rows[0].Position != 200 || rows[0].EventID != "ev2" {
		t.Fatalf("更早者不应覆盖: %+v", rows[0])
	}
	// 平局取 event_id 升序（更小者胜）
	seed(200, "ev0", 999)
	rows, _ = st.ListProgressByID("actor1")
	if rows[0].EventID != "ev0" || rows[0].Position != 999 {
		t.Fatalf("平局应取 event_id 升序更小者: %+v", rows[0])
	}
	// 平局取 event_id 升序（更大者不覆盖）
	seed(200, "ev9", 777)
	rows, _ = st.ListProgressByID("actor1")
	if rows[0].EventID != "ev0" {
		t.Fatalf("平局更大者不应覆盖: %+v", rows[0])
	}
}

// 同 event_id 重放必须幂等（反熵每轮会重拉同一事件）。
func TestPutProgressProjectionReplayIsIdempotent(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()

	e := ProgressEvent{
		ID: "actor1", ItemID: "article/a", Position: 500, Done: false,
		Day: "2026-10-01", CreatedAt: 100, EventID: "ev1",
	}
	for i := 0; i < 3; i++ {
		if err := st.PutProgressProjection(e); err != nil {
			t.Fatalf("第 %d 次 PutProgressProjection: %v", i+1, err)
		}
	}
	rows, _ := st.ListProgressByID("actor1")
	if len(rows) != 1 || rows[0].Position != 500 {
		t.Fatalf("重放不得产生第二行 / 不得改值: %+v", rows)
	}
	days, _ := st.CheckinDaysOf("actor1")
	if len(days) != 1 || days[0].FirstEventID != "ev1" {
		t.Fatalf("checkin 重放应保持 1 行且首次值不变: %+v", days)
	}
}

// 打卡日是 insert-or-ignore 的只增集合（#8 册子 §3.5）：
// 同一天的第二条事件（哪怕 LWW 更晚）不得改写 first_event_id。
func TestCheckinDaysKeepsFirstEvent(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()

	if err := st.PutProgressProjection(ProgressEvent{
		ID: "actor1", ItemID: "article/a", Position: 100, Done: false,
		Day: "2026-10-01", CreatedAt: 100, EventID: "ev1",
	}); err != nil {
		t.Fatalf("首次: %v", err)
	}
	if err := st.PutProgressProjection(ProgressEvent{
		ID: "actor1", ItemID: "article/b", Position: 200, Done: false,
		Day: "2026-10-01", CreatedAt: 999, EventID: "ev2",
	}); err != nil {
		t.Fatalf("同日第二条: %v", err)
	}

	days, err := st.CheckinDaysOf("actor1")
	if err != nil || len(days) != 1 {
		t.Fatalf("同日应只 1 行 err=%v days=%+v", err, days)
	}
	if days[0].FirstEventID != "ev1" || days[0].CreatedAt != 100 {
		t.Fatalf("打卡日应保留首次: %+v", days[0])
	}
	// 但 progress 是**两个不同条目的两个寄存器**，都应各留一行。
	rows, _ := st.ListProgressByID("actor1")
	if len(rows) != 2 || rows[0].ItemID != "article/a" || rows[1].ItemID != "article/b" {
		t.Fatalf("两个 item_id 应各一行: %+v", rows)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/store/ -run 'Progress|CheckinDays' -v`
Expected: FAIL，编译错误 `undefined: ProgressEvent` / `undefined: ProgressRow` / `undefined: CheckinDayRow` / `st.PutProgressProjection undefined`

- [ ] **Step 3: 建表（`schemaStatements` 追加两表）**

在 `internal/store/schema.go` 里，把 `schemaStatements` 末尾的

```go
	`CREATE INDEX IF NOT EXISTS idx_tag_links_target ON tag_links(target_id)`,
}
```

替换为：

```go
	`CREATE INDEX IF NOT EXISTS idx_tag_links_target ON tag_links(target_id)`,

	// progress / checkin_days：学习进度与打卡的**两张投影表**（#8 册子 §4.2）。
	// 一条 progress.v1 事件**同一事务**同时写这两张表：
	//   progress     = (id,item_id) 的 LWW 寄存器（§3.3 / §3.4），只留胜者；
	//   checkin_days = 打卡日集合（§3.5），insert-or-ignore 保留首次。
	// 打卡日**不能**从 progress 派生：(id,item_id) 只留最后一次的 day，会把该条目历史上的打卡日冲掉。
	// 两表都是新表（无存量列演进问题），故直接进 schemaStatements，不需要 ColumnMigrations。
	`CREATE TABLE IF NOT EXISTS progress(
		id         TEXT    NOT NULL,
		item_id    TEXT    NOT NULL,
		position   INTEGER NOT NULL,
		done       INTEGER NOT NULL,
		day        TEXT    NOT NULL,
		updated_at INTEGER NOT NULL,
		event_id   TEXT    NOT NULL,
		dirty      INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY(id, item_id)
	)`,

	`CREATE INDEX IF NOT EXISTS idx_progress_item ON progress(item_id)`,

	`CREATE TABLE IF NOT EXISTS checkin_days(
		id             TEXT    NOT NULL,
		day            TEXT    NOT NULL,
		first_event_id TEXT    NOT NULL,
		created_at     INTEGER NOT NULL,
		PRIMARY KEY(id, day)
	)`,
}
```

- [ ] **Step 4: 写 `internal/store/progress.go`**

```go
package store

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/johocn/base/internal/protocol"
)

// ProgressEvent 是一条 progress.v1 事件的投影输入（#8 册子 §3.1）。
// `Position` 已由客户端按 §3.2 归一化、`Done` 由客户端判定 —— 节点只信、不反推。
type ProgressEvent struct {
	ID        string
	ItemID    string
	Position  int64
	Done      bool
	Day       string
	CreatedAt int64
	EventID   string
}

// ProgressRow 是 progress 表的一行。
type ProgressRow struct {
	ItemID    string
	Position  int64
	Done      bool
	Day       string
	UpdatedAt int64
	EventID   string
}

// CheckinDayRow 是 checkin_days 表的一行。
type CheckinDayRow struct {
	Day          string
	FirstEventID string
	CreatedAt    int64
}

// PutProgressProjection 把一条 progress.v1 事件投影进 progress + checkin_days（#8 册子 §4.2）。
// **同一事务**写两张表：要么都落、要么都不落（反熵中断不留半条状态）。
//
// progress 的收敛口径 = §3.4 的 LWW（`created_at` 降序、平局 `event_id` 升序，首条即胜者）：
//   - 无行 → INSERT；
//   - 同 event_id 重放 → 幂等 no-op；
//   - 本次事件更晚 → UPDATE；
//   - 否则（更早，或同刻更大 event_id）→ **静默 no-op**（输者不是错误：寄存器已收敛，
//     与 ProjectGovernProposal 的 ErrGovernEventConflict 不同——那册需要向用户告知冲突，本册不需要）。
//
// checkin_days 恒为 insert-or-ignore：该身份该日已有行则保留首次（§3.5 的「只增集合」）。
// 注意**即使 progress 这行输了 LWW，checkin_days 照样要写**——打卡是**事件级**语义
//（§3.5：某日已打卡 ⇔ 存在至少一条 day == 该日 的事件），不是寄存器级。
func (s *Store) PutProgressProjection(e ProgressEvent) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`INSERT INTO checkin_days(id,day,first_event_id,created_at)
		VALUES(?,?,?,?) ON CONFLICT(id,day) DO NOTHING`,
		e.ID, e.Day, e.EventID, e.CreatedAt); err != nil {
		return fmt.Errorf("store: 投影打卡日: %w", err)
	}

	prevCreated, prevEventID, found, err := existingProgressTx(tx, e.ID, e.ItemID)
	if err != nil {
		return err
	}
	switch {
	case !found:
		if _, err := tx.Exec(`INSERT INTO progress(id,item_id,position,done,day,updated_at,event_id,dirty)
			VALUES(?,?,?,?,?,?,?,0)`,
			e.ID, e.ItemID, e.Position, boolToInt(e.Done), e.Day, e.CreatedAt, e.EventID); err != nil {
			return fmt.Errorf("store: 投影进度: %w", err)
		}
	case prevEventID == e.EventID:
		// 同一条事件重放：幂等，什么都不做。
	case protocol.ProgressWins(e.CreatedAt, e.EventID, prevCreated, prevEventID):
		if _, err := tx.Exec(`UPDATE progress SET position=?,done=?,day=?,updated_at=?,event_id=?
			WHERE id=? AND item_id=?`,
			e.Position, boolToInt(e.Done), e.Day, e.CreatedAt, e.EventID, e.ID, e.ItemID); err != nil {
			return fmt.Errorf("store: 收敛进度 %s: %w", e.ItemID, err)
		}
	}
	// 其余分支（本次事件输了）静默 no-op：事件行照样由上层落，读接口以寄存器为准。
	return tx.Commit()
}

// existingProgressTx 读一个寄存器已占位的 (updated_at, event_id)；无行返回 found=false。
func existingProgressTx(tx *sql.Tx, id, itemID string) (updatedAt int64, eventID string, found bool, err error) {
	err = tx.QueryRow(`SELECT updated_at, event_id FROM progress WHERE id=? AND item_id=?`,
		id, itemID).Scan(&updatedAt, &eventID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", false, nil
	}
	if err != nil {
		return 0, "", false, err
	}
	return updatedAt, eventID, true, nil
}

// ListProgressByID 返回某身份的全部进度寄存器（LWW 胜者），按 item_id 升序。
// `GET /v1/me` 与反熵断言都用它。空结果返回 nil（上层负责转成 `[]`，不是 `null`）。
func (s *Store) ListProgressByID(id string) ([]ProgressRow, error) {
	rows, err := s.db.Query(`SELECT item_id,position,done,day,updated_at,event_id
		FROM progress WHERE id=? ORDER BY item_id ASC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProgressRow
	for rows.Next() {
		var r ProgressRow
		var done int
		if err := rows.Scan(&r.ItemID, &r.Position, &done, &r.Day, &r.UpdatedAt, &r.EventID); err != nil {
			return nil, err
		}
		r.Done = done != 0
		out = append(out, r)
	}
	return out, rows.Err()
}

// CheckinDaysOf 返回某身份的全部打卡日，按 day 升序。空结果返回 nil（同 ListProgressByID）。
func (s *Store) CheckinDaysOf(id string) ([]CheckinDayRow, error) {
	rows, err := s.db.Query(`SELECT day,first_event_id,created_at FROM checkin_days
		WHERE id=? ORDER BY day ASC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CheckinDayRow
	for rows.Next() {
		var r CheckinDayRow
		if err := rows.Scan(&r.Day, &r.FirstEventID, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// boolToInt 把布尔落成 SQLite 的 0/1。
func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
```

> **注：** `protocol.ProgressWins` 在 Task 2 创建。若先执行 Task 1 会编译不过——**请按 Task 1 → Task 2 的顺序**，或在 Step 4 落地后先跑 Task 2 再回来跑 Step 5。

- [ ] **Step 5: 跑测试确认通过**

Run: `go test ./internal/store/ -run 'Progress|CheckinDays' -v`
Expected: PASS，5 个测试全绿（`TestPutProgressProjectionFirstWriteAndCheckin` / `TestPutProgressProjectionLWW` / `TestPutProgressProjectionReplayIsIdempotent` / `TestCheckinDaysKeepsFirstEvent`）

- [ ] **Step 6: 全包回归 + 提交**

Run: `go build ./... ; go vet ./... ; go test ./internal/store/`
Expected: 全部通过（schema 变更不影响既有测试）

```bash
git add internal/store/schema.go internal/store/progress.go internal/store/progress_test.go
git commit -m "feat(store): 新增 progress/checkin_days 两投影表与 PutProgressProjection 双投影写入"
```

---

## Task 2: `internal/protocol/progress.go` + 契约向量

**Files:**
- Create: `internal/protocol/progress.go`
- Create: `vectors/v1/progress.json`
- Test: `internal/protocol/progress_vector_test.go`

- [ ] **Step 1: 写失败测试**

创建 `internal/protocol/progress_vector_test.go`：

```go
package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type progressArticleCase struct {
	Name     string  `json:"name"`
	Fraction float64 `json:"fraction"`
	Want     int64   `json:"want"`
}

type progressVideoCase struct {
	Name    string  `json:"name"`
	Seconds float64 `json:"seconds"`
	Want    int64   `json:"want"`
}

type progressQuizCase struct {
	Name     string `json:"name"`
	Answered int64  `json:"answered"`
	Total    int64  `json:"total"`
	Want     int64  `json:"want"`
}

type progressLWWCase struct {
	Name          string `json:"name"`
	CreatedAt     int64  `json:"createdAt"`
	EventID       string `json:"eventId"`
	PrevCreatedAt int64  `json:"prevCreatedAt"`
	PrevEventID   string `json:"prevEventId"`
	Want          bool   `json:"want"`
}

// 学习进度的量纲与 LWW 判据是**双端写死口径**（#8 册子 §3.2 / §3.4），
// 本向量同时被 Go 与 TS 两侧测试消费，任一侧漂移即红。
func TestProgressVectorFile(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "progress.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var f struct {
		Version int                  `json:"version"`
		Article []progressArticleCase `json:"article"`
		Video   []progressVideoCase   `json:"video"`
		Quiz    []progressQuizCase    `json:"quiz"`
		LWW     []progressLWWCase     `json:"lww"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if f.Version != 1 || len(f.Article) == 0 || len(f.Video) == 0 || len(f.Quiz) == 0 || len(f.LWW) == 0 {
		t.Fatalf("向量文件结构错误: version=%d article=%d video=%d quiz=%d lww=%d",
			f.Version, len(f.Article), len(f.Video), len(f.Quiz), len(f.LWW))
	}

	for _, c := range f.Article {
		t.Run("article/"+c.Name, func(t *testing.T) {
			if got := ArticlePosition(c.Fraction); got != c.Want {
				t.Fatalf("got=%d want=%d fraction=%v", got, c.Want, c.Fraction)
			}
		})
	}
	for _, c := range f.Video {
		t.Run("video/"+c.Name, func(t *testing.T) {
			if got := VideoPosition(c.Seconds); got != c.Want {
				t.Fatalf("got=%d want=%d seconds=%v", got, c.Want, c.Seconds)
			}
		})
	}
	for _, c := range f.Quiz {
		t.Run("quiz/"+c.Name, func(t *testing.T) {
			if got := QuizPosition(c.Answered, c.Total); got != c.Want {
				t.Fatalf("got=%d want=%d answered=%d total=%d", got, c.Want, c.Answered, c.Total)
			}
		})
	}
	for _, c := range f.LWW {
		t.Run("lww/"+c.Name, func(t *testing.T) {
			if got := ProgressWins(c.CreatedAt, c.EventID, c.PrevCreatedAt, c.PrevEventID); got != c.Want {
				t.Fatalf("got=%v want=%v", got, c.Want)
			}
		})
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/protocol/ -run TestProgressVectorFile -v`
Expected: FAIL，`open ../../vectors/v1/progress.json: no such file or directory`（先缺向量文件）

- [ ] **Step 3: 写契约向量 `vectors/v1/progress.json`**

```json
{
  "version": 1,
  "article": [
    {"name": "起点", "fraction": 0, "want": 0},
    {"name": "半程", "fraction": 0.5, "want": 500},
    {"name": "读了 64%", "fraction": 0.64, "want": 640},
    {"name": "末尾", "fraction": 1, "want": 1000},
    {"name": "过 1 夹到 1000", "fraction": 1.5, "want": 1000},
    {"name": "负数归零", "fraction": -0.2, "want": 0},
    {"name": "四舍五入 123.4 → 123", "fraction": 0.1234, "want": 123},
    {"name": "临近末尾进位 999.9 → 1000", "fraction": 0.9999, "want": 1000}
  ],
  "video": [
    {"name": "起点", "seconds": 0, "want": 0},
    {"name": "整数秒", "seconds": 42, "want": 42},
    {"name": "小数向下取整", "seconds": 42.9, "want": 42},
    {"name": "负数归零", "seconds": -3, "want": 0}
  ],
  "quiz": [
    {"name": "未作答", "answered": 0, "total": 10, "want": 0},
    {"name": "答 3 题", "answered": 3, "total": 10, "want": 3},
    {"name": "全答完", "answered": 10, "total": 10, "want": 10},
    {"name": "超出总题数夹到 total", "answered": 12, "total": 10, "want": 10},
    {"name": "总题数为 0 归零", "answered": 3, "total": 0, "want": 0}
  ],
  "lww": [
    {"name": "更晚的 created_at 胜", "createdAt": 200, "eventId": "00000000000000000000000000000002", "prevCreatedAt": 100, "prevEventId": "00000000000000000000000000000001", "want": true},
    {"name": "更早的 created_at 负", "createdAt": 100, "eventId": "00000000000000000000000000000001", "prevCreatedAt": 200, "prevEventId": "00000000000000000000000000000002", "want": false},
    {"name": "平局取 event_id 升序（更小者胜）", "createdAt": 100, "eventId": "00000000000000000000000000000001", "prevCreatedAt": 100, "prevEventId": "00000000000000000000000000000002", "want": true},
    {"name": "平局取 event_id 升序（更大者负）", "createdAt": 100, "eventId": "0000000000000000000000000000000f", "prevCreatedAt": 100, "prevEventId": "00000000000000000000000000000001", "want": false}
  ]
}
```

> **注（IEEE754 陷阱，勿改这几组值）：** 向量刻意避开 `0.1235` / `0.0005` 这类 half-way 边界——它们在 IEEE754 里不可精确表示，会让 JS `Math.round` 与 Go `math.Round` 在同一输入上分歧。`0.1234 → 123.4`、`0.9999 → 999.9` 都是安全值。

- [ ] **Step 4: 写 `internal/protocol/progress.go`**

```go
package protocol

import "math"

// 学习进度（progress.v1）的**量纲定义处**（#8 册子 §3.2）。
// 本文件是 Go 侧唯一口径；TS 镜像在 apps/mobile/src/core/progress.ts，
// 两侧测试共用 vectors/v1/progress.json（§3.4），任一侧漂移即红。
//
// **本文件不实现 `done` 谓词**：§3.2 表格的「`done` 判定」列写明判据主体是「客户端：」，
// 节点只信客户端上报的 `done`、不反推（§3.1）。在 Go 侧实现会是死代码。

// ArticlePosition 把正文滚动比例归一化为千分比：0..1000（§3.2）。
// 越界钳位；NaN 归 0（`!(fraction > 0)` 同时兜住 NaN——NaN 的比较恒为假）。
func ArticlePosition(fraction float64) int64 {
	if !(fraction > 0) {
		return 0
	}
	if fraction >= 1 {
		return 1000
	}
	return int64(math.Round(fraction * 1000))
}

// VideoPosition 把已看秒数归一化为整秒（§3.2）。负数归 0；小数向下取整。
func VideoPosition(seconds float64) int64 {
	if !(seconds > 0) {
		return 0
	}
	return int64(math.Floor(seconds))
}

// QuizPosition 把已作答题数归一化：夹到 [0, total]（§3.2）。total<=0 或 answered<=0 归 0。
func QuizPosition(answered, total int64) int64 {
	if total <= 0 || answered <= 0 {
		return 0
	}
	if answered >= total {
		return total
	}
	return answered
}

// ProgressWins 判事件 (createdAt, eventID) 是否胜过已占位的 (prevCreatedAt, prevEventID)：
// 排序 = `created_at` 降序、平局 `event_id` 升序，**首条即胜者**（#8 册子 §3.4）。
//
// 该口径与节点侧按身份读事件的既有排序（internal/store/event.go 的
// `ORDER BY created_at DESC, event_id ASC`）逐字一致；**不跟** dm 的 `event_id DESC`（§3.4）。
func ProgressWins(createdAt int64, eventID string, prevCreatedAt int64, prevEventID string) bool {
	if createdAt != prevCreatedAt {
		return createdAt > prevCreatedAt
	}
	return eventID < prevEventID
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `go test ./internal/protocol/ -run TestProgressVectorFile -v`
Expected: PASS，21 个 `t.Run` 子用例全绿（article 8 + video 4 + quiz 5 + lww 4）

- [ ] **Step 6: 回跑 Task 1 的测试（现在 `protocol.ProgressWins` 已存在）**

Run: `go test ./internal/store/ -run 'Progress|CheckinDays' -v`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add internal/protocol/progress.go internal/protocol/progress_vector_test.go vectors/v1/progress.json
git commit -m "feat(protocol): 新增 progress 量纲与 LWW 判据及双端契约向量"
```

---

## Task 3: `progress.v1` 放行 + 校验 + 写路径

**Files:**
- Modify: `internal/httpapi/event.go:25-30`、`:62-75`
- Create: `internal/httpapi/progress.go`
- Create: `internal/httpapi/progress_test.go`
- Modify: `internal/httpapi/event_test.go:51,63,69,74`

- [ ] **Step 1: 写失败测试**

创建 `internal/httpapi/progress_test.go`：

```go
package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/johocn/base/internal/protocol"
)

// progressEventBody 造一条 progress.v1 事件体，并按 §3.4 签内容签名
// canonical({event_id,type,created_at,body})——与节点侧重建的待验字节同口径。
func progressEventBody(t *testing.T, seed, eventID, itemID string, position int64, done bool, day string) string {
	t.Helper()
	body := map[string]any{"item_id": itemID, "position": position, "done": done, "day": day}
	payload := map[string]any{
		"event_id": eventID, "type": "progress.v1",
		"created_at": time.Now().UnixMilli(), "body": body,
	}
	canon, err := protocol.Canonicalize(payload)
	if err != nil {
		t.Fatalf("Canonicalize: %v", err)
	}
	sig, err := protocol.Sign(seed, canon)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	payload["sig"] = sig
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return string(raw)
}

func TestProgressEventPersistsBothProjections(t *testing.T) {
	st, _, ts := newFullServer(t)
	id, _ := identityFromSeed(t, testSeed)

	body := progressEventBody(t, testSeed, strings.Repeat("1", 32), "article/hello-world", 640, false, "2026-10-01")
	status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", body))
	if status != http.StatusOK {
		t.Fatalf("发进度 status=%d out=%v", status, out)
	}

	rows, err := st.ListProgressByID(id)
	if err != nil || len(rows) != 1 {
		t.Fatalf("progress 投影 err=%v rows=%+v", err, rows)
	}
	if rows[0].ItemID != "article/hello-world" || rows[0].Position != 640 || rows[0].Done {
		t.Fatalf("progress 投影不符: %+v", rows[0])
	}
	if rows[0].Day != "2026-10-01" || rows[0].EventID != strings.Repeat("1", 32) {
		t.Fatalf("progress 的 day/event_id 不符: %+v", rows[0])
	}
	days, err := st.CheckinDaysOf(id)
	if err != nil || len(days) != 1 || days[0].Day != "2026-10-01" {
		t.Fatalf("checkin 投影 err=%v days=%+v", err, days)
	}

	// 事件行必须存**客户端原始键集**（不是减化形态）：反熵侧要据它重投影。
	evs, err := st.ListEvents(id, 10)
	if err != nil || len(evs) != 1 {
		t.Fatalf("事件行 err=%v evs=%+v", err, evs)
	}
	if evs[0].Type != "progress.v1" || evs[0].TargetID != "article/hello-world" {
		t.Fatalf("事件行不符: %+v", evs[0])
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(evs[0].BodyJSON), &m); err != nil {
		t.Fatalf("body_json 不是对象: %s", evs[0].BodyJSON)
	}
	for _, k := range []string{"item_id", "position", "done", "day"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("body_json 丢键 %q: %s", k, evs[0].BodyJSON)
		}
	}
}

func TestProgressEventRejectsBadBody(t *testing.T) {
	_, _, ts := newFullServer(t)

	cases := []struct {
		name     string
		rawBody  string
	}{
		{"day 形态非法", `{"item_id":"article/a","position":1,"done":false,"day":"2026/10/01"}`},
		{"position 为负", `{"item_id":"article/a","position":-1,"done":false,"day":"2026-10-01"}`},
		{"position 非整数", `{"item_id":"article/a","position":"1","done":false,"day":"2026-10-01"}`},
		{"done 非布尔", `{"item_id":"article/a","position":1,"done":"false","day":"2026-10-01"}`},
		{"item_id 为空", `{"item_id":"","position":1,"done":false,"day":"2026-10-01"}`},
		{"item_id 超 256 字节", `{"item_id":"` + strings.Repeat("a", 257) + `","position":1,"done":false,"day":"2026-10-01"}`},
		{"item_id 非 ASCII", `{"item_id":"文章/a","position":1,"done":false,"day":"2026-10-01"}`},
		{"多一个未知键", `{"item_id":"article/a","position":1,"done":false,"day":"2026-10-01","x":1}`},
		{"缺 day", `{"item_id":"article/a","position":1,"done":false}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// 校验在验签**之前**发生，故这里不需要合法签名：非法 body 必须 400 event_param_invalid。
			body := `{"event_id":"` + strings.Repeat("2", 32) + `","type":"progress.v1","created_at":1,"body":` + c.rawBody + `,"sig":"` + strings.Repeat("ab", 64) + `"}`
			status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", body))
			if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
				t.Fatalf("status=%d out=%v, want 400/event_param_invalid", status, out)
			}
		})
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/httpapi/ -run 'TestProgressEvent' -v`
Expected: FAIL，`400 event_type_unknown`（`progress.v1` 尚未放行）

- [ ] **Step 3: 放行 + 分流**

在 `internal/httpapi/event.go` 把 `eventTypeRegistry` 改为：

```go
var eventTypeRegistry = map[string]struct{}{
	"comment.v1":  {},
	"group.v1":    {},
	"dm.v1":       {},
	"govern.v1":   {},
	"progress.v1": {},
}
```

在同文件 `handleEventPost` 的 switch 里，`case "govern.v1"` 之后加分支：

```go
	case "govern.v1":
		s.handleGovernEvent(w, actor, req, createdAt)
		return
	case "progress.v1":
		s.handleProgressEvent(w, actor, req, createdAt)
		return
	}
	s.putBareEvent(w, actor, req, createdAt)
```

> **不沿用 `putBareEvent`**：只落骨架会让节点侧两张投影表永远为空，`GET /v1/me` 也就没东西可返回（册子 §4.1）。

- [ ] **Step 4: 写 `internal/httpapi/progress.go`**

```go
package httpapi

import (
	"encoding/json"
	"net/http"
	"regexp"
	"time"

	"github.com/johocn/base/internal/store"
)

// progressBody 是 progress.v1 的四个字段（#8 册子 §3.1）。
type progressBody struct {
	ItemID   string
	Position int64
	Done     bool
	Day      string
}

// progressKeys 是 progress.v1 的**严格键集**：多一个未知键即拒。
// `verifyEventSig` 会把 body 原样 canonicalize，签一份存另一份就是漏洞（同 parseCommentBody 口径，§3.1）。
var progressKeys = map[string]struct{}{
	"item_id": {}, "position": {}, "done": {}, "day": {},
}

// dayRe 校验打卡日的字面形态 YYYY-MM-DD（#8 册子 §3.1）。
var dayRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// validDay 判日界字符串**形态**合法。只校形态、不校「是不是真实存在的日期」——
// 日界是客户端自述数据（§10 风险 2），节点不解释日历、不做时钟可信性校验。
func validDay(s string) bool {
	return dayRe.MatchString(s)
}

// parseProgressBody 校验 progress.v1 的 body（#8 册子 §3.1），
// 返回**客户端原始键集**的 map（供 verifyEventSig 重建待验字节）。
func parseProgressBody(raw json.RawMessage) (map[string]any, progressBody, bool) {
	var pb progressBody
	if len(raw) == 0 {
		return nil, pb, false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, pb, false
	}
	if !onlyKeys(m, progressKeys) {
		return nil, pb, false
	}
	itemID, ok := m["item_id"].(string)
	if !ok || !validTargetID(itemID) {
		return nil, pb, false
	}
	pos, ok := jsonInt(m["position"])
	if !ok || pos < 0 {
		return nil, pb, false
	}
	done, ok := m["done"].(bool)
	if !ok {
		return nil, pb, false
	}
	day, ok := m["day"].(string)
	if !ok || !validDay(day) {
		return nil, pb, false
	}
	pb = progressBody{ItemID: itemID, Position: pos, Done: done, Day: day}
	return m, pb, true
}

// handleProgressEvent 处理 progress.v1：校验 body → 验内容签名 → **双投影同事务** → 落事件行 → 200（#8 册子 §4.1）。
//
// 与 govern.v1 的差别：进度投影**没有「冲突」语义**（输者静默 no-op 且不算错），
// 故任何投影错误都直接 500（不像 govern 要吞 ErrGovernEventConflict）。
// 事件行按**客户端原始键集**存 body_json（同 govern 口径），反熵侧据此还原两表列。
func (s *Server) handleProgressEvent(w http.ResponseWriter, actor string, req eventReq, createdAt int64) {
	rawBody, pb, ok := parseProgressBody(req.Body)
	if !ok {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	if !s.verifyEventSig(w, actor, req, rawBody) {
		return
	}
	if err := s.st.PutProgressProjection(store.ProgressEvent{
		ID: actor, ItemID: pb.ItemID, Position: pb.Position, Done: pb.Done, Day: pb.Day,
		CreatedAt: createdAt, EventID: req.EventID,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UnixMilli()
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: actor, Type: req.Type, BodyJSON: string(req.Body),
		CreatedAt: createdAt, ReceivedAt: now, TargetID: pb.ItemID,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 回读 received_at：同 event_id 重发时它是首次值，响应必须给权威值（与 comment / group / govern 同口径）。
	if ev, ok, err := s.st.GetEventByID(req.EventID); err == nil && ok {
		now = ev.ReceivedAt
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"event_id": req.EventID, "received_at": now})
}
```

- [ ] **Step 5: 跑新测试确认通过**

Run: `go test ./internal/httpapi/ -run 'TestProgressEvent' -v`
Expected: PASS（`TestProgressEventPersistsBothProjections` + 9 个 `TestProgressEventRejectsBadBody` 子用例）

- [ ] **Step 6: 修既有破坏点 `event_test.go`**

`TestEventUnknownTypeRejectedKnownTypePersisted` 原本拿 `progress.v1` 当**未知类型**例子；注册后该测试必挂。把 `internal/httpapi/event_test.go` 的第 48–78 行整体替换为：

```go
func TestEventUnknownTypeRejectedKnownTypePersisted(t *testing.T) {
	_, srv, ts := newFullServer(t)
	id, _ := identityFromSeed(t, testSeed)
	// 用一个**不会**被注册的类型当未知类型的样本；`progress.v1` 已被本册放行，不能再当反例。
	body := `{"event_id":"` + strings.Repeat("7", 32) + `","type":"bogus.v1","created_at":1,"body":{"n":1}}`

	status, out := doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/event", "", body)
	if status != http.StatusBadRequest || out["code"] != "auth_missing_header" {
		t.Fatalf("未签名 status=%d out=%v, want 400/auth_missing_header", status, out)
	}

	status, out = sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", body))
	if status != http.StatusBadRequest || out["error"] != "event_type_unknown" {
		t.Fatalf("未登记类型 status=%d out=%v, want 400/event_type_unknown", status, out)
	}

	srv.knownEventTypes["bogus.v1"] = struct{}{}
	status, out = sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", body))
	if status != http.StatusOK {
		t.Fatalf("登记类型后 status=%d out=%v", status, out)
	}
	evs, err := srv.st.ListEvents(id, 10)
	if err != nil || len(evs) != 1 || evs[0].Type != "bogus.v1" || evs[0].BodyJSON != `{"n":1}` {
		t.Fatalf("落库结果 err=%v evs=%+v", err, evs)
	}

	status, out = sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event",
		`{"event_id":"zz","type":"bogus.v1","created_at":1}`))
	if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
		t.Fatalf("event_id 非法 status=%d out=%v, want 400/event_param_invalid", status, out)
	}
}
```

- [ ] **Step 7: 跑 httpapi 整包回归**

Run: `go test ./internal/httpapi/`
Expected: PASS（含改写后的 `TestEventUnknownTypeRejectedKnownTypePersisted`）

- [ ] **Step 8: 提交**

```bash
git add internal/httpapi/event.go internal/httpapi/progress.go internal/httpapi/progress_test.go internal/httpapi/event_test.go
git commit -m "feat(httpapi): 放行 progress.v1 并实现校验与双投影写路径"
```

---

## Task 4: `GET /v1/me` 三数组接真

**Files:**
- Modify: `internal/httpapi/identity.go:238-244`
- Modify: `internal/httpapi/identity_test.go:287-299`

- [ ] **Step 1: 写失败测试**

把 `internal/httpapi/identity_test.go` 的 `TestMeReturnsEmptyArrays`（L287-299）整体替换为：

```go
// GET /v1/me 的三个数组**恒为数组而非 null**（契约 5.5 的红线不破），
// 且 progress / checkin_days 已从「写死空数组」改为**按签名身份返回真数据**（#8 册子 §4.4）。
func TestMeReturnsRealProgressArrays(t *testing.T) {
	st, _, ts := newFullServer(t)
	id, _ := identityFromSeed(t, testSeed)
	otherID, _ := identityFromSeed(t, strings.Repeat("ab", 32))

	seed := func(eventID, actor, itemID string, position int64, day string) {
		t.Helper()
		if err := st.PutProgressProjection(store.ProgressEvent{
			ID: actor, ItemID: itemID, Position: position, Done: false,
			Day: day, CreatedAt: 100, EventID: eventID,
		}); err != nil {
			t.Fatalf("PutProgressProjection(%s): %v", eventID, err)
		}
	}
	seed(strings.Repeat("1", 32), id, "article/a", 640, "2026-10-01")
	seed(strings.Repeat("2", 32), id, "quiz/q1", 3, "2026-10-02")
	// 别人的进度绝不能被返回（进度恒为私有，§2 第 1 条）
	seed(strings.Repeat("3", 32), otherID, "article/z", 1, "2026-10-03")

	status, body := sendAuth(t, signedRequest(t, testSeed, http.MethodGet, ts.URL+"/v1/me", ""))
	if status != http.StatusOK {
		t.Fatalf("GET /v1/me status=%d body=%v", status, body)
	}
	if body["id"] != id {
		t.Fatalf("id=%v want %s", body["id"], id)
	}

	events, ok := body["events"].([]any)
	if !ok || len(events) != 0 {
		t.Fatalf("events 应为长度 0 的数组而非 null: %v", body["events"])
	}
	progress, ok := body["progress"].([]any)
	if !ok || len(progress) != 2 {
		t.Fatalf("progress 应为长度 2 的数组: %v", body["progress"])
	}
	first, ok := progress[0].(map[string]any)
	if !ok {
		t.Fatalf("progress[0] 不是对象: %v", progress[0])
	}
	// 元素形状 {item_id, position, done, day, updated_at, event_id}（§4.4）——
	// event_id 是必需的：本地合并要复现 §3.4 的平局判据。
	for _, k := range []string{"item_id", "position", "done", "day", "updated_at", "event_id"} {
		if _, has := first[k]; !has {
			t.Fatalf("progress 元素缺字段 %q: %v", k, first)
		}
	}
	if first["item_id"] != "article/a" || first["position"] != float64(640) ||
		first["event_id"] != strings.Repeat("1", 32) {
		t.Fatalf("progress[0] 不符: %v", first)
	}

	days, ok := body["checkin_days"].([]any)
	if !ok || len(days) != 2 {
		t.Fatalf("checkin_days 应为长度 2 的数组: %v", body["checkin_days"])
	}
	d0, ok := days[0].(map[string]any)
	if !ok {
		t.Fatalf("checkin_days[0] 不是对象: %v", days[0])
	}
	for _, k := range []string{"day", "first_event_id", "created_at"} {
		if _, has := d0[k]; !has {
			t.Fatalf("checkin_days 元素缺字段 %q: %v", k, d0)
		}
	}
	if d0["day"] != "2026-10-01" {
		t.Fatalf("checkin_days[0] 不符: %v", d0)
	}
}

// 无任何进度时三个数组仍必须是 `[]` 而非 `null`。
func TestMeEmptyArraysAreNotNull(t *testing.T) {
	_, _, ts := newFullServer(t)

	status, body := sendAuth(t, signedRequest(t, testSeed, http.MethodGet, ts.URL+"/v1/me", ""))
	if status != http.StatusOK {
		t.Fatalf("GET /v1/me status=%d", status)
	}
	for _, k := range []string{"events", "progress", "checkin_days"} {
		arr, ok := body[k].([]any)
		if !ok || len(arr) != 0 {
			t.Fatalf("%s 应为长度 0 的数组而非 null: %v", k, body[k])
		}
	}
}
```

同时确认 `identity_test.go` 顶部已 import `strings` 与 `store`（现已 import，L8 与 L12），无需新增 import。

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/httpapi/ -run 'TestMe' -v`
Expected: FAIL，`checkin_days` 缺失 / `progress` 长度 0 而非 2

- [ ] **Step 3: 改 `handleMe`**

把 `internal/httpapi/identity.go` 的 `handleMe`（L238-244）替换为：

```go
// handleMe 返回当前身份与事件/进度骨架（契约 5.5 / #8 册子 §4.4）。
//
// `events` 本册**保持现状**（空数组），不扩面——它属于另一条待办。
// `progress` / `checkin_days` 按**签名身份**返回真数据；三数组**恒为数组而非 null**：
// 用 `make(..., 0, n)` 而不是 `nil`，否则 JSON 会编成 `null`，客户端无条件迭代就会炸。
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r)
	progressRows, err := s.st.ListProgressByID(id)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	checkins, err := s.st.CheckinDaysOf(id)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 元素形状见 §4.4：progress 带 event_id（本地要复现 §3.4 的平局判据）；
	// checkin_days 是 §3.5 的独立投影，不能从折叠后的 progress 派生。
	progress := make([]map[string]any, 0, len(progressRows))
	for _, p := range progressRows {
		progress = append(progress, map[string]any{
			"item_id":    p.ItemID,
			"position":   p.Position,
			"done":       p.Done,
			"day":        p.Day,
			"updated_at": p.UpdatedAt,
			"event_id":   p.EventID,
		})
	}
	days := make([]map[string]any, 0, len(checkins))
	for _, c := range checkins {
		days = append(days, map[string]any{
			"day":            c.Day,
			"first_event_id": c.FirstEventID,
			"created_at":     c.CreatedAt,
		})
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"id": id, "events": []any{}, "progress": progress, "checkin_days": days,
	})
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/httpapi/ -run 'TestMe' -v`
Expected: PASS（`TestMeReturnsRealProgressArrays` + `TestMeEmptyArraysAreNotNull`）

- [ ] **Step 5: 全包回归 + 提交**

Run: `go build ./... ; go vet ./... ; go test ./internal/httpapi/`
Expected: PASS

```bash
git add internal/httpapi/identity.go internal/httpapi/identity_test.go
git commit -m "feat(httpapi): GET /v1/me 返回真实 progress 与 checkin_days 三数组"
```

---

## Task 5: 反熵投影 `progress.v1`

**Files:**
- Modify: `internal/peersync/eventsync.go:245-248`、`:111-117`
- Modify: `internal/peersync/eventsync_test.go`（文件尾追加）

- [ ] **Step 1: 写失败测试**

在 `internal/peersync/eventsync_test.go` 文件尾追加（同时补 `reflect` 到 import 块）：

```go
// seedProgressEvent 在源节点直接落一条 progress.v1（双投影 + 事件行）。
// 写路径的验签由 internal/httpapi 覆盖，这里只造既成事实。
func seedProgressEvent(t *testing.T, st *store.Store, eventID, actor string, createdAt int64,
	itemID string, position int64, done bool, day string) {
	t.Helper()
	if err := st.PutProgressProjection(store.ProgressEvent{
		ID: actor, ItemID: itemID, Position: position, Done: done, Day: day,
		CreatedAt: createdAt, EventID: eventID,
	}); err != nil {
		t.Fatalf("PutProgressProjection(%s): %v", eventID, err)
	}
	body := fmt.Sprintf(`{"item_id":%q,"position":%d,"done":%t,"day":%q}`, itemID, position, done, day)
	if err := st.PutEvent(store.Event{
		EventID: eventID, ID: actor, Type: "progress.v1", BodyJSON: body,
		CreatedAt: createdAt, TargetID: itemID,
	}); err != nil {
		t.Fatalf("PutEvent(%s): %v", eventID, err)
	}
}

// #8 册子 §8.1 Go 反熵：两节点间 progress.v1 传播后，两侧 progress / checkin_days **逐字一致**；
// 重复投递幂等（第二轮不得改变结果、不得产生第二行）。
func TestSyncEventsProgressProjectionConverges(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)
	dst := openTemp(t)

	actor := commentActor
	// article/a：先早后晚 —— 两端都只留 LWW 晚者。
	seedProgressEvent(t, src, eventIDHex(21), actor, 1000, "article/a", 300, false, "2026-10-01")
	seedProgressEvent(t, src, eventIDHex(22), actor, 2000, "article/a", 900, false, "2026-10-02")
	// quiz/q1：先晚后早 —— 后到达的更早事件**不得**覆盖（输者静默）。
	seedProgressEvent(t, src, eventIDHex(23), actor, 2000, "quiz/q1", 9, true, "2026-10-03")
	seedProgressEvent(t, src, eventIDHex(24), actor, 1000, "quiz/q1", 2, false, "2026-10-01")

	wantProgress := []store.ProgressRow{
		{ItemID: "article/a", Position: 900, Done: false, Day: "2026-10-02", UpdatedAt: 2000, EventID: eventIDHex(22)},
		{ItemID: "quiz/q1", Position: 9, Done: true, Day: "2026-10-03", UpdatedAt: 2000, EventID: eventIDHex(23)},
	}
	// 打卡日是事件级 insert-or-ignore：10-01 由 event21 首次写入并被 event24 复投而不改（§3.5）。
	wantDays := []store.CheckinDayRow{
		{Day: "2026-10-01", FirstEventID: eventIDHex(21), CreatedAt: 1000},
		{Day: "2026-10-02", FirstEventID: eventIDHex(22), CreatedAt: 2000},
		{Day: "2026-10-03", FirstEventID: eventIDHex(23), CreatedAt: 2000},
	}

	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	if _, err := cfg.SyncEvents(context.Background(), dst, Peer{URL: url}); err != nil {
		t.Fatalf("SyncEvents: %v", err)
	}

	for _, node := range []struct {
		name string
		st   *store.Store
	}{{"源节点", src}, {"缓存节点", dst}} {
		rows, err := node.st.ListProgressByID(actor)
		if err != nil || !reflect.DeepEqual(rows, wantProgress) {
			t.Fatalf("%s progress 不符 err=%v got=%+v want=%+v", node.name, err, rows, wantProgress)
		}
		days, err := node.st.CheckinDaysOf(actor)
		if err != nil || !reflect.DeepEqual(days, wantDays) {
			t.Fatalf("%s checkin_days 不符 err=%v got=%+v want=%+v", node.name, err, days, wantDays)
		}
	}

	// 第二轮：游标已推进 ⇒ 无事件可搬，结果一字不变。
	ev, err := cfg.SyncEvents(context.Background(), dst, Peer{URL: url})
	if err != nil || ev.Events != 0 {
		t.Fatalf("第二轮应无事可做 ev=%+v err=%v", ev, err)
	}
	rows, _ := dst.ListProgressByID(actor)
	if !reflect.DeepEqual(rows, wantProgress) {
		t.Fatalf("第二轮后 progress 变了: %+v", rows)
	}
	days, _ := dst.CheckinDaysOf(actor)
	if !reflect.DeepEqual(days, wantDays) {
		t.Fatalf("第二轮后 checkin_days 变了: %+v", days)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/peersync/ -run TestSyncEventsProgressProjectionConverges -v`
Expected: FAIL，`缓存节点 progress 不符`（对端来的事件没有投影）

- [ ] **Step 3: `parseEventProjection` 加分支**

在 `internal/peersync/eventsync.go` 的 `parseEventProjection` 里，把 `default:` 之前插入：

```go
	case "progress.v1":
		// 进度的减化 body 是 {item_id,position,done,day}；target_id 直接取 item_id（#8 册子 §3.1）。
		// 进度**不带正文块**，payload_cid 恒空（§3.1）——故 EventBlobIndex 的 type 白名单不用动。
		var m struct {
			ItemID string `json:"item_id"`
		}
		if err := json.Unmarshal([]byte(bodyJSON), &m); err != nil || m.ItemID == "" {
			return commentProjection{}
		}
		return commentProjection{TargetID: m.ItemID}
	default:
		return commentProjection{}
	}
```

- [ ] **Step 4: 新增 `applySyncedProgressEvent`**

在 `internal/peersync/eventsync.go` 的 `applySyncedGroupEvent` 之后、`applySyncedGovernEvent` 之前插入：

```go
// applySyncedProgressEvent 把对端来的 progress.v1 事件投影进本地 progress + checkin_days（#8 册子 §4.3）。
// 投影**幂等**（同 event_id 重放 no-op；输者静默 no-op，见 store.PutProgressProjection）。
//
// 与 group 同强度：投影失败**阻断整页反熵**。理由：进度投影是一次纯本地 SQL 双写，
// 失败即真异常（磁盘 / schema），不像 govern 那样有「事件是权威、读接口可重算」的退路。
func applySyncedProgressEvent(st *store.Store, it eventSyncItem) (bool, error) {
	if it.Type != "progress.v1" {
		return false, nil
	}
	var m struct {
		ItemID   string `json:"item_id"`
		Position int64  `json:"position"`
		Done     bool   `json:"done"`
		Day      string `json:"day"`
	}
	if err := json.Unmarshal([]byte(it.BodyJSON), &m); err != nil || m.ItemID == "" {
		return false, nil // 形态不认识的事件：落行但不投影（与 parseEventProjection 的零值口径一致）
	}
	if err := st.PutProgressProjection(store.ProgressEvent{
		ID: it.ID, ItemID: m.ItemID, Position: m.Position, Done: m.Done, Day: m.Day,
		CreatedAt: it.CreatedAt, EventID: it.EventID,
	}); err != nil {
		return false, err
	}
	return true, nil
}
```

- [ ] **Step 5: 接进 `pullEvents`**

在 `internal/peersync/eventsync.go` 的 `pullEvents` 里，`applySyncedGroupEvent` 调用之后插入：

```go
			if _, err := applySyncedGroupEvent(st, it); err != nil {
				return total, err
			}
			// progress.v1 投影失败**阻断整页**（与 group 同强度：进度投影是纯本地双写，失败即真异常）。
			if _, err := applySyncedProgressEvent(st, it); err != nil {
				return total, err
			}
			// govern.v1 投影失败**不阻断整页反熵**：事件行才是权威来源，读接口可从事件重算。
```

- [ ] **Step 6: 跑测试确认通过**

Run: `go test ./internal/peersync/ -run TestSyncEventsProgressProjectionConverges -v`
Expected: PASS

- [ ] **Step 7: 全包回归 + 提交**

Run: `go build ./... ; go vet ./... ; go test ./internal/peersync/`
Expected: PASS

```bash
git add internal/peersync/eventsync.go internal/peersync/eventsync_test.go
git commit -m "feat(peersync): progress.v1 跨节点反熵投影两表并收敛"
```

---

## Task 6: TS 量纲镜像 `core/progress.ts` + 消费同一向量

**Files:**
- Create: `apps/mobile/src/core/progress.ts`
- Test: `apps/mobile/src/core/progress.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/mobile/src/core/progress.test.ts`：

```ts
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  articleDone,
  articlePosition,
  checkinStreak,
  lessonCompleted,
  localDay,
  progressWins,
  quizDone,
  quizPosition,
  REPORT_MIN_INTERVAL_MS,
  shiftDay,
  shouldReport,
  videoPosition,
} from './progress';

interface VectorFile {
  version: number;
  article: Array<{ name: string; fraction: number; want: number }>;
  video: Array<{ name: string; seconds: number; want: number }>;
  quiz: Array<{ name: string; answered: number; total: number; want: number }>;
  lww: Array<{
    name: string;
    createdAt: number;
    eventId: string;
    prevCreatedAt: number;
    prevEventId: string;
    want: boolean;
  }>;
}

// 与 Go 侧 internal/protocol/progress_vector_test.go 读**同一个文件**（#8 册子 §3.4）。
// 层深 4：apps/mobile/src/core → apps/mobile/src → apps/mobile → apps → 仓库根。
const vector = JSON.parse(
  readFileSync(new URL('../../../../vectors/v1/progress.json', import.meta.url), 'utf8'),
) as VectorFile;

describe('progress 契约向量（与 Go 侧共用同一文件）', () => {
  it('向量文件结构正确', () => {
    expect(vector.version).toBe(1);
    expect(vector.article.length).toBeGreaterThan(0);
    expect(vector.video.length).toBeGreaterThan(0);
    expect(vector.quiz.length).toBeGreaterThan(0);
    expect(vector.lww.length).toBeGreaterThan(0);
  });

  it('article 正文滚动千分比归一化', () => {
    for (const c of vector.article) {
      expect(articlePosition(c.fraction), c.name).toBe(c.want);
    }
  });

  it('video 已看秒数归一化', () => {
    for (const c of vector.video) {
      expect(videoPosition(c.seconds), c.name).toBe(c.want);
    }
  });

  it('quiz 已作答题数归一化', () => {
    for (const c of vector.quiz) {
      expect(quizPosition(c.answered, c.total), c.name).toBe(c.want);
    }
  });

  it('LWW 判据（created_at 降序、平局 event_id 升序）', () => {
    for (const c of vector.lww) {
      expect(progressWins(c.createdAt, c.eventId, c.prevCreatedAt, c.prevEventId), c.name).toBe(c.want);
    }
  });
});

describe('done 判定（客户端侧口径，#8 册子 §3.2）', () => {
  it('article：读到末尾才算完成', () => {
    expect(articleDone(999)).toBe(false);
    expect(articleDone(1000)).toBe(true);
  });

  it('quiz：全答完才算完成，空题库不算', () => {
    expect(quizDone(3, 10)).toBe(false);
    expect(quizDone(10, 10)).toBe(true);
    expect(quizDone(0, 0)).toBe(false);
  });
});

describe('打卡日与连续天数（#8 册子 §3.5）', () => {
  it('今天已打卡：从今天起算', () => {
    const days = new Set(['2026-09-29', '2026-09-30', '2026-10-01']);
    expect(checkinStreak(days, '2026-10-01')).toBe(3);
  });

  it('今天未打卡不断签：从昨天起算', () => {
    const days = new Set(['2026-09-29', '2026-09-30']);
    expect(checkinStreak(days, '2026-10-01')).toBe(2);
  });

  it('中间有缺口即断', () => {
    const days = new Set(['2026-09-28', '2026-09-30', '2026-10-01']);
    expect(checkinStreak(days, '2026-10-01')).toBe(2);
  });

  it('跨月回溯', () => {
    const days = new Set(['2026-08-31', '2026-09-01']);
    expect(checkinStreak(days, '2026-09-01')).toBe(2);
  });

  it('一天都没打卡为 0', () => {
    expect(checkinStreak(new Set<string>(), '2026-10-01')).toBe(0);
  });

  it('shiftDay 跨月跨年由 Date 归一', () => {
    expect(shiftDay('2026-10-01', -1)).toBe('2026-09-30');
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDay('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('localDay 按本地时区组串（不落 UTC）', () => {
    expect(localDay(new Date(2026, 9, 1, 8, 0, 0))).toBe('2026-10-01');
    expect(localDay(new Date(2026, 0, 5, 23, 30, 0))).toBe('2026-01-05');
  });
});

describe('节流（#8 册子 §5.3）', () => {
  it('首次必发', () => {
    expect(shouldReport(undefined, 1000)).toBe(true);
  });

  it('不足间隔丢帧', () => {
    expect(shouldReport(1000, 1000 + REPORT_MIN_INTERVAL_MS - 1)).toBe(false);
  });

  it('正好到间隔即发', () => {
    expect(shouldReport(1000, 1000 + REPORT_MIN_INTERVAL_MS)).toBe(true);
  });
});

describe('容器完成度聚合（#8 册子 §6，只展示、不落表）', () => {
  it('lesson 完成 ⇔ 可达叶子非空且全 done', () => {
    expect(lessonCompleted([true, true])).toBe(true);
    expect(lessonCompleted([true, false])).toBe(false);
    expect(lessonCompleted([])).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/mobile; npx vitest run src/core/progress.test.ts`
Expected: FAIL，`Failed to resolve import "./progress"`

- [ ] **Step 3: 写 `apps/mobile/src/core/progress.ts`**

```ts
/**
 * 学习进度（progress.v1）的量纲、判定与派生（#8 册子 §3.2 / §3.4 / §3.5 / §5.3 / §6）。
 *
 * Go 镜像在 `internal/protocol/progress.go`；两侧测试共用 `vectors/v1/progress.json` 防漂。
 * **纯函数、零依赖**（不 import 'uni' / 'plus'），可在 Node 下完整测试。
 *
 * 本文件**只含客户端侧判定**（`done` 谓词、打卡、节流、完成度聚合）——这些在节点侧不实现
 * （册子 §3.2 表格的「`done` 判定」列写明判据主体是「客户端：」）。
 */

/** 同一 item_id 两次上报的最小间隔（#8 册子 §5.3）：不足则丢弃本次触发点。 */
export const REPORT_MIN_INTERVAL_MS = 5000;

/**
 * 正文滚动比例 → 千分比 0..1000（§3.2）。
 * 越界钳位；NaN 归 0（`!(fraction > 0)` 同时兜住 NaN——NaN 的比较恒为假）。
 */
export function articlePosition(fraction: number): number {
  if (!(fraction > 0)) return 0;
  if (fraction >= 1) return 1000;
  return Math.round(fraction * 1000);
}

/** 已看秒数 → 整秒（§3.2）。负数归 0；小数向下取整。 */
export function videoPosition(seconds: number): number {
  if (!(seconds > 0)) return 0;
  return Math.floor(seconds);
}

/** 已作答题数 → 归一化位置：夹到 [0, total]（§3.2）。total<=0 或 answered<=0 归 0。 */
export function quizPosition(answered: number, total: number): number {
  if (total <= 0 || answered <= 0) return 0;
  return answered >= total ? total : Math.floor(answered);
}

/** article 的 `done` 判定（§3.2）：读完末尾。 */
export function articleDone(position: number): boolean {
  return position >= 1000;
}

/** quiz 的 `done` 判定（§3.2）：全答完；**空题库（total<=0）不算完成**。 */
export function quizDone(position: number, total: number): boolean {
  return total > 0 && position >= total;
}

/**
 * LWW：`createdAt` 降序、平局 `eventId` 升序，**首条即胜者**（§3.4）。
 * 与 Go `protocol.ProgressWins` 逐字同口径；本地合并与节点侧读接口复用同一函数。
 */
export function progressWins(
  createdAt: number,
  eventId: string,
  prevCreatedAt: number,
  prevEventId: string,
): boolean {
  if (createdAt !== prevCreatedAt) return createdAt > prevCreatedAt;
  return eventId < prevEventId;
}

/** 客户端本地时区的 `YYYY-MM-DD`（§3.5）。节点**不**用 `created_at` 反推打卡日。 */
export function localDay(at: Date = new Date()): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 把 `YYYY-MM-DD` 位移 `delta` 天（本地时区）；跨月跨年由 `Date` 归一。 */
export function shiftDay(day: string, delta: number): string {
  const parts = day.split('-').map((s) => Number(s));
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  const at = new Date(y, m - 1, d);
  at.setDate(at.getDate() + delta);
  return localDay(at);
}

/**
 * 连续天数（§3.5）：从「今天」起向前逐日回溯已打卡日集合，**首个缺口即断**。
 * 今天尚未打卡时从昨天起算（当天不判断签）。
 */
export function checkinStreak(days: ReadonlySet<string>, today: string): number {
  let cursor = days.has(today) ? today : shiftDay(today, -1);
  let n = 0;
  while (days.has(cursor)) {
    n += 1;
    cursor = shiftDay(cursor, -1);
  }
  return n;
}

/**
 * 节流判据（§5.3）：同一 item_id 距上次上报 `>= REPORT_MIN_INTERVAL_MS` 才真投递。
 * 上报内容一律是**当前位置的绝对值**（不是增量），故丢帧不造成累计误差——这是能安全丢帧的前提。
 */
export function shouldReport(lastAt: number | undefined, now: number): boolean {
  return lastAt === undefined || now - lastAt >= REPORT_MIN_INTERVAL_MS;
}

/**
 * `lesson` 完成 ⇔ 其**可达**叶子载体数 > 0 且**全部** `done`（§6）。
 * 叶子载体 = `article` / `video` / `quiz`（只有这三类有 `position` / `done`）；
 * 未下载的子条目由调用方**先过滤掉**，不计入分母。
 */
export function lessonCompleted(leafDone: boolean[]): boolean {
  return leafDone.length > 0 && leafDone.every((d) => d);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/mobile; npx vitest run src/core/progress.test.ts`
Expected: PASS（21 个向量子断言 + 12 个本地用例）

- [ ] **Step 5: 类型检查 + 提交**

Run: `cd apps/mobile; npx tsc --noEmit`
Expected: 无输出（0 错误）

```bash
git add apps/mobile/src/core/progress.ts apps/mobile/src/core/progress.test.ts
git commit -m "feat(mobile): 新增 progress 量纲镜像与打卡/节流纯函数并消费契约向量"
```

---

## Task 7: 手机端两张本地表 + 仓储方法

**Files:**
- Modify: `apps/mobile/src/core/types.ts`（追加 `ProgressRow` / `CheckinDayRow`）
- Modify: `apps/mobile/src/core/repo.ts`（DDL 两表 + `ensureProgressColumns` + `LocalRepo` 5 方法 + `SqlRepo` 实现 + 2 个转换器）
- Modify: `apps/mobile/src/core/fakes.ts`（`MemoryRepo` 同步实现 5 方法）
- Modify: `apps/mobile/src/platform/index.ts`（bootstrap 里挂 `ensureProgressColumns`）
- Test: `apps/mobile/src/core/progress-repo.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/mobile/src/core/progress-repo.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import { MemoryRepo } from './fakes';
import type { CheckinDayRow, ProgressRow } from './types';

// 仓储层语义用 MemoryRepo 断言（与既有 comment_out / dm_keys 的测试手法一致：
// fakes 与 SqlRepo 共用同一 LocalRepo 契约，SQL 正确性由真机验收覆盖）。
function row(over: Partial<ProgressRow> = {}): ProgressRow {
  return {
    itemId: 'article/a',
    position: 100,
    done: false,
    day: '2026-10-01',
    updatedAt: 1000,
    eventId: 'a'.repeat(32),
    dirty: true,
    ...over,
  };
}

function day(over: Partial<CheckinDayRow> = {}): CheckinDayRow {
  return { day: '2026-10-01', firstEventId: 'b'.repeat(32), createdAt: 1000, ...over };
}

describe('progress 本地仓储语义（#8 册子 §3.4 / §3.5 / §5.1）', () => {
  it('首写：进度行落库，checkin_days 同事务写入', async () => {
    const repo = new MemoryRepo();
    await repo.saveProgressLocal(row());
    expect(await repo.getProgress('article/a')).toMatchObject({ position: 100, done: false, dirty: true });
    expect(await repo.listCheckinDays()).toEqual([
      { day: '2026-10-01', firstEventId: 'a'.repeat(32), createdAt: 1000 },
    ]);
  });

  it('LWW：created_at 更大者胜；平局取 event_id 更小者；输家不覆盖', async () => {
    const repo = new MemoryRepo();
    await repo.saveProgressLocal(row({ position: 100, updatedAt: 1000, eventId: 'f'.repeat(32) }));
    await repo.saveProgressLocal(row({ position: 200, updatedAt: 2000, eventId: 'f'.repeat(32) }));
    expect((await repo.getProgress('article/a'))!.position).toBe(200);

    // 平局（同为 2000）：event_id 升序 ⇒ '0…' 胜 'f…'
    await repo.saveProgressLocal(row({ position: 300, updatedAt: 2000, eventId: '0'.repeat(32) }));
    expect((await repo.getProgress('article/a'))!.position).toBe(300);

    // 更新更早 + event_id 更大 ⇒ 输
    await repo.saveProgressLocal(row({ position: 400, updatedAt: 1000, eventId: '1'.repeat(32) }));
    expect((await repo.getProgress('article/a'))!.position).toBe(300);
  });

  it('打卡是事件级语义：进度行输了 LWW，checkin_days 照样写', async () => {
    const repo = new MemoryRepo();
    await repo.saveProgressLocal(row({ updatedAt: 2000, eventId: 'a'.repeat(32), day: '2026-10-02' }));
    await repo.saveProgressLocal(row({ updatedAt: 1000, eventId: 'b'.repeat(32), day: '2026-10-03' }));
    expect((await repo.getProgress('article/a'))!.updatedAt).toBe(2000);
    expect((await repo.listCheckinDays()).map((d) => d.day)).toEqual(['2026-10-02', '2026-10-03']);
  });

  it('checkin_days 保留首次：同日重复打卡不改 first_event_id', async () => {
    const repo = new MemoryRepo();
    await repo.saveProgressLocal(row({ day: '2026-10-01', eventId: 'a'.repeat(32), updatedAt: 1000 }));
    await repo.saveProgressLocal(row({ day: '2026-10-01', eventId: 'c'.repeat(32), updatedAt: 9000 }));
    const days = await repo.listCheckinDays();
    expect(days).toHaveLength(1);
    expect(days[0]!.firstEventId).toBe('a'.repeat(32));
  });

  it('mergeProgress：远程行按同一比较函数并入，且写回 dirty=false', async () => {
    const repo = new MemoryRepo();
    await repo.saveProgressLocal(row({ position: 100, updatedAt: 1000, eventId: 'a'.repeat(32) }));
    await repo.mergeProgress(
      [
        row({ position: 900, updatedAt: 5000, eventId: 'b'.repeat(32) }),
        row({ itemId: 'quiz/q1', position: 3, updatedAt: 1, eventId: 'c'.repeat(32) }),
      ],
      [day({ day: '2026-09-30', firstEventId: 'd'.repeat(32) })],
    );
    expect((await repo.getProgress('article/a'))!.position).toBe(900);
    expect((await repo.getProgress('article/a'))!.dirty).toBe(false);
    expect((await repo.getProgress('quiz/q1'))!.position).toBe(3);
    expect((await repo.listCheckinDays()).map((d) => d.day)).toEqual(['2026-09-30', '2026-10-01']);

    // 输的远程行不覆盖
    await repo.mergeProgress([row({ position: 1, updatedAt: 1, eventId: 'e'.repeat(32) })], []);
    expect((await repo.getProgress('article/a'))!.position).toBe(900);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/mobile; npx vitest run src/core/progress-repo.test.ts`
Expected: FAIL，`repo.saveProgressLocal is not a function`

- [ ] **Step 3: `types.ts` 追加两个行类型**

在 `apps/mobile/src/core/types.ts` **文件末尾**追加：

```ts
/**
 * 本地学习进度（`progress` 表，#8 册子 §5.1）。
 * **一个 `item_id` 一条**（本地单人库故无 `id` 列），值是该条目所有 `progress.v1` 事件经
 * §3.4 LWW 排序后的胜者。`updatedAt` 存**胜者事件的 `created_at`**（毫秒），
 * 不是「本机写入时刻」——否则跨设备比较无意义。
 */
export interface ProgressRow {
  itemId: string;
  /** 量纲按条目 type 分派（#8 册子 §3.2） */
  position: number;
  /** 客户端判定并显式上报；节点只信该值，不反推 */
  done: boolean;
  /** 客户端本地时区的 `YYYY-MM-DD` */
  day: string;
  /** 胜者事件的 `created_at`（毫秒） */
  updatedAt: number;
  /** 胜者事件的 `event_id`（32 hex）；LWW 平局判据要求本地必须持有它 */
  eventId: string;
  /** true = 本地新变（尚未确认投递）；远程合并写回 false */
  dirty: boolean;
}

/**
 * 打卡日集合（`checkin_days` 表，#8 册子 §5.1）。与节点侧同构、insert-or-ignore 保留首次。
 * **不能从 `progress` 派生**：后者是 LWW 寄存器，只留最后一次的 `day`，会把历史打卡日冲掉。
 */
export interface CheckinDayRow {
  day: string;
  /** 该日首次打卡事件的 `event_id`（32 hex） */
  firstEventId: string;
  /** 该日首次打卡事件的 `created_at`（毫秒） */
  createdAt: number;
}
```

- [ ] **Step 4: `repo.ts` 加 DDL + 幂等补列**

(a) 顶部 import 两处改造：

```ts
import type { LocalDb } from '../platform/adapter';
import { computeStats, favoriteNext, readAtNext } from './state';
import { progressWins } from './progress';
import { SEARCH_SQL, searchPattern } from './search';
import type { ArticleRow, CheckinDayRow, CommentOutRow, DmKeyRow, FavoriteRow, GroupKeyRow, GroupRow, ItemRow, LearningStats, MySubmissionRow, ProgressRow, QuizRow, SegmentRow, TagLinkRow, TombstoneRow } from './types';
```

（`progress.ts` 零 import ⇒ 无环；`store → protocol` 的同类顾虑在手机端同样不成立。）

(b) `SCHEMA_SQL` 数组末尾（`idx_tag_links_target` 那行**之后**、`];` **之前**）追加：

```ts
  `CREATE TABLE IF NOT EXISTS progress(
     item_id TEXT PRIMARY KEY, position INTEGER NOT NULL, done INTEGER NOT NULL,
     day TEXT NOT NULL, updated_at INTEGER NOT NULL, event_id TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS checkin_days(
     day TEXT PRIMARY KEY, first_event_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
```

(c) 在 `ensureSubmissionColumns` **之后**追加：

```ts
/**
 * 存量库幂等补列（`progress` 表，#8 册子 §5.1）。
 * 总纲 §9 早已预留 `progress(item_id, position, updated_at, dirty)` 四列形态，
 * 本册补 `done` / `day` / `event_id` 三列；`CREATE TABLE IF NOT EXISTS` 对既有表不补列，故沿用同款手法。
 * 表本身不存在（`PRAGMA table_info` 返回空）说明是首启前的空库，直接跳过，等 DDL 建全。
 */
export async function ensureProgressColumns(db: LocalDb): Promise<void> {
  const cols = new Set((await db.select(`PRAGMA table_info(progress)`)).map((r) => String(r.name)));
  if (cols.size === 0) return;
  if (!cols.has('done')) {
    await db.execute(`ALTER TABLE progress ADD COLUMN done INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.has('day')) {
    await db.execute(`ALTER TABLE progress ADD COLUMN day TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.has('event_id')) {
    await db.execute(`ALTER TABLE progress ADD COLUMN event_id TEXT NOT NULL DEFAULT ''`);
  }
}
```

- [ ] **Step 5: `repo.ts` 加 `LocalRepo` 5 方法**

在 `LocalRepo` 接口的 `removeSubmission(...)` **之后**、接口结束 `}` **之前**插入：

```ts
  /**
   * 写一条本地进度（#8 册子 §5.2）：同一事务 upsert `progress`（`dirty=1`）+ insert-or-ignore `checkin_days`。
   * upsert 受 §3.4 LWW 守卫（`progressWins`）；**打卡不受守卫**——打卡是**事件级**语义，
   * 即使进度行输了 LWW，该事件带来的打卡日照样写（否则同一 issue 的形态会丢打卡）。
   */
  saveProgressLocal(row: ProgressRow): Promise<void>;
  /**
   * 把 `GET /v1/me` 拉回的远程行按 §3.4 同一比较函数合并进本地（#8 册子 §5.5）。
   * 合并写入的 `dirty` 固定 0（已同步）；无一行变更时**不写库**。
   */
  mergeProgress(rows: ProgressRow[], days: CheckinDayRow[]): Promise<void>;
  /** 全部进度行，按 `item_id ASC`（页面渲染只读本地表）。 */
  listProgress(): Promise<ProgressRow[]>;
  /** 读一条；不存在返回 null（续位用）。 */
  getProgress(itemId: string): Promise<ProgressRow | null>;
  /** 全部打卡日，按 `day ASC`（连续天数回溯用）。 */
  listCheckinDays(): Promise<CheckinDayRow[]>;
```

- [ ] **Step 6: `repo.ts` 加 `SqlRepo` 实现**

在 `SqlRepo` 的 `removeSubmission` 方法**之后**、类结束 `}` **之前**插入：

```ts
  async saveProgressLocal(row: ProgressRow): Promise<void> {
    // LocalDb.tx 只写不读 ⇒ 先单独读当前行，再在一个事务里落下两条语句。
    const cur = await this.getProgress(row.itemId);
    const stmts: Array<{ sql: string; params?: unknown[] }> = [];
    if (cur === null || progressWins(row.updatedAt, row.eventId, cur.updatedAt, cur.eventId)) {
      stmts.push({
        sql: `INSERT INTO progress(item_id,position,done,day,updated_at,event_id,dirty) VALUES(?,?,?,?,?,?,1)
              ON CONFLICT(item_id) DO UPDATE SET position=excluded.position,done=excluded.done,
                day=excluded.day,updated_at=excluded.updated_at,event_id=excluded.event_id,dirty=1`,
        params: [row.itemId, row.position, row.done ? 1 : 0, row.day, row.updatedAt, row.eventId],
      });
    }
    stmts.push({
      sql: `INSERT INTO checkin_days(day,first_event_id,created_at) VALUES(?,?,?) ON CONFLICT(day) DO NOTHING`,
      params: [row.day, row.eventId, row.updatedAt],
    });
    await this.db.tx(stmts);
  }

  async mergeProgress(rows: ProgressRow[], days: CheckinDayRow[]): Promise<void> {
    const cur = new Map((await this.listProgress()).map((r) => [r.itemId, r]));
    const stmts: Array<{ sql: string; params?: unknown[] }> = [];
    for (const row of rows) {
      const prev = cur.get(row.itemId);
      if (prev !== undefined && !progressWins(row.updatedAt, row.eventId, prev.updatedAt, prev.eventId)) continue;
      stmts.push({
        sql: `INSERT INTO progress(item_id,position,done,day,updated_at,event_id,dirty) VALUES(?,?,?,?,?,?,0)
              ON CONFLICT(item_id) DO UPDATE SET position=excluded.position,done=excluded.done,
                day=excluded.day,updated_at=excluded.updated_at,event_id=excluded.event_id,dirty=0`,
        params: [row.itemId, row.position, row.done ? 1 : 0, row.day, row.updatedAt, row.eventId],
      });
    }
    for (const d of days) {
      stmts.push({
        sql: `INSERT INTO checkin_days(day,first_event_id,created_at) VALUES(?,?,?) ON CONFLICT(day) DO NOTHING`,
        params: [d.day, d.firstEventId, d.createdAt],
      });
    }
    if (stmts.length === 0) return;
    await this.db.tx(stmts);
  }

  async listProgress(): Promise<ProgressRow[]> {
    const rows = await this.db.select(
      `SELECT item_id,position,done,day,updated_at,event_id,dirty FROM progress ORDER BY item_id ASC`,
    );
    return rows.map(toProgressRow);
  }

  async getProgress(itemId: string): Promise<ProgressRow | null> {
    const rows = await this.db.select(
      `SELECT item_id,position,done,day,updated_at,event_id,dirty FROM progress WHERE item_id=?`,
      [itemId],
    );
    return rows.length > 0 ? toProgressRow(rows[0]) : null;
  }

  async listCheckinDays(): Promise<CheckinDayRow[]> {
    const rows = await this.db.select(`SELECT day,first_event_id,created_at FROM checkin_days ORDER BY day ASC`);
    return rows.map(toCheckinDayRow);
  }
```

- [ ] **Step 7: `repo.ts` 加两个转换器**

在文件末尾（`toMySubmissionRow` **之后**）追加：

```ts
function toProgressRow(r: Record<string, unknown>): ProgressRow {
  return {
    itemId: String(r.item_id),
    position: Number(r.position ?? 0),
    done: Number(r.done ?? 0) !== 0,
    day: String(r.day ?? ''),
    updatedAt: Number(r.updated_at ?? 0),
    eventId: String(r.event_id ?? ''),
    dirty: Number(r.dirty ?? 0) !== 0,
  };
}

function toCheckinDayRow(r: Record<string, unknown>): CheckinDayRow {
  return {
    day: String(r.day),
    firstEventId: String(r.first_event_id ?? ''),
    createdAt: Number(r.created_at ?? 0),
  };
}
```

- [ ] **Step 8: `fakes.ts` 的 `MemoryRepo` 同步实现**

(a) import 两处改造：

```ts
import type { ArticleRow, CheckinDayRow, CommentOutRow, DmKeyRow, FavoriteRow, GroupKeyRow, GroupRow, ItemRow, LearningStats, MySubmissionRow, ProgressRow, QuizRow, SegmentRow, TagLinkRow, TombstoneRow } from './types';
import { progressWins } from './progress';
```

(b) 在 `MemoryRepo` 的 `removeSubmission` 方法**之后**、类结束 `}` **之前**插入：

```ts
  progress = new Map<string, ProgressRow>(); // itemId -> row
  checkinDays = new Map<string, CheckinDayRow>(); // day -> row

  async saveProgressLocal(row: ProgressRow): Promise<void> {
    const cur = this.progress.get(row.itemId);
    // 与 SqlRepo 同一守卫：赢才写进度行；打卡与守卫无关，永远写
    if (cur === undefined || progressWins(row.updatedAt, row.eventId, cur.updatedAt, cur.eventId)) {
      this.progress.set(row.itemId, { ...row, dirty: true });
    }
    if (!this.checkinDays.has(row.day)) {
      this.checkinDays.set(row.day, { day: row.day, firstEventId: row.eventId, createdAt: row.updatedAt });
    }
  }

  async mergeProgress(rows: ProgressRow[], days: CheckinDayRow[]): Promise<void> {
    for (const row of rows) {
      const cur = this.progress.get(row.itemId);
      if (cur !== undefined && !progressWins(row.updatedAt, row.eventId, cur.updatedAt, cur.eventId)) continue;
      this.progress.set(row.itemId, { ...row, dirty: false });
    }
    for (const d of days) {
      if (!this.checkinDays.has(d.day)) this.checkinDays.set(d.day, { ...d });
    }
  }

  async listProgress(): Promise<ProgressRow[]> {
    return [...this.progress.values()].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  }

  async getProgress(itemId: string): Promise<ProgressRow | null> {
    return this.progress.get(itemId) ?? null;
  }

  async listCheckinDays(): Promise<CheckinDayRow[]> {
    return [...this.checkinDays.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }
```

- [ ] **Step 9: `platform/index.ts` 挂载补列**

(a) import 行改造：

```ts
import { SCHEMA_SQL, SqlRepo, ensureGroupColumns, ensureProgressColumns, ensureSubmissionColumns, type LocalRepo } from '../core/repo';
```

(b) `bootstrap` 里 `ensureSubmissionColumns(db)` 那行**之后**追加：

```ts
  await ensureProgressColumns(db); // 存量库幂等补 progress.done / day / event_id 三列
```

- [ ] **Step 10: 跑测试确认通过**

Run: `cd apps/mobile; npx vitest run src/core/progress-repo.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 11: 类型检查 + 提交**

Run: `cd apps/mobile; npx tsc --noEmit`
Expected: 无输出（0 错误）

```bash
git add apps/mobile/src/core/types.ts apps/mobile/src/core/repo.ts apps/mobile/src/core/fakes.ts apps/mobile/src/platform/index.ts apps/mobile/src/core/progress-repo.test.ts
git commit -m "feat(mobile): 新增 progress/checkin_days 两张本地表与仓储方法"
```

---

## Task 8: 上报与拉取编排 `core/progress-store.ts`

**Files:**
- Create: `apps/mobile/src/core/progress-store.ts`
- Test: `apps/mobile/src/core/progress-store.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/mobile/src/core/progress-store.test.ts`：

```ts
import { utf8 } from '@base/protocol-ts';
import { describe, expect, it } from 'vitest';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { pullProgress, reportProgress, type ProgressOptions } from './progress-store';
import { decodeUtf8 } from './sync';

const BASE = 'https://node.test';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function fixture() {
  const http = new FakeHttp();
  const repo = new MemoryRepo();
  const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
  const o: ProgressOptions = { adapters, repo, nodeBaseUrl: BASE };
  return { http, repo, o };
}

/** 只让 `POST /v1/event` 断网，登记请求照常走路由。 */
function offlineEventPost(http: FakeHttp): void {
  const real = http.post.bind(http);
  http.post = async (url, body, headers) => {
    if (url.endsWith('/v1/event')) throw new Error('断网');
    return real(url, body, headers);
  };
}

function readyRoutes(http: FakeHttp): void {
  http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
  http.postRoutes.set(`${BASE}/v1/event`, json({ payload_cid: '' }));
}

describe('reportProgress（#8 册子 §5.2 / §5.3 / §5.4）', () => {
  it('上报：先本地双写，再带类型签名投递；updated_at = 胜者事件 created_at', async () => {
    const { http, repo, o } = fixture();
    readyRoutes(http);

    const res = await reportProgress(
      o,
      { itemId: 'article/a', position: 640, done: false, day: '2026-10-01' },
      1000,
    );

    expect(res).toEqual({ reported: true, queued: false });
    expect(http.posted.map((p) => p.url)).toEqual([`${BASE}/v1/identity/register`, `${BASE}/v1/event`]);
    const sent = JSON.parse(decodeUtf8(http.posted[1]!.body)) as {
      type: string;
      body: Record<string, unknown>;
      created_at: number;
    };
    expect(sent.type).toBe('progress.v1');
    expect(sent.body).toEqual({ item_id: 'article/a', position: 640, done: false, day: '2026-10-01' });

    const local = await repo.getProgress('article/a');
    expect(local).toMatchObject({ position: 640, done: false, day: '2026-10-01', dirty: true });
    expect(local!.updatedAt).toBe(sent.created_at);
    expect(local!.eventId).toHaveLength(32);
    expect((await repo.listCheckinDays()).map((d) => d.day)).toEqual(['2026-10-01']);
  });

  it('节流：同一 item_id 不足 5s 丢帧（不写本地也不发），满 5s 再发', async () => {
    const { http, repo, o } = fixture();
    readyRoutes(http);

    await reportProgress(o, { itemId: 'article/b', position: 1, done: false, day: '2026-10-01' }, 1000);
    expect(http.posted).toHaveLength(2);

    const dropped = await reportProgress(o, { itemId: 'article/b', position: 2, done: false, day: '2026-10-01' }, 2000);
    expect(dropped).toEqual({ reported: false, queued: false });
    expect(http.posted).toHaveLength(2);
    expect((await repo.getProgress('article/b'))!.position).toBe(1); // 丢帧不落库

    await reportProgress(o, { itemId: 'article/b', position: 3, done: false, day: '2026-10-01' }, 6000);
    expect(http.posted).toHaveLength(4);
  });

  it('参数非法：不写本地、不发请求', async () => {
    const { http, repo, o } = fixture();
    readyRoutes(http);

    expect(await reportProgress(o, { itemId: '', position: 1, done: false })).toEqual({ reported: false, queued: false });
    expect(await reportProgress(o, { itemId: 'article/x', position: -1, done: false })).toEqual({ reported: false, queued: false });
    expect(await reportProgress(o, { itemId: 'article/x', position: 1.5, done: false })).toEqual({ reported: false, queued: false });

    expect(http.posted).toHaveLength(0);
    expect(await repo.listProgress()).toEqual([]);
  });

  it('断网：本地已写 + wire 入 comment_out（目标 = item_id，正文留空）', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    offlineEventPost(http);

    const res = await reportProgress(o, { itemId: 'article/c', position: 30, done: false, day: '2026-10-01' }, 1000);

    expect(res).toEqual({ reported: true, queued: true });
    const q = await repo.listCommentOut();
    expect(q).toHaveLength(1);
    expect(q[0]!.targetId).toBe('article/c');
    expect(q[0]!.text).toBe('');
    expect(q[0]!.state).toBe('pending');
    expect((JSON.parse(q[0]!.wire) as { type: string }).type).toBe('progress.v1');
    expect((await repo.getProgress('article/c'))!.position).toBe(30);
  });

  it('未配置节点：只写本地，不发也不入队（同 postComment 口径）', async () => {
    const { http, repo, o } = fixture();
    o.nodeBaseUrl = '';

    const res = await reportProgress(o, { itemId: 'article/d', position: 5, done: false, day: '2026-10-01' }, 1000);

    expect(res).toEqual({ reported: true, queued: false });
    expect(http.posted).toHaveLength(0);
    expect(await repo.listCommentOut()).toHaveLength(0);
    expect((await repo.getProgress('article/d'))!.position).toBe(5);
  });

  it('节点拒绝（429）：本地已写，静默返回，不入队', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, { status: 429, body: utf8(JSON.stringify({ code: 'event_rate_limited' })) });

    const res = await reportProgress(o, { itemId: 'article/e', position: 7, done: false, day: '2026-10-01' }, 1000);

    expect(res).toEqual({ reported: true, queued: false });
    expect(await repo.listCommentOut()).toHaveLength(0);
    expect((await repo.getProgress('article/e'))!.position).toBe(7);
  });
});

describe('pullProgress（#8 册子 §5.5）', () => {
  it('200：progress 与 checkin_days 按同一比较函数并进本地，写回 dirty=false', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.routes.set(
      `${BASE}/v1/me`,
      json({
        events: [],
        progress: [
          {
            item_id: 'article/a',
            position: 900,
            done: true,
            day: '2026-10-01',
            updated_at: 5000,
            event_id: 'b'.repeat(32),
          },
        ],
        checkin_days: [{ day: '2026-09-30', first_event_id: 'c'.repeat(32), created_at: 4000 }],
      }),
    );

    await pullProgress(o);

    const local = await repo.getProgress('article/a');
    expect(local).toMatchObject({ position: 900, done: true, updatedAt: 5000, dirty: false });
    expect((await repo.listCheckinDays()).map((d) => d.day)).toEqual(['2026-09-30']);
  });

  it('非 200 / 网络抛错 / 未配置节点：一律静默，本地不变', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.routes.set(`${BASE}/v1/me`, { status: 403, body: utf8('{}') });

    await expect(pullProgress(o)).resolves.toBeUndefined();
    expect(await repo.listProgress()).toEqual([]);

    const broken = fixture();
    broken.http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    broken.o.adapters.http = {
      get: () => Promise.reject(new Error('断网')),
      post: () => Promise.reject(new Error('断网')),
    };
    await expect(pullProgress(broken.o)).resolves.toBeUndefined();

    const none = fixture();
    none.o.nodeBaseUrl = '';
    await expect(pullProgress(none.o)).resolves.toBeUndefined();
    expect(none.http.posted).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/mobile; npx vitest run src/core/progress-store.test.ts`
Expected: FAIL，`Failed to resolve import "./progress-store"`

- [ ] **Step 3: 写 `apps/mobile/src/core/progress-store.ts`**

```ts
/**
 * 学习进度的编排层（#8 册子 §5.2 / §5.3 / §5.4 / §5.5）：
 * - `reportProgress`：本地双写（`progress` + `checkin_days`）→ 投递 `progress.v1`；**只有网络不可达**才入队。
 * - `pullProgress`：`GET /v1/me` 拉节点侧真实进度与打卡日，按 §3.4 同一比较函数合并进本地。
 *
 * 量纲与判定全在 `core/progress.ts`（纯函数）；本文件只做「写本地 / 发或入队 / 拉回合并」。
 * 离线队列复用 `comment_out`（**不加列**，类型由 `wire` 自带）；补发者是 `core/comment.ts` 的 `flushPending`。
 */
import type { Json } from '@base/protocol-ts';

import type { LocalRepo } from './repo';
import { ensureRegistered } from './comment';
import { ensureLocalIdentity, signRequestHeaders } from './identity';
import { localDay, shouldReport } from './progress';
import { decodeUtf8 } from './sync';
import type { CheckinDayRow, ProgressRow } from './types';
import { buildEventWire, submitWire, type WireOptions } from './wire';

/** 与 `WireOptions` **同形**：`CommentOptions` / `SyncOptions` 可直接喂进来。 */
export type ProgressOptions = WireOptions;

/** `item_id` 的 ASCII 长度上限（#8 册子 §3.1，与 `validTargetID` 同口径）。 */
const ITEM_ID_MAX = 256;

/** 同一 `item_id` 的上次真实上报时刻（毫秒）；只在本进程内节流，不落盘（§5.3）。 */
const lastReportAt = new Map<string, number>();

export interface ProgressInput {
  itemId: string;
  /** 归一化位置，量纲按条目 type 分派（调用方负责，见 `core/progress.ts`） */
  position: number;
  done: boolean;
  /** 覆盖打卡日（测试用）；缺省取本机本地时区的今天 */
  day?: string;
}

export interface ReportResult {
  /** false = 被节流丢弃或参数非法：未写本地、未发请求 */
  reported: boolean;
  /** true = 网络不可达，已入 `comment_out` 待补发 */
  queued: boolean;
}

/**
 * 上报一次进度（§5.2 先写本地、再进队列）。
 *
 * 丢帧是安全的：上报内容一律是**当前位置的绝对值**（不是增量），故少发一次不造成累计误差（§5.3）。
 * 投递失败**不抛错**：上报是后台动作，节点拒绝（429 / 403 / 400）只静默返回——本地已经记住了。
 * 未配置节点时**不入队**（同 `postComment` 口径）：否则队列会变成永远发不出去的垃圾桶。
 */
export async function reportProgress(
  o: ProgressOptions,
  input: ProgressInput,
  now: number = Date.now(),
): Promise<ReportResult> {
  const itemId = input.itemId;
  if (itemId === '' || itemId.length > ITEM_ID_MAX) return { reported: false, queued: false };
  if (!Number.isInteger(input.position) || input.position < 0) return { reported: false, queued: false };
  if (!shouldReport(lastReportAt.get(itemId), now)) return { reported: false, queued: false };

  const day = input.day ?? localDay(new Date(now));
  const body: Json = { item_id: itemId, position: input.position, done: input.done, day };

  const ident = await ensureLocalIdentity(o.adapters.storage);
  const { eventId, wire } = buildEventWire(ident, 'progress.v1', body);
  // updated_at 存**胜者事件的 created_at**（§5.1 写计划时定死）：从 wire 反解，
  // 免去改动已上线的 `buildEventWire` 签名（它不返回 createdAt）。
  const createdAt = Number((JSON.parse(wire) as { created_at?: number }).created_at ?? 0);
  const row: ProgressRow = {
    itemId,
    position: input.position,
    done: input.done,
    day,
    updatedAt: createdAt,
    eventId,
    dirty: true,
  };
  await o.repo.saveProgressLocal(row);
  lastReportAt.set(itemId, now);

  if (o.nodeBaseUrl === '') return { reported: true, queued: false };
  try {
    const { queued } = await submitWire(o, { eventId, wire, targetId: itemId, queueText: '' });
    return { reported: true, queued };
  } catch {
    return { reported: true, queued: false };
  }
}

/**
 * 拉节点侧进度并合并进本地（§5.5）。**只在同步时调用**，不参与页面渲染路径。
 * 一律静默：未配置节点 / 身份未登记 / 网络失败 / 非 200 都不抛错——页面只读本地表。
 */
export async function pullProgress(o: ProgressOptions): Promise<void> {
  if (o.nodeBaseUrl === '') return;
  try {
    // 签名 GET 要求身份已在节点侧登记，否则 403（与评论读接口同一前置）。
    const ident = await ensureRegistered(o);
    const headers = signRequestHeaders(ident, { method: 'GET', path: '/v1/me' });
    const res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/me`, headers);
    if (res.status !== 200) return;
    const page = JSON.parse(decodeUtf8(res.body)) as {
      progress?: Array<Record<string, unknown>>;
      checkin_days?: Array<Record<string, unknown>>;
    };
    const rows: ProgressRow[] = (page.progress ?? []).map((r) => ({
      itemId: String(r.item_id ?? ''),
      position: Number(r.position ?? 0),
      done: Boolean(r.done),
      day: String(r.day ?? ''),
      updatedAt: Number(r.updated_at ?? 0),
      eventId: String(r.event_id ?? ''),
      dirty: false,
    }));
    const days: CheckinDayRow[] = (page.checkin_days ?? []).map((r) => ({
      day: String(r.day ?? ''),
      firstEventId: String(r.first_event_id ?? ''),
      createdAt: Number(r.created_at ?? 0),
    }));
    await o.repo.mergeProgress(rows, days);
  } catch {
    // 静默：拉取失败不该打断 onShow（页面渲染只读本地表）
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/mobile; npx vitest run src/core/progress-store.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: 类型检查 + 提交**

Run: `cd apps/mobile; npx tsc --noEmit`
Expected: 无输出（0 错误）

```bash
git add apps/mobile/src/core/progress-store.ts apps/mobile/src/core/progress-store.test.ts
git commit -m "feat(mobile): 新增进度上报与拉取编排（离线复用 comment_out 队列）"
```

---

## Task 9: 内容页续位与上报（`article.vue` / `quiz.vue`）

**Files:**
- Modify: `apps/mobile/src/pages/article/article.vue`
- Modify: `apps/mobile/src/pages/quiz/quiz.vue`

> 本 Task 两个页面互不重叠，可独立验证。真机项（续位手感、细进度条）**本册延后**，只登记不下场。

- [ ] **Step 1: `article.vue` 加 import**

第 41 行整行替换：

```ts
import { onHide, onLoad, onPageScroll, onUnload } from '@dcloudio/uni-app';
```

`import { setPendingTarget } from '../../core/comment';` 那行**之后**追加两行：

```ts
import { articleDone, articlePosition } from '../../core/progress';
import { reportProgress } from '../../core/progress-store';
```

- [ ] **Step 2: `article.vue` 加 `pendingRestore` ref**

`const scrolled = ref(0);` 那行**之后**追加：

```ts
/** 待续位的滚动比例 0..1（进入时从本地 progress 读出）；0 = 不续位 */
const pendingRestore = ref(0);
```

- [ ] **Step 3: `article.vue` 两处 onLoad 分支各加一行续位**

(a) `from=ledger` 分支：`await nextTick();` 那行**之前**插入：

```ts
      await restoreProgress(sub.itemId);
```

(b) 常规分支：`await repo.markRead(row.itemId, new Date().toISOString());` 那行**之后**、`await nextTick();` **之前**插入：

```ts
    await restoreProgress(row.itemId);
```

- [ ] **Step 4: `article.vue` 改 `paintProgress` 并加三个函数 + 两个生命周期**

`function paintProgress()` 整体替换为：

```ts
/**
 * 进度 = 已滚 / 可滚。可滚高度必须实测：正文长短与字号都影响它。
 * 未量到 / 无需滚动（短文全可见）时**保留本地续位画出的初值**，不归零——
 * 否则推进去的一瞬间会把「上次读到哪」洗掉。
 */
function paintProgress() {
  if (scrollable.value <= 0) return;
  progress.value = Math.min(100, Math.max(0, Math.round((scrolled.value / scrollable.value) * 100)));
}
```

在 `measure()` 函数**之后**追加：

```ts
/** 进入时按本地 progress 续位：细进度条先画到上次位置，正文渲染完（`measure`）后再滚过去（#8 册子 §6）。 */
async function restoreProgress(id: string) {
  try {
    const { repo } = await bootstrap();
    const p = await repo.getProgress(id);
    if (!p) return;
    progress.value = Math.round(Math.min(1000, Math.max(0, p.position)) / 10);
    if (p.position > 0 && p.position < 1000) pendingRestore.value = p.position / 1000;
  } catch {
    // 读本地失败不影响阅读
  }
}

/** 当前位置的归一化千分比：无需滚动（短文全可见）即视为读完。 */
function currentPosition(): number {
  return articlePosition(scrollable.value > 0 ? scrolled.value / scrollable.value : 1);
}

/**
 * 离开页面 / 切前后台时上报一次（§5.3 触发点；不做「滚动即写」——队列会被滚动淹没并撞节点限速）。
 * 失败静默：本地已由 `reportProgress` 写入，离开动作不该弹错。
 */
async function reportNow() {
  if (itemId.value === '') return;
  try {
    const { opts, repo } = await bootstrap();
    const position = currentPosition();
    await reportProgress(
      { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl },
      { itemId: itemId.value, position, done: articleDone(position) },
    );
  } catch {
    // 静默
  }
}

onHide(() => {
  void reportNow();
});
onUnload(() => {
  void reportNow();
});
```

`measure()` 的 `.exec(...)` 回调整体替换为：

```ts
    .exec((res) => {
      const rect = res && res[0] ? (res[0] as { height?: number }) : undefined;
      scrollable.value = Math.max(0, (rect?.height ?? 0) - winH);
      // 续位只能在量到可滚高度之后做：`Math.round(scrollable * fraction)` 才是千分比对应的像素位
      if (pendingRestore.value > 0 && scrollable.value > 0) {
        const top = Math.round(scrollable.value * pendingRestore.value);
        pendingRestore.value = 0;
        uni.pageScrollTo({ scrollTop: top, duration: 0 });
      }
      paintProgress();
    });
```

- [ ] **Step 5: `quiz.vue` 加 import**

第 29 行整行替换：

```ts
import { onHide, onLoad, onUnload } from '@dcloudio/uni-app';
```

`import { gradeAnswer, parseQuestionDoc, shuffleAll, type ShuffledQuestion } from '../../core/quiz';` 那行**之后**追加两行：

```ts
import { quizDone, quizPosition } from '../../core/progress';
import { reportProgress } from '../../core/progress-store';
```

- [ ] **Step 6: `quiz.vue` 两处 onLoad 分支各加一行续位**

(a) `from=ledger` 分支：`questions.value = shuffleAll(parsed, sub.itemId);` 那行**之后**插入：

```ts
      await restoreProgress();
```

(b) 常规分支：`questions.value = shuffleAll(parsed, row.itemId);` 那行**之后**插入：

```ts
    await restoreProgress();
```

- [ ] **Step 7: `quiz.vue` 加三个函数 + 两个生命周期**

在 `function restart()` 函数**之前**插入：

```ts
/** 已作答题数：已翻过的题 + 当前题（已作答则计入）——#8 册子 §3.2 的 quiz 量纲。 */
function answeredCount(): number {
  return index.value + (picked.value !== null ? 1 : 0);
}

/** 进入时续位到上次题号（§6 内容页续位）；全答完时落在最后一题。 */
async function restoreProgress() {
  if (questions.value.length === 0) return;
  try {
    const { repo } = await bootstrap();
    const p = await repo.getProgress(itemId.value);
    if (!p) return;
    index.value = Math.min(Math.max(0, p.position), questions.value.length - 1);
  } catch {
    // 读本地失败不影响答题
  }
}

/**
 * 离开页面 / 切前后台时上报一次（§5.3 触发点）。`done` = 全答完（空题库不算完成）。
 * 失败静默：本地已写入。
 */
async function reportNow() {
  if (itemId.value === '' || questions.value.length === 0) return;
  try {
    const { opts, repo } = await bootstrap();
    const position = quizPosition(answeredCount(), questions.value.length);
    await reportProgress(
      { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl },
      { itemId: itemId.value, position, done: quizDone(position, questions.value.length) },
    );
  } catch {
    // 静默
  }
}

onHide(() => {
  void reportNow();
});
onUnload(() => {
  void reportNow();
});
```

- [ ] **Step 8: 类型检查 + 模板 `.value` 硬检查 + 提交**

Run: `cd apps/mobile; npx tsc --noEmit`
Expected: 无输出（0 错误）

Run（仓库根）: `git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- apps/mobile/src/pages/*/*.vue`
Expected: 无输出（模板里不得出现 `.value`，见 0.9.3 的整页空白事故）

```bash
git add apps/mobile/src/pages/article/article.vue apps/mobile/src/pages/quiz/quiz.vue
git commit -m "feat(mobile): 内容页续位到本地进度并在离开时上报 progress.v1"
```

---

## Task 10: 课程页完成度（`course.vue`）

**Files:**
- Modify: `apps/mobile/src/pages/course/course.vue`

- [ ] **Step 1: 加 import 与 ref**

第 82 行整行替换：

```ts
import { childrenOf, groupCoursesByCategory, splitCourses } from '../../core/course-tree';
```

第 85 行整行替换：

```ts
import type { ItemRow, ProgressRow, SegmentRow } from '../../core/types';
```

`import { canSync } from '../../core/selfcheck';` 那行**之后**追加两行：

```ts
import type { LocalRepo } from '../../core/repo';
import { lessonCompleted } from '../../core/progress';
```

`const marksByItemId = ref(new Map<string, { badge: string[]; titleColor: string }>());` 那行**之后**追加：

```ts
/** 每门课的完成度（已学 a / b 讲）；分母为 0 的课**不入 Map** ⇒ 模板不显示该行（#8 册子 §6） */
const completionByCourse = ref(new Map<string, { done: number; total: number }>());
```

- [ ] **Step 2: 加聚合函数**

在 `load()` 函数**之前**插入：

```ts
/**
 * 一门课的完成度（#8 册子 §6）。分母 = **可达** lesson 数，分子 = 其中「可达叶子非空且全 done」的 lesson 数。
 * 未下载的子条目（不在本地 `items` 里）**不计入分母**；分母为 0 时由调用方不显示该行（不是显示 0 / 0）。
 * 只用于展示：**不产生事件、不落表**。
 */
async function courseCompletion(
  courseId: string,
  repo: LocalRepo,
  byId: Map<string, ItemRow>,
  progressByItem: Map<string, ProgressRow>,
): Promise<{ done: number; total: number }> {
  let done = 0;
  let total = 0;
  for (const lessonId of childrenOf(await repo.listSegments(courseId))) {
    if (!byId.has(lessonId)) continue;
    const leafDone: boolean[] = [];
    for (const leafId of childrenOf(await repo.listSegments(lessonId))) {
      const leaf = byId.get(leafId);
      if (!leaf) continue;
      // 叶子载体只有这三类才有 position / done（#8 册子 §3.2）
      if (leaf.type !== 'article' && leaf.type !== 'video' && leaf.type !== 'quiz') continue;
      leafDone.push(progressByItem.get(leafId)?.done === true);
    }
    if (leafDone.length === 0) continue;
    total += 1;
    if (lessonCompleted(leafDone)) done += 1;
  }
  return { done, total };
}

/** 「已学 a / b 讲」；无数据（分母 0）返回空串 ⇒ 模板不显示该行。 */
function completionText(courseId: string): string {
  const c = completionByCourse.value.get(courseId);
  return c ? `已学 ${c.done} / ${c.total} 讲` : '';
}
```

- [ ] **Step 3: 在 `load()` 里算出完成度**

`marksByItemId.value = marks;` 那行**之后**插入：

```ts
    // 每门课的完成度（#8 册子 §6）：只读派生，复用上面已建的 segsByItemId；零写入。
    const byId = new Map(active.map((i) => [i.itemId, i]));
    const progressByItem = new Map((await repo.listProgress()).map((r) => [r.itemId, r]));
    const completion = new Map<string, { done: number; total: number }>();
    for (const it of active) {
      if (it.type !== 'course') continue;
      const c = await courseCompletion(it.itemId, repo, byId, progressByItem);
      if (c.total > 0) completion.set(it.itemId, c);
    }
    completionByCourse.value = completion;
```

- [ ] **Step 4: 模板三处课程行各加一行**

(a) 分类分组里的课程行（`<text class="meta">{{ it.itemId }} · {{ it.rev }}</text>`，缩进 12 空格，第 35 行）**之后**插入：

```html
            <text v-if="completionText(it.itemId)" class="meta">{{ completionText(it.itemId) }}</text>
```

(b) 「未归类课程」行（缩进 8 空格，第 45 行）**之后**插入：

```html
        <text v-if="completionText(it.itemId)" class="meta">{{ completionText(it.itemId) }}</text>
```

(c) 「课程」行（无分组时的回落块，缩进 8 空格，第 63 行）**之后**插入：

```html
        <text v-if="completionText(it.itemId)" class="meta">{{ completionText(it.itemId) }}</text>
```

（**不要**加在「独立内容」/「未归类」文章行上：它们不是课程容器，没有 lesson 分母。）

- [ ] **Step 5: 类型检查 + 模板 `.value` 硬检查 + 提交**

Run: `cd apps/mobile; npx tsc --noEmit`
Expected: 无输出（0 错误）

Run（仓库根）: `git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- apps/mobile/src/pages/*/*.vue`
Expected: 无输出

```bash
git add apps/mobile/src/pages/course/course.vue
git commit -m "feat(mobile): 课程页显示每门课的完成度（已学 a / b 讲）"
```

---

## Task 11: 我的页进度卡（`mine.vue`）

**Files:**
- Modify: `apps/mobile/src/pages/mine/mine.vue`

- [ ] **Step 1: 加 import 与状态**

第 28-34 行的 import 块整体替换为：

```ts
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import type { LearningStats } from '../../core/types';
import { flushPending } from '../../core/comment';
import { checkinStreak, localDay } from '../../core/progress';
import { pullProgress } from '../../core/progress-store';
import { myIdentityId, roster } from '../../core/contribution';
import { bootstrap } from '../../platform';
```

`const rosterState = ref<'in' | 'out' | 'unknown'>('unknown');` 那行**之后**追加：

```ts
/** 在学中列表项（有进度但 `done=false`）；**只展示、不可点**（#8 册子 §2 排除独立进度页） */
interface StudyingRow {
  itemId: string;
  title: string;
  hint: string;
}

const todayDone = ref(false);
const streak = ref(0);
const studying = ref<StudyingRow[]>([]);
```

- [ ] **Step 2: 加提示函数**

在 `onShow(...)` **之前**插入：

```ts
/** 在学中行的进度提示（量纲按 type 分派，与 #8 册子 §3.2 同口径；未知类型不显示）。 */
function progressHint(type: string, position: number): string {
  if (type === 'article') return `已读 ${Math.round(Math.min(1000, Math.max(0, position)) / 10)}%`;
  if (type === 'video') return `已看 ${position} 秒`;
  if (type === 'quiz') return `已答 ${position} 题`;
  return '';
}
```

- [ ] **Step 3: 改 `onShow`**

`onShow(async () => { ... });` 整块替换为：

```ts
// onShow 而不是 onLoad：从阅读器或答题页返回后必须立刻反映
onShow(async () => {
  try {
    const { opts, repo } = await bootstrap();
    const o = { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl };

    // 补发待发队列（评论 / 小组 / 私信 / **进度**共用同一 `comment_out`，类型由 wire 自带）
    // + 拉节点侧进度并合并进本地（#8 册子 §5.4 / §5.5）。两者都只经返回值 / 静默体现，
    // 绝不让「我的」页报错；失败也不影响下面的本地读取。
    try {
      await flushPending(o);
      await pullProgress(o);
    } catch {
      // 忽略
    }

    stats.value = await repo.learningStats();
    pendingCount.value = (await repo.listSubmissions('pending')).length;

    // 打卡卡（#8 册子 §3.5）：某日已打卡 ⇔ 存在该日事件；连续天数从今天回溯、首个缺口即断
    const days = new Set((await repo.listCheckinDays()).map((d) => d.day));
    const today = localDay();
    todayDone.value = days.has(today);
    streak.value = checkinStreak(days, today);

    // 在学中 = 有进度但未完成的条目，最近更新的在前，最多 5 条
    const byId = new Map((await repo.listItems()).map((i) => [i.itemId, i]));
    studying.value = (await repo.listProgress())
      .filter((p) => !p.done)
      .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : 0))
      .slice(0, 5)
      .map((p) => {
        const it = byId.get(p.itemId);
        return {
          itemId: p.itemId,
          title: it?.title || p.itemId,
          hint: progressHint(it?.type ?? '', p.position),
        };
      });

    const myId = await myIdentityId(o);
    const list = await roster(o);
    rosterState.value = myId !== '' && list.some((c) => c.id === myId) ? 'in' : 'out';
  } catch {
    // 「我的」不因读库 / 拉名册失败而报错，保持上一次的值（含 rosterState 保持 unknown）
  }
});
```

- [ ] **Step 4: 模板加进度卡**

第一个 `<view class="card">...</view>`（统计卡，第 4-8 行）**之后**插入：

```html
    <view class="card">
      <view class="row"><text class="k">今日打卡</text><text class="v">{{ todayDone ? '已打卡' : '未打卡' }}</text></view>
      <view class="row"><text class="k">连续打卡</text><text class="v">{{ streak }} 天</text></view>
      <block v-if="studying.length > 0">
        <view class="row"><text class="k">在学中</text></view>
        <view v-for="p in studying" :key="p.itemId" class="row">
          <text class="k">{{ p.title }}</text>
          <text class="v">{{ p.hint }}</text>
        </view>
      </block>
    </view>
```

- [ ] **Step 5: 类型检查 + 模板 `.value` 硬检查 + 提交**

Run: `cd apps/mobile; npx tsc --noEmit`
Expected: 无输出（0 错误）

Run（仓库根）: `git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- apps/mobile/src/pages/*/*.vue`
Expected: 无输出

```bash
git add apps/mobile/src/pages/mine/mine.vue
git commit -m "feat(mobile): 我的页新增进度卡（今日打卡 / 连续天数 / 在学中）并挂补发与拉取"
```

---

## Task 12: 版本 + 门禁 + 上游回填 + 发布

**Files:**
- Modify: `apps/mobile/src/manifest.json:5-6`
- Modify: `docs/README.md`（§3 第 8 行状态 + 新增计划行；§4 依赖图；§5 当前阶段与待人工）

- [ ] **Step 1: 版本号**

`apps/mobile/src/manifest.json` 两行替换：

```json
    "versionName" : "0.17.0",
    "versionCode" : "22",
```

- [ ] **Step 2: `docs/README.md` 回填（五处）**

> 注：本步骤在**出计划时已随册子/计划一并落笔并提交**（`#46`–`#54` 的既有做法：每份文档写完即回填 README 并 push）。执行 Task 12 时**只需核对下列五处现状与预期一致**；若一致即勾选跳过，不要重复改写。

(a) **§3 文档清单第 34 行**（`| 8 | specs/*-base-progress-design.md | ... |`）的**状态列** `待写` 改为：

```
册子已定稿（`specs/2026-10-01-base-progress-design.md`）；计划 #55 已出，待执行
```

(b) **§3 文档清单末尾**追加一行（`#55` 的取号口径：本册写作时表内最大编号为 `#54`，故取 +1；执行时若已被占用则顺延并同步改 (a) 的引用）：

```
| 55 | `plans/2026-10-01-base-progress-plan.md` | 学习进度与打卡实施计划（`progress.v1` + 节点两表 + 手机端两表 + 三处展示） | 不做排名 / 奖励 / 公开可见性 / 独立进度页 | 册子 #8、总纲 §0.11 | 已出，待执行 |
```

(c) **§4 依赖图第 87 行**（`├─ 进度 (#8)`）整行替换为：

```
 │                          ├─ 进度 (#8：册子已定稿 → 计划 #55 已出)
```

(d) **§5 当前阶段**的「已完成」末尾追加：

```
、**B 主线第四形态「学习进度与打卡」（#8 册子 + 计划 #55）已出册子与计划，待执行**（`progress.v1` 事件 + 节点 `progress` / `checkin_days` 两投影表 + `GET /v1/me` 接真 + 手机端两张本地表与三处展示；真机项按用户指令延后，只登记不消耗）
```

(e) **§5 待人工**列表末尾追加：

```
；`#55`（学习进度与打卡）的真机验收 5 条延后（内容页续位与细进度条、课程页「已学 a / b 讲」、我的页进度卡与连续天数、跨设备收敛、断网写入后联网补发）
```

- [ ] **Step 3: 全量门禁**

Run（仓库根 `base`）:

```bash
go build ./...
go vet ./...
go test ./...
```

Expected: `go test` 全包 `ok`（含新增的 `internal/store` / `internal/protocol` / `internal/httpapi` / `internal/peersync` 用例）

Run（`base/apps/mobile`）:

```bash
npx vitest run
npx tsc --noEmit
npm run build:h5
```

Expected: vitest **31 文件全绿**（原 28 + `progress.test.ts` + `progress-repo.test.ts` + `progress-store.test.ts`）；`tsc` 无输出；`build:h5` 成功

Run（仓库根）:

```bash
git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- apps/mobile/src/pages/*/*.vue
powershell -File scripts/acceptance-d.ps1
```

Expected: 第一条无输出；第二条无 `FAIL`

- [ ] **Step 4: 提交代码与文档**

```bash
git add apps/mobile/src/manifest.json docs/README.md docs/superpowers/specs/2026-10-01-base-progress-design.md docs/superpowers/plans/2026-10-01-base-progress-plan.md
git commit -m "chore: 进度册子定稿 + 实施计划，版本落 0.17.0/22，README 回填"
```

**注意**：`git add` 只列本任务文件——**不要**碰工作区里既有的 ` M .gitignore` 与未跟踪的 `based-linux-amd64`。

- [ ] **Step 5: 节点二进制重编 + `mv` 原子替换部署**

（节点侧新增两张表与一条事件类型 ⇒ 必须重编；口径同 `0.16.0` 收口。）

```bash
GOOS=linux GOARCH=amd64 go build -o based-linux-amd64 ./cmd/based
```

上传后在节点上：

```bash
mv /opt/base/based /opt/base/based.bak-pre-0.17.0
mv based-linux-amd64 /opt/base/based
chmod 0755 /opt/base/based
systemctl restart base
systemctl restart base-cache
systemctl is-active base base-cache
```

Expected: 两单元均 `active`；探活 `GET /v1/comment` → 200、`GET /v1/proposal` → 200、`POST /v1/blob` → 400（非 404，无回归）、`GET /v1/blobzzz` → 404（反向对照）。

- [ ] **Step 6: 手机端四步发布（REL）**

```bash
# 1) 云打包（HBuilderX CLI）
# 2) 上传 APK
scp base-0.17.0.apk root@<节点>:/opt/appdl/base-0.17.0.apk
# 3) 落地页整页重写改指（仅含新版本号，无 0.16.0 残留）
# 4) 服务器上签发
based release
```

Expected: 线上 `GET /v1/release`（:80）→ `0.17.0`；`HEAD /dl/base-0.17.0.apk` = 200 且 `Content-Length` 与本地逐字一致；`verifyRelease` = `true`；证书 SHA1 仍是 `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`（否则不能覆盖安装）。

- [ ] **Step 7: push**

```bash
git push
```

---

## Self-Review

**1. Spec 覆盖**

| 册子条目 | 落地 Task |
| --- | --- |
| §3.1 `progress.v1` 形状（含 `item_id` 1..256 / `position>=0` / `done` 必填 / `day` 形态）+ 不带正文块 | Task 2（协议侧隐式）、Task 3（`parseProgressBody` 逐字段校验）、Task 8（客户端只送这四键） |
| §3.2 `position` 归一化三分派 + `done` 判定主体是客户端 | Task 2（`ArticlePosition`/`VideoPosition`/`QuizPosition`，Go 侧**不含** `done` 谓词）、Task 6（`articleDone`/`quizDone`）、Task 9/10 调用 |
| §3.3 `(id,item_id)` 一个 LWW 寄存器 | Task 1（`progress` 主键 `(id,item_id)`）、Task 7（本地主键 `item_id`） |
| §3.4 LWW 口径 + 契约向量 | Task 2（`ProgressWins` + `vectors/v1/progress.json`）、Task 6（TS 同一向量）、Task 7（`saveProgressLocal` / `mergeProgress` 复用 `progressWins`） |
| §3.5 打卡日界 / 已打卡判据 / 连续天数 / 必须独立存储 | Task 1（`checkin_days` insert-or-ignore）、Task 2（`validDay`）、Task 6（`localDay`/`shiftDay`/`checkinStreak`）、Task 7（同事务双投影）、Task 11（`checkinStreak` 展示） |
| §4.1 放行 + 分流（不走 `putBareEvent`） | Task 3 |
| §4.2 两张投影表 + 同事务 + `dirty` 语义 | Task 1、Task 3（调用点） |
| §4.3 反熵 `parseEventProjection` 加分支（不动 `EventBlobIndex`） | Task 5 |
| §4.4 `GET /v1/me` 三数组接真（含 `event_id` / `checkin_days` 必需字段） | Task 4 |
| §4.5 限速不放宽、靠客户端节流 | Task 6（`REPORT_MIN_INTERVAL_MS`）、Task 8（`shouldReport`）、Task 9/11 不做滚动即写 |
| §5.1 本地两表 + 幂等补列 + `updated_at` 语义 | Task 7 |
| §5.2 先写本地再进队列 | Task 8（`saveProgressLocal` 在 `submitWire` 之前） |
| §5.3 触发点与节流 | Task 6（`shouldReport`）、Task 8、Task 9（`onHide`/`onUnload`） |
| §5.4 离线复用 `comment_out`（不加列 / `target_id`=item_id / `text` 留空 / 补发走 `flushPending`） | Task 8（入队）、Task 11（`flushPending` 挂载点） |
| §5.5 页面读本地、`GET /v1/me` 只在同步时合并 | Task 8（`pullProgress`）、Task 9/10/11（渲染只读本地表） |
| §6 三处展示 + 容器完成度聚合口径（分母不含未下载、分母 0 不显示） | Task 9（内容页续位 + 细进度条）、Task 10（课程页「已学 a / b 讲」）、Task 11（我的页进度卡） |
| §7 上游回填（总纲 §0.11 等**已完成**；README 三处） | Task 12 Step 2 |
| §8.1 自动化门禁（Go / vitest / 向量 / 门禁五道） | Task 1–11 各自的测试步 + Task 12 Step 3 |
| §8.2 真机项延后、只登记 | Task 12 Step 2(e)（README §5 待人工）+ 本计划 Task 9 抬头声明 |
| §9 版本 `0.17.0`/`22` + REL 四步 + 节点二进制重编 | Task 12 Step 1 / 5 / 6 |

**缺口**：无。册子 §2「明确不做」的七条无一被实现（未做公开可见性、排名、独立进度页、冲突介入 UI、学习时长、iOS、包规范改动）。

**2. 占位符扫描**

已逐节复查：无 `TBD` / `TODO` / 「实现稍后」/「加适当错误处理」/「与 Task N 类似」/「为上述写测试」。每个改动步都给了完整代码或完整替换片段，每条命令都带期望输出。

**3. 类型与命名一致性**

- `ProgressRow` / `CheckinDayRow` 字段名在 Task 7（定义）、Task 8（构造 / 消费）、Task 10/11（读）三处一致：`itemId` / `position` / `done` / `day` / `updatedAt` / `eventId` / `dirty`，以及 `day` / `firstEventId` / `createdAt`。
- 函数名跨 Task 一致：`progressWins`（Task 6 定义，Task 7 两侧仓储消费）、`articleDone` / `quizDone` / `articlePosition` / `quizPosition` / `checkinStreak` / `localDay` / `shouldReport` / `lessonCompleted` / `REPORT_MIN_INTERVAL_MS`（Task 6 定义，Task 8/9/10/11 消费）、`reportProgress` / `pullProgress`（Task 8 定义，Task 9/11 消费）。
- 仓储方法名一致：`LocalRepo` 5 方法（Task 7 Step 5 定义）↔ `SqlRepo`（Step 6）↔ `MemoryRepo`（Step 8）三处签名逐字相同；Read 侧 `getProgress` / `listProgress` / `listCheckinDays` 被 Task 8/9/10/11 使用且均已在 Step 5 声明。
- Go 侧：`protocol.ProgressWins` / `store.PutProgressProjection` / `store.ListProgressByID` / `store.CheckinDaysOf`（Task 1–2 定义）在 Task 3–5 的调用点逐字一致（Task 5 复用同一 `PutProgressProjection` 而非新写反熵专用写入）。
- `ensureProgressColumns`（Task 7 Step 4 定义）↔ `platform/index.ts` 调用名（Step 9）一致。

**已修正的两处不自洽**（写计划期发现）：① `doneRatio` 一度被列入 `progress.ts`，但它无消费者（分母 0 时该行不显示）⇒ 已从设计中删除，改由 `lessonCompleted(leafDone: boolean[])` 返回布尔；② `progressWinner` 一度被列为本地合并辅助函数，但本地表主键唯一、合并只需 `progressWins` ⇒ 已删除，避免死代码。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-01-base-progress-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — 每个 Task 派发全新子代理，Task 之间做两阶段审查（实现审查 + 规格审查），迭代快、主上下文干净。

**2. Inline Execution** — 在本会话内用 `superpowers:executing-plans` 批量执行，按检查点暂停复核。

**Which approach?**

- 若选 1：**REQUIRED SUB-SKILL** `superpowers:subagent-driven-development`（fresh subagent per task + two-stage review）。
- 若选 2：**REQUIRED SUB-SKILL** `superpowers:executing-plans`（batch execution with checkpoints）。