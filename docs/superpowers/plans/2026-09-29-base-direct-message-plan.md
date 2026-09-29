# 私信（② 加密）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**：把 #32 册子落地为——节点侧两件（`dm.v1` 事件类型注册与密文落块、匿名读 `GET /v1/dm/{peer_id}`）加一处反熵接收侧接线；手机端 `core/dm.ts`（好友码编解码与离线自验、建好友/收码、会话列表、发言、双 `target_id` 合并解密）与两页（`pages/dm/list.vue` / `pages/dm/chat.vue`），本地只新增一张表 `dm_keys`；离线发言**原样复用** `comment_out` 队列与既有补发编排。

**Architecture**：私信只有一个语义（密文发言），body 恒为两个键 `{to, text_cipher}`（无 `action`、无 `reply_to`），节点从不解密、不建明文派生索引、**零新表零新列**；会话密钥靠**带外好友码**递送（Ed25519 签名 + 对称 AEAD，无任何非对称加密、无密钥轮换），寻址为 `target_id = dm/<收件人 id>`，收件箱即 `GET /v1/dm/<我 id>`。手机端纯逻辑落 `apps/mobile/src/core/dm.ts`（不 import `uni`/`plus`，配 vitest），页面只做渲染与跳转；密码学零新代码，wire 与密文原语与小组共用抽出的 `core/wire.ts`。

**Tech Stack**：Go 1.25 + 纯 Go SQLite（`modernc.org/sqlite`，无 CGO）；TypeScript + Vue 3 + uni-app；`@base/protocol-ts`（`canonicalize` / `blobId` / `sign` / `verify` / `deriveIdentityId` / `isIdentityId` / `sealWithNonce` / `openWithNonce` / `randomBytes` / `bytesToHex` / `hexToBytes` / `utf8`）；测试 `go test` + vitest。

**上游 spec**：`docs/superpowers/specs/2026-09-29-base-direct-message-design.md`（**唯一契约来源**）。与册子冲突时以册子为准；要改口径先改册子（走 `## 0. 改版说明`），并在本计划追加「执行期更正」。

**基线**：`e:\code\base` HEAD = `7ca56e9`；工作区仅 `.gitignore` 未提交（**属其它任务，本计划一律不碰**）。移动端实测 `npx vitest run`（cwd `apps/mobile`）= **17 文件 / 149 项全绿**。`apps/mobile/src/manifest.json` = `0.9.3` / `13`（本册发 **0.10.0 / 14**）。

---

## 已核实的环境事实（勿再验证）

### 册子 §2 的八处缺口（复核一致）

| # | 事实 | 位置 |
|---|---|---|
| 1 | `eventTypeRegistry` 只有 `comment.v1`、`group.v1` | `internal/httpapi/event.go:25-28` |
| 2 | `GET /v1/identity/{id}` 已存在，取对方公钥无需新接口 | `internal/httpapi/server.go:113` |
| 3 | 既有密码学只有对称 AEAD + Ed25519，无非对称加密 | `packages/protocol-ts/src/index.ts` 的导出面 |
| 4 | `buildGroupWire` / `submitWire` 是 `group.ts` 模块私有 | `apps/mobile/src/core/group.ts:252`、`:264` |
| 5 | `comment_out(event_id,target_id,text,reply_to,wire,state,reason,queued_at)` 完全通用 | `apps/mobile/src/core/repo.ts:105-108` |
| 6 | `ListGroupEvents` 与私信读只差 `type` 与 `target_id` | `internal/store/group.go:96-123` |
| 7 | `handleEventSync` 不按 type 过滤；反熵只比对 `blob_id` | `internal/peersync/eventsync.go:89-103` |
| 8 | `isHexN(s,n)` 第二参是**字节数**（实现 `len(s) == n*2`） | `internal/httpapi/identity.go:48`；私信 `peer_id` 用 `isHexN(id,16)` 即 32 hex |

### 开工前新发现的两处缺陷级缺口（册子未列，本计划必须补，见「补充 1」）

`#9 → #31` 复盘里的 F5 / F6 在私信上**同族复现**：册子 §4.3 的「接收侧投影还原零改动」说的是**投影表**层面（私信确实没有 `groups` 那样的表，这一点无异议），但反熵**接收侧**还有两件既有机制必须各加一个 `dm.v1` 分支，否则私信事件「搬得过去、读不出来、块也拉不下来」，AC 4 不成立：

| # | 事实 | 位置 | 后果 |
|---|---|---|---|
| F5′ | `parseEventProjection` 只有 `comment.v1` / `group.v1` 分支，其余类型返回零值 | `internal/peersync/eventsync.go:196-223`（调用点 `:90-96`） | 私信事件搬到对端后 `target_id` / `payload_cid` 为空 → 缓存节点 `GET /v1/dm/{peer_id}` 查不到该条 |
| F6′ | 块归属索引只认 `comment.v1` / `group.v1` | `internal/store/comment.go:66-89`（`EventBlobIndex`，被 `peersync/sync.go:40` 经 `ownershipIndex` 使用） | 私信密文块在缓存节点**无归属** → 反熵拉不下来、scrub 还会当孤儿删掉（AC 4 取不到密文） |

### 其它必须知道的事实

| 事实 | 值 |
|---|---|
| 本机 shell | Windows PowerShell 5.1，**不支持 `&&`、不支持 heredoc**；多命令用 `;` 分行；commit message 可 `-m` 单行（本计划给的都是一行消息，无需临时文件） |
| 中文读取 | 必须 `[System.IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)`；`Select-String` 直接读文件会乱码（本计划只用它扫 `.vue` 的 ASCII 模式，不读内容） |
| 单连接 | `internal/store/store.go` 有 `SetMaxOpenConns(1)`：新写的 store 方法必须「读完即 Close 再发下一条语句」（照 `ListGroupEvents` 的写法） |
| `Event` 结构 | `internal/store/event.go:11-21`；`PutEvent`（`:25`，同 `event_id` 覆盖、`received_at` 保留首次值）；`eventColumns`（`:39`）；`scanEvent`（`:41`） |
| 验签管线 | `internal/httpapi/event.go:96-156`：严格键集校验 body → `Canonicalize({event_id,type,created_at,body})` → `LookupIdentity(actor)` → `protocol.Verify` → 落块；**新类型照抄这段，不要另写验签** |
| 错误响应形状 | `writeAuthErr` → `{"error":…,"code":…}`；`writeError` → `{"error":…}`（**无 `code`**）。客户端只读 `code`；因此凡是客户端要分流的错误一律 `writeAuthErr` |
| 分页口径 | `parseCommentCursor`（`internal/httpapi/comment.go:72-85`）：不透明游标 `<created_at>_<event_id>`，非法值按首页处理；满页才给 `next_cursor` |
| 身份 id | 32 hex；`isIdentityId` 在 `packages/protocol-ts/src/identity.ts:23` |
| 手机端建表机制 | `core/repo.ts:87-124` 的 `SCHEMA_SQL` 由 `platform/index.ts` 的 `bootstrap()` 逐条 `execute`，`CREATE TABLE IF NOT EXISTS` 幂等，**无版本号** → 新表只追加，不写迁移 |
| 密文形态 | 密钥列级密文 `nonceHex:ctHex`（`core/identity.ts:96` 原文 `${bytesToHex(nonce)}:${bytesToHex(ct)}`）；正文密文 `base64url(nonce12‖GCM 密文与 tag)`（`core/group.ts:111-126`） |
| 离线队列真相 | `wire` 存**整个已签名请求体**；`core/comment.ts:296-326` 的 `runFlush` 逐条按 `wire` 重放，节点按 `type` 分流 ⇒ 私信发言**零改动复用**；`submitWire` 只在 `CommentError('network')` 时入队（`core/group.ts:264-287`） |
| 补发入口可跨模块用 | `core/comment.ts:282` 的 `flushPending(o)` 只依赖 `{adapters, repo, nodeBaseUrl}`，私信页可直接 import 调用 |
| 写能力门控 | `core/selfcheck.ts` 导出 `canPostComment` / `postBlockedReason` / `UNKNOWN_FLAGS` / `CapabilityFlags`（`pages/group/group.vue:77-82` 的用法） |
| **模板禁写 `.value`** | `pages/group/group.vue` 已用计算属性 `canInput` 规避（#31「更正 13/14」）：**模板里对 ref 手写 `.value` 会让 app 端整页渲染中断**。本册两个新页一律「脚本里 `.value`、模板里只写计算属性名」 |
| 页面传参约定 | 全仓页面读 camelCase query（`query.itemId` / `query.groupId`）→ 本册新页统一 `query.peerId` |
| Go 测试基座 | `internal/httpapi/httpapi_test.go:64` 的 `newTestServer(t)`；`comment_test.go:75` 的 `eventIDOf`、`:105` 的 `doJSONMap(t, method, url, body, headers)`；`group_test.go:21-35` 的 `newGroupNode` / `registerIdentitySeed`；`authmw_test.go:89` 的 `signedRequest`、`:100` 的 `sendAuth`；`store/store_test.go:9` 的 `openTemp(t)` |
| 反熵测试基座 | `internal/peersync/eventsync_test.go:129` 的 `TestGroupEventProjectionRestoredOnPeer`（`newSourceNode` / `Config{TransportFor: tr, IssuerPubKeys: …}` / `SyncEvents`）——本册第 5 个 Task 照它写 dm 版 |
| 既有 `EventBlobIndex` 引用点 | 只有 `internal/peersync/sync.go:40`（间接被 `scrub.go` 的 `ownershipIndex` 使用）与 `peersync/eventsync_test.go:196`；无「精确 map 内容」断言 → 扩充 SQL 不破坏既有测试 |
| 当前版本 | `apps/mobile/src/manifest.json` = `versionName "0.9.3"` / `versionCode "13"` → 本册发 **0.10.0 / 14** |
| 节点侧必须部署 | 本册改了节点代码（新路由 + 新事件类型 + 反熵接线）。按「更正 3」的后续口径：发布清单必须含交叉编译 + 两节点各备份替换 + 依次 restart + 逐个探活 |
| **私信读接口无 404** | 探活期望是 `200 {"events":[],"next_cursor":null}`（**不要**照抄 #31 的 `404 group_not_found`），非 32 hex 才是 400 |

---

## 对册子的补充与口径填空（已登记，实施时照此执行）

册子未写、但实施必需。1–2 是**缺陷级补充**（不做则 AC 4 不成立），3–11 是口径填空（零契约影响）。全部不触碰任何线上接口形状。

1. **反熵接收侧两处接线（对应 F5′ / F6′）**：`peersync.parseEventProjection` 加 `dm.v1` 分支，从减化 body `{to, payload_cid}` 还原 `target_id = "dm/" + to` 与 `payload_cid`；`store.EventBlobIndex` 的 SQL 放宽到 `type IN ('comment.v1','group.v1','dm.v1')` 并把归属前缀扩为 `comment:` / `group:` / `dm:`。**不改事件传播协议、不改线上契约**，与 #31 的 F5/F6 同一性质。
2. **`core/wire.ts` 的导出面不止 `buildEventWire`/`submitWire`**：册子 §5.2 只点了这两个名字，但 `dm.ts` 还需要 `group.ts` 里同一套原语——base64url 编解码、`sealText`/`openText`、`sealKeyCipher`/`openKeyCipher`。册子自己的 §2.4 说抽公共件的理由就是「否则出现第二份复制粘贴」，故这 5 个原语**一并收编进 `wire.ts`**（`sealGroupKey`/`openGroupKey` 随语义改名 `sealKeyCipher`/`openKeyCipher`），`group.ts` 改 import。**纯抽取 + 纯改名，行为零变化**（由既有 `group.test.ts` 覆盖）。
3. **不收编 `comment.ts` 的 `buildCommentWire`（开工时确认的结论）**：它确实与 `buildEventWire` 同构（都是「`event_id` + payload + 内容签名 + `JSON.stringify`」四步），但 `submitWire` 必须引 `core/comment.ts` 的 `sendComment`，收编会让 `comment.ts` 反向 import `wire.ts`，形成 **`comment ↔ wire` 模块环**；本册对已上线代码的硬约束是「纯抽取、行为零变化」，故 `comment.ts` **一行不动**。复核方式见 Task 5 Step 5。若要后续收编，须先把 `sendComment` 下沉到更底层的模块（另立册子）。
4. **抽公共件带来两处**错误文案**变化**：`openKeyCipher` 的 `'group: 组密钥密文格式损坏'` → `'密钥密文格式损坏'`，`openText` 的 `'group: 密文过短'` → `'密文过短'`（原本带 `group:` 前缀）。这两个文案**无任何测试断言**，且只在「库中密文损坏」这一异常路径出现；`group.ts` 的调用点对两者的处理不变（解不开即降级提示）。
5. **`decodeFriendCode(code, myId)` 比 `decodeInvite(code)` 多一个参数**：册子 §3.2 的「定向」一步要求校验 `peer_id === 本机身份 id`，故必须把本机 id 传进来（册子 §5.2 只列了函数名，未定签名）。`myId === ''`（本机无身份）时一律按 `friend_code_invalid` 拒绝。
6. **`listFriends` 返回 `{peerId, hasKey}[]`**：并集的两部分来源不同——本地 `dm_keys` 的行（`hasKey: true`）与 `GET /v1/dm/<我 id>` 的 `actor` 集合（`hasKey: false`）。**拉收件箱失败（断网 / 未配置节点 / 无本机身份）时静默回落为「仅本地好友」**：不让一次读失败把整页变空（与「禁止静默跳过解密」是两件事——那是内容层，这是索引层）。`dm_keys` 表没有昵称列，故列表项只显示 id 前 8 位。
7. **`postDM` 的三条前置校验都在入队前**（不产生事件、不入队）：`peerId` 非 32 hex → `client`；明文为空 / 超 4096 字节（UTF-8）→ `client` / `too_long`；本地无该 peer 密钥 → `not_friend`。册子 §3.3 只写了「4096 字节由客户端在入队前拦」，另外两条是同一条路径的必然前置。
8. **会话页不做翻页**（册子 §8「明确不做」未列翻页，但会话页要求只有消息流 / 发送 / 待发区）：`DmConversation.nextCursor` 非空时**原位提示**「更早的消息本版暂不支持翻页」，不静默显示「没有更多了」——与 #31「更正 9」同口径。
9. **`isHexN` 两侧语义不同**：节点侧第二参是**字节数**（`len(s) == n*2`）；客户端 `group.ts` / `dm.ts` 的私有 `isHexN` 第二参是**hex 字符数**。故「32 hex 的身份 id」在节点写 `isHexN(id, 16)`、在客户端写 `isHexN(s, 32)` 或直接用 `isIdentityId(s)`——**不要互相照抄**（#31「更正 1 / 10」踩过两次）。
10. **会话页展示口径**：每条消息「未解密时不显示任何载荷」，只显示 `DM_KEY_MISSING_NOTICE`（本地无该 peer 密钥）或 `DM_DECRYPT_FAILED_NOTICE`（密钥在但认证失败）；**密文原文永不进界面**（册子 §5.3、红线 4）。
11. **`docs/README.md` 第 32 行（本册）与第 33 行（治理体系重规划）的登记**由主人随册子落盘完成；Task 10 只做**状态回填**，不新增行、不碰 #33 的任何文件。

---

## 文件结构（File Structure）

