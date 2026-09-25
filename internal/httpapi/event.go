package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/johocn/base/internal/store"
)

type eventReq struct {
	EventID   string          `json:"event_id"`
	Type      string          `json:"type"`
	CreatedAt int64           `json:"created_at"`
	Body      json.RawMessage `json:"body"`
}

// handleEventPost 落地验签管线与落库骨架（契约 5.6）。
// S1 阶段 s.knownEventTypes 为空，故一律 400 event_type_unknown；
// B 阶段只需往该表登记类型，管线与本处理器都不用改。
func (s *Server) handleEventPost(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r)
	var req eventReq
	if !s.decodeJSON(w, r, &req) {
		return
	}
	if _, ok := s.knownEventTypes[req.Type]; !ok {
		s.writeError(w, http.StatusBadRequest, "event_type_unknown")
		return
	}
	if !isHexN(req.EventID, 16) || req.CreatedAt <= 0 {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	body := req.Body
	if len(body) == 0 {
		body = json.RawMessage(`{}`)
	}
	now := time.Now().UnixMilli()
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: id, Type: req.Type,
		BodyJSON: string(body), CreatedAt: req.CreatedAt, ReceivedAt: now,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"event_id": req.EventID, "received_at": now})
}
