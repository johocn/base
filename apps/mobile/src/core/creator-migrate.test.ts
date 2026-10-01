import { utf8 } from '@base/protocol-ts';
import { describe, expect, it } from 'vitest';

import { segmentsContentHash } from './attrs';
import { CREATOR_VISIBILITY_MIGRATION_KEY, LEDGER_HEAL_KEY, runCreatorVisibilityMigration, runLedgerHealMigration } from './creator-migrate';
import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import type { SubmitOptions } from './submit';
import type { MySubmissionRow } from './types';

const BASE = 'https://node.test';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function opts(http: FakeHttp, repo: MemoryRepo): SubmitOptions {
  return { adapters: fakeAdapters(http, new MemoryFs(), new FakePackReader()), repo, nodeBaseUrl: BASE };
}

/** 历史 failed 行：属性行 seq 非规范（cover 占 -2、instructor 占 -1）。 */
function courseRow(over: Partial<MySubmissionRow> = {}): MySubmissionRow {
  return {
    itemId: 'course/c1', type: 'course', title: '课程', bodyMd: '', questionJson: '', linksJson: '',
    segmentsJson: JSON.stringify([
      { seq: -2, kind: 'attr.cover', text: 'b1' },
      { seq: -1, kind: 'attr.instructor', text: '李老师' },
    ]),
    state: 'failed', reason: 'item_segments_invalid', created: 0,
    queuedAt: '2026-09-30T00:00:00Z', sentAt: '', localOnly: false,
    ...over,
  };
}

class OfflineHttp extends FakeHttp {
  override async post(url: string, body: Uint8Array, headers?: Record<string, string>) {
    if (url.endsWith('/v1/submit')) throw new Error('offline');
    return super.post(url, body, headers);
  }
}

describe('runCreatorVisibilityMigration：一次性自愈迁移（册子 #56 §2.4）', () => {
  it('历史 failed 行归一化重试成功 ⇒ sent，并写幂等标志位与物化本地条目', async () => {
    const http = new FakeHttp();
    const repo = new MemoryRepo();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'course/c1', created: true }));
    await repo.saveSubmission(courseRow());

    const res = await runCreatorVisibilityMigration(opts(http, repo));
    expect(res).toEqual({ skipped: false, retried: 1, sent: 1, pending: 0, localOnly: 0 });
    expect((await repo.getSubmission('course/c1'))!.state).toBe('sent');
    expect(await repo.getConfig(CREATOR_VISIBILITY_MIGRATION_KEY)).toBe('0.18.0');
    const item = (await repo.getItem('course/c1'))!;
    expect(item.source).toBe('local');
    expect(item.contentHash).toBe(segmentsContentHash(await repo.listSegments('course/c1')));
  });

  it('幂等：标志位已存在 ⇒ 跳过（零请求、零改动）', async () => {
    const http = new FakeHttp();
    const repo = new MemoryRepo();
    await repo.setConfig(CREATOR_VISIBILITY_MIGRATION_KEY, '0.18.0');
    await repo.saveSubmission(courseRow());

    const res = await runCreatorVisibilityMigration(opts(http, repo));
    expect(res).toEqual({ skipped: true, retried: 0, sent: 0, pending: 0, localOnly: 0 });
    expect(http.posted).toHaveLength(0);
    expect((await repo.getSubmission('course/c1'))!.state).toBe('failed');
  });

  it('归一化后仍被 4xx 拒 ⇒ 转「仅本地留存」，本地已物化可编辑', async () => {
    const http = new FakeHttp();
    const repo = new MemoryRepo();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, { status: 400, body: utf8('{"error":"item_segments_invalid"}') });
    await repo.saveSubmission(courseRow());

    const res = await runCreatorVisibilityMigration(opts(http, repo));
    expect(res).toEqual({ skipped: false, retried: 1, sent: 0, pending: 0, localOnly: 1 });
    const got = (await repo.getSubmission('course/c1'))!;
    expect(got.state).toBe('failed');
    expect(got.localOnly).toBe(true);
    expect((await repo.getItem('course/c1'))!.source).toBe('local');
  });

  it('断网 ⇒ 回 pending（进入正常重放队列），不置终态', async () => {
    const http = new OfflineHttp();
    const repo = new MemoryRepo();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ created: true }));
    await repo.saveSubmission(courseRow());

    const res = await runCreatorVisibilityMigration(opts(http, repo));
    expect(res).toEqual({ skipped: false, retried: 1, sent: 0, pending: 1, localOnly: 0 });
    const got = (await repo.getSubmission('course/c1'))!;
    expect(got.state).toBe('pending');
    expect(got.localOnly).toBe(false);
  });

  it('已完成终态的 localOnly 行不再被迁移选中', async () => {
    const http = new FakeHttp();
    const repo = new MemoryRepo();
    await repo.saveSubmission(courseRow({ localOnly: true }));
    const res = await runCreatorVisibilityMigration(opts(http, repo));
    expect(res.retried).toBe(0);
    expect(http.posted).toHaveLength(0);
  });
});

