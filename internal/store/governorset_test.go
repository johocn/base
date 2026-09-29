package store

import (
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestGovernorSetUnionsRosterAndCircleGovernors(t *testing.T) {
	s := newTestStore(t)
	// 名册来源：一条达门槛的 article（≥200 非空白 rune）
	body := ""
	for i := 0; i < ArticleMinRunes; i++ {
		body += "甲"
	}
	hash := protocol.SHA256Hex([]byte(body))
	if _, err := s.UpsertSubmission(Submission{
		ItemID: "article/a1", Type: "article", Title: "t", BodyMD: body,
		ContentHash: hash, AuthorID: "aaa", AuthorSig: "s",
	}); err != nil {
		t.Fatal(err)
	}
	// 圈子来源：一个 m=1 的圈，唯一治者 = 创建者
	if err := s.PutGroupRosterV2(GroupRoster{
		GroupID: "g1", CreatorID: "ccc", Epoch: 1, RosterRev: 1, Encrypted: 0,
		MemberIDsJSON: `["ccc"]`, EventID: "e1",
	}); err != nil {
		t.Fatal(err)
	}
	set, err := s.GovernorSet()
	if err != nil {
		t.Fatal(err)
	}
	if !set["aaa"] || !set["ccc"] {
		t.Fatalf("集合 = %v，应同时含名册内 aaa 与圈内 ccc", set)
	}
	if set["bbb"] {
		t.Fatalf("bbb 不应在集合内: %v", set)
	}
	if len(set) != 2 {
		t.Fatalf("集合大小 = %d, want 2（去重）", len(set))
	}
}

func TestGovernorSetEmptyWhenNothingDerivable(t *testing.T) {
	s := newTestStore(t)
	set, err := s.GovernorSet()
	if err != nil {
		t.Fatal(err)
	}
	if len(set) != 0 {
		t.Fatalf("空库应得空集合，得 %v", set)
	}
}
