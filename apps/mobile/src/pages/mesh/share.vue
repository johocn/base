<template>
  <view class="wrap">
    <text class="title">近场分享（源端）</text>

    <view class="field">
      <text class="label">签名口令（≥8 位；部署者可直接粘贴 64 位 hex 节点私钥）</text>
      <input v-model="seedInput" class="input" password placeholder="至少 8 位口令" />
      <button size="mini" class="btn" @click="saveKey">生成并保存</button>
      <text class="meta">口令 + 本机设备号经 Argon2id 派生签名种子，同一设备同一口令可复现；生成约需数秒。</text>
      <text v-if="signKey" class="meta">node_id：{{ signKey.nodeId }}（{{ signKey.derived ? '口令派生' : '节点私钥' }}）</text>
    </view>

    <view class="field row">
      <text class="label">亮屏常亮（分享期间）</text>
      <switch :checked="screenLock" @change="onLockChange" />
    </view>

    <button size="mini" class="btn" @click="onToggleShare">{{ sharing ? '停止分享' : '开始分享' }}</button>
    <text class="meta">本机 IP：{{ localIp || '未获取' }}　端口：{{ sharing ? MESH_PORT : '-' }}</text>

    <view v-if="sharing" class="field">
      <text class="label">配对码（token 每 30 分钟自动续签，续签后请重新复制给接收端）</text>
      <textarea :value="shareCode" class="code" :maxlength="-1" disabled auto-height />
      <button size="mini" class="btn" @click="copyCode">复制配对码</button>
    </view>

    <view class="field">
      <text class="label">状态</text>
      <text class="meta">连接数：{{ activeConns }}　gossip 收到：{{ gossipStored }}（拒收 {{ gossipRejected }}）</text>
      <text v-for="(l, i) in logs" :key="i" class="log">{{ l }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from 'vue';

import { bootstrap } from '../../platform';
import { buildMeshCatalogEntries } from '@base/core-ts';
import { ensureLocalIdentity } from '@base/core-ts/identity';
import { decodeUtf8 } from '@base/core-ts/sync';
import { signMeshCatalog, utf8 } from '@base/protocol-ts';
import { ingestGossip, outgoingGossip } from '../../mesh/gossip-engine';
import { MESH_PORT, startMeshServer, type MeshRouteHandler, type MeshServerHandle } from '../../mesh/nio-server';
import { derivedTlsFingerprint, loadMeshSignKey, saveMeshSignKey, type MeshSignKey } from '../../mesh/sign-key';
import { buildShareCode, createShareTokenBox, shareExpiresAt } from '../../mesh/share';

function plusAny(): any {
  return (globalThis as any).plus;
}

const CATALOG_PAGE = 1000;
const GOSSIP_PAGE = 200;
const EMPTY: Uint8Array = new Uint8Array(0);

const signKey = ref<MeshSignKey | null>(null);
const seedInput = ref('');
const sharing = ref(false);
const screenLock = ref(true);
const shareCode = ref('');
const localIp = ref('');
const activeConns = ref(0);
const gossipStored = ref(0);
const gossipRejected = ref(0);
const logs = ref<string[]>([]);

/** 配对码静态部分（url/锚点在开始分享时定格） */
let shareUrl = '';
let shareTls = '';

let server: MeshServerHandle | null = null;
const tokenBox = createShareTokenBox({
  onRenew: () => {
    refreshShareCode();
    pushLog('token 已续签，请让接收端重新复制配对码');
  },
});

function pushLog(msg: string): void {
  logs.value = [...logs.value.slice(-49), `${new Date().toISOString().slice(11, 19)} ${msg}`];
}

function isoNoMs(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function applyWakelock(): void {
  try {
    plusAny()?.device?.setWakelock(screenLock.value && sharing.value);
  } catch {
    /* H5/老内核降级 */
  }
}

function onLockChange(e: Event): void {
  const detail = (e as unknown as { detail?: { value?: boolean } }).detail;
  screenLock.value = detail?.value ?? screenLock.value;
  applyWakelock();
}

async function loadKey(): Promise<void> {
  try {
    const { opts } = await bootstrap();
    signKey.value = await loadMeshSignKey(opts.adapters.storage);
  } catch (e) {
    pushLog(`私钥加载失败：${(e as Error).message}`);
  }
}

async function saveKey(): Promise<void> {
  const raw = seedInput.value.trim();
  if (raw === '') {
    uni.showToast({ title: '请输入口令或 64 位 hex 私钥', icon: 'none' });
    return;
  }
  uni.showLoading({ title: '生成签名种子…' });
  // 派生为同步 CPU 计算（数秒）：先让 loading 渲染一帧再阻塞
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    const { opts } = await bootstrap();
    signKey.value = await saveMeshSignKey(opts.adapters.storage, raw);
    seedInput.value = '';
    pushLog(`签名私钥已保存（${signKey.value.derived ? '口令派生' : '节点私钥'}），node_id=${signKey.value.nodeId}`);
  } catch (e) {
    uni.showToast({ title: (e as Error).message, icon: 'none' });
  } finally {
    uni.hideLoading();
  }
}

interface BatteryInfo {
  level: number;
  isCharging: boolean;
}

function checkBattery(): Promise<BatteryInfo | null> {
  return new Promise((resolve) => {
    try {
      const plus = plusAny();
      if (!plus?.device?.getBatteryInfo) {
        resolve(null);
        return;
      }
      plus.device.getBatteryInfo({
        success: (info: { level?: number; isCharging?: boolean }) =>
          resolve({ level: Number(info.level ?? 100), isCharging: info.isCharging === true }),
        fail: () => resolve(null),
      });
    } catch {
      resolve(null);
    }
  });
}

async function readLocalIp(): Promise<string> {
  try {
    const ip = String(plusAny()?.networkinfo?.getCurrentIPAddress?.() ?? '');
    if (ip) return ip;
  } catch {
    /* 落到 WifiManager */
  }
  // plus.networkinfo 在新 Android 上常返回空：用 WifiManager 取当前 Wi-Fi 地址（小端 int）
  try {
    const plus = plusAny();
    const main = plus.android.runtimeMainActivity();
    const Context = plus.android.importClass('android.content.Context');
    plus.android.importClass('android.net.wifi.WifiManager');
    const wm = main.getSystemService(Context.WIFI_SERVICE);
    const raw = Number(wm.getConnectionInfo().getIpAddress());
    if (Number.isFinite(raw) && raw !== 0) {
      return [raw & 255, (raw >> 8) & 255, (raw >> 16) & 255, (raw >>> 24) & 255].join('.');
    }
  } catch {
    /* 无 Wi-Fi / 无权限 */
  }
  return '';
}

function refreshShareCode(): void {
  const sign = signKey.value;
  if (!sign) return;
  shareCode.value = buildShareCode({
    nodeId: sign.nodeId,
    url: shareUrl,
    signPubkey: sign.pubHex,
    tlsFingerprint: shareTls,
    token: tokenBox.token(),
    ip: localIp.value,
    port: MESH_PORT,
    expiresAt: shareExpiresAt(),
  });
}

async function startShare(): Promise<void> {
  const sign = signKey.value;
  if (!sign) {
    uni.showToast({ title: '请先录入节点签名私钥', icon: 'none' });
    return;
  }
  const bat = await checkBattery();
  if (bat && !bat.isCharging) {
    uni.showModal({ title: '请插电后分享', content: '近场分发耗电明显，请连接充电器后再开始。', showCancel: false });
    return;
  }
  if (bat && bat.level < 20) {
    uni.showToast({ title: `电量 ${bat.level}%，建议保持插电`, icon: 'none' });
    pushLog(`电量偏低（${bat.level}%），未阻塞分享`);
  }
  const ip = await readLocalIp();
  if (!ip) {
    uni.showToast({ title: '无法获取本机 IP，请检查网络', icon: 'none' });
    return;
  }
  localIp.value = ip;
  const { repo } = await bootstrap();
  shareUrl = (await repo.getConfig('node_base_url')) ?? '';
  if (!shareUrl) {
    uni.showToast({ title: '请先在设置里填写节点地址', icon: 'none' });
    return;
  }
  const anchor = await repo.getNode(sign.nodeId);
  // 本机通常没有该 node_id 的锚点行：tls_fingerprint 按公钥确定性生成（接收端只落库不校验，
  // mesh 明文传输，真锚是 sign_pubkey TOFU），否则配对码缺锚被 parseNodeEnroll 拒收
  shareTls = anchor?.tlsFingerprint || derivedTlsFingerprint(sign.pubHex);
  gossipStored.value = 0;
  gossipRejected.value = 0;
  tokenBox.start();
  try {
    server = startMeshServer(handlers, {
      token: () => tokenBox.token(),
      onLog: pushLog,
      onStats: (s) => {
        activeConns.value = s.activeConns;
      },
    });
  } catch (e) {
    tokenBox.stop();
    uni.showToast({ title: (e as Error).message, icon: 'none' });
    return;
  }
  sharing.value = true;
  applyWakelock();
  refreshShareCode();
  pushLog(`分享中 http://${ip}:${MESH_PORT}`);
}

function stopShare(): void {
  server?.stop();
  server = null;
  tokenBox.stop();
  sharing.value = false;
  activeConns.value = 0;
  applyWakelock();
  pushLog('已停止分享');
}

function onToggleShare(): void {
  if (sharing.value) stopShare();
  else void startShare();
}

function copyCode(): void {
  uni.setClipboardData({
    data: shareCode.value,
    success: () => uni.showToast({ title: '已复制', icon: 'success' }),
  });
}

const json = (obj: unknown): { status: number; body: Uint8Array; contentType: string } => ({
  status: 200,
  body: utf8(JSON.stringify(obj)),
  contentType: 'application/json',
});

const notFound = (): { status: number; body: Uint8Array } => ({ status: 404, body: EMPTY });

/** 六接口接线（计划 Task 5 Step 6 表格逐字） */
const handlers: Record<string, MeshRouteHandler> = {
  'GET /mesh/v1/hello': async () => {
    const sign = signKey.value;
    if (!sign) return { status: 500, body: EMPTY };
    const { repo, db } = await bootstrap();
    const rows = await db.select(
      'SELECT received_at, event_id FROM gossip_events ORDER BY received_at DESC, event_id DESC LIMIT 1',
    );
    const cursor = rows.length > 0 ? `${Number(rows[0]!.received_at)}_${String(rows[0]!.event_id)}` : '0_';
    const catalogVersion = Number((await repo.getConfig('content_version')) ?? '0');
    return json({
      node_id: sign.nodeId,
      sign_pubkey: sign.pubHex,
      protocol_version: 1,
      catalog_version: catalogVersion,
      gossip_cursor: cursor,
    });
  },

  'GET /mesh/v1/catalog': async (ctx) => {
    const sign = signKey.value;
    if (!sign) return { status: 500, body: EMPTY };
    const { repo, db } = await bootstrap();
    const entries = await buildMeshCatalogEntries(repo);
    const catalogVersion = Number((await repo.getConfig('content_version')) ?? '0');
    const doc = signMeshCatalog(
      {
        type: 'mesh-catalog',
        v: 1,
        node_id: sign.nodeId,
        catalog_version: catalogVersion,
        entries,
        signed_at: isoNoMs(),
      },
      sign.seedHex,
    );
    // 一期全量单页（entries < 1000 不分页，next_cursor=null；超 1000 按 item_id 切页）
    const cur = ctx.query.cursor ?? '';
    let start = 0;
    if (cur !== '') {
      const idx = entries.findIndex((e) => e.item_id > cur);
      start = idx < 0 ? entries.length : idx;
    }
    const pageEntries = entries.slice(start, start + CATALOG_PAGE);
    const nextCursor =
      pageEntries.length > 0 && start + CATALOG_PAGE < entries.length
        ? pageEntries[pageEntries.length - 1]!.item_id
        : null;
    // 传输层扩展（非签名对象，块哈希自证，spec §1.2）：按条目附块清单，接收端据此取块
    const itemBlobs: Record<string, string[]> = {};
    if (pageEntries.length > 0) {
      const marks = pageEntries.map(() => '?').join(',');
      const blobRows = await db.select(
        `SELECT item_id, blob_id FROM blob_index WHERE item_id IN (${marks})`,
        pageEntries.map((e) => e.item_id),
      );
      for (const r of blobRows) {
        const k = String(r.item_id);
        (itemBlobs[k] ??= []).push(String(r.blob_id));
      }
    }
    return json({
      node_id: doc.node_id,
      catalog_version: doc.catalog_version,
      signed_at: doc.signed_at,
      signature: doc.signature,
      entries: pageEntries,
      next_cursor: nextCursor,
      item_blobs: itemBlobs,
    });
  },

  'GET /mesh/v1/blob/': async (ctx) => {
    const id = ctx.path.slice('/mesh/v1/blob/'.length).toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(id)) return notFound();
    const { db, opts } = await bootstrap();
    const rows = await db.select('SELECT path FROM blob_index WHERE blob_id = ?', [id]);
    const path = rows.length > 0 ? String(rows[0]!.path ?? '') : '';
    if (!path) return notFound();
    try {
      const bytes = await opts.adapters.fs.readFile(path);
      return { status: 200, body: bytes, contentType: 'application/octet-stream' };
    } catch {
      return notFound();
    }
  },

  'POST /mesh/v1/gossip': async (ctx) => {
    const { repo, opts } = await bootstrap();
    let parsed: { messages?: unknown };
    try {
      parsed = JSON.parse(decodeUtf8(ctx.body)) as { messages?: unknown };
    } catch {
      return { status: 400, body: EMPTY };
    }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    let stored = 0;
    let rejected = 0;
    const now = Date.now();
    for (const m of messages) {
      const r = await ingestGossip({ adapters: opts.adapters, repo, workDir: opts.workDir, msg: m, now });
      if (r === 'stored') stored += 1;
      else rejected += 1; // duplicate 对推送方无害，不计入拒收
    }
    gossipStored.value += stored;
    gossipRejected.value += rejected;
    return json({ stored, rejected });
  },

  'GET /mesh/v1/gossip': async (ctx) => {
    // 执行期定案 6：收件缓存转发后置二期（gossip_events 未存 actor_pubkey，转发必被对端丢弃）。
    // 一期 GET 只服务本机所发（comment_out 未发送行）：接收端由此拉到源端离线评论，双向互通在此闭环。
    const { repo, opts } = await bootstrap();
    const ident = await ensureLocalIdentity(opts.adapters.storage);
    const messages = (await outgoingGossip({ repo, myPubHex: ident.pubHex })).slice(0, GOSSIP_PAGE);
    return json({ messages, next_cursor: ctx.query.since ?? '0_' });
  },
};

onUnmounted(() => {
  stopShare();
});

void loadKey();
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
.row {
  display: flex;
  align-items: center;
  gap: 16rpx;
}
.label {
  display: block;
  font-size: 26rpx;
  color: #666;
  margin-bottom: 8rpx;
}
.input {
  border: 1rpx solid #ddd;
  border-radius: 8rpx;
  padding: 12rpx;
  margin-bottom: 12rpx;
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
