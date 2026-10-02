# P2 接口边界 + Node 壳最小可跑（实施计划 #72）

- 日期：2026-10-02
- 上游：册子 `#69`《铁律对齐》、路线计划 `#70`《P1–P6 迁移路线》
- 状态：**待执行**（任务级计划；接口冻结附表见 `#70` §3.2）
- 性质：任务级计划。**契约一律回册子 / 路线计划**，本册只落执行口径。

## 0. 一句话

P2 做三件事：① **冻结接口**——客户端 `Adapters` 原样上提，**新增独立一组**服务端侧 `ServerAdapters`（监听/路由、TLS、定时、CLI、进程信号五类）；② **建 `packages/core-ts` 并整体搬迁业务核**（`apps/mobile/src/core/*`，原路径留 re-export 过渡）；③ **建 `apps/node` 壳**，用 `node-sqlite3-wasm` 读库，跑通 `/healthz` 与 `/v1/catalog`。

## 1. P2 前置门的 5 项决策（用户 2026-10-02 已定，执行期不再议）

| # | 取舍 | 定死 |
|---|---|---|
| 1 | 服务端五类与客户端 `Adapters` 的关系 | **独立一组**。`Adapters` 原样不动（4 能力 + `LocalDb`）；服务端另立 `ServerAdapters`。手机壳不必实现服务端方法 |
| 2 | `packages/core-ts` 本轮范围 | **全搬业务核**。`apps/mobile/src/core/*`（除 `update.ts` / `selfcheck.ts`）整体搬入；mobile 侧原路径改 **re-export shim** |
| 3 | Node 壳落点 | **`apps/node`**，与 `apps/mobile` 平级，根 `package.json` workspaces 注册 |
| 4 | Node 壳最小验收 | **`/healthz` + `/v1/catalog`**。字节级等价留给 P5 判据 2 |
| 5 | SQLite 驱动 | **`node-sqlite3-wasm`**（纯 WASM、零原生编译、Node 20 可用、同步 API） |

## 2. 接口冻结（本阶段锁定，P3 起不得再改）

### 2.1 客户端侧 `Adapters`（原样，只改归属）

`apps/mobile/src/platform/adapter.ts` 全量上提到 `packages/core-ts/src/platform/adapter.ts`，**逐字不变**（`FsAdapter` / `StorageAdapter` / `HttpResponse` / `HttpAdapter` / `SqliteConnection` / `PackReader` / `LocalDb` / `Adapters`）。原路径改 **显式 re-export**。

### 2.2 服务端侧 `ServerAdapters`（新增，独立一组）

落点 `packages/core-ts/src/platform/server.ts`，**纯类型声明，零 `node:` 依赖**（实现归 `apps/node`）。

```ts
export interface ServerRequest {
  method: string; path: string;
  params: Record<string, string>; query: Record<string, string>;
  headers: Record<string, string>; body: Uint8Array;
}
export interface ServerResponse { status: number; headers?: Record<string, string>; body?: Uint8Array }
export type ServerHandler = (req: ServerRequest) => Promise<ServerResponse>;

/** 1. 监听 / 路由 */
export interface Listener { addr(): string; close(): Promise<void> }
export interface ListenOptions { host: string; port: number; tls?: TlsMaterial }
export interface HttpServerAdapter {
  /** pattern 沿用 Go http.ServeMux 体例："GET /v1/catalog"、"GET /v1/manifest/{pack_id}"、"GET /a/{item_id...}" */
  handle(pattern: string, handler: ServerHandler): void;
  listen(opts: ListenOptions): Promise<Listener>;
}

/** 2. TLS / 指纹固定 / X-Base-Node-Key（镜像 internal/httpapi/tlscfg.go） */
export interface TlsMaterial { certFile: string; keyFile: string }
export interface TlsInfo extends TlsMaterial { fingerprintHex: string; pairingCode: string }
export interface TlsAdapter {
  loadOrCreate(info: TlsMaterial): Promise<TlsInfo>;          // 自签生成 + 载入（P3 随 tlscert 实现）
  serverConfig(info: TlsInfo, peerFingerprints: string[]): TlsMaterial;
  clientConfig(own: TlsInfo, peerFingerprintHex: string): TlsMaterial;
  verifyPeer(rawCertsDer: Uint8Array[], allowed: string[]): void; // 空名单 = 拒绝一切（fail-closed）
  nodeKeyMatches(want: string, got: string): boolean;            // 常量时间
}

/** 3. 定时调度（镜像 cmd/based/scrub.go 的 ScrubForever） */
export interface ScheduledHandle { cancel(): void }
export interface SchedulerAdapter { every(intervalMs: number, fn: () => Promise<void>): ScheduledHandle }

/** 4. CLI 子命令（镜像 cmd/based/main.go 的分发表） */
export interface CliCommand { name: string; run(args: string[]): Promise<number> }
export interface CliHost { register(cmd: CliCommand): void; run(argv: string[]): Promise<number> }

/** 5. 进程信号 / 优雅停机（镜像 cmd/based/serve.go） */
export interface LifecycleAdapter {
  onShutdown(fn: () => Promise<void>): void;  // SIGINT/SIGTERM 时按注册逆序执行
  exit(code: number): void;
}

export interface ServerAdapters {
  http: HttpServerAdapter; tls: TlsAdapter; scheduler: SchedulerAdapter;
  cli: CliHost; lifecycle: LifecycleAdapter;
}
```

