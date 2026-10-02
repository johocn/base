// `internal/importer/md.go` 的 `Run` 编排（宿主层）：读目录 → 解析归属 → 分类硬校验 →
// 写载体 → 重建容器/分类 → 可选退役旧形态。纯解析在 `@base/core-ts` 的 importer 模块。
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import {
  articleRowFromDoc,
  parseMD,
  parseQuiz,
  quizRowFromQuiz,
  resolvePlacement,
  splitFrontMatter,
  validateCategories,
} from "@base/core-ts";
import type { Store } from "../store/store";
import { rebuildCategories, rebuildContainers, type ParsedMD } from "./container";

export interface ImportResult {
  imported: number;
  failed: number;
  errors: string[];
  warnings: string[];
}

export interface RunOptions {
  /** 把仍为 active 的旧形态（item_id 含 ':'）条目一次性墓碑退役，默认 false。 */
  retireLegacy?: boolean;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `filepath.Ext`：从最后一个路径分隔符起向右找第一个 `.`（认 `/` 与 `\`）。 */
function extOf(path: string): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const c = path[i];
    if (c === "/" || c === "\\") break;
    if (c === ".") return path.slice(i);
  }
  return "";
}

/** 按 UTF-8 字节序升序（对齐 Go `sort.Strings`）。 */
function compareUtf8(a: string, b: string): number {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ab[i] !== bb[i]) return ab[i] < bb[i] ? -1 : 1;
  }
  return ab.length - bb.length;
}

/**
 * 导入目录下全部 *.md（按文件名升序），幂等覆盖同 slug 条目。
 * 两阶段：先解析全部文件与归属（任何失败只计 errors、跳过该文件，不整批失败），
 * 再写载体、合并式重建受影响容器，最后可选退役旧形态条目。
 * 分类硬校验失败即整批退出（抛错，未打印任何输出、未写任何库）。
 */
export function runImport(store: Store, dir: string, opts: RunOptions = {}): ImportResult {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`importer: read dir ${dir}: ${msg(err)}`);
  }
  const names = entries
    .filter((e) => !e.isDirectory() && extOf(e.name).toLowerCase() === ".md")
    .map((e) => e.name)
    .sort(compareUtf8);

  const res: ImportResult = { imported: 0, failed: 0, errors: [], warnings: [] };

  // 阶段 1：解析 + 归属，先不写任何库。
  const items: ParsedMD[] = [];
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
    const it: ParsedMD = {
      name,
      raw,
      kind: "article",
      p: { itemId: "", course: "", lesson: "", order: "", filename: "" },
      doc: null,
      quiz: null,
      courseTitle: meta.course_title ?? "",
      courseDigest: meta.course_digest ?? "",
      category: (meta.category ?? "").trim(),
      categoryTitle: meta.category_title ?? "",
      categoryDigest: meta.category_digest ?? "",
      lessonTitle: meta.lesson_title ?? "",
      lessonDigest: meta.lesson_digest ?? "",
    };
    try {
      if (meta.type === "quiz") {
        const q = parseQuiz(name, raw);
        const p = resolvePlacement(meta, "quiz", q.slug, name);
        it.kind = "quiz";
        it.p = p;
        it.quiz = q;
      } else {
        const doc = parseMD(name, raw);
        const p = resolvePlacement(meta, "article", doc.slug, name);
        it.kind = "article";
        it.p = p;
        it.doc = doc;
      }
    } catch (err) {
      res.failed++;
      res.errors.push(name + ": " + msg(err));
      continue;
    }
    items.push(it);
  }

  // 阶段 1.5：分类硬校验（册子 §3.4）。必须在任何写库之前失败：失败即整批退出、不产出任何包。
  validateCategories(items.map((it) => ({ name: it.name, category: it.category, course: it.p.course })));

  // 阶段 2：写全部载体。
  for (const it of items) {
    try {
      if (it.kind === "quiz") {
        const row = quizRowFromQuiz(it.p.itemId, it.quiz as NonNullable<ParsedMD["quiz"]>);
        store.upsertQuiz(row);
      } else {
        const row = articleRowFromDoc(it.p.itemId, it.doc as NonNullable<ParsedMD["doc"]>);
        store.upsertArticle({ ...row, updatedAt: "" });
      }
    } catch (err) {
      res.failed++;
      res.errors.push(it.name + ": " + msg(err));
      continue;
    }
    res.imported++;
  }

  // 阶段 3：合并式重建受影响容器。投稿域容器不覆盖，转 warning 不转 error。
  {
    const { errs, warns } = rebuildContainers(store, items);
    res.warnings.push(...warns);
    for (const e of errs) {
      res.failed++;
      res.errors.push(e);
    }
  }

  // 阶段 3.5：分类容器全量重算（册子 §3.2），必须在课程/课时容器重建之后。
  for (const e of rebuildCategories(store, items)) {
    res.failed++;
    res.errors.push(e);
  }

  // 阶段 4：一次性退役旧形态（item_id 含 ':'）条目。
  if (opts.retireLegacy === true) {
    const rev = store.nextContentVersion();
    const active = store.listItems("active");
    for (const it of active) {
      if (!it.itemId.includes(":")) continue;
      try {
        store.retireItem(it.itemId, rev);
      } catch (err) {
        res.failed++;
        res.errors.push(it.itemId + ": 退役失败: " + msg(err));
      }
    }
  }
  return res;
}