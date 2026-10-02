import { describe, expect, it } from 'vitest';

import { SEARCH_SQL, escapeLike, searchPattern } from './search';

describe('escapeLike', () => {
  it('转义 LIKE 通配符，避免一个 % 命中全部内容', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
  });

  it('先转义反斜杠本身，避免转义被吃', () => {
    expect(escapeLike('c:\\d')).toBe('c:\\\\d');
    expect(escapeLike('50%\\_x')).toBe('50\\%\\\\\\_x');
  });
});

describe('searchPattern', () => {
  it('去掉首尾空白后包 %', () => {
    expect(searchPattern('  内容  ')).toBe('%内容%');
  });

  it('空输入返回 null（调用方据此不发查询）', () => {
    expect(searchPattern('')).toBeNull();
    expect(searchPattern('   ')).toBeNull();
  });
});

describe('SEARCH_SQL', () => {
  it('只用匿名 ? 占位符（sqlWithParams 是单遍替换，不支持 ?1）', () => {
    expect(SEARCH_SQL.match(/\?/g)?.length).toBe(3);
    expect(SEARCH_SQL).not.toMatch(/\?\d/);
  });

  it('带 ESCAPE 子句且标题命中优先排序', () => {
    expect(SEARCH_SQL).toContain("ESCAPE '\\'");
    expect(SEARCH_SQL).toContain('ORDER BY (title LIKE');
    expect(SEARCH_SQL).toContain('LIMIT 50');
  });
});