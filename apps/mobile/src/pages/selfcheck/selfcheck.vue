<template>
  <view class="wrap">
    <view class="bar">
      <text class="title">基座自检</text>
      <text class="act" @click="run">重跑</text>
    </view>

    <text v-if="running" class="hint">探测中…</text>
    <text v-if="degraded" class="warn">本地库不可用，本次为降级自检（只跑不依赖本地库的条目）</text>

    <view v-for="g in groups" :key="g.name" class="grp">
      <text class="grp-name">{{ g.name }}</text>
      <view v-for="r in g.items" :key="r.id" class="row">
        <text class="mark">{{ mark(r.status) }}</text>
        <view class="body">
          <text class="row-name">{{ r.name }}</text>
          <text class="row-detail">{{ r.detail }}</text>
          <text class="row-affects">影响：{{ r.affects }}</text>
        </view>
      </view>
    </view>

    <text v-if="flagsLine" class="meta">{{ flagsLine }}</text>
    <button size="mini" class="copy" :disabled="items.length === 0" @click="copy">复制结果</button>
    <text v-if="tip" class="hint">{{ tip }}</text>

    <view class="log">
      <text class="grp-name">编辑面日志（末尾 4 KiB，只读）</text>
      <pre v-if="logTail" class="log-body">{{ logTail }}</pre>
      <text v-else class="hint">暂无编辑面失败记录</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { applySelfCheck, bootstrap } from '../../platform';
import { plusRuntime } from '../../platform/uni';
import { readEditLog } from '../../core/editlog';
import { runSelfCheck, type CheckResult, type SelfCheckReport } from '../../core/selfcheck';

const report = ref<SelfCheckReport | null>(null);
const running = ref(false);
const tip = ref('');
const logTail = ref('');

const items = computed<CheckResult[]>(() => report.value?.items ?? []);
const degraded = computed(() => report.value?.degraded === true);

/** 按 group 聚合，保持探测表的原始顺序（不二次排序） */
const groups = computed(() => {
  const out: Array<{ name: string; items: CheckResult[] }> = [];
  for (const r of items.value) {
    const last = out[out.length - 1];
    if (last && last.name === r.group) last.items.push(r);
    else out.push({ name: r.group, items: [r] });
  }
  return out;
});

const flagsLine = computed(() => {
  const f = report.value?.flags;
  if (!f) return '';
  const show = (v: string) => (v === 'ok' ? 'ok' : v === 'fail' ? 'fail' : '未测');
  return `能力：随机源 ${show(f.cryptoOk)} / 文件 ${show(f.fsOk)} / 本地库 ${show(f.dbOk)} / 写入 ${show(f.writeOk)}`;
});

function mark(s: CheckResult['status']): string {
  return s === 'ok' ? '✅' : s === 'fail' ? '❌' : '➖';
}

async function run() {
  running.value = true;
  tip.value = '';
  try {
    // bootstrap 失败也得能出报告：此时以降级模式跑（spec §4）
    const app = await bootstrap().catch(() => null);
    const opts = app
      ? {
          adapters: app.opts.adapters,
          repo: app.repo,
          db: app.db,
          nodeBaseUrl: app.opts.nodeBaseUrl,
          workDir: app.opts.workDir,
        }
      : null;
    const r = await runSelfCheck(opts, { plus: plusRuntime() });
    report.value = r;
    applySelfCheck(r);
    // 只读回看编辑面失败现场：日志内容不得写回任何能力标志
    logTail.value = opts ? await readEditLog(opts.adapters.fs, opts.workDir, 4096) : '';
  } catch (e) {
    tip.value = `自检执行失败：${(e as Error).message}`;
  } finally {
    running.value = false;
  }
}

/** 复制文本与页面展示同源：贴回对话就能定位（spec §5）。 */
function copy() {
  const r = report.value;
  if (!r) return;
  const lines = r.items.map((i) => `${mark(i.status)} ${i.name} — ${i.detail}（影响：${i.affects}）`);
  lines.push(flagsLine.value);
  lines.push(`版本：${String(plusRuntime()?.runtime?.version ?? '未知')}`);
  uni.setClipboardData({
    data: lines.join('\n'),
    success: () => {
      tip.value = '已复制';
    },
  });
}

onLoad(() => {
  void run();
});
</script>

<style>
.wrap { padding: 16px; padding-bottom: 40px; }
.bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.title { font-size: 20px; font-weight: 600; }
.act { color: #2b6cb0; font-size: 14px; }
.hint { display: block; color: #888888; font-size: 13px; }
.warn { display: block; margin-bottom: 8px; color: #c05621; font-size: 13px; }
.grp { margin-top: 16px; }
.grp-name { display: block; color: #888888; font-size: 13px; margin-bottom: 4px; }
.row { display: flex; padding: 8px 0; border-bottom: 1px solid #eeeeee; }
.mark { width: 24px; font-size: 15px; }
.body { flex: 1; }
.row-name { display: block; font-size: 15px; }
.row-detail { display: block; color: #666666; font-size: 12px; margin-top: 2px; }
.row-affects { display: block; color: #999999; font-size: 12px; margin-top: 2px; }
.meta { display: block; margin-top: 16px; color: #666666; font-size: 12px; }
.copy { margin-top: 16px; }
.log { margin-top: 20px; }
.log-body { white-space: pre-wrap; word-break: break-all; padding: 8px; background: #f5f5f5; border-radius: 4px; font-size: 11px; color: #444444; }
</style>