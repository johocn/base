# base P3 余下批次计划（按 P5 六条判据切批）

- 日期：2026-10-02
- 上游：路线计划 `#70`（§1 P3 行、§5 节点职能清单、§6 P5 等价判据）；首批计划 `#73`（§8 不做「P3 余下批次」、§9.2 执行期发现）；接口边界冻结面 `#72`
- 状态：**批 A 已收口、批 B 已切子批开工**（批 A 全量见 §9；批 B 切 B1–B4 见 §10；批 C–E 未开工）
- 范围：**P3 余下批次**，共五批（§1）。本册详列**批 A**（§9 收口）与**批 B**（§10，切 B1–B4）；批 C–E 只登记边界（§8）
- 性质：任务级计划。契约一律回册子，本册不承载契约。

## 0. 本批为什么这么切

`#73 §1` 已定：Go 侧 P3 面 ≈25k 行，一次做完不可验收，必须切批；首批取「离线包闭环」是因为它是唯一**可字节级自证**的段落。余下部分同理——**切的依据是「能不能独立验收」**，不是代码结构。

`#70 §6` 已把退役闸门写成六条**等价判据**，每条都是一个可独立自证的验收面。故余下批次**按判据切**：每批自带一道闸门，不靠「全部做完才知道对不对」。

**用户已定（2026-10-02 本册开工前）**：

| 决策 | 取 |
|---|---|
| 切批原则 | **按 P5 六条判据切**（每批自带验收门） |
| 起始批 | **公开读面 + 门户页**（判据 2） |

## 1. 批次总览

| 批 | 范围 | 对应判据 | 状态 |
|---|---|---|---|
| **A** | **纯匿名公开读 JSON 面 12 条 + 门户页 3 个** | **判据 2**（字节级） | **已收口**（§9） |
| B | 认证读写面：身份写（`identity/register`、`escrow` PUT）/ `me` / `event` / `profile` / `submit` / `blob` POST / `group` 读权（`optionalAuth`）+ `authmw` 的 `X-Base-*` 五头 | 判据 3（签名域与错误码） | **已切 B1–B4**（§10）开工中 |
| C | 治理派生面：`proposal` POST / `proposal/{id}/vote` / `proposal` GET | 判据 5（含 `#65` 小节点豁免） | 未开工 |
| D | 对端同步·反熵：`inventory` / `sync` / `fetch` / `scrub` / `event-sync` + CLI `peer-sync` / `scrub` | 判据 4（结果集一致 + 只增不减） | 未开工 |
| E | `importer` 容器 / 题库 / 视频派生 + CLI `import-video` | 判据 6（pack_id 与 merkle_root 同一） | 未开工 |

判据 1（黄金向量）已由 P1 / `#73` 覆盖，无需再切批。

## 2. 批 A 范围（判据 2：公开读响应体字节级一致）

**边界定死**：批 A **只做纯匿名读**——凡需验签（`requireAuth` / `optionalAuth`）的读接口一律归批 B。故 `GET /v1/group/{group_id}`（`group.go:681`，`optionalAuth`）**不在批 A**。

### 2.1 JSON 公开读 12 条

| # | 路由 | Go 落点 | 已实现 |
|---|---|---|---|
| 1 | `GET /healthz` | `public.go:25` | ✅ `routes/healthz.ts` |
| 2 | `GET /v1/pubkey` | `public.go:30` | — |
| 3 | `GET /v1/catalog` | `public.go:58` | ✅ `routes/catalog.ts` |
| 4 | `GET /v1/manifest/{pack_id}` | `content.go:31` | — |
| 5 | `GET /v1/pack/{pack_id}` | `content.go:58` | — |
| 6 | `GET /v1/blob/{blob_id}` | `content.go:85` | — |
| 7 | `HEAD /v1/blob/{blob_id}` | `content.go:121` | — |
| 8 | `GET /v1/release` | `release.go:14` | — |
| 9 | `GET /v1/comment` | `comment.go:36` | — |
| 10 | `GET /v1/contributors` | `contributor.go:23` | — |
| 11 | `GET /v1/directory` | `directory.go:32` | — |
| 12 | `GET /v1/dm/{peer_id}` | `dm.go:121` | — |

