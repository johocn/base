import { utf8 } from '@base/protocol-ts';
import { describe, expect, it } from 'vitest';

import { attrSeqsCanonical, segmentsContentHash } from './attrs';
import {
  buildContainerSegments,
  emptyContainerForm,
  loadContainerForm,
  saveContainer,
  startNewCourse,
  startNewLesson,
  toLocalContainer,
  validateContainerSegments,
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

  it('多选图章 → 单行（去重 + 码位升序）；标题色 → 单行；属性行整体规范', () => {
    const form = { ...emptyContainerForm('course', 'course/c1'), badge: ['悬赏', '活动'], titleColor: 'red' };
    const segs = buildContainerSegments(form);
    expect(segs.find((s) => s.kind === 'attr.badge')?.text).toBe('悬赏,活动');
    expect(segs.find((s) => s.kind === 'attr.title_color')?.text).toBe('red');
    const attrRows = segs.filter((s) => s.seq < 0).map((s) => ({ seq: s.seq, kind: s.kind, text: s.text }));
    expect(attrSeqsCanonical(attrRows)).toBe(true);
  });

  it('空图章 / 空色名 ⇒ 不产这两行', () => {
    const rows = buildContainerSegments(lessonForm({ badge: [], titleColor: '' }));
    expect(rows.some((r) => r.kind === 'attr.badge')).toBe(false);
    expect(rows.some((r) => r.kind === 'attr.title_color')).toBe(false);
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
      category: '', badge: [], titleColor: '',
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

  it('回填 attr.badge / attr.title_color：course 与 lesson 均生效', async () => {
    const repo = new MemoryRepo();
    await repo.applyPack({
      version: 1, packId: 'p3', updatedAt: '2026-09-30T00:00:00Z', articles: [], quizzes: [], tombstones: [],
      items: [
        { itemId: 'course/c1', source: 'course', type: 'course', title: '数学', rev: 'r', contentHash: 'h', state: 'active', updatedAt: '' },
        { itemId: 'course/c1/lesson/l1', source: 'lesson', type: 'lesson', title: '第一讲', rev: 'r', contentHash: 'h', state: 'active', updatedAt: '' },
      ],
      segments: [
        { itemId: 'course/c1', seq: -1, kind: 'attr.badge', text: '悬赏,活动', contentHash: 'h' },
        { itemId: 'course/c1', seq: -2, kind: 'attr.title_color', text: 'red', contentHash: 'h' },
        { itemId: 'course/c1/lesson/l1', seq: -1, kind: 'attr.badge', text: '热门', contentHash: 'h' },
        { itemId: 'course/c1/lesson/l1', seq: -2, kind: 'attr.title_color', text: 'blue', contentHash: 'h' },
      ],
    });
    const course = await loadContainerForm(repo, 'course/c1', 'course');
    expect(course.badge).toEqual(['悬赏', '活动']);
    expect(course.titleColor).toBe('red');
    const lesson = await loadContainerForm(repo, 'course/c1/lesson/l1', 'lesson');
    expect(lesson.badge).toEqual(['热门']);
    expect(lesson.titleColor).toBe('blue');
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

describe('toLocalContainer：表单 → 本地乐观条目（册子 #56 §2.1）', () => {
  it('items 输入为 source/rev/state 之外的四字段，content_hash 等于现行 segmentsContentHash', () => {
    const { item, segments } = toLocalContainer(lessonForm(), '2026-10-01T00:00:00Z');
    expect(item).toEqual({
      itemId: 'course/c1/lesson/l1', type: 'lesson', title: '第一讲',
      contentHash: segmentsContentHash(segments), updatedAt: '2026-10-01T00:00:00Z',
    });
    expect(item.contentHash).not.toBe('');
    expect(segments).toEqual(buildContainerSegments(lessonForm()));
  });
});

describe('saveContainer：本地乐观落库 + 投稿（册子 #56 §2.1）', () => {
  it('保存后本机立即可读（items.source=local，segments 落库），台账照旧 sent', async () => {
    const http = new FakeHttp();
    const repo = new MemoryRepo();
    const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
    const o: SubmitOptions = { adapters, repo, nodeBaseUrl: BASE };
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'course/c1/lesson/l1', created: true }));

    const out = await saveContainer(o, lessonForm());
    expect(out.ledgerState).toBe('sent');
    expect((await repo.getItem('course/c1/lesson/l1'))!.source).toBe('local');
    expect((await repo.getItem('course/c1/lesson/l1'))!.title).toBe('第一讲');
    expect((await repo.listSegments('course/c1/lesson/l1')).map((s) => s.kind)).toEqual(
      [...buildContainerSegments(lessonForm())].sort((a, b) => a.seq - b.seq).map((s) => s.kind),
    );
  });

  it('未配置节点（enqueueOrSend 抛错）也先落本地乐观条目', async () => {
    const repo = new MemoryRepo();
    const o: SubmitOptions = {
      adapters: fakeAdapters(new FakeHttp(), new MemoryFs(), new FakePackReader()),
      repo,
      nodeBaseUrl: '',
    };
    await expect(saveContainer(o, lessonForm())).rejects.toThrow('未配置节点地址，无法投稿');
    expect((await repo.getItem('course/c1/lesson/l1'))!.source).toBe('local');
  });
});

describe('validateContainerSegments / saveContainer 预检（本册 §4）', () => {
  it('合法行集 ⇒ ok', () => {
    expect(validateContainerSegments('lesson', buildContainerSegments(lessonForm())).ok).toBe(true);
    expect(validateContainerSegments('course', buildContainerSegments(emptyContainerForm('course', 'course/c1'))).ok).toBe(true);
  });

  it('course 挂 article 子项 ⇒ 指名到行，且 saveContainer 不发网络请求', async () => {
    const bad: ContainerForm = {
      ...emptyContainerForm('course', 'course/c1'),
      title: '课',
      children: [{ kind: 'article', itemId: 'course/c1/article/a1' }],
    };
    const check = validateContainerSegments('course', buildContainerSegments(bad));
    expect(check.ok).toBe(false);
    expect(check.message).toContain('第 1 个子项');
    expect(check.message).toContain('article');

    const http = new FakeHttp();
    const repo = new MemoryRepo();
    const o: SubmitOptions = { adapters: fakeAdapters(http, new MemoryFs(), new FakePackReader()), repo, nodeBaseUrl: BASE };
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'course/c1', created: true }));

    const out = await saveContainer(o, bad);
    expect(out.ledgerState).toBe('failed');
    expect(out.message).toContain('第 1 个子项');
    expect(http.posted.some((p) => p.url === `${BASE}/v1/submit`)).toBe(false);
    expect((await repo.getSubmission('course/c1'))!.state).toBe('failed');
  });

  it('seq 重复 ⇒ 判否；seq=0 非 digest ⇒ 判否（镜像三区间铁律）', () => {
    const dup = validateContainerSegments('course', [
      { seq: 0, kind: 'digest', text: 'x' },
      { seq: 0, kind: 'digest', text: 'y' },
    ]);
    expect(dup.ok).toBe(false);
    expect(dup.message).toContain('重复');

    const wrongDigest = validateContainerSegments('course', [{ seq: 0, kind: 'lesson', text: 'course/c1/lesson/l1' }]);
    expect(wrongDigest.ok).toBe(false);
  });
});

