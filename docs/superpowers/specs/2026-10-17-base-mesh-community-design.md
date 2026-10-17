# base mesh 社区设计（近场互传 + 快照降级）

- 日期：2026-10-17
- 状态：设计定案（待实施；实施计划另出，本册不写代码）
- 上游：总纲 `2026-09-25-base-distributed-learning-design.md`（本文 = 其 §8.4 近场互传的展开与定案；术语、块模型、签名体系、事件模型全部沿用总纲，冲突处以本册为准并回写总纲 §0.x）
- 定位：**有节点为中心、mesh 为断网补充**——不是无中心 DHT，节点在线时一切照旧；断网时近场互传保住「读 ① 类内容 + 发评论」两条能力，回连后经代上报汇入节点。

## 0. 背景与决策总览

### 0.1 三个场景（已拍板）

| # | 场景 | 方向 | 载体 |
|---|---|---|---|
| 1 | **类单向内容分发** | 源端 → 接收端（① 类内容：catalog + 块） | 热点 / 同 Wi-Fi 内嵌 HTTP server |
| 2 | **评论 gossip** | 双向（仅 `comment.v1` 事件，append-only） | 同上 |
| 3 | **回连代上报** | 接收端到达任意在线节点后，把断网期收到的评论代为上报（事件带原签名者） | 既有 `POST /v1/event` |

### 0.2 传输方案（已拍板，方案 C）

- **近场实时互传**：热点 / 同 Wi-Fi 内嵌 HTTP server（Android 源端 NIO 非阻塞）。
- **文件快照降级**：物理不可达时走任意文件通道（U 盘 / 网盘 / 聊天文件），复用 pack v1 容器（二期）。

### 0.3 R2 spike 技术验证结论（build 47，2026-10-16/17 实测）

spike 页 `apps/mobile/src/pages/dev/nearby-spike.vue`（一期实现时删除），四场景各 5 分钟、30s 心跳：

| 场景 | 结果 | 结论 |
|---|---|---|
| S1 亮屏+常亮+前台 | **10/10 PASS** | 可作源端 |
| S4 亮屏+常亮+切后台 | **10/10 PASS** | 可作源端（前台/后台无差别） |
| S2 息屏无保活 | 4/10 FAIL | 不可作源端 |
| S3 息屏+CPU锁+白名单 | 6/10 FAIL | 不可作源端 |

- **服务稳定性分界线 = 屏幕亮/灭**，与前台后台无关。息屏是硬死路（WebView JS 节流，CPU WakeLock + 电池白名单救不了），**不做息屏保活**。
- **运营约束（写入产品）**：源端必须**亮屏 + 插电**，UI 显式提示并全程 `plus.device.setWakelock(true)`。
- 息屏期间已建连接不死（进程存活、白名单生效），语义降级为**间歇补传**：能传多少传多少，恢复亮屏后续传。
- NIO 链路可直接进生产，三条铁律（§3.2）。
- **iOS 不做源端**（无 plus.android，NIO 路线不可达）；iOS 可做接收端。

## 1. 信任与密钥

### 1.1 目标

断网互传无 TLS，接收端必须能验证「这份 catalog / 这些块属于权威节点」。建立**单一信任锚**：节点身份密钥，并与在线世界的 TLS 指纹双锚互证。

### 1.2 机制

**M4 定案（二选一写死）：mesh 信任锚 = pack §6.4 的源节点签名私钥，同一把（`BASE_SIGN_KEY`）。**

- 理由：「这份 catalog 是权威节点发的」与「这个 pack 是源节点签的」是同一信任判断；两把密钥 = 两个 TOFU 锚点 + 两份撤销链，成本翻倍、收益为零。
- 节点部署者独持此私钥（总纲 §7.1 既有）；近场互传中节点签名对象 = mesh catalog 与块清单（§3.3）。**节点签 catalog，不签块**——块真伪由内容寻址（`blob_id = sha256`，总纲 §3.2）自证，签名只锚「清单是权威视角」。

**密钥与 TLS 指纹双锚（M5 前半）：**