其中 1 / 3 已在 `#73` 落地，本批**只做回归对照**，不改。

### 2.2 门户页 3 个

| # | 路由 | Go 落点 | 模板 |
|---|---|---|---|
| 1 | `GET /{$}`（首页） | `web.go:101` | `web/templates/base.html` + `index.html` |
| 2 | `GET /a/{item_id...}`（文章页） | `web.go:123` | `base.html` + `article.html` |
| 3 | `GET /governance`（治理页） | `web.go:311` | `base.html` + `governance.html` |

`web/` 现状：`web/web.go` 8 行（`go:embed`）+ 模板 123 行（`base.html` 48 / `index.html` 15 / `article.html` 12 / `governance.html` 48）。

## 3. 批 A Task 拆解

移植体例已由 `#73` 打通：Node 侧逐行对齐 Go handler，`db.select` 取数 + `jsonResponse` 统一响应头（`Cache-Control: no-store` / `application/json; charset=utf-8`），**每条路由一个 `.test.ts` 对拍测试**。路由器无需改动（`host/http.ts` 已支持 Go 1.22 具体度排序 + `{rest...}` + 方法限定）。

### Task A1：内容分发读面（6 条）

- 范围：`pubkey` / `manifest` / `pack` / `blob`（GET + HEAD）/ `release`。
- Go 源：`public.go:30-39`、`content.go:31-163`、`release.go:14-28`。
- 交付：`apps/node/src/routes/{pubkey,manifest,pack,blob,release}.ts` + 同名 `.test.ts`。
- 验收：对本节点真实数据面（`#73` 已可产出 pack）逐条比对 —— `status` / `Content-Type` / `Cache-Control` / `ETag` / `If-None-Match` 304 语义 / body 字节。

### Task A2：治理派生 + 社交读面（4 条）

- 范围：`contributors` / `directory` / `comment` / `dm/{peer_id}`。
- Go 源：`contributor.go:23-90`、`directory.go:32-85`、`comment.go:36-164`、`dm.go:121-153`。
- 交付：`routes/{contributors,directory,comment,dm}.ts` + `.test.ts`。
- 注意：`contributors` 依赖 `ContributorRoster` 的**派生口径**（治理册 §4，`RosterTopN=10`）——Node 侧须**逐字复刻**排序与门槛，不得自造口径。

### Task A3：身份只读面（2 条）

- 范围：`GET /v1/identity/{id}` / `GET /v1/identity/escrow/{username}`（均匿名）。
- Go 源：`identity.go:122-160`、`identity.go:211-343`。
- 交付：`routes/identity.ts` + `.test.ts`。
- 注意：写路径（`register` / `escrow` PUT）**不属本批**，见批 B。

### Task A4：门户页（3 个）

- 范围：`/`、`/a/*`、`/governance`。
- Go 源：`web.go:101-389`、`web/`（模板 + `go:embed`）。
- 交付：`apps/node/src/routes/portal.ts` + 模板渲染 + `.test.ts`。
- **本批最高风险项**：Go 用 `html/template`（上下文感知转义 + 空白语义）。须定死渲染等价口径，见 §5 风险 1。

### Task A5：门禁 + 回填 + `commit` / `push`

- 跑 §4 全部门禁，回填 §9「执行实况」，登记 `docs/README.md`，提交**仅本批文件**。

## 4. 门禁（G1–G6）

