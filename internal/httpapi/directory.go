package httpapi

import (
	"net/http"
	"strconv"

	"github.com/johocn/base/internal/store"
)

type directoryTermDTO struct {
	Kind        string `json:"kind"`
	TermKey     string `json:"term_key"`
	DisplayName string `json:"display_name"`
}

type directoryPendingDTO struct {
	Kind        string `json:"kind"`
	TermKey     string `json:"term_key"`
	DisplayName string `json:"display_name"`
	Votes       int    `json:"votes"`
	Threshold   int    `json:"threshold"`
}

type directoryResponse struct {
	Version  int64                 `json:"version"`
	Approved []directoryTermDTO    `json:"approved"`
	Pending  []directoryPendingDTO `json:"pending"`
}

// handleDirectoryGet 是匿名公开读 GET /v1/directory（册子 #58 §4.1）：与 contributors / catalog 同级；
// 复用治理面 IP 限速（不新增限速器）；客户端带 version 且未变时短路返回 unchanged。
func (s *Server) handleDirectoryGet(w http.ResponseWriter, r *http.Request) {
	if !s.governLimiterByIP.allow(clientIP(r)) {
		s.writeAuthErr(w, http.StatusTooManyRequests, "govern_rate_limited")
		return
	}
	version, err := s.st.DirectoryVersion()
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// version 未变短路：与 catalog 的 since 水位同体例。
	if v := r.URL.Query().Get("version"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n == version {
			s.writeJSON(w, http.StatusOK, map[string]any{"version": version, "unchanged": true})
			return
		}
	}

	// approved 只取 ListDirectory 的第一个返回值：directory_terms 实际只存 approved 行（未豁免时
	// store 不写目录行），pending 态仅存在于 govern_proposals，故待票选词条由未定案提案派生。
	approved, _, err := s.st.ListDirectory()
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	roster, rosterOK := s.governRoster()
	views, err := s.st.ListProposalViews(roster)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	threshold := store.GovernThresholdForRoster(store.GovernActionDirectoryAdd, len(roster), rosterOK)

	resp := directoryResponse{Version: version, Approved: []directoryTermDTO{}, Pending: []directoryPendingDTO{}}
	for _, t := range approved {
		resp.Approved = append(resp.Approved, directoryTermDTO{
			Kind: t.Kind, TermKey: t.TermKey, DisplayName: t.DisplayName,
		})
	}
	for _, v := range views {
		if v.Action != store.GovernActionDirectoryAdd || v.Status != store.GovernStatusPending {
			continue
		}
		kind, ok := store.DirectoryKindOfItemID(v.ItemID)
		if !ok {
			continue
		}
		resp.Pending = append(resp.Pending, directoryPendingDTO{
			Kind: kind, TermKey: v.BodyMD, DisplayName: v.Title,
			Votes: len(v.Votes), Threshold: threshold,
		})
	}
	s.writeJSON(w, http.StatusOK, resp)
}
