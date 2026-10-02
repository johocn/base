// import-video 对拍：库侧逐条镜像 internal/importer/video_test.go；G4 用**真实视频文件**
// （运行时生成、> 2 MiB 跨 ≥2 块且末块短）跑出非平凡 merkle_root，坐实判据 6。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex, merkleRoot } from "@base/protocol-ts";
import { openHostDb } from "../host/sqlite";
import { openStore } from "../store/store";
import { createExportCommand } from "./export";
import { createImportVideoCommand, importVideo } from "./import-video";

const BASED_EXE = fileURLToPath(new URL("../../../../based.exe", import.meta.url));
const KEY = "1".repeat(64);
const ISSUED_AT = "2026-01-01T00:00:00Z";
const CHUNK = 1 << 20;
/** 2.5 MiB → 3 块（前两块满，末块 512 KiB）。 */
const VIDEO_SIZE = 2 * CHUNK + CHUNK / 2;

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "base-e4-"));
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

/** 确定性生成视频字节（固定算法，不把二进制提交进仓库）。 */
function writeVideo(path: string, size: number): string {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + (i >> 7) * 17 + (i >> 15) * 5) & 0xff;
  writeFileSync(path, buf);
  return path;
}

function openTemp(): ReturnType<typeof openStore> {
  return openStore(tmpRoot());
}

/** 捕获 process.stdout 上写入的文本（Node 子命令用）。 */
async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => {
    buf += String(c);
    return true;
  };
  try {
    const code = await fn();
    return { code, out: buf };
  } finally {
    process.stdout.write = orig;
  }
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
  return {
    packId: /pack_id=(\S+)/.exec(stdout)?.[1] ?? "",
    contentVersion: Number(/content_version=(\d+)/.exec(stdout)?.[1] ?? -1),
    entries: Number(/entries=(\d+)/.exec(stdout)?.[1] ?? -1),
    merkleRoot: /merkle_root=(\S+)/.exec(stdout)?.[1] ?? "",
    packSha: /pack\.sqlite\s+\S+\s+sha256=(\S+)/.exec(stdout)?.[1] ?? "",
    manifestSha: /manifest\.json\s+\S+\s+sha256=(\S+)/.exec(stdout)?.[1] ?? "",
  };
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
  const { code, out } = await captureStdout(() =>
    createExportCommand().run([
      "-sign-key",
      KEY,
      "-issuer",
      "probe",
      "-issued-at",
      ISSUED_AT,
      "-data",
      dataDir,
    ]),
  );
  if (code !== 0) throw new Error(`Node export 退出码 ${code}`);
  return parseOut(out);
}

/** 独立复核：直接读盘算 sha256（不用 stdout 自报值）。 */
function diskHashes(dataDir: string, packId: string): { pack: string; manifest: string } {
  const dir = join(dataDir, "packs", packId);
  return {
    pack: sha256Hex(new Uint8Array(readFileSync(join(dir, "pack.sqlite")))),
    manifest: sha256Hex(new Uint8Array(readFileSync(join(dir, "manifest.json")))),
  };
}

/** 把既有条目改成「投稿域」（author_id 非空）：关库 → 裸 SQL 补写。 */
function markSubmitted(dataDir: string, itemId: string, authorId: string): void {
  const raw = openHostDb(join(dataDir, "base.db"));
  try {
    raw.run("UPDATE items SET author_id=?, author_sig=? WHERE item_id=?", [authorId, "ff", itemId]);
  } finally {
    raw.close();
  }
}

