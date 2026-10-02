# base P3 余下批次计划（按 P5 六条判据切批）

- 日期：2026-10-02
- 上游：路线计划 `#70`（§1 P3 行、§5 节点职能清单、§6 P5 等价判据）；首批计划 `#73`（§8 不做「P3 余下批次」、§9.2 执行期发现）；接口边界冻结面 `#72`
- 状态：**批 A 已收口、批 B1–B3 已收口**（批 A 全量见 §9；批 B 切 B1–B4 见 §10，B1 实况见 §10.7、B2 实况见 §10.8、B3 实况见 §10.9；B4 未开工；批 C–E 未开工）
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
| B | 认证读写面：身份写（`identity/register`、`escrow` PUT）/ `me` / `event` / `profile` / `submit` / `blob` POST / `group` 读权（`optionalAuth`）+ `authmw` 的 `X-Base-*` 五头 | 判据 3（签名域与错误码） | **B1–B3 已收口**（§10，实况 §10.7 / §10.8 / §10.9）；B4 未开工 |
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

- **批 B**：`identity/register`（`identity.go:91`）、`identity/escrow` PUT（`:161`）、`me`、`event`（`event.go`，含 `eventTypeRegistry` fail-closed 白名单）、`profile`、`submit`（`submit.go` 393 行）、`blob` POST（`blob.go:17`）、`group` 读权（`group.go:681`）+ `authmw.go`（236 行，`X-Base-*` 五头）。验收 = 判据 3。**已切 4 子批 B1–B4，详列见 §10**（`govern.v1` 分支已定随 event 一起做，不留批 C；B1–B3 已收口）。
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

**状态：B1–B3 已收口（实况见 §10.7 / §10.8 / §10.9），B4 未开工。**

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

### 10.7 执行实况（B1）

**状态：B1 已收口**（B2–B4 未开工）。

**产出**：
- `routes/authmw.ts`：`authErrText` 全表（逐字取 `authmw.go:20-79`）+ `writeAuthErr`（`{"code":...,"error":...}`，Go map 字典序 code 在前）+ `authenticate` 契约 3.2 七步 + `requireAuth` / `requireAuthLimit` / `optionalAuth` / `hasAnyAuthHeader`。
- `routes/decode.ts`：严格 JSON 解码器，对齐 Go `json.NewDecoder(...).Decode(&struct)` 口径（只解首值不拒尾随、顶层 `null` 为 no-op、字段类型严格、int64 只收十进制字面量）；含**保留数字原始字面量**的极简解析器（`JSON.parse` 会把 `1e2` 归一成 100，无法判 int64）。
- `routes/identity.ts` 扩 register（匿名，`409 identity_pubkey_conflict`）+ escrow PUT（`AuthedHandler`，`EqualFold` 比对 → `403 escrow_identity_mismatch`）；新增 `routes/me.ts` / `routes/profile.ts`；`serve.ts` 装配 4 条路由（`requireAuth({db}, ...)` 三条 + register 匿名）；`derived.ts` 新增导出 `isHexNonEmptyEven`、`trimGoSpace` 转 export。
- 测试：新增 `authmw.test.ts` / `me.test.ts` / `profile.test.ts`，`identity.test.ts` 扩 2 组。

#### 10.7.1 门禁 G1–G6（逐条通过）

| 门 | 结果 | 证据 |
|---|---|---|
| G1 | 通过 | `go build ./...` / `go vet ./...` / `go test ./...` 全绿（本批不动 Go，作基线回归） |
| G2 | 通过 | `apps/node` `npx tsc --noEmit` **0 错误** |
| G3 | 通过 | `apps/node` `npx vitest run`：**23 文件 / 168 用例全绿**（B1 开工前 23/158 ⇒ +10 用例） |
| G4 | 通过 | **字节级对拍 0 分歧（40/40 token）**，实况见 §10.7.2 |
| G5 | 通过 | `git diff --stat -- internal/` **无输出**；`packages/protocol-ts/**`、`#72` 冻结的 `Adapters` / `ServerAdapters` 未动 |
| G6 | 通过 | 只 `add` 本批文件；`.gitignore` / `internal/httpapi/web.go` / `based-linux-amd64` / `.tmp/`（含 `g4/` 取证件）均未入暂存 |

