<template>
  <view class="page">
    <!-- 顶栏 -->
    <view class="hero">
      <text class="hero-title">治理广场</text>
      <text class="hero-sub">Spec v2 · 两阶段判定（法定人数 + 净票权）</text>
      <view v-if="!loading && !error" class="hero-stats">
        <view class="stat">
          <text class="stat-val">{{ proposals.length }}</text>
          <text class="stat-lbl">提案</text>
        </view>
        <view class="stat">
          <text class="stat-val">{{ pendingCount }}</text>
          <text class="stat-lbl">进行中</text>
        </view>
        <view class="stat">
          <text class="stat-val">{{ effectiveCount }}</text>
          <text class="stat-lbl">通过</text>
        </view>
        <view class="stat">
          <text class="stat-val">{{ voidCount }}</text>
          <text class="stat-lbl">否决</text>
        </view>
      </view>
    </view>

    <!-- 发起人按钮 -->
    <view class="new-btn" @click="showForm = true">发起提案</view>

    <!-- 空态 -->
    <view v-if="!loading && !error && proposals.length === 0" class="empty">
      <text class="empty-text">当前暂无提案</text>
    </view>

    <!-- 错误态 -->
    <view v-if="error" class="empty">
      <text class="empty-text">{{ error }}</text>
      <view class="retry-btn" @click="loadProposals">重试</view>
    </view>

    <!-- 提案列表 -->
    <view v-for="p in proposals" :key="p.proposalId" class="card">
      <!-- 头部 -->
      <view class="card-head">
        <view class="head-left">
          <text class="action-tag" :class="p.action">{{ ACTION_LABEL[p.action] ?? p.action }}</text>
          <text v-if="p.governanceLevel === 'enhanced'" class="lvl-badge">强化</text>
          <text class="status-tag" :class="'s-' + p.status">{{ STATUS_LABEL[p.status] ?? p.status }}</text>
        </view>
        <text class="proposal-id">#{{ p.proposalId }}</text>
      </view>

      <!-- 目标条目 + 说明 -->
      <text class="item-link" @click="gotoItem(p.itemId)">📄 {{ p.itemId }}</text>
      <text v-if="p.reason" class="reason">{{ p.reason }}</text>
      <text v-if="p.action === 'edit' && p.title" class="edit-hint">拟改标题：{{ p.title }}</text>

      <!-- 阶段 1：法定人数 -->
      <view class="phase" :class="{ 'phase-pass': (p.voterCount ?? 0) >= (p.quorum ?? 0) }">
        <view class="phase-row">
          <text class="phase-label">阶段 1 · 法定人数</text>
          <text class="phase-val">{{ p.voterCount ?? 0 }} / {{ p.quorum ?? 0 }}</text>
        </view>
        <view class="bar">
          <view class="bar-fill quorum" :style="{ width: phase1Width(p) + '%' }" />
        </view>
        <text class="phase-hint">独立 voter 数 ≥ 法定人数（max(min(threshold, ⌈m/2⌉), m)）</text>
      </view>

      <!-- 阶段 2：净票权 -->
      <view class="phase" :class="phase2Class(p)">
        <view class="phase-row">
          <text class="phase-label">阶段 2 · 净票权</text>
          <text class="phase-val">
            <text class="approve">+{{ p.approveWeight ?? 0 }}</text>
            <text class="vs">−</text>
            <text class="reject">{{ p.rejectWeight ?? 0 }}</text>
            <text class="eq">= {{ p.netWeight ?? 0 }}</text>
          </text>
        </view>
        <view class="bar split">
          <view class="bar-fill approve-fill" :style="{ width: approvePct(p) + '%' }" />
          <view class="bar-fill reject-fill" :style="{ width: rejectPct(p) + '%' }" />
        </view>
        <text class="phase-hint">净票权 > 0 才 effective；≤ 0 自动否决</text>
      </view>

      <!-- 门槛信息 -->
      <view class="threshold-row">
        <text class="th-lbl">动态门槛 threshold</text>
        <text class="th-val">{{ p.threshold }}</text>
      </view>

      <!-- 投票操作 -->
      <view v-if="p.status === 'pending' && !hasVoted(p)" class="vote-actions">
        <view class="vote-btn approve" @click="doVote(p, 'approve')">👍 赞成</view>
        <view class="vote-btn reject" @click="doVote(p, 'reject')">👎 反对</view>
      </view>
      <view v-else-if="hasVoted(p)" class="voted">
        <text class="voted-label">已投：{{ votedLabel(p) }}</text>
      </view>
    </view>

    <!-- 发起提案表单 -->
    <view v-if="showForm" class="modal-mask" @click.self="showForm = false">
      <view class="modal">
        <text class="modal-title">发起提案</text>
        <view class="field">
          <text class="field-lbl">目标条目 ID</text>
          <input v-model="form.itemId" class="field-input" placeholder="如 article-xxx 或 term:tag:foo" />
        </view>
        <view class="field">
          <text class="field-lbl">动作类型</text>
          <view class="action-grid">
            <view
              v-for="(lbl, act) in ACTION_LABEL"
              :key="act"
              class="action-chip"
              :class="{ active: form.action === act }"
              @click="form.action = act"
            >{{ lbl }}</view>
          </view>
        </view>
        <view v-if="form.action === 'edit'" class="field">
          <text class="field-lbl">拟改标题</text>
          <input v-model="form.title" class="field-input" placeholder="新标题（可选）" />
        </view>
        <view v-if="form.action === 'edit'" class="field">
          <text class="field-lbl">拟改正文</text>
          <textarea v-model="form.bodyMd" class="field-textarea" placeholder="新正文 Markdown" />
        </view>
        <view class="field">
          <text class="field-lbl">理由</text>
          <textarea v-model="form.reason" class="field-textarea" placeholder="简述发起理由" />
        </view>
        <view class="modal-actions">
          <view class="cancel-btn" @click="showForm = false">取消</view>
          <view class="submit-btn" @click="doCreate" :class="{ disabled: submitting }">
            {{ submitting ? '提交中…' : '确认发起' }}
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { bootstrap } from '../../platform';
import {
  ACTION_LABEL,
  STATUS_LABEL,
  createProposal,
  listProposals,
  vote,
  type GovernAction,
  type ProposalItem,
  type GovernOptions,
  type VoteType,
} from '@base/core-ts/govern';

