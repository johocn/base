<template>
  <view class="wrap">
    <text class="title">近场接收</text>

    <view class="field">
      <text class="label">配对码（源端「近场分享」页复制，或扫码）</text>
      <textarea v-model="code" class="code" :maxlength="-1" placeholder="粘贴配对码 JSON" auto-height />
      <view class="acts">
        <button size="mini" class="btn" @click="scan">扫码</button>
        <button size="mini" class="btn" :disabled="syncing" @click="onSync">{{ syncing ? '同步中…' : '开始同步' }}</button>
      </view>
    </view>

    <view class="field">
      <text class="label">进度</text>
      <text class="meta">{{ statusLine }}</text>
      <text v-if="total > 0" class="meta">块下载：{{ done }}/{{ total }}（失败 {{ failed }}）</text>
      <text v-for="(l, i) in logs" :key="i" class="log">{{ l }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from 'vue';

import { bootstrap } from '../../platform';
import { MeshClient, mergeMeshCatalog, verifyCatalogPubs } from '@base/core-ts';
import { ensureLocalIdentity } from '@base/core-ts/identity';
import { decodeUtf8 } from '@base/core-ts/sync';
import { parseNodeEnroll, verifyMeshCatalog, type MeshCatalogDoc, type MeshCatalogEntry } from '@base/protocol-ts';
import type { Adapters } from '@base/core-ts';
import type { LocalRepo } from '@base/core-ts/repo';
import { exchangeGossip } from '../../mesh/gossip-engine';
import { flushRelay } from '../../mesh/relay';

const DOWNLOAD_CONCURRENCY = 4;
const GOSSIP_EXCHANGE_MS = 30_000;

const code = ref('');
const syncing = ref(false);
const statusLine = ref('待同步');
const done = ref(0);
const total = ref(0);
const failed = ref(0);
const logs = ref<string[]>([]);

/** gossip 交换循环状态：配对成功后每 30s 一轮（推送本机所发 + 拉取源端所发），卸载时清理 */
let meshTarget: { baseUrl: string; token: string } | null = null;
let gossipTimer: ReturnType<typeof setInterval> | null = null;
let gossipSince = '0_';
let exchanging = false;

async function exchangeTick(): Promise<void> {
  const target = meshTarget;
  if (!target || exchanging) return;
  exchanging = true;
  try {
    const { repo, opts } = await bootstrap();
    const ident = await ensureLocalIdentity(opts.adapters.storage);
    const stats = await exchangeGossip({
      adapters: opts.adapters,
      repo,
      myPubHex: ident.pubHex,
      baseUrl: target.baseUrl,
      token: target.token,
      since: gossipSince,
      workDir: opts.workDir,
    });
    gossipSince = stats.cursor;
    if (stats.sent + stats.stored > 0) {
      pushLog(`gossip：推 ${stats.sent} 收 ${stats.stored}（重 ${stats.duplicate} 拒 ${stats.rejected}）`);
    }
  } catch {
    /* 对端暂不可达：下一轮再试 */
  } finally {
    exchanging = false;
  }
}

function startGossipLoop(baseUrl: string, token: string): void {
  meshTarget = { baseUrl, token };
  if (gossipTimer !== null) return;
  void exchangeTick();
  gossipTimer = setInterval(() => {
    void exchangeTick();
  }, GOSSIP_EXCHANGE_MS);
}

onUnmounted(() => {
  if (gossipTimer !== null) {
    clearInterval(gossipTimer);
    gossipTimer = null;
  }
});

function pushLog(msg: string): void {
  logs.value = [...logs.value.slice(-49), `${new Date().toISOString().slice(11, 19)} ${msg}`];
}

function isoNoMs(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function scan(): void {
  uni.scanCode({
    success: (res) => {
      code.value = String(res.result ?? '').trim();
    },
    fail: () => {
      /* 用户取消 */
    },
  });
}

function failSync(msg: string): void {
  statusLine.value = `失败：${msg}`;
  pushLog(msg);
  uni.showToast({ title: msg, icon: 'none' });
  syncing.value = false;
}

/** 分页拉 catalog（体例同 MeshClient.pullCatalog），同时收集非签名传输扩展 item_blobs（块清单）。 */
async function pullCatalogWithBlobs(
  http: Adapters['http'],
  baseUrl: string,
  token: string,
  anchorPub: string,
): Promise<{ doc: MeshCatalogDoc; itemBlobs: Record<string, string[]> }> {
  const entries: MeshCatalogEntry[] = [];
  const itemBlobs: Record<string, string[]> = {};
  let catalogVersion = 0;
  let signedAt = '';
  let nodeId = '';
  let signature = '';
  let cursor: string | null = null;
  for (;;) {
    const q = [`token=${encodeURIComponent(token)}`];
    if (cursor !== null) q.push(`cursor=${encodeURIComponent(cursor)}`);
    const res = await http.get(`${baseUrl}/mesh/v1/catalog?${q.join('&')}`);
    if (res.status !== 200) throw new Error(`mesh_catalog_failed: HTTP ${res.status}`);
    const page = JSON.parse(decodeUtf8(res.body)) as {
      node_id: string;
      catalog_version: number;
      signed_at: string;
      signature: string;
      entries: MeshCatalogEntry[];
      next_cursor: string | null;
      item_blobs?: Record<string, string[]>;
    };
    nodeId = page.node_id;
    catalogVersion = page.catalog_version;
    signedAt = page.signed_at;
    signature = page.signature;
    entries.push(...(page.entries ?? []));
    for (const [k, ids] of Object.entries(page.item_blobs ?? {})) itemBlobs[k] = ids ?? [];
    const next = page.next_cursor ?? null;
    if (next === null) break;
    if (next === cursor) throw new Error('mesh_catalog_pagination_stuck');
    cursor = next;
  }
  const doc: MeshCatalogDoc = {
    type: 'mesh-catalog',
    v: 1,
    node_id: nodeId,
    catalog_version: catalogVersion,
    entries,
    signed_at: signedAt,
    signature,
  };
  if (!verifyCatalogPubs(doc, [anchorPub])) throw new Error('mesh_catalog_sig_invalid');
  return { doc, itemBlobs };
}

/** 并发 4 下载缺失块（fetchBlob 已含 sha256 自证 + 一次重拉） */
async function downloadBlobs(
  repo: LocalRepo,
  fs: Adapters['fs'],
  client: MeshClient,
  baseUrl: string,
  token: string,
  jobs: Array<{ blobId: string; itemId: string }>,
): Promise<void> {
  total.value = jobs.length;
  done.value = 0;
  failed.value = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= jobs.length) return;
      const job = jobs[i]!;
      try {
        const bytes = await client.fetchBlob(baseUrl, token, job.blobId);
        // 任务指定路径：_doc/blobs/<b0>/<b2>/<blob_id>（FsAdapter 内部建目录）
        const path = `_doc/blobs/${job.blobId.slice(0, 2)}/${job.blobId.slice(2, 4)}/${job.blobId}`;
        await fs.writeFile(path, bytes);
        await repo.addBlob(job.blobId, '', path, bytes.length, isoNoMs(), undefined, undefined, job.itemId);
        done.value += 1;
      } catch (e) {
        failed.value += 1;
        pushLog(`块 ${job.blobId} 下载失败：${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, jobs.length) }, () => worker()));
}

async function onSync(): Promise<void> {
  if (syncing.value) return;
  syncing.value = true;
  statusLine.value = '解析配对码…';
  try {
    const raw = code.value.trim();
    const doc = parseNodeEnroll(raw);
    if (!doc) {
      failSync('配对码不合法，已拒收');
      return;
    }
    let extra: { mesh_ip?: string; mesh_port?: number };
    try {
      extra = JSON.parse(raw) as { mesh_ip?: string; mesh_port?: number };
    } catch {
      failSync('配对码不合法，已拒收');
      return;
    }
    if (!extra.mesh_ip || !extra.mesh_port) {
      failSync('配对码缺少近场地址（mesh_ip/mesh_port）');
      return;
    }
    if (!doc.token) {
      failSync('配对码缺少 token');
      return;
    }
    const token = doc.token;
    const baseUrl = `http://${extra.mesh_ip}:${extra.mesh_port}`;

    // TOFU（spec §3.4）：锚点已存在且 sign_pubkey 不匹配 → 全屏告警中止
    const { repo, opts } = await bootstrap();
    const { adapters } = opts;
    const existing = await repo.getNode(doc.node_id);
    if (existing && existing.signPubkey !== doc.sign_pubkey) {
      uni.showModal({
        title: '安全警告：节点密钥变更',
        content: `节点 ${doc.node_id} 的签名公钥与已信任锚点不一致，可能是密钥轮换或中间人攻击。已中止同步。`,
        showCancel: false,
        confirmText: '知道了',
      });
      failSync('节点密钥变更，已中止');
      return;
    }
    if (!existing) {
      const confirmed = await new Promise<boolean>((resolve) => {
        uni.showModal({
          title: '信任新节点',
          content: `首次连接节点 ${doc.node_id.slice(0, 8)}…，将按 TOFU 记录其公钥。是否信任？`,
          success: (r) => resolve(r.confirm === true),
          fail: () => resolve(false),
        });
      });
      if (!confirmed) {
        failSync('已取消');
        return;
      }
      await repo.upsertNode({
        nodeId: doc.node_id,
        url: doc.url,
        tlsFingerprint: doc.tls_fingerprint,
        signPubkey: doc.sign_pubkey,
        authorityOrder: 2147483647,
        lastSeenAt: isoNoMs(),
      });
      pushLog(`已记录 TOFU 锚点 ${doc.node_id}`);
    }

    statusLine.value = '连接源端…';
    const client = new MeshClient(adapters.http);
    const hello = await client.hello(baseUrl, token);
    pushLog(`hello：node=${hello.node_id.slice(0, 8)}… catalog_v${hello.catalog_version}`);
    // token 验过即配对成立：起 gossip 交换循环（每 30s 推本机所发 + 拉源端所发）
    startGossipLoop(baseUrl, token);

    statusLine.value = '拉取目录…';
    const { doc: catalog, itemBlobs } = await pullCatalogWithBlobs(adapters.http, baseUrl, token, doc.sign_pubkey);
    if (!verifyMeshCatalog(catalog, doc.sign_pubkey)) {
      failSync('目录验签失败，已拒收');
      return;
    }
    pushLog(`目录 ${catalog.entries.length} 条（v${catalog.catalog_version}）`);

    statusLine.value = '合并目录…';
    const decisions = await mergeMeshCatalog(repo, catalog.entries);
    const fetched = decisions.filter((d) => d.action === 'fetch');
    const conflicted = decisions.filter((d) => d.action === 'conflicted');
    const regressed = decisions.filter((d) => d.action === 'rev_regression');
    if (regressed.length > 0) pushLog(`警告：${regressed.length} 条 rev 回退（拒绝）`);
    if (conflicted.length > 0) pushLog(`${conflicted.length} 条内容冲突（本地保留，标记 conflicted）`);

    statusLine.value = '下载缺失块…';
    const jobs: Array<{ blobId: string; itemId: string }> = [];
    for (const d of fetched) {
      for (const blobId of itemBlobs[d.itemId] ?? []) {
        if (!/^[0-9a-f]{32}$/.test(blobId)) continue;
        if (await repo.hasBlob(blobId)) continue;
        jobs.push({ blobId, itemId: d.itemId });
      }
    }
    pushLog(`待下载 ${jobs.length} 块`);
    await downloadBlobs(repo, adapters.fs, client, baseUrl, token, jobs);

    statusLine.value = failed.value > 0 ? `完成（${failed.value} 块失败）` : '完成';
    uni.showToast({ title: failed.value > 0 ? `同步完成，${failed.value} 块失败` : '同步完成', icon: 'none' });
    // 回连代报（spec §4.3）：同步成功的分支上追加，不阻塞 UI、失败静默
    void flushRelay(opts).catch(() => {});
  } catch (e) {
    const msg = (e as Error).message;
    failSync(msg === 'mesh_token_rejected' ? '配对码已失效，请让源端重新提供' : msg);
  } finally {
    syncing.value = false;
  }
}
</script>

<style scoped>
.wrap {
  padding: 24rpx;
}
.title {
  font-size: 36rpx;
  font-weight: bold;
  margin-bottom: 24rpx;
}
.field {
  margin: 20rpx 0;
}
.acts {
  display: flex;
  gap: 16rpx;
  margin-top: 12rpx;
}
.label {
  display: block;
  font-size: 26rpx;
  color: #666;
  margin-bottom: 8rpx;
}
.code {
  border: 1rpx solid #ddd;
  border-radius: 8rpx;
  padding: 12rpx;
  width: 100%;
  word-break: break-all;
}
.btn {
  margin: 12rpx 0;
}
.meta {
  font-size: 24rpx;
  color: #666;
}
.log {
  display: block;
  font-size: 22rpx;
  color: #999;
}
</style>
