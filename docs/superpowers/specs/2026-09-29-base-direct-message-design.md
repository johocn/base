# base 私信（② 加密）设计

* 日期：2026-09-29

* 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`（§3 可见性三类、§3.1 判定责任、§4 访问模型、§7.3 接口、§8.1 本地表、§8.2 列级加密覆盖面、§9 交流互动与寻址域、§12.1 L2、§12 红线 9；**冲突时先改总纲**）

* 直接上游：`specs/2026-09-26-base-identity-tls-design.md`（S1 签名头与事件签名）、`specs/2026-09-26-base-mobile-local-encryption-spike.md`（#4：密钥密文列走应用层列级加密、`kek_source='device'`、禁 `PRAGMA key`）、`specs/2026-09-27-base-comment-event-sync-design.md`（#19：`POST /v1/event` 管线与 `GET /v1/comment` 体例）、`specs/2026-09-28-base-comment-offline-queue-design.md`（#20：离线入队与补发编排）、`specs/2026-09-29-base-groups-design.md`（#9：② 类事件类型注册、密文块落法、匿名分页读体例、带外密钥码形态）

* 范围：**私信寻址与 `dm.v1` 事件 · 带外好友码（对称会话密钥） · 匿名读索引接口 · 手机端好友列表 / 会话页 · 离线发言复用既有队列**

* 本册子**不覆盖**：群聊与广播（归 #9 小组）；已读回执；消息撤回 / 编辑 / 删除；引用回复；附件（图片 / 语音 / 文件）；密钥轮换与前向安全；成员准入读控制；本地消息缓存；多设备同一身份；节点托管密钥包；跨节点名册类同步；iOS；内容包规范 v1 的任何字段变更

## 0. 改版说明

### 0.1 2026-09-29 初版

**动机**：总纲 §9 把「私信」列为 B 主线四类互动之一，可见性 ② 加密可分发，寻址域已定为「收件人 id」（§9 寻址域表最后一行）。它是 #9（学习小组）的姊妹册——同属 ② 类、同一批既有件（事件管线、密文块、离线队列、`deviceKek()` 列级加密），但**形态更薄**：没有名单、没有 epoch、没有 owner 锁、没有密钥轮换，节点侧也因此比 #9 少一处改动。

**本册第一次定义（新增）：**

* **私信寻址** `target_id = dm/<收件人 id>`（§3.1）

* **带外好友码**格式与对称会话密钥模型（§3.2）

* **`dm.v1` 事件类型**（唯一种语义：密文发言）（§3.3）

* **节点侧最小改动两件**：事件类型注册 + 一个匿名读接口；**无新表**（§4）

* **手机端本地表 `dm_keys`** 与「双 `target_id` 合并」的会话视图（§5.1、§5.3）

**明确沿用、不改动：**

* `POST /v1/event` 的验签管线（签名头管准入 + 事件体 `sig` 管归属，`canonical({event_id,type,created_at,body})`）与「先验签、后落块」次序（#19）

* `GET /v1/comment` 的匿名分页体例：不透明游标 `<created_at>_<event_id>`、满页才给 `next_cursor`（#19、#9）

* `internal/sync` 的反熵与 `POST /v1/event-sync` 的事件传播；**接收侧无投影需要还原**（比 #9 少一处，§4.3）

* 手机端 `comment_out` 离线队列表与其补发编排（§5.4，**零新表**）

* `sealWithNonce` / `openWithNonce`（AES-256-GCM，密文形态 `nonce:ct`）与 `identity.ts` 的 `deviceKek()`（§5.2，**零新密码学代码**）

* ② 类「节点不可读、不可审」红线（总纲 §12 第 9 条）

### 0.2 2026-09-29 与总纲的两处口径对齐（先改总纲，再写本册）

本册在评审时确认了「不落地本地正文缓存」这一取舍（§5.1），它与总纲两处原文有指向性冲突，按铁律 1 **先改总纲**，改动随本册同一批提交：

* **总纲 §8.2 表格「私信正文（本地持久化）| 密文存储、读时解密 | 待 #10」一行**：该行的待办指向现在被作废——本册**不落地私信正文本地持久化**（与 #9 §5.1「不做本地消息缓存」同口径）。已改为「**不适用**（2026-09-29 §0.6：私信册子不缓存正文；该形态延期不取消）」。

* **总纲 §9 手机端本地表清单中的 `messages(msg_id, peer_id, blob_id, direction, sent_at)`**：本册不落地该表（**延期，不是取消**——它仍是「本地缓存他人正文」这一形态的既定设计）。已在总纲 §9 该行加注「**2026-09-29 §0.6：本册不落地**」。

总纲改动以 `## 0. 改版说明` 新增一节（§0.6）登记，不改任何既有条款的语义。

