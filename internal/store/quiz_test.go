package store

import (
	"testing"
)

func TestUpsertQuizRoundTrip(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer st.Close()

	const qjson = `{"schema_version":1,"questions":[{"q":"甲？","options":["a","b"],"answer":1,"explain":"因为"}]}`
	err = st.UpsertQuiz(Quiz{
		ItemID: "lesson:cid", Title: "内容寻址小测", QuestionJSON: qjson,
		ContentHash: "hash-1", SourceRev: "rev-1",
	})
	if err != nil {
		t.Fatalf("UpsertQuiz: %v", err)
	}

	it, ok, err := st.GetItem("lesson:cid")
	if err != nil || !ok {
		t.Fatalf("GetItem: ok=%v err=%v", ok, err)
	}
	if it.Source != "lesson" || it.Type != "quiz" || it.SQLiteTable != "quizzes" || it.DistClass != "public" {
		t.Fatalf("items 行不符: %+v", it)
	}

	q, ok, err := st.GetQuiz("lesson:cid")
	if err != nil || !ok {
		t.Fatalf("GetQuiz: ok=%v err=%v", ok, err)
	}
	if q.QuestionJSON != qjson || q.ContentHash != "hash-1" {
		t.Fatalf("quizzes 行不符: %+v", q)
	}

	// 幂等：同 item_id 再写覆盖，不新增行
	if err := st.UpsertQuiz(Quiz{ItemID: "lesson:cid", Title: "改了标题", QuestionJSON: qjson, ContentHash: "hash-2"}); err != nil {
		t.Fatalf("再次 UpsertQuiz: %v", err)
	}
	all, err := st.ListQuizzes(nil)
	if err != nil {
		t.Fatalf("ListQuizzes: %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("题库条目数 = %d，期望 1", len(all))
	}
	if all["lesson:cid"].ContentHash != "hash-2" {
		t.Fatalf("覆盖失败: %+v", all["lesson:cid"])
	}
}

func TestListQuizzesByIDs(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer st.Close()
	for _, id := range []string{"lesson:a", "lesson:b"} {
		if err := st.UpsertQuiz(Quiz{ItemID: id, Title: id, QuestionJSON: "{}", ContentHash: "h"}); err != nil {
			t.Fatalf("UpsertQuiz %s: %v", id, err)
		}
	}
	got, err := st.ListQuizzes([]string{"lesson:b"})
	if err != nil {
		t.Fatalf("ListQuizzes: %v", err)
	}
	if len(got) != 1 || got["lesson:b"].ItemID != "lesson:b" {
		t.Fatalf("按 id 取失败: %+v", got)
	}
}
