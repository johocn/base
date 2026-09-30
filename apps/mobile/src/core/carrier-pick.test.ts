import { describe, expect, it } from 'vitest';

import { kindOfItem, listCarrierCandidates } from './carrier-pick';
import { MemoryRepo } from './fakes';
import type { ItemRow } from './types';

function row(itemId: string, type: string, title: string, state = 'active'): ItemRow {
  return { itemId, source: type, type, title, rev: 'r', contentHash: 'h', state, updatedAt: '' };
}

async function repo(): Promise<MemoryRepo> {
  const r = new MemoryRepo();
  await r.applyPack({
    version: 1,
    packId: 'p1',
    updatedAt: '2026-09-30T00:00:00Z',
    articles: [],
    quizzes: [],
    segments: [],
    tombstones: [],
    items: [
      row('article/a1', 'article', 'Alpha 文章'),
      row('article/a2', 'article', ''),
      row('quiz/q1', 'quiz', '小测一'),
      row('course/c1/lesson/l1', 'lesson', '第一讲'),
      row('article/gone', 'article', '已撤下', 'removed'),
    ],
  });
  return r;
}

describe('kindOfItem', () => {
  it('kind 即 item.type（course 子项 ⇒ lesson；lesson 子项 ⇒ article|video|audio|quiz）', () => {
    expect(kindOfItem(row('course/c1/lesson/l1', 'lesson', '第一讲'))).toBe('lesson');
    expect(kindOfItem(row('course/c1/lesson/l1/article/a1', 'article', '正文'))).toBe('article');
    expect(kindOfItem(row('course/c1/lesson/l1/video/v1', 'video', '视频'))).toBe('video');
  });
});

describe('listCarrierCandidates', () => {
  it('kind 过滤：给定四 kind 只出 article/quiz，给定 lesson 只出课时', async () => {
    const r = await repo();
    expect((await listCarrierCandidates(r, ['article', 'video', 'audio', 'quiz'], '')).map((c) => c.itemId)).toEqual([
      'article/a1',
      'article/a2',
      'quiz/q1',
    ]);
    const lessons = await listCarrierCandidates(r, ['lesson'], '');
    expect(lessons.map((c) => c.itemId)).toEqual(['course/c1/lesson/l1']);
    expect(lessons[0].kind).toBe('lesson');
  });

  it('removed 条目被过滤', async () => {
    const r = await repo();
    expect(await listCarrierCandidates(r, ['article'], 'gone')).toEqual([]);
  });

  it('关键词大小写不敏感，命中 itemId 或 title', async () => {
    const r = await repo();
    expect((await listCarrierCandidates(r, ['article'], 'ALPHA')).map((c) => c.itemId)).toEqual(['article/a1']);
    expect((await listCarrierCandidates(r, ['quiz'], 'q1')).map((c) => c.itemId)).toEqual(['quiz/q1']);
  });

  it('title 为空串时回落 itemId', async () => {
    const r = await repo();
    const hit = await listCarrierCandidates(r, ['article'], 'a2');
    expect(hit).toEqual([{ kind: 'article', itemId: 'article/a2', title: 'article/a2' }]);
  });

  it('结果按 itemId 升序', async () => {
    const r = await repo();
    const got = await listCarrierCandidates(r, ['article', 'quiz'], '');
    expect(got.map((c) => c.itemId)).toEqual(['article/a1', 'article/a2', 'quiz/q1']);
  });
});