// store 数据层跨实现取证：Go 写 → Node 读；Node 写 → Go 读。
// 仅在 based.exe 存在时运行；不触碰仓库内 `.tmp/`（全部在系统临时目录里作业）。
//
// 驱动限制：node-sqlite3-wasm（WASM VFS 无 xShmMap）**无法打开 WAL 库**，报
// SQLite3Error: unable to open database file；Go/modernc 建的 base.db 是 WAL（头字节 18/19 = 2,2）。
// 由 `normalizeJournalMode` 在打开前把主库头改回 rollback（1,1）——Go 进程已干净退出、
// 主库完整且无 `-wal` 残留，数据页未被触碰；仓库内 `.tmp/p3probe` 全程只被复制、从未被打开或写入。
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  articleFromRow,
  quizFromRow,
  segmentFromRow,
  type StoreArticle,
  type StoreItem,
} from "@base/core-ts";
import { normalizeJournalMode, openHostDb } from "../host/sqlite";
import { openStore, storeKeyStatus } from "./store";

const BASED_EXE = fileURLToPath(new URL("../../../../based.exe", import.meta.url));
const P3_PROBE = fileURLToPath(new URL("../../../../.tmp/p3probe", import.meta.url));
const P3_PROBE_DB = join(P3_PROBE, "base.db");
const KEY = "1".repeat(64);
const ISSUED_AT = "2026-01-01T00:00:00Z";

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "base-store-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop() as string;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄释放竞态，忽略即可 */
    }
  }
});

/** 只读打开数据目录（openStore 内部会先归一 journal-mode 头字节）。 */
function openReadOnlyStore(dataDir: string): ReturnType<typeof openStore> {
  return openStore(dataDir, { readOnly: true });
}

function runExport(dataDir: string): { packId: string; merkleRoot: string; stdout: string } {
  const res = spawnSync(
    BASED_EXE,
    ["export", "-sign-key", KEY, "-issuer", "probe", "-issued-at", ISSUED_AT, "-data", dataDir],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`based.exe export 失败: ${res.stdout}\n${res.stderr}`);
  return {
    packId: /pack_id=(\S+)/.exec(res.stdout)?.[1] ?? "",
    merkleRoot: /merkle_root=(\S+)/.exec(res.stdout)?.[1] ?? "",
    stdout: res.stdout,
  };
}

function byItemId<T extends { itemId: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
}

