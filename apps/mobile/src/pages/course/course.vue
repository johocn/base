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
        <text v-if="row.localOnly" class="act" @click.stop="removeMyCreated(row)">删除</text>
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
            <text class="item-title" :class="titleColorOf(it.itemId) ? 'c-' + titleColorOf(it.itemId) : ''">{{ it.title }}</text>
            <view v-if="badgesOf(it.itemId).length > 0" class="chips">
              <text v-for="b in badgesOf(it.itemId)" :key="b" class="badge">{{ b }}</text>
            </view>
            <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
            <text v-if="completionText(it.itemId)" class="meta">{{ completionText(it.itemId) }}</text>
          </view>
        </block>
      </block>
      <text v-if="unclassified.length > 0" class="group">未归类课程</text>
      <view v-for="it in unclassified" :key="it.itemId" class="item" @click="openCourse(it.itemId)">
        <text class="item-title" :class="titleColorOf(it.itemId) ? 'c-' + titleColorOf(it.itemId) : ''">{{ it.title }}</text>
        <view v-if="badgesOf(it.itemId).length > 0" class="chips">
          <text v-for="b in badgesOf(it.itemId)" :key="b" class="badge">{{ b }}</text>
        </view>
        <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
        <text v-if="completionText(it.itemId)" class="meta">{{ completionText(it.itemId) }}</text>
      </view>
      <text v-if="standalone.length > 0" class="group">独立内容</text>
      <view v-for="it in standalone" :key="it.itemId" class="item" @click="openStandalone(it)">
        <text class="item-title" :class="titleColorOf(it.itemId) ? 'c-' + titleColorOf(it.itemId) : ''">{{ it.title }}</text>
        <view v-if="badgesOf(it.itemId).length > 0" class="chips">
          <text v-for="b in badgesOf(it.itemId)" :key="b" class="badge">{{ b }}</text>
        </view>
        <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
      </view>
    </block>
    <block v-else>
      <text v-if="courses.length > 0" class="group">课程</text>
      <view v-for="it in courses" :key="it.itemId" class="item" @click="openCourse(it.itemId)">
        <text class="item-title" :class="titleColorOf(it.itemId) ? 'c-' + titleColorOf(it.itemId) : ''">{{ it.title }}</text>
        <view v-if="badgesOf(it.itemId).length > 0" class="chips">
          <text v-for="b in badgesOf(it.itemId)" :key="b" class="badge">{{ b }}</text>
        </view>
        <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
        <text v-if="completionText(it.itemId)" class="meta">{{ completionText(it.itemId) }}</text>
      </view>
      <text v-if="standalone.length > 0" class="group">未归类</text>
      <view v-for="it in standalone" :key="it.itemId" class="item" @click="openStandalone(it)">
        <text class="item-title" :class="titleColorOf(it.itemId) ? 'c-' + titleColorOf(it.itemId) : ''">{{ it.title }}</text>
        <view v-if="badgesOf(it.itemId).length > 0" class="chips">
          <text v-for="b in badgesOf(it.itemId)" :key="b" class="badge">{{ b }}</text>
        </view>
        <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
      </view>
    </block>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { syncOnce } from '../../core/sync';
import { runCreatorVisibilityMigration } from '../../core/creator-migrate';
import { childrenOf, groupCoursesByCategory, splitCourses } from '../../core/course-tree';
import { attrsOf } from '../../core/container-view';
import { buildMyCreatedView, type MyCreatedRow, type MyCreatedType } from '../../core/my-created';
import type { ItemRow, ProgressRow, SegmentRow } from '../../core/types';
import { bootstrap } from '../../platform';
import { canSync } from '../../core/selfcheck';
import type { LocalRepo } from '../../core/repo';
import { lessonCompleted } from '../../core/progress';

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
// 图章与标题色（册子 #53 §2.5）：只读派生映射，仅供展示；无属性行则空数组 / 空串
const marksByItemId = ref(new Map<string, { badge: string[]; titleColor: string }>());
/** 每门课的完成度（已学 a / b 讲）；分母为 0 的课**不入 Map** ⇒ 模板不显示该行（#8 册子 §6） */
const completionByCourse = ref(new Map<string, { done: number; total: number }>());
const total = computed(
  () => courses.value.length + groups.value.reduce((n, g) => n + g.courses.length, 0) + standalone.value.length,
);
const error = ref('');
const tip = ref('');
const busy = ref(false);
const syncBlocked = ref(false);

/**
 * 一门课的完成度（#8 册子 §6）。分母 = **可达** lesson 数，分子 = 其中「可达叶子非空且全 done」的 lesson 数。
 * 未下载的子条目（不在本地 `items` 里）**不计入分母**；分母为 0 时由调用方不显示该行（不是显示 0 / 0）。
 * 只用于展示：**不产生事件、不落表**。
 */
