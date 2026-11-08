# 批次一 · 发布一致性止血 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一条命令把「本地版本、线上落地页、`/v1/release`、APK 大小/哈希」四处互校，任一处不一致即非零退出；随后把生产线切到当前开发版 0.21.11/54。

**Architecture:** 新增独立 Node 工具 `scripts/check-release.mjs`（零依赖、Node 20 全局 `fetch`）。纯函数负责解析与比对，可直接单测；CLI 负责取数、打印与退出码。生产切版沿用既有四步（云打包 → 上传 `/opt/appdl` → 改落地页 → `based release` 签发），切版后复跑同一脚本作为验收。

**Tech Stack:** Node 20.19（全局 `fetch`、`node:test`、`node:crypto`、`node:fs/promises`）、npm workspaces。

**上游:** `docs/superpowers/specs/2026-11-08-base-business-blockers-and-roadmap-design.md` §3.1。

**现状事实（执行前必须知道）：**
- 2026-11-08 线上实测：落地页 `base-0.21.10-53.apk`，`/v1/release` 为 `0.21.6` / `apk_url=base-0.21.6.apk` → **两处不一致**，本脚本首跑应当报 FAIL。
- 本地 `apps/mobile/src/manifest.json` = `0.21.11` / `54`；`pages.json` 无版本字段，版本唯一真源是 `manifest.json`。
- 线上 APK 目录 `/opt/appdl/`，服务器别名 `ssh me`（root@118.190.217.242）；签发命令 `/opt/base/based release … -out /opt/base-cache/data/release.json`。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `scripts/check-release.mjs`（新建） | 解析 manifest / 落地页 / release 文档；比对；CLI 取数与退出码 |
| `scripts/check-release.test.mjs`（新建） | 纯函数与 `runCheck` 的 `node:test` 单测，注入假 `fetch` |
| `package.json`（修改） | 加 `"check:release": "node scripts/check-release.mjs"` |
| `docs/README.md`（修改） | 本计划登记为 #84 |

---

### Task 1: 解析与比对纯函数

**Files:**
- Create: `scripts/check-release.mjs`
- Test: `scripts/check-release.test.mjs`

- [ ] **Step 1: 写失败测试（解析）**

`scripts/check-release.test.mjs`：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/check-release.test.mjs`
Expected: FAIL，`Cannot find module ... check-release.mjs`。

- [ ] **Step 3: 写最小实现（仅解析函数）**

`scripts/check-release.mjs`：

```js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/check-release.test.mjs`
Expected: PASS（5 tests）。

- [ ] **Step 5: 提交**

```bash
git add scripts/check-release.mjs scripts/check-release.test.mjs
git commit -m "feat(scripts): 发布一致性校验解析纯函数"
```

---

### Task 2: `evaluateChecks` 比对规则

**Files:**
- Modify: `scripts/check-release.mjs`
- Test: `scripts/check-release.test.mjs`

- [ ] **Step 1: 写失败测试（全绿与三类不一致）**

追加到 `scripts/check-release.test.mjs`：

```js
import { evaluateChecks } from './check-release.mjs';

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/check-release.test.mjs`
Expected: FAIL，`evaluateChecks is not a function`。

- [ ] **Step 3: 实现 `evaluateChecks`**

在 `scripts/check-release.mjs` 末尾追加：

```js
import { basename } from 'node:path';

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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/check-release.test.mjs`
Expected: PASS（10 tests）。

- [ ] **Step 5: 提交**

```bash
git add scripts/check-release.mjs scripts/check-release.test.mjs
git commit -m "feat(scripts): 发布四处一致性比对规则"
```

---

### Task 3: CLI 取数、打印与退出码

**Files:**
- Modify: `scripts/check-release.mjs`
- Test: `scripts/check-release.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写失败测试（假 fetch 端到端）**

追加到 `scripts/check-release.test.mjs`：