| 路径 | 动作 | 职责 |
|---|---|---|
| `internal/store/dm.go` | 新建 | `ListDMEvents(peerID, cursorTS, cursorID, limit)`——与 `ListGroupEvents` 同构的十二行 |
| `internal/store/dm_test.go` | 新建 | 收件人过滤 + 倒序 + 游标分页 + 不串类型 |
| `internal/store/comment.go` | 修改 | `EventBlobIndex` 的 SQL 与归属前缀纳入 `dm.v1`（补充 1 / F6′） |
| `internal/httpapi/dm.go` | 新建 | 常量组、`parseDMBody`、`handleDMEvent`、`handleDMGet`、DTO |
| `internal/httpapi/dm_test.go` | 新建 | AC 3（不落明文）/ AC 7（键集、长度、`to` 形态、验签失败不落块）与匿名读分页体例（AC 4 的索引侧） |
| `internal/httpapi/event.go` | 修改 | `eventTypeRegistry` 加 `"dm.v1"`；`handleEventPost` 加一个分支 |
| `internal/httpapi/server.go` | 修改 | 注册 `GET /v1/dm/{peer_id}`（匿名公开读） |
| `internal/peersync/eventsync.go` | 修改 | `parseEventProjection` 加 `dm.v1` 分支（补充 1 / F5′） |
| `internal/peersync/eventsync_test.go` | 修改 | 加一条：dm 事件跨节点后 `target_id`/`payload_cid` 与块归属都被还原（AC 4） |
| `apps/mobile/src/core/wire.ts` | 新建 | `buildEventWire` / `submitWire` + 事件层原语（base64url、`sealText`/`openText`、`sealKeyCipher`/`openKeyCipher`）（补充 2） |
| `apps/mobile/src/core/group.ts` | 修改 | 删掉已抽走的 8 个私有函数、4 处调用改名、改 import（纯抽取，行为零变化） |
| `apps/mobile/src/core/types.ts` | 修改 | 追加 `DmKeyRow` |
| `apps/mobile/src/core/repo.ts` | 修改 | `SCHEMA_SQL` 加 `dm_keys`；`LocalRepo` 3 方法；`SqlRepo` 实现 + `toDmKeyRow` |
| `apps/mobile/src/core/fakes.ts` | 修改 | `MemoryRepo` 的 `dmKeys` 与 3 个方法 |
| `apps/mobile/src/core/dm.ts` | 新建 | 六函数 + 好友码 7 键签名域 + 三条上限/前置校验 |
| `apps/mobile/src/core/dm.test.ts` | 新建 | AC 1 / 2 / 5 / 6 / 8 / 9 + 解密失败提示 + 客户端上限 |
| `apps/mobile/src/pages/dm/list.vue` | 新建 | 会话列表（并集）+ 生成好友码 + 粘贴好友码 |
| `apps/mobile/src/pages/dm/chat.vue` | 新建 | 会话页（双 `target_id` 合并、逐条解密、发送、待发区、无密钥提示） |
| `apps/mobile/src/pages/mine/mine.vue` | 修改 | 「我的」页新增一组私信入口（现有两组四行之后） |
| `apps/mobile/src/pages.json` | 修改 | 加 `pages/dm/list`、`pages/dm/chat` 两条路由（**tabBar 四 tab 不动**） |
| `apps/mobile/src/manifest.json` | 修改 | `0.10.0` / `14` |
| `docs/README.md` | 修改 | Task 10：只做状态回填（第 32 行登记已由主人完成） |
| `docs/superpowers/specs/2026-09-29-base-direct-message-design.md` | 修改 | Task 10：按册子 §9 第 3 条回填执行期更正（若无更正，则补一句「无」） |

---

### Task 1: 节点 store 层——`ListDMEvents`（同构于 `ListGroupEvents`）

**Files:**
- Test: `internal/store/dm_test.go`（新建）
- Create: `internal/store/dm.go`（新建）

- [ ] **Step 1: 先写失败测试 `internal/store/dm_test.go`**

```go
package store

import (
	"fmt"
	"testing"
)

// dmEventHex 造一个 16 字节（32 hex）的事件 id，形状与契约一致。
func dmEventHex(n int) string { return fmt.Sprintf("%032x", n) }

// 验收 4 的数据层：按收件人分页读 dm.v1——只认本收件人、只认 dm.v1、倒序 + 复合游标。
func TestListDMEventsFilterAndCursor(t *testing.T) {
	st := openTemp(t)
	put := func(eventID, typ, target string, createdAt int64) {
		t.Helper()
		if err := st.PutEvent(Event{
			EventID: eventID, ID: "actor-" + eventID, Type: typ, BodyJSON: `{}`,
			CreatedAt: createdAt, TargetID: target, PayloadCID: "cid-" + eventID,
		}); err != nil {
			t.Fatalf("PutEvent %s: %v", eventID, err)
		}
	}
	const (
		peer  = "000000000000000000000000000000aa"
		other = "000000000000000000000000000000bb"
	)
	// 同一收件人三条（时间递增）+ 别人的一条 + 另一类型的同 target 一条
	put(dmEventHex(1), "dm.v1", "dm/"+peer, 100)
	put(dmEventHex(2), "dm.v1", "dm/"+peer, 200)
	put(dmEventHex(3), "dm.v1", "dm/"+peer, 300)
	put(dmEventHex(4), "dm.v1", "dm/"+other, 400)
	put(dmEventHex(5), "dm.v1", "dm/"+peer, 500)
	put(dmEventHex(6), "group.v1", "dm/"+peer, 600)

	// 第一页：limit=2 → 最新的两条（500 / 300），由新到旧
	page1, err := st.ListDMEvents(peer, 0, "", 2)
	if err != nil {
		t.Fatalf("ListDMEvents page1: %v", err)
	}
	if len(page1) != 2 || page1[0].EventID != dmEventHex(5) || page1[1].EventID != dmEventHex(3) {
		t.Fatalf("第一页不符: %+v", page1)
	}
	if page1[0].TargetID != "dm/"+peer || page1[0].PayloadCID != "cid-"+dmEventHex(5) {
		t.Fatalf("投影列不符: %+v", page1[0])
	}

	// 第二页：用 (created_at, event_id) 复合游标继续
	page2, err := st.ListDMEvents(peer, page1[1].CreatedAt, page1[1].EventID, 2)
	if err != nil {
		t.Fatalf("ListDMEvents page2: %v", err)
	}
	if len(page2) != 2 || page2[0].EventID != dmEventHex(2) || page2[1].EventID != dmEventHex(1) {
		t.Fatalf("第二页不符: %+v", page2)
	}

	// 别人的私信与别的类型的事件都不许串进来
	for _, e := range append(page1, page2...) {
		if e.EventID == dmEventHex(4) || e.EventID == dmEventHex(6) {
			t.Fatalf("串了别的收件人或别的类型: %+v", e)
		}
	}
}
```

- [ ] **Step 2: 跑测试确认失败（红）**

Run（cwd `e:\code\base`）: `go test ./internal/store/ -run TestListDMEventsFilterAndCursor`
Expected: **编译失败**，
`internal\store\dm_test.go:38:19: st.ListDMEvents undefined (type *Store has no field or method ListDMEvents)`

- [ ] **Step 3: 新建 `internal/store/dm.go`（最小实现）**

```go
package store

// ListDMEvents 按 (created_at, event_id) 倒序分页读发给某收件人的 dm.v1 事件（册子 §4.2）。
// 与 ListGroupEvents 同构：只把 type 换成 dm.v1、target_id 换成 "dm/" + peerID。
// 私信没有投影表 ⇒ 调用方无需按 action 分流（每条都是密文发言）。
func (s *Store) ListDMEvents(peerID string, cursorTS int64, cursorID string, limit int) ([]Event, error) {
	if limit <= 0 {
		limit = 30
	}
	q := `SELECT ` + eventColumns + ` FROM events WHERE type='dm.v1' AND target_id=?`
	args := []any{"dm/" + peerID}
	if cursorID != "" {
		q += ` AND (created_at < ? OR (created_at = ? AND event_id < ?))`
		args = append(args, cursorTS, cursorTS, cursorID)
	}
	q += ` ORDER BY created_at DESC, event_id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.Query(q, args...)
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

- [ ] **Step 4: 跑测试确认通过（绿）**

Run（cwd `e:\code\base`）: `go test ./internal/store/ -run TestListDMEventsFilterAndCursor`
Expected: `ok  	github.com/johocn/base/internal/store`

- [ ] **Step 5: 提交**

```bash
git add internal/store/dm.go internal/store/dm_test.go
git commit -m "feat(store): 私信读索引 ListDMEvents（私信 §4.2）"
```

---

### Task 2: 节点事件入口——`dm.v1` 注册与密文落块

**Files:**
- Test: `internal/httpapi/dm_test.go`（新建）
- Modify: `internal/httpapi/event.go`（`eventTypeRegistry` 在 `:25-28`；`handleEventPost` 的 switch 在 `:60-67`）
- Create: `internal/httpapi/dm.go`（新建）

- [ ] **Step 1: 先写失败测试（AC 3 + AC 7 的前两条）**

新建 `internal/httpapi/dm_test.go`：

```go
package httpapi

import (
	"encoding/hex"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/johocn/base/internal/protocol"
)

// dmPeerOf 造一个 32 hex 的收件人身份 id（形状与契约一致）。
func dmPeerOf(n int) string { return fmt.Sprintf("%032x", n) }

// newDmNode 复用既有测试节点，并登记 testSeed 身份（写事件必须先登记）。
func newDmNode(t *testing.T) (*store.Store, string) {
	t.Helper()
	st, _, ts := newTestServer(t)
	registerIdentitySeed(t, ts.URL, testSeed)
	return st, ts.URL
}

// dmEventBody 造一条 dm.v1 事件体并签内容签名，与 groupEventBody 同口径。
func dmEventBody(t *testing.T, seed, eventID string, body map[string]any) string {
	t.Helper()
	payload := map[string]any{
		"event_id": eventID, "type": "dm.v1",
		"created_at": time.Now().UnixMilli(), "body": body,
	}
	canon, err := protocol.Canonicalize(payload)
	if err != nil {
		t.Fatalf("Canonicalize: %v", err)
	}
	sig, err := protocol.Sign(seed, canon)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	payload["sig"] = sig
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return string(raw)
}

func postDmBody(t *testing.T, seed, baseURL, eventID string, body map[string]any) (int, map[string]any) {
	t.Helper()
	raw := dmEventBody(t, seed, eventID, body)
	return sendAuth(t, signedRequest(t, seed, http.MethodPost, baseURL+"/v1/event", raw))
}

func postDmMsg(t *testing.T, seed, baseURL, eventID, to, cipher string) string {
	t.Helper()
	status, out := postDmBody(t, seed, baseURL, eventID, map[string]any{"to": to, "text_cipher": cipher})
	if status != http.StatusOK {
		t.Fatalf("dm 事件 status=%d out=%v", status, out)
	}
	cid, _ := out["payload_cid"].(string)
	if !protocol.IsBlobID(cid) {
		t.Fatalf("payload_cid 不合法: %v", out)
	}
	return cid
}

// 验收 3：节点侧无明文——块里存的就是客户端密文，事件行与块目录原始字节都不含明文。
func TestDMMsgStoresCipherNotPlaintext(t *testing.T) {
	st, base := newDmNode(t)
	to := dmPeerOf(1)
	plain := "私信明文-绝不出现在节点"
	// 密文形态照 §3.3（base64url），确保既不等于也不包含明文
	cipher := "AbC-_" + hex.EncodeToString([]byte(plain))
	if cipher == plain || strings.Contains(cipher, plain) {
		t.Fatal("测试自身有误：密文不得等于或包含明文")
	}

	cid := postDmMsg(t, testSeed, base, eventIDOf(1), to, cipher)

	// 块内容等于客户端给的密文（节点不解密、不解释）
	got, err := st.GetBlobBytes(cid)
	if err != nil || string(got) != cipher {
		t.Fatalf("块内容应等于客户端密文 err=%v got=%q", err, got)
	}
	rawBlob, err := os.ReadFile(st.BlobPath(cid))
	if err != nil {
		t.Fatalf("读块文件: %v", err)
	}
	if strings.Contains(string(rawBlob), plain) {
		t.Fatal("块目录原始字节里出现了私信明文")
	}
	// 事件行：target_id 由 to 拼出，body_json 只留 payload_cid
	ev, ok, err := st.GetEventByID(eventIDOf(1))
	if err != nil || !ok {
		t.Fatalf("读事件行 err=%v ok=%v", err, ok)
	}
	if strings.Contains(ev.BodyJSON, cipher) || strings.Contains(ev.BodyJSON, plain) {
		t.Fatalf("events.body_json 泄漏了密文或明文: %s", ev.BodyJSON)
	}
	if ev.Type != "dm.v1" || ev.TargetID != "dm/"+to || ev.PayloadCID != cid {
		t.Fatalf("事件行投影异常: %+v", ev)
	}
}

// 验收 7：严格键集 / to 形态 / 密文长度，一律 400 event_param_invalid。
func TestDMContractValidation(t *testing.T) {
	_, base := newDmNode(t)
	to := dmPeerOf(2)

	// 多一个未知键（action / reply_to 都不属于 dm.v1）
	status, out := postDmBody(t, testSeed, base, eventIDOf(1), map[string]any{
		"to": to, "text_cipher": "aaa", "action": "msg",
	})
	if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
		t.Fatalf("未知键 status=%d out=%v, want 400/event_param_invalid", status, out)
	}

	// to 非 32 hex（31 位 / 非 hex 字符各一例）
	for _, bad := range []string{"0000000000000000000000000000000", "zz000000000000000000000000000000"} {
		status, out = postDmBody(t, testSeed, base, eventIDOf(2), map[string]any{
			"to": bad, "text_cipher": "aaa",
		})
		if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
			t.Fatalf("to=%q status=%d out=%v, want 400/event_param_invalid", bad, status, out)
		}
	}

	// 密文空 / 超 8192 字节（客户端明文上限 4096 是客户端自己的事，节点只看密文长度）
	for _, cipher := range []string{"", strings.Repeat("a", maxDMCipherBytes+1)} {
		status, out = postDmBody(t, testSeed, base, eventIDOf(3), map[string]any{
			"to": to, "text_cipher": cipher,
		})
		if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
			t.Fatalf("密文长度 status=%d out=%v, want 400/event_param_invalid", status, out)
		}
	}
}

// 验收 7 的次序：验签失败一律不落块（先验签、后落块，与 comment / group 同一次序）。
func TestDMSigInvalidDoesNotStoreBlob(t *testing.T) {
	st, base := newDmNode(t)
	seedB := strings.Repeat("ab", 32)
	registerIdentitySeed(t, base, seedB)
	cipher := "vv-" + hex.EncodeToString([]byte("不该落块的密文"))

	// 内容签名来自 B，请求头却用 A 的私钥 ⇒ actor=A 与内容签名不符
	raw := dmEventBody(t, seedB, eventIDOf(1), map[string]any{"to": dmPeerOf(3), "text_cipher": cipher})
	status, out := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, base+"/v1/event", raw))
	if status != http.StatusForbidden || out["code"] != "event_sig_invalid" {
		t.Fatalf("错签名 status=%d out=%v, want 403/event_sig_invalid", status, out)
	}
	if ok, _, err := st.HasBlob(protocol.BlobID([]byte(cipher))); err != nil || ok {
		t.Fatalf("验签失败不得落块 ok=%v err=%v", ok, err)
	}
}
```

补两处 import：`encoding/json`（`dmEventBody` 用）与 `github.com/johocn/base/internal/store`（`newDmNode` 的返回类型）。

- [ ] **Step 2: 跑测试确认失败（红）**

Run（cwd `e:\code\base`）: `go test ./internal/httpapi/ -run 'TestDM'`
Expected: 编译失败 → `undefined: maxDMCipherBytes`（补全 import 后）。把 `maxDMCipherBytes` 一并在 Step 4 定义后，首个断言失败形态为 `dm 事件 status=400 out=map[error:event_type_unknown]`（类型未注册）。

- [ ] **Step 3: `event.go` 注册类型并加分支**

`internal/httpapi/event.go:25-28`：

```go
// eventTypeRegistry 是节点放行的事件类型表。
// 新增类型 = 在此加一行 + 在 handleEventPost 的 switch 里加一个分支，不改验签管线。
var eventTypeRegistry = map[string]struct{}{
	"comment.v1": {},
	"group.v1":   {},
	"dm.v1":      {},
}
```

`internal/httpapi/event.go:60-67` 的 switch 加一支（放在 `group.v1` 之后）：

```go
	case "dm.v1":
		s.handleDMEvent(w, actor, req, createdAt)
		return
```

- [ ] **Step 4: 新建 `internal/httpapi/dm.go`（事件落库部分）**

