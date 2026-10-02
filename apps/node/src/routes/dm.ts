// 逐行对齐 internal/httpapi/dm.go 的 handleDMGet（:106-153）与
// parseDMBody（:29-55）/ handleDMEvent（:59-104）。
import type { ServerHandler, ServerResponse } from "@base/core-ts";
import { blobId, canonicalize, utf8 } from "@base/protocol-ts";
import type { Db } from "../db";
import { getEventById, hasBlob, putBlob, putEvent } from "../store/events";
import { isHexN, onlyKeys, parseGoInt, toStr } from "./derived";
import { parseCommentCursor } from "./comment";
import { type EventDeps, type EventEnvelope, verifyEventSig } from "./event";
import { jsonResponse } from "./json";

const DM_DEFAULT_LIMIT = 30;
const DM_MAX_LIMIT = 100;

// maxDMCipherBytes（dm.go:14）：单条私信密文的字节上限。
const MAX_DM_CIPHER_BYTES = 8192;

// dm.v1 严格键集：只有两个键，多一个未知键即拒。
const DM_KEYS: ReadonlySet<string> = new Set(["to", "text_cipher"]);

interface DmEvent {
  eventId: string;
  actor: string;
  createdAt: number;
  payloadCid: string;
}

/** ListDMEvents（store/dm.go:6-32）：按 (created_at,event_id) 倒序分页读发给 peer 的 dm.v1。 */
function listDMEvents(
  db: Db,
  peerId: string,
  cursorTS: number,
  cursorID: string,
  limit: number,
): DmEvent[] {
  if (limit <= 0) limit = 30;
  let q = `SELECT event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to
    FROM events WHERE type='dm.v1' AND target_id=?`;
  const args: unknown[] = ["dm/" + peerId];
  if (cursorID !== "") {
    q += ` AND (created_at < ? OR (created_at = ? AND event_id < ?))`;
    args.push(cursorTS, cursorTS, cursorID);
  }
  q += ` ORDER BY created_at DESC, event_id DESC LIMIT ?`;
  args.push(limit);

  const rows = db.select(q, args);
  return rows.map((r) => ({
    eventId: toStr(r.event_id),
    actor: toStr(r.id),
    createdAt: Number(r.created_at ?? 0),
    payloadCid: toStr(r.payload_cid),
  }));
}

/**
 * 匿名分页读「所有人发给 peer_id 的私信索引」；无 404 分支，查无即空数组。
 * 游标与 GET /v1/comment 同口径（复用 parseCommentCursor）。
 */
export function dmHandler(db: Db): ServerHandler {
  return async (req) => {
    const peerId = req.params.peer_id ?? "";
    if (!isHexN(peerId, 16)) {
      return jsonResponse(400, { error: "event_param_invalid" });
    }
    try {
      const limitRaw = req.query.limit ?? "";
      let limit = DM_DEFAULT_LIMIT;
      if (limitRaw !== "") {
        const n = parseGoInt(limitRaw);
        if (n !== null && n > 0 && n <= DM_MAX_LIMIT) limit = n;
      }
      const cur = parseCommentCursor(req.query.cursor ?? "");
      const rows = listDMEvents(db, peerId, cur.ts, cur.id, limit);

      const events = rows.map((e) => ({
        event_id: e.eventId,
        actor: e.actor,
        created_at: e.createdAt,
        payload_cid: e.payloadCid,
      }));

      // 满页才给游标：与 GET /v1/comment 同口径。
      let nextCursor: string | null = null;
      if (rows.length === limit) {
        const last = rows[rows.length - 1];
        nextCursor = `${last.createdAt}_${last.eventId}`;
      }
      return jsonResponse(200, { events, next_cursor: nextCursor });
    } catch (err) {
      return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

interface DMMsg {
  to: string;
  textCipher: string;
}

/**
 * parseDMBody（dm.go:29-55）：**只有两个键**，多一个未知键即拒；
 * 返回**客户端原始键集**的 map 供验签重建。
 */
export function parseDMBody(
  raw: string,
): { map: Record<string, unknown>; msg: DMMsg } | null {
  if (raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  if (!onlyKeys(m, DM_KEYS)) return null;
  // 收件人是身份 id：32 hex（isHexN 的第二参是**字节数**，16 字节 = 32 hex）。
  const to = m.to;
  if (typeof to !== "string" || !isHexN(to, 16)) return null;
  const cipher = m.text_cipher;
  if (typeof cipher !== "string" || cipher === "") return null;
  if (Buffer.byteLength(cipher, "utf8") > MAX_DM_CIPHER_BYTES) return null;
  return { map: m, msg: { to, textCipher: cipher } };
}

/**
 * handleDMEvent（dm.go:59-104）：校验 body → 验内容签名 → 落块 → 落事件行。
 * **不做墓碑检查**，**不校验 to 是否已登记身份**。
 */
export async function dmEventHandler(
  deps: EventDeps,
  actor: string,
  env: EventEnvelope,
  createdAt: number,
): Promise<ServerResponse> {
  const parsed = parseDMBody(env.bodyRaw);
  if (parsed === null) return jsonResponse(400, { error: "event_param_invalid" });
  const verr = verifyEventSig(deps, actor, env, parsed.map, createdAt);
  if (verr !== null) return verr;
  // 落块必须在**验签通过之后**。
  const cipher = utf8(parsed.msg.textCipher);
  const payloadCid = blobId(cipher);
  try {
    const hb = hasBlob(deps.db, deps.dataDir, payloadCid);
    if (!hb.exists) putBlob(deps.db, deps.dataDir, deps.storeKey, payloadCid, cipher, "", 0);
  } catch (err) {
    return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
  }
  // body_json 减化为 canonical({to, payload_cid})：密文只在块里存一份。
  let bodyJSON: string;
  try {
    bodyJSON = canonicalize({ to: parsed.msg.to, payload_cid: payloadCid });
  } catch (err) {
    return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
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
      targetId: "dm/" + parsed.msg.to,
      payloadCid,
      replyTo: "",
    });
  } catch (err) {
    return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
  }
  // 回读 received_at：同 event_id 重发时它是首次值。
  try {
    const ev = getEventById(deps.db, env.eventId);
    if (ev !== null) now = ev.receivedAt;
  } catch {
    // 回读失败按本次 now 返回。
  }
  return jsonResponse(200, {
    event_id: env.eventId,
    payload_cid: payloadCid,
    received_at: now,
  });
}
