package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

const (
	// maxCommentBytes 是单条评论正文的 UTF-8 字节上限（册子 §3.2），远小于 maxJSONBody。
	maxCommentBytes = 8192

	// 写限速（册子 §4.1）：按已验签身份与客户端 IP 双维度，超限 429 event_rate_limited。
	eventPerMinutePerID = 30
	eventBurstPerID     = 10
	eventPerMinutePerIP = 120
	eventBurstPerIP     = 30
)

// eventTypeRegistry 是节点放行的事件类型表。
// 新增类型 = 在此加一行 + 在 handleEventPost 的 switch 里加一个分支，不改验签管线。
var eventTypeRegistry = map[string]struct{}{
	"comment.v1":  {},
	"group.v1":    {},
	"dm.v1":       {},
	"govern.v1":   {},
	"progress.v1": {},
}

type eventReq struct {
	EventID string `json:"event_id"`
	Type    string `json:"type"`
	// CreatedAt 用 json.Number 保留客户端的字面形态：内容签名（§3.4）要按客户端所签的字节重建。
	CreatedAt json.Number     `json:"created_at"`
	Body      json.RawMessage `json:"body"`
	Sig       string          `json:"sig"`
}

// handleEventPost 按类型分流：comment.v1 走正文落块 + 投影（§4.1），
// 其它已登记类型只落事件骨架。
func (s *Server) handleEventPost(w http.ResponseWriter, r *http.Request) {
	actor := identityFrom(r)
	var req eventReq
	if !s.decodeJSON(w, r, &req) {
		return
	}
	if _, ok := s.knownEventTypes[req.Type]; !ok {
		s.writeError(w, http.StatusBadRequest, "event_type_unknown")
		return
	}
	createdAt, err := req.CreatedAt.Int64()
	if err != nil || !isHexN(req.EventID, 16) || createdAt <= 0 {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	if !s.eventLimiterByID.allow(actor) || !s.eventLimiterByIP.allow(clientIP(r)) {
		s.writeAuthErr(w, http.StatusTooManyRequests, "event_rate_limited")
		return
	}
	switch req.Type {
	case "comment.v1":
		s.handleCommentEvent(w, actor, req, createdAt)
		return
	case "group.v1":
		s.handleGroupEvent(w, actor, req, createdAt)
		return
	case "dm.v1":
		s.handleDMEvent(w, actor, req, createdAt)
		return
	case "govern.v1":
		s.handleGovernEvent(w, actor, req, createdAt)
		return
	case "progress.v1":
		s.handleProgressEvent(w, actor, req, createdAt)
		return
	}
	s.putBareEvent(w, actor, req, createdAt)
}

// putBareEvent 落一个不带投影的事件骨架（已登记但本册子未定义语义的类型）。
func (s *Server) putBareEvent(w http.ResponseWriter, actor string, req eventReq, createdAt int64) {
	body := req.Body
	if len(body) == 0 {
		body = json.RawMessage(`{}`)
	}
	now := time.Now().UnixMilli()
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: actor, Type: req.Type,
		BodyJSON: string(body), CreatedAt: createdAt, ReceivedAt: now,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"event_id": req.EventID, "received_at": now})
}

// commentBody 是 comment.v1 的正文三字段（册子 §3.2）。
type commentBody struct {
	TargetID string
	Text     string
	ReplyTo  string
}

