# 评论改版（对象跳转与类型过滤）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 评论卡片挂「所属条目」并可点击跳转课程/课时/文章；评论页升级为「类型 + 具体条目」两级过滤；Go/Node 双节点新增评论目标聚合接口与 `kind` 过滤下推。

**Architecture:** 规格见 `docs/superpowers/specs/2026-10-16-base-comment-revamp-design.md`（#80）。数据侧一条 GROUP BY 聚合（JOIN items，排除墓碑与已删条目），列表接口加 `kind` EXISTS 过滤；双实现（Go `internal/`、TS `apps/node/`）逐行对齐；客户端纯消费（core-ts 三个小函数 + comment.vue 改版），发评论与既有行为零改动。

**Tech Stack:** Go 1.22+（`http.ServeMux` 方法路由）、Node/TS（apps/node 自研 handler）、uni-app（Options+setup 混合）、vitest / go test。

**约定（全程有效）：**
- PowerShell 环境不用 `&&`（用 `;`）；不支持 heredoc（多行提交信息用 here-string `@'...'@`）。
- 每个 Task 结束即 commit + push，只 add 本 Task 文件。
- 发版口径：**并版 0.21.6/45**（manifest 已是 0.21.6/45 未云打包，无需 bump）；节点二进制重部署在云打包后一并走部署流程。

---

### Task 1: Go store 层——`ListCommentTargets` 聚合 + `ListComments` kind 参数

**Files:**
- Modify: `internal/store/comment.go`（新增聚合方法；`ListComments` 加 kind 参数）
- Modify: `internal/store/comment_test.go`（新增两个测试；既有 `TestListCommentsProjectionCursorAndTombstone` 的 `ListComments` 调用点补首个实参）
- Test: `internal/store/comment_test.go`

- [ ] **Step 1: 写失败测试**

在 `internal/store/comment_test.go` 末尾追加（文件已有 `openTemp(t)` 助手与 `put` 事件写法，沿用）：

```go
// 插入一条 items 行（聚合 JOIN 用），列形状与 like_test.go 同口径。
func putItemForTest(t *testing.T, st *Store, id, typ, title, state string) {
	t.Helper()
	if _, err := st.db.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?)`, id, typ, typ, title, "r", "h", "articles", "public", state, "2026-01-01T00:00:00Z"); err != nil {
		t.Fatalf("putItem %s: %v", id, err)
	}
}

