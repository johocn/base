# base P3 余下批次计划（按 P5 六条判据切批）

- 日期：2026-10-02
- 上游：路线计划 `#70`（§1 P3 行、§5 节点职能清单、§6 P5 等价判据）；首批计划 `#73`（§8 不做「P3 余下批次」、§9.2 执行期发现）；接口边界冻结面 `#72`
- 状态：**批 A 已收口、批 B1–B4 已收口、批 C 已收口、批 D 已收口、批 E 已收口**（P3 余下批次全部收口；批 A 全量见 §9；批 B 切 B1–B4 见 §10，B1 实况见 §10.7、B2 实况见 §10.8、B3 实况见 §10.9、B4 实况见 §10.10；批 C 全量见 §11；批 D 全量见 §12；批 E 全量见 §13）
- 范围：**P3 余下批次**，共五批（§1）。本册详列**批 A**（§9 收口）、**批 B**（§10，切 B1–B4）、**批 C**（§11 收口）、**批 D**（§12 收口）与**批 E**（§13 收口）
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
| B | 认证读写面：身份写（`identity/register`、`escrow` PUT）/ `me` / `event` / `profile` / `submit` / `blob` POST / `group` 读权（`optionalAuth`）+ `authmw` 的 `X-Base-*` 五头 | 判据 3（签名域与错误码） | **B1–B4 已收口**（§10，实况 §10.7 / §10.8 / §10.9 / §10.10） |
| C | 治理派生面：`proposal` POST / `proposal/{id}/vote` / `proposal` GET | 判据 5（含 `#65` 小节点豁免） | **已收口**（§11） |
| D | 对端同步·反熵：`inventory` / `sync` / `fetch` / `scrub` / `event-sync` + CLI `peer-sync` / `scrub` | 判据 4（结果集一致 + 只增不减） | **已收口**（§12） |
| E | `importer` 容器 / 题库 / 视频派生 + CLI `import-video` | 判据 6（pack_id 与 merkle_root 同一） | **已收口**（§13） |

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

- **批 B**：`identity/register`（`identity.go:91`）、`identity/escrow` PUT（`:161`）、`me`、`event`（`event.go`，含 `eventTypeRegistry` fail-closed 白名单）、`profile`、`submit`（`submit.go` 393 行）、`blob` POST（`blob.go:17`）、`group` 读权（`group.go:681`）+ `authmw.go`（236 行，`X-Base-*` 五头）。验收 = 判据 3。**已切 4 子批 B1–B4，详列见 §10**（`govern.v1` 分支已定随 event 一起做，不留批 C；B1–B4 已收口）。
- **批 C**：`govern.go`（405 行）+ `govern_event.go`（222 行）+ `directory_proposal`；验收 = 判据 5。**已收口**（全量见 §11）——侦察后确认 `govern_event.go` 的 `govern.v1` 事件路径**已在 B2 收口**，故批 C 实做为 `govern.go` 的三条**签名**路由（`POST /v1/proposal` / `POST /v1/proposal/{proposal_id}/vote` / `GET /v1/proposal`）及其 store 依赖。**残余缺口**：Node 侧缺 Go `store.Open` 的 `seedDirectoryFromExisting` 开库引导（见 §11.4 发现 1）。
- **开库引导等价（新增边界，待认领）**：Go `internal/store/store.go:155-168` 的 `Open` = `schemaStatements` → `migrate` → `seedDirectoryFromExisting`（`internal/store/directory.go:294-442`：把存量 `items WHERE item_id LIKE 'tag/%'`、`source='category'`、`segments seq<0` 的 `attr.category` / `attr.instructor` 登记为 `directory_terms` 的 `approved` 词条，仅当确有存量词条时 `bumpDirectoryVersion` 一次并写 `meta.directory_seeded=1`；失败只打 stderr 不阻断 Open）。Node 侧现状：`openStore`（`apps/node/src/store/store.ts:244-267`）只跑 `migrate`、**不含 seed**；`main.ts:48` 的 `serve` 用裸 `openDb`（连 `migrate` 都无）。**验收 = 开库后 DB 快照与 Go 逐字节一致**（即批 C G4 阶段 4 的 4 行对称差归零，见 §11.3）。
- **批 D**：`peer.go`（334 行）+ `internal/peersync`（2,784 行）+ CLI `peer-sync` / `scrub`；验收 = 判据 4（**只增不减**须保持）。**已收口**（全量见 §12）——5 条对端路由全部落在 `routes/peer.ts`；出站侧拆为 `store/syncstore.ts`（`SyncStore` 端口）+ `store/packimport.ts` + `peersync/*`；对端监听由 `serve.ts` 的 `startPeerServer` 承载（公开路由 ∪ 内部路由，对齐 Go `PeerHandler()`）。**残余缺口**：Node 缺 Go `store.Open` 的 `seedDirectoryFromExisting` 开库引导（§12.3 的 3 行对称差，同下条边界项）。
- **批 E**：`internal/importer`（1,819 行）容器 / 题库 / 视频派生 + CLI `import-video`；验收 = 判据 6。**已收口**（全量见 §13）——Node 落点：core-ts 纯派生 `importer/{gojson,quiz,container,video}.ts` + 宿主编排 `apps/node/src/importer/{container,run}.ts` + CLI `import-video`。**判据 6 的非平凡证据由 G4-4（真实视频块）提供**（见 §13.2）。

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

**状态：B1–B4 已收口（实况见 §10.7 / §10.8 / §10.9 / §10.10）。**

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

**状态：B1 已收口**（B2 见 §10.8、B3 见 §10.9、B4 见 §10.10）。

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

**待决点（登记）**：`decodeStrict` 未做 Go struct 键名 `EqualFold` 匹配（Go 精确优先、其次大小写不敏感）——B1 各路由结果不受影响，B2/B4 接 event/group body 时需复核。**B4 复核结果：已关闭**——`decode.ts:283-294` 的 `matchField` 实现「精确优先 + 唯一大小写不敏感（折叠命中多个即歧义不匹配）」，B4 读面 `parseEventBody` / `groupName` 均经 `jsonObjectField`（`:350-357`）走同一规则，与 Go 解到 `struct{Action;Epoch;PayloadCID;ReplyTo}` / `struct{Name}` 同语义（见 §10.10 发现 8）。

### 10.8 执行实况（B2）

**状态：B2 已收口**（B3 见 §10.9、B4 见 §10.10）。

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
6. **`decode.ts` 的 `NUM_FULL_RE` 假设已由 G4 证伪风险**：`created_at` 含 `.` / `e` 时 Go `json.Number.Int64()` 与 Node `parseGoInt64` **都先拒**（400 `event_param_invalid`），故该正则只影响**字符串形态** `created_at`；B 组 `created-at-float` / `created-at-string-space` 与 A 组 `created-at-as-string` 三向实测两侧一致，**§10.7 登记的第 5 条待决点至此关闭**（`EqualFold` 匹配已由 B4 复核对齐，见 §10.10 发现 8）。

### 10.9 执行实况（B3）

**状态：B3 已收口**（B4 见 §10.10）。

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

### 10.10 执行实况（B4）

**状态：B4 已收口** ⇒ **批 B 全四子批 B1–B4 至此收口**（批 C–E 未开工）。

