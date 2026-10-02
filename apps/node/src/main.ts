// 节点壳入口：装配真实 ServerAdapters + 注册 CLI 子命令。
import { pathToFileURL } from "node:url";
import type { CliCommand, ServerAdapters } from "@base/core-ts";
import { VERSION } from "./version";
import { openDb } from "./db";
import { createHttpServerAdapter } from "./host/http";
import { createTlsAdapter } from "./host/tls";
import { createSchedulerAdapter } from "./host/scheduler";
import { createCliHost } from "./host/cli";
import { createLifecycleAdapter } from "./host/lifecycle";
import { startServer } from "./serve";

function parseAddr(addr: string): { host: string; port: number } {
  const trimmed = addr.trim();
  const i = trimmed.lastIndexOf(":");
  if (i < 0) return { host: "", port: Number.parseInt(trimmed, 10) };
  return { host: trimmed.slice(0, i), port: Number.parseInt(trimmed.slice(i + 1), 10) };
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
      const db = openDb(process.env.BASE_DB ?? "base.db");
      const listener = await startServer(adapters, db, parseAddr(process.env.BASE_ADDR ?? ":8080"));
      process.stdout.write(`listening ${listener.addr()}\n`);
      // 服务由信号驱动关停（lifecycle），此处不返回，保持进程存活。
      await new Promise<void>(() => {});
      return 0;
    },
  };

  adapters.cli.register(versionCmd);
  adapters.cli.register(serveCmd);

  const code = await adapters.cli.run(process.argv.slice(2));
  adapters.lifecycle.exit(code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
