<template>
  <view class="wrap">
    <text class="title">{{ isUpdate ? '重投更新' : '新建投稿' }}</text>

    <view class="tabs">
      <text class="tab" :class="type === 'article' ? 'tab-on' : ''" @click="switchType('article')">文章</text>
      <text class="tab" :class="type === 'quiz' ? 'tab-on' : ''" @click="switchType('quiz')">题库</text>
    </view>
    <text v-if="isUpdate" class="hint">载体与条目 id 在更新模式下不可改（id 就是身份）</text>

    <view class="field">
      <text class="label">标题</text>
      <input v-model="title" class="input" placeholder="1–200 字" />
      <text v-if="isUpdate" class="hint">标题不参与作者签名，只有正文（题库为题组内容）受签名保护</text>
    </view>

    <view v-if="type === 'article'" class="field">
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
        <view
          v-for="b in COLOR_BUTTONS"
          :key="b.key"
          class="tool tool-color"
          :title="b.hint"
          @click="applyTool(b.action)"
        >{{ b.label }}<text class="tool-note">{{ b.hint }}</text></view>
        <view class="tool-divider" />
        <view class="tool" @click="openImageDialog">图片</view>
      </view>
      <!-- 链接对话框：外部链接 / 内部链接 两个 Tab -->
      <view v-if="linkOpen" class="modal-mask" @click.self="closeLinkDialog">
        <view class="modal">
          <view class="modal-tabs">
            <text class="modal-tab" :class="linkTab === 'ext' ? 'modal-tab-on' : ''" @click="linkTab = 'ext'">外部链接</text>
            <text class="modal-tab" :class="linkTab === 'int' ? 'modal-tab-on' : ''" @click="switchLinkTab('int')">内部链接</text>
          </view>
          <block v-if="linkTab === 'ext'">
            <input v-model="extUrl" class="input" placeholder="https://example.com" />
            <input v-model="extText" class="input" placeholder="显示文本（可空，默认用 URL）" />
            <view class="modal-actions">
              <text class="act" @click="closeLinkDialog">取消</text>
              <text class="act act-primary" @click="submitExternalLink">插入</text>
            </view>
          </block>
          <block v-else>
            <input v-model="intQuery" class="input" placeholder="搜索本机条目标题" @input="refreshIntItems" />
            <scroll-view scroll-y class="modal-scroll">
              <view v-for="it in intItems" :key="it.itemId" class="modal-row" @click="submitInternalLink(it)">
                <text class="val">{{ it.title || it.itemId }}</text>
                <text class="hint">{{ it.kind }} · {{ it.itemId }}</text>
              </view>
              <text v-if="intItems.length === 0" class="hint">没有匹配的条目</text>
            </scroll-view>
            <view class="modal-actions">
              <text class="act" @click="closeLinkDialog">取消</text>
            </view>
          </block>
        </view>
      </view>
      <!-- 图片对话框：上传新图 / 图片库 两个 Tab -->
      <view v-if="imageOpen" class="modal-mask" @click.self="closeImageDialog">
        <view class="modal">
          <view class="modal-tabs">
            <text class="modal-tab" :class="imageTab === 'upload' ? 'modal-tab-on' : ''" @click="imageTab = 'upload'">上传新图</text>
            <text class="modal-tab" :class="imageTab === 'library' ? 'modal-tab-on' : ''" @click="switchImageTab('library')">图片库</text>
          </view>
          <block v-if="imageTab === 'upload'">
            <image v-if="uploadPreview !== ''" :src="uploadPreview" mode="widthFix" class="upload-preview" />
            <view class="modal-actions">
              <text class="act" @click="pickAndUploadImage">{{ uploadBusy ? '上传中…' : (uploadedBlobId === '' ? '选择图片并上传' : '重新选图') }}</text>
              <text class="act act-primary" @click="confirmUploadImage" :class="uploadedBlobId === '' ? 'act-disabled' : ''">插入正文</text>
              <text class="act" @click="closeImageDialog">取消</text>
            </view>
            <text v-if="uploadedBlobId !== ''" class="hint">已上传：{{ uploadedFileName || uploadedBlobId }}，点「插入正文」写入光标处</text>
            <input v-model="uploadAlt" class="input" placeholder="alt 文本（可空）" />
          </block>
          <block v-else>
            <input v-model="blobQuery" class="input" placeholder="搜索（可选）" @input="refreshBlobs" />
            <scroll-view scroll-y class="modal-scroll">
              <view class="blob-grid">
                <view v-for="b in blobRows" :key="b.blobId" class="blob-cell" @click="submitBlobImage(b)">
                  <image :src="thumbSrcOf(b)" class="thumb" mode="aspectFill" />
                  <text class="del-btn" @click.stop="handleDeleteBlob(b, $event)">删</text>
                </view>
              </view>
              <text v-if="blobRows.length === 0" class="hint">本机还没有上传过图片</text>
            </scroll-view>
            <view class="modal-actions">
              <text class="act" @click="closeImageDialog">取消</text>
            </view>
          </block>
        </view>
      </view>
      <textarea
        id="body-caret-anchor"
        ref="bodyRef"
        v-model="bodyMd"
        class="area"
        placeholder="正文内容"
        :focus="bodyFocus"
        :selection-start="selStart"
        :selection-end="selEnd"
        @input="onBodyInput"
        @blur="onBodyBlur"
      />
      <text class="hint">正文以 Markdown 源文本保存，与课时同口径；支持 [文字]{.c-red} 变色</text>
      <text class="preview-label">预览</text>
      <rich-text :nodes="previewHtml" class="preview" />
    </view>

    <block v-else>
      <view v-for="(q, i) in drafts" :key="i" class="qcard">
        <view class="qhead">
          <text class="label">第 {{ i + 1 }} 题</text>
          <text v-if="drafts.length > 1" class="del" @click="removeQuestion(i)">删除本题</text>
        </view>
        <input v-model="q.q" class="input" placeholder="题干" />
        <view v-for="(opt, j) in q.options" :key="j" class="opt">
          <text class="pick" :class="q.answer === j ? 'pick-on' : ''" @click="pick(i, j)">{{ q.answer === j ? '●' : '○' }}</text>
          <input v-model="q.options[j]" class="input opt-in" placeholder="选项" />
          <text v-if="q.options.length > 2" class="del" @click="removeOption(i, j)">✕</text>
        </view>
        <text class="add" @click="addOption(i)">+ 选项</text>
        <input v-model="q.explain" class="input" placeholder="解析（可空）" />
      </view>
      <text class="add" @click="addQuestion">+ 加一题</text>
    </block>

    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <button class="submit" :disabled="busy" @click="submit">{{ busy ? '提交中…' : '提交' }}</button>
  </view>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import {
  buildBlobImage,
  composeExternalLink,
  composeInternalLink,
  insertMarkdown,
  resolveBlobUrl,
  searchLocalBlobs,
  searchLocalItems,
  type BlobSearchRow,
  type ItemSearchRow,
} from '../../core/editor-dialogs';
import { decodeSafe, mimeFromName, uploadAndStoreBlob } from '../../core/course-edit';
import { renderMarkdown } from '../../core/markdown';
import { resolveBlobRefsInMd } from '@base/core-ts/blob-refs';
import { resolveCaret } from '../../core/editor-caret';
import {
  COLOR_BUTTONS,
  INLINE_BUTTONS,
  PARAGRAPH_BUTTONS,
  applyToolbar,
  wrapSelection,
  type ToolbarAction,
} from '../../core/markdown-toolbar';
import { buildQuestionJSON, draftsFromQuestionJSON, emptyDraft, type QuestionDraft } from '../../core/quizdoc';
import { enqueueOrSend, loadItemDraft, newItemID, type SubmitDraft } from '../../core/submit';
import { bytesToBase64, pickLocalFile, type PickedFile } from '../../platform/uni';
import { bootstrap, type AppContext } from '../../platform';
import { syncOnce } from '../../core/sync';

