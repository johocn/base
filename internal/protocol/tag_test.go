package protocol

import "testing"

func TestTagItemIDAndTitle(t *testing.T) {
	cases := []struct {
		name, chapter, section string
		wantID                 string
		wantOK                 bool
	}{
		{"甲", "第一章", "第一节", "tag/甲/第一章/第一节", true},
		{"甲/乙", "第一章", "第一节", "tag/甲%2F乙/第一章/第一节", true},
		{"甲\\乙", "第一章", "第一节", "tag/甲%5C乙/第一章/第一节", true},
		{"100%", "第一章", "第一节", "tag/100%25/第一章/第一节", true},
		{"  甲  ", " 第一章 ", "第一节", "tag/甲/第一章/第一节", true}, // 去首尾空白（本册口径收窄：不做 NFC）
		{"", "第一章", "第一节", "", false},                        // 空段
		{"  ", "第一章", "第一节", "", false},                       // 全空白段
		{"甲", "第一章", "第一节"[:0], "", false},                    // 空节
	}
	for _, c := range cases {
		got, ok := TagItemID(c.name, c.chapter, c.section)
		if ok != c.wantOK || got != c.wantID {
			t.Errorf("TagItemID(%q,%q,%q) = (%q,%v), want (%q,%v)", c.name, c.chapter, c.section, got, ok, c.wantID, c.wantOK)
		}
	}
	if got := TagTitle("  甲 ", "第一章", "第一节"); got != "甲 · 第一章 · 第一节" {
		t.Errorf("TagTitle = %q", got)
	}
}

func TestTagItemIDMaxRunes(t *testing.T) {
	long := ""
	for i := 0; i < 64; i++ {
		long += "甲"
	}
	if _, ok := TagItemID(long, "章", "节"); !ok {
		t.Fatal("64 rune 应通过")
	}
	if _, ok := TagItemID(long+"甲", "章", "节"); ok {
		t.Fatal("65 rune 应拒绝")
	}
}

func TestParseTagItemIDRoundTrip(t *testing.T) {
	id, ok := TagItemID("甲/乙", "第一章", "第一节")
	if !ok {
		t.Fatal("构造失败")
	}
	name, chapter, section, ok := ParseTagItemID(id)
	if !ok || name != "甲/乙" || chapter != "第一章" || section != "第一节" {
		t.Fatalf("ParseTagItemID(%q) = (%q,%q,%q,%v)", id, name, chapter, section, ok)
	}
	for _, bad := range []string{
		"", "tag", "tag/甲", "tag/甲/第一章", "tag/甲/第一章/第一节/第二节",
		"tag//第一章/第一节", "tag/甲/第一章/%ZZ", "tag/ 甲 /第一章/第一节",
		"article/x", "tag/甲/第一章/第一节\t",
	} {
		if _, _, _, ok := ParseTagItemID(bad); ok {
			t.Errorf("ParseTagItemID(%q) 应失败", bad)
		}
	}
}

func TestTagKindOfTarget(t *testing.T) {
	hex32 := "0123456789abcdef0123456789abcdef"
	cases := map[string]string{
		"course/c1": "course",
		"course/c1/lesson/l1": "lesson",
		"article/a1": "article",
		"quiz/q1":    "quiz",
		"course/c1/lesson/l1/article/a1": "article",
		"course/c1/lesson/l1/quiz/q1":    "quiz",
		"comment/" + hex32: "comment",
		"video/v1": "", "group/g1": "",
		"comment/0123": "",
		"course/c1/lesson/": "",
		"tag/甲/章/节": "",
	}
	for target, want := range cases {
		if got := TagKindOfTarget(target); got != want {
			t.Errorf("TagKindOfTarget(%q) = %q, want %q", target, got, want)
		}
	}
}
