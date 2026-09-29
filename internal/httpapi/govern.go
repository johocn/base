package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/johocn/base/internal/store"
)

// 本册的文档级常量（册子 §6）：不做配置项，校准走「改册子 + 改常量」。
const (
	// 写限速：按已验签身份分两条路径、按客户端 IP 全治理面共用一条。
	proposalPerMinutePerID = 6
	proposalBurstPerID     = 3
	votePerMinutePerID     = 20
	voteBurstPerID         = 10
	governPerMinutePerIP   = 60
	governBurstPerIP       = 20

	// maxProposalReasonRunes 是 reason 的 rune 上限（册子 §3.1），与 title 同为 200。
	maxProposalReasonRunes = 200
)

// validProposalAction 按册子 §2.1：remove / edit / revive 三值枚举。
func validProposalAction(a string) bool {
	switch a {
	case store.GovernActionRemove, store.GovernActionEdit, store.GovernActionRevive:
		return true
	}
	return false
}

// hasControlChars 判 U+0000–U+001F 与 U+007F（册子 §3.1 的控制字符口径）。
func hasControlChars(s string) bool {
	for _, r := range s {
		if r <= 0x1F || r == 0x7F {
			return true
		}
	}
	return false
}

// validProposalReason 按册子 §3.1：去首尾空白后 1..200 rune 且不含控制字符。
// 返回去空白后的存储值；ok=false 表示「已给定但不合规」（缺省由 handler 单独判）。
func validProposalReason(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	n := utf8.RuneCountInString(s)
	if n < 1 || n > maxProposalReasonRunes {
		return "", false
	}
	return s, !hasControlChars(s)
}

// parseProposalID 解析路径里的 proposal_id：十进制正整数（册子 §5.1 的本地自增整数）。
func parseProposalID(raw string) (int64, bool) {
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}

// governRoster 派生本节点名册为集合；ok=false 表示派生失败。
//
// 派生失败按册子 §6.2 降级：有效票 = 0（提案停在 pending）、展示为空名册，
// 且**不因此拒绝**提案 / 投票请求——故资格判定在 !ok 时放行（fail-open）。
func (s *Server) governRoster() (set map[string]bool, ok bool) {
	rows, err := s.st.ContributorRoster()
	if err != nil {
		log.Printf("httpapi: 名册派生失败，按空名册降级（治理册 §6.2）: %v", err)
		return map[string]bool{}, false
	}
	set = make(map[string]bool, len(rows))
	for _, c := range rows {
		set[c.ID] = true
	}
	return set, true
}

type proposalEditReq struct {
	Title string `json:"title"`
	// BodyMD 用指针以区分「键缺失」（400）与「空串」（合法：本册不设内容下限）。
	BodyMD *string `json:"body_md"`
}

type proposalReq struct {
	Action     string           `json:"action"`
	ItemID     string           `json:"item_id"`
	Reason     string           `json:"reason"`
	Edit       *proposalEditReq `json:"edit"`
	ProposerID json.RawMessage  `json:"proposer_id"`
	AuthorID   json.RawMessage  `json:"author_id"`
}

