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
        <view class="tool" @click="colorOpen = true">颜色</view>
        <view class="tool-divider" />
        <view class="tool" @click="sizeOpen = true">字号</view>
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
            <scroll-view scroll-y class="modal-scroll" style="max-height:60vh" @scrolltolower="onBlobScrollLower">
              <view class="blob-grid">
                <view v-for="b in blobRows" :key="b.blobId" class="blob-cell" @click="submitBlobImage(b)" @longpress="onBlobLongpress(b)">
                  <image :src="thumbSrcOf(b)" class="thumb" mode="aspectFill" />
                  <text class="del-btn" @click.stop="handleDeleteBlob(b, $event)">删</text>
                </view>
              </view>
              <text v-if="blobHasMore" class="hint">上滑加载更多（已加载 {{ blobRows.length }} 张）</text>
              <text v-else-if="blobRows.length > 0" class="hint">已全部加载</text>
              <text v-if="blobRows.length === 0" class="hint">本机还没有上传过图片</text>
            </scroll-view>
            <view class="modal-actions">
              <text class="act" @click="closeImageDialog">取消</text>
            </view>
          </block>
        </view>
      </view>
      <!-- 颜色弹层：7 档选一（与字号弹层同构；语义名 + 类名 hint） -->
      <view v-if="colorOpen" class="modal-mask" @click.self="colorOpen = false">
        <view class="modal">
          <view class="modal-tabs">
            <text class="modal-tab modal-tab-on">选择颜色</text>
          </view>
          <view class="size-row color-row">
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
      <!-- 字号弹层：三档选一（册子 #83 §4.3） -->
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
          v-model="bodyMd"
          class="area"
          placeholder="正文内容"
          :focus="bodyFocus"
          @input="onBodyInput"
          @blur="onBodyBlur"
        />
      </view>
      <text class="hint">正文以 Markdown 源文本保存，与课时同口径；支持 [文字]{.c-red} 变色</text>
      <text v-if="probeInfo" class="probe">{{ probeInfo }}</text>
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

<script lang="ts">
// Options 块：renderjs callMethod 官方仅支持「选项式 methods」，故桥回调挂这里；
// 状态本体在 core/caret-report（与 script setup 共享同一 ref 实例）
import { caretLedger as caretLedgerStore, selLedger as selLedgerStore, probeInfo as probeStore } from '../../core/caret-report';

export default {
  methods: {
    onSelectionReport(c: { start: number; end: number } | null) {
      if (c && c.start === c.end) {
        // v3.4：塌陷单点入 caretLedger（点空白处移动光标也保鲜），选区台账清账
        selLedgerStore.value = null;
        caretLedgerStore.value = { start: c.start, end: c.end };
        return;
      }
      selLedgerStore.value = c;
    },
    onBridgeProbe(info: Record<string, unknown>) {
      probeStore.value = JSON.stringify(info);
    },
  },
};
</script>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { caretLedger, selLedger, probeInfo } from '../../core/caret-report';

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
import {
  COLOR_BUTTONS,
  INLINE_BUTTONS,
  PARAGRAPH_BUTTONS,
  SIZE_OPTIONS,
  applyToolbar,
  type ToolbarAction,
} from '../../core/markdown-toolbar';
import { buildQuestionJSON, draftsFromQuestionJSON, emptyDraft, type QuestionDraft } from '../../core/quizdoc';
import { enqueueOrSend, loadItemDraft, newItemID, type SubmitDraft } from '../../core/submit';
import { bytesToBase64, pickLocalFile, type PickedFile } from '../../platform/uni';
import { bootstrap, type AppContext } from '../../platform';
import { syncOnce } from '../../core/sync';
import { flushRelay } from '../../mesh/relay';

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

/** 颜色弹层（7 档收拢，与字号弹层同构） */
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
/** 图库分页：偏移随触底翻页前进；搜索词/开弹窗/上传/删除刷新一律归 0 并替换 */
const blobOffset = ref(0);
/** 上次返回条数 === limit(50) 时视为仍有下一页（触底继续拉） */
const blobHasMore = ref(false);
/** 触底翻页防重入：in-flight 时忽略后续 scrolltolower */
const blobBusy = ref(false);

