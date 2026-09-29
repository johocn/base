<template>
  <view class="wrap">
    <view class="bar">
      <text class="title">圈子</text>
      <text class="act" @click="reload">刷新</text>
    </view>

    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <view class="acts">
      <text class="act" @click="create">新建小组</text>
      <text class="act" @click="join">加入小组</text>
    </view>

    <text v-if="groups.length === 0" class="empty">还没有小组。可以新建一个，或粘贴伙伴给的邀请码入组。</text>
    <navigator
      v-for="g in groups"
      :key="g.groupId"
      class="card"
      :url="'/pages/group/group?groupId=' + g.groupId"
    >
      <text class="t">{{ g.name || '未命名小组' }}</text>
      <text class="meta">成员 {{ memberCount(g.memberIdsJson) }} · epoch {{ g.epoch }}</text>
    </navigator>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { acceptInvite, createGroup, listMyGroups, GroupError, type GroupOptions } from '../../core/group';
import type { GroupRow } from '../../core/types';
import { bootstrap } from '../../platform';

const opts = ref<GroupOptions | null>(null);
const groups = ref<GroupRow[]>([]);
const error = ref('');
const notice = ref('');

/** 我参与的小组：零网络，只读本地 groups 表（册子 §5.5）。 */
async function load() {
  try {
    const ctx = await bootstrap();
    opts.value = { adapters: ctx.opts.adapters, repo: ctx.repo, nodeBaseUrl: ctx.opts.nodeBaseUrl };
    groups.value = await listMyGroups(opts.value);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function reload() {
  error.value = '';
  notice.value = '';
  await load();
}

/** 成员数取自名单快照；投影损坏按 0，不让一行坏数据打断整页。 */
function memberCount(memberIdsJson: string): number {
  try {
    const ids = JSON.parse(memberIdsJson) as unknown;
    return Array.isArray(ids) ? ids.length : 0;
  } catch {
    return 0;
  }
}

/** 可编辑弹窗；取消返回 null。 */
function ask(title: string, placeholderText: string): Promise<string | null> {
  return new Promise((resolve) => {
    uni.showModal({
      title,
      editable: true,
      placeholderText,
      success: (res) => resolve(res.confirm ? String(res.content ?? '') : null),
      fail: () => resolve(null),
    });
  });
}

/**
 * 新建小组：本地出码、发不出去就入队——**未配置节点也能用**（AC 1 全离线），
 * 故此处不像评论页那样禁用入口，只在 queued 时补一句说明。
 */
async function create() {
  if (!opts.value) return;
  error.value = '';
  notice.value = '';
  const name = await ask('新建小组', '给小组起个名字');
  if (name === null) return;
  try {
    const r = await createGroup(opts.value, { name: name.trim() });
    uni.setClipboardData({ data: r.inviteCode });
    notice.value = r.queued
      ? '邀请码已复制，发给伙伴即可入组（联网后自动登记名单）'
      : '邀请码已复制，发给伙伴即可入组';
    await load();
  } catch (e) {
    error.value = e instanceof GroupError ? e.message : (e as Error).message;
  }
}

/** 加入小组 / 粘入续期码：全程离线、零网络；失败显示 GroupError 文案。 */
async function join() {
  if (!opts.value) return;
  error.value = '';
  notice.value = '';
  const code = await ask('加入小组', '粘贴邀请码或续期码');
  if (code === null || code === '') return;
  try {
    await acceptInvite(opts.value, code);
    notice.value = '已加入小组';
    await load();
  } catch (e) {
    error.value = e instanceof GroupError ? e.message : (e as Error).message;
  }
}

onShow(() => {
  void load();
});
</script>

<style>
.wrap { padding: 16px; }
.bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.title { font-size: 20px; font-weight: 600; }
.act { color: #2b6cb0; font-size: 14px; margin-right: 18px; }
.acts { display: flex; margin-bottom: 10px; }
.card { display: block; padding: 14px 0; border-bottom: 1px solid #eeeeee; }
.t { display: block; font-size: 17px; }
.meta { display: block; color: #888888; font-size: 12px; margin-top: 4px; }
.empty { display: block; color: #999999; font-size: 13px; padding: 6px 0; line-height: 1.7; }
.error { display: block; color: #c53030; font-size: 13px; margin-bottom: 8px; }
.notice { display: block; color: #b7791f; font-size: 13px; margin-bottom: 8px; }
</style>