> 口径依据 `#70` §8 风险 2：**宁可多留一个方法，也不二次改边界**。故五类一次留全，即使 P2 只实现其中一部分。

### 2.3 P2 的**实现面**与**接口面**（刻意区分）

| 能力 | P2 冻结接口 | P2 在 `apps/node` 实现 | 留 P3 |
|---|---|---|---|
| 监听 / 路由 | ✅ | ✅ `node:http` + ServeMux 体例路由 | 其余路由 |
| TLS | ✅ | ✅ **载入 + 指纹校验 + node-key**（`node:tls` / `node:crypto`） | `loadOrCreate` 自签生成（随 `tlscert`） |
| 定时 | ✅ | ✅ `setInterval` 包装（立即执行一次） | scrub 任务体 |
| CLI | ✅ | ✅ argv 分发（P2 只注册 `version` / `serve`） | 其余 9 个子命令 |
| 进程信号 | ✅ | ✅ SIGINT/SIGTERM → 逆序停机 | — |

## 3. 搬迁规则（签字区）

- **`packages/core-ts`**：`name=@base/core-ts`、`type=module`、`main/types/exports` 指 `./src/index.ts`；**子路径导出** `"./*": "./src/*.ts"` 供 mobile 的 shim 1:1 转发。
- **包内目录**：`src/platform/{adapter.ts,server.ts}` + 其余业务模块平铺（与 `apps/mobile/src/core` 同形）。
- **shim 口径**（与 P1 的差异，说明理由）：P1 禁 `export *` 是因为「整包泄进单个 core 模块命名空间」；本轮 shim 是 **1:1 模块转发**（`core/submit.ts` → `@base/core-ts/submit`），故 **`export *` 即正确语义**，不构成污染。
- **保留在 `apps/mobile` 的模块**：`core/update.ts`、`core/selfcheck.ts`（唯二 import `../platform/uni` 的宿主探针）；其 import 改指 `@base/core-ts`。二者的测试随之留在 mobile。
- **不搬的三个 P1 shim**：`core/attrs.ts` / `core/progress.ts` / `core/markdown.ts`（现指向 `@base/protocol-ts`）**留在 mobile 不动**；core-ts 内对它们的引用**改指 `@base/protocol-ts`**。
- **测试**：随模块搬进 core-ts；向量相对路径改 `../../../vectors/v1/…`；`fakes.ts` 随核搬（Node 壳测试也要用）。
- **`core/types.ts`**：属业务核，随核搬。注：该文件在工作区被 ` M` 标记但 **`git diff --numstat` 为空**（仅行尾/stat 噪声，无内容改动），故 `git mv` 不丢任何东西。

## 4. Task 列表（TDD：先搬测试，再搬实现；子代理驱动 + 两阶段审查）

### Task 1 core-ts 骨架 + 服务端五类接口 + adapter 上提

- 新建 `packages/core-ts/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,src/platform/adapter.ts,src/platform/server.ts}`；根 `package.json` workspaces 追加 `packages/core-ts`。
- `src/platform/adapter.ts` = `apps/mobile/src/platform/adapter.ts` **逐字搬迁**；`apps/mobile/src/platform/adapter.ts` 改 **显式 re-export**（`export type { … } from '@base/core-ts/platform/adapter'`）。
- `src/platform/server.ts` = §2.2 五个接口（纯类型）。
- 验收：`npm run typecheck -w @base/core-ts` 干净；`npm test -w @base/mobile` 与 `-w @base/protocol-ts` 全绿（应零变化）。

