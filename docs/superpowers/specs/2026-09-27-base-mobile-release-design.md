# base 手机端发布版设计（v1 发布册子）

- 日期：2026-09-27
- 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`（唯一上游，冲突时先改总纲）
- 范围：**底部菜单（tabBar）· 本地搜索 · 收藏与已读 · 阅读器排版 · App 升级通道**
- 本册子**不覆盖**：节点侧分发（归 `2026-09-26-base-content-distribution-design.md`）；课程层级建模（#6）；学习进度上报与互动形态（#7–#10）；本地库加密（#4）；账号与设备身份上行

## 0. 改版说明

### 0.1 2026-09-27 初版

**新增（本册子首次定义）：**

- 手机端信息架构：4 个 tab 页 + 1 个非 tab 详情页（§3）
- 本地表 `user_state`（收藏 / 已读），以及它与总纲 §8.1 `progress` 的边界（§2.3、§4）
- 本地正文搜索的查询口径与转义规则（§5.2）
- 阅读器排版范围（字号 / 行距 / 主题 / 进度条）（§5.4）
- 签名 `release` 文档格式与 `GET /v1/release` 接口（§6）
- 升级判定规则与失败语义（§6.4）
- 手机端发布流程（§7）

**明确沿用、不改动：**

- 内容包规范 v1（`manifest.json` 字段与类型、`pack.sqlite` 表结构），见总纲 §6
- 公开读四接口 `GET /v1/catalog` / `/v1/manifest/:pack_id` / `/v1/pack/:pack_id` / `/v1/blob/:blob_id`（总纲 §7.3）
- 客户端↔节点**明文 HTTP**（F1 定案，总纲 §12.2）；签名而非传输层是资产完整性的信任来源
- 本地库表集合（总纲 §8.1）——本册子只**新增** `user_state`，不改任何既有表的列
- `manifest` 的签名字节口径：`canonicalize(去掉 signature 的文档)`（总纲 §6.4）

## 1. 范围与不做什么

**做五件事：**

1. 信息架构：把「内容 / 搜索 / 收藏 / 设置」落成原生 tabBar 四个 tab，文章详情仍为独立页。
2. 本地搜索：对已同步内容做离线全文匹配，零网络、零新接口。
3. 收藏与已读：本地私有状态，换机不保留。
4. 阅读器排版：字号三档、行距、浅色/深色、阅读进度条。
5. 升级通道：节点签发 `release` 文档，App 验签比对版本并提示下载。

**明确不做：**

- **不做 markdown 解析**。现有正文（`seed/*.md` 与 Strapi 迁移内容）除 front-matter 外全是纯段落，解析这版没有可见收益；真出现带标题/列表的正文时另出册子。
- **不做滚动位置恢复**：只做「已读」标记与顶部进度条。
- **不做全站深色主题**：主题只作用于文章页（阅读场景）。
- **不做 FTS5**：内容量在几十至几百篇时 `LIKE` 足够，且不赌 Android 系统 SQLite 是否编入 FTS5。
- **不做 wgt 资源包热更新**：service/view 版本错配的排查成本高于它省下的那次装机。
- **不做 App 内下载 APK 与 `plus.runtime.install`**：本版走浏览器打开下载链接（§6.5）。
- **不做账号 / 设备身份 / 用户数据上报**：`user_state` 纯本地，不产生任何上行流量。
- **不做 tabBar 图标**：本版纯文字；补图标是同处改动，不预留结构。
- 不做内容分发的任何节点侧改动（除 §6.3 新增的一个只读接口）。

## 2. 契约边界

### 2.1 不可改（任何实现都不得偏离）

| 项 | 约束 | 出处 |
|---|---|---|
| 客户端↔节点传输 | **明文 HTTP**，不引入 TLS/HSTS | 总纲 §12.2（F1） |
| 公开读四接口 | 路径、响应结构、`ETag` 语义不变 | 总纲 §7.3 |
| `manifest` 签名字节 | `canonicalize(去掉 signature)`；键必须 ASCII、数字必须整数 | 总纲 §6.4 |
| 既有本地表 | `config` / `items` / `articles` / `blob_index` / `tombstone` 列不变 | 总纲 §8.1 |
| 版本裁决 | 内容以签名 `content_version` 为准，大者胜 | 总纲 §1、§6.5 |
| 同步顺序不变量 | 验签 → 校验 pack → 拉块 → 一次性落库；任一步失败不留半截数据 | 现有 `syncOnce` |

### 2.2 允许新增（v1 之外）

- 本地表 `user_state`（§4）+ `config` 的两个新键 `reader_theme` / `reader_font_scale`。
- 节点只读接口 `GET /v1/release`（§6.3）。
- 命令行子命令 `based release`（§6.3）。
- 手机端页面 `pages/search/search`、`pages/favorite/favorite`；`pages.json` 的 `tabBar` 段。
- 协议侧新对象 `release` 文档与它的黄金向量（`vectors/v1/release.json`）。
- 手机端 `src/core/update.ts`。

### 2.3 与总纲 §8.1 `progress` 的关系（本册子定案）

总纲 §8.1 已有 `progress(item_id, position, updated_at, dirty)`，语义是**学习进度**，`dirty` 标志意味着它最终要向上报（归 #7–#10）。本册子的 `user_state` 只服务阅读器的本地体验（收藏 / 已读），**不写 `dirty`、不参与任何上报**。

两者**不合并**：一旦合并，同一张表里会同时存在「纯本地私有」与「待上报、需冲突合并」两种语义，后续 #7 落地时必须做一次数据迁移与语义拆分。分开建表，代价是一张空表。

## 3. 信息架构与路由

`pages.json` 的 `pages` 顺序即启动页与 tab 顺序：

| # | 路径 | tabBar 文字 | 说明 |
|---|---|---|---|
| 1 | `pages/index/index` | 内容 | 现有列表 + 同步，**删除**底部「节点设置」文字链 |
| 2 | `pages/search/search` | 搜索 | 新增 |
| 3 | `pages/favorite/favorite` | 收藏 | 新增 |
| 4 | `pages/setting/setting` | 设置 | 现有页面，作为 tab 页进入 |
| 5 | `pages/article/article` | —— | **非 tab**，`navigateTo` 打开 |

`tabBar` 配置（不配 `iconPath` / `selectedIconPath`，纯文字）：

```json
{
  "color": "#888888",
  "selectedColor": "#2b6cb0",
  "backgroundColor": "#ffffff",
  "borderStyle": "black",
  "list": [
    { "pagePath": "pages/index/index", "text": "内容" },
    { "pagePath": "pages/search/search", "text": "搜索" },
    { "pagePath": "pages/favorite/favorite", "text": "收藏" },
    { "pagePath": "pages/setting/setting", "text": "设置" }
  ]
}
```

两条硬约束（uni-app 平台行为，不是设计选择）：

1. **tab 页之间只能用 `uni.switchTab`**。`navigateTo` / `redirectTo` 指向 tab 页会失败。因此 [index.vue](file:///e:/code/base/apps/mobile/src/pages/index/index.vue) 底部的「节点设置」文字链必须删除或改 `switchTab`；本册子选删除（设置已是 tab）。
2. **tab 页不能带 query 参数**。文章详情保持 `navigateTo('/pages/article/article?itemId=' + encodeURIComponent(itemId))`，从任意一个 tab 页进入都回到该 tab。

## 4. 本地数据层

### 4.1 新表

`SCHEMA_SQL` 追加一条 `CREATE TABLE IF NOT EXISTS`，对已有库是幂等增量，**不需要迁移脚本**：

```sql
CREATE TABLE IF NOT EXISTS user_state (
  item_id      TEXT PRIMARY KEY,
  favorited_at TEXT,   -- ISO8601，NULL = 未收藏
  read_at      TEXT    -- ISO8601，NULL = 未读
);
```

- 不出现在 `user_state` 里的 `item_id` 等价于「未收藏、未读」。
- 取消收藏 = `favorited_at` 置 `NULL`（不删行，保留 `read_at`）。
- 收藏列表**不 JOIN `user_state` 反查标题**，而是 `user_state INNER JOIN items ON item_id`。语义：条目被节点撤下（tombstone 删 `items` 行）后，收藏自动从列表消失，不需要额外清理逻辑；恢复重新发布则自动回来。

### 4.2 阅读偏好

放现有 `config` k/v，不新增表：

| 键 | 取值 | 缺省 |
|---|---|---|
| `reader_theme` | `light` / `dark` | `light` |
| `reader_font_scale` | `1` / `2` / `3`（小 / 中 / 大） | `2` |

读取时任何非预期取值一律回落到缺省值（不做校验报错）。

### 4.3 repo 新增方法

| 方法 | 语义 |
|---|---|
| `toggleFavorite(itemId, at): Promise<boolean>` | 取反并返回新状态（`true` = 已收藏） |
| `isFavorite(itemId): Promise<boolean>` | —— |
| `listFavorites(): Promise<{itemId, title, favoritedAt}[]>` | `favorited_at DESC`，`INNER JOIN items` |
| `markRead(itemId, at): Promise<void>` | 幂等 upsert；已读不重复覆盖（保留首次时间） |
| `searchArticles(q): Promise<ArticleRow[]>` | 见 §5.2 |

## 5. 页面

### 5.1 内容（`pages/index/index`）

保持现状：列表（`listItems()` 过滤 `type === 'article'`）+ 同步按钮 + 提示/错误行。仅删除底部「节点设置」文字链（§3 约束 1）。

### 5.2 搜索（`pages/search/search`）

- 交互：输入即搜（`@input` 触发），纯本地查询，零网络。
- 查询（占位符只用匿名 `?`，因为 `sqlWithParams` 是单遍替换、不支持 `?1` 编号形式；同一模式串出现三次即传三个参数）：

```sql
SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev
FROM articles
WHERE title LIKE ? ESCAPE '\' OR body_md LIKE ? ESCAPE '\'
ORDER BY (title LIKE ? ESCAPE '\') DESC, published_at DESC
LIMIT 50
```

- 转义（必做）：模式串 = `'%' + escapeLike(q) + '%'`，其中 `escapeLike` 把 `\` → `\\`、`%` → `\%`、`_` → `\_`。不做这步的话，输入一个 `%` 会命中全部内容、输入 `_` 会匹配任意单字符。
- 空输入：直接返回空数组，**不发查询**（避免一次全表扫描）。
- 结果项：标题 + `digest` 摘要；点击 `navigateTo` 文章页。
- 空态分两种：本地 `articles` 为空 → 「还没有内容，先去内容页同步」；有内容但无命中 → 「没搜到」。
- 搜索域是 `articles` 表（含正文），不是 `items` 表 —— 与文章详情的数据来源一致。

### 5.3 收藏（`pages/favorite/favorite`）

- `listFavorites()`，`favorited_at DESC`。
- 结果项：封面缩略（`blob_index` 里 `cover:<slug>` 的路径，缺失则不显示）+ 标题 + 收藏时间。
- 空态：「还没有收藏，在文章页点收藏会出现在这里」。
- 点击 `navigateTo` 文章页；页面 `onShow` 重新加载（从文章页取消收藏返回后要立刻消失）。

### 5.4 文章 · 阅读器（`pages/article/article`）

结构自上而下：

1. 封面图（`cover:<slug>` blob，已有逻辑，缺失则整块不渲染）
2. 标题 / 发布时间 / tags
3. 操作行：**收藏**（切换态）、**A**（循环切字号）、**主题**（浅/深切换）
4. 正文段落（沿用现有 `\n\n` 切分 + 去空段）
5. 顶部 1px 阅读进度条（滚动比例，纯前端计算，不落库）

规则：

- 进入即 `markRead(itemId, now)`；`read_at` 只写首次（`COALESCE` 语义），重复进入不覆盖。
- 字号三档映射到正文 `font-size`，行距固定 `1.8`，段间距用 `margin-bottom`。
- 深色主题只改本页的颜色（背景 / 文字 / 分割线）；tabBar 与其它页保持浅色。
- 收藏按钮的切换立即写库，不做二次确认、不做 toast。
- 现有 `decodedId` 兜底（原样查不到再按 `decodeURIComponent` 查一次）保留。
- 「本地没有这篇正文，请返回先同步」这条错误文案保留，作为同步失败的可观察出口。

### 5.5 设置（`pages/setting/setting`）

现有内容（节点地址 / 公钥 / 保存 / 能力诊断）不变，新增两块只读展示 + 一个动作：

- 「当前版本」：`plus.runtime.version`（H5 预览下显示 `-`）
- 「检查更新」按钮 + 结果行（§6.4）
- 「升级包摘要」：最新 `release` 文档里 `apk_sha256` 的前 16 位（有人工核对价值，见 §6.5）

## 6. App 升级通道

### 6.1 约束来源

`release` 是**签名文档**，签名字节口径与 `manifest` 一致：`canonicalize(payload)`，其中 payload = 文档去掉 `signature`。由此继承两条硬约束：

- 对象**键**必须 ASCII（`canonicalize` 对非 ASCII 键直接抛错）；
- 数字必须是**有限整数**，不得用浮点。

值的限制只有一条：**不要把中文排除在外**——`manifest.entries[].title` 本身就是中文且真机验签已通。故 `notes`（版本说明）可以直接进签名载荷，不需要拆到签名之外。

### 6.2 `release` 文档

```json
{
  "payload": {
    "schema_version": 1,
    "issuer": "base-node-1",
    "issued_at": "2026-09-27T00:00:00Z",
    "version_name": "0.2.0",
    "min_version_name": "0.1.0",
    "apk_url": "http://node.example.com/dl/base-0.2.0.apk",
    "apk_size": 12345678,
    "apk_sha256": "<64 hex>",
    "notes": "底部菜单、搜索与收藏；修复正文同步"
  },
  "signature": "<128 hex>"
}
```

| 字段 | 类型 | 语义 |
|---|---|---|
| `schema_version` | int | 固定 `1`，不符即判为不可用 |
| `issuer` | string | 签发方标识，取自节点自身 |
| `issued_at` | string | 签发时间（人可读） |
| `version_name` | string | 最新版本名，三段数字 `x.y.z` |
| `min_version_name` | string | 最低可用版本；本地低于它 → 强制更新 |
| `apk_url` | string | APK 下载地址（绝对 URL，指向静态目录，见 §10） |
| `apk_size` | int | APK 字节数 |
| `apk_sha256` | string | APK 的 sha256（64 hex），供人工核对 |
| `notes` | string | 版本说明，**参与签名**，允许中文 |

`payload` 与 `signature` 分离（而不是像 `manifest` 那样平铺 + 去字段）的原因：`notes` 是自由文本，平铺 + 去字段的口径要求签名方与验签方对「哪些字段参与」有完全一致的隐含约定，容易漂移；显式包一个 `payload` 对象后，签名域就是 `payload` 的字面内容，没有隐含约定。

### 6.3 节点侧

**`GET /v1/release`**（公开读路由，挂在客户端监听上）

- 读 `<data>/release.json`，原样吐出（`Content-Type: application/json`）。
- 文件不存在 → **404**。App 把 404 当作「本节点无升级信息」，静默忽略。
- 节点**不做**任何验签、不缓存、不合成：它只是把签发好的文件读出来。

**`based release`**（离线命令，在源节点机器上跑）

```
based release -version-name 0.2.0 [-min-version-name 0.1.0] -apk-url <url> -apk-file <本地 apk 路径> [-notes <文本>] [-out <path>] [-data <dir>]
```

- 从 `-apk-file` 计算 `apk_size` 与 `apk_sha256`（避免手填出错）。
- 用**源节点私钥**（与签发 manifest 同一把）对 `payload` 签名，写 `<data>/release.json`（`-out` 可覆盖）。
- 幂等：重复执行覆盖写，不追加历史。

### 6.4 客户端流程与失败语义

触发点：`onLaunch` 一次 + 设置页「检查更新」按钮。

1. `GET {nodeBaseUrl}/v1/release`。
2. 200 → 解析 → 用**装机时已填的节点公钥**（`config.pubkey_hex`）验签（§6.2 口径）。
3. `plus.runtime.version` 与 `version_name` / `min_version_name` 做**三段数值比较**（按 `.` 切分，段数不等时缺位按 0；任一段非数字则该文档判为不可用）。
4. 判定：

| 情形 | 行为 |
|---|---|
| 验签失败 / `schema_version != 1` / 版本串不合法 | 静默丢弃，不提示（可能是被篡改，也可能是协议未来版本） |
| 网络失败 / 404 / 未配节点地址与公钥 | 静默丢弃 |
| `version_name <= 本地` | 无提示（设置页结果行显示「已是最新 0.1.0」） |
| `version_name > 本地` 且 `min_version_name <= 本地` | 可取消弹窗：说明 + 「去下载」/「以后再说」 |
| `version_name > 本地` 且 `min_version_name > 本地` | 不可取消弹窗：只有「去下载」 |

**红线：升级通道的任何失败都不得阻断 App 使用。** 不弹错误框、不写 `error` 状态、不拦启动流程。理由是节点是明文 HTTP，升级通道被中间人破坏的概率不为零，不能让它成为一个可被用来 DoS 客户端的入口。

### 6.5 下载方式与残余风险

弹窗确认后 `plus.runtime.openURL(apk_url)`，交给系统浏览器 / 下载器。

**残余风险（明确记录，不粉饰）**：App 无法校验下载到的 APK 字节，Android 的「安装未知应用」流程也不做完整性校验。因此一条主动的中间人可以：

- **不能**改 `apk_url`（它在签名载荷里）——攻击者无法把用户引到自己的服务器；
- **能**在用户从本节点下载 APK 的过程中替换 APK 字节。

缓解手段只有两个：设置页展示 `apk_sha256` 前 16 位供人工核对（有心人才会用），以及节点与客户端之间实际的网络环境（同城、家庭/办公网络）。彻底堵住需要 §1 明确不做的「App 内下载 + 校验 + `plus.runtime.install`」——留待下版评估。

## 7. 发布流程

1. HBuilderX 云打包出 APK（`versionName` / `versionCode` 在 `manifest.json` 里递增）。
2. APK 上传到节点机器的静态目录（URL 前缀见 §10）。
3. 在节点机器上跑 `based release -version-name <新版本> -apk-file <上传后的 apk 路径> -apk-url <公网 URL>`。
4. 手机装新版 → 设置页「检查更新」应显示「已是最新」。
5. 反向验证：在节点上把 `release.json` 的 `version_name` 改成更高版本（或改 `signature` 一位）→ 前者应弹更新框，后者应被静默拒绝。

## 8. 验收

| # | 验收项 | 判定 |
|---|---|---|
| 1 | 底部菜单 | 装机后四个 tab 可互相切换；从任一 tab 进文章再返回，回到原 tab；无 tab 用 `navigateTo` 的报错 |
| 2 | 搜索 | 输入正文中出现过的词 → 命中该文章；输入 `%` → 不返回全部；输入空串 → 结果为空且响应即时 |
| 3 | 收藏 | 收藏 → 收藏 tab 出现；取消 → 立即消失；杀进程重进仍保持；文章被节点撤下并同步后自动消失 |
| 4 | 阅读器 | 字号三档可切且重启后保持；深色主题重启后保持；进入文章后 `read_at` 只写首次 |
| 5 | 升级·正常 | 节点 `release.json` 版本高于本地 → 弹可取消框；点「去下载」能打开 `apk_url` |
| 6 | 升级·强制 | `min_version_name` 高于本地 → 弹不可取消框 |
| 7 | 升级·拒绝 | 改 `signature` 一位 / 改 `version_name` 后不重签 → 静默无提示，App 正常可用 |
| 8 | 升级·可用性 | 节点宕机 / 未配公钥 → 启动与设置页均不出现任何升级相关错误 |
| 9 | 离线不回归 | 飞行模式下：内容列表、搜索、收藏、读正文全部可用 |
| 10 | 单测与向量 | `user_state` 五个方法与 `searchArticles` 转义全绿；`vectors/v1/release.json` 在 Go 与 TS 两侧同时消费通过 |

## 9. 风险与红线

1. **升级通道是唯一的新入口，且跑在明文 HTTP 上**：处置 = 签名 + 静默失败（§6.4）。任何让升级检查阻断启动或弹出错误框的实现都视为红线。
2. **APK 字节无端到端校验**（§6.5）：本版接受的取舍；下版若要堵，须走 App 内下载 + 校验 + `install`。
3. **`min_version_name` 是单点**：一旦签发一个高于现状的 `min_version_name`，所有老客户端立刻被强更拦住。签发命令不提供默认值，必须显式传；且它进签名载荷，改它必须重新签发。
4. **搜索的 `LIKE` 全表扫描**：正文总量进入几十 MB 量级后，`body_md` 上的 `LIKE` 会明显变慢。届时的处置优先级是「先在 `title` 上查，无命中再查 `body_md`」，而不是直接上 FTS5。
5. **tabBar 纯文字的观感**：本版刻意接受；补图标是同处配置改动，不影响结构。
6. **`user_state` 换机即丢**：这是本册子 §2.3 的定案，不是缺陷。用户重装后需重新收藏。

## 10. 待定与未闭环

- **静态目录的 URL 前缀**：APK 在服务器上的目录与 nginx `location` 的对应关系尚未进仓库（当前只存在于服务器）。落地时确认后写入本节，并让 §7 的命令示例使用真实 URL。
- **`issuer` 的取值口径**：`payload.issuer` 本版只作人可读标识，验签**不**校验它与节点公钥的绑定关系（`manifest` 的 `issuer` 由 `derived_pack_id` 间接绑定）。若要严格绑定，需要 `pubkey_hex → issuer` 的映射来源，本版不做。
- **`notes` 的展示形态**：本版弹窗里直接显示纯文本，不做换行与长度限制。超长说明会被截断。
- **`versionCode` 不参与判定**：Android 的 `versionCode` 只影响系统升级安装，App 侧判定只用 `version_name` 三段比较。两处必须人工保持同步递增。