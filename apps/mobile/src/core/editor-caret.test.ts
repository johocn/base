import { describe, expect, it } from 'vitest';

import { resolveCaret } from './editor-caret';

describe('resolveCaret：live → ledger → fallback 三级裁决（册子 #67 §3.2）', () => {
  it('live 存在时优先于 ledger（H5 原生 DOM 路径不被台账覆盖）', () => {
    expect(resolveCaret({ start: 2, end: 4 }, { start: 9, end: 9 }, 10)).toEqual({
      caret: { start: 2, end: 4 },
      source: 'live',
    });
  });

  it('无 live 时用 ledger（App 端 renderjs 台账）', () => {
    expect(resolveCaret(null, { start: 3, end: 3 }, 10)).toEqual({
      caret: { start: 3, end: 3 },
      source: 'ledger',
    });
  });

  it('双空 ⇒ fallback 落到正文末尾（不静默落到上一次落点）', () => {
    expect(resolveCaret(null, null, 7)).toEqual({
      caret: { start: 7, end: 7 },
      source: 'fallback',
    });
    expect(resolveCaret(null, null, 0)).toEqual({
      caret: { start: 0, end: 0 },
      source: 'fallback',
    });
  });

  it('越界入参钳到 [0, len]', () => {
    expect(resolveCaret({ start: 99, end: 120 }, null, 5)).toEqual({
      caret: { start: 5, end: 5 },
      source: 'live',
    });
    expect(resolveCaret(null, { start: -4, end: 3 }, 5)).toEqual({
      caret: { start: 0, end: 3 },
      source: 'ledger',
    });
  });

  it('end < start 时取 end = start', () => {
    expect(resolveCaret({ start: 4, end: 2 }, null, 10)).toEqual({
      caret: { start: 4, end: 4 },
      source: 'live',
    });
  });
});
