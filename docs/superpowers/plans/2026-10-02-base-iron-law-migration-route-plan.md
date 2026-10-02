# P1–P6 迁移路线（实施计划 #70）

- 日期：2026-10-02
- 上游：册子 `#69`《铁律对齐》（`specs/2026-10-02-base-app-is-all-iron-law-alignment-design.md`）
- 状态：**待执行**（路线级计划；每阶段开工前另出任务级计划）
- 性质：路线计划，**不承载契约**。契约一律回册子。

## 0. 本册为什么存在：对 #69 §6 的四处修正

`#69 §6` 的分期是**未取证的粗线条**，取完证后必须重排。

| # | #69 原口径 | 取证结论 | 修正 |
|---|---|---|---|
| 1 | P1 =「补齐 `protocol-ts` 相对 `internal/protocol` 的**零散缺口**」 | **不成立**：缺口的主体不是「缺失」，而是「**位置错误**」——`attrs` / `progress` / `tags` / `markdown` 的 TS 实现**早已存在**，但躺在 `apps/mobile/src/core/` 里（`core/attrs.ts:96` `assignAttrSeqs`、`core/progress.ts:50` `progressWins`、`core/tags.ts` 全套） | **P1 与 P2 合并**为「核收敛」 |
| 2 | #69 §2.1 / §3.2 记「缺 `DerivePackID` 等零散项」 | **误记**：`packages/protocol-ts/src/manifest.ts:54` 已有 `derivePackId(issuer, contentVersion, merkleRootHex)`，与 `internal/protocol/sign.go:63` 对应 | 更正，见 §2 |
| 3 | 「靠 `Adapters` 注入口换壳」 | **只说对一半**：`Adapters`（`fs`/`storage`/`http`/`packReader`）是**客户端侧**接口，没有「监听 / 路由 / TLS / 定时 / 进程信号」——Node 壳需要**另一组服务端侧抽象** | **P2 前增设接口边界审查门**，见 §3 |
| 4 | 融合治理（铁律二）与内容自治作用域（铁律三）排在最末 P6 | 二者的**设计**会改数据模型（新事件类型 / 新表 / 圈子读权），若等 P5 迁移完才发现，**P4 的实现全部返工** | **设计前移、实现后置**：设计提到 P4，实现仍在 P6，见 §4 |

## 1. 重排后的总览

| 阶段 | 目标 | 服务铁律 | 退出准则（硬） |
|---|---|---|---|
| **P1 核收敛** | 抽出单份宿主无关核；协议核补空 | ① | 核包不 import `uni`/`plus`/`node:`；`vectors/v1/` **全部**向量在核包内通过 |
| **P2 接口边界 + Node 壳最小可跑** | 锁定 `Adapters` 与**服务端侧抽象**；Node 壳能起服务 | ① | 接口冻结（本阶段后不得再改）；同一份核在手机壳与 Node 壳均能加载；Node 壳能响应 `/healthz` 与公开读 |
| **P3 节点职能补齐** | 导入 / 导出 / 对端同步 / scrub / CLI / 门户 | ① | 节点职能清单（§5）逐项通过；Go 版与 Node 版对同一数据集产出**同一份包** |
| **P4 融合治理【设计】** | 铁律二 / 铁律三的数据模型提案 | ② ③ | 产出提案册（新事件类型 / 新表 / 圈子读权 / 内容自治作用域）；**经评审后才允许 P5 开工** |
| **P5 并行双跑 → 退役** | 行为等价后 Go 只读 → 退役 | ① | §6 全部等价判据通过；不通过**不退役** |
| **P6 融合治理【实现】** | 铁律二 / 铁律三落地 | ② ③ | 融合动作全程**只增不减**；融合治理与内容自治按 P4 提案验收 |

**关键次序约定**：P4 是**设计轨**，只出文档不出代码；P6 是**实现轨**。P5 夹在中间，**不得**在 P4 定稿前开工——否则数据模型变更会让 P5 的等价基线作废。

## 2. P1 精确范围

### 2.1 真缺口（TS 侧完全没有，**新增**）

