package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAuthorSigVectorFile(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "authorsig.json"))
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
			Name         string `json:"name"`
			ItemID       string `json:"item_id"`
			ContentHash  string `json:"content_hash"`
			AuthorID     string `json:"author_id"`
			SignBytes    string `json:"sign_bytes"`
			SignatureHex string `json:"signature_hex"`
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
			// 自证：author_id 必须由公钥派生（册子 §2.1）
			id, err := IdentityID(f.Key.PubHex)
			if err != nil {
				t.Fatal(err)
			}
			if id != c.AuthorID {
				t.Fatalf("author_id 与公钥失配: %s != %s", id, c.AuthorID)
			}
			sb, err := AuthorSignBytes(c.ItemID, c.ContentHash, c.AuthorID)
			if err != nil {
				t.Fatal(err)
			}
			if string(sb) != c.SignBytes {
				t.Fatalf("签名字节不一致:\n got %s\nwant %s", sb, c.SignBytes)
			}
			ok, err := VerifyAuthorSig(f.Key.PubHex, c.ItemID, c.ContentHash, c.AuthorID, c.SignatureHex)
			if err != nil || !ok {
				t.Fatalf("向量验签失败: ok=%v err=%v", ok, err)
			}
			sig, err := Sign(f.Key.SeedHex, sb)
			if err != nil {
				t.Fatal(err)
			}
			if sig != c.SignatureHex {
				t.Fatalf("签名复算 = %s, want %s", sig, c.SignatureHex)
			}
		})
	}
}
