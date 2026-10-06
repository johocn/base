import http from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Listener, ServerAdapters, ServerRequest } from "@base/core-ts";
import {
  blobId,
  bytesToHex,
  canonicalize,
  deriveIdentityId,
  keyPairFromSeed,
  randomBytes,
  requestSignBytes,
  sha256Hex,
  sign,
  utf8,
  type Json,
} from "@base/protocol-ts";
import { openDb, type Db } from "../db";
import { createHttpServerAdapter } from "../host/http";
import { createTlsAdapter } from "../host/tls";
import { createSchedulerAdapter } from "../host/scheduler";
import { createCliHost } from "../host/cli";
import { createLifecycleAdapter } from "../host/lifecycle";
import { startServer } from "../serve";
import { IpLimiter } from "./derived";
import { eventPostHandler } from "./event";

const IDENTITIES_DDL = `CREATE TABLE identities(
		id           TEXT PRIMARY KEY,
		alg          TEXT NOT NULL,
		pubkey       TEXT NOT NULL,
		created_at   INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL DEFAULT 0
	)`;
const NONCES_DDL = `CREATE TABLE auth_nonces(
		id      TEXT NOT NULL,
		nonce   TEXT NOT NULL,
		seen_at INTEGER NOT NULL,
		PRIMARY KEY(id, nonce)
	)`;
const EVENTS_DDL = `CREATE TABLE events(
		event_id    TEXT PRIMARY KEY,
		id          TEXT NOT NULL,
		type        TEXT NOT NULL,
		body_json   TEXT NOT NULL,
		created_at  INTEGER NOT NULL,
		received_at INTEGER NOT NULL,
		target_id   TEXT,
		payload_cid TEXT,
		reply_to    TEXT
	)`;
const BLOBS_DDL = `CREATE TABLE blobs(
		blob_id    TEXT PRIMARY KEY,
		size       INTEGER NOT NULL,
		item_id    TEXT NOT NULL DEFAULT '',
		seq        INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL
	)`;
const TOMBSTONE_DDL = `CREATE TABLE comment_tombstone(
		event_id    TEXT PRIMARY KEY,
		payload_cid TEXT NOT NULL,
		reason      TEXT,
		at          INTEGER NOT NULL,
		received_at INTEGER NOT NULL
	)`;
const PROGRESS_DDL = `CREATE TABLE progress(
		id         TEXT    NOT NULL,
		item_id    TEXT    NOT NULL,
		position   INTEGER NOT NULL,
		done       INTEGER NOT NULL,
		day        TEXT    NOT NULL,
		updated_at INTEGER NOT NULL,
		event_id   TEXT    NOT NULL,
		dirty      INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY(id, item_id)
	)`;
const CHECKIN_DDL = `CREATE TABLE checkin_days(
		id             TEXT    NOT NULL,
		day            TEXT    NOT NULL,
		first_event_id TEXT    NOT NULL,
		created_at     INTEGER NOT NULL,
		PRIMARY KEY(id, day)
	)`;
// 条目表（schema.ts items 同构，裁剪注释）：like.v1 的条目 target 校验（activeItemExists）需要。
const ITEMS_DDL = `CREATE TABLE items(
		item_id      TEXT PRIMARY KEY,
		source       TEXT NOT NULL,
		type         TEXT NOT NULL,
		title        TEXT NOT NULL DEFAULT '',
		source_rev   TEXT NOT NULL DEFAULT '',
		content_hash TEXT NOT NULL,
		sqlite_table TEXT NOT NULL,
		dist_class   TEXT NOT NULL DEFAULT 'public',
		instructor   TEXT NOT NULL DEFAULT '',
		state              TEXT    NOT NULL DEFAULT 'active',
		pin_level          INTEGER NOT NULL DEFAULT 0,
		pinned_at          INTEGER,
		highlight_until    INTEGER,
		tags_json          TEXT    NOT NULL DEFAULT '[]',
		updated_at         TEXT    NOT NULL
	)`;

