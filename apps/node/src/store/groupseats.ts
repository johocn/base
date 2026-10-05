// 圈子席位的只读派生：逐行对齐 internal/store/groupseats.go（GovernorSeats / RemoveQuorum /
// DissolveProposerQuorum / DissolveVoteQuorum / ContributionRank / EventWatermark / DeriveSeats /
// groupBodyAction）。只读、不落表。
import { sha256Hex, utf8 } from "@base/protocol-ts";
import type { EventRow } from "./events";

/** GovernorSeats（groupseats.go:12-21）：成员数 m 对应的治理人席位总数 k(m)。 */
export function governorSeats(m: number): number {
  if (m <= 10) return 1;
  const k = 3 + Math.trunc((m - 11) / 10);
  if (k > 10) return 10;
  return k;
}

/** RemoveQuorum（groupseats.go:24）：⌈2k/3⌉；k=1 时自动为 1。 */
export function removeQuorum(k: number): number {
  return Math.trunc((2 * k + 2) / 3);
}

/** DissolveProposerQuorum（groupseats.go:27-32）：min(2, k)。 */
export function dissolveProposerQuorum(k: number): number {
  if (k < 2) return k;
  return 2;
}

/** DissolveVoteQuorum（groupseats.go:35-41）：min(30, ⌊m/3⌋+1)。 */
export function dissolveVoteQuorum(m: number): number {
  const q = Math.trunc(m / 3) + 1;
  if (q > 30) return 30;
  return q;
}

// ============ Spec v2 §4 / §6 V2 纯函数 ============

/**
 * governThreshold（govern.go:82-89）：门槛公式。
 * level: "base" | "enhanced"。
 * m = 活跃 7 天用户数，P = 他人学习去重数，F = 他人收藏去重数。
 * Go 整数除法向零截断等于 ⌊x⌋，Node Math.trunc 同口径。
 */
export function governThreshold(level: string, m: number, P: number, F: number): number {
  const mPrime = Math.trunc(m / 3); // ⌊m/3⌋
  if (level === "enhanced") {
    return 20 + mPrime + Math.trunc((2 * (P + F)) / 3);
  }
  // base / default
  return 10 + mPrime + Math.trunc((P + F) / 3);
}

/**
 * governQuorum（govern.go:94-114）：法定人数裁切。
 * quorum = min(max(threshold, ⌈m/2⌉), m)。
 * ⌈m/2⌉ = Math.trunc((m + 1) / 2) 在整数域（对正数）。
 */
export function governQuorum(threshold: number, m: number): number {
  if (threshold <= 0) return 0;
  if (m <= 0) return threshold;
  const half = Math.trunc((m + 1) / 2); // ⌈m/2⌉
  if (threshold > half) {
    if (threshold > m) return m;
    return threshold;
  }
  if (half > m) return m;
  return half;
}

/** netWeight（govern.go:117-119）：净票权 = 赞成 - 反对。 */
export function netWeight(approveSum: number, rejectSum: number): number {
  return approveSum - rejectSum;
}

/**
 * removeQuorumV2（groupseats.go:30-33，Spec v2 §6）：
 * base 门槛公式 + GovernQuorum 裁切。
 */
export function removeQuorumV2(mCircle: number, pCircle: number, fCircle: number): number {
  const threshold = governThreshold("base", mCircle, pCircle, fCircle);
  return governQuorum(threshold, mCircle);
}

/**
 * dissolveVoteQuorumV2（groupseats.go:56-59，Spec v2 §6）：
 * enhanced 门槛公式 + GovernQuorum 裁切。
 */
export function dissolveVoteQuorumV2(mCircle: number, pCircle: number, fCircle: number): number {
  const threshold = governThreshold("enhanced", mCircle, pCircle, fCircle);
  return governQuorum(threshold, mCircle);
}

/** brushWindowMs（groupseats.go:44）：防刷窗口 = 任意滚动 24h。 */
const BRUSH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** brushMaxPerWindow（groupseats.go:47）：同一 actor 在任意滚动 24h 内最多计入的条数。 */
const BRUSH_MAX_PER_WINDOW = 20;

/** rankInput（groupseats.go:50-54）。 */
export interface RankInput {
  eventId: string;
  actor: string;
  createdAt: number;
}

