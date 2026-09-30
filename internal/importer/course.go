package importer

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// errSubmittedContainer 表示目标容器属于投稿域（items.author_id 非空），导入器一律不覆盖。
// 它不是失败：调用方把它转成 Result.Warnings（本册 §6.3）。
var errSubmittedContainer = errors.New("importer: 投稿域容器，导入器不覆盖")

// isSubmittedContainer 判定一个容器是否已由投稿登记（author_id 非空）。
// 空归属的存量容器（导入器自建）返回 false，故导入器仍可重建它们（本册 §2.1 占用口径）。
func isSubmittedContainer(st *store.Store, itemID string) (bool, error) {
	it, ok, err := st.GetItem(itemID)
	if err != nil {
		return false, err
	}
	return ok && it.AuthorID != "", nil
}

// placement 是一个载体（article / video / quiz）的归属解析结果（册子 §4.2）。
type placement struct {
	ItemID   string
	Course   string // 空 = 未归类
	Lesson   string
	Order    string // 空 = 缺省（排在该课时清单末尾）
	Filename string // order 相同时的次序键
}

// resolvePlacement 按 front-matter 算载体 item_id（册子 §2.1 / §4.2 规则 1–3）。
// kind ∈ {article, video, quiz}；只有 article 允许无 course。
func resolvePlacement(meta map[string]string, kind, slug, filename string) (placement, error) {
	course := strings.TrimSpace(meta["course"])
	lesson := strings.TrimSpace(meta["lesson"])
	p := placement{Course: course, Lesson: lesson, Order: strings.TrimSpace(meta["order"]), Filename: filename}
	if course == "" {
		if kind != "article" {
			return placement{}, fmt.Errorf("importer: %s 的 %s 缺少 front-matter `course`（无顶层 %s 命名空间）", filename, kind, kind)
		}
		p.ItemID = "article/" + slug
		return p, nil
	}
	if lesson == "" {
		return placement{}, fmt.Errorf("importer: %s 声明了 course=%s 但缺少 lesson（不允许只有课程没有课时的载体）", filename, course)
	}
	p.ItemID = fmt.Sprintf("course/%s/lesson/%s/%s/%s", course, lesson, kind, slug)
	return p, nil
}

// validateCategories 是导入器侧的**硬校验**（册子 §3.4），必须在任何写库之前执行，
// 失败即整批退出、不产出任何包——静默取其一会让「哪一份声明生效」取决于文件遍历顺序，
// 产生不可复现的导出结果。
//
// 三条判定：
//  1. `category` 非空时必须是合法 slug（契约级 protocol.ValidSlug）；
//  2. 声明了 `category` 就必须有 `course`（分类只承载课程归属，孤立分类是配置错误）；
//  3. 一个 course 至多属一个分类——出现两个不同的非空 category 即报错。
//     空 category 不参与判定：它就是「该课程进未归类」，不是第二个分类。
func validateCategories(items []parsedMD) error {
	seen := map[string]string{}
	for _, it := range items {
		if it.category == "" {
			continue
		}
		if !protocol.ValidSlug(it.category) {
			return fmt.Errorf("importer: %s 的 front-matter `category=%s` 不是合法 slug（[a-z0-9][a-z0-9-]{0,63}）", it.name, it.category)
		}
		if it.p.Course == "" {
			return fmt.Errorf("importer: %s 声明了 category=%s 但没有 course（分类只承载课程归属）", it.name, it.category)
		}
		if prev, ok := seen[it.p.Course]; ok && prev != it.category {
			return fmt.Errorf("importer: 课程 %s 同时声明了分类 %s 与 %s（一个课程至多属一个分类，册子 §3.4）", it.p.Course, prev, it.category)
		}
		seen[it.p.Course] = it.category
	}
	return nil
}

// mergeChildren 是容器清单的合并式重算（册子 §4.2 规则 6 的落地口径）：
// 结果是「本次 Run 声明的子项（已确定性排序）」+「既有但本次未声明的子项（保持原相对顺序）」。
// 这样 import-video 产出的 video 行不会被 md 重建删掉，且重复执行幂等。
func mergeChildren(existing, declared []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(declared)+len(existing))
	for _, id := range declared {
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	for _, id := range existing {
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// sortDeclared 按 (order 升序, order 缺省排最后, 文件名升序) 排序（册子 §4.2 规则 3）。
func sortDeclared(items []placement) []placement {
	out := append([]placement{}, items...)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		ao, bo := a.Order == "", b.Order == ""
		if ao != bo {
			return !ao // 有 order 的在前
		}
		if a.Order != b.Order {
			return a.Order < b.Order
		}
		return a.Filename < b.Filename
	})
	return out
}

// childIDsOf 取出既有 segments 里的子项 id（seq>=1）。
func childIDsOf(segs []store.Segment) []string {
	out := []string{}
	for _, s := range segs {
		if s.Seq >= 1 {
			out = append(out, s.Text)
		}
	}
	return out
}

// digestTextOf 取既有 seq=0 行的 text（缺省返回空串）。
func digestTextOf(segs []store.Segment) string {
	for _, s := range segs {
		if s.Seq == 0 {
			return s.Text
		}
	}
	return ""
}

// attrSegsOf 取既有 segments 里的属性行（seq<0），按 seq 升序原样返回（本册 §2.1 铁律 1）。
// 重建容器时这些行必须原样保留：它们是课程 / 课时的封面、讲师、难度等字段的唯一载体。
func attrSegsOf(segs []store.Segment) []store.Segment {
	out := []store.Segment{}
	for _, s := range segs {
		if s.Seq < 0 {
			out = append(out, s)
		}
	}
	return out
}

