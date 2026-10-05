// 逐行对齐 internal/httpapi/group.go 的写面（:14-645）：常量 / groupApproval / groupRosterV2 /
// groupMsg / groupRoster / parseGroupBody / parseGroupMsg / parseGroupRoster / parseGroupRosterV2 /
// handleGroupEvent / putGroupMessage / putGroupRoster / handleGroupRosterV2 /
// rosterApprovalPayload / verifyRosterApprovals / ciSet / govSet / countIn / subsetOf / rosterQuorumError。
// GET 读路由（handleGroupGet 及 DTO）由 B4b 承担，不在本文件。
import type { ServerResponse } from "@base/core-ts";
import { blobId, canonicalize, utf8, verify, type Json } from "@base/protocol-ts";
import {
  getGroup,
  GroupStoreError,
  listGroupMsgEvents,
  putGroupRoster as putGroupRosterStore,
  putGroupRosterV2 as putGroupRosterV2Store,
  type GroupRoster,
} from "../store/group";
import { getEventById, hasBlob, putBlob, putEvent, type EventRow } from "../store/events";
import {
  deriveSeats,
  dissolveProposerQuorum,
  dissolveVoteQuorumV2,
  groupBodyAction,
  removeQuorumV2,
  type SeatSnapshot,
} from "../store/groupseats";
import { writeAuthErr } from "./authmw";
import { isHexN, jsonInt, onlyKeys, toStr } from "./derived";
import { type EventDeps, type EventEnvelope, verifyEventSig } from "./event";
import { jsonResponse } from "./json";

// 常量（group.go:14-42）。
const MAX_GROUP_CIPHER_BYTES = 8192;
const MAX_GROUP_MEMBERS = 200;
const ROSTER_APPROVAL_DOMAIN = "base/group-roster-v2";
const MAX_ROSTER_SIGS = 256;
const MAX_ROSTER_ENVELOPES = 32;

// roster v2 的六个子类型（group.go:27-33）。
const SUB_RENAME = "rename";
const SUB_ROTATE = "rotate";
const SUB_LEAVE = "leave";
const SUB_JOIN = "join";
const SUB_REMOVE = "remove";
const SUB_DISSOLVE = "dissolve";

// 三档严格键集（group.go:96-128）：多一个未知键即拒。
const MSG_KEYS: ReadonlySet<string> = new Set([
  "group_id",
  "action",
  "epoch",
  "text_cipher",
  "reply_to",
]);
const ROSTER_V1_KEYS: ReadonlySet<string> = new Set([
  "group_id",
  "action",
  "epoch",
  "member_ids",
  "name",
  "encrypted",
]);
const ROSTER_V2_KEYS: ReadonlySet<string> = new Set([
  "group_id",
  "action",
  "sub",
  "epoch",
  "roster_rev",
  "member_ids",
  "name",
  "encrypted",
  "sigs",
  "envelopes",
]);

/** groupApproval（group.go:45-48）：sigs[] 的一项。 */
interface GroupApproval {
  id: string;
  sig: string;
}

/** groupRosterV2（group.go:51-61）。 */
interface GroupRosterV2 {
  groupId: string;
  sub: string;
  epoch: number;
  rosterRev: number;
  encrypted: number;
  memberIds: string[];
  name: string;
  sigs: GroupApproval[];
  envelopes: string; // 存 {"envelopes":[...]} 的 canonical 文本，节点不解释
}

/** groupMsg（group.go:63-68）。 */
interface GroupMsg {
  groupId: string;
  epoch: number;
  textCipher: string;
  replyTo: string;
}

/** groupRoster（group.go:70-77）。 */
interface GroupRosterV1 {
  groupId: string;
  epoch: number;
  memberIds: string[];
  name: string;
  encrypted: number;
}

function errResponse(err: unknown): ServerResponse {
  return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
}

/**
 * parseGroupBody（group.go:82-136）：校验 group.v1 的 body。返回的 map 保留**客户端原始键集**——
 * 重建的待验字节必须与客户端所签一致，多一个未知键即拒。
 */
