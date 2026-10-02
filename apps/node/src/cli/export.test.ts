// G4 逐字节取证（基于 based.exe）：Node 与 Go 对同一 data 目录导出的 pack.sqlite + manifest.json
// 必须 sha256 全等。两个方向各自使用**独立的等价副本**（export 在 Version=0 时会自增 content_version，
// 同一目录导两次会得到不同 pack_id）。
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@base/protocol-ts";
import { createExportCommand } from "./export";
import { createImportMdCommand } from "./import-md";

const BASED_EXE = fileURLToPath(new URL("../../../../based.exe", import.meta.url));
const P3_PROBE = fileURLToPath(new URL("../../../../.tmp/p3probe", import.meta.url));
const SEED = fileURLToPath(new URL("../../../../seed", import.meta.url));
const E3SEED = fileURLToPath(new URL("./__fixtures__/e3seed/", import.meta.url));
const KEY = "1".repeat(64);
const ISSUED_AT = "2026-01-01T00:00:00Z";

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "base-g4-"));
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

/** 复制一份 data 目录（含 base.db 与兄弟 .key）。 */
function copyData(src: string, root: string, name: string): string {
  const dest = join(root, name);
  cpSync(src, dest, { recursive: true });
  cpSync(src + ".key", dest + ".key");
  return dest;
}

interface ExportOut {
  packId: string;
  contentVersion: number;
  entries: number;
  merkleRoot: string;
  packSha: string;
  manifestSha: string;
}

function parseOut(stdout: string): ExportOut {
  const packId = /pack_id=(\S+)/.exec(stdout)?.[1] ?? "";
  const contentVersion = Number(/content_version=(\d+)/.exec(stdout)?.[1] ?? -1);
  const entries = Number(/entries=(\d+)/.exec(stdout)?.[1] ?? -1);
  const merkleRoot = /merkle_root=(\S+)/.exec(stdout)?.[1] ?? "";
  const packSha = /pack\.sqlite\s+\S+\s+sha256=(\S+)/.exec(stdout)?.[1] ?? "";
  const manifestSha = /manifest\.json\s+\S+\s+sha256=(\S+)/.exec(stdout)?.[1] ?? "";
  return { packId, contentVersion, entries, merkleRoot, packSha, manifestSha };
}

function runGoExport(dataDir: string): ExportOut {
  const res = spawnSync(
    BASED_EXE,
    ["export", "-sign-key", KEY, "-issuer", "probe", "-issued-at", ISSUED_AT, "-data", dataDir],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`based.exe export 失败: ${res.stdout}\n${res.stderr}`);
  return parseOut(res.stdout);
}

async function runNodeExport(dataDir: string): Promise<ExportOut> {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => {
    buf += String(c);
    return true;
  };
  try {
    const code = await createExportCommand().run([
      "-sign-key",
      KEY,
      "-issuer",
      "probe",
      "-issued-at",
      ISSUED_AT,
      "-data",
      dataDir,
    ]);
    if (code !== 0) throw new Error(`Node export 退出码 ${code}`);
  } finally {
    process.stdout.write = orig;
  }
  return parseOut(buf);
}

/** 独立复核：直接读盘算 sha256（不用 stdout 自报值）。 */
function diskHashes(dataDir: string, packId: string): { pack: string; manifest: string } {
  const dir = join(dataDir, "packs", packId);
  return {
    pack: sha256Hex(new Uint8Array(readFileSync(join(dir, "pack.sqlite")))),
    manifest: sha256Hex(new Uint8Array(readFileSync(join(dir, "manifest.json")))),
  };
}

