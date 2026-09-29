import { describe, expect, it } from 'vitest';

import {
  childrenOf,
  coursesOfCategory,
  lessonOfCarrier,
  lessonNo,
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
