# base 身份 + TLS + 节点静态加密设计（S1 纵切）

- 日期：2026-09-26
- 上游：总纲 `specs/2026-09-25-base-distributed-learning-design.md`（唯一上游，冲突时先改总纲）
- 范围：**客户端自持 Ed25519 身份** + **TLS 信任模型** + **节点静态加密（L4a′）**
- 本册子**不覆盖**：任何互动形态的业务语义（评论 / 进度 / 小组 / 私信）；内容分发与课程体系；手机端本地库加密的最终实现（只定交汇点与退路）

## 1. 范围与不做什么

**做三件事：**

1. 身份：id 派生、客户端密钥生命周期、节点公钥登记、写请求签名认证与防重放、密码托管。
2. TLS：客户端↔节点、节点↔节点；自签证书 + 指纹固定 + 首次配对由人确认。
3. 节点静态加密 L4a′：`internal/store` 层透明 AEAD 封装。

**明确不做：**

- 不做 JWT / session / cookie；节点不签发密钥、不登记私钥、不接触明文私钥。
- 不做 ① 类公开内容的端到端加密。
- 不做 L4b / L4c（应用层每块加密 + 全网共享密钥 / 每节点独立密钥 + 跨节点重加密）。
- 不做互动形态的业务语义；但**验签管线必须在本册子落地并被测试覆盖**（否则 B 阶段无地基）。
- 不做读取鉴权：① 类与身份公钥查询一律匿名开放。

## 2. 身份模型

### 2.1 id 派生（不可变契约）

- `id = hex(sha256(pubkey))[0:32]`，32 个 hex 字符（128 bit）。
- `alg = "ed25519"`（RFC 8032）。一期只允许该值，其他值一律拒绝。
- **节点不分配 id**：id 自证——任何人拿公钥都能算出同一个 id。节点的「登记」只表示「记录在案且可被邻居核对」，不是发号。
- 派生规则写入向量 `vectors/v1/identity.json`（固定种子 → 期望公钥 hex → 期望 id），Go 与 TS 两侧测试同时消费。

### 2.2 客户端密钥生命周期

| 阶段 | 行为 |
|---|---|
| 生成 | 首次需要写入（发评论 / 记进度 / 入组 / 私信）时，App **本地**生成 Ed25519 密钥对。无需注册、无需节点审批、无需联网 |
| 使用 | 私钥永不出设备、永不落明文盘 |
| 本地存储 | `identity.privkey_cipher`：设备侧 KEK 加密后的密文（见 §8） |
| 主动备份 | 私钥导出（助记词或二维码），用户手动触发 |
| 换设备取回 | 用户名 + 密码 → 从节点取回托管密文 → 本地解密（见 §5） |
| 丢失 | **无任何节点可找回**。这是模型前提，不是缺陷 |

### 2.3 节点只登记公钥

- 表 `identities(id TEXT PRIMARY KEY, alg TEXT NOT NULL, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER)`。
- 登记幂等：同 `id` + 同 `pubkey` 重复提交 → 返回既有结果（`registered=false`）；同 `id` + 不同 `pubkey` → 409 `identity_pubkey_mismatch`。
- 节点不做任何与私钥有关的存储或运算。

## 3. 写请求认证（无 JWT、无 session）

### 3.1 签名头

所有需要身份认证的请求统一携带 5 个头，**不用请求体承载签名**（使无请求体的 GET 也能认证）：

| 头 | 说明 |
|---|---|
| `X-Base-Id` | 公钥派生 id |
| `X-Base-Alg` | 固定 `ed25519` |
| `X-Base-Ts` | 客户端 Unix 毫秒时间戳（十进制） |
| `X-Base-Nonce` | 每次请求唯一的随机值，16 字节 hex |
| `X-Base-Sig` | Ed25519 签名（hex），覆盖下述待签字节 |

待签字节 = `canonical({method, path, query, body_sha256, ts, nonce})`：

- `method`：大写，如 `POST`。
- `path`：不含 query 的路径，如 `/v1/identity/escrow/alice`。
- `query`：原始 query string（无则空串）。
- `body_sha256`：请求体原始字节的 sha256 hex；**无请求体时为 `sha256("")` 的 hex**（固定值，不省略）。
- `ts` / `nonce`：与头一致（防头体不一致）。

