// @ts-nocheck
/**
 * 正文光标桥（renderjs，只跑在 App 视图层；H5 无 renderjs）。
 * 职责收窄（册子 #82 §4.1）：只上报**非空选区** `{start, end}` 到逻辑层 `onCaret`；
 * 单点光标由逻辑层 textarea 的 @input/@blur `e.detail.cursor` 直接补记（组件层同步事件，
 * 不经 renderjs 跨层——跨层延迟正是旧版「插入漂到上方几行」的根因）。
 * 写光标已改走逻辑层 `:selection-start/:selection-end` 属性，本桥不再有写路径。
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
    /** 读：仅非空选区上报（选区语义）；单点交给逻辑层 @input/@blur，杜绝滞后覆盖 */
    report(el) {
      if (el.selectionStart === el.selectionEnd) return;
      const owner = this.$ownerInstance;
      if (!owner) return;
      owner.callMethod('onCaret', { start: el.selectionStart, end: el.selectionEnd });
    },
  },
};
