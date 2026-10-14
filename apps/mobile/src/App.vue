<script setup lang="ts">
import { onLaunch } from '@dcloudio/uni-app';

import { decideUpdate, fetchReleaseDoc, promptUpdate } from './core/update';
import { bootstrap } from './platform';
import { plusRuntime } from './platform/uni';

onLaunch(() => {
  console.log('base mobile launched');

  // 启动即静默检查一次升级；红线：任何失败都不阻断启动（spec §8.4）
  void (async () => {
    try {
      const localVersion = String(plusRuntime()?.runtime?.version ?? '0.0.0');
      const { repo, opts } = await bootstrap();
      if (!opts.nodeBaseUrl) return;
      const pubHex = await repo.getConfig('pubkey_hex');
      if (!pubHex) return;
      const doc = await fetchReleaseDoc(opts.adapters.http, opts.nodeBaseUrl, pubHex);
      if (!doc) return;
      const decision = decideUpdate(localVersion, doc.payload);
      if (decision !== 'optional' && decision !== 'forced') return;
      promptUpdate(doc, decision);
    } catch {
      // 静默：升级通道任何失败都不影响正常使用
    }
  })();
});
</script>

<style>
/* 适老化固定字阶（册子 #84 §3.1）：全部页面 font-size 一律引用变量，禁止新写死字号 */
:root {
  --fs-annotate: 15px;
  --fs-body: 19px;
  --fs-title: 24px;
}
page {
  background: #ffffff;
  color: #1a1a1a;
  font-size: var(--fs-body);
  line-height: 1.6;
}
.fs-annotate { font-size: var(--fs-annotate); }
.fs-body { font-size: var(--fs-body); }
.fs-title { font-size: var(--fs-title); }
</style>