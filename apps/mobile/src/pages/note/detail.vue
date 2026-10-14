<template>
  <view class="wrap">
    <view class="topbar">
      <text class="edit-btn" @click="goEdit">编辑</text>
      <text class="del-btn" @click="remove">删除</text>
    </view>

    <text v-if="error !== ''" class="error">{{ error }}</text>

    <block v-else-if="row">
      <text class="title">{{ row.title }}</text>
      <view class="body">
        <rich-text :nodes="bodyHtml" />
      </view>
    </block>
  </view>
</template>

<script setup lang="ts">
import { onLoad, onShow } from '@dcloudio/uni-app';
import { ref } from 'vue';

import { deleteNote, type NoteRow } from '@base/core-ts/notes';
import { decodeSafe } from '../../core/course-edit';
import { renderMarkdown } from '../../core/markdown';
import { resolveBlobRefsInMd } from '@base/core-ts/blob-refs';
import { bootstrap } from '../../platform';

const row = ref<NoteRow | null>(null);
const bodyHtml = ref('');
const error = ref('');
let noteId = '';

// onLoad 只拿参数；onShow 装载：从编辑页返回后立刻刷新正文（与列表页同口径）
onLoad((query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  // 跳转方传 encodeURIComponent(noteId)，不解码会拼出坏 id
  noteId = decodeSafe(String(q.noteId ?? ''));
});

onShow(() => {
  void refresh();
});

async function refresh(): Promise<void> {
  if (noteId === '') return;
  try {
    const { opts, repo } = await bootstrap();
    const found = (await repo.listNotes()).find((r) => r.noteId === noteId) ?? null;
    if (!found) {
      error.value = '本地没有这篇笔记';
      row.value = null;
      bodyHtml.value = '';
      return;
    }
    row.value = found;
    // 与 article.vue 同口径：渲染前先解析 blob 引用
    bodyHtml.value = renderMarkdown(resolveBlobRefsInMd(found.bodyMd, opts.nodeBaseUrl || ''));
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function goEdit(): void {
  if (!row.value) return;
  uni.navigateTo({ url: `/pages/note/edit?noteId=${encodeURIComponent(row.value.noteId)}` });
}

// 删除前确认；确认后仅删本机（私有笔记绝不上传）
function remove(): void {
  if (!row.value) return;
  uni.showModal({
    title: '删除笔记',
    content: `确定删除「${row.value.title}」吗？`,
    confirmText: '删除',
    cancelText: '取消',
    success: (res) => {
      if (res.confirm) void doDelete();
    },
  });
}

async function doDelete(): Promise<void> {
  const { repo } = await bootstrap();
  await deleteNote(repo, row.value!.noteId);
  uni.navigateBack();
}
</script>

<style>
.wrap { padding: 16px; }
.topbar { display: flex; justify-content: flex-end; gap: 12px; margin-bottom: 8px; }
.edit-btn { color: #2b6cb0; font-size: var(--fs-body); display: inline-flex; align-items: center; min-height: 48px; padding: 0 12px; }
.del-btn { color: #c53030; font-size: var(--fs-body); display: inline-flex; align-items: center; min-height: 48px; padding: 0 12px; }
.title { display: block; font-size: var(--fs-title); font-weight: 600; margin-bottom: 10px; }
.body { font-size: var(--fs-body); line-height: 1.6; color: #333333; }
.body img { max-width: 100%; height: auto; }
.error { display: block; color: #c53030; font-size: var(--fs-body); margin-top: 24px; }
</style>
