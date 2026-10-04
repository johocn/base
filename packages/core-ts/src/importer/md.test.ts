import { describe, expect, it } from "vitest";
import { sha256Hex, utf8 } from "@base/protocol-ts";

import { firstLine, splitFrontMatter } from "./frontmatter";
import {
  articleRowFromDoc,
  parseMD,
  resolvePlacement,
  validateCategories,
  type MdDoc,
} from "./md";

const SAMPLE = `---
slug: what-is-distributed-learning
title: 什么是分布式学习系统
tags: 分布式, 离线学习, 入门
published_at: 2026-09-25T00:00:00Z
---

分布式学习系统把「内容」和「分发」拆开。

第二段。
`;

describe("splitFrontMatter", () => {
  it("无 front-matter 时正文原样返回", () => {
    const { meta, body } = splitFrontMatter("hello\nworld\n");
    expect(meta).toEqual({});
    expect(body).toBe("hello\nworld\n");
  });

  it("CRLF 归一后拆出 meta 与正文（正文保留闭合分隔后的前导换行）", () => {
    const { meta, body } = splitFrontMatter(SAMPLE.replace(/\n/g, "\r\n"));
    expect(meta.slug).toBe("what-is-distributed-learning");
    expect(meta.tags).toBe("分布式, 离线学习, 入门");
    expect(body.startsWith("\n分布式")).toBe(true);
  });

  it("注释行与非法行被忽略，值剥引号", () => {
    const { meta } = splitFrontMatter(`---\n# c\nkey: "v"\nno-colon\n---\nbody\n`);
    expect(meta).toEqual({ key: "v" });
  });
});

describe("firstLine", () => {
  it("剥去前导 '# ' 并截 80 码点", () => {
    expect(firstLine("# 标题\n正文")).toBe("标题");
    const long = "字".repeat(100);
    expect(Array.from(firstLine(long)).length).toBe(80);
  });
});

describe("parseMD", () => {
  it("从 front-matter 派生全部字段并 trim 正文", () => {
    const doc = parseMD("01-x.md", SAMPLE);
    expect(doc.slug).toBe("what-is-distributed-learning");
    expect(doc.title).toBe("什么是分布式学习系统");
    expect(doc.tags).toEqual(["分布式", "离线学习", "入门"]);
    expect(doc.publishedAt).toBe("2026-09-25T00:00:00Z");
    expect(doc.body).toBe("分布式学习系统把「内容」和「分发」拆开。\n\n第二段。");
    expect(doc.digest).toBe("分布式学习系统把「内容」和「分发」拆开。");
  });

  it("缺 slug/title 时用文件名 stem；缺 published_at 补 1970", () => {
    const doc = parseMD("02-fallback.md", "# 首行标题\n\n正文\n");
    expect(doc.slug).toBe("02-fallback");
    expect(doc.title).toBe("首行标题");
    expect(doc.body).toBe("正文");
    expect(doc.publishedAt).toBe("1970-01-01T00:00:00Z");
  });

  it("首行标题派生时正文按空白裁剪（对齐 Go 的 TrimSpace 而非只裁换行）", () => {
    const doc = parseMD("03-ws.md", "# T\n\n  正文缩进  \n");
    expect(doc.body).toBe("正文缩进");
  });

  it("正文为空即抛错", () => {
    expect(() => parseMD("x.md", "---\nslug: a\n---\n")).toThrowError(/正文为空/);
  });
});

describe("resolvePlacement", () => {
  it("article 无 course ⇒ article/<slug>", () => {
    const p = resolvePlacement({}, "article", "s1", "a.md");
    expect(p.itemId).toBe("article/s1");
    expect(p.course).toBe("");
  });

  it("course + lesson ⇒ 全路径", () => {
    const p = resolvePlacement({ course: "c1", lesson: "l1", order: " 2 " }, "article", "s1", "a.md");
    expect(p.itemId).toBe("course/c1/lesson/l1/article/s1");
    expect(p.order).toBe("2");
  });

  it("quiz 无 course ⇒ standalone quiz/slug", () => {
    const p = resolvePlacement({}, "quiz", "q1", "q.md");
    expect(p.itemId).toBe("quiz/q1");
  });

  it("video 无 course ⇒ 抛错", () => {
    expect(() => resolvePlacement({}, "video", "v1", "v.md")).toThrowError(/缺少 front-matter/);
  });

  it("有 course 无 lesson ⇒ 抛错", () => {
    expect(() => resolvePlacement({ course: "c1" }, "article", "s1", "a.md")).toThrowError(
      /缺少 lesson/,
    );
  });
});

describe("validateCategories", () => {
  it("合法分类通过", () => {
    expect(() =>
      validateCategories([{ name: "a", category: "tech", course: "c1" }]),
    ).not.toThrow();
  });

  it("非法 slug / 无 course / 一课程两分类 各自抛错", () => {
    expect(() =>
      validateCategories([{ name: "a", category: "Tech", course: "c1" }]),
    ).toThrowError(/不是合法 slug/);
    expect(() =>
      validateCategories([{ name: "a", category: "tech", course: "" }]),
    ).toThrowError(/没有 course/);
    expect(() =>
      validateCategories([
        { name: "a", category: "tech", course: "c1" },
        { name: "b", category: "life", course: "c1" },
      ]),
    ).toThrowError(/至多属一个分类/);
  });
});

describe("articleRowFromDoc", () => {
  it("content_hash = sha256(body)，source_rev 取前 16 字符", () => {
    const doc = parseMD("a.md", SAMPLE) as MdDoc;
    const row = articleRowFromDoc("article/what-is-distributed-learning", doc);
    const hash = sha256Hex(utf8(doc.body));
    expect(row.contentHash).toBe(hash);
    expect(row.sourceRev).toBe(hash.slice(0, 16));
    expect(row.tagsJson).toBe('["分布式","离线学习","入门"]');
    expect(row.bodyMd).toBe(doc.body);
  });
});
