// 节点壳入口：装配真实 ServerAdapters + 注册 CLI 子命令。
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import type { CliCommand, ServerAdapters, TlsMaterial } from "@base/core-ts";
import { VERSION } from "./version";
import { createHttpServerAdapter } from "./host/http";
import { createTlsAdapter } from "./host/tls";
import { createSchedulerAdapter } from "./host/scheduler";
import { createCliHost } from "./host/cli";
import { createLifecycleAdapter } from "./host/lifecycle";
import { openHostDb } from "./host/sqlite";
import { loadStoreKey } from "./host/storekey";
import { openSyncStore } from "./store/syncstore";
import { openBootstrapDb } from "./store/store";
import { createTlsCertCommand } from "./cli/tls-cert";
import { createExportCommand } from "./cli/export";
import { createImportMdCommand } from "./cli/import-md";
import { createImportVideoCommand } from "./cli/import-video";
import { createReleaseCommand } from "./cli/release";
import { createPubkeyCommand } from "./cli/pubkey";
import { createStoreKeyCommand } from "./cli/store-key";
import { createPeerSyncCommand } from "./cli/peer-sync";
import { createScrubCommand } from "./cli/scrub";
import { envIntOr, logf, parseGoDuration, peersFromRaw } from "./cli/peerconfig";
import { parseIssuerPubKeys, type Config } from "./peersync/peer";
import { formatGoDuration, runForever } from "./peersync/sync";
import { scrubForever } from "./peersync/scrub";
import { startPeerServer, startServer, type ServerOptions } from "./serve";

function parseAddr(addr: string): { host: string; port: number } {
  const trimmed = addr.trim();
  const i = trimmed.lastIndexOf(":");
  if (i < 0) return { host: "", port: Number.parseInt(trimmed, 10) };
  return { host: trimmed.slice(0, i), port: Number.parseInt(trimmed.slice(i + 1), 10) };
}

/** 证书/私钥路径决策（对齐 serve.go:61-76 的 plaintext/peerAddr 两条路径）。 */
function resolveTlsMaterial(tlsCertRaw: string, tlsKeyRaw: string, dataDir: string): TlsMaterial {
  const defCert = join(dataDir, "tls", "node.crt");
  const defKey = join(dataDir, "tls", "node.key");
  if (tlsCertRaw.trim().toLowerCase() === "off") {
    // off = 主监听明文，**不是**本节点没有身份：对端监听仍落回默认证书路径。
    return { certFile: defCert, keyFile: defKey };
  }
  return {
    certFile: tlsCertRaw.trim() || defCert,
    keyFile: tlsKeyRaw.trim() || defKey,
  };
}