### 0.3 2026-09-29 评审后补充（写计划时发现的缺陷级缺口与口径填空）

写实施计划（计划 #34）时逐行核对了节点与手机端现有代码，发现本册 §4.3 有**两处判断错误**，以及若干处只有函数名、没有签名与口径的留白。**上游（总纲）无冲突，故只改本册**。

**一、纠错（§4.3「零改动」两条不成立）**

`#31` 计划复盘里的 F5 / F6 两处缺口在私信上**同族复现**——本册初版把它们误判为「私信无投影表 ⇒ 反熵接收侧零改动」。事实是：投影**表**确实没有，但反熵**接收侧**的两处既有机制各有硬编码的类型分支，必须各加一个 `dm.v1` 分支，否则私信事件「搬得过去、读不出来、块也拉不下来」，AC 4 不成立：

| # | 位置 | 现状 | 后果 |
|---|---|---|---|
| F5′ | `internal/peersync/eventsync.go` 的 `parseEventProjection(typ, bodyJSON)` | 只有 `comment.v1` / `group.v1` 两个分支，其余类型返回零值 | 私信事件搬到对端后 `target_id` / `payload_cid` 为空 ⇒ 对端 `GET /v1/dm/{peer_id}` 查不到该条 |
| F6′ | `internal/store/comment.go` 的 `EventBlobIndex()` | SQL 硬编码 `type IN ('comment.v1','group.v1')`，归属前缀只有 `comment:` / `group:` | 私信密文块在接受侧**无归属** ⇒ 反熵拉不下来、scrub 还会把块当孤儿删掉（AC 4 取不到密文） |

两条都**不改任何线上接口形状与事件传播协议**（减化 body 里 `{to, payload_cid}` 本就有 `payload_cid`，只是接收侧没去读；`EventBlobIndex` 是节点内部索引）。故本册 §4 的改动面由「两件」更正为「**三处**：事件类型注册 + 一个匿名读接口 + 反熵接收侧两行接线」，且**仍然零新表、零新列**。

**二、口径填空（零契约影响，仅补签名与边界）**

* §5.2 的抽取面不止两个函数：`dm.ts` 还需要 `group.ts` 里同一套原语，故 `core/wire.ts` 一并收编 base64url 编解码、`sealText`/`openText`、密钥密文封装（`sealGroupKey`/`openGroupKey` 随语义改名 `sealKeyCipher`/`openKeyCipher`），`group.ts` 改 import——仍是**纯抽取 + 纯改名、行为零变化**。
* `comment.ts` 的 `buildCommentWire` **不收编**：`submitWire` 必须引 `sendComment`，收编会形成 `comment ↔ wire` 模块环。
* `decodeFriendCode(code, myId)` 比组码多一个参数——「定向」一步要拿本机 id 比较 `peer_id`（§3.2）。
* `listFriends` 返回 `{peerId, hasKey}[]`；**拉收件箱失败时回落为「仅本地好友」**（索引层的可用性回落，与内容层「禁止静默跳过解密」是两件事）。
* `postDM` 的三条前置校验（`peerId` 形态 / 明文非空且 ≤ 4096 / 本地有该 peer 密钥）**全部在入队前**。
* 会话页不做翻页；`nextCursor` 非空时**原位提示**，不伪装成「没有更多了」。

## 1. 目标与判定

| # | 目标 | 判定 |
|---|---|---|
| 1 | 两人不联网也能建立会话 | A 选定对方 id 出好友码 → B 粘码 → 双方用同一会话密钥互读（§3.2、AC 1） |
| 2 | 私信内容对节点是**不透明密文** | 节点库与块目录原始字节中不出现私信明文（§3.3、AC 3） |
| 3 | 收件人能跨节点读到私信 | A 在节点 1 发言 → B 从节点 2 匿名拉索引 + 取密文块 → 解密成功（§4.2、AC 4） |
| 4 | 好友码不可伪造、不可转发 | 篡改任一字段验签失败；码被第三方拿到因 `peer_id` 不符被拒（§3.2、AC 2） |
| 5 | 会话里不掺入无关条目 | 第三方发给同一 peer 的消息不出现在 A↔B 会话中（§5.3、AC 5） |
| 6 | 断网发言不丢 | 复用 `comment_out` 入队 → 联网补发仅一条（§5.4、AC 6） |
| 7 | 无密钥时不暴露密文、不崩溃 | 收件箱对无本地密钥的来信显示索取提示，不显示密文原文（§5.3、AC 9） |

**非目标**：不做成员准入读控制（索引匿名可读，见 §4.2 的代价）、不做前向安全、不做密钥托管与轮换、不做已读回执、不做本地正文缓存。

