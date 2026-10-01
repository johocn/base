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
  ATTR_BADGE,
  ATTR_BODY_MD,
  ATTR_CATEGORY,
  ATTR_COVER,
  ATTR_DIFFICULTY,
  ATTR_DURATION,
  ATTR_INSTRUCTOR,
  ATTR_TITLE_COLOR,
  DIGEST_KIND,
  assignAttrSeqs,
  attrSeqsCanonical,
  isAttrKind,
  isTitleColor,
  segmentsContentHash,
  serializeBadge,
  type AttrLine,
  type AttrSlot,
  type SubmitSegmentRow,
} from './attrs';
import { attrsOf, childrenRowsOf, digestOf } from './container-view';
import type { LocalContainerInput, LocalRepo } from './repo';
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
  /** 仅课程：分类**词条键**（可中文，已规范化）；空则不产 `attr.category` 行（lesson 恒忽略） */
  category: string;
  /** 图章（多值；空数组 = 不产该行） */
  badge: string[];
  /** 标题色（6 色；空串 = 不产该行） */
  titleColor: string;
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
    category: '',
    badge: [],
    titleColor: '',
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
  const category = form.category.trim();
  if (form.cover !== '') lines.push({ kind: ATTR_COVER, text: form.cover });
  if (form.instructor !== '') lines.push({ kind: ATTR_INSTRUCTOR, text: form.instructor });
  if (form.difficulty !== '') lines.push({ kind: ATTR_DIFFICULTY, text: form.difficulty });
  if (form.durationSec > 0) lines.push({ kind: ATTR_DURATION, text: String(Math.trunc(form.durationSec)) });
  if (form.type === 'course' && category !== '') lines.push({ kind: ATTR_CATEGORY, text: category });
  for (const a of form.attachments) {
    if (a.blobId !== '') lines.push({ kind: ATTR_ATTACHMENT, text: `${a.blobId}\t${a.name}` });
  }
  if (form.type === 'lesson' && form.bodyMd !== '') lines.push({ kind: ATTR_BODY_MD, text: form.bodyMd });
  const badgeText = serializeBadge(form.badge);
  if (badgeText !== '') lines.push({ kind: ATTR_BADGE, text: badgeText });
  if (isTitleColor(form.titleColor)) lines.push({ kind: ATTR_TITLE_COLOR, text: form.titleColor });

  const out: SubmitSegmentRow[] = assignAttrSeqs(lines).map((s) => ({ seq: s.seq, kind: s.kind, text: s.text }));
  if (form.digest !== '') out.push({ seq: 0, kind: DIGEST_KIND, text: form.digest });
  form.children.forEach((c, i) => out.push({ seq: i + 1, kind: c.kind, text: c.itemId }));
  return out;
}

/**
 * 容器子项词表（与 `internal/httpapi/submit.go` 的 `childKindsByContainer` **同值同义**）。
 * 这是「客户端可判」与「节点裁决」的唯一交集，改一处必须改两处。
 */
const CHILD_KINDS_BY_CONTAINER: Record<ContainerType, string[]> = {
  course: ['lesson'],
  lesson: ['article', 'video', 'audio', 'quiz'],
};

/**
 * 行集预检（本册 §4）：判据与节点 `validateSubmitSegments` 同构，**失败指名到行**。
 * 目的是把「提交后只看到兜底 400」提前到「保存前看到是哪一行」——尤其是 `loadContainerForm`
 * 会把库里原样的 kind 带回表单、原样发回，而客户端新增行恒合法，故非法来源只能是既有清单行。
 */
export function validateContainerSegments(
  type: ContainerType,
  rows: SubmitSegmentRow[],
): { ok: boolean; message: string } {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const allowed = new Set(CHILD_KINDS_BY_CONTAINER[type]);
  const attrs: AttrSlot[] = [];
  let childNo = 0;
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i]!;
    if (i > 0 && s.seq === ordered[i - 1]!.seq) {
      return { ok: false, message: `第 ${i + 1} 行的 seq=${s.seq} 与上一行重复` };
    }
    if (s.seq < 0) {
      if (!isAttrKind(s.kind)) {
        return { ok: false, message: `属性行的 kind=${s.kind} 不合法（seq=${s.seq}）` };
      }
      attrs.push({ seq: s.seq, kind: s.kind, text: s.text });
    } else if (s.seq === 0) {
      if (s.kind !== DIGEST_KIND) {
        return { ok: false, message: `seq=0 的简介行 kind 必须是 ${DIGEST_KIND}，实际是 ${s.kind}` };
      }
    } else {
      childNo += 1;
      if (!allowed.has(s.kind)) {
        const scope = type === 'course' ? '课程只能挂课时' : '课时只能挂文章 / 视频 / 音频 / 测验';
        return { ok: false, message: `第 ${childNo} 个子项的 kind=${s.kind} 不合法：${scope}` };
      }
    }
  }
  if (!attrSeqsCanonical(attrs)) {
    return { ok: false, message: '属性行未按规范排布（seq<0 须按 kind 字典序分配）' };
  }
  return { ok: true, message: '' };
}

