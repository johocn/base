# base 内容分发主线设计（A 主线）

- 日期：2026-09-26
- 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`（唯一上游，冲突时先改总纲）
- 范围：**视频分块 · 包级复制 · 多节点反熵 · 邻居补齐 · scrub · 墓碑同步 · 发行包**
- 本册子**不覆盖**：课程层级建模（`course → lesson → 载体` 的归属与排序，归 #6）；任何互动形态（评论 / 进度 / 小组 / 私信，归 #7–#10）；手机端本地库加密（归 #4）；近场互传与可视化后台（C 阶段）

## 0. 改版说明

### 0.1 2026-09-26 初版

**新增（本册子首次定义）：**

- 视频导入与分块落库的接口契约（§4）
- 对端监听与公开监听的**路由隔离**，以及四个内部接口的形状（§5）
- 包级复制流程：缓存节点从邻居复制签名内容包并解包入库，从而**可独立供读**（§6）
- 反熵回合调度、块集合比对算法、**副本登记**表语义（§7）
- scrub 自愈（§8）
- 墓碑跨节点同步，以及 `revoked_rev` 的**语义定案**（§9）
- 一键安装脚本 `install.sh` / `install.ps1` 的契约（§10）

**明确沿用、不改动：**

- 内容包规范 v1（`manifest.json` 字段与类型、`pack.sqlite` 表结构），见总纲 §6
- `blob_id = hex(sha256(逻辑字节))[0:32]`、定长 1 MiB 视频分块、磁盘布局 `data/blobs/<h0..1>/<h2..3>/<blob_id>`（总纲 §3.2 / §6.3）
- L4a′ 静态加密只在 `internal/store` 一层透明加解密，跨节点仍传**明文**（总纲 §12.1.1）
- P0 已落地的导入 / 导出 / 公开读 / 手机端下载全部保留，不重写

## 1. 范围与不做什么

**做七件事：**

1. 视频导入：定长 1 MiB 分块、块入库、`media_meta` 与 `items` 登记、导出与公开读对齐。
2. 监听与路由隔离：公开监听零内部路由；内部接口只挂对端监听。
3. 内部接口：`inventory` / `sync` / `fetch` / `scrub` 四个（节点↔节点）。
4. 包级复制：缓存节点从邻居复制已签名内容包 → 验签 → 解包入库 → 目录与正文可用。
5. 反熵：每 5 分钟逐邻居比对块集合 → 缺失批量补齐 → 副本登记；`extra` 只记录不删。
6. scrub：每日全量重算哈希 → 坏块删除并从邻居补齐。
7. 墓碑同步 + 发行包：墓碑随签名 manifest 传播并在节点与客户端两侧落地；补 `install.sh` / `install.ps1`。

**明确不做：**

- **不改内容包规范 v1 的字段名、字段类型与 `pack.sqlite` 表结构**；本册子新增的一切都在 v1 之外（新接口、新表、新配置）。
- **不做课程层级建模**：不引入 `course` / `lesson` 归属与排序语义。`item_id` 命名保持 P0 形式（`<source>:<slug>`），路径式命名空间（总纲 §6.0）由 #6 统一切换（见 §2.3）。
- **不做容量上限与 LRU 淘汰**：本册子只做副本**登记**，不实现淘汰动作，也不实现淘汰前的「别处存在副本」保护判定。
- 不做手机端视频播放器；手机端只沿用既有块下载路径（§4.5）。
- 不做 ② 类内容的解密、索引、审核；节点侧一切操作只面向**不透明字节**。
- 不做读取鉴权、不做节点侧授权判定；不做近场互传、不做可视化后台（C 阶段）。

## 2. 契约边界

### 2.1 不可改（任何实现都不得偏离）

| 项 | 约束 | 出处 |
|---|---|---|
| `blob_id` | `hex(sha256(逻辑字节))[0:32]`，输入与算法均不可变；① 类算明文、② 类算密文 | 总纲 §3.2 |
| 分块粒度 | 视频定长 1 MiB（1048576 字节），最后一块可短；文本与小资源整块 | 总纲 §6.3 |
| 磁盘布局 | `data/blobs/<h0..1>/<h2..3>/<blob_id>` | 总纲 §3.2 |
| `manifest.json` | 字段名与类型不变；`schema_version` 固定 `1` | 总纲 §6.1 |
| `pack.sqlite` | `articles` / `segments` / `quizzes` / `media_meta` / `meta` 五张表，列顺序不变 | 总纲 §6.2 |
| 包派生 | `pack_id`、`merkle_root` 必须可由 `Verify` 复算一致，否则整包拒绝 | 总纲 §6.4 |
| 版本裁决 | 以签名 `content_version` 为准，大者胜 | 总纲 §1、§6.5 |
| 静态加密 | 只改磁盘表示，跨节点传明文；`internal/httpapi` / `packexport` / `sync` 不感知加密 | 总纲 §12.1.1 |

### 2.2 允许新增（v1 之外）

- 内部接口四个（§5.2）与对端监听的挂载方式（§5.1）。
- 新表：`blob_replicas`（副本登记，§7.3）。
- 新配置项：`BASE_SYNC_INTERVAL`、`BASE_SCRUB_INTERVAL`、`BASE_ISSUER_PUBKEYS`、`BASE_FETCH_MAX_BLOBS`（§5.3 / §6.1 / §7.1）。
- 新的命令行子命令：`import-video`（§4.2）、`peer-sync`（手动触发一轮反熵，§7.1）、`scrub`（手动触发一次 scrub，§8）。
- 发行侧的 `install.sh` / `install.ps1` 与配置模板（§10）。

### 2.3 三处已落地不一致的处置（本册子定案）

**① `item_id` 命名（P0 `article:<slug>` vs 总纲 §6.0 路径式）**

- 本册子**不动**已落地的命名，`importer` / `tools/migrate` / 客户端测试与存量数据一律不改。
- 视频条目沿用「`<source>:<slug>`」形式，`source` 取总纲 §6.0 已声明的 `lesson`（**不新增 `video` 枚举值**），即 `lesson:<slug>`。
- 定案记录：P0 命名为**过渡态**；#6 落地课程体系时**统一切换**为路径式，切换方式 = 新增路径式 `item_id` 条目 + 递增 `content_version` + 对旧 `item_id` 签发墓碑（§9）。切换属 #6，不在本册子实现。

**② `revoked_rev` 语义（`INTEGER` vs `source_rev TEXT`）**

- 现状：`Tombstone.RevokedRev` 是整数，而 `Entry.SourceRev` 是字符串（哈希前缀），二者无法直接比较。
- 定案（**不改字段、不改类型**）：`revoked_rev` 的含义是「**撤回生效的全局 `content_version`**」，与 `source_rev` 无关。判定规则见 §9.1。

**③ 客户端墓碑未删块文件**

- 现状：客户端应用墓碑时删了 `blob_index` 行与 `items` / `articles` 行，但应用私有目录下的**块文件本体仍留在磁盘**。
- 定案：属本册子范围内的一处实现 delta，随 §9.3 一并补齐（删行前先取出 `blob_index.path`，逐个删除文件）。

## 3. 已落地基线（只补文档，不改写）

| 能力 | 落点 | 本册子是否改动 |
|---|---|---|
| 内容库骨架（`items` / `articles` / `segments` / `quizzes` / `media_meta` / `blobs` / `packs` / `tombstones`） | `internal/store/schema.go` | 只**新增** `blob_replicas` |
| 静态加密 L4a′（块逐文件 AEAD、`articles.body_md` 前缀封装） | `internal/store/crypto.go` | 不改 |
| 导入（markdown → 文章） | `internal/importer/md.go`、`cmd/based/import.go` | 不改；视频导入**新增**独立子命令 |
| 导出（pack.sqlite + 签名 manifest + `merkle_root` + `tombstone[]` + 全局 `content_version` 自增） | `internal/packexport/export.go` | 不改（`media_meta` 分支已具备，视频导出即自动可用） |
| 公开读（`catalog` / `manifest` / `pack` / `blob` GET+HEAD、浏览页） | `internal/httpapi/content.go`、`public.go`、`web.go` | 不改；仅新增 `catalog` 在缓存节点上的语义说明（§6.4） |
| 节点拓扑（主监听 + 对端监听：mTLS + 指纹固定 + `X-Base-Node-Key`） | `cmd/based/serve.go`、`internal/httpapi/tlscfg.go` | **改**：路由隔离（§5.1） |
| 客户端目录 diff → 拉包 → 逐行校验 → 墓碑落地 | `apps/mobile/src/core/sync.ts`、`repo.ts` | **改**：墓碑删块文件（§9.3） |
| 交叉编译发行（三平台 + `SHA256SUMS.txt`） | `scripts/build-release.ps1` | 不改；**新增** `install.sh` / `install.ps1` |
| 一次性迁移（Strapi 文章 + 封面块） | `tools/migrate` | 不改 |

## 4. 视频分块与块分发

### 4.1 分块算法（不可变）

- 定长 **1048576 字节**（1 MiB），按文件顺序切分，`seq` 从 0 递增；最后一块可短。
- 每个块单独算 `blob_id`（明文上算），块之间无依赖，可乱序、可断点、可并发。
- 条目级 `content_hash` = `hex(sha256(按 seq 升序拼接的每个块的 blob_id))`：只依赖块 id 序列，不依赖块字节，可复算且与存储形态无关。

### 4.2 导入接口（命令行）

```
based import-video -file <path> -slug <slug> [-title <t>] [-mime <m>] [-duration <sec>] [-data <dir>]
```

- 派生 `item_id = lesson:<slug>`；`items` 行：`source=lesson`、`type=video`、`sqlite_table=media_meta`、`dist_class=public`（② 类视频的密文由其客户端自行分块上传，不在本命令范围）。
- `media_meta` 行：`mime`、`size`（原始文件字节数）、`duration`（秒，0 = 未知）、`chunk_size=1048576`、`chunk_hashes_json` = **按 seq 升序的 `blob_id` 数组**（与 `manifest.entries[].chunks[].blob_id` 一致）。
- 落块：逐块 `PutBlob(blob_id, data, item_id, seq)`，写 `data/blobs/<h0..1>/<h2..3>/<blob_id>` 并登记 `blobs` 行。
- 幂等：同一 `slug` 重复导入 = 覆盖 `items` 与 `media_meta`、刷新 `source_rev = content_hash[:16]`；块按 `blob_id` 天然去重（同字节同 id，已存在即跳过写盘）。
- 失败语义：任一块写盘失败 → 命令报错并以非零码退出；已写入的块与登记**保留**（块是内容寻址的，重跑即续上），不做回滚。

### 4.3 导出与公开读

- 导出侧无需改动：`export.go` 对 `sqlite_table=media_meta` 的条目已走「读 `media_meta` + 读该条目全部块引用 → 填 `entries[].chunks[]` → 块 id 汇入 `merkle_root`」。
- 公开读：块按 `GET /v1/blob/:blob_id` 逐个可取；`HEAD` 用于存在性判定；两者均已返回 `ETag` + 长缓存头。
- 头 1 MiB 与尾块均由同一路径提供，无 Range 语义（分块即为 Range 的替代品，不做 HTTP 断点续传）。

### 4.4 元数据可见性

- `catalog` 中的视频条目与其他条目同构：`item_id` / `source` / `type` / `title` / `content_hash` / `source_rev`。
- 块清单只在 `manifest.entries[].chunks[]` 与 `media_meta.chunk_hashes_json` 中出现，**不在 `catalog` 里**——客户端按需取 manifest 或 pack 后才知道块列表。

### 4.5 手机端

- 不新增播放器与解码逻辑；沿用既有路径：取 manifest/pack → 读 `chunks[]` → 逐块 `GET /v1/blob/:blob_id` → 校验 → 写 `blob_index` 与应用私有目录。
- 中断续传语义沿用现有 `downloads` 设计（P0 已建表；本期不新增调度）。

## 5. 对端监听与内部接口

### 5.1 监听拓扑（本册子的关键改动）

现状是主监听与对端监听**共用同一个 handler**，一旦加入内部接口，客户端监听上也会暴露。定案：

| 监听 | 挂载路由 | 传输与鉴权 |
|---|---|---|
| 客户端监听（`-addr`） | **仅公开路由**（现 `Handler()` 的全部内容） | TLS（自签 + 客户端指纹固定） |
| 对端监听（`-peer-addr`） | **公开路由 + 内部路由** | mTLS（双向证书 + 对端指纹白名单）+ 可选 `X-Base-Node-Key` |

- 实现方式：把公开路由与内部路由拆成两个独立 router，对端监听挂「公开 ∪ 内部」的合并 router。客户端监听上内部路由**根本不存在**（404），而不是「存在但被拦截」。
- 对端监听同时保留公开路由，使 `BASE_PEERS` 里**一个 `url` 即可满足两种用途**（内部接口 + 拉包/拉块），无需引入第二个地址字段。
- 缺省不启用对端监听（`-peer-addr` 为空）；配置了 `-peer-addr` 则必须同时配置 `-peers`（对端指纹白名单非空），保持既有铁律。

### 5.2 接口定义

四个接口均为 JSON 进、JSON 出（`fetch` 除外，见下），路径固定在 `/v1/` 下，**只在内部 router 注册**。

**`GET /v1/inventory?since=&cursor=&limit=`**

- 语义：本节点块清单分页 + 全量 `merkle_root`。
- `since`：调用方已知的 `content_version` 水位。命中（`since >= content_version`）时返回空 `blobs` 但仍返回 `merkle_root`，用于快速 no-op。
- `cursor`：上一页最后一个 `blob_id`（独占），`next_cursor` 为空表示没有下一页。
- `limit`：默认 500，上限 2000。
- 响应：`{content_version, merkle_root, blobs:[{blob_id, size}], next_cursor}`。
- `merkle_root` 的定义域是**本节点持有的全部块 id**（排序后构树），与 `packexport` 的 `merkle_root`（单个包内条目的块集合）**不是同一个值**，两者不可互相校验。

**`POST /v1/sync`**

- 语义：开启一轮反熵会话，提交我方水位。
- 请求：`{content_version, merkle_root}`。
- 响应：`{equal: bool}`。`equal=true` 表示双方块集合一致，调用方本回合结束；`equal=false` 时调用方继续拉 `inventory` 做集合比对（§7.2）。
- 本接口**不做**服务端状态机、不做会话 id、不做增量位图——一轮反熵由调用方驱动，服务端无状态。

**`POST /v1/fetch`**

- 语义：批量拉块。
- 请求：`{blob_ids: [<32 hex>...]}`，单次上限 `BASE_FETCH_MAX_BLOBS`（默认 64）。
- 响应：`Content-Type: application/x-base-blobpack`，逐帧流式：
  - 帧 = `blob_id(32 字节 ASCII) || size(8 字节大端) || payload(size 字节)`，帧首尾相接，流结束即结束。
  - 请求中不存在于本节点的 `blob_id` **整帧跳过**（不占位、不报错）；调用方以「缺哪些帧」为准。
- 任一 `blob_id` 非法或超上限 → 400 / 413，不返回半截流。
- 设计理由：避免引入归档库（tar/zip）与 base64 膨胀；帧格式零依赖、可流式、可在客户端逐帧校验。

**`POST /v1/scrub`**

- 语义：触发一次校验修复（§8）。
- 请求：`{blob_ids?: [<32 hex>...]}`；省略则全量。
- 响应：`{checked, repaired, dropped, bad:[{blob_id, reason}]}`；`reason` 取值 `hash_mismatch` / `missing`。
- 本接口**只对自己**做校验修复；「从邻居补齐」由调用方在拿到 `bad` 后走 `fetch`。不做跨节点 scrub 编排。

### 5.3 鉴权、限额与红线

- 内部路由的一切请求都经过对端监听的三层：传输层 mTLS（双向）→ 对端证书指纹白名单 → 可选 `X-Base-Node-Key`。三层缺任一层不影响其余，但**缺省全部启用**（除 node key 可留空以便局域网调试）。
- `fetch` 是唯一可能被用来放大流量的接口：限额 = 单请求块数上限 + 单请求总字节上限（64 块 × 1 MiB ≈ 64 MiB）；超限 413。
- 内部接口**不**返回 `items` / `articles` 等条目级信息，只返回块清单与块字节；条目与正文的复制走公开接口（§6）。
- 内部接口不写任何业务数据（`scrub` 只修自己的本地状态）。

## 6. 包级复制（缓存节点独立供读）

### 6.1 签发方公钥的信任来源

- 缓存节点（无私钥）不签发任何东西，也不调用 `GET /v1/pubkey` 作为信任来源（该接口在无私钥节点上返回 404，且 TOFU 会让「第一个连上的节点」获得伪造能力，与「内容不可伪造」铁律冲突）。
- 信任来源 = **配置注入**：`BASE_ISSUER_PUBKEYS` = JSON `[{"issuer":"...","public_key_hex":"<64 hex>"}]`，可经 env 或文件提供，由安装脚本随发行包预置。
- 验签规则：`manifest.issuer` 必须在配置表中命中对应公钥，且 `manifest.Verify(pub)` 为真；未命中 → 拒绝整包并告警（不静默跳过）。

### 6.2 复制流程（把客户端流程搬到节点间）

1. `GET {peer.url}/v1/catalog?since=<本地 content_version>`（公开路由）。
2. 若返回的 `content_version` **不大于**本地水位 → 本回合结束；`pack_id` 为空同样结束（对端还不是源节点）。
3. `GET {peer.url}/v1/manifest/{pack_id}` → 按 §6.1 验签 → 失败即拒绝并告警。
4. `GET {peer.url}/v1/pack/{pack_id}` → 写入 `data/packs/<pack_id>/pack.sqlite`（先写临时目录，校验通过再落位）。
5. 解包入库（一个事务内）：
   - `meta` 表中的 `pack_id` / `content_version` / `merkle_root` 必须与已验签的 manifest 一致；
   - 逐条按 `manifest.entries[]` 比对：`items` 行按 `item_id` 覆盖写、`articles` / `media_meta` 行按 `item_id` 覆盖写，行的 `content_hash` 必须与 manifest 一致，任一行不符 → **整包拒绝**，事务回滚，临时目录清理；
   - `dist_class != public` 的条目**跳过入库**（防御性：P0 导出口径本就拒绝非 public 条目，此处只作双保险，不改变导出侧行为）。
6. 登记 `packs` 行（`dir` 指向落位后的目录、`signature` 存 manifest 签名）→ 本节点 `LatestPack` 自然指向它 → `catalog` / `manifest` / `pack` 三个公开接口在本节点**立即可用**。
7. 块补齐：按 entries 的 `chunks[]` 计算本地缺失的 `blob_id`，走反熵补齐（§7.3），补齐后本节点对客户端**完整等价于源节点**（除 `/v1/pubkey` 返回 404）。

### 6.3 版本裁决与拒绝语义

| 情形 | 处理 |
|---|---|
| 对端 `content_version` > 本地 | 正常复制 |
| 相等 | 跳过（不拉 manifest、不拉 pack） |
| 对端 < 本地 | 拒绝并告警（防回卷；不回退本地视图） |
| manifest 验签失败 / `pack_id` 与 `merkle_root` 复算不符 | 拒绝整包，记录告警，本地视图不变 |
| pack 行级 `content_hash` 不符 | 同上，且**不落任何行** |

### 6.4 幂等与可重跑

- 复制是幂等的：同一 `pack_id` 重复复制 → 行覆盖写、`packs` 行覆盖写、块按 `blob_id` 去重。
- 复制不重新导出、不重新签名：`data/packs/<pack_id>/` 是**复制来的产物**，字节与源节点一致（这也使 `GET /v1/pack/:pack_id` 的 `SHA256` 全网一致）。
- 不复制 `tombstones` 以外的历史：本节点 `tombstones` 表由 manifest 的 `tombstone[]` 逐个 upsert（§9）。

## 7. 反熵与邻居补齐

### 7.1 回合调度

- 触发：进程启动后延迟随机 0–60 秒执行首轮，此后每 `BASE_SYNC_INTERVAL`（默认 **5 分钟**）执行一轮；另提供 `based peer-sync` 手动触发单轮（逐节点打印结果）。
- 逐 `BASE_PEERS` 元素串行执行：一个 peer 一轮完整走完（含拉包与补齐）再处理下一个，避免并发打满带宽。
- 单轮失败（超时 / TLS 拒绝 / 验签失败）只记日志并进入下一 peer，不影响其他 peer，也不终止调度器。
- 单轮的整体超时与单请求超时都设上限；不做重试队列（下一轮自然会重试）。

### 7.2 比对算法

对每个 peer：

1. 先做 §6.2 的**包级复制**（若包有更新）——条目视图与块视图要在同一轮内收敛。
2. `POST {peer}/v1/sync` 提交 `{本地 content_version, 本地块集合 merkle_root}`；`equal=true` → 本 peer 结束。
3. `equal=false` → 分页 `GET {peer}/v1/inventory` 拉邻居块清单（含 `blob_id` 与 `size`）。
4. 计算集合差：
   - `missing` = 邻居有、本地无 → 走补齐；
   - `extra` = 本地有、邻居无 → **仅记录**，不删除（避免误删唯一副本）。
5. `missing` 按 `BASE_FETCH_MAX_BLOBS` 分批 `POST {peer}/v1/fetch`：
   - 逐帧读出 → `hex(sha256(payload))[0:32]` 必须等于帧头 `blob_id`，不符即丢弃该帧（不落盘、不登记）并记 `hash_mismatch`；
   - 校验通过 → `PutBlob` → `blobs` 行登记；
   - 分批之间不阻塞调度器以外的任何东西。
6. `blob_replicas` 更新（§7.3）。
7. 回合统计写日志：`peer / 包版本 / missing / extra / 成功补齐 / 坏帧 / 副本数 < 2 的块数`。

### 7.3 副本登记

新表（唯一新增表）：

```
blob_replicas(blob_id TEXT, peer TEXT, seen_at INTEGER, PRIMARY KEY(blob_id, peer))
```

- 写入时机：拿到某 peer 的 inventory 后，把该 peer **声明的每个 `blob_id`** 执行 upsert（`seen_at` 刷新）。`peer` 取 `BASE_PEERS` 中的 `url`。
- 副本数定义：某块 `blob_id` 的副本数 = **本地持有（0 或 1） + `blob_replicas` 中该块的 peer 行数**。
- 用途（本册子）：只作**观测**——每轮结束打印「副本数 < 2 的块数」，并在补齐后复核该值是否下降。A 阶段节点数少、内容量小，不做淘汰动作（总纲 §12 第 6 条的容量/LRU 留给后续）。
- 不做反向清理：peer 长期离线不删行（`seen_at` 供运维判断新鲜度）；节点不再持有某块时**不删** `blob_replicas` 行，因为该行的语义是「那个 peer 曾经声明持有」，与本地持有无关。

### 7.4 不做删除的例外

- 唯一允许节点主动删除块的场景是 **scrub 发现坏块**（§8）与 **墓碑**（§9）。

## 8. scrub 自愈

- 触发：进程启动后延迟 10 分钟执行首轮，此后每 `BASE_SCRUB_INTERVAL`（默认 **24 小时**）；另提供 `based scrub [-data] [-blob <id>]` 手动执行。
- 流程（逐块，串行）：
  1. 读 `data/blobs/<h0..1>/<h2..3>/<blob_id>` → 拆封（`internal/store` 透明解密）→ 重算 `hex(sha256(明文))[0:32]`；
  2. 与文件名/登记 id 不符 → 记 `bad{reason=hash_mismatch}` → 删除坏块文件与 `blobs` 行；
  3. 文件不存在但 `blobs` 行存在 → 记 `bad{reason=missing}` → 删除 `blobs` 行；
  4. 对每个坏块：按 `blob_replicas` 找声明持有它的 peer → `POST {peer}/v1/fetch` 拉回 → 校验 → `PutBlob`。全部已知 peer 都拿不到 → 保留在 `bad` 列表并**告警**（不静默、不删除已坏的登记之外的任何数据）。
- ② 类密文只需重算**密文**哈希，无需解密（密文就是 blob 的逻辑字节，拆封只发生在 L4a′ 的磁盘表示层）。
- scrub 只修**本地**；跨节点编排不做（节点各扫各的）。

## 9. 墓碑同步

### 9.1 `revoked_rev` 语义（定案，不改字段与类型）

- `revoked_rev` = **撤回生效的全局 `content_version`**，不是条目版本。
- 条目 `item_id` 被撤回 ⇔ 「该 `item_id` 在某个 `content_version = revoked_rev` 的签名 manifest 的 `tombstone[]` 中，且不再出现在任何 `content_version ≥ revoked_rev` 的 manifest 的 `entries[]` 中」。
- 与 `source_rev`（字符串哈希前缀）**不做比较**——这是本册子对 §2.3② 的定案。

### 9.2 节点侧应用

复制或拉取到带 `tombstone[]` 的签名 manifest 后（§6.2 步骤 5 的同一事务内）：

1. `tombstones` 表 upsert `(item_id, revoked_rev)`；
2. 删 `items` 行、`articles` / `media_meta` 行、`blobs` 行；
3. 删块文件：先取该 `item_id` 在 `blobs` 中的全部 `blob_id`，逐个删 `data/blobs/...`；
4. 已撤回的 `item_id` 若在**同一或更小** `content_version` 的 manifest 的 `entries[]` 中再次出现 → 拒绝入库该条目（防回卷），并告警；出现在**更大** `content_version` 中 → 视为正常「重新发布」，允许入库（`tombstones` 行按 `revoked_rev` 取大值覆盖）。

### 9.3 客户端侧（含实现 delta）

- 现实现已做：应用墓碑 → upsert `tombstone` 行 → 删 `blob_index` 行 → 删 `articles` 行 → 删 `items` 行（同一事务）。
- **补齐**：删行前先按 `blob_index.path` 取出本地块文件路径，在同一流程中删除文件本体（文件删除失败不阻断事务，只记错并重试于下次同步）。
- 客户端不重新计算 `revoked_rev`，一律以 manifest 中的值为准；客户端没有源节点签名能力，**不可能伪造墓碑**。

### 9.4 防回卷的统一口径

节点与客户端共用同一口径：**条目的「新」由 `content_version` 裁决，条目的「亡」由 `revoked_rev` 裁决**；两者都不依赖 `source_rev` 的比较。`source_rev` 只作为「同一来源的修订标识」与人可读的诊断信息。

## 10. 发行包与一键安装

### 10.1 交叉编译（已落地，不改）

`scripts/build-release.ps1` 产三个目标（`linux/amd64`、`linux/arm64`、`windows/amd64`），写 `SHA256SUMS.txt`。构建一律在开发机完成。

### 10.2 `install.sh` / `install.ps1` 契约（本册子新增）

两者行为一致，参数相同：

| 参数 | 说明 |
|---|---|
| `--version` / `-Version` | 发行版本，决定下载的文件名 `base-v<ver>-<os>-<arch>[.exe]` |
| `--base-url` / `-BaseUrl` | 发行产物基址（HTTP/HTTPS 或本地目录） |
| `--dir` / `-Dir` | 安装目录，缺省 `./base` |
| `--issuer` / `-Issuer` | 节点签发方标识，写入生成的配置文件 |
| `--source` / `-Source` | 是否作为源节点（含私钥）；缺省为缓存节点 |

步骤（两个脚本必须逐条一致，顺序固定）：

1. 探测 `os` / `arch` → 选定文件名；
2. 下载二进制与 `SHA256SUMS.txt` → **校验 SHA256**，不符即失败退出（不覆盖已有二进制）；
3. 落地安装目录：二进制 + 生成的配置文件（`base.env`）+ 空 `data/` 目录；
4. 数据目录与密钥位置符合总纲 §7.2：`data/`、`data.key` 在 `data/` 之外（0600）、`data/tls/`；
5. 打印后续人工步骤（TLS 指纹与配对码在首次启动日志中回显；源节点另需注入签名私钥与 `BASE_ISSUER_PUBKEYS`），**不自动写入任何私钥**；
6. 幂等：重复执行只更新二进制与配置模板，**不动 `data/`、不动 `data.key`**。

### 10.3 部署者路径铁律（沿用总纲 §7.6）

- 部署机不编译、不 `npm install`、不 `go get`；只接收二进制与配置。
- 贡献者两条路径：跑 `install.sh` / `install.ps1`，或自备 Go 工具链 `go build`。
- 服务托管（systemd / Windows 服务）在安装脚本中**只输出建议命令**，不自动注册——避免脚本在部署机上做不可逆操作。

## 11. 验收（A 阶段）

| # | 验收项 | 判定 |
|---|---|---|
| 1 | 三节点恢复 | 3 节点（1 源 + 2 缓存）→ 杀 1 个 → 剩余节点的下一轮反熵补齐缺失块、逐块哈希校验通过、`副本数 < 2 的块数` 回落为 0 |
| 2 | 篡改拒收 | 改动块 1 bit → 客户端拒绝加载；节点侧 `scrub` 报 `hash_mismatch` 并从邻居修复 |
| 3 | 视频分块 | 导入 1 个视频 → 块数 = `ceil(size / 1 MiB)`；每块 `GET /v1/blob` 校验通过、`HEAD` 返回正确大小；导出后 `manifest.entries[].chunks[]` 与 `media_meta.chunk_hashes_json` 一致 |
| 4 | 缓存节点独立 | 断开源节点连接后，缓存节点的 `catalog` / `manifest` / `pack` / `blob` 全可用；其 `pack.sqlite` 字节与源节点一致 |
| 5 | 路由隔离 | 客户端监听上四个内部接口全部 404；对端监听上三层鉴权（mTLS / 指纹白名单 / node key）任一不满足即拒绝 |
| 6 | 幂等 | 同源重复复制不产生新 `content_version`、不产生新的 `pack_id`；重复 `import-video` 同 `slug` 不新增块 |
| 7 | 墓碑同步 | 源节点签发带 `tombstone` 的新版本 → 缓存节点删除对应 `items` / `articles` / 块文件；客户端同步后本地行与块文件均被删除（§9.3 delta 生效） |
| 8 | L4a′ 断言不变 | 直接读 `data/base.db` 与 `data/blobs/*` 原始字节，断言无 ① 类明文；同时公开读仍返回明文 |
| 9 | 验签拒绝 | 篡改 manifest 任一字段（含 `tombstone` / `merkle_root`）→ 缓存节点拒绝整包，本地视图不变 |
| 10 | 发行安装 | 在干净目录跑 `install.sh` / `install.ps1` → 二进制 SHA256 校验通过、目录结构正确、首次启动生成 `data.key`（在 `data/` 之外）与自签证书 |

范围约束：本册子的验收只覆盖 A 阶段的**分发侧**；课程体系（#6）与互动形态（#7–#10）各自另出册子与计划。

## 12. 风险与红线

1. **内部接口是新的攻击面**：定案处置 = 客户端监听零注册（404 而非拦截）、对端监听三层鉴权、`fetch` 双限额。任何把内部路由加回客户端监听的改动都视为红线。
2. **包级复制让缓存节点持有 ① 类明文**：与总纲 §12.1 的不可达边界一致（节点必须能解密才能匿名供读明文），不因本册子改变。
3. **签发方公钥靠配置注入**：配置缺失或被改成攻击者公钥 = 该节点接受伪造内容。公共键必须随发行包预置，且**只有** `BASE_ISSUER_PUBKEYS` 一个来源，不做 TOFU、不做 `/v1/pubkey` 信任。
4. **副本登记是观测值，不是持久性保证**：`blob_replicas` 记录的是「peer 曾经声明持有」，peer 可能已删目录但未重新同步。因为本期不做淘汰，误删风险为 0；一旦引入淘汰，**必须**把「声明持有」升级为「补齐后已验证持有」。
5. **`extra` 只记录不删**：代价是节点可能长期持有已撤回之外的多余块；收益是永不误删唯一副本。这是刻意取舍。
6. **反熵是串行逐 peer**：节点数多或带宽小时单轮可能超过 5 分钟间隔。处置 = 单轮不重入（上一轮未结束则跳过本轮），并记录实际轮次耗时。
7. **`install` 脚本不注册服务、不写私钥**：牺牲「全自动」，换取部署机零不可逆操作。

## 13. 待定与未闭环

- **容量上限与 LRU 淘汰**：本册子明确不做，只留下 §7.3 的副本登记作为前置数据；引入时需按风险 4 升级登记语义。
- **`BASE_ISSUER_PUBKEYS` 的运维流程**：签发方轮换公钥（换源节点）时的分发与过渡窗口，未定；当前假定签发方长期不变。
- **多 issuer 并存**：`BASE_ISSUER_PUBKEYS` 是数组，但本册子未定义「同一 `item_id` 由两个 issuer 签发」的裁决规则（当前假定单一签发方）。
- **手机端视频块下载调度**：本周册只沿用既有路径，未设计预下载优先级与并发策略。
- **`merkle_root` 双定义**：本册子已明确「节点块集合 root」与「包内条目块 root」是两个值（§5.2）；后续若要做「全节点集合一致性」的可视化，需要另出册子，不在本册子扩写。