## 2. 开工前已核实的现状缺口

逐条核实（全部为只读核对，结论直接决定 §4 / §5 的改动面）：

| # | 现状 | 对本册的影响 |
|---|---|---|
| 1 | `eventTypeRegistry` 只有 `comment.v1`、`group.v1`；`handleEventPost` 的 switch 只有两个分支 | 加 `dm.v1` = 加一行 + 一个分支（§4.1），验签管线零改动 |
| 2 | `GET /v1/identity/{id}` **已存在**（`handleIdentityGet`） | 取对方公钥用于验好友码无需新接口 |
| 3 | 既有密码学只有对称 AEAD（AES-256-GCM，`aead.ts`）与 Ed25519 签名，**无任何非对称加密能力** | 密钥只能**带外递送**（§3.2）；本册不引入非对称加密 |
| 4 | `buildGroupWire` / `submitWire` 是 `group.ts` 的**模块私有**函数（`group.ts:252`、`group.ts:264`） | 私信要复用须抽公共件（§5.2），否则出现第二份复制粘贴 |
| 5 | `comment_out(event_id,target_id,text,reply_to,wire,state,reason,queued_at)` 完全通用（`repo.ts:105`），小组即拿它存密文 | 私信离线发言**零新表**（§5.4） |
| 6 | 节点 `events` 表与 `ListGroupEvents` 只差一个 `type` 过滤（`store/group.go:96`） | 新增 `ListDMEvents` 是同构的十二行（§4.2） |
| 7 | `handleEventSync` 不按 type 过滤；反熵只比对 `blob_id` | 私信事件与密文块**自动跨节点传播**；**但接收侧要各加一个 `dm.v1` 分支**（见第 9、10 行） |
| 8 | `isHexN(s,n)` 的第二参是**字节数**（实现为 `len(s) == n*2`） | 校验 `peer_id` 与 `group_id` 同形：`isHexN(id, 16)` 即 32 hex（#9 曾在此踩坑，见 #9 册子 §0.2） |
| 9 | 反熵接收侧 `parseEventProjection` 只有 `comment.v1` / `group.v1` 分支，其余类型返回零值（`peersync/eventsync.go`） | **须加一个 `dm.v1` 分支**（§0.3 的 F5′、§4.4）：否则搬到对端的事件没有 `target_id` / `payload_cid` |
| 10 | 块归属索引 `EventBlobIndex()` 的 SQL 硬编码 `type IN ('comment.v1','group.v1')`（`store/comment.go`） | **须纳入 `dm.v1`**（§0.3 的 F6′、§4.4）：否则私信密文块在接受侧无归属，反熵拉不下、scrub 当孤儿删 |

## 3. 契约

### 3.1 标识与寻址

| 项 | 形态 | 说明 |
|---|---|---|
| 身份 id | 32 hex（16 字节） | `sha256(pubkey)` 截取，与 `event_id`、`group_id` 同形；由公钥派生，不依赖任何节点分配 |
| 会话寻址 | `target_id = dm/<peer_id>` | `peer_id` = **收件人**身份 id（32 hex） |
| 会话密钥 | 32 字节随机 | 一 peer 一把，**双向共用**；无 epoch、无轮换 |
| 事件行表达 | `actor` + `target_id` | `actor`（签名头验签所得）= 发送者；`target_id` = 收件人。两者合起来表达「谁发给谁」 |

**为什么用「收件人 id」而不是双向会话号**：总纲 §9 寻址域表已定「私信 → 收件人 id」，本册零总纲改动即可落地；且收件人的收件箱**天然可发现**——`GET /v1/dm/<我 id>` 就是「所有人发给我的」，无需任何额外接口或带外信息。代价是会话视图要合并两个 `target_id`（§5.3），以及节制的元数据暴露（§7.1）。

**寻址域护栏**（与总纲 §3.1 同族）：只有 `dm/` + 32 hex 可进入私信域；无会话号分配、无中心发号，`target_id` 由客户端从收件人 id 拼出并由事件内容签名覆盖（改标收件人即验签失败）。

### 3.2 会话密钥与好友码

**密钥来源**：带外递送，完全沿用 #9 邀请码的形制——纯文本单行、可复制粘贴、**可离线自验**；密码学零新代码（Ed25519 签名 + AES-256-GCM）。

**单向发起**（与 #9「建组 → 入组」同构）：

1. A 先确定 B 的 id（从名册 `GET /v1/contributors` 选定，或直接粘贴）；
2. A 生成 32 字节随机会话密钥，本地落 `dm_keys(peer_id=B)`，产出好友码；
3. B 贴码落 `dm_keys(peer_id=A)`。

双方各持一条记录、**同一把密钥**，两条方向的密文都用它加解密。

