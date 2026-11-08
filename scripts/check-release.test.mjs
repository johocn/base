import test from 'node:test';
import assert from 'node:assert/strict';

import { parseManifest, parseLanding, parseReleaseDoc, compareVersion } from './check-release.mjs';

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
