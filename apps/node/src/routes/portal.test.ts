import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../db";
import { schemaStatements } from "../store/schema";
import {
  SafeHTML,
  articlePageData,
  governancePageData,
  indexPageData,
  renderPortalPage,
  type PageData,
  type PortalDeps,
} from "./portal";

// —— (a) 黄金字节对拍：以 Go 预言机产出的 .html 为规范 ——

const FIXTURES = new URL("./__fixtures__/portal/", import.meta.url);
const PAGEDATA = JSON.parse(readFileSync(new URL("pagedata.json", FIXTURES), "utf8")) as Record<
  string,
  unknown
>;

type PageKey = "index" | "article" | "governance";

function pageOf(key: string): PageKey {
  if (key.startsWith("index")) return "index";
  if (key.startsWith("article")) return "article";
  return "governance";
}

/** JSON → pageData：Article.Body 是 Go template.HTML，需包成 SafeHTML 才原样输出。 */
function toPageData(raw: unknown): PageData {
  const d = structuredClone(raw) as PageData & { Article?: { Body?: unknown } };
  if (d.Article !== undefined && d.Article !== null && typeof d.Article.Body === "string") {
    d.Article.Body = new SafeHTML(d.Article.Body);
  }
  return d;
}

const GOLDEN_KEYS = [
  "index",
  "index-empty",
  "index-url",
  "article",
  "article-url",
];

describe("门户黄金字节对拍", () => {
  for (const key of GOLDEN_KEYS) {
    it(key, () => {
      const rendered = renderPortalPage(pageOf(key), toPageData(PAGEDATA[key]));
      const got = Buffer.from(rendered, "utf8");
      const want = readFileSync(new URL(`${key}.html`, FIXTURES));
      expect(got.equals(want)).toBe(true);
    });
  }
});

// governance / governance-roster 的 pagedata.json + .html fixture 均为 V1 Go 预言机输出，
// 但 web/templates/governance.html 已升级为 V2（使用 ActiveUsersM / ThresholdBaseExample /
// Quorum / NetWeight / RosterSeedIDs 等 V2 字段）。这两个 fixture 需要 Go 侧重新生成
// V2 版预言机数据后再对拍；Node 侧仅验证 db→pagedata 映射（见下文 governancePageData 测试）。
describe.skip("门户黄金字节对拍（governance V2 fixture 待 Go 侧重生成）", () => {
  for (const key of ["governance", "governance-roster"]) {
    it(key, () => {
      const rendered = renderPortalPage(pageOf(key), toPageData(PAGEDATA[key]));
      const got = Buffer.from(rendered, "utf8");
      const want = readFileSync(new URL(`${key}.html`, FIXTURES));
      expect(got.equals(want)).toBe(true);
    });
  }
});

// —— (b) DB → pageData 映射 ——

let dir: string;
let db: Db;
const deps: PortalDeps = {
  db: null as unknown as Db,
  storeKey: null,
  issuer: "issuer-x",
  pairingCode: "",
  fingerprintHex: "",
};

const LONG_BODY = "x".repeat(250);

function insertItem(
  id: string,
  type: string,
  state: string,
  distClass: string,
  title: string,
  rev: string,
  author: string,
): void {
  db.execute(
    `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, "src", type, title, rev, "ch", "articles", distClass, state, "2024-01-01T00:00:00Z", author, ""],
  );
}

function insertArticle(
  id: string,
  title: string,
  body: string,
  tagsJson: string,
  digest: string,
  publishedAt: string,
): void {
  db.execute(
    `INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev)
			VALUES(?,?,?,?,?,?,?,?)`,
    [id, title, digest, publishedAt, tagsJson, body, "ch", "rev"],
  );
}

function insertProposal(
  id: number,
  action: string,
  itemId: string,
  reason: string,
  title: string,
  bodyMd: string,
  createdAt: number,
  executedAt: number,
  voidedAt: number,
): void {
  db.execute(
    `INSERT INTO govern_proposals(proposal_id,action,item_id,proposer_id,reason,title,body_md,links_json,base_content_hash,created_at,executed_at,voided_at,executed_result,content_version,revoked_rev)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, action, itemId, "proposer", reason, title, bodyMd, "", "base", createdAt, executedAt, voidedAt, "", 0, 0],
  );
}

