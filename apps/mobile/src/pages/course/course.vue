<template>
  <view class="wrap">
    <view class="bar">
      <text class="title">课程</text>
      <button size="mini" @click="createCourse">新建课程</button>
      <button size="mini" :disabled="busy || syncBlocked" @click="doSync">{{ busy ? '同步中…' : '同步' }}</button>
    </view>
    <view class="searchbox" @click="openSearch">
      <text class="searchtext">搜索标题与正文</text>
    </view>
    <view class="sec">
      <text class="sec-title">我创建的（{{ myCreated.length }}）</text>
      <text v-if="myCreated.length === 0" class="hint">还没有我创建的内容</text>
      <view v-for="row in myCreated" :key="row.itemId" class="item" @click="openMyCreated(row)">
        <text class="item-title">{{ typeLabel(row.type) }} · {{ row.title }}</text>
        <text class="meta" :style="`color:${statusColor(row.state)}`">{{ row.statusLabel }}</text>
        <text v-if="row.reason !== ''" class="reason">{{ row.reason }}</text>
      </view>
    </view>
    <text v-if="tip" class="tip">{{ tip }}</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="syncBlocked" class="error">本地文件不可写，无法同步（设置 → 基座自检 可看原因）</text>
    <text v-if="total === 0 && !error" class="hint">还没有内容，点「同步」从节点拉取。</text>
    <block v-if="groups.length > 0">
      <block v-for="g in groups" :key="g.slug">
        <text class="group group-cat" @click="toggle(g.slug)">
          {{ collapsed[g.slug] ? '▸ ' : '▾ ' }}{{ g.title }}
        </text>
        <block v-if="!collapsed[g.slug]">
          <view v-for="it in g.courses" :key="it.itemId" class="item" @click="openCourse(it.itemId)">
            <text class="item-title">{{ it.title }}</text>
            <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
          </view>
        </block>
      </block>
      <text v-if="unclassified.length > 0" class="group">未归类课程</text>
      <view v-for="it in unclassified" :key="it.itemId" class="item" @click="openCourse(it.itemId)">
        <text class="item-title">{{ it.title }}</text>
        <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
      </view>
      <text v-if="standalone.length > 0" class="group">独立内容</text>
      <view v-for="it in standalone" :key="it.itemId" class="item" @click="openStandalone(it)">
        <text class="item-title">{{ it.title }}</text>
        <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
      </view>
    </block>
    <block v-else>
      <text v-if="courses.length > 0" class="group">课程</text>
      <view v-for="it in courses" :key="it.itemId" class="item" @click="openCourse(it.itemId)">
        <text class="item-title">{{ it.title }}</text>
        <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
      </view>
      <text v-if="standalone.length > 0" class="group">未归类</text>
      <view v-for="it in standalone" :key="it.itemId" class="item" @click="openStandalone(it)">
        <text class="item-title">{{ it.title }}</text>
        <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
      </view>
    </block>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { syncOnce } from '../../core/sync';
import { groupCoursesByCategory, splitCourses } from '../../core/course-tree';
import { buildMyCreatedView, type MyCreatedRow, type MyCreatedType } from '../../core/my-created';
import type { ItemRow, SegmentRow } from '../../core/types';
import { bootstrap } from '../../platform';
import { canSync } from '../../core/selfcheck';

interface CategoryGroupVM {
  slug: string;
  title: string;
  courses: ItemRow[];
}

