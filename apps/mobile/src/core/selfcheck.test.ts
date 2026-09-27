import { describe, expect, it } from 'vitest';

import { UNKNOWN_FLAGS, canPostComment, canSync, postBlockedReason } from './selfcheck';

describe('能力标志与降级判定', () => {
  it('unknown 不降级：功能照常可用', () => {
    expect(canPostComment(UNKNOWN_FLAGS)).toBe(true);
    expect(canSync(UNKNOWN_FLAGS)).toBe(true);
    expect(postBlockedReason(UNKNOWN_FLAGS)).toBe('');
  });

  it('只有明确 fail 才降级，且各标志互不牵连', () => {
    expect(canPostComment({ ...UNKNOWN_FLAGS, cryptoOk: 'fail' })).toBe(false);
    expect(postBlockedReason({ ...UNKNOWN_FLAGS, cryptoOk: 'fail' })).toContain('随机源不可用');
    expect(canPostComment({ ...UNKNOWN_FLAGS, writeOk: 'fail' })).toBe(false);
    expect(postBlockedReason({ ...UNKNOWN_FLAGS, writeOk: 'fail' })).toContain('节点未接受写入');
    expect(canSync({ ...UNKNOWN_FLAGS, fsOk: 'fail' })).toBe(false);
    // 文件不可用不影响发表评论（两条链路互不依赖）
    expect(canPostComment({ ...UNKNOWN_FLAGS, fsOk: 'fail' })).toBe(true);
  });

  it('全 ok 不降级', () => {
    const all = { cryptoOk: 'ok', fsOk: 'ok', dbOk: 'ok', writeOk: 'ok' } as const;
    expect(canPostComment(all)).toBe(true);
    expect(canSync(all)).toBe(true);
    expect(postBlockedReason(all)).toBe('');
  });
});