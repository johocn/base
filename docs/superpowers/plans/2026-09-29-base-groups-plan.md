# base 学习小组（② 加密）实施计划（B 主线 第 9 册 · #9 → 计划 #31）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `executing-plans` 逐 Task 执行。每个 Task 完成后做一次两阶段复核（① 对着册子核「做了什么 / 有没有少」；② 对着代码核「写的和计划是否一致」），通过后再进入下一个 Task。步骤用 `- [ ]` 复选框跟踪。

**Goal**：把 #9 册子落地为——节点侧三件（`group.v1` 事件类型注册与 `msg`/`roster` 分流、`groups` 名单表与 owner 锁/epoch 单调校验、匿名读 `GET /v1/group/{group_id}`）；手机端两页（圈子 tab 改小组列表、新增会话页）与 `core/group.ts`（邀请码编解码、建组/入组、名单与轮换、发言编排、读索引 + 解密密文）、本地两张表 `groups` / `group_keys`；离线发言**原样复用** `comment_out` 队列。

**Architecture**：② 类密文只作为 `group.v1` 的 `action=msg` 的一部分进入节点（**不新开 blob 上传面**）；节点从不解密、不索引明文；节点侧唯一新状态是 `groups(group_id, creator_id, epoch, member_ids_json, event_id, updated_at)`（只含 id 列表与 epoch）。手机端纯逻辑落 `apps/mobile/src/core/group.ts`（不 import `uni`/`plus`，配 vitest），页面只做渲染与跳转；密码学**零新代码**（复用 `sealWithNonce`/`openWithNonce` + `deviceKek()`，`kek_source='device'`）。

**Tech Stack**：Go 1.25 + 纯 Go SQLite（`modernc.org/sqlite`，无 CGO）；TypeScript + Vue 3 + uni-app；`@base/protocol-ts`（`canonicalize` / `blobId` / `sign` / `verify` / `deriveIdentityId` / `sealWithNonce` / `openWithNonce`）；测试 vitest + `go test`。

**上游 spec**：`docs/superpowers/specs/2026-09-29-base-groups-design.md`（**唯一契约来源**）。与册子冲突时以册子为准；要改口径先改册子（走 `## 0. 改版说明`），并在本计划追加「执行期更正」。

**基线**：`e:\code\base` HEAD = `fb4fed1`；工作区仅 `.gitignore` 未提交（**属其它任务，本计划一律不碰**）。移动端实测 `npx vitest run`（cwd `apps/mobile`）= **16 文件 / 142 项全绿**。

---

## 已核实的环境事实（勿再验证）

### 册子 §2 的四处缺口（复核一致）

| # | 事实 | 位置 |
|---|---|---|
| G1 | 事件类型表只有 `comment.v1` | `internal/httpapi/event.go:25-27` 的 `eventTypeRegistry` |
| G2 | 无客户端 → 节点 blob 上传面，`/v1/blob/{id}` 只有 GET / HEAD | `internal/httpapi/server.go:107-108` |
| G3 | `ListComments` 硬编码 `type='comment.v1'` | `internal/store/comment.go:27` |
| G4 | `handleEventSync` 不按 type 过滤（只 `ListEventsAfter`） | `internal/httpapi/peer.go:262` |

### 开工前新发现的两处缺口（册子未列，本计划必须补，见「补充 1」）

| # | 事实 | 位置 | 后果 |
|---|---|---|---|
| F5 | 反熵**接收侧**靠 `parseCommentProjection` 从 `body_json` 还原投影列；非 `comment.v1` 一律返回零值 | `internal/peersync/eventsync.go:190-204`（调用点 `:90-96`） | 小组事件搬到对端后 `target_id` 为空 → `GET /v1/group/{id}` 在接收节点上查不到（AC 4 不成立） |
| F6 | 块归属索引只认 `type='comment.v1'` | `internal/store/comment.go:68-87`（`CommentBlobIndex`），被 `peersync/sync.go:40` 与 `peersync/scrub.go:78` 经 `ownershipIndex` 使用 | ② 类密文块在缓存节点上**无归属** → 反熵拉不下来（AC 4 取不到密文），scrub 还会把它当孤儿删掉 |

### 其它必须知道的事实

| 事实 | 值 |
|---|---|
| 本机 shell | Windows PowerShell 5.1，**不支持 `&&`、不支持 heredoc**；多命令用 `;` 分行；commit message 写临时文件后 `git commit -F`，用完删除（git 在 `e:\Git\cmd\git.exe`） |
| 中文读取 | 必须 `[System.IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)`；`Select-String` 直接读会乱码 |
| 单连接 | `internal/store/store.go` 有 `SetMaxOpenConns(1)`：**游标未关闭时嵌套查询会死锁**。新写的 store 方法必须「先读完/读完即 Close，再发下一条语句」（参照 `ListComments` 的写法） |
| `Event` 结构 | `internal/store/event.go:11-21`：`EventID/ID/Type/BodyJSON/CreatedAt/ReceivedAt/TargetID/PayloadCID/ReplyTo`；`PutEvent`（`:25`）同 `event_id` 覆盖、`received_at` 保留首次值；`GetEventByID`（`:80`）、`ListEventsAfter`（`:93`） |
| 验签管线 | `internal/httpapi/event.go:91-136` 的 6 步：严格键集校验 body → `Canonicalize({event_id,type,created_at,body})` → `LookupIdentity(actor)` → `protocol.Verify` → 墓碑 → 落块；**新类型照抄这段，不要另写验签** |
| `parseCommentBody` 的关键取舍 | `internal/httpapi/event.go:183-219`：返回**客户端原始键集**的 map（缺 `reply_to` 不补空串），重建的待验字节必须与客户端所签一致；未知键即拒 |
| 错误响应形状 | `writeAuthErr` → `{"error":…,"code":…}`；`writeError` → `{"error":…}`（**无 `code`**）。客户端只读 `code` |
| 身份 id | `sha256(公钥原始 32 字节)[0:32]` = **32 hex**（`packages/protocol-ts/src/identity.ts:14-20`，`isIdentityId` 在 `:23`）；节点侧 `protocol.IdentityID` |
| `event_id` / `group_id` 形态 | 16 hex（`isHexN(id, 16)`）；`reply_to` 指向 `event_id`，同为 16 hex |
| `validTargetID` | `internal/httpapi/event.go:222-231`：ASCII、1..256 字节 → `group/<id>` 天然可用 |
| 手机端建表机制 | `core/repo.ts:77-108` 的 `SCHEMA_SQL`，由 `platform/index.ts` 的 `bootstrap()` 逐条 `db.execute`，`CREATE TABLE IF NOT EXISTS` 幂等，**无版本号** → 新表只追加，不写迁移 |
| 手机端无 group 代码 | `apps/mobile/src/` 全目录 grep `group` 只命中课程树/自检等无关串；本地**没有** `groups` 表（册子 §5.1 写的「替换单密钥形态」实为新建，见「补充 6」） |
| `LocalRepo` 已有方法 | `core/repo.ts:18-74`；`comment_out` 的 4 个方法与 `my_submissions` 的 6 个方法都在，命名体例可照抄 |
| 离线队列真相 | `core/repo.ts:95-98`：`comment_out(event_id, target_id, text, reply_to, wire, state, reason, queued_at)`，`wire` 存**整个已签名请求体**；`core/comment.ts:296-326` 的 `runFlush` 逐条**按 `wire` 重放**，节点按 `type` 分流 → 小组发言与 roster 事件**零改动复用** |
| 补发入口可跨模块用 | `core/comment.ts:282` 的 `flushPending(o)` 只依赖 `{adapters, repo, nodeBaseUrl}`（`CommentOptions`），**小组页可直接 import 调用** |
| 身份获取 | `core/identity.ts`：`deviceKek`（`:69`）、`saveLocalIdentity`（`:87`）、`loadLocalIdentity`（`:111`）、`peekLocalIdentity`（`:134`）、`signRequestHeaders`（`:225`）；`core/comment.ts:83` 的 `localIdentity()` 是**私有**的、缺身份即现建 |
| 密文形态 | `nonceHex:ctHex`（`core/identity.ts:96` 原文 `${bytesToHex(nonce)}:${bytesToHex(ct)}`）——`group_keys.key_cipher` **必须同一形态**，才能复用 `openWithNonce` |
| 无 base64 工具可复用 | `bytesToBase64`/`base64ToBytes` 在 `platform/uni.ts:423-436`（依赖 `btoa`/`atob`，且该文件 import `plus`，**Node 测试里不可用**）→ 见「补充 3」 |
| 页面传参约定 | 全仓页面读 `query.itemId`（camelCase，`article.vue` / `quiz.vue`）；本计划新页统一用 `query.groupId` |
| 圈子 tab 现状 | `pages/circle/circle.vue` 全文 15 行，写「本版未开放 / 圈子需要节点支持成员名单与加密内容分发」——**本册正是兑现它**，改造成小组列表页（不改四 tab 结构） |
| 评论页体例 | `pages/comment/comment.vue`（待发区 `:19-32`、`flush()` `:145-150`、`send()` `:216-237`、样式 `:268-294`）可整段类比 |
| 写能力门控 | `core/selfcheck.ts` 导出 `canPostComment` / `postBlockedReason` / `UNKNOWN_FLAGS` / `SELFCHECK_TARGET`（`comment.vue:80-115` 的用法） |
| Go 测试基座 | `internal/httpapi/httpapi_test.go:64` 的 `newTestServer(t)`（返回 `*store.Store` + `inprocServer`，内含确定性测试密钥 `testSeed` / `testPub`）；`comment_test.go:105` 的 `doJSONMap(t, method, url, body, headers)` |
| 当前版本 | `apps/mobile/src/manifest.json` = `versionName "0.8.0"` / `versionCode "9"` → 本册发 **0.9.0 / 10** |
| 节点侧必须部署 | 本册改了节点代码（新路由 + 新事件类型 + 新表）。按上上册「更正 3」的后续口径：**发布清单必须含交叉编译 + 两个节点各备份替换 + 依次 restart + 逐个探活** |

## 对册子的补充与口径填空（已登记，实施时照此执行）

册子未写、但实施必需。1 是**缺陷级补充**（不做则 AC 4 不成立），2–9 是口径填空（均为零契约影响的细节）。全部不触碰任何线上接口形状。

1. **反熵接收侧两处接线（对应 F5 / F6）**。册子 §4.4 的「零改动」清单说的是**接口面**——`POST /v1/event-sync` 确实不按 type 过滤、`ListEventsAfter` 确实原样搬事件行，这部分零改动无异议。但接收侧还有两件既有机制必须各加一个 `group.v1` 分支，否则小组事件**搬得过去、读不出来、块也拉不下来**：
   - `peersync.parseCommentProjection`（`eventsync.go:190`）加 `group.v1` 分支，还原 `target_id = "group/" + group_id` 与 `payload_cid`/`reply_to`；
   - `store.CommentBlobIndex`（`comment.go:68`）的 SQL 放宽到 `type IN ('comment.v1','group.v1')`，命名随语义改为 `EventBlobIndex`；
   - 接收侧的 `roster` 事件要落本地 `groups` 投影（否则接收节点 `GET /v1/group/{id}` 返回 404）。
   这是册子漏列的**必然补充**，不改线上契约、不改事件传播协议。
2. **邀请码签名域的键集固定为 9 个键**（`v/group_id/target_id/name/epoch/group_key/creator_id/creator_pub/created_at`），`name` 缺省时写**空串**而不是省略——否则「同一组，有没有名字」会 canonicalize 出两种字节序，验签结果不可预期。邀请码 JSON 本体同样恒带 `name`。
3. **`text_cipher` 用 base64url**（册子 §3.4 写的是 base64）。节点只把它当**不透明字符串**（不解码、不校验字母表之外的语义），生产端与消费端都是客户端；与邀请码共用同一个编解码器可少一份代码，且免去 `+/=` 在 JSON、日志、URL 里的转义噪声。字节边界由 `sealWithNonce` 决定，与字母表无关。
4. **`roster` 事件也走 `comment_out` 队列**（断网建组 / 断网轮换）。`wire` 存整个请求体、`text` 列存**组名**（列名语义为「正文载荷」，不承诺明文——与 §5.4 对发言的处置同一口径）。册子 §5.4 只写了发言，这是同一路径的自然延伸，**零新表**。
5. **`action=msg` 不校验组是否已存在**。节点是「登记与缓存」（总纲 §1）：离线成员完全可能先发言、其名单事件后才同步到节点；要求「先有 roster 才能发言」会把节点变成裁决者，与 §1 定位相悖。册子 §4.1 的 msg 分支步骤里也确实没有这一步。
6. **本地 `groups` 表是新建，不是替换**。册子 §5.1 写「**替换**原 `groups(group_id, member_ids_json, group_key_cipher)` 的单密钥形态」，但本仓**从未实现**该表（`SCHEMA_SQL` 里没有）→ 实际是新增两行建表语句，无迁移、无历史数据、无降级路径。
7. **名单读回写口径**：会话页读成功后可把节点的 `epoch` / `member_ids` / `name` 写回本地，但**仅当节点 `epoch ≥ 本地 epoch`**。理由：续期码可以先于 roster 事件到达（用户手工粘贴的时刻不可控），无条件写回会把本地 epoch 拉回旧值。
8. **待发区对小组行不渲染密文**（密文对用户无意义）。只显示「待发送 / 发送失败：<原因>」与删除按钮，交互与评论页一致。
9. **写能力门控复用 `canPostComment` / `postBlockedReason`**，不为小组新增自检探测项（同一条「能否写事件」的能力，复制探测必然漂移）。
10. **新增 `core/identity.ts` 的 `ensureLocalIdentity(storage)`**：`comment.ts` 的 `localIdentity` 是私有的，`group.ts` 需要同一语义（缺身份就现建并落盘）。与既有 `peekLocalIdentity`（只读、不生成）成对。

---

## 文件结构

| 路径 | 动作 | 职责 |
|---|---|---|
| `internal/store/schema.go` | 修改 | 追加 `groups` 建表语句（节点侧唯一新表） |
| `internal/store/group.go` | 新建 | `GroupRoster` 行类型、`PutGroupRoster`（owner 锁 + epoch 单调）、`ForceGroupRoster`（反熵侧）、`GetGroup`、`ListGroupEvents`、两个错误哨兵 |
| `internal/store/comment.go` | 修改 | `CommentBlobIndex` → `EventBlobIndex`，SQL 纳入 `group.v1`，`ItemID` 前缀按 type 区分 |
| `internal/httpapi/event.go` | 修改 | `eventTypeRegistry` 加 `"group.v1"`；`handleEventPost` 加分支 → `s.handleGroupEvent` |
| `internal/httpapi/group.go` | 新建 | `table` 常量组、`parseGroupBody`（严格键集，按 `action` 分流）、`handleGroupEvent`、`handleGroupGet`、DTO |
| `internal/httpapi/server.go` | 修改 | 注册 `GET /v1/group/{group_id}`（匿名公开读） |
| `internal/peersync/eventsync.go` | 修改 | `parseCommentProjection` 加 `group.v1` 分支；接收侧 roster → `ForceGroupRoster` |
| `internal/peersync/sync.go` | 修改 | 改用 `EventBlobIndex`（仅改名，语义不变） |
| `internal/peersync/scrub.go` | 修改 | 同上（仅改名） |
| `internal/store/group_test.go` | 新建 | owner 锁 / epoch 单调 / Force 语义 / 分页 |
| `internal/httpapi/group_test.go` | 新建 | AC 5 / AC 6 错误码、msg 落块与不落明文（AC 3）、匿名读体例（AC 9）、msg 无组也接受 |
| `internal/peersync/eventsync_test.go` | 修改 | 加一条：group 事件跨节点后投影列与 groups 行都被还原 |
| `apps/mobile/src/core/types.ts` | 修改 | 追加 `GroupRow` / `GroupKeyRow` |
| `apps/mobile/src/core/repo.ts` | 修改 | `SCHEMA_SQL` 两张表；`LocalRepo` 5 方法；`SqlRepo` 实现 + 两个行映射函数 |
| `apps/mobile/src/core/fakes.ts` | 修改 | `MemoryRepo` 的内存实现 |
| `apps/mobile/src/core/identity.ts` | 修改 | 加 `ensureLocalIdentity(storage)`（补充 10） |
| `apps/mobile/src/core/group.ts` | 新建 | 邀请码 base64url 编解码、建组、入组/续期、名单与轮换、发言编排、读索引 + 取块解密 |
| `apps/mobile/src/core/group.test.ts` | 新建 | AC 1 / 2 / 8 / 9 / 10 + 轮换与提示 |
| `apps/mobile/src/pages/circle/circle.vue` | 重写 | 小组列表（建组出码 / 粘码入组 / 进会话） |
| `apps/mobile/src/pages/group/group.vue` | 新建 | 会话页（消息流 / 发言 / 待发区 / 成员 / 续期码） |
| `apps/mobile/src/pages.json` | 修改 | 加 `pages/group/group` 路由（tabBar 四 tab **不动**） |
| `apps/mobile/src/manifest.json` | 修改 | `0.9.0` / `10` |
| `docs/README.md` | 修改 | 第 31 行的登记**已随本计划落盘一并完成**；Task 10 只做状态回填（§3 第 31 行与第 9 行、§4 依赖图、§5 状态与下一步） |

