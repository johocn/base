// 对拍级用例：直接驱动 submitPostHandler，覆盖五种形态的直角、全部错误码与限速切点。
// 真私钥签 author_sig、真验签；content_hash 一律用 @base/protocol-ts 的客户端镜像独立算出。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerRequest, ServerResponse } from "@base/core-ts";
import {
  authorSignBytes,
  deriveIdentityId,
  encodeTagPath,
  keyPairFromSeed,
  segmentsContentHash as protoSegmentsHash,
  sha256Hex,
  sign,
  tagTitle,
  utf8,
} from "@base/protocol-ts";
import { openDb, type Db } from "../db";
import { decText } from "../host/aesgcm";
import type { AuthedHandler } from "./authmw";
import { IpLimiter } from "./derived";
import {
  SUBMIT_BURST_PER_ID,
  SUBMIT_BURST_PER_IP,
  SUBMIT_PER_MINUTE_PER_ID,
  SUBMIT_PER_MINUTE_PER_IP,
  submitPostHandler,
} from "./submit";

const DDL: string[] = [
  `CREATE TABLE identities(
    id           TEXT PRIMARY KEY,
    alg          TEXT NOT NULL,
    pubkey       TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE items(
    item_id      TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    type         TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    source_rev   TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL,
    sqlite_table TEXT NOT NULL,
    dist_class   TEXT NOT NULL DEFAULT 'public',
    state        TEXT NOT NULL DEFAULT 'active',
    updated_at   TEXT NOT NULL,
    author_id    TEXT NOT NULL DEFAULT '',
    author_sig   TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE articles(
    item_id      TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT '',
    digest       TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL DEFAULT '',
    tags_json    TEXT NOT NULL DEFAULT '[]',
    body_md      TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_rev   TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE quizzes(
    item_id       TEXT PRIMARY KEY,
    question_json TEXT NOT NULL,
    content_hash  TEXT NOT NULL
  )`,
  `CREATE TABLE segments(
    item_id      TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    kind         TEXT NOT NULL DEFAULT '',
    text         TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    PRIMARY KEY(item_id, seq)
  )`,
  `CREATE TABLE tag_links(
    tag_id     TEXT NOT NULL,
    target_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tag_id, target_id)
  )`,
  `CREATE TABLE media_meta(
    item_id           TEXT PRIMARY KEY,
    mime              TEXT NOT NULL DEFAULT '',
    size              INTEGER NOT NULL DEFAULT 0,
    duration          INTEGER NOT NULL DEFAULT 0,
    chunk_size        INTEGER NOT NULL DEFAULT 0,
    chunk_hashes_json TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE TABLE groups(
    group_id        TEXT PRIMARY KEY,
    creator_id      TEXT NOT NULL,
    epoch           INTEGER NOT NULL,
    roster_rev      INTEGER NOT NULL DEFAULT 0,
    encrypted       INTEGER NOT NULL DEFAULT 1,
    member_ids_json TEXT NOT NULL,
    key_envelopes   TEXT NOT NULL DEFAULT '[]',
    event_id        TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  )`,
  `CREATE TABLE events(
    event_id    TEXT PRIMARY KEY,
    id          TEXT NOT NULL,
    type        TEXT NOT NULL,
    body_json   TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    target_id   TEXT,
    payload_cid TEXT,
    reply_to    TEXT
  )`,
];

const SEED_A = "a1".repeat(32);
const SEED_B = "b2".repeat(32);
const ID_A = deriveIdentityId(keyPairFromSeed(SEED_A).pubHex);
const ID_B = deriveIdentityId(keyPairFromSeed(SEED_B).pubHex);
const STORE_KEY = new Uint8Array(32).fill(7);
const TS = 1_700_000_000_000;

