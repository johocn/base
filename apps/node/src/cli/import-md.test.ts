// import-md 的 G8 取证：对同一 seed 目录、各自独立的 data 目录，Node 与 based.exe 的
// stdout 必须**逐行相同**（stdout 不含路径，故两侧可比）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createImportMdCommand } from "./import-md";

const BASED_EXE = fileURLToPath(new URL("../../../../based.exe", import.meta.url));
const SEED = fileURLToPath(new URL("../../../../seed", import.meta.url));
const E3SEED = fileURLToPath(new URL("./__fixtures__/e3seed/", import.meta.url));

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "base-import-"));
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

async function runNode(args: string[]): Promise<{ code: number; stdout: string }> {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => {
    buf += String(c);
    return true;
  };
  try {
    const code = await createImportMdCommand().run(args);
    return { code, stdout: buf };
  } finally {
    process.stdout.write = orig;
  }
}

describe.skipIf(!existsSync(BASED_EXE))("跨实现：Go import-md vs Node import-md", () => {
  it("同一 seed 目录：stdout 逐行相同", async () => {
    const root = tmpRoot();
    const go = spawnSync(BASED_EXE, ["import-md", "-dir", SEED, "-data", join(root, "go")], {
      encoding: "utf8",
    });
    expect(go.status).toBe(0);
    const node = await runNode(["-dir", SEED, "-data", join(root, "node")]);
    expect(node.code).toBe(0);

    expect(go.stdout).toBe("import-md: 导入 3 篇，失败 0 篇\n");
    expect(node.stdout).toBe(go.stdout);
  });

  it("e3seed（容器/分类/题库）：stdout 逐行相同、退出码相同", async () => {
    const root = tmpRoot();
    const go = spawnSync(BASED_EXE, ["import-md", "-dir", E3SEED, "-data", join(root, "go")], {
      encoding: "utf8",
    });
    const node = await runNode(["-dir", E3SEED, "-data", join(root, "node")]);

    expect(go.status).toBe(0);
    expect(node.code).toBe(go.status);
    expect(node.stdout).toBe(go.stdout);
    expect(go.stdout).toBe("import-md: 导入 7 篇，失败 0 篇\n");
  });
});
