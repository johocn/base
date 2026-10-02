// pubkey 命令单测：stdout 逐字（issuer= / public_key_hex=）、缺 sign-key 抛错，
// 以及与 based.exe 的跨实现 stdout 逐字相等比对。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { keyPairFromSeed } from "@base/protocol-ts";
import { createPubkeyCommand } from "./pubkey";

const BASED_EXE = fileURLToPath(new URL("../../../../based.exe", import.meta.url));
const KEY = "1".repeat(64);
const PUB = keyPairFromSeed(KEY).pubHex;

async function runNode(args: string[]): Promise<{ code: number; stdout: string }> {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => {
    buf += String(c);
    return true;
  };
  try {
    const code = await createPubkeyCommand().run(args);
    return { code, stdout: buf };
  } finally {
    process.stdout.write = orig;
  }
}

describe("pubkey 命令", () => {
  it("Node：stdout 逐字", async () => {
    const { code, stdout } = await runNode(["-sign-key", KEY, "-issuer", "probe"]);
    expect(code).toBe(0);
    expect(stdout).toBe(`issuer=probe\npublic_key_hex=${PUB}\n`);
  });

  it("Node：issuer 缺省为 base-node-1", async () => {
    const prev = process.env.BASE_ISSUER;
    delete process.env.BASE_ISSUER;
    try {
      const { stdout } = await runNode(["-sign-key", KEY]);
      expect(stdout).toBe(`issuer=base-node-1\npublic_key_hex=${PUB}\n`);
    } finally {
      if (prev !== undefined) process.env.BASE_ISSUER = prev;
    }
  });

  it("Node：缺 sign-key 抛错", async () => {
    const prev = process.env.BASE_SIGN_KEY;
    process.env.BASE_SIGN_KEY = "";
    try {
      await expect(runNode([])).rejects.toThrow(
        "pubkey: 缺少 -sign-key（或环境变量 BASE_SIGN_KEY）",
      );
    } finally {
      if (prev === undefined) delete process.env.BASE_SIGN_KEY;
      else process.env.BASE_SIGN_KEY = prev;
    }
  });
});

describe.skipIf(!existsSync(BASED_EXE))("跨实现：Go pubkey vs Node pubkey", () => {
  it("同一 sign-key/issuer：stdout 完全相等", async () => {
    const args = ["-sign-key", KEY, "-issuer", "probe"];
    const go = spawnSync(BASED_EXE, ["pubkey", ...args], { encoding: "utf8" });
    expect(go.status).toBe(0);
    const node = await runNode(args);
    expect(node.code).toBe(0);
    expect(node.stdout).toBe(go.stdout);
  });
});
