/**
 * 评论：发一条（正文随事件内联，节点验签后落块）、读列表（投影索引）、取正文（按 payload_cid 取块）。
 *
 * 只依赖注入的 `Adapters` / `LocalRepo` 与 `core/identity`，不 import 'uni'，
 * 因此可在 Node 下用 `core/fakes.ts` 完整测试（与 core/sync.ts 同一约定）。
 */
import { bytesToHex, canonicalize, randomBytes, sign, utf8, type Json } from '@base/protocol-ts';

import type { Adapters } from './platform/adapter';
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
  likeCount: number;
}

export interface CommentList {
  items: CommentItem[];
  nextCursor: string | null;
}

export type CommentErrorCode = 'unregistered' | 'rate_limited' | 'revoked' | 'rejected' | 'network' | 'server' | 'client';

/** 一条评论的入参。`wire` / `eventId` 只在补发时传入（逐字节重放冻结的请求体，本册 §3.1）。 */
export interface CommentInput {
  targetId: string;
  text: string;
  replyTo?: string;
  wire?: string;
  eventId?: string;
}

/** `postComment` 的结果。`queued=true` 即已落本地待发队列（本册 §4.2）。 */
export interface PostResult {
  eventId: string;
  payloadCid: string | null;
  queued: boolean;
}

/** `flushPending` 的结果。**只经返回值体现，绝不抛错**（本册 §4.3）。 */
export interface FlushResult {
  sent: number;
  failed: number;
  remaining: number;
  error: string;
}

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
 * 把本地步骤（存储 / 随机数 / 签名）的裸错误包成带原因的可读错误。
 * 不包的话页面只能显示通用文案，真机上出了问题等于没有线索。
 */
function localStep<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new CommentError('client', `${what}失败：${(e as Error).message ?? String(e)}`);
  }
}

async function localStepAsync<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new CommentError('client', `${what}失败：${(e as Error).message ?? String(e)}`);
  }
}

/**
 * 本地身份存在但节点侧未登记时补登记一次（匿名请求，无签名头）。
 * 失败不阻断阅读，只让评论功能不可用。
 */
export async function ensureRegistered(o: CommentOptions): Promise<Identity> {
  const ident = await localStepAsync('身份准备', () => localIdentity(o));
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
    likeCount: Number(c.like_count ?? 0),
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

/**
 * 本地构造一条评论事件：`event_id` / `created_at` / 内容签名都在这里冻结。
 * `sig` 覆盖 `canonical({event_id,type,created_at,body})`，与请求头无关：事件搬到别的节点仍可独立验签。
 */
function buildCommentWire(ident: Identity, input: CommentInput): { eventId: string; wire: string } {
  const eventId = bytesToHex(randomBytes(16));
  const inner: Json = { target_id: input.targetId, text: input.text };
  if (input.replyTo) (inner as Record<string, Json>).reply_to = input.replyTo;
  const payload: Json = { event_id: eventId, type: 'comment.v1', created_at: Date.now(), body: inner };
  const sig = sign(ident.seedHex, utf8(canonicalize(payload)));
  return { eventId, wire: JSON.stringify({ ...(payload as Record<string, Json>), sig }) };
}

/**
 * 直接发送一条评论：登记 →（构造）→ 带签名头 POST `/v1/event`。失败抛 `CommentError`，**不落本地队列**。
 *
 * 传 `input.wire` 即逐字节重放该请求体（补发路径）：内容签名与 `event_id` 冻结在 wire 内，
 * 请求签名头每轮新算（`ts` 本就一次性、`nonce` 会被节点去重）。
 * 本函数是**补发与自检探针共用的唯一发送入口**。
 */
export async function sendComment(
  o: CommentOptions,
  input: CommentInput,
): Promise<{ eventId: string; payloadCid: string }> {
  const ident = await ensureRegistered(o);

  let eventId: string;
  let wire: string;
  if (input.wire !== undefined && input.eventId !== undefined) {
    eventId = input.eventId;
    wire = input.wire;
  } else {
    const built = localStep('构造请求', () => buildCommentWire(ident, input));
    eventId = built.eventId;
    wire = built.wire;
  }

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
    throw new CommentError('network', '无法连接节点，请稍后重试');
  }
  if (res.status === 200) {
    const out = localStep('解析响应', () => JSON.parse(decodeUtf8(res.body)) as { event_id?: string; payload_cid?: string });
    return { eventId: String(out.event_id ?? eventId), payloadCid: String(out.payload_cid ?? '') };
  }
  throw mapPostFailure(res.status, decodeUtf8(res.body));
}