// #80 §2.1：评论目标聚合——计数 / last_at 倒序 / 墓碑排除 / 已删条目排除。
func TestListCommentTargets(t *testing.T) {
	st := openTemp(t)
	putItemForTest(t, st, "article/a", "article", "文章甲", "active")
	putItemForTest(t, st, "course/c1", "course", "课程乙", "active")
	putItemForTest(t, st, "article/gone", "article", "已删文章", "removed")
	put := func(eventID, target string, createdAt, receivedAt int64) {
		t.Helper()
		if err := st.PutEvent(Event{
			EventID: eventID, ID: "actor-" + eventID, Type: "comment.v1", BodyJSON: `{}`,
			CreatedAt: createdAt, ReceivedAt: receivedAt, TargetID: target, PayloadCID: "cid-" + eventID,
		}); err != nil {
			t.Fatalf("PutEvent %s: %v", eventID, err)
		}
	}
	put("c1", "article/a", 100, 10)
	put("c2", "article/a", 200, 11)
	put("c3", "course/c1", 300, 12)
	put("c4", "article/gone", 400, 13) // 已删条目上的评论：列表可见，但不进聚合

	rows, err := st.ListCommentTargets()
	if err != nil {
		t.Fatalf("ListCommentTargets: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("应只有 active 条目入聚合: %+v", rows)
	}
	if rows[0].TargetID != "course/c1" || rows[0].Count != 1 || rows[0].LastAt != 300 || rows[0].Kind != "course" || rows[0].Title != "课程乙" {
		t.Fatalf("首行应为最近评论的课程: %+v", rows[0])
	}
	if rows[1].TargetID != "article/a" || rows[1].Count != 2 || rows[1].LastAt != 200 {
		t.Fatalf("次行应为文章甲(2条): %+v", rows[1])
	}

	// 墓碑排除：撤掉 article/a 的 c1 后计数 2→1
	if err := st.PutCommentTombstone(CommentTombstone{EventID: "c1", PayloadCID: "cid-c1", Reason: "违规"}); err != nil {
		t.Fatalf("PutCommentTombstone: %v", err)
	}
	after, err := st.ListCommentTargets()
	if err != nil || after[1].TargetID != "article/a" || after[1].Count != 1 {
		t.Fatalf("墓碑未从聚合排除 err=%v rows=%+v", err, after)
	}
}

// #80 §2.2：kind 过滤下推——EXISTS items.type；removed 条目评论仍可见。
func TestListCommentsKindFilter(t *testing.T) {
	st := openTemp(t)
	putItemForTest(t, st, "article/a", "article", "文章甲", "active")
	putItemForTest(t, st, "course/c1", "course", "课程乙", "active")
	put := func(eventID, target string, createdAt, receivedAt int64) {
		t.Helper()
		if err := st.PutEvent(Event{
			EventID: eventID, ID: "actor-" + eventID, Type: "comment.v1", BodyJSON: `{}`,
			CreatedAt: createdAt, ReceivedAt: receivedAt, TargetID: target, PayloadCID: "cid-" + eventID,
		}); err != nil {
			t.Fatalf("PutEvent %s: %v", eventID, err)
		}
	}
	put("c1", "article/a", 100, 10)
	put("c2", "course/c1", 200, 11)
	put("c3", "article/none", 300, 12) // 无 items 行的 target

	arts, err := st.ListComments("article", "", 0, "", 10)
	if err != nil || len(arts) != 2 {
		t.Fatalf("kind=article 应 2 行（含无 items 行的 target）: err=%v rows=%+v", err, arts)
	}
	courses, err := st.ListComments("course", "", 0, "", 10)
	if err != nil || len(courses) != 1 || courses[0].EventID != "c2" {
		t.Fatalf("kind=course 应 1 行: err=%v rows=%+v", err, courses)
	}
	// kind + target_id 同传：target 过滤优先语义不变（AND 组合）
	both, err := st.ListComments("course", "course/c1", 0, "", 10)
	if err != nil || len(both) != 1 || both[0].EventID != "c2" {
		t.Fatalf("kind+target 同传: err=%v rows=%+v", err, both)
	}
	// kind 为空 = 现状行为不变（全量 3 行，含无 items 行 target）
	all, err := st.ListComments("", "", 0, "", 10)
	if err != nil || len(all) != 3 {
		t.Fatalf("kind 空不过滤: err=%v rows=%+v", err, all)
	}
}
```

同时把既有 `TestListCommentsProjectionCursorAndTombstone` 里 4 处 `st.ListComments("article/a", ...)` / `st.ListComments("", ...)` 改为补首参 `""`（如 `st.ListComments("", "article/a", 0, "", 10)`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/store/ -run 'TestListCommentTargets|TestListCommentsKindFilter|TestListCommentsProjection'`
Expected: 编译失败 `undefined: st.ListCommentTargets` / `not enough arguments in call to st.ListComments`

- [ ] **Step 3: 实现**

`internal/store/comment.go`：`ListComments` 签名加 `kind` 首参并在 WHERE 里加 EXISTS；文件顶部（`CommentRow` 之后）加聚合行类型与 `ListCommentTargets`：

```go
// ListComments 按 (created_at, event_id) 倒序分页读评论投影，联表排除墓碑。
// kind/targetID 为空表示不过滤；kind 走 EXISTS items.type（不看 state：已删条目的评论仍可读，改版册子 §2.2）；
// cursorTS/cursorID 为上一页末条，返回严格更旧的行。
func (s *Store) ListComments(kind, targetID string, cursorTS int64, cursorID string, limit int) ([]CommentRow, error) {
	if limit <= 0 {
		limit = 30
	}
	q := `SELECT e.event_id,e.id,e.target_id,e.payload_cid,e.reply_to,e.created_at
		FROM events e
		WHERE e.type='comment.v1'
		  AND NOT EXISTS (SELECT 1 FROM comment_tombstone t WHERE t.event_id=e.event_id)`
	args := []any{}
	if kind != "" {
		q += ` AND EXISTS (SELECT 1 FROM items i WHERE i.item_id=e.target_id AND i.type=?)`
		args = append(args, kind)
	}
	if targetID != "" {
		q += ` AND e.target_id=?`
		args = append(args, targetID)
	}
	// ……以下游标 / ORDER / Scan 原样不动
```

（游标、ORDER BY、Scan 段保持原文件不变。）

同文件追加：

```go
// CommentTargetRow 是 GET /v1/comment/targets 的聚合行（改版册子 §2.1）。
type CommentTargetRow struct {
	TargetID string
	Kind     string
	Title    string
	Count    int64
	LastAt   int64
}

// ListCommentTargets 按目标聚合全站评论：只含 items 里 state='active' 的条目
// （已删条目不进二级 chips，点了也跳不过去；其评论仍走 ListComments 可见）。
// 墓碑与 ListComments 同口径排除；按最近评论时间倒序，target_id 兜底稳定序。
func (s *Store) ListCommentTargets() ([]CommentTargetRow, error) {
	rows, err := s.db.Query(`SELECT e.target_id, i.type, i.title, COUNT(*) AS cnt, MAX(e.created_at) AS last_at
		FROM events e
		JOIN items i ON i.item_id = e.target_id AND i.state='active'
		WHERE e.type='comment.v1'
		  AND NOT EXISTS (SELECT 1 FROM comment_tombstone t WHERE t.event_id=e.event_id)
		GROUP BY e.target_id
		ORDER BY last_at DESC, e.target_id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CommentTargetRow{}
	for rows.Next() {
		var (
			r     CommentTargetRow
			title sql.NullString
		)
		if err := rows.Scan(&r.TargetID, &r.Kind, &title, &r.Count, &r.LastAt); err != nil {
			return nil, err
		}
		r.Title = title.String
		out = append(out, r)
	}
	return out, rows.Err()
}
```

- [ ] **Step 4: 跑 store 全量测试**

Run: `go test ./internal/store/`
Expected: 全部 PASS（含既有用例——`ListComments` 签名改动的调用点已在 Step 1 补齐）

- [ ] **Step 5: Commit**

```powershell
git add internal/store/comment.go internal/store/comment_test.go
git commit -m "feat(node-go): 评论目标聚合 ListCommentTargets 与 ListComments kind 过滤（store 层，#80）"
git push
```

---

### Task 2: Go httpapi——`GET /v1/comment/targets` 路由 + `kind` 透传

**Files:**
- Modify: `internal/httpapi/server.go:129` 附近（注册路由）
- Modify: `internal/httpapi/comment.go`（新 handler；`handleCommentList` 透传 kind）
- Modify: `internal/httpapi/comment_test.go`（新测试）
- Test: `internal/httpapi/comment_test.go`

- [ ] **Step 1: 写失败测试**

`internal/httpapi/comment_test.go` 末尾追加：

```go
// #80：目标聚合路由 + kind 过滤透传。
func TestCommentTargetsAndKind(t *testing.T) {
	n := newCommentNode(t, "")
	// items：两个 active、一个 removed
	for _, it := range []struct{ id, typ, state string }{
		{"article/a", "article", "active"},
		{"course/c1", "course", "active"},
		{"article/gone", "article", "removed"},
	} {
		if _, err := n.st.db.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
			VALUES(?,?,?,?,?,?,?,?,?,?)`, it.id, it.typ, it.typ, "标题-"+it.id, "r", "h", "articles", "public", it.state, "2026-01-01T00:00:00Z"); err != nil {
			t.Fatal(err)
		}
	}
	postComment(t, n, eventIDOf(1), "article/a", "甲", "")
	postComment(t, n, eventIDOf(2), "course/c1", "乙", "")
	postComment(t, n, eventIDOf(3), "article/gone", "已删", "")

	// 聚合：只有 active 条目，按 last_at 倒序
	code, out := doJSONMap(t, http.MethodGet, n.public+"/v1/comment/targets", "", nil)
	if code != http.StatusOK {
		t.Fatalf("GET /v1/comment/targets status=%d out=%v", code, out)
	}
	targets, _ := out["targets"].([]any)
	if len(targets) != 2 {
		t.Fatalf("应 2 个目标: %v", out)
	}
	first, _ := targets[0].(map[string]any)
	second, _ := targets[1].(map[string]any)
	if first["target_id"] != "course/c1" || first["kind"] != "course" || first["count"] != float64(1) {
		t.Fatalf("首行错误: %v", first)
	}
	if second["target_id"] != "article/a" || second["count"] != float64(1) || second["title"] != "标题-article/a" {
		t.Fatalf("次行错误: %v", second)
	}

	// kind 透传：列表只剩该类型
	code, out = doJSONMap(t, http.MethodGet, n.public+"/v1/comment?kind=course", "", nil)
	if code != http.StatusOK {
		t.Fatalf("kind=course status=%d", code)
	}
	rows, _ := out["comments"].([]any)
	if len(rows) != 1 {
		t.Fatalf("kind=course 应 1 行: %v", out)
	}

	// 匿名路由：无须签名头（postComment 内部已带签名头，这里不带也须 200）
	code, _ = doRaw(t, http.MethodGet, n.public+"/v1/comment/targets", "", nil)
	if code != http.StatusOK {
		t.Fatalf("匿名读应 200，got %d", code)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/httpapi/ -run TestCommentTargetsAndKind`
Expected: FAIL（404，路由未注册）

- [ ] **Step 3: 实现**

`internal/httpapi/server.go:129` 处、`mux.HandleFunc("GET /v1/comment", ...)` 下一行加：

```go
mux.HandleFunc("GET /v1/comment/targets", s.handleCommentTargets)
```

`internal/httpapi/comment.go`：`handleCommentList` 里 `s.st.ListComments(q.Get("target_id"), curTS, curID, limit)` 改为 `s.st.ListComments(q.Get("kind"), q.Get("target_id"), curTS, curID, limit)`；文件追加：

```go
type commentTargetDTO struct {
	TargetID string `json:"target_id"`
	Kind     string `json:"kind"`
	Title    string `json:"title"`
	Count    int64  `json:"count"`
	LastAt   int64  `json:"last_at"`
}

type commentTargetsResponse struct {
	Targets []commentTargetDTO `json:"targets"`
}

// handleCommentTargets 评论目标聚合（改版册子 §2.1）：二级条目 chips 数据源，一次到位。
func (s *Server) handleCommentTargets(w http.ResponseWriter, r *http.Request) {
	rows, err := s.st.ListCommentTargets()
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := commentTargetsResponse{Targets: []commentTargetDTO{}}
	for _, t := range rows {
		resp.Targets = append(resp.Targets, commentTargetDTO{
			TargetID: t.TargetID, Kind: t.Kind, Title: t.Title, Count: t.Count, LastAt: t.LastAt,
		})
	}
	s.writeJSON(w, http.StatusOK, resp)
}
```

- [ ] **Step 4: 跑 httpapi 全量测试**

Run: `go test ./internal/httpapi/`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```powershell
git add internal/httpapi/server.go internal/httpapi/comment.go internal/httpapi/comment_test.go
git commit -m "feat(node-go): GET /v1/comment/targets 路由与 kind 透传（#80）"
git push
```

---

### Task 3: Node 分发节点——同款聚合与 kind 过滤（逐行对齐 Go）

**Files:**
- Modify: `apps/node/src/routes/comment.ts`
- Modify: `apps/node/src/serve.ts:166` 附近（注册路由）
- Modify: `apps/node/src/routes/comment.test.ts`
- Test: `apps/node/src/routes/comment.test.ts`

- [ ] **Step 1: 写失败测试（字节级 golden）**

`apps/node/src/routes/comment.test.ts` 顶部 DDL 区追加 ITEMS_DDL，并在两个 beforeAll 里各执行一次 `db.execute(ITEMS_DDL)`：

```ts
const ITEMS_DDL = `CREATE TABLE items(
	item_id    TEXT PRIMARY KEY,
	source     TEXT NOT NULL,
	type       TEXT NOT NULL,
	title      TEXT NOT NULL DEFAULT '',
	source_rev TEXT NOT NULL DEFAULT '',
	content_hash TEXT NOT NULL,
	sqlite_table TEXT NOT NULL,
	dist_class TEXT NOT NULL DEFAULT 'public',
	state      TEXT NOT NULL DEFAULT 'active',
	updated_at TEXT NOT NULL
)`;

function insertItem(db: Db, id: string, typ: string, title: string, state: string): void {
	db.execute(
		`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
			VALUES(?,?,?,?,?,?,?,?,?,?)`,
		[id, typ, typ, title, "r", "h", "articles", "public", state, "2026-01-01T00:00:00Z"],
	);
}
```

文件末尾追加用例（新起独立库，沿用文件内既有 beforeAll/afterAll 模式）：

```ts
// ---------- #80：/v1/comment/targets 聚合 + kind 过滤（对齐 Go TestCommentTargetsAndKind） ----------
describe("GET /v1/comment/targets 与 kind 过滤", () => {
	let d: string;
	let ldb: Db;
	let ln: Listener;
	let lb: string;
	const T1 = "44444444444444444444444444444444";
	const T2 = "55555555555555555555555555555555";

	beforeAll(async () => {
		d = mkdtempSync(join(tmpdir(), "base-node-comment-targets-"));
		ldb = openDb(join(d, "base.db"));
		ldb.execute(EVENTS_DDL);
		ldb.execute(TOMBSTONE_DDL);
		ldb.execute(ITEMS_DDL);
		insertItem(ldb, "article/a", "article", "文章甲", "active");
		insertItem(ldb, "course/c1", "course", "课程乙", "active");
		insertItem(ldb, "article/gone", "article", "已删", "removed");
		const insert = (eventId: string, target: string, createdAt: number): void => {
			ldb.execute(
				`INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
					VALUES(?,?,?,?,?,?,?,?,?)`,
				[eventId, "actor", "comment.v1", "{}", createdAt, createdAt, target, "", null],
			);
		};
		insert(T1, "article/a", 100);
		insert(T2, "course/c1", 200);
		insert("6".repeat(32), "article/gone", 300);

		ln = await startServer(adapters(), ldb, { host: "127.0.0.1", port: 0, dataDir: d });
		lb = `http://${ln.addr()}`;
	});

	afterAll(async () => {
		await ln.close();
		ldb.close();
		rmSync(d, { recursive: true, force: true });
	});

	it("聚合：只含 active 条目，last_at 倒序，键序与 Go 一致", async () => {
		const res = await request(`${lb}/v1/comment/targets`);
		const body =
			`{"targets":[` +
			`{"target_id":"course/c1","kind":"course","title":"课程乙","count":1,"last_at":200},` +
			`{"target_id":"article/a","kind":"article","title":"文章甲","count":1,"last_at":100}` +
			`}]}\n`;
		expect(res.status).toBe(200);
		expect(res.body.toString("utf8")).toBe(body);
	});

	it("kind 过滤：列表只剩该类型", async () => {
		const res = await request(`${lb}/v1/comment?kind=course`);
		const parsed = JSON.parse(res.body.toString("utf8")) as { comments: Array<{ target_id: string }> };
		expect(res.status).toBe(200);
		expect(parsed.comments.map((c) => c.target_id)).toEqual(["course/c1"]);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/node; npx vitest run src/routes/comment.test.ts`
Expected: FAIL（404）

- [ ] **Step 3: 实现**

`apps/node/src/routes/comment.ts`：

1. `listComments` 加 `kind` 首参（与 Go 逐行对齐）：`if (kind !== "") { q += \` AND EXISTS (SELECT 1 FROM items i WHERE i.item_id=e.target_id AND i.type=?)\`; args.push(kind); }`（插在 targetId 分支之前）；`commentHandler` 里调用改 `listComments(db, req.query.kind ?? "", req.query.target_id ?? "", cur.ts, cur.id, limit)`。
2. 追加聚合函数与 handler：

```ts
/** CommentTargetRow（store/comment.go ListCommentTargets）：只含 active 条目，墓碑同口径排除。 */
interface CommentTargetRow {
  targetId: string;
  kind: string;
  title: string;
  count: number;
  lastAt: number;
}

function listCommentTargets(db: Db): CommentTargetRow[] {
  const rows = db.select(
    `SELECT e.target_id, i.type AS kind, i.title, COUNT(*) AS cnt, MAX(e.created_at) AS last_at
      FROM events e
      JOIN items i ON i.item_id = e.target_id AND i.state='active'
      WHERE e.type='comment.v1'
        AND NOT EXISTS (SELECT 1 FROM comment_tombstone t WHERE t.event_id=e.event_id)
      GROUP BY e.target_id
      ORDER BY last_at DESC, e.target_id DESC`,
    [],
  );
  return rows.map((r) => ({
    targetId: toStr(r.target_id),
    kind: toStr(r.kind),
    title: toStr(r.title),
    count: Number(r.cnt ?? 0),
    lastAt: Number(r.last_at ?? 0),
  }));
}

/** 匿名聚合读（改版册子 §2.1）；JSON 键序与 Go commentTargetDTO 一致。 */
export function commentTargetsHandler(db: Db): ServerHandler {
  return async () => {
    try {
      const targets = listCommentTargets(db).map((t) => ({
        target_id: t.targetId,
        kind: t.kind,
        title: t.title,
        count: t.count,
        last_at: t.lastAt,
      }));
      return jsonResponse(200, { targets });
    } catch (err) {
      return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
```

`apps/node/src/serve.ts:166` 处、`adapters.http.handle("GET /v1/comment", commentHandler(db));` 下一行加：

```ts
adapters.http.handle("GET /v1/comment/targets", commentTargetsHandler(db));
```

并在 serve.ts 顶部 import 里补 `commentTargetsHandler`。

- [ ] **Step 4: 跑 Node 评论路由测试**

Run: `cd apps/node; npx vitest run src/routes/comment.test.ts`
Expected: 全部 PASS（含既有字节级 golden——`listComments` 签名改动的唯一调用点已在 Step 3 更新）

- [ ] **Step 5: Commit**

```powershell
git add apps/node/src/routes/comment.ts apps/node/src/routes/comment.test.ts apps/node/src/serve.ts
git commit -m "feat(node): /v1/comment/targets 聚合与 kind 过滤，对齐 Go 实现（#80）"
git push
```

---

### Task 4: core-ts——`listCommentTargets` / `listComments` kind 参数 / `lessonParentCourseId`

**Files:**
- Modify: `packages/core-ts/src/comment.ts`
- Modify: `packages/core-ts/src/comment.test.ts`
- Test: `packages/core-ts/src/comment.test.ts`

- [ ] **Step 1: 写失败测试**

`packages/core-ts/src/comment.test.ts` 追加（import 行补 `listCommentTargets`, `lessonParentCourseId`）：

```ts
describe('listCommentTargets：评论目标聚合', () => {
  it('解析 targets 行；非 200 抛 server 错', async () => {
    const { http, o } = fixture();
    http.routes.set(`${BASE}/v1/comment/targets`, json({
      targets: [
        { target_id: 'course/c1', kind: 'course', title: '课程乙', count: 2, last_at: 300 },
        { target_id: 'article/a', kind: 'article', title: '', count: 1, last_at: 100 },
      ],
    }));
    const rows = await listCommentTargets(o);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ targetId: 'course/c1', kind: 'course', title: '课程乙', count: 2, lastAt: 300 });
    expect(rows[1]!.title).toBe('');

    http.routes.set(`${BASE}/v1/comment/targets`, { status: 500, body: utf8('{}') });
    await expect(listCommentTargets(o)).rejects.toMatchObject({ code: 'server' });
  });

  it('网络不可达抛 network 错', async () => {
    const { http, o } = fixture();
    http.get = async () => {
      throw new Error('断网');
    };
    await expect(listCommentTargets(o)).rejects.toMatchObject({ code: 'network' });
  });
});

describe('listComments kind 参数', () => {
  it('kind 拼进查询串', async () => {
    const { http, o } = fixture();
    let seen = '';
    const real = http.get.bind(http);
    http.get = async (url) => {
      seen = url;
      return real(url);
    };
    http.routes.set(`${BASE}/v1/comment?kind=course`, json({ comments: [], next_cursor: null }));
    await listComments(o, { kind: 'course' });
    expect(seen).toBe(`${BASE}/v1/comment?kind=course`);
  });
});

describe('lessonParentCourseId：课时 id 解析父课程', () => {
  it('4 段容器 id 解出 course/<cid>；扁平 id / 坏编码返回 null', () => {
    expect(lessonParentCourseId('course%2Fc1%2Flesson%2Fl1')).toBe('course/c1');
    expect(lessonParentCourseId('course/c1/lesson/l1')).toBe('course/c1');
    expect(lessonParentCourseId('article/a1')).toBeNull();
    expect(lessonParentCourseId('course/c1')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core-ts; npx vitest run src/comment.test.ts`
Expected: FAIL（`listCommentTargets` / `lessonParentCourseId` 未导出）

- [ ] **Step 3: 实现**

`packages/core-ts/src/comment.ts`：

1. 顶部 import 补 `import { decodeSafe } from './course-edit';`
2. `listComments` 的 opts 类型与拼串扩 kind（插在 targetId 之后）：

```ts
export async function listComments(
  o: CommentOptions,
  opts: { targetId?: string; kind?: string; cursor?: string | null } = {},
): Promise<CommentList> {
  // 手拼查询串：老 WebView 没有 URLSearchParams（与 core/sync.ts 同一原因）
  const q: string[] = [];
  if (opts.targetId) q.push(`target_id=${encodeURIComponent(opts.targetId)}`);
  if (opts.kind) q.push(`kind=${encodeURIComponent(opts.kind)}`);
  if (opts.cursor) q.push(`cursor=${encodeURIComponent(opts.cursor)}`);
  // ……其余原样
```

3. `CommentList` 接口之后追加：

```ts
/** 评论目标聚合行（改版册子 §2.1）：二级条目 chips 数据源，一次到位。 */
export interface CommentTargetRow {
  targetId: string;
  kind: string;
  title: string;
  count: number;
  lastAt: number;
}

/** 读评论目标聚合（只含未删条目）；失败抛 `CommentError`，调用方局部降级。 */
export async function listCommentTargets(o: CommentOptions): Promise<CommentTargetRow[]> {
  let res;
  try {
    res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/comment/targets`);
  } catch {
    throw new CommentError('network', '无法连接节点，请稍后重试');
  }
  if (res.status !== 200) throw new CommentError('server', `读取评论条目失败（HTTP ${res.status}）`);
  const page = JSON.parse(decodeUtf8(res.body)) as { targets?: Array<Record<string, unknown>> };
  return (page.targets ?? []).map((t) => ({
    targetId: String(t.target_id ?? ''),
    kind: String(t.kind ?? ''),
    title: String(t.title ?? ''),
    count: Number(t.count ?? 0),
    lastAt: Number(t.last_at ?? 0),
  }));
}

