import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderMarkdown } from './markdown';

interface VectorCase {
  name: string;
  src: string;
  html: string;
}

const vectors = JSON.parse(
  readFileSync(new URL('../../../../vectors/v1/markdown.json', import.meta.url), 'utf8'),
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