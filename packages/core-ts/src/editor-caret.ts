/**
 * 正文光标的取值裁决（册子 #67 §3.2）。
 *
 * 三级优先级：`live`（H5 原生 DOM 选区） → `ledger`（App 端 renderjs 台账） → `fallback`（正文末尾）。
 * 固定口径：**任何情况下都不回落到「上一次工具动作的落点」**——那正是本册要修的缺陷。
 */

/** 一段光标（或选区）位置；`start === end` 即单点光标 */
export interface Caret {
  start: number;
  end: number;
}

/** 取值来源：live = 本端原生 DOM（H5）／ledger = renderjs 台账（App）／fallback = 正文末尾 */
export type CaretSource = 'live' | 'ledger' | 'fallback';

export interface CaretResolution {
  caret: Caret;
  source: CaretSource;
}

/** 钳到 [0, len]，并保证 end >= start */
function clamp(c: Caret, len: number): Caret {
  const start = Math.min(Math.max(c.start, 0), len);
  const end = Math.min(Math.max(c.end, start), len);
  return { start, end };
}

export function resolveCaret(live: Caret | null, ledger: Caret | null, len: number): CaretResolution {
  if (live) return { caret: clamp(live, len), source: 'live' };
  if (ledger) return { caret: clamp(ledger, len), source: 'ledger' };
  return { caret: { start: len, end: len }, source: 'fallback' };
}
