# base App 基座自检与功能级降级设计

* 日期：2026-09-27

* 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`（唯一上游，冲突时先改总纲）

* 直接上游：`specs/2026-09-27-base-mobile-release-design.md`（发布链路与设置页）、`specs/2026-09-27-base-comment-event-sync-design.md`（§6 客户端约定、§3.4 事件签名）

* 范围：**平台能力探测（12 条）· 自检页 · 能力标志与功能级降级 · 单测与真机验收**

* 本册子**不覆盖**：离线发表队列（断网先入队、联网补发）；联网后拉取他人新评论的行为约定；节点侧任何改动；能力上报；自检结果的持久化历史

## 0. 改版说明

### 0.1 2026-09-27 初版

**动机（本册子存在的唯一理由）**：0.4.1 修掉的「发表评论 → 提交失败，请稍后重试」，根因是 **uni-app 的 App 逻辑层跑在 V8 / jscore 而非 WebView**，因此没有 `crypto`（也没有 `TextEncoder`、`window`、`URLSearchParams`）；noble 的 `randomBytes` 探测 `globalThis.crypto` 必然失败并抛裸 Error。这类错误的共同形态是：**平台能力假设未在真机验证过 → 真机报通用错误 → 只能靠读构建产物反推**。每一轮猜测的代价是一次云打包 + 装机 + 复现。

因此本册子的目标不是「加一个诊断工具」，而是：**把平台能力从推断变成一次装机就能读到的证据，并让不可用的能力直接体现为对应功能的显式降级**。

**新增（本册子首次定义）：**

* 能力标志 `CapabilityFlags` 与「只有明确 `fail` 才降级」的取值约定（§4）

* 探测条目表 12 条与其判定口径、影响功能映射（§3）

* 自检页 `pages/selfcheck/selfcheck` 与设置页入口（§6）

* 报告结构、单条超时与降级报告（§5）

* 自检的污染控制口径（§7）

**明确沿用、不改动：**

* `core/*` 不 import `uni` / `plus`、平台能力一律经 `platform/adapter.ts` 注入的约定（`2026-09-27-base-mobile-release-design.md` §7）

* 设置页既有「能力诊断」（`pages/setting/setting.vue` 的 `probe()`）：仍是开发向的原始行输出，本册子**不替换它**，只在旁边加自检入口

* `POST /v1/event` 的准入语义与 `event_id` 幂等（运行在 `INSERT ... ON CONFLICT(event_id) DO UPDATE`）

* 评论读接口 `GET /v1/comment` 的 `target_id` / `cursor` / `limit` 分页

* 升级文档拉取与验签（`GET /v1/release` + `verifyRelease`）

## 1. 目标与判定

| # | 目标 | 判定 |
|---|---|---|
| 1 | 装机后能一次看清哪些平台能力可用 | 自检页一屏出 12 条结果，每条带真实原因 |
| 2 | 能力不可用时，对应功能不再等用户操作才报错 | 4 类功能在 `flags` 为 `fail` 时入口禁用并原位说明（§4） |
| 3 | 自检本身不污染设备与节点 | 除第 10 条外不写任何持久状态（§7） |
| 4 | 自检本身可测 | 12 条探测在 Node 下用 `fakes` 跑通，含「只坏一条」「超时」「无本地库」三条路径（§8） |

**非目标**：不做能力上报、不做历史记录、不做自动修复、不做性能基准。

## 2. 架构

新增 3 个文件、改动 2 个：

| 路径 | 内容 |
| --- | --- |
| `apps/mobile/src/core/selfcheck.ts`（新增） | 探测定义与执行：`CheckItem` / `runSelfCheck` / `CapabilityFlags` / 报告类型 |
| `apps/mobile/src/core/selfcheck.test.ts`（新增） | 上者的单测（§8） |
| `apps/mobile/src/pages/selfcheck/selfcheck.vue`（新增） | 展示、复制、重跑；`pages.json` 注册 |
| `apps/mobile/src/platform/index.ts` | `AppContext` 增加 `capabilities`（`CapabilityFlags`）；`bootstrap()` 用随机池预填结果设 `cryptoOk` 初值 |
| `apps/mobile/src/pages/setting/setting.vue` | 诊断按钮旁加「自检」入口 |

**依赖方向**：`selfcheck.ts` 只依赖 `AppContext`（`adapters` / `repo` / `db`）与 `platform/adapter.ts` 的接口类型，**不 import `uni` / `plus`**。

**平台探针靠注入，不靠 core 反向依赖平台层**：条目 11（`plus.runtime.openURL` 存在性）与条目 12 的 `btoa`/`atob` 往返属于平台能力，由**页面**（可以 import `platform`）构造成一组 `platformProbes: CheckItem[]` 传进 `runSelfCheck`。core 只负责调度、超时、标志聚合；Node 单测里传一组假探针即可，无需碰 `plus`。

**不在启动时跑全量自检**：冷启动只做随机池预填（既有行为），其成败即 `cryptoOk` 初值；其余标志保持 `unknown`，等自检页跑完才定。自检页由用户主动进入。

## 3. 探测条目（12 条 / 4 组）

每条结果三态：`ok` / `fail` / `skip`（`skip` 表示前置条件不存在，如本地无 pack 文件，`skip` 不影响标志）。

| # | id | 组 | 探测 | 影响的功能 | 计入标志 |
| --- | --- | --- | --- | --- | --- |
| 1 | `crypto.sqlite_random` | 随机源 | `SELECT hex(randomblob(32)) AS b` 返回 64 位十六进制 | 发表评论、身份生成 | `cryptoOk` |
| 2 | `crypto.pool` | 随机源 | 随机池预填后同步取 32 字节：长度正确、非全零 | 同上 | `cryptoOk` |
| 3 | `crypto.sign` | 随机源 | 固定种子 `keyPairFromSeed` → `sign` → `verify` 通过 | 发表评论、升级验签 | `cryptoOk` |
| 4 | `fs.bigfile` | 文件/库 | 写 1 MiB 随机字节 → 读回逐字节比对 | 同步 pack、封面缓存 | `fsOk` |
| 5 | `fs.meta` | 文件/库 | `size` 与写入长度一致、`exists` 为真、`remove` 后 `exists` 为假 | 缓存清理、断点 | `fsOk` |
| 6 | `db.tx` | 文件/库 | 事务内插入自检行后回滚，行数不变 | `applyPack` 原子性 | `dbOk` |
| 7 | `db.pack` | 文件/库 | 只读打开已下载的 pack 并 SELECT；本地无 pack 时 `skip` | 离线读书 | `dbOk` |
| 8 | `net.tls_get` | 网络 | 自签 TLS 下 `GET /v1/comment?limit=1` 返回 200 | 评论列表 | — |
| 9 | `net.release_verify` | 网络 | `GET /v1/release` 拉取 + `verifyRelease` 用预置公钥验签为真 | 升级提示 | — |
| 10 | `net.event_write` | 网络 | 向 `target_id=selfcheck` 发一条自检事件并拿到 200 回执 | 发表评论 | `writeOk` |
| 11 | `net.open_url` | 网络 | `plus.runtime.openURL` 存在（不真打开） | 升级下载 | — |
| 12 | `render.memory` | 渲染 | 50 KiB 正文按 `\n\n` 切段 + `btoa`/`atob` 100 KiB 往返一致 | 阅读器、封面 | — |

**第 3 条的种子**：固定常量种子，只验证算法链路自洽，不消耗随机池（不能因为自检把池用空）。

**第 6 条**：用既有 `db.tx([...])` 探回滚：一批两条语句，第一条向自建表 `selfcheck_probe` 正常插入，第二条写不存在的表使其必然失败；断言 `tx` 抛错**且**行数与探测前相同（即第一条也被回滚）。不改用真实业务表，探测时先 `CREATE TABLE IF NOT EXISTS selfcheck_probe`（不改 `bootstrap()` 的 schema）。

**第 10 条**：走既有 `postComment` 路径（身份 → 构造 → 签名头 → `POST /v1/event`），因此它天然覆盖「本次坏掉的那条链路」。正文固定为 `selfcheck`，`target_id` 固定为 `selfcheck`。**不写本地 `user_state`**。

**超时**：默认单条 5s（自签 TLS 挂死不能卡整页），阈值可由调用方注入以便测试。

## 4. 能力标志与降级

```ts
type Capability = 'unknown' | 'ok' | 'fail';
interface CapabilityFlags {
  cryptoOk: Capability;  // 条目 1–3
  fsOk: Capability;      // 条目 4–5
  dbOk: Capability;      // 条目 6–7
  writeOk: Capability;   // 条目 10
}
```

**取值约定（本册最关键的一条）**：功能读取标志时 **只有 `fail` 才降级**，`unknown` 与 `ok` 一律照常尝试。否则「用户没进过自检页 = 功能全废」。启动时只有 `cryptoOk` 有值（随机池预填成败），其余为 `unknown`。

| 标志 | 功能行为 |
| --- | --- |
| `cryptoOk === 'fail'` | 评论页发表按钮禁用，原位显示「随机源不可用：<条目 1–3 的真实原因>」；不再尝试注册身份 |
| `fsOk === 'fail'` | 课程页「同步」按钮禁用并说明「无法写入本地文件」 |
| `dbOk === 'fail'` | 不加新分支：`bootstrap()` 本身已抛错。**自检页必须在 `bootstrap()` 失败时仍能出结果**——此时只跑不依赖本地库的条目（3、8、9、11、12），条目 1、2、4–7、10 一律标 `fail` 且原因写「本地库不可用，未探测」 |
| `writeOk === 'fail'` | 评论页发表禁用 + 显示节点返回的真实错误码文案（`comment.ts` 已映射） |

`—`（第 8、9、11、12 条）不触发降级：读路径与升级通道本就有静默降级，再叠一层禁用只会增加无效分支。

**降级落点**：评论页读 `AppContext.capabilities.cryptoOk / writeOk`；课程页读 `fsOk`。判断写成一处小函数（如 `canPostComment(ctx)`）而不是页面里散写条件。

## 5. 报告结构

```ts
interface CheckResult {
  id: string;
  group: string;
  name: string;
  affects: string;
  status: 'ok' | 'fail' | 'skip';
  detail: string;   // 失败时为真实原因；成功时为关键读数（如「64 位 hex」「27370082 字节」）
}

interface SelfCheckReport {
  at: string;                 // ISO8601
  degraded: boolean;          // 是否在 bootstrap 失败的降级模式下产出
  items: CheckResult[];
  flags: CapabilityFlags;
}
```

页面展示与「复制结果」用同一份数据：复制文本每行 `[✅|❌|➖] 名称 — detail（影响：affects）`，末行附 `flags` 与版本号（`plus.runtime.version`），便于贴回到对话里定位。

## 6. 页面与入口

* 路由 `pages/selfcheck/selfcheck`，`pages.json` 注册（标题「基座自检」）。

* `onLoad` 即跑：`bootstrap()` → `runSelfCheck(ctx, { timeoutMs })`；`bootstrap()` 抛错时改跑降级模式（§4）。

* 页面元素：12 条结果（分组标题 + 状态 + 名称 + `detail` + 「影响：…」）、底部「重跑」「复制结果」。

* 入口：`pages/setting/setting.vue` 在「能力诊断」按钮旁加「基座自检」按钮（`uni.navigateTo`）。

* 复制用 `uni.setClipboardData`（平台调用留在页面内，不进 `core/`）。

## 7. 污染控制

| 探针 | 落点 | 清理 |
| --- | --- | --- |
| 4 / 5 | `_doc/base/selfcheck/probe.bin` | 探测结束 `remove` |
| 6 | 本地库新表 `selfcheck_probe` | 事务内回滚，不留行 |
| 10 | 节点事件表一条 `target_id=selfcheck` 事件 | **不可回收，是本册的已知取舍**；客户端在评论列表里过滤 `target_id === 'selfcheck'` |
| 2 / 3 | 无持久化 | — |

第 10 条的事件在**任何客户端**拉全站最新流时都会出现。当前只有自有客户端，故只做客户端过滤，不动节点；若将来开公开读，再在节点侧过滤或改用保留 target 前缀（记入 §10 风险）。

## 8. 测试

`apps/mobile/src/core/selfcheck.test.ts`，Node + `core/fakes.ts` 的假适配器 + 一组假 `platformProbes`：

| # | 用例 | 断言 |
| --- | --- | --- |
| 1 | 全可用 | 12 条均为 `ok`（第 7 条在假 fs 无 pack 时为 `skip`），`flags` 全 `ok` |
| 2 | 只坏一条 | 让 `http.post` 抛错 → 仅第 10 条 `fail`、`writeOk='fail'`，其余仍 `ok` |
| 3 | 超时 | 探测挂起 + `timeoutMs=10` → 该条 `fail`、`detail` 含「超时」，整页仍返回 |
| 4 | 无本地库 | `runSelfCheck` 以「无 ctx」降级模式调用 → 出报告、`degraded=true`、未探测项原因写明 |
| 5 | 标志取值 | `flags` 初值 `unknown` 时，`canPostComment` 返回可用（`unknown` 不降级） |

既有 77 项单测与 `tsc --noEmit`、`build:app` 必须全绿（不回归）。

## 9. 真机验收

| # | 验收项 | 判定 |
| --- | --- | --- |
| 1 | 12 条一屏出结果 | 无卡死、无「提交失败」式通用文案 |
| 2 | 第 10 条 | 返回 200 回执，且节点侧 `GET /v1/comment?target_id=selfcheck` 能查到这条 |
| 3 | 列表过滤 | 评论页「全站最新」不出现 `selfcheck` |
| 4 | 复制结果 | 粘贴出来含全部 12 行 + flags + 版本号 |
| 5 | 降级可见 | 临时把第 10 条改为失败（或断网）→ 评论页发表按钮禁用且显示原因 |
| 6 | 无污染 | 自检后 `_doc/base/selfcheck/` 为空；`selfcheck_probe` 行数为 0 |

## 10. 风险与已知取舍

| # | 风险 / 取舍 | 处置 |
| --- | --- | --- |
| 1 | 第 10 条会在节点留下一串 `selfcheck` 事件 | 客户端过滤；公开读前改节点侧过滤（本册不做） |
| 2 | 1 MiB 写盘在低端机上可能偏慢 | 单条 5s 超时 + 结果里给出耗时读数；超时即 `fail`，不重试 |
| 3 | `randomblob` 是 SQLite 内置函数，但 Android 各版本 SQLite 版本不同 | 这正是第 1 条要探的东西；失败即可读，不再靠猜 |
| 4 | 自检页依赖 `bootstrap()`，本地库坏了进不去 | §4 的降级模式（无 ctx 也出报告） |
| 5 | 探测本身消耗随机池 | 第 2 条只取 32 字节，第 3 条用固定种子不取池 |

## 11. 不影响面（红线）

* 不改节点侧任何接口、表结构与二进制。

* 不改既有同步（`core/sync.ts`）、升级判定（`core/update.ts`）、评论读写（`core/comment.ts`）的既有语义；只在其上增加「禁用 + 说明」这一个前置判断。

* 不替换设置页既有「能力诊断」的原始行输出。

* 不引入新的外部依赖。

* 不做离线发表队列与联网拉取（那是下一册子）。