const SEED_A = "a1".repeat(32);
const SEED_B = "b2".repeat(32);
const SEED_C = "c3".repeat(32);
const SEED_R = "d4".repeat(32);
const ID_A = deriveIdentityId(keyPairFromSeed(SEED_A).pubHex);
const ID_B = deriveIdentityId(keyPairFromSeed(SEED_B).pubHex);
const ID_C = deriveIdentityId(keyPairFromSeed(SEED_C).pubHex);
const ID_R = deriveIdentityId(keyPairFromSeed(SEED_R).pubHex);
const UNREGISTERED = "ab".repeat(16);
const DM_TO = "cd".repeat(16);

const TS = 1_700_000_000_000;

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function post(url: string, headers: Record<string, string>, body: Uint8Array): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    req.write(Buffer.from(body));
    req.end();
  });
}

function authHeaders(seed: string, id: string, body: Uint8Array): Record<string, string> {
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
      requestSignBytes({
        method: "POST",
        path: "/v1/event",
        query: "",
        bodySha256: sha256Hex(body),
        ts,
        nonce,
      }),
    ),
  };
}

/** 真签真验：事件内容签名覆盖 canonical({event_id,type,created_at,body})。 */
function makeEnvelope(
  seed: string,
  eventId: string,
  type: string,
  createdAtRaw: string,
  bodyObj: unknown,
  sigOverride?: string,
): string {
  const bodyPart = JSON.stringify(bodyObj);
  const sig =
    sigOverride ??
    sign(
      seed,
      utf8(
        canonicalize({
          event_id: eventId,
          type,
          created_at: Number(createdAtRaw),
          body: bodyObj as Json,
        }),
      ),
    );
  return `{"event_id":"${eventId}","type":"${type}","created_at":${createdAtRaw},"body":${bodyPart},"sig":"${sig}"}`;
}

/**
 * 直接拼信封、不做内容签名。仅用于在验签之前就会被拒的用例
 * （created_at / body 形态校验失败），此时 sig 不被读取，填 64hex 占位即可。
 */
function rawEnvelope(
  eventId: string,
  type: string,
  createdAtRaw: string,
  bodyText: string,
  sig = "00".repeat(32),
): string {
  return `{"event_id":"${eventId}","type":"${type}","created_at":${createdAtRaw},"body":${bodyText},"sig":"${sig}"}`;
}

function postEvent(base: string, seed: string, id: string, bodyText: string): Promise<Res> {
  const body = new Uint8Array(Buffer.from(bodyText, "utf8"));
  return post(`${base}/v1/event`, authHeaders(seed, id, body), body);
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
let rlListener: Listener;
let rlBase: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "base-node-event-"));
  db = openDb(join(dir, "base.db"));
  db.execute(IDENTITIES_DDL);
  db.execute(NONCES_DDL);
  db.execute(EVENTS_DDL);
  db.execute(BLOBS_DDL);
  db.execute(TOMBSTONE_DDL);
  db.execute(PROGRESS_DDL);
  db.execute(CHECKIN_DDL);
  db.execute(ITEMS_DDL);
  for (const [seed, id] of [
    [SEED_A, ID_A],
    [SEED_B, ID_B],
    [SEED_C, ID_C],
    [SEED_R, ID_R],
  ] as const) {
    db.execute(`INSERT INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, [
      id,
      "ed25519",
      keyPairFromSeed(seed).pubHex,
      TS,
      0,
    ]);
  }
  listener = await startServer(adapters(), db, { host: "127.0.0.1", port: 0, dataDir: dir });
  base = `http://${listener.addr()}`;
  // 第二台服务：全新的令牌桶，专供限速越界测试，避免打满共享 IP 桶影响其它用例。
  rlListener = await startServer(adapters(), db, { host: "127.0.0.1", port: 0, dataDir: dir });
  rlBase = `http://${rlListener.addr()}`;
});