- `nodes` 表扩列：`nodes(node_id, url, tls_fingerprint, sign_pubkey, authority_order, last_seen_at)`（`sign_pubkey`、`authority_order` 新增；其余沿用总纲 §8.1）。
- 首装 TOFU：**扫码入网**，二维码内容（canonical JSON）：

```
{ "v": 1, "kind": "base-node-enroll",
  "node_id": <hex32>, "url": <https url>,
  "sign_pubkey": <hex64>, "tls_fingerprint": <hex64>,
  "expires_at": <ISO8601，仅二维码有效期> }
```

- 两个锚点同时落 `nodes` 表：在线时走明文 HTTP（总纲 F1），`tls_fingerprint` 是「这个 node_id 是真的」的带外锚；断网时 `sign_pubkey` 是验签锚。扫码同时带入两者，缺一不收。
- TOFU 语义：首次扫码 = 信任建立；之后 catalog 验签公钥必须匹配锚点，不匹配即拒绝并**全屏告警**（可能换锚攻击）。

**撤销链（M5 后半，格式写死、一期实现接口与向量，UI 后置）：**

```
canonical({
  "type": "node-key-rotation", "v": 1,
  "node_id": <hex32>,
  "old_pubkey": <hex64>,          // 旧工作密钥公钥
  "new_pubkey": <hex64>,          // 新工作密钥公钥
  "effective_at": <ISO8601>,
  "issued_at": <ISO8601>
})
cert_id = hex(sha256(canonical 字节))[0:32]
```

- **单级规则（写死）**：`cert` 由**根密钥亲签**；工作密钥自身**无签发轮换权**（`old_pubkey` 必须等于根密钥公钥或当前生效工作密钥公钥，且签发者必须是根密钥——即每把新钥都由根密钥直签，防链式接管）。
- 同一 `node_id` 至多一把生效工作密钥：按 `issued_at` 最新者生效，旧的立即失效。
- 客户端验签公钥集合 = `{root_pubkey, 当前生效 cert 的 new_pubkey}`；catalog 签名者不在集合内即拒绝。
- cert 随 mesh catalog 快照与 pack 一并分发；TOFU 设备收到新 pubkey 时带合法 cert 则更新锚点并提示。
- **密钥备份要求（R3）**：根私钥离线保管 + 口令加密备份（形态同总纲 §12.1.1 恢复码）。工作密钥泄露 → 根密钥亲签新 cert 替换即可；**根密钥泄露无救**——回退到 TOFU 重锚（全员重新扫码 + 运营公告），照实写进运维文档。
- **密钥交接即权威迁移**：根密钥签 cert 把工作权交给新部署者；新部署者持 `new_privkey + cert` 即权威。

### 1.3 mesh 身份与节点账号绑定（M2）

- **不引入新身份体系**：mesh 上的设备身份 = 总纲 §8.1 `identity` 表的同一套 Ed25519 密钥，`id` 由公钥派生。
- 评论 gossip 事件的内容签名 `sig`（覆盖 `canonical({event_id,type,created_at,body})`，总纲 §7.3）即归属证明；**公钥随事件走**，验证方（对端设备 / 节点）不依赖预登记即可验签。
- 节点侧登记：代上报时节点首次见到该 id 即登记公钥（沿用 `POST /v1/identity/register`「首次出现即登记」语义），零新表。

### 1.4 边界（不做什么）

- 不做 PKI / 证书透明 / 多级撤销链（单级写死）。
- 不做匿名身份、不做零知识成员证明。
- 不为 mesh 新设密钥种类（复用 `BASE_SIGN_KEY` + 客户端 `identity`）。

### 1.5 验证

- `node-key-rotation` 与 `base-node-enroll` 的 canonical 字节与签名进 `vectors/`，Go / TS 双侧消费（总纲 §5.3 对齐铁律）。
- 场景：扫码 → 断言双锚落库；篡改二维码任一字段 → 拒绝；轮换后旧工作密钥签的 catalog 被拒、新密钥通过；单级约束断言（用工作密钥再签 cert 必须失败）。

