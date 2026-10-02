// cli/scrub.ts 单测：未知 flag 报错；无对端时（Go 侧 scrub 无「至少一个对端」校验）
// 在临时目录离线跑通一轮空 scrub 并返回 0。**不起真网络**。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createScrubCommand } from "./scrub";

const KEYS = ["BASE_PEERS", "BASE_STORE_KEY", "BASE_STORE_KEY_FILE", "BASE_TLS_CERT", "BASE_TLS_KEY"] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true });
    } catch {
      /* Windows 句柄竞态 */
    }
  }
});

describe("scrub 命令", () => {
  it("未知 flag → 未知参数 -bogus", async () => {
    await expect(createScrubCommand().run(["-bogus"])).rejects.toThrow("未知参数 -bogus");
  });

  it("无对端 + 空库：离线跑完一轮 scrub 且返回 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "base-scrub-"));
    dirs.push(dir);
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk): boolean => {
      written.push(String(chunk));
      return true;
    });
    try {
      const code = await createScrubCommand().run(["-data", dir]);
      expect(code).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(written.join("")).toContain(
      "based: scrub checked=0 repaired=0 dropped=0 unrepaired=0",
    );
  });
});