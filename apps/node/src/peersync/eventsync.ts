// 逐行移植 internal/peersync/eventsync.go（436 行）：事件增量 + 墓碑增量同步，以及
// 收到事件后的本地投影（group / progress / govern）。
//
// 与 Go 的**有意差异**（记录于文件头）：
//   1. 方法形态：Go 是 `func (c Config) SyncEvents(...)`；TS 无接收者，改为导出函数 `syncEvents(c, ctx, st, p)`。
//   2. `hc *http.Client` 换成本节点的 `PeerTransport`（由 `client(c,p)` 得到），`doRequest` 发请求。
//   3. `io.LimitReader(res.Body, 8<<20)`：TS 用 `res.body.subarray(0, 8<<20)`——**同样是截断而非报错**。
//   4. `json.Unmarshal` 的强类型语义用一组内部 helper 忠实模拟（见 `goObj` / `goStr` / `goInt` 等）：
//      顶层非对象且非 null → 错误；字段值非目标类型（非 null/缺键）→ 错误；错误一律走「零值」分支。
//   5. `applySyncedGroupEvent` 的 Go 签名 `(bool, error)` 在 TS 中改为 `void` + 真错误抛异常；
//      `applySyncedProgressEvent` 同理；`applySyncedGovernEvent` 的投影失败在函数内记日志、不向外抛。
//   6. `[]json.RawMessage`（envelopes）在 Go 里原样搬运字节；TS 无 RawMessage，**重新序列化**为
//      `{"envelopes":[...]}`（有意差异，字节形态等价，仅键序可能不同）。
//   7. Go 的 `log.Printf` / `fmt.Printf` 改为 `console.warn` / `console.log`。
import { parseGoInt64, directoryKindOfItemId, normalizeTermKey, GOVERN_ACTION_DIRECTORY_ADD } from "../routes/derived";
import type { SyncStore } from "../store/syncstore";
import { client, doRequest, type Config, type Peer, type PeerResponse, type PeerTransport, type SyncContext } from "./peer";
import { endpoint } from "./remote";

/** eventSyncPageLimit（eventsync.go:19）：单请求条数；与 httpapi 的 eventSyncDefaultLimit 一致。 */
export const EVENT_SYNC_PAGE_LIMIT = 200;
/** maxEventPages（eventsync.go:23）：单轮单 peer 单 kind 的翻页上限，防对端持续增长时本轮永不结束。 */
export const MAX_EVENT_PAGES = 20;

const decoder = new TextDecoder();

/** Go `json.Unmarshal` 失败时的统一包装（eventsync.go:201-203 的同一个前缀）。 */
function unmarshalError(detail: string): Error {
  return new Error(`event-sync 响应不是合法 JSON: ${detail}`);
}

/** EventSyncResult（eventsync.go:27-34）：一轮事件增量同步的结果（日志字段）。 */
export class EventSyncResult {
  events = 0;
  tombstones = 0;

  String(): string {
    return `event_sync events=${this.events} tombstones=${this.tombstones}`;
  }
}

/** eventSyncCursor（eventsync.go:36-39）。 */
interface EventSyncCursor {
  ts: number;
  id: string;
}

/** eventSyncItem（eventsync.go:41-48）。 */
export interface EventSyncItem {
  eventId: string;
  id: string;
  type: string;
  bodyJson: string;
  createdAt: number;
  receivedAt: number;
}

/** tombstoneItem（eventsync.go:50-56）。 */
interface TombstoneItem {
  eventId: string;
  payloadCid: string;
  reason: string;
  at: number;
  receivedAt: number;
}

// ---------------------------------------------------------------------------
// 忠实模拟 Go encoding/json 的强类型语义（见文件头差异 4）
// ---------------------------------------------------------------------------

interface GoObjResult {
  ok: boolean;
  obj: Record<string, unknown>;
}

/** 顶层：非 JSON / 非对象且非 null → 错误；JSON null 视作全缺省（Go 不报错）。 */
function goObj(bodyJSON: string): GoObjResult {
  let v: unknown;
  try {
    v = JSON.parse(bodyJSON);
  } catch {
    return { ok: false, obj: {} };
  }
  if (v === null || v === undefined) return { ok: true, obj: {} };
  if (typeof v !== "object" || Array.isArray(v)) return { ok: false, obj: {} };
  return { ok: true, obj: v as Record<string, unknown> };
}

