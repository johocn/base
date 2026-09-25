# base 分布式学习系统设计

- 日期：2026-09-25（2026-09-25 重大改版：彻底脱离 Strapi）
- 仓库：`e:\code\base`（远端 `git@github.com:johocn/base.git`，已 `git init` 并绑定 `origin`）
- 定位：完全独立的去中心化学习系统，**不依赖 Strapi、不依赖 basic 仓库**
- 节点运行时：Go（静态单文件，纯 Go SQLite，无 CGO）
- 客户端：uni-app（Android 优先）

## 0. 改版说明

本版推翻了上一版「base 作为 basic 插件 + 依赖 Strapi 提供内容与身份」的方案。上一版中以下内容全部作废：

- `basic/plugins/base` 插件、`gate.ts` 只读门面调用、表隔离铁律约束、插件 `dist` 重建与部署流程
- `zhao-*` 内容插件作为内容权威源；`zhao-sso` / `zhao-point` 作为身份与分享权威源
- 协议层仅 TS 单实现的假设

保留并沿用的设计：可分发/受控分界、匿名读开放、内容包规范（manifest / pack.sqlite / 哈希寻址 / Ed25519）、节点公开读与反熵接口、手机端离线、事件与审核、分期思路。

新增这一层负担：base 必须自己承担原本由 Strapi 提供的内容存储、内容维护、身份与写入能力。

## 1. 目标

让学习者用手机 App 访问「可分发内容」（课程、文章、题库等），把内容下载到本地随时离线学习；内容在多个节点间分布存储，节点消失后可由邻居按内容哈希补齐。

节点是同构的：**谁愿意贡献服务器或自己的电脑，从仓库取源码或发行包部署，谁就成为一个分发节点。**

## 2. 明确不做（排除范围）

- 不做区块链、共识、token、DHT。所谓「区块链式」只体现为哈希寻址 + Merkle 清单 + 多副本。
- 不承载受控内容（需鉴权/加密/付费/内部内容）：这类内容不属于本系统，不迁移、不存储、不转发。
- 不做内容级授权与加密：可分发内容对匿名（guest）开放。
- 一期不做 iOS（离线文件与后台下载受限）。

## 3. 硬性分界：可分发 vs 受控

| 维度 | 可分发内容（= 指定内容） | 受控内容 |
|---|---|---|
| 是否进本系统 | 是 | 否，本系统完全不碰 |
| 加密 | 不加密，明文分块 | 不属于本系统 |
| 鉴权 | 登录、匿名均可下载 | 不属于本系统 |
| 复制 / 近场互传 | 允许，节点可任意缓存 | 不允许分发 |

铁律：

1. base 只处理 `dist_class = public` 的内容；判定在源节点导入/发布时完成，结果写入 `manifest` 并签名。
2. public 内容不加密、不鉴权、允许任意复制与近场互传。**public 等于全网可复制转存，这是模式固有前提，不是缺陷。**
3. 受控内容的字节不得进入内容库、内容包、节点块目录或客户端本地库。

## 4. 访问模型

| 操作 | 要求 |
|---|---|
| 读：`catalog` / `manifest` / `pack` / `blob` / 浏览页 | 匿名开放，无需登录 |
| 写：评论、分享、学习进度、账号 | 需本系统账号（自建 users 表 + EdDSA 签名的 JWT），源节点签发密钥 |
| 节点间：`inventory` / `sync` / `fetch` / `scrub` | 预共享密钥（`X-Base-Node-Key`），不对外 |
| 审核取正文 | 审核密钥，仅运营侧 |

guest 路径：未注册用户打开 App 即可浏览目录、下载与离线学习全部分发内容；仅在发评论、记进度、领分享奖励时触发注册/登录。

## 5. 系统构成

```
协议规范层  vectors/         （语言中立的黄金测试向量，Go 与 TS 共用）
节点服务    Go 单进程        （cmd/based：内容库 + 公开读接口 + 节点同步 + 账号 + 浏览页）
手机端      apps/mobile      （uni-app，Android 优先）
迁移工具    tools/migrate    （一次性：Strapi REST → base 内容库）
发布脚本    scripts/         （交叉编译 + 一键安装脚本）
```

### 5.1 仓库目录结构