### Task 2 业务核搬迁 `core` → `core-ts`

- 搬 `apps/mobile/src/core/*.ts`（除 `update.ts` / `selfcheck.ts` / 三个 P1 shim）到 `packages/core-ts/src/`，**含 `types.ts` / `fakes.ts` / 同名 `*.test.ts`**。
- 核内 import 修正：`../platform/adapter` → `./platform/adapter`；`./attrs|./progress|./markdown` → `@base/protocol-ts`。
- mobile 侧被搬模块原路径改 **`export * from '@base/core-ts/<module>'`** shim（`.vue` 与 `pages/**` **零改动**）。
- `core/update.ts` / `core/selfcheck.ts` 改 import 指向 `@base/core-ts`（保持 `../platform/uni` 不变）。
- 验收：根 `npm test` 全绿，**如实记录迁移前后两侧用例数**（预期总量守恒）；`apps/mobile/pages/**` 与 `platform/**` 零改动。

### Task 3 `apps/node` 壳：ServerAdapters 实现 + `/healthz` + `/v1/catalog`

- 新建 `apps/node`（`package.json` / `tsconfig.json` / `vitest.config.ts`）；依赖 `@base/core-ts` + `node-sqlite3-wasm`；根 workspaces 注册。
- `src/host/`：`http.ts`（ServeMux 体例路由：`{param}` 与 `{rest...}` 通配 + `node:http` 监听）、`tls.ts`（载入 + 指纹固定 + node-key 常量时间比较）、`scheduler.ts`、`cli.ts`、`lifecycle.ts`。
- `src/routes/healthz.ts`：逐字对齐 Go —— `{"ok":true,"version":"<版本>"}`，`Content-Type: application/json`。
- `src/routes/catalog.ts`：逐字段对齐 `internal/httpapi/public.go:41-109` 的 `catalogResponse`（`pack_id` / `content_version` / `items[{item_id,source,type,title,content_hash,source_rev}]` / `next_cursor`），`limit` 默认 200（1..1000）、`since>=version` 短路、`limit+1` 取页判 `next_cursor`、只出 `state=active && dist_class=public`。SQL 取证自 Go store 层。
- `src/serve.ts` / `src/main.ts`：装配 `ServerAdapters` → 注册两条路由 → `listen` → `lifecycle.onShutdown` 优雅停机。
- 验收：起服务后 `GET /healthz` → 200 且体为 `{"ok":true,…}`；`GET /v1/catalog` → 200 且 JSON 形状与 Go 同构（空库为 `{"pack_id":"","content_version":0,"items":[],"next_cursor":null}`）。

### Task 4 门禁与实况回填

- **G1** 根 `npm test` 全绿（三包）。
- **G2** 根 `npm run typecheck`：`protocol-ts` / `core-ts` / `node` 干净；mobile 仅剩 `#62` 决策 12 登记的 **2 条册外既有 `.vue` 错误**（不得新增）。
- **G3** `core-ts` 非测试源码**零宿主依赖**：Grep `plus\.|from ['"]node:|from ['"]uni|@dcloudio|from ['"]vue` ⇒ 零命中。
- **G4** Node 壳冒烟：`/healthz` 200 + `/v1/catalog` 200（同 G3 口径的自动用例）。
- **G5** `vectors/v1/` **13/13** 仍由协议核消费（P1 不回归）。
- **G6** `git diff --stat -- internal/` 无输出；四项禁碰文件（`.gitignore` / `apps/mobile/src/core/types.ts` 的**噪声标记** / `internal/httpapi/web.go` / `based-linux-amd64`）**不入本次提交**。
- 回填本册「§8 执行实况」+ `docs/README.md`（#72 行 + #70 行状态）。
- **发布判断**：P2 无用户可见改动（`apps/mobile` 行为等价），**不做 APK / 节点发布**。

## 5. 不做

- 不删 Go 实现；不改任何 Go 文件。
- 不做 P3 节点职能（导入/导出/对端同步/scrub/门户/其余 9 个子命令）——只冻结接口。
- 不改内容包规范 v1、不 bump `schema_version`。
- 不为兼容复制双份核心（过渡只用 shim，不复制逻辑）。
- 不改 `apps/mobile/src/pages/**`、不改三个 P1 shim、不新增配置项。
- 不做 iOS。