#### 10.7.2 G4 字节级对拍实况（B1）

**方法**：Node `openDb` + `migrate()` 建全量 schema → 插固定数据（`identities` 1 行 / `progress` 2 行 / `checkin_days` 1 行）→ 关闭 → **复制两份**（`go/base.db` / `node/base.db`）→ Go 侧 `store.Open` + `httpapi.New` + `httptest` 真 server；Node 侧 `openDb` + `startServer` 真 server → 按**同一顺序**发 40 条 token（真私钥签、真公钥验）→ 逐条比对 `status` / 4 对照头（`content-type` / `cache-control` / `x-content-type-options` / `access-control-allow-origin`）/ body 字节。取证件在 `.tmp/g4/`（`goprobe/main.go` + 两个 vitest probe + `compare.mjs`），**未入提交**。

**为何用两份独立副本**：B1 是写面，两侧共用一份库时 `auth_nonces` 去重表会互相污染（Go 先跑登记 nonce ⇒ Node 同 nonce 被判重放）；同时规避 §9.3 发现 2 的「Go `store.Open` 必须先于 Node `openDb`」取数定序约束。两侧初始数据逐字节同源（同一 seed 复制）。

**结果：40/40 逐条 0 分歧。** 归一化 1 条：token `escrow-put-ok` 的 `updated_at` 两侧各为自身 `Date.now()`（比对前替换为 0）。覆盖：
- register 10 条：正常 / 幂等重复 / 已登记 / alg 非 ed25519 / pubkey 非 32 字节 / id 与 pubkey 不匹配 / 顶层 `null` / 字段类型错（`id` 收数字）/ 空对象 / **尾随垃圾**（Go 只解首值 ⇒ 两侧同 200）。
- escrow PUT 7 条：无签名头 / 正常 / body `id` 不符 403 / 用户名非法 / kdf 非法 / salt 非法 / 冲突 409。
- me 3 条：无签名头 / 身份 A（固定 progress + checkin）/ 身份 B（空数组）。
- profile 8 条：无签名头 / 正常 / `id` 出现 / `id:null` / 名称空 / 名称首尾空白（`TrimSpace` 对齐）/ 名称 33 字 / 控制字符。
- authmw 拒绝矩阵 11 条：alg 不支持 / id 非 32hex / ts 非十进制 / **ts 前导 `+`**（Go `strconv.ParseInt` 与 Node `parseGoInt64` 同接受 ⇒ 两侧 200）/ nonce 非 16 字节 hex / sig 非 hex / 身份未登记 403 / 时间窗越界 401 / nonce 重放 401 / 签名错 401 / 体超 64 KiB 413。

逐字节证据（两侧原文一致）：`{"code":"profile_id_forbidden","error":"请求体不得携带 id"}\n`、`{"error":"escrow_conflict"}\n`、`{"checkin_days":[…],"events":[],"id":"…","progress":[…]}\n`（三数组非 null + 键序字典序 + `done` 为 JSON bool）。

**执行期发现**（登记，不在本批修）：
1. **沙箱缺 TCP 环回**：Go 进程内 `net.Listen` + 自连被阻断（Node 自连正常），故 Go 取证件以 `net.Pipe` 承载真 `http.Server` + 真 `http.Client`——HTTP/1.1 线上字节仍真实，仅底层 conn 换管道；Node 侧为真监听。后续 Go 侧对拍若遇同问题照此处理。
2. **同一批内两种错误体形状并存**（已对拍确认两侧各自一致）：`authenticate` 与 `handleProfilePut` 走 `writeAuthErr`（`{"code":…,"error":…}`）；`handleEscrowPut` / register / 只读面走 `writeError`（`{"error":…}`，无 code）。§10.0 错误体表的适用范围仅认证中间件自身。
3. **register 的 `identity_pubkey_conflict` 分支在真实流量下不可达**（分析，非实跑）：handler 强制 `alg==ed25519`，conflict 条件是「同 id 不同 pubkey 或不同 alg」，而 id 由 pubkey 派生 ⇒ 需 sha256 前 128 bit 碰撞才可能触发。两侧等价性由「同输入同结果」覆盖，非分支级覆盖。
4. **`rawQueryOf` 回构限制**（沿用 §10.0）：本壳 `ServerRequest` 未暴露 `RawQuery` 原文，B1 四条路由均无 query 故恒为 `""`；**B4 带 query 的签名读路由必须复核**。