export function parseGroupBody(
  raw: string,
): { map: Record<string, unknown>; action: string } | null {
  if (raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  const action = typeof m.action === "string" ? m.action : null;
  if (action === null) return null;
  switch (action) {
    case "msg": {
      if (!onlyKeys(m, MSG_KEYS)) return null;
      if (parseGroupMsg(m) === null) return null;
      break;
    }
    case "roster": {
      // v2 与 v1 的分流判据 = body 里有没有 `sigs` 键（补充 1）。
      if ("sigs" in m) {
        if (!onlyKeys(m, ROSTER_V2_KEYS)) return null;
        if (parseGroupRosterV2(m) === null) return null;
        return { map: m, action: "roster_v2" };
      }
      if (!onlyKeys(m, ROSTER_V1_KEYS)) return null;
      if (parseGroupRoster(m) === null) return null;
      break;
    }
    default:
      return null;
  }
  return { map: m, action };
}

/** parseGroupMsg（group.go:139-162）：缺 reply_to 不补空串（保持客户端原始键集）。 */
function parseGroupMsg(m: Record<string, unknown>): GroupMsg | null {
  const g: GroupMsg = { groupId: "", epoch: 0, textCipher: "", replyTo: "" };
  g.groupId = typeof m.group_id === "string" ? m.group_id : "";
  if (!isHexN(g.groupId, 16)) return null;
  const epoch = jsonInt(m.epoch);
  if (epoch === null || epoch < 1) return null;
  g.epoch = epoch;
  const cipher = m.text_cipher;
  if (
    typeof cipher !== "string" ||
    cipher.length === 0 ||
    Buffer.byteLength(cipher, "utf8") > MAX_GROUP_CIPHER_BYTES
  ) {
    return null;
  }
  g.textCipher = cipher;
  if ("reply_to" in m) {
    const v = m.reply_to;
    if (typeof v !== "string" || !isHexN(v, 16)) return null;
    g.replyTo = v;
  }
  return g;
}

/** parseGroupRoster（group.go:166-206）：完整快照，成员 1..maxGroupMembers；encrypted 缺省 1。 */
function parseGroupRoster(m: Record<string, unknown>): GroupRosterV1 | null {
  const gid = typeof m.group_id === "string" ? m.group_id : "";
  if (!isHexN(gid, 16)) return null;
  const epoch = jsonInt(m.epoch);
  if (epoch === null || epoch < 1) return null;
  const items = m.member_ids;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_GROUP_MEMBERS) return null;
  const memberIds: string[] = [];
  for (const it of items) {
    if (typeof it !== "string" || !isHexN(it, 16)) return null;
    memberIds.push(it);
  }
  let name = "";
  if ("name" in m) {
    const v = m.name;
    if (typeof v !== "string" || Buffer.byteLength(v, "utf8") > 64) return null;
    name = v;
  }
  let encrypted = 1; // 缺省封闭（老客户端语义不变，AC 13）
  if ("encrypted" in m) {
    const enc = jsonInt(m.encrypted);
    if (enc === null || (enc !== 0 && enc !== 1)) return null;
    encrypted = enc;
  }
  return { groupId: gid, epoch, memberIds, name, encrypted };
}

/**
 * parseGroupRosterV2（group.go:211-302）：键集严格；`sub` 必须在六值枚举内；
 * `sigs` 1..maxRosterSigs 条且每条 id 为 32 hex、sig 为 64 hex。
 * `member_ids` 常态 1..maxGroupMembers；只有 `sub=dissolve` 允许空数组。
 */