/** 调度间隔解析（对齐 peerconfig.go:118-128 的错误前缀）。 */
function parseInterval(raw: string, flag: string): number {
  try {
    return parseGoDuration(raw.trim());
  } catch (err) {
    throw new Error(`${flag} 解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function main(): Promise<void> {
  const adapters: ServerAdapters = {
    http: createHttpServerAdapter(),
    tls: createTlsAdapter(),
    scheduler: createSchedulerAdapter(),
    cli: createCliHost(),
    lifecycle: createLifecycleAdapter(),
  };

  const versionCmd: CliCommand = {
    name: "version",
    async run(): Promise<number> {
      process.stdout.write(`based ${VERSION}\n`);
      return 0;
    },
  };

  const serveCmd: CliCommand = {
    name: "serve",
    async run(): Promise<number> {
      const dbPath = process.env.BASE_DB ?? "base.db";
      // 对齐 serve.go:43-46：env 读取与默认值保持不变。
      const dataDir = process.env.BASE_DATA ?? dirname(dbPath);
      const opts: ServerOptions = {
        ...parseAddr(process.env.BASE_ADDR ?? ":8080"),
        dataDir,
        issuer: process.env.BASE_ISSUER || "base-node-1",
        signKeyHex: process.env.BASE_SIGN_KEY ?? "",
      };

      const db = openBootstrapDb(dbPath);
      const listener = await startServer(adapters, db, opts);
      process.stdout.write(`listening ${listener.addr()}\n`);

      const peers = peersFromRaw(process.env.BASE_PEERS ?? "");
      const peerAddr = process.env.BASE_PEER_ADDR ?? "";
      const nodeKey = (process.env.BASE_NODE_KEY ?? "").trim();
      const tlsCert = process.env.BASE_TLS_CERT ?? "";
      const tlsKey = process.env.BASE_TLS_KEY ?? "";
      const fetchMaxBlobs = envIntOr("BASE_FETCH_MAX_BLOBS", 64);
      // 本节点 TLS 身份：主监听明文（tls-cert=off）时也按默认证书路径加载（出站/对端监听需要）。
      const info =
        peerAddr !== "" || peers.length > 0
          ? await adapters.tls.loadOrCreate(resolveTlsMaterial(tlsCert, tlsKey, dataDir))
          : undefined;

      // 对端监听（公开路由 ∪ 内部路由）：只有配置 -peer-addr 才起。
      if (peerAddr !== "") {
        if (peers.length === 0) {
          throw new Error(
            "启用 -peer-addr 必须同时配置 -peers：没有对端指纹白名单就无法固定对端身份",
          );
        }
        const peerFPs = peers.filter((p) => p.tlsFingerprint !== "").map((p) => p.tlsFingerprint);
        const peerTLS = adapters.tls.serverConfig(info as NonNullable<typeof info>, peerFPs);
        const peerDb = openHostDb(dbPath); // 同文件第二个连接，WAL 下安全
        await startPeerServer(
          adapters,
          db,
          { ...opts, ...parseAddr(peerAddr), tls: peerTLS },
          { db: peerDb, dataDir, storeKey: loadStoreKey(dataDir, {}).key, fetchMaxBlobs },
          nodeKey,
        );
        logf(`based 对端接口监听 ${peerAddr}（双向 TLS + 指纹固定，白名单 ${peerFPs.length} 个）`);
        adapters.lifecycle.onShutdown(async () => {
          peerDb.close();
        });
      }

      // 反熵 / scrub 调度：只有配置了 -peers 才启动（册子 §7.1）。
      if (peers.length > 0) {
        const syncMs = parseInterval(process.env.BASE_SYNC_INTERVAL ?? "5m", "-sync-interval");
        const scrubMs = parseInterval(process.env.BASE_SCRUB_INTERVAL ?? "24h", "-scrub-interval");
        const cfg: Config = {
          ownTls: info as NonNullable<typeof info>,
          nodeKey,
          issuerPubKeys: parseIssuerPubKeys(process.env.BASE_ISSUER_PUBKEYS ?? ""),
          fetchMaxBlobs,
        };
        const st = openSyncStore(dataDir);
        const ctrl = new AbortController();
        adapters.lifecycle.onShutdown(async () => {
          ctrl.abort();
        });
        adapters.lifecycle.onShutdown(async () => {
          st.close();
        });
        runForever(cfg, ctrl.signal, st, peers, syncMs, logf);
        logf(`based: 反熵调度已启动（${peers.length} 个对端，间隔 ${formatGoDuration(syncMs)}）`);
        scrubForever(cfg, ctrl.signal, st, peers, scrubMs, logf);
        logf(`based: scrub 调度已启动（间隔 ${formatGoDuration(scrubMs)}，首轮延迟 10 分钟）`);
      }

      // 服务由信号驱动关停（lifecycle），此处不返回，保持进程存活。
      await new Promise<void>(() => {});
      return 0;
    },
  };

  adapters.cli.register(versionCmd);
  adapters.cli.register(serveCmd);
  adapters.cli.register(createTlsCertCommand(adapters.tls));
  adapters.cli.register(createImportMdCommand());
  adapters.cli.register(createImportVideoCommand());
  adapters.cli.register(createExportCommand());
  adapters.cli.register(createReleaseCommand());
  adapters.cli.register(createPubkeyCommand());
  adapters.cli.register(createStoreKeyCommand());
  adapters.cli.register(createPeerSyncCommand());
  adapters.cli.register(createScrubCommand());

  const code = await adapters.cli.run(process.argv.slice(2));
  adapters.lifecycle.exit(code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
