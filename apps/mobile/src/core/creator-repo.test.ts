import { describe, expect, it } from 'vitest';

import { segmentsContentHash } from './attrs';
import { MemoryRepo } from './fakes';
import type { MySubmissionRow } from './types';

function sub(over: Partial<MySubmissionRow> = {}): MySubmissionRow {
  return {
    itemId: 'course/c1', type: 'course', title: '课程', bodyMd: '', questionJson: '',
    linksJson: '', segmentsJson: '', state: 'pending', reason: null, created: 0,
    queuedAt: '2026-10-01T00:00:00Z', sentAt: '', localOnly: false,
    ...over,
  };
}

describe('upsertLocalContainer：本地乐观落库（册子 #56 §2.1）', () => {
  it('同事务写 items（source=local / state=active / rev 空）+ 覆盖 segments（按 seq 升序）', async () => {
    const repo = new MemoryRepo();
    const segments = [
      { seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1' },
      { seq: -1, kind: 'attr.cover', text: 'b1' },
    ];
    await repo.upsertLocalContainer(
      { itemId: 'course/c1', type: 'course', title: 'A', contentHash: segmentsContentHash(segments), updatedAt: '2026-10-01T00:00:00Z' },
      segments,
    );
    expect(await repo.getItem('course/c1')).toEqual({
      itemId: 'course/c1', source: 'local', type: 'course', title: 'A',
      rev: '', contentHash: segmentsContentHash(segments), state: 'active', updatedAt: '2026-10-01T00:00:00Z',
    });
    expect((await repo.listSegments('course/c1')).map((s) => s.seq)).toEqual([-1, 1]);
  });

  it('再次写入覆盖同 id：items 与 segments 皆以新值为准，旧行不残留', async () => {
    const repo = new MemoryRepo();
    await repo.upsertLocalContainer({ itemId: 'course/c1', type: 'course', title: 'A', contentHash: 'h1', updatedAt: 't1' }, [{ seq: 1, kind: 'lesson', text: 'x' }]);
    await repo.upsertLocalContainer({ itemId: 'course/c1', type: 'course', title: 'B', contentHash: 'h2', updatedAt: 't2' }, [{ seq: 2, kind: 'lesson', text: 'y' }]);
    expect((await repo.getItem('course/c1'))!.title).toBe('B');
    expect((await repo.listSegments('course/c1')).map((s) => s.seq)).toEqual([2]);
  });
});

describe('markSubmissionLocalOnly：终态标记（册子 #56 §2.4）', () => {
  it('置 failed + reason + localOnly=true，且不再出现在 pending 列表', async () => {
    const repo = new MemoryRepo();
    await repo.saveSubmission(sub());
    await repo.markSubmissionLocalOnly('course/c1', 'item_segments_invalid');
    const got = (await repo.getSubmission('course/c1'))!;
    expect(got.state).toBe('failed');
    expect(got.reason).toBe('item_segments_invalid');
    expect(got.localOnly).toBe(true);
    expect(await repo.listSubmissions('pending')).toHaveLength(0);
    expect(await repo.listSubmissions('failed')).toHaveLength(1);
  });

  it('saveSubmission 原样保留 localOnly（可凭它把「仅本地留存」重新写回普通行）', async () => {
    const repo = new MemoryRepo();
    await repo.saveSubmission(sub({ localOnly: true, state: 'failed' }));
    expect((await repo.getSubmission('course/c1'))!.localOnly).toBe(true);
    await repo.saveSubmission(sub({ localOnly: false, state: 'pending' }));
    expect((await repo.getSubmission('course/c1'))!.localOnly).toBe(false);
  });
});

describe('removeLocalContainer：失败行的本地删除（册子 #61 §4.3）', () => {
  it('清 segments 与 items（source=local）', async () => {
    const repo = new MemoryRepo();
    await repo.upsertLocalContainer(
      { itemId: 'course/c1', type: 'course', title: 'A', contentHash: 'h', updatedAt: 't' },
      [{ seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1' }],
    );
    await repo.removeLocalContainer('course/c1');
    expect(await repo.getItem('course/c1')).toBeNull();
    expect(await repo.listSegments('course/c1')).toEqual([]);
  });

  it('source!=local 时 items 保留（守卫：绝不误删节点已收录内容）', async () => {
    const repo = new MemoryRepo();
    repo.items.set('course/c1', {
      itemId: 'course/c1', source: 'course', type: 'course', title: '同步来的',
      rev: '1', contentHash: 'h', state: 'active', updatedAt: '',
    });
    repo.segments.set('course/c1', [{ itemId: 'course/c1', seq: 1, kind: 'lesson', text: 'x', contentHash: '' }]);
    await repo.removeLocalContainer('course/c1');
    expect((await repo.getItem('course/c1'))!.title).toBe('同步来的');
    expect(await repo.listSegments('course/c1')).toEqual([]);
  });
});
