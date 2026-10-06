package httpapi

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

const (
	commentDefaultLimit = 30
	commentMaxLimit     = 100
)

type commentDTO struct {
	EventID    string  `json:"event_id"`
	Actor      string  `json:"actor"`
	TargetID   string  `json:"target_id"`
	PayloadCID string  `json:"payload_cid"`
	ReplyTo    *string `json:"reply_to"`
	CreatedAt  int64   `json:"created_at"`
	LikeCount  int64   `json:"like_count"`
}

type commentListResponse struct {
	Comments   []commentDTO `json:"comments"`
	NextCursor *string      `json:"next_cursor"`
}

// handleCommentList 匿名分页读评论索引（册子 §4.2）；正文由客户端另取 GET /v1/blob/{payload_cid}。
func (s *Server) handleCommentList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := commentDefaultLimit
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= commentMaxLimit {
			limit = n
		}
	}
	curTS, curID := parseCommentCursor(q.Get("cursor"))
	rows, err := s.st.ListComments(q.Get("target_id"), curTS, curID, limit)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := commentListResponse{Comments: []commentDTO{}}
	// #79 §5.1：按页聚合 like_count（禁 N+1），无赞行 map 缺键按 0 填。
	targets := make([]string, 0, len(rows))
	for _, c := range rows {
		targets = append(targets, c.EventID)
	}
	likeMap, err := s.st.LikeCountsByTargets(targets)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, c := range rows {
		dto := commentDTO{
			EventID: c.EventID, Actor: c.Actor, TargetID: c.TargetID,
			PayloadCID: c.PayloadCID, CreatedAt: c.CreatedAt,
			LikeCount: likeMap[c.EventID],
		}
		if c.ReplyTo != "" {
			reply := c.ReplyTo
			dto.ReplyTo = &reply
		}
		resp.Comments = append(resp.Comments, dto)
	}
	// 满页才给游标：不满页即已到底。
	if len(rows) == limit {
		last := rows[len(rows)-1]
		next := strconv.FormatInt(last.CreatedAt, 10) + "_" + last.EventID
		resp.NextCursor = &next
	}
	s.writeJSON(w, http.StatusOK, resp)
}

// parseCommentCursor 解析不透明游标 `<created_at>_<event_id>`；非法值按首页处理（无游标）。
func parseCommentCursor(raw string) (int64, string) {
	if raw == "" {
		return 0, ""
	}
	tsRaw, id, ok := strings.Cut(raw, "_")
	if !ok || !isHexN(id, 16) {
		return 0, ""
	}
	ts, err := strconv.ParseInt(tsRaw, 10, 64)
	if err != nil {
		return 0, ""
	}
	return ts, id
}

// requireReviewKey 校验运营审核密钥。
// 未配置该密钥的节点上这两条路由根本不注册；密钥不符也回 404——不暴露路由存在性（册子 §4.3、风险 9）。
func (s *Server) requireReviewKey(next http.HandlerFunc) http.Handler {
	key := s.opt.ReviewKey
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-Base-Review-Key")
		if subtle.ConstantTimeCompare([]byte(got), []byte(key)) != 1 {
			s.writeError(w, http.StatusNotFound, "not_found")
			return
		}
		next(w, r)
	})
}

type reviewFetchReq struct {
	PayloadCID string `json:"payload_cid"`
}

// handleReviewFetch 按 payload_cid 取评论正文明文；不校验该块属于哪个类型（总纲 §7.3）。
func (s *Server) handleReviewFetch(w http.ResponseWriter, r *http.Request) {
	var req reviewFetchReq
	if !s.decodeJSON(w, r, &req) {
		return
	}
	if !protocol.IsBlobID(req.PayloadCID) {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	plain, err := s.st.GetBlobBytes(req.PayloadCID)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			s.writeError(w, http.StatusNotFound, "blob_not_found")
			return
		}
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"payload_cid": req.PayloadCID, "text": string(plain)})
}

// handleReviewReported 被举报评论列表（#79 §5.3）：X-Base-Review-Key 保护（requireReviewKey 同款）。
// 只聚合呈现，处置仍走既有 fetch→reject；无参数（空体 {}），列表短小不分页。
func (s *Server) handleReviewReported(w http.ResponseWriter, r *http.Request) {
	rows, err := s.st.ListReportedComments()
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	type reportedDTO struct {
		EventID     string   `json:"event_id"`
		Actor       string   `json:"actor"`
		TargetID    string   `json:"target_id"`
		PayloadCID  string   `json:"payload_cid"`
		ReplyTo     *string  `json:"reply_to"`
		CreatedAt   int64    `json:"created_at"`
		ReportCount int64    `json:"report_count"`
		Reporters   []string `json:"reporters"`
	}
	resp := struct {
		Reports []reportedDTO `json:"reports"`
	}{Reports: []reportedDTO{}}
	for _, c := range rows {
		dto := reportedDTO{
			EventID: c.EventID, Actor: c.Actor, TargetID: c.TargetID,
			PayloadCID: c.PayloadCID, CreatedAt: c.CreatedAt,
			ReportCount: c.ReportCount, Reporters: c.Reporters,
		}
		if c.ReplyTo != "" {
			reply := c.ReplyTo
			dto.ReplyTo = &reply
		}
		resp.Reports = append(resp.Reports, dto)
	}
	s.writeJSON(w, http.StatusOK, resp)
}

type reviewRejectReq struct {
	EventID string `json:"event_id"`
	Reason  string `json:"reason"`
}

// handleReviewReject 审核删：写墓碑 + 删本地块（册子 §4.3）。
// 墓碑随事件反熵传播，各节点据此删块且不再拉回（§4.5）。
func (s *Server) handleReviewReject(w http.ResponseWriter, r *http.Request) {
	var req reviewRejectReq
	if !s.decodeJSON(w, r, &req) {
		return
	}
	if !isHexN(req.EventID, 16) {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	ev, ok, err := s.st.GetEventByID(req.EventID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok || ev.PayloadCID == "" {
		s.writeError(w, http.StatusNotFound, "event_not_found")
		return
	}
	now := time.Now().UnixMilli()
	if err := s.st.PutCommentTombstone(store.CommentTombstone{
		EventID: ev.EventID, PayloadCID: ev.PayloadCID, Reason: req.Reason, At: now, ReceivedAt: now,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.st.DeleteBlob(ev.PayloadCID); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"event_id": ev.EventID, "payload_cid": ev.PayloadCID})
}
