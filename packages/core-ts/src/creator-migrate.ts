/**
 * 创作者可见性一次性自愈迁移（册子 #56 §2.4）：升级后首轮启动执行一次，
 * 把台账里 `type ∈ {course,lesson}` 且 `state ∈ {failed,pending}` 的历史行按 §2.3 归一化后重试一轮。
 * **幂等靠本地 `config` 标志位**（不靠内存或时间戳推断）；**只经返回值体现结果，绝不抛错**——
 * 升级首启不能因迁移失败而阻断。只依赖注入的 `SubmitOptions`，故可在 Node 下用 `core/fakes.ts` 完整测试。
 */
import { segmentsContentHash } from '@base/protocol-ts';
import { buildContainerSegments, toLocalContainer } from './course-edit';
import { containerFormFromLedger } from './my-created';
import { SubmitError, isPermanentSubmitFailure, submitItem, type SubmitDraft, type SubmitOptions } from './submit';
import type { MySubmissionRow } from './types';

/** 本地 `config` 幂等标志位键。值 = 本册版本号。 */
export const CREATOR_VISIBILITY_MIGRATION_KEY = 'creator_visibility_migrated';
/** 标志位记录的版本号（与 `manifest.json` 同批版本）。 */
export const CREATOR_VISIBILITY_MIGRATION_VERSION = '0.18.0';

/** 存量台账自愈的独立幂等标志位键（册子 #63 §2.2）。值 = 本册版本号。 */
export const LEDGER_HEAL_KEY = 'ledger_heal_migrated';
/** 标志位记录的版本号（与 `manifest.json` 同批版本）。 */
export const LEDGER_HEAL_VERSION = '0.20.2';

export interface HealResult {
  /** 已自愈过（标志位存在）⇒ 本轮零动作 */
  skipped: boolean;
  /** 参与扫描的容器台账行数 */
  scanned: number;
  /** 补齐条目行的行数 */
  healed: number;
  /** 行集还原不出、转「仅本地留存」终态的行数 */
  localOnly: number;
}

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

/**
 * 存量台账自愈（册子 #63 §2）：`#56` 的本地乐观落库上线前产生的行只有 `my_submissions`、没有 `items`，
 * 于是「我创建的」删除取不到 `content_hash`、编辑页回填全空。这里按**现行口径**补一轮：
 * 缺条目行的容器行 → `containerFormFromLedger` → `toLocalContainer` → `upsertLocalContainer`；
 * 行集还原不出 ⇒ 沿用既有 `localOnly` 终态。**纯本地、幂等、绝不抛错、不改台账状态。**
 * 只读台账 + 写本地库，故只要 `repo`（调用点放在 `nodeBaseUrl` 判据之外）。
 */
export async function runLedgerHealMigration(o: Pick<SubmitOptions, 'repo'>): Promise<HealResult> {
  if ((await o.repo.getConfig(LEDGER_HEAL_KEY)) !== null) {
    return { skipped: true, scanned: 0, healed: 0, localOnly: 0 };
  }
  const rows = (await o.repo.listSubmissions()).filter((r) => r.type === 'course' || r.type === 'lesson');
  let healed = 0;
  let localOnly = 0;
  for (const row of rows) {
    if ((await o.repo.getItem(row.itemId)) !== null) continue; // 已有条目行即跳过（幂等核心）
    const { item, segments } = toLocalContainer(containerFormFromLedger(row), new Date().toISOString());
    if (segments.length === 0) {
      await o.repo.markSubmissionLocalOnly(row.itemId, '本地数据无法还原，仅本地留存');
      localOnly += 1;
      continue;
    }
    await o.repo.upsertLocalContainer(item, segments);
    healed += 1;
  }
  await o.repo.setConfig(LEDGER_HEAL_KEY, LEDGER_HEAL_VERSION);
  return { skipped: false, scanned: rows.length, healed, localOnly };
}
