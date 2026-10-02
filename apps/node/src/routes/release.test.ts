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
import { defaultStoreKeyPath } from "../host/storekey";
import { startServer } from "../serve";

const RELEASE_BYTES = Buffer.from(
  `{"schema_version":1,"issuer":"base-node-1","version_name":"0.2.0"}\n`,
  "utf8",
);

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

function adapters(): ServerAdapters {
  return {
    http: createHttpServerAdapter(),
    tls: createTlsAdapter(),
    scheduler: createSchedulerAdapter(),
    cli: createCliHost(),
    lifecycle: createLifecycleAdapter(),
  };
}

let dir: string;
let withFileDir: string;
let emptyDir: string;
let db: Db;
let withFile: Listener;
let without: Listener;
let baseWith: string;
let baseWithout: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "base-node-release-"));
  db = openDb(join(dir, "base.db"));

  withFileDir = join(dir, "with");
  emptyDir = join(dir, "empty");
  mkdirSync(withFileDir, { recursive: true });
  mkdirSync(emptyDir, { recursive: true });
  writeFileSync(join(withFileDir, "release.json"), RELEASE_BYTES);

  withFile = await startServer(adapters(), db, {
    host: "127.0.0.1",
    port: 0,
    dataDir: withFileDir,
  });
  without = await startServer(adapters(), db, { host: "127.0.0.1", port: 0, dataDir: emptyDir });
  baseWith = `http://${withFile.addr()}`;
  baseWithout = `http://${without.addr()}`;
});

afterAll(async () => {
  await withFile.close();
  await without.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(defaultStoreKeyPath(withFileDir), { force: true });
  rmSync(defaultStoreKeyPath(emptyDir), { force: true });
});

describe("GET /v1/release", () => {
  it("成功：原文 + no-cache + 精确 Content-Length", async () => {
    const res = await request(`${baseWith}/v1/release`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["content-length"]).toBe(String(RELEASE_BYTES.byteLength));
    expect(res.body.equals(RELEASE_BYTES)).toBe(true);
  });

  it("文件不存在 → 404", async () => {
    const res = await request(`${baseWithout}/v1/release`);
    expect(res.status).toBe(404);
    expect(res.body.toString("utf8")).toBe(`{"error":"本节点无升级信息"}\n`);
  });
});
