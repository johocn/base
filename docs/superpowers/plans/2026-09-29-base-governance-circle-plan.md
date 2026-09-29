# base 治理体系重规划与圈子自治实施计划（#33 → 计划 #35）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development` 执行——**每个 Task 派发一个全新子代理**，Task 完成后做一次两阶段复核（① 对着册子核「做了什么 / 有没有少」；② 对着代码核「写的和计划是否一致」），通过后再派下一个 Task 的子代理。步骤用 `- [ ]` 复选框跟踪。**Phase 1 与 Phase 2 各自独立发布一次**，不要跨阶段合并发布。

**Goal**：把 #33 册子落地为两层治理——**Phase 1（L2 圈子自治）**：`groups` 三列与写权放宽、`group.v1` 的 roster v2（`sub` 子类型 + 多签 + 信封链）、治者席位与圈内贡献度只读派生、按形态分支的读权、对端复制、手机端双形态与治者面板；**Phase 2（L1 全局治理一致性）**：`govern.v1` 事件化、提案/投票走反熵收敛、票权按快照水位判定、`govern_*` 两表降级为投影（老路径只写投影、不产事件；客户端改走原生事件投递）。

**Architecture**：**零新算法**——继续 Ed25519 签名（`protocol.Verify` / `sign`）+ AES-256-GCM（`sealWithNonce` / `openWithNonce`），**不引入 X25519**，因此「开放加入但仍加密」不可达 ⇒ 圈子形态二元化（开放圈不加密 / 封闭圈加密）且建圈定死。节点**永不持有组密钥**：多签只验签名数与签名者集合归属，不数票、不解密（§3.4）；密钥轮换用**对称信封链**（新钥用旧钥 AEAD 加密后随 roster 事件走节点）。席位与贡献度是**只读派生**，不落新表（唯一新增状态是 `groups` 的三个列）。

**Tech Stack**：Go 1.25 + 纯 Go SQLite（`modernc.org/sqlite`，无 CGO）；TypeScript + Vue 3 + uni-app；`@base/protocol-ts`（`canonicalize` / `sign` / `verify` / `deriveIdentityId` / `sealWithNonce` / `openWithNonce`）；测试 `go test` + vitest。

**上游 spec**：`docs/superpowers/specs/2026-09-29-base-governance-circle-design.md`（**唯一契约来源**）。与册子冲突时以册子为准；要改口径先改册子（走 `## 0. 改版说明`），并在本计划追加「执行期更正」。

**基线**：`e:\code\base` HEAD = `da39b14`；工作区仅 `.gitignore` 未提交（**属其它任务，本计划一律不碰**）。移动端实测 `npx vitest run`（cwd `apps/mobile`）= **17 文件 / 149 项全绿**。

---

## 已核实的环境事实（勿再验证）

### 册子 §2 的六处缺口（复核一致，行号为基线 HEAD 实测）

| # | 事实 | 位置 |
|---|---|---|
| G1 | `groups` 表只有 6 列（`group_id / creator_id / epoch / member_ids_json / event_id / updated_at`），写入受 **owner 锁** + epoch 严格单调约束 | `internal/store/schema.go:169-176`、`internal/store/group.go:27-55` |
| G2 | `GET /v1/group/{group_id}` **匿名可读**，返回名单与 `action=msg` 索引；正文另经 `GET /v1/blob/{payload_cid}` 取 | `internal/httpapi/group.go:295-359`、`internal/httpapi/server.go:131` |
| G3 | `handleEventSync` **不按 type 过滤** ⇒ 新事件类型自动参与反熵 | `internal/httpapi/peer.go`（`handleEventSync`）、`internal/peersync/eventsync.go:80-119` |
| G4 | `govern_proposals` / `govern_votes` 是**本地权威表**，票按 roster **实时复判**（`filterRoster`），不跨节点 | `internal/store/govern.go:112-121`、`internal/store/govern.go:163-198`、`internal/store/govern.go:216-297` |
| G5 | 客户端密码学只有 Ed25519 + 对称 AEAD，**没有 X25519** | `apps/mobile/src/core/identity.ts`、`apps/mobile/src/core/group.ts` |
| G6 | `decodeInvite` 校验 `v !== 1` 即拒 → 老客户端遇 `v=2` 码**明确拒绝**（不是崩，是「邀请码无效或已损坏」） | `apps/mobile/src/core/group.ts:193` |

### 其它必须知道的事实

| 事实 | 值 |
|---|---|
| 本机 shell | Windows PowerShell 5.1，**不支持 `&&`、不支持 heredoc**；多命令用 `;` 分行；commit message 写临时文件后 `git commit -F`，用完删除（git 在 `e:\Git\cmd\git.exe`） |
| 中文读取 | 必须 `[System.IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)`；`Select-String` 直接读会乱码 |
| 单连接 | `internal/store/store.go` 有 `SetMaxOpenConns(1)`：**游标未关闭时嵌套查询会死锁**。新写的 store 方法必须「先读完即 Close，再发下一条语句」（参照 `ListProposalViews` 的写法） |
| 严格键集 | `parseGroupBody`（`internal/httpapi/group.go:42-81`）按 `action` 分流后**逐键白名单**，未知键即拒；返回的 map 保留**客户端原始键集**供验签重建 |
| 验签管线 | `verifyEventSig`（`internal/httpapi/event.go:160-190`）：`Canonicalize({event_id,type,created_at,body})` → `LookupIdentity(actor)` → `protocol.Verify`。**新 action 照抄，不要另写验签** |
| reqsig 头 | `requireAuth`（`internal/httpapi/authmw.go:81-175`）5 个头 `X-Base-Id / Alg / Ts / Nonce / Sig`，待签字节含 `Method + Path + RawQuery + BodySHA256 + TS + Nonce`（`protocol.RequestSignBytes`） |
| 错误响应形状 | `writeAuthErr` → `{"error":…,"code":…}`（`authErrText` 里无该码时回落到 code 文本）；`writeError` → `{"error":…}`（**无 `code`**）。客户端只读 `code` |
| 身份 id | `sha256(pubkey)[0:32]` = **32 hex**（`protocol.IsIdentityID`、`protocol-ts` 的 `isIdentityId`） |
| `event_id` / `group_id` | **32 hex**（节点侧 `isHexN(id, 16)` 第二参是**字节数**，即 len==32；`group_id` 与 `event_id` 同形） |
| `sig` 形态 | **64 hex**（`isHexN(req.Sig, 64)`，`event.go:171`） |
| 手机端建表机制 | `core/repo.ts:87-124` 的 `SCHEMA_SQL`，由 `platform/index.ts` 的 `bootstrap()` 逐条 `db.execute`，`CREATE TABLE IF NOT EXISTS` 幂等，**无版本号** → 新列走「读时容错」而非迁移 |
| `GroupRow` / `GroupKeyRow` | `core/types.ts`；`groups(group_id,name,creator_id,epoch,member_ids_json,joined_at)`、`group_keys(group_id,epoch,key_cipher,created_at)` |
| 密文形态 | `group_keys.key_cipher` = `nonceHex:ctHex`（`identity.ts:96` 同形态）；正文 = `base64url(nonce12‖ct)`（`group.ts:111-126`） |
| 写能力门控 | `core/selfcheck.ts` 导出 `canPostComment` / `postBlockedReason`（`comment.vue:80-115` 用法） |
| 补发入口可跨模块用 | `core/comment.ts:282` 的 `flushPending(o)` 只依赖 `{adapters, repo, nodeBaseUrl}` ⇒ 圈子页可直接 import |
| Go 测试基座 | `internal/httpapi/httpapi_test.go:64` 的 `newTestServer(t)`（返回 `*store.Store` + `inprocServer`，含确定性密钥 `testSeed` / `testPub`）；`comment_test.go:105` 的 `doJSONMap(t, method, url, body, headers)` |
| 当前版本 | `apps/mobile/src/manifest.json` = `versionName "0.10.0"` / `versionCode "14"`（**私信册 #34 已执行完毕并发布上线**，见「补充 19」）→ **Phase 1 发 `0.11.0` / `15`**、**Phase 2 发 `0.12.0` / `16`** |
| 节点侧必须部署 | 两个阶段都改了节点代码。按 #31「更正 3 / 更正 11」的后续口径：**发布清单必须含交叉编译 + 两个节点各备份替换 + 依次 restart + 逐个探活** |
| 双节点二进制同一份 | `base.service` 与 `base-cache.service` 的 `ExecStart` **都指 `/opt/base/based`**，回滚要一起回 |

---

## 对册子的补充与口径填空（已登记，实施时照此执行）

册子未写、但实施必需。**1–3 是缺陷级补充**（不做则 AC 不成立），4–14 是口径填空。全部不改既有线上接口的形状（只在既有响应体上**加字段**）。

1. **`roster` v2 与 v1 的分流判据 = body 里有没有 `sigs` 键**（对应 G1 的兼容要求）。带 `sigs` ⇒ 走新的多签路径（§3.8 的放宽写权）；不带 ⇒ **原样走既有 `putGroupRoster`**（owner 锁 + epoch 单调），存量 `0.9.3` 客户端零感知。
2. **席位与贡献度必须在节点侧派生后随读接口下发**，客户端**不自己排名**。理由：名次依赖「本地已验签的 `group.v1` `action=msg` 事件全集」，客户端只有分页片段，自己排必然漂移。故 `GET /v1/group/{group_id}` 的 `group` 对象新增 `encrypted` / `roster_rev` / `seat_count` / `governors` / `envelopes` 五个字段（**只加不改**），UI 只做展示。
3. **信封是「epoch 级单封」而不是「逐成员封」**。册子 §3.5 写「逐成员 AEAD 加密成信封」，但在**没有非对称加密**的前提下（G5），每个成员用的都是同一把旧 epoch 钥、加密的都是同一把新钥 ⇒ 逐成员信封与单封**逐字节等价**，只是把体积乘以成员数（200 人 ⇒ 200 份同样密文）。故定案：`envelopes` 是**每跨越一个 epoch 一个信封**，形状 `{"from_epoch":N,"cipher":"<base64url(nonce12‖sealWithNonce(oldKey,newKey))>"}`。离线跨多 epoch 的成员按「其最后持有的 epoch」逐层解链。这条是 **YAGNI 取舍**，不改册子的「不做逐人非对称信封」结论。
4. **多签的签名域与待签载荷**。域常量 `base/group-roster-v2`（`base/*-v1` 体例的族内新成员）。待签载荷 = `canonicalize` 下列**固定键集**（不含 `sigs` / `envelopes`——签名是「对这次名单变更的授权」，信封是分发载体）：

   ```json
   {"domain":"base/group-roster-v2","event_id":"<32hex>","group_id":"<32hex>","action":"roster",
    "sub":"rename|rotate|leave|join|remove|dissolve","epoch":N,"roster_rev":N,
    "member_ids":["<32hex>"],"encrypted":0|1,"created_at":<ms>}
   ```

   `name` **只有非空才进载荷**（与 `reply_to` 同处置）；`encrypted` 恒在（0/1 都是确定值）。节点收到后**自己重建**这份载荷（不信客户端给的字节），逐条 `protocol.Verify`。
5. **`sigs` 的形状** = `[{"id":"<32hex>","sig":"<64hex>"}]`（不是平行数组——平行数组要靠下标对齐，错位不可检）。去重按 `id`（保留首条）。任一条验签失败即整条事件拒收（`event_sig_invalid`），**不做「跳过坏的、数好的」**（会变成伪造签名的入口）。
6. **「不可判定」的节点侧落地 = 拒写重大动作**（对应册子 §3.3 第 9 条）。判定：`k(m) ≤ 1` ⇒ 治者 = `{创建者}`，**恒可判定**（小圈子不需要排名）；`k(m) > 1` 且本地 **一条圈内 `action=msg` 事件都没有** ⇒ 不可判定，**除 `rename` / `rotate` / `leave` 三档低风险动作外一律拒写**（返回 `group_roster_quorum_missing`，提示「圈内历史尚未同步齐，请稍后重试」）。**不猜名次**、也不退化成「创建者一人说了算」。
7. **防刷窗口的确定性算法**（册子 §3.3 第 3 条只说「最多计 20 条」）。逐 actor：其发言按 `(created_at, event_id)` **升序贪心接受**——把当前事件放进已接受集合，若存在任一 24h 窗口内已接受数 > 20 则丢弃该条。贪心从最早开始，是满足「任意滚动 24h 窗口 ≤ 20」约束下**总数最大**的那个解，且**唯一确定**（同分同序）。窗口边界取整到秒（`t` 与 `t-86400000` 闭区间）。
8. **AC 3 断言样例的 id 必须显式构造**。册子写 `A=30, B=20, C=20, D=5, E=0` ⇒ 名次必须是 `A → B → C → D → E`。但 A 被防刷截断成 20 后与 B、C **同分**，同分按 `actor_id` hex 升序 ⇒ 用例必须造出 `id(A) < id(B) < id(C) < id(D) < id(E)` 的 hex 顺序（如 `'a0..0'` / `'b0..0'` …），否则断言与算法都自洽但用例会假失败。
9. **`join`（开放圈自加入）的 `encrypted` 必须为 0**，且签名者集合恒等于 `{actor}`（自己签自己）。封闭圈发 `join` 一律 403 `group_invite_required`——**封闭圈只认邀请码**，节点不代收自加入。开放圈自加入**不要求**签名者是治者，也就顺带绕过 §6 第 6 条「不可判定」的拒写（低风险档）。
10. **`leave`（自己退出）按册子 §3.4 字面口径 = 低风险档「任一治者 1 签」**。因此在册普成员**不能独自退出**——必须由任一治者签署。这是定稿口径的**代价**，UI 必须在成员主动退出的入口**原位提示**原文：「退出圈子需要一名治理者确认」。节点侧不额外放宽（否则与册子冲突）。
11. **`dissolve` 生效后节点只做两件事**：`groups` 行置 `encrypted` 不变、`member_ids_json` 写空数组 `[]`（语义 = 「已解散，名单清空」），并在事件行保留完整 `sub=dissolve` 记录。**不删块、不删事件**（块保持可取是 §3.7 的定案）。读接口遇到空名单一律按**已解散**渲染，不再做形态分支。
12. **`key_envelopes` 列的职责 = 把最新信封端到读接口**。成员一读就能解开链拿到新钥（不必等 roster 事件反熵到达），这是 §3.5「不粘贴续期码自动获新钥」的落地路径。该列是**密文**，公开返回无害。
13. **Phase 2 的版本号 = `0.12.0` / `16`**。册子说「版本从本册基线起；两阶段各自完整走发布四步」——两个阶段都有用户可见改动，同名版本发两次会让升级通道判不出新旧，故 Phase 2 起再 +1。
14. **老路径不产事件（原「桥接」方案已撤销，定案见册子 §0.2 / §4.4）**。最初的写法是让 `handleProposalPost` / `handleVotePost` 把老请求**桥接**成一条 `govern.v1` 事件（`sig` 填该次请求的 reqsig），好让反熵把老客户端的提案 / 投票带到别的节点。**撤销理由**：reqsig 签的是 `method / path / query / body_sha256 / ts / nonce`，是对「这一次 HTTP 请求」的签名，**不是对事件体的签名**；这样产出的「已签名事件」签名者与签名内容不对应，等于**节点代用户伪证**。
    - **定案**：老路径 `POST /v1/proposal` / `POST /v1/proposal/{id}/vote` **只写本地投影表、不产事件**（行为与今天完全一致）。跨节点传播由**新客户端**走 `POST /v1/event` 产出带**真内容签名**的 `govern.v1` 事件承担（复用既有 `verifyEventSig` 管线，本册 Task 8 的 `handleGovernEvent` 就是它的接收端）。
    - 代价：老客户端升级前其提案 / 投票**不出本节点**——与今天完全相同，无回归（`govern_proposals` / `govern_votes` 本就不跨节点）。**不再有「不可独立验证的桥接票」这一类数据进入反熵**。
18. **`govern.v1` 的 `choice` 枚举册子未定，本计划按「1..16 字节 ASCII 非空短串」放行**（对应 §4.2 只写「choice」）——与既有 `AddVote` 只有「投一票」语义一致：这一册只做「投影 + 收敛」，不引入 `for/against` 的语义分叉。册子后续收敛枚举值时，只改 `httpapi/govern_event.go` 的 `parseGovernBody` 一处。

编号说明：**15 / 16 / 17 就地写在对应 Task 的正文里**，因为它们的上下文就在那段代码旁边——15 = 多签收集两段码 + 回执带 `pub`（Task 5 Step 6），16 = 建圈一律走 v1 形态 roster（Task 5 Step 7），17 = v2 名单信封必须复用草稿的 `event_id`/`created_at`（Task 5 Step 7）。

19. **版本定序已定并已收口：私信册（#32 册子 + #34 计划）先发，本计划整体 +1 让位。** 私信册 `0.10.0` / `14`（基线 `0.9.3` / `13`）**已执行完毕并发布上线**（`bb15a7c`→`2de4f1c` 覆盖 Task 1–9，`33f2556` 完成版本与发布并回填文档，`5f354a1` 修正回填笔误；APK 27413300 字节 / sha256 `683cfed841ccbc82a187a95afe34c36bf156081b8a4f6d1319d31aaa3e5fe15e`，落地页与 `/v1/release` 均已改指）。故本计划基线 = **`0.10.0` / `14`（即线上当前版本）**：**Phase 1 = `0.11.0` / `15`、Phase 2 = `0.12.0` / `16`**。判据是「**谁已经在跑**」而不是文档依赖顺序——私信册先落版本号且已上线，再改它就会与已发布链路冲突。册子 `2026-09-29-base-governance-circle-design.md` §0.2 第 2 条 / §9 与 `docs/README.md` 第 33/35 行、§5 已同步。**版本号冲突已收口：Task 7 Step 1 直接由 `0.10.0` / `14` 改指 `0.11.0` / `15`，无任何前置等待。**
20. **客户端治理写路径改走原生事件（= 册子 §0.2 第 1 条 B 方案的客户端半边）**。老客户端（`0.9.3`）继续用 `POST /v1/proposal` / `/v1/proposal/{id}/vote`（reqsig，**只写本节点投影、不产事件**）；**新客户端**改用 `POST /v1/event` 产出带**真内容签名**的 `govern.v1` 事件，承担跨节点传播。落地在 Task 9（`core/govern.ts`）：

    - `createProposal` / `vote` 由 `signedPost`（reqsig 五头）改为**内容签名 + 事件投递**：`payload = canonicalize({event_id, type:'govern.v1', created_at, body})`、`sig = sign(ident.seedHex, utf8(payload))`，POST `/v1/event`（与 `core/group.ts` 的 `buildGroupWireAt` 逐字同构）。**不需要签名头**（事件路径只验内容签名）。
    - **`proposal_id` 由客户端取「当前最大 id + 1」**：事件化后 `govern_proposals.proposal_id` 不再由节点自增（事件是权威来源）。发事件前先 `GET /v1/proposal` 取 `max(proposal_id)`，+1 作为本条；并发撞号由节点 `ProjectGovernProposal` 的 `(created_at, event_id)` 首者胜 + `govern_event_conflict` 兜底，客户端收到该码后重取重发。
    - `body` 键集与老路径一致：提案 `{proposal_id, action, item_id, reason}`（`edit` 另带 `{title, body_md}`）；投票 `{proposal_id, choice:'yes'}`——`choice` 用 `'yes'`，与「补充 18」的短 ASCII 口径一致。
    - **幂等**：`event_id` 用 `randomBytes(16)`；同 `event_id` 重发由 `ProjectGovernProposal` / `ProjectGovernVote` 的 `source_event_id` 判重放直接返回 nil（不报冲突）。
    - **响应重建**：事件投递的 200 只回 `{event_id, received_at}`，不再回 `vote_count` / `threshold` / `status` ⇒ 写路径返回后**必须重拉 `GET /v1/proposal`** 对齐（本册 §5.6 本来就这么要求），`VoteResult` 由重拉结果的对应条目构造。

---

## 文件结构

| 路径 | 动作 | 职责 |
|---|---|---|
| `internal/store/schema.go` | 修改 | `groups` CREATE 加 3 列；新增 `groupColumnMigrations` 并在 `migrate()` 里补列（存量库不 bump `schema_version`）；`govern_*` 两表加 `source_event_id` 列（Phase 2） |
| `internal/store/group.go` | 修改 | `GroupRoster` 加 3 字段；`PutGroupRosterV2`（无 owner 锁、epoch **与** `roster_rev` 双单调、形态锁定）；`ListGroupMsgEvents`（全量，供派生）；`ForceGroupRoster` 带上 3 新列；`PutGroupRoster`（v1）补 `roster_rev+1` |
| `internal/store/groupseats.go` | 新建 | 纯函数：`GovernorSeats` / `RemoveQuorum` / `DissolveProposerQuorum` / `DissolveVoteQuorum` / `ContributionRank` / `EventWatermark` / `DeriveSeats`（§3.2 / §3.3 全部算例） |
| `internal/store/govern.go` | 修改 | Phase 2：`Proposal` / `ProposalView` 加 `SourceEventID`；`ProjectGovernEvent`（事件→投影还原）；`ListProposalViews` 的票权按**快照水位**（`content_version` + `revoked_rev`）过滤 |
| `internal/store/govern_projection.go` | 新建 | Phase 2：`govern.v1` 的 body 严格键集解析 + 投影 upsert + 并发收敛（`(created_at,event_id)` 首、`(proposal_id,voter)` 最早） |
| `internal/httpapi/group.go` | 修改 | roster v2 解析（`sub` / `sigs` / `envelopes`）与多签门槛校验；`handleGroupGet` 按形态分支；`groupDTO` 加 5 字段 |
| `internal/httpapi/authmw.go` | 修改 | 抽 `authenticate`；新增 `optionalAuth`；`authErrText` 加 6 条新码 |
| `internal/httpapi/server.go` | 修改 | `GET /v1/group/{group_id}` 改走 `optionalAuth`（Phase 2 再加 `govern.v1` 无关的注册） |
| `internal/httpapi/event.go` | 修改 | Phase 2：`eventTypeRegistry` 加 `"govern.v1"` + `handleEventPost` 分流分支 |
| `internal/httpapi/govern.go` | 修改 | Phase 2：老路径**只写投影表、不产事件**（行为不变）；读接口的票权口径改由投影给出 |
| `internal/httpapi/govern_event.go` | 新建 | Phase 2：`handleGovernEvent`（严格键集 → 验签 → 投影还原） |
| `internal/peersync/eventsync.go` | 修改 | `applySyncedGroupEvent` 带上 `roster_rev` / `encrypted` / `key_envelopes`；Phase 2 加 `govern.v1` 分支落投影 |
| `internal/store/groupseats_test.go` | 新建 | AC 2 / AC 3 全算例 + 防刷 + 水位 + 不可判定 |
| `internal/store/group_test.go` | 修改 | v2 写权（`roster_rev` 单调 / 形态锁定 / v1 兼容） |
| `internal/httpapi/group_roster_test.go` | 新建 | AC 6 / AC 7 门槛算例 + 5 个新错误码 + 签名者集合归属 |
| `internal/httpapi/group_read_test.go` | 新建 | AC 1 / AC 8 / AC 9 / AC 13 读权分支与形态 |
| `internal/peersync/eventsync_test.go` | 修改 | v2 名单跨节点后 3 个新列被还原 |
| `internal/httpapi/govern_event_test.go` | 新建 | Phase 2：AC 11 / AC 12（水位不改判）+ `govern_event_conflict` |
| `apps/mobile/src/core/types.ts` | 修改 | `GroupRow` 加 `encrypted` / `rosterRev` |
| `apps/mobile/src/core/group.ts` | 修改 | v2 邀请码（`v=2`，12 键签名域）、建圈选型、席位消费、多签签署、信封链解链、双形态读权、退出/移出/解散编排 |
| `apps/mobile/src/core/group.test.ts` | 修改 | AC 4 / AC 5 / AC 13（老码可用）+ 信封链 + 门槛拒写提示 |
| `apps/mobile/src/pages/circle/circle.vue` | 修改 | 建圈选型（开放 / 封闭）与形态标记 |
| `apps/mobile/src/pages/group/group.vue` | 修改 | 治者面板（成员管理 / 改名 / 轮换 / 解散提案）、席位与贡献度展示、退出入口 |
| `apps/mobile/src/core/govern.ts` | 修改 | Phase 2：`createProposal` / `vote` 改走原生 `govern.v1` 事件投递（内容签名，见「补充 20」）+ 消费事件化结论 + 水位展示 |
| `apps/mobile/src/pages/governance/governance.vue` | 修改 | Phase 2：水位与「被选中的那一条」展示 |
| `apps/mobile/src/manifest.json` | 修改 | Phase 1 `0.11.0` / `15`；Phase 2 `0.12.0` / `16` |
| `docs/README.md` | 修改 | 第 34 行（本计划）状态回填；第 33 行（#33 册子）状态；§4 依赖图与 §5 状态与下一步 |

---

## Phase 1（L2 圈子自治）

### Task 1: 节点 store——`groups` 三列与写权放宽 + 席位/贡献度只读派生

**Files:**
- Modify: `internal/store/schema.go`
- Modify: `internal/store/group.go`
- New: `internal/store/groupseats.go`
- New: `internal/store/groupseats_test.go`
- Modify: `internal/store/group_test.go`

- [ ] **Step 1: 写失败的单测（席位阶梯与门槛，AC 2 / AC 7 的纯函数部分）**

新建 `internal/store/groupseats_test.go`：

