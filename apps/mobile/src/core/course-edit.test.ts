import { utf8 } from '@base/protocol-ts';
import { describe, expect, it } from 'vitest';

import {
  buildContainerSegments,
  emptyContainerForm,
  loadContainerForm,
  saveContainer,
  startNewCourse,
  startNewLesson,
  type ContainerForm,
} from './course-edit';
import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { decodeUtf8 } from './sync';
import type { SubmitOptions } from './submit';

const BASE = 'https://node.test';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function lessonForm(over: Partial<ContainerForm> = {}): ContainerForm {
  return {
    ...emptyContainerForm('lesson', 'course/c1/lesson/l1'),
    title: '第一讲',
    digest: '简介',
    cover: '00112233445566778899aabbccddeeff',
    instructor: '李老师',
    difficulty: 'basic',
    durationSec: 3600,
    attachments: [
      { blobId: '00000000000000000000000000000000', name: '讲义.pdf' },
      { blobId: 'ffffffffffffffffffffffffffffffff', name: '附录.pdf' },
    ],
    bodyMd: '# 讲稿',
    children: [
      { kind: 'article', itemId: 'course/c1/lesson/l1/article/a1' },
      { kind: 'quiz', itemId: 'course/c1/lesson/l1/quiz/q1' },
    ],
    ...over,
  };
}

describe('buildContainerSegments：表单 → 行集（本册 §4.1）', () => {
  it('属性行 seq<0 规范排布，digest 占 0，清单从 1 起连续', () => {
    expect(buildContainerSegments(lessonForm())).toEqual([
      { seq: -1, kind: 'attr.attachment', text: '00000000000000000000000000000000\t讲义.pdf' },
      { seq: -2, kind: 'attr.attachment', text: 'ffffffffffffffffffffffffffffffff\t附录.pdf' },
      { seq: -3, kind: 'attr.body_md', text: '# 讲稿' },
      { seq: -4, kind: 'attr.cover', text: '00112233445566778899aabbccddeeff' },
      { seq: -5, kind: 'attr.difficulty', text: 'basic' },
      { seq: -6, kind: 'attr.duration', text: '3600' },
      { seq: -7, kind: 'attr.instructor', text: '李老师' },
      { seq: 0, kind: 'digest', text: '简介' },
      { seq: 1, kind: 'article', text: 'course/c1/lesson/l1/article/a1' },
      { seq: 2, kind: 'quiz', text: 'course/c1/lesson/l1/quiz/q1' },
    ]);
  });

  it('课程不吃正文：course 类型即使填了 bodyMd 也不产 attr.body_md', () => {
    const rows = buildContainerSegments(lessonForm({ type: 'course', itemId: 'course/c1', bodyMd: '# 不该出现' }));
    expect(rows.some((r) => r.kind === 'attr.body_md')).toBe(false);
  });

  it('course 且 category 非空 ⇒ 产 attr.category 行，落 body_md 与 cover 之间', () => {
    const rows = buildContainerSegments(
      lessonForm({ type: 'course', itemId: 'course/c1', category: 'math', instructor: '李老师', difficulty: 'basic', durationSec: 3600, attachments: [] }),
    );
    expect(rows.filter((r) => r.seq < 0)).toEqual([
      { seq: -1, kind: 'attr.category', text: 'math' },
      { seq: -2, kind: 'attr.cover', text: '00112233445566778899aabbccddeeff' },
      { seq: -3, kind: 'attr.difficulty', text: 'basic' },
      { seq: -4, kind: 'attr.duration', text: '3600' },
      { seq: -5, kind: 'attr.instructor', text: '李老师' },
    ]);
  });

  it('category 空串 ⇒ 不产该行', () => {
    const rows = buildContainerSegments(lessonForm({ type: 'course', itemId: 'course/c1', category: '' }));
    expect(rows.some((r) => r.kind === 'attr.category')).toBe(false);
  });

  it('lesson 即使填了 category 也不产该行（课程专用）', () => {
    const rows = buildContainerSegments(lessonForm({ category: 'math' }));
    expect(rows.some((r) => r.kind === 'attr.category')).toBe(false);
  });

  it('空字段不产行；时长非正数不产行；纯空表单得空行集', () => {
    expect(buildContainerSegments(emptyContainerForm('course', 'course/c1'))).toEqual([]);
    const rows = buildContainerSegments(lessonForm({ durationSec: 0, attachments: [], digest: '', children: [] }));
    expect(rows.map((r) => r.kind)).toEqual(['attr.body_md', 'attr.cover', 'attr.difficulty', 'attr.instructor']);
  });
});