## 2. 多节点权威序

### 2.1 目标

多节点部署下，同一 item 的内容更新必须唯一收敛；节点分区 / 反熵窗口内出现分叉时有确定的仲裁结果。

### 2.2 机制

**单写者模型**：课程 / 课时 / 文章的更新权 = 作者私钥签名（`item_id` + 版本号 `rev` + 新 `content_hash`）。一个 item 只有一个权威写者（节点人 / 运营侧），评论不在此列（append-only，无更新权问题，走 §4 gossip）。

**failover 写序（客户端硬规则，R6）**：

- 客户端按 `nodes.authority_order`（1 起始，小者先）配置节点权威序。
- 写路径：**只写「序首可达」节点**——序 1 可达则只写序 1（序 1 写失败才降级序 2，且降级时记录降级事件）；**不向全部可达节点广播写**。
- 读路径：同样序首优先；序 1 超时（3s）才 failover 序 2。

**分区仲裁细则（S5，节点行为文案化）**：

- 触发条件：同一 `item_id` 同一 `rev`、不同 `content_hash`（反熵窗口内的临时分叉，或节点被入侵后回滚版本）。
- 仲裁规则（写死）：**以权威序最靠前的节点数据为准**；`(rev, authority_order)` 字典序取首，同序位比 `content_hash` 字典序（确定性收尾，防两侧互不相让）。
- 序尾节点行为：发现本地位次靠后的分叉 → **回滚**到序首版本（删本地异 hash 块 + 重新反熵拉取）；回滚动作记日志（`item_id / rev / 丢弃 hash / 保留 hash`）。
- 客户端行为：拉取遇到同 rev 异 hash → 以序首为准落本地，`items` 表记 `conflicted=1`，UI 弱提示「内容已在权威节点修正」；**rev 只进不退**（见 §5.3），序首给出更低 rev 的一律拒绝。
- 防回退锚：客户端不信任任何「rev 变小」的 catalog（无论签名是否合法）——签名合法的 rev 回退只可能来自根密钥泄露，属 §1.2 无救场景，触发全屏告警。

### 2.3 边界

- 不做拜占庭共识、不做投票、不做 Raft / Paxos。
- 不做多写者合并——单写者模型内无此问题。
- 不做自动分叉合并 UI（仲裁是确定性规则，人工介入仅运维日志层面）。

### 2.4 验证

- 3 节点注入同 rev 异 hash → 断言两侧收敛到序首版本、序尾回滚、日志齐全。
- 客户端：序 1 断网写序 2 → 恢复后序 1 呈现新 rev → 客户端以序首 rev 更新；序 1 呈现更旧 rev → 拒绝 + `conflicted` 标记。

## 3. 近场协议（一期：实时面）

### 3.1 目标

Android 源端在**亮屏 + 插电**约束下，经热点 / 同 Wi-Fi 向接收端分发 ① 类内容（catalog + 块），并双向交换评论 gossip（§4）。协议跑在源端内嵌 HTTP server 上（NIO 非阻塞，R2 已验证）。

### 3.2 传输与 HTTP 最小子集（S1 + NIO 铁律）

手写 HTTP（`java.nio.channels.ServerSocketChannel` 非阻塞，plus bridge 上阻塞调用被禁）：

- **请求解析**：只支持 `GET` / `POST` / `HEAD`；request line + headers 按 `\r\n` 切分；body 按 `Content-Length` 截取。解析失败即断连，不回错（省字节的场景不值得回错）。
- **响应三要素（写死）**：必带 `Connection: close`（一请求一连接）、必带 `Content-Length`、支持 `Range: bytes=start-end` 单区间（大块断点续传，命中回 `206` + `Content-Range`）。
- **NIO 铁律（spike 定案，生产沿用）**：
  1. 全程非阻塞：`accept()` 空转返回 `null` 属 Java 语义，静默；单线程 `setInterval` 轮询（200ms）。
  2. plus bridge 的 Java 方法返回对象必须先 `importClass` 对应类再调用。
  3. `close()` 前必须排空入站（未读数据触发 RST 毁掉已写响应，spike 的 curl 56 教训）。
