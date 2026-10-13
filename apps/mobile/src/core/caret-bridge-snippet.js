// @ts-nocheck
/**
 * 光标桥 v3.3 内联代码（两页 <script module="caretBridge" lang="renderjs"> 的共享源）。
 * 官方文档定案：renderjs「目前仅支持内联使用」——外部 src 在 App 端不加载（v3/v3.1/v3.2 失效根因）；
 * callMethod 仅支持逻辑层「选项式 methods」——回调挂两页的普通 <script> Options 块。
 * 构建时把本文件内容贴入两页的内联 script 块（两页同构拷贝，册子既定口径）。
 *
 * 结构要点（0.20.7 H5 验证 + 官方文档）：
 * - :prop/:change:prop 挂在包裹 textarea 的 <view> 上（uni 内置组件不透传 prop）；
 * - 写侧直写 el.value（绕开组件 model→DOM 的 100ms 防抖，光标不被重置到末尾）；
 * - 读侧 = 三事件（focus/blur/input）+ 200ms 轮询 + touchend 分向推送；
 *   blur/塌陷不清缓存（点工具栏引发的失焦不能毁掉选区），清账唯一入口是用户触碰 textarea。
 * - mounted 里一次性环境探测（onBridgeProbe 上报）：真机定案 DOM 可达性，修复后可移除。
 */

function anchor() {
  const root = document.getElementById('body-caret-anchor');
  return root ? root.querySelector('textarea') : null;
}

export default {
  mounted() {
    const probe = () => {
      try {
        const root = document.getElementById('body-caret-anchor');
        const el = root ? root.querySelector('textarea') : null;
        const info = {
          rootFound: !!root,
          rootTag: root ? root.tagName : '',
          elFound: !!el,
          elTag: el ? el.tagName : '',
          valueLen: el ? el.value.length : -1,
          selType: el ? typeof el.selectionStart : 'none',
        };
        const owner = this.$ownerInstance;
        if (owner) owner.callMethod('onBridgeProbe', info);
      } catch (e) {
        const owner = this.$ownerInstance;
        if (owner) owner.callMethod('onBridgeProbe', { probeError: String(e) });
      }
    };
    // 视图层挂载可能早于组件渲染出 textarea：命中或 2 秒超时后各探测一次
    let tries = 0;
    let lastKey = '';
    let lastSel = null;
    const bind = () => {
      const el = anchor();
      if (!el) {
        tries += 1;
        if (tries < 40) {
          setTimeout(bind, 50);
        } else {
          probe();
        }
        return;
      }
      probe();
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
