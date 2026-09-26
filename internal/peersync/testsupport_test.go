package peersync

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/johocn/base/internal/store"
)

// 本机 Go 无法完成同进程回环 TCP（listen 与 dial 在同一进程内 100% 超时，
// 跨进程正常），故 httptest.NewServer 在本机不可用。
// 这里提供进程内 RoundTripper：请求按 Host 查表直接送进 handler，不经过 socket。
// 与 internal/httpapi/testsupport_test.go 的做法一致，但 test helper 跨包不可见，只能各留一份。
var (
	inprocMu    sync.Mutex
	inprocTable = map[string]http.Handler{}
	inprocSeq   int
)

// newInprocPeer 登记一个进程内 peer 并返回它的 URL 与「注入给 Config.TransportFor 的传输」。
func newInprocPeer(t *testing.T, h http.Handler) (url string, rt func(Peer) (http.RoundTripper, error)) {
	t.Helper()
	inprocMu.Lock()
	inprocSeq++
	host := fmt.Sprintf("peer-%d.test", inprocSeq)
	inprocTable[host] = h
	inprocMu.Unlock()
	return "https://" + host, func(Peer) (http.RoundTripper, error) { return inprocTransport{}, nil }
}

type inprocTransport struct{}

func (inprocTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	inprocMu.Lock()
	h := inprocTable[req.URL.Host]
	inprocMu.Unlock()
	if h == nil {
		return nil, fmt.Errorf("测试未登记的进程内 peer: %s", req.URL.Host)
	}
	if req.Body == nil {
		req.Body = http.NoBody
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Result(), nil
}

// openTemp 打开测试用内容库（注入固定密钥，避免在仓库根落地 data.key）。
func openTemp(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir(), store.WithStoreKey(testStoreKey))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// testStoreKey 是测试固定静态加密密钥（hex64）。
const testStoreKey = "9f2c1d4a7b3e5081f6a9c2d5e8b10432a7c9e6b3d0f84261c5a8e2b7d4f01963"