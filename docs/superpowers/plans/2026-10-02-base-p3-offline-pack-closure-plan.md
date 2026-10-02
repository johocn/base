# P3 首批「离线包闭环」（实施计划 #73）

- 日期：2026-10-02
- 上游：路线计划 `#70`（§1 P3 行、§3.2 附表、§5 节点职能清单）；任务级计划 `#72`（§8.5 待办 1「TLS 边界缺陷」）
- 状态：**已执行**（完整度见 §9「执行实况」）
- 范围：**P3 首批**。P3 余下批次（HTTP 全量面 / 对端同步·反熵 / 门户页）**不在本册**，另立任务级计划。
- 性质：任务级计划。契约一律回册子，本册不承载契约。

## 1. 本批为什么这么切

Go 侧 P3 面 ≈ 25k 行（`internal/httpapi` 10,960 / `internal/store` 8,986 / `internal/peersync` 2,784 / `internal/importer` 1,819 / `internal/packexport` 1,161 / `cmd/based` 887 / `web` 127），一次做完不可验收，必须切批。

`#70 §1` 的 P3 退出准则有两段，其中「Go 版与 Node 版对同一数据集产出**同一份包**」是唯一**可字节级自证**的段落，且是读面 / 写面 / 对端同步面的共同底座（store 写入面 + 协议序列化 + 打包确定性）。故首批取它。

**用户已定（2026-10-02 本册开工前）**：

| 决策 | 取 |
|---|---|
| 首批边界 | 离线包闭环（import / export / release + tls-cert / store-key / pubkey） |
| TLS 边界缺陷修法 | 新增 `TlsConfig` 返回类型 |
| 「同一份包」验收强度 | **逐字节比对** |

## 2. 开工前已取证

### 2.1 逐字节等同**已实测成立**（本批最大风险已解除）

探针（临时文件已删）：

1. Go 侧产出真实包：`based.exe import-md -dir seed -data .tmp/p3probe` → `based.exe export -sign-key 11…11 -issuer probe -issued-at 2026-01-01T00:00:00Z -data .tmp/p3probe`
   ⇒ `pack_id=395f63a2d4431a76b47afe251c8feb76`、`content_version=1`、`entries=3`、`merkle_root=b5b867a806ecbe6e33384b30f7dd30e00811421f4936f0eb3eccd9fb7e86ff2a`、
   `pack.sqlite sha256=2a22baab4e535d5ad3f4fca071e3a7e055f7c5cfc4731cd83ab48107fd7b3071`（45056 字节）、
   `manifest.json sha256=a3e9c4689d78645cb502cb9bbb75ac4111750910ce98e233f377960f6d23c83a`。
2. 读该 `pack.sqlite` 头：`page_size=4096`、`schema format=1`、**offset 96 的 SQLite 版本号 = 3053004 = 3.53.4**。
3. `node-sqlite3-wasm@0.8.60`：`select sqlite_version()` → **`3.53.4`**（与 `modernc.org/sqlite v1.59.0` **同版本号**），`VACUUM INTO` 支持。
4. 用 Node 侧按 `packDDL` 原样建表 + 按 Go 产物行序回插 + `PRAGMA page_size=4096` / `journal_mode=OFF` / `synchronous=OFF` + `VACUUM INTO` 重建 ⇒ **sha256 完全相同**（`2a22baab…`），`sqlite_master` 的 DDL 文本逐字一致。

⇒ 判据成立，本批按**逐字节**验收，**不**退到「只比 `pack_id` + `merkle_root`」。

**残余风险（须在 Task 3 复核，不得默认通过）**：上面对照的是「同版本 SQLite + 同 pragma + 同 DDL 文本 + 同插入序」；MD5 之外，`journal_mode=OFF` 下若中途有 WAL/回滚日志残留、或 `VACUUM INTO` 的临时文件名/顺序不同，都可能引入字节差。故 Task 3 的验收必须是**端到端**（Node 从零导出 vs Go 从零导出），而非复用本次探针结论。

### 2.2 决定移植结构的事实

