package httpapi

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/johocn/base/internal/store"
)

// governProposalKeys / governVoteKeys 是两档严格键集（册子 §4.2）。多一个未知键即拒——
// `verifyEventSig` 会把 body **原样** canonicalize，签的与存的不一致就是漏洞（同 parseCommentBody 口径）。
var governProposalKeys = map[string]struct{}{
	"action": {}, "proposal_id": {}, "target_item_id": {}, "verb": {}, "content_hash": {},
	"content_version": {}, "revoked_rev": {}, "reason": {}, "title": {}, "body_md": {},
}

var governVoteKeys = map[string]struct{}{
	"action": {}, "proposal_id": {}, "choice": {},
}

// onlyKeys 判 m 的键是否全在允许集内。
func onlyKeys(m map[string]any, allowed map[string]struct{}) bool {
	for k := range m {
		if _, ok := allowed[k]; !ok {
			return false
		}
	}
	return true
}

// anyString 取 body 里的字符串值；JSON 数字与字符串都容忍（缺省空串）。
// `proposal_id` / `content_version` / `revoked_rev` 可能被不同客户端写成数字或字符串。
func anyString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case json.Number:
		return t.String()
	case float64:
		return strconv.FormatInt(int64(t), 10)
	}
	return ""
}

// parseGovernBody 校验 govern.v1 的 body（册子 §4.2），返回**客户端原始键集**的 map（供验签重建）。
// action=proposal 键集：{action, proposal_id, target_item_id, verb, content_hash, content_version,
//
//	revoked_rev, reason?, title?, body_md?}
//
// action=vote     键集：{action, proposal_id, choice}
func parseGovernBody(raw json.RawMessage) (map[string]any, string, bool) {
	if len(raw) == 0 {
		return nil, "", false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, "", false
	}
	action, _ := m["action"].(string)
	switch action {
	case "proposal":
		if !onlyKeys(m, governProposalKeys) {
			return nil, "", false
		}
		if _, ok := parseProposalID(anyString(m["proposal_id"])); !ok {
			return nil, "", false
		}
		if !validTargetID(anyString(m["target_item_id"])) {
			return nil, "", false
		}
		if !validProposalAction(anyString(m["verb"])) { // remove / edit / revive 三值枚举
			return nil, "", false
		}
		if !isHexNonEmptyEven(anyString(m["content_hash"])) {
			return nil, "", false
		}
		for _, k := range []string{"content_version", "revoked_rev"} {
			n, ok := jsonInt(m[k])
			if !ok || n < 0 {
				return nil, "", false
			}
		}
		if s, present := m["reason"]; present {
			if _, ok := validProposalReason(anyString(s)); !ok {
				return nil, "", false // 「已给定」却不合规要拒（与 handleProposalPost 同口径）
			}
		}
		if s, present := m["title"]; present && !validItemTitle(anyString(s)) {
			return nil, "", false
		}
		if s, present := m["body_md"]; present {
			if _, isStr := s.(string); !isStr {
				return nil, "", false
			}
		}
		return m, action, true
	case "vote":
		if !onlyKeys(m, governVoteKeys) {
			return nil, "", false
		}
		if _, ok := parseProposalID(anyString(m["proposal_id"])); !ok {
			return nil, "", false
		}
		// 册子 §4.2 只写「choice」未定枚举值 ⇒ 本计划按「1..16 字节 ASCII 非空短串」放行，
		// 语义收敛后只改这一处（补充 18）。
		choice := anyString(m["choice"])
		if len(choice) < 1 || len(choice) > 16 {
			return nil, "", false
		}
		for i := 0; i < len(choice); i++ {
			if choice[i] >= 0x80 {
				return nil, "", false
			}
		}
		return m, action, true
	}
	return nil, "", false
}

// handleGovernEvent 与 handleCommentEvent 共用同一条验签管线（event.go 的 verifyEventSig），
// 验签通过后按 action 投影（册子 §4.2）；**不做墓碑检查**（治理事件不是内容）。
// **投影失败不拒事件**：投影是派生、事件是权威（册子 §4.4），故只记 conflict、事件行照落。
func (s *Server) handleGovernEvent(w http.ResponseWriter, actor string, req eventReq, createdAt int64) {
	rawBody, action, ok := parseGovernBody(req.Body)
	if !ok {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	if !s.verifyEventSig(w, actor, req, rawBody) {
		return
	}
	pid, _ := parseProposalID(anyString(rawBody["proposal_id"]))
	var perr error
	switch action {
	case "proposal":
		cv, _ := jsonInt(rawBody["content_version"])
		rv, _ := jsonInt(rawBody["revoked_rev"])
		perr = s.st.ProjectGovernProposal(store.GovernProposalEvent{
			ProposalID: pid, TargetItemID: anyString(rawBody["target_item_id"]),
			Verb: anyString(rawBody["verb"]), ContentHash: anyString(rawBody["content_hash"]),
			Reason: anyString(rawBody["reason"]), Title: anyString(rawBody["title"]),
			BodyMD:         anyString(rawBody["body_md"]),
			ContentVersion: cv, RevokedRev: rv,
			CreatedAt: createdAt, EventID: req.EventID, Actor: actor,
		})
	case "vote":
		perr = s.st.ProjectGovernVote(store.GovernVoteEvent{
			ProposalID: pid, Choice: anyString(rawBody["choice"]),
			CreatedAt: createdAt, EventID: req.EventID, Actor: actor,
		})
	}
	if perr != nil && !errors.Is(perr, store.ErrGovernEventConflict) {
		s.writeError(w, http.StatusInternalServerError, perr.Error())
		return
	}
	// 事件行先落：`body_json` 存**客户端原始键集**（不是减化形态）——反熵把它搬到别的节点后，
	// 接收侧要据它重投影（Step 8），减化会丢掉 verb / content_hash / choice。
	now := time.Now().UnixMilli()
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: actor, Type: req.Type, BodyJSON: string(req.Body),
		CreatedAt: createdAt, ReceivedAt: now,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 权威事件行落地后才做生效判定（册子 §4.3 / §4.4）：proposal 与 vote **两条分支都要 settle**——
	// 反熵不保证 proposal 事件先于 vote 事件到达，故任一事件落地后都重新收敛一次（幂等）。
	// settle 是派生、事件是权威：失败只记日志，**不拒事件**。（顺序与 peersync.applySyncedGovernEvent 一致。）
	roster, _ := s.governRoster() // 派生失败按空名册降级（册子 §6.2），settle 会停在 pending
	if err := s.st.SettleGovernProposal(pid, roster, true); err != nil {
		log.Printf("httpapi: 治理提案 %d 生效判定失败（事件行已落）: %v", pid, err)
	}
	if ev, ok, err := s.st.GetEventByID(req.EventID); err == nil && ok {
		now = ev.ReceivedAt // 同 event_id 重发时给权威值（与 comment / group 口径一致）
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"event_id": req.EventID, "received_at": now,
		// true = 本次投影未生效（同 proposal_id 已被更早的 (created_at,event_id) 占位）；读接口展示被选中的那一条
		"conflict": perr != nil,
	})
}
