package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

const (
	// maxGroupCipherBytes 是单条发言密文的字节上限（与 maxCommentBytes 同量级，
	// 明文上限由客户端自己把握；节点只看密文长度，不解密、不推断）。
	maxGroupCipherBytes = 8192
	// maxGroupMembers 是名单快照的成员数上限，防一条事件塞进超大数组。
	maxGroupMembers = 200
	// 读接口分页口径与 GET /v1/comment 逐字一致（册子 §4.3）。
	groupDefaultLimit = 30
	groupMaxLimit     = 100
)

type groupMsg struct {
	GroupID    string
	Epoch      int64
	TextCipher string
	ReplyTo    string
}

type groupRoster struct {
	GroupID   string
	Epoch     int64
	MemberIDs []string
	Name      string
}

// parseGroupBody 校验 group.v1 的 body（册子 §3.4）。返回的 map 保留**客户端原始键集**——
// 与 parseCommentBody 同一取舍：重建的待验字节必须与客户端所签一致，多一个未知键即拒。
// 两个 action 的键集互不兼容（msg 不许带 member_ids，roster 不许带 text_cipher）。
func parseGroupBody(raw json.RawMessage) (map[string]any, string, bool) {
	if len(raw) == 0 {
		return nil, "", false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, "", false
	}
	action, ok := m["action"].(string)
	if !ok {
		return nil, "", false
	}
	switch action {
	case "msg":
		for k := range m {
			switch k {
			case "group_id", "action", "epoch", "text_cipher", "reply_to":
			default:
				return nil, "", false
			}
		}
		if _, ok := parseGroupMsg(m); !ok {
			return nil, "", false
		}
	case "roster":
		for k := range m {
			switch k {
			case "group_id", "action", "epoch", "member_ids", "name":
			default:
				return nil, "", false
			}
		}
		if _, ok := parseGroupRoster(m); !ok {
			return nil, "", false
		}
	default:
		return nil, "", false
	}
	return m, action, true
}

// parseGroupMsg 解析 msg 分支；缺 reply_to 不补空串（保持客户端原始键集，供验签重建）。
func parseGroupMsg(m map[string]any) (groupMsg, bool) {
	var g groupMsg
	g.GroupID, _ = m["group_id"].(string)
	if !isHexN(g.GroupID, 16) {
		return g, false
	}
	epoch, ok := jsonInt(m["epoch"])
	if !ok || epoch < 1 {
		return g, false
	}
	g.Epoch = epoch
	g.TextCipher, ok = m["text_cipher"].(string)
	if !ok || len(g.TextCipher) == 0 || len(g.TextCipher) > maxGroupCipherBytes {
		return g, false
	}
	if v, present := m["reply_to"]; present {
		s, isStr := v.(string)
		if !isStr || !isHexN(s, 16) {
			return g, false
		}
		g.ReplyTo = s
	}
	return g, true
}

// parseGroupRoster 解析 roster 分支（册子 §3.4 B）：完整快照，成员 1..maxGroupMembers 个。
func parseGroupRoster(m map[string]any) (groupRoster, bool) {
	var r groupRoster
	r.GroupID, _ = m["group_id"].(string)
	if !isHexN(r.GroupID, 16) {
		return r, false
	}
	epoch, ok := jsonInt(m["epoch"])
	if !ok || epoch < 1 {
		return r, false
	}
	r.Epoch = epoch
	items, ok := m["member_ids"].([]any)
	if !ok || len(items) == 0 || len(items) > maxGroupMembers {
		return r, false
	}
	r.MemberIDs = make([]string, 0, len(items))
	for _, it := range items {
		s, isStr := it.(string)
		// 成员是身份 id：sha256(pubkey)[0:32] = 32 hex（与 protocol.IsIdentityID 同形）。
		if !isStr || !isHexN(s, 16) {
			return r, false
		}
		r.MemberIDs = append(r.MemberIDs, s)
	}
	if v, present := m["name"]; present {
		s, isStr := v.(string)
		if !isStr || len(s) > 64 {
			return r, false
		}
		r.Name = s
	}
	return r, true
}