/** 正文编辑：工具栏产出源文本标记；预览是只读派生，不落库（保存口径零改动） */
const bodyRef = ref<{ $el?: Element } | null>(null);
const bodyFocus = ref(false);
// caretLedger 单点光标台账在 core/caret-report（v3.4 起桥的塌陷上报也入账，跨 script 块共享）
/** App 端 renderjs 写命令：{start,end,text} 对象直传（0.20.7 验证口径），每次换新对象触发 observer */
const caretCmd = ref<{ start: number; end: number; text: string } | null>(null);
/** uni 编译器注入的 renderjs 模块实例：模板 :change:prop 按 module 名匹配；占位仅供 vue-tsc */
const caretBridge: { writeCaret: (cmd: unknown) => void } = { writeCaret: () => {} };
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

/** 工具动作统一入口：读当前光标/选区（H5 live DOM → App 官方 API → 台账 → 末尾）再变换 */
function applyTool(action: ToolbarAction) {
  // \r\n 归一（幂等防御）：App 原生层偶发把 \r\n 写回 v-model，偏移基准必须与源文本一致（册子 #82 §8 教训）
  if (bodyMd.value.includes('\r')) bodyMd.value = bodyMd.value.replace(/\r\n/g, '\n');
  const field = bodyTextarea();
  if (field) {
    runToolbar(field.selectionStart, field.selectionEnd, 'live', action);
    return;
  }
  // App：选区走 renderjs DOM 上报台账（0.20.9 真机定案 getSelectedTextRange 点工具栏返回折叠点）
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
  runToolbar(l?.start ?? bodyMd.value.length, l?.end ?? bodyMd.value.length, l ? 'ledger' : 'fallback', action);
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

/** 在光标处插入任意 markdown：等价于空 before 的包裹动作（册子 #83 §4.1 统一路径） */
function insertMarkdownAtCursor(markdown: string) {
  applyTool({ kind: 'wrap', before: '', after: markdown });
}

/** 同步变换 + 异步写光标（App=renderjs DOM 直写 / H5=DOM 双拍） */
function runToolbar(start: number, end: number, source: 'live' | 'ledger' | 'fallback', action: ToolbarAction) {
  const src = bodyMd.value;
  const r = applyToolbar(src, start, end, action);
  bodyMd.value = r.text;
  caretLedger.value = { start: r.start, end: r.end };
  if (source === 'fallback') {
    uni.showToast({ title: '未取到光标，已插入到正文末尾', icon: 'none' });
  }
  void writeCaret(r.start, r.end);
}

/** 写光标：App 端 renderjs DOM 直写（:selection-start + focus 翻转真机不落位，0.20.9 定案）——
 * len 门控等 v-model flush 完成、rAF 重试防时序竞争（caret-bridge v3）；H5 只走 DOM 双拍（久经验证） */
function writeCaret(start: number, end: number) {
  // #ifdef APP-PLUS
  caretCmd.value = { start, end, text: bodyMd.value };
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
        // 回连代报（spec §4.3）：sync 成功分支上追加，不阻塞 UI、失败静默
        void flushRelay(editCtx.opts).catch(() => {});
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
    blobHasMore.value = false;
    return;
  }
  // 任何刷新（搜索词变化 / 开弹窗 / 上传 / 删除）都归 0 并整表替换，不 append
  blobOffset.value = 0;
  const rows = await searchLocalBlobs({
    db: editCtx.db,
    ownerIdentityId: 'me',
    query: blobQuery.value,
    limit: 50,
    offset: blobOffset.value,
  });
  blobRows.value = rows;
  blobHasMore.value = rows.length === 50;
}

