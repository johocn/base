import type { Listener, ServerAdapters, TlsConfig } from "@base/core-ts";
import { keyPairFromSeed } from "@base/protocol-ts";
import type { Db } from "./db";
import { loadStoreKey } from "./host/storekey";
import { healthzHandler } from "./routes/healthz";
import { catalogHandler } from "./routes/catalog";
import { pubkeyHandler } from "./routes/pubkey";
import { manifestHandler } from "./routes/manifest";
import { packHandler } from "./routes/pack";
import { blobGetHandler, blobHeadHandler } from "./routes/blob";
import { releaseHandler } from "./routes/release";
import { contributorsHandler } from "./routes/contributors";
import { directoryHandler } from "./routes/directory";
import { commentHandler } from "./routes/comment";
import { dmHandler } from "./routes/dm";
import {
  escrowGetHandler,
  escrowPutHandler,
  identityGetHandler,
  identityRegisterHandler,
} from "./routes/identity";
import { requireAuth } from "./routes/authmw";
import { meHandler } from "./routes/me";
import { profilePutHandler } from "./routes/profile";
import {
  EVENT_BURST_PER_ID,
  EVENT_BURST_PER_IP,
  EVENT_PER_MINUTE_PER_ID,
  EVENT_PER_MINUTE_PER_IP,
  eventPostHandler,
} from "./routes/event";
import {
  articlePageHandler,
  governancePageHandler,
  indexPageHandler,
} from "./routes/portal";
import { GOVERN_BURST_PER_IP, GOVERN_PER_MINUTE_PER_IP, IpLimiter } from "./routes/derived";

/** 节点对外服务选项；后五项均为可选，保持既有 `startServer(adapters, db, {host, port})` 调用兼容。 */
export interface ServerOptions {
  host: string;
  port: number;
  tls?: TlsConfig;
  issuer?: string;
  signKeyHex?: string;
  dataDir?: string;
  fingerprintHex?: string;
  pairingCode?: string;
}

export async function startServer(
  adapters: ServerAdapters,
  db: Db,
  opts: ServerOptions,
): Promise<Listener> {
  const signKeyHex = opts.signKeyHex ?? "";
  const pubHex = signKeyHex === "" ? "" : keyPairFromSeed(signKeyHex).pubHex;
  const dataDir = opts.dataDir;
  // blob 解密所需的 store 密钥：与 apps/node/src/store/store.ts 同源。
  const storeKey = dataDir === undefined || dataDir === "" ? null : loadStoreKey(dataDir, {}).key;
  // 治理面 IP 令牌桶（对齐 httpapi/govern.go 的 governLimiterByIP 常量）。
  const governLimiter = new IpLimiter(GOVERN_PER_MINUTE_PER_IP, GOVERN_BURST_PER_IP);
  // escrow 读取的同 IP 令牌桶：对齐 server.go:54 的 newIPLimiter(10, 10)（**独立实例**，
  // 与治理面的 governLimiter 不是同一个桶）。
  const escrowLimiter = new IpLimiter(10, 10);
  // 事件写面限速（对齐 httpapi/event.go:59 的双维度判定）：身份维度与 IP 维度各一把**独立**桶。
  const eventLimiterByID = new IpLimiter(EVENT_PER_MINUTE_PER_ID, EVENT_BURST_PER_ID);
  const eventLimiterByIP = new IpLimiter(EVENT_PER_MINUTE_PER_IP, EVENT_BURST_PER_IP);

  adapters.http.handle("GET /healthz", healthzHandler);
  adapters.http.handle("GET /v1/catalog", catalogHandler(db));
  adapters.http.handle("GET /v1/pubkey", pubkeyHandler({ pubHex, issuer: opts.issuer ?? "" }));
  adapters.http.handle("GET /v1/manifest/{pack_id}", manifestHandler(db));
  adapters.http.handle("GET /v1/pack/{pack_id}", packHandler(db));
  // 先注册 HEAD：Node 路由器同具体度时按注册顺序取先者，HEAD 覆盖 GET 的「GET 兼配 HEAD」。
  adapters.http.handle("HEAD /v1/blob/{blob_id}", blobHeadHandler(db, { dataDir }));
  adapters.http.handle("GET /v1/blob/{blob_id}", blobGetHandler({ dataDir, storeKey }));
  adapters.http.handle("GET /v1/release", releaseHandler({ dataDir }));
  // 治理派生 + 社交公开读面（批 A2）。
  adapters.http.handle("GET /v1/contributors", contributorsHandler({ db, storeKey }));
  adapters.http.handle("GET /v1/directory", directoryHandler({ db, storeKey, limiter: governLimiter }));
  adapters.http.handle("GET /v1/comment", commentHandler(db));
  adapters.http.handle("GET /v1/dm/{peer_id}", dmHandler(db));
  // 身份公开只读面（契约 5.2/5.4，批 A3）：公钥查询与 escrow 读取均匿名。
  adapters.http.handle("GET /v1/identity/{id}", identityGetHandler({ db }));
  adapters.http.handle("GET /v1/identity/escrow/{username}", escrowGetHandler({ db, limiter: escrowLimiter }));
  // 身份写面（批 B1）：匿名单登记；托管写入与 /v1/me、/v1/profile 均走签名中间件（体上限 64 KiB）。
  adapters.http.handle("POST /v1/identity/register", identityRegisterHandler({ db }));
  adapters.http.handle(
    "PUT /v1/identity/escrow/{username}",
    requireAuth({ db }, escrowPutHandler({ db })),
  );
  adapters.http.handle("GET /v1/me", requireAuth({ db }, meHandler({ db })));
  adapters.http.handle("POST /v1/profile", requireAuth({ db }, profilePutHandler({ db })));
  // 事件写面（批 B2a）：信封解码 + comment.v1 / dm.v1 / progress.v1 分流。
  adapters.http.handle(
    "POST /v1/event",
    requireAuth(
      { db },
      eventPostHandler({
        db,
        dataDir: dataDir ?? "",
        storeKey,
        byID: eventLimiterByID,
        byIP: eventLimiterByIP,
      }),
    ),
  );
  // 门户 HTML 页面（批 A4）：服务端直读库渲染，与 Go html/template 逐字节一致。
  const portalDeps = {
    db,
    storeKey,
    issuer: opts.issuer ?? "",
    pairingCode: opts.pairingCode ?? "",
    fingerprintHex: opts.fingerprintHex ?? "",
  };
  adapters.http.handle("GET /", indexPageHandler(portalDeps));
  adapters.http.handle("GET /a/{item_id...}", articlePageHandler(portalDeps));
  adapters.http.handle("GET /governance", governancePageHandler(portalDeps));

  const listener = await adapters.http.listen(opts);
  adapters.lifecycle.onShutdown(() => listener.close());
  return listener;
}