| # | 门禁 | 判据 |
|---|---|---|
| G1 | Go 回归 | `go build ./...` / `go vet ./...` / `go test ./...` 全绿（本批**不动 Go**，作基线回归） |
| G2 | Node 类型 | `npx tsc --noEmit` 无输出 |
| G3 | Node 测试 | `npx vitest run` 全绿，且**新增 12 条路由各自有对拍用例** |
| G4 | **字节级对拍** | 同一数据集下 Go 节点与 Node 节点，逐条比对 `status` / 头 / body 字节；**任一分歧即阻塞**（判据 2 的唯一判据） |
| G5 | 禁碰校验 | `git diff --stat` 证明未动 `internal/**`、`packages/protocol-ts/**`、`web/**`、`#72` 冻结的 `Adapters` 边界 |
| G6 | 提交洁净 | 只 `add` 本批文件；不得混入既有工作区改动（`.gitignore`、`internal/httpapi/web.go`）与构建残留 |

## 5. 风险与处置

| # | 风险 | 处置 |
|---|---|---|
| 1 | **门户页 `html/template` 字节级等价最难** | 备选：门户页拆为**批 A2**，本批先交 JSON 面（判据 2 的 JSON 部分可独立验收）。是否拆，G4 首轮对拍后定 |
| 2 | `optionalAuth` 读接口需验签 | `GET /v1/group/{group_id}` 归批 B；批 A 不引入任何认证面 |
| 3 | Node 侧模板取数路径未定 | 须定死「同仓读取 `web/templates`」还是「随包分发」；无论哪种，**同一份模板不做两个渲染面** |
| 4 | Node `store.ts`（281 行）覆盖不足 | 读面所需查询（manifest / pack / blob / release / comment / contributors / directory / dm / identity）若缺方法，在 Task 内补；**不改 schema**（`store/schema.ts` 已 353 行全量） |
| 5 | 工作区既有改动被误提交 | 严格执行 G6；`.gitignore` / `internal/httpapi/web.go` 绝不 `add` |

## 6. 文件清单与禁碰

**新增（本批）**：`apps/node/src/routes/{pubkey,manifest,pack,blob,release,contributors,directory,comment,dm,identity,portal}.ts` 及各自 `.test.ts`。

**修改（本批，限）**：`apps/node/src/serve.ts`（装配路由表）、`apps/node/src/store/store.ts`（仅在缺查询方法时补）、`docs/README.md`（登记）、本册（回填 §9）。

**禁碰**：`internal/**`（Go 实现，P5 前并行不删）、`packages/protocol-ts/**`、`web/**`（只读）、`#72` 冻结的 `Adapters` 边界（`packages/core-ts` 的 `ServerAdapters`）、内容包规范 v1、`schema_version`。

## 7. 不做

- 不做批 B–E（§8 登记边界，另立任务级计划或在本册后续扩章）。
- 不做 iOS。
- 不改内容包规范 v1、不 bump `schema_version`、不加配置项。
- 不为兼容复制核心逻辑（过渡期只用 re-export）。

## 8. 后续批次边界（只登记，不展开）

- **批 B**：`identity/register`（`identity.go:91`）、`identity/escrow` PUT（`:161`）、`me`、`event`（`event.go`，含 `eventTypeRegistry` fail-closed 白名单）、`profile`、`submit`（`submit.go` 393 行）、`blob` POST（`blob.go:17`）、`group` 读权（`group.go:681`）+ `authmw.go`（236 行，`X-Base-*` 五头）。验收 = 判据 3。**已切 4 子批 B1–B4，详列见 §10**（`govern.v1` 分支已定随 event 一起做，不留批 C）。
- **批 C**：`govern.go`（405 行）+ `govern_event.go`（222 行）+ `directory_proposal`；验收 = 判据 5。
- **批 D**：`peer.go`（334 行）+ `internal/peersync`（2,784 行）+ CLI `peer-sync` / `scrub`；验收 = 判据 4（**只增不减**须保持）。
- **批 E**：`internal/importer`（1,819 行）容器 / 题库 / 视频派生 + CLI `import-video`；验收 = 判据 6。

## 9. 执行实况

**状态：批 A 已收口**（Task A1–A5 全部落地；批 B 未开工）。

