# 节点 TLS 身份面收敛（任务级计划 #77）

- 日期：2026-10-03
- 上游：P5 计划 `#76`（§5 残留风险 2 = **GAP-B 登记未修**；§8 GAP-B 段）；路线计划 `#70`（§6 判据 2 / 判据 4）；Go 参照实现 = `cmd/based/serve.go:61-76`、`cmd/based/peerconfig.go:61-92`、`internal/httpapi/tlscfg.go:151-199`
- 状态：**已出，待执行**
- 性质：任务级计划，**不承载契约**。契约一律回册子。

## 0. 一句话

P5 把节点从 Go 切到了 Node，等价判据是按**当时真实存在的配置**取的证；GAP-B 是登记在案的剩余分歧。
本册把「TLS 身份」这一整面收敛干净——**加载判定**（登记的 B-①）、**主监听 TLS 接线**（B-②，本轮新发现）、
**对端监听的双向 TLS 指纹固定**（B-③，本轮新发现，**安全面**），三处一次修完，再以运行态取证复验。

## 1. 三处不等价（证据）

| # | 差异 | Go（参照） | Node（现状） | 后果 |
|---|---|---|---|---|
| B-① | 身份**加载判定** | `serve.go:61-76`：`!plaintext` **或** `-peer-addr` 非空 | `main.ts:91-94`：`-peer-addr` 非空 **或** `-peers` 非空 | ① `tls-cert≠off` 且无 `-peer-addr`/`-peers` → Go 加载、Node 不加载；② `-peers` 非空但无 `-peer-addr` 且 `tls-cert=off` → Node 加载、Go 不加载 |
| B-② | 主监听**从不 TLS** | `ServerTLSConfig(info, nil)`（`tlscfg.go:170-182`）起 TLS 主监听 | `main.ts` 从不给 `startServer` 传 `opts.tls`；`host/http.ts:240-248` 只在有 `opts.tls` 时 `https.createServer` | `BASE_TLS_CERT=<路径>` 在 Node 上**完全无效**，主监听恒明文（B-① 格里「丢失 TLS 身份」的实质） |
| B-③ | 对端监听**不校验对端证书** | `ClientAuth = RequireAnyClientCert` + `VerifyPeerCertificate = PeerVerifier(peerFPs)`（`tlscfg.go:176-180`） | `TlsConfig.peerFingerprints` / `trustPeerByFingerprint` **只被生产、只被单测断言，无任何消费者**；`host/http.ts` 只用 `certFile`/`keyFile` | Node 对端监听**不要求客户端证书**⇒ 入站对端身份零校验。线上 `base-cache` 单元已跑 Node，`BASE_PEER_ADDR=127.0.0.1:8082` 目前处此状态 |

**B-③ 是退役引入的真实回退**：P5 双影子对练第 ② 段只验过「**Node 作出站客户端**连 Go 对端口」（F 向），
「**他人连 Node 对端口**」（G 向）从未取证 —— 反例取证当时是在 **Go** 的 `:8092` 上做的。

## 2. 两条定案（用户 2026-10-03 拍板）

| # | 决策项 | 定案 |
|---|---|---|
| 1 | 修复范围 | **三层全修**：B-① + B-② + B-③ 一次修完，不拆批留尾 |
| 2 | `tls-cert=off` + `-peers` 非空 + 无 `-peer-addr` 这一格 | **超集语义**：Node 在「主监听要 TLS」**或**「对端监听要身份」**或**「出站要身份」任一成立时加载身份。该格里 Go 因 `serve.go` 漏了 `-peers` 判据导致出站每轮失败（与 `peerconfig.go:83-92` 的 `tlsInfo()` 自身文档相矛盾）——**不复制这个缺陷** |

**边界**：本册**不改任何 Go 文件**；**不删 Go 实现**；不切客户端；不动 `#72` 冻结的 `Adapters` / `ServerAdapters` 边界；不做 P6。

## 3. Task 列表

### Task T1　身份加载判定 + 主监听 TLS 接线（B-① + B-②）

- `main.ts` 的加载判定改为三因子并集（超集语义）：

  | 因子 | 条件 | 对应 Go |
  |---|---|---|
  | 主监听要 TLS | `tls-cert` 非 `off` | `!plaintext`（`serve.go:67-71`） |
  | 对端监听要身份 | `-peer-addr` 非空 | `serve.go:72-76` |
  | 出站要身份 | `-peers` 非空 | **Go 缺失**（超集格，定案 2） |

  三因子全假 ⇒ **不加载**（对齐 Go：off + 无 peer-addr + 无 peers）。
