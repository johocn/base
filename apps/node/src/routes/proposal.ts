// 逐行对齐 internal/httpapi/govern.go 的三条签名治理路由：
// handleProposalPost（:124-278）/ handleVotePost（:288-345）/ handleProposalList（:373-405），
// 以及 proposalReq / proposalEditReq / proposalDirectoryReq 的解码形状（:97-120）与
// proposalDTO 的声明序（:347-365）。
//
// 判定顺序**原样保留**（含限速在查库之前、`||` 短路）：顺序影响限速令牌消耗与错误码优先级。
import type { ServerHandler, ServerResponse } from "@base/core-ts";
import type { Db } from "../db";
import {
  addVote,
  addVoteV2,
  AlreadyVotedError,
  createDirectoryProposal,
  createProposal,
  directoryPendingVotes,
  encodeTagLinks,
  findPendingDirectoryProposal,
  getDirectoryTerm,
  getItemRow,
} from "../store/govern";
import { getProposal } from "../store/governProjection";
import { type AuthedHandler, MAX_JSON_BODY, writeAuthErr } from "./authmw";
import {
  decodeStrict,
  jsonObjectField,
  listOf,
  opt,
  parseJSONDocument,
  type StrictSpec,
} from "./decode";
import {
  cleanDisplayName,
  DIRECTORY_SMALL_NODE_ROSTER_MAX,
  DIRECTORY_STATE_APPROVED,
  directoryPayloadHash,
  directoryProposalItemId,
  GOVERN_ACTION_DIRECTORY_ADD,
  GOVERN_STATUS_PENDING,
  governRoster,
  governThreshold,
  governThresholdForRoster,
  type IpLimiter,
  listProposalViews,
  normalizeTermKey,
  parseProposalId,
  trimGoSpace,
  validDirectoryKind,
  validItemTitle,
  validProposalAction,
  validProposalReason,
} from "./derived";
import { jsonResponse } from "./json";
import { MAX_SUBMIT_BYTES, normalizeSubmitTagLinks, type SubmitLink } from "./submit";

/** 客户端 IP 维度的退化单桶键（与 routes/submit.ts:60 同口径；ServerRequest 未暴露远端地址）。 */
const CLIENT_BUCKET_KEY = "";

/** proposalEditReq（govern.go:97-103）：BodyMD 用指针以区分「键缺失」与「空串」。 */
interface ProposalEditReq {
  title: string;
  body_md: string | null;
  links: SubmitLink[];
}

/** proposalDirectoryReq（govern.go:116-120）。 */
interface ProposalDirectoryReq {
  kind: string;
  term_key: string;
  display_name: string;
}

/**
 * proposalReq（govern.go:105-113）的字段规格：edit / directory 用 opt（Go 指针），
 * proposer_id / author_id 用 raw（出现即禁止，含 null）。
 */
const PROPOSAL_SPEC: StrictSpec = {
  action: "string",
  item_id: "string",
  reason: "string",
  edit: opt({
    title: "string",
    body_md: opt("string"),
    links: listOf({ target_id: "string", kind: "string" }),
  }),
  directory: opt({ kind: "string", term_key: "string", display_name: "string" }),
  proposer_id: "raw",
  author_id: "raw",
};

export interface ProposalDeps {
  db: Db;
  storeKey: Uint8Array | null;
  byID: IpLimiter;
  byIP: IpLimiter;
}

function errResponse(err: unknown): ServerResponse {
  return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
}

/**
 * handleProposalPost（govern.go:124-278）：名册内的治理者对**他人**条目发起
 * remove / edit / revive / directory_add 提案，签名即自动构成第 1 票。任何失败都不写入。
 */
