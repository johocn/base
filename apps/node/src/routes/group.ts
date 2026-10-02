// 逐行对齐 internal/httpapi/group.go 的读面（:647-800）：groupDTO / groupEventDTO / groupResponse /
// handleGroupGet / groupName / memberOf。写面见 routes/groupEvent.ts。
import { canonicalize, type Json } from "@base/protocol-ts";
import type { AuthedHandler } from "./authmw";
import { writeAuthErr } from "./authmw";
import type { Db } from "../db";
import { jsonObjectField, parseJSONDocument } from "./decode";
import { isHexN, parseGoInt, parseGoInt64 } from "./derived";
import { parseCommentCursor } from "./comment";
import { jsonResponse, rawJSON } from "./json";
import { getGroup, listGroupEvents, listGroupMsgEvents } from "../store/group";
import { deriveSeats } from "../store/groupseats";
import { getEventById, type EventRow } from "../store/events";

// 分页上限（group.go:21-22）。
const GROUP_DEFAULT_LIMIT = 30;
const GROUP_MAX_LIMIT = 100;

function errResponse(err: unknown): ReturnType<typeof jsonResponse> {
  return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
}

/** memberOf（group.go:790-800）：actor 为空（匿名）恒 false。 */
function memberOf(members: string[], actor: string): boolean {
  if (actor === "") return false;
  for (const m of members) {
    if (m === actor) return true;
  }
  return false;
}

/**
 * groupName（group.go:775-787）：从 groups.event_id 指向事件的 body_json 取组名。
 * 事件缺失、body 非对象、name 键缺失/为 null/非字符串一律空串（对齐 json.Unmarshal 进
 * `struct{ Name string }` 的 no-op 与报错语义）。
 */
function groupName(db: Db, eventId: string): string {
  let ev: EventRow | null;
  try {
    ev = getEventById(db, eventId);
  } catch {
    return "";
  }
  if (ev === null) return "";
  const doc = parseJSONDocument(ev.bodyJson);
  if (doc === null) return ""; // 语法错误 → Unmarshal 报错
  if (doc.t === "null") return ""; // 顶层 null → no-op（零值）
  if (doc.t !== "obj") return ""; // 类型错误 → 报错
  const node = jsonObjectField(doc, "name");
  if (node === undefined || node.t !== "str") return "";
  return node.v;
}

/** string 字段取值：未出现或 null → ""（no-op 零值）；非字符串 → null（报错）。 */
function fieldString(node: ReturnType<typeof jsonObjectField>): string | null {
  if (node === undefined || node.t === "null") return "";
  return node.t === "str" ? node.v : null;
}

/** int64 字段取值：未出现或 null → 0；非十进制整数字面量/越界 → null（报错）。 */
function fieldInt64(node: ReturnType<typeof jsonObjectField>): number | null {
  if (node === undefined || node.t === "null") return 0;
  if (node.t !== "num") return null;
  return parseGoInt64(node.raw);
}

/**
 * 解析事件 body_json 到 `struct{ Action string; Epoch int64; PayloadCID string; ReplyTo string }`
 * （group.go:744-750）。解析失败返回 null（调用方 continue）。
 */
function parseEventBody(
  bodyJson: string,
): { action: string; epoch: number; payloadCid: string; replyTo: string } | null {
  const doc = parseJSONDocument(bodyJson);
  if (doc === null) return null;
  if (doc.t === "null") return { action: "", epoch: 0, payloadCid: "", replyTo: "" };
  if (doc.t !== "obj") return null;
  const action = fieldString(jsonObjectField(doc, "action"));
  if (action === null) return null;
  const epoch = fieldInt64(jsonObjectField(doc, "epoch"));
  if (epoch === null) return null;
  const payloadCid = fieldString(jsonObjectField(doc, "payload_cid"));
  if (payloadCid === null) return null;
  const replyTo = fieldString(jsonObjectField(doc, "reply_to"));
  if (replyTo === null) return null;
  return { action, epoch, payloadCid, replyTo };
}

/**
 * envelopes 分支（group.go:734-741）：
 * - `key_envelopes` 为 "" 或 "[]" → 默认空数组 `[]`；
 * - 解析失败或 `envelopes` 非数组 → 报错 → **保留默认 `[]`**；
 * - 解析成功但**无 `envelopes` 键**（或值为 null）→ Go 把 `Envelopes` 赋成 nil ⇒ 输出 **`null`**
 *   （不是省略该键、也不是 `[]`）；
 * - 是数组 → 元素按 Go `[]json.RawMessage` 原样嵌入（仓里 key_envelopes 恒为 canonicalize 产物，
 *   元素文本即其 canonical 形态，故用 canonicalize 复现得到与原文相同字节）。
 */
