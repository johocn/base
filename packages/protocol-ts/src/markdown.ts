// core/markdown.ts 提供 attr.body_md / articles.body_md 的渲染管线：
// 「解析 + 消毒」单出口，把 Markdown 子集与变色扩展 [文字]{.c-x} 转为白名单 HTML。
//
// 渲染是只读派生：产物不落库、不入包、不参与哈希。白名单在产出时逐点强制——
// 只生成 h1/h2/h3/p/ul/ol/li/blockquote/pre/code/strong/em/a/img/hr/br/span，
// 属性仅 a[href]/img[src]/img[alt]/span[class]，class 只认 7 个枚举名，
// href/src 仅 http:// 与 https://（否则只丢该属性），文本节点转义 & < >。
//
// 与 Go 侧 internal/markdown 逐决策镜像，共读 vectors/v1/markdown.json。
// 只依赖自身，不 import 'uni' / 'plus'（core 层不变式）。

const HEADING_RE = /^(#{1,})[ \t\f\r]+(.*)$/;
const HR_RE = /^-{3,}$/;
const UL_RE = /^([ \t\f\r]*)- +(.*)$/;
const OL_RE = /^([ \t\f\r]*)[0-9]+\. +(.*)$/;

const headingTags = ['', 'h1', 'h2', 'h3'];

// 变色扩展的 7 个枚举类名（span[class] 的合法取值）。
const colorClasses = new Set(['red', 'orange', 'green', 'blue', 'purple', 'gray', 'mark']);

interface Parsed {
  html: string;
  len: number;
}

interface ListItem {
  text: string;
  ordered: boolean;
  children: ListItem[];
}

/** 渲染并消毒 src，返回 HTML 字符串（App 侧唯一出口）。 */
export function renderMarkdown(src: string): string {
  return renderBlocks(src.split('\n'));
}

function trimSpace(s: string): string {
  return s.trim();
}

function renderBlocks(lines: string[]): string {
  let out = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (trimSpace(line) === '') {
      i++;
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      let level = h[1].length;
      if (level > 3) level = 3;
      const tag = headingTags[level];
      out += '<' + tag + '>' + inline(h[2]) + '</' + tag + '>';
      i++;
      continue;
    }
    if (HR_RE.test(trimSpace(line))) {
      out += '<hr>';
      i++;
      continue;
    }
    if (line.startsWith('> ')) {
      const parts: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        parts.push(inline(lines[i].slice(2)));
        i++;
      }
      out += '<blockquote>' + parts.join('<br>') + '</blockquote>';
      continue;
    }
    if (isListLine(line)) {
      const start = i;
      while (i < lines.length && isListLine(lines[i])) i++;
      out += renderList(lines.slice(start, i));
      continue;
    }
    const parts: string[] = [];
    while (i < lines.length && trimSpace(lines[i]) !== '' && !isBlockStart(lines[i])) {
      parts.push(inline(lines[i]));
      i++;
    }
    out += '<p>' + parts.join('<br>') + '</p>';
  }
  return out;
}

function isListLine(line: string): boolean {
  return UL_RE.test(line) || OL_RE.test(line);
}

function isBlockStart(line: string): boolean {
  return (
    HEADING_RE.test(line) ||
    HR_RE.test(trimSpace(line)) ||
    line.startsWith('> ') ||
    isListLine(line)
  );
}

function renderList(lines: string[]): string {
  const items: ListItem[] = [];
  let outerOrdered = false;
  for (const line of lines) {
    const p = parseListItem(line);
    if (!p) continue;
    if (p.indent === 0) {
      if (items.length === 0) outerOrdered = p.ordered;
      items.push({ text: p.content, ordered: false, children: [] });
    } else if (items.length > 0) {
      items[items.length - 1].children.push({
        text: p.content,
        ordered: p.ordered,
        children: [],
      });
    }
  }
  return renderListItems(items, outerOrdered);
}

function parseListItem(
  line: string,
): { indent: number; content: string; ordered: boolean } | null {
  const u = UL_RE.exec(line);
  if (u) return { indent: u[1].length, content: u[2], ordered: false };
  const o = OL_RE.exec(line);
  if (o) return { indent: o[1].length, content: o[2], ordered: true };
  return null;
}

