// 逐行移植 cmd/based/scrub.go（runScrub）：手动触发一次 scrub（契约 §8，只修本地）。
//
// 与 Go 的**有意差异**：TlsAdapter 由本文件内部构造（Go 侧是包级函数 LoadOrCreateTLSCert）。
import type { CliCommand } from "@base/core-ts";
import { createTlsAdapter } from "../host/tls";
import { scrubOnce } from "../peersync/scrub";
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

export function createScrubCommand(): CliCommand {
  return {
    name: "scrub",
    async run(args: string[]): Promise<number> {
      const { values, rest } = parseFlags(args, [...peerFlagSpecs(), { name: "blob", def: "" }]);
      if (rest.length > 0) throw new Error(`未知参数 "${rest[0]}"`);

      const f = peerFlagsFromValues(values);
      const peers = peersFromRaw(f.peers);
      const info = await tlsInfo(f, createTlsAdapter());
      const cfg = config(f, info);
      const st = openStore(f);
      try {
        const blob = values["blob"] ?? "";
        const only = blob !== "" ? [blob] : [];
        const res = await scrubOnce(cfg, undefined, st, peers, only);
        logf(`based: ${res.String()}`);
        for (const id of res.unrepaired) {
          logf(`based: **告警** 块 ${id} 所有已知 peer 都拿不到，保留在未修复列表`);
        }
        return 0;
      } finally {
        st.close();
      }
    },
  };
}