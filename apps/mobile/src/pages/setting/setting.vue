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

    <button size="mini" class="probe" @click="probe">能力诊断</button>
    <text v-for="(line, i) in probeLines" :key="i" class="meta">{{ line }}</text>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { bootstrap, updateNodeBaseUrl } from '../../platform';
import { plusRuntime } from '../../platform/uni';

// 生产默认值：只读分发节点（明文 :80）+ 源节点签发方公钥（based pubkey -issuer base-node-1）。
// 仅在本地未保存过配置时预填，保存后以本地配置为准；公钥是公开值，不是私钥。
const DEFAULT_BASE_URL = 'http://118.190.217.242';
const DEFAULT_PUBKEY = '48c33db9cf859e107fe89651d15fc5faaa8b16ffbb7d4b483aa167a0cff824f4';

const baseUrl = ref('');
const pubkey = ref('');
const tip = ref('');
const error = ref('');
const probeLines = ref<string[]>([]);

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

// 能力诊断：真机验收第一步，把平台能力有没有一次看清（Task 20）
function probe() {
  const u = globalThis as unknown as Record<string, unknown>;
  const uniAny = u.uni as { getFileSystemManager?: () => unknown } | undefined;
  const p = plusRuntime();
  probeLines.value = [
    `plus 运行时：${p ? '有' : '无'}`,
    `plus.sqlite：${p?.sqlite ? '有' : '无'}`,
    `uni.getFileSystemManager：${typeof uniAny?.getFileSystemManager === 'function' ? '有' : '无'}`,
    `_doc 绝对路径：${p ? p.io.convertLocalFileSystemURL('_doc') : '-'}`,
  ];
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
.probe { margin-top: 24px; }
</style>