**好友码载荷（签名域的 7 个固定键）**：

| 键 | 类型 | 说明 |
|---|---|---|
| `v` | number | 恒为 `1` |
| `peer_id` | 32 hex | **本码指定的接收人**——B 必须校验它等于自己的 id |
| `key` | 64 hex | 会话密钥（32 字节） |
| `owner_id` | 32 hex | 生成者 A 的身份 id |
| `owner_name` | string | 生成者 A 的昵称；缺省写**空串**（避免同一码 canonicalize 出两种字节序） |
| `owner_pub` | 64 hex | 生成者 A 的公钥（收件人据此离线自验，不信任任何节点） |
| `created_at` | number | 毫秒时间戳 |

编码为 `base1:` + base64url(canonical(载荷 + `sig`))（与 #9 邀请码同一前缀与编码）。

**离线自验三步**（全通过才返回，任一步失败**统一文案**「好友码无效或已损坏」，不区分原因、不泄漏「哪一步失败」）：

1. **形态**：前缀、JSON 可解析、7 键类型与长度（`peer_id`/`owner_id` 32 hex、`key`/`owner_pub` 64 hex、`v === 1`）；
2. **定向**：`peer_id` 必须等于**本机身份 id**，否则拒（这是与 #9 组码的关键差别：组码设计上可任意转发，私信码刻意定向）；
3. **自证**：`deriveIdentityId(owner_pub) === owner_id`；`verify(owner_pub, canonical(7 键), sig)`。

**与既有码的互斥**：组的邀请码含 `group_id`/`epoch`/`group_key` 而缺 `peer_id`/`key`，私信码反之 ⇒ 两种码互相粘贴必然在第 1 步失败，无需额外类型判别位。

**同一 peer 已有本地记录时**（幂等与冲突口径）：

* 码里 `key` 与本地相同 ⇒ **幂等通过**（重复粘贴同一码不报错，与 #9 同 epoch 幂等同族）；
* 码里 `key` 不同 ⇒ 拒 `key_conflict`，提示「已有该好友的会话，本版本不支持更换密钥」。

**本册不做密钥轮换**，理由照实写：轮换会把「旧密文静默读不出」这一失败模式引入私信，而私信没有群主这类权威角色来仲裁换钥时机；要换钥须另立册子（含带外新码 + 历史可读性策略）。

**本地落盘**：`dm_keys.key_cipher` 形态为 `nonceHex:ctHex`（`deviceKek()` + `sealWithNonce`），与 `identity.ts` 的私钥密文、`group_keys.key_cipher` **同一形态**。

### 3.3 `dm.v1` 事件

**body 只在两种键之间取舍，最终只取两个键**（无 `action`、无 `reply_to`）：

| 键 | 类型 | 说明 |
|---|---|---|
| `to` | 32 hex | 收件人身份 id；节点据此拼 `target_id`，且它**被内容签名覆盖** |
| `text_cipher` | string | base64url(`nonce(12) || AES-256-GCM 密文与 tag`)，与 #9 小组消息同一封法 |

**为什么不带 `action`**：`dm.v1` 只有一种语义（密文发言），加 `action` 只是照抄 #9 的形状而没有第二个分支可分流。将来若要回执之类，另立事件类型（如 `dm_receipt.v1`）比改本类型的语义更干净。**为什么不带 `reply_to`**：私信是双人线性会话，引用语义弱（见 §8）。

**长度上限**（客户端与节点两侧各有一道，且客户端更紧）：

* 节点：`text_cipher` 长度 ≤ 8192 字节（与 `maxCommentBytes` / `maxGroupCipherBytes` 同量级），超限即拒 `event_param_invalid`；节点**只看密文长度，不解密、不推断**。
* 客户端：**单条明文 ≤ 4096 字节**（UTF-8）。推导：明文 4096 + nonce 12 + tag 16 = 4124 → base64url 长度 `ceil(4124/3)*4 = 5500` < 8192，留足余量；反过来若按节点上限倒推明文，base64 膨胀会溢出。此上限由客户端**在入队前**校验，拒绝的文案在 UI 层（不产生事件、不入队）。

**节点落库**（`putDMMessage`，与 `putGroupMessage` 同构）：

1. 校验 body 键集（多一个未知键即拒，因为重建的待验字节必须与客户端所签一致）；
2. `verifyEventSig` 验事件内容签名；
3. **验签通过之后**才落块：`cipher := []byte(text_cipher)`、`payload_cid := BlobID(cipher)`、`PutBlob(payload_cid, cipher, "", 0)`；
4. 落事件行：`TargetID = "dm/" + to`、`PayloadCID = payload_cid`、`BodyJSON = canonical({to, payload_cid})`（密文只在块里存一份，与 `comment.v1` / `group.v1` 同构）；
5. 响应 `{event_id, payload_cid, received_at}`；同 `event_id` 重发给权威 `received_at`（与 comment 口径一致）。

