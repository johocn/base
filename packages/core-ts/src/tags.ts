/**
 * 统一标签（#37 册子 §5.2）：按目标反查、待补标签、治理人资格、打标提交（适配器侧）。
 *
 * 纯编解码段（= `internal/protocol/tag.go` 的镜像）已上提至 `@base/protocol-ts`，本文件显式 re-export 过渡。
 * 只依赖注入的 `Adapters` / `LocalRepo`，不 import 'uni'，因此可在 Node 下用 `core/fakes.ts` 完整测试。
 */
import { TAG_SEGMENT_MAX_RUNES, encodeTagPath, tagKindOfTarget, tagTitle } from '@base/protocol-ts';

import { myIdentityId, roster } from './contribution';
import { fetchGroup } from './group';
import { SubmitError, enqueueOrSend, type SubmitOptions, type SubmitOutcome } from './submit';
import type { ItemRow, TagLinkRow } from './types';

// P1 核收敛（计划 #71）：编解码段已上提到 `@base/protocol-ts`，此处显式 re-export 过渡，稳定后删除
export {
  TAG_SEGMENT_MAX_RUNES,
  encodeTagPathSegment,
  decodeTagPathSegment,
  encodeTagPath,
  tagTitle,
  decodeTagPath,
  tagKindOfTarget,
} from '@base/protocol-ts';

/** 与节点 `store.tagKindRank` 同一序：物化与渲染都按它（册子 §3.3）。 */
export const TAG_KIND_ORDER: Record<string, number> = { course: 0, lesson: 1, article: 2, comment: 3 };

/** 某目标已挂的标签行，按 `tag_id` 升序。 */
export function tagsOf(rows: TagLinkRow[], targetId: string): TagLinkRow[] {
  return rows.filter((r) => r.targetId === targetId).sort((a, b) => (a.tagId < b.tagId ? -1 : a.tagId > b.tagId ? 1 : 0));
}

/** 某标签关联的目标行：按 kind 固定序 + `target_id` 升序；`known` 里没有的目标（悬空引用）静默跳过。 */
export function linksOf(rows: TagLinkRow[], tagId: string, known: Set<string>): TagLinkRow[] {
  return rows
    .filter((r) => r.tagId === tagId && known.has(r.targetId))
    .sort((a, b) => {
      const d = (TAG_KIND_ORDER[a.kind] ?? 99) - (TAG_KIND_ORDER[b.kind] ?? 99);
      if (d !== 0) return d;
      return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0;
    });
}

/**
 * 「待补标签」清单（纯客户端反查，册子 §4 明确节点侧不做）。
 * **只认 ① 类三型**：quiz 与评论永不进待补（评论是 ① 类但按册子 §5.3 不标「待补」）。
 */
export function untaggedTargets(items: ItemRow[], rows: TagLinkRow[]): string[] {
  const tagged = new Set(rows.map((r) => r.targetId));
  return items
    .filter((i) => (i.type === 'course' || i.type === 'lesson' || i.type === 'article') && !tagged.has(i.itemId))
    .map((i) => i.itemId)
    .sort();
}

/** 打标入参：三元组 + 一个目标（一次直打只标一个目标；多目标由 `edit` 提案生效，册子 §3.5）。 */
export interface TagInput {
  name: string;
  chapter: string;
  section: string;
  targetId: string;
}

/** 打标：复用 #29 的台账与补发（联网直发、断网入队），载荷走 `core/submit.ts` 的 tag 分支。 */
export async function submitTag(o: SubmitOptions, input: TagInput): Promise<SubmitOutcome> {
  const labels = ['名称', '章', '节'];
  const segs = [input.name.trim(), input.chapter.trim(), input.section.trim()];
  for (let i = 0; i < 3; i++) {
    if (segs[i] === '') throw new SubmitError('client', `请填写${labels[i]}`);
    if ([...segs[i]!].length > TAG_SEGMENT_MAX_RUNES) {
      throw new SubmitError('client', `${labels[i]}不能超过 ${TAG_SEGMENT_MAX_RUNES} 个字`);
    }
  }
  const kind = tagKindOfTarget(input.targetId);
  if (kind === '') throw new SubmitError('client', '打标目标形态不合法');
  const itemId = encodeTagPath(segs[0]!, segs[1]!, segs[2]!);
  return enqueueOrSend(o, {
    itemId,
    type: 'tag',
    title: tagTitle(segs[0]!, segs[1]!, segs[2]!),
    bodyMd: '',
    questionJson: '',
    links: [{ tagId: itemId, targetId: input.targetId, kind }],
  });
}

/**
 * 打标资格（册子 §3.4）：#23 全站名册 ∪ #33 各圈治者集合。
 * **判不出就不给按钮**：名册都拉不到（离线）⇒ false；单圈拉取失败只跳过该圈。
 */
export async function canGovern(o: SubmitOptions): Promise<boolean> {
  const myId = await myIdentityId(o);
  if (myId === '') return false;
  try {
    if ((await roster(o)).some((c) => c.id === myId)) return true;
  } catch {
    return false;
  }
  for (const g of await o.repo.listGroups()) {
    try {
      const page = await fetchGroup(o, g.groupId);
      if (page.group.governors.includes(myId)) return true;
    } catch {
      // 单圈失败不影响其余圈
    }
  }
  return false;
}