```go
package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

const (
	// maxDMCipherBytes 是单条私信密文的字节上限（与 maxGroupCipherBytes 同量级）；
	// 明文上限 4096 字节由客户端自己拦，节点只看密文长度、不解密、不推断（册子 §3.3）。
	maxDMCipherBytes = 8192
	// 读接口分页口径与 GET /v1/comment 逐字一致（册子 §4.2）。
	dmDefaultLimit = 30
	dmMaxLimit     = 100
)

type dmMsg struct {
	To         string
	TextCipher string
}

// parseDMBody 校验 dm.v1 的 body（册子 §3.3）：**只有两个键**，多一个未知键即拒
// （重建的待验字节必须与客户端所签一致）。返回的 map 保留客户端原始键集供验签重建。
func parseDMBody(raw json.RawMessage) (map[string]any, dmMsg, bool) {
	if len(raw) == 0 {
		return nil, dmMsg{}, false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, dmMsg{}, false
	}
	for k := range m {
		switch k {
		case "to", "text_cipher":
		default:
			return nil, dmMsg{}, false
		}
	}
	var d dmMsg
	d.To, _ = m["to"].(string)
	// 收件人是身份 id：32 hex。isHexN 的第二参是**字节数**，16 字节 = 32 hex（册子补充 9）。
	if !isHexN(d.To, 16) {
		return nil, dmMsg{}, false
	}
	d.TextCipher, _ = m["text_cipher"].(string)
	if len(d.TextCipher) == 0 || len(d.TextCipher) > maxDMCipherBytes {
		return nil, dmMsg{}, false
	}
	return m, d, true
}

// handleDMEvent 执行册子 §3.3：校验 body → 验内容签名 → 落块 → 落事件行。
// **不做墓碑检查**（② 类不可审，总纲 §12 第 9 条），**不校验 to 是否已登记身份**
// （与小组发言一致：节点不把「对方是否注册」当准入门槛）。
func (s *Server) handleDMEvent(w http.ResponseWriter, actor string, req eventReq, createdAt int64) {
	rawBody, d, ok := parseDMBody(req.Body)
	if !ok {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	if !s.verifyEventSig(w, actor, req, rawBody) {
		return
	}
	// 落块必须在**验签通过之后**（与 handleCommentEvent / putGroupMessage 同一次序）
	cipher := []byte(d.TextCipher)
	payloadCID := protocol.BlobID(cipher)
	exist, _, err := s.st.HasBlob(payloadCID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !exist {
		if err := s.st.PutBlob(payloadCID, cipher, "", 0); err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	// body_json 减化为 canonical({to, payload_cid})：密文只在块里存一份（与 comment / group 同构）
	bodyJSON, err := protocol.Canonicalize(map[string]any{"to": d.To, "payload_cid": payloadCID})
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UnixMilli()
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: actor, Type: req.Type, BodyJSON: string(bodyJSON),
		CreatedAt: createdAt, ReceivedAt: now,
		TargetID: "dm/" + d.To, PayloadCID: payloadCID,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 回读 received_at：同 event_id 重发时它是首次值，响应必须给权威值
	if ev, ok, err := s.st.GetEventByID(req.EventID); err == nil && ok {
		now = ev.ReceivedAt
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"event_id": req.EventID, "payload_cid": payloadCID, "received_at": now,
	})
}
```

> `handleDMGet` 与 DTO 在 Task 3 追加到同一文件；`strconv` 到 Task 3 才用得上，先在 Step 4 省掉（Task 3 补进 import 块）。

- [ ] **Step 5: 跑测试确认通过（绿）**

Run（cwd `e:\code\base`）: `go test ./internal/httpapi/ -run 'TestDM'` 然后 `go build ./...` 然后 `go vet ./...`
Expected: `ok  	github.com/johocn/base/internal/httpapi`；`go build` / `go vet` 无输出

- [ ] **Step 6: 提交**

```bash
git add internal/httpapi/event.go internal/httpapi/dm.go internal/httpapi/dm_test.go
git commit -m "feat(httpapi): dm.v1 事件注册与密文落块（私信 §3.3、§4.1）"
```

---

### Task 3: 节点匿名读接口 `GET /v1/dm/{peer_id}`

**Files:**
- Test: `internal/httpapi/dm_test.go`（追加两个用例）
- Modify: `internal/httpapi/dm.go`（追加 DTO 与 handler，补 `strconv` import）
- Modify: `internal/httpapi/server.go`（路由注册，加在 `:131` 的 `GET /v1/group/{group_id}` 之后）

- [ ] **Step 1: 先写失败测试（追加到 `internal/httpapi/dm_test.go` 末尾）**

```go
// 验收 4（索引侧）：未持有密钥者也能匿名分页读到私信索引。
func TestDMGetAnonymousListingAndPagination(t *testing.T) {
	_, base := newDmNode(t)
	to := dmPeerOf(4)
	// 4 条事件；limit=3 → 首页 3 条 + next_cursor，第二页 1 条 + null
	for i := 1; i <= 4; i++ {
		postDmMsg(t, testSeed, base, eventIDOf(i), to, fmt.Sprintf("cipher-%d", i))
	}

	// 匿名：不带任何 X-Base-* 头
	status, page1 := doJSONMap(t, http.MethodGet, base+"/v1/dm/"+to+"?limit=3", "", nil)
	if status != http.StatusOK {
		t.Fatalf("匿名读 status=%d out=%v", status, page1)
	}
	events, _ := page1["events"].([]any)
	if len(events) != 3 {
		t.Fatalf("第一页应满 3 条: %v", page1)
	}
	first, _ := events[0].(map[string]any)
	if first["event_id"] != eventIDOf(4) || first["actor"] == "" || first["created_at"] == nil {
		t.Fatalf("事件 DTO 字段异常: %v", first)
	}
	if cid, _ := first["payload_cid"].(string); !protocol.IsBlobID(cid) {
		t.Fatalf("payload_cid 不合法: %v", first)
	}
	next, _ := page1["next_cursor"].(string)
	if next == "" {
		t.Fatalf("满页必须给 next_cursor: %v", page1)
	}

	status, page2 := doJSONMap(t, http.MethodGet, base+"/v1/dm/"+to+"?limit=3&cursor="+next, "", nil)
	if status != http.StatusOK {
		t.Fatalf("第二页 status=%d out=%v", status, page2)
	}
	if events, _ := page2["events"].([]any); len(events) != 1 {
		t.Fatalf("第二页应只剩 1 条: %v", page2)
	}
	if page2["next_cursor"] != nil {
		t.Fatalf("不满页必须给 null 游标: %v", page2)
	}
}

// 册子 §4.2：**无 404 分支**（查无即空数组）；peer_id 非 32 hex → 400。
func TestDMGetNo404AndBadPeer(t *testing.T) {
	_, base := newDmNode(t)

	status, out := doJSONMap(t, http.MethodGet, base+"/v1/dm/"+dmPeerOf(99), "", nil)
	if status != http.StatusOK {
		t.Fatalf("查无数据应 200 而非 404: status=%d out=%v", status, out)
	}
	if events, _ := out["events"].([]any); len(events) != 0 {
		t.Fatalf("查无数据 events 应为空数组: %v", out)
	}
	if out["next_cursor"] != nil {
		t.Fatalf("查无数据 next_cursor 应为 null: %v", out)
	}

	for _, bad := range []string{"zz", "0000000000000000000000000000000"} {
		status, out = doJSONMap(t, http.MethodGet, base+"/v1/dm/"+bad, "", nil)
		if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
			t.Fatalf("peer_id=%q status=%d out=%v, want 400/event_param_invalid", bad, status, out)
		}
	}
}
```

`TestDMContractValidation` 用到 `maxDMCipherBytes`，`fmt` 在两个新用例里用到——确保 `dm_test.go` 的 import 块含 `fmt`、`encoding/json`、`github.com/johocn/base/internal/store`。

- [ ] **Step 2: 跑测试确认失败（红）**

Run（cwd `e:\code\base`）: `go test ./internal/httpapi/ -run 'TestDMGet'`
Expected: 失败形态为 `匿名读 status=404 out=map[]`（路由未注册，mux 回落到首页的 404）

- [ ] **Step 3: `internal/httpapi/dm.go` 追加 DTO 与 handler（并补 `strconv` import）**

追加到文件末尾：

```go
type dmEventDTO struct {
	EventID    string `json:"event_id"`
	Actor      string `json:"actor"`
	CreatedAt  int64  `json:"created_at"`
	PayloadCID string `json:"payload_cid"`
}

type dmResponse struct {
	Events     []dmEventDTO `json:"events"`
	NextCursor *string      `json:"next_cursor"`
}

// handleDMGet 匿名分页读「所有人发给 peer_id 的私信索引」（册子 §4.2）。
// 正文一律另取 GET /v1/blob/{payload_cid}（密文，节点不解释）。
// **无 404 分支**：私信没有投影表，查无数据即 {"events": [], "next_cursor": null}。
func (s *Server) handleDMGet(w http.ResponseWriter, r *http.Request) {
	peerID := r.PathValue("peer_id")
	if !isHexN(peerID, 16) {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	q := r.URL.Query()
	limit := dmDefaultLimit
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= dmMaxLimit {
			limit = n
		}
	}
	curTS, curID := parseCommentCursor(q.Get("cursor")) // 同一套不透明游标 <created_at>_<event_id>
	rows, err := s.st.ListDMEvents(peerID, curTS, curID, limit)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := dmResponse{Events: []dmEventDTO{}}
	for _, e := range rows {
		// 私信只有一种语义：body_json 是 canonical({to, payload_cid})
		var b struct {
			PayloadCID string `json:"payload_cid"`
		}
		if err := json.Unmarshal([]byte(e.BodyJSON), &b); err != nil {
			continue
		}
		resp.Events = append(resp.Events, dmEventDTO{
			EventID: e.EventID, Actor: e.ID, CreatedAt: e.CreatedAt, PayloadCID: b.PayloadCID,
		})
	}
	// 满页才给游标：与 GET /v1/comment 同口径
	if len(rows) == limit {
		last := rows[len(rows)-1]
		next := strconv.FormatInt(last.CreatedAt, 10) + "_" + last.EventID
		resp.NextCursor = &next
	}
	s.writeJSON(w, http.StatusOK, resp)
}
```

- [ ] **Step 4: `internal/httpapi/server.go` 注册路由**

在 `internal/httpapi/server.go:131`（`GET /v1/group/{group_id}` 那行）之后：

```go
	// 私信公开读（匿名，私信册 §4.2）：「谁、何时、给谁发了多大一条密文」这层元数据公开；
	// 内容仍不可读（无会话密钥）。**无 404 分支**：私信没有投影表，查无即空数组。
	mux.HandleFunc("GET /v1/dm/{peer_id}", s.handleDMGet)
```

- [ ] **Step 5: 跑测试确认通过（绿）**

Run（cwd `e:\code\base`）: `go test ./internal/httpapi/ -run 'TestDM'` 然后 `go vet ./...`
Expected: `ok  	github.com/johocn/base/internal/httpapi`；`go vet` 无输出

- [ ] **Step 6: 提交**

```bash
git add internal/httpapi/dm.go internal/httpapi/dm_test.go internal/httpapi/server.go
git commit -m "feat(httpapi): 匿名读 GET /v1/dm/{peer_id}（私信 §4.2）"
```

---

### Task 4: 反熵接收侧接线（F5′ 投影还原 + F6′ 块归属）

**Files:**
- Modify: `internal/store/comment.go`（`EventBlobIndex` 在 `:63-89`）
- Modify: `internal/peersync/eventsync.go`（`parseEventProjection` 在 `:193-223`）
- Test: `internal/peersync/eventsync_test.go`（追加一条，照 `:129` 的 group 版）

- [ ] **Step 1: 先写失败测试（追加到 `internal/peersync/eventsync_test.go` 末尾）**

```go
// 验收 4：一轮反熵后缓存节点能读到私信索引与密文块归属。
// 对端事件只有 body_json，target_id / payload_cid 必须在本地重建（F5′）；
// 密文块归属也要认得 dm.v1（F6′），否则缓存节点拉不下块、scrub 还会当孤儿删掉。
func TestDMEventProjectionRestoredOnPeer(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)

	const (
		peerID   = "00000000000000a1aaaaaaaaaaaaaaaa"
		msgEvent = "00000000000000000000000000000009"
	)
	cipher := []byte("私信密文")
	cid := protocol.BlobID(cipher)
	if err := src.PutBlob(cid, cipher, "dm:"+msgEvent, 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	body := `{"payload_cid":"` + cid + `","to":"` + peerID + `"}`
	if err := src.PutEvent(store.Event{
		EventID: msgEvent, ID: commentActor, Type: "dm.v1", BodyJSON: body,
		CreatedAt: time.Now().UnixMilli(), TargetID: "dm/" + peerID, PayloadCID: cid,
	}); err != nil {
		t.Fatalf("PutEvent dm: %v", err)
	}

	dst := openTemp(t)
	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	ev, err := cfg.SyncEvents(context.Background(), dst, Peer{URL: url})
	if err != nil || ev.Events != 1 {
		t.Fatalf("反熵一轮应搬来 1 条事件 ev=%+v err=%v", ev, err)
	}

	// ① 索引列从 body_json 还原（否则缓存节点 GET /v1/dm/{peer} 查不到）
	rows, err := dst.ListDMEvents(peerID, 0, "", 10)
	if err != nil || len(rows) != 1 {
		t.Fatalf("应读到 1 条 dm.v1 事件 rows=%+v err=%v", rows, err)
	}
	if rows[0].TargetID != "dm/"+peerID || rows[0].PayloadCID != cid {
		t.Fatalf("私信投影列未还原: %+v", rows[0])
	}

	// ② 块归属索引认得该密文（EventBlobIndex 纳入 dm.v1 后才成立）
	idx, err := dst.EventBlobIndex()
	if err != nil {
		t.Fatalf("EventBlobIndex: %v", err)
	}
	if ref, ok := idx[cid]; !ok || ref.ItemID != "dm:"+msgEvent {
		t.Fatalf("块归属不符: %+v ok=%v", ref, ok)
	}
}
```

- [ ] **Step 2: 跑测试确认失败（红）**

Run（cwd `e:\code\base`）: `go test ./internal/peersync/ -run TestDMEventProjectionRestoredOnPeer`
Expected: `私信投影列未还原: {EventID:… TargetID:… }`（`TargetID` 为空串）——即 `parseEventProjection` 缺 `dm.v1` 分支

- [ ] **Step 3: `parseEventProjection` 加 `dm.v1` 分支**

`internal/peersync/eventsync.go:196-223` 的 switch 里，在 `group.v1` 分支后插入：

```go
	case "dm.v1":
		// 私信的减化 body 是 {to, payload_cid}；target_id 由 to 拼回来（册子 §3.3）。
		var m struct {
			To         string `json:"to"`
			PayloadCID string `json:"payload_cid"`
		}
		if err := json.Unmarshal([]byte(bodyJSON), &m); err != nil || m.To == "" {
			return commentProjection{}
		}
		return commentProjection{TargetID: "dm/" + m.To, PayloadCID: m.PayloadCID}
```

- [ ] **Step 4: `EventBlobIndex` 纳入 `dm.v1`**

`internal/store/comment.go:63-89` 改为（注释与 SQL、前缀一起改）：

```go
// EventBlobIndex 返回事件正文块 → 归属事件的映射，来源是 events.payload_cid。
// ① 类评论正文与 ② 类小组 / 私信密文都挂在这里：三者都是「块被事件引用」，
// 少了归属，缓存节点永远拉不下来、scrub 还会把块当孤儿删掉（册子 §4.4）。
func (s *Store) EventBlobIndex() (map[string]BlobRef, error) {
	rows, err := s.db.Query(`SELECT type,event_id,payload_cid FROM events
		WHERE type IN ('comment.v1','group.v1','dm.v1') AND payload_cid IS NOT NULL AND payload_cid<>''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]BlobRef{}
	for rows.Next() {
		var typ, eventID, cid string
		if err := rows.Scan(&typ, &eventID, &cid); err != nil {
			return nil, err
		}
		if _, ok := out[cid]; ok {
			continue
		}
		prefix := "comment:"
		switch typ {
		case "group.v1":
			prefix = "group:"
		case "dm.v1":
			prefix = "dm:"
		}
		out[cid] = BlobRef{BlobID: cid, ItemID: prefix + eventID}
	}
	return out, rows.Err()
}
```

- [ ] **Step 5: 跑测试确认通过（绿），并跑 peersync + store 全包回归**

Run（cwd `e:\code\base`）: `go test ./internal/peersync/ -run 'TestDM'`; `go test ./internal/peersync/ ./internal/store/`; `go test ./...`
Expected: 新用例 ok；`internal/peersync` 与 `internal/store` 全包 ok（含既有 `TestGroupEventProjectionRestoredOnPeer`）；`go test ./...` 全包 ok

- [ ] **Step 6: 提交**

```bash
git add internal/store/comment.go internal/peersync/eventsync.go internal/peersync/eventsync_test.go
git commit -m "fix(peersync): 反熵接收侧还原 dm.v1 投影列与块归属（私信 §4.3 补充）"
```

---

### Task 5: 手机端 `core/wire.ts`——抽公共件（唯一一处改已上线代码）

**Files:**
- Create: `apps/mobile/src/core/wire.ts`
- Modify: `apps/mobile/src/core/group.ts`

- [ ] **Step 1: 取重构前基线（characterization）**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run src/core/group.test.ts`
Expected: `Test Files  1 passed (1)` / `Tests  7 passed (7)` —— 抽出后必须逐字不变