`canonical` 复用 P0 已实现的 `protocol.Canonicalize`（键排序、无多余空白、拒绝非整数数字与非 ASCII 键）。固定向量写入 `vectors/v1/reqsig.json`（固定密钥 + 固定请求元组 → 期望待签字节 + 期望签名），Go 与 TS 两侧测试同时消费。

### 3.2 节点验签流程（顺序固定，先验后读体）

1. 缺任一头 → 400 `auth_missing_header`。
2. `alg != "ed25519"` → 400 `identity_alg_unsupported`。
3. 查 `identities` 取 `pubkey`；未登记 → 403 `identity_unregistered`。
4. `|now - ts| > 300000ms` → 401 `auth_ts_out_of_window`。
5. `(id, nonce)` 命中近期去重集 → 401 `auth_nonce_replay`。去重窗口 = 10 分钟（时间窗的两倍），落 `auth_nonces(id TEXT, nonce TEXT, seen_at INTEGER, PRIMARY KEY(id, nonce))`，随启动与定期任务清理过期行。**去重键含 id**：否则任一身份可抢先占用他人 nonce，使合法请求被误判重放。
6. 读请求体 → 算 `body_sha256` → 组待签字节 → 验签失败 → 401 `auth_bad_signature`。
7. 全通过 → `ctx.state.identity = id`，业务处理。

### 3.3 错误体

- P0 既有 `writeError` 保持 `{"error": "<人读消息>"}` **不变**（不破坏 P0 验收）。
- 新增 `writeAuthErr`，形如 `{"error": "<人读消息>", "code": "<机器码>"}`，`code` 取值即 §3.2 中的字符串。客户端只依赖 `code`，不解析人读消息。
- 机器码用字符串而非数字段位：与协议「语言中立」一致，Go / TS 共用同一份取值表。

## 4. 密码托管（可选锚定，唯一密钥恢复路径）

### 4.1 客户端侧加密

1. `salt` = 随机 16 字节。
2. `kek = argon2id(password, salt, m=65536 KiB, t=3, p=1, len=32)`。
3. `priv_cipher = AES-256-GCM(kek, enc_nonce=随机 12 字节, 明文=私钥种子)`；`enc_nonce` 作为独立列存储，故 `priv_cipher` 本体即 `ciphertext || tag`。（若未来并入单一 blob，再改为 `enc_nonce || ciphertext || tag`。）

**参数的归属**：`salt` 与全部 KDF 参数由**客户端**决定并随密文一起上传；节点原样存、原样返。换设备时必须能拿回同一组参数，否则无法派生同一 `kek`。

### 4.2 节点侧契约

- 表 `escrow(username TEXT PRIMARY KEY, id TEXT NOT NULL, alg TEXT NOT NULL, salt TEXT NOT NULL, kdf_json TEXT NOT NULL, enc_nonce TEXT NOT NULL, priv_cipher TEXT NOT NULL, updated_at INTEGER NOT NULL)`。
- **节点只存不解释**：不派生密钥、不解密、不校验密码、不记录密码。节点无法判断上传的密文是否正确，也无从判断。
- username 约束：`^[a-zA-Z0-9_]{3,32}$`，全局唯一。
- 写入规则：
  - username 未占用 → 绑定该 `id`。
  - username 已绑定**同一 id** → 允许覆盖（改密码 = 同 id 用新 kek 重新加密后覆盖），更新 `updated_at`。
  - username 已绑定**其他 id** → 409 `escrow_conflict`，不覆盖。
  - 请求的 `id` 未登记 → 403 `identity_unregistered`。
- 读取：**匿名开放**。取回场景恰恰是「本机没有私钥」，若要求签名则鸡生蛋。密文无密码不可读，安全性由 argon2id 参数 + 客户端侧口令强度承担；节点侧加同 IP 限速（默认 10 次 / 分钟）以抬高批量拖取成本。

### 4.3 失联代价

密码遗忘且无备份 = 身份不可恢复，只能新建身份并重新学习（① 类内容不受影响）。此代价写进隐私政策与 App 首次引导。