interface GoField<T> {
  ok: boolean;
  value: T;
}

/** 塞进 string 字段：缺键/null → ""；非字符串 → 错误。 */
function goStr(obj: Record<string, unknown>, key: string): GoField<string> {
  const raw = obj[key];
  if (raw === undefined || raw === null) return { ok: true, value: "" };
  if (typeof raw !== "string") return { ok: false, value: "" };
  return { ok: true, value: raw };
}

const INT64_MAX = 2 ** 63 - 1;
const INT64_MIN = -(2 ** 63);

function badInt(raw: unknown): boolean {
  return typeof raw !== "number" || !Number.isInteger(raw) || raw > INT64_MAX || raw < INT64_MIN;
}

/** 塞进 int64：缺键/null → 0；非整数或越 int64 范围 → 错误。 */
function goInt(obj: Record<string, unknown>, key: string): GoField<number> {
  const raw = obj[key];
  if (raw === undefined || raw === null) return { ok: true, value: 0 };
  if (badInt(raw)) return { ok: false, value: 0 };
  return { ok: true, value: raw as number };
}

/** 塞进 *int64：缺键/null → null；非整数或越界 → 错误。 */
function goIntPtr(obj: Record<string, unknown>, key: string): GoField<number | null> {
  const raw = obj[key];
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (badInt(raw)) return { ok: false, value: null };
  return { ok: true, value: raw as number };
}

/** 塞进 bool：缺键/null → false；非布尔 → 错误。 */
function goBool(obj: Record<string, unknown>, key: string): GoField<boolean> {
  const raw = obj[key];
  if (raw === undefined || raw === null) return { ok: true, value: false };
  if (typeof raw !== "boolean") return { ok: false, value: false };
  return { ok: true, value: raw };
}

/** 塞进 []string：缺键/null → null（Go nil slice）；非数组或元素非字符串 → 错误。 */
function goStrSlice(obj: Record<string, unknown>, key: string): GoField<string[] | null> {
  const raw = obj[key];
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw)) return { ok: false, value: null };
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string") return { ok: false, value: null };
    out.push(x);
  }
  return { ok: true, value: out };
}

/** 塞进 []json.RawMessage：缺键/null → null；非数组 → 错误（元素可为任意 JSON）。 */
function goRawSlice(obj: Record<string, unknown>, key: string): GoField<unknown[] | null> {
  const raw = obj[key];
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw)) return { ok: false, value: null };
  return { ok: true, value: raw };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * SyncEvents（eventsync.go:70-81）：对一个 peer 拉一轮事件增量与墓碑增量（册子 §4.4）。
 * 先事件后墓碑：墓碑到达即删本地块，若反过来则同一轮可能先落块再删，白跑一趟。
 */
export async function syncEvents(c: Config, ctx: SyncContext, st: SyncStore, p: Peer): Promise<EventSyncResult> {
  const res = new EventSyncResult();
  // Go 的 c.client(p) 失败即返回错误；Node 的 client 抛异常，直接向上冒泡（等价）。
  const tr = client(c, p);
  res.events = await pullEvents(c, ctx, tr, st, p);
  res.tombstones = await pullTombstones(c, ctx, tr, st, p);
  return res;
}