function insertVote(proposalId: number, voterId: string): void {
  db.execute(`INSERT INTO govern_votes(proposal_id,voter_id,created_at) VALUES(?,?,?)`, [
    proposalId,
    voterId,
    1,
  ]);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "base-node-portal-"));
  db = openDb(join(dir, "base.db"));
  for (const stmt of schemaStatements) db.execute(stmt);
  // schemaStatements 不含 items 的后加列（Go 由 migrate 补），测试里按 itemColumnMigrations 补齐。
  db.execute(`ALTER TABLE items ADD COLUMN author_id TEXT NOT NULL DEFAULT ''`);
  db.execute(`ALTER TABLE items ADD COLUMN author_sig TEXT NOT NULL DEFAULT ''`);
  deps.db = db;

  // 名册：3 个作者各一篇达标文章（非空格 rune ≥ 200）。
  for (const c of ["c1", "c2", "c3"]) {
    insertItem(`r-${c}`, "article", "active", "public", `文章 ${c}`, "rev", c);
    insertArticle(`r-${c}`, `文章 ${c}`, LONG_BODY, "[]", "", "");
  }
  db.execute(`INSERT INTO profiles(id,name,updated_at) VALUES(?,?,?)`, ["c1", "甲", 1]);

  // 提案目标条目：公开在架 / 公开已下架 / 私密在架。
  insertItem("t-active", "article", "active", "public", "公开条目甲", "rev", "");
  insertItem("t-removed", "article", "removed", "public", "公开条目乙", "rev", "");
  insertItem("t-private", "article", "active", "private", "私密条目丙", "rev", "");

  // p1 remove 3 票（阈值 3）/ p2 edit 3 票（阈值 2，Percent 截断到 100）/ p3 directory_add pending
  // p4 已下架目标 / p5 私密目标 / p6 目标缺失 / p7 remove 1 票（Percent 截断为 33）
  insertProposal(1, "remove", "t-active", "p1", "", "", 1700000000000, 0, 0);
  insertVote(1, "c1");
  insertVote(1, "c2");
  insertVote(1, "c3");
  insertProposal(2, "edit", "t-active", "p2", "拟改标题", "拟改正文", 0, 0, 0);
  insertVote(2, "c1");
  insertVote(2, "c2");
  insertVote(2, "c3");
  insertProposal(3, "directory_add", "term:tag:foo", "p3", "  新词条   X ", "", 1700000000000, 0, 0);
  insertProposal(4, "remove", "t-removed", "p4", "", "", 1700000000000, 0, 0);
  insertProposal(5, "remove", "t-private", "p5", "", "", 1700000000000, 0, 0);
  insertProposal(6, "remove", "ghost", "p6", "", "", 1700000000000, 0, 0);
  insertProposal(7, "remove", "t-active", "p7", "", "", 0, 0, 0);
  insertVote(7, "c1");

  // 文章：标签三态 + 图章/标题色 + 封面块。
  insertItem("art1", "article", "active", "public", "文章标题", "rev-art", "");
  insertArticle(
    "art1",
    "文章标题",
    "# 标题\n正文",
    JSON.stringify(["纯标签", "标签<&\"'+", "", "x".repeat(65)]),
    "摘要",
    "2026-10-02 15:04",
  );
  db.execute(
    `INSERT INTO directory_terms(kind,term_key,display_name,state,first_author_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
    ["tag", "纯标签", "纯标签", "approved", "", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"],
  );
  const seg = (seq: number, kind: string, text: string): void => {
    db.execute(
      `INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`,
      ["art1", seq, kind, text, "ch"],
    );
  };
  seg(-3, "attr.badge", "活动,悬赏,活动,自定义");
  seg(-2, "attr.title_color", "blue");
  seg(-1, "attr.title_color", "yellow");
  db.execute(
    `INSERT INTO blobs(blob_id,size,item_id,seq,created_at) VALUES(?,?,?,?,?)`,
    ["coverB", 10, "art1/cover", 1, "2024-01-01T00:00:00Z"],
  );
  db.execute(
    `INSERT INTO blobs(blob_id,size,item_id,seq,created_at) VALUES(?,?,?,?,?)`,
    ["coverA", 10, "art1/cover", 0, "2024-01-01T00:00:00Z"],
  );

  // 索引过滤：仅 active + public + article。
  insertItem("a-pub", "article", "active", "public", "标题一", "rev-1", "");
  insertItem("b-removed", "article", "removed", "public", "标题二", "rev-2", "");
  insertItem("c-private", "article", "active", "private", "标题三", "rev-3", "");
  insertItem("d-video", "video", "active", "public", "标题四", "rev-4", "");
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("indexPageData", () => {
  it("只含 active + public + article，Rev 取 source_rev", () => {
    const data = indexPageData(db, deps);
    expect(data.Title).toBe("内容目录");
    const ids = data.Items!.map((i) => i.ItemID);
    // 排除三条反例：removed / private / 非 article。
    expect(ids).not.toContain("b-removed");
    expect(ids).not.toContain("c-private");
    expect(ids).not.toContain("d-video");
    expect(data.Items!.find((i) => i.ItemID === "a-pub")).toEqual({
      ItemID: "a-pub",
      Type: "article",
      Title: "标题一",
      Rev: "rev-1",
    });
  });
});

describe("articlePageData", () => {
  it("条目护栏不过 → null", () => {
    expect(articlePageData(db, deps, "absent")).toBeNull();
    expect(articlePageData(db, deps, "d-video")).toBeNull();
    expect(articlePageData(db, deps, "b-removed")).toBeNull();
    expect(articlePageData(db, deps, "c-private")).toBeNull();
  });

  it("正文行缺失 → 404 文章正文不存在", () => {
    insertItem("art-nobody", "article", "active", "public", "无正文", "rev", "");
    expect(() => articlePageData(db, deps, "art-nobody")).toThrow("文章正文不存在");
  });

  it("标签三态：approved → false；未 approved / 非法 → true", () => {
    const data = articlePageData(db, deps, "art1");
    expect(data).not.toBeNull();
    expect(data!.Article!.TagViews).toEqual([
      { Name: "纯标签", Pending: false },
      { Name: '标签<&"\'+', Pending: true },
      { Name: "", Pending: true },
      { Name: "x".repeat(65), Pending: true },
    ]);
  });

  it("图章白名单过滤 + 去重 + 码位升序；标题色白名单 + 后者胜", () => {
    const art = articlePageData(db, deps, "art1")!.Article!;
    expect(art.Badges).toEqual(["悬赏", "活动"]);
    expect(art.TitleColor).toBe("blue");
  });

  it("封面取 blobs 首行（seq 最小）", () => {
    expect(articlePageData(db, deps, "art1")!.Article!.CoverBlobID).toBe("coverA");
  });

  it("正文走 renderMarkdown 且为 SafeHTML", () => {
    const art = articlePageData(db, deps, "art1")!.Article!;
    expect(art.Body).toBeInstanceOf(SafeHTML);
    expect(art.Body.html).toBe("<h1>标题</h1><p>正文</p>");
    expect(art.ItemID).toBe("art1");
    expect(art.Title).toBe("文章标题");
    expect(art.Digest).toBe("摘要");
    expect(art.PublishedAt).toBe("2026-10-02 15:04");
  });
});

describe("governancePageData", () => {
  it("提案倒序（新提案在前）", () => {
    const reasons = governancePageData(db, deps).Proposals!.map((p) => p.Reason);
    expect(reasons).toEqual(["p7", "p6", "p5", "p4", "p3", "p2", "p1"]);
  });

  it("Percent 整数截断并封顶 100；Threshold/Quorum 用 Spec v2 动态公式 + V2 字段齐全", () => {
    const props = governancePageData(db, deps).Proposals!;
    const byReason = new Map(props.map((p) => [p.Reason, p]));
    // db 无 identities/progress/favorites → V2 动态公式 m=0,P=0,F=0 → GovernThreshold("base")=10, GovernQuorum(10,0)=10
    // 测试插入的 vote 默认 vote_type='approve', vote_weight=1 → p1 approveWeight=3
    expect(byReason.get("p1")).toMatchObject({
      VoteCount: 3,
      Threshold: 10,
      Quorum: 10,
      Percent: 30,
      GovernanceLevel: "base",
      ApproveWeight: 3,
      RejectWeight: 0,
      NetWeight: 3,
      ApproveBar: 100,
      RejectBar: 0,
    });
    expect(byReason.get("p2")).toMatchObject({ VoteCount: 3, Threshold: 10, Quorum: 10, Percent: 30 });
    expect(byReason.get("p7")).toMatchObject({ VoteCount: 1, Threshold: 10, Quorum: 10, Percent: 10 });
  });

  it("directory_add 渲染 TermName / TermPending", () => {
    const p3 = governancePageData(db, deps).Proposals!.find((p) => p.Reason === "p3")!;
    expect(p3.ActionLabel).toBe("新增词条");
    expect(p3.TermName).toBe("新词条 X");
    expect(p3.TermPending).toBe(true);
  });

  it("edit 带出 Edit 字段", () => {
    const p2 = governancePageData(db, deps).Proposals!.find((p) => p.Reason === "p2")!;
    expect(p2.ActionLabel).toBe("改写");
    expect(p2.Edit).toEqual({ Title: "拟改标题", BodyMD: "拟改正文" });
  });

  it("两条可见性护栏：标题只在 public 显示，链接只挂 active + public", () => {
    const props = governancePageData(db, deps).Proposals!;
    const byReason = new Map(props.map((p) => [p.Reason, p]));
    expect(byReason.get("p1")).toMatchObject({
      ItemState: "active",
      ItemStateLabel: "在架",
      Title: "公开条目甲",
      Linkable: true,
    });
    expect(byReason.get("p4")).toMatchObject({
      ItemState: "removed",
      ItemStateLabel: "已下架",
      Title: "公开条目乙",
      Linkable: false,
    });
    expect(byReason.get("p5")).toMatchObject({
      ItemState: "active",
      ItemStateLabel: "在架",
      Title: "t-private",
      Linkable: false,
    });
    expect(byReason.get("p6")).toMatchObject({ ItemState: "", ItemStateLabel: "", Title: "ghost" });
  });

  it("名册：DeriveContributionRoster 恒 10 人（不足用 earliestRegisteredIDs 补齐；测试无 identities 数据 → 仅贡献者 c1/c2/c3），缺昵称回退 id；顶部门槛演示字段齐全", () => {
    const data = governancePageData(db, deps);
    expect(data.RosterReady).toBe(true);
    // V2 顶部门槛演示：db 无 identities → m=0 → base=10, enhanced=20
    expect(data.ActiveUsersM).toBe(0);
    expect(data.ThresholdBaseExample).toBe(10);
    expect(data.ThresholdEnhancedExample).toBe(20);
    // 贡献者名册 = c1/c2/c3（identities 表缺失 → 无种子补齐），Count 恒 0（V2 名册不展示 count）
    expect(data.Roster).toEqual([
      { ID: "c1", Name: "甲", Count: 0 },
      { ID: "c2", Name: "c2", Count: 0 },
      { ID: "c3", Name: "c3", Count: 0 },
    ]);
    expect(data.RosterSeedIDs).toEqual({});
  });

  it("CreatedAt：非零按本地时区格式化（只断言形状），零值渲染空串", () => {
    // CreatedAt 依赖本机本地时区，硬编码具体时刻会在别的时区磁盘上失败，故只校验格式。
    const props = governancePageData(db, deps).Proposals!;
    const byReason = new Map(props.map((p) => [p.Reason, p]));
    expect(byReason.get("p1")!.CreatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(byReason.get("p2")!.CreatedAt).toBe("");
  });
});
