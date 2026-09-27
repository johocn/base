import { describe, expect, it } from 'vitest';

import { compareVersionName, decideUpdate, parseVersionName } from './update';

describe('parseVersionName', () => {
  it('三段数字合法', () => {
    expect(parseVersionName('0.2.0')).toEqual([0, 2, 0]);
  });

  it('非数字、空串、含字母一律 null', () => {
    expect(parseVersionName('')).toBeNull();
    expect(parseVersionName('0.2')).toEqual([0, 2]);
    expect(parseVersionName('0.2.0-beta')).toBeNull();
    expect(parseVersionName('v0.2.0')).toBeNull();
    expect(parseVersionName('0..2')).toBeNull();
  });
});

describe('compareVersionName', () => {
  it('三段数值比较，不是字符串比较', () => {
    expect(compareVersionName('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersionName('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersionName('0.2.0', '0.2.0')).toBe(0);
  });

  it('段数不等时缺位按 0', () => {
    expect(compareVersionName('0.1', '0.1.0')).toBe(0);
    expect(compareVersionName('0.1', '0.1.1')).toBe(-1);
  });

  it('任一侧非法返回 null（文档判为不可用）', () => {
    expect(compareVersionName('0.1.0', 'beta')).toBeNull();
  });
});

describe('decideUpdate', () => {
  const base = { schema_version: 1, version_name: '0.2.0', min_version_name: '0.1.0' };

  it('本地已是最新', () => {
    expect(decideUpdate('0.2.0', base)).toBe('latest');
    expect(decideUpdate('0.3.0', base)).toBe('latest');
  });

  it('可取消更新与强制更新由 min_version_name 分界', () => {
    expect(decideUpdate('0.1.0', base)).toBe('optional');
    expect(decideUpdate('0.1.0', { ...base, min_version_name: '0.2.0' })).toBe('forced');
  });

  it('schema_version 不符或版本串非法 → ignore', () => {
    expect(decideUpdate('0.1.0', { ...base, schema_version: 2 })).toBe('ignore');
    expect(decideUpdate('beta', base)).toBe('ignore');
    expect(decideUpdate('0.1.0', { ...base, version_name: 'beta' })).toBe('ignore');
  });
});