- [ ] **Step 2: 新建 `apps/mobile/src/core/wire.ts`**

```ts
/**
 * 事件层共用件：`POST /v1/event` 的请求体构造与「发或入队」编排，以及事件正文用到的
 * 字节 / 密文原语（base64url、正文 AEAD、密钥列级密文）。
 *
 * 抽自 `core/group.ts`（私信册 §5.2）：小组（group.v1）与私信（dm.v1）共用同一套 wire 与
 * 密文形态，避免第二份复制粘贴。只依赖 `@base/protocol-ts` 与 `core/identity`，
 * 不 import 'uni' / 'plus'，因此可在 Node 下用 `core/fakes.ts` 完整测试。
 */
import {
  bytesToHex,
  canonicalize,
  openWithNonce,
  randomBytes,
  sealWithNonce,
  sign,
  utf8,
  type Json,
} from '@base/protocol-ts';

import type { Adapters } from '../platform/adapter';
import type { LocalRepo } from './repo';
import { CommentError, sendComment } from './comment';
import { deviceKek, type Identity } from './identity';
import { decodeUtf8 } from './sync';
import { hexToBytes } from '@base/protocol-ts';

/** 与 `CommentOptions` **同形**：这样 `flushPending`（补发）可直接喂进来，无需转换。 */
export interface WireOptions {
  adapters: Adapters;
  repo: LocalRepo;
  nodeBaseUrl: string;
}

const GCM_NONCE_BYTES = 12;

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url 手写：老 WebView 无 `btoa` 稳定实现，Node 测试里 `platform/uni.ts` 又不可用。 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64URL.charAt(b0 >> 2);
    out += B64URL.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    if (i + 1 < bytes.length) out += B64URL.charAt(((b1 & 0x0f) << 2) | (b2 >> 6));
    if (i + 2 < bytes.length) out += B64URL.charAt(b2 & 0x3f);
  }
  return out;
}

export function base64UrlToBytes(s: string): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64URL.indexOf(s.charAt(i));
    if (v < 0) throw new Error('base64url: 非法字符');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** 会话 / 组密钥落库：`nonceHex:ctHex`——与 `identity.ts:96` 的私钥密文**同一形态**。 */
export async function sealKeyCipher(storage: Adapters['storage'], keyBytes: Uint8Array): Promise<string> {
  const kek = await deviceKek(storage);
  const nonce = randomBytes(GCM_NONCE_BYTES);
  return `${bytesToHex(nonce)}:${bytesToHex(sealWithNonce(kek, nonce, keyBytes))}`;
}

export async function openKeyCipher(storage: Adapters['storage'], keyCipher: string): Promise<Uint8Array> {
  const kek = await deviceKek(storage);
  const [nonceHex, ctHex] = keyCipher.split(':');
  if (!nonceHex || !ctHex) throw new Error('密钥密文格式损坏');
  return openWithNonce(kek, hexToBytes(nonceHex), hexToBytes(ctHex));
}

/** 正文加密：`base64url(nonce12 || sealWithNonce(...))`。 */
export function sealText(key: Uint8Array, plain: string): string {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const ct = sealWithNonce(key, nonce, utf8(plain));
  const buf = new Uint8Array(nonce.length + ct.length);
  buf.set(nonce, 0);
  buf.set(ct, nonce.length);
  return bytesToBase64Url(buf);
}

/** 正文解密；密钥不对 / 密文损坏一律抛错，由调用方降级为「提示 + 占位」。 */
export function openText(key: Uint8Array, textCipher: string): string {
  const buf = base64UrlToBytes(textCipher);
  if (buf.length < GCM_NONCE_BYTES + 16) throw new Error('密文过短');
  return decodeUtf8(openWithNonce(key, buf.subarray(0, GCM_NONCE_BYTES), buf.subarray(GCM_NONCE_BYTES)));
}

/** 构造一条已签名事件请求体：内容签名覆盖 canonical({event_id,type,created_at,body})。 */
export function buildEventWire(ident: Identity, type: string, body: Json): { eventId: string; wire: string } {
  const eventId = bytesToHex(randomBytes(16));
  const payload: Json = { event_id: eventId, type, created_at: Date.now(), body };
  const sig = sign(ident.seedHex, utf8(canonicalize(payload)));
  return { eventId, wire: JSON.stringify({ ...(payload as Record<string, Json>), sig }) };
}

/**
 * 发一条已签名事件；**只有网络不可达**才入 `comment_out`（节点给了任何 HTTP 响应都原样抛出、不入队）。
 * 复用 `sendComment` ⇒ 签名头、错误码映射、`wire` 重放全部零新代码。
 */
export async function submitWire(
  o: WireOptions,
  input: { eventId: string; wire: string; targetId: string; queueText: string },
): Promise<{ queued: boolean }> {
  try {
    await sendComment(o, { targetId: input.targetId, text: input.queueText, wire: input.wire, eventId: input.eventId });
    return { queued: false };
  } catch (e) {
    if (e instanceof CommentError && e.code === 'network') {
      await o.repo.enqueueComment({
        eventId: input.eventId,
        targetId: input.targetId,
        text: input.queueText,
        replyTo: null,
        wire: input.wire,
        state: 'pending',
        reason: null,
        queuedAt: new Date().toISOString(),
      });
      return { queued: true };
    }
    throw e;
  }
}
```

> import 块请合并成一条 `@base/protocol-ts` 语句（`hexToBytes` 与其余同一个包），上例为便于逐条核对分了两行。

- [ ] **Step 3: 改 `apps/mobile/src/core/group.ts`（纯抽取）**

① **import 段**（`group.ts:8-28`）替换为：

```ts
import {
  bytesToHex,
  canonicalize,
  deriveIdentityId,
  hexToBytes,
  isIdentityId,
  randomBytes,
  sign,
  utf8,
  verify,
  type Json,
} from '@base/protocol-ts';

import type { GroupRow } from './types';
import { ensureLocalIdentity, type Identity } from './identity';
import { decodeUtf8 } from './sync';
import {
  base64UrlToBytes,
  buildEventWire,
  bytesToBase64Url,
  openKeyCipher,
  openText,
  sealKeyCipher,
  sealText,
  submitWire,
  type WireOptions,
} from './wire';
```

② **`GroupOptions`**（`group.ts:30-35`）换成别名（`WireOptions` 与新文件同形，页面 `import { type GroupOptions }` 不受影响）：

```ts
/** 与 `WireOptions` 同形（原样保留这个导出名，页面与测试的 import 不必改）。 */
export type GroupOptions = WireOptions;
```

③ **删除**（内容已逐字搬进 `wire.ts`）：常量 `GCM_NONCE_BYTES`（`:62`）、`B64URL` 与 `bytesToBase64Url` / `base64UrlToBytes`（`:64-95`）、`sealGroupKey` / `openGroupKey`（`:97-109`）、`sealText` / `openText`（`:111-126`）、`buildGroupWire`（`:251-257`）、`submitWire`（`:259-287`）。`GROUP_KEY_BYTES`（`:61`）仍被 `createGroup` / `rotateGroup` 使用，**保留**。

④ **4 处调用改名**（`sealGroupKey` → `sealKeyCipher`；`openGroupKey` → `openKeyCipher`）：

| 行 | 原 | 新 |
|---|---|---|
| `:221`（`saveInvite`） | `keyCipher: await sealGroupKey(o.adapters.storage, hexToBytes(inv.groupKeyHex)),` | `keyCipher: await sealKeyCipher(o.adapters.storage, hexToBytes(inv.groupKeyHex)),` |
| `:319`（`createGroup`） | `keyCipher: await sealGroupKey(o.adapters.storage, hexToBytes(groupKeyHex)),` | `keyCipher: await sealKeyCipher(o.adapters.storage, hexToBytes(groupKeyHex)),` |
| `:362`（`rotateGroup`） | 同上形态 | `sealKeyCipher(...)` |
| `:400`（`postGroupMessage`） | `const key = await openGroupKey(o.adapters.storage, row.keyCipher);` | `const key = await openKeyCipher(o.adapters.storage, row.keyCipher);` |
| `:517`（`fetchGroupMessages`） | `keyMap.set(row.epoch, await openGroupKey(o.adapters.storage, row.keyCipher));` | `keyMap.set(row.epoch, await openKeyCipher(o.adapters.storage, row.keyCipher));` |

⑤ **3 处 wire 构造**（`buildGroupWire(ident, body)` → `buildEventWire(ident, 'group.v1', body)`）：`:324`（`createGroup` 的 roster）、`:369`（`rotateGroup` 的 roster）、`:412`（`postGroupMessage` 的 msg）。例如 `:412` 那行：

```ts
  const { eventId, wire } = buildEventWire(ident, 'group.v1', body);
```

- [ ] **Step 4: 跑测试确认行为零变化（绿）**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run src/core/group.test.ts`; `npx vitest run`; `npx tsc --noEmit`
Expected: `group.test.ts` **7 passed**（与 Step 1 逐字一致）；全套 **17 文件 / 149 项全绿**；`tsc` 无输出

- [ ] **Step 5: 复核 `comment.ts` 不收编（补充 3 的结论落地）**

Run（cwd `e:\code\base\apps\mobile`）: `git diff --stat src/core/comment.ts`
Expected: **无输出**（`comment.ts` 一行未动）。
说明：`comment.ts:180-187` 的 `buildCommentWire` 与 `buildEventWire` 同构，但收编会让 `comment.ts` 反向 import `wire.ts`、与 `wire.ts` 的 `sendComment` import 形成模块环，与「纯抽取、行为零变化」冲突 → 本轮不收编，见「补充 3」。

- [ ] **Step 6: 提交**

```bash
git add apps/mobile/src/core/wire.ts apps/mobile/src/core/group.ts
git commit -m "refactor(mobile): 抽出 core/wire.ts 事件 wire 与密文原语（私信 §5.2）"
```

---

### Task 6: 手机端本地表 `dm_keys` 与 `LocalRepo` 三方法

**Files:**
- Modify: `apps/mobile/src/core/types.ts`（追加到文件末尾）
- Modify: `apps/mobile/src/core/repo.ts`（import 在 `:4`；接口在 `:18-84`；`SCHEMA_SQL` 在 `:87-124`；`SqlRepo` 方法加在 `:406-409` 附近；行映射函数加在 `:519-526` 附近）
- Modify: `apps/mobile/src/core/fakes.ts`（import 在 `:5`；`MemoryRepo` 加在 `:218-223` 之后）

- [ ] **Step 1: `types.ts` 追加行类型**

```ts
/**
 * 私信会话密钥（本地 `dm_keys` 表，私信册 §5.1）。一 peer 一把、双向共用，无 epoch、无轮换。
 * `keyCipher` 与 `identity.ts` 的私钥密文、`group_keys.key_cipher` **同一形态**（`nonce:ct`）。
 * 本表**不含昵称**：好友列表项只显示 id 前 8 位。
 */
export interface DmKeyRow {
  /** 对方身份 id（32 hex），主键 */
  peerId: string;
  keyCipher: string;
  /** 建立会话时刻 ISO8601（列表排序键） */
  createdAt: string;
}
```

- [ ] **Step 2: `repo.ts` 加接口与建表语句（先只加这两处，制造类型红）**

`repo.ts:4` 的 import 类型列表加入 `DmKeyRow`（按字母序放在 `CommentOutRow` 之后）。

`LocalRepo`（`repo.ts:65-68` 的 `listGroupKeys` 之后）加三个方法：

```ts
  /** 写/覆盖一条好友会话密钥（同 `peer_id` 覆盖密钥、保留首次 `created_at`）。幂等与冲突的裁决在 `core/dm.ts`，不在仓储层。 */
  putDmKey(row: DmKeyRow): Promise<void>;
  /** 读一条；不存在返回 null。 */
  getDmKey(peerId: string): Promise<DmKeyRow | null>;
  /** 全部行，按 `created_at ASC`（好友列表本体，私信册 §5.1）。 */
  listDmKeys(): Promise<DmKeyRow[]>;
```

`SCHEMA_SQL`（`repo.ts:121-123` 的 `group_keys` 之后）追加：

```ts
  `CREATE TABLE IF NOT EXISTS dm_keys(
     peer_id TEXT PRIMARY KEY, key_cipher TEXT NOT NULL, created_at TEXT NOT NULL)`,
