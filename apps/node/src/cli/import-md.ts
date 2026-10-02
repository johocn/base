// import-md：把目录下的 markdown 导入内容库（镜像 cmd/based/import.go + internal/importer/md.go）。
// 纯解析/派生在 `@base/core-ts` 的 importer 模块；本文件负责读目录、写库与打印。
//
// 本批范围（Task 3）：只接线**无 course 的文章路径**（seed/ 三篇）。容器重建
// （course/lesson/category 的 segments）与 quiz / video 派生未实现，遇到即 fail-fast，
// 以免静默产出与 Go 版不同的包。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CliCommand } from "@base/core-ts";
import {
  articleRowFromDoc,
  parseMD,
  resolvePlacement,
  splitFrontMatter,
  validateCategories,
  type MdDoc,
} from "@base/core-ts";
import { openStore, type Store } from "../store/store";
import { parseFlags } from "./flags";

interface ParsedItem {
  name: string;
  category: string;
  course: string;
  itemId: string;
  doc: MdDoc;
}

export interface ImportResult {
  imported: number;
  failed: number;
  errors: string[];
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** UTF-8 字节序比较（对齐 Go `sort.Strings` 的字节序）。 */
function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** 导入目录下全部 *.md（按文件名升序）。任何单文件失败只计数，不整批失败。 */
export function importMarkdownDir(store: Store, dir: string): ImportResult {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.isDirectory() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => e.name)
    .sort(compareUtf8);

  const res: ImportResult = { imported: 0, failed: 0, errors: [] };

  // 阶段 1：解析 + 归属，先不写任何库。
  const items: ParsedItem[] = [];
  for (const name of names) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), "utf8");
    } catch (err) {
      res.failed++;
      res.errors.push(name + ": " + msg(err));
      continue;
    }
    const { meta } = splitFrontMatter(raw);
    if (meta.type === "quiz") {
      res.failed++;
      res.errors.push(name + ": importer: 本批未实现 quiz 导入（Task 3 仅文章路径）");
      continue;
    }
    try {
      const doc = parseMD(name, raw);
      const p = resolvePlacement(meta, "article", doc.slug, name);
      items.push({
        name,
        category: (meta.category ?? "").trim(),
        course: p.course,
        itemId: p.itemId,
        doc,
      });
    } catch (err) {
      res.failed++;
      res.errors.push(name + ": " + msg(err));
    }
  }

  // 阶段 1.5：分类硬校验（册子 §3.4）：必须在任何写库之前失败。
  validateCategories(items.map((it) => ({ name: it.name, category: it.category, course: it.course })));

  // 容器重建（course/lesson/category 的 segments）未接线：有 course 归属即 fail-fast。
  const withCourse = items.find((it) => it.course !== "");
  if (withCourse !== undefined) {
    throw new Error(
      `importer: ${withCourse.name} 有 course 归属，本批未接线容器重建（Task 3 仅无 course 的文章路径）`,
    );
  }

  // 阶段 2：写全部文章载体。
  for (const it of items) {
    try {
      const row = articleRowFromDoc(it.itemId, it.doc);
      store.upsertArticle({ ...row, updatedAt: "" });
      res.imported++;
    } catch (err) {
      res.failed++;
      res.errors.push(it.name + ": " + msg(err));
    }
  }
  return res;
}

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
      if (values["retire-legacy"] === "true") {
        throw new Error("importer: -retire-legacy 本批未实现");
      }

      const store = openStore(values.data);
      try {
        const res = importMarkdownDir(store, values.dir);
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
