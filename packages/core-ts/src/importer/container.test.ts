import { describe, expect, it } from "vitest";

import type { Placement } from "./md";
import type { StoreSegment } from "../store/types";
import {
  attrSegsOf,
  childIdsOf,
  compareGoString,
  digestTextOf,
  kindOf,
  mergeChildren,
  sortDeclared,
} from "./container";

function seg(seq: number, text: string, kind = "text"): StoreSegment {
  return { itemId: "course/c1/lesson/l1", seq, kind, text, contentHash: "" };
}

function pl(order: string, filename: string): Placement {
  return { itemId: filename, course: "c1", lesson: "l1", order, filename };
}

describe("mergeChildren", () => {
  it("先 declared（去重）后 existing 未声明项，保持原相对顺序", () => {
    expect(mergeChildren(["a", "b", "c"], ["b", "d"])).toEqual(["b", "d", "a", "c"]);
  });

  it("declared 内部去重；existing 为空时原样返回 declared", () => {
    expect(mergeChildren([], ["x", "x", "y"])).toEqual(["x", "y"]);
    expect(mergeChildren(["z"], [])).toEqual(["z"]);
  });
});

describe("sortDeclared", () => {
  it("有 order 在前、order 升序、同 order 按文件名升序、缺省排末尾", () => {
    const items = [pl("2", "b.md"), pl("2", "a.md"), pl("", "z.md"), pl("1", "q.md")];
    expect(sortDeclared(items).map((p) => p.filename)).toEqual(["q.md", "a.md", "b.md", "z.md"]);
  });

  it("order 与文件名都相同时保持原相对顺序（稳定排序）", () => {
    const items = [pl("1", "b.md"), pl("1", "b.md"), pl("1", "a.md")];
    const got = sortDeclared(items);
    expect(got.map((p) => p.filename)).toEqual(["a.md", "b.md", "b.md"]);
    // 两份相同键的项不得被交换
    expect(got[1]).toBe(items[0]);
  });

  it("不修改入参", () => {
    const items = [pl("2", "b.md"), pl("1", "a.md")];
    sortDeclared(items);
    expect(items.map((p) => p.filename)).toEqual(["b.md", "a.md"]);
  });

  it("文件名按 UTF-8 字节序（emoji 与全角字符的分歧：JS `<` 是 UTF-16 码元序）", () => {
    // 😀 = F0 9F 98 80，０ = EF BC 90：字节序「０ < 😀」，而 UTF-16 码元序（D83D < FF10）「😀 < ０」。
    const items = [pl("1", "😀.md"), pl("1", "０.md")];
    expect(sortDeclared(items).map((p) => p.filename)).toEqual(["０.md", "😀.md"]);
  });
});

describe("compareGoString", () => {
  it("短串是长串前缀时为负", () => {
    expect(compareGoString("abc", "abcd")).toBeLessThan(0);
    expect(compareGoString("abcd", "abc")).toBeGreaterThan(0);
    expect(compareGoString("abc", "abc")).toBe(0);
  });

  it("ASCII 与 CJK 按字节序", () => {
    expect(compareGoString("a", "b")).toBeLessThan(0);
    expect(compareGoString("高", "０")).toBeLessThan(0); // E9… < EF…
  });

  it("emoji 与全角字符分歧于 JS 的 UTF-16 比较", () => {
    // JS UTF-16：😀 首码元 D83D < ０ 的 FF10 → 😀 更小。
    expect("😀" < "０").toBe(true);
    // 字节序相反：F0… > EF…。
    expect(compareGoString("😀", "０")).toBeGreaterThan(0);
  });
});

describe("segments 切分", () => {
  const segs = [seg(-2, "lat"), seg(-1, "cover"), seg(0, "简介"), seg(1, "child1"), seg(2, "child2")];

  it("childIdsOf 取 seq>=1 保持原序", () => {
    expect(childIdsOf(segs)).toEqual(["child1", "child2"]);
  });

  it("digestTextOf 取 seq==0，缺省为空串", () => {
    expect(digestTextOf(segs)).toBe("简介");
    expect(digestTextOf([seg(1, "child")])).toBe("");
  });

  it("attrSegsOf 取 seq<0 保持原序", () => {
    expect(attrSegsOf(segs)).toEqual([seg(-2, "lat"), seg(-1, "cover")]);
  });
});

describe("kindOf", () => {
  it("取 item_id 倒数第二段", () => {
    expect(kindOf("course/c1/lesson/l1/video/v1")).toBe("video");
    expect(kindOf("course/c1/lesson/l1/quiz/q")).toBe("quiz");
    expect(kindOf("course/c1")).toBe("course");
    expect(kindOf("a")).toBe("");
    expect(kindOf("")).toBe("");
  });
});