```js
import { runCheck } from './check-release.mjs';

function fakeFetch({ landingHtml, releaseJson, size, headStatus = 200 }) {
  return async (url, init = {}) => {
    if (init.method === 'HEAD') {
      return { ok: headStatus === 200, status: headStatus, headers: { get: () => String(size) } };
    }
    if (url.endsWith('/dl/')) return { ok: true, status: 200, text: async () => landingHtml };
    if (url.endsWith('/v1/release')) return { ok: true, status: 200, text: async () => releaseJson };
    throw new Error(`unexpected ${url}`);
  };
}

test('runCheck 四处一致时通过', async () => {
  const r = await runCheck({
    fetchImpl: fakeFetch({
      landingHtml: '<a href=./base-0.21.11-54.apk>下载</a>',
      releaseJson: JSON.stringify({ payload: { ...RELEASE, version_name: RELEASE.versionName, apk_url: RELEASE.apkUrl, apk_size: RELEASE.apkSize, apk_sha256: RELEASE.apkSha256, min_version_name: RELEASE.minVersionName } }),
      size: RELEASE.apkSize,
    }),
    baseUrl: 'http://x',
    manifestText: JSON.stringify(MANIFEST),
  });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
});

test('runCheck 线上仍是旧版时失败并给出可读原因', async () => {
  const r = await runCheck({
    fetchImpl: fakeFetch({
      landingHtml: '<a href=./base-0.21.10-53.apk>下载</a>',
      releaseJson: JSON.stringify({ payload: { version_name: '0.21.6', apk_url: 'http://x/dl/base-0.21.6.apk', apk_size: 27585454, apk_sha256: 'a'.repeat(64), min_version_name: '0.8.0' } }),
      size: 27585454,
    }),
    baseUrl: 'http://x',
    manifestText: JSON.stringify(MANIFEST),
  });
  assert.equal(r.ok, false);
  const ids = r.checks.filter((c) => !c.ok).map((c) => c.id);
  assert.deepEqual(ids, ['landing.version', 'landing.code', 'landing.file', 'release.version', 'release.url']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/check-release.test.mjs`
Expected: FAIL，`runCheck is not a function`。

- [ ] **Step 3: 实现取数与 CLI**

在 `scripts/check-release.mjs` 末尾追加：

```js
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
  const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { pathToFileURL } = await import('node:url');

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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/check-release.test.mjs`
Expected: PASS（12 tests）。

- [ ] **Step 5: 加 npm 脚本**

`package.json` 的 `scripts` 改为：

```json
"scripts": {
  "test": "npm run test --workspaces --if-present",
  "typecheck": "npm run typecheck --workspaces --if-present",
  "check:release": "node scripts/check-release.mjs"
}
```

- [ ] **Step 6: 对生产实跑，确认能抓到现存不一致**

Run: `npm run check:release`
Expected: 退出码 1；`landing.version` / `landing.code` / `landing.file` / `release.version` / `release.url` 至少各一条 FAIL（线上落地页 0.21.10-53 vs 本地 0.21.11-54 vs release 0.21.6）。

- [ ] **Step 7: 提交**

```bash
git add scripts/check-release.mjs scripts/check-release.test.mjs package.json
git commit -m "feat(scripts): check:release 一条命令互校发布四处"
```

---

### Task 4: 生产线切版到 0.21.11 / 54

> **前置（阻塞项）：** 需要用户先云打包得到 `apps/mobile/dist/release/apk/__UNI__936A667__<时间戳>.apk`（manifest 已是 0.21.11 / 54）。以下命令中的 `$apk` 由该路径替换。

**Files:**
- 服务器 `/opt/appdl/base-0.21.11-54.apk`（新增）
- 服务器 `/opt/appdl/index.html`（修改）
- 服务器 `/opt/base-cache/data/release.json`（重新签发）

- [ ] **Step 1: 记录可回退备份**

```bash
ssh me "cp -a /opt/appdl/index.html /opt/appdl/index.html.bak-20261108; cp -a /opt/base-cache/data/release.json /opt/base-cache/data/release.json.bak-20261108"
```

Expected: 两条备份路径存在。

- [ ] **Step 2: 上传 APK 并核对大小与哈希**

```powershell
scp $apk me:/opt/appdl/base-0.21.11-54.apk
ssh me "sha256sum /opt/appdl/base-0.21.11-54.apk; stat -c %s /opt/appdl/base-0.21.11-54.apk"
```

Expected: 远端 `sha256sum` 与本地 `Get-FileHash` 逐字一致；`stat` 字节数与本地文件一致。

- [ ] **Step 3: 落地页改指新包**

