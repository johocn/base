<template>
  <view class="wrap">
    <text class="title">全部标签</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="!error && rows.length === 0" class="hint">还没有标签</text>
    <view v-for="r in rows" :key="r.itemId" class="card" @click="open(r.itemId)">
      <text class="t">{{ r.title || r.itemId }}</text>
      <text class="meta">{{ r.itemId }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import type { ItemRow } from '../../core/types';
import { bootstrap } from '../../platform';

const rows = ref<ItemRow[]>([]);
const error = ref('');

// onShow 而不是 onLoad：从详情页或补标签页返回后条数可能已变
onShow(async () => {
  error.value = '';
  try {
    const { repo } = await bootstrap();
    rows.value = (await repo.listItems())
      .filter((i) => i.type === 'tag')
      .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  } catch (e) {
    error.value = (e as Error).message;
  }
});

function open(tagId: string) {
  uni.navigateTo({ url: `/pages/tag/detail?tagId=${encodeURIComponent(tagId)}` });
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 12px; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.t { display: block; font-size: 15px; }
.meta { display: block; color: #888888; font-size: 12px; }
.hint { color: #888888; font-size: 13px; }
.error { display: block; color: #c53030; font-size: 13px; }
</style>