| Go 符号 | 位置 | 落点 | 说明 |
|---|---|---|---|
| `WriteBlobFrame` / `ReadBlobFrame` | `internal/protocol/blobpack.go:24,43` | **新增** `packages/protocol-ts/src/blobpack.ts` | blob 传输帧的写 / 读 |
| `BlobPackContentType` / `BlobFetchMaxBytes` | `internal/protocol/blobpack.go` | 同上 | 对端传输的**共享契约常量**（`blobpack_test.go:54` 明确「IsSharedContract」） |
| `ValidSlug` | `internal/protocol/id.go:35` | 先核对 `core/tags.ts` 的归一化口径，**择一**后落 `protocol-ts` | 若 `core/tags.ts` 已覆盖则只需上提，不重写 |

### 2.2 位置错误（TS 有，但**在错的包里**，需上提）

| Go 包 | 现有 TS（错位置） | 动作 |
|---|---|---|
| `internal/protocol/attrs.go` | `apps/mobile/src/core/attrs.ts` | 上提到核包；`core/attrs.ts` 变 re-export |
| `internal/protocol/progress.go` | `apps/mobile/src/core/progress.ts` | 同上 |
| `internal/protocol/tag.go` | `apps/mobile/src/core/tags.ts` | 同上 |
| `internal/markdown` | `apps/mobile/src/core/markdown.ts` | 同上（`vectors/v1/markdown.json` 已是共享向量） |

### 2.3 已对齐（**不动**）

`canonical` / `hash` / `merkle` / `ed25519` / `manifest`（含 `derivePackId`）/ `author` / `reqsig` / `release` / `identity` —— `packages/protocol-ts/src/` 已逐一对应。

### 2.4 P1 的核包切分线

- **协议核**：语言中立、**无 IO**、被 `vectors/v1/` 覆盖的纯函数 → `packages/protocol-ts/`。
- **业务核**：依赖 `Adapters` 但不依赖具体宿主 → 新包（暂名 `packages/core-ts/`）。
- 判据：**一个模块若能被 `vectors/` 的某个 JSON 驱动，就属协议核**；否则属业务核。

## 3. P2 前置门：接口边界审查（**先锁定，后抽取**）

### 3.1 客户端侧（现状，已存在）

`fs` / `storage` / `http` / `packReader`（`apps/mobile/src/platform/adapter.ts`）+ `LocalDb`。**问题：只有客户端语义**（`http.get/post` 是出站请求），**没有服务端语义**。

### 3.2 服务端侧（**缺，需新增并冻结**）

| 能力 | 现阶段由谁承担 | Node 壳落点 |
|---|---|---|
| 监听 / 路由（约 40 条，见 §5） | `internal/httpapi/server.go:102-164` | Node 监听器 + 路由表 |
| 节点间 mTLS / 指纹固定 / `X-Base-Node-Key` | `internal/httpapi/tlscfg.go:205` | Node `tls` 模块 |
| scrub 定时调度 | `cmd/based/scrub.go` | Node 定时器 |
| CLI 子命令 | `cmd/based/*.go`（12 个子命令） | Node CLI |
| 进程信号 / 优雅停机 | `cmd/based/serve.go` | Node 进程事件 |

**门禁**：§3.2 五项接口在本阶段**一次锁定**；P3 起不得再改这组边界。锁定产物写入本册附表（开工时补）。

## 4. P4 融合治理【设计】范围

现状口径：反熵**只增不减已符合**（`internal/peersync/sync.go` 只补本地缺失）；**融合治理零实现**。

设计轨需回答（只出提案，不写代码）：

1. **融合时的圈子规则**：融合动作以哪个圈子为治理主体？无圈子时是否必须**形成新圈子**？
2. **数据模型影响**：是否引入新事件类型 / 新表 / 圈子**读权**字段？
3. **`vectors/` 影响**：新事件是否需新增黄金向量？
4. **与现有治理的关系**：与 `#27` 节点级治理（`remove` 3 票 / `edit`·`revive` 2 票）、`#58` 目录词条准入如何共处？
5. **铁律三作用域**：「内容自治」是否指**内容本身**可被票选下架 / 编辑？与 `#51` 登记的「不建审批闸门」如何调和？
6. **票权口径**：现票权由达标 `article`/`video`/`quiz` 作者派生，**课程与课时不计贡献**（`#65` 已暴露同类缺口）——内容自治下是否须扩到全部载体？

