package httpapi

import (
	"io"
	"net/http"
	"strings"
	"testing"

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