function parseGroupRosterV2(m: Record<string, unknown>): GroupRosterV2 | null {
  const gid = typeof m.group_id === "string" ? m.group_id : "";
  if (!isHexN(gid, 16)) return null;
  const sub = typeof m.sub === "string" ? m.sub : "";
  switch (sub) {
    case SUB_RENAME:
    case SUB_ROTATE:
    case SUB_LEAVE:
    case SUB_JOIN:
    case SUB_REMOVE:
    case SUB_DISSOLVE:
      break;
    default:
      return null;
  }
  const epoch = jsonInt(m.epoch);
  if (epoch === null || epoch < 1) return null;
  const rev = jsonInt(m.roster_rev);
  if (rev === null || rev < 1) return null;
  const enc = jsonInt(m.encrypted);
  if (enc === null || (enc !== 0 && enc !== 1)) return null;
  const items = m.member_ids;
  if (!Array.isArray(items) || items.length > MAX_GROUP_MEMBERS) return null;
  if (items.length === 0 && sub !== SUB_DISSOLVE) return null;
  const memberIds: string[] = [];
  for (const it of items) {
    if (typeof it !== "string" || !isHexN(it, 16)) return null;
    memberIds.push(it);
  }
  let name = "";
  if ("name" in m) {
    const v = m.name;
    if (typeof v !== "string" || Buffer.byteLength(v, "utf8") > 64) return null;
    name = v;
  }
  const sigs = m.sigs;
  if (!Array.isArray(sigs) || sigs.length === 0 || sigs.length > MAX_ROSTER_SIGS) return null;
  const approvals: GroupApproval[] = [];
  for (const it of sigs) {
    if (it === null || typeof it !== "object" || Array.isArray(it)) return null;
    const obj = it as Record<string, unknown>;
    const id = obj.id;
    const sig = obj.sig;
    if (
      typeof id !== "string" ||
      typeof sig !== "string" ||
      !isHexN(id, 16) ||
      !isHexN(sig, 64) ||
      Object.keys(obj).length !== 2
    ) {
      return null;
    }
    approvals.push({ id, sig });
  }
  let envelopes = "";
  if ("envelopes" in m) {
    const arr = m.envelopes;
    if (!Array.isArray(arr) || arr.length > MAX_ROSTER_ENVELOPES) return null;
    for (const it of arr) {
      if (it === null || typeof it !== "object" || Array.isArray(it)) return null;
      const obj = it as Record<string, unknown>;
      if (Object.keys(obj).length !== 2) return null;
      if (!("from_epoch" in obj)) return null;
      const cipher = obj.cipher;
      if (
        typeof cipher !== "string" ||
        cipher.length === 0 ||
        Buffer.byteLength(cipher, "utf8") > MAX_GROUP_CIPHER_BYTES
      ) {
        return null;
      }
    }
    try {
      envelopes = canonicalize({ envelopes: arr } as unknown as Json);
    } catch {
      return null;
    }
  }
  return {
    groupId: gid,
    sub,
    epoch,
    rosterRev: rev,
    encrypted: enc,
    memberIds,
    name,
    sigs: approvals,
    envelopes,
  };
}

/**
 * handleGroupEvent（group.go:322-339）：校验 body → 验内容签名 → 按 action 分流。
 * 与 handleCommentEvent 共用同一条验签管线；**不做墓碑检查**——② 类不可审。
 */
export function groupEventHandler(
  deps: EventDeps,
  actor: string,
  env: EventEnvelope,
  createdAt: number,
): ServerResponse {
  const parsed = parseGroupBody(env.bodyRaw);
  if (parsed === null) return jsonResponse(400, { error: "event_param_invalid" });
  const verr = verifyEventSig(deps, actor, env, parsed.map, createdAt);
  if (verr !== null) return verr;
  const raw = parsed.map;
  switch (parsed.action) {
    case "msg":
      return putGroupMessage(deps, actor, env, raw, createdAt);
    case "roster":
      return putGroupRoster(deps, actor, env, raw, createdAt);
    case "roster_v2":
      return handleGroupRosterV2(deps, actor, env, raw, createdAt);
  }
  return jsonResponse(400, { error: "event_param_invalid" });
}

/**
 * putGroupMessage（group.go:344-386）：落 ② 类密文块与事件行。body_json 减化为
 * canonical({group_id,action,epoch,payload_cid,reply_to})，密文只在块里存一份。
 */
function putGroupMessage(
  deps: EventDeps,
  actor: string,
  env: EventEnvelope,
  raw: Record<string, unknown>,
  createdAt: number,
): ServerResponse {
  const g = parseGroupMsg(raw) as GroupMsg;
  const cipher = utf8(g.textCipher);
  const payloadCid = blobId(cipher); // 先定密文、再算 id
  let exist: boolean;
  try {
    exist = hasBlob(deps.db, deps.dataDir, payloadCid).exists;
  } catch (err) {
    return errResponse(err);
  }
  if (!exist) {
    // 落块必须在**验签通过之后**（与 handleCommentEvent 同一次序）
    try {
      putBlob(deps.db, deps.dataDir, deps.storeKey, payloadCid, cipher, "", 0);
    } catch (err) {
      return errResponse(err);
    }
  }
  const reduced: Record<string, unknown> = {
    group_id: g.groupId,
    action: "msg",
    epoch: g.epoch,
    payload_cid: payloadCid,
  };
  if (g.replyTo !== "") reduced.reply_to = g.replyTo;
  let bodyJSON: string;
  try {
    bodyJSON = canonicalize(reduced as Json);
  } catch (err) {
    return errResponse(err);
  }
  let now = Date.now();
  try {
    putEvent(deps.db, {
      eventId: env.eventId,
      id: actor,
      type: env.type,
      bodyJson: bodyJSON,
      createdAt,
      receivedAt: now,
      targetId: "group/" + g.groupId,
      payloadCid,
      replyTo: g.replyTo,
    });
  } catch (err) {
    return errResponse(err);
  }
  // 回读 received_at：同 event_id 重发时给权威值（与 comment 口径一致）。
  try {
    const ev = getEventById(deps.db, env.eventId);
    if (ev !== null) now = ev.receivedAt;
  } catch {
    // 回读失败按本次 now 返回（Go: err == nil && ok 才覆盖）。
  }
  return jsonResponse(200, {
    event_id: env.eventId,
    payload_cid: payloadCid,
    received_at: now,
  });
}

