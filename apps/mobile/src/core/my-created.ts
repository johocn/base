/**
 * 「我创建的」视图模型（本册 §7）与台账行集 → 详情渲染的桥。
 * 纯函数、不碰 IO、不 import 'uni'——台账本体由 `LocalRepo.listSubmissions`（`queued_at ASC`）喂入，
 * 本模块只把行集收窄成列表视图、并从 `segments_json` 还原容器详情所需的读取视图。
 */
import { attrsOf, childrenRowsOf, digestOf } from './container-view';
import { emptyContainerForm, type ContainerForm, type ContainerType } from './course-edit';
import type { MySubmissionRow, SegmentRow } from './types';

/** 「我创建的」区可展示的载体类型（台账里的 tag 载体不进本视图）。 */
export type MyCreatedType = 'article' | 'quiz' | 'course' | 'lesson';

/** 列表行视图：台账行的展示子集 + 状态标签。 */
export interface MyCreatedRow {
  itemId: string;
  type: MyCreatedType;
  title: string;
  state: 'pending' | 'sent' | 'failed';
  reason: string;
  statusLabel: string;
}

/** 投稿状态 → 中文标签。 */
export function statusLabelOf(s: MySubmissionRow['state']): string {
  switch (s) {
    case 'pending':
      return '待补发';
    case 'failed':
      return '失败';
    case 'sent':
      return '已同步';
  }
}

/**
 * 台账行集 → 「我创建的」列表（本册去重口径）：
 * 1. 排除 tag 载体；
 * 2. `sent` 且 `packItemIds` 含该 id（库内已同步）⇒ 跳过；其余一律列出。
 * 不重排——顺序由 `listSubmissions` 的 `queued_at ASC` 保证。
 */
export function buildMyCreatedView(rows: MySubmissionRow[], packItemIds: Set<string>): MyCreatedRow[] {
  const out: MyCreatedRow[] = [];
  for (const r of rows) {
    if (r.type === 'tag') continue;
    if (r.state === 'sent' && packItemIds.has(r.itemId)) continue;
    out.push({
      itemId: r.itemId,
      type: r.type,
      title: r.title,
      state: r.state,
      reason: r.reason ?? '',
      statusLabel: statusLabelOf(r.state),
    });
  }
  return out;
}

/**
 * `segments_json` → `SegmentRow[]`：空串或坏 JSON 一律返回 `[]`（不抛——一行坏数据不该让列表打不开）。
 * `contentHash: ''` 仅用于复用读取器，不参与任何哈希（本册不写包表、不入队）。
 */
export function ledgerSegmentsOf(row: MySubmissionRow): SegmentRow[] {
  if (row.segmentsJson === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.segmentsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((x) => ({
    itemId: row.itemId,
    seq: Number((x as { seq: unknown }).seq),
    kind: String((x as { kind: unknown }).kind),
    text: String((x as { text: unknown }).text),
    contentHash: '',
  }));
}

/**
 * 台账行 → 容器编辑表单：与 `core/course-edit.ts` 的 `loadContainerForm` **逐字段同构**，
 * 唯一差别是数据源由 `repo` 换成 `segments_json`。课程恒不吃正文。
 */
export function containerFormFromLedger(row: MySubmissionRow): ContainerForm {
  const segs = ledgerSegmentsOf(row);
  const attrs = attrsOf(segs);
  const form = emptyContainerForm(row.type as ContainerType, row.itemId);
  form.title = row.title;
  form.digest = digestOf(segs);
  form.cover = attrs.cover;
  form.instructor = attrs.instructor;
  form.difficulty = attrs.difficulty;
  form.durationSec = attrs.duration;
  form.attachments = attrs.attachments.map((a) => ({ blobId: a.blobId, name: a.name }));
  form.bodyMd = row.type === 'lesson' ? attrs.bodyMd : '';
  form.category = row.type === 'course' ? attrs.category : '';
  form.children = childrenRowsOf(segs).map((r) => ({ kind: r.kind, itemId: r.text }));
  return form;
}