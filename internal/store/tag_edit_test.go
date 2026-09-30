package store

import (
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestEditTagProposalReplacesLinksAndKeepsAuthor(t *testing.T) {
	s := newTestStore(t)
	if err := s.putItemForTest("course/c1", "course"); err != nil {
		t.Fatal(err)
	}
	if err := s.putItemForTest("course/c2", "course"); err != nil {
		t.Fatal(err)
	}
	tagID, _ := protocol.TagItemID("甲", "第一章", "第一节")
	if _, err := s.UpsertTagSubmission(TagSubmission{
		TagID: tagID, Title: protocol.TagTitle("甲", "第一章", "第一节"),
		Links:    []TagLink{{TagID: tagID, TargetID: "course/c1", Kind: "course"}},
		AuthorID: "aa", AuthorSig: "sig-original",
	}); err != nil {
		t.Fatal(err)
	}
	base, ok, err := s.GetItem(tagID)
	if err != nil || !ok {
		t.Fatalf("GetItem ok=%v err=%v", ok, err)
	}
	linksJSON, err := EncodeTagLinks([]TagLink{
		{TagID: tagID, TargetID: "course/c1", Kind: "course"},
		{TagID: tagID, TargetID: "course/c2", Kind: "course"},
	})
	if err != nil {
		t.Fatal(err)
	}
	id, err := s.CreateProposal(Proposal{
		Action: GovernActionEdit, ItemID: tagID, ProposerID: "bb",
		LinksJSON: linksJSON, BaseContentHash: base.ContentHash,
	})
	if err != nil {
		t.Fatal(err)
	}
	// 2 票门槛：提案人自计 1 票，再补一票
	roster := map[string]bool{"bb": true, "cc": true}
	if _, err := s.AddVote(id, "cc", roster); err != nil {
		t.Fatal(err)
	}
	got, err := s.ListTagLinks(tagID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("生效后 tag_links = %+v，want 2 行（全量覆盖）", got)
	}
	after, ok, err := s.GetItem(tagID)
	if err != nil || !ok {
		t.Fatalf("GetItem ok=%v err=%v", ok, err)
	}
	if after.AuthorID != "aa" || after.AuthorSig != "sig-original" {
		t.Fatalf("归属两列不得变化: %+v", after)
	}
	segs, err := s.ListSegments(tagID)
	if err != nil {
		t.Fatal(err)
	}
	if after.ContentHash != SegmentsContentHash(segs) {
		t.Fatalf("content_hash 未按容器口径重算: %s", after.ContentHash)
	}
}
