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
          v-for="b in INLINE_BUTTONS"
          :key="b.key"
          class="tool"
          @click="applyTool(b.action)"
        >{{ b.label }}</view>
        <view class="tool-divider" />
        <view
          v-for="b in COLOR_BUTTONS"
          :key="b.key"
          class="tool tool-color"
          :title="b.hint"
          @click="applyTool(b.action)"
        >{{ b.label }}<text class="tool-note">{{ b.hint }}</text></view>
      </view>
      <view :prop="caretCmd" :change:prop="caretBridge.setCaret">
        <textarea
          id="body-caret-anchor"
          ref="bodyRef"
          v-model="form.bodyMd"
          class="area"
          placeholder="课时正文；留空则不显示正文块"
          :focus="bodyFocus"
        />
      </view>
      <text class="hint">正文以 Markdown 源文本保存（槽位 attr.body_md），与文章同口径；支持 [文字]{.c-red} 变色</text>
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

<script setup lang="ts">
import { onLoad } from '@dcloudio/uni-app';
import { computed, nextTick, ref } from 'vue';

import { BADGE_WORDS, BADGE_WORDS_AUTHOR, DIFFICULTY_BASIC, DIFFICULTY_CHOICES, DIFFICULTY_INTRO, TITLE_COLORS } from '../../core/attrs';
import { listCarrierCandidates, type CarrierCandidate } from '../../core/carrier-pick';
import { myIdentityId, roster } from '../../core/contribution';
import { loadContainerForm, saveContainer, startNewLesson, uploadAndStoreBlob, type ContainerForm } from '../../core/course-edit';
import { recordEditFailure, type EditStage } from '../../core/editlog';
import { resolveCaret } from '../../core/editor-caret';
import { renderMarkdown } from '../../core/markdown';
import {
  COLOR_BUTTONS,
  INLINE_BUTTONS,
  PARAGRAPH_BUTTONS,
  applyToolbar,
  type ToolbarAction,
} from '../../core/markdown-toolbar';
import type { LocalRepo } from '../../core/repo';
import { UNKNOWN_FLAGS, canPickFile, pickBlockedReason, type CapabilityFlags } from '../../core/selfcheck';
import { bootstrap, type AppContext } from '../../platform';
import { bytesToBase64, pickLocalFile, type PickedFile } from '../../platform/uni';

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

/** 正文编辑：工具栏产出源文本标记；预览是只读派生，不落库（保存口径零改动） */
const bodyRef = ref<{ $el?: Element } | null>(null);
const bodyFocus = ref(false);
/** renderjs 台账：App 视图层上报的真实光标；H5 不用（走原生 DOM 选区） */
const caretLedger = ref<{ start: number; end: number } | null>(null);
/** 逻辑层 → 视图层的写光标指令；每次换新对象以触发 `:change:prop` */
const caretCmd = ref<{ start: number; end: number; text: string } | null>(null);
/**
 * renderjs 桥在 App 视图层执行，不进入逻辑层组件实例；这里给模板一个同形空实现占位：
 * H5 无 renderjs、该占位会被真调用（no-op），App 上 uni 模板编译器按模块名解析、此值不参与运行。
 */
const caretBridge = {
  setCaret: (_value: { start: number; end: number; text: string }): void => undefined,
};
const previewHtml = computed(() => renderMarkdown(form.value.bodyMd));

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
  const src = form.value.bodyMd;
  const field = bodyTextarea();
  const live = field ? { start: field.selectionStart, end: field.selectionEnd } : null;
  const pick = resolveCaret(live, caretLedger.value, src.length);
  const r = applyToolbar(src, pick.caret.start, pick.caret.end, action);
  // 1) 同步 Vue 响应式源（bodyMd 会触发 v-model flush 写 DOM textarea.value）
  form.value.bodyMd = r.text;
  caretLedger.value = { start: r.start, end: r.end };
  caretCmd.value = { start: r.start, end: r.end, text: r.text };
  if (pick.source === 'fallback') {
    uni.showToast({ title: '未取到光标，已插入到正文末尾', icon: 'none' });
  }

  // 2) 让 textarea 保持焦点（模板 :focus directive 设 true 就不会 blur）
  bodyFocus.value = true;

  // 3) Vue v-model flush 写 textarea.value 时浏览器会把光标重置到末尾
  //    用 setTimeout 在它之后设回正确位置；两次触发防御多次 flush
  setTimeout(() => {
    const el = bodyTextarea();
    if (el) el.setSelectionRange(r.start, r.end);
  }, 60);
  setTimeout(() => {
    const el = bodyTextarea();
    if (el) el.setSelectionRange(r.start, r.end);
  }, 250);
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
  // 先解码（册子 #61 §2.2）：跳转方传 `encodeURIComponent(courseId)`，不解码会拼出 `course%2F…/lesson/…` 的坏 id
  courseId.value = decodedId(String(q.courseId ?? ''));
  const lessonId = String(q.lessonId ?? '');
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