describe('runLedgerHealMigration：存量台账自愈（册子 #63 §2）', () => {
  it('有台账行、无条目行 ⇒ 按现行口径重建本地乐观条目，并写独立幂等标志位', async () => {
    const repo = new MemoryRepo();
    await repo.saveSubmission(courseRow());

    const res = await runLedgerHealMigration({ repo });

    expect(res).toEqual({ skipped: false, scanned: 1, healed: 1, localOnly: 0 });
    const item = (await repo.getItem('course/c1'))!;
    expect(item.source).toBe('local');
    expect(item.contentHash).toBe(segmentsContentHash(await repo.listSegments('course/c1')));
    expect(await repo.getConfig(LEDGER_HEAL_KEY)).toBe('0.20.2');
    // 状态一无所改（本函数只补 items / segments）
    const row = (await repo.getSubmission('course/c1'))!;
    expect(row.state).toBe('failed');
    expect(row.localOnly).toBe(false);
  });

  it('幂等：标志位已存在 ⇒ 零动作', async () => {
    const repo = new MemoryRepo();
    await repo.setConfig(LEDGER_HEAL_KEY, '0.20.2');
    await repo.saveSubmission(courseRow());

    expect(await runLedgerHealMigration({ repo })).toEqual({ skipped: true, scanned: 0, healed: 0, localOnly: 0 });
    expect(await repo.getItem('course/c1')).toBe(null);
  });

  it('行集还原不出（空 segments_json）⇒ 落 localOnly 终态、不建条目行', async () => {
    const repo = new MemoryRepo();
    await repo.saveSubmission(courseRow({ segmentsJson: '' }));

    const res = await runLedgerHealMigration({ repo });

    expect(res).toEqual({ skipped: false, scanned: 1, healed: 0, localOnly: 1 });
    const row = (await repo.getSubmission('course/c1'))!;
    expect(row.localOnly).toBe(true);
    expect(row.reason).toBe('本地数据无法还原，仅本地留存');
    expect(await repo.getItem('course/c1')).toBe(null);
  });

  it('tag 行不参与；已有条目行的容器跳过、内容一字不改', async () => {
    const repo = new MemoryRepo();
    await repo.saveSubmission(courseRow({ itemId: 'tag/x', type: 'tag' }));
    await repo.upsertLocalContainer(
      { itemId: 'course/c1', type: 'course', title: '既有标题', contentHash: 'h', updatedAt: 't' },
      [{ seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1' }],
    );
    await repo.saveSubmission(courseRow());

    const res = await runLedgerHealMigration({ repo });

    expect(res).toEqual({ skipped: false, scanned: 1, healed: 0, localOnly: 0 });
    expect((await repo.getItem('course/c1'))!.title).toBe('既有标题');
  });
});
