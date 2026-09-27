// Package importer 提供 P0 的本地 markdown 内容导入（一次性工具路径，
// 与 tools/migrate 的 Strapi 导入共用 store 写入语义：以 (source,item_id) 为幂等键）。
package importer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// Doc 是一篇待导入的文章。
type Doc struct {
	Slug         string
	Title        string
	Digest       string
	PublishedAt  string
	Course       string
	CourseTitle  string
	CourseDigest string
	Lesson       string
	LessonTitle  string
	LessonDigest string
	Order        string
	Tags         []string
	Body         string
}

// Result 是导入统计。
type Result struct {
	Imported int
	Failed   int
	Errors   []string
}

// Options 是 Run 的行为开关。
type Options struct {
	// RetireLegacy 把仍为 active 的旧形态（item_id 含 ':'）条目一次性墓碑退役（册子 §2.2），默认 false。
	RetireLegacy bool
}

// ParseMD 解析带可选 front-matter 的 markdown。
// front-matter：首行 --- 起、到下一个独立 --- 行止，内容为 `key: value`。
func ParseMD(filename string, raw []byte) (Doc, error) {
	meta, body := SplitFrontMatter(raw)
	body = strings.Trim(body, "\n")
	if body == "" {
		return Doc{}, fmt.Errorf("importer: %s 正文为空", filename)
	}
	stem := strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename))
	doc := Doc{
		Slug:         meta["slug"],
		Title:        meta["title"],
		Digest:       meta["digest"],
		PublishedAt:  meta["published_at"],
		Course:       strings.TrimSpace(meta["course"]),
		CourseTitle:  meta["course_title"],
		CourseDigest: meta["course_digest"],
		Lesson:       strings.TrimSpace(meta["lesson"]),
		LessonTitle:  meta["lesson_title"],
		LessonDigest: meta["lesson_digest"],
		Order:        strings.TrimSpace(meta["order"]),
		Body:         body,
	}
	if doc.Slug == "" {
		doc.Slug = stem
	}
	if doc.Title == "" {
		if first := strings.SplitN(body, "\n", 2)[0]; strings.HasPrefix(first, "# ") {
			doc.Title = strings.TrimSpace(strings.TrimPrefix(first, "# "))
			doc.Body = strings.Trim(strings.TrimSpace(strings.SplitN(body, "\n", 2)[1]), "\n")
			body = doc.Body
		} else {
			doc.Title = stem
		}
	}
	if t := meta["tags"]; t != "" {
		for _, part := range strings.Split(t, ",") {
			if p := strings.TrimSpace(part); p != "" {
				doc.Tags = append(doc.Tags, p)
			}
		}
	}
	if doc.PublishedAt == "" {
		doc.PublishedAt = "1970-01-01T00:00:00Z"
	}
	if doc.Digest == "" {
		doc.Digest = firstLine(body)
	}
	return doc, nil
}