## 5. 接口契约

### 5.1 `POST /v1/identity/register`（匿名）

请求体：`{"id":"<32hex>","alg":"ed25519","pubkey":"<64hex>"}`

- **不需要签名**：登记只写公开信息，且节点会重算 `sha256(pubkey)[0:32]`，与 `id` 不符即 400 `identity_id_mismatch`。自证，无可篡改。
- 响应：`200 {"id":"...","alg":"ed25519","registered":true|false}`；`registered=false` 表示此前已登记（幂等）。

### 5.2 `GET /v1/identity/{id}`（匿名）

- 响应：`200 {"id":"...","alg":"ed25519","pubkey":"...","created_at":<ms>}`。
- `404 identity_not_found`。
- 用途：验签他人事件、验签私信发送方。

### 5.3 `PUT /v1/identity/escrow/{username}`（需签名头）

请求体：`{"id":"...","alg":"ed25519","salt":"<32hex>","kdf":{"alg":"argon2id","m":65536,"t":3,"p":1,"len":32},"enc_nonce":"<24hex>","priv_cipher":"<hex>"}`

- 响应：`200 {"username":"...","updated_at":<ms>}`。
- `409 escrow_conflict` / `403 identity_unregistered` / `400` 参数非法。

### 5.4 `GET /v1/identity/escrow/{username}`（匿名）

- 响应：`200 {"username","id","alg","salt","kdf":{...},"enc_nonce","priv_cipher","updated_at"}`。
- `404 escrow_not_found`。同 IP 限速。

### 5.5 `GET /v1/me`（需签名头，无请求体）

- 响应：`200 {"id":"...","events":[],"progress":[]}`。
- 本册子阶段 `events` 与 `progress` 恒为**空数组**（结构先定，数据由 B 阶段填充）。

### 5.6 `POST /v1/event`（需签名头）

- 本册子**只落地验签管线与落库骨架**，不定义任何事件类型；`type` 取值与语义由 B 阶段册子定义。
- 未登记 `type` → 400 `event_type_unknown`。

## 6. TLS 信任模型

### 6.1 自签 + 指纹固定

- 客户端↔节点、节点↔节点一律 TLS。
- 节点首启若无 `data/tls/` 证书 → 自签生成（ECDSA P-256）→ 计算证书 SHA-256 指纹 → 生成**配对码**：取指纹前 10 字节 → Base32 → 16 字符，按 4-4-4-4 分组显示（如 `ABCD-EFGH-IJKL-MNOP`）；同时输出 `.onion` 式的完整指纹 hex 供复制。
- 客户端首次连接：接受自签证书，但**必须**由人核对配对码（手输或扫节点浏览页二维码）；核对通过 → 指纹写入本地 `nodes.tls_fingerprint`。
- 之后连接：只接受该指纹，不匹配即断（`tls_fingerprint_mismatch`）。**不提供「忽略」开关**——只能删记录重新配对。

> **落地状态（2026-09-26，Task 15 回填）**：Spike（Task 1）**尚未执行**——验证需要真机与具体 ROM，本机没有可验设备，因此「App 的 HTTP 栈能否接受自签证书、能否固定指纹」仍**未定**。已落地的只有不依赖该结论的部分：节点侧证书生成 / 配对码 / 指纹固定与拒连、节点↔节点双向 TLS + `X-Base-Node-Key`、浏览页与启动日志展示配对码。三条退路（F1 客户端↔节点降级为 HTTP + 签名头、F2 原生插件 pinning、F3 待定）**仍然有效**；若 spike 结论为 F1，需按 `docs/README.md` 硬规则 1 先改总纲再改本节与总纲 §4「传输」一行。§8 的 `nodes` 表与配对交互同样以该结论为前提，结论未定前不实现。

### 6.2 换证书

节点执行 `rotate-cert` → 生成新自签证书 → 浏览页与启动日志显示**新配对码** → 所有客户端需重新配对。旧指纹不会自动接受。

### 6.3 节点↔节点

- 节点清单由配置提供：`BASE_PEERS` = JSON 数组 `[{"url":"https://...","tls_fingerprint":"<hex>"}]`。
- 节点间请求另带预共享密钥头 `X-Base-Node-Key`（内部接口鉴权，与 TLS 指纹是两层，互不替代）。

