import { readFileSync } from 'node:fs';

import { sha256Hex, utf8 } from './hash';
import { describe, expect, it } from 'vitest';

import {
  ATTR_BODY_MD,
  ATTR_CATEGORY,
  ATTR_COVER,
  ATTR_DIFFICULTY,
  ATTR_DURATION,
  ATTR_INSTRUCTOR,
  BADGE_WORDS_AUTHOR,
  TITLE_COLORS,
  assignAttrSeqs,
  attrSeqsCanonical,
  isAttrKind,
  isTitleColor,
  parseBadge,
  segmentsContentHash,
  serializeBadge,
  type AttrSlot,
} from './attrs';

interface VectorCase {
  name: string;
  lines: Array<{ kind: string; text: string }>;
  slots: AttrSlot[];
}

const vectors = JSON.parse(
  readFileSync(new URL('../../../vectors/v1/attrs.json', import.meta.url), 'utf8'),
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

  it('isAttrKind 只认七种属性 kind', () => {
    expect(isAttrKind(ATTR_COVER)).toBe(true);
    expect(isAttrKind(ATTR_BODY_MD)).toBe(true);
    expect(isAttrKind(ATTR_CATEGORY)).toBe(true);
    for (const k of ['', 'attr.', 'attr.unknown', 'digest', 'lesson', 'article']) {
      expect(isAttrKind(k)).toBe(false);
    }
  });

  it('不含 attr.category 的字段集排布不因新 kind 而变（老条目不破）', () => {
    // 字典序里 attr.category 落在 attr.body_md 与 attr.cover 之间；
    // 该行缺席时既有属性行的 seq 与新增常量前逐字节一致，不得整体位移。
    expect(
      assignAttrSeqs([
        { kind: ATTR_INSTRUCTOR, text: '李老师' },
        { kind: ATTR_BODY_MD, text: '# 正文' },
        { kind: ATTR_COVER, text: '00112233445566778899aabbccddeeff' },
      ]),
    ).toEqual([
      { seq: -1, kind: ATTR_BODY_MD, text: '# 正文' },
      { seq: -2, kind: ATTR_COVER, text: '00112233445566778899aabbccddeeff' },
      { seq: -3, kind: ATTR_INSTRUCTOR, text: '李老师' },
    ]);
  });

  it('非规范排布（seq 赋值错）不得通过 canonical', () => {
    expect(
      attrSeqsCanonical([
        { seq: -1, kind: ATTR_INSTRUCTOR, text: '甲' },
        { seq: -2, kind: ATTR_COVER, text: '00112233445566778899aabbccddeeff' },
      ]),
    ).toBe(false);
  });

  it('canonical 与入参数组顺序无关（≥2 条属性行）', () => {
    const cover: AttrSlot = { seq: -1, kind: ATTR_COVER, text: '00112233445566778899aabbccddeeff' };
    const difficulty: AttrSlot = { seq: -2, kind: ATTR_DIFFICULTY, text: 'basic' };
    const duration: AttrSlot = { seq: -3, kind: ATTR_DURATION, text: '600' };
    const instructor: AttrSlot = { seq: -4, kind: ATTR_INSTRUCTOR, text: '李老师' };
    // 编辑器按 assignAttrSeqs 产出的是 seq 降序；节点校验前按 seq 升序排过——两向都必须通过
    expect(attrSeqsCanonical([cover, difficulty, duration, instructor])).toBe(true);
    expect(attrSeqsCanonical([instructor, duration, difficulty, cover])).toBe(true);
    expect(attrSeqsCanonical([difficulty, cover, instructor, duration])).toBe(true);
    // 但 seq 取值本身错了仍然拦下
    expect(attrSeqsCanonical([{ ...cover, seq: -2 }, { ...difficulty, seq: -1 }, duration, instructor])).toBe(false);
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

describe('attrs：图章序列化与标题色白名单', () => {
  it('serializeBadge：去重 + 码位升序 + 半角逗号', () => {
    expect(serializeBadge(['悬赏', '活动', '悬赏', '置顶'])).toBe('悬赏,活动,置顶');
    expect(serializeBadge(['辩论', '热门', '精华', '推荐', '置顶', '悬赏', '活动'])).toBe(
      '悬赏,推荐,活动,热门,精华,置顶,辩论',
    );
    expect(serializeBadge(BADGE_WORDS_AUTHOR)).toBe('悬赏,活动,置顶,辩论');
    expect(serializeBadge([])).toBe('');
  });

  it('parseBadge：空串、去重、域外词静默丢弃并归一到规范序', () => {
    expect(parseBadge('')).toEqual([]);
    expect(parseBadge('活动,活动')).toEqual(['活动']);
    expect(parseBadge('活动,自定义词,悬赏')).toEqual(['悬赏', '活动']);
    expect(parseBadge('悬赏,活动')).toEqual(['悬赏', '活动']);
    expect(parseBadge('辩论,热门,精华,推荐,置顶,悬赏,活动')).toEqual([
      '悬赏',
      '推荐',
      '活动',
      '热门',
      '精华',
      '置顶',
      '辩论',
    ]);
  });

  it('标题色白名单：只认 6 色，c-mark 不算', () => {
    for (const c of TITLE_COLORS) expect(isTitleColor(c)).toBe(true);
    for (const c of ['', 'mark', 'c-mark', 'yellow']) expect(isTitleColor(c)).toBe(false);
  });
});