```go
package store

import "testing"

func TestGovernorSeats(t *testing.T) {
	// 册子 §3.2 的阶梯表逐行核对（AC 2）
	cases := []struct{ m, want int }{
		{1, 1}, {10, 1}, {11, 3}, {20, 3}, {21, 4}, {30, 4},
		{31, 5}, {41, 6}, {51, 7}, {61, 8}, {71, 9}, {80, 9}, {81, 10}, {200, 10},
	}
	for _, c := range cases {
		if got := GovernorSeats(c.m); got != c.want {
			t.Errorf("GovernorSeats(%d) = %d, want %d", c.m, got, c.want)
		}
	}
}

func TestQuorums(t *testing.T) {
	// 移出成员：治者 ≥ ⌈2k/3⌉（AC 6）
	for _, c := range []struct{ k, want int }{{1, 1}, {3, 2}, {4, 3}, {6, 4}, {10, 7}} {
		if got := RemoveQuorum(c.k); got != c.want {
			t.Errorf("RemoveQuorum(%d) = %d, want %d", c.k, got, c.want)
		}
	}
	// 解散发起：治者 ≥ min(2, k)（AC 7）
	for _, c := range []struct{ k, want int }{{1, 1}, {3, 2}, {10, 2}} {
		if got := DissolveProposerQuorum(c.k); got != c.want {
			t.Errorf("DissolveProposerQuorum(%d) = %d, want %d", c.k, got, c.want)
		}
	}
	// 解散通过：成员 ≥ min(30, ⌊m/3⌋+1)，上限 30（AC 7 算例）
	for _, c := range []struct{ m, want int }{
		{3, 2}, {11, 4}, {30, 11}, {89, 30}, {90, 30}, {200, 30},
	} {
		if got := DissolveVoteQuorum(c.m); got != c.want {
			t.Errorf("DissolveVoteQuorum(%d) = %d, want %d", c.m, got, c.want)
		}
	}
}
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `go test ./internal/store/ -run 'TestGovernorSeats|TestQuorums' -v`
Expected: FAIL —— `undefined: GovernorSeats` / `undefined: RemoveQuorum` / `undefined: DissolveProposerQuorum` / `undefined: DissolveVoteQuorum`

- [ ] **Step 3: 实现 `internal/store/groupseats.go`（公式 + 排名 + 水位 + 派生）**

```go
package store

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
)

// GovernorSeats 返回成员数 m 对应的治理人席位总数 k(m)（册子 §3.2）。
func GovernorSeats(m int) int {
	if m <= 10 {
		return 1
	}
	k := 3 + (m-11)/10
	if k > 10 {
		return 10
	}
	return k
}

// RemoveQuorum 是「移出成员」的治者签名门槛 ⌈2k/3⌉（册子 §3.4）。k=1 时自动为 1。
func RemoveQuorum(k int) int { return (2*k + 2) / 3 }

// DissolveProposerQuorum 是「解散圈子」的发起治者门槛 min(2, k)（册子 §3.4）。
func DissolveProposerQuorum(k int) int {
	if k < 2 {
		return k
	}
	return 2
}

// DissolveVoteQuorum 是「解散圈子」的成员投票门槛 min(30, ⌊m/3⌋+1)（册子 §3.4，必须超过 1/3 且上限 30）。
func DissolveVoteQuorum(m int) int {
	q := m/3 + 1
	if q > 30 {
		return 30
	}
	return q
}

// brushWindowMs 是防刷窗口：任意滚动 24h（册子 §3.3 第 3 条，边界取整到秒）。
const brushWindowMs = 24 * 60 * 60 * 1000

// brushMaxPerWindow 是同一 actor 在任意滚动 24h 内最多计入的条数（册子 §3.3 第 3 条）。
const brushMaxPerWindow = 20

// rankInput 是排序输入的一行。
type rankInput struct {
	EventID   string
	Actor     string
	CreatedAt int64
}

// ContributionRank 按册子 §3.3 排出圈内贡献度名次。
//   - 输入已按 event_id 去重、只含 action=msg、且 actor 已过滤到当前成员（由 DeriveSeats 完成）；
//   - 防刷：逐 actor 的发言按 (created_at, event_id) 升序**贪心接受**，保持任意滚动 24h 窗口 ≤ 20；
//   - 排序键：count 降序，同分按 actor_id 的 hex 字典序**升序**（各节点同解的前提）；
//   - 返回**全部成员**的名次顺序（零发言的成员也在，排在最后按 id 升序），长度 = len(members)。
func ContributionRank(events []rankInput, members []string) []string {
	counts := make(map[string]int, len(members))
	byActor := make(map[string][]rankInput, len(members))
	memberSet := make(map[string]bool, len(members))
	for _, m := range members {
		memberSet[m] = true
	}
	for _, e := range events {
		if !memberSet[e.Actor] {
			continue // 已移出者的历史发言不计入排名（册子 §3.3 第 4 条；事件仍留库）
		}
		byActor[e.Actor] = append(byActor[e.Actor], e)
	}
	for actor, list := range byActor {
		sort.Slice(list, func(i, j int) bool {
			if list[i].CreatedAt != list[j].CreatedAt {
				return list[i].CreatedAt < list[j].CreatedAt
			}
			return list[i].EventID < list[j].EventID
		})
		accepted := make([]int64, 0, len(list))
		for _, e := range list {
			// 贪心：若接受该条会让某个 24h 窗口内超过上限，则丢弃它（从最早已接受条开始数）。
			accepted = append(accepted, e.CreatedAt)
			if windowCount(accepted, e.CreatedAt) > brushMaxPerWindow {
				accepted = accepted[:len(accepted)-1]
			}
		}
		counts[actor] = len(accepted)
	}
	out := append([]string(nil), members...)
	sort.Slice(out, func(i, j int) bool {
		if counts[out[i]] != counts[out[j]] {
			return counts[out[i]] > counts[out[j]]
		}
		return out[i] < out[j]
	})
	return out
}

// windowCount 返回已接受的（升序）时刻里落在 [end-24h, end] 闭区间的条数。
func windowCount(accepted []int64, end int64) int {
	lo := end - brushWindowMs
	n := 0
	for _, t := range accepted {
		if t >= lo && t <= end {
			n++
		}
	}
	return n
}

// EventWatermark 是册子 §3.3 第 8 条的 event_watermark：event_id 集合排序拼接后取 sha256 前 16 hex。
func EventWatermark(eventIDs []string) string {
	sorted := append([]string(nil), eventIDs...)
	sort.Strings(sorted)
	sum := sha256.Sum256([]byte(strings.Join(sorted, "")))
	return hex.EncodeToString(sum[:])[:16]
}

// SeatSnapshot 是一次席位派生的结果，水位一并带出（册子 §3.3 第 8 条）。
type SeatSnapshot struct {
	RosterRev   int64
	RosterEpoch int64
	Watermark   string
	SeatCount   int
	Ranked      []string
	Governors   []string
	// Decidable=false 表示名册或事件集合不足以判定名次（册子 §3.3 第 9 条）。
	// k(m) <= 1 的圈子不需要排名，恒可判定。
	Decidable bool
}

// DeriveSeats 从名册 + 圈内发言事件派生席位（册子 §3.2 / §3.3）。
// 只读派生、不落表；创建者永久占 1 席，其余 k-1 席按贡献度名次取。
func DeriveSeats(memberIDs []string, creatorID string, rosterRev, epoch int64, events []Event) SeatSnapshot {
	k := GovernorSeats(len(memberIDs))
	msgs := make([]rankInput, 0, len(events))
	seen := make(map[string]bool, len(events))
	ids := make([]string, 0, len(events))
	for _, e := range events {
		if seen[e.EventID] {
			continue // 按 event_id 去重（册子 §3.3 第 1 条）
		}
		seen[e.EventID] = true
		if groupBodyAction(e.BodyJSON) != "msg" {
			continue
		}
		ids = append(ids, e.EventID)
		msgs = append(msgs, rankInput{EventID: e.EventID, Actor: e.ID, CreatedAt: e.CreatedAt})
	}
	snap := SeatSnapshot{
		RosterRev: rosterRev, RosterEpoch: epoch,
		Watermark: EventWatermark(ids),
		SeatCount: k,
		Ranked:    ContributionRank(msgs, memberIDs),
		Decidable: k <= 1 || len(msgs) > 0,
	}
	// 创建者永久 1 席；其余按名次取，跳过创建者本身（册子 §3.2）。
	snap.Governors = make([]string, 0, k)
	if creatorID != "" {
		snap.Governors = append(snap.Governors, creatorID)
	}
	for _, id := range snap.Ranked {
		if len(snap.Governors) >= k {
			break
		}
		if id == creatorID {
			continue
		}
		snap.Governors = append(snap.Governors, id)
	}
	return snap
}

// groupBodyAction 从事件 body_json 里取 action；解析失败或非 roster/msg 返回空串。
func groupBodyAction(bodyJSON string) string {
	var b struct {
		Action string `json:"action"`
	}
	if err := json.Unmarshal([]byte(bodyJSON), &b); err != nil {
		return ""
	}
	return b.Action
}
```

（`groupseats.go` 顶部 import 需含 `encoding/json`。）

- [ ] **Step 4: 跑一遍确认通过**

Run: `go test ./internal/store/ -run 'TestGovernorSeats|TestQuorums' -v`
Expected: PASS

- [ ] **Step 5: 补 AC 3 的排名单测（防刷 / 同分 / 水位 / 不可判定）**

追加到 `internal/store/groupseats_test.go`：

```go
// fixtureID 造一个可预期的 32 hex 身份 id：前缀单字符 + 补齐，保证 hex 升序与字母序一致（补充 8）。
func fixtureID(prefix byte) string {
	return strings.Repeat(string(prefix), 32)
}

// msgEvent 造一条已验签形态的 msg 事件行（body 只需含 action）。
func msgEvent(id, actor string, at int64) Event {
	return Event{EventID: id, ID: actor, Type: "group.v1", CreatedAt: at,
		BodyJSON: `{"action":"msg"}`}
}

func TestContributionRankAntiBrush(t *testing.T) {
	a, b, c, d, e := fixtureID('a'), fixtureID('b'), fixtureID('c'), fixtureID('d'), fixtureID('e')
	members := []string{a, b, c, d, e}
	const t0 = 1_700_000_000_000
	var events []Event
	// A 在 1 分钟内发 30 条 → 防刷截断为 20
	for i := 0; i < 30; i++ {
		events = append(events, msgEvent(fmt.Sprintf("%032x", 0x1000+i), a, t0+i*1000))
	}
	for i := 0; i < 20; i++ {
		events = append(events, msgEvent(fmt.Sprintf("%032x", 0x2000+i), b, t0+i*1000))
	}
	for i := 0; i < 20; i++ {
		events = append(events, msgEvent(fmt.Sprintf("%032x", 0x3000+i), c, t0+i*1000))
	}
	for i := 0; i < 5; i++ {
		events = append(events, msgEvent(fmt.Sprintf("%032x", 0x4000+i), d, t0+i*1000))
	}
	want := []string{a, b, c, d, e}
	if got := ContributionRank(rankInputs(events), members); !reflect.DeepEqual(got, want) {
		t.Fatalf("rank = %v, want %v（AC 3：A 截断为 20，与 B/C 同分按 id 升序）", got, want)
	}
}

func TestContributionRankReplayStable(t *testing.T) {
	a, b := fixtureID('a'), fixtureID('b')
	const t0 = 1_700_000_000_000
	one := msgEvent("00000000000000000000000000000001", a, t0)
	base := []Event{one, msgEvent("00000000000000000000000000000002", b, t0+1000)}
	first := ContributionRank(rankInputs(base), []string{a, b})
	// 把同一条 event_id 重放 100 次，名次不得变化（AC 3）
	replayed := append([]Event(nil), base...)
	for i := 0; i < 100; i++ {
		replayed = append(replayed, one)
	}
	if got := ContributionRank(rankInputs(dedup(replayed)), []string{a, b}); !reflect.DeepEqual(got, first) {
		t.Fatalf("重放后名次变化: %v != %v", got, first)
	}
}

func TestDeriveSeats(t *testing.T) {
	a, b, c := fixtureID('a'), fixtureID('b'), fixtureID('c')
	const t0 = 1_700_000_000_000
	// m=3 ⇒ k=1，创建者永久 1 席，恒可判定（补充 6）
	snap := DeriveSeats([]string{a, b, c}, a, 3, 3, nil)
	if snap.SeatCount != 1 || !reflect.DeepEqual(snap.Governors, []string{a}) || !snap.Decidable {
		t.Fatalf("m=3 席位错: %+v", snap)
	}
	// m=11 ⇒ k=3，创建者 a + 名次前 2（b、c），可判定
	members := []string{a, b, c}
	for i := 0; i < 9; i++ {
		members = append(members, fmt.Sprintf("%032x", 0x9000+i))
	}
	events := []Event{
		msgEvent("00000000000000000000000000000011", b, t0),
		msgEvent("00000000000000000000000000000012", b, t0+1000),
		msgEvent("00000000000000000000000000000013", c, t0),
	}
	snap = DeriveSeats(members, a, 5, 5, events)
	if snap.SeatCount != 3 || !snap.Decidable {
		t.Fatalf("m=11 席位错: %+v", snap)
	}
	if snap.Governors[0] != a || snap.Governors[1] != b || snap.Governors[2] != c {
		t.Fatalf("m=11 治者错: %v", snap.Governors)
	}
	// m=11 且一条 msg 都没有 ⇒ 不可判定（补充 6）
	if snap := DeriveSeats(members, a, 5, 5, nil); snap.Decidable {
		t.Fatalf("无发言的 m=11 圈应不可判定: %+v", snap)
	}
}

func TestEventWatermark(t *testing.T) {
	// 顺序无关（排序后拼接）
	if EventWatermark([]string{"b", "a"}) != EventWatermark([]string{"a", "b"}) {
		t.Fatal("水位应对 event_id 集合的顺序不敏感")
	}
	if n := len(EventWatermark([]string{"a"})); n != 16 {
		t.Fatalf("水位长度 = %d, want 16", n)
	}
}
```

（同文件需补 `import ("fmt"; "reflect"; "strings"; "testing")` 与两个小工具函数 `rankInputs(events []Event) []rankInput`、`dedup(events []Event) []Event`——前者把 `Event` 摊成 `rankInput`，后者按 `EventID` 去重。）

- [ ] **Step 6: 跑排名单测**

Run: `go test ./internal/store/ -run 'TestContributionRank|TestDeriveSeats|TestEventWatermark' -v`
Expected: PASS

- [ ] **Step 7: `schema.go` —— `groups` 加三列 + 存量库补列**

`schemaStatements` 里 `groups` 的 CREATE 改为（**新库**走这条）：

```go
	`CREATE TABLE IF NOT EXISTS groups(
		group_id         TEXT PRIMARY KEY,
		creator_id       TEXT NOT NULL,
		epoch            INTEGER NOT NULL,
		roster_rev       INTEGER NOT NULL DEFAULT 0,
		encrypted        INTEGER NOT NULL DEFAULT 1,
		member_ids_json  TEXT NOT NULL,
		key_envelopes    TEXT NOT NULL DEFAULT '[]',
		event_id         TEXT NOT NULL,
		updated_at       INTEGER NOT NULL
	)`,
```

在其后追加（**存量库**走这条，幂等、不 bump `schema_version`）：

```go
// groupColumnMigrations 是 groups 表的**后加列**（#33 册子 §3.8）。
// 与 events / items 同因：schemaStatements 全是 CREATE TABLE IF NOT EXISTS，对既有表不补列。
// 存量行 encrypted 默认 1（语义不变：「存量小组一律加密」，册子 §3.1 / AC 13）。
var groupColumnMigrations = []struct{ column, ddl string }{
	{"roster_rev", `ALTER TABLE groups ADD COLUMN roster_rev INTEGER NOT NULL DEFAULT 0`},
	{"encrypted", `ALTER TABLE groups ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 1`},
	{"key_envelopes", `ALTER TABLE groups ADD COLUMN key_envelopes TEXT NOT NULL DEFAULT '[]'`},
}
```

`migrate()` 在 items 补列之后追加：

```go
	groupCols, err := tableColumns(db, "groups")
	if err != nil {
		return err
	}
	for _, m := range groupColumnMigrations {
		if groupCols[m.column] {
			continue
		}
		if _, err := db.Exec(m.ddl); err != nil {
			return fmt.Errorf("store: migrate groups.%s: %w", m.column, err)
		}
	}
```

- [ ] **Step 8: `group.go` —— `GroupRoster` 加字段、v2 写权、全量事件读、`Force` 带新列**

`GroupRoster` 改为：

```go
type GroupRoster struct {
	GroupID          string
	CreatorID        string
	Epoch            int64
	RosterRev        int64
	Encrypted        int64
	MemberIDsJSON    string
	KeyEnvelopesJSON string
	EventID          string
	UpdatedAt        int64
}
```

新增哨兵与 v2 写入：

```go
var (
	ErrGroupOwnerMismatch   = errors.New("group_owner_mismatch")
	ErrGroupEpochStale      = errors.New("group_epoch_stale")
	ErrGroupRosterRevStale  = errors.New("group_roster_rev_stale")
	ErrGroupFormLocked      = errors.New("group_form_locked")
)

// PutGroupRosterV2 写 v2 名单投影（册子 §3.8）。多签与门槛已由 httpapi 验完，**这里不再校验 owner**——
// 写权已从「owner 锁」放宽为「写者 ∈ 圈内治者名单 ∧ 门槛签数达标」（§3.4）；
// 但三件事必须由本方法兜住：epoch 严格递增、roster_rev 严格递增、encrypted 建圈定死后不可切换（§3.1）。
// 校验失败**不写任何行**。
func (s *Store) PutGroupRosterV2(r GroupRoster) error {
	if r.UpdatedAt == 0 {
		r.UpdatedAt = time.Now().UnixMilli()
	}
	if r.KeyEnvelopesJSON == "" {
		r.KeyEnvelopesJSON = "[]"
	}
	var curEpoch, curRev, curEnc int64
	err := s.db.QueryRow(`SELECT epoch,roster_rev,encrypted FROM groups WHERE group_id=?`, r.GroupID).
		Scan(&curEpoch, &curRev, &curEnc)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		_, err = s.db.Exec(`INSERT INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at)
			VALUES(?,?,?,?,?,?,?,?,?)`,
			r.GroupID, r.CreatorID, r.Epoch, r.RosterRev, r.Encrypted, r.MemberIDsJSON,
			r.KeyEnvelopesJSON, r.EventID, r.UpdatedAt)
		return err
	case err != nil:
		return err
	}
	if r.CreatorID != "" && r.CreatorID != "" { // 占位：creator_id 归属由首个事件决定，v2 不再要求写者等于它
	}
	if r.Encrypted != curEnc {
		return ErrGroupFormLocked // 形态不可切换（册子 §3.1）
	}
	if r.Epoch <= curEpoch {
		return ErrGroupEpochStale
	}
	if r.RosterRev <= curRev {
		return ErrGroupRosterRevStale
	}
	// 乐观锁：WHERE 带上读到的旧值，并发下不会把更旧的行盖上去。
	_, err = s.db.Exec(`UPDATE groups SET epoch=?,roster_rev=?,member_ids_json=?,key_envelopes=?,event_id=?,updated_at=?
		WHERE group_id=? AND epoch=? AND roster_rev=?`,
		r.Epoch, r.RosterRev, r.MemberIDsJSON, r.KeyEnvelopesJSON, r.EventID, r.UpdatedAt,
		r.GroupID, curEpoch, curRev)
	return err
}
```

> 上面那行 `if r.CreatorID != "" && r.CreatorID != ""` 是**占位注释块，实现时删掉**（写在这里是为了提醒：v2 路径**不校验** creator_id 归属——`creator_id` 仍由首个 roster 事件锁定，之后 `PutGroupRosterV2` 不改它）。

`ForceGroupRoster` 的 SQL 与参数带上三个新列：

```go
	res, err := s.db.Exec(`INSERT INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?)
		ON CONFLICT(group_id) DO UPDATE SET
			epoch=excluded.epoch, roster_rev=excluded.roster_rev, encrypted=excluded.encrypted,
			member_ids_json=excluded.member_ids_json, key_envelopes=excluded.key_envelopes,
			event_id=excluded.event_id, updated_at=excluded.updated_at
		WHERE excluded.epoch > groups.epoch`,
		r.GroupID, r.CreatorID, r.Epoch, r.RosterRev, r.Encrypted, r.MemberIDsJSON,
		r.KeyEnvelopesJSON, r.EventID, r.UpdatedAt)
```

`GetGroup` 的 SELECT 列出全部 9 列（顺序与 `Scan` 一一对应）。

`PutGroupRoster`（**v1 兼容路径**）在 `UPDATE` 里把 `roster_rev` 也 +1，并保留 `encrypted` / `key_envelopes` 不动：

```go
	_, err = s.db.Exec(`UPDATE groups SET epoch=?,roster_rev=roster_rev+1,member_ids_json=?,event_id=?,updated_at=?
		WHERE group_id=? AND epoch=?`,
		r.Epoch, r.MemberIDsJSON, r.EventID, r.UpdatedAt, r.GroupID, curEpoch)
