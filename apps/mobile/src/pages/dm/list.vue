<template>
  <view class="wrap">
    <view class="bar">
      <text class="title">私信</text>
      <text class="act" @click="reload">刷新</text>
    </view>

    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <view class="acts">
      <text class="act" @click="addFriend">添加好友</text>
      <text class="act" @click="pasteCode">粘贴好友码</text>
    </view>

    <text v-if="friends.length === 0" class="empty">还没有好友。可以「添加好友」生成好友码，或粘贴伙伴给的好友码。</text>
    <!-- 卡片的 flex 必须落在 navigator 内侧：H5 端 navigator 会把子节点再包一层 `<a>`，
         直接给 navigator 加 display:flex 时它只剩这一个子元素，头像与正文会被竖排。 -->
    <navigator v-for="f in friends" :key="f.peerId" :url="'/pages/dm/chat?peerId=' + f.peerId">
      <view class="card">
        <view class="card-avatar" :style="{ background: avatarBg(f.peerId) }"></view>
        <view class="card-body">
          <text class="t">{{ authorName(f.peerId) }}</text>
          <text class="meta">{{ f.hasKey ? '已建立会话' : '未交换好友码，只读到来信' }}</text>
        </view>
      </view>
    </navigator>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import {
  acceptFriendCode,
  createFriend,
  listFriends,
  DmError,
  type DmOptions,
  type FriendEntry,
} from '../../core/dm';
import { avatarBg, useActorNames } from '../../core/useActorNames';
import { bootstrap } from '../../platform';

const opts = ref<DmOptions | null>(null);
const friends = ref<FriendEntry[]>([]);
const error = ref('');
const notice = ref('');

/** 昵称三级降级（名册 → profile 补查 → id[:8] 回退），与私信会话页同一降级链 */
const { authorName, loadNames } = useActorNames();

async function load() {
  try {
    const ctx = await bootstrap();
    opts.value = { adapters: ctx.opts.adapters, repo: ctx.repo, nodeBaseUrl: ctx.opts.nodeBaseUrl };
    friends.value = await listFriends(opts.value);
    await loadNames(friends.value.map((f) => f.peerId), opts.value);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function reload() {
  error.value = '';
  notice.value = '';
  await load();
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

/** 添加好友：给对方的身份 id → 本地出码 → 复制给对方（全程离线、零网络，AC 1）。 */
async function addFriend() {
  if (!opts.value) return;
  error.value = '';
  notice.value = '';
  const peerId = await ask('添加好友', '粘贴对方的身份 id（32 位 hex）');
  if (peerId === null) return;
  try {
    const r = await createFriend(opts.value, peerId.trim());
    uni.setClipboardData({ data: r.code });
    notice.value = '好友码已复制，发给对方即可建立会话';
    await load();
  } catch (e) {
    error.value = e instanceof DmError ? e.message : (e as Error).message;
  }
}

/** 粘贴好友码：本地自验并入会话（全程离线、零网络）。 */
async function pasteCode() {
  if (!opts.value) return;
  error.value = '';
  notice.value = '';
  const code = await ask('粘贴好友码', '粘贴好友码');
  if (code === null || code === '') return;
  try {
    await acceptFriendCode(opts.value, code);
    notice.value = '已建立会话';
    await load();
  } catch (e) {
    error.value = e instanceof DmError ? e.message : (e as Error).message;
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
.card { display: flex; align-items: center; padding: 12px 0; border-bottom: 1px solid #eeeeee; }
.card-avatar { width: 40px; height: 40px; margin-right: 10px; border-radius: 8px; }
.card-body { flex: 1; }
.t { display: block; font-size: 17px; }
.meta { display: block; color: #888888; font-size: 12px; margin-top: 4px; }
.empty { display: block; color: #999999; font-size: 13px; padding: 6px 0; line-height: 1.7; }
.error { display: block; color: #c53030; font-size: 13px; margin-bottom: 8px; }
.notice { display: block; color: #b7791f; font-size: 13px; margin-bottom: 8px; }
</style>
