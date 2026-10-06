// 逐行对齐 internal/httpapi/event.go 的 parseLikeBody（:277-302）/ checkLikeReportTarget（:309-341）/
// handleLikeEvent（:344-376）/ parseReportBody（:394-420）/ handleReportEvent（:423-454）。
// #79 §3：like.v1 / report.v1 写面——严格键集、target 校验（404/410）、幂等落行（无 payload）。
import type { ServerResponse } from "@base/core-ts";
import { canonicalize } from "@base/protocol-ts";
import type { Db } from "../db";
import { activeItemExists, getEventById, isRevokedEvent, putEvent } from "../store/events";
import { isHexN, onlyKeys } from "./derived";
import { type EventDeps, type EventEnvelope, validTargetID, verifyEventSig } from "./event";
import { jsonResponse } from "./json";

/** likeBody 是 like.v1 的两字段（#79 §3.1）。target 两形态：16 hex=评论事件 id；路径式=条目 item_id。 */
export interface LikeBody {
  targetId: string;
  action: string; // "like" | "unlike"
}

/** reportBody 是 report.v1 的两字段（#79 §3.2）。target 仅评论（16 hex）。 */
export interface ReportBody {
  targetId: string;
  reason: string; // spam | abuse | illegal | other
}

// 严格键集（Go parseLikeBody/parseReportBody 同纪律）：多一个未知键即拒，
// 防止「签了一份、存了另一份」。
const LIKE_KEYS: ReadonlySet<string> = new Set(["target_id", "action"]);
const REPORT_KEYS: ReadonlySet<string> = new Set(["target_id", "reason"]);

// validReportReason（#79 §3.2）：严格四值。
const REPORT_REASONS: ReadonlySet<string> = new Set(["spam", "abuse", "illegal", "other"]);

function errResponse(err: unknown): ServerResponse {
  return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
}

/**
 * parseLikeBody：严格键集 {target_id,action}；返回 map 保留**客户端原始键集**
 * （供 verifyEventSig 重建待验字节，语义同 parseCommentBody）。
 */
export function parseLikeBody(
  raw: string,
): { map: Record<string, unknown>; lb: LikeBody } | null {
  if (raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  if (!onlyKeys(m, LIKE_KEYS)) return null;
  const target = m.target_id;
  if (typeof target !== "string" || !validTargetID(target)) return null;
  const action = m.action;
  if (typeof action !== "string" || (action !== "like" && action !== "unlike")) return null;
  return { map: m, lb: { targetId: target, action } };
}

/**
 * parseReportBody：严格键集 {target_id,reason}；report 只收评论 target
 * （16 hex，#79 §3.2：非 16 hex 即拒）。
 */
export function parseReportBody(
  raw: string,
): { map: Record<string, unknown>; rb: ReportBody } | null {
  if (raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  if (!onlyKeys(m, REPORT_KEYS)) return null;
  const target = m.target_id;
  if (typeof target !== "string" || !isHexN(target, 16)) return null;
  const reason = m.reason;
  if (typeof reason !== "string" || !REPORT_REASONS.has(reason)) return null;
  return { map: m, rb: { targetId: target, reason } };
}

/**
 * checkTarget（Go checkLikeReportTarget 同口径）：评论 target 须本地存在且未墓碑；
 * 条目 target 须 items.state='active'。失败返回已构造好的响应（404/410）。
 * 反熵接收侧不重放此校验（与 comment.v1 同口径）。
 */
export function checkTarget(db: Db, target: string): ServerResponse | null {
  // 评论 target 形态判别（isCommentTarget）：16 hex = 评论 event_id；否则为条目路径式。
  if (isHexN(target, 16)) {
    const ev = getEventById(db, target);
    if (ev === null || ev.type !== "comment.v1") {
      return jsonResponse(404, { error: "target_not_found" });
    }
    if (isRevokedEvent(db, target)) return jsonResponse(410, { error: "target_gone" });
    return null;
  }
  try {
    if (!activeItemExists(db, target)) return jsonResponse(404, { error: "target_not_found" });
  } catch (err) {
    return errResponse(err);
  }
  return null;
}

/** 落行（target_id 投影列必填，无 payload）+ 回读 received_at + 200（Go handleLikeEvent 尾段同款）。 */
function putLikeReportEvent(
  db: Db,
  actor: string,
  env: EventEnvelope,
  createdAt: number,
  bodyJSON: string,
  targetId: string,
): ServerResponse {
  let now = Date.now();
  try {
    putEvent(db, {
      eventId: env.eventId,
      id: actor,
      type: env.type,
      bodyJson: bodyJSON,
      createdAt,
      receivedAt: now,
      targetId,
      payloadCid: "",
      replyTo: "",
    });
  } catch (err) {
    return errResponse(err);
  }
  // 回读 received_at：同 event_id 重发时它是首次值，响应必须给权威值（幂等，#79 §3.4）。
  try {
    const ev = getEventById(db, env.eventId);
    if (ev !== null) now = ev.receivedAt;
  } catch {
    // 回读失败按本次 now 返回（Go: err == nil && ok 才覆盖）。
  }
  return jsonResponse(200, { event_id: env.eventId, received_at: now });
}

/** handleLikeEvent（event.go:344-376）：校验 body → 验签 → target 校验 → 落行 → 200。 */
export async function likeEventHandler(
  deps: EventDeps,
  actor: string,
  env: EventEnvelope,
  createdAt: number,
): Promise<ServerResponse> {
  const parsed = parseLikeBody(env.bodyRaw);
  if (parsed === null) return jsonResponse(400, { error: "event_param_invalid" });
  const verr = verifyEventSig(deps, actor, env, parsed.map, createdAt);
  if (verr !== null) return verr;
  const t = checkTarget(deps.db, parsed.lb.targetId);
  if (t !== null) return t;
  let bodyJSON: string;
  try {
    bodyJSON = canonicalize({ target_id: parsed.lb.targetId, action: parsed.lb.action, sig: env.sig });
  } catch (err) {
    return errResponse(err);
  }
  return putLikeReportEvent(deps.db, actor, env, createdAt, bodyJSON, parsed.lb.targetId);
}

/** handleReportEvent（event.go:423-454）同 handleLikeEvent，body 键集 {target_id,reason}；重复举报不拒（计数去重在聚合层）。 */
export async function reportEventHandler(
  deps: EventDeps,
  actor: string,
  env: EventEnvelope,
  createdAt: number,
): Promise<ServerResponse> {
  const parsed = parseReportBody(env.bodyRaw);
  if (parsed === null) return jsonResponse(400, { error: "event_param_invalid" });
  const verr = verifyEventSig(deps, actor, env, parsed.map, createdAt);
  if (verr !== null) return verr;
  const t = checkTarget(deps.db, parsed.rb.targetId);
  if (t !== null) return t;
  let bodyJSON: string;
  try {
    bodyJSON = canonicalize({ target_id: parsed.rb.targetId, reason: parsed.rb.reason, sig: env.sig });
  } catch (err) {
    return errResponse(err);
  }
  return putLikeReportEvent(deps.db, actor, env, createdAt, bodyJSON, parsed.rb.targetId);
}
