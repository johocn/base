// `internal/importer/course.go` 的**库访问**部分（宿主层）：容器合并式重建、分类全量重算。
// 纯排序/切分复用 `@base/core-ts` 的 mergeChildren / sortDeclared / childIdsOf / digestTextOf /
// attrSegsOf / kindOf / compareGoString，不重复实现。
import {
  attrSegsOf,
  childIdsOf,
  compareGoString,
  digestTextOf,
  kindOf,
  mergeChildren,
  sortDeclared,
  type MdDoc,
  type Placement,
  type Quiz,
  type SegmentItemInput,
  type StoreItem,
  type StoreSegment,
} from "@base/core-ts";
import type { Store } from "../store/store";

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 对齐 Go 哨兵 `errSubmittedContainer`：目标容器属投稿域（items.author_id 非空），导入器一律不覆盖。 */
export class SubmittedContainerError extends Error {
  constructor() {
    super("importer: 投稿域容器，导入器不覆盖");
    this.name = "SubmittedContainerError";
  }
}

/** Run 阶段 1 的解析产物（对齐 Go `parsedMD`）。 */
export interface ParsedMD {
  name: string;
  raw: string;
  kind: "article" | "quiz";
  p: Placement;
  /** kind == article 时有意义。 */
  doc: MdDoc | null;
  /** kind == quiz 时有意义（阶段 2 复用，避免二次解析）。 */
  quiz: Quiz | null;
  courseTitle: string;
  courseDigest: string;
  lessonTitle: string;
  lessonDigest: string;
  category: string;
  categoryTitle: string;
  categoryDigest: string;
}

/** 判定容器是否已由投稿登记（author_id 非空）；空归属的存量容器仍可被导入器重建。 */
export function isSubmittedContainer(store: Store, itemId: string): boolean {
  const it = store.getItem(itemId);
  return it !== null && it.authorId !== "";
}

/**
 * 合并式重建一个容器条目的 segments（`course.go:160-186`）。
 * children 为本次 Run 声明的子项（已排序），digest 为空则省略 seq=0 行；投稿域抛 `SubmittedContainerError`。
 */
export function rebuildContainer(
  store: Store,
  itemId: string,
  source: string,
  typ: string,
  title: string,
  digest: string,
  children: string[],
): void {
  if (isSubmittedContainer(store, itemId)) throw new SubmittedContainerError();
  const existing = store.listSegments(itemId);
  const merged = mergeChildren(childIdsOf(existing), children);
  const segs: StoreSegment[] = attrSegsOf(existing); // 先搬既有属性行，再拼 seq=0 与 seq>=1
  let seq = 1;
  if (digest !== "") {
    segs.push({ itemId: "", seq: 0, kind: "digest", text: digest, contentHash: "" });
  }
  for (const id of merged) {
    segs.push({ itemId: "", seq, kind: kindOf(id), text: id, contentHash: "" });
    seq++;
  }
  if (title === "") title = itemId;
  const input: SegmentItemInput = { itemId, source, type: typ, title, segments: segs };
  store.upsertSegmentItem(input);
}

/** lessonKey 的键：`<course>\u0000<lesson>`（避免字段拼接歧义）。 */
function lessonKey(course: string, lesson: string): string {
  return course + "\u0000" + lesson;
}

/**
 * 按 (course, lesson) 归组做合并式重建（`md.go:283-366`）：先重建全部课时容器，
 * 再重建受影响课程容器。投稿域转 warns，其余错误转 errs，均不整批失败。
 */
export function rebuildContainers(
  store: Store,
  items: readonly ParsedMD[],
): { errs: string[]; warns: string[] } {
  interface Group {
    course: string;
    lesson: string;
    placements: Placement[];
  }
  const groups = new Map<string, Group>();
  const lessonTitle = new Map<string, string>();
  const lessonDigest = new Map<string, string>();
  const courseTitle = new Map<string, string>();
  const courseDigest = new Map<string, string>();
  for (const it of items) {
    if (it.p.course === "") continue;
    const key = lessonKey(it.p.course, it.p.lesson);
    let g = groups.get(key);
    if (g === undefined) {
      g = { course: it.p.course, lesson: it.p.lesson, placements: [] };
      groups.set(key, g);
    }
    g.placements.push(it.p);
    // title / digest 取该 course/lesson 下第一个非空声明值（items 已按文件名升序）。
    if (!lessonTitle.get(key)) lessonTitle.set(key, it.lessonTitle);
    if (!lessonDigest.get(key)) lessonDigest.set(key, it.lessonDigest);
    if (!courseTitle.get(it.p.course)) courseTitle.set(it.p.course, it.courseTitle);
    if (!courseDigest.get(it.p.course)) courseDigest.set(it.p.course, it.courseDigest);
  }

  const keys = [...groups.entries()].sort((a, b) => {
    const c = compareGoString(a[1].course, b[1].course);
    return c !== 0 ? c : compareGoString(a[1].lesson, b[1].lesson);
  });

  const errs: string[] = [];
  const warns: string[] = [];
  const courseLessons = new Map<string, string[]>(); // cid → lesson item_id（lid 升序）
  for (const [key, g] of keys) {
    const declared = sortDeclared(g.placements);
    const children = declared.map((p) => p.itemId);
    const lessonId = `course/${g.course}/lesson/${g.lesson}`;
    let title = lessonTitle.get(key) ?? "";
    if (title === "") title = g.lesson;
    try {
      rebuildContainer(store, lessonId, "lesson", "lesson", title, lessonDigest.get(key) ?? "", children);
    } catch (err) {
      if (err instanceof SubmittedContainerError) {
        warns.push("skipped: " + lessonId + " 投稿域，导入器不覆盖");
      } else {
        errs.push(lessonId + ": " + msg(err));
      }
    }
    const arr = courseLessons.get(g.course) ?? [];
    arr.push(lessonId);
    courseLessons.set(g.course, arr);
  }

  const cids = [...courseLessons.keys()].sort(compareGoString);
  for (const cid of cids) {
    const courseId = "course/" + cid;
    let title = courseTitle.get(cid) ?? "";
    if (title === "") title = cid;
    try {
      rebuildContainer(store, courseId, "course", "course", title, courseDigest.get(cid) ?? "", courseLessons.get(cid) ?? []);
    } catch (err) {
      if (err instanceof SubmittedContainerError) {
        warns.push("skipped: " + courseId + " 投稿域，导入器不覆盖");
      } else {
        errs.push(courseId + ": " + msg(err));
      }
    }
  }
  return { errs, warns };
}