**产出（7 文件）**：
- `routes/groupEvent.ts`（718 行）：`group.v1` 写面——`parseGroupBody`（v2/v1 按 `sigs` **键存在性**分流，`null` 也算存在）/ `parseGroupMsg`（缺 `reply_to` 不补键）/ `parseGroupRoster`（`encrypted` 缺省 1）/ `parseGroupRosterV2`（`sigs` 条目**恰 2 键**、`from_epoch` **只判键存在不判类型**、`envelopes` 走 `Canonicalize({"envelopes":arr})`）+ `handleGroupEvent`（parse → `verifyEventSig` → 三 action 分流，**不做墓碑检查**）+ `putGroupMessage` / `putGroupRoster` / `handleGroupRosterV2` / `rosterApprovalPayload` / `verifyRosterApprovals`（按 id 去重保留首条）/ `rosterQuorumError`。
- `store/group.ts`（193 行）：`putGroupRoster` / `putGroupRosterV2`（乐观锁 `WHERE` 携带读到的旧 `epoch`/`roster_rev`；错误 kind `owner_mismatch` / `epoch_stale` / `roster_rev_stale` / `form_locked`）/ `getGroup` / `listGroupEvents`（`created_at DESC, event_id DESC` 分页）/ `listGroupMsgEvents`（`ASC` 全量，供席位派生）。
- `routes/group.ts`（213 行）：`GET /v1/group/{group_id}` 读面——非 hex16 → 400 `event_param_invalid`、无行 → 404 `group_not_found`、封闭圈非成员 → 404 `group_read_denied`（`memberOf` 对空 actor 恒 false，**不泄露存在性**）、`limit` 走 `parseGoInt` 且 `1..100` 否则回落 30、复用 `parseCommentCursor`、`deriveSeats` 派生席位、`envelopes` 三态（无键 / `null` ⇒ 输出 `null`）、事件循环只留 `action="msg"`、**满页才给** `next_cursor`。
- `routes/event.ts`（289 行）扩：加 `case "group.v1": return groupEventHandler(...)` ⇒ **闭合 §10.8 发现 1 / §10.9 发现 8 登记的缺口**。
- `serve.ts`（156 行）扩：装配 `GET /v1/group/{group_id}` = `optionalAuth({db}, groupGetHandler({db}))`（对齐 `server.go:133`）。
- 测试：`groupEvent.test.ts`（**16 用例**）、`group.test.ts`（**12 用例**）。

#### 10.10.1 门禁 G1–G6（逐条通过）

| 门 | 结果 | 证据 |
|---|---|---|
| G1 | 通过 | `go build ./...` / `go vet ./...` / `go test ./...` 全绿（本批不动 Go，作基线回归） |
| G2 | 通过 | `apps/node` `npx tsc --noEmit` **0 错误** |
| G3 | 通过 | `apps/node` `npx vitest run`：**28 文件 / 296 用例全绿**（B3 收口时 26 文件 / 268 用例 ⇒ B4 净增 **2 文件 / 28 用例**） |
| G4 | 通过 | **字节级对拍 0 分歧**（令牌 **179** 条，含 B4 新增 **60** 条，见 §10.10.2）；阶段 4 DB 快照 **111 行逐字节相同**（含新增 `groups` 表 6 行） |
| G5 | 通过 | `git diff --stat -- internal/` **无输出**（`git status` 对 `internal/httpapi/web.go` 的 ` M` 为陈旧 stat 项，`git diff` 为空）；`packages/protocol-ts/**` 与 `#72` 冻结的 `ServerRequest` / `Adapters` / `ServerAdapters` 未动 |
| G6 | 通过 | 只 `add` 本批 7 个代码文件 + 2 个文档文件；`.gitignore` / `internal/httpapi/web.go` / `based-linux-amd64` / `.tmp/`（含 G4 取证件）均未入暂存 |

#### 10.10.2 G4 字节级对拍实况（B4）

**方法**（沿用 §10.9.2）：Node `openDb` + `migrate()` 建全量 schema → 插种子（含身份 + 被标条目 + store 密钥文件）→ **复制两份**（`go/` / `node/`）→ Go `store.Open` **先于** Node `openDb`（§9.3 发现 2 的取数顺序硬约束）→ 两侧同一份 `tokens.json` 逐字节回放 → 比对 `status` + 4 对照头（`content-type` / `cache-control` / `x-content-type-options` / `access-control-allow-origin`）+ body 字节（**不比 `Content-Length`**）。取证件在 `e:\code\.tmp\g4\`，**未入提交**。

**本批工装改造三处**：① 新增**保真 GET + query** 通道（成员签名读令牌的签名覆盖规范形态 query；GET body 0 字节按其 sha256 口径）；② 阶段 4 快照两侧各加 **`groups` 表**（`group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at`，`updated_at` 归一化 `<ts>`）；③ **移除 D 组「group.v1 已知分歧」特殊处理**（`KNOWN_DIVERGENT_GROUP` / `dropKnownArtifact`）——旧反向项改由 I 组反向矩阵以「两侧同 400」等价覆盖。

**结果：令牌 179 条（A14 / B34 / C12 / E5 / F34 / G4 / H16 + B4 新增 I 组 60 条），逐条 0 分歧。** I 组覆盖：
- **写面正向 27 条**：roster v1 建封闭 / 建开放 / 更新（`encrypted` 键缺省验缺省语义）、msg（带 / 不带 `reply_to`）、roster v2 `join` / `rename` / `remove` / `rotate` / `leave` / `dissolve`、`envelopes` 三态（数组 / **无键** / 空数组）、`from_epoch:null` **应通过**、`sigs` 重复 id **按 id 去重保留首条**。
- **写面反向 20 条**：非法 body（未知键 / `action` 非枚举 / 数组 / 标量 / 缺失）→ 400 `event_param_invalid`、`sigs:null`（键存在 ⇒ 走 v2 路径）→ 400、未登记签名者 → 403 `identity_unregistered`、签名不匹配 → 403 `event_sig_invalid`、quorum 不足 → 403 `group_roster_quorum_missing`、dissolve 发起段不足 → 403 `group_proposal_proposer_missing`、`encrypted` 切换 → 400 `event_param_invalid`（form_locked）、v1/v2 epoch 不递增与 rev 不递增 → 409、`group_id` / `epoch<1` / `text_cipher` 空或超 8192 / `reply_to` 非 hex16 / `member_ids` 空数组但 sub≠dissolve / `name` 超 64 / `sigs` 条目键数≠2 / `envelopes` 超 32 条 → 400。
- **读面 13 条**：开放圈 + **匿名（零 auth 头）200** / 封闭圈 + 匿名 **404 `group_read_denied`** / 封闭圈 + 成员签名 **200** / 封闭圈 + 已登记非成员 **404** / 不存在 hex16 **404 `group_not_found`** / 非 hex16 **400** / **半 auth 头 400 `auth_missing_header`** / `limit=1` / `=100` / `=0`（回落 30）/ `=abc`（回落 30）/ 真实 `cursor` / `events` 只留 `action=msg`。
- **`group.v1` 缺口闭合自证**：旧 D 组单条（非法 body）由 I 组反向等价覆盖，两侧**同 400** 且 DB 侧无 artifact 行 ⇒ §10.8 发现 1 / §10.9 发现 8 **至此关闭**。

**阶段 4 DB 状态对拍**：固定列序、主键升序、`|` 连接 ⇒ **111 行逐字节相同**（含 `groups` 表 6 行）。

**执行期发现（登记）**：
1. **`group.v1` 缺口闭合**：原 §10.8 发现 1 / §10.9 发现 8 关闭；B4 起判据 3 可对 `group.v1` 与 `GET /v1/group/{group_id}` 宣称等价——**限规范 query 形态**（见第 3 条）。
2. **`created_at` > 2^53 精度发散（残余缺口，登记）**：Go `eventReq.CreatedAt` 为 `json.Number` 保客户端字面量（`event.go:36-37`），Node `parseGoInt64` 内部虽用 `BigInt` 校验范围但 `return Number(v)` 会舍入（`derived.ts:53-63`）⇒ 客户端发 `created_at:9007199254740993` 时两侧**重建的待验字节不同**（Node 落 403 `event_sig_invalid`）且落库值不同。系 **B1/B2 既有管线缺陷**（非 B4 引入），修复需改仍属冻结面的 `packages/protocol-ts` `canonicalize`（§10.0 明定本批不改）⇒ **登记不改**。真实客户端毫秒时间戳 ≪ 2^53，**实际不可达**。
3. **签名 query 非逐字节等价（残余缺口，登记；§10.7 待决点 4 的复核结论）**：Go 以 `r.URL.RawQuery` **原文**参与签名（`authmw.go:218`），Node 侧 `host/http.ts:165-183` 用 `URLSearchParams` 建 query map（**取首值**）后由 `authmw.ts:137-143` 的 `rawQueryOf` 用 `encodeURIComponent` **回构**。**参数选取语义与 Go `Get` 一致，仅签名串在非规范形态下分歧**：`?limit=10&limit=20`（重复键）、小写 `%hex`、值含 `+` 时 Node 落 401 `auth_bad_signature` 而 Go 200。修复须让 host 层透传原始 RawQuery，而 `ServerRequest` 属 `#72` 二次冻结面（`platform/server.ts:7-14`，**无 RawQuery 字段**）⇒ **登记不改**；故**判据 3 对 `GET /v1/group/{group_id}` 只在规范 query 形态下成立**（G4 I 组读面令牌全部用规范形态，已验证）。
4. **重复键 / `null` 覆盖语义（残余缺口，登记）**：Go `json.Unmarshal` 进 struct 时重复键逐个解码、**任一次取值类型不符即整体报错**，`null` 对字段是 no-op 保留前值；Node `jsonObjectField`（`decode.ts:350-357`）只取末次匹配且不校验前值。差异仅在 `{"action":5,"action":"msg"}` / `{"action":"msg","action":null}` 一类形状可达，**正常客户端经 `Canonicalize` 写入故不可达**。
5. **`member_ids_json` 为 `"null"` / `[null]` 的退化口径（残余缺口，登记）**：Go 解 `null` 进 `[]string` 置 nil ⇒ 读面输出 `null`、`[null]` ⇒ `[""]`；Node 读面统一退化 `[]`。**正常写入不可达**（写入侧经 `Canonicalize` 的元素恒为 hex 串）。
6. **envelopes 非规范存量行（残余缺口，登记）**：Go 读面用 `json.RawMessage` 原样嵌入（compact 后保留数字字面量 / 键序 / 转义），Node 用 `canonicalize` 复现（会排序键、拒非整数）。仓里 `key_envelopes` 恒为 `Canonicalize` 产物故两侧字节相同；仅手工改库 / 反熵同步非规范行可达。
7. **任务书预期校正（非移植差异）**：① 读面「半 auth 头」实测两侧**同为 400 `auth_missing_header`**（非任务书假定的 401）；② `group_id` 口径为 **32 hex**——`isHexN(s,16)` 的 16 指**字节数**（对齐 `group_test.go:17`），非任务书示例的 16 hex。两条均**两侧一致**，非差异。
8. **§10.7 待决点「`EqualFold` 匹配」关闭（本批复核，非缺口）**：Go 读面解 `struct{Action;Epoch;PayloadCID;ReplyTo}` 与 `struct{Name string}` 用 struct 字段匹配（精确优先、其次**唯一**大小写不敏感，折叠命中多个即歧义不忽略）；Node 侧 `decode.ts:283-294` 的 `matchField` 逐条复刻该规则，`jsonObjectField`（`:350-357`）与 B4 读面 `parseEventBody` / `groupName` 皆经此路径 ⇒ **两侧等价**。写面 `parseGroupBody` 走 `map[string]any` **精确键**查表（键集白名单同时把大小写变体判为未知键 → 400），与 Go 同。故 §10.7 该待决点**关闭**。

