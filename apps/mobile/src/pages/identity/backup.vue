<template>
  <view class="wrap">
    <text class="title">账号托管与备份</text>
    <text class="hint">换手机后，用托管密码或备份串即可恢复本账号，内容继承权不变。</text>

    <view class="section">
      <text class="shead">当前身份</text>
      <view class="row">
        <text class="label">身份 id</text>
        <text class="val mono">{{ identId }}</text>
      </view>
      <view class="row">
        <text class="label">本机托管用户名</text>
        <text class="val">{{ escrowUsername || '尚未设置' }}</text>
      </view>
    </view>

    <view class="section">
      <text class="shead">设置托管密码（推荐）</text>
      <text class="hint">节点只存密文，从不接触你的密码或私钥。密码丢了无法找回，请自行记住。</text>
      <view class="field">
        <text class="label">用户名</text>
        <input v-model="username" class="input" placeholder="3-32 位字母/数字/下划线" :value="escrowUsername" />
      </view>
      <view class="field">
        <text class="label">密码</text>
        <input v-model="password" class="input" type="password" placeholder="至少 4 位" />
      </view>
      <view class="field">
        <text class="label">再输一遍</text>
        <input v-model="confirm" class="input" type="password" placeholder="同上" />
      </view>
      <text v-if="pwMismatch" class="err">两次密码不一致</text>
      <button class="submit" :disabled="busy || !!pwMismatch" @click="bind">
        {{ busy ? '处理中…' : (escrowUsername ? '更新托管密码' : '绑定托管') }}
      </button>
      <text v-if="tip" class="tip">{{ tip }}</text>
      <text v-if="error" class="err">{{ error }}</text>
    </view>

    <view class="section">
      <text class="shead">导出备份串（备选方案）</text>
      <text class="hint">32 字节种子的 hex 形式。抄写或拍照保存即可，离线恢复不依赖节点。</text>
      <button class="ghost" @click="showBackup">{{ busyBackup ? '读取中…' : '显示备份串' }}</button>
      <view v-if="backupVisible" class="backup-box">
        <text class="backup mono">{{ backupText }}</text>
        <text class="warn">⚠ 私钥明文，拍照/截图后请妥善保存，不要发给任何人</text>
        <text class="copy" @click="hideBackup">我已抄好，隐藏</text>
      </view>
    </view>

    <view class="section">
      <text class="shead">换手机了？</text>
      <navigator url="/pages/identity/restore" class="link">去恢复页面 →</navigator>
    </view>
  </view>
</template>

<script setup lang="ts">
import { onShow } from '@dcloudio/uni-app';
import { ref, watch } from 'vue';

import { bootstrap } from '../../platform';
import { peekLocalIdentity, exportIdentityBackup } from '../../core/identity';
import { setupEscrow } from '../../core/escrow';

const identId = ref('');
const escrowUsername = ref('');
const username = ref('');
const password = ref('');
const confirm = ref('');
const busy = ref(false);
const busyBackup = ref(false);
const tip = ref('');
const error = ref('');
const backupVisible = ref(false);
const backupText = ref('');

const pwMismatch = ref(false);

onShow(async () => {
  try {
    const { opts } = await bootstrap();
    const ident = await peekLocalIdentity(opts.adapters.storage);
    identId.value = ident?.id ?? '(尚未生成本机身份)';
    escrowUsername.value = '';
    // 读本机存的 escrowUsername：identity 表里没有单独字段，只有 LocalIdentityRecord.escrowUsername
    // peekLocalIdentity 本身不返回，所以这里暂时空着——UI 允许用户重新绑（幂等覆盖）
    password.value = '';
    confirm.value = '';
    tip.value = '';
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
});

// 实时校验密码
function checkPw() {
  if (password.value || confirm.value) {
    pwMismatch.value = !!password.value && !!confirm.value && password.value !== confirm.value;
  } else {
    pwMismatch.value = false;
  }
}
// 绑定到 reactive 变化
watch([password, confirm], checkPw);

async function bind() {
  checkPw();
  if (pwMismatch.value) {
    error.value = '两次密码不一致';
    return;
  }
  const u = username.value.trim();
  const p = password.value;
  if (!u) {
    error.value = '请填写用户名';
    return;
  }
  if (!p || p.length < 4) {
    error.value = '密码至少 4 位';
    return;
  }
  busy.value = true;
  error.value = '';
  tip.value = '';
  try {
    const { opts } = await bootstrap();
    await setupEscrow(opts, u, p);
    escrowUsername.value = u;
    username.value = u;
    password.value = '';
    confirm.value = '';
    tip.value = '托管密码已绑定，节点可以帮你找回账号了';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = msg;
  } finally {
    busy.value = false;
  }
}

async function showBackup() {
  busyBackup.value = true;
  try {
    const { opts } = await bootstrap();
    const ident = await peekLocalIdentity(opts.adapters.storage);
    if (!ident) {
      error.value = '本机尚未生成本地身份';
      return;
    }
    backupText.value = exportIdentityBackup(ident);
    backupVisible.value = true;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busyBackup.value = false;
  }
}

function hideBackup() {
  backupVisible.value = false;
  backupText.value = '';
}
</script>

<style>
.wrap { padding: 16px; }
.title { font-size: 20px; font-weight: 600; }
.hint { display: block; color: #666666; font-size: 12px; margin-top: 4px; }
.section { margin-top: 20px; padding-top: 12px; border-top: 1px solid #eeeeee; }
.shead { display: block; font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.row { display: flex; justify-content: space-between; padding: 4px 0; }
.label { color: #666666; font-size: 13px; }
.val { color: #333333; font-size: 13px; max-width: 60%; }
.mono { font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; }
.field { margin-top: 10px; }
.input { border: 1px solid #dddddd; border-radius: 6px; padding: 8px; font-size: 14px; width: 100%; }
.submit { margin-top: 12px; background: #2b6cb0; color: #ffffff; }
.submit[disabled] { background: #dddddd; color: #888888; }
.tip { display: block; color: #2f855a; font-size: 13px; margin-top: 8px; }
.err { display: block; color: #c53030; font-size: 13px; margin-top: 6px; }
.ghost { margin-top: 8px; }
.backup-box { margin-top: 10px; padding: 12px; background: #fafafa; border-radius: 6px; }
.backup { display: block; word-break: break-all; font-size: 12px; background: #fff; padding: 8px; border-radius: 4px; border: 1px solid #eee; }
.warn { display: block; color: #c53030; font-size: 12px; margin-top: 8px; }
.copy { display: block; margin-top: 8px; color: #2b6cb0; font-size: 13px; text-align: right; }
.link { display: block; color: #2b6cb0; font-size: 14px; margin-top: 4px; }
</style>
