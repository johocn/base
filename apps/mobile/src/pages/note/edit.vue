<template>
  <view class="wrap">
    <text class="title">编辑笔记</text>

    <view class="field">
      <text class="label">标题</text>
      <input v-model="form.title" class="input" placeholder="1–200 字" />
    </view>

    <view class="field">
      <text class="label">标签（逗号分隔）</text>
      <input v-model="tagsInput" class="input" placeholder="如：语文,备课" />
    </view>

    <view class="field">
      <text class="label">正文（Markdown）</text>
      <view class="toolbar">
        <view
          v-for="b in PARAGRAPH_BUTTONS"
          :key="b.key"
          class="tool"
          @click="applyTool(b.action)"
        >{{ b.label }}</view>
        <view class="tool-divider" />
        <view
          v-for="b in INLINE_BUTTONS.filter(b => b.key !== 'link')"
          :key="b.key"
          class="tool"
          @click="applyTool(b.action)"
        >{{ b.label }}</view>
        <view class="tool" @click="openLinkDialog">链接</view>
        <view class="tool-divider" />
        <view class="tool" @click="colorOpen = true">颜色</view>
        <view class="tool-divider" />
        <view class="tool" @click="sizeOpen = true">字号</view>
        <view class="tool-divider" />
        <view class="tool" @click="openImageDialog">图片</view>
      </view>
      <!-- 链接对话框（外部链接；笔记不挂本机条目） -->
      <view v-if="linkOpen" class="modal-mask" @click.self="closeLinkDialog">
        <view class="modal">
          <view class="modal-tabs">
            <text class="modal-tab modal-tab-on">外部链接</text>
          </view>
          <input v-model="extUrl" class="input" placeholder="https://example.com" />
          <input v-model="extText" class="input" placeholder="显示文本（可空，默认用 URL）" />
          <view class="modal-actions">
            <text class="act" @click="closeLinkDialog">取消</text>
            <text class="act act-primary" @click="submitExternalLink">插入</text>
          </view>
        </view>
      </view>
      <!-- 图片对话框 -->
      <view v-if="imageOpen" class="modal-mask" @click.self="closeImageDialog">
        <view class="modal">
          <view class="modal-tabs">
            <text class="modal-tab" :class="imageTab === 'upload' ? 'modal-tab-on' : ''" @click="imageTab = 'upload'">上传新图</text>
            <text class="modal-tab" :class="imageTab === 'library' ? 'modal-tab-on' : ''" @click="switchImageTab('library')">图片库</text>
          </view>
          <block v-if="imageTab === 'upload'">
            <image v-if="uploadPreview !== ''" :src="uploadPreview" mode="aspectFit" class="upload-preview" />
            <view class="modal-actions">
              <text class="act" @click="pickAndUploadImage">{{ uploadBusy ? '上传中…' : (uploadedBlobId === '' ? '选择图片并上传' : '重新选图') }}</text>
              <text class="act act-primary" @click="confirmUploadImage" :class="uploadedBlobId === '' ? 'act-disabled' : ''">插入正文</text>
              <text class="act" @click="closeImageDialog">取消</text>
            </view>
            <text v-if="uploadedBlobId !== ''" class="hint">已上传：{{ uploadedFileName || uploadedBlobId }}，点「插入正文」写入光标处</text>
            <input v-model="uploadAlt" class="input" placeholder="alt 文本（可空）" />
          </block>
          <block v-else>
            <input v-model="blobQuery" class="input" placeholder="按文件名搜索" @input="refreshBlobs" />
            <scroll-view scroll-y class="modal-scroll">
              <view class="blob-grid">
                <view v-for="b in blobRows" :key="b.blobId" class="blob-cell" @click="submitBlobImage(b)">
                  <image :src="thumbSrcOf(b)" class="thumb" mode="aspectFill" />
                </view>
              </view>
              <text v-if="blobHasMore" class="add" @click="loadMoreBlobs">加载更多</text>
              <text v-if="blobRows.length === 0" class="hint">本机还没有上传过图片</text>
            </scroll-view>
            <view class="modal-actions">
              <text class="act" @click="closeImageDialog">取消</text>
            </view>
          </block>
        </view>
      </view>
      <!-- 颜色弹层：7 档选一（与字号弹层同构） -->
      <view v-if="colorOpen" class="modal-mask" @click.self="colorOpen = false">
        <view class="modal">
          <view class="modal-tabs">
            <text class="modal-tab modal-tab-on">选择颜色</text>
          </view>
          <view class="size-row">
            <view v-for="c in COLOR_BUTTONS" :key="c.key" class="tool size-opt" :class="c.key" @click="applyColor(c)">
              <text :class="c.key">{{ c.label }}</text>
              <text class="hint">{{ c.hint }}</text>
            </view>
          </view>
          <view class="modal-actions">
            <text class="act" @click="colorOpen = false">取消</text>
          </view>
        </view>
      </view>
      <!-- 字号弹层：三档选一 -->
      <view v-if="sizeOpen" class="modal-mask" @click.self="sizeOpen = false">
        <view class="modal">
          <view class="modal-tabs">
            <text class="modal-tab modal-tab-on">选择字号</text>
          </view>
          <view class="size-row">
            <view v-for="s in SIZE_OPTIONS" :key="s.key" class="tool size-opt" :class="s.key" @click="applySize(s)">
              <text :class="s.key">{{ s.label }}</text>
              <text class="hint">{{ s.key }}</text>
            </view>
          </view>
          <view class="modal-actions">
            <text class="act" @click="sizeOpen = false">取消</text>
          </view>
        </view>
      </view>
      <view :prop="caretCmd" :change:prop="caretBridge.writeCaret">
        <textarea
          id="body-caret-anchor"
          ref="bodyRef"
          v-model="form.bodyMd"
          class="area"
          placeholder="笔记正文；支持 Markdown 与图片"
          :focus="bodyFocus"
          @input="onBodyInput"
          @blur="onBodyBlur"
        />
      </view>
      <text class="hint">正文以 Markdown 源文本保存，仅存本机，不上传</text>
      <text class="preview-label">预览</text>
      <rich-text :nodes="previewHtml" class="preview" />
    </view>

    <text v-if="error" class="error">{{ error }}</text>

    <button class="submit" :disabled="busy" @click="submit">{{ busy ? '保存中…' : '保存' }}</button>
  </view>