describe.skipIf(!existsSync(BASED_EXE))("G4 逐字节：Go export vs Node export", () => {
  it.skipIf(!existsSync(join(P3_PROBE, "base.db")))("方向 1：Go 建库 → 两侧导出", async () => {
    const root = tmpRoot();
    const goDir = copyData(P3_PROBE, root, "go");
    const nodeDir = copyData(P3_PROBE, root, "node");

    const go = runGoExport(goDir);
    const node = await runNodeExport(nodeDir);

    const goDisk = diskHashes(goDir, go.packId);
    const nodeDisk = diskHashes(nodeDir, node.packId);
    // eslint-disable-next-line no-console
    console.log(
      `[G4-1] go   pack_id=${go.packId} cv=${go.contentVersion} entries=${go.entries} merkle=${go.merkleRoot}\n` +
        `[G4-1] node pack_id=${node.packId} cv=${node.contentVersion} entries=${node.entries} merkle=${node.merkleRoot}\n` +
        `[G4-1] pack.sqlite  go=${goDisk.pack}\n[G4-1] pack.sqlite  node=${nodeDisk.pack}\n` +
        `[G4-1] manifest.json go=${goDisk.manifest}\n[G4-1] manifest.json node=${nodeDisk.manifest}`,
    );

    expect(node.packId).toBe(go.packId);
    expect(node.contentVersion).toBe(go.contentVersion);
    expect(node.entries).toBe(go.entries);
    expect(node.merkleRoot).toBe(go.merkleRoot);
    expect(nodeDisk.pack).toBe(goDisk.pack);
    expect(nodeDisk.manifest).toBe(goDisk.manifest);
  }, 120000);

  it("方向 2：Node 建库（seed）→ 两侧导出", async () => {
    const root = tmpRoot();
    const src = join(root, "src");
    const code = await createImportMdCommand().run(["-dir", SEED, "-data", src]);
    expect(code).toBe(0);

    const goDir = copyData(src, root, "go");
    const nodeDir = copyData(src, root, "node");

    const go = runGoExport(goDir);
    const node = await runNodeExport(nodeDir);

    const goDisk = diskHashes(goDir, go.packId);
    const nodeDisk = diskHashes(nodeDir, node.packId);
    // eslint-disable-next-line no-console
    console.log(
      `[G4-2] go   pack_id=${go.packId} cv=${go.contentVersion} entries=${go.entries} merkle=${go.merkleRoot}\n` +
        `[G4-2] node pack_id=${node.packId} cv=${node.contentVersion} entries=${node.entries} merkle=${node.merkleRoot}\n` +
        `[G4-2] pack.sqlite  go=${goDisk.pack}\n[G4-2] pack.sqlite  node=${nodeDisk.pack}\n` +
        `[G4-2] manifest.json go=${goDisk.manifest}\n[G4-2] manifest.json node=${nodeDisk.manifest}`,
    );

    expect(node.packId).toBe(go.packId);
    expect(node.contentVersion).toBe(go.contentVersion);
    expect(node.entries).toBe(go.entries);
    expect(nodeDisk.pack).toBe(goDisk.pack);
    expect(nodeDisk.manifest).toBe(goDisk.manifest);
  }, 120000);

  it("方向 3：容器/分类/题库 seed → Go 与 Node 各自 import-md 建库 → 各自 export 全等", async () => {
    const root = tmpRoot();
    const goDir = join(root, "go");
    const nodeDir = join(root, "node");

    // 各自 import-md 建库（Go 版、Node 版，目录互不共享）。
    const goImp = spawnSync(BASED_EXE, ["import-md", "-dir", E3SEED, "-data", goDir], {
      encoding: "utf8",
    });
    expect(goImp.status).toBe(0);
    expect(goImp.stdout).toBe("import-md: 导入 7 篇，失败 0 篇\n");
    const nodeImpCode = await createImportMdCommand().run(["-dir", E3SEED, "-data", nodeDir]);
    expect(nodeImpCode).toBe(0);

    // 各自 export（独立 data 目录：export 在 Version=0 会自增 content_version）。
    const go = runGoExport(goDir);
    const node = await runNodeExport(nodeDir);

    const goDisk = diskHashes(goDir, go.packId);
    const nodeDisk = diskHashes(nodeDir, node.packId);
    // eslint-disable-next-line no-console
    console.log(
      `[G4-3] go   pack_id=${go.packId} cv=${go.contentVersion} entries=${go.entries} merkle=${go.merkleRoot}\n` +
        `[G4-3] node pack_id=${node.packId} cv=${node.contentVersion} entries=${node.entries} merkle=${node.merkleRoot}\n` +
        `[G4-3] pack.sqlite  go=${goDisk.pack}\n[G4-3] pack.sqlite  node=${nodeDisk.pack}\n` +
        `[G4-3] manifest.json go=${goDisk.manifest}\n[G4-3] manifest.json node=${nodeDisk.manifest}`,
    );

    expect(node.packId).toBe(go.packId);
    expect(node.contentVersion).toBe(go.contentVersion);
    expect(node.entries).toBe(go.entries);
    expect(node.merkleRoot).toBe(go.merkleRoot);
    expect(nodeDisk.pack).toBe(goDisk.pack);
    expect(nodeDisk.manifest).toBe(goDisk.manifest);
  }, 120000);
});