**不做的事**：不查墓碑（② 类不可审，总纲 §12 第 9 条）、不建任何明文派生索引、不写任何投影表、**不校验 `to` 是否已登记身份**（与小组发言一致：节点不把「对方是否注册」当准入门槛）。

## 4. 节点侧改动（三处，其余零改动）

### 4.1 事件类型注册

`internal/httpapi/event.go`：`eventTypeRegistry` 加一行 `"dm.v1": {}`；`handleEventPost` 的 switch 加 `case "dm.v1": s.handleDMEvent(...)`。其余（`decodeJSON`、`isHexN(event_id,16)`、`created_at > 0`、按身份与 IP 的双维度限速 30/分钟）**全部复用**。

### 4.2 匿名读接口（新增）

```
GET /v1/dm/{peer_id}?cursor=&limit=
→ 200 { "events": [ { "event_id", "actor", "created_at", "payload_cid" } ], "next_cursor": <string|null> }
```

* `peer_id` 必须 32 hex（`isHexN(id,16)`），否则 400 `event_param_invalid`。
* 匿名开放，**不需要签名头**；正文一律另取 `GET /v1/blob/{payload_cid}`（密文，节点不解释）。
* 分页口径与 `GET /v1/comment`、`GET /v1/group/{id}` **逐字一致**：`limit` 缺省 30 / 上限 100；游标是不透明的 `<created_at>_<event_id>`（复用 `parseCommentCursor`）；排序 `created_at DESC, event_id DESC`；**满页才给** `next_cursor`。
* **无 404 分支**：私信没有投影表，查无数据即 `{"events": [], "next_cursor": null}`。这是与 `GET /v1/group/{group_id}` 的一处刻意差异——后者 404 是因为「尚无 roster」这一状态本身有语义，私信没有对应状态。

`internal/store` 新增 `ListDMEvents(peerID, cursorTS, cursorID, limit)`，与 `ListGroupEvents` 同构，只把 `type` 换成 `dm.v1`、`target_id` 换成 `"dm/" + peerID`。

**代价（明写）**：索引匿名可读 ⇒「谁、何时、给谁、发了多大一条密文」这一层元数据公开；内容仍不可读（无密钥）。与 #9 §4.3 的代价同口径。

### 4.3 零改动清单（逐条核对过）

| 项 | 结论 |
|---|---|
| `POST /v1/event` 验签管线、限速、错误码映射 | 零改动（只多一个分支） |
| `POST /v1/event-sync` 事件传播 | 零改动——`handleEventSync` 不按 type 过滤，事件照搬 |
| 反熵接收侧投影还原（`parseEventProjection`） | **须加一个 `dm.v1` 分支**（§4.4 / §0.3 F5′）——减化 body 里本就有 `payload_cid`，接收侧只是没读 |
| 块归属索引（`EventBlobIndex`） | **须纳入 `dm.v1`**（§4.4 / §0.3 F6′）——否则密文块在接受侧无归属，被 scrub 当孤儿 |
| 投影**表** | 零改动——私信没有任何投影表，比 #9 少一处（#9 需把 `roster` 落进 `groups` 名单） |
| `GET /v1/blob/{blob_id}` 匿名取块 | 零改动（密文与明文一视同仁） |
| 内容包规范 v1 | 零改动——私信不进包、**不 bump `schema_version`** |
| 配置项 | 不新增任何配置项 |
| 数据库表 | 节点侧**不新增任何表、不新增任何列** |

### 4.4 反熵接收侧两行接线（§0.3 F5′ / F6′ 的落点）

这两处不是新增机制，而是既有机制里各补一个 `dm.v1` 分支；不补则 AC 4（跨节点仍能读到密文）不成立。

**F5′：`internal/peersync/eventsync.go` 的 `parseEventProjection`（现 `:196`）**

该函数从对端事件的 `body_json` 重建本地索引列。私信事件的减化 body 本就有 `to` 与 `payload_cid`（§3.3），只是没读。加一个分支：

```go
case "dm.v1":
	var m struct {
		To         string `json:"to"`
		PayloadCID string `json:"payload_cid"`
	}
	if err := json.Unmarshal([]byte(bodyJSON), &m); err != nil || !isHexN16(m.To) {
		return commentProjection{}
	}
	return commentProjection{TargetID: "dm/" + m.To, PayloadCID: m.PayloadCID}
```