// handleProposalPost 是签名写路径 POST /v1/proposal（册子 §3.1）：名册内的治理者
// 对**他人**条目发起 remove / edit / revive 提案，签名即自动构成第 1 票。任何失败都不写入。
func (s *Server) handleProposalPost(w http.ResponseWriter, r *http.Request) {
	actor := identityFrom(r)
	var req proposalReq
	if !s.decodeJSON(w, r, &req) {
		return
	}
	// 提案人只能取自鉴权身份：请求体携带即等于替他人提案（册子 §3.1 硬约束）。
	if len(req.ProposerID) > 0 || len(req.AuthorID) > 0 {
		s.writeAuthErr(w, http.StatusBadRequest, "author_id_forbidden")
		return
	}
	if !validProposalAction(req.Action) {
		s.writeAuthErr(w, http.StatusBadRequest, "proposal_action_unsupported")
		return
	}
	// reason 可选（缺省空串）；但「已给定」却不合规要拒。
	reason, reasonOK := validProposalReason(req.Reason)
	if req.Reason != "" && !reasonOK {
		s.writeAuthErr(w, http.StatusBadRequest, "proposal_reason_invalid")
		return
	}
	title, bodyMD := "", ""
	if req.Action == store.GovernActionEdit {
		if req.Edit == nil || req.Edit.BodyMD == nil || !validItemTitle(req.Edit.Title) {
			s.writeAuthErr(w, http.StatusBadRequest, "proposal_edit_invalid")
			return
		}
		title, bodyMD = strings.TrimSpace(req.Edit.Title), *req.Edit.BodyMD
		if len(title)+len(bodyMD) > maxSubmitBytes {
			s.writeAuthErr(w, http.StatusRequestEntityTooLarge, "proposal_too_large")
			return
		}
	}
	if !s.proposalLimiterByID.allow(actor) || !s.governLimiterByIP.allow(clientIP(r)) {
		s.writeAuthErr(w, http.StatusTooManyRequests, "govern_rate_limited")
		return
	}
	it, ok, err := s.st.GetItem(req.ItemID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		s.writeAuthErr(w, http.StatusNotFound, "item_not_found")
		return
	}
	// 自己改自己走第 2 册的签名写路径，不需要审批（册子 §2.2）。空归属条目可治。
	if it.AuthorID != "" && it.AuthorID == actor {
		s.writeAuthErr(w, http.StatusForbidden, "item_self_owned")
		return
	}
	if it.State != store.GovernRequiredState(req.Action) {
		s.writeAuthErr(w, http.StatusBadRequest, "item_state_mismatch")
		return
	}
	// edit 只对 article 载体成立（册子 §0.3）：body_md 与 sha256(body_md) 只存在于 articles。
	if req.Action == store.GovernActionEdit && it.SQLiteTable != "articles" {
		s.writeAuthErr(w, http.StatusBadRequest, "proposal_edit_invalid")
		return
	}
	roster, rosterOK := s.governRoster()
	if rosterOK && !roster[actor] {
		s.writeAuthErr(w, http.StatusForbidden, "proposer_not_governor")
		return
	}
	id, err := s.st.CreateProposal(store.Proposal{
		Action: req.Action, ItemID: req.ItemID, ProposerID: actor,
		Reason: reason, Title: title, BodyMD: bodyMD,
		BaseContentHash: it.ContentHash, CreatedAt: time.Now().UnixMilli(),
	})
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusCreated, map[string]any{
		"proposal_id": strconv.FormatInt(id, 10),
		"action":      req.Action,
		"item_id":     req.ItemID,
		"vote_count":  1,
		"threshold":   store.GovernThreshold(req.Action),
		"status":      store.GovernStatusPending,
	})
}

type voteReq struct {
	VoterID  json.RawMessage `json:"voter_id"`
	AuthorID json.RawMessage `json:"author_id"`
	ID       json.RawMessage `json:"id"`
}