</template>

<script lang="ts">
// Options 块：renderjs callMethod 官方仅支持「选项式 methods」，故桥回调挂这里；
// 状态本体在 core/caret-report（与 script setup 共享同一 ref 实例）
import { selLedger as selLedgerStore, probeInfo as probeStore } from '../../core/caret-report';

export default {
  methods: {
    onSelectionReport(c: { start: number; end: number } | null) {
      selLedgerStore.value = c;
    },
    onBridgeProbe(info: Record<string, unknown>) {
      probeStore.value = JSON.stringify(info);
    },
  },
};
</script>

<script setup lang="ts">
import { onLoad } from '@dcloudio/uni-app';
import { computed, ref } from 'vue';

import { selLedger } from '../../core/caret-report';

import { decodeSafe, mimeFromName, uploadAndStoreBlob } from '../../core/course-edit';
import {
  composeBlobImg,
  searchLocalBlobs,
  type BlobSearchRow,
} from '../../core/editor-dialogs';
import { renderMarkdown } from '../../core/markdown';
import { resolveBlobRefsInMd } from '@base/core-ts/blob-refs';
import {
  COLOR_BUTTONS,
  INLINE_BUTTONS,
  PARAGRAPH_BUTTONS,
  SIZE_OPTIONS,
  applyToolbar,
  type ToolbarAction,
} from '../../core/markdown-toolbar';
import { newNoteID, writeNote } from '@base/core-ts/notes';
import { bootstrap, type AppContext } from '../../platform';
import { bytesToBase64, pickLocalFile } from '../../platform/uni';