let dir: string;
let db: Db;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "base-node-submit-"));
  db = openDb(join(dir, "base.db"));
  for (const stmt of DDL) db.execute(stmt);
  for (const [seed, id] of [
    [SEED_A, ID_A],
    [SEED_B, ID_B],
  ] as const) {
    db.execute(`INSERT INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, [
      id,
      "ed25519",
      keyPairFromSeed(seed).pubHex,
      TS,
      0,
    ]);
  }
  // 圈 g1：ID_A 是创建者 → deriveSeats 的 k=1 恒把 creator 作为治者 → governorSet 含 ID_A。
  db.execute(
    `INSERT INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
    ["g1", ID_A, 1, 1, 1, "[]", "[]", "e1", "2024-01-01T00:00:00Z"],
  );
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeHandler(limiters?: { byID?: IpLimiter; byIP?: IpLimiter }): AuthedHandler {
  return submitPostHandler({
    db,
    storeKey: STORE_KEY,
    byID: limiters?.byID ?? new IpLimiter(SUBMIT_PER_MINUTE_PER_ID, SUBMIT_BURST_PER_ID),
    byIP: limiters?.byIP ?? new IpLimiter(SUBMIT_PER_MINUTE_PER_IP, SUBMIT_BURST_PER_IP),
  });
}

async function post(
  actor: string,
  body: Record<string, unknown>,
  handler?: AuthedHandler,
): Promise<ServerResponse> {
  const h = handler ?? makeHandler();
  const req = {
    method: "POST",
    path: "/v1/submit",
    params: {},
    query: {},
    headers: {},
    body: new Uint8Array(Buffer.from(JSON.stringify(body), "utf8")),
  } as ServerRequest;
  return h(req, actor);
}

function text(res: ServerResponse): string {
  return Buffer.from(res.body ?? new Uint8Array()).toString("utf8");
}

function jsonOf(res: ServerResponse): Record<string, unknown> {
  return JSON.parse(text(res)) as Record<string, unknown>;
}

/** 客户端侧算 author_sig（治理册 §2.1 的规范化签名字节）。 */
function sigOf(seed: string, itemId: string, contentHash: string, authorId: string): string {
  return sign(seed, utf8(authorSignBytes(itemId, contentHash, authorId)));
}

/** 直插一条 state 可控的 items 行（供打标目标 / 占用 / 存量空归属用）。 */
function insertItem(itemId: string, type: string, state: string, authorId: string, bodyMd = ""): void {
  const hash = sha256Hex(utf8(bodyMd));
  db.execute(
    `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      itemId,
      type,
      type,
      itemId,
      hash.slice(0, 16),
      hash,
      type === "article" ? "articles" : "segments",
      "public",
      state,
      "2024-01-01T00:00:00Z",
      authorId,
      "",
    ],
  );
  if (type === "article") {
    db.execute(
      `INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev)
        VALUES(?,?,?,?,?,?,?,?)`,
      [itemId, itemId, "", "", "[]", bodyMd, hash, hash.slice(0, 16)],
    );
  }
}

describe("article", () => {
  const ITEM = "article/hello-world";
  const BODY = "hello";
  const HASH = sha256Hex(utf8(BODY));

  it("直角 200：items + articles 落库、body_md 密文可解密", async () => {
    const sig = sigOf(SEED_A, ITEM, HASH, ID_A);
    const res = await post(ID_A, {
      type: "article",
      item_id: ITEM,
      title: "Hello",
      body_md: BODY,
      author_sig: sig,
    });
    expect(res.status).toBe(200);
    expect(text(res)).toBe(
      JSON.stringify({
        author_id: ID_A,
        content_hash: HASH,
        created: true,
        item_id: ITEM,
        type: "article",
      }) + "\n",
    );

    const it = db.select(`SELECT * FROM items WHERE item_id=?`, [ITEM]);
    expect(it.length).toBe(1);
    expect(String(it[0].source)).toBe("article");
    expect(String(it[0].type)).toBe("article");
    expect(String(it[0].sqlite_table)).toBe("articles");
    expect(String(it[0].dist_class)).toBe("public");
    expect(String(it[0].state)).toBe("active");
    expect(String(it[0].author_id)).toBe(ID_A);
    expect(String(it[0].author_sig)).toBe(sig);
    expect(String(it[0].content_hash)).toBe(HASH);
    expect(String(it[0].source_rev)).toBe(HASH.slice(0, 16));

    const ar = db.select(`SELECT * FROM articles WHERE item_id=?`, [ITEM]);
    expect(ar.length).toBe(1);
    expect(String(ar[0].title)).toBe("Hello");
    expect(String(ar[0].content_hash)).toBe(HASH);
    expect(String(ar[0].tags_json)).toBe("[]");
    expect(String(ar[0].body_md).startsWith("enc:v1:")).toBe(true);
    expect(decText(STORE_KEY, String(ar[0].body_md))).toBe(BODY);
  });

  it("同作者重复投稿：created:false 且不新建行", async () => {
    const res = await post(ID_A, {
      type: "article",
      item_id: ITEM,
      title: "Hello",
      body_md: BODY,
      author_sig: sigOf(SEED_A, ITEM, HASH, ID_A),
    });
    expect(res.status).toBe(200);
    expect(jsonOf(res).created).toBe(false);
    expect(db.select(`SELECT 1 FROM items WHERE item_id=?`, [ITEM]).length).toBe(1);
  });

  it("他人占用同 item_id → 403 item_id_taken", async () => {
    const res = await post(ID_B, {
      type: "article",
      item_id: ITEM,
      title: "Hello",
      body_md: BODY,
      author_sig: sigOf(SEED_B, ITEM, HASH, ID_B),
    });
    expect(res.status).toBe(403);
    expect(text(res)).toBe(`{"code":"item_id_taken","error":"该 item_id 已被占用"}\n`);
  });

  it("空归属存量条目也拒 → 403 item_id_taken", async () => {
    insertItem("article/legacy", "article", "active", "");
    const h = sha256Hex(utf8("x"));
    const res = await post(ID_A, {
      type: "article",
      item_id: "article/legacy",
      title: "Legacy",
      body_md: "x",
      author_sig: sigOf(SEED_A, "article/legacy", h, ID_A),
    });
    expect(res.status).toBe(403);
    expect(jsonOf(res).code).toBe("item_id_taken");
  });
});

describe("author_id 出现即禁止", () => {
  for (const [label, value] of [
    ["空串", ""],
    ["null", null],
  ] as const) {
    it(`author_id=${label} → 400 author_id_forbidden`, async () => {
      const res = await post(ID_A, {
        type: "article",
        item_id: "article/forbid",
        title: "F",
        body_md: "x",
        author_sig: "aa".repeat(32),
        author_id: value,
      });
      expect(res.status).toBe(400);
      expect(text(res)).toBe(
        `{"code":"author_id_forbidden","error":"请求体不得携带身份字段（author_id / proposer_id / id 等）"}\n`,
      );
    });
  }
});

describe("type / item_id 形态", () => {
  it("type 非法 → 400 item_type_unsupported", async () => {
    const res = await post(ID_A, { type: "video", item_id: "article/x", title: "x" });
    expect(res.status).toBe(400);
    expect(jsonOf(res).code).toBe("item_type_unsupported");
  });

  it("article 传 course/x → 400 item_id_invalid", async () => {
    const res = await post(ID_A, { type: "article", item_id: "course/x", title: "x", body_md: "b" });
    expect(res.status).toBe(400);
    expect(jsonOf(res).code).toBe("item_id_invalid");
  });

  it("article 传 quiz/x → 400 item_type_mismatch", async () => {
    const res = await post(ID_A, { type: "article", item_id: "quiz/x", title: "x", body_md: "b" });
    expect(res.status).toBe(400);
    expect(jsonOf(res).code).toBe("item_type_mismatch");
  });

  it("slug 非法（大写）→ 400 item_id_invalid", async () => {
    const res = await post(ID_A, { type: "article", item_id: "article/BAD", title: "x", body_md: "b" });
    expect(res.status).toBe(400);
    expect(jsonOf(res).code).toBe("item_id_invalid");
  });

  it("course 传 lesson/x → 400 item_id_invalid", async () => {
    const res = await post(ID_A, { type: "course", item_id: "lesson/x", title: "x" });
    expect(res.status).toBe(400);
    expect(jsonOf(res).code).toBe("item_id_invalid");
  });

  it("course 传 course/c1/lesson/l1 → 400 item_type_mismatch", async () => {
    const res = await post(ID_A, { type: "course", item_id: "course/c1/lesson/l1", title: "x" });
    expect(res.status).toBe(400);
    expect(jsonOf(res).code).toBe("item_type_mismatch");
  });
});

describe("title", () => {
  it("空串 → 400 item_title_invalid", async () => {
    const res = await post(ID_A, { type: "article", item_id: "article/t1", title: "", body_md: "b" });
    expect(res.status).toBe(400);
    expect(jsonOf(res).code).toBe("item_title_invalid");
  });

  it("201 rune → 400 item_title_invalid", async () => {
    const res = await post(ID_A, {
      type: "article",
      item_id: "article/t2",
      title: "a".repeat(201),
      body_md: "b",
    });
    expect(res.status).toBe(400);
    expect(jsonOf(res).code).toBe("item_title_invalid");
  });

  it("含控制字符 → 400 item_title_invalid", async () => {
    const res = await post(ID_A, {
      type: "article",
      item_id: "article/t3",
      title: "bad\u0001title",
      body_md: "b",
    });
    expect(res.status).toBe(400);
    expect(jsonOf(res).code).toBe("item_title_invalid");
  });
});

describe("正文体量", () => {
  it("body_md > 32768 字节 → 413 item_body_too_large", async () => {
    const res = await post(ID_A, {
      type: "article",
      item_id: "article/big",
      title: "Big",
      body_md: "a".repeat(32769),
    });
    expect(res.status).toBe(413);
    expect(text(res)).toBe(`{"code":"item_body_too_large","error":"正文超过 32768 字节"}\n`);
  });

  it("恰好 32768 字节放行到验签（非 413）", async () => {
    const body = "a".repeat(32768);
    const h = sha256Hex(utf8(body));
    const res = await post(ID_A, {
      type: "article",
      item_id: "article/edge",
      title: "Edge",
      body_md: body,
      author_sig: sigOf(SEED_A, "article/edge", h, ID_A),
    });
    expect(res.status).toBe(200);
    expect(jsonOf(res).content_hash).toBe(h);
  });
});

describe("quiz", () => {
  const Q = JSON.stringify({ schema_version: 1, questions: [{ q: 1 }] });
  const HASH = sha256Hex(utf8(Q));

  it("直角 200：quizzes 落库", async () => {
    const res = await post(ID_A, {
      type: "quiz",
      item_id: "quiz/q1",
      title: "Q1",
      question_json: Q,
      author_sig: sigOf(SEED_A, "quiz/q1", HASH, ID_A),
    });
    expect(res.status).toBe(200);
    expect(text(res)).toBe(
      JSON.stringify({
        author_id: ID_A,
        content_hash: HASH,
        created: true,
        item_id: "quiz/q1",
        type: "quiz",
      }) + "\n",
    );
    const it0 = db.select(`SELECT * FROM items WHERE item_id=?`, ["quiz/q1"]);
    expect(String(it0[0].sqlite_table)).toBe("quizzes");
    const qs = db.select(`SELECT * FROM quizzes WHERE item_id=?`, ["quiz/q1"]);
    expect(String(qs[0].question_json)).toBe(Q);
    expect(String(qs[0].content_hash)).toBe(HASH);
  });

  for (const [label, q] of [
    ["非 JSON", "{oops"],
    ["schema_version != 1", JSON.stringify({ schema_version: 2, questions: [1] })],
    ["questions 空数组", JSON.stringify({ schema_version: 1, questions: [] })],
    ["questions 缺失", JSON.stringify({ schema_version: 1 })],
  ] as const) {
    it(`${label} → 400 item_question_invalid`, async () => {
      const res = await post(ID_A, {
        type: "quiz",
        item_id: "quiz/bad",
        title: "Q",
        question_json: q,
        author_sig: "aa".repeat(32),
      });
      expect(res.status).toBe(400);
      expect(jsonOf(res).code).toBe("item_question_invalid");
    });
  }
});

describe("author_sig", () => {
  const ITEM = "article/sig";
  const BODY = "sig-body";
  const HASH = sha256Hex(utf8(BODY));

  it("非 64 位 hex → 400 author_sig_invalid", async () => {
    const res = await post(ID_A, {
      type: "article",
      item_id: ITEM,
      title: "S",
      body_md: BODY,
      author_sig: "abc",
    });
    expect(res.status).toBe(400);
    expect(jsonOf(res).code).toBe("author_sig_invalid");
  });

  it("64 位 hex 但错签 → 400 author_sig_invalid", async () => {
    const res = await post(ID_A, {
      type: "article",
      item_id: ITEM,
      title: "S",
      body_md: BODY,
      author_sig: "00".repeat(32),
    });
    expect(res.status).toBe(400);
    expect(jsonOf(res).code).toBe("author_sig_invalid");
  });

  it("用他人私钥签 → 400 author_sig_invalid", async () => {
    const res = await post(ID_A, {
      type: "article",
      item_id: ITEM,
      title: "S",
      body_md: BODY,
      author_sig: sigOf(SEED_B, ITEM, HASH, ID_A),
    });
    expect(res.status).toBe(400);
    expect(jsonOf(res).code).toBe("author_sig_invalid");
  });
});

describe("course 容器", () => {
  const C = "course/c1";
  const L = "course/c1/lesson/l1";
  const SEGS = [
    { seq: 1, kind: "lesson", text: L },
    { seq: 0, kind: "digest", text: "简介" },
    { seq: -1, kind: "attr.difficulty", text: "basic" },
  ];
  const HASH = protoSegmentsHash(SEGS);

  it("直角 200：items.sqlite_table='segments'、segments 三行内容正确", async () => {
    const res = await post(ID_A, {
      type: "course",
      item_id: C,
      title: "Course 1",
      segments: SEGS,
      author_sig: sigOf(SEED_A, C, HASH, ID_A),
    });
    expect(res.status).toBe(200);
    expect(text(res)).toBe(
      JSON.stringify({
        author_id: ID_A,
        content_hash: HASH,
        created: true,
        item_id: C,
        type: "course",
      }) + "\n",
    );
    const it0 = db.select(`SELECT * FROM items WHERE item_id=?`, [C]);
    expect(String(it0[0].type)).toBe("course");
    expect(String(it0[0].sqlite_table)).toBe("segments");
    expect(String(it0[0].content_hash)).toBe(HASH);
    expect(String(it0[0].source_rev)).toBe(HASH.slice(0, 16));

    const rows = db.select(`SELECT seq,kind,text,content_hash FROM segments WHERE item_id=? ORDER BY seq ASC`, [
      C,
    ]);
    expect(rows.length).toBe(3);
    expect(rows.map((r) => [Number(r.seq), String(r.kind), String(r.text)])).toEqual([
      [-1, "attr.difficulty", "basic"],
      [0, "digest", "简介"],
      [1, "lesson", L],
    ]);
    for (const r of rows) {
      expect(String(r.content_hash)).toBe(sha256Hex(utf8(String(r.text))));
    }
  });

  it("同一作者重投：created:false 且 segments 全量替换不残留", async () => {
    const res = await post(ID_A, {
      type: "course",
      item_id: C,
      title: "Course 1",
      segments: SEGS,
      author_sig: sigOf(SEED_A, C, HASH, ID_A),
    });
    expect(res.status).toBe(200);
    expect(jsonOf(res).created).toBe(false);
    expect(db.select(`SELECT 1 FROM segments WHERE item_id=?`, [C]).length).toBe(3);
  });

  for (const [label, segs] of [
    ["seq<0 非属性行", [{ seq: -1, kind: "lesson", text: "x" }]],
    ["seq=0 非 digest", [{ seq: 0, kind: "article", text: "x" }]],
    ["seq>=1 非本容器子项", [{ seq: 1, kind: "article", text: "x" }]],
    [
      "seq 重复",
      [
        { seq: 1, kind: "lesson", text: "a" },
        { seq: 1, kind: "lesson", text: "b" },
      ],
    ],
    ["属性行非规范排布", [{ seq: -2, kind: "attr.difficulty", text: "basic" }]],
  ] as const) {
    it(`${label} → 400 item_segments_invalid`, async () => {
      const res = await post(ID_A, {
        type: "course",
        item_id: "course/c9",
        title: "C9",
        segments: segs,
        author_sig: "aa".repeat(32),
      });
      expect(res.status).toBe(400);
      expect(jsonOf(res).code).toBe("item_segments_invalid");
    });
  }

  it("lesson 容器直角 200（子项可为 quiz）", async () => {
    const LI = "course/c2/lesson/l2";
    const segs = [{ seq: 1, kind: "quiz", text: "quiz/q2" }];
    const hash = protoSegmentsHash(segs);
    const res = await post(ID_A, {
      type: "lesson",
      item_id: LI,
      title: "Lesson 2",
      segments: segs,
      author_sig: sigOf(SEED_A, LI, hash, ID_A),
    });
    expect(res.status).toBe(200);
    expect(jsonOf(res).created).toBe(true);
    const it0 = db.select(`SELECT * FROM items WHERE item_id=?`, [LI]);
    expect(String(it0[0].sqlite_table)).toBe("segments");
    expect(String(it0[0].type)).toBe("lesson");
  });
});

describe("tag", () => {
  const TGT = "article/tag-target";

  beforeAll(() => {
    insertItem(TGT, "article", "active", ID_B, "target body");
  });

  function tagBody(itemId: string, links: unknown[], over: Record<string, unknown> = {}) {
    const title = tagTitle(...(itemId.split("/").slice(1) as [string, string, string]));
    const hash = protoSegmentsHash(
      (links as { target_id: string; kind: string }[]).map((l, i) => ({
        seq: i + 1,
        kind: l.kind,
        text: l.target_id,
      })),
    );
    return {
      type: "tag",
      item_id: itemId,
      title,
      links,
      author_sig: sigOf(SEED_A, itemId, hash, ID_A),
      ...over,
    };
  }

  it("直角 200：created 恒 false，tag_links / segments 正确", async () => {
    const itemId = encodeTagPath("Alpha", "Ch1", "Sec1");
    const links = [{ target_id: TGT, kind: "article" }];
    const hash = protoSegmentsHash([{ seq: 1, kind: "article", text: TGT }]);
    const res = await post(ID_A, tagBody(itemId, links));
    expect(res.status).toBe(200);
    expect(text(res)).toBe(
      JSON.stringify({
        author_id: ID_A,
        content_hash: hash,
        created: false,
        item_id: itemId,
        type: "tag",
      }) + "\n",
    );

    const it0 = db.select(`SELECT * FROM items WHERE item_id=?`, [itemId]);
    expect(String(it0[0].type)).toBe("tag");
    expect(String(it0[0].sqlite_table)).toBe("segments");
    expect(String(it0[0].author_id)).toBe(ID_A);
    expect(String(it0[0].title)).toBe(tagTitle("Alpha", "Ch1", "Sec1"));
    expect(String(it0[0].content_hash)).toBe(hash);

    const tl = db.select(`SELECT * FROM tag_links WHERE tag_id=?`, [itemId]);
    expect(tl.length).toBe(1);
    expect(String(tl[0].target_id)).toBe(TGT);
    expect(String(tl[0].kind)).toBe("article");
    expect(String(tl[0].created_at).endsWith("Z")).toBe(true);

    const segs = db.select(`SELECT seq,kind,text,content_hash FROM segments WHERE item_id=?`, [itemId]);
    expect(segs.length).toBe(1);
    expect(Number(segs[0].seq)).toBe(1);
    expect(String(segs[0].kind)).toBe("article");
    expect(String(segs[0].text)).toBe(TGT);
    expect(String(segs[0].content_hash)).toBe(sha256Hex(utf8(TGT)));
  });

  it("非治理人 → 403 tag_not_governor", async () => {
    const res = await post(
      ID_B,
      tagBody(encodeTagPath("Beta", "Ch1", "Sec1"), [{ target_id: TGT, kind: "article" }]),
    );
    expect(res.status).toBe(403);
    expect(text(res)).toBe(
      `{"code":"tag_not_governor","error":"只有治理人（全站名册或圈子治者）能给无标签内容打标签"}\n`,
    );
  });

  it("目标不存在 → 400 tag_target_not_found", async () => {
    const res = await post(
      ID_A,
      tagBody(encodeTagPath("Gamma", "Ch1", "Sec1"), [
        { target_id: "article/nope", kind: "article" },
      ]),
    );
    expect(res.status).toBe(400);
    expect(jsonOf(res).code).toBe("tag_target_not_found");
  });

  it("目标 state 非 active → 400 tag_target_not_found", async () => {
    insertItem("article/gone", "article", "removed", ID_B);
    const res = await post(
      ID_A,
      tagBody(encodeTagPath("Gone", "Ch1", "Sec1"), [
        { target_id: "article/gone", kind: "article" },
      ]),
    );
    expect(res.status).toBe(400);
    expect(jsonOf(res).code).toBe("tag_target_not_found");
  });

  it("comment 目标未收到事件 → 400；收到 comment.v1 后 200", async () => {
    const hex32 = "ab".repeat(16);
    const commentTarget = `comment/${hex32}`;
    const itemId = encodeTagPath("Delta", "Ch1", "Sec1");
    const links = [{ target_id: commentTarget, kind: "comment" }];
    const missing = await post(ID_A, tagBody(itemId, links));
    expect(missing.status).toBe(400);
    expect(jsonOf(missing).code).toBe("tag_target_not_found");

    db.execute(
      `INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
        VALUES(?,?,?,?,?,?,?,?,?)`,
      [hex32, ID_B, "comment.v1", "{}", TS, TS, "article/tag-target", "cid", ""],
    );
    const ok = await post(ID_A, tagBody(itemId, links));
    expect(ok.status).toBe(200);
    expect(jsonOf(ok).created).toBe(false);
    const segs = db.select(`SELECT kind,text FROM segments WHERE item_id=?`, [itemId]);
    expect(String(segs[0].kind)).toBe("comment");
    expect(String(segs[0].text)).toBe(commentTarget);
  });

  it("kind 与 target 形态不符 → 400 tag_links_invalid", async () => {
    const res = await post(
      ID_A,
      tagBody(encodeTagPath("Epsilon", "Ch1", "Sec1"), [{ target_id: TGT, kind: "course" }]),
    );
    expect(res.status).toBe(400);
    expect(text(res)).toBe(
      `{"code":"tag_links_invalid","error":"links 不合法：kind 必须与 target_id 形态一致，且同一 target_id 不得重复"}\n`,
    );
  });

  it("target 重复 → 400 tag_links_invalid", async () => {
    const res = await post(
      ID_A,
      tagBody(encodeTagPath("Zeta", "Ch1", "Sec1"), [
        { target_id: TGT, kind: "article" },
        { target_id: TGT, kind: "article" },
      ]),
    );
    expect(res.status).toBe(400);
    expect(jsonOf(res).code).toBe("tag_links_invalid");
  });

  it("title 与 tagTitle 不符 → 400 item_title_invalid", async () => {
    const res = await post(
      ID_A,
      tagBody(encodeTagPath("Eta", "Ch1", "Sec1"), [{ target_id: TGT, kind: "article" }], {
        title: "wrong title",
      }),
    );
    expect(res.status).toBe(400);
    expect(jsonOf(res).code).toBe("item_title_invalid");
  });

  it("目标已被别的标签占用 → 403 tag_target_tagged", async () => {
    insertItem("article/tag-target2", "article", "active", ID_B);
    const first = await post(
      ID_A,
      tagBody(encodeTagPath("Theta", "Ch1", "Sec1"), [
        { target_id: "article/tag-target2", kind: "article" },
      ]),
    );
    expect(first.status).toBe(200);
    const second = await post(
      ID_A,
      tagBody(encodeTagPath("Iota", "Ch1", "Sec1"), [
        { target_id: "article/tag-target2", kind: "article" },
      ]),
    );
    expect(second.status).toBe(403);
    expect(text(second)).toBe(`{"code":"tag_target_tagged","error":"该内容已有标签，改动请走治理提案"}\n`);
  });
});

describe("限速", () => {
  it("同一身份第 4 发即 429 item_rate_limited（burst 3）", async () => {
    const handler = makeHandler();
    const ITEM = "article/rate";
    const HASH = sha256Hex(utf8("r"));
    const body = {
      type: "article",
      item_id: ITEM,
      title: "Rate",
      body_md: "r",
      author_sig: sigOf(SEED_A, ITEM, HASH, ID_A),
    };
    for (let i = 0; i < 3; i++) {
      const res = await post(ID_A, body, handler);
      expect(res.status, `第 ${i + 1} 发应放行`).toBe(200);
    }
    const fourth = await post(ID_A, body, handler);
    expect(fourth.status).toBe(429);
    expect(text(fourth)).toBe(`{"code":"item_rate_limited","error":"投稿过于频繁"}\n`);
  });
});

describe("鉴权身份未登记", () => {
  it("LookupIdentity 无行 → 403 identity_unregistered（已过限速与体校验）", async () => {
    const UNREG = "cd".repeat(16);
    const res = await post(UNREG, {
      type: "article",
      item_id: "article/unreg",
      title: "U",
      body_md: "u",
      author_sig: "aa".repeat(32),
    });
    expect(res.status).toBe(403);
    expect(jsonOf(res).code).toBe("identity_unregistered");
  });
});

// 圈名单与圈内发言事件共同决定治者资格（GovernorSet = 全站名册 ∪ 各圈治者）。
describe("GovernorSet 派生", () => {
  const SEED_C = "c3".repeat(32);
  const SEED_D = "d4".repeat(32);
  const ID_C = deriveIdentityId(keyPairFromSeed(SEED_C).pubHex);
  const ID_D = deriveIdentityId(keyPairFromSeed(SEED_D).pubHex);

  function register(seed: string, id: string): void {
    db.execute(`INSERT INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, [
      id,
      "ed25519",
      keyPairFromSeed(seed).pubHex,
      TS,
      0,
    ]);
  }

  function insertGroup(
    groupId: string,
    creatorId: string,
    memberIdsJson: string,
    eventId: string,
  ): void {
    db.execute(
      `INSERT INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
      [groupId, creatorId, 1, 1, 1, memberIdsJson, "[]", eventId, "2024-01-01T00:00:00Z"],
    );
  }

  function insertGroupMsg(eventId: string, actor: string, groupId: string, bodyJson: string): void {
    db.execute(
      `INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
        VALUES(?,?,?,?,?,?,?,?,?)`,
      [eventId, actor, "group.v1", bodyJson, TS, TS, `group/${groupId}`, "cid", ""],
    );
  }

  function tagReq(seed: string, id: string, itemId: string, targetId: string) {
    const hash = protoSegmentsHash([{ seq: 1, kind: "article", text: targetId }]);
    return {
      type: "tag",
      item_id: itemId,
      title: tagTitle(...(itemId.split("/").slice(1) as [string, string, string])),
      links: [{ target_id: targetId, kind: "article" }],
      author_sig: sigOf(seed, itemId, hash, id),
    };
  }

  it("圈名单含 null 元素时整圈保留（null 解成 \"\"），其贡献者仍是治者", async () => {
    register(SEED_C, ID_C);
    // 11 名成员（k=3），第 2 个元素为 null：Go 解成 ""，圈**不**被跳过。
    const members = JSON.stringify([ID_C, null, ...Array.from({ length: 9 }, (_, i) => `m${i}`)]);
    insertGroup("g2", ID_A, members, "ge2");
    insertGroupMsg("g2e1", ID_C, "g2", `{"action":"msg"}`);
    insertItem("article/seat-target", "article", "active", ID_A);
    const res = await post(
      ID_C,
      tagReq(SEED_C, ID_C, encodeTagPath("Seat", "Ch1", "Sec1"), "article/seat-target"),
    );
    expect(res.status).toBe(200);
    expect(jsonOf(res).created).toBe(false);
  });

  it("groupBodyAction 取键大小写不敏感（Action 亦算 msg）", async () => {
    register(SEED_D, ID_D);
    // 11 名成员（k=3）；ID_D 的字典序排在 "00"/"01" 之后——只有本条件计入贡献时它才进前二。
    const members = JSON.stringify(["00", "01", ID_D, ...Array.from({ length: 8 }, (_, i) => `m${i}`)]);
    insertGroup("g3", "creator-x", members, "ge3");
    insertGroupMsg("g3e1", ID_D, "g3", `{"Action":"msg"}`);
    insertItem("article/seat-target2", "article", "active", ID_A);
    const res = await post(
      ID_D,
      tagReq(SEED_D, ID_D, encodeTagPath("Seat2", "Ch1", "Sec1"), "article/seat-target2"),
    );
    expect(res.status).toBe(200);
  });
});