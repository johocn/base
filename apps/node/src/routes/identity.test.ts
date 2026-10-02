import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Listener, ServerAdapters } from "@base/core-ts";
import {
  bytesToHex,
  deriveIdentityId,
  keyPairFromSeed,
  randomBytes,
  requestSignBytes,
  sha256Hex,
  sign,
} from "@base/protocol-ts";
import { openDb, type Db } from "../db";
import { createHttpServerAdapter } from "../host/http";
import { createTlsAdapter } from "../host/tls";
import { createSchedulerAdapter } from "../host/scheduler";
import { createCliHost } from "../host/cli";
import { createLifecycleAdapter } from "../host/lifecycle";
import { startServer } from "../serve";

// identities / escrow 两表 DDL 逐字取自 store/schema.ts。
const IDENTITIES_DDL = `CREATE TABLE identities(
		id           TEXT PRIMARY KEY,
		alg          TEXT NOT NULL,
		pubkey       TEXT NOT NULL,
		created_at   INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL DEFAULT 0
	)`;
const ESCROW_DDL = `CREATE TABLE escrow(
		username    TEXT PRIMARY KEY,
		id          TEXT NOT NULL,
		alg         TEXT NOT NULL,
		salt        TEXT NOT NULL,
		kdf_json    TEXT NOT NULL,
		enc_nonce   TEXT NOT NULL,
		priv_cipher TEXT NOT NULL,
		updated_at  INTEGER NOT NULL
	)`;

// 数据面：合法 32 位小写 hex id + 一条真实形状的 escrow 记录。
const ID = "0123456789abcdef0123456789abcdef";
const PUB = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const CREATED_AT = 1700000000000; // int64 毫秒
const SALT = "cd".repeat(16);
const NONCE = "ef".repeat(12);
const PRIV = "ab".repeat(48);
const UPDATED_AT = 1700000000001;
// kdf_json 故意用**非字典序、非 kdfParams 结构序**存储：
// 只有「原样嵌入」才能逐字节还原它，重新序列化（排序键或按结构体键序）都会露馅。
const KDF_RAW = `{"p":1,"len":32,"m":65536,"t":3,"alg":"argon2id"}`;

// 批 B1：escrow PUT 的签名身份——ID 行存的 PUB 恰是 SEED 的公钥（RFC 8032 test-1）。
const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
// 登记用：REG 为全新身份；C 用于「已存在且公钥不同」的冲突分支（预置一条异公钥行）。
const REG_SEED = "00".repeat(32);
const REG_PUB = keyPairFromSeed(REG_SEED).pubHex;
const REG_ID = deriveIdentityId(REG_PUB);
const C_PUB = keyPairFromSeed("02".repeat(32)).pubHex;
const C_ID = deriveIdentityId(C_PUB);
const OTHER_PUB = "ab".repeat(32);

const NONCES_DDL = `CREATE TABLE auth_nonces(
		id      TEXT NOT NULL,
		nonce   TEXT NOT NULL,
		seen_at INTEGER NOT NULL,
		PRIMARY KEY(id, nonce)
	)`;

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
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      })
      .on("error", reject);
  });
}

function send(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Uint8Array,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    if (body !== undefined) req.write(Buffer.from(body));
    req.end();
  });
}

function jsonBody(obj: unknown): { text: string; bytes: Uint8Array } {
  const text = JSON.stringify(obj);
  return { text, bytes: new Uint8Array(Buffer.from(text, "utf8")) };
}

