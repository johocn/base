import { describe, expect, it } from 'vitest';

import { renderMarkdown } from './markdown';
import {
  COLOR_BUTTONS,
  INLINE_BUTTONS,
  PARAGRAPH_BUTTONS,
  applyToolbar,
  insertSeparator,
  prefixLines,
  wrapSelection,
} from './markdown-toolbar';

describe('wrapSelection：有选区包裹、无选区夹位', () => {
  it('有选区：两端插入标记，选区覆盖被包裹的原文', () => {
    expect(wrapSelection('hello', 0, 5, '**', '**')).toEqual({
      text: '**hello**',
      start: 2,
      end: 7,
    });
    expect(wrapSelection('a hello b', 2, 7, '*', '*')).toEqual({
      text: 'a *hello* b',
      start: 3,
      end: 8,
    });
  });

  it('无选区：插入一对空标记并把光标夹在中间', () => {
    expect(wrapSelection('hello', 5, 5, '[', ']{.c-red}')).toEqual({
      text: 'hello[]{.c-red}',
      start: 6,
      end: 6,
    });
    expect(wrapSelection('', 0, 0, '**', '**')).toEqual({ text: '****', start: 2, end: 2 });
  });

  it('越界入参夹到合法范围', () => {
    expect(wrapSelection('ab', 5, 9, '`', '`')).toEqual({ text: 'ab``', start: 3, end: 3 });
    expect(wrapSelection('ab', -3, -1, '`', '`')).toEqual({ text: '``ab', start: 1, end: 1 });
  });
});

describe('prefixLines：段落级加前缀', () => {
  it('无选区：只给光标所在行加前缀，光标随前缀右移', () => {
    expect(prefixLines('abc', 0, 0, '## ')).toEqual({ text: '## abc', start: 3, end: 3 });
    expect(prefixLines('a\nbc', 3, 3, '> ')).toEqual({ text: 'a\n> bc', start: 5, end: 5 });
  });

  it('有选区：选区覆盖的每行都加前缀，整体重选', () => {
    expect(prefixLines('a\nb', 0, 3, '- ')).toEqual({
      text: '- a\n- b',
      start: 0,
      end: 7,
    });
  });
});

describe('insertSeparator：另起一行插入分隔线', () => {
  it('行尾插入：补前后换行', () => {
    expect(insertSeparator('abc', 3, 3)).toEqual({ text: 'abc\n---\n', start: 8, end: 8 });
  });
  it('行首插入：不补前导换行', () => {
    expect(insertSeparator('abc', 0, 0)).toEqual({ text: '---\nabc', start: 4, end: 4 });
  });
});

describe('applyToolbar：按动作派发', () => {
  it('wrap / prefix / hr 三种动作各就其位', () => {
    expect(applyToolbar('x', 0, 1, { kind: 'wrap', before: '**', after: '**' })).toEqual({
      text: '**x**',
      start: 2,
      end: 3,
    });
    expect(applyToolbar('x', 0, 0, { kind: 'prefix', prefix: '# ' }).text).toBe('# x');
    expect(applyToolbar('x', 1, 1, { kind: 'hr' }).text).toBe('x\n---\n');
  });
});

describe('按钮表', () => {
  it('段落级 5 个、行内 4 个', () => {
    expect(PARAGRAPH_BUTTONS.map((b) => b.key)).toEqual(['heading', 'quote', 'ul', 'ol', 'hr']);
    expect(INLINE_BUTTONS.map((b) => b.key)).toEqual(['bold', 'italic', 'code', 'link']);
  });

  it('7 个色块按钮按语义命名，hint 标出枚举类名', () => {
    expect(COLOR_BUTTONS.map((b) => b.label)).toEqual([
      '强调',
      '提示',
      '补充',
      '说明',
      '重点',
      '弱化',
      '高亮',
    ]);
    for (const b of COLOR_BUTTONS) {
      expect(b.label).not.toContain('c-');
      expect(b.hint).toMatch(/^c-(red|orange|green|blue|purple|gray|mark)$/);
    }
  });

  it('色块按钮产出的源文本可被 renderMarkdown 渲染成对应类名的 span', () => {
    const out = applyToolbar('x', 0, 1, COLOR_BUTTONS[0]!.action);
    expect(out.text).toBe('[x]{.c-red}');
    expect(renderMarkdown(out.text)).toBe('<p><span class="c-red">x</span></p>');
  });
});