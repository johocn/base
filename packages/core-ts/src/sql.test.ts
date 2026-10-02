import { describe, expect, it } from 'vitest';

import { sqlLiteral, sqlWithParams } from './sql';

describe('sqlLiteral', () => {
  it('字符串加单引号并转义内部单引号', () => {
    expect(sqlLiteral('甲')).toBe("'甲'");
    expect(sqlLiteral("it's")).toBe("'it''s'");
  });

  it('数字与布尔直出，null 走 NULL', () => {
    expect(sqlLiteral(7)).toBe('7');
    expect(sqlLiteral(true)).toBe('1');
    expect(sqlLiteral(false)).toBe('0');
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(undefined)).toBe('NULL');
  });

  it('非有限数直接抛错（避免写入 NaN）', () => {
    expect(() => sqlLiteral(Number.NaN)).toThrow(/非有限数/);
    expect(() => sqlLiteral(Number.POSITIVE_INFINITY)).toThrow(/非有限数/);
  });
});

describe('sqlWithParams', () => {
  it('按顺序替换 ? 占位符', () => {
    expect(sqlWithParams('SELECT * FROM items WHERE item_id=? AND state=?', ['article:aaa', 'active'])).toBe(
      "SELECT * FROM items WHERE item_id='article:aaa' AND state='active'",
    );
  });

  it('参数少于占位符时剩余 ? 原样保留（调用方 bug 要看得见）', () => {
    expect(sqlWithParams('SELECT ? , ?', [1])).toBe('SELECT 1 , ?');
  });
});