```

- [ ] **Step 3: 跑类型检查确认失败（红）**

Run（cwd `e:\code\base\apps\mobile`）: `npx tsc --noEmit`
Expected: 两条错误（形态逐字如下）
`src/core/repo.ts(127,14): error TS2420: Class 'SqlRepo' incorrectly implements interface 'LocalRepo'.`
`src/core/repo.ts(127,14): error TS2739: Type 'SqlRepo' is missing the following properties from type 'LocalRepo': putDmKey, getDmKey, listDmKeys`
（`MemoryRepo` 同类错误紧邻其后）

- [ ] **Step 4: `SqlRepo` 实现三个方法 + 行映射**

在 `repo.ts:406-409`（`listGroupKeys`）之后插入：

```ts
  async putDmKey(row: DmKeyRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO dm_keys(peer_id,key_cipher,created_at) VALUES(?,?,?)
       ON CONFLICT(peer_id) DO UPDATE SET key_cipher=excluded.key_cipher`,
      [row.peerId, row.keyCipher, row.createdAt],
    );
  }

  async getDmKey(peerId: string): Promise<DmKeyRow | null> {
    const rows = await this.db.select(`SELECT peer_id,key_cipher,created_at FROM dm_keys WHERE peer_id=?`, [peerId]);
    return rows.length > 0 ? toDmKeyRow(rows[0]) : null;
  }

  async listDmKeys(): Promise<DmKeyRow[]> {
    const rows = await this.db.select(`SELECT peer_id,key_cipher,created_at FROM dm_keys ORDER BY created_at ASC`);
    return rows.map(toDmKeyRow);
  }
```

在 `repo.ts:519-526`（`toGroupKeyRow`）之后插入：

```ts
function toDmKeyRow(r: Record<string, unknown>): DmKeyRow {
  return {
    peerId: String(r.peer_id ?? ''),
    keyCipher: String(r.key_cipher ?? ''),
    createdAt: String(r.created_at ?? ''),
  };
}
```

- [ ] **Step 5: `fakes.ts` 的 `MemoryRepo` 实现**

`fakes.ts:5` 的 import 类型列表加入 `DmKeyRow`；在 `fakes.ts:218-223`（`listGroupKeys`）之后插入：

```ts
  dmKeys = new Map<string, DmKeyRow>(); // peerId -> row

  async putDmKey(row: DmKeyRow): Promise<void> {
    const cur = this.dmKeys.get(row.peerId);
    // created_at 保留首次值（与 SqlRepo 的 ON CONFLICT UPDATE 列表一致）
    this.dmKeys.set(row.peerId, cur ? { ...row, createdAt: cur.createdAt } : { ...row });
  }
  async getDmKey(peerId: string): Promise<DmKeyRow | null> {
    return this.dmKeys.get(peerId) ?? null;
  }
  async listDmKeys(): Promise<DmKeyRow[]> {
    return [...this.dmKeys.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }
```

- [ ] **Step 6: 跑类型检查与回归（绿）**

Run（cwd `e:\code\base\apps\mobile`）: `npx tsc --noEmit`; `npx vitest run`
Expected: `tsc` 无输出；**17 文件 / 149 项**全绿（新表只追加，既有测试不应有任何变动）

- [ ] **Step 7: 提交**

```bash
git add apps/mobile/src/core/types.ts apps/mobile/src/core/repo.ts apps/mobile/src/core/fakes.ts
git commit -m "feat(mobile): 本地 dm_keys 表与仓储三方法（私信 §5.1）"
```

---

### Task 7: 手机端 `core/dm.ts`（第一部分）——好友码与建友 / 收码

**Files:**
- Test: `apps/mobile/src/core/dm.test.ts`（新建，本 Task 放 AC 1 / 2 / 8 三条）
- Create: `apps/mobile/src/core/dm.ts`（本 Task 只写好友码与 `createFriend` / `acceptFriendCode`）

- [ ] **Step 1: 先写失败测试（`dm.test.ts` 先放 AC 1 / 2 / 8 三条，覆盖好友码全部语义）**

```ts
import { describe, expect, it } from 'vitest';

import { bytesToHex, canonicalize, hexToBytes, openWithNonce, sign, utf8 } from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, MemoryStorage } from './fakes';
import type { Adapters } from '../platform/adapter';
import { deviceKek, ensureLocalIdentity, type Identity } from './identity';
import { decodeUtf8 } from './sync';
import { base64UrlToBytes, bytesToBase64Url } from './wire';
import { acceptFriendCode, createFriend, decodeFriendCode, DmError, type DmOptions } from './dm';

const BASE = 'https://node.test';

function fixture() {
  const http = new FakeHttp();
  const storage = new MemoryStorage();
  const repo = new MemoryRepo();
  const adapters: Adapters = { fs: new MemoryFs(), storage, http, packReader: new FakePackReader() };
  const o: DmOptions = { adapters, repo, nodeBaseUrl: BASE };
  return { http, storage, repo, o };
}

/** 可开关的「网络不可达」模拟：只挡 http，本地存储与仓储照常走（照 comment.test.ts 的 gatePost）。 */
function gateOffline(o: DmOptions): { offline: boolean } {
  const real = o.adapters.http;
  const state = { offline: true };
  o.adapters.http = {
    get: (url, headers) => (state.offline ? Promise.reject(new Error('断网')) : real.get(url, headers)),
    post: (url, body, headers) => (state.offline ? Promise.reject(new Error('断网')) : real.post(url, body, headers)),
  };
  return state;
}

/** 用自己的设备 KEK 解开 `dm_keys.key_cipher`，回原始 32 字节 hex（AC 1 的「key 相同」判定）。 */
async function dmKeyHex(storage: MemoryStorage, cipher: string): Promise<string> {
  const kek = await deviceKek(storage);
  const [n, ct] = cipher.split(':');
  return bytesToHex(openWithNonce(kek, hexToBytes(n!), hexToBytes(ct!)));
}

/** 手工重编码（篡改用）：解析原载荷 → mutate → 重新 base64url（**不重签**，故必然验签失败）。 */
function rewrap(code: string, mutate: (obj: Record<string, unknown>) => void): string {
  const obj = JSON.parse(decodeUtf8(base64UrlToBytes(code.slice('base1:'.length)))) as Record<string, unknown>;
  mutate(obj);
  return 'base1:' + bytesToBase64Url(utf8(JSON.stringify(obj)));
}

/** 手工签一张合法好友码（造「同 peer 不同 key」用；不经过 createFriend 的密钥落库）。 */
function handSignedCode(
  owner: Identity,
  fields: { peerId: string; keyHex: string; ownerName?: string; createdAt?: number },
): string {
  const payload: Record<string, unknown> = {
    v: 1,
    peer_id: fields.peerId,
    key: fields.keyHex,
    owner_id: owner.id,
    owner_name: fields.ownerName ?? '',
    owner_pub: owner.pubHex,
    created_at: fields.createdAt ?? Date.now(),
  };
  const sig = sign(owner.seedHex, utf8(canonicalize(payload)));
  return 'base1:' + bytesToBase64Url(utf8(canonicalize({ ...payload, sig })));
}

/** 断言一个 Promise 抛 `DmError(code)`（比 `toThrowError` 更精确，不受文案影响）。 */
async function expectDmError(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DmError && e.code === code) return;
    throw new Error(`期望 DmError(${code})，实得 ${String(e)}`);
  }
  throw new Error(`期望抛 DmError(${code})，但未抛错`);
}

describe('dm', () => {
  it('AC 1：A 断网出码、B 断网粘码，双方各落一条 dm_keys 且 key 相同', async () => {
    const a = fixture();
    const b = fixture();
    gateOffline(a.o);
    gateOffline(b.o);
    const idA = (await ensureLocalIdentity(a.storage)).id;
    const idB = (await ensureLocalIdentity(b.storage)).id;

    const made = await createFriend(a.o, idB, '阿甲');
    expect(made.code.startsWith('base1:')).toBe(true);
    expect(a.http.posted).toHaveLength(0); // 出码全程离线：不发任何请求

    const joined = await acceptFriendCode(b.o, made.code);
    expect(joined.idempotent).toBe(false);
    expect(b.http.posted).toHaveLength(0); // 粘码全程离线（AC 1）

    const ka = await a.repo.listDmKeys();
    const kb = await b.repo.listDmKeys();
    expect(ka).toHaveLength(1);
    expect(kb).toHaveLength(1);
    expect(ka[0]!.peerId).toBe(idB);
    expect(kb[0]!.peerId).toBe(idA);
    expect(await dmKeyHex(b.storage, kb[0]!.keyCipher)).toBe(await dmKeyHex(a.storage, ka[0]!.keyCipher));
  });

  it('AC 2：篡改任一字段被拒（统一文案）；码转给第三方因 peer_id 不符被拒', async () => {
    const a = fixture();
    const b = fixture();
    const c = fixture();
    const idA = (await ensureLocalIdentity(a.storage)).id;
    const idB = (await ensureLocalIdentity(b.storage)).id;
    const idC = (await ensureLocalIdentity(c.storage)).id;
    const made = await createFriend(a.o, idB, '阿甲');

    // ① 篡改 key 字段（不改 sig）⇒ 验签失败 ⇒ 统一文案
    const tampered = rewrap(made.code, (o) => {
      const k = String(o.key ?? '');
      o.key = (k[0] === 'a' ? 'b' : 'a') + k.slice(1);
    });
    expect(() => decodeFriendCode(tampered, idB)).toThrowError('好友码无效或已损坏');

    // ② 定向：把 B 的码转给 C ⇒ C 解码即因 peer_id 不符被拒
    expect(() => decodeFriendCode(made.code, idC)).toThrowError('好友码无效或已损坏');

    // 合法码在本人手里通过，owner 是 A
    expect(decodeFriendCode(made.code, idB).ownerId).toBe(idA);
  });

  it('AC 8：同码重复粘贴幂等通过；同 peer 不同 key 的码被拒 key_conflict', async () => {
    const a = fixture();
    const b = fixture();
    const ownerA = await ensureLocalIdentity(a.storage);
    const idB = (await ensureLocalIdentity(b.storage)).id;
    const k1 = '11'.repeat(32);
    const k2 = '22'.repeat(32);

    const first = await acceptFriendCode(b.o, handSignedCode(ownerA, { peerId: idB, keyHex: k1 }));
    expect(first).toEqual({ peerId: ownerA.id, idempotent: false });

    // 同一张码再粘一次：幂等通过，不报错、不覆盖
    const again = await acceptFriendCode(b.o, handSignedCode(ownerA, { peerId: idB, keyHex: k1 }));
    expect(again.idempotent).toBe(true);

    // 同 peer 不同 key：拒 key_conflict，且本地密钥不动
    const before = (await b.repo.listDmKeys())[0]!.keyCipher;
    await expectDmError(acceptFriendCode(b.o, handSignedCode(ownerA, { peerId: idB, keyHex: k2 })), 'key_conflict');
    expect((await b.repo.listDmKeys())[0]!.keyCipher).toBe(before);
  });
});
```

- [ ] **Step 2: 跑测试确认失败（红）**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run src/core/dm.test.ts`
Expected: 收集失败 → `Failed to load url ./dm ... Does the file exist?`（模块尚未创建）

- [ ] **Step 3: 新建 `apps/mobile/src/core/dm.ts`（本 Task 只写好友码与 `createFriend` / `acceptFriendCode`）**

```ts
/**
 * 私信（② 加密）：好友码编解码与离线自验、建好友 / 收码、会话列表、发言、双 target_id 合并解密。
 *
 * 只依赖注入的适配器 / `LocalRepo` / `core/identity`，不 import 'uni' / 'plus'，
 * 因此可在 Node 下用 `core/fakes.ts` 完整测试（与 core/group.ts 同一约定）。
 * 密码学**零新代码**：wire 与密文原语来自 `core/wire.ts`（#32 §5.2）。
 */
import {
  bytesToHex,
  canonicalize,
  deriveIdentityId,
  hexToBytes,
  isIdentityId,
  randomBytes,
  sign,
  utf8,
  verify,
  type Json,
} from '@base/protocol-ts';

import type { Adapters } from '../platform/adapter';
import type { LocalRepo } from './repo';
import { ensureLocalIdentity, type Identity } from './identity';
import { decodeUtf8 } from './sync';
import {
  base64UrlToBytes,
  buildEventWire,
  bytesToBase64Url,
  openKeyCipher,
  openText,
  sealKeyCipher,
  sealText,
  submitWire,
  type WireOptions,
} from './wire';

/** 与 `WireOptions` **同形**：离线发言可直接把 `o` 喂给 `flushPending` 与 `submitWire`。 */
export type DmOptions = WireOptions;

export type DmErrorCode =
  | 'friend_code_invalid'
  | 'key_conflict'
  | 'not_friend'
  | 'too_long'
  | 'client'
  | 'network'
  | 'server'
  | 'rejected'
  | 'unregistered'
  | 'rate_limited'
  | 'revoked';

export class DmError extends Error {
  constructor(
    readonly code: DmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DmError';
  }
}

/** 好友码自验失败**统一文案**（册子 §3.2：不区分哪一步失败，不泄漏「哪一步失败」）。 */
export const FRIEND_CODE_INVALID_MESSAGE = '好友码无效或已损坏';
/** 本地无该 peer 密钥时的原位提示（册子 §5.3；密文原文永不进界面）。 */
export const DM_KEY_MISSING_NOTICE = '这是新好友的来信，请先与对方交换好友码。';
/** 密钥在但认证失败（或块取不到）时的原位提示。 */
export const DM_DECRYPT_FAILED_NOTICE = '这条私信解不开，可能与对方的好友码不一致。';
/** 客户端明文上限（册子 §3.3）：单条明文 ≤ 4096 字节（UTF-8），入队前校验。 */
export const DM_TEXT_MAX_BYTES = 4096;

const SESSION_KEY_BYTES = 32;
const B64URL_PREFIX = 'base1:';

export interface FriendCode {
  v: number;
  peerId: string;
  keyHex: string;
  ownerId: string;
  ownerName: string;
  ownerPubHex: string;
  createdAt: number;
  sig: string;
}

/** 签名域的 **7 个固定键**（册子 §3.2）：`owner_name` 缺省写空串（避免同一码 canonicalize 出两种字节序）。 */
function friendSignFields(c: FriendCode): Record<string, Json> {
  return {
    v: c.v,
    peer_id: c.peerId,
    key: c.keyHex,
    owner_id: c.ownerId,
    owner_name: c.ownerName,
    owner_pub: c.ownerPubHex,
    created_at: c.createdAt,
  };
}

/** 客户端侧第二参是 **hex 字符数**（与节点侧 `isHexN` 的「字节数」语义不同，见「补充 9」）。 */
function isHexN(s: string, n: number): boolean {
  return new RegExp(`^[0-9a-f]{${n}}$`).test(s);
}

/** 册子 §3.2：形态 → 定向 → 自证，任一步失败统一文案，不泄漏「哪一步失败」。 */
function invalidFriendCode(): DmError {
  return new DmError('friend_code_invalid', FRIEND_CODE_INVALID_MESSAGE);
}

/** 编码为 `base1:` + base64url(canonical(7 键 + sig))，单行可复制粘贴。 */
export function encodeFriendCode(c: FriendCode): string {
  const body: Json = { ...friendSignFields(c), sig: c.sig };
  return `${B64URL_PREFIX}${bytesToBase64Url(utf8(canonicalize(body)))}`;
}

/**
 * 解码 + **离线自验三步**（册子 §3.2）：形态 → 定向（`peer_id === myId`）→ 自证（id 派生 + 验签）。
 * `myId === ''`（本机尚无身份）一律按 `friend_code_invalid` 拒绝。
 */
export function decodeFriendCode(code: string, myId: string): FriendCode {
  const raw = code.trim();
  if (!raw.startsWith(B64URL_PREFIX)) throw invalidFriendCode();
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(decodeUtf8(base64UrlToBytes(raw.slice(B64URL_PREFIX.length)))) as Record<string, unknown>;
  } catch {
    throw invalidFriendCode();
  }
  const c: FriendCode = {
    v: Number(m.v ?? 0),
    peerId: String(m.peer_id ?? ''),
    keyHex: String(m.key ?? ''),
    ownerId: String(m.owner_id ?? ''),
    ownerName: typeof m.owner_name === 'string' ? m.owner_name : '',
    ownerPubHex: String(m.owner_pub ?? ''),
    createdAt: Number(m.created_at ?? 0),
    sig: String(m.sig ?? ''),
  };
  // ① 形态：7 键的类型与长度
  if (c.v !== 1) throw invalidFriendCode();
  if (!isHexN(c.peerId, 32) || !isHexN(c.keyHex, 64)) throw invalidFriendCode();
  if (!isIdentityId(c.ownerId) || !isHexN(c.ownerPubHex, 64)) throw invalidFriendCode();
  if (!Number.isInteger(c.createdAt)) throw invalidFriendCode();
  // ② 定向：本码指定的接收人必须是本机（与组码可任意转发的关键差别）
  if (myId === '' || c.peerId !== myId) throw invalidFriendCode();
  // ③ 自证：公钥派生的 id 必须等于 owner_id，且签名必须由该公钥验证通过
  if (deriveIdentityId(c.ownerPubHex) !== c.ownerId) throw invalidFriendCode();
  if (!verify(c.ownerPubHex, utf8(canonicalize(friendSignFields(c))), c.sig)) throw invalidFriendCode();
  return c;
}

/** 用生成者身份私钥对 7 个字段签名（不含 `sig` 自身）。 */
function signFriendCode(ident: Identity, fields: Omit<FriendCode, 'sig'>): FriendCode {
  const sig = sign(ident.seedHex, utf8(canonicalize(friendSignFields({ ...fields, sig: '' }))));
  return { ...fields, sig };
}

/**
 * 建立一条好友关系（册子 §3.2 单向发起）：生成 32 字节随机会话密钥 → 落 `dm_keys(peer_id)` → 出好友码。
 * **全程离线、零网络**（AC 1）。同一 peer 已有本地密钥时**复用**（重复出码不换钥，与「幂等」同口径）。
 * `ownerName` 即签名域里的 `owner_name`，缺省空串（册子 §3.2）。
 */
export async function createFriend(o: DmOptions, peerId: string, ownerName = ''): Promise<{ peerId: string; code: string }> {
  if (!isIdentityId(peerId)) throw new DmError('client', '对方身份 id 形态不对');
  const ident = await ensureLocalIdentity(o.adapters.storage);
  if (peerId === ident.id) throw new DmError('client', '不能添加自己为好友');
  const existing = await o.repo.getDmKey(peerId);
  let keyBytes: Uint8Array;
  if (existing) {
    keyBytes = await openKeyCipher(o.adapters.storage, existing.keyCipher); // 重复出码：复用已存密钥，保证码与本地一致
  } else {
    keyBytes = randomBytes(SESSION_KEY_BYTES);
    await o.repo.putDmKey({
      peerId,
      keyCipher: await sealKeyCipher(o.adapters.storage, keyBytes),
      createdAt: new Date().toISOString(),
    });
  }
  const code = encodeFriendCode(
    signFriendCode(ident, {
      v: 1,
      peerId,
      keyHex: bytesToHex(keyBytes),
      ownerId: ident.id,
      ownerName,
      ownerPubHex: ident.pubHex,
      createdAt: Date.now(),
    }),
  );
  return { peerId, code };
}

/**
 * 粘入好友码（册子 §3.2）。解码自验后落 `dm_keys(peer_id = 生成者)`。
 * 幂等：码里 `key` 与本地相同 ⇒ 通过且不覆盖；不同 ⇒ 拒 `key_conflict`。**全程离线、零网络**（AC 1）。
 */
