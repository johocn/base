# base 分布式学习系统设计

- 日期：2026-09-25
- 仓库：`e:\code\base`（远端 `git@github.com:johocn/base.git`，已 `git init` 并绑定 `origin`）
- 依赖：`e:\code\basic`（Strapi + 16 个 `zhao-*` 插件，内容与身份的权威源）
- 客户端：uni-app（Android 优先）

## 1. 目标

让客户用手机 App 访问 Strapi 中的「可分发内容」（文章、课程视频等），把内容下载到本地随时离线查看；内容在多个 SQLite 节点间分布存储，节点消失后可由邻居按内容哈希补齐。

## 2. 明确不做（排除范围）

- 不做区块链、共识、token、DHT。
- 受控内容（需鉴权/加密的付费或内部内容）不进入 base，base 不缓存、不索引、不转发其字节。
- 不做内容级授权与加密：可分发内容对匿名（guest）开放。
- 一期不做 iOS（离线文件与后台下载受限）。

## 3. 硬性分界：可分发 vs 受控

| 维度 | 可分发内容（= 指定内容） | 受控内容 |
|---|---|---|
| 是否进 base 内容包 | 是 | 否，base 完全不碰 |
| 加密 | 不加密，明文分块 | 走现有通道（如 zhao-oss 签名 URL） |
| 鉴权 | 登录、匿名均可下载 | 现有 Strapi 权限体系，在线 |
| 复制 / 近场互传 | 允许，节点可任意缓存 | 不允许分发 |

铁律：

1. base 只处理 `dist_class = public` 的内容；判定由 `base` 依据现有内容字段/标签完成，判定结果写入 `manifest` 并签名。
2. public 内容不加密、不鉴权、允许任意复制与近场互传。**public 等于全网可复制转存，这是模式固有前提，不是缺陷。**
3. 受控内容的字节不得进入内容包、节点块目录或客户端本地库。

## 4. 访问模型

| 操作 | 要求 |
|---|---|
| 读：`catalog` / `manifest` / `pack` / `blob` | 匿名开放，无需登录 |
| 携带 SSO token 的读 | 仅用于归因（分享/推荐/统计），不影响是否可读 |
| 写：评论、分享 id、学习进度 | 需 SSO 身份（复用 `zhao-sso`，`app_code=base`） |
| 节点间：`inventory` / `sync` / `scrub` | 预共享密钥，不对外 |
| 审核取正文 | 审核密钥，仅运营侧 |

guest 路径：未注册用户打开 App 即可浏览目录、下载与离线查看全部分发内容；仅在发评论、记进度、领分享奖励时触发 SSO 登录。

## 5. 系统构成

```
L0 权威层  basic/plugins
   zhao-sso（身份）· zhao-auth · zhao-website/zhao-course/zhao-tag/zhao-quiz/zhao-oss（内容）
   zhao-point（分享）· base（新增插件，薄编排：聚合作者内容 → 生成包 → 签名 → 登记副本索引 → 签发 event id）
L1 协议层  base/packages/protocol   （TS 类型 + 哈希/Merkle + 签名验签 + pack 读写）
L2 节点层  base/apps/node           （Node + better-sqlite3，边缘节点服务）
L3 客户端  base/apps/mobile         （uni-app，Android 优先）
```

### 5.1 与 basic 的耦合规则

- `base` 只允许调用各插件现有的只读门面服务（`gate.ts`）与其 HTTP 接口，**严禁跨表直查**（zhao-sso 表隔离铁律）。
- `base` 不重复实现任何业务逻辑，只做聚合、签名、签发与索引。
- 除 `base` 外，base 不写入 basic 任何数据。

## 6. 内容包规范 v1

一个内容包 = `manifest.json` + `pack.sqlite` + 块文件（按哈希命名）。

### 6.1 `manifest.json`

| 字段 | 说明 |
|---|---|
| `pack_id` | 包标识 |
| `schema_version` | 固定 `1` |
| `issuer` | 签发方标识 |
| `issued_at` | 签发时间 |
| `content_version` | **全局**单调递增（每次导出 +1），冲突时大者胜 |
| `entries[]` | 条目清单 |
| `tombstone[]` | 撤回清单 `{item_id, revoked_rev}` |
| `merkle_root` | 所有 `blob_id` 排序后构树的根 |
| `signature` | Ed25519 签名（覆盖上述字段的规范化 JSON） |

`entries[]` 单项：

| 字段 | 说明 |
|---|---|
| `item_id` | 条目 id（来自各插件内容 id） |
| `plugin` | 来源插件，如 `zhao-website` / `zhao-course` |
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

### 6.3 块与寻址

- 视频按定长 1 MiB 分块；文本与小资源整块处理。
- `blob_id = hex(sha256(bytes))[0:32]`（128 bit）。评论/事件正文同样按此寻址，事件字段 `payload_cid` 即该 `blob_id`，两者是同一个 id。
- 节点磁盘布局：`data/blobs/<h0..1>/<h2..3>/<blob_id>`，内容寻址 → 任何来源的块天然可验真，内容一变哈希即变。
- 因此**不需要共识与链**：「区块链式」在此仅体现为哈希寻址 + Merkle 清单 + 多副本。

### 6.4 签名与验签

`base` 用 Ed25519 私钥签 `manifest`；客户端与节点内置公钥验签。验签失败 → 整包拒绝。manifest 与 pack.sqlite 的行级 `content_hash` 双重校验，任一不符即判坏块。

### 6.5 版本与墓碑

