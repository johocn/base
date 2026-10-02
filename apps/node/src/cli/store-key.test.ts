// store-key 命令单测：init/show 的 stdout 逐字（含 key_hex 后两空格）、错误分支、
// 以及跨实现比对——init 各用独立 data 目录比格式，show 用同一份 Node 生成的密钥比 hex。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createStoreKeyCommand } from "./store-key";

const BASED_EXE = fileURLToPath(new URL("../../../../based.exe", import.meta.url));
const HEADER = "已生成密钥（离线恢复码，请抄走并离线保存）：";
const EXISTS_MSG = "密钥已存在，未改动。";
const WARN = "警告：丢失该密钥 = data 目录内内容永久不可读。";
const USAGE = "用法: based store-key <show|init> [-data <dir>]";
const HEX_PREFIX = "key_hex  = ";

// 密钥环境变量会覆盖文件档：测试期间清空（Node 命令与 spawn 的 Go 命令共用 process.env）。
const SAVED_KEY = process.env.BASE_STORE_KEY;
const SAVED_FILE = process.env.BASE_STORE_KEY_FILE;
beforeAll(() => {
  delete process.env.BASE_STORE_KEY;
  delete process.env.BASE_STORE_KEY_FILE;
});
afterAll(() => {
  if (SAVED_KEY !== undefined) process.env.BASE_STORE_KEY = SAVED_KEY;
  if (SAVED_FILE !== undefined) process.env.BASE_STORE_KEY_FILE = SAVED_FILE;
});

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "base-key-"));
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
    const code = await createStoreKeyCommand().run(args);
    return { code, stdout: buf };
  } finally {
    process.stdout.write = orig;
  }
}

function parseHex(stdout: string): string {
  return stdout.split("\n")[2].slice(HEX_PREFIX.length);
}

describe("store-key 命令", () => {
  it("Node init：生成密钥文件，stdout 逐字", async () => {
    const root = tmpRoot();
    const data = join(root, "node-data");
    const { code, stdout } = await runNode(["init", "-data", data]);
    const lines = stdout.split("\n");
    expect(code).toBe(0);
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toBe(`key_path = ${data}.key`);
    expect(lines[2]).toMatch(/^key_hex  = [0-9a-f]{64}$/);
    expect(lines[3]).toBe(WARN);
    expect(lines[4]).toBe(""); // 末尾换行
    const hex = parseHex(stdout);
    expect(readFileSync(data + ".key", "utf8")).toBe(hex + "\n");
  });

  it("Node show 与「密钥已存在」分支", async () => {
    const root = tmpRoot();
    const data = join(root, "node-data");
    const init = await runNode(["init", "-data", data]);
    const hex = parseHex(init.stdout);

    const show = await runNode(["show", "-data", data]);
    expect(show.code).toBe(0);
    expect(show.stdout).toBe(`key_path = ${data}.key\n` + `${HEX_PREFIX}${hex}\n`);

    const again = await runNode(["init", "-data", data]);
    expect(again.code).toBe(0);
    expect(again.stdout).toBe(
      `${EXISTS_MSG}\nkey_path = ${data}.key\n${HEX_PREFIX}${hex}\n`,
    );
  });

  it("Node show：密钥不存在时抛错", async () => {
    const root = tmpRoot();
    const data = join(root, "empty");
    await expect(runNode(["show", "-data", data])).rejects.toThrow(
      `密钥不存在（来源 ${data}.key）：先运行 based store-key init`,
    );
  });

  it("Node：用法与子命令错误", async () => {
    const root = tmpRoot();
    const data = join(root, "x");
    await expect(runNode([])).rejects.toThrow(USAGE);
    await expect(runNode(["-data", data])).rejects.toThrow(USAGE);
    await expect(runNode(["bogus", "-data", data])).rejects.toThrow(
      '未知子命令 "bogus"；用法: based store-key <show|init>',
    );
    await expect(runNode(["show", "extra", "-data", data])).rejects.toThrow(
      `未知参数 "extra"；${USAGE}`,
    );
  });
});

describe.skipIf(!existsSync(BASED_EXE))("跨实现：Go store-key vs Node store-key", () => {
  it("init：各用独立 data 目录，格式与前缀一致（hex 各自随机）", async () => {
    const root = tmpRoot();
    const nodeData = join(root, "node-data");
    const goData = join(root, "go-data");

    const node = await runNode(["init", "-data", nodeData]);
    const go = spawnSync(BASED_EXE, ["store-key", "init", "-data", goData], { encoding: "utf8" });
    expect(go.status).toBe(0);

    const nl = node.stdout.split("\n");
    const gl = go.stdout.split("\n");
    expect(nl[0]).toBe(gl[0]);
    expect(nl[0]).toBe(HEADER);
    expect(nl[1]).toBe(`key_path = ${nodeData}.key`);
    expect(gl[1]).toBe(`key_path = ${goData}.key`);
    expect(nl[2]).toMatch(/^key_hex  = [0-9a-f]{64}$/);
    expect(gl[2]).toMatch(/^key_hex  = [0-9a-f]{64}$/);
    expect(nl[2]).not.toBe(gl[2]); // 随机密钥 → hex 不同
    expect(nl[3]).toBe(gl[3]);
    expect(nl[4]).toBe(gl[4]);
    expect(existsSync(nodeData + ".key")).toBe(true);
    expect(existsSync(goData + ".key")).toBe(true);
  });

  it("show：Go 读 Node 生成的密钥文件，stdout 完全相等", async () => {
    const root = tmpRoot();
    const data = join(root, "shared-data");
    const init = await runNode(["init", "-data", data]);
    const hex = parseHex(init.stdout);

    const node = await runNode(["show", "-data", data]);
    const go = spawnSync(BASED_EXE, ["store-key", "show", "-data", data], { encoding: "utf8" });
    expect(go.status).toBe(0);
    expect(node.stdout).toBe(`key_path = ${data}.key\n${HEX_PREFIX}${hex}\n`);
    expect(go.stdout).toBe(node.stdout);
  });
});
