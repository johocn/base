package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// 旧库：先造一张**没有**后加列的 events 表，再让 Open 迁移它。
func createLegacyEventsDB(t *testing.T, dir string) {
	t.Helper()
	path := filepath.ToSlash(filepath.Join(dir, "base.db"))
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE events(
		event_id    TEXT PRIMARY KEY,
		id          TEXT NOT NULL,
		type        TEXT NOT NULL,
		body_json   TEXT NOT NULL,
		created_at  INTEGER NOT NULL,
		received_at INTEGER NOT NULL)`); err != nil {
		t.Fatalf("造旧表: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func assertEventColumns(t *testing.T, st *Store) {
	t.Helper()
	cols, err := tableColumns(st.db, "events")
	if err != nil {
		t.Fatalf("tableColumns: %v", err)
	}
	for _, name := range []string{"target_id", "payload_cid", "reply_to"} {
		if !cols[name] {
			t.Fatalf("events 缺列 %s: %v", name, cols)
		}
	}
}

// 验收 17：events 列迁移幂等——空库与旧库两种输入；重复 Open 不报错。
func TestEventsColumnMigrationIdempotent(t *testing.T) {
	// 空库：连续 Open 两次
	empty := t.TempDir()
	for i := 0; i < 2; i++ {
		st, err := Open(empty, WithStoreKey(testKeyHex))
		if err != nil {
			t.Fatalf("空库第 %d 次 Open: %v", i+1, err)
		}
		assertEventColumns(t, st)
		_ = st.Close()
	}

	// 旧库：迁移后再 Open 一次
	legacy := t.TempDir()
	createLegacyEventsDB(t, legacy)
	for i := 0; i < 2; i++ {
		st, err := Open(legacy, WithStoreKey(testKeyHex))
		if err != nil {
			t.Fatalf("旧库第 %d 次 Open: %v", i+1, err)
		}
		assertEventColumns(t, st)
		if err := st.PutEvent(Event{
			EventID: "c1", ID: "actor", Type: "comment.v1", BodyJSON: `{}`, CreatedAt: 1,
			ReceivedAt: 2, TargetID: "article/a", PayloadCID: "aa", ReplyTo: "bb",
		}); err != nil {
			t.Fatalf("迁移后写入: %v", err)
		}
		ev, ok, err := st.GetEventByID("c1")
		if err != nil || !ok || ev.TargetID != "article/a" || ev.PayloadCID != "aa" || ev.ReplyTo != "bb" {
			t.Fatalf("迁移后读回 err=%v ok=%v ev=%+v", err, ok, ev)
		}
		_ = st.Close()
	}
}

// 验收 6/7/11 的数据层：投影倒序 + 游标分页 + 墓碑过滤。
func TestListCommentsProjectionCursorAndTombstone(t *testing.T) {
	st := openTemp(t)
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
	put("c3", "article/b", 300, 12)
	// 非评论类型不进入投影
	if err := st.PutEvent(Event{EventID: "p1", ID: "actor", Type: "progress.v1", BodyJSON: `{}`, CreatedAt: 400, ReceivedAt: 13}); err != nil {
		t.Fatalf("PutEvent p1: %v", err)
	}

	byTarget, err := st.ListComments("", "article/a", 0, "", 10)
	if err != nil || len(byTarget) != 2 {
		t.Fatalf("按目标投影 err=%v rows=%+v", err, byTarget)
	}
	if byTarget[0].EventID != "c2" || byTarget[1].EventID != "c1" {
		t.Fatalf("应按 created_at 倒序: %+v", byTarget)
	}
	if byTarget[0].PayloadCID != "cid-c2" || byTarget[0].Actor != "actor-c2" {
		t.Fatalf("投影字段错误: %+v", byTarget[0])
	}

	all, err := st.ListComments("", "", 0, "", 10)
	if err != nil || len(all) != 3 {
		t.Fatalf("全站投影 err=%v rows=%+v", err, all)
	}

	// 游标：严格更旧
	page, err := st.ListComments("", "", 300, "c3", 10)
	if err != nil || len(page) != 2 || page[0].EventID != "c2" {
		t.Fatalf("游标翻页 err=%v rows=%+v", err, page)
	}

	// 墓碑过滤
	if err := st.PutCommentTombstone(CommentTombstone{EventID: "c2", PayloadCID: "cid-c2", Reason: "违规"}); err != nil {
		t.Fatalf("PutCommentTombstone: %v", err)
	}
	after, err := st.ListComments("", "article/a", 0, "", 10)
	if err != nil || len(after) != 1 || after[0].EventID != "c1" {
		t.Fatalf("墓碑未过滤 err=%v rows=%+v", err, after)
	}
	revoked, err := st.IsRevokedPayload("cid-c2")
	if err != nil || !revoked {
		t.Fatalf("IsRevokedPayload err=%v got=%v", err, revoked)
	}
	if ok, _ := st.IsRevokedPayload("cid-c1"); ok {
		t.Fatal("cid-c1 不应被判为已撤销")
	}
	if ok, err := st.IsRevokedEvent("c2"); err != nil || !ok {
		t.Fatalf("IsRevokedEvent err=%v got=%v", err, ok)
	}
	set, err := st.ListRevokedPayloads()
	if err != nil || len(set) != 1 {
		t.Fatalf("ListRevokedPayloads err=%v set=%v", err, set)
	}
	if _, ok := set["cid-c2"]; !ok {
		t.Fatalf("批量护栏集合缺 cid-c2: %v", set)
	}
}

// 验收 17：事件/墓碑游标的严格递增与复合顺序。
func TestEventAndTombstoneIncrementalCursors(t *testing.T) {
	st := openTemp(t)
	for _, e := range []Event{
		{EventID: "b", ID: "a", Type: "comment.v1", BodyJSON: `{}`, CreatedAt: 1, ReceivedAt: 5},
		{EventID: "a", ID: "a", Type: "comment.v1", BodyJSON: `{}`, CreatedAt: 1, ReceivedAt: 5},
		{EventID: "c", ID: "a", Type: "comment.v1", BodyJSON: `{}`, CreatedAt: 1, ReceivedAt: 6},
	} {
		if err := st.PutEvent(e); err != nil {
			t.Fatalf("PutEvent %s: %v", e.EventID, err)
		}
	}
	rows, err := st.ListEventsAfter(0, "", 10)
	if err != nil || len(rows) != 3 {
		t.Fatalf("全量增量 err=%v rows=%+v", err, rows)
	}
	want := []string{"a", "b", "c"} // 同 received_at 按 event_id 升序
	for i, id := range want {
		if rows[i].EventID != id {
			t.Fatalf("增量顺序 = %v, want %v", rows, want)
		}
	}
	// 严格大于游标：同 ts 下只取 event_id 更大的
	rows, err = st.ListEventsAfter(5, "a", 10)
	if err != nil || len(rows) != 2 || rows[0].EventID != "b" {
		t.Fatalf("复合游标 err=%v rows=%+v", err, rows)
	}

	if err := st.PutCommentTombstone(CommentTombstone{EventID: "t1", PayloadCID: "x", ReceivedAt: 7}); err != nil {
		t.Fatalf("PutCommentTombstone: %v", err)
	}
	if err := st.PutCommentTombstone(CommentTombstone{EventID: "t2", PayloadCID: "y", ReceivedAt: 7}); err != nil {
		t.Fatalf("PutCommentTombstone: %v", err)
	}
	ts, err := st.ListTombstonesAfter(0, "", 10)
	if err != nil || len(ts) != 2 || ts[0].EventID != "t1" {
		t.Fatalf("墓碑增量 err=%v ts=%+v", err, ts)
	}
	// received_at 保留首次值（重发不改游标）
	if err := st.PutCommentTombstone(CommentTombstone{EventID: "t1", PayloadCID: "x", ReceivedAt: 99}); err != nil {
		t.Fatalf("墓碑重写: %v", err)
	}
	ts, _ = st.ListTombstonesAfter(0, "", 10)
	if ts[0].ReceivedAt != 7 {
		t.Fatalf("墓碑 received_at 不应被覆盖: %+v", ts[0])
	}
}

func TestPeerCursorStrictlyIncreases(t *testing.T) {
	st := openTemp(t)
	if ts, id, err := st.GetPeerCursor("peer-1", "event"); err != nil || ts != 0 || id != "" {
		t.Fatalf("初始游标 err=%v ts=%d id=%q", err, ts, id)
	}
	if err := st.PutPeerCursor("peer-1", "event", 100, "id2"); err != nil {
		t.Fatalf("PutPeerCursor: %v", err)
	}
	if ts, id, _ := st.GetPeerCursor("peer-1", "event"); ts != 100 || id != "id2" {
		t.Fatalf("游标 = (%d,%q), want (100,id2)", ts, id)
	}
	// 同 ts 但 id 更大：复合游标确实前进，不抬 ts
	if err := st.PutPeerCursor("peer-1", "event", 100, "id5"); err != nil {
		t.Fatalf("PutPeerCursor: %v", err)
	}
	if ts, id, _ := st.GetPeerCursor("peer-1", "event"); ts != 100 || id != "id5" {
		t.Fatalf("同 ts 前进 = (%d,%q), want (100,id5)", ts, id)
	}
	// 回拨：ts 抬高
	if err := st.PutPeerCursor("peer-1", "event", 50, "id9"); err != nil {
		t.Fatalf("PutPeerCursor: %v", err)
	}
	if ts, id, _ := st.GetPeerCursor("peer-1", "event"); ts != 101 || id != "id9" {
		t.Fatalf("回拨护栏 = (%d,%q), want (101,id9)", ts, id)
	}
	// 重复写同一游标：仍严格递增
	if err := st.PutPeerCursor("peer-1", "event", 101, "id9"); err != nil {
		t.Fatalf("PutPeerCursor: %v", err)
	}
	if ts, _, _ := st.GetPeerCursor("peer-1", "event"); ts != 102 {
		t.Fatalf("重复写应抬到 102, got %d", ts)
	}
	// kind 维度独立
	if ts, _, _ := st.GetPeerCursor("peer-1", "tombstone"); ts != 0 {
		t.Fatalf("tombstone 游标不应受影响: %d", ts)
	}
}

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
