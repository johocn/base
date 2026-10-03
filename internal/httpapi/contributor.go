package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/johocn/base/internal/protocol"
)

type contributorDTO struct {
	ID    string `json:"id"`
	Count int    `json:"count"`
	Name  string `json:"name"`
}

type contributorsResponse struct {
	Contributors []contributorDTO `json:"contributors"`
}

// handleContributors 匿名返回本节点实时派生的贡献前 10 名名册（治理册 §5.1）。
// 不返回条目清单、不返回投稿时间、不返回任何内容 id；空名册返回 []（不是 null）。
func (s *Server) handleContributors(w http.ResponseWriter, r *http.Request) {
	rows, err := s.st.ContributorRoster()
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	ids := make([]string, 0, len(rows))
	for _, c := range rows {
		ids = append(ids, c.ID)
	}
	names, err := s.st.ProfileNames(ids)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := contributorsResponse{Contributors: []contributorDTO{}}
	for _, c := range rows {
		name := names[c.ID]
		if name == "" {
			name = c.ID[:8] // 展示层回退，不影响任何判定（治理册 §5.1）
		}
		resp.Contributors = append(resp.Contributors, contributorDTO{ID: c.ID, Count: c.Count, Name: name})
	}
	s.writeJSON(w, http.StatusOK, resp)
}

type profilePutReq struct {
	Name string          `json:"name"`
	ID   json.RawMessage `json:"id"`
}

// validProfileName 按治理册 §5.2：去首尾空白后 rune 长度 1..32，且不含控制字符。
func validProfileName(s string) bool {
	n := utf8.RuneCountInString(s)
	if n < 1 || n > 32 {
		return false
	}
	for _, r := range s {
		if r <= 0x1F || r == 0x7F {
			return false
		}
	}
	return true
}

// handleProfilePut 写入调用者自己的公开昵称（治理册 §5.2），与评论写路径同一条鉴权路。
// 硬约束：id 只能取自鉴权中间件解析出的身份，请求体不得携带 id——否则等于伪造他人昵称。
func (s *Server) handleProfilePut(w http.ResponseWriter, r *http.Request) {
	var req profilePutReq
	if !s.decodeJSON(w, r, &req) {
		return
	}
	if len(req.ID) > 0 {
		s.writeAuthErr(w, http.StatusBadRequest, "profile_id_forbidden")
		return
	}
	name := strings.TrimSpace(req.Name)
	if !validProfileName(name) {
		s.writeAuthErr(w, http.StatusBadRequest, "profile_name_invalid")
		return
	}
	id := identityFrom(r)
	if err := s.st.PutProfile(id, name, time.Now().UnixMilli()); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"id": id, "name": name})
}

// handleProfileGet 匿名查询单条公开昵称（治理册 §5.1）：与 /v1/contributors 同级的匿名公开读。
// 空昵称即未登记——诚实返回 404，不泄露任何额外状态。
func (s *Server) handleProfileGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !protocol.IsIdentityID(id) {
		s.writeError(w, http.StatusBadRequest, "profile_id_invalid")
		return
	}
	name, found, err := s.st.GetProfile(strings.ToLower(id))
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !found {
		s.writeError(w, http.StatusNotFound, "profile_not_found")
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"id": strings.ToLower(id), "name": name})
}