/**
 * putGroupRoster（group.go:391-429）：先写投影（校验失败即返回、不留半态），再落事件行；
 * 事件行的 body_json 保留**客户端原始键集**。
 */
function putGroupRoster(
  deps: EventDeps,
  actor: string,
  env: EventEnvelope,
  raw: Record<string, unknown>,
  createdAt: number,
): ServerResponse {
  const r = parseGroupRoster(raw) as GroupRosterV1;
  const membersJSON = JSON.stringify(r.memberIds);
  try {
    putGroupRosterStore(deps.db, {
      groupId: r.groupId,
      creatorId: actor,
      epoch: r.epoch,
      rosterRev: 0,
      encrypted: r.encrypted,
      memberIdsJson: membersJSON,
      keyEnvelopesJson: "",
      eventId: env.eventId,
      updatedAt: 0,
    });
  } catch (err) {
    if (err instanceof GroupStoreError) {
      if (err.kind === "owner_mismatch") return writeAuthErr(403, "group_owner_mismatch");
      if (err.kind === "epoch_stale") return writeAuthErr(409, "group_epoch_stale");
    }
    return errResponse(err);
  }
  let bodyJSON: string;
  try {
    bodyJSON = canonicalize(raw as Json);
  } catch (err) {
    return errResponse(err);
  }
  let now = Date.now();
  try {
    putEvent(deps.db, {
      eventId: env.eventId,
      id: actor,
      type: env.type,
      bodyJson: bodyJSON,
      createdAt,
      receivedAt: now,
      targetId: "group/" + r.groupId,
      payloadCid: "",
      replyTo: "",
    });
  } catch (err) {
    return errResponse(err);
  }
  try {
    const ev = getEventById(deps.db, env.eventId);
    if (ev !== null) now = ev.receivedAt;
  } catch {
    // 回读失败按本次 now 返回。
  }
  return jsonResponse(200, { event_id: env.eventId, received_at: now });
}

/**
 * handleGroupRosterV2（group.go:433-524）：解析 → 验内容签名（发起者自己）→ 重建多签载荷 →
 * 逐条验签去重 → 门槛判定 → 写库 → 落事件行。次序严格不可换。
 */
