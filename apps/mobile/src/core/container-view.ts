/**
 * 容器（课程 / 课时）的读取视图（本册 §5）：从 `segments` 行集里解析属性行、简介、子项清单与计数。
 * 纯函数、不碰 IO——页面只负责把 `repo.listSegments` 的结果喂进来。
 *
 * 三区间口径与节点一字不改：`seq<0` = 属性行、`seq=0` = 简介、`seq>=1` = 子项清单。
 */
import {
  ATTR_ATTACHMENT,
  ATTR_BODY_MD,
  ATTR_CATEGORY,
  ATTR_COVER,
  ATTR_DIFFICULTY,
  ATTR_DURATION,
  ATTR_INSTRUCTOR,
  DIGEST_KIND,
} from './attrs';
import type { SegmentRow } from './types';

export interface AttachmentVM {
  blobId: string;
  /** `attr.attachment` 里 `\t` 之后的名字 */
  name: string;
}

export interface ContainerAttrs {
  /** blob_id；空串 = 未设置 */
  cover: string;
  instructor: string;
  /** intro | basic | advanced；空串 = 未设置 */
  difficulty: string;
  /** 秒；0 = 未设置 */
  duration: number;
  attachments: AttachmentVM[];
  /** 仅课时有：`attr.body_md` 的 Markdown 源；空串 = 未设置 */
  bodyMd: string;
  /** 仅课程有：分类 slug；空串 = 未设置 */
  category: string;
}

/** 空属性集（新建表单的初值，也是 `attrsOf` 的基底）。 */
export function emptyAttrs(): ContainerAttrs {
  return { cover: '', instructor: '', difficulty: '', duration: 0, attachments: [], bodyMd: '', category: '' };
}

/**
 * 解析 `seq<0` 的属性行。
 * 未知 kind、`attr.attachment` 缺制表符、`attr.duration` 非正数一律**静默忽略**：
 * 属性行是「有则显示」的可选展示字段，坏一行不该让整门课打不开。
 */
export function attrsOf(segs: SegmentRow[]): ContainerAttrs {
  const out = emptyAttrs();
  // 按槽位序号（|seq|）升序 = seq 降序：与 `assignAttrSeqs` 的产出顺序一致，附件保持库内条目顺序。
  for (const s of [...segs].filter((r) => r.seq < 0).sort((a, b) => b.seq - a.seq)) {
    switch (s.kind) {
      case ATTR_COVER:
        out.cover = s.text;
        break;
      case ATTR_INSTRUCTOR:
        out.instructor = s.text;
        break;
      case ATTR_DIFFICULTY:
        out.difficulty = s.text;
        break;
      case ATTR_DURATION: {
        const n = Number(s.text);
        out.duration = Number.isFinite(n) && n > 0 ? n : 0;
        break;
      }
      case ATTR_BODY_MD:
        out.bodyMd = s.text;
        break;
      case ATTR_CATEGORY:
        out.category = s.text;
        break;
      case ATTR_ATTACHMENT: {
        const i = s.text.indexOf('\t');
        if (i > 0) out.attachments.push({ blobId: s.text.slice(0, i), name: s.text.slice(i + 1) });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** 简介：`seq=0` 且 `kind=digest` 的行文本；无则空串（既有约定，本册不改语义）。 */
export function digestOf(segs: SegmentRow[]): string {
  const hit = segs.find((s) => s.seq === 0 && s.kind === DIGEST_KIND);
  return hit ? hit.text : '';
}

/** 子项清单行（`seq>=1`，按 seq 升序）：带 kind，供编辑回填与徽标计数。 */
export function childrenRowsOf(segs: SegmentRow[]): Array<{ kind: string; text: string }> {
  return [...segs]
    .filter((s) => s.seq >= 1)
    .sort((a, b) => a.seq - b.seq)
    .map((s) => ({ kind: s.kind, text: s.text }));
}

/** 清单行的 kind 计数（课程页徽标用）；未知 kind 照数，由页面决定显不显示。 */
export function childCounts(segs: SegmentRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of childrenRowsOf(segs)) out[r.kind] = (out[r.kind] ?? 0) + 1;
  return out;
}

/** 首段：跳过空行与 `#` 标题记号，取第一行非空文本；超长按 max 截断加省略号。 */
export function firstLine(md: string, max = 60): string {
  for (const raw of md.split('\n')) {
    const line = raw.replace(/^#{1,6}\s*/, '').trim();
    if (line !== '') return line.length > max ? `${line.slice(0, max)}…` : line;
  }
  return '';
}

/**
 * 课时摘要（本册 §2.2）：**优先 `seq=0` 的既有 digest**，缺失才回落正文首段截断。
 * 新写路径不产 digest 行，故新课时恒走回落分支。
 */
export function lessonDigest(segs: SegmentRow[], max = 60): string {
  const d = digestOf(segs);
  if (d !== '') return firstLine(d, max);
  return firstLine(attrsOf(segs).bodyMd, max);
}