/** pullEvents（eventsync.go:83-140）。 */
async function pullEvents(
  c: Config,
  ctx: SyncContext,
  tr: PeerTransport,
  st: SyncStore,
  p: Peer,
): Promise<number> {
  let cur: EventSyncCursor = st.getPeerCursor(p.url, "event");
  let total = 0;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const out = await postEventSync(c, ctx, tr, p, "event", cur);
    const items = toEventItems(out.items);
    // 治理事件才派生名册，且**整页只派生一次**（册子 §4.3）：本页只写事件与投影，不碰名册输入，故页内复用安全。
    let govRoster = new Set<string>();
    let govRosterOk = false;
    for (const it of items) {
      if (it.type === "govern.v1") {
        const d = deriveGovernRoster(st);
        govRoster = d.roster;
        govRosterOk = d.ok;
        break;
      }
    }
    for (const it of items) {
      const proj = parseEventProjection(it.type, it.bodyJson);
      // 本地 received_at 用本机 now（receivedAt 传 0，底层填 now）：游标口径必须与本地读接口一致。
      st.putEvent({
        eventId: it.eventId,
        id: it.id,
        type: it.type,
        bodyJson: it.bodyJson,
        createdAt: it.createdAt,
        receivedAt: 0,
        targetId: proj.targetId,
        payloadCid: proj.payloadCid,
        replyTo: proj.replyTo,
      });
      // group / progress：投影失败**阻断整页**，直接向外抛。
      applySyncedGroupEvent(st, it);
      applySyncedProgressEvent(st, it);
      // govern：投影失败**不阻断整页反熵**（事件行才是权威来源，读接口可从事件重算）。
      try {
        applySyncedGovernEvent(st, it, govRoster, govRosterOk);
      } catch (err) {
        console.warn(`peersync: govern.v1 投影失败（事件行已落，读接口可从事件重算）: ${String(err)}`);
      }
      // circle.v1 assign 投影（融合治理册 §2.2 的轨道 A）：写 circle_assignments 一行。
      // form 投影留 T4——对端事件 body 不带 creator_id，本地 items 可能还没。
      applySyncedCircleEvent(st, it);
      total++;
    }
    if (items.length === 0) return total; // 空页：本 kind 已拉完
    // 用本页末条推进游标：对端只在满页时给 next，不满页同样要推进，否则每轮重拉尾部。
    const last = items[items.length - 1];
    const next: EventSyncCursor = { ts: last.receivedAt, id: last.eventId };
    st.putPeerCursor(p.url, "event", next.ts, next.id);
    cur = next;
    if (out.next === null) return total;
  }
  return total;
}

/** pullTombstones（eventsync.go:142-181）。 */
async function pullTombstones(
  c: Config,
  ctx: SyncContext,
  tr: PeerTransport,
  st: SyncStore,
  p: Peer,
): Promise<number> {
  let cur: EventSyncCursor = st.getPeerCursor(p.url, "tombstone");
  let total = 0;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const out = await postEventSync(c, ctx, tr, p, "tombstone", cur);
    const items = toTombstoneItems(out.items);
    for (const it of items) {
      // 墓碑 upsert 幂等；收到即删本地副本（反熵护栏 3 的同一条语义）。receivedAt 传 0，底层填本机 now。
      st.putCommentTombstone({
        eventId: it.eventId,
        payloadCid: it.payloadCid,
        reason: it.reason,
        at: it.at,
        receivedAt: 0,
      });
      const h = st.hasBlob(it.payloadCid);
      if (h.exists) st.deleteBlob(it.payloadCid);
      total++;
    }
    if (items.length === 0) return total;
    const last = items[items.length - 1];
    const next: EventSyncCursor = { ts: last.receivedAt, id: last.eventId };
    st.putPeerCursor(p.url, "tombstone", next.ts, next.id);
    cur = next;
    if (out.next === null) return total;
  }
  return total;
}