## 7. 节点静态加密（L4a′）

### 7.1 密钥与封装

- 算法：AES-256-GCM（Go 标准库 `crypto/aes` + `crypto/cipher`，无第三方依赖）。
- 封装格式统一为 `nonce(12B) || ciphertext || tag(16B)`。
- 密钥来源（四级优先级）：`WithStoreKey`（代码/测试注入）→ `BASE_STORE_KEY`（hex64）→ `BASE_STORE_KEY_FILE`（文件路径）→ 默认文件 **`<data>.key`**（`data` 目录的**兄弟文件**，刻意置于 `data` 之外，0600），末者不存在则**首启自动生成**。
- **密钥文件必须在 `data` 目录之外**：`cp -r data` / 只备份 `data` 目录不应连密钥一起拷走。代价是备份**整个安装目录**仍可解密——只有把密钥经 env 注入（`BASE_STORE_KEY` / `BASE_STORE_KEY_FILE`）且不入镜像才能根除。
- `BASE_STORE_KEY_FILE` 指向的密钥文件内容为 hex64（允许结尾换行与大小写）；内容坏 → 报错，不静默回退到默认文件（否则会用一把新密钥去解旧库）。
- 启动日志只回显密钥**前 8 个 hex**（`storeKey=67eed590…`）：完整 hex 写进日志等于把它留在日志文件与运维平台上。需要离线恢复码时用 `based store-key show -data <dir>` 按需取。
- **密钥独立，不派生自签名私钥**：签名私钥丢失不应连带全库不可读，反之亦然。

### 7.2 加密范围

| 对象 | 处理 |
|---|---|
| `data/blobs/<h0..1>/<h2..3>/<blob_id>` | 逐文件封装（整体作为一个密文文件） |
| `data/base.db` 的 `articles.body_md` | 逐列封装，列值以 **`enc:v1:` 前缀 + base64** 存（便于识别历史明文行；无前缀即未加密行，原样读出） |
| `data/packs/` | **不加密**（可由内容库重导出的产物） |
| ② 类密文块 | **不二次加密**（E2E 后已不可读，再包一层只增开销） |
| `identity` 类表（公钥、托管密文） | **不加密**（本就是公开信息 / 已加密密文） |

`segments` / `quizzes` 两张表在本期只有 DDL、没有任何读写代码路径，故不在加密范围内；A 阶段（课程体系）引入写入路径时，**同步接入同一套 `encText` / `decText`** 并在那里补验收，避免留下「有列无加密」的空档。

### 7.3 落点与不变量

- 唯一改动位置：`internal/store`。写时封装、读时拆封，对上层**透明**。
- `internal/httpapi` / `internal/packexport` / `internal/sync` **零改动**；属 P0 已实现代码的复用改造，**不删除**。
- 不变量（必须由测试守住）：
  1. `blob_id` 在**明文**上计算，加密只改磁盘表示 → 去重 / 秒传 / 副本因子 / 反熵 / Merkle 全部不变。
  2. `GET /v1/blob/{blob_id}` 返回**明文**且长度 = `blobs.size`（协议字段语义不变，不能暴露封装长度）。
  3. `GET /v1/catalog` / `manifest` / `pack` 的输出与加密前**逐字节一致**。
  4. 读盘校验顺序：解密 → `sha256(明文) == blob_id`，不符即坏块（scrub 走同一路径）。
- 跨节点仍传**明文** + TLS → **零重加密**。这是 L4a′ 与 L4c 的分界线：一旦要求跨节点也传密文，就退回「解密 → 重加密」，本方案作废。

### 7.4 已知代价

- 正文列加密后不可 SQL 检索 / LIKE（P0 无全文检索需求，影响可接受）。
- 每多一个密钥多一个运维故障点；**权威源节点丢密钥 = 内容不可读**（缓存节点可反熵重拉）。
- 明文列与磁盘密文之间多一次 AES-GCM（AES-NI 下相对磁盘 IO 可忽略）。

### 7.5 升级与轮换