`dm.v1` 的 body 只有 `{to, text_cipher}`（无 `reply_to`），故 `ReplyTo` 恒空——这是与 comment/group 分支的唯一差异。`isHexN16` 为 `peersync` 包内 3 行小助手（`len(s)==32` + `hex.DecodeString`），不在本包引入 `httpapi` 依赖。

**F6′：`internal/store/comment.go` 的 `EventBlobIndex`（现 `:66`）**

该函数的 SQL 白名单与前缀映射都要纳入 `dm.v1`：

```sql
WHERE type IN ('comment.v1','group.v1','dm.v1') AND payload_cid IS NOT NULL AND payload_cid<>''
```

```
prefix := "comment:"
if typ == "group.v1" { prefix = "group:" }
if typ == "dm.v1"    { prefix = "dm:" }
```

两条既有调用点（`peersync/sync.go:40` 的 `ownershipIndex`、scrub 的孤儿判定）**不改代码即自动生效**——它们只消费这个 map。

**不做的**：私信没有投影表，故**不需要** `applySyncedGroupEvent` 那样的第三条接线（那是 #9 为 `roster` 落 `groups` 名单而设的，私信无对应状态）；`handleEventSync` 也不按 type 过滤，事件照搬，零改动。

## 5. 手机端设计

### 5.1 本地表

**只新增一张表**：

```sql
CREATE TABLE IF NOT EXISTS dm_keys(
  peer_id TEXT PRIMARY KEY,
  key_cipher TEXT NOT NULL,
  created_at TEXT NOT NULL
)
```

`LocalRepo` 新增三个方法：`putDmKey(row)` / `getDmKey(peerId)` / `listDmKeys()`；类型 `DmKeyRow` 加在 `core/types.ts`。

**好友列表 = `dm_keys` 的行集**，不另建联系人表。

**不建消息表、不缓存他人私信正文**：与 #9 §5.1「不做本地消息缓存」同口径。由此产生的产品行为照实写：**断网只能看到会话列表与待发队列，历史私信正文需联网取块才能读**（与小组会话页一致）。总纲 §9 的 `messages` 表因此在本册**延期不取消**，已在 §0.2 登记并同步改总纲。

### 5.2 新增模块与既有件的收编

**新文件 `core/dm.ts`**（只依赖注入的适配器 / `LocalRepo` / 既有 `core/*`，不 import `uni` / `plus`，可在 Node 下用 `core/fakes.ts` 完整测试）：

| 函数 | 职责 |
|---|---|
| `encodeFriendCode` / `decodeFriendCode(code, myId)` | 好友码编解码 + 离线自验（§3.2，形制与 `group.ts` 的 `encodeInvite`/`decodeInvite` 同构）。**比 `decodeInvite` 多一个 `myId` 参数**：§3.2 的「定向」一步要校验 `peer_id === 本机身份 id`；`myId === ''`（本机无身份）一律判 `friend_code_invalid` |
| `createFriend(o, peerId)` | 生成/复用会话密钥 → 落 `dm_keys` → 出好友码（**全程离线**）。重复出码复用已存密钥，保证码与本地一致 |
| `acceptFriendCode(o, code)` | 验码 → 落 `dm_keys`（幂等 / `key_conflict`） |
| `listFriends(o)` | 会话列表，返回 `{ peerId, hasKey }[]`：`dm_keys` ∪ 「给我发过消息的人」（§5.3）；`hasKey` 供 UI 区分「有密钥可读」与「只有来信」。**拉收件箱失败时静默回落为仅本地好友**，不抛错 |
| `postDM(o, peerId, text)` | 三条前置校验（有身份 / 明文字节数上限 / 本地有会话密钥）**全部在入队之前** → `sealText` 出密文 → `buildEventWire('dm.v1', {to, text_cipher})` → 入 `comment_out`（离线也成功） |
| `fetchConversation(o, peerId)` | 合并双 `target_id` → 逐条取块 → 解密（§5.3）。**只取首页、不翻页**——与既有小组会话页口径一致 |

**收编既有件（唯一一处对已上线代码的改动）**：`group.ts` 里的事件层公共件抽到新文件 `core/wire.ts`，导出面为 `buildEventWire(ident, type, body)` / `submitWire(o, {...})` 加事件层原语 `bytesToBase64Url` / `base64UrlToBytes` / `sealText` / `openText` / `sealKeyCipher` / `openKeyCipher`；`group.ts` 与 `dm.ts` 都改为 import。改动是**纯抽取、行为零变化**：仅两处异常文案因去掉 `group:` 前缀而变化（无任何测试断言），`sealGroupKey`→`sealKeyCipher`、`openGroupKey`→`openKeyCipher` 四处调用点改名。由既有 `group.test.ts` 与新增 `dm.test.ts` 双向覆盖。

