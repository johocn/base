<template>
  <view class="wrap">
    <text class="title">补标签</text>
    <text class="target">{{ targetLabel }}</text>
    <text v-if="!allowed" class="warn">本机身份不在治理人名册、也不在任何圈子治者内：提交会被节点拒绝（403 tag_not_governor）。</text>

    <view class="field">
      <text class="label">名称</text>
      <input v-model="name" class="input" placeholder="必填，≤ 64 字" />
    </view>
    <view class="field">
      <text class="label">章</text>
      <input v-model="chapter" class="input" placeholder="必填，≤ 64 字" />
    </view>
    <view class="field">
      <text class="label">节</text>
      <input v-model="section" class="input" placeholder="必填，≤ 64 字" />
    </view>

    <text class="hint">三段组成标签「名称 · 章 · 节」，三段都必填；三段完全相同即同一个标签（不会重复建条目）。</text>

    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>
    <button class="submit" :disabled="busy" @click="submit">{{ busy ? '提交中…' : '提交' }}</button>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { canGovern, submitTag, tagKindOfTarget } from '../../core/tags';
import type { SubmitOptions } from '../../core/submit';
import { bootstrap } from '../../platform';

const KIND_LABEL: Record<string, string> = { course: '课程', lesson: '课时', article: '文章', comment: '评论' };

const target = ref('');
const kind = ref('');
const targetLabel = ref('');
const allowed = ref(false);
const name = ref('');
const chapter = ref('');
const section = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');

onLoad(async (query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  target.value = String(q.target ?? '');
  kind.value = String(q.kind ?? '') || tagKindOfTarget(target.value);
  try {
    const { opts, repo } = await bootstrap();
    const o: SubmitOptions = { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl };
    const t = await repo.getItem(target.value);
    targetLabel.value = `给${KIND_LABEL[kind.value] ?? '内容'}「${t?.title || target.value}」补标签`;
    allowed.value = await canGovern(o);
  } catch (e) {
    error.value = (e as Error).message;
  }
});

async function submit() {
  error.value = '';
  notice.value = '';
  busy.value = true;
  try {
    const { opts, repo } = await bootstrap();
    const out = await submitTag(
      { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl },
      { name: name.value, chapter: chapter.value, section: section.value, targetId: target.value },
    );
    if (out.ledgerState === 'sent') {
      uni.showToast({ title: out.created ? '已打标' : '已更新', icon: 'success' });
      setTimeout(() => uni.navigateBack(), 600);
      return;
    }
    // 未送达：pending 会自动补发，failed 需回「我的条目」删除后重投
    notice.value = out.message;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 8px; }
.target { display: block; color: #444444; font-size: 14px; margin-bottom: 12px; }
.warn { display: block; color: #c05621; font-size: 12px; margin-bottom: 12px; }
.field { margin-bottom: 14px; }
.label { display: block; font-size: 14px; color: #666666; margin-bottom: 6px; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: 14px; }
.hint { display: block; font-size: 12px; color: #999999; margin-bottom: 12px; }
.error { display: block; color: #c53030; font-size: 13px; margin: 8px 0; }
.notice { display: block; color: #b7791f; font-size: 13px; margin: 8px 0; }
.submit { margin-top: 16px; background: #2b6cb0; color: #ffffff; }
</style>
