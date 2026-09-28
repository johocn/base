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

func TestProfilePut(t *testing.T) {
	st, _, ts := newTestServer(t)
	id, pub := identityFromSeed(t, testSeed)
	if status, body := doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/identity/register", "", registerBody(id, pub)); status != http.StatusOK {
		t.Fatalf("预登记 status=%d body=%v", status, body)
	}

	// 合法昵称
	code, body := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/profile", `{"name":"  阿茶  "}`))
	if code != http.StatusOK {
		t.Fatalf("status=%d body=%v", code, body)
	}
	if body["id"] != id || body["name"] != "阿茶" {
		t.Fatalf("入库值应为去空白后的昵称: %v", body)
	}
	names, err := st.ProfileNames([]string{id})
	if err != nil {
		t.Fatal(err)
	}
	if names[id] != "阿茶" {
		t.Fatalf("昵称未落库: %v", names)
	}

	// 幂等覆盖
	if code, _ := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/profile", `{"name":"阿茶二"}`)); code != http.StatusOK {
		t.Fatalf("覆盖写入失败: %d", code)
	}
	names, _ = st.ProfileNames([]string{id})
	if names[id] != "阿茶二" {
		t.Fatalf("覆盖失败: %v", names)
	}

	// 请求体携带 id → 400，且不写入他人昵称（治理册 §5.2 硬约束）
	other := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	code, body = sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/profile",
		`{"name":"冒名","id":"`+other+`"}`))
	if code != http.StatusBadRequest {
		t.Fatalf("带 id 应 400: %d %v", code, body)
	}
	names, _ = st.ProfileNames([]string{other})
	if len(names) != 0 {
		t.Fatalf("不得写入他人昵称: %v", names)
	}

	// 超长 / 空 / 控制字符 → 400
	for _, bad := range []string{
		`{"name":"` + strings.Repeat("字", 33) + `"}`,
		`{"name":"   "}`,
		`{"name":"阿\u0000茶"}`,
	} {
		if code, _ := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/profile", bad)); code != http.StatusBadRequest {
			t.Fatalf("非法昵称应 400: %s", bad)
		}
	}

	// 缺签名头 → 400 auth_missing_header（契约 §3.2 第 1 步）
	if code, body := doJSONMap(t, http.MethodPost, ts.URL+"/v1/profile", `{"name":"无签名"}`, nil); code != http.StatusBadRequest || body["code"] != "auth_missing_header" {
		t.Fatalf("缺签名头应 400 auth_missing_header: %d %v", code, body)
	}

	// 重放（同 nonce 同 ts）→ 401
	replay := signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/profile", `{"name":"重放"}`)
	if code, _ := sendAuth(t, replay); code != http.StatusOK {
		t.Fatalf("首次应成功: %d", code)
	}
	dup := signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/profile", `{"name":"重放"}`)
	copyAuthHeaders(replay, dup)
	if code, body := sendAuth(t, dup); code != http.StatusUnauthorized || body["code"] != "auth_nonce_replay" {
		t.Fatalf("重放应 401 auth_nonce_replay: %d %v", code, body)
	}
}

func TestContributorNameFollowsProfile(t *testing.T) {
	st, _, ts := newTestServer(t)
	const authorID = "cccccccccccccccccccccccccccccccc"
	long := strings.Repeat("字", 200)
	if err := st.UpsertArticle(store.Article{
		ItemID: "article/long2", Title: "长文", BodyMD: long,
		ContentHash: protocol.SHA256Hex([]byte(long)), UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}
	setCachedAuthor(t, st, "article/long2", authorID, "00")
	if err := st.PutProfile(authorID, "阿茶", 1); err != nil {
		t.Fatal(err)
	}
	code, body := getJSON(t, ts.URL+"/v1/contributors")
	if code != http.StatusOK {
		t.Fatalf("status=%d", code)
	}
	list := body["contributors"].([]any)
	if list[0].(map[string]any)["name"] != "阿茶" {
		t.Fatalf("名册未取到昵称: %v", list[0])
	}
}
