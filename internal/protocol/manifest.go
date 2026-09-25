package protocol

import (
	"encoding/json"
	"fmt"
)

// Chunk 是一个外部块（内容寻址）。
type Chunk struct {
	BlobID string `json:"blob_id"`
	Size   int64  `json:"size"`
	Seq    int    `json:"seq"`
}

// Entry 是 manifest 条目。
type Entry struct {
	ItemID      string  `json:"item_id"`
	Source      string  `json:"source"`
	Type        string  `json:"type"`
	Title       string  `json:"title"`
	SourceRev   string  `json:"source_rev"`
	ContentHash string  `json:"content_hash"`
	SQLiteTable string  `json:"sqlite_table"`
	Chunks      []Chunk `json:"chunks,omitempty"`
	DistClass   string  `json:"dist_class"`
}

// Tombstone 是撤回记录（只能在已签名 manifest 中传播）。
type Tombstone struct {
	ItemID     string `json:"item_id"`
	RevokedRev int    `json:"revoked_rev"`
}

// Manifest 是内容包清单。
type Manifest struct {
	PackID         string      `json:"pack_id"`
	SchemaVersion  int         `json:"schema_version"`
	Issuer         string      `json:"issuer"`
	IssuedAt       string      `json:"issued_at"`
	ContentVersion int64       `json:"content_version"`
	Entries        []Entry     `json:"entries"`
	Tombstone      []Tombstone `json:"tombstone"`
	MerkleRoot     string      `json:"merkle_root"`
	Signature      string      `json:"signature"`
}

// ManifestBlobIDs 汇总所有条目的块 id（契约第 4 条的定义域）。
func ManifestBlobIDs(entries []Entry) []string {
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		for _, c := range e.Chunks {
			out = append(out, c.BlobID)
		}
	}
	return out
}

// SignBytes 返回签名字节：manifest 去掉 signature 字段后的规范化 JSON。
func (m Manifest) SignBytes() ([]byte, error) {
	raw, err := json.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("manifest sign bytes: %w", err)
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, fmt.Errorf("manifest sign bytes: %w", err)
	}
	delete(obj, "signature")
	return Canonicalize(obj)
}

// Sign 用私钥种子对 SignBytes 签名，并写入 Signature。
func (m *Manifest) SignWith(seedHex string) error {
	b, err := m.SignBytes()
	if err != nil {
		return err
	}
	sig, err := Sign(seedHex, b)
	if err != nil {
		return err
	}
	m.Signature = sig
	return nil
}

// Verify 用公钥验签，并要求 merkle_root 与 pack_id 可复算一致。
func (m Manifest) Verify(pubHex string) (bool, error) {
	if m.SchemaVersion != 1 {
		return false, nil
	}
	if m.PackID != DerivePackID(m.Issuer, m.ContentVersion, m.MerkleRoot) {
		return false, nil
	}
	want, err := MerkleRoot(ManifestBlobIDs(m.Entries))
	if err != nil {
		return false, err
	}
	if want != m.MerkleRoot {
		return false, nil
	}
	b, err := m.SignBytes()
	if err != nil {
		return false, err
	}
	return Verify(pubHex, b, m.Signature)
}