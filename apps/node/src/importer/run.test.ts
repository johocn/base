// `apps/node/src/importer/run.ts` 与 `container.ts` 的库访问对拍：逐条镜像
// `internal/importer/{course_test.go,category_test.go,submitted_skip_test.go,attrs_preserve_test.go,quiz_test.go}`。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openHostDb } from "../host/sqlite";
import { openStore, type Store } from "../store/store";
import { ensureLessonChild, rebuildContainer } from "./container";
import { runImport } from "./run";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "base-e3-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true });
    } catch {
      /* Windows 句柄竞态 */
    }
  }
});

/** 把若干 markdown（name → 内容）写进同一个临时目录，返回目录路径。 */
function writeMD(files: Record<string, string>): string {
  const dir = tmpDir();
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}

function openTemp(): Store {
  return openStore(tmpDir());
}

/** 某容器 seq>=1 的子项清单（按 seq 升序）。 */
function segmentTexts(store: Store, itemId: string): string[] {
  return store
    .listSegments(itemId)
    .filter((s) => s.seq >= 1)
    .map((s) => s.text);
}

/** 记录每个 active 条目的清单，用于幂等比对。 */
function snapshotSegments(store: Store): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const it of store.listItems("active")) out[it.itemId] = store.listSegments(it.itemId);
  return out;
}

/** 把既有条目改成「投稿域」（author_id 非空）：关库 → 裸 SQL 补写 → 重开。 */
function markSubmitted(dataDir: string, itemId: string, authorId: string): void {
  const raw = openHostDb(join(dataDir, "base.db"));
  try {
    raw.run("UPDATE items SET author_id=?, author_sig=? WHERE item_id=?", [authorId, "ff", itemId]);
  } finally {
    raw.close();
  }
}

