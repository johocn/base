<template>
  <view class="wrap">
    <text class="title">节点设置</text>
    <view class="field">
      <text class="label">节点地址</text>
      <input v-model="baseUrl" class="input" placeholder="http://118.190.217.242" />
    </view>
    <view class="field">
      <text class="label">节点公钥（hex64）</text>
      <input v-model="pubkey" class="input" placeholder="d75a9801…" />
    </view>
    <button size="mini" @click="save">保存</button>
    <text v-if="tip" class="tip">{{ tip }}</text>
    <text v-if="error" class="error">{{ error }}</text>

    <view class="acts">
      <button size="mini" class="probe" @click="probe">能力诊断</button>
      <button size="mini" class="probe" @click="openSelfCheck">基座自检</button>
    </view>
    <text v-for="(line, i) in probeLines" :key="i" class="meta">{{ line }}</text>

    <view class="ver">
      <text class="meta">当前版本：{{ localVersion }}</text>
      <button size="mini" @click="checkUpdate">检查更新</button>
      <text v-if="updateLine" class="meta">{{ updateLine }}</text>
    </view>

    <view class="identity">
      <text class="identity-title">账号与恢复</text>
      <navigator url="/pages/identity/backup" class="nav-link">账号托管与备份</navigator>
      <navigator url="/pages/identity/restore" class="nav-link">换手机恢复账号</navigator>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { bootstrap, updateNodeBaseUrl } from '../../platform';
import { plusRuntime } from '../../platform/uni';
import { decideUpdate, fetchReleaseDoc, promptUpdate } from '../../core/update';

// 生产默认值：只读分发节点（明文 :80）+ 源节点签发方公钥（based pubkey -issuer base-node-1）。
// 仅在本地未保存过配置时预填，保存后以本地配置为准；公钥是公开值，不是私钥。
const DEFAULT_BASE_URL = 'http://118.190.217.242';
const DEFAULT_PUBKEY = '48c33db9cf859e107fe89651d15fc5faaa8b16ffbb7d4b483aa167a0cff824f4';

const baseUrl = ref('');
const pubkey = ref('');
const tip = ref('');
const error = ref('');
const probeLines = ref<string[]>([]);
const localVersion = ref(String(plusRuntime()?.runtime?.version ?? '0.0.0'));
const updateLine = ref('');

onShow(async () => {
  try {
    const { repo } = await bootstrap();
    baseUrl.value = (await repo.getConfig('node_base_url')) ?? DEFAULT_BASE_URL;
    pubkey.value = (await repo.getConfig('pubkey_hex')) ?? DEFAULT_PUBKEY;
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
});

async function save() {
  try {
    const { repo } = await bootstrap();
    await repo.setConfig('node_base_url', baseUrl.value.trim());
    await repo.setConfig('pubkey_hex', pubkey.value.trim());
    updateNodeBaseUrl(baseUrl.value.trim());
    tip.value = '已保存';
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// 能力诊断：真机验收第一步，把平台能力与「本地到底存了多少正文」一次看清（Task 20）
async function probe() {
  const p = plusRuntime();
  const lines = [
    `plus 运行时：${p ? '有' : '无'}`,
    `plus.sqlite：${p?.sqlite ? '有' : '无'}`,
    `plus.io 文件接口：${p?.io.resolveLocalFileSystemURL ? '有' : '无'}`,
    `_doc 绝对路径：${p ? p.io.convertLocalFileSystemURL('_doc') : '-'}`,
  ];
  try {
    const { repo, db, opts } = await bootstrap();
    lines.push(`本地 items 条目：${(await repo.listItems()).length}`);
    lines.push(`本地 articles 正文：${Number((await db.select('SELECT count(*) AS n FROM articles'))[0]?.n ?? 0)}`);
    lines.push(`答题记录行数：${Number((await db.select('SELECT count(*) AS n FROM quiz_attempt'))[0]?.n ?? 0)}`);
    lines.push(`工作目录：${opts.workDir}`);
  } catch (e) {
    lines.push(`库存量查询失败：${(e as Error).message}`);
  }
  probeLines.value = lines;
}

/**
 * 升级通道的任何失败都静默：节点是明文 HTTP，不能让它成为可被用来 DoS 客户端的入口（spec §8.4 红线）。
 * 只有「已是最新」写结果行，其余情形不写任何 error。
 */
async function checkUpdate() {
  updateLine.value = '';
  try {
    const { repo, opts } = await bootstrap();
    if (!opts.nodeBaseUrl) return;
    const pubHex = await repo.getConfig('pubkey_hex');
    if (!pubHex) return;
    const doc = await fetchReleaseDoc(opts.adapters.http, opts.nodeBaseUrl, pubHex);
    if (!doc) return;
    const decision = decideUpdate(localVersion.value, doc.payload);
    if (decision === 'latest') {
      updateLine.value = `已是最新 ${localVersion.value}`;
      return;
    }
    if (decision === 'ignore') return;
    promptUpdate(doc, decision);
  } catch {
    // 静默：不把任何升级相关异常写进 error.value
  }
}

/** 自检页承载 12 条探测与降级标志；本页的「能力诊断」保持开发向的原始行输出不变。 */
function openSelfCheck() {
  uni.navigateTo({ url: '/pages/selfcheck/selfcheck' });
}
</script>

<style>
.wrap { padding: 16px; }
.title { font-size: 20px; font-weight: 600; }
.field { margin-top: 16px; }
.label { display: block; color: #666666; font-size: 13px; margin-bottom: 6px; }
.input { border: 1px solid #dddddd; border-radius: 6px; padding: 8px; font-size: 14px; }
.tip { display: block; color: #2f855a; font-size: 13px; margin-top: 8px; }
.error { display: block; color: #c53030; font-size: 13px; margin-top: 8px; }
.meta { display: block; color: #666666; font-size: 12px; margin-top: 4px; }
.acts { display: flex; margin-top: 24px; }
.probe { margin-right: 8px; }
.ver { margin-top: 24px; }
.identity { margin-top: 24px; padding-top: 12px; border-top: 1px solid #eeeeee; }
.identity-title { display: block; font-size: 14px; font-weight: 600; margin-bottom: 8px; }
.nav-link { display: block; color: #2b6cb0; font-size: 13px; padding: 6px 0; }
</style>