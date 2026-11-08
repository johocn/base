#!/usr/bin/env node
// 发布一致性校验：本地 manifest.json ↔ 线上落地页 ↔ /v1/release ↔ APK
// 任一处不一致即非零退出。零依赖，Node 20 全局 fetch。

import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

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

export function evaluateChecks({ manifest, landing, release, headSize, localApkSha256 }) {
  const expectedApk = `base-${manifest.versionName}-${manifest.versionCode}.apk`;
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });

  add(
    'manifest.format',
    /^\d+\.\d+\.\d+$/.test(manifest.versionName) && Number.isInteger(manifest.versionCode) && manifest.versionCode > 0,
    `本地 ${manifest.versionName} / ${manifest.versionCode}`,
  );
  add('landing.present', landing !== null, landing ? `线上落地页 ${landing.apkFile}` : '落地页未找到 base-<版本>-<code>.apk 链接');
  if (landing) {
    add('landing.version', landing.versionName === manifest.versionName, `线上 ${landing.versionName} ≠ 本地 ${manifest.versionName}`);
    add('landing.code', landing.versionCode === manifest.versionCode, `线上 ${landing.versionCode} ≠ 本地 ${manifest.versionCode}`);
    add('landing.file', landing.apkFile === expectedApk, `线上 ${landing.apkFile} ≠ 期望 ${expectedApk}`);
  }
  add('release.version', release.versionName === manifest.versionName, `release ${release.versionName} ≠ 本地 ${manifest.versionName}`);
  add('release.url', basename(release.apkUrl) === expectedApk, `release ${basename(release.apkUrl)} ≠ 期望 ${expectedApk}`);
  add('release.size', headSize !== null && release.apkSize === headSize, `HEAD ${headSize ?? '不可用'} ≠ release ${release.apkSize}`);
  add('min.version', compareVersion(release.minVersionName, manifest.versionName) <= 0, `min ${release.minVersionName} > 当前 ${manifest.versionName}`);
  if (localApkSha256) {
    add(
      'release.sha256',
      release.apkSha256 === localApkSha256,
      `release ${release.apkSha256.slice(0, 12)}… ≠ 本地 ${localApkSha256.slice(0, 12)}…`,
    );
  }
  return { ok: checks.every((c) => c.ok), checks, expectedApk };
}

async function getText(fetchImpl, url) {
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.text();
}

async function getContentLength(fetchImpl, url) {
  const r = await fetchImpl(url, { method: 'HEAD' });
  if (!r.ok) return null;
  const n = Number(r.headers.get('content-length'));
  return Number.isFinite(n) ? n : null;
}

export async function runCheck({ fetchImpl, baseUrl = DEFAULT_BASE_URL, manifestText, localApkSha256 }) {
  const manifest = parseManifest(manifestText);
  const landing = parseLanding(await getText(fetchImpl, `${baseUrl}/dl/`));
  const release = parseReleaseDoc(await getText(fetchImpl, `${baseUrl}/v1/release`));
  const apkFile = landing?.apkFile ?? `base-${manifest.versionName}-${manifest.versionCode}.apk`;
  const headSize = await getContentLength(fetchImpl, `${baseUrl}/dl/${apkFile}`);
  return evaluateChecks({ manifest, landing, release, headSize, localApkSha256 });
}

function argValue(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const manifestPath = argValue(args, '--manifest', 'apps/mobile/src/manifest.json');
  const apkPath = argValue(args, '--apk', '');
  const baseUrl = argValue(args, '--base-url', process.env.BASE_URL ?? DEFAULT_BASE_URL);

  const manifestText = await readFile(manifestPath, 'utf8');
  const localApkSha256 = apkPath
    ? createHash('sha256').update(await readFile(apkPath)).digest('hex')
    : undefined;

  const result = await runCheck({ fetchImpl: globalThis.fetch, baseUrl, manifestText, localApkSha256 });
  for (const c of result.checks) {
    console.log(`[${c.ok ? 'ok  ' : 'FAIL'}] ${c.id.padEnd(16)} ${c.detail}`);
  }
  console.log(result.ok ? '\n发布一致性：通过' : '\n发布一致性：不一致（见上）');
  process.exitCode = result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
