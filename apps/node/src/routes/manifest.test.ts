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

const MANIFEST_BYTES = Buffer.from(
  `{"pack_id":"${PACK_ID}","merkle_root":"aa","issuer":"base-node-1"}\n`,
  "utf8",
);

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(url: string, method = "GET"): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on("error", reject);
    req.end();
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
  dir = mkdtempSync(join(tmpdir(), "base-node-manifest-"));
  db = openDb(join(dir, "base.db"));
  db.execute(PACKS_DDL);

  const packDir = join(dir, "packs", PACK_ID);
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, "manifest.json"), MANIFEST_BYTES);
  insertPack(PACK_ID, packDir);

  // 已登记但 manifest.json 不存在的包。
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

describe("GET /v1/manifest/{pack_id}", () => {
  it("成功：原文 + no-cache + 精确 Content-Length", async () => {
    const res = await request(`${base}/v1/manifest/${PACK_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["content-length"]).toBe(String(MANIFEST_BYTES.byteLength));
    expect(res.body.equals(MANIFEST_BYTES)).toBe(true);
  });

  it("非法 pack_id → 400", async () => {
    const res = await request(`${base}/v1/manifest/not-a-pack-id`);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"非法 pack_id"}\n`);
  });

  it("未登记 → 404 包未登记", async () => {
    const res = await request(`${base}/v1/manifest/${UNKNOWN_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.toString("utf8")).toBe(`{"error":"包未登记"}\n`);
  });

  it("已登记但文件缺失 → 404 manifest 文件不存在", async () => {
    const res = await request(`${base}/v1/manifest/${MISSING_PACK_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.toString("utf8")).toBe(`{"error":"manifest 文件不存在"}\n`);
  });

  it("OPTIONS 预检 → 204 无 body + CORS 头（未命中路径同样 204）", async () => {
    for (const path of [`/v1/manifest/${PACK_ID}`, "/nope"]) {
      const res = await request(`${base}${path}`, "OPTIONS");
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(res.headers["access-control-allow-methods"]).toBe("GET, HEAD, POST, PUT, OPTIONS");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-length"]).toBeUndefined();
      expect(res.body.byteLength).toBe(0);
    }
  });
});
