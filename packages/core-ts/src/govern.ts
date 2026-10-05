/**
 * 治理：提案列表（匿名读）、发起提案与投票（签名写，走原生 `govern.v1` 事件）。
 *
 * **薄封装、无本地状态**（本册 §4.2）：票数 / 门槛 / 状态一律来自当次读接口，
 * 不缓存、不增量推算（#27 风险 3）。写路径产 `govern.v1` 事件（`POST /v1/event`，内容签名），
 * 承担跨节点传播；老路径 `POST /v1/proposal` 仍服务未升级的客户端、行为不变（册子 §4.4）。
 * 只依赖注入的 `Adapters` / `LocalRepo`，不 import 'uni'。
 */
import { bytesToHex, canonicalize, randomBytes, sha256Hex, sign, utf8, type Json } from '@base/protocol-ts';

import { CommentError, ensureRegistered, type CommentOptions } from './comment';
import { errorCodeOf, errorText } from './errors';
import { peekLocalIdentity, signRequestHeaders, type Identity } from './identity';
import { decodeUtf8 } from './sync';

/** 与 `core/comment.ts` 同一组依赖（同一套 `ensureRegistered`，本册不另立会话模块）。 */
export type GovernOptions = CommentOptions;

/** `govern.v1` 事件类型（册子 §4.2）。 */
const GOVERN_EVENT_TYPE = 'govern.v1';

/** 提案撞号（conflict）时的重取重发上限：重取最大 id 再发，避免会话内无限循环。 */
const PROPOSAL_CONFLICT_ATTEMPTS = 3;

/** 受审动作（#27 §2.1）+ 词条补录 `directory_add`（#58 §3.1）+ Spec v2 扩 12 种。 */
export type GovernAction =
  | 'remove'
  | 'edit'
  | 'revive'
  | 'directory_add'
  | 'edit_title'
  | 'edit_body'
  | 'edit_category'
  | 'edit_tags'
  | 'edit_instructor'
  | 'highlight'
  | 'pin'
  | 'recommend'
  | 'feature';

/** 提案状态三值（#27 §4.4）。 */
export type GovernStatus = 'pending' | 'effective' | 'void';

/** 投票类型（Spec v2 §4）。 */
export type VoteType = 'approve' | 'reject';

export interface ProposalItem {
  /** 十进制整数字符串，与节点侧同一 id */
  proposalId: string;
  action: GovernAction;
  itemId: string;
  proposerId: string;
  reason: string;
  /** 仅 `edit` 提案非空 */
  title: string;
  /** 仅 `edit` 提案非空 */
  bodyMd: string;
  status: GovernStatus;
  /** 当前有效票的投票人 id（已按名册实时复判） */
  votes: string[];
  voteCount: number;
  threshold: number;
  createdAt: number;
  executedAt: number;
  voidedAt: number;
  /** 提案快照水位（#33 §4.3）：票权按此判定，名册中途变化不改判。 */
  contentVersion: number;
  revokedRev: number;
  /** Spec v2：治理门槛档位 'base'|'enhanced'（缺省 'base'） */
  governanceLevel?: string;
  /** Spec v2：提案目标所属分类（缺省 ''） */
  category?: string;
  /** Spec v2：提案目标所属圈（缺省 ''） */
  circleId?: string;
  /** Spec v2 两阶段：独立 voter 数（V2 管线里所有人都算，不再按名册过滤） */
  voterCount?: number;
  /** Spec v2 两阶段：法定人数（GovernQuorum） */
  quorum?: number;
  /** Spec v2：赞成票权 SUM(vote_weight WHERE vote_type='approve') */
  approveWeight?: number;
  /** Spec v2：反对票权 SUM(vote_weight WHERE vote_type='reject') */
  rejectWeight?: number;
  /** Spec v2：净票权 = approveWeight - rejectWeight；>0 才 effective，<=0 void */
  netWeight?: number;
}