## 5. P3 节点职能清单（来自取证）

- **HTTP 接口**：约 40 条（`internal/httpapi/server.go:102-164`），分五组——公开读（`catalog`/`manifest`/`pack`/`blob`/`release`/`directory`/`contributors`/`comment`/`inventory`）、身份与认证写（`identity/*`、`me`、`event`、`profile`、`submit`、`blob`）、治理（`proposal*`）、对端同步（`sync`/`fetch`/`scrub`/`event-sync`）、节点的门户页（`/`、`/a/*`、`/governance`）与运维（`healthz`、`admin/review/*`）。
- **CLI**：`serve` / `import` / `importvideo` / `export` / `release` / `scrub` / `peersync` / `tlscert` / `storekey` / `pubkey`（`cmd/based/`）。
- **门户**：`web/` 模板（`html/template` + 少量原生 JS，内嵌）。

## 6. P5 行为等价验收标准（**退役的唯一闸门**）

| # | 判据 | 口径 |
|---|---|---|
| 1 | 黄金向量 | `vectors/v1/` **全部**向量在核包内通过 |
| 2 | 公开读接口 | 响应体**字节级**一致（含 `Content-Type` / `ETag` / `Cache-Control` / `If-None-Match` 304 语义） |
| 3 | 认证写接口 | 签名域与错误码语义一致（`authmw.go` 的 `X-Base-*` 五头） |
| 4 | 同步 / 反熵 | 同一数据集下 Go 与 Node 的 `sync`/`fetch`/`event-sync` **结果集一致**，且**只增不减** |
| 5 | 治理派生视图 | `proposal` 列表 / 票数 / 门槛（含 `#65` 的小节点豁免）逐条一致 |
| 6 | 内容包 | 同一数据集导出的包 **pack_id 与 merkle_root 同一** |

**任一判据不过 ⇒ 阻塞退役**，不得「先退役再补」。等价期 Go 与 Node **同时在线**，互为对照。

## 7. 铁律追溯

| 阶段 | 铁律一 | 铁律二 | 铁律三 |
|---|---|---|---|
| P1 核收敛 | ✅ 单核的前置 | — | — |
| P2 接口边界 + Node 壳 | ✅ 同核双形态成立 | — | — |
| P3 节点职能补齐 | ✅ 节点可独立部署 | 反熵只增不减须保持 | — |
| P4 融合治理【设计】 | — | ✅ | ✅ |
| P5 并行双跑 → 退役 | ✅ 单实现落地 | 等价判据 4 守住只增不减 | 判据 5 守住票选口径 |
| P6 融合治理【实现】 | — | ✅ | ✅ |

## 8. 风险与回退

| # | 风险 | 处置 |
|---|---|---|
| 1 | P1 上提时改动 `core/*` 的 import 面过大 | 上提采用 **re-export 过渡**：原路径保留转发，稳定后再删 |
| 2 | `Adapters` 边界锁早了不够用 | §3.2 一次性覆盖五类能力；**宁可多留一个方法，也不二次改边界** |
| 3 | SQLite 驱动差异（Go `modernc.org/sqlite` vs Node 侧驱动） | 判据 1/4/6 兜底；差异即阻塞退役 |
| 4 | P4 设计久拖导致 P5 停滞 | P4 有时限；超时则 P5 只做**只读等价**，写路径等价后置 |
| 5 | 迁移期「双实现」被误当目标态 | #69 §0.13 已钉死；本册 §1 再次声明 |
| 6 | Node 壳缺 `plus.*` 能力（`#4`/`#17`/`#46`） | 严格执行「核不 import `uni`/`plus`/`node:`」 |

## 9. 不做

- 不删 Go 实现（P5 等价前一直并行）。
- 不做 iOS。
- 不改内容包规范 v1、不 bump `schema_version`。
- 不在 P4 定稿前动 P5；不在 P1 改任何契约语义。
- 不为兼容保留双份核心（过渡期只用 re-export，不复制逻辑）。