describe('loadContainerForm：从本地包回填', () => {
  it('标题取 items，属性 / 简介 / 清单各自归位', async () => {
    const repo = new MemoryRepo();
    await repo.applyPack({
      version: 1, packId: 'p1', updatedAt: '2026-09-30T00:00:00Z', articles: [], quizzes: [], tombstones: [],
      items: [
        { itemId: 'course/c1/lesson/l1', source: 'lesson', type: 'lesson', title: '第一讲', rev: 'r', contentHash: 'h', state: 'active', updatedAt: '' },
      ],
      segments: [
        { itemId: 'course/c1/lesson/l1', seq: -1, kind: 'attr.cover', text: '00112233445566778899aabbccddeeff', contentHash: 'h' },
        { itemId: 'course/c1/lesson/l1', seq: -2, kind: 'attr.body_md', text: '# 讲稿', contentHash: 'h' },
        { itemId: 'course/c1/lesson/l1', seq: 0, kind: 'digest', text: '简介', contentHash: 'h' },
        { itemId: 'course/c1/lesson/l1', seq: 1, kind: 'article', text: 'course/c1/lesson/l1/article/a1', contentHash: 'h' },
      ],
    });

    expect(await loadContainerForm(repo, 'course/c1/lesson/l1', 'lesson')).toEqual({
      itemId: 'course/c1/lesson/l1', type: 'lesson', title: '第一讲', digest: '简介',
      cover: '00112233445566778899aabbccddeeff', instructor: '', difficulty: '', durationSec: 0,
      attachments: [], bodyMd: '# 讲稿',
      children: [{ kind: 'article', itemId: 'course/c1/lesson/l1/article/a1' }],
      category: '',
    });
  });

  it('回填 attr.category：有该行取 slug，缺失得空串', async () => {
    const repo = new MemoryRepo();
    await repo.applyPack({
      version: 1, packId: 'p2', updatedAt: '2026-09-30T00:00:00Z', articles: [], quizzes: [], tombstones: [],
      items: [
        { itemId: 'course/c1', source: 'course', type: 'course', title: '数学', rev: 'r', contentHash: 'h', state: 'active', updatedAt: '' },
      ],
      segments: [
        { itemId: 'course/c1', seq: -1, kind: 'attr.category', text: 'math', contentHash: 'h' },
      ],
    });
    expect((await loadContainerForm(repo, 'course/c1', 'course')).category).toBe('math');
    expect((await loadContainerForm(new MemoryRepo(), 'course/none', 'course')).category).toBe('');
  });

  it('条目不存在也不抛：得空表单（保留给定 itemId 与 type）', async () => {
    const form = await loadContainerForm(new MemoryRepo(), 'course/none', 'course');
    expect(form.title).toBe('');
    expect(form.itemId).toBe('course/none');
    expect(form.type).toBe('course');
  });
});

describe('startNewCourse / startNewLesson / saveContainer', () => {
  it('startNewCourse：id 形如 course/<16 位 hex>；startNewLesson 挂在课程下', () => {
    expect(/^course\/[0-9a-f]{16}$/.test(startNewCourse().itemId)).toBe(true);
    expect(/^course\/c1\/lesson\/[0-9a-f]{16}$/.test(startNewLesson('course/c1').itemId)).toBe(true);
  });

  it('saveContainer：投稿行集与表单一致，台账落 segments_json', async () => {
    const http = new FakeHttp();
    const repo = new MemoryRepo();
    const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
    const o: SubmitOptions = { adapters, repo, nodeBaseUrl: BASE };
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'course/c1/lesson/l1', created: true }));

    const out = await saveContainer(o, lessonForm());
    expect(out.ledgerState).toBe('sent');
    const wire = JSON.parse(decodeUtf8(http.posted.at(-1)!.body)) as { segments: unknown[] };
    expect(wire.segments).toHaveLength(10);
    expect((await repo.getSubmission('course/c1/lesson/l1'))!.segmentsJson).toContain('"seq":-1');
  });
});