# P5 并行双跑 → Go 节点退役（任务级计划 #76）

- 日期：2026-10-03
- 上游：总纲 `#69`（§0.13 迁移节奏 = 并行双跑 → 行为等价后 Go 节点退役）；路线计划 `#70`（§1 P5 行、§6 六条等价判据、§8 风险）；P4 设计册 `#74`（**2026-10-03 已定稿，P5 开工闸门已解除**）；P3 各批 = 计划 `#75`（批 A–G 已全收口，判据 2–7 均已各自对拍过）
- 状态：**已收口**（2026-10-03：P5-1 ~ P5-6 全过、G1–G8 逐条通过；线上 `base-cache` 已切 Node 壳、tag `last-go-node`；Go 实现全留、客户端零改动）
- 性质：任务级计划，**不承载契约**。契约一律回册子。

## 0. 一句话

P1–P3 已经把 Node 壳的**面**铺完了（HTTP 无未移植路由、CLI 11 条齐、包导出两侧同一）；P5 不是再写功能，而是**把「Node 能真跑」和「等价有据」这两件事做实**，然后在判据全过后把线上节点从 Go 切到 Node。

## 1. 范围与四条定案（用户 2026-10-03 拍板）

| # | 决策项 | 定案 |
|---|---|---|
| 1 | 双跑拓扑 | **本机全量对拍 → 服务器短时并存**（两段推进；任一段不过即阻塞，不许跳段） |
| 2 | 写入归属 | **Go 权威写 + Node 只读影子**（双跑期 Node 不接生产写；写面等价由 P3 各批 G4 静态对拍承担，不重复引入写风险） |
| 3 | 判据验收方式 | **全量回归（复用 P3 工装）+ 真实流量影子重放**（静态证明「已知面等价」，影子证明「真实面等价」） |
| 4 | 退役处置 | **保留代码、停止部署**（Go 代码与二进制都不删；systemd `ExecStart` 切到 Node，打 tag 标记最后可运行 Go 节点） |

**边界**：本阶段**不改任何 Go 文件**、**不删 Go 实现**、**不切客户端**（APK / 落地页 / `/v1/release` 指向全不动 —— Node 节点对客户端应当完全等价、客户端无感知）。

## 2. 开工前硬阻塞：Node 节点当前**跑不起来**

这是 P5 的第一个必解项，不解决则「并行双跑」无从谈起。

**证据**：