/**
 * 全量重算分类容器（`course.go:197-286`）。与 lesson / course **刻意不同**：分类清单是
 * 本 Run 声明的快照，**不做 mergeChildren 合并**。覆盖集合 = 本 Run 声明的分类 ∪ 库中既有分类。
 * 返回失败明细数组，不整批失败。
 */
export function rebuildCategories(store: Store, items: readonly ParsedMD[]): string[] {
  const bySlug = new Map<string, string[]>(); // slug → cid
  const title = new Map<string, string>();
  const digest = new Map<string, string>();
  const seen = new Set<string>(); // "<slug>/<cid>"：同一分类下的同一课程只收一次
  for (const it of items) {
    if (it.p.course === "" || it.category === "") continue;
    const key = it.category + "/" + it.p.course;
    if (!seen.has(key)) {
      seen.add(key);
      const arr = bySlug.get(it.category) ?? [];
      arr.push(it.p.course);
      bySlug.set(it.category, arr);
    }
    if (!title.get(it.category)) title.set(it.category, it.categoryTitle);
    if (!digest.get(it.category)) digest.set(it.category, it.categoryDigest);
  }

  let existing: StoreItem[];
  try {
    existing = store.listItems("active");
  } catch (err) {
    return ["列出既有分类失败: " + msg(err)];
  }
  const slugs = new Set<string>(bySlug.keys());
  for (const it of existing) {
    if (it.source !== "category" || !it.itemId.startsWith("category/")) continue;
    const slug = it.itemId.slice("category/".length);
    slugs.add(slug);
    if (!title.get(slug)) title.set(slug, it.title);
  }

  const ordered = [...slugs].sort(compareGoString);
  const errs: string[] = [];
  for (const slug of ordered) {
    const itemId = "category/" + slug;
    let existingSegs: StoreSegment[];
    try {
      existingSegs = store.listSegments(itemId);
    } catch (err) {
      errs.push(itemId + ": " + msg(err));
      continue;
    }
    if (!digest.get(slug)) digest.set(slug, digestTextOf(existingSegs));
    const courses = [...(bySlug.get(slug) ?? [])].sort(compareGoString);

    const segs: StoreSegment[] = attrSegsOf(existingSegs);
    let seq = 1;
    const d = digest.get(slug) ?? "";
    if (d !== "") {
      segs.push({ itemId: "", seq: 0, kind: "digest", text: d, contentHash: "" });
    }
    for (const cid of courses) {
      segs.push({ itemId: "", seq, kind: "course", text: "course/" + cid, contentHash: "" });
      seq++;
    }
    let t = title.get(slug) ?? "";
    if (t === "") t = slug;
    try {
      store.upsertSegmentItem({ itemId, source: "category", type: "category", title: t, segments: segs });
    } catch (err) {
      errs.push(itemId + ": " + msg(err));
    }
  }
  return errs;
}

/**
 * 把一个载体 id 并入课时清单（`course.go:290-304`，import-video 用）。
 * 既有课时容器存在时沿用其 title 与 seq=0 digest，避免视频导入冲掉 md 设好的 lesson_title。
 */
export function ensureLessonChild(store: Store, course: string, lesson: string, childId: string): void {
  const lessonId = `course/${course}/lesson/${lesson}`;
  let title = lesson;
  const it = store.getItem(lessonId);
  if (it !== null && it.title !== "") title = it.title;
  const existing = store.listSegments(lessonId);
  const digest = digestTextOf(existing);
  rebuildContainer(store, lessonId, "lesson", "lesson", title, digest, [childId]);
}