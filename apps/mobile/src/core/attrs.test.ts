import { readFileSync } from 'node:fs';

import { sha256Hex, utf8 } from '@base/protocol-ts';
import { describe, expect, it } from 'vitest';

import {
  ATTR_BODY_MD,
  ATTR_COVER,
  ATTR_INSTRUCTOR,
  assignAttrSeqs,
  attrSeqsCanonical,
  isAttrKind,
  segmentsContentHash,
  type AttrSlot,
} from './attrs';

interface VectorCase {
  name: string;
  lines: Array<{ kind: string; text: string }>;
  slots: AttrSlot[];
}

const vectors = JSON.parse(
  readFileSync(new URL('../../../../vectors/v1/attrs.json', import.meta.url), 'utf8'),
) as { version: number; cases: VectorCase[] };

describe('attrs：与 Go 共读同一份契约向量', () => {
  it('向量文件结构', () => {
    expect(vectors.version).toBe(1);
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  for (const c of vectors.cases) {
    it(c.name, () => {
      expect(assignAttrSeqs(c.lines)).toEqual(c.slots);
      // 向量自身必须是规范排布，否则 canonical 这道门形同虚设
      expect(attrSeqsCanonical(c.slots)).toBe(true);
    });
  }
});

describe('attrs：分配规则边界', () => {
  it('同 kind 至多一行（唯 attachment 可多行），超出取首行', () => {
    expect(
      assignAttrSeqs([
        { kind: ATTR_INSTRUCTOR, text: '甲' },
        { kind: ATTR_INSTRUCTOR, text: '乙' },
      ]),
    ).toEqual([{ seq: -1, kind: ATTR_INSTRUCTOR, text: '甲' }]);
  });

  it('isAttrKind 只认六种属性 kind', () => {
    expect(isAttrKind(ATTR_COVER)).toBe(true);
    expect(isAttrKind(ATTR_BODY_MD)).toBe(true);
    for (const k of ['', 'attr.', 'attr.unknown', 'digest', 'lesson', 'article']) {
      expect(isAttrKind(k)).toBe(false);
    }
  });

  it('非规范排布（顺序颠倒）不得通过 canonical', () => {
    expect(
      attrSeqsCanonical([
        { seq: -1, kind: ATTR_INSTRUCTOR, text: '甲' },
        { seq: -2, kind: ATTR_COVER, text: '00112233445566778899aabbccddeeff' },
      ]),
    ).toBe(false);
  });
});

describe('attrs：容器 content_hash 口径', () => {
  it('按 seq 升序拼 "<kind>\\t<text>\\n"', () => {
    const rows = [
      { seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1' },
      { seq: -1, kind: ATTR_COVER, text: '00112233445566778899aabbccddeeff' },
      { seq: 0, kind: 'digest', text: '简介' },
    ];
    expect(segmentsContentHash(rows)).toBe(
      sha256Hex(utf8('attr.cover\t00112233445566778899aabbccddeeff\ndigest\t简介\nlesson\tcourse/c1/lesson/l1\n')),
    );
    // 输入顺序不影响：内部按 seq 升序归一
    expect(segmentsContentHash([...rows].reverse())).toBe(segmentsContentHash(rows));
  });
});