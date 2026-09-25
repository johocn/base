package httpapi

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
)

func (s *Server) writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		log.Printf("httpapi: encode response: %v", err)
	}
}

func (s *Server) writeError(w http.ResponseWriter, status int, msg string) {
	s.writeJSON(w, status, map[string]any{"error": msg})
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": s.opt.Version})
}

// handlePubkey 只对源节点开放：客户端据此验签（契约第 2 条）。
func (s *Server) handlePubkey(w http.ResponseWriter, r *http.Request) {
	if s.pub == "" {
		s.writeError(w, http.StatusNotFound, "本节点未配置签名密钥（只读分发节点）")
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"issuer":         s.opt.Issuer,
		"public_key_hex": s.pub,
	})
}

type catalogItem struct {
	ItemID      string `json:"item_id"`
	Source      string `json:"source"`
	Type        string `json:"type"`
	Title       string `json:"title"`
	ContentHash string `json:"content_hash"`
	SourceRev   string `json:"source_rev"`
}

type catalogResponse struct {
	PackID         string        `json:"pack_id"`
	ContentVersion int64         `json:"content_version"`
	Items          []catalogItem `json:"items"`
	NextCursor     *string       `json:"next_cursor"`
}

// handleCatalog 返回可分发内容目录（契约第 1 条）。
func (s *Server) handleCatalog(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 200
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}

	version := int64(0)
	packID := ""
	if rec, ok, err := s.st.LatestPack(); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	} else if ok {
		version = rec.ContentVersion
		packID = rec.PackID
	}

	resp := catalogResponse{PackID: packID, ContentVersion: version, Items: []catalogItem{}}
	if since := q.Get("since"); since != "" {
		if n, err := strconv.ParseInt(since, 10, 64); err == nil && n >= version {
			// 客户端已是最新版本：空 items + null cursor，快速 no-op
			s.writeJSON(w, http.StatusOK, resp)
			return
		}
	}

	// 多取一条用于判定「是否还有下一页」，保证最后一页 next_cursor 为 null
	items, _, err := s.st.ListItemsPage(q.Get("cursor"), limit+1)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = items[len(items)-1].ItemID
	}
	for _, it := range items {
		if it.State != "active" || it.DistClass != "public" {
			continue
		}
		resp.Items = append(resp.Items, catalogItem{
			ItemID: it.ItemID, Source: it.Source, Type: it.Type, Title: it.Title,
			ContentHash: it.ContentHash, SourceRev: it.SourceRev,
		})
	}
	if next != "" {
		resp.NextCursor = &next
	}
	s.writeJSON(w, http.StatusOK, resp)
}