```
base/
  vectors/                     # 黄金测试向量（JSON，语言中立）
  go.mod
  cmd/based/                   # 节点主程序入口
  internal/protocol/           # Go 协议实现：canonical JSON / sha256 / Merkle / Ed25519
  internal/store/              # SQLite 访问层（modernc.org/sqlite）
  internal/httpapi/            # 公开读 / 写 / 内部同步 / 审核 接口
  internal/sync/               # 反熵、补齐、scrub
  internal/auth/               # 账号 + JWT（EdDSA）
  web/                         # 节点自带只读浏览页（html/template + 少量原生 JS，内嵌）
  tools/migrate/               # 一次性迁移工具
  packages/protocol-ts/        # 手机端共用的 TS 协议实现
  apps/mobile/                 # uni-app
  scripts/                     # build-release.ps1 / install.sh / install.ps1
  docs/
```

### 5.2 与 Strapi / basic 的关系

- 内容来自**一次性迁移**：`tools/migrate` 通过 Strapi REST 读取课程、文章、题库，写入 base 内容库；迁移完成后两边零依赖、零同步。
- 身份不迁移、不复用：base 自建账号体系，历史 SSO 用户与积分体系不连通。
- 迁移是单向、可重跑的工具，不在运行时依赖 Strapi。

### 5.3 协议双实现与对齐机制

协议存在两份实现，必须行为一致：

| 实现 | 位置 | 用途 |
|---|---|---|
| Go | `internal/protocol` | 节点：签名、导出包、校验 |
| TS | `packages/protocol-ts` | 手机端：验签、内容哈希与 Merkle 校验、读 pack |

**对齐铁律**：`vectors/` 下每个向量（固定私钥 + 固定输入 + 期望 canonical 字节 + 期望 `merkle_root` + 期望签名）必须被 Go 与 TS 两侧的测试同时消费。任何一侧漂移即测试失败。Ed25519（RFC 8032）签名确定性，同一密钥与消息的签名可作黄金值。

## 6. 内容包规范 v1

一个内容包 = `manifest.json` + `pack.sqlite` + 块文件（按哈希命名）。

### 6.1 `manifest.json`

| 字段 | 说明 |
|---|---|
| `pack_id` | 包标识 |
| `schema_version` | 固定 `1` |
| `issuer` | 签发方标识（源节点 id） |
| `issued_at` | 签发时间 |
| `content_version` | **全局**单调递增（每次导出 +1），冲突时大者胜 |
| `entries[]` | 条目清单 |
| `tombstone[]` | 撤回清单 `{item_id, revoked_rev}` |
| `merkle_root` | 所有 `blob_id` 排序后构树的根 |
| `signature` | Ed25519 签名（覆盖上述字段的规范化 JSON） |

`entries[]` 单项：

| 字段 | 说明 |
|---|---|
| `item_id` | 条目 id |
| `source` | 来源模块：`course` / `lesson` / `article` / `quiz` |
| `type` | `article` / `video` / `quiz` / `subtitle` / `cover` |
| `title` | 标题 |
| `source_rev` | 源内容版本 |
| `content_hash` | 条目级哈希 |
| `sqlite_table` | 落在 `pack.sqlite` 的表名；视频类为 `media_meta` |
| `chunks[]` | 视频条目：`{blob_id, size, seq}` |
| `dist_class` | 固定 `public` |

manifest 中**没有**权限标签、用户范围、过期时间。

### 6.2 `pack.sqlite`

| 表 | 用途 |
|---|---|
| `articles(item_id, title, digest, published_at, tags_json, body_md, content_hash, source_rev)` | 文章正文 |
| `segments(item_id, seq, kind, text, content_hash)` | 文章分段 / 字幕 / 讲义片段 |
| `quizzes(item_id, question_json, content_hash)` | 题库 |
| `media_meta(item_id, mime, size, duration, chunk_size, chunk_hashes_json)` | 视频元数据与分块索引 |
| `meta(key, value)` | `pack_id` / `content_version` / `merkle_root` |

`pack.sqlite` 由源节点从内容库导出，是**只读分发产物**；导出为确定性过程（同版本内容导出字节一致）。

### 6.3 块与寻址