const itemId = ref('');
const type = ref<'article' | 'quiz'>('article');
const title = ref('');
const bodyMd = ref('');
const drafts = ref<QuestionDraft[]>([emptyDraft()]);
const busy = ref(false);
const error = ref('');
const notice = ref('');

/** 编辑器对话框上下文（bootstrap 后才有） */
let editCtx: AppContext | null = null;

/** 链接对话框 */
const linkOpen = ref(false);
const linkTab = ref<'ext' | 'int'>('int');
const extUrl = ref('');
const extText = ref('');
const intQuery = ref('');
const intItems = ref<ItemSearchRow[]>([]);

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

/** 在当前光标位置插入一段 markdown 字符串，光标落在串末尾。 */
function insertMarkdownAtCursor(markdown: string) {
  const src = bodyMd.value;
  const field = bodyTextarea();
  const live = field ? { start: field.selectionStart, end: field.selectionEnd } : null;
  const pick = resolveCaret(live, caretLedger.value, src.length);
  const r = wrapSelection(src, pick.caret.start, pick.caret.end, '', markdown);
  bodyMd.value = r.text;
  caretLedger.value = { start: r.start, end: r.end };
  if (pick.source === 'fallback') {
    uni.showToast({ title: '未取到光标，已插入到正文末尾', icon: 'none' });
  }

  // 写光标：App 走 selection-start/end 属性（原生组件应用）；H5 再由 DOM 兜底（下方）
  selStart.value = r.start;
  selEnd.value = r.end;
  bodyFocus.value = true;
  // H5 已证口径：v-model flush 会把光标重置到末尾，双 setTimeout 在 flush 后设回
  // （App 逻辑层无 document，bodyTextarea() 为 null，自动空转无害）
  setTimeout(() => {
    const el = bodyTextarea();
    if (el) el.setSelectionRange(r.start, r.end);
  }, 60);
  setTimeout(() => {
    const el = bodyTextarea();
    if (el) el.setSelectionRange(r.start, r.end);
  }, 250);
}

