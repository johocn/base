// 逐行移植 cmd/based/peersync.go（runPeerSync）：手动触发一轮出站反熵。
//
// 与 Go 的**有意差异**：TlsAdapter 由本文件内部构造（Go 侧是包级函数 LoadOrCreateTLSCert）；
// 命令本身不接收适配器参数（对齐任务给定的 `createPeerSyncCommand()` 签名）。
import type { CliCommand } from "@base/core-ts";
import { createTlsAdapter } from "../host/tls";
import { runOnce } from "../peersync/sync";
import { parseFlags } from "./flags";
import {
  config,
  logf,
  openStore,
  peerFlagSpecs,
  peerFlagsFromValues,
  peersFromRaw,
  tlsInfo,
} from "./peerconfig";

export function createPeerSyncCommand(): CliCommand {
  return {
    name: "peer-sync",
    async run(args: string[]): Promise<number> {
      const { values, rest } = parseFlags(args, peerFlagSpecs());
      if (rest.length > 0) throw new Error(`未知参数 "${rest[0]}"`);

      const f = peerFlagsFromValues(values);
      const peers = peersFromRaw(f.peers);
      if (peers.length === 0) {
        throw new Error("peer-sync: 需要至少一个对端（-peers 或 BASE_PEERS）");
      }
      const info = await tlsInfo(f, createTlsAdapter());
      const cfg = config(f, info);
      const st = openStore(f);
      try {
        // Go 传 context.Background() → Node 传 undefined。
        const results = await runOnce(cfg, undefined, st, peers, logf);
        if (results.length === 0) {
          throw new Error(`peer-sync: ${peers.length} 个对端全部失败`);
        }
        for (const r of results) process.stdout.write(r.String() + "\n");
        return 0;
      } finally {
        st.close();
      }
    },
  };
}