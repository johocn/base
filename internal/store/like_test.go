package store

import (
	"fmt"
	"testing"
)

// #79 计数/举报聚合测试：seedEvent 只做示意性落行（真实写入走 PutEvent 幂等 upsert）。
func seedEvent(t *testing.T, st *Store, id, eventID, typ, target, bodyJSON string, createdAt int64) {
	t.Helper()
	if err := st.PutEvent(Event{EventID: eventID, ID: id, Type: typ, BodyJSON: bodyJSON,
		CreatedAt: createdAt, ReceivedAt: createdAt, TargetID: target}); err != nil {
		t.Fatal(err)
	}
}

const likeJSON = `{"action":"%s","target_id":%q,"sig":"00"}` // 计数只读 action，其余字段无关

// #79 §4.1：LWW 计数——同 (id,target) 取 (created_at,event_id) 最大者为最新状态。
func TestLikeCountsByTargetsLWW(t *testing.T) {
	st := openTemp(t)
	// actor A：like(t=100) → unlike(t=200) ⇒ 不计
	seedEvent(t, st, "A", "aa01", "like.v1", "c1", fmt.Sprintf(likeJSON, "like", "c1"), 100)
	seedEvent(t, st, "A", "aa02", "like.v1", "c1", fmt.Sprintf(likeJSON, "unlike", "c1"), 200)
	// actor B：like(t=300) ⇒ 计 1
	seedEvent(t, st, "B", "bb01", "like.v1", "c1", fmt.Sprintf(likeJSON, "like", "c1"), 300)
	// actor C：乱序——旧 like(t=50) 晚到，已有新 unlike(t=80) ⇒ 不计
	seedEvent(t, st, "C", "cc02", "like.v1", "c1", fmt.Sprintf(likeJSON, "unlike", "c1"), 80)
	seedEvent(t, st, "C", "cc01", "like.v1", "c1", fmt.Sprintf(likeJSON, "like", "c1"), 50)
	// actor D：只对 c2 点赞（不同 event_id 的重复 like 仍只计 1）
	seedEvent(t, st, "D", "dd01", "like.v1", "c2", fmt.Sprintf(likeJSON, "like", "c2"), 100)
	seedEvent(t, st, "D", "dd02", "like.v1", "c2", fmt.Sprintf(likeJSON, "like", "c2"), 101)

	got, err := st.LikeCountsByTargets([]string{"c1", "c2", "c3"})
	if err != nil {
		t.Fatal(err)
	}
	if got["c1"] != 1 || got["c2"] != 1 {
		t.Fatalf("c1=%d c2=%d, want 1/1", got["c1"], got["c2"])
	}
	if _, ok := got["c3"]; ok {
		t.Fatalf("c3 无赞，map 不应有键")
	}
}

// #79 §3.3：条目 target 校验——items 存在且 state='active'。
func TestActiveItemExists(t *testing.T) {
	st := openTemp(t)
	for _, it := range []struct{ id, state string }{
		{"article/a1", "active"},
		{"article/a2", "removed"},
	} {
		if _, err := st.db.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
			VALUES(?,?,?,?,?,?,?,?,?,?)`, it.id, "article", "article", "t", "r", "h", "articles", "public", it.state, "2026-01-01T00:00:00Z"); err != nil {
			t.Fatal(err)
		}
	}

	active, err := st.ActiveItemExists("article/a1")
	if err != nil || !active {
		t.Fatalf("active 条目应存在: ok=%v err=%v", active, err)
	}
	removed, err := st.ActiveItemExists("article/a2")
	if err != nil || removed {
		t.Fatalf("removed 条目不应算存在: ok=%v err=%v", removed, err)
	}
	missing, err := st.ActiveItemExists("article/none")
	if err != nil || missing {
		t.Fatalf("不存在条目应返回 false: ok=%v err=%v", missing, err)
	}
}

// #79 §5.3：被举报评论列表——去重举报人、report_count 降序、墓碑评论排除。
func TestListReportedComments(t *testing.T) {
	st := openTemp(t)
	// 三条评论事件（被举报的 target）
	putComment := func(eventID, actor, target, cid string, createdAt int64) {
		t.Helper()
		if err := st.PutEvent(Event{EventID: eventID, ID: actor, Type: "comment.v1",
			BodyJSON: `{}`, CreatedAt: createdAt, ReceivedAt: createdAt,
			TargetID: target, PayloadCID: cid}); err != nil {
			t.Fatal(err)
		}
	}
	putComment("x1", "author1", "article/a", "cid-x1", 100)
	putComment("x2", "author2", "article/a", "cid-x2", 200)
	putComment("x3", "author3", "article/a", "cid-x3", 300)

	putReport := func(actor, eventID, target string, createdAt int64) {
		t.Helper()
		seedEvent(t, st, actor, eventID, "report.v1", target,
			fmt.Sprintf(`{"reason":"spam","target_id":%q,"sig":"00"}`, target), createdAt)
	}
	// c1(x1) 被甲、乙、甲 举报（甲重复，去重后 2 人）⇒ report_count=2
	putReport("甲", "r01", "x1", 10)
	putReport("乙", "r02", "x1", 11)
	putReport("甲", "r03", "x1", 12)
	// c2(x2) 被丙举报 1 次 ⇒ report_count=1
	putReport("丙", "r04", "x2", 13)
	// c3(x3) 被丁举报 1 次，但评论已墓碑 ⇒ 不出现
	putReport("丁", "r05", "x3", 14)
	if err := st.PutCommentTombstone(CommentTombstone{EventID: "x3", PayloadCID: "cid-x3", Reason: "abuse", At: 400}); err != nil {
		t.Fatal(err)
	}

	rows, err := st.ListReportedComments()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("墓碑评论应被排除，只余 2 行: %+v", rows)
	}
	// c1 report_count=2 在前（降序）
	if rows[0].EventID != "x1" || rows[0].ReportCount != 2 {
		t.Fatalf("第一行应为 x1(count=2): %+v", rows[0])
	}
	if rows[0].Actor != "author1" || rows[0].TargetID != "article/a" || rows[0].PayloadCID != "cid-x1" || rows[0].CreatedAt != 100 {
		t.Fatalf("x1 行字段错误: %+v", rows[0])
	}
	if len(rows[0].Reporters) != 2 {
		t.Fatalf("reporters 应去重为 2 人: %+v", rows[0].Reporters)
	}
	seen := map[string]bool{}
	for _, r := range rows[0].Reporters {
		seen[r] = true
	}
	if !seen["甲"] || !seen["乙"] {
		t.Fatalf("reporters 应为 {甲,乙}: %+v", rows[0].Reporters)
	}
	if rows[1].EventID != "x2" || rows[1].ReportCount != 1 {
		t.Fatalf("第二行应为 x2(count=1): %+v", rows[1])
	}
	if len(rows[1].Reporters) != 1 || rows[1].Reporters[0] != "丙" {
		t.Fatalf("x2 reporters 应为 [丙]: %+v", rows[1].Reporters)
	}
}
