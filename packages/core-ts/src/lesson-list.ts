/**
 * 课程详情的课时清单视图（册子 #65 §3）：课时 id 列表 → `LessonVM[]`。
 *
 * 台账入口（`from=ledger`）与普通入口**共用这一段派生**——此前台账分支把标题硬编码回落 itemId
 * （`detail.vue` 旧实现），与普通分支口径分叉，用户看到的是 id 而不是课时标题。
 *
 * 本模块收 `LocalRepo`（与 `course-edit.ts` / `creator-migrate.ts` 同体例）：取标题与副标题都要读库；
 * 其余判定复用既有纯函数（`lessonNo` / `childCounts` / `attrsOf` / `tagsOf`），不另造口径。
 */
import { attrsOf, childCounts } from './container-view';
import { lessonNo } from './course-tree';
import type { LocalRepo } from './repo';
import { tagsOf } from './tags';
import type { SegmentRow, TagLinkRow } from './types';

export interface LessonVM {
  itemId: string;
  no: number;
  title: string;
  /** 徽标行：类型计数 / 附件 / 时长，或「空课时」「未同步」 */
  sub: string;
  tags: TagLinkRow[];
}

const KIND_LABEL: Record<string, string> = { article: '文章', quiz: '测验', video: '视频', audio: '音频' };

export interface LessonListOptions {
  /** 课程行集，用于算「第 N 讲」位次；台账入口没有这份数据 ⇒ 传 null（序号按入参次序计） */
  courseSegs: SegmentRow[] | null;
  /** tag_links 行集；台账入口不加载 ⇒ 传 [] */
  links: TagLinkRow[];
}

/** 课时 id 列表 → 视图行（顺序与入参一致；序号有课程行集时取清单位次）。 */
export async function buildLessonList(
  repo: LocalRepo,
  lessonIds: string[],
  o: LessonListOptions,
): Promise<LessonVM[]> {
  const out: LessonVM[] = [];
  for (let i = 0; i < lessonIds.length; i++) {
    const lid = lessonIds[i]!;
    const lrow = await repo.getItem(lid);
    const lsegs = await repo.listSegments(lid);
    const counts = childCounts(lsegs);
    const lattrs = attrsOf(lsegs);
    const parts: string[] = [];
    for (const k of ['article', 'quiz', 'video', 'audio']) {
      const n = counts[k] ?? 0;
      if (n > 0) parts.push(`${KIND_LABEL[k]} ${n}`);
    }
    if (lattrs.attachments.length > 0) parts.push(`附件 ${lattrs.attachments.length}`);
    if (lattrs.duration > 0) parts.push(`约 ${Math.round(lattrs.duration / 60)} 分钟`);
    // 位次由 seq 决定：空课时与未同步都照占一行，不吃掉后面课时的序号
    const sub = !lrow ? '本地未同步（点开按 id 直接查）' : parts.length === 0 ? '空课时' : parts.join(' · ');
    out.push({
      itemId: lid,
      no: (o.courseSegs === null ? 0 : lessonNo(o.courseSegs, lid)) || i + 1,
      title: lrow?.title || lid,
      sub,
      tags: tagsOf(o.links, lid),
    });
  }
  return out;
}