/** 课时 id → 父课程 id（改版册子 §3）：容器 id 形态 `course/<cid>/lesson/<lid>`（幂等解码后）；
 *  其余形态（扁平 id、坏编码）返回 null，由调用方按「该内容不可用」降级。 */
export function lessonParentCourseId(targetId: string): string | null {
  const segs = decodeSafe(targetId).split('/');
  if (segs.length === 4 && segs[0] === 'course' && segs[2] === 'lesson') {
    return `course/${segs[1]}`;
  }
  return null;
}
```

- [ ] **Step 4: 跑 core-ts 全量测试**

Run: `cd packages/core-ts; npx vitest run --reporter=dot`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```powershell
git add packages/core-ts/src/comment.ts packages/core-ts/src/comment.test.ts
git commit -m "feat(core-ts): listCommentTargets / kind 参数 / lessonParentCourseId（#80）"
git push
```

---

### Task 5: mobile 评论页——两级过滤、所属行、对象跳转

**Files:**
- Modify: `apps/mobile/src/pages/comment/comment.vue`（模板 8-17 行过滤区重写；卡片加所属行；script 加状态与函数；CSS 补类）

- [ ] **Step 1: 模板——过滤区（替换现有 `<scroll-view class="picker">…</scroll-view>` 一段，8-17 行）**

```html
    <!-- 两级过滤（#80 §4.1）：第一排类型，第二排「有评论的条目」+ 搜索 -->
    <scroll-view class="picker" scroll-x>
      <text class="chip" :class="kindFilter === '' && target === '' ? 'chip-on' : ''" @click="pickKind('')">全部</text>
      <text
        v-for="k in KIND_CHIPS"
        :key="k.key"
        class="chip"
        :class="kindFilter === k.key && target === '' ? 'chip-on' : ''"
        @click="pickKind(k.key)"
      >{{ k.label }}</text>
    </scroll-view>
    <input v-model="itemQuery" class="item-search" placeholder="搜索条目标题" />
    <scroll-view class="picker" scroll-x>
      <text
        v-for="t in visibleTargetChips"
        :key="t.targetId"
        class="chip"
        :class="target === t.targetId ? 'chip-on' : ''"
        @click="pick(t.targetId)"
      >{{ t.title || t.targetId }} · {{ t.count }}</text>
      <text v-if="!targetLoading && !targetError && visibleTargetChips.length === 0" class="hint">该类型下还没有评论</text>
    </scroll-view>
    <text v-if="targetError" class="error">条目列表加载失败</text>
    <text v-if="targetError" class="act" @click="loadTargets">重试</text>
