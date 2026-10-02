import { describe, expect, it } from 'vitest';

import {
  decodeTagPath,
  encodeTagPath,
  encodeTagPathSegment,
  tagKindOfTarget,
  tagTitle,
} from './tag';

/**
 * 与 `internal/protocol/tag_test.go` 的 `cases` 表**逐行同源**（`raw` = 用例入参、`norm` = 归一化后、
 * `id` = `wantID`）。两边任何一处漂移都会让本册的「同一标签 = 同一 item_id」失效。
 */
const GO_CASES: Array<{ raw: [string, string, string]; norm: [string, string, string]; id: string }> = [
  { raw: ['甲', '第一章', '第一节'], norm: ['甲', '第一章', '第一节'], id: 'tag/甲/第一章/第一节' },
  { raw: ['甲/乙', '第一章', '第一节'], norm: ['甲/乙', '第一章', '第一节'], id: 'tag/甲%2F乙/第一章/第一节' },
  { raw: ['甲\\乙', '第一章', '第一节'], norm: ['甲\\乙', '第一章', '第一节'], id: 'tag/甲%5C乙/第一章/第一节' },
  { raw: ['100%', '第一章', '第一节'], norm: ['100%', '第一章', '第一节'], id: 'tag/100%25/第一章/第一节' },
  { raw: ['  甲  ', ' 第一章 ', '第一节'], norm: ['甲', '第一章', '第一节'], id: 'tag/甲/第一章/第一节' },
];

describe('标签路径编码（与节点 protocol/tag.go 同口径）', () => {
  it('三段的编码/解码往返，且与 Go 侧期望值逐字一致', () => {
    for (const c of GO_CASES) {
      expect(encodeTagPath(c.raw[0], c.raw[1], c.raw[2])).toBe(c.id);
      expect(decodeTagPath(c.id)).toEqual({ name: c.norm[0], chapter: c.norm[1], section: c.norm[2] });
    }
  });

  it('斜杠、反斜杠、百分号与控制字符都被转义；中文与空格不转义', () => {
    expect(encodeTagPathSegment('a/b')).toBe('a%2Fb');
    expect(encodeTagPathSegment('a\\b')).toBe('a%5Cb');
    expect(encodeTagPathSegment('50%')).toBe('50%25');
    expect(encodeTagPathSegment('甲 乙')).toBe('甲 乙');
    expect(encodeTagPathSegment('a\nb')).toBe('a%0Ab'); // 控制字符用大写十六进制（与 Go 的 %02X 一致）
  });

  it('title = 三段以 ` · ` 连接', () => {
    expect(tagTitle('甲', '第一章', '第一节')).toBe('甲 · 第一章 · 第一节');
  });

  it('decodeTagPath 拒绝非 tag 前缀、段数不符、非十六进制转义，以及重建后不逐字相等的畸形 id', () => {
    expect(decodeTagPath('course/c1')).toBeNull();
    expect(decodeTagPath('tag')).toBeNull();
    expect(decodeTagPath('tag/甲/第一章')).toBeNull();
    expect(decodeTagPath('tag/甲/第一章/第一节/第二节')).toBeNull();
    expect(decodeTagPath('tag//第一章/第一节')).toBeNull();
    expect(decodeTagPath('tag/甲/第一章/%ZZ')).toBeNull();
    // 带空格：段能解出来，但重建值（已 trim）与入参不逐字相等 ⇒ 拒（与 Go 侧同一重建校验）
    expect(decodeTagPath('tag/ 甲 /第一章/第一节')).toBeNull();
  });
});

describe('目标形态判定', () => {
  it('六种合法形态各归其类，其余一律空串', () => {
    const hex32 = '0123456789abcdef0123456789abcdef';
    expect(tagKindOfTarget('course/c1')).toBe('course');
    expect(tagKindOfTarget('article/a1')).toBe('article');
    expect(tagKindOfTarget('course/c1/lesson/l1')).toBe('lesson');
    expect(tagKindOfTarget('course/c1/lesson/l1/article/a1')).toBe('article');
    expect(tagKindOfTarget(`comment/${hex32}`)).toBe('comment');
    expect(tagKindOfTarget('course/c1/lesson/l1/quiz/q1')).toBe('');
    expect(tagKindOfTarget(`dm/${hex32}`)).toBe('');
    expect(tagKindOfTarget('video/v1')).toBe('');
    expect(tagKindOfTarget('group/g1')).toBe('');
    expect(tagKindOfTarget('comment/0123')).toBe('');
    expect(tagKindOfTarget('course/c1/lesson/')).toBe('');
    expect(tagKindOfTarget('tag/甲/章/节')).toBe('');
    expect(tagKindOfTarget('course/')).toBe('');
  });
});