export function proposalPostHandler(deps: ProposalDeps): AuthedHandler {
  return async (req, actor) => {
    const dec = decodeStrict(req, PROPOSAL_SPEC);
    if (!dec.ok) return dec.resp;
    const v = dec.value;
    // 提案人只能取自鉴权身份：请求体携带即等于替他人提案（册子 §3.1 硬约束）。
    if (v.proposer_id === true || v.author_id === true) {
      return writeAuthErr(400, "author_id_forbidden");
    }
    const action = v.action as string;
    if (!validProposalAction(action)) {
      return writeAuthErr(400, "proposal_action_unsupported");
    }
    // reason 可选（缺省空串）；但「已给定」却不合规要拒。
    const reasonRes = validProposalReason(v.reason as string);
    if ((v.reason as string) !== "" && !reasonRes.ok) {
      return writeAuthErr(400, "proposal_reason_invalid");
    }
    let title = "";
    let bodyMD = "";
    let linksJSON = "";
    const edit = v.edit as ProposalEditReq | null;
    // edit 的载荷**存在性**在此判定；载荷内容按载体系分流（在 GetItem 之后，册子 §3.5）。
    if (action === "edit" && edit === null) {
      return writeAuthErr(400, "proposal_edit_invalid");
    }
    if (!deps.byID.allow(actor) || !deps.byIP.allow(CLIENT_BUCKET_KEY)) {
      return writeAuthErr(429, "govern_rate_limited");
    }
    // directory_add 走独立载荷与同键归并，不要求目标条目存在、不要求名册内资格（册子 #58 §3.1/§3.3）。
    if (action === GOVERN_ACTION_DIRECTORY_ADD) {
      const directory = v.directory as ProposalDirectoryReq | null;
      if (edit !== null || directory === null || !validDirectoryKind(directory.kind)) {
        return writeAuthErr(400, "proposal_directory_invalid");
      }
      const termKey = normalizeTermKey(directory.display_name);
      const display = cleanDisplayName(directory.display_name);
      if (termKey === null || display === "" || directory.term_key !== termKey) {
        return writeAuthErr(400, "proposal_directory_invalid");
      }
      const itemId = directoryProposalItemId(directory.kind, termKey);
      // 同键归并（册子 #58 §3.3）：已 approved ⇒ 成功短路不建提案；已有 pending ⇒ 返回既有 id。
      let term: ReturnType<typeof getDirectoryTerm>;
      try {
        term = getDirectoryTerm(deps.db, directory.kind, termKey);
      } catch (err) {
        return errResponse(err);
      }
      if (term.ok && term.term.state === DIRECTORY_STATE_APPROVED) {
        // Go 是 map[string]any → 键按字典序：action, item_id, merged, status。
        return jsonResponse(200, { action, item_id: itemId, merged: true, status: "effective" });
      }
      const roster = governRoster(deps.db, deps.storeKey);
      let pending: ReturnType<typeof findPendingDirectoryProposal>;
      try {
        pending = findPendingDirectoryProposal(deps.db, itemId);
      } catch (err) {
        return errResponse(err);
      }
      if (pending.ok) {
        let votes: number;
        try {
          votes = directoryPendingVotes(deps.db, deps.storeKey, itemId, roster.set);
        } catch (err) {
          return errResponse(err);
        }
        // Go map 键按字典序：action, item_id, merged, proposal_id, status, threshold, vote_count。
        return jsonResponse(200, {
          action,
          item_id: itemId,
          merged: true,
          proposal_id: String(pending.pid),
          status: GOVERN_STATUS_PENDING,
          threshold: governThresholdForRoster(action, roster.set.size, roster.ok),
          vote_count: votes,
        });
      }
      // 小节点豁免（名册就绪且 < 10）⇒ 提交即 approved（册子 #58 §3.2）。
      const auto = roster.ok && roster.set.size < DIRECTORY_SMALL_NODE_ROSTER_MAX;
      let r: { id: number; status: string };
      try {
        r = createDirectoryProposal(
          deps.db,
          {
            action,
            itemId,
            proposerId: actor,
            reason: reasonRes.value,
            title: display,
            bodyMd: termKey,
            linksJson: "",
            baseContentHash: directoryPayloadHash(directory.kind, termKey),
            createdAt: Date.now(),
          },
          auto,
        );
      } catch (err) {
        return errResponse(err);
      }
      return jsonResponse(201, {
        action,
        item_id: itemId,
        proposal_id: String(r.id),
        status: r.status,
        threshold: governThresholdForRoster(action, roster.set.size, roster.ok),
        vote_count: 1,
      });
    }
    const itemId = v.item_id as string;
    let it: ReturnType<typeof getItemRow>;
    try {
      it = getItemRow(deps.db, itemId);
    } catch (err) {
      return errResponse(err);
    }
    if (it === null) {
      return writeAuthErr(404, "item_not_found");
    }
    // 自己改自己走第 2 册的签名写路径，不需要审批（册子 §2.2）。空归属条目可治。
    if (it.authorId !== "" && it.authorId === actor) {
      return writeAuthErr(403, "item_self_owned");
    }
    if (it.state !== (action === "revive" ? "removed" : "active")) {
      return writeAuthErr(400, "item_state_mismatch");
    }
    // edit 的载荷按载体系分流（#37 册子 §3.5）：article 走 title+body_md，tag 走 links[]。
    if (action === "edit") {
      const e = edit as ProposalEditReq;
      if (it.sqliteTable === "articles") {
        if (e.body_md === null || !validItemTitle(e.title)) {
          return writeAuthErr(400, "proposal_edit_invalid");
        }
        title = trimGoSpace(e.title);
        bodyMD = e.body_md;
        if (Buffer.byteLength(title, "utf8") + Buffer.byteLength(bodyMD, "utf8") > MAX_SUBMIT_BYTES) {
          return writeAuthErr(413, "proposal_too_large");
        }
      } else if (it.type === "tag") {
        // tag 型：title 由 item_id 重建故不收；body_md 不适用，给了即拒。
        const links = normalizeSubmitTagLinks(e.links);
        if (links === null || e.body_md !== null || trimGoSpace(e.title) !== "") {
          return writeAuthErr(400, "proposal_edit_invalid");
        }
        linksJSON = encodeTagLinks(links);
      } else {
        return writeAuthErr(400, "proposal_edit_invalid");
      }
    }
    const roster = governRoster(deps.db, deps.storeKey);
    if (roster.ok && !roster.set.has(actor)) {
      return writeAuthErr(403, "proposer_not_governor");
    }
    let id: number;
    try {
      id = createProposal(deps.db, {
        action,
        itemId,
        proposerId: actor,
        reason: reasonRes.value,
        title,
        bodyMd: bodyMD,
        linksJson: linksJSON,
        baseContentHash: it.contentHash,
        createdAt: Date.now(),
      });
    } catch (err) {
      return errResponse(err);
    }
    return jsonResponse(201, {
      action,
      item_id: itemId,
      proposal_id: String(id),
      status: GOVERN_STATUS_PENDING,
      threshold: governThreshold(action),
      vote_count: 1,
    });
  };
}

