/**
 * 创作者可见性一次性自愈迁移（册子 #56 §2.4）：升级后首轮启动执行一次，
 * 把台账里 `type ∈ {course,lesson}` 且 `state ∈ {failed,pending}` 的历史行按 §2.3 归一化后重试一轮。
 * **幂等靠本地 `config` 标志位**（不靠内存或时间戳推断）；**只经返回值体现结果，绝不抛错**——
 * 升级首启不能因迁移失败而阻断。只依赖注入的 `SubmitOptions`，故可在 Node 下用 `core/fakes.ts` 完整测试。
 */
import { segmentsContentHash } from './attrs';
import { buildContainerSegments } from './course-edit';
import { containerFormFromLedger } from './my-created';
import { SubmitError, isPermanentSubmitFailure, submitItem, type SubmitDraft, type SubmitOptions } from './submit';
import type { MySubmissionRow } from './types';

/** 本地 `config` 幂等标志位键。值 = 本册版本号。 */
export const CREATOR_VISIBILITY_MIGRATION_KEY = 'creator_visibility_migrated';
/** 标志位记录的版本号（与 `manifest.json` 同批版本）。 */
export const CREATOR_VISIBILITY_MIGRATION_VERSION = '0.18.0';

export interface MigrationResult {
  /** 已迁移过（标志位存在）⇒ 本轮零动作 */
  skipped: boolean;
  /** 参与重试的历史行数 */
  retried: number;
  sent: number;
  pending: number;
  localOnly: number;
}

/** 需迁移的台账行：容器载体 + 可重试态 + 尚未标记为仅本地留存。 */
function isMigratable(r: MySubmissionRow): boolean {
  return (r.type === 'course' || r.type === 'lesson') && !r.localOnly && (r.state === 'failed' || r.state === 'pending');
}

export async function runCreatorVisibilityMigration(o: SubmitOptions): Promise<MigrationResult> {
  if ((await o.repo.getConfig(CREATOR_VISIBILITY_MIGRATION_KEY)) !== null) {
    return { skipped: true, retried: 0, sent: 0, pending: 0, localOnly: 0 };
  }
  const rows = (await o.repo.listSubmissions()).filter(isMigratable);
  let sent = 0;
  let pending = 0;
  let localOnly = 0;
  for (const row of rows) {
    const form = containerFormFromLedger(row);
    const segments = buildContainerSegments(form);
    // 顺带物化本地乐观条目（§2.4）：即便随后被拒，本地仍可见、可编辑、可删。
    await o.repo.upsertLocalContainer(
      {
        itemId: form.itemId,
        type: form.type,
        title: form.title.trim(),
        contentHash: segmentsContentHash(segments),
        updatedAt: new Date().toISOString(),
      },
      segments,
    );
    if (segments.length === 0) {
      await o.repo.markSubmissionLocalOnly(row.itemId, '本地数据无法还原，仅本地留存');
      localOnly += 1;
      continue;
    }
    const draft: SubmitDraft = { itemId: row.itemId, type: row.type, title: row.title, bodyMd: '', questionJson: '', segments };
    try {
      const r = await submitItem(o, draft);
      await o.repo.markSubmissionSent(row.itemId, r.created ? 1 : 0, new Date().toISOString());
      sent += 1;
    } catch (e) {
      if (isPermanentSubmitFailure(e)) {
        // 其余 4xx ⇒ 终态「仅本地留存」（reason 保留节点错误码映射后的文案）
        await o.repo.markSubmissionLocalOnly(row.itemId, e instanceof SubmitError ? e.message : String(e));
        localOnly += 1;
      } else {
        // 断网 / 429 / 5xx ⇒ 回 pending（进入正常重放队列）
        const msg = e instanceof SubmitError ? e.message : `迁移重试失败：${(e as Error).message ?? String(e)}`;
        await o.repo.saveSubmission({ ...row, state: 'pending', reason: msg, localOnly: false });
        pending += 1;
      }
    }
  }
  await o.repo.setConfig(CREATOR_VISIBILITY_MIGRATION_KEY, CREATOR_VISIBILITY_MIGRATION_VERSION);
  return { skipped: false, retried: rows.length, sent, pending, localOnly };
}