| Task | 产出 | 提交 |
|---|---|---|
| A1 | `routes/{pubkey,manifest,pack,blob,release}.ts` + 同名 `.test.ts`（内容分发 6 条：`pubkey` / `manifest` / `pack` / `blob` GET / `blob` HEAD / `release`） | `865584a` |
| A2 | `routes/{contributors,directory,comment,dm}.ts` + 同名 `.test.ts` + `routes/derived.ts`（治理派生逐字复刻：`contributorRoster` / `governRoster` / `listProposalViews` / `IpLimiter`） | `481655b` |
| A3 | `routes/identity.ts` + `.test.ts`（`GET /v1/identity/{id}` / `GET /v1/identity/escrow/{username}`） | `04920d5` |
| A4 | `routes/portal.ts`（1,279 行：`html/template` 子集引擎）+ 7 组 `__fixtures__/portal/` 黄金夹具 + `portal.test.ts` | `ec39e5f` |
| A5 | 门禁 G1–G6 + 本册 §9 回填 + `docs/README.md` 登记 | 见本次提交 |

合计：**35 文件 / +5236 −5**。批 A 交付 = 纯匿名公开读 **JSON 12 条**（`pubkey` / `manifest` / `pack` / `blob` GET / `blob` HEAD / `release` / `contributors` / `directory` / `comment` / `dm` / `identity` / `identity/escrow`；`healthz` / `catalog` 由 `#73` 落地，本批只作回归对照）+ **门户页 3 个**（`/` / `/a/*` / `/governance`）。

### 9.1 门禁 G1–G6（逐条通过）

| 门 | 结果 | 证据 |
|---|---|---|
| G1 | 通过 | `go build ./...` / `go vet ./...` / `go test ./...` 全绿（本批**不动 Go**，作基线回归） |
| G2 | 通过 | `apps/node` `npx tsc --noEmit` **0 错误** |
| G3 | 通过 | `apps/node` `npx vitest run`：**20 文件 / 119 用例全绿**。批 A 开工前（`#73` 收口）为 **9 文件 / 53 用例** ⇒ +11 文件 / +66 用例；12 条新路由**各自有对拍用例**，`healthz`/`catalog` 由 `smoke.test.ts` 覆盖 |
| G4 | 通过 | **字节级对拍 0 分歧**：JSON 面 **24 条 token** + 门户页 **12 条 token**，同数据集下 Go 节点（真 mux + 真 handler）与 Node 节点（真适配器 + 真路由 + 真库）逐条比对 `status` / 头 / body 字节，实况见 §9.2 |
| G5 | 通过 | `git diff --stat -- internal/` **无输出**；`packages/protocol-ts/**`、`web/**`、`#72` 冻结的 `Adapters` 边界、内容包规范 v1、`schema_version` 均未动 |
| G6 | 通过 | 只 `add` 本批文件；临时取证件（两个 `g4*.tmp.test.ts` + `tmp_g4verify/`）**已删除**，`.gitignore` / `internal/httpapi/web.go` / `based-linux-amd64` / `.tmp/` **均未入暂存** |

### 9.2 G4 字节级对拍实况

**方法**：`based.exe import-md` 造数 → `based.exe export -sign-key` 产包并登记 `packs` 行 → Node 驱动补数据（`profiles` / `directory_terms` / `govern_proposals`+票 / `comment.v1` 3 条含墓碑 / `dm.v1` 2 条 / 真块加密落盘 + `blobs` 行）→ 固定 `issuer=base-node-1`、同一 `sign-key`、`version=0.1.0` → 两侧读**同一 data 目录**逐条对拍。对照头集合：`Content-Type` / `Cache-Control` / `ETag` / `X-Content-Type-Options` / `Access-Control-Allow-Origin`。

**JSON 面 24/24 OK**（`sha256` 前 12 位；两侧全等）：

