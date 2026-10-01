import { describe, expect, it } from 'vitest';

import { errorCodeOf, errorText } from './errors';

describe('错误码中文映射（本册 §4）', () => {
  it('item_segments_invalid → 行集不合法（此前落回裸兜底串）', () => {
    expect(errorText('item_segments_invalid', '提交失败（HTTP 400）')).toBe(
      '课程 / 课时的行集不合法：请检查属性与子项清单',
    );
  });

  it('auth_body_too_large → 体超限（不再被 auth_ 前缀吞成「签名校验失败」）', () => {
    expect(errorText('auth_body_too_large', '提交失败（HTTP 413）')).toBe('提交内容超过 64KB');
  });

  it('未单列的 auth_* / identity_* 仍回落「签名校验失败」', () => {
    expect(errorText('auth_nonce_replay', 'x')).toBe('签名校验失败，请重试');
    expect(errorText('identity_alg_unsupported', 'x')).toBe('签名校验失败，请重试');
  });

  it('未知码用调用方兜底文案', () => {
    expect(errorText('some_unknown_code', '提交失败（HTTP 400）')).toBe('提交失败（HTTP 400）');
  });

  it('errorCodeOf 解析 code；坏 JSON 得空串', () => {
    expect(errorCodeOf('{"code":"item_segments_invalid"}')).toBe('item_segments_invalid');
    expect(errorCodeOf('not json')).toBe('');
    expect(errorCodeOf('{}')).toBe('');
  });
});