## 11. 批 C：治理派生面（判据 5）

**状态：批 C 已收口**（批 D–E 未开工）。

**范围厘清**：§8 登记的批 C = `govern.go`（405 行）+ `govern_event.go`（222 行）+ `directory_proposal`。开工侦察确认 `govern_event.go` 的 `govern.v1` 事件路径**已在批 B2 收口**（§10.8，`routes/governEvent.ts` + `store/governProjection.ts`）⇒ 本批实做为 `govern.go` 的三条**签名**路由 + 其 store 依赖：

| # | 路由 | Go 落点 | Node 落点 |
|---|---|---|---|
| 1 | `POST /v1/proposal` | `govern.go:124-278` | `routes/proposal.ts` `proposalPostHandler` |
| 2 | `POST /v1/proposal/{proposal_id}/vote` | `govern.go:288-345` | `routes/proposal.ts` `proposalVoteHandler` |
| 3 | `GET /v1/proposal` | `govern.go:373-405` | `routes/proposal.ts` `proposalListHandler` |

**切法（3 个 Task，逐 Task 两阶段审查）**：C1（`store/govern.ts` 签名写层 + 单测）→ C2（三 handler + `derived.ts` 扩展 + `decode.ts` 指针语义 + `serve.ts` 装配 + 单测）→ C3（G4 扩容 + 门禁 G1–G6 + 回填 + 提交）。

**产出（10 代码文件 / +2235 −29 + 2 文档）**：

- `store/govern.ts`（**新增 469 行**）：逐行对齐 `internal/store/govern.go` 的 `CreateProposal` / `CreateDirectoryProposal` / `AddVote` / `addVoteTx` / `EncodeTagLinks` + `directory.go` 的 `GetDirectoryTerm` / `FindPendingDirectoryProposal` / `DirectoryPendingVotes` + `store.go` 的 `GetItem`；导出 `AlreadyVotedError` / `createProposal` / `createDirectoryProposal` / `addVote` / `getDirectoryTerm` / `findPendingDirectoryProposal` / `directoryPendingVotes` / `encodeTagLinks` / `getItemRow`。
- `store/govern.test.ts`（**新增 600 行 / 27 用例**）。
- `routes/proposal.ts`（**新增 388 行**）：三 handler + `proposalReq` / `proposalEditReq` / `proposalDirectoryReq` 解码形状 + `proposalDTO` 声明序。
- `routes/proposal.test.ts`（**新增 663 行 / 33 用例**）。
- `routes/decode.ts`（+39 −1）：新增 `opt()`（Symbol 标记 `OPT_SPEC`）实现 Go 指针三态（键缺失 / `null` → `null`；有值递归解码；类型不符 → ERR），additive 不破坏既有 spec。
- `routes/derived.ts`（+26 −3）：`PROPOSAL_COLUMNS` / `ProposalView` 补 `content_version`；新增 `PROPOSAL_PER_MINUTE_PER_ID` / `PROPOSAL_BURST_PER_ID` / `VOTE_PER_MINUTE_PER_ID` / `VOTE_BURST_PER_ID`；导出 `DIRECTORY_STATE_APPROVED` / `DIRECTORY_SMALL_NODE_ROSTER_MAX` / `validProposalAction`。
- `routes/governEvent.ts`（+1 −14）：删私有 `validProposalAction` 与独占常量，改由 `derived.ts` 统一（消重，不造第二份口径）。
- `routes/submit.ts`（+2 −2）：`normalizeSubmitTagLinks` / `SubmitLink` 加 `export`，逻辑未动。
- `store/governProjection.ts`（+14 −8）：9 个私有函数纯加 `export`（复用事件路径唯一实现，不改 SQL / 语义）。
- `serve.ts`（+33 −1）：装配三路由——两条 POST 走 `requireAuth` + 双维度限速（proposal / vote 各一把 ID 桶 + 复用治理面 IP 桶），GET 匿名（对齐 `server.go:124-126`）。

### 11.1 门禁 G1–G6（逐条通过）

| 门 | 结果 | 证据 |
|---|---|---|
| G1 | 通过 | `go build ./...` / `go vet ./...` / `go test ./...` 全绿（本批不动 Go，作基线回归） |
| G2 | 通过 | `apps/node` `npx tsc --noEmit` **exit 0** |
| G3 | 通过 | `apps/node` `npx vitest run`：**30 文件 / 356 用例全绿**（B4 收口时 28/296 ⇒ 批 C 净增 **2 文件 / 60 用例**） |
| G4 | 通过（HTTP 面） | **字节级对拍 HTTP 逐条 0 分歧**（批 C 新增 J 组 **63 token**，见 §11.2）；阶段 4 DB 快照**对称差 4 行**（根因属开库引导，见 §11.3 / §11.4 发现 1） |
| G5 | 通过 | `git diff --stat -- internal/` **无输出**（`git status` 对 `internal/httpapi/web.go` 的 ` M` 为陈旧 stat 项，定向 `git diff` 为空）；`packages/protocol-ts/**` 与 `#72` 冻结的 `ServerRequest` / `Adapters` / `ServerAdapters` 未动 |
| G6 | 通过 | 只 `add` 本批 10 个代码文件 + 2 个文档文件；`.gitignore` / `internal/httpapi/web.go` / `based-linux-amd64` / `.tmp/`（含 G4 取证件）均未入暂存 |