一期**不做密钥轮换**（轮换需全库重写且无收益）。只要求：密钥一旦确定不得变更；变更 = 全库重写，属运维事故处置，不进设计。

## 8. 手机端身份与密钥存放

| 表 | 用途 |
|---|---|
| `identity(id, alg, pubkey, privkey_cipher, kek_source, escrow_username, created_at)` | 本机身份 |
| `nodes(node_id, url, tls_fingerprint, pairing_verified_at, last_seen_at)` | 已配对节点与固定指纹 |

- 私钥**永不**明文落盘：落 `privkey_cipher`，由设备侧 KEK 加密。
- `kek_source` 记录 KEK 来源（设备安全存储 / 用户口令派生 / 二者组合），供 spike 结论回填。**S1 期实际取值为 `"device"`**：KEK = 随机 32 字节，经 `StorageAdapter` 存于应用私有存储（键 `identity.device_kek`），与 `privkey_cipher` 同库。
  - **残余风险（必须诚实标注）**：同库意味着有 root/越狱能力的本地读取可同时拿到 KEK 与密文，此层防护只挡「应用沙箱外的普通读取」。真正的加固属 spike（#4）：落地后**只替换 `deviceKek()` 一个实现**（改走设备安全存储 / 用户口令派生），`saveLocalIdentity` / `loadLocalIdentity` 的调用契约不变。
- 与 §5 的 `escrow` 不同：这里的 `privkey_cipher` 是**本机**密文，`escrow` 是**上传托管**密文，两者可用不同 KEK，互不替代。

## 9. 与手机本地加密 spike（#4）的交汇点与退路

- **交汇点 1（算法与格式复用）**：spike 的退路「敏感表列级加密」与本册子 §7.1 的封装格式、AEAD 算法、参数**必须一致**，实现共用 `packages/protocol-ts` 一侧，并由同一组向量校验。
- **交汇点 2（KEK 来源）**：手机 KEK 与本机私钥的关系（是否由私钥派生）决定「私钥丢失是否连带本地库不可读」，该结论回填 §8 的 `kek_source` 并写进总纲 §8.2。
- **交汇点 3（开关语义）**：本地库加密可自由开关（总纲 §8.2）；开关切换靠**全量重写 + 校验 + 旧文件安全删除**，与节点 L4a′ 无关——节点侧没有开关，必须常开。
- **本册子的退路**：L4a′ 无外部依赖，失败风险极低，无退路设计。真正的风险只在手机侧；若 spike 得出「`plus.sqlite` 无原生加密」，则按退路落地，并保持与本册子 §7.1 的格式一致。

## 10. 验收口径（S1）

| # | 验收 | 判定 |
|---|---|---|
| 1 | 跨节点身份 | 客户端在 A 节点登记，B 节点（无共享状态）能取到公钥并验签通过，且两次算出的 id 相同 |
| 2 | 篡改拒绝 | 签名改 1 bit → 401 `auth_bad_signature` |
| 3 | 重放拒绝 | 同一 nonce 二次提交 → 401 `auth_nonce_replay` |
| 4 | 时间窗 | `ts` 偏移 10 分钟 → 401 `auth_ts_out_of_window` |
| 5 | 未登记拒绝 | 未登记 id 发起写请求 → 403 `identity_unregistered` |
| 6 | id 自证 | `id` 与 `sha256(pubkey)[0:32]` 不符 → 400 `identity_id_mismatch` |
| 7 | 密码托管闭环 | 设密码上传 → 清空本地身份 → 同 username + 密码取回 → 解得同一 id；错误密码解得失败（客户端判定） |
| 8 | escrow 冲突 | 同 username 换 id 写入 → 409 `escrow_conflict` |
| 9 | TLS 指纹 | 指纹不匹配的连接被拒；配对码核对通过后连接成功；无「忽略」路径 |
| 10 | L4a′ 落盘断言 | 直接搜 `data/base.db` 与 `data/blobs/*` 原始字节，断言不含固定测试明文 |
| 11 | L4a′ 透明性 | 加密前后 `blob_id` 相同；`catalog` / `manifest` / `pack` 输出逐字节一致；`/v1/blob` 返回明文且长度 = `blobs.size` |
| 12 | 私钥不落明文 | 设备端数据库与文件中搜不到私钥明文 |
| 13 | 向量双侧 | `vectors/v1/identity.json` 与 `vectors/v1/reqsig.json` 被 Go 与 TS 测试同时消费，任一漂移即失败 |
| 14 | L4a′ 密钥位置 | 默认密钥文件为 `data` 目录的兄弟文件 `<data>.key`；`data/` 内不得出现密钥文件（`cp -r data` 拷不走密钥） |
| 15 | AEAD 格式双侧 | `vectors/v1/aead.json` 被 TS `aead.ts` 与 Go `Encrypt` / `Decrypt` 同时消费：同 nonce 下逐字节一致，且 Go 能直接解开 TS 的 `nonce ‖ ct ‖ tag` 拼接密文 |

