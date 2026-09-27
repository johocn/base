package packexport

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/johocn/base/internal/store"
	_ "modernc.org/sqlite"
)

const seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"

func TestExportIncludesQuizzes(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer st.Close()
	if err := st.UpsertArticle(store.Article{
		ItemID: "article:aaa", Title: "甲", Digest: "甲", PublishedAt: "2026-01-01T00:00:00Z",
		TagsJSON: "[]", BodyMD: "甲正文\n", ContentHash: "bodyhash",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	const qjson = `{"schema_version":1,"questions":[{"q":"甲？","options":["a","b"],"answer":1,"explain":"e"}]}`
	if err := st.UpsertQuiz(store.Quiz{ItemID: "lesson:cid", Title: "小测", QuestionJSON: qjson, ContentHash: "qhash"}); err != nil {
		t.Fatalf("UpsertQuiz: %v", err)
	}

	res, err := Export(st, Options{
		Issuer: "base-node-1", SignKeyHex: seed, Version: 7,
		IssuedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}

	var found bool
	for _, e := range res.Manifest.Entries {
		if e.ItemID == "lesson:cid" {
			found = true
			if e.SQLiteTable != "quizzes" || e.Type != "quiz" || e.ContentHash != "qhash" {
				t.Fatalf("条目不符: %+v", e)
			}
			if len(e.Chunks) != 0 {
				t.Fatalf("题库不应有块: %+v", e.Chunks)
			}
		}
	}
	if !found {
		t.Fatalf("manifest.entries 缺少 lesson:cid: %+v", res.Manifest.Entries)
	}

	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(res.PackPath))
	if err != nil {
		t.Fatalf("open pack: %v", err)
	}
	defer db.Close()
	var gotJSON, gotHash string
	if err := db.QueryRow(`SELECT question_json,content_hash FROM quizzes WHERE item_id=?`, "lesson:cid").Scan(&gotJSON, &gotHash); err != nil {
		t.Fatalf("pack 内 quizzes 行缺失: %v", err)
	}
	if gotJSON != qjson || gotHash != "qhash" {
		t.Fatalf("pack 内 quizzes 行不符: %q / %q", gotJSON, gotHash)
	}
	if _, err := os.Stat(res.ManifestPath); err != nil {
		t.Fatalf("manifest 未落盘: %v", err)
	}
}