/** 正文编辑：工具栏产出源文本标记；预览是只读派生，不落库（保存口径零改动） */
const bodyRef = ref<{ $el?: Element } | null>(null);
const bodyFocus = ref(false);
/** 光标台账：单点 = @input/@blur 的 detail.cursor（组件层同步事件）；选区 = renderjs 上报（仅非空选区） */
const caretLedger = ref<{ start: number; end: number } | null>(null);
/** App 端属性写光标：每次变换后设新值驱动 :selection-start/:selection-end 应用；-1 = 不干预 */
const selStart = ref(-1);
const selEnd = ref(-1);
const previewHtml = computed(() => renderMarkdown(resolveBlobRefsInMd(bodyMd.value, editCtx?.opts.nodeBaseUrl ?? '')));

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

/** renderjs 上报入口（App）：真实光标存台账 */
function onCaret(c: { start: number; end: number }) {
  caretLedger.value = { start: c.start, end: c.end };
}
defineExpose({ onCaret });

/** 工具栏动作：把变换结果写回源文本，并把光标/选区落到新位置。 */
function applyTool(action: ToolbarAction) {
  // 核心变换：算出新文本和目标光标位置
  const src = bodyMd.value;
  const field = bodyTextarea();
  const live = field ? { start: field.selectionStart, end: field.selectionEnd } : null;
  const pick = resolveCaret(live, caretLedger.value, src.length);
  const r = applyToolbar(src, pick.caret.start, pick.caret.end, action);

  // 1) 同步 Vue 响应式源（bodyMd 会触发 v-model flush 写 DOM textarea.value）
  bodyMd.value = r.text;
  caretLedger.value = { start: r.start, end: r.end };
  if (pick.source === 'fallback') {
    uni.showToast({ title: '未取到光标，已插入到正文末尾', icon: 'none' });
  }

  // 写光标：App 走 selection-start/end 属性（原生组件应用）；H5 再由 DOM 兜底（下方）
  selStart.value = r.start;
  selEnd.value = r.end;
  bodyFocus.value = true;
  // H5 已证口径：v-model flush 会把光标重置到末尾，双 setTimeout 在 flush 后设回
  // （App 逻辑层无 document，bodyTextarea() 为 null，自动空转无害）
  setTimeout(() => {
    const el = bodyTextarea();
    if (el) el.setSelectionRange(r.start, r.end);
  }, 60);
  setTimeout(() => {
    const el = bodyTextarea();
    if (el) el.setSelectionRange(r.start, r.end);
  }, 250);
}

