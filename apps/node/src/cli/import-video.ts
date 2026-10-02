// import-video：把一个文件按定长 1 MiB 分块导入内容库
// （镜像 cmd/based/importvideo.go + internal/importer/video.go 的 ImportVideo）。
// 纯派生（item_id / content_hash / MIME / 标题 / 分块粒度）在 `@base/core-ts`；本文件负责 flag 解析、
// 顺序读文件的宿主 IO、blob 写盘与打印。
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { CliCommand } from "@base/core-ts";
import {
  guessVideoMime,
  VIDEO_CHUNK_SIZE,
  videoContentHash,
  videoItemId,
  videoTitleFromPath,
} from "@base/core-ts";
import { blobId } from "@base/protocol-ts";
import { ensureLessonChild, SubmittedContainerError } from "../importer/container";
import { openStore, type Store } from "../store/store";
import { parseFlags } from "./flags";

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** VideoOptions（video.go:20-29）。 */
export interface VideoOptions {
  path: string;
  slug: string;
  course: string;
  lesson: string;
  title: string;
  mime: string;
  /** 秒；0 = 未知。 */
  duration: number;
}

/** VideoResult（video.go:31-39）。 */
export interface VideoResult {
  itemId: string;
  chunks: number;
  totalSize: number;
  written: number;
  contentHash: string;
  /** 投稿域课时容器被跳过等非致命提示（CLI 不打印，对齐 importvideo.go）。 */
  warnings: string[];
}

/**
 * ImportVideo（video.go:44-127）：按定长 1 MiB 顺序分块入库。
 * 失败语义：任一块写盘失败即抛错，已写入的块与登记保留、不回滚。
 */
export function importVideo(store: Store, opt: VideoOptions): VideoResult {
  if (opt.path.trim() === "" || opt.slug.trim() === "") {
    throw new Error("importer: -file 与 -slug 都是必填");
  }
  if (opt.course.trim() === "" || opt.lesson.trim() === "") {
    throw new Error("importer: -course 与 -lesson 都是必填（无顶层 video 命名空间）");
  }

  let fd: number;
  try {
    fd = openSync(opt.path, "r");
  } catch (err) {
    throw new Error(`importer: 打开视频: ${msg(err)}`);
  }
  try {
    let size: number;
    try {
      size = fstatSync(fd).size;
    } catch (err) {
      throw new Error(`importer: stat 视频: ${msg(err)}`);
    }
    if (size === 0) {
      throw new Error("importer: 视频为空（0 字节），分块后没有任何块文件，无法导出");
    }

    const itemId = videoItemId(opt.course, opt.lesson, opt.slug);
    const res: VideoResult = { itemId, chunks: 0, totalSize: size, written: 0, contentHash: "", warnings: [] };
    const hashes: string[] = [];
    const buf = Buffer.alloc(VIDEO_CHUNK_SIZE); // 复用缓冲：不把整个文件读进内存
    for (let seq = 0; ; seq++) {
      // 镜像 io.ReadFull(f, buf)：读满一块或读到 EOF（末块可短）。
      let n = 0;
      let hitEOF = false;
      while (n < buf.length) {
        let r: number;
        try {
          r = readSync(fd, buf, n, buf.length - n, null);
        } catch (err) {
          throw new Error(`importer: 读视频: ${msg(err)}`);
        }
        if (r === 0) {
          hitEOF = true;
          break;
        }
        n += r;
      }
      if (n > 0) {
        const data = buf.subarray(0, n);
        const id = blobId(data);
        hashes.push(id);
        res.chunks++;
        let exists: boolean;
        try {
          exists = store.hasBlob(id).exists;
        } catch (err) {
          throw new Error(`importer: 探测块 ${id}: ${msg(err)}`);
        }
        if (!exists) {
          try {
            store.putBlob(id, data, itemId, seq);
          } catch (err) {
            throw new Error(`importer: 写块 ${id}(seq=${seq}): ${msg(err)}`);
          }
          res.written++;
        }
      }
      if (hitEOF) break;
    }

    res.contentHash = videoContentHash(hashes);

    let title = opt.title;
    if (title === "") title = videoTitleFromPath(opt.path);
    let mime = opt.mime;
    if (mime === "") mime = guessVideoMime(opt.path);
    try {
      store.upsertMediaItem({
        itemId,
        source: "lesson",
        type: "video",
        title,
        sourceRev: res.contentHash.slice(0, 16),
        contentHash: res.contentHash,
        mime,
        size,
        duration: opt.duration,
        chunkSize: VIDEO_CHUNK_SIZE,
        chunkHashes: hashes,
      });
    } catch (err) {
      throw new Error(`importer: 登记条目: ${msg(err)}`);
    }
    try {
      ensureLessonChild(store, opt.course, opt.lesson, itemId);
    } catch (err) {
      if (err instanceof SubmittedContainerError) {
        res.warnings.push(
          "skipped: " + `course/${opt.course}/lesson/${opt.lesson}` + " 投稿域，导入器不覆盖",
        );
      } else {
        throw new Error(`importer: 并入课时清单: ${msg(err)}`);
      }
    }
    return res;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* 关闭失败不影响已落库结果 */
    }
  }
}

/** Go flag.Int64 的十进制解析（非法 → flag 包风格的 parse error）。 */
function parseDurationFlag(raw: string): number {
  if (!/^[+-]?[0-9]+$/.test(raw)) {
    throw new Error(`invalid value "${raw}" for flag -duration: parse error`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`invalid value "${raw}" for flag -duration: parse error`);
  }
  return n;
}

export function createImportVideoCommand(): CliCommand {
  return {
    name: "import-video",
    async run(args: string[]): Promise<number> {
      const { values, rest } = parseFlags(args, [
        { name: "file", def: "" },
        { name: "slug", def: "" },
        { name: "course", def: "" },
        { name: "lesson", def: "" },
        { name: "title", def: "" },
        { name: "mime", def: "" },
        { name: "duration", def: "0" },
        { name: "data", def: process.env.BASE_DATA || "data" },
      ]);
      if (rest.length > 0) throw new Error(`未知参数 "${rest[0]}"`);

      const duration = parseDurationFlag(values["duration"]);
      const store = openStore(values["data"]);
      try {
        const res = importVideo(store, {
          path: values["file"],
          slug: values["slug"],
          course: values["course"],
          lesson: values["lesson"],
          title: values["title"],
          mime: values["mime"],
          duration,
        });
        process.stdout.write(
          `import-video: ${res.itemId} 块数=${res.chunks} 总字节=${res.totalSize} 本次写盘=${res.written} content_hash=${res.contentHash}\n`,
        );
        return 0;
      } finally {
        store.close();
      }
    },
  };
}