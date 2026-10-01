<template>
  <view class="wrap">
    <text class="title">{{ isEdit ? '编辑课程' : '新建课程' }}</text>
    <text class="hint">条目 id：{{ form.itemId }}（不可改，它就是身份）</text>

    <view class="field">
      <text class="label">标题</text>
      <input v-model="form.title" class="input" placeholder="1–200 字" />
    </view>

    <view class="field">
      <text class="label">简介</text>
      <textarea v-model="form.digest" class="area-sm" placeholder="课程简介（可空）" />
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
      <text class="add" @click="applyDirectory('instructor')">+ 提交新讲师</text>
    </view>

    <view class="field">
      <text class="label">分类</text>
      <input v-model="categoryInput" class="input" placeholder="分类名称（可空，可中文）" />
      <text class="add" @click="openCategoryPicker">+ 选本机分类</text>
      <text class="add" @click="applyDirectory('category')">+ 提交新分类</text>
      <view v-if="categoryPickOpen" class="card">
        <text class="label">选择分类</text>
        <input v-model="categoryKeyword" class="input" placeholder="搜索分类" />
        <text v-if="categoryCandidates.length === 0" class="hint">本机还没有已有分类，直接手填即可</text>
        <view class="chips">
          <text
            v-for="c in categoryCandidates"
            :key="c.slug"
            class="chip"
            :class="categoryInput.trim() === c.slug ? 'chip-on' : ''"
            @click="pickCategory(c.slug)"
          >{{ c.label }}</text>
        </view>
        <text class="add" @click="categoryPickOpen = false">收起</text>
      </view>
      <text class="hint">名称即词条键（可中文，≤ 64 字）；空则不归类</text>
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
      <text class="hint">单文件 ≤ 8 MiB；内容寻址，同字节重复上传只存一份</text>
    </view>

    <view class="section">
      <view class="shead">
        <text class="label">课时清单</text>
        <view class="acts">
          <text class="act" @click="openPicker">+ 选已有课时</text>
          <text class="add" @click="addLesson">+ 加一课</text>
        </view>
      </view>
      <text v-if="form.children.length === 0" class="hint">还没有课时；保存后本课程为空课时列表</text>
      <view v-for="(c, i) in form.children" :key="c.itemId" class="row">
        <view class="row-main" @click="openLesson(c)">
          <text class="val">第 {{ i + 1 }} 讲 · {{ lessonTitle(c.itemId) }}</text>
          <text class="sub">{{ c.itemId }}</text>
        </view>
        <text class="act" @click="move(i, -1)">上移</text>
        <text class="act" @click="move(i, 1)">下移</text>
        <text class="del" @click="removeChild(i)">删除</text>
      </view>
      <view v-if="pickOpen" class="card">
        <text class="label">选择课时</text>
        <input v-model="pickKeyword" class="input" placeholder="搜索标题或 item_id" @input="refresh" />
        <text v-if="candidates.length === 0" class="hint">本机还没有可选的条目，先同步内容包</text>
        <view v-for="c in candidates" :key="c.itemId" class="row" @click="chooseLesson(c)">
          <text class="val">{{ c.title }}</text>
          <text class="hint">{{ c.kind }} · {{ c.itemId }}</text>
        </view>
        <text class="add" @click="pickOpen = false">收起</text>
      </view>
      <text class="hint">顺序即「第 N 讲」；空课时也会占位，不要靠删行来隐藏</text>
    </view>

    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="pickBlocked" class="hint">{{ pickBlocked }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <button class="submit" :disabled="busy" @click="submit">{{ busy ? '提交中…' : '保存' }}</button>
  </view>
</template>

<script setup lang="ts">
import { onLoad } from '@dcloudio/uni-app';
import { computed, ref } from 'vue';

import { BADGE_WORDS, BADGE_WORDS_AUTHOR, DIFFICULTY_BASIC, DIFFICULTY_CHOICES, DIFFICULTY_INTRO, TITLE_COLORS } from '../../core/attrs';
import { listCarrierCandidates, type CarrierCandidate } from '../../core/carrier-pick';
import { myIdentityId, roster } from '../../core/contribution';
import { loadContainerForm, saveContainer, startNewCourse, uploadAndStoreBlob, type ChildRow, type ContainerForm } from '../../core/course-edit';
import { splitCategories } from '../../core/course-tree';
import { normalizeTermKey } from '../../core/directory';
import { containerFormFromLedger } from '../../core/my-created';
import { recordEditFailure } from '../../core/editlog';
import type { LocalRepo } from '../../core/repo';
import { UNKNOWN_FLAGS, canPickFile, pickBlockedReason, type CapabilityFlags } from '../../core/selfcheck';
import { newLessonID } from '../../core/submit';
import { bootstrap, type AppContext } from '../../platform';
import { bytesToBase64, pickLocalFile, type PickedFile } from '../../platform/uni';

const form = ref<ContainerForm>(startNewCourse());
const durationMin = ref('');
const isEdit = ref(false);
const lessonTitles = ref<Record<string, string>>({});
const busy = ref(false);
/** 封面预览 src：刚上传 = 内存 dataURL，重进页 = 本地 `file://` 路径（册子 #61 §5）。 */
const coverPreview = ref('');
const error = ref('');
const notice = ref('');

/** 课时选择面板：关键词 + 候选列表（kind 固定 lesson，无需 kind 过滤） */
const pickOpen = ref(false);
const pickKeyword = ref('');
const candidates = ref<CarrierCandidate[]>([]);
/** 本机仓库（候选查询用），bootstrap 后才有值 */
let pickRepo: LocalRepo | null = null;

/** 分类输入（slug）；候选源 = 本机已下载条目里的既有分类（零新接口） */
const categoryInput = ref('');
const categoryPickOpen = ref(false);
const categoryKeyword = ref('');
const categoryAll = ref<Array<{ slug: string; label: string }>>([]);
const categoryCandidates = computed(() => {
  const kw = categoryKeyword.value.trim().toLowerCase();
  if (kw === '') return categoryAll.value;
  return categoryAll.value.filter((c) => c.slug.toLowerCase().includes(kw) || c.label.toLowerCase().includes(kw));
});

/** 治理者身份（#23 名册内）：决定图章候选是 4 种还是 7 种 */
const isGovernor = ref(false);
const badgeChoices = computed(() => (isGovernor.value ? BADGE_WORDS : BADGE_WORDS_AUTHOR));

/** 能力标志：启动时只有 cryptoOk / pickOk 有值，其余 unknown（unknown 不降级，照常尝试） */
const caps = ref<CapabilityFlags>(UNKNOWN_FLAGS);
const pickBlocked = computed(() => pickBlockedReason(caps.value));
const canPick = computed(() => canPickFile(caps.value));

/** bootstrap 上下文：日志出口要拿 `adapters.fs` 与 `opts.workDir`，故在此持有 */
let ctx: AppContext | null = null;

onLoad(async (query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  const courseId = String(q.courseId ?? '');
  const rebuildFrom = String(q.rebuildFrom ?? '');
  try {
    ctx = await bootstrap();
    caps.value = ctx.capabilities;
    pickRepo = ctx.repo;
    if (rebuildFrom !== '') {
      // 复建（册子 #61 §4.3）：内容照搬台账行，身份换成新 id —— 坏 id 不可救时的唯一出路。
      const row = await ctx.repo.getSubmission(rebuildFrom);
      if (row) {
        const rebuilt = containerFormFromLedger(row);
        rebuilt.itemId = startNewCourse().itemId;
        form.value = rebuilt;
      }
    } else if (courseId !== '') {
      isEdit.value = true;
      form.value = await loadContainerForm(ctx.repo, courseId, 'course');
    }
    durationMin.value = form.value.durationSec > 0 ? String(Math.round(form.value.durationSec / 60)) : '';
    categoryInput.value = form.value.category;
    // 封面回显（册子 #61 §5）：与详情页取键逐字一致（`<itemId>/cover`）
    const coverFile = await ctx.repo.findBlobPathByItem(`${form.value.itemId}/cover`);
    coverPreview.value = coverFile ? (coverFile.startsWith('file://') ? coverFile : `file://${coverFile}`) : '';
    const items = await ctx.repo.listItems();
    lessonTitles.value = Object.fromEntries(items.map((i) => [i.itemId, i.title || i.itemId]));
    categoryAll.value = splitCategories(items).map((c) => {
      const slug = c.itemId.replace(/^category\//, '');
      return { slug, label: c.title || slug };
    });
    // 治理者身份按 #23 名册实时派生；联网失败一律按作者档（4 种），不阻塞编辑
    try {
      const o = { adapters: ctx.opts.adapters, repo: ctx.repo, nodeBaseUrl: ctx.opts.nodeBaseUrl };
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

/** 再点一次取消选择（空串 = 不产该属性行） */
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

/** 打开本机分类候选面板（候选已在 onLoad 一次性读出，纯本机过滤） */
function openCategoryPicker() {
  categoryPickOpen.value = true;
}

/** 点选本机分类：回填 slug，再点同一项取消（空串 = 不产该属性行） */
function pickCategory(slug: string) {
  categoryInput.value = categoryInput.value.trim() === slug ? '' : slug;
}

/** 进入补词条页（#58 §3.1）：任何已登记身份均可提交，走目录提案。 */
function applyDirectory(kind: 'category' | 'instructor') {
  uni.navigateTo({ url: `/pages/directory/apply?kind=${kind}` });
}

/** 失败落本地日志（`workDir/edit-surface.log`）；取消不落，日志写失败静默不影响主流程。 */
async function logFail(stage: 'pick' | 'upload', e: unknown) {
  if (!ctx) return;
  // 适配器在 `ctx.opts.adapters`（`AppContext` 没有 `adapters`）——写错会二次抛错掩码真实失败（册子 #61 §3）
  await recordEditFailure(ctx.opts.adapters.fs, ctx.opts.workDir, stage, String((e as Error)?.message ?? e));
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
    // 内容寻址：同 blob 只留一行（重复上传同一文件不该出现两条附件行）
    if (!form.value.attachments.some((a) => a.blobId === blobId)) {
      form.value.attachments.push({ blobId, name: picked.name });
    }
  } catch (e) {
    // 同 pickCover：日志只在 pickFile / storeBlob 一处落，这里只出文案
    error.value = (e as Error).message;
  }
}

function removeAttachment(i: number) {
  form.value.attachments.splice(i, 1);
}

/** 加一课：id 用当前课程 id 立刻拼出（课程 id 在页面打开时就固定了），随后跳课时编辑页 */
function addLesson() {
  const id = newLessonID(form.value.itemId);
  const row: ChildRow = { kind: 'lesson', itemId: id };
  form.value.children.push(row);
  openLesson(row);
}

function openLesson(c: ChildRow) {
  uni.navigateTo({
    url: `/pages/lesson/edit?courseId=${encodeURIComponent(form.value.itemId)}&lessonId=${encodeURIComponent(c.itemId)}`,
  });
}

/** 按关键词刷新课时候选（kind 固定 lesson）；repo 未就绪时置空（不报错）。 */
async function refresh() {
  if (!pickRepo) {
    candidates.value = [];
    return;
  }
  candidates.value = await listCarrierCandidates(pickRepo, ['lesson'], pickKeyword.value);
}

async function openPicker() {
  pickOpen.value = true;
  await refresh();
}

/** 点选候选：同 item_id 已在清单里则只关面板（去重），否则带入后关面板（不跳转，用户可再点行内进入）。 */
function chooseLesson(c: CarrierCandidate) {
  if (!form.value.children.some((x) => x.itemId === c.itemId)) {
    form.value.children.push({ kind: 'lesson', itemId: c.itemId });
  }
  pickOpen.value = false;
}

function lessonTitle(itemId: string): string {
  return lessonTitles.value[itemId] ?? '（新课时，未保存）';
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

/** 分钟输入 → 秒（槽位收秒数字符串，本册 §2.1）；非法一律归 0（= 不产该行） */
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
  f.durationSec = durationSecOf();
  // 分类取值 = 词条键（可中文）；空 / 非法一律归空（= 不产 attr.category 行，#58 §2.2）
  const catRaw = categoryInput.value.trim();
  const catKey = catRaw === '' ? '' : (normalizeTermKey(catRaw) ?? '');
  if (catRaw !== '' && catKey === '') {
    error.value = '分类名称非法或超过 64 个字';
    return;
  }
  f.category = catKey;
  busy.value = true;
  try {
    const { opts, repo } = await bootstrap();
    const out = await saveContainer({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl }, f);
    if (out.ledgerState === 'sent') {
      uni.showToast({ title: out.created ? '已创建' : '已更新', icon: 'success' });
      setTimeout(() => uni.navigateBack(), 600);
      return;
    }
    // pending 会自动补发；failed 需回「我的条目」删除后重投
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
.acts { display: flex; align-items: center; }
.label { display: block; font-size: 14px; color: #666666; margin-bottom: 6px; }
.hint { display: block; font-size: 12px; color: #999999; margin-top: 4px; }
.sub { display: block; font-size: 11px; color: #aaaaaa; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: 14px; }
.area-sm { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 90px; font-size: 14px; }
.chips { display: flex; flex-wrap: wrap; }
.chip { padding: 4px 14px; border: 1px solid #dddddd; border-radius: 14px; margin: 0 10px 6px 0; color: #666666; font-size: 13px; }
.chip-on { border-color: #2b6cb0; color: #2b6cb0; }
.swatch { background: #fafafa; }
.swatch-on { border-color: #2b6cb0; border-width: 2px; }

/* 标题色 6 字色（复用例 #44 §6；标题色不含高亮底，故无 c-mark） */
.c-red { color: #C53030; }
.c-orange { color: #B7791F; }
.c-green { color: #2F855A; }
.c-blue { color: #2B6CB0; }
.c-purple { color: #6B46C1; }
.c-gray { color: #718096; }
.cover-preview { width: 180px; margin-top: 8px; border-radius: 6px; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 12px; }
.row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f5f5f5; }
.row-main { flex: 1; }
.val { flex: 1; font-size: 14px; color: #333333; }
.act { color: #2b6cb0; font-size: 13px; padding: 0 6px; }
.del { color: #c53030; font-size: 13px; padding: 0 6px; }
.add { display: block; color: #2b6cb0; font-size: 14px; padding: 6px 0; }
.error { display: block; color: #c53030; font-size: 13px; margin: 8px 0; }
.notice { display: block; color: #b7791f; font-size: 13px; margin: 8px 0; }
.submit { margin-top: 16px; background: #2b6cb0; color: #ffffff; }
</style>