/**
 * 点赞/举报（#79 §7）：无正文的轻事件，仅在线发送；离线由调用方 toast，不入 comment_out。
 * 复用 comment 管线：ensureRegistered → 构造（event_id/created_at/内容签名冻结）→ 签名头 POST /v1/event。
 */
import { bytesToHex, canonicalize, randomBytes, sign, utf8, type Json } from '@base/protocol-ts';

import type { Adapters } from './platform/adapter';
import type { LocalRepo } from './repo';
import { ensureRegistered } from './comment';
import { signRequestHeaders, type Identity } from './identity';
import { decodeUtf8 } from './sync';

export type LikeAction = 'like' | 'unlike';
export type ReportReason = 'spam' | 'abuse' | 'illegal' | 'other';

export interface LikeOptions {
  adapters: Adapters;
  repo: LocalRepo;
  nodeBaseUrl: string;
}

export class LikeError extends Error {
  constructor(readonly code: 'target_gone' | 'target_missing' | 'rate_limited' | 'network' | 'server' | 'client', message: string) {
    super(message);
    this.name = 'LikeError';
  }
}

function buildWire(
  ident: Identity, type: 'like.v1' | 'report.v1',
  body: Record<string, Json>,
): { eventId: string; wire: string } {
  const eventId = bytesToHex(randomBytes(16));
  const payload: Json = { event_id: eventId, type, created_at: Date.now(), body };
  const sig = sign(ident.seedHex, utf8(canonicalize(payload)));
  return { eventId, wire: JSON.stringify({ ...(payload as Record<string, Json>), sig }) };
}

async function sendLikeReport(
  o: LikeOptions, type: 'like.v1' | 'report.v1', body: Record<string, Json>,
): Promise<{ eventId: string }> {
  if (o.nodeBaseUrl === '') throw new LikeError('client', '未配置节点地址');
  const ident = await ensureRegistered(o);
  const { eventId, wire } = buildWire(ident, type, body);
  const bytes = utf8(wire);
  const headers = signRequestHeaders(ident, { method: 'POST', path: '/v1/event', body: bytes });
  let res;
  try {
    res = await o.adapters.http.post(`${o.nodeBaseUrl}/v1/event`, bytes, {
      'Content-Type': 'application/json', ...headers,
    });
  } catch {
    throw new LikeError('network', '无法连接节点，请稍后重试');
  }
  if (res.status === 200) {
    const out = JSON.parse(decodeUtf8(res.body)) as { event_id?: string };
    return { eventId: String(out.event_id ?? eventId) };
  }
  throw mapLikeFailure(res.status, decodeUtf8(res.body));
}

function mapLikeFailure(status: number, raw: string): LikeError {
  let code = '';
  try {
    code = ((JSON.parse(raw) as { error?: string }).error) ?? '';
  } catch { code = ''; }
  switch (code) {
    case 'target_not_found': return new LikeError('target_missing', '目标不存在或已下架');
    case 'target_gone': return new LikeError('target_gone', '该内容已被处理');
    case 'event_rate_limited': return new LikeError('rate_limited', '操作过于频繁，请稍后再试');
    default: return new LikeError('server', `提交失败（HTTP ${status}）`);
  }
}

/** 点赞/取消（评论 target=16hex 或条目 item_id；在线成功后由调用方写 like_out + 乐观计数）。 */
export function sendLike(o: LikeOptions, targetId: string, action: LikeAction) {
  return sendLikeReport(o, 'like.v1', { target_id: targetId, action });
}

/** 举报评论（target 仅 16hex；重复举报服务端不拒，计数去重）。 */
export function sendReport(o: LikeOptions, targetId: string, reason: ReportReason) {
  return sendLikeReport(o, 'report.v1', { target_id: targetId, reason });
}

/** 我的点赞台账：高亮态唯一来源（服务端不提供 liked_by_me）。 */
export async function myLike(o: LikeOptions, targetId: string): Promise<boolean> {
  return (await o.repo.getLikeOut(targetId)) === 'like';
}
