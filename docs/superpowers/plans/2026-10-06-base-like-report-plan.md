# base 点赞/举报实施计划（#79 册子）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 #79 册子——`like.v1` / `report.v1` 两事件类型进 `eventTypeRegistry`（写侧零新路由）、LWW 即时聚合计数、三读面内联 `like_count`、审核面 `POST /v1/admin/review/reported`、mobile 评论点赞/举报 + 条目点赞 + 条目举报快捷提案，Go/Node 双实现同修。

**Architecture:** 写面复用 `POST /v1/event` 管线（registry + switch 分支，内容签名沿用 `sig` 不新增域）；计数零新表——events 加 `(type,target_id)` 索引后读时聚合（`json_extract` 取 action）；接收侧 `parseEventProjection` 扩两分支；mobile 新本地表 `like_out` 作高亮态台账、`items` 补列 `like_count`。顺序：**先节点（Go→Node→对拍→部署）后客户端（core-ts→页面→发布）**（P6 红线：先升节点、后开事件）。

**Tech Stack:** Go 1.x（`internal/httpapi` / `internal/store` / `internal/peersync`）、Node（`apps/node` esbuild bundle，vitest）、TS 共享核心（`packages/core-ts`，vitest）、uni-app Vue3（`apps/mobile`）。

---

## 环境铁律（每个 Go Task 都要）

- Go 命令一律带 PATH 前缀：`$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go test ./internal/store/ -run TestLikeCounts -v`
- 提交纪律：每 Task 只 `git add` 该 Task 列出的文件；不碰工作区其它未提交改动；**绝不** add `scripts/__pycache__/`、`.bak*`、bundle 产物。
- commit 信息风格：`feat(store): ...` / `test(node): ...` / `docs: ...`，一行说清。
- 册子 = `docs/superpowers/specs/2026-10-06-base-like-report-design.md`（下称 #79）。实现与本计划冲突时以 #79 为准，先改计划再动手。

## 门禁总表

| 门禁 | 内容 | 落在 |
|---|---|---|
| G1 | Go `go vet ./... && go build ./... && go test ./internal/...` 全绿 | T7 |
| G2 | Node `tsc --noEmit && vitest run` 全绿 | T10 |
| G3 | 双端对拍：同数据集下 comment / catalog / reported 三读面 JSON 逐字段一致（Go golden ↔ Node vitest 断言同一 golden） | T11 |
| G4 | core-ts vitest 全绿（`like_out` 台账 + wire 构造） | T12 |
| G5 | mobile `tsc --noEmit && vitest run && npm run build:h5` + 模板 `.value` 硬检查 | T15 |
| G6 | 回填实况：#79 状态行、README §5、commit 历史完整 | T16 |
| G7 | 线上双单元探活：Go 源节点 + Node base-cache 同版本新面全 200，无密钥 reported 404，blobzzz 反向对照 404 | T17 |
| G8 | mobile 发布四步 + 线上 `/v1/release` 核对 + 真机 3 条（#79 §9.2） | T18 |

---

### Task 1: Go store 层——索引 + 计数查询 + reported 列表 + 条目校验辅助

**Files:**
- Modify: `internal/store/schema.go`（索引迁移列表，L417-419 三行之后追加一行）
- Create: `internal/store/like.go`
- Test: `internal/store/like_test.go`

- [ ] **Step 1.1: 回读脚手架**

读 `internal/store/comment_test.go`（或 schema_test.go）开头的建库手法（内存库 / 临时目录 + `Open`/`New`），后续测试沿用同款；回读 `internal/store/schema.go` L410-425 的迁移结构（补列后建索引的注释区）。

- [ ] **Step 1.2: 写失败测试（like_test.go）**

沿用 Step 1.1 的建库手法，用例体：

```go
func seedEvent(t *testing.T, st *Store, id, eventID, typ, target, bodyJSON string, createdAt int64) {
	t.Helper()
	if err := st.PutEvent(Event{EventID: eventID, ID: id, Type: typ, BodyJSON: bodyJSON,
		CreatedAt: createdAt, ReceivedAt: createdAt, TargetID: target}); err != nil {
		t.Fatal(err)
	}
}

const likeJSON = `{"action":"%s","target_id":%q,"sig":"00"}` // 计数只读 action，其余字段无关

func TestLikeCountsByTargetsLWW(t *testing.T) {
	st := openTestStore(t)
	// actor A：like(t=100) → unlike(t=200) ⇒ 不计
	seedEvent(t, st, "A", "aa01", "like.v1", "c1", fmt.Sprintf(likeJSON, "like"), 100)
	seedEvent(t, st, "A", "aa02", "like.v1", "c1", fmt.Sprintf(likeJSON, "unlike"), 200)
	// actor B：like(t=300) ⇒ 计 1
	seedEvent(t, st, "B", "bb01", "like.v1", "c1", fmt.Sprintf(likeJSON, "like"), 300)
	// actor C：乱序——旧 like(t=50) 晚到，已有新 unlike(t=80) ⇒ 不计
	seedEvent(t, st, "C", "cc02", "like.v1", "c1", fmt.Sprintf(likeJSON, "unlike"), 80)
	seedEvent(t, st, "C", "cc01", "like.v1", "c1", fmt.Sprintf(likeJSON, "like"), 50)
	// actor D：只对 c2 点赞（不同 event_id 的重复 like 仍只计 1）
	seedEvent(t, st, "D", "dd01", "like.v1", "c2", fmt.Sprintf(likeJSON, "like"), 100)
	seedEvent(t, st, "D", "dd02", "like.v1", "c2", fmt.Sprintf(likeJSON, "like"), 101)

	got, err := st.LikeCountsByTargets([]string{"c1", "c2", "c3"})
	if err != nil { t.Fatal(err) }
	if got["c1"] != 1 || got["c2"] != 1 { t.Fatalf("c1=%d c2=%d, want 1/1", got["c1"], got["c2"]) }
	if _, ok := got["c3"]; ok { t.Fatalf("c3 无赞，map 不应有键") }
}

func TestActiveItemExists(t *testing.T) {
	st := openTestStore(t)
	// 用 store 既有写 items 的路径（commitPack / UpsertItem，回读后沿用）插一条 active + 一条 removed
	// …断言：active→true；removed→false；不存在→false
}

func TestListReportedComments(t *testing.T) {
	st := openTestStore(t)
	// 评论 c1(id=x1) 被甲、乙、甲 举报（去重后 2 人）⇒ report_count=2
	// 评论 c2 被丙举报 1 次；c3 有墓碑 ⇒ 不出现
	// 断言顺序：c1 在前（count 降序）；c1.Reporters == {"甲","乙"} 去重
}
```

（`openTestStore` / items 插入手法以 Step 1.1 回读结果为准，不新造。）

- [ ] **Step 1.3: 跑测试确认失败**

`$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go test ./internal/store/ -run 'TestLikeCounts|TestActiveItem|TestListReported' -v`
预期：编译错误（`LikeCountsByTargets` 等未定义）。

- [ ] **Step 1.4: schema.go 加索引**

在 L417-419 三条 events 索引后追加（同一迁移列表内）：

```go
	`CREATE INDEX IF NOT EXISTS idx_events_type_target ON events(type, target_id)`,
```

- [ ] **Step 1.5: 新建 internal/store/like.go**

