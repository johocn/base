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
page {
  background: #ffffff;
  color: #1a1a1a;
  font-size: 16px;
}
</style>