```

- [ ] **Step 2: 模板——楼层与子回复各加「所属行」，正文可点跳转**

楼层 `<text class="cmt-text">{{ floor.item.text }}</text>` 改为：

```html
        <text class="cmt-text" @click="openTarget(floor.item.targetId)">{{ floor.item.text }}</text>
        <text class="cmt-own" @click="openTarget(floor.item.targetId)">→《{{ ownTitle(floor.item.targetId) }}》</text>
```

子回复 `<text class="cmt-text">{{ sub.item.text }}</text>` 同样改为：

```html
          <text class="cmt-text" @click="openTarget(sub.item.targetId)">{{ sub.item.text }}</text>
          <text class="cmt-own" @click="openTarget(sub.item.targetId)">→《{{ ownTitle(sub.item.targetId) }}》</text>
```

- [ ] **Step 3: script——导入与状态**

import 区补：`listCommentTargets, lessonParentCourseId`（来自 `../../core/comment`），`type CommentTargetRow`（同处）。状态区（`const target = ref('')` 附近）加：

```ts
/** 两级过滤（#80 §4.1）：类型 chips + 有评论条目搜索 chips */
const KIND_CHIPS = [
  { key: 'course', label: '课程' },
  { key: 'lesson', label: '课时' },
  { key: 'article', label: '文章' },
] as const;
const kindFilter = ref('');
const itemQuery = ref('');
const targetRows = ref<CommentTargetRow[]>([]);
const targetError = ref(false);
const targetLoading = ref(false);