---

### Task 1: 节点 store 层——`groups` 表、owner 锁与 epoch 单调、事件分页、块归属索引

**Files:**
- Modify: `internal/store/schema.go`
- New: `internal/store/group.go`
- Modify: `internal/store/comment.go`

- [ ] **Step 1: `schema.go` 追加 `groups` 建表语句**

加在 `profiles` 表之后（`govern_proposals` 之前），注释照仓库体例写清「为什么只有这些列」：

```go
	// groups：小组名单投影（第 9 册 §4.2）。**节点侧唯一的组状态**——
	// 只含 id 列表与 epoch，不含任何密钥、不解密任何内容（总纲 §3.1）。
	// 首个 epoch=1 的 roster 事件锁定 creator_id；后续事件必须同 actor 且 epoch 严格更大。
	// event_id 指向最新一条 roster 事件（组名 name 在它的 body_json 里，故本表不存 name）。
	`CREATE TABLE IF NOT EXISTS groups(
		group_id        TEXT PRIMARY KEY,
		creator_id      TEXT NOT NULL,
		epoch           INTEGER NOT NULL,
		member_ids_json TEXT NOT NULL,
		event_id        TEXT NOT NULL,
		updated_at      INTEGER NOT NULL
	)`,
```

- [ ] **Step 2: 新建 `internal/store/group.go`**

```go
package store

import (
	"database/sql"
	"errors"
	"time"
)

// GroupRoster 是 groups 表的一行（册子 §4.2）。
type GroupRoster struct {
	GroupID       string
	CreatorID     string
	Epoch         int64
	MemberIDsJSON string
	EventID       string
	UpdatedAt     int64
}

// 两个哨兵错误由 httpapi 映射为错误码（册子 §4.2）。
var (
	ErrGroupOwnerMismatch = errors.New("group_owner_mismatch")
	ErrGroupEpochStale    = errors.New("group_epoch_stale")
)
```

`PutGroupRoster`（写路径，**带裁决**）分三步，注意单连接不能嵌套查询：

```go
// PutGroupRoster 写/更新名单投影（册子 §4.2）：首个 roster 事件锁定 creator_id，
// 后续必须同 actor 且 epoch 严格大于当前值。校验失败**不写任何行**。
func (s *Store) PutGroupRoster(r GroupRoster) error {
	if r.UpdatedAt == 0 {
		r.UpdatedAt = time.Now().UnixMilli()
	}
	var curCreator string
	var curEpoch int64
	err := s.db.QueryRow(`SELECT creator_id,epoch FROM groups WHERE group_id=?`, r.GroupID).
		Scan(&curCreator, &curEpoch)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		_, err = s.db.Exec(`INSERT INTO groups(group_id,creator_id,epoch,member_ids_json,event_id,updated_at)
			VALUES(?,?,?,?,?,?)`,
			r.GroupID, r.CreatorID, r.Epoch, r.MemberIDsJSON, r.EventID, r.UpdatedAt)
		return err
	case err != nil:
		return err
	}
	if r.CreatorID != curCreator {
		return ErrGroupOwnerMismatch
	}
	if r.Epoch <= curEpoch {
		return ErrGroupEpochStale
	}
	// 乐观锁：WHERE epoch=? 保证并发下不会把更旧的值盖上去。
	_, err = s.db.Exec(`UPDATE groups SET epoch=?,member_ids_json=?,event_id=?,updated_at=?
		WHERE group_id=? AND epoch=?`,
		r.Epoch, r.MemberIDsJSON, r.EventID, r.UpdatedAt, r.GroupID, curEpoch)
	return err
}
```

`ForceGroupRoster`（反熵接收侧，**不裁决 owner**——对端数据是信任域内的事，且它可能没有 epoch=1 那条）：

```go
// ForceGroupRoster 反熵接收侧用的写入（册子 §4.4 的延伸）：不校验 owner（对端数据在信任域内），
// 只接受**更大的 epoch**，旧值静默忽略——与 putPeerCursor 的单调口径同族。
// 返回是否实际写入，供接收侧测试断言。
func (s *Store) ForceGroupRoster(r GroupRoster) (bool, error) {
	if r.UpdatedAt == 0 {
		r.UpdatedAt = time.Now().UnixMilli()
	}
	res, err := s.db.Exec(`INSERT INTO groups(group_id,creator_id,epoch,member_ids_json,event_id,updated_at)
		VALUES(?,?,?,?,?,?)
		ON CONFLICT(group_id) DO UPDATE SET
			epoch=excluded.epoch, member_ids_json=excluded.member_ids_json,
			event_id=excluded.event_id, updated_at=excluded.updated_at
		WHERE excluded.epoch > groups.epoch`,
		r.GroupID, r.CreatorID, r.Epoch, r.MemberIDsJSON, r.EventID, r.UpdatedAt)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
```

`GetGroup` + `ListGroupEvents`：

```go
// GetGroup 读名单投影；不存在返回 false。
func (s *Store) GetGroup(groupID string) (GroupRoster, bool, error) {
	var g GroupRoster
	err := s.db.QueryRow(`SELECT group_id,creator_id,epoch,member_ids_json,event_id,updated_at
		FROM groups WHERE group_id=?`, groupID).
		Scan(&g.GroupID, &g.CreatorID, &g.Epoch, &g.MemberIDsJSON, &g.EventID, &g.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return GroupRoster{}, false, nil
	}
	if err != nil {
		return GroupRoster{}, false, err
	}
	return g, true, nil
}

// ListGroupEvents 按 (created_at, event_id) 倒序分页读某组的 group.v1 事件（册子 §4.3）。
// 与 ListComments 同口径：事件行是唯一来源，名单事件与发言事件都在里面，
// 由调用方按 body_json 的 action 分流（发言才有 payload_cid）。
func (s *Store) ListGroupEvents(groupID string, cursorTS int64, cursorID string, limit int) ([]Event, error) {
	if limit <= 0 {
		limit = 30
	}
	q := `SELECT ` + eventColumns + ` FROM events WHERE type='group.v1' AND target_id=?`
	args := []any{"group/" + groupID}
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

- [ ] **Step 3: `comment.go` 的块归属索引纳入小组密文块（F6）**

`CommentBlobIndex` 改名为 `EventBlobIndex`，SQL 与归属前缀一起改：

```go
// EventBlobIndex 返回事件正文块 → 归属事件的映射，来源是 events.payload_cid。
// ① 类评论正文与 ② 类小组密文都挂在这里：两者都是「块被事件引用」，
// 少了归属，缓存节点永远拉不下来、scrub 还会把块当孤儿删掉（册子 §4.4）。
func (s *Store) EventBlobIndex() (map[string]BlobRef, error) {
	rows, err := s.db.Query(`SELECT type,event_id,payload_cid FROM events
		WHERE type IN ('comment.v1','group.v1') AND payload_cid IS NOT NULL AND payload_cid<>''`)
	...
	prefix := "comment:"
	if typ == "group.v1" {
		prefix = "group:"
	}
	out[cid] = BlobRef{BlobID: cid, ItemID: prefix + eventID}
}
```

- [ ] **Step 4: 改掉两处引用点**

`internal/peersync/sync.go:40` 与 `internal/peersync/scrub.go:78` 里的 `st.CommentBlobIndex()` 改为 `st.EventBlobIndex()`；`peersync/sync.go:33` 的注释同步改写（「+ 评论事件引用的正文块」→「+ 事件（评论 / 小组）引用的正文块」）。

Run（cwd `e:\code\base`）: `grep -rn "CommentBlobIndex" --include=*.go .`
Expected: 除注释外无残留引用（`internal/store/comment.go` 的新函数名除外）

- [ ] **Step 5: 编译**

Run（cwd `e:\code\base`）: `go build ./...` 然后 `go vet ./...`
Expected: 无输出

---

### Task 2: 节点事件入口——`group.v1` 类型注册与 `msg` / `roster` 分流

**Files:**
- Modify: `internal/httpapi/event.go`
- New: `internal/httpapi/group.go`

- [ ] **Step 1: `event.go` 注册类型并加分支**

```go
var eventTypeRegistry = map[string]struct{}{
	"comment.v1": {},
	"group.v1":   {},
}
```

`handleEventPost`（`:59-63`）的分流处改为：

```go
	switch req.Type {
	case "comment.v1":
		s.handleCommentEvent(w, actor, req, createdAt)
		return
	case "group.v1":
		s.handleGroupEvent(w, actor, req, createdAt)
		return
	}
	s.putBareEvent(w, actor, req, createdAt)
```

- [ ] **Step 2: 新建 `internal/httpapi/group.go` 的常量与 body 解析**

```go
package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

const (
	// maxGroupCipherBytes 是单条发言密文的字节上限（与 maxCommentBytes 同量级，
	// 明文上限由客户端自己把握；节点只看密文长度，不解密、不推断）。
	maxGroupCipherBytes = 8192
	// maxGroupMembers 是名单快照的成员数上限，防一条事件塞进超大数组。
	maxGroupMembers = 200
	// 读接口分页口径与 GET /v1/comment 逐字一致（册子 §4.3）。
	groupDefaultLimit = 30
	groupMaxLimit     = 100
)

type groupMsg struct {
	GroupID    string
	Epoch      int64
	TextCipher string
	ReplyTo    string
}

type groupRoster struct {
	GroupID   string
	Epoch     int64
	MemberIDs []string
	Name      string
}

