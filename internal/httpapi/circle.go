package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/johocn/base/internal/store"
)

// circleBody 是 circle.v1 的正文（融合治理册 §2.2）。
// action 枚举：assign（声明归属）| form（成圈）。
// content_hash 可选：若给了必须是合法 hex 串，本 handler 不做进一步验证——
// 它只是客户端承诺的关联哈希，校验留给消费侧。
type circleBody struct {
	Action      string
	ItemID      string
	CircleID    string
	Origin      string
	ContentHash string
}

// circleAssignKeys / circleFormKeys 是两档严格键集（融合治理册 §2.2）。
// 多一个未知键即拒——verifyEventSig 会把 body 原样 canonicalize，
// 签的与存的不一致就是漏洞（同 parseCommentBody / parseGovernBody 口径）。
var (
	circleAssignKeys = map[string]struct{}{
		"action": {}, "item_id": {}, "circle_id": {}, "content_hash": {},
	}
	circleFormKeys = map[string]struct{}{
		"action": {}, "item_id": {}, "circle_id": {}, "origin": {}, "content_hash": {},
	}
)

// parseCircleBody 校验 circle.v1 的 body，返回**客户端原始键集**的 map（供验签重建）。
// assign 键集：{action, item_id, circle_id, content_hash?}
// form   键集：{action, item_id, circle_id, origin?, content_hash?}
// origin 取值仅 "fusion" | "user"，缺省 "fusion"。
func parseCircleBody(raw json.RawMessage) (map[string]any, circleBody, bool) {
	var cb circleBody
	if len(raw) == 0 {
		return nil, cb, false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, cb, false
	}
	action, _ := m["action"].(string)
	itemID, _ := m["item_id"].(string)
	circleID, _ := m["circle_id"].(string)
	if !validTargetID(itemID) {
		return nil, cb, false
	}
	if !isHexN(circleID, 16) {
		return nil, cb, false
	}
	cb.ItemID = itemID
	cb.CircleID = circleID
	cb.Origin = "fusion" // 缺省

	switch action {
	case "assign":
		if !onlyKeys(m, circleAssignKeys) {
			return nil, cb, false
		}
		cb.Action = action
	case "form":
		if !onlyKeys(m, circleFormKeys) {
			return nil, cb, false
		}
		// origin 可选，取值封闭。
		if v, ok := m["origin"]; ok {
			s, isStr := v.(string)
			if !isStr {
				return nil, cb, false
			}
			if s != "fusion" && s != "user" {
				return nil, cb, false
			}
			cb.Origin = s
		}
		cb.Action = action
	default:
		return nil, cb, false
	}
	// content_hash 可选；若给了必须是合法 hex 串。
	if v, ok := m["content_hash"]; ok {
		s, isStr := v.(string)
		if !isStr || !isHexNonEmptyEven(s) {
			return nil, cb, false
		}
		cb.ContentHash = s
	}
	return m, cb, true
}

// handleCircleEvent 校验 body → 验签 → 按 action 分流 → 落事件骨架 → 回读 received_at → 200。
// form action 需查本地 items 表取 author_id 成圈（设计册决策 6），条目不存在 → 400 item_not_found（fail-closed）。
func (s *Server) handleCircleEvent(w http.ResponseWriter, actor string, req eventReq, createdAt int64) {
	rawBody, cb, ok := parseCircleBody(req.Body)
	if !ok {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	if !s.verifyEventSig(w, actor, req, rawBody) {
		return
	}
	switch cb.Action {
	case "assign":
		if err := s.st.PutCircleAssignment(cb.ItemID, cb.CircleID, cb.Origin, createdAt); err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	case "form":
		// fail-closed：form 事件引用的条目必须存在，否则拒绝。
		item, found, err := s.st.GetItem(cb.ItemID)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !found {
			s.writeError(w, http.StatusBadRequest, "item_not_found")
			return
		}
		// 成圈：creator_id = 条目作者（设计册 #74 §2.2）。
		if err := s.st.UpsertGroupForForm(cb.CircleID, item.AuthorID, createdAt, cb.Origin); err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := s.st.PutCircleAssignment(cb.ItemID, cb.CircleID, cb.Origin, createdAt); err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	// 事件骨架落盘；body_json 保留客户端原始字节（同 govern.v1 口径，反熵要据它重投影）。
	now := time.Now().UnixMilli()
	body := req.Body
	if len(body) == 0 {
		body = json.RawMessage(`{}`)
	}
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: actor, Type: req.Type,
		BodyJSON: string(body), CreatedAt: createdAt, ReceivedAt: now,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if ev, ok, err := s.st.GetEventByID(req.EventID); err == nil && ok {
		now = ev.ReceivedAt
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"event_id": req.EventID, "received_at": now,
	})
}
