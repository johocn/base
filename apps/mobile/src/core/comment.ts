/**
 * 评论：发一条（正文随事件内联，节点验签后落块）、读列表（投影索引）、取正文（按 payload_cid 取块）。
 *
 * 只依赖注入的 `Adapters` / `LocalRepo` 与 `core/identity`，不 import 'uni'，
 * 因此可在 Node 下用 `core/fakes.ts` 完整测试（与 core/sync.ts 同一约定）。
 */
import { bytesToHex, canonicalize, randomBytes, sign, utf8, type Json } from '@base/protocol-ts';

import type { Adapters } from '../platform/adapter';
import type { LocalRepo } from './repo';
import {
  createIdentity,
  deviceKek,
  loadLocalIdentity,
  saveLocalIdentity,
  signRequestHeaders,
  type Identity,
} from './identity';
import { decodeUtf8 } from './sync';

/** 节点侧已登记公钥的本地标记（册子 §6.1）。 */
export const IDENTITY_REGISTERED_KEY = 'identity.registered';

export interface CommentOptions {
  adapters: Adapters;
  repo: LocalRepo;
  /** 节点根地址，如 https://node.example.com（无尾斜杠） */
  nodeBaseUrl: string;
}

export interface CommentItem {
  eventId: string;
  actor: string;
  targetId: string;
  payloadCid: string;
  replyTo: string | null;
  createdAt: number;
}

export interface CommentList {
  items: CommentItem[];
  nextCursor: string | null;
}

export type CommentErrorCode = 'unregistered' | 'rate_limited' | 'revoked' | 'rejected' | 'network' | 'server';

/** 发表/读取失败的用户可读错误（册子 §6.4 的映射结果）。 */
export class CommentError extends Error {
  constructor(
    readonly code: CommentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CommentError';
  }
}

/** 取本地身份；首次使用就生成并落盘（无需注册、无需联网，册子 §2.2）。 */
async function localIdentity(o: CommentOptions): Promise<Identity> {
  const kek = await deviceKek(o.adapters.storage);
  const existing = await loadLocalIdentity(o.adapters.storage, kek);
  if (existing) return existing;
  const ident = createIdentity();
  await saveLocalIdentity(o.adapters.storage, ident, kek, 'device');
  return ident;
}

/**
 * 本地身份存在但节点侧未登记时补登记一次（匿名请求，无签名头）。
 * 失败不阻断阅读，只让评论功能不可用。
 */
export async function ensureRegistered(o: CommentOptions): Promise<Identity> {
  const ident = await localIdentity(o);
  if ((await o.repo.getConfig(IDENTITY_REGISTERED_KEY)) === '1') return ident;
  const body = utf8(JSON.stringify({ id: ident.id, alg: ident.alg, pubkey: ident.pubHex }));
  let res;
  try {
    res = await o.adapters.http.post(`${o.nodeBaseUrl}/v1/identity/register`, body, {
      'Content-Type': 'application/json',
    });
  } catch {
    throw new CommentError('network', '无法连接节点，请稍后重试');
  }
  if (res.status !== 200) throw new CommentError('unregistered', '身份未就绪，请重试');
  await o.repo.setConfig(IDENTITY_REGISTERED_KEY, '1');
  return ident;
}

