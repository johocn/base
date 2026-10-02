// GovernorSet（governorset.go:11-65）：本节点治理人集合 = 全站名册 ∪ 各圈治者。
// 名册与席位都是**实时派生**、不落表；席位判定完全复用 deriveSeats，不自定义任何圈子治者口径。
import type { Db } from "../db";
import { contributorRoster, toStr } from "../routes/derived";
import type { EventRow } from "./events";
import { deriveSeats } from "./groupseats";

/** 对齐 Go 的 `sort.Strings`（字节序）；成员/事件 id 均为 ASCII hex，字典序一致。 */
function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * ListGroupMsgEvents（group.go:178-194）：读某组的**全部** group.v1 事件（不分页、不再给游标），
 * 供席位派生用。先读尽再返回（单连接池下不能留下未闭合游标）。
 */
function listGroupMsgEvents(db: Db, groupId: string): EventRow[] {
  const rows = db.select(
    `SELECT event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to
			FROM events WHERE type='group.v1' AND target_id=? ORDER BY created_at ASC, event_id ASC`,
    ["group/" + groupId],
  );
  return rows.map((r) => ({
    eventId: toStr(r.event_id),
    id: toStr(r.id),
    type: toStr(r.type),
    bodyJson: toStr(r.body_json),
    createdAt: Number(r.created_at ?? 0),
    receivedAt: Number(r.received_at ?? 0),
    targetId: toStr(r.target_id),
    payloadCid: toStr(r.payload_cid),
    replyTo: toStr(r.reply_to),
  }));
}

/**
 * GovernorSet（governorset.go:11-65）：全站名册 ∪ 各圈治者。
 * groups 行**先读尽**（不留未闭合游标）再逐圈查事件——单连接池下 Go 亦有此约束。
 */
export function governorSet(db: Db, storeKey: Uint8Array | null): Set<string> {
  const out = new Set<string>();
  for (const c of contributorRoster(db, storeKey)) out.add(c.id);
  const groups = db.select(
    `SELECT group_id,creator_id,epoch,roster_rev,member_ids_json FROM groups ORDER BY group_id ASC`,
  );
  for (const g of groups) {
    // json.Unmarshal([]byte(member_ids_json), &[]string)：逐个元素解码进 string，
    // `null` 元素是 no-op（保留零值 ""），非 string 元素才令整体报错；报错即该圈不参与资格判定。
    let parsed: unknown;
    try {
      parsed = JSON.parse(toStr(g.member_ids_json));
    } catch {
      continue;
    }
    let members: string[];
    if (parsed === null) {
      members = []; // null 解进 slice → nil
    } else if (Array.isArray(parsed)) {
      members = [];
      let bad = false;
      for (const el of parsed) {
        if (el === null) {
          members.push(""); // null 对 string 元素是 no-op → 零值
          continue;
        }
        if (typeof el !== "string") {
          bad = true;
          break;
        }
        members.push(el);
      }
      if (bad) continue;
    } else {
      continue;
    }
    members.sort(compareStr);
    const events = listGroupMsgEvents(db, toStr(g.group_id));
    const snap = deriveSeats(
      members,
      toStr(g.creator_id),
      Number(g.roster_rev ?? 0),
      Number(g.epoch ?? 0),
      events,
    );
    for (const id of snap.governors) {
      if (id !== "") out.add(id);
    }
  }
  return out;
}