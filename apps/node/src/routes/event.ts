// 逐行对齐 internal/httpapi/event.go 的 handleEventPost（:44-81）与 putBareEvent（:84-98），
// 以及 comment 分支 handleCommentEvent（:108-168）/ verifyEventSig（:172-202）/
// parseCommentBody（:207-243）/ validTargetID（:246-256）。
// group.v1 分支见 routes/groupEvent.ts（内部 httpapi/group.go 的写面）。
import type { ServerResponse } from "@base/core-ts";
import { blobId, canonicalize, utf8, verify, type Json } from "@base/protocol-ts";
import type { Db } from "../db";
import { hasBlob, isRevokedEvent, putBlob, putEvent, getEventById } from "../store/events";
import { type AuthedHandler, writeAuthErr } from "./authmw";
import { decodeStrict } from "./decode";
import { type IpLimiter, isHexN, onlyKeys, parseGoInt64, toStr } from "./derived";
import { dmEventHandler } from "./dm";
import { governEventHandler } from "./governEvent";
import { groupEventHandler } from "./groupEvent";
import { jsonResponse } from "./json";
import { progressEventHandler } from "./progress";

// 写限速（event.go:16-20）：按已验签身份与客户端 IP 双维度。
export const EVENT_PER_MINUTE_PER_ID = 30;
export const EVENT_BURST_PER_ID = 10;
export const EVENT_PER_MINUTE_PER_IP = 120;
export const EVENT_BURST_PER_IP = 30;

// maxCommentBytes（event.go:14）：单条评论正文的 UTF-8 字节上限。
const MAX_COMMENT_BYTES = 8192;

// eventTypeRegistry（event.go:25-31）：节点放行的事件类型表，5 条全抄。
export const EVENT_TYPES: ReadonlySet<string> = new Set([
  "comment.v1",
  "group.v1",
  "dm.v1",
  "govern.v1",
  "progress.v1",
]);

// 客户端 IP 维度的退化单桶键（ServerRequest 未暴露远端地址）。
const CLIENT_BUCKET_KEY = "";

/** 已解码的事件信封；字段语义与 Go eventReq 对齐（createdAt/body 均为**原始字面量/切片**）。 */
export interface EventEnvelope {
  eventId: string;
  type: string;
  createdAtRaw: string; // json.Number 字面量
  bodyRaw: string; // json.RawMessage 原始字节切片
  sig: string;
}

export interface EventDeps {
  db: Db;
  dataDir: string;
  storeKey: Uint8Array | null;
  byID: IpLimiter;
  byIP: IpLimiter;
}

function errResponse(err: unknown): ServerResponse {
  return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
}

/**
 * verifyEventSig（event.go:172-202）：待签字节 = canonical({event_id,type,created_at,body})，
 * body 是按客户端原始键集重建的已解析值。成功返回 null，失败返回已构造好的响应。
 */
export function verifyEventSig(
  deps: EventDeps,
  actor: string,
  env: EventEnvelope,
  rawBody: Record<string, unknown>,
  createdAt: number,
): ServerResponse | null {
  let signBytes: string;
  try {
    signBytes = canonicalize({
      event_id: env.eventId,
      type: env.type,
      created_at: createdAt,
      body: rawBody as Json,
    });
  } catch {
    return jsonResponse(400, { error: "event_param_invalid" });
  }
  if (!isHexN(env.sig, 64)) return writeAuthErr(403, "event_sig_invalid");
  let pubKey: string;
  try {
    const rows = deps.db.select(
      `SELECT id,alg,pubkey,created_at,last_seen_at FROM identities WHERE id=?`,
      [actor],
    );
    if (rows.length === 0) return writeAuthErr(403, "identity_unregistered");
    pubKey = toStr(rows[0].pubkey);
  } catch (err) {
    return errResponse(err);
  }
  if (!verify(pubKey, utf8(signBytes), env.sig)) return writeAuthErr(403, "event_sig_invalid");
  return null;
}