/** ============ 链接对话框 ============ */
async function openLinkDialog() {
  linkTab.value = 'int';
  intQuery.value = '';
  extUrl.value = '';
  extText.value = '';
  linkOpen.value = true;

  // 自动同步：items 表为空 → 跑一次 syncOnce（课程页手动点的那个）
  if (editCtx) {
    try {
      const rows = await editCtx.db.select('SELECT COUNT(*) AS c FROM items');
      const count = Number((rows[0] as any)?.c ?? 0);
      if (count === 0 && editCtx.opts.nodeBaseUrl) {
        await syncOnce(editCtx.opts);
      }
    } catch (e) {
      console.warn('自动同步失败（不阻断链接弹窗）', e);
    }
  }
  // 打开即加载最近条目（空关键词 → ORDER BY updated_at DESC）
  await refreshIntItems();
}
function closeLinkDialog() {
  linkOpen.value = false;
}
async function switchLinkTab(tab: 'ext' | 'int') {
  linkTab.value = tab;
  if (tab === 'int') {
    intQuery.value = '';
    await refreshIntItems();
  }
}
async function refreshIntItems() {
  if (!editCtx) {
    intItems.value = [];
    return;
  }
  intItems.value = await searchLocalItems({ db: editCtx.db, query: intQuery.value, limit: 30 });
}
function submitExternalLink() {
  const url = extUrl.value.trim();
  if (url === '') {
    uni.showToast({ title: '请先填 URL', icon: 'none' });
    return;
  }
  const md = composeExternalLink(url, extText.value);
  insertMarkdownAtCursor(md);
  closeLinkDialog();
}
function submitInternalLink(it: ItemSearchRow) {
  if (!editCtx) return;
  const baseUrl = editCtx.opts.nodeBaseUrl;
  const md = composeInternalLink(baseUrl, it.itemId, it.title);
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
  // 打开即预加载图库（用户切 Tab 立刻看到）
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
  if (!editCtx) {
    blobRows.value = [];
    return;
  }
  blobRows.value = await searchLocalBlobs({
    db: editCtx.db,
    ownerIdentityId: 'me',
    query: blobQuery.value,
    limit: 50,
  });
}
/** 上传新图 Tab：选文件 → 上传 → 记录 blob_id */
async function pickAndUploadImage() {
  if (!editCtx) {
    uni.showToast({ title: '编辑器尚未初始化', icon: 'none' });
    return;
  }
  uploadBusy.value = true;
  try {
    const picked = await pickLocalFile();
    if (!picked) {
      uploadBusy.value = false;
      return; // 用户取消
    }
    const up = await uploadAndStoreBlob(
      { adapters: editCtx.opts.adapters, repo: editCtx.repo, nodeBaseUrl: editCtx.opts.nodeBaseUrl, workDir: editCtx.opts.workDir },
      'me',              // ownerId：图片归属当前用户（单机固定 'me'）
      { name: picked.name, bytes: picked.bytes },
      // itemId 不传：编辑器图片进独立图库，不绑定条目
    );
    uploadedBlobId.value = up.blobId;
    uploadedFileName.value = picked.name;
    uploadPreview.value = `data:${mimeFromName(picked.name) || 'application/octet-stream'};base64,${bytesToBase64(picked.bytes)}`;
    uni.showToast({ title: `上传成功：${picked.name}`, icon: 'success' });
    // 上传即入库 → 刷新图库，用户切 Tab 立刻能看到
    await refreshBlobs();
  } catch (e) {
    uni.showToast({ title: (e as Error).message, icon: 'none' });
  } finally {
    uploadBusy.value = false;
  }
}
function confirmUploadImage() {
  if (uploadedBlobId.value === '' || !editCtx) return;
  // blob: 协议引用，不硬编码 baseUrl（内容寻址跨节点便携）
  const md = buildBlobImage(uploadedBlobId.value, uploadAlt.value);
  insertMarkdownAtCursor(md);
  closeImageDialog();
}
function imageUrlOf(blobId: string): string {
  // 渲染时用 resolveBlobUrl 把 blob:{hash} 转绝对 URL
  const base = editCtx?.opts.nodeBaseUrl ?? '';
  return resolveBlobUrl(base, `blob:${blobId}`);
}
/** 缩略图 src：本地 blob 文件直读（离线可见）；path 缺失回退节点 URL（在线可见） */
function thumbSrcOf(b: BlobSearchRow): string {
  const p = b.path;
  if (p !== '') return p.startsWith('file://') ? p : `file://${p}`;
  return imageUrlOf(b.blobId);
}
function submitBlobImage(b: BlobSearchRow) {
  if (!editCtx) return;
  const md = buildBlobImage(b.blobId, 'image');
  insertMarkdownAtCursor(md);
  closeImageDialog();
}

