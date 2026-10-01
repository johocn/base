import { describe, expect, it } from 'vitest';

import {
  ATTR_BODY_MD,
  ATTR_CATEGORY,
  ATTR_COVER,
  ATTR_DURATION,
  ATTR_INSTRUCTOR,
  DIGEST_KIND,
} from './attrs';
import type { ContainerForm } from './course-edit';
import { loadContainerForm } from './course-edit';
import { MemoryRepo } from './fakes';
import {
  buildMyCreatedView,
  containerFormFromLedger,
  ledgerSegmentsOf,
  statusLabelOf,
  type MyCreatedType,
} from './my-created';
import type { MySubmissionRow, SegmentRow } from './types';

/** 造一条台账行；除需断言的字段外给中性默认值。 */
function row(over: Partial<MySubmissionRow> = {}): MySubmissionRow {
  return {
    itemId: 'article/a1',
    type: 'article',
    title: '标题',
    bodyMd: '',
    questionJson: '',
    linksJson: '',
    segmentsJson: '',
    state: 'sent',
    reason: null,
    created: 1,
    queuedAt: '2026-09-30T00:00:00Z',
    sentAt: '',
    localOnly: false,
    ...over,
  };
}

function seg(itemId: string, seq: number, kind: string, text: string): SegmentRow {
  return { itemId, seq, kind, text, contentHash: '' };
}

describe('statusLabelOf：状态 → 中文标签', () => {
  it('pending / failed / sent 三条映射', () => {
    expect(statusLabelOf('pending')).toBe('待补发');
    expect(statusLabelOf('failed')).toBe('失败');
    expect(statusLabelOf('sent')).toBe('已同步');
  });
});

describe('buildMyCreatedView：去重与四象限', () => {
  it('sent 且 packItemIds 含该 id ⇒ 不列出（库内已同步，不重复显示）', () => {
    const rows = [row({ itemId: 'article/a1', state: 'sent' })];
    expect(buildMyCreatedView(rows, new Set(['article/a1']))).toEqual([]);
  });

  it('sent 且不含 ⇒ 列出且 statusLabel 为「已同步」', () => {
    const rows = [row({ itemId: 'article/a1', state: 'sent', title: 'A' })];
    expect(buildMyCreatedView(rows, new Set())).toEqual([
      { itemId: 'article/a1', type: 'article', title: 'A', state: 'sent', reason: '', statusLabel: '已同步' },
    ]);
  });

  it('pending 无论是否含都列出', () => {
    const rows = [row({ itemId: 'article/a1', state: 'pending' })];
    const withId = buildMyCreatedView(rows, new Set(['article/a1']));
    const without = buildMyCreatedView(rows, new Set());
    expect(withId).toHaveLength(1);
    expect(withId[0]!.statusLabel).toBe('待补发');
    expect(without).toHaveLength(1);
  });

  it('failed 无论是否含都列出，且保留 reason', () => {
    const rows = [row({ itemId: 'article/a1', state: 'failed', reason: '网络不可达' })];
    for (const pack of [new Set(['article/a1']), new Set<string>()]) {
      expect(buildMyCreatedView(rows, pack)).toEqual([
        { itemId: 'article/a1', type: 'article', title: '标题', state: 'failed', reason: '网络不可达', statusLabel: '失败' },
      ]);
    }
  });

  it('reason 为 null ⇒ 归一为空串', () => {
    const rows = [row({ state: 'pending', reason: null })];
    expect(buildMyCreatedView(rows, new Set())[0]!.reason).toBe('');
  });

  it('type 为 tag 的行被排除', () => {
    const rows = [row({ itemId: 'tag/x', type: 'tag' }), row({ itemId: 'article/a1', type: 'article' })];
    const out = buildMyCreatedView(rows, new Set());
    expect(out.map((r) => r.itemId)).toEqual(['article/a1']);
  });

  it('空台账 ⇒ []', () => {
    expect(buildMyCreatedView([], new Set(['article/a1']))).toEqual([]);
  });

  it('输出顺序与输入一致（不重排）', () => {
    const rows = [
      row({ itemId: 'article/a3', queuedAt: '2026-09-30T03:00:00Z' }),
      row({ itemId: 'article/a1', queuedAt: '2026-09-30T01:00:00Z' }),
      row({ itemId: 'article/a2', queuedAt: '2026-09-30T02:00:00Z' }),
    ];
    expect(buildMyCreatedView(rows, new Set()).map((r) => r.itemId)).toEqual([
      'article/a3',
      'article/a1',
      'article/a2',
    ]);
  });

  it('容器类型 course / lesson 原样透传', () => {
    const rows = [row({ itemId: 'course/c1', type: 'course' }), row({ itemId: 'course/c1/lesson/l1', type: 'lesson' })];
    const out = buildMyCreatedView(rows, new Set());
    expect(out.map((r) => r.type)).toEqual<MyCreatedType[]>(['course', 'lesson']);
  });
});

