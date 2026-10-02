// 逐行对齐 internal/httpapi/contributor.go 的 handleContributors（:21-47）。
import type { ServerHandler } from "@base/core-ts";
import type { Db } from "../db";
import { contributorRoster, placeholders, toStr } from "./derived";
import { jsonResponse } from "./json";

/** ProfileNames（contributor.go:200-224）：ids 为空表示全部；缺该身份即不在结果里。 */
function profileNames(db: Db, ids: string[]): Map<string, string> {
  let q = `SELECT id,name FROM profiles`;
  const args: unknown[] = [];
  if (ids.length > 0) {
    q += ` WHERE id IN (${placeholders(ids.length)})`;
    args.push(...ids);
  }
  const rows = db.select(q, args);
  const out = new Map<string, string>();
  for (const r of rows) out.set(toStr(r.id), toStr(r.name));
  return out;
}

export interface ContributorsDeps {
  db: Db;
  /** 文章 body_md 解密所需；dataDir 未提供时为 null。 */
  storeKey: Uint8Array | null;
}

/** 匿名返回本节点实时派生的贡献前 10 名名册；空名册返回 []（不是 null）。 */
export function contributorsHandler(deps: ContributorsDeps): ServerHandler {
  return async () => {
    try {
      const rows = contributorRoster(deps.db, deps.storeKey);
      const names = profileNames(deps.db, rows.map((c) => c.id));
      const contributors = rows.map((c) => {
        const name = names.get(c.id) ?? "";
        // 展示层回退：缺昵称取 id 前 8 位（治理册 §5.1），不影响任何判定。
        return { id: c.id, count: c.count, name: name === "" ? c.id.slice(0, 8) : name };
      });
      return jsonResponse(200, { contributors });
    } catch (err) {
      return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
