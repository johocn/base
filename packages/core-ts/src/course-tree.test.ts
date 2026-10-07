import { describe, expect, it } from 'vitest';

import {
  categoryCandidates,
  childrenOf,
  coursesOfCategory,
  groupCoursesByCategory,
  lessonOfCarrier,
  lessonNo,
  lessonPosition,
  prevNextLesson,
  relatedLessons,
  splitCategories,
  splitCourses,
} from './course-tree';
import type { ItemRow, SegmentRow } from './types';

function item(itemId: string, type: string): ItemRow {
  return {
    itemId,
    source: type,
    type,
    title: itemId,
    rev: 'rev-1',
    contentHash: 'h',
    state: 'active',
    updatedAt: '2026-01-01T00:00:00Z',
    authorId: '',
    authorSig: '',
  };
}

function seg(itemId: string, seq: number, kind: string, text: string): SegmentRow {
  return { itemId, seq, kind, text, contentHash: 'h' };
}

describe('splitCourses', () => {
  it('课程集合 = type=course 且 itemId 以 course/ 开头，按 itemId 升序', () => {
    const items = [
      item('course/c2', 'course'),
      item('course/c1', 'course'),
      item('article/aaa', 'article'),
      item('lesson:c1', 'course'),
    ];
    const tree = splitCourses(items);
    expect(tree.courses.map((c) => c.itemId)).toEqual(['course/c1', 'course/c2']);
  });

  it('未归类集合 = type=article 且 itemId 不以 course/ 开头，按 itemId 升序', () => {
    const items = [
      item('article/zzz', 'article'),
      item('article/aaa', 'article'),
      item('course/c1/lesson/l1/article/aaa', 'article'),
      item('course/c1', 'course'),
    ];
    const tree = splitCourses(items);
    expect(tree.ungrouped.map((a) => a.itemId)).toEqual(['article/aaa', 'article/zzz']);
  });

  it('不改动传入数组', () => {
    const items = [item('course/c2', 'course'), item('course/c1', 'course')];
    const snapshot = [...items];
    splitCourses(items);
    expect(items).toEqual(snapshot);
    expect(items.map((i) => i.itemId)).toEqual(['course/c2', 'course/c1']);
  });
});

describe('childrenOf', () => {
  it('取 seq>=1 的 text，按 seq 升序', () => {
    const segs = [
      seg('course/c1', 0, 'digest', '课程简介\n'),
      seg('course/c1', 1, 'lesson', 'course/c1/lesson/l1'),
      seg('course/c1', 2, 'lesson', 'course/c1/lesson/l2'),
    ];
    expect(childrenOf(segs)).toEqual(['course/c1/lesson/l1', 'course/c1/lesson/l2']);
  });

  it('乱序输入仍按 seq 升序，不依赖入参顺序', () => {
    const segs = [
      seg('course/c1', 2, 'lesson', 'course/c1/lesson/l2'),
      seg('course/c1', 0, 'digest', '课程简介\n'),
      seg('course/c1', 1, 'lesson', 'course/c1/lesson/l1'),
    ];
    expect(childrenOf(segs)).toEqual(['course/c1/lesson/l1', 'course/c1/lesson/l2']);
  });
});

describe('lessonNo', () => {
  const segs = [
    seg('course/c1', 0, 'digest', '课程简介\n'),
    seg('course/c1', 1, 'lesson', 'course/c1/lesson/l1'),
    seg('course/c1', 2, 'lesson', 'course/c1/lesson/l2'),
  ];

  it('第 N 讲 = 位次（从 1 计）', () => {
    expect(lessonNo(segs, 'course/c1/lesson/l1')).toBe(1);
    expect(lessonNo(segs, 'course/c1/lesson/l2')).toBe(2);
  });

  it('不在清单里返回 0', () => {
    expect(lessonNo(segs, 'course/c1/lesson/l9')).toBe(0);
  });
});