describe('loadContainerForm：参数解码（册子 #61 §2）', () => {
  /** 造一门已在本地库里的课程（items + segments 直塞，与 my-created.test.ts 同手法）。 */
  function seeded(): MemoryRepo {
    const repo = new MemoryRepo();
    repo.items.set('course/c1', {
      itemId: 'course/c1', source: 'course', type: 'course', title: '数学',
      rev: 'r', contentHash: 'h', state: 'active', updatedAt: '',
    });
    repo.segments.set('course/c1', [
      { itemId: 'course/c1', seq: -1, kind: 'attr.instructor', text: '李老师', contentHash: '' },
      { itemId: 'course/c1', seq: 0, kind: 'digest', text: '课程简介', contentHash: '' },
      { itemId: 'course/c1', seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1', contentHash: '' },
    ]);
    return repo;
  }

  it('传编码态 id（course%2Fc1）⇒ 回填真实内容，且 form.itemId 为解码后的真 id', async () => {
    const form = await loadContainerForm(seeded(), 'course%2Fc1', 'course');
    expect(form.itemId).toBe('course/c1');
    expect(form.title).toBe('数学');
    expect(form.instructor).toBe('李老师');
    expect(form.digest).toBe('课程简介');
    expect(form.children).toEqual([{ kind: 'lesson', itemId: 'course/c1/lesson/l1' }]);
  });

  it('传解码态 id 或原样命中 ⇒ 行为不变（首次 getItem 即命中）', async () => {
    const form = await loadContainerForm(seeded(), 'course/c1', 'course');
    expect(form.itemId).toBe('course/c1');
    expect(form.title).toBe('数学');
  });

  it('条目不存在 ⇒ 仍得空表单、不抛（保留语义，AC 2）', async () => {
    const form = await loadContainerForm(new MemoryRepo(), 'course%2Fnope', 'course');
    expect(form.title).toBe('');
    expect(form.type).toBe('course');
    expect(form.itemId).toBe('course%2Fnope');
  });

  it('坏编码（course%ZZ）不抛，回落原样得空表单', async () => {
    const form = await loadContainerForm(new MemoryRepo(), 'course%ZZ', 'course');
    expect(form.itemId).toBe('course%ZZ');
    expect(form.title).toBe('');
  });
});