**待决点（登记）**：`decodeStrict` 未做 Go struct 键名 `EqualFold` 匹配（Go 精确优先、其次大小写不敏感）——B1 各路由结果不受影响，B2/B4 接 event/group body 时需复核。

### 10.8 执行实况（B2）

**状态：B2 已收口**（B3–B4 未开工）。

**内部切法**：B2 再切 B2a（`event` 骨架 + `comment.v1` / `dm.v1` / `progress.v1`）与 B2b（`govern.v1` body 校验 + 投影 + settle），**共用一个提交**（不制造中间破损态）。

**产出（11 文件 / +2784 −13）**：
- `routes/event.ts`（282 行）：`eventTypeRegistry` 5 条 fail-closed 白名单；骨架按 Go `handleEventPost`（`event.go:44-81`）顺序——decode → registry → `parseGoInt64(created_at)` + `isHexN(event_id,16)` + `createdAt>0` → 限速**双维度按 Go 的 `||` 短路序** → switch；`putBareEvent`（`event.go:84-98`，`len(body)==0 → "{}"`）；`case "comment.v1"` 走 `handleCommentEvent`（parse → `verifyEventSig` → `isRevokedEvent` → `hasBlob`/`putBlob` → canonicalize **减化四键** → `putEvent` → 回读 `received_at`）。
- `routes/progress.ts`（106 行）：`progressKeys` / `dayRe` / `parseProgressBody` / `handleProgressEvent`（`progress.go:74`）+ `putProgressProjection`（`checkin_days` 先写且恒 insert-or-ignore）。
- `routes/dm.ts` 扩 dm event（185 行，`dm.go:59`）。
- `routes/governEvent.ts`（235 行）：`GOVERN_PROPOSAL_KEYS`(13) / `GOVERN_VOTE_KEYS`(3) / `validProposalAction` / `anyString` / `parseGovernBody` / `governEventHandler`（`govern_event.go:158`：parse → verify → 投影（`directory_add` 时 `title=display_name` / `body=term_key`）→ `putEvent` → `governRoster` → `settleGovernProposal` → 回读 → 200 三键，键序照 Go map 字典序）。
- `store/governProjection.ts`（578 行）：`projectGovernProposal`（BEGIN + 提案人自投第 1 票）/ `projectGovernVote`（**照 Go 不开事务**）/ `governPreconditionTx` / `governApplyTx` / `editItemTx` / `editTagItemTx` / `replaceTagLinksTx` / `materializeTagSegments` / `segmentsContentHash` / `settleGovernProposal` / `freeRemoveEligible`，逐行同构 `store/govern_projection.go` + `store/govern.go`。
- `store/events.ts`（195 行）：`putEvent`（`ON CONFLICT DO UPDATE` **不含 `received_at`**）/ `getEventByID` / `isRevokedEvent` / `hasCommentEvent` / `putCommentEvent` 等。
- `routes/derived.ts`（644 行）新增：`normalizeTermKey` / `foldFullWidthASCII` / `cleanDisplayName` / `stripControlChars` / `collapseGoSpaces` / `isGoSpace`（`unicode.IsSpace` 口径）/ `hasControlChars` / `validDirectoryKind` / `directoryPayloadHash` / `directoryProposalItemId` / `directoryKindOfItemId` / `validProposalReason` / `validItemTitle` / `parseProposalId` / `jsonInt` / `onlyKeys` / `isHexN` / `parseGoInt64` / `parseGoInt` / `contributorRoster` 系 / `governRoster`。
- `routes/decode.ts`（279 行）扩：保留数字**原始字面量**（`json.Number` 口径）+ `NUM_FULL_RE` 放行**字符串形态** `created_at`。
- `serve.ts`：装配 `POST /v1/event`（`requireAuth` + ID / IP 两把**独立**桶，常量对齐 `event.go`）。
- 测试：新增 `event.test.ts`（22 用例）/ `governEvent.test.ts`（17 用例，真签真验）。