export class GovernError extends Error {
  constructor(
    readonly code: 'network' | 'rejected' | 'rate_limited' | 'server' | 'client',
    message: string,
  ) {
    super(message);
    this.name = 'GovernError';
  }
}

/** 本机身份 id（不联网、不生成）；无身份返回空串。只用于「已投 / 名册内」的展示判定（本册 §2.3）。 */
export async function myIdentityId(o: GovernOptions): Promise<string> {
  try {
    const ident = await peekLocalIdentity(o.adapters.storage);
    return ident?.id ?? '';
  } catch {
    return '';
  }
}

function toProposalItem(p: Record<string, unknown>): ProposalItem {
  return {
    proposalId: String(p.proposal_id ?? ''),
    action: String(p.action ?? 'remove') as GovernAction,
    itemId: String(p.item_id ?? ''),
    proposerId: String(p.proposer_id ?? ''),
    reason: String(p.reason ?? ''),
    title: String(p.title ?? ''),
    bodyMd: String(p.body_md ?? ''),
    status: String(p.status ?? 'pending') as GovernStatus,
    votes: Array.isArray(p.votes) ? p.votes.map((v) => String(v)) : [],
    voteCount: Number(p.vote_count ?? 0),
    threshold: Number(p.threshold ?? 0),
    createdAt: Number(p.created_at ?? 0),
    executedAt: Number(p.executed_at ?? 0),
    voidedAt: Number(p.voided_at ?? 0),
    contentVersion: Number(p.content_version ?? 0),
    revokedRev: Number(p.revoked_rev ?? 0),
    governanceLevel: String(p.governance_level ?? 'base'),
    category: String(p.category ?? ''),
    circleId: String(p.circle_id ?? ''),
    voterCount: Number(p.vote_count ?? 0),
    quorum: Number(p.quorum ?? 0),
    approveWeight: Number(p.approve_weight ?? 0),
    rejectWeight: Number(p.reject_weight ?? 0),
    netWeight: Number(p.net_weight ?? 0),
  };
}

/**
 * 拉提案列表。接口按 `proposal_id` 升序（旧 → 新）返回；这里只做**纯展示反转**（新提案在前），
 * 除此之外不排序、不派生任何字段（本册 §5.6）。
 */
