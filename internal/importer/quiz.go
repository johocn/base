package importer

import (
	"fmt"
	"path/filepath"
	"strings"
)

// Question 是 question_json 里的一道题（spec §6.2）。键名即契约，勿改。
type Question struct {
	Q       string   `json:"q"`
	Options []string `json:"options"`
	Answer  int      `json:"answer"`
	Explain string   `json:"explain"`
}

// QuestionDoc 是一个题组的完整 question_json。
type QuestionDoc struct {
	SchemaVersion int        `json:"schema_version"`
	Questions     []Question `json:"questions"`
}

// Quiz 是一份待导入的题库。
type Quiz struct {
	Slug      string
	Title     string
	Questions []Question
}

// ParseQuiz 解析 front-matter 带 `type: quiz` 的 markdown（spec §6.1 的固定语法）。
// 语法：`### ` 题干 / `- ` 选项（`- [x] ` 为正确答案）/ `> ` 解析。
// 失败语义：整份文件拒绝，不做部分导入。
func ParseQuiz(filename string, raw []byte) (Quiz, error) {
	meta, body := SplitFrontMatter(raw)
	body = strings.Trim(body, "\n")
	if body == "" {
		return Quiz{}, fmt.Errorf("importer: %s 正文为空", filename)
	}
	stem := strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename))
	q := Quiz{Slug: meta["slug"], Title: meta["title"]}
	if q.Slug == "" {
		q.Slug = stem
	}
	if q.Title == "" {
		q.Title = q.Slug
	}
	questions, err := parseQuestions(filename, body)
	if err != nil {
		return Quiz{}, err
	}
	q.Questions = questions
	return q, nil
}

func parseQuestions(filename, body string) ([]Question, error) {
	out := []Question{}
	var cur *Question
	flush := func() error {
		if cur == nil {
			return nil
		}
		if len(cur.Options) < 2 {
			return fmt.Errorf("importer: %s 题目「%s」至少两个选项，实际 %d 个", filename, cur.Q, len(cur.Options))
		}
		if cur.Answer < 0 {
			return fmt.Errorf("importer: %s 题目「%s」必须有恰好一个正确答案", filename, cur.Q)
		}
		out = append(out, *cur)
		cur = nil
		return nil
	}
	for _, rawLine := range strings.Split(body, "\n") {
		line := strings.TrimSpace(rawLine)
		switch {
		case strings.HasPrefix(line, "### "):
			if err := flush(); err != nil {
				return nil, err
			}
			cur = &Question{Q: strings.TrimSpace(strings.TrimPrefix(line, "### ")), Answer: -1}
		case strings.HasPrefix(line, "> "):
			if cur == nil {
				return nil, fmt.Errorf("importer: %s 解析行出现在题目之前: %s", filename, line)
			}
			ex := strings.TrimSpace(strings.TrimPrefix(line, "> "))
			if cur.Explain == "" {
				cur.Explain = ex
			} else {
				cur.Explain += "\n" + ex
			}
		case strings.HasPrefix(line, "- "):
			if cur == nil {
				return nil, fmt.Errorf("importer: %s 选项出现在题目之前: %s", filename, line)
			}
			item := strings.TrimSpace(strings.TrimPrefix(line, "- "))
			switch {
			case strings.HasPrefix(item, "[x] "), strings.HasPrefix(item, "[X] "):
				if cur.Answer >= 0 {
					return nil, fmt.Errorf("importer: %s 题目「%s」有多个正确答案", filename, cur.Q)
				}
				cur.Answer = len(cur.Options)
				item = strings.TrimSpace(item[4:])
			case strings.HasPrefix(item, "[ ] "):
				item = strings.TrimSpace(item[4:])
			}
			if item == "" {
				return nil, fmt.Errorf("importer: %s 题目「%s」有空选项", filename, cur.Q)
			}
			cur.Options = append(cur.Options, item)
		case line == "":
			// 空行只作分隔
		default:
			// 题目开始前的普通文本视作前言，忽略；题目块内无法识别的行才报错。
			if cur != nil {
				return nil, fmt.Errorf("importer: %s 无法识别的行: %s", filename, line)
			}
		}
	}
	if err := flush(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("importer: %s 没有解析到任何题目", filename)
	}
	return out, nil
}
