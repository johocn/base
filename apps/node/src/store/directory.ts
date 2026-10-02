// 目录 seed 的宿主层：事务、幂等短路与失败口径；纯派生与 SQL 文本在 `@base/core-ts`。
import {
  deriveDirectorySeedTerms,
  GET_DIRECTORY_SEEDED_SQL,
  GET_META_SQL,
  META_DIRECTORY_SEEDED,
  META_DIRECTORY_VERSION,
  SELECT_DIRECTORY_SEED_ATTRS_SQL,
  SELECT_DIRECTORY_SEED_CATEGORY_SQL,
  SELECT_DIRECTORY_SEED_TAG_SQL,
  UPSERT_DIRECTORY_TERM_SQL,
  UPSERT_META_SQL,
} from "@base/core-ts";
import type { HostDb } from "../host/sqlite";

/** `time.Now().UTC().Format(time.RFC3339)`：无毫秒（与 `store.ts` 的 nowUTC 同式）。 */
function nowUTC(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `bumpDirectoryVersionExec`（`directory.go:274-292`）：读-自增-写，缺省 0 起（首次 bump 得 1）。 */
function nextDirectoryVersion(db: HostDb): number {
  const row = db.get(GET_META_SQL, [META_DIRECTORY_VERSION]);
  if (row === undefined) return 1;
  const raw = String(row.value);
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`store: bad directory_version ${JSON.stringify(raw)}`);
  }
  return n + 1;
}

/**
 * `SeedDirectoryFromExisting`（`internal/store/directory.go:294-446`）：把存量内容里已经存在的
 * 分类 / 讲师 / 标签名称一次性登记为 approved 词条（册子 #58 §2.3）。
 *
 * 幂等：靠 meta 键 `directory_seeded` 短路。**仅当确有写入（≥1 条）时**才递增目录版本一次并落
 * 短路键；空库 / 全新安装一条都没有则不写，避免无谓 churn，也让后续补入的存量内容仍能被 seed。
 * 失败原样抛出，由调用方（`openStore`）记日志、不阻断开库（册子 #58 §9 风险 1）。
 */
export function seedDirectoryFromExisting(db: HostDb): void {
  const seeded = db.get(GET_DIRECTORY_SEEDED_SQL, [META_DIRECTORY_SEEDED]);
  if (seeded !== undefined && String(seeded.value) !== "") return;

  db.exec("BEGIN");
  try {
    const attrs = db.all(SELECT_DIRECTORY_SEED_ATTRS_SQL).map((r) => ({
      kind: String(r.kind),
      text: String(r.text),
    }));
    const categoryItemIds = db.all(SELECT_DIRECTORY_SEED_CATEGORY_SQL).map((r) => String(r.item_id));
    const tagItemIds = db.all(SELECT_DIRECTORY_SEED_TAG_SQL).map((r) => String(r.item_id));
    const terms = deriveDirectorySeedTerms({ attrs, categoryItemIds, tagItemIds });
    if (terms.length === 0) {
      // 无存量词条：不 bump、不落短路键（收窄 Go 计划原文的「无条件 bump」）。
      db.exec("ROLLBACK");
      return;
    }
    const now = nowUTC();
    for (const t of terms) {
      // 存量数据没有签名作者，first_author_id 传空串（册子 §2.1 允许为空）。
      db.run(UPSERT_DIRECTORY_TERM_SQL, [t.kind, t.termKey, t.displayName, "approved", "", now, now]);
    }
    db.run(UPSERT_META_SQL, [META_DIRECTORY_VERSION, String(nextDirectoryVersion(db))]);
    db.run(UPSERT_META_SQL, [META_DIRECTORY_SEEDED, "1"]);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}