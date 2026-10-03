// circle.v1 的 store 接口：putCircleAssignment（INSERT OR IGNORE circle_assignments）
// 与 upsertGroupForForm（INSERT OR IGNORE groups，不做 owner/epoch 校验，形式锁定成圈）。
// 严格对齐 store/schema.ts:237-246 的 circle_assignments 表定义与 groups 表定义。
import type { Db } from "../db";

/**
 * PutCircleAssignment（circle.go 的写面）：INSERT OR IGNORE INTO circle_assignments。
 * 主键 (item_id, circle_id) 天然幂等——同组合重复调用只写首次。
 * origin 允许外部传入（handler 从 body 读 "fusion" | "user"），不做校验（校验已在 parseCircleBody 完成）。
 */
export function putCircleAssignment(
  db: Db,
  itemID: string,
  circleID: string,
  origin: string,
  createdAt: number,
): void {
  db.execute(
    `INSERT OR IGNORE INTO circle_assignments(item_id,circle_id,origin,created_at) VALUES(?,?,?,?)`,
    [itemID, circleID, origin, createdAt],
  );
}

/**
 * UpsertGroupForForm：INSERT OR IGNORE INTO groups，字段按设计册 #74 §2.1 派生。
 * 新圈子的 creator_id = items.author_id（handler 查完条目传进来），
 * member_ids_json = JSON.stringify([creatorId])——初始成员只有作者自己。
 * origin 允许 handler 从 body 读 "fusion" | "user" 覆盖默认值。
 *
 * 不做 owner/epoch/roster_rev 校验——form 事件只成圈一次，后续由 group.v1 管理。
 * 已存在的 group_id 静默跳过（ON CONFLICT DO NOTHING），保持幂等。
 */
export function upsertGroupForForm(
  db: Db,
  circleID: string,
  creatorID: string,
  createdAt: number,
  origin = "fusion",
): void {
  db.execute(
    `INSERT OR IGNORE INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at,origin)
		VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [
      circleID,
      creatorID,
      1,
      0,
      1,
      JSON.stringify([creatorID]),
      "[]",
      circleID,
      createdAt,
      origin,
    ],
  );
}
