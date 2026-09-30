/**
 * 容器（课程 / 课时）编辑编排（本册 §6）：表单模型 ↔ `segments` 行集的来回转换。
 * 纯函数 + 一个 `saveContainer` 出口（走既有 `enqueueOrSend`）；不 import 'uni'，
 * 故可在 Node 下用 `core/fakes.ts` 完整测试（与 core/submit.ts 同一约定）。
 *
 * **子项清单由编辑页直接管**：表单里的 `children` 就是 `seq>=1` 的全集，提交时整段覆盖——
 * 节点 `UpsertSegmentSubmission` 先删同 item_id 旧行再按 seq 写入，天然是「整体替换」语义。
 */
import {
  ATTR_ATTACHMENT,
  ATTR_BODY_MD,
  ATTR_COVER,
  ATTR_DIFFICULTY,
  ATTR_DURATION,
  ATTR_INSTRUCTOR,
  DIGEST_KIND,
  assignAttrSeqs,
  type AttrLine,
  type SubmitSegmentRow,
} from './attrs';
import { attrsOf, childrenRowsOf, digestOf } from './container-view';
import type { LocalRepo } from './repo';
import {
  enqueueOrSend,
  newItemID,
  newLessonID,
  type ContainerSubmitType,
  type SubmitOptions,
  type SubmitOutcome,
} from './submit';

/** 容器类型（与 submit.ts 的 `ContainerSubmitType` 同源）。 */
export type ContainerType = ContainerSubmitType;

/** 一行附件（`attr.attachment` 的 text = `<blob_id>\t<文件名>`）。 */
export interface AttachmentRow {
  blobId: string;
  name: string;
}

/** 一行子项（`seq>=1` 的清单行）；`kind` 由容器形态决定（course 收 lesson，lesson 收 article|video|audio|quiz）。 */
export interface ChildRow {
  kind: string;
  itemId: string;
}

/** 容器编辑表单：页面可编辑字段的全集，与台账 / 行集一一对应。 */
export interface ContainerForm {
  itemId: string;
  type: ContainerType;
  title: string;
  /** 简介 → `seq=0` 的 `digest` 行；空串则不产该行 */
  digest: string;
  /** 封面 blob_id；空串 = 不产该行 */
  cover: string;
  instructor: string;
  /** intro | basic | advanced；空串 = 不产该行 */
  difficulty: string;
  /** 秒；非正数 = 不产该行 */
  durationSec: number;
  attachments: AttachmentRow[];
  /** 仅课时：Markdown 正文 → `attr.body_md`；course 恒忽略 */
  bodyMd: string;
  /** 子项清单，按展示顺序；写入时 seq 从 1 起连续 */
  children: ChildRow[];
}

/** 新建 / 编辑表单初值。`itemId` 由调用方给定并**固定**（新建时页面一打开就生成，见 Task 12）。 */
export function emptyContainerForm(type: ContainerType, itemId: string): ContainerForm {
  return {
    itemId,
    type,
    title: '',
    digest: '',
    cover: '',
    instructor: '',
    difficulty: '',
    durationSec: 0,
    attachments: [],
    bodyMd: '',
    children: [],
  };
}

/** 新建课程：生成新 id 并回填。页面打开即调用，使「+ 加一课」能立刻拼出子项 id。 */
export function startNewCourse(): ContainerForm {
  return emptyContainerForm('course', newItemID('course'));
}

/** 新建课时：挂在给定课程下（课时不独立存在，本册 §6）。 */
export function startNewLesson(courseId: string): ContainerForm {
  return emptyContainerForm('lesson', newLessonID(courseId));
}

/**
 * 表单 → `segments` 行集（本册 §4.1）：属性行（seq<0）→ 可选简介（seq=0）→ 清单（seq=1..n）。
 * 属性行必须经 `assignAttrSeqs` 排布——`seq<0` 的顺序进 content_hash，两端不一致会静默出新版本（§8 风险 2）。
 */
export function buildContainerSegments(form: ContainerForm): SubmitSegmentRow[] {
  const lines: AttrLine[] = [];
  if (form.cover !== '') lines.push({ kind: ATTR_COVER, text: form.cover });
  if (form.instructor !== '') lines.push({ kind: ATTR_INSTRUCTOR, text: form.instructor });
  if (form.difficulty !== '') lines.push({ kind: ATTR_DIFFICULTY, text: form.difficulty });
  if (form.durationSec > 0) lines.push({ kind: ATTR_DURATION, text: String(Math.trunc(form.durationSec)) });
  for (const a of form.attachments) {
    if (a.blobId !== '') lines.push({ kind: ATTR_ATTACHMENT, text: `${a.blobId}\t${a.name}` });
  }
  if (form.type === 'lesson' && form.bodyMd !== '') lines.push({ kind: ATTR_BODY_MD, text: form.bodyMd });

  const out: SubmitSegmentRow[] = assignAttrSeqs(lines).map((s) => ({ seq: s.seq, kind: s.kind, text: s.text }));
  if (form.digest !== '') out.push({ seq: 0, kind: DIGEST_KIND, text: form.digest });
  form.children.forEach((c, i) => out.push({ seq: i + 1, kind: c.kind, text: c.itemId }));
  return out;
}

/** 从本地包回填表单：标题取 `items`，其余取 `segments` 的三区间。条目不存在也得空表单，不抛。 */
export async function loadContainerForm(repo: LocalRepo, itemId: string, type: ContainerType): Promise<ContainerForm> {
  const item = await repo.getItem(itemId);
  const segs = await repo.listSegments(itemId);
  const attrs = attrsOf(segs);
  const form = emptyContainerForm(type, itemId);
  form.title = item?.title ?? '';
  form.digest = digestOf(segs);
  form.cover = attrs.cover;
  form.instructor = attrs.instructor;
  form.difficulty = attrs.difficulty;
  form.durationSec = attrs.duration;
  form.attachments = attrs.attachments.map((a) => ({ blobId: a.blobId, name: a.name }));
  form.bodyMd = type === 'lesson' ? attrs.bodyMd : '';
  form.children = childrenRowsOf(segs).map((r) => ({ kind: r.kind, itemId: r.text }));
  return form;
}

/**
 * 落一条容器投稿。新建与编辑同一条路径——`enqueueOrSend` 本身就是 upsert（本册 §4.1）：
 * 送达 → 台账 `sent`；断网 / 429 / 5xx → `pending` 待补发；其余 4xx → `failed`。
 * 三种结果都会留台账行（「我的条目」的列表本体）。
 */
export function saveContainer(o: SubmitOptions, form: ContainerForm): Promise<SubmitOutcome> {
  return enqueueOrSend(o, {
    itemId: form.itemId,
    type: form.type,
    title: form.title,
    bodyMd: '',
    questionJson: '',
    segments: buildContainerSegments(form),
  });
}