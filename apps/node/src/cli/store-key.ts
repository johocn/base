// store-key：L4a′ 静态加密密钥的运维入口（镜像 cmd/based/storekey.go:17-74，stdout 逐字对齐）。
//
//	store-key show —— 只读打印密钥来源与 hex（不创建任何文件）
//	store-key init —— 密钥不存在则生成（serve 首启同样会自动生成）
import type { CliCommand } from "@base/core-ts";
import { openStore, storeKeyStatus } from "../store/store";
import { parseFlags } from "./flags";

const USAGE = "用法: based store-key <show|init> [-data <dir>]";

/** 让「密钥来自环境变量」也有可读输出（对齐 Go `displayPath`）。 */
function displayPath(p: string): string {
  if (p === "") return "(环境变量注入，无文件)";
  return p;
}

export function createStoreKeyCommand(): CliCommand {
  return {
    name: "store-key",
    async run(args: string[]): Promise<number> {
      const sub = args[0];
      // 子命令在前（based store-key show -data x），故先取子命令再解析其余 flag。
      if (sub === undefined || sub.startsWith("-")) throw new Error(USAGE);
      const { values, rest } = parseFlags(args.slice(1), [{ name: "data", def: "data" }]);
      if (rest.length > 0) {
        throw new Error(`未知参数 "${rest[0]}"；${USAGE}`);
      }

      const status = storeKeyStatus(values.data);

      switch (sub) {
        case "show":
          if (!status.exists) {
            throw new Error(
              `密钥不存在（来源 ${displayPath(status.path)}）：先运行 based store-key init`,
            );
          }
          process.stdout.write(`key_path = ${displayPath(status.path)}\n`);
          process.stdout.write(`key_hex  = ${status.hexKey}\n`);
          return 0;

        case "init": {
          if (status.exists) {
            process.stdout.write(`密钥已存在，未改动。\n`);
            process.stdout.write(`key_path = ${displayPath(status.path)}\n`);
            process.stdout.write(`key_hex  = ${status.hexKey}\n`);
            return 0;
          }
          const st = openStore(values.data);
          try {
            process.stdout.write("已生成密钥（离线恢复码，请抄走并离线保存）：\n");
            process.stdout.write(`key_path = ${st.storeKeyPath()}\n`);
            process.stdout.write(`key_hex  = ${st.storeKeyHex()}\n`);
            process.stdout.write("警告：丢失该密钥 = data 目录内内容永久不可读。\n");
            return 0;
          } finally {
            st.close();
          }
        }

        default:
          throw new Error(`未知子命令 "${sub}"；用法: based store-key <show|init>`);
      }
    },
  };
}
