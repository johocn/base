// import-md：把目录下的 markdown 导入内容库（镜像 cmd/based/import.go + internal/importer/md.go）。
// 纯解析/派生在 `@base/core-ts` 的 importer 模块；Run 编排在 `../importer/run`；本文件只解析 flag、写库与打印。
import type { CliCommand } from "@base/core-ts";
import { runImport } from "../importer/run";
import { openStore } from "../store/store";
import { parseFlags } from "./flags";

export function createImportMdCommand(): CliCommand {
  return {
    name: "import-md",
    async run(args: string[]): Promise<number> {
      const { values, rest } = parseFlags(args, [
        { name: "dir", def: "seed" },
        { name: "data", def: "data" },
        { name: "retire-legacy", def: "false", bool: true },
      ]);
      if (rest.length > 0) throw new Error(`未知参数 "${rest[0]}"`);

      const store = openStore(values.data);
      try {
        // runImport 抛错即整批失败（如分类硬校验），此时不打印任何 stdout、不写任何库。
        const res = runImport(store, values.dir, { retireLegacy: values["retire-legacy"] === "true" });
        process.stdout.write(`import-md: 导入 ${res.imported} 篇，失败 ${res.failed} 篇\n`);
        for (const e of res.errors) process.stdout.write("  ! " + e + "\n");
        if (res.failed > 0) throw new Error(`import-md: ${res.failed} 篇失败`);
        return 0;
      } finally {
        store.close();
      }
    },
  };
}