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
      <textarea
        ref="bodyRef"
        v-model="form.bodyMd"
        class="area"
        placeholder="课时正文；留空则不显示正文块"
        :selection-start="bodySelStart"
        :selection-end="bodySelEnd"
        :focus="bodyFocus"
      />
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

import { DIFFICULTY_BASIC, DIFFICULTY_CHOICES, DIFFICULTY_INTRO } from '../../core/attrs';
import { uploadBlob } from '../../core/blob';
import { listCarrierCandidates, type CarrierCandidate } from '../../core/carrier-pick';
import { loadContainerForm, saveContainer, startNewLesson, type ContainerForm } from '../../core/course-edit';
import { recordEditFailure } from '../../core/editlog';
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
import { pickLocalFile, type PickedFile } from '../../platform/uni';

/** 课时可挂的载体类型（本册 §2.4；audio 登记在册但播放能力待后续版本） */
const CARRIER_KINDS = ['article', 'quiz', 'video', 'audio'];

const courseId = ref('');
const form = ref<ContainerForm>(startNewLesson(''));
const durationMin = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');

/** 正文编辑：工具栏产出源文本标记；预览是只读派生，不落库（保存口径零改动） */
const bodyRef = ref<{ $el?: Element } | null>(null);
const bodySelStart = ref(-1);
const bodySelEnd = ref(-1);
const bodyFocus = ref(false);
const previewHtml = computed(() => renderMarkdown(form.value.bodyMd));

/** H5：组件根节点下即原生 textarea，用 ref 拿真实选区；其它端落 props 兜底 */
function bodyTextarea(): HTMLTextAreaElement | null {
  const root = bodyRef.value?.$el;
  if (!root || typeof root.querySelector !== 'function') return null;
  return root.querySelector('textarea') as HTMLTextAreaElement | null;
}

/** 工具栏动作：把变换结果写回源文本，并把光标/选区落到新位置。 */
function applyTool(action: ToolbarAction) {
  const field = bodyTextarea();
  const src = form.value.bodyMd;
  const start = field ? field.selectionStart : bodySelStart.value >= 0 ? bodySelStart.value : src.length;
  const end = field ? field.selectionEnd : bodySelEnd.value >= 0 ? bodySelEnd.value : src.length;
  const r = applyToolbar(src, start, end, action);
  form.value.bodyMd = r.text;
  bodySelStart.value = r.start;
  bodySelEnd.value = r.end;
  bodyFocus.value = false;
  nextTick(() => {
    bodyFocus.value = true;
    const el = bodyTextarea();
    if (el) {
      // 直接落到原生节点：绕开组件 model→DOM 的 100ms 防抖，避免光标被重置到末尾
      el.value = r.text;
      el.focus();
      el.setSelectionRange(r.start, r.end);
    }
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

/** bootstrap 上下文：日志出口要拿 `adapters.fs` 与 `opts.workDir`，故在此持有 */
let ctx: AppContext | null = null;

onLoad(async (query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  courseId.value = String(q.courseId ?? '');
  const lessonId = String(q.lessonId ?? '');
  try {
    ctx = await bootstrap();
    caps.value = ctx.capabilities;
    const repo = ctx.repo;
    pickRepo = repo;
    for (const it of await repo.listItems()) carrierTitles.set(it.itemId, it.title || it.itemId);
    if (lessonId !== '') {
      form.value = await loadContainerForm(repo, lessonId, 'lesson');
      durationMin.value = form.value.durationSec > 0 ? String(Math.round(form.value.durationSec / 60)) : '';
    } else if (courseId.value !== '') {
      form.value = startNewLesson(courseId.value);
    } else {
      error.value = '缺少课程 id，无法定位课时';
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

/** 失败落本地日志（`workDir/edit-surface.log`）；取消不落，日志写失败静默不影响主流程。 */
async function logFail(stage: 'pick' | 'upload', e: unknown) {
  if (!ctx) return;
  await recordEditFailure(ctx.adapters.fs, ctx.opts.workDir, stage, String((e as Error)?.message ?? e));
}

/** 选文件 → 上传拿 blob_id；取消返回 null。封面与附件共用一条上传路径。 */
async function uploadOne(): Promise<{ blobId: string; name: string } | null> {
  let picked: PickedFile | null;
  try {
    picked = await pickLocalFile();
  } catch (e) {
    await logFail('pick', e);
    throw e;
  }
  if (!picked) return null;
  const { opts, repo } = await bootstrap();
  let blobId: string;
  try {
    blobId = await uploadBlob(
      { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl },
      picked.bytes,
      picked.name,
    );
  } catch (e) {
    await logFail('upload', e);
    throw e;
  }
  return { blobId, name: picked.name };
}

async function pickCover() {
  if (!canPick.value) {
    error.value = pickBlocked.value;
    return;
  }
  error.value = '';
  try {
    const up = await uploadOne();
    if (up) form.value.cover = up.blobId;
  } catch (e) {
    // 日志已由 uploadOne 按 pick / upload 阶段落盘，此处只出人读文案（避免同一失败写两行）
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
    const up = await uploadOne();
    if (up && !form.value.attachments.some((a) => a.blobId === up.blobId)) form.value.attachments.push(up);
  } catch (e) {
    // 同 pickCover：日志只在 uploadOne 一处落，这里只出文案
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
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

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