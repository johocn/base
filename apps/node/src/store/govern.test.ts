// 治理签名写路径 store 层（govern.ts）的单测：逐条对齐 internal/store 的
// govern.go / directory.go / store.go 写 / 读面。建库风格参照 store.test.ts 与 directory.test.ts。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex, utf8 } from "@base/protocol-ts";
import { openDb, type Db } from "../db";
import { decText, encText } from "../host/aesgcm";
import { directoryProposalItemId } from "../routes/derived";
import { itemColumnMigrations, schemaStatements } from "./schema";
import {
  addVote,
  AlreadyVotedError,
  createDirectoryProposal,
  createProposal,
  directoryPendingVotes,
  encodeTagLinks,
  findPendingDirectoryProposal,
  getDirectoryTerm,
  getItemRow,
  type ProposalInput,
} from "./govern";

const KEY = new Uint8Array(32).fill(9);

const opened: { db: Db; dir: string }[] = [];

function newDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "base-node-govern-"));
  const db = openDb(join(dir, "base.db"));
  for (const stmt of schemaStatements) db.execute(stmt);
  // itemColumnMigrations 里部分列已在 schemaStatements（pin_level/pinned_at/highlight_until/instructor/tags_json），
  // 判重跳过，只补 author_id/author_sig 这些 schemaStatements 里没有的后加列。
  const cols = new Set<string>();
  for (const r of (db as unknown as { select(sql: string): { name: unknown }[] }).select(
    `PRAGMA table_info(items)`,
  )) {
    cols.add(String(r.name));
  }
  for (const m of itemColumnMigrations) {
    if (cols.has(m.column)) continue;
    db.execute(m.ddl);
  }
  opened.push({ db, dir });
  return db;
}

afterEach(() => {
  while (opened.length > 0) {
    const { db, dir } = opened.pop() as { db: Db; dir: string };
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄释放竞态，忽略 */
    }
  }
});

interface ItemOpts {
  type?: string;
  state?: string;
  authorId?: string;
  authorSig?: string;
  contentHash?: string;
  sqliteTable?: string;
  title?: string;
}