- 端口写死 `8712`；块传输并发 **2–4**（R7：一期取 4，真机实测吞吐后允许下调），总并发连接上限 8（S7）。
- 明文传输无 TLS（局域网内）；内容真伪靠 §1 信任锚 + 块哈希自证（R5 的兜底：手写 HTTP 再错也错不出假内容，错只错在可用性）。

### 3.3 接口定义

路径前缀 `/mesh/v1/`：

| 接口 | 方向 | 说明 |
|---|---|---|
| `GET /mesh/v1/hello?token=` | 接收端 → 源端 | 握手 + token 校验。返回 `{node_id, sign_pubkey, protocol_version: 1, catalog_version, gossip_cursor}`。token 无效 `403`；同源 5 次失败锁 10 分钟 |
| `GET /mesh/v1/catalog?token=` | 接收端 → 源端 | catalog 快照（node 签名，见下）。体例沿用总纲 §7.3 `GET /v1/catalog`（`item_id/source/type/content_hash/rev` 分页，满页给 `next_cursor`） |
| `HEAD /mesh/v1/blob/:blob_id` | 接收端 → 源端 | 秒传判定（同总纲 `HEAD /v1/blob/:blob_id` 语义） |
| `GET /mesh/v1/blob/:blob_id` | 接收端 → 源端 | 取块，支持 Range；返回字节流 |
| `POST /mesh/v1/gossip` | **双向** | 提交 gossip 事件（§4.2） |
| `GET /mesh/v1/gossip?since=<received_at>_<event_id>` | **双向** | 增量拉 gossip 事件（游标体例同总纲 `event-sync`） |

**catalog 签名对象（写死，进 vectors/）**：

```
canonical({
  "type": "mesh-catalog", "v": 1,
  "node_id": <hex32>,
  "catalog_version": <int，单调递增>,
  "entries": [ { "item_id", "rev", "content_hash", "size" } ],
  "signed_at": <ISO8601>
})
```

节点签 catalog（用 §1.1 信任锚私钥）；`rev` 即 manifest 的 `content_version`（总纲 §6.5 同源），不另设版本轴。

**入网 token（M8 后半）**：

- 源端「开始分享」时生成会话期 token（随机 32B hex）；**有效期 30 分钟**，UI 到期自动续签并提示刷新二维码。
- 二维码 = §1.2 enroll 内容 + `"token"` 字段（同一次扫码完成 TOFU + 入网）。
- 限流（S7）：每 token 并发连接 ≤ 8；`hello` 每来源 IP 5 次失败锁 10 分钟。token 只管准入，不进签名体系。
- 源端 UI 前置条件：亮屏常亮已开 + 检测到充电状态（否则阻塞性提示「请插电后分享」，S7 电量约束——电量 < 20% 时弹提示不阻塞）。

### 3.4 内容分发流程（场景 1）

1. 接收端扫码 → 取 `{token, ip, port, node_id, sign_pubkey}` → `hello`。
2. TOFU 校验：`nodes` 表已有该 `node_id` → 比对 `sign_pubkey`；没有 → 提示「新节点，确认信任？」落表。
3. 拉 catalog → 验签（公钥 ∈ §1.2 集合）→ 与本地 `items` 按 `(item_id, rev, content_hash)` 比对。
4. 缺失块：`HEAD` 秒传 → `GET blob`（并发 4）→ 逐块 sha256 校验 → 写应用私有目录 + `blob_index`（总纲 §8.1 既有表）。校验失败即丢弃重拉一次，再失败标记坏块跳过。
5. 落库规则：**rev 只进不退**；新条目直接写入。全程断网状态本地可读（总纲 §8.3 离线路径复用）。

传输对象边界：**只有 ① 类**（`dist_class=public`）。**② 类组内容互传一期不做（M1 写死）**——② 类的密钥分发 / 名单同步无带外方案，硬塞会造成「有密文无密钥」的假可用；留升级位（§6）。