**刻意不收编 `comment.ts`**：其 `buildCommentWire` 与 `buildEventWire` 同构，但收编会让 `comment.ts` 与 `wire.ts` 形成**模块环**（`wire.ts` 的 `submitWire` 要调 `sendComment`），与「纯抽取、行为零变化」冲突 ⇒ 本轮一行不动。

**密码学零新代码**：`sealWithNonce` / `openWithNonce` / `randomBytes` / `sign` / `verify` / `deriveIdentityId` 全部来自 `@base/protocol-ts`，与 #9 一字不差。

### 5.3 双 `target_id` 合并的会话视图

A↔B 的会话由两次匿名读 + 客户端合并得到：

```
拉 GET /v1/dm/<B.id>  →  只保留 actor === A.id（A 自己发出的）
拉 GET /v1/dm/<A.id>  →  只保留 actor === B.id（B 发给 A 的）
两条流按 created_at 升序合并 → 逐条 GET /v1/blob/{payload_cid} → 用 dm_keys(B).key 解密
```

* **过滤是硬要求，不是优化**：`dm/<B.id>` 里还会有第三方发给 B 的条目，不过滤就会把别人的私信混进 A 的会话页（AC 5）。
* **一次密钥解两个方向**：双方共用同一把会话密钥，两个方向的密文都可解。
* **解密失败一律原位提示**，禁止静默跳过、禁止把密文直接铺到界面上（沿用 #9 §5.3 的硬要求）：库中无该 peer 密钥 → 「尚未与对方建立会话，请索取好友码」；密钥在但认证失败（密文损坏 / 密钥不符）→ 「这条消息无法解密」。

**收件箱（会话列表）**：

```
本地 dm_keys 的 peer_id 集合  ∪  ( GET /v1/dm/<我 id> 返回的 actor 集合 )
```

并集里**无本地密钥**的那些人显示为「对方给你发了消息，需要索取好友码」——这正是「收件箱天然可发现」的收益（§3.1 的选型回报），实现成本约二十行。**不做未读数**（需引入本地已读状态，见 §8）。

### 5.4 离线发言：复用既有队列

与 #9 §5.4 完全同构，**零新表**：

* 有网：`sendComment`（签名头发送 + 错误码映射，零新代码）；
* 只有**网络不可达**才入 `comment_out`（节点回任何 HTTP 响应都原样抛出、不入队，与 `postComment` 同一口径）；
* 队列项的 `target_id = dm/<peer>`、`text` 列存**密文**（列名语义是「正文载荷」，不承诺明文）、`wire` 存已签名请求体供联网后重放；
* 联网补发走既有 `flushPending` 编排，**仅一条**（AC 6）。

### 5.5 UI

| 项 | 内容 |
|---|---|
| 页面 | `pages/dm/list.vue`（会话列表 + 「添加好友」生成/复制码 + 「粘贴好友码」）、`pages/dm/chat.vue`（会话页：合并双 `target_id`、逐条解密、输入发送、断网入队提示、无密钥提示） |
| 入口 | 挂在「我的」页（现有两组四行入口之后新增一组），**不改 #15 的四 tab 信息架构、不动 tabBar 图标** |
| 剪贴板 | 复用既有 `uni.setClipboardData` 用法（小组邀请码同款），不新增适配器方法 |
| 发布前检查 | 沿用 #9 复盘新增的两条硬检查：模板内 `.value` 用法扫描无输出、`build:app` 产物 `\.value\.value` 计数为 0（#9 册子 §0.2「更正 14」） |
| 版本发布 | `0.10.0` / code `14`，**必含四步**：云打包 → 上传 `/opt/appdl` → 落地页改指 → `based release` 签发落缓存节点（#31 计划「更正 11」立的口径） |

## 6. 验收（AC）

| AC | 内容 | 判定方式 |
|---|---|---|
| 1 | 全离线建立会话 | 飞行模式下 A 出好友码、B 粘码，双方 `dm_keys` 各一条且 `key` 相同（§3.2） |
| 2 | 好友码不可伪造、不可转发 | 篡改任一字段 → 统一文案拒绝；把 B 的码转给 C → C 因 `peer_id` 不符被拒（§3.2） |
| 3 | ② 类密文断言 | 发言后直接读节点 `data/base.db` 与 `data/blobs/*` 原始字节，**不出现私信明文**（总纲 §11 同款断言） |
| 4 | 跨节点取件解密 | A 在节点 1 发言 → B 从节点 2 拉 `GET /v1/dm/<B id>` + 取块 → 解出明文；第三方拉同一接口只拿到密文（§4.2） |
| 5 | 会话不掺无关条目 | 第三方 C 发给 B 的消息**不出现**在 A↔B 会话中（§5.3） |
| 6 | 断网发言不丢、补发仅一条 | 断网发送入队 → 联网后 `flushPending` 补发 → 服务端该 `event_id` 只有一条（§5.4） |
| 7 | 节点契约校验 | `to` 非 32 hex / 密文超 8192 字节 / 未知 body 键 / 未登记类型 一律拒，且**验签失败不落块**（§3.3） |
| 8 | 幂等与冲突 | 重复贴同一码幂等通过；同 peer 不同 `key` 的码被拒 `key_conflict`（§3.2） |
| 9 | 无密钥降级 | 收件箱对无本地密钥的来信显示索取提示；点开不崩溃、**界面上不出现密文原文**（§5.3） |
| 10 | 门禁全绿 | `go build ./...` / `go vet ./...` / `go test ./...` 全包 ok；mobile vitest 全绿；`tsc --noEmit` 干净；`build:h5` / `build:app` 通过；两条发布前检查无输出 |