// jsonInt 把 body 里的数字读成 int64。json.Unmarshal 到 any 得到 float64，
// 但经 protocol.Canonicalize 往返后可能变成 json.Number，故两者都认。
func jsonInt(v any) (int64, bool) {
	switch n := v.(type) {
	case float64:
		if n != float64(int64(n)) {
			return 0, false
		}
		return int64(n), true
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	}
	return 0, false
}

// handleGroupEvent 执行册子 §4.1：校验 body → 验内容签名 → 按 action 分流。
// 与 handleCommentEvent 共用同一条验签管线；**不做墓碑检查**——② 类不可审（总纲 §12 第 9 条）。
func (s *Server) handleGroupEvent(w http.ResponseWriter, actor string, req eventReq, createdAt int64) {
	rawBody, action, ok := parseGroupBody(req.Body)
	if !ok {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	if !s.verifyEventSig(w, actor, req, rawBody) {
		return
	}
	switch action {
	case "msg":
		s.putGroupMessage(w, actor, req, rawBody, createdAt)
	case "roster":
		s.putGroupRoster(w, actor, req, rawBody, createdAt)
	}
}

// putGroupMessage 落 ② 类密文块与事件行（册子 §3.4 A）。节点的处理到此为止：
// 不解密、不索引明文、不审核。body_json 减化为 canonical({group_id,action,epoch,payload_cid,reply_to})，
// 密文只在块里存一份（与 comment.v1 同构）。
func (s *Server) putGroupMessage(w http.ResponseWriter, actor string, req eventReq, raw map[string]any, createdAt int64) {
	g, _ := parseGroupMsg(raw)
	cipher := []byte(g.TextCipher)
	payloadCID := protocol.BlobID(cipher) // 先定密文、再算 id（总纲 §3.2）
	exist, _, err := s.st.HasBlob(payloadCID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !exist {
		// 落块必须在**验签通过之后**（与 handleCommentEvent 同一次序）
		if err := s.st.PutBlob(payloadCID, cipher, "", 0); err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	reduced := map[string]any{
		"group_id": g.GroupID, "action": "msg", "epoch": g.Epoch, "payload_cid": payloadCID,
	}
	if g.ReplyTo != "" {
		reduced["reply_to"] = g.ReplyTo
	}
	bodyJSON, err := protocol.Canonicalize(reduced)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UnixMilli()
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: actor, Type: req.Type, BodyJSON: string(bodyJSON),
		CreatedAt: createdAt, ReceivedAt: now,
		TargetID: "group/" + g.GroupID, PayloadCID: payloadCID, ReplyTo: g.ReplyTo,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if ev, ok, err := s.st.GetEventByID(req.EventID); err == nil && ok {
		now = ev.ReceivedAt // 同 event_id 重发时给权威值（与 comment 口径一致）
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"event_id": req.EventID, "payload_cid": payloadCID, "received_at": now,
	})
}

// putGroupRoster 落名单投影与事件行（册子 §3.4 B）。语义是**完整快照覆盖**，不做增量合并。
// 先写投影（校验失败即返回、不留半态），再落事件行；事件行的 body_json 保留**客户端原始键集**
// （组名 name 在它里面，读接口据此回 name）。
func (s *Server) putGroupRoster(w http.ResponseWriter, actor string, req eventReq, raw map[string]any, createdAt int64) {
	r, _ := parseGroupRoster(raw)
	membersJSON, err := json.Marshal(r.MemberIDs)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.st.PutGroupRoster(store.GroupRoster{
		GroupID: r.GroupID, CreatorID: actor, Epoch: r.Epoch,
		MemberIDsJSON: string(membersJSON), EventID: req.EventID,
	}); err != nil {
		switch {
		case errors.Is(err, store.ErrGroupOwnerMismatch):
			s.writeAuthErr(w, http.StatusForbidden, "group_owner_mismatch")
		case errors.Is(err, store.ErrGroupEpochStale):
			s.writeAuthErr(w, http.StatusConflict, "group_epoch_stale")
		default:
			s.writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	bodyJSON, err := protocol.Canonicalize(raw)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UnixMilli()
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: actor, Type: req.Type, BodyJSON: string(bodyJSON),
		CreatedAt: createdAt, ReceivedAt: now, TargetID: "group/" + r.GroupID,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if ev, ok, err := s.st.GetEventByID(req.EventID); err == nil && ok {
		now = ev.ReceivedAt
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"event_id": req.EventID, "received_at": now})
}

type groupDTO struct {
	GroupID   string   `json:"group_id"`
	CreatorID string   `json:"creator_id"`
	Epoch     int64    `json:"epoch"`
	MemberIDs []string `json:"member_ids"`
	Name      string   `json:"name"`
}

type groupEventDTO struct {
	EventID    string  `json:"event_id"`
	Actor      string  `json:"actor"`
	CreatedAt  int64   `json:"created_at"`
	PayloadCID string  `json:"payload_cid"`
	Epoch      int64   `json:"epoch"`
	Action     string  `json:"action"`
	ReplyTo    *string `json:"reply_to"`
}

type groupResponse struct {
	Group      groupDTO        `json:"group"`
	Events     []groupEventDTO `json:"events"`
	NextCursor *string         `json:"next_cursor"`
}

// handleGroupGet 匿名分页读小组索引与当前名单（册子 §4.3）。
// 正文一律另取 GET /v1/blob/{payload_cid}（密文，节点不解释）。
func (s *Server) handleGroupGet(w http.ResponseWriter, r *http.Request) {
	groupID := r.PathValue("group_id")
	if !isHexN(groupID, 16) {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	g, found, err := s.st.GetGroup(groupID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !found {
		// 尚无任何 roster 事件（册子 §4.3）；带 code 供客户端分流
		s.writeAuthErr(w, http.StatusNotFound, "group_not_found")
		return
	}
	q := r.URL.Query()
	limit := groupDefaultLimit
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= groupMaxLimit {
			limit = n
		}
	}
	curTS, curID := parseCommentCursor(q.Get("cursor")) // 同一套不透明游标 <created_at>_<event_id>
	rows, err := s.st.ListGroupEvents(groupID, curTS, curID, limit)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := groupResponse{
		Group:  groupDTO{GroupID: g.GroupID, CreatorID: g.CreatorID, Epoch: g.Epoch, MemberIDs: []string{}, Name: groupName(s, g.EventID)},
		Events: []groupEventDTO{},
	}
	if err := json.Unmarshal([]byte(g.MemberIDsJSON), &resp.Group.MemberIDs); err != nil {
		resp.Group.MemberIDs = []string{} // 投影损坏不该让整页 500：名单退化为空
	}
	for _, e := range rows {
		// 名单事件不进会话流（已由 group 字段表达），只列 action=msg
		var b struct {
			Action     string `json:"action"`
			Epoch      int64  `json:"epoch"`
			PayloadCID string `json:"payload_cid"`
			ReplyTo    string `json:"reply_to"`
		}
		if err := json.Unmarshal([]byte(e.BodyJSON), &b); err != nil || b.Action != "msg" {
			continue
		}
		dto := groupEventDTO{
			EventID: e.EventID, Actor: e.ID, CreatedAt: e.CreatedAt,
			PayloadCID: b.PayloadCID, Epoch: b.Epoch, Action: b.Action,
		}
		if b.ReplyTo != "" {
			reply := b.ReplyTo
			dto.ReplyTo = &reply
		}
		resp.Events = append(resp.Events, dto)
	}
	// 满页才给游标：与 GET /v1/comment 同口径
	if len(rows) == limit {
		last := rows[len(rows)-1]
		next := strconv.FormatInt(last.CreatedAt, 10) + "_" + last.EventID
		resp.NextCursor = &next
	}
	s.writeJSON(w, http.StatusOK, resp)
}

// groupName 从最新一条 roster 事件的 body_json 里取组名；事件缺失或没名字一律空串。
// 为什么绕这一下：groups 表刻意不存 name（它只是「名单 + epoch」的投影），
// 组名是客户端内容，留在事件的原始 body 里。
func groupName(s *Server, eventID string) string {
	ev, ok, err := s.st.GetEventByID(eventID)
	if err != nil || !ok {
		return ""
	}
	var b struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal([]byte(ev.BodyJSON), &b); err != nil {
		return ""
	}
	return b.Name
}
