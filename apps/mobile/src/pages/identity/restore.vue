<template>
  <view class="wrap">
    <text class="title">恢复账号</text>
    <text class="hint">选一种方式即可。恢复后，本机之前的身份会被覆盖（内容所有权随私钥走）。</text>

    <view class="tabs">
      <text
        class="tab"
        :class="mode === 'escrow' ? 'tab-on' : ''"
        @click="mode = 'escrow'"
      >用户名 + 密码</text>
      <text
        class="tab"
        :class="mode === 'backup' ? 'tab-on' : ''"
        @click="mode = 'backup'"
      >粘贴备份串</text>
    </view>

    <!-- 方式一：托管用户名 + 密码 -->
    <view v-if="mode === 'escrow'" class="section">
      <view class="field">
        <text class="label">托管用户名</text>
        <input v-model="username" class="input" placeholder="3-32 位字母/数字/下划线" />
      </view>
      <view class="field">
        <text class="label">托管密码</text>
        <input v-model="password" class="input" type="password" placeholder="你绑定托管时设的那个" />
      </view>
      <button class="submit" :disabled="busy" @click="doRestoreEscrow">
        {{ busy ? '恢复中…' : '恢复账号' }}
      </button>
    </view>

    <!-- 方式二：粘贴备份串 -->
    <view v-if="mode === 'backup'" class="section">
      <text class="hint">把旧设备上抄下来的 64 位 hex 备份串粘进来。</text>
      <view class="field">
        <textarea v-model="backup" class="area" placeholder="0123456789abcdef…（共 64 位）" />
      </view>
      <button class="submit" :disabled="busy" @click="restoreBackup">
        {{ busy ? '恢复中…' : '从备份串恢复' }}
      </button>
    </view>

    <text v-if="error" class="err">{{ error }}</text>
    <text v-if="tip" class="tip">{{ tip }}</text>

    <view class="section">
      <text class="hint">恢复完成后会自动登记公钥；如果节点暂时连不上，下次联网会自动补登记。</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import { bootstrap } from '../../platform';
import { peekLocalIdentity } from '../../core/identity';
import { restoreEscrow as restoreEscrowRemote, restoreFromBackup } from '../../core/escrow';

const mode = ref<'escrow' | 'backup'>('escrow');
const username = ref('');
const password = ref('');
const backup = ref('');
const busy = ref(false);
const error = ref('');
const tip = ref('');

/** 覆盖前确认：本机已有身份时弹框，用户点确定才继续 */
async function confirmOverwrite(existingId: string): Promise<boolean> {
  return new Promise((resolve) => {
    uni.showModal({
      title: '覆盖本机身份？',
      content: `本机已存在身份 ${existingId.slice(0, 8)}…，恢复将覆盖它。确定继续吗？`,
      confirmText: '确定恢复',
      cancelText: '取消',
      success: (r) => resolve(r.confirm),
      fail: () => resolve(false),
    });
  });
}

/** 进入恢复前：若本机已有身份则弹确认；否则直接放行 */
async function preflight(): Promise<boolean> {
  const { opts } = await bootstrap();
  const existing = await peekLocalIdentity(opts.adapters.storage);
  if (!existing) return true; // 新手机，没什么好确认的
  return confirmOverwrite(existing.id);
}

async function doRestoreEscrow() {
  const u = username.value.trim();
  const p = password.value;
  if (!u || !p) {
    error.value = '请填写用户名和密码';
    return;
  }
  if (!(await preflight())) return;
  await doRestore(async () => {
    const { opts } = await bootstrap();
    const ident = await restoreEscrowRemote(opts, u, p);
    tip.value = `恢复成功！身份 id：${ident.id}`;
  });
}

async function restoreBackup() {
  const b = backup.value.trim();
  if (!b) {
    error.value = '请粘贴备份串';
    return;
  }
  if (!(await preflight())) return;
  await doRestore(async () => {
    const { opts } = await bootstrap();
    const ident = await restoreFromBackup(opts, b);
    tip.value = `恢复成功！身份 id：${ident.id}`;
  });
}

async function doRestore(fn: () => Promise<void>) {
  busy.value = true;
  error.value = '';
  tip.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.title { font-size: 20px; font-weight: 600; }
.hint { display: block; color: #666666; font-size: 12px; margin-top: 4px; }
.tabs { display: flex; margin-top: 14px; }
.tab { padding: 6px 12px; border: 1px solid #dddddd; border-radius: 14px; margin-right: 8px; font-size: 13px; color: #666666; }
.tab-on { border-color: #2b6cb0; color: #2b6cb0; }
.section { margin-top: 14px; }
.field { margin-top: 10px; }
.label { display: block; color: #666666; font-size: 13px; margin-bottom: 4px; }
.input { border: 1px solid #dddddd; border-radius: 6px; padding: 8px; font-size: 14px; width: 100%; }
.area { border: 1px solid #dddddd; border-radius: 6px; padding: 8px; width: 100%; height: 140px; font-size: 12px; font-family: ui-monospace, monospace; word-break: break-all; }
.submit { margin-top: 12px; background: #2b6cb0; color: #ffffff; }
.submit[disabled] { background: #dddddd; color: #888888; }
.tip { display: block; color: #2f855a; font-size: 13px; margin-top: 8px; }
.err { display: block; color: #c53030; font-size: 13px; margin-top: 8px; }
</style>
