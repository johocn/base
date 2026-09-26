package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// newPeerTestServer 起一个节点，返回 store、服务端、**客户端路由**、**对端路由**。
// 客户端路由 = Handler()（只有公开路由）；对端路由 = PeerHandler()（公开 ∪ 内部）。
func newPeerTestServer(t *testing.T) (*store.Store, *Server, *inprocServer, *inprocServer) {
	t.Helper()
	st, srv, _ := newFullServer(t) // event_test.go 的既有 helper
	return st, srv, newInprocServer(srv.Handler()), newInprocServer(srv.PeerHandler())
}

func TestInternalRoutesAbsentOnClientListener(t *testing.T) {
	_, _, client, peer := newPeerTestServer(t)
	cases := []struct{ method, path string }{
		{http.MethodGet, "/v1/inventory"},
		{http.MethodPost, "/v1/sync"},
		{http.MethodPost, "/v1/fetch"},
		{http.MethodPost, "/v1/scrub"},
	}
	for _, c := range cases {
		req, err := http.NewRequest(c.method, client.URL+c.path, strings.NewReader("{}"))
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", c.method, c.path, err)
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("客户端监听上 %s %s = %d, want 404（内部接口必须不存在）", c.method, c.path, res.StatusCode)
		}
		// 同一条路径在对端监听上必须存在（不是 404）
		req2, _ := http.NewRequest(c.method, peer.URL+c.path, strings.NewReader("{}"))
		res2, err := http.DefaultClient.Do(req2)
		if err != nil {
			t.Fatalf("peer %s %s: %v", c.method, c.path, err)
		}
		_, _ = io.Copy(io.Discard, res2.Body)
		res2.Body.Close()
		if res2.StatusCode == http.StatusNotFound {
			t.Fatalf("对端监听上 %s %s = 404，接口未注册", c.method, c.path)
		}
	}
}

func TestPeerHandlerKeepsPublicRoutes(t *testing.T) {
	_, _, _, peer := newPeerTestServer(t)
	res, err := http.Get(peer.URL + "/v1/catalog")
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("对端监听上的公开路由 /v1/catalog = %d, want 200", res.StatusCode)
	}
}

func TestInventoryPaginationAndSinceNoop(t *testing.T) {
	// 复用 Task 4 已在 peer_test.go 落下的 helper（唯一 4 返回值版本）。
	st, _, _, peer := newPeerTestServer(t)
	for _, s := range []string{"①", "②", "③"} {
		data := []byte("块" + s)
		id := protocol.BlobID(data)
		if err := st.PutBlob(id, data, "lesson:x", 0); err != nil {
			t.Fatalf("PutBlob: %v", err)
		}
	}

	// 分页：limit=2 → 2 条 + next_cursor
	res, err := http.Get(peer.URL + "/v1/inventory?limit=2")
	if err != nil {
		t.Fatalf("inventory: %v", err)
	}
	var page inventoryResponse
	if err := json.NewDecoder(res.Body).Decode(&page); err != nil {
		t.Fatalf("decode: %v", err)
	}
	res.Body.Close()
	if len(page.Blobs) != 2 || page.NextCursor == nil || page.MerkleRoot == "" {
		t.Fatalf("page = %d 条 next=%v root=%q", len(page.Blobs), page.NextCursor, page.MerkleRoot)
	}
	if page.ContentVersion != 0 {
		t.Fatalf("content_version = %d, want 0（未导出过包）", page.ContentVersion)
	}

	// since >= 本节点水位 → 空 blobs 但仍带 merkle_root
	res2, err := http.Get(peer.URL + "/v1/inventory?since=0")
	if err != nil {
		t.Fatalf("inventory since: %v", err)
	}
	var page2 inventoryResponse
	if err := json.NewDecoder(res2.Body).Decode(&page2); err != nil {
		t.Fatalf("decode2: %v", err)
	}
	res2.Body.Close()
	if len(page2.Blobs) != 0 || page2.MerkleRoot == "" {
		t.Fatalf("since no-op 应为空 blobs + 非空 root，got %d/%q", len(page2.Blobs), page2.MerkleRoot)
	}
}

func TestFetchStreamsFramesAndSkipsMissing(t *testing.T) {
	st, _, _, peer := newPeerTestServer(t)
	body := []byte("fetch 的块字节")
	id := protocol.BlobID(body)
	if err := st.PutBlob(id, body, "lesson:x", 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	missing := strings.Repeat("ab", 16) // 32 hex，但本节点没有

	reqBody, _ := json.Marshal(fetchRequest{BlobIDs: []string{id, missing}})
	res, err := http.Post(peer.URL+"/v1/fetch", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != protocol.BlobPackContentType {
		t.Fatalf("Content-Type = %q", ct)
	}
	gotID, gotBody, err := protocol.ReadBlobFrame(res.Body)
	if err != nil || gotID != id || !bytes.Equal(gotBody, body) {
		t.Fatalf("帧 = %s err=%v", gotID, err)
	}
	if _, _, err := protocol.ReadBlobFrame(res.Body); !errors.Is(err, io.EOF) {
		t.Fatalf("缺失块必须整帧跳过（流到此结束），got %v", err)
	}
}

func TestFetchRejectsOverLimit(t *testing.T) {
	_, _, _, peer := newPeerTestServer(t)
	ids := make([]string, 65)
	for i := range ids {
		ids[i] = strings.Repeat("0", 31) + strconv.Itoa(i%10)
	}
	reqBody, _ := json.Marshal(fetchRequest{BlobIDs: ids})
	res, err := http.Post(peer.URL+"/v1/fetch", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", res.StatusCode)
	}
}

func TestScrubEndpointRepairsNothingLocally(t *testing.T) {
	st, _, _, peer := newPeerTestServer(t)
	body := []byte("正常块")
	id := protocol.BlobID(body)
	if err := st.PutBlob(id, body, "lesson:x", 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	res, err := http.Post(peer.URL+"/v1/scrub", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("scrub: %v", err)
	}
	defer res.Body.Close()
	var out scrubResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Checked != 1 || out.Dropped != 0 || out.Repaired != 0 || len(out.Bad) != 0 {
		t.Fatalf("scrub = %+v", out)
	}
}