// SplitFrontMatter 拆出 front-matter（`key: value`）与剩余正文；正文未做首尾裁剪。
// 文章与题库共用这一段解析，避免两套 front-matter 规则漂移。
func SplitFrontMatter(raw []byte) (map[string]string, string) {
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	meta := map[string]string{}
	body := text
	if !strings.HasPrefix(text, "---\n") {
		return meta, body
	}
	rest := text[len("---\n"):]
	idx := strings.Index(rest, "\n---\n")
	if idx < 0 {
		return meta, body
	}
	block := rest[:idx]
	body = rest[idx+len("\n---\n"):]
	for _, line := range strings.Split(block, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		meta[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
	}
	return meta, body
}

func firstLine(body string) string {
	line := strings.SplitN(body, "\n", 2)[0]
	line = strings.TrimSpace(strings.TrimPrefix(line, "# "))
	runes := []rune(line)
	if len(runes) > 80 {
		line = string(runes[:80])
	}
	return line
}

// parsedMD 是 Run 阶段 1 的解析产物（此时还未写库）。
type parsedMD struct {
	name                                                 string
	raw                                                  []byte
	kind                                                 string // article | quiz
	p                                                    placement
	doc                                                  Doc // kind == article 时有意义
	courseTitle, courseDigest, lessonTitle, lessonDigest string
}

// Run 导入目录下全部 *.md（按文件名升序），幂等覆盖同 slug 条目。
// 两阶段：先解析全部文件与归属（任何失败只计 Errors、跳过该文件，不整批失败），
// 再写载体、合并式重建受影响容器，最后可选退役旧形态条目。
func Run(st *store.Store, dir string, opts Options) (Result, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return Result{}, fmt.Errorf("importer: read dir %s: %w", dir, err)
	}
	names := []string{}
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".md") {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)

	res := Result{}

	// 阶段 1：解析 + 归属，先不写任何库。
	items := []parsedMD{}
	for _, name := range names {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			res.Failed++
			res.Errors = append(res.Errors, name+": "+err.Error())
			continue
		}
		meta, _ := SplitFrontMatter(raw)
		it := parsedMD{
			name: name, raw: raw,
			courseTitle: meta["course_title"], courseDigest: meta["course_digest"],
			lessonTitle: meta["lesson_title"], lessonDigest: meta["lesson_digest"],
		}
		if meta["type"] == "quiz" {
			q, err := ParseQuiz(name, raw)
			if err != nil {
				res.Failed++
				res.Errors = append(res.Errors, name+": "+err.Error())
				continue
			}
			p, err := resolvePlacement(meta, "quiz", q.Slug, name)
			if err != nil {
				res.Failed++
				res.Errors = append(res.Errors, name+": "+err.Error())
				continue
			}
			it.kind, it.p = "quiz", p
		} else {
			doc, err := ParseMD(name, raw)
			if err != nil {
				res.Failed++
				res.Errors = append(res.Errors, name+": "+err.Error())
				continue
			}
			p, err := resolvePlacement(meta, "article", doc.Slug, name)
			if err != nil {
				res.Failed++
				res.Errors = append(res.Errors, name+": "+err.Error())
				continue
			}
			it.kind, it.p, it.doc = "article", p, doc
		}
		items = append(items, it)
	}

	// 阶段 2：写全部载体。
	for _, it := range items {
		var err error
		if it.kind == "quiz" {
			err = importQuiz(st, it.name, it.raw, it.p)
		} else {
			err = upsertArticleDoc(st, it.p.ItemID, it.doc)
		}
		if err != nil {
			res.Failed++
			res.Errors = append(res.Errors, it.name+": "+err.Error())
			continue
		}
		res.Imported++
	}

	// 阶段 3：合并式重建受影响容器。
	for _, e := range rebuildContainers(st, items) {
		res.Failed++
		res.Errors = append(res.Errors, e)
	}

	// 阶段 4：一次性退役旧形态（item_id 含 ':'）条目。
	if opts.RetireLegacy {
		rev, err := st.NextContentVersion()
		if err != nil {
			return res, err
		}
		active, err := st.ListItems("active")
		if err != nil {
			return res, err
		}
		for _, it := range active {
			if !strings.Contains(it.ItemID, ":") {
				continue
			}
			if err := st.RetireItem(it.ItemID, rev); err != nil {
				res.Failed++
				res.Errors = append(res.Errors, it.ItemID+": 退役失败: "+err.Error())
			}
		}
	}
	return res, nil
}

