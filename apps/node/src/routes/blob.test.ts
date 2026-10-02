import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Listener, ServerAdapters, ServerRequest, ServerResponse } from "@base/core-ts";
import { blobId, seal } from "@base/protocol-ts";
import { MAX_BLOB_BYTES, blobPostHandler } from "./blob";
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

// POST /v1/blob 直接调用 handler（serve.ts 的路由装配由上层统一做）。
// 本层只验 multipart 解析 + store.PutBlob，故不经 HTTP/签名中间件。
const POST_STORE_KEY = parseStoreKey(KEY_HEX);
const BAD_MULTIPART = `{"code":"bad_multipart","error":"请求必须是 multipart/form-data，且含字段 file"}\n`;

function postReq(body: Uint8Array, contentType: string | undefined): ServerRequest {
  const headers: Record<string, string> = {};
  if (contentType !== undefined) headers["content-type"] = contentType;
  return { method: "POST", path: "/v1/blob", params: {}, query: {}, headers, body };
}

function postHandler() {
  return blobPostHandler({ db, dataDir: dir, storeKey: POST_STORE_KEY });
}

function multipartBody(
  boundary: string,
  parts: { name: string; filename?: string; extra?: string; data: Uint8Array }[],
): Uint8Array {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let cd = `form-data; name="${p.name}"`;
    if (p.filename !== undefined) cd += `; filename="${p.filename}"`;
    let head = `--${boundary}\r\nContent-Disposition: ${cd}\r\n`;
    if (p.extra !== undefined) head += `${p.extra}\r\n`;
    head += "\r\n";
    chunks.push(Buffer.from(head, "utf8"));
    chunks.push(Buffer.from(p.data));
    chunks.push(Buffer.from("\r\n", "latin1"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}

function bodyText(res: ServerResponse): string {
  return Buffer.from(res.body ?? new Uint8Array(0)).toString("utf8");
}

describe("POST /v1/blob", () => {
  it("合法单块（含 0x00/0xFF）→ 200，blob_id/size 正确，行存在，密文 = 明文+28", async () => {
    const data = new Uint8Array([0x00, 0x01, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x7f]);
    const boundary = "----baseBoundary01";
    const body = multipartBody(boundary, [{ name: "file", data }]);

    const res = await postHandler()(postReq(body, `multipart/form-data; boundary=${boundary}`), "");
    const id = blobId(data);
    expect(res.status).toBe(200);
    expect(bodyText(res)).toBe(`{"blob_id":"${id}","size":${data.byteLength}}\n`);

    const rows = db.select(`SELECT size,item_id,seq FROM blobs WHERE blob_id=?`, [id]);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].size)).toBe(data.byteLength);
    expect(rows[0].item_id).toBe("");
    expect(Number(rows[0].seq)).toBe(0);
    // 落盘是密文：nonce(12) + 明文 + tag(16)。
    expect(statSync(blobPath(dir, id)).size).toBe(data.byteLength + 28);
  });

  it("同内容重复上传幂等 → 同一 blob_id、同一响应", async () => {
    const data = new Uint8Array(Buffer.from("idempotent-bytes-1234567890"));
    const boundary = "----baseBoundary02";
    const body = multipartBody(boundary, [{ name: "file", data }]);
    const ct = `multipart/form-data; boundary=${boundary}`;

    const r1 = await postHandler()(postReq(body, ct), "");
    const r2 = await postHandler()(postReq(body, ct), "");
    const id = blobId(data);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(bodyText(r1)).toBe(`{"blob_id":"${id}","size":${data.byteLength}}\n`);
    expect(bodyText(r2)).toBe(bodyText(r1));
    expect(db.select(`SELECT 1 FROM blobs WHERE blob_id=?`, [id]).length).toBe(1);
  });

  it("字段名不是 file（name=\"other\"）→ 400 bad_multipart", async () => {
    const boundary = "----baseBoundary03";
    const body = multipartBody(boundary, [{ name: "other", data: new Uint8Array([1, 2, 3]) }]);
    const res = await postHandler()(postReq(body, `multipart/form-data; boundary=${boundary}`), "");
    expect(res.status).toBe(400);
    expect(bodyText(res)).toBe(BAD_MULTIPART);
  });

  it("file 分片为空（0 字节）→ 400 bad_multipart", async () => {
    const boundary = "----baseBoundary04";
    const body = multipartBody(boundary, [{ name: "file", data: new Uint8Array(0) }]);
    const res = await postHandler()(postReq(body, `multipart/form-data; boundary=${boundary}`), "");
    expect(res.status).toBe(400);
    expect(bodyText(res)).toBe(BAD_MULTIPART);
  });

  it("完全没有 file 分片 → 400 bad_multipart", async () => {
    const boundary = "----baseBoundary05";
    const body = multipartBody(boundary, [{ name: "a", data: new Uint8Array([1]) }]);
    const res = await postHandler()(postReq(body, `multipart/form-data; boundary=${boundary}`), "");
    expect(res.status).toBe(400);
    expect(bodyText(res)).toBe(BAD_MULTIPART);
  });

  it("完全不是 multipart（application/json）→ 400", async () => {
    const body = new Uint8Array(Buffer.from(`{"hello":"world"}`, "utf8"));
    const res = await postHandler()(postReq(body, "application/json"), "");
    expect(res.status).toBe(400);
    expect(bodyText(res)).toBe(BAD_MULTIPART);
  });

  it("缺 Content-Type → 400", async () => {
    const res = await postHandler()(postReq(new Uint8Array([1, 2, 3]), undefined), "");
    expect(res.status).toBe(400);
    expect(bodyText(res)).toBe(BAD_MULTIPART);
  });

  it("缺 boundary 参数 → 400", async () => {
    const boundary = "----baseBoundary07";
    const body = multipartBody(boundary, [{ name: "file", data: new Uint8Array([9]) }]);
    const res = await postHandler()(postReq(body, "multipart/form-data"), "");
    expect(res.status).toBe(400);
    expect(bodyText(res)).toBe(BAD_MULTIPART);
  });

  it("非 ASCII 文件名不影响结果 → 200", async () => {
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00]);
    const boundary = "----baseBoundary08";
    const body = multipartBody(boundary, [{ name: "file", filename: "封面 ünïcode.png", data }]);
    const res = await postHandler()(postReq(body, `multipart/form-data; boundary=${boundary}`), "");
    const id = blobId(data);
    expect(res.status).toBe(200);
    expect(bodyText(res)).toBe(`{"blob_id":"${id}","size":${data.byteLength}}\n`);
  });

  it("两个 file 分片只取第一个 → 200 且为第一块", async () => {
    const first = new Uint8Array([10, 20, 30]);
    const second = new Uint8Array([40, 50, 60, 70]);
    const boundary = "----baseBoundary09";
    const body = multipartBody(boundary, [
      { name: "file", data: first },
      { name: "file", data: second },
    ]);
    const res = await postHandler()(postReq(body, `multipart/form-data; boundary=${boundary}`), "");
    const id = blobId(first);
    expect(res.status).toBe(200);
    expect(bodyText(res)).toBe(`{"blob_id":"${id}","size":${first.byteLength}}\n`);
    expect(statSync(blobPath(dir, id)).size).toBe(first.byteLength + 28);
  });

  it("超过 8 MiB → 413 blob_too_large", async () => {
    const big = new Uint8Array(MAX_BLOB_BYTES + 1);
    const boundary = "----baseBoundary10";
    const body = multipartBody(boundary, [{ name: "file", data: big }]);
    const res = await postHandler()(postReq(body, `multipart/form-data; boundary=${boundary}`), "");
    expect(res.status).toBe(413);
    expect(bodyText(res)).toBe(`{"code":"blob_too_large","error":"上传块超过 8 MiB"}\n`);
  });

  it("CTE=quoted-printable → 分片体透明解码后再算 blob_id", async () => {
    // `=48=65=6C=6C=6F=20=77=6F=72=6C=64=0A` → "Hello world\n"
    const enc = new Uint8Array(Buffer.from("=48=65=6C=6C=6F=20=77=6F=72=6C=64=0A", "latin1"));
    const decoded = new Uint8Array(Buffer.from("Hello world\n", "latin1"));
    const boundary = "----baseBoundary11";
    const body = multipartBody(boundary, [
      { name: "file", extra: "Content-Transfer-Encoding: quoted-printable", data: enc },
    ]);
    const res = await postHandler()(postReq(body, `multipart/form-data; boundary=${boundary}`), "");
    const id = blobId(decoded);
    expect(res.status).toBe(200);
    expect(bodyText(res)).toBe(`{"blob_id":"${id}","size":${decoded.byteLength}}\n`);
    expect(statSync(blobPath(dir, id)).size).toBe(decoded.byteLength + 28);
  });

  it("CTE 值大小写不敏感（Quoted-Printable）且软换行拼接", async () => {
    // `abc=\r\ndef` → "abcdef"（软换行 '=' 后 CRLF 被吞）
    const enc = new Uint8Array(Buffer.from("abc=\r\ndef", "latin1"));
    const decoded = new Uint8Array(Buffer.from("abcdef", "latin1"));
    const boundary = "----baseBoundary12";
    const body = multipartBody(boundary, [
      { name: "file", extra: "content-transfer-encoding: Quoted-Printable", data: enc },
    ]);
    const res = await postHandler()(postReq(body, `multipart/form-data; boundary=${boundary}`), "");
    const id = blobId(decoded);
    expect(res.status).toBe(200);
    expect(bodyText(res)).toBe(`{"blob_id":"${id}","size":${decoded.byteLength}}\n`);
  });

  it("CTE=quoted-printable 但分片体非法（孤立 '=' 结尾）→ 400 bad_multipart", async () => {
    const boundary = "----baseBoundary13";
    const body = multipartBody(boundary, [
      {
        name: "file",
        extra: "Content-Transfer-Encoding: quoted-printable",
        data: new Uint8Array(Buffer.from("=", "latin1")),
      },
    ]);
    const res = await postHandler()(postReq(body, `multipart/form-data; boundary=${boundary}`), "");
    expect(res.status).toBe(400);
    expect(bodyText(res)).toBe(BAD_MULTIPART);
  });

  it("头行以 ':' 开头（空键名）→ 400 bad_multipart", async () => {
    const boundary = "----baseBoundary14";
    const body = multipartBody(boundary, [
      { name: "file", extra: ": novalue", data: new Uint8Array([1, 2, 3]) },
    ]);
    const res = await postHandler()(postReq(body, `multipart/form-data; boundary=${boundary}`), "");
    expect(res.status).toBe(400);
    expect(bodyText(res)).toBe(BAD_MULTIPART);
  });
});