afterAll(async () => {
  await listener.close();
  await rlListener.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /v1/event 信封", () => {
  it("未签名 → 400 auth_missing_header（走 requireAuth）", async () => {
    const res = await post(`${base}/v1/event`, {}, Buffer.from(`{"type":"comment.v1"}`));
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(
      `{"code":"auth_missing_header","error":"缺少签名头"}\n`,
    );
  });

  it("坏 JSON → 400 bad_json", async () => {
    for (const raw of [`{`, `[]`, `123`, `"str"`]) {
      const res = await postEvent(base, SEED_A, ID_A, raw);
      expect(res.status, raw).toBe(400);
      expect(res.body.toString("utf8"), raw).toBe(`{"error":"bad_json"}\n`);
    }
  });

  it("顶层 null = no-op → 400 event_type_unknown（不是 bad_json）", async () => {
    const res = await postEvent(base, SEED_A, ID_A, `null`);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"event_type_unknown"}\n`);
  });

  it("未知类型 → 400 event_type_unknown", async () => {
    const body = makeEnvelope(SEED_A, "01".repeat(16), "nope.v1", "1", { a: 1 });
    const res = await postEvent(base, SEED_A, ID_A, body);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"event_type_unknown"}\n`);
  });

  it("created_at 语义：字符串非数字 → bad_json；1e2 / 1.5 / \"1e2\" → event_param_invalid", async () => {
    const cases: [string, string][] = [
      [`"abc"`, `{"error":"bad_json"}\n`],
      [`1e2`, `{"error":"event_param_invalid"}\n`],
      [`1.5`, `{"error":"event_param_invalid"}\n`],
      [`"1e2"`, `{"error":"event_param_invalid"}\n`],
      [`0`, `{"error":"event_param_invalid"}\n`],
    ];
    for (const [raw, expected] of cases) {
      const body = rawEnvelope(
        "02".repeat(16),
        "comment.v1",
        raw,
        JSON.stringify({ target_id: "t1" }),
      );
      const res = await postEvent(base, SEED_A, ID_A, body);
      expect(res.status, raw).toBe(400);
      expect(res.body.toString("utf8"), raw).toBe(expected);
    }
  });

  it("event_id 非 32hex → 400 event_param_invalid", async () => {
    const body = makeEnvelope(SEED_A, "zz", "comment.v1", String(TS), { target_id: "t1" });
    const res = await postEvent(base, SEED_A, ID_A, body);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
  });
});

