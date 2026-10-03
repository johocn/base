// circle.v1 事件的写面处理：逐行对齐设计册 #74 §2.2.1 的 body 契约与 handler 行为。
// 单类型双 action（assign / form），同事件二选一；键集白名单分 action 严格。
import type { ServerResponse } from "@base/core-ts";
import { getItemRow } from "../store/govern";
import { getEventById, putEvent } from "../store/events";
import { putCircleAssignment, upsertGroupForForm } from "../store/circle";
import { isHexNonEmptyEven, isHexN, onlyKeys } from "./derived";
import { type EventDeps, type EventEnvelope, validTargetID, verifyEventSig } from "./event";
import { jsonResponse } from "./json";

// 两档严格键集：assign 不带 origin，form 带 origin。
const ASSIGN_KEYS: ReadonlySet<string> = new Set(["action", "item_id", "circle_id", "content_hash"]);
const FORM_KEYS: ReadonlySet<string> = new Set([
  "action",
  "item_id",
  "circle_id",
  "origin",
  "content_hash",
]);

const ACTION_ASSIGN = "assign";
const ACTION_FORM = "form";
const ORIGIN_FUSION = "fusion";
const ORIGIN_USER = "user";

/** parseCircleBody：校验 circle.v1 的 body。返回的 map 保留客户端原始键集（验签重建需它）。 */
export function parseCircleBody(
  raw: string,
): { map: Record<string, unknown>; cb: CircleBody } | null {
  if (raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  const action = typeof m.action === "string" ? m.action : "";
  const itemID = typeof m.item_id === "string" ? m.item_id : "";
  const circleID = typeof m.circle_id === "string" ? m.circle_id : "";
  if (!validTargetID(itemID)) return null;
  if (!isHexN(circleID, 16)) return null; // 同 group_id 口径

  let cb: CircleBody;
  switch (action) {
    case ACTION_ASSIGN: {
      if (!onlyKeys(m, ASSIGN_KEYS)) return null;
      // content_hash 可选；若给了必须是合法 hex 串。
      let contentHash = "";
      if ("content_hash" in m) {
        if (typeof m.content_hash !== "string" || !isHexNonEmptyEven(m.content_hash)) return null;
        contentHash = m.content_hash;
      }
      cb = { action, itemID, circleID, origin: ORIGIN_FUSION, contentHash };
      break;
    }
    case ACTION_FORM: {
      if (!onlyKeys(m, FORM_KEYS)) return null;
      // origin 可选，取值仅 "fusion" | "user"。
      let origin = ORIGIN_FUSION;
      if ("origin" in m) {
        if (typeof m.origin !== "string") return null;
        if (m.origin !== ORIGIN_FUSION && m.origin !== ORIGIN_USER) return null;
        origin = m.origin;
      }
      let contentHash = "";
      if ("content_hash" in m) {
        if (typeof m.content_hash !== "string" || !isHexNonEmptyEven(m.content_hash)) return null;
        contentHash = m.content_hash;
      }
      cb = { action, itemID, circleID, origin, contentHash };
      break;
    }
    default:
      return null;
  }
  return { map: m, cb };
}

export interface CircleBody {
  action: "assign" | "form";
  itemID: string;
  circleID: string;
  origin: string;
  contentHash: string;
}

function errResponse(err: unknown): ServerResponse {
  return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
}

/**
 * handleCircleEvent：校验 body → 验签 → 按 action 分流 → 落事件骨架 → 回读 received_at → 200。
 * form action 需查本地 items 表取 author_id 成圈（设计册决策 6），条目不存在 → 400 item_not_found。
 */
export function circleEventHandler(
  deps: EventDeps,
  actor: string,
  env: EventEnvelope,
  createdAt: number,
): ServerResponse {
  const parsed = parseCircleBody(env.bodyRaw);
  if (parsed === null) return jsonResponse(400, { error: "event_param_invalid" });
  const verr = verifyEventSig(deps, actor, env, parsed.map, createdAt);
  if (verr !== null) return verr;
  const cb = parsed.cb;

  switch (cb.action) {
    case ACTION_ASSIGN: {
      try {
        putCircleAssignment(deps.db, cb.itemID, cb.circleID, cb.origin, createdAt);
      } catch (err) {
        return errResponse(err);
      }
      break;
    }
    case ACTION_FORM: {
      let item;
      try {
        item = getItemRow(deps.db, cb.itemID);
      } catch (err) {
        return errResponse(err);
      }
      if (item === null) {
        return jsonResponse(400, { error: "item_not_found" }); // fail-closed
      }
      try {
        upsertGroupForForm(deps.db, cb.circleID, item.authorId, createdAt, cb.origin);
        putCircleAssignment(deps.db, cb.itemID, cb.circleID, cb.origin, createdAt);
      } catch (err) {
        return errResponse(err);
      }
      break;
    }
  }

  // 事件骨架落盘；body_json 保留客户端原始字节（同 govern.v1 / Go 侧 circle.go:138 req.Body 口径，反熵要据它重投影）。
  const bodyRaw = env.bodyRaw === "" ? "{}" : env.bodyRaw;
  let now = Date.now();
  try {
    putEvent(deps.db, {
      eventId: env.eventId,
      id: actor,
      type: env.type,
      bodyJson: bodyRaw,
      createdAt,
      receivedAt: now,
      targetId: "",
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
    // 回读失败按本次 now 返回（Go: err == nil && ok 才覆盖）。
  }
  return jsonResponse(200, { event_id: env.eventId, received_at: now });
}
