import { describe, expect, it } from 'vitest';

import { MemoryRepo } from './fakes';
import type { CheckinDayRow, ProgressRow } from './types';

// 仓储层语义用 MemoryRepo 断言（与既有 comment_out / dm_keys 的测试手法一致：
// fakes 与 SqlRepo 共用同一 LocalRepo 契约，SQL 正确性由真机验收覆盖）。
function row(over: Partial<ProgressRow> = {}): ProgressRow {
  return {
    itemId: 'article/a',
    position: 100,
    done: false,
    day: '2026-10-01',
    updatedAt: 1000,
    eventId: 'a'.repeat(32),
    dirty: true,
    ...over,
  };
}

function day(over: Partial<CheckinDayRow> = {}): CheckinDayRow {
  return { day: '2026-10-01', firstEventId: 'b'.repeat(32), createdAt: 1000, ...over };
}

describe('progress 本地仓储语义（#8 册子 §3.4 / §3.5 / §5.1）', () => {
  it('首写：进度行落库，checkin_days 同事务写入', async () => {
    const repo = new MemoryRepo();
    await repo.saveProgressLocal(row());
    expect(await repo.getProgress('article/a')).toMatchObject({ position: 100, done: false, dirty: true });
    expect(await repo.listCheckinDays()).toEqual([
      { day: '2026-10-01', firstEventId: 'a'.repeat(32), createdAt: 1000 },
    ]);
  });

  it('LWW：created_at 更大者胜；平局取 event_id 更小者；输家不覆盖', async () => {
    const repo = new MemoryRepo();
    await repo.saveProgressLocal(row({ position: 100, updatedAt: 1000, eventId: 'f'.repeat(32) }));
    await repo.saveProgressLocal(row({ position: 200, updatedAt: 2000, eventId: 'f'.repeat(32) }));
    expect((await repo.getProgress('article/a'))!.position).toBe(200);

    // 平局（同为 2000）：event_id 升序 ⇒ '0…' 胜 'f…'
    await repo.saveProgressLocal(row({ position: 300, updatedAt: 2000, eventId: '0'.repeat(32) }));
    expect((await repo.getProgress('article/a'))!.position).toBe(300);

    // 更新更早 + event_id 更大 ⇒ 输
    await repo.saveProgressLocal(row({ position: 400, updatedAt: 1000, eventId: '1'.repeat(32) }));
    expect((await repo.getProgress('article/a'))!.position).toBe(300);
  });

  it('打卡是事件级语义：进度行输了 LWW，checkin_days 照样写', async () => {
    const repo = new MemoryRepo();
    await repo.saveProgressLocal(row({ updatedAt: 2000, eventId: 'a'.repeat(32), day: '2026-10-02' }));
    await repo.saveProgressLocal(row({ updatedAt: 1000, eventId: 'b'.repeat(32), day: '2026-10-03' }));
    expect((await repo.getProgress('article/a'))!.updatedAt).toBe(2000);
    expect((await repo.listCheckinDays()).map((d) => d.day)).toEqual(['2026-10-02', '2026-10-03']);
  });

  it('checkin_days 保留首次：同日重复打卡不改 first_event_id', async () => {
    const repo = new MemoryRepo();
    await repo.saveProgressLocal(row({ day: '2026-10-01', eventId: 'a'.repeat(32), updatedAt: 1000 }));
    await repo.saveProgressLocal(row({ day: '2026-10-01', eventId: 'c'.repeat(32), updatedAt: 9000 }));
    const days = await repo.listCheckinDays();
    expect(days).toHaveLength(1);
    expect(days[0]!.firstEventId).toBe('a'.repeat(32));
  });

  it('mergeProgress：远程行按同一比较函数并入，且写回 dirty=false', async () => {
    const repo = new MemoryRepo();
    await repo.saveProgressLocal(row({ position: 100, updatedAt: 1000, eventId: 'a'.repeat(32) }));
    await repo.mergeProgress(
      [
        row({ position: 900, updatedAt: 5000, eventId: 'b'.repeat(32) }),
        row({ itemId: 'quiz/q1', position: 3, updatedAt: 1, eventId: 'c'.repeat(32) }),
      ],
      [day({ day: '2026-09-30', firstEventId: 'd'.repeat(32) })],
    );
    expect((await repo.getProgress('article/a'))!.position).toBe(900);
    expect((await repo.getProgress('article/a'))!.dirty).toBe(false);
    expect((await repo.getProgress('quiz/q1'))!.position).toBe(3);
    expect((await repo.listCheckinDays()).map((d) => d.day)).toEqual(['2026-09-30', '2026-10-01']);

    // 输的远程行不覆盖
    await repo.mergeProgress([row({ position: 1, updatedAt: 1, eventId: 'e'.repeat(32) })], []);
    expect((await repo.getProgress('article/a'))!.position).toBe(900);
  });

  it('mergeProgress：同批同 item_id 按 LWW 取胜者，而非末条', async () => {
    const repo = new MemoryRepo();
    // 同一批次内同 item_id 两条：末条 created_at 更早，LWW 应取前一条
    await repo.mergeProgress(
      [
        row({ position: 900, updatedAt: 5000, eventId: 'b'.repeat(32) }),
        row({ position: 1, updatedAt: 1, eventId: 'c'.repeat(32) }),
      ],
      [],
    );
    expect((await repo.getProgress('article/a'))!.position).toBe(900);

    // 平局（同为 5000）：event_id 升序 ⇒ '0…' 胜 'b…'，即使它排在后面
    await repo.mergeProgress(
      [
        row({ position: 700, updatedAt: 5000, eventId: 'b'.repeat(32) }),
        row({ position: 800, updatedAt: 5000, eventId: '0'.repeat(32) }),
      ],
      [],
    );
    expect((await repo.getProgress('article/a'))!.position).toBe(800);
  });
});