package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestMerkleRootVectorFile(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "merkle.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var f struct {
		Version int `json:"version"`
		Cases   []struct {
			Name    string   `json:"name"`
			BlobIDs []string `json:"blob_ids"`
			Root    string   `json:"merkle_root"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(f.Cases) < 6 {
		t.Fatalf("vectors cases = %d, want >= 6", len(f.Cases))
	}
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			got, err := MerkleRoot(c.BlobIDs)
			if err != nil {
				t.Fatalf("MerkleRoot: %v", err)
			}
			if got != c.Root {
				t.Fatalf("MerkleRoot = %s, want %s", got, c.Root)
			}
		})
	}
}

func TestMerkleRootProperties(t *testing.T) {
	a := "00000000000000000000000000000001"
	b := "00000000000000000000000000000002"
	c := "00000000000000000000000000000003"
	base, _ := MerkleRoot([]string{a, b, c})

	t.Run("顺序无关", func(t *testing.T) {
		got, _ := MerkleRoot([]string{c, a, b})
		if got != base {
			t.Fatalf("顺序改变了根: %s != %s", got, base)
		}
	})
	t.Run("去重后等价", func(t *testing.T) {
		got, _ := MerkleRoot([]string{a, b, c, a, b})
		if got != base {
			t.Fatalf("重复项改变了根: %s != %s", got, base)
		}
	})
	t.Run("单叶变化即变根", func(t *testing.T) {
		got, _ := MerkleRoot([]string{a, b, "00000000000000000000000000000004"})
		if got == base {
			t.Fatal("改一个叶子后根未变化")
		}
	})
	t.Run("非法 id 报错", func(t *testing.T) {
		if _, err := MerkleRoot([]string{"XX"}); err == nil {
			t.Fatal("want error for invalid blob id")
		}
	})
	t.Run("空集为固定值", func(t *testing.T) {
		empty, _ := MerkleRoot(nil)
		if empty == base {
			t.Fatal("空集根不应等于非空集根")
		}
		if empty != SHA256Hex([]byte("merkle:empty")) {
			t.Fatalf("空集根 = %s, want sha256(merkle:empty)", empty)
		}
	})
}