```go
package store

// #79 §4：点赞/举报的即时聚合计数（方案 A，零新表）。
// 依赖 idx_events_type_target(type, target_id)（schema.go），按页聚合禁 N+1。

// LikeCountsByTargets 对一批 target（评论 event_id 或条目 item_id）各算 like_count：
// 同 (id, target_id) 取 (created_at, event_id) 最大者为最新状态，计数 = 最新为 like 的去重 actor 数。
// 无赞 target 不在返回 map 中（调用方按 0 处理）。
func (s *Store) LikeCountsByTargets(targets []string) (map[string]int64, error) {
	out := map[string]int64{}
	if len(targets) == 0 {
		return out, nil
	}
	q := `SELECT target_id, COUNT(DISTINCT id) FROM events e
		WHERE e.type='like.v1' AND e.target_id IN (` + placeholders(len(targets)) + `)
		  AND json_extract(e.body_json,'$.action')='like'
		  AND NOT EXISTS (SELECT 1 FROM events e2
			WHERE e2.type='like.v1' AND e2.id=e.id AND e2.target_id=e.target_id
			  AND (e2.created_at > e.created_at
			       OR (e2.created_at = e.created_at AND e2.event_id > e.event_id)))
		GROUP BY target_id`
	args := make([]any, 0, len(targets))
	for _, t := range targets {
		args = append(args, t)
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var target string
		var cnt int64
		if err := rows.Scan(&target, &cnt); err != nil {
			return nil, err
		}
		out[target] = cnt
	}
	return out, rows.Err()
}

// ActiveItemExists 条目 target 校验（#79 §3.3）：items 存在且 state='active'。
func (s *Store) ActiveItemExists(itemID string) (bool, error) {
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM items WHERE item_id=? AND state='active' LIMIT 1`, itemID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// ReportedCommentRow 是 POST /v1/admin/review/reported 的一行：被举报评论 + 聚合举报数。
type ReportedCommentRow struct {
	EventID     string   // 被举报评论 event_id
	Actor       string   // 评论作者
	TargetID    string   // 评论所属目标
	PayloadCID  string   // 评论正文块（审核者接 fetch 取正文）
	ReplyTo     string
	CreatedAt   int64    // 评论创建时间
	ReportCount int64    // 去重举报人数（#79 §4.2）
	Reporters   []string // 去重举报人 id
}