const targetMap = computed<Record<string, CommentTargetRow>>(() => {
  const m: Record<string, CommentTargetRow> = {};
  for (const t of targetRows.value) m[t.targetId] = t;
  return m;
});
/** 类型 + 标题关键字过滤后的条目 chips（只列有评论的条目，聚合接口一次到位） */
const visibleTargetChips = computed(() => {
  const kw = itemQuery.value.trim();
  return targetRows.value
    .filter((t) => kindFilter.value === '' || t.kind === kindFilter.value)
    .filter((t) => kw === '' || (t.title || t.targetId).includes(kw));
});
```

- [ ] **Step 4: script——加载聚合、选类型、标题三级降级、跳转**

在 `refresh()` 之前加：

```ts
async function loadTargets() {
  if (!opts.value || unconfigured.value) return;
  targetLoading.value = true;
  targetError.value = false;
  try {
    targetRows.value = await listCommentTargets(opts.value);
  } catch {
    // 聚合失败不影响评论列表：第二排局部错误 + 重试（#80 §5）
    targetError.value = true;
  } finally {
    targetLoading.value = false;
  }
}

/** 选类型：清条目筛选，按 kind 拉列表；发评论仍须选具体条目（#80 定案 6）。 */
function pickKind(kind: string) {
  kindFilter.value = kind;
  target.value = '';
  nextCursor.value = null;
  void refresh();
}