// handleCommentEvent 执行 §4.1 的 6 步：校验 body → 验内容签名 → 查墓碑 → 落块 → 落事件行 → 200。
func (s *Server) handleCommentEvent(w http.ResponseWriter, actor string, req eventReq, createdAt int64) {
	rawBody, cb, ok := parseCommentBody(req.Body)
	if !ok {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	if !s.verifyEventSig(w, actor, req, rawBody) {
		return
	}
	// 已审核删除的评论不允许再落（否则删块会被同一条重发复活）。
	revoked, err := s.st.IsRevokedEvent(req.EventID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if revoked {
		s.writeAuthErr(w, http.StatusBadRequest, "event_revoked")
		return
	}
	// 正文落块（§3.3）：必须在**验签通过之后**才算 id 并落盘。
	text := []byte(cb.Text)
	payloadCID := protocol.BlobID(text)
	exist, _, err := s.st.HasBlob(payloadCID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !exist {
		if err := s.st.PutBlob(payloadCID, text, "", 0); err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	// body_json 存减化形态，不含 text（正文只在块里存一份）。
	bodyJSON, err := protocol.Canonicalize(map[string]any{
		"target_id":   cb.TargetID,
		"payload_cid": payloadCID,
		"reply_to":    cb.ReplyTo,
		"sig":         req.Sig,
	})
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UnixMilli()
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: actor, Type: req.Type, BodyJSON: string(bodyJSON),
		CreatedAt: createdAt, ReceivedAt: now,
		TargetID: cb.TargetID, PayloadCID: payloadCID, ReplyTo: cb.ReplyTo,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 回读 received_at：同 event_id 重发时它是首次值，响应必须给权威值。
	if ev, ok, err := s.st.GetEventByID(req.EventID); err == nil && ok {
		now = ev.ReceivedAt
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"event_id": req.EventID, "payload_cid": payloadCID, "received_at": now,
	})
}

// verifyEventSig 校验事件归属签名：内容签名覆盖 canonical({event_id,type,created_at,body})，
// 与请求头无关，因此事件被反熵搬到别的节点后仍可独立验签（册子 §3.4）。失败时已写好响应。
func (s *Server) verifyEventSig(w http.ResponseWriter, actor string, req eventReq, rawBody map[string]any) bool {
	signBytes, err := protocol.Canonicalize(map[string]any{
		"event_id":   req.EventID,
		"type":       req.Type,
		"created_at": req.CreatedAt,
		"body":       rawBody,
	})
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return false
	}
	if !isHexN(req.Sig, 64) {
		s.writeAuthErr(w, http.StatusForbidden, "event_sig_invalid")
		return false
	}
	it, found, err := s.st.LookupIdentity(actor)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return false
	}
	if !found {
		s.writeAuthErr(w, http.StatusForbidden, "identity_unregistered")
		return false
	}
	valid, err := protocol.Verify(it.PubKey, signBytes, req.Sig)
	if err != nil || !valid {
		s.writeAuthErr(w, http.StatusForbidden, "event_sig_invalid")
		return false
	}
	return true
}

// parseCommentBody 校验 comment.v1 的 body；返回的 map 保留**客户端原始键集**——
// 缺 reply_to 时不得补空串，否则重建的待验字节与客户端所签不一致。
// 只看协议允许的键，多一个未知键即拒绝：防止「签了一份、存了另一份」。
func parseCommentBody(raw json.RawMessage) (map[string]any, commentBody, bool) {
	var cb commentBody
	if len(raw) == 0 {
		return nil, cb, false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, cb, false
	}
	for k := range m {
		switch k {
		case "target_id", "text", "reply_to":
		default:
			return nil, cb, false
		}
	}
	target, ok := m["target_id"].(string)
	if !ok || !validTargetID(target) {
		return nil, cb, false
	}
	text, ok := m["text"].(string)
	if !ok || len(text) == 0 || len(text) > maxCommentBytes {
		return nil, cb, false
	}
	reply, ok := m["reply_to"]
	if !ok {
		cb = commentBody{TargetID: target, Text: text}
		return m, cb, true
	}
	s, isStr := reply.(string)
	// reply_to 指向一条 event_id，故与 event_id 同形（16 字节 hex，见 §2.1 的准入口径）。
	if !isStr || !isHexN(s, 16) {
		return nil, cb, false
	}
	cb = commentBody{TargetID: target, Text: text, ReplyTo: s}
	return m, cb, true
}

// validTargetID 校验路径式命名空间（总纲 §6.0）：ASCII、1..256 字节。
func validTargetID(s string) bool {
	if len(s) == 0 || len(s) > 256 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}
