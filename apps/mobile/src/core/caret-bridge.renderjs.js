// @ts-nocheck
/**
 * 正文光标桥 v3.1（renderjs，App 视图层；H5 走逻辑层 live DOM 路径，本桥在 H5 无副作用）。
 * 真机定案（0.20.10）：v3 的 select/touchend 事件路线失效——uni-textarea 内部真 textarea
 * 的 select/touchend 在 App 端不可靠。v3.1 读侧改为「轮询 + 主动推送」，不依赖任何事件触发：
 *   - 轮询 200ms 读 DOM selectionStart/End（变化即上报），选区形成后 200ms 内必入台账；
 *   - 模块内缓存 lastSel（DOM 塌陷/blur 不影响缓存）；
 *   - 全局 touchend（capture）：触点在 textarea 外（点工具栏）→ 主动重推 lastSel（幂等防丢）；
 *     触点在 textarea 内且选区塌陷（用户点正文取消/重新定位）→ 清缓存并清台账。
 * 写侧（0.20.10 结构保留）：逻辑层命令 {seq,start,end,len} → 等 DOM value 长度===len
 * （v-model flush 完成）才 focus + setSelectionRange，rAF 重试 20 拍防时序竞争。
 */

function anchor() {
  const root = document.getElementById('body-caret-anchor');
  return root ? root.querySelector('textarea') : null;
}

export default {
  mounted() {
    let lastKey = '';
    let lastSel = null;
    this._poll = setInterval(() => {
      const el = anchor();
      const owner = this.$ownerInstance;
      if (!el || !owner) return;
      const key = el.selectionStart + ':' + el.selectionEnd;
      if (key === lastKey) return;
      lastKey = key;
      if (el.selectionStart !== el.selectionEnd) {
        lastSel = { start: el.selectionStart, end: el.selectionEnd };
        owner.callMethod('onSelectionReport', lastSel);
      }
    }, 200);
    this._onTouch = (e) => {
      const el = anchor();
      const owner = this.$ownerInstance;
      if (!el || !owner) return;
      const inArea = e.target === el || el.contains(e.target);
      if (!inArea && lastSel) {
        owner.callMethod('onSelectionReport', lastSel);
      } else if (inArea && el.selectionStart === el.selectionEnd && lastSel) {
        lastSel = null;
        owner.callMethod('onSelectionReport', null);
      }
    };
    document.addEventListener('touchend', this._onTouch, true);
  },
  beforeDestroy() {
    clearInterval(this._poll);
    if (this._onTouch) document.removeEventListener('touchend', this._onTouch, true);
  },
  methods: {
    /** 写命令入口（:change:prop 触发）：等新正文渲染进 DOM 再写光标 */
    writeCaret(cmd) {
      if (!cmd || typeof cmd.len !== 'number' || cmd.start < 0) return;
      let tries = 0;
      const attempt = () => {
        const el = anchor();
        if (el && el.value.length === cmd.len) {
          el.focus();
          el.setSelectionRange(cmd.start, cmd.end);
          return;
        }
        if (tries++ < 20) requestAnimationFrame(attempt);
      };
      attempt();
    },
  },
};