- 导出触发：`base` 定时或手动导出增量包，并递增全局 `content_version`。
- 内容更新 → `content_version` 递增，客户端按版本覆盖本地。
- 内容下架/删除 → 新版本 manifest 带 `tombstone`；客户端同步时删除对应本地行与块；节点同样删除，且墓碑**只能在签名 manifest 中传播**，节点无法伪造。

## 7. 边缘节点设计

### 7.1 目录布局

```
data/base.db          # 文本/索引/事件/副本登记
data/blobs/xx/yy/<id> # 块文件
```

### 7.2 接口

公开（匿名）：

| 接口 | 说明 |
|---|---|
| `GET /v1/catalog?since=&cursor=` | 可分发内容目录（item_id/type/content_hash/rev）分页 |
| `GET /v1/manifest/:pack_id` | 取 manifest |
| `GET /v1/pack/:pack_id` | 取 pack.sqlite |
| `GET /v1/blob/:blob_id` | 取块 |
| `HEAD /v1/blob/:blob_id` | 存在性（近场互传秒传判定） |
| `POST /v1/event` | 提交评论/分享/进度事件，需 SSO token |

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

### 7.3 反熵与节点恢复

1. 节点每 5 分钟向邻居取 Merkle root。
2. root 相同 → 本轮回合结束。
3. root 不同 → 拉邻居 inventory 分页，比对本地集合，得出 `missing` / `extra`。
4. `missing` → `POST /v1/fetch` 批量拉取 → 逐块重算 sha256 校验 → 入库 → 回报 `base` 副本索引。
5. `extra` 仅记录，不主动删除（避免误删唯一副本）。

**恢复语义**：节点消失后不需要投票、不需要重建链——剩余节点或客户端查副本索引/邻居清单，发现该哈希仍有人持有即拉回，校验通过即恢复。只要全网还有 1 份副本就能恢复。副本因子默认 2：某块登记位置少于 2 时，节点主动向邻居补齐；淘汰块前必须确认别处存在副本。

### 7.4 scrub 自愈

每日全量重算哈希，发现坏块 → 删除本地副本 → 从邻居补齐 → 更新副本索引。

## 8. 手机端设计

### 8.1 本地 SQLite

本地库用 `plus.sqlite`，块下载用 `plus.downloader`，块文件存应用私有目录。

| 表 | 用途 |
|---|---|
| `config(key, value)` | 节点地址、公钥 |
| `items(item_id, type, title, rev, content_hash, state, updated_at)` | 目录快照 |
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

## 9. 评论 / 分享 / 进度

- 客户端生成本地事件：`{type, target_id, actor, payload, causal_parent}`，正文作为 blob 存节点。
- 评论正文按 `payload_cid` 公开可读（同 `GET /v1/blob/:blob_id`），不做读取鉴权。
- 服务器只保留：**全局 `event_id` + `payload_cid` + 副本索引 + 审核状态**；正文不落 Strapi。
- 写路径：客户端 `POST /v1/event`（带 SSO token）→ 节点存正文 blob 并校验 token → 转发 `base` 签发 `event_id` → 回填客户端。
- 分享归因：分享链接携带 `share_id`，服务器只记 id 与点击；guest 分享仅统计，登录后分享可接入 `zhao-point` 奖励。
- 审核：先发后审。运营经审核通道按 `payload_cid` 取正文；结论 `rejected` → 删块 + 写入墓碑 → 客户端下次同步删除。
- 合并规则：内容以 `base` 的 `content_version` 为准（大者胜）；事件按因果序 + LWW 合并。

## 10. 分期与验收

| 阶段 | 范围 | 验收 |
|---|---|---|
| P0 | 协议 + `base` 文章导出 + 单节点 + 手机端离线读文章 + guest 匿名访问 | 无 token 可拉 `catalog`/`pack`/`blob`；手机断网可读已下载文章 |
| P1 | 视频分块 + 多节点反熵 + 邻居补齐 + scrub + 墓碑同步 | 3 节点 docker 杀 1 个 → 剩余节点补齐缺失块、哈希校验通过、副本索引恢复为 2；篡改 1 bit → 客户端拒绝加载 |
| P2 | 评论/分享/进度事件 + 审核通道 + 近场互传 | 离线写评论 → 联网补 `event_id`；`rejected` → 设备删除 |

范围约束：**实施计划一期只覆盖 P0**；P1、P2 在 P0 验收通过后各自另出 spec 与计划。

## 11. 验证方案

- 协议层单测：哈希、Merkle root、签名验签、pack 读写（黄金样本回归）。
- 恢复 E2E：3 节点 docker compose，杀节点 → 断言补齐与校验。
- 篡改检测：改动 1 bit → 拒绝加载。
- 真机：Android 断网阅读、下载中断续传、guest 匿名全流程。

## 12. 红线与风险

1. public 即全网可复制转存——已接受，不可作为后续抱怨点。
2. 明文视频必然可被翻录——已接受（不做包内加密）。
3. 节点公开读接口等于内容完全公开——需重点防护的是**写接口与内部接口**。
4. 2G 服务器禁止 `npm run build`：节点服务与 uni-app 一律本地构建后 scp。
5. 表隔离铁律：`base` 只能调门面服务，禁止跨表直查。
6. 磁盘增长：节点需容量上限 + LRU 淘汰，淘汰前确认别处存在副本。
7. iOS 一期不做。

## 13. 已确认项

- 插件的名字用 `base`（`basic/plugins/` 下现存 16 个插件均为 `zhao-*`，无 `base` 占用，2026-09-25 确认）。
- 插件落位 `basic/plugins/base`。