async function handleDeleteBlob(b: BlobSearchRow, _e: Event) {
  if (!editCtx) return;
  // 有引用 → 阻止删除（票选治理等多用户身份体系再接 govern.ts）
  const refs = await editCtx.repo.countBlobRefs(b.blobId);
  if (refs > 0) {
    uni.showModal({
      title: '无法删除',
      content: `此图片被 ${refs} 篇文章正文引用，请先在引用方删除后再清理。票选治理功能待多用户身份上线。`,
      showCancel: false,
    });
    return;
  }
  // 无引用 → 确认后删
  uni.showModal({
    title: '删除图片',
    content: `确认删除「${b.name || b.blobId.slice(0, 8)}」？此操作不可恢复。`,
    success: async (res) => {
      if (!res.confirm) return;
      try {
        // 先查文件路径
        const rows = await editCtx!.db.select(`SELECT path FROM blob_index WHERE blob_id=?`, [b.blobId]);
        const path = rows.length > 0 ? String((rows[0] as any).path ?? '') : '';
        await editCtx!.repo.removeBlob(b.blobId);
        // 删本地文件（H5 localStorage 删对应 key；App plus.io fs.unlink）
        if (path && editCtx!.opts.adapters.fs) {
          try { await editCtx!.opts.adapters.fs.remove(path); } catch {}
        }
        uni.showToast({ title: '已删除', icon: 'success' });
        await refreshBlobs();
      } catch (e) {
        uni.showToast({ title: `删除失败：${(e as Error).message}`, icon: 'none' });
      }
    },
  });
}

const isUpdate = computed(() => itemId.value !== '');

onLoad(async (query) => {
  const raw = String((query as Record<string, string> | undefined)?.itemId ?? '');
  try {
    const ctx = await bootstrap();
    editCtx = ctx;
    if (raw === '') return;
    const wanted = decodeSafe(raw);
    // 两级回退（册子 §4.2）：本机台账（可能有 pending/failed 未送达修改）优先 → items 表已同步版本回退
    const row = await ctx.repo.getSubmission(wanted);
    if (row) {
      itemId.value = row.itemId;
      type.value = row.type === 'quiz' ? 'quiz' : 'article';
      title.value = row.title;
      bodyMd.value = row.bodyMd;
      const loaded = row.type === 'quiz' ? draftsFromQuestionJSON(row.questionJson) : [];
      drafts.value = loaded.length > 0 ? loaded : [emptyDraft()];
      return;
    }
    const item = await loadItemDraft(ctx.repo, wanted);
    if (!item) {
      error.value = '本地没有这条记录';
      return;
    }
    itemId.value = item.itemId;
    type.value = item.type;
    title.value = item.title;
    bodyMd.value = item.bodyMd;
    const loaded = item.type === 'quiz' ? draftsFromQuestionJSON(item.questionJson) : [];
    drafts.value = loaded.length > 0 ? loaded : [emptyDraft()];
  } catch (e) {
    error.value = (e as Error).message;
  }
});

/** 新建模式才允许切载体；更新模式的载体由 item_id 前缀固定（本册 §5.4） */
function switchType(next: 'article' | 'quiz') {
  if (!isUpdate.value) type.value = next;
}
function pick(i: number, j: number) {
  drafts.value[i]!.answer = j;
}
function addOption(i: number) {
  drafts.value[i]!.options.push('');
}
function removeOption(i: number, j: number) {
  const q = drafts.value[i]!;
  q.options.splice(j, 1);
  if (q.answer >= q.options.length) q.answer = -1;
}
function addQuestion() {
  drafts.value.push(emptyDraft());
}
function removeQuestion(i: number) {
  drafts.value.splice(i, 1);
}

