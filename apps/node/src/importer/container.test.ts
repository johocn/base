// `apps/node/src/importer/container.ts` 的库访问直测：镜像 `internal/importer/course.go` 的
// rebuildContainer / ensureLessonChild / isSubmittedContainer 语义（attrs_preserve_test.go / minimal 场景）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openHostDb } from "../host/sqlite";
import { openStore, type Store } from "../store/store";
import {
  ensureLessonChild,
  isSubmittedContainer,
  rebuildCategories,
  rebuildContainer,
  SubmittedContainerError,
} from "./container";
import type { ParsedMD } from "./container";

// 每个用例都要建真库 + mkdtemp，默认 5s 在并发全量跑下会超时（单跑 ~1.5s）。同 schema.test.ts 等重型用例。
vi.setConfig({ testTimeout: 20_000 });

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "base-e3c-"));
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

function openTemp(): Store {
  return openStore(tmpDir());
}

/** 造一个最小 parsedMD（仅供 rebuildCategories 用）。 */
function parsed(course: string, category: string, categoryTitle = "", categoryDigest = ""): ParsedMD {
  return {
    name: "x.md",
    raw: "",
    kind: "article",
    p: { itemId: `course/${course}/lesson/l1/article/x`, course, lesson: "l1", order: "", filename: "x.md" },
    doc: null,
    quiz: null,
    courseTitle: "",
    courseDigest: "",
    lessonTitle: "",
    lessonDigest: "",
    category,
    categoryTitle,
    categoryDigest,
  };
}

describe("isSubmittedContainer", () => {
  it("缺条目 / author_id 空 → false；author_id 非空 → true", () => {
    const dataDir = tmpDir();
    let store = openStore(dataDir);
    store.upsertSegmentItem({
      itemId: "course/c1",
      source: "course",
      type: "course",
      title: "课",
      segments: [],
    });
    expect(isSubmittedContainer(store, "course/nope")).toBe(false);
    expect(isSubmittedContainer(store, "course/c1")).toBe(false);
    store.close();

    const raw = openHostDb(join(dataDir, "base.db"));
    raw.run("UPDATE items SET author_id=? WHERE item_id=?", ["aa", "course/c1"]);
    raw.close();

    store = openStore(dataDir);
    try {
      expect(isSubmittedContainer(store, "course/c1")).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("rebuildContainer", () => {
  it("digest 为空省略 seq=0；title 为空回退 itemId", () => {
    const store = openTemp();
    try {
      rebuildContainer(store, "course/c9", "course", "course", "", "", ["course/c9/lesson/l1"]);
      expect(store.getItem("course/c9")?.title).toBe("course/c9");
      const segs = store.listSegments("course/c9");
      expect(segs.map((s) => s.seq)).toEqual([1]);
      expect(segs[0]?.kind).toBe("lesson");
    } finally {
      store.close();
    }
  });

  it("投稿域容器抛 SubmittedContainerError，不写库", () => {
    const dataDir = tmpDir();
    let store = openStore(dataDir);
    store.upsertSegmentItem({
      itemId: "course/c1",
      source: "course",
      type: "course",
      title: "投稿的课",
      segments: [{ itemId: "course/c1", seq: 1, kind: "lesson", text: "course/c1/lesson/l1", contentHash: "" }],
    });
    store.close();
    const raw = openHostDb(join(dataDir, "base.db"));
    raw.run("UPDATE items SET author_id=? WHERE item_id=?", ["aa", "course/c1"]);
    raw.close();

    store = openStore(dataDir);
    try {
      expect(() =>
        rebuildContainer(store, "course/c1", "course", "course", "改", "", ["course/c1/lesson/l2"]),
      ).toThrowError(SubmittedContainerError);
      expect(store.getItem("course/c1")?.title).toBe("投稿的课");
      expect(store.listSegments("course/c1").map((s) => s.text)).toEqual(["course/c1/lesson/l1"]);
    } finally {
      store.close();
    }
  });
});

describe("ensureLessonChild", () => {
  it("沿用既有 lesson 的 title 与 seq=0 digest，并合并子项", () => {
    const store = openTemp();
    try {
      store.upsertSegmentItem({
        itemId: "course/c1/lesson/l1",
        source: "lesson",
        type: "lesson",
        title: "第一讲",
        segments: [
          { itemId: "course/c1/lesson/l1", seq: 0, kind: "digest", text: "课时简介", contentHash: "" },
          { itemId: "course/c1/lesson/l1", seq: 1, kind: "article", text: "course/c1/lesson/l1/article/a", contentHash: "" },
        ],
      });
      ensureLessonChild(store, "c1", "l1", "course/c1/lesson/l1/video/v1");
      expect(store.getItem("course/c1/lesson/l1")?.title).toBe("第一讲");
      const segs = store.listSegments("course/c1/lesson/l1");
      expect(segs.find((s) => s.seq === 0)?.text).toBe("课时简介");
      expect(segs.filter((s) => s.seq >= 1).map((s) => s.text)).toEqual([
        "course/c1/lesson/l1/video/v1",
        "course/c1/lesson/l1/article/a",
      ]);
    } finally {
      store.close();
    }
  });

  it("既有 lesson 不存在时 title 回退 lesson 名，无 seq=0", () => {
    const store = openTemp();
    try {
      ensureLessonChild(store, "c1", "l9", "course/c1/lesson/l9/video/v1");
      expect(store.getItem("course/c1/lesson/l9")?.title).toBe("l9");
      expect(store.listSegments("course/c1/lesson/l9").map((s) => s.seq)).toEqual([1]);
    } finally {
      store.close();
    }
  });
});

describe("rebuildCategories", () => {
  it("覆盖集合 = 声明 ∪ 既有；既有未声明的分类被重写为空清单且保留 title", () => {
    const store = openTemp();
    try {
      store.upsertSegmentItem({
        itemId: "category/legacy",
        source: "category",
        type: "category",
        title: "旧分类",
        segments: [{ itemId: "category/legacy", seq: 1, kind: "course", text: "course/gone", contentHash: "" }],
      });
      const errs = rebuildCategories(store, [parsed("c1", "math", "数学", "数学入门")]);
      expect(errs).toEqual([]);
      expect(store.getItem("category/math")?.title).toBe("数学");
      expect(
        store.listSegments("category/math").map((s) => s.text),
      ).toEqual(["数学入门", "course/c1"]);
      expect(store.getItem("category/legacy")?.title).toBe("旧分类");
      expect(store.listSegments("category/legacy").filter((s) => s.seq >= 1)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("同一分类下的同一课程只收一次（去重）", () => {
    const store = openTemp();
    try {
      const errs = rebuildCategories(store, [parsed("c1", "math"), parsed("c1", "math")]);
      expect(errs).toEqual([]);
      expect(
        store.listSegments("category/math").filter((s) => s.seq >= 1).map((s) => s.text),
      ).toEqual(["course/c1"]);
    } finally {
      store.close();
    }
  });
});