interface NoteForm {
  noteId: string;
  title: string;
  bodyMd: string;
}

const form = ref<NoteForm>({ noteId: '', title: '', bodyMd: '' });
/** 顶栏标签输入：保存时逗号拆分 */
const tagsInput = ref('');
const busy = ref(false);
const error = ref('');

/** 链接对话框（仅外部链接） */
const linkOpen = ref(false);
const extUrl = ref('');
const extText = ref('');

/** 颜色弹层（与字号弹层同构） */
const colorOpen = ref(false);
/** 字号弹层 */
const sizeOpen = ref(false);
/** 图片对话框 */
const imageOpen = ref(false);
const imageTab = ref<'upload' | 'library'>('upload');
const uploadBusy = ref(false);
const uploadedBlobId = ref('');
const uploadedFileName = ref('');
const uploadAlt = ref('');
/** 上传成功的大图预览（dataURL）；「重新选图」即再点选择覆盖 */
const uploadPreview = ref('');
const blobQuery = ref('');
const blobRows = ref<BlobSearchRow[]>([]);
/** 图库分页：偏移随「加载更多」前进；搜索词/开弹窗/上传刷新一律归 0 并替换 */
const blobOffset = ref(0);
/** 上次返回条数 === limit(50) 时才显示「加载更多」 */
const blobHasMore = ref(false);

/** 正文编辑：工具栏产出源文本标记；预览是只读派生，不落库 */
const bodyRef = ref<{ $el?: Element } | null>(null);
const bodyFocus = ref(false);
/** 光标台账：单点 = @input/@blur 的 detail.cursor（组件层同步事件）；工具动作后 = 变换产出的目标光标/选区 */
const caretLedger = ref<{ start: number; end: number } | null>(null);
/** App 端 renderjs 写命令：{start,end,text} 对象直传，每次换新对象触发 observer */
const caretCmd = ref<{ start: number; end: number; text: string } | null>(null);
/** uni 编译器注入的 renderjs 模块实例：模板 :change:prop 按 module 名匹配；占位仅供 vue-tsc */
const caretBridge: { writeCaret: (cmd: unknown) => void } = { writeCaret: () => {} };
const previewHtml = computed(() => renderMarkdown(resolveBlobRefsInMd(form.value.bodyMd, ctx?.opts.nodeBaseUrl ?? '')));

/** 单点光标补记（App 同步路径）：renderjs 跨层上报滞后是漂移根因，这里不经过它 */
function onBodyInput(e: Event | { detail?: { cursor?: number } }) {
  // App 事件带 detail.cursor；H5 原生 FocusEvent/InputEvent 无 cursor，安全空转
  const c = (e as { detail?: { cursor?: number } })?.detail?.cursor;
  if (typeof c === 'number' && c >= 0) caretLedger.value = { start: c, end: c };
}
function onBodyBlur(e: Event | { detail?: { cursor?: number } }) {
  onBodyInput(e);
}

/** 拿正文原生 textarea：uni-app H5 把 id 移到 <uni-textarea> 包装元素上，直接查标签名 */
function bodyTextarea(): HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLTextAreaElement>('#body-caret-anchor textarea');
}

/** 工具动作统一入口：读当前光标/选区（H5 live DOM → App 官方 API → 台账 → 末尾）再变换 */
function applyTool(action: ToolbarAction) {
  // \r\n 归一（幂等防御）：App 原生层偶发把 \r\n 写回 v-model，偏移基准必须与源文本一致
  if (form.value.bodyMd.includes('\r')) form.value.bodyMd = form.value.bodyMd.replace(/\r\n/g, '\n');
  const field = bodyTextarea();
  if (field) {
    runToolbar(field.selectionStart, field.selectionEnd, 'live', action);
    return;
  }
  // App：选区走 renderjs DOM 上报台账
  const s = selLedger.value;
  if (s && s.start !== s.end) {
    runToolbar(s.start, s.end, 'ledger', action);
    return;
  }
  failToLedger(action);
}

