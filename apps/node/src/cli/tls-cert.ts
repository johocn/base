// tls-cert：管理节点自签证书（镜像 cmd/based/tlscert.go，契约 6.1 / 6.2）。
//
//	tls-cert init   —— 不存在则生成；已存在则报错（避免误换指纹）
//	tls-cert show   —— 打印证书路径、完整指纹 hex、配对码
//	tls-cert rotate —— 备份旧证书后生成新证书（所有客户端需重新配对）
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { CliCommand, TlsAdapter } from "@base/core-ts";
import { parseFlags } from "./flags";

const USAGE = "用法: based tls-cert <init|show|rotate> [-data <dir>]";

/** 对齐 Go `time.Now().Format("20060102T150405")`（本地时间）。 */
function backupStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`;
}

export function createTlsCertCommand(tls: TlsAdapter): CliCommand {
  return {
    name: "tls-cert",
    async run(args: string[]): Promise<number> {
      const sub = args[0];
      // 子命令在前（based tls-cert show -data x），故先取子命令再解析其余 flag。
      if (sub === undefined || sub.startsWith("-")) throw new Error(USAGE);
      const { values, rest } = parseFlags(args.slice(1), [
        { name: "data", def: "data" },
        { name: "cert", def: "" },
        { name: "key", def: "" },
      ]);
      if (rest.length > 0) throw new Error(`未知参数 "${rest[0]}"；${USAGE}`);

      const dataDir = values.data;
      const certPath = values.cert === "" ? join(dataDir, "tls", "node.crt") : values.cert;
      const keyPath = values.key === "" ? join(dataDir, "tls", "node.key") : values.key;

      switch (sub) {
        case "init":
          if (existsSync(certPath)) {
            throw new Error(`证书已存在：${certPath}；如需换新请用 tls-cert rotate`);
          }
          break;
        case "show":
          if (!existsSync(certPath)) {
            throw new Error(`证书不存在：${certPath}；先运行 based tls-cert init`);
          }
          break;
        case "rotate": {
          const stamp = backupStamp(new Date());
          for (const p of [certPath, keyPath]) {
            if (!existsSync(p)) continue;
            const bak = `${p}.${stamp}.bak`;
            renameSync(p, bak);
            process.stdout.write(`已备份 ${p} → ${bak}\n`);
          }
          break;
        }
        default:
          throw new Error(`未知子命令 "${sub}"；用法: based tls-cert <init|show|rotate>`);
      }

      const info = await tls.loadOrCreate({ certFile: certPath, keyFile: keyPath });
      process.stdout.write(`cert         = ${info.certFile}\n`);
      process.stdout.write(`key          = ${info.keyFile}\n`);
      process.stdout.write(`fingerprint  = ${info.fingerprintHex}\n`);
      process.stdout.write(`pairing_code = ${info.pairingCode}\n`);
      if (sub === "rotate") {
        process.stdout.write("注意：指纹已变，所有客户端需删除旧记录并重新配对（契约 6.2，不提供忽略开关）。\n");
      }
      return 0;
    },
  };
}
