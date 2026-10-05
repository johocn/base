// seats.json 黄金向量消费测试：TS 侧逐字对齐 Go 侧输出。
// 四个 section：governor_seats_and_quorums / event_watermark / contribution_rank / derive_seats。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { EventRow } from "./events";
import {
  contributionRank,
  deriveSeats,
  dissolveProposerQuorum,
  eventWatermark,
  governorSeats,
  groupBodyAction,
  type SeatSnapshot,
} from "./groupseats";

const here = dirname(fileURLToPath(import.meta.url));
const f = JSON.parse(readFileSync(join(here, "..", "..", "..", "..", "vectors", "v1", "seats.json"), "utf8"));
const sections = f.sections as {
  governor_seats_and_quorums: Array<Record<string, unknown>>;
  event_watermark: Array<Record<string, unknown>>;
  contribution_rank: Array<{ name: string; members: string[]; events: Array<{ event_id: string; actor: string; created_at: number }>; ranked: string[] }>;
  derive_seats: Array<{
    name: string;
    members: string[];
    creator: string;
    roster_rev: number;
    epoch: number;
    events: Array<{ event_id: string; id: string; created_at: number; body_json: string }>;
    seats: number;
    ranked: string[];
    governors: string[];
    decidable: boolean;
    watermark: string;
  }>;
  group_body_action: Array<{ name: string; body_json: string; action: string }>;
};

// — Section 1: GovernorSeats + Quorums —
describe("seats.json → governor_seats_and_quorums", () => {
  for (const c of sections.governor_seats_and_quorums) {
    it(c.name as string, () => {
      if (typeof c.seats === "number") {
        expect(governorSeats(c.m as number)).toBe(c.seats);
      }
      if (typeof c.k === "number") {
        if (typeof c.dp === "number") {
          expect(dissolveProposerQuorum(c.k as number)).toBe(c.dp);
        }
      }
    });
  }
});

// — Section 2: EventWatermark —
describe("seats.json → event_watermark", () => {
  for (const c of sections.event_watermark) {
    it(c.name as string, () => {
      expect(eventWatermark((c.ids as string[]) ?? [])).toBe(c.watermark);
    });
  }
});

// — Section 3: ContributionRank —
describe("seats.json → contribution_rank", () => {
  for (const c of sections.contribution_rank) {
    it(c.name, () => {
      const events = c.events.map((e) => ({
        eventId: e.event_id,
        actor: e.actor,
        createdAt: e.created_at,
      }));
      expect(contributionRank(events, c.members)).toEqual(c.ranked);
    });
  }
});

// — Section 4: DeriveSeats —
describe("seats.json → derive_seats", () => {
  for (const c of sections.derive_seats) {
    it(c.name, () => {
      const events: EventRow[] = c.events.map((e) => ({
        eventId: e.event_id,
        id: e.id,
        type: "group.v1",
        bodyJson: e.body_json,
        createdAt: e.created_at,
        receivedAt: 0,
        targetId: "",
        payloadCid: "",
        replyTo: "",
      }));
      const snap = deriveSeats(c.members, c.creator, c.roster_rev, c.epoch, events);
      const want: SeatSnapshot = {
        seatCount: c.seats,
        ranked: c.ranked,
        governors: c.governors,
        decidable: c.decidable,
        watermark: c.watermark,
        rosterRev: c.roster_rev,
        rosterEpoch: c.epoch,
      };
      expect(snap).toEqual(want);
    });
  }
});

// — Section 5: GroupBodyAction（黄金向量 seats.json / group_body_action section） —
describe("seats.json → group_body_action", () => {
  if (!sections.group_body_action || sections.group_body_action.length === 0) {
    throw new Error("seats.json 未找到 group_body_action section");
  }
  for (const c of sections.group_body_action) {
    it(c.name, () => {
      expect(groupBodyAction(c.body_json)).toBe(c.action);
    });
  }
});
