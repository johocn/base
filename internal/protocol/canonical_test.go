package protocol

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type canonicalVector struct {
	Version int `json:"version"`
	Cases   []struct {
		Name     string          `json:"name"`
		Input    json.RawMessage `json:"input"`
		Expected string          `json:"expected"`
	} `json:"cases"`
}

func TestCanonicalizeVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "canonical.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var f canonicalVector
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if f.Version != 1 {
		t.Fatalf("vectors version = %d, want 1", f.Version)
	}
	if len(f.Cases) < 8 {
		t.Fatalf("vectors cases = %d, want >= 8", len(f.Cases))
	}
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			dec := json.NewDecoder(bytes.NewReader(c.Input))
			dec.UseNumber()
			var v any
			if err := dec.Decode(&v); err != nil {
				t.Fatalf("decode input: %v", err)
			}
			got, err := Canonicalize(v)
			if err != nil {
				t.Fatalf("Canonicalize: %v", err)
			}
			if string(got) != c.Expected {
				t.Fatalf("Canonicalize = %s, want %s", got, c.Expected)
			}
		})
	}
}

func TestCanonicalizeRejectsNonIntegerAndNonASCIIKey(t *testing.T) {
	if _, err := Canonicalize(json.Number("1.5")); err == nil {
		t.Fatal("want error for float number, got nil")
	}
	if _, err := Canonicalize(map[string]any{"中": 1}); err == nil {
		t.Fatal("want error for non-ascii key, got nil")
	}
}