const opts = ref<GovernOptions | null>(null);
const proposals = ref<ProposalItem[]>([]);
const loading = ref(true);
const error = ref('');
const unconfigured = ref(false);
const showForm = ref(false);
const submitting = ref(false);
const myVoteCache = ref<Map<string, VoteType>>(new Map());

const form = reactive({
  itemId: '',
  action: 'remove' as GovernAction,
  reason: '',
  title: '',
  bodyMd: '',
});

onMounted(async () => {
  try {
    const ctx = await bootstrap();
    opts.value = { adapters: ctx.opts.adapters, repo: ctx.repo, nodeBaseUrl: ctx.opts.nodeBaseUrl };
    unconfigured.value = ctx.opts.nodeBaseUrl === '';
  } catch (e) {
    error.value = (e as Error).message;
    return;
  }
  await loadProposals();
});

async function loadProposals() {
  if (!opts.value) return;
  loading.value = true;
  error.value = '';
  try {
    proposals.value = await listProposals(opts.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

const pendingCount = computed(() => proposals.value.filter(p => p.status === 'pending').length);
const effectiveCount = computed(() => proposals.value.filter(p => p.status === 'effective').length);
const voidCount = computed(() => proposals.value.filter(p => p.status === 'void').length);

// —— 辅助函数 ——
function phase1Width(p: ProposalItem): number {
  const q = p.quorum ?? 0;
  const v = p.voterCount ?? 0;
  if (q <= 0) return 0;
  return Math.min(100, Math.round((v * 100) / q));
}
function phase2Class(p: ProposalItem): string {
  if ((p.voterCount ?? 0) < (p.quorum ?? 0)) return 'phase-pending';
  const nw = p.netWeight ?? 0;
  return nw > 0 ? 'phase-pass' : 'phase-fail';
}
function approvePct(p: ProposalItem): number {
  const a = p.approveWeight ?? 0;
  const r = p.rejectWeight ?? 0;
  const tot = a + r;
  if (tot <= 0) return 50;
  return Math.round((a * 100) / tot);
}
function rejectPct(p: ProposalItem): number {
  return 100 - approvePct(p);
}
function hasVoted(p: ProposalItem): boolean {
  return myVoteCache.value.has(p.proposalId);
}
function votedLabel(p: ProposalItem): string {
  const v = myVoteCache.value.get(p.proposalId);
  return v === 'approve' ? '赞成 👍' : v === 'reject' ? '反对 👎' : '';
}
function gotoItem(itemId: string): void {
  uni.navigateTo({ url: `/pages/article/article?id=${encodeURIComponent(itemId)}` });
}

async function doVote(p: ProposalItem, voteType: VoteType) {
  if (!opts.value) return;
  myVoteCache.value.set(p.proposalId, voteType);
  const incApprove = voteType === 'approve' ? 1 : 0;
  const incReject = voteType === 'reject' ? 1 : 0;
  p.approveWeight = (p.approveWeight ?? 0) + incApprove;
  p.rejectWeight = (p.rejectWeight ?? 0) + incReject;
  p.netWeight = (p.netWeight ?? 0) + incApprove - incReject;
  p.voterCount = (p.voterCount ?? 0) + 1;
  try {
    await vote(opts.value, p.proposalId, { voteType, voteWeight: 1 });
  } catch {
    myVoteCache.value.delete(p.proposalId);
    p.approveWeight = (p.approveWeight ?? 0) - incApprove;
    p.rejectWeight = (p.rejectWeight ?? 0) - incReject;
    p.netWeight = (p.netWeight ?? 0) - incApprove + incReject;
    p.voterCount = (p.voterCount ?? 0) - 1;
  }
}

async function doCreate() {
  if (!opts.value) return;
  if (!form.itemId) { uni.showToast({ title: '请填写目标条目', icon: 'none' }); return; }
  if (!form.reason && form.action !== 'directory_add') {
    uni.showToast({ title: '请填写理由', icon: 'none' }); return;
  }
  submitting.value = true;
  try {
    const payload: Record<string, unknown> = {
      action: form.action,
      itemId: form.itemId,
      reason: form.reason,
    };
    // 旧 edit 动作需要嵌套 edit 载荷；V2 细粒度 edit_* / highlight / pin 等各自独立，无需额外载荷
    if (form.action === 'edit' && (form.title || form.bodyMd)) {
      payload.edit = { title: form.title, bodyMd: form.bodyMd };
    }
    await createProposal(opts.value, payload as unknown as Parameters<typeof createProposal>[1]);
    showForm.value = false;
    form.itemId = ''; form.reason = ''; form.title = ''; form.bodyMd = ''; form.action = 'remove';
    uni.showToast({ title: '已发起', icon: 'success' });
    await loadProposals();
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : '发起失败', icon: 'none' });
  } finally {
    submitting.value = false;
  }
}
</script>

<style lang="scss" scoped>
.page { padding: 0 0 40rpx; background: #f5f6f8; min-height: 100vh; }

.hero {
  background: linear-gradient(135deg, #1e3a5f 0%, #2d5a87 100%);
  padding: 60rpx 32rpx 40rpx;
  color: #fff;
}
.hero-title { font-size: 40rpx; font-weight: 700; display: block; }
.hero-sub { font-size: 24rpx; opacity: 0.75; display: block; margin-top: 8rpx; }
.hero-stats { display: flex; gap: 32rpx; margin-top: 32rpx; }
.stat { text-align: center; }
.stat-val { font-size: 40rpx; font-weight: 700; display: block; }
.stat-lbl { font-size: 22rpx; opacity: 0.8; }

.new-btn {
  margin: 24rpx 32rpx;
  padding: 24rpx 32rpx;
  background: #1e3a5f;
  color: #fff;
  border-radius: 12rpx;
  text-align: center;
  font-size: 28rpx;
  font-weight: 600;
}

.empty { padding: 120rpx 32rpx; text-align: center; }
.empty-text { color: #888; font-size: 28rpx; }
.retry-btn { margin-top: 24rpx; color: #1e3a5f; font-size: 26rpx; }

.card {
  background: #fff;
  margin: 0 32rpx 24rpx;
  border-radius: 16rpx;
  padding: 28rpx;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.04);
}

.card-head { display: flex; justify-content: space-between; align-items: center; }
.head-left { display: flex; gap: 12rpx; align-items: center; }
.action-tag {
  display: inline-block;
  padding: 6rpx 16rpx;
  border-radius: 8rpx;
  font-size: 22rpx;
  font-weight: 600;
  background: #eef2f7;
  color: #1e3a5f;
  text-transform: none;
}
.action-tag.remove { background: #fee; color: #c33; }
.action-tag.revive { background: #efe; color: #3a3; }
.action-tag.edit { background: #fff6e6; color: #a66; }
.action-tag.directory_add { background: #e6f7ff; color: #1890ff; }
.action-tag.highlight, .action-tag.pin, .action-tag.recommend, .action-tag.feature {
  background: #f3e6ff; color: #722ed1;
}
.action-tag.edit_title, .action-tag.edit_body, .action-tag.edit_category, .action-tag.edit_tags, .action-tag.edit_instructor {
  background: #fff6e6; color: #d48806;
}
.lvl-badge {
  font-size: 20rpx;
  padding: 4rpx 12rpx;
  background: #fff1f0;
  color: #f5222d;
  border-radius: 6rpx;
  font-weight: 600;
}
.status-tag {
  font-size: 20rpx;
  padding: 4rpx 12rpx;
  border-radius: 6rpx;
  font-weight: 600;
}
.status-tag.s-pending { background: #e6f7ff; color: #1890ff; }
.status-tag.s-effective { background: #f6ffed; color: #52c41a; }
.status-tag.s-voided { background: #fff1f0; color: #ff4d4f; }
.proposal-id { color: #aaa; font-size: 22rpx; }

.item-link {
  display: block;
  margin-top: 16rpx;
  color: #1e3a5f;
  font-size: 26rpx;
  font-weight: 500;
}
.reason {
  display: block;
  margin-top: 8rpx;
  color: #555;
  font-size: 24rpx;
  line-height: 1.5;
}
.edit-hint {
  display: block;
  margin-top: 6rpx;
  color: #a66;
  font-size: 22rpx;
}

.phase {
  margin-top: 20rpx;
  padding: 16rpx;
  border-radius: 10rpx;
  background: #fafbfc;
  border: 2rpx solid transparent;
}
.phase.pending, .phase.phase-pending { border-color: #eee; }
.phase.phase-pass { border-color: #52c41a; background: #f6ffed; }
.phase.phase-fail { border-color: #ff4d4f; background: #fff1f0; }
.phase-row { display: flex; justify-content: space-between; align-items: center; }
.phase-label { font-size: 24rpx; color: #333; font-weight: 600; }
.phase-val { font-size: 24rpx; }
.phase-val .approve { color: #52c41a; }
.phase-val .reject { color: #ff4d4f; }
.phase-val .eq { color: #666; margin-left: 8rpx; }
.phase-val .vs { color: #999; margin: 0 4rpx; }
.phase-hint { display: block; margin-top: 8rpx; font-size: 20rpx; color: #999; }

.bar {
  margin-top: 10rpx;
  height: 16rpx;
  background: #eee;
  border-radius: 8rpx;
  overflow: hidden;
}
.bar.split { display: flex; }
.bar-fill { height: 100%; transition: width 0.3s; }
.bar-fill.quorum { background: #1e3a5f; }
.bar-fill.approve-fill { background: #52c41a; }
.bar-fill.reject-fill { background: #ff4d4f; }

.threshold-row {
  margin-top: 16rpx;
  display: flex;
  justify-content: space-between;
  padding: 10rpx 0;
  border-top: 2rpx solid #f0f0f0;
}
.th-lbl { font-size: 22rpx; color: #888; }
.th-val { font-size: 24rpx; color: #333; font-weight: 600; }

.vote-actions {
  margin-top: 16rpx;
  display: flex;
  gap: 20rpx;
}
.vote-btn {
  flex: 1;
  padding: 18rpx 0;
  text-align: center;
  border-radius: 10rpx;
  font-size: 26rpx;
  font-weight: 600;
}
.vote-btn.approve { background: #52c41a; color: #fff; }
.vote-btn.reject { background: #ff4d4f; color: #fff; }

.voted {
  margin-top: 16rpx;
  padding: 14rpx;
  background: #f0f0f0;
  border-radius: 8rpx;
  text-align: center;
}
.voted-label { font-size: 24rpx; color: #666; }

/* Modal */
.modal-mask {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
  display: flex;
  align-items: flex-end;
}
.modal {
  width: 100%;
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  padding: 32rpx;
  max-height: 80vh;
  overflow-y: auto;
}
.modal-title { font-size: 32rpx; font-weight: 700; display: block; margin-bottom: 24rpx; }

.field { margin-bottom: 20rpx; }
.field-lbl { display: block; font-size: 24rpx; color: #555; margin-bottom: 8rpx; }
.field-input, .field-textarea {
  width: 100%;
  padding: 16rpx;
  border: 2rpx solid #e8e8e8;
  border-radius: 10rpx;
  font-size: 26rpx;
  box-sizing: border-box;
  background: #fafbfc;
}
.field-textarea { min-height: 160rpx; }

.action-grid { display: flex; flex-wrap: wrap; gap: 12rpx; }
.action-chip {
  padding: 10rpx 20rpx;
  border-radius: 20rpx;
  background: #f0f0f0;
  font-size: 24rpx;
  color: #555;
  border: 2rpx solid transparent;
}
.action-chip.active {
  background: #1e3a5f;
  color: #fff;
  border-color: #1e3a5f;
}

.modal-actions { display: flex; gap: 20rpx; margin-top: 24rpx; }
.cancel-btn {
  flex: 1;
  padding: 22rpx;
  text-align: center;
  background: #f0f0f0;
  border-radius: 10rpx;
  font-size: 28rpx;
  color: #666;
}
.submit-btn {
  flex: 1;
  padding: 22rpx;
  text-align: center;
  background: #1e3a5f;
  border-radius: 10rpx;
  font-size: 28rpx;
  color: #fff;
  font-weight: 600;
}
.submit-btn.disabled { opacity: 0.5; }
</style>