// rebuildContainer 合并式重建一个容器条目的 segments。
// children 为本次 Run 声明的子项（已排序），digest 为空则省略 seq=0 行。
func rebuildContainer(st *store.Store, itemID, source, typ, title, digest string, children []string) error {
	submitted, err := isSubmittedContainer(st, itemID)
	if err != nil {
		return err
	}
	if submitted {
		return errSubmittedContainer
	}
	existing, err := st.ListSegments(itemID)
	if err != nil {
		return err
	}
	merged := mergeChildren(childIDsOf(existing), children)
	segs := attrSegsOf(existing) // 先搬既有属性行，再拼 seq=0 与 seq>=1
	seq := 1
	if digest != "" {
		segs = append(segs, store.Segment{Seq: 0, Kind: "digest", Text: digest})
	}
	for _, id := range merged {
		segs = append(segs, store.Segment{Seq: seq, Kind: kindOf(id), Text: id})
		seq++
	}
	if title == "" {
		title = itemID
	}
	return st.UpsertSegmentItem(store.SegmentItem{ItemID: itemID, Source: source, Type: typ, Title: title, Segments: segs})
}

// kindOf 从子项 item_id 的倒数第二段取 kind（course/c1/lesson/l1/video/v1 → video）。
func kindOf(itemID string) string {
	parts := strings.Split(itemID, "/")
	if len(parts) < 2 {
		return ""
	}
	return parts[len(parts)-2]
}

// rebuildCategories 全量重算分类容器（册子 §3.1 / §3.2）。
//
// 与 lesson / course 容器**刻意不同**：分类清单是「本 Run 声明」的快照，**不做 mergeChildren 合并**。
// 合并会让课程换分类后仍留在旧分类清单里（AC 3 失败），也会让悬空的 course 引用永久沉淀。
//
// 覆盖集合 = 本 Run 声明的分类 ∪ 库中既有的分类：
// 未被声明的既有分类被重写成「无课程行」的容器（title / digest 沿用既有），
// 手机端跳过空清单分类（册子 §5.2），故不会出现空分组。
// 返回失败明细，不整批失败（与 rebuildContainers 同口径）。
func rebuildCategories(st *store.Store, items []parsedMD) []string {
	bySlug := map[string][]string{} // slug → cid
	title := map[string]string{}
	digest := map[string]string{}
	seen := map[string]bool{} // "<slug>/<cid>"：同一分类下的同一课程只收一次
	for _, it := range items {
		if it.p.Course == "" || it.category == "" {
			continue
		}
		if key := it.category + "/" + it.p.Course; !seen[key] {
			seen[key] = true
			bySlug[it.category] = append(bySlug[it.category], it.p.Course)
		}
		if title[it.category] == "" {
			title[it.category] = it.categoryTitle
		}
		if digest[it.category] == "" {
			digest[it.category] = it.categoryDigest
		}
	}

	existing, err := st.ListItems("active")
	if err != nil {
		return []string{"列出既有分类失败: " + err.Error()}
	}
	slugs := map[string]bool{}
	for slug := range bySlug {
		slugs[slug] = true
	}
	for _, it := range existing {
		if it.Source != "category" || !strings.HasPrefix(it.ItemID, "category/") {
			continue
		}
		slug := strings.TrimPrefix(it.ItemID, "category/")
		slugs[slug] = true
		if title[slug] == "" {
			title[slug] = it.Title
		}
	}

	ordered := make([]string, 0, len(slugs))
	for slug := range slugs {
		ordered = append(ordered, slug)
	}
	sort.Strings(ordered)

	errs := []string{}
	for _, slug := range ordered {
		itemID := "category/" + slug
		existingSegs, err := st.ListSegments(itemID)
		if err != nil {
			errs = append(errs, itemID+": "+err.Error())
			continue
		}
		if digest[slug] == "" {
			digest[slug] = digestTextOf(existingSegs)
		}
		courses := append([]string{}, bySlug[slug]...)
		sort.Strings(courses)

		segs := attrSegsOf(existingSegs)
		seq := 1
		if digest[slug] != "" {
			segs = append(segs, store.Segment{Seq: 0, Kind: "digest", Text: digest[slug]})
		}
		for _, cid := range courses {
			segs = append(segs, store.Segment{Seq: seq, Kind: "course", Text: "course/" + cid})
			seq++
		}
		t := title[slug]
		if t == "" {
			t = slug
		}
		if err := st.UpsertSegmentItem(store.SegmentItem{
			ItemID: itemID, Source: "category", Type: "category", Title: t, Segments: segs,
		}); err != nil {
			errs = append(errs, itemID+": "+err.Error())
		}
	}
	return errs
}

// ensureLessonChild 把一个载体 id 并入课时清单（import-video 用）。
// 既有课时容器存在时沿用其 title 与 seq=0 digest，避免视频导入冲掉 md 设好的 lesson_title。
func ensureLessonChild(st *store.Store, course, lesson, childID string) error {
	lessonID := fmt.Sprintf("course/%s/lesson/%s", course, lesson)
	title, digest := lesson, ""
	if it, ok, err := st.GetItem(lessonID); err != nil {
		return err
	} else if ok && it.Title != "" {
		title = it.Title
	}
	existing, err := st.ListSegments(lessonID)
	if err != nil {
		return err
	}
	digest = digestTextOf(existing)
	return rebuildContainer(st, lessonID, "lesson", "lesson", title, digest, []string{childID})
}
