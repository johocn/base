import { describe, expect, it } from 'vitest';

import { childrenOf, lessonNo, splitCourses } from './course-tree';
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