describe('lessonPosition', () => {
  const segs = [
    seg('course/c1', 0, 'digest', '课程简介\n'),
    seg('course/c1', 1, 'lesson', 'course/c1/lesson/l1'),
    seg('course/c1', 2, 'lesson', 'course/c1/lesson/l2'),
    seg('course/c1', 3, 'lesson', 'course/c1/lesson/l3'),
    seg('course/c1', 4, 'lesson', 'course/c1/lesson/l4'),
    seg('course/c1', 5, 'lesson', 'course/c1/lesson/l5'),
    seg('course/c1', 6, 'lesson', 'course/c1/lesson/l6'),
    seg('course/c1', 7, 'lesson', 'course/c1/lesson/l7'),
  ];

  it('返回 {cur,total}：cur 从 1 计、total = 课时总数（不包含 seq=0 的 digest）', () => {
    expect(lessonPosition(segs, 'course/c1/lesson/l1')).toEqual({ cur: 1, total: 7 });
    expect(lessonPosition(segs, 'course/c1/lesson/l4')).toEqual({ cur: 4, total: 7 });
    expect(lessonPosition(segs, 'course/c1/lesson/l7')).toEqual({ cur: 7, total: 7 });
  });

  it('不在清单里返回 null', () => {
    expect(lessonPosition(segs, 'course/c1/lesson/l9')).toBeNull();
    expect(lessonPosition(segs, '')).toBeNull();
  });

  it('与 lessonNo 同源：childrenOf 同一次调用，cur === lessonNo 返回值', () => {
    const pos = lessonPosition(segs, 'course/c1/lesson/l4');
    if (pos) expect(pos.cur).toBe(lessonNo(segs, 'course/c1/lesson/l4'));
  });
});

describe('prevNextLesson', () => {
  const segs = [
    seg('course/c1', 0, 'digest', ''),
    seg('course/c1', 1, 'lesson', 'course/c1/lesson/l1'),
    seg('course/c1', 2, 'lesson', 'course/c1/lesson/l2'),
    seg('course/c1', 3, 'lesson', 'course/c1/lesson/l3'),
  ];

  it('中间课时：prev = 前一个 itemId，next = 后一个 itemId', () => {
    expect(prevNextLesson(segs, 'course/c1/lesson/l2')).toEqual({
      prev: 'course/c1/lesson/l1',
      next: 'course/c1/lesson/l3',
    });
  });

  it('首课时：prev = null，next = 第二讲', () => {
    expect(prevNextLesson(segs, 'course/c1/lesson/l1')).toEqual({
      prev: null,
      next: 'course/c1/lesson/l2',
    });
  });

  it('末课时：prev = 倒数第二讲，next = null', () => {
    expect(prevNextLesson(segs, 'course/c1/lesson/l3')).toEqual({
      prev: 'course/c1/lesson/l2',
      next: null,
    });
  });

  it('不在清单里：prev/next 都 null', () => {
    expect(prevNextLesson(segs, 'course/c1/lesson/l9')).toEqual({ prev: null, next: null });
  });

  it('单课时课程：prev/next 都 null', () => {
    const single = [
      seg('course/s', 0, 'digest', ''),
      seg('course/s', 1, 'lesson', 'course/s/lesson/only'),
    ];
    expect(prevNextLesson(single, 'course/s/lesson/only')).toEqual({ prev: null, next: null });
  });
});

describe('relatedLessons', () => {
  const segs = [
    seg('course/c1', 0, 'digest', ''),
    seg('course/c1', 1, 'lesson', 'course/c1/lesson/l1'),
    seg('course/c1', 2, 'lesson', 'course/c1/lesson/l2'),
    seg('course/c1', 3, 'lesson', 'course/c1/lesson/l3'),
    seg('course/c1', 4, 'lesson', 'course/c1/lesson/l4'),
    seg('course/c1', 5, 'lesson', 'course/c1/lesson/l5'),
    seg('course/c1', 6, 'lesson', 'course/c1/lesson/l6'),
    seg('course/c1', 7, 'lesson', 'course/c1/lesson/l7'),
  ];

  it('排除当前课时、保持清单位次、默认 top 5', () => {
    expect(relatedLessons(segs, 'course/c1/lesson/l4')).toEqual([
      'course/c1/lesson/l1',
      'course/c1/lesson/l2',
      'course/c1/lesson/l3',
      'course/c1/lesson/l5',
      'course/c1/lesson/l6',
    ]);
  });

  it('末尾课时：取前 5（不含自己 + 后面不够 5 个不补 null）', () => {
    expect(relatedLessons(segs, 'course/c1/lesson/l7')).toEqual([
      'course/c1/lesson/l1',
      'course/c1/lesson/l2',
      'course/c1/lesson/l3',
      'course/c1/lesson/l4',
      'course/c1/lesson/l5',
    ]);
  });

  it('首课时：跳过自己后取 l2..l6', () => {
    expect(relatedLessons(segs, 'course/c1/lesson/l1')).toEqual([
      'course/c1/lesson/l2',
      'course/c1/lesson/l3',
      'course/c1/lesson/l4',
      'course/c1/lesson/l5',
      'course/c1/lesson/l6',
    ]);
  });

  it('不在清单里：不排除任何，直接取前 topN', () => {
    expect(relatedLessons(segs, 'course/c1/lesson/l99', 3)).toEqual([
      'course/c1/lesson/l1',
      'course/c1/lesson/l2',
      'course/c1/lesson/l3',
    ]);
  });

  it('自定义 topN：topN=2 只给 2 条', () => {
    expect(relatedLessons(segs, 'course/c1/lesson/l3', 2)).toEqual([
      'course/c1/lesson/l1',
      'course/c1/lesson/l2',
    ]);
  });

  it('单课时课程：排除自己后空数组', () => {
    const single = [
      seg('course/s', 0, 'digest', ''),
      seg('course/s', 1, 'lesson', 'course/s/lesson/only'),
    ];
    expect(relatedLessons(single, 'course/s/lesson/only')).toEqual([]);
  });
});

