package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
)

// 本机 Go 无法完成同进程回环 TCP（listen 与 dial 在同一进程内 100% 超时，
// 跨进程正常；见计划「已核实的环境事实」），故 httptest.NewServer 在本机不可用。
// 这里把默认传输换成进程内分发：请求按 Host 查表直接送进 handler，不经过 socket。
// 调用点继续把 inprocServer.URL 当普通字符串拼接，断言逻辑不变。
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