## 6. 风险与回退

| # | 风险 | 处置 |
|---|---|---|
| 1 | `@base/core-ts/*` 子路径导出在 vitest/vue-tsc 下解析失败 | 回退方案：`index.ts` 显式聚合 + shim 改显式具名 re-export（不复制逻辑） |
| 2 | Task 2 体量大、易漏改 import | 先搬 + 跑测试暴露断链；如一子代理跑不动，按模块簇拆 2–3 批，批间审查 |
| 3 | `types.ts` 在工作区被标记 | 已核实零内容 diff；`git mv` 后 **不 `git add` 该路径的旧标记**，只 add 新路径与删除动作 |
| 4 | `node-sqlite3-wasm` 的 ESM/CJS 互操作 | 若默认导出不兼容，`tsconfig` 开 `esModuleInterop` + `allowSyntheticDefaultImports`（`apps/node` 局部） |
| 5 | 冻结的服务端接口 P3 不够用 | `#70` §8 风险 2 已认账：P2 一次留全五类，**P3 起不得再改** |
| 6 | Node 壳 catalog 与 Go 字节不一致 | P2 只要求**形状同构**；**字节级等价是 P5 判据 2**，不阻塞 P2 |
| 7 | 【执行期发现】`TlsAdapter.serverConfig` / `clientConfig` 返回 `TlsMaterial`（只有 `{certFile,keyFile}`），**无法承载对端指纹白名单与目标指纹**——`internal/httpapi/tlscfg.go` 的 `ServerTLSConfig(info, peerFingerprints)` / `ClientTLSConfig(own, peerFingerprintHex)` 是靠**返回值携带**这些参数的 | P2 无出站对端调用、也不起对端监听 ⇒ **不阻塞**，实现按 `TlsMaterial` 原样返回（见 §2.3）。**本阶段不改冻结边界**；登记为 P3 开工前的接口复议项（P3 要实现对端同步/双向 TLS 时必然撞到） |

## 7. 文件清单（预估）

- 新增：`packages/core-ts/**`（骨架 3 文件 + `src/platform/{adapter,server}.ts` + 业务模块 ~35 + 测试 ~30）；`apps/node/**`（骨架 3 + `src/host/*` 5 + `src/routes/*` 2 + `src/serve.ts` + `src/main.ts` + 冒烟测试）
- 改：根 `package.json`（workspaces）；`apps/mobile/src/platform/adapter.ts`（改 shim）；`apps/mobile/src/core/*.ts`（被搬者改 shim）；`apps/mobile/src/core/{update,selfcheck}.ts`（改 import 指向）
- 文档：`#70` §3.2 附表；`docs/README.md`；本册 §8
- 不碰：`internal/**`、`.gitignore`、`internal/httpapi/web.go`、`based-linux-amd64`

## 8. 执行实况

**结论：Task 1–4 全部落地；门禁 G1–G7 逐条通过；零 Go 改动、零用户可见改动，故无 APK / 节点发布。** 执行方式：Task 1 / Task 2 / Task 4 由主代理直接执行（机械搬迁需全局一致，脚本化落地 + 逐类核查），Task 3 派子代理实现后由主代理逐文件复核。

### 8.1 Task 1（core-ts 骨架 + 服务端五类接口 + adapter 上提）

- 新增 `packages/core-ts/{package.json,tsconfig.json,vitest.config.ts}`、`src/index.ts`、`src/platform/adapter.ts`（逐字搬迁，零字符改动）、`src/platform/server.ts`（五类接口纯类型，零 `node:`）。
- `package.json` 的 `exports` = `{".": "./src/index.ts", "./*": "./src/*.ts"}`；`apps/mobile/src/platform/adapter.ts` 改 **8 个名字的显式 `export type` re-export**（原文件 18 处消费**全部是 `import type`**，无值导入，故类型转发语义完整）。
- 根 `package.json` workspaces += `packages/core-ts`；`apps/mobile/package.json` dependencies += `@base/core-ts`（真实依赖，非仅为解析）。
- **风险 1 未发生**：`@base/core-ts/*` 子路径导出在 vitest 与 `vue-tsc` 下**均解析正常**，无需回退到「显式聚合」方案。
- 验收：`npm run typecheck -w @base/core-ts` 0 错误；`@base/protocol-ts` 9/156、`@base/mobile` 35/376 **与基线逐字一致**；mobile typecheck 仅剩 2 条册外既有 `.vue` 错误。

