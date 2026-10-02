// cli/peer-sync.ts 单测：无对端时的错误消息文本、未知 flag 报错。**不起真网络**。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPeerSyncCommand } from "./peer-sync";

const SAVED = process.env.BASE_PEERS;
beforeAll(() => {
  delete process.env.BASE_PEERS;
});
afterAll(() => {
  if (SAVED === undefined) delete process.env.BASE_PEERS;
  else process.env.BASE_PEERS = SAVED;
});

describe("peer-sync 命令", () => {
  it("无对端（默认 BASE_PEERS 空）→ 逐字错误消息", async () => {
    await expect(createPeerSyncCommand().run([])).rejects.toThrow(
      "peer-sync: 需要至少一个对端（-peers 或 BASE_PEERS）",
    );
  });

  it("非法 -peers JSON → BASE_PEERS 前缀错误", async () => {
    await expect(createPeerSyncCommand().run(["-peers", "{"])).rejects.toThrow(
      /^BASE_PEERS 不是合法 JSON 数组/,
    );
  });

  it("未知 flag → 未知参数 -bogus", async () => {
    await expect(createPeerSyncCommand().run(["-bogus"])).rejects.toThrow("未知参数 -bogus");
  });
});