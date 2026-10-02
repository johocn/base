import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Listener, ServerAdapters } from "@base/core-ts";
import { openDb, type Db } from "../db";
import { createHttpServerAdapter } from "../host/http";
import { createTlsAdapter } from "../host/tls";
import { createSchedulerAdapter } from "../host/scheduler";
import { createCliHost } from "../host/cli";
import { createLifecycleAdapter } from "../host/lifecycle";
import { startServer } from "../serve";

const PACKS_DDL = `CREATE TABLE packs(
	pack_id         TEXT PRIMARY KEY,
	content_version INTEGER NOT NULL,
	dir             TEXT NOT NULL,
	merkle_root     TEXT NOT NULL,
	signature       TEXT NOT NULL,
	issued_at       TEXT NOT NULL,
	item_count      INTEGER NOT NULL,
	created_at      TEXT NOT NULL
)`;

const PACK_ID = "0123456789abcdef0123456789abcdef";
const MISSING_PACK_ID = "fedcba9876543210fedcba9876543210";
const UNKNOWN_ID = "11111111111111111111111111111111";

// 任意二进制产物（含非 UTF-8 字节，验证按字节原样返回）。
const PACK_BYTES = Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x00, 0xff, 0x10]);

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(url: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      })
      .on("error", reject);
  });
}

function insertPack(id: string, packDir: string): void {
  db.execute(
    `INSERT INTO packs(pack_id,content_version,dir,merkle_root,signature,issued_at,item_count,created_at)
			VALUES(?,?,?,?,?,?,?,?)`,
    [id, 1, packDir, "root", "sig", "2024-01-01T00:00:00Z", 1, "2024-01-01T00:00:00Z"],
  );
}

let dir: string;
let db: Db;
let listener: Listener;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "base-node-pack-"));
  db = openDb(join(dir, "base.db"));
  db.execute(PACKS_DDL);

  const packDir = join(dir, "packs", PACK_ID);
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, "pack.sqlite"), PACK_BYTES);
  insertPack(PACK_ID, packDir);

  const emptyDir = join(dir, "packs", MISSING_PACK_ID);
  mkdirSync(emptyDir, { recursive: true });
  insertPack(MISSING_PACK_ID, emptyDir);

  const adapters: ServerAdapters = {
    http: createHttpServerAdapter(),
    tls: createTlsAdapter(),
    scheduler: createSchedulerAdapter(),
    cli: createCliHost(),
    lifecycle: createLifecycleAdapter(),
  };
  listener = await startServer(adapters, db, { host: "127.0.0.1", port: 0 });
  base = `http://${listener.addr()}`;
});

afterAll(async () => {
  await listener.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /v1/pack/{pack_id}", () => {
  it("成功：immutable + vnd.sqlite3 + 精确字节", async () => {
    const res = await request(`${base}/v1/pack/${PACK_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.sqlite3");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers["content-length"]).toBe(String(PACK_BYTES.byteLength));
    expect(res.body.equals(PACK_BYTES)).toBe(true);
  });

  it("非法 pack_id → 400", async () => {
    const res = await request(`${base}/v1/pack/not-a-pack-id`);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"非法 pack_id"}\n`);
  });

  it("未登记 → 404 包未登记", async () => {
    const res = await request(`${base}/v1/pack/${UNKNOWN_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.toString("utf8")).toBe(`{"error":"包未登记"}\n`);
  });

  it("已登记但文件缺失 → 404 pack 文件不存在", async () => {
    const res = await request(`${base}/v1/pack/${MISSING_PACK_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.toString("utf8")).toBe(`{"error":"pack 文件不存在"}\n`);
  });
});
