package importer

import (
	"encoding/json"
	"strings"
	"testing"
)

const quizMD = `---
type: quiz
slug: what-is-cid
title: 内容寻址小测
---

### 内容寻址里，一份字节的标识是什么？
- 文件路径
- [x] 内容哈希
- 递增序号
> 标识即哈希，改一个 bit 哈希就变。

### 节点之间需要共识吗？
- [x] 不需要
- 需要
> 不需要：哈希即验真。
`

func TestParseQuiz(t *testing.T) {
	q, err := ParseQuiz("what-is-cid.md", []byte(quizMD))
	if err != nil {
		t.Fatalf("ParseQuiz: %v", err)
	}
	if q.Slug != "what-is-cid" || q.Title != "内容寻址小测" {
		t.Fatalf("front-matter 解析错误: %+v", q)
	}
	if len(q.Questions) != 2 {
		t.Fatalf("题目数 = %d，期望 2", len(q.Questions))
	}
	first := q.Questions[0]
	if first.Q != "内容寻址里，一份字节的标识是什么？" {
		t.Fatalf("题干 = %q", first.Q)
	}
	if len(first.Options) != 3 || first.Options[1] != "内容哈希" {
		t.Fatalf("选项 = %v", first.Options)
	}
	if first.Answer != 1 {
		t.Fatalf("答案下标 = %d，期望 1", first.Answer)
	}
	if first.Explain != "标识即哈希，改一个 bit 哈希就变。" {
		t.Fatalf("解析 = %q", first.Explain)
	}
}

func TestParseQuizRejectsIllegal(t *testing.T) {
	cases := []struct{ name, body, want string }{
		{"选项无正确答案", "### 题\n- 甲\n- 乙\n", "恰好一个正确答案"},
		{"两个正确答案", "### 题\n- [x] 甲\n- [x] 乙\n", "多个正确答案"},
		{"没有题目", "只有一段正文\n", "没有解析到任何题目"},
		{"选项少于两个", "### 题\n- [x] 甲\n", "至少两个选项"},
		{"题目出现在选项之前", "- [x] 甲\n", "选项出现在题目之前"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			md := "---\ntype: quiz\nslug: x\n---\n\n" + c.body
			_, err := ParseQuiz("x.md", []byte(md))
			if err == nil {
				t.Fatalf("期望失败，实际成功")
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("错误 = %q，期望包含 %q", err.Error(), c.want)
			}
		})
	}
}

// QuestionDoc 的 JSON 形状就是 spec §6.2 的 question_json，键名与顺序即契约。
func TestQuestionDocJSONShape(t *testing.T) {
	q, err := ParseQuiz("what-is-cid.md", []byte(quizMD))
	if err != nil {
		t.Fatalf("ParseQuiz: %v", err)
	}
	raw, err := json.Marshal(QuestionDoc{SchemaVersion: 1, Questions: q.Questions})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	want := `{"schema_version":1,"questions":[{"q":"内容寻址里，一份字节的标识是什么？","options":["文件路径","内容哈希","递增序号"],"answer":1,"explain":"标识即哈希，改一个 bit 哈希就变。"},{"q":"节点之间需要共识吗？","options":["不需要","需要"],"answer":0,"explain":"不需要：哈希即验真。"}]}`
	if string(raw) != want {
		t.Fatalf("question_json:\n got %s\nwant %s", raw, want)
	}
}
