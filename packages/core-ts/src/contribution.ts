/**
 * 我的贡献：昵称写入（签名写）与名册读取（匿名读）。
 *
 * 薄封装（本册 §4.2）。名册与昵称**不做跨节点同步**（#23 已定）。
 * 只依赖注入的 `Adapters` / `LocalRepo`，不 import 'uni'。
 */
import { utf8 } from '@base/protocol-ts';

import { CommentError, ensureRegistered, type CommentOptions } from './comment';
import { errorCodeOf, errorText } from './errors';
import { peekLocalIdentity, signRequestHeaders, type Identity } from './identity';
import { decodeUtf8 } from './sync';

/** 与 `core/comment.ts` 同一组依赖（同一套 `ensureRegistered`，本册不另立会话模块）。 */
export type ContributionOptions = CommentOptions;

export interface ContributorItem {
  id: string;
  /** 缺昵称时节点已回退成 `id[:8]`（#23 §5.1），客户端不再二次兜底 */
  name: string;
  count: number;
}

export class ContributionError extends Error {
  constructor(
    readonly code: 'network' | 'rejected' | 'server' | 'client',
    message: string,
  ) {
    super(message);
    this.name = 'ContributionError';
  }
}

/** 名册（匿名读、前 10、实时派生）。 */
export async function roster(o: ContributionOptions): Promise<ContributorItem[]> {
  let res;
  try {
    res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/contributors`);
  } catch {
    throw new ContributionError('network', '需要联网才能查看名册');
  }
  if (res.status !== 200) throw new ContributionError('server', `读取名册失败（HTTP ${res.status}）`);
  const page = JSON.parse(decodeUtf8(res.body)) as { contributors?: Array<Record<string, unknown>> };
  return (page.contributors ?? []).map((c) => ({
    id: String(c.id ?? ''),
    name: String(c.name ?? ''),
    count: Number(c.count ?? 0),
  }));
}

/** 本机身份 id（不联网、不生成）；无身份返回空串。只用于「在榜标出自己」。 */
export async function myIdentityId(o: ContributionOptions): Promise<string> {
  try {
    const ident = await peekLocalIdentity(o.adapters.storage);
    return ident?.id ?? '';
  } catch {
    return '';
  }
}

/** 写昵称。**请求体不得携带 `id`**（携带即 `profile_id_forbidden`，#23 §5.2）。 */
export async function putName(o: ContributionOptions, name: string): Promise<void> {
  let ident: Identity;
  try {
    ident = await ensureRegistered(o);
  } catch (e) {
    if (e instanceof CommentError) {
      throw new ContributionError(e.code === 'network' ? 'network' : 'rejected', e.message);
    }
    throw new ContributionError('client', `身份准备失败：${(e as Error).message ?? String(e)}`);
  }
  const bytes = utf8(JSON.stringify({ name }));
  const headers = signRequestHeaders(ident, { method: 'POST', path: '/v1/profile', body: bytes });
  let res;
  try {
    res = await o.adapters.http.post(`${o.nodeBaseUrl}/v1/profile`, bytes, {
      'Content-Type': 'application/json',
      ...headers,
    });
  } catch {
    throw new ContributionError('network', '需要联网才能保存昵称');
  }
  if (res.status !== 200) {
    const body = decodeUtf8(res.body);
    if (res.status >= 500) throw new ContributionError('server', `保存昵称失败（HTTP ${res.status}）`);
    throw new ContributionError('rejected', errorText(errorCodeOf(body), `保存昵称失败（HTTP ${res.status}）`));
  }
}