- 视频按定长 1 MiB 分块；文本与小资源整块处理。
- `blob_id = hex(sha256(bytes))[0:32]`（128 bit）。评论/事件正文同样按此寻址，事件字段 `payload_cid` 即该 `blob_id`，两者是同一个 id。
- 节点磁盘布局：`data/blobs/<h0..1>/<h2..3>/<blob_id>`，内容寻址 → 任何来源的块天然可验真，内容一变哈希即变。
- 因此**不需要共识与链**。

### 6.4 签名与验签

源节点用 Ed25519 私钥签 `manifest`；客户端与所有节点内置公钥验签。验签失败 → 整包拒绝。manifest 与 `pack.sqlite` 的行级 `content_hash` 双重校验，任一不符即判坏块。

### 6.5 版本与墓碑

- 导出触发：源节点手动或定时导出增量包，并递增全局 `content_version`。
- 内容更新 → `content_version` 递增，客户端按版本覆盖本地。
- 内容下架/删除 → 新版本 manifest 带 `tombstone`；客户端同步时删除对应本地行与块；节点同样删除，且墓碑**只能在签名 manifest 中传播**，节点无法伪造。

## 7. 节点设计

### 7.1 同构部署与角色

所有节点部署物完全相同（同一个静态二进制），角色由配置决定：

| 角色 | 配置特征 | 能力 |
|---|---|---|
| 源节点 | 配置签名私钥（`BASE_SIGN_KEY`） | 可导入/编辑内容、导出并签发内容包、递增 `content_version` |
| 分发节点 | 不配置私钥 | 只读缓存：拉取已签名内容包与块、反熵补齐、对外提供读接口 |

铁律：**没有私钥就不可能产出新的、可被验签的内容版本**。这是「任何人都能当节点」与「内容不可被伪造」同时成立的前提。

### 7.2 目录布局

```
data/base.db            # 内容库 / 索引 / 事件 / 副本登记 / 账号
data/blobs/xx/yy/<id>   # 块文件
data/packs/<pack_id>/   # 已发布包（manifest.json + pack.sqlite）
```

### 7.3 接口

公开（匿名）：

| 接口 | 说明 |
|---|---|
| `GET /v1/catalog?since=&cursor=` | 可分发内容目录（item_id/source/type/content_hash/rev）分页 |
| `GET /v1/manifest/:pack_id` | 取 manifest |
| `GET /v1/pack/:pack_id` | 取 pack.sqlite |
| `GET /v1/blob/:blob_id` | 取块 |
| `HEAD /v1/blob/:blob_id` | 存在性（近场互传秒传判定） |
| `GET /` | 节点自带只读浏览页 |

写（账号 JWT）：

| 接口 | 说明 |
|---|---|
| `POST /v1/event` | 提交评论/分享/进度事件 |
| `POST /v1/auth/register` · `POST /v1/auth/login` | 账号注册与登录 |
| `GET /v1/me` | 当前账号信息与学习进度 |

内部（`X-Base-Node-Key`）：

| 接口 | 说明 |
|---|---|
| `GET /v1/inventory?since=&cursor=` | 分页块清单 + Merkle root |
| `POST /v1/sync` | 开启反熵会话（提交我方 root） |
| `POST /v1/fetch` | 批量拉块（多哈希） |
| `POST /v1/scrub` | 触发该校验修复 |

运营（审核密钥）：

| 接口 | 说明 |
|---|---|
| `POST /v1/admin/review/fetch` | 按 `payload_cid` 取评论正文供审核 |

### 7.4 反熵与节点恢复

1. 节点每 5 分钟向邻居取 Merkle root。
2. root 相同 → 本轮回合结束。
3. root 不同 → 拉邻居 inventory 分页，比对本地集合，得出 `missing` / `extra`。
4. `missing` → `POST /v1/fetch` 批量拉取 → 逐块重算 sha256 校验 → 入库 → 更新本地副本登记。
5. `extra` 仅记录，不主动删除（避免误删唯一副本）。

**恢复语义**：节点消失后不需要投票、不需要重建链——剩余节点或客户端查副本清单/邻居清单，发现该哈希仍有人持有即拉回，校验通过即恢复。只要全网还有 1 份副本就能恢复。副本因子默认 2：某块登记位置少于 2 时，节点主动向邻居补齐；淘汰块前必须确认别处存在副本。

### 7.5 scrub 自愈

每日全量重算哈希，发现坏块 → 删除本地副本 → 从邻居补齐 → 更新副本登记。