/** 回落台账单点，无台账再落正文末尾 */
function failToLedger(action: ToolbarAction) {
  const l = caretLedger.value;
  runToolbar(l?.start ?? form.value.bodyMd.length, l?.end ?? form.value.bodyMd.length, l ? 'ledger' : 'fallback', action);
}

/** 字号档位点选：包裹/夹位后关弹层 */
function applySize(s: (typeof SIZE_OPTIONS)[number]) {
  sizeOpen.value = false;
  applyTool(s.action);
}

/** 颜色档位点选：包裹/夹位后关弹层（与字号同构） */
function applyColor(c: (typeof COLOR_BUTTONS)[number]) {
  colorOpen.value = false;
  applyTool(c.action);
}

/** 在光标处插入任意 markdown：等价于空 before 的包裹动作 */
function insertMarkdownAtCursor(markdown: string) {
  applyTool({ kind: 'wrap', before: '', after: markdown });
}

/** 同步变换 + 异步写光标（App=renderjs DOM 直写 / H5=DOM 双拍） */
function runToolbar(start: number, end: number, source: 'live' | 'ledger' | 'fallback', action: ToolbarAction) {
  const src = form.value.bodyMd;
  const r = applyToolbar(src, start, end, action);
  form.value.bodyMd = r.text;
  caretLedger.value = { start: r.start, end: r.end };
  if (source === 'fallback') {
    uni.showToast({ title: '未取到光标，已插入到正文末尾', icon: 'none' });
  }
  void writeCaret(r.start, r.end);
}

/** 写光标：App 端 renderjs DOM 直写；H5 只走 DOM 双拍 */
function writeCaret(start: number, end: number) {
  // #ifdef APP-PLUS
  caretCmd.value = { start, end, text: form.value.bodyMd };
  // #endif
  setTimeout(() => {
    const el = bodyTextarea();
    if (el) el.setSelectionRange(start, end);
  }, 60);
  setTimeout(() => {
    const el = bodyTextarea();
    if (el) el.setSelectionRange(start, end);
  }, 250);
}

/** ============ 链接对话框 ============ */
function openLinkDialog() {
  extUrl.value = '';
  extText.value = '';
  linkOpen.value = true;
}
function closeLinkDialog() {
  linkOpen.value = false;
}
function submitExternalLink() {
  const url = extUrl.value.trim();
  if (url === '') {
    uni.showToast({ title: '请先填 URL', icon: 'none' });
    return;
  }
  const md = `[${extText.value.trim() || url}](${url})`;
  insertMarkdownAtCursor(md);
  closeLinkDialog();
}

/** ============ 图片对话框 ============ */
function openImageDialog() {
  imageTab.value = 'upload';
  uploadedBlobId.value = '';
  uploadedFileName.value = '';
  uploadPreview.value = '';
  uploadAlt.value = '';
  uploadBusy.value = false;
  imageOpen.value = true;
  void refreshBlobs();
}
function closeImageDialog() {
  imageOpen.value = false;
}
async function switchImageTab(tab: 'upload' | 'library') {
  imageTab.value = tab;
  if (tab === 'library') {
    blobQuery.value = '';
    await refreshBlobs();
  }
}
async function refreshBlobs() {
  if (!ctx) {
    blobRows.value = [];
    blobHasMore.value = false;
    return;
  }
  // 任何刷新（搜索词变化 / 开弹窗 / 上传）都归 0 并整表替换，不 append
  blobOffset.value = 0;
  const rows = await searchLocalBlobs({
    db: ctx.db,
    ownerIdentityId: 'me',
    query: blobQuery.value,
    limit: 50,
    offset: blobOffset.value,
  });
  blobRows.value = rows;
  blobHasMore.value = rows.length === 50;
}