// rebuildContainers 按 (course, lesson) 归组做合并式重建（册子 §4.2 规则 6）：
// 先重建全部课时容器，再重建受影响课程容器（lesson id 升序）。返回失败明细，不整批失败。
func rebuildContainers(st *store.Store, items []parsedMD) []string {
	type lessonKey struct{ course, lesson string }

	groups := map[lessonKey][]placement{}
	lessonTitle := map[lessonKey]string{}
	lessonDigest := map[lessonKey]string{}
	courseTitle := map[string]string{}
	courseDigest := map[string]string{}
	for _, it := range items {
		if it.p.Course == "" {
			continue
		}
		k := lessonKey{it.p.Course, it.p.Lesson}
		groups[k] = append(groups[k], it.p)
		// title / digest 取该 course/lesson 下第一个非空声明值（items 已按文件名升序）。
		if lessonTitle[k] == "" {
			lessonTitle[k] = it.lessonTitle
		}
		if lessonDigest[k] == "" {
			lessonDigest[k] = it.lessonDigest
		}
		if courseTitle[it.p.Course] == "" {
			courseTitle[it.p.Course] = it.courseTitle
		}
		if courseDigest[it.p.Course] == "" {
			courseDigest[it.p.Course] = it.courseDigest
		}
	}

	keys := make([]lessonKey, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].course != keys[j].course {
			return keys[i].course < keys[j].course
		}
		return keys[i].lesson < keys[j].lesson
	})

	errs := []string{}
	courseLessons := map[string][]string{} // cid → lesson item_id（lid 升序）
	for _, k := range keys {
		declared := sortDeclared(groups[k])
		children := make([]string, 0, len(declared))
		for _, p := range declared {
			children = append(children, p.ItemID)
		}
		lessonID := fmt.Sprintf("course/%s/lesson/%s", k.course, k.lesson)
		title := lessonTitle[k]
		if title == "" {
			title = k.lesson
		}
		if err := rebuildContainer(st, lessonID, "lesson", "lesson", title, lessonDigest[k], children); err != nil {
			errs = append(errs, lessonID+": "+err.Error())
		}
		courseLessons[k.course] = append(courseLessons[k.course], lessonID)
	}

	cids := make([]string, 0, len(courseLessons))
	for cid := range courseLessons {
		cids = append(cids, cid)
	}
	sort.Strings(cids)
	for _, cid := range cids {
		courseID := "course/" + cid
		title := courseTitle[cid]
		if title == "" {
			title = cid
		}
		if err := rebuildContainer(st, courseID, "course", "course", title, courseDigest[cid], courseLessons[cid]); err != nil {
			errs = append(errs, courseID+": "+err.Error())
		}
	}
	return errs
}

// upsertArticleDoc 把一个解析好的文章写进内容库（口径与既有实现一致）。
func upsertArticleDoc(st *store.Store, itemID string, doc Doc) error {
	tags := doc.Tags
	if tags == nil {
		tags = []string{}
	}
	tagsJSON, err := json.Marshal(tags)
	if err != nil {
		return err
	}
	hash := protocol.SHA256Hex([]byte(doc.Body))
	return st.UpsertArticle(store.Article{
		ItemID:      itemID,
		Title:       doc.Title,
		Digest:      doc.Digest,
		PublishedAt: doc.PublishedAt,
		TagsJSON:    string(tagsJSON),
		BodyMD:      doc.Body,
		ContentHash: hash,
		SourceRev:   hash[:16],
	})
}

// importQuiz 把一份题库写进内容库：item_id 取归属解析结果、type = quiz。
// content_hash 与 articles 同口径：hex(sha256(question_json 的 UTF-8 字节))，不走 canonicalize。
func importQuiz(st *store.Store, filename string, raw []byte, p placement) error {
	q, err := ParseQuiz(filename, raw)
	if err != nil {
		return err
	}
	doc := QuestionDoc{SchemaVersion: 1, Questions: q.Questions}
	questionJSON, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	hash := protocol.SHA256Hex(questionJSON)
	return st.UpsertQuiz(store.Quiz{
		ItemID:       p.ItemID,
		Title:        q.Title,
		QuestionJSON: string(questionJSON),
		ContentHash:  hash,
		SourceRev:    hash[:16],
	})
}
