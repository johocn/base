/**
 * `internal/importer/md.go` + `course.go` 的**纯派生**：front-matter → 载体形态
 * （slug / item_id / tags / digest / content_hash）。不做文件 IO、不写库、不切分容器 segments
 * （容器重建需要读库既有状态，属节点宿主层；本批仅接线文章路径）。
 */
import { isValidSlug, sha256Hex, utf8 } from "@base/protocol-ts";

import { firstLine, splitFrontMatter, stemOf } from "./frontmatter";

/** 一篇待导入文章（对齐 Go `Doc`）。 */
export interface MdDoc {
  slug: string;
  title: string;
  digest: string;
  publishedAt: string;
  course: string;
  courseTitle: string;
  courseDigest: string;
  lesson: string;
  lessonTitle: string;
  lessonDigest: string;
  order: string;
  tags: string[];
  body: string;
}

/** 解析带可选 front-matter 的 markdown；正文为空即抛错。 */
export function parseMD(filename: string, raw: string): MdDoc {
  const { meta, body: rawBody } = splitFrontMatter(raw);
  let body = rawBody.replace(/^\n+/, "").replace(/\n+$/, "");
  if (body === "") throw new Error(`importer: ${filename} 正文为空`);
  const stem = stemOf(filename);
  const doc: MdDoc = {
    slug: meta.slug ?? "",
    title: meta.title ?? "",
    digest: meta.digest ?? "",
    publishedAt: meta.published_at ?? "",
    course: (meta.course ?? "").trim(),
    courseTitle: meta.course_title ?? "",
    courseDigest: meta.course_digest ?? "",
    lesson: (meta.lesson ?? "").trim(),
    lessonTitle: meta.lesson_title ?? "",
    lessonDigest: meta.lesson_digest ?? "",
    order: (meta.order ?? "").trim(),
    tags: [],
    body,
  };
  if (doc.slug === "") doc.slug = stem;
  if (doc.title === "") {
    const first = body.split("\n")[0] ?? "";
    if (first.startsWith("# ")) {
      doc.title = first.slice(2).trim();
      const rest = body.includes("\n") ? body.slice(body.indexOf("\n") + 1) : "";
      // 对齐 Go `strings.Trim(strings.TrimSpace(rest), "\n")`：此处按空白裁剪，不只裁换行。
      doc.body = rest.trim();
      body = doc.body;
    } else {
      doc.title = stem;
    }
  }
  const t = meta.tags ?? "";
  if (t !== "") {
    for (const part of t.split(",")) {
      const p = part.trim();
      if (p !== "") doc.tags.push(p);
    }
  }
  if (doc.publishedAt === "") doc.publishedAt = "1970-01-01T00:00:00Z";
  if (doc.digest === "") doc.digest = firstLine(body);
  return doc;
}

/** 载体的归属解析结果（对齐 Go `placement`）。 */
export interface Placement {
  itemId: string;
  /** 空 = 未归类。 */
  course: string;
  lesson: string;
  /** 空 = 缺省（排在该课时清单末尾）。 */
  order: string;
  filename: string;
}

/**
 * 按 front-matter 算载体 item_id（册子 §2.1 / §4.2 规则 1–3）。
 * kind ∈ {article, video, quiz}；只有 article 允许无 course。
 */
export function resolvePlacement(
  meta: Record<string, string>,
  kind: string,
  slug: string,
  filename: string,
): Placement {
  const course = (meta.course ?? "").trim();
  const lesson = (meta.lesson ?? "").trim();
  const p: Placement = {
    itemId: "",
    course,
    lesson,
    order: (meta.order ?? "").trim(),
    filename,
  };
  if (course === "") {
    if (kind !== "article") {
      throw new Error(
        `importer: ${filename} 的 ${kind} 缺少 front-matter \`course\`（无顶层 ${kind} 命名空间）`,
      );
    }
    p.itemId = "article/" + slug;
    return p;
  }
  if (lesson === "") {
    throw new Error(
      `importer: ${filename} 声明了 course=${course} 但缺少 lesson（不允许只有课程没有课时的载体）`,
    );
  }
  p.itemId = `course/${course}/lesson/${lesson}/${kind}/${slug}`;
  return p;
}

/** 分类校验的输入（一篇已解析载体的最小面）。 */
export interface CategoryInput {
  name: string;
  category: string;
  course: string;
}

/**
 * 导入器侧的**硬校验**（册子 §3.4），必须在任何写库之前执行，失败即整批退出。
 * 三条判定：category 合法 slug；声明 category 必须有 course；一个 course 至多属一个分类。
 */
export function validateCategories(items: readonly CategoryInput[]): void {
  const seen: Record<string, string> = {};
  for (const it of items) {
    if (it.category === "") continue;
    if (!isValidSlug(it.category)) {
      throw new Error(
        `importer: ${it.name} 的 front-matter \`category=${it.category}\` 不是合法 slug（[a-z0-9][a-z0-9-]{0,63}）`,
      );
    }
    if (it.course === "") {
      throw new Error(
        `importer: ${it.name} 声明了 category=${it.category} 但没有 course（分类只承载课程归属）`,
      );
    }
    const prev = seen[it.course];
    if (prev !== undefined && prev !== it.category) {
      throw new Error(
        `importer: 课程 ${it.course} 同时声明了分类 ${prev} 与 ${it.category}（一个课程至多属一个分类，册子 §3.4）`,
      );
    }
    seen[it.course] = it.category;
  }
}

/** 文章写库行的派生（对齐 Go `upsertArticleDoc`；body_md 明文，加密在宿主层）。 */
export interface ArticleRow {
  itemId: string;
  title: string;
  digest: string;
  publishedAt: string;
  tagsJson: string;
  bodyMd: string;
  contentHash: string;
  sourceRev: string;
}

/** 由解析结果派生文章行：content_hash = hex(sha256(body))，source_rev = hash 前 16 字符。 */
export function articleRowFromDoc(itemId: string, doc: MdDoc): ArticleRow {
  const tagsJson = JSON.stringify(doc.tags);
  const hash = sha256Hex(utf8(doc.body));
  return {
    itemId,
    title: doc.title,
    digest: doc.digest,
    publishedAt: doc.publishedAt,
    tagsJson,
    bodyMd: doc.body,
    contentHash: hash,
    sourceRev: hash.slice(0, 16),
  };
}