/** 图库「加载更多」：offset 前进一页并 append 到现有行后 */
async function loadMoreBlobs() {
  if (!ctx) return;
  blobOffset.value += 50;
  const rows = await searchLocalBlobs({
    db: ctx.db,
    ownerIdentityId: 'me',
    query: blobQuery.value,
    limit: 50,
    offset: blobOffset.value,
  });
  blobRows.value = [...blobRows.value, ...rows];
  blobHasMore.value = rows.length === 50;
}
async function pickAndUploadImage() {
  if (!ctx) {
    uni.showToast({ title: '编辑器尚未初始化', icon: 'none' });
    return;
  }
  uploadBusy.value = true;
  try {
    const picked = await pickLocalFile();
    if (!picked) {
      uploadBusy.value = false;
      return;
    }
    const up = await uploadAndStoreBlob(
      { adapters: ctx.opts.adapters, repo: ctx.repo, nodeBaseUrl: ctx.opts.nodeBaseUrl, workDir: ctx.opts.workDir },
      'me',
      { name: picked.name, bytes: picked.bytes },
    );
    uploadedBlobId.value = up.blobId;
    uploadedFileName.value = picked.name;
    uploadPreview.value = `data:${mimeFromName(picked.name) || 'application/octet-stream'};base64,${bytesToBase64(picked.bytes)}`;
    uni.showToast({ title: `上传成功：${picked.name}`, icon: 'success' });
    await refreshBlobs();
  } catch (e) {
    uni.showToast({ title: (e as Error).message, icon: 'none' });
  } finally {
    uploadBusy.value = false;
  }
}
function confirmUploadImage() {
  if (uploadedBlobId.value === '' || !ctx) return;
  const md = composeBlobImg(ctx.opts.nodeBaseUrl, uploadedBlobId.value, uploadAlt.value);
  insertMarkdownAtCursor(md);
  closeImageDialog();
}
function imageUrlOf(blobId: string): string {
  const base = ctx?.opts.nodeBaseUrl ?? '';
  return `${base.replace(/\/+$/, '')}/v1/blob/${blobId}`;
}
/** 缩略图 src：本地 blob 文件直读（离线可见）；path 缺失回退节点 URL（在线可见） */
function thumbSrcOf(b: BlobSearchRow): string {
  const p = b.path;
  if (p !== '') return p.startsWith('file://') ? p : `file://${p}`;
  return imageUrlOf(b.blobId);
}
function submitBlobImage(b: BlobSearchRow) {
  if (!ctx) return;
  const md = composeBlobImg(ctx.opts.nodeBaseUrl, b.blobId, 'image');
  insertMarkdownAtCursor(md);
  closeImageDialog();
}

/** bootstrap 上下文：预览与图库都要拿 nodeBaseUrl / db / repo */
let ctx: AppContext | null = null;

