<template>
  <view class="wrap">
    <text class="h">R2 源端保活验证（spike，验证后删除）</text>

    <view class="row">
      <text class="label">屏幕常亮（plus.device.setWakelock）</text>
      <switch :checked="screenLock" @change="toggleScreenLock" />
    </view>
    <view class="row">
      <text class="label">CPU WakeLock（PARTIAL_WAKE_LOCK）</text>
      <switch :checked="cpuLock" @change="toggleCpuLock" />
    </view>
    <button class="btn" @click="requestBatteryWhitelist">申请电池优化白名单</button>
    <text class="hint">batteryOk = {{ batteryOk === null ? '未检测' : batteryOk ? '已忽略' : '未忽略' }}</text>

    <button class="btn" @click="toggleServer">
      {{ serverOn ? `停止 Server (:${PORT})` : `启动 Server (:${PORT})` }}
    </button>

    <view class="stat">
      <text>accept 计数：{{ acceptCount }}</text>
      <text>最近活动：{{ lastActivity }}</text>
      <text>当前时间：{{ now }}</text>
    </view>

    <text class="h2">日志</text>
    <scroll-view class="logs" scroll-y>
      <text v-for="(l, i) in logs" :key="i" class="log">{{ l }}</text>
    </scroll-view>
  </view>
</template>

<script setup lang="ts">
/**
 * R2 spike：验证 Android 源端（ServerSocket）在息屏/后台/电池优化下的存活能力。
 * 三种保活手段独立开关，配合场景矩阵使用（见评审 R2）：
 *   S1 亮屏 + 屏幕常亮        → baseline，预期稳定
 *   S2 息屏 + 无保活          → 预期失败（JS 节流）
 *   S3 息屏 + CPU 锁 + 白名单 → 关键判定场景
 *   S4 亮屏 + 切后台（home）  → 模拟源端切走
 * 判定：客户端每 30s GET /ping 连续 5 分钟成功率 ≥95% = PASS。
 */
import { onUnmounted, ref } from 'vue';

const PORT = 8712;

const screenLock = ref(false);
const cpuLock = ref(false);
const batteryOk = ref<boolean | null>(null);
const serverOn = ref(false);
const acceptCount = ref(0);
const lastActivity = ref('—');
const now = ref('—');
const logs = ref<string[]>([]);

let server: any = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let cpuLockRef: any = null;
let pollBusy = false;

function log(msg: string) {
  const ts = new Date().toLocaleTimeString();
  logs.value = [...logs.value.slice(-40), `[${ts}] ${msg}`];
}

function plusAny(): any {
  return (globalThis as any).plus;
}

function toggleScreenLock(e: any) {
  screenLock.value = e.detail.value;
  try {
    plusAny().device.setWakelock(screenLock.value);
    log(`setWakelock(${screenLock.value}) 调用成功`);
  } catch (err) {
    screenLock.value = false;
    log(`setWakelock 异常: ${String(err)}`);
  }
}

function toggleCpuLock(e: any) {
  cpuLock.value = e.detail.value;
  const plus = plusAny();
  if (!plus?.android) {
    log('plus.android 不可用（H5/老内核），CPU 锁不可测');
    cpuLock.value = false;
    return;
  }
  try {
    if (cpuLock.value) {
      const main = plus.android.runtimeMainActivity();
      const Context = plus.android.importClass('android.content.Context');
      plus.android.importClass('android.os.PowerManager');
      const pm = main.getSystemService(Context.POWER_SERVICE);
      cpuLockRef = pm.newWakeLock(0x00000001 /* PARTIAL_WAKE_LOCK */, 'base:r2-spike');
      cpuLockRef.acquire();
      log('CPU WakeLock acquired');
    } else if (cpuLockRef) {
      cpuLockRef.release();
      cpuLockRef = null;
      log('CPU WakeLock released');
    }
  } catch (err) {
    cpuLock.value = false;
    cpuLockRef = null;
    log(`CPU WakeLock 异常: ${String(err)}`);
  }
}

function requestBatteryWhitelist() {
  const plus = plusAny();
  if (!plus?.android) {
    log('plus.android 不可用，仅真机 Android 可测');
    return;
  }
  try {
    const main = plus.android.runtimeMainActivity();
    const Context = plus.android.importClass('android.content.Context');
    plus.android.importClass('android.os.PowerManager');
    const pm = main.getSystemService(Context.POWER_SERVICE);
    const pkg = main.getPackageName();
    batteryOk.value = pm.isIgnoringBatteryOptimizations(pkg);
    if (batteryOk.value) {
      log('已在电池优化白名单');
      return;
    }
    // 跳系统设置面板（免 manifest 权限的路径）
    const Intent = plus.android.importClass('android.content.Intent');
    const intent = new Intent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
    main.startActivity(intent);
    log('已跳转电池优化设置，请把本应用设为「不优化」后返回');
  } catch (err) {
    log(`白名单检测异常: ${String(err)}`);
  }
}

