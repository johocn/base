package httpapi

import (
	"database/sql"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// 归属缓存列只由导入/投稿产生，httpapi 侧没有公开写路径，故测试直写库。
func setCachedAuthor(t *testing.T, st *store.Store, itemID, authorID, sig string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(st.DataDir(), "base.db"))+"?mode=rw")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(`UPDATE items SET author_id=?, author_sig=? WHERE item_id=?`, authorID, sig, itemID); err != nil {
		t.Fatalf("set author: %v", err)
	}
}

func TestContributorsEndpointAnonymous(t *testing.T) {
	st, _, ts := newTestServer(t)
	const authorID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	long := strings.Repeat("字", 200)
	if err := st.UpsertArticle(store.Article{
		ItemID: "article/long", Title: "长文", BodyMD: long,
		ContentHash: protocol.SHA256Hex([]byte(long)), UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}
	setCachedAuthor(t, st, "article/long", authorID, "00")

	// 无签名头亦 200（治理册 §5.1）
	code, body := getJSON(t, ts.URL+"/v1/contributors")
	if code != http.StatusOK {
		t.Fatalf("status=%d body=%v", code, body)
	}
	list, ok := body["contributors"].([]any)
	if !ok || len(list) != 1 {
		t.Fatalf("名册结构错误: %v", body)
	}
	row := list[0].(map[string]any)
	if row["id"] != authorID || row["count"].(float64) != 1 {
		t.Fatalf("名册行错误: %v", row)
	}
	// 未设置昵称 → 回退 id 前 8 位
	if row["name"] != authorID[:8] {
		t.Fatalf("昵称回退错误: %v", row["name"])
	}
}

func TestContributorsEndpointEmptyRoster(t *testing.T) {
	_, _, ts := newTestServer(t)
	// 种子内容都无归属 → 空名册 + 200，不报错（治理册 §6）
	code, body := getJSON(t, ts.URL+"/v1/contributors")
	if code != http.StatusOK {
		t.Fatalf("status=%d body=%v", code, body)
	}
	list, ok := body["contributors"].([]any)
	if !ok || len(list) != 0 {
		t.Fatalf("应为空数组而非 null: %v", body)
	}
}