### 11.2 G4 字节级对拍实况（批 C）

**方法**（沿用 §10.10.2）：Node `openDb` + `migrate()` 建全量 schema → 插种子（10 名治理者 G0..G9 + 非治理者 X + 被标条目 + store 密钥文件）→ **复制两份**（`go/` / `node/`）→ Go `store.Open` **先于** Node `openDb` → 两侧同一份 `jtokens.json` 逐字节回放 → 比对 `status` + 4 对照头（`content-type` / `cache-control` / `x-content-type-options` / `access-control-allow-origin`）+ body 字节（**不比 `Content-Length`**）。取证件在 `e:\code\.tmp\g4\`（`jcprobe.probe.ts` / `jgoprobe/main.go` / `jcompare.mjs` / `jtokens.json` / `REPORT.md` / `baseline.txt` / `gates.txt`），**未入提交**。

**工装扩容**：新增 J 组对拍通道（三路由签名令牌，全部 `mode=isolated`——每条全新 server 实例隔离限速桶）；既有 40 token 基线**先复跑自证**（`DIVERGENCES: 0 / 40`）。

**结果：J 组 63 token，HTTP 逐条 0 分歧。** status 序列完全相同、4 对照头全一致；body 仅 `J46/J47/J63`（匿名 `GET /v1/proposal` 列表）需按 `created_at` / `executed_at` / `voided_at`（两侧各为自身墙钟）归一化后相等。覆盖：

- **拒绝矩阵**（J01–J25、J48–J53、J56/J57/J61）：无签名头 400 / 半头 400 / `proposer_id`·`author_id` 出现 400 `author_id_forbidden` / `voter_id` 出现 400 / action 非枚举 400 `proposal_action_unsupported` / reason 非法（`%201` / 控制字符）400 `proposal_reason_invalid` / edit 缺失·`null`·类型错 400 `proposal_edit_invalid` / item 不存在 404 `item_not_found` / 提案对象归提案人自己 403 `item_self_owned` / state 不符 400 `item_state_mismatch` / `body_md` 缺失·`null`·类型错 400 / title 空·含 DEL 400 / 字节和超限 413 `proposal_too_large` / 非治理者提案 403 `proposer_not_governor` / 目录 kind 非法·`term_key` 与归一化不符·带 `edit`·缺 `directory` 400 `proposal_directory_invalid` / tag 形态带 `body_md` 400 / `course` 形态 edit 400 / `proposal_id` 非法（`0` / `abc` / 不存在）404 `proposal_not_found` / 非治理者投票 403 `voter_not_governor` / 投票体 `null`·数组 400 `bad_json` / 重复投票 409 `already_voted`。
- **正向执行链路**（J26–J45、J54/J55、J58–J60、J62）：remove 提案 201 `pending`（`threshold=3`、`vote_count=1`）→ 第 2/3 票 200（跨门槛 `effective`）→ 同 item 再提案 400 `item_state_mismatch`；revive 反向；edit（`article` / `tag`）各形态；`directory_add` 三支——同键归并 200 `merged:true`、小节点豁免（名册 3 < 10）即时 `effective`、已 approved 短路 200；免票选 remove（`course`，无 `seq>=1` 课时）`threshold=0` 即时 `effective`。
- **读面**（J46/J47/J63）：匿名 `GET /v1/proposal` 全量 `proposals[]`，**16 键声明序逐字节**（`proposal_id, action, item_id, proposer_id, reason, title, body_md, status, votes, vote_count, threshold, created_at, executed_at, voided_at, content_version, revoked_rev`）。

### 11.3 阶段 4 DB 状态对拍（批 C）

固定列序、主键升序、`|` 连接 ⇒ **集合对称差 4 行**（go 侧 141 行 / node 侧 139 行；按行集合比对，行序不计）。

**仅 go 侧有 3 行**：`directory_terms|tag|x|x|approved||<ts>|<ts>`、`meta|directory_seeded|1`、`meta|directory_version|4`。
**仅 node 侧有 1 行**：`meta|directory_version|3`。

**根因**：Go `store.Open`（`internal/store/store.go:164-168`）在 `migrate` 后调 `seedDirectoryFromExisting`（`internal/store/directory.go:303`），把存量 `tag/x` 登记为 `approved` 词条并 `bumpDirectoryVersion` 一次、写 `meta.directory_seeded=1`；Node 侧无等价实现 ⇒ 缺 1 行词条、`directory_version` 少 bump 一次、无 `directory_seeded` 键，其余行为这 3 行挤出的**行序整体错位**（内容一致）。属**开库引导层**，不属批 C 三路由范围（§8 已新增「开库引导等价」边界项待认领）。

### 11.4 执行期发现（登记）

1. **Node 缺 Go `store.Open` 的目录 seed 引导（残余缺口，登记；用户 2026-10-02 裁定「登记而非实现」）**：覆盖 §11.3 的 4 行对称差。双层——① 全仓无 `seedDirectoryFromExisting` / `directory_seeded` 等价实现；② `openStore` 不含 seed、`main.ts:48` 的 `serve` 走裸 `openDb`（连 `migrate` 都无）。**处置**：§8 新增边界项「开库引导等价」待后续批次认领，**验收 = 开库后 DB 快照与 Go 逐字节一致**；本批不动 `openStore` / `main.ts` 这条批 A/B 已收口基线共用的路径。
2. **`govern_event.go` 已在 B2 收口（范围厘清，非缺口）**：§8 原登记含 `govern_event.go`，但该文件的事件路径（`govern.v1` body 校验 + 投影 + settle）**已随批 B2 交付**（§10.8，`routes/governEvent.ts` 235 行 + `store/governProjection.ts`）；批 C 只做签名路径。两路径的差异在本批显式保留：`addVoteTx` 用**实时** `filterRoster` + `GovernThresholdForRoster(action, len(roster), true)`；`SettleGovernProposal` 用**快照水位** + 真实 `rosterReady` 且带 `#65` 小节点豁免 ⇒ **签名路径与事件路径各自的票数 / 门槛语义不可互换**。
3. **`EncodeTagLinks` 从事件路径复用（消重，非缺口）**：B2 曾删死代码 `encodeTagLinks`（§10.8 发现 4），本批签名路径需要它 ⇒ 经 `store/governProjection.ts` 加 `export` 复用**唯一实现**，不新造第二份口径；其 `goJSONString` 对齐 `json.Marshal`（`encodeTagLinks` 产 struct 序 `TagID,TargetID,Kind`，**非字典序**）。
4. **`routes/json.ts` 的 `encodeString` 既有偏离（残余缺口，登记；非本批引入）**：`0x08` / `0x0c` 输出 `\u0008` / `\u000c`（Go `json.Marshal` 用 `\b` / `\f`）、`0x7f`(DEL) 被转义为 `\u007f`（Go 不转义）。本批 `proposal` 路径不受影响（`encodeTagLinks` 走独立 `goJSONString`；`writeAuthErr` / `jsonResponse` 的文案键值均不含该码域）⇒ **登记不改**。
5. **IP 维度限速同口径退化**（沿用 §10.8 发现 2 / §10.9 发现 6）：`ServerRequest` 无 `RemoteAddr` ⇒ Node 侧 `CLIENT_BUCKET_KEY=""` 单桶键（与 `submit.ts:60` 同口径）；Go 取证件经进程内分发亦无 `RemoteAddr` ⇒ 两侧同退化，IP 桶等价性在**单桶口径**下自证（ID 维度仍逐身份独立）。
6. **`authmw` 读体后还体（非缺口，已核实等价）**：Go `authenticate`（`authmw.go:205-210` 读体、`:233` `r.Body = io.NopCloser(bytes.NewReader(body))`）把体还给 handler，故 vote handler 能再读体；Node 侧 `req.body` 是冻结的 `Uint8Array`、`requireAuth` 不消耗 ⇒ 天然等价，**无需移植还体动作**。
7. **`opt()` 指针三态为 additive 扩展（非缺口）**：`decode.ts` 原无「键缺失 / `null` / 有值」三态语义 ⇒ 新增 Symbol 标记 `OPT_SPEC` + `opt()`，`defaultOf` 与 `decodeField` 顶部各加一分支；既有 spec 行为不变（G3 356 用例全绿自证）。
8. **5 条故意差异（复核结论，非缺口）**：C2 报告列出并逐条复核——① `auth_body_read_failed` 分支不可达（Node 体已在内存）；② `EncodeTagLinks` 的 error 分支不可达（无 IO 写）；③ store 包装文案（`store: 读提案 N: no rows` 等）逐字对齐 Go 的错误路径包装；④ IP 桶退化单键（见发现 5）；⑤ `Date.now()` 墙钟（对拍归一化口径处理）。
9. **`handleVotePost` 体空判走 `trimGoSpace`（口径定死，非缺口）**：Go `strings.TrimSpace` 与 JS `.trim()` 的空白集不同（Go `unicode.IsSpace` 含 U+0085 不含 U+FEFF；JS 反之）⇒ 空体判定必须用 `trimGoSpace`；本批 `proposalVoteHandler` 照此，非空体再走 `parseJSONDocument`（全值语义，拒尾随）判定 `bad_json`。