/** 用真私钥对 (method,path,body) 组签名头；body 为原始字节。 */
function authHeaders(
  seed: string,
  id: string,
  method: string,
  path: string,
  body: Uint8Array = new Uint8Array(0),
): Record<string, string> {
  const ts = Date.now();
  const nonce = bytesToHex(randomBytes(16));
  return {
    "Content-Type": "application/json",
    "X-Base-Id": id,
    "X-Base-Alg": "ed25519",
    "X-Base-Ts": String(ts),
    "X-Base-Nonce": nonce,
    "X-Base-Sig": sign(
      seed,
      requestSignBytes({ method, path, query: "", bodySha256: sha256Hex(body), ts, nonce }),
    ),
  };
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
let db: Db;
let listener: Listener;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "base-node-identity-"));
  db = openDb(join(dir, "base.db"));
  db.execute(IDENTITIES_DDL);
  db.execute(ESCROW_DDL);
  db.execute(NONCES_DDL);
  db.execute(
    `INSERT INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
    [ID, "ed25519", PUB, CREATED_AT, 0],
  );
  // 预置一条「同 id 异公钥」的行，供 register 冲突分支（409）用。
  db.execute(
    `INSERT INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
    [C_ID, "ed25519", OTHER_PUB, CREATED_AT, 0],
  );
  db.execute(
    `INSERT INTO escrow(username,id,alg,salt,kdf_json,enc_nonce,priv_cipher,updated_at)
			VALUES(?,?,?,?,?,?,?,?)`,
    ["alice", ID, "ed25519", SALT, KDF_RAW, NONCE, PRIV, UPDATED_AT],
  );
  listener = await startServer(adapters(), db, { host: "127.0.0.1", port: 0 });
  base = `http://${listener.addr()}`;
});

afterAll(async () => {
  await listener.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /v1/identity/{id}", () => {
  it("已登记 → 200，body 逐字节等于 Go 键序 alg/created_at/id/pubkey", async () => {
    const res = await request(`${base}/v1/identity/${ID}`);
    const body = `{"alg":"ed25519","created_at":${CREATED_AT},"id":"${ID}","pubkey":"${PUB}"}\n`;
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(res.body.toString("utf8")).toBe(body);
  });

  it("未登记（合法 hex）→ 404 identity_not_found", async () => {
    const res = await request(`${base}/v1/identity/${"a".repeat(32)}`);
    expect(res.status).toBe(404);
    expect(res.body.toString("utf8")).toBe(`{"error":"identity_not_found"}\n`);
  });

  it("非法 id（长度/字符不符）→ 400 identity_id_invalid", async () => {
    for (const bad of ["notahex", "abc", "g".repeat(32), "A".repeat(31), ""]) {
      const res = await request(`${base}/v1/identity/${encodeURIComponent(bad)}`);
      expect(res.status, `id=${JSON.stringify(bad)}`).toBe(400);
      expect(res.body.toString("utf8")).toBe(`{"error":"identity_id_invalid"}\n`);
    }
  });

  it("大写 id → 400（Go isHex32 只认小写，ToLower 对合法 id 不可达）", async () => {
    const res = await request(`${base}/v1/identity/${ID.toUpperCase()}`);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"identity_id_invalid"}\n`);
  });
});

describe("GET /v1/identity/escrow/{username}", () => {
  it("已托管 → 200，body 逐字节等于 Go 键序且 kdf 原样嵌入", async () => {
    const res = await request(`${base}/v1/identity/escrow/alice`);
    const body =
      `{"alg":"ed25519","enc_nonce":"${NONCE}","id":"${ID}","kdf":${KDF_RAW},` +
      `"priv_cipher":"${PRIV}","salt":"${SALT}","updated_at":${UPDATED_AT},"username":"alice"}\n`;
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(res.body.toString("utf8")).toBe(body);
  });

  it("未托管 → 404 escrow_not_found", async () => {
    const res = await request(`${base}/v1/identity/escrow/nobody`);
    expect(res.status).toBe(404);
    expect(res.body.toString("utf8")).toBe(`{"error":"escrow_not_found"}\n`);
  });

  it("非法 username 严格 ^[a-zA-Z0-9_]{3,32}$ → 400", async () => {
    const bads = ["a", "ab", "has space", "-lead", "has.dot", "用户名", "x".repeat(33)];
    for (const u of bads) {
      const res = await request(`${base}/v1/identity/escrow/${encodeURIComponent(u)}`);
      expect(res.status, `username=${JSON.stringify(u)}`).toBe(400);
      expect(res.body.toString("utf8")).toBe(`{"error":"escrow_username_invalid"}\n`);
    }
  });

  it("连续请求超突发（10）→ 429 rate_limited + Retry-After: 60", async () => {
    // 用**全新** server 实例拿到干净令牌桶（escrowLimiter 为独立实例，突发 10）。
    const fresh = await startServer(adapters(), db, { host: "127.0.0.1", port: 0 });
    const freshBase = `http://${fresh.addr()}`;
    try {
      // 前 10 次消费全部令牌：未命中同样计数，均应为 404。
      for (let i = 1; i <= 10; i++) {
        const res = await request(`${freshBase}/v1/identity/escrow/nobody`);
        expect(res.status, `第 ${i} 次`).toBe(404);
      }
      const res11 = await request(`${freshBase}/v1/identity/escrow/nobody`);
      expect(res11.status).toBe(429);
      expect(res11.headers["retry-after"]).toBe("60");
      expect(res11.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(res11.body.toString("utf8")).toBe(`{"error":"rate_limited"}\n`);
    } finally {
      await fresh.close();
    }
  });
});

