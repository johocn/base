package httpapi

import (
	"log"
	"strconv"
	"strings"
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
