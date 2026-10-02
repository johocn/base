// routes/authmw.ts 的 requireNodeKey（tlscfg.go:202-212）单测：命中放行；
// 缺头 / 不等长 / 不等值 → 401 且 body 为 writeAuthErr(401,"node_key_mismatch") 的形状。
import { describe, expect, it } from "vitest";
import type { ServerHandler, ServerRequest } from "@base/core-ts";
import { createTlsAdapter } from "../host/tls";
import { requireNodeKey } from "./authmw";

const tls = createTlsAdapter();

function req(headers: Record<string, string>): ServerRequest {
  return { method: "GET", path: "/v1/healthz", params: {}, query: {}, headers, body: new Uint8Array(0) };
}

const okHandler: ServerHandler = async () => ({ status: 200, body: new Uint8Array([0x4f, 0x4b]) });

const EXPECT_BODY = `{"code":"node_key_mismatch","error":"节点间预共享密钥不匹配"}\n`;

describe("requireNodeKey", () => {
  const guarded = requireNodeKey(tls, "s3cret")(okHandler);

  it("命中（等长且等值）→ 放行", async () => {
    const res = await guarded(req({ "x-base-node-key": "s3cret" }));
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body ?? new Uint8Array(0)).toString("utf8")).toBe("OK");
  });

  it("缺头 / 不等长 / 等长不等值 → 401 node_key_mismatch", async () => {
    const cases: Record<string, string>[] = [
      {},
      { "x-base-node-key": "short" },
      { "x-base-node-key": "s3creX" },
    ];
    for (const headers of cases) {
      const res = await guarded(req(headers));
      expect(res.status).toBe(401);
      expect(res.headers?.["Content-Type"]).toBe("application/json; charset=utf-8");
      expect(Buffer.from(res.body ?? new Uint8Array(0)).toString("utf8")).toBe(EXPECT_BODY);
    }
  });
});