describe("ImportVideo 库侧（video_test.go）", () => {
  it("分块：ChunkSize*2.5 → 3 块，media_meta 与并入课时清单", () => {
    const store = openTemp();
    try {
      const path = writeVideo(join(tmpRoot(), "clip.mp4"), VIDEO_SIZE);
      const res = importVideo(store, { path, slug: "v1", course: "c1", lesson: "l1", title: "第一课", mime: "", duration: 0 });
      expect(res.chunks).toBe(3);
      expect(res.written).toBe(3);
      expect(res.totalSize).toBe(VIDEO_SIZE);

      const meta = store.getMediaMeta("course/c1/lesson/l1/video/v1");
      expect(meta?.mime).toBe("video/mp4");
      expect(meta?.size).toBe(VIDEO_SIZE);
      expect(meta?.chunkSize).toBe(CHUNK);
      expect(meta?.duration).toBe(0);
      expect(meta?.chunkHashes).toHaveLength(3);

      const merged = store
        .listSegments("course/c1/lesson/l1")
        .filter((s) => s.seq >= 1)
        .map((s) => s.text);
      expect(merged).toContain("course/c1/lesson/l1/video/v1");
    } finally {
      store.close();
    }
  });

  it("幂等：同文件同参数第二次「本次写盘=0」且 content_hash 不变", () => {
    const store = openTemp();
    try {
      const path = writeVideo(join(tmpRoot(), "clip.mp4"), VIDEO_SIZE);
      const opt = { path, slug: "v1", course: "c1", lesson: "l1", title: "", mime: "", duration: 0 };
      const r1 = importVideo(store, opt);
      const r2 = importVideo(store, opt);
      expect(r1.written).toBe(3);
      expect(r2.written).toBe(0);
      expect(r2.contentHash).toBe(r1.contentHash);
    } finally {
      store.close();
    }
  });

  it("校验与错误文案逐字相同", () => {
    const store = openTemp();
    try {
      const base = { title: "", mime: "", duration: 0 };
      expect(() => importVideo(store, { ...base, path: "", slug: "v", course: "c", lesson: "l" })).toThrowError(
        /^importer: -file 与 -slug 都是必填$/,
      );
      expect(() => importVideo(store, { ...base, path: "x", slug: "  ", course: "c", lesson: "l" })).toThrowError(
        /^importer: -file 与 -slug 都是必填$/,
      );
      expect(() => importVideo(store, { ...base, path: "x", slug: "v", course: "", lesson: "l" })).toThrowError(
        /^importer: -course 与 -lesson 都是必填（无顶层 video 命名空间）$/,
      );
      expect(() => importVideo(store, { ...base, path: "x", slug: "v", course: "c", lesson: "" })).toThrowError(
        /^importer: -course 与 -lesson 都是必填（无顶层 video 命名空间）$/,
      );

      const empty = join(tmpRoot(), "empty.mp4");
      writeFileSync(empty, Buffer.alloc(0));
      expect(() => importVideo(store, { ...base, path: empty, slug: "v", course: "c", lesson: "l" })).toThrowError(
        /^importer: 视频为空（0 字节），分块后没有任何块文件，无法导出$/,
      );

      const missing = join(tmpRoot(), "nope.mp4");
      expect(() => importVideo(store, { ...base, path: missing, slug: "v", course: "c", lesson: "l" })).toThrowError(
        /^importer: 打开视频: /,
      );
    } finally {
      store.close();
    }
  });

  it("投稿域课时容器：产 warning 非致命，容器原样保留，命令返回 0", async () => {
    const dataDir = tmpRoot();
    let store = openStore(dataDir);
    store.upsertSegmentItem({
      itemId: "course/c1/lesson/l1",
      source: "lesson",
      type: "lesson",
      title: "投稿课时",
      segments: [
        { itemId: "course/c1/lesson/l1", seq: 1, kind: "article", text: "course/c1/lesson/l1/article/x", contentHash: "" },
      ],
    });
    store.close();
    markSubmitted(dataDir, "course/c1/lesson/l1", "aa");

    store = openStore(dataDir);
    const path = writeVideo(join(tmpRoot(), "clip.mp4"), 10);
    try {
      const res = importVideo(store, { path, slug: "v1", course: "c1", lesson: "l1", title: "", mime: "", duration: 0 });
      expect(res.warnings).toEqual(["skipped: course/c1/lesson/l1 投稿域，导入器不覆盖"]);
      expect(store.getItem("course/c1/lesson/l1")?.title).toBe("投稿课时");
      // 条目本身仍登记成功
      expect(store.getMediaMeta("course/c1/lesson/l1/video/v1")?.size).toBe(10);
    } finally {
      store.close();
    }

    const path2 = writeVideo(join(tmpRoot(), "clip2.mp4"), 11);
    const { code, out } = await captureStdout(() =>
      createImportVideoCommand().run([
        "-file", path2, "-slug", "v2", "-course", "c1", "-lesson", "l1", "-data", dataDir,
      ]),
    );
    expect(code).toBe(0);
    expect(out).toMatch(/^import-video: course\/c1\/lesson\/l1\/video\/v2 块数=1 总字节=11 本次写盘=1 content_hash=[0-9a-f]{64}\n$/);
  });

  it("MIME 缺省推断与显式 -mime 覆盖", () => {
    const store = openTemp();
    try {
      const cases: [string, string][] = [
        ["a.webm", "video/webm"],
        ["b.mkv", "video/x-matroska"],
        ["c.mov", "video/quicktime"],
        ["d.xyz", "application/octet-stream"],
        ["e.M4V", "video/mp4"],
      ];
      for (const [name, want] of cases) {
        const path = writeVideo(join(tmpRoot(), name), 10);
        const id = `course/c/lesson/l/video/${name}`;
        importVideo(store, { path, slug: name, course: "c", lesson: "l", title: "", mime: "", duration: 0 });
        expect(store.getMediaMeta(id)?.mime).toBe(want);
      }
      const path = writeVideo(join(tmpRoot(), "f.mp4"), 10);
      importVideo(store, { path, slug: "f.mp4", course: "c", lesson: "l", title: "", mime: "video/custom", duration: 7 });
      expect(store.getMediaMeta("course/c/lesson/l/video/f.mp4")?.mime).toBe("video/custom");
      expect(store.getMediaMeta("course/c/lesson/l/video/f.mp4")?.duration).toBe(7);
    } finally {
      store.close();
    }
  });
});

