import { attrsOf } from './container-view';
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

/** 课时在课程里的位置：{ cur: 位次(1基), total: 课时总数 }；不在清单里返回 null */
export function lessonPosition(segs: SegmentRow[], lessonId: string): { cur: number; total: number } | null {
  const list = childrenOf(segs);
  const idx = list.indexOf(lessonId);
  if (idx < 0) return null;
  return { cur: idx + 1, total: list.length };
}

/** 课时的上下讲 itemId：{ prev, next }；边界到了就 null */
export function prevNextLesson(segs: SegmentRow[], lessonId: string): { prev: string | null; next: string | null } {
  const list = childrenOf(segs);
  const idx = list.indexOf(lessonId);
  if (idx < 0) return { prev: null, next: null };
  return { prev: idx > 0 ? list[idx - 1]! : null, next: idx < list.length - 1 ? list[idx + 1]! : null };
}

/** 同课程其他讲（排除当前），保持清单位次，取前 topN（默认 5） */
export function relatedLessons(segs: SegmentRow[], lessonId: string, topN = 5): string[] {
  const list = childrenOf(segs);
  return list.filter((id) => id !== lessonId).slice(0, topN);
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

/** 分组读取产物：一个分类（slug + 组标题 + 其下课程）。 */
export interface CategoryGroup {
  slug: string;
  title: string;
  courses: ItemRow[];
}

const CATEGORY_PREFIX = 'category/';

/**
 * 课程分组读取（册子 #49 §3）：**双来源 + 优先级**。
 * 高优先 = 课程自身 `attr.category`（有则以它为准，该课程不再出现在清单行给的其它分类里）；
 * 低优先 = 导入器产 `category/<slug>` 的 `seq>=1` 清单行（`course/<cid>`）——**缺失才回退**。
 * 组标题优先取**已存在的** `category/<slug>` 容器的 `title`，容器不存在（或 title 为空）回落 slug 本身。
 * 两来源都未归入的课程进 `unclassified`；清单行悬空引用静默跳过。**只读**：不写库、不改清单、不发请求。
 */
export function groupCoursesByCategory(
  items: ItemRow[],
  segsByItemId: Map<string, SegmentRow[]>,
): { groups: CategoryGroup[]; unclassified: ItemRow[] } {
  const titleBySlug = new Map<string, string>();
  const slugByListedCourse = new Map<string, string>();
  for (const cat of splitCategories(items)) {
    if (!cat.itemId.startsWith(CATEGORY_PREFIX)) continue;
    const slug = cat.itemId.slice(CATEGORY_PREFIX.length);
    titleBySlug.set(slug, cat.title);
    for (const listedId of childrenOf(segsByItemId.get(cat.itemId) ?? [])) {
      if (!slugByListedCourse.has(listedId)) slugByListedCourse.set(listedId, slug);
    }
  }

  const bySlug = new Map<string, ItemRow[]>();
  const unclassified: ItemRow[] = [];
  for (const course of splitCourses(items).courses) {
    const slug = attrsOf(segsByItemId.get(course.itemId) ?? []).category || slugByListedCourse.get(course.itemId) || '';
    if (slug === '') {
      unclassified.push(course);
      continue;
    }
    const bucket = bySlug.get(slug);
    if (bucket) bucket.push(course);
    else bySlug.set(slug, [course]);
  }

  const groups: CategoryGroup[] = [...bySlug.keys()]
    .sort()
    .map((slug) => ({ slug, title: titleBySlug.get(slug) || slug, courses: bySlug.get(slug) as ItemRow[] }));
  return { groups, unclassified };
}
