// peersync/eventsync.ts 的单测：EventSyncResult.String、syncEvents 的请求顺序 / 游标推进 /
// 空页与 next=null 结束 / 墓碑删块、parseEventProjection 的强类型语义、以及三个 applySynced* 投影。
// 集成用例用注入 transport + 真实 SyncStore；纯投影用例用手写 stub。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blobId } from "@base/protocol-ts";
import type { GroupRoster } from "../store/group";
import { openSyncStore, type SyncStore } from "../store/syncstore";
import type { Config, Peer, PeerRequest, PeerResponse } from "./peer";
import {
  applySyncedCircleEvent,
  applySyncedGovernEvent,
  applySyncedGroupEvent,
  applySyncedProgressEvent,
  deriveGovernRoster,
  EventSyncResult,
  parseEventProjection,
  syncEvents,
  type EventSyncItem,
} from "./eventsync";

vi.setConfig({ testTimeout: 20_000 });

const PEER: Peer = { url: "https://peer1", tlsFingerprint: "" };
const ZERO = { targetId: "", payloadCid: "", replyTo: "" };

const opened: { st: SyncStore; dir: string }[] = [];
function newStore(): { st: SyncStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "base-node-eventsync-"));
  const st = openSyncStore(dir, { storeKeyHex: "a".repeat(64) });
  opened.push({ st, dir });
  return { st, dir };
}
afterEach(() => {
  while (opened.length > 0) {
    const { st, dir } = opened.pop() as { st: SyncStore; dir: string };
    try {
      st.close();
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

function json(v: unknown, status = 200): PeerResponse {
  return { status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(v)) };
}

function cfg(route: (req: PeerRequest) => PeerResponse): { c: Config; calls: PeerRequest[] } {
  const calls: PeerRequest[] = [];
  const c: Config = {
    transportFor: () => async (req) => {
      calls.push(req);
      return route(req);
    },
  };
  return { c, calls };
}

function kindOf(req: PeerRequest): string {
  const body = req.body ?? new Uint8Array();
  return (JSON.parse(new TextDecoder().decode(body)) as { kind: string }).kind;
}

function item(over: Partial<EventSyncItem> = {}): EventSyncItem {
  return { eventId: "e", id: "actor", type: "comment.v1", bodyJson: "{}", createdAt: 0, receivedAt: 0, ...over };
}

describe("EventSyncResult", () => {
  it("String() 字段顺序与 Go 一致", () => {
    const r = new EventSyncResult();
    r.events = 3;
    r.tombstones = 2;
    expect(r.String()).toBe("event_sync events=3 tombstones=2");
    expect(new EventSyncResult().String()).toBe("event_sync events=0 tombstones=0");
  });
});

describe("syncEvents", () => {
  it("先 event 后 tombstone，且空页即结束", async () => {
    const { st } = newStore();
    const { c, calls } = cfg(() => json({ items: [], next: null }));
    const res = await syncEvents(c, undefined, st, PEER);
    expect(res.events).toBe(0);
    expect(res.tombstones).toBe(0);
    expect(calls.map(kindOf)).toEqual(["event", "tombstone"]);
    expect(calls[0].body && new URL(calls[0].url).pathname).toBe("/v1/event-sync");
  });

  it("非空页推进游标并用本页末条；page.next=null 时结束", async () => {
    const { st } = newStore();
    let eventPage = 0;
    const { c, calls } = cfg((req) => {
      if (kindOf(req) === "event") {
        eventPage++;
        if (eventPage === 1) {
          return json({
            items: [
              {
                event_id: "e1",
                id: "a",
                type: "comment.v1",
                body_json: JSON.stringify({ target_id: "t1", payload_cid: "p1" }),
                created_at: 1,
                received_at: 5,
              },
            ],
            next: { ts: 5, id: "e1" },
          });
        }
        return json({ items: [], next: null }); // 第二页空：本 kind 拉完
      }
      return json({ items: [], next: null });
    });
    const res = await syncEvents(c, undefined, st, PEER);
    expect(res.events).toBe(1); // 仅第一页一条；第二页空即结束
    expect(calls.map(kindOf)).toEqual(["event", "event", "tombstone"]);
    expect(st.getPeerCursor(PEER.url, "event")).toEqual({ ts: 5, id: "e1" });
    const evs = st.listEventsAfter(0, "", 10);
    expect(evs.length).toBe(1);
    expect(evs[0].type).toBe("comment.v1");
    expect(evs[0].targetId).toBe("t1");
    expect(evs[0].payloadCid).toBe("p1");
    expect(evs[0].receivedAt).toBeGreaterThan(0); // 本地 received_at 用本机 now
  });

  it("page.next=null 时同一页取完即结束（不再翻页）", async () => {
    const { st } = newStore();
    const { c, calls } = cfg((req) => {
      if (kindOf(req) === "event") {
        return json({
          items: [
            { event_id: "e9", id: "a", type: "comment.v1", body_json: "{}", created_at: 1, received_at: 9 },
          ],
          next: null,
        });
      }
      return json({ items: [], next: null });
    });
    await syncEvents(c, undefined, st, PEER);
    expect(calls.map(kindOf)).toEqual(["event", "tombstone"]);
    expect(st.getPeerCursor(PEER.url, "event")).toEqual({ ts: 9, id: "e9" });
  });

  it("govern.v1 整页只派生一次名册", async () => {
    const { st } = newStore();
    const spy = vi.spyOn(st, "contributorRoster").mockReturnValue([]);
    const { c } = cfg((req) => {
      if (kindOf(req) === "event") {
        return json({
          items: [
            {
              event_id: "g1",
              id: "a",
              type: "govern.v1",
              body_json: JSON.stringify({ action: "proposal", proposal_id: "1", verb: "remove", target_item_id: "article/x", content_hash: "h" }),
              created_at: 1,
              received_at: 1,
            },
            {
              event_id: "g2",
              id: "b",
              type: "govern.v1",
              body_json: JSON.stringify({ action: "proposal", proposal_id: "2", verb: "remove", target_item_id: "article/y", content_hash: "h" }),
              created_at: 2,
              received_at: 2,
            },
          ],
          next: null,
        });
      }
      return json({ items: [], next: null });
    });
    await syncEvents(c, undefined, st, PEER);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("墓碑到达后本地块被删、游标推进、墓碑落库", async () => {
    const { st } = newStore();
    const payload = new Uint8Array([1, 2, 3, 4]);
    const B = blobId(payload);
    st.putBlob(B, payload, "item/x", 0);
    expect(st.hasBlob(B).exists).toBe(true);

    const { c } = cfg((req) => {
      if (kindOf(req) === "event") return json({ items: [], next: null });
      return json({
        items: [{ event_id: "tomb1", payload_cid: B, reason: "moderated", at: 9, received_at: 7 }],
        next: null,
      });
    });
    const res = await syncEvents(c, undefined, st, PEER);
    expect(res.tombstones).toBe(1);
    expect(st.hasBlob(B).exists).toBe(false);
    expect(st.getPeerCursor(PEER.url, "tombstone")).toEqual({ ts: 7, id: "tomb1" });
    const tombs = st.listTombstonesAfter(0, "", 10);
    expect(tombs.length).toBe(1);
    expect(tombs[0].payloadCid).toBe(B);
    expect(tombs[0].receivedAt).toBeGreaterThan(0);
  });
});

describe("parseEventProjection", () => {
  it("四种已知 type 的线名还原", () => {
    expect(parseEventProjection("comment.v1", JSON.stringify({ target_id: "c", payload_cid: "p", reply_to: "r" }))).toEqual({
      targetId: "c",
      payloadCid: "p",
      replyTo: "r",
    });
    expect(parseEventProjection("group.v1", JSON.stringify({ group_id: "g", payload_cid: "p", reply_to: "r" }))).toEqual({
      targetId: "group/g",
      payloadCid: "p",
      replyTo: "r",
    });
    expect(parseEventProjection("dm.v1", JSON.stringify({ to: "bob", payload_cid: "p" }))).toEqual({
      targetId: "dm/bob",
      payloadCid: "p",
      replyTo: "",
    });
    expect(parseEventProjection("progress.v1", JSON.stringify({ item_id: "i/1" }))).toEqual({
      targetId: "i/1",
      payloadCid: "",
      replyTo: "",
    });
  });

  it("非法 JSON / 非对象 / 非字符串字段 → 零值；null 与缺键不报错", () => {
    expect(parseEventProjection("comment.v1", "not json")).toEqual(ZERO);
    expect(parseEventProjection("comment.v1", "[]")).toEqual(ZERO);
    expect(parseEventProjection("comment.v1", "42")).toEqual(ZERO);
    expect(parseEventProjection("comment.v1", JSON.stringify({ target_id: 5 }))).toEqual(ZERO);
    expect(parseEventProjection("comment.v1", JSON.stringify({ target_id: { a: 1 } }))).toEqual(ZERO);
    expect(parseEventProjection("comment.v1", JSON.stringify({ target_id: null, payload_cid: "p" }))).toEqual({
      targetId: "",
      payloadCid: "p",
      replyTo: "",
    });
    expect(parseEventProjection("group.v1", JSON.stringify({ group_id: "" }))).toEqual(ZERO);
    expect(parseEventProjection("dm.v1", JSON.stringify({ to: "" }))).toEqual(ZERO);
    expect(parseEventProjection("unknown.v1", JSON.stringify({ x: 1 }))).toEqual(ZERO);
  });
});

describe("applySyncedGroupEvent", () => {
  it("roster 事件：encrypted 缺省 1、envelopes 包装、member_ids 序列化", () => {
    const forceGroupRoster = vi.fn((_r: GroupRoster) => true);
    const st = { forceGroupRoster } as unknown as SyncStore;
    applySyncedGroupEvent(
      st,
      item({
        type: "group.v1",
        id: "actor1",
        eventId: "ev1",
        bodyJson: JSON.stringify({
          group_id: "g1",
          action: "roster",
          epoch: 1,
          member_ids: ["a", "b"],
          envelopes: [{ k: 1 }],
        }),
      }),
    );
    expect(forceGroupRoster).toHaveBeenCalledTimes(1);
    expect(forceGroupRoster.mock.calls[0][0]).toEqual({
      groupId: "g1",
      creatorId: "actor1",
      epoch: 1,
      rosterRev: 0,
      encrypted: 1,
      memberIdsJson: JSON.stringify(["a", "b"]),
      keyEnvelopesJson: JSON.stringify({ envelopes: [{ k: 1 }] }),
      eventId: "ev1",
      updatedAt: 0,
    });
  });

  it("dissolve 空名单放行（[] → \"[]\"，缺键 → \"null\"）", () => {
    const forceGroupRoster = vi.fn((_r: GroupRoster) => true);
    const st = { forceGroupRoster } as unknown as SyncStore;
    applySyncedGroupEvent(
      st,
      item({ type: "group.v1", bodyJson: JSON.stringify({ group_id: "g", action: "roster", sub: "dissolve", epoch: 2, member_ids: [] }) }),
    );
    expect(forceGroupRoster.mock.calls[0][0].memberIdsJson).toBe("[]");
    applySyncedGroupEvent(
      st,
      item({ type: "group.v1", bodyJson: JSON.stringify({ group_id: "g", action: "roster", sub: "dissolve", epoch: 3 }) }),
    );
    expect(forceGroupRoster.mock.calls[1][0].memberIdsJson).toBe("null");
  });

  it("encrypted 显式 0 被保留；epoch < 1 或非 roster 直接忽略", () => {
    const forceGroupRoster = vi.fn((_r: GroupRoster) => true);
    const st = { forceGroupRoster } as unknown as SyncStore;
    applySyncedGroupEvent(
      st,
      item({ type: "group.v1", bodyJson: JSON.stringify({ group_id: "g", action: "roster", epoch: 1, encrypted: 0, member_ids: ["a"] }) }),
    );
    expect(forceGroupRoster.mock.calls[0][0].encrypted).toBe(0);
    applySyncedGroupEvent(st, item({ type: "group.v1", bodyJson: JSON.stringify({ group_id: "g", action: "roster", epoch: 0, member_ids: ["a"] }) }));
    applySyncedGroupEvent(st, item({ type: "group.v1", bodyJson: JSON.stringify({ group_id: "g", action: "msg", epoch: 1, member_ids: ["a"] }) }));
    applySyncedGroupEvent(st, item({ type: "group.v1", bodyJson: "[]" }));
    expect(forceGroupRoster).toHaveBeenCalledTimes(1);
  });
});

describe("applySyncedProgressEvent", () => {
  it("合法 progress 事件投影进 putProgressProjection", () => {
    const putProgressProjection = vi.fn();
    const st = { putProgressProjection } as unknown as SyncStore;
    applySyncedProgressEvent(
      st,
      item({ id: "a", eventId: "ev", type: "progress.v1", createdAt: 11, bodyJson: JSON.stringify({ item_id: "i/1", position: 3, done: true, day: "d" }) }),
    );
    expect(putProgressProjection).toHaveBeenCalledWith({
      id: "a",
      itemId: "i/1",
      position: 3,
      done: true,
      day: "d",
      createdAt: 11,
      eventId: "ev",
    });
  });

  it("item_id 缺失 / 类型错误 → 不投影", () => {
    const putProgressProjection = vi.fn();
    const st = { putProgressProjection } as unknown as SyncStore;
    applySyncedProgressEvent(st, item({ type: "progress.v1", bodyJson: JSON.stringify({ position: 1 }) }));
    applySyncedProgressEvent(st, item({ type: "progress.v1", bodyJson: JSON.stringify({ item_id: 5 }) }));
    applySyncedProgressEvent(st, item({ type: "progress.v1", bodyJson: "not json" }));
    expect(putProgressProjection).not.toHaveBeenCalled();
  });
});

describe("applySyncedGovernEvent", () => {
  it("proposal：冲突（true）不算错，仍继续 settle", () => {
    const projectGovernProposal = vi.fn(() => true);
    const settleGovernProposal = vi.fn();
    const st = { projectGovernProposal, settleGovernProposal } as unknown as SyncStore;
    const roster = new Set(["a"]);
    expect(() =>
      applySyncedGovernEvent(
        st,
        item({ type: "govern.v1", id: "a", eventId: "ev", createdAt: 1, bodyJson: JSON.stringify({ action: "proposal", proposal_id: "5", verb: "remove", target_item_id: "article/x", content_hash: "h" }) }),
        roster,
        false,
      ),
    ).not.toThrow();
    expect(projectGovernProposal).toHaveBeenCalledTimes(1);
    expect(settleGovernProposal).toHaveBeenCalledWith(5, roster, false);
  });

  it("vote：投影投票并 settle", () => {
    const projectGovernVote = vi.fn();
    const settleGovernProposal = vi.fn();
    const st = { projectGovernVote, settleGovernProposal } as unknown as SyncStore;
    applySyncedGovernEvent(
      st,
      item({ type: "govern.v1", id: "a", eventId: "ev", createdAt: 1, bodyJson: JSON.stringify({ action: "vote", proposal_id: "7", choice: "yes" }) }),
      new Set(["a"]),
      true,
    );
    expect(projectGovernVote).toHaveBeenCalledWith({ proposalId: 7, choice: "yes", createdAt: 1, eventId: "ev", actor: "a" });
    expect(settleGovernProposal).toHaveBeenCalledWith(7, expect.any(Set), true);
  });

  it("directory_add 镜像校验失败 → 不投影、不 settle", () => {
    const projectGovernProposal = vi.fn(() => false);
    const settleGovernProposal = vi.fn();
    const st = { projectGovernProposal, settleGovernProposal } as unknown as SyncStore;
    applySyncedGovernEvent(
      st,
      item({ type: "govern.v1", bodyJson: JSON.stringify({ action: "proposal", proposal_id: "9", verb: "directory_add", target_item_id: "article/x", directory_display_name: "X", directory_term_key: "x" }) }),
      new Set(),
      false,
    );
    expect(projectGovernProposal).not.toHaveBeenCalled();
    expect(settleGovernProposal).not.toHaveBeenCalled();
  });

  it("proposal_id 非法 / action 未知 → 直接返回", () => {
    const projectGovernProposal = vi.fn();
    const settleGovernProposal = vi.fn();
    const st = { projectGovernProposal, settleGovernProposal } as unknown as SyncStore;
    applySyncedGovernEvent(st, item({ type: "govern.v1", bodyJson: JSON.stringify({ action: "proposal", proposal_id: "0" }) }), new Set(), false);
    applySyncedGovernEvent(st, item({ type: "govern.v1", bodyJson: JSON.stringify({ action: "nope", proposal_id: "5" }) }), new Set(), false);
    applySyncedGovernEvent(st, item({ type: "govern.v1", bodyJson: JSON.stringify({ action: "proposal", proposal_id: "abc" }) }), new Set(), false);
    expect(projectGovernProposal).not.toHaveBeenCalled();
    expect(settleGovernProposal).not.toHaveBeenCalled();
  });

  it("settle 抛错只记日志、不向外抛", () => {
    const projectGovernVote = vi.fn();
    const settleGovernProposal = vi.fn(() => {
      throw new Error("settle boom");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const st = { projectGovernVote, settleGovernProposal } as unknown as SyncStore;
    expect(() =>
      applySyncedGovernEvent(st, item({ type: "govern.v1", bodyJson: JSON.stringify({ action: "vote", proposal_id: "3", choice: "no" }) }), new Set(), true),
    ).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("deriveGovernRoster", () => {
  it("成功 → 全部 id 进 Set，ok=true", () => {
    const st = { contributorRoster: () => [{ id: "a", count: 1 }, { id: "b", count: 2 }] } as unknown as SyncStore;
    const r = deriveGovernRoster(st);
    expect(r.ok).toBe(true);
    expect([...r.roster].sort()).toEqual(["a", "b"]);
  });

  it("失败 → ok=false、空名册、记日志", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const st = {
      contributorRoster: () => {
        throw new Error("boom");
      },
    } as unknown as SyncStore;
    const r = deriveGovernRoster(st);
    expect(r.ok).toBe(false);
    expect(r.roster.size).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("applySyncedCircleEvent", () => {
  it("assign 事件：写 putCircleAssignment，缺省 origin=fusion", () => {
    const putCircleAssignment = vi.fn();
    const st = { putCircleAssignment } as unknown as SyncStore;
    applySyncedCircleEvent(
      st,
      item({
        type: "circle.v1",
        createdAt: 123,
        bodyJson: JSON.stringify({ action: "assign", item_id: "article/ai1", circle_id: "00000000000000ff", content_hash: "ab" }),
      }),
    );
    expect(putCircleAssignment).toHaveBeenCalledTimes(1);
    expect(putCircleAssignment).toHaveBeenCalledWith("article/ai1", "00000000000000ff", "fusion", 123);
  });

  it("显式 origin=user 被保留", () => {
    const putCircleAssignment = vi.fn();
    const st = { putCircleAssignment } as unknown as SyncStore;
    applySyncedCircleEvent(
      st,
      item({
        type: "circle.v1",
        bodyJson: JSON.stringify({ action: "assign", item_id: "i/1", circle_id: "c1", origin: "user" }),
      }),
    );
    expect(putCircleAssignment).toHaveBeenCalledWith("i/1", "c1", "user", 0);
  });

  it("form 事件：本地 item 存在 → 投影 upsertGroupForForm + putCircleAssignment；本地 item 不存在 → 不投影", () => {
    const putCircleAssignment = vi.fn();
    const upsertGroupForForm = vi.fn();
    const getItemRow = vi.fn().mockReturnValue({ itemId: "i/1", authorId: "a1" });
    const st = { putCircleAssignment, upsertGroupForForm, getItemRow } as unknown as SyncStore;
    applySyncedCircleEvent(
      st,
      item({
        type: "circle.v1",
        createdAt: 42,
        bodyJson: JSON.stringify({ action: "form", item_id: "i/1", circle_id: "c1", origin: "fusion" }),
      }),
    );
    expect(upsertGroupForForm).toHaveBeenCalledWith("c1", "a1", 42, "fusion");
    expect(putCircleAssignment).toHaveBeenCalledWith("i/1", "c1", "fusion", 42);

    // 本地 item 不存在 → 不投影
    vi.clearAllMocks();
    getItemRow.mockReturnValue(null);
    applySyncedCircleEvent(
      st,
      item({
        type: "circle.v1",
        bodyJson: JSON.stringify({ action: "form", item_id: "i/unknown", circle_id: "c1" }),
      }),
    );
    expect(upsertGroupForForm).not.toHaveBeenCalled();
    expect(putCircleAssignment).not.toHaveBeenCalled();
  });

  it("负向：非 circle.v1 / 坏 JSON / assign 缺字段 → 不投影", () => {
    const putCircleAssignment = vi.fn();
    const upsertGroupForForm = vi.fn();
    const getItemRow = vi.fn();
    const st = { putCircleAssignment, upsertGroupForForm, getItemRow } as unknown as SyncStore;
    applySyncedCircleEvent(st, item({ type: "comment.v1", bodyJson: JSON.stringify({ target_id: "t" }) }));
    applySyncedCircleEvent(st, item({ type: "circle.v1", bodyJson: "not json" }));
    applySyncedCircleEvent(st, item({ type: "circle.v1", bodyJson: JSON.stringify({ action: "assign" }) })); // 缺 item_id/circle_id
    applySyncedCircleEvent(st, item({ type: "circle.v1", bodyJson: JSON.stringify({ action: "unknown", item_id: "i", circle_id: "c" }) })); // 未知 action
    expect(putCircleAssignment).not.toHaveBeenCalled();
    expect(upsertGroupForForm).not.toHaveBeenCalled();
    expect(getItemRow).not.toHaveBeenCalled();
  });
});