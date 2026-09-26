package httpapi

import "net/http"

// 本文件是节点↔节点接口的**入站**侧的注册落点：只在对端监听上注册（见 server.go 的 mountInternal），
// 客户端监听上这四条路径必须不存在（404）——册子 §5.1 的红线。
//
// 四个接口的处理器本体（inventory / sync / fetch / scrub）属实施计划 Task 5；
// 本 Task（Task 4 路由隔离）只需路由骨架可编译，故先以 501 占位，Task 5 原地替换这四个方法体。

func (s *Server) handleInventory(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func (s *Server) handleSync(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func (s *Server) handleFetch(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func (s *Server) handleScrub(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}
