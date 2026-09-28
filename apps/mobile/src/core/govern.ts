/**
 * 治理：提案列表（匿名读）、发起提案（签名写）、投票（签名写）。
 *
 * **薄封装、无本地状态**（本册 §4.2）：票数 / 门槛 / 状态一律来自当次响应，
 * 不缓存、不增量推算（#27 风险 3）。只依赖注入的 `Adapters` / `LocalRepo`，不 import 'uni'。
 */
import { utf8 } from '@base/protocol-ts';

import { CommentError, ensureRegistered, type CommentOptions } from './comment';
import { errorCodeOf, errorText } from './errors';
import { peekLocalIdentity, signRequestHeaders, type Identity } from './identity';
import { decodeUtf8 } from './sync';

/** 与 `core/comment.ts` 同一组依赖（同一套 `ensureRegistered`，本册不另立会话模块）。 */
export type GovernOptions = CommentOptions;

/** 三个受审动作（#27 §2.1）。 */
export type GovernAction = 'remove' | 'edit' | 'revive';

/** 提案状态三值（#27 §4.4）。 */
export type GovernStatus = 'pending' | 'effective' | 'void';

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

/** 带 5 个签名头 POST 一次（三个签名写路径共用；不解析响应）。 */
async function signedPost(
  o: GovernOptions,
  ident: Identity,
  path: string,
  bytes: Uint8Array,
  fallback: string,
): Promise<{ status: number; body: string }> {
  const headers = signRequestHeaders(ident, { method: 'POST', path, body: bytes });
  let res;
  try {
    res = await o.adapters.http.post(`${o.nodeBaseUrl}${path}`, bytes, {
      'Content-Type': 'application/json',
      ...headers,
    });
  } catch {
    throw new GovernError('network', '需要联网才能完成该操作');
  }
  const body = decodeUtf8(res.body);
  if (res.status >= 200 && res.status < 300) return { status: res.status, body };
  const code = errorCodeOf(body);
  if (res.status === 429) throw new GovernError('rate_limited', errorText(code, '操作过于频繁，请稍后再试'));
  if (res.status >= 500) throw new GovernError('server', `${fallback}（HTTP ${res.status}）`);
  throw new GovernError('rejected', errorText(code, `${fallback}（HTTP ${res.status}）`));
}

export interface CreateProposalInput {
  action: GovernAction;
  itemId: string;
  reason: string;
  /** 仅 `edit` 需要（#27 §3.1） */
  edit?: { title: string; bodyMd: string };
}

/** 发起提案。**不做本地资格预判**（本册 §2.3）：资格一律由服务端裁决。 */
export async function createProposal(o: GovernOptions, input: CreateProposalInput): Promise<{ proposalId: string }> {
  const ident = await ensureIdentity(o);
  const payload: Record<string, unknown> = { action: input.action, item_id: input.itemId, reason: input.reason };
  // 只有 edit 才带 edit 块（remove / revive 带了会被判 proposal_edit_invalid）
  if (input.action === 'edit') {
    payload.edit = { title: input.edit?.title ?? '', body_md: input.edit?.bodyMd ?? '' };
  }
  // 命中 201 Created（本计划的「已核实的环境事实」写了这一点）
  const r = await signedPost(o, ident, '/v1/proposal', utf8(JSON.stringify(payload)), '发起提案失败');
  const out = JSON.parse(r.body) as Record<string, unknown>;
  return { proposalId: String(out.proposal_id ?? '') };
}

export interface VoteResult {
  proposalId: string;
  voteCount: number;
  threshold: number;
  status: GovernStatus;
}

/** 投一票。达门槛当场生效，响应用来就地刷新那一条；调用方随后应重拉一次列表对齐（本册 §5.6）。 */
export async function vote(o: GovernOptions, proposalId: string): Promise<VoteResult> {
  const ident = await ensureIdentity(o);
  // 请求体可为空对象：节点侧「空体与 {} 等价」（#27 §3.2）
  const r = await signedPost(
    o,
    ident,
    `/v1/proposal/${encodeURIComponent(proposalId)}/vote`,
    utf8('{}'),
    '投票失败',
  );
  const out = JSON.parse(r.body) as Record<string, unknown>;
  return {
    proposalId: String(out.proposal_id ?? proposalId),
    voteCount: Number(out.vote_count ?? 0),
    threshold: Number(out.threshold ?? 0),
    status: String(out.status ?? 'pending') as GovernStatus,
  };
}