/** windowCount（groupseats.go:102-111）：已接受（升序）时刻里落在 [end-24h, end] 闭区间的条数。 */
function windowCount(accepted: number[], end: number): number {
  const lo = end - BRUSH_WINDOW_MS;
  let n = 0;
  for (const t of accepted) {
    if (t >= lo && t <= end) n++;
  }
  return n;
}

/**
 * ContributionRank（groupseats.go:61-99）：按册子 §3.3 排出圈内贡献度名次。
 * 防刷贪心接受；排序键 count 降序、同分按 actor_id 字典序升序；返回全部成员名次。
 */
export function contributionRank(events: RankInput[], members: string[]): string[] {
  const counts = new Map<string, number>();
  const byActor = new Map<string, RankInput[]>();
  const memberSet = new Set(members);
  for (const e of events) {
    if (!memberSet.has(e.actor)) continue; // 已移出者的历史发言不计入排名
    const cur = byActor.get(e.actor);
    if (cur === undefined) byActor.set(e.actor, [e]);
    else cur.push(e);
  }
  for (const [actor, list] of byActor) {
    list.sort((a, b) =>
      a.createdAt !== b.createdAt
        ? a.createdAt - b.createdAt
        : a.eventId < b.eventId
          ? -1
          : a.eventId > b.eventId
            ? 1
            : 0,
    );
    const accepted: number[] = [];
    for (const e of list) {
      // 贪心：若接受该条会让某个 24h 窗口内超过上限，则丢弃它。
      accepted.push(e.createdAt);
      if (windowCount(accepted, e.createdAt) > BRUSH_MAX_PER_WINDOW) accepted.pop();
    }
    counts.set(actor, accepted.length);
  }
  const out = members.slice();
  out.sort((a, b) => {
    const ca = counts.get(a) ?? 0;
    const cb = counts.get(b) ?? 0;
    if (ca !== cb) return cb - ca;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return out;
}

/** EventWatermark（groupseats.go:114-119）：event_id 集合排序拼接后取 sha256 前 16 hex。 */
export function eventWatermark(eventIds: string[]): string {
  const sorted = eventIds.slice().sort();
  return sha256Hex(utf8(sorted.join(""))).slice(0, 16);
}

/** SeatSnapshot（groupseats.go:122-132）。 */
export interface SeatSnapshot {
  rosterRev: number;
  rosterEpoch: number;
  watermark: string;
  seatCount: number;
  ranked: string[];
  governors: string[];
  decidable: boolean;
}

/** groupBodyAction（groupseats.go:177-185）：从 body_json 取 action；解析失败或非 msg 返回空串。 */
export function groupBodyAction(bodyJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyJson);
  } catch {
    return "";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  // Go 是 json.Unmarshal 进 `struct{ Action string \`json:"action"\` }`：
  // 键名精确优先、其次大小写不敏感；重复键按原文顺序逐个解码，后者覆盖前者，
  // 且任一次取值解不进 string（null 为 no-op）即整体报错 → 空串。
  let action = "";
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k.toLowerCase() !== "action") continue;
    if (v === null) continue; // null 对 string 字段是 no-op（保留原值）
    if (typeof v !== "string") return "";
    action = v;
  }
  return action;
}

/**
 * DeriveSeats（groupseats.go:136-174）：从名册 + 圈内发言事件派生席位。
 * 创建者永久占 1 席，其余 k-1 席按贡献度名次取。
 */
export function deriveSeats(
  memberIds: string[],
  creatorId: string,
  rosterRev: number,
  epoch: number,
  events: EventRow[],
): SeatSnapshot {
  const k = governorSeats(memberIds.length);
  const msgs: RankInput[] = [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const e of events) {
    if (seen.has(e.eventId)) continue; // 按 event_id 去重（册子 §3.3 第 1 条）
    seen.add(e.eventId);
    if (groupBodyAction(e.bodyJson) !== "msg") continue;
    ids.push(e.eventId);
    msgs.push({ eventId: e.eventId, actor: e.id, createdAt: e.createdAt });
  }
  const ranked = contributionRank(msgs, memberIds);
  const governors: string[] = [];
  if (creatorId !== "") governors.push(creatorId);
  for (const id of ranked) {
    if (governors.length >= k) break;
    if (id === creatorId) continue;
    governors.push(id);
  }
  return {
    rosterRev,
    rosterEpoch: epoch,
    watermark: eventWatermark(ids),
    seatCount: k,
    ranked,
    governors,
    decidable: k <= 1 || msgs.length > 0,
  };
}