/**
 * handleVotePost（govern.go:288-345 + Spec v2 §4）：投票请求**可能带副作用**——这一票把有效票推到
 * 该动作门槛时，在同一事务内执行动作。
 * 请求体可带 vote_type('approve'|'reject') / vote_weight(1..10)；缺省 vote_type='approve' / vote_weight=1。
 */
export function proposalVoteHandler(deps: ProposalDeps): AuthedHandler {
  return async (req, actor) => {
    const raw = Buffer.from(req.body.subarray(0, MAX_JSON_BODY)).toString("utf8");
    // Go 用 bytes.TrimSpace（空白集与 JS `.trim()` 不同），故必须走 trimGoSpace。
    let voteType = "approve";
    let voteWeight = 1;
    if (trimGoSpace(raw) !== "") {
      const node = parseJSONDocument(raw);
      if (node === null) {
        return jsonResponse(400, { error: "bad_json" });
      }
      if (node.t !== "null") {
        if (node.t !== "obj") {
          return jsonResponse(400, { error: "bad_json" });
        }
        // 投票人只能取自鉴权身份：请求体携带任何身份字段都等于替他人投票。
        if (
          jsonObjectField(node, "voter_id") !== undefined ||
          jsonObjectField(node, "author_id") !== undefined ||
          jsonObjectField(node, "id") !== undefined
        ) {
          return writeAuthErr(400, "author_id_forbidden");
        }
        const vt = jsonObjectField(node, "vote_type");
        if (vt !== undefined) {
          if (vt.t !== "str" || typeof vt.v !== "string") {
            return jsonResponse(400, { error: "invalid_vote_type" });
          }
          const s = vt.v;
          if (s !== "approve" && s !== "reject") {
            return jsonResponse(400, { error: "invalid_vote_type" });
          }
          voteType = s;
        }
        const vw = jsonObjectField(node, "vote_weight");
        if (vw !== undefined) {
          let n: number;
          if (vw.t === "num") {
            n = parseInt(vw.raw, 10);
          } else if (vw.t === "str") {
            n = parseInt(vw.v, 10);
          } else {
            return jsonResponse(400, { error: "invalid_vote_weight" });
          }
          if (!Number.isFinite(n) || n < 1 || n > 10) {
            return jsonResponse(400, { error: "invalid_vote_weight" });
          }
          voteWeight = n | 0;
        }
      }
    }
    const pid = parseProposalId(req.params["proposal_id"] ?? "");
    if (pid === null) {
      return writeAuthErr(404, "proposal_not_found");
    }
    if (!deps.byID.allow(actor) || !deps.byIP.allow(CLIENT_BUCKET_KEY)) {
      return writeAuthErr(429, "govern_rate_limited");
    }
    let p: ReturnType<typeof getProposal>;
    try {
      p = getProposal(deps.db, pid);
    } catch (err) {
      return errResponse(err);
    }
    if (p === null) {
      return writeAuthErr(404, "proposal_not_found");
    }
    const roster = governRoster(deps.db, deps.storeKey);
    if (roster.ok && !roster.set.has(actor)) {
      return writeAuthErr(403, "voter_not_governor");
    }
    let res: ReturnType<typeof addVoteV2>;
    try {
      res = addVoteV2(deps.db, deps.storeKey, pid, actor, voteWeight, voteType);
    } catch (err) {
      if (err instanceof AlreadyVotedError) {
        return writeAuthErr(409, "already_voted");
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("quota_exceeded") || msg.startsWith("per_item_quota_exceeded")) {
        return writeAuthErr(429, msg);
      }
      return errResponse(err);
    }
    // VoteResultV2：proposal_id / voter_count / quorum / threshold / approve_weight / reject_weight / net_weight / status
    return jsonResponse(200, {
      proposal_id: String(res.proposalId),
      status: res.status,
      threshold: res.threshold,
      quorum: res.quorum,
      voter_count: res.voterCount,
      approve_weight: res.approveWeight,
      reject_weight: res.rejectWeight,
      net_weight: res.netWeight,
    });
  };
}

