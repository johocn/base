import { describe, expect, it } from 'vitest';

import { computeStats, favoriteNext, readAtNext } from './state';

describe('favoriteNext', () => {
  it('未收藏时写入时间并返回已收藏', () => {
    expect(favoriteNext(null, '2026-09-27T10:00:00Z')).toEqual({
      favoritedAt: '2026-09-27T10:00:00Z',
      isFavorite: true,
    });
  });

  it('已收藏时置空且保留行（取消收藏不清 read_at）', () => {
    expect(favoriteNext('2026-09-27T10:00:00Z', '2026-09-27T11:00:00Z')).toEqual({
      favoritedAt: null,
      isFavorite: false,
    });
  });
});

describe('readAtNext', () => {
  it('首次阅读写入时间', () => {
    expect(readAtNext(null, '2026-09-27T10:00:00Z')).toBe('2026-09-27T10:00:00Z');
  });

  it('已读不覆盖（保留首次时间）', () => {
    expect(readAtNext('2026-09-20T08:00:00Z', '2026-09-27T10:00:00Z')).toBe('2026-09-20T08:00:00Z');
  });
});

describe('computeStats', () => {
  it('无作答时正确率为 null，不是 0', () => {
    expect(
      computeStats({ readCount: 3, attempts: 0, correct: 0, total: 0, readLast: '2026-09-27T10:00:00Z', quizLast: '' }),
    ).toEqual({ readCount: 3, quizAttempts: 0, correctRate: null, lastAt: '2026-09-27T10:00:00Z' });
  });

  it('正确率取累计 SUM(correct)/SUM(total)', () => {
    expect(
      computeStats({ readCount: 1, attempts: 2, correct: 5, total: 8, readLast: '', quizLast: '' }).correctRate,
    ).toBe(0.625);
  });

  it('最近学习时间取阅读与作答的较大者（ISO8601 字符串可比）', () => {
    expect(
      computeStats({ readCount: 1, attempts: 1, correct: 1, total: 1, readLast: '2026-09-20T08:00:00Z', quizLast: '2026-09-27T10:00:00Z' })
        .lastAt,
    ).toBe('2026-09-27T10:00:00Z');
    expect(
      computeStats({ readCount: 1, attempts: 1, correct: 1, total: 1, readLast: '2026-09-27T10:00:00Z', quizLast: '2026-09-20T08:00:00Z' })
        .lastAt,
    ).toBe('2026-09-27T10:00:00Z');
  });
});