### 3.5 场景形态约束

| 项 | 定案 |
|---|---|
| 载体 | 热点（源端开热点，接收端连入，源端 IP 用 `plus.networkinfo` 取）或同 Wi-Fi（扫码带 IP） |
| 设备发现 | **不做 mDNS / UDP 广播**——二维码带 IP:port，一期零发现协议 |
| 方向 | 一期**单向分发**（接收端不能向源端写内容）；评论 gossip 双向是事件交换，不是内容写 |
| iOS | 接收端可用（`plus.io` + uni.request 请求明文局域网）；源端永不做（R1） |

### 3.6 平台配置清单（M8 前半，实施必查）

| 平台 | 配置 | 说明 |
|---|---|---|
| Android | `AndroidManifest.xml`：`android:usesCleartextTraffic="true"`（或 `networkSecurityConfig` 仅对局域网网段放行） | uni-app 云打包 manifest 源码视图配置；`targetSdkVersion >= 28` 默认禁明文 |
| iOS | `Info.plist`：`NSAppTransportSecurity → NSAllowsLocalNetworking = true` | 仅放行本地网络，不放行全局明文 |
| iOS | 本地网络权限弹窗描述文案（`NSLocalNetworkUsageDescription`） | iOS 14+ 访问局域网设备触发 |
| Android | 热点 / 位置权限：连接他人热点需定位权限（Android 9+ 获取 SSID） | 接收端提示 |

### 3.7 边界（不做什么）

- 不做蓝牙 / Wi-Fi Direct / NFC（`plus` 无可用 API 面，超预算）。
- 不做息屏保活（R2 定案硬死路）。
- 不做 mesh 多跳（A→B→C 转发）——一期是「星型对话」：一台源端对多台接收端，两两直连。
- 不做 ② 类互传（M1）。
- 不做接收端向源端回传内容。

### 3.8 验证

- **Go oracle 对拍（S2）**：`tools/` 下 Go 实现同一近场协议参考实现（consumer 侧），TS 侧解析 / canonical / 验签按同一 `vectors/` 消费；对拍项：mesh-catalog 签名、gossip 事件 canonical 字节、HTTP 响应三要素。
- 真机场景：源端（亮屏插电）分发 100 块 + 1 视频课程 → 接收端断网后可读；Range 断点续传（杀进程重连）；篡改 1 bit 块 → 拒收跳过；token 过期 → `403`。
- 吞吐实测（R7）：并发 2 vs 4 各 3 轮，记录 MiB/s 与失败率，结论回写本册 §3.2。
- 二维码流程：新设备 TOFU 确认弹窗 → 落锚 → 断网验签通过。

## 4. 评论 gossip 与代上报（一期：实时面）

### 4.1 目标

断网区域内互传**评论**（仅评论），回连后把事件汇入节点，全网收敛。归属与防伪造依赖既有内容签名，代上报不产生新的信任模型。

### 4.2 事件模型与收发（场景 2）

- **事件复用** `comment.v1`：线上形态 `{event_id, type, created_at, body}` + 内容签名 `sig = Ed25519_sign(actor_priv, canonical({event_id,type,created_at,body}))`（总纲 §7.3 逐字沿用，不新增签名域）。`event_id` 客户端生成 16 hex，幂等键。
- **gossip 消息形状（写死）**：

```
{ "event": { event_id, type, created_at, body, sig },
  "actor_pubkey": <hex64>,          // 原签名者公钥，随事件走
  "payload_b64": <base64 正文明文>   // ① 类明文，仅 comment.v1 有
}
```

  接收端用 `actor_pubkey` 验 `sig` → 落本地库（正文写块文件 + `blob_index`，事件落 gossip 收件表）。
- **本地新表 `gossip_events`**（一期新增，总纲 §8.1 未有收件侧；**只存收到的他人事件**）：

