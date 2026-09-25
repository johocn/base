<template>
  <view class="wrap">
    <view class="bar">
      <text class="title">内容</text>
      <button size="mini" :disabled="busy" @click="doSync">{{ busy ? '同步中…' : '同步' }}</button>
    </view>
    <text v-if="tip" class="tip">{{ tip }}</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="items.length === 0 && !error" class="hint">还没有内容，点「同步」从节点拉取。</text>
    <view v-for="it in items" :key="it.itemId" class="item" @click="open(it.itemId)">
      <text class="item-title">{{ it.title }}</text>
      <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
    </view>
    <navigator url="/pages/setting/setting" class="link">节点设置</navigator>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { syncOnce } from '../../core/sync';
import type { ItemRow } from '../../core/types';
import { bootstrap } from '../../platform';

const items = ref<ItemRow[]>([]);
const error = ref('');
const tip = ref('');
const busy = ref(false);

async function load() {
  try {
    const { repo } = await bootstrap();
    items.value = (await repo.listItems()).filter((i) => i.type === 'article');
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function doSync() {
  busy.value = true;
  tip.value = '';
  try {
    const { opts } = await bootstrap();
    if (!opts.nodeBaseUrl) {
      tip.value = '请先在「节点设置」里填写节点地址与公钥';
      return;
    }
    const res = await syncOnce(opts);
    tip.value =
      res.status === 'noop'
        ? '已是最新版本'
        : `已更新到版本 ${res.contentVersion}（条目 ${res.items}，块 ${res.blobs}）`;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function open(itemId: string) {
  uni.navigateTo({ url: `/pages/article/article?itemId=${encodeURIComponent(itemId)}` });
}

onShow(() => {
  void load();
});
</script>

<style>
.wrap { padding: 16px; }
.bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.title { font-size: 20px; font-weight: 600; }
.item { padding: 12px 0; border-bottom: 1px solid #eeeeee; }
.item-title { font-size: 17px; }
.meta { display: block; color: #888888; font-size: 12px; }
.hint { color: #888888; }
.tip { color: #2f855a; font-size: 13px; }
.error { color: #c53030; font-size: 13px; }
.link { display: block; margin-top: 20px; color: #2b6cb0; }
</style>