// handleVotePost 是签名写路径 POST /v1/proposal/{proposal_id}/vote（册子 §3.2）。
// 投票请求**可能带副作用**：这一票把有效票推到该动作门槛时，在同一事务内执行动作。
func (s *Server) handleVotePost(w http.ResponseWriter, r *http.Request) {
	actor := identityFrom(r)
	// 请求体可空（册子 §3.2）：空体与 {} 等价，故不能直接用 decodeJSON。
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxJSONBody))
	if err != nil {
		s.writeAuthErr(w, http.StatusBadRequest, "auth_body_read_failed")
		return
	}
	_ = r.Body.Close()
	if len(bytes.TrimSpace(raw)) > 0 {
		var req voteReq
		if err := json.Unmarshal(raw, &req); err != nil {
			s.writeError(w, http.StatusBadRequest, "bad_json")
			return
		}
		// 投票人只能取自鉴权身份：请求体携带任何身份字段都等于替他人投票。
		if len(req.VoterID) > 0 || len(req.AuthorID) > 0 || len(req.ID) > 0 {
			s.writeAuthErr(w, http.StatusBadRequest, "author_id_forbidden")
			return
		}
	}
	pid, ok := parseProposalID(r.PathValue("proposal_id"))
	if !ok {
		s.writeAuthErr(w, http.StatusNotFound, "proposal_not_found")
		return
	}
	if !s.voteLimiterByID.allow(actor) || !s.governLimiterByIP.allow(clientIP(r)) {
		s.writeAuthErr(w, http.StatusTooManyRequests, "govern_rate_limited")
		return
	}
	if _, ok, err := s.st.GetProposal(pid); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	} else if !ok {
		s.writeAuthErr(w, http.StatusNotFound, "proposal_not_found")
		return
	}
	roster, rosterOK := s.governRoster()
	if rosterOK && !roster[actor] {
		s.writeAuthErr(w, http.StatusForbidden, "voter_not_governor")
		return
	}
	res, err := s.st.AddVote(pid, actor, roster)
	if errors.Is(err, store.ErrAlreadyVoted) {
		s.writeAuthErr(w, http.StatusConflict, "already_voted")
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"proposal_id": strconv.FormatInt(res.ProposalID, 10),
		"vote_count":  res.VoteCount,
		"threshold":   res.Threshold,
		"status":      res.Status,
	})
}

type proposalDTO struct {
	ProposalID string   `json:"proposal_id"`
	Action     string   `json:"action"`
	ItemID     string   `json:"item_id"`
	ProposerID string   `json:"proposer_id"`
	Reason     string   `json:"reason"`
	Title      string   `json:"title"`
	BodyMD     string   `json:"body_md"`
	Status     string   `json:"status"`
	Votes      []string `json:"votes"`
	VoteCount  int      `json:"vote_count"`
	Threshold  int      `json:"threshold"`
	CreatedAt  int64    `json:"created_at"`
	ExecutedAt int64    `json:"executed_at"`
	VoidedAt   int64    `json:"voided_at"`
	// 提案快照水位（册子 §4.3）：客户端据此展示「票权按此判定」，同提案行上的 content_version / revoked_rev。
	ContentVersion int64 `json:"content_version"`
	RevokedRev     int64 `json:"revoked_rev"`
}

type proposalsResponse struct {
	Proposals []proposalDTO `json:"proposals"`
}

// handleProposalList 匿名返回全部提案与**当前有效票**（册子 §3.3）：无需登录、无需签名头。
// 不分页、不支持过滤（量级假设见册子 §9 风险 6）；空列表返回 []（不是 null）。
func (s *Server) handleProposalList(w http.ResponseWriter, r *http.Request) {
	roster, _ := s.governRoster() // 派生失败按空名册降级（册子 §6.2）
	// 票权按提案**快照水位**判定（册子 §4.3，取代 #27 的实时复判）：名册作为当前基线，
	// 内部再按提案行上的 content_version / revoked_rev 加回水位后退役的作者（AC 12）。
	views, err := s.st.ListProposalViews(roster)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := proposalsResponse{Proposals: []proposalDTO{}}
	for _, v := range views {
		resp.Proposals = append(resp.Proposals, proposalDTO{
			ProposalID: strconv.FormatInt(v.ProposalID, 10),
			Action:     v.Action,
			ItemID:     v.ItemID,
			ProposerID: v.ProposerID,
			Reason:     v.Reason,
			Title:      v.Title,
			BodyMD:     v.BodyMD,
			Status:     v.Status,
			Votes:      v.Votes,
			VoteCount:  len(v.Votes),
			Threshold:  v.Threshold,
			CreatedAt:  v.CreatedAt,
			ExecutedAt: v.ExecutedAt,
			VoidedAt:   v.VoidedAt,
			// 快照水位直接透传提案行的两列（ProposalView 内嵌 Proposal，已带上）。
			ContentVersion: v.ContentVersion,
			RevokedRev:     v.RevokedRev,
		})
	}
	s.writeJSON(w, http.StatusOK, resp)
}