| token | status | body | sha |
|---|---|---|---|
| `GET /healthz` | 200 | 30B | `c624ae18fcea` |
| `GET /v1/pubkey` | 200 | 109B | `7c07f104e6bf` |
| `GET /v1/catalog`（含 `?since=99` 短路） | 200 | 783B / 97B | `b5a98c6bbdc0` / `1ca68ce00e49` |
| `GET /v1/manifest/{pack_id}` | 200 | 1225B | `9090cfff4590` |
| `GET /v1/manifest/{未登记 / 非法}` | 404 / 400 | 25B / 27B | `c028ac99f382` / `f22566127837` |
| `GET /v1/pack/{pack_id}` | 200 | 45056B | `bec0bd106881` |
| `GET /v1/blob/{blob_id}` | 200 | 27B | `bc899adbd165`（`ETag` 两侧同为 `"{blob_id}"`） |
| `HEAD /v1/blob/{blob_id}` | 200 | 0B（`Content-Length` = 明文 size） | `e3b0c44298fc` |
| `GET /v1/blob/{blob_id}` + `If-None-Match` | **304** | 0B | `e3b0c44298fc` |
| `GET/HEAD /v1/blob/{未知 / 非法}` | 404 / 400 | 25B / 27B | `24f6e4052edb` / `e8087807a5d2` |
| `GET /v1/release` | 200 | 67B | `08e29b0dbbdc` |
| `GET /v1/comment`（含 `limit` / 游标翻页） | 200 | 472B / 516B / 35B | `720b632c9c1f` / `e6557092b576` / `6e819739a95b` |
| `GET /v1/contributors` | 200 | 157B | `a963821adbdd` |
| `GET /v1/directory`（含 `?version=<v>` 短路） | 200 | 201B / 31B | `427f751f69f3` / `5bf7388522b9` |
| `GET /v1/dm/{peer_id}`（含 `limit` / 非法） | 200 / 400 | 366B / 243B / 32B | `92a0c1f684d8` / `b53ff2cbc2e0` / `69dfe186b482` |

**门户页 12/12 OK**：`/`、`/?q=1`、`/a/{3 篇}`、`/a/{不存在}`、`/a/{id}/extra`、`/governance`、`/governance?x=1` 全等；`/a/`、`/governance/`、`/nope` 的 404 亦逐字节相同（如 `/governance` 4096B `8e195b0aeaf8`、`/a/article/become-a-node` 3743B `2aed69e8fef9`）。

### 9.3 执行期发现（登记，不在本批修）

1. **`httptest.ResponseRecorder` 不平滑真 server 语义**：HEAD 的响应体在连接层被丢弃（`net/http/server.go:381`「Eat writes」），且真 server 会自动补 `Content-Length`（`:1382`，条件 `!isHEAD || len(p) > 0`）。故 G4 对照口径定死两条：① Go 取证件对 HEAD **手工丢弃记录体**；② **不比对 `Content-Length`**（自动 `Content-Length` 与分块判定 recorder 不复刻）。首轮 `/v1/blob/{未知} HEAD` 的「分流」即此**假阳性**，非批 A 缺陷——真 server 下两侧同为「404 + `Content-Length: 25` + 空体」。
2. **取数顺序是硬约束**：Go 侧 `store.Open` 会动库文件，**必须先于** Node 侧 `openDb`（WASM 连接）打开；反序会让 `node-sqlite3-wasm` 落在失效句柄上，全库读路由齐报 `unable to open database file`。批 B–E 的对拍脚本按此定序。
3. **目录 pending 派生的 `item_id` 形态**：为 `dir/<kind>/<hash16>`（三段，`DirectoryKindOfItemID`），非 `term:<kind>:<key>`——后者只用于**治理页**的提案展示。后续造数不得混用。

## 10. 批 B：认证读写面（判据 3）

**状态：已切子批，B1 开工中。**

**开工前决策（2026-10-02，用户拍板）**：

