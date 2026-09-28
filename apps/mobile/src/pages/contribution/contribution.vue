<template>
  <view class="wrap">
    <text class="title">我的贡献</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <view class="card">
      <text class="label">公开昵称</text>
      <input v-model="name" class="input" placeholder="1–32 字" />
      <text class="act" @click="save">保存昵称</text>
      <text class="meta">昵称与名册不做跨节点同步</text>
    </view>

    <text class="sec-title">贡献前 10 名</text>
    <text v-if="contributors.length === 0" class="empty">暂无贡献者</text>
    <view v-for="c in contributors" :key="c.id" class="card" :class="c.id === myId ? 'me' : ''">
      <text class="t">{{ c.name }}</text>
      <text class="meta">{{ c.count }} 条 · {{ c.id.slice(0, 8) }}</text>
    </view>

    <view v-if="!inRoster" class="card">
      <text class="meta">未入前 10</text>
      <text class="meta">我的 id：{{ myIdShort }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { myIdentityId, putName, roster, type ContributorItem } from '../../core/contribution';
import { bootstrap } from '../../platform';

const contributors = ref<ContributorItem[]>([]);
const myId = ref('');
const name = ref('');
const error = ref('');
const notice = ref('');

const myIdShort = computed(() => (myId.value === '' ? '（本机还没有身份）' : myId.value.slice(0, 8)));
const inRoster = computed(() => myId.value !== '' && contributors.value.some((c) => c.id === myId.value));

onShow(async () => {
  error.value = '';
  try {
    const { opts, repo } = await bootstrap();
    const o = { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl };
    myId.value = await myIdentityId(o);
    contributors.value = await roster(o);
    const mine = contributors.value.find((c) => c.id === myId.value);
    if (mine) name.value = mine.name;
  } catch (e) {
    error.value = (e as Error).message;
  }
});

async function save() {
  error.value = '';
  notice.value = '';
  try {
    const { opts, repo } = await bootstrap();
    const o = { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl };
    await putName(o, name.value.trim());
    contributors.value = await roster(o);
    notice.value = '昵称已保存';
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 12px; }
.sec-title { display: block; font-size: 15px; font-weight: 600; margin: 14px 0 8px; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.me { border-color: #2b6cb0; }
.label { display: block; font-size: 14px; color: #666666; margin-bottom: 6px; }
.t { display: block; font-size: 15px; }
.meta { display: block; color: #888888; font-size: 12px; margin-top: 2px; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: 14px; }
.act { display: block; color: #2b6cb0; font-size: 14px; margin-top: 10px; }
.empty { display: block; color: #999999; font-size: 13px; padding: 6px 0; }
.error { display: block; color: #c53030; font-size: 13px; margin-bottom: 8px; }
.notice { display: block; color: #b7791f; font-size: 13px; margin-bottom: 8px; }
</style>