const courses = ref<ItemRow[]>([]);
const groups = ref<CategoryGroupVM[]>([]);
const unclassified = ref<ItemRow[]>([]);
const standalone = ref<ItemRow[]>([]);
const collapsed = ref<Record<string, boolean>>({});
const myCreated = ref<MyCreatedRow[]>([]);
const total = computed(
  () => courses.value.length + groups.value.reduce((n, g) => n + g.courses.length, 0) + standalone.value.length,
);
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

    // 分类分组（册子 #49 §3）：双来源 + 优先级，组标题与未归类口径都由纯函数给出。
    // 需要课程自身的 attr.category（逐课程取 segments）与分类清单行（逐分类取 segments）；只读、零写入。
    const segsByItemId = new Map<string, SegmentRow[]>();
    for (const it of active) {
      if (it.type === 'course' || it.source === 'category') {
        segsByItemId.set(it.itemId, await repo.listSegments(it.itemId));
      }
    }
    const { groups: built, unclassified: orphan } = groupCoursesByCategory(active, segsByItemId);
    groups.value = built;
    unclassified.value = orphan;

    // 独立内容 = 独立文章 article/<aid> ∪ 独立题库 quiz/<qid>（册子 §5.2）
    standalone.value = [
      ...tree.ungrouped,
      ...active.filter((i) => i.type === 'quiz' && i.itemId.startsWith('quiz/')),
    ].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

    // 「我创建的」区（册子 #51 §3）：台账行集 + 包表 id 集合（复用上面已取的 all，不重复查询）。
    // 去重全在 buildMyCreatedView 内，此处只消费结果。
    const subs = await repo.listSubmissions();
    myCreated.value = buildMyCreatedView(subs, new Set(all.map((i) => i.itemId)));

    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function toggle(itemId: string) {
  collapsed.value = { ...collapsed.value, [itemId]: !collapsed[itemId] };
}

function openStandalone(it: ItemRow) {
  if (it.type === 'quiz') {
    uni.navigateTo({ url: `/pages/quiz/quiz?itemId=${encodeURIComponent(it.itemId)}` });
    return;
  }
  openArticle(it.itemId);
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

function createCourse() {
  uni.navigateTo({ url: '/pages/course/edit' });
}

function openArticle(itemId: string) {
  uni.navigateTo({ url: `/pages/article/article?itemId=${encodeURIComponent(itemId)}` });
}

function openCourse(itemId: string) {
  uni.navigateTo({ url: `/pages/course/detail?courseId=${encodeURIComponent(itemId)}` });
}

const TYPE_LABEL: Record<MyCreatedType, string> = { course: '课程', lesson: '课时', article: '文章', quiz: '题库' };

function typeLabel(t: MyCreatedType): string {
  return TYPE_LABEL[t];
}

/** 状态色照「我的条目」页既有色值：待补发 / 失败 / 已同步。 */
function statusColor(state: MyCreatedRow['state']): string {
  return state === 'pending' ? '#b7791f' : state === 'failed' ? '#c53030' : '#888888';
}

/**
 * 点开「我创建的」行 → 走既有详情页路由并带 `from=ledger`，详情页据此改从台账行集渲染。
 * 课时行：台账无 courseId 字段，按 id 形态 `course/<cid>/lesson/<lid>` 剥出（与 lesson/detail 既有口径同源）。
 */
function openMyCreated(row: MyCreatedRow) {
  const id = encodeURIComponent(row.itemId);
  if (row.type === 'course') {
    uni.navigateTo({ url: `/pages/course/detail?courseId=${id}&from=ledger` });
    return;
  }
  if (row.type === 'lesson') {
    const mid = row.itemId.indexOf('/lesson/');
    const cid = mid > 0 ? row.itemId.slice(0, mid) : '';
    uni.navigateTo({
      url: `/pages/lesson/detail?courseId=${encodeURIComponent(cid)}&lessonId=${id}&from=ledger`,
    });
    return;
  }
  const page = row.type === 'quiz' ? 'quiz/quiz' : 'article/article';
  uni.navigateTo({ url: `/pages/${page}?itemId=${id}&from=ledger` });
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
.sec { margin-bottom: 18px; }
.sec-title { display: block; font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.reason { display: block; color: #c53030; font-size: 13px; }
.group { display: block; margin: 16px 0 4px; color: #888888; font-size: 13px; }
.group-cat { color: #2b6cb0; }
</style>