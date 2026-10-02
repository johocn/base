import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Listener, ServerAdapters } from "@base/core-ts";
import { blobId, seal } from "@base/protocol-ts";
import { openDb, type Db } from "../db";
import { createHttpServerAdapter } from "../host/http";
import { createTlsAdapter } from "../host/tls";
import { createSchedulerAdapter } from "../host/scheduler";
import { createCliHost } from "../host/cli";
import { createLifecycleAdapter } from "../host/lifecycle";
import { defaultStoreKeyPath, parseStoreKey } from "../host/storekey";
import { startServer } from "../serve";

const BLOBS_DDL = `CREATE TABLE blobs(
	blob_id    TEXT PRIMARY KEY,
	size       INTEGER NOT NULL,
	item_id    TEXT NOT NULL DEFAULT '',
	seq        INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT ''
)`;

const KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PLAIN = Buffer.from("\x89PNG\r\n\x1a\nCOVERBYTES", "latin1");
const BLOB_ID = blobId(new Uint8Array(PLAIN));
const UNKNOWN_ID = "22222222222222222222222222222222";
// 文件存在但内容哈希 ≠ 请求 id：写入任意合法密文即可触发 500。
const MISMATCH_ID = "00000000000000000000000000000000";
// 仅在 blobs 表登记、磁盘无文件。
const ROW_ONLY_ID = "33333333333333333333333333333333";

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(url: string, method = "GET", headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
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

function blobPath(dataDir: string, id: string): string {
  return join(dataDir, "blobs", id.slice(0, 2), id.slice(2, 4), id);
}

let dir: string;
let db: Db;
let listener: Listener;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "base-node-blob-"));
  // 预置密钥文件：serve.ts 启动时按 `<dataDir>.key` 读取，与本测试加密所用密钥同源。
  const key = parseStoreKey(KEY_HEX);
  writeFileSync(defaultStoreKeyPath(dir), KEY_HEX + "\n", { mode: 0o600 });

  db = openDb(join(dir, "base.db"));
  db.execute(BLOBS_DDL);
  db.execute(`INSERT INTO blobs(blob_id,size,item_id,seq,created_at) VALUES(?,?,?,?,?)`, [
    BLOB_ID,
    PLAIN.byteLength,
    "item",
    0,
    "2024-01-01T00:00:00Z",
  ]);
  db.execute(`INSERT INTO blobs(blob_id,size,item_id,seq,created_at) VALUES(?,?,?,?,?)`, [
    ROW_ONLY_ID,
    7,
    "item",
    0,
    "2024-01-01T00:00:00Z",
  ]);

  const real = blobPath(dir, BLOB_ID);
  mkdirSync(join(dir, "blobs", BLOB_ID.slice(0, 2), BLOB_ID.slice(2, 4)), { recursive: true });
  writeFileSync(real, Buffer.from(seal(key, new Uint8Array(PLAIN))));

  const mism = blobPath(dir, MISMATCH_ID);
  mkdirSync(join(dir, "blobs", MISMATCH_ID.slice(0, 2), MISMATCH_ID.slice(2, 4)), {
    recursive: true,
  });
  writeFileSync(mism, Buffer.from(seal(key, new Uint8Array(PLAIN))));

  const adapters: ServerAdapters = {
    http: createHttpServerAdapter(),
    tls: createTlsAdapter(),
    scheduler: createSchedulerAdapter(),
    cli: createCliHost(),
    lifecycle: createLifecycleAdapter(),
  };
  listener = await startServer(adapters, db, { host: "127.0.0.1", port: 0, dataDir: dir });
  base = `http://${listener.addr()}`;
});

afterAll(async () => {
  await listener.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(defaultStoreKeyPath(dir), { force: true });
});

describe("GET /v1/blob/{blob_id}", () => {
  it("成功：解密后原文 + ETag + immutable", async () => {
    const res = await request(`${base}/v1/blob/${BLOB_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers["etag"]).toBe(`"${BLOB_ID}"`);
    expect(res.headers["content-length"]).toBe(String(PLAIN.byteLength));
    expect(res.body.equals(PLAIN)).toBe(true);
  });

  it("If-None-Match 命中 → 304 无 body", async () => {
    const res = await request(`${base}/v1/blob/${BLOB_ID}`, "GET", {
      "If-None-Match": `"${BLOB_ID}"`,
    });
    expect(res.status).toBe(304);
    expect(res.headers["etag"]).toBe(`"${BLOB_ID}"`);
    expect(res.headers["content-length"]).toBeUndefined();
    expect(res.body.byteLength).toBe(0);
  });

  it("非法 blob_id → 400", async () => {
    const res = await request(`${base}/v1/blob/XX`);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"非法 blob_id"}\n`);
  });

  it("文件不存在 → 404", async () => {
    const res = await request(`${base}/v1/blob/${UNKNOWN_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.toString("utf8")).toBe(`{"error":"块不存在"}\n`);
  });

  it("内容与哈希不符 → 500", async () => {
    const res = await request(`${base}/v1/blob/${MISMATCH_ID}`);
    expect(res.status).toBe(500);
    expect(res.body.toString("utf8")).toBe(`{"error":"块内容与哈希不符"}\n`);
  });
});

describe("HEAD /v1/blob/{blob_id}", () => {
  it("成功：Content-Length 取明文大小，无 body", async () => {
    const res = await request(`${base}/v1/blob/${BLOB_ID}`, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers["etag"]).toBe(`"${BLOB_ID}"`);
    expect(res.headers["content-length"]).toBe(String(PLAIN.byteLength));
    expect(res.body.byteLength).toBe(0);
  });

  it("非法 blob_id → 400", async () => {
    const res = await request(`${base}/v1/blob/XX`, "HEAD");
    expect(res.status).toBe(400);
    expect(res.body.byteLength).toBe(0);
  });

  it("无登记行 → 404", async () => {
    const res = await request(`${base}/v1/blob/${UNKNOWN_ID}`, "HEAD");
    expect(res.status).toBe(404);
  });

  it("有登记行但文件不存在 → 404", async () => {
    const res = await request(`${base}/v1/blob/${ROW_ONLY_ID}`, "HEAD");
    expect(res.status).toBe(404);
  });
});