```

（`INSERT` 分支补 `roster_rev,encrypted,key_envelopes` 三列，值 `1,1,'[]'`——v1 码建出来的圈子按存量语义恒为封闭圈。）

新增全量读（供派生）：

```go
// ListGroupMsgEvents 读某组的**全部** group.v1 事件（不分页），供席位派生用（册子 §3.3）。
// 与 ListGroupEvents 的区别只有「不给游标、不给 limit」：排名需要全量输入。
// 先读尽再返回，游标在函数内 Close——单连接池下不能留下未闭合游标。
func (s *Store) ListGroupMsgEvents(groupID string) ([]Event, error) {
	rows, err := s.db.Query(`SELECT `+eventColumns+` FROM events WHERE type='group.v1' AND target_id=? ORDER BY created_at ASC, event_id ASC`,
		"group/"+groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
```

- [ ] **Step 9: 补 v2 写权的 store 单测**

追加到 `internal/store/group_test.go`：

```go
func TestPutGroupRosterV2MonotonicAndFormLock(t *testing.T) {
	st := newTestStore(t)
	base := GroupRoster{GroupID: "g1", CreatorID: "c1", Epoch: 1, RosterRev: 1,
		Encrypted: 1, MemberIDsJSON: `["c1"]`, EventID: "e1"}

	// 首写（无行）→ 成立
	if err := st.PutGroupRosterV2(base); err != nil {
		t.Fatalf("首写: %v", err)
	}
	// epoch 相等 → ErrGroupEpochStale
	if err := st.PutGroupRosterV2(GroupRoster{GroupID: "g1", Epoch: 1, RosterRev: 2,
		Encrypted: 1, MemberIDsJSON: `["c1"]`, EventID: "e2"}); !errors.Is(err, ErrGroupEpochStale) {
		t.Fatalf("epoch 未递增应报 stale，得 %v", err)
	}
	// roster_rev 未递增 → ErrGroupRosterRevStale
	if err := st.PutGroupRosterV2(GroupRoster{GroupID: "g1", Epoch: 2, RosterRev: 1,
		Encrypted: 1, MemberIDsJSON: `["c1"]`, EventID: "e3"}); !errors.Is(err, ErrGroupRosterRevStale) {
		t.Fatalf("roster_rev 未递增应报 stale，得 %v", err)
	}
	// 形态切换 → ErrGroupFormLocked（册子 §3.1）
	if err := st.PutGroupRosterV2(GroupRoster{GroupID: "g1", Epoch: 2, RosterRev: 2,
		Encrypted: 0, MemberIDsJSON: `["c1"]`, EventID: "e4"}); !errors.Is(err, ErrGroupFormLocked) {
		t.Fatalf("形态切换应被拒，得 %v", err)
	}
	// 正常推进
	if err := st.PutGroupRosterV2(GroupRoster{GroupID: "g1", Epoch: 2, RosterRev: 2,
		Encrypted: 1, MemberIDsJSON: `["c1","m2"]`, KeyEnvelopesJSON: `[{"from_epoch":1,"cipher":"x"}]`,
		EventID: "e5"}); err != nil {
		t.Fatalf("推进: %v", err)
	}
	g, ok, err := st.GetGroup("g1")
	if err != nil || !ok {
		t.Fatalf("GetGroup: ok=%v err=%v", ok, err)
	}
	if g.Epoch != 2 || g.RosterRev != 2 || g.Encrypted != 1 || g.KeyEnvelopesJSON != `[{"from_epoch":1,"cipher":"x"}]` {
		t.Fatalf("读回错: %+v", g)
	}
}
```

- [ ] **Step 10: 全量跑节点测试**

Run: `go build ./... ; go vet ./... ; go test ./...`
Expected: 全包 ok

- [ ] **Step 11: 提交**

```powershell
git add internal/store/groupseats.go internal/store/groupseats_test.go internal/store/schema.go internal/store/group.go internal/store/group_test.go
git commit -F <临时文件>
```

---

### Task 2: 节点 `group.v1` roster v2——多签验签与门槛

**Files:**
- Modify: `internal/httpapi/group.go`
- Modify: `internal/httpapi/authmw.go`
- New: `internal/httpapi/group_roster_test.go`

- [ ] **Step 1: `authmw.go` 加 6 条新错误码文案**

在 `authErrText` 末尾追加：

```go
	"group_read_denied":              "圈子不存在或不可见",
	"group_invite_required":          "该圈子仅接受邀请码加入",
	"group_roster_quorum_missing":    "签名数不足门槛",
	"group_proposal_proposer_missing": "解散圈子需治理者发起",
	"group_roster_epoch_stale":       "密钥已轮换，请先同步圈内状态",
	"govern_event_conflict":          "同一提案存在并发冲突，已按确定性规则收敛",
```

- [ ] **Step 2: 写失败的单测（AC 6 / AC 7 的门槛拒写）**

新建 `internal/httpapi/group_roster_test.go`。先落地测试基座（沿用 `httpapi_test.go` 的 `newTestServer` / `doJSONMap` 体例）：

```go
package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

const rosterApprovalDomain = "base/group-roster-v2"

// rosterFields 重建节点的待签载荷（与实现同构，故意写两遍：测试若照抄实现就没有独立价值，
// 但这里的**键集**是册子补充 4 的契约，两处必须一致——不一致时测试会红）。
func rosterFields(t *testing.T, b map[string]any) []byte {
	t.Helper()
	f := map[string]any{
		"domain":     rosterApprovalDomain,
		"event_id":   b["event_id"],
		"group_id":   b["group_id"],
		"action":     "roster",
		"sub":        b["sub"],
		"epoch":      b["epoch"],
		"roster_rev": b["roster_rev"],
		"member_ids": b["member_ids"],
		"encrypted":  b["encrypted"],
		"created_at": b["created_at"],
	}
	if name, ok := b["name"]; ok && name != "" {
		f["name"] = name
	}
	raw, err := protocol.Canonicalize(f)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// approval 用给定种子对载荷签名，返回 sigs 的一项。
func approval(t *testing.T, seed string, payload []byte) map[string]any {
	t.Helper()
	kp, err := protocol.KeyPairFromSeed(seed)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := protocol.Sign(kp.PrivHex, payload)
	if err != nil {
		t.Fatal(err)
	}
	id, err := protocol.IdentityID(kp.PubHex)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{"id": id, "sig": sig}
}

func TestRosterV2RemoveQuorumMissing(t *testing.T) {
	// k = 3（m = 11）⇒ 移出需 ⌈2k/3⌉ = 2 名治者签；只给 1 名 ⇒ group_roster_quorum_missing（AC 6）
	st, ts := newTestServer(t)
	seedGroupV2(t, st, "g1", "creator", 11) // 造 m=11 的圈子：创建者 + 10 名在册 + 若干发言

	body := map[string]any{
		"group_id": "g1", "action": "roster", "sub": "remove",
		"epoch": 2, "roster_rev": 2, "member_ids": memberIDsOf(t, st, "g1", 10),
		"encrypted": 1, "event_id": "0000000000000000000000000000000a",
		"created_at": 1790000000000,
	}
	body["sigs"] = []any{approval(t, testSeed, rosterFields(t, body))}
	res := doJSONMap(t, http.MethodPost, ts.URL+"/v1/event", map[string]any{
		"event_id": body["event_id"], "type": "group.v1",
		"created_at": body["created_at"], "body": body, "sig": "",
	}, sigHeaders(t, testSeed, "/v1/event", nil))
	if res.Code != http.StatusForbidden || res.Code2 != "group_roster_quorum_missing" {
		t.Fatalf("want 403 group_roster_quorum_missing, got %d %s", res.Code, res.Code2)
	}
}
```

（`seedGroupV2` / `memberIDsOf` / `sigHeaders` 是本文件的小工具：前者直接调 `st.PutGroupRosterV2` + `st.PutEvent` 造出一个 m=11 的 v2 圈子与若干 `action=msg` 事件；`sigHeaders` 复刻既有测试里构造 5 个签名头的写法。）

- [ ] **Step 3: 跑一遍确认失败**

Run: `go test ./internal/httpapi/ -run TestRosterV2RemoveQuorumMissing -v`
Expected: FAIL —— 节点当前把 `sigs` 当未知键直接 `event_param_invalid`（400），且工具函数未定义

- [ ] **Step 4: 实现 v2 解析、多签验签与门槛**

在 `internal/httpapi/group.go` 里追加常量与结构：

```go
// roster v2 的六个子类型（册子 §3.4 / §3.6）。
const (
	subRename   = "rename"
	subRotate   = "rotate"
	subLeave    = "leave"
	subJoin     = "join"
	subRemove   = "remove"
	subDissolve = "dissolve"
)

// rosterApprovalDomain 是多签的签名域（册子 §3.4；补充 4）。
const rosterApprovalDomain = "base/group-roster-v2"

// maxRosterSigs 是单条 roster 事件的签名条数上限（防一条事件塞进超大数组）。
const maxRosterSigs = 256

// maxRosterEnvelopes 是信封条数上限，与 historialKeys 的 32 epoch 上限同量级。
const maxRosterEnvelopes = 32

// groupApproval 是 sigs[] 的一项。
type groupApproval struct {
	ID  string
	Sig string
}

// groupRosterV2 是 v2 名单体（册子 §3.4）。
type groupRosterV2 struct {
	GroupID    string
	Sub        string
	Epoch      int64
	RosterRev  int64
	Encrypted  int64
	MemberIDs  []string
	Name       string
	Sigs       []groupApproval
	Envelopes  string // 原样存 JSON 数组文本，节点不解释
}
```

`parseGroupBody` 的 `roster` 分支改为：**含 `sigs` 键 ⇒ 走 v2 键集**，否则走既有 v1 键集。

```go
	case "roster":
		if _, isV2 := m["sigs"]; isV2 {
			for k := range m {
				switch k {
				case "group_id", "action", "sub", "epoch", "roster_rev", "member_ids",
					"name", "encrypted", "sigs", "envelopes":
				default:
					return nil, "", false
				}
			}
			if _, ok := parseGroupRosterV2(m); !ok {
				return nil, "", false
			}
			return m, "roster_v2", true
		}
		for k := range m {
			switch k {
			case "group_id", "action", "epoch", "member_ids", "name", "encrypted":
			default:
				return nil, "", false
			}
		}
		if _, ok := parseGroupRoster(m); !ok {
			return nil, "", false
		}
```

`handleGroupEvent` 的 switch 加 `case "roster_v2"` → `s.handleGroupRosterV2(...)`。

`parseGroupRosterV2`：

```go
// parseGroupRosterV2 解析 v2 名单体（册子 §3.4）。键集严格；`sub` 必须在六值枚举内；
// `sigs` 1..maxRosterSigs 条且每条 id 为 32 hex、sig 为 64 hex；`envelopes` 原样保留 JSON 文本。
func parseGroupRosterV2(m map[string]any) (groupRosterV2, bool) {
	var r groupRosterV2
	r.GroupID, _ = m["group_id"].(string)
	if !isHexN(r.GroupID, 16) {
		return r, false
	}
	r.Sub, _ = m["sub"].(string)
	switch r.Sub {
	case subRename, subRotate, subLeave, subJoin, subRemove, subDissolve:
	default:
		return r, false
	}
	epoch, ok := jsonInt(m["epoch"])
	if !ok || epoch < 1 {
		return r, false
	}
	r.Epoch = epoch
	rev, ok := jsonInt(m["roster_rev"])
	if !ok || rev < 1 {
		return r, false
	}
	r.RosterRev = rev
	enc, ok := jsonInt(m["encrypted"])
	if !ok || (enc != 0 && enc != 1) {
		return r, false
	}
	r.Encrypted = enc
	if r.Encrypted == 0 && r.Sub == subJoin {
		// 开放圈自加入必须是不加密形态（补充 9）；封闭圈的 join 另行拒绝，见 handleGroupRosterV2。
	}
	items, ok := m["member_ids"].([]any)
	if !ok || len(items) == 0 || len(items) > maxGroupMembers {
		return r, false
	}
	r.MemberIDs = make([]string, 0, len(items))
	for _, it := range items {
		s, isStr := it.(string)
		if !isStr || !isHexN(s, 16) {
			return r, false
		}
		r.MemberIDs = append(r.MemberIDs, s)
	}
	if v, present := m["name"]; present {
		s, isStr := v.(string)
		if !isStr || len(s) > 64 {
			return r, false
		}
		r.Name = s
	}
	sigs, ok := m["sigs"].([]any)
	if !ok || len(sigs) == 0 || len(sigs) > maxRosterSigs {
		return r, false
	}
	r.Sigs = make([]groupApproval, 0, len(sigs))
	for _, it := range sigs {
		obj, isObj := it.(map[string]any)
		if !isObj {
			return r, false
		}
		id, idOK := obj["id"].(string)
		sig, sigOK := obj["sig"].(string)
		if !idOK || !sigOK || !isHexN(id, 16) || !isHexN(sig, 64) || len(obj) != 2 {
			return r, false
		}
		r.Sigs = append(r.Sigs, groupApproval{ID: id, Sig: sig})
	}
	if v, present := m["envelopes"]; present {
		arr, isArr := v.([]any)
		if !isArr || len(arr) > maxRosterEnvelopes {
			return r, false
		}
		for _, it := range arr {
			obj, isObj := it.(map[string]any)
			if !isObj || len(obj) != 2 {
				return r, false
			}
			if _, ok := obj["from_epoch"]; !ok {
				return r, false
			}
			cipher, ok := obj["cipher"].(string)
			if !ok || len(cipher) == 0 || len(cipher) > maxGroupCipherBytes {
				return r, false
			}
		}
		raw, err := protocol.Canonicalize(map[string]any{"envelopes": arr})
		if err != nil {
			return r, false
		}
		r.Envelopes = string(raw) // 存 {"envelopes":[...]} 的 canonical 文本，读接口原样回吐
	}
	return r, true
}
```

`handleGroupRosterV2`（核心：重建载荷 → 逐条验签 → 去重 → 门槛 → 写库）：

```go
// handleGroupRosterV2 是 v2 名单事件的入口（册子 §3.4）。
// 次序：解析 → 验内容签名（发起者自己）→ 重建多签载荷 → 逐条验签去重 → 门槛判定 → 写库 → 落事件行。
func (s *Server) handleGroupRosterV2(w http.ResponseWriter, actor string, req eventReq, raw map[string]any, createdAt int64) {
	r, _ := parseGroupRosterV2(raw)
	if r.Sub == subJoin {
		// 封闭圈不接受自加入（补充 9）：先看本地形态，再决定放行或拒绝。
		cur, found, err := s.st.GetGroup(r.GroupID)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if (found && cur.Encrypted == 1) || (!found && r.Encrypted == 1) {
			s.writeAuthErr(w, http.StatusForbidden, "group_invite_required")
			return
		}
	}
	payload, err := rosterApprovalPayload(r, req.EventID, createdAt)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	signers, ok := s.verifyRosterApprovals(w, r.Sigs, payload)
	if !ok {
		return
	}
	cur, found, err := s.st.GetGroup(r.GroupID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if found && r.Epoch <= cur.Epoch {
		s.writeAuthErr(w, http.StatusConflict, "group_roster_epoch_stale")
		return
	}
	creatorID := actor
	var memberIDs []string
	var cis []string
	var rosterRev int64
	if found {
		if err := json.Unmarshal([]byte(cur.MemberIDsJSON), &memberIDs); err != nil {
			memberIDs = []string{}
		}
		creatorID = cur.CreatorID
		rosterRev = cur.RosterRev
	}
	cis = memberIDs
	events, err := s.st.ListGroupMsgEvents(r.GroupID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	seats := store.DeriveSeats(cis, creatorID, rosterRev, r.Epoch, events)
	if code := rosterQuorumError(r, signers, ciSet(cis), govSet(seats.Governors), seats); code != "" {
		s.writeAuthErr(w, http.StatusForbidden, code)
		return
	}
	membersJSON, err := json.Marshal(r.MemberIDs)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.st.PutGroupRosterV2(store.GroupRoster{
		GroupID: r.GroupID, CreatorID: creatorID, Epoch: r.Epoch, RosterRev: r.RosterRev,
		Encrypted: r.Encrypted, MemberIDsJSON: string(membersJSON),
		KeyEnvelopesJSON: r.Envelopes, EventID: req.EventID,
	}); err != nil {
		switch {
		case errors.Is(err, store.ErrGroupEpochStale):
			s.writeAuthErr(w, http.StatusConflict, "group_roster_epoch_stale")
		case errors.Is(err, store.ErrGroupRosterRevStale):
			s.writeAuthErr(w, http.StatusConflict, "group_roster_epoch_stale")
		case errors.Is(err, store.ErrGroupFormLocked):
			s.writeAuthErr(w, http.StatusBadRequest, "event_param_invalid")
		default:
			s.writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	bodyJSON, err := protocol.Canonicalize(raw)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UnixMilli()
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: actor, Type: req.Type, BodyJSON: string(bodyJSON),
		CreatedAt: createdAt, ReceivedAt: now, TargetID: "group/" + r.GroupID,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if ev, ok, err := s.st.GetEventByID(req.EventID); err == nil && ok {
		now = ev.ReceivedAt
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"event_id": req.EventID, "received_at": now})
}
```

配套的三个纯函数（同文件）：

```go
// rosterApprovalPayload 重建多签待签载荷（补充 4）：**不信客户端给的字节**，由节点自己拼。
func rosterApprovalPayload(r groupRosterV2, eventID string, createdAt int64) ([]byte, error) {
	f := map[string]any{
		"domain":     rosterApprovalDomain,
		"event_id":   eventID,
		"group_id":   r.GroupID,
		"action":     "roster",
		"sub":        r.Sub,
		"epoch":      r.Epoch,
		"roster_rev": r.RosterRev,
		"member_ids": r.MemberIDs,
		"encrypted":  r.Encrypted,
		"created_at": createdAt,
	}
	if r.Name != "" {
		f["name"] = r.Name
	}
	return protocol.Canonicalize(f)
}

// verifyRosterApprovals 逐条验签并按 id 去重（保留首条）。任一条坏即整条拒收（补充 5）。
func (s *Server) verifyRosterApprovals(w http.ResponseWriter, sigs []groupApproval, payload []byte) (map[string]bool, bool) {
	out := make(map[string]bool, len(sigs))
	for _, a := range sigs {
		if out[a.ID] {
			continue
		}
		it, found, err := s.st.LookupIdentity(a.ID)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return nil, false
		}
		if !found {
			s.writeAuthErr(w, http.StatusForbidden, "identity_unregistered")
			return nil, false
		}
		valid, err := protocol.Verify(it.PubKey, payload, a.Sig)
		if err != nil || !valid {
			s.writeAuthErr(w, http.StatusForbidden, "event_sig_invalid")
			return nil, false
		}
		out[a.ID] = true
	}
	return out, true
}

// ciSet / govSet 把名单切片摊成集合。
func ciSet(ids []string) map[string]bool {
	m := make(map[string]bool, len(ids))
	for _, id := range ids {
		m[id] = true
	}
	return m
}
func govSet(ids []string) map[string]bool { return ciSet(ids) }

// countIn 数签名者里落在集合内的个数。
func countIn(signers, set map[string]bool) int {
	n := 0
	for id := range signers {
		if set[id] {
			n++
		}
	}
	return n
}

// subsetOf 判 signers 是否全部属于 set。
func subsetOf(signers, set map[string]bool) bool {
	for id := range signers {
		if !set[id] {
			return false
		}
	}
	return true
}

// rosterQuorumError 按 sub 判定门槛，返回要回的错误码；"" 表示通过（册子 §3.4）。
func rosterQuorumError(r groupRosterV2, signers, members, governors map[string]bool, seats store.SeatSnapshot) string {
	k := seats.SeatCount
	switch r.Sub {
	case subJoin:
		// 开放圈自加入：签名者集合恒等于 {自己}（补充 9）。
		if len(signers) != 1 || r.Encrypted != 0 {
			return "group_roster_quorum_missing"
		}
		return ""
	case subRename, subRotate, subLeave:
		// 低风险（直权）：任一治者 1 签；签名者必须全是治者。
		if !subsetOf(signers, governors) || countIn(signers, governors) < 1 {
			return "group_roster_quorum_missing"
		}
		return ""
	case subRemove:
		if !seats.Decidable {
			return "group_roster_quorum_missing" // 不可判定 ⇒ 拒写重大动作（补充 6）
		}
		if !subsetOf(signers, governors) || countIn(signers, governors) < store.RemoveQuorum(k) {
			return "group_roster_quorum_missing"
		}
		return ""
	case subDissolve:
		if !seats.Decidable {
			return "group_roster_quorum_missing"
		}
		if !subsetOf(signers, members) {
			return "group_roster_quorum_missing"
		}
		if countIn(signers, governors) < store.DissolveProposerQuorum(k) {
			return "group_proposal_proposer_missing" // 发起段不足（册子 §6）
		}
		if countIn(signers, members) < store.DissolveVoteQuorum(len(members)) {
			return "group_roster_quorum_missing"
		}
		return ""
	}
	return "group_roster_quorum_missing"
}
```

> **口径提醒**：`subDissolve` 的成员门槛要用**当前名单**（变更前）的人数 `len(members)`，不是 `len(r.MemberIDs)`——解散事件本身把名单清空（补充 11），若用新名单会算成 0 人。同理 `subRemove` 的 `k` 用变更前席位（`seats.SeatCount` 由变更前名单派生）。

- [ ] **Step 5: 跑单测**

Run: `go test ./internal/httpapi/ -run TestRosterV2 -v`
Expected: PASS

- [ ] **Step 6: 补 AC 7 的三条算例与「签名者集合归属」用例**

在 `internal/httpapi/group_roster_test.go` 追加：

```go
func TestRosterV2DissolveQuorums(t *testing.T) {
	// AC 7 算例：m=3 → 发起 1 治者 + 成员 2 签；m=11 → 发起 2 治者 + 成员 4 签。
	for _, tc := range []struct {
		name       string
		members    int
		proposers  int
		wantCode   string
	}{
		{"m=3 只给发起不给票", 3, 1, "group_roster_quorum_missing"},
		{"m=11 只给 1 名治者发起", 11, 1, "group_proposal_proposer_missing"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st, ts := newTestServer(t)
			seedGroupV2(t, st, "g1", "creator", tc.members)
			body := dissolveBody(t, st, "g1", tc.members)
			body["sigs"] = []any{approval(t, testSeed, rosterFields(t, body))} // 只给发起者自己
			res := postEvent(t, ts, body)
			if res.Code2 != tc.wantCode {
				t.Fatalf("want %s, got %d %s", tc.wantCode, res.Code, res.Code2)
			}
		})
	}
}

func TestRosterV2DissolveQuorumSatisfied(t *testing.T) {
	// m=3：发起 1 名治者（创建者）+ 成员 2 签（创建者 + 另 1 名成员）⇒ 通过。
	st, ts := newTestServer(t)
	seedGroupV2(t, st, "g1", "creator", 3)
	body := dissolveBody(t, st, "g1", 3)
	p := rosterFields(t, body)
	body["sigs"] = []any{
		approval(t, testSeed, p),          // 创建者：同时计入发起段与投票段（签名去重后复用，册子 §3.4）
		approval(t, memberSeed(1), p),     // 第 2 名成员
	}
	res := postEvent(t, ts, body)
	if res.Code != http.StatusOK {
		t.Fatalf("want 200, got %d %s", res.Code, res.Code2)
	}
	g, ok, _ := st.GetGroup("g1")
	if !ok || g.MemberIDsJSON != "[]" {
		t.Fatalf("解散后名单应清空（补充 11），得 %s", g.MemberIDsJSON)
	}
}

func TestRosterV2SignerNotGovernor(t *testing.T) {
	// 移出成员的签名者必须全是治者：塞一个非治者签名 ⇒ group_roster_quorum_missing
	st, ts := newTestServer(t)
	seedGroupV2(t, st, "g1", "creator", 11)
	body := removeBody(t, st, "g1", 11)
	p := rosterFields(t, body)
	body["sigs"] = []any{
		approval(t, testSeed, p),
		approval(t, outsiderSeed, p), // 不在圈内的身份
	}
	if res := postEvent(t, ts, body); res.Code2 != "group_roster_quorum_missing" {
		t.Fatalf("非治者签名应被拒，得 %d %s", res.Code, res.Code2)
	}
}
```

（`dissolveBody` / `removeBody` / `memberSeed(i)` / `outsiderSeed` / `postEvent` 是文件内小工具。）

- [ ] **Step 7: 跑全量节点测试与提交**

Run: `go build ./... ; go vet ./... ; go test ./...`
Expected: 全包 ok

```powershell
git add internal/httpapi/group.go internal/httpapi/authmw.go internal/httpapi/group_roster_test.go
git commit -F <临时文件>
```

---

### Task 3: 节点读权分支（开放圈匿名 / 封闭圈签名读）+ 席位下发

**Files:**
- Modify: `internal/httpapi/authmw.go`
- Modify: `internal/httpapi/group.go`
- Modify: `internal/httpapi/server.go`
- New: `internal/httpapi/group_read_test.go`

- [ ] **Step 1: 写失败的单测（AC 1 / AC 8 / AC 9）**

新建 `internal/httpapi/group_read_test.go`：

```go
package httpapi

import (
	"net/http"
	"testing"
)

func TestGroupReadClosedCircleDenied(t *testing.T) {
	// AC 1 / AC 9：封闭圈（encrypted=1）非成员读 → 404 + group_read_denied，**不泄露存在性**
	st, ts := newTestServer(t)
	seedGroupV2(t, st, "cl1", "creator", 3) // encrypted=1

	res := doGet(t, ts.URL+"/v1/group/cl1", nil)
	if res.Code != http.StatusNotFound || res.Code2 != "group_read_denied" {
		t.Fatalf("匿名读封闭圈 want 404 group_read_denied, got %d %s", res.Code, res.Code2)
	}
	// 已登记但非成员：同样 404（不区分「不存在」与「无权」）
	res = doGet(t, ts.URL+"/v1/group/cl1", sigHeaders(t, outsiderSeed, "/v1/group/cl1", nil))
	if res.Code != http.StatusNotFound || res.Code2 != "group_read_denied" {
		t.Fatalf("非成员读封闭圈 want 404 group_read_denied, got %d %s", res.Code, res.Code2)
	}
	// 成员：200，且名单与席位字段齐备
	res = doGet(t, ts.URL+"/v1/group/cl1", sigHeaders(t, testSeed, "/v1/group/cl1", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("成员读 want 200, got %d %s", res.Code, res.Code2)
	}
}

func TestGroupReadOpenCircleAnonymous(t *testing.T) {
	// AC 8：开放圈（encrypted=0）匿名可读，且 group 对象带 encrypted / roster_rev / seat_count / governors
	st, ts := newTestServer(t)
	seedGroupV2Open(t, st, "op1", "creator", 3)

	res := doGet(t, ts.URL+"/v1/group/op1", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("匿名读开放圈 want 200, got %d %s", res.Code, res.Code2)
	}
	var page struct {
		Group struct {
			Encrypted int      `json:"encrypted"`
			RosterRev int64    `json:"roster_rev"`
			SeatCount int      `json:"seat_count"`
			Governors []string `json:"governors"`
			Envelopes []any    `json:"envelopes"`
		} `json:"group"`
	}
	if err := json.Unmarshal(res.Body, &page); err != nil {
		t.Fatal(err)
	}
	if page.Group.Encrypted != 0 || page.Group.SeatCount != 1 || len(page.Group.Governors) != 1 {
		t.Fatalf("开放圈形态字段错: %+v", page.Group)
	}
}

func TestGroupReadDissolved(t *testing.T) {
	// 补充 11：解散后 member_ids 为空数组 ⇒ 读接口按「已解散」渲染，两类人都 200（内容已无意义）
	st, ts := newTestServer(t)
	seedGroupV2(t, st, "dis1", "creator", 3)
	if err := st.PutGroupRosterV2(store.GroupRoster{GroupID: "dis1", CreatorID: "creator",
		Epoch: 9, RosterRev: 9, Encrypted: 1, MemberIDsJSON: "[]", EventID: "x"}); err != nil {
		t.Fatal(err)
	}
	if res := doGet(t, ts.URL+"/v1/group/dis1", nil); res.Code != http.StatusOK {
		t.Fatalf("已解散圈 want 200, got %d %s", res.Code, res.Code2)
	}
}

func TestGroupReadLegacyRowDefaultsEncrypted(t *testing.T) {
	// AC 13：存量 0.9.3 建的圈（v1 路径写入）默认 encrypted=1 ⇒ 匿名读 404
	st, ts := newTestServer(t)
	if err := st.PutGroupRoster(store.GroupRoster{GroupID: "legacy1", CreatorID: "old",
		Epoch: 1, MemberIDsJSON: `["old"]`, EventID: "e1"}); err != nil {
		t.Fatal(err)
	}
	if res := doGet(t, ts.URL+"/v1/group/legacy1", nil); res.Code != http.StatusNotFound {
		t.Fatalf("存量圈默认封闭，匿名读应 404，得 %d", res.Code)
	}
}
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `go test ./internal/httpapi/ -run TestGroupRead -v`
Expected: FAIL —— 当前 `handleGroupGet` 匿名一律 200（`TestGroupReadClosedCircleDenied` 挂），且 `group` DTO 无新字段

- [ ] **Step 3: `authmw.go` 抽 `authenticate` + 加 `optionalAuth`**

把 `requireAuth` 的函数体抽成 `authenticate`（**逐行搬运，不加不减**），并新写：

```go
// requireAuth 包装需要签名头的处理器：严格按契约 3.2 的 1→7 顺序，先验后读体。
func (s *Server) requireAuth(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, ok := s.authenticate(w, r)
		if !ok {
			return
		}
		next(w, withIdentity(r, id))
	})
}

// optionalAuth 供按形态分支的读接口用：5 个签名头**全缺**即按匿名放行；
// 缺一半仍按 auth_missing_header 拒（避免「半带头的请求」被静默降级为匿名）。
func (s *Server) optionalAuth(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hasAnyAuthHeader(r) {
			next(w, r)
			return
		}
		id, ok := s.authenticate(w, r)
		if !ok {
			return
		}
		next(w, withIdentity(r, id))
	})
}

// hasAnyAuthHeader 判 5 个头是否至少出现了一个。
func hasAnyAuthHeader(r *http.Request) bool {
	for _, k := range []string{"X-Base-Id", "X-Base-Alg", "X-Base-Ts", "X-Base-Nonce", "X-Base-Sig"} {
		if r.Header.Get(k) != "" {
			return true
		}
	}
	return false
}

// authenticate 执行契约 3.2 的 1..7 步；返回已验签身份 id 与是否放行（失败时响应已写好）。
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (string, bool) {
	// 以下为原 requireAuth 的函数体逐行搬运（第 1 步到第 7 步的验签部分），
	// 末尾由 `next(w, withIdentity(r, id))` 改为 `return id, true`。
}
```

- [ ] **Step 4: `server.go` 把小组读改走 `optionalAuth`**

```go
	// 小组读（册子 §3.7）：**开放圈匿名可读**；封闭圈需成员签名读权（optionalAuth 允许匿名进入，
	// 由 handler 按形态分支决定放行 / 404）。非成员一律 404，不泄露存在性。
	mux.HandleFunc("GET /v1/group/{group_id}", s.optionalAuth(s.handleGroupGet))
```

- [ ] **Step 5: `handleGroupGet` 加形态分支 + DTO 加 5 字段**

```go
type groupDTO struct {
	GroupID   string   `json:"group_id"`
	CreatorID string   `json:"creator_id"`
	Epoch     int64    `json:"epoch"`
	RosterRev int64    `json:"roster_rev"`
	Encrypted int64    `json:"encrypted"`
	MemberIDs []string `json:"member_ids"`
	Name      string   `json:"name"`
	// 以下三项是节点侧只读派生（补充 2）：客户端**不自己排名**，避免名次漂移。
	SeatCount int      `json:"seat_count"`
	Governors []string `json:"governors"`
	// envelopes 是密文（补充 3 / 12），公开返回无害——非成员没有旧钥，解不出任何东西。
	Envelopes []json.RawMessage `json:"envelopes"`
}
```

`handleGroupGet` 在 `GetGroup` 之后插入形态判定：

```go
	actor := identityFrom(r) // 匿名时为空串（optionalAuth 未注入身份）
	members := []string{}
	if err := json.Unmarshal([]byte(g.MemberIDsJSON), &members); err != nil {
		members = []string{} // 投影损坏不该让整页 500
	}
	// 形态分支（册子 §3.7）：开放圈匿名放行；封闭圈需成员签名读权；非成员一律 404（不泄露存在性）。
	if g.Encrypted == 1 && len(members) > 0 && !memberOf(members, actor) {
		s.writeAuthErr(w, http.StatusNotFound, "group_read_denied")
		return
	}
```

派生席位与信封（同一函数内、`ListGroupMsgEvents` 之后）：

```go
	events, err := s.st.ListGroupMsgEvents(groupID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	seats := store.DeriveSeats(members, g.CreatorID, g.RosterRev, g.Epoch, events)
```

响应装配：

```go
	resp.Group = groupDTO{
		GroupID: g.GroupID, CreatorID: g.CreatorID, Epoch: g.Epoch, RosterRev: g.RosterRev,
		Encrypted: g.Encrypted, MemberIDs: members, Name: groupName(s, g.EventID),
		SeatCount: seats.SeatCount, Governors: seats.Governors, Envelopes: []json.RawMessage{},
	}
	if g.KeyEnvelopesJSON != "" && g.KeyEnvelopesJSON != "[]" {
		var wrap struct {
			Envelopes []json.RawMessage `json:"envelopes"`
		}
		if err := json.Unmarshal([]byte(g.KeyEnvelopesJSON), &wrap); err == nil {
			resp.Group.Envelopes = wrap.Envelopes
		}
	}
```

配套小函数：

```go
// memberOf 判 id 是否在名单里；actor 为空（匿名）恒 false。
func memberOf(members []string, actor string) bool {
	if actor == "" {
		return false
	}
	for _, m := range members {
		if m == actor {
			return true
		}
	}
	return false
}
```

- [ ] **Step 6: 跑单测**

Run: `go test ./internal/httpapi/ -run TestGroupRead -v`
Expected: PASS

- [ ] **Step 7: 全量跑 + 提交**

Run: `go build ./... ; go vet ./... ; go test ./...`
Expected: 全包 ok

```powershell
git add internal/httpapi/authmw.go internal/httpapi/group.go internal/httpapi/server.go internal/httpapi/group_read_test.go
git commit -F <临时文件>
```

---

### Task 4: 反熵接收侧——v2 三列与信封的跨节点还原

**Files:**
- Modify: `internal/peersync/eventsync.go`
- Modify: `internal/peersync/eventsync_test.go`

- [ ] **Step 1: 写失败的单测**

追加到 `internal/peersync/eventsync_test.go`：

```go
func TestApplySyncedGroupEventV2(t *testing.T) {
	// v2 名单跨节点后：roster_rev / encrypted / key_envelopes 三列都要被还原（AC 10 的前置）
	st := newTestStore(t)
	body := `{"action":"roster","encrypted":1,"envelopes":[{"cipher":"zzz","from_epoch":1}],` +
		`"epoch":2,"group_id":"g1","member_ids":["a1"],"name":"读书","roster_rev":2,` +
		`"sigs":[{"id":"a1","sig":"ff"}],"sub":"rotate"}`
	written, err := applySyncedGroupEvent(st, eventSyncItem{
		EventID: "e1", ID: "a1", Type: "group.v1", BodyJSON: body, CreatedAt: 1,
	})
	if err != nil || !written {
		t.Fatalf("written=%v err=%v", written, err)
	}
	g, ok, err := st.GetGroup("g1")
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if g.RosterRev != 2 || g.Encrypted != 1 || g.KeyEnvelopesJSON == "" || g.KeyEnvelopesJSON == "[]" {
		t.Fatalf("v2 三列未还原: %+v", g)
	}
}
```

- [ ] **Step 2: 跑一遍确认失败**

Run: `go test ./internal/peersync/ -run TestApplySyncedGroupEventV2 -v`
Expected: FAIL —— `RosterRev` 恒 0、`KeyEnvelopesJSON` 为空

- [ ] **Step 3: 改 `applySyncedGroupEvent`**

```go
// applySyncedGroupEvent 把对端来的 roster 事件落进本地名单投影（册子 §4.4 的延伸）。
// 用 ForceGroupRoster：**不校验 owner**——对端数据在信任域内，且本地可能只收到 epoch>1 的名单；
// 只接受更大的 epoch，旧值静默忽略。发言事件不改变投影，直接返回。
// v2 事件另带 roster_rev / encrypted / key_envelopes（#33 §3.8），一并无损搬运。
func applySyncedGroupEvent(st *store.Store, it eventSyncItem) (bool, error) {
	if it.Type != "group.v1" {
		return false, nil
	}
	var m struct {
		GroupID   string            `json:"group_id"`
		Action    string            `json:"action"`
		Epoch     int64             `json:"epoch"`
		RosterRev int64             `json:"roster_rev"`
		Encrypted *int64            `json:"encrypted"`
		MemberIDs []string          `json:"member_ids"`
		Envelopes []json.RawMessage `json:"envelopes"`
	}
	if err := json.Unmarshal([]byte(it.BodyJSON), &m); err != nil || m.GroupID == "" {
		return false, nil
	}
	if m.Action != "roster" || m.Epoch < 1 || len(m.MemberIDs) == 0 {
		return false, nil
	}
	membersJSON, err := json.Marshal(m.MemberIDs)
	if err != nil {
		return false, err
	}
	// v1 事件（老客户端）没有这两个键：encrypted 缺省按 1（存量语义），信封缺省空数组。
	enc := int64(1)
	encPointer := 0
	if m.Encrypted != nil {
		encPointer = 1
	} else {
		_ = encPointer
	}
	_ = encPointer
	if m.Encrypted != nil {
		enc = *m.Encrypted
	}
	envelopesJSON := "[]"
	if len(m.Envelopes) > 0 {
		raw, err := json.Marshal(m.Envelopes)
		if err != nil {
			return false, err
		}
		envelopesJSON = string(raw)
	}
	return st.ForceGroupRoster(store.GroupRoster{
		GroupID: m.GroupID, CreatorID: it.ID, Epoch: m.Epoch, RosterRev: m.RosterRev,
		Encrypted: enc, MemberIDsJSON: string(membersJSON), KeyEnvelopesJSON: envelopesJSON,
		EventID: it.EventID,
	})
}
```

> **实现时把上面那段 `encPointer` 的死代码删掉**——它只是提醒：「`encrypted` 缺省 = 1」这件事必须显式写，因为 `*int64` 的零值是 `nil` 而不是 0（用 `int64` 会让老事件被误判成**开放圈**，那是安全漏洞）。最终只需保留 `enc := int64(1); if m.Encrypted != nil { enc = *m.Encrypted }`。

- [ ] **Step 4: 跑单测 + 全量**

Run: `go test ./internal/peersync/ -run TestApplySyncedGroupEvent -v ; go build ./... ; go vet ./... ; go test ./...`
Expected: PASS；全包 ok

- [ ] **Step 5: 提交**

```powershell
git add internal/peersync/eventsync.go internal/peersync/eventsync_test.go
git commit -F <临时文件>
```

---

### Task 5: 手机端 `core/group.ts` v2——双形态、多签收集、信封链、席位消费

**Files:**
- Modify: `apps/mobile/src/core/types.ts`
- Modify: `apps/mobile/src/core/group.ts`
- Modify: `apps/mobile/src/core/group.test.ts`

**本 Task 的前置补充（必须与本 Task 一起落地，否则 AC 6 / AC 7 在真机上不可达）：**

15. **多签收集靠「带外码」，零新表**（对应 §3.4 的落地缺口）。手机端**一次只能签自己那一份**，因此多签必须有收集通道。复用本仓既有的 base64url 码体例（#31 的 `base1:` 邀请码、#32 的带外码），新增两段码：
    - `base2:`（**签名请求码**）= base64url(canonical `{v:2, event_id, group_id, sub, epoch, roster_rev, member_ids, encrypted, created_at}`，`name` 非空才带)。它**就是**那次名单变更的完整草稿 → 治者把它发给同伴，或贴进同一台机器的另一身份。
    - `base3:`（**签名回执码**）= base64url(canonical `{v:2, request_hash, id, pub, sig}`)，`request_hash = sha256(canonical(草稿))[0:16]`，`pub` 是签名者公钥 hex（**32 字节 = 64 hex**），`sig` = 该身份对**节点侧同构载荷**（补充 4，含 `domain`）的签名。带 `pub` 是为了让收集方**离线就能验**这条回执（`verify` 要公钥，而回执里只有 id；节点侧仍按 id 查库取公钥，`pub` 字段节点不看）。
    - 发起人自己也算一签（本机直接 `signSigRequest`）。凑够门槛后用 `submitRoster(o, requestCode, receiptCodes)` 提交。
    - 全过程**离线可行**（断网时事件走既有 `comment_out` 队列，与发言同路径）。

- [ ] **Step 1: `types.ts` —— `GroupRow` 加两列**

```ts
export interface GroupRow {
  groupId: string;
  name: string;
  creatorId: string;
  epoch: number;
  /** 形态：0 = 开放圈（明文、匿名可读、自助自加入）；1 = 封闭圈（加密、成员签名读权）。建圈定死不可切换（#33 §3.1）。 */
  encrypted: number;
  /** 成员变更计数，与 epoch 同步 +1（#33 §3.8）。老行（0.9.3 建的）读出为 0，写回时补 1。 */
  rosterRev: number;
  memberIdsJson: string;
  joinedAt: string;
}
```

`repo.ts` 的两张表 DDL **不改**（`ALTER` 不是本仓体例）；改为在 `SqlRepo` / `MemoryRepo` 的行映射函数里**读时容错**：`encrypted` / `roster_rev` 列不存在时分别取 `1` 与 `0`（对应「存量小组一律加密」，AC 13）。具体做法：`saveGroup` 的 INSERT 写成 7 列（含两新列），首次写入即由 SQLite 自动补列——**改用 `INSERT ... ON CONFLICT(group_id) DO UPDATE` 并在 `SCHEMA_SQL` 里为 `groups` 加两列**（`CREATE TABLE IF NOT EXISTS` 对既有表不补列，所以 `repo.ts` 里再补一条幂等的 `ALTER` 容错：先 `PRAGMA table_info(groups)` 查列，缺则 `ALTER TABLE groups ADD COLUMN`）。

- [ ] **Step 2: 写失败的单测（AC 4 / AC 5 / AC 13）**

在 `apps/mobile/src/core/group.test.ts` 追加（沿用文件内既有的 `fixture()` / `gateOffline()` 体例）：

```ts
it('AC 13：v=1 老邀请码仍可入组，且被识别为封闭圈', async () => {
  const a = fixture();
  const legacy = encodeInviteV1({ /* 老 9 键形态 */ });
  const { group } = await acceptInvite(a.o, legacy);
  expect(group.encrypted).toBe(1); // 老码没有 encrypted 字段 ⇒ 缺省封闭（存量语义）
  expect(group.rosterRev).toBe(0);
});

it('AC 4：轮换后其余成员靠信封链自动拿到新钥，无需粘贴续期码', async () => {
  const a = fixture();
  const created = await createGroup(a.o, { name: '读书', encrypted: true });
  // 创建者移出一名成员并轮换 → 生成信封
  const rotated = await rotateGroup(a.o, created.group.groupId, {
    memberIds: [created.group.creatorId, MEMBER_B],
  });
  expect(rotated.group.epoch).toBe(2);
  // B 侧只用「节点读接口下发的 envelopes」就能解出 epoch 2 的钥
  const b = fixture();
  stubGroupReadWithEnvelopes(b, rotated.envelopes, 2);
  await acceptInvite(b.o, created.inviteCode); // B 先持 epoch 1
  const keysBefore = await b.repo.listGroupKeys(created.group.groupId);
  expect(keysBefore.map((r) => r.epoch)).toEqual([1]);
  await fetchGroupMessages(b.o, created.group.groupId);
  const keysAfter = await b.repo.listGroupKeys(created.group.groupId);
  expect(keysAfter.map((r) => r.epoch).sort()).toEqual([1, 2]); // 自动补上，没粘过任何码
});

it('AC 5：被移出者新消息解密失败且触发原位提示原文', async () => {
  const a = fixture();
  const created = await createGroup(a.o, { name: '读书', encrypted: true });
  const out = fixture(); // 被移出者：本地只有 epoch 1 的钥
  await acceptInvite(out.o, created.inviteCode);
  stubGroupReadWithEnvelopes(a, [envelopeOfEpoch1To2], 2); // 节点已到 epoch 2
  const feed = await fetchGroupMessages(out.o, created.group.groupId);
  expect(feed.notice).toBe(GROUP_KEY_STALE_NOTICE); // 原文可核对（禁止静默）
  expect(feed.events.some((e) => e.text === null)).toBe(true);
});

it('AC 6 / AC 7：签名收集码凑不够门槛时 submitRoster 原地报错，不提交', async () => {
  const a = fixture();
  const created = await createGroup(a.o, { name: '读书', encrypted: true });
  const req = await buildRosterRequest(a.o, created.group.groupId, {
    sub: 'remove', memberIds: [...], // m=11 ⇒ k=3 ⇒ 需 2 名治者签
  });
  const mine = await signSigRequest(a.o, req);
  await expect(submitRoster(a.o, req, [mine])).rejects.toThrowError('需 2 名签名（移出成员需治理者）');
});
```

- [ ] **Step 3: 跑一遍确认失败**

Run（cwd `apps/mobile`）: `npx vitest run src/core/group.test.ts`
Expected: FAIL —— `encodeInviteV1` / `acceptInvite` 的 `encrypted` / `buildRosterRequest` 等未定义

- [ ] **Step 4: `group.ts` —— 邀请码升到 v2（进签名域的 12 键）**

```ts
export interface GroupInvite {
  v: number;
  groupId: string;
  targetId: string;
  name: string;
  epoch: number;
  groupKeyHex: string;
  /** = **签发者**身份 id（任一在册成员或治者均可签发，字段名沿用以保 v1 兼容，册子 §3.6）。 */
  creatorId: string;
  creatorPubHex: string;
  createdAt: number;
  /** v2 新增，**进签名域**：能解入圈前的历史（最多 32 个 epoch，册子 §3.5）。 */
  historyKeys?: string[];
  /** v2 新增，**进签名域**：0 = 开放圈，1 = 封闭圈。 */
  encrypted?: number;
  /** v2 新增，**进签名域**：签发时的成员变更计数。 */
  rosterRev?: number;
  sig: string;
}

/** 签名域（补充 4 的客户端镜像）：v1 恒 9 键（老客户端能验），v2 把三个新键一起签进去。 */
function inviteSignFields(inv: GroupInvite): Record<string, Json> {
  const f: Record<string, Json> = {
    v: inv.v,
    group_id: inv.groupId,
    target_id: inv.targetId,
    name: inv.name,
    epoch: inv.epoch,
    group_key: inv.groupKeyHex,
    creator_id: inv.creatorId,
    creator_pub: inv.creatorPubHex,
    created_at: inv.createdAt,
  };
  if (inv.v >= 2) {
    f.history_keys = inv.historyKeys ?? [];
    f.encrypted = inv.encrypted ?? 1;
    f.roster_rev = inv.rosterRev ?? 1;
  }
  return f;
}
```

`decodeInvite` 的改动只有两处：版本判定 `inv.v !== 1 && inv.v !== 2` ⇒ 拒；解析时带上 `historyKeys` / `encrypted` / `rosterRev`，并在 `v === 2` 时校验 `historyKeys` 每项 64 hex 且 ≤ 32 个、`encrypted ∈ {0,1}`、`rosterRev ≥ 1`。

- [ ] **Step 5: `group.ts` —— 信封链与密钥补全**

```ts
export interface GroupEnvelope {
  fromEpoch: number;
  cipher: string;
}

/** 造一个信封：**用旧 epoch 钥加密新 epoch 钥**（补充 3，对称链、零新算法）。 */
export function sealEnvelope(oldKey: Uint8Array, newKey: Uint8Array, fromEpoch: number): GroupEnvelope {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const ct = sealWithNonce(oldKey, nonce, newKey);
  const buf = new Uint8Array(nonce.length + ct.length);
  buf.set(nonce, 0);
  buf.set(ct, nonce.length);
  return { fromEpoch, cipher: bytesToBase64Url(buf) };
}

export function openEnvelope(oldKey: Uint8Array, env: GroupEnvelope): Uint8Array {
  const buf = base64UrlToBytes(env.cipher);
  if (buf.length < GCM_NONCE_BYTES + 16) throw new Error('group: 信封过短');
  return openWithNonce(oldKey, buf.subarray(0, GCM_NONCE_BYTES), buf.subarray(GCM_NONCE_BYTES));
}

/**
 * 从「本地已持有的 epoch 密钥 + 节点下发的信封」解链到 `targetEpoch`（补充 3）。
 * 先把 epoch 递减到「本地已有的一层」，再逐层向上解开；链长上限 32（与历史上限同值）。
 */
export function resolveKeyChain(
  have: Map<number, Uint8Array>,
  envelopes: GroupEnvelope[],
  targetEpoch: number,
): Uint8Array | null {
  const direct = have.get(targetEpoch);
  if (direct) return direct;
  const byFrom = new Map(envelopes.map((e) => [e.fromEpoch, e]));
  const chain: GroupEnvelope[] = [];
  let epoch = targetEpoch;
  while (!have.has(epoch)) {
    const env = byFrom.get(epoch - 1);
    if (!env || epoch <= 1 || chain.length >= 32) return null;
    chain.push(env);
    epoch -= 1;
  }
  let key = have.get(epoch)!;
  for (let i = chain.length - 1; i >= 0; i--) {
    try {
      key = openEnvelope(key, chain[i]!);
    } catch {
      return null; // 链上任一层解不开 ⇒ 整链放弃（不半途而废，避免写进错误的钥）
    }
  }
  return key;
}
```

`fetchGroupMessages` 在建立 `keyMap` 之后、解密之前插入补钥环节：

```ts
  // 节点下发的信封链：缺哪一层的钥就现解现写（补充 12 的落地路径，AC 4）。
  const missing = new Set(page.events.map((e) => e.epoch).filter((n) => !keyMap.has(n)));
  if (missing.size > 0) {
    const resolved = resolveKeyChain(keyMap, page.group.envelopes, page.group.epoch);
    if (resolved) {
      await o.repo.putGroupKey({
        groupId,
        epoch: page.group.epoch,
        keyCipher: await sealGroupKey(o.adapters.storage, resolved),
        createdAt: new Date().toISOString(),
      });
      keyMap.set(page.group.epoch, resolved);
    }
  }
```

（`page.group.envelopes` 由 `fetchGroup` 解析，字段形态 `{from_epoch, cipher}` → 映射为 `{fromEpoch, cipher}`。）

- [ ] **Step 6: `group.ts` —— v2 名单草稿、签名请求/回执码、多签提交**

```ts
export type RosterSub = 'rename' | 'rotate' | 'leave' | 'join' | 'remove' | 'dissolve';

export interface RosterDraft {
  v: 2;
  eventId: string;
  groupId: string;
  sub: RosterSub;
  epoch: number;
  rosterRev: number;
  memberIds: string[];
  encrypted: number;
  createdAt: number;
  name?: string;
}

/** 节点侧同构的待签载荷（补充 4）：`domain` 只在签名时加，不进请求体。 */
function approvalFields(d: RosterDraft): Record<string, Json> {
  const f: Record<string, Json> = {
    domain: 'base/group-roster-v2',
    event_id: d.eventId,
    group_id: d.groupId,
    action: 'roster',
    sub: d.sub,
    epoch: d.epoch,
    roster_rev: d.rosterRev,
    member_ids: [...d.memberIds],
    encrypted: d.encrypted,
    created_at: d.createdAt,
  };
  if (d.name) f.name = d.name;
  return f;
}

/** 草稿码 `base2:`：**去掉 domain**（它是节点的验签域常量，不是协议字段）。 */
function draftFields(d: RosterDraft): Record<string, Json> {
  const f = { ...approvalFields(d) };
  delete f.domain;
  return f;
}

/** 两段码的前缀；本册的 `base2:` / `base3:`（补充 15）。 */
const ROSTER_REQUEST_PREFIX = 'base2:';
const SIG_RECEIPT_PREFIX = 'base3:';
const ROSTER_SUBS: RosterSub[] = ['rename', 'rotate', 'leave', 'join', 'remove', 'dissolve'];

export function encodeRosterRequest(d: RosterDraft): string {
  return `${ROSTER_REQUEST_PREFIX}${bytesToBase64Url(utf8(canonicalize({ v: 2, ...draftFields(d) })))}`;
}

/**
 * `base2:` 的逆运算。任何形态不合法都统一报 `roster_request_invalid`（不猜、不修）。
 * 注意 `isHexN` 在本文件是**字符数**口径（`core/group.ts:156`），id 为 32 hex、pub 为 64 hex、sig 为 128 hex。
 */
export function decodeRosterRequest(code: string): RosterDraft {
  const raw = code.trim();
  if (!raw.startsWith(ROSTER_REQUEST_PREFIX)) {
    throw new GroupError('roster_request_invalid', '这不是签名请求码（应以 base2: 开头）');
  }
  let o: Record<string, any>;
  try {
    o = JSON.parse(decodeUtf8(base64UrlToBytes(raw.slice(ROSTER_REQUEST_PREFIX.length))));
  } catch {
    throw new GroupError('roster_request_invalid', '签名请求码不是合法的 base64url JSON');
  }
  const nameOK = o.name === undefined || typeof o.name === 'string';
  const ok =
    o.v === 2 &&
    typeof o.event_id === 'string' && isHexN(o.event_id, 32) &&
    typeof o.group_id === 'string' && isHexN(o.group_id, 32) &&
    ROSTER_SUBS.includes(o.sub) &&
    Number.isInteger(o.epoch) && o.epoch >= 1 &&
    Number.isInteger(o.roster_rev) && o.roster_rev >= 1 &&
    Array.isArray(o.member_ids) && o.member_ids.length > 0 &&
    o.member_ids.every((s: unknown) => typeof s === 'string' && isHexN(s, 32)) &&
    (o.encrypted === 0 || o.encrypted === 1) &&
    Number.isInteger(o.created_at) && o.created_at > 0 &&
    nameOK;
  if (!ok) throw new GroupError('roster_request_invalid', '签名请求码字段不合法');
  const d: RosterDraft = {
    v: 2,
    eventId: o.event_id,
    groupId: o.group_id,
    sub: o.sub,
    epoch: o.epoch,
    rosterRev: o.roster_rev,
    memberIds: [...o.member_ids],
    encrypted: o.encrypted,
    createdAt: o.created_at,
  };
  if (typeof o.name === 'string' && o.name !== '') d.name = o.name;
  return d;
}

/** 自己对草稿签名，产出 `base3:` 回执码。 */
export async function signSigRequest(o: GroupOptions, code: string): Promise<string> {
  const d = decodeRosterRequest(code);
  const ident = await ensureLocalIdentity(o.adapters.storage);
  const sig = sign(ident.seedHex, utf8(canonicalize(approvalFields(d))));
  const requestHash = sha256Hex(utf8(canonicalize({ v: 2, ...draftFields(d) }))).slice(0, 16);
  return `${SIG_RECEIPT_PREFIX}${bytesToBase64Url(
    utf8(canonicalize({ v: 2, request_hash: requestHash, id: ident.id, pub: ident.pubHex, sig })),
  )}`;
}

/**
 * 校验一条回执是否针对**这份草稿**、且签名有效；返回 `{id, pub, sig}` 或 null（不抛错——收码入口只需过滤）。
 * `pub` 由本地推导的 id 自证（`deriveIdentityId(pub) === id`），故离线即可验签（补充 15）。
 */
export function readSigReceipt(code: string, d: RosterDraft): { id: string; pub: string; sig: string } | null {
  const raw = code.trim();
  if (!raw.startsWith(SIG_RECEIPT_PREFIX)) return null;
  let o: Record<string, any>;
  try {
    o = JSON.parse(decodeUtf8(base64UrlToBytes(raw.slice(SIG_RECEIPT_PREFIX.length))));
  } catch {
    return null;
  }
  if (
    o?.v !== 2 ||
    typeof o.request_hash !== 'string' ||
    typeof o.id !== 'string' || !isIdentityId(o.id) ||
    typeof o.pub !== 'string' || !isHexN(o.pub, 64) ||
    typeof o.sig !== 'string' || !isHexN(o.sig, 128) ||
    deriveIdentityId(o.pub) !== o.id
  ) {
    return null;
  }
  const want = sha256Hex(utf8(canonicalize({ v: 2, ...draftFields(d) }))).slice(0, 16);
  if (o.request_hash !== want) return null; // 回执是给别的草稿签的 ⇒ 丢弃（不报错）
  if (!verify(o.pub, utf8(canonicalize(approvalFields(d))), o.sig)) return null;
  return { id: o.id, pub: o.pub, sig: o.sig };
}

/**
 * 提交一次名单变更（册子 §3.4）。`receipts` 里只保留**验过的**那几条；门槛不足时**原地报错**——
 * 错误文案按册子 §6 的原位提示口径（「需 N 名签名（…），当前 M 名」）。
 */
export async function submitRoster(
  o: GroupOptions,
  requestCode: string,
  receipts: string[],
): Promise<{ queued: boolean; epoch: number }> {
  const d = decodeRosterRequest(requestCode);
  // 1. 只留「针对这份草稿、签名有效」的回执；同一 id 只算一签（节点侧也去重，这里只是镜像）
  const signers = new Map<string, { id: string; sig: string }>();
  for (const code of receipts) {
    const r = readSigReceipt(code, d);
    if (r) signers.set(r.id, { id: r.id, sig: r.sig });
  }
  // 2. 门槛镜像：k 只依赖 m（纯函数，客户端算得出）；「谁算治者」依赖贡献度排名，客户端算不出 ⇒ 留给节点裁决
  const m = d.memberIds.length;
  const q = quorumOf(d.sub, governorSeats(m), m);
  if (signers.size < q.votes) {
    throw new GroupError('roster_quorum_missing', `需 ${q.votes} 名签名（${q.label}），当前 ${signers.size} 名`);
  }
  // 3. 信封里的 `event_id` / `created_at` **必须等于草稿值**：节点按这两个值重建多签载荷（补充 4）
  const ident = await ensureLocalIdentity(o.adapters.storage);
  const body: Record<string, Json> = {
    group_id: d.groupId,
    action: 'roster_v2',
    sub: d.sub,
    epoch: d.epoch,
    roster_rev: d.rosterRev,
    member_ids: [...d.memberIds],
    encrypted: d.encrypted,
    sigs: [...signers.values()],
  };
  if (d.name) body.name = d.name;
  const wire = buildGroupWireAt(ident, d.eventId, d.createdAt, body);
  const { queued } = await submitWire(o, {
    eventId: d.eventId, wire, targetId: `group/${d.groupId}`, queueText: q.label,
  });
  return { queued, epoch: d.epoch };
}

/**
 * 与 `buildGroupWire` 同构，但 **`event_id` / `created_at` 由调用方给定**（补充 17）。
 *
 * 为什么不能用 `buildGroupWire`：v2 名单的多签载荷由节点按 `req.EventID` + `req.CreatedAt`
 * 重建（`rosterApprovalPayload`），而这两个值来自**外层信封**。若信封里的 `event_id` 现生成，
 * 就与签名者签进草稿的那个 `event_id` 不一致 ⇒ 全部签名验不过。故 v2 名单必须用本函数。
 */
function buildGroupWireAt(ident: Identity, eventId: string, createdAt: number, body: Json): string {
  const payload: Json = { event_id: eventId, type: 'group.v1', created_at: createdAt, body };
  const sig = sign(ident.seedHex, utf8(canonicalize(payload)));
  return JSON.stringify({ ...(payload as Record<string, Json>), sig });
}
```

`submitRoster` 的门槛预校验（**只是原地提示，不是裁决**——裁决在节点）：

```ts
/** 治理人席位数 k(m)（册子 §3.2）：m ≤ 10 ⇒ 1 席；否则 min(10, 3 + ⌊(m−11)/10⌋)。纯函数，客户端可算。 */
export function governorSeats(m: number): number {
  return m <= 10 ? 1 : Math.min(10, 3 + Math.floor((m - 11) / 10));
}

/** 客户端侧的门槛镜像（仅用于「凑够没凑够」的原位提示；节点侧才是裁决者）。 */
function quorumOf(sub: RosterSub, k: number, m: number): { proposer: number; votes: number; label: string } {
  if (sub === 'dissolve') {
    return { proposer: Math.min(2, k), votes: Math.min(30, Math.floor(m / 3) + 1), label: '解散圈子' };
  }
  if (sub === 'remove') return { proposer: 1, votes: ceil2of3(k), label: '移出成员' };
  return { proposer: 1, votes: 1, label: '改名 / 轮换 / 退出' };
}
const ceil2of3 = (k: number): number => Math.ceil((2 * k) / 3);
```

`GroupErrorCode` 一并加两条（`core/group.ts:37` 的联合类型）：`'roster_request_invalid'`、`'roster_quorum_missing'`。`GroupOptions` / `buildGroupWire` / `submitWire` / `decodeUtf8` / `isIdentityId` / `deriveIdentityId` 均已就位；**只需给现有 import 块补一行 `sha256Hex`**（`@base/protocol-ts` 导出，`identity.ts` 已在用）。

三个便捷入口（建圈 / 轮换 / 移出 / 改名 / 退出 / 解散 / 开放圈自加入）：

```ts
export async function buildRosterRequest(
  o: GroupOptions,
  groupId: string,
  input: { sub: RosterSub; memberIds: string[]; name?: string; bumpEpoch?: boolean },
): Promise<string>   // 读本地 groups 行 → epoch = bumpEpoch ? cur+1 : cur；rosterRev = cur+1 → encodeRosterRequest
export async function joinOpenGroup(o: GroupOptions, groupId: string): Promise<{ queued: boolean }>
export async function renameGroup(o: GroupOptions, groupId: string, name: string): Promise<{ requestCode: string }>
export async function rotateGroup(o: GroupOptions, groupId: string, opts: { memberIds: string[] }): Promise<{ requestCode: string; envelopes: GroupEnvelope[] }>
export async function removeMember(o: GroupOptions, groupId: string, memberId: string): Promise<{ requestCode: string }>
export async function leaveGroup(o: GroupOptions, groupId: string): Promise<{ requestCode: string }>
export async function dissolveGroup(o: GroupOptions, groupId: string): Promise<{ requestCode: string }>
```

`rotateGroup` 与 `createGroup` 负责**本地先换钥**（同 #9 的三步，但移出者不再需要续期码）：

```ts
/** 轮换：新 epoch 钥 → 用旧钥封一个信封 → 本地写钥并前推 epoch（册子 §3.5）。 */
async function localRotate(o: GroupOptions, cur: GroupRow, memberIds: string[]):
  Promise<{ group: GroupRow; envelope: GroupEnvelope | null; newKeyHex: string }> {
  const epoch = cur.epoch + 1;
  const newKeyHex = bytesToHex(randomBytes(GROUP_KEY_BYTES));
  const oldRow = (await o.repo.listGroupKeys(cur.groupId)).find((r) => r.epoch === cur.epoch);
  let envelope: GroupEnvelope | null = null;
  if (oldRow) {
    try {
      const oldKey = await openGroupKey(o.adapters.storage, oldRow.keyCipher);
      envelope = sealEnvelope(oldKey, hexToBytes(newKeyHex), cur.epoch);
    } catch {
      envelope = null; // 本地旧钥解不开 ⇒ 不产信封（成员需重贴邀请码，UI 原位提示）
    }
  }
  await o.repo.putGroupKey({
    groupId: cur.groupId, epoch,
    keyCipher: await sealGroupKey(o.adapters.storage, hexToBytes(newKeyHex)),
    createdAt: new Date().toISOString(),
  });
  const group: GroupRow = { ...cur, epoch, rosterRev: (cur.rosterRev || 0) + 1,
    memberIdsJson: JSON.stringify(memberIds) };
  await o.repo.saveGroup(group);
  return { group, envelope, newKeyHex };
}
```

- [ ] **Step 7: `group.ts` —— 建圈选型与读权分支**

`createGroup` 的入参由 `{ name }` 改为 `{ name: string; encrypted: boolean }`：`encrypted ? 1 : 0`；**开放圈不发 `sigs`**——开放圈建圈仍走 v1 形态的 roster（无 `sigs`）也能被节点接受（v1 路径），但为了带上 `encrypted = 0` 必须走 v2，故**开放圈建圈也发 v2 roster**，`sigs` 里只有自己、`sub = 'rename'`？不行——`rename` 要求签名者是治者，而建圈时本地还没有 `groups` 行 ⇒ 节点不可判定。

**定案（补充 16）：建圈一律走 v1 形态的 roster（无 `sigs`）**，`encrypted` 由**节点侧的 v1 分支按 body 里的 `encrypted` 键取值**——即 `putGroupRoster` 扩一个可选键 `encrypted`，缺省 1。这样：
- 老客户端（不带 `encrypted`）⇒ 默认 1，语义不变（AC 13）；
- 新客户端建开放圈 ⇒ 带 `encrypted: 0`，节点按 0 落库；
- 建圈不需要任何门槛判定（首个 roster 事件锁定 `creator_id`，owner 锁天然成立）。

对应节点侧改动：`parseGroupBody` 的 v1 roster 键集**加一个 `encrypted`**，`putGroupRoster` 把它传给 `PutGroupRoster`（store 侧 v1 路径落库时带上，缺省 1）。**这个补充要在 Task 2 一并实现**（Task 2 Step 4 的 v1 键集改写为 `group_id, action, epoch, member_ids, name, encrypted`）。

17. **v2 名单信封的 `event_id` / `created_at` 必须复用草稿里那两个值**（自查发现的契约缺口）。节点侧 `rosterApprovalPayload(r, req.EventID, createdAt)` 按**外层信封**的 `event_id` + `created_at` 重建多签载荷，而草稿码里已把这两个值固定下来（换值 = 全部同伴签名作废）。故 `submitRoster` **不得**走 `buildGroupWire`（它现生成 `eventId = randomBytes(16)` 与 `Date.now()`），必须走新增的 `buildGroupWireAt(ident, d.eventId, d.createdAt, body)`。`created_at` 只要求 `> 0`（`event.go:52`），无时间窗，故带外收集签名可以慢慢来。
    - 顺带定案：`base3:` 回执码除 `request_hash` / `id` / `sig` 外**再带 `pub`**。理由是收集方要离线验签，而 `verify` 要公钥、回执里原本只有 id；`pub` 由 `deriveIdentityId(pub) === id` 自证，节点侧不看该字段（它按 id 查库取公钥）。

`fetchGroup` 的读权分支：

```ts
export async function fetchGroup(o: GroupOptions, groupId: string, opts: { cursor?: string | null } = {}) {
  const local = await o.repo.getGroup(groupId);
  // 已知封闭圈 ⇒ 直接带签名头；未知（或开放圈）⇒ 先匿名，404 后再带签名头重试一次。
  const first = await getGroupPage(o, groupId, opts, local?.encrypted === 1);
  if (first.status === 404) {
    if (local?.encrypted === 1) throw new GroupError('group_not_found', '圈子不存在或你没有读权');
    const retry = await getGroupPage(o, groupId, opts, true); // 本机不认识这个圈子：可能是封闭圈且我是成员
    if (retry.status === 404) throw new GroupError('group_not_found', '圈子不存在或你没有读权');
    return parseGroupPage(retry, groupId);
  }
  return parseGroupPage(first, groupId);
}

/** 解析一次读响应（含新增的五个 group 字段）；非 200 由调用方处理。 */
function parseGroupPage(res: { body: Uint8Array }, groupId: string): {
  group: GroupInfo; events: GroupMessage[]; nextCursor: string | null;
} {
  const page = JSON.parse(decodeUtf8(res.body)) as {
    group?: Record<string, unknown>;
    events?: Array<Record<string, unknown>>;
    next_cursor?: string | null;
  };
  const g = page.group ?? {};
  const events = (page.events ?? []).map((e) => ({
    eventId: String(e.event_id ?? ''),
    actor: String(e.actor ?? ''),
    createdAt: Number(e.created_at ?? 0),
    replyTo: e.reply_to === null || e.reply_to === undefined ? null : String(e.reply_to),
    epoch: Number(e.epoch ?? 1),
    payloadCid: String(e.payload_cid ?? ''),
    text: null as string | null,
  }));
  return {
    group: {
      groupId: String(g.group_id ?? groupId),
      creatorId: String(g.creator_id ?? ''),
      epoch: Number(g.epoch ?? 1),
      memberIds: Array.isArray(g.member_ids) ? (g.member_ids as unknown[]).map(String) : [],
      name: String(g.name ?? ''),
      encrypted: Number(g.encrypted ?? 1),
      rosterRev: Number(g.roster_rev ?? 0),
      seatCount: Number(g.seat_count ?? 1),
      governors: Array.isArray(g.governors) ? (g.governors as unknown[]).map(String) : [],
      envelopes: Array.isArray(g.envelopes)
        ? (g.envelopes as Array<Record<string, unknown>>).map((e) => ({
            fromEpoch: Number(e.from_epoch ?? 0),
            cipher: String(e.cipher ?? ''),
          }))
        : [],
    },
    events,
    nextCursor: page.next_cursor ?? null,
  };
}
```

`getGroupPage`（`fetchGroup` 的唯一网络出口；非 2xx **不抛错**，把 `status` 交给调用方判 404 重试）：

```ts
async function getGroupPage(
  o: GroupOptions, groupId: string, opts: { cursor?: string | null }, signed: boolean,
) {
  const query = opts.cursor ? `cursor=${encodeURIComponent(opts.cursor)}` : '';
  const path = `/v1/group/${groupId}`;
  let headers: Record<string, string> | undefined;
  if (signed) {
    const ident = await ensureLocalIdentity(o.adapters.storage);
    // `path` 不含 query、`query` 传原串——与节点 `r.URL.Path` / `r.URL.RawQuery` 口径一致
    headers = signRequestHeaders(ident, { method: 'GET', path, query });
  }
  try {
    return await o.adapters.http.get(`${o.nodeBaseUrl}${path}${query ? `?${query}` : ''}`, headers);
  } catch {
    throw new GroupError('network', '无法连接节点，请稍后重试');
  }
}
```

（`signRequestHeaders` 从 `./identity` 追加导入；它已有该导出，`core/comment.ts` 已在用。）

`GroupInfo` 加 `encrypted: number` / `rosterRev: number` / `seatCount: number` / `governors: string[]` / `envelopes: GroupEnvelope[]`。

- [ ] **Step 8: 跑移动端单测**

Run（cwd `apps/mobile`）: `npx vitest run src/core/group.test.ts`
Expected: PASS

- [ ] **Step 9: 全量移动端自测**

Run（cwd `apps/mobile`）: `npx vitest run ; npx tsc --noEmit`
Expected: **≥ 17 文件全绿**（本 Task 若新增 `core/seats.test.ts` 则更多）；`tsc` 无输出

- [ ] **Step 10: 提交**

```powershell
git add apps/mobile/src/core/types.ts apps/mobile/src/core/group.ts apps/mobile/src/core/group.test.ts apps/mobile/src/core/repo.ts apps/mobile/src/core/fakes.ts
git commit -F <临时文件>
```

---

### Task 6: 手机端 UI——圈子列表形态与建圈选型、会话页治者面板

**Files:**
- Modify: `apps/mobile/src/pages/circle/circle.vue`
- Modify: `apps/mobile/src/pages/group/group.vue`

- [ ] **Step 1: `circle.vue` —— 建圈选型与形态标记**

`create()` 改为两步：先问名字，再问形态（`uni.showActionSheet`，两项「开放圈子（任何人可加入、内容公开）」「封闭圈子（仅邀请码加入、内容加密）」）。失败/取消即中止。

```ts
async function create() {
  if (!opts.value) return;
  const name = await ask('新建圈子', '给圈子起个名字');
  if (!name) return;
  const encrypted = await askForm(); // true = 封闭圈，false = 开放圈，null = 取消
  if (encrypted === null) return;
  const r = await createGroup(opts.value, { name: name.trim(), encrypted });
  uni.setClipboardData({ data: r.inviteCode });
  notice.value = encrypted
    ? '封闭圈子已建好，邀请码已复制（含密钥，请只发给要拉进来的人）'
    : '开放圈子已建好（不加密、任何人可加入）';
  await load();
}

/** 形态选择；取消返回 null。**建圈定死不可切换**，故文案必须说清（册子 §3.1）。 */
function askForm(): Promise<boolean | null> {
  return new Promise((resolve) => {
    uni.showActionSheet({
      itemList: ['开放圈子（任何人可加入，内容公开）', '封闭圈子（仅邀请码加入，内容加密）'],
      success: (res) => resolve(res.tapIndex === 1),
      fail: () => resolve(null),
    });
  });
}
```

卡片元信息加形态标记：

```html
<text class="meta">{{ g.encrypted === 1 ? '封闭' : '开放' }} · 成员 {{ memberCount(g.memberIdsJson) }} · epoch {{ g.epoch }}</text>
```

- [ ] **Step 2: `group.vue` —— 治者面板与席位展示**

在成员区之上插入席位与形态块：

```html
<view class="seats">
  <text class="li">形态：{{ feed.group.encrypted === 1 ? '封闭圈子（内容加密）' : '开放圈子（内容公开）' }}</text>
  <text class="li">治理席位：{{ feed.group.seatCount }} 席</text>
  <text class="li">当前治理者：{{ govText }}</text>
</view>
<view v-if="isGovernor" class="panel">
  <text class="act" @click="onRename">改名</text>
  <text class="act" @click="onRemove">移出成员</text>
  <text class="act" @click="onRotate">轮换密钥</text>
  <text class="act" @click="onDissolve">发起解散</text>
</view>
<view class="panel">
  <text class="act" @click="onLeave">退出圈子</text>
</view>
```

`onRemove` / `onRename` / `onRotate` / `onDissolve` / `onLeave` 的**统一流程**（多签收集，对应补充 15）：

```ts
/**
 * 多签提交的四步（补充 15）：出草稿码 → 自己签 → 收集同伴回执 → 提交。
 * 门槛不足时**原地提示**（不提交、不静默、不入队）。
 */
async function multsigSubmit(build: () => Promise<string>) {
  if (!opts.value) return;
  error.value = ''; notice.value = '';
  try {
    const request = await build();
    const mine = await signSigRequest(opts.value, request);
    const receipts = [mine];
    // 收同伴回执：把请求码复制给同伴；同伴在同一台机器的另一身份可用「粘贴回执」入口补签。
    uni.setClipboardData({ data: request });
    notice.value = '签名请求已复制，请发给其他治理者；收到回执后用「粘贴回执」提交';
    pendingRequest.value = request;
    pendingReceipts.value = receipts;
    const r = await submitRoster(opts.value, request, receipts);
    notice.value = r.queued ? '已提交，联网后自动发送' : '已提交';
    await load();
  } catch (e) {
    error.value = e instanceof GroupError ? e.message : (e as Error).message;
  }
}
```

`onLeave` 的**原位提示**（补充 10 的 UX 代价）：

```ts
async function onLeave() {
  if (!opts.value || !feed.value) return;
  if (!isGovernor.value) {
    // 低风险档「自己退出」需任一治者 1 签（册子 §3.4 定稿口径）⇒ 在位提示原文，不假装能退出
    notice.value = '退出圈子需要一名治理者确认，请把下面的请求码发给治理者';
  }
  await multsigSubmit(() => leaveGroup(opts.value!, feed.value!.group.groupId));
}
```

「粘贴回执」入口（同一台机器上换身份补签，或代同伴回执）：

```ts
async function pasteReceipt() {
  const code = await ask('粘贴签名回执', '粘贴 base3: 开头的回执码');
  if (!code || !opts.value || !pendingRequest.value) return;
  const merged = [...pendingReceipts.value, code];
  try {
    const r = await submitRoster(opts.value, pendingRequest.value, merged);
    notice.value = r.queued ? '已提交，联网后自动发送' : '已提交';
    pendingReceipts.value = merged;
    await load();
  } catch (e) {
    error.value = e instanceof GroupError ? e.message : (e as Error).message; // 门槛不足的错误就显示在这里
  }
}
```

- [ ] **Step 3: 构建验证**

Run（cwd `apps/mobile`）: `npx vitest run ; npx tsc --noEmit ; npm run build:h5`
Expected: 测试全绿、`tsc` 干净、`build:h5` 通过

- [ ] **Step 4: 提交**

```powershell
git add apps/mobile/src/pages/circle/circle.vue apps/mobile/src/pages/group/group.vue
git commit -F <临时文件>
```

---

### Task 7: Phase 1 收口——版本号、节点二进制部署、0.11.0 发布四步、文档回填

**Files:**
- Modify: `apps/mobile/src/manifest.json`
- Modify: `docs/README.md`

- [ ] **Step 1: 版本号**

`apps/mobile/src/manifest.json`：`versionName` → `"0.11.0"`，`versionCode` → `"15"`。

- [ ] **Step 2: 全量自测**

Run（cwd `apps/mobile`）: `npx vitest run ; npx tsc --noEmit`
Run（仓库根）: `go build ./... ; go vet ./... ; go test ./...`
Expected: 全绿

- [ ] **Step 3: 节点二进制交叉编译与两节点部署探活**

```bash
# 本机（Windows）交叉编译
$env:GOOS="linux"; $env:GOARCH="amd64"; go build -o based-linux-amd64 ./cmd/based
# 上传 → 两个节点各备份旧二进制 → 替换 → 依次 restart → 逐个探活
```

探活判据（**必须用新错误码**，否则说明二进制还是旧的）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<node>/v1/group/00000000000000000000000000000001
# 期望：404（老二进制会返回 404 的 "404 page not found" 纯文本；新二进制返回 {"code":"group_not_found"}）
curl -s http://<node>/v1/group/00000000000000000000000000000001
```

回滚：`mv /opt/base/based.bak-0.11.0 /opt/base/based && systemctl restart base && systemctl restart base-cache`
（**两个 service 共用同一二进制**，回滚要一起回。）

- [ ] **Step 4: 0.11.0 发布四步**

1. HBuilderX 云打包 APK（证书与前几版一致，记录字节数与 sha256）；
2. 上传到 `/opt/appdl/base-0.11.0.apk`；
3. 落地页 `/opt/appdl/index.html` **整页重写**（改指 0.11.0）后 `scp`；
4. `based release -out /opt/base-cache/data/release.json` 签发新 release 文档，线上验签 `verifyRelease=true`。

- [ ] **Step 5: `docs/README.md` 回填**

- §3 第 35 行（本计划）状态：`已出（待执行）` → `已执行（完整度见本计划「执行实况」；真机验收待人工）`；
- §3 第 33 行（#33 册子）状态：`已定稿（上游同步项见册子 §10；**实施计划 #35 已出**）` → `已定稿（计划 #35 已执行 Phase 1）`；
- §4 依赖图与 §5「状态与下一步」同步。

- [ ] **Step 6: 提交并推送**

```powershell
git add apps/mobile/src/manifest.json docs/README.md
git commit -F <临时文件>
git push origin master
```

---

## Phase 2（L1 全局治理一致性）

### Task 8: 节点 `govern.v1`——事件注册、投影还原、票权水位、老路径只写投影

**Files:**
- Modify: `internal/store/schema.go`
- Modify: `internal/store/govern.go`
- New: `internal/store/govern_projection.go`
- Modify: `internal/httpapi/event.go`
- New: `internal/httpapi/govern_event.go`
- Modify: `internal/httpapi/govern.go`
- Modify: `internal/peersync/eventsync.go`
- New: `internal/httpapi/govern_event_test.go`

- [ ] **Step 1: `schema.go` —— `govern_*` 两表加可空 `source_event_id`**

`govern_proposals` 与 `govern_votes` 的 CREATE 末尾各加 `source_event_id TEXT`；并新增 `governColumnMigrations`（幂等 ALTER，**不 bump `schema_version`**）：

```go
// governColumnMigrations 是 govern_* 两表的**后加列**（#33 册子 §4.4）。
// 两表由本册降级为「本地物化视图」：事件是权威来源，投影列只供既有读接口与兼容期回读。
var governColumnMigrations = []struct{ table, column, ddl string }{
	{"govern_proposals", "source_event_id", `ALTER TABLE govern_proposals ADD COLUMN source_event_id TEXT`},
	{"govern_votes", "source_event_id", `ALTER TABLE govern_votes ADD COLUMN source_event_id TEXT`},
}
```

`migrate()` 里按 `tableColumns(db, m.table)` 逐个补列。

- [ ] **Step 2: 写失败的单测（AC 11 / AC 12）**

新建 `internal/httpapi/govern_event_test.go`：

```go
func TestGovernEventConvergesViaAntiEntropy(t *testing.T) {
	// AC 11：两台节点**只靠反熵**（不做包导出 / 导入）收敛到同一提案结论
	// 做法：在 A 上 POST 两条 govern.v1 事件（proposal + vote），B 从 A 拉一轮 event-sync，
	//       然后断言两边的 ListProposalViews 逐字一致（提案、票集合、生效状态）。
}

func TestGovernEventVoteQuorumSnapshotWatermark(t *testing.T) {
	// AC 12：提案建立后名册变化，结论**不改判**（按快照水位复算稳定）
	// 做法：在 content_version=1 时建提案并投满门槛 → 生效；
	//       随后推高 content_version 并让投票人「落榜」→ 重算仍是 effective。
}

func TestGovernEventConflictFirstWins(t *testing.T) {
	// 同 proposal_id 的并发提案取 (created_at, event_id) 首个；返回的读接口展示被选中的那一条
	// 第二个不同 body 的同 id 事件 → 落库时被忽略并在响应里体现（govern_event_conflict 仅用于查询口径冲突告知）
}
```

- [ ] **Step 3: 跑一遍确认失败**

Run: `go test ./internal/httpapi/ -run TestGovernEvent -v`
Expected: FAIL —— `govern.v1` 未注册（`event_type_unknown`）

- [ ] **Step 4: `event.go` —— 注册与分流**

```go
var eventTypeRegistry = map[string]struct{}{
	"comment.v1": {},
	"group.v1":   {},
	"govern.v1":  {},
}
```

`handleEventPost` 的 switch 加：

```go
	case "govern.v1":
		s.handleGovernEvent(w, actor, req, createdAt)
		return
```

- [ ] **Step 5: `internal/store/govern_projection.go` —— 严格键集、投影还原、并发收敛**

```go
package store

// GovernEventVerb 是 govern.v1 提案的三个动作（与 #27 的三值同源，零新增枚举）。
// GovernEventChoice 是票的两值。
const (
	GovernEventActionProposal = "proposal"
	GovernEventActionVote     = "vote"
)

// GovernProposalEvent 是 govern.v1 的提案体（册子 §4.2）。
type GovernProposalEvent struct {
	ProposalID   string
	TargetItemID string
	Verb         string
	ContentHash  string
	Reason       string
	Title        string
	BodyMD       string
	ContentVersion int64 // 提案快照水位之一（册子 §4.3）
	RevokedRev     int64 // 提案快照水位之二
	CreatedAt    int64
	EventID      string
	Actor        string
}

// GovernProposalEvent 是 govern.v1 的提案体（册子 §4.2）。
// `ProposalID` 是 **int64**：`govern_proposals.proposal_id` 是 `INTEGER PRIMARY KEY`，
// 事件的 `proposal_id` 必须是同一空间（十进制整数字符串，解析在 parseGovernBody）。
type GovernProposalEvent struct {
	ProposalID     int64
	TargetItemID   string
	Verb           string
	ContentHash    string
	Reason         string
	Title          string
	BodyMD         string
	ContentVersion int64 // 提案快照水位之一（册子 §4.3）
	RevokedRev     int64 // 提案快照水位之二
	CreatedAt      int64
	EventID        string
	Actor          string
}

// GovernVoteEvent 是 govern.v1 的投票体（册子 §4.2）。
type GovernVoteEvent struct {
	ProposalID int64
	Choice     string
	CreatedAt  int64
	EventID    string
	Actor      string
}

// ErrGovernEventConflict 表示同 proposal_id 的投影已被占位、本次事件不是 (created_at,event_id) 首个。
// 上层（httpapi / peersync）据此**告知而不报错**：投影已收敛，事件行照落（册子 §4.3 / §6）。
var ErrGovernEventConflict = errors.New("store: govern event conflict")

// ProjectGovernProposal 把提案事件投影进 govern_proposals（册子 §4.4）。
// **并发收敛**：同 proposal_id 已有投影时，取 (created_at, event_id) 字典序**首个**——
// 后来的冲突事件不覆盖，返回 ErrGovernEventConflict 供上层告知（册子 §4.3 / §6）。
func (s *Store) ProjectGovernProposal(e GovernProposalEvent) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// 写语句置最前（沿用 addVoteTx 体例：单连接池下先拿写锁，避免并发读到旧值）。
	var prevCreated int64
	var prevEventID string
	err = tx.QueryRow(`SELECT created_at, COALESCE(source_event_id,'') FROM govern_proposals WHERE proposal_id=?`,
		e.ProposalID).Scan(&prevCreated, &prevEventID)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		// 首次投影：事件是权威，按事件值落库（proposal_id 也取事件值，不依赖本机自增）
		if _, err := tx.Exec(`INSERT INTO govern_proposals(
			proposal_id,action,item_id,proposer_id,reason,title,body_md,base_content_hash,created_at,source_event_id)
			VALUES(?,?,?,?,?,?,?,?,?,?)`,
			e.ProposalID, e.Verb, e.TargetItemID, e.Actor, e.Reason, e.Title, e.BodyMD,
			e.ContentHash, e.CreatedAt, e.EventID); err != nil {
			return fmt.Errorf("store: 投影提案: %w", err)
		}
		// 提案人自投第 1 票（与 CreateProposal 同构；票的 created_at 用**事件值**，不是本机 now）
		if _, err := tx.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,created_at,source_event_id)
			VALUES(?,?,?,?) ON CONFLICT(proposal_id,voter_id) DO NOTHING`,
			e.ProposalID, e.Actor, e.CreatedAt, e.EventID); err != nil {
			return fmt.Errorf("store: 投影提案人第 1 票: %w", err)
		}
		return tx.Commit()
	case err != nil:
		return err
	}
	// 已有投影：一律**不覆盖**（首条胜出）。同一条事件重放属幂等，不算冲突。
	if prevEventID == e.EventID {
		return nil
	}
	return ErrGovernEventConflict
}

// ProjectGovernVote 把投票事件投影进 govern_votes（册子 §4.4）。
// 同 (proposal_id, voter_id) 取**最早**的 (created_at, event_id)；后来的不覆盖（幂等重放也不报错）。
func (s *Store) ProjectGovernVote(e GovernVoteEvent) error {
	// 「最早」按 **事件的 created_at** 比较，而不是到达顺序：先到的可能是较晚的事件，
	// 故不能只靠 PRIMARY KEY + DO NOTHING，要在占位更晚时替换。
	var prevCreated int64
	var prevEventID string
	err := s.db.QueryRow(`SELECT created_at, COALESCE(source_event_id,'') FROM govern_votes WHERE proposal_id=? AND voter_id=?`,
		e.ProposalID, e.Actor).Scan(&prevCreated, &prevEventID)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if _, err := s.db.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,created_at,source_event_id) VALUES(?,?,?,?)`,
			e.ProposalID, e.Actor, e.CreatedAt, e.EventID); err != nil {
			return fmt.Errorf("store: 投影投票: %w", err)
		}
		return nil
	case err != nil:
		return err
	}
	if prevEventID == e.EventID {
		return nil // 同一事件重放
	}
	if e.CreatedAt < prevCreated || (e.CreatedAt == prevCreated && e.EventID < prevEventID) {
		if _, err := s.db.Exec(`UPDATE govern_votes SET created_at=?, source_event_id=? WHERE proposal_id=? AND voter_id=?`,
			e.CreatedAt, e.EventID, e.ProposalID, e.Actor); err != nil {
			return fmt.Errorf("store: 收敛投票: %w", err)
		}
	}
	return nil
}
```

`govern_proposals.proposal_id` 是 `INTEGER PRIMARY KEY`（本地自增），而事件的 `proposal_id` **必须是同一空间**才能让老读接口继续工作。**定案**：`govern.v1` 的 `proposal_id` 用**十进制整数字符串**，`parseGovernBody` 解析成 `int64` 后写入 `govern_proposals.proposal_id`；若数值已存在则走上面的首条胜出规则；若不存在则**以事件值为准**（事件是权威，不依赖本机自增）。

- [ ] **Step 6: `httpapi/govern_event.go` —— 严格键集 + 验签 + 投影**

```go
// governProposalKeys / governVoteKeys 是两档严格键集（册子 §4.2）。多一个未知键即拒——
// `verifyEventSig` 会把 body **原样** canonicalize，签的与存的不一致就是漏洞（同 parseCommentBody 口径）。
var governProposalKeys = map[string]struct{}{
	"action": {}, "proposal_id": {}, "target_item_id": {}, "verb": {}, "content_hash": {},
	"content_version": {}, "revoked_rev": {}, "reason": {}, "title": {}, "body_md": {},
}
var governVoteKeys = map[string]struct{}{
	"action": {}, "proposal_id": {}, "choice": {},
}

// onlyKeys 判 m 的键是否全在允许集内。
func onlyKeys(m map[string]any, allowed map[string]struct{}) bool {
	for k := range m {
		if _, ok := allowed[k]; !ok {
			return false
		}
	}
	return true
}

// anyString 取 body 里的字符串值；JSON 数字与字符串都容忍（缺省空串）。
// `proposal_id` / `content_version` / `revoked_rev` 可能被不同客户端写成数字或字符串。
func anyString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case json.Number:
		return t.String()
	case float64:
		return strconv.FormatInt(int64(t), 10)
	}
	return ""
}

// parseGovernBody 校验 govern.v1 的 body（册子 §4.2），返回**客户端原始键集**的 map（供验签重建）。
// action=proposal 键集：{action, proposal_id, target_item_id, verb, content_hash, content_version,
//                          revoked_rev, reason?, title?, body_md?}
// action=vote     键集：{action, proposal_id, choice}
func parseGovernBody(raw json.RawMessage) (map[string]any, string, bool) {
	if len(raw) == 0 {
		return nil, "", false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, "", false
	}
	action, _ := m["action"].(string)
	switch action {
	case "proposal":
		if !onlyKeys(m, governProposalKeys) {
			return nil, "", false
		}
		if _, ok := parseProposalID(anyString(m["proposal_id"])); !ok {
			return nil, "", false
		}
		if !validTargetID(anyString(m["target_item_id"])) {
			return nil, "", false
		}
		if !validProposalAction(anyString(m["verb"])) { // remove / edit / revive 三值枚举
			return nil, "", false
		}
		if !isHexNonEmptyEven(anyString(m["content_hash"])) {
			return nil, "", false
		}
		for _, k := range []string{"content_version", "revoked_rev"} {
			n, ok := jsonInt(m[k])
			if !ok || n < 0 {
				return nil, "", false
			}
		}
		if s, present := m["reason"]; present {
			if _, ok := validProposalReason(anyString(s)); !ok {
				return nil, "", false // 「已给定」却不合规要拒（与 handleProposalPost 同口径）
			}
		}
		if s, present := m["title"]; present && !validItemTitle(anyString(s)) {
			return nil, "", false
		}
		if s, present := m["body_md"]; present {
			if _, isStr := s.(string); !isStr {
				return nil, "", false
			}
		}
		return m, action, true
	case "vote":
		if !onlyKeys(m, governVoteKeys) {
			return nil, "", false
		}
		if _, ok := parseProposalID(anyString(m["proposal_id"])); !ok {
			return nil, "", false
		}
		// 册子 §4.2 只写「choice」未定枚举值 ⇒ 本计划按「1..16 字节 ASCII 非空短串」放行，
		// 语义收敛后只改这一处（补充 18）。
		choice := anyString(m["choice"])
		if len(choice) < 1 || len(choice) > 16 {
			return nil, "", false
		}
		for i := 0; i < len(choice); i++ {
			if choice[i] >= 0x80 {
				return nil, "", false
			}
		}
		return m, action, true
	}
	return nil, "", false
}

// handleGovernEvent 与 handleCommentEvent 共用同一条验签管线（event.go 的 verifyEventSig），
// 验签通过后按 action 投影（册子 §4.2）；**不做墓碑检查**（治理事件不是内容）。
// **投影失败不拒事件**：投影是派生、事件是权威（册子 §4.4），故只记 conflict、事件行照落。
func (s *Server) handleGovernEvent(w http.ResponseWriter, actor string, req eventReq, createdAt int64) {
	rawBody, action, ok := parseGovernBody(req.Body)
	if !ok {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	if !s.verifyEventSig(w, actor, req, rawBody) {
		return
	}
	pid, _ := parseProposalID(anyString(rawBody["proposal_id"]))
	var perr error
	switch action {
	case "proposal":
		cv, _ := jsonInt(rawBody["content_version"])
		rv, _ := jsonInt(rawBody["revoked_rev"])
		perr = s.st.ProjectGovernProposal(store.GovernProposalEvent{
			ProposalID: pid, TargetItemID: anyString(rawBody["target_item_id"]),
			Verb: anyString(rawBody["verb"]), ContentHash: anyString(rawBody["content_hash"]),
			Reason: anyString(rawBody["reason"]), Title: anyString(rawBody["title"]),
			BodyMD: anyString(rawBody["body_md"]),
			ContentVersion: cv, RevokedRev: rv,
			CreatedAt: createdAt, EventID: req.EventID, Actor: actor,
		})
	case "vote":
		perr = s.st.ProjectGovernVote(store.GovernVoteEvent{
			ProposalID: pid, Choice: anyString(rawBody["choice"]),
			CreatedAt: createdAt, EventID: req.EventID, Actor: actor,
		})
	}
	if perr != nil && !errors.Is(perr, store.ErrGovernEventConflict) {
		s.writeError(w, http.StatusInternalServerError, perr.Error())
		return
	}
	// 事件行照落：`body_json` 存**客户端原始键集**（不是减化形态）——反熵把它搬到别的节点后，
	// 接收侧要据它重投影（Step 8），减化会丢掉 verb / content_hash / choice。
	now := time.Now().UnixMilli()
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: actor, Type: req.Type, BodyJSON: string(req.Body),
		CreatedAt: createdAt, ReceivedAt: now,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if ev, ok, err := s.st.GetEventByID(req.EventID); err == nil && ok {
		now = ev.ReceivedAt // 同 event_id 重发时给权威值（与 comment / group 口径一致）
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"event_id": req.EventID, "received_at": now,
		// true = 本次投影未生效（同 proposal_id 已被更早的 (created_at,event_id) 占位）；读接口展示被选中的那一条
		"conflict": perr != nil,
	})
}
```

（`anyString` 也可给 `parseGroupBody` 复用；`jsonInt` 已在 `httpapi/group.go`，`errors` / `strconv` / `time` 已在 `httpapi/govern.go` 的 import 里。）

- [ ] **Step 7: `httpapi/govern.go` —— 老路径保持原行为（不产事件）+ 票权口径改快照水位**

**`handleProposalPost` / `handleVotePost` 一行都不改。** 它们照旧只调 `CreateProposal` / `AddVote` 写 `govern_proposals` / `govern_votes` 两表（新列 `source_event_id` 缺省 `NULL` = 「本地提案 / 本地票」，正是我们想要的语义），**不产出任何 `govern.v1` 事件**。

> **为什么不做「双写 / 桥接」（补充 14，定案见册子 §0.2 / §4.4）**：老路径只有**请求签名**（reqsig），它签的是 `method / path / query / body_sha256 / ts / nonce`，是对「这一次 HTTP 请求」的签名，**不是对事件体的签名**。若节点把它填进事件的 `sig` 字段充当内容签名，就是**节点代用户产出「已签名事件」**——签名者与签名内容不对应，接收侧无从独立验证，等于让节点伪造用户签名。节点没有用户私钥，做不出事件体签名，故**不产事件**。跨节点传播改由新客户端走 `POST /v1/event`（Task 9）——那条路的 `verifyEventSig` 才是真内容签名。

**加一条回归护栏测试**（放进 `internal/httpapi/govern_event_test.go`，防以后有人「顺手补上双写」）：

```go
func TestOldProposalPathProducesNoGovernEvent(t *testing.T) {
	// 补充 14 的护栏：老路径 POST /v1/proposal 与 /v1/proposal/{id}/vote 之后，
	// **事件流里不得出现任何 govern.v1 行**（否则就是节点代用户产签名事件）。
	// 做法：老路径建一条提案并投一票 → 以对端身份从 /v1/event-sync 拉一轮 →
	//       断言返回的事件列表里没有一个 type == "govern.v1"；
	//       再断言 handleProposalList 仍能读到这条提案（投影路径没坏）。
}
```

`handleProposalList` 的票权口径改为**快照水位**：

```go
	// 票权按提案快照水位判定（册子 §4.3，取代 #27 的实时复判）。
	views, err := s.st.ListProposalViews(roster)   // 签名保持，内部口径换掉
```

`store.ListProposalViews` 内部的 `filterRoster(voters, roster)` 改为 `filterRosterAtWatermark(voters, p.ContentVersion, p.RevokedRev)`——按提案行上记录的**快照水位**重放名册，与「当前名册」解耦（AC 12）。名册重放读者是 `ContributorRoster` 的**历史版本**，实现上按 `content_version` / `revoked_rev` 两个既有列过滤（同 #23 的派生口径，加两个上界参数）。

同名册之后的**新客户端写路径**：`POST /v1/event`（`type=govern.v1`）→ `handleGovernEvent`（Step 6）→ `ProjectGovern*`（Step 5）。两条路在**投影层**收敛，互不影响：老路径写两表、不产事件；新路径产事件、由投影写两表。

- [ ] **Step 8: `peersync/eventsync.go` —— 加 `govern.v1` 投影还原**

`pullEvents` 里已有的 `applySyncedGroupEvent(st, it)` 调用点旁，追加（**只记日志、不 return err**——投影失败不能把整页反熵拖停）：

```go
		if _, err := applySyncedGovernEvent(st, it); err != nil {
			log.Printf("peersync: govern.v1 投影失败（事件行已落，读接口可从事件重算）: %v", err)
		}
```

（`peersync/eventsync.go` 现有 import 里补 `log`；该文件已在用 `encoding/json` / `fmt` / `store`。）

```go
// applySyncedGovernEvent 把对端来的 govern.v1 事件投影进本地 govern_* 两表（册子 §4.3）。
// 投影是**幂等**的：重复事件静默忽略；冲突事件（已被更早的 (created_at,event_id) 占位）**不算错**；
// 投影失败**不阻断事件行落地**（事件行才是权威来源，读接口可以从事件重算）。
func applySyncedGovernEvent(st *store.Store, it eventSyncItem) (bool, error) {
	if it.Type != "govern.v1" {
		return false, nil
	}
	// body_json 是**客户端原始键集**（httpapi 存的就是 req.Body 原文），故这里能取到全部字段。
	var m struct {
		Action         string `json:"action"`
		ProposalID     string `json:"proposal_id"`
		TargetItemID   string `json:"target_item_id"`
		Verb           string `json:"verb"`
		ContentHash    string `json:"content_hash"`
		ContentVersion int64  `json:"content_version"`
		RevokedRev     int64  `json:"revoked_rev"`
		Reason         string `json:"reason"`
		Title          string `json:"title"`
		BodyMD         string `json:"body_md"`
		Choice         string `json:"choice"`
	}
	if err := json.Unmarshal([]byte(it.BodyJSON), &m); err != nil || m.ProposalID == "" {
		return false, nil // 形态不认识的事件：落行但不投影（与 parseEventProjection 的零值口径一致）
	}
	pid, err := strconv.ParseInt(m.ProposalID, 10, 64)
	if err != nil || pid <= 0 {
		return false, nil
	}
	switch m.Action {
	case "proposal":
		err := st.ProjectGovernProposal(store.GovernProposalEvent{
			ProposalID: pid, TargetItemID: m.TargetItemID, Verb: m.Verb, ContentHash: m.ContentHash,
			Reason: m.Reason, Title: m.Title, BodyMD: m.BodyMD,
			ContentVersion: m.ContentVersion, RevokedRev: m.RevokedRev,
			CreatedAt: it.CreatedAt, EventID: it.EventID, Actor: it.ID,
		})
		if err != nil && !errors.Is(err, store.ErrGovernEventConflict) {
			return false, err
		}
		return true, nil
	case "vote":
		if err := st.ProjectGovernVote(store.GovernVoteEvent{
			ProposalID: pid, Choice: m.Choice,
			CreatedAt: it.CreatedAt, EventID: it.EventID, Actor: it.ID,
		}); err != nil {
			return false, err
		}
		return true, nil
	}
	return false, nil
}
```

（`errors` / `strconv` 一并补进 import。）

- [ ] **Step 9: 全量跑 + 提交**

Run: `go build ./... ; go vet ./... ; go test ./...`
Expected: 全包 ok

```powershell
git add internal/store/schema.go internal/store/govern.go internal/store/govern_projection.go internal/httpapi/event.go internal/httpapi/govern_event.go internal/httpapi/govern.go internal/httpapi/govern_event_test.go internal/peersync/eventsync.go
git commit -F <临时文件>
```

---

### Task 9: Phase 2 收口——客户端写路径事件化、消费、版本号、0.12.0 发布四步、文档回填

**Files:**
- Modify: `apps/mobile/src/core/govern.ts`
- Modify: `apps/mobile/src/pages/governance/governance.vue`
- Modify: `apps/mobile/src/manifest.json`
- Modify: `docs/README.md`

- [ ] **Step 1: `govern.ts` —— 写路径改走原生 `govern.v1` 事件（补充 20）**

`createProposal` / `vote` 不再走 `signedPost`（reqsig 五头），改为**内容签名 + `POST /v1/event`**（老路径停用后跨节点传播的唯一通道；老客户端仍走老路径，节点侧行为不变）。`import` 增加 `canonicalize` / `sign` / `utf8`（`@base/protocol-ts`）与 `bytesToHex` / `randomBytes`。

```ts
/** 构造并投递一条 govern.v1 事件（与 core/group.ts 的 buildGroupWireAt 同构；事件路径只验内容签名，不需要签名头）。 */
async function postGovernEvent(o: GovernOptions, ident: Identity, body: Record<string, unknown>): Promise<void> {
  const eventId = bytesToHex(randomBytes(16));
  const createdAt = Date.now();
  const payload = { event_id: eventId, type: 'govern.v1', created_at: createdAt, body };
  const sig = sign(ident.seedHex, utf8(canonicalize(payload)));
  const wire = utf8(JSON.stringify({ ...payload, sig }));
  let res;
  try {
    res = await o.adapters.http.post(`${o.nodeBaseUrl}/v1/event`, wire, { 'Content-Type': 'application/json' });
  } catch {
    throw new GovernError('network', '需要联网才能完成该操作');
  }
  if (res.status >= 200 && res.status < 300) return;
  const code = errorCodeOf(decodeUtf8(res.body));
  if (res.status === 429) throw new GovernError('rate_limited', errorText(code, '操作过于频繁，请稍后再试'));
  if (res.status >= 500) throw new GovernError('server', `治理事件投递失败（HTTP ${res.status}）`);
  throw new GovernError('rejected', errorText(code, `治理事件投递失败（HTTP ${res.status}）`));
}
```

`createProposal`：`proposal_id` 由客户端取「当前最大 + 1」（事件是权威来源，节点不再自增）；撞号由节点 `govern_event_conflict` 兜底（人工重试即重取）。

```ts
export async function createProposal(o: GovernOptions, input: CreateProposalInput): Promise<{ proposalId: string }> {
  const ident = await ensureIdentity(o);
  const existing = await listProposals(o);
  const proposalId = existing.reduce((m, p) => Math.max(m, Number(p.proposalId) || 0), 0) + 1;
  const body: Record<string, unknown> = {
    proposal_id: proposalId,
    action: input.action,
    item_id: input.itemId,
    reason: input.reason,
  };
  if (input.action === 'edit') body.edit = { title: input.edit?.title ?? '', body_md: input.edit?.bodyMd ?? '' };
  await postGovernEvent(o, ident, body);
  return { proposalId: String(proposalId) };
}
```

`vote`：body 为 `{proposal_id, choice:'yes'}`；**事件投递的 200 不回票数 / 门槛 / 状态**，故写后重拉一次列表构造响应（本册 §5.6 本就要求调用方随后重拉对齐）。

```ts
export async function vote(o: GovernOptions, proposalId: string): Promise<VoteResult> {
  const ident = await ensureIdentity(o);
  await postGovernEvent(o, ident, { proposal_id: Number(proposalId), choice: 'yes' });
  const fresh = (await listProposals(o)).find((p) => p.proposalId === proposalId);
  return {
    proposalId,
    voteCount: fresh?.voteCount ?? 0,
    threshold: fresh?.threshold ?? 0,
    status: fresh?.status ?? 'pending',
  };
}
```

- [ ] **Step 2: `govern.ts` —— 水位展示与冲突提示**

`ProposalItem` 加两字段，`toProposalItem` 同步（**只加不改**）：

```ts
  /** 提案快照水位（#33 §4.3）：票权按此判定，名册中途变化不改判。 */
  contentVersion: number;
  revokedRev: number;
  /** 非空即为「同 proposal_id 并发冲突、按确定性规则收敛」的告知（#33 §4.3 / §6）。 */
  conflictNote: string;
```

`vote()` 的响应处理加一条：`status === 'void'` 时 `errorText` 走既有的 `proposal_*` 文案，并在页面上把 `conflictNote` 原位显示。

- [ ] **Step 3: `governance.vue` —— 水位与「被选中的那一条」**

提案卡片元信息行加：

```html
<text class="meta">水位 v{{ p.contentVersion }} / rev{{ p.revokedRev }} · 门槛 {{ p.threshold }} 票 · {{ statusText(p.status) }}</text>
<text v-if="p.conflictNote" class="notice">{{ p.conflictNote }}</text>
```

- [ ] **Step 4: 版本号与全量自测**

`manifest.json`：`versionName` → `"0.12.0"`，`versionCode` → `"16"`。

Run（cwd `apps/mobile`）: `npx vitest run ; npx tsc --noEmit ; npm run build:h5`
Run（仓库根）: `go build ./... ; go vet ./... ; go test ./...`
Expected: 全绿

- [ ] **Step 5: 节点二进制重新部署 + 0.12.0 发布四步**

与 Task 7 Step 3 / Step 4 **逐条同构**（换版本号 0.12.0、换备份名 `based.bak-0.12.0`、APK 改名 `base-0.12.0.apk`）。

- [ ] **Step 6: `docs/README.md` 回填**

- §3 第 33 行（#33 册子）状态 → `已定稿（计划 #35 已执行 Phase 1 + Phase 2）`；
- 若册子 §10 要求的 #9 / #27 加注尚未做，**在本 Task 一并补上**：
  - #9 册子 §4.3 的「不做成员准入读控制」行加注「已于 #33 收口，见治理与圈子自治册」；
  - #27 册子 §0 追加一节，写明「票实时复判」被 #33 §4.3 的**快照水位**取代。

- [ ] **Step 7: 提交并推送**

```powershell
git add apps/mobile/src/core/govern.ts apps/mobile/src/pages/governance/governance.vue apps/mobile/src/manifest.json docs/README.md docs/superpowers/specs/2026-09-29-base-groups-design.md docs/superpowers/specs/2026-09-28-base-approval-governance-design.md
git commit -F <临时文件>
git push origin master
```

---

## 人工验收清单（实施完成后交给人工，不在本计划的自动步骤内）

| # | 项 | 对应 AC |
|---|---|---|
| M1 | 封闭圈：非成员点开圈子卡片 → **看不到任何内容**（404 语义），成员点开正常 | AC 1 |
| M2 | 开放圈：任意已登记身份点「自助加入」→ 立即可读；未加入者也能匿名读 | AC 1 / AC 8 |
| M3 | 移出一名成员后：被移出者的新消息显示**密钥已更新**提示原文；其余成员**未粘任何码**却读到了新消息 | AC 4 / AC 5 |
| M4 | `m = 11` 的封闭圈：只给 1 名治者签 → 原位提示「需 2 名签名」；凑够 2 名后提交成功 | AC 6 / AC 7 |
| M5 | `m = 3` 的圈子发起解散：1 名治者发起 + 2 名成员签 → 成功，名单清空 | AC 7 |
| M6 | 两台节点：A 上发起提案并投票，B **不做任何包导入**，等一轮反熵后 B 的 `/v1/proposal` 与 A 逐字一致 | AC 11 |
| M7 | 提案建立后改动名册，结论不改判 | AC 12 |
| M8 | 0.9.3 老客户端用**老邀请码**仍能入组（读回 `encrypted = 1`）；老客户端不会因新字段报错 | AC 13 |
| M9 | 节点 `data/base.db`（含 wal）与 `data/blobs/*` 里搜不到封闭圈明文 | AC 9 |
| M10 | 成员从**缓存节点**（非源节点）读到并解密成功 | AC 10 |
| M11 | **0.13.1 补丁**：手机端发起提案并投票，票满门槛后卡片状态变「已生效」，且受审动作**真的发生**（`remove` → 该条目在课程页消失；`edit` → 标题/正文已改） | AC 11（事件路径生效闭环） |
| M12 | **0.13.1 补丁**：治理卡片显示「水位 vN / revM」（不再恒 0；`content_version`/`revoked_rev` 由 `/v1/proposal` 下发） | 更正 45 ⑧ |

---

## 执行实况（实施后回填）

| # | Task | commit | 实测 |
|---|---|---|---|
| 1 | `groups` 三列 + 席位/贡献度派生 | `7e7dac5` | `go build`/`vet` 干净；`go test ./... -count=1` 全包 ok（`c9ac6a5` 补三处文件尾换行） |
| 2 | `group.v1` roster v2 多签与门槛 | `0c048a6` | `go build`/`vet` 干净；`go test ./... -count=1` 8 包全 ok；`TestRosterV2*` 8 用例（含 3 子例）全 PASS |
| 3 | 读权分支（开放匿名 / 封闭签名） | `a7a945f` | `go build`/`vet` 干净；`go test ./... -count=1` 10 包全 ok；`TestGroupRead*` 5 用例 + `TestGroupGet*` 3 用例 + `TestAuth*OutOfWindow/NonceReplay/BadSignature` 全 PASS；动过的 5 个文件 `gofmt -l` 无输出 |
| 4 | 反熵接收侧 v2 三列 + 信封 | `539f68c` | `go build`/`vet` 干净；`go test ./... -count=1` 全包 ok；`TestApplySyncedGroupEvent*` 4 用例全 PASS（另验证：换回旧实现时 V2/Legacy/Dissolve 三条 FAIL，非空跑）；`gofmt -l` 两文件无输出 |
| 5 | `core/group.ts` v2（双形态 / 多签码 / 信封链） | `148b745` + `c9a087f` + `f2bfa5f` | `npx vitest run` 18 文件 / 169 用例全绿（group 19 用例）；`npx tsc --noEmit` 无输出；动 5 文件（含 `platform/index.ts` 的存量库补列调用） |
| 6 | 圈子列表形态与治者面板 | `b1d71c3` + `912f76f` | `npx vitest run` 18 文件 / 169 用例全绿（未加测试）；`npx tsc --noEmit` 无输出；`npm run build:h5` `DONE Build complete`（**`.vue` 编译错误只有 build:h5 能抓到**）；动 2 文件（`912f76f` 为补「代签请求码」入口，见更正 38） |
| 7 | 0.11.0 发布四步 + 节点二进制部署 | `63e8ddc` | 版本落 `0.11.0`/`15`；门禁 `npx vitest run` 18 文件 / 176 用例全绿（169 为 Phase 1 Task 1–6 基线，+7 来自并行 #36 课程分类线的 `course-tree.test.ts`，已随 `6e4cc37` 进 HEAD）、`npx tsc --noEmit` 无输出、`npm run build:h5` `DONE Build complete`、`.value` 扫描无匹配、Go `build`/`vet`/`test ./... -count=1` 全包 ok；节点二进制交叉编译（21625006 字节 / sha256 `90f3c898…b21f`）上传后**远端 `sha256sum /opt/base/based` 与本地逐字一致**、两 service `active`、探活 `/v1/group/{32hex}` → 404 + `{"code":"group_not_found"}`、`/v1/comment` → 200、`/v1/dm/{32hex}` → 200；`docs/README.md` 第 33/35 行与 §5 已回填。**Step 4 于更正 44 定案作废**（0.11.0 不单独发，客户端改动合并到 Phase 2 的发布；见更正 44） |
| 8 | `govern.v1` 注册 + 投影 + 水位 + 老路径只写投影 | `7071775` | 8 文件（+884/−9）；`go build`/`vet` 无输出；`go test ./... -count=1` 全包 ok；8 文件 `gofmt -l` 无输出；TDD：先红（编译失败，见更正 43 ⑤）→ 实现后 `TestGovernEvent*` 4 条全 PASS；老路径 `handleProposalPost`/`handleVotePost` **一行未改**（补充 14）；**零签名域改动**（更正 41，复用 `verifyEventSig`） |
| 9 | 客户端写路径事件化 + `0.13.0` 发布四步 + 文档回填 | `f0a3a30` | 5 文件（+216/−86）：`core/govern.ts`（写路径改走 `POST /v1/event` 的 `govern.v1` 事件，移除旧 `signedPost`/`signRequestHeaders`；新增 `snapshotWatermark`）、`govern.test.ts`（7 → 9 用例）、`governance.vue`、`manifest.json`（`0.13.0`/`17`）、`docs/README.md`；**主代理独立复跑**：`npx vitest run` 18 文件 / 178 用例全绿、`npx tsc --noEmit` 无输出、`npm run build:h5` `DONE Build complete`、Go `build`/`vet`/`test ./... -count=1` 全包 ok（`cmd/based` … `tools/migrate` 9 包 ok）；节点二进制 21679512 字节 / sha256 `2071335046…c7f6`，远端 `sha256sum /opt/base/based` **独立复验逐字一致**、两 service `active`；发布四步全部完成：APK **27418563 字节 / sha256 `5649bc55…e385`**（与节点 `release.json` 的 `apk_sha256` 一致）、`/opt/appdl/base-0.13.0.apk` 就位、落地页 `0.13.0（versionCode 17）`、公网 `GET /v1/release` → `version_name=0.13.0` / `min_version_name=0.8.0` / `issuer=base-node-1`；`docs/README.md` 第 33/35 行已按更正 44 回填。**两处审查发现的未收口缺口见更正 45 ⑦⑧** |
| 10 | **补丁**：审查缺口修复——事件路径生效闭环 + 提案水位可见 | `d0472d9` | 11 文件（+326/−27）：`store/govern_projection.go`（新增 `SettleGovernProposal`）、`store/govern.go`（抽纯函数 `filterRosterAtWatermarkSet`）、`httpapi/govern_event.go`（投影后 settle）、`httpapi/govern.go`（`proposalDTO` 补 `content_version`/`revoked_rev`）、`peersync/eventsync.go`（两支均 settle）、`httpapi/govern_event_test.go`（+3 用例、AC 11 补 `status` 断言、AC 12 改走事件路径、镜像补 settle）、mobile 4 文件（删 `conflictNote` 与重复门槛/状态文案、`0.13.1`/`18`）；**主代理独立复跑**：`vitest` 18 文件 / 178 用例、`tsc` clean、`build:h5` DONE、Go `build`/`vet`/`test ./... -count=1` 全包 ok、6 个改动 Go 文件的 LF 副本 `gofmt -l` 无输出；节点二进制 21685510 字节，**远端 `/opt/base/based` 与子代理本地产物 `%TEMP%\based-0.13.1-linux-amd64` 的 sha256 `ea1aca50…7902` 逐字一致**（`go version -m` 读得 `vcs.revision=55b56b0619c9`、`vcs.modified=true`）、备份链自洽（`based.bak-0.13.1` = 0.13.0 那版 `2071335046…`）、两 service `active`、`/v1/comment` `/v1/proposal` 200；发布四步全部完成：APK **27418505 字节 / sha256 `3091c4e8…1c50`**（与节点 `release.json` 的 `apk_sha256` 一致）、`/opt/appdl/base-0.13.1.apk` 就位、落地页改指、公网 `GET /v1/release` → `version_name=0.13.1` / `min_version_name=0.8.0`、`HEAD /dl/base-0.13.1.apk` → 200（27418505）。**TDD 红灯证据**：去掉 settle 调用时 `TestGovernEventQuorumSettlesAction` 精确复现 `vote_count:3 threshold:3 status:pending`（即更正 45 ⑦ 的现象）|

---

## 执行期更正（实施后回填，后续 Task 请以本节为准）

（执行时在此追加：与计划的偏差、实测发现、口径更正。每条写清「计划怎么写的 / 实际怎么做的 / 为什么」。编号从**更正 15** 起——#31 计划已用到更正 14。）

**更正 15（Task 2）测试代码与实况不符**。计划 Step 2/6 写的是 `st, ts := newTestServer(t)`、`doJSONMap(t, …, map[…]any{…})`、`sigHeaders(…)`、`group_id` 用 `"g1"`，实况是：`newTestServer` 返回 **3 个值**（`st, _, ts`）、`doJSONMap` 第二参是 **string body**、**不存在** `sigHeaders`、`group_id` 必须是 **32 hex**（`isHexN(gid,16)`）。实际做法：新文件 `internal/httpapi/group_roster_test.go` 按 `testsupport_test.go` / `group_test.go` 的真实体例重写，并自建 `postRosterV2(t, seed, baseURL, eventID, createdAt, body)`——多签载荷要用**同一个** `created_at`，故不能复用内部用 `time.Now()` 的 `groupEventBody`。

**更正 16（Task 2）测试侧不能重复声明签名域常量**。计划 Step 2 让测试文件再写一份 `const rosterApprovalDomain`，但测试与实现同属 `package httpapi`，重复声明编译不过。实际做法：测试侧改名 `rosterDomainWant = "base/group-roster-v2"`，保住「两处独立写、不一致就红」的校验意图。

**更正 17（Task 2）补齐 16 落地的 store 侧改动**。补充 16 要求「新客户端建开放圈 ⇒ body 带 `encrypted:0`，节点按 0 落库」，但 Task 1 的 `PutGroupRoster` v1 INSERT **硬编码** encrypted=1，会把这个 0 吃掉。实际做法：`internal/store/group.go` 的 v1 INSERT 改用调用方解析好的 `r.Encrypted`（UPDATE 分支仍不动 encrypted，形态建圈时定死），并在方法注释里写明缺省口径。因此 Task 2 的提交范围比计划多一个文件：`internal/store/group.go`。

**更正 18（Task 2）`member_ids` 空数组只有 `dissolve` 放行**。计划 Step 4 的 `len(items)==0` 一律拒，但补充 11 要求解散事件把 `member_ids_json` 写成 `[]` ⇒ 计划里的解散用例（`TestRosterV2DissolveQuorumSatisfied`）按计划代码根本不可达。实际做法：`> maxGroupMembers` 恒拒；`==0` 仅当 `sub == subDissolve` 放行；其余 sub 仍要求 1..maxGroupMembers。

**更正 19（Task 2）`join` 的「签名者集合恒等于 {actor}」必须真判**。补充 9 写「签名者集合恒等于 `{actor}`（自己签自己）」，但计划 `rosterQuorumError` 只判了 `len(signers) != 1`，没判那唯一签名者是不是发起者本人。实际做法：`rosterQuorumError` 加首个参数 `actor string`，`subJoin` 分支判 `len(signers) != 1 || !signers[actor] || r.Encrypted != 0`。`TestRosterV2JoinOpenOnly` 里「换成创建者签名提交同一 join」的用例正是这条的负向断言。

**更正 20（Task 2）删掉空分支**。计划 `parseGroupRosterV2` 里有 `if r.Encrypted == 0 && r.Sub == subJoin { /* 只有注释 */ }` 的空分支（与 Task 1 的占位空分支同族）：真判定在更正 19 与 `handleGroupRosterV2` 的封闭圈预判里，空分支只是噪音，已删。

**更正 21（留给 Task 5，未修）客户端 v2 body 的 `action` 值写错**。计划第 2066 行 `submitRoster` 里 `body.action = 'roster_v2'`，但：节点按 `action:"roster"` + body 有无 `sigs` 分流（本 Task 已这样实现），补充 4 的多签待签载荷里 `action` 也固定成 `"roster"`（客户端 `approvalFields` 同）。⇒ **Task 5 实施时必须改成 `action: 'roster'`**，否则 v2 名单在真机上会被节点判 `event_param_invalid`（400）。

**更正 22（Task 3）`authenticate` 必须用具名结果，且**不能**叫 `ok`**。计划 Step 3 要求「1–6 步裸 `return` 逐行搬运」+ 签名 `(string, bool)`，两者互斥（无具名结果时裸 `return` 报 `not enough return values`）。实际做法：签名改 `(actorID string, authed bool)`。**关键坑**：具名结果不能命名成 `ok`——第 3 步 `it, ok, err := s.st.LookupIdentity(id)` 会把具名结果 `ok` 绑到局部（`:=` 只新声明 `it`/`err`），于是 `identity_unregistered` 等失败分支的裸 `return` 会带回 `ok=true`，`requireAuth` 继续 `next(...)` ⇒ **双写响应**，`TestAuthTsOutOfWindow` / `TestAuthNonceReplay` / `TestAuthBadSignature` 变红。同理 `id` 也别与局部重名（本实现里第 3 步用的是 `it`，故 `id` 可用）。

**更正 23（Task 3）既有两个匿名读用例必须改传 `encrypted:0`**。加形态分支后，`TestGroupGetAnonymousListing`（`group_test.go:223`）与 `TestGroupGetPagination`（`:294`）用 v1 建圈（缺省 `encrypted=1`）再匿名 GET，会 404。实际做法：`postGroupRoster` 补 `encrypted int64` 形参并写进 body（`TestGroupRosterOwnerMismatch`/`TestGroupRosterEpochStale` 传 1，两个读用例传 0）——新语义下「匿名可读」只对开放圈成立，用例必须显式表达形态。

**更正 24（Task 3）计划里的存量形态用例写法无效**。计划 `TestGroupReadLegacyRowDefaultsEncrypted` 直接 `st.PutGroupRoster(...)` 且**不传** `Encrypted`，但更正 17 后 store 写的就是调用方给的 `r.Encrypted`（零值 0），「缺省封闭」的语义实际落在 **httpapi 解析层**（`parseGroupRoster` 缺键补 1），所以该用例恒为开放圈、断言必挂。实际做法：改走 HTTP v1 路径（`postGroupBody` 建圈**不带** `encrypted`）→ 匿名 GET 期望 404 `group_read_denied`；再加一个显式 `encrypted:0` 的对照圈期望 200。

**更正 25（Task 3）路由注册只能用 `mux.Handle`**。计划 Step 4 写 `mux.HandleFunc("GET /v1/group/{group_id}", s.optionalAuth(s.handleGroupGet))`，但 `optionalAuth` 返回 `http.Handler`（不是 `func(w,r)`），`HandleFunc` 编译不过。实际做法：`mux.Handle(pattern, s.optionalAuth(s.handleGroupGet))`。

**更正 26（Task 4）`key_envelopes` 必须写包装对象，不能写裸数组**。计划 Step 3 用 `json.Marshal(m.Envelopes)`（`[]json.RawMessage`）得到裸数组 `[{...}]`，但写路径 `httpapi/group.go:295–299` 存的是 `protocol.Canonicalize(map[string]any{"envelopes": arr})`（字段注释明写「读接口就这么解 key_envelopes 列，**别改成裸数组**」），读路径 `httpapi/group.go:726–733` 用 `struct{ Envelopes []json.RawMessage }` 解包——裸数组会 `Unmarshal` 失败且被**静默忽略**，对端 `envelopes` 恒为空数组 ⇒ AC 10（成员从缓存节点解密）在对端断链；而计划的测试只判「`KeyEnvelopesJSON != "" && != "[]"`」，正好漏检这个坑。实际做法：`json.Marshal(map[string]any{"envelopes": m.Envelopes})`（单键无排序歧义，元素为源节点 canonical 字节，故与写路径同形）；测试改为**用读接口同一形态解包并逐字段核对**（恰好 1 条、`cipher`/`from_epoch` 保真）。

**更正 27（Task 4）接收侧必须放行 `dissolve` 的空名单**。计划 Step 3 的 `len(m.MemberIDs) == 0 → return false, nil` 会把解散事件整个丢弃：补充 11 要求解散把名单写成 `[]`（Task 2 更正 18 已按此解析），对端于是永远保留旧名单——已被移出/已解散的成员在缓存节点上仍能读封闭圈（安全侧错误，且与源节点读权表现不一致）。实际做法：结构体加 `Sub string`，判据改为 `len(m.MemberIDs) == 0 && m.Sub != "dissolve" → 忽略`；v1 键集无 `sub`（`parseGroupRoster` 键白名单），不会误放垃圾事件。

**更正 28（Task 4）测试助手名不符**。计划测试用 `newTestStore(t)`，peersync 包内不存在；实为 `openTemp(t) *store.Store`（`testsupport_test.go:52`）。`group_id` 用 `"g1"` 不影响（peersync 侧不做 16 hex 校验，与 httpapi 的 `isHexN(gid,16)` 不同）。另：计划 Step 3 里那段 `encPointer` 死代码，按计划自己的批注已删，只留 `enc := int64(1); if m.Encrypted != nil { enc = *m.Encrypted }`（**必须用 `*int64`**，`int64` 零值 0 会把 v1 老事件误判成开放圈）。

**更正 29（Task 5，真机阻断）v2 名单必须「epoch 与 rosterRev 一起 +1」，且**每次都换钥并随事件 body 下发信封**。计划 `buildRosterRequest` 的 `bumpEpoch?: boolean` 是错的：节点 `handleGroupRosterV2` 前置 `found && r.Epoch <= cur.Epoch ⇒ 409 group_roster_epoch_stale`（`group.go:461`），`store.PutGroupRosterV2` 亦要求 `epoch` 与 `roster_rev` **都**严格递增，设计册 §3.8 同口径；按计划让 `remove/rename/leave/dissolve` 出 `epoch = cur` 的草稿，真机 100% 被拒。实际做法：`buildRosterRequest` 去掉 `bumpEpoch`，六个 sub 恒 `epoch = cur+1`、`rosterRev = cur.rosterRev+1`；六个便捷入口统一走 `draftThenRotate`（**先出草稿、再用 `cur` 本地换钥**，顺序反了会双推 epoch）。第二步「换钥并分发」原本无路径：`rotateGroup` 产出的 `envelopes` 在计划里没有任何入体口子（AC 4 / 验收 M3「其余成员未粘任何码却读到新消息」直接断链）⇒ `submitRoster` 增加**可选第 4 参** `envelopes`，非空才往 body 写 `envelopes: [{from_epoch, cipher}]`（键名即节点读路径契约）。节点重建的多签载荷 `rosterApprovalPayload`（`group.go:527-544`）**不含 `envelopes`** ⇒ 信封不进签名域，`base2:` 草稿码形态与回执 `request_hash` 全不受影响。

**更正 30（Task 5）便捷入口的返回类型统一扩为 `{ requestCode, envelopes }`**。计划 API 表只给 `rotateGroup` 带 `envelopes`，但更正 29 落地后 `renameGroup`/`removeMember`/`leaveGroup`/`dissolveGroup` 也都换钥产信 ⇒ 全部返回 `{ requestCode: string; envelopes: GroupEnvelope[] }`（无旧钥可封时为 `[]`）。**Task 6 的多签编排必须把 `envelopes` 一并交给 `submitRoster`**（`multsigSubmit(build)` 的 `build` 返回 `{ request, envelopes }`），否则「不粘码自动获新钥」在真机上不成立。

**更正 31（Task 5）`joinOpenGroup` 必须先匿名读节点**。计划签名 `joinOpenGroup(o, groupId)` 只有本地 `groups` 行可用，而陌生人本地无行 ⇒ 草稿 epoch 只能猜（更新一点的圈子必被 409）。实际做法：先匿名 `getGroupPage(o, groupId, {}, false)`（开放圈匿名可读）取节点当前 `epoch`/`roster_rev`/`member_ids`/`name`，草稿用 `epoch+1`、`rosterRev+1`、名单 ∪ 自己，并把读回的名单**落本地 `groups` 行**（否则这个圈子不会出现在「我的圈子」，M2 看不到）。读失败（404 等）抛 `group_not_found`/`server`，不猜。

**更正 32（Task 5）计划 Step 2 的测试示例不可用**。它引用了不存在的 helper（`encodeInviteV1` / `MEMBER_B` / `stubGroupReadWithEnvelopes` / `envelopeOfEpoch1To2`），断言的文案 `需 2 名签名（移出成员需治理者）` 也与 `submitRoster` 实际格式（`需 N 名签名（label），当前 M 名`）不符。实际做法：按文件内真实体例（`fixture()` / `gateOffline()` / `a.http.routes.set` 打桩）重写，新增 AC 4 / AC 5 / AC 6-7 / AC 13 / `base2-base3` 往返与篡改 / `resolveKeyChain` 断链 / 六 sub epoch+1 / `remove` 提交带信封且旧钥可解 / `joinOpenGroup` 匿名读共 12 组用例（group 17 用例）。更正 21（`action: 'roster'`）已在本 Task 落地。

**更正 33（Task 5 遗留，Task 6 必须处理）低风险档的签名者必须**全是治者**。节点 `rosterQuorumError`（`group.go:614-619`）对 `rename`/`rotate`/`leave` 判 `subsetOf(signers, governors) && countIn(signers, governors) >= 1`，`remove` 要求治者签数 ≥ `RemoveQuorum(k)`。故非治者的「自己退出」**自签必被 403**——计划 Task 6 的 `onLeave` 已给「请把请求码发给治理者」的提示，但 `multsigSubmit` 不能只交自己的回执就当作已提交成功；`rename/rotate` 也要求签名者是治者（UI 已用 `isGovernor` 门控面板）。

**更正 34（Task 5）两处落地细节**。① `GCM_NONCE_BYTES` 在 `core/wire.ts` 里是**未导出**的模块内常量（=12），`group.ts` 不能 import ⇒ 在 `group.ts` 内自定同名常量，不改 `wire.ts`。② 存量设备库要补列：`CREATE TABLE IF NOT EXISTS` 对既有 `groups` 表不补列 ⇒ `repo.ts` 额外导出 `ensureGroupColumns(db)`（`PRAGMA table_info(groups)` 查列名，缺则 `ALTER`），由 `platform/index.ts` 在建表循环之后调用 ⇒ **Task 5 的实际提交范围比计划多一个文件 `apps/mobile/src/platform/index.ts`**。

**更正 35（Task 5，破坏 M4 / M5）门槛镜像必须用「变更前」的名单人数**。节点 `handleGroupRosterV2`（`group.go:456-484`）先读 `cur` 行、用**变更前**名单算 `DeriveSeats` 与 `rosterQuorumError`，`dissolve` 的投票闸门同样（`group.go:639` 注释明写「用**变更前**的名单人数：解散事件本身把名单清空」）。首版实现用**草稿里**的名单（变更后）⇒ `remove` 的 k 少算一档（验收 M4：m=11 移出应提示「需 2 名签名」，实际会提示 1 名并提交 ⇒ 403）、`dissolve` 的 m=0 ⇒ votes=1（M5 实为 2）。实际做法：`submitRoster` 的 `m` 改读本地 `groups` 行的当前名单人数（无本地行才退回草稿长度），`k = governorSeats(m)`。门槛公式两边本就一致（`store/groupseats.go`：`RemoveQuorum=(2k+2)/3`、`DissolveProposerQuorum=min(2,k)`、`DissolveVoteQuorum=m/3+1 上限 30`）。

**更正 36（Task 5）`localRotate` 不再覆盖 `groups.memberIdsJson`**。本地名单代表**已提交**的名单，草稿里的名单是「变更后」的提案，只有在节点确认后（读接口回写）才落本地；否则门槛镜像会拿变更后人数去算（更正 35 的根因），且本地投影会先于节点「假装」改变更已生效。副作用：`remove`/`dissolve` 在提交失败时本地名单保持不变（正确地表达「提案未生效」），成功后被节点读回覆盖。

**更正 37（Task 6）开放圈「自助加入」入口是计划漏写**。验收 M2（陌生人自助加入开放圈）要求 UI 有入口，但 Task 6 正文只写了 `circle.vue` 的建圈选型与形态标记，没有任何入口能调 `joinOpenGroup`（更正 31 已把它做成「先匿名读节点拿当前 epoch/名单再自签提交 join」）。实际做法：`circle.vue` 顶栏加第三个入口「自助加入」，弹窗收「32 位 hex 圈子 ID 或含 `groupId=` 的链接」（`parseGroupId` 只识别这两种形态，路径形态如 `…/group/<id>` 需用户手贴 id），再调 `joinOpenGroup`，`queued` 与非 `queued` 分别提示。

**更正 38（Task 6，真机阻断）多签收集缺少「同伴签名」这半边**。补充 15 的口径是「发起者出 `base2:` 码 → 同伴签名 → 回 `base3:` 回执」，但计划 Task 6 只给了发起者侧（自签 + 「粘贴回执」收别人的回执），**没有任何入口能让同伴对别人的 `base2:` 码签名**（`signSigRequest` 只在自签路径被调用）⇒ 验收 M4（m=11 移出需 2 名治者签）与 M5（解散需 1 发起 + 2 成员签）在真机上**永远凑不够签名**。实际做法：`group.vue` 顶栏补第三个入口「代签请求码」（粘 `base2:` → `signSigRequest` → 复制回出的 `base3:` 回执），闭合收集回路（`912f76f`）。多签往返因此**跨设备可用**：发起者复制 `base2:` 发给同伴，同伴「代签请求码」后把 `base3:` 发回，发起者「粘贴回执」提交；发起者本机的 `pendingRequest` / `pendingEnvelopes` 只在**同机会话内**保留，跨设备时发起者那边的 pending 一直有效（它就是本机产生的），故不阻断。

**更正 39（Task 6）两处实现取舍**。① 计划模板写 `feed.group.*`，但 `group.vue` 既有的 `feed` 是**消息数组**（`v-for="m in feed"`），按「不重构既有逻辑」改为新增 `group = ref<GroupInfo|null>` 承接 `f.group`（语义等价，`isGovernor` / `govText` 从它派生）。② **非治者「退出圈子」按更正 33 落地时仍调 `leaveGroup`**（它内部 `draftThenRotate` 会本地换钥并产出信封）：这是**必需的**——节点要求每个 roster 事件 epoch 递增，而新 epoch 的钥必须随事件 body 的 `envelopes` 分发（更正 29），所以「出草稿」与「产信封」不能拆开；非治者只是**不自签、不提交**，把 `{requestCode, envelopes}` 存成 pending 并复制请求码给治者。副作用：若该提案最终没提交，本机本地 `epoch`/`roster_rev` 会比节点超前（`fetchGroupMessages` 只在「节点 epoch ≥ 本地」时回写，故不会被拉回）；此时发出的消息用的是别人没有的新钥。属知情接受的边角态（M2–M10 不覆盖）。

**更正 40（Task 7 开工前）版本基线口径收口（文档层，零代码改动）。** 本计划原写「当前版本 `0.9.3` / `13`」「建议先把私信 Task 10 收尾再开工本册」**已过期**：私信册 #34 已执行完毕并发布上线（`0.10.0` / `14`，APK 27413300 字节 / sha256 `683cfed841ccbc82a187a95afe34c36bf156081b8a4f6d1319d31aaa3e5fe15e`，落地页与 `/v1/release` 均已改指、线上验签通过）。故基线 = **`0.10.0` / `14`（线上当前版本）**：**Task 7 Step 1 直接由 `0.10.0` / `14` 改指 `0.11.0` / `15`**，无任何前置等待；Phase 2 收 `0.12.0` / `16`。册子 §0.2 第 2 条、总纲 §0.7、`docs/README.md` 第 35 行与 §5 已同步。

**更正 41（Task 7 开工前）`govern.v1` 不新增签名域常量（Task 8 / Task 9 一律以本条为准）。** 册子 §4.2 / §4.4 原写「签名域新增常量 `base/govern-v1`（与 `base/author-v1` 同族）并产出契约向量」，与同段「复用既有 `verifyEventSig` 管线」**自相矛盾**——`verifyEventSig`（`internal/httpapi/event.go`）签的是 `canonical({event_id, type, created_at, body})`，**没有域分隔**。定案：**`govern.v1` 沿用通用事件内容签名，不新增 `base/govern-v1` 常量、不出新契约向量**（理由：`type` 已在待签载荷内 ⇒ 改 `type` 即改待签字节，跨事件类型重放不可行；新增域要并行维护第二条验签路径与一套新向量，与「密码学零新增面」相悖）。落地要求：**Task 8 节点侧照计划原样复用 `s.verifyEventSig(w, actor, req, rawBody)`，零改动**；**Task 9 客户端按「补充 20」自签 `canonical({event_id, type: 'govern.v1', created_at, body})`，与 `core/group.ts` 的 `buildEventWire` 逐字同构**。册子 §0.2 第 3 条 / §4.2 / §4.4、总纲 §0.7 与 §6.5 段 / §7.3 接口表、`docs/README.md` 第 33 行已同步。

**更正 42（Task 7 执行期）三处实测偏差 + 一处待人工。**
① **Step 4.1 云打包卡在 DCloud 免费队列，Step 4 整体未完成（唯一待人工项）**。`D:\HBuilderX\cli.exe pack --project e:\code\base\apps\mobile --platform android --android.packagename uni.app.UNI936A667 --android.androidpacktype 3` 能成功提交云端并进入编译（HBuilderX 5.26 在线，**证实更正 11 的「CLI 不再必崩」结论仍成立**），但 `00:08:32` 起排队、`00:17:47` 仍显示「队列中，第 80 位，预计 20 分钟内进入打包状态」⇒ 10 分钟预算内无 APK 产出，已终止。**故 `/opt/appdl/base-0.11.0.apk` 未上传、落地页未改指、`/v1/release` 仍为 `0.10.0` 文档**（远端实测 `/v1/release` → 200 但内容仍是 0.10.0）。**后续口径**：`cli pack` 的失败形态不止「报错」，还有「排队超时」；凡遇排队位次 > 0 且预计 > 10 分钟，直接转人工云打包，不要在会话里空等（Step 4.2–4.4 依赖 APK 产物，一并挂起）。
② **Step 3 原探活判据不能区分新旧二进制**。计划写「`/v1/group/{32hex}` 必须返回 `{"code":"group_not_found"}`，否则说明二进制还是旧的」——但该错误码**在 0.9.3/0.10.0 的二进制里就已存在**（#31 部署探活用的就是它），故本条对「换没换二进制」**零区分度**。实际做法：把判据补成「**远端 `sha256sum /opt/base/based` 与本地交叉编译产物 sha256 逐字一致**」+「`systemctl is-active base base-cache` 均 active」，再跑计划那四条探活作为**未回归**校验（本次 `/v1/group` 404 + code、`/v1/comment` 200、`/v1/dm` 200 全符合）。**后续口径**：凡「同码不同版本」的变更，探活必须含「产物哈希比对」，不能只靠错误码。
③ **发布前 `.value` 硬检查的命令在 PowerShell 5.1 下有坑（假阳性）**。计划原文 `git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- 'apps/mobile/src/pages/*/*.vue'` 在 PowerShell 里**参数内的双引号会被剥掉**，正则实际退化成 `=[^]*\.value|…`，把脚本侧 `myId.value` 之类**误报**（0.9.3 起保留的这条硬检查会被污染成「天天红」）。实际做法：改用 `git grep -nE -f <模式文件>` 或 ripgrep 精确匹配（本次两种方式均为 No matches）。**后续口径**：此检查的模式串一律从文件读入，不写在命令行引号里；同理「ssh 远程命令用单引号包裹」这条老口径继续有效。
④ **用例数基线随并行线漂移**：本 Task 门禁实测 **18 文件 / 176 用例**，而非 Phase 1 Task 1–6 的 169——差量来自并行 #36 课程分类线的 `apps/mobile/src/core/course-tree.test.ts`（+7，已随 `6e4cc37` 进 HEAD）。旧数字不再作为基线，Phase 2 以**当次实测**为准。

**更正 43（Task 8 执行期）计划内部矛盾三处 + 实现取舍两处。**
① **Step 1 的加列清单不完整**。Step 1 只让 `govern_proposals` 加 `source_event_id`，但 Step 5 的投影 INSERT 与 Step 7 的读取（`p.ContentVersion` / `p.RevokedRev`）都要求该行带 `content_version` / `revoked_rev`（这两键是 `govern.v1` 提案体的既定字段，见 Step 5 的键集与 `jsonInt` 解析）。实际做法：**三列一起加**（`source_event_id TEXT` + `content_version INTEGER NOT NULL DEFAULT 0` + `revoked_rev INTEGER NOT NULL DEFAULT 0`），`governColumnMigrations` 同步三条幂等 ALTER，仍**不 bump `schema_version`**。（`govern_votes` 只加 `source_event_id`，与 Step 1 一致。）
② **`filterRosterAtWatermark` 的签名必须保留传入名册**。Step 7 写 `filterRosterAtWatermark(voters, p.ContentVersion, p.RevokedRev)`——隐含「丢掉传入 roster，只按水位重放」。但既有的 `TestListProposalViewsFiltersVotesByRoster`（**不在 Task 8 的 8 个文件内、不可改**）要求按传入 roster 过滤，且 §6.2 的「名册派生失败按空名册降级」依赖它。实际做法：实现为 `filterRosterAtWatermark(ids, roster, revokedRev)` = **传入名册 ∪「水位之后才退役、且当前仍达质量门槛」的作者**，两条旧用例与 AC 12 同时满足。**`content_version` 只记录、不参与 gate**：`items` 无 per-item 版本列，可实施的杠杆只有 `revoked_rev`（代码注释已标明）。**后续口径**：写「按两个水位过滤」这类步骤前先确认两个水位都真的可 gate，不可 gate 的要写明「仅记录」，否则实现者会写出永远为真的判定。
③ **投影的覆盖语义按册子 §4.3，不按 Step 5 的字面**。Step 5 写「已有投影一律不覆盖」，册子 §4.3 要求按 `(created_at, event_id)` 收敛。实际做法：同 `proposal_id` 取 `(created_at, event_id)` **字典序首个**（更早则 UPDATE 替换），**本地路径写入的行（`source_event_id` 为 NULL）永不覆盖**——它代表本机已执行的动作，事件无权改写；同 `event_id` 重放返回 nil（幂等，不算冲突）。票按 `(proposal_id, voter)` 取**事件 `created_at` 最早**（不能只靠 `PRIMARY KEY + DO NOTHING`，先到的可能是较晚的事件）。
④ **名册重放的候选富集逻辑在 `govern.go` 内自建**。`restoredRosterAuthors` 需要「含退役条目的候选集」，既有 `ContributorRoster` 的取数在 `contributor.go`（**不在 Task 8 的 8 个文件内**）。实际做法：只复制**取数**部分（`deriveRoster` / `meetsQualityGate` 仍是共享函数，口径未分叉），并把候选查询限定为「有 tombstone 且 `revoked_rev > 水位`」的条目。**已知边角**：加回集合与实时名册取并集后未再截断 top-10，退役后加回作者 >10 的极端场景与「全量重放」严格口径存在细微差异，**无测试覆盖、属知情接受**。
⑤ **TDD 的红灯形态是编译失败**。计划 Step 2/3 期望「先跑出 `event_type_unknown`」这类行为级失败，但测试文件同时引用了 Step 5/6 才引入的 `store.GovernProposalEvent` / `ProjectGovernProposal` / `ErrGovernEventConflict` / `ProjectGovernVote`，**Go 编译先于路由断言失败**。这不是问题（红灯依然真实），但**后续写 TDD 步骤时不要用「必须先看到某个 HTTP 错误码」当判据**，否则实施者会误以为要拆成两段提交。
⑥ **peersync 侧未加包内单测**（Step 8 只给实现、未给用例；且 `peersync → httpapi` 有包环，`httpapi` 测试不能 import `peersync`）。AC 11 的跨节点验收在 `httpapi` 内以**等价落库 + 投影**（`drainGovernFromPeer`）复刻；真实 `applySyncedGovernEvent` 路径已编译通过并纳入 `go test ./...` 覆盖范围，但**未单独断言**。属知情接受的覆盖缺口。

**更正 44（Task 9 开工前）版本定序二次让位 + `0.11.0` 不单独发布（用户 2026-09-30 定案）。**
① **撞号事实**：并行 #36（课程分类）会话已把 `apps/mobile/src/manifest.json` 升到 **`0.12.0` / `16`** 并提交（`ff62779`，仅改版本号 + 册子回填 + `docs/README.md` 一行），与本计划 Task 9 原定的 `0.12.0` / `16` **正面相撞**。按更正 40 的判据「**谁已经在跑谁赢**」（#36 已落版本号且正在发布线上），**Phase 2（Task 9）改指 `0.13.0` / `17`**；#36 的 `0.12.0` / `16` **不动**（本线不改、不回退、不代为发布）。
② **Task 7 Step 4 的 `0.11.0` 发布整条作废**。定案：`0.11.0` / `15` 只作为「Phase 1 版本号 + 节点二进制部署」的留痕（这部分已全部完成），**不单独打包发布**——客户端圈子自治改动（双形态 / 治者面板 / 多签 / 信封链）**随 Phase 2 的发布一次性触达用户**。理由有二：(a) Task 7 的云打包受 DCloud 免费队列阻塞（更正 42 ①），CLI 已无法在会话内完成；(b) 当前源码版本号已被 #36 升到 `0.12.0`，从工作区源码**已不可能产出 `0.11.0` 包**（要单独发只能按 `63e8ddc` 检出/复制工作区，成本与风险都不划算）。代价：Phase 1 的客户端改动会与 Phase 2 + #36 的同批上线，**「Phase 1 单独可回滚」这条退路消失**——知情接受（节点侧二进制已先行部署且探活通过，服务端不存在混合态）。
③ **落地要求（Task 9 一律以本条为准）**：Task 9 Step 4 版本号写 **`0.13.0` / `17`**；Step 5 的发布四步全按 `0.13.0` 执行（`cli pack` → 上传 `/opt/appdl/base-0.13.0.apk` → 落地页整页重写改指 → `based release -version-name 0.13.0 -min-version-name 0.8.0 -out /opt/base-cache/data/release.json`）；Step 6 的 `docs/README.md` 回填写「Phase 1 + Phase 2 均已执行，随 `0.13.0` 发布」。若云打包再次被队列阻塞，**按更正 42 ① 的口径直接转人工，不在会话内空等**。

**更正 45（Task 9 执行期 + 主代理审查）六处偏差、三处缺口。**

① **计划 Step 1 的 body 键集与节点契约正面冲突（最要紧的一条）**。计划写 `{proposal_id, action, item_id, reason}` + `edit:{title, body_md}`，但 Task 8 已按册子 §4.2 实现的 `parseGovernBody` 要求**严格键集**：提案 `{action:'proposal', proposal_id, target_item_id, verb, content_hash, content_version, revoked_rev, reason?, title?, body_md?}`、投票 `{action:'vote', proposal_id, choice}`，多一个未知键即 `event_param_invalid`(400)。实际做法：客户端按**节点契约**组装（`verb` 承载动作、`item_id` → `target_item_id`、`edit` 块摊平成 `title`/`body_md`），并补计划漏掉的一步——**先取本地 `repo.getItem(itemId).contentHash`**（事件体必须自带 `content_hash`，本地缺则原地拒 `client`，不投递）。

② **`createProposal` 的撞号处理从「人工重试」升级为自动**。计划只写「撞号由节点兜底，人工重试即重取」；实际按 200 体的 `conflict:true` 做 **≤3 次**「重拉列表 → 取最大 id+1 → 重投」，耗尽才报「提案编号冲突，请重试」。另：册子 §6 列的 `govern_event_conflict` 在实现里**不是错误码**，而是 **200 + `{"conflict":true}`**（该行只作「查询口径冲突告知」，节点不拒事件——任务报告曾把这条当作偏差登记，实与 Task 8 实现一致）。

③ **计划 Step 3 模板引用的 `statusText()` 不存在**。页面上只有 `STATUS_LABEL` 常量映射；实际改用 `STATUS_LABEL[p.status]`。同时给水位行补 `v-if="p.contentVersion > 0 || p.revokedRev > 0"`（避免服务端未回水位时展示「水位 v0 / rev0」）。

④ **计划 Step 6 要求的 #9 / #27 册子加注未做**。Step 6 让「若册子 §10 要求的加注尚未做，在本 Task 一并补上」，但本 Task 的范围（Task 9 开头 Files 清单）**只含 4 个文件**、且全程口径是「不改其它册子」⇒ 两处加注**留空**（#9 册子 §4.3 的「不做成员准入读控制」加注、#27 册子 §0 的「票实时复判被快照水位取代」加注）。Step 7 的 `git add` 清单也含这两个册子文件，实际未改、未 add。

⑤ **云打包本次反而成功**。更正 42 ① 记录 Task 7 被 DCloud 免费队列阻塞（第 80 位）；本 Task 重试一次即通过（云端 02:04:17 完成）。故 ① 的「转人工」口径**本次未触发**，发布四步全部在会话内跑完。

⑥ **`.value` 硬检查口径沿用更正 42 ③**。PowerShell 5.1 下参数内双引号会被剥掉造成假阳性；本次用「模式文件 + `git grep -f`」跑，无匹配。

**⑦ 审查发现的缺口一：`govern.v1` 投票事件不触发生效（功能性，未修）**。`ProjectGovernVote` 只往 `govern_votes` 插/更好一行；而 `ProposalStatus` 完全由 `govern_proposals.executed_at` / `voided_at` 派生（`internal/store/govern.go`），事件路径**从不写这两列**⇒ 新客户端（唯一走事件路径的客户端）把票投满门槛后，结论**永远停在 `pending`**，`RetireItem` / `editItemTx` 也不会被执行（受审动作实际未发生）。**这是计划级遗漏，不是 Task 8 执行偏差**：Task 8 Step 5 的投影代码本身只写票；AC 11 的断言未含 `status`（且用例是 `remove`/门槛 3、只投 2 票，恒 `pending`）；AC 12 的用例走的是**老路径** `n.propose` / `n.vote`（老路径由 `addVoteTx` 写 `executed_at`），故 4 条测试全绿也照不出这个洞。修法方向：投影投票后在**同一事务**里复算有效票并对达门槛的提案执行受审动作（复用 `governPreconditionTx` / `governApplyTx`），或把 `status` 改为读时派生 + 落地动作。**待定案**。

**⑧ 审查发现的缺口二：客户端水位 / 冲突字段无服务端来源（未修）**。`proposalDTO`（`internal/httpapi/govern.go`）只回 `proposal_id/action/item_id/proposer_id/reason/title/body_md/status/votes/vote_count/threshold/created_at/executed_at/voided_at`，**不含** `content_version` / `revoked_rev` / `conflict_note` ⇒ `core/govern.ts` 新增的三个字段现值恒为 `0`/`0`/`''`，`governance.vue` 的水位行（因 ③ 的 `v-if`）与冲突提示行**当前都不会显示**——属**前向兼容预留**，不是坏掉的代码，但也没带来任何可见效果。修法方向：DTO 补三字段（`conflict_note` 由节点按 §4.3 收敛结果生成）。**待定案**。

**⑨ 审查发现的冗余三（未修）**：`governance.vue` 新增的水位行把卡片上**已有**的「门槛 N 票」与状态文案又写了一遍（同卡片已有 `#id · STATUS_LABEL · 时间` 与 `voteCount / threshold 票` 两行）。若按 ⑧ 让水位行真正可见，应同时删去重复的门槛 / 状态片段。

**验尸（本机门禁的伪信号，供后续 Task 参考）**：`gofmt -l .` 在**本机 Windows 工作区无区分度**——`git config core.autocrlf=true` 使全部 `.go` 工作区副本为 CRLF，`gofmt -l .` 会把**未改动**的文件（实测 `internal/protocol/sign.go` 等 9 个 protocol 包文件）一并列出，`gofmt -d` 显示差异纯为行尾。故该命令只能对「本次新增且为 LF 的文件」（如 `internal/store/govern_projection.go`）判定；对存量文件的判定须忽略其输出。

**更正 46（补丁 Task 10 执行期 + 主代理审查）九条。**

① **为什么新增 `SettleGovernProposal` 而不是改 `ProjectGovernVote` 签名**。生效判定需要「当前名册 ∪ 水位加回集合」，而 `filterRosterAtWatermark`（`internal/store/govern.go`）→ `restoredRosterAuthors` → `s.ListArticles` / `s.ListQuizzes` / `s.ListMediaDurations` **全是 `s.db` 方法**；本库纯 Go SQLite + `SetMaxOpenConns(1)`，**在事务里调用它们必然死锁**。故两步走：**事务外**派生名册与加回集合、复算有效票（未达门槛直接返回）；**事务内**第一件事就是乐观锁重读提案行 + `governPreconditionTx` + `governApplyTx`。事务内只调用已知的 exec 版本函数。为免口径漂移，把 `filterRosterAtWatermark` 的循环抽成纯函数 `filterRosterAtWatermarkSet(ids, roster, restored)`，由 `ListProposalViews` 与 `SettleGovernProposal` 共用——**因此本 Task 多动了一个文件 `internal/store/govern.go`**（8 行，行为不变）。

② **proposal 与 vote 两条分支都要 settle**。反熵不保证 `proposal` 事件先于 `vote` 事件到达（`vote` 先到时提案行尚未投影，settle 直接 `return nil`）。故 `internal/httpapi/govern_event.go` 与 `internal/peersync/eventsync.go` 都在 `switch` 之后统一 settle：proposal 事件负责「补算已有票」、vote 事件负责「补算新票」。`peersync` 侧 settle 失败只 `log.Printf` 并**仍返回 `(true, nil)`**——否则会冒泡到 `pullEvents` 让整页反熵失败（事件行才是权威来源）。

③ **既有两条用例的改造是本次修复的一部分**。AC 11（`TestGovernEventConvergesViaAntiEntropy`）**补了 `status` 断言**——原断言只比 `vote_count` / `item_id`，正是它当年照不出缺陷 1 的原因之一（本用例 2 票 < `remove` 门槛 3，故断言应为 `pending`）。AC 12（`TestGovernEventVoteQuorumSnapshotWatermark`）**从老路径 `n.propose` / `n.vote` 改为走事件路径**——原版走老路径（老路径由 `addVoteTx` 写 `executed_at`），所以它验的是老路径的生效，与事件路径无关。`drainGovernFromPeer` 这个「peersync 的测试镜像」（httpapi 不能 import peersync 成环）也补了 settle，否则镜像失真、AC 11 验不到闭环。

④ **`conflict_note` 决定「删」而不是「补」**。册子 §6 对 `govern_event_conflict` 的要求原文是「按 §4.3 收敛，**界面展示被选中的那一条**」——读接口天然只返回被选中的那条，**不需要**额外字段；且客户端 `createProposal` 已做 ≤3 次撞号自动重取重发，冲突在写路径就被消化。故只删客户端字段 + 页面提示行，**不**给 `proposalDTO` 加 `conflict_note`。`content_version` / `revoked_rev` 则确实补上了（`ProposalView` 内嵌 `Proposal`，两字段已随行透传）。

⑤ **「sha256 逐字一致」判据的适用边界（对更正 42 ② 的重要修正）**。本次实测：同一份源码、同一工作区改动，**子代理产物** sha256 `ea1aca50…7902`（`go version -m` 读得 `vcs.revision=55b56b0619c9`、`vcs.time=2026-09-29T18:23:26Z`），**主代理事后重建** sha256 `6c744396…c468`（`vcs.revision=ed0b2221…`）——**两者不同**；而同一时刻连做两次重建，两者**sha256 完全一致**。⇒ 差异来源是 Go 的 vcs stamping（build info 里的 `vcs.revision` / `vcs.time`）随 HEAD / 时间变化，**与源码无关**。故：`sha256 逐字一致` 只在「构建与比对之间 HEAD 与工作区状态不变」时成立；**跨时刻复核必须改用**（a）与**本地留存的构建产物**比 sha256（本次即用此法闭合证据链：远端 = `%TEMP%\based-0.13.1-linux-amd64`），或（b）`go version -m <binary>` 读 vcs stamp。

⑥ **公网入口事实更正**。`/v1/release` 由 **nginx `:80` → `127.0.0.1:8083`（`base-cache` 节点）** 承载，**不是** `base.service` 的 `:443`（其 data 目录 `/opt/base/data` 下**无** `release.json`，直连 `https://127.0.0.1/v1/release` 返回 404「本节点无升级信息」）。签发路径 `/opt/base-cache/data/release.json` 正确。（更正 43 / 本轮 prompt 里「公网 443 由 `base.service` 提供」的表述作废。）

⑦ **已知未修：settle 与 `PutEvent` 的先后顺序两处不一致**。`handleGovernEvent` 是「settle → PutEvent」（settle 在权威事件行落地**之前**），`peersync.applySyncedGovernEvent` 是「PutEvent → settle」（正确顺序）。风险低——`PutEvent` 对同 `event_id` 是幂等覆盖，失败只可能是磁盘/DB 错；且即便 `PutEvent` 失败，`governPreconditionTx` 的 `content_hash` 乐观锁也能兜住后续重投（目标内容已变 ⇒ 新提案记 `voided_at`），不会产生错误结论。若要统一，把 settle 移到 `PutEvent` 之后即可（1 行）。**未修**。

⑧ **每遇一条 `govern.v1` 事件派生一次名册**（`peersync` 侧调 `ContributorRoster()`，会扫 items + articles + quizzes + videos）。治理事件量级小（只对 `case "proposal"` / `case "vote"` 触发，评论 / 圈子事件不受影响），当前可接受；若治理放量，可提到「每页一次」。

⑨ **文档行号口径**：`docs/README.md` 的「第 33 行」（表格 `#` 列 = 33 的册子行）**物理行号是第 59 行**——后续引用请按「表格 `#` 列」而非物理行号（本轮 prompt 里写「第 33 行」按物理行号读会改错行）。