#!/usr/bin/env node
// 发布一致性校验：本地 manifest.json ↔ 线上落地页 ↔ /v1/release ↔ APK
// 任一处不一致即非零退出。零依赖，Node 20 全局 fetch。

export const DEFAULT_BASE_URL = 'http://118.190.217.242';

export function parseManifest(text) {
  const m = JSON.parse(text);
  return { versionName: String(m.versionName ?? ''), versionCode: Number(m.versionCode ?? 0) };
}

export function parseLanding(html) {
  const hit = html.match(/base-(\d+\.\d+\.\d+)-(\d+)\.apk/);
  if (!hit) return null;
  return { versionName: hit[1], versionCode: Number(hit[2]), apkFile: `base-${hit[1]}-${hit[2]}.apk` };
}

export function parseReleaseDoc(text) {
  const doc = JSON.parse(text);
  const p = doc.payload ?? doc;
  return {
    versionName: String(p.version_name ?? ''),
    apkUrl: String(p.apk_url ?? ''),
    apkSize: Number(p.apk_size ?? 0),
    apkSha256: String(p.apk_sha256 ?? ''),
    minVersionName: String(p.min_version_name ?? ''),
  };
}

/** 数字段比较；空串视为 0.0.0。返回 -1 / 0 / 1。 */
export function compareVersion(a, b) {
  const pa = (a === '' ? '0.0.0' : a).split('.').map(Number);
  const pb = (b === '' ? '0.0.0' : b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