## 7. 风险与红线

### 7.1 残余风险（照实写，不粉饰）

| # | 风险 | 现状与处置 |
|---|---|---|
| 1 | **通信关系元数据公开**：节点可见「谁在何时给谁发了多大一条密文」 | 这是选「收件人 id 寻址 + 索引匿名可读」的明确代价（§4.2），与 #9 小组同口径；内容仍不可读。须写入隐私政策 |
| 2 | **好友码即密钥券**：谁拿到码谁就能解密该会话 | 定向校验（`peer_id`）只防「第三方转发」，不防「会话双方之一主动外泄」。与 #9 组码同类风险，本册收窄了转发面但未消除 |
| 3 | **无前向安全、无密钥轮换**：密钥一旦泄露，该会话全部历史密文可解 | 本册刻意不做轮换（§3.2 的理由）；要换钥须另立册子 |
| 4 | **断网读不到历史正文** | 「不缓存他人正文」的必然结果（§5.1），与小组一致；若日后要离线可读，另立册子落地总纲 §9 的 `messages` 表 |
| 5 | **本地密钥不抗本机取证** | KEK 与密文同库，不抗 root / 越狱（#4 既有承认，非本册新增） |
| 6 | **② 类不可审**：滥用无法在节点侧发现 | 总纲 §12 第 9 条既有口径；治理只能靠客户端举报与自行断绝往来（无拉黑，见 §8） |

### 7.2 红线

1. **节点不得尝试解密私信、不得为其建立任何明文派生索引**（总纲 §3 第 3 条）。
2. **会话密钥绝不写入节点**——这与 #9 的 `roster` 事件不同：私信没有任何密钥类投影，节点侧零新表零新列（§4.3）。
3. **禁 `PRAGMA key` / `rekey` / `hexkey`** 同族（#4 定案红线），本地密钥只用应用层列级加密。
4. **不得把密文写进日志或错误文案**；文案一律是「无法解密 / 索取好友码」这类不含载荷的表述。
5. **验签通过之前不得落块**（与 comment / group 同一次序）。
6. 本册**不引入非对称加密、不新增密码学实现**——密码学路径与 #9 完全一致（§5.2）。

## 8. 明确不做

已读回执；消息撤回 / 编辑 / 删除；引用回复（`reply_to`）；附件（图片 / 语音 / 文件）；群聊与广播；拉黑与举报入口；未读数与本地已读状态；本地消息缓存（总纲 §9 的 `messages` 表，延期不取消）；密钥轮换与前向安全；多设备同一身份；成员准入读控制；节点托管密钥包；跨节点名册类同步；iOS；内容包规范 v1 的任何变更。

## 9. 回填清单（本册随附完成）

1. **总纲**：新增 `## 0.` 一节（§0.6）登记 §0.2 的两处口径对齐；§8.2 表格「私信正文（本地持久化）」一行改口为「**不适用**（2026-09-29 §0.6：私信册子不缓存正文；该形态延期不取消）」；§9 本地表清单 `messages` 行加注「**2026-09-29 §0.6：本册不落地**——私信册子不缓存他人正文，本表**延期不取消**」。
2. **`docs/README.md`**：§3 文档清单新增本册行（第 32 行：职责 / 明确不做什么 / 依赖 / 状态）并把原第 10 行占位行的状态由「待写」改指本行；§4 依赖图把 `私信 (#10)` 补为「册子 #32 已定稿 → 计划待出」；§5「风险前置」与本册所对应的「下一步（关键路径）」段同步口径（计划编号待出计划时回填）。
3. **本册 §0.3 / §4.4 / §5.2** 已在写计划阶段同步回填（F5′/F6′ 两处缺陷级缺口与 6 条口径填空）；§0.2 在计划执行结束时回填执行期更正（若有）。