export async function acceptFriendCode(o: DmOptions, code: string): Promise<{ peerId: string; idempotent: boolean }> {
  const myId = (await ensureLocalIdentity(o.adapters.storage)).id;
  const c = decodeFriendCode(code, myId);
  const existing = await o.repo.getDmKey(c.ownerId);
  if (existing) {
    const cur = await openKeyCipher(o.adapters.storage, existing.keyCipher);
    if (bytesToHex(cur) === c.keyHex) return { peerId: c.ownerId, idempotent: true };
    throw new DmError('key_conflict', '已有该好友的会话，本版本不支持更换密钥');
  }
  await o.repo.putDmKey({
    peerId: c.ownerId,
    keyCipher: await sealKeyCipher(o.adapters.storage, hexToBytes(c.keyHex)),
    createdAt: new Date().toISOString(),
  });
  return { peerId: c.ownerId, idempotent: false };
}
```

> 本 Task 尚未用到 `buildEventWire` / `submitWire` / `sealText` / `openText` 四个 import（Task 8 才用上）；`tsconfig.json` 无 `noUnusedLocals`，故 `tsc --noEmit` 仍然干净，不必删。

- [ ] **Step 4: 跑测试确认通过（绿）**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run src/core/dm.test.ts`; `npx tsc --noEmit`; `npx vitest run`
Expected: `dm.test.ts` **3 passed**（AC 1 / 2 / 8）；`tsc` 无输出；全套 **18 文件 / 152 项全绿**

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/core/dm.ts apps/mobile/src/core/dm.test.ts
git commit -m "feat(mobile): 私信好友码编解码与建友/收码（私信 §3.2、AC 1/2/8）"
```

---

### Task 8: 手机端 `core/dm.ts`（第二部分）——好友列表、发言、会话合并解密

**Files:**
- Modify: `apps/mobile/src/core/dm.test.ts`（在既有 `describe('dm', …)` 内追加 5 条用例）
- Modify: `apps/mobile/src/core/dm.ts`（import 一行；文件末尾追加第二部分）

- [ ] **Step 1: 先追加失败测试（AC 5 / 6 / 9 + 解密失败提示 + 前置校验与列表回落）**

把 `dm.test.ts` 的 import 块改为（新增 3 行、扩 2 行）：

```ts
import { describe, expect, it } from 'vitest';

import { bytesToHex, canonicalize, hexToBytes, openWithNonce, sign, utf8 } from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, MemoryStorage } from './fakes';
import type { Adapters } from '../platform/adapter';
import { flushPending } from './comment';
import { deviceKek, ensureLocalIdentity, type Identity } from './identity';
import { decodeUtf8 } from './sync';
import { base64UrlToBytes, bytesToBase64Url, openKeyCipher, sealText } from './wire';
import {
  acceptFriendCode,
  createFriend,
  decodeFriendCode,
  DM_DECRYPT_FAILED_NOTICE,
  DM_KEY_MISSING_NOTICE,
  DmError,
  fetchConversation,
  listFriends,
  postDM,
  type DmOptions,
} from './dm';
```

在 `fixture()` 之后、`gateOffline` 之前插入 `json` 助手：

```ts
/** 造一个 200 JSON 响应（与 group.test.ts 同名同形）。 */
function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}
```

在 `describe('dm', …)` 的大括号内、最后一处 `});` 之前追加以下 5 条用例：

```ts
  it('AC 5：会话只合并双方的消息，第三方发给同一 peer 的条目被硬过滤', async () => {
    const a = fixture();
    const b = fixture();
    const idA = (await ensureLocalIdentity(a.storage)).id;
    const idB = (await ensureLocalIdentity(b.storage)).id;
    const idThird = 'c'.repeat(32);

    const made = await createFriend(a.o, idB, '阿甲');
    await acceptFriendCode(b.o, made.code);
    const key = await openKeyCipher(a.o.adapters.storage, (await a.repo.getDmKey(idB))!.keyCipher);

    // A 的收件箱：B → A 一条
    a.http.routes.set(
      `${BASE}/v1/dm/${idA}`,
      json({ events: [{ event_id: '1'.repeat(32), actor: idB, created_at: 1790000002000, payload_cid: 'cidIn' }], next_cursor: null }),
    );
    // 查 B：第三方 → B 一条（必须被过滤）+ A → B 一条
    a.http.routes.set(
      `${BASE}/v1/dm/${idB}`,
      json({
        events: [
          { event_id: '2'.repeat(32), actor: idThird, created_at: 1790000003000, payload_cid: 'cidThird' },
          { event_id: '3'.repeat(32), actor: idA, created_at: 1790000001000, payload_cid: 'cidOut' },
        ],
        next_cursor: null,
      }),
    );
    a.http.routes.set(`${BASE}/v1/blob/cidIn`, { status: 200, body: utf8(sealText(key, '在吗')) });
    a.http.routes.set(`${BASE}/v1/blob/cidOut`, { status: 200, body: utf8(sealText(key, '在的')) });
    a.http.routes.set(`${BASE}/v1/blob/cidThird`, { status: 200, body: utf8(sealText(key, '不该出现')) });

    const convo = await fetchConversation(a.o, idB);
    // 第三方条目被丢弃，只留 A ↔ B 两条，按 created_at 升序
    expect(convo.messages.map((m) => m.eventId)).toEqual(['3'.repeat(32), '1'.repeat(32)]);
    expect(convo.messages.map((m) => m.text)).toEqual(['在的', '在吗']);
    expect(convo.messages.map((m) => m.mine)).toEqual([true, false]);
    expect(convo.notice).toBe('');
    expect(JSON.stringify(convo)).not.toContain('不该出现');
  });

  it('AC 6：断网发言入队，联网后仅补发一条；wire 含 dm.v1、不含明文', async () => {
    const a = fixture();
    await ensureLocalIdentity(a.storage);
    const idB = 'b'.repeat(32);
    await createFriend(a.o, idB, '阿乙');
    const gate = gateOffline(a.o);

    const sent = await postDM(a.o, idB, '睡前读一段');
    expect(sent.queued).toBe(true);
    const rows = await a.repo.listCommentOut();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetId).toBe(`dm/${idB}`);
    expect(rows[0]!.wire).toContain('dm.v1');
    expect(rows[0]!.wire).not.toContain('睡前读一段'); // 明文不进 wire，只进 text_cipher

    gate.offline = false;
    a.http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    a.http.postRoutes.set(`${BASE}/v1/event`, json({ event_id: 'ignored', payload_cid: 'c'.repeat(32) }));

    const first = await flushPending(a.o);
    expect(first.sent).toBe(1);
    expect(await a.repo.listCommentOut()).toHaveLength(0);

    const second = await flushPending(a.o);
    expect(second.sent).toBe(0);
    expect(a.http.posted.filter((p) => p.url.endsWith('/v1/event'))).toHaveLength(1);
  });

  it('AC 9：本地无该 peer 密钥时显示索取提示、不显示密文原文', async () => {
    const a = fixture();
    const idA = (await ensureLocalIdentity(a.storage)).id;
    const idB = 'b'.repeat(32);
    // 没有任何好友关系（dm_keys 为空），但收件箱里有 B 发来的密文
    a.http.routes.set(
      `${BASE}/v1/dm/${idA}`,
      json({ events: [{ event_id: '1'.repeat(32), actor: idB, created_at: 1790000000000, payload_cid: 'cidX' }], next_cursor: null }),
    );
    a.http.routes.set(`${BASE}/v1/dm/${idB}`, json({ events: [], next_cursor: null }));
    a.http.routes.set(`${BASE}/v1/blob/cidX`, { status: 200, body: utf8('不可能解开的密文') });

    const convo = await fetchConversation(a.o, idB);
    expect(convo.messages).toHaveLength(1);
    expect(convo.messages[0]!.text).toBeNull();
    expect(convo.notice).toBe(DM_KEY_MISSING_NOTICE);
    expect(JSON.stringify(convo)).not.toContain('不可能'); // 密文原文永不进界面
  });

  it('解密失败：密钥在但认证失败 → 原位提示、不显示载荷', async () => {
    const a = fixture();
    const b = fixture();
    const idA = (await ensureLocalIdentity(a.storage)).id;
    const idB = (await ensureLocalIdentity(b.storage)).id;
    const made = await createFriend(a.o, idB, '阿甲');
    await acceptFriendCode(b.o, made.code);

    const wrong = sealText(hexToBytes('aa'.repeat(32)), '不该出现');
    a.http.routes.set(
      `${BASE}/v1/dm/${idA}`,
      json({ events: [{ event_id: '1'.repeat(32), actor: idB, created_at: 1790000000000, payload_cid: 'cidBad' }], next_cursor: null }),
    );
    a.http.routes.set(`${BASE}/v1/dm/${idB}`, json({ events: [], next_cursor: null }));
    a.http.routes.set(`${BASE}/v1/blob/cidBad`, { status: 200, body: utf8(wrong) });

    const convo = await fetchConversation(a.o, idB);
    expect(convo.messages[0]!.text).toBeNull();
    expect(convo.notice).toBe(DM_DECRYPT_FAILED_NOTICE);
    expect(JSON.stringify(convo)).not.toContain('不该出现');
  });

  it('发言前置校验：非 32 hex / 空明文 / 超 4096 字节 / 无密钥各自被拒，且均不入队', async () => {
    const a = fixture();
    await ensureLocalIdentity(a.storage);
    const idB = 'b'.repeat(32);

    await expectDmError(postDM(a.o, 'zz', '在吗'), 'client');
    await expectDmError(postDM(a.o, idB, ''), 'client');
    await expectDmError(postDM(a.o, idB, '好'.repeat(4096)), 'too_long'); // 3 字节/字 ⇒ 12288 > 4096
    await expectDmError(postDM(a.o, idB, '在吗'), 'not_friend'); // 尚未交换好友码

    expect(await a.repo.listCommentOut()).toHaveLength(0); // 全部在入队前拦下
  });

  it('listFriends：本地好友与收件箱发件人取并集；拉收件箱失败时静默回落为仅本地好友', async () => {
    const a = fixture();
    const idA = (await ensureLocalIdentity(a.storage)).id;
    const idB = 'b'.repeat(32);
    const idC = 'c'.repeat(32);
    await createFriend(a.o, idB, '阿甲');

    a.http.routes.set(
      `${BASE}/v1/dm/${idA}`,
      json({
        events: [
          { event_id: '1'.repeat(32), actor: idC, created_at: 1790000000000, payload_cid: 'c1' },
          { event_id: '2'.repeat(32), actor: idB, created_at: 1790000001000, payload_cid: 'c2' },
        ],
        next_cursor: null,
      }),
    );
    expect(await listFriends(a.o)).toEqual([
      { peerId: idB, hasKey: true },
      { peerId: idC, hasKey: false },
    ]);

    // 节点不可达 → 静默回落为仅本地好友，不抛错
    a.o.adapters.http = { get: () => Promise.reject(new Error('断网')), post: () => Promise.reject(new Error('断网')) };
    expect(await listFriends(a.o)).toEqual([{ peerId: idB, hasKey: true }]);
  });
```

- [ ] **Step 2: 跑测试确认失败（红）**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run src/core/dm.test.ts`
Expected: 4 条新用例收集/运行失败 → `TypeError: fetchConversation is not a function` / `listFriends is not a function` / `postDM is not a function`（第二部分函数尚未导出）；另 `DM_KEY_MISSING_NOTICE` / `DM_DECRYPT_FAILED_NOTICE` 已导出故不报「undefined」。

- [ ] **Step 3: 追加 `core/dm.ts` 第二部分**

① 把 import 段的 identity 一行改为：

```ts
import { ensureLocalIdentity, peekLocalIdentity, type Identity } from './identity';
```

② 在文件末尾追加：

```ts
export interface FriendEntry {
  peerId: string;
  /** 本地是否有会话密钥（false = 只在收件箱见过来信，还没交换好友码）。 */
  hasKey: boolean;
}

export interface DmIndexItem {
  eventId: string;
  actor: string;
  createdAt: number;
  payloadCid: string;
}

interface DmIndexPage {
  events: DmIndexItem[];
  nextCursor: string | null;
}

/** 匿名读一人的收件箱索引（册子 §4.2）：`GET /v1/dm/{peer_id}`。**无 404 分支**（查无数据即空数组）。 */
export async function fetchDmIndex(o: DmOptions, peerId: string, cursor?: string | null): Promise<DmIndexPage> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  let res;
  try {
    res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/dm/${peerId}${qs}`);
  } catch {
    throw new DmError('network', '无法连接节点，请稍后重试');
  }
  if (res.status !== 200) throw new DmError('server', `读取私信失败（HTTP ${res.status}）`);
  const page = JSON.parse(decodeUtf8(res.body)) as {
    events?: Array<Record<string, unknown>>;
    next_cursor?: string | null;
  };
  return {
    events: (page.events ?? []).map((e) => ({
      eventId: String(e.event_id ?? ''),
      actor: String(e.actor ?? ''),
      createdAt: Number(e.created_at ?? 0),
      payloadCid: String(e.payload_cid ?? ''),
    })),
    nextCursor: page.next_cursor ?? null,
  };
}

