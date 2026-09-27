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
