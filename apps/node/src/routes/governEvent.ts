// 逐行对齐 internal/httpapi/govern_event.go 的 governProposalKeys / governVoteKeys / anyString /
// parseGovernBody / handleGovernEvent；校验辅助见 internal/httpapi/govern.go 与 submit.go。
import type { ServerResponse } from "@base/core-ts";
import { getEventById, putEvent } from "../store/events";
import { projectGovernProposal, projectGovernVote, settleGovernProposal } from "../store/governProjection";
import {
  cleanDisplayName,
  directoryProposalItemId,
  GOVERN_ACTION_DIRECTORY_ADD,
  governRoster,
  hasControlChars,
  isHexNonEmptyEven,
  jsonInt,
  normalizeTermKey,
  onlyKeys,
  parseProposalId,
  TERM_KEY_MAX_RUNES,
  validDirectoryKind,
  validItemTitle,
  validProposalReason,
} from "./derived";
import { type EventDeps, type EventEnvelope, validTargetID, verifyEventSig } from "./event";
import { jsonResponse } from "./json";

const GOVERN_ACTION_REMOVE = "remove";
const GOVERN_ACTION_EDIT = "edit";
const GOVERN_ACTION_REVIVE = "revive";

// 两档严格键集（govern_event.go:18-26）：多一个未知键即拒。
const GOVERN_PROPOSAL_KEYS: ReadonlySet<string> = new Set([
  "action",
  "proposal_id",
  "target_item_id",
  "verb",
  "content_hash",
  "content_version",
  "revoked_rev",
  "reason",
  "title",
  "body_md",
  "directory_kind",
  "directory_term_key",
  "directory_display_name",
]);
const GOVERN_VOTE_KEYS: ReadonlySet<string> = new Set(["action", "proposal_id", "choice"]);

/** validProposalAction（govern.go:33-39）：remove / edit / revive / directory_add 四值枚举。 */
function validProposalAction(a: string): boolean {
  return (
    a === GOVERN_ACTION_REMOVE ||
    a === GOVERN_ACTION_EDIT ||
    a === GOVERN_ACTION_REVIVE ||
    a === GOVERN_ACTION_DIRECTORY_ADD
  );
}

/**
 * anyString（govern_event.go:40-50）：string → 原值；数字 → FormatInt(int64(t))；其余 → 空串。
 * JSON.parse 只产出 number，故无 json.Number 分支。
 */
function anyString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(Math.trunc(v));
  return "";
}

/**
 * parseGovernBody（govern_event.go:58-153）：校验 govern.v1 的 body，返回**客户端原始键集**的 map
 * （供验签重建）与 action。失败返回 null。
 */
export function parseGovernBody(
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
  const action = typeof m.action === "string" ? m.action : "";
  switch (action) {
    case "proposal": {
      if (!onlyKeys(m, GOVERN_PROPOSAL_KEYS)) return null;
      if (parseProposalId(anyString(m.proposal_id)) === null) return null;
      if (!validTargetID(anyString(m.target_item_id))) return null;
      if (!validProposalAction(anyString(m.verb))) return null;
      if (!isHexNonEmptyEven(anyString(m.content_hash))) return null;
      for (const k of ["content_version", "revoked_rev"]) {
        const n = jsonInt(m[k]);
        if (n === null || n < 0) return null;
      }
      // reason 可选；「已给定」却不合规要拒（与 handleProposalPost 同口径）。
      if ("reason" in m && !validProposalReason(anyString(m.reason)).ok) return null;
      if ("title" in m && !validItemTitle(anyString(m.title))) return null;
      if ("body_md" in m && typeof m.body_md !== "string") return null;
      // directory_add 的附加校验：三键必存且互相自洽，禁止再用 title / body_md 承载。
      if (anyString(m.verb) === GOVERN_ACTION_DIRECTORY_ADD) {
        for (const k of ["directory_kind", "directory_term_key", "directory_display_name"]) {
          if (!(k in m)) return null;
        }
        const kind = anyString(m.directory_kind);
        const tk = anyString(m.directory_term_key);
        const d = anyString(m.directory_display_name);
        const norm = normalizeTermKey(d);
        const n = [...d].length;
        if (
          !validDirectoryKind(kind) ||
          cleanDisplayName(d) === "" ||
          n < 1 ||
          n > TERM_KEY_MAX_RUNES ||
          hasControlChars(d) ||
          norm === null ||
          norm !== tk ||
          anyString(m.target_item_id) !== directoryProposalItemId(kind, tk)
        ) {
          return null;
        }
        if ("title" in m) return null;
        if ("body_md" in m) return null;
      }
      return { map: m, action };
    }
    case "vote": {
      if (!onlyKeys(m, GOVERN_VOTE_KEYS)) return null;
      if (parseProposalId(anyString(m.proposal_id)) === null) return null;
      // choice 按「1..16 字节 ASCII 非空短串」放行（govern_event.go:139-149）。
      const choice = anyString(m.choice);
      const bytes = Buffer.from(choice, "utf8");
      if (bytes.length < 1 || bytes.length > 16) return null;
      for (const b of bytes) {
        if (b >= 0x80) return null;
      }
      return { map: m, action };
    }
  }
  return null;
}