- 证书路径仍走 `resolveTlsMaterial`：`off` → 默认 `<data>/tls/node.crt|key`（对齐 `defaultCertPaths`）；非 `off` → `-tls-cert`/`-tls-key` 或默认（对齐 `certPaths`）。**路径决策不改**。
- 主监听接线：`tls-cert` 非 `off` 时给 `startServer` 传 `opts.tls = adapters.tls.serverConfig(info, [])`
  —— **空白名单 = 不要求客户端证书**，与 `ServerTLSConfig(info, nil)`（不设 `ClientAuth`）逐条对齐；`off` 时**不传** `opts.tls`（明文，线上 `base-cache` 行为不变）。
  复用既有 `TlsAdapter.serverConfig` ⇒ **不动冻结边界**。
- GAP-A 不可回退：门户 `fingerprintHex` / `pairingCode` 仍取自同一份 `info`（`#76` 的修法保持不变）。
- **首步为探针（硬门，不过即停）**：单实例（`BASE_TLS_CERT=<路径>`、无 `-peer-addr`/`-peers`）
  ① `curl -k https://127.0.0.1:<port>/healthz` = 200；② 同端口 `curl http://…` **失败**；
  ③ `based-node.mjs tls-cert` 的指纹/配对码与进程内一致；④ 门户 `GET /` 身份行非空（GAP-A 不回退）。

### Task T2　对端监听双向 TLS 指纹固定（B-③）

- **单一实现**：把「指纹归一化 + raw 证书校验」抽为 `host/tls.ts` 的导出纯函数
  `verifyPeerFingerprint(raw: Uint8Array | undefined, allowed: string[]): Error | null`，
  `TlsAdapter.verifyPeer` 改调它（**方法签名与对外形态不变**），`host/http.ts` 引**同一个**函数 ⇒ 不产生第二份实现。
- `host/http.ts` 的 `listen(opts)`：当 `opts.tls.trustPeerByFingerprint === true` 时
  - `https.createServer({ cert, key, requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.2" })`
    —— `rejectUnauthorized: false` 是必需的：节点证书是自签，链校验必失败，信任完全由指纹承担（与 Go 的 `InsecureSkipVerify` + 指纹同构）。
  - `server.on("secureConnection", socket => …)`：**握手完成即刻**校验 `socket.getPeerCertificate(false).raw`
    —— `raw` 为空（未提供证书）**或** 指纹不在白名单 ⇒ `socket.destroy()`，客户端在 **TLS 层**失败（对齐 Go 握手期拒绝）。
  - **关键风险（必须由探针覆盖）**：`rejectUnauthorized:false` 下「客户端不带证书」的握手**会成功**，
    故唯一的 fail-closed 点就是上面的钩子 —— 漏写即 **fail-open**（与 GAP-C 同类的隐蔽性）。
- `trustPeerByFingerprint === false`（空白名单）时**不设** `requestCert` —— 对齐 Go「白名单为空则不设 `ClientAuth`」。
- **出站不动**：`peersync/peer.ts` 与 GAP-C 的 `maxCachedSessions: 0` 一字不改。
- 单测：`verifyPeerFingerprint` 三格（空 raw / 错指纹 / 白名单命中）+ `listen` 的 `requestCert` 决策两格。

### Task T3　本机双影子对练（G 向补验）

复用 P5 的 `.tmp/` 工装体例（**不入版本控制**）：

- **G 向（本册主目标）**：起 Node 影子（对端监听 + `BASE_PEERS` 白名单 = 客户端指纹），三格取证
  —— 白名单指纹客户端 ⇒ 通过；错指纹 ⇒ TLS 层拒绝；**无证书** ⇒ TLS 层拒绝。客户端用 `openssl s_client` 与 Go 影子（`-peers` 指向 Node）各取一遍。
- **F 向回归**：Node 影子作出站客户端连 Go 对端口，反熵跑通（确认 T2 未扰 GAP-C 修复）。
- **B-② 取证**：Node 影子以 `BASE_TLS_CERT=<路径>`（非 `off`）起主监听，核 T1 探针四项。
- **B-① 判定矩阵**：五格配置（`off`/非 `off` × 有无 `-peer-addr` × 有无 `-peers`）在 Node 与 Go 上各跑一次，逐格对照「是否加载身份」，**超集格显式标注定案 2**。

### Task T4　门禁 + 全量对拍回归

- 跑 §4 的 G1–G3（静态门禁）。
- 复用 P3 / P5 工装重跑一次**全量对拍**（G7）：确认 T1/T2 未扰动已过判据（HTTP 分歧 0 条、DB 快照对称差 0 行）。

### Task T5　部署 + 线上复验

