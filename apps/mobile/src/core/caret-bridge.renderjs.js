// @ts-nocheck
/**
 * 正文光标桥 v3（renderjs，App 视图层；H5 走逻辑层 live DOM 路径，本桥在 H5 无副作用）。
 * 真机定案（0.20.9）：官方 API 两条路线都失效——
 *   ① uni.getSelectedTextRange 点工具栏时返回折叠点（系统菜单/失焦清选区）→ 读走本桥 DOM 选区上报；
 *   ② :selection-start + focus 翻转不落位 → 写走本桥 DOM setSelectionRange（len 门控 + rAF 重试）。
 * 读：非空选区在 select/touchend/focus/blur/input 时刻上报 onSelectionReport；
 *    touchend 无论塌陷都报（点正文取消选区 → 清台账；点工具栏不在 textarea 上 → 台账保留）。
 * 写：命令 {seq,start,end,len} 由逻辑层变换后发出；等 DOM value 长度===len（v-model flush 完成）
 *    才 focus + setSelectionRange，rAF 重试 20 拍防时序竞争。
 */

function anchor() {
  const root = document.getElementById('body-caret-anchor');
  return root ? root.querySelector('textarea') : null;
}

export default {
  mounted() {
    let tries = 0;
    const bind = () => {
      const el = anchor();
      if (el) {
        const owner = this.$ownerInstance;
        const report = (keepCollapse) => {
          if (!owner) return;
          if (el.selectionStart !== el.selectionEnd) {
            owner.callMethod('onSelectionReport', { start: el.selectionStart, end: el.selectionEnd });
          } else if (keepCollapse) {
            owner.callMethod('onSelectionReport', null);
          }
        };
        el.addEventListener('select', () => report(false));
        el.addEventListener('input', () => report(false));
        el.addEventListener('focus', () => report(false));
        el.addEventListener('blur', () => report(false));
        el.addEventListener('touchend', () => report(true));
      } else if (tries++ < 40) {
        setTimeout(bind, 50);
      }
    };
    bind();
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