/**
 * handleGovernEvent（govern_event.go:158-222）：校验 body → 验签 → 投影（失败不拒事件）→ 落事件行
 * → settle（失败只记日志）→ 回读 received_at → 200。
 */
export function governEventHandler(
  deps: EventDeps,
  actor: string,
  env: EventEnvelope,
  createdAt: number,
): ServerResponse {
  const parsed = parseGovernBody(env.bodyRaw);
  if (parsed === null) return jsonResponse(400, { error: "event_param_invalid" });
  const verr = verifyEventSig(deps, actor, env, parsed.map, createdAt);
  if (verr !== null) return verr;
  const rawBody = parsed.map;
  const pid = parseProposalId(anyString(rawBody.proposal_id)) ?? 0;

  // 投影失败不拒事件：冲突（返回 true）只作「告知」，其它错误 → 500。
  let conflict = false;
  try {
    if (parsed.action === "proposal") {
      const cv = jsonInt(rawBody.content_version) ?? 0;
      const rv = jsonInt(rawBody.revoked_rev) ?? 0;
      let title = anyString(rawBody.title);
      let body = anyString(rawBody.body_md);
      // directory_add 的标题 / 正文位由 directory_* 三键承载。
      if (anyString(rawBody.verb) === GOVERN_ACTION_DIRECTORY_ADD) {
        title = anyString(rawBody.directory_display_name);
        body = anyString(rawBody.directory_term_key);
      }
      conflict = projectGovernProposal(deps.db, {
        proposalId: pid,
        targetItemId: anyString(rawBody.target_item_id),
        verb: anyString(rawBody.verb),
        contentHash: anyString(rawBody.content_hash),
        reason: anyString(rawBody.reason),
        title,
        bodyMd: body,
        contentVersion: cv,
        revokedRev: rv,
        createdAt,
        eventId: env.eventId,
        actor,
      });
    } else {
      projectGovernVote(deps.db, {
        proposalId: pid,
        choice: anyString(rawBody.choice),
        createdAt,
        eventId: env.eventId,
        actor,
      });
    }
  } catch (err) {
    return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
  }

  // 事件行先落：body_json 存**客户端原始字节**（不是减化形态，反熵要据它重投影）。
  let now = Date.now();
  try {
    putEvent(deps.db, {
      eventId: env.eventId,
      id: actor,
      type: env.type,
      bodyJson: env.bodyRaw,
      createdAt,
      receivedAt: now,
      targetId: "",
      payloadCid: "",
      replyTo: "",
    });
  } catch (err) {
    return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
  }

  // 权威事件行落地后才做生效判定；settle 是派生、事件是权威：失败只记日志，不拒事件。
  const { set: roster, ok: rosterOK } = governRoster(deps.db, deps.storeKey);
  try {
    settleGovernProposal(deps.db, deps.storeKey, pid, roster, rosterOK);
  } catch (err) {
    console.error(
      `httpapi: 治理提案 ${pid} 生效判定失败（事件行已落）: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 回读 received_at：同 event_id 重发时给权威值（首次值）。
  try {
    const ev = getEventById(deps.db, env.eventId);
    if (ev !== null) now = ev.receivedAt;
  } catch {
    // 回读失败按本次 now 返回。
  }
  return jsonResponse(200, { conflict, event_id: env.eventId, received_at: now });
}