## 12. 批 D：对端同步·反熵（判据 4）

**状态：批 D 已收口**（批 E 未开工）。

**范围**：§8 登记的批 D = `internal/httpapi/peer.go`（334 行，5 条对端路由）+ `internal/peersync`（`peer.go` 122 / `remote.go` 339 / `packimport.go` 359 / `eventsync.go` 436 / `sync.go` 235 / `scrub.go` 165）+ CLI `peer-sync` / `scrub`。Node 落点：

| # | 路由 | Go 落点 | Node 落点 |
|---|---|---|---|
| 1 | `GET /v1/inventory` | `peer.go:34-85` | `routes/peer.ts` `inventoryHandler` |
| 2 | `POST /v1/sync` | `peer.go:87-111` | `routes/peer.ts` `syncHandler` |
| 3 | `POST /v1/fetch` | `peer.go:114-240` | `routes/peer.ts` `fetchHandler` |
| 4 | `POST /v1/event-sync` | `peer.go:243-312` | `routes/peer.ts` `eventSyncHandler` |
| 5 | `POST /v1/scrub` | `peer.go:316-334` | `routes/peer.ts` `scrubHandler` |

**切法（5 个 Task，逐 Task 两阶段审查）**：D1（读面 store 层：`store/peersync.ts` 块 / 副本 / 事件游标 / `verifyBlobs`）→ D2（入站五路由 `routes/peer.ts` + 对端监听装配 + `requireNodeKey`）→ D3（出站：`peersync/{peer,remote,packimport}.ts` + `store/{packimport,syncstore}.ts`）→ D4（`peersync/{eventsync,sync,scrub}.ts` 的 `syncEvents` / `RunOnce` / `RunForever` / `ScrubOnce` / `ScrubForever`）→ D5（CLI `{peerconfig,peer-sync,scrub}.ts` + `serve.ts` 对端监听 + `main.ts` 对端/调度装配）。

**产出（13 个新代码文件 + 14 个新测试文件 + 3 处改动 + 2 文档）**：

- `store/peersync.ts`（**新增 407 行**）+ `store/peersync.test.ts`（402 行）：逐行对齐 `internal/store` 的块 / 副本 / 事件游标 / 校验读面（`listAllBlobIDs` / `upsertBlobReplica` / `countBlobsWithoutReplica` / `replicaPeers` / `hasBlob` / `deleteBlob` / `verifyBlobs` / `listRevokedPayloads` / `eventsAfter` 等）。
- `store/packimport.ts`（**新增 379 行**）+ 测试（264 行）：对齐 `internal/store/packimport.go`（229 行）的 `importPack`（**落库唯一实现**）。
- `store/syncstore.ts`（**新增 314 行**）+ 测试（149 行）：`SyncStore` 端口 = Go `store.Store` 在出站侧所需子集（`contentVersion` / `mediaChunkIndex` / `eventBlobIndex` / `putBlob` / `isRevokedPayload` …）；`openSyncStore(data, {storeKeyHex})` 对齐 `store.Open` + `WithStoreKey`。
- `peersync/peer.ts`（228 行）+ 测试（95 行）：`Config` / `Peer` / `REQUEST_TIMEOUT_MS` / `parseIssuerPubKeys`（对齐 `peersync/peer.go` 122 行）。
- `peersync/remote.ts`（372 行）+ 测试（228 行）：`postSync` / `fetchInventory` / `fetchBlobs` / `fetchCatalog` / `fetchManifest` / `fetchPackTo`（对齐 `remote.go` 339 行；出站 HTTP + 双向 TLS + 指纹固定 + 块帧读写）。
- `peersync/packimport.ts`（**新增 402 行**）+ 测试（451 行）：对齐 `internal/peersync/packimport.go`（359 行）的包级复制（目录水位 → 验签 → pack meta → 行级 → 才落库）；**复用** `store/packimport.ts` 的 `PackEntry` / `ImportResult`，不造第二份。
- `peersync/sync.ts`（270 行）+ 测试（256 行）：`RoundResult` / `ownershipIndex` / `syncPeer` / `runOnce` / `runForever`（对齐 `sync.go` 235 行）。
- `peersync/eventsync.ts`（624 行）+ 测试（436 行）：对齐 `eventsync.go` 436 行的事件 / 墓碑同步。
- `peersync/scrub.ts`（191 行）+ 测试（164 行）：`scrubOnce` / `scrubForever`（对齐 `scrub.go` 165 行；含反熵护栏 3「墓碑块直接删本地副本」）。
- `routes/peer.ts`（**新增 481 行**）+ `routes/peer.test.ts`（504 行）+ `routes/nodekey.test.ts`（40 行）：五 handler + `mountPeerRoutes(adapter, deps)` + 手写 JSON 扫描器（`skipWs` / `scanString` / `scanComposite` / `firstJSONValue`，复刻 Go `json.Decoder` 的裸字段语义）。
- `cli/peerconfig.ts`（**新增 298 行**）+ 测试（153 行）：10 个 flag（默认值取同名 env）+ `peersFromRaw` + `certPaths` / `tlsInfo` + `openStore` + `config` + `parseGoDuration`（`time.ParseDuration` 等价，错误文案逐字）+ `logf`（`log.Printf` 默认格式化）。
- `cli/peer-sync.ts`（47 行）+ 测试（30 行）、`cli/scrub.ts`（44 行）+ 测试（59 行）：对齐 `cmd/based/peersync.go`（44 行）与 `cmd/based/scrub.go`（48 行）。
- `routes/authmw.ts`（+21 −2）：新增 `requireNodeKey(tls, key)`（对齐 `tlscfg.go:202-212`）。
- `serve.ts`（+51 −）：`startServer` 拆出 `mountPublicRoutes`（**签名/行为不变**）+ 新增 `startPeerServer`（包整张 mux 对齐 Go `PeerHandler()` = 公开路由 ∪ 内部路由）。
- `main.ts`（+112）：`serve` 追加对端监听 + 反熵 / scrub 调度装配（`-peer-addr` / `-peers` / `-node-key` / TLS / `fetch-max-blobs` / 两间隔），并注册 `peer-sync` / `scrub` 两个子命令（共 9 条）。

### 12.1 门禁 G1–G6（逐条通过）