onLoad(async (query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  // 跳转方传 encodeURIComponent(noteId)，不解码会拼出坏 id
  const noteId = decodeSafe(String(q.noteId ?? ''));
  try {
    ctx = await bootstrap();
    if (noteId !== '') {
      // 编辑态：listNotes 全量过滤取行回填（避免再动 repo 接口）
      const row = (await ctx.repo.listNotes()).find((r) => r.noteId === noteId);
      if (!row) {
        error.value = '本地没有这篇笔记';
        return;
      }
      form.value = { noteId: row.noteId, title: row.title, bodyMd: row.bodyMd };
      tagsInput.value = row.tags.join(',');
    } else {
      // 新建态
      form.value = { noteId: newNoteID(), title: '', bodyMd: '' };
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
});

async function submit() {
  const f = form.value;
  if (f.title.trim() === '') {
    uni.showToast({ title: '请先填写标题', icon: 'none' });
    return;
  }
  busy.value = true;
  try {
    const { repo } = await bootstrap();
    const tags = tagsInput.value.split(/[,,]/).map((t) => t.trim()).filter(Boolean);
    await writeNote(repo, { noteId: f.noteId, title: f.title.trim(), bodyMd: f.bodyMd, tags, updatedAt: new Date().toISOString() });
    uni.showToast({ title: '已保存', icon: 'success' });
    setTimeout(() => uni.navigateBack(), 600);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<style>
  .wrap { padding: 16px; }
.title { display: block; font-size: var(--fs-title); font-weight: 600; margin-bottom: 6px; }
.field { margin-bottom: 14px; }
.label { display: block; font-size: var(--fs-body); color: #666666; margin-bottom: 6px; }
.hint { display: block; font-size: var(--fs-annotate); color: #999999; margin-top: 4px; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: var(--fs-body); min-height: 48px; box-sizing: border-box; }
.area { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 220px; font-size: var(--fs-body); }
.toolbar { display: flex; flex-wrap: wrap; margin-bottom: 6px; }
.tool { padding: 4px 10px; margin: 0 6px 6px 0; border: 1px solid #dddddd; border-radius: 6px; color: #444444; font-size: var(--fs-annotate); display: inline-flex; align-items: center; min-height: 48px; box-sizing: border-box; }
.tool-divider { width: 1px; margin: 0 4px 6px; background: #eeeeee; }
.preview-label { display: block; margin: 10px 0 4px; color: #666666; font-size: var(--fs-body); }
.preview { display: block; padding: 8px; border: 1px solid #f0f0f0; border-radius: 6px; font-size: var(--fs-body); line-height: 1.6; color: #333333; }

/* 正文预览变色：7 个枚举类。c-mark 只改背景、不覆盖字色 */
.c-red { color: #C53030; }
.c-orange { color: #B7791F; }
.c-green { color: #2F855A; }
.c-blue { color: #2B6CB0; }
.c-purple { color: #6B46C1; }
.c-gray { color: #718096; }
.c-mark { background: #FFF3BF; }
/* 字号三档渲染：预览与详情同值 */
.fs-sm { font-size: var(--fs-annotate); }
.fs-lg { font-size: var(--fs-body); }
.fs-xl { font-size: var(--fs-title); }
/* 预览内图片等比缩放 */
.preview img { max-width: 100%; height: auto; }
.size-row { display: flex; gap: 10px; margin-top: 10px; }
.size-opt { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; }
.add { display: block; color: #2b6cb0; font-size: var(--fs-body); padding: 6px 0; min-height: 48px; }
.error { display: block; color: #c53030; font-size: var(--fs-annotate); margin: 8px 0; }
.submit { margin-top: 16px; background: #2b6cb0; color: #ffffff; min-height: 48px; padding: 12px 16px; }

/* ============ 链接 / 图片对话框 ============ */
.modal-mask {
  position: fixed; left: 0; top: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center;
  z-index: 99;
}
.modal {
  width: 92%; max-width: 520px;
  background: #ffffff; border-radius: 12px;
  padding: 16px; max-height: 80vh;
}
.modal-tabs { display: flex; border-bottom: 1px solid #eee; margin-bottom: 12px; }
.modal-tab { padding: 8px 16px; color: #888; font-size: var(--fs-body); display: inline-flex; align-items: center; min-height: 48px; }
.modal-tab-on { color: #2b6cb0; border-bottom: 2px solid #2b6cb0; font-weight: 500; }
.modal-scroll { max-height: 360px; margin-top: 8px; }
/* 图片库：4 列方图网格 */
.blob-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.blob-cell { position: relative; width: calc((100% - 24px) / 4); min-height: 48px; }
.blob-cell .thumb { display: block; width: 100%; aspect-ratio: 1 / 1; border-radius: 6px; background: #f0f0f0; }
.upload-preview { width: 100%; max-height: 40vh; border-radius: 8px; margin-bottom: 8px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 12px; padding-top: 12px; }
.act { color: #666; font-size: var(--fs-body); padding: 6px 12px; display: inline-flex; align-items: center; min-height: 48px; }
.act-primary { color: #2b6cb0; font-weight: 500; }
.act-disabled { color: #ccc; }
</style>

<!-- renderjs 桥（内联，官方口径「仅支持内联使用」——外部 src 在 App 端不加载）：
     结构=0.20.7 H5 验证形态 + 轮询读侧；写=直写 el.value 绕 100ms 防抖；源码共享于 core/caret-bridge-snippet.js -->
<script module="caretBridge" lang="renderjs">
function anchor() {
  const root = document.getElementById('body-caret-anchor');
  return root ? root.querySelector('textarea') : null;
}

export default {
  mounted() {
    const probe = () => {
      try {
        const root = document.getElementById('body-caret-anchor');
        const el = root ? root.querySelector('textarea') : null;
        const info = {
          rootFound: !!root,
          rootTag: root ? root.tagName : '',
          elFound: !!el,
          elTag: el ? el.tagName : '',
          valueLen: el ? el.value.length : -1,
          selType: el ? typeof el.selectionStart : 'none'
        };
        const owner = this.$ownerInstance;
        if (owner) owner.callMethod('onBridgeProbe', info);
      } catch (e) {
        const owner = this.$ownerInstance;
        if (owner) owner.callMethod('onBridgeProbe', { probeError: String(e) });
      }
    };
    let tries = 0;
    let lastKey = '';
    let lastSel = null;
    const bind = () => {
      const el = anchor();
      if (!el) {
        tries += 1;
        if (tries < 40) {
          setTimeout(bind, 50);
        } else {
          probe();
        }
        return;
      }
      probe();
      el.addEventListener('focus', () => this.report(el));
      el.addEventListener('blur', () => this.report(el));
      el.addEventListener('input', () => this.report(el));
      this._poll = setInterval(() => {
        const e = anchor();
        const owner = this.$ownerInstance;
        if (!e || !owner) return;
        const key = e.selectionStart + ':' + e.selectionEnd;
        if (key === lastKey) return;
        lastKey = key;
        if (e.selectionStart !== e.selectionEnd) {
          lastSel = { start: e.selectionStart, end: e.selectionEnd };
          owner.callMethod('onSelectionReport', lastSel);
        }
      }, 200);
      this._onTouch = (ev) => {
        const e = anchor();
        const owner = this.$ownerInstance;
        if (!e || !owner) return;
        const inArea = ev.target === e || e.contains(ev.target);
        if (!inArea && lastSel) {
          owner.callMethod('onSelectionReport', lastSel);
        } else if (inArea && e.selectionStart === e.selectionEnd && lastSel) {
          lastSel = null;
          owner.callMethod('onSelectionReport', null);
        }
      };
      document.addEventListener('touchend', this._onTouch, true);
    };
    bind();
  },
  methods: {
    report(el) {
      const owner = this.$ownerInstance;
      if (!owner) return;
      if (el.selectionStart !== el.selectionEnd) {
        owner.callMethod('onSelectionReport', { start: el.selectionStart, end: el.selectionEnd });
      }
    },
    writeCaret(cmd) {
      if (!cmd || typeof cmd.text !== 'string') return;
      const el = anchor();
      if (!el) return;
      const owner = this.$ownerInstance;
      if (owner && !this._writeProbed) {
        this._writeProbed = true;
        owner.callMethod('onBridgeProbe', { writeCalled: true, start: cmd.start, end: cmd.end, textLen: cmd.text.length });
      }
      el.focus();
      el.value = cmd.text;
      el.setSelectionRange(cmd.start, cmd.end);
      setTimeout(() => {
        const e = anchor();
        if (e && e.value.length === cmd.text.length) e.setSelectionRange(cmd.start, cmd.end);
      }, 150);
    }
  }
};
</script>
