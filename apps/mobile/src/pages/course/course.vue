<template>
  <view class="wrap">
    <view class="bar">
      <text class="title">课程</text>
      <button size="mini" :disabled="busy || syncBlocked" @click="doSync">{{ busy ? '同步中…' : '同步' }}</button>
    </view>
    <view class="searchbox" @click="openSearch">
      <text class="searchtext">搜索标题与正文</text>
    </view>
    <text v-if="tip" class="tip">{{ tip }}</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="syncBlocked" class="error">本地文件不可写，无法同步（设置 → 基座自检 可看原因）</text>
    <text v-if="total === 0 && !error" class="hint">还没有内容，点「同步」从节点拉取。</text>
    <text v-if="courses.length > 0" class="group">课程</text>
    <view v-for="it in courses" :key="it.itemId" class="item" @click="openCourse(it.itemId)">
      <text class="item-title">{{ it.title }}</text>
      <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
    </view>
    <text v-if="ungrouped.length > 0" class="group">未归类</text>
    <view v-for="it in ungrouped" :key="it.itemId" class="item" @click="openArticle(it.itemId)">
      <text class="item-title">{{ it.title }}</text>
      <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { syncOnce } from '../../core/sync';
import { splitCourses } from '../../core/course-tree';
import type { ItemRow } from '../../core/types';
import { bootstrap } from '../../platform';
import { canSync } from '../../core/selfcheck';

const courses = ref<ItemRow[]>([]);
const ungrouped = ref<ItemRow[]>([]);
const total = computed(() => courses.value.length + ungrouped.value.length);
const error = ref('');
const tip = ref('');
const busy = ref(false);
const syncBlocked = ref(false);

async function load() {
  try {
    const { repo, capabilities } = await bootstrap();
    syncBlocked.value = !canSync(capabilities);
    const all = await repo.listItems();
    const active = all.filter((i) => i.state !== 'removed');
    const tree = splitCourses(active);
    courses.value = tree.courses;
    ungrouped.value = tree.ungrouped;
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
      tip.value = '请先在「我的 → 设置」里填写节点地址与公钥';
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

function openSearch() {
  uni.navigateTo({ url: '/pages/search/search' });
}

function openArticle(itemId: string) {
  uni.navigateTo({ url: `/pages/article/article?itemId=${encodeURIComponent(itemId)}` });
}

function openCourse(itemId: string) {
  uni.navigateTo({ url: `/pages/course/detail?courseId=${encodeURIComponent(itemId)}` });
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
.searchbox { padding: 10px 12px; margin: 8px 0 12px; background: #f5f5f5; border-radius: 6px; }
.searchtext { color: #999999; font-size: 14px; }
.group { display: block; margin: 16px 0 4px; color: #888888; font-size: 13px; }
</style>