async function courseCompletion(
  courseId: string,
  repo: LocalRepo,
  byId: Map<string, ItemRow>,
  progressByItem: Map<string, ProgressRow>,
): Promise<{ done: number; total: number }> {
  let done = 0;
  let total = 0;
  for (const lessonId of childrenOf(await repo.listSegments(courseId))) {
    if (!byId.has(lessonId)) continue;
    const leafDone: boolean[] = [];
    for (const leafId of childrenOf(await repo.listSegments(lessonId))) {
      const leaf = byId.get(leafId);
      if (!leaf) continue;
      // 叶子载体只有这三类才有 position / done（#8 册子 §3.2）
      if (leaf.type !== 'article' && leaf.type !== 'video' && leaf.type !== 'quiz') continue;
      leafDone.push(progressByItem.get(leafId)?.done === true);
    }
    if (leafDone.length === 0) continue;
    total += 1;
    if (lessonCompleted(leafDone)) done += 1;
  }
  return { done, total };
}

/** 「已学 a / b 讲」；无数据（分母 0）返回空串 ⇒ 模板不显示该行。 */
function completionText(courseId: string): string {
  const c = completionByCourse.value.get(courseId);
  return c ? `已学 ${c.done} / ${c.total} 讲` : '';
}

async function load() {
  try {
    const { repo, capabilities, opts } = await bootstrap();
    syncBlocked.value = !canSync(capabilities);
    // 一次性自愈迁移（册子 #56 §2.4）：幂等——标志位已存在即零动作；未配置节点则跳过。
    if (opts.nodeBaseUrl !== '') {
      await runCreatorVisibilityMigration(opts);
    }
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

    // 图章与标题色（册子 #53 §2.5）：只读派生，仅供展示；无属性行则空数组 / 空串
    const marks = new Map<string, { badge: string[]; titleColor: string }>();
    for (const [id, segs] of segsByItemId) {
      const a = attrsOf(segs);
      marks.set(id, { badge: a.badge, titleColor: a.titleColor });
    }
    marksByItemId.value = marks;

    // 每门课的完成度（#8 册子 §6）：只读派生，复用上面已建的 segsByItemId；零写入。
    const byId = new Map(active.map((i) => [i.itemId, i]));
    const progressByItem = new Map((await repo.listProgress()).map((r) => [r.itemId, r]));
    const completion = new Map<string, { done: number; total: number }>();
    for (const it of active) {
      if (it.type !== 'course') continue;
      const c = await courseCompletion(it.itemId, repo, byId, progressByItem);
      if (c.total > 0) completion.set(it.itemId, c);
    }
    completionByCourse.value = completion;

    // 独立内容 = 独立文章 article/<aid> ∪ 独立题库 quiz/<qid>（册子 §5.2）
    standalone.value = [
      ...tree.ungrouped,
      ...active.filter((i) => i.type === 'quiz' && i.itemId.startsWith('quiz/')),
    ].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

    // 「我创建的」区（册子 #51 §3）：台账行集 + 包表 id 集合（复用上面已取的 all，不重复查询）。
    // 去重全在 buildMyCreatedView 内，此处只消费结果。
    const subs = await repo.listSubmissions();
    const packIds = new Set(all.filter((i) => i.source !== 'local').map((i) => i.itemId));
    myCreated.value = buildMyCreatedView(subs, packIds);

    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function badgesOf(itemId: string): string[] {
  return marksByItemId.value.get(itemId)?.badge ?? [];
}

function titleColorOf(itemId: string): string {
  return marksByItemId.value.get(itemId)?.titleColor ?? '';
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
        ? '节点内容未更新'
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

/** 删除「仅本地留存」台账行（册子 #56 §2.4 / §7 风险 4：终态必须有手动删除入口）。 */
async function removeMyCreated(row: MyCreatedRow) {
  const { repo } = await bootstrap();
  await repo.removeSubmission(row.itemId);
  await load();
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
.act { display: inline-block; color: #2b6cb0; font-size: 14px; margin-top: 4px; }
.group { display: block; margin: 16px 0 4px; color: #888888; font-size: 13px; }
.group-cat { color: #2b6cb0; }
.chips { display: flex; flex-wrap: wrap; margin-top: 4px; }
.badge { display: inline-block; font-size: 12px; color: #666666; border: 1px solid #dddddd; border-radius: 10px; padding: 0 8px; margin-right: 6px; }
.c-red { color: #C53030; }
.c-orange { color: #B7791F; }
.c-green { color: #2F855A; }
.c-blue { color: #2B6CB0; }
.c-purple { color: #6B46C1; }
.c-gray { color: #718096; }
</style>