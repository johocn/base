import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '@base/protocol-ts';
import {
  COLOR_BUTTONS,
  INLINE_BUTTONS,
  PARAGRAPH_BUTTONS,
  applyToolbar,
  insertSeparator,
  SIZE_OPTIONS,
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

describe('SIZE_OPTIONS 字号档位（册子 #83 §4.3）', () => {
  it('三档包裹选区', () => {
    const r = applyToolbar('hello', 0, 5, SIZE_OPTIONS[1]!.action);
    expect(r.text).toBe('[hello]{.fs-lg}');
    expect(r.start).toBe(1);
    expect(r.end).toBe(6);
  });
  it('无选区夹位', () => {
    const r = applyToolbar('ab', 1, 1, SIZE_OPTIONS[0]!.action);
    expect(r.text).toBe('a[]{.fs-sm}b');
    expect(r.start).toBe(2);
    expect(r.end).toBe(2);
  });
});

describe('属性组合并（真机反馈 0.21.5：字号套色不得嵌套）', () => {
  it('字号后整组选中再套色：类并集合并，渲染出双类 span', () => {
    const r1 = applyToolbar('hello', 0, 5, SIZE_OPTIONS[1]!.action); // [hello]{.fs-lg}
    const r2 = applyToolbar(r1.text, r1.start, r1.end, COLOR_BUTTONS[0]!.action);
    expect(r2.text).toBe('[hello]{.fs-lg .c-red}');
    expect(r2.start).toBe(0);
    expect(r2.end).toBe(r2.text.length);
    expect(renderMarkdown(r2.text)).toBe('<p><span class="fs-lg c-red">hello</span></p>');
  });

  it('先色后字号：同组合并，顺序跟随操作次序', () => {
    const r1 = applyToolbar('hi', 0, 2, COLOR_BUTTONS[2]!.action); // [hi]{.c-green}
    const r2 = applyToolbar(r1.text, r1.start, r1.end, SIZE_OPTIONS[2]!.action);
    expect(r2.text).toBe('[hi]{.c-green .fs-xl}');
    expect(renderMarkdown(r2.text)).toBe('<p><span class="c-green fs-xl">hi</span></p>');
  });

  it('只选中组内文本：合并进外层组，选区扩为整组', () => {
    const r = applyToolbar('[笔记]{.fs-lg}', 1, 3, COLOR_BUTTONS[6]!.action);
    expect(r.text).toBe('[笔记]{.fs-lg .c-mark}');
    expect(r.start).toBe(0);
    expect(r.end).toBe(r.text.length);
  });

  it('同类重复应用：去重幂等，文本不变', () => {
    const r1 = applyToolbar('x', 0, 1, COLOR_BUTTONS[0]!.action); // [x]{.c-red}
    const r2 = applyToolbar(r1.text, r1.start, r1.end, COLOR_BUTTONS[0]!.action);
    expect(r2.text).toBe('[x]{.c-red}');
    expect(r2.start).toBe(0);
    expect(r2.end).toBe(r1.text.length);
  });

  it('跨组/无组选区不受影响：普通包裹（嵌套留给用户自决）', () => {
    expect(wrapSelection('a[x]{.c-red}b', 0, 13, '[', ']{.fs-lg}')).toEqual({
      text: '[a[x]{.c-red}b]{.fs-lg}',
      start: 1,
      end: 14,
    });
  });

  it('链接按钮（before=[ 但非属性组）不受合并影响', () => {
    expect(wrapSelection('x', 0, 1, '[', '](https://)')).toEqual({
      text: '[x](https://)',
      start: 1,
      end: 2,
    });
  });
});