| 事实 | 取证 | 约束 |
|---|---|---|
| TEXT 列**静态加密落盘**（L4a′） | `internal/store/crypto.go:16-28,180-224`：AES-256-GCM，`nonce(12)‖ct‖tag(16)`，TEXT 列加 `enc:v1:` 前缀 + base64；无前缀视为历史明文行 | Node 侧必须实现同一 AEAD 才能解密导出。`node:crypto` 的 `aes-256-gcm` 同算法，`createCipheriv` 输出 `ct‖tag`，前置 12 字节 nonce 即同构 |
| store key 是 data 目录的**兄弟文件** | `crypto.go:48-52`：`filepath.Clean(dataDir) + ".key"` | Node 侧同路径同格式（hex + `\n`，权限 0600） |
| 密钥优先级四档 | `crypto.go:86-121`：显式参数 → `BASE_STORE_KEY` → `BASE_STORE_KEY_FILE` → `<data>.key`（缺失即生成并写盘） | 逐一对齐 |
| `pack.sqlite` 只有 5 张表 + 4 条 meta | `packexport/export.go:21-64` | 列顺序必须与 `internal/store/schema.go` 一致；导出白名单是**集合式**判断，不放宽成前缀/正则 |
| 条目**按 item_id 排序**后导出 | `export.go:108` | 决定确定性 |
| 内容包内是**明文** | `export.go:276-278` 写 `a.BodyMD`；`store.go:489-518` 已解密 | 「跨过 store 边界一律明文」 |
| 表结构演进靠列存在性检查补列 | `schema.go:306-368` | Node 侧复刻；**索引必须在补列之后建** |
| `Open` 建 `blobs/`、`packs/` | `store.go:122-170` | 逐一对齐 |
| `ListItems(state)` 按 `item_id ASC` 且可过滤 state | `store.go:411-426` | 导出取 `ListItems("active")` 后再滤 `dist_class` |
| **Node 驱动打不开 WAL 库** | 实测：`node-sqlite3-wasm@0.8.60` 的 WASM VFS 无 `xShmMap`，对 WAL 库（头字节 18/19 = `2,2`）读写均报 `unable to open database file`；URI `?immutable=1` / `?mode=ro` 也不通。而 Go store 固定 `journal_mode(WAL)`（`store.go:147`，且 §7 禁改 Go） | `openStore` 在打开前做一次 **WAL→rollback 头归一化**（只改主库头 2 字节，等价 `PRAGMA journal_mode=DELETE` 的落地状态，不碰数据页）；存在 `-wal`/`-shm` 残留（对端未干净退出或并发写）即 fail-fast。Node 自身全程 `journal_mode=DELETE` |

### 2.3 TLS 边界缺陷（本批必修）

