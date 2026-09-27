// 升级判定为纯逻辑：不碰网络、不弹窗（spec §8.4 的判定表）。
// 红线：任何失败都不得阻断 App 使用——判定函数不抛错，一律返回 ignore/latest。
//
// 另外三个函数（fetchReleaseDoc / openApkUrl / promptUpdate）有副作用，供设置页与 App.vue 复用；
// 它们同样静默：网络 404/超时、JSON 非法、验签失败、plus 缺失等一律不抛错、不阻断启动。

import { verifyRelease, type ReleaseDoc } from '@base/protocol-ts';

import type { HttpAdapter } from '../platform/adapter';
import { plusRuntime } from '../platform/uni';
import { decodeUtf8 } from './sync';

/** 三段数值解析；任一段非数字或为空即 null。 */
export function parseVersionName(s: string): number[] | null {
  const t = s.trim();
  if (!/^\d+(\.\d+)*$/.test(t)) return null;
  return t.split('.').map((x) => Number(x));
}

/** 三段数值比较：段数不等时缺位按 0。任一侧非法返回 null。 */
export function compareVersionName(a: string, b: string): number | null {
  const pa = parseVersionName(a);
  const pb = parseVersionName(b);
  if (pa === null || pb === null) return null;
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export interface ReleasePayloadShape {
  schema_version: number;
  version_name: string;
  min_version_name: string;
}

export type UpdateDecision = 'ignore' | 'latest' | 'optional' | 'forced';

/**
 * ignore：静默丢弃（验签已由调用方负责；此处只判可判定的部分）
 * latest：已是最新；optional：可取消弹窗；forced：不可取消弹窗
 */
export function decideUpdate(localVersion: string, payload: ReleasePayloadShape): UpdateDecision {
  if (payload.schema_version !== 1) return 'ignore';
  const cmp = compareVersionName(localVersion, payload.version_name);
  if (cmp === null) return 'ignore';
  if (cmp >= 0) return 'latest';
  const minCmp = compareVersionName(localVersion, payload.min_version_name);
  if (minCmp === null) return 'ignore';
  return minCmp < 0 ? 'forced' : 'optional';
}

/** 拉取并验签 release 文档；任何失败返回 null（调用方一律静默）。 */
export async function fetchReleaseDoc(
  http: HttpAdapter,
  nodeBaseUrl: string,
  pubHex: string,
): Promise<ReleaseDoc | null> {
  try {
    const res = await http.get(`${nodeBaseUrl}/v1/release`);
    if (res.status !== 200) return null;
    const doc = JSON.parse(decodeUtf8(res.body)) as ReleaseDoc;
    return verifyRelease(doc, pubHex) ? doc : null;
  } catch {
    return null;
  }
}

/** 本版走浏览器打开下载链接（spec §8.5）；没有 plus.runtime.openURL 时退回复制到剪贴板。 */
export function openApkUrl(url: string): void {
  const rt = plusRuntime()?.runtime;
  if (rt && typeof rt.openURL === 'function') {
    rt.openURL(url);
    return;
  }
  uni.setClipboardData({ data: url });
}

/**
 * 确认后**只打开下载链接**，不下载、不 install、不做 wgt 热更新。
 * 展示 apk_sha256 前 16 位供人工核对下载到的包（App 无法校验下载字节）。
 */
export function promptUpdate(doc: ReleaseDoc, decision: UpdateDecision): void {
  const shortSha = doc.payload.apk_sha256.slice(0, 16);
  const shaTip = `apk sha256(前16位)：${shortSha}`;
  const notes = doc.payload.notes ? `${doc.payload.notes}\n${shaTip}` : shaTip;
  uni.showModal({
    title: `发现新版本 ${doc.payload.version_name}`,
    content: notes,
    showCancel: decision === 'optional',
    cancelText: '以后再说',
    confirmText: '去下载',
    success: (r) => {
      if (r.confirm) openApkUrl(doc.payload.apk_url);
    },
  });
}