function renderListItems(items: ListItem[], ordered: boolean): string {
  const tag = ordered ? 'ol' : 'ul';
  let out = '<' + tag + '>';
  for (const it of items) {
    out += '<li>' + inline(it.text);
    if (it.children.length > 0) {
      out += renderListItems(it.children, it.children[0].ordered);
    }
    out += '</li>';
  }
  out += '</' + tag + '>';
  return out;
}

// inline 解析行内标记，逐码元扫描并把字符原样回写以保证多字节 UTF-8 不被破坏。
function inline(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && (s[i + 1] === '[' || s[i + 1] === ']')) {
      out += s[i + 1];
      i += 2;
    } else if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j >= 0) {
        out += '<code>' + escapeText(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
      } else {
        out += '`';
        i += 1;
      }
    } else if (c === '*') {
      const r = parseEmphasis(s.slice(i));
      if (r) {
        out += r.html;
        i += r.len;
      } else {
        out += '*';
        i += 1;
      }
    } else if (c === '!') {
      const r = parseImage(s.slice(i));
      if (r) {
        out += r.html;
        i += r.len;
      } else {
        out += '!';
        i += 1;
      }
    } else if (c === '[') {
      const r = parseBracket(s.slice(i));
      if (r) {
        out += r.html;
        i += r.len;
      } else {
        out += '[';
        i += 1;
      }
    } else {
      out += escapeChar(c);
      i += 1;
    }
  }
  return out;
}

function parseEmphasis(s: string): Parsed | null {
  if (s.length >= 2 && s[1] === '*') {
    const j = s.indexOf('**', 2);
    if (j >= 0) return { html: '<strong>' + inline(s.slice(2, j)) + '</strong>', len: j + 2 };
    return null;
  }
  const j = s.indexOf('*', 1);
  if (j >= 0) return { html: '<em>' + inline(s.slice(1, j)) + '</em>', len: j + 1 };
  return null;
}

function parseImage(s: string): Parsed | null {
  if (s.length < 2 || s[1] !== '[') return null;
  const k = s.indexOf(']', 2);
  if (k < 0) return null;
  const alt = s.slice(2, k);
  const rest = s.slice(k + 1);
  if (!rest.startsWith('(')) return null;
  const u = parseURL(rest);
  if (!u) return null;
  let out = '<img';
  if (safeURL(u.url)) out += ' src="' + escapeAttr(u.url) + '"';
  out += ' alt="' + escapeAttr(alt) + '">';
  return { html: out, len: k + 1 + u.len };
}

// parseBracket 处理 [文字] 后缀消歧：先试变色后缀 {.c-，再试链接后缀 (。
function parseBracket(s: string): Parsed | null {
  const k = s.indexOf(']', 1);
  if (k < 0) return null;
  const content = s.slice(1, k);
  const rest = s.slice(k + 1);
  if (rest.startsWith('{.c-')) {
    const end = rest.indexOf('}');
    if (end < 0) return null;
    const len = k + 1 + end + 1;
    const cls = rest.slice(4, end);
    if (colorClasses.has(cls)) {
      return { html: '<span class="c-' + cls + '">' + inline(content) + '</span>', len };
    }
    // 未知类名：整段按字面量原样输出，不产 span。
    return { html: '[' + escapeText(content) + ']' + escapeText(rest.slice(0, end + 1)), len };
  }
  if (rest.startsWith('(')) {
    const u = parseURL(rest);
    if (!u) return null;
    const href = safeURL(u.url) ? ' href="' + escapeAttr(u.url) + '"' : '';
    return { html: '<a' + href + '>' + inline(content) + '</a>', len: k + 1 + u.len };
  }
  return null;
}

// parseURL 从 s[0]=='(' 起按括号配平取到匹配的 ')'，返回 url 与其后位移。
function parseURL(s: string): { url: string; len: number } | null {
  let depth = 0;
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '(') {
      depth++;
    } else if (s[j] === ')') {
      depth--;
      if (depth === 0) return { url: s.slice(1, j), len: j + 1 };
    }
  }
  return null;
}

function safeURL(u: string): boolean {
  return u.startsWith('http://') || u.startsWith('https://');
}

function escapeChar(c: string): string {
  if (c === '&') return '&amp;';
  if (c === '<') return '&lt;';
  if (c === '>') return '&gt;';
  return c;
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}