```
gossip_events(event_id, type, target_id, actor, created_at,
              received_at, payload_cid, payload_path, sig)
```

  **本机所发评论不入此表**——沿用既有 `comment_out` 离线队列回连补报（总纲 §9「离线写讨论 → 联网补发」既有语义），避免双队列重复上报；两路汇合靠节点按 `event_id` 幂等去重。
- **类型枚举留位（S6 前半）**：一期 gossip 只接受 `type=comment.v1`，其余类型**静默丢弃**（不报错、不断连）；`like.v1` / `report.v1` 等为将来升级位，进 gossip 前须修订本册。
- **缓存上限（S3）**：每端 gossip 转发缓存 **500 条 / 7 天**（LRU，双条件任一触顶即驱逐最旧）；驱逐只影响转发，已落本地库的不删。
- **排序与游标（S4）**：按**收账时间**（`received_at`）排序传播，游标 `<received_at>_<event_id>`（体例同总纲 `event-sync`）；本机所发事件参与 gossip 交换时其 `received_at` 取 `created_at`。
- **幂等与合并**：`event_id` 相同即丢弃（先到先得）；不做因果重排，展示按 `(created_at, event_id)` 排（同总纲 §9 LWW 口径的精神，评论无更新语义，天然无冲突）。

### 4.3 回连代上报（场景 3）

- 触发：设备到达任一在线节点（既有连通性检测）→ 自动批量回连，两路并行：
  1. **本机所发**：既有 `comment_out` 队列补报（普通 `POST /v1/event`，**不带** Relay 头——归属即本机）；
  2. **代报**：`gossip_events` 中存在收到的他人事件 → 逐条代上报（带 Relay 头）。
- **代报请求形态**：复用 `POST /v1/event`，事件体原样（`sig` 是原签名者的）；**新增审计请求头**：

| 头 | 值 |
|---|---|
| `X-Base-Relay-For` | 原签名者 id（hex32） |
| `X-Base-Relay-Device` | 代报设备自身 id（hex32） |

- **节点侧（M3 后半）**：验签管线不变（签名头管准入、内容签名管归属）；落库事件行新增审计列 `relay_channel`（`'direct' | 'mesh'`）、`relay_device_id`（可空），**留存 ≥ 6 个月**（与事件本体同生命周期下限，删除策略不得短于 6 个月）。列不删、不 bump `schema_version`（总纲 §0.5 惯例）。
- **风控（R4）**：代上报与直连**同风控、无豁免**——先发后审、频控、同 `payload_cid` 去重、审核通道，全部一致；`relay_channel='mesh'` 不降低任何门槛。审计字段即为此服务：滥用溯源到代报设备。
- **归属不可伪造（R4 兜底）**：代报者没有原签名者私钥，`sig` 验签挡住冒名；`actor_pubkey` 与 `X-Base-Relay-For` 派生 id 不一致即拒（`400`）。
- 幂等：节点按 `event_id` 去重（既有行为），重复回连无副作用。

### 4.4 边界

- 一期 gossip 仅 `comment.v1`；进度 / 点赞 / 举报 / 小组 / 私信不进 mesh（② 类 M1，进度点赞留升级位）。
- 不做多跳洪泛控制（无多跳即无需 TTL）。
- 不做 gossip 事件的编辑 / 删除（append-only；评论删除走节点侧墓碑 + 审核结论，mesh 侧一期不传播墓碑——收件端展示以回连后节点索引为准修正）。
- 缓存上限驱逐后**不补拉**（对端已驱逐的历史评论，以节点索引为准）。

### 4.5 验证

- 场景 E2E：A↔B 断网互发评论各 50 条 → 断言双方各见 100 条（`event_id` 幂等去重后）、重复交换零新增。
- 回连：B 回连节点 → 代上报 → 断言节点库 `relay_channel='mesh'`、`relay_device_id=B`、留存时间戳落库；第三客户端经节点索引读到 A 的评论。
- 风控同权：mesh 来的评论命中审核 reject → 墓碑生效，直连路径行为一致。
- 缓存：灌 600 条 → 断言缓存收敛到 500；7 天前事件被驱逐。

## 5. 快照降级（二期）