/**
 * 容器表单 → 本地乐观条目 + 行集（册子 #56 §2.1）：`content_hash` 用现行
 * `segmentsContentHash(orderedRows)` 算（与节点 `store.SegmentsContentHash` 逐字节同构）。
 * `saveContainer` 与 `core/creator-migrate.ts` 共用这一出口，避免两处各算一份哈希。
 */
export function toLocalContainer(
  form: ContainerForm,
  updatedAt: string,
): { item: LocalContainerInput; segments: SubmitSegmentRow[] } {
  const segments = buildContainerSegments(form);
  return {
    item: {
      itemId: form.itemId,
      type: form.type,
      title: form.title.trim(),
      contentHash: segmentsContentHash(segments),
      updatedAt,
    },
    segments,
  };
}

/**
 * 解码参数取真 id（册子 #61 §2）：先原样 `getItem`，未命中且解码形态不同时再试 `decodeURIComponent`。
 * 跳转方传的是 `encodeURIComponent(id)`，`course/<hex>` 到页面就成了 `course%2F<hex>`；
 * 命中即返回真实 id（调用方据此覆盖 `form.itemId`），都不命中返回 `null`（调用方回落原样入参）。
 */
async function resolveId(repo: LocalRepo, raw: string): Promise<string | null> {
  if (raw === '') return null;
  if ((await repo.getItem(raw)) !== null) return raw;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // 坏编码（如 course%ZZ）不是错误，回落原样即可
  }
  if (decoded === raw) return null;
  return (await repo.getItem(decoded)) !== null ? decoded : null;
}

/** 从本地包回填表单：标题取 `items`，其余取 `segments` 的三区间。条目不存在也得空表单，不抛。 */
export async function loadContainerForm(repo: LocalRepo, rawId: string, type: ContainerType): Promise<ContainerForm> {
  // 解码下沉（册子 #61 §2）：以命中的真实 id 覆盖 form.itemId —— 修好回填（Bug1）与保存 4xx（Bug4）两个症状。
  const itemId = (await resolveId(repo, rawId)) ?? rawId;
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
  form.category = type === 'course' ? attrs.category : '';
  form.badge = attrs.badge;
  form.titleColor = attrs.titleColor;
  form.children = childrenRowsOf(segs).map((r) => ({ kind: r.kind, itemId: r.text }));
  return form;
}

/**
 * 预检失败写台账 `failed`（字段与 `core/submit.ts` 的 `writeLedger` 同口径）。
 * 本函数**不导出**、也**不发网络请求**：行集非法时提交必然被节点判 `item_segments_invalid`，
 * 与其等一个兜底 400，不如本地就写明是哪一行（AC 4）。
 */
async function writeFailedLedger(
  o: SubmitOptions,
  form: ContainerForm,
  segments: SubmitSegmentRow[],
  reason: string,
): Promise<void> {
  const prev = await o.repo.getSubmission(form.itemId);
  await o.repo.saveSubmission({
    itemId: form.itemId,
    type: form.type,
    title: form.title.trim(),
    bodyMd: '',
    questionJson: '',
    linksJson: '',
    segmentsJson: JSON.stringify([...segments].sort((a, b) => a.seq - b.seq)),
    state: 'failed',
    reason,
    created: prev?.created ?? 0,
    queuedAt: new Date().toISOString(),
    sentAt: '',
    localOnly: false,
  });
}

/**
 * 落一条容器投稿。新建与编辑同一条路径——`enqueueOrSend` 本身就是 upsert（本册 §4.1）：
 * 送达 → 台账 `sent`；断网 / 429 / 5xx → `pending` 待补发；其余 4xx → `failed`。
 * 三种结果都会留台账行（「我的条目」的列表本体）。
 */
export async function saveContainer(o: SubmitOptions, form: ContainerForm): Promise<SubmitOutcome> {
  const { item, segments } = toLocalContainer(form, new Date().toISOString());
  // 先本地乐观落库（册子 #56 §2.1）：本机立刻可读、可点开、可编辑，不依赖节点重建内容包。
  await o.repo.upsertLocalContainer(item, segments);
  // 行集预检（本册 §4）：客户端能判的先判、指名到行、不发网络请求。
  const check = validateContainerSegments(form.type, segments);
  if (!check.ok) {
    await writeFailedLedger(o, form, segments, check.message);
    return { itemId: form.itemId, created: false, ledgerState: 'failed', message: check.message };
  }
  return enqueueOrSend(o, {
    itemId: form.itemId,
    type: form.type,
    title: form.title,
    bodyMd: '',
    questionJson: '',
    segments,
  });
}