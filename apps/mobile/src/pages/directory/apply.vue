<template>
  <view class="wrap">
    <text class="title">补{{ kindLabel }}</text>
    <text class="hint">任何已登记身份均可提交；人数不足 10 的节点提交即通过，其余需票选（提交后显示「待票选」）。</text>

    <view class="field">
      <text class="label">{{ kindLabel }}名称</text>
      <input v-model="name" class="input" placeholder="必填，≤ 64 字，可中文" />
    </view>

    <text v-if="error" class="error">{{ error }}</text>
    <button class="submit" :disabled="busy" @click="submit">{{ busy ? '提交中…' : '提交' }}</button>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { loadDirectory, normalizeTermKey, pullDirectory, termState, type TermKind } from '../../core/directory';
import { createProposal, GovernError } from '../../core/govern';
import { bootstrap } from '../../platform';

const KIND_LABEL: Record<TermKind, string> = { category: '分类', instructor: '讲师', tag: '标签' };

const kind = ref<TermKind>('category');
const name = ref('');
const busy = ref(false);
const error = ref('');

const kindLabel = computed(() => KIND_LABEL[kind.value]);

onLoad((query) => {
  const k = String((query as Record<string, string> | undefined)?.kind ?? '');
  if (k === 'category' || k === 'instructor' || k === 'tag') kind.value = k;
});

/** 提交词条提案（#58 §3.1）：`directory_add`，任何已登记身份均可提交，无本地资格门槛。 */
async function submit() {
  error.value = '';
  const raw = name.value.trim();
  if (raw === '') {
    error.value = `请填写${KIND_LABEL[kind.value]}名称`;
    return;
  }
  const termKey = normalizeTermKey(raw);
  if (termKey === null) {
    error.value = '名称非法或超过 64 个字';
    return;
  }
  busy.value = true;
  try {
    const { opts, repo } = await bootstrap();
    await createProposal(
      { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl },
      { action: 'directory_add', itemId: '', reason: '', directory: { kind: kind.value, termKey, displayName: raw } },
    );
    // 节点在同一请求内已投影 + 结算（govern_event.go 投影后立即 settle），故此处重拉即见最终态。
    // 不重拉则本地缓存仍是旧版本 ⇒ 小节点上已通过的词条仍显示「待票选」（册子 #65 §2.2 附带核对）。
    let approved = false;
    try {
      await pullDirectory({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl });
      approved = termState(await loadDirectory(repo), kind.value, termKey) === 'approved';
    } catch {
      // 目录拉取失败静默：提交本身已成功，旁路不该把成功报成失败（与 sync.ts 的 pullDirectory 同口径）。
    }
    uni.showToast({ title: approved ? '已通过' : '已提交 · 待票选', icon: 'none' });
    setTimeout(() => uni.navigateBack(), 600);
  } catch (e) {
    error.value = e instanceof GovernError ? e.message : (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 8px; }
.hint { display: block; font-size: 12px; color: #999999; margin-bottom: 12px; }
.field { margin-bottom: 14px; }
.label { display: block; font-size: 14px; color: #666666; margin-bottom: 6px; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: 14px; }
.error { display: block; color: #c53030; font-size: 13px; margin: 8px 0; }
.submit { margin-top: 16px; background: #2b6cb0; color: #ffffff; }
</style>