/** 所属行标题三级降级：聚合 → 本地 catalog → target_id（#80 §4.2）。 */
function ownTitle(targetId: string): string {
  const agg = targetMap.value[targetId];
  if (agg && agg.title !== '') return agg.title;
  return targetTitle(targetId);
}

/** 点评论进关联内容（#80 §4.2）：本地 catalog 查不到一律 toast 不跳。 */
function openTarget(targetId: string): void {
  const item = items.value.find((i) => i.itemId === targetId);
  const kind = targetMap.value[targetId]?.kind || item?.type || '';
  if (!item || (kind !== 'course' && kind !== 'lesson' && kind !== 'article')) {
    uni.showToast({ title: '该内容不可用', icon: 'none' });
    return;
  }
  if (kind === 'course') {
    uni.navigateTo({ url: `/pages/course/detail?courseId=${encodeURIComponent(targetId)}` });
    return;
  }
  if (kind === 'lesson') {
    const cid = lessonParentCourseId(targetId);
    if (cid === null) {
      uni.showToast({ title: '该内容不可用', icon: 'none' });
      return;
    }
    uni.navigateTo({ url: `/pages/lesson/detail?lessonId=${encodeURIComponent(targetId)}&courseId=${encodeURIComponent(cid)}` });
    return;
  }
  uni.navigateTo({ url: `/pages/article/article?itemId=${encodeURIComponent(targetId)}` });
}
```

- [ ] **Step 5: script——refresh / loadMore 请求参数与 onShow**

`refresh()` 与 `loadMore()` 里的 `listComments(opts.value, { targetId: target.value ... })` 改为（两处同改，loadMore 多带 cursor）：

```ts
    const page = await listComments(opts.value, {
      targetId: target.value || undefined,
      kind: target.value === '' ? (kindFilter.value || undefined) : undefined,
    });
