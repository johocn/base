// 本地体验状态的纯规则：收藏取反 / 已读不覆盖 / 学习记录聚合。
// 单独成文件的原因：真机上这些规则写在 SQL 里，而 Node 下没有 SQLite 引擎，
// 把「怎么判定」抽成纯函数才能在 Node 下测（SQL 侧的落库由真机验收覆盖，spec §10 验收 4/5/8）。
import type { LearningStats } from './types';

/** 收藏取反：已收藏置 null（保留行，保留 read_at），未收藏写入时间。 */
export function favoriteNext(current: string | null, at: string): { favoritedAt: string | null; isFavorite: boolean } {
  if (current !== null && current !== '') return { favoritedAt: null, isFavorite: false };
  return { favoritedAt: at, isFavorite: true };
}

/** 已读幂等：只写首次时间。 */
export function readAtNext(current: string | null, at: string): string {
  return current !== null && current !== '' ? current : at;
}

export interface StatsInput {
  /** user_state 中 read_at 非空的行数 */
  readCount: number;
  /** quiz_attempt 行数 */
  attempts: number;
  /** SUM(correct) */
  correct: number;
  /** SUM(total) */
  total: number;
  /** MAX(read_at)，无则空串 */
  readLast: string;
  /** MAX(answered_at)，无则空串 */
  quizLast: string;
}

/** 「我的」的学习记录：正确率无作答时为 null（界面显示 `-` 而不是 0）。 */
export function computeStats(i: StatsInput): LearningStats {
  return {
    readCount: i.readCount,
    quizAttempts: i.attempts,
    correctRate: i.total > 0 ? i.correct / i.total : null,
    lastAt: i.readLast > i.quizLast ? i.readLast : i.quizLast,
  };
}