import { describe, expect, it } from 'vitest';

import { emptyContainerForm, toLocalContainer } from './course-edit';
import { MemoryRepo } from './fakes';
import { buildLessonList } from './lesson-list';
import type { SegmentRow } from './types';

/** 造一条本地课时条目（走 #56 的既有出口，不手搓 items / segments）。 */
async function seedLesson(repo: MemoryRepo, id: string, title: string) {
  const { item, segments } = toLocalContainer({ ...emptyContainerForm('lesson', id), title }, '2026-10-01T00:00:00Z');
  await repo.upsertLocalContainer(item, segments);
}

describe('buildLessonList（册子 #65 §3）', () => {
  it('本地有条目 ⇒ 出标题；无条目 ⇒ 回落 id 且副标题为「本地未同步」；序号连续', async () => {
    const repo = new MemoryRepo();
    await seedLesson(repo, 'course/c1/lesson/l1', '第一讲');
    const out = await buildLessonList(
      repo,
      ['course/c1/lesson/l1', 'course/c1/lesson/l9'],
      { courseSegs: null, links: [] },
    );
    expect(out).toEqual([
      { itemId: 'course/c1/lesson/l1', no: 1, title: '第一讲', sub: '空课时', tags: [] },
      {
        itemId: 'course/c1/lesson/l9',
        no: 2,
        title: 'course/c1/lesson/l9',
        sub: '本地未同步（点开按 id 直接查）',
        tags: [],
      },
    ]);
  });

  it('有课程行集 ⇒ 序号取清单位次（不信入参次序）', async () => {
    const repo = new MemoryRepo();
    await seedLesson(repo, 'course/c1/lesson/l1', '第一讲');
    await seedLesson(repo, 'course/c1/lesson/l2', '第二讲');
    // 课程行集用本地库口径 `SegmentRow`（seq 即清单位次），与 Task 4 的 `repo.listSegments()` 同型。
    const courseSegs: SegmentRow[] = [
      { itemId: 'course/c1', seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1', contentHash: 'h1' },
      { itemId: 'course/c1', seq: 2, kind: 'lesson', text: 'course/c1/lesson/l2', contentHash: 'h2' },
    ];
    // 只传第 2 讲，且入参次序只有一条 —— 序号仍须是 2（由课程行集决定）。
    const out = await buildLessonList(repo, ['course/c1/lesson/l2'], { courseSegs, links: [] });
    expect(out.map((l) => ({ no: l.no, title: l.title }))).toEqual([{ no: 2, title: '第二讲' }]);
  });

  it('tags 由 links 行集过滤（台账入口传空行集 ⇒ 恒空）', async () => {
    const repo = new MemoryRepo();
    await seedLesson(repo, 'course/c1/lesson/l1', '第一讲');
    const links = [{ tagId: 'tag/数学/第一章/第一节', targetId: 'course/c1/lesson/l1', kind: 'lesson' as const }];
    const out = await buildLessonList(repo, ['course/c1/lesson/l1'], { courseSegs: null, links });
    expect(out[0]!.tags).toHaveLength(1);
    const none = await buildLessonList(repo, ['course/c1/lesson/l1'], { courseSegs: null, links: [] });
    expect(none[0]!.tags).toEqual([]);
  });
});
