import { describe, expect, it } from 'vitest';

import { MemoryRepo } from './fakes';
import { migrateLegacyIds } from './id-migrate';
import type { ItemRow } from './types';

const AT = '2026-01-02T00:00:00Z';

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

describe('migrateLegacyIds', () => {
  it('旧 article:<slug> 有唯一新 id 时平移，收藏与作答都跟着走', async () => {
    const repo = new MemoryRepo();
    repo.items.set('article:aaa', item('article:aaa', 'article'));
    repo.items.set('article/aaa', item('article/aaa', 'article'));
    await repo.toggleFavorite('article:aaa', AT);
    await repo.addAttempt('article:aaa', 1, 2, AT);

    const moved = await migrateLegacyIds(repo);

    expect(moved).toBe(1);
    expect(await repo.isFavorite('article/aaa')).toBe(true);
    expect(await repo.isFavorite('article:aaa')).toBe(false);
    expect(repo.attempts).toEqual([{ itemId: 'article/aaa', at: AT, correct: 1, total: 2 }]);
  });

  it('video:/quiz: 参与平移，cover:/comment: 不参与（旧行保留）', async () => {
    const repo = new MemoryRepo();
    for (const id of [
      'video:v1',
      'quiz:q1',
      'cover:aaa',
      'comment:x',
      'course/c1/lesson/l1/video/v1',
      'course/c1/lesson/l1/quiz/q1',
    ]) {
      repo.items.set(id, item(id, id.slice(0, id.indexOf(':')) || 'x'));
    }
    await repo.toggleFavorite('video:v1', AT);
    await repo.toggleFavorite('quiz:q1', AT);
    await repo.toggleFavorite('cover:aaa', AT);
    await repo.toggleFavorite('comment:x', AT);

    const moved = await migrateLegacyIds(repo);

    expect(moved).toBe(2);
    expect(await repo.isFavorite('course/c1/lesson/l1/video/v1')).toBe(true);
    expect(await repo.isFavorite('course/c1/lesson/l1/quiz/q1')).toBe(true);
    expect(await repo.isFavorite('video:v1')).toBe(false);
    expect(await repo.isFavorite('quiz:q1')).toBe(false);
    expect(await repo.isFavorite('cover:aaa')).toBe(true);
    expect(await repo.isFavorite('comment:x')).toBe(true);
    expect(repo.items.has('cover:aaa')).toBe(true);
    expect(repo.items.has('comment:x')).toBe(true);
  });

  it('末段有多个候选：放弃平移，旧行保留', async () => {
    const repo = new MemoryRepo();
    repo.items.set('article:aaa', item('article:aaa', 'article'));
    repo.items.set('article/aaa', item('article/aaa', 'article'));
    repo.items.set('course/c1/lesson/l1/article/aaa', item('course/c1/lesson/l1/article/aaa', 'article'));
    await repo.toggleFavorite('article:aaa', AT);

    const moved = await migrateLegacyIds(repo);

    expect(moved).toBe(0);
    expect(await repo.isFavorite('article:aaa')).toBe(true);
    expect(await repo.isFavorite('article/aaa')).toBe(false);
    expect(await repo.isFavorite('course/c1/lesson/l1/article/aaa')).toBe(false);
  });

  it('无候选（内容已下架）：旧行保留不删', async () => {
    const repo = new MemoryRepo();
    repo.items.set('article:aaa', item('article:aaa', 'article'));
    await repo.toggleFavorite('article:aaa', AT);

    const moved = await migrateLegacyIds(repo);

    expect(moved).toBe(0);
    expect(await repo.isFavorite('article:aaa')).toBe(true);
    expect(repo.items.has('article:aaa')).toBe(true);
  });

  it('第二次调用直接返回，不再重复平移', async () => {
    const repo = new MemoryRepo();
    repo.items.set('article:aaa', item('article:aaa', 'article'));
    repo.items.set('article/aaa', item('article/aaa', 'article'));

    const first = await migrateLegacyIds(repo);
    expect(first).toBe(1);
    expect(await repo.getConfig('id_migrate_v2')).toBe('done');

    const second = await migrateLegacyIds(repo);
    expect(second).toBe(0);
  });

  it('平移后相同 (item_id, answered_at) 冲突不报错、不重复插入', async () => {
    const repo = new MemoryRepo();
    repo.items.set('quiz:q1', item('quiz:q1', 'quiz'));
    repo.items.set('course/c1/lesson/l1/quiz/q1', item('course/c1/lesson/l1/quiz/q1', 'quiz'));
    await repo.addAttempt('quiz:q1', 1, 2, AT);
    await repo.addAttempt('course/c1/lesson/l1/quiz/q1', 0, 2, AT);

    const moved = await migrateLegacyIds(repo);

    expect(moved).toBe(1);
    const atTarget = repo.attempts.filter((a) => a.itemId === 'course/c1/lesson/l1/quiz/q1');
    expect(atTarget).toHaveLength(1);
    expect(repo.attempts.some((a) => a.itemId === 'quiz:q1')).toBe(false);
  });
});
