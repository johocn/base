package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

const (
	// maxDMCipherBytes 是单条私信密文的字节上限（与 maxGroupCipherBytes 同量级）；
	// 明文上限 4096 字节由客户端自己拦，节点只看密文长度、不解密、不推断（册子 §3.3）。
	maxDMCipherBytes = 8192
	// 读接口分页口径与 GET /v1/comment 逐字一致（册子 §4.2）。
	dmDefaultLimit = 30
	dmMaxLimit     = 100
)

type dmMsg struct {
	To         string
	TextCipher string
}

// parseDMBody 校验 dm.v1 的 body（册子 §3.3）：**只有两个键**，多一个未知键即拒
// （重建的待验字节必须与客户端所签一致）。返回的 map 保留客户端原始键集供验签重建。
func parseDMBody(raw json.RawMessage) (map[string]any, dmMsg, bool) {
	if len(raw) == 0 {
		return nil, dmMsg{}, false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, dmMsg{}, false
	}
	for k := range m {
		switch k {
		case "to", "text_cipher":
		default:
			return nil, dmMsg{}, false
		}
	}
	var d dmMsg
	d.To, _ = m["to"].(string)
	// 收件人是身份 id：32 hex。isHexN 的第二参是**字节数**，16 字节 = 32 hex（册子补充 9）。
	if !isHexN(d.To, 16) {
		return nil, dmMsg{}, false
	}
	d.TextCipher, _ = m["text_cipher"].(string)
	if len(d.TextCipher) == 0 || len(d.TextCipher) > maxDMCipherBytes {
		return nil, dmMsg{}, false
	}
	return m, d, true
}

// handleDMEvent 执行册子 §3.3：校验 body → 验内容签名 → 落块 → 落事件行。
// **不做墓碑检查**（② 类不可审，总纲 §12 第 9 条），**不校验 to 是否已登记身份**。
func (s *Server) handleDMEvent(w http.ResponseWriter, actor string, req eventReq, createdAt int64) {
	rawBody, d, ok := parseDMBody(req.Body)
	if !ok {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	if !s.verifyEventSig(w, actor, req, rawBody) {
		return
	}
	// 落块必须在**验签通过之后**（与 handleCommentEvent / putGroupMessage 同一次序）
	cipher := []byte(d.TextCipher)
	payloadCID := protocol.BlobID(cipher)
	exist, _, err := s.st.HasBlob(payloadCID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !exist {
		if err := s.st.PutBlob(payloadCID, cipher, "", 0); err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	// body_json 减化为 canonical({to, payload_cid})：密文只在块里存一份（与 comment / group 同构）
	bodyJSON, err := protocol.Canonicalize(map[string]any{"to": d.To, "payload_cid": payloadCID})
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UnixMilli()
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: actor, Type: req.Type, BodyJSON: string(bodyJSON),
		CreatedAt: createdAt, ReceivedAt: now,
		TargetID: "dm/" + d.To, PayloadCID: payloadCID,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 回读 received_at：同 event_id 重发时它是首次值，响应必须给权威值
	if ev, ok, err := s.st.GetEventByID(req.EventID); err == nil && ok {
		now = ev.ReceivedAt
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"event_id": req.EventID, "payload_cid": payloadCID, "received_at": now,
	})
}

type dmEventDTO struct {
	EventID    string `json:"event_id"`
	Actor      string `json:"actor"`
	CreatedAt  int64  `json:"created_at"`
	PayloadCID string `json:"payload_cid"`
}

type dmResponse struct {
	Events     []dmEventDTO `json:"events"`
	NextCursor *string      `json:"next_cursor"`
}

// handleDMGet 匿名分页读「所有人发给 peer_id 的私信索引」（册子 §4.2）。
// 正文一律另取 GET /v1/blob/{payload_cid}（密文，节点不解释）。
// **无 404 分支**：私信没有投影表，查无数据即 {"events": [], "next_cursor": null}。
func (s *Server) handleDMGet(w http.ResponseWriter, r *http.Request) {
	peerID := r.PathValue("peer_id")
	if !isHexN(peerID, 16) {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	q := r.URL.Query()
	limit := dmDefaultLimit
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= dmMaxLimit {
			limit = n
		}
	}
	curTS, curID := parseCommentCursor(q.Get("cursor")) // 同一套不透明游标 <created_at>_<event_id>
	rows, err := s.st.ListDMEvents(peerID, curTS, curID, limit)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := dmResponse{Events: []dmEventDTO{}}
	for _, e := range rows {
		resp.Events = append(resp.Events, dmEventDTO{
			EventID: e.EventID, Actor: e.ID, CreatedAt: e.CreatedAt, PayloadCID: e.PayloadCID,
		})
	}
	// 满页才给游标：与 GET /v1/comment 同口径
	if len(rows) == limit {
		last := rows[len(rows)-1]
		next := strconv.FormatInt(last.CreatedAt, 10) + "_" + last.EventID
		resp.NextCursor = &next
	}
	s.writeJSON(w, http.StatusOK, resp)
}