describe("POST /v1/identity/register（匿名单登记）", () => {
  it("成功登记 → 200 registered:true（键序 alg/id/registered）", async () => {
    const { bytes, text } = jsonBody({ id: REG_ID, alg: "ed25519", pubkey: REG_PUB });
    const res = await send("POST", `${base}/v1/identity/register`, {
      "Content-Type": "application/json",
    }, bytes);
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe(
      `{"alg":"ed25519","id":"${REG_ID}","registered":true}\n`,
    );
    expect(text).toContain(REG_ID);
  });

  it("同 id 同公钥再登记 → 200 registered:false（幂等）", async () => {
    const { bytes } = jsonBody({ id: REG_ID, alg: "ed25519", pubkey: REG_PUB });
    const res = await send("POST", `${base}/v1/identity/register`, {}, bytes);
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toBe(
      `{"alg":"ed25519","id":"${REG_ID}","registered":false}\n`,
    );
  });

  it("id 与 pubkey 派生不匹配 → 400 identity_id_mismatch", async () => {
    const { bytes } = jsonBody({ id: "0".repeat(32), alg: "ed25519", pubkey: REG_PUB });
    const res = await send("POST", `${base}/v1/identity/register`, {}, bytes);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"identity_id_mismatch"}\n`);
  });

  it("alg 不支持 → 400 identity_alg_unsupported（普通 error 形状）", async () => {
    const { bytes } = jsonBody({ id: REG_ID, alg: "rsa", pubkey: REG_PUB });
    const res = await send("POST", `${base}/v1/identity/register`, {}, bytes);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"identity_alg_unsupported"}\n`);
  });

  it("pubkey 非法（非 hex/长度不对）→ 400 identity_pubkey_invalid", async () => {
    for (const pub of ["zz", "", "ab".repeat(31)]) {
      const { bytes } = jsonBody({ id: REG_ID, alg: "ed25519", pubkey: pub });
      const res = await send("POST", `${base}/v1/identity/register`, {}, bytes);
      expect(res.status, `pubkey=${JSON.stringify(pub)}`).toBe(400);
      expect(res.body.toString("utf8")).toBe(`{"error":"identity_pubkey_invalid"}\n`);
    }
  });

  it("已存在且公钥不同 → 409 identity_pubkey_conflict", async () => {
    const { bytes } = jsonBody({ id: C_ID, alg: "ed25519", pubkey: C_PUB });
    const res = await send("POST", `${base}/v1/identity/register`, {}, bytes);
    expect(res.status).toBe(409);
    expect(res.body.toString("utf8")).toBe(`{"error":"identity_pubkey_conflict"}\n`);
  });

  it("非 JSON 体 → 400 {\"error\":\"bad_json\"}", async () => {
    const res = await send(
      "POST",
      `${base}/v1/identity/register`,
      {},
      new Uint8Array(Buffer.from("not-json", "utf8")),
    );
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"bad_json"}\n`);
  });

  it("body 为 JSON null → 解码 no-op（零值）→ 400 identity_alg_unsupported（不抛错挂起）", async () => {
    const res = await send(
      "POST",
      `${base}/v1/identity/register`,
      {},
      new Uint8Array(Buffer.from("null", "utf8")),
    );
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"identity_alg_unsupported"}\n`);
  });

  it("字段类型严格（alg 收数字 / pubkey 收数组）→ 400 {\"error\":\"bad_json\"}", async () => {
    for (const raw of [`{"alg":1}`, `{"pubkey":[]}`]) {
      const res = await send(
        "POST",
        `${base}/v1/identity/register`,
        {},
        new Uint8Array(Buffer.from(raw, "utf8")),
      );
      expect(res.status, raw).toBe(400);
      expect(res.body.toString("utf8")).toBe(`{"error":"bad_json"}\n`);
    }
  });
});