/** 图库触底翻页：offset 前进一页并 append 到现有行后（busy 防重入） */
async function loadMoreBlobs() {
  if (!editCtx || blobBusy.value) return;
  blobBusy.value = true;
  try {
    blobOffset.value += 50;
    const rows = await searchLocalBlobs({
      db: editCtx.db,
      ownerIdentityId: 'me',
      query: blobQuery.value,
      limit: 50,
      offset: blobOffset.value,
    });
    blobRows.value = [...blobRows.value, ...rows];
    blobHasMore.value = rows.length === 50;
  } finally {
    blobBusy.value = false;
  }
}
/** 滚动触底自动加载下一页（仍有下一页时才拉） */
function onBlobScrollLower() {
  if (blobHasMore.value) void loadMoreBlobs();
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
/** 长按图库图片：预览大图 / 复制 markdown 引用（系统 ActionSheet，适老原生可用） */
function onBlobLongpress(b: BlobSearchRow) {
  uni.showActionSheet({
    itemList: ['预览大图', '复制引用'],
    success: (res) => {
      if (res.tapIndex === 0) {
        uni.previewImage({ urls: [thumbSrcOf(b)] });
      } else if (res.tapIndex === 1) {
        uni.setClipboardData({
          data: buildBlobImage(b.blobId, b.name),
          success: () => uni.showToast({ title: '引用已复制', icon: 'none' }),
        });
      }
    },
  });
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

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: var(--fs-title); font-weight: 600; margin-bottom: 12px; }
.tabs { display: flex; margin-bottom: 8px; }
.tab { padding: 6px 16px; border: 1px solid #dddddd; border-radius: 16px; margin-right: 10px; color: #666666; font-size: var(--fs-body); display: inline-flex; align-items: center; min-height: 48px; }
.tab-on { border-color: #2b6cb0; color: #2b6cb0; }
.field { margin-bottom: 14px; }
.label { display: block; font-size: var(--fs-body); color: #666666; margin-bottom: 6px; }
.hint { display: block; font-size: var(--fs-annotate); color: #999999; margin-top: 4px; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: var(--fs-body); min-height: 48px; box-sizing: border-box; }
.opt-in { flex: 1; }
.area { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 220px; font-size: var(--fs-body); }
.toolbar { display: flex; flex-wrap: wrap; margin-bottom: 6px; }
.tool { padding: 4px 10px; margin: 0 6px 6px 0; border: 1px solid #dddddd; border-radius: 6px; color: #444444; font-size: var(--fs-annotate); display: inline-flex; align-items: center; min-height: 48px; box-sizing: border-box; }
.tool-divider { width: 1px; margin: 0 4px 6px; background: #eeeeee; }
.preview-label { display: block; margin: 10px 0 4px; color: #666666; font-size: var(--fs-body); }
.preview { display: block; padding: 8px; border: 1px solid #f0f0f0; border-radius: 6px; font-size: var(--fs-body); line-height: 1.6; color: #333333; }

/* 正文预览变色：7 个枚举类（#44 §6）。c-mark 只改背景、不覆盖字色 */
.c-red { color: #C53030; }
.c-orange { color: #B7791F; }
.c-green { color: #2F855A; }
.c-blue { color: #2B6CB0; }
.c-purple { color: #6B46C1; }
.c-gray { color: #718096; }
.c-mark { background: #FFF3BF; }
/* 字号三档渲染（册子 #83 §4.3）：预览与详情同值 */
.fs-sm { font-size: var(--fs-annotate); }
.fs-lg { font-size: var(--fs-body); }
.fs-xl { font-size: var(--fs-title); }
/* 预览内图片等比缩放（页面 style 无 scoped，App 端 webview DOM 与 H5 均命中；渲染器内联 style 为网页版/服务端场景兜底） */
.preview img { max-width: 100%; height: auto; }
/* 上传预览限高：完整显示不撑爆弹窗（册子 #83 §4.4），规则并入下方 .upload-preview 主定义 */
.size-row { display: flex; gap: 10px; margin-top: 10px; }
/* 颜色弹层 7 档：3 列换行（单行 flex:1 挤压截断标签，真机反馈 0.21.5） */
.color-row { flex-wrap: wrap; }
.color-row .size-opt { flex: 0 0 30%; }
.size-opt { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; }
.qcard { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 12px; }
.qhead { display: flex; justify-content: space-between; }
.opt { display: flex; align-items: center; margin: 6px 0; }
.pick { width: 28px; color: #888888; min-height: 48px; display: inline-flex; align-items: center; }
.pick-on { color: #2b6cb0; }
.add { display: block; color: #2b6cb0; font-size: var(--fs-body); padding: 6px 0; min-height: 48px; }
.del { color: #c53030; font-size: var(--fs-annotate); display: inline-flex; align-items: center; min-height: 48px; }
.error { display: block; color: #c53030; font-size: var(--fs-annotate); margin: 8px 0; }
.notice { display: block; color: #b7791f; font-size: var(--fs-annotate); margin: 8px 0; }
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
.modal-row { padding: 10px 0; border-bottom: 1px solid #f5f5f5; display: flex; align-items: center; gap: 10px; min-height: 48px; }
/* 图片库：4 列方图网格（册子 #83）；gap 8px 保留，(100% - 3×8px) / 4 ≈ 23.5% */
.blob-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.blob-cell { position: relative; width: calc((100% - 24px) / 4); }
.blob-cell .thumb { display: block; width: 100%; aspect-ratio: 1 / 1; border-radius: 6px; background: #f0f0f0; }
.blob-cell .del-btn { position: absolute; top: 4px; right: 4px; padding: 0 5px; border-radius: 4px; background: rgba(255,255,255,0.85); color: #c53030; font-size: var(--fs-annotate); display: flex; align-items: center; justify-content: center; min-height: 48px; min-width: 48px; box-sizing: border-box; }
.upload-preview { width: 100%; max-height: 40vh; border-radius: 8px; margin-bottom: 8px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 12px; padding-top: 12px; }
.act { color: #666; font-size: var(--fs-body); padding: 6px 12px; display: inline-flex; align-items: center; min-height: 48px; }
.act-primary { color: #2b6cb0; font-weight: 500; }
.act-disabled { color: #ccc; }
.probe { font-size: var(--fs-annotate); color: #b7791f; word-break: break-all; }
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
        } else {
          // v3.4：塌陷位移也上报（方向键/程序置位等不触发 touch 的路径），caretLedger 才能保鲜
          owner.callMethod('onSelectionReport', { start: e.selectionStart, end: e.selectionEnd });
        }
      }, 200);
      this._onTouch = (ev) => {
        const e = anchor();
        const owner = this.$ownerInstance;
        if (!e || !owner) return;
        const inArea = ev.target === e || e.contains(ev.target);
        if (!inArea) {
          // 区外触碰（含点工具栏）：补报最近一次非空选区，不毁台账（v3.3 既定口径）
          if (lastSel) owner.callMethod('onSelectionReport', lastSel);
          return;
        }
        // v3.4：区内触碰一律上报当前位置——塌陷单点入 caretLedger（修「空白处插入落错位」），
        // 非空选区入 selLedger；lastSel 按塌陷与否维护
        const sel = { start: e.selectionStart, end: e.selectionEnd };
        lastSel = sel.start !== sel.end ? sel : null;
        owner.callMethod('onSelectionReport', sel);
      };
      document.addEventListener('touchend', this._onTouch, true);
    };
    bind();
  },
  methods: {
    report(el) {
      const owner = this.$ownerInstance;
      if (!owner) return;
      owner.callMethod('onSelectionReport', { start: el.selectionStart, end: el.selectionEnd });
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
      [150, 400, 800].forEach((delay) => {
        setTimeout(() => {
          const e = anchor();
          if (!e || e.value !== cmd.text) return;
          if (e.selectionStart !== cmd.start || e.selectionEnd !== cmd.end) e.setSelectionRange(cmd.start, cmd.end);
        }, delay);
      });
    }
  }
};
</script>