describe.skipIf(!existsSync(BASED_EXE))("跨实现取证（based.exe）", () => {
  it.skipIf(!existsSync(P3_PROBE_DB))(
    "方向 A：Go 写 → Node 只读读，逐表与 pack.sqlite 逐行相同",
    () => {
      const dir = tmpDir();
      cpSync(P3_PROBE_DB, join(dir, "base.db"));
      cpSync(`${P3_PROBE}.key`, `${dir}.key`);

      // 打开即完成 WAL→rollback 归一化（openStore 内部做），随后跑一次 rw Open：
      // 对齐 Go `store.Open`（打开时同样会补全 schema 与列迁移）。
      openStore(dir).close();

      const { packId, merkleRoot, stdout } = runExport(dir);
      expect(packId).not.toBe("");
      const packDir = join(dir, "packs", packId);
      const manifest = JSON.parse(readFileSync(join(packDir, "manifest.json"), "utf8")) as {
        entries: { item_id: string; content_hash: string }[];
      };

      const store = openReadOnlyStore(dir);
      const pack = openHostDb(join(packDir, "pack.sqlite"), { readOnly: true });
      try {
        const items: StoreItem[] = store.listItems("active");

        // articles：全 8 列（含解密后的 body_md）逐行相同
        const packArticles = pack
          .all(
            "SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev FROM articles ORDER BY item_id ASC",
          )
          .map((r) => articleFromRow(r));
        expect(byItemId(Object.values(store.listArticles()))).toEqual(packArticles);

        // quizzes 逐行相同
        const packQuizzes = pack
          .all("SELECT item_id,question_json,content_hash FROM quizzes ORDER BY item_id ASC")
          .map((r) => quizFromRow(r));
        expect(byItemId(Object.values(store.listQuizzes()))).toEqual(packQuizzes);

        // segments 逐行相同（ORDER BY item_id, seq）
        const packSegs = pack
          .all("SELECT item_id,seq,kind,text,content_hash FROM segments ORDER BY item_id ASC, seq ASC")
          .map((r) => segmentFromRow(r));
        const nodeSegs = items
          .filter((it) => it.sqliteTable === "segments")
          .flatMap((it) => store.listSegments(it.itemId));
        expect(nodeSegs).toEqual(packSegs);

        // media_meta 逐行相同（chunk_hashes_json 逐位）
        const packMedia = pack.all(
          "SELECT item_id,mime,size,duration,chunk_size,chunk_hashes_json FROM media_meta ORDER BY item_id ASC",
        );
        const mediaItems = items.filter((it) => it.sqliteTable === "media_meta");
        expect(mediaItems.length).toBe(packMedia.length);
        for (const it of mediaItems) {
          const meta = store.getMediaMeta(it.itemId);
          expect(meta).not.toBeNull();
          const row = packMedia.find((r) => String(r.item_id) === it.itemId);
          expect(row).toBeDefined();
          expect(row?.mime).toBe(meta?.mime);
          expect(row?.size).toBe(meta?.size);
          expect(row?.duration).toBe(meta?.duration);
          expect(row?.chunk_size).toBe(meta?.chunkSize);
          expect(JSON.parse(String(row?.chunk_hashes_json))).toEqual(meta?.chunkHashes);
        }

        // 3 条 seed 条目的目录断言
        expect(items.length).toBeGreaterThanOrEqual(3);
        const byId = new Map(manifest.entries.map((e) => [e.item_id, e]));
        for (const it of items) {
          expect(it.sqliteTable).toBe("articles");
          expect(it.distClass).toBe("public");
          expect(it.state).toBe("active");
          expect(it.updatedAt).not.toBe("");
          expect(byId.get(it.itemId)?.content_hash).toBe(it.contentHash);
        }

        const identities = store.lookupIdentities([]);
        const tombstones = store.listTombstones();
        expect(tombstones.length).toBe(0);

        // DDL 逐字：Node 建表语句进 sqlite_master 的文本必须与 Go pack.sqlite 的同名表完全相同
        const raw2 = openHostDb(join(dir, "base.db"), { readOnly: true });
        try {
          for (const t of ["meta", "articles", "segments", "quizzes", "media_meta"]) {
            const nodeSql = String(
              raw2.get("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [t])?.sql,
            );
            const packSql = String(
              pack.get("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [t])?.sql,
            );
            expect(nodeSql).toBe(packSql);
          }
        } finally {
          raw2.close();
        }

        console.log(
          `[A] ${stdout.trim()}\n[A] items=${items.length} packArticles=${packArticles.length} ` +
            `packQuizzes=${packQuizzes.length} packSegments=${packSegs.length} packMedia=${packMedia.length} ` +
            `identities=${Object.keys(identities).length} tombstones=${tombstones.length} ` +
            `declaredChunks(media 条目)=${mediaItems.length} merkle=${merkleRoot}`,
        );
      } finally {
        pack.close();
        store.close();
      }
    },
  );

  it("方向 B：Node 写 → Go 读回，body_md 逐字相同", () => {
    const dir = tmpDir();
    const body = `第一行 '单引号' 与 "双引号"\n第二行：中文正文，含标点。；\n第三行 end`;
    const store = openStore(dir);
    const article: StoreArticle = {
      itemId: "article/node-probe",
      title: "Node 探针",
      digest: "",
      publishedAt: "",
      tagsJson: "[]",
      bodyMd: body,
      contentHash: "deadbeefdeadbeefdeadbeefdeadbeef",
      sourceRev: "",
      updatedAt: "",
    };
    store.upsertArticle(article);
    store.close();

    // 追加一条 media 声明块，供 declaredChunks 跨实现取证
    const mediaId = "media/node-probe";
    const chunk64 = "ab12cd34".repeat(8); // 64 位 hex（需归一为 32）
    const raw = openHostDb(join(dir, "base.db"));
    raw.run(
      `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
				VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [mediaId, "video", "video", "M", "", "mh", "media_meta", "public", "active", "", "", ""],
    );
    raw.run(
      `INSERT INTO media_meta(item_id,mime,size,duration,chunk_size,chunk_hashes_json) VALUES(?,?,?,?,?,?)`,
      [mediaId, "video/mp4", 1500, 0, 1024, JSON.stringify([chunk64, chunk64])],
    );
    raw.close();

    // Go 能打开 Node 建的库并导出成功；读回 articles.body_md
    const { packId } = runExport(dir);
    const packDir = join(dir, "packs", packId);
    const pack = openHostDb(join(packDir, "pack.sqlite"), { readOnly: true });
    try {
      const row = pack.get("SELECT body_md FROM articles WHERE item_id=?", ["article/node-probe"]);
      expect(row).toBeDefined();
      expect(String(row?.body_md)).toBe(body);
    } finally {
      pack.close();
    }

    // declaredChunks：64→32 归一 + 末块截断
    const store2 = openReadOnlyStore(dir);
    try {
      const chunks = store2.declaredChunks(mediaId);
      console.log(`[B] pack_id=${packId} declaredChunks=${JSON.stringify(chunks)}`);
      expect(chunks).toEqual([
        { blobId: chunk64.slice(0, 32), seq: 0, size: 1024 },
        { blobId: chunk64.slice(0, 32), seq: 1, size: 476 },
      ]);
    } finally {
      store2.close();
    }
  });

  it("storeKeyStatus 只读、不创建文件", () => {
    const dir = tmpDir();
    const status = storeKeyStatus(dir);
    expect(status.exists).toBe(false);
    expect(status.path).toBe(`${dir}.key`);
    expect(existsSync(status.path)).toBe(false);
  });
});

describe("normalizeJournalMode：WAL → rollback 头归一化", () => {
  function writeDbHeader(dir: string, bytes18: number, bytes19: number): string {
    const p = join(dir, "base.db");
    const buf = Buffer.alloc(4096, 0);
    buf.write("SQLite format 3\0", 0, "binary");
    buf[16] = 0x10;
    buf[17] = 0x00;
    buf[18] = bytes18;
    buf[19] = bytes19;
    writeFileSync(p, buf);
    return p;
  }

  it("WAL 头 (2,2) 且无 -wal/-shm ⇒ 改为 (1,1)，幂等", () => {
    const dir = tmpDir();
    const p = writeDbHeader(dir, 2, 2);
    normalizeJournalMode(p);
    expect([readFileSync(p)[18], readFileSync(p)[19]]).toEqual([1, 1]);
    normalizeJournalMode(p);
    expect([readFileSync(p)[18], readFileSync(p)[19]]).toEqual([1, 1]);
    expect(existsSync(`${p}-wal`)).toBe(false);
  });

  it("已是 rollback 头 (1,1) ⇒ 不变", () => {
    const dir = tmpDir();
    const p = writeDbHeader(dir, 1, 1);
    normalizeJournalMode(p);
    expect([readFileSync(p)[18], readFileSync(p)[19]]).toEqual([1, 1]);
  });

  it("残留 -wal / -shm ⇒ 拒绝打开（主库不完整）", () => {
    const dir = tmpDir();
    const p = writeDbHeader(dir, 2, 2);
    writeFileSync(`${p}-wal`, "");
    expect(() => normalizeJournalMode(p)).toThrowError(/残留/);
    rmSync(`${p}-wal`);
    writeFileSync(`${p}-shm`, "");
    expect(() => normalizeJournalMode(p)).toThrowError(/残留/);
  });

  it("库文件不存在 ⇒ 直接返回（交给驱动创建）", () => {
    const dir = tmpDir();
    expect(() => normalizeJournalMode(join(dir, "base.db"))).not.toThrow();
  });
});