/** postEventSync（eventsync.go:184-205）：发一次 event-sync 请求并把响应解析成 `{items,next}`。 */
async function postEventSync(
  c: Config,
  ctx: SyncContext,
  tr: PeerTransport,
  p: Peer,
  kind: string,
  cur: EventSyncCursor,
): Promise<{ items: unknown[]; next: EventSyncCursor | null }> {
  const body = new TextEncoder().encode(
    JSON.stringify({ kind, after: { ts: cur.ts, id: cur.id }, limit: EVENT_SYNC_PAGE_LIMIT }),
  );
  let res: PeerResponse;
  try {
    res = await doRequest(c, ctx, tr, "POST", endpoint(p, "/v1/event-sync"), body);
  } catch (err) {
    throw new Error(`POST /v1/event-sync: ${String(err)}`);
  }
  // io.LimitReader 语义：截断而非报错（超过 8MiB 的响应会在下面 JSON 解析处失败，与 Go 一致）。
  const raw = res.body.subarray(0, 8 << 20);
  if (res.status !== 200) {
    throw new Error(`POST /v1/event-sync: HTTP ${res.status} ${decoder.decode(raw).trim()}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(raw));
  } catch (err) {
    throw new Error(`event-sync 响应不是合法 JSON: ${String(err)}`);
  }
  // Go 把响应解进 `eventSyncPage{Items []eventSyncItem; Next *eventSyncCursor}`：JSON null 不报错（留零值），
  // 顶层非对象、items 非数组、next 非对象、字段类型不符都报 `json.Unmarshal` 错误。
  if (parsed === null || parsed === undefined) return { items: [], next: null };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw unmarshalError("顶层不是 JSON 对象");
  }
  const o = parsed as Record<string, unknown>;
  const rawItems = o.items;
  if (rawItems !== undefined && rawItems !== null && !Array.isArray(rawItems)) {
    throw unmarshalError("items 不是 JSON 数组");
  }
  const items: unknown[] = rawItems === undefined || rawItems === null ? [] : (rawItems as unknown[]);
  const rawNext = o.next;
  if (rawNext === undefined || rawNext === null) return { items, next: null };
  if (typeof rawNext !== "object" || Array.isArray(rawNext)) {
    throw unmarshalError("next 不是 JSON 对象");
  }
  const nextObj = rawNext as Record<string, unknown>;
  const ts = goInt(nextObj, "ts");
  const id = goStr(nextObj, "id");
  if (!ts.ok || !id.ok) throw unmarshalError("next 字段类型不符");
  return { items, next: { ts: ts.value, id: id.value } };
}

/** 页内 event 项（eventsync.go:41-48）：严格按线名与类型还原，类型不符即抛 `json.Unmarshal` 等价错误。 */
function toEventItems(raw: unknown[]): EventSyncItem[] {
  return raw.map((x) => {
    const o = jsonObjectOrNull(x);
    if (o === null) throw unmarshalError("items 元素不是 JSON 对象");
    const eventId = goStr(o, "event_id");
    const id = goStr(o, "id");
    const type = goStr(o, "type");
    const bodyJson = goStr(o, "body_json");
    const createdAt = goInt(o, "created_at");
    const receivedAt = goInt(o, "received_at");
    if (!eventId.ok || !id.ok || !type.ok || !bodyJson.ok || !createdAt.ok || !receivedAt.ok) {
      throw unmarshalError("items 元素字段类型不符");
    }
    return {
      eventId: eventId.value,
      id: id.value,
      type: type.value,
      bodyJson: bodyJson.value,
      createdAt: createdAt.value,
      receivedAt: receivedAt.value,
    };
  });
}

/** 页内 tombstone 项（eventsync.go:50-56）：同 toEventItems 的严格口径。 */
function toTombstoneItems(raw: unknown[]): TombstoneItem[] {
  return raw.map((x) => {
    const o = jsonObjectOrNull(x);
    if (o === null) throw unmarshalError("items 元素不是 JSON 对象");
    const eventId = goStr(o, "event_id");
    const payloadCid = goStr(o, "payload_cid");
    const reason = goStr(o, "reason");
    const at = goInt(o, "at");
    const receivedAt = goInt(o, "received_at");
    if (!eventId.ok || !payloadCid.ok || !reason.ok || !at.ok || !receivedAt.ok) {
      throw unmarshalError("items 元素字段类型不符");
    }
    return {
      eventId: eventId.value,
      payloadCid: payloadCid.value,
      reason: reason.value,
      at: at.value,
      receivedAt: receivedAt.value,
    };
  });
}

/** JSON null/缺省 → `{}`（Go 解进 struct 不报错、留零值）；对象 → 对象；其余 → null（调用方判为类型错误）。 */
function jsonObjectOrNull(x: unknown): Record<string, unknown> | null {
  if (x === null || x === undefined) return {};
  if (typeof x === "object" && !Array.isArray(x)) return x as Record<string, unknown>;
  return null;
}

// ---------------------------------------------------------------------------
// 本地投影
// ---------------------------------------------------------------------------

/** commentProjection（eventsync.go:208-212）。 */
export interface EventProjection {
  targetId: string;
  payloadCid: string;
  replyTo: string;
}

const ZERO_PROJECTION: EventProjection = { targetId: "", payloadCid: "", replyTo: "" };

/**
 * parseEventProjection（eventsync.go:217-264）：从 body_json 还原投影列（收到的对端事件只有 body_json，
 * 索引列必须在本地重建）。非已知类型返回零值（不认识的事件仍然落行，只是没有索引）。
 */
export function parseEventProjection(typ: string, bodyJSON: string): EventProjection {
  switch (typ) {
    case "comment.v1": {
      const g = goObj(bodyJSON);
      if (!g.ok) return ZERO_PROJECTION;
      const target = goStr(g.obj, "target_id");
      const payload = goStr(g.obj, "payload_cid");
      const reply = goStr(g.obj, "reply_to");
      if (!target.ok || !payload.ok || !reply.ok) return ZERO_PROJECTION;
      return { targetId: target.value, payloadCid: payload.value, replyTo: reply.value };
    }
    case "like.v1":
    case "report.v1": {
      // #79 §6：无 payload 事件，投影只填 target_id。
      const g = goObj(bodyJSON);
      if (!g.ok) return ZERO_PROJECTION;
      const target = goStr(g.obj, "target_id");
      if (!target.ok || target.value === "") return ZERO_PROJECTION;
      return { targetId: target.value, payloadCid: "", replyTo: "" };
    }
    case "group.v1": {
      const g = goObj(bodyJSON);
      if (!g.ok) return ZERO_PROJECTION;
      const groupId = goStr(g.obj, "group_id");
      const payload = goStr(g.obj, "payload_cid");
      const reply = goStr(g.obj, "reply_to");
      if (!groupId.ok || !payload.ok || !reply.ok || groupId.value === "") return ZERO_PROJECTION;
      return { targetId: "group/" + groupId.value, payloadCid: payload.value, replyTo: reply.value };
    }
    case "dm.v1": {
      const g = goObj(bodyJSON);
      if (!g.ok) return ZERO_PROJECTION;
      const to = goStr(g.obj, "to");
      const payload = goStr(g.obj, "payload_cid");
      if (!to.ok || !payload.ok || to.value === "") return ZERO_PROJECTION;
      return { targetId: "dm/" + to.value, payloadCid: payload.value, replyTo: "" };
    }
    case "progress.v1": {
      const g = goObj(bodyJSON);
      if (!g.ok) return ZERO_PROJECTION;
      const itemId = goStr(g.obj, "item_id");
      if (!itemId.ok || itemId.value === "") return ZERO_PROJECTION;
      return { targetId: itemId.value, payloadCid: "", replyTo: "" };
    }
    case "circle.v1": {
      // circle.v1 body 是 {action,item_id,circle_id,origin?,content_hash?}，
      // 不带 target_id / payload_cid / reply_to——三列全空（融合治理册 §2.2）。
      return ZERO_PROJECTION;
    }
    default:
      return ZERO_PROJECTION;
  }
}

/**
 * applySyncedGroupEvent（eventsync.go:270-318）：把对端来的 roster 事件落进本地名单投影。
 * 用 ForceGroupRoster——不校验 owner，只接受更大的 epoch，旧值静默忽略。真错误抛异常。
 */
export function applySyncedGroupEvent(st: SyncStore, it: EventSyncItem): void {
  if (it.type !== "group.v1") return;
  const g = goObj(it.bodyJson);
  if (!g.ok) return;
  const groupId = goStr(g.obj, "group_id");
  const action = goStr(g.obj, "action");
  const sub = goStr(g.obj, "sub");
  const epoch = goInt(g.obj, "epoch");
  const rosterRev = goInt(g.obj, "roster_rev");
  const encrypted = goIntPtr(g.obj, "encrypted");
  const memberIds = goStrSlice(g.obj, "member_ids");
  const envelopes = goRawSlice(g.obj, "envelopes");
  if (
    !groupId.ok ||
    !action.ok ||
    !sub.ok ||
    !epoch.ok ||
    !rosterRev.ok ||
    !encrypted.ok ||
    !memberIds.ok ||
    !envelopes.ok
  ) {
    return;
  }
  if (groupId.value === "") return;
  // 空名单只放行解散（sub=dissolve）：否则解散事件会消失，对端永远保留旧名单。
  const emptyMembers = memberIds.value === null || memberIds.value.length === 0;
  if (action.value !== "roster" || epoch.value < 1 || (emptyMembers && sub.value !== "dissolve")) return;
  // Go json.Marshal([]string)：nil slice → "null"（键缺失/null），[] → "[]"，其余逐元素 JSON。
  const membersJSON = memberIds.value === null ? "null" : JSON.stringify(memberIds.value);
  // encrypted 缺省必须显式给 1（封闭）：v1 老事件没有该键，用 int64 零值 0 会把老事件误判成开放圈。
  const enc = encrypted.value === null ? 1 : encrypted.value;
  // 信封列必须与写路径同形态：包装对象 {"envelopes":[...]}（有意差异 6：原 RawMessage 重新序列化）。
  const envList = envelopes.value;
  const envelopesJSON = envList !== null && envList.length > 0 ? JSON.stringify({ envelopes: envList }) : "[]";
  st.forceGroupRoster({
    groupId: groupId.value,
    creatorId: it.id,
    epoch: epoch.value,
    rosterRev: rosterRev.value,
    encrypted: enc,
    memberIdsJson: membersJSON,
    keyEnvelopesJson: envelopesJSON,
    eventId: it.eventId,
    updatedAt: 0,
  });
}

/**
 * applySyncedProgressEvent（eventsync.go:325-345）：把对端来的 progress.v1 事件投影进本地
 * progress + checkin_days。与 group 同强度：投影失败**阻断整页**（真错误抛异常）。
 */
export function applySyncedProgressEvent(st: SyncStore, it: EventSyncItem): void {
  if (it.type !== "progress.v1") return;
  const g = goObj(it.bodyJson);
  if (!g.ok) return;
  const itemId = goStr(g.obj, "item_id");
  const position = goInt(g.obj, "position");
  const done = goBool(g.obj, "done");
  const day = goStr(g.obj, "day");
  if (!itemId.ok || !position.ok || !done.ok || !day.ok || itemId.value === "") return;
  st.putProgressProjection({
    id: it.id,
    itemId: itemId.value,
    position: position.value,
    done: done.value,
    day: day.value,
    createdAt: it.createdAt,
    eventId: it.eventId,
  });
}

/**
 * applySyncedGovernEvent（eventsync.go:352-421）：把对端来的 govern.v1 事件投影进本地 govern_* 两表。
 * 投影幂等；冲突事件**不算错**；settle 失败只记日志、**不阻断整页反熵**。
 * roster 由调用方每页派生一次传入；rosterReady 是名册就绪位，透传给 settle。
 */
export function applySyncedGovernEvent(
  st: SyncStore,
  it: EventSyncItem,
  roster: Set<string>,
  rosterReady: boolean,
): void {
  if (it.type !== "govern.v1") return;
  // body_json 是客户端原始键集（httpapi 存的就是 req.Body 原文），故这里能取到全部字段。
  const g = goObj(it.bodyJson);
  if (!g.ok) return;
  const action = goStr(g.obj, "action");
  const proposalId = goStr(g.obj, "proposal_id");
  const targetItemId = goStr(g.obj, "target_item_id");
  const verb = goStr(g.obj, "verb");
  const contentHash = goStr(g.obj, "content_hash");
  const reason = goStr(g.obj, "reason");
  const titleField = goStr(g.obj, "title");
  const bodyField = goStr(g.obj, "body_md");
  const choice = goStr(g.obj, "choice");
  const directoryKind = goStr(g.obj, "directory_kind");
  const directoryTermKey = goStr(g.obj, "directory_term_key");
  const directoryDisplayName = goStr(g.obj, "directory_display_name");
  const contentVersion = goInt(g.obj, "content_version");
  const revokedRev = goInt(g.obj, "revoked_rev");
  // Go 逐字段 Unmarshal，任一字段类型错误都使整体失败 → 落行但不投影。
  for (const f of [
    action,
    proposalId,
    targetItemId,
    verb,
    contentHash,
    reason,
    titleField,
    bodyField,
    choice,
    directoryKind,
    directoryTermKey,
    directoryDisplayName,
    contentVersion,
    revokedRev,
  ]) {
    if (!f.ok) return;
  }
  if (proposalId.value === "") return;
  const pid = parseGoInt64(proposalId.value);
  if (pid === null || pid <= 0) return;
  switch (action.value) {
    case "proposal": {
      // 与 httpapi.parseGovernBody 同口径的镜像校验：directory_add 形态不认识 ⇒ 落行不投影。
      let title = titleField.value;
      let body = bodyField.value;
      if (verb.value === GOVERN_ACTION_DIRECTORY_ADD) {
        if (directoryKindOfItemId(targetItemId.value) === null) return;
        const tk = normalizeTermKey(directoryDisplayName.value);
        if (tk === null || tk !== directoryTermKey.value) return;
        title = directoryDisplayName.value;
        body = directoryTermKey.value;
      }
      // 返回值 true=冲突**不算错**（投影已收敛，事件行照落）；真错误由实现抛异常向上冒泡。
      st.projectGovernProposal({
        proposalId: pid,
        targetItemId: targetItemId.value,
        verb: verb.value,
        contentHash: contentHash.value,
        reason: reason.value,
        title,
        bodyMd: body,
        contentVersion: contentVersion.value,
        revokedRev: revokedRev.value,
        createdAt: it.createdAt,
        eventId: it.eventId,
        actor: it.id,
      });
      break;
    }
    case "vote":
      st.projectGovernVote({
        proposalId: pid,
        choice: choice.value,
        createdAt: it.createdAt,
        eventId: it.eventId,
        actor: it.id,
      });
      break;
    default:
      return;
  }
  // 投影后 settle：proposal 与 vote 两支都要（反熵不保证 proposal 先于 vote 到达）。
  try {
    st.settleGovernProposal(pid, roster, rosterReady);
  } catch (err) {
    console.warn(
      `peersync: 治理提案 ${pid} 生效判定失败（事件行已落，读接口可从事件重算）: ${String(err)}`,
    );
  }
}

/**
 * deriveGovernRoster（eventsync.go:425-436）：派生本节点治者名册；失败返回 ok=false，
 * 按空名册降级（settle 停在 pending）。
 */
export function deriveGovernRoster(st: SyncStore): { roster: Set<string>; ok: boolean } {
  try {
    const rows = st.contributorRoster();
    const set = new Set<string>();
    for (const c of rows) set.add(c.id);
    return { roster: set, ok: true };
  } catch (err) {
    console.warn(`peersync: 治理名册派生失败，按空名册降级（settle 停在 pending）: ${String(err)}`);
    return { roster: new Set(), ok: false };
  }
}

/**
 * applySyncedCircleEvent（eventsync.go:452-498）：把对端来的 circle.v1 事件投影进本地
 * circle_assignments +（form 时）groups（融合治理册 §2.2）。
 * action=assign → putCircleAssignment（轨道 A 归属声明）。
 * action=form   → upsertGroupForForm + putCircleAssignment（轨道 B 成圈）。
 * form 投影用本地 items 表取 author_id；不存在 → 静默跳过（事件行已落、投影等重放）。
 * 与 group / progress 同强度：投影失败**阻断整页**（真错误抛异常）。
 */
export function applySyncedCircleEvent(st: SyncStore, it: EventSyncItem): void {
  if (it.type !== "circle.v1") return;
  const g = goObj(it.bodyJson);
  if (!g.ok) return;
  const action = goStr(g.obj, "action");
  const itemId = goStr(g.obj, "item_id");
  const circleId = goStr(g.obj, "circle_id");
  const origin = goStr(g.obj, "origin");
  // Go 逐字段 Unmarshal，任一字段类型错误都使整体失败 → 落行但不投影。
  for (const f of [action, itemId, circleId, origin]) {
    if (!f.ok) return;
  }
  if (itemId.value === "" || circleId.value === "") return;
  const o = origin.value === "" ? "fusion" : origin.value;
  switch (action.value) {
    case "assign":
      st.putCircleAssignment(itemId.value, circleId.value, o, it.createdAt);
      return;
    case "form": {
      const item = st.getItemRow(itemId.value);
      if (item === null) return; // 事件行已落、投影等重放
      st.upsertGroupForForm(circleId.value, item.authorId, it.createdAt, o);
      st.putCircleAssignment(itemId.value, circleId.value, o, it.createdAt);
      return;
    }
  }
}