```bash
ssh me "sed -i 's#base-0.21.10-53.apk#base-0.21.11-54.apk#; s#0.21.10#0.21.11#; s#versionCode 53#versionCode 54#' /opt/appdl/index.html"
ssh me "grep -o 'base-0.21.11-54.apk' /opt/appdl/index.html | head -1"
```

Expected: 输出 `base-0.21.11-54.apk`；页面内不再出现 `0.21.10` 或 `versionCode 53`。

- [ ] **Step 4: 重新签发 `/v1/release` 文档**

```bash
ssh me "set -a; . /opt/base/base.secret.env; set +a; /opt/base/based release -version-name 0.21.11 -min-version-name 0.8.0 -apk-url http://118.190.217.242/dl/base-0.21.11-54.apk -apk-file /opt/appdl/base-0.21.11-54.apk -notes '0.21.11/54: 圈子引导与邀请码留存、mesh IP 探测' -out /opt/base-cache/data/release.json"
```

Expected: 输出 `apk_size` / `apk_sha256` / `public_key`，且 `apk_size` 与 Step 2 的字节数一致。

- [ ] **Step 5: 复跑校验（本批唯一验收命令）**

```powershell
npm run check:release
```

Expected: 全部 `ok`，末行「发布一致性：通过」，退出码 0。

- [ ] **Step 6: 公网复核**

```powershell
(Invoke-WebRequest 'http://118.190.217.242/dl/' -UseBasicParsing).Content -match 'base-0.21.11-54.apk'
(Invoke-WebRequest 'http://118.190.217.242/v1/release' -UseBasicParsing).Content
```

Expected: 第一条 `True`；第二条 `version_name` = `0.21.11`、`apk_url` 指向 `base-0.21.11-54.apk`。

- [ ] **Step 7: 记录结果并提交台账**

把实测的 `apk_size` / `apk_sha256` / 命令时间写进本计划末尾「执行实况」，然后：

```bash
git add docs/superpowers/plans/2026-11-08-base-release-integrity-phase1-plan.md
git commit -m "docs(plans): 批次一生产切版实况（0.21.11/54）"
```

---

### Task 5: 门禁与登记

**Files:**
- Modify: `docs/README.md`（#84 行状态回填）
- Modify: `docs/superpowers/specs/2026-11-08-base-business-blockers-and-roadmap-design.md`（§6 标记批次一已收口）

- [ ] **Step 1: 注入三处不一致，确认脚本逐条报错**

每次只改一处、跑一次、还原：

```powershell
# ① 落地页版本（线上）
ssh me "cp -a /opt/appdl/index.html /tmp/i.bak; sed -i 's#0.21.11#0.21.10#' /opt/appdl/index.html"
npm run check:release   # 期望退出码 1，landing.* FAIL
ssh me "cp -a /tmp/i.bak /opt/appdl/index.html"

# ② release 版本（线上）
ssh me "cp -a /opt/base-cache/data/release.json /tmp/r.bak"
# 手工把 version_name 改为 0.21.10 后
npm run check:release   # 期望退出码 1，release.version FAIL
ssh me "cp -a /tmp/r.bak /opt/base-cache/data/release.json"

# ③ 本地 manifest 版本
# 把 versionCode 54 改为 55 后
npm run check:release   # 期望退出码 1，landing.* / release.* FAIL
# 改回 54
```

Expected: 三次均退出码 1 且失败项与注入位置对应；还原后 `npm run check:release` 退出码 0。

- [ ] **Step 2: 四 workspace 回归**

```powershell
npm test; npm run typecheck
```

Expected: 四 workspace 全绿、0 类型错误（本批不动业务代码，应与基线一致）。

- [ ] **Step 3: 回填 README #84 与 spec §6**

`docs/README.md` #84 行状态改为「**已收口**（2026-11-08：check:release 落地并抓到线上三处不一致；生产线已切 0.21.11/54，脚本退出码 0）」；spec §6 第 2 条改为「批次一已收口（#84），批次二待出计划」。

- [ ] **Step 4: 提交**

```bash
git add docs/README.md docs/superpowers/specs/2026-11-08-base-business-blockers-and-roadmap-design.md
git commit -m "docs: 批次一收口，登记 #84 状态"
git push
```

---

## 执行实况

（执行时回填：时间 / APK 路径 / apk_size / apk_sha256 / check:release 输出摘要）