describe.skipIf(!existsSync(BASED_EXE))("G4-4 逐字节：真实视频文件的 import-video（Go vs Node）", () => {
  it("两侧导入 → 各自 export：stdout / pack_id / merkle_root / pack.sqlite / manifest 全等，且 merkle 非平凡", async () => {
    const root = tmpRoot();
    const goDir = join(root, "go");
    const nodeDir = join(root, "node");
    const video = writeVideo(join(root, "lecture.mp4"), VIDEO_SIZE);

    const flags = [
      "-file", video,
      "-slug", "v1",
      "-course", "cs101",
      "-lesson", "l1",
      "-title", "第一讲",
      "-duration", "90",
      "-data",
    ];

    const goImp = spawnSync(BASED_EXE, ["import-video", ...flags, goDir], { encoding: "utf8" });
    expect(goImp.status).toBe(0);

    const nodeImp = await captureStdout(() =>
      createImportVideoCommand().run([...flags, nodeDir]),
    );
    expect(nodeImp.code).toBe(0);

    // ① stdout 逐字相同
    expect(nodeImp.out).toBe(goImp.stdout);

    // ② 两侧各自 export
    const go = runGoExport(goDir);
    const node = await runNodeExport(nodeDir);
    const goDisk = diskHashes(goDir, go.packId);
    const nodeDisk = diskHashes(nodeDir, node.packId);

    const emptyMerkle = merkleRoot([]);
    // eslint-disable-next-line no-console
    console.log(
      `[G4-4] import-video stdout go  =${JSON.stringify(goImp.stdout)}\n` +
        `[G4-4] import-video stdout node=${JSON.stringify(nodeImp.out)}\n` +
        `[G4-4] go   pack_id=${go.packId} cv=${go.contentVersion} entries=${go.entries} merkle_root=${go.merkleRoot}\n` +
        `[G4-4] node pack_id=${node.packId} cv=${node.contentVersion} entries=${node.entries} merkle_root=${node.merkleRoot}\n` +
        `[G4-4] pack.sqlite   go=${goDisk.pack}\n[G4-4] pack.sqlite   node=${nodeDisk.pack}\n` +
        `[G4-4] manifest.json  go=${goDisk.manifest}\n[G4-4] manifest.json  node=${nodeDisk.manifest}\n` +
        `[G4-4] merkle_root=${go.merkleRoot} 空集常量=${emptyMerkle} 非平凡=${go.merkleRoot !== emptyMerkle}`,
    );

    expect(node.packId).toBe(go.packId);
    expect(node.contentVersion).toBe(go.contentVersion);
    expect(node.entries).toBe(go.entries);
    expect(node.merkleRoot).toBe(go.merkleRoot);
    expect(nodeDisk.pack).toBe(goDisk.pack);
    expect(nodeDisk.manifest).toBe(goDisk.manifest);
    // ③ merkle 必须非平凡（真视频块 > 0，不等于空集常量）
    expect(go.merkleRoot).not.toBe(emptyMerkle);
    expect(go.merkleRoot).not.toBe("b5b867a806ecbe6e33384b30f7dd30e00811421f4936f0eb3eccd9fb7e86ff2a");
  }, 120000);
});