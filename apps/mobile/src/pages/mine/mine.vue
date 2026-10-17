<template>
  <view class="wrap">
    <text class="title">我的</text>
    <view class="card">
      <view class="row"><text class="k">已读</text><text class="v">{{ stats.readCount }} 篇</text></view>
      <view class="row"><text class="k">答题正确率</text><text class="v">{{ rateText }}</text></view>
      <view class="row"><text class="k">最近学习</text><text class="v">{{ lastText }}</text></view>
    </view>
    <view class="card">
      <view class="row"><text class="k">今日打卡</text><text class="v">{{ todayDone ? '已打卡' : '未打卡' }}</text></view>
      <view class="row"><text class="k">连续打卡</text><text class="v">{{ streak }} 天</text></view>
      <block v-if="studying.length > 0">
        <view class="row"><text class="k">在学中</text></view>
        <view v-for="p in studying" :key="p.itemId" class="row">
          <text class="k">{{ p.title }}</text>
          <text class="v">{{ p.hint }}</text>
        </view>
      </block>
    </view>
    <text class="group">创作</text>
    <navigator url="/pages/submit/submit" class="link">新建投稿</navigator>
    <navigator url="/pages/myitems/myitems" class="link">我的条目<text class="tail">{{ pendingText }}</text></navigator>
    <navigator url="/pages/note/list" class="link">我的笔记</navigator>
    <!-- 本地操作（#84 Task 5 自首页迁入）：同步 / 新建课程 / 我创建的，行高沿用 .link（≥48px 适老） -->
    <view class="link" :class="{ dim: busy || syncBlocked }" @click="doSync">{{ busy ? '同步中…' : (syncBlocked ? '无法同步' : '同步数据') }}</view>
    <view class="link" @click="createCourse">新建课程</view>
    <view class="link" @click="showMyCreated">我创建的<text class="tail">（{{ myCreated.length }}）</text></view>
    <text v-if="syncBlocked" class="ops-error">本地文件不可写，无法同步（设置 → 基座自检 可看原因）</text>
    <text v-if="tip" class="ops-tip">{{ tip }}</text>

    <text class="group">治理</text>
    <navigator url="/pages/governance/governance" class="link">提案与投票<text class="tail">{{ rosterText }}</text></navigator>
    <navigator url="/pages/contribution/contribution" class="link">我的贡献</navigator>

    <text class="group">私信</text>
    <navigator url="/pages/dm/list" class="link">好友与私信</navigator>

    <text class="group">标签</text>
    <navigator url="/pages/tag/list" class="link">全部标签</navigator>

    <navigator url="/pages/favorite/favorite" class="link">我的收藏</navigator>
    <navigator url="/pages/help/help" class="link">使用帮助</navigator>
    <navigator url="/pages/setting/setting" class="link">设置</navigator>
    <!-- R2 spike 临时入口：保活验证完成后随 pages/dev/nearby-spike 一并删除 -->
    <navigator url="/pages/dev/nearby-spike" class="link">R2保活验证（临时）</navigator>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import type { LearningStats } from '../../core/types';
import { flushPending } from '../../core/comment';
import { checkinStreak, localDay } from '../../core/progress';
import { pullProgress } from '../../core/progress-store';
import { myIdentityId, roster } from '../../core/contribution';
import { syncOnce } from '../../core/sync';
import { canSync } from '../../core/selfcheck';
import { buildMyCreatedView, type MyCreatedRow, type MyCreatedType } from '../../core/my-created';
import type { LocalRepo } from '../../core/repo';
import { bootstrap } from '../../platform';

const stats = ref<LearningStats>({ readCount: 0, quizAttempts: 0, correctRate: null, lastAt: '' });

const pendingCount = ref(0);
/** 名册状态只作提示文案，不是资格判定（本册 §2.3） */
const rosterState = ref<'in' | 'out' | 'unknown'>('unknown');

/** 在学中列表项（有进度但 `done=false`）；**只展示、不可点**（#8 册子 §2 排除独立进度页） */
interface StudyingRow {
  itemId: string;
  title: string;
  hint: string;
}

const todayDone = ref(false);
const streak = ref(0);
const studying = ref<StudyingRow[]>([]);

/** 本地操作（#84 Task 5 自首页迁入）：同步三态 + 「我创建的」台账行集 */
const busy = ref(false);
const syncBlocked = ref(false);
const tip = ref('');
const myCreated = ref<MyCreatedRow[]>([]);

const pendingText = computed(() => (pendingCount.value > 0 ? `（${pendingCount.value} 条待发）` : ''));
const rosterText = computed(() =>
  rosterState.value === 'unknown' ? '' : rosterState.value === 'in' ? '（名册内）' : '（未入名册）',
);

// 无作答时显示 `-`，不显示 0%（0% 会被误读为「全错」）
const rateText = computed(() =>
  stats.value.correctRate === null ? '-' : `${Math.round(stats.value.correctRate * 100)}%`,
);
const lastText = computed(() => stats.value.lastAt.slice(0, 10) || '-');

/** 在学中行的进度提示（量纲按 type 分派，与 #8 册子 §3.2 同口径；未知类型不显示）。 */
function progressHint(type: string, position: number): string {
  if (type === 'article') return `已读 ${Math.round(Math.min(1000, Math.max(0, position)) / 10)}%`;
  if (type === 'video') return `已看 ${position} 秒`;
  if (type === 'quiz') return `已答 ${position} 题`;
  return '';
}