describe("POST /v1/event comment.v1", () => {
  const E1 = "11".repeat(16);

  it("直角 200：落块 + 落事件行，body_json 为减化 canonical 形态", async () => {
    const text = "hello";
    const body = makeEnvelope(SEED_A, E1, "comment.v1", String(TS), { target_id: "t1", text });
    const res = await postEvent(base, SEED_A, ID_A, body);
    const payloadCid = blobId(utf8(text));
    const envSig = (JSON.parse(body) as { sig: string }).sig;
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body.toString("utf8")) as Record<string, unknown>;
    expect(parsed.event_id).toBe(E1);
    expect(parsed.payload_cid).toBe(payloadCid);
    expect(typeof parsed.received_at).toBe("number");

    const rows = db.select(`SELECT * FROM events WHERE event_id=?`, [E1]);
    expect(rows.length).toBe(1);
    expect(String(rows[0].target_id)).toBe("t1");
    expect(String(rows[0].payload_cid)).toBe(payloadCid);
    expect(String(rows[0].reply_to)).toBe("");
    expect(String(rows[0].body_json)).toBe(
      canonicalize({ target_id: "t1", payload_cid: payloadCid, reply_to: "", sig: envSig }),
    );
    const blobs = db.select(`SELECT size FROM blobs WHERE blob_id=?`, [payloadCid]);
    expect(blobs.length).toBe(1);
    expect(Number(blobs[0].size)).toBe(Buffer.byteLength(text, "utf8"));
    const filePath = join(dir, "blobs", payloadCid.slice(0, 2), payloadCid.slice(2, 4), payloadCid);
    expect(existsSync(filePath)).toBe(true);
  });

  it("未知键 → 400 event_param_invalid", async () => {
    const body = makeEnvelope(SEED_A, "12".repeat(16), "comment.v1", String(TS), {
      target_id: "t1",
      text: "hi",
      extra: 1,
    });
    const res = await postEvent(base, SEED_A, ID_A, body);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("缺 text → 400 event_param_invalid", async () => {
    const body = makeEnvelope(SEED_A, "13".repeat(16), "comment.v1", String(TS), { target_id: "t1" });
    const res = await postEvent(base, SEED_A, ID_A, body);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("text 超 8192 字节 → 400 event_param_invalid", async () => {
    const body = makeEnvelope(SEED_A, "14".repeat(16), "comment.v1", String(TS), {
      target_id: "t1",
      text: "x".repeat(8193),
    });
    const res = await postEvent(base, SEED_A, ID_A, body);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("sig 错（合法 64hex 但不匹配）→ 403 event_sig_invalid", async () => {
    const body = makeEnvelope(
      SEED_A,
      "15".repeat(16),
      "comment.v1",
      String(TS),
      { target_id: "t1", text: "hi" },
      "00".repeat(32),
    );
    const res = await postEvent(base, SEED_A, ID_A, body);
    expect(res.status).toBe(403);
    expect(res.body.toString("utf8")).toBe(
      `{"code":"event_sig_invalid","error":"事件内容签名验证失败"}\n`,
    );
  });

  it("身份未登记 → 403 identity_unregistered（直接调用 handler）", async () => {
    const bodyText = makeEnvelope(SEED_C, "16".repeat(16), "comment.v1", String(TS), {
      target_id: "t1",
      text: "hi",
    });
    const req = {
      method: "POST",
      path: "/v1/event",
      params: {},
      query: {},
      headers: {},
      body: new Uint8Array(Buffer.from(bodyText, "utf8")),
    } as ServerRequest;
    const handler = eventPostHandler({
      db,
      dataDir: dir,
      storeKey: null,
      byID: new IpLimiter(30, 10),
      byIP: new IpLimiter(120, 30),
    });
    const res = await handler(req, UNREGISTERED);
    expect(res.status).toBe(403);
    expect(Buffer.from(res.body ?? new Uint8Array()).toString("utf8")).toBe(
      `{"code":"identity_unregistered","error":"身份未登记"}\n`,
    );
  });
});

describe("POST /v1/event dm.v1", () => {
  const C1 = "21".repeat(16);

  it("直角 200：target_id=dm/<to>，body_json=canonical({to,payload_cid})", async () => {
    const cipher = "ciphertext";
    const body = makeEnvelope(SEED_B, C1, "dm.v1", String(TS), { to: DM_TO, text_cipher: cipher });
    const res = await postEvent(base, SEED_B, ID_B, body);
    const payloadCid = blobId(utf8(cipher));
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body.toString("utf8")) as Record<string, unknown>;
    expect(parsed.event_id).toBe(C1);
    expect(parsed.payload_cid).toBe(payloadCid);
    const rows = db.select(`SELECT * FROM events WHERE event_id=?`, [C1]);
    expect(String(rows[0].target_id)).toBe("dm/" + DM_TO);
    expect(String(rows[0].payload_cid)).toBe(payloadCid);
    expect(String(rows[0].body_json)).toBe(canonicalize({ to: DM_TO, payload_cid: payloadCid }));
  });

  it("to 非 32hex → 400 event_param_invalid", async () => {
    const body = makeEnvelope(SEED_B, "22".repeat(16), "dm.v1", String(TS), {
      to: "zz",
      text_cipher: "x",
    });
    const res = await postEvent(base, SEED_B, ID_B, body);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("text_cipher 空或超限 → 400 event_param_invalid", async () => {
    for (const cipher of ["", "x".repeat(8193)]) {
      const body = makeEnvelope(SEED_B, "23".repeat(16), "dm.v1", String(TS), {
        to: DM_TO,
        text_cipher: cipher,
      });
      const res = await postEvent(base, SEED_B, ID_B, body);
      expect(res.status).toBe(400);
      expect(res.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
    }
  });
});

describe("POST /v1/event progress.v1", () => {
  const P1 = "31".repeat(16);
  const ITEM_A = "article/a";
  const ITEM_B = "article/b";

  it("直角 200：双投影 + body_json 为客户端原始字节；同 event_id 重放 received_at 幂等", async () => {
    const bodyObj = { item_id: ITEM_A, position: 5, done: false, day: "2026-01-01" };
    const body = makeEnvelope(SEED_C, P1, "progress.v1", String(TS), bodyObj);
    const first = await postEvent(base, SEED_C, ID_C, body);
    expect(first.status).toBe(200);
    const firstParsed = JSON.parse(first.body.toString("utf8")) as Record<string, unknown>;
    expect(firstParsed.event_id).toBe(P1);

    const rows = db.select(`SELECT * FROM events WHERE event_id=?`, [P1]);
    expect(String(rows[0].body_json)).toBe(JSON.stringify(bodyObj)); // 原始字节，非减化
    expect(String(rows[0].target_id)).toBe(ITEM_A);
    const prog = db.select(`SELECT * FROM progress WHERE id=? AND item_id=?`, [ID_C, ITEM_A]);
    expect(prog.length).toBe(1);
    expect(Number(prog[0].position)).toBe(5);
    expect(Number(prog[0].done)).toBe(0);
    expect(String(prog[0].day)).toBe("2026-01-01");
    const days = db.select(`SELECT * FROM checkin_days WHERE id=? AND day=?`, [ID_C, "2026-01-01"]);
    expect(days.length).toBe(1);

    const second = await postEvent(base, SEED_C, ID_C, body);
    expect(second.status).toBe(200);
    const secondParsed = JSON.parse(second.body.toString("utf8")) as Record<string, unknown>;
    expect(secondParsed.received_at).toBe(firstParsed.received_at);
  });

  it("day 形态错 → 400 event_param_invalid", async () => {
    const body = makeEnvelope(SEED_C, "32".repeat(16), "progress.v1", String(TS), {
      item_id: ITEM_A,
      position: 1,
      done: true,
      day: "2026-1-1",
    });
    const res = await postEvent(base, SEED_C, ID_C, body);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("position 负数或非整数 → 400 event_param_invalid", async () => {
    for (const position of [-1, 1.5]) {
      const body = rawEnvelope(
        "33".repeat(16),
        "progress.v1",
        String(TS),
        JSON.stringify({ item_id: ITEM_A, position, done: true, day: "2026-01-01" }),
      );
      const res = await postEvent(base, SEED_C, ID_C, body);
      expect(res.status).toBe(400);
      expect(res.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
    }
  });

  it("done 非 bool → 400 event_param_invalid", async () => {
    const body = makeEnvelope(SEED_C, "34".repeat(16), "progress.v1", String(TS), {
      item_id: ITEM_A,
      position: 1,
      done: 1,
      day: "2026-01-01",
    });
    const res = await postEvent(base, SEED_C, ID_C, body);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("未知键 → 400 event_param_invalid", async () => {
    const body = makeEnvelope(SEED_C, "35".repeat(16), "progress.v1", String(TS), {
      item_id: ITEM_A,
      position: 1,
      done: true,
      day: "2026-01-01",
      extra: 1,
    });
    const res = await postEvent(base, SEED_C, ID_C, body);
    expect(res.status).toBe(400);
    expect(res.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
  });

  it("LWW 输者静默 200 且不改 progress，但 checkin_days 照样写", async () => {
    const winBody = makeEnvelope(SEED_C, "36".repeat(16), "progress.v1", String(TS), {
      item_id: ITEM_B,
      position: 9,
      done: true,
      day: "2026-01-05",
    });
    const win = await postEvent(base, SEED_C, ID_C, winBody);
    expect(win.status).toBe(200);

    // 更早的 created_at → 输掉 LWW；换一个 day 以验证 checkin_days 仍写。
    const loseBody = makeEnvelope(SEED_C, "37".repeat(16), "progress.v1", String(TS - 10), {
      item_id: ITEM_B,
      position: 1,
      done: false,
      day: "2026-01-06",
    });
    const lose = await postEvent(base, SEED_C, ID_C, loseBody);
    expect(lose.status).toBe(200);

    const prog = db.select(`SELECT * FROM progress WHERE id=? AND item_id=?`, [ID_C, ITEM_B]);
    expect(Number(prog[0].position)).toBe(9);
    expect(Number(prog[0].done)).toBe(1);
    expect(String(prog[0].day)).toBe("2026-01-05");
    expect(String(prog[0].event_id)).toBe("36".repeat(16));
    const days = db.select(`SELECT day FROM checkin_days WHERE id=? AND day IN (?,?)`, [
      ID_C,
      "2026-01-05",
      "2026-01-06",
    ]);
    expect(days.map((d) => String(d.day)).sort()).toEqual(["2026-01-05", "2026-01-06"]);
  });
});

describe("POST /v1/event 限速", () => {
  it("超过 ID 桶 burst → 429 event_rate_limited", async () => {
    const bodyObj = { x: 1 }; // 过信封校验，body 未知键 → 400，但已消耗令牌
    let last: Res | null = null;
    for (let i = 0; i < 11; i++) {
      const body = makeEnvelope(
        SEED_R,
        i.toString(16).padStart(2, "0").repeat(16).slice(0, 32),
        "comment.v1",
        String(TS),
        bodyObj,
      );
      last = await postEvent(rlBase, SEED_R, ID_R, body);
    }
    expect(last?.status).toBe(429);
    expect(last?.body.toString("utf8")).toBe(
      `{"code":"event_rate_limited","error":"发言过于频繁"}\n`,
    );
  });
});

// ---------- #79 §3：like.v1 / report.v1 写面验收（镜像 Go TestHandleEventLikeReport 三用例） ----------
// 事件限速是令牌桶（30/min，burst 10），故与 Go 同口径自起专用服务（全新令牌桶），
// 三个用例分摊到三个身份，单个身份的 POST /v1/event 次数留在桶内。

describe("POST /v1/event like.v1 / report.v1", () => {
  let lrListener: Listener;
  let lrBase: string;

  beforeAll(async () => {
    lrListener = await startServer(adapters(), db, { host: "127.0.0.1", port: 0, dataDir: dir });
    lrBase = `http://${lrListener.addr()}`;
  });

  afterAll(async () => {
    await lrListener.close();
  });

  function postLR(seed: string, id: string, bodyText: string): Promise<Res> {
    const body = new Uint8Array(Buffer.from(bodyText, "utf8"));
    return post(`${lrBase}/v1/event`, authHeaders(seed, id, body), body);
  }

  function seedComment(
    seed: string,
    id: string,
    eventId: string,
    target: string,
    text: string,
  ): Promise<Res> {
    return postLR(
      seed,
      id,
      makeEnvelope(seed, eventId, "comment.v1", String(TS), { target_id: target, text }),
    );
  }

  /** ①like 评论成功落行（投影只填 target_id）＋②幂等＋⑧重复举报不拒＋⑨未登记类型回归。 */
  it("①like 落行 ②幂等 ⑧重复举报 ⑨like.v2 未登记", async () => {
    const C1 = "51".repeat(16);
    const seeded = await seedComment(SEED_A, ID_A, C1, "article/a", "被赞评论");
    expect(seeded.status).toBe(200);

    // ① like 评论：200 {event_id, received_at}，无 payload_cid 键。
    const likeWire = makeEnvelope(SEED_A, "61".repeat(16), "like.v1", String(TS), {
      target_id: C1,
      action: "like",
    });
    const first = await postLR(SEED_A, ID_A, likeWire);
    expect(first.status).toBe(200);
    const parsed = JSON.parse(first.body.toString("utf8")) as Record<string, unknown>;
    expect(parsed.event_id).toBe("61".repeat(16));
    expect(typeof parsed.received_at).toBe("number");
    expect("payload_cid" in parsed).toBe(false);
    const rows = db.select(`SELECT * FROM events WHERE event_id=?`, ["61".repeat(16)]);
    expect(rows.length).toBe(1);
    expect(String(rows[0].target_id)).toBe(C1);
    expect(String(rows[0].payload_cid)).toBe("");
    expect(String(rows[0].reply_to)).toBe("");
    const envSig = (JSON.parse(likeWire) as { sig: string }).sig;
    expect(String(rows[0].body_json)).toBe(
      canonicalize({ target_id: C1, action: "like", sig: envSig }),
    );

    // ② 幂等：同 event_id 重发 → 200 同 received_at。
    const replay = await postLR(SEED_A, ID_A, likeWire);
    expect(replay.status).toBe(200);
    const replayed = JSON.parse(replay.body.toString("utf8")) as Record<string, unknown>;
    expect(replayed.received_at).toBe(parsed.received_at);

    // ⑧ 重复举报两条不同 event_id → 均 200（重复举报本身是信号，节点不拒）。
    for (const [i, reason] of [["62", "spam"], ["63", "abuse"]] as const) {
      const wire = makeEnvelope(SEED_A, i.repeat(16), "report.v1", String(TS), {
        target_id: C1,
        reason,
      });
      const res = await postLR(SEED_A, ID_A, wire);
      expect(res.status, reason).toBe(200);
      if (i === "62") {
        const sig = (JSON.parse(wire) as { sig: string }).sig;
        const r = db.select(`SELECT * FROM events WHERE event_id=?`, [i.repeat(16)]);
        expect(r.length).toBe(1);
        expect(String(r[0].target_id)).toBe(C1);
        expect(String(r[0].payload_cid)).toBe("");
        expect(String(r[0].body_json)).toBe(canonicalize({ target_id: C1, reason, sig }));
      }
    }

    // ⑨ 未登记类型回归：type=like.v2 → 400 event_type_unknown。
    const v2 = await postLR(
      SEED_A,
      ID_A,
      makeEnvelope(SEED_A, "64".repeat(16), "like.v2", String(TS), {
        target_id: C1,
        action: "like",
      }),
    );
    expect(v2.status).toBe(400);
    expect(v2.body.toString("utf8")).toBe(`{"error":"event_type_unknown"}\n`);
  });

  /** ③评论 target 不存在 404＋④墓碑 410＋⑤条目 target 校验＋⑥like body 严格键集。 */
  it("③target 404 ④墓碑 410 ⑤条目 target ⑥like 严格键集", async () => {
    const C2 = "52".repeat(16);
    const seeded = await seedComment(SEED_B, ID_B, C2, "article/b", "会被删的评论");
    expect(seeded.status).toBe(200);

    // ③ 评论 target 不存在 → 404 target_not_found。
    const missing = await postLR(
      SEED_B,
      ID_B,
      makeEnvelope(SEED_B, "65".repeat(16), "like.v1", String(TS), {
        target_id: "5f".repeat(16),
        action: "like",
      }),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.toString("utf8")).toBe(`{"error":"target_not_found"}\n`);

    // ④ target 已墓碑 → 410 target_gone（like 与 report 同口径；Go 用 review reject 产生，此处同状态直达）。
    db.execute(
      `INSERT INTO comment_tombstone(event_id,payload_cid,reason,at,received_at) VALUES(?,?,?,?,?)`,
      [C2, "cid", "违规", TS, TS],
    );
    const gone = await postLR(
      SEED_B,
      ID_B,
      makeEnvelope(SEED_B, "66".repeat(16), "like.v1", String(TS), {
        target_id: C2,
        action: "like",
      }),
    );
    expect(gone.status).toBe(410);
    expect(gone.body.toString("utf8")).toBe(`{"error":"target_gone"}\n`);

    // ⑤ 条目 target：不存在 → 404；active → 200；下架（removed）→ 404。
    const noItem = await postLR(
      SEED_B,
      ID_B,
      makeEnvelope(SEED_B, "67".repeat(16), "like.v1", String(TS), {
        target_id: "article/nope",
        action: "like",
      }),
    );
    expect(noItem.status).toBe(404);
    expect(noItem.body.toString("utf8")).toBe(`{"error":"target_not_found"}\n`);
    db.execute(
      `INSERT INTO items(item_id,source,type,content_hash,sqlite_table,updated_at)
			VALUES('article/a1','test','article','hash','articles','2026-01-01T00:00:00Z')`,
    );
    const itemLike = await postLR(
      SEED_B,
      ID_B,
      makeEnvelope(SEED_B, "68".repeat(16), "like.v1", String(TS), {
        target_id: "article/a1",
        action: "like",
      }),
    );
    expect(itemLike.status).toBe(200);
    const itemRows = db.select(`SELECT * FROM events WHERE event_id=?`, ["68".repeat(16)]);
    expect(String(itemRows[0].target_id)).toBe("article/a1");
    expect(String(itemRows[0].payload_cid)).toBe("");
    db.execute(`UPDATE items SET state='removed' WHERE item_id='article/a1'`);
    const retired = await postLR(
      SEED_B,
      ID_B,
      makeEnvelope(SEED_B, "69".repeat(16), "like.v1", String(TS), {
        target_id: "article/a1",
        action: "unlike",
      }),
    );
    expect(retired.status).toBe(404);
    expect(retired.body.toString("utf8")).toBe(`{"error":"target_not_found"}\n`);

    // ⑥ like body：非法 action / 多未知键 → 400 event_param_invalid。
    const badAction = await postLR(
      SEED_B,
      ID_B,
      makeEnvelope(SEED_B, "6a".repeat(16), "like.v1", String(TS), {
        target_id: C2,
        action: "love",
      }),
    );
    expect(badAction.status).toBe(400);
    expect(badAction.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
    const extraKey = await postLR(
      SEED_B,
      ID_B,
      makeEnvelope(SEED_B, "6b".repeat(16), "like.v1", String(TS), {
        target_id: C2,
        action: "like",
        text: "多余键",
      }),
    );
    expect(extraKey.status).toBe(400);
    expect(extraKey.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
  });

  /** ⑦report 四值 reason / 缺键 / 多键 / 非评论形态 target 严格校验＋report 的 target 404。 */
  it("⑦report body 严格校验 + report target 404", async () => {
    const C3 = "53".repeat(16);
    const seeded = await seedComment(SEED_C, ID_C, C3, "article/c", "被举报评论");
    expect(seeded.status).toBe(200);

    // 非法 reason（严格四值 spam/abuse/illegal/other）→ 400 event_param_invalid。
    const badReason = await postLR(
      SEED_C,
      ID_C,
      makeEnvelope(SEED_C, "71".repeat(16), "report.v1", String(TS), {
        target_id: C3,
        reason: "hate",
      }),
    );
    expect(badReason.status).toBe(400);
    expect(badReason.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
    // 缺 reason 键 → 400。
    const noReason = await postLR(
      SEED_C,
      ID_C,
      makeEnvelope(SEED_C, "72".repeat(16), "report.v1", String(TS), { target_id: C3 }),
    );
    expect(noReason.status).toBe(400);
    expect(noReason.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
    // 多未知键 → 400。
    const extraKey = await postLR(
      SEED_C,
      ID_C,
      makeEnvelope(SEED_C, "73".repeat(16), "report.v1", String(TS), {
        target_id: C3,
        reason: "spam",
        text: "多余键",
      }),
    );
    expect(extraKey.status).toBe(400);
    expect(extraKey.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
    // report 只收评论 target（16 hex）：路径式 → 400 event_param_invalid。
    const pathTarget = await postLR(
      SEED_C,
      ID_C,
      makeEnvelope(SEED_C, "74".repeat(16), "report.v1", String(TS), {
        target_id: "article/b",
        reason: "spam",
      }),
    );
    expect(pathTarget.status).toBe(400);
    expect(pathTarget.body.toString("utf8")).toBe(`{"error":"event_param_invalid"}\n`);
    // report 的 target 不存在 → 404 target_not_found（与 like 同口径）。
    const missing = await postLR(
      SEED_C,
      ID_C,
      makeEnvelope(SEED_C, "75".repeat(16), "report.v1", String(TS), {
        target_id: "5e".repeat(16),
        reason: "spam",
      }),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.toString("utf8")).toBe(`{"error":"target_not_found"}\n`);
  });
});