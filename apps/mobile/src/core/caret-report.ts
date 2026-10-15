import { ref } from 'vue';

/**
 * 光标桥跨块共享状态（script setup 与 Options methods 两个 script 块共用同一实例）：
 * - selLedger：App 选区台账（renderjs 视图层上报，非空选区入账 / 塌陷清账）
 * - caretLedger：单点光标台账（v3.4 起三来源：组件层 @input/@blur detail.cursor、
 *   桥的塌陷上报（touchend/poll/report）、工具动作后的目标光标）——点空白处移动
 *   光标不触发 @input，靠桥的塌陷上报保鲜，否则工具动作会用陈旧位置插入
 * - probeInfo：renderjs 环境探测结果（诊断用，真机显示后可移除）
 */
export const selLedger = ref<{ start: number; end: number } | null>(null);
export const caretLedger = ref<{ start: number; end: number } | null>(null);
export const probeInfo = ref('');