// onShow 而不是 onLoad：从阅读器或答题页返回后必须立刻反映
onShow(async () => {
  try {
    const { opts, repo, capabilities } = await bootstrap();
    const o = { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl };
    // 同步阻断态（原首页 load 口径）：canSync 不通过则同步入口禁用 + 提示行
    syncBlocked.value = !canSync(capabilities);

    // 补发待发队列（评论 / 小组 / 私信 / **进度**共用同一 `comment_out`，类型由 wire 自带）
    // + 拉节点侧进度并合并进本地（#8 册子 §5.4 / §5.5）。两者都只经返回值 / 静默体现，
    // 绝不让「我的」页报错；失败也不影响下面的本地读取。
    try {
      await flushPending(o);
      await pullProgress(o);
    } catch {
      // 忽略
    }

    stats.value = await repo.learningStats();
    pendingCount.value = (await repo.listSubmissions('pending')).length;

    // 「我创建的」台账行集（原首页 load 口径，册子 #51 §3）：去重全在 buildMyCreatedView 内
    await refreshMyCreated(repo);

    // 打卡卡（#8 册子 §3.5）：某日已打卡 ⇔ 存在该日事件；连续天数从今天回溯、首个缺口即断
    const days = new Set((await repo.listCheckinDays()).map((d) => d.day));
    const today = localDay();
    todayDone.value = days.has(today);
    streak.value = checkinStreak(days, today);

    // 在学中 = 有进度但未完成的条目，最近更新的在前，最多 5 条
    const byId = new Map((await repo.listItems()).map((i) => [i.itemId, i]));
    studying.value = (await repo.listProgress())
      .filter((p) => !p.done)
      .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : 0))
      .slice(0, 5)
      .map((p) => {
        const it = byId.get(p.itemId);
        return {
          itemId: p.itemId,
          title: it?.title || p.itemId,
          hint: progressHint(it?.type ?? '', p.position),
        };
      });

    const myId = await myIdentityId(o);
    const list = await roster(o);
    rosterState.value = myId !== '' && list.some((c) => c.id === myId) ? 'in' : 'out';
  } catch {
    // 「我的」不因读库 / 拉名册失败而报错，保持上一次的值（含 rosterState 保持 unknown）
  }
});

/** 「我创建的」台账行集（原首页 load 段逐字迁移）：台账行 + 包表 id 集合 → buildMyCreatedView。 */
async function refreshMyCreated(repo: LocalRepo) {
  const subs = await repo.listSubmissions();
  const all = await repo.listItems();
  const packIds = new Set(all.filter((i) => i.source !== 'local').map((i) => i.itemId));
  myCreated.value = buildMyCreatedView(subs, packIds);
}

/** 同步（原首页 doSync 逐字迁移）：行形态无 disabled 属性，阻断/进行中以入口守卫代替。 */
async function doSync() {
  if (busy.value || syncBlocked.value) return;
  busy.value = true;
  tip.value = '';
  try {
    const { opts, repo, capabilities } = await bootstrap();
    if (!opts.nodeBaseUrl) {
      tip.value = '请先在「我的 → 设置」里填写节点地址与公钥';
      return;
    }
    const res = await syncOnce(opts);
    tip.value =
      res.status === 'noop'
        ? '节点内容未更新'
        : `已更新到版本 ${res.contentVersion}（条目 ${res.items}，块 ${res.blobs}）`;
    syncBlocked.value = !canSync(capabilities);
    await refreshMyCreated(repo);
  } catch (e) {
    tip.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function createCourse() {
  uni.navigateTo({ url: '/pages/course/edit' });
}

const TYPE_LABEL: Record<MyCreatedType, string> = { course: '课程', lesson: '课时', article: '文章', quiz: '题库' };

function typeLabel(t: MyCreatedType): string {
  return TYPE_LABEL[t];
}

/**
 * 「我创建的」大按钮（#84 回补）：ActionSheet 列出台账行标题，点开走既有详情路由。
 * 课程行 → openCourse；其余（课时/文章/题库）→ openMyCreated（带 from=ledger，未落库行只有台账渲染兜底）。
 */
function showMyCreated() {
  const rows = myCreated.value;
  if (rows.length === 0) {
    uni.showToast({ title: '还没有我创建的内容', icon: 'none' });
    return;
  }
  uni.showActionSheet({
    itemList: rows.map((r) => `${typeLabel(r.type)} · ${r.title}`),
    success: ({ tapIndex }) => {
      const row = rows[tapIndex];
      if (row.type === 'course') {
        openCourse(row.itemId);
        return;
      }
      openMyCreated(row);
    },
  });
}

function openCourse(itemId: string) {
  uni.navigateTo({ url: `/pages/course/detail?courseId=${encodeURIComponent(itemId)}` });
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
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: var(--fs-title); font-weight: 600; margin-bottom: 16px; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 4px 12px; margin-bottom: 20px; min-height: 96px; }
.row { display: flex; justify-content: space-between; padding: 10px 0; }
.k { color: #666666; font-size: var(--fs-annotate); }
.v { font-size: var(--fs-title); }
.link { display: flex; align-items: center; min-height: 56px; padding: 0 16px; border-bottom: 1px solid #eeeeee; color: #2b6cb0; font-size: var(--fs-body); }
.group { display: block; font-size: var(--fs-annotate); color: #999999; margin: 8px 0 4px; }
.tail { color: #2b6cb0; font-size: var(--fs-annotate); }
/* 本地操作区（#84 Task 5）：禁用态降透明；同步结果/阻断提示 fs-annotate 小字（阻断红，同原首页 ops-error） */
.dim { opacity: 0.5; }
.ops-tip { display: block; font-size: var(--fs-annotate); color: #666666; padding: 4px 16px 0; }
.ops-error { display: block; font-size: var(--fs-annotate); color: #c53030; padding: 4px 16px 0; }
</style>