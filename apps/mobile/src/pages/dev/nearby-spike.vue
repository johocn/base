<template>
  <view class="wrap">
    <text class="h">R2 源端保活验证 · build 46 NIO（spike，验证后删除）</text>

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
      <text>本机 IP：{{ localIp }}</text>
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
 * R2 spike：验证 Android 源端在息屏/后台/电池优化下的存活能力（NIO 非阻塞版）。
 *
 * 历史：java.net.ServerSocket 的阻塞 accept() 被 plus bridge 直接吐 null
 *（bridge 不允许阻塞调用；StrictMode permitNetwork 后仍 null，已证伪线程异常论）。
 * 现改用 java.nio.channels.ServerSocketChannel 非阻塞模式：accept() 无连接
 * 立即返回 null、有连接返回 SocketChannel，全程零阻塞，bridge 必然放行。
 * serve 为最小实现：不读请求，连接进来直接回固定 HTTP 响应后关闭。
 *
 * 场景矩阵：S1 亮屏+常亮 / S2 息屏无保活 / S3 息屏+CPU锁+白名单 / S4 切后台。
 * 判定：客户端每 30s GET /ping 连续 5 分钟成功率 ≥95% = PASS。
 */
import { onUnmounted, ref } from 'vue';

const PORT = 8712;

const screenLock = ref(false);
const cpuLock = ref(false);
const batteryOk = ref<boolean | null>(null);
const serverOn = ref(false);
const localIp = ref('查询中…');
const acceptCount = ref(0);
const lastActivity = ref('—');
const now = ref('—');
const logs = ref<string[]>([]);

let ssc: any = null; // java.nio.channels.ServerSocketChannel
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
    const Intent = plus.android.importClass('android.content.Intent');
    const intent = new Intent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
    main.startActivity(intent);
    log('已跳转电池优化设置，请把本应用设为「不优化」后返回');
  } catch (err) {
    log(`白名单检测异常: ${String(err)}`);
  }
}

/** 最小 serve：不读请求，直接回固定 HTTP 响应后关闭（非阻塞 write 一次尝试） */
function serveChannel(ch: any) {
  try {
    const body = `pong@${new Date().toISOString()}`;
    const resp = `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
    const JString = plusAny().android.importClass('java.lang.String');
    const bytes = new JString(resp).getBytes('UTF-8');
    const BB = plusAny().android.importClass('java.nio.ByteBuffer');
    const bb = BB.wrap(bytes);
    ch.write(bb);
    ch.close();
    acceptCount.value += 1;
    lastActivity.value = new Date().toLocaleTimeString();
    log('served /ping');
  } catch (err) {
    log(`serve 异常: ${String(err)}`);
    try {
      ch.close();
    } catch {
      /* ignore */
    }
  }
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
    // bridge 线程网络 I/O 放行（NIO 调用非阻塞，本行是保险，留置无害）
    const Builder = plus.android.importClass('android.os.StrictMode$ThreadPolicy$Builder');
    const policy = new Builder().permitNetwork().build();
    const SM = plus.android.importClass('android.os.StrictMode');
    SM.setThreadPolicy(policy);
    // NIO 非阻塞通道：accept() 无连接立即返回 null，有连接返回 SocketChannel
    plus.android.importClass('java.nio.channels.SocketChannel');
    plus.android.importClass('java.nio.ByteBuffer');
    const ISA = plus.android.importClass('java.net.InetSocketAddress');
    const SCh = plus.android.importClass('java.nio.channels.ServerSocketChannel');
    ssc = SCh.open();
    ssc.configureBlocking(false);
    ssc.bind(new ISA(PORT));
    serverOn.value = true;
    log(`ServerSocketChannel :${PORT} 已监听（NIO 非阻塞）`);
    pollTimer = setInterval(pollAccept, 200);
  } catch (err) {
    log(`启动失败: ${String(err)}`);
    ssc = null;
  }
}

function pollAccept() {
  if (!ssc || pollBusy) return;
  pollBusy = true;
  try {
    const ch = ssc.accept();
    if (!ch) return; // 非阻塞空转（Java 语义），静默
    log('accepted');
    serveChannel(ch);
  } catch (err) {
    log(`accept 异常: ${String(err)}`);
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
    ssc?.close();
  } catch {
    /* ignore */
  }
  ssc = null;
  serverOn.value = false;
  log('Server 已停止');
}

clockTimer = setInterval(() => {
  now.value = new Date().toLocaleTimeString();
}, 1000);

try {
  const ip = plusAny().networkinfo.getCurrentIPAddress();
  localIp.value = ip || '未获取到（检查 Wi-Fi/热点）';
} catch {
  localIp.value = 'plus.networkinfo 不可用';
}

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