1. [package.json](file:///e:/code/base/apps/node/package.json#L8-L11) 的 `scripts` 只有 `test` / `typecheck`，**没有 `build` / `start`**；`main` 指向 `./src/main.ts`。
2. [main.ts](file:///e:/code/base/apps/node/src/main.ts) 是 TS 源码；Node 20 无 TS 运行时，仓库未装 `tsx` / `ts-node`（`#72 §8.5` 已登记「`main.ts` CLI 入口无端到端运行验证」）。
3. **更隐蔽的一层**：`@base/core-ts` / `@base/protocol-ts` 的 `exports` 把子路径映射到 `./src/*.ts`。即使 `tsc` 编出 JS，产物的 `import '@base/core-ts/xxx'` 仍会解析到 `.ts` ⇒ **单纯编译救不了**，必须**打包**（把 workspace 内的 `.ts` 内联进单文件产物）。

**可用的现成手段**：`esbuild` **已作为传递依赖存在于 `node_modules/esbuild`**（vitest 链路带入），无需新增下载；打包目标 = `apps/node/dist/based-node.mjs`，而根 [.gitignore](file:///e:/code/base/.gitignore#L3) 第 3 行 **`dist/`** 已覆盖该输出目录（逐字核过 ⇒ 产物不会误入提交）。

**不做的事**：不改 workspace 的 `exports` 形状（那会牵动 mobile 的 34 个转发 shim）；不引 `tsx` 之类运行时加载器（部署机上多一层依赖）。

## 3. Task 列表

### Task P5-1　Node 可运行化（**硬门，先做**）

- 用 `esbuild` 把 `apps/node/src/main.ts` 打为**单文件 ESM 产物** `apps/node/dist/based-node.mjs`（`--bundle --platform=node --format=esm --target=node20`）；`node:*` 与 `node-sqlite3-wasm` 列为 **external**（wasm 文件靠 node_modules 解析，不进 bundle）。
- `apps/node/package.json` 增 `build` / `start` 两个 script，并把 `esbuild` **提升为显式 `devDependencies`**（不再依赖传递关系）。
- **首步为探针**：先只打 `version` 一条路径，实跑 `node dist/based-node.mjs version`，确认 ① 打包成功 ② `node-sqlite3-wasm` 能加载 ③ stdout 与 Go `based version` **逐字一致**；探针不过则停下改方案，不许带病推进。
- 验收：`version` 逐字一致；`serve` 能起且 `/healthz` → 200。

### Task P5-2　本机全量对拍回归（静态面）

把 P3 各批的对拍工装**按统一入口重跑一遍**，产出一份**单次全量**报告，而不是各批各自的结论拼贴。

- 汇总范围：批 A（JSON 24 token + 门户页 12 token）、批 B（认证写面）、批 C（`j*` 工装，tokens=63）、批 D（`p*` 工装，tokens=43）、批 E（包与 `merkle_root`）、批 F（开库引导 + **DB 快照**）、批 G（`rg*` 工装，tokens=25）。
- **必须重跑确认的一件事**：批 C 的 DB 快照对称差 4 行、批 D 的 3 行，是批 F 落地**之前**的记录（见 `.tmp/g4/gates.txt:54-62` 与 `prunlog.txt:106-107`）。批 F 已补开库引导等价，**这两笔是否已随批 F 归零，必须在本 Task 用一次全量回归重新取证**，不得直接沿用旧结论。
- 补未覆盖边界：判据 2 的四个门禁头（`Content-Type` / `ETag` / `Cache-Control` / `If-None-Match` 304）、`limit` 边界（1 / 1000 / 1001）、`since` 边界（`since >= version` 短路）。
- 产物：报告留在 `.tmp/`（**不入版本控制**），只把结论回填本册 §8。

### Task P5-3　真实流量影子重放

- 从线上 Go 节点采集**真实请求样本**（方法 + 路径 + 头 + 体 + 响应基线），脱敏后落 `.tmp/`；两侧（Go 与 Node）重放，逐条比 `status` + 头 + body 字节。
- 采集口径按路由分组处理：
  - **匿名读面**（公开读 + 门户页）可直接对线上节点采集响应基线，**限速、只读、样本量小**（不把生产节点当压测目标）。
  - **认证写面**（`requireAuth` / `optionalAuth`）**不在生产节点执行写操作**；判据 3 的真实面只取到「签名域与错误码」这一层（合法签名 / 缺头 / 错签名 / 过期 四类响应），写副作用面的等价仍以 P3 批 B 的静态对拍为准。
- 边界：**全程零生产写操作**；采集期间不动 `base.service` / `base-cache.service`。

### Task P5-4　服务器短时并存（第二段）

在线上服务器起 Node 实例与 Go 生产实例**并存一小段**，一次性、结束即清理。

- 拓扑：**独立端口**（严格避开 443 / 8081 / 8082 / 8083）+ **独立 data 目录** + 该目录内容 = **Go data 目录的只读快照副本**（定案 2：Go 权威写、Node 只读影子）。
- 副本制作方式：用 `VACUUM INTO` 产快照（P3 已实测可用）——Node 侧驱动打不开 WAL，直接拷目录会读到不一致状态。
  **（实况修正）**：线上 `sqlite3` 为 3.26.0、**无 `VACUUM INTO`**（3.27 才引入），改用 `.backup` 点命令（在线备份 API，同为一致快照），见 §8。
- 单元文件沿用 [install.sh](file:///e:/code/base/scripts/install.sh#L129-L132) 的 `EnvironmentFile` + `ExecStart` 体例；**绝不复用 `base.service` / `base-cache.service` 的单元名与端口**。
- 观测项：Node `/healthz`、公开读面与线上 Go 逐条字节比对、`journalctl` 有无错误、常驻内存（wasm 驱动的内存占用要实测）。
- 结束动作：停并删除临时单元、清理独立 data 目录；**线上 Go 生产实例全程不受影响**（这是本 Task 的门禁条件）。

### Task P5-5　判据定案 + 退役

- 把 §6 六条判据 + 批 F 判据 7 的定案证据**逐条**列出（判据 → 由哪个 Task 的哪份证据、过/不过）；**任一不过即阻塞**，不得「先退役再补」。
- 全过后执行定案 4：systemd `ExecStart` 从 `based` 切到 `node dist/based-node.mjs`；打 **git tag 标记最后可运行 Go 节点**；`internal/` / `cmd/` / `web/` 与 `based-linux-amd64` **一律不删**。
- **切换时序（P5-4 实测补充，勿颠倒）**：**先停 Go 单元**（让 WAL 干净收敛、`-wal`/`-shm` 消失）→ **再起 Node 单元**。
  Node 驱动没有 `xShmMap`，对 WAL 库（即使只读）直接打不开；`normalizeJournalMode`（`apps/node/src/host/sqlite.ts:34`）只在
  **主库是 WAL 头且无 `-wal`/`-shm` 兄弟文件**时把头 `(2,2)` → `(1,1)` 完成一次性迁移。若 Go 未正常停止（留有 WAL 兄弟文件），Node 会**拒绝打开并报错**——这是**期望行为**，不要绕过。
- 单元环境变量照 §8「部署前置清单」配齐（含 `BASE_WEB_DIR`、密钥来源）；切换后探活 `/healthz`、`/v1/catalog`、`/`、`/v1/manifest/{pack_id}` 逐条复核。
- 客户端侧**零改动**：APK、落地页、`/v1/release` 指向全部不动；切换后线上探活（`/v1/catalog` / `/` / `/v1/manifest/{pack_id}`）逐条复核。
- **回退路径**：`ExecStart` 切回 `based` 即可，回退成本 = 一次 restart（这正是定案 4 选「保留代码」的理由）。

### Task P5-6　门禁 + 回填 + 提交

跑 §4 门禁 G1–G8，回填本册 §8 执行实况 + §7 判据追溯表，并同步 `docs/README.md`（`#70` 行状态 + `#76` 行登记），只 add 本册相关文件后提交。

## 4. 门禁 G1–G8

| # | 门禁 | 口径 |
|---|---|---|
| G1 | Go 侧全绿 | `go build ./... && go vet ./... && go test ./...` |
| G2 | TS 类型 | `npx tsc --noEmit` 全 0 错误 |
| G3 | 单测守恒 | `apps/node` 与 `packages/core-ts` vitest 全绿；mobile 用例数**不减少** |
| G4 | **全量对拍 0 分歧** | P5-2 的单次全量报告：HTTP 分歧 0 条 **且** DB 快照集合对称差 0 行（含批 C/批 D 旧差异的归零复核） |
| G5 | **影子重放 0 分歧** | P5-3：真实流量样本逐条 status + 头 + body 字节一致 |
| G6 | 并存无回归 | P5-4：Node 实例正常、且**线上 Go 生产实例零影响**（探活无回归、日志无异常） |
| G7 | **判据全过** | §7 追溯表逐条「过」；任一「不过」即阻塞退役 |
| G8 | 仓库纪律 | `git diff --stat -- internal/` 为空；只 add 本册相关文件（**绝不** add `.tmp/`、`based-linux-amd64`、`.gitignore`、`internal/httpapi/web.go`） |

## 5. 判据追溯表（§6 六条 + 批 F 判据 7 → 由谁定案）

| # | 判据（`#70 §6` 原文口径） | 定案 Task | 证据 | 判定 |
|---|---|---|---|---|
| 1 | `vectors/v1/` **全部**向量在核包内通过 | P5-2 | vitest 向量全绿（P1 起即为 13/13，本阶段回归确认） | **过** |
| 2 | 公开读接口响应体**字节级**一致（含 4 个门禁头与 304 语义） | P5-2 + P5-3 | 静态对拍（EB 批 39 令牌含 ETag/304 边界）+ 线上真实样本 47 条 0 分歧；P5-4 再以**真库快照**在服务器上对拍 22 条 0 分歧 | **过** |
| 3 | 认证写接口签名域与错误码语义一致（`X-Base-*` 五头） | P5-2（+ P5-3 弱证据） | 静态对拍为主（批 B 40 令牌）；真实面只到错误码层（5 类已取到，**未取得合法签名的真实写请求**） | **过（弱证据）** |
| 4 | `sync` / `fetch` / `event-sync` 结果集一致且**只增不减** | P5-2 + 双影子对练 | 批 D 工装重跑（tokens=43，0 分歧）；真实运行态：Node↔Go 互为对端跑通 `importPack`（`imported=true`、只增不减）与多轮 `RoundResult`/`event_sync`（§8） | **过** |
| 5 | `proposal` 列表 / 票数 / 门槛（含小节点豁免）逐条一致 | P5-2 | 批 C 工装重跑（tokens=63，0 分歧；DB 对称差 0） | **过** |
| 6 | 同一数据集导出包 **`pack_id` 与 `merkle_root` 同一** | P5-2 | 批 E 证据（含真实视频块的非平凡 merkle） | **过** |
| 7 | 开库引导等价（批 F 追加，`#75 §8` 边界项） | P5-2 | 开库后 **DB 快照对称差归零**（批 C 141 / 批 D 27 / 批 G 3×3 / EB 13 逐批 0） | **过** |

**残留风险（原登记 → 已补验，见下）**：P5-4 的线上影子是**只读影子**（不配 `BASE_PEERS` / `BASE_PEER_ADDR`），
故 Node 的「**权威写 + 对端监听 + 反熵/scrub 调度 + TLS 身份**」这一整套运行态当时**尚未在任何真实环境跑过**。

**补验结果（2026-10-03「双影子对练」，实况见 §8）**：该运行态已在服务器上与**真实 Go 节点互为对端**跑通
（①门户身份 ②mTLS 指纹固定 + 反熵 ③权威写/`importPack` ④scrub ⑤生产零影响，五段全过），
并据此挖出并修复 **GAP-C**（出站反熵约半数轮次失败）。补验后残留：

1. 出站指纹校验在 `rejectUnauthorized:false` 下 `checkServerIdentity` **不生效**，唯一校验点是**响应后**对
   `res.socket.getPeerCertificate().raw` 的复核 ⇒ 依赖「每次连接都传证书」；**GAP-C 已通过禁用 TLS 会话复用保证**。
2. **GAP-B → 已修（= #77）**：身份加载判定与 Go 不一致，另挖出主监听从不 TLS / 对端监听不校验证书两处，已由 `#77`「节点 TLS 身份面收敛」三层全修并线上复验（详见 §8）。

## 6. 风险与回退

| # | 风险 | 处置 |
|---|---|---|
| 1 | 打包后 `node-sqlite3-wasm` 的 wasm 定位失败（bundle 改变 `__dirname` 语义） | 列 external、留 node_modules 解析；**P5-1 首步探针先验**，不过即改方案 |
| 2 | 真实认证写流量采集不到（无用户配合 / 不可重放签名） | 降级为构造签名请求的双向对拍（P3 批 B 已做），并**在 §7 把判据 3 标为弱证据**，不假装是强证据 |
| 3 | 采集线上样本把生产节点当压力源 | 限速 + 只读 + 小样本；只采匿名面响应基线 |
| 4 | Node 直读 Go data 目录读到 WAL 不一致状态 | 用 `VACUUM INTO` 产快照副本（P3 已实测可用），不做目录直拷 |
| 5 | 双跑实例占资源 / 端口冲突 / 单元名撞车 | 独立端口 + 独立目录 + 独立单元名 + **一次性运行结束即清理** |
| 6 | 退役后才发现某判据不过 | 定案 4「保留代码、停止部署」本身就是回退路径；`ExecStart` 切回 `based` 一次 restart 即恢复 |
| 7 | （P5-4 实测新发现）线上服务器无 Node 运行时 | **已解**：官方 `node-v20.20.2-linux-x64.tar.xz` 解到隔离目录 `/opt/base-node`（不动系统目录、不装包管理器；卸载 = `rm -rf`） |
| 8 | （P5-4 实测新发现）门户模板路径 `TPL_DIR` 按**源码层级**算，产物落到 `apps/node/dist` 后少一层 → 门户三页 500 | **已定案并落地（方案 ②）**：`portal.ts` 增 `BASE_WEB_DIR` 环境变量覆盖，缺省回退原相对路径（源码模式行为不变）。G2（`@base/node` 0 错）/ G3（node 550 + core-ts 412 + protocol-ts 156 全绿）已复跑，重打包后线上复验 0 分歧 |

## 7. 不做

- **不删 Go 实现**（`internal/` / `cmd/` / `web/` / `based-linux-amd64` 全留 —— 定案 4）。
- 不改任何 Go 文件；不改内容包规范 v1；不 bump `schema_version`。
- **不切客户端**（APK 不动、落地页与 `/v1/release` 指向不动、`min_version` 不动）。
- 不在生产节点执行任何写操作。
- 不做 P6（融合治理实现轨）。
- 不改 `#72` 已冻结的 `Adapters` / `ServerAdapters` 边界。
- 不为兼容复制双份核心；不做 iOS。

## 8. 执行实况

### Task P5-1　Node 可运行化 —— **已收口**

- `apps/node/package.json` 增 `build` / `start` 两个 script；`esbuild@0.20.2` 提升为显式 `devDependencies`
  （同步 `package-lock.json` 的 `apps/node` 条目）；产物 `apps/node/dist/based-node.mjs`
  （`--bundle --platform=node --format=esm --target=node20`，`node:*` 与 `node-sqlite3-wasm` 列 external）。
- `dist/` 已被根 `.gitignore:3` 覆盖（逐字核过，产物不入提交）。
- **探针结论（硬门过）**：
  - `node apps/node/dist/based-node.mjs version` 与 `go run ./cmd/based version` **stdout 逐字一致**；
  - `serve` 能起：`/healthz` → 200、`/v1/catalog` → 200；`node-sqlite3-wasm` 在 bundle 后定位正常（风险 1 未触发）。
- 提交：`138e9b8`（已 push）。

### Task P5-2　本机全量对拍回归 —— **已收口（G4 过）**

- **单次全量报告**：`.tmp/g4/P5REPORT.md`（不入版本控制）；原始输出 `.tmp/g4/p5p2-rerun.txt`
  （批 B/C/D/G/E + 新增边界批 EB 的同一次顺序重跑）；边界批明细 `.tmp/g4/EBREPORT.md`。
- **批 C / 批 D 旧 DB 差异归零复核（本 Task 指定必做项）**：**两笔均已归零**
  （批 C 141 行 0 对称差、批 D 27 行 0 对称差）。
  - 旧记录：`gates.txt:54-57`（批 C 对称差 4 行，`goLines=141 nodeLines=139`）、
    `prunlog.txt:108-112`（批 D 对称差 3 行：`directory_terms|tag|x`、`meta|directory_seeded`、`meta|directory_version`）。
  - **根因 = 工装不对称，非 Node 实现缺口**：Go 侧探针走 `store.Open`（`internal/store/store.go:123`，引导段含
    `schema → migrate → seedDirectoryFromExisting`，`store.go:165` / `directory.go:304`），而 P3 各批 Node 侧探针
    原用裸 `openHostDb`/`openDb`，跳过了引导段。Node 侧**本就有**生产等价实现
    （`apps/node/src/store/store.ts:472` `bootstrapStoreDb` / `:488` `openBootstrapDb`，生产 `main.ts:92` 在用）。
  - **矫正**：4 个 Node 探针改为生产同口径（`jcprobe`/`rg-node`/`nodeprobe` → `openBootstrapDb`；
    `pnode` → `openHostDb` + `bootstrapStoreDb`）。**未改任何 `apps/node/src/**` 或 `internal/**` 生产代码**。
- **补未覆盖边界（判据 2）**：新增边界批 **EB**（39 令牌，0 分歧，DB 快照 13 行 0 对称差）：
  - `GET|HEAD /v1/blob/{blob_id}`：`ETag` / `Cache-Control: public, max-age=31536000, immutable` /
    `Content-Type: application/octet-stream` / `If-None-Match` 命中 → **304 空体**（不命中、不带引号、列表形态 → 200）/
    `HasBlob` 双重判定（只有库行无文件 → 404）/ 非法 id → 400 / 不存在 → 404；
  - `GET /v1/catalog`：`limit` = `1|1000|1001|0|-1|abc|+5|' 5'`；
    `since` = `version`（短路空）| `version+1` | `version-1` | `abc` | `-1` | `+version` | 空串；`cursor` 到末条；
  - 匿名读抽样：`/healthz`、`/v1/pubkey`、`/v1/directory`（默认 / version 命中短路 / version 落后 / version 非法）、
    `/v1/manifest/{pack_id}`（200/404/400）、`/v1/identity/{id}`（200/404）。
- **工装修正 2 处（均工具不对称，非行为差异）**：
  1. `ebgoprobe` 补 `Options.Version = "0.1.0"`（生产 `cmd/based/main.go:8` 同值），否则 `/healthz` 版本号 `0.1.0` vs `""`；
  2. `HEAD` 令牌 body 标 `n/a(HEAD)`：真 server 两侧都丢弃 HEAD 响应体（Go `net/http`、Node `_http_server`），
     但沙箱里 Go 侧走 `httptest.NewRecorder`，Recorder 不模拟该剥离（与各批不比对 `Content-Length` 同类的工具限制）。
- **G4 判定：过** —— HTTP 分歧 **0 / 210 令牌**（B 40 + C 63 + D 43 + G 25 + EB 39）；
  DB 快照集合对称差 **0 行**（C 141 / D 27 / G 3×3 / EB 13 逐批 0）。
- **批 A 说明**：批 A 的临时取证件已按 P3 计划 `#75 §9.1 G6` 计划内清理删除，其公开读面（24 + 12）结论沿用
  `#75 §9.2`；本次 EB 批已补上 `#75` 未覆盖的判据 2 边界项并抽样重跑了匿名读 JSON 面（未含门户 HTML 页）。

### Task P5-3　真实流量影子重放 —— **已收口（G5 过）**

- **报告**：`.tmp/g4/LCREPORT.md`（不入版本控制）；基线 `lclive.json`、回放 `lcgo-results.json` / `lcnode-results.json`。
- **线上节点**：`http://118.190.217.242`（明文 HTTP，nginx/1.24.0 反代，**只读分发节点**）。
- **G5 判定：过 —— 真实流量样本 47 条，0 分歧**：

  | 组 | 含义 | 条数 | 分歧 | 比较口径 |
  |---|---|---|---|---|
  | D | 数据无关（健康检查/CORS/未知路由/鉴权拒绝/格式门禁） | 25 | 0 | 三方逐字节（status + 5 应用头 + body） |
  | V | 线上逐字件（`release.json` / `manifest.json` 原文） | 2 | 0 | 同上 |
  | C | 线上读面数据行（catalog / directory / contributors） | 12 | 0 | 同上 |
  | S | 节点身份 / 真实时间戳相关（门户页 + 评论面 + 身份 GET） | 6 | 0 | status + content-type + 归一化 body |
  | G | 会落 `auth_nonces` 行 → **不在生产执行** | 2 | 0 | 仅本地 go↔node |

- **判据 3 的真实面（错误码层）已取到 5 类**（用线上真实身份 `5c7ca272008f23910fc92d2db8d1a949` 构造签名头）：
  - `auth_missing_header`(400)（D12–D18）、`identity_alg_unsupported` / `identity_id_invalid` / `auth_ts_invalid` /
    `auth_nonce_invalid` / `auth_sig_invalid`(400)（D19–D23）、`identity_unregistered`(403，查库只读)（D24）、
    `auth_ts_out_of_window`(401)（D25）、`auth_nonce_replay`(401，仅本机)（G02）。
  - **未取得**「合法签名的真实写请求」（线上无可用身份私钥）→ 判据 3 仍以 P5-2 批 B 静态对拍为主，本项只作**弱证据**。
- **零生产写的取证**：线上只发 GET / HEAD；3 条 POST / PUT（D13–D18 缺头、D19–D23 格式非法、D24 未登记、D25 过期）
  全部在 [authmw.go](file:///e:/code/base/internal/httpapi/authmw.go#L144-L235) 的**第 1..4 步**被拒，
  早于第 5 步 `UseNonce` 落库 ⇒ 未进任何 handler、未写任何表。会走到第 5/6 步的令牌划入 G 组**只在本机跑**。
- **影子数据集重建**（`lcbuild.probe.ts`）：按线上真实输出重建而非降级为结构锚点 ——
  `release.json` / `manifest.json` 取线上原文落盘（verbatim 文件路由），items 9 行 / articles 行取自线上
  `/v1/catalog` 与公开包 `/v1/pack/{pack_id}` 的 `pack.sqlite`，directory 词条 1 行 + `meta.directory_seeded=1`
  短路 `seedDirectoryFromExisting`，identities 取线上真实 actor（pubkey 用占位，两侧均不验签通过）。
- **证据强度三级（报告 §5 已明标）**：
  - **强**：D / V / C 三组与线上**逐字节**一致；
  - **中**：S01 `/` 与 S03 `/a/{item_id}` 在**置空节点身份行**（配对码/指纹行 + issuer 页脚行）后逐字节一致
    （线上/影子节点私有身份本就不可能相同）；
  - **弱**：S04 / S05 `/v1/comment`、S06 `/v1/identity/{actor}` 只比 status + content-type + JSON 顶层键集合；
    S02 `/governance` 只比**页面壳**（其看板正文来自线上治理状态，非匿名读面，影子不重建）。
- **组内一致性（不受数据边界影响）**：**本地 Go ↔ 本地 Node 在全部 47 条上逐字节一致**（含 S 组 HTML 全文，未做任何归一化）。
- **工装**（`lccollect.mjs` 采集 / `lcbuild.probe.ts` 建影子集 / `lcgoprobe` + `lcnode.probe.ts` 回放 / `lccompare.mjs` 比对）；
  沙箱内 Go 侧走 `httptest.NewRecorder` 进程内分发，Node 侧起真 `http` server，`HEAD` 只比 status + 5 头。
- **边界**：全程未触碰 `base.service` / `base-cache.service`；不把生产节点当压测目标（限速 160ms/次）；
  线上 `/v1/pubkey` 返回 404（只读分发节点无签名密钥），本地两侧已按同口径对齐。
- **注**：线上无 SSH 部署信息（仓库 `scripts/install.sh` 仅客户端脚本），P5-4 的服务器访问可用性待确认。

### Task P5-4　服务器短时并存 —— **已收口（G6 过）**

- **拓扑**：线上服务器起 Node 实例与 Go 生产实例**短时并存**，结束即清理。
  - 运行时：官方 `node-v20.20.2-linux-x64.tar.xz` → **隔离目录 `/opt/base-node`**（服务器原本无 node/npm/nvm/docker；不动系统目录）。
  - 端口：影子 `127.0.0.1:8090`（避开 443/8081/8082/8083/80/8080）；独立 data 目录 `/opt/base-node-shadow/data`。
  - 单元：**瞬态单元** `base-node-shadow`（`systemd-run --unit=... --collect`，即「独立单元名 + 停止即自动清理」）。
  - 只读影子：**不配 `BASE_PEERS` / `-peer-addr`** ⇒ 不起对端监听、不启反熵/scrub、不接任何写（定案 2）。
- **快照**：源 = `/opt/base-cache/data`（nginx `:80` 上游 = 公网读面真实来源）。
  服务器 `sqlite3` 仅 **3.26.0**、**不支持 `VACUUM INTO`**（3.27 才引入）⇒ 改用 `.backup` 点命令（SQLite 在线备份 API，同为一致快照），已产无 `-wal`/`-shm` 兄弟文件的主库。
  文件件 `blobs/` `packs/` `release.json` 用 `cp -a`；并把 `packs.dir` 改指影子路径（自包含，不读生产文件）。
- **对拍口径**：`127.0.0.1:8083`（Go 生产缓存节点）↔ `127.0.0.1:8090`（Node 影子）**都是源站**（不经过 nginx）
  ⇒ 可比**完整头集**（剔除 hop-by-hop / 框架头：`Date`/`Connection`/`Keep-Alive`/`Transfer-Encoding`/`Content-Length`）+ status + **body 字节**。
- **G6 判定：过 —— 22 条令牌，19 条直接 MATCH，余 3 条门户页归一化后 MATCH**：

  | 类别 | 条数 | 结果 |
  |---|---|---|
  | 公开读 JSON 面（healthz/release/pubkey/catalog×4/directory×3/contributors/manifest×3/pack/identity/blob/unknown-route） | 19 | **MATCH**（status + 应用头排序后 + body 字节全等） |
  | 门户 HTML 页（`/`、`/governance`、`/a/{item}`） | 3 | 应用头 MATCH；body 归一化（剔除节点私有身份行）后 **MATCH**，页脚 issuer 逐字相同 |

- **P5-1 未覆盖缺口（本 Task 暴露 → 已定案修复）**：门户模板 `TPL_DIR = new URL("../../../../web/templates/", import.meta.url)`
  按**源码层级**（`apps/node/src/routes/`）计算；打包到 `apps/node/dist/based-node.mjs` 后**少一层** ⇒ 解析成 `/web/templates/base.html` ⇒ 门户三页 **500**。
  P5-1 探针只验了 `version`/`/healthz`/`/v1/catalog`，未覆盖门户页，故当时未暴露。
  - 取证一（不改代码）：布局对齐（产物放到「下 4 层即含 `web/` 的根」）⇒ 门户三页回 200 且归一化后逐字节一致；
  - **定案（方案 ②，已落地）**：`apps/node/src/routes/portal.ts` 增 `BASE_WEB_DIR` 环境变量覆盖，**缺省回退原相对路径**（源码/测试模式行为不变）。
    复跑 G2（`@base/node` 0 错；`apps/mobile` 2 个既有错与本改无关）+ G3（node 550 / core-ts 412 / protocol-ts 156 全绿）→ 重新 esbuild 打包 →
    线上以 `BASE_WEB_DIR=/opt/base-node/web/templates`、产物置于**常规路径**（不再依赖布局 hack）复验：**22 条 0 分歧**（19 直接 MATCH + 3 门户页归一化后 MATCH）。
- **两个部署前置（本次实测）**：
  1. **store 密钥**：密钥是 **data 目录的兄弟文件** `<data>.key`（`serve.ts:99` → `loadStoreKey(dataDir)`）。
     影子初始缺失 ⇒ Node **自造了一把新钥**，解不开生产密文 ⇒ `/v1/contributors` 与门户页 **500**（`aes/gcm: invalid ghash tag`）。
     处置：`BASE_STORE_KEY_FILE=/opt/base-cache/data.key`（**指向生产密钥，不复制密件**），并删掉自造的 `data.key`。
  2. **`node-sqlite3-wasm`**：打包列为 external ⇒ 部署目录需带该包（`node_modules/node-sqlite3-wasm`，含 `.wasm`），否则驱动加载失败。
- **节点私有身份的边界（与 P5-3 S 组同口径）**：Go 门户页第 44 行渲染 `配对码 + TLS 指纹`，影子为空（只读影子未加载 TLS 身份）。
  **证据**：生产证书 `data/tls/node.crt` 的 SHA256 指纹 = `96de4640…745e`，与 Go 页面显示的指纹**逐字相同**
  ⇒ 该身份块派生自 TLS 证书（影子未配 peer 监听故未加载），属**配置差异、非实现缺口**；归一化剔除该行后 body 逐字节一致。
- **观测**：影子常驻内存 **RSS ≈ 119 MB**；`journalctl -u base-node-shadow -p warning` **无条目**；`listening 127.0.0.1:8090`。
- **门禁条件（线上 Go 生产实例全程零影响）**：并存期间 `base` / `base-cache` 均 **active**；
  公网 `http://118.190.217.242/` 与 `/v1/release`、`/v1/catalog` 均 **200**；未触碰任何生产单元与文件。
- **清理**：单元已停且消失（瞬态 + `--collect`）、`/opt/base-node-shadow` 已 `rm -rf`、端口 8090 已释放；
  **保留** `/opt/base-node`（运行时，167 MB，供 P5-5 退役使用）。
- **工装**（`.tmp/g4/`，不入版本控制）：`p54_snapshot.sh`（快照）、`p54_compare.sh`（22 条逐条对拍）、`p54_compare_html.sh`（门户页归一化对拍）。
- **部署前置清单（P5-5 退役单元直接照用，本次已实测有效）**：
  - 运行时：`/opt/base-node/bin/node`（v20.20.2，隔离目录，已就位）。
  - 产物：`apps/node/dist/based-node.mjs`（**路径无层级要求**，靠 env 定位模板）；Node 包内 `node_modules/node-sqlite3-wasm/`（含 `.wasm`）随产物部署。
  - 模板：`web/templates/` 随产物部署，`BASE_WEB_DIR` 指向它（绝对路径）。
  - 环境变量：`BASE_DATA` / `BASE_DB` / `BASE_ADDR` / `BASE_ISSUER` / `BASE_TLS_CERT`（`off` 或证书路径）/ `BASE_STORE_KEY_FILE` 或 `<data>.key`（**密钥必须与所接管的库匹配，否则密文解不开**）。
  - 只读影子额外约束：不配 `BASE_PEERS` / `BASE_PEER_ADDR`（正因如此影子不加载 TLS 身份、门户页身份行为空，属**预期**差异）。

### Task P5-5　判据定案 + 退役

#### P5-5 前置补验：服务器「双影子对练」（2026-10-03）—— **已通过**

- **目的**：补验 §5 残留风险所指的运行态 ——「权威写 + 对端监听 + 反熵/scrub 调度 + TLS 身份」（P5-4 只读影子未覆盖）。
- **拓扑**：同机**双影子并存、互为对端**；瞬态单元 `p5-go-shadow` / `p5-node-shadow`（`systemd-run --collect`）。
  - Go 影子 `/opt/p5-shadow-go`：快照源 = `/opt/base/data`（源节点）；主监听 `127.0.0.1:8093`、对端监听 `127.0.0.1:8091`；
    GoFP=`eed8fb64a566b4024f0e9075a71386ac5388af4243836ff30bc3c33f7612356c`、GoPC=`53MP-WZFF-M22A-ETYO`。
  - Node 影子 `/opt/p5-shadow-node`：快照源 = `/opt/base-cache/data`（缓存节点）；主监听 `127.0.0.1:8094`、对端监听 `127.0.0.1:8092`；
    `BASE_TLS_CERT=off`；NodeFP=`521e1d853d263bccda5ee57ae23a805e1217747f86e9c9841ed54529402f8d66`、NodePC=`KIPB-3BJ5-EY54-ZWS6`。
  - 快照口径同 P5-4：`sqlite3 .backup`（服务器无 `VACUUM INTO`）+ `cp -a blobs/packs/release.json` + 改写 `packs.dir` + 连带 `<data>.key`。
- **五段结论（全过）**：

  | 段 | 验证点 | 结果 |
  |---|---|---|
  | ① | 门户页身份（GAP-A 修复的线上实证） | 各显示**自身**配对码/指纹（Go 页 `53MP-WZFF-M22A-ETYO` / `eed8fb64a566…`；Node 页 `KIPB-3BJ5-EY54-ZWS6` / `521e1d853d26…`）→ **PASS** |
  | ② | 对端监听 + 双向 TLS 指纹固定 | 正例（用 Node 指纹连 Go 的 `:8092`）exit=0；**反例**（故意错指纹）→ `tls_fingerprint_mismatch: 对端指纹 … 不在白名单` exit=1（fail-closed）；Node→Go 出站调度产生完整 `RoundResult` 与 `event_sync events=36 tombstones=0` → **PASS** |
  | ③ | 权威写 + `importPack` | Go 影子 `import-video`（2.5 MiB / 3 块）→ `export` 出 `pack_id=f7d832fe4b29c1ad7aff2ebd6e230a74 cv=4`；Node 影子自动 `imported=true equal=false missing=3 extra=3 fetched=3`，落 `cv=4 packs=4 blobs=11`，新包目录 `manifest.json`+`pack.sqlite` 就位 → **PASS** |
  | ④ | scrub（本地校验修复） | 干净轮 `checked=11 repaired=0 dropped=0 unrepaired=0`；注入坏块后 `checked=10 repaired=1 dropped=1 unrepaired=0` 且文件恢复 524316 字节 → **PASS** |
  | ⑤ | 生产零影响 | `base` / `base-cache` 均 active、`ActiveEnterTimestamp=Thu 2026-10-01 23:52:10 CST` **未变**；nginx 与公网 `/`、`/v1/catalog`、`/v1/release` 全 200 → **PASS** |

- **预期值修正（非缺陷）**：Node 影子（base-cache 快照）比 Go 影子（base 快照）**多 3 个块**，故 `extra=3` / `no_replica=3`、
  merkle **永不相等** —— 两侧数据集不同源，在「只增不减」语义下这是**期望行为**，不是实现差异。

- **GAP-A（门户页身份证恒为空）—— 已修**
  - 根因：`main.ts` 的 TLS 身份 `info` 在 `startServer` **之后**才加载，门户页拿到的 `opts.fingerprintHex`/`pairingCode` 恒为空。
  - 修复：把 `info` 加载**移到 `startServer` 之前**并注入 `opts`（对齐 `serve.go:63-76`）；**判定条件保持不动**（避免牵出 GAP-B）。
  - 线上实证：见上表 ①。

- **GAP-C（出站反熵约半数轮次失败）—— 已修**
  - 症状：`peersync: https://127.0.0.1:8091 事件同步失败: POST /v1/event-sync: Error: tls_fingerprint_mismatch: 对端未提供证书` + 「本轮失败」。
  - 根因（已实证）：`peersync/peer.ts` 在**响应到达后**用 `res.socket.getPeerCertificate().raw` 复核对端 DER 指纹；
    Node `https.globalAgent` 默认 `maxCachedSessions:100` ⇒ **TLS 会话复用（abbreviated handshake）时对端不再传证书** ⇒ `raw` 为空
    ⇒ `verifyPinned` 抛「对端未提供证书」整轮中止。**fail-closed，故为可用性缺陷而非安全漏洞**。
    Go 侧 `tls.Config.ClientSessionCache` 默认 `nil` ⇒ **从不复用会话** ⇒ 无此问题。
  - 探针证据：v1（每请求后 `destroy()`）6/6 成功 `raw len=474` 且 `checkServerIdentity` **从未被调用**
    （证明 `rejectUnauthorized:false` 下它不生效）；v2（keep-alive，16s 间隔）**#8–#12 全部 `rawLen=0`**（新 socket + 会话复用）。
  - 修复：`tlsTransport` 改用自带 `new https.Agent({ keepAlive: true, maxCachedSessions: 0 })`（对齐 Go 语义：每次全握手、证书必在）。
  - 复验：重打包上线后连续 **11 轮**（180 s，间隔 15 s）**0 次**「对端未提供证书」、**0 次**「本轮失败」（修复前约半数轮次失败）。

- **GAP-B（身份加载判定与 Go 不一致）—— 已修（= #77）**
  - 当时取证：Go（`serve.go:61-76`）加载身份 ⟺ `tls-cert ≠ off` **或** `-peer-addr` 非空；Node（`main.ts:91-94`）⟺ `-peer-addr` 非空 **或** `-peers` 非空。两处分歧：① `tls-cert≠off` 且无 `-peer-addr`/`-peers` → Go 加载、Node 不加载（Node 主监听将丢失 TLS 身份）；② `-peers` 非空但无 `-peer-addr` 且 `tls-cert=off` → Node 加载、Go 不加载。
  - **`#77` 处置（2026-10-03，已收口）**：三层全修 —— **B-① 加载判定**改三因子并集（`!isTlsOff(tlsCert) || peerAddr !== "" || peerCount > 0`，超集语义，**不复制** Go 漏判 `-peers` 的缺陷；分歧 ② 一格 Node 加载为**刻意**）、**B-② 主监听 TLS 接线**（`tls-cert` 非 `off` 时传 `opts.tls = serverConfig(info, [])`，分歧 ① 已消）、**B-③ 对端监听 mTLS 指纹固定**（`requestCert:true` + `secureConnection` 钩子 fail-closed）。
  - 复验：本机 G 向三格（`openssl s_client`）+ B-① 五格矩阵；线上 `base-cache` 部署后三格 fail-closed 成立（无证书拒绝 / `base` 证书通过 / 自身证书拒绝）、`base`（Go）反熵零失败。详见 `#77` 册 §7。

- **工装**（`.tmp/g4/`，不入版本控制；服务器 `/root/`）：`p55_setup.sh`（快照 + 证书 + 环境 + 起双影子）、
  `p55_verify.sh`（五段验证）、`p55_tlsprobe.mjs`（只读取证探针）、`p55_c_verify.sh`（GAP-C 复验）。

#### P5-5 退役实况 —— **已收口**

- **落点**：**只切 `base-cache` 单元**（nginx `:80` 的真实上游 = `127.0.0.1:8083`）；`base` 单元（源节点）继续跑 Go。
- **切换时序（照 §3 未颠倒）**：**先停 Go**（`systemctl stop base-cache`）→ **再起 Node**。
  Go 停止后 WAL **干净收敛**：`base.db-wal` / `-shm` 消失，只剩 `base.db` ⇒ 未触发 Node「拒绝打开」分支，**无需手工 checkpoint**。
- **单元改动**：
  - `ExecStart` 由 `/opt/base/based serve -peer-addr 127.0.0.1:8082 -peers '<json>' -issuer-pubkeys '<json>'`
    改为 `/opt/base-cache/run-node.sh` —— bash wrapper：先 `export BASE_PEERS` / `BASE_ISSUER_PUBKEYS`（**单引号字面量**）
    再 `exec /opt/base-node/bin/node /opt/base-node/based-node.mjs serve`。
    原因：Node `serve` **只读 env、不解析 flag**，而 systemd `EnvironmentFile` 会剥值中引号 ⇒ JSON 不能进 env 文件。
  - `EnvironmentFile` 保持 `/opt/base-cache/base.env`，追加 4 项：`BASE_DB=/opt/base-cache/data/base.db`、
    `BASE_PEER_ADDR=127.0.0.1:8082`、`BASE_STORE_KEY_FILE=/opt/base-cache/data.key`、`BASE_WEB_DIR=/opt/base-node/web/templates`。
    （`BASE_ADDR` / `BASE_DATA` / `BASE_ISSUER` / `BASE_TLS_CERT=off` / `BASE_SYNC_INTERVAL=5m` / `BASE_SCRUB_INTERVAL=24h` 原样沿用。）
- **备份（回退用）**：`/root/base-cache.service.bak-20261003-090413`、`/root/base-cache.env.bak-20261003-090413`。
- **启动日志**（Node base-cache）：`listening 127.0.0.1:8083`；`based 对端接口监听 127.0.0.1:8082（双向 TLS + 指纹固定，白名单 1 个）`；
  `反熵调度已启动（1 个对端，间隔 5m0s）`；`scrub 调度已启动（间隔 24h0m0s，首轮延迟 10 分钟）`。
- **证书零改动（关键不变量）**：`BASE_TLS_CERT=off` ⇒ `resolveTlsMaterial` 落回默认路径 `<data>/tls/node.{crt,key}` —— 正是**退役前那张证书**；
  Node **复用不重签** ⇒ 指纹仍 `96de46405be76287c0f89c59a09905507ead8c789e2ef0260e0c710ff1c1745e`，与 `base` 单元 `-peers` 白名单**逐字相同** ⇒ 节点间 mTLS 不断链。
  - 佐证（GAP-A 的生产实证）：`:8083` 门户页显示 `节点配对码 S3PE-MQC3-45RI-PQHY · 指纹 96de46405be76287c0f89c59a09905507ead8c789e2ef0260e0c710ff1c1745e`。
- **切换后首轮反熵即成功**（Node base-cache ← Go base `https://127.0.0.1:8081`）：
  `peer=https://127.0.0.1:8081 version=3 pack= imported=false equal=false missing=0 extra=3 fetched=0 bad_frames=0 no_replica=3`，耗时 `100ms`；
  近 3 分钟计数 `对端未提供证书=0`、`本轮失败=0`。
- **探活（全 200）**：
  - 直连 `127.0.0.1:8083`：`/healthz` `/v1/catalog` `/` `/v1/release` `/v1/manifest/dd8feadc113331bc233641bb7ba36067` `/v1/directory`；
  - 经 nginx `127.0.0.1:80`：`/healthz` `/v1/catalog` `/` `/v1/release` `/v1/manifest/{pack_id}`；
  - 公网 `http://118.190.217.242`：`/` `/v1/catalog` `/v1/release` `/v1/manifest/{pack_id}`。
- **客户端零改动**：APK / 落地页 / `/v1/release` 指向全未动；`base`（Go 源节点）全程 `active`。
- **tag**：`last-go-node`（退役前最后一版，已 push）。
- **回退路径**：`ExecStart` 切回 `/opt/base/based serve -peer-addr 127.0.0.1:8082 -peers '…' -issuer-pubkeys '…'`（备份在 `/root/`）
  → `systemctl daemon-reload && systemctl restart base-cache`。

#### 影子清理 —— **已完成**

- `p5-go-shadow` / `p5-node-shadow` 已停；瞬态单元由 `--collect` 自动回收（`systemctl list-unit-files 'p5-*'` → 0 条）。
- `rm -rf /opt/p5-shadow-go /opt/p5-shadow-node`、`rm -f /opt/p5-shadow-fp.env`、`rm -f /root/p55_*`（工装 + 日志 + 前述备份保留）。
- **保留** `/opt/base-node`（运行时 + 产物 + 模板 + `node-sqlite3-wasm`，169 MB）—— 线上 `base-cache` 正在使用。

### Task P5-6　门禁 G1–G8 + 回填 + 提交 —— **已收口**

| # | 门禁 | 结果 |
|---|---|---|
| G1 | Go 侧全绿 | `go build ./...` / `go vet ./...` 0 错；`go test ./...` 全 `ok`（`cmd/based` + `internal` 7 包 + `tools`）→ **过** |
| G2 | TS 类型 | `@base/protocol-ts` / `@base/core-ts` / `@base/node` 各 **0 错**；**`apps/mobile` 2 条既有 `.vue` 错**（`governance.vue` 缺 `directory_add`、`submit.vue` 类型联合），册外既有、与 P5 无关 → **过（既有例外）** |
| G3 | 单测守恒 | `@base/node` **550/550**、`@base/core-ts` **412/412**、`@base/protocol-ts` **156/156** 全绿；本阶段未动 mobile，用例未减 → **过** |
| G4 | 全量对拍 0 分歧 | P5-2 单次全量：HTTP **0/210 令牌**、DB 快照对称差 **0 行** → **过** |
| G5 | 影子重放 0 分歧 | P5-3：真实流量 **47 条 0 分歧** → **过** |
| G6 | 并存无回归 | P5-4：**22 条 0 分歧**（19 直接 MATCH + 3 门户归一化后 MATCH），线上 Go 零影响 → **过** |
| G7 | 判据全过 | §5 追溯表 7 条全 **过**（判据 3 明标弱证据）；另经「双影子对练」补验运行态 → **过** |
| G8 | 仓库纪律 | `git diff --stat HEAD -- internal/` / `git diff --raw HEAD` **均无输出** ⇒ 零 Go 改动。`internal/httpapi/web.go` 在 `git status` 上的 ` M` **已坐实为纯行尾现象**：`git diff --quiet HEAD -- <file>` **exit=0**（git 权威内容判据，施 clean 过滤）；带过滤 `git hash-object <file>` = `git rev-parse HEAD:<file>` = **同一 blob `c6b9590d…`**（`--no-filters` 原始字节 `42fa3f9d…` 不同）；字节统计 **12832 B / CR=388 / LF=388**，与 HEAD blob 12444 B 之差 **恰为 388 个 CR**；成因 `core.autocrlf=true` + 无 `.gitattributes`。`git update-index --refresh` 实测**未能**清除（`web.go: needs update`，exit=1）——该命令按 stat() 判定（工作区 CRLF 大小 ≠ 索引缓存 LF 大小），故 ` M` 是 stat 缓存 + 行尾归一的表面现象，**非内容改动**。只 add 本册相关文件（**未** add `.tmp/`、`based-linux-amd64`、`.gitignore`、`internal/httpapi/web.go`；亦**未**用 `git add --renormalize` 去消标志，以免触碰「不 add web.go」约束）→ **过** |

- **提交**：GAP-A/GAP-C 修复 + 双影子对练回填 = `6713e61`；退役实况 + G1–G8 回填 + `docs/README.md` 同步（`#70` 行状态 + `#76` 行登记）= 收口提交；G8 判据坐实补记（`web.go` 行尾定性）= 其后一次提交。**tag `last-go-node` 已 push**。
- **结论：P5 收口** —— 线上 `base-cache` 已由 Node 壳接管；`base`（源节点）仍为 Go。
  Go 实现（`internal/` / `cmd/` / `web/` / `based-linux-amd64`）**全留**，回退 = 一次 `restart`。