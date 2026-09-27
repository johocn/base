package httpapi

import (
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

// handleRelease 原样吐出节点数据目录下的 release.json（spec §8.3）。
// 节点不验签、不缓存、不合成：只把签发好的文件读出来；文件不存在即 404，
// App 把 404 当作「本节点无升级信息」并静默忽略。
func (s *Server) handleRelease(w http.ResponseWriter, r *http.Request) {
	f, err := os.Open(filepath.Join(s.st.DataDir(), "release.json"))
	if errors.Is(err, os.ErrNotExist) {
		s.writeError(w, http.StatusNotFound, "本节点无升级信息")
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer f.Close()
	if err := writeFileResponse(w, f, "application/json; charset=utf-8", false); err != nil {
		log.Printf("httpapi: 写 release 响应失败: %v", err)
	}
}
