import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  articleDone,
  articlePosition,
  checkinStreak,
  lessonCompleted,
  localDay,
  progressWins,
  quizDone,
  quizPosition,
  REPORT_MIN_INTERVAL_MS,
  shiftDay,
  shouldReport,
  videoPosition,
} from './progress';

interface VectorFile {
  version: number;
  article: Array<{ name: string; fraction: number; want: number }>;
  video: Array<{ name: string; seconds: number; want: number }>;
  quiz: Array<{ name: string; answered: number; total: number; want: number }>;
  lww: Array<{
    name: string;
    createdAt: number;
    eventId: string;
    prevCreatedAt: number;
    prevEventId: string;
    want: boolean;
  }>;
}

// 与 Go 侧 internal/protocol/progress_vector_test.go 读**同一个文件**（#8 册子 §3.4）。
// 层深 4：apps/mobile/src/core → apps/mobile/src → apps/mobile → apps → 仓库根。
const vector = JSON.parse(
  readFileSync(new URL('../../../vectors/v1/progress.json', import.meta.url), 'utf8'),
) as VectorFile;

describe('progress 契约向量（与 Go 侧共用同一文件）', () => {
  it('向量文件结构正确', () => {
    expect(vector.version).toBe(1);
    expect(vector.article.length).toBeGreaterThan(0);
    expect(vector.video.length).toBeGreaterThan(0);
    expect(vector.quiz.length).toBeGreaterThan(0);
    expect(vector.lww.length).toBeGreaterThan(0);
  });

  it('article 正文滚动千分比归一化', () => {
    for (const c of vector.article) {
      expect(articlePosition(c.fraction), c.name).toBe(c.want);
    }
  });

  it('video 已看秒数归一化', () => {
    for (const c of vector.video) {
      expect(videoPosition(c.seconds), c.name).toBe(c.want);
    }
  });

  it('quiz 已作答题数归一化', () => {
    for (const c of vector.quiz) {
      expect(quizPosition(c.answered, c.total), c.name).toBe(c.want);
    }
  });

  it('LWW 判据（created_at 降序、平局 event_id 升序）', () => {
    for (const c of vector.lww) {
      expect(progressWins(c.createdAt, c.eventId, c.prevCreatedAt, c.prevEventId), c.name).toBe(c.want);
    }
  });
});

describe('done 判定（客户端侧口径，#8 册子 §3.2）', () => {
  it('article：读到末尾才算完成', () => {
    expect(articleDone(999)).toBe(false);
    expect(articleDone(1000)).toBe(true);
  });

  it('quiz：全答完才算完成，空题库不算', () => {
    expect(quizDone(3, 10)).toBe(false);
    expect(quizDone(10, 10)).toBe(true);
    expect(quizDone(0, 0)).toBe(false);
  });
});

describe('打卡日与连续天数（#8 册子 §3.5）', () => {
  it('今天已打卡：从今天起算', () => {
    const days = new Set(['2026-09-29', '2026-09-30', '2026-10-01']);
    expect(checkinStreak(days, '2026-10-01')).toBe(3);
  });

  it('今天未打卡不断签：从昨天起算', () => {
    const days = new Set(['2026-09-29', '2026-09-30']);
    expect(checkinStreak(days, '2026-10-01')).toBe(2);
  });

  it('中间有缺口即断', () => {
    const days = new Set(['2026-09-28', '2026-09-30', '2026-10-01']);
    expect(checkinStreak(days, '2026-10-01')).toBe(2);
  });

  it('跨月回溯', () => {
    const days = new Set(['2026-08-31', '2026-09-01']);
    expect(checkinStreak(days, '2026-09-01')).toBe(2);
  });

  it('一天都没打卡为 0', () => {
    expect(checkinStreak(new Set<string>(), '2026-10-01')).toBe(0);
  });

  it('shiftDay 跨月跨年由 Date 归一', () => {
    expect(shiftDay('2026-10-01', -1)).toBe('2026-09-30');
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDay('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('localDay 按本地时区组串（不落 UTC）', () => {
    expect(localDay(new Date(2026, 9, 1, 8, 0, 0))).toBe('2026-10-01');
    expect(localDay(new Date(2026, 0, 5, 23, 30, 0))).toBe('2026-01-05');
  });
});

describe('节流（#8 册子 §5.3）', () => {
  it('首次必发', () => {
    expect(shouldReport(undefined, 1000)).toBe(true);
  });

  it('不足间隔丢帧', () => {
    expect(shouldReport(1000, 1000 + REPORT_MIN_INTERVAL_MS - 1)).toBe(false);
  });

  it('正好到间隔即发', () => {
    expect(shouldReport(1000, 1000 + REPORT_MIN_INTERVAL_MS)).toBe(true);
  });
});

describe('容器完成度聚合（#8 册子 §6，只展示、不落表）', () => {
  it('lesson 完成 ⇔ 可达叶子非空且全 done', () => {
    expect(lessonCompleted([true, true])).toBe(true);
    expect(lessonCompleted([true, false])).toBe(false);
    expect(lessonCompleted([])).toBe(false);
  });
});