/** 分页读评论索引（`targetId` 为空 = 全站最新）。 */
export async function listComments(
  o: CommentOptions,
  opts: { targetId?: string; cursor?: string | null } = {},
): Promise<CommentList> {
  // 手拼查询串：老 WebView 没有 URLSearchParams（与 core/sync.ts 同一原因）
  const q: string[] = [];
  if (opts.targetId) q.push(`target_id=${encodeURIComponent(opts.targetId)}`);
  if (opts.cursor) q.push(`cursor=${encodeURIComponent(opts.cursor)}`);
  const qs = q.join('&');
  let res;
  try {
    res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/comment${qs ? `?${qs}` : ''}`);
  } catch {
    throw new CommentError('network', '无法连接节点，请稍后重试');
  }
  if (res.status !== 200) throw new CommentError('server', `读取评论失败（HTTP ${res.status}）`);
  const page = JSON.parse(decodeUtf8(res.body)) as {
    comments?: Array<Record<string, unknown>>;
    next_cursor?: string | null;
  };
  const items = (page.comments ?? []).map((c) => ({
    eventId: String(c.event_id ?? ''),
    actor: String(c.actor ?? ''),
    targetId: String(c.target_id ?? ''),
    payloadCid: String(c.payload_cid ?? ''),
    replyTo: c.reply_to === null || c.reply_to === undefined ? null : String(c.reply_to),
    createdAt: Number(c.created_at ?? 0),
  }));
  return { items, nextCursor: page.next_cursor ?? null };
}

/** 取正文；失败返回 null，由调用方降级为「正文暂不可用」，不让一条坏数据打断整页。 */
export async function fetchCommentText(o: CommentOptions, payloadCid: string): Promise<string | null> {
  try {
    const res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/blob/${payloadCid}`);
    if (res.status !== 200) return null;
    return decodeUtf8(res.body);
  } catch {
    return null;
  }
}

/** 发表一条评论：内容签名（归属）+ 请求签名头（准入）都要带。 */
export async function postComment(
  o: CommentOptions,
  input: { targetId: string; text: string; replyTo?: string },
): Promise<{ eventId: string; payloadCid: string }> {
  const ident = await ensureRegistered(o);

  const inner: Json = { target_id: input.targetId, text: input.text };
  if (input.replyTo) (inner as Record<string, Json>).reply_to = input.replyTo;
  const eventId = bytesToHex(randomBytes(16));
  const payload: Json = {
    event_id: eventId,
    type: 'comment.v1',
    created_at: Date.now(),
    body: inner,
  };
  // sig 覆盖 canonical({event_id,type,created_at,body})，与请求头无关：事件搬到别的节点仍可独立验签。
  const sig = sign(ident.seedHex, utf8(canonicalize(payload)));
  const wire = utf8(JSON.stringify({ ...(payload as Record<string, Json>), sig }));
  const headers = signRequestHeaders(ident, { method: 'POST', path: '/v1/event', body: wire });

  let res;
  try {
    res = await o.adapters.http.post(`${o.nodeBaseUrl}/v1/event`, wire, {
      'Content-Type': 'application/json',
      ...headers,
    });
  } catch {
    throw new CommentError('network', '无法连接节点，请稍后重试');
  }
  if (res.status === 200) {
    const out = JSON.parse(decodeUtf8(res.body)) as { event_id?: string; payload_cid?: string };
    return { eventId: String(out.event_id ?? eventId), payloadCid: String(out.payload_cid ?? '') };
  }
  throw mapPostFailure(res.status, decodeUtf8(res.body));
}

/** 节点错误码 → 用户可读提示（册子 §6.4）。 */
function mapPostFailure(status: number, raw: string): CommentError {
  let code = '';
  try {
    const body = JSON.parse(raw) as { code?: string; error?: string };
    code = body.code ?? body.error ?? '';
  } catch {
    code = '';
  }
  switch (code) {
    case 'identity_unregistered':
      return new CommentError('unregistered', '身份未就绪，请重试');
    case 'event_rate_limited':
      return new CommentError('rate_limited', '发言过于频繁');
    case 'event_revoked':
      return new CommentError('revoked', '该评论已被处理');
    case 'event_sig_invalid':
    case 'event_param_invalid':
    case 'event_type_unknown':
      return new CommentError('rejected', '提交被拒绝');
    default:
      return new CommentError('server', `提交失败（HTTP ${status}）`);
  }
}

/** 文章页 → 评论 tab 的锚定态。tab 页不能带 query，只能走模块级状态（册子 §6.2）。 */
let pendingTarget: string | null = null;

export function setPendingTarget(targetId: string): void {
  pendingTarget = targetId;
}

/** 消费并清空锚定态；无则返回 null。 */
export function takePendingTarget(): string | null {
  const t = pendingTarget;
  pendingTarget = null;
  return t;
}