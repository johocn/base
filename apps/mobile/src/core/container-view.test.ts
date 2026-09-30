import { describe, expect, it } from 'vitest';

import {
  ATTR_ATTACHMENT,
  ATTR_BADGE,
  ATTR_BODY_MD,
  ATTR_CATEGORY,
  ATTR_COVER,
  ATTR_DIFFICULTY,
  ATTR_DURATION,
  ATTR_INSTRUCTOR,
  ATTR_TITLE_COLOR,
} from './attrs';
import { attrsOf, childCounts, childrenRowsOf, digestOf, firstLine, lessonDigest } from './container-view';
import type { SegmentRow } from './types';

function seg(seq: number, kind: string, text: string): SegmentRow {
  return { itemId: 'course/c1/lesson/l1', seq, kind, text, contentHash: `h${seq}` };
}

describe('attrsOf：解析 seq<0 属性行', () => {
  it('六种属性齐全', () => {
    const got = attrsOf([
      seg(-1, ATTR_ATTACHMENT, '00000000000000000000000000000000\t讲义.pdf'),
      seg(-2, ATTR_ATTACHMENT, 'ffffffffffffffffffffffffffffffff\t附录.pdf'),
      seg(-3, ATTR_BODY_MD, '# 讲稿\n\n正文\n'),
      seg(-4, ATTR_COVER, '00112233445566778899aabbccddeeff'),
      seg(-5, ATTR_DIFFICULTY, 'basic'),
      seg(-6, ATTR_DURATION, '3600'),
      seg(-7, ATTR_INSTRUCTOR, '李老师'),
    ]);
    expect(got).toEqual({
      cover: '00112233445566778899aabbccddeeff',
      instructor: '李老师',
      difficulty: 'basic',
      duration: 3600,
      attachments: [
        { blobId: '00000000000000000000000000000000', name: '讲义.pdf' },
        { blobId: 'ffffffffffffffffffffffffffffffff', name: '附录.pdf' },
      ],
      bodyMd: '# 讲稿\n\n正文\n',
      category: '',
      badge: [],
      titleColor: '',
    });
  });

  it('无属性 → 全空；未知 kind 与坏形状静默忽略', () => {
    expect(attrsOf([])).toEqual({
      cover: '',
      instructor: '',
      difficulty: '',
      duration: 0,
      attachments: [],
      bodyMd: '',
      category: '',
      badge: [],
      titleColor: '',
    });
    const got = attrsOf([seg(-1, 'attr.unknown', 'x'), seg(-2, ATTR_ATTACHMENT, '没有制表符'), seg(-3, ATTR_DURATION, 'soon')]);
    expect(got.attachments).toEqual([]);
    expect(got.duration).toBe(0);
  });

  it('解析 attr.category：有该行取 text，无该行得空串', () => {
    expect(attrsOf([seg(-1, ATTR_CATEGORY, 'math')]).category).toBe('math');
    expect(attrsOf([seg(-1, ATTR_COVER, 'x')]).category).toBe('');
  });

  it('解析 attr.badge：切分后归一为码位升序；域外词与重复词被丢弃', () => {
    expect(attrsOf([seg(-1, ATTR_BADGE, '活动,悬赏')]).badge).toEqual(['悬赏', '活动']);
    expect(attrsOf([seg(-1, ATTR_BADGE, '悬赏,悬赏,自定义,活动')]).badge).toEqual(['悬赏', '活动']);
    expect(attrsOf([seg(-1, ATTR_BADGE, '')]).badge).toEqual([]);
    expect(attrsOf([seg(-1, ATTR_COVER, 'x')]).badge).toEqual([]);
  });

  it('解析 attr.title_color：只认 6 色；c-mark / yellow / 空 → 空串（静默忽略）', () => {
    expect(attrsOf([seg(-1, ATTR_TITLE_COLOR, 'red')]).titleColor).toBe('red');
    expect(attrsOf([seg(-1, ATTR_TITLE_COLOR, 'c-mark')]).titleColor).toBe('');
    expect(attrsOf([seg(-1, ATTR_TITLE_COLOR, 'yellow')]).titleColor).toBe('');
    expect(attrsOf([seg(-1, ATTR_TITLE_COLOR, '')]).titleColor).toBe('');
    expect(attrsOf([seg(-1, ATTR_COVER, 'x')]).titleColor).toBe('');
  });
});

describe('digestOf / childrenRowsOf / childCounts', () => {
  it('digest 只认 seq=0 且 kind=digest', () => {
    expect(digestOf([seg(0, 'digest', '简介'), seg(1, 'lesson', 'course/c1/lesson/l1')])).toBe('简介');
    expect(digestOf([seg(0, 'intro', 'x')])).toBe('');
  });

  it('清单行按 seq 升序带 kind；seq<0 与 seq=0 不算子项', () => {
    const rows = [
      seg(2, 'quiz', 'course/c1/lesson/l1/quiz/q1'),
      seg(-1, ATTR_COVER, '00112233445566778899aabbccddeeff'),
      seg(1, 'article', 'course/c1/lesson/l1/article/a1'),
      seg(0, 'digest', '简介'),
    ];
    expect(childrenRowsOf(rows)).toEqual([
      { kind: 'article', text: 'course/c1/lesson/l1/article/a1' },
      { kind: 'quiz', text: 'course/c1/lesson/l1/quiz/q1' },
    ]);
    expect(childCounts(rows)).toEqual({ article: 1, quiz: 1 });
  });
});

describe('lessonDigest / firstLine：摘要回落口径（本册 §2.2）', () => {
  it('优先 seq=0 的 digest', () => {
    expect(lessonDigest([seg(0, 'digest', '既有简介'), seg(-1, ATTR_BODY_MD, '正文首段')])).toBe('既有简介');
  });

  it('缺 digest 才回落正文首段截断', () => {
    expect(lessonDigest([seg(-1, ATTR_BODY_MD, '# 标题\n\n后面')])).toBe('标题');
    expect(lessonDigest([seg(-1, ATTR_BODY_MD, '')])).toBe('');
  });

  it('firstLine：跳空行与标题记号，超长截断加省略号', () => {
    expect(firstLine('\n\n## 甲\n乙', 60)).toBe('甲');
    expect(firstLine('一二三四五', 3)).toBe('一二三…');
    expect(firstLine('   \n  ', 60)).toBe('');
  });
});