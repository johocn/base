import { ref } from 'vue';

/**
 * 光标桥跨块共享状态（script setup 与 Options methods 两个 script 块共用同一实例）：
 * - selLedger：App 选区台账（renderjs 视图层上报，非空选区入账 / touchend 塌陷清账）
 * - probeInfo：renderjs 环境探测结果（诊断用，真机显示后可移除）
 */
export const selLedger = ref<{ start: number; end: number } | null>(null);
export const probeInfo = ref('');
