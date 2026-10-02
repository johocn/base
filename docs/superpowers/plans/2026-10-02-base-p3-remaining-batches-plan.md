# base P3 余下批次计划（按 P5 六条判据切批）

- 日期：2026-10-02
- 上游：路线计划 `#70`（§1 P3 行、§5 节点职能清单、§6 P5 等价判据）；首批计划 `#73`（§8 不做「P3 余下批次」、§9.2 执行期发现）；接口边界冻结面 `#72`
- 状态：**执行中**（批 A 开工；完整度见 §9「执行实况」）
- 范围：**P3 余下批次**，共五批（§1）。本册详列**批 A**，批 B–E 只登记边界（§8）
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
| **A** | **纯匿名公开读 JSON 面 12 条 + 门户页 3 个** | **判据 2**（字节级） | 本册执行 |
| B | 认证读写面：身份写（`identity/register`、`escrow` PUT）/ `me` / `event` / `profile` / `submit` / `blob` POST / `group` 读权（`optionalAuth`）+ `authmw` 的 `X-Base-*` 五头 | 判据 3（签名域与错误码） | 未开工 |
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

- **批 B**：`identity/register`（`identity.go:91`）、`identity/escrow` PUT（`:161`）、`me`、`event`（`event.go`，含 `eventTypeRegistry` fail-closed 白名单）、`profile`、`submit`（`submit.go` 393 行）、`blob` POST（`blob.go:17`）、`group` 读权（`group.go:681`）+ `authmw.go`（236 行，`X-Base-*` 五头）。验收 = 判据 3。
- **批 C**：`govern.go`（405 行）+ `govern_event.go`（222 行）+ `directory_proposal`；验收 = 判据 5。
- **批 D**：`peer.go`（334 行）+ `internal/peersync`（2,784 行）+ CLI `peer-sync` / `scrub`；验收 = 判据 4（**只增不减**须保持）。
- **批 E**：`internal/importer`（1,819 行）容器 / 题库 / 视频派生 + CLI `import-video`；验收 = 判据 6。

## 9. 执行实况

（批 A 完成后回填。）
