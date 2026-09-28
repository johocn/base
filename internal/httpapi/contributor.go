package httpapi

import (
	"net/http"
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