### 7.6 交付形态铁律

- 节点以 **Go 静态单文件**（`CGO_ENABLED=0`，`modernc.org/sqlite` 纯 Go 实现）发布，交叉编译覆盖 `linux/amd64`、`linux/arm64`、`windows/amd64`。
- 贡献者路径只有两条，都**不需要他装运行时、不需要现场编译**：① 运行 `scripts/install.sh` / `install.ps1` 下载对应平台发行二进制；② 自行 `go build`（仅对已装 Go 工具链者）。
- 构建与交叉编译一律在开发机完成，服务器只接收二进制与配置；**禁止让部署者现场 `npm install` / `go get` 拉起依赖树**（历史的 2G 服务器 OOM 教训）。

## 8. 手机端设计

### 8.1 本地 SQLite

本地库用 `plus.sqlite`，块下载用 `plus.downloader`，块文件存应用私有目录。

| 表 | 用途 |
|---|---|
| `config(key, value)` | 节点地址、公钥、账号 token |
| `items(item_id, source, type, title, rev, content_hash, state, updated_at)` | 目录快照 |
| `articles(item_id, body_md, tags_json, published_at)` | 文章正文 |
| `segments(item_id, seq, kind, text)` | 分段/字幕 |
| `quizzes(item_id, question_json)` | 题库 |
| `blob_index(blob_id, item_id, path, size, verified_at)` | 本地块索引 |
| `downloads(blob_id, item_id, url, offset, total, state)` | 下载队列（断点续传） |
| `events_out(local_id, type, target_id, payload_path, state, retry)` | 待上报事件 |
| `progress(item_id, position, updated_at, dirty)` | 学习进度 |
| `tombstone(item_id, revoked_rev)` | 撤回清单 |

无 `license` 表：可分发内容不做授权与时效。

### 8.2 下载与离线

1. `GET /v1/catalog` → 与本地 `items` 比对差异。
2. `GET /v1/pack/:pack_id` → 解包写入本地表，逐行校验 `content_hash`。
3. 视频块按需或预下载：`GET /v1/blob/:blob_id` → 写入应用私有目录（文件名=哈希）→ 校验 → 写 `blob_index`；中断由 `downloads.offset` 续传。
4. 离线阅读只读本地表 + 本地块文件，零网络。

### 8.3 近场互传（三期）

热点或局域网内一方起本地 HTTP 服务，双方交换块清单：命中即秒传（只比哈希），缺失才拉块。不做 DHT、不做蓝牙。

## 9. 学习分享 / 学习交流 / 学习进度

- 客户端生成本地事件：`{type, target_id, actor, payload, causal_parent}`，正文作为 blob 存节点。
- 评论正文按 `payload_cid` 公开可读（同 `GET /v1/blob/:blob_id`），不做读取鉴权。
- 服务器只保留：`event_id` + `payload_cid` + 副本登记 + 审核状态；正文不落中心库。
- 写路径：客户端 `POST /v1/event`（带账号 JWT）→ 节点校验 JWT → 存正文 blob → 本地签发 `event_id`（ULID）→ 回填客户端 → 反熵时传播给邻居。
- 账号与 JWT：`internal/auth` 自建 users 表；JWT 用 EdDSA（Ed25519）签名，节点持公钥即可验签。
- 分享归因：分享链接携带 `share_id`，只记 id 与点击；guest 分享仅统计，登录后分享可计入奖励。
- 审核：先发后审。运营经审核通道按 `payload_cid` 取正文；结论 `rejected` → 删块 + 写入墓碑 → 客户端下次同步删除。
- 合并规则：内容以源节点签名的 `content_version` 为准（大者胜）；事件按因果序 + LWW 合并。

## 10. 分期与验收

| 阶段 | 范围 | 验收 |
|---|---|---|
| P0 | 协议（Go + TS 双实现 + 向量）· 迁移工具导入文章 · 源节点签发导出 pack/manifest · 单节点公开读接口 + 极简浏览页 · 手机端匿名下载 + 断网读文章 | 无 token 可拉 `catalog`/`pack`/`blob`；手机断网可读已下载文章；Go 与 TS 双方跑同一向量全绿 |
| P1 | 视频分块 · 自建账号与 JWT · 多节点反熵 + 邻居补齐 + scrub · 墓碑同步 · 发行包与一键安装脚本 | 3 节点杀 1 个 → 剩余节点补齐缺失块、哈希校验通过、副本登记恢复为 2；篡改 1 bit → 客户端拒绝加载 |
| P2 | 评论/分享/进度事件 + 审核通道 · 近场互传 · 可视化内容后台（源节点） | 离线写评论 → 联网补 `event_id`；`rejected` → 设备删除 |

