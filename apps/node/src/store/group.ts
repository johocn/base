// 逐行对齐 internal/store/group.go 的 GroupRoster / 哨兵错误 / PutGroupRoster /
// PutGroupRosterV2 / GetGroup / ListGroupEvents / ListGroupMsgEvents。
import type { Db } from "../db";
import type { EventRow } from "./events";

/** GroupRoster（group.go:10-20）：groups 表的一行（册子 §4.2）。 */
export interface GroupRoster {
  groupId: string;
  creatorId: string;
  epoch: number;
  rosterRev: number;
  encrypted: number;
  memberIdsJson: string;
  keyEnvelopesJson: string;
  eventId: string;
  updatedAt: number;
}

/** 哨兵错误的等价物：Go 四个 sentinel 由 httpapi 映射为错误码（册子 §4.2）。 */
export type GroupStoreErrorKind =
  | "owner_mismatch"
  | "epoch_stale"
  | "roster_rev_stale"
  | "form_locked";

export class GroupStoreError extends Error {
  readonly kind: GroupStoreErrorKind;
  constructor(kind: GroupStoreErrorKind) {
    super(kind);
    this.name = "GroupStoreError";
    this.kind = kind;
  }
}

function toStr(value: unknown): string {
  return value == null ? "" : String(value);
}

/**
 * PutGroupRoster（group.go:33-61）：写/更新名单投影。首个 roster 事件锁定 creator_id，
 * 后续必须同 actor 且 epoch 严格大于当前值。校验失败**不写任何行**。
 */
export function putGroupRoster(db: Db, r: GroupRoster): void {
  let updatedAt = r.updatedAt;
  if (updatedAt === 0) updatedAt = Date.now();
  const cur = db.select(`SELECT creator_id,epoch FROM groups WHERE group_id=?`, [r.groupId]);
  if (cur.length === 0) {
    db.execute(
      `INSERT INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at)
			VALUES(?,?,?,?,?,?,?,?,?)`,
      [r.groupId, r.creatorId, r.epoch, 1, r.encrypted, r.memberIdsJson, "[]", r.eventId, updatedAt],
    );
    return;
  }
  const curCreator = toStr(cur[0].creator_id);
  const curEpoch = Number(cur[0].epoch ?? 0);
  if (r.creatorId !== curCreator) throw new GroupStoreError("owner_mismatch");
  if (r.epoch <= curEpoch) throw new GroupStoreError("epoch_stale");
  // 乐观锁：WHERE epoch=? 保证并发下不会把更旧的值盖上去。
  db.execute(
    `UPDATE groups SET epoch=?,roster_rev=roster_rev+1,member_ids_json=?,event_id=?,updated_at=?
			WHERE group_id=? AND epoch=?`,
    [r.epoch, r.memberIdsJson, r.eventId, updatedAt, r.groupId, curEpoch],
  );
}

/**
 * PutGroupRosterV2（group.go:67-102）：写 v2 名单投影（册子 §3.8）。多签与门槛已由 httpapi 验完，
 * 这里不再校验 owner——但 epoch 严格递增、roster_rev 严格递增、encrypted 建圈定死后不可切换。
 * 校验失败**不写任何行**。
 */
export function putGroupRosterV2(db: Db, r: GroupRoster): void {
  let updatedAt = r.updatedAt;
  if (updatedAt === 0) updatedAt = Date.now();
  let keyEnv = r.keyEnvelopesJson;
  if (keyEnv === "") keyEnv = "[]";
  const cur = db.select(`SELECT epoch,roster_rev,encrypted FROM groups WHERE group_id=?`, [r.groupId]);
  if (cur.length === 0) {
    db.execute(
      `INSERT INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at)
			VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        r.groupId,
        r.creatorId,
        r.epoch,
        r.rosterRev,
        r.encrypted,
        r.memberIdsJson,
        keyEnv,
        r.eventId,
        updatedAt,
      ],
    );
    return;
  }
  const curEpoch = Number(cur[0].epoch ?? 0);
  const curRev = Number(cur[0].roster_rev ?? 0);
  const curEnc = Number(cur[0].encrypted ?? 0);
  if (r.encrypted !== curEnc) throw new GroupStoreError("form_locked"); // 形态不可切换（册子 §3.1）
  if (r.epoch <= curEpoch) throw new GroupStoreError("epoch_stale");
  if (r.rosterRev <= curRev) throw new GroupStoreError("roster_rev_stale");
  // 乐观锁：WHERE 带上读到的旧值，并发下不会把更旧的行盖上去。
  db.execute(
    `UPDATE groups SET epoch=?,roster_rev=?,member_ids_json=?,key_envelopes=?,event_id=?,updated_at=?
			WHERE group_id=? AND epoch=? AND roster_rev=?`,
    [
      r.epoch,
      r.rosterRev,
      r.memberIdsJson,
      keyEnv,
      r.eventId,
      updatedAt,
      r.groupId,
      curEpoch,
      curRev,
    ],
  );
}

/** GetGroup（group.go:128-141）：读名单投影；不存在返回 null。 */
export function getGroup(db: Db, groupId: string): GroupRoster | null {
  const rows = db.select(
    `SELECT group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at
			FROM groups WHERE group_id=?`,
    [groupId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    groupId: toStr(r.group_id),
    creatorId: toStr(r.creator_id),
    epoch: Number(r.epoch ?? 0),
    rosterRev: Number(r.roster_rev ?? 0),
    encrypted: Number(r.encrypted ?? 0),
    memberIdsJson: toStr(r.member_ids_json),
    keyEnvelopesJson: toStr(r.key_envelopes),
    eventId: toStr(r.event_id),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

/** eventColumns（event.go:39）与 scanEvent（event.go:41-55）的列序与映射口径。 */
const EVENT_COLUMNS = `event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to`;

function scanEvents(rows: Record<string, unknown>[]): EventRow[] {
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
 * ListGroupEvents（group.go:146-173）：按 (created_at, event_id) 倒序分页读某组的 group.v1 事件。
 * target_id 绑定值是 "group/" + groupId；游标条件仅 cursorID != "" 时加。
 */
export function listGroupEvents(
  db: Db,
  groupId: string,
  cursorTS: number,
  cursorID: string,
  limit: number,
): EventRow[] {
  if (limit <= 0) limit = 30;
  let q = `SELECT ${EVENT_COLUMNS} FROM events WHERE type='group.v1' AND target_id=?`;
  const args: unknown[] = ["group/" + groupId];
  if (cursorID !== "") {
    q += ` AND (created_at < ? OR (created_at = ? AND event_id < ?))`;
    args.push(cursorTS, cursorTS, cursorID);
  }
  q += ` ORDER BY created_at DESC, event_id DESC LIMIT ?`;
  args.push(limit);
  return scanEvents(db.select(q, args));
}

/**
 * ListGroupMsgEvents（group.go:178-194）：读某组的**全部** group.v1 事件（不分页），供席位派生用。
 * 与 ListGroupEvents 的区别只有「不给游标、不给 limit」。
 */
export function listGroupMsgEvents(db: Db, groupId: string): EventRow[] {
  return scanEvents(
    db.select(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE type='group.v1' AND target_id=? ORDER BY created_at ASC, event_id ASC`,
      ["group/" + groupId],
    ),
  );
}