function handleGroupRosterV2(
  deps: EventDeps,
  actor: string,
  env: EventEnvelope,
  raw: Record<string, unknown>,
  createdAt: number,
): ServerResponse {
  const r = parseGroupRosterV2(raw) as GroupRosterV2;
  if (r.sub === SUB_JOIN) {
    // 封闭圈不接受自加入（补充 9）：先看本地形态，再决定放行或拒绝。
    let cur: GroupRoster | null;
    try {
      cur = getGroup(deps.db, r.groupId);
    } catch (err) {
      return errResponse(err);
    }
    const found = cur !== null;
    if ((found && (cur as GroupRoster).encrypted === 1) || (!found && r.encrypted === 1)) {
      return writeAuthErr(403, "group_invite_required");
    }
  }
  let payload: string;
  try {
    payload = rosterApprovalPayload(r, env.eventId, createdAt);
  } catch {
    return jsonResponse(400, { error: "event_param_invalid" });
  }
  const approvals = verifyRosterApprovals(deps, r.sigs, payload);
  if (approvals.resp !== null) return approvals.resp;
  const signers = approvals.signers as Set<string>;
  let cur: GroupRoster | null;
  try {
    cur = getGroup(deps.db, r.groupId);
  } catch (err) {
    return errResponse(err);
  }
  const found = cur !== null;
  if (found && r.epoch <= (cur as GroupRoster).epoch) {
    return writeAuthErr(409, "group_roster_epoch_stale");
  }
  let creatorId = actor;
  let memberIds: string[] = [];
  let rosterRev = 0;
  if (found) {
    memberIds = parseMemberIdsJson((cur as GroupRoster).memberIdsJson);
    creatorId = (cur as GroupRoster).creatorId;
    rosterRev = (cur as GroupRoster).rosterRev;
  }
  let events: EventRow[];
  try {
    events = listGroupMsgEvents(deps.db, r.groupId);
  } catch (err) {
    return errResponse(err);
  }
  const seats = deriveSeats(memberIds, creatorId, rosterRev, r.epoch, events);
  // Spec v2 §6: 圈内 V2 动态门槛参数。
  const mCircle = memberIds.length;
  const pCircleSet = new Set<string>();
  for (const ev of events) {
    if (groupBodyAction(ev.bodyJson) === "msg") pCircleSet.add(ev.id);
  }
  const pCircle = pCircleSet.size;
  const fCircle = 0; // 圈 msg 事件不进 items 表，没有 progress / favorites
  const code = rosterQuorumError(
    actor,
    r,
    signers,
    new Set(memberIds),
    new Set(seats.governors),
    seats,
    mCircle,
    pCircle,
    fCircle,
  );
  if (code !== "") return writeAuthErr(403, code);
  const membersJSON = JSON.stringify(r.memberIds);
  try {
    putGroupRosterV2Store(deps.db, {
      groupId: r.groupId,
      creatorId,
      epoch: r.epoch,
      rosterRev: r.rosterRev,
      encrypted: r.encrypted,
      memberIdsJson: membersJSON,
      keyEnvelopesJson: r.envelopes,
      eventId: env.eventId,
      updatedAt: 0,
    });
  } catch (err) {
    if (err instanceof GroupStoreError) {
      if (err.kind === "epoch_stale" || err.kind === "roster_rev_stale") {
        return writeAuthErr(409, "group_roster_epoch_stale");
      }
      if (err.kind === "form_locked") return writeAuthErr(400, "event_param_invalid");
    }
    return errResponse(err);
  }
  let bodyJSON: string;
  try {
    bodyJSON = canonicalize(raw as Json);
  } catch (err) {
    return errResponse(err);
  }
  let now = Date.now();
  try {
    putEvent(deps.db, {
      eventId: env.eventId,
      id: actor,
      type: env.type,
      bodyJson: bodyJSON,
      createdAt,
      receivedAt: now,
      targetId: "group/" + r.groupId,
      payloadCid: "",
      replyTo: "",
    });
  } catch (err) {
    return errResponse(err);
  }
  try {
    const ev = getEventById(deps.db, env.eventId);
    if (ev !== null) now = ev.receivedAt;
  } catch {
    // 回读失败按本次 now 返回。
  }
  return jsonResponse(200, { event_id: env.eventId, received_at: now });
}

/**
 * memberIdsJson 的解析口径同 Go `json.Unmarshal([]byte, &[]string)`：
 * 非数组、或含非字符串元素即整体失败 → 退化为 `[]`（`null` 得 nil，等价空集）。
 */
function parseMemberIdsJson(s: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  for (const it of parsed) {
    if (typeof it !== "string") return [];
  }
  return parsed as string[];
}

/** rosterApprovalPayload（group.go:527-544）：不信客户端给的字节，由节点自己拼。 */
function rosterApprovalPayload(r: GroupRosterV2, eventId: string, createdAt: number): string {
  const f: Record<string, unknown> = {
    domain: ROSTER_APPROVAL_DOMAIN,
    event_id: eventId,
    group_id: r.groupId,
    action: "roster",
    sub: r.sub,
    epoch: r.epoch,
    roster_rev: r.rosterRev,
    member_ids: r.memberIds,
    encrypted: r.encrypted,
    created_at: createdAt,
  };
  if (r.name !== "") f.name = r.name;
  return canonicalize(f as Json);
}