### 5.1 目标

物理不可达（无热点 / 无同 Wi-Fi / 跨地域）时的兜底：快照文件走任意文件通道，接收端导入后获得与近场同构的 ① 类内容。**零新容器格式**。

### 5.2 机制（S6 后半：复用 pack v1 容器）

- **快照 = 一次内容包导出**：manifest.json + pack.sqlite + blobs/，总纲 §6 全部沿用；`content_version` 递增、`merkle_root`、Ed25519 签名（§1.1 同一把信任锚）、tombstone 全部照旧。
- **manifest 零改动**：不新增字段，导入路径按既有 pack 导入逻辑识别；「这是一次 mesh 快照」不是内容事实，无需进协议。
- **快照不含 gossip 事件**：评论时效性强、快照价值低；一期定案快照 = 纯内容。评论补齐靠回连节点索引。
- 导出触发：节点后台（总纲 C 阶段可视化后台）或源端设备导出菜单。

### 5.3 导入防回退（M6，写死）

导入端逐条目执行，顺序固定：

1. **验签**：manifest 验签（公钥 ∈ §1.2 集合）失败 → 整包拒绝。
2. **完整性**：`merkle_root` + 行级 `content_hash` 双重校验（总纲 §6.4 既有），任一不符判坏包拒绝。
3. **rev 只进不退**：本地 `items.rev > 快照 rev` → **跳过该条目**（不覆盖、不提示错误，日志记录）；`=` 且 `content_hash` 异 → 按 §2.2 仲裁（记 `conflicted=1`）；`>` → 覆盖写入。
4. **tombstone 照常生效**（总纲 §6.5）：快照带墓碑 → 删本地对应行与块；本地 rev 高于墓碑 `revoked_rev` 的条目不受影响（防旧快照删除新内容）。
5. **来源确认**：TOFU 语义——快照签名者不在 `nodes` 表锚点内 → 提示「来源未知，确认导入？」；在锚内且公钥不匹配 → 拒绝 + 全屏告警（同 §1.2）。

### 5.4 边界

- 不做增量快照 / delta 包（全量快照，接收端靠块级秒传去重省流量）。
- 不做快照内评论、不做加密快照。
- 不做快照合并（两份快照先后导入，逐条目按 rev 规则独立判定）。

### 5.5 验证

- 场景：老内容设备（本地 rev 高）导入旧快照 → 断言零回退、`items` 逐字不变；新快照正常覆盖；tombstone 生效；篡改 1 bit 拒收。
- 幂等：同快照重复导入 → 零副作用。

## 6. 分期交付

### 一期：实时面

| 交付项 | 对应节 |
|---|---|
| 信任与密钥：enroll 二维码、TOFU、`nodes` 表扩列（`sign_pubkey` / `authority_order`）、rotation 接口与向量（UI 后置） | §1 |
| 多节点权威序：客户端 failover 写序、仲裁细则、节点回滚行为 | §2 |
| 近场协议：NIO server（HTTP 最小子集）、hello / catalog / blob / Range、入网 token 与限流 | §3 |
| 评论 gossip：双向收发、`gossip_events` 表、缓存上限、幂等 | §4.1–4.2 |
| 回连代上报：`X-Base-Relay-*`、节点审计列、风控同权 | §4.3 |
| 平台配置：Android cleartext / iOS ATS 清单落地 | §3.6 |
| 源端保活 UI：亮屏常亮 + 插电检测 + 电量提示 | §0.3 / §3.3 |
| Go oracle 对拍 + vectors 新增 | §3.8 |

**一期验收**：真机热点 + 同 Wi-Fi 两场景各一轮全流程（分发 / 断网读 / 互发评论 / 回连代上报 / 第三端可见）；对拍全绿；篡改与 token 负路径全拒。

### 二期：降级面

| 交付项 | 对应节 |
|---|---|
| 快照导出入口（节点后台 / 源端菜单） | §5.2 |
| 导入防回退流水线 + 来源确认 | §5.3 |

**二期验收**：防回退断言 + tombstone + 坏包拒绝 + 幂等。