export async function listProposals(o: GovernOptions): Promise<ProposalItem[]> {
  let res;
  try {
    res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/proposal`);
  } catch {
    throw new GovernError('network', '需要联网才能查看提案');
  }
  if (res.status !== 200) throw new GovernError('server', `读取提案失败（HTTP ${res.status}）`);
  const page = JSON.parse(decodeUtf8(res.body)) as { proposals?: Array<Record<string, unknown>> };
  return (page.proposals ?? []).map(toProposalItem).reverse();
}

/** 身份准备；`CommentError` 统一换成 `GovernError`，页面只处理一种错误类型。 */
async function ensureIdentity(o: GovernOptions): Promise<Identity> {
  try {
    return await ensureRegistered(o);
  } catch (e) {
    if (e instanceof CommentError) {
      throw new GovernError(e.code === 'network' ? 'network' : 'rejected', e.message);
    }
    throw new GovernError('client', `身份准备失败：${(e as Error).message ?? String(e)}`);
  }
}

/**
 * 把本地步骤（编码 / 签名）的裸错误包成带原因的可读错误。
 * 与 `core/comment.ts` 的 `localStep` 同口径，但抛 `GovernError`（本模块只暴露一种错误类型）。
 */
function localStep<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new GovernError('client', `${what}失败：${(e as Error).message ?? String(e)}`);
  }
}

/**
 * 构造并投递一条 `govern.v1` 事件。内容签名覆盖 `canonical({event_id, type, created_at, body})`
 * （与 `core/wire.ts` 的 `buildEventWire` 逐字同构），**且必须再带 5 个请求签名头**——
 * 节点 `authenticate` 第一步即判缺头（400 `auth_missing_header`），与事件内容签名无关（本册 §1）。
 * `event_id` 用 `randomBytes(16)` 保证幂等（同 id 重发由节点投影判重放、不报冲突）。
 * 返回节点的 `conflict` 标记：true = 同 `proposal_id` 已被更早的 `(created_at, event_id)` 占位。
 */
async function postGovernEvent(o: GovernOptions, ident: Identity, body: Json): Promise<{ conflict: boolean }> {
  const eventId = bytesToHex(randomBytes(16));
  const payload: Json = { event_id: eventId, type: GOVERN_EVENT_TYPE, created_at: Date.now(), body };
  const sig = sign(ident.seedHex, utf8(canonicalize(payload)));
  const wire = JSON.stringify({ ...(payload as Record<string, Json>), sig });
  const bytes = localStep('编码请求', () => utf8(wire));
  const headers = localStep('签名请求', () =>
    signRequestHeaders(ident, { method: 'POST', path: '/v1/event', body: bytes }),
  );
  let res;
  try {
    res = await o.adapters.http.post(`${o.nodeBaseUrl}/v1/event`, bytes, {
      'Content-Type': 'application/json',
      ...headers,
    });
  } catch {
    throw new GovernError('network', '需要联网才能完成该操作');
  }
  if (res.status >= 200 && res.status < 300) {
    let conflict = false;
    try {
      conflict = (JSON.parse(decodeUtf8(res.body)) as { conflict?: boolean }).conflict === true;
    } catch {
      conflict = false; // 200 但体不可解析：按「无冲突」处理，对齐以随后的重拉为准
    }
    return { conflict };
  }
  const code = errorCodeOf(decodeUtf8(res.body));
  if (res.status === 429) throw new GovernError('rate_limited', errorText(code, '操作过于频繁，请稍后再试'));
  if (res.status >= 500) throw new GovernError('server', `治理事件投递失败（HTTP ${res.status}）`);
  throw new GovernError('rejected', errorText(code, `治理事件投递失败（HTTP ${res.status}）`));
}

/**
 * 提案快照水位（#33 §4.3）：事件权威化后，水位由**客户端**在提案建立时钉进事件体——
 * `content_version` 取本地已同步的内容包版本，`revoked_rev` 取本地墓碑的最大退役序号（当前退役态）。
 * 之后名册/内容变化不改判既有提案。
 */
async function snapshotWatermark(o: GovernOptions): Promise<{ contentVersion: number; revokedRev: number }> {
  const raw = Number((await o.repo.getConfig('content_version')) ?? '0');
  const contentVersion = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
  const revokedRev = (await o.repo.listTombstones()).reduce((m, t) => Math.max(m, t.revokedRev), 0);
  return { contentVersion, revokedRev };
}

export interface CreateProposalInput {
  action: GovernAction;
  /** 仅非 `directory_add` 需要（词条无对应内容条目） */
  itemId: string;
  reason: string;
  /** 仅 `edit` 需要（#27 §3.1） */
  edit?: { title: string; bodyMd: string };
  /** 仅 `directory_add` 需要（#58 §3.1）：kind ∈ category/instructor/tag，termKey 必须等于 NormalizeTermKey(displayName) */
  directory?: { kind: string; termKey: string; displayName: string };
}

/** `directory_add` 的条目 id 与载荷哈希同源派生（#58 §3.1，与节点侧逐字节同构）。 */
function directoryDigest(kind: string, termKey: string): string {
  return sha256Hex(utf8(`dir\x00${kind}\x00${termKey}`));
}

/**
 * 发起提案。**不做本地资格预判**（本册 §2.3）：资格一律由节点裁决。
 * `proposal_id` 由客户端取「当前最大 id + 1」（事件是权威来源，节点不再自增）；
 * 撞号时节点以 `(created_at, event_id)` 首者胜，客户端据 200 体的 `conflict` 重取重发（补充 20）。
 */
export async function createProposal(o: GovernOptions, input: CreateProposalInput): Promise<{ proposalId: string }> {
  const ident = await ensureIdentity(o);
  // directory_add 无对应内容条目：跳过本地内容哈希前置，改用派生载荷哈希与派生 item_id（#58 §3.1）。
  let dir: { kind: string; termKey: string; displayName: string; targetItemId: string } | null = null;
  let contentHash = '';
  if (input.action === 'directory_add') {
    if (!input.directory) throw new GovernError('client', '缺少词条信息（kind / termKey / displayName）');
    const digest = directoryDigest(input.directory.kind, input.directory.termKey);
    dir = {
      kind: input.directory.kind,
      termKey: input.directory.termKey,
      displayName: input.directory.displayName,
      targetItemId: `dir/${input.directory.kind}/${digest.slice(0, 16)}`,
    };
    contentHash = digest;
  } else {
    const item = await o.repo.getItem(input.itemId);
    contentHash = item?.contentHash ?? '';
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(contentHash)) {
      throw new GovernError('client', '本地缺少该条目的内容哈希，请同步后再试');
    }
    dir = null;
  }
  const { contentVersion, revokedRev } = await snapshotWatermark(o);
  for (let attempt = 0; attempt < PROPOSAL_CONFLICT_ATTEMPTS; attempt++) {
    const existing = await listProposals(o);
    const proposalId = existing.reduce((m, p) => Math.max(m, Number(p.proposalId) || 0), 0) + 1;
    const body: Record<string, Json> = {
      action: 'proposal',
      proposal_id: proposalId,
      target_item_id: dir ? dir.targetItemId : input.itemId,
      verb: input.action,
      content_hash: contentHash,
      content_version: contentVersion,
      revoked_rev: revokedRev,
    };
    // 空的 reason 不能下发：节点对「已给定」的 reason 走 1..200 校验，空串会被拒（#27 §3.1）
    if (input.reason !== '') body.reason = input.reason;
    // 只有 edit 才带 title / body_md（remove / revive 带了会被判键集非法）
    if (input.action === 'edit') {
      body.title = input.edit?.title ?? '';
      body.body_md = input.edit?.bodyMd ?? '';
    }
    // 词条三键：与 title / body_md 互斥（目录动作混带即整条被拒）
    if (dir) {
      body.directory_kind = dir.kind;
      body.directory_term_key = dir.termKey;
      body.directory_display_name = dir.displayName;
    }
    const { conflict } = await postGovernEvent(o, ident, body);
    if (!conflict) return { proposalId: String(proposalId) };
  }
  throw new GovernError('rejected', '提案编号冲突，请重试');
}

export interface VoteResult {
  proposalId: string;
  status: GovernStatus;
  /** Spec v2 两阶段管线字段（旧节点可能缺） */
  threshold?: number;
  quorum?: number;
  voterCount?: number;
  approveWeight?: number;
  rejectWeight?: number;
  netWeight?: number;
}

export interface VoteOptions {
  voteType?: VoteType;
  voteWeight?: number;
}

/**
 * 投一票。Spec v2 两阶段管线：voteType ∈ approve|reject，voteWeight ∈ [1,10]。
 * 事件体 choice 仍传 'yes'（govern.v1 事件不区分 approve/reject，全按 approve 算）。
 * 写后重拉提案列表返回当次快照（本册 §5.6）。
 */
export async function vote(
  o: GovernOptions,
  proposalId: string,
  opts?: VoteOptions,
): Promise<VoteResult> {
  const ident = await ensureIdentity(o);
  await postGovernEvent(o, ident, { action: 'vote', proposal_id: Number(proposalId), choice: 'yes' });
  const fresh = (await listProposals(o)).find((p) => p.proposalId === proposalId);
  return {
    proposalId,
    status: fresh?.status ?? 'pending',
    threshold: fresh?.threshold ?? 0,
  };
}