// ListReportedComments 被举报评论列表（#79 §5.3）：
// 内联评论事件已同步到本地（JOIN）且未墓碑；report_count 降序、次键 (created_at, event_id) 降序。
func (s *Store) ListReportedComments() ([]ReportedCommentRow, error) {
	rows, err := s.db.Query(`SELECT t.event_id, t.id, t.target_id, t.payload_cid, t.reply_to, t.created_at,
		COUNT(DISTINCT r.id) AS report_count, GROUP_CONCAT(DISTINCT r.id) AS reporters
		FROM events r
		JOIN events t ON t.event_id = r.target_id AND t.type='comment.v1'
		WHERE r.type='report.v1'
		  AND NOT EXISTS (SELECT 1 FROM comment_tombstone tb WHERE tb.event_id=t.event_id)
		GROUP BY t.event_id
		ORDER BY report_count DESC, t.created_at DESC, t.event_id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReportedCommentRow{}
	for rows.Next() {
		var (
			r        ReportedCommentRow
			targetID sql.NullString
			payload  sql.NullString
			replyTo  sql.NullString
			ids      sql.NullString
		)
		if err := rows.Scan(&r.EventID, &r.Actor, &targetID, &payload, &replyTo, &r.CreatedAt,
			&r.ReportCount, &ids); err != nil {
			return nil, err
		}
		r.TargetID, r.PayloadCID, r.ReplyTo = targetID.String, payload.String, replyTo.String
		if ids.Valid && ids.String != "" {
			r.Reporters = strings.Split(ids.String, ",") // id 是 hex，不含逗号
		} else {
			r.Reporters = []string{}
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
```

`placeholders(n)` 若 store 包已有同用途辅助则复用；否则在 like.go 里补一个私有实现（`strings.Repeat("?,", n)` 去尾）。

- [ ] **Step 1.6: 跑测试确认通过**

同 Step 1.3 命令，预期 3 个用例全 PASS；再跑 `go test ./internal/store/ -v` 确认存量无回归。

- [ ] **Step 1.7: Commit**

```bash
git add internal/store/like.go internal/store/like_test.go internal/store/schema.go
git commit -m "feat(store): like.v1/report.v1 聚合计数与举报列表查询 (#79)"
```

---

### Task 2: Go 写面——两类型进 registry + 目标校验 + 错误码

**Files:**
- Modify: `internal/httpapi/event.go`（registry L25-31 加两行；switch L64-83 加两分支；文件尾追加两个 handler + 两个 body 解析）
- Test: `internal/httpapi/event_test.go`（追加用例）

- [ ] **Step 2.1: 回读 event.go L1-85**

确认 `eventTypeRegistry` 字面量、`eventReq` 字段名、`handleEventPost` switch 形态与限速位置（Node 镜像 event.ts 头注已证实：`(:44-81)` 分流、`(:25-31)` registry）。

- [ ] **Step 2.2: 写失败测试（追加到 event_test.go，沿用该文件既有建服/登记身份/签事件脚手架）**

```go
func TestHandleEventLikeReport(t *testing.T) {
	// 脚手架：与 TestHandleCommentEvent 同款——起 Server、登记身份、注册事件签名辅助
	// ① like 评论：seed comment 事件 c1 → POST like.v1(body={target_id:"<c1>",action:"like"})
	//    断言 200 {event_id, received_at}（无 payload_cid 键）
	// ② 幂等：同 event_id 重发 → 200 同 received_at
	// ③ target 不存在 → 404 {"error":"target_not_found"}
	// ④ target 是墓碑评论（PutCommentTombstone 后）→ 410 {"error":"target_gone"}
	// ⑤ 条目 target：items 无此 id → 404 target_not_found；有 active 条目 → 200
	// ⑥ report：action/reason 非法、多未知键、缺键 → 400 event_param_invalid
	// ⑦ report 非法 reason 值 → 400 event_param_invalid
	// ⑧ 重复举报两条不同 event_id → 均 200（节点不拒）
	// ⑨ 未登记类型回归：type="like.v2" → 400 event_type_unknown
}
```

用例体按上面注释逐条写全（`http.StatusNotFound`/`410`/`400` 断言 + `parse(t, res)` 辅助），签名用与既有 comment 用例相同的 `sign(seed, canonical(...))` 辅助。

- [ ] **Step 2.3: 跑测试确认失败**

`go test ./internal/httpapi/ -run TestHandleEventLikeReport -v` → 编译通过但断言失败（registry 无 like.v1 → 400 event_type_unknown）。

- [ ] **Step 2.4: 实现**

registry 加两行（保持字母序与现表一致）：

```go
	"like.v1",
	"report.v1",
```

switch（handleEventPost）加两分支：

```go
	case "like.v1":
		s.handleLikeEvent(w, actor, req, createdAt)
	case "report.v1":
		s.handleReportEvent(w, actor, req, createdAt)
```

文件尾追加（完全照 `commentBody`/`parseCommentBody`/`handleCommentEvent` 体例）：

```go
// likeBody 是 like.v1 的两字段（#79 §3.1）。target 两形态：16hex=评论事件 id；路径式=条目 item_id。
type likeBody struct {
	TargetID string
	Action   string // "like" | "unlike"
}

// parseLikeBody 严格键集 {target_id,action}；返回 map 保留客户端原始键集（验签语义同 parseCommentBody）。
func parseLikeBody(raw json.RawMessage) (map[string]any, likeBody, bool) {
	var lb likeBody
	if len(raw) == 0 {
		return nil, lb, false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, lb, false
	}
	for k := range m {
		switch k {
		case "target_id", "action":
		default:
			return nil, lb, false
		}
	}
	target, ok := m["target_id"].(string)
	if !ok || !validTargetID(target) {
		return nil, lb, false
	}
	action, ok := m["action"].(string)
	if !ok || (action != "like" && action != "unlike") {
		return nil, lb, false
	}
	return m, likeBody{TargetID: target, Action: action}, true
}

// parseCommentTargetID 评论 target 形态判别：16 hex = 评论 event_id；否则为条目路径式。
func isCommentTarget(target string) bool { return isHexN(target, 16) }

// checkLikeReportTarget 校验 target 本地存在性（#79 §3.3）；失败已写好响应并返回 false。
// 反熵接收侧不重放此校验（投影落行不经这里，与 comment.v1 同口径）。
func (s *Server) checkLikeReportTarget(w http.ResponseWriter, target string) bool {
	if isCommentTarget(target) {
		ev, ok, err := s.st.GetEventByID(target)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return false
		}
		if !ok || ev.Type != "comment.v1" {
			s.writeError(w, http.StatusNotFound, "target_not_found")
			return false
		}
		gone, err := s.st.IsRevokedEvent(target)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return false
		}
		if gone {
			s.writeError(w, http.StatusGone, "target_gone")
			return false
		}
		return true
	}
	active, err := s.st.ActiveItemExists(target)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return false
	}
	if !active {
		s.writeError(w, http.StatusNotFound, "target_not_found")
		return false
	}
	return true
}

// handleLikeEvent 校验 body → 验签 → target 校验 → 落行（target_id 投影列必填，无 payload）→ 200。
func (s *Server) handleLikeEvent(w http.ResponseWriter, actor string, req eventReq, createdAt int64) {
	rawBody, lb, ok := parseLikeBody(req.Body)
	if !ok {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	if !s.verifyEventSig(w, actor, req, rawBody) {
		return
	}
	if !s.checkLikeReportTarget(w, lb.TargetID) {
		return
	}
	bodyJSON, err := protocol.Canonicalize(map[string]any{
		"target_id": lb.TargetID, "action": lb.Action, "sig": req.Sig,
	})
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UnixMilli()
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: actor, Type: req.Type, BodyJSON: string(bodyJSON),
		CreatedAt: createdAt, ReceivedAt: now, TargetID: lb.TargetID,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if ev, ok, err := s.st.GetEventByID(req.EventID); err == nil && ok {
		now = ev.ReceivedAt
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"event_id": req.EventID, "received_at": now})
}

// reportReason 严格四值（#79 §3.2）。
func validReportReason(r string) bool {
	switch r {
	case "spam", "abuse", "illegal", "other":
		return true
	}
	return false
}

func parseReportBody(raw json.RawMessage) (map[string]any, likeBody, bool) {
	var rb likeBody
	if len(raw) == 0 {
		return nil, rb, false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, rb, false
	}
	for k := range m {
		switch k {
		case "target_id", "reason":
		default:
			return nil, rb, false
		}
	}
	target, ok := m["target_id"].(string)
	// report 只收评论 target（#79 §3.2）：非 16 hex 即拒。
	if !ok || !isHexN(target, 16) {
		return nil, rb, false
	}
	reason, ok := m["reason"].(string)
	if !ok || !validReportReason(reason) {
		return nil, rb, false
	}
	return m, likeBody{TargetID: target, Action: reason}, true
}

// handleReportEvent 同 handleLikeEvent，body 键集 {target_id,reason}；重复举报不拒（计数去重在聚合层）。
func (s *Server) handleReportEvent(w http.ResponseWriter, actor string, req eventReq, createdAt int64) {
	rawBody, rb, ok := parseReportBody(req.Body)
	if !ok {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	if !s.verifyEventSig(w, actor, req, rawBody) {
		return
	}
	if !s.checkLikeReportTarget(w, rb.TargetID) {
		return
	}
	bodyJSON, err := protocol.Canonicalize(map[string]any{
		"target_id": rb.TargetID, "reason": rb.Action, "sig": req.Sig,
	})
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UnixMilli()
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: actor, Type: req.Type, BodyJSON: string(bodyJSON),
		CreatedAt: createdAt, ReceivedAt: now, TargetID: rb.TargetID,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if ev, ok, err := s.st.GetEventByID(req.EventID); err == nil && ok {
		now = ev.ReceivedAt
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"event_id": req.EventID, "received_at": now})
}
```

注意：`parseReportBody` 返回的 `likeBody.Action` 在此语义是 reason——**落库 body_json 必须写 `reason` 键**（上面代码已按此写）；`json_extract` 只用于 like。若嫌复用别扭，可另定义 `reportBody{TargetID, Reason}` 结构，二选一，**以可读性优先**。

- [ ] **Step 2.5: 跑测试确认通过**

`go test ./internal/httpapi/ -run TestHandleEventLikeReport -v` → PASS；`go test ./internal/httpapi/` 全绿。

- [ ] **Step 2.6: Commit**

```bash
git add internal/httpapi/event.go internal/httpapi/event_test.go
git commit -m "feat(httpapi): like.v1/report.v1 进 registry，target 校验与 target_not_found/target_gone (#79)"
```

---

### Task 3: Go 读面内联——commentDTO 与 catalogItem 加 like_count

**Files:**
- Modify: `internal/httpapi/comment.go:21-68`（commentDTO 加字段、handleCommentList 按页聚合）
- Modify: `internal/httpapi/public.go:41-109`（catalogItem 加字段、handleCatalog 按页聚合）
- Test: `internal/httpapi/comment_test.go` / `public_test.go`（追加；无则新建，沿用 httpapi 测试脚手架）

- [ ] **Step 3.1: 写失败测试**

comment 用例：seed 评论 c1/c2 + A 对 c1 点赞 + B 对 c1 点赞 + A 对 c2 点赞后取消 → `GET /v1/comment?target_id=t` 断言 `comments[0].like_count`（c1=2、c2=0，注意响应内顺序）。catalog 用例：seed active 条目 it1 + 点赞 → `GET /v1/catalog` 断言 `items[0].like_count`；`?since=<当前版本>` 短路响应**无 items**（回归不动）。

- [ ] **Step 3.2: 跑失败**（`like_count` 字段不存在 → 断言失败）

- [ ] **Step 3.3: 实现 comment.go**

DTO 加一行：

```go
type commentDTO struct {
	EventID    string  `json:"event_id"`
	Actor      string  `json:"actor"`
	TargetID   string  `json:"target_id"`
	PayloadCID string  `json:"payload_cid"`
	ReplyTo    *string `json:"reply_to"`
	CreatedAt  int64   `json:"created_at"`
	LikeCount  int64   `json:"like_count"`
}
```

`handleCommentList` 在组装 `resp.Comments` 前按页聚合（JSON 键序按结构体声明，`like_count` 落在对象尾部——Go 与 Node 双侧一致即可）：

```go
	// #79 §5.1：按页聚合 like_count（禁 N+1）。
	targets := make([]string, 0, len(rows))
	for _, c := range rows {
		targets = append(targets, c.EventID)
	}
	likeMap, err := s.st.LikeCountsByTargets(targets)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
```

组装处：`dto.LikeCount = likeMap[c.EventID]`（map 缺键即 0）。

- [ ] **Step 3.4: 实现 public.go**

```go
type catalogItem struct {
	ItemID      string `json:"item_id"`
	Source      string `json:"source"`
	Type        string `json:"type"`
	Title       string `json:"title"`
	ContentHash string `json:"content_hash"`
	SourceRev   string `json:"source_rev"`
	LikeCount   int64  `json:"like_count"`
}
```

`handleCatalog` 组装循环前，对**已通过 active/public 过滤的条目 id 集合**做一次聚合（先收集再写值，避免对被过滤行白算）：

```go
	var visibleIDs []string
	for _, it := range items {
		if it.State != "active" || it.DistClass != "public" {
			continue
		}
		visibleIDs = append(visibleIDs, it.ItemID)
	}
	likeMap, err := s.st.LikeCountsByTargets(visibleIDs)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
```

组装处 `LikeCount: likeMap[it.ItemID]`。

- [ ] **Step 3.5: 跑测试** → PASS + `go test ./internal/httpapi/` 全绿。
- [ ] **Step 3.6: Commit** `git add internal/httpapi/comment.go internal/httpapi/public.go internal/httpapi/*_test.go` → `feat(httpapi): comment/catalog 读面内联 like_count (#79 §5.1-5.2)`

---

### Task 4: Go 审核面——POST /v1/admin/review/reported

**Files:**
- Modify: `internal/httpapi/comment.go`（文件尾追加 handler）
- Modify: `internal/httpapi/server.go:146-150`（reviewKey 块内加注册）
- Test: `internal/httpapi/comment_test.go` 追加

- [ ] **Step 4.1: 写失败测试**

```go
func TestHandleReviewReported(t *testing.T) {
	// ① 未配置 ReviewKey 的 Server：请求 → 404（路由不存在，Go ServeMux 默认 404 文本）
	// ② 配置 ReviewKey 的 Server：无头/错头 → 404 {"error":"not_found"}
	// ③ 正确头 + 空体 {} → 200 {"reports":[...]}：字段集与顺序断言（report_count 降序）
	// ④ 墓碑评论不在列；reporters 去重
}
```

- [ ] **Step 4.2: 跑失败**
- [ ] **Step 4.3: 实现**

comment.go 文尾追加：

```go
// handleReviewReported 被举报评论列表（#79 §5.3）：X-Base-Review-Key 保护（requireReviewKey 同款）。
// 只聚合呈现，处置仍走既有 fetch→reject；无参数（空体 {}），列表短小不分页。
func (s *Server) handleReviewReported(w http.ResponseWriter, r *http.Request) {
	rows, err := s.st.ListReportedComments()
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	type reportedDTO struct {
		EventID     string   `json:"event_id"`
		Actor       string   `json:"actor"`
		TargetID    string   `json:"target_id"`
		PayloadCID  string   `json:"payload_cid"`
		ReplyTo     *string  `json:"reply_to"`
		CreatedAt   int64    `json:"created_at"`
		ReportCount int64    `json:"report_count"`
		Reporters   []string `json:"reporters"`
	}
	resp := struct {
		Reports []reportedDTO `json:"reports"`
	}{Reports: []reportedDTO{}}
	for _, c := range rows {
		dto := reportedDTO{
			EventID: c.EventID, Actor: c.Actor, TargetID: c.TargetID,
			PayloadCID: c.PayloadCID, CreatedAt: c.CreatedAt,
			ReportCount: c.ReportCount, Reporters: c.Reporters,
		}
		if c.ReplyTo != "" {
			reply := c.ReplyTo
			dto.ReplyTo = &reply
		}
		resp.Reports = append(resp.Reports, dto)
	}
	s.writeJSON(w, http.StatusOK, resp)
}
```

server.go L147-150 块内加一行：

```go
		mux.Handle("POST /v1/admin/review/reported", s.requireReviewKey(s.handleReviewReported))
```

- [ ] **Step 4.4: 跑测试** → PASS + 全包回归。
- [ ] **Step 4.5: Commit** → `feat(httpapi): 审核面 POST /v1/admin/review/reported (#79 §5.3)`

---

### Task 5: Go peersync——parseEventProjection 扩两分支

**Files:**
- Modify: `internal/peersync/eventsync.go:212-260`（switch 加一分支）
- Test: `internal/peersync/eventsync_test.go` 追加

- [ ] **Step 5.1: 写失败测试**：body_json=`{"action":"like","target_id":"c1","sig":"0"}`（like.v1）与 `{"reason":"spam","target_id":"c1","sig":"0"}`（report.v1）→ 投影 `{TargetID:"c1", PayloadCID:"", ReplyTo:""}`；坏 JSON → 零投影。
- [ ] **Step 5.2: 跑失败**
- [ ] **Step 5.3: 实现**——在 `case "comment.v1"` 分支后加：

```go
	case "like.v1", "report.v1":
		// #79 §6：无 payload 事件，投影只填 target_id（EventBlobIndex 白名单不动，同 progress.v1 先例）。
		var m struct {
			TargetID string `json:"target_id"`
		}
		if err := json.Unmarshal([]byte(bodyJSON), &m); err != nil || m.TargetID == "" {
			return commentProjection{}
		}
		return commentProjection{TargetID: m.TargetID}
```

（switch 返回类型/零值字面量以该函数现形为准；如现形用命名变量而非直接返回，照抄其风格。）

- [ ] **Step 5.4: 跑测试** → `go test ./internal/peersync/` 全绿。
- [ ] **Step 5.5: Commit** → `feat(peersync): like.v1/report.v1 投影重建只填 target_id (#79 §6)`

---

### Task 6: Go 跨节点传播测试（AC 11-1）

**Files:**
- Test: `internal/peersync/eventsync_test.go` 追加（或既有双节点测试文件）

- [ ] **Step 6.1: 写测试**——沿用 peersync 包既有双节点互拉脚手架（先回读该文件现有一轮「A 写 → B 拉」用例）：A 节点写 comment + like.v1 → B 从 A 增量拉一轮 → B 的 `LikeCountsByTargets(["c1"])` = 1；B 无该评论事件时聚合不崩（只拉 like 不拉 comment 的对造用例）。
- [ ] **Step 6.2: 跑测试** → PASS。
- [ ] **Step 6.3: Commit** → `test(peersync): like 事件跨节点传播与悬空 target 聚合不崩 (#79 AC11)`

---

### Task 7: G1 门禁——Go 全量

- [ ] **Step 7.1**: `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go vet ./... && go build ./... && go test ./internal/... ` → 全绿（如 `go vet` 对存量报错，只修本计划引入的）。
- [ ] **Step 7.2**: 桌面冒烟（可选但推荐）：`go run ./cmd/based`（本地空库）起服 → `GET /healthz` 200、`GET /v1/comment` 200 `{"comments":[],"next_cursor":null}`（新字段在空页不出现，属正常——`like_count` 随行内联）。

---

### Task 8: Node 镜像写面——EVENT_TYPES + 两 handler + store 辅助

**Files:**
- Modify: `apps/node/src/routes/event.ts`（EVENT_TYPES L29-36 加两行；switch L277-290 加两分支）
- Create: `apps/node/src/routes/likeEvent.ts`（两个 handler，体例照 `routes/progress.ts`）
- Modify: `apps/node/src/store/events.ts`（追加 `activeItemExists`）
- Test: `apps/node/src/routes/event.test.ts` 追加（沿用既有注册/签名脚手架）

- [ ] **Step 8.1: 写失败测试**——对齐 Go Task 2 九条（①-⑨），断言同错误码同状态码；签名用测试文件既有的 `signEvent` 类辅助。
- [ ] **Step 8.2: 跑失败**（EVENT_TYPES 无 like.v1 → 400 event_type_unknown）。
- [ ] **Step 8.3: 实现 store/events.ts 追加**：

```ts
/** ActiveItemExists（store/like.go 同口径）：items 存在且 state='active'。 */
export function activeItemExists(db: Db, itemId: string): boolean {
  const rows = db.select(`SELECT 1 FROM items WHERE item_id=? AND state='active' LIMIT 1`, [itemId]);
  return rows.length > 0;
}
```

- [ ] **Step 8.4: 新建 routes/likeEvent.ts**（对齐 event.ts 的 parseCommentBody/handleCommentEvent 逐行风格）：

```ts
// 对齐 internal/httpapi/event.go 的 handleLikeEvent / handleReportEvent（Task 2 产物）。
import type { ServerResponse } from "@base/core-ts";
import { canonicalize, type Json } from "@base/protocol-ts";
import type { Db } from "../db";
import { getEventById, isRevokedEvent, putEvent } from "../store/events";
import { activeItemExists } from "../store/events";
import type { EventDeps, EventEnvelope } from "./event";
import { isHexN, toStr } from "./derived";
import { jsonResponse } from "./json";
import { writeAuthErr } from "./authmw";

export interface LikeBody {
  targetId: string;
  action: string; // like.v1: "like"|"unlike"；report.v1 借此字段带 reason
}

const LIKE_KEYS: ReadonlySet<string> = new Set(["target_id", "action"]);
const REPORT_KEYS: ReadonlySet<string> = new Set(["target_id", "reason"]);

function parseBody(raw: string, keys: ReadonlySet<string>): { map: Record<string, unknown>; b: LikeBody } | null {
  if (raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  for (const k of Object.keys(m)) if (!keys.has(k)) return null;
  const target = m.target_id;
  if (typeof target !== "string" || target === "" || target.length > 256) return null;
  for (let i = 0; i < target.length; i++) if (target.charCodeAt(i) > 0x7f) return null;
  return { map: m, b: { targetId: target, action: "" } };
}

/** target 校验（Go checkLikeReportTarget 同口径）：评论须本地存在且未墓碑；条目须 active。 */
export function checkTarget(db: Db, target: string): ServerResponse | null {
  if (isHexN(target, 16)) {
    const ev = getEventById(db, target);
    if (ev === null || ev.type !== "comment.v1") return jsonResponse(404, { error: "target_not_found" });
    if (isRevokedEvent(db, target)) return jsonResponse(410, { error: "target_gone" });
    return null;
  }
  try {
    if (!activeItemExists(db, target)) return jsonResponse(404, { error: "target_not_found" });
  } catch (err) {
    return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
  }
  return null;
}

/** 落行 + 回读 received_at + 200（Go handleLikeEvent 尾段同款）。 */
function putLikeReportEvent(
  db: Db, actor: string, env: EventEnvelope, createdAt: number,
  bodyJSON: string, targetId: string,
): ServerResponse {
  let now = Date.now();
  try {
    putEvent(db, {
      eventId: env.eventId, id: actor, type: env.type, bodyJson: bodyJSON,
      createdAt, receivedAt: now, targetId, payloadCid: "", replyTo: "",
    });
    const ev = getEventById(db, env.eventId);
    if (ev !== null) now = ev.receivedAt;
  } catch (err) {
    return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
  }
  return jsonResponse(200, { event_id: env.eventId, received_at: now });
}

export function likeEventHandler(deps: EventDeps, actor: string, env: EventEnvelope, createdAt: number): ServerResponse {
  const parsed = parseBody(env.bodyRaw, LIKE_KEYS);
  if (parsed === null) return jsonResponse(400, { error: "event_param_invalid" });
  const action = parsed.map.action;
  if (action !== "like" && action !== "unlike") return jsonResponse(400, { error: "event_param_invalid" });
  const verr = verifySigShim(deps, actor, env, parsed.map, createdAt);
  if (verr !== null) return verr;
  const t = checkTarget(deps.db, parsed.b.targetId);
  if (t !== null) return t;
  let bodyJSON: string;
  try {
    bodyJSON = canonicalize({ target_id: parsed.b.targetId, action, sig: env.sig });
  } catch (err) {
    return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
  }
  return putLikeReportEvent(deps.db, actor, env, createdAt, bodyJSON, parsed.b.targetId);
}

const REPORT_REASONS: ReadonlySet<string> = new Set(["spam", "abuse", "illegal", "other"]);

export function reportEventHandler(deps: EventDeps, actor: string, env: EventEnvelope, createdAt: number): ServerResponse {
  const parsed = parseBody(env.bodyRaw, REPORT_KEYS);
  if (parsed === null) return jsonResponse(400, { error: "event_param_invalid" });
  const reason = parsed.map.reason;
  if (typeof reason !== "string" || !REPORT_REASONS.has(reason)) return jsonResponse(400, { error: "event_param_invalid" });
  if (!isHexN(parsed.b.targetId, 16)) return jsonResponse(400, { error: "event_param_invalid" }); // report 只收评论 target
  const verr = verifySigShim(deps, actor, env, parsed.map, createdAt);
  if (verr !== null) return verr;
  const t = checkTarget(deps.db, parsed.b.targetId);
  if (t !== null) return t;
  let bodyJSON: string;
  try {
    bodyJSON = canonicalize({ target_id: parsed.b.targetId, reason, sig: env.sig });
  } catch (err) {
    return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
  }
  return putLikeReportEvent(deps.db, actor, env, createdAt, bodyJSON, parsed.b.targetId);
}

function verifySigShim(
  deps: EventDeps, actor: string, env: EventEnvelope,
  rawBody: Record<string, unknown>, createdAt: number,
): ServerResponse | null {
  // verifyEventSig 从 ./event 导入即可（本文件不重实现）：import { verifyEventSig } from "./event";
  return verifyEventSig(deps, actor, env, rawBody, createdAt);
}
```

（实现时把 `verifySigShim` 收敛成顶部直接 `import { verifyEventSig } from "./event"` 调用，不留 shim 中间层——上面写 shim 只是为了示例完整。）

- [ ] **Step 8.5: event.ts 接线**——EVENT_TYPES 加 `"like.v1"`、`"report.v1"`；switch 加：

```ts
      case "like.v1":
        return likeEventHandler(deps, actor, env, createdAt);
      case "report.v1":
        return reportEventHandler(deps, actor, env, createdAt);
```

顶部 `import { likeEventHandler, reportEventHandler } from "./likeEvent";`。
- [ ] **Step 8.6: 跑测试** → `npx vitest run src/routes/event.test.ts` PASS。
- [ ] **Step 8.7: Commit** → `feat(node): like.v1/report.v1 写面镜像 Go（严格键集+target 校验+错误码）(#79)`

---

### Task 9: Node 读面 + 审核面

**Files:**
- Modify: `apps/node/src/routes/comment.ts`（列表后按页聚合 like_count）
- Modify: `apps/node/src/routes/catalog.ts`（条目对象加 like_count）
- Modify: `apps/node/src/routes/review.ts`（追加 reportedHandler）
- Modify: `apps/node/src/serve.ts:161-174`（reviewKey 块内注册）
- Create: `apps/node/src/store/like.ts`（`likeCountsByTargets` / `listReportedComments`——SQL 与 Go like.go 逐字同）
- Test: `apps/node/src/routes/comment.test.ts` / `review.test.ts` 追加

- [ ] **Step 9.1: 写失败测试**——对齐 Go Task 3/4 断言（含 `?since` 短路无 like_count 键、reported 无密钥 404）。
- [ ] **Step 9.2: 跑失败**
- [ ] **Step 9.3: 实现 store/like.ts**——把 Task 1 like.go 的三条 SQL 原样移植（`GROUP_CONCAT` / `json_extract` / 索引在 Task 8 由 schema 迁移补——**Node schema.ts 的索引追加与 Go 同一行 DDL**，加到 L379-381 三行后：`` `CREATE INDEX IF NOT EXISTS idx_events_type_target ON events(type, target_id)` ``）。注意 Node 侧 LIKE_KEYS 的 action 落库形态与 Go 一致（`canonical({target_id,action,sig})`）。
- [ ] **Step 9.4: comment.ts 接线**：

```ts
      const targets = rows.map((c) => c.eventId);
      const likeMap = likeCountsByTargets(db, targets); // map<string, number>，缺键 0
      const comments = rows.map((c) => ({
        event_id: c.eventId,
        actor: c.actor,
        target_id: c.targetId,
        payload_cid: c.payloadCid,
        reply_to: c.replyTo === "" ? null : c.replyTo,
        created_at: c.createdAt,
        like_count: likeMap.get(c.eventId) ?? 0,
      }));
```

- [ ] **Step 9.5: catalog.ts 接线**——`items` 的 visible 过滤后聚合，映射加 `like_count: likeMap.get(it.item_id) ?? 0`（对齐 Go `catalogItem` 字段序，`like_count` 在 `source_rev` 后）。
- [ ] **Step 9.6: review.ts 追加 reportedHandler**（响应结构与 Go handleReviewReported 逐字段同，`reports` 空数组兜底）：

```ts
export function reviewReportedHandler(deps: ReviewDeps): ServerHandler {
  return async () => {
    try {
      const rows = listReportedComments(deps.db);
      return jsonResponse(200, {
        reports: rows.map((c) => ({
          event_id: c.eventId, actor: c.actor, target_id: c.targetId,
          payload_cid: c.payloadCid, reply_to: c.replyTo === "" ? null : c.replyTo,
          created_at: c.createdAt, report_count: c.reportCount, reporters: c.reporters,
        })),
      });
    } catch (err) {
      return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
```

serve.ts L164-174 块内加：

```ts
    adapters.http.handle(
      "POST /v1/admin/review/reported",
      requireReviewKey(reviewKey, reviewReportedHandler(reviewDeps)),
    );
```

- [ ] **Step 9.7: 跑测试** → 全绿。
- [ ] **Step 9.8: Commit** → `feat(node): comment/catalog 内联 like_count + 审核面 reported 镜像 (#79 §5)`

---

### Task 10: Node peersync 投影 + G2 门禁

**Files:**
- Modify: `apps/node/src/peersync/eventsync.ts:395-427`（switch 加一分支）
- Test: `apps/node/src/peersync/eventsync.test.ts` 追加

- [ ] **Step 10.1: 写失败测试**（对齐 Go Task 5）。
- [ ] **Step 10.2: 实现**——`case "comment.v1"` 后加：

```ts
    case "like.v1":
    case "report.v1": {
      // #79 §6：无 payload 事件，投影只填 target_id。
      const g = goObj(bodyJSON);
      if (!g.ok) return ZERO_PROJECTION;
      const target = goStr(g.obj, "target_id");
      if (!target.ok || target.value === "") return ZERO_PROJECTION;
      return { targetId: target.value, payloadCid: "", replyTo: "" };
    }
```

- [ ] **Step 10.3: G2 门禁**——`npm run tsc -- --noEmit && npx vitest run`（在 `apps/node` 下）全绿。
- [ ] **Step 10.4: Commit** → `feat(node): peersync like/report 投影 + 全量测试绿 (#79 §6)`

---

### Task 11: G3 双端对拍

**Files:**
- Create: `apps/node/src/golden-like.test.ts`（Node 侧）
- Create: `internal/httpapi/golden_like_test.go`（Go 侧）
- Create: `docs/superpowers/plans/fixtures/like-golden.json`（共享 golden，两侧断言同一份）

- [ ] **Step 11.1: 构造 golden**——固定数据集：pack v1 + 条目 `article/a1`（active）+ 评论事件两条（c1 有 2 赞 1 举报人 2 人、c2 有 1 like 1 unlike 取消 + 1 举报）+ 对应 like/report 事件行。`like-golden.json` 写死三段期望输出：`GET /v1/comment` 全页 JSON、`GET /v1/catalog` 全页 JSON、`POST /v1/admin/review/reported` JSON（键序按 Go 结构体声明序；Node 侧构造响应对象时**按同一键序**写 map——Node 的 `jsonResponse` 序列化保留插入序）。
- [ ] **Step 11.2: Go 测试**——用 Task 2-4 的脚手架 seed 全数据集后请求三面，`JSONEq(golden.x, body)` 断言（`bytes` 级或 `reflect.DeepEqual` 反序列化后比较，二选一，与既有断言辅助一致）。
- [ ] **Step 11.3: Node 测试**——vitest 内存库 seed 同数据集（事件行直接 `putEvent`）请求三面，断言与 golden `toEqual`（JSON.parse 后比较）。
- [ ] **Step 11.4: 跑两侧** → 全绿。若键序不一致导致字节差异：**改 Node 对象字面量键序对齐 Go**，不改 Go。
- [ ] **Step 11.5: Commit** → `test: like/report 三读面双端 golden 对拍 (#79 G3)`

---

### Task 12: core-ts——like_out 台账 + items 补列 + 发送核心

**Files:**
- Modify: `packages/core-ts/src/repo.ts`（SCHEMA_SQL 加 `like_out` 表；`ensureItemsColumns` 补 `like_count` 列；LocalRepo 接口与实现加 4 个方法）
- Create: `packages/core-ts/src/like.ts`
- Modify: `packages/core-ts/src/comment.ts`（listComments 映射加 likeCount；index.ts/出口 re-export）
- Test: `packages/core-ts/test/like.test.ts`（沿用 fakes 脚手架）

- [ ] **Step 12.1: repo.ts 三处**：

SCHEMA_SQL（L175 comment_out 旁）加：

```ts
  `CREATE TABLE IF NOT EXISTS like_out(
     target_id TEXT PRIMARY KEY, action TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
```

`ensureItemsColumns`（L229-241）补：

```ts
  if (!cols.has('like_count')) {
    await db.execute(`ALTER TABLE items ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0`);
  }
```

LocalRepo 接口 + 实现加（与 comment_out 方法同区）：

```ts
// 接口声明
getLikeOut(targetId: string): Promise<'like' | 'unlike' | null>;
upsertLikeOut(targetId: string, action: 'like' | 'unlike'): Promise<void>;
getItemLikeCount(itemId: string): Promise<number>;
adjustItemLikeCount(itemId: string, delta: number): Promise<void>;

// 实现（SQL 手法同 enqueueComment）
async getLikeOut(targetId: string) {
  const rows = await this.db.select(`SELECT action FROM like_out WHERE target_id=?`, [targetId]);
  if (rows.length === 0) return null;
  return String(rows[0].action) === 'like' ? 'like' : 'unlike';
}
async upsertLikeOut(targetId: string, action: 'like' | 'unlike') {
  await this.db.execute(
    `INSERT INTO like_out(target_id,action,updated_at) VALUES(?,?,?)
     ON CONFLICT(target_id) DO UPDATE SET action=excluded.action, updated_at=excluded.updated_at`,
    [targetId, action, Date.now()]);
}
async getItemLikeCount(itemId: string) {
  const rows = await this.db.select(`SELECT like_count FROM items WHERE item_id=?`, [itemId]);
  return rows.length === 0 ? 0 : Number(rows[0].like_count ?? 0);
}
async adjustItemLikeCount(itemId: string, delta: number) {
  await this.db.execute(`UPDATE items SET like_count = MAX(0, like_count + ?) WHERE item_id=?`, [delta, itemId]);
}
```

- [ ] **Step 12.2: 新建 core-ts/src/like.ts**（发送管线照 comment.ts `sendComment` 逐行体例，复用 `ensureRegistered`/`signRequestHeaders`/`localStep` 思路；**不落队列**）：

```ts
/**
 * 点赞/举报（#79 §7）：无正文的轻事件，仅在线发送；离线由调用方 toast，不入 comment_out。
 * 复用 comment 管线：ensureRegistered → 构造（event_id/created_at/内容签名冻结）→ 签名头 POST /v1/event。
 */
import { bytesToHex, canonicalize, randomBytes, sign, utf8, type Json } from '@base/protocol-ts';

import type { Adapters } from './platform/adapter';
import type { LocalRepo } from './repo';
import { ensureRegistered, type Identity, signRequestHeaders } from './identity';
import { decodeUtf8 } from './sync';

export type LikeAction = 'like' | 'unlike';
export type ReportReason = 'spam' | 'abuse' | 'illegal' | 'other';

export interface LikeOptions {
  adapters: Adapters;
  repo: LocalRepo;
  nodeBaseUrl: string;
}

export class LikeError extends Error {
  constructor(readonly code: 'target_gone' | 'target_missing' | 'rate_limited' | 'network' | 'server' | 'client', message: string) {
    super(message);
    this.name = 'LikeError';
  }
}

function buildWire(
  ident: Identity, type: 'like.v1' | 'report.v1',
  body: Record<string, Json>,
): { eventId: string; wire: string } {
  const eventId = bytesToHex(randomBytes(16));
  const payload: Json = { event_id: eventId, type, created_at: Date.now(), body };
  const sig = sign(ident.seedHex, utf8(canonicalize(payload)));
  return { eventId, wire: JSON.stringify({ ...(payload as Record<string, Json>), sig }) };
}

async function sendLikeReport(
  o: LikeOptions, type: 'like.v1' | 'report.v1', body: Record<string, Json>,
): Promise<{ eventId: string }> {
  if (o.nodeBaseUrl === '') throw new LikeError('client', '未配置节点地址');
  const ident = await ensureRegistered(o);
  const { eventId, wire } = buildWire(ident, type, body);
  const bytes = utf8(wire);
  const headers = signRequestHeaders(ident, { method: 'POST', path: '/v1/event', body: bytes });
  let res;
  try {
    res = await o.adapters.http.post(`${o.nodeBaseUrl}/v1/event`, bytes, {
      'Content-Type': 'application/json', ...headers,
    });
  } catch {
    throw new LikeError('network', '无法连接节点，请稍后重试');
  }
  if (res.status === 200) {
    const out = JSON.parse(decodeUtf8(res.body)) as { event_id?: string };
    return { eventId: String(out.event_id ?? eventId) };
  }
  throw mapLikeFailure(res.status, decodeUtf8(res.body));
}

function mapLikeFailure(status: number, raw: string): LikeError {
  let code = '';
  try {
    code = ((JSON.parse(raw) as { error?: string }).error) ?? '';
  } catch { code = ''; }
  switch (code) {
    case 'target_not_found': return new LikeError('target_missing', '目标不存在或已下架');
    case 'target_gone': return new LikeError('target_gone', '该内容已被处理');
    case 'event_rate_limited': return new LikeError('rate_limited', '操作过于频繁，请稍后再试');
    default: return new LikeError('server', `提交失败（HTTP ${status}）`);
  }
}

/** 点赞/取消（评论 target=16hex 或条目 item_id；在线成功后由调用方写 like_out + 乐观计数）。 */
export function sendLike(o: LikeOptions, targetId: string, action: LikeAction) {
  return sendLikeReport(o, 'like.v1', { target_id: targetId, action });
}

/** 举报评论（target 仅 16hex；重复举报服务端不拒，计数去重）。 */
export function sendReport(o: LikeOptions, targetId: string, reason: ReportReason) {
  return sendLikeReport(o, 'report.v1', { target_id: targetId, reason });
}

/** 我的点赞台账：高亮态唯一来源（服务端不提供 liked_by_me）。 */
export async function myLike(o: LikeOptions, targetId: string): Promise<boolean> {
  return (await o.repo.getLikeOut(targetId)) === 'like';
}
```

注意：`ensureRegistered` / `signRequestHeaders` / `decodeUtf8` 从 `./comment` / `./identity` / `./sync` 的**实际导出名**回读后对齐（ensureRegistered 是 comment.ts 导出 ✓；`localStep` 是私有不复用，错误就地包装）。

- [ ] **Step 12.3: comment.ts listComments 映射加 likeCount**：

```ts
    likeCount: Number(c.like_count ?? 0),
```

`CommentItem` 接口加 `likeCount: number;`。出口：`packages/core-ts/src/index.ts`（或入口文件）加 `export * from './like';`（回读现出口结构后照抄同款）。

- [ ] **Step 12.4: 写测试**——fakes http 断言请求体：`sendLike` 构造的 wire `type='like.v1'`、body 严格两键、sig 可被节点侧 verify 通过（用 protocol-ts 的 verify 回验）；`myLike`/`upsertLikeOut` 往返；`adjustItemLikeCount` 边界（0 再 -1 不越负）。
- [ ] **Step 12.5: 跑** `npx vitest run`（packages/core-ts）→ G4 全绿。
- [ ] **Step 12.6: Commit** → `feat(core-ts): like.v1/report.v1 发送核心 + like_out 台账 + items.like_count 补列 (#79 §7.1)`

---

### Task 13: mobile 评论页——点赞按钮 + 举报弹层

**Files:**
- Modify: `apps/mobile/src/pages/comment/comment.vue`（行内点赞按钮、举报菜单/弹层、提交逻辑）
- Modify: `apps/mobile/src/core/likes.ts`（Create；仅作 re-export 过渡，体例照 `core/comment.ts` L1-2：`export * from '@base/core-ts/like';`）

- [ ] **Step 13.1: 回读 comment.vue 模板区**（L1-120）确认评论行结构与既有操作按钮区（回复入口所在 view），点赞按钮放同一行。
- [ ] **Step 13.2: 模板**——每条评论行（`v-for` 树节点渲染处）加：

```html
<view class="row-acts">
  <text class="like-btn" :class="{ liked: likedSet.has(row.eventId) }" @click="toggleLike(row)">
    ♥ {{ row.likeCount > 0 ? row.likeCount : '' }}
  </text>
  <text class="report-btn" @click="openReport(row.eventId)">举报</text>
</view>
```

- [ ] **Step 13.3: 脚本**——

```ts
import { sendLike, sendReport, type ReportReason } from '@base/core-ts/like';

const likedSet = ref<Set<string>>(new Set()); // 本会话高亮态（进页时由 like_out 初始化）
const likeBusy = ref<Set<string>>(new Set()); // 防抖：发送中禁点
const showReport = ref(false);
const reportTarget = ref('');
const reportReason = ref<ReportReason>('spam');
const REPORT_LABEL: Record<ReportReason, string> = {
  spam: '垃圾广告', abuse: '辱骂攻击', illegal: '违法违规', other: '其他',
};

async function initLikes() {
  const ids = list.value.map((r) => r.eventId);
  const s = new Set<string>();
  for (const id of ids) if (await opts.value!.repo.getLikeOut(id) === 'like') s.add(id);
  likedSet.value = s;
}

async function toggleLike(row: Row) {
  if (!opts.value || likeBusy.value.has(row.eventId)) return;
  const wasLiked = likedSet.value.has(row.eventId);
  const action = wasLiked ? 'unlike' : 'like';
  likeBusy.value.add(row.eventId);
  try {
    await sendLike(opts.value, row.eventId, action);
    await opts.value.repo.upsertLikeOut(row.eventId, action);
    // 本地计数 ±1（下次拉列表以服务端为准）
    row.likeCount = Math.max(0, row.likeCount + (action === 'like' ? 1 : -1));
    const s = new Set(likedSet.value);
    if (action === 'like') s.add(row.eventId); else s.delete(row.eventId);
    likedSet.value = s;
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : '操作失败', icon: 'none' });
  } finally {
    likeBusy.value.delete(row.eventId);
  }
}

function openReport(eventId: string) {
  reportTarget.value = eventId;
  reportReason.value = 'spam';
  showReport.value = true;
}

async function submitReport() {
  if (!opts.value || !reportTarget.value) return;
  try {
    await sendReport(opts.value, reportTarget.value, reportReason.value);
    showReport.value = false;
    uni.showToast({ title: '已提交，感谢反馈', icon: 'none' });
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : '提交失败', icon: 'none' });
  }
}
```

举报弹层模板（四原因单选 + 提交/取消，样式沿用页面既有 modal 风格；`Row` 类型若由页面本地定义需补 `likeCount: number` 字段——`listComments` 已回带）。

- [ ] **Step 13.4: 接线**——`refresh()` 成功后调 `initLikes()`；`list.value` 的行对象展开处带 `likeCount: it.likeCount`。
- [ ] **Step 13.5: 手工验证（H5 dev）**：点赞高亮/取消、计数联动、举报弹层四选一、断网点击 toast。
- [ ] **Step 13.6: Commit** → `feat(mobile): 评论页点赞与举报 (#79 §7.2)`

---

### Task 14: mobile 阅读页——条目点赞 + 条目举报入口

**Files:**
- Modify: `apps/mobile/src/pages/article/article.vue`（页脚点赞条 + 举报菜单入口）
- Modify: `apps/mobile/src/pages/lesson/detail.vue`（同款；若课时页结构同源则抽同一 composable `apps/mobile/src/composables/useItemLike.ts`）
- Modify: `apps/mobile/src/core/sync.ts` 或 catalog 落库处（`like_count` 随 catalog 刷新写回 items——回读 `packages/core-ts/src/repo.ts` 的 `commitPack`/catalog 应用函数，落库 INSERT/UPDATE 补 `like_count` 列）

- [ ] **Step 14.1: catalog 落库补列**——grep `INSERT INTO items` / `REPLACE INTO items`（packages/core-ts）定位 upsert 语句，补 `like_count` 写入（catalog 响应带 `like_count` 时用之，缺省 0）：

```ts
// upsert 语句列清单尾加 like_count，值取 it.like_count ?? 0
```

- [ ] **Step 14.2: useItemLike composable**（article 与 lesson 共用）：

```ts
import { ref, computed } from 'vue';
import { sendLike } from '@base/core-ts/like';

export function useItemLike(opts: Ref<LikeOptions | null>, itemId: Ref<string>) {
  const likeCount = ref(0);
  const liked = ref(false);
  const busy = ref(false);

  async function loadLocal() { // 进页读本地（离线可见，catalog 同步校正）
    if (!opts.value) return;
    likeCount.value = await opts.value.repo.getItemLikeCount(itemId.value);
    liked.value = (await opts.value.repo.getLikeOut(itemId.value)) === 'like';
  }
  async function refreshFromCatalog(count: number) { // 在线拉 catalog 回来后校正
    likeCount.value = count;
  }
  async function toggle() {
    if (!opts.value || busy.value) return;
    const action = liked.value ? 'unlike' : 'like';
    busy.value = true;
    try {
      await sendLike(opts.value, itemId.value, action);
      await opts.value.repo.upsertLikeOut(itemId.value, action);
      await opts.value.repo.adjustItemLikeCount(itemId.value, action === 'like' ? 1 : -1);
      likeCount.value = Math.max(0, likeCount.value + (action === 'like' ? 1 : -1));
      liked.value = action === 'like';
    } catch (e) {
      uni.showToast({ title: e instanceof Error ? e.message : '点赞需联网', icon: 'none' });
    } finally {
      busy.value = false;
    }
  }
  return { likeCount, liked, busy, loadLocal, refreshFromCatalog, toggle };
}
```

- [ ] **Step 14.3: 页面接线**——页脚加点赞条（`♥ {{ likeCount }}`，点击 `toggle`）+「举报此条目」入口 → 弹四原因弹层（与 Task 13 同款；**确认后不直接发 report**，跳治理预填，见 Task 15）：

```ts
import { setPendingProposalPrefill } from '@base/core-ts/govern'; // Task 15 产物

async function reportItem(reason: ReportReason) {
  setPendingProposalPrefill({
    itemId: itemId.value, action: 'remove',
    reason: `用户举报（${REPORT_LABEL[reason]}）`,
  });
  uni.switchTab({ url: '/pages/governance/governance' }); // tab 页路由以 pages.json 实际为准
}
```

- [ ] **Step 14.4: 手工验证**：点赞乐观 ±1、杀 H5 标签页重进计数保持、断网 toast、举报跳治理页。
- [ ] **Step 14.5: Commit** → `feat(mobile): 阅读页条目点赞与举报快捷提案入口 (#79 §7.3-7.4)`

---

### Task 15: mobile 治理页预填 + G5 门禁

**Files:**
- Modify: `packages/core-ts/src/govern.ts`（模块级预填状态，照 comment.ts `setPendingTarget` 手法 L354-365）
- Modify: `apps/mobile/src/pages/governance/governance.vue`（`showForm` 打开时消费预填）
- Test: `packages/core-ts/test/govern-prefill.test.ts`（小用例）

- [ ] **Step 15.1: govern.ts 追加**（governance 是 tab 页不带 query，走模块级状态——与 comment.ts `pendingTarget` 同理由）：

```ts
export interface ProposalPrefill {
  itemId: string;
  action: 'remove';
  reason: string;
}
let pendingPrefill: ProposalPrefill | null = null;
export function setPendingProposalPrefill(p: ProposalPrefill): void { pendingPrefill = p; }
export function takePendingProposalPrefill(): ProposalPrefill | null {
  const p = pendingPrefill;
  pendingPrefill = null;
  return p;
}
```

- [ ] **Step 15.2: governance.vue 接线**——「发起提案」按钮 handler 从 `showForm = true` 改为：

```ts
function openForm() {
  const p = takePendingProposalPrefill();
  if (p) {
    form.itemId = p.itemId;
    form.action = p.action;
    form.reason = p.reason;
  }
  showForm.value = true;
}
```

（模板 L28 的 `@click="showForm = true"` 改 `@click="openForm"`。）

- [ ] **Step 15.3: 测试 + G5 门禁**——core-ts vitest 预填往返用例；`apps/mobile` 下 `npx tsc --noEmit && npx vitest run && npm run build:h5` 全绿；**模板 `.value` 硬检查**（grep `<template>` 区不含 `.value`，既有红线脚本照跑）。
- [ ] **Step 15.4: Commit** → `feat(mobile): 条目举报预填治理 remove 提案 (#79 §7.4)`

---

### Task 16: 回填实况 + G6

**Files:**
- Modify: `docs/superpowers/specs/2026-10-06-base-like-report-design.md`（册子 §0.1 尾或 §12 下加「实施实况」段：各 Task 提交哈希、门禁结果、偏离点）
- Modify: `docs/README.md`（§3 表第 79 行状态改「已实施」；§5 末段状态句更新）

- [ ] **Step 16.1**: 回填三处（实况哈希与结果）。
- [ ] **Step 16.2**: `git add docs/... && git commit -m "docs: #79 点赞/举报实施实况回填"`；`git push origin master`。

---

### Task 17: 节点双单元部署 + G7 探活（先升节点、后发客户端）

**前置确认**：Go/Node 两侧改动均已 push；线上 `GET /v1/release` 现值记下（mobile 还没发，客户端不报错——`like_count` 是纯增字段，老客户端兼容）。

- [ ] **Step 17.1: Go 二进制交叉编译**（本地）：

```bash
$env:GOOS='linux'; $env:GOARCH='amd64'; $env:CGO_ENABLED='0'
$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH; go build -o based-pre-like ./cmd/based
$env:GOOS=''; $env:GOARCH=''; $env:CGO_ENABLED=''
```

- [ ] **Step 17.2: Node bundle**（`apps/node` 下既有构建命令，与 #78 T7 同款 esbuild 打包）→ `based-node.mjs`，记 sha256。
- [ ] **Step 17.3: 上传与备份**——scp 两个产物到服务器临时目录；`/opt/base/based` 与 `/opt/base-node/based-node.mjs` 各备份 `.bak-pre-like`；原子替换（mv）。
- [ ] **Step 17.4: 重启**——base 单元（Go，源节点）与 base-cache 单元（Node）`systemctl restart`；`systemctl is-active` 双 active。
- [ ] **Step 17.5: G7 探活清单**（两单元各跑一遍，Go 源节点走客户端域名、Node 走 127.0.0.1:8083）：
  1. `GET /healthz` 200；
  2. 用已登记身份发一条 like.v1 签名事件（脚本见 #78 冒烟手法）→ 200 `{"event_id":...,"received_at":...}`（无 `payload_cid` 键）；
  3. `GET /v1/comment?target_id=<该评论>` → 行内带 `like_count:1`；
  4. `GET /v1/catalog` → 条目对象带 `like_count`；
  5. `POST /v1/admin/review/reported` 无密钥 → 404 `not_found`；带密钥 → 200 `{"reports":[...]}`；
  6. 反向对照：`GET /v1/blob/zzzz`（乱 id）→ 404；`type=like.v2` → 400 `event_type_unknown`；
  7. `journalctl -u <单元> --since -5m`：无 panic、无 `event_type_unknown` 新增。
- [ ] **Step 17.6: 反熵验证**——like.v1 事件从 base（Go）传播到 base-cache（Node）：在 Node 单元 `sqlite3` 直查或 `GET /v1/comment` 看计数一致（AC 11-2 线上版）。
- [ ] **Step 17.7**: 记录实况（哈希、探活结果）到 #79 实施实况段，一并 commit + push。

---

### Task 18: mobile 发布四步 + G8

**Files:**
- Modify: `apps/mobile/src/manifest.json`（版本号：**开工时核实现值 +1**，`versionName` 与 `versionCode` 同步；不要照抄本计划的字面值）
- 服务器：`/opt/appdl/base-<ver>.apk`、落地页指向、`based release` 签发

- [ ] **Step 18.1**: `manifest.json` 版本 +1（核实现值）；`GET /v1/release` 记录旧值。
- [ ] **Step 18.2**: 云打包（`cli pack`，与 #59 同款参数）→ 产出 apk。
- [ ] **Step 18.3**: 上传 apk 到 `/opt/appdl/`，改落地页下载指向（同 #59 手法）。
- [ ] **Step 18.4**: `based release` 签发新版本（min 版本策略沿用上一次签发参数）。
- [ ] **Step 18.5: G8 线上核对**：`GET /v1/release` → 新版本；`HEAD http://<服务器>/dl/base-<ver>.apk` → 200 且字节数与本地一致；`verifyRelease` → true。
- [ ] **Step 18.6: 真机 3 条（#79 §9.2，待人工）**：
  1. 评论页：点赞高亮/取消/计数联动；举报弹层四原因可选、提交成功反馈；
  2. 阅读页：条目点赞乐观 ±1、杀进程重进计数保持（本地落库）、断网点赞 toast；
  3. 条目举报：入口跳治理页、remove 提案预填正确、投票流可走通。
- [ ] **Step 18.7**: 真机结果回填 #79 实况段 + README，最终 commit + push。

---

## 自审记录（写完计划后过一遍）

1. **覆盖度**：#79 §3（T2/T8）、§4（T1/T9）、§5（T3/T4/T9）、§6（T5/T10）、§7.1（T12）、§7.2（T13）、§7.3-7.4（T14/T15）、§7.5 离线 toast（T13/T14 catch 分支）、§9.1 AC1-12（T2/T8 测试九条 + T1 LWW/去重 + T6 跨节点 + T11 golden）、§9.2 真机（T18）、G1-G8 全落位。✓
2. **占位符**：无 TBD；「回读脚手架/以现形为准」均为显式步骤而非含糊指令。✓
3. **类型一致性**：`likeBody.Action` 在 report 语义为 reason（已注记，允许拆成 reportBody）；`like_count` 键序以 Go 结构体声明为准、Node 字面量对齐；`LikeCount`/`likeCount` 双端映射齐。✓
