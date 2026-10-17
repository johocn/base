<template>
  <view class="wrap">
    <text class="title">编辑课时</text>
    <text class="hint">条目 id：{{ form.itemId }}（不可改，它就是身份）</text>
    <text class="hint">所属课程：{{ courseId }}</text>

    <view class="field">
      <text class="label">标题</text>
      <input v-model="form.title" class="input" placeholder="1–200 字" />
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
      <!-- 链接对话框 -->
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
            <scroll-view scroll-y class="modal-scroll" style="max-height:60vh" @scrolltolower="onBlobScrollLower">
              <view class="blob-grid">
                <view v-for="b in blobRows" :key="b.blobId" class="blob-cell" @click="submitBlobImage(b)" @longpress="onBlobLongpress(b)">
                  <image :src="thumbSrcOf(b)" class="thumb" mode="aspectFill" />
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
          v-model="form.bodyMd"
          class="area"
          placeholder="课时正文；留空则不显示正文块"
          :focus="bodyFocus"
          @input="onBodyInput"
          @blur="onBodyBlur"
        />
      </view>
      <text class="hint">正文以 Markdown 源文本保存（槽位 attr.body_md），与文章同口径；支持 [文字]{.c-red} 变色</text>
      <text v-if="probeInfo" class="probe">{{ probeInfo }}</text>
      <text class="preview-label">预览</text>
      <rich-text :nodes="previewHtml" class="preview" />
    </view>

    <view class="field">
      <text class="label">摘要 / 简介</text>
      <textarea v-model="form.digest" class="area-sm" placeholder="可空；只影响列表摘要，不影响正文" />
    </view>

    <view class="field">
      <text class="label">封面</text>
      <view class="row">
        <text class="val">{{ form.cover === '' ? '未设置' : form.cover }}</text>
        <text class="act" @click="pickCover">{{ form.cover === '' ? '选择图片' : '更换' }}</text>
      </view>
      <image v-if="coverPreview" :src="coverPreview" mode="widthFix" class="cover-preview" />
    </view>

    <view class="field">
      <text class="label">讲师</text>
      <input v-model="form.instructor" class="input" placeholder="可空" />
    </view>

    <view class="field">
      <text class="label">难度</text>
      <view class="chips">
        <text
          v-for="d in DIFFICULTY_CHOICES"
          :key="d"
          class="chip"
          :class="form.difficulty === d ? 'chip-on' : ''"
          @click="toggleDifficulty(d)"
        >{{ difficultyLabel(d) }}</text>
      </view>
    </view>

    <view class="field">
      <text class="label">图章</text>
      <view class="chips">
        <text
          v-for="w in badgeChoices"
          :key="w"
          class="chip"
          :class="form.badge.includes(w) ? 'chip-on' : ''"
          @click="toggleBadge(w)"
        >{{ w }}</text>
      </view>
      <text class="hint">作者可选 4 种、治理者 7 种；可多选，保存时自动去重并按规范序落成一行</text>
    </view>

    <view class="field">
      <text class="label">标题色</text>
      <view class="chips">
        <text
          v-for="c in TITLE_COLORS"
          :key="c"
          class="chip swatch"
          :class="['c-' + c, form.titleColor === c ? 'swatch-on' : '']"
          @click="toggleTitleColor(c)"
        >{{ titleColorLabel(c) }}</text>
      </view>
      <text class="hint">只改标题字色；再点一次取消</text>
    </view>

    <view class="field">
      <text class="label">时长（分钟）</text>
      <input v-model="durationMin" class="input" type="number" placeholder="可空；保存时换算成秒" />
    </view>

    <view class="field">
      <text class="label">附件</text>
      <view v-for="(a, i) in form.attachments" :key="a.blobId" class="row">
        <text class="val">{{ a.name }}</text>
        <text class="del" @click="removeAttachment(i)">删除</text>
      </view>
      <text class="add" @click="addAttachment">+ 添加附件</text>
    </view>

    <view class="section">
      <view class="shead">
        <text class="label">载体清单</text>
        <text class="add" @click="openPicker">+ 添加载体</text>
      </view>
      <text v-if="form.children.length === 0" class="hint">还没有载体；空课时也会在课程页占一行的位次</text>
      <view v-for="(c, i) in form.children" :key="i" class="card">
        <view class="chead">
          <text class="label">第 {{ i + 1 }} 项 · {{ c.kind }}</text>
          <view>
            <text class="act" @click="move(i, -1)">上移</text>
            <text class="act" @click="move(i, 1)">下移</text>
            <text class="del" @click="removeChild(i)">删除</text>
          </view>
        </view>
        <text class="val">{{ carrierTitle(c.itemId) }}</text>
        <text class="hint">{{ c.itemId }}</text>
      </view>
      <view v-if="pickOpen" class="card">
        <text class="label">选择载体</text>
        <input v-model="pickKeyword" class="input" placeholder="搜索标题或 item_id" @input="refresh" />
        <view class="chips">
          <text class="chip" :class="pickKind === '' ? 'chip-on' : ''" @click="setPickKind('')">全部</text>
          <text
            v-for="k in CARRIER_KINDS"
            :key="k"
            class="chip"
            :class="pickKind === k ? 'chip-on' : ''"
            @click="setPickKind(k)"
          >{{ k }}</text>
        </view>
        <text v-if="candidates.length === 0" class="hint">本机还没有可选的条目，先同步内容包</text>
        <view v-for="c in candidates" :key="c.itemId" class="row" @click="chooseCarrier(c)">
          <text class="val">{{ c.title }}</text>
          <text class="hint">{{ c.kind }} · {{ c.itemId }}</text>
        </view>
        <text class="add" @click="pickOpen = false">收起</text>
      </view>
      <text class="hint">顺序即课时页里的展示顺序；kind 由候选行带入，不再手填</text>
    </view>

    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="pickBlocked" class="hint">{{ pickBlocked }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <button class="submit" :disabled="busy" @click="submit">{{ busy ? '提交中…' : '保存' }}</button>
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
import { onLoad } from '@dcloudio/uni-app';
import { computed, ref } from 'vue';

import { caretLedger, probeInfo, selLedger } from '../../core/caret-report';

import { BADGE_WORDS, BADGE_WORDS_AUTHOR, DIFFICULTY_BASIC, DIFFICULTY_CHOICES, DIFFICULTY_INTRO, TITLE_COLORS } from '../../core/attrs';
import { listCarrierCandidates, type CarrierCandidate } from '../../core/carrier-pick';
import { myIdentityId, roster } from '../../core/contribution';
import { decodeSafe, loadContainerForm, mimeFromName, saveContainer, startNewLesson, uploadAndStoreBlob, type ContainerForm } from '../../core/course-edit';
import {
  buildBlobImage,
  composeBlobImg,
  composeExternalLink,
  composeInternalLink,
  searchLocalBlobs,
  searchLocalItems,
  type BlobSearchRow,
  type ItemSearchRow,
} from '../../core/editor-dialogs';
import { recordEditFailure, type EditStage } from '../../core/editlog';
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
import type { LocalRepo } from '../../core/repo';
import { UNKNOWN_FLAGS, canPickFile, pickBlockedReason, type CapabilityFlags } from '../../core/selfcheck';
import { bootstrap, type AppContext } from '../../platform';
import { bytesToBase64, pickLocalFile, type PickedFile } from '../../platform/uni';
import { syncOnce } from '../../core/sync';
import { flushRelay } from '../../mesh/relay';

/** 课时可挂的载体类型（本册 §2.4；audio 登记在册但播放能力待后续版本） */
const CARRIER_KINDS = ['article', 'quiz', 'video', 'audio'];

const courseId = ref('');
const form = ref<ContainerForm>(startNewLesson(''));
const durationMin = ref('');
const busy = ref(false);
/** 封面预览 src：刚上传 = 内存 dataURL，重进页 = 本地 `file://` 路径（册子 #61 §5）。 */
const coverPreview = ref('');
const error = ref('');
const notice = ref('');

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
  // \r\n 归一（幂等防御）：App 原生层偶发把 \r\n 写回 v-model，偏移基准必须与源文本一致（册子 #82 §8 教训）
  if (form.value.bodyMd.includes('\r')) form.value.bodyMd = form.value.bodyMd.replace(/\r\n/g, '\n');
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

/** 在光标处插入任意 markdown：等价于空 before 的包裹动作（册子 #83 §4.1 统一路径） */
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

/** 写光标：App 端 renderjs DOM 直写（:selection-start + focus 翻转真机不落位，0.20.9 定案）——
 * len 门控等 v-model flush 完成、rAF 重试防时序竞争（caret-bridge v3）；H5 只走 DOM 双拍（久经验证） */
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
async function openLinkDialog() {
  linkTab.value = 'int';
  intQuery.value = '';
  extUrl.value = '';
  extText.value = '';
  linkOpen.value = true;

  if (ctx) {
    try {
      const rows = await ctx.db.select('SELECT COUNT(*) AS c FROM items');
      const count = Number((rows[0] as any)?.c ?? 0);
      if (count === 0 && ctx.opts.nodeBaseUrl) {
        await syncOnce(ctx.opts);
        // 回连代报（spec §4.3）：sync 成功分支上追加，不阻塞 UI、失败静默
        void flushRelay(ctx.opts).catch(() => {});
      }
    } catch (e) {
      console.warn('自动同步失败（不阻断链接弹窗）', e);
    }
  }
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
  if (!ctx) {
    intItems.value = [];
    return;
  }
  intItems.value = await searchLocalItems({ db: ctx.db, query: intQuery.value, limit: 30 });
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
  if (!ctx) return;
  const baseUrl = ctx.opts.nodeBaseUrl;
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

/** 图库触底翻页：offset 前进一页并 append 到现有行后（busy 防重入） */
async function loadMoreBlobs() {
  if (!ctx || blobBusy.value) return;
  blobBusy.value = true;
  try {
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
  } finally {
    blobBusy.value = false;
  }
}
/** 滚动触底自动加载下一页（仍有下一页时才拉） */
function onBlobScrollLower() {
  if (blobHasMore.value) void loadMoreBlobs();
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

/** 载体选择面板：关键词 + kind 过滤 + 候选列表 */
const pickOpen = ref(false);
const pickKeyword = ref('');
const pickKind = ref('');
const candidates = ref<CarrierCandidate[]>([]);
/** 本机条目标题缓存（itemId → title || itemId），供清单行只读回显 */
const carrierTitles = new Map<string, string>();
/** 本机仓库（选择候选与标题缓存都要用），bootstrap 后才有值 */
let pickRepo: LocalRepo | null = null;

/** 能力标志：启动时只有 cryptoOk / pickOk 有值，其余 unknown（unknown 不降级，照常尝试） */
const caps = ref<CapabilityFlags>(UNKNOWN_FLAGS);
const pickBlocked = computed(() => pickBlockedReason(caps.value));
const canPick = computed(() => canPickFile(caps.value));

/** 治理者身份（#23 名册内）：决定图章候选是 4 种还是 7 种 */
const isGovernor = ref(false);
const badgeChoices = computed(() => (isGovernor.value ? BADGE_WORDS : BADGE_WORDS_AUTHOR));

/** bootstrap 上下文：日志出口要拿 `adapters.fs` 与 `opts.workDir`，故在此持有 */
let ctx: AppContext | null = null;

onLoad(async (query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  // 先解码（册子 #61 §2.2 + #80 §3.2）：跳转方传 `encodeURIComponent(id)`，不解码会拼出坏 id
  courseId.value = decodeSafe(String(q.courseId ?? ''));
  const lessonId = decodeSafe(String(q.lessonId ?? ''));
  try {
    ctx = await bootstrap();
    caps.value = ctx.capabilities;
    const repo = ctx.repo;
    pickRepo = repo;
    for (const it of await repo.listItems()) carrierTitles.set(it.itemId, it.title || it.itemId);
    if (lessonId !== '') {
      form.value = await loadContainerForm(repo, lessonId, 'lesson');
    } else if (courseId.value !== '') {
      form.value = startNewLesson(courseId.value);
    } else {
      error.value = '缺少课程 id，无法定位课时';
    }
    durationMin.value = form.value.durationSec > 0 ? String(Math.round(form.value.durationSec / 60)) : '';
    // 封面回显（册子 #61 §5）：与详情页取键逐字一致（`<itemId>/cover`）
    const coverFile = await repo.findBlobPathByItem(`${form.value.itemId}/cover`);
    coverPreview.value = coverFile ? (coverFile.startsWith('file://') ? coverFile : `file://${coverFile}`) : '';
    // 治理者身份按 #23 名册实时派生；联网失败一律按作者档（4 种），不阻塞编辑
    try {
      const o = { adapters: ctx.opts.adapters, repo, nodeBaseUrl: ctx.opts.nodeBaseUrl };
      const myId = await myIdentityId(o);
      const list = await roster(o);
      isGovernor.value = myId !== '' && list.some((c) => c.id === myId);
    } catch {
      isGovernor.value = false;
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
});

function difficultyLabel(d: string): string {
  if (d === DIFFICULTY_INTRO) return '入门';
  if (d === DIFFICULTY_BASIC) return '基础';
  return '进阶';
}

function toggleDifficulty(d: string) {
  form.value.difficulty = form.value.difficulty === d ? '' : d;
}

/** 多选图章：再点一次取消（表单里存原始选择集，序列化与去重由 core 负责） */
function toggleBadge(w: string) {
  const cur = form.value.badge;
  const i = cur.indexOf(w);
  if (i >= 0) cur.splice(i, 1);
  else cur.push(w);
}

/** 单选标题色：再点同一个取消（空串 = 不产该行） */
function toggleTitleColor(c: string) {
  form.value.titleColor = form.value.titleColor === c ? '' : c;
}

/** 色块文案（只影响预览显示，不参与契约） */
function titleColorLabel(c: string): string {
  const map: Record<string, string> = { red: '红', orange: '橙', green: '绿', blue: '蓝', purple: '紫', gray: '灰' };
  return map[c] ?? c;
}

/** 失败落本地日志（`workDir/edit-surface.log`）；取消不落，日志写失败静默不影响主流程。 */
async function logFail(stage: EditStage, e: unknown) {
  if (!ctx) return;
  // 适配器在 `ctx.opts.adapters`（`AppContext` 没有 `adapters`）——写错会二次抛错掩码真实失败（册子 #61 §3）
  await recordEditFailure(ctx.opts.adapters.fs, ctx.opts.workDir, stage, String((e as Error)?.message ?? e));
}

/** 提交失败现场（册子 #63 §4.2.2）：手里已是字符串文案，直接落 `submit` 阶段。 */
async function logSubmit(msg: string) {
  if (!ctx) return;
  await recordEditFailure(ctx.opts.adapters.fs, ctx.opts.workDir, 'submit', msg);
}

/** 选文件（取消 → null）；pick 阶段失败落日志并原样抛出。 */
async function pickFile(): Promise<PickedFile | null> {
  try {
    return await pickLocalFile();
  } catch (e) {
    await logFail('pick', e);
    throw e;
  }
}

/** 上传 + 落盘 + 登记（册子 #61 §5）；失败落 upload 阶段日志并原样抛出，成功返回 blob_id。 */
async function storeBlob(slot: string, picked: PickedFile): Promise<string> {
  const { opts, repo } = await bootstrap();
  try {
    const up = await uploadAndStoreBlob(
      { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl, workDir: opts.workDir },
      'me',
      { name: picked.name, bytes: picked.bytes },
      form.value.itemId,    // 封面/附件保留条目关联（墓碑清理用）
    );
    return up.blobId;
  } catch (e) {
    await logFail('upload', e);
    throw e;
  }
}

async function pickCover() {
  if (!canPick.value) {
    error.value = pickBlocked.value;
    return;
  }
  error.value = '';
  try {
    const picked = await pickFile();
    if (!picked) return;
    // 立即出缩略图（册子 #61 §5）：内存 dataURL，不必等落盘或节点返回
    coverPreview.value = `data:image/*;base64,${bytesToBase64(picked.bytes)}`;
    form.value.cover = await storeBlob('cover', picked);
  } catch (e) {
    // 日志已由 pickFile / storeBlob 按阶段落盘，此处只出人读文案（避免同一失败写两行）
    error.value = (e as Error).message;
  }
}

async function addAttachment() {
  if (!canPick.value) {
    error.value = pickBlocked.value;
    return;
  }
  error.value = '';
  try {
    const picked = await pickFile();
    if (!picked) return;
    const blobId = await storeBlob('attachment', picked);
    if (!form.value.attachments.some((a) => a.blobId === blobId)) {
      form.value.attachments.push({ blobId, name: picked.name });
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function removeAttachment(i: number) {
  form.value.attachments.splice(i, 1);
}

/** 按当前 kind 过滤与关键词刷新候选；repo 未就绪时置空（不报错）。 */
async function refresh() {
  if (!pickRepo) {
    candidates.value = [];
    return;
  }
  const kinds = pickKind.value === '' ? CARRIER_KINDS : [pickKind.value];
  candidates.value = await listCarrierCandidates(pickRepo, kinds, pickKeyword.value);
}

async function openPicker() {
  pickOpen.value = true;
  await refresh();
}

/** 标题回显：命中本机条目缓存优先，查不到回落 item_id。 */
function carrierTitle(itemId: string): string {
  return carrierTitles.get(itemId) ?? itemId;
}

/** 点选候选：同 item_id 已在清单里则只关面板（去重），否则带入 kind 与 item_id 后关面板。 */
function chooseCarrier(c: CarrierCandidate) {
  if (!form.value.children.some((x) => x.itemId === c.itemId)) {
    form.value.children.push({ kind: c.kind, itemId: c.itemId });
  }
  pickOpen.value = false;
}

function setPickKind(k: string) {
  pickKind.value = k;
  void refresh();
}

function move(i: number, d: number) {
  const j = i + d;
  const arr = form.value.children;
  if (j < 0 || j >= arr.length) return;
  const t = arr[i]!;
  arr[i] = arr[j]!;
  arr[j] = t;
}

function removeChild(i: number) {
  form.value.children.splice(i, 1);
}

function durationSecOf(): number {
  const raw = durationMin.value.trim();
  if (raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 60);
}

async function submit() {
  error.value = '';
  notice.value = '';
  const f = form.value;
  const blank = f.children.findIndex((c) => c.itemId.trim() === '');
  if (blank >= 0) {
    error.value = `第 ${blank + 1} 个载体的 item_id 不能为空（不需要就删掉这行）`;
    return;
  }
  f.durationSec = durationSecOf();
  busy.value = true;
  try {
    const { opts, repo } = await bootstrap();
    const out = await saveContainer({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl }, f);
    if (out.ledgerState === 'sent') {
      uni.showToast({ title: out.created ? '已创建' : '已更新', icon: 'success' });
      setTimeout(() => uni.navigateBack(), 600);
      return;
    }
    if (out.ledgerState === 'failed') {
      // 失败必须弹（#80 §3.4）：行内小字在长页底部不可见，真机曾静默
      uni.showToast({ title: out.message, icon: 'none' });
    }
    notice.value = out.message;
    await logSubmit(out.message);
  } catch (e) {
    error.value = (e as Error).message;
    await logSubmit(error.value);
  } finally {
    busy.value = false;
  }
}
</script>

<style>
  .wrap { padding: 16px; }
.title { display: block; font-size: var(--fs-title); font-weight: 600; margin-bottom: 6px; }
.field { margin-bottom: 14px; }
.section { margin-top: 18px; padding-top: 12px; border-top: 1px solid #eeeeee; }
.shead { display: flex; justify-content: space-between; align-items: center; }
.label { display: block; font-size: var(--fs-body); color: #666666; margin-bottom: 6px; }
.hint { display: block; font-size: var(--fs-annotate); color: #999999; margin-top: 4px; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: var(--fs-body); min-height: 48px; box-sizing: border-box; }
.area { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 220px; font-size: var(--fs-body); }
.area-sm { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 80px; font-size: var(--fs-body); }
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
.chips { display: flex; flex-wrap: wrap; }
.chip { padding: 4px 14px; border: 1px solid #dddddd; border-radius: 14px; margin: 0 10px 6px 0; color: #666666; font-size: var(--fs-annotate); display: inline-flex; align-items: center; min-height: 48px; }
.chip-on { border-color: #2b6cb0; color: #2b6cb0; }
.swatch { background: #fafafa; }
.swatch-on { border-color: #2b6cb0; border-width: 2px; }
.cover-preview { width: 180px; margin-top: 8px; border-radius: 6px; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 12px; }
.chead { display: flex; justify-content: space-between; align-items: center; }
.row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f5f5f5; min-height: 48px; }
.val { flex: 1; font-size: var(--fs-body); color: #333333; }
.act { color: #2b6cb0; font-size: var(--fs-annotate); padding: 0 6px; display: inline-flex; align-items: center; min-height: 48px; }
.del { color: #c53030; font-size: var(--fs-annotate); padding: 0 6px; display: inline-flex; align-items: center; min-height: 48px; }
.add { display: block; color: #2b6cb0; font-size: var(--fs-body); padding: 6px 0; min-height: 48px; }
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
.blob-cell { position: relative; width: calc((100% - 24px) / 4); min-height: 48px; }
.blob-cell .thumb { display: block; width: 100%; aspect-ratio: 1 / 1; border-radius: 6px; background: #f0f0f0; }
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