#### 10.8.1 门禁 G1–G6（逐条通过）

| 门 | 结果 | 证据 |
|---|---|---|
| G1 | 通过 | `go build ./...` / `go vet ./...` / `go test ./...` 全绿（本批不动 Go，作基线回归） |
| G2 | 通过 | `apps/node` `npx tsc --noEmit` **0 错误** |
| G3 | 通过 | `apps/node` `npx vitest run`：**25 文件 / 207 用例全绿**（B1 收口时 23/168 ⇒ B2 净增 **2 文件 / 39 用例**） |
| G4 | 通过 | **字节级对拍 0 分歧（61 token，见 §10.8.2）**——除 D 组 `group.v1` 既定缺口 1 条外，60 条 `status` / 4 对照头 / body 字节全等；阶段 4 DB 快照 13 张表逐字节相同 |
| G5 | 通过 | `git diff --stat -- internal/` **无输出**；`packages/protocol-ts/**`、`#72` 冻结的 `Adapters` / `ServerAdapters` 未动 |
| G6 | 通过 | 只 `add` 本批 11 个文件；`.gitignore` / `internal/httpapi/web.go` / `based-linux-amd64` / `.tmp/`（含 G4 取证件）均未入暂存 |

#### 10.8.2 G4 字节级对拍实况（B2）