/**
 * 发表一条评论：正常走 `sendComment`；**只有网络不可达**才入本地待发队列（本册 §4.2）。
 *
 * 节点给了任何 HTTP 响应（4xx / 5xx）都不入队——用户就在页面上、草稿还在输入框里，
 * 立即原地重试比静默入队清楚。未配置节点同样不入队（否则队列会变成永远发不出去的垃圾桶）。
 */
export async function postComment(o: CommentOptions, input: CommentInput): Promise<PostResult> {
  if (o.nodeBaseUrl === '') throw new CommentError('client', '未配置节点地址，无法发表');

  try {
    const r = await sendComment(o, input);
    return { eventId: r.eventId, payloadCid: r.payloadCid, queued: false };
  } catch (e) {
    if (e instanceof CommentError && e.code === 'network') {
      // 身份生成本地可用、不需要节点，故断网时仍能冻结一条合法 wire 入队
      const ident = await localStepAsync('身份准备', () => localIdentity(o));
      const { eventId, wire } = localStep('构造请求', () => buildCommentWire(ident, input));
      await o.repo.enqueueComment({
        eventId,
        targetId: input.targetId,
        text: input.text,
        replyTo: input.replyTo ?? null,
        wire,
        state: 'pending',
        reason: null,
        queuedAt: new Date().toISOString(),
      });
      return { eventId, payloadCid: null, queued: true };
    }
    throw e;
  }
}

/** 永久失败：节点明确拒绝，重发无意义（本册 §5.2）。 */
function isPermanentFailure(e: unknown): boolean {
  return e instanceof CommentError && (e.code === 'revoked' || e.code === 'rejected');
}

/** 进行中的补发：并发调用复用同一轮（进页面与「立即补发」可能撞在一起）。 */
let inflightFlush: Promise<FlushResult> | null = null;

/**
 * 补发待发队列。**不抛错**：结果只经返回值体现，绝不打断调用方（上上册 §6.4 红线）。
 *
 * 逐条顺序补发；**暂时失败即中止本轮**——网络刚断或已被限速时后续条目必然同错，
 * 中止省掉一串无用请求，下次进页面继续。已 `failed` 的行永不自动重试，只能由用户删除。
 * **不读能力标志**：`writeOk` 只由用户主动跑自检更新，用它拦补发会让「节点已恢复但标志过期」永久卡死。
 */
export function flushPending(o: CommentOptions): Promise<FlushResult> {
  if (o.nodeBaseUrl === '') return Promise.resolve({ sent: 0, failed: 0, remaining: 0, error: '' });
  if (!inflightFlush) {
    inflightFlush = (async () => {
      try {
        return await runFlush(o);
      } finally {
        inflightFlush = null;
      }
    })();
  }
  return inflightFlush;
}

async function runFlush(o: CommentOptions): Promise<FlushResult> {
  const rows = (await o.repo.listCommentOut()).filter((r) => r.state === 'pending');
  let sent = 0;
  let failed = 0;
  let remaining = 0;
  let error = '';
  for (const row of rows) {
    try {
      await sendComment(o, {
        targetId: row.targetId,
        text: row.text,
        replyTo: row.replyTo ?? undefined,
        wire: row.wire,
        eventId: row.eventId,
      });
      await o.repo.removeCommentOut(row.eventId);
      sent += 1;
    } catch (e) {
      const msg = e instanceof CommentError ? e.message : `补发失败：${(e as Error).message ?? String(e)}`;
      if (isPermanentFailure(e)) {
        await o.repo.markCommentOutFailed(row.eventId, msg);
        failed += 1;
      } else {
        remaining += 1;
        error = msg;
        break;
      }
    }
  }
  return { sent, failed, remaining, error };
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