function parseEnvelopes(keyEnvelopesJson: string): unknown[] | null {
  if (keyEnvelopesJson === "" || keyEnvelopesJson === "[]") return [];
  let wrap: unknown;
  try {
    wrap = JSON.parse(keyEnvelopesJson);
  } catch {
    return [];
  }
  if (wrap === null) return null; // 顶层 null → no-op → nil → JSON null
  if (typeof wrap !== "object" || Array.isArray(wrap)) return [];
  const env = (wrap as Record<string, unknown>).envelopes;
  if (env === undefined || env === null) return null; // 无键/值为 null → nil → JSON null
  if (!Array.isArray(env)) return [];
  return env.map((el) => {
    try {
      return rawJSON(canonicalize(el as Json));
    } catch {
      return rawJSON(JSON.stringify(el));
    }
  });
}

/**
 * handleGroupGet（group.go:681-769）：分页读小组索引与当前名单（册子 §4.3 / §3.7）。
 * 形态分支：开放圈匿名可读；封闭圈需成员签名读权，非成员一律 404（不泄露存在性）。
 * 正文另取 GET /v1/blob/{payload_cid}（密文）。
 */
export function groupGetHandler(deps: { db: Db }): AuthedHandler {
  return async (req, actor) => {
    const db = deps.db;
    const groupId = req.params.group_id ?? "";
    if (!isHexN(groupId, 16)) {
      return jsonResponse(400, { error: "event_param_invalid" });
    }
    let g: ReturnType<typeof getGroup>;
    try {
      g = getGroup(db, groupId);
    } catch (err) {
      return errResponse(err);
    }
    if (g === null) {
      // 尚无任何 roster 事件（册子 §4.3）；带 code 供客户端分流。
      return writeAuthErr(404, "group_not_found");
    }
    // 投影损坏不该让整页 500：名单退化为空。
    let members: string[] = [];
    try {
      const parsed = JSON.parse(g.memberIdsJson) as unknown;
      if (Array.isArray(parsed) && parsed.every((it) => typeof it === "string")) {
        members = parsed as string[];
      }
    } catch {
      members = [];
    }
    // 形态分支（册子 §3.7）：开放圈匿名放行；封闭圈需成员签名读权；非成员一律 404（不泄露存在性）。
    if (g.encrypted === 1 && members.length > 0 && !memberOf(members, actor)) {
      return writeAuthErr(404, "group_read_denied");
    }
    let limit = GROUP_DEFAULT_LIMIT;
    const limitRaw = req.query.limit ?? "";
    if (limitRaw !== "") {
      const n = parseGoInt(limitRaw);
      if (n !== null && n > 0 && n <= GROUP_MAX_LIMIT) limit = n;
    }
    const cur = parseCommentCursor(req.query.cursor ?? ""); // 同一套不透明游标 <created_at>_<event_id>
    let rows: EventRow[];
    try {
      rows = listGroupEvents(db, groupId, cur.ts, cur.id, limit);
    } catch (err) {
      return errResponse(err);
    }
    let msgEvents: EventRow[];
    try {
      msgEvents = listGroupMsgEvents(db, groupId);
    } catch (err) {
      return errResponse(err);
    }
    const seats = deriveSeats(members, g.creatorId, g.rosterRev, g.epoch, msgEvents);
    // 键序严格照 Go struct 字段声明顺序（JSON.stringify 保持插入顺序）。
    const group = {
      group_id: g.groupId,
      creator_id: g.creatorId,
      epoch: g.epoch,
      roster_rev: g.rosterRev,
      encrypted: g.encrypted,
      member_ids: members,
      name: groupName(db, g.eventId),
      seat_count: seats.seatCount,
      governors: seats.governors,
      envelopes: parseEnvelopes(g.keyEnvelopesJson),
    };
    const events: unknown[] = [];
    for (const e of rows) {
      // 名单事件不进会话流（已由 group 字段表达），只列 action=msg。
      const b = parseEventBody(e.bodyJson);
      if (b === null || b.action !== "msg") continue;
      events.push({
        event_id: e.eventId,
        actor: e.id,
        created_at: e.createdAt,
        payload_cid: b.payloadCid,
        epoch: b.epoch,
        action: b.action,
        // Go 的 ReplyTo *string：仅当非空才设指针，否则 JSON null。
        reply_to: b.replyTo === "" ? null : b.replyTo,
      });
    }
    // 满页才给游标：与 GET /v1/comment 同口径。
    let nextCursor: string | null = null;
    if (rows.length === limit) {
      const last = rows[rows.length - 1];
      nextCursor = `${last.createdAt}_${last.eventId}`;
    }
    return jsonResponse(200, { group, events, next_cursor: nextCursor });
  };
}