**方法**（沿用 §10.7.2，差异处标注）：Node `openDb` + `migrate()` 建全量 schema → 插种子（`identities` 2 行 + `items`/`articles`（`article/x`，author = 身份 A）+ `course/c1`（author = 身份 A、无 `seq>=1` 课时，供免票选）+ store 密钥文件）→ **复制两份**（`go/` / `node/`）→ 两侧同一份 `tokens.json` **逐字节回放** → 比对 `status` + 4 对照头 + body 字节（**不比 `Content-Length`**）。取证件在 `e:\code\.tmp\g4\`（`tokens.json` / `goprobe/main.go` / `node-probe.test.ts` / `compare.mjs` / `REPORT.md`），**未入提交**。

**两侧隔离**：A / B / D 组**逐条新建服务器实例**（令牌桶重置，以真实覆盖拒绝矩阵）；C 组**同一实例连发 12 条**以触发限速。两侧初始数据逐字节同源。

**结果：61 token，除 D 组既定缺口外 0 分歧。** 归一化 1 类：body 内 `received_at`（两侧各为自身墙钟，24 条经归一化后相等）；DB 快照内 `events.received_at` / `govern_proposals.executed_at,voided_at` / `identities.last_seen_at` / `directory_terms.created_at,updated_at` / `checkin_days.created_at` 同口径置 `<ts>`。覆盖：
- A 组 14 条：**13 条直角** —— `comment.v1`（含回复 / 重复发送）/ `dm.v1` / `progress.v1` / `govern.v1`（proposal 首投 / 同 `proposal_id` 冲突 `conflict:true` / vote / 重复投票 / `directory_add` / remove 免票选）/ **`created_at` 为字符串形态** / **`event_id` 大写 hex**；**1 条顶层 `null` body**（Go 顶层 `null` 为 no-op ⇒ 两侧同 400 `event_param_invalid`）。
- B 拒绝矩阵 34 条：未知类型 / `created_at` float·带空格字符串·0·负数 / `event_id` 长度不足 / sig 非 hex / 身份未落库 403 / 签名错 / 各类型未知键·缺键·越界（`comment` target 非 ASCII·空·text 超限 / `dm` to 非法·cipher 空 / `progress` position 负数·float·done 非 bool·day 非法 / `govern` verb 非法·`content_version` 缺失·float·`choice` 17 字节·含非 ASCII / `directory_add` 缺键·带 `title`）/ **信封尾随垃圾**（Go 只解首值 ⇒ 两侧同 200）。
- C 限速 12 条：身份 B 连发，**两侧切点一致**（前 10 条 200、第 11/12 条 429）。
- D 已知缺口 1 条：`group.v1`（单列，**不计入分母**，见执行期发现 1）。

**阶段 4 DB 状态对拍**：`identities` / `events` / `blobs` / `items` / `articles` / `segments` / `progress` / `checkin_days` / `govern_proposals` / `govern_votes` / `directory_terms` / `comment_tombstone` / `meta` 共 13 张表，固定列序、主键升序、`|` 连接 ⇒ **剔 D 组缺口 1 行 artifact 后 55 行逐字节相同**（`dbSnapshot diffs=0`）；两侧 blob 文件均存在且非零大小。

**执行期发现**（登记）：
1. **`group.v1` 临时缺口（B2 唯一未闭合的判据 3 项，归 B4）**：Node `eventTypeRegistry` 已含 `group.v1`，但 `event.ts` 无分支 ⇒ 落 `putBareEvent`：非法 body 时 Go 走 `handleGroupEvent` → **400 `event_param_invalid`**，Node → **200** 且向 `events` 落 1 行（Go 因 400 未写）。**故 B4 收口前，判据 3 不得对 `group.v1` 宣称等价**；B4 须同时补「合法 `group.v1`」的正向对拍。
2. **IP 维度限速在取证件中同口径退化**：`ServerRequest` 无 `RemoteAddr` ⇒ Node 侧 `clientIP` 恒为单桶键；Go 侧取证件经进程内分发亦无 `RemoteAddr` ⇒ 两侧同退化，故 IP 桶等价性在**单桶口径**下自证（ID 维度仍逐身份独立，由 C 组覆盖切点）。
3. **`received_at` 回读是写面 body 的必然差异源**：两侧各自墙钟，唯有用「两侧各自回读自己写入的值」比较才等价（A 组 24 条即此口径）。
4. **删除死代码 `encodeTagLinks`**：`store/governProjection.ts` 曾导出该函数，但 Node 侧尚无治理写面 `POST /v1/proposal`，**无任何调用方**（Go 侧同函数属后续批次）⇒ 本批删除，避免冗余。
5. **`anyString` 数字分支的不可见发散**（`anyString` 取 `String(Math.trunc(v))`，Go 取 `strconv.FormatInt(int64(t),10)`）：仅在超出 int64 范围时两侧字符串不同，而下游 `parseProposalId` / `jsonInt` **同拒** ⇒ 无可见发散，不处置。
6. **`decode.ts` 的 `NUM_FULL_RE` 假设已由 G4 证伪风险**：`created_at` 含 `.` / `e` 时 Go `json.Number.Int64()` 与 Node `parseGoInt64` **都先拒**（400 `event_param_invalid`），故该正则只影响**字符串形态** `created_at`；B 组 `created-at-float` / `created-at-string-space` 与 A 组 `created-at-as-string` 三向实测两侧一致，**§10.7 登记的第 5 条待决点至此关闭**（`EqualFold` 匹配仍待 B4 复核）。

### 10.9 执行实况（B3）

**状态：B3 已收口**（B4 未开工）。

**产出（13 文件）**：
- `routes/submit.ts`（402 行）：`handleSubmitPost` 五形态（`article` / `quiz` / `tag` / `course` / `lesson`）+ **严格判定顺序**（decode → `author_id_forbidden` → 形态分流 → `content_hash` 服务端重算 → `author_sig` 校验）+ 双维度限速按 Go 的 `||` 短路序（`item_rate_limited`）。
- `routes/blob.ts` 扩 POST（`blob.go:17`）：`MultipartReader` 单块字段 `file`（只认 `file`）、8 MiB 上限；**QP 透明解码**逐行复刻 `mime/quotedprintable/reader.go:73-140`（含行窗 4096 与 4 处 RFC 偏离）；分片头解析复刻 `net/textproto/reader.go:523-608`（`maxHeaders=10000` + 空键名即 `ProtocolError`）。
- `routes/decode.ts` 扩：`listOf` / `JsonNode` / `parseJSONDocument` / `jsonObjectField`。
- `store/submission.ts`（262 行）：`UpsertSubmission` / `UpsertTagSubmission` / `UpsertSegmentSubmission` / `PutBlob` / `HasBlob` / `GetItem` 等写层。
- `store/groupseats.ts`（167 行）：`groupBodyAction`（**键名大小写不敏感**，对齐 `json.Unmarshal` 到 `struct{Action string}`）+ 席位派生。
- `store/governorset.ts`：`GovernorSet`（`member_ids_json` 逐元素解码，**`null` 元素为 no-op 落零值**，非 string 才整体报错）。
- `store/events.ts` 扩 `hasCommentEvent`；`store/governProjection.ts` 改导出；`serve.ts` 装配 `POST /v1/blob`（`requireAuthLimit(8 MiB + 4 KiB)`）与 `POST /v1/submit`（`requireAuth` + 双桶限速）。
- 测试：`submit.test.ts`（**46 用例**）、`blob.test.ts`（**24 用例**）+ 既有对拍用例。

#### 10.9.1 门禁 G1–G6（逐条通过）

| 门 | 结果 | 证据 |
|---|---|---|
| G1 | 通过 | `go build ./...` / `go vet ./...` / `go test ./...` 全绿（本批不动 Go，作基线回归） |
| G2 | 通过 | `apps/node` `npx tsc --noEmit` **0 错误** |
| G3 | 通过 | `apps/node` `npx vitest run`：**26 文件 / 268 用例全绿**（B2 收口时 25/207 ⇒ B3 净增 **1 文件 / 61 用例**） |
| G4 | 通过 | **字节级对拍 0 分歧（B3 新增 59 条，见 §10.9.2）**；阶段 4 DB 快照 81 行逐字节相同 |
| G5 | 通过 | `git diff --stat -- internal/` **无输出**；`packages/protocol-ts/**`、`#72` 冻结的 `Adapters` / `ServerAdapters` 未动 |
| G6 | 通过 | 只 `add` 本批 11 个代码文件 + 2 个文档文件；`.gitignore` / `internal/httpapi/web.go` / `based-linux-amd64` / `.tmp/`（含 G4 取证件）均未入暂存 |

#### 10.9.2 G4 字节级对拍实况（B3）

**方法**（沿用 §10.8.2）：Node `openDb` + `migrate()` 建全量 schema → 插种子（身份 + 被标条目 + 圈与圈事件 + store 密钥文件）→ **复制两份**（`go/` / `node/`）→ 两侧同一份 `tokens.json` **逐字节回放** → 比对 `status` + 4 对照头（`content-type` / `cache-control` / `x-content-type-options` / `access-control-allow-origin`）+ body 字节（**不比 `Content-Length`**）。取证件在 `e:\code\.tmp\g4\`，**未入提交**。

**结果：B3 新增 59 条，逐条 0 分歧。** 覆盖：
- A 五形态直角 5 条：`article` / `quiz` / `tag` / `course` / `lesson` 各 1 条（真私钥签 `author_sig`、服务端重算 `content_hash`）。
- B 拒绝矩阵 34 条：`author_id_forbidden` / 形态 `item_id` 非法 / segments 三区间铁律越界 / `tag_not_governor` / `tag_target_not_found` / `content_hash` 不符重算值 / `author_sig` 错 / 缺键 / 未知键 / 体超 64 KiB 等。
- C blob multipart 16 条：正常单块 / 缺 `file` 字段 / 多块 / 边界截断 / 超 8 MiB / **QP 透明解码**（`=48=65…` 解码后算 `blob_id`）/ CTE 值大小写 + 软换行 `abc=\r\ndef` → `abcdef` / QP 体非法（单个 `=`）/ 空头键名 / 头数超限 等。**其中 1 条（H109）为任务书预期写反**——Go 依 issue 15486 **接受** EOF 前 `=` 软换行（`abc=` → 200），实测两侧一致 200，非移植差异（见执行期发现 7）。
- G 限速 4 条：`submit` 同身份连发，**两侧切点一致**（`burst=3`）。

**阶段 4 DB 状态对拍**：固定列序、主键升序、`|` 连接 ⇒ **81 行逐字节相同**（含 `items` / `articles` / `segments` / `quizzes` / `tag_links` / `blobs` / `events` 等；`received_at` / `updated_at` 等墙钟列同口径置 `<ts>`）。

**执行期发现**（登记）：
1. **审查报告 9 条偏差的裁定**：实际需修 **1 / 2 / 3 / 4 / 7** 五条——① multipart **QP 透明解码缺失**（`multipart.go:148-167`：`NextPart()` 时 CTE 为 `quoted-printable` 则删头并把 `bp.r` 换成 `quotedprintable.NewReader`）；② `groupBodyAction` 取键**大小写敏感**（应为不敏感）；③ `member_ids_json` 含 **`null` 元素整圈丢弃**（应为该元素落零值 `""`）；④ 空分片头键名未报错（`canonicalMIMEHeaderKey("")` 返回 `("", false)` ⇒ ProtocolError）；⑦ `maxHeaders` 未复刻（`multipart.go:355-367` godebug 未设时默认 **10000**）。均已修复并补单测。
2. **偏差 9 为审查误判**：`packages/protocol-ts/src/ed25519.ts:25-34` 的 `verify` **已内建 `try { … } catch { return false; }`**，与 Go 的 `err != nil || !valid` 等价 ⇒ 无需修改。
3. **RFC 2231 续参未移植（残余缺口，登记）**：`mime/mediatype.go:142-235` 的 `ParseMediaType` 支持 `foo*` / `foo*0` 续参拼接与百分号解码；Node 侧未实现。真实客户端（浏览器 `FormData` / `curl -F` / `fetch FormData`）不会产出续参形态，且实现需引入 `percentHexUnescape` 与跨段拼接，与「拒绝冗余与过度设计」冲突 ⇒ **登记而非实现**。若后续发现对端可产出续参，须补齐后重跑 C 组。
4. **`maxMIMEHeaderSize = 10<<20` 分支在本路由不可达**：`multipart.go:348` 的 10 MiB 单头上限，因本路由 body 上限为 `8 MiB + 4 KiB < 10 MB` ⇒ 该分支永不触发，**不移植**；可达的是 `maxHeaders=10000`（已实现）。
5. **`protocol-ts/src/tag.ts` 用 JS `trim()` 而 Go `strings.TrimSpace` 不去 U+FEFF**：**既有镜像问题，非本批引入**，登记待后续统一（本批 `submit` 的 tag 形态判定未受影响，已由 A 组 `tag` 直角覆盖）。
6. **IP 维度限速在取证件中同口径退化**（沿用 §10.8 发现 2）：`ServerRequest` 无 `RemoteAddr` ⇒ Node 侧 `clientIP` 恒为单桶键；Go 侧取证件经进程内分发亦无 `RemoteAddr` ⇒ 两侧同退化，IP 桶等价性在**单桶口径**下自证（ID 维度由 G 组覆盖切点）。
7. **G4 任务书预期写反（H109）**：Go `quotedprintable` 依 issue 15486 **接受** EOF 前 `=` 软换行，故 `abc=` → 200（非任务书文字预期的 400）；实测两侧一致 200，**非移植差异**。单测用**单个 `=`** 仍正确判 400（该分支要求 `cur.length > 0`），并把真正的 `invalid bytes after =` 落点改为 `abc=\r`（两侧同 400）。
8. **`group.v1` 缺口仍归 B4**（沿用 §10.8 发现 1）：B4 收口前，判据 3 **不得**对 `group.v1` 宣称等价。