describe("PUT /v1/identity/escrow/{username}（签名写）", () => {
  const SALT2 = "cd".repeat(16);
  const ENC_NONCE2 = "ef".repeat(12);
  const PRIV2 = "ab".repeat(48);
  const KDF_OK = { alg: "argon2id", m: 65536, t: 3, p: 1, len: 32 };
  const PATH = "/v1/identity/escrow/bob";

  function escrowBody(o: Record<string, unknown>): { text: string; bytes: Uint8Array } {
    return jsonBody({
      id: ID,
      alg: "ed25519",
      salt: SALT2,
      kdf: KDF_OK,
      enc_nonce: ENC_NONCE2,
      priv_cipher: PRIV2,
      ...o,
    });
  }

  it("成功写入 → 200（键序 updated_at/username），kdf_json 按结构体字段序落库", async () => {
    const { bytes } = escrowBody({});
    const res = await send(
      "PUT",
      `${base}${PATH}`,
      authHeaders(SEED, ID, "PUT", PATH, bytes),
      bytes,
    );
    expect(res.status).toBe(200);
    expect(res.body.toString("utf8")).toMatch(/^\{"updated_at":\d+,"username":"bob"\}\n$/);
    const rows = db.select(`SELECT id,kdf_json FROM escrow WHERE username=?`, ["bob"]);
    expect(rows.length).toBe(1);
    expect(String(rows[0].id)).toBe(ID);
    expect(String(rows[0].kdf_json)).toBe(`{"alg":"argon2id","m":65536,"t":3,"p":1,"len":32}`);
  });

  it("body id 与验签身份不符 → 403 escrow_identity_mismatch", async () => {
    const { bytes } = escrowBody({ id: "0".repeat(32) });
    const res = await send(
      "PUT",
      `${base}${PATH}`,
      authHeaders(SEED, ID, "PUT", PATH, bytes),
      bytes,
    );
    expect(res.status).toBe(403);
    expect(res.body.toString("utf8")).toBe(`{"error":"escrow_identity_mismatch"}\n`);
  });

  it("alg 不支持 → 400 identity_alg_unsupported", async () => {
    const { bytes } = escrowBody({ alg: "rsa" });
    const res = await send(
      "PUT",
      `${base}${PATH}`,
      authHeaders(SEED, ID, "PUT", PATH, bytes),
      bytes,
    );
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"identity_alg_unsupported"}\n`);
  });

  it("salt / enc_nonce / priv_cipher 非法 → 400 escrow_param_invalid", async () => {
    const bads: Array<Record<string, unknown>> = [
      { salt: "zz" },
      { salt: "ab" },
      { enc_nonce: "ab" },
      { enc_nonce: "zz".repeat(12) },
      { priv_cipher: "abc" },
      { priv_cipher: "" },
    ];
    for (const o of bads) {
      const { bytes } = escrowBody(o);
      const res = await send(
        "PUT",
        `${base}${PATH}`,
        authHeaders(SEED, ID, "PUT", PATH, bytes),
        bytes,
      );
      expect(res.status, JSON.stringify(o)).toBe(400);
      expect(res.body.toString("utf8")).toBe(`{"error":"escrow_param_invalid"}\n`);
    }
  });

  it("kdf 非法（alg/m/t/p/len）→ 400 escrow_kdf_invalid", async () => {
    const bads: Array<Record<string, unknown>> = [
      { alg: "scrypt", m: 65536, t: 3, p: 1, len: 32 },
      { alg: "argon2id", m: 0, t: 3, p: 1, len: 32 },
      { alg: "argon2id", m: 65536, t: 0, p: 1, len: 32 },
      { alg: "argon2id", m: 65536, t: 3, p: 0, len: 32 },
      { alg: "argon2id", m: 65536, t: 3, p: 1, len: 16 },
    ];
    for (const kdf of bads) {
      const { bytes } = escrowBody({ kdf });
      const res = await send(
        "PUT",
        `${base}${PATH}`,
        authHeaders(SEED, ID, "PUT", PATH, bytes),
        bytes,
      );
      expect(res.status, JSON.stringify(kdf)).toBe(400);
      expect(res.body.toString("utf8")).toBe(`{"error":"escrow_kdf_invalid"}\n`);
    }
  });

  it("username 非法 → 400 escrow_username_invalid", async () => {
    const badPath = "/v1/identity/escrow/ab";
    const { bytes } = escrowBody({});
    const res = await send(
      "PUT",
      `${base}${badPath}`,
      authHeaders(SEED, ID, "PUT", badPath, bytes),
      bytes,
    );
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"escrow_username_invalid"}\n`);
  });

  it("未签名 → 400 auth_missing_header（中间件先于 handler）", async () => {
    const { bytes } = escrowBody({});
    const res = await send("PUT", `${base}${PATH}`, {}, bytes);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"code":"auth_missing_header","error":"缺少签名头"}\n`);
  });

  // 以下用**原始文本**构造体（jsonBody 的 JSON.stringify 会把 1e2 归一成 100，测不出 int64 口径）。
  function escrowRaw(kdfRaw: string): string {
    return (
      `{"id":"${ID}","alg":"ed25519","salt":"${SALT2}","kdf":${kdfRaw},` +
      `"enc_nonce":"${ENC_NONCE2}","priv_cipher":"${PRIV2}"}`
    );
  }

  function putRaw(text: string): Promise<Res> {
    const bytes = new Uint8Array(Buffer.from(text, "utf8"));
    return send("PUT", `${base}${PATH}`, authHeaders(SEED, ID, "PUT", PATH, bytes), bytes);
  }

  it("body 为 JSON null → 解码 no-op → 403 escrow_identity_mismatch（不抛错挂起）", async () => {
    const res = await putRaw("null");
    expect(res.status).toBe(403);
    expect(res.body.toString("utf8")).toBe(`{"error":"escrow_identity_mismatch"}\n`);
  });

  it("kdf 类型严格（字符串 / 数组）→ 400 {\"error\":\"bad_json\"}", async () => {
    for (const raw of [escrowRaw(`"str"`), escrowRaw(`[]`)]) {
      const res = await putRaw(raw);
      expect(res.status, raw).toBe(400);
      expect(res.body.toString("utf8")).toBe(`{"error":"bad_json"}\n`);
    }
  });

  it("kdf 字段类型严格（m 收字符串 / len 收小数）→ 400 {\"error\":\"bad_json\"}", async () => {
    for (const raw of [escrowRaw(`{"m":"65536"}`), escrowRaw(`{"len":32.5}`)]) {
      const res = await putRaw(raw);
      expect(res.status, raw).toBe(400);
      expect(res.body.toString("utf8")).toBe(`{"error":"bad_json"}\n`);
    }
  });

  it("int64 口径：1e2 / 1.0 非整数字面量、超 int64 上界 → 400 {\"error\":\"bad_json\"}", async () => {
    const raws = [
      escrowRaw(`{"m":1e2}`),
      escrowRaw(`{"m":1.0}`),
      escrowRaw(`{"m":9223372036854775808}`),
    ];
    for (const raw of raws) {
      const res = await putRaw(raw);
      expect(res.status, raw).toBe(400);
      expect(res.body.toString("utf8")).toBe(`{"error":"bad_json"}\n`);
    }
  });

  it("kdf:null → 解码 no-op（零值）→ 400 escrow_kdf_invalid", async () => {
    const res = await putRaw(escrowRaw("null"));
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"escrow_kdf_invalid"}\n`);
  });
});
