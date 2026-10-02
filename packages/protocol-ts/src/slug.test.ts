import { describe, expect, it } from "vitest";

import { isValidSlug } from "./slug";

describe("isValidSlug", () => {
  const ok = ["a", "c1", "course-2026", "a".repeat(64), "a-b-c"];
  for (const s of ok) {
    it(`接受 ${JSON.stringify(s)}`, () => {
      expect(isValidSlug(s)).toBe(true);
    });
  }

  const bad = ["", "-a", "A", "a_b", "中文", "a/b", "a".repeat(65)];
  for (const s of bad) {
    it(`拒绝 ${JSON.stringify(s)}`, () => {
      expect(isValidSlug(s)).toBe(false);
    });
  }
});
