// core/markdown-toolbar.ts 提供编辑端工具栏的纯文本变换：
// 段落级加前缀、行内/色块包裹选区、分隔线插入。产物是 §2 的源文本标记，
// 不产 HTML、不落库、不参与哈希；只做「字符串 + 选区」的纯函数，
// 不 import 'uni' / 'plus'（core 层不变式），可在 Node 下单测。

export interface EditResult {
  /** 变换后的整段文本 */
  text: string;
  /** 变换后应选中的起点（等于 end 即光标夹位） */
  start: number;
  /** 变换后应选中的终点 */
  end: number;
}

export type ToolbarAction =
  | { kind: 'wrap'; before: string; after: string }
  | { kind: 'prefix'; prefix: string }
  | { kind: 'hr' };

export interface ToolbarButton {
  key: string;
  /** 语义词：色块按钮按语义命名，不按颜色命名（#44 §12 风险 5） */
  label: string;
  action: ToolbarAction;
  /** 类名小字：色块按钮在语义标签旁附注的枚举类名 */
  hint?: string;
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n) || n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/** 行内 / 色块：有选区则包裹，无选区插入一对空标记并把光标夹在中间。 */
export function wrapSelection(
  text: string,
  start: number,
  end: number,
  before: string,
  after: string,
): EditResult {
  const s = clamp(start, 0, text.length);
  const e = clamp(end, s, text.length);
  const selected = text.slice(s, e);
  const next = text.slice(0, s) + before + selected + after + text.slice(e);
  if (s === e) {
    const caret = s + before.length;
    return { text: next, start: caret, end: caret };
  }
  return { text: next, start: s + before.length, end: s + before.length + selected.length };
}

/** 段落级：给选区覆盖的每行（无选区则光标所在行）加前缀。 */
export function prefixLines(
  text: string,
  start: number,
  end: number,
  prefix: string,
): EditResult {
  const s = clamp(start, 0, text.length);
  const e = clamp(end, s, text.length);
  const lineStart = text.lastIndexOf('\n', s - 1) + 1;
  if (s === e) {
    const next = text.slice(0, lineStart) + prefix + text.slice(lineStart);
    const caret = s + prefix.length;
    return { text: next, start: caret, end: caret };
  }
  const nl = text.indexOf('\n', e);
  const lineEnd = nl < 0 ? text.length : nl;
  const block = text.slice(lineStart, lineEnd);
  const updated = block
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
  return {
    text: text.slice(0, lineStart) + updated + text.slice(lineEnd),
    start: lineStart,
    end: lineStart + updated.length,
  };
}

/** 分隔线：另起一行插入 `---`，光标落到其后。 */
export function insertSeparator(text: string, start: number, end: number): EditResult {
  const s = clamp(start, 0, text.length);
  const e = clamp(end, s, text.length);
  const lead = s > 0 && text[s - 1] !== '\n' ? '\n' : '';
  const trail = e < text.length && text[e] === '\n' ? '' : '\n';
  const insert = lead + '---' + trail;
  const next = text.slice(0, s) + insert + text.slice(e);
  const caret = s + insert.length;
  return { text: next, start: caret, end: caret };
}

/** 按按钮动作派发到对应的纯变换。 */
export function applyToolbar(
  text: string,
  start: number,
  end: number,
  action: ToolbarAction,
): EditResult {
  if (action.kind === 'wrap') return wrapSelection(text, start, end, action.before, action.after);
  if (action.kind === 'prefix') return prefixLines(text, start, end, action.prefix);
  return insertSeparator(text, start, end);
}

/** 段落级按钮：标题 / 引用 / 无序列表 / 有序列表 / 分隔线。 */
export const PARAGRAPH_BUTTONS: ToolbarButton[] = [
  { key: 'heading', label: '标题', action: { kind: 'prefix', prefix: '## ' } },
  { key: 'quote', label: '引用', action: { kind: 'prefix', prefix: '> ' } },
  { key: 'ul', label: '无序列表', action: { kind: 'prefix', prefix: '- ' } },
  { key: 'ol', label: '有序列表', action: { kind: 'prefix', prefix: '1. ' } },
  { key: 'hr', label: '分隔线', action: { kind: 'hr' } },
];

/** 行内按钮：粗 / 斜 / 行内代码 / 链接。 */
export const INLINE_BUTTONS: ToolbarButton[] = [
  { key: 'bold', label: '加粗', action: { kind: 'wrap', before: '**', after: '**' } },
  { key: 'italic', label: '斜体', action: { kind: 'wrap', before: '*', after: '*' } },
  { key: 'code', label: '行内代码', action: { kind: 'wrap', before: '`', after: '`' } },
  { key: 'link', label: '链接', action: { kind: 'wrap', before: '[', after: '](https://)' } },
];

/** 7 个色块按钮：语义命名，hint 标出对应枚举类名（两页共用同一套）。 */
export const COLOR_BUTTONS: ToolbarButton[] = [
  { key: 'c-red', label: '强调', hint: 'c-red', action: { kind: 'wrap', before: '[', after: ']{.c-red}' } },
  { key: 'c-orange', label: '提示', hint: 'c-orange', action: { kind: 'wrap', before: '[', after: ']{.c-orange}' } },
  { key: 'c-green', label: '补充', hint: 'c-green', action: { kind: 'wrap', before: '[', after: ']{.c-green}' } },
  { key: 'c-blue', label: '说明', hint: 'c-blue', action: { kind: 'wrap', before: '[', after: ']{.c-blue}' } },
  { key: 'c-purple', label: '重点', hint: 'c-purple', action: { kind: 'wrap', before: '[', after: ']{.c-purple}' } },
  { key: 'c-gray', label: '弱化', hint: 'c-gray', action: { kind: 'wrap', before: '[', after: ']{.c-gray}' } },
  { key: 'c-mark', label: '高亮', hint: 'c-mark', action: { kind: 'wrap', before: '[', after: ']{.c-mark}' } },
];