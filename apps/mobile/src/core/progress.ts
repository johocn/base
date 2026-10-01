/**
 * 学习进度（progress.v1）的量纲、判定与派生（#8 册子 §3.2 / §3.4 / §3.5 / §5.3 / §6）。
 *
 * Go 镜像在 `internal/protocol/progress.go`；两侧测试共用 `vectors/v1/progress.json` 防漂。
 * **纯函数、零依赖**（不 import 'uni' / 'plus'），可在 Node 下完整测试。
 *
 * 本文件**只含客户端侧判定**（`done` 谓词、打卡、节流、完成度聚合）——这些在节点侧不实现
 * （册子 §3.2 表格的「`done` 判定」列写明判据主体是「客户端：」）。
 */

/** 同一 item_id 两次上报的最小间隔（#8 册子 §5.3）：不足则丢弃本次触发点。 */
export const REPORT_MIN_INTERVAL_MS = 5000;

/**
 * 正文滚动比例 → 千分比 0..1000（§3.2）。
 * 越界钳位；NaN 归 0（`!(fraction > 0)` 同时兜住 NaN——NaN 的比较恒为假）。
 */
export function articlePosition(fraction: number): number {
  if (!(fraction > 0)) return 0;
  if (fraction >= 1) return 1000;
  return Math.round(fraction * 1000);
}

/** 已看秒数 → 整秒（§3.2）。负数归 0；小数向下取整。 */
export function videoPosition(seconds: number): number {
  if (!(seconds > 0)) return 0;
  return Math.floor(seconds);
}

/** 已作答题数 → 归一化位置：夹到 [0, total]（§3.2）。total<=0 或 answered<=0 归 0。 */
export function quizPosition(answered: number, total: number): number {
  if (total <= 0 || answered <= 0) return 0;
  return answered >= total ? total : Math.floor(answered);
}

/** article 的 `done` 判定（§3.2）：读完末尾。 */
export function articleDone(position: number): boolean {
  return position >= 1000;
}

/** quiz 的 `done` 判定（§3.2）：全答完；**空题库（total<=0）不算完成**。 */
export function quizDone(position: number, total: number): boolean {
  return total > 0 && position >= total;
}

/**
 * LWW：`createdAt` 降序、平局 `eventId` 升序，**首条即胜者**（§3.4）。
 * 与 Go `protocol.ProgressWins` 逐字同口径；本地合并与节点侧读接口复用同一函数。
 */
export function progressWins(
  createdAt: number,
  eventId: string,
  prevCreatedAt: number,
  prevEventId: string,
): boolean {
  if (createdAt !== prevCreatedAt) return createdAt > prevCreatedAt;
  return eventId < prevEventId;
}

/** 客户端本地时区的 `YYYY-MM-DD`（§3.5）。节点**不**用 `created_at` 反推打卡日。 */
export function localDay(at: Date = new Date()): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 把 `YYYY-MM-DD` 位移 `delta` 天（本地时区）；跨月跨年由 `Date` 归一。 */
export function shiftDay(day: string, delta: number): string {
  const parts = day.split('-').map((s) => Number(s));
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  const at = new Date(y, m - 1, d);
  at.setDate(at.getDate() + delta);
  return localDay(at);
}

/**
 * 连续天数（§3.5）：从「今天」起向前逐日回溯已打卡日集合，**首个缺口即断**。
 * 今天尚未打卡时从昨天起算（当天不判断签）。
 */
export function checkinStreak(days: ReadonlySet<string>, today: string): number {
  let cursor = days.has(today) ? today : shiftDay(today, -1);
  let n = 0;
  while (days.has(cursor)) {
    n += 1;
    cursor = shiftDay(cursor, -1);
  }
  return n;
}

/**
 * 节流判据（§5.3）：同一 item_id 距上次上报 `>= REPORT_MIN_INTERVAL_MS` 才真投递。
 * 上报内容一律是**当前位置的绝对值**（不是增量），故丢帧不造成累计误差——这是能安全丢帧的前提。
 */
export function shouldReport(lastAt: number | undefined, now: number): boolean {
  return lastAt === undefined || now - lastAt >= REPORT_MIN_INTERVAL_MS;
}

/**
 * `lesson` 完成 ⇔ 其**可达**叶子载体数 > 0 且**全部** `done`（§6）。
 * 叶子载体 = `article` / `video` / `quiz`（只有这三类有 `position` / `done`）；
 * 未下载的子条目由调用方**先过滤掉**，不计入分母。
 */
export function lessonCompleted(leafDone: boolean[]): boolean {
  return leafDone.length > 0 && leafDone.every((d) => d);
}