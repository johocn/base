package httpapi

import (
	"encoding/json"
	"net/http"
	"regexp"
	"time"

	"github.com/johocn/base/internal/store"
)

// progressBody 是 progress.v1 的四个字段（#8 册子 §3.1）。
type progressBody struct {
	ItemID   string
	Position int64
	Done     bool
	Day      string
}

// progressKeys 是 progress.v1 的**严格键集**：多一个未知键即拒。
// `verifyEventSig` 会把 body 原样 canonicalize，签一份存另一份就是漏洞（同 parseCommentBody 口径，§3.1）。
var progressKeys = map[string]struct{}{
	"item_id": {}, "position": {}, "done": {}, "day": {},
}

// dayRe 校验打卡日的字面形态 YYYY-MM-DD（#8 册子 §3.1）。
var dayRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// validDay 判日界字符串**形态**合法。只校形态、不校「是不是真实存在的日期」——
// 日界是客户端自述数据（§10 风险 2），节点不解释日历、不做时钟可信性校验。
func validDay(s string) bool {
	return dayRe.MatchString(s)
}

// parseProgressBody 校验 progress.v1 的 body（#8 册子 §3.1），
// 返回**客户端原始键集**的 map（供 verifyEventSig 重建待验字节）。
func parseProgressBody(raw json.RawMessage) (map[string]any, progressBody, bool) {
	var pb progressBody
	if len(raw) == 0 {
		return nil, pb, false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, pb, false
	}
	if !onlyKeys(m, progressKeys) {
		return nil, pb, false
	}
	itemID, ok := m["item_id"].(string)
	if !ok || !validTargetID(itemID) {
		return nil, pb, false
	}
	pos, ok := jsonInt(m["position"])
	if !ok || pos < 0 {
		return nil, pb, false
	}
	done, ok := m["done"].(bool)
	if !ok {
		return nil, pb, false
	}
	day, ok := m["day"].(string)
	if !ok || !validDay(day) {
		return nil, pb, false
	}
	pb = progressBody{ItemID: itemID, Position: pos, Done: done, Day: day}
	return m, pb, true
}

// handleProgressEvent 处理 progress.v1：校验 body → 验内容签名 → **双投影同事务** → 落事件行 → 200（#8 册子 §4.1）。
//
// 与 govern.v1 的差别：进度投影**没有「冲突」语义**（输者静默 no-op 且不算错），
// 故任何投影错误都直接 500（不像 govern 要吞 ErrGovernEventConflict）。
// 事件行按**客户端原始键集**存 body_json（同 govern 口径），反熵侧据此还原两表列。
func (s *Server) handleProgressEvent(w http.ResponseWriter, actor string, req eventReq, createdAt int64) {
	rawBody, pb, ok := parseProgressBody(req.Body)
	if !ok {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	if !s.verifyEventSig(w, actor, req, rawBody) {
		return
	}
	if err := s.st.PutProgressProjection(store.ProgressEvent{
		ID: actor, ItemID: pb.ItemID, Position: pb.Position, Done: pb.Done, Day: pb.Day,
		CreatedAt: createdAt, EventID: req.EventID,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UnixMilli()
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: actor, Type: req.Type, BodyJSON: string(req.Body),
		CreatedAt: createdAt, ReceivedAt: now, TargetID: pb.ItemID,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 回读 received_at：同 event_id 重发时它是首次值，响应必须给权威值（与 comment / group / govern 同口径）。
	if ev, ok, err := s.st.GetEventByID(req.EventID); err == nil && ok {
		now = ev.ReceivedAt
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"event_id": req.EventID, "received_at": now})
}
