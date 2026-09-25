package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestManifestVectorFile(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "manifest.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var f struct {
		Version int `json:"version"`
		Key     struct {
			SeedHex string `json:"seed_hex"`
			PubHex  string `json:"pub_hex"`
		} `json:"key"`
		Cases []struct {
			Name           string   `json:"name"`
			PackID         string   `json:"pack_id"`
			ContentVersion int64    `json:"content_version"`
			MerkleRoot     string   `json:"merkle_root"`
			Entries        int      `json:"entries"`
			ManifestSHA256 string   `json:"manifest_sha256"`
			SignBytes      string   `json:"sign_bytes"`
			Manifest       Manifest `json:"manifest"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if f.Version != 1 || len(f.Cases) == 0 {
		t.Fatalf("向量文件结构错误: version=%d cases=%d", f.Version, len(f.Cases))
	}
	kp, err := KeyPairFromSeed(f.Key.SeedHex)
	if err != nil {
		t.Fatal(err)
	}
	if kp.PubHex != f.Key.PubHex {
		t.Fatalf("向量公钥与种子不匹配: %s != %s", kp.PubHex, f.Key.PubHex)
	}
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			ok, err := c.Manifest.Verify(f.Key.PubHex)
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if !ok {
				t.Fatal("向量 manifest 验签失败")
			}
			if c.Manifest.PackID != c.PackID || c.Manifest.ContentVersion != c.ContentVersion || c.Manifest.MerkleRoot != c.MerkleRoot {
				t.Fatalf("向量字段与 manifest 不一致: %+v", c)
			}
			if got := len(c.Manifest.Entries); got != c.Entries {
				t.Fatalf("entries = %d, want %d", got, c.Entries)
			}
			if got := DerivePackID(c.Manifest.Issuer, c.Manifest.ContentVersion, c.Manifest.MerkleRoot); got != c.PackID {
				t.Fatalf("pack_id 复算 = %s, want %s", got, c.PackID)
			}
			merkle, err := MerkleRoot(ManifestBlobIDs(c.Manifest.Entries))
			if err != nil {
				t.Fatalf("MerkleRoot: %v", err)
			}
			if merkle != c.MerkleRoot {
				t.Fatalf("merkle_root 复算 = %s, want %s", merkle, c.MerkleRoot)
			}
			signBytes, err := c.Manifest.SignBytes()
			if err != nil {
				t.Fatal(err)
			}
			if string(signBytes) != c.SignBytes {
				t.Fatalf("签名字节不一致:\n got %s\nwant %s", signBytes, c.SignBytes)
			}
			canon, err := Canonicalize(c.Manifest)
			if err != nil {
				t.Fatal(err)
			}
			if got := SHA256Hex(canon); got != c.ManifestSHA256 {
				t.Fatalf("manifest 规范化字节 sha256 = %s, want %s", got, c.ManifestSHA256)
			}
		})
	}
}