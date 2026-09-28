package httpapi

import (
	"strings"
	"testing"
)

func trimSpace(s string) string { return strings.TrimSpace(s) }

func TestValidProposalAction(t *testing.T) {
	for _, a := range []string{"remove", "edit", "revive"} {
		if !validProposalAction(a) {
			t.Fatalf("应合法: %q", a)
		}
	}
	for _, a := range []string{"", "REMOVE", "delete", "add", "remove "} {
		if validProposalAction(a) {
			t.Fatalf("应非法: %q", a)
		}
	}
}

func TestValidProposalReason(t *testing.T) {
	// 缺省（空串）走「未给定」分支，由 handler 判；此处的判定只针对「已给定」。
	for _, raw := range []string{"", "   ", "\t\n", repeat("文", 201), "有\x00控制符", "有\x7f控制符"} {
		if _, ok := validProposalReason(raw); ok {
			t.Fatalf("应非法: %q", raw)
		}
	}
	for _, raw := range []string{"错别字", "  两边有空白  ", repeat("文", 200)} {
		s, ok := validProposalReason(raw)
		if !ok {
			t.Fatalf("应合法: %q", raw)
		}
		if s != trimSpace(raw) {
			t.Fatalf("应返回去空白后的值: %q → %q", raw, s)
		}
	}
}

func TestParseProposalID(t *testing.T) {
	for raw, want := range map[string]int64{"1": 1, "42": 42, "9007199254740993": 9007199254740993} {
		got, ok := parseProposalID(raw)
		if !ok || got != want {
			t.Fatalf("parseProposalID(%q)=(%d,%v) want (%d,true)", raw, got, ok, want)
		}
	}
	for _, raw := range []string{"", "0", "-1", "1.0", "abc", "1 ", " 1", "0x1"} {
		if got, ok := parseProposalID(raw); ok {
			t.Fatalf("parseProposalID(%q) 应失败，得 %d", raw, got)
		}
	}
}
