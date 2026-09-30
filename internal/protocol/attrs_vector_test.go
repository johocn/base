package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAttrVectorFile(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "attrs.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var f struct {
		Version int `json:"version"`
		Cases   []struct {
			Name  string     `json:"name"`
			Lines []AttrLine `json:"lines"`
			Slots []AttrSlot `json:"slots"`
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
			got := AssignAttrSeqs(c.Lines)
			if len(got) != len(c.Slots) {
				t.Fatalf("槽位数 %d != %d: got=%+v", len(got), len(c.Slots), got)
			}
			for i := range got {
				if got[i] != c.Slots[i] {
					t.Fatalf("第 %d 槽: got=%+v want=%+v", i, got[i], c.Slots[i])
				}
			}
			// 向量自身必须是「规范排布」，否则 AttrSeqsCanonical 的门就形同虚设。
			if !AttrSeqsCanonical(c.Slots) {
				t.Fatalf("向量 slots 不是规范排布: %+v", c.Slots)
			}
		})
	}
}

// 同一 kind 至多一行（唯 attachment 可多行）：超出部分按确定性规则取首行，不报错。
func TestAssignAttrSeqsSingleRowPerKind(t *testing.T) {
	got := AssignAttrSeqs([]AttrLine{
		{Kind: AttrKeyInstructor, Text: "甲"},
		{Kind: AttrKeyInstructor, Text: "乙"},
	})
	if len(got) != 1 || got[0].Text != "甲" || got[0].Seq != -1 {
		t.Fatalf("同 kind 多行应只留首行: %+v", got)
	}
}

func TestIsAttrKind(t *testing.T) {
	if !IsAttrKind(AttrKeyCover) || !IsAttrKind(AttrKeyBodyMD) {
		t.Fatal("六种属性 kind 均应通过")
	}
	for _, k := range []string{"", "attr.", "attr.unknown", "digest", "lesson", "article"} {
		if IsAttrKind(k) {
			t.Fatalf("应非法: %q", k)
		}
	}
}