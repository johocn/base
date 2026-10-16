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

/** 组后缀形态：`]{.cls}` 起始段（属性组感知合并用；`{.a .b}` 空格分段式，见 protocol-ts 渲染器）。 */
const GROUP_SUFFIX = /^\]\{(\.[\w-]+)(?: \.[\w-]+)*\}/;

/** 类并集去重（先旧后新），回吐 `{.a .b}` 分段式。 */
function mergeClasses(existing: string[], add: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [...existing, ...add]) {
    if (seen.has(c)) continue;
    seen.add(c);
    out.push('.' + c);
  }
  return out.join(' ');
}

/** 属性组合并（真机反馈 0.21.5：字号后再套色会嵌套 `[[x]{.fs-lg}]{.c-red}`，渲染失效）。
 *  情形 A：选区恰为完整属性组 → 类并集合并进该组；
 *  情形 B：选区为外层组内文（前邻 `[` 且紧跟 `]{.cls…}`，内文不含括号）→ 合并进外层组。
 *  两情形选区都保持覆盖整组，便于连续叠加属性；不匹配返回 null 走普通包裹。 */
function wrapAttributeGroup(text: string, s: number, e: number, after: string): EditResult | null {
  const add = after.slice(2, -1).split('.').filter(Boolean);
  const selected = text.slice(s, e);
  const whole = /^\[([^\[\]]*)\]\{(\.[\w-]+(?: \.[\w-]+)*)\}$/.exec(selected);
  if (whole) {
    const existing = whole[2].split(' ').map((x) => x.slice(1));
    const repl = '[' + whole[1] + ']{' + mergeClasses(existing, add) + '}';
    return { text: text.slice(0, s) + repl + text.slice(e), start: s, end: s + repl.length };
  }
  if (s > 0 && text[s - 1] === '[' && !/[\[\]]/.test(selected)) {
    const m = GROUP_SUFFIX.exec(text.slice(e));
    if (m) {
      const existing = m[1].split(' ').map((x) => x.slice(1));
      const suffix = ']{' + mergeClasses(existing, add) + '}';
      return {
        text: text.slice(0, e) + suffix + text.slice(e + m[0].length),
        start: s - 1,
        end: e + suffix.length,
      };
    }
  }
  return null;
}

/** 行内 / 色块：有选区则包裹，无选区插入一对空标记并把光标夹在中间。
 *  `[`…`]{.cls}` 形态的工具先试属性组合并（字号/颜色叠加同一组，不嵌套）。 */
export function wrapSelection(
  text: string,
  start: number,
  end: number,
  before: string,
  after: string,
): EditResult {
  const s = clamp(start, 0, text.length);
  const e = clamp(end, s, text.length);
  if (before === '[' && /^\]\{(\.[\w-]+)+\}$/.test(after)) {
    const merged = wrapAttributeGroup(text, s, e, after);
    if (merged) return merged;
  }
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

/** 字号三档（册子 #83 §4.3）：标准 15px 不需标记；before 固定 `[`，与色块同构。 */
export const SIZE_OPTIONS: ToolbarButton[] = [
  { key: 'fs-sm', label: '小', action: { kind: 'wrap', before: '[', after: ']{.fs-sm}' } },
  { key: 'fs-lg', label: '大', action: { kind: 'wrap', before: '[', after: ']{.fs-lg}' } },
  { key: 'fs-xl', label: '特大', action: { kind: 'wrap', before: '[', after: ']{.fs-xl}' } },
];