/** verifyRosterApprovals（group.go:547-570）：逐条验签并按 id 去重（保留首条）。任一条坏即整条拒收。 */
function verifyRosterApprovals(
  deps: EventDeps,
  sigs: GroupApproval[],
  payload: string,
): { signers: Set<string> | null; resp: ServerResponse | null } {
  const out = new Set<string>();
  for (const a of sigs) {
    if (out.has(a.id)) continue;
    let pubKey: string;
    try {
      const rows = deps.db.select(
        `SELECT id,alg,pubkey,created_at,last_seen_at FROM identities WHERE id=?`,
        [a.id],
      );
      if (rows.length === 0) {
        return { signers: null, resp: writeAuthErr(403, "identity_unregistered") };
      }
      pubKey = toStr(rows[0].pubkey);
    } catch (err) {
      return { signers: null, resp: errResponse(err) };
    }
    let valid = false;
    try {
      valid = verify(pubKey, utf8(payload), a.sig);
    } catch {
      valid = false;
    }
    if (!valid) return { signers: null, resp: writeAuthErr(403, "event_sig_invalid") };
    out.add(a.id);
  }
  return { signers: out, resp: null };
}

/** countIn（group.go:583-591）：数签名者里落在集合内的个数。 */
function countIn(signers: Set<string>, set: Set<string>): number {
  let n = 0;
  for (const id of signers) {
    if (set.has(id)) n++;
  }
  return n;
}

/** subsetOf（group.go:594-601）：判 signers 是否全部属于 set。 */
function subsetOf(signers: Set<string>, set: Set<string>): boolean {
  for (const id of signers) {
    if (!set.has(id)) return false;
  }
  return true;
}

/**
 * rosterQuorumError（group.go:605-648 + Spec v2 §6）：按 sub 判定门槛，返回要回的错误码；"" 表示通过。
 * actor 是本次事件的发起者（join 档要求签名者集合恒等于 {actor}）。
 * mCircle / pCircle / fCircle 是圈内 V2 动态门槛参数（成员数 / msg 独立 actor 数 / 收藏数=0）。
 */
function rosterQuorumError(
  actor: string,
  r: GroupRosterV2,
  signers: Set<string>,
  members: Set<string>,
  governors: Set<string>,
  seats: SeatSnapshot,
  mCircle: number,
  pCircle: number,
  fCircle: number,
): string {
  const k = seats.seatCount;
  switch (r.sub) {
    case SUB_JOIN:
      // 开放圈自加入：签名者集合恒等于 {自己}（补充 9）。
      if (signers.size !== 1 || !signers.has(actor) || r.encrypted !== 0) {
        return "group_roster_quorum_missing";
      }
      return "";
    case SUB_RENAME:
    case SUB_ROTATE:
    case SUB_LEAVE:
      // 低风险（直权）：任一治者 1 签；签名者必须全是治者。
      if (!subsetOf(signers, governors) || countIn(signers, governors) < 1) {
        return "group_roster_quorum_missing";
      }
      return "";
    case SUB_REMOVE:
      if (!seats.decidable) return "group_roster_quorum_missing"; // 不可判定 ⇒ 拒写重大动作
      // Spec v2 §6: V2 base 门槛公式，再按治者数裁切——治者是唯一能签名的池，
      // quorum 不可能超过 k。GovernQuorum 有 ⌈m/2⌉ 下限，大圈时可能 > k，需要裁切。
      let q = removeQuorumV2(mCircle, pCircle, fCircle);
      if (q > k) q = k;
      if (!subsetOf(signers, governors) || countIn(signers, governors) < q) {
        return "group_roster_quorum_missing";
      }
      return "";
    case SUB_DISSOLVE:
      if (!seats.decidable) return "group_roster_quorum_missing";
      if (!subsetOf(signers, members)) return "group_roster_quorum_missing";
      if (countIn(signers, governors) < dissolveProposerQuorum(k)) {
        return "group_proposal_proposer_missing"; // 发起段不足（册子 §6）
      }
      // Spec v2 §6: V2 enhanced 动态门槛。签名池是**全成员**（dissolve 允许非治者成员签名），
      // GovernQuorum 已经裁切到 mCircle，不需要额外裁切。
      const dq = dissolveVoteQuorumV2(mCircle, pCircle, fCircle);
      if (countIn(signers, members) < dq) {
        return "group_roster_quorum_missing";
      }
      return "";
  }
  return "group_roster_quorum_missing";
}