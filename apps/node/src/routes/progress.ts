// 逐行对齐 internal/httpapi/progress.go 的 parseProgressBody（:37-67）与
// handleProgressEvent（:74-103），以及 onlyKeys / validTargetID / jsonInt 的既有语义。
import type { ServerResponse } from "@base/core-ts";
import { getEventById, putEvent, putProgressProjection } from "../store/events";
import { jsonInt, onlyKeys } from "./derived";
import { type EventDeps, type EventEnvelope, validTargetID, verifyEventSig } from "./event";
import { jsonResponse } from "./json";

// progressKeys（progress.go:22-24）：严格键集，多一个未知键即拒。
const PROGRESS_KEYS: ReadonlySet<string> = new Set(["item_id", "position", "done", "day"]);

// dayRe（progress.go:27）：只校 YYYY-MM-DD 的字面形态，不校「是不是真实存在的日期」。
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

interface ProgressBody {
  itemId: string;
  position: number;
  done: boolean;
  day: string;
}

function errResponse(err: unknown): ServerResponse {
  return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
}

/**
 * parseProgressBody（progress.go:37-67）：四键全为必填；返回**客户端原始键集**的 map
 * （供 verifyEventSig 重建待验字节）。
 */
export function parseProgressBody(
  raw: string,
): { map: Record<string, unknown>; pb: ProgressBody } | null {
  if (raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  if (!onlyKeys(m, PROGRESS_KEYS)) return null;
  const itemId = m.item_id;
  if (typeof itemId !== "string" || !validTargetID(itemId)) return null;
  const pos = jsonInt(m.position);
  if (pos === null || pos < 0) return null;
  const done = m.done;
  if (typeof done !== "boolean") return null;
  const day = m.day;
  if (typeof day !== "string" || !DAY_RE.test(day)) return null;
  return { map: m, pb: { itemId, position: pos, done, day } };
}

/**
 * handleProgressEvent（progress.go:74-103）：校验 body → 验内容签名 → **双投影同事务** →
 * 落事件行（body_json = 客户端**原始** body 字节）→ 回读 received_at → 200。
 * 投影失败直接 500（progress 没有「冲突」语义）。
 */
export async function progressEventHandler(
  deps: EventDeps,
  actor: string,
  env: EventEnvelope,
  createdAt: number,
): Promise<ServerResponse> {
  const parsed = parseProgressBody(env.bodyRaw);
  if (parsed === null) return jsonResponse(400, { error: "event_param_invalid" });
  const verr = verifyEventSig(deps, actor, env, parsed.map, createdAt);
  if (verr !== null) return verr;
  try {
    putProgressProjection(deps.db, {
      id: actor,
      itemId: parsed.pb.itemId,
      position: parsed.pb.position,
      done: parsed.pb.done,
      day: parsed.pb.day,
      createdAt,
      eventId: env.eventId,
    });
  } catch (err) {
    return errResponse(err);
  }
  let now = Date.now();
  try {
    putEvent(deps.db, {
      eventId: env.eventId,
      id: actor,
      type: env.type,
      bodyJson: env.bodyRaw, // 原始键集（不是减化形态）
      createdAt,
      receivedAt: now,
      targetId: parsed.pb.itemId,
      payloadCid: "",
      replyTo: "",
    });
  } catch (err) {
    return errResponse(err);
  }
  // 回读 received_at：同 event_id 重发时它是首次值，响应必须给权威值。
  try {
    const ev = getEventById(deps.db, env.eventId);
    if (ev !== null) now = ev.receivedAt;
  } catch {
    // 回读失败按本次 now 返回。
  }
  return jsonResponse(200, { event_id: env.eventId, received_at: now });
}