/** validTargetID（event.go:246-256）：ASCII、1..256 字节（任何字节 ≥0x80 即拒）。 */
export function validTargetID(s: string): boolean {
  if (s.length === 0 || s.length > 256) return false;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

interface CommentBody {
  targetId: string;
  text: string;
  replyTo: string;
}

const COMMENT_KEYS: ReadonlySet<string> = new Set(["target_id", "text", "reply_to"]);

/**
 * parseCommentBody（event.go:207-243）：严格键集 {target_id,text,reply_to}，多键即拒。
 * 返回的 map 保留**客户端原始键集**（缺 reply_to 不得补空串，否则重建的待验字节与所签不一致）。
 */
export function parseCommentBody(
  raw: string,
): { map: Record<string, unknown>; cb: CommentBody } | null {
  if (raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  if (!onlyKeys(m, COMMENT_KEYS)) return null;
  const target = m.target_id;
  if (typeof target !== "string" || !validTargetID(target)) return null;
  const text = m.text;
  if (typeof text !== "string" || text === "") return null;
  if (Buffer.byteLength(text, "utf8") > MAX_COMMENT_BYTES) return null;
  if (!("reply_to" in m)) return { map: m, cb: { targetId: target, text, replyTo: "" } };
  const reply = m.reply_to;
  // reply_to 指向一条 event_id，故与 event_id 同形（16 字节 hex）。
  if (typeof reply !== "string" || !isHexN(reply, 16)) return null;
  return { map: m, cb: { targetId: target, text, replyTo: reply } };
}

/** handleCommentEvent（event.go:108-168）：校验 body → 验签 → 查墓碑 → 落块 → 落事件行 → 200。 */
async function handleCommentEvent(
  deps: EventDeps,
  actor: string,
  env: EventEnvelope,
  createdAt: number,
): Promise<ServerResponse> {
  const parsed = parseCommentBody(env.bodyRaw);
  if (parsed === null) return jsonResponse(400, { error: "event_param_invalid" });
  const verr = verifyEventSig(deps, actor, env, parsed.map, createdAt);
  if (verr !== null) return verr;
  // 已审核删除的评论不允许再落（否则删块会被同一条重发复活）。
  let revoked: boolean;
  try {
    revoked = isRevokedEvent(deps.db, env.eventId);
  } catch (err) {
    return errResponse(err);
  }
  if (revoked) return writeAuthErr(400, "event_revoked");
  // 正文落块：必须在**验签通过之后**才算 id 并落盘。
  const text = utf8(parsed.cb.text);
  const payloadCid = blobId(text);
  try {
    const hb = hasBlob(deps.db, deps.dataDir, payloadCid);
    if (!hb.exists) putBlob(deps.db, deps.dataDir, deps.storeKey, payloadCid, text, "", 0);
  } catch (err) {
    return errResponse(err);
  }
  // body_json 存减化形态，不含 text（正文只在块里存一份）。
  let bodyJSON: string;
  try {
    bodyJSON = canonicalize({
      target_id: parsed.cb.targetId,
      payload_cid: payloadCid,
      reply_to: parsed.cb.replyTo,
      sig: env.sig,
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
      bodyJson: bodyJSON,
      createdAt,
      receivedAt: now,
      targetId: parsed.cb.targetId,
      payloadCid,
      replyTo: parsed.cb.replyTo,
    });
  } catch (err) {
    return errResponse(err);
  }
  // 回读 received_at：同 event_id 重发时它是首次值，响应必须给权威值。
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
 * putBareEvent（event.go:84-98）：落不带投影的事件骨架；不验签、不查墓碑。
 * 五类放行类型均有真分支，故此处已是未列举类型的兜底（当前不可达）。
 */
function putBareEvent(
  deps: EventDeps,
  actor: string,
  env: EventEnvelope,
  createdAt: number,
): ServerResponse {
  const body = env.bodyRaw === "" ? "{}" : env.bodyRaw;
  const now = Date.now();
  try {
    putEvent(deps.db, {
      eventId: env.eventId,
      id: actor,
      type: env.type,
      bodyJson: body,
      createdAt,
      receivedAt: now,
      targetId: "",
      payloadCid: "",
      replyTo: "",
    });
  } catch (err) {
    return errResponse(err);
  }
  return jsonResponse(200, { event_id: env.eventId, received_at: now });
}

/**
 * handleEventPost（event.go:44-81）按类型分流；已验签身份由 requireAuth 以形参传入。
 * 五类事件均有真分支；putBareEvent 仅作为未列举类型的骨架兜底（当前不可达）。
 */
export function eventPostHandler(deps: EventDeps): AuthedHandler {
  return async (req, actor) => {
    const dec = decodeStrict(req, {
      event_id: "string",
      type: "string",
      sig: "string",
      created_at: "number",
      body: "rawText",
    });
    if (!dec.ok) return dec.resp;
    const env: EventEnvelope = {
      eventId: dec.value.event_id as string,
      type: dec.value.type as string,
      sig: dec.value.sig as string,
      createdAtRaw: dec.value.created_at as string,
      bodyRaw: dec.value.body as string,
    };
    if (!EVENT_TYPES.has(env.type)) return jsonResponse(400, { error: "event_type_unknown" });
    // Go 先 Int64() 再判 isHexN(event_id,16) 与 createdAt<=0，三者任一不成立即同一错误码。
    const createdAt = parseGoInt64(env.createdAtRaw);
    if (createdAt === null || !isHexN(env.eventId, 16) || createdAt <= 0) {
      return jsonResponse(400, { error: "event_param_invalid" });
    }
    // 必须保留 || 短路：byID 拒绝时不得消耗 byIP 的令牌。
    if (!deps.byID.allow(actor) || !deps.byIP.allow(CLIENT_BUCKET_KEY)) {
      return writeAuthErr(429, "event_rate_limited");
    }
    switch (env.type) {
      case "comment.v1":
        return handleCommentEvent(deps, actor, env, createdAt);
      case "group.v1":
        return groupEventHandler(deps, actor, env, createdAt);
      case "dm.v1":
        return dmEventHandler(deps, actor, env, createdAt);
      case "progress.v1":
        return progressEventHandler(deps, actor, env, createdAt);
      case "govern.v1":
        return governEventHandler(deps, actor, env, createdAt);
    }
    return putBareEvent(deps, actor, env, createdAt);
  };
}