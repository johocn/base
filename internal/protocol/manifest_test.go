package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

const testSeed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"

func sampleManifest(t *testing.T) Manifest {
	t.Helper()
	body := []byte("demo body 1")
	cover := []byte("\x89PNG\r\n\x1a\n0123456789")
	m := Manifest{
		PackID:         DerivePackID("base-node-1", 7, "00000000000000000000000000000000"),
		SchemaVersion:  1,
		Issuer:         "base-node-1",
		IssuedAt:       "2026-01-02T03:04:05Z",
		ContentVersion: 7,
		Entries: []Entry{
			{
				ItemID: "article:demo-1", Source: "article", Type: "article", Title: "演示一",
				SourceRev: "rev-1", ContentHash: SHA256Hex(body), SQLiteTable: "articles", DistClass: "public",
			},
			{
				ItemID: "cover:demo-1", Source: "article", Type: "cover", Title: "封面",
				SourceRev: "rev-1", ContentHash: SHA256Hex(cover), SQLiteTable: "media_meta", DistClass: "public",
				Chunks: []Chunk{{BlobID: BlobID(cover), Size: int64(len(cover)), Seq: 0}},
			},
		},
		Tombstone:  []Tombstone{{ItemID: "article:old", RevokedRev: 2}},
		MerkleRoot: "00000000000000000000000000000000",
	}
	root, err := MerkleRoot(ManifestBlobIDs(m.Entries))
	if err != nil {
		t.Fatal(err)
	}
	m.MerkleRoot = root
	m.PackID = DerivePackID(m.Issuer, m.ContentVersion, m.MerkleRoot)
	sig, err := Sign(testSeed, mustSignBytes(t, m))
	if err != nil {
		t.Fatal(err)
	}
	m.Signature = sig
	return m
}

func mustSignBytes(t *testing.T, m Manifest) []byte {
	t.Helper()
	b, err := m.SignBytes()
	if err != nil {
		t.Fatalf("SignBytes: %v", err)
	}
	return b
}

func TestSignBytesExcludesSignature(t *testing.T) {
	m := sampleManifest(t)
	before := string(mustSignBytes(t, m))
	m.Signature = strings.Repeat("a", 128)
	after := string(mustSignBytes(t, m))
	if before != after {
		t.Fatal("SignBytes 受 signature 字段影响")
	}
	if strings.Contains(before, "signature") {
		t.Fatalf("SignBytes 不应包含 signature 字段: %s", before)
	}
	for _, want := range []string{`"pack_id"`, `"schema_version"`, `"entries"`, `"tombstone"`, `"merkle_root"`} {
		if !strings.Contains(before, want) {
			t.Fatalf("SignBytes 缺少 %s: %s", want, before)
		}
	}
}

func TestManifestVerifyAndTamper(t *testing.T) {
	m := sampleManifest(t)
	kp, err := KeyPairFromSeed(testSeed)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := m.Verify(kp.PubHex)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !ok {
		t.Fatal("Verify = false, want true")
	}

	t.Run("改标题即失败", func(t *testing.T) {
		bad := m
		bad.Entries = append([]Entry(nil), m.Entries...)
		bad.Entries[0].Title = "被改"
		ok, _ := bad.Verify(kp.PubHex)
		if ok {
			t.Fatal("篡改标题后仍验签通过")
		}
	})
	t.Run("改 merkle_root 即失败", func(t *testing.T) {
		bad := m
		bad.MerkleRoot = strings.Repeat("f", 64)
		ok, _ := bad.Verify(kp.PubHex)
		if ok {
			t.Fatal("篡改 merkle_root 后仍验签通过")
		}
	})
	t.Run("merkle_root 复算一致", func(t *testing.T) {
		got, err := MerkleRoot(ManifestBlobIDs(m.Entries))
		if err != nil {
			t.Fatal(err)
		}
		if got != m.MerkleRoot {
			t.Fatalf("merkle_root = %s, want %s", got, m.MerkleRoot)
		}
	})
	t.Run("pack_id 可复算", func(t *testing.T) {
		want := DerivePackID(m.Issuer, m.ContentVersion, m.MerkleRoot)
		if m.PackID != want {
			t.Fatalf("pack_id = %s, want %s", m.PackID, want)
		}
	})
}

func TestManifestJSONOmitsEmptyChunks(t *testing.T) {
	m := sampleManifest(t)
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"chunks"`) == false {
		t.Fatal("cover 条目应含 chunks")
	}
	imgOnly := m
	imgOnly.Entries = []Entry{m.Entries[0]}
	imgOnly.Tombstone = nil
	raw, err = json.Marshal(imgOnly)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"chunks"`) {
		t.Fatalf("空 chunks 必须省略: %s", raw)
	}
	if !strings.Contains(string(raw), `"tombstone":[]`) && !strings.Contains(string(raw), `"tombstone":null`) {
		t.Fatalf("tombstone 序列化异常: %s", raw)
	}
}

// 归属字段是可选的：空值不进签名字节，非空值进——这是「不 bump schema_version」的依据。
func TestManifestAuthorFieldsInSignBytes(t *testing.T) {
	base := Manifest{
		PackID: "p", SchemaVersion: 1, Issuer: "base-node-1", IssuedAt: "2026-01-02T03:04:05Z",
		ContentVersion: 7, Tombstone: []Tombstone{}, MerkleRoot: "m",
		Entries: []Entry{{ItemID: "article:demo-1", Source: "article", Type: "article",
			Title: "演示一", SourceRev: "rev-1", ContentHash: "h", SQLiteTable: "articles", DistClass: "public"}},
	}
	empty, err := base.SignBytes()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(empty), "author_id") || strings.Contains(string(empty), "contributors") {
		t.Fatalf("空归属/空名册不得进入签名字节: %s", empty)
	}

	withAuthor := base
	withAuthor.Entries = []Entry{{ItemID: "article:demo-1", Source: "article", Type: "article",
		Title: "演示一", SourceRev: "rev-1", ContentHash: "h", SQLiteTable: "articles", DistClass: "public",
		AuthorID: "f78672b2f87ff80b248323a4be7c3da6", AuthorSig: "00"}}
	withAuthor.Contributors = map[string]string{"f78672b2f87ff80b248323a4be7c3da6": "9471ed98cfff058f9b91cd3d1df44f1a78230d8e3ceb2311981307a04c5be6d0"}
	got, err := withAuthor.SignBytes()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"author_id":"f78672b2f87ff80b248323a4be7c3da6"`, `"author_sig":"00"`, `"contributors":{`} {
		if !strings.Contains(string(got), want) {
			t.Fatalf("签名字节缺少 %s: %s", want, got)
		}
	}
}