验收 9 / 10 / 11 / 12 / 13 / 15 的落点：9 → `tlscfg_test.go`；10 → `store` 的 `assertPlaintextAbsent`；11 / 12 → blob 与 pack 导出的既有断言；13 → `protocol` / `protocol-ts` 的向量消费测试；15 → `crypto_test.go` 的 `TestAEADGoldenVector` 与 `aead.test.ts`。验收 1–8 与 14 由 `internal/httpapi/s1_acceptance_test.go` 覆盖。

## 11. 红线（本册子）

1. 节点永不接触明文私钥、永不签发密钥、永不发 JWT / session。
2. `escrow` 的 nonce 必须独立列存储，不得与 `priv_cipher` 混为一体，避免服务端拆包猜测。
3. `blob_id` 的算法与其输入不可变；静态加密只允许改磁盘表示。
4. L4a′ 密钥不得与签名私钥同源或互相派生。
5. 配对码必须由人确认；不得提供「忽略指纹不匹配」的开关。
6. `escrow` 密文对节点不可读；节点不得记录或校验密码。
7. 客户端私钥不得明文落盘。
8. 本册子不实现互动形态的业务语义，但验签管线必须落地且被测试覆盖。
9. 跨节点传输不得改为传密文（否则退回 L4c，零重加密优势丧失）。

## 12. 已确认项

| 项 | 结论 |
|---|---|
| id 派生 | `hex(sha256(pubkey))[0:32]`，`alg=ed25519`，写入 `vectors/v1/identity.json` |
| 节点身份职责 | 只登记公钥；不签发、不托管明文私钥、不发 JWT |
| 写请求认证 | 5 个签名头；签名覆盖 `canonical({method,path,query,body_sha256,ts,nonce})`；时间窗 300s；nonce 去重窗口 10 分钟 |
| 密码托管 | 客户端 argon2id(65536/3/1/32) + AES-256-GCM；节点只存不解释；同 username 只允许同 id 覆盖；读取匿名 + 限速 |
| TLS | 自签 + 证书指纹固定 + 配对码（指纹前 10 字节 Base32，4-4-4-4）人工确认；无忽略开关 |
| 节点静态加密 | L4a′：store 层透明 AEAD；范围 = blobs + `articles.body_md`；独立密钥（`WithStoreKey` / `BASE_STORE_KEY` / `BASE_STORE_KEY_FILE` / `<data>.key`，密钥文件刻意置于 `data` 之外）；不做轮换 |
| 不做 | L4b、L4c、① 类 E2E、JWT、读取鉴权、密钥轮换 |
| 手机端 | 私钥密文落 `identity.privkey_cipher`；本地库加密的最终实现取决于 spike（#4），格式与本册子 §7.1 对齐 |

## 13. 分期内切（供实施计划使用）

1. `vectors/v1/identity.json` + id 派生（Go/TS 双实现）
2. `internal/auth`：id 派生 + 公钥登记 + 验签
3. 签名头解析与校验中间件 + nonce 去重表
4. 身份接口：`register` / `GET identity` / `escrow PUT/GET` / `me`（含错误码与限速）
5. `internal/store` L4a′ 透明加解密 + 10/11 两条验收
6. TLS：自签生成 + 配对码输出 + 客户端指纹固定（节点浏览页展示）
7. TS 侧：`packages/protocol-ts` 身份与请求签名 + 手机端身份表 + spike 收口