```

（loadMore 在此基础上保留 `cursor: nextCursor.value`。）

`onShow` 里 `await load(); if (anchor) target.value = anchor;` 之后补一行 `await loadTargets();`。

- [ ] **Step 6: CSS——补两类**

style 末尾追加：

```css
.item-search { height: 48px; margin-bottom: 8px; padding: 0 10px; background: #f5f5f5; border-radius: 6px; font-size: var(--fs-annotate); }
.cmt-own { display: block; margin-top: 4px; color: #2b6cb0; font-size: var(--fs-annotate); }
```

- [ ] **Step 7: 门禁三连**

Run: `cd apps/mobile; npx vue-tsc --noEmit; npx vitest run --reporter=dot; npm run build:h5`
Expected: 类型零错、37 测试全绿、构建完成

- [ ] **Step 8: Commit**

```powershell
git add apps/mobile/src/pages/comment/comment.vue
git commit -m "feat(mobile): 评论页两级过滤与对象跳转——类型 chips + 有评论条目搜索 + 所属行（#80）"
git push
```

---

### Task 6: 全量回归 + 状态回填

**Files:**
- Modify: `docs/README.md`（#80 行状态改「已实施」）

- [ ] **Step 1: 双实现全量测试**

Run: `go test ./...`（仓库根）
Expected: 全部 PASS

Run: `cd apps/node; npx vitest run --reporter=dot`
Expected: 全部 PASS

Run: `cd packages/core-ts; npx vitest run --reporter=dot; cd ../../apps/mobile; npx vue-tsc --noEmit`
Expected: 全部 PASS / 类型零错

- [ ] **Step 2: README #80 状态回填**

`docs/README.md` #80 行状态列改为：

```markdown
| 已实施（2026-10-16：实施计划 `plans/2026-10-16-base-comment-revamp-plan.md` Task 1–6 落地；节点二进制重部署与客户端发版随 0.21.6/45 一并走部署流程） |
```

- [ ] **Step 3: Commit + push**

```powershell
git add docs/README.md
git commit -m "docs: 评论改版 #80 状态回填已实施"
git push
```

- [ ] **Step 4: 部署交接（不自动化）**

节点二进制编译重部署 + 客户端云打包 0.21.6/45 后的部署签发（sha256→scp→落地页两处→`based release` 签发→公网三连验）按既有部署流程执行；`GET /v1/comment/targets` 上线后用 `curl.exe -s https://<node>/v1/comment/targets` 冒烟。

---

## 验收清单（对照规格 §7，真机）

1. 评论页默认「全部」：所有评论按时间倒序，每条可见「→《所属条目》」
2. 点课程评论 → 课程详情；课时评论 → 课时详情（父课程正确）；文章评论 → 文章页
3. 选「课时」类型 → 列表只剩课时评论；第二排 chips 只剩有评论的课时
4. 搜索框输入关键字 → 条目 chips 即时收敛
5. 目标不可用（已删/本地无）的评论 → 点击 toast「该内容不可用」
6. 未选条目不能发评论；详情页锚定进评论页行为不回归
7. 待发队列 / 点赞 / 举报 / 楼中楼不回归