// parseGroupBody 校验 group.v1 的 body（册子 §3.4）。返回的 map 保留**客户端原始键集**——
// 与 parseCommentBody 同一取舍：重建的待验字节必须与客户端所签一致，多一个未知键即拒。
// 两个 action 的键集互不兼容（msg 不许带 member_ids，roster 不许带 text_cipher）。
func parseGroupBody(raw json.RawMessage) (map[string]any, string, bool) {
	if len(raw) == 0 {
		return nil, "", false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, "", false
	}
	action, ok := m["action"].(string)
	if !ok {
		return nil, "", false
	}
	switch action {
	case "msg":
		for k := range m {
			switch k {
			case "group_id", "action", "epoch", "text_cipher", "reply_to":
			default:
				return nil, "", false
			}
		}
		if _, ok := parseGroupMsg(m); !ok {
			return nil, "", false
		}
	case "roster":
		for k := range m {
			switch k {
			case "group_id", "action", "epoch", "member_ids", "name":
			default:
				return nil, "", false
			}
		}
		if _, ok := parseGroupRoster(m); !ok {
			return nil, "", false
		}
	default:
		return nil, "", false
	}
	return m, action, true
}
```

`parseGroupMsg` / `parseGroupRoster` 各写一个（键存在性判断，**缺 `reply_to` 不补空串**）：

```go
func parseGroupMsg(m map[string]any) (groupMsg, bool) {
	var g groupMsg
	g.GroupID, _ = m["group_id"].(string)
	if !isHexN(g.GroupID, 16) {
		return g, false
	}
	epoch, ok := jsonInt(m["epoch"])
	if !ok || epoch < 1 {
		return g, false
	}
	g.Epoch = epoch
	g.TextCipher, ok = m["text_cipher"].(string)
	if !ok || len(g.TextCipher) == 0 || len(g.TextCipher) > maxGroupCipherBytes {
		return g, false
	}
	if v, present := m["reply_to"]; present {
		s, isStr := v.(string)
		if !isStr || !isHexN(s, 16) {
			return g, false
		}
		g.ReplyTo = s
	}
	return g, true
}
```

（`parseGroupRoster`：`group_id` 16 hex；`epoch ≥ 1`；`member_ids` 为 `[]any`、长度 1..`maxGroupMembers`、逐项 `string` 且 `isHexN(id, 32)`；`name` 若存在必须是 string 且 ≤ 64 字节。）

`jsonInt`：`json.Number` / `float64` 都要能吃（客户端 `JSON.stringify` 出的是普通数字，节点 `json.Unmarshal` 到 `any` 得到 `float64`）——写成一个 6 行的小工具，放在 `group.go` 里：

```go
// jsonInt 把 body 里的数字读成 int64。json.Unmarshal 到 any 得到 float64，
// 但经 protocol.Canonicalize 往返后可能变成 json.Number，故两者都认。
func jsonInt(v any) (int64, bool) {
	switch n := v.(type) {
	case float64:
		if n != float64(int64(n)) {
			return 0, false
		}
		return int64(n), true
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	}
	return 0, false
}
```

- [ ] **Step 3: `handleGroupEvent`——验签照抄，分支分流**

```go
// handleGroupEvent 执行册子 §4.1：校验 body → 验内容签名 → 按 action 分流。
// 与 handleCommentEvent 共用同一条验签管线；**不做墓碑检查**——② 类不可审（总纲 §12 第 9 条）。
func (s *Server) handleGroupEvent(w http.ResponseWriter, actor string, req eventReq, createdAt int64) {
	rawBody, action, ok := parseGroupBody(req.Body)
	if !ok {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	if !s.verifyEventSig(w, actor, req, rawBody) {
		return
	}
	switch action {
	case "msg":
		s.putGroupMessage(w, actor, req, rawBody, createdAt)
	case "roster":
		s.putGroupRoster(w, actor, req, rawBody, createdAt)
	}
}
```

`verifyEventSig` 是**从 `handleCommentEvent` 抽出的共用段**（`event.go:97-126` 原样搬入，不改任何判定）：

```go
// verifyEventSig 校验事件归属签名：内容签名覆盖 canonical({event_id,type,created_at,body})，
// 与请求头无关，因此事件被反熵搬到别的节点后仍可独立验签（册子 §3.4）。失败时已写好响应。
func (s *Server) verifyEventSig(w http.ResponseWriter, actor string, req eventReq, rawBody map[string]any) bool {
	signBytes, err := protocol.Canonicalize(map[string]any{
		"event_id":   req.EventID,
		"type":       req.Type,
		"created_at": req.CreatedAt,
		"body":       rawBody,
	})
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return false
	}
	if !isHexN(req.Sig, 64) {
		s.writeAuthErr(w, http.StatusForbidden, "event_sig_invalid")
		return false
	}
	it, found, err := s.st.LookupIdentity(actor)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return false
	}
	if !found {
		s.writeAuthErr(w, http.StatusForbidden, "identity_unregistered")
		return false
	}
	valid, err := protocol.Verify(it.PubKey, signBytes, req.Sig)
	if err != nil || !valid {
		s.writeAuthErr(w, http.StatusForbidden, "event_sig_invalid")
		return false
	}
	return true
}
```

- [ ] **Step 4: `msg` 分支——落块 + 减化 body_json + 落事件行**

```go
// putGroupMessage 落 ② 类密文块与事件行（册子 §3.4 A）。节点的处理到此为止：
// 不解密、不索引明文、不审核。body_json 减化为 canonical({group_id,action,epoch,payload_cid,reply_to})，
// 密文只在块里存一份（与 comment.v1 同构）。
func (s *Server) putGroupMessage(w http.ResponseWriter, actor string, req eventReq, raw map[string]any, createdAt int64) {
	g, _ := parseGroupMsg(raw)
	cipher := []byte(g.TextCipher)
	payloadCID := protocol.BlobID(cipher) // 先定密文、再算 id（总纲 §3.2）
	exist, _, err := s.st.HasBlob(payloadCID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !exist {
		// 落块必须在**验签通过之后**（与 handleCommentEvent 同一次序）
		if err := s.st.PutBlob(payloadCID, cipher, "", 0); err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	reduced := map[string]any{
		"group_id": g.GroupID, "action": "msg", "epoch": g.Epoch, "payload_cid": payloadCID,
	}
	if g.ReplyTo != "" {
		reduced["reply_to"] = g.ReplyTo
	}
	bodyJSON, err := protocol.Canonicalize(reduced)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UnixMilli()
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: actor, Type: req.Type, BodyJSON: bodyJSON,
		CreatedAt: createdAt, ReceivedAt: now,
		TargetID: "group/" + g.GroupID, PayloadCID: payloadCID, ReplyTo: g.ReplyTo,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if ev, ok, err := s.st.GetEventByID(req.EventID); err == nil && ok {
		now = ev.ReceivedAt // 同 event_id 重发时给权威值（与 comment 口径一致）
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"event_id": req.EventID, "payload_cid": payloadCID, "received_at": now,
	})
}
```

- [ ] **Step 5: `roster` 分支——名单投影 + 落事件行 + 两个错误码**

```go
// putGroupRoster 落名单投影与事件行（册子 §3.4 B）。语义是**完整快照覆盖**，不做增量合并。
// 先写投影（校验失败即返回、不留半态），再落事件行；事件行的 body_json 保留**客户端原始键集**
// （组名 name 在它里面，读接口据此回 name）。
func (s *Server) putGroupRoster(w http.ResponseWriter, actor string, req eventReq, raw map[string]any, createdAt int64) {
	r, _ := parseGroupRoster(raw)
	membersJSON, err := json.Marshal(r.MemberIDs)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.st.PutGroupRoster(store.GroupRoster{
		GroupID: r.GroupID, CreatorID: actor, Epoch: r.Epoch,
		MemberIDsJSON: string(membersJSON), EventID: req.EventID,
	}); err != nil {
		switch {
		case errors.Is(err, store.ErrGroupOwnerMismatch):
			s.writeAuthErr(w, http.StatusForbidden, "group_owner_mismatch")
		case errors.Is(err, store.ErrGroupEpochStale):
			s.writeAuthErr(w, http.StatusConflict, "group_epoch_stale")
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
		EventID: req.EventID, ID: actor, Type: req.Type, BodyJSON: bodyJSON,
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

- [ ] **Step 6: `handleCommentEvent` 改用抽出的 `verifyEventSig`**

`event.go:97-126` 那段替换为 `if !s.verifyEventSig(w, actor, req, rawBody) { return }`，其余分支（墓碑检查、落块、落事件行、响应）**一字不动**。这是纯抽取重构，`comment_test.go` 必须全绿。

Run（cwd `e:\code\base`）: `go test ./internal/httpapi/ -run TestComment -v` 然后 `go test ./internal/...`
Expected: 既有测试全绿（本次无新增测试）

- [ ] **Step 7: 提交**

```bash
git add internal/store/schema.go internal/store/group.go internal/store/comment.go internal/peersync/sync.go internal/peersync/scrub.go internal/httpapi/event.go internal/httpapi/group.go
git commit -m "feat(node): group.v1 事件类型与名单投影（学习小组 §4.1/§4.2）"
git push
```

---

### Task 3: 节点匿名读接口 `GET /v1/group/{group_id}`

**Files:**
- Modify: `internal/httpapi/group.go`
- Modify: `internal/httpapi/server.go`

- [ ] **Step 1: 注册路由**

`server.go` 的公开路由区（`GET /v1/comment` 那行之后，与匿名读同类）：

```go
	// 小组公开读（匿名，册子 §4.3）：与 GET /v1/comment 同构。
	// 代价是明确的——索引匿名可读 ⇒「谁、何时、在哪个组发言」这层元数据公开；内容仍不可读（无组密钥）。
	mux.HandleFunc("GET /v1/group/{group_id}", s.handleGroupGet)
```

- [ ] **Step 2: DTO 与 handler**

```go
type groupDTO struct {
	GroupID   string   `json:"group_id"`
	CreatorID string   `json:"creator_id"`
	Epoch     int64    `json:"epoch"`
	MemberIDs []string `json:"member_ids"`
	Name      string   `json:"name"`
}

type groupEventDTO struct {
	EventID    string  `json:"event_id"`
	Actor      string  `json:"actor"`
	CreatedAt  int64   `json:"created_at"`
	PayloadCID string  `json:"payload_cid"`
	Epoch      int64   `json:"epoch"`
	Action     string  `json:"action"`
	ReplyTo    *string `json:"reply_to"`
}

type groupResponse struct {
	Group      groupDTO        `json:"group"`
	Events     []groupEventDTO `json:"events"`
	NextCursor *string         `json:"next_cursor"`
}

// handleGroupGet 匿名分页读小组索引与当前名单（册子 §4.3）。
// 正文一律另取 GET /v1/blob/{payload_cid}（密文，节点不解释）。
func (s *Server) handleGroupGet(w http.ResponseWriter, r *http.Request) {
	groupID := r.PathValue("group_id")
	if !isHexN(groupID, 16) {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	g, found, err := s.st.GetGroup(groupID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !found {
		// 尚无任何 roster 事件（册子 §4.3）
		s.writeError(w, http.StatusNotFound, "group_not_found")
		return
	}
	q := r.URL.Query()
	limit := groupDefaultLimit
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= groupMaxLimit {
			limit = n
		}
	}
	curTS, curID := parseCommentCursor(q.Get("cursor")) // 同一套不透明游标 <created_at>_<event_id>
	rows, err := s.st.ListGroupEvents(groupID, curTS, curID, limit)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := groupResponse{
		Group:  groupDTO{GroupID: g.GroupID, CreatorID: g.CreatorID, Epoch: g.Epoch, MemberIDs: []string{}, Name: groupName(s, g.EventID)},
		Events: []groupEventDTO{},
	}
	if err := json.Unmarshal([]byte(g.MemberIDsJSON), &resp.Group.MemberIDs); err != nil {
		resp.Group.MemberIDs = []string{} // 投影损坏不该让整页 500：名单退化为空
	}
	for _, e := range rows {
		// 名单事件不进会话流（已由 group 字段表达），只列 action=msg
		var b struct {
			Action     string `json:"action"`
			Epoch      int64  `json:"epoch"`
			PayloadCID string `json:"payload_cid"`
			ReplyTo    string `json:"reply_to"`
		}
		if err := json.Unmarshal([]byte(e.BodyJSON), &b); err != nil || b.Action != "msg" {
			continue
		}
		dto := groupEventDTO{
			EventID: e.EventID, Actor: e.ID, CreatedAt: e.CreatedAt,
			PayloadCID: b.PayloadCID, Epoch: b.Epoch, Action: b.Action,
		}
		if b.ReplyTo != "" {
			reply := b.ReplyTo
			dto.ReplyTo = &reply
		}
		resp.Events = append(resp.Events, dto)
	}
	// 满页才给游标：与 GET /v1/comment 同口径
	if len(rows) == limit {
		last := rows[len(rows)-1]
		next := strconv.FormatInt(last.CreatedAt, 10) + "_" + last.EventID
		resp.NextCursor = &next
	}
	s.writeJSON(w, http.StatusOK, resp)
}

// groupName 从最新一条 roster 事件的 body_json 里取组名；事件缺失或没名字一律空串。
// 为什么绕这一下：groups 表刻意不存 name（它只是「名单 + epoch」的投影），
// 组名是客户端内容，留在事件的原始 body 里。
func groupName(s *Server, eventID string) string {
	ev, ok, err := s.st.GetEventByID(eventID)
	if err != nil || !ok {
		return ""
	}
	var b struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal([]byte(ev.BodyJSON), &b); err != nil {
		return ""
	}
	return b.Name
}
```

- [ ] **Step 3: 编译并跑既有测试**

Run（cwd `e:\code\base`）: `go build ./...` 然后 `go test ./internal/...`
Expected: 全包 ok

---

### Task 4: 反熵接收侧接线（F5 投影还原 + roster 落表）

**Files:**
- Modify: `internal/peersync/eventsync.go`
- Modify: `internal/peersync/eventsync_test.go`

- [ ] **Step 1: `parseCommentProjection` 加 `group.v1` 分支**

`eventsync.go:190-204` 改为按 type switch：

```go
// parseEventProjection 从 body_json 还原投影列（收到的对端事件只有 body_json，
// 索引列必须在本地重建，否则读接口与块归属都会落空）。
// 非已知类型返回零值（保持原语义：不认识的事件仍然落行，只是没有索引）。
func parseEventProjection(typ, bodyJSON string) commentProjection {
	switch typ {
	case "comment.v1":
		var m struct {
			TargetID   string `json:"target_id"`
			PayloadCID string `json:"payload_cid"`
			ReplyTo    string `json:"reply_to"`
		}
		if err := json.Unmarshal([]byte(bodyJSON), &m); err != nil {
			return commentProjection{}
		}
		return commentProjection{TargetID: m.TargetID, PayloadCID: m.PayloadCID, ReplyTo: m.ReplyTo}
	case "group.v1":
		// 小组事件的减化 body 是 {group_id,action,epoch,payload_cid,reply_to}（发言）
		// 或 {group_id,action,epoch,member_ids,name}（名单）；target_id 由 group_id 拼回来。
		var m struct {
			GroupID    string `json:"group_id"`
			PayloadCID string `json:"payload_cid"`
			ReplyTo    string `json:"reply_to"`
		}
		if err := json.Unmarshal([]byte(bodyJSON), &m); err != nil || m.GroupID == "" {
			return commentProjection{}
		}
		return commentProjection{TargetID: "group/" + m.GroupID, PayloadCID: m.PayloadCID, ReplyTo: m.ReplyTo}
	default:
		return commentProjection{}
	}
}
```

调用点（`:90`）改名同步：`proj := parseEventProjection(it.Type, it.BodyJSON)`。

- [ ] **Step 2: 接收侧把 `roster` 落进本地 `groups` 投影**

在 `pullEvents` 的 `PutEvent(...)` 成功之后（`:98` 后）加：

```go
			if ok, err := applySyncedGroupEvent(st, it); err != nil {
				return total, err
			} else if ok {
				_ = ok
			}
```

```go
// applySyncedGroupEvent 把对端来的 roster 事件落进本地名单投影（册子 §4.4 的延伸）。
// 用 ForceGroupRoster：**不校验 owner**——对端数据在信任域内，且本地可能只收到 epoch>1 的名单；
// 只接受更大的 epoch，旧值静默忽略。发言事件不改变投影，直接返回。
func applySyncedGroupEvent(st *store.Store, it eventSyncItem) (bool, error) {
	if it.Type != "group.v1" {
		return false, nil
	}
	var m struct {
		GroupID   string   `json:"group_id"`
		Action    string   `json:"action"`
		Epoch     int64    `json:"epoch"`
		MemberIDs []string `json:"member_ids"`
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
	return st.ForceGroupRoster(store.GroupRoster{
		GroupID: m.GroupID, CreatorID: it.ID, Epoch: m.Epoch,
		MemberIDsJSON: string(membersJSON), EventID: it.EventID,
	})
}
```

- [ ] **Step 3: 加一条跨节点断言**

`eventsync_test.go` 末尾追加（参照 `:32-52` 的既有用例体例）：

```go
func TestGroupEventProjectionRestoredOnPeer(t *testing.T) {
	src, dst := 起两个 Store（同文件既有写法）
	// 源节点：一条 msg（body_json 减化形态，与 putGroupMessage 一致）+ 一条 roster
	// 拉一轮 SyncEvents 后断言：
	//   ① dst.GetGroup(groupID) 存在且 epoch/member_ids_json/creator_id 正确
	//   ② dst.ListGroupEvents(groupID, 0, "", 10) 里 msg 行的 target_id/payload_cid 已还原
	//   ③ dst.EventBlobIndex() 含该 payload_cid（归属 "group:<event_id>"）
}
```

- [ ] **Step 4: 跑 peersync 包**

Run（cwd `e:\code\base`）: `go test ./internal/peersync/ -v -run TestGroupEvent`
Expected: PASS

---

### Task 5: 节点侧单测（AC 3 / 5 / 6 / 9 + 读接口体例）

**Files:**
- New: `internal/store/group_test.go`
- New: `internal/httpapi/group_test.go`

- [ ] **Step 1: `store/group_test.go`（不依赖 httpapi，纯语义）**

四组用例：

| 用例 | 断言 |
|---|---|
| `TestPutGroupRosterLocksOwner` | 首写 `epoch=1` 落行；换 `CreatorID` 再写 → `ErrGroupOwnerMismatch`，且行未被修改（回读 epoch/成员仍是旧值） |
| `TestPutGroupRosterEpochMonotonic` | 同 owner 写 `epoch=3` 成功；再写 `epoch=3` / `epoch=2` → `ErrGroupEpochStale`；写 `epoch=4` 成功 |
| `TestForceGroupRosterOnlyNewer` | 空表写 `epoch=5` 落行（不校验 owner）；再 `epoch=5` / `epoch=4` → `false` 且行不变；`epoch=6` → `true` |
| `TestListGroupEventsPaging` | 造 3 条 `group.v1`（2 msg + 1 roster）与 1 条别组事件 + 1 条 `comment.v1`：不过滤时只出本组 3 条、倒序、`(created_at,event_id)` 游标取下一更旧的一页 |

- [ ] **Step 2: `httpapi/group_test.go`（端到端，AC 5 / 6 / 9 + 落块）**

复用 `newTestServer(t)` + `doJSONMap`。签名照 `comment_test.go` 的既有写法（用 `testSeed` 签 `canonical({event_id,type,created_at,body})`，再 `signRequestHeaders` 等价物——**直接抄 comment_test.go 里造签名头的那段**）。

| 用例 | 断言（对应 AC） |
|---|---|
| `TestGroupMsgStoresCipherNotPlaintext` | 发一条 `msg`（`text_cipher` = 明文 hex 的反向拼装，确保不等于明文）→ 200 且回 `payload_cid`；**节点库与块目录里 grep 不到该条明文**（AC 3）：`GetBlobBytes(payload_cid)` 等于客户端给的密文字节、`store` 的 `events.body_json` 里不含 `text_cipher` |
| `TestGroupRosterOwnerMismatch` | 身份 A 先发 `epoch=1`；身份 B 发 `epoch=2` → **403** + `code=group_owner_mismatch`（AC 5） |
| `TestGroupRosterEpochStale` | 身份 A 发 `epoch=1` 后再发 `epoch=1` → **409** + `code=group_epoch_stale`（AC 6） |
| `TestGroupUnknownKeyRejected` | `msg` 里多带一个 `member_ids` → 400 `event_param_invalid`；`roster` 里带 `text_cipher` 同理（严格键集） |
| `TestGroupGetAnonymousListing` | 无任何签名头 `GET /v1/group/{id}` → 200，`group.member_ids` 与 `group.name` 正确、`events` 只含 msg、`reply_to` 为 null/字符串两种形态都对（AC 9 的索引侧） |
| `TestGroupGetNotFound` | 未建组的 id → 404 `group_not_found` |
| `TestGroupMsgWithoutRosterAccepted` | 直接发 `msg`（无任何 roster）→ 200（补充 5 的宽松口径） |
| `TestGroupGetPagination` | 造 `limit+1` 条 → 首页满页给 `next_cursor`，第二页不满页给 null |

- [ ] **Step 3: 跑包**

Run（cwd `e:\code\base`）: `go test ./internal/store/ ./internal/httpapi/ -v -run 'Group'`
Expected: 全 PASS

- [ ] **Step 4: 全局门禁**

Run（cwd `e:\code\base`）: `go build ./...` 然后 `go vet ./...` 然后 `go test ./...`
Expected: 全包 ok

- [ ] **Step 5: 提交**

```bash
git add internal/httpapi/group.go internal/httpapi/server.go internal/peersync/eventsync.go internal/peersync/eventsync_test.go internal/store/group_test.go internal/httpapi/group_test.go
git commit -m "feat(node): 匿名读 /v1/group/{id}、反熵投影接线与节点侧单测（学习小组 §4.3/§4.4）"
git push
```

---

### Task 6: 手机端本地表与 `LocalRepo` 五方法

**Files:**
- Modify: `apps/mobile/src/core/types.ts`
- Modify: `apps/mobile/src/core/repo.ts`
- Modify: `apps/mobile/src/core/fakes.ts`

- [ ] **Step 1: `types.ts` 追加行类型**

追加在 `MySubmissionRow` 之后：

```ts
/** 我参与的小组（本地 `groups` 表，本册 §5.1）。名单是**快照**，以节点读回为准。 */
export interface GroupRow {
  /** 16 hex，与节点侧同一 id */
  groupId: string;
  /** 组名，可空串 */
  name: string;
  /** 创建者身份 id（32 hex）；轮换与续期码的签名权威 */
  creatorId: string;
  /** 当前生效 epoch（与 `group_keys.epoch` 的最大值一致） */
  epoch: number;
  /** 完整名单快照（JSON 数组文本，元素为 32 hex 身份 id） */
  memberIdsJson: string;
  /** 入组时刻 ISO8601 */
  joinedAt: string;
}

/**
 * 历次 epoch 的组密钥（本地 `group_keys` 表，本册 §5.1）。
 * `keyCipher` 是 `nonce:ct` 形态的列级密文（#4 定案：`kek_source='device'`，复用 `deviceKek()`）。
 * 保留历史 epoch 是为了解加入前的消息；**无前向安全**（册子 §7.1 风险 3）。
 */
export interface GroupKeyRow {
  groupId: string;
  epoch: number;
  keyCipher: string;
  createdAt: string;
}
```

- [ ] **Step 2: `repo.ts` 追加建表语句**

`SCHEMA_SQL` 末尾（`idx_my_submissions_queued` 之后）：

```ts
  `CREATE TABLE IF NOT EXISTS groups(
     group_id TEXT PRIMARY KEY, name TEXT NOT NULL, creator_id TEXT NOT NULL, epoch INTEGER NOT NULL,
     member_ids_json TEXT NOT NULL, joined_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS group_keys(
     group_id TEXT NOT NULL, epoch INTEGER NOT NULL, key_cipher TEXT NOT NULL, created_at TEXT NOT NULL,
     PRIMARY KEY(group_id, epoch))`,
```

- [ ] **Step 3: `LocalRepo` 加五个方法**

放在 `removeCommentOut` 之后、`saveSubmission` 之前（按册子顺序：加密小组在投稿台账之前）：

```ts
  /** 写/更新一个小组成员行（入组、续期、读回写都走它）。 */
  saveGroup(row: GroupRow): Promise<void>;
  /** 全部小组，按 `joined_at ASC`。 */
  listGroups(): Promise<GroupRow[]>;
  /** 读一组；不存在返回 null。 */
  getGroup(groupId: string): Promise<GroupRow | null>;
  /** 写一把 epoch 组密钥（同 `(group_id, epoch)` 覆盖）。epoch 大小的裁决在 `core/group.ts`，不在仓储层。 */
  putGroupKey(row: GroupKeyRow): Promise<void>;
  /** 某组的全部 epoch 密钥，按 `epoch ASC`（会话页一次取出建内存 map）。 */
  listGroupKeys(groupId: string): Promise<GroupKeyRow[]>;
```

- [ ] **Step 4: `SqlRepo` 实现 + 两个行映射**

```ts
  async saveGroup(row: GroupRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO groups(group_id,name,creator_id,epoch,member_ids_json,joined_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(group_id) DO UPDATE SET name=excluded.name,creator_id=excluded.creator_id,
         epoch=excluded.epoch,member_ids_json=excluded.member_ids_json`,
      [row.groupId, row.name, row.creatorId, row.epoch, row.memberIdsJson, row.joinedAt],
    );
  }
```

注意 `joined_at` **不在 UPDATE 列表里**（入组时刻是首次值，续期不该改它——与 `received_at` 保留首次值同一取舍）。

```ts
  async listGroups(): Promise<GroupRow[]> {
    const rows = await this.db.select(`SELECT group_id,name,creator_id,epoch,member_ids_json,joined_at FROM groups ORDER BY joined_at ASC`);
    return rows.map(toGroupRow);
  }

  async getGroup(groupId: string): Promise<GroupRow | null> {
    const rows = await this.db.select(`SELECT group_id,name,creator_id,epoch,member_ids_json,joined_at FROM groups WHERE group_id=?`, [groupId]);
    return rows.length > 0 ? toGroupRow(rows[0]) : null;
  }

  async putGroupKey(row: GroupKeyRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO group_keys(group_id,epoch,key_cipher,created_at) VALUES(?,?,?,?)
       ON CONFLICT(group_id,epoch) DO UPDATE SET key_cipher=excluded.key_cipher`,
      [row.groupId, row.epoch, row.keyCipher, row.createdAt],
    );
  }

  async listGroupKeys(groupId: string): Promise<GroupKeyRow[]> {
    const rows = await this.db.select(`SELECT group_id,epoch,key_cipher,created_at FROM group_keys WHERE group_id=? ORDER BY epoch ASC`, [groupId]);
    return rows.map(toGroupKeyRow);
  }
```

`file-private` 映射（与 `toCommentOutRow` 同区）：

```ts
function toGroupRow(r: Record<string, unknown>): GroupRow {
  return {
    groupId: String(r.group_id),
    name: String(r.name ?? ''),
    creatorId: String(r.creator_id ?? ''),
    epoch: Number(r.epoch ?? 1),
    memberIdsJson: String(r.member_ids_json ?? '[]'),
    joinedAt: String(r.joined_at ?? ''),
  };
}

function toGroupKeyRow(r: Record<string, unknown>): GroupKeyRow {
  return {
    groupId: String(r.group_id),
    epoch: Number(r.epoch),
    keyCipher: String(r.key_cipher ?? ''),
    createdAt: String(r.created_at ?? ''),
  };
}
```

- [ ] **Step 5: `fakes.ts` 的 `MemoryRepo` 实现**

```ts
  groups = new Map<string, GroupRow>(); // groupId -> row
  groupKeys = new Map<string, GroupKeyRow>(); // `${groupId}:${epoch}` -> row

  async saveGroup(row: GroupRow): Promise<void> {
    const cur = this.groups.get(row.groupId);
    // joined_at 保留首次值（与 SqlRepo 的 UPDATE 列表一致）
    this.groups.set(row.groupId, cur ? { ...row, joinedAt: cur.joinedAt } : { ...row });
  }
  async listGroups(): Promise<GroupRow[]> {
    return [...this.groups.values()].sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1 : 0));
  }
  async getGroup(groupId: string): Promise<GroupRow | null> {
    return this.groups.get(groupId) ?? null;
  }
  async putGroupKey(row: GroupKeyRow): Promise<void> {
    this.groupKeys.set(`${row.groupId}:${row.epoch}`, { ...row });
  }
  async listGroupKeys(groupId: string): Promise<GroupKeyRow[]> {
    return [...this.groupKeys.values()].filter((k) => k.groupId === groupId).sort((a, b) => a.epoch - b.epoch);
  }
```

- [ ] **Step 6: 回归（本地表只追加，不应有任何既有测试变动）**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run` 然后 `npx tsc --noEmit`
Expected: 16 文件 / 142 项全绿；`tsc` 无输出

- [ ] **Step 7: 提交**

```bash
git add apps/mobile/src/core/types.ts apps/mobile/src/core/repo.ts apps/mobile/src/core/fakes.ts
git commit -m "feat(mobile): 本地 groups / group_keys 两表与仓储五方法（学习小组 §5.1）"
git push
```

---

### Task 7: 手机端 `core/group.ts`——邀请码、建组/入组/轮换、发言、读索引解密（+ `identity.ts` 的 `ensureLocalIdentity`）

**Files:**
- Modify: `apps/mobile/src/core/identity.ts`
- New: `apps/mobile/src/core/group.ts`

- [ ] **Step 1: `identity.ts` 加 `ensureLocalIdentity`**

加在 `peekLocalIdentity`（`:134`）之后，与其「只读、不生成」成对：

```ts
/**
 * 取本机身份；不存在就现建并落盘（**写路径**需要，与 `peekLocalIdentity` 的只读语义成对）。
 * 从 `core/comment.ts` 的私有 `localIdentity()` 提上来——两处同一语义，复制必然漂移。
 */
export async function ensureLocalIdentity(storage: StorageAdapter): Promise<Identity> {
  const kek = await deviceKek(storage);
  const existing = await loadLocalIdentity(storage, kek);
  if (existing) return existing;
  const ident = createIdentity();
  await saveLocalIdentity(storage, ident, kek, 'device');
  return ident;
}
```

**不改 `comment.ts`**：它的私有 `localIdentity` 保持原样（本册不动无关文件，避免回归面扩大）。

- [ ] **Step 2: `group.ts` 头部、选项与错误类型**

```ts
/**
 * 学习小组（② 加密）：邀请码编解码、建组/入组/轮换、发言编排、读索引 + 取块解密。
 *
 * 只依赖注入的适配器 / `LocalRepo` / `core/identity`，不 import 'uni' / 'plus'，
 * 因此可在 Node 下用 `core/fakes.ts` 完整测试（与 core/comment.ts 同一约定）。
 * 密码学**零新代码**：全部经 `sealWithNonce` / `openWithNonce`（#4 定案）。
 */
import {
  bytesToHex,
  canonicalize,
  deriveIdentityId,
  hexToBytes,
  isIdentityId,
  openWithNonce,
  randomBytes,
  sealWithNonce,
  sign,
  utf8,
  verify,
  type Json,
} from '@base/protocol-ts';

import type { Adapters } from '../platform/adapter';
import type { LocalRepo } from './repo';
import type { GroupRow } from './types';
import { CommentError, sendComment } from './comment';
import { deviceKek, ensureLocalIdentity, type Identity } from './identity';
import { decodeUtf8 } from './sync';

/** 与 `CommentOptions` **同形**：这样 `flushPending`（补发）可直接喂进来，无需转换。 */
export interface GroupOptions {
  adapters: Adapters;
  repo: LocalRepo;
  nodeBaseUrl: string;
}

export type GroupErrorCode =
  | 'invite_invalid'
  | 'not_creator'
  | 'key_stale'
  | 'group_not_found'
  | 'unregistered'
  | 'rejected'
  | 'network'
  | 'server'
  | 'client';

export class GroupError extends Error {
  constructor(
    readonly code: GroupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GroupError';
  }
}

/** 移出后新消息读不出来时的**原位提示原文**（册子 §5.3 硬要求；禁止静默跳过）。 */
export const GROUP_KEY_STALE_NOTICE = '小组密钥已更新，请向创建者索取新邀请码。';

const GROUP_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
```

- [ ] **Step 3: base64url 编解码（手写，不依赖 `btoa` / `atob`）**

理由：`platform/uni.ts:423-436` 的实现依赖 `btoa`/`atob` 且该文件 import `plus`（Node 测试里不可用），App 逻辑层也没有这两个函数（补充 3）。

```ts
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function bytesToBase64Url(bytes: Uint8Array): string {
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

function base64UrlToBytes(s: string): Uint8Array {
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
```

- [ ] **Step 4: 密文原语（组密钥封装 + 正文加解密）**

```ts
/** 组密钥落 `group_keys.key_cipher`：`nonceHex:ctHex`——与 `identity.ts:96` 的私钥密文**同一形态**。 */
async function sealGroupKey(storage: Adapters['storage'], keyBytes: Uint8Array): Promise<string> {
  const kek = await deviceKek(storage);
  const nonce = randomBytes(GCM_NONCE_BYTES);
  return `${bytesToHex(nonce)}:${bytesToHex(sealWithNonce(kek, nonce, keyBytes))}`;
}

async function openGroupKey(storage: Adapters['storage'], keyCipher: string): Promise<Uint8Array> {
  const kek = await deviceKek(storage);
  const [nonceHex, ctHex] = keyCipher.split(':');
  if (!nonceHex || !ctHex) throw new Error('group: 组密钥密文格式损坏');
  return openWithNonce(kek, hexToBytes(nonceHex), hexToBytes(ctHex));
}

/** 正文加密：`base64url(nonce12 || sealWithNonce(...))`（补充 3）。 */
function sealText(key: Uint8Array, plain: string): string {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const ct = sealWithNonce(key, nonce, utf8(plain));
  const buf = new Uint8Array(nonce.length + ct.length);
  buf.set(nonce, 0);
  buf.set(ct, nonce.length);
  return bytesToBase64Url(buf);
}

/** 正文解密；密钥不对 / 密文损坏一律抛错，由调用方降级为「提示 + 占位」（册子 §5.3）。 */
function openText(key: Uint8Array, textCipher: string): string {
  const buf = base64UrlToBytes(textCipher);
  if (buf.length < GCM_NONCE_BYTES + 16) throw new Error('group: 密文过短');
  return decodeUtf8(openWithNonce(key, buf.subarray(0, GCM_NONCE_BYTES), buf.subarray(GCM_NONCE_BYTES)));
}
```

- [ ] **Step 5: 邀请码——签名域、编码、解码自验**

```ts
export interface GroupInvite {
  v: number;
  groupId: string;
  targetId: string;
  name: string;
  epoch: number;
  groupKeyHex: string;
  creatorId: string;
  creatorPubHex: string;
  createdAt: number;
  sig: string;
}

/** 签名域的 **9 个固定键**：`name` 缺省写空串（补充 2，避免同一组 canonicalize 出两种字节序）。 */
function inviteSignFields(inv: GroupInvite): Record<string, Json> {
  return {
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
}

function isHexN(s: string, n: number): boolean {
  return new RegExp(`^[0-9a-f]{${n}}$`).test(s);
}

/** 册子 §3.3：任一步失败即拒绝，**统一文案**，不区分原因（不泄漏「哪一步失败」）。 */
function invalidInvite(): GroupError {
  return new GroupError('invite_invalid', '邀请码无效或已损坏');
}

/** 编码为 `base1:` + base64url(canonical JSON)，单行可复制粘贴。 */
export function encodeInvite(inv: GroupInvite): string {
  const body: Json = { ...inviteSignFields(inv), sig: inv.sig };
  return `base1:${bytesToBase64Url(utf8(canonicalize(body)))}`;
}

/** 解码 + **离线自验**（册子 §3.3）：形态 → 自证 id → 验签名。全通过才返回。 */
export function decodeInvite(code: string): GroupInvite {
  const raw = code.trim();
  if (!raw.startsWith('base1:')) throw invalidInvite();
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(decodeUtf8(base64UrlToBytes(raw.slice('base1:'.length)))) as Record<string, unknown>;
  } catch {
    throw invalidInvite();
  }
  const inv: GroupInvite = {
    v: Number(m.v ?? 0),
    groupId: String(m.group_id ?? ''),
    targetId: String(m.target_id ?? ''),
    name: typeof m.name === 'string' ? m.name : '',
    epoch: Number(m.epoch ?? 0),
    groupKeyHex: String(m.group_key ?? ''),
    creatorId: String(m.creator_id ?? ''),
    creatorPubHex: String(m.creator_pub ?? ''),
    createdAt: Number(m.created_at ?? 0),
    sig: String(m.sig ?? ''),
  };
  if (inv.v !== 1) throw invalidInvite();
  if (!isHexN(inv.groupId, 16) || inv.targetId !== `group/${inv.groupId}`) throw invalidInvite();
  if (!isHexN(inv.groupKeyHex, 64)) throw invalidInvite();
  if (!isIdentityId(inv.creatorId) || !isHexN(inv.creatorPubHex, 64)) throw invalidInvite();
  if (!Number.isInteger(inv.epoch) || inv.epoch < 1 || !Number.isInteger(inv.createdAt)) throw invalidInvite();
  if (deriveIdentityId(inv.creatorPubHex) !== inv.creatorId) throw invalidInvite();
  if (!verify(inv.creatorPubHex, utf8(canonicalize(inviteSignFields(inv))), inv.sig)) throw invalidInvite();
  return inv;
}

/** 用创建者身份私钥对 9 个字段签名（不含 `sig` 自身）。 */
function signInvite(ident: Identity, fields: Omit<GroupInvite, 'sig'>): GroupInvite {
  const sig = sign(ident.seedHex, utf8(canonicalize(inviteSignFields({ ...fields, sig: '' }))));
  return { ...fields, sig };
}
```

- [ ] **Step 6: 入组 / 续期**

```ts
/** 把邀请码落库：写 `group_keys`（该 epoch 一把）+ `groups`（名单留待读回，补充 7）。 */
async function saveInvite(o: GroupOptions, inv: GroupInvite): Promise<GroupRow> {
  const existing = await o.repo.getGroup(inv.groupId);
  const row: GroupRow = existing ?? {
    groupId: inv.groupId,
    name: inv.name,
    creatorId: inv.creatorId,
    epoch: inv.epoch,
    memberIdsJson: '[]', // 邀请码里只有创建者，没有全体成员 → 以节点读回为准
    joinedAt: new Date().toISOString(),
  };
  await o.repo.putGroupKey({
    groupId: inv.groupId,
    epoch: inv.epoch,
    keyCipher: await sealGroupKey(o.adapters.storage, hexToBytes(inv.groupKeyHex)),
    createdAt: new Date().toISOString(),
  });
  const merged: GroupRow = { ...row, name: inv.name || row.name, creatorId: inv.creatorId, epoch: inv.epoch };
  await o.repo.saveGroup(merged);
  return merged;
}

/**
 * 粘入邀请码 / 续期码（册子 §3.3、§5.3）。**全程离线、零网络**（AC 1）。
 * 同一 epoch 视为幂等（重复粘同一张码不报错）；**比本地旧则拒绝**（否则续期码之后又粘旧码会把 epoch 拉回去）。
 */
export async function acceptInvite(o: GroupOptions, code: string): Promise<{ group: GroupRow; renewed: boolean }> {
  const inv = decodeInvite(code);
  const existing = await o.repo.getGroup(inv.groupId);
  if (existing && inv.epoch < existing.epoch) {
    throw new GroupError('key_stale', '这是旧邀请码，本地密钥已更新，无需重复入组');
  }
  const group = await saveInvite(o, inv);
  return { group, renewed: inv.epoch > (existing?.epoch ?? 0) };
}

/** 我参与的全部小组（零网络）。 */
export function listMyGroups(o: GroupOptions): Promise<GroupRow[]> {
  return o.repo.listGroups();
}
```

- [ ] **Step 7: 事件构造与「发或入队」**

```ts
/** 构造一条 `group.v1` 请求体并签名（与 `buildCommentWire` 同构，只有 type/body 不同）。 */
function buildGroupWire(ident: Identity, body: Json): { eventId: string; wire: string } {
  const eventId = bytesToHex(randomBytes(16));
  const payload: Json = { event_id: eventId, type: 'group.v1', created_at: Date.now(), body };
  const sig = sign(ident.seedHex, utf8(canonicalize(payload)));
  return { eventId, wire: JSON.stringify({ ...(payload as Record<string, Json>), sig }) };
}

/**
 * 发一条已签名组事件；**只有网络不可达**才入 `comment_out`（册子 §5.4、AC 10）。
 * 节点给了任何 HTTP 响应（4xx/5xx）都原样抛出、不入队——与 `postComment` 同一口径。
 * 复用 `sendComment`（comment.ts 的补发入口）⇒ 签名头、错误码映射、`wire` 重放全部零新代码。
 */
async function submitWire(
  o: GroupOptions,
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

/** roster 的 body：**完整名单快照**；`name` 缺省不带该键（与 `reply_to` 同处置）。 */
function rosterBody(groupId: string, epoch: number, memberIds: string[], name: string): Json {
  const body: Record<string, Json> = { group_id: groupId, action: 'roster', epoch, member_ids: [...memberIds] };
  if (name) body.name = name;
  return body;
}
```

- [ ] **Step 8: 建组与轮换**

```ts
/**
 * 建组（册子 §5.5）：本地生成 `group_id` / 组密钥 / `epoch=1` → 发首个 `roster` → 出邀请码。
 * **离线可用**：发不出去就入队（AC 1 的「A 建组出码」不依赖网络）。
 */
export async function createGroup(
  o: GroupOptions,
  opts: { name: string },
): Promise<{ group: GroupRow; inviteCode: string; queued: boolean }> {
  const ident = await ensureLocalIdentity(o.adapters.storage);
  const groupId = bytesToHex(randomBytes(8));
  const groupKeyHex = bytesToHex(randomBytes(GROUP_KEY_BYTES));
  const now = new Date().toISOString();
  const group: GroupRow = {
    groupId,
    name: opts.name,
    creatorId: ident.id,
    epoch: 1,
    memberIdsJson: JSON.stringify([ident.id]),
    joinedAt: now,
  };
  await o.repo.putGroupKey({
    groupId,
    epoch: 1,
    keyCipher: await sealGroupKey(o.adapters.storage, hexToBytes(groupKeyHex)),
    createdAt: now,
  });
  await o.repo.saveGroup(group);

  const { eventId, wire } = buildGroupWire(ident, rosterBody(groupId, 1, [ident.id], opts.name));
  const { queued } = await submitWire(o, { eventId, wire, targetId: `group/${groupId}`, queueText: opts.name });

  const inviteCode = encodeInvite(
    signInvite(ident, {
      v: 1,
      groupId,
      targetId: `group/${groupId}`,
      name: opts.name,
      epoch: 1,
      groupKeyHex,
      creatorId: ident.id,
      creatorPubHex: ident.pubHex,
      createdAt: Date.now(),
    }),
  );
  return { group, inviteCode, queued };
}

/**
 * 移出成员 / 轮换（册子 §5.3 的三步，全在创建者本地）：新密钥 → 新 epoch 的 `roster` → 新续期码。
 * **仅创建者**可调用。返回的 `inviteCode` 即**续期码**，由调用方带外发给剩余成员。
 */
export async function rotateGroup(
  o: GroupOptions,
  groupId: string,
  memberIds: string[],
): Promise<{ group: GroupRow; inviteCode: string; queued: boolean }> {
  const ident = await ensureLocalIdentity(o.adapters.storage);
  const cur = await o.repo.getGroup(groupId);
  if (!cur) throw new GroupError('group_not_found', '本地没有这个小组');
  if (cur.creatorId !== ident.id) throw new GroupError('not_creator', '只有创建者可以轮换密钥');

  const epoch = cur.epoch + 1;
  const groupKeyHex = bytesToHex(randomBytes(GROUP_KEY_BYTES));
  const now = new Date().toISOString();
  const group: GroupRow = { ...cur, epoch, memberIdsJson: JSON.stringify(memberIds) };
  await o.repo.putGroupKey({
    groupId,
    epoch,
    keyCipher: await sealGroupKey(o.adapters.storage, hexToBytes(groupKeyHex)),
    createdAt: now,
  });
  await o.repo.saveGroup(group);

  const { eventId, wire } = buildGroupWire(ident, rosterBody(groupId, epoch, memberIds, cur.name));
  const { queued } = await submitWire(o, { eventId, wire, targetId: `group/${groupId}`, queueText: cur.name });

  const inviteCode = encodeInvite(
    signInvite(ident, {
      v: 1,
      groupId,
      targetId: `group/${groupId}`,
      name: cur.name,
      epoch,
      groupKeyHex,
      creatorId: ident.id,
      creatorPubHex: ident.pubHex,
      createdAt: Date.now(),
    }),
  );
  return { group, inviteCode, queued };
}
```

- [ ] **Step 9: 发言**

```ts
/**
 * 发一条小组消息（册子 §3.4 A）：用**当前 epoch 组密钥**加密，节点负责落块。
 * 断网入队时 `text` 列存**密文**（§5.4：列名语义是「正文载荷」，不承诺明文）。
 */
export async function postGroupMessage(
  o: GroupOptions,
  input: { groupId: string; text: string; replyTo?: string },
): Promise<{ eventId: string; queued: boolean }> {
  const group = await o.repo.getGroup(input.groupId);
  if (!group) throw new GroupError('group_not_found', '还没有加入这个小组');
  const row = (await o.repo.listGroupKeys(input.groupId)).find((r) => r.epoch === group.epoch);
  if (!row) throw new GroupError('client', `本地缺少 epoch ${group.epoch} 的组密钥`);
  const key = await openGroupKey(o.adapters.storage, row.keyCipher);
  const textCipher = sealText(key, input.text);

  const body: Record<string, Json> = {
    group_id: input.groupId,
    action: 'msg',
    epoch: group.epoch,
    text_cipher: textCipher,
  };
  if (input.replyTo) body.reply_to = input.replyTo;

  const ident = await ensureLocalIdentity(o.adapters.storage);
  const { eventId, wire } = buildGroupWire(ident, body);
  const { queued } = await submitWire(o, {
    eventId,
    wire,
    targetId: `group/${input.groupId}`,
    queueText: textCipher,
  });
  return { eventId, queued };
}
```

- [ ] **Step 10: 读索引 + 取块解密（含静默失败提示）**

```ts
export interface GroupInfo {
  groupId: string;
  creatorId: string;
  epoch: number;
  memberIds: string[];
  name: string;
}

export interface GroupMessage {
  eventId: string;
  actor: string;
  createdAt: number;
  replyTo: string | null;
  epoch: number;
  payloadCid: string;
  /** 解密成功为明文；密钥缺失或解不开为 null（**不是**空串，UI 据此显示提示而非空白）。 */
  text: string | null;
}

/** 匿名读索引（册子 §4.3；与 `GET /v1/comment` 同构，只列 `action=msg`）。 */
export async function fetchGroup(
  o: GroupOptions,
  groupId: string,
  opts: { cursor?: string | null } = {},
): Promise<{ group: GroupInfo; events: GroupMessage[]; nextCursor: string | null }> {
  const qs = opts.cursor ? `?cursor=${encodeURIComponent(opts.cursor)}` : '';
  let res;
  try {
    res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/group/${groupId}${qs}`);
  } catch {
    throw new GroupError('network', '无法连接节点，请稍后重试');
  }
  if (res.status === 404) throw new GroupError('group_not_found', '该小组在节点上还没有名单');
  if (res.status !== 200) throw new GroupError('server', `读取小组失败（HTTP ${res.status}）`);
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
    },
    events,
    nextCursor: page.next_cursor ?? null,
  };
}

/**
 * 取密文块（`GET /v1/blob/{payload_cid}`）。返回**文本**而非字节：
 * 节点存的正是 `text_cipher` 字符串的 UTF-8 字节（Task 2 Step 4：`cipher := []byte(g.TextCipher)`）。
 */
async function fetchCipher(o: GroupOptions, payloadCid: string): Promise<string | null> {
  try {
    const res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/blob/${payloadCid}`);
    if (res.status !== 200) return null;
    return decodeUtf8(res.body);
  } catch {
    return null;
  }
}

export interface GroupFeed {
  group: GroupInfo;
  events: GroupMessage[];
  nextCursor: string | null;
  /** 非空即为册子 §5.3 的**显式提示原文**，UI 必须原位显示（禁止静默跳过）。 */
  notice: string;
}

/**
 * 会话页数据：读索引 → 逐条取块 → 用**该条自己的 epoch 密钥**解密（历史消息靠 `group_keys` 留档）。
 * 解密失败或被移出（本地无该 epoch 密钥）触发提示原文（册子 §5.3）。
 * 读成功后把节点名单写回本地，但**仅当节点 epoch ≥ 本地 epoch**（补充 7：续期码可能先于 roster 到达）。
 */
export async function fetchGroupMessages(o: GroupOptions, groupId: string): Promise<GroupFeed> {
  const page = await fetchGroup(o, groupId);
  const local = await o.repo.getGroup(groupId);
  const keyMap = new Map<number, Uint8Array>();
  for (const row of await o.repo.listGroupKeys(groupId)) {
    try {
      keyMap.set(row.epoch, await openGroupKey(o.adapters.storage, row.keyCipher));
    } catch {
      // 单把密钥解不开不影响其余 epoch
    }
  }
  const items: GroupMessage[] = [];
  let decryptFailed = false;
  for (const ev of page.events) {
    let text: string | null = null;
    const cipher = ev.payloadCid ? await fetchCipher(o, ev.payloadCid) : null;
    if (cipher !== null) {
      const key = keyMap.get(ev.epoch);
      if (!key) {
        decryptFailed = true; // 本地没有该 epoch 的密钥 ⇒ 被移出或还没收到续期码
      } else {
        try {
          text = openText(key, cipher);
        } catch {
          decryptFailed = true; // 有密钥但认证失败 ⇒ 密钥已轮换
        }
      }
    }
    items.push({ ...ev, text });
  }
  if (local && page.group.epoch >= local.epoch) {
    await o.repo.saveGroup({
      ...local,
      name: page.group.name || local.name,
      epoch: page.group.epoch,
      memberIdsJson: JSON.stringify(page.group.memberIds),
    });
  }
  const stale = page.group.epoch > (local?.epoch ?? 0);
  return {
    group: page.group,
    events: items,
    nextCursor: page.nextCursor,
    notice: stale || decryptFailed ? GROUP_KEY_STALE_NOTICE : '',
  };
}
```

（**取块失败**不算解密失败：它只是网络问题，`text` 同样为 null 但**不触发**提示原文——否则断网会把用户误导成「被移出」。）

- [ ] **Step 11: 类型检查（本 Task 不加测试）**

Run（cwd `e:\code\base\apps\mobile`）: `npx tsc --noEmit` 然后 `npx vitest run`
Expected: `tsc` 无输出；vitest 仍是 **16 文件 / 142 项**（新测试在 Task 8）

- [ ] **Step 12: 提交**

```bash
git add apps/mobile/src/core/group.ts apps/mobile/src/core/identity.ts
git commit -m "feat(mobile): core/group.ts 邀请码/建组/入组/轮换/发言/读索引解密（学习小组 §5.2）"
git push
```

---

### Task 8: `core/group.test.ts`——AC 1 / 2 / 8 / 9 / 10 + 轮换与提示

**Files:**
- New: `apps/mobile/src/core/group.test.ts`

- [ ] **Step 1: fixture 与两个共享 helper**

体例照 `comment.test.ts`；**四个适配器手工组装**（不用 `fakeAdapters` 的默认 storage），以便测试自己拿 `deviceKek` 解组密钥密文：

```ts
import { describe, expect, it } from 'vitest';

import { bytesToHex, hexToBytes, openWithNonce, utf8 } from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, MemoryStorage } from './fakes';
import type { Adapters } from '../platform/adapter';
import { deviceKek } from './identity';
import { CommentError, flushPending } from './comment';
import { decodeUtf8 } from './sync';
import {
  GROUP_KEY_STALE_NOTICE,
  GroupError,
  acceptInvite,
  createGroup,
  decodeInvite,
  encodeInvite,
  fetchGroupMessages,
  postGroupMessage,
  rotateGroup,
  type GroupOptions,
} from './group';

const BASE = 'https://node.test';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function fixture() {
  const http = new FakeHttp();
  const storage = new MemoryStorage();
  const repo = new MemoryRepo();
  const adapters: Adapters = { fs: new MemoryFs(), storage, http, packReader: new FakePackReader() };
  const o: GroupOptions = { adapters, repo, nodeBaseUrl: BASE };
  return { http, storage, repo, o };
}

/**
 * 可开关的「网络不可达」模拟（AC 1 / AC 8）：只挡 http，本地存储与仓储照常走。
 * 照 `comment.test.ts:48-59` 的 `gatePost` 写法——**同一个 `o` 先离线后联网**，不重建 fixture
 * （重建会丢掉 `MemoryStorage`，也就丢了本机身份与组密钥）。
 */
function gateOffline(o: GroupOptions): { offline: boolean } {
  const real = o.adapters.http;
  const state = { offline: true };
  o.adapters.http = {
    get: (url, headers) => (state.offline ? Promise.reject(new Error('断网')) : real.get(url, headers)),
    post: (url, body, headers) => (state.offline ? Promise.reject(new Error('断网')) : real.post(url, body, headers)),
  };
  return state;
}

/** 用自己的设备 KEK 解开 `group_keys.key_cipher`，回原始 32 字节 hex（AC 1 的「组密钥相同」判定）。 */
async function groupKeyHex(storage: MemoryStorage, cipher: string): Promise<string> {
  const kek = await deviceKek(storage);
  const [n, ct] = cipher.split(':');
  return bytesToHex(openWithNonce(kek, hexToBytes(n!), hexToBytes(ct!)));
}
```

- [ ] **Step 2: 用例 1（AC 1）——断网建组出码 → 另一设备断网粘码入组 → 组密钥相同**

```ts
it('AC 1：A 断网建组出码，B 断网粘码入组，双方 epoch 与组密钥一致', async () => {
  const a = fixture();
  gateOffline(a.o);
  const created = await createGroup(a.o, { name: '夜间读书' });

  expect(created.queued).toBe(true); // 断网 → roster 入队，但邀请码已可用
  expect(created.inviteCode.startsWith('base1:')).toBe(true);
  expect(created.group.groupId).toMatch(/^[0-9a-f]{16}$/);

  const b = fixture();
  gateOffline(b.o); // 入组**全程零网络**
  const joined = await acceptInvite(b.o, created.inviteCode);

  expect(joined.renewed).toBe(true);
  expect(joined.group.groupId).toBe(created.group.groupId);
  expect(joined.group.epoch).toBe(1);
  expect(joined.group.creatorId).toBe(created.group.creatorId);

  const ka = await a.repo.listGroupKeys(created.group.groupId);
  const kb = await b.repo.listGroupKeys(created.group.groupId);
  expect(kb).toHaveLength(1);
  expect(kb[0]!.epoch).toBe(ka[0]!.epoch);
  expect(await groupKeyHex(b.storage, kb[0]!.keyCipher)).toBe(await groupKeyHex(a.storage, ka[0]!.keyCipher));
});
```

- [ ] **Step 3: 用例 2（AC 2）——篡改 `group_key` / `creator_id` 一律「邀请码无效或已损坏」**

```ts
it('AC 2：篡改 group_key 任一字符 → 入组被拒，文案统一', async () => {
  const a = fixture();
  gateOffline(a.o);
  const created = await createGroup(a.o, { name: '读书' });

  const inv = decodeInvite(created.inviteCode);
  const flipped = inv.groupKeyHex[0] === 'a' ? 'b' + inv.groupKeyHex.slice(1) : 'a' + inv.groupKeyHex.slice(1);
  expect(() => decodeInvite(encodeInvite({ ...inv, groupKeyHex: flipped }))).toThrowError('邀请码无效或已损坏');

  // creator_id 与 creator_pub 不自证同样被拒（自带公钥的理由就是这一步）
  const forged = { ...inv, creatorId: inv.creatorId.slice(0, 31) + (inv.creatorId.endsWith('0') ? '1' : '0') };
  expect(() => decodeInvite(encodeInvite(forged))).toThrowError('邀请码无效或已损坏');

  // 非 base1: 前缀 / 坏 base64 也不放行
  expect(() => decodeInvite('base2:xxxx')).toThrowError('邀请码无效或已损坏');
  expect(() => decodeInvite('base1:!!!!')).toThrowError('邀请码无效或已损坏');

  const b = fixture();
  gateOffline(b.o);
  const err = await acceptInvite(b.o, encodeInvite({ ...inv, groupKeyHex: flipped })).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(GroupError);
  expect((err as GroupError).code).toBe('invite_invalid');
});
```

- [ ] **Step 4: 用例 3（AC 8 + AC 3 的客户端侧）——断网发言入队 → 联网仅补发一条**

```ts
it('AC 8：断网发言入队，联网后仅补发一条；队列行含密文不含明文', async () => {
  const a = fixture();
  const gate = gateOffline(a.o);
  const created = await createGroup(a.o, { name: '读书' });
  await a.repo.removeCommentOut((await a.repo.listCommentOut())[0]!.eventId); // 清掉 roster 行，只看发言

  const sent = await postGroupMessage(a.o, { groupId: created.group.groupId, text: '今晚九点开读' });
  expect(sent.queued).toBe(true);
  const rows = await a.repo.listCommentOut();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.targetId).toBe(`group/${created.group.groupId}`);
  expect(rows[0]!.wire).toContain('group.v1');
  expect(rows[0]!.wire).not.toContain('今晚九点开读'); // 明文不进 wire，只进 text_cipher

  // 联网：登记 + 收事件都打桩，在**同一个 o** 上补发
  gate.offline = false;
  a.http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
  a.http.postRoutes.set(`${BASE}/v1/event`, json({ event_id: 'ignored', payload_cid: 'c'.repeat(32) }));

  const first = await flushPending(a.o);
  expect(first.sent).toBe(1);
  expect(await a.repo.listCommentOut()).toHaveLength(0);

  const second = await flushPending(a.o);
  expect(second.sent).toBe(0); // 仅一条，不重复
  expect(a.http.posted.filter((p) => p.url.endsWith('/v1/event'))).toHaveLength(1);
});
```

- [ ] **Step 5: 用例 4（AC 9）——未入组者能读索引与 `member_ids`，但解不开**

```ts
it('AC 9：未入组者能列出索引与 member_ids，取到的密文解不开且触发提示', async () => {
  const a = fixture();
  a.http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
  a.http.postRoutes.set(`${BASE}/v1/event`, json({ event_id: 'ignored', payload_cid: 'c'.repeat(32) }));

  const { group } = await createGroup(a.o, { name: '读书' });
  const post = await postGroupMessage(a.o, { groupId: group.groupId, text: '九点开读' });
  const lastPost = a.http.posted[a.http.posted.length - 1]!;
  const wire = JSON.parse(decodeUtf8(lastPost.body)) as { event_id: string; body: { text_cipher: string } };

  // 节点读接口打桩：名单 = 创建者 + 自己
  a.http.routes.set(
    `${BASE}/v1/group/${group.groupId}`,
    json({
      group: { group_id: group.groupId, creator_id: group.creatorId, epoch: 1, member_ids: [group.creatorId], name: '读书' },
      events: [
        { event_id: wire.event_id, actor: group.creatorId, created_at: 1790000000000, payload_cid: post.eventId, epoch: 1, action: 'msg', reply_to: null },
      ],
      next_cursor: null,
    }),
  );
  a.http.routes.set(`${BASE}/v1/blob/${post.eventId}`, { status: 200, body: utf8(wire.body.text_cipher) });

  // A（有密钥）能读明文，且读回把名单写进本地
  const feed = await fetchGroupMessages(a.o, group.groupId);
  expect(feed.events[0]!.text).toBe('九点开读');
  expect(feed.notice).toBe('');
  expect(feed.group.memberIds).toEqual([group.creatorId]);

  // C（未入组、无密钥）能读索引与名单，但解不开——用的是**同一个节点**（桩都在 a.http 上）
  const c = fixture();
  c.o.adapters.http = a.http;
  const stranger = await fetchGroupMessages(c.o, group.groupId);
  expect(stranger.group.memberIds).toEqual([group.creatorId]);
  expect(stranger.events[0]!.text).toBeNull();
  expect(stranger.notice).toBe(GROUP_KEY_STALE_NOTICE);
});
```

（`payload_cid` 这里用 `post.eventId` 顶替——桩数据只要自洽即可；真机上 `payload_cid` 是密文块的 32 hex id。）

- [ ] **Step 6: 用例 5（AC 10）——节点 4xx 不入队**

```ts
it('AC 10：节点返回 4xx → 原地报错、comment_out 行数不变', async () => {
  const a = fixture();
  a.http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
  a.http.postRoutes.set(`${BASE}/v1/event`, { status: 403, body: utf8(JSON.stringify({ code: 'event_sig_invalid' })) });

  const { group } = await createGroup(a.o, { name: '读书' }); // roster 也被 403
  const before = (await a.repo.listCommentOut()).length;
  const err = await postGroupMessage(a.o, { groupId: group.groupId, text: 'x' }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CommentError); // 复用 comment 的错误映射（'rejected'）
  expect((err as CommentError).code).toBe('rejected');
  expect((await a.repo.listCommentOut()).length).toBe(before);
});
```

- [ ] **Step 7: 用例 6（AC 7 的自动部分）——轮换后旧密钥解不开、旧码不覆盖、非创建者不能轮换**

```ts
it('轮换：新 epoch 用新密钥；被移出者解不开并提示；旧码不覆盖本地新 epoch', async () => {
  const a = fixture();
  a.http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
  a.http.postRoutes.set(`${BASE}/v1/event`, json({ event_id: 'ignored', payload_cid: 'c'.repeat(32) }));

  const { group, inviteCode } = await createGroup(a.o, { name: '读书' });
  const b = fixture();
  const joined = await acceptInvite(b.o, inviteCode); // 入组零网络，b 不需任何桩

  // 6.1 非创建者不能轮换（b 的 creatorId 是 a 的 id，b 自己的身份不是创建者）
  const err = await rotateGroup(b.o, group.groupId, [joined.group.creatorId]).catch((e: unknown) => e);
  expect((err as GroupError).code).toBe('not_creator');

  // 6.2 创建者移出 b：新 epoch=2 + 续期码
  const rotated = await rotateGroup(a.o, group.groupId, [group.creatorId]);
  expect(rotated.group.epoch).toBe(2);
  expect((await a.repo.listGroupKeys(group.groupId)).map((k) => k.epoch)).toEqual([1, 2]);

  // 6.3 b 粘续期码 → epoch 跟进
  const renewed = await acceptInvite(b.o, rotated.inviteCode);
  expect(renewed.renewed).toBe(true);
  expect(renewed.group.epoch).toBe(2);

  // 6.4 b 再粘最初那张（epoch=1）→ 拒绝，不被拉回
  const stale = await acceptInvite(b.o, inviteCode).catch((e: unknown) => e);
  expect((stale as GroupError).code).toBe('key_stale');
  expect((await b.repo.getGroup(group.groupId))!.epoch).toBe(2);
});
```

- [ ] **Step 8: 用例 7——回复与「无 roster 也接受 msg」的客户端侧**

```ts
it('msg 的回复键只在提供时入体；本地没有组时拒绝发言', async () => {
  const a = fixture();
  gateOffline(a.o);
  const { group } = await createGroup(a.o, { name: '读书' });

  await postGroupMessage(a.o, { groupId: group.groupId, text: '甲', replyTo: 'f'.repeat(16) });
  const rows = await a.repo.listCommentOut();
  const last = JSON.parse(rows[rows.length - 1]!.wire) as { body: Record<string, unknown> };
  expect(last.body.reply_to).toBe('f'.repeat(16));

  await postGroupMessage(a.o, { groupId: group.groupId, text: '乙' });
  const rows2 = await a.repo.listCommentOut();
  const last2 = JSON.parse(rows2[rows2.length - 1]!.wire) as { body: Record<string, unknown> };
  expect('reply_to' in last2.body).toBe(false);

  const err = await postGroupMessage(a.o, { groupId: 'a'.repeat(16), text: 'x' }).catch((e: unknown) => e);
  expect((err as GroupError).code).toBe('group_not_found');
});
```

- [ ] **Step 9: 跑测试**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run` 然后 `npx tsc --noEmit`
Expected: **17 文件**、原 142 项 + 本 Task 新增（7 个 `it`）全绿；`tsc` 无输出

- [ ] **Step 10: 提交**

```bash
git add apps/mobile/src/core/group.test.ts
git commit -m "test(mobile): 学习小组 AC 1/2/8/9/10 与轮换提示（学习小组 §6）"
git push
```

---

### Task 9: 手机端 UI——圈子改小组列表页、新建会话页、路由

**Files:**
- Rewrite: `apps/mobile/src/pages/circle/circle.vue`
- New: `apps/mobile/src/pages/group/group.vue`
- Modify: `apps/mobile/src/pages.json`

- [ ] **Step 1: `pages.json` 加一条路由**

加在 `pages/contribution/contribution` 之后；**tabBar 四 tab 一律不动**（册子 §5.5）：

```json
    {
      "path": "pages/group/group",
      "style": { "navigationBarTitleText": "小组会话" }
    }
```

- [ ] **Step 2: 重写 `circle.vue`（小组列表页）**

替换现有的「本版未开放」占位（`circle.vue` 全文 15 行）。要点：

- `bootstrap()` → `listMyGroups({ adapters, repo, nodeBaseUrl })`；**零网络**（读本地 `groups` 表）。
- 「新建小组」：`uni.showModal({ title:'新建小组', editable:true, placeholderText:'给小组起个名字' })` → `createGroup(o,{name})` → `uni.setClipboardData({ data: inviteCode })` + 提示「邀请码已复制，发给伙伴即可入组」；`queued` 为真时补一句「联网后自动登记名单」。
- 「加入小组」：`uni.showModal({ title:'加入小组', editable:true, placeholderText:'粘贴邀请码或续期码' })` → `acceptInvite`；失败显示 `GroupError.message`（`invite_invalid` 即「邀请码无效或已损坏」）；成功后刷新列表。
- **这两个入口在未配置节点时也可用**（AC 1 全离线）——与 `comment.vue` 的「未配置就禁用发表」不同，此处不禁用，只在列表为空时给「还没有小组」的提示。
- 列表项：`<navigator :url="'/pages/group/group?groupId=' + g.groupId">`，显示 `g.name || '未命名小组'`、`成员 N`、`epoch K`。成员数用 `JSON.parse(g.memberIdsJson).length`（解析失败按 0）。
- 样式照 `circle.vue` 现有 class 命名（`.wrap/.title/...`）扩展，不引组件库。

- [ ] **Step 3: 新建 `group.vue`（会话页）**

体例整段类比 `comment.vue`（待发区 `:19-32`、`flush()` `:145-150`、`send()` `:216-237`、样式 `:268-294`）。要点：

- `import { onLoad, onReachBottom, onShow } from '@dcloudio/uni-app'`；`onLoad((q) => { groupId.value = String(q?.groupId ?? '') })`（页面传参用 camelCase `groupId`，与全仓 `query.itemId` 同约定）。
- `onShow`：`load()` → `loadPending()` → `refresh()` → `void flush()`（不 await，补发不阻塞首屏）。
- 数据：`fetchGroupMessages(o, groupId)` → `feed.group.memberIds` 渲染成员、`feed.events` 渲染消息流、`feed.nextCursor` 支持 `onReachBottom` 续页、**`feed.notice` 非空时原位显示原文**（`GROUP_KEY_STALE_NOTICE`，硬要求，禁止静默）。
- 消息行：`short(actor) · rel(createdAt)` + `text ?? '（无法解密）'`；有 `replyTo` 时加一行「回复 xx」。
- 待发区：`repo.listCommentOut()` **过滤 `targetId === 'group/' + groupId`**（`comment.vue` 不过滤是因为评论是单一 tab；小组会话页必须只显示本组的行），且**不渲染 `text`**（补充 8：密文对用户无意义）——只显示「待发送 / 发送失败：<原因>」与「删除」。
- 发言：`postGroupMessage(o, { groupId, text })`；`queued` → 「已保存，联网后自动补发」+ `loadPending()`；否则「已发表」+ `refresh()`；异常按 `e instanceof GroupError ? e.message : ...` 显示。
- 写门控：`canPostComment(caps)` / `postBlockedReason(caps)` / `UNKNOWN_FLAGS`（补充 9：与评论同一条「能否写事件」的能力，不新增自检探测）。
- **移出与轮换**（创建者才显示）：成员行右侧「移出」→ `rotateGroup(o, groupId, memberIds.filter(id => id !== target))` → `uni.setClipboardData({ data: inviteCode })` + 提示「已生成续期码，请发给剩余成员（他们粘入后才能读新消息）」。这正是册子 §5.3 的三步一次完成。
- **「粘贴续期码」**：所有人可见 → `uni.showModal({ editable:true })` → `acceptInvite`（只接受更大 epoch）→ 刷新。
- 未配置节点：给「未配置节点，暂时读不到消息」的提示；但**待发区与「粘贴续期码」仍可用**（本地操作）。

- [ ] **Step 4: 三件回归**

Run（cwd `e:\code\base\apps\mobile`）: `npx tsc --noEmit`; `npx vitest run`; `npm run build:h5`
Expected: `tsc` 无输出；**17 文件**全绿；`build:h5` 成功

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/pages/circle/circle.vue apps/mobile/src/pages/group/group.vue apps/mobile/src/pages.json
git commit -m "feat(mobile): 圈子改小组列表页 + 小组会话页（学习小组 §5.5）"
git push
```

---

### Task 10: 版本号、全量自测、节点二进制部署、文档回填

**Files:**
- Modify: `apps/mobile/src/manifest.json`
- Modify: `docs/README.md`

- [ ] **Step 1: 版本号**

`apps/mobile/src/manifest.json`：`versionName` `"0.8.0"` → `"0.9.0"`，`versionCode` `"9"` → `"10"`。

- [ ] **Step 2: 全量自测（两端）**

Run（cwd `e:\code\base\apps\mobile`）: `npx vitest run`; `npx tsc --noEmit`; `npm run build:h5`
Run（cwd `e:\code\base`）: `go build ./...`; `go vet ./...`; `go test ./...`
Expected: 移动端 **17 文件**全绿、`tsc` 无输出、`build:h5` 成功；Go 全包 ok

- [ ] **Step 3: 节点二进制交叉编译与两节点部署探活**（本册改了节点代码，按「更正 3」的后续口径必须做）

```powershell
$env:CGO_ENABLED = "0"; $env:GOOS = "linux"; $env:GOARCH = "amd64"; go build -o based ./cmd/based
```

再 `scp` 到 `/opt/base/based.new` 与 `/opt/base-cache/based.new`，各自 `cp -p` 备份为 `based.bak-0.9.0-deploy`，替换后 `systemctl restart base` / `systemctl restart base-cache`。

探活（**两节点都要**）：

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1:443/v1/group/0000000000000000   # 期望 404（路由已挂、组不存在）
curl -s  -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8083/v1/group/0000000000000000   # 期望 404
curl -sk https://127.0.0.1:443/v1/comment                                                    # 期望 200（既有读接口未回归）
```

期望：两个节点都是 **404 + `group_not_found`**（而不是 404 的 `404 page not found`——后者说明路由没挂上，二进制还是旧的）。回滚：`mv /opt/base/based.bak-0.9.0-deploy /opt/base/based && systemctl restart base`；**`base-cache.service` 与 `base.service` 共用同一二进制**（`ExecStart` 都指 `/opt/base/based`，见更正 3），回滚要一起回。

- [ ] **Step 4: `docs/README.md` 状态回填**（第 31 行的**登记**已随本计划落盘一并完成，此处只改状态，不要重复新增行）

1. §3 文档地图：第 31 行（本计划）状态「已定稿（待执行）」→「已执行（完整度见本计划『执行实况』；真机验收待人工）」；第 9 行 #9 册子状态 →「已定稿（计划 #31 已执行）」；
2. §4 依赖图：#9 行补「计划 #31」，并把「待出实施计划」的口径改为「已出/已执行」；
3. §5 状态与下一步：写明「#9 节点三件 + 手机端两页已落地；发布 0.9.0 / versionCode 10」与「真机待验项见本计划『待人工验收』」。

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/manifest.json docs/README.md
git commit -m "chore(release): 0.9.0/10 + docs/README 回填学习小组（#9 → 计划 #31）"
git push
```

---

## 自检清单（写完计划后核过）

- [ ] 每个 Task 的**文件路径**与**导入路径**都与仓库现状逐字对过：`@base/protocol-ts` 顶层已导出 `canonicalize` / `blobId` / `sign` / `verify` / `deriveIdentityId` / `isIdentityId` / `sealWithNonce` / `openWithNonce` / `bytesToHex` / `hexToBytes` / `randomBytes` / `utf8`（`packages/protocol-ts/src/index.ts` 的 11 条 `export *`）
- [ ] 移动端**没有新增依赖**：base64url 手写（补充 3），不引 `btoa`/`atob`、不引组件库
- [ ] 线上契约逐字核对：`group.v1` 的 body 键名（msg：`group_id`/`action`/`epoch`/`text_cipher`/`reply_to`；roster：`group_id`/`action`/`epoch`/`member_ids`/`name`）、`GET /v1/group/{group_id}` 的响应形状（`group`/`events`/`next_cursor`）、错误码 `group_owner_mismatch`(403) / `group_epoch_stale`(409) / `group_not_found`(404)、邀请码 `base1:` 前缀与 9 键签名域
- [ ] 节点侧**没有**新接口以外的接口面、没有 bump `schema_version`、没有加配置项、没有新增 KEK 种类、没有 `PRAGMA key`/`rekey`/`hexkey`
- [ ] 密码学**零新代码**：只有 `sealWithNonce` / `openWithNonce`（+ `deviceKek`）；密文形态 `nonceHex:ctHex` 与 `identity.ts` 一致
- [ ] `payload_cid` 两侧口径一致：节点 `BlobID([]byte(text_cipher))`（Task 2 Step 4），客户端只消费不重算
- [ ] 每个 Task 都以「只 `git add` 本 Task 文件」的提交 + push 收尾；**全程不碰工作区里 `.gitignore` 的既有未提交改动**
- [ ] 本册不改 `internal/packexport`、不动内容包规范、不动 `tools/migrate`

## 执行期更正（实施后回填，后续 Task 请以本节为准）

（执行时在此追加：与计划的偏差、实测发现、口径更正。每条写清「计划怎么写的 / 实际怎么做的 / 为什么」。）

- **更正 1（Task 2，缺陷级）**：`parseGroupRoster` 的成员校验原写 `isHexN(id, 32)`。`isHexN(s, n)` 的第二参是**字节数**（实现是 `len(s) != n*2`，见 `internal/httpapi/identity.go:48`），身份 id 是 **32 个 hex 字符**（`protocol.IdentityID` = `SHA256Hex(pub)[:32]`）→ 实际应写 `isHexN(s, 16)`。不改则**任何合法名单都被 400 `event_param_invalid` 拒掉**，AC 5 / AC 6 / AC 9 全部不可达（Task 5 写测试时暴露）。已改 `internal/httpapi/group.go:129`。
- **更正 2（Task 2，编译级）**：计划给出的 `internal/httpapi/group.go` 骨架有两处对不上仓库现状——① import 块漏 `errors`（`putGroupRoster` 要用 `errors.Is` 映射两个错误码）；② `BodyJSON: bodyJSON` 编译不过（`store.Event.BodyJSON` 是 `string`，而 `protocol.Canonicalize` 返回 `[]byte`）→ 应写 `string(bodyJSON)`（与 `handleCommentEvent` 同写法）。
- **更正 3（Task 1，行号级）**：计划 Step 4 说 `internal/peersync/scrub.go:78` 直呼 `CommentBlobIndex`。实测该行是 `ownershipIndex(st)`，scrub 是**经 `ownershipIndex` 间接**使用（全仓唯一直接调用点在 `peersync/sync.go:40`）→ `scrub.go` 无需改动，改名后语义自动生效。
- **更正 4（Task 3）**：`group_not_found` 原计划写 `writeError`。`writeError` 的响应体**只有 `error`、没有 `code`**，而客户端分流只读 `code` → 改用 `writeAuthErr`（响应体带 `code`）。`authErrText` 里无该码时回落到 code 文本，与既有错误码体例一致。
- **更正 5（Task 4）**：`peersync.parseCommentProjection` 在加 `group.v1` 分支时随语义改名 `parseEventProjection`（私有函数，唯一调用点同步改）；接收侧落投影抽成 `applySyncedGroupEvent`（`action=roster` 才写，走 `ForceGroupRoster`）。
- **更正 6（Task 5）**：节点侧单测比计划多两条口径——① AC 6 补「更小 epoch」一例（计划只写相等）；② 分页用例的 `limit` 要按**事件行数**（roster 行也占 limit 但不进 `events`）设计，否则末页永远满页、拿不到 `null` 游标。另：新文件统一补了文件末尾换行（与仓库既有文件一致）。
- **更正 7（Task 8，计划内部矛盾）**：Step 6 的 AC 10 用例先把 `/v1/event` 全局打成 403 再调 `createGroup`（注释写「roster 也被 403」），期望建组仍返回 `{ group }`。但本计划 Step 8 自己给的 `submitWire` 只在 `CommentError('network')` 时入队、**其余错误一律 `throw e`**（`core/group.ts:284`）⇒ 建组的 roster 吃 403 会让 `createGroup` 直接抛 `CommentError('rejected')`，断言在用例第 5 行即失败。**两处互相矛盾，非实现缺陷**；册子 §5.4 与 AC 10 原文是「节点返回任何 4xx / 5xx 一律**原地报错**不入队」，故**保持实现不变、改测试**：先用 200 桩走通建组，再把 `/v1/event` 翻成 403 去断言发言路径（`comment_out` 行数不变）。
- **更正 8（Task 8，体例）**：Step 1 import 了 `describe`，但 Step 2–8 给的用例全是**顶层 `it`**（照抄则 `describe` 未使用）。实际把 7 个用例包进 `describe('group', …)`——与仓库其它 `*.test.ts` 体例一致，也用上了该 import。
- **更正 9（Task 9）**：Step 3 说「`feed.nextCursor` 支持 `onReachBottom` 续页」，但 Step 10 给出的 `fetchGroupMessages(o, groupId)` **不接受游标**，内部 `fetchGroup` 也不传 `cursor` ⇒ 永远只取首页（节点 limit=30）；带解密的续页还需该模块**未导出**的 `openText`。册子 §5.5 对会话页只要求「消息流 / 发言输入框 / 待发区 / 成员列表」，**未要求翻页** ⇒ 不新增导出、不改 `core/`：保留 `onReachBottom` 接线与 `nextCursor`，游标非空时**原位提示**「更早的消息本版暂不支持翻页」（不静默显示「没有更多了」，也不混入未解密的原始事件）。另两点落地口径：① 创建者判定用零网络的 `peekLocalIdentity` 与本机 id 比对 `feed.group.creatorId`（计划未指定函数）；② 补发复用 `core/comment` 的 `flushPending`（`core/group.ts` 未导出补发函数）——与计划「补发编排零改动」一致。
- **更正 10（Task 6/7/8 + Task 10 探活，缺陷级）**：计划把 `group_id` 写成「16 hex」（Step 给的是 `randomBytes(8)`、`decodeInvite` 校验 16 字符），但**节点契约是 32 hex（16 字节）**——`isHexN(s, n)` 的第二参是**字节数**（`len(s) == n*2`，`internal/httpapi/identity.go:48`），而 `event_id` 实为 `randomBytes(16)`（`core/comment.ts:181`）/ 节点侧 `isHexN(req.EventID, 16)`（`internal/httpapi/event.go:52`）⇒ 册子「与 `event_id` 同形」的**同形值是 32 hex**。不改则：建组 roster 与每条发言都会被节点判 **400 `event_param_invalid`**（AC 5/AC 6/AC 9 与 AC 10 的联网路径全部不可达）。**发现方式**：Task 10 部署后探活 `GET /v1/group/0000000000000000`（16 hex）得 **400** 而非期望的 404，用 32 hex 重探才得到 `404 group_not_found`。已改客户端三处（`core/group.ts` 的 `createGroup` → `randomBytes(16)`、`decodeInvite` → 校验 32 hex；`types.ts` 注释）+ 测试三处期望（`group.test.ts` 的 `groupId` 正则、`reply_to` 两例、`group_not_found` 用 32 hex 组 id），另把册子 §3.1/§3.3/§3.4 的「16 hex」口径回填为「16 字节（32 hex）」并记入册子 §0.2。
- **更正 11（Task 10 发布缺口补做 + CLI 取证反转）**：本计划 Task 10 只写了「版本号 + 节点二进制部署」，**没有** 0.5.0–0.8.0 一贯的四步发布动作（APK 云打包 → 上传 → 落地页改指 → `based release` 签发）。同日补做：
  - ① **打包**：`D:\HBuilderX\cli.exe open` 后执行 `cli.exe pack --project e:\code\base\apps\mobile --platform android --android.packagename uni.app.UNI936A667 --android.androidpacktype 3` **一次成功**（HBuilderX `5.26.2026091802`；09:15 提交云端 → 09:18 打包成功）。**这与 #30 计划留档的「任何 `pack` 调用必崩、CLI 桥接失效」相反**——那条取证基于 HBuilderX 5.24，现已不成立；两条记录并存备查（`pack` 输出显示「类型: Android云端证书」，但**证书 SHA1 仍是 `19:95:21:ED:…:FF:19`**，与 0.6.0–0.8.0 一致 ⇒ 可覆盖安装，无需卸载重装）。
  - ② **指纹**：临时地址下载另存 `apps\mobile\dist\release\apk\base-0.9.0.apk`；**27409541 字节**，sha256 `fda995350d4605c96a7ddb433e3cc04653e9f05706bc6ce0bab0e847f93c13a5`（本地 `curl.exe` 仍报 `getaddrinfo()`，照 #30 经验改用 `Invoke-WebRequest`）。
  - ③ **上传**：`scp` 到 `/opt/appdl/base-0.9.0.apk`，远端 `sha256sum` 与本地逐字一致。
  - ④ **落地页**：仍**整页重写后 `scp`**（`sed` 单行替换会留下陈旧版本文案，同 #30 经验）：href → `./base-0.9.0.apk`，版本行 → 「版本 0.9.0（versionCode 10）· 2026-09-29 · 学习小组（② 加密）：圈子建组 / 入组、小组会话、邀请码」，操作指引补第 6 条圈子路径；远端 `grep` 复核得 `base-0.9.0.apk` / `versionCode 10`。
  - ⑤ **签发**：`BASE_SIGN_KEY=… /opt/base/based release -version-name 0.9.0 -min-version-name 0.8.0 -apk-url http://118.190.217.242/dl/base-0.9.0.apk -apk-file /opt/appdl/base-0.9.0.apk -notes 学习小组②加密：圈子建组入组_小组会话_邀请码 -out /opt/base-cache/data/release.json`（`-notes` 必须是无空格单 token；`-out` 必须落在**缓存节点**数据目录——nginx `/` 的后端是 8083）。输出 `apk_size=27409541`、`apk_sha256=fda99535…`（与 ② 一致）、`public_key=48c33db9…824f4`。
  - ⑥ **线上验证**：`GET /v1/release` → `version_name":"0.9.0"` 且 `apk_sha256` 一致、`min_version_name":"0.8.0"`、`notes` 中文无乱码；`HEAD http://118.190.217.242/dl/base-0.9.0.apk` → **200** 且 `Content-Length: 27409541` == `apk_size`；客户端 `verifyRelease(doc, '48c33db9…')` = **true**（临时 `tsx` 脚本用后即删）；`/dl/index.html` 已指 0.9.0。**至此 0.9.0 才真正触达终端用户**（此前仅版本号 + 节点二进制），真机 7 条验收可以开始。
  - **后续口径**：凡手机端有用户可见改动，Task 列表必须显式包含这四步发布动作（本计划漏写属计划缺陷，与「更正 3」同类）。
- **更正 12（真机验收首日暴露的两处缺陷 + 热修复 0.9.1）**：两处现象独立，`0.9.0` 已发布且带 ①，故补发 `0.9.1`。
  - ① **代码级缺陷：自检 `randomblob` 探测把大写 hex 误判为异常**。真机 `hex(randomblob(32))` 返回 **64 个大写**字符（SQLite `hex()` 固有行为；本机实测 `select hex(randomblob(4))` → `0627764F`），而探测白名单是 `/^[0-9a-f]{64}$/`（只收小写）：长度 64 通过、字符不匹配 ⇒ 报「randomblob 返回异常（64 字符）」。**影响面不止页面红叉**——`applySelfCheck` 把探测结果写回 `cached.capabilities`（`platform/index.ts`），`cryptoOk='fail'` 令 `postBlockedReason` 生效 ⇒ **评论与小组发言被禁用**。**冷启动路径不受影响**（`hexToBytes` 经 `asciiToBase16` 同时接受 `A-F`/`a-f`，实测 512 大写字符 → 256 字节成功），故两者必须分清；`cached` 是**模块级内存变量、不落盘**，误判后**重启应用即恢复**。它能长期藏住的原因与「更正 10」同类：`fakes.ts` 假实现返回小写、单测恒绿——已把假实现改为照抄大写。修复 = 正则改 `[0-9a-fA-F]`。
  - ② **发布级缺陷：「真机安装包提示解析错误」的根因不是包，而是同名不同签的旧安装**。取证：0.8.0 与 0.9.0 **编译器同为 5.26、签名证书 SHA1/SHA256 完全相同、lib 压缩（`libgifimage.so` 318992→106612）与 ABI 一致、zip 条目 854 vs 855（只差新增小组页资源）**；公网 GET 下载件与本地逐字节一致、zip 首部 `50 4b 03 04`、EOCD 与 855 条目自洽 ⇒ **AAB / ABI 缺失 / 下载损坏 / zip 破坏 / 拿错包全部排除**。用户在机上**卸载同名旧安装**（此前装过同包名的自制基座，签名不同）后 **0.9.0 安装成功**。**口径**：凡真机装不上，先卸载同名旧安装再试，不要先怀疑构建。
  - ③ **热修复 `0.9.1`/`11`（含 ①，四步发布一次走完）**：CLI 打包一次成功（12:09:01，`Android云端证书`）；APK **27409528 字节** / sha256 `3450f78dbbd0078963786fb7491fac3019fa0a8e3c3cb4aee7a881eb0b3981ec` / 证书 SHA1 仍为 `19:95:21:ED:…:FF:19`；上传 `/opt/appdl/base-0.9.1.apk`（远端 sha256 一致）；落地页整页重写改指 0.9.1，并在指引里补「报解析错误先卸载同名应用」；签发 `based release -version-name 0.9.1 -min-version-name 0.8.0 … -out /opt/base-cache/data/release.json`；线上 `GET /v1/release` → `0.9.1` / `apk_size=27409528` / `verifyRelease=true`，`HEAD /dl/base-0.9.1.apk` → **200** + 27409528。
- **更正 13（真机验收次日：小组会话页输入框被自身禁用逻辑锁死 + 热修复 0.9.2）**：「更正 12 ①」修好后真机现象变为 —— **能建小组，但小组会话页打不了字、评论页选中内容标签后才能发**。
  - ① **代码级缺陷：`group.vue` 输入框 `:disabled="!canSend"` 自锁**。`canSend` 含 `draft.trim() !== ''`，故空草稿 → 输入框禁用 → 打不出字 → 草稿永远为空，**死循环**；按钮与输入框挂了同一个 `canSend`，把「提交前置条件」误当成「输入前置条件」。评论页写法正确（输入框只按 `unconfigured || target === ''`、按钮才用 `canSend`），小组页抄错——**同一缺陷族在 0.9.0 起就存在，只是被「更正 12 ①」的能力标志遮住**。修复：输入框改为 `:disabled="!canPostComment(caps.value)"`（只按「结构性不可写」禁用；离线入队仍可行，故节点未配置不禁用——`submitWire` 在网络不可达时入队）。
  - ② **服务端取证（说明这**不是**网络/节点问题）**：两节点 `events` 表证明设备（`116.142.113.6`）当日 `POST /v1/event` **全部 200**（自检探针 + 建组 roster），`groups` 表两节点均有该组且 `epoch=1`，12:38–12:39 仍在正常 `GET /v1/comment` / `GET /v1/group/{id}` / 取块；**12:36 之后再无任何评论或小组发言的 POST**。即「点发表后请求根本没发出」⇒ 缺陷在客户端 UI 层，非节点。
  - ③ **热修复 `0.9.2`/`12`（四步发布一次走完）**：CLI 打包一次成功（13:53:27，`Android云端证书`）；APK **27409554 字节** / sha256 `4cf75f45705f1508dcafec5ec8677ca5a715878b58e1141f3c12083a5c697db6` / 855 条目 / 包内 `"version":{"code":"12","name":"0.9.2"}` / 证书 SHA1 仍为 `19:95:21:ED:…:FF:19`（与 0.6.0–0.9.1 一致，可覆盖安装）；上传 `/opt/appdl/base-0.9.2.apk`（远端 sha256 一致）；落地页整页重写改指 0.9.2 并在评论指引里补「先点一个内容标签」；签发 `based release -version-name 0.9.2 -min-version-name 0.8.0 … -out /opt/base-cache/data/release.json`；线上 `GET /v1/release` → `0.9.2` / `apk_size=27409554` / `verifyRelease=true`，`HEAD /dl/base-0.9.2.apk` → **200**，无游离 `/opt/base/data/release.json`。
  - ④ **口径登记（留待「结构性」阶段，本版不动）**：评论页**必须先在顶部点一个内容标签**才可发表（`target_id` 为 ① 类的靶向契约，不接受空目标）；未选时输入框为灰色且只有占位文案、无原位原因。这是体验缺口、不是缺陷，本版只修功能，**不在 0.9.2 内变更评论目标口径**。
- **更正 14（真机验收第三日：小组会话页**整页空白** + 热修复 0.9.3）**：0.9.2 装上后点小组卡片「只有「小组会话」4 个字、一片空白、没有输入框与发表按钮」。
  - ① **代码级缺陷：模板里对 ref 手写 `.value`**。0.9.2 的修法写成了 `:disabled="!canPostComment(caps.value)"`——`caps` 是 **ref**，而**模板会自动解包**，手写 `.value` 等于多取一层。app-vue 以 inline 模式编译模板，会对 `SETUP_REF` 标识符补一次 `.value`，于是产出 **`!e.unref(yo)(S.value.value)`**（同一表达式在**脚本**侧正确产出 `yo(S.value)`，单层）。`caps.value.value === undefined` ⇒ `canPostComment(undefined)` ⇒ 首次渲染就抛 `TypeError: Cannot read properties of undefined (reading 'cryptoOk')` ⇒ **整页渲染中断**，只剩 `pages.json` 的原生标题「小组会话」——与「其他 tab 都正常、只有这一页全白」的现象逐字吻合。全仓扫描：模板里写 `.value` **仅此一处**（`group.vue:52`），无同类残留。
  - ② **取证靠编译产物，不靠运行日志**（本次定性的关键手法）：`npm run build:app` 产出的 `app-service.js` 与线上 0.9.2 包内**字节数完全相同（227835）**⇒ 包内即当前源码、排除陈旧构建；在产物里定位 group 页渲染函数，得 `disabled:!e.unref(yo)(S.value.value)`，与评论页同位置 `disabled:r.value` 对照；再由 `S.value=e.capabilities` 确认 `S` 就是 `caps`。**修复后重新编译：产物 `\.value\.value` 计数 = 0，输入框行变为 `disabled:!x.value`**（与评论页同形态）。
  - ③ **为何 149 项单测 + `tsc` + `build:h5` 全绿仍漏掉**：这是**运行期渲染错误**，三道门禁只做编译与纯逻辑；且该写法在 **H5 非 inline 模式下同样会炸**（不是 app 专属），本册从未跑过任何页面渲染测试。**故新增发布前检查项**（并入四步发布的第一道）：`grep -nE '="[^"]*\.value|\{\{[^}]*\.value' apps/mobile/src/pages/*/*.vue` 必须**无输出**；并保留「`build:app` 产物 `\.value\.value` 计数为 0」这条硬检查。
  - ④ **热修复 `0.9.3`/`13`（四步发布一次走完）**：模板改用计算属性 `canInput`（`const canInput = computed(() => canPostComment(caps.value))`，与评论页 `canSend` 同体例），模板只写 `canInput`；APK **27409547 字节** / sha256 `4feb8a76212253841b3c6db1b845976382abb4ed568be5b7b8fdc7d6e35cab47` / 包内 `"version":{"code":"13","name":"0.9.3"}` / 证书 SHA1 仍为 `19:95:21:ED:…:FF:19`（与 0.6.0–0.9.2 一致，可覆盖安装）；上传 `/opt/appdl/base-0.9.3.apk`（远端 sha256 逐字一致）；落地页整页重写改指 0.9.3；`based release` 签发落 `/opt/base-cache/data/release.json`（**无**游离 `/opt/base/data/release.json`）；线上 `GET /v1/release` → `0.9.3` / `apk_size=27409547` / `verifyRelease=true`，`HEAD /dl/base-0.9.3.apk` → **200**。
  - ⑤ **一句话教训**：`build:app` 的产物检查（`\.value\.value` 计数、与线上包同尺寸）比 `build:h5` 更代表真机；`cli pack` 的编译产物不等于 `uni build -p app` 的产物（本次两者差 8KB，故产物核对以**包内文件**为准）。

## 执行实况（实施后回填）

| Task | 内容 | commit | 实测结论 |
|---|---|---|---|
| 1 | `groups` 表 + `sqlExec` 抽壳 + 事件分页/块归属索引 | `4575dd3` | `go build` / `go vet` / `go test ./...` 全包 ok；scrub 经 `ownershipIndex` 间接生效，无需改动（更正 3） |
| 2 | `group.v1` 注册与 `msg`/`roster` 分流 | `4575dd3` | 同上；`isHexN` 第二参是字节数、`BodyJSON` 要 `string(...)`（更正 1、2） |
| 3 | 匿名读 `GET /v1/group/{group_id}` | `e9fbc05` | 404 走 `writeAuthErr` 才能带 `code`（更正 4） |
| 4 | 反熵接收侧投影还原 + roster 落表 | `e9fbc05` | `parseEventProjection` + `applySyncedGroupEvent`（更正 5） |
| 5 | 节点侧单测（AC 5/6 + 分页 + 归属） | `e9fbc05` | 分页 `limit` 按**事件行数**设计，否则拿不到 `null` 游标（更正 6） |
| 6 | 手机端 `groups` / `group_keys` 两表 + 仓储五方法 | `e98a2af` | 含本册新测在内 vitest 17 文件全绿 |
| 7 | `core/group.ts` + `ensureLocalIdentity` | `be19dc2` | `tsc --noEmit` 干净；签名域 9 键与册子 §3.3 逐字一致 |
| 8 | `core/group.test.ts`（AC 1/2/8/9/10） | `b784317` | AC 10 用例前提修正（更正 7）、7 个用例包 `describe`（更正 8） |
| 9 | 圈子改小组列表页 + 小组会话页 + 路由 | `c00075a` | `pages.json` 只加 1 条路由、tabBar 未动；不翻页时**原位提示**（更正 9） |
| 10 | `0.9.0`/`10` + 全量自测 + 节点部署探活 + 文档回填 + **发布补做** | `9f7156c`（group_id 修复）+ `a55c4be`（版本/文档） | mobile **17 文件 / 149 项全绿** + `tsc` 干净 + `build:h5` 通过；`go build`/`go vet`/`go test ./...` 全包 ok；两节点交叉编译部署后探活：`GET /v1/group/{32hex}` → **404 `group_not_found`**、`GET /v1/comment` → **200**；**`group_id` 长度缺陷即在此步暴露**（更正 10）；**0.9.0 APK 已发布上线**（补做，见更正 11）：27409541 字节 / sha256 `fda99535…c13a5` / 证书 SHA1 与 0.6.0–0.8.0 一致，落地页与 `/v1/release` 均改指 0.9.0、线上验签 `verifyRelease=true` |
| 11 | 热修复 `0.9.1`/`11`：自检随机源误判（更正 12 ①）+ 发布四步 | `aa1360e`（正则 + fakes 照抄大写）+ 版本号 | mobile **17 文件 / 149 项全绿** + `tsc` 干净 + `build:h5` 通过；APK **27409528 字节** / sha256 `3450f78d…81ec` / 证书 SHA1 与 0.6.0–0.8.0 一致；落地页与 `/v1/release` 均改指 0.9.1、线上验签 `verifyRelease=true` |
| 12 | 热修复 `0.9.2`/`12`：小组会话页输入框被 `canSend` 自锁（更正 13 ①）+ 发布四步 | `1c2d3ac`（fix）+ `d6df2c6`（docs）+ `51b02c0`（验收手册） | mobile **17 文件 / 149 项全绿** + `tsc` 干净 + `build:h5` 通过；服务端取证确认写入通道正常、卡点在 UI（更正 13 ②）；APK **27409554 字节** / sha256 `4cf75f45…7db6` / 包内 `0.9.2`+`12` / 证书 SHA1 与 0.6.0–0.9.1 一致；落地页与 `/v1/release` 均改指 0.9.2、线上验签 `verifyRelease=true` |
| 13 | 热修复 `0.9.3`/`13`：模板误写 ref 的 `.value` 致小组会话页**整页空白**（更正 14 ①）+ 发布四步 | `64f44dd`（fix）+ `43ce839`（docs） | mobile **17 文件 / 149 项全绿** + `tsc` 干净 + `build:h5` 通过；定性靠**编译产物**：0.9.2 包内即当前源码（`app-service.js` 同尺寸 227835）、产物内 `disabled:!e.unref(yo)(S.value.value)` 双层解包，修后 `\.value\.value` 计数 = 0、变为 `disabled:!x.value`（更正 14 ②）；**新增发布前门禁**：模板内 `.value` grep 必须无输出（更正 14 ③）；APK **27409547 字节** / sha256 `4feb8a76…cab47` / 包内 `"version":{"code":"13","name":"0.9.3"}` / 证书 SHA1 与 0.6.0–0.9.2 一致；落地页与 `/v1/release` 均改指 0.9.3、线上验签 `verifyRelease=true`、无游离 `/opt/base/data/release.json` |

### 待人工验收（真机）

- AC 7 被移出方的**解密失败提示原文**在会话页原位可见（不是空白、不是「消息消失」）
- AC 3 真机部署后翻节点 `data/base.db` 与 `data/blobs/*` 原始字节，**不出现**任何小组消息明文
- AC 4 跨节点取件：A 节点发言 → B 节点（缓存节点）匿名拉索引 + 取密文块 → 解密成功
- AC 1 真机全离线：飞行模式下 A 建组出码、B 粘码入组
- 邀请码 / 续期码的复制与粘贴（`uni.setClipboardData` 与 `showModal` 的 `editable`）
- 圈子 tab 小组列表 → 会话页跳转；待发区**不显示密文**、只显示状态与删除
- 断网发言入队 → 联网自动补发仅一条（含 roster 的断网建组场景）

**说明（AC 3/AC 4 为何只能真机验）**：本机（Windows）起 `based serve` 做端到端替代验证**不可行**——监听回环地址后客户端连接被 Windows Defender 防火墙静默丢弃（三个 Profile 均 `Enabled=True`、`DefaultInboundAction=NotConfigured`，非管理员无法为新二进制加放行规则），`curl` 与 Node `fetch` 均 `ETIMEDOUT`。对生产节点写测试数据会留下不可删除的 `identity` / `groups` / `event` / blob 行，故不做；AC 3/AC 4 维持真机定位，探活仅做**只读**验证（已在 Task 10 完成）。

### 真机验收操作手册 · 第一步（0.9.3 功能复验）

> 用途：复验「更正 14 ①」的修复（0.9.2 上小组会话页整页空白），并确认评论发表的正确操作口径。
> 通过标准：下表两条检查全部出现「预期结果」。**任一条不符即停止**，按各节「失败分支」取证后回报，不要继续往后做。

#### 0. 前置

| 项 | 要求 |
|---|---|
| 安装包 | `http://118.190.217.242/dl/base-0.9.3.apk`（27409547 字节） |
| 安装方式 | 覆盖安装即可；若报「解析错误」，**先卸载同名应用**再装（更正 12 ②） |
| 版本核对 | 设置 →「基座自检」→「复制结果」，末行必须是 `版本：0.9.3` |
| 网络 | 保持联网（本条只验功能，不验离线） |
| ⚠️ 若仍是 0.9.2 | 装 0.9.2 时小组会话页会**整页空白**（只剩标题「小组会话」，无输入框与发表按钮）——这是更正 14 ①，非操作问题；先换 0.9.3 |

#### 1. 环境自检（先做）

1. 我的 → 设置 → 点「保存」（节点地址已预填 `http://118.190.217.242`）
2. 点「基座自检」→ 等出结果 → 点「复制结果」留档
3. **预期**：底部一行 `能力：随机源 ok / 文件 ok / 本地库 ok / 写入 ok`
   - 任一项为 `fail` ⇒ **停止**，把复制出来的全文贴回（属能力标志问题，不在本次修复范围）

#### 2. 检查 A：小组会话页正常渲染且能直接打字发言（本次修复点）

| # | 操作 | 预期结果 |
|---|---|---|
| A1 | 圈子 tab →「新建小组」→ 输入名字 → 确定 | 顶部出现「邀请码已复制，发给伙伴即可入组」；列表出现该小组卡片（成员 1 · epoch 1） |
| A2 | 点该小组卡片进会话页 | **整页渲染完整**：标题为小组名、成员区显示 `xxxxxxxx（我）`、底部**能看到**输入框与「发表」按钮（只要「小组会话」4 个字而下面全空 ⇒ 命中更正 14 ①，见失败分支） |
| A3 | **不点任何按钮，直接点输入框** | **输入框可聚焦、光标出现、软键盘弹出**（← 本次修复点之一；0.9.1 及更早此处点不进去，更正 13 ①） |
| A4 | 打一句独特标记，如 `验收探针-9F3C2A` | 文字正常回显；右侧「发表」按钮由灰变亮 |
| A5 | 点「发表」 | 按钮短暂显示「发表中…」；下方出现「已发表」（断网则「已保存，联网后自动补发」）；输入框清空 |
| A6 | 退出该会话再重进（或等 1 秒刷新） | 消息列表中该条**原样出现**，带自己的短 id 与「刚刚」 |

**失败分支**（任一条命中即回报，不要自己重装或清数据）
- A2 只有标题「小组会话」、下方一片空白 ⇒ **先截图该页**，并回来自检「复制结果」全文与包内版本号（判定是否为更正 14 ① 的页面级渲染中断）。
- A3 点不进去 ⇒ 截图该页（含输入框底色），并附自检「复制结果」全文。
- A4 能打字但「发表」不变亮 ⇒ 回报草稿内容与按钮状态（说明 `canSend` 还有分支未满足）。
- A5 出现「已保存，联网后自动补发」但网络正常 ⇒ 回报其上方「待发送 N 条」区文案。
- A5 出现报错 ⇒ **报错原文照抄**贴回。

#### 3. 检查 B：评论发表（正确口径）

评论页输入框是**靶向的**：必须先选定一个内容，才允许发表（`target_id` 不接受空目标）。

| # | 操作 | 预期结果 |
|---|---|---|
| B1 | 课程 tab → 点同步（本地需有已下载内容） | 课程列表有内容 |
| B2 | 评论 tab → 看顶部横向标签栏 | 出现「全部最新」+ 若干内容标题 |
| B3 | 点中某个**内容标题**标签 | 该标签高亮；输入框由灰变白、可聚焦（未选中时占位文案为「选择一项内容后可以评论」） |
| B4 | 输入一句话 → 点「发表」 | 出现「已发表」；列表出现该条评论 |
| B5 | 换第二台设备评论 tab 重复 B2–B3 | **能读到同一条评论** |

**失败分支**：B3 输入框仍不可聚焦 ⇒ 回报标签栏截图 + 自检「复制结果」全文。

#### 4. 回报模板（照填贴回）

```
设备型号 / 安卓版本：
版本（自检复制结果末行）：
自检能力行：
检查 A：A1 / A3 能否打字 / A5 结果文案 / A6 是否回显
检查 B：B3 能否聚焦 / B4 结果 / B5 跨设备可见
异常截图或原文：
```

#### 5. 服务端配套取证（你做完 A5 后由我执行）

- 两节点 `events`（`group.v1|1`）与 `groups` 行：确认该条发言已落库、`epoch` 正确。
- 扫两节点 `data/base.db`（含 wal）与 `data/blobs/*`：确认**不含** `验收探针-9F3C2A` 明文（对应 AC 3）。
- 对比源节点与缓存节点 `GET /v1/group/{group_id}`：索引与密文块一致（对应 AC 4）。
- ⚠️ 标记只写在**小组**里、**不要**写进评论（① 类评论明文落库，会污染 AC 3 取证）。

#### 6. 记录

| 检查 | 结论 | 备注 |
|---|---|---|
| A 小组会话页整页渲染（不空白） | 待验 | 本次修复点（更正 14 ①：模板误写 ref 的 `.value` 致渲染中断） |
| A 小组会话页直接打字发言 | 待验 | 上一轮修复点（更正 13 ①：输入框被 `canSend` 自锁） |
| B 评论页先选标签再发表 | 待验 | 口径确认（更正 13 ④） |
| — | — | 本手册在 0.9.2 上暴露了更正 14 ①，安装包与版本核对已改指 `0.9.3`/`13` |