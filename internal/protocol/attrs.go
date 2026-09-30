package protocol

import "sort"

// 属性行的 kind 取值域（本册 §2.1 槽位表）：seq<0 只放属性行，kind 必以 "attr." 开头。
const (
	AttrKindPrefix = "attr."

	AttrKeyAttachment = "attr.attachment"
	AttrKeyBodyMD     = "attr.body_md"
	AttrKeyCategory   = "attr.category"
	AttrKeyCover      = "attr.cover"
	AttrKeyDifficulty = "attr.difficulty"
	AttrKeyDuration   = "attr.duration"
	AttrKeyInstructor = "attr.instructor"

	// 难度枚举（本册 §2.1）。
	DifficultyIntro    = "intro"
	DifficultyBasic    = "basic"
	DifficultyAdvanced = "advanced"

	// DigestKind 是 seq=0 的简介行 kind（既有约定，一字不改）。
	DigestKind = "digest"
)

// AttrKindSet 是属性行的合法 kind 集合；只有落在这里的 kind 才算属性行。
var AttrKindSet = map[string]bool{
	AttrKeyAttachment: true,
	AttrKeyBodyMD:     true,
	AttrKeyCategory:   true,
	AttrKeyCover:      true,
	AttrKeyDifficulty: true,
	AttrKeyDuration:   true,
	AttrKeyInstructor: true,
}

// IsAttrKind 判定 kind 是否为合法属性行（本册 §2.1 铁律 1）。
func IsAttrKind(kind string) bool { return AttrKindSet[kind] }

// AttrLine 是一条待分配 seq 的属性行；AttrSlot 是分配后的结果。
type AttrLine struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}

type AttrSlot struct {
	Seq  int    `json:"seq"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}

// AssignAttrSeqs 按本册 §2.1 铁律 2 为属性行分配 seq<0：
//  1. 按 kind **字典序**从 -1 起递减；
//  2. 同一 kind 至多一行，唯 attr.attachment 可多行——多行占**连续递减区间**，
//     同一 kind 内按 text（含 `<blob_id>\t<文件名>` 的整串）升序映射到递减 seq。
//
// 返回值按 seq **降序**（第一个元素 seq 最大 = -1）。这是确定性导出的前提：
// 任何一端改了顺序，双端 content_hash 立刻漂移且不会报错（本册 §8 风险 2）。
// 调用方不必按这个顺序传回：AttrSeqsCanonical 与入参数组顺序无关。
func AssignAttrSeqs(lines []AttrLine) []AttrSlot {
	byKind := map[string][]string{}
	kinds := make([]string, 0, len(lines))
	for _, l := range lines {
		if _, ok := byKind[l.Kind]; !ok {
			kinds = append(kinds, l.Kind)
		}
		byKind[l.Kind] = append(byKind[l.Kind], l.Text)
	}
	sort.Strings(kinds)
	out := make([]AttrSlot, 0, len(lines))
	next := -1
	for _, k := range kinds {
		texts := byKind[k]
		if k == AttrKeyAttachment {
			sorted := append([]string{}, texts...)
			sort.Strings(sorted)
			for _, t := range sorted {
				out = append(out, AttrSlot{Seq: next, Kind: k, Text: t})
				next--
			}
			continue
		}
		if len(texts) == 0 {
			continue
		}
		out = append(out, AttrSlot{Seq: next, Kind: k, Text: texts[0]})
		next--
	}
	return out
}

// AttrSeqsCanonical 报告一组属性行是否已按 AssignAttrSeqs 的规则排布，**与入参数组顺序无关**：
// 两侧都按 seq 升序对齐后逐行比对。判据强度不降——seq 取值、attachment 的连续递减区间、
// 同 kind 内 text 升序仍须逐字节吻合，只是不再要求调用方把行按哪个方向传进来。
func AttrSeqsCanonical(slots []AttrSlot) bool {
	lines := make([]AttrLine, 0, len(slots))
	for _, s := range slots {
		lines = append(lines, AttrLine{Kind: s.Kind, Text: s.Text})
	}
	want := AssignAttrSeqs(lines)
	if len(want) != len(slots) {
		return false
	}
	got := append([]AttrSlot{}, slots...)
	sort.Slice(got, func(i, j int) bool { return got[i].Seq < got[j].Seq })
	sort.Slice(want, func(i, j int) bool { return want[i].Seq < want[j].Seq })
	for i := range want {
		if want[i] != got[i] {
			return false
		}
	}
	return true
}