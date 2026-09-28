package peersync

import (
	"testing"

	"github.com/johocn/base/internal/protocol"
)

const (
	authorSeed = "6f1e0d9c8b7a6958473625142332415061728394a5b6c7d8e9f0a1b2c3d4e5f6"
	authorHash = "af7d2109429d7850f7ae542da6b0d83403846119fc160ed8060cc3814f676a48"
)

func signedEntry(t *testing.T, itemID string) protocol.Entry {
	t.Helper()
	kp, err := protocol.KeyPairFromSeed(authorSeed)
	if err != nil {
		t.Fatal(err)
	}
	id, err := protocol.IdentityID(kp.PubHex)
	if err != nil {
		t.Fatal(err)
	}
	sb, err := protocol.AuthorSignBytes(itemID, authorHash, id)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := protocol.Sign(authorSeed, sb)
	if err != nil {
		t.Fatal(err)
	}
	return protocol.Entry{
		ItemID: itemID, Source: "article", Type: "article", Title: "演示",
		ContentHash: authorHash, SQLiteTable: "articles", DistClass: "public",
		AuthorID: id, AuthorSig: sig,
	}
}

func authorPub(t *testing.T) (id, pub string) {
	t.Helper()
	kp, err := protocol.KeyPairFromSeed(authorSeed)
	if err != nil {
		t.Fatal(err)
	}
	id, err = protocol.IdentityID(kp.PubHex)
	if err != nil {
		t.Fatal(err)
	}
	return id, kp.PubHex
}

func TestResolveAuthorAcceptsValid(t *testing.T) {
	id, pub := authorPub(t)
	e := signedEntry(t, "article:demo-1")
	man := protocol.Manifest{Contributors: map[string]string{id: pub}}
	gotID, gotSig := resolveAuthor(man, e)
	if gotID != id || gotSig != e.AuthorSig {
		t.Fatalf("合法归属应保留: %q %q", gotID, gotSig)
	}
}

func TestResolveAuthorDegradesWithoutRejecting(t *testing.T) {
	id, pub := authorPub(t)

	// 1) 缺 contributors
	if gotID, gotSig := resolveAuthor(protocol.Manifest{}, signedEntry(t, "article:demo-1")); gotID != "" || gotSig != "" {
		t.Fatalf("缺公告钥应降级: %q %q", gotID, gotSig)
	}
	// 2) 公钥与 author_id 失配（篡改公钥）
	other, err := protocol.KeyPairFromSeed("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
	if err != nil {
		t.Fatal(err)
	}
	if gotID, gotSig := resolveAuthor(protocol.Manifest{Contributors: map[string]string{id: other.PubHex}}, signedEntry(t, "article:demo-1")); gotID != "" || gotSig != "" {
		t.Fatalf("公钥失配应降级: %q %q", gotID, gotSig)
	}
	// 3) 篡改 author_sig
	bad := signedEntry(t, "article:demo-1")
	bad.AuthorSig = "0" + bad.AuthorSig[1:]
	if gotID, gotSig := resolveAuthor(protocol.Manifest{Contributors: map[string]string{id: pub}}, bad); gotID != "" || gotSig != "" {
		t.Fatalf("验签失败应降级: %q %q", gotID, gotSig)
	}
	// 4) 内容变了（content_hash 不再是签名里的那个）
	moved := signedEntry(t, "article:demo-1")
	moved.ContentHash = "00" + moved.ContentHash[2:]
	if gotID, gotSig := resolveAuthor(protocol.Manifest{Contributors: map[string]string{id: pub}}, moved); gotID != "" || gotSig != "" {
		t.Fatalf("内容变更应重签，否则降级: %q %q", gotID, gotSig)
	}
	// 5) 本就无归属
	plain := signedEntry(t, "article:demo-1")
	plain.AuthorID, plain.AuthorSig = "", ""
	if gotID, gotSig := resolveAuthor(protocol.Manifest{Contributors: map[string]string{id: pub}}, plain); gotID != "" || gotSig != "" {
		t.Fatalf("无归属应保持空: %q %q", gotID, gotSig)
	}
}