/** 读取请求头（粗读到 \r\n\r\n 即可，spike 只需区分 GET 路径）并回一个最小 HTTP 响应 */
function serveSocket(sock: any) {
  try {
    plusAny().android.importClass('java.io.InputStream');
    const input = sock.getInputStream();
    const buf = javaByteArray(4096);
    let head = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 1000 && head.indexOf('\r\n\r\n') < 0) {
      const n = input.read(buf);
      if (n < 0) break;
      head += javaString(buf, n);
    }
    const path = head.split(' ')[1] ?? '/';
    const body = path.startsWith('/ping') ? `pong@${new Date().toISOString()}` : `blob@${'x'.repeat(1024)}`;
    const resp = `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
    const out = sock.getOutputStream();
    out.write(javaByteArray2(resp));
    out.flush();
    sock.close();
    acceptCount.value += 1;
    lastActivity.value = new Date().toLocaleTimeString();
    log(`served ${path}`);
  } catch (err) {
    log(`serve 异常: ${String(err)}`);
    try {
      sock.close();
    } catch {
      /* ignore */
    }
  }
}

function javaByteArray(n: number): any {
  const JByteArray = plusAny().android.importClass('java.lang.reflect.Array');
  return JByteArray.newInstance(plusAny().android.importClass('java.lang.Byte').TYPE, n);
}

function javaByteArray2(s: string): any {
  // 字符串 → byte[]（ASCII 域足够，spike 不做二进制块）
  const JString = plusAny().android.importClass('java.lang.String');
  return new JString(s).getBytes('UTF-8');
}

function javaString(buf: any, n: number): string {
  const JString = plusAny().android.importClass('java.lang.String');
  return new JString(buf, 0, n, 'UTF-8');
}

function toggleServer() {
  if (serverOn.value) {
    stopServer();
    return;
  }
  const plus = plusAny();
  if (!plus?.android) {
    log('需要 Android 真机（plus.android）；iOS/H5 无法起 server');
    return;
  }
  try {
    const ServerSocket = plus.android.importClass('java.net.ServerSocket');
    server = new ServerSocket(PORT);
    server.setSoTimeout(250); // accept 轮询间隔同量级，超时即 poll
    serverOn.value = true;
    log(`ServerSocket :${PORT} 已监听（soTimeout=250ms 轮询 accept）`);
    pollTimer = setInterval(pollAccept, 300);
  } catch (err) {
    log(`启动失败: ${String(err)}`);
    server = null;
  }
}

function pollAccept() {
  if (!server || pollBusy) return;
  pollBusy = true;
  try {
    const sock = server.accept();
    log('accepted');
    serveSocket(sock);
  } catch {
    // soTimeout 超时：正常轮询空转
  } finally {
    pollBusy = false;
  }
}

function stopServer() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  try {
    server?.close();
  } catch {
    /* ignore */
  }
  server = null;
  serverOn.value = false;
  log('Server 已停止');
}

clockTimer = setInterval(() => {
  now.value = new Date().toLocaleTimeString();
}, 1000);

onUnmounted(() => {
  stopServer();
  if (cpuLockRef) {
    try {
      cpuLockRef.release();
    } catch {
      /* ignore */
    }
  }
  try {
    plusAny().device.setWakelock(false);
  } catch {
    /* ignore */
  }
});
</script>

<style>
.wrap { padding: 16px; }
.h { font-size: 18px; font-weight: bold; margin-bottom: 12px; }
.h2 { font-size: 15px; font-weight: bold; margin-top: 12px; }
.row { display: flex; flex-direction: row; align-items: center; justify-content: space-between; margin: 8px 0; }
.label { font-size: 14px; }
.btn { margin: 10px 0; }
.hint { font-size: 12px; color: #888; }
.stat { display: flex; flex-direction: column; background: #f5f5f5; border-radius: 8px; padding: 10px; margin-top: 10px; }
.logs { height: 240px; background: #222; border-radius: 8px; padding: 8px; }
.log { color: #9f9; font-size: 11px; }
</style>