describe('splitCategories', () => {
  it('取 source=category 的条目，按 itemId 升序，不改动入参', () => {
    const items = [
      item('category/zz', 'category'),
      item('category/aa', 'category'),
      item('course/c1', 'course'),
    ];
    const snapshot = [...items];
    expect(splitCategories(items).map((c) => c.itemId)).toEqual(['category/aa', 'category/zz']);
    expect(items).toEqual(snapshot);
  });

  it('无分类时返回空数组（旧包兼容：首页退化为两级）', () => {
    expect(splitCategories([item('course/c1', 'course')])).toEqual([]);
  });
});

describe('coursesOfCategory', () => {
  const cat = item('category/math', 'category');
  const c1 = item('course/c1', 'course');
  const c2 = item('course/c2', 'course');

  it('按清单 seq 升序解析课程，乱序入参也按 seq', () => {
    const segs = [
      seg('category/math', 2, 'course', 'course/c2'),
      seg('category/math', 0, 'digest', '简介'),
      seg('category/math', 1, 'course', 'course/c1'),
    ];
    expect(coursesOfCategory(cat.itemId, [c1, c2], segs).map((c) => c.itemId)).toEqual([
      'course/c1',
      'course/c2',
    ]);
  });

  it('悬空引用静默跳过，不报错、不影响其它课程', () => {
    const segs = [
      seg('category/math', 1, 'course', 'course/nope'),
      seg('category/math', 2, 'course', 'course/c1'),
    ];
    expect(coursesOfCategory(cat.itemId, [c1], segs).map((c) => c.itemId)).toEqual(['course/c1']);
  });

  it('只认自己 itemId 的 segments 行', () => {
    const segs = [
      seg('category/other', 1, 'course', 'course/c1'),
      seg('category/math', 1, 'course', 'course/c2'),
    ];
    expect(coursesOfCategory(cat.itemId, [c1, c2], segs).map((c) => c.itemId)).toEqual(['course/c2']);
  });
});

describe('lessonOfCarrier', () => {
  it('课程内载体返回其课时 id', () => {
    expect(lessonOfCarrier('course/c1/lesson/l1/article/a1')).toBe('course/c1/lesson/l1');
    expect(lessonOfCarrier('course/c1/lesson/l2/quiz/q1')).toBe('course/c1/lesson/l2');
  });

  it('独立文章 / 独立题库 / 课程与课时自身返回空串', () => {
    expect(lessonOfCarrier('article/a1')).toBe('');
    expect(lessonOfCarrier('quiz/q1')).toBe('');
    expect(lessonOfCarrier('course/c1')).toBe('');
    expect(lessonOfCarrier('course/c1/lesson/l1')).toBe('');
  });
});