### 8.2 Task 2（业务核搬迁 `core` → `core-ts`）

- `git mv` **66 个文件**（34 个非测试模块 + 32 个测试）进 `packages/core-ts/src/`；mobile 侧为这 **34 个模块**各建 1 行 `export * from '@base/core-ts/<module>'` 的 1:1 转发 shim。
- 核内 import 重写 26 个文件：`../platform/adapter` → `./platform/adapter`；`./attrs` / `./progress` / `./markdown` → `@base/protocol-ts`（P1 上提的三个模块）。
- **留在 mobile 的 7 个文件**：`update.ts` / `selfcheck.ts`（唯二 import `../platform/uni` 的宿主探针）+ 其 2 个测试 + P1 的三个 re-export shim（`attrs.ts` / `progress.ts` / `markdown.ts`）。`update.ts` 与 `selfcheck.ts` 的 import 已改指 `@base/core-ts/{sync,platform/adapter,comment,repo}`，`../platform/uni` 与 `./update` 保持不变。
- **用例守恒（逐字核对）**：迁移前 = protocol-ts 156 + mobile 376 = **532**；迁移后 = protocol-ts 156 + core-ts **339** + mobile **37** = **532**（339 + 37 = 376，即 mobile 原 376 例一分为二：core-ts 得 32 文件/339 例，mobile 留 3 文件/37 例 = `uni.test.ts` 15 + `update.test.ts` 8 + `selfcheck.test.ts` 14）。
- `apps/mobile/src/pages/**` 与 `apps/mobile/src/platform/uni.ts` **零改动**（108 处 `../core/*` 引用全部由 shim 兜住）。
- `types.ts` 的 ` M` 噪声标记已随 `git mv` 消解（迁移前 `git diff --numstat` 为空，零内容丢失）。

### 8.3 Task 3（`apps/node` 壳）

- 新增 `apps/node/`：骨架 3 文件 + `src/version.ts` + `src/db.ts` + `src/host/{http,tls,scheduler,cli,lifecycle}.ts` + `src/routes/{healthz,catalog}.ts` + `src/serve.ts` + `src/main.ts` + `src/smoke.test.ts` + `src/host/http.test.ts`。根 workspaces += `apps/node`。
- SQLite 驱动按决策 5 落 `node-sqlite3-wasm@^0.8.60`（实装 0.8.60）。**ESM/CJS 互操作**（风险 4）实际发生：该包是 CJS，`import { Database }` 在 ESM 下取不到具名导出，改用 default import（`tsconfig` 亦已开 `esModuleInterop` + `allowSyntheticDefaultImports`）。
- `http.ts` 自实现 Go `http.ServeMux` 体例匹配器（字面段 / `{name}` 单段 / `{name...}` 尾段通配 + 具体度优先 + **`GET` 同时匹配 `HEAD`**），未命中 → 404 体 `404 page not found\n` 与 Go 逐字一致。`catalog.ts` 逐行对齐 `internal/httpapi/public.go:41-110`，含 `limit` 默认 200 / 1..1000、`since>=version` 短路、`limit+1` 取页、**next 先于 state/dist_class 过滤**（Go 的既有次序，刻意 bug-for-bug 保留）；SQL 逐字取自 `internal/store/store.go:429-448`（`ListItemsPage`）与 `:625-636`（`LatestPack`）。
- `tls.ts` 实现证书载入 + sha256 DER 指纹 + Base32 无填充 4-4-4-4 配对码 + `verifyPeer`（空名单 fail-closed）+ `nodeKeyMatches`（等长后 `timingSafeEqual`）；`loadOrCreate` 缺证书时**显式抛错**（自签生成留 P3）。`scheduler` / `cli` / `lifecycle` 按 §2.3 实现（立即跑一次 + 周期；无命令/未知命令 → usage + 2；信号逆序停机）。
- **建表 SQL 只在冒烟测试内**（照抄 `internal/store/schema.go:15-26` 的 `items` + 迁移补的 `author_id`/`author_sig`、`:71-80` 的 `packs`），**生产代码零 schema 复制**（P3 才需要节点全库 schema）。
- 验收：`npm run typecheck -w @base/node` 0 错误；`npm test -w @base/node` **2 文件 / 12 用例**全绿，其中冒烟覆盖 `/healthz` 体逐字、空库 `/v1/catalog` 体逐字、未知路由 404 体逐字、只出 `active+public` 且版本取自 `packs`、`since=7` 短路。

