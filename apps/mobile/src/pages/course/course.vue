<template>
  <view class="page">
    <view class="hero">
      <text class="hero-title">base 学习</text>
    </view>
    <input class="search" placeholder="搜索课程与文章" :value="keyword" @input="onSearch" />
    <!-- B 宫格区：2×2（册子 §3.2）；tabBar 页走 switchTab -->
    <view class="grid">
      <view class="cell" @click="go('/pages/course/course')"><text class="cell-ico">📚</text><text class="cell-tx">学课程</text></view>
      <view class="cell" @click="go('/pages/search/search')"><text class="cell-ico">📰</text><text class="cell-tx">看文章</text></view>
      <view class="cell" @click="go('/pages/submit/submit')"><text class="cell-ico">✍️</text><text class="cell-tx">去投稿</text></view>
      <view class="cell" @click="go('/pages/mine/mine')"><text class="cell-ico">👤</text><text class="cell-tx">我的</text></view>
    </view>
    <!-- A 大卡瀑布区：最近更新（课程/文章混合） -->
    <view class="feed">
      <text class="feed-head">最近更新</text>
      <text v-if="rows.length === 0" class="feed-hint">{{ keyword.trim() === '' ? '还没有内容' : '没搜到' }}</text>
      <view class="card" v-for="row in rows" :key="row.itemId" @click="open(row)">
        <text class="card-title">{{ row.title }}</text>
        <text class="card-meta">{{ row.meta }}</text>
      </view>
      <text v-if="error" class="feed-error">{{ error }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { syncOnce } from '../../core/sync';
import { runCreatorVisibilityMigration, runLedgerHealMigration } from '../../core/creator-migrate';
import { childrenOf, groupCoursesByCategory, splitCourses } from '../../core/course-tree';
import { attrsOf } from '../../core/container-view';
import { displayOf, loadDirectory, normalizeTermKey, termState, type DirectorySnapshot, type PendingTerm } from '../../core/directory';
import { buildMyCreatedView, canRemoveMyCreated, containerFormFromLedger, type MyCreatedRow, type MyCreatedType } from '../../core/my-created';
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
/** 「我创建的」提示行：itemId -> 「分类待票选 · 已有 n/N 票」（#58 §5.2） */
const categoryHints = ref(new Map<string, string>());
/** 目录快照（三态判定用）：进入页面时读本地缓存，模板只读 */
const directory = ref<DirectorySnapshot>({ version: 0, approved: new Map(), pending: new Map() });
// 图章与标题色（册子 #53 §2.5）：只读派生映射，仅供展示；无属性行则空数组 / 空串
const marksByItemId = ref(new Map<string, { badge: string[]; titleColor: string }>());
/** 每门课的完成度（已学 a / b 讲）；分母为 0 的课**不入 Map** ⇒ 模板不显示该行（#8 册子 §6） */
const completionByCourse = ref(new Map<string, { done: number; total: number }>());
/** 课程封面图路径；key=courseItemId → 本地 blob 路径（无封面不入 Map） */
const coverByCourse = ref(new Map<string, string>());
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

/** 完成度百分比 & 是否全完成；无数据返回 null ⇒ 模板不渲染进度条。 */
function completionPercent(courseId: string): { percent: number; done: boolean } | null {
  const c = completionByCourse.value.get(courseId);
  if (!c || c.total === 0) return null;
  const percent = Math.round((c.done / c.total) * 100);
  return { percent, done: c.done === c.total };
}

/** 课程封面图路径；无封面返回空串 ⇒ 模板不渲染封面缩略图。 */
function courseCover(itemId: string): string {
  return coverByCourse.value.get(itemId) ?? '';
}

async function load() {
  try {
    const { repo, capabilities, opts } = await bootstrap();
    directory.value = await loadDirectory(repo);
    syncBlocked.value = !canSync(capabilities);
    // 一次性自愈迁移（册子 #56 §2.4）：幂等——标志位已存在即零动作；未配置节点则跳过。
    if (opts.nodeBaseUrl !== '') {
      await runCreatorVisibilityMigration(opts);
    }
    // 存量台账自愈（册子 #63 §2.2）：纯本地、不依赖节点地址 ⇒ 放在上面判据之外，串行执行。
    await runLedgerHealMigration({ repo });
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
    // 循环内顺便查课程封面：cover item_id 约定 = {courseId}/cover（文章页同口径），零封面不入 Map。
    const byId = new Map(active.map((i) => [i.itemId, i]));
    const progressByItem = new Map((await repo.listProgress()).map((r) => [r.itemId, r]));
    const completion = new Map<string, { done: number; total: number }>();
    const covers = new Map<string, string>();
    for (const it of active) {
      if (it.type !== 'course') continue;
      const c = await courseCompletion(it.itemId, repo, byId, progressByItem);
      if (c.total > 0) completion.set(it.itemId, c);
      const p = await repo.findBlobPathByItem(`${it.itemId}/cover`);
      if (p) covers.set(it.itemId, p.startsWith('file://') ? p : `file://${p}`);
    }
    completionByCourse.value = completion;
    coverByCourse.value = covers;

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

    // 「分类待票选 · 已有 n/N 票」提示行（#58 §5.2）：只加提示行，不改主展示。
    const hints = new Map<string, string>();
    for (const sub of subs) {
      if (sub.type !== 'course') continue;
      const key = normalizeTermKey(containerFormFromLedger(sub).category) ?? '';
      if (key === '') continue;
      let term: PendingTerm | undefined;
      for (const cand of directory.value.pending.values()) {
        if (cand.kind === 'category' && cand.termKey === key) {
          term = cand;
          break;
        }
      }
      if (term) hints.set(sub.itemId, `分类待票选 · 已有 ${term.votes}/${term.threshold} 票`);
    }
    categoryHints.value = hints;

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

/** 分类分组头的展示名（#58 §5.2）：词条键走目录展示名，键非法则回落既有组标题。 */
function groupTitle(g: CategoryGroupVM): string {
  const key = normalizeTermKey(g.slug) ?? '';
  return key === '' ? g.title : displayOf(directory.value, 'category', key);
}

/** 分类分组头三态（#58 §5.1）：词条键非空且未 approved ⇒ 加「待票选」角标。 */
function groupPending(g: CategoryGroupVM): boolean {
  const key = normalizeTermKey(g.slug) ?? '';
  return termState(directory.value, 'category', key) === 'pending';
}

/** 「我创建的」提示行文案（无则空串 ⇒ 模板不显示）。 */
function categoryHint(itemId: string): string {
  return categoryHints.value.get(itemId) ?? '';
}

function toggle(itemId: string) {
  collapsed.value = { ...collapsed.value, [itemId]: !collapsed.value[itemId] };
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

/** 发表文章入口（册子 #65 §4）：复用既有投稿页（内部已是「文章 / 题库」双 tab），零新页面。 */
function publishArticle() {
  uni.navigateTo({ url: '/pages/submit/submit' });
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

/** 首页搜索关键字：本地过滤「最近更新」大卡流（册子 §3.2 大搜索框） */
const keyword = ref('');

/** 大卡流行视图：大字标题 + 标注字 meta（类型 · 更新日期） */
interface FeedRow {
  itemId: string;
  title: string;
  meta: string;
  kind: string;
  updatedAt: string;
}

const FEED_LABEL: Record<string, string> = { course: '课程', article: '文章', quiz: '题库' };

/** 「最近更新」大卡流（册子 §3.2 A 瀑布区）：课程 ∪ 独立内容，updatedAt 倒序，关键字本地过滤。 */
const rows = computed<FeedRow[]>(() => {
  const kw = keyword.value.trim().toLowerCase();
  const all: FeedRow[] = [...courses.value, ...standalone.value].map((it) => ({
    itemId: it.itemId,
    title: it.title || it.itemId,
    kind: it.type,
    updatedAt: it.updatedAt || '',
    meta: `${FEED_LABEL[it.type] ?? it.type} · ${(it.updatedAt || '').slice(0, 10)}`,
  }));
  const filtered =
    kw === '' ? all : all.filter((r) => r.title.toLowerCase().includes(kw) || r.itemId.toLowerCase().includes(kw));
  return filtered.sort((a, b) =>
    a.updatedAt === b.updatedAt ? (a.itemId < b.itemId ? -1 : 1) : a.updatedAt < b.updatedAt ? 1 : -1,
  );
});

/** 宫格跳转：tabBar 页走 switchTab（tab 页不可 navigateTo），其余 navigateTo。 */
const TAB_PATHS = new Set(['/pages/course/course', '/pages/circle/circle', '/pages/comment/comment', '/pages/mine/mine']);

function go(url: string) {
  if (TAB_PATHS.has(url)) {
    uni.switchTab({ url });
    return;
  }
  uni.navigateTo({ url });
}

function onSearch(e: Event) {
  const detail = (e as { detail?: { value?: string } }).detail;
  keyword.value = detail?.value ?? '';
}

/** 大卡点开：沿用既有详情跳转（课程→课程详情，题库→答题页，其余→文章页）。 */
function open(row: FeedRow) {
  if (row.kind === 'course') {
    openCourse(row.itemId);
    return;
  }
  if (row.kind === 'quiz') {
    uni.navigateTo({ url: `/pages/quiz/quiz?itemId=${encodeURIComponent(row.itemId)}` });
    return;
  }
  openArticle(row.itemId);
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

/** 删除台账行（册子 #61 §4.3）：台账行 + 本机乐观条目一起清，否则课程列表里仍留着它。 */
async function removeMyCreated(row: MyCreatedRow) {
  const { repo } = await bootstrap();
  await repo.removeSubmission(row.itemId);
  await repo.removeLocalContainer(row.itemId);
  await load();
}

onShow(() => {
  void load();
});
</script>

<style>
/* 首页适老重排（册子 §3.2 A+B 融合）：字号全部引用全局字阶令牌（#84） */
.page { padding-bottom: 32px; }
.hero { padding: 16px 16px 0; }
.hero-title { font-size: var(--fs-title); font-weight: 600; }
.search { height: 48px; border-radius: 24px; background: #fff; border: 1px solid #d9e1ea; padding: 0 20px; font-size: var(--fs-body); margin: 12px 16px; }
.grid { display: flex; flex-wrap: wrap; padding: 0 8px; }
.cell { width: 50%; box-sizing: border-box; padding: 8px; min-height: 96px; }
.cell { background: #fff; border: 1px solid #d9e1ea; border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.cell:active { background: #f7fafc; }
.cell-ico { font-size: var(--fs-title); }
.cell-tx { font-size: var(--fs-title); }
.feed-head { font-size: var(--fs-title); font-weight: 600; display: block; padding: 16px 16px 8px; }
.card { background: #fff; border: 1px solid #d9e1ea; border-radius: 12px; padding: 16px; margin: 8px 16px; min-height: 48px; display: flex; flex-direction: column; gap: 6px; }
.card:active { background: #f7fafc; }
.card-title { font-size: var(--fs-body); font-weight: 500; }
.card-meta { font-size: var(--fs-annotate); color: #64748b; }
.feed-hint { display: block; font-size: var(--fs-annotate); color: #64748b; padding: 8px 16px; }
.feed-error { display: block; font-size: var(--fs-annotate); color: #c53030; padding: 8px 16px; }
</style>