| 门 | 结果 | 证据 |
|---|---|---|
| G1 | 通过 | `go build ./...` / `go vet ./...` / `go test ./...` 全绿（本批不动 Go，作基线回归） |
| G2 | 通过 | `apps/node` `npx tsc --noEmit` **exit 0** |
| G3 | 通过 | `apps/node` `npx vitest run`：**44 文件 / 492 用例全绿**（批 C 收口时 30/356 ⇒ 批 D 净增 **14 文件 / 136 用例**） |
| G4 | 通过 | **HTTP 逐条 0 分歧**（P 组 **43 token**，见 §12.2）；阶段 4 DB 快照**对称差 3 行**（全为 go 侧多出，根因属开库引导，见 §12.3 / §12.4 发现 1）；**判据 4「只增不减」成立**（见 §12.2） |
| G5 | 通过 | `git diff --stat -- internal/` **无输出**（`git status` 对 `internal/httpapi/web.go` 的 ` M` 为陈旧 stat 项，定向 `git diff` 为空）；`packages/protocol-ts/**` / `web/**` / `#72` 冻结的 `ServerRequest` / `ServerAdapters` 未动 |
| G6 | 通过 | 只 `add` 本批 13 个新代码文件 + 14 个新测试文件 + 3 处改动 + 2 个文档；`.gitignore` / `internal/httpapi/web.go` / `based-linux-amd64` / `.tmp/`（含 G4 取证件）均未入暂存 |

### 12.2 G4 字节级对拍实况（批 D）

