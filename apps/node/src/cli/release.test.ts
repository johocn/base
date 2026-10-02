// release 命令单测：stdout 逐字对齐（含全角 →、public_key 后三空格）、落盘签名文档、
// issued_at 秒精度，以及与 based.exe 的**跨实现 stdout 逐字相等**比对（跳过 if 无 exe）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalize,
  keyPairFromSeed,
  sha256Hex,
  verifyRelease,
  type Json,
  type ReleaseDoc,
} from "@base/protocol-ts";
import { createReleaseCommand } from "./release";

const BASED_EXE = fileURLToPath(new URL("../../../../based.exe", import.meta.url));
const KEY = "1".repeat(64);
const PUB = keyPairFromSeed(KEY).pubHex;
const APK = Buffer.from("fake-apk-" + "x".repeat(200) + "-中文", "utf8");
const APK_SHA = sha256Hex(new Uint8Array(APK));

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "base-rel-"));
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
    const code = await createReleaseCommand().run(args);
    return { code, stdout: buf };
  } finally {
    process.stdout.write = orig;
  }
}

function baseArgs(data: string, apk: string): string[] {
  return [
    "-version-name",
    "1.2.3",
    "-min-version-name",
    "1.0.0",
    "-apk-url",
    "https://example.com/app.apk",
    "-apk-file",
    apk,
    "-notes",
    "修复若干问题",
    "-issuer",
    "probe",
    "-sign-key",
    KEY,
    "-data",
    data,
  ];
}

describe("release 命令", () => {
  it("Node：stdout 逐字 + 落盘签名文档 + issued_at 秒精度", async () => {
    const root = tmpRoot();
    const data = join(root, "data");
    const apkPath = join(root, "app.apk");
    writeFileSync(apkPath, APK);

    const { code, stdout } = await runNode(baseArgs(data, apkPath));
    const path = join(data, "release.json");
    expect(code).toBe(0);
    expect(stdout).toBe(
      `release: version_name=1.2.3 min_version_name=1.0.0 → ${path}\n` +
        `  apk_size=${APK.length} apk_sha256=${APK_SHA}\n` +
        `  public_key   ${PUB}\n`,
    );

    const raw = readFileSync(path);
    const doc = JSON.parse(raw.toString("utf8")) as ReleaseDoc;
    expect(doc.payload.schema_version).toBe(1);
    expect(doc.payload.issuer).toBe("probe");
    expect(doc.payload.version_name).toBe("1.2.3");
    expect(doc.payload.min_version_name).toBe("1.0.0");
    expect(doc.payload.apk_url).toBe("https://example.com/app.apk");
    expect(doc.payload.apk_size).toBe(APK.length);
    expect(doc.payload.apk_sha256).toBe(APK_SHA);
    expect(doc.payload.notes).toBe("修复若干问题");
    // issued_at 必须是 UTC 秒精度（"YYYY-MM-DDTHH:MM:SSZ"，无毫秒）
    expect(doc.payload.issued_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(verifyRelease(doc, PUB)).toBe(true);
    // 落盘字节必须正好等于 canonicalize(整份文档) 的 UTF-8
    expect(raw.equals(Buffer.from(canonicalize(doc as unknown as Json), "utf8"))).toBe(true);
  });

  it("Node：必填缺失 / 缺 sign-key / APK 读失败 均抛错", async () => {
    const root = tmpRoot();
    const data = join(root, "data");
    const apkPath = join(root, "app.apk");
    writeFileSync(apkPath, APK);

    await expect(
      runNode([
        "-version-name",
        "1.2.3",
        "-apk-url",
        "https://example.com/app.apk",
        "-apk-file",
        apkPath,
        "-sign-key",
        KEY,
        "-data",
        data,
      ]),
    ).rejects.toThrow("release: -version-name、-min-version-name、-apk-url、-apk-file 均为必填");

    const prev = process.env.BASE_SIGN_KEY;
    process.env.BASE_SIGN_KEY = "";
    try {
      const noKey = baseArgs(data, apkPath);
      noKey.splice(noKey.indexOf("-sign-key"), 2);
      await expect(runNode(noKey)).rejects.toThrow(
        "release: 缺少 -sign-key（或环境变量 BASE_SIGN_KEY）：没有私钥不能签发升级文档",
      );
    } finally {
      if (prev === undefined) delete process.env.BASE_SIGN_KEY;
      else process.env.BASE_SIGN_KEY = prev;
    }

    await expect(runNode(baseArgs(data, join(root, "missing.apk")))).rejects.toThrow(
      /^release: 读取 APK 失败:/,
    );
  });
});

describe.skipIf(!existsSync(BASED_EXE))("跨实现：Go release vs Node release", () => {
  it("同一 data 目录与同一假 APK：stdout 逐字相等", async () => {
    const root = tmpRoot();
    const data = join(root, "data");
    const apkPath = join(root, "app.apk");
    writeFileSync(apkPath, APK);

    const args = baseArgs(data, apkPath);
    const go = spawnSync(BASED_EXE, ["release", ...args], { encoding: "utf8" });
    expect(go.status).toBe(0);
    const node = await runNode(args);
    expect(node.code).toBe(0);
    expect(node.stdout).toBe(go.stdout);
  });
});