async function submit() {
  error.value = '';
  notice.value = '';
  const draft: SubmitDraft = {
    itemId: itemId.value || newItemID(type.value),
    type: type.value,
    title: title.value,
    bodyMd: '',
    questionJson: '',
  };
  if (type.value === 'quiz') {
    const built = buildQuestionJSON(drafts.value);
    if (built === null) {
      error.value = '题组内容不合法：每题需题干、至少 2 个选项并选定正确项';
      return;
    }
    draft.questionJson = built;
  } else {
    draft.bodyMd = bodyMd.value;
  }

  busy.value = true;
  try {
    const { opts, repo } = await bootstrap();
    const out = await enqueueOrSend({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl }, draft);
    itemId.value = out.itemId;
    // 保存后刷 blob_references：从 bodyMd 扫 blobId → DELETE + INSERT 到 blob_references
    if (type.value === 'article') {
      const { extractBlobRefs } = await import('@base/core-ts/blob-refs');
      await repo.refreshBlobRefs(itemId.value, extractBlobRefs(bodyMd.value));
    }
    if (out.ledgerState === 'sent') {
      uni.showToast({ title: out.created ? '已提交' : '已更新', icon: 'success' });
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

<!-- #ifdef APP-PLUS -->
<!-- renderjs 桥：App 视图层声明 `caretBridge`（uni 编译器改写为 <renderjs name=…>，vue-tsc 不参与运行） -->
<script module="caretBridge" lang="renderjs" src="src/core/caret-bridge.renderjs.js"></script>
<!-- #endif -->

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 12px; }
.tabs { display: flex; margin-bottom: 8px; }
.tab { padding: 6px 16px; border: 1px solid #dddddd; border-radius: 16px; margin-right: 10px; color: #666666; font-size: 14px; }
.tab-on { border-color: #2b6cb0; color: #2b6cb0; }
.field { margin-bottom: 14px; }
.label { display: block; font-size: 14px; color: #666666; margin-bottom: 6px; }
.hint { display: block; font-size: 12px; color: #999999; margin-top: 4px; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: 14px; }
.opt-in { flex: 1; }
.area { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 220px; font-size: 14px; }
.toolbar { display: flex; flex-wrap: wrap; margin-bottom: 6px; }
.tool { padding: 4px 10px; margin: 0 6px 6px 0; border: 1px solid #dddddd; border-radius: 6px; color: #444444; font-size: 13px; }
.tool-divider { width: 1px; margin: 0 4px 6px; background: #eeeeee; }
.tool-color { display: flex; align-items: baseline; }
.tool-note { margin-left: 3px; color: #999999; font-size: 10px; }
.preview-label { display: block; margin: 10px 0 4px; color: #666666; font-size: 14px; }
.preview { display: block; padding: 8px; border: 1px solid #f0f0f0; border-radius: 6px; font-size: 15px; line-height: 1.7; color: #333333; }

/* 正文预览变色：7 个枚举类（#44 §6）。c-mark 只改背景、不覆盖字色 */
.c-red { color: #C53030; }
.c-orange { color: #B7791F; }
.c-green { color: #2F855A; }
.c-blue { color: #2B6CB0; }
.c-purple { color: #6B46C1; }
.c-gray { color: #718096; }
.c-mark { background: #FFF3BF; }
.qcard { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 12px; }
.qhead { display: flex; justify-content: space-between; }
.opt { display: flex; align-items: center; margin: 6px 0; }
.pick { width: 28px; color: #888888; }
.pick-on { color: #2b6cb0; }
.add { display: block; color: #2b6cb0; font-size: 14px; padding: 6px 0; }
.del { color: #c53030; font-size: 13px; }
.error { display: block; color: #c53030; font-size: 13px; margin: 8px 0; }
.notice { display: block; color: #b7791f; font-size: 13px; margin: 8px 0; }
.submit { margin-top: 16px; background: #2b6cb0; color: #ffffff; }

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
.modal-tab { padding: 8px 16px; color: #888; font-size: 14px; }
.modal-tab-on { color: #2b6cb0; border-bottom: 2px solid #2b6cb0; font-weight: 500; }
.modal-scroll { max-height: 360px; margin-top: 8px; }
.modal-row { padding: 10px 0; border-bottom: 1px solid #f5f5f5; display: flex; align-items: center; gap: 10px; }
/* 图片库：3 列方图网格（册子 #82 §4.4） */
.blob-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.blob-cell { position: relative; width: calc((100% - 16px) / 3); }
.blob-cell .thumb { display: block; width: 100%; aspect-ratio: 1 / 1; border-radius: 6px; background: #f0f0f0; }
.blob-cell .del-btn { position: absolute; top: 4px; right: 4px; padding: 0 5px; border-radius: 4px; background: rgba(255,255,255,0.85); color: #c53030; font-size: 12px; line-height: 18px; }
.upload-preview { width: 100%; border-radius: 8px; margin-bottom: 8px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 12px; padding-top: 12px; }
.act { color: #666; font-size: 14px; padding: 6px 12px; }
.act-primary { color: #2b6cb0; font-weight: 500; }
.act-disabled { color: #ccc; }
</style>