/** 解码路由参数；坏编码回落原样（与详情页 `resolveBy` 同口径）。 */
function decodedId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

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
      form.value.itemId,
      slot,
      { name: picked.name, bytes: picked.bytes },
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

<!-- #ifdef APP-PLUS -->
<!-- renderjs 桥：App 视图层声明 `caretBridge`（uni 编译器改写为 <renderjs name=…>，vue-tsc 不参与运行） -->
<script module="caretBridge" lang="renderjs" src="src/core/caret-bridge.renderjs.js"></script>
<!-- #endif -->

<style>
  .wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 6px; }
.field { margin-bottom: 14px; }
.section { margin-top: 18px; padding-top: 12px; border-top: 1px solid #eeeeee; }
.shead { display: flex; justify-content: space-between; align-items: center; }
.label { display: block; font-size: 14px; color: #666666; margin-bottom: 6px; }
.hint { display: block; font-size: 12px; color: #999999; margin-top: 4px; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: 14px; }
.area { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 220px; font-size: 14px; }
.area-sm { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 80px; font-size: 14px; }
.toolbar { display: flex; flex-wrap: wrap; margin-bottom: 6px; }
.tool { padding: 4px 10px; margin: 0 6px 6px 0; border: 1px solid #dddddd; border-radius: 6px; color: #444444; font-size: 13px; }
.tool-divider { width: 1px; margin: 0 4px 6px; background: #eeeeee; }
.tool-color { display: flex; align-items: baseline; }
.tool-note { margin-left: 3px; color: #999999; font-size: 10px; }
.preview-label { display: block; margin: 10px 0 4px; color: #666666; font-size: 14px; }
.preview { display: block; padding: 8px; border: 1px solid #f0f0f0; border-radius: 6px; font-size: 14px; line-height: 1.8; color: #333333; }

/* 正文预览变色：7 个枚举类（#44 §6）。c-mark 只改背景、不覆盖字色 */
.c-red { color: #C53030; }
.c-orange { color: #B7791F; }
.c-green { color: #2F855A; }
.c-blue { color: #2B6CB0; }
.c-purple { color: #6B46C1; }
.c-gray { color: #718096; }
.c-mark { background: #FFF3BF; }
.chips { display: flex; flex-wrap: wrap; }
.chip { padding: 4px 14px; border: 1px solid #dddddd; border-radius: 14px; margin: 0 10px 6px 0; color: #666666; font-size: 13px; }
.chip-on { border-color: #2b6cb0; color: #2b6cb0; }
.swatch { background: #fafafa; }
.swatch-on { border-color: #2b6cb0; border-width: 2px; }
.cover-preview { width: 180px; margin-top: 8px; border-radius: 6px; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 12px; }
.chead { display: flex; justify-content: space-between; align-items: center; }
.row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f5f5f5; }
.val { flex: 1; font-size: 14px; color: #333333; }
.act { color: #2b6cb0; font-size: 13px; padding: 0 6px; }
.del { color: #c53030; font-size: 13px; padding: 0 6px; }
.add { display: block; color: #2b6cb0; font-size: 14px; padding: 6px 0; }
.error { display: block; color: #c53030; font-size: 13px; margin: 8px 0; }
.notice { display: block; color: #b7791f; font-size: 13px; margin: 8px 0; }
.submit { margin-top: 16px; background: #2b6cb0; color: #ffffff; }
</style>