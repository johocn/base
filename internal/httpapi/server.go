// Package httpapi 实现节点对外的 HTTP 接口。P0 只有匿名公开读与只读浏览页；
// 写接口（事件/账号）与内部同步接口属 P1/P2，不在本包范围内。
package httpapi

import (
	"log"
	"net/http"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// Options 是节点对外服务的配置。SignKeyHex 为空表示本节点是只读分发节点。
type Options struct {
	Issuer     string
	SignKeyHex string
	Version    string
}

// Server 是节点 HTTP 服务。
type Server struct {
	st  *store.Store
	opt Options
	pub string
}

// New 构造服务；配置了私钥时同时推导出公钥（用于 /v1/pubkey 与验签）。
func New(st *store.Store, opt Options) (*Server, error) {
	s := &Server{st: st, opt: opt}
	if opt.SignKeyHex != "" {
		kp, err := protocol.KeyPairFromSeed(opt.SignKeyHex)
		if err != nil {
			return nil, err
		}
		s.pub = kp.PubHex
	}
	return s, nil
}

// Handler 返回路由。公开读路由不挂鉴权中间件（契约：匿名可读）。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /v1/pubkey", s.handlePubkey)
	mux.HandleFunc("GET /v1/catalog", s.handleCatalog)
	return withCommon(mux)
}

// withCommon 统一处理 CORS、OPTIONS 预检、panic 兜底与访问日志。
func withCommon(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		h.Set("X-Content-Type-Options", "nosniff")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		defer func() {
			if v := recover(); v != nil {
				log.Printf("httpapi: panic %s %s: %v", r.Method, r.URL.Path, v)
				http.Error(rec, "internal error", http.StatusInternalServerError)
			}
			log.Printf("httpapi: %s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
		}()
		next.ServeHTTP(rec, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (r *statusRecorder) WriteHeader(code int) {
	if !r.wrote {
		r.status = code
		r.wrote = true
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	r.wrote = true
	return r.ResponseWriter.Write(b)
}