**方法**（沿用 §11.2，取件根 `e:\code\base\.tmp\g4\`，**未入提交**）：Node `openDb` + `migrate()` 建全量 schema → 插种子（7 个有效块 + 1 个 missing 块 `4444…` + 1 个 hash_mismatch 块 `7777…` + 事件 / 墓碑 / `tag/x` 存量词条 + store 密钥文件）→ **复制两份**（`pgo/` / `pnode/`）→ Go `store.Open(pgo)` **先于** Node 回放 → 两侧同一份 `ptokens.json`（43 token）逐字节回放 → 比对 `status` + 4 对照头（`content-type` / `cache-control` / `x-content-type-options` / `access-control-allow-origin`）+ body 字节（**不比 `Content-Length`**）。

**取证件与命令**：`pbuild.probe.ts`（造种子 + `cpSync` 两份 + 出 43 token）→ `pgoprobe/main.go`（Go 侧走 **`(*httpapi.Server).PeerHandler()`** 进程内直分发——对端 5 路由注册在 `PeerHandler()`（`server.go:93`）而**非** `Handler()`）→ `pnode.probe.ts`（Node 侧走**真 `http.createServer` + `127.0.0.1` 回环**）→ `pcompare.mjs`。

**结果：P 组 43 token，HTTP 逐条 0 分歧**（status / 4 头 / body 全一致，**无需 body 归一化**——五路由响应不含墙钟字段）。覆盖：

- **`inventory`（P01–P10，10 条）**：默认 / `limit=1` / 真实 cursor 翻页 / `limit=0`（回落默认 500）/ `limit=5000`（>2000 回落）/ `limit=abc`（回落）/ `since=content_version` 与 `+1`（空 blobs + `merkle_root`）/ `since=0` / `since=abc`。
- **`sync`（P11–P17，7 条）**：`equal=true` / 不等 / `{` 400 / 空体 400 / 数组 400 / `null` 200 / `content_version` 为字符串 400。
- **`fetch`（P18–P28，11 条）**：1 块 / 2 块 / 空 400 / 65 块 413 / 非 32-hex 400 / 不存在块 200（0 帧）/ 已墓碑块 200 / `{` 400 / 重复块 / 数组含 `null` 400 / 有行无文件 200。
- **`scrub`（P29–P33，5 条）**：**顺序为「子集先、全量后」**（单块 valid / missing / hash_mismatch → 再全量）→ 全量 200 / `{` 400。
- **`event-sync`（P34–P43，10 条）**：事件增量 / `limit=1` / 复合游标翻页 / 非枚举 kind 400 / `{` 400 / 墓碑 / 墓碑 `limit=1` / `limit=5000` / `limit=0`（回落）/ `null` 400。

**判据 4「只增不减」核验（Node 回放前后快照）**：

- 受跟踪表（`blobs|` / `events|`）**新增行数 0**（五路由中 inventory / sync / fetch / event-sync 只读，仅 scrub 会删坏块）。
- **删除行数 2**：`blobs|4444…4444|5|article/missing|0|<ts>`（missing）与 `blobs|7777…7777|28|article/bad|0|<ts>`（hash_mismatch）——恰为 P31 / P32 请求体指定的坏块，属**设计内**（`peer.go:316-334` → `store.VerifyBlobs`）；**events 删除 0 行**，其余行只增不减 ⇒ 断言成立。
- **水位不回退**：`inventory` 各次 `content_version` 恒为 7（种子水位）非递减；全量列举的各次响应块集合一致。
- 说明：服务端 `handleScrub` 的 `Repaired` **恒为 0**（跨节点补齐必须走出站请求，`httpapi` 包不依赖 `peersync`）——本批两侧同口径。

### 12.3 阶段 4 DB 状态对拍（批 D）

固定列序、主键升序、`|` 连接 ⇒ **集合对称差 3 行**（go 侧 27 行 / node 侧 24 行；按行集合比对，行序不计）。

**仅 go 侧有 3 行**：`directory_terms|tag|x|x|approved||<ts>|<ts>`、`meta|directory_seeded|1`、`meta|directory_version|1`。
**仅 node 侧有 0 行**。

**根因**：同 §11.3——Go `store.Open` 在 `migrate` 后调 `seedDirectoryFromExisting`，把存量 `tag/x` 登记为 `approved` 词条并 `bumpDirectoryVersion` 一次、写 `meta.directory_seeded=1`；Node 侧无等价实现。属**开库引导层**（§8「开库引导等价」边界项），**不属批 D 五路由范围**。批 C 实测 4 行对称差（含 node 侧 `directory_version|3`）本批降为 3 行，差异源于两侧种子不同（本批为纯 `tag/x` 单存量词条、无 proposal 路径），非行为变化。

### 12.4 执行期发现（登记）

1. **Node 缺 Go `store.Open` 的目录 seed 引导（残余缺口，沿用 §11.4 发现 1）**：覆盖 §12.3 的 3 行对称差；本批不动 `openStore` / `main.ts` 这条已收口基线共用的路径。
2. **对端路由的挂载面是 `PeerHandler()` 而非 `Handler()`（非缺口，口径定死）**：Go 5 条对端路由注册在 `(*httpapi.Server).PeerHandler()`（`server.go:93` = 公开路由 ∪ 内部路由），`Handler()` 只含公开路由 ⇒ 取证件必须走 `PeerHandler()` 才能覆盖；Node 侧 `startPeerServer` 用 `wrapAdapter` 把 `requireNodeKey` 套到**该 adapter 上注册的每个 handler**，与 Go 用 `RequireNodeKey` 包整张 `PeerHandler()` mux 等价；`-node-key` 为空时不包装（两侧同）。
3. **`requireNodeKey` 与 TLS 指纹是两层（非缺口）**：`X-Base-Node-Key` 预共享密钥（契约 6.3）与双向 TLS 指纹固定各自独立；Node 侧新增 `routes/nodekey.test.ts`（命中放行 / 缺头 / 不等长 / 等长不等值 → 401 `node_key_mismatch`）。
4. **取证件两侧都绕过真实 TLS 握手（口径定死，非缺口）**：Go 侧 `PeerHandler()` 进程内直分发（`httptest.NewRecorder()`），Node 侧真 `127.0.0.1` 回环但不做双向 TLS ⇒ G4 只自证**路由行为**等价，**不覆盖** TLS 握手 / 指纹固定层（该层由 `host/tls.ts` 与 `tlscfg.go` 的对齐单独负责）。
5. **`packimport` 两处各有其源（非重复实现）**：`store/packimport.ts` ← `internal/store/packimport.go`（229 行，`importPack` 落库唯一实现）；`peersync/packimport.ts` ← `internal/peersync/packimport.go`（359 行，包级复制编排）并**复用**前者的 `PackEntry` / `ImportResult`，不造第二份口径。
6. **出站/CLI 的有意差异（记录于各文件头，非缺口）**：① `logf` 由 Go `func(string, ...any)` 改为 `(msg: string) => void`（调用方预格式化）；② `context.WithTimeout` / `time.NewTicker` / `time.NewTimer` 改为 `AbortController` + `setTimeout` + 「可被 AbortSignal 打断的 sleep」；③ 首轮 jitter `rand.Int63n(60s)` 改为 `Math.floor(Math.random() * 60_000)`；④ `time.Duration.Round(time.Millisecond).String()` 自实现为 `formatGoDuration`（`5m` → `5m0s`、`24h` → `24h0m0s`）；⑤ `parseGoDuration` 返回**毫秒**（number）而非纳秒 `Duration`（本工程只用于调度间隔）；⑥ CLI 的 `TlsAdapter` 由命令文件内部构造（Go 是包级 `LoadOrCreateTLSCert`）；⑦ `openStore` 用 `openSyncStore` 而非 `store.Open`（Node 侧 host 库与出站端口已拆分）；⑧ `fmt.Printf` → `console.log`、`ctx.Err()` → `ctx.aborted`。
7. **`config()` 的 `-fetch-max-blobs` 整型解析（本批对齐）**：Node flag 表只给字符串，故在 `config()` 内补 `atoi`，错误文案对齐 Go flag 包 `invalid value "<v>" for flag -fetch-max-blobs: parse error`。边界微差（Go `flag` 的 `strconv.ParseInt(s,0,…)` 接受 `0x`/下划线、`envIntOr` 的 `Atoi` 为十进制 64 位；Node 侧统一按十进制且以 `Number.isSafeInteger` 为界）在调度间隔 / 对端清单的可达域外，**登记不改**。

## 13. 批 E：importer 容器 / 题库 / 视频派生（判据 6）

**状态：批 E 已收口**——P3 余下批次（A + B1–B4 + C + D + E）**全部收口**。

**范围**：§8 登记的批 E = `internal/importer`（1,819 行）容器 / 题库 / 视频派生 + CLI `import-video`；验收 = **判据 6**（同一数据集下两侧 `pack_id` 与 `merkle_root` 同一）。开工侦察确认 `internal/importer` 四文件分工：`md.go`（411 行：`Import` 全程编排 = 阶段 1 扫描 / 1.5 校验 / 2 条目 / 3 容器重建 / 3.5 分类 / 4 收尾）+ `course.go`（284 行：容器清单合并 / 排序 / 子项归属）+ `quiz.go`（119 行：题库解析）+ `video.go`（132 行：定长分块 / `content_hash` / MIME / 标题）。

**切法（5 Task，逐 Task 两阶段审查）**：

| Task | 内容 | 落点 |
|---|---|---|
| E1 | store 写面补齐 | core-ts `store/{queries,types}.ts` + apps/node `store/store.ts` |
| E2 | core-ts importer 纯派生 | `importer/{gojson,quiz,container,video}.ts` |
| E3 | import-md 全程编排接线 | apps/node `importer/{container,run}.ts` + CLI `import-md` 改薄壳 |
| E4 | import-video CLI + 注册 | `cli/import-video.ts` + `main.ts` |
| E5 | 门禁 + 回填 + 提交 | 本节 |

**产出（新增 14 代码/测试文件 + 7 夹具 + 改 6 处）**：

core-ts（纯派生，无宿主 IO）：

- `store/queries.ts`（**+73**）：11 个 SQL 常量（`UPSERT_SEGMENT_ITEM_SQL` / `DELETE_SEGMENTS_SQL` / `INSERT_SEGMENT_SQL` / `UPSERT_QUIZ_ITEM_SQL` / `UPSERT_QUIZ_SQL` / `UPSERT_MEDIA_ITEM_SQL` / `UPSERT_MEDIA_META_SQL` / `GET_ITEM_SQL` / `RETIRE_TOMBSTONE_SQL` / `RETIRE_STATE_SQL` / `NEXT_CONTENT_VERSION_SQL`）+ 纯函数 `segmentsContentHash`。**SQL 文本会进 `sqlite_master`，字面差异直接改包字节** ⇒ 子代理用临时脚本正则抽取 Go 原始串逐字节比对，**11/11 MATCH**。
- `store/types.ts`（**+33**）：`SegmentItemInput` / `QuizInput` / `MediaItemInput`。
- `importer/gojson.ts`（**新增 134 行**）：`marshalGoJSON` / `writeGoJSON` / `writeGoString`——Go `json.Marshal`（`SetEscapeHTML(true)`）等价序列化器：对象键按插入序、`<>&`→`\u003c/\u003e/\u0026`、U+2028/2029 转义、`/` 不转义。
- `importer/quiz.ts`（**新增 137 行**）：`parseQuiz` / `parseQuestions` / `quizRowFromQuiz`（错误文案逐字对齐 `quiz.go`）。
- `importer/container.ts`（**新增 91 行**）：`mergeChildren` / `sortDeclared` / `childIdsOf` / `digestTextOf` / `attrSegsOf` / `kindOf` + **`compareGoString`**（见发现 2）。
- `importer/video.ts`（**新增 61 行**）：`VIDEO_CHUNK_SIZE` / `guessVideoMime` / `videoItemId` / `videoContentHash` / `chunkSizes` / `videoTitleFromPath`。
- `importer/md.ts`（**+4 −1**）：`articleRowFromDoc` 的 `tags_json` 由 `JSON.stringify(doc.tags)` 改 `marshalGoJSON(doc.tags)`（**修正既有真实字节偏差**，见发现 3）。
- `index.ts`（**+4**）：补导出 importer 四模块。

apps/node（宿主 IO）：

- `store/store.ts`（**+190**）：`Store` 新增 8 方法——`getItem` / `nextContentVersion` / `retireItem` / `upsertSegmentItem`（事务内 upsert items → DELETE segments → 按 seq 升序 INSERT）/ `upsertQuiz` / `upsertMediaItem` / `putBlob` / `hasBlob`（后两者复用 `store/events.ts` 实现经 `hostDbAsDb` 适配）。
- `importer/container.ts`（**新增 257 行**）：`SubmittedContainerError` / `isSubmittedContainer` / `rebuildContainer` / `rebuildContainers` / `rebuildCategories`（**分类清单是本 Run 快照，不 `mergeChildren`**）/ `ensureLessonChild` / `ParsedMD`。
- `importer/run.ts`（**新增 175 行**）：`runImport`，逐字移植 `md.go:154-279` 的阶段 1 / 1.5 / 2 / 3 / 3.5 / 4。
- `cli/import-video.ts`（**新增 212 行**）：`importVideo` / `parseDurationFlag` / `createImportVideoCommand`；分块用 `openSync` + `readSync` + 复用 1 MiB `Buffer` 镜像 `io.ReadFull`。
- `cli/import-md.ts`（**改薄壳，+9 −112**）：`-retire-legacy` 真正生效，stdout 逐字 `import-md: 导入 %d 篇，失败 %d 篇` + `  ! %s`；warnings 不打印。
- `main.ts`（**+2**）：注册 `import-video`。

测试与夹具：core-ts 新增 4 测试文件（`gojson` / `quiz` / `container` / `video`，共 346 行）；apps/node 新增 `store/store.test.ts`（+266）/ `importer/container.test.ts`（202 行）/ `importer/run.test.ts`（500 行）/ `cli/import-video.test.ts`（325 行），改 `cli/import-md.test.ts`（+14）/ `cli/export.test.ts`（+37）；夹具 `apps/node/src/cli/__fixtures__/e3seed/*.md`（**7 篇**：`01-solo` / `10-a` / `20-b` / `30-c` / `40-d` / `50-quiz` / `60-e`）。

### 13.1 门禁 G1–G6（逐条通过）

| 门 | 结果 | 证据 |
|---|---|---|
| G1 | 通过 | `go build ./...` / `go vet ./...` / `go test ./...` 全绿（本批不动 Go，作基线回归） |
| G2 | 通过 | `apps/node` `npx tsc --noEmit` **exit 0** |
| G3 | 通过 | `apps/node` `npx vitest run`：**47 文件 / 534 用例全绿**（批 D 收口时 44/492 ⇒ 批 E 净增 **3 文件 / 42 用例**）；`packages/core-ts` `npx vitest run`：**39 文件 / 404 用例全绿** |
| G4 | 通过 | **判据 6：同数据集两侧 `pack_id` 与 `merkle_root` 同一**——4 组证据（方向 1/2/3 + G4-4），`pack.sqlite` / `manifest.json` 均两侧 sha256 全等，见 §13.2 |
| G5 | 通过 | `git diff --stat -- internal/` **无输出**（`git status` 对 `internal/httpapi/web.go` 的 ` M` 为陈旧 stat 项，定向 `git diff` 为空）；`packages/protocol-ts/**` / `web/**` / `#72` 冻结的 `ServerRequest` / `ServerAdapters` 未动 |
| G6 | 通过 | 只 `add` 本批 14 个新代码/测试文件 + 7 夹具 + 6 处改 + 2 个文档；`.gitignore` / `internal/httpapi/web.go` / `based-linux-amd64` / `.tmp/` 均未入暂存 |

### 13.2 G4 字节级对拍实况（判据 6）

**方法**：沿用 `apps/node/src/cli/export.test.ts`（**提交进仓库的 vitest 取证**，依赖仓库根 `based.exe`，`describe.skipIf(!existsSync(BASED_EXE))`；`diskHashes` **直读盘**算 sha256，不用 stdout 自报值）。批 E 新增**方向 3**（容器/分类/题库 seed，两侧**各自** `import-md` 建库 → 各自 export）与 **G4-4**（真实 >2 MiB 视频 → 两侧**各自** `import-video` → 各自 export），既有方向 1/2 复跑自证。

| 证据 | 数据集 | `pack_id` | `merkle_root` | `pack.sqlite` sha | `manifest.json` sha |
|---|---|---|---|---|---|
| 方向 1 | `.tmp/p3probe`（Go 建库，3 条目） | `91bf490a…` 两侧同 | `b5b867a8…`（**空集常量**） | `932244ea…` 两侧同 | `799f3eff…` 两侧同 |
| 方向 2 | `seed/`（Node 建库，3 条目） | `395f63a2…` 两侧同 | `b5b867a8…`（**空集常量**） | `fda7fc06…` 两侧同 | `7b517e1d…` 两侧同 |
| 方向 3 | `e3seed`（两侧各自 `import-md`，14 条目） | `395f63a2…` 两侧同 | `b5b867a8…`（**空集常量**） | `405debfc…` 两侧同 | `20c2f361…` 两侧同 |
| **G4-4** | 真实 2.5 MiB 视频（两侧各自 `import-video`，2 条目） | `13b32f91…` 两侧同 | **`9851a776…`（非平凡）** | `95f0d8e0…` 两侧同 | `712a2f16…` 两侧同 |

**判据 6 的实质（关键事实）**：`merkle_root = protocol.MerkleRoot(blobIDs)`，而 `blobIDs` **只来自 `media_meta` 的 `DeclaredChunks`**（`internal/packexport/export.go:136-152`）⇒ **无视频块时 merkle 是空集常量** `b5b867a806ecbe6e33384b30f7dd30e00811421f4936f0eb3eccd9fb7e86ff2a`。故方向 1/2/3 的 merkle 证据**平凡**（只能证 import-md 路径的包字节等价）；判据 6 的**非平凡证据由 G4-4 提供**。

**G4-4 关键日志（自跑复核）**：

```
[G4-4] import-video stdout go  ="import-video: course/cs101/lesson/l1/video/v1 块数=3 总字节=2621440 本次写盘=3 content_hash=9adb96476f3942f63489ab72d21d2041fb510062ab9a8fa402cc6725f52a0288\n"
[G4-4] import-video stdout node="（同上一字相同）"
[G4-4] go   pack_id=13b32f919bbe3cdb4b8e5b0f16b4e2fe cv=1 entries=2 merkle_root=9851a7765991c8e19219bd1fa65cb84ade0391a1af7fa05ef83c040149d7bf78
[G4-4] node pack_id=13b32f919bbe3cdb4b8e5b0f16b4e2fe cv=1 entries=2 merkle_root=9851a7765991c8e19219bd1fa65cb84ade0391a1af7fa05ef83c040149d7bf78
[G4-4] pack.sqlite   go=95f0d8e032ffaeb2803e2ffdeabdeac3e57230f5fb26a452f1bbf0a537219ab0
[G4-4] pack.sqlite   node=95f0d8e032ffaeb2803e2ffdeabdeac3e57230f5fb26a452f1bbf0a537219ab0
[G4-4] manifest.json  go=712a2f161320653ad3851e459632ff18efaf5a0a2186a969675f6190d27251d4
[G4-4] manifest.json  node=712a2f161320653ad3851e459632ff18efaf5a0a2186a969675f6190d27251d4
[G4-4] merkle_root=9851a7765991c8e19219bd1fa65cb84ade0391a1af7fa05ef83c040149d7bf78 空集常量=b5b867a806ecbe6e33384b30f7dd30e00811421f4936f0eb3eccd9fb7e86ff2a 非平凡=true
```

### 13.3 内容包无跨批缺口

内容包 `pack.sqlite` 只有 5 张表（`meta` / `articles` / `segments` / `quizzes` / `media_meta`，`packexport.go:22-55`）+ 固定 4 条 `meta`（`schema_version` / `pack_id` / `content_version` / `merkle_root`），**不含 `items` / `directory_terms`** ⇒ §8「开库引导等价」边界项（Node 缺 Go `store.Open` 的 `seedDirectoryFromExisting`）**不进内容包**，判据 6 不受其影响。

### 13.4 执行期发现（登记）

1. **判据 6 的 `merkle_root` 是 over blob ids，无视频块时为空集常量**（关键事实，见 §13.2）：`pack_id = DerivePackID(issuer, content_version, merkle)` ⇒ 无视频块时 `pack_id` 只由 issuer + `content_version` 决定。故「判据 6 已验」必须以**含视频块**的数据集（G4-4）为准，方向 1/2/3 只证 `import-md` 路径的包字节等价。
2. **`sortDeclared` 的字符串比较必须按 UTF-8 字节序（E3 修正，改包字节）**：JS `<` 是 UTF-16 码元序，非 BMP 字符（如 emoji）与 Go 字节序分歧 ⇒ E3 新增 `compareGoString`（核包内不得用 `Buffer`，用 `utf8()` 逐字节比较），`sortDeclared` 的 order / filename 均改由它比较。
3. **`tags_json` 的既有真实字节偏差（E2 修正）**：`articleRowFromDoc` 原用 `JSON.stringify(doc.tags)`，不做 HTML 转义；Go `json.Marshal` 默认 `SetEscapeHTML(true)`（`<>&` → `\u003c/\u003e/\u0026`）⇒ 含这些字符的 tag 会改包字节。E2 改走 `marshalGoJSON` 并补对拍用例（`TAGS_HTML` 夹具 sha `90e7fbe9…`）。
4. **`nextContentVersion` 整型判定比 Go 宽松（登记不改）**：用 `Number()` / `Number.isInteger`，对 `""` / `0x10` / `1e3` 等边界串比 Go `strconv.ParseInt` 宽松（与既有 `bumpContentVersion` 同约定）。
5. **`stemOf` 对以点开头的文件名与 Go 有别（登记不改）**：`.mp4` 之类（`dot > 0` 判定）与 Go `filepath.Ext` + `TrimSuffix` 边界不同。
6. **`-duration` 解析用十进制（登记不改）**：Go `flag.Int64`（`strconv.ParseInt(s,0,64)`）认 `0x` / `0o` / `0b` 前缀，Node 侧按十进制。
7. **`Run` 阶段 4 失败的返回口径（登记不改）**：Go 返回 `(部分 res, err)`，Node 抛错；`read dir` 失败文案随 Node fs 措辞。
8. **未知 flag 退出码 Node=1 vs Go=2**（既有登记，设计册 `#74` 附录 A）。
9. **已知跨批缺口「开库引导等价」不在本批修**：已确认不进内容包（§13.3）。
