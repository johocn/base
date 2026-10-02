// 逐行对齐 internal/httpapi/identity.go 的 handleMe（:243-279，契约 5.5 / #8 册子 §4.4）。
import type { Db } from "../db";
import type { AuthedHandler } from "./authmw";
import { toStr } from "./derived";
import { jsonResponse } from "./json";

export interface MeDeps {
  db: Db;
}

/**
 * GET /v1/me：按**签名身份**返回 progress / checkin_days 真数据。
 *
 * `events` 本册保持空数组（不扩面）；三数组**恒为数组而非 null**——Go 用 make(...,0,n)
 * 而非 nil，否则 JSON 编成 null，客户端无条件迭代就会炸。
 * progress 带 event_id（本地要复现 §3.4 的平局判据）；checkin_days 是 §3.5 的独立投影。
 */
export function meHandler(deps: MeDeps): AuthedHandler {
  return async (_req, identityId) => {
    try {
      // ListProgressByID（store/progress.go:105-123）：按 item_id 升序。
      const progressRows = deps.db.select(
        `SELECT item_id,position,done,day,updated_at,event_id
		FROM progress WHERE id=? ORDER BY item_id ASC`,
        [identityId],
      );
      // CheckinDaysOf（store/progress.go:126-142）：按 day 升序。
      const checkins = deps.db.select(
        `SELECT day,first_event_id,created_at FROM checkin_days
		WHERE id=? ORDER BY day ASC`,
        [identityId],
      );
      // Go map 键按字典序：day, done, event_id, item_id, position, updated_at。
      const progress = progressRows.map((p) => ({
        day: toStr(p.day),
        done: Number(p.done ?? 0) !== 0,
        event_id: toStr(p.event_id),
        item_id: toStr(p.item_id),
        position: Number(p.position ?? 0),
        updated_at: Number(p.updated_at ?? 0),
      }));
      // 键按字典序：created_at, day, first_event_id。
      const days = checkins.map((c) => ({
        created_at: Number(c.created_at ?? 0),
        day: toStr(c.day),
        first_event_id: toStr(c.first_event_id),
      }));
      // 键按字典序：checkin_days, events, id, progress。
      return jsonResponse(200, { checkin_days: days, events: [], id: identityId, progress });
    } catch (err) {
      return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}