package markdown

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// 与 mobile 侧 vitest 共读同一份 vectors/v1/markdown.json，任一端漂移即红。
func TestMarkdownVectorFile(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "markdown.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var f struct {
		Version int `json:"version"`
		Cases   []struct {
			Name string `json:"name"`
			Src  string `json:"src"`
			HTML string `json:"html"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if f.Version != 1 || len(f.Cases) == 0 {
		t.Fatalf("向量文件结构错误: version=%d cases=%d", f.Version, len(f.Cases))
	}
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			if got := RenderString(c.Src); got != c.HTML {
				t.Fatalf("got=%q want=%q", got, c.HTML)
			}
		})
	}
}
