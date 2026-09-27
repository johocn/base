package importer

import (
	"fmt"
	"sort"
	"strings"

	"github.com/johocn/base/internal/store"
)

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

// rebuildContainer 合并式重建一个容器条目的 segments。
// children 为本次 Run 声明的子项（已排序），digest 为空则省略 seq=0 行。
func rebuildContainer(st *store.Store, itemID, source, typ, title, digest string, children []string) error {
	existing, err := st.ListSegments(itemID)
	if err != nil {
		return err
	}
	merged := mergeChildren(childIDsOf(existing), children)
	segs := []store.Segment{}
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