describe('ledgerSegmentsOf：台账 JSON → 行集', () => {
  it('正常解析：补 itemId 与 contentHash', () => {
    const r = row({
      itemId: 'course/c1/lesson/l1',
      segmentsJson: '[{"seq":-1,"kind":"attr.cover","text":"b1"}]',
    });
    expect(ledgerSegmentsOf(r)).toEqual([seg('course/c1/lesson/l1', -1, 'attr.cover', 'b1')]);
  });

  it('空串 ⇒ []', () => {
    expect(ledgerSegmentsOf(row({ segmentsJson: '' }))).toEqual([]);
  });

  it('坏 JSON ⇒ []（不抛）', () => {
    expect(ledgerSegmentsOf(row({ segmentsJson: '{ not json' }))).toEqual([]);
  });
});

describe('containerFormFromLedger：台账行集 → 详情渲染（与 loadContainerForm 同构）', () => {
  // course 行集：含 attr.instructor / digest / 两条子项行；另塞一条 attr.body_md 证明课程恒不吃正文。
  const courseId = 'course/c1';
  const courseSegs = [
    seg(courseId, -6, ATTR_INSTRUCTOR, '李老师'),
    seg(courseId, -5, ATTR_COVER, 'b1'),
    seg(courseId, -4, ATTR_DURATION, '3600'),
    seg(courseId, -3, ATTR_CATEGORY, 'math'),
    seg(courseId, -2, ATTR_BODY_MD, '# 不该出现在课程'),
    seg(courseId, 0, DIGEST_KIND, '课程简介'),
    seg(courseId, 1, 'lesson', 'course/c1/lesson/l1'),
    seg(courseId, 2, 'lesson', 'course/c1/lesson/l2'),
  ];
  const courseJson = JSON.stringify(courseSegs.map((s) => ({ seq: s.seq, kind: s.kind, text: s.text })));

  const lessonId = 'course/c1/lesson/l1';
  const lessonSegs = [
    seg(lessonId, -4, ATTR_INSTRUCTOR, '王老师'),
    seg(lessonId, -3, ATTR_DURATION, '600'),
    seg(lessonId, -2, ATTR_BODY_MD, '# 讲稿'),
    seg(lessonId, 0, DIGEST_KIND, '课时简介'),
    seg(lessonId, 1, 'quiz', 'course/c1/lesson/l1/quiz/q1'),
  ];
  const lessonJson = JSON.stringify(lessonSegs.map((s) => ({ seq: s.seq, kind: s.kind, text: s.text })));

  /** 用假 LocalRepo 造与台账同源的数据，喂给 loadContainerForm 做逐字段对照。 */
  async function loadViaRepo(itemId: string, type: 'course' | 'lesson', title: string, segs: SegmentRow[]): Promise<ContainerForm> {
    const repo = new MemoryRepo();
    repo.items.set(itemId, {
      itemId,
      source: 'local',
      type,
      title,
      rev: '1',
      contentHash: '',
      state: 'active',
      updatedAt: '2026-09-30T00:00:00Z',
    });
    repo.segments.set(itemId, segs);
    return loadContainerForm(repo, itemId, type);
  }

  it('course：instructor / digest / children 与 loadContainerForm 一致，bodyMd 恒空、category 取 attr.category', async () => {
    const r = row({ itemId: courseId, type: 'course', title: '课程标题', segmentsJson: courseJson });
    const got = containerFormFromLedger(r);
    const want = await loadViaRepo(courseId, 'course', '课程标题', courseSegs);

    expect(got).toEqual(want);
    expect(got.instructor).toBe('李老师');
    expect(got.digest).toBe('课程简介');
    expect(got.bodyMd).toBe('');
    expect(got.category).toBe('math');
    expect(got.children).toEqual([
      { kind: 'lesson', itemId: 'course/c1/lesson/l1' },
      { kind: 'lesson', itemId: 'course/c1/lesson/l2' },
    ]);
  });

  it('lesson：bodyMd 取 attr.body_md，instructor / digest / children 与 loadContainerForm 一致', async () => {
    const r = row({ itemId: lessonId, type: 'lesson', title: '课时标题', segmentsJson: lessonJson });
    const got = containerFormFromLedger(r);
    const want = await loadViaRepo(lessonId, 'lesson', '课时标题', lessonSegs);

    expect(got).toEqual(want);
    expect(got.bodyMd).toBe('# 讲稿');
    expect(got.instructor).toBe('王老师');
    expect(got.digest).toBe('课时简介');
    expect(got.children).toEqual([{ kind: 'quiz', itemId: 'course/c1/lesson/l1/quiz/q1' }]);
  });
});