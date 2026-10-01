// @ts-nocheck
/**
 * 正文光标桥（renderjs，只跑在 App 视图层；H5 无 renderjs，逻辑侧保留原生 DOM 路径）。
 *
 * 只做两件事：① 读真实 DOM 光标 → `$ownerInstance.callMethod('onCaret', …)` 上报逻辑层；
 * ② 按逻辑层经 `:prop` / `:change:prop` 下发的指令把文本与光标写回真实节点。
 * 固定边界：不读不写任何业务状态（不碰表单、不碰落库、不碰提交）。
 *
 * 逻辑层契约（两页一致）：
 *   <textarea id="body-caret-anchor" … />
 *   <view :prop="caretCmd" :change:prop="caretBridge.setCaret">…</view>
 *   defineExpose({ onCaret })
 *
 * 为什么不用 document 级 `selectionchange`：旧版 Android WebView 对 `<textarea>` 的光标移动
 * 不触发它（元素级 `selectionchange` 到 Chrome 125 才有）。元素上的 focus / blur / input 已覆盖
 * 「打字」「点标签前失焦」两条必经时序。
 */

/** 正文 textarea 的真实 DOM 节点：id 落在组件根上，内层才是原生 textarea */
function anchor() {
  const root = document.getElementById('body-caret-anchor');
  return root ? root.querySelector('textarea') : null;
}

export default {
  mounted() {
    // 视图层挂载可能早于组件渲染出 textarea，故短轮询直到命中（2 秒内），超时静默放弃
    let tries = 0;
    const bind = () => {
      const el = anchor();
      if (el) {
        const report = () => this.report(el);
        el.addEventListener('focus', report);
        el.addEventListener('blur', report);
        el.addEventListener('input', report);
        return;
      }
      tries += 1;
      if (tries < 40) setTimeout(bind, 50);
    };
    bind();
  },
  methods: {
    /** 读：把真实光标上报逻辑层（写入它的 `caretLedger`） */
    report(el) {
      const owner = this.$ownerInstance;
      if (!owner) return;
      owner.callMethod('onCaret', { start: el.selectionStart, end: el.selectionEnd });
    },
    /** 写：沿用「直写原生节点」以绕开组件 model→DOM 的 100ms 防抖，避免光标被重置到末尾 */
    setCaret(newValue) {
      const el = anchor();
      if (!el || !newValue) return;
      el.focus();
      el.value = newValue.text;
      el.setSelectionRange(newValue.start, newValue.end);
    },
  },
};