- 重打包 `apps/node/dist/based-node.mjs` → 备份远端为 `based-node.mjs.bak-<ts>` → `scp` → `systemctl restart base-cache`。
- 线上复验（**一次性、只读为主**）：`/healthz`、`/`、`/v1/catalog`、`/v1/release` 全 200；一轮反熵成功、日志无「对端未提供证书」；
  **从服务器本机对 `127.0.0.1:8082` 取证**：不带证书的 `openssl s_client` ⇒ 被拒；带 `base` 单元证书 ⇒ 通过。
- **回退**：`cp` 回 `.bak` + 一次 `systemctl restart base-cache`。
- 零生产写：不动 `base.service`（仍 Go）、不动 nginx、不动客户端任何指向。

### Task T6　回填 + 提交

- 回填本册 §7 执行实况；`docs/README.md` 增 `#77` 行与 §5 条目；把 `#76` 册 §5 残留风险 2 / §8 GAP-B 措辞改为**「已修（= #77）」**。
- 只 add 本册相关文件后提交并 push。

## 4. 门禁 G1–G7

| # | 门禁 | 口径 |
|---|---|---|
| G1 | Go 侧全绿且零改动 | `go build ./... && go vet ./... && go test ./...`；`git diff --stat -- internal/` **无输出** |
| G2 | TS 类型 | `npx tsc --noEmit` 全 0 错误 |
| G3 | 单测 | vitest 全绿；`apps/node` 用例数**只增不减**（新增 B-②/B-③ 单测） |
| G4 | **B-① 判定矩阵全过** | §3 T3 的五格矩阵 Node/Go 逐格对照；超集格标注定案 2 |
| G5 | **B-② 主监听 TLS** | T1 探针四项全过（https 200 / http 失败 / 指纹一致 / 门户身份行非空） |
| G6 | **B-③ 对端 mTLS 拒绝** | 白名单指纹通过、错指纹 TLS 层拒绝、**无证书 TLS 层拒绝**（fail-closed，三格缺一不可）；空白名单时不要求证书 |
| G7 | 回归 + 仓库纪律 | 全量对拍 HTTP 分歧 0 条 且 DB 快照对称差 0 行；只 add 本册相关文件（**绝不** add `.tmp/`、`based-linux-amd64`、`.gitignore`、`internal/httpapi/web.go`） |

## 5. 风险与回退

| # | 风险 | 处置 |
|---|---|---|
| 1 | `rejectUnauthorized:false` + `requestCert:true` 下「无证书」握手成功 ⇒ **fail-open** | 唯一 fail-closed 点 = `secureConnection` 钩子；G6 把「无证书」列为**独立一格**，探针不过即停 |
| 2 | `secureConnection` 钩子与 `destroy()` 时机在不同 Node 小版本上语义漂移 | T1/T2 探针先在本机实测（线上 Node = v20.20.2）；异常即改用请求层兜底并回填 |
| 3 | 改加载判定牵动 GAP-A 的边界（门户身份行） | G5 第 ④ 项显式回归门户身份行；`#76` 的修法一字不动 |
| 4 | 线上 `base-cache` 对端口开始要求客户端证书，可能挡掉 `base`（Go）的对端连接 | `base` 侧 `-peers` 白名单本就在，且 `base-cache` 复用原证书（指纹未变）⇒ 预期通过；T5 用 `openssl` 双向取证，异常即回退 |
| 5 | 主监听 TLS 接线后 `off` 路径受影响 | 只有 `!off` 才传 `opts.tls`；线上两单元现均为 `off`（`base` 仍 Go）⇒ 零生产变化 |
| 6 | 重打包/重启把线上缓存节点带下去 | 远端留 `.bak`，回退 = 一次 `restart`；切换前先备份、先探活后收工 |
| 7 | 三处共享同一套接线，先修一处会与后修冲突 | 定案 1 就是为此：**一次修完再取证**，不拆批 |

## 6. 不做

- 不改任何 Go 文件；不删 Go 实现（`internal/` / `cmd/` / `web/` / `based-linux-amd64` 全留）。
- **不退役 `base` 单元**（源节点仍跑 Go，含签名私钥与权威写，超出本册范围）。
- 不改内容包规范 v1；不 bump `schema_version`；不切客户端（APK / 落地页 / `/v1/release` 指向 / `min_version` 全不动）。
- 不在生产节点执行任何写操作；不动 `base.service` 与 nginx。
- 不改 `#72` 冻结的 `Adapters` / `ServerAdapters` 边界（复用 `TlsAdapter.serverConfig` 与既有 `TlsConfig` 字段即可覆盖全部改动）。
- 不做 P6（融合治理实现轨）；不为兼容复制双份核心；不做 iOS。

## 7. 执行实况

（待执行后回填：T1–T6 逐项证据、G1–G7 判定、超集格与 Go 缺失判据的对照、服务器复验输出、回退备份路径。）