### 升级位（明确不做，留位）

- ② 类组内容互传（M1）——待密钥带外分发方案成熟后立册。
- gossip 扩类型（`like.v1` / `report.v1` / 进度）。
- 多跳 gossip 与 mDNS / UDP 发现。
- iOS 源端（R1：等原生插件路线成熟）。
- 息屏保活（R2 定案：硬死路，永不立项）。

## 7. 决策自检（评审项映射）

| 项 | 处置 | 落点 |
|---|---|---|
| M1 ② 组内容互传 | 一期不做，写死边界 + 升级位 | §3.4 / §6 |
| M2 mesh 身份 ↔ 节点账号绑定 | 复用 `identity` 同一密钥体系，公钥随事件走 | §1.3 |
| M3 代上报审计 | `X-Base-Relay-For/Device` + `relay_channel` / `relay_device_id` 列，留存 ≥6 个月 | §4.3 |
| M4 节点密钥与 pack 签名密钥关系 | 二选一写死：同一把（`BASE_SIGN_KEY`） | §1.2 |
| M5 撤销链 + TOFU | 单级 cert 格式写死进 vectors；扫码双锚（`sign_pubkey` + `tls_fingerprint`） | §1.2 |
| M6 快照导入防回退 | rev 只进不退 + content_hash 双重校验 + tombstone 生效 + 来源确认 | §5.3 |
| M7 源端保活 | R2 spike 四场景实测，运营约束「亮屏+插电」，息屏定案不做 | §0.3 |
| M8 平台清单 + token | Android cleartext / iOS ATS 清单；token 会话期 30min + 限流 | §3.6 / §3.3 |
| S1 HTTP 最小子集 | Connection:close + Content-Length + Range 写死 | §3.2 |
| S2 Go oracle 对拍 | `tools/` 参考实现 + vectors 双消费 | §3.8 |
| S3 gossip 缓存上限 | 500 条 / 7 天 LRU | §4.2 |
| S4 节点排序 | 按收账时间 `received_at` 排序传播 | §4.2 |
| S5 仲裁细则文案化 | 节点回滚日志格式写明 | §2.2 |
| S6 枚举留位 + 容器复用 | gossip 类型白名单留位；快照 = pack v1 零扩展 | §4.2 / §5.2 |
| S7 源端限流 | 并发 ≤8、电量 <20% 提示、5 次失败锁 10min | §3.3 / §3.2 |
| R1 iOS 源端 | 确认约束：永不做（升级位） | §0.3 / §6 |
| R2 息屏保活 | 已解除：spike 定案硬死路，改运营约束 | §0.3 |
| R3 节点私钥泄露 | 根私钥口令加密离线备份；工作密钥可轮换；根泄露无救照实写 | §1.2 |
| R4 代上报滥用 | 同风控无豁免 + 审计溯源 + sig 防冒名 | §4.3 |
| R5 手写 HTTP 正确性 | 块哈希逐块校验 + Range 断点续传测试 + Go oracle 对拍 | §3.8 / §5.5 |
| R6 分叉窗口 | 硬规则只写序首可达 + 确定性仲裁 | §2.2 |
| R7 近场吞吐 | 并发 4 起步 + 真机实测回写 | §3.8 |

## 8. 与总纲的关系（回写清单，实施 PR 时执行）

- 总纲 §8.4 补一句：近场互传定案见本册；一期范围 = 本册实时面。
- 总纲 §7.3 `POST /v1/event` 补代报审计头与 `relay_channel` / `relay_device_id` 两列（M3）。
- 总纲 §8.1 `nodes` 表补 `sign_pubkey` / `authority_order` 两列、新增 `gossip_events` 表（一期收件侧）。
- 总纲 §10 C 阶段拆分：C1 = 本册一期实时面，C2 = 本册二期降级面。
- 新增签名域常量：`mesh-catalog`（canonical 对象自带 `type` 字段，无需新签名域常量，与总纲「不新增签名域」惯例一致——`govern.v1` 同例）。
