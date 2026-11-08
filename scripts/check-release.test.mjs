import test from 'node:test';
import assert from 'node:assert/strict';

import { parseManifest, parseLanding, parseReleaseDoc, compareVersion, evaluateChecks } from './check-release.mjs';

test('parseManifest 取 versionName / versionCode', () => {
  const m = parseManifest('{"versionName":"0.21.11","versionCode":54}');
  assert.deepEqual(m, { versionName: '0.21.11', versionCode: 54 });
});

test('parseLanding 从 href 取版本与 code', () => {
  const l = parseLanding('<a class=btn href=./base-0.21.11-54.apk download>下载</a>');
  assert.deepEqual(l, { versionName: '0.21.11', versionCode: 54, apkFile: 'base-0.21.11-54.apk' });
});

test('parseLanding 无链接返回 null', () => {
  assert.equal(parseLanding('<p>暂无</p>'), null);
});

test('parseReleaseDoc 兼容带 payload 信封', () => {
  const r = parseReleaseDoc(JSON.stringify({
    payload: { version_name: '0.21.11', apk_url: 'http://x/dl/base-0.21.11-54.apk', apk_size: 123, apk_sha256: 'ab', min_version_name: '0.8.0' },
    signature: 'ff',
  }));
  assert.deepEqual(r, {
    versionName: '0.21.11',
    apkUrl: 'http://x/dl/base-0.21.11-54.apk',
    apkSize: 123,
    apkSha256: 'ab',
    minVersionName: '0.8.0',
  });
});

test('compareVersion 按数字段比较', () => {
  assert.equal(compareVersion('0.21.10', '0.21.11') < 0, true);
  assert.equal(compareVersion('0.21.11', '0.21.11'), 0);
  assert.equal(compareVersion('0.8.0', '0.21.11') < 0, true);
});

const MANIFEST = { versionName: '0.21.11', versionCode: 54 };
const LANDING = { versionName: '0.21.11', versionCode: 54, apkFile: 'base-0.21.11-54.apk' };
const RELEASE = {
  versionName: '0.21.11',
  apkUrl: 'http://118.190.217.242/dl/base-0.21.11-54.apk',
  apkSize: 27585454,
  apkSha256: 'a'.repeat(64),
  minVersionName: '0.8.0',
};

test('evaluateChecks 四处一致时通过', () => {
  const r = evaluateChecks({ manifest: MANIFEST, landing: LANDING, release: RELEASE, headSize: RELEASE.apkSize });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.equal(r.expectedApk, 'base-0.21.11-54.apk');
  assert.equal(r.checks.every((c) => c.ok), true);
});

test('evaluateChecks 落地页版本落后即失败', () => {
  const r = evaluateChecks({
    manifest: MANIFEST,
    landing: { ...LANDING, versionName: '0.21.10', versionCode: 53, apkFile: 'base-0.21.10-53.apk' },
    release: RELEASE,
    headSize: RELEASE.apkSize,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.checks.filter((c) => !c.ok).map((c) => c.id), ['landing.version', 'landing.code', 'landing.file']);
});

test('evaluateChecks release 指向旧包或大小不符即失败', () => {
  const r = evaluateChecks({
    manifest: MANIFEST,
    landing: LANDING,
    release: { ...RELEASE, apkUrl: 'http://118.190.217.242/dl/base-0.21.6.apk', apkSize: 27585455 },
    headSize: 27585454,
  });
  assert.deepEqual(r.checks.filter((c) => !c.ok).map((c) => c.id), ['release.url', 'release.size']);
});

test('evaluateChecks 本地 APK 哈希不符即失败', () => {
  const r = evaluateChecks({
    manifest: MANIFEST,
    landing: LANDING,
    release: RELEASE,
    headSize: RELEASE.apkSize,
    localApkSha256: 'b'.repeat(64),
  });
  assert.deepEqual(r.checks.filter((c) => !c.ok).map((c) => c.id), ['release.sha256']);
});

test('evaluateChecks min_version 高于当前版本即失败', () => {
  const r = evaluateChecks({
    manifest: MANIFEST,
    landing: LANDING,
    release: { ...RELEASE, minVersionName: '0.22.0' },
    headSize: RELEASE.apkSize,
  });
  assert.deepEqual(r.checks.filter((c) => !c.ok).map((c) => c.id), ['min.version']);
});
