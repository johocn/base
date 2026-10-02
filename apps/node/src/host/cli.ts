// CliAdapter：镜像 cmd/based/main.go 的分发（无命令/未知命令 → usage + exit 2）。
import type { CliCommand, CliHost } from "@base/core-ts";

const USAGE = "usage: based <version|...> [flags]";

export function createCliHost(): CliHost {
  const commands = new Map<string, CliCommand>();
  return {
    register(cmd: CliCommand): void {
      commands.set(cmd.name, cmd);
    },
    async run(argv: string[]): Promise<number> {
      const name = argv[0];
      const cmd = name === undefined ? undefined : commands.get(name);
      if (cmd === undefined) {
        process.stderr.write(`${USAGE}\n`);
        return 2;
      }
      try {
        return await cmd.run(argv.slice(1));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`error: ${msg}\n`);
        return 1;
      }
    },
  };
}
