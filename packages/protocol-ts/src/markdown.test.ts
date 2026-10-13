import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderMarkdown } from './markdown';

interface VectorCase {
  name: string;
  src: string;
  html: string;
}

const vectors = JSON.parse(
  readFileSync(new URL('../../../vectors/v1/markdown.json', import.meta.url), 'utf8'),
) as { version: number; cases: VectorCase[] };

describe('markdown：与 Go 共读同一份契约向量', () => {
  it('向量文件结构', () => {
    expect(vectors.version).toBe(1);
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  for (const c of vectors.cases) {
    it(c.name, () => {
      expect(renderMarkdown(c.src)).toBe(c.html);
    });
  }
});

describe('span 多 class 组合（#83）', () => {
  it('色块 + 字号组合，保持书写顺序', () => {
    expect(renderMarkdown('[文字]{.c-red .fs-lg}')).toBe('<p><span class="c-red fs-lg">文字</span></p>');
  });
  it('任一段未知 → 整段字面量原样输出', () => {
    expect(renderMarkdown('[文字]{.c-red .bogus}')).toBe('<p>[文字]{.c-red .bogus}</p>');
  });
  it('纯单 class 行为不变', () => {
    expect(renderMarkdown('[文字]{.fs-xl}')).toBe('<p><span class="fs-xl">文字</span></p>');
  });
});