现状 [server.ts](file:///e:/code/base/packages/core-ts/src/platform/server.ts#L51-L59)：`serverConfig` / `clientConfig` 返回 `TlsMaterial`（只有 `certFile` / `keyFile`）。而 Go 侧两条策略**都无处承载**：

- `ServerTLSConfig(info, peerFingerprints)`（`tlscfg.go:170-182`）：白名单非空时 `ClientAuth = RequireAnyClientCert` + `VerifyPeerCertificate = PeerVerifier(白名单)`；
- `ClientTLSConfig(own, peerFingerprintHex)`（`tlscfg.go:188-199`）：`InsecureSkipVerify = true` + `VerifyPeerCertificate = PeerVerifier([单指纹])` + 带本节点证书。

`#72 §8.5` 已登记「P3 双向 TLS 前必解」。处置见 §3.1。

## 3. 定死项（本批不得再议）

### 3.1 `TlsConfig` 二次冻结（修完即终态）

`packages/core-ts/src/platform/server.ts` 增：

```ts
/**
 * TLS 配置描述符：Go `*tls.Config` 的可断言形状。
 * - `peerFingerprints` 非空 ⇒ 要求对端提供证书，且其 DER 的 sha256 命中白名单
 *   （服务端 = RequireAnyClientCert + 指纹固定；出站 = 单元素白名单）
 * - `trustPeerByFingerprint` ⇒ 对端证书**不**由系统 CA 校验，信任完全由 `peerFingerprints` 承担
 */
export interface TlsConfig extends TlsMaterial {
  peerFingerprints: string[];
  trustPeerByFingerprint: boolean;
}
```

改动面（**一次到位，之后不再改**）：

| 项 | 改法 |
|---|---|
| `TlsAdapter.serverConfig` | `(info: TlsInfo, peerFingerprints: string[]) => TlsConfig` |
| `TlsAdapter.clientConfig` | `(own: TlsInfo, peerFingerprintHex: string) => TlsConfig` |
| `ListenOptions.tls` | `TlsMaterial` → `TlsConfig` |
| `TlsMaterial` | **保留**（`TlsInfo extends TlsMaterial` 与 `loadOrCreate` 入参均不变） |
| `verifyPeer` / `nodeKeyMatches` | 签名不变 |

**不再新增任何字段**。本批落地后该组边界冻结为终态（对齐 `#70 §3.2`「P3 起不得再改这组边界」）。

### 3.2 分层线（谁放 core-ts，谁放 apps/node）

| 内容 | 落点 | 依据 |
|---|---|---|
| 导入解析（front matter / `item_id` 派生 / segments 切分 / `content_hash`） | `packages/core-ts/src/importer/` | 纯算法 |
| 包装配（entries 组装 / merkle / manifest 签名 / meta 行） | `packages/core-ts/src/packexport.ts` | 纯算法 + 协议核 |
| store 的 **SQL 语句与行映射纯函数** | `packages/core-ts/src/store/` | 业务规则 |
| SQLite 驱动、文件 IO、AES-256-GCM、X.509 自签 | `apps/node/src/host/` | 宿主相关；核内禁 `node:` |
| 全量 schema DDL + 列迁移 | `apps/node/src/store/schema.ts` | 节点数据面；Go 副本在 P5 退役前并存 |

**不新增任何适配器接口**（守住 `#72` 的冻结面）。核内不得 `import "node:*"`。

### 3.3 输出文案逐字对齐

六条命令的 stdout 模板字符串**逐字**照抄 Go（`cmd/based/*.go`），因为它们是人工核对面。命令名沿用 Go 的 `main.go:16-42` 分发表（`version` / `import-md` / `import-video` / `export` / `release` / `serve` / `pubkey` / `store-key` / `tls-cert` / `peer-sync` / `scrub`）。**本批只实现**：`version`（已有）、`import-md`、`export`、`release`、`pubkey`、`store-key`、`tls-cert`；其余仍走「未知命令 → usage + 2」。

## 4. Task 拆解

### Task 1：`TlsConfig` 边界修补 + `tls-cert` 自签生成

- **core-ts**：按 §3.1 改 `platform/server.ts`；`platform/adapter.ts` 不动。
- **apps/node**：[host/tls.ts](file:///e:/code/base/apps/node/src/host/tls.ts) 实现 `serverConfig` / `clientConfig` 返回 `TlsConfig`；`loadOrCreate` 补**自签生成**（证书不存在则生成）：
  - ECDSA P-256；自签 X.509，`CN=base-node`、`O=base`、`IsCA=true`、`BasicConstraintsValid`、
    `KeyUsage = digitalSignature|certSign`、`ExtKeyUsage = serverAuth|clientAuth`、
    `DNSNames=["base-node"]`、`IPAddresses=[127.0.0.1, ::1]`、serial 128-bit 随机、
    `NotBefore = now-1h`、`NotAfter = now+10y`；
  - 证书 0644 / 私钥 0600，PEM（`CERTIFICATE` / `EC PRIVATE KEY`），父目录 `MkdirAll 0755`；
  - Node 20 无内置证书生成 ⇒ 手写最小 DER 编码器（**不引第三方依赖**）。
- **apps/node**：`schema.ts` 之外新增 `cli/tls-cert.ts`：`init` / `show` / `rotate`，语义照 `cmd/based/tlscert.go:19-81`（`init` 已存在即报错、`rotate` 备份为 `<path>.<20060102T150405>.bak` 后生成、`rotate` 追加一行提示）。
- **单测**：`verifyPeer` 空名单 fail-closed；`nodeKeyMatches` 等长/常量时间；`loadOrCreate` 幂等（二次调用指纹不变）；`create` 出的证书能被 `X509Certificate` 解析且 **DER sha256 自洽**。
- **跨实现验收**：Node 生成的证书目录，用 `based.exe tls-cert show -data <同目录>` 输出的 `fingerprint` / `pairing_code` 必须与 Node 输出**逐字一致**（反向亦然）。

### Task 2：store 数据层（apps/node）

- `store/schema.ts`：全量 `schemaStatements` + `eventIndexStatements` + 四组 `ColumnMigrations`，照抄 [schema.go](file:///e:/code/base/internal/store/schema.go)（DDL 文本必须逐字相同——`VACUUM INTO` 的对照已证明 DDL 文本会进 `sqlite_master`，字面差异会直接改变包字节）。
- `host/storekey.ts`：三源优先级 + `parseStoreKey`（32 字节 hex）+ 生成 + 写盘（hex + `\n`，0600）。
- `host/aesgcm.ts`：`encrypt` / `decrypt` / `encText` / `decText`（`enc:v1:` + 标准 base64）。字节层**复用** `protocol-ts` 的 `seal` / `open`，不重写 GCM（该文件注释已钉死「手机与节点共用」）。
- `host/sqlite.ts`：驱动封装 + `normalizeJournalMode`（见 §2.2 末行 / §6 风险 7）。
- `store/store.ts`：`open` / `close` / `listItems(state)` / `lookupIdentities(ids)` / `declaredChunks` / `bumpContentVersion` / `packsDir` / `listTombstones` / `listArticles(ids)` / `listQuizzes(ids)` / `getMediaMeta` / `listSegments` / `insertPack` / `upsertArticle` / `storeKeyPath` / `storeKeyHex`；`storeKeyStatus(dataDir)`（只读、不建文件）。
- **验收**：Node 打开 Go 建的 `.tmp/p3probe`，逐表 dump（含解密后的 `body_md`）与 Go `export` 产出的 `pack.sqlite` 同名表**逐行相同**；反向 Node 写 → `based.exe export` 读回 `body_md` 逐字相同。

### Task 3：packexport + importer（core-ts）+ `export` / `import-md` 接线

- **core-ts** `packexport.ts`：`Export(reader, writer, options)`；算法照 [export.go](file:///e:/code/base/internal/packexport/export.go#L88-L221)，含条目排序、`dist_class`/白名单校验、`DeclaredChunks` 填 `chunks`、merkle、`BumpContentVersion`、`DerivePackId`、manifest 签名 + `Canonicalize`、`InsertPack`。
- **core-ts** `importer/`：`Run(store, dir, options)`；照 `internal/importer/{md,course,quiz,video}.go`（非测试 922 行）。**本批只接线 `import-md`**（`import-video` 的 CLI 保留未实现）。
- **apps/node**：`cli/import-md.ts`、`cli/export.ts`；`export` 的 pack 写出用 `node-sqlite3-wasm`，pragma 序列与 `VACUUM INTO` 步骤照 [export.go:223-377](file:///e:/code/base/internal/packexport/export.go#L223-L377)（先写 `path + ".tmp"` 再 `VACUUM INTO path`，最后删 tmp）。
- **验收（本批核心门禁）**：对**同一份 data 目录**（由 Go `import-md` 建），
  - Node `export` 与 Go `export` 的 `pack.sqlite` / `manifest.json` **sha256 完全相同**；
  - 再反向：Node `import-md` 建的 data 目录，Go `export` 与 Node `export` 的包**同样相同**（证明导入侧也同构）。

### Task 4：`release` / `pubkey` / `store-key` CLI + 分发表装配

- `cli/release.ts`、`cli/pubkey.ts`、`cli/store-key.ts`，stdout 模板逐字照抄（§3.3）。
- `main.ts` 的分发表补齐到本批七条命令；未实现命令保持「usage + 退出码 2」。
- **验收**：三条命令对同一输入与 Go 的 stdout **逐行相同**（`release` 用同一临时 APK 文件）。

### Task 5：门禁 + 回填 + `commit` / `push`

## 5. 门禁（G1–G8）

| 门 | 判据 |
|---|---|
| G1 | 根 `npm test` 全绿；并给出**用例守恒**（`packages/mobile` 侧不得减少，`apps/node` 新增计数） |
| G2 | 根 `npm run typecheck`：`protocol-ts` / `core-ts` / `node` 各 0 错误；`mobile` 仅 `#62` 决策 12 登记的 2 条册外既有 `.vue` 错误 |
| G3 | `packages/core-ts` 非测试源码**导入级零宿主依赖**（无 `uni` / `plus` / `node:`；注释命中单独列出，不粉饰为字面零命中） |
| G4 | **逐字节**：Node `export` 与 Go `export` 对同一 data 目录产出的 `pack.sqlite` + `manifest.json` sha256 全等（双向：Go 建的库 + Node 建的库） |
| G5 | **`tls-cert` 互认**：Node 生成的证书，`based.exe tls-cert show` 与 Node 输出 `fingerprint` / `pairing_code` 逐字一致 |
| G6 | `vectors/v1/` **13/13** 仍由协议核消费（P1/P2 零回归） |
| G7 | `git diff --stat -- internal/` **无输出**；四项禁碰文件未入暂存（见 §7） |
| G8 | 七条命令 stdout 与 Go **逐行相同**（`version` / `import-md` / `export` / `release` / `pubkey` / `store-key` / `tls-cert`） |

## 6. 风险与处置

| # | 风险 | 处置 |
|---|---|---|
| 1 | 端到端导出仍有字节差（探针只覆盖了重建路径） | G4 双向取证；**不通过不改判据**，逐字段定位（pragma 序 / meta 行序 / DDL 文本 / 事务边界）后修到通过 |
| 2 | Node 侧手写 DER 自签证书与 Go 生成的不等价 | G5 只要求**互认**（指纹/配对码一致），**不要求**证书字节相同（ECDSA 签名含随机 k，字节必不同） |
| 3 | `internal/importer` 的 `course` / `quiz` 派生在 `import-md` 路径下的实际触发面比预想大 | Task 3 先按 `md.go:151-278` 逐行走；若发现派生写库超出本批（如写 `tag_links` / `directory_terms`），**登记并只实现导出所需的最小面**，不顺手扩 |
| 4 | `node-sqlite3-wasm` 的 `VACUUM INTO` 在带 BLOB/大文件时不稳 | 本批数据是 seed 的 3 篇 markdown，无大 blob；Task 3 加一例带 `media_meta` 的用例 |
| 5 | store key 自动生成导致两侧密钥不同、解密失败 | 验收统一**先固定** `BASE_STORE_KEY` 环境变量再跑双侧 |
| 6 | 全量 schema DDL 复制被误当「双份核心」 | `#70 §9`「不为兼容保留双份核心」指 **TS 侧不得有第二份**；Go 副本在 P5 退役前属计划内并存，本册 §3.2 已钉死落点 |
| 7 | Node 驱动不支持 WAL，与 Go store 的 WAL 落盘格式不兼容 | **用户 2026-10-02 定：就地归一化（方案 A）**。`normalizeJournalMode` 只改主库头 2 字节、不碰数据页，幂等；有 `-wal`/`-shm` 残留则 fail-fast。P5「Node 接管存量数据目录」前必须先落地此迁移，不得留到 P5 现场 |

## 7. 文件清单与禁碰

**新增**：`packages/core-ts/src/packexport.ts`、`packages/core-ts/src/importer/*`、`packages/core-ts/src/store/*`、`apps/node/src/store/*`、`apps/node/src/host/{storekey,aesgcm,sqlite,der}.ts`、`apps/node/src/cli/*`

**修改**：`packages/core-ts/src/platform/server.ts`、`packages/core-ts/src/index.ts`、`apps/node/src/host/tls.ts`、`apps/node/src/main.ts`、`apps/node/src/smoke.test.ts`、`apps/node/package.json`（Task 2 加 `@base/protocol-ts` 依赖）、`docs/README.md`、本册

**不碰**：`internal/**`、`.gitignore`、`based-linux-amd64`、`based.exe`、`apps/mobile/src/pages/**`、`apps/mobile/src/core/**`（P2 shim 已冻结）、`packages/protocol-ts/src/**`

## 8. 不做

- 不做 P3 余下批次：HTTP 全量面（约 40 条）、对端同步 / 反熵（`sync` / `fetch` / `scrub` / `event-sync`）、门户页（`/`、`/a/*`、`/governance`）、`import-video`、`serve`、`peer-sync`、`scrub` 的**新实现**。
- 不删 Go 实现；不改任何 Go 文件。
- 不改内容包规范 v1、不 bump `schema_version`、不加配置项、不做 iOS。
- 不为兼容在 TS 侧保留双份核心（过渡期只用转发，不复制逻辑）。
- 不改 `#72` 冻结的客户端 `Adapters`；`ServerAdapters` 只按 §3.1 改 `TlsConfig` 一处。

## 9. 执行实况（2026-10-02）

**状态：已执行**（Task 1–5 全部落地，本批七条命令齐：`version` / `import-md` / `export` / `release` / `pubkey` / `store-key` / `tls-cert`）。

| Task | 产出 | 提交 |
|---|---|---|
| 1 | `platform/server.ts` 的 `TlsConfig` 二次冻结 + `host/der.ts`（手写最小 DER）+ `host/tls.ts` 自签生成 + `cli/tls-cert.ts` | `7d3c53d` |
| 2 | `store/schema.ts` 全量 DDL + 列迁移 + `host/{storekey,aesgcm,sqlite}.ts` + `store/store.ts` + Go↔Node 双向取证 | `9936131` |
| 3 | `core-ts`：`packexport.ts` + `importer/{frontmatter,md}.ts`；`apps/node`：`host/packsqlite.ts` + `cli/{export,import-md}.ts` + G4 逐字节双向门禁 | `d5f9cca` |
| 4 | `cli/{release,pubkey,store-key}.ts` + `main.ts` 分发表补齐七命令 + `host/cli.ts` 的 `USAGE` 逐字对齐 `main.go:47` | `bb30aa4` |
| 5 | 门禁 G1–G8 + 本册 §9 回填 + `docs/README.md` 登记 | 见本次提交 |

### 9.1 门禁 G1–G8（逐条通过）

| 门 | 结果 | 证据 |
|---|---|---|
| G1 | 通过 | 根 `npm test` 全绿：**4 包 / 56 文件 / 617 用例** = protocol-ts 9/156 + core-ts 35/371 + mobile 3/37 + node 9/53。**用例守恒**：`packages/mobile` 37 与 P2 持平未减少；core-ts 339→371（+32）、node 12→53（+41） |
| G2 | 通过 | 根 `npm run typecheck`：protocol-ts / core-ts / node **各 0 错误**；mobile 仅 `#62` 决策 12 登记的两条册外既有 `.vue` 错误（`governance.vue` 缺 `directory_add`、`submit.vue` 的 `tag`），未新增 |
| G3 | 通过 | `packages/core-ts` 非测试源码 `from "node:"` / `require("node:")` / `uni` / `plus` **零命中**（导入级） |
| G4 | 通过 | 逐字节双向：方向 1（Go 建库）两侧 `pack.sqlite=932244ea…` / `manifest.json=799f3eff…`；方向 2（Node `import-md` 建库）两侧 `pack.sqlite=fda7fc06…` / `manifest.json=7b517e1d…`，`pack_id` / `cv` / `entries` / `merkle_root` 亦全等 |
| G5 | 通过 | `apps/node/src/host/tls.test.ts` 的「跨实现互认（G5）」：Node 生成证书 → `based.exe tls-cert show` 的 `fingerprint` / `pairing_code` 与 Node 逐字一致；反向亦然 |
| G6 | 通过 | `vectors/v1/` **13/13** 全部仍被协议核消费（`vectors.test.ts` 9 个 + `aead`/`attrs`/`markdown`/`progress` 各 1），45 用例全绿（P1/P2 零回归） |
| G7 | 通过 | `git diff --stat -- internal/` **无输出**；`.gitignore` / `internal/httpapi/web.go` / `based-linux-amd64` / `.tmp/` **均未入暂存** |
| G8 | 通过 | 七命令 stdout 与 Go 逐行相同（命令级取证见各 Task 的单测）：`version`（`based 0.1.0`，源级同值）、`import-md`、`export`、`release`、`pubkey`、`store-key`、`tls-cert` |

> G4 / G8 的 `export` 判据说明：`export` 在 `Version=0` 时会自增 `content_version`，同一目录导两次必得不同 `pack_id`，故两侧各用**等价副本**；stdout 中的路径随之不同，逐行比对取「路径以外的每一列全等 + 落盘 sha256 全等」。

### 9.2 执行期发现（登记，不在本批修）

1. **根目录 `based.exe` 陈旧**：构建于 2026-09-27 16:03，早于 `article/` 命名空间变更（`82f303f`，2026-09-28），故其 `import-md` 产 `article:<slug>` 形态的 `item_id`，而 Node 按现行源码产 `article/<slug>`。**影响仅限 §2.1 探针的绝对值**（`fda7fc06…` vs 探针期 `2a22baab…`）；G4 的判据（同一 data 目录两侧导出全等）**两向均成立，不受影响**。按 §7「不碰 `based.exe`」，本册不重建二进制，留待 P5 退役前复跑时一并更新 §2.1 探针值。
2. **`importer` 的容器/题库/视频派生未接线**：本批 `import-md` 只实现**无 course 的文章路径**；遇 `course` 归属、`type: quiz`、`-retire-legacy` 一律 fail-fast（不静默产出与 Go 不同的包）。`course`/`lesson`/`category` 容器重建与 `import-video` 属 P3 余下批次。
3. **未知 flag 的退出码**：Go 用 `flag.ExitOnError`（退出码 2），Node 经 `CliHost` 统一抛错为 1。仅影响「未知 flag」路径，不在 G8 断言范围；`CliHost` 的错误码语义属 `#72` 冻结面，本册不改。