describe('groupCoursesByCategory：分组读取（双来源 + attr.category 优先）', () => {
  const math: ItemRow = { ...item('category/math', 'category'), title: '数学' };
  const physics: ItemRow = { ...item('category/physics', 'category'), title: '物理' };
  const c1 = item('course/c1', 'course');
  const c2 = item('course/c2', 'course');

  const attrRow = (courseId: string, slug: string): SegmentRow => seg(courseId, -1, 'attr.category', slug);
  const manifestRow = (catId: string, seq: number, courseId: string): SegmentRow =>
    seg(catId, seq, 'course', courseId);
  const segMap = (entries: Array<[string, SegmentRow[]]>): Map<string, SegmentRow[]> => new Map(entries);

  it('按 attr.category 归组，组标题取既有 category/<slug> 容器 title；组内课程按 itemId 升序', () => {
    const got = groupCoursesByCategory(
      [c2, math, c1],
      segMap([
        ['course/c1', [attrRow('course/c1', 'math')]],
        ['course/c2', [attrRow('course/c2', 'math')]],
      ]),
    );
    expect(got.groups).toEqual([{ slug: 'math', title: '数学', courses: [c1, c2] }]);
    expect(got.unclassified).toEqual([]);
  });

  it('主判据②：无 attr.category 且 category/math 清单含该课程 ⇒ 低优先回退归 math', () => {
    const got = groupCoursesByCategory(
      [math, c1],
      segMap([['category/math', [manifestRow('category/math', 1, 'course/c1')]]]),
    );
    expect(got.groups).toEqual([{ slug: 'math', title: '数学', courses: [c1] }]);
    expect(got.unclassified).toEqual([]);
  });

  it('主判据①：有 attr.category=math 且 category/physics 清单含该课程 ⇒ 归 math、不归 physics', () => {
    const got = groupCoursesByCategory(
      [physics, math, c1],
      segMap([
        ['course/c1', [attrRow('course/c1', 'math')]],
        ['category/physics', [manifestRow('category/physics', 1, 'course/c1')]],
      ]),
    );
    expect(got.groups).toEqual([{ slug: 'math', title: '数学', courses: [c1] }]);
    expect(got.unclassified).toEqual([]);
  });

  it('容器不存在（或 title 空串）时组标题回落 slug 本身', () => {
    const got = groupCoursesByCategory([c1], segMap([['course/c1', [attrRow('course/c1', 'self')]]]));
    expect(got.groups).toEqual([{ slug: 'self', title: 'self', courses: [c1] }]);
    const empty = { ...item('category/self', 'category'), title: '' };
    const got2 = groupCoursesByCategory([empty, c1], segMap([['course/c1', [attrRow('course/c1', 'self')]]]));
    expect(got2.groups).toEqual([{ slug: 'self', title: 'self', courses: [c1] }]);
  });

  it('未归类纳入双来源：两来源都未归入的课程才进 unclassified（按 itemId 升序）', () => {
    const caa = item('course/aa', 'course');
    const cmm = item('course/mm', 'course');
    const got = groupCoursesByCategory(
      [cmm, caa, math],
      segMap([
        ['course/aa', [attrRow('course/aa', 'math')]],
        ['course/mm', []],
      ]),
    );
    expect(got.groups).toEqual([{ slug: 'math', title: '数学', courses: [caa] }]);
    expect(got.unclassified.map((i) => i.itemId)).toEqual(['course/mm']);
  });

  it('分组按 slug 升序、空组不显示、组内课程按 itemId 升序', () => {
    const czz = item('course/zz', 'course');
    const caa = item('course/aa', 'course');
    const got = groupCoursesByCategory(
      [czz, caa, physics, math],
      segMap([
        ['course/zz', [attrRow('course/zz', 'math')]],
        ['course/aa', [attrRow('course/aa', 'physics')]],
      ]),
    );
    expect(got.groups.map((g) => g.slug)).toEqual(['math', 'physics']);
    expect(got.groups.map((g) => g.title)).toEqual(['数学', '物理']);
  });

  it('悬空：清单行指向不存在的课程 ⇒ 静默跳过、不产组', () => {
    const got = groupCoursesByCategory(
      [math],
      segMap([['category/math', [manifestRow('category/math', 1, 'course/nope')]]]),
    );
    expect(got.groups).toEqual([]);
    expect(got.unclassified).toEqual([]);
  });

  it('悬空：attr.category 指向不存在的分类容器 ⇒ 仍以 slug 成组', () => {
    const got = groupCoursesByCategory([c1], segMap([['course/c1', [attrRow('course/c1', 'ghost')]]]));
    expect(got.groups).toEqual([{ slug: 'ghost', title: 'ghost', courses: [c1] }]);
  });

  it('非课程条目（文章）既不进分组也不进未归类', () => {
    const article = item('article/a1', 'article');
    const got = groupCoursesByCategory([article, math], segMap([]));
    expect(got.groups).toEqual([]);
    expect(got.unclassified).toEqual([]);
  });
});

describe('categoryCandidates：内置默认分类（#80 §3.5）', () => {
  it('首项恒为「从零开始」，本机词条其后追加', () => {
    const items = [item('category/math', 'category'), item('category/zzz', 'category')];
    // item() 的 title=itemId，手动改题：
    items[0]!.title = '数学';
    const cands = categoryCandidates(items);
    expect(cands[0]).toEqual({ slug: '从零开始', label: '从零开始（默认）' });
    expect(cands.slice(1).map((c) => c.slug)).toEqual(['math', 'zzz']);
  });

  it('本机已有同名词条时去重（内置优先，不重复出现）', () => {
    const items = [item('category/从零开始', 'category'), item('category/math', 'category')];
    const slugs = categoryCandidates(items).map((c) => c.slug);
    expect(slugs.filter((s) => s === '从零开始')).toHaveLength(1);
    expect(slugs[0]).toBe('从零开始');
  });

  it('空本机词条：只有内置默认一项（空态不空）', () => {
    expect(categoryCandidates([])).toEqual([{ slug: '从零开始', label: '从零开始（默认）' }]);
  });
});