describe("Run 课程/课时容器（course_test.go）", () => {
  it("规则 3：order 缺省排末尾，order 相同按文件名升序", () => {
    const store = openTemp();
    try {
      const dir = writeMD({
        "10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\norder: 2\n---\n\n甲",
        "20-b.md": "---\nslug: b\ntitle: 乙\ncourse: c1\nlesson: l1\norder: 1\n---\n\n乙",
        "30-c.md": "---\nslug: c\ntitle: 丙\ncourse: c1\nlesson: l1\n---\n\n丙",
      });
      const res = runImport(store, dir);
      expect(res.imported).toBe(3);
      expect(res.failed).toBe(0);
      expect(segmentTexts(store, "course/c1/lesson/l1")).toEqual([
        "course/c1/lesson/l1/article/b", // order=1
        "course/c1/lesson/l1/article/a", // order=2
        "course/c1/lesson/l1/article/c", // 缺省排末尾
      ]);
      expect(segmentTexts(store, "course/c1")).toEqual(["course/c1/lesson/l1"]);
    } finally {
      store.close();
    }
  });

  it("规则 1：course 缺省 → 独立文章 article/<slug>，不进任何清单", () => {
    const store = openTemp();
    try {
      const dir = writeMD({ "a.md": "---\nslug: solo\ntitle: 独立文章\n---\n\n正文" });
      const res = runImport(store, dir);
      expect(res.imported).toBe(1);
      expect(res.failed).toBe(0);
      expect(store.getItem("article/solo")).not.toBeNull();
      const items = store.listItems("active");
      expect(items).toHaveLength(1);
      for (const it of items) {
        for (const id of segmentTexts(store, it.itemId)) expect(id).not.toBe("article/solo");
      }
    } finally {
      store.close();
    }
  });

  it("规则 2：course 有值、lesson 缺省 → 只该文件失败，不整批失败", () => {
    const store = openTemp();
    try {
      const dir = writeMD({
        "01-ok.md": "---\nslug: ok\ntitle: 正常\n---\n\n正文",
        "02-bad.md": "---\nslug: bad\ntitle: 缺课时\ncourse: c1\n---\n\n正文",
      });
      const res = runImport(store, dir);
      expect(res.imported).toBe(1);
      expect(res.failed).toBe(1);
      expect(res.errors.join("\n")).toContain("02-bad.md");
      expect(store.getItem("article/ok")).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it("规则 4：容器 title / digest 缺省口径", () => {
    const store = openTemp();
    try {
      const dir = writeMD({
        "01-default.md": "---\nslug: d\ntitle: 默认\ncourse: c2\nlesson: l2\n---\n\n正文",
        "02-explicit.md":
          "---\nslug: e\ntitle: 显式\ncourse: c3\ncourse_title: 显式课程\ncourse_digest: 课程简介\nlesson: l3\nlesson_title: 第一讲\nlesson_digest: 课时简介\n---\n\n正文",
      });
      runImport(store, dir);

      expect(store.getItem("course/c2")?.title).toBe("c2");
      expect(store.getItem("course/c2/lesson/l2")?.title).toBe("l2");
      for (const id of ["course/c2", "course/c2/lesson/l2"]) {
        for (const s of store.listSegments(id)) expect(s.seq).not.toBe(0);
      }

      expect(store.getItem("course/c3")?.title).toBe("显式课程");
      expect(store.getItem("course/c3/lesson/l3")?.title).toBe("第一讲");
      const c3 = store.listSegments("course/c3");
      expect(c3[0]?.seq).toBe(0);
      expect(c3[0]?.text).toBe("课程简介");
      const l3 = store.listSegments("course/c3/lesson/l3");
      expect(l3[0]?.seq).toBe(0);
      expect(l3[0]?.text).toBe("课时简介");
    } finally {
      store.close();
    }
  });

  it("规则 6（前半）：连跑两次幂等", () => {
    const store = openTemp();
    try {
      const dir = writeMD({
        "01-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\norder: 1\n---\n\n甲",
        "02-b.md": "---\nslug: b\ntitle: 乙\ncourse: c1\nlesson: l1\norder: 2\n---\n\n乙",
        "03-c.md": "---\nslug: c\ntitle: 丙\ncourse: c1\nlesson: l2\n---\n\n丙",
        "04-d.md": "---\nslug: d\ntitle: 丁\n---\n\n丁",
      });
      runImport(store, dir);
      const first = snapshotSegments(store);
      const count1 = store.listItems("active").length;

      runImport(store, dir);
      expect(snapshotSegments(store)).toEqual(first);
      expect(store.listItems("active").length).toBe(count1);
    } finally {
      store.close();
    }
  });

  it("规则 6（后半）：合并式重建保留 import-video 的行，且不冲掉 lesson_title", () => {
    const store = openTemp();
    try {
      const dir = writeMD({
        "01-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\nlesson_title: 第一讲\n---\n\n甲的正文",
      });
      runImport(store, dir);

      const videoId = "course/c1/lesson/l1/video/v1";
      store.upsertMediaItem({
        itemId: videoId,
        source: "lesson",
        type: "video",
        title: "视频一",
        sourceRev: "vh16",
        contentHash: "vh",
        mime: "video/mp4",
        size: 11,
        duration: 0,
        chunkSize: 11,
        chunkHashes: ["vh"],
      });
      ensureLessonChild(store, "c1", "l1", videoId);
      expect(store.getItem("course/c1/lesson/l1")?.title).toBe("第一讲");

      runImport(store, dir);
      const got = segmentTexts(store, "course/c1/lesson/l1");
      expect(got).toContain(videoId);
      expect(got).toContain("course/c1/lesson/l1/article/a");
      expect(store.getItem("course/c1/lesson/l1")?.title).toBe("第一讲");
    } finally {
      store.close();
    }
  });
});

describe("Run 分类容器（category_test.go）", () => {
  it("同一课程声明两个分类必须报错，且写库前失败", () => {
    const store = openTemp();
    try {
      const dir = writeMD({
        "10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: math\n---\n\n甲",
        "20-b.md": "---\nslug: b\ntitle: 乙\ncourse: c1\nlesson: l1\ncategory: physics\n---\n\n乙",
      });
      expect(() => runImport(store, dir)).toThrowError(/至多属一个分类/);
      expect(store.listItems("active")).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("非法 category slug / 声明 category 但无 course 均报错", () => {
    {
      const store = openTemp();
      try {
        const dir = writeMD({
          "10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: Math_1\n---\n\n甲",
        });
        expect(() => runImport(store, dir)).toThrowError(/不是合法 slug/);
      } finally {
        store.close();
      }
    }
    {
      const store = openTemp();
      try {
        const dir = writeMD({
          "10-a.md": "---\nslug: a\ntitle: 甲\ncategory: math\n---\n\n甲",
        });
        expect(() => runImport(store, dir)).toThrowError(/没有 course/);
      } finally {
        store.close();
      }
    }
  });

  it("同一分类多个文档：条目 source/type/sqlite_table 与标题取第一个非空 category_title", () => {
    const store = openTemp();
    try {
      const dir = writeMD({
        "10-a.md":
          "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: math\ncategory_title: 数学\n---\n\n甲",
        "20-b.md": "---\nslug: b\ntitle: 乙\ncourse: c1\nlesson: l2\ncategory: math\n---\n\n乙",
      });
      const res = runImport(store, dir);
      expect(res.imported).toBe(2);
      expect(res.failed).toBe(0);
      const it = store.getItem("category/math");
      expect(it?.source).toBe("category");
      expect(it?.type).toBe("category");
      expect(it?.sqliteTable).toBe("segments");
      expect(it?.title).toBe("数学");
      expect(segmentTexts(store, "category/math")).toEqual(["course/c1"]);
    } finally {
      store.close();
    }
  });

  it("分类清单按 course id 字节序升序，与文件遍历顺序无关", () => {
    const store = openTemp();
    try {
      const dir = writeMD({
        "10-a.md":
          "---\nslug: a\ntitle: 甲\ncourse: c2\nlesson: l1\ncategory: math\ncategory_digest: 数学入门\n---\n\n甲",
        "20-b.md": "---\nslug: b\ntitle: 乙\ncourse: c1\nlesson: l1\ncategory: math\n---\n\n乙",
      });
      runImport(store, dir);
      const segs = store.listSegments("category/math");
      expect(segs).toHaveLength(3);
      expect(segs[0]?.seq).toBe(0);
      expect(segs[0]?.kind).toBe("digest");
      expect(segs[0]?.text).toBe("数学入门");
      expect(segmentTexts(store, "category/math")).toEqual(["course/c1", "course/c2"]);
    } finally {
      store.close();
    }
  });

  it("课程换分类：旧分类清单清空、新分类收编，课程 content_hash 不变", () => {
    const store = openTemp();
    try {
      const before = writeMD({
        "10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: math\n---\n\n甲",
      });
      runImport(store, before);
      const courseBefore = store.getItem("course/c1");

      const after = writeMD({
        "10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: physics\n---\n\n甲",
      });
      runImport(store, after);
      expect(segmentTexts(store, "category/physics")).toEqual(["course/c1"]);
      expect(segmentTexts(store, "category/math")).toEqual([]);
      expect(store.getItem("course/c1")?.contentHash).toBe(courseBefore?.contentHash);
    } finally {
      store.close();
    }
  });

  it("重复导入分类条目哈希稳定、清单行数不叠加", () => {
    const store = openTemp();
    try {
      const dir = writeMD({
        "10-a.md":
          "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: math\ncategory_title: 数学\n---\n\n甲",
      });
      runImport(store, dir);
      const first = store.getItem("category/math");
      runImport(store, dir);
      expect(store.getItem("category/math")?.contentHash).toBe(first?.contentHash);
      expect(segmentTexts(store, "category/math")).toEqual(["course/c1"]);
    } finally {
      store.close();
    }
  });

  it("既有分类未被声明时：清单清空但 title / seq=0 digest 保留", () => {
    const store = openTemp();
    try {
      const first = writeMD({
        "10-a.md":
          "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: math\ncategory_title: 数学\ncategory_digest: 数学入门\n---\n\n甲",
      });
      runImport(store, first);
      const second = writeMD({
        "10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\n---\n\n甲",
      });
      runImport(store, second);
      expect(store.getItem("category/math")?.title).toBe("数学");
      expect(segmentTexts(store, "category/math")).toEqual([]);
      const segs = store.listSegments("category/math");
      expect(segs).toHaveLength(1);
      expect(segs[0]?.seq).toBe(0);
      expect(segs[0]?.text).toBe("数学入门");
    } finally {
      store.close();
    }
  });

  it("悬空 course 引用：既有分类里的 course/gone 被全量重算清掉（不合并）", () => {
    const store = openTemp();
    try {
      store.upsertSegmentItem({
        itemId: "category/legacy",
        source: "category",
        type: "category",
        title: "旧分类",
        segments: [
          { itemId: "category/legacy", seq: 0, kind: "digest", text: "旧简介", contentHash: "" },
          { itemId: "category/legacy", seq: 1, kind: "course", text: "course/gone", contentHash: "" },
        ],
      });
      const dir = writeMD({
        "10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: math\n---\n\n甲",
      });
      runImport(store, dir);
      expect(segmentTexts(store, "category/legacy")).toEqual([]);
      expect(segmentTexts(store, "category/math")).toEqual(["course/c1"]);
    } finally {
      store.close();
    }
  });

  it("独立文章不进分类清单；quiz 与 article 共用文档级三键", () => {
    const store = openTemp();
    try {
      const dir = writeMD({
        "10-a.md": "---\nslug: a\ntitle: 甲\n---\n\n甲",
        "20-q.md":
          "---\ntype: quiz\nslug: q\ncourse: c1\nlesson: l1\ncategory: math\ncategory_title: 数学\n---\n\n### 题\n- [x] 甲\n- 乙\n",
      });
      const res = runImport(store, dir);
      expect(res.imported).toBe(2);
      expect(segmentTexts(store, "category/math")).toEqual(["course/c1"]);
      expect(store.getItem("article/a")).not.toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("Run 投稿域（submitted_skip_test.go）", () => {
  it("投稿域容器跳过并转 warning，不产 error，容器原样保留", () => {
    const dataDir = tmpDir();
    let store = openStore(dataDir);
    store.upsertSegmentItem({
      itemId: "course/c1",
      source: "course",
      type: "course",
      title: "投稿的课",
      segments: [
        { itemId: "course/c1", seq: 1, kind: "lesson", text: "course/c1/lesson/l1", contentHash: "" },
      ],
    });
    store.close();
    markSubmitted(dataDir, "course/c1", "aa");

    store = openStore(dataDir);
    try {
      const dir = writeMD({
        "a1.md": "---\nslug: a1\ntitle: 甲文\ncourse: c1\nlesson: l1\nlesson_title: 第一讲\n---\n\n正文\n",
      });
      const res = runImport(store, dir);
      expect(res.failed).toBe(0);
      expect(res.warnings.join("\n")).toContain("course/c1");
      expect(store.getItem("course/c1")?.title).toBe("投稿的课");
    } finally {
      store.close();
    }
  });

  it("空归属的存量容器仍可被导入器重建", () => {
    const store = openTemp();
    try {
      store.upsertSegmentItem({
        itemId: "course/c2",
        source: "course",
        type: "course",
        title: "旧课",
        segments: [
          { itemId: "course/c2", seq: 1, kind: "lesson", text: "course/c2/lesson/l1", contentHash: "" },
        ],
      });
      const dir = writeMD({
        "a2.md": "---\nslug: a2\ntitle: 乙文\ncourse: c2\nlesson: l1\ncourse_title: 新课\n---\n\n正文\n",
      });
      const res = runImport(store, dir);
      expect(res.warnings).toHaveLength(0);
      expect(store.getItem("course/c2")?.title).toBe("新课");
    } finally {
      store.close();
    }
  });
});

describe("rebuildContainer 属性行保留（attrs_preserve_test.go）", () => {
  it("重建保留 seq<0 属性行，按 seq 排在最前，简介更新，子项合并", () => {
    const store = openTemp();
    try {
      store.upsertSegmentItem({
        itemId: "course/c1",
        source: "course",
        type: "course",
        title: "甲课",
        segments: [
          { itemId: "course/c1", seq: -1, kind: "attr.cover", text: "00112233445566778899aabbccddeeff", contentHash: "" },
          { itemId: "course/c1", seq: -2, kind: "attr.instructor", text: "李老师", contentHash: "" },
          { itemId: "course/c1", seq: 1, kind: "lesson", text: "course/c1/lesson/l1", contentHash: "" },
        ],
      });
      rebuildContainer(store, "course/c1", "course", "course", "甲课", "新简介", ["course/c1/lesson/l2"]);
      const segs = store.listSegments("course/c1");
      expect(segs.map((s) => s.seq)).toEqual([-2, -1, 0, 1, 2]);
      expect(segs[0]?.kind).toBe("attr.instructor");
      expect(segs[1]?.kind).toBe("attr.cover");
      expect(segs.find((s) => s.seq === 0)?.text).toBe("新简介");
      const kids = segmentTexts(store, "course/c1");
      expect(kids).toEqual(["course/c1/lesson/l2", "course/c1/lesson/l1"]);
    } finally {
      store.close();
    }
  });
});

describe("Run quiz 载体（quiz_test.go 的库侧）", () => {
  it("type: quiz → item type/table 为 quiz/quizzes，question_json 含 HTML 转义", () => {
    const store = openTemp();
    try {
      const dir = writeMD({
        "50-q.md":
          "---\ntype: quiz\nslug: what-is-cid\ntitle: 内容寻址小测\ncourse: c1\nlesson: l1\n---\n\n### 内容寻址里，一份字节的标识是什么？\n- 文件路径\n- [x] 内容哈希 < 递增序号\n- 递增序号\n> 标识即哈希，a & b 且 <标签>。\n",
      });
      const res = runImport(store, dir);
      expect(res.imported).toBe(1);
      expect(res.failed).toBe(0);
      const id = "course/c1/lesson/l1/quiz/what-is-cid";
      expect(store.getItem(id)?.type).toBe("quiz");
      expect(store.getItem(id)?.sqliteTable).toBe("quizzes");
      const q = store.listQuizzes([id])[id];
      expect(q?.questionJson).toContain('"answer":1');
      expect(q?.questionJson).toContain("\\u003c"); // < 被 Go json HTML 转义
      expect(q?.questionJson).toContain("\\u0026"); // & 被转义
    } finally {
      store.close();
    }
  });
});