范围约束：**实施计划一期只覆盖 P0**；P1、P2 在 P0 验收通过后各自另出 spec 与计划。

## 11. 验证方案

- 协议向量对齐：`vectors/` 黄金向量被 Go 与 TS 两侧测试同时消费（canonical 字节、`merkle_root`、Ed25519 签名）。
- Go 单测：canonical JSON、sha256、Merkle、签名验签、pack 导出与读取。
- 恢复 E2E：3 节点，杀 1 个 → 断言补齐与校验（P1）。
- 篡改检测：改动 1 bit → 拒绝加载。
- 真机：Android 断网阅读、下载中断续传、guest 匿名全流程。

## 12. 红线与风险

1. public 即全网可复制转存——已接受，不可作为后续抱怨点。
2. 明文视频必然可被翻录——已接受（不做包内加密）。
3. 节点公开读接口等于内容完全公开——需重点防护的是**写接口、内部接口与签名私钥**。
4. 协议双实现是长期负担：任何协议变更必须同时改 Go、TS 与向量三处，缺一即漂移。
5. 节点构建一律开发机交叉编译，服务器只收二进制；禁止要求部署者现场装依赖。
6. 磁盘增长：节点需容量上限 + LRU 淘汰，淘汰前确认别处存在副本。
7. iOS 一期不做。
8. 历史 Strapi 用户与积分体系不迁移，账号需重建或另行迁移。

## 13. 已确认项

- 彻底脱离 Strapi：base 完全独立，basic 仓库与 16 个 `zhao-*` 插件全部退出本项目。
- 内容来源：**一次性迁移**，此后 base 自持内容（P0 用命令行导入，可视化后台 P2）。
- 身份：**base 自建账号 + JWT**（EdDSA），与 SSO 及积分体系不连通。
- 节点形态：**单进程自包含**（内容库 + 公开读 + 同步 + 账号 + 浏览页同一进程）。
- 节点运行时：**Go 静态单文件**（纯 Go SQLite，无 CGO），本地电脑与服务器同构部署。
- 远端仓库：`git@github.com:johocn/base.git`。

## 14. 迁移源契约（Strapi 文章，一次性）

已核实（来源：`basic/plugins/zhao-website`）：

| 项 | 事实 |
|---|---|
| 列表端点 | `GET {STRAPI}/api/zhao-website/v1/articles?page=&pageSize=&sort=` |
| 详情端点 | `GET {STRAPI}/api/zhao-website/v1/articles/:slug` |
| 鉴权 | 路由为 `publicRoute`（`auth: false`），但**附加了 `plugin::zhao-auth.has-channel-scope` 策略**；匿名可用性须以 curl 实测为准，必要时携带站点/渠道标识或 API token（迁移工具需支持可选 header 配置） |
| 分页返回 | Strapi 5 结构 `{ data, meta: { pagination: { page, pageSize, pageCount, total } } }` |
| 正文字段 | `content`，类型 `text`（**不是** blocks JSON），按原文存入 `articles.body_md` |
| 其他字段 | `documentId`、`title`、`slug`、`excerpt`、`coverImage`(media)、`category`、`tags`、`status`、`publishedAt`、`updatedAt` |
| 只迁移 | `status = published` 的文章 |

P0 迁移边界：

- 正文 `content` 原样搬运，不做格式转换；正文内嵌图片保留原始 URL，**离线不保证显示**（P1 处理）。
- 封面 `coverImage` 作为 `type=cover` 条目导出为块；缺失时跳过，不阻塞迁移。
- 迁移工具必须可重跑：以 `(source, item_id)` 为幂等键，重跑覆盖同一条目并刷新 `source_rev`。
- 迁移后不保留对 Strapi 的任何运行时依赖；`STRAPI` 基址仅作为迁移工具入参。
- 迁移工具的第一步是 curl 探测端点与所需 header，实测结论写入 `tools/migrate/README.md`，后续解析按实测响应结构对齐。