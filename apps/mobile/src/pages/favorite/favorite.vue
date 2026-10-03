<template>
  <view class="wrap">
    <text v-if="rows.length === 0" class="hint">还没有收藏，在文章页点收藏会出现在这里。</text>
    <view v-for="r in rows" :key="r.itemId" class="card" @click="open(r.itemId)">
      <text class="t">{{ r.title }}</text>
      <text class="meta">收藏于 {{ r.favoritedAt.slice(0, 10) }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import type { FavoriteRow } from '../../core/types';
import { bootstrap } from '../../platform';

const rows = ref<FavoriteRow[]>([]);

// onShow：从阅读器取消收藏返回后立刻消失
onShow(async () => {
  try {
    const { repo } = await bootstrap();
    rows.value = await repo.listFavorites();
  } catch {
    rows.value = [];
  }
});

function open(itemId: string) {
  uni.navigateTo({ url: `/pages/article/article?itemId=${encodeURIComponent(itemId)}` });
}
</script>

<style>
.wrap { padding: 16px; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.t { display: block; font-size: 15px; }
.meta { display: block; color: #888888; font-size: 12px; }
.hint { display: block; color: #888888; font-size: 13px; }
</style>