function putItem(db: Db, itemId: string, o: ItemOpts = {}): void {
  const type = o.type ?? "article";
  db.execute(
    `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      itemId,
      type,
      type,
      o.title ?? "T",
      "r",
      o.contentHash ?? "h",
      o.sqliteTable ?? "articles",
      "public",
      o.state ?? "active",
      "2024-01-01T00:00:00Z",
      o.authorId ?? "",
      o.authorSig ?? "",
    ],
  );
}

function putArticle(db: Db, itemId: string, bodyMd: string, contentHash: string): void {
  db.execute(
    `INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev) VALUES(?,?,?,?,?,?,?,?)`,
    [itemId, "T", "", "", "[]", bodyMd, contentHash, "r"],
  );
}

function putMeta(db: Db, key: string, value: string): void {
  db.execute(`INSERT INTO meta(key,value) VALUES(?,?)`, [key, value]);
}

/** 一条提案入参（默认 remove，可覆写）。 */
function input(over: Partial<ProposalInput> & { action: string; itemId: string }): ProposalInput {
  return {
    action: over.action,
    itemId: over.itemId,
    proposerId: over.proposerId ?? "p",
    reason: over.reason ?? "r",
    title: over.title ?? "",
    bodyMd: over.bodyMd ?? "",
    linksJson: over.linksJson ?? "",
    baseContentHash: over.baseContentHash ?? "h",
    createdAt: over.createdAt ?? 1,
  };
}

function proposalRow(db: Db, id: number): Record<string, unknown> {
  return db.select(
    `SELECT action,item_id,proposer_id,reason,title,body_md,links_json,base_content_hash,created_at,executed_at,voided_at,executed_result,source_event_id,content_version,revoked_rev FROM govern_proposals WHERE proposal_id=?`,
    [id],
  )[0];
}

describe("createProposal", () => {
  it("返回自增 id；11 列正确；水位两列取当前 meta / MAX(revoked_rev)；恰 1 票", () => {
    const db = newDb();
    putMeta(db, "content_version", "7");
    db.execute(`INSERT INTO tombstones(item_id,revoked_rev) VALUES('article/old1',4)`);
    db.execute(`INSERT INTO tombstones(item_id,revoked_rev) VALUES('article/old2',9)`);

    const id = createProposal(
      db,
      input({
        action: "remove",
        itemId: "article/a1",
        proposerId: "p",
        reason: "why",
        baseContentHash: "h1",
        createdAt: 1234,
      }),
    );
    expect(id).toBe(1);

    const row = proposalRow(db, id);
    expect(row.action).toBe("remove");
    expect(row.item_id).toBe("article/a1");
    expect(row.proposer_id).toBe("p");
    expect(row.reason).toBe("why");
    expect(row.title).toBe("");
    expect(row.body_md).toBe("");
    expect(row.links_json).toBe("");
    expect(row.base_content_hash).toBe("h1");
    expect(Number(row.created_at)).toBe(1234);
    expect(Number(row.executed_at)).toBe(0);
    expect(Number(row.voided_at)).toBe(0);
    expect(row.executed_result).toBe("");
    expect(row.source_event_id).toBeNull();
    expect(Number(row.content_version)).toBe(7);
    expect(Number(row.revoked_rev)).toBe(9);

    const votes = db.select(`SELECT voter_id,created_at,source_event_id FROM govern_votes`);
    expect(votes.length).toBe(1);
    expect(votes[0].voter_id).toBe("p");
    expect(Number(votes[0].created_at)).toBe(1234);
    expect(votes[0].source_event_id).toBeNull();
  });

  it("meta 无行 → content_version=0；无墓碑 → revoked_rev=0", () => {
    const db = newDb();
    const id = createProposal(db, input({ action: "remove", itemId: "article/a1" }));
    const row = proposalRow(db, id);
    expect(Number(row.content_version)).toBe(0);
    expect(Number(row.revoked_rev)).toBe(0);
  });
});

describe("createDirectoryProposal", () => {
  const dirItem = directoryProposalItemId("tag", "go");

  it("autoApprove=false → pending，不写词条、不动 directory_version", () => {
    const db = newDb();
    const { id, status } = createDirectoryProposal(
      db,
      input({ action: "directory_add", itemId: dirItem, title: "Go", bodyMd: "go", createdAt: 5 }),
      false,
    );
    expect(status).toBe("pending");
    expect(db.select(`SELECT * FROM directory_terms`).length).toBe(0);
    expect(db.select(`SELECT * FROM meta WHERE key='directory_version'`).length).toBe(0);
    const row = proposalRow(db, id);
    expect(Number(row.executed_at)).toBe(0);
    expect(row.executed_result).toBe("");
    expect(db.select(`SELECT * FROM govern_votes WHERE proposal_id=?`, [id]).length).toBe(1);
  });

  it("autoApprove=true → effective，词条 approved、版本=1、executed_at/result 落值", () => {
    const db = newDb();
    const { id, status } = createDirectoryProposal(
      db,
      input({ action: "directory_add", itemId: dirItem, title: "Go", bodyMd: "go", proposerId: "p" }),
      true,
    );
    expect(status).toBe("effective");
    const terms = db.select(
      `SELECT kind,term_key,display_name,state,first_author_id,created_at,updated_at FROM directory_terms`,
    );
    expect(terms.length).toBe(1);
    expect(terms[0].kind).toBe("tag");
    expect(terms[0].term_key).toBe("go");
    expect(terms[0].display_name).toBe("Go");
    expect(terms[0].state).toBe("approved");
    expect(terms[0].first_author_id).toBe("p");
    expect(db.select(`SELECT value FROM meta WHERE key='directory_version'`)[0].value).toBe("1");
    const row = proposalRow(db, id);
    expect(Number(row.executed_at)).not.toBe(0);
    expect(row.executed_result).toBe("directory_approved");
  });

  it("item_id 形态非法 → 抛错且整事务回滚（proposals/votes/directory_terms 全空）", () => {
    const db = newDb();
    expect(() =>
      createDirectoryProposal(db, input({ action: "directory_add", itemId: "bogus" }), true),
    ).toThrow(/形态非法/);
    expect(db.select(`SELECT * FROM govern_proposals`).length).toBe(0);
    expect(db.select(`SELECT * FROM govern_votes`).length).toBe(0);
    expect(db.select(`SELECT * FROM directory_terms`).length).toBe(0);
    expect(db.select(`SELECT * FROM meta WHERE key='directory_version'`).length).toBe(0);
  });
});

describe("addVote", () => {
  function roster(...ids: string[]): Set<string> {
    return new Set(ids);
  }

  it("重复投票 → AlreadyVotedError，票仍只有 1 行", () => {
    const db = newDb();
    putItem(db, "article/a1");
    const id = createProposal(db, input({ action: "remove", itemId: "article/a1" }));
    expect(() => addVote(db, null, id, "p", roster("p"))).toThrow(AlreadyVotedError);
    expect(db.select(`SELECT * FROM govern_votes WHERE proposal_id=?`, [id]).length).toBe(1);
  });

  it("remove 3 票生效：state=removed、墓碑 revoked_rev=content_version+1、executed_result=removed", () => {
    const db = newDb();
    putMeta(db, "content_version", "10");
    putItem(db, "article/a1", { contentHash: "h" });
    const id = createProposal(db, input({ action: "remove", itemId: "article/a1" }));
    const r = roster("p", "q", "s");

    const first = addVote(db, null, id, "q", r);
    expect(first).toMatchObject({ voteCount: 2, threshold: 3, status: "pending" });

    const second = addVote(db, null, id, "s", r);
    expect(second).toMatchObject({ voteCount: 3, threshold: 3, status: "effective" });

    expect(getItemRow(db, "article/a1")?.state).toBe("removed");
    const tomb = db.select(`SELECT revoked_rev FROM tombstones WHERE item_id=?`, ["article/a1"]);
    expect(tomb.length).toBe(1);
    expect(Number(tomb[0].revoked_rev)).toBe(11);
    const row = proposalRow(db, id);
    expect(Number(row.executed_at)).not.toBe(0);
    expect(Number(row.voided_at)).toBe(0);
    expect(row.executed_result).toBe("removed");
  });

  it("edit 2 票生效（改正文）：articles 全量覆盖 + items 清空 author_id/author_sig", () => {
    const db = newDb();
    putItem(db, "article/a2", { contentHash: "h2", authorId: "aa", authorSig: "sig" });
    putArticle(db, "article/a2", "old body", "h2");
    const id = createProposal(
      db,
      input({
        action: "edit",
        itemId: "article/a2",
        title: "newT",
        bodyMd: "new body",
        baseContentHash: "h2",
      }),
    );

    const res = addVote(db, KEY, id, "q", roster("p", "q"));
    expect(res).toMatchObject({ voteCount: 2, threshold: 2, status: "effective" });

    const hash = sha256Hex(utf8("new body"));
    expect(getItemRow(db, "article/a2")?.contentHash).toBe(hash);
    const item = db.select(`SELECT title,author_id,author_sig FROM items WHERE item_id=?`, [
      "article/a2",
    ])[0];
    expect(item.title).toBe("newT");
    expect(item.author_id).toBe("");
    expect(item.author_sig).toBe("");
    const art = db.select(
      `SELECT title,body_md,content_hash,source_rev FROM articles WHERE item_id=?`,
      ["article/a2"],
    )[0];
    expect(art.title).toBe("newT");
    // AES-GCM nonce 随机 ⇒ 密文不可复现，按解密后的明文断言（且必须是加密态）。
    expect(String(art.body_md).startsWith("enc:v1:")).toBe(true);
    expect(decText(KEY, String(art.body_md))).toBe("new body");
    expect(art.content_hash).toBe(hash);
    expect(art.source_rev).toBe(hash.slice(0, 16));
    expect(proposalRow(db, id).executed_result).toBe("edited_author_cleared");
  });

  it("edit 2 票生效（仅改标题、正文逐字节未变）：归属两列原样保留", () => {
    const db = newDb();
    const body = "正文逐字节未变";
    const hash = sha256Hex(utf8(body));
    putItem(db, "article/a3", { contentHash: hash, authorId: "aa", authorSig: "sig" });
    putArticle(db, "article/a3", encText(KEY, body), hash);
    const id = createProposal(
      db,
      input({
        action: "edit",
        itemId: "article/a3",
        title: "改标题",
        bodyMd: body,
        baseContentHash: hash,
      }),
    );

    const res = addVote(db, KEY, id, "q", roster("p", "q"));
    expect(res.status).toBe("effective");
    const item = db.select(`SELECT title,author_id,author_sig FROM items WHERE item_id=?`, [
      "article/a3",
    ])[0];
    expect(item.title).toBe("改标题");
    expect(item.author_id).toBe("aa");
    expect(item.author_sig).toBe("sig");
    expect(proposalRow(db, id).executed_result).toBe("edited");
  });

  it("revive 2 票生效：删墓碑 + 回 active", () => {
    const db = newDb();
    putItem(db, "article/a4", { state: "removed", contentHash: "h4" });
    db.execute(`INSERT INTO tombstones(item_id,revoked_rev) VALUES('article/a4',5)`);
    const id = createProposal(
      db,
      input({ action: "revive", itemId: "article/a4", baseContentHash: "h4" }),
    );

    const res = addVote(db, null, id, "q", roster("p", "q"));
    expect(res).toMatchObject({ voteCount: 2, threshold: 2, status: "effective" });
    expect(getItemRow(db, "article/a4")?.state).toBe("active");
    expect(db.select(`SELECT * FROM tombstones WHERE item_id=?`, ["article/a4"]).length).toBe(0);
    expect(proposalRow(db, id).executed_result).toBe("revived");
  });

  it("前置条件不满足（content_hash 被改）→ voided_at 落值、status=void、不执行动作", () => {
    const db = newDb();
    putItem(db, "article/a5", { contentHash: "changed" });
    const id = createProposal(db, input({ action: "remove", itemId: "article/a5" }));
    const r = roster("p", "q", "s", "t");
    addVote(db, null, id, "q", r);
    addVote(db, null, id, "s", r);

    const res = addVote(db, null, id, "t", r);
    expect(res).toMatchObject({ voteCount: 4, threshold: 3, status: "void" });
    const row = proposalRow(db, id);
    expect(Number(row.voided_at)).not.toBe(0);
    expect(Number(row.executed_at)).toBe(0);
    expect(getItemRow(db, "article/a5")?.state).toBe("active");
  });

  it("前置条件不满足（state 不匹配：revive 目标仍 active）→ void", () => {
    const db = newDb();
    putItem(db, "article/a6", { state: "active", contentHash: "h6" });
    const id = createProposal(db, input({ action: "revive", itemId: "article/a6", baseContentHash: "h6" }));
    const res = addVote(db, null, id, "q", roster("p", "q"));
    expect(res.status).toBe("void");
    expect(Number(proposalRow(db, id).voided_at)).not.toBe(0);
  });

  it("前置条件不满足（目标不存在）→ void", () => {
    const db = newDb();
    const id = createProposal(db, input({ action: "remove", itemId: "article/gone" }));
    const r = roster("p", "q", "s");
    addVote(db, null, id, "q", r);
    const res = addVote(db, null, id, "s", r);
    expect(res.status).toBe("void");
    expect(Number(proposalRow(db, id).voided_at)).not.toBe(0);
  });

  it("已定案后再投：票落库，status 仍为既定案值，不重复结算", () => {
    const db = newDb();
    putItem(db, "article/a1");
    const id = createProposal(db, input({ action: "remove", itemId: "article/a1" }));
    const r = roster("p", "q", "s", "t");
    addVote(db, null, id, "q", r);
    addVote(db, null, id, "s", r);
    const before = Number(proposalRow(db, id).executed_at);

    const res = addVote(db, null, id, "t", r);
    expect(res).toMatchObject({ voteCount: 4, threshold: 3, status: "effective" });
    expect(Number(proposalRow(db, id).executed_at)).toBe(before);
    expect(db.select(`SELECT * FROM govern_votes WHERE proposal_id=?`, [id]).length).toBe(4);
  });

  it("名册为空 → voteCount=0、status=pending、无 executed/voided", () => {
    const db = newDb();
    putItem(db, "article/a7");
    const id = createProposal(db, input({ action: "remove", itemId: "article/a7" }));
    const res = addVote(db, null, id, "z", new Set());
    expect(res).toMatchObject({ voteCount: 0, threshold: 3, status: "pending" });
    const row = proposalRow(db, id);
    expect(Number(row.executed_at)).toBe(0);
    expect(Number(row.voided_at)).toBe(0);
  });

  it("directory_add 2 票生效（名册 10 人）→ 词条落库 + 版本推进", () => {
    const db = newDb();
    const itemId = directoryProposalItemId("category", "go");
    const id = createProposal(
      db,
      input({
        action: "directory_add",
        itemId,
        title: "Go 语言",
        bodyMd: "go",
        baseContentHash: "",
      }),
    );
    const r = new Set(["p", "u0", "u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8"]);
    expect(r.size).toBe(10);

    const res = addVote(db, null, id, "u0", r);
    expect(res).toMatchObject({ voteCount: 2, threshold: 2, status: "effective" });

    const terms = db.select(`SELECT kind,term_key,display_name,state,first_author_id FROM directory_terms`);
    expect(terms.length).toBe(1);
    expect(terms[0].kind).toBe("category");
    expect(terms[0].term_key).toBe("go");
    expect(terms[0].display_name).toBe("Go 语言");
    expect(terms[0].state).toBe("approved");
    expect(terms[0].first_author_id).toBe("p");
    expect(db.select(`SELECT value FROM meta WHERE key='directory_version'`)[0].value).toBe("1");
    expect(proposalRow(db, id).executed_result).toBe("directory_approved");
  });

  it("Spec v2 shouldFreeExec：作者本人 + 无他人互动 + active → CreateProposal 直接生效 executed_result=free_exec:removed", () => {
    const db = newDb();
    putMeta(db, "content_version", "3");
    putItem(db, "course/c1", { type: "course", sqliteTable: "segments", authorId: "p" });
    const id = createProposal(db, input({ action: "remove", itemId: "course/c1" }));
    // ShouldFreeExec 快速路径：不需要投票
    expect(getItemRow(db, "course/c1")?.state).toBe("removed");
    const tomb = db.select(`SELECT revoked_rev FROM tombstones WHERE item_id=?`, ["course/c1"]);
    expect(Number(tomb[0].revoked_rev)).toBe(4);
    const row = proposalRow(db, id);
    expect(Number(row.executed_at)).not.toBe(0);
    expect(Number(row.voided_at)).toBe(0);
    expect(row.executed_result).toBe("free_exec:removed");
  });

  it("免票选删除反例：有课时且他人学过 → 退回 3 票", () => {
    const db = newDb();
    putItem(db, "course/c2", { type: "course", sqliteTable: "segments", authorId: "p" });
    db.execute(
      `INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES('course/c2',1,'lesson','course/c2/lesson/l1','x')`,
    );
    db.execute(
      `INSERT INTO progress(id,item_id,position,done,day,updated_at,event_id) VALUES('other','course/c2/lesson/l1',0,0,'d',1,'e')`,
    );
    const id = createProposal(db, input({ action: "remove", itemId: "course/c2" }));
    const res = addVote(db, null, id, "q", roster("p", "q"));
    expect(res).toMatchObject({ threshold: 3, status: "pending" });
  });

  it("免票选判定查询异常 → fail-closed 退回 3 票", () => {
    const db = newDb();
    putItem(db, "course/c3", { type: "course", sqliteTable: "segments", authorId: "p" });
    db.execute(
      `INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES('course/c3',1,'lesson','course/c3/lesson/l1','x')`,
    );
    db.execute(`DROP TABLE progress`); // 查询异常 → 免票选判定 fail-closed
    const id = createProposal(db, input({ action: "remove", itemId: "course/c3" }));
    const res = addVote(db, null, id, "q", roster("p", "q"));
    expect(res).toMatchObject({ threshold: 3, status: "pending" });
  });
});

describe("directoryPendingVotes", () => {
  const dirItem = directoryProposalItemId("tag", "go");

  it("无 pending 提案 → 0", () => {
    const db = newDb();
    expect(directoryPendingVotes(db, null, dirItem, new Set(["p"]))).toBe(0);
  });

  it("有 pending 且 2 个名册内投票人 → 2；名册外投票人不计", () => {
    const db = newDb();
    const id = createProposal(db, input({ action: "directory_add", itemId: dirItem, proposerId: "p" }));
    db.execute(`INSERT INTO govern_votes(proposal_id,voter_id,created_at) VALUES(?,?,?)`, [id, "q", 2]);
    db.execute(`INSERT INTO govern_votes(proposal_id,voter_id,created_at) VALUES(?,?,?)`, [id, "x", 3]);
    expect(directoryPendingVotes(db, null, dirItem, new Set(["p", "q"]))).toBe(2);
  });

  it("revoked_rev 水位加回退役作者 → 计入", () => {
    const db = newDb();
    const id = createProposal(db, input({ action: "directory_add", itemId: dirItem, proposerId: "p" }));
    db.execute(`INSERT INTO govern_votes(proposal_id,voter_id,created_at) VALUES(?,?,?)`, [id, "z", 2]);
    // 水位（提案 revoked_rev=0）之后才退役、且当前仍达门槛的作者 z
    putItem(db, "article/ret", { state: "removed", authorId: "z", contentHash: "hr" });
    putArticle(db, "article/ret", "x".repeat(200), "hr");
    db.execute(`INSERT INTO tombstones(item_id,revoked_rev) VALUES('article/ret',5)`);
    expect(directoryPendingVotes(db, null, dirItem, new Set(["p"]))).toBe(2);
  });
});

describe("getDirectoryTerm / findPendingDirectoryProposal", () => {
  it("getDirectoryTerm：命中返回全列，未命中 ok=false", () => {
    const db = newDb();
    db.execute(
      `INSERT INTO directory_terms(kind,term_key,display_name,state,first_author_id,created_at,updated_at)
        VALUES('tag','go','Go','approved','p','t1','t2')`,
    );
    const hit = getDirectoryTerm(db, "tag", "go");
    expect(hit.ok).toBe(true);
    expect(hit.term).toEqual({
      kind: "tag",
      termKey: "go",
      displayName: "Go",
      state: "approved",
      firstAuthorId: "p",
      createdAt: "t1",
      updatedAt: "t2",
    });
    expect(getDirectoryTerm(db, "tag", "rust").ok).toBe(false);
    expect(getDirectoryTerm(db, "category", "go").ok).toBe(false);
  });

  it("findPendingDirectoryProposal：命中 pending、已定案不算、无提案 ok=false", () => {
    const db = newDb();
    const itemId = directoryProposalItemId("tag", "go");
    expect(findPendingDirectoryProposal(db, itemId)).toEqual({ pid: 0, ok: false });

    const id = createProposal(db, input({ action: "directory_add", itemId }));
    expect(findPendingDirectoryProposal(db, itemId)).toEqual({ pid: id, ok: true });

    db.execute(`UPDATE govern_proposals SET executed_at=1 WHERE proposal_id=?`, [id]);
    expect(findPendingDirectoryProposal(db, itemId).ok).toBe(false);
  });
});

describe("encodeTagLinks", () => {
  it("键序 = 声明序 TagID,TargetID,Kind（非字典序），逐字节无空格", () => {
    expect(encodeTagLinks([{ tagId: "", targetId: "tag/a", kind: "article" }])).toBe(
      '[{"TagID":"","TargetID":"tag/a","Kind":"article"}]',
    );
    expect(
      encodeTagLinks([
        { tagId: "tag/x", targetId: "course/c1", kind: "course" },
        { tagId: "tag/x", targetId: "course/c2", kind: "course" },
      ]),
    ).toBe(
      '[{"TagID":"tag/x","TargetID":"course/c1","Kind":"course"},{"TagID":"tag/x","TargetID":"course/c2","Kind":"course"}]',
    );
    expect(encodeTagLinks([])).toBe("[]");
  });

  it("对齐 Go json.Marshal 转义（escapeHTML=true）", () => {
    // < > & → \u003c \u003e \u0026
    expect(encodeTagLinks([{ tagId: "a<b>c&d", targetId: "x", kind: "k" }])).toBe(
      '[{"TagID":"a\\u003cb\\u003ec\\u0026d","TargetID":"x","Kind":"k"}]',
    );
    // " \ \n
    expect(encodeTagLinks([{ tagId: 'q"\\\n', targetId: "x", kind: "k" }])).toBe(
      '[{"TagID":"q\\"\\\\\\n","TargetID":"x","Kind":"k"}]',
    );
    // \b \f 短转义
    expect(encodeTagLinks([{ tagId: "bs\bff\f", targetId: "x", kind: "k" }])).toBe(
      '[{"TagID":"bs\\bff\\f","TargetID":"x","Kind":"k"}]',
    );
    // U+2028/U+2029 无条件转义
    expect(encodeTagLinks([{ tagId: "sep\u2028\u2029", targetId: "x", kind: "k" }])).toBe(
      '[{"TagID":"sep\\u2028\\u2029","TargetID":"x","Kind":"k"}]',
    );
    // DEL(0x7f) 不转义
    expect(encodeTagLinks([{ tagId: "del\u007f", targetId: "x", kind: "k" }])).toBe(
      '[{"TagID":"del\u007f","TargetID":"x","Kind":"k"}]',
    );
  });
});

describe("getItemRow", () => {
  it("命中返回子集，未命中 null", () => {
    const db = newDb();
    putItem(db, "article/a1", {
      type: "article",
      state: "active",
      authorId: "aa",
      contentHash: "hc",
      sqliteTable: "articles",
    });
    expect(getItemRow(db, "article/a1")).toEqual({
      authorId: "aa",
      state: "active",
      sqliteTable: "articles",
      type: "article",
      contentHash: "hc",
    });
    expect(getItemRow(db, "article/missing")).toBeNull();
  });
});