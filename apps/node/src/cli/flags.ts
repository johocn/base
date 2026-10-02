// 极简 flag 解析：对齐 Go flag 包的常用形状（`-name value` / `-name=value` / `--name`）。
// 仅服务于本节点壳的 CLI 子命令，不做 usage 打印（由 CliHost 统一输出 error: 前缀）。

export interface FlagSpec {
  name: string;
  /** 缺省值；布尔型用 "false"。 */
  def: string;
  /** 布尔型：出现即置 "true"，不吞下一个参数。 */
  bool?: boolean;
}

export interface ParsedFlags {
  values: Record<string, string>;
  /** 非 flag 的位置参数。 */
  rest: string[];
}

export function parseFlags(args: string[], specs: FlagSpec[]): ParsedFlags {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const values: Record<string, string> = {};
  for (const s of specs) values[s.name] = s.def;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-") || arg === "-" || arg === "--") {
      rest.push(arg);
      continue;
    }
    const stripped = arg.replace(/^--?/, "");
    const eq = stripped.indexOf("=");
    const name = eq < 0 ? stripped : stripped.slice(0, eq);
    const spec = byName.get(name);
    if (spec === undefined) throw new Error(`未知参数 -${name}`);
    if (eq >= 0) {
      values[name] = stripped.slice(eq + 1);
      continue;
    }
    if (spec.bool) {
      values[name] = "true";
      continue;
    }
    const next = args[i + 1];
    if (next === undefined) throw new Error(`参数 -${name} 缺少值`);
    values[name] = next;
    i++;
  }
  return { values, rest };
}