| 决策 | 取 |
|---|---|
| 批 B 切法 | **再切 4 子批 B1–B4**，逐子批独立跑门禁、独立提交、独立验收（体量约为批 A 数倍，一次做完无法二分定位） |
| `event` 的 `govern.v1` 归属 | **随 event 一起做**（不留批 C）。理由：`eventTypeRegistry` 是全量白名单（5 条），缺一类则 `POST /v1/event` 的 fail-closed 判定与错误码无法等价，判据 3 不自证 |

### 10.0 地基与硬约束（四子批共用）

| 项 | 现状 / 约束 |
|---|---|
| 请求签名 | `protocol-ts` 已具 `requestSignBytes` / `verify` / `sha256Hex` / `canonicalize`（**本批不改 protocol-ts**） |
| 冻结面 | `core-ts` 的 `ServerRequest` / `ServerHandler`（`#72` 终态）**不得改**；identity 以**业务函数形参**下传，不塞进 `ServerRequest` |
| 取数顺序 | Go `store.Open` 必须先于 Node `openDb`（§9.3 发现 2），对拍脚本照此定序 |
| 体上限 | `requireAuth` / `optionalAuth` = `maxJSONBody` 64 KiB；`POST /v1/blob` = `maxBlobBytes`(8 MiB) + 4 KiB（`requireAuthLimit`） |
| IP 限速 | `clientIP` 退化为**单桶键**（批 A 既定，`ServerRequest` 无 RemoteAddr）；令牌桶算法复用 `derived.ts` 的 `IpLimiter` |
| 错误体 | `writeAuthErr` → `{"code":..., "error":...}`（Go map 键字典序，**code 在前**），区别于既有 `writeError` 的 `{"error":...}` |
| schema | **不动**：`auth_nonces` / `identities` / `escrow` / `events` / `profiles` / `progress` / `checkin_days` / `tag_links` / `groups` 等已全量（`store/schema.ts`） |

### 10.1 子批 B1：认证地基 + 身份写面

- 范围：`authmw`（236 行）+ `POST /v1/identity/register`（`identity.go:91`）+ `PUT /v1/identity/escrow/{username}`（`:161`）+ `GET /v1/me`（`:243`）+ `POST /v1/profile`（`contributor.go:70`）。
- 交付：
  - `routes/authmw.ts`：`authErrText` **全表** + `writeAuthErr` + `authenticate`（契约 3.2 七步：五头齐全 → alg/格式 → 取公钥 → 时间窗 ±300s → nonce 去重 10min → 体哈希+待签字节 → 验签）+ `requireAuth` / `requireAuthLimit` / `optionalAuth` / `hasAnyAuthHeader`。
  - store 写层：`LookupIdentity`(单条含 `created_at`) / `RegisterIdentity` / `PutEscrow` / `UseNonce` / `PruneNonces` / `TouchIdentity` / `ListProgressByID` / `CheckinDaysOf`。
  - `routes/identity.ts` 扩 register + escrow PUT（identity 形参）；`routes/me.ts`；`routes/profile.ts`。
  - `serve.ts` 装配（含 `escrowLimiter` 复用）。
- 验收：`authmw` 单测逐条覆盖五头缺失 / 半带头 / alg 不支持 / id 非法 / ts 非十进制 / nonce 非 16 字节 hex / sig 非 hex / 身份未登记 / 时间窗越界 / nonce 重放 / 签名错 / 体超限 的**status + code**；四条路由对拍。
- 注意：`optionalAuth` 语义 = 五头**全缺**按匿名放行，缺一半仍 `auth_missing_header` 拒。

### 10.2 子批 B2：event 面（骨架 + 4 类型分流）