### 8.4 Task 4（门禁 G1–G7）

| 门 | 口径 | 实测 |
|---|---|---|
| G1 | 根 `npm test` 全绿 | ✅ **46 文件 / 544 用例**：protocol-ts 9/156、core-ts 32/339、mobile 3/37、node 2/12 |
| G2 | 根 `npm run typecheck` | ✅ protocol-ts / core-ts / node **各 0 错误**；mobile **2** 条（`governance.vue` TS2741、`submit.vue` TS2322，即 `#62` 决策 12 登记的册外既有项，未新增） |
| G3 | core-ts 非测试源码零宿主依赖 | ✅ **导入级零命中**（`from 'node:` / `uni` / `@dcloudio` / `vue` 均 0）。**口径澄清**：按本册原字面 pattern 扫描有 **7 处命中，全部是注释**（`plus.sqlite` / `platform/uni.ts` 的历史说明，分布在 `sync.ts`×3、`sql.ts`、`repo.ts`、`identity.ts`、`platform/adapter.ts`×1）；其中 `platform/adapter.ts` 是**逐字冻结的客户端接口原文**，其注释不可改。故 G3 按**语义**判过（无宿主依赖），而非按字面 pattern 判过 |
| G4 | Node 壳冒烟 | ✅ `/healthz` → 200 体 `{"ok":true,"version":"0.1.0"}\n`；`/v1/catalog` 空库 → 200 体 `{"pack_id":"","content_version":0,"items":[],"next_cursor":null}\n`，均为自动用例 |
| G5 | `vectors/v1/` 13/13 仍由协议核消费 | ✅ 目录 13 个向量文件与 protocol-ts 消费面**一一对应**：`vectors.test.ts` 9（canonical / hash / merkle / ed25519 / manifest / identity / reqsig / release / authorsig）+ `attrs.test.ts` / `progress.test.ts` / `markdown.test.ts` / `aead.test.ts` 各 1；protocol-ts 9 文件 / 156 用例**与 P1 收口时逐字一致**（零回归） |
| G6 | 零 Go 改动 + 禁碰文件不入提交 | ✅ `git diff --stat -- internal/` **无输出**；`git diff --cached --name-only` 中 `.gitignore` / `apps/mobile/src/core/types.ts`（旧路径）/ `internal/httpapi/web.go` / `based-linux-amd64` **零命中** |
| G7 | 发布判断 | ✅ P2 无用户可见改动（`apps/mobile` 行为等价，仅内部包归属变化）⇒ **不做 APK 云打包、不做节点二进制重编部署** |

**回填**：本册 §6 新增风险 7（`TlsAdapter` 边界缺口）；`docs/README.md` 的 `#70` / `#72` 行状态与门禁实况已同步。

### 8.5 已知缺口（如实登记，不粉饰）

1. **`TlsAdapter.serverConfig` / `clientConfig` 无法承载对端指纹**（§6 风险 7）：P2 不阻塞，但 P3 实现双向 TLS 前必须先解决。**本阶段按冻结口径不改边界**。
2. **`host/{tls,scheduler,cli,lifecycle}.ts` 无单测**：P2 的 G4 只要求 `/healthz` + `/v1/catalog` 冒烟，这四个适配器在 P2 **未被任何路由/命令实际使用**（`serve`/`version` 之外的 9 个子命令留 P3、对端监听留 P3）。故只有类型层面的一致性保证，**P3 接线时必须补测**，其中 `verifyPeer` 的 fail-closed 与 `nodeKeyMatches` 的常量时间属**安全不变量**，优先补。
3. **`main.ts` 的 CLI 入口无端到端运行验证**：Node 20.19.6 无内置 TS 运行时，仓库也未装 `tsx`，故入口守卫（`import.meta.url === pathToFileURL(process.argv[1]).href`）只经 `tsc` 校验、未经真实 `node` 跑通。P3 引入运行时（或 `--experimental-strip-types` / `tsx`）时首验此路径。
4. **`parseDecimal` 对超出 `Number.MAX_SAFE_INTEGER` 的 `since` 返回 `null`**，而 Go 的 `ParseInt(_,10,64)` 会接受并命中短路分支 ⇒ 极端入参下与 Go 有分歧（P2 只要求形状同构，且 P5 判据 2 的字节级比对会覆盖此类边界）。
