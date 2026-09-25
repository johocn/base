package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHashVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "hash.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var f struct {
		Version int `json:"version"`
		Cases   []struct {
			Name      string `json:"name"`
			InputUTF8 string `json:"input_utf8"`
			SHA256    string `json:"sha256"`
			BlobID    string `json:"blob_id"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(f.Cases) < 4 {
		t.Fatalf("vectors cases = %d, want >= 4", len(f.Cases))
	}
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			if strings.Contains(c.SHA256, "__") {
				t.Fatalf("vector %s 未填值", c.Name)
			}
			if got := SHA256Hex([]byte(c.InputUTF8)); got != c.SHA256 {
				t.Fatalf("SHA256Hex = %s, want %s", got, c.SHA256)
			}
			if got := BlobID([]byte(c.InputUTF8)); got != c.BlobID {
				t.Fatalf("BlobID = %s, want %s", got, c.BlobID)
			}
		})
	}
}

func TestIsBlobID(t *testing.T) {
	good := "e3b0c44298fc1c149afbf4c8996fb924"
	if !IsBlobID(good) {
		t.Fatalf("IsBlobID(%q) = false, want true", good)
	}
	for _, bad := range []string{"", "E3B0C44298FC1C149AFBF4C8996FB924", "e3b0c44298fc1c149afbf4c8996fb92", "e3b0c44298fc1c149afbf4c8996fb92z"} {
		if IsBlobID(bad) {
			t.Fatalf("IsBlobID(%q) = true, want false", bad)
		}
	}
}