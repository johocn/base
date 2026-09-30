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

// AttrSeqsCanonical 与入参数组顺序无关：同 kind 字典序递减分配，attachment 占连续递减区间。
// 判据强度不降——seq 取值本身错了（这里 cover 与 instructor 互换了 seq）仍须为假。
func TestAttrSeqsCanonicalOrderIndependent(t *testing.T) {
	// kind 字典序：attr.attachment < attr.cover < attr.instructor，
	// 故 attachment 先占 -1 起，同 kind 内按 text 升序占递减 seq。
	cover := AttrSlot{Seq: -3, Kind: AttrKeyCover, Text: "00112233445566778899aabbccddeeff"}
	instructor := AttrSlot{Seq: -4, Kind: AttrKeyInstructor, Text: "李老师"}
	attachA := AttrSlot{Seq: -1, Kind: AttrKeyAttachment, Text: "aa11\t甲.pdf"}
	attachB := AttrSlot{Seq: -2, Kind: AttrKeyAttachment, Text: "bb22\t乙.pdf"}

	cases := []struct {
		name string
		in   []AttrSlot
		want bool
	}{
		{"规范（seq 降序）", []AttrSlot{attachA, attachB, cover, instructor}, true},
		{"乱序（seq 升序）", []AttrSlot{instructor, cover, attachB, attachA}, true},
		{"乱序（交错）", []AttrSlot{attachB, cover, attachA, instructor}, true},
		{"单条", []AttrSlot{{Seq: -1, Kind: AttrKeyCover, Text: cover.Text}}, true},
		{"seq 赋值错（cover/instructor 互换）", []AttrSlot{
			{Seq: -1, Kind: AttrKeyInstructor, Text: "李老师"},
			{Seq: -2, Kind: AttrKeyCover, Text: cover.Text},
		}, false},
		{"附件区间不连续（-1/-3）", []AttrSlot{
			attachA,
			{Seq: -3, Kind: AttrKeyAttachment, Text: attachB.Text},
			{Seq: -4, Kind: AttrKeyCover, Text: cover.Text},
			{Seq: -5, Kind: AttrKeyInstructor, Text: instructor.Text},
		}, false},
		{"附件 text 降序占递减 seq", []AttrSlot{
			{Seq: -1, Kind: AttrKeyAttachment, Text: attachB.Text},
			{Seq: -2, Kind: AttrKeyAttachment, Text: attachA.Text},
			cover, instructor,
		}, false},
	}
	for _, c := range cases {
		if got := AttrSeqsCanonical(c.in); got != c.want {
			t.Fatalf("%s: got=%v want=%v in=%+v", c.name, got, c.want, c.in)
		}
	}
}

func TestIsAttrKind(t *testing.T) {
	if !IsAttrKind(AttrKeyCover) || !IsAttrKind(AttrKeyBodyMD) {
		t.Fatal("六种属性 kind 均应通过")
	}
	for _, k := range []string{AttrKeyBadge, AttrKeyTitleColor} {
		if !IsAttrKind(k) {
			t.Fatalf("新增 kind 应通过: %q", k)
		}
	}
	for _, k := range []string{"", "attr.", "attr.unknown", "digest", "lesson", "article"} {
		if IsAttrKind(k) {
			t.Fatalf("应非法: %q", k)
		}
	}
}