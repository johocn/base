/**
 * 属性槽位镜像（本册 §2.1）：与 Go 侧 `internal/protocol/attrs.go` **逐字节同构**。
 *
 * 两端都要自己算 `content_hash`（作者签名覆盖它），任一端改了 `seq<0` 的分配顺序都会让
 * 同一字段集在两端算出不同哈希——且**不会报错**，只会被当成新版本静默入库（§8 风险 2）。
 * 故 `vectors/v1/attrs.json` 由两端共读，是这条规则唯一的守门（AC 1）。
 */
import { sha256Hex, utf8 } from '@base/protocol-ts';

import type { SegmentRow } from './types';

export const ATTR_KIND_PREFIX = 'attr.';

export const ATTR_ATTACHMENT = 'attr.attachment';
export const ATTR_BODY_MD = 'attr.body_md';
export const ATTR_COVER = 'attr.cover';
export const ATTR_DIFFICULTY = 'attr.difficulty';
export const ATTR_DURATION = 'attr.duration';
export const ATTR_INSTRUCTOR = 'attr.instructor';

export const DIFFICULTY_INTRO = 'intro';
export const DIFFICULTY_BASIC = 'basic';
export const DIFFICULTY_ADVANCED = 'advanced';

/** `seq=0` 的简介行 kind（既有约定，一字不改）。 */
export const DIGEST_KIND = 'digest';

/** 编辑页难度下拉的取值域（与上面三个常量同源）。 */
export const DIFFICULTY_CHOICES = [DIFFICULTY_INTRO, DIFFICULTY_BASIC, DIFFICULTY_ADVANCED];

const ATTR_KIND_SET: Record<string, true> = {
  [ATTR_ATTACHMENT]: true,
  [ATTR_BODY_MD]: true,
  [ATTR_COVER]: true,
  [ATTR_DIFFICULTY]: true,
  [ATTR_DURATION]: true,
  [ATTR_INSTRUCTOR]: true,
};

/** 判定 kind 是否为合法属性行（本册 §2.1 铁律 1）。 */
export function isAttrKind(kind: string): boolean {
  return ATTR_KIND_SET[kind] === true;
}

export interface AttrLine {
  kind: string;
  text: string;
}

export interface AttrSlot {
  seq: number;
  kind: string;
  text: string;
}

/**
 * 按本册 §2.1 铁律 2 为属性行分配 `seq<0`（与 `protocol.AssignAttrSeqs` 同一规则）：
 *  1. 按 kind **字典序**从 -1 起递减；
 *  2. 同一 kind 至多一行，唯 `attr.attachment` 可多行——多行占**连续递减区间**，
 *     同一 kind 内按 text（含 `<blob_id>\t<文件名>` 的整串）升序映射到递减 seq。
 *
 * 返回值天然按 seq 升序（首元素 seq 最小 = -1）。
 */
export function assignAttrSeqs(lines: AttrLine[]): AttrSlot[] {
  const byKind = new Map<string, string[]>();
  for (const l of lines) {
    const cur = byKind.get(l.kind);
    if (cur) cur.push(l.text);
    else byKind.set(l.kind, [l.text]);
  }
  const kinds = [...byKind.keys()].sort();
  const out: AttrSlot[] = [];
  let next = -1;
  for (const k of kinds) {
    const texts = byKind.get(k) ?? [];
    if (k === ATTR_ATTACHMENT) {
      for (const t of [...texts].sort()) {
        out.push({ seq: next, kind: k, text: t });
        next -= 1;
      }
      continue;
    }
    if (texts.length === 0) continue;
    out.push({ seq: next, kind: k, text: texts[0]! });
    next -= 1;
  }
  return out;
}

/** 报告一组属性行是否已按 `assignAttrSeqs` 的规则排布（调用方按 seq 升序传入）。 */
export function attrSeqsCanonical(slots: AttrSlot[]): boolean {
  const want = assignAttrSeqs(slots.map((s) => ({ kind: s.kind, text: s.text })));
  if (want.length !== slots.length) return false;
  return want.every((w, i) => w.seq === slots[i]!.seq && w.kind === slots[i]!.kind && w.text === slots[i]!.text);
}

/** 一条待提交的 `segments` 行（`POST /v1/submit` 的 `segments` 元素，本册 §2.3）。 */
export interface SubmitSegmentRow {
  seq: number;
  kind: string;
  text: string;
}

/**
 * 容器口径 `content_hash`（#14 §3.3 / 本册 §2.3）：按 seq 升序拼 `"<kind>\t<text>\n"` 的 sha256。
 * 与节点 `store.SegmentsContentHash` 逐字节同构——作者签名覆盖它，故客户端必须自己算出来。
 */
export function segmentsContentHash(rows: Array<Pick<SegmentRow, 'seq' | 'kind' | 'text'>>): string {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  return sha256Hex(utf8(ordered.map((r) => `${r.kind}\t${r.text}\n`).join('')));
}