// @ts-nocheck
/**
 * 正文光标桥 v3.2（renderjs，App 视图层；H5 走逻辑层 live DOM 路径，本桥在 H5 无副作用）。
 *
 * 结构回归 0.20.7 线上验证过的形态（v3/v3.1 失效根因）：
 *   ① 外部文件 src 必须写「项目根相对」：src="src/core/caret-bridge.renderjs.js"
 *      （写成 ../../core/ 会被解析到项目外 → 模块不加载 → 一切空转）；
 *   ② :prop/:change:prop 挂在包裹 textarea 的 <view> 上（uni 内置组件不透传 prop）；
 *   ③ 写侧直写 el.value（绕开组件 model→DOM 的 100ms 防抖，光标不被重置到末尾）。
 *
 * 读侧在 0.20.7 三事件（focus/blur/input）之上叠加 v3.1 轮询 + touchend 推送：
 *   - 轮询 200ms：非空选区变化即上报（select 事件在 App 端不可靠，轮询不依赖事件触发）；
 *   - 模块内缓存 lastSel：blur/塌陷不清（点工具栏引发的失焦不能毁掉选区缓存）；
 *   - 全局 touchend（capture）：触点在 textarea 外（工具栏）→ 主动重推缓存（幂等防丢）；
 *     触点在 textarea 内且选区塌陷（用户点正文取消/重新定位）→ 清缓存并清台账。
 * 清台账唯一入口是「用户触碰 textarea」，工具栏路径永不触发。
 *
 * 逻辑层契约（两页一致）：
 *   <view :prop="caretCmd" :change:prop="caretBridge.writeCaret">
 *     <textarea id="body-caret-anchor" … />
 *   </view>
 *   defineExpose({ onSelectionReport })
 */

/** 正文 textarea 的真实 DOM 节点：id 落在组件根上，内层才是原生 textarea */
function anchor() {
  const root = document.getElementById('body-caret-anchor');
  return root ? root.querySelector('textarea') : null;
}

export default {
  mounted() {
    // 视图层挂载可能早于组件渲染出 textarea，短轮询直到命中（2 秒内），超时静默放弃
    let tries = 0;
    let lastKey = '';
    let lastSel = null;
    const bind = () => {
      const el = anchor();
      if (!el) {
        tries += 1;
        if (tries < 40) setTimeout(bind, 50);
        return;
      }
      el.addEventListener('focus', () => this.report(el));
      el.addEventListener('blur', () => this.report(el));
      el.addEventListener('input', () => this.report(el));
      this._poll = setInterval(() => {
        const e = anchor();
        const owner = this.$ownerInstance;
        if (!e || !owner) return;
        const key = e.selectionStart + ':' + e.selectionEnd;
        if (key === lastKey) return;
        lastKey = key;
        if (e.selectionStart !== e.selectionEnd) {
          lastSel = { start: e.selectionStart, end: e.selectionEnd };
          owner.callMethod('onSelectionReport', lastSel);
        }
      }, 200);
      this._onTouch = (ev) => {
        const e = anchor();
        const owner = this.$ownerInstance;
        if (!e || !owner) return;
        const inArea = ev.target === e || e.contains(ev.target);
        if (!inArea && lastSel) {
          owner.callMethod('onSelectionReport', lastSel);
        } else if (inArea && e.selectionStart === e.selectionEnd && lastSel) {
          lastSel = null;
          owner.callMethod('onSelectionReport', null);
        }
      };
      document.addEventListener('touchend', this._onTouch, true);
    };
    bind();
  },
  beforeDestroy() {
    clearInterval(this._poll);
    if (this._onTouch) document.removeEventListener('touchend', this._onTouch, true);
  },
  methods: {
    /** 读：非空选区上报入台账；塌陷不报（清账只归 touchend 的用户触碰判定管） */
    report(el) {
      const owner = this.$ownerInstance;
      if (!owner) return;
      if (el.selectionStart !== el.selectionEnd) {
        owner.callMethod('onSelectionReport', { start: el.selectionStart, end: el.selectionEnd });
      }
    },
    /** 写：直写原生节点绕开 model→DOM 防抖，光标随新文本一次落位 */
    writeCaret(cmd) {
      if (!cmd || typeof cmd.text !== 'string') return;
      const el = anchor();
      if (!el) return;
      el.focus();
      el.value = cmd.text;
      el.setSelectionRange(cmd.start, cmd.end);
    },
  },
};
