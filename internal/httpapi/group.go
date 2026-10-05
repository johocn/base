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

// roster v2 的六个子类型（册子 §3.4 / §3.6）。
const (
	subRename   = "rename"
	subRotate   = "rotate"
	subLeave    = "leave"
	subJoin     = "join"
	subRemove   = "remove"
	subDissolve = "dissolve"
)

// rosterApprovalDomain 是多签的签名域（册子 §3.4；补充 4）。
const rosterApprovalDomain = "base/group-roster-v2"

// maxRosterSigs 是单条 roster 事件的签名条数上限（防一条事件塞进超大数组）。
const maxRosterSigs = 256

// maxRosterEnvelopes 是信封条数上限，与 historialKeys 的 32 epoch 上限同量级。
const maxRosterEnvelopes = 32

// groupApproval 是 sigs[] 的一项。
type groupApproval struct {
	ID  string
	Sig string
}

// groupRosterV2 是 v2 名单体（册子 §3.4）。
type groupRosterV2 struct {
	GroupID   string
	Sub       string
	Epoch     int64
	RosterRev int64
	Encrypted int64
	MemberIDs []string
	Name      string
	Sigs      []groupApproval
	Envelopes string // 存 {"envelopes":[...]} 的 canonical 文本，节点不解释
}

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
	// Encrypted 是圈子形态（0 开放 / 1 封闭）；body 缺该键时缺省 1（补充 16）。
	Encrypted int64
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
		// v2 与 v1 的分流判据 = body 里有没有 `sigs` 键（补充 1）：带 ⇒ 多签路径，不带 ⇒ owner 锁路径。
		if _, isV2 := m["sigs"]; isV2 {
			for k := range m {
				switch k {
				case "group_id", "action", "sub", "epoch", "roster_rev", "member_ids",
					"name", "encrypted", "sigs", "envelopes":
				default:
					return nil, "", false
				}
			}
			if _, ok := parseGroupRosterV2(m); !ok {
				return nil, "", false
			}
			return m, "roster_v2", true
		}
		for k := range m {
			switch k {
			case "group_id", "action", "epoch", "member_ids", "name", "encrypted":
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
// `encrypted` 可选，缺省 1（补充 16）；形态在建圈时定死。
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
	r.Encrypted = 1 // 缺省封闭（老客户端语义不变，AC 13）
	if v, present := m["encrypted"]; present {
		enc, ok := jsonInt(v)
		if !ok || (enc != 0 && enc != 1) {
			return r, false
		}
		r.Encrypted = enc
	}
	return r, true
}

// parseGroupRosterV2 解析 v2 名单体（册子 §3.4）。键集严格；`sub` 必须在六值枚举内；
// `sigs` 1..maxRosterSigs 条且每条 id 为 32 hex、sig 为 64 hex。
// `member_ids` 常态 1..maxGroupMembers；只有 `sub=dissolve` 允许空数组（补充 11 把名单清空）。
func parseGroupRosterV2(m map[string]any) (groupRosterV2, bool) {
	var r groupRosterV2
	r.GroupID, _ = m["group_id"].(string)
	if !isHexN(r.GroupID, 16) {
		return r, false
	}
	r.Sub, _ = m["sub"].(string)
	switch r.Sub {
	case subRename, subRotate, subLeave, subJoin, subRemove, subDissolve:
	default:
		return r, false
	}
	epoch, ok := jsonInt(m["epoch"])
	if !ok || epoch < 1 {
		return r, false
	}
	r.Epoch = epoch
	rev, ok := jsonInt(m["roster_rev"])
	if !ok || rev < 1 {
		return r, false
	}
	r.RosterRev = rev
	enc, ok := jsonInt(m["encrypted"])
	if !ok || (enc != 0 && enc != 1) {
		return r, false
	}
	r.Encrypted = enc
	items, ok := m["member_ids"].([]any)
	if !ok || len(items) > maxGroupMembers {
		return r, false
	}
	if len(items) == 0 && r.Sub != subDissolve {
		return r, false
	}
	r.MemberIDs = make([]string, 0, len(items))
	for _, it := range items {
		s, isStr := it.(string)
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
	sigs, ok := m["sigs"].([]any)
	if !ok || len(sigs) == 0 || len(sigs) > maxRosterSigs {
		return r, false
	}
	r.Sigs = make([]groupApproval, 0, len(sigs))
	for _, it := range sigs {
		obj, isObj := it.(map[string]any)
		if !isObj {
			return r, false
		}
		id, idOK := obj["id"].(string)
		sig, sigOK := obj["sig"].(string)
		if !idOK || !sigOK || !isHexN(id, 16) || !isHexN(sig, 64) || len(obj) != 2 {
			return r, false
		}
		r.Sigs = append(r.Sigs, groupApproval{ID: id, Sig: sig})
	}
	if v, present := m["envelopes"]; present {
		arr, isArr := v.([]any)
		if !isArr || len(arr) > maxRosterEnvelopes {
			return r, false
		}
		for _, it := range arr {
			obj, isObj := it.(map[string]any)
			if !isObj || len(obj) != 2 {
				return r, false
			}
			if _, ok := obj["from_epoch"]; !ok {
				return r, false
			}
			cipher, ok := obj["cipher"].(string)
			if !ok || len(cipher) == 0 || len(cipher) > maxGroupCipherBytes {
				return r, false
			}
		}
		raw, err := protocol.Canonicalize(map[string]any{"envelopes": arr})
		if err != nil {
			return r, false
		}
		r.Envelopes = string(raw) // 读接口 Task 3 就这么解 key_envelopes 列，别改成裸数组
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
	case "roster_v2":
		s.handleGroupRosterV2(w, actor, req, rawBody, createdAt)
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
		Encrypted: r.Encrypted, MemberIDsJSON: string(membersJSON), EventID: req.EventID,
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

// handleGroupRosterV2 是 v2 名单事件的入口（册子 §3.4）。
// 次序：解析 → 验内容签名（发起者自己）→ 重建多签载荷 → 逐条验签去重 → 门槛判定 → 写库 → 落事件行。
func (s *Server) handleGroupRosterV2(w http.ResponseWriter, actor string, req eventReq, raw map[string]any, createdAt int64) {
	r, _ := parseGroupRosterV2(raw)
	if r.Sub == subJoin {
		// 封闭圈不接受自加入（补充 9）：先看本地形态，再决定放行或拒绝。
		cur, found, err := s.st.GetGroup(r.GroupID)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if (found && cur.Encrypted == 1) || (!found && r.Encrypted == 1) {
			s.writeAuthErr(w, http.StatusForbidden, "group_invite_required")
			return
		}
	}
	payload, err := rosterApprovalPayload(r, req.EventID, createdAt)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	signers, ok := s.verifyRosterApprovals(w, r.Sigs, payload)
	if !ok {
		return
	}
	cur, found, err := s.st.GetGroup(r.GroupID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if found && r.Epoch <= cur.Epoch {
		s.writeAuthErr(w, http.StatusConflict, "group_roster_epoch_stale")
		return
	}
	creatorID := actor
	var memberIDs []string
	var rosterRev int64
	if found {
		if err := json.Unmarshal([]byte(cur.MemberIDsJSON), &memberIDs); err != nil {
			memberIDs = []string{}
		}
		creatorID = cur.CreatorID
		rosterRev = cur.RosterRev
	}
	events, err := s.st.ListGroupMsgEvents(r.GroupID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	seats := store.DeriveSeats(memberIDs, creatorID, rosterRev, r.Epoch, events)
	// Spec v2 §6: 圈内 V2 动态门槛参数。
	// mCircle = 变更前的圈内成员数（memberIDs 是变更前的 current 或新 r.MemberIDs？
	//   seat.Decidable 已用 memberIDs 算好席位门槛，这里沿用同一口径 = len(memberIDs)）。
	mCircle := len(memberIDs)
	// pCircle = 圈内 msg 事件的独立 actor 数（只计 action=msg 的去重参与者，代表圈内互动度）。
	pCircleSet := map[string]bool{}
	for _, ev := range events {
		if store.GroupBodyAction(ev.BodyJSON) == "msg" {
			pCircleSet[ev.ID] = true
		}
	}
	pCircle := len(pCircleSet)
	// fCircle = 0：圈 msg 事件不进 items 表，没有 progress / favorites 概念。
	fCircle := 0
	if code := rosterQuorumError(actor, r, signers, ciSet(memberIDs), govSet(seats.Governors), seats, mCircle, pCircle, fCircle); code != "" {
		s.writeAuthErr(w, http.StatusForbidden, code)
		return
	}
	membersJSON, err := json.Marshal(r.MemberIDs)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.st.PutGroupRosterV2(store.GroupRoster{
		GroupID: r.GroupID, CreatorID: creatorID, Epoch: r.Epoch, RosterRev: r.RosterRev,
		Encrypted: r.Encrypted, MemberIDsJSON: string(membersJSON),
		KeyEnvelopesJSON: r.Envelopes, EventID: req.EventID,
	}); err != nil {
		switch {
		case errors.Is(err, store.ErrGroupEpochStale):
			s.writeAuthErr(w, http.StatusConflict, "group_roster_epoch_stale")
		case errors.Is(err, store.ErrGroupRosterRevStale):
			s.writeAuthErr(w, http.StatusConflict, "group_roster_epoch_stale")
		case errors.Is(err, store.ErrGroupFormLocked):
			s.writeAuthErr(w, http.StatusBadRequest, "event_param_invalid")
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

// rosterApprovalPayload 重建多签待签载荷（补充 4）：**不信客户端给的字节**，由节点自己拼。
func rosterApprovalPayload(r groupRosterV2, eventID string, createdAt int64) ([]byte, error) {
	f := map[string]any{
		"domain":     rosterApprovalDomain,
		"event_id":   eventID,
		"group_id":   r.GroupID,
		"action":     "roster",
		"sub":        r.Sub,
		"epoch":      r.Epoch,
		"roster_rev": r.RosterRev,
		"member_ids": r.MemberIDs,
		"encrypted":  r.Encrypted,
		"created_at": createdAt,
	}
	if r.Name != "" {
		f["name"] = r.Name
	}
	return protocol.Canonicalize(f)
}

// verifyRosterApprovals 逐条验签并按 id 去重（保留首条）。任一条坏即整条拒收（补充 5）。
func (s *Server) verifyRosterApprovals(w http.ResponseWriter, sigs []groupApproval, payload []byte) (map[string]bool, bool) {
	out := make(map[string]bool, len(sigs))
	for _, a := range sigs {
		if out[a.ID] {
			continue
		}
		it, found, err := s.st.LookupIdentity(a.ID)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return nil, false
		}
		if !found {
			s.writeAuthErr(w, http.StatusForbidden, "identity_unregistered")
			return nil, false
		}
		valid, err := protocol.Verify(it.PubKey, payload, a.Sig)
		if err != nil || !valid {
			s.writeAuthErr(w, http.StatusForbidden, "event_sig_invalid")
			return nil, false
		}
		out[a.ID] = true
	}
	return out, true
}

// ciSet / govSet 把名单切片摊成集合。
func ciSet(ids []string) map[string]bool {
	m := make(map[string]bool, len(ids))
	for _, id := range ids {
		m[id] = true
	}
	return m
}
func govSet(ids []string) map[string]bool { return ciSet(ids) }

// countIn 数签名者里落在集合内的个数。
func countIn(signers, set map[string]bool) int {
	n := 0
	for id := range signers {
		if set[id] {
			n++
		}
	}
	return n
}

// subsetOf 判 signers 是否全部属于 set。
func subsetOf(signers, set map[string]bool) bool {
	for id := range signers {
		if !set[id] {
			return false
		}
	}
	return true
}

// rosterQuorumError 按 sub 判定门槛，返回要回的错误码；"" 表示通过（册子 §3.4 + Spec v2 §6）。
// actor 是本次事件的发起者（join 档要求签名者集合恒等于 {actor}，补充 9）。
// mCircle / pCircle / fCircle 是圈内 V2 动态门槛参数（成员数 / msg 独立 actor 数 / 圈 msg 收藏数 = 0）。
func rosterQuorumError(actor string, r groupRosterV2, signers, members, governors map[string]bool, seats store.SeatSnapshot, mCircle, pCircle, fCircle int) string {
	k := seats.SeatCount
	switch r.Sub {
	case subJoin:
		// 开放圈自加入：签名者集合恒等于 {自己}（补充 9）。
		if len(signers) != 1 || !signers[actor] || r.Encrypted != 0 {
			return "group_roster_quorum_missing"
		}
		return ""
	case subRename, subRotate, subLeave:
		// 低风险（直权）：任一治者 1 签；签名者必须全是治者。
		if !subsetOf(signers, governors) || countIn(signers, governors) < 1 {
			return "group_roster_quorum_missing"
		}
		return ""
	case subRemove:
		if !seats.Decidable {
			return "group_roster_quorum_missing" // 不可判定 ⇒ 拒写重大动作（补充 6）
		}
		// Spec v2 §6: 用 V2 base 门槛公式，结果再按治者数裁切——治者是唯一能签名的池，
		// quorum 不可能超过 k。GovernQuorum 有 ⌈m/2⌉ 下限，大圈时可能 > k，需要裁切。
		q := store.RemoveQuorumV2(mCircle, pCircle, fCircle)
		if q > k {
			q = k
		}
		if !subsetOf(signers, governors) || countIn(signers, governors) < q {
			return "group_roster_quorum_missing"
		}
		return ""
	case subDissolve:
		if !seats.Decidable {
			return "group_roster_quorum_missing"
		}
		if !subsetOf(signers, members) {
			return "group_roster_quorum_missing"
		}
		if countIn(signers, governors) < store.DissolveProposerQuorum(k) {
			return "group_proposal_proposer_missing" // 发起段不足（册子 §6）
		}
		// Spec v2 §6: V2 enhanced 动态门槛。签名池是**全成员**（dissolve 允许非治者成员签名），
		// GovernQuorum 已经裁切到 mCircle，不需要额外裁切。
		q := store.DissolveVoteQuorumV2(mCircle, pCircle, fCircle)
		if countIn(signers, members) < q {
			return "group_roster_quorum_missing"
		}
		return ""
	}
	return "group_roster_quorum_missing"
}

type groupDTO struct {
	GroupID   string   `json:"group_id"`
	CreatorID string   `json:"creator_id"`
	Epoch     int64    `json:"epoch"`
	RosterRev int64    `json:"roster_rev"`
	Encrypted int64    `json:"encrypted"`
	MemberIDs []string `json:"member_ids"`
	Name      string   `json:"name"`
	// 以下三项是节点侧只读派生（补充 2）：客户端**不自己排名**，避免名次漂移。
	SeatCount int      `json:"seat_count"`
	Governors []string `json:"governors"`
	// envelopes 是密文（补充 3 / 12），公开返回无害——非成员没有旧钥，解不出任何东西。
	Envelopes []json.RawMessage `json:"envelopes"`
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

// handleGroupGet 分页读小组索引与当前名单（册子 §4.3 / §3.7）。
// 形态分支：开放圈匿名可读；封闭圈需成员签名读权，非成员一律 404（不泄露存在性）。
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
	actor := identityFrom(r) // 匿名时为空串（optionalAuth 未注入身份）
	members := []string{}
	if err := json.Unmarshal([]byte(g.MemberIDsJSON), &members); err != nil {
		members = []string{} // 投影损坏不该让整页 500：名单退化为空
	}
	// 形态分支（册子 §3.7）：开放圈匿名放行；封闭圈需成员签名读权；非成员一律 404（不泄露存在性）。
	if g.Encrypted == 1 && len(members) > 0 && !memberOf(members, actor) {
		s.writeAuthErr(w, http.StatusNotFound, "group_read_denied")
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
	events, err := s.st.ListGroupMsgEvents(groupID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	seats := store.DeriveSeats(members, g.CreatorID, g.RosterRev, g.Epoch, events)
	resp := groupResponse{
		Group: groupDTO{
			GroupID: g.GroupID, CreatorID: g.CreatorID, Epoch: g.Epoch, RosterRev: g.RosterRev,
			Encrypted: g.Encrypted, MemberIDs: members, Name: groupName(s, g.EventID),
			SeatCount: seats.SeatCount, Governors: seats.Governors, Envelopes: []json.RawMessage{},
		},
		Events: []groupEventDTO{},
	}
	if g.KeyEnvelopesJSON != "" && g.KeyEnvelopesJSON != "[]" {
		var wrap struct {
			Envelopes []json.RawMessage `json:"envelopes"`
		}
		if err := json.Unmarshal([]byte(g.KeyEnvelopesJSON), &wrap); err == nil {
			resp.Group.Envelopes = wrap.Envelopes
		}
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

// memberOf 判 id 是否在名单里；actor 为空（匿名）恒 false。
func memberOf(members []string, actor string) bool {
	if actor == "" {
		return false
	}
	for _, m := range members {
		if m == actor {
			return true
		}
	}
	return false
}
