/**
 * front-matter 的**纯解析**：逐字对齐 `internal/importer/md.go` 的
 * `SplitFrontMatter` / `firstLine`。不做任何 IO，不引宿主依赖。
 */

export interface FrontMatter {
  /** `key: value`（键与值均已 trim，值再 trim 掉首尾引号）。 */
  meta: Record<string, string>;
  /** 闭合 `---` 之后的剩余正文；**未**做首尾裁剪。 */
  body: string;
}

/** 拆出 front-matter 与剩余正文；正文未做首尾裁剪。 */
export function splitFrontMatter(raw: string): FrontMatter {
  const text = raw.replace(/\r\n/g, "\n");
  const meta: Record<string, string> = {};
  let body = text;
  if (!text.startsWith("---\n")) return { meta, body };
  const rest = text.slice("---\n".length);
  const idx = rest.indexOf("\n---\n");
  if (idx < 0) return { meta, body };
  const block = rest.slice(0, idx);
  body = rest.slice(idx + "\n---\n".length);
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const cut = line.indexOf(":");
    if (cut < 0) continue;
    const key = line.slice(0, cut).trim();
    meta[key] = trimQuotes(line.slice(cut + 1).trim());
  }
  return { meta, body };
}

/** 对齐 Go `strings.Trim(v, "\"'")`。 */
function trimQuotes(v: string): string {
  return v.replace(/^["']+/, "").replace(/["']+$/, "");
}

/** 取正文首行为 digest：剥去前导 `# `、trim，按**码点**截 80 字符。 */
export function firstLine(body: string): string {
  let line = body.split("\n")[0] ?? "";
  if (line.startsWith("# ")) line = line.slice(2);
  line = line.trim();
  const runes = Array.from(line);
  if (runes.length > 80) line = runes.slice(0, 80).join("");
  return line;
}

/** `filepath.Base`：同时认 `/` 与 `\`。 */
export function baseName(filename: string): string {
  const i = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  return i >= 0 ? filename.slice(i + 1) : filename;
}

/** `strings.TrimSuffix(filepath.Base(f), filepath.Ext(f))`。 */
export function stemOf(filename: string): string {
  const base = baseName(filename);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
