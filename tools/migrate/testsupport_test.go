package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
)

// 本机 Go 无法完成同进程回环 TCP（见 internal/httpapi/testsupport_test.go 的说明），
// 故 httptest.NewServer 在本机不可用。这里把默认传输换成进程内分发：
// 请求按 Host 查表直接送进 handler，不经过 socket。
// Run 内部自建 http.Client{Timeout: timeout}，其 Transport 为 nil → 走 http.DefaultTransport。
func init() {
	http.DefaultTransport = inprocTransport{}
}

// inprocServer 是 httptest.Server 的进程内替代物：只提供 URL 与 Close。
type inprocServer struct {
	URL string
}

func (s *inprocServer) Close() {}

var (
	inprocMu    sync.Mutex
	inprocTable = map[string]http.Handler{}
	inprocSeq   int
)

func newInprocServer(h http.Handler) *inprocServer {
	inprocMu.Lock()
	inprocSeq++
	host := fmt.Sprintf("node-%d.test", inprocSeq)
	inprocTable[host] = h
	inprocMu.Unlock()
	return &inprocServer{URL: "http://" + host}
}

type inprocTransport struct{}

func (inprocTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	inprocMu.Lock()
	h := inprocTable[req.URL.Host]
	inprocMu.Unlock()
	if h == nil {
		return nil, fmt.Errorf("测试未登记的进程内节点: %s", req.URL.Host)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Result(), nil
}