/** 取密文块（`GET /v1/blob/{payload_cid}`）；失败返回 null，由调用方降级为提示（密文原文永不进界面）。 */
async function fetchDmCipher(o: DmOptions, payloadCid: string): Promise<string | null> {
  try {
    const res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/blob/${payloadCid}`);
    if (res.status !== 200) return null;
    return decodeUtf8(res.body);
  } catch {
    return null;
  }
}

/**
 * 好友列表（册子 §5.2）：本地 `dm_keys`（`hasKey: true`）与收件箱发件人（`hasKey: false`）取并集。
 * **拉收件箱失败静默回落为「仅本地好友」**（「补充 6」）：一次读失败不该让整页变空。
 * 顺序：本地好友在前（按 `created_at ASC`），收件箱新增的按首次出现顺序。
 */
export async function listFriends(o: DmOptions): Promise<FriendEntry[]> {
  const rows = await o.repo.listDmKeys();
  const out: FriendEntry[] = rows.map((r) => ({ peerId: r.peerId, hasKey: true }));
  const seen = new Set(out.map((e) => e.peerId));
  const myId = (await peekLocalIdentity(o.adapters.storage))?.id ?? '';
  if (myId === '' || o.nodeBaseUrl === '') return out;
  let page: DmIndexPage;
  try {
    page = await fetchDmIndex(o, myId);
  } catch {
    return out; // 收件箱读不到（断网 / 节点不可达）→ 只列本地好友
  }
  for (const ev of page.events) {
    if (ev.actor === myId || seen.has(ev.actor)) continue;
    seen.add(ev.actor);
    out.push({ peerId: ev.actor, hasKey: false });
  }
  return out;
}

/**
 * 发一条私信（册子 §3.3）。三条前置校验都在**入队前**（不产生事件、不入队，「补充 7」）：
 * `peerId` 非 32 hex → `client`；明文为空 → `client`；超 4096 字节（UTF-8）→ `too_long`；无本地密钥 → `not_friend`。
 * 正向走不通时**只有网络不可达**才入 `comment_out`（`wire` 存已签名请求体，补发零改动复用）。
 */
export async function postDM(o: DmOptions, peerId: string, text: string): Promise<{ eventId: string; queued: boolean }> {
  if (!isIdentityId(peerId)) throw new DmError('client', '对方身份 id 形态不对');
  if (text.length === 0) throw new DmError('client', '私信内容不能为空');
  if (utf8(text).length > DM_TEXT_MAX_BYTES) throw new DmError('too_long', `单条私信不超过 ${DM_TEXT_MAX_BYTES} 字节`);
  const row = await o.repo.getDmKey(peerId);
  if (!row) throw new DmError('not_friend', '还没有与该好友建立会话，请先交换好友码');
  const key = await openKeyCipher(o.adapters.storage, row.keyCipher);
  const textCipher = sealText(key, text);
  const ident = await ensureLocalIdentity(o.adapters.storage);
  const { eventId, wire } = buildEventWire(ident, 'dm.v1', { to: peerId, text_cipher: textCipher });
  const { queued } = await submitWire(o, {
    eventId,
    wire,
    targetId: `dm/${peerId}`,
    queueText: textCipher,
  });
  return { eventId, queued };
}

export interface DmMessage {
  eventId: string;
  actor: string;
  createdAt: number;
  /** 是否我发出的（`actor === 本机 id`），供会话页左右分栏。 */
  mine: boolean;
  /** 解密成功为明文；密钥缺失或解不开为 null（**不是**空串，UI 据此显示提示而非空白）。 */
  text: string | null;
}

export interface DmConversation {
  peerId: string;
  messages: DmMessage[];
  nextCursor: string | null;
  /** 非空即为册子 §5.3 的**显式提示原文**，UI 必须原位显示（禁止静默跳过）。 */
  notice: string;
}

/**
 * 会话页数据（册子 §5.3）：合并**两个 `target_id`**——发件箱 `dm/<peer>`（只留 `actor === 我`）与
 * 收件箱 `dm/<我>`（只留 `actor === peer`），按时间升序，逐条用该 peer 的会话密钥解密。
 * **过滤是硬要求**：`dm/<peer>` 里混有第三方发给 peer 的条目，不过滤就会进入本会话（AC 5）。
 * 无密钥 → `DM_KEY_MISSING_NOTICE`；有密钥但认证失败 / 块取不到 → `DM_DECRYPT_FAILED_NOTICE`。
 */
export async function fetchConversation(o: DmOptions, peerId: string): Promise<DmConversation> {
  if (!isIdentityId(peerId)) throw new DmError('client', '对方身份 id 形态不对');
  const myId = (await ensureLocalIdentity(o.adapters.storage)).id;

  const [inbox, outbox] = await Promise.all([fetchDmIndex(o, myId), fetchDmIndex(o, peerId)]);
  const picked: DmIndexItem[] = [
    ...inbox.events.filter((e) => e.actor === peerId),
    ...outbox.events.filter((e) => e.actor === myId),
  ];
  picked.sort((a, b) => (a.createdAt === b.createdAt ? (a.eventId < b.eventId ? -1 : 1) : a.createdAt - b.createdAt));

  const row = await o.repo.getDmKey(peerId);
  let key: Uint8Array | null = null;
  if (row) {
    try {
      key = await openKeyCipher(o.adapters.storage, row.keyCipher);
    } catch {
      key = null; // 本地密钥损坏 → 与「无密钥」同处置
    }
  }

  let missingKey = false;
  let decryptFailed = false;
  const messages: DmMessage[] = [];
  for (const ev of picked) {
    let text: string | null = null;
    const cipher = ev.payloadCid ? await fetchDmCipher(o, ev.payloadCid) : null;
    if (cipher === null) {
      decryptFailed = true; // 块取不到（断网 / 块缺失）：解不开
    } else if (!key) {
      missingKey = true; // 本地没有该 peer 密钥
    } else {
      try {
        text = openText(key, cipher);
      } catch {
        decryptFailed = true; // 有密钥但认证失败（密文损坏 / 密钥不符）
      }
    }
    messages.push({ eventId: ev.eventId, actor: ev.actor, createdAt: ev.createdAt, mine: ev.actor === myId, text });
  }

  const notice = missingKey ? DM_KEY_MISSING_NOTICE : decryptFailed ? DM_DECRYPT_FAILED_NOTICE : '';
  // 翻页口径：本版不做翻页，任一方向还有更早的消息就原位提示（「补充 8」）
  const nextCursor = inbox.nextCursor ?? outbox.nextCursor ?? null;
  return { peerId, messages, nextCursor, notice };
}
```

- [ ] **Step 4: 跑测试确认通过（绿）**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run src/core/dm.test.ts`; `npx tsc --noEmit`; `npx vitest run`
Expected: `dm.test.ts` **8 passed**；`tsc` 无输出；全套 **18 文件 / 157 项全绿**

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/core/dm.ts apps/mobile/src/core/dm.test.ts
git commit -m "feat(mobile): 私信好友列表/发言/双 target_id 合并解密（私信 §5.3/§5.4、AC 5/6/9）"
```

---

### Task 9: 手机端两页 + 路由 + 「我的」入口

**Files:**
- Create: `apps/mobile/src/pages/dm/list.vue`
- Create: `apps/mobile/src/pages/dm/chat.vue`
- Modify: `apps/mobile/src/pages.json`（`pages` 数组末尾加两条）
- Modify: `apps/mobile/src/pages/mine/mine.vue`（在「治理」两组四行之后新增一组）

- [ ] **Step 1: 新建 `apps/mobile/src/pages/dm/list.vue`（会话列表 + 生成好友码 + 粘贴好友码）**

```vue
<template>
  <view class="wrap">
    <view class="bar">
      <text class="title">私信</text>
      <text class="act" @click="reload">刷新</text>
    </view>

    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <view class="acts">
      <text class="act" @click="addFriend">添加好友</text>
      <text class="act" @click="pasteCode">粘贴好友码</text>
    </view>

    <text v-if="friends.length === 0" class="empty">还没有好友。可以「添加好友」生成好友码，或粘贴伙伴给的好友码。</text>
    <navigator v-for="f in friends" :key="f.peerId" class="card" :url="'/pages/dm/chat?peerId=' + f.peerId">
      <text class="t">{{ short(f.peerId) }}</text>
      <text class="meta">{{ f.hasKey ? '已建立会话' : '未交换好友码，只读到来信' }}</text>
    </navigator>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import {
  acceptFriendCode,
  createFriend,
  listFriends,
  DmError,
  type DmOptions,
  type FriendEntry,
} from '../../core/dm';
import { bootstrap } from '../../platform';

const opts = ref<DmOptions | null>(null);
const friends = ref<FriendEntry[]>([]);
const error = ref('');
const notice = ref('');

async function load() {
  try {
    const ctx = await bootstrap();
    opts.value = { adapters: ctx.opts.adapters, repo: ctx.repo, nodeBaseUrl: ctx.opts.nodeBaseUrl };
    friends.value = await listFriends(opts.value);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function reload() {
  error.value = '';
  notice.value = '';
  await load();
}

/** 可编辑弹窗；取消返回 null。 */
function ask(title: string, placeholderText: string): Promise<string | null> {
  return new Promise((resolve) => {
    uni.showModal({
      title,
      editable: true,
      placeholderText,
      success: (res) => resolve(res.confirm ? String(res.content ?? '') : null),
      fail: () => resolve(null),
    });
  });
}

/** 添加好友：给对方的身份 id → 本地出码 → 复制给对方（全程离线、零网络，AC 1）。 */
async function addFriend() {
  if (!opts.value) return;
  error.value = '';
  notice.value = '';
  const peerId = await ask('添加好友', '粘贴对方的身份 id（32 位 hex）');
  if (peerId === null) return;
  try {
    const r = await createFriend(opts.value, peerId.trim());
    uni.setClipboardData({ data: r.code });
    notice.value = '好友码已复制，发给对方即可建立会话';
    await load();
  } catch (e) {
    error.value = e instanceof DmError ? e.message : (e as Error).message;
  }
}

/** 粘贴好友码：本地自验并入会话（全程离线、零网络）。 */
async function pasteCode() {
  if (!opts.value) return;
  error.value = '';
  notice.value = '';
  const code = await ask('粘贴好友码', '粘贴好友码');
  if (code === null || code === '') return;
  try {
    await acceptFriendCode(opts.value, code);
    notice.value = '已建立会话';
    await load();
  } catch (e) {
    error.value = e instanceof DmError ? e.message : (e as Error).message;
  }
}

function short(hex: string): string {
  return hex.slice(0, 8);
}

onShow(() => {
  void load();
});
</script>

<style>
.wrap { padding: 16px; }
.bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.title { font-size: 20px; font-weight: 600; }
.act { color: #2b6cb0; font-size: 14px; margin-right: 18px; }
.acts { display: flex; margin-bottom: 10px; }
.card { display: block; padding: 14px 0; border-bottom: 1px solid #eeeeee; }
.t { display: block; font-size: 17px; }
.meta { display: block; color: #888888; font-size: 12px; margin-top: 4px; }
.empty { display: block; color: #999999; font-size: 13px; padding: 6px 0; line-height: 1.7; }
.error { display: block; color: #c53030; font-size: 13px; margin-bottom: 8px; }
.notice { display: block; color: #b7791f; font-size: 13px; margin-bottom: 8px; }
</style>
```

- [ ] **Step 2: 新建 `apps/mobile/src/pages/dm/chat.vue`（会话页）**

```vue
<template>
  <view class="wrap">
    <view class="bar">
      <text class="title">私信 · {{ short(peerId) }}</text>
    </view>

    <!-- notice 原文：无密钥 / 解不开时必须原位告知，禁止静默跳过、禁止把密文铺到界面上 -->
    <text v-if="notice" class="notice">{{ notice }}</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="error" class="act" @click="retry">重试</text>

    <view v-if="pending.length > 0" class="pending">
      <view class="pending-bar">
        <text class="pending-title">待发送 {{ pending.length }} 条</text>
      </view>
      <view v-for="p in pending" :key="p.eventId" class="po">
        <view class="po-foot">
          <text :class="p.state === 'failed' ? 'po-reason' : 'po-state'">
            {{ p.state === 'failed' ? '发送失败：' + (p.reason || '未知原因') : '待发送' }}
          </text>
          <text class="act" @click="dropPending(p.eventId)">删除</text>
        </view>
      </view>
    </view>

    <text v-if="unconfigured" class="hint">未配置节点，暂时读不到消息</text>
    <block v-else>
      <text v-if="!error && !loading && feed.length === 0" class="hint">还没有消息</text>

      <view v-for="m in feed" :key="m.eventId" class="msg">
        <text class="msg-meta">{{ m.mine ? '我' : short(m.actor) }} · {{ rel(m.createdAt) }}</text>
        <text class="msg-text">{{ m.text ?? '（无法解密）' }}</text>
      </view>
      <text v-if="loading" class="hint">加载中…</text>
      <text v-else-if="!error && feed.length > 0 && nextCursor === null" class="hint">没有更多了</text>
      <text v-if="moreHint" class="hint">{{ moreHint }}</text>
    </block>

    <text v-if="blocked" class="blocked">{{ blocked }}</text>
    <view class="composer">
      <!-- 输入框只按「结构性不可写」禁用（canInput）；若用 canSend（含「草稿非空」）空草稿会锁死输入框 -->
      <input v-model="draft" class="input" :disabled="!canInput" placeholder="说点什么…" />
      <button size="mini" :disabled="!canSend" @click="send">{{ sending ? '发送中…' : '发送' }}</button>
    </view>
    <text v-if="tip" class="hint">{{ tip }}</text>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onReachBottom, onShow } from '@dcloudio/uni-app';

import {
  fetchConversation,
  postDM,
  DmError,
  type DmConversation,
  type DmMessage,
  type DmOptions,
} from '../../core/dm';
import { flushPending } from '../../core/comment';
import type { CommentOutRow } from '../../core/types';
import { bootstrap } from '../../platform';
import {
  UNKNOWN_FLAGS,
  canPostComment,
  postBlockedReason,
  type CapabilityFlags,
} from '../../core/selfcheck';

const opts = ref<DmOptions | null>(null);
const peerId = ref('');
const feed = ref<DmMessage[]>([]);
const nextCursor = ref<string | null>(null);
const notice = ref('');
const error = ref('');
const moreHint = ref('');
const tip = ref('');
const loading = ref(false);
const sending = ref(false);
const draft = ref('');
const unconfigured = ref(false);

/** 待发区：只显示本会话的行（按 target_id 隔离）。 */
const pending = ref<CommentOutRow[]>([]);

/** 写门控：与评论 / 小组同一条「能否写事件」的能力，不新增自检探测。 */
const caps = ref<CapabilityFlags>(UNKNOWN_FLAGS);
const blocked = computed(() => postBlockedReason(caps.value));
/** 输入框可写性：只按「结构性不可写」判断（草稿为空不禁用）。ref 在模板里自动解包，故模板只能写 `canInput`。 */
const canInput = computed(() => canPostComment(caps.value));
const canSend = computed(() => canPostComment(caps.value) && draft.value.trim() !== '' && !sending.value);

async function load() {
  try {
    const ctx = await bootstrap();
    opts.value = { adapters: ctx.opts.adapters, repo: ctx.repo, nodeBaseUrl: ctx.opts.nodeBaseUrl };
    caps.value = ctx.capabilities;
    unconfigured.value = ctx.opts.nodeBaseUrl === '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

/** 待发区只取本会话的行；密文（p.text）不渲染——对用户无意义。 */
async function loadPending() {
  if (!opts.value) return;
  const all = await opts.value.repo.listCommentOut();
  pending.value = all.filter((r) => r.targetId === `dm/${peerId.value}`);
}

/** 补发一轮并刷新：不 await 进页面（由 onShow 决定），与评论 / 小组页同一体例。 */
async function flush() {
  if (!opts.value) return;
  const r = await flushPending(opts.value);
  if (r.sent + r.failed > 0) await loadPending();
  if (r.sent > 0) await refresh();
}

async function dropPending(eventId: string) {
  if (!opts.value) return;
  await opts.value.repo.removeCommentOut(eventId);
  await loadPending();
}

function applyFeed(c: DmConversation) {
  feed.value = c.messages;
  nextCursor.value = c.nextCursor;
  notice.value = c.notice; // 非空即提示原文，原位显示
  moreHint.value = c.nextCursor === null ? '' : '更早的消息本版暂不支持翻页';
}

async function refresh() {
  if (unconfigured.value || !opts.value || peerId.value === '') return;
  loading.value = true;
  error.value = '';
  try {
    applyFeed(await fetchConversation(opts.value, peerId.value));
  } catch (e) {
    error.value = e instanceof DmError ? e.message : (e as Error).message;
    feed.value = [];
    nextCursor.value = null;
    moreHint.value = '';
  } finally {
    loading.value = false;
  }
}

/**
 * core/dm.ts 的 fetchConversation 只导出「取首页并解密」，**不接受游标**；
 * 带解密的续页需要其内部未导出的 openText。故不伪造续页：游标非空时原位说明还有更早的消息。
 */
async function loadMore() {
  if (unconfigured.value || nextCursor.value === null) return;
  moreHint.value = '更早的消息本版暂不支持翻页';
}

async function retry() {
  await refresh();
}

/** 发送：断网入队（密文进队列）；节点给了响应则失败/成功，不入队。 */
async function send() {
  if (!canSend.value || !opts.value) return;
  const text = draft.value.trim();
  sending.value = true;
  tip.value = '';
  try {
    const r = await postDM(opts.value, peerId.value, text);
    draft.value = '';
    if (r.queued) {
      tip.value = '已保存，联网后自动补发';
      await loadPending();
    } else {
      tip.value = '已发送';
      await refresh();
    }
  } catch (e) {
    tip.value = e instanceof DmError ? e.message : `发送失败：${(e as Error).message ?? String(e)}`;
  } finally {
    sending.value = false;
  }
}

function short(hex: string): string {
  return hex.slice(0, 8);
}

function rel(ms: number): string {
  const d = Date.now() - ms;
  if (!ms || d < 0) return '';
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 30 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`;
  return new Date(ms).toISOString().slice(0, 10);
}

onLoad((q) => {
  peerId.value = String(q?.peerId ?? '');
});

onShow(async () => {
  await load();
  await loadPending();
  await refresh();
  void flush(); // 不 await：补发不阻塞首屏
});

onReachBottom(() => {
  void loadMore();
});
</script>

<style>
.wrap { padding: 16px; padding-bottom: 80px; }
.bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.title { font-size: 20px; font-weight: 600; }
.act { color: #2b6cb0; font-size: 14px; }
.pending { margin-bottom: 12px; padding: 10px; background: #fffaf0; border: 1px solid #f6e05e; border-radius: 6px; }
.pending-bar { display: flex; align-items: center; justify-content: space-between; }
.pending-title { font-size: 14px; font-weight: 600; }
.po { padding: 8px 0; border-top: 1px solid #f6e05e; }
.po-foot { display: flex; align-items: center; justify-content: space-between; }
.po-state { color: #888888; font-size: 12px; }
.po-reason { color: #c05621; font-size: 12px; }
.msg { padding: 10px 0; border-bottom: 1px solid #eeeeee; }
.msg-meta { display: block; color: #888888; font-size: 12px; }
.msg-text { display: block; margin-top: 4px; font-size: 15px; line-height: 1.6; }
.hint { display: block; margin-top: 8px; color: #888888; font-size: 13px; }
.error { display: block; color: #c53030; font-size: 13px; }
.notice { display: block; margin-bottom: 8px; color: #b7791f; font-size: 13px; }
.blocked { display: block; margin-bottom: 8px; color: #c05621; font-size: 13px; }
.composer { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; padding: 8px 12px; background: #ffffff; border-top: 1px solid #eeeeee; }
.input { flex: 1; height: 36px; margin-right: 8px; padding: 0 10px; background: #f5f5f5; border-radius: 6px; font-size: 14px; }
</style>
```

- [ ] **Step 3: `pages.json` 加两条路由（`pages` 数组末尾）**

```json
    {
      "path": "pages/group/group",
      "style": { "navigationBarTitleText": "小组会话" }
    },
    {
      "path": "pages/dm/list",
      "style": { "navigationBarTitleText": "私信" }
    },
    {
      "path": "pages/dm/chat",
      "style": { "navigationBarTitleText": "私信会话" }
    }
```

> **tabBar 四 tab 一行不动**（册子 §5.5 要求不改 #15 的信息架构）。

- [ ] **Step 4: `mine.vue` 新增一组「私信」入口（在「治理」两组四行之后）**

在 `apps/mobile/src/pages/mine/mine.vue` 的 `<navigator url="/pages/contribution/contribution" class="link">我的贡献</navigator>` 之后插入：

```html
    <text class="group">私信</text>
    <navigator url="/pages/dm/list" class="link">好友与私信</navigator>
```

- [ ] **Step 5: 编译 + 两条发布前硬检查（模板内 `.value`）**

Run（cwd `e:\code\base`）:
`git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- 'apps/mobile/src/pages/*/*.vue'`
Expected: **无输出**（模板里对 ref 手写 `.value` 会让 app 端整页渲染中断，见「已核实的环境事实」的模板禁写项）。

Run（cwd `e:\code\base\apps\mobile`）: `npx tsc --noEmit`; `npm run build:h5`
Expected: `tsc` 无输出；`build:h5` 成功（两个新页被编译进产物）。

- [ ] **Step 6: 提交**

```bash
git add apps/mobile/src/pages/dm/list.vue apps/mobile/src/pages/dm/chat.vue apps/mobile/src/pages.json apps/mobile/src/pages/mine/mine.vue
git commit -m "feat(mobile): 私信会话列表页与会话页 + 路由 + 我的入口（私信 §5.5）"
```

---

### Task 10: 版本 0.10.0 / 14 + 全量门禁 + 节点部署探活 + 四步发布 + 回填

**Files:**
- Modify: `apps/mobile/src/manifest.json`（`:5-6`）
- Modify: `docs/superpowers/specs/2026-09-29-base-direct-message-design.md`（§9 第 3 条回填执行期更正）

- [ ] **Step 1: 版本号**

`apps/mobile/src/manifest.json`：`versionName` `"0.9.3"` → `"0.10.0"`，`versionCode` `"13"` → `"14"`。

- [ ] **Step 2: 全量门禁（两端）**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run`; `npx tsc --noEmit`; `npm run build:h5`; `npm run build:app`
Run（cwd `e:\code\base`）: `go build ./...`; `go vet ./...`; `go test ./...`
Expected: 移动端 **18 文件 / 157 项全绿**、`tsc` 无输出、`build:h5` 与 `build:app` 均成功；Go 三个命令全包 ok。

- [ ] **Step 3: 两条发布前硬检查**

① 模板内 `.value` 扫描（**必须无输出**）：

Run（cwd `e:\code\base`）: `git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- 'apps/mobile/src/pages/*/*.vue'`
Expected: 无输出。

② `build:app` 产物 `\.value\.value` 计数为 0：

Run（cwd `e:\code\base\apps\mobile`）:
```powershell
(Select-String -Path dist/build/app/**/*.js -Pattern '\.value\.value' -AllMatches | Measure-Object).Count
```
Expected: `0`。若 > 0，说明某个页面模板里对 ref 手写了 `.value`（**停止发布**，回到 Task 9 Step 5 定位）。

- [ ] **Step 4: 节点二进制交叉编译与两节点部署探活**（本册改了节点代码，按 #31「更正 3」的后续口径必须做）

```powershell
$env:CGO_ENABLED = "0"; $env:GOOS = "linux"; $env:GOARCH = "amd64"; go build -o based ./cmd/based
```

再 `scp` 到 `/opt/base/based.new` 与 `/opt/base-cache/based.new`，各自 `cp -p` 备份为 `based.bak-0.10.0-deploy`，替换后 `systemctl restart base` / `systemctl restart base-cache`。

探活（**两节点都要**；注意私信读接口**无 404 分支**）：

```bash
curl -sk https://127.0.0.1:443/v1/dm/00000000000000000000000000000000    # 期望 {"events":[],"next_cursor":null}（200）
curl -s  -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8083/v1/dm/00000000000000000000000000000000   # 期望 200
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1:443/v1/dm/zz                        # 期望 400（非 32 hex）
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1:443/v1/group/00000000000000000000000000000000   # 期望 404（既有读接口未回归）
```

期望：两节点 `GET /v1/dm/{32hex}` 均 **200 + 空数组**（**不是** 404——这条与 #31 的小组探活刻意不同，见「已核实的环境事实」的私信读接口无 404）；`/v1/dm/zz` → **400**；`/v1/group/{32hex}` 仍 **404**。回滚：`mv /opt/base/based.bak-0.10.0-deploy /opt/base/based && systemctl restart base`（`base-cache.service` 与 `base.service` 共用同一二进制，回滚要一起回）。

- [ ] **Step 5: 四步发布（云打包 → 上传 → 落地页改指 → `based release` 签发）**

① **云打包**：

```powershell
D:\HBuilderX\cli.exe pack --project e:\code\base\apps\mobile --platform android --android.packagename uni.app.UNI936A667 --android.androidpacktype 3
```

② **取指纹并上传**：下载 APK 另存后，`scp` 到 `/opt/appdl/base-0.10.0.apk`，远端 `sha256sum` 与本地逐字一致。

③ **落地页整页重写改指**（不做 `sed` 单行替换，会留下陈旧版本文案）：href → `./base-0.10.0.apk`，版本行 → 「版本 0.10.0（versionCode 14）· 2026-09-29 · 私信（② 加密）：加好友换码 / 双目标合并会话 / 离线发言」；远端 `grep` 复核得 `base-0.10.0.apk` / `versionCode 14`。

④ **签发**：

```bash
BASE_SIGN_KEY=… /opt/base/based release -version-name 0.10.0 -min-version-name 0.8.0 \
  -apk-url http://118.190.217.242/dl/base-0.10.0.apk -apk-file /opt/appdl/base-0.10.0.apk \
  -notes 私信②加密：加好友换码_双目标合并会话_离线发言 -out /opt/base-cache/data/release.json
```

（`-notes` 必须是无空格单 token；`-out` 必须落在**缓存节点**数据目录。）

**线上验证**：`GET /v1/release` → `version_name":"0.10.0"`、`min_version_name":"0.8.0"`、`apk_size` 与上传件一致、`notes` 中文无乱码；`HEAD http://118.190.217.242/dl/base-0.10.0.apk` → **200** 且 `Content-Length` == `apk_size`。

- [ ] **Step 6: 文档回填**

1. **册子 `docs/superpowers/specs/2026-09-29-base-direct-message-design.md` §9 第 3 条**：在 `## 0. 改版说明` 追加一节 `### 0.3 <日期> 执行期更正`，写明「本册 §0.2 两处口径对齐已随册子落盘；实施过程无进一步口径变更」；若实施中有更正，则逐条列出（体例照 #9 册子 §0.2）。
2. **`docs/README.md`**：本册（第 32 行）与并行 `#33 治理体系重规划`（第 33 行）的**登记与状态回填由主人执行**，本 Task **不代改 `docs/README.md`**（避免与并行 #33 任务的 README 改动冲突）。

- [ ] **Step 7: 提交**

```bash
git add apps/mobile/src/manifest.json docs/superpowers/specs/2026-09-29-base-direct-message-design.md
git commit -m "chore(release): 0.10.0/14 + 私信册执行期更正回填（#32 → 计划）"
git push
```

---

## 自检清单（写完计划后核过）

- [ ] 每个 Task 都是「先写失败测试 → 跑它确认失败（确切命令 + 期望失败输出）→ 最小实现（**完整代码、无省略**）→ 跑测试确认通过（期望数字）→ commit（只 add 本 Task 文件）」。
- [ ] 全文无 TBD / TODO / 「稍后补充」/ 「类似 Task N」/ 「加上适当的错误处理」/ 「为以上写测试」等占位符；函数与类型名前后一致（`ListDMEvents` / `parseDMBody` / `handleDMEvent` / `handleDMGet` / `maxDMCipherBytes` / `parseEventProjection` / `EventBlobIndex` / `buildEventWire` / `submitWire` / `sealKeyCipher` / `openKeyCipher` / `sealText` / `openText` / `bytesToBase64Url` / `base64UrlToBytes` / `encodeFriendCode` / `decodeFriendCode` / `createFriend` / `acceptFriendCode` / `listFriends` / `postDM` / `fetchConversation` / `fetchDmIndex` / `DmOptions` / `DmError` / `DmErrorCode` / `FriendCode` / `FriendEntry` / `DmKeyRow` / `DmMessage` / `DmConversation` / `DM_TEXT_MAX_BYTES` / `DM_KEY_MISSING_NOTICE` / `DM_DECRYPT_FAILED_NOTICE` / `FRIEND_CODE_INVALID_MESSAGE`）。
- [ ] `isHexN` 两侧语义已分别标注（节点 `isHexN(id,16)` = 32 hex；客户端 `isHexN(s,32)` / `isIdentityId(s)`），无互相照抄。
- [ ] 两条发布前硬检查（模板 `.value` 扫描无输出、`build:app` 产物 `\.value\.value` 计数 0）已并入 Task 9 Step 5 与 Task 10 Step 3。
- [ ] 唯一一处改已上线代码 = 抽 `core/wire.ts`（Task 5，「纯抽取、行为零变化」）；`comment.ts` 一行未动（Task 5 Step 5 复核）。
- [ ] 节点侧**零新表零新列**；手机端**只新增 `dm_keys`**；离线发言复用 `comment_out`，无新队列。

## AC 覆盖自查（AC 1–10 → Task 编号）

| AC | 内容 | 落地 Task |
|---|---|---|
| 1 | 全离线建立会话（双方 `dm_keys` 各一条且 key 相同） | Task 7（`createFriend` / `acceptFriendCode`，AC 1 用例）；Task 9 Step 1（列表页离线加好友入口）；真机 Task 10 |
| 2 | 好友码不可伪造、不可转发 | Task 7（AC 2 用例：篡改 key 拒、码转第三方因 `peer_id` 拒） |
| 3 | ② 类密文断言（节点无明文） | Task 2（`TestDMMsgStoresCipherNotPlaintext`：块内容 == 客户端密文、事件行不含密文/明文、块目录原始字节无明文）；真机 Task 10 |
| 4 | 跨节点取件解密 | Task 1（`ListDMEvents`）+ Task 3（`GET /v1/dm/{peer_id}`）+ Task 4（反熵 `parseEventProjection` + `EventBlobIndex` 纳入 `dm.v1` + 跨节点用例）；探活 Task 10 |
| 5 | 会话不掺无关条目 | Task 8（`fetchConversation` 硬过滤 + AC 5 用例） |
| 6 | 断网发言不丢、补发仅一条 | Task 8（`postDM` 入队 + `flushPending` 仅一条，AC 6 用例） |
| 7 | 节点契约校验（键集 / 长度 / `to` 形态 / 验签失败不落块） | Task 2（`TestDMContractValidation` + `TestDMSigInvalidDoesNotStoreBlob`） |
| 8 | 幂等与冲突 | Task 7（AC 8 用例：同码幂等、同 peer 不同 key 拒 `key_conflict`） |
| 9 | 无密钥降级（不暴露密文、不崩溃） | Task 8（AC 9 用例 + 解密失败用例）；Task 9 Step 2（chat.vue 原位提示） |
| 10 | 门禁全绿 | Task 10 Step 2–3（两端全量门禁 + 两条发布前硬检查） |

## 执行期更正（实施后回填）

> 实施过程中若与册子 / 本计划出现口径冲突，按「先改册子（走 `## 0. 改版说明`）→ 再改计划 → 最后改代码」的次序处理，并在本节逐条追加（体例照 `#31` 计划的「执行期更正」）。

- **更正 1（Task 5，文案级）**：`core/wire.ts` 为保持「纯抽取、行为零变化」，`openKeyCipher` / `openText` 的错误文案原样保留了 group 侧的 `'group: 组密钥密文格式损坏'` / `'group: 密文过短'` 前缀；dm 侧这两种失败都被降级为界面提示，不暴露给用户（册子 §0.4）。
- **更正 2（Task 3，实现细节）**：匿名读接口 DTO 的 `payload_cid` 直接取事件行投影列 `e.PayloadCID`（与 `GET /v1/comment` 同口径），不解析 `body_json`。
- **更正 3（Task 10 Step 3，执行方式）**：发布前硬检查①的正则，计划原文 `git grep -nE '...'` 在 PowerShell 5.1 下会因内层双引号被剥离而产生假阳性；须使用 ripgrep / `-f -` 方式执行同一正则。**检查结论本身不变（无输出）**。
- **更正 4（Task 8 / Task 10，数字偏差）**：Task 8 的用例实为 **6 条**（非计划写的 5 条），故 `dm.test.ts` 为 **9 条**、移动端全量为 **18 文件 / 158 项**（计划写的 157 是旧数）。

## 执行实况（实施后回填）

> 实施完成后逐 Task 回填「commit / 实测结论」，体例照 `#31` 计划的同名章节。

| Task | 内容 | commit | 实测结论 |
|---|---|---|---|
| 1 | 节点 store 层 `ListDMEvents`（同构 `ListGroupEvents`） | `bb15a7c` | `go build` / `go vet` / `go test ./...` 全包 ok |
| 2 | `dm.v1` 事件注册与密文落块 | `145d816` | 同上；`TestDMMsgStoresCipherNotPlaintext` / `TestDMContractValidation` / `TestDMSigInvalidDoesNotStoreBlob` 通过 |
| 3 | 匿名读 `GET /v1/dm/{peer_id}` | `9ab102f` | DTO `payload_cid` 取投影列 `e.PayloadCID`（更正 2） |
| 4 | 反熵接收侧接线（F5′ 投影还原 + F6′ 块归属） | `83d186f` | `parseEventProjection` 加 `dm.v1` 分支 + `EventBlobIndex` 纳入 `dm.v1` |
| 5 | `core/wire.ts` 抽公共件（唯一一处改已上线代码） | `e66c67e` | `tsc --noEmit` 干净；纯抽取、行为零变化；错误文案保留 group 前缀（更正 1） |
| 6 | 本地 `dm_keys` 表与 `LocalRepo` 三方法 | `e6143d3` | vitest 全绿 |
| 7 | `core/dm.ts` 好友码与建友 / 收码 | `d6f5839` | AC 1 / 2 / 8 用例通过 |
| 8 | `core/dm.ts` 好友列表、发言、会话合并解密 | `2998c72` | AC 5 / 6 / 9 用例通过；`dm.test.ts` 9 条（更正 4） |
| 9 | 两页 + 路由 + 「我的」入口 | `2de4f1c` | `pages.json` 末尾只加 **2** 条路由（`pages/dm/list` / `pages/dm/chat`），`tabBar` 四 tab 未动；模板 `.value` 扫描无输出 |
| 10 | `0.10.0` / `14` + 全量门禁 + 节点部署探活 + 四步发布 + 回填 | `33f2556` | mobile **18 文件 / 158 项全绿** + `tsc` 干净 + `build:h5` / `build:app` 通过；`go build` / `go vet` / `go test ./...` 全包 ok；两节点交叉编译部署后探活：`GET /v1/dm/{32hex}` → **200 + `{"events":[],"next_cursor":null}`**（**非** 404）、`GET /v1/dm/zz` → **400**、`GET /v1/group/{32hex}` → **404**（既有读接口未回归）；APK **27413300 字节** / sha256 `683cfed8…5fe15e`；落地页与 `/v1/release` 均改指 0.10.0、`min_version_name=0.8.0`、`HEAD /dl/base-0.10.0.apk` → **200** + 27413300 |

### 待人工验收（真机）

- AC 1 真机全离线：飞行模式下 A 出好友码、B 粘码，双方「好友与私信」列表各出现对方且可互读。
- AC 3 真机部署后翻节点 `data/base.db` 与 `data/blobs/*` 原始字节，**不出现**任何私信明文。
- AC 4 跨节点取件：A 在节点 1 发言 → B 从节点 2（缓存节点）匿名拉 `GET /v1/dm/<B id>` + 取密文块 → 解密成功。
- AC 5 第三方 C 发给 B 的消息**不出现**在 A↔B 会话页。
- AC 6 断网发送入队 → 联网自动补发仅一条（服务端该 `event_id` 只有一条）。
- AC 9 无本地密钥的来信：列表显示「未交换好友码，只读到来信」，点开会话页显示索取提示、**界面上不出现密文原文**。
- 好友码的复制（`uni.setClipboardData`）与粘贴（`showModal` 的 `editable`）；粘贴组邀请码到私信页（反之亦然）必须被统一文案拒绝。
- 会话页待发区**不显示密文**、只显示状态与删除；模板 `\.value` 两条硬检查在真机包上零残留。