- 范围：`POST /v1/event`（`event.go:44`）+ `eventTypeRegistry` fail-closed（`event.go:25`，5 条白名单）+ `putBareEvent` + `comment.v1`（`event.go:108`）+ `dm.v1`（`dm.go:59`）+ `progress.v1`（`progress.go:74`）+ `govern.v1`（`govern_event.go:158`）。
- 交付：`routes/event.ts`（路由 + 骨架 + comment + `verifyEventSig` + `parseCommentBody`）、`routes/progress.ts`、`routes/governEvent.ts`；`routes/dm.ts` 扩 dm event；store：`PutEvent` / `GetEventByID` / `IsRevokedEvent` / `HasCommentEvent` / `PutProgressProjection` / govern 投影所需方法。
- 硬约束：内容签名 `canonical({event_id,type,created_at,body})` 逐字节等价；`body` **保留客户端原始键集**（多一未知键即拒，不补空串）；`created_at` 用 `json.Number` 字面形态重建；**落块必须在验签之后**；`received_at` 回读为权威值；限速双维度（ID + IP）。
- 验收：5 类型 × {直角 / 缺键 / 未知键 / 签名错 / 墓碑 / 超限 / 未知类型} 的 status + code 对拍。

### 10.3 子批 B3：submit + blob POST

- 范围：`POST /v1/submit`（`submit.go` 393 行，`article`/`quiz`/`tag`/`course`/`lesson` 五形态）+ `POST /v1/blob`（`blob.go:17`，multipart 单块 8 MiB）。
- 交付：`routes/submit.ts`、`routes/blob.ts` 扩 POST；store：`UpsertSubmission` / `UpsertTagSubmission` / `UpsertSegmentSubmission` / `PutBlob` / `HasBlob` / `GetItem` / `GovernorSet`；multipart 解析（只认字段 `file`）。
- 验收：`author_id_forbidden` / 五形态 item_id 校验 / segments 三区间铁律 / tag 资格（`tag_not_governor`）与目标存在性（`tag_target_not_found`）/ 写限速 429（`item_rate_limited`）/ `content_hash` 服务端重算 / `author_sig` 校验 的逐条对拍。
- 风险：multipart 字节级边界；`SegmentsContentHash` 与 `MaterializeTagSegments` 逐字节。

### 10.4 子批 B4：group（`group.v1` event + 读权 `optionalAuth`）

- 范围：`GET /v1/group/{group_id}`（`group.go:681`，`optionalAuth`）+ `group.v1` event（`group.go:322`）+ group 派生（roster / epoch / message）。
- **编排说明**：`group.v1` event 归本子批而非 B2——它与 group 读权共享同一批 group 派生逻辑，拆开会产生跨子批的重复依赖。
- 交付：`routes/group.ts`；store：group 相关读写方法。
- 验收：开放圈匿名可读 / 封闭圈**非成员一律 404（不泄露存在性）** / 成员签名读权 / 五头缺失时 `optionalAuth` 按匿名分支 的对拍。

### 10.5 门禁（沿用 §4 G1–G6，每子批独立跑）

G4 对拍口径照 §9.2 方法：Go 真 mux + 真 handler（`httptest`）vs Node 真适配器 + 真路由 + 真库；HEAD 手工丢弃记录体、**不比对 `Content-Length`**（§9.3 发现 1）。

### 10.6 风险

| # | 风险 | 处置 |
|---|---|---|
| 1 | 验签字节级（canonical / 体哈希 / query 原文） | 复用 `protocol-ts`，不重写；对拍用真签名请求（真私钥签、真公钥验） |
| 2 | identity 下传 vs `#72` 冻结面 | 业务函数带 `identityId` 形参，**不改** `ServerRequest` |
| 3 | nonce 表语义（键含 id，防抢注） | 逐字复刻 `UseNonce(id, nonce, now)` 与 `PruneNonces`；对拍重放 |
| 4 | multipart 解析（B3） | 只支持单块字段 `file`、8 MiB 上限；边界对齐 Go `MultipartReader` |
| 5 | `POST /v1/event` body 键集保真（B2） | 保留客户端原始键集，不补键不删键 |
| 6 | `group.go` 800 行体量（B4） | 单独成批、内聚 group 派生，不拆到 B2 |
| 7 | 工作区既有改动被误提交 | 严格 G6；`.gitignore` / `internal/httpapi/web.go` 绝不 `add` |
