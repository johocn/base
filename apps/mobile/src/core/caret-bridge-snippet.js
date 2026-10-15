// @ts-nocheck
/**
 * 光标桥 v3.4 内联代码（三页 <script module="caretBridge" lang="renderjs"> 的共享源）。
 * 官方文档定案：renderjs「目前仅支持内联使用」——外部 src 在 App 端不加载（v3/v3.1/v3.2 失效根因）；
 * callMethod 仅支持逻辑层「选项式 methods」——回调挂各页的普通 <script> Options 块。
 * 构建时把本文件内容贴入各页的内联 script 块（多页同构拷贝，册子既定口径）。
 *
 * 结构要点（0.20.7 H5 验证 + 官方文档）：
 * - :prop/:change:prop 挂在包裹 textarea 的 <view> 上（uni 内置组件不透传 prop）；
 * - 写侧直写 el.value（绕开组件 model→DOM 的 100ms 防抖，光标不被重置到末尾）；
 * - 读侧 = 三事件（focus/blur/input）+ 200ms 轮询 + touchend 分向推送；
 *   blur/塌陷不清缓存（点工具栏引发的失焦不能毁掉选区），清账唯一入口是用户触碰 textarea。
 * - v3.4：塌陷单点也上报（touchend 区内 / 轮询位移 / 三事件）——点空白处移动光标
 *   不触发 @input，塌陷位不保鲜会让工具动作插到陈旧位置（0.21.5 真机缺陷）。
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
        } else {
          // v3.4：塌陷位移也上报（方向键/程序置位等不触发 touch 的路径），caretLedger 才能保鲜
          owner.callMethod('onSelectionReport', { start: e.selectionStart, end: e.selectionEnd });
        }
      }, 200);
      this._onTouch = (ev) => {
        const e = anchor();
        const owner = this.$ownerInstance;
        if (!e || !owner) return;
        const inArea = ev.target === e || e.contains(ev.target);
        if (!inArea) {
          // 区外触碰（含点工具栏）：补报最近一次非空选区，不毁台账（v3.3 既定口径）
          if (lastSel) owner.callMethod('onSelectionReport', lastSel);
          return;
        }
        // v3.4：区内触碰一律上报当前位置——塌陷单点入 caretLedger（修「空白处插入落错位」），
        // 非空选区入 selLedger；lastSel 按塌陷与否维护
        const sel = { start: e.selectionStart, end: e.selectionEnd };
        lastSel = sel.start !== sel.end ? sel : null;
        owner.callMethod('onSelectionReport', sel);
      };
      document.addEventListener('touchend', this._onTouch, true);
    };
    bind();
  },
  methods: {
    /** 读：上报当前位置（v3.4 起塌陷也报——blur 时最后一次光标位是工具动作的重要台账来源） */
    report(el) {
      const owner = this.$ownerInstance;
      if (!owner) return;
      owner.callMethod('onSelectionReport', { start: el.selectionStart, end: el.selectionEnd });
    },
    /** 写：直写原生节点绕开 model→DOM 防抖；首写经 onBridgeProbe 探测上报（验证 observer 触发链路），
     * 150/400/800ms 三次钉位（blur 态 focus 后 uni 值回写可能晚于 150ms 再重置光标）；
     * 条件=「值串仍等于命令文本且光标未落位」——用户已继续输入（值变化）则不抢光标 */
    writeCaret(cmd) {
      if (!cmd || typeof cmd.text !== 'string') return;
      const el = anchor();
      if (!el) return;
      const owner = this.$ownerInstance;
      if (owner && !this._writeProbed) {
        this._writeProbed = true;
        owner.callMethod('onBridgeProbe', { writeCalled: true, start: cmd.start, end: cmd.end, textLen: cmd.text.length });
      }
      el.focus();
      el.value = cmd.text;
      el.setSelectionRange(cmd.start, cmd.end);
      [150, 400, 800].forEach((delay) => {
        setTimeout(() => {
          const e = anchor();
          if (!e || e.value !== cmd.text) return;
          if (e.selectionStart !== cmd.start || e.selectionEnd !== cmd.end) e.setSelectionRange(cmd.start, cmd.end);
        }, delay);
      });
    },
  },
};