export interface ProposalListDeps {
  db: Db;
  storeKey: Uint8Array | null;
}

/**
 * handleProposalList（govern.go:373-405）：匿名返回全部提案与**当前有效票**；不分页、不过滤；
 * 空列表返回 []（不是 null）。元素键序严格等于 proposalDTO 的声明序。
 */
export function proposalListHandler(deps: ProposalListDeps): ServerHandler {
  return async () => {
    const roster = governRoster(deps.db, deps.storeKey); // 派生失败按空名册降级（忽略 ok）
    let views: ReturnType<typeof listProposalViews>;
    try {
      views = listProposalViews(deps.db, deps.storeKey, roster.set);
    } catch (err) {
      return errResponse(err);
    }
    const proposals = views.map((view) => ({
      proposal_id: String(view.proposalId),
      action: view.action,
      item_id: view.itemId,
      proposer_id: view.proposerId,
      reason: view.reason,
      title: view.title,
      body_md: view.bodyMd,
      status: view.status,
      votes: view.votes,
      vote_count: view.voterCount,
      threshold: view.threshold,
      quorum: view.quorum,
      approve_weight: view.approveWeight,
      reject_weight: view.rejectWeight,
      net_weight: view.netWeight,
      governance_level: view.governanceLevel,
      category: view.category,
      circle_id: view.circleId,
      created_at: view.createdAt,
      executed_at: view.executedAt,
      voided_at: view.voidedAt,
      content_version: view.contentVersion,
      revoked_rev: view.revokedRev,
    }));
    return jsonResponse(200, { proposals });
  };
}