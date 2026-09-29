import type { ItemRow, SegmentRow } from './types';

export interface CourseTree {
  /** 课程容器条目，按 itemId 升序 */
  courses: ItemRow[];
  /** 未归类文章，按既有平铺口径（itemId 升序） */
  ungrouped: ItemRow[];
}

function byItemId(a: ItemRow, b: ItemRow): number {
  return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
}

export function splitCourses(items: ItemRow[]): CourseTree {
  const courses = items.filter((it) => it.type === 'course' && it.itemId.startsWith('course/'));
  const ungrouped = items.filter((it) => it.type === 'article' && !it.itemId.startsWith('course/'));
  return { courses: courses.sort(byItemId), ungrouped: ungrouped.sort(byItemId) };
}

/** 容器的子项 item_id（seq>=1），按 seq 升序 */
export function childrenOf(segs: SegmentRow[]): string[] {
  return [...segs]
    .filter((s) => s.seq >= 1)
    .sort((a, b) => a.seq - b.seq)
    .map((s) => s.text);
}

/** 课时序号：第 N 讲 = 在课程清单里的位次（从 1 计）；不在清单里返回 0 */
export function lessonNo(segs: SegmentRow[], lessonId: string): number {
  const idx = childrenOf(segs).indexOf(lessonId);
  return idx < 0 ? 0 : idx + 1;
}

/** 分类条目：source=category，按 itemId 升序（册子 §5.1）。分类之间无上级容器，故不排序字段。 */
export function splitCategories(items: ItemRow[]): ItemRow[] {
  return items.filter((it) => it.source === 'category').sort(byItemId);
}

/**
 * 一个分类下的课程：按该分类清单的 seq 升序解析 course/<cid>（册子 §3.2）。
 * 悬空引用（清单指向本地不存在的课程）**静默跳过**：不显示、不报错，不是错误状态。
 */
export function coursesOfCategory(catItemId: string, items: ItemRow[], segments: SegmentRow[]): ItemRow[] {
  const byId = new Map(items.map((it) => [it.itemId, it]));
  const own = segments.filter((s) => s.itemId === catItemId);
  const out: ItemRow[] = [];
  for (const id of childrenOf(own)) {
    const row = byId.get(id);
    if (row) out.push(row);
  }
  return out;
}

/**
 * 载体 item_id 所属的课时 id（`course/<cid>/lesson/<lid>`）（册子 §4 文章页入口）。
 * 不属于任何课时（独立文章 / 独立题库 / 课程或课时自身）返回空串。
 */
export function lessonOfCarrier(itemId: string): string {
  const parts = itemId.split('/');
  if (parts.length >= 5 && parts[0] === 'course' && parts[2] === 'lesson') {
    return parts.slice(0, 4).join('/');
  }
  return '';
}
