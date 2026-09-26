# base S1 实施计划（身份 + TLS + 节点静态加密）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 base 以「客户端自持 Ed25519 密钥」为唯一身份根：客户端本地生成密钥、id 由公钥派生，节点只登记公钥并用签名头验签（无 JWT）；节点的块文件与文章正文在磁盘上以 AES-256-GCM 密文落盘（L4a′），而公开读接口的输出与加密前逐字节一致；节点间 TLS 用自签证书 + 指纹固定。

**Architecture:** 身份域**不新增服务层**（与既有 `httpapi` 直连 `store` 的分层一致）：id 派生与待签字节作为不可变契约放进 `internal/protocol`，公钥登记/密码托管/nonce 去重的落库在 `internal/store`，验签中间件与限速在 `internal/httpapi`；这两个契约由 `vectors/v1/*.json` 与 TS 侧对齐；L4a′ 全部落在 `internal/store` 一层做透明 AEAD 封装，`httpapi` / `packexport` / `sync` 零改动；TLS 只改 `cmd/based` 与 `httpapi` 的监听方式。

**Tech Stack:** Go 1.23+（CGO_ENABLED=0，`modernc.org/sqlite`、标准库 `crypto/aes` + `crypto/cipher` + `crypto/ecdsa` + `crypto/tls` + `encoding/base32`）、net/http（Go 1.22 路由模式）、TypeScript + vitest + `@noble/curves@1.4.0` + `@noble/hashes@1.4.0`（**不要升 v2**）、uni-app CLI。

**上游契约：** `docs/superpowers/specs/2026-09-26-base-identity-tls-design.md`（本计划把它的接口与不变量钉成可执行步骤）。总纲 `docs/superpowers/specs/2026-09-25-base-distributed-learning-design.md` 为唯一上游。

**已核实的环境事实（执行时直接依赖，2026-09-26 实测）：**

| 事实 | 结论 |
|---|---|
| Go 工具链 | 已安装；`GOPROXY=https://goproxy.cn,direct` |
| **本机同进程回环 TCP 不可用（2026-09-26 实测）** | Go **同进程** listen+dial 100% 超时（`127.0.0.1` / `0.0.0.0` / `::1` 均试过，报 `connectex ... did not properly respond`）；**跨进程**正常（两个独立 exe 互连 OK）；PowerShell 同进程正常；Go 无外网。故 `httptest.NewServer`（服务端与客户端同进程）在本机不可用，且 `go test -c -o dist/x.exe` 另存再跑**同样无效（已证伪）**。**所有 HTTP 测试一律 socket-free**：见 Task 0 的进程内分发基建；TLS 握手断言用 `net.Pipe()` + `tls.Server`/`tls.Client` |
| `.ps1` 含中文 | 必须带 UTF-8 BOM |
| `data/` 现状 | 仓库内只有 `data/packs/*/manifest.json`；**没有** `data/base.db` 与 `data/blobs/` → L4a′ 上线无历史明文迁移负担 |
| `internal/store` 现有表 | `meta` / `items` / `articles` / `segments` / `quizzes` / `media_meta` / `blobs` / `packs` / `tombstones` |
| `segments` / `quizzes` 读写路径 | **全仓库无任何 SELECT/INSERT/UPDATE**（只有 DDL），P0 未实现 → 见下方「规格修正」 |
| `store.Open` 调用方 | `cmd/based/serve.go`、`cmd/based/import.go`、`cmd/based/export.go`、`tools/genvectors`、`tools/migrate`、`internal/store` 测试、`internal/httpapi` 测试、`internal/packexport` 测试 → **签名变更必须向后兼容** |
| 手机端 HTTP 适配器 | `PlusHttp` **只有 GET**（`apps/mobile/src/platform/uni.ts`），无 POST、无证书指纹能力 → 见 Task 1 |

---

## 规格修正（本计划对册子的三处纠正，实施时以此为准，收工后回填册子）

### 修正 1：L4a′ 的加密范围收敛为 blobs + `articles.body_md`

册子 §7.2 列了三个正文列。实测 `segments` / `quizzes` 两表**在 P0 无任何读写代码路径**（`internal/store` 与 `internal/packexport` 里只有 DDL；`packexport` 只从 `articles` 取正文）。对一个没有写入路径的列做加密，无实现位置，属空转。

**结论：** S1 只加密 `articles.body_md`。`segments.text` / `quizzes.question_json` 在 A 阶段（课程体系 #6）引入写入路径时**同步接入**同一套 `encText` / `decText`，并在那里补验收。这条要回填册子 §7.2 与总纲 §12.1.1。

### 修正 2：`HasBlob` 的 size 来源必须改为 `blobs.size`

加密后磁盘文件大小 = `明文长度 + 12(nonce) + 16(tag)`。若 `HasBlob` 继续 `os.Stat` 取文件大小，`HEAD /v1/blob/:id` 的 `Content-Length` 会比 `blobs.size` 多 28 字节，**改变 P0 的接口语义**（近场互传秒传判定依赖 size 一致）。

**结论：** `HasBlob` 的存在性看文件，size 一律取 `blobs.size`（表里本就有该列）。必须有测试锁死。

### 修正 3：客户端↔节点的自签 TLS 有可行性风险，Task 1 就是 spike

册子 §6.1 假定「App 接受自签证书 + 指纹固定」。实测 `PlusHttp` 只封了 `uni.request`，无 pinning 能力；Android 默认信任库**会拒绝**自签证书。这不是代码问题，是平台能力问题。

**结论：** 把可行性验证前置为 Task 1，三条退路已定；Task 12 只实现**确定能做**的部分（Go 侧证书生成 + 配对码 + 节点↔节点指纹固定）。若 spike 结论为退路 F1，需按总纲「## 0. 改版说明」改 §4 与 §6.1（客户端↔节点改 HTTP + 签名头，TLS 只保节点↔节点）。

### 修正 4：L4a′ 的密钥**不能**放在 `data/` 里（册子 §7.2 与 §12.1.1 需改）

册子写「`data/store.key`（0600）」。这条自相矛盾：本节 L4a′ 的触发威胁就是"**误拷 `data/` 目录**"，而把密钥放在 `data/` 里，`cp -r data/` 或"备份 data 目录"会**连密钥一起拷走**，加密形同虚设。

**修正后的密钥来源优先级（唯一确定）：**

1. `store.WithStoreKey(hex)` —— 仅代码/测试用，优先级最高
2. 环境变量 `BASE_STORE_KEY`（hex64）—— **生产推荐**，由 systemd `Environment=` / Windows 服务环境变量 / 容器 secret 注入，磁盘上不存在密钥
3. 环境变量 `BASE_STORE_KEY_FILE`（路径）
4. 默认文件 **`<dataDir>.key`（`data` 目录的兄弟文件，不是 `data/` 内的文件）**，权限 0600，首启自动生成

**必须写进文档的残余风险（不粉饰）：** 用默认文件时，只要备份**整个安装目录**（含 `data.key`）仍可解密；只有 env 注入才能根除。要回填册子 §7.2（把 `data/store.key` 改为 `data.key`，并注明"刻意置于 data 目录之外"）、§12.1.1、总纲 §12.1.1 与 §7.2 目录布局。

### 修正 5-8（位置索引）

修正 5（`articles.body_md` 用 `enc:v1:` 前缀 + base64）见 Task 8；修正 6（事件最小信封字段）见 Task 11；修正 7（TS 侧 AEAD/KDF 的实现位置与 `@noble/ciphers@1.3.0` 依赖）与修正 8（S1 期设备 KEK 的实际来源与残余风险）见 Task 14 前的补充段。


---

## 文件结构（本计划落定，后续任务只碰这些文件）

**新增（Go）**

| 文件 | 职责 |
|---|---|
| `internal/protocol/id.go` | `IdentityID(pubHex)`、`IsIdentityID(id)`；`hash.go` 抽出共用 `isHex32` |
| `internal/protocol/id_test.go` | id 派生的属性测试 + 消费 `vectors/v1/identity.json` |
| `internal/protocol/reqsig.go` | `RequestMeta`、`RequestSignBytes`、`EmptyBodySHA256` |
| `internal/protocol/reqsig_test.go` | 待签字节属性测试 + 消费 `vectors/v1/reqsig.json` |
| `internal/store/crypto.go` | L4a′：密钥加载/生成、`Encrypt`/`Decrypt`、`encText`/`decText` |
| `internal/store/crypto_test.go` | 封装格式、密钥优先级、恢复码、明文缺失断言 |
| `internal/store/identity.go` | `identities` / `escrow` / `auth_nonces` 三表的读写 |
| `internal/store/identity_test.go` | 幂等登记、pubkey 冲突、托管覆盖规则、nonce 去重 |
| `internal/httpapi/authmw.go` | 签名头解析与校验中间件、`writeAuthErr` |
| `internal/httpapi/authmw_test.go` | 7 步验签顺序逐条覆盖 |
| `internal/httpapi/identity.go` | 5 个身份接口处理器 + 同 IP 令牌桶（`escrow` 读取限速，防密码哈希枚举） |
| `internal/httpapi/identity_test.go` | 接口级测试 |
| `internal/httpapi/tlscfg.go` | 自签证书生成/加载、指纹、配对码、`VerifyPeerCertificate` |
| `internal/httpapi/tlscfg_test.go` | 指纹固定必须拒绝不匹配证书 |
| `cmd/based/tlscert.go` | `tls-cert` 子命令（`init` / `show` / `rotate`） |
| `cmd/based/storekey.go` | `store-key` 子命令（`show` / `init`） |
| `vectors/v1/identity.json` | 身份 id 黄金向量（由 genvectors 生成） |
| `vectors/v1/reqsig.json` | 请求签名字节黄金向量（由 genvectors 生成） |
| `vectors/v1/aead.json` | AEAD 封装格式黄金向量（TS 生成，Go 与 TS 双侧消费） |

**修改（Go）**

| 文件 | 改什么 |
|---|---|
| `internal/protocol/hash.go` | 抽出 `isHex32`，`IsBlobID` 委托；行为不变 |
| `internal/store/schema.go` | 追加 `identities` / `escrow` / `auth_nonces` 三张表 + 注释标注正文列加密 |
| `internal/store/store.go` | `Open` 加变参 `Option`；`PutBlob`/`GetBlobBytes`/`HasBlob` 走加解密；`UpsertArticle`/`GetArticle`/`ListArticles` 的 `body_md` 走加解密 |
| ``internal/httpapi/server.go`` | 新路由（4 个匿名 + 2 个签名）；``Options`` 增 ``FingerprintHex`` / ``PairingCode``（仅供首页展示） |
| ``cmd/based/serve.go`` | 新 flag：``-store-key`` / ``-tls-cert`` / ``-tls-key`` / ``-peer-addr`` / ``-peers`` / ``-node-key``；主监听 + 对端监听（双向 TLS + 指纹固定） |
| `cmd/based/main.go` | 子命令分发加 `tls-cert` / `store-key`；更新 usage 行 |
| `tools/genvectors/main.go` | 追加 `writeIdentity` 与 `writeRequestSig` |
| ``internal/httpapi/web.go`` | 首页显示节点配对码（供扫码），读 ``s.opt.PairingCode`` / ``s.opt.FingerprintHex`` |

**新增 / 修改（TS）**

| 文件 | 改什么 |
|---|---|
| `packages/protocol-ts/src/identity.ts` | `deriveIdentityId(pubHex)` |
| `packages/protocol-ts/src/reqsig.ts` | `requestSignBytes(meta)`、`emptyBodySha256()` |
| `packages/protocol-ts/src/index.ts` | 导出上面两个模块 |
| `packages/protocol-ts/src/vectors.test.ts` | 追加 `identity.json` / `reqsig.json` 两段 |
| `apps/mobile/src/core/identity.ts` | 身份生成/载入/签名/托管加密（纯逻辑，只依赖注入的适配器） |
| `apps/mobile/src/core/identity.test.ts` | 用 `core/fakes.ts` 的假适配器跑 |
| `packages/protocol-ts/src/aead.ts` | AES-256-GCM 封装的**唯一实现**（`nonce(12)||ct||tag(16)`），节点侧 Go 必须逐字节对齐 |
| `packages/protocol-ts/src/aead.test.ts` | 往返、篡改拒绝、黄金向量消费 |
| `packages/protocol-ts/src/kdf.ts` | argon2id 参数契约 `KdfParams` / `DEFAULT_KDF` / `deriveKek` |
| `packages/protocol-ts/src/hash.ts` | 追加导出 `bytesToHex` / `randomBytes` |
| `packages/protocol-ts/package.json` | 增加 `\"@noble/ciphers\": \"1.3.0\"` |

---

## 任务依赖顺序

```
Task 0（测试去 socket 化，让基线转绿——所有后续 Task 的前置）
Task 1（TLS spike，阻塞 Task 12 的最终形态）
Task 2 → Task 3 → Task 4        （协议层，双实现对齐）
Task 5 → Task 6 → Task 7 → Task 8  （存储层）
Task 9 → Task 10 → Task 11      （身份接口 + 限速 + 验签中间件）
Task 12 → Task 13               （TLS + CLI）
Task 14                          （手机端）
Task 15                          （端到端验收与文档回填）
```

Task 1 可与 Task 2-11 并行；Task 12 必须等 Task 1 结论。
---

## Task 0: 测试去 socket 化（前置基建，先让基线转绿）

**为什么必须先做：** 本机 Go 无法完成**同进程回环 TCP**（见「已核实的环境事实」），而 `internal/httpapi` 与 `tools/migrate` 的测试全部是 `httptest.NewServer`（服务端与客户端在同一进程）。当前 `go test ./...` 有 11 个测试是红的，且**在本计划动手之前就是红的**。不先修掉，后续每个 Task 的「跑测试」步骤都没有可信基线，无法区分「新代码写坏了」与「基线本来就红」。

**做法：** **不动 29 处调用点**，只在两处替换默认传输——把 `http.DefaultTransport` 换成一个按 Host 查表、直接调用 handler 的进程内 `RoundTripper`。请求不再经过 socket，`ts.URL` 继续当普通字符串使用，所有既有断言（状态码、响应头、body、Content-Length、CORS 预检、HEAD 无 body）语义全部不变。

**Files:**
- Create: `internal/httpapi/testsupport_test.go`
- Create: `tools/migrate/testsupport_test.go`
- Modify: `internal/httpapi/httpapi_test.go:65,77,128`（helper 返回类型 + 2 处建服务）
- Modify: `internal/httpapi/web_test.go:95`（1 处建服务）
- Modify: `tools/migrate/strapi_test.go:56,142`（2 处建服务）

- [ ] **Step 1: 建进程内分发基建（httpapi）**

新建 `internal/httpapi/testsupport_test.go`：

```go
package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
)

// 本机 Go 无法完成同进程回环 TCP（listen 与 dial 在同一进程内 100% 超时，
// 跨进程正常；见计划「已核实的环境事实」），故 httptest.NewServer 在本机不可用。
// 这里把默认传输换成进程内分发：请求按 Host 查表直接送进 handler，不经过 socket。
// 调用点继续把 inprocServer.URL 当普通字符串拼接，断言逻辑不变。
func init() {
	http.DefaultTransport = inprocTransport{}
}

// inprocServer 是 httptest.Server 的进程内替代物：只提供 URL 与 Close。
type inprocServer struct {
	URL string
}

func (s *inprocServer) Close() {}

var (
	inprocMu    sync.Mutex
	inprocTable = map[string]http.Handler{}
	inprocSeq   int
)

func newInprocServer(h http.Handler) *inprocServer {
	inprocMu.Lock()
	inprocSeq++
	host := fmt.Sprintf("node-%d.test", inprocSeq)
	inprocTable[host] = h
	inprocMu.Unlock()
	return &inprocServer{URL: "http://" + host}
}

type inprocTransport struct{}

func (inprocTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	inprocMu.Lock()
	h := inprocTable[req.URL.Host]
	inprocMu.Unlock()
	if h == nil {
		return nil, fmt.Errorf("测试未登记的进程内节点: %s", req.URL.Host)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Result(), nil
}
```

- [ ] **Step 2: 改 `internal/httpapi` 的 3 处建服务**

`httpapi_test.go` 第 65 行 helper 签名改为：

```go
func newTestServer(t *testing.T) (*store.Store, packexport.Result, *inprocServer) {
```

`httpapi_test.go` 第 77 行、第 128 行，以及 `web_test.go` 第 95 行：

```go
	ts := newInprocServer(srv.Handler())
```

`t.Cleanup(ts.Close)` 不用改（`*inprocServer` 有 `Close()` 方法）。这两个文件里的 `"net/http/httptest"` 导入随之不再被使用，删掉该导入行。

- [ ] **Step 3: 跑 httpapi 测试**

Run: `go test ./internal/httpapi/ -count=1`
Expected: 全部 PASS（改动前有 9 个 FAIL）

- [ ] **Step 4: 建进程内分发基建（migrate）**

新建 `tools/migrate/testsupport_test.go`，内容与 Step 1 同构，仅 `package` 改为 `main`；`strapi_test.go` 第 56、142 行的 `httptest.NewServer(...)` 改为 `newInprocServer(...)`，并删掉 `strapi_test.go` 中不再使用的 `"net/http/httptest"` 导入。

`Options{BaseURL: srv.URL}` 不必改：`Run` 内部自建 `http.Client`，其 `Transport` 为 nil → 走 `http.DefaultTransport`，已被替换为进程内分发。

- [ ] **Step 5: 全仓库转绿**

Run: `go test ./... -count=1`
Expected: 全部 `ok`（改动前 `internal/httpapi` 与 `tools/migrate` 为 FAIL）

- [ ] **Step 6: 提交**

```bash
git -C e:/code/base add internal/httpapi/testsupport_test.go internal/httpapi/httpapi_test.go internal/httpapi/web_test.go tools/migrate/testsupport_test.go tools/migrate/strapi_test.go
git -C e:/code/base commit -m "test: 测试改走进程内分发，绕开本机同进程回环 TCP 限制"
```

---

## Task 1: 客户端自签 TLS 可行性 spike（风险前置，阻塞 Task 12 最终形态）

**背景：** 册子 §6.1 假定 App 能接受自签证书并固定指纹。实测 `apps/mobile/src/platform/uni.ts` 的 `PlusHttp` 只封装了 `uni.request`（且只有 GET），没有任何证书或指纹能力；Android 7+ 的默认信任库会**拒绝**自签证书，且默认不信任用户安装的 CA。这不是代码问题，是平台能力问题——必须先验证，否则 Task 12 可能白做。

**Files:**
- Create: `tools/spiketls/main.go`（一次性探针，spike 结束后删除）
- Modify: `apps/mobile/src/pages/settings/settings.vue`（临时按钮，spike 结束后删除）

> **结论（2026-09-26 定案，先于执行）：本 Task 的 Step 1–7 全部未执行，直接定案 F1。**
>
> **为什么可以不跑**：spike 需要真机 + 具体 ROM，本机无可验设备；且三条退路的比较**不依赖实测结果**——F2（原生插件 pinning）超出「纯 uni-app、无原生代码」预算且 iOS 需另做一份；F3（引导用户装 CA）在 Android 7+ 多数不生效，已排除；F1 是预算内唯一可行路径。即便跑出 `SPIKE_SUCCESS`，也只是「平台无脑接受自签证书」= **没有 pinning**，安全性等同明文却没有明文的诚实。
>
> **采用 F1**：客户端↔节点走 HTTP，完整性与认证由 §3 签名头承担、② 类机密性由客户端 E2E 承担；**节点↔节点仍走 TLS + 双向 mTLS + 指纹固定**。
>
> **代价（必须写下）**：明文链路上被动旁观者可读 ① 类明文与请求路径，**写请求正文同样可读**——签名头保护的是「谁发的、有没有被改」，不是「内容不给谁看」。截断可**阻断**（可用性不保），但**不可伪造内容**（manifest / 块按哈希验真）、**不可冒用身份**（验签失败即拒）。
>
> **回填（同一次提交内完成，`docs/README.md` 硬规则 1）**：总纲 §0.1 改版说明 + §4「传输」行 + §10 S1 行 + §11 + §12.1 L1 行 + §12.2 重写；本册子 §1 / §6.1 / §8 `nodes` 表（标注不做）/ §10 验收 9 / §11 红线 5 / §12 已确认项 / §13 分期内切 6。
>
> **真机落地验证（2026-09-26）**：主节点 TLS `:443`（对端 `:8081`）+ 缓存节点明文 `:80`（对端 `:8082`）；明文 `:80` 公开读 200、`:8443` 不再监听、`:8082` 拒绝无证书客户端、缓存节点指纹不变、两侧反熵收敛。落地时暴露并修复一处真代码缺陷：`-tls-cert=off` 被误当成「节点没有证书」，致使 F1 配置下 `serve` 报 `证书与私钥路径都不能为空` 反复重启；现 off 只关主监听，对端监听仍从默认路径 `data/tls/node.crt|key` 加载/生成。

- [ ] **Step 1: 写一个只做自签 HTTPS 的探针程序**（未执行，见上）

创建 `tools/spiketls/main.go`：

```go
// Command spiketls 是一次性探针：起一个自签 HTTPS 服务，用于验证 uni-app App 端
// 能否接受自签证书。spike 出结论后本目录应删除。
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"time"
)

func main() {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "base-spike"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("0.0.0.0"), net.ParseIP("127.0.0.1")},
		IsCA:         true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		log.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	fmt.Printf("SPIKE_FINGERPRINT=%x\n", sha256.Sum256(der))

	srv := &http.Server{
		Addr:    ":8443",
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(w, "spike-ok path=%s\n", r.URL.Path)
		}),
		TLSConfig: &tls.Config{Certificates: []tls.Certificate{mustKeyPair(certPEM, key)}},
	}
	fmt.Println("SPIKE_LISTENING https://<本机局域网IP>:8443/healthz")
	log.Fatal(srv.ListenAndServeTLS("", ""))
}

func mustKeyPair(certPEM []byte, key *ecdsa.PrivateKey) tls.Certificate {
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		log.Fatal(err)
	}
	kp, err := tls.X509KeyPair(certPEM, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
	if err != nil {
		log.Fatal(err)
	}
	return kp
}

var _ = os.Getenv
```

- [ ] **Step 2: 启动探针并记下指纹与局域网地址**

```powershell
$env:CGO_ENABLED='0'
go run ./tools/spiketls
```

Expected: 打印 `SPIKE_FINGERPRINT=<hex64>` 与监听提示。另开一个终端取本机局域网 IP：

```powershell
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' }).IPAddress
```

- [ ] **Step 3: 加临时按钮，用手机 App 打过去**

在 `apps/mobile/src/pages/settings/settings.vue` 的 `<script setup>` 里临时追加（spike 后删除）：

```ts
import { plusRuntime, assertAppRuntime } from '../../platform/uni';

// SPIKE 临时：验证自签证书能否被接受。截图保存 fail 的原始错误字符串。
async function spikeSelfSigned() {
  assertAppRuntime();
  const url = 'https://<把上一步的局域网IP填这里>:8443/healthz';
  (globalThis as any).uni.request({
    url,
    method: 'GET',
    success: (res: any) => console.log('SPIKE_SUCCESS', res.statusCode, res.data),
    fail: (e: any) => console.log('SPIKE_FAIL', JSON.stringify(e)),
  });
}
```

同文件 `<template>` 末尾加一个触发按钮：

```html
<button @click="spikeSelfSigned">SPIKE 自签证书</button>
```

- [ ] **Step 4: 真机运行并记录原始错误串**

用 HBuilderX 或 `npm run dev:app -w apps/mobile` 出包，进设置页点按钮，看控制台输出。

- [ ] **Step 5: 按错误串在三条退路中定案**

| 观察到的结果 | 结论 | 走哪条 |
|---|---|---|
| `SPIKE_SUCCESS`（能连通） | 说明该 ROM 的 App HTTP 栈接受了自签证书。**但"接受"不等于"能固定指纹"**——还要确认平台是否暴露 `VerifyPeerCertificate` 等价能力；若只是"无脑接受"，则等于没有 pinning，安全性等同无 TLS 校验 | 走 F2 或 F1 |
| `SPIKE_FAIL` 含 `ssl` / `certificate` / `trust` / `handshake` 字样 | 平台拒绝自签证书。App 端无法在无原生代码前提下建立自签 TLS | **走 F1** |
| 报 `CLEARTEXT` / 明文流量被拒 | 反向确认：该 ROM 默认禁止明文 HTTP | 若同时拒自签 → 无可行路径，需上报用户 |

**三条退路的定义（写进结论就不许改）：**

- **F1（推荐退路，代价最小）**：客户端↔节点**放弃 TLS**，改走 HTTP，安全性由 §3 的签名头（完整性 + 认证）与 ② 类内容 E2E 加密（机密性）承担；**节点↔节点仍走 TLS + 指纹固定**。代价：① 类明文与目录在链路上对被动的旁观者可读——但 ① 类本就是"全网可复制"，实际增量损失接近零；② 类密文本就不可读。此退路与总纲"① 类公开即全网可复制"的哲学自洽。
- **F2**：用 Android 原生插件做 pinning。**超出"纯 uni-app、无原生代码"的既定预算**，且 iOS 需另做一份。仅在 F1 被否决时启用。
- **F3**：节点自签证书 + 引导用户把证书装为设备信任根。Android 7+ 起 App 默认**不信任**用户 CA，多数设备不生效；不予采纳，仅记录为已排除。

- [ ] **Step 6: 写结论并清理探针**

把结论（选了哪条、错误串原文、验证机型与 Android 版本）追加到册子 `docs/superpowers/specs/2026-09-26-base-identity-tls-design.md` 的 `## 0. 改版说明`（册子当前无此节则新建，紧跟标题下方）：

```markdown
## 0. 改版说明

### 2026-09-26 Task 1 spike 结论

- 验证机型／系统：
- 观察到的原始错误串：
- 结论：走 F1 / F2 / F3
- 若走 F1，本册子 §6.1 与总纲 §4「传输」一行作废，改写为：客户端↔节点 HTTP + 签名头；节点↔节点 TLS + 指纹固定。总纲按「## 0. 改版说明」追加一节。
```

- [ ] **Step 7: 删除探针并提交文档结论**

```powershell
Remove-Item -Recurse -Force e:\code\base\tools\spiketls
git -C e:\code\base checkout -- apps/mobile/src/pages/settings/settings.vue
```

```bash
git -C e:/code/base add docs/superpowers/specs/2026-09-26-base-identity-tls-design.md
git -C e:/code/base commit -m "docs(s1): Task 1 spike 定案客户端自签 TLS 可行性"
```

> **若结论为 F1，必须先改总纲再改册子（`docs/README.md` 硬规则 1），并在同一次提交里完成，否则后续 Task 12 会按错误前提实现。**
---

## Task 2: 身份 id 派生（Go，不可变契约）

**Files:**
- Create: `internal/protocol/id.go`
- Create: `internal/protocol/id_test.go`
- Modify: `internal/protocol/hash.go:25-36`（抽出共用的 `isHex32`）
- Modify: `tools/genvectors/main.go`（追加 `writeIdentity` 与 main 调用）
- Create: `vectors/v1/identity.json`（由 genvectors 生成）

- [ ] **Step 1: 写失败的测试**

创建 `internal/protocol/id_test.go`：

```go
package protocol

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 第二个密钥用于证明"不同公钥必得不同 id"，与 Rfc8032 测试密钥无关。
const idTestSeedB = "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7"

func TestIdentityIDDerivation(t *testing.T) {
	kpA, err := KeyPairFromSeed(testSeed)
	if err != nil {
		t.Fatal(err)
	}
	kpB, err := KeyPairFromSeed(idTestSeedB)
	if err != nil {
		t.Fatal(err)
	}
	idA, err := IdentityID(kpA.PubHex)
	if err != nil {
		t.Fatalf("IdentityID: %v", err)
	}
	if len(idA) != 32 {
		t.Fatalf("len(id) = %d, want 32", len(idA))
	}
	if !IsIdentityID(idA) {
		t.Fatalf("IsIdentityID(%q) = false", idA)
	}
	// 独立复算，不复用实现内部逻辑
	raw, err := hex.DecodeString(kpA.PubHex)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	if want := hex.EncodeToString(sum[:])[:32]; idA != want {
		t.Fatalf("IdentityID = %s, 独立复算 = %s", idA, want)
	}
	// 确定性
	if again, _ := IdentityID(kpA.PubHex); again != idA {
		t.Fatalf("同一公钥两次派生不一致: %s vs %s", idA, again)
	}
	// 大写十六进制归一到同一 id
	if up, err := IdentityID(strings.ToUpper(kpA.PubHex)); err != nil || up != idA {
		t.Fatalf("大写公钥应归一到同一 id: %s vs %s err=%v", up, idA, err)
	}
	// 不同公钥 → 不同 id
	idB, err := IdentityID(kpB.PubHex)
	if err != nil {
		t.Fatal(err)
	}
	if idA == idB {
		t.Fatalf("不同公钥派生出相同 id: %s", idA)
	}
	// 非法输入必须报错而不是静默产出 id
	if _, err := IdentityID("zz"); err == nil {
		t.Fatal("非 hex 公钥应报错")
	}
	if _, err := IdentityID("9d61b19d"); err == nil {
		t.Fatal("长度不足的公钥应报错")
	}
	if _, err := IdentityID(""); err == nil {
		t.Fatal("空公钥应报错")
	}
	// id 形状校验
	if IsIdentityID("ABCDEF") || IsIdentityID(idA+"0") || IsIdentityID("A"+idA[1:]) || IsIdentityID("") {
		t.Fatal("IsIdentityID 应拒绝非 32 字符小写 hex")
	}
}

func TestIdentityIDVectors(t *testing.T) {
	type vecCase struct {
		Name    string `json:"name"`
		SeedHex string `json:"seed_hex"`
		PubHex  string `json:"pub_hex"`
		Alg     string `json:"alg"`
		ID      string `json:"id"`
	}
	var f struct {
		Version int       `json:"version"`
		Cases   []vecCase `json:"cases"`
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "identity.json"))
	if err != nil {
		t.Fatalf("读向量失败: %v", err)
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("解析向量失败: %v", err)
	}
	if f.Version != 1 {
		t.Fatalf("向量 version = %d, want 1", f.Version)
	}
	if len(f.Cases) < 2 {
		t.Fatalf("向量用例数 = %d, want >= 2", len(f.Cases))
	}
	for _, c := range f.Cases {
		kp, err := KeyPairFromSeed(c.SeedHex)
		if err != nil {
			t.Fatalf("%s: KeyPairFromSeed: %v", c.Name, err)
		}
		if kp.PubHex != c.PubHex {
			t.Fatalf("%s: 公钥不符 %s != %s", c.Name, kp.PubHex, c.PubHex)
		}
		if c.Alg != AlgEd25519 {
			t.Fatalf("%s: alg = %q, want %q", c.Name, c.Alg, AlgEd25519)
		}
		got, err := IdentityID(c.PubHex)
		if err != nil {
			t.Fatalf("%s: IdentityID: %v", c.Name, err)
		}
		if got != c.ID {
			t.Fatalf("%s: id 漂移 %s != %s（改了派生算法就必须同步全部消费方）", c.Name, got, c.ID)
		}
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
go test ./internal/protocol/ -run 'TestIdentityID' -v
```

Expected: 编译失败，`undefined: IdentityID`、`undefined: IsIdentityID`、`undefined: AlgEd25519`。

- [ ] **Step 3: 抽出共用的 isHex32（hash.go，行为不变）**

把 `internal/protocol/hash.go` 的 `IsBlobID` 替换为：

```go
// IsBlobID 校验 id 是否为合法的 32 字符小写十六进制。
func IsBlobID(id string) bool { return isHex32(id) }

// isHex32 判断 s 是否为 32 字符小写十六进制；blob_id 与身份 id 共用同一形状约束。
func isHex32(s string) bool {
	if len(s) != 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') {
			continue
		}
		return false
	}
	return true
}
```

- [ ] **Step 4: 实现 id.go**

创建 `internal/protocol/id.go`：

```go
package protocol

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"strings"
)

// AlgEd25519 是身份签名算法标识；一期只允许该值，其余一律拒绝。
const AlgEd25519 = "ed25519"

// IdentityID 由公钥派生身份 id：sha256(公钥原始 32 字节) 的前 32 个十六进制字符。
//
// 这是不可变契约：节点不分配 id——任何人拿公钥都能算出同一个 id，
// 节点的"登记"只是"记录下来并可被邻居核对"，不是发号。
// 改本函数的算法或其输入，会同时破坏登记幂等、验签与跨节点一致性。
func IdentityID(pubHex string) (string, error) {
	pub, err := hex.DecodeString(strings.ToLower(strings.TrimSpace(pubHex)))
	if err != nil {
		return "", fmt.Errorf("identity id: 公钥不是合法 hex: %w", err)
	}
	if len(pub) != ed25519.PublicKeySize {
		return "", fmt.Errorf("identity id: 期望 %d 字节公钥，实得 %d", ed25519.PublicKeySize, len(pub))
	}
	return SHA256Hex(pub)[:32], nil
}

// IsIdentityID 校验身份 id 是否为 32 字符小写十六进制。
func IsIdentityID(id string) bool { return isHex32(id) }
```

- [ ] **Step 5: 运行测试确认通过**

```powershell
go test ./internal/protocol/ -run 'TestIdentityIDDerivation' -v
```

Expected: `--- PASS: TestIdentityIDDerivation`。此时 `TestIdentityIDVectors` 仍失败（向量文件还没生成），这是预期的。

- [ ] **Step 6: 在 genvectors 里追加身份向量生成器**

在 `tools/genvectors/main.go` 末尾追加：

```go
// writeIdentity 产出身份 id 黄金向量：固定种子 → 期望公钥 → 期望 id。
func writeIdentity(out string) error {
	seeds := []struct{ name, seed string }{
		{"rfc8032_test1", testSeed},
		{"second_key", "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7"},
	}
	type identityCase struct {
		Name    string `json:"name"`
		SeedHex string `json:"seed_hex"`
		PubHex  string `json:"pub_hex"`
		Alg     string `json:"alg"`
		ID      string `json:"id"`
	}
	cases := make([]identityCase, 0, len(seeds))
	for _, s := range seeds {
		kp, err := protocol.KeyPairFromSeed(s.seed)
		if err != nil {
			return err
		}
		id, err := protocol.IdentityID(kp.PubHex)
		if err != nil {
			return err
		}
		cases = append(cases, identityCase{
			Name: s.name, SeedHex: kp.SeedHex, PubHex: kp.PubHex, Alg: protocol.AlgEd25519, ID: id,
		})
	}
	return writeJSON(filepath.Join(out, "identity.json"), map[string]any{"version": 1, "cases": cases})
}
```

并在 `main()` 的 `writeManifest` 之后追加一行：

```go
	if err := writeIdentity(*out); err != nil {
		fail(err)
	}
```

- [ ] **Step 7: 生成向量**

```powershell
go run ./tools/genvectors -out vectors/v1
```

Expected: 打印 `wrote vectors\v1\merkle.json`、`wrote vectors\v1\manifest.json`、`wrote vectors\v1\identity.json`。

**必须确认 `merkle.json` 与 `manifest.json` 未被改动**（L4a′ 与身份都不该影响既有向量）：

```powershell
git -C e:\code\base diff --stat vectors/
```

Expected: 只有 `identity.json` 是新增（`??`），另两个 `merkle.json` / `manifest.json` **无改动**。若有改动，说明 Task 6/7/8 尚未做但已验证过 `store` 的调用方被影响了——停下排查。

- [ ] **Step 8: 运行向量测试确认通过**

```powershell
go test ./internal/protocol/ -run 'TestIdentityID' -v
```

Expected: `--- PASS: TestIdentityIDDerivation` 与 `--- PASS: TestIdentityIDVectors` 均通过。

- [ ] **Step 9: 跑全包回归，确认没破坏 P0**

```powershell
go test ./internal/protocol/ ./internal/store/ ./internal/packexport/ ./internal/importer/
```

Expected: 全部 `ok`。

- [ ] **Step 10: 提交**

```bash
git -C e:/code/base add internal/protocol/id.go internal/protocol/id_test.go internal/protocol/hash.go tools/genvectors/main.go vectors/v1/identity.json
git -C e:/code/base commit -m "feat(protocol): 身份 id 派生契约与黄金向量"
```

---

## Task 3: 请求签名字节（Go，不可变契约）

**Files:**
- Create: `internal/protocol/reqsig.go`
- Create: `internal/protocol/reqsig_test.go`
- Modify: `tools/genvectors/main.go`（追加 `writeRequestSig` 与 main 调用）
- Create: `vectors/v1/reqsig.json`（由 genvectors 生成）

- [ ] **Step 1: 写失败的测试**

创建 `internal/protocol/reqsig_test.go`：

```go
package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRequestSignBytes(t *testing.T) {
	if got := EmptyBodySHA256(); got != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatalf("EmptyBodySHA256 = %s, want sha256(\"\") 的 hex", got)
	}
	m := RequestMeta{
		Method: "POST", Path: "/v1/identity/escrow/alice", Query: "a=1&b=2",
		BodySHA256: SHA256Hex([]byte("{}")), TS: 1790000000000,
		Nonce: "00112233445566778899aabbccddeeff",
	}
	got, err := RequestSignBytes(m)
	if err != nil {
		t.Fatalf("RequestSignBytes: %v", err)
	}
	want := `{"body_sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","method":"POST","nonce":"00112233445566778899aabbccddeeff","path":"/v1/identity/escrow/alice","query":"a=1&b=2","ts":1790000000000}`
	if string(got) != want {
		t.Fatalf("待签字节不符:\n got = %s\nwant = %s", got, want)
	}

	// 任一字段变化 → 待签字节必变。这条测的是"有没有字段漏签"。
	base := string(got)
	muts := []struct {
		name string
		m    RequestMeta
	}{
		{"method", RequestMeta{Method: "GET", Path: m.Path, Query: m.Query, BodySHA256: m.BodySHA256, TS: m.TS, Nonce: m.Nonce}},
		{"path", RequestMeta{Method: m.Method, Path: "/v1/me", Query: m.Query, BodySHA256: m.BodySHA256, TS: m.TS, Nonce: m.Nonce}},
		{"query", RequestMeta{Method: m.Method, Path: m.Path, Query: "", BodySHA256: m.BodySHA256, TS: m.TS, Nonce: m.Nonce}},
		{"body_sha256", RequestMeta{Method: m.Method, Path: m.Path, Query: m.Query, BodySHA256: EmptyBodySHA256(), TS: m.TS, Nonce: m.Nonce}},
		{"ts", RequestMeta{Method: m.Method, Path: m.Path, Query: m.Query, BodySHA256: m.BodySHA256, TS: m.TS + 1, Nonce: m.Nonce}},
		{"nonce", RequestMeta{Method: m.Method, Path: m.Path, Query: m.Query, BodySHA256: m.BodySHA256, TS: m.TS, Nonce: "ffffffffffffffffffffffffffffffff"}},
	}
	for _, mu := range muts {
		b, err := RequestSignBytes(mu.m)
		if err != nil {
			t.Fatalf("变体 %s: %v", mu.name, err)
		}
		if string(b) == base {
			t.Fatalf("变体 %s 未改变待签字节——说明该字段没进签名", mu.name)
		}
	}

	// 签/验闭环 + 篡改拒绝
	kp, err := KeyPairFromSeed(testSeed)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := Sign(testSeed, got)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	ok, err := Verify(kp.PubHex, got, sig)
	if err != nil || !ok {
		t.Fatalf("验签失败 ok=%v err=%v", ok, err)
	}
	tampered := append([]byte(nil), got...)
	tampered[len(tampered)-2] ^= 0x01
	if ok, _ := Verify(kp.PubHex, tampered, sig); ok {
		t.Fatal("篡改 1 bit 后仍验签通过")
	}
}

func TestRequestSignBytesVectors(t *testing.T) {
	type vecCase struct {
		Name         string `json:"name"`
		Method       string `json:"method"`
		Path         string `json:"path"`
		Query        string `json:"query"`
		BodySHA256   string `json:"body_sha256"`
		TS           int64  `json:"ts"`
		Nonce        string `json:"nonce"`
		SignBytes    string `json:"sign_bytes"`
		SignatureHex string `json:"signature_hex"`
	}
	var f struct {
		Version int       `json:"version"`
		SeedHex string    `json:"seed_hex"`
		PubHex  string    `json:"pub_hex"`
		Cases   []vecCase `json:"cases"`
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "reqsig.json"))
	if err != nil {
		t.Fatalf("读向量失败: %v", err)
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("解析向量失败: %v", err)
	}
	if f.Version != 1 {
		t.Fatalf("向量 version = %d, want 1", f.Version)
	}
	if len(f.Cases) < 2 {
		t.Fatalf("向量用例数 = %d, want >= 2", len(f.Cases))
	}
	kp, err := KeyPairFromSeed(f.SeedHex)
	if err != nil {
		t.Fatal(err)
	}
	if kp.PubHex != f.PubHex {
		t.Fatalf("向量公钥与种子不符: %s != %s", kp.PubHex, f.PubHex)
	}
	for _, c := range f.Cases {
		got, err := RequestSignBytes(RequestMeta{
			Method: c.Method, Path: c.Path, Query: c.Query,
			BodySHA256: c.BodySHA256, TS: c.TS, Nonce: c.Nonce,
		})
		if err != nil {
			t.Fatalf("%s: RequestSignBytes: %v", c.Name, err)
		}
		if string(got) != c.SignBytes {
			t.Fatalf("%s: 待签字节漂移\n got = %s\nwant = %s", c.Name, got, c.SignBytes)
		}
		ok, err := Verify(f.PubHex, got, c.SignatureHex)
		if err != nil || !ok {
			t.Fatalf("%s: 向量签名验签失败 ok=%v err=%v", c.Name, ok, err)
		}
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
go test ./internal/protocol/ -run 'TestRequestSignBytes' -v
```

Expected: 编译失败，`undefined: RequestMeta`、`undefined: RequestSignBytes`、`undefined: EmptyBodySHA256`。

- [ ] **Step 3: 实现 reqsig.go**

创建 `internal/protocol/reqsig.go`：

```go
package protocol

// RequestMeta 是一次请求中参与签名的元数据（不含请求体本身）。
// 无 JWT、无 session：节点验签通过即放行，身份由公钥派生 id 自证。
type RequestMeta struct {
	Method     string // 大写，如 "POST"
	Path       string // 不含 query，如 "/v1/identity/escrow/alice"
	Query      string // 原始 query string（r.URL.RawQuery），无则空串
	BodySHA256 string // 请求体原始字节的 sha256 hex；无请求体时用 EmptyBodySHA256()
	TS         int64  // 客户端 Unix 毫秒
	Nonce      string // 每次请求唯一的随机值，16 字节 hex
}

// RequestSignBytes 返回待签字节：canonical({method,path,query,body_sha256,ts,nonce})。
//
// 这是不可变契约：Go 与 TS 两侧必须产出完全一致的字节，
// 由 vectors/v1/reqsig.json 同时消费来锁死。字段增删即协议破坏。
func RequestSignBytes(m RequestMeta) ([]byte, error) {
	return Canonicalize(map[string]any{
		"method":      m.Method,
		"path":        m.Path,
		"query":       m.Query,
		"body_sha256": m.BodySHA256,
		"ts":          m.TS,
		"nonce":       m.Nonce,
	})
}

// EmptyBodySHA256 是无请求体请求的固定 body_sha256 取值。
// 固定值而非省略字段：让"无请求体"也有确定的签名输入，避免歧义。
func EmptyBodySHA256() string { return SHA256Hex(nil) }
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
go test ./internal/protocol/ -run 'TestRequestSignBytes$' -v
```

Expected: `--- PASS: TestRequestSignBytes`。

- [ ] **Step 5: 在 genvectors 里追加请求签名向量生成器**

在 `tools/genvectors/main.go` 末尾追加：

```go
// writeRequestSig 产出请求签名黄金向量：固定请求元组 → 期望待签字节 + 期望签名。
func writeRequestSig(out string) error {
	kp, err := protocol.KeyPairFromSeed(testSeed)
	if err != nil {
		return err
	}
	type reqCase struct {
		Name         string `json:"name"`
		Method       string `json:"method"`
		Path         string `json:"path"`
		Query        string `json:"query"`
		BodySHA256   string `json:"body_sha256"`
		TS           int64  `json:"ts"`
		Nonce        string `json:"nonce"`
		SignBytes    string `json:"sign_bytes"`
		SignatureHex string `json:"signature_hex"`
	}
	metas := []struct {
		name string
		m    protocol.RequestMeta
	}{
		{"get_me_no_body", protocol.RequestMeta{
			Method: "GET", Path: "/v1/me", Query: "",
			BodySHA256: protocol.EmptyBodySHA256(),
			TS:         1790000000000, Nonce: "00112233445566778899aabbccddeeff",
		}},
		{"put_escrow_with_query_and_body", protocol.RequestMeta{
			Method: "PUT", Path: "/v1/identity/escrow/alice", Query: "force=1",
			BodySHA256: protocol.SHA256Hex([]byte(`{"id":"aa"}`)),
			TS:         1790000000123, Nonce: "ffeeddccbbaa99887766554433221100",
		}},
	}
	cases := make([]reqCase, 0, len(metas))
	for _, it := range metas {
		sb, err := protocol.RequestSignBytes(it.m)
		if err != nil {
			return err
		}
		sig, err := protocol.Sign(testSeed, sb)
		if err != nil {
			return err
		}
		cases = append(cases, reqCase{
			Name: it.name, Method: it.m.Method, Path: it.m.Path, Query: it.m.Query,
			BodySHA256: it.m.BodySHA256, TS: it.m.TS, Nonce: it.m.Nonce,
			SignBytes: string(sb), SignatureHex: sig,
		})
	}
	return writeJSON(filepath.Join(out, "reqsig.json"), map[string]any{
		"version": 1, "seed_hex": kp.SeedHex, "pub_hex": kp.PubHex, "cases": cases,
	})
}
```

并在 `main()` 里 `writeIdentity` 之后追加：

```go
	if err := writeRequestSig(*out); err != nil {
		fail(err)
	}
```

- [ ] **Step 6: 生成向量**

```powershell
go run ./tools/genvectors -out vectors/v1
```

Expected: 额外打印 `wrote vectors\v1\reqsig.json`；`merkle.json` / `manifest.json` / `identity.json` 无改动。

- [ ] **Step 7: 运行向量测试并回归全包**

```powershell
go test ./internal/protocol/ -run 'TestRequestSignBytes' -v
```

Expected: 两个测试均 PASS。

- [ ] **Step 8: 提交**

```bash
git -C e:/code/base add internal/protocol/reqsig.go internal/protocol/reqsig_test.go tools/genvectors/main.go vectors/v1/reqsig.json
git -C e:/code/base commit -m "feat(protocol): 请求签名字节契约与黄金向量"
```
---

## Task 4: TS 侧身份与请求签名（消费向量，锁死双实现一致）

**Files:**
- Create: `packages/protocol-ts/src/identity.ts`
- Create: `packages/protocol-ts/src/reqsig.ts`
- Modify: `packages/protocol-ts/src/index.ts`
- Modify: `packages/protocol-ts/src/vectors.test.ts`

- [ ] **Step 1: 写失败的测试（追加到 vectors.test.ts）**

在 `packages/protocol-ts/src/vectors.test.ts` 顶部的 import 里加上 `bytesToHex`：

```ts
import { bytesToHex } from "@noble/hashes/utils";
```

在同文件的 `from "./index"` 导入列表里加上 `ALG_ED25519, deriveIdentityId, emptyBodySha256, isIdentityId, requestSignBytes`。然后在文件末尾追加：

```ts
describe("identity.json", () => {
  const f = load("identity.json");
  it("version 与用例数", () => {
    expect(f.version).toBe(1);
    expect(f.cases.length).toBeGreaterThanOrEqual(2);
  });
  for (const c of f.cases) {
    it(c.name, () => {
      expect(keyPairFromSeed(c.seed_hex).pubHex).toBe(c.pub_hex);
      expect(c.alg).toBe(ALG_ED25519);
      expect(deriveIdentityId(c.pub_hex)).toBe(c.id);
      expect(isIdentityId(c.id)).toBe(true);
    });
  }
  it("大小写归一 + 拒绝非法长度", () => {
    const c = f.cases[0];
    expect(deriveIdentityId(c.pub_hex.toUpperCase())).toBe(c.id);
    expect(() => deriveIdentityId("9d61b19d")).toThrow(/32 字节公钥/);
    expect(isIdentityId(c.id + "0")).toBe(false);
    expect(isIdentityId(c.id.toUpperCase())).toBe(false);
  });
});

describe("reqsig.json", () => {
  const f = load("reqsig.json");
  it("version、用例数与密钥", () => {
    expect(f.version).toBe(1);
    expect(f.cases.length).toBeGreaterThanOrEqual(2);
    expect(keyPairFromSeed(f.seed_hex).pubHex).toBe(f.pub_hex);
  });
  for (const c of f.cases) {
    it(c.name, () => {
      const bytes = requestSignBytes({
        method: c.method,
        path: c.path,
        query: c.query,
        bodySha256: c.body_sha256,
        ts: c.ts,
        nonce: c.nonce,
      });
      expect(bytesToHex(bytes)).toBe(bytesToHex(utf8(c.sign_bytes)));
      expect(verify(f.pub_hex, bytes, c.signature_hex)).toBe(true);
    });
  }
  it("无请求体的固定 body_sha256", () => {
    expect(emptyBodySha256()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
  it("篡改任一字段后签名不再成立", () => {
    const c = f.cases[0];
    const bytes = requestSignBytes({
      method: c.method,
      path: c.path,
      query: c.query,
      bodySha256: c.body_sha256,
      ts: c.ts,
      nonce: "ffffffffffffffffffffffffffffffff",
    });
    expect(verify(f.pub_hex, bytes, c.signature_hex)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
npm test -w packages/protocol-ts
```

Expected: 编译/运行失败，`deriveIdentityId is not a function` 或 `Failed to resolve import "./identity"`。

- [ ] **Step 3: 实现 identity.ts**

创建 `packages/protocol-ts/src/identity.ts`：

```ts
import { hexToBytes } from "@noble/hashes/utils";

import { sha256Hex } from "./hash";

/** 身份签名算法标识；一期只允许该值，其余一律拒绝。 */
export const ALG_ED25519 = "ed25519";

/**
 * 由公钥派生身份 id：sha256(公钥原始 32 字节) 的前 32 个十六进制字符。
 *
 * 这是不可变契约（与 Go 侧 protocol.IdentityID 必须逐字节一致）：
 * 节点不分配 id——任何人拿公钥都能算出同一个 id。
 */
export function deriveIdentityId(pubHex: string): string {
  const pub = hexToBytes(pubHex.trim().toLowerCase());
  if (pub.length !== 32) {
    throw new Error(`identity id: 期望 32 字节公钥，实得 ${pub.length}`);
  }
  return sha256Hex(pub).slice(0, 32);
}

/** 校验身份 id 是否为 32 字符小写十六进制。 */
export function isIdentityId(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id);
}
```

- [ ] **Step 4: 实现 reqsig.ts**

创建 `packages/protocol-ts/src/reqsig.ts`：

```ts
import { canonicalize } from "./canonical";
import { sha256Hex, utf8 } from "./hash";

/** 一次请求中参与签名的元数据（不含请求体本身）。 */
export interface RequestMeta {
  /** 大写，如 "POST" */
  method: string;
  /** 不含 query，如 "/v1/identity/escrow/alice" */
  path: string;
  /** 原始 query string，无则空串 */
  query: string;
  /** 请求体原始字节的 sha256 hex；无请求体时用 emptyBodySha256() */
  bodySha256: string;
  /** 客户端 Unix 毫秒。必须是安全整数，否则 canonicalize 会抛错 */
  ts: number;
  /** 每次请求唯一的随机值，16 字节 hex */
  nonce: string;
}

/** 无请求体请求的固定 body_sha256 取值。 */
export function emptyBodySha256(): string {
  return sha256Hex(new Uint8Array(0));
}

/**
 * 待签字节：canonical({method,path,query,body_sha256,ts,nonce})。
 *
 * 这是不可变契约（与 Go 侧 protocol.RequestSignBytes 必须逐字节一致），
 * 由 vectors/v1/reqsig.json 双侧消费锁死。字段增删即协议破坏。
 */
export function requestSignBytes(m: RequestMeta): Uint8Array {
  return utf8(
    canonicalize({
      method: m.method,
      path: m.path,
      query: m.query,
      body_sha256: m.bodySha256,
      ts: m.ts,
      nonce: m.nonce,
    }),
  );
}
```

- [ ] **Step 5: 导出新模块**

把 `packages/protocol-ts/src/index.ts` 改为：

```ts
export * from "./canonical";
export * from "./hash";
export * from "./merkle";
export * from "./ed25519";
export * from "./manifest";
export * from "./identity";
export * from "./reqsig";
```

- [ ] **Step 6: 运行测试确认通过**

```powershell
npm test -w packages/protocol-ts
```

Expected: 全部通过，含新增的 `identity.json` 与 `reqsig.json` 两组用例。**若某个用例报"待签字节不符"，说明 Go 与 TS 的 canonical JSON 实现已经漂移——必须修 TS 的 `canonicalize`，不许改向量。**

- [ ] **Step 7: 提交**

```bash
git -C e:/code/base add packages/protocol-ts/src/identity.ts packages/protocol-ts/src/reqsig.ts packages/protocol-ts/src/index.ts packages/protocol-ts/src/vectors.test.ts
git -C e:/code/base commit -m "feat(protocol-ts): 身份 id 与请求签名，消费黄金向量"
```

---

## Task 5: store 身份表（公钥登记 / 密码托管 / nonce 去重）

**Files:**
- Create: `internal/store/identity.go`
- Create: `internal/store/identity_test.go`
- Modify: `internal/store/schema.go`（追加三张表与一个索引）

- [ ] **Step 1: 加表（schema.go）**

在 `internal/store/schema.go` 末尾的 `tombstones` 建表语句之后追加（注意 `tombstones` 那条后面要加逗号）：

```go
	`CREATE TABLE IF NOT EXISTS identities(
		id           TEXT PRIMARY KEY,
		alg          TEXT NOT NULL,
		pubkey       TEXT NOT NULL,
		created_at   INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL DEFAULT 0
	)`,

	`CREATE TABLE IF NOT EXISTS escrow(
		username    TEXT PRIMARY KEY,
		id          TEXT NOT NULL,
		alg         TEXT NOT NULL,
		salt        TEXT NOT NULL,
		kdf_json    TEXT NOT NULL,
		enc_nonce   TEXT NOT NULL,
		priv_cipher TEXT NOT NULL,
		updated_at  INTEGER NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS auth_nonces(
		id      TEXT NOT NULL,
		nonce   TEXT NOT NULL,
		seen_at INTEGER NOT NULL,
		PRIMARY KEY(id, nonce)
	)`,

	`CREATE INDEX IF NOT EXISTS idx_auth_nonces_seen_at ON auth_nonces(seen_at)`,
```

同时把文件顶部注释补一行，说明 `escrow.priv_cipher` 是客户端密文、节点只存不解释。

- [ ] **Step 2: 写失败的测试**

创建 `internal/store/identity_test.go`：

```go
package store

import (
	"errors"
	"testing"
)

func TestRegisterIdentityIdempotent(t *testing.T) {
	st := openTemp(t)
	const id = "00112233445566778899aabbccddeeff"
	const pubA = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"

	created, err := st.RegisterIdentity(id, "ed25519", pubA, 1000)
	if err != nil || !created {
		t.Fatalf("首次登记 created=%v err=%v, want true/nil", created, err)
	}
	// 幂等：同 id 同公钥重放不报错、created=false，且刷新 last_seen_at
	created2, err := st.RegisterIdentity(id, "ed25519", pubA, 2000)
	if err != nil || created2 {
		t.Fatalf("重复登记 created=%v err=%v, want false/nil", created2, err)
	}
	got, ok, err := st.LookupIdentity(id)
	if err != nil || !ok {
		t.Fatalf("LookupIdentity ok=%v err=%v", ok, err)
	}
	if got.PubKey != pubA || got.Alg != "ed25519" || got.CreatedAt != 1000 || got.LastSeenAt != 2000 {
		t.Fatalf("identity 字段不符: %+v", got)
	}
	// 同 id 换公钥必须硬失败，不允许悄悄改写已有登记
	const pubB = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"
	if _, err := st.RegisterIdentity(id, "ed25519", pubB, 3000); !errors.Is(err, ErrIdentityPubKeyMismatch) {
		t.Fatalf("换公钥 err=%v, want ErrIdentityPubKeyMismatch", err)
	}
	// 换算法同样硬失败
	if _, err := st.RegisterIdentity(id, "secp256k1", pubA, 3000); !errors.Is(err, ErrIdentityPubKeyMismatch) {
		t.Fatalf("换算法 err=%v, want ErrIdentityPubKeyMismatch", err)
	}
	// 未登记 id
	if _, ok, err := st.LookupIdentity("ffffffffffffffffffffffffffffffff"); err != nil || ok {
		t.Fatalf("未登记 id ok=%v err=%v, want false/nil", ok, err)
	}
}

func TestEscrowConflictAndOverwrite(t *testing.T) {
	st := openTemp(t)
	base := EscrowRecord{
		Username: "alice", ID: "id-1", Alg: "ed25519",
		Salt: "00112233445566778899aabbccddeeff", KDFJSON: `{"alg":"argon2id","m":65536,"t":3,"p":1,"len":32}`,
		EncNonce: "ffeeddccbbaa998877665544", PrivCipher: "deadbeef", UpdatedAt: 1000,
	}
	if err := st.PutEscrow(base); err != nil {
		t.Fatalf("PutEscrow: %v", err)
	}
	// 同 username 同 id → 允许覆盖（改密码场景）
	base.PrivCipher = "cafebabe"
	base.UpdatedAt = 2000
	if err := st.PutEscrow(base); err != nil {
		t.Fatalf("同 id 覆盖失败: %v", err)
	}
	got, ok, err := st.GetEscrow("alice")
	if err != nil || !ok || got.PrivCipher != "cafebabe" || got.UpdatedAt != 2000 {
		t.Fatalf("覆盖后记录不符: ok=%v err=%v got=%+v", ok, err, got)
	}
	// 同 username 换 id → 冲突
	other := base
	other.ID = "id-2"
	if err := st.PutEscrow(other); !errors.Is(err, ErrEscrowConflict) {
		t.Fatalf("换 id err=%v, want ErrEscrowConflict", err)
	}
	// 冲突时原记录不得被改动
	after, _, _ := st.GetEscrow("alice")
	if after.ID != "id-1" || after.PrivCipher != "cafebabe" {
		t.Fatalf("冲突后原记录被改坏: %+v", after)
	}
	// 未登记用户名
	if _, ok, err := st.GetEscrow("nobody"); err != nil || ok {
		t.Fatalf("未登记 username ok=%v err=%v, want false/nil", ok, err)
	}
}

func TestUseNonceIsScopedByIdAndPrunable(t *testing.T) {
	st := openTemp(t)
	const nonce = "00112233445566778899aabbccddeeff"
	used, err := st.UseNonce("id-1", nonce, 1000)
	if err != nil || used {
		t.Fatalf("首次使用 used=%v err=%v, want false/nil", used, err)
	}
	// 同 id 同 nonce 第二次 → 重放
	used2, err := st.UseNonce("id-1", nonce, 1001)
	if err != nil || !used2 {
		t.Fatalf("重放 used=%v err=%v, want true/nil", used2, err)
	}
	// 不同 id 用同一 nonce 互不影响：否则任一身份可抢先占用他人 nonce
	used3, err := st.UseNonce("id-2", nonce, 1002)
	if err != nil || used3 {
		t.Fatalf("另一 id 使用同 nonce used=%v err=%v, want false/nil", used3, err)
	}
	// 清理
	n, err := st.PruneNonces(1001)
	if err != nil || n != 1 {
		t.Fatalf("PruneNonces = %d err=%v, want 1/nil", n, err)
	}
	// 清理后原 nonce 可再用（窗口已过）
	used4, err := st.UseNonce("id-1", nonce, 2000)
	if err != nil || used4 {
		t.Fatalf("清理后重用 used=%v err=%v, want false/nil", used4, err)
	}
}
```

- [ ] **Step 3: 运行测试确认失败**

```powershell
go test ./internal/store/ -run 'TestRegisterIdentity|TestEscrow|TestUseNonce' -v
```

Expected: 编译失败，`undefined: ErrIdentityPubKeyMismatch` 等。

- [ ] **Step 4: 实现 identity.go**

创建 `internal/store/identity.go`：

```go
package store

import (
	"database/sql"
	"errors"
	"fmt"
)

// Identity 是一条已登记的身份公钥。节点只存公钥，永不接触明文私钥。
type Identity struct {
	ID         string
	Alg        string
	PubKey     string
	CreatedAt  int64
	LastSeenAt int64
}

// EscrowRecord 是一条密码托管记录。节点只存不解释：不派生密钥、不解密、不校验密码。
type EscrowRecord struct {
	Username   string
	ID         string
	Alg        string
	Salt       string // 客户端生成，随密文上传，节点原样存原样返
	KDFJSON    string // 客户端决定的 KDF 参数，换设备必须能原样取回
	EncNonce   string // 独立列，不与 priv_cipher 混为一体
	PrivCipher string // ciphertext || tag，节点无从解读
	UpdatedAt  int64
}

// ErrIdentityPubKeyMismatch 表示同一 id 提交了不同公钥或不同算法。
var ErrIdentityPubKeyMismatch = errors.New("store: identity pubkey mismatch")

// ErrEscrowConflict 表示该用户名已绑定到另一个 id。
var ErrEscrowConflict = errors.New("store: escrow username bound to another identity")

// RegisterIdentity 幂等登记公钥。registered=false 表示此前已登记同 id 同公钥。
// 同 id 换公钥或换算法一律返回 ErrIdentityPubKeyMismatch，不静默改写。
func (s *Store) RegisterIdentity(id, alg, pubKey string, now int64) (bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()

	var existPub, existAlg string
	err = tx.QueryRow(`SELECT pubkey, alg FROM identities WHERE id=?`, id).Scan(&existPub, &existAlg)
	switch {
	case err == nil:
		if existPub != pubKey || existAlg != alg {
			return false, ErrIdentityPubKeyMismatch
		}
		if _, err := tx.Exec(`UPDATE identities SET last_seen_at=? WHERE id=?`, now, id); err != nil {
			return false, err
		}
		return false, tx.Commit()
	case !errors.Is(err, sql.ErrNoRows):
		return false, err
	}
	if _, err := tx.Exec(`INSERT INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
		id, alg, pubKey, now, now); err != nil {
		return false, fmt.Errorf("store: register identity: %w", err)
	}
	return true, tx.Commit()
}

// LookupIdentity 读取已登记的身份。
func (s *Store) LookupIdentity(id string) (Identity, bool, error) {
	var it Identity
	err := s.db.QueryRow(`SELECT id,alg,pubkey,created_at,last_seen_at FROM identities WHERE id=?`, id).
		Scan(&it.ID, &it.Alg, &it.PubKey, &it.CreatedAt, &it.LastSeenAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Identity{}, false, nil
	}
	if err != nil {
		return Identity{}, false, err
	}
	return it, true, nil
}

// TouchIdentity 更新 last_seen_at。
func (s *Store) TouchIdentity(id string, now int64) error {
	_, err := s.db.Exec(`UPDATE identities SET last_seen_at=? WHERE id=?`, now, id)
	return err
}

// UseNonce 原子登记 (id, nonce)；used=true 表示该 nonce 已被用过（重放）。
//
// 去重键必须含 id：否则任一身份可以抢先占用他人的 nonce，
// 使合法请求被误判为重放而遭拒绝。
func (s *Store) UseNonce(id, nonce string, now int64) (bool, error) {
	res, err := s.db.Exec(
		`INSERT INTO auth_nonces(id,nonce,seen_at) VALUES(?,?,?) ON CONFLICT(id,nonce) DO NOTHING`,
		id, nonce, now)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n == 0, nil
}

// PruneNonces 删除 seen_at 早于 before 的行，返回删除条数。
func (s *Store) PruneNonces(before int64) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM auth_nonces WHERE seen_at < ?`, before)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// PutEscrow 写入或覆盖密码托管记录。同 username 只允许同一 id 覆盖。
func (s *Store) PutEscrow(e EscrowRecord) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var owner string
	err = tx.QueryRow(`SELECT id FROM escrow WHERE username=?`, e.Username).Scan(&owner)
	switch {
	case err == nil && owner != e.ID:
		return ErrEscrowConflict
	case err != nil && !errors.Is(err, sql.ErrNoRows):
		return err
	}
	if _, err := tx.Exec(`INSERT INTO escrow(username,id,alg,salt,kdf_json,enc_nonce,priv_cipher,updated_at)
		VALUES(?,?,?,?,?,?,?,?)
		ON CONFLICT(username) DO UPDATE SET
			id=excluded.id, alg=excluded.alg, salt=excluded.salt, kdf_json=excluded.kdf_json,
			enc_nonce=excluded.enc_nonce, priv_cipher=excluded.priv_cipher, updated_at=excluded.updated_at`,
		e.Username, e.ID, e.Alg, e.Salt, e.KDFJSON, e.EncNonce, e.PrivCipher, e.UpdatedAt); err != nil {
		return fmt.Errorf("store: put escrow: %w", err)
	}
	return tx.Commit()
}

// GetEscrow 读取密码托管记录。
func (s *Store) GetEscrow(username string) (EscrowRecord, bool, error) {
	var e EscrowRecord
	err := s.db.QueryRow(`SELECT username,id,alg,salt,kdf_json,enc_nonce,priv_cipher,updated_at
		FROM escrow WHERE username=?`, username).
		Scan(&e.Username, &e.ID, &e.Alg, &e.Salt, &e.KDFJSON, &e.EncNonce, &e.PrivCipher, &e.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return EscrowRecord{}, false, nil
	}
	if err != nil {
		return EscrowRecord{}, false, err
	}
	return e, true, nil
}
```

- [ ] **Step 5: 运行测试确认通过**

```powershell
go test ./internal/store/ -run 'TestRegisterIdentity|TestEscrow|TestUseNonce' -v
```

Expected: 三个测试全部 PASS。

- [ ] **Step 6: 回归整个 store 包**

```powershell
go test ./internal/store/
```

Expected: `ok`（新表不应影响既有用例）。

- [ ] **Step 7: 提交**

```bash
git -C e:/code/base add internal/store/identity.go internal/store/identity_test.go internal/store/schema.go
git -C e:/code/base commit -m "feat(store): 身份公钥登记、密码托管与 nonce 去重三张表"
```

---

## 阶段二：存储层 L4a′（Task 6-8）

### Task 6: store 密钥加载与 AES-256-GCM 封装

**Files:**
- Create: `e:\code\base\internal\store\crypto.go`
- Create: `e:\code\base\internal\store\crypto_test.go`
- Modify: `e:\code\base\internal\store\store.go`（imports、`Store` 结构体、`Open` 签名与函数体、新增两个方法）
- Modify: `e:\code\base\internal\store\store_test.go`（`openTemp` 注入固定测试密钥）

**落地修正 4 的密钥优先级**（严格按序，`data/` 目录内绝不出现密钥文件）：
1. `WithStoreKey(hex)` —— 仅代码/测试用
2. 环境变量 `BASE_STORE_KEY`（hex64）
3. 环境变量 `BASE_STORE_KEY_FILE`（文件路径）
4. 默认文件 `<dataDir>.key`（**data 目录的兄弟文件**，权限 0600，首启自动生成）

- [ ] **Step 1: 写失败测试**

创建 `e:\code\base\internal\store\crypto_test.go`：

```go
package store

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const testKeyHex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

// assertPlaintextAbsent 断言 plain 不出现在 dir 下任一文件里（含 WAL/SHM）。
// 这是 L4a′ 的全部意义所在：误拷 data 目录不应泄漏内容。
func assertPlaintextAbsent(t *testing.T, dir string, plain []byte) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir(%s): %v", dir, err)
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		if bytes.Contains(b, plain) {
			t.Fatalf("明文泄漏到 %s 目录的 %s 文件", dir, e.Name())
		}
	}
}

func TestStoreKeyFromExplicitOption(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir, WithStoreKey(strings.ToUpper(testKeyHex)))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	if st.StoreKeyHex() != testKeyHex {
		t.Fatalf("StoreKeyHex = %s, want %s（应大小写归一）", st.StoreKeyHex(), testKeyHex)
	}
	if st.StoreKeyPath() != "" {
		t.Fatalf("显式注入不应有密钥文件路径，got %q", st.StoreKeyPath())
	}
	if _, err := os.Stat(defaultStoreKeyPath(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("显式注入不应写默认密钥文件，stat err=%v", err)
	}
}

func TestStoreKeyFromEnv(t *testing.T) {
	dir := t.TempDir()
	envKey := strings.Repeat("ab", 32)
	t.Setenv(envStoreKey, envKey)
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	if st.StoreKeyHex() != envKey {
		t.Fatalf("StoreKeyHex = %s, want %s", st.StoreKeyHex(), envKey)
	}
	if st.StoreKeyPath() != "" {
		t.Fatalf("env 注入不应有文件路径，got %q", st.StoreKeyPath())
	}
}

func TestStoreKeyFromEnvFile(t *testing.T) {
	dir := t.TempDir()
	keyFile := filepath.Join(t.TempDir(), "store.key")
	envKey := strings.Repeat("cd", 32)
	if err := os.WriteFile(keyFile, []byte(envKey+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(envStoreKey, "")
	t.Setenv(envStoreKeyFile, keyFile)
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	if st.StoreKeyHex() != envKey || st.StoreKeyPath() != keyFile {
		t.Fatalf("key=%s path=%s, want %s / %s", st.StoreKeyHex(), st.StoreKeyPath(), envKey, keyFile)
	}
}

func TestStoreKeyGeneratedOnceAndReused(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(envStoreKey, "")
	t.Setenv(envStoreKeyFile, "")
	st1, err := Open(dir)
	if err != nil {
		t.Fatalf("Open(1): %v", err)
	}
	first := st1.StoreKeyHex()
	keyPath := st1.StoreKeyPath()
	if len(first) != 64 {
		t.Fatalf("生成的密钥 hex 长度 = %d, want 64", len(first))
	}
	if keyPath != defaultStoreKeyPath(dir) {
		t.Fatalf("密钥路径 = %s, want %s", keyPath, defaultStoreKeyPath(dir))
	}
	if filepath.Dir(keyPath) == filepath.Clean(dir) {
		t.Fatalf("密钥文件不能放在 data 目录内: %s", keyPath)
	}
	if err := st1.Close(); err != nil {
		t.Fatal(err)
	}

	st2, err := Open(dir)
	if err != nil {
		t.Fatalf("Open(2): %v", err)
	}
	defer func() { _ = st2.Close() }()
	if st2.StoreKeyHex() != first {
		t.Fatalf("二次 Open 密钥漂移: %s != %s", st2.StoreKeyHex(), first)
	}
}

func TestStoreKeyFilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 无 POSIX 权限位，0600 由部署脚本/容器保证")
	}
	dir := t.TempDir()
	t.Setenv(envStoreKey, "")
	t.Setenv(envStoreKeyFile, "")
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	fi, err := os.Stat(st.StoreKeyPath())
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("密钥文件权限 = %o, want 600", perm)
	}
}

func TestStoreKeyRejectsBadInput(t *testing.T) {
	dir := t.TempDir()
	for _, bad := range []string{"", "   ", "zz", strings.Repeat("ab", 31), strings.Repeat("ab", 33)} {
		if _, err := Open(dir, WithStoreKey(bad)); err == nil {
			t.Fatalf("WithStoreKey(%q) 期望报错", bad)
		}
	}
	if _, err := Open(dir, WithStoreKey(testKeyHex)); err != nil {
		t.Fatalf("合法密钥被拒: %v", err)
	}
}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	st := openTemp(t)
	for _, plain := range []string{"", "a", strings.Repeat("中文内容", 1000)} {
		ct, err := st.Encrypt([]byte(plain))
		if err != nil {
			t.Fatalf("Encrypt: %v", err)
		}
		if len(ct) != len(plain)+gcmNonceSize+gcmTagSize {
			t.Fatalf("密文长度 = %d, want %d", len(ct), len(plain)+gcmNonceSize+gcmTagSize)
		}
		got, err := st.Decrypt(ct)
		if err != nil {
			t.Fatalf("Decrypt: %v", err)
		}
		if string(got) != plain {
			t.Fatalf("往返不一致: %q != %q", got, plain)
		}
	}
}

func TestEncryptUsesFreshNonce(t *testing.T) {
	st := openTemp(t)
	a, err := st.Encrypt([]byte("same"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.Encrypt([]byte("same"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(a, b) {
		t.Fatal("两次加密结果相同，nonce 未随机化")
	}
	if bytes.Equal(a[:gcmNonceSize], b[:gcmNonceSize]) {
		t.Fatal("nonce 前缀相同")
	}
}

func TestDecryptRejectsTamperWrongKeyShort(t *testing.T) {
	st := openTemp(t)
	ct, err := st.Encrypt([]byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	bad := append([]byte(nil), ct...)
	bad[len(bad)-1] ^= 0x01
	if _, err := st.Decrypt(bad); err == nil {
		t.Fatal("篡改密文后仍解密成功")
	}

	other, err := Open(t.TempDir(), WithStoreKey(strings.Repeat("ff", 32)))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = other.Close() }()
	if _, err := other.Decrypt(ct); err == nil {
		t.Fatal("换密钥后仍解密成功")
	}

	for _, short := range [][]byte{{}, []byte("short"), make([]byte, gcmNonceSize+gcmTagSize-1)} {
		if _, err := st.Decrypt(short); err == nil {
			t.Fatalf("过短密文（%d 字节）未报错", len(short))
		}
	}
}

func TestEncTextPrefixAndLegacyPlaintext(t *testing.T) {
	st := openTemp(t)
	enc, err := st.encText("正文内容")
	if err != nil {
		t.Fatalf("encText: %v", err)
	}
	if !strings.HasPrefix(enc, encPrefix) {
		t.Fatalf("密文缺少前缀: %q", enc)
	}
	if strings.Contains(enc, "正文内容") {
		t.Fatal("密文里出现了明文")
	}
	got, err := st.decText(enc)
	if err != nil || got != "正文内容" {
		t.Fatalf("decText = %q err=%v", got, err)
	}
	if got, err := st.decText("历史明文"); err != nil || got != "历史明文" {
		t.Fatalf("历史明文行应原样返回, got %q err=%v", got, err)
	}
	if s, err := st.encText(""); err != nil || s != "" {
		t.Fatalf("空串应保持空, got %q err=%v", s, err)
	}
	if _, err := st.decText(encPrefix + "!!!not-base64!!!"); err == nil {
		t.Fatal("坏 base64 未报错")
	}
}

var _ = fmt.Sprintf
```

（末尾 `var _ = fmt.Sprintf` 可删——若未用到 `fmt` 请一并从 import 中移除，保持 `go vet` 干净。）

- [ ] **Step 2: 运行测试确认失败**

```powershell
Set-Location e:\code\base
go test ./internal/store/ -run 'TestStoreKey|TestEncrypt|TestDecrypt|TestEncText' -v
```

Expected: 编译失败，报 `undefined: WithStoreKey` / `undefined: defaultStoreKeyPath` / `undefined: encPrefix` / `undefined: gcmNonceSize`。

- [ ] **Step 3: 写最小实现**

创建 `e:\code\base\internal\store\crypto.go`：

```go
package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// L4a′：节点本地静态加密。
// 加密与解密只发生在 store 包内部（落盘前 / 读盘后）：
// 跨过 store 边界的一律是明文，因此「同一内容在两个节点上 blob_id 相同、跨节点传输零重加密」仍然成立。
//
// 密钥独立于节点签名私钥，绝不派生：签名私钥轮换不应让历史内容不可读。
const (
	storeKeySize   = 32 // AES-256
	gcmNonceSize   = 12
	gcmTagSize     = 16
	encPrefix      = "enc:v1:" // 仅用于 TEXT 列（body_md），用于识别历史明文行
	envStoreKey     = "BASE_STORE_KEY"
	envStoreKeyFile = "BASE_STORE_KEY_FILE"
)

// Option 是 Open 的可选配置。
type Option func(*openConfig) error

type openConfig struct {
	storeKeyHex string
}

// WithStoreKey 直接注入 64 位 hex 密钥（优先级最高；测试与代码内嵌用）。
func WithStoreKey(hexKey string) Option {
	return func(c *openConfig) error {
		c.storeKeyHex = hexKey
		return nil
	}
}

// defaultStoreKeyPath 返回默认密钥文件路径：data 目录的**兄弟文件**，不是 data 目录内的文件。
// 触发威胁是「误拷/备份 data 目录」，密钥放进 data/ 等于形同虚设。
func defaultStoreKeyPath(dataDir string) string {
	return filepath.Clean(dataDir) + ".key"
}

func parseStoreKey(raw string) ([]byte, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, fmt.Errorf("store: empty store key")
	}
	key, err := hex.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("store: store key is not hex: %w", err)
	}
	if len(key) != storeKeySize {
		return nil, fmt.Errorf("store: store key must be %d bytes (hex %d chars), got %d bytes", storeKeySize, storeKeySize*2, len(key))
	}
	return key, nil
}

func newStoreKey() ([]byte, error) {
	k := make([]byte, storeKeySize)
	if _, err := rand.Read(k); err != nil {
		return nil, fmt.Errorf("store: generate store key: %w", err)
	}
	return k, nil
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("store: aes: %w", err)
	}
	return cipher.NewGCM(block)
}

// loadStoreKey 按优先级解析密钥；path 在密钥来自环境/参数时为空串。
func loadStoreKey(dataDir string, cfg openConfig) (key []byte, path string, err error) {
	if cfg.storeKeyHex != "" {
		k, err := parseStoreKey(cfg.storeKeyHex)
		return k, "", err
	}
	if v := strings.TrimSpace(os.Getenv(envStoreKey)); v != "" {
		k, err := parseStoreKey(v)
		return k, "", err
	}
	if f := strings.TrimSpace(os.Getenv(envStoreKeyFile)); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, f, fmt.Errorf("store: read %s=%s: %w", envStoreKeyFile, f, err)
		}
		k, err := parseStoreKey(string(b))
		return k, f, err
	}

	p := defaultStoreKeyPath(dataDir)
	b, err := os.ReadFile(p)
	switch {
	case err == nil:
		k, err := parseStoreKey(string(b))
		return k, p, err
	case !errors.Is(err, os.ErrNotExist):
		return nil, p, fmt.Errorf("store: read store key %s: %w", p, err)
	}
	k, err := newStoreKey()
	if err != nil {
		return nil, p, err
	}
	if err := os.WriteFile(p, []byte(hex.EncodeToString(k)+"\n"), 0o600); err != nil {
		return nil, p, fmt.Errorf("store: write store key %s: %w", p, err)
	}
	return k, p, nil
}

// StoreKeyHex 返回当前密钥 hex（仅供启动日志与运维核对，不落库）。
func (s *Store) StoreKeyHex() string { return hex.EncodeToString(s.storeKey) }

// StoreKeyPath 返回密钥文件路径；密钥来自参数/环境变量时返回空串。
func (s *Store) StoreKeyPath() string { return s.storeKeyPath }

// Encrypt 返回 nonce(12) || ciphertext || tag(16)。
func (s *Store) Encrypt(plain []byte) ([]byte, error) {
	nonce := make([]byte, gcmNonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("store: nonce: %w", err)
	}
	// dst 复用 nonce 的底层数组并追加密文，得到 nonce||ct||tag
	return s.aead.Seal(nonce, nonce, plain, nil), nil
}

// Decrypt 接受 nonce(12) || ciphertext || tag(16)。
func (s *Store) Decrypt(b []byte) ([]byte, error) {
	if len(b) < gcmNonceSize+gcmTagSize {
		return nil, fmt.Errorf("store: ciphertext too short (%d bytes)", len(b))
	}
	return s.aead.Open(nil, b[:gcmNonceSize], b[gcmNonceSize:], nil)
}

// encText 加密 TEXT 列；空串保持空串。带前缀便于识别历史明文行。
func (s *Store) encText(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	ct, err := s.Encrypt([]byte(plain))
	if err != nil {
		return "", err
	}
	return encPrefix + base64.StdEncoding.EncodeToString(ct), nil
}

// decText 解密 TEXT 列；无前缀视为历史明文行，原样返回。
func (s *Store) decText(stored string) (string, error) {
	if !strings.HasPrefix(stored, encPrefix) {
		return stored, nil
	}
	raw, err := base64.StdEncoding.DecodeString(stored[len(encPrefix):])
	if err != nil {
		return "", fmt.Errorf("store: bad base64 in encrypted text: %w", err)
	}
	pt, err := s.Decrypt(raw)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}
```

修改 `e:\code\base\internal\store\store.go`。

改动 A —— imports 增加 `"crypto/cipher"`（放在 `"database/sql"` 之后，保持字母序）：

```go
import (
	"crypto/cipher"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/johocn/base/internal/protocol"
	_ "modernc.org/sqlite"
)
```

改动 B —— `Store` 结构体：

```go
// Store 是内容库（SQLite + 块文件目录）访问层。
type Store struct {
	db           *sql.DB
	dataDir      string
	storeKey     []byte
	storeKeyPath string
	aead         cipher.AEAD
}
```

改动 C —— `Open` 函数头与前半段（密钥解析必须在 schema 之前完成，失败即退出）：

```go
// Open 打开/创建数据目录下的内容库。
func Open(dataDir string, opts ...Option) (*Store, error) {
	cfg := openConfig{}
	for _, opt := range opts {
		if opt == nil {
			continue
		}
		if err := opt(&cfg); err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(filepath.Join(dataDir, "blobs"), 0o755); err != nil {
		return nil, fmt.Errorf("store: mkdir blobs: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, "packs"), 0o755); err != nil {
		return nil, fmt.Errorf("store: mkdir packs: %w", err)
	}
	key, keyPath, err := loadStoreKey(dataDir, cfg)
	if err != nil {
		return nil, err
	}
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	dbPath := filepath.Join(dataDir, "base.db")
	dsn := "file:" + filepath.ToSlash(dbPath) + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("store: open: %w", err)
	}
	db.SetMaxOpenConns(1)
	st := &Store{db: db, dataDir: dataDir, storeKey: key, storeKeyPath: keyPath, aead: aead}
	for _, stmt := range schemaStatements {
		if _, err := db.Exec(stmt); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("store: schema: %w", err)
		}
	}
	return st, nil
}
```

改动 D —— 修改 `e:\code\base\internal\store\store_test.go` 的 `openTemp`，避免每次测试都在系统临时目录留下散落的 `.key` 文件：

```go
func openTemp(t *testing.T) *Store {
	t.Helper()
	st, err := Open(t.TempDir(), WithStoreKey(testKeyHex))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
Set-Location e:\code\base
go test ./internal/store/ -run 'TestStoreKey|TestEncrypt|TestDecrypt|TestEncText' -v
```

Expected: 全部 PASS（`TestStoreKeyFilePermissions` 在 Windows 上显示 SKIP）。

- [ ] **Step 5: 回归整个 store 包**

```powershell
go test ./internal/store/ ./internal/packexport/ ./internal/importer/
```

Expected: 三个包全部 `ok`。

- [ ] **Step 6: 提交**

```bash
git -C e:/code/base add internal/store/crypto.go internal/store/crypto_test.go internal/store/store.go internal/store/store_test.go
git -C e:/code/base commit -m "feat(store): L4a' 本地静态加密的密钥加载与 AES-256-GCM 封装"
```

---

### Task 7: blob 透明加解密

**Files:**
- Create: `e:\code\base\internal\store\blob_crypto_test.go`
- Modify: `e:\code\base\internal\store\store.go`（`PutBlob` / `HasBlob` / `GetBlobBytes`）

**为什么 `HasBlob` 要改成查 `blobs.size`**（修正 2）：磁盘文件 = 明文长度 + 28 字节。若继续用 `os.Stat`，`HEAD /v1/blob/:id` 的 `Content-Length` 会凭空多 28，破坏 P0 已定的接口语义。

**调用面确认**（已核实，改动外溢极小）：
- `GetBlobBytes` 唯一调用点 [content.go](file:///e:/code/base/internal/httpapi/content.go#L91) 的 `handleBlob`（它会重算明文哈希，解密后行为不变）
- `HasBlob` 唯一调用点 [content.go](file:///e:/code/base/internal/httpapi/content.go#L127) 的 `handleBlobHead`
- `internal/packexport` **不复制** blob 字节，只走 `ListArticles`（Task 8 解密后仍是明文），`data/packs/` 无需改动

- [ ] **Step 1: 写失败测试**

创建 `e:\code\base\internal\store\blob_crypto_test.go`：

```go
package store

import (
	"bytes"
	"os"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestPutBlobStoresCiphertext(t *testing.T) {
	st := openTemp(t)
	plain := []byte("块明文内容-blob-唯一标记")
	id := protocol.BlobID(plain)
	if err := st.PutBlob(id, plain, "cover:demo", 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	onDisk, err := os.ReadFile(st.BlobPath(id))
	if err != nil {
		t.Fatalf("读裸文件: %v", err)
	}
	if bytes.Contains(onDisk, plain) {
		t.Fatal("磁盘上出现了明文块内容")
	}
	if len(onDisk) != len(plain)+gcmNonceSize+gcmTagSize {
		t.Fatalf("磁盘文件大小 = %d, want %d", len(onDisk), len(plain)+gcmNonceSize+gcmTagSize)
	}
	got, err := st.GetBlobBytes(id)
	if err != nil {
		t.Fatalf("GetBlobBytes: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("GetBlobBytes = %q, want %q", got, plain)
	}
	if protocol.BlobID(got) != id {
		t.Fatalf("解密后重算的 blob_id 与原 id 不一致，会破坏 handleBlob 的坏块校验")
	}
}

func TestPutBlobStillRejectsIdMismatch(t *testing.T) {
	st := openTemp(t)
	plain := []byte("真实内容")
	wrong := protocol.BlobID([]byte("别的内容"))
	if err := st.PutBlob(wrong, plain, "", 0); err == nil {
		t.Fatal("blob_id 与明文不匹配时应报错（校验必须在明文上做）")
	}
}

func TestHasBlobReportsPlaintextSize(t *testing.T) {
	st := openTemp(t)
	plain := []byte("0123456789")
	id := protocol.BlobID(plain)
	if err := st.PutBlob(id, plain, "", 0); err != nil {
		t.Fatal(err)
	}
	ok, size, err := st.HasBlob(id)
	if err != nil || !ok {
		t.Fatalf("HasBlob ok=%v err=%v", ok, err)
	}
	if size != int64(len(plain)) {
		t.Fatalf("HasBlob size = %d, want %d（必须取 blobs 表的明文长度）", size, len(plain))
	}
}

func TestHasBlobFalseWhenFileDeleted(t *testing.T) {
	st := openTemp(t)
	plain := []byte("gone")
	id := protocol.BlobID(plain)
	if err := st.PutBlob(id, plain, "", 0); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(st.BlobPath(id)); err != nil {
		t.Fatal(err)
	}
	ok, size, err := st.HasBlob(id)
	if err != nil || ok || size != 0 {
		t.Fatalf("删文件后 HasBlob ok=%v size=%d err=%v, want false/0/nil", ok, size, err)
	}
}

func TestHasBlobFalseWhenNeverWritten(t *testing.T) {
	st := openTemp(t)
	ok, size, err := st.HasBlob(protocol.BlobID([]byte("nope")))
	if err != nil || ok || size != 0 {
		t.Fatalf("未写入的块 ok=%v size=%d err=%v, want false/0/nil", ok, size, err)
	}
}

func TestBlobPlaintextAbsentFromDataDir(t *testing.T) {
	st := openTemp(t)
	marker := []byte("BLOCK-PLAINTEXT-MARKER-9f3a")
	id := protocol.BlobID(marker)
	if err := st.PutBlob(id, marker, "", 0); err != nil {
		t.Fatal(err)
	}
	assertPlaintextAbsent(t, st.DataDir(), marker)
}
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
Set-Location e:\code\base
go test ./internal/store/ -run 'TestPutBlob|TestHasBlob|TestBlobPlaintext' -v
```

Expected: `TestPutBlobStoresCiphertext` FAIL（"磁盘上出现了明文块内容"）、`TestHasBlobReportsPlaintextSize` FAIL（size 比明文多 28）、`TestBlobPlaintextAbsentFromDataDir` FAIL；其余 PASS。

- [ ] **Step 3: 写最小实现**

修改 `e:\code\base\internal\store\store.go`。把 `PutBlob` / `HasBlob` / `GetBlobBytes` 三个函数整体替换为：

```go
// PutBlob 写入块文件并登记。
// blob_id 在**明文**上校验；落盘的是密文（L4a′）；blobs.size 记明文长度。
func (s *Store) PutBlob(blobID string, data []byte, itemID string, seq int) error {
	if !protocol.IsBlobID(blobID) {
		return fmt.Errorf("store: invalid blob id %q", blobID)
	}
	if got := protocol.BlobID(data); got != blobID {
		return fmt.Errorf("store: blob id mismatch: %s != %s", got, blobID)
	}
	enc, err := s.Encrypt(data)
	if err != nil {
		return fmt.Errorf("store: encrypt blob %s: %w", blobID, err)
	}
	p := s.BlobPath(blobID)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(p, enc, 0o644); err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO blobs(blob_id,size,item_id,seq,created_at) VALUES(?,?,?,?,?)
		ON CONFLICT(blob_id) DO UPDATE SET item_id=excluded.item_id, seq=excluded.seq`,
		blobID, int64(len(data)), itemID, seq, nowUTC())
	return err
}

// HasBlob 返回块是否存在及其**明文**大小。
// size 必须取自 blobs 表：磁盘文件是密文，比明文多 28 字节（nonce 12 + tag 16），
// 用 os.Stat 会让 HEAD /v1/blob/:id 的 Content-Length 多 28，改变既定接口语义。
func (s *Store) HasBlob(blobID string) (bool, int64, error) {
	if !protocol.IsBlobID(blobID) {
		return false, 0, fmt.Errorf("store: invalid blob id %q", blobID)
	}
	var size int64
	err := s.db.QueryRow(`SELECT size FROM blobs WHERE blob_id=?`, blobID).Scan(&size)
	if errors.Is(err, sql.ErrNoRows) {
		return false, 0, nil
	}
	if err != nil {
		return false, 0, err
	}
	if _, err := os.Stat(s.BlobPath(blobID)); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, 0, nil
		}
		return false, 0, err
	}
	return true, size, nil
}

// GetBlobBytes 读取块文件并解密，返回明文。
func (s *Store) GetBlobBytes(blobID string) ([]byte, error) {
	if !protocol.IsBlobID(blobID) {
		return nil, fmt.Errorf("store: invalid blob id %q", blobID)
	}
	raw, err := os.ReadFile(s.BlobPath(blobID))
	if err != nil {
		return nil, err
	}
	plain, err := s.Decrypt(raw)
	if err != nil {
		return nil, fmt.Errorf("store: decrypt blob %s: %w", blobID, err)
	}
	return plain, nil
}
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
Set-Location e:\code\base
go test ./internal/store/ -run 'TestPutBlob|TestHasBlob|TestBlobPlaintext' -v
```

Expected: 全部 PASS。

- [ ] **Step 5: 回归（含 HTTP 层的坏块校验与 HEAD）**

```powershell
Set-Location e:\code\base
go test ./internal/... ./cmd/...
```

Expected: 全部 `ok`，无 FAIL。

- [ ] **Step 6: 提交**

```bash
git -C e:/code/base add internal/store/blob_crypto_test.go internal/store/store.go
git -C e:/code/base commit -m "feat(store): blob 落盘加密，HasBlob 改以 blobs.size 报明文长度"
```


---

### Task 8: `articles.body_md` 透明加解密

**Files:**
- Create: `e:\code\base\internal\store\text_crypto_test.go`
- Modify: `e:\code\base\internal\store\store.go`（`UpsertArticle` / `GetArticle` / `ListArticles`）

**为什么要带 `enc:v1:` 前缀而不是裸密文**（修正 5，册子 §7.2 未写明）：`body_md` 是 TEXT 列，且升级前已存在的数据目录里全是明文行。带前缀可用 `decText` 区分「历史明文」与「本版密文」，避免升级即不可读；blob 是二进制文件，无此需要，保持裸密文（nonce||ct||tag）。

- [ ] **Step 1: 写失败测试**

创建 `e:\code\base\internal\store\text_crypto_test.go`：

```go
package store

import (
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestArticleBodyEncryptedAtRest(t *testing.T) {
	st := openTemp(t)
	body := "这是正文，绝不能以明文出现在 data 目录里"
	a := Article{ItemID: "article:enc", Title: "t", BodyMD: body,
		ContentHash: protocol.SHA256Hex([]byte(body)), SourceRev: "r", UpdatedAt: "2026-01-01T00:00:00Z"}
	if err := st.UpsertArticle(a); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}

	var raw string
	if err := st.db.QueryRow(`SELECT body_md FROM articles WHERE item_id=?`, a.ItemID).Scan(&raw); err != nil {
		t.Fatalf("裸读 body_md: %v", err)
	}
	if strings.Contains(raw, "这是正文") {
		t.Fatal("body_md 列里出现了明文")
	}
	if !strings.HasPrefix(raw, encPrefix) {
		t.Fatalf("body_md 未带加密前缀: %q", raw)
	}
	assertPlaintextAbsent(t, st.DataDir(), []byte(body))

	got, ok, err := st.GetArticle(a.ItemID)
	if err != nil || !ok {
		t.Fatalf("GetArticle ok=%v err=%v", ok, err)
	}
	if got.BodyMD != body {
		t.Fatalf("GetArticle.BodyMD = %q, want %q", got.BodyMD, body)
	}

	m, err := st.ListArticles([]string{a.ItemID})
	if err != nil {
		t.Fatal(err)
	}
	if m[a.ItemID].BodyMD != body {
		t.Fatalf("ListArticles 返回未解密内容: %q", m[a.ItemID].BodyMD)
	}
}

func TestArticleUpsertReEncryptsEveryWrite(t *testing.T) {
	st := openTemp(t)
	body := "同一段正文"
	a := Article{ItemID: "article:twice", Title: "t", BodyMD: body,
		ContentHash: protocol.SHA256Hex([]byte(body)), SourceRev: "r", UpdatedAt: "2026-01-01T00:00:00Z"}
	if err := st.UpsertArticle(a); err != nil {
		t.Fatal(err)
	}
	var first string
	if err := st.db.QueryRow(`SELECT body_md FROM articles WHERE item_id=?`, a.ItemID).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertArticle(a); err != nil {
		t.Fatal(err)
	}
	var second string
	if err := st.db.QueryRow(`SELECT body_md FROM articles WHERE item_id=?`, a.ItemID).Scan(&second); err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("两次写入的密文相同，nonce 未随机化")
	}
	got, _, err := st.GetArticle(a.ItemID)
	if err != nil || got.BodyMD != body {
		t.Fatalf("重复写入后读回不一致: %q err=%v", got.BodyMD, err)
	}
}

func TestArticleReadsLegacyPlaintextRow(t *testing.T) {
	st := openTemp(t)
	if _, err := st.db.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
		VALUES('article:legacy','article','article','t','r','h','articles','public','active','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.Exec(`INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev)
		VALUES('article:legacy','t','','','[]','历史明文正文','h','r')`); err != nil {
		t.Fatal(err)
	}
	got, ok, err := st.GetArticle("article:legacy")
	if err != nil || !ok {
		t.Fatalf("GetArticle ok=%v err=%v", ok, err)
	}
	if got.BodyMD != "历史明文正文" {
		t.Fatalf("历史明文行应原样返回，got %q", got.BodyMD)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
Set-Location e:\code\base
go test ./internal/store/ -run 'TestArticle' -v
```

Expected: `TestArticleBodyEncryptedAtRest` FAIL（"body_md 列里出现了明文"）、`TestArticleUpsertReEncryptsEveryWrite` 可能 PASS（明文写入也不稳定？不，明文写入两次完全相同 → FAIL）；`TestArticleReadsLegacyPlaintextRow` PASS。

- [ ] **Step 3: 写最小实现**

修改 `e:\code\base\internal\store\store.go`。

改动 A —— `UpsertArticle` 中 `articles` 那条 Exec 之前插入加密，并把 `a.BodyMD` 换成 `bodyEnc`：

```go
	bodyEnc, err := s.encText(a.BodyMD)
	if err != nil {
		return fmt.Errorf("store: encrypt body_md: %w", err)
	}
	if _, err := tx.Exec(`INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev)
		VALUES(?,?,?,?,?,?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			title=excluded.title, digest=excluded.digest, published_at=excluded.published_at,
			tags_json=excluded.tags_json, body_md=excluded.body_md, content_hash=excluded.content_hash, source_rev=excluded.source_rev`,
		a.ItemID, a.Title, a.Digest, a.PublishedAt, a.TagsJSON, bodyEnc, a.ContentHash, a.SourceRev); err != nil {
		return fmt.Errorf("store: upsert article: %w", err)
	}
```

改动 B —— `GetArticle` 在 `row.Scan` 成功之后、`return` 之前插入解密：

```go
	if err != nil {
		return Article{}, false, err
	}
	body, err := s.decText(a.BodyMD)
	if err != nil {
		return Article{}, false, fmt.Errorf("store: decrypt body_md %s: %w", itemID, err)
	}
	a.BodyMD = body
	return a, true, nil
```

改动 C —— `ListArticles` 的循环体内，`Scan` 之后插入解密：

```go
		if err := rows.Scan(&a.ItemID, &a.Title, &a.Digest, &a.PublishedAt, &a.TagsJSON, &a.BodyMD, &a.ContentHash, &a.SourceRev); err != nil {
			return nil, err
		}
		body, err := s.decText(a.BodyMD)
		if err != nil {
			return nil, fmt.Errorf("store: decrypt body_md %s: %w", a.ItemID, err)
		}
		a.BodyMD = body
		out[a.ItemID] = a
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
Set-Location e:\code\base
go test ./internal/store/ -run 'TestArticle' -v
```

Expected: 三个测试全部 PASS。

- [ ] **Step 5: 回归（重点：packexport 导出的是明文，导入侧才能读到）**

```powershell
Set-Location e:\code\base
go test ./internal/... ./cmd/...
```

Expected: 全部 `ok`。若 `packexport` 或 `importer` 用例失败，说明密文漏到了导出侧——不要改测试，回到 Step 3 检查是否漏了某个读取点。

- [ ] **Step 6: 提交**

```bash
git -C e:/code/base add internal/store/text_crypto_test.go internal/store/store.go
git -C e:/code/base commit -m "feat(store): articles.body_md 落盘加密，带 enc:v1 前缀兼容历史明文行"
```

---

## 阶段三：HTTP 接口（Task 9-11）

### Task 9: 身份接口处理器 + 同 IP 令牌桶

**Files:**
- Create: `e:\code\base\internal\httpapi\identity.go`
- Create: `e:\code\base\internal\httpapi\identity_test.go`
- Modify: `e:\code\base\internal\httpapi\server.go`（`Server` 加 `escrowLimiter` 字段；`New` 里初始化）

**落点理由**：不再新增 `internal/auth` 服务层——本仓库既有分层就是 `httpapi` 直接持有 `store`（见 [public.go](file:///e:/code/base/internal/httpapi/public.go#L69) 的 `s.st.LatestPack()`）。领域不变量（pubkey↔id 一致、托管冲突）已经在 Task 2 的 `protocol.IdentityID` 与 Task 5 的 `store.RegisterIdentity`/`PutEscrow` 里强制，再加一层只转发不判断的服务层是纯冗余。

- [ ] **Step 1: 写失败测试**

创建 `e:\code\base\internal\httpapi\identity_test.go`：

```go
package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

const identityTestStoreKey = "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f"

const escrowKDF = `{"alg":"argon2id","m":65536,"t":3,"p":1,"len":32}`

func identityFromSeed(t *testing.T, seed string) (id, pub string) {
	t.Helper()
	kp, err := protocol.KeyPairFromSeed(seed)
	if err != nil {
		t.Fatalf("KeyPairFromSeed: %v", err)
	}
	id, err = protocol.IdentityID(kp.PubHex)
	if err != nil {
		t.Fatalf("IdentityID: %v", err)
	}
	return id, strings.ToLower(kp.PubHex)
}

// withAuth 模拟验签中间件（真实验签由 Task 10 覆盖）。
// 默认用 defaultID；带 X-Test-Id 头时改用该 id，便于构造「不同身份」场景。
func withAuth(next http.HandlerFunc, defaultID string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := defaultID
		if v := r.Header.Get("X-Test-Id"); v != "" {
			id = v
		}
		next(w, withIdentity(r, id))
	})
}

func newIdentityServer(t *testing.T) (*store.Store, *Server, *httptest.Server) {
	t.Helper()
	st, err := store.Open(t.TempDir(), store.WithStoreKey(identityTestStoreKey))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	srv, err := New(st, Options{Issuer: "base-node-1", SignKeyHex: testSeed, Version: "test"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	authID, _ := identityFromSeed(t, testSeed)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/identity/register", srv.handleIdentityRegister)
	mux.HandleFunc("GET /v1/identity/{id}", srv.handleIdentityGet)
	mux.HandleFunc("GET /v1/identity/escrow/{username}", srv.handleEscrowGet)
	mux.Handle("PUT /v1/identity/escrow/{username}", withAuth(srv.handleEscrowPut, authID))
	mux.Handle("GET /v1/me", withAuth(srv.handleMe, authID))
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return st, srv, ts
}

func doIdentityJSON(t *testing.T, method, rawURL, asID, body string) (int, map[string]any) {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, rawURL, rdr)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if asID != "" {
		req.Header.Set("X-Test-Id", asID)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	out := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("响应不是 JSON: %s", raw)
		}
	}
	return res.StatusCode, out
}

func registerBody(id, pub string) string {
	return `{"id":"` + id + `","alg":"ed25519","pubkey":"` + pub + `"}`
}

func escrowBody(id string) string {
	return `{"id":"` + id + `","alg":"ed25519","salt":"` + strings.Repeat("cd", 16) + `","kdf":` + escrowKDF +
		`,"enc_nonce":"` + strings.Repeat("ef", 12) + `","priv_cipher":"` + strings.Repeat("ab", 48) + `"}`
}

func TestIdentityRegisterIsSelfCertifying(t *testing.T) {
	st, _, ts := newIdentityServer(t)
	id, pub := identityFromSeed(t, testSeed)

	status, body := doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/identity/register", "", registerBody(id, pub))
	if status != http.StatusOK || body["registered"] != true {
		t.Fatalf("首次登记 status=%d body=%v, want 200/true", status, body)
	}
	if _, ok, err := st.LookupIdentity(id); err != nil || !ok {
		t.Fatalf("登记后应能查到 ok=%v err=%v", ok, err)
	}

	status, body = doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/identity/register", "", registerBody(id, pub))
	if status != http.StatusOK || body["registered"] != false {
		t.Fatalf("重复登记 status=%d body=%v, want 200/false（幂等）", status, body)
	}

	status, body = doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/identity/register", "", registerBody(strings.Repeat("0", 32), pub))
	if status != http.StatusBadRequest || body["error"] != "identity_id_mismatch" {
		t.Fatalf("id 与 pubkey 不匹配 status=%d body=%v, want 400/identity_id_mismatch", status, body)
	}

	status, body = doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/identity/register", "",
		`{"id":"`+id+`","alg":"rsa","pubkey":"`+pub+`"}`)
	if status != http.StatusBadRequest || body["error"] != "identity_alg_unsupported" {
		t.Fatalf("alg 非法 status=%d body=%v, want 400/identity_alg_unsupported", status, body)
	}

	status, body = doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/identity/register", "",
		`{"id":"`+id+`","alg":"ed25519","pubkey":"zz"}`)
	if status != http.StatusBadRequest || body["error"] != "identity_pubkey_invalid" {
		t.Fatalf("pubkey 非法 status=%d body=%v, want 400/identity_pubkey_invalid", status, body)
	}

	status, body = doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/identity/register", "", `{`)
	if status != http.StatusBadRequest || body["error"] != "bad_json" {
		t.Fatalf("坏 JSON status=%d body=%v, want 400/bad_json", status, body)
	}
}

func TestIdentityGetAfterRegister(t *testing.T) {
	_, _, ts := newIdentityServer(t)
	id, pub := identityFromSeed(t, testSeed)
	if status, _ := doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/identity/register", "", registerBody(id, pub)); status != http.StatusOK {
		t.Fatalf("register status=%d", status)
	}

	status, body := doIdentityJSON(t, http.MethodGet, ts.URL+"/v1/identity/"+id, "", "")
	if status != http.StatusOK || body["pubkey"] != pub || body["alg"] != "ed25519" || body["id"] != id {
		t.Fatalf("GET identity status=%d body=%v", status, body)
	}
	if _, ok := body["created_at"]; !ok {
		t.Fatalf("响应缺 created_at: %v", body)
	}

	status, body = doIdentityJSON(t, http.MethodGet, ts.URL+"/v1/identity/"+strings.Repeat("a", 32), "", "")
	if status != http.StatusNotFound || body["error"] != "identity_not_found" {
		t.Fatalf("未登记身份 status=%d body=%v, want 404/identity_not_found", status, body)
	}

	status, body = doIdentityJSON(t, http.MethodGet, ts.URL+"/v1/identity/notahex", "", "")
	if status != http.StatusBadRequest || body["error"] != "identity_id_invalid" {
		t.Fatalf("非法 id status=%d body=%v, want 400/identity_id_invalid", status, body)
	}
}

func TestEscrowPutAndGetRoundTrip(t *testing.T) {
	_, _, ts := newIdentityServer(t)
	id, pub := identityFromSeed(t, testSeed)
	if status, _ := doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/identity/register", "", registerBody(id, pub)); status != http.StatusOK {
		t.Fatalf("register status=%d", status)
	}

	status, body := doIdentityJSON(t, http.MethodPut, ts.URL+"/v1/identity/escrow/alice", "", escrowBody(id))
	if status != http.StatusOK || body["username"] != "alice" {
		t.Fatalf("PUT escrow status=%d body=%v", status, body)
	}
	if _, ok := body["updated_at"]; !ok {
		t.Fatalf("PUT 响应缺 updated_at: %v", body)
	}

	status, body = doIdentityJSON(t, http.MethodGet, ts.URL+"/v1/identity/escrow/alice", "", "")
	if status != http.StatusOK {
		t.Fatalf("GET escrow status=%d body=%v", status, body)
	}
	if body["id"] != id || body["alg"] != "ed25519" || body["salt"] != strings.Repeat("cd", 16) ||
		body["enc_nonce"] != strings.Repeat("ef", 12) || body["priv_cipher"] != strings.Repeat("ab", 48) {
		t.Fatalf("托管字段未原样返回: %v", body)
	}
	kdf, ok := body["kdf"].(map[string]any)
	if !ok || kdf["alg"] != "argon2id" || kdf["m"] != float64(65536) || kdf["len"] != float64(32) {
		t.Fatalf("kdf 未原样返回: %v", body["kdf"])
	}

	status, body = doIdentityJSON(t, http.MethodGet, ts.URL+"/v1/identity/escrow/nobody", "", "")
	if status != http.StatusNotFound || body["error"] != "escrow_not_found" {
		t.Fatalf("未托管用户 status=%d body=%v, want 404/escrow_not_found", status, body)
	}
}

func TestEscrowPutRejectsIdentityMismatch(t *testing.T) {
	_, _, ts := newIdentityServer(t)
	otherID, _ := identityFromSeed(t, strings.Repeat("ab", 32))
	status, body := doIdentityJSON(t, http.MethodPut, ts.URL+"/v1/identity/escrow/bob", "", escrowBody(otherID))
	if status != http.StatusForbidden || body["error"] != "escrow_identity_mismatch" {
		t.Fatalf("请求体 id 与验签身份不一致 status=%d body=%v, want 403/escrow_identity_mismatch", status, body)
	}
}

func TestEscrowPutRejectsBadParams(t *testing.T) {
	_, _, ts := newIdentityServer(t)
	id, pub := identityFromSeed(t, testSeed)
	if status, _ := doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/identity/register", "", registerBody(id, pub)); status != http.StatusOK {
		t.Fatalf("register status=%d", status)
	}
	cases := []struct {
		name string
		body string
		err  string
	}{
		{"salt 长度错", `{"id":"` + id + `","alg":"ed25519","salt":"cd","kdf":` + escrowKDF + `,"enc_nonce":"` + strings.Repeat("ef", 12) + `","priv_cipher":"ab"}`, "escrow_param_invalid"},
		{"enc_nonce 长度错", `{"id":"` + id + `","alg":"ed25519","salt":"` + strings.Repeat("cd", 16) + `","kdf":` + escrowKDF + `,"enc_nonce":"ef","priv_cipher":"ab"}`, "escrow_param_invalid"},
		{"priv_cipher 非 hex", `{"id":"` + id + `","alg":"ed25519","salt":"` + strings.Repeat("cd", 16) + `","kdf":` + escrowKDF + `,"enc_nonce":"` + strings.Repeat("ef", 12) + `","priv_cipher":"zz"}`, "escrow_param_invalid"},
		{"kdf 非 argon2id", `{"id":"` + id + `","alg":"ed25519","salt":"` + strings.Repeat("cd", 16) + `","kdf":{"alg":"pbkdf2","m":1,"t":1,"p":1,"len":32},"enc_nonce":"` + strings.Repeat("ef", 12) + `","priv_cipher":"ab"}`, "escrow_kdf_invalid"},
		{"kdf len 非 32", `{"id":"` + id + `","alg":"ed25519","salt":"` + strings.Repeat("cd", 16) + `","kdf":{"alg":"argon2id","m":65536,"t":3,"p":1,"len":16},"enc_nonce":"` + strings.Repeat("ef", 12) + `","priv_cipher":"ab"}`, "escrow_kdf_invalid"},
		{"alg 非 ed25519", `{"id":"` + id + `","alg":"rsa","salt":"` + strings.Repeat("cd", 16) + `","kdf":` + escrowKDF + `,"enc_nonce":"` + strings.Repeat("ef", 12) + `","priv_cipher":"ab"}`, "identity_alg_unsupported"},
	}
	for _, c := range cases {
		status, body := doIdentityJSON(t, http.MethodPut, ts.URL+"/v1/identity/escrow/dave", "", c.body)
		if status != http.StatusBadRequest || body["error"] != c.err {
			t.Fatalf("%s status=%d body=%v, want 400/%s", c.name, status, body, c.err)
		}
	}
}

func TestEscrowConflictReturns409(t *testing.T) {
	_, _, ts := newIdentityServer(t)
	id1, pub1 := identityFromSeed(t, testSeed)
	id2, pub2 := identityFromSeed(t, strings.Repeat("ab", 32))
	for _, p := range [][2]string{{id1, pub1}, {id2, pub2}} {
		if status, _ := doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/identity/register", "", registerBody(p[0], p[1])); status != http.StatusOK {
			t.Fatalf("register %s status=%d", p[0], status)
		}
	}
	if status, body := doIdentityJSON(t, http.MethodPut, ts.URL+"/v1/identity/escrow/carol", id1, escrowBody(id1)); status != http.StatusOK {
		t.Fatalf("id1 首次 PUT status=%d body=%v", status, body)
	}
	status, body := doIdentityJSON(t, http.MethodPut, ts.URL+"/v1/identity/escrow/carol", id2, escrowBody(id2))
	if status != http.StatusConflict || body["error"] != "escrow_conflict" {
		t.Fatalf("换身份占用同一 username status=%d body=%v, want 409/escrow_conflict", status, body)
	}
}

func TestEscrowUsernameValidation(t *testing.T) {
	_, _, ts := newIdentityServer(t)
	for _, u := range []string{"a", "ab", "has space", "-lead", "has.dot", "用户名", strings.Repeat("x", 33)} {
		status, body := doIdentityJSON(t, http.MethodGet, ts.URL+"/v1/identity/escrow/"+url.PathEscape(u), "", "")
		if status != http.StatusBadRequest || body["error"] != "escrow_username_invalid" {
			t.Fatalf("username %q status=%d body=%v, want 400/escrow_username_invalid", u, status, body)
		}
	}
}

func TestEscrowGetRateLimited(t *testing.T) {
	_, srv, ts := newIdentityServer(t)
	srv.escrowLimiter = newIPLimiter(60, 3)
	for i := 1; i <= 3; i++ {
		if status, body := doIdentityJSON(t, http.MethodGet, ts.URL+"/v1/identity/escrow/nobody", "", ""); status != http.StatusNotFound {
			t.Fatalf("第 %d 次 status=%d body=%v, want 404（令牌桶内）", i, status, body)
		}
	}
	status, body := doIdentityJSON(t, http.MethodGet, ts.URL+"/v1/identity/escrow/nobody", "", "")
	if status != http.StatusTooManyRequests || body["error"] != "rate_limited" {
		t.Fatalf("超出令牌桶 status=%d body=%v, want 429/rate_limited", status, body)
	}
}

func TestMeReturnsEmptyArrays(t *testing.T) {
	_, _, ts := newIdentityServer(t)
	id, _ := identityFromSeed(t, testSeed)
	status, body := doIdentityJSON(t, http.MethodGet, ts.URL+"/v1/me", "", "")
	if status != http.StatusOK || body["id"] != id {
		t.Fatalf("GET /v1/me status=%d body=%v", status, body)
	}
	ev, ok1 := body["events"].([]any)
	pg, ok2 := body["progress"].([]any)
	if !ok1 || !ok2 || len(ev) != 0 || len(pg) != 0 {
		t.Fatalf("events/progress 必须是空数组而不是 null: %v", body)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
Set-Location e:\code\base
go test ./internal/httpapi/ -run 'TestIdentity|TestEscrow|TestMe' -v
```

Expected: 编译失败，报 `srv.handleIdentityRegister undefined` / `undefined: withIdentity` / `srv.escrowLimiter undefined`。

- [ ] **Step 3: 写最小实现**

创建 `e:\code\base\internal\httpapi\identity.go`：

```go
package httpapi

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// maxJSONBody 限制请求体：身份与托管请求都很小，超过即视为异常。
const maxJSONBody = 64 << 10

type ctxKey int

const ctxKeyIdentity ctxKey = iota + 1

// withIdentity 把已验签的身份 id 写入请求上下文（只由验签中间件调用）。
func withIdentity(r *http.Request, id string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), ctxKeyIdentity, id))
}

// identityFrom 取出已验签的身份 id；空串表示未挂验签中间件或未通过。
func identityFrom(r *http.Request) string {
	v, _ := r.Context().Value(ctxKeyIdentity).(string)
	return v
}

// decodeJSON 读请求体并反序列化；失败时已写好 400 响应，调用方直接 return。
func (s *Server) decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	defer func() { _ = r.Body.Close() }()
	dec := json.NewDecoder(io.LimitReader(r.Body, maxJSONBody))
	if err := dec.Decode(dst); err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_json")
		return false
	}
	return true
}

func isHexN(s string, n int) bool {
	if len(s) != n*2 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

func isHexNonEmptyEven(s string) bool {
	if len(s) == 0 || len(s)%2 != 0 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// validUsername 严格按契约 4.2：^[a-zA-Z0-9_]{3,32}$。
// 不做大小写归一：静默改写会让「用户以为的名字」与「托管键」不一致。
func validUsername(s string) bool {
	if len(s) < 3 || len(s) > 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_':
		default:
			return false
		}
	}
	return true
}

type identityRegisterReq struct {
	ID     string `json:"id"`
	Alg    string `json:"alg"`
	PubKey string `json:"pubkey"`
}

// handleIdentityRegister 匿名登记公钥（契约 5.1）。
// 不需要签名：节点重算 sha256(pubkey)[0:32] 并与 id 比对，请求自证且无可篡改。
func (s *Server) handleIdentityRegister(w http.ResponseWriter, r *http.Request) {
	var req identityRegisterReq
	if !s.decodeJSON(w, r, &req) {
		return
	}
	if req.Alg != protocol.AlgEd25519 {
		s.writeError(w, http.StatusBadRequest, "identity_alg_unsupported")
		return
	}
	wantID, err := protocol.IdentityID(req.PubKey)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "identity_pubkey_invalid")
		return
	}
	if !strings.EqualFold(wantID, req.ID) {
		s.writeError(w, http.StatusBadRequest, "identity_id_mismatch")
		return
	}
	registered, err := s.st.RegisterIdentity(wantID, req.Alg, strings.ToLower(req.PubKey), time.Now().UnixMilli())
	if err != nil {
		if errors.Is(err, store.ErrIdentityPubKeyMismatch) {
			s.writeError(w, http.StatusConflict, "identity_pubkey_conflict")
			return
		}
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"id": wantID, "alg": req.Alg, "registered": registered})
}

// handleIdentityGet 匿名查询公钥（契约 5.2），供验签他人事件与私信发送方。
func (s *Server) handleIdentityGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !protocol.IsIdentityID(id) {
		s.writeError(w, http.StatusBadRequest, "identity_id_invalid")
		return
	}
	it, ok, err := s.st.LookupIdentity(strings.ToLower(id))
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		s.writeError(w, http.StatusNotFound, "identity_not_found")
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"id": it.ID, "alg": it.Alg, "pubkey": it.PubKey, "created_at": it.CreatedAt,
	})
}

type kdfParams struct {
	Alg string `json:"alg"`
	M   int64  `json:"m"`
	T   int64  `json:"t"`
	P   int64  `json:"p"`
	Len int64  `json:"len"`
}

type escrowPutReq struct {
	ID         string    `json:"id"`
	Alg        string    `json:"alg"`
	Salt       string    `json:"salt"`
	KDF        kdfParams `json:"kdf"`
	EncNonce   string    `json:"enc_nonce"`
	PrivCipher string    `json:"priv_cipher"`
}

// handleEscrowPut 写入密码托管密文（契约 5.3，需签名头）。
// 节点只存不解释：不派生密钥、不解密、不校验密码，因此也无从判断 priv_cipher 是否正确。
func (s *Server) handleEscrowPut(w http.ResponseWriter, r *http.Request) {
	username := r.PathValue("username")
	if !validUsername(username) {
		s.writeError(w, http.StatusBadRequest, "escrow_username_invalid")
		return
	}
	authID := identityFrom(r)
	var req escrowPutReq
	if !s.decodeJSON(w, r, &req) {
		return
	}
	if !strings.EqualFold(req.ID, authID) {
		s.writeError(w, http.StatusForbidden, "escrow_identity_mismatch")
		return
	}
	if req.Alg != protocol.AlgEd25519 {
		s.writeError(w, http.StatusBadRequest, "identity_alg_unsupported")
		return
	}
	if !isHexN(req.Salt, 16) || !isHexN(req.EncNonce, 12) || !isHexNonEmptyEven(req.PrivCipher) {
		s.writeError(w, http.StatusBadRequest, "escrow_param_invalid")
		return
	}
	if req.KDF.Alg != "argon2id" || req.KDF.M <= 0 || req.KDF.T <= 0 || req.KDF.P <= 0 || req.KDF.Len != 32 {
		s.writeError(w, http.StatusBadRequest, "escrow_kdf_invalid")
		return
	}
	kdfJSON, err := json.Marshal(req.KDF)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UnixMilli()
	err = s.st.PutEscrow(store.EscrowRecord{
		Username: username, ID: strings.ToLower(req.ID), Alg: req.Alg, Salt: req.Salt,
		KDFJSON: string(kdfJSON), EncNonce: req.EncNonce,
		PrivCipher: req.PrivCipher, UpdatedAt: now,
	})
	if errors.Is(err, store.ErrEscrowConflict) {
		s.writeError(w, http.StatusConflict, "escrow_conflict")
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"username": username, "updated_at": now})
}

// handleEscrowGet 匿名取回托管密文（契约 5.4），同 IP 限速。
func (s *Server) handleEscrowGet(w http.ResponseWriter, r *http.Request) {
	username := r.PathValue("username")
	if !validUsername(username) {
		s.writeError(w, http.StatusBadRequest, "escrow_username_invalid")
		return
	}
	if !s.escrowLimiter.allow(clientIP(r)) {
		w.Header().Set("Retry-After", "60")
		s.writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	rec, ok, err := s.st.GetEscrow(username)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		s.writeError(w, http.StatusNotFound, "escrow_not_found")
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"username": rec.Username, "id": rec.ID, "alg": rec.Alg, "salt": rec.Salt,
		"kdf": json.RawMessage(rec.KDFJSON), "enc_nonce": rec.EncNonce,
		"priv_cipher": rec.PrivCipher, "updated_at": rec.UpdatedAt,
	})
}

// handleMe 返回当前身份与事件/进度骨架（契约 5.5）。
// events/progress 恒为空数组而非 null：结构先定死，客户端可无条件迭代。
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	s.writeJSON(w, http.StatusOK, map[string]any{
		"id": identityFrom(r), "events": []any{}, "progress": []any{},
	})
}

func clientIP(r *http.Request) string {
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return h
	}
	return r.RemoteAddr
}

// ipLimiter 是极简同 IP 令牌桶，只给匿名 escrow 读取用。
// 目的不是抗 DDoS，而是把「离线猜测密码哈希」的请求速率压到可控范围。
type ipLimiter struct {
	mu        sync.Mutex
	rate      float64 // 每秒补充令牌数
	burst     float64
	buckets   map[string]*ipBucket
	lastSweep time.Time
}

type ipBucket struct {
	tokens float64
	last   time.Time
}

func newIPLimiter(perMinute, burst float64) *ipLimiter {
	return &ipLimiter{
		rate: perMinute / 60, burst: burst,
		buckets: map[string]*ipBucket{}, lastSweep: time.Now(),
	}
}

func (l *ipLimiter) allow(ip string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweepLocked(now)
	b, ok := l.buckets[ip]
	if !ok {
		b = &ipBucket{tokens: l.burst, last: now}
		l.buckets[ip] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// sweepLocked 清理 10 分钟无活动的桶，避免 map 无界增长。
func (l *ipLimiter) sweepLocked(now time.Time) {
	if now.Sub(l.lastSweep) < 10*time.Minute {
		return
	}
	l.lastSweep = now
	for ip, b := range l.buckets {
		if now.Sub(b.last) > 10*time.Minute {
			delete(l.buckets, ip)
		}
	}
}
```

修改 `e:\code\base\internal\httpapi\server.go`。

改动 A —— `Server` 结构体加字段：

```go
// Server 是节点 HTTP 服务。
type Server struct {
	st            *store.Store
	opt           Options
	pub           string
	escrowLimiter *ipLimiter
}
```

改动 B —— `New` 里初始化限速器（契约 4.2：10 次/分钟、突发 10）：

```go
func New(st *store.Store, opt Options) (*Server, error) {
	s := &Server{st: st, opt: opt, escrowLimiter: newIPLimiter(10, 10)}
	if opt.SignKeyHex != "" {
		kp, err := protocol.KeyPairFromSeed(opt.SignKeyHex)
		if err != nil {
			return nil, err
		}
		s.pub = kp.PubHex
	}
	return s, nil
}
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
Set-Location e:\code\base
go test ./internal/httpapi/ -run 'TestIdentity|TestEscrow|TestMe' -v
```

Expected: 10 个测试全部 PASS。

- [ ] **Step 5: 回归（确认没破坏既有匿名公开读接口）**

```powershell
Set-Location e:\code\base
go test ./internal/httpapi/
```

Expected: `ok`。

- [ ] **Step 6: 提交**

```bash
git -C e:/code/base add internal/httpapi/identity.go internal/httpapi/identity_test.go internal/httpapi/server.go
git -C e:/code/base commit -m "feat(httpapi): 身份登记/查询、密码托管读写与同 IP 令牌桶"
```

---

### Task 10: 签名头验签中间件

**Files:**
- Create: `e:\code\base\internal\httpapi\authmw.go`
- Create: `e:\code\base\internal\httpapi\authmw_test.go`

**契约依据**：册子 §3.2 的 7 步顺序**固定**、先验后读体；§3.3 规定 `writeAuthErr` 形如 `{"error":"<人读消息>","code":"<机器码>"}`，客户端只依赖 `code`。P0 既有的 `writeError`（`{"error": "..."}`）**不改**，否则破坏 P0 验收。

- [ ] **Step 1: 写失败测试**

创建 `e:\code\base\internal\httpapi\authmw_test.go`：

```go
package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

func newAuthServer(t *testing.T) (*store.Store, *Server, *httptest.Server) {
	t.Helper()
	st, err := store.Open(t.TempDir(), store.WithStoreKey(identityTestStoreKey))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	srv, err := New(st, Options{Issuer: "base-node-1", SignKeyHex: testSeed, Version: "test"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/identity/register", srv.handleIdentityRegister)
	mux.Handle("GET /v1/me", srv.requireAuth(srv.handleMe))
	mux.Handle("PUT /v1/identity/escrow/{username}", srv.requireAuth(srv.handleEscrowPut))
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)

	id, pub := identityFromSeed(t, testSeed)
	if status, body := doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/identity/register", "", registerBody(id, pub)); status != http.StatusOK {
		t.Fatalf("预登记 status=%d body=%v", status, body)
	}
	return st, srv, ts
}

func signedRequestAt(t *testing.T, seed, method, rawURL, body string, tsMillis int64) *http.Request {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, rawURL, rdr)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rawNonce := make([]byte, 16)
	if _, err := rand.Read(rawNonce); err != nil {
		t.Fatal(err)
	}
	nonce := hex.EncodeToString(rawNonce)

	signBytes, err := protocol.RequestSignBytes(protocol.RequestMeta{
		Method: method, Path: req.URL.Path, Query: req.URL.RawQuery,
		BodySHA256: protocol.SHA256Hex([]byte(body)), TS: tsMillis, Nonce: nonce,
	})
	if err != nil {
		t.Fatalf("RequestSignBytes: %v", err)
	}
	sig, err := protocol.Sign(seed, signBytes)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	kp, err := protocol.KeyPairFromSeed(seed)
	if err != nil {
		t.Fatalf("KeyPairFromSeed: %v", err)
	}
	id, err := protocol.IdentityID(kp.PubHex)
	if err != nil {
		t.Fatalf("IdentityID: %v", err)
	}
	req.Header.Set("X-Base-Id", id)
	req.Header.Set("X-Base-Alg", "ed25519")
	req.Header.Set("X-Base-Ts", strconv.FormatInt(tsMillis, 10))
	req.Header.Set("X-Base-Nonce", nonce)
	req.Header.Set("X-Base-Sig", sig)
	return req
}

func signedRequest(t *testing.T, seed, method, rawURL, body string) *http.Request {
	t.Helper()
	return signedRequestAt(t, seed, method, rawURL, body, time.Now().UnixMilli())
}

func copyAuthHeaders(from, to *http.Request) {
	for _, k := range []string{"X-Base-Id", "X-Base-Alg", "X-Base-Ts", "X-Base-Nonce", "X-Base-Sig"} {
		to.Header.Set(k, from.Header.Get(k))
	}
}

func sendAuth(t *testing.T, req *http.Request) (int, map[string]any) {
	t.Helper()
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	out := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("响应不是 JSON: %s", raw)
		}
	}
	return res.StatusCode, out
}

// 步骤 1：缺任一头 → 400 auth_missing_header
func TestAuthMissingHeader(t *testing.T) {
	_, _, ts := newAuthServer(t)
	for _, h := range []string{"X-Base-Id", "X-Base-Alg", "X-Base-Ts", "X-Base-Nonce", "X-Base-Sig"} {
		req := signedRequest(t, testSeed, http.MethodGet, ts.URL+"/v1/me", "")
		req.Header.Del(h)
		status, body := sendAuth(t, req)
		if status != http.StatusBadRequest || body["code"] != "auth_missing_header" {
			t.Fatalf("缺 %s status=%d body=%v, want 400/auth_missing_header", h, status, body)
		}
	}
}

// 步骤 2：alg != ed25519 → 400 identity_alg_unsupported
func TestAuthAlgUnsupported(t *testing.T) {
	_, _, ts := newAuthServer(t)
	req := signedRequest(t, testSeed, http.MethodGet, ts.URL+"/v1/me", "")
	req.Header.Set("X-Base-Alg", "rsa")
	status, body := sendAuth(t, req)
	if status != http.StatusBadRequest || body["code"] != "identity_alg_unsupported" {
		t.Fatalf("status=%d body=%v, want 400/identity_alg_unsupported", status, body)
	}
}

// 步骤 3：未登记身份 → 403 identity_unregistered
func TestAuthUnregisteredIdentity(t *testing.T) {
	_, _, ts := newAuthServer(t)
	req := signedRequest(t, strings.Repeat("ab", 32), http.MethodGet, ts.URL+"/v1/me", "")
	status, body := sendAuth(t, req)
	if status != http.StatusForbidden || body["code"] != "identity_unregistered" {
		t.Fatalf("status=%d body=%v, want 403/identity_unregistered", status, body)
	}
}

// 步骤 4：|now-ts| > 300s → 401 auth_ts_out_of_window
func TestAuthTsOutOfWindow(t *testing.T) {
	_, _, ts := newAuthServer(t)
	for _, delta := range []time.Duration{-10 * time.Minute, 10 * time.Minute} {
		req := signedRequestAt(t, testSeed, http.MethodGet, ts.URL+"/v1/me", "", time.Now().Add(delta).UnixMilli())
		status, body := sendAuth(t, req)
		if status != http.StatusUnauthorized || body["code"] != "auth_ts_out_of_window" {
			t.Fatalf("ts 偏移 %v status=%d body=%v, want 401/auth_ts_out_of_window", delta, status, body)
		}
	}
}

// 步骤 5：(id, nonce) 重放 → 401 auth_nonce_replay
func TestAuthNonceReplay(t *testing.T) {
	_, _, ts := newAuthServer(t)
	first := signedRequest(t, testSeed, http.MethodGet, ts.URL+"/v1/me", "")
	if status, body := sendAuth(t, first); status != http.StatusOK {
		t.Fatalf("首次请求 status=%d body=%v", status, body)
	}
	replay, err := http.NewRequest(http.MethodGet, ts.URL+"/v1/me", nil)
	if err != nil {
		t.Fatal(err)
	}
	copyAuthHeaders(first, replay)
	status, body := sendAuth(t, replay)
	if status != http.StatusUnauthorized || body["code"] != "auth_nonce_replay" {
		t.Fatalf("重放 status=%d body=%v, want 401/auth_nonce_replay", status, body)
	}
}

// 步骤 6：签名不覆盖真实请求 → 401 auth_bad_signature
func TestAuthBadSignature(t *testing.T) {
	_, _, ts := newAuthServer(t)

	// 6a. 签名后追加 query
	req := signedRequest(t, testSeed, http.MethodGet, ts.URL+"/v1/me", "")
	req.URL.RawQuery = "a=1"
	status, body := sendAuth(t, req)
	if status != http.StatusUnauthorized || body["code"] != "auth_bad_signature" {
		t.Fatalf("签名后追加 query status=%d body=%v, want 401/auth_bad_signature", status, body)
	}

	// 6b. 签名后换请求体
	id, _ := identityFromSeed(t, testSeed)
	req = signedRequest(t, testSeed, http.MethodPut, ts.URL+"/v1/identity/escrow/eve", escrowBody(id))
	tampered, err := http.NewRequest(http.MethodPut, ts.URL+"/v1/identity/escrow/eve",
		strings.NewReader(escrowBody(strings.Repeat("00", 32))))
	if err != nil {
		t.Fatal(err)
	}
	copyAuthHeaders(req, tampered)
	status, body = sendAuth(t, tampered)
	if status != http.StatusUnauthorized || body["code"] != "auth_bad_signature" {
		t.Fatalf("签名后换体 status=%d body=%v, want 401/auth_bad_signature", status, body)
	}

	// 6c. 直接用全 0 签名
	req = signedRequest(t, testSeed, http.MethodGet, ts.URL+"/v1/me", "")
	req.Header.Set("X-Base-Sig", strings.Repeat("00", 64))
	status, body = sendAuth(t, req)
	if status != http.StatusUnauthorized || body["code"] != "auth_bad_signature" {
		t.Fatalf("伪签名 status=%d body=%v, want 401/auth_bad_signature", status, body)
	}
}

// 步骤 7：全通过 → 业务处理，且请求体已被还原给 handler
func TestAuthHappyPathAndBodyRestored(t *testing.T) {
	_, _, ts := newAuthServer(t)
	id, _ := identityFromSeed(t, testSeed)

	status, body := sendAuth(t, signedRequest(t, testSeed, http.MethodGet, ts.URL+"/v1/me", ""))
	if status != http.StatusOK || body["id"] != id {
		t.Fatalf("GET /v1/me status=%d body=%v", status, body)
	}

	status, body = sendAuth(t, signedRequest(t, testSeed, http.MethodGet, ts.URL+"/v1/me?x=1&y=2", ""))
	if status != http.StatusOK {
		t.Fatalf("带 query 的 GET status=%d body=%v（query 必须进待签字节）", status, body)
	}

	status, body = sendAuth(t, signedRequest(t, testSeed, http.MethodPut, ts.URL+"/v1/identity/escrow/frank", escrowBody(id)))
	if status != http.StatusOK || body["username"] != "frank" {
		t.Fatalf("中间件读完体后未还原，handler 拿不到 body: status=%d body=%v", status, body)
	}
}

func TestServerPruneNonces(t *testing.T) {
	st, srv, _ := newAuthServer(t)
	id, _ := identityFromSeed(t, testSeed)
	if _, err := st.UseNonce(id, strings.Repeat("11", 16), time.Now().UnixMilli()-20*60*1000); err != nil {
		t.Fatal(err)
	}
	if _, err := st.UseNonce(id, strings.Repeat("22", 16), time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	n, err := srv.PruneNonces()
	if err != nil || n != 1 {
		t.Fatalf("PruneNonces = %d err=%v, want 1（只清 10 分钟前的行）", n, err)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
Set-Location e:\code\base
go test ./internal/httpapi/ -run 'TestAuth|TestServerPrune' -v
```

Expected: 编译失败，报 `srv.requireAuth undefined` / `srv.PruneNonces undefined`。

- [ ] **Step 3: 写最小实现**

创建 `e:\code\base\internal\httpapi\authmw.go`：

```go
package httpapi

import (
	"bytes"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/johocn/base/internal/protocol"
)

// 契约 3.2：时间窗 300 秒；nonce 去重窗口 10 分钟（时间窗的两倍）。
const (
	authTsWindowMs = 300_000
	nonceWindowMs  = 600_000
)

// authErrText 只给人读；客户端必须只依赖 code（契约 3.3）。
var authErrText = map[string]string{
	"auth_missing_header":      "缺少签名头",
	"auth_ts_invalid":          "X-Base-Ts 不是十进制毫秒时间戳",
	"auth_nonce_invalid":       "X-Base-Nonce 必须是 16 字节 hex",
	"auth_sig_invalid":         "X-Base-Sig 必须是 hex",
	"auth_ts_out_of_window":    "时间戳超出 ±300 秒窗口",
	"auth_nonce_replay":        "nonce 在 10 分钟内已使用过",
	"auth_bad_signature":       "签名验证失败",
	"auth_body_read_failed":    "请求体读取失败",
	"auth_body_too_large":      "请求体超过 64 KiB",
	"auth_sign_meta_invalid":   "待签字节构造失败",
	"identity_id_invalid":      "身份 id 必须是 32 位 hex",
	"identity_alg_unsupported": "算法不受支持",
	"identity_unregistered":    "身份未登记",
}

// writeAuthErr 按契约 3.3 输出 {"error": "<人读消息>", "code": "<机器码>"}。
// 既有 writeError 的 {"error": "..."} 形状保持不变，不破坏 P0 验收。
func (s *Server) writeAuthErr(w http.ResponseWriter, status int, code string) {
	text := authErrText[code]
	if text == "" {
		text = code
	}
	s.writeJSON(w, status, map[string]any{"error": text, "code": code})
}

// PruneNonces 清理过期 nonce 行；serve 启动时与定时任务调用（契约 3.2 第 5 步）。
func (s *Server) PruneNonces() (int64, error) {
	return s.st.PruneNonces(time.Now().UnixMilli() - nonceWindowMs)
}

// requireAuth 包装需要签名头的处理器：严格按契约 3.2 的 1→7 顺序，先验后读体。
func (s *Server) requireAuth(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 1. 缺任一头
		id := r.Header.Get("X-Base-Id")
		alg := r.Header.Get("X-Base-Alg")
		tsRaw := r.Header.Get("X-Base-Ts")
		nonce := r.Header.Get("X-Base-Nonce")
		sig := r.Header.Get("X-Base-Sig")
		if id == "" || alg == "" || tsRaw == "" || nonce == "" || sig == "" {
			s.writeAuthErr(w, http.StatusBadRequest, "auth_missing_header")
			return
		}
		// 2. 算法与格式（全部在查库之前，避免用坏输入打库）
		if alg != protocol.AlgEd25519 {
			s.writeAuthErr(w, http.StatusBadRequest, "identity_alg_unsupported")
			return
		}
		if !protocol.IsIdentityID(id) {
			s.writeAuthErr(w, http.StatusBadRequest, "identity_id_invalid")
			return
		}
		ts, err := strconv.ParseInt(tsRaw, 10, 64)
		if err != nil {
			s.writeAuthErr(w, http.StatusBadRequest, "auth_ts_invalid")
			return
		}
		if !isHexN(nonce, 16) {
			s.writeAuthErr(w, http.StatusBadRequest, "auth_nonce_invalid")
			return
		}
		if !isHexNonEmptyEven(sig) {
			s.writeAuthErr(w, http.StatusBadRequest, "auth_sig_invalid")
			return
		}
		// 3. 取公钥
		it, ok, err := s.st.LookupIdentity(id)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !ok {
			s.writeAuthErr(w, http.StatusForbidden, "identity_unregistered")
			return
		}
		// 4. 时间窗
		now := time.Now().UnixMilli()
		if delta := now - ts; delta > authTsWindowMs || delta < -authTsWindowMs {
			s.writeAuthErr(w, http.StatusUnauthorized, "auth_ts_out_of_window")
			return
		}
		// 5. nonce 去重（键含 id，否则可被抢注导致合法请求被误判重放）
		fresh, err := s.st.UseNonce(id, nonce, now)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !fresh {
			s.writeAuthErr(w, http.StatusUnauthorized, "auth_nonce_replay")
			return
		}
		// 6. 读体 → 算 body_sha256 → 组待签字节 → 验签
		body, err := io.ReadAll(io.LimitReader(r.Body, maxJSONBody+1))
		if err != nil {
			s.writeAuthErr(w, http.StatusBadRequest, "auth_body_read_failed")
			return
		}
		_ = r.Body.Close()
		if int64(len(body)) > maxJSONBody {
			s.writeAuthErr(w, http.StatusRequestEntityTooLarge, "auth_body_too_large")
			return
		}
		signBytes, err := protocol.RequestSignBytes(protocol.RequestMeta{
			Method:     r.Method,
			Path:       r.URL.Path,
			Query:      r.URL.RawQuery,
			BodySHA256: protocol.SHA256Hex(body),
			TS:         ts,
			Nonce:      nonce,
		})
		if err != nil {
			s.writeAuthErr(w, http.StatusBadRequest, "auth_sign_meta_invalid")
			return
		}
		valid, err := protocol.Verify(it.PubKey, signBytes, sig)
		if err != nil || !valid {
			s.writeAuthErr(w, http.StatusUnauthorized, "auth_bad_signature")
			return
		}
		// 7. 通过：把体还给 handler，写入已验签身份
		r.Body = io.NopCloser(bytes.NewReader(body))
		_ = s.st.TouchIdentity(id, now)
		next(w, withIdentity(r, id))
	})
}
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
Set-Location e:\code\base
go test ./internal/httpapi/ -run 'TestAuth|TestServerPrune' -v
```

Expected: 8 个测试全部 PASS。

- [ ] **Step 5: 回归**

```powershell
Set-Location e:\code\base
go test ./internal/httpapi/ ./internal/store/
```

Expected: 全部 `ok`。

- [ ] **Step 6: 提交**

```bash
git -C e:/code/base add internal/httpapi/authmw.go internal/httpapi/authmw_test.go
git -C e:/code/base commit -m "feat(httpapi): 5 头 Ed25519 验签中间件与 auth 错误体"
```

---

### Task 11: 事件落库骨架 + 路由总装

**Files:**
- Create: `e:\code\base\internal\store\event.go`
- Create: `e:\code\base\internal\store\event_test.go`
- Create: `e:\code\base\internal\httpapi\event.go`
- Create: `e:\code\base\internal\httpapi\event_test.go`
- Modify: `e:\code\base\internal\store\schema.go`（追加 `events` 表）
- Modify: `e:\code\base\internal\httpapi\server.go`（`Server` 再加 `knownEventTypes`；`Handler()` 挂 6 条新路由；`withCommon` 放开方法与头）

**修正 6（册子 §5.6 未定）**：契约只规定了「未登记 type → 400 `event_type_unknown`」，没规定事件信封字段。本计划自定最小信封 `{event_id, type, created_at, body}`，并把 `event_id` 定为 16 字节 hex（与 nonce 同宽）。B 阶段定义事件语义时若需改信封，改这里即可——管线与验签不受影响。

**为什么用 `s.knownEventTypes` 而不是包级变量**：包级空 map 会让写入路径成为永不执行的死代码；作为 `Server` 字段后测试可以登记一项，从而真正覆盖落库路径，B 阶段也只需填表。

- [ ] **Step 1: 写失败测试**

创建 `e:\code\base\internal\store\event_test.go`：

```go
package store

import "testing"

func TestEventPutIsIdempotentAndListed(t *testing.T) {
	st := openTemp(t)
	e := Event{EventID: "e1", ID: "id-1", Type: "progress.v1", BodyJSON: `{"a":1}`, CreatedAt: 100, ReceivedAt: 200}
	if err := st.PutEvent(e); err != nil {
		t.Fatalf("PutEvent: %v", err)
	}
	e.BodyJSON = `{"a":2}`
	e.CreatedAt = 300
	if err := st.PutEvent(e); err != nil {
		t.Fatalf("PutEvent(覆盖): %v", err)
	}
	if err := st.PutEvent(Event{EventID: "e2", ID: "id-1", Type: "progress.v1", BodyJSON: `{}`, CreatedAt: 400}); err != nil {
		t.Fatalf("PutEvent(e2): %v", err)
	}

	evs, err := st.ListEvents("id-1", 10)
	if err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	if len(evs) != 2 {
		t.Fatalf("事件数 = %d, want 2（同 event_id 幂等）", len(evs))
	}
	if evs[0].EventID != "e2" || evs[1].EventID != "e1" {
		t.Fatalf("排序应为 created_at 倒序: %+v", evs)
	}
	if evs[1].BodyJSON != `{"a":2}` || evs[1].CreatedAt != 300 {
		t.Fatalf("覆盖未生效: %+v", evs[1])
	}
	if evs[1].ReceivedAt != 200 {
		t.Fatalf("ReceivedAt 不应被覆盖: %+v", evs[1])
	}

	empty, err := st.ListEvents("nobody", 10)
	if err != nil || len(empty) != 0 {
		t.Fatalf("无事件应返回空切片 err=%v evs=%+v", err, empty)
	}
}
```

创建 `e:\code\base\internal\httpapi\event_test.go`：

```go
package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/johocn/base/internal/store"
)

// newFullServer 用真实 srv.Handler()，因此同时覆盖「路由是否挂上」。
func newFullServer(t *testing.T) (*store.Store, *Server, *httptest.Server) {
	t.Helper()
	st, err := store.Open(t.TempDir(), store.WithStoreKey(identityTestStoreKey))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	srv, err := New(st, Options{Issuer: "base-node-1", SignKeyHex: testSeed, Version: "test"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	id, pub := identityFromSeed(t, testSeed)
	if status, body := doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/identity/register", "", registerBody(id, pub)); status != http.StatusOK {
		t.Fatalf("预登记 status=%d body=%v", status, body)
	}
	return st, srv, ts
}

func TestRoutesAreWiredOnRealHandler(t *testing.T) {
	_, _, ts := newFullServer(t)
	id, _ := identityFromSeed(t, testSeed)

	status, body := sendAuth(t, signedRequest(t, testSeed, http.MethodGet, ts.URL+"/v1/me", ""))
	if status != http.StatusOK || body["id"] != id {
		t.Fatalf("GET /v1/me 未挂上真实路由: status=%d body=%v", status, body)
	}

	status, _ = doIdentityJSON(t, http.MethodGet, ts.URL+"/v1/catalog", "", "")
	if status != http.StatusOK {
		t.Fatalf("GET /v1/catalog status=%d，公开读被鉴权误伤", status)
	}
}

func TestEventUnknownTypeRejectedKnownTypePersisted(t *testing.T) {
	_, srv, ts := newFullServer(t)
	id, _ := identityFromSeed(t, testSeed)
	body := `{"event_id":"` + strings.Repeat("7", 32) + `","type":"progress.v1","created_at":1,"body":{"n":1}}`

	status, out := doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/event", "", body)
	if status != http.StatusBadRequest || out["code"] != "auth_missing_header" {
		t.Fatalf("未签名 status=%d out=%v, want 400/auth_missing_header", status, out)
	}

	status, out = sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", body))
	if status != http.StatusBadRequest || out["error"] != "event_type_unknown" {
		t.Fatalf("未登记类型 status=%d out=%v, want 400/event_type_unknown", status, out)
	}

	srv.knownEventTypes["progress.v1"] = struct{}{}
	status, out = sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event", body))
	if status != http.StatusOK {
		t.Fatalf("登记类型后 status=%d out=%v", status, out)
	}
	evs, err := srv.st.ListEvents(id, 10)
	if err != nil || len(evs) != 1 || evs[0].Type != "progress.v1" || evs[0].BodyJSON != `{"n":1}` {
		t.Fatalf("落库结果 err=%v evs=%+v", err, evs)
	}

	status, out = sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/event",
		`{"event_id":"zz","type":"progress.v1","created_at":1}`))
	if status != http.StatusBadRequest || out["error"] != "event_param_invalid" {
		t.Fatalf("event_id 非法 status=%d out=%v, want 400/event_param_invalid", status, out)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
Set-Location e:\code\base
go test ./internal/store/ ./internal/httpapi/ -run 'TestEvent|TestRoutes' -v
```

Expected: 编译失败，报 `undefined: Event` / `s.st.PutEvent undefined` / `srv.knownEventTypes undefined`。

- [ ] **Step 3: 写最小实现**

在 `e:\code\base\internal\store\schema.go` 的 `schemaStatements` 末尾（`tombstones` 之后）追加一条：

```go
	`CREATE TABLE IF NOT EXISTS events(
		event_id    TEXT PRIMARY KEY,
		id          TEXT NOT NULL,
		type        TEXT NOT NULL,
		body_json   TEXT NOT NULL,
		created_at  INTEGER NOT NULL,
		received_at INTEGER NOT NULL
	)`,
```

创建 `e:\code\base\internal\store\event.go`：

```go
package store

import "time"

// Event 是一条已验签的客户端事件（落库骨架）。
// S1 阶段 type 取值表为空，故没有写入路径；B 阶段只需填 httpapi 的类型表，
// 本文件与验签管线都不用改。
type Event struct {
	EventID    string
	ID         string
	Type       string
	BodyJSON   string
	CreatedAt  int64
	ReceivedAt int64
}

// PutEvent 幂等写入事件：同 event_id 覆盖（客户端可安全重试），received_at 保留首次值。
func (s *Store) PutEvent(e Event) error {
	if e.ReceivedAt == 0 {
		e.ReceivedAt = time.Now().UnixMilli()
	}
	_, err := s.db.Exec(`INSERT INTO events(event_id,id,type,body_json,created_at,received_at)
		VALUES(?,?,?,?,?,?)
		ON CONFLICT(event_id) DO UPDATE SET
			id=excluded.id, type=excluded.type, body_json=excluded.body_json, created_at=excluded.created_at`,
		e.EventID, e.ID, e.Type, e.BodyJSON, e.CreatedAt, e.ReceivedAt)
	return err
}

// ListEvents 返回某身份的事件，按 created_at 倒序；limit<=0 取 100。
func (s *Store) ListEvents(id string, limit int) ([]Event, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.Query(`SELECT event_id,id,type,body_json,created_at,received_at
		FROM events WHERE id=? ORDER BY created_at DESC, event_id ASC LIMIT ?`, id, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.EventID, &e.ID, &e.Type, &e.BodyJSON, &e.CreatedAt, &e.ReceivedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
```

创建 `e:\code\base\internal\httpapi\event.go`：

```go
package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/johocn/base/internal/store"
)

type eventReq struct {
	EventID   string          `json:"event_id"`
	Type      string          `json:"type"`
	CreatedAt int64           `json:"created_at"`
	Body      json.RawMessage `json:"body"`
}

// handleEventPost 落地验签管线与落库骨架（契约 5.6）。
// S1 阶段 s.knownEventTypes 为空，故一律 400 event_type_unknown；
// B 阶段只需往该表登记类型，管线与本处理器都不用改。
func (s *Server) handleEventPost(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r)
	var req eventReq
	if !s.decodeJSON(w, r, &req) {
		return
	}
	if _, ok := s.knownEventTypes[req.Type]; !ok {
		s.writeError(w, http.StatusBadRequest, "event_type_unknown")
		return
	}
	if !isHexN(req.EventID, 16) || req.CreatedAt <= 0 {
		s.writeError(w, http.StatusBadRequest, "event_param_invalid")
		return
	}
	body := req.Body
	if len(body) == 0 {
		body = json.RawMessage(`{}`)
	}
	now := time.Now().UnixMilli()
	if err := s.st.PutEvent(store.Event{
		EventID: req.EventID, ID: id, Type: req.Type,
		BodyJSON: string(body), CreatedAt: req.CreatedAt, ReceivedAt: now,
	}); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"event_id": req.EventID, "received_at": now})
}
```

修改 `e:\code\base\internal\httpapi\server.go`。

改动 A —— `Server` 结构体（在 Task 9 新增的 `escrowLimiter` 旁再加一个字段）：

```go
// Server 是节点 HTTP 服务。
type Server struct {
	st              *store.Store
	opt             Options
	pub             string
	escrowLimiter   *ipLimiter
	knownEventTypes map[string]struct{}
}
```

改动 B —— `New` 里初始化（空表：S1 不认任何事件类型）：

```go
func New(st *store.Store, opt Options) (*Server, error) {
	s := &Server{
		st: st, opt: opt,
		escrowLimiter:   newIPLimiter(10, 10),
		knownEventTypes: map[string]struct{}{},
	}
	if opt.SignKeyHex != "" {
		kp, err := protocol.KeyPairFromSeed(opt.SignKeyHex)
		if err != nil {
			return nil, err
		}
		s.pub = kp.PubHex
	}
	return s, nil
}
```

改动 C —— `Handler()` 挂新路由：

```go
// Handler 返回路由。公开读路由不挂鉴权中间件（契约：匿名可读）。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /v1/pubkey", s.handlePubkey)
	mux.HandleFunc("GET /v1/catalog", s.handleCatalog)
	mux.HandleFunc("GET /v1/manifest/{pack_id}", s.handleManifest)
	mux.HandleFunc("GET /v1/pack/{pack_id}", s.handlePack)
	mux.HandleFunc("GET /v1/blob/{blob_id}", s.handleBlob)
	mux.HandleFunc("HEAD /v1/blob/{blob_id}", s.handleBlobHead)

	// 身份（契约 5.1-5.5）：登记与公钥/托管读取匿名；托管写入与 /v1/me 需签名头。
	mux.HandleFunc("POST /v1/identity/register", s.handleIdentityRegister)
	mux.HandleFunc("GET /v1/identity/{id}", s.handleIdentityGet)
	mux.HandleFunc("GET /v1/identity/escrow/{username}", s.handleEscrowGet)
	mux.Handle("PUT /v1/identity/escrow/{username}", s.requireAuth(s.handleEscrowPut))
	mux.Handle("GET /v1/me", s.requireAuth(s.handleMe))
	mux.Handle("POST /v1/event", s.requireAuth(s.handleEventPost))

	mux.HandleFunc("GET /{$}", s.handleIndex)
	mux.HandleFunc("GET /a/{item_id}", s.handleArticlePage)
	return withCommon(mux)
}
```

改动 D —— `withCommon` 放开新方法与 5 个签名头（否则浏览器/H5 预检会拦掉写接口）：

```go
		h.Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Base-Id, X-Base-Alg, X-Base-Ts, X-Base-Nonce, X-Base-Sig")
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
Set-Location e:\code\base
go test ./internal/store/ ./internal/httpapi/ -run 'TestEvent|TestRoutes' -v
```

Expected: 3 个测试全部 PASS。

- [ ] **Step 5: 回归全仓（P0 验收不能被破坏）**

```powershell
Set-Location e:\code\base
go build ./...
go test ./...
```

Expected: 编译通过，所有包 `ok`。

- [ ] **Step 6: 提交**

```bash
git -C e:/code/base add internal/store/event.go internal/store/event_test.go internal/store/schema.go internal/httpapi/event.go internal/httpapi/event_test.go internal/httpapi/server.go
git -C e:/code/base commit -m "feat: 事件落库骨架与身份/事件路由总装"
```
---

### Task 12: TLS 证书、指纹固定与配对码

**Files:**
- Create: `internal/httpapi/tlscfg.go`
- Create: `internal/httpapi/tlscfg_test.go`
- Modify: `internal/httpapi/server.go:8-12`（`Options` 增加 `FingerprintHex` / `PairingCode`）
- Modify: `internal/httpapi/authmw.go:3435-3449`（`authErrText` 增加 `node_key_mismatch`）

**职责边界**：本文件只做「证书 → 指纹 → 配对码」与「指纹固定校验」，不碰 `store`、不碰路由表。双监听拓扑在 Task 13 的 `serve.go` 组装。

**契约依据**：册子 §6.1（自签 + 指纹固定 + 配对码，无「忽略」开关）、§6.2（换证书需重新配对）、§6.3（节点间预共享密钥与指纹是两层）。

- [ ] **Step 1: 写失败测试**

创建 `e:\code\base\internal\httpapi\tlscfg_test.go`：

```go
package httpapi

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestPairingCode(t *testing.T) {
	// 指纹前 10 字节全 0 → Base32 无填充 16 个 'A'
	code, err := PairingCode(strings.Repeat("00", 32))
	if err != nil {
		t.Fatalf("PairingCode: %v", err)
	}
	if code != "AAAA-AAAA-AAAA-AAAA" {
		t.Fatalf("PairingCode = %s, want AAAA-AAAA-AAAA-AAAA", code)
	}
	if len(code) != 19 {
		t.Fatalf("配对码长度 = %d, want 19（4-4-4-4）", len(code))
	}
	if _, err := PairingCode("not-hex"); err == nil {
		t.Fatal("非 hex 指纹应报错")
	}
	if _, err := PairingCode("0011"); err == nil {
		t.Fatal("不足 10 字节的指纹应报错")
	}
}

func TestLoadOrCreateTLSCertIdempotent(t *testing.T) {
	dir := t.TempDir()
	certFile := filepath.Join(dir, "tls", "node.crt")
	keyFile := filepath.Join(dir, "tls", "node.key")

	first, err := LoadOrCreateTLSCert(certFile, keyFile)
	if err != nil {
		t.Fatalf("首次生成: %v", err)
	}
	if len(first.FingerprintHex) != 64 {
		t.Fatalf("指纹长度 = %d, want 64", len(first.FingerprintHex))
	}
	if first.PairingCode == "" {
		t.Fatal("配对码不应为空")
	}
	if _, err := os.Stat(filepath.Join(dir, "tls")); err != nil {
		t.Fatalf("证书目录未创建: %v", err)
	}
	// Windows 不支持 POSIX 权限位，os.WriteFile 的 0600 在 Windows 上只映射只读位，
	// 断言权限只对非 Windows 有意义。
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(keyFile)
		if err != nil {
			t.Fatalf("stat key: %v", err)
		}
		if perm := fi.Mode().Perm(); perm != 0o600 {
			t.Fatalf("私钥权限 = %o, want 600", perm)
		}
	}

	second, err := LoadOrCreateTLSCert(certFile, keyFile)
	if err != nil {
		t.Fatalf("二次加载: %v", err)
	}
	if second.FingerprintHex != first.FingerprintHex {
		t.Fatalf("二次加载指纹漂移: %s != %s", second.FingerprintHex, first.FingerprintHex)
	}
	if second.PairingCode != first.PairingCode {
		t.Fatalf("二次加载配对码漂移: %s != %s", second.PairingCode, first.PairingCode)
	}
}

func TestLoadOrCreateTLSCertRejectsEmptyPath(t *testing.T) {
	if _, err := LoadOrCreateTLSCert("", ""); err == nil {
		t.Fatal("空路径应报错")
	}
}

func TestPeerVerifierRejectsUnknown(t *testing.T) {
	if err := PeerVerifier([]string{"aa"})(nil, nil); !errors.Is(err, ErrFingerprintMismatch) {
		t.Fatalf("对端未提供证书应报指纹不匹配，got %v", err)
	}
	if err := PeerVerifier([]string{"aa"})([][]byte{{0x01}}, nil); !errors.Is(err, ErrFingerprintMismatch) {
		t.Fatalf("未知指纹应报指纹不匹配，got %v", err)
	}
	// fail-closed：空白名单必须拒绝一切，不能退化成「不校验」。
	if err := PeerVerifier(nil)([][]byte{{0x01}}, nil); !errors.Is(err, ErrFingerprintMismatch) {
		t.Fatalf("空白名单必须拒绝，got %v", err)
	}
	sum := sha256.Sum256([]byte{0x01})
	if err := PeerVerifier([]string{hex.EncodeToString(sum[:])})([][]byte{{0x01}}, nil); err != nil {
		t.Fatalf("命中白名单应通过，got %v", err)
	}
}

// TestPeerVerifierHandshake 用 net.Pipe 跑真实 TLS 握手，覆盖「指纹命中才连得上」。
func TestPeerVerifierHandshake(t *testing.T) {
	dirA, dirB := t.TempDir(), t.TempDir()
	a, err := LoadOrCreateTLSCert(filepath.Join(dirA, "a.crt"), filepath.Join(dirA, "a.key"))
	if err != nil {
		t.Fatalf("A 证书: %v", err)
	}
	b, err := LoadOrCreateTLSCert(filepath.Join(dirB, "b.crt"), filepath.Join(dirB, "b.key"))
	if err != nil {
		t.Fatalf("B 证书: %v", err)
	}

	cases := []struct {
		name        string
		serverTrust []string // 服务端接受的对端（客户端）指纹
		clientWants string   // 客户端固定期望的服务端指纹
		wantErr     bool
	}{
		{"指纹互相命中", []string{b.FingerprintHex}, a.FingerprintHex, false},
		{"客户端指纹不在白名单", []string{strings.Repeat("ab", 32)}, a.FingerprintHex, true},
		{"服务端指纹不匹配", []string{b.FingerprintHex}, strings.Repeat("cd", 32), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srvCfg, err := ServerTLSConfig(a, tc.serverTrust)
			if err != nil {
				t.Fatalf("ServerTLSConfig: %v", err)
			}
			cliCfg := ClientTLSConfig(tc.clientWants)

			c1, c2 := net.Pipe()
			defer c1.Close()
			defer c2.Close()
			_ = c1.SetDeadline(time.Now().Add(5 * time.Second))
			_ = c2.SetDeadline(time.Now().Add(5 * time.Second))

			errCh := make(chan error, 1)
			go func() { errCh <- tls.Client(c1, cliCfg).Handshake() }()
			_ = tls.Server(c2, srvCfg).Handshake()

			select {
			case err := <-errCh:
				if tc.wantErr && err == nil {
					t.Fatal("期望握手失败，实际成功")
				}
				if !tc.wantErr && err != nil {
					t.Fatalf("期望握手成功，实际失败: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("握手超时")
			}
		})
	}
}

func TestClientTLSConfigPinsFingerprint(t *testing.T) {
	dir := t.TempDir()
	info, err := LoadOrCreateTLSCert(filepath.Join(dir, "n.crt"), filepath.Join(dir, "n.key"))
	if err != nil {
		t.Fatalf("证书: %v", err)
	}
	cfg := ClientTLSConfig(info.FingerprintHex)
	if !cfg.InsecureSkipVerify {
		t.Fatal("自签证书必须跳过系统 CA 校验，改由指纹固定承担信任")
	}
	if cfg.VerifyPeerCertificate == nil {
		t.Fatal("必须设置 VerifyPeerCertificate，否则指纹固定形同虚设")
	}
	if err := cfg.VerifyPeerCertificate([][]byte{[]byte("other")}, nil); !errors.Is(err, ErrFingerprintMismatch) {
		t.Fatalf("错误证书应被拒，got %v", err)
	}
}

func TestRequireNodeKey(t *testing.T) {
	s := &Server{}
	h := s.RequireNodeKey("s3cret", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	cases := []struct {
		name string
		key  string
		want int
	}{
		{"密钥匹配", "s3cret", http.StatusOK},
		{"密钥不匹配", "wrong", http.StatusUnauthorized},
		{"密钥缺失", "", http.StatusUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/v1/healthz", nil)
			if tc.key != "" {
				req.Header.Set("X-Base-Node-Key", tc.key)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("状态码 = %d, want %d", rec.Code, tc.want)
			}
			if tc.want == http.StatusUnauthorized && !strings.Contains(rec.Body.String(), "node_key_mismatch") {
				t.Fatalf("错误体应含机器码 node_key_mismatch，got %s", rec.Body.String())
			}
		})
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
Set-Location e:\code\base
go test ./internal/httpapi/ -run 'TestPairingCode|TestLoadOrCreateTLSCert|TestPeerVerifier|TestClientTLSConfigPinsFingerprint|TestRequireNodeKey' -v
```

Expected: 编译失败，报 `undefined: PairingCode` / `undefined: LoadOrCreateTLSCert` / `undefined: ErrFingerprintMismatch` / `undefined: ServerTLSConfig` / `undefined: ClientTLSConfig`。

- [ ] **Step 3: 写最小实现**

创建 `e:\code\base\internal\httpapi\tlscfg.go`：

```go
package httpapi

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base32"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrFingerprintMismatch 是指纹固定失败的哨兵错误（契约 6.1 的 tls_fingerprint_mismatch）。
// 调用方用 errors.Is 判定；**没有忽略路径**——不匹配即断。
var ErrFingerprintMismatch = errors.New("tls_fingerprint_mismatch")

const (
	// 指纹前 10 字节 → Base32 无填充恰好 16 字符（80 bit / 5 bit = 16）。
	pairingBytes = 10
	certValidity = 10 * 365 * 24 * time.Hour
)

// TLSInfo 描述节点自身的 TLS 身份。证书一旦生成，四个字段同时固定；
// 轮换会换掉全部值，所有客户端需重新配对（契约 6.2）。
type TLSInfo struct {
	CertFile       string
	KeyFile        string
	FingerprintHex string // 证书 DER 的 sha256 hex（小写 64 字符）
	PairingCode    string // 指纹前 10 字节 → Base32 → 4-4-4-4
}

// LoadOrCreateTLSCert 加载自签证书；证书文件不存在则生成（ECDSA P-256）。
// 生成写两个文件：证书 0644、私钥 0600。
func LoadOrCreateTLSCert(certFile, keyFile string) (TLSInfo, error) {
	if strings.TrimSpace(certFile) == "" || strings.TrimSpace(keyFile) == "" {
		return TLSInfo{}, errors.New("tls: 证书与私钥路径都不能为空")
	}
	switch _, err := os.Stat(certFile); {
	case errors.Is(err, os.ErrNotExist):
		if err := generateSelfSigned(certFile, keyFile); err != nil {
			return TLSInfo{}, err
		}
	case err != nil:
		return TLSInfo{}, fmt.Errorf("tls: stat %s: %w", certFile, err)
	}

	pemBytes, err := os.ReadFile(certFile)
	if err != nil {
		return TLSInfo{}, fmt.Errorf("tls: read %s: %w", certFile, err)
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return TLSInfo{}, fmt.Errorf("tls: %s 不是 PEM", certFile)
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return TLSInfo{}, fmt.Errorf("tls: parse %s: %w", certFile, err)
	}
	fp := FingerprintHex(cert)
	code, err := PairingCode(fp)
	if err != nil {
		return TLSInfo{}, err
	}
	return TLSInfo{CertFile: certFile, KeyFile: keyFile, FingerprintHex: fp, PairingCode: code}, nil
}

// FingerprintHex 返回证书 DER 的 sha256 hex（小写 64 字符）。
func FingerprintHex(cert *x509.Certificate) string {
	sum := sha256.Sum256(cert.Raw)
	return hex.EncodeToString(sum[:])
}

// PairingCode 把指纹前 10 字节编成 16 字符 Base32，按 4-4-4-4 分组（契约 6.1）。
func PairingCode(fingerprintHex string) (string, error) {
	raw, err := hex.DecodeString(strings.TrimSpace(fingerprintHex))
	if err != nil {
		return "", fmt.Errorf("tls: 指纹不是 hex: %w", err)
	}
	if len(raw) < pairingBytes {
		return "", fmt.Errorf("tls: 指纹至少 %d 字节，got %d", pairingBytes, len(raw))
	}
	enc := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw[:pairingBytes])
	if len(enc) != 16 {
		return "", fmt.Errorf("tls: 配对码长度 %d, want 16", len(enc))
	}
	return enc[0:4] + "-" + enc[4:8] + "-" + enc[8:12] + "-" + enc[12:16], nil
}

// generateSelfSigned 生成 ECDSA P-256 自签证书；IsCA 是为了让同一张证书
// 既能做服务端也能做客户端（节点↔节点双向 TLS 用同一张）。
func generateSelfSigned(certFile, keyFile string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("tls: 生成密钥: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return fmt.Errorf("tls: 生成序列号: %w", err)
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "base-node", Organization: []string{"base"}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(certValidity),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		DNSNames:              []string{"base-node"},
		IPAddresses:           []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return fmt.Errorf("tls: 自签证书: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return fmt.Errorf("tls: 序列化私钥: %w", err)
	}
	dir := filepath.Dir(certFile)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("tls: mkdir %s: %w", dir, err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(certFile, certPEM, 0o644); err != nil {
		return fmt.Errorf("tls: 写 %s: %w", certFile, err)
	}
	if err := os.WriteFile(keyFile, keyPEM, 0o600); err != nil {
		return fmt.Errorf("tls: 写 %s: %w", keyFile, err)
	}
	return nil
}

// PeerVerifier 返回指纹固定回调：只接受 DER 的 sha256 命中白名单的证书。
// 空白名单 = 拒绝一切（fail-closed），绝不退化成「不校验」。
func PeerVerifier(allowed []string) func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
	set := make(map[string]struct{}, len(allowed))
	for _, f := range allowed {
		set[strings.ToLower(strings.TrimSpace(f))] = struct{}{}
	}
	return func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		if len(rawCerts) == 0 {
			return fmt.Errorf("%w: 对端未提供证书", ErrFingerprintMismatch)
		}
		sum := sha256.Sum256(rawCerts[0])
		got := hex.EncodeToString(sum[:])
		if _, ok := set[got]; !ok {
			return fmt.Errorf("%w: 对端指纹 %s 不在白名单", ErrFingerprintMismatch, got)
		}
		return nil
	}
}

// ServerTLSConfig 构造服务端配置。peerFingerprints 非空时启用双向 TLS 并要求对端指纹命中白名单。
func ServerTLSConfig(info TLSInfo, peerFingerprints []string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(info.CertFile, info.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("tls: 加载密钥对: %w", err)
	}
	cfg := &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	if len(peerFingerprints) > 0 {
		// RequireAnyClientCert：不依赖系统 CA 链，信任完全由下方指纹固定承担。
		cfg.ClientAuth = tls.RequireAnyClientCert
		cfg.VerifyPeerCertificate = PeerVerifier(peerFingerprints)
	}
	return cfg, nil
}

// ClientTLSConfig 构造出站配置：跳过系统 CA 校验，信任完全由指纹固定承担。
// 这是自签 + 指纹固定的标准写法——InsecureSkipVerify 在此**不**等于不安全。
func ClientTLSConfig(peerFingerprintHex string) *tls.Config {
	return &tls.Config{
		InsecureSkipVerify:    true,
		VerifyPeerCertificate: PeerVerifier([]string{peerFingerprintHex}),
		MinVersion:            tls.VersionTLS12,
	}
}

// RequireNodeKey 校验节点间预共享密钥头（契约 6.3：与 TLS 指纹是两层，互不替代）。
func (s *Server) RequireNodeKey(key string, next http.Handler) http.Handler {
	want := []byte(key)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := []byte(r.Header.Get("X-Base-Node-Key"))
		if len(got) != len(want) || subtle.ConstantTimeCompare(got, want) != 1 {
			s.writeAuthErr(w, http.StatusUnauthorized, "node_key_mismatch")
			return
		}
		next.ServeHTTP(w, r)
	})
}
```

- [ ] **Step 4: 改 `Options` 与错误码表**

改动 A —— `internal/httpapi/server.go` 的 `Options`（新增两个仅供首页展示的字段）：

```go
type Options struct {
	Issuer     string
	SignKeyHex string
	Version    string
	// TLS 身份，供首页展示配对码与指纹；两者留空表示节点未启用 TLS。
	FingerprintHex string
	PairingCode    string
}
```

改动 B —— `internal/httpapi/authmw.go` 的 `authErrText` 增加一行（放在 `identity_unregistered` 之后）：

```go
	"node_key_mismatch":        "节点间预共享密钥不匹配",
```

- [ ] **Step 5: 运行测试确认通过**

```powershell
Set-Location e:\code\base
go test ./internal/httpapi/ -run 'TestPairingCode|TestLoadOrCreateTLSCert|TestPeerVerifier|TestClientTLSConfigPinsFingerprint|TestRequireNodeKey' -v
```

Expected: 7 个测试全部 PASS（`TestPeerVerifierHandshake` 3 个子用例、`TestRequireNodeKey` 3 个子用例）。

- [ ] **Step 6: 回归全仓**

```powershell
Set-Location e:\code\base
go build ./...
go test ./...
```

Expected: 编译通过，所有包 `ok`。

- [ ] **Step 7: 提交**

```bash
git -C e:/code/base add internal/httpapi/tlscfg.go internal/httpapi/tlscfg_test.go internal/httpapi/server.go internal/httpapi/authmw.go
git -C e:/code/base commit -m "feat: TLS 自签证书、指纹固定与配对码"
```

---

### Task 13: 密钥/证书 CLI 与双监听拓扑

**Files:**
- Modify: `internal/store/crypto.go`（新增 `StoreKeyStatus`，只读、无副作用）
- Modify: `internal/store/crypto_test.go`（追加 `TestStoreKeyStatus`）
- Create: `cmd/based/storekey.go`
- Create: `cmd/based/tlscert.go`
- Modify: `cmd/based/serve.go`（新增 flag、双监听）
- Modify: `cmd/based/main.go`（子命令分发与 usage）
- Modify: `internal/httpapi/web.go`（`pageData` 增加配对码与指纹）
- Modify: `web/templates/base.html`（展示配对码）

**为什么要 `StoreKeyStatus`**：CLI 需要「查询密钥是否存在」而不触发 `Open` 的自动生成副作用（否则 `store-key show` 会凭空造出一个密钥文件）。

**双监听拓扑**（Task 1 spike 的退路形态）：

| 监听 | flag | 用途 | TLS |
|---|---|---|---|
| 主监听 | `-addr`（默认 `:8080`） | 客户端接口 | 默认 TLS（`<data>/tls/node.crt`）；`-tls-cert off` 显式降级为明文（仅 spike 判定不可行时使用） |
| 对端监听 | `-peer-addr`（默认空=不启用） | 节点↔节点 | 强制双向 TLS + 指纹固定；可叠加 `-node-key` 预共享密钥 |

- [ ] **Step 1: 写失败测试**

把下面函数**追加**到 `e:\code\base\internal\store\crypto_test.go` 末尾：

```go
func TestStoreKeyStatus(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(envStoreKey, "")
	t.Setenv(envStoreKeyFile, "")

	// 1. 无密钥文件：只报告路径，不创建文件。
	path, keyHex, exists, err := StoreKeyStatus(dir)
	if err != nil {
		t.Fatalf("StoreKeyStatus: %v", err)
	}
	if path != defaultStoreKeyPath(dir) {
		t.Fatalf("path = %s, want %s", path, defaultStoreKeyPath(dir))
	}
	if exists || keyHex != "" {
		t.Fatalf("密钥不应存在，got exists=%v hex=%q", exists, keyHex)
	}
	if _, err := os.Stat(defaultStoreKeyPath(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("StoreKeyStatus 不得创建密钥文件")
	}

	// 2. 已有密钥文件。
	if err := os.WriteFile(defaultStoreKeyPath(dir), []byte(testKeyHex+"\n"), 0o600); err != nil {
		t.Fatalf("预置密钥: %v", err)
	}
	path, keyHex, exists, err = StoreKeyStatus(dir)
	if err != nil {
		t.Fatalf("StoreKeyStatus: %v", err)
	}
	if !exists || keyHex != testKeyHex || path != defaultStoreKeyPath(dir) {
		t.Fatalf("got path=%s exists=%v hex=%s", path, exists, keyHex)
	}

	// 3. 环境变量注入：无文件路径。
	envKey := strings.Repeat("ab", 32)
	t.Setenv(envStoreKey, envKey)
	path, keyHex, exists, err = StoreKeyStatus(dir)
	if err != nil {
		t.Fatalf("StoreKeyStatus(env): %v", err)
	}
	if !exists || keyHex != envKey || path != "" {
		t.Fatalf("got path=%q exists=%v hex=%s", path, exists, keyHex)
	}
	t.Setenv(envStoreKey, "")

	// 4. 代码注入：无文件路径。
	path, keyHex, exists, err = StoreKeyStatus(dir, WithStoreKey(testKeyHex))
	if err != nil {
		t.Fatalf("StoreKeyStatus(opt): %v", err)
	}
	if !exists || keyHex != testKeyHex || path != "" {
		t.Fatalf("got path=%q exists=%v hex=%s", path, exists, keyHex)
	}

	// 5. 坏密钥文件：报错而不是静默当不存在。
	badDir := t.TempDir()
	if err := os.WriteFile(defaultStoreKeyPath(badDir), []byte("not-hex"), 0o600); err != nil {
		t.Fatalf("预置坏密钥: %v", err)
	}
	if _, _, _, err := StoreKeyStatus(badDir); err == nil {
		t.Fatal("坏密钥文件应报错")
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```powershell
Set-Location e:\code\base
go test ./internal/store/ -run TestStoreKeyStatus -v
```

Expected: 编译失败，报 `undefined: StoreKeyStatus`。

- [ ] **Step 3: 写最小实现**

在 `e:\code\base\internal\store\crypto.go` 的 `StoreKeyPath()` 之后插入：

```go
// StoreKeyStatus 报告当前配置下的密钥状态，**不创建任何文件**（供 CLI 只读查询）。
// path 为密钥来源文件路径；密钥来自参数/环境变量时为空串。hexKey 仅在 exists=true 时非空。
func StoreKeyStatus(dataDir string, opts ...Option) (path, hexKey string, exists bool, err error) {
	cfg := openConfig{}
	for _, opt := range opts {
		if err := opt(&cfg); err != nil {
			return "", "", false, err
		}
	}

	if cfg.storeKeyHex != "" {
		k, err := parseStoreKey(cfg.storeKeyHex)
		if err != nil {
			return "", "", false, err
		}
		return "", hex.EncodeToString(k), true, nil
	}
	if v := strings.TrimSpace(os.Getenv(envStoreKey)); v != "" {
		k, err := parseStoreKey(v)
		if err != nil {
			return "", "", false, err
		}
		return "", hex.EncodeToString(k), true, nil
	}
	if f := strings.TrimSpace(os.Getenv(envStoreKeyFile)); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			return f, "", false, fmt.Errorf("store: read %s=%s: %w", envStoreKeyFile, f, err)
		}
		k, err := parseStoreKey(string(b))
		if err != nil {
			return f, "", false, err
		}
		return f, hex.EncodeToString(k), true, nil
	}

	p := defaultStoreKeyPath(dataDir)
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return p, "", false, nil
	}
	if err != nil {
		return p, "", false, fmt.Errorf("store: read store key %s: %w", p, err)
	}
	k, err := parseStoreKey(string(b))
	if err != nil {
		return p, "", false, err
	}
	return p, hex.EncodeToString(k), true, nil
}
```

- [ ] **Step 4: 运行测试确认通过**

```powershell
Set-Location e:\code\base
go test ./internal/store/ -run TestStoreKeyStatus -v
```

Expected: PASS。

- [ ] **Step 5: 写 `store-key` 子命令**

创建 `e:\code\base\cmd\based\storekey.go`：

```go
package main

import (
	"flag"
	"fmt"

	"github.com/johocn/base/internal/store"
)

// runStoreKey 是 L4a′ 静态加密密钥的运维入口。
//
//	store-key show —— 只读打印密钥来源与 hex（不创建任何文件）
//	store-key init —— 密钥不存在则生成（serve 首启同样会自动生成）
//
// 契约 7.5：密钥一旦确定不得变更；变更 = 全库重写，属运维事故处置。
func runStoreKey(args []string) error {
	fs := flag.NewFlagSet("store-key", flag.ExitOnError)
	data := fs.String("data", "data", "数据目录")
	if err := fs.Parse(args); err != nil {
		return err
	}
	sub := fs.Arg(0)
	if sub == "" {
		return fmt.Errorf("用法: based store-key <show|init> [-data <dir>]")
	}

	path, keyHex, exists, err := store.StoreKeyStatus(*data)
	if err != nil {
		return err
	}

	switch sub {
	case "show":
		if !exists {
			return fmt.Errorf("密钥不存在（来源 %s）：先运行 based store-key init", displayPath(path))
		}
		fmt.Printf("key_path = %s\n", displayPath(path))
		fmt.Printf("key_hex  = %s\n", keyHex)
		return nil

	case "init":
		if exists {
			fmt.Printf("密钥已存在，未改动。\nkey_path = %s\nkey_hex  = %s\n", displayPath(path), keyHex)
			return nil
		}
		st, err := store.Open(*data)
		if err != nil {
			return err
		}
		defer st.Close()
		fmt.Println("已生成密钥（离线恢复码，请抄走并离线保存）：")
		fmt.Printf("key_path = %s\n", st.StoreKeyPath())
		fmt.Printf("key_hex  = %s\n", st.StoreKeyHex())
		fmt.Println("警告：丢失该密钥 = data 目录内内容永久不可读。")
		return nil

	default:
		return fmt.Errorf("未知子命令 %q；用法: based store-key <show|init>", sub)
	}
}

// displayPath 让「密钥来自环境变量」也有可读输出。
func displayPath(p string) string {
	if p == "" {
		return "(环境变量注入，无文件)"
	}
	return p
}
```

- [ ] **Step 6: 写 `tls-cert` 子命令**

创建 `e:\code\base\cmd\based\tlscert.go`：

```go
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/johocn/base/internal/httpapi"
)

// runTLSCert 管理节点自签证书（契约 6.1 / 6.2）。
//
//	tls-cert init   —— 不存在则生成；已存在则报错（避免误换指纹）
//	tls-cert show   —— 打印证书路径、完整指纹 hex、配对码
//	tls-cert rotate —— 备份旧证书后生成新证书（所有客户端需重新配对）
func runTLSCert(args []string) error {
	fs := flag.NewFlagSet("tls-cert", flag.ExitOnError)
	data := fs.String("data", "data", "数据目录")
	cert := fs.String("cert", "", "证书路径；空=<data>/tls/node.crt")
	key := fs.String("key", "", "私钥路径；空=<data>/tls/node.key")
	if err := fs.Parse(args); err != nil {
		return err
	}
	sub := fs.Arg(0)
	if sub == "" {
		return fmt.Errorf("用法: based tls-cert <init|show|rotate> [-data <dir>]")
	}

	certPath, keyPath := *cert, *key
	if certPath == "" {
		certPath = filepath.Join(*data, "tls", "node.crt")
	}
	if keyPath == "" {
		keyPath = filepath.Join(*data, "tls", "node.key")
	}

	switch sub {
	case "init":
		if _, err := os.Stat(certPath); err == nil {
			return fmt.Errorf("证书已存在：%s；如需换新请用 tls-cert rotate", certPath)
		}
	case "show":
		if _, err := os.Stat(certPath); err != nil {
			return fmt.Errorf("证书不存在：%s；先运行 based tls-cert init", certPath)
		}
	case "rotate":
		stamp := time.Now().Format("20060102T150405")
		for _, p := range []string{certPath, keyPath} {
			if _, err := os.Stat(p); err != nil {
				continue
			}
			bak := p + "." + stamp + ".bak"
			if err := os.Rename(p, bak); err != nil {
				return fmt.Errorf("备份 %s: %w", p, err)
			}
			fmt.Printf("已备份 %s → %s\n", p, bak)
		}
	default:
		return fmt.Errorf("未知子命令 %q；用法: based tls-cert <init|show|rotate>", sub)
	}

	info, err := httpapi.LoadOrCreateTLSCert(certPath, keyPath)
	if err != nil {
		return err
	}
	fmt.Printf("cert         = %s\n", info.CertFile)
	fmt.Printf("key          = %s\n", info.KeyFile)
	fmt.Printf("fingerprint  = %s\n", info.FingerprintHex)
	fmt.Printf("pairing_code = %s\n", info.PairingCode)
	if sub == "rotate" {
		fmt.Println("注意：指纹已变，所有客户端需删除旧记录并重新配对（契约 6.2，不提供忽略开关）。")
	}
	return nil
}
```

- [ ] **Step 7: 改 `serve.go` 为双监听拓扑**

用下面内容**整体替换** `e:\code\base\cmd\based\serve.go`：

```go
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/johocn/base/internal/httpapi"
	"github.com/johocn/base/internal/store"
)

// peerSpec 是契约 6.3 的对端清单元素。
// BASE_PEERS / -peers = [{"url":"https://...","tls_fingerprint":"<hex64>"}]
type peerSpec struct {
	URL            string `json:"url"`
	TLSFingerprint string `json:"tls_fingerprint"`
}

func parsePeers(raw string) ([]peerSpec, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var out []peerSpec
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, fmt.Errorf("BASE_PEERS 不是合法 JSON 数组: %w", err)
	}
	return out, nil
}

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	data := fs.String("data", "data", "数据目录")
	addr := fs.String("addr", envOr("BASE_ADDR", ":8080"), "客户端接口监听地址")
	issuer := fs.String("issuer", envOr("BASE_ISSUER", "base-node-1"), "签发方标识")
	key := fs.String("sign-key", os.Getenv("BASE_SIGN_KEY"), "Ed25519 私钥种子（hex64）；配置了才是源节点")
	storeKey := fs.String("store-key", os.Getenv("BASE_STORE_KEY"), "L4a′ 静态加密密钥（hex64）；缺省 <data>.key，两者皆无则首启生成")
	tlsCert := fs.String("tls-cert", envOr("BASE_TLS_CERT", ""), "客户端接口证书路径；空=<data>/tls/node.crt；off=明文 HTTP（仅 TLS spike 失败时的退路）")
	tlsKey := fs.String("tls-key", envOr("BASE_TLS_KEY", ""), "客户端接口私钥路径；空=<data>/tls/node.key")
	peerAddr := fs.String("peer-addr", envOr("BASE_PEER_ADDR", ""), "节点↔节点监听地址；空=不启用")
	peersRaw := fs.String("peers", os.Getenv("BASE_PEERS"), `对端清单 JSON：[{"url":"https://...","tls_fingerprint":"<hex64>"}]`)
	nodeKey := fs.String("node-key", os.Getenv("BASE_NODE_KEY"), "节点间预共享密钥（头 X-Base-Node-Key）")
	if err := fs.Parse(args); err != nil {
		return err
	}
	peers, err := parsePeers(*peersRaw)
	if err != nil {
		return err
	}

	opts := []store.Option{}
	if strings.TrimSpace(*storeKey) != "" {
		opts = append(opts, store.WithStoreKey(*storeKey))
	}
	st, err := store.Open(*data, opts...)
	if err != nil {
		return err
	}
	defer st.Close()

	plaintext := strings.EqualFold(strings.TrimSpace(*tlsCert), "off")
	certPath, keyPath := strings.TrimSpace(*tlsCert), strings.TrimSpace(*tlsKey)
	if !plaintext {
		if certPath == "" {
			certPath = filepath.Join(*data, "tls", "node.crt")
		}
		if keyPath == "" {
			keyPath = filepath.Join(*data, "tls", "node.key")
		}
	}

	// 节点自身 TLS 身份：主监听与对端监听共用同一张证书。
	// 客户端接口显式降级为明文时，只要启用了 -peer-addr 仍必须生成证书。
	var info httpapi.TLSInfo
	if !plaintext || *peerAddr != "" {
		info, err = httpapi.LoadOrCreateTLSCert(certPath, keyPath)
		if err != nil {
			return err
		}
	}

	// 对端指纹白名单 = -peers 声明的指纹（用于校验入站对端证书）。
	var peerFPs []string
	for _, p := range peers {
		if p.TLSFingerprint != "" {
			peerFPs = append(peerFPs, p.TLSFingerprint)
		}
	}

	srv, err := httpapi.New(st, httpapi.Options{
		Issuer:         *issuer,
		SignKeyHex:     *key,
		Version:        version,
		FingerprintHex: info.FingerprintHex,
		PairingCode:    info.PairingCode,
	})
	if err != nil {
		return err
	}
	if n, err := srv.PruneNonces(); err != nil {
		log.Printf("based: 清理过期 nonce 失败: %v", err)
	} else if n > 0 {
		log.Printf("based: 清理过期 nonce %d 行", n)
	}

	handler := srv.Handler()

	// 对端监听：强制双向 TLS + 指纹固定，可选叠加预共享密钥（契约 6.3）。
	if *peerAddr != "" {
		if len(peerFPs) == 0 {
			return fmt.Errorf("启用 -peer-addr 必须同时配置 -peers：没有对端指纹白名单就无法固定对端身份")
		}
		peerTLS, err := httpapi.ServerTLSConfig(info, peerFPs)
		if err != nil {
			return err
		}
		peerHandler := handler
		if strings.TrimSpace(*nodeKey) != "" {
			peerHandler = srv.RequireNodeKey(*nodeKey, peerHandler)
		}
		ln, err := net.Listen("tcp", *peerAddr)
		if err != nil {
			return err
		}
		peerSrv := &http.Server{Handler: peerHandler, TLSConfig: peerTLS}
		go func() {
			log.Printf("based 对端接口监听 %s（双向 TLS + 指纹固定，白名单 %d 个）", *peerAddr, len(peerFPs))
			if err := peerSrv.ServeTLS(ln, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("based: 对端监听退出: %v", err)
			}
		}()
	}

	base := fmt.Sprintf("issuer=%s source=%v data=%s storeKey=%s…", *issuer, *key != "", *data, shortKey(st.StoreKeyHex()))
	if plaintext {
		log.Printf("based %s 监听 %s（**明文 HTTP**，仅签名头认证；%s）", version, *addr, base)
		return http.ListenAndServe(*addr, handler)
	}

	clientTLS, err := httpapi.ServerTLSConfig(info, nil)
	if err != nil {
		return err
	}
	httpSrv := &http.Server{Addr: *addr, Handler: handler, TLSConfig: clientTLS}
	log.Printf("based %s 监听 %s（TLS；指纹 %s；配对码 %s；%s）",
		version, *addr, info.FingerprintHex, info.PairingCode, base)
	return httpSrv.ListenAndServeTLS("", "")
}

// shortKey 只回显密钥前 8 位 hex，避免完整密钥进日志。
func shortKey(hexKey string) string {
	if len(hexKey) < 8 {
		return "?"
	}
	return hexKey[:8]
}
```

- [ ] **Step 8: 改 `main.go` 子命令分发**

改动 A —— `switch` 中 `pubkey` 之后增加两个 case：

```go
	case "store-key":
		err = runStoreKey(os.Args[2:])
	case "tls-cert":
		err = runTLSCert(os.Args[2:])
```

改动 B —— `usage()`：

```go
	fmt.Fprintln(os.Stderr, "usage: based <version|import-md|export|serve|pubkey|store-key|tls-cert> [flags]")
```

- [ ] **Step 9: 首页展示配对码**

改动 A —— `internal/httpapi/web.go` 的 `pageData` 增加两个字段：

```go
type pageData struct {
	Title       string
	Issuer      string
	PairingCode string
	Fingerprint string
	Items       []pageItem
	Article     *pageArticle
}
```

改动 B —— 同文件 `handleIndex` 的 `data := pageData{...}` 改为：

```go
	data := pageData{
		Title:       "内容目录",
		Issuer:      s.opt.Issuer,
		PairingCode: s.opt.PairingCode,
		Fingerprint: s.opt.FingerprintHex,
	}
```

改动 C —— 同文件 `handleArticlePage` 的 `data := pageData{...}` 首行改为（其余字段不动）：

```go
	data := pageData{Title: art.Title, Issuer: s.opt.Issuer, PairingCode: s.opt.PairingCode, Fingerprint: s.opt.FingerprintHex, Article: &pageArticle{
```

改动 D —— `web/templates/base.html` 的 `<style>` 内追加一行样式：

```css
.pair { padding: 10px 18px; border-bottom: 1px solid #e5e5e5; font-size: 13px; color: #555; }
.pair code { user-select: all; }
```

改动 E —— 同文件 `<header>` 之后插入：

```html
{{if .PairingCode}}<div class="pair">节点配对码 <code>{{.PairingCode}}</code> · 指纹 <code>{{.Fingerprint}}</code></div>{{end}}
```

- [ ] **Step 10: 构建并手工验收 CLI 与双监听**

```powershell
Set-Location e:\code\base
go build ./...
go run ./cmd/based store-key show -data tmpdata
```

Expected: 退出码 1，报 `密钥不存在（来源 E:\code\base\tmpdata.key）：先运行 based store-key init`。**此时 `tmpdata.key` 必须不存在**（验证无副作用）。

```powershell
go run ./cmd/based store-key init -data tmpdata
go run ./cmd/based store-key show -data tmpdata
```

Expected: 两次打印同一个 64 位 hex；`init` 额外打印「已生成密钥（离线恢复码…）」与警告行。

```powershell
go run ./cmd/based tls-cert show -data tmpdata
go run ./cmd/based tls-cert init -data tmpdata
go run ./cmd/based tls-cert rotate -data tmpdata
go run ./cmd/based tls-cert show -data tmpdata
```

Expected: 第 1 条报「证书不存在」；第 2 条打印 `fingerprint`（64 hex）与 `pairing_code`（形如 `XXXX-XXXX-XXXX-XXXX`）；第 3 条打印「已备份 …→….bak」且指纹改变；第 4 条与第 3 条指纹一致。

```powershell
$proc = Start-Process -PassThru -NoNewWindow go -ArgumentList 'run','./cmd/based','serve','-data','tmpdata','-addr','127.0.0.1:18080'
Start-Sleep -Seconds 6
try { (Invoke-WebRequest -Uri https://127.0.0.1:18080/ -SkipCertificateCheck).Content | Select-String 'AAAA-AAAA-AAAA-AAAA' } finally { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
```

Expected: 首页 HTML 含 `class="pair"` 且含 `tls-cert show` 打印出的配对码。`-SkipCertificateCheck` 是**人工肉眼核对配对码时**的临时手段，产品代码里没有这条路径（契约 6.1 无「忽略」开关）。

```powershell
Remove-Item -Recurse -Force tmpdata, tmpdata.key -ErrorAction SilentlyContinue
```

- [ ] **Step 11: 回归全仓**

```powershell
Set-Location e:\code\base
go build ./...
go test ./...
```

Expected: 编译通过，所有包 `ok`。

- [ ] **Step 12: 提交**

```bash
git -C e:/code/base add internal/store/crypto.go internal/store/crypto_test.go cmd/based/storekey.go cmd/based/tlscert.go cmd/based/serve.go cmd/based/main.go internal/httpapi/web.go web/templates/base.html
git -C e:/code/base commit -m "feat: 密钥/证书 CLI 与节点双监听拓扑"
```

---

### 规格修正 7-8（补充进本计划头部修正清单）

**修正 7：TS 侧 AES-256-GCM 与 argon2id 的实现位置**

册子 §9 交汇点 1 要求「spike 的列级加密与本册子 §7.1 的封装格式、AEAD 算法、参数必须一致，实现共用 `packages/protocol-ts` 一侧」。但计划头部文件结构表漏了两件事：

1. 现有 `packages/protocol-ts` 只有 `@noble/curves` + `@noble/hashes`，**没有 AES-GCM 实现**。`@noble/hashes@1.4.0` 已含 `argon2id`（已验证 `node_modules/@noble/hashes` 的 `./argon2` 子路径导出 `argon2id`），无需升级；但 AES-GCM 必须新增依赖。
2. 已核实 `@noble/ciphers@1.3.0`（v1 线，与 `@noble/hashes` 1.x 同代）提供 `./aes` 子路径的 `gcm`；npm registry 为 `https://registry.npmmirror.com/`（用户级 `.npmrc` 已配置），可获取。

**结论：** 新增 `packages/protocol-ts/src/aead.ts`（封装格式唯一实现）与 `packages/protocol-ts/src/kdf.ts`（argon2id 参数契约），`packages/protocol-ts/package.json` 增加 `"@noble/ciphers": "1.3.0"`；`hash.ts` 追加导出 `bytesToHex` / `randomBytes`。移动端不再直接依赖 `@noble/*`，只依赖 `@base/protocol-ts`。

**修正 8：S1 期设备 KEK 的实际来源**

册子 §8 把 `kek_source` 留成「供 spike（#4）结论回填」，但没定 S1 期**先跑什么**。若不落地，"本地私钥永不明文落盘"（§8 表下第一行）就成了空话。

**结论：** S1 期 `deviceKek()` = 32 字节随机值，经 `StorageAdapter` 存于应用私有存储（键 `identity.device_kek`）；`kek_source` 记为 `"device"`。**必须诚实标注残余风险**：该 KEK 与密文同库，不抗有 root/越狱能力的本地读取。spike 落地后只替换 `deviceKek()` 实现（改走设备安全存储/用户口令），`saveLocalIdentity` / `loadLocalIdentity` 的调用契约不变。此结论要回填册子 §8 的 `kek_source` 行。

---

### Task 14: 移动端身份（生成 / 本机密文存储 / 托管封装 / 签名头）

**Files:**
- Modify: `packages/protocol-ts/package.json`（加 `@noble/ciphers`）
- Create: `packages/protocol-ts/src/aead.ts`
- Create: `packages/protocol-ts/src/aead.test.ts`
- Create: `packages/protocol-ts/src/kdf.ts`
- Modify: `packages/protocol-ts/src/hash.ts`（追加 `bytesToHex` / `randomBytes` 导出）
- Modify: `packages/protocol-ts/src/index.ts`（导出 `aead` / `kdf`）
- Create: `apps/mobile/src/core/identity.ts`
- Create: `apps/mobile/src/core/identity.test.ts`

**契约依据**：册子 §4.1（客户端侧加密）、§5.3 / §5.4（escrow 请求体与响应字段）、§8（手机端身份表与私钥存放）、§3.1（5 个签名头）。

- [ ] **Step 1: 安装 AES-GCM 依赖**

```powershell
Set-Location e:\code\base
npm install -w packages/protocol-ts @noble/ciphers@1.3.0
```

Expected: `added 1 package`，`packages/protocol-ts/package.json` 的 `dependencies` 出现 `"@noble/ciphers": "1.3.0"`。

验证：

```powershell
node -e "import('@noble/ciphers/aes').then(m=>console.log(typeof m.gcm))"
```

Expected: 打印 `function`。

- [ ] **Step 2: 写 `aead.test.ts`（失败测试）**

创建 `e:\code\base\packages\protocol-ts\src\aead.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { GCM_NONCE_BYTES, GCM_TAG_BYTES, open, seal, openWithNonce, sealWithNonce } from "./aead";
import { hexToBytes, randomBytes } from "./hash";

const KEY = hexToBytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");

describe("aead", () => {
  it("seal 产出 nonce(12) || ct || tag(16)，open 可还原", () => {
    const plain = new TextEncoder().encode("base L4a′ 封装格式");
    const blob = seal(KEY, plain);
    expect(blob.length).toBe(GCM_NONCE_BYTES + plain.length + GCM_TAG_BYTES);
    expect(new TextDecoder().decode(open(KEY, blob))).toBe("base L4a′ 封装格式");
  });

  it("固定 nonce 时输出可复现：同一 key/nonce/明文 → 同一密文", () => {
    const nonce = new Uint8Array(GCM_NONCE_BYTES); // 全 0
    const plain = new Uint8Array([1, 2, 3, 4]);
    const a = sealWithNonce(KEY, nonce, plain);
    const b = sealWithNonce(KEY, nonce, plain);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(plain.length + GCM_TAG_BYTES);
  });

  it("escrow 形态：nonce 独立成列，本体 = ct || tag", () => {
    const nonce = randomBytes(GCM_NONCE_BYTES);
    const plain = randomBytes(32);
    const ct = sealWithNonce(KEY, nonce, plain);
    expect(Array.from(openWithNonce(KEY, nonce, ct))).toEqual(Array.from(plain));
  });

  it("篡改密文 / 错 key 必须认证失败", () => {
    const blob = seal(KEY, new TextEncoder().encode("x"));
    const tampered = new Uint8Array(blob);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => open(KEY, tampered)).toThrow();
    expect(() => open(new Uint8Array(32), blob)).toThrow();
  });

  it("参数校验：key 必须 32 字节、nonce 必须 12 字节、密文不得过短", () => {
    expect(() => seal(new Uint8Array(16), new Uint8Array(1))).toThrow(/密钥/);
    expect(() => sealWithNonce(KEY, new Uint8Array(8), new Uint8Array(1))).toThrow(/nonce/);
    expect(() => open(KEY, new Uint8Array(GCM_NONCE_BYTES + GCM_TAG_BYTES - 1))).toThrow(/过短/);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```powershell
Set-Location e:\code\base
npx vitest run packages/protocol-ts/src/aead.test.ts
```

Expected: 失败，报 `Failed to resolve import "./aead"`。

- [ ] **Step 4: 实现 `aead.ts` 与 `kdf.ts`**

创建 `e:\code\base\packages\protocol-ts\src\aead.ts`：

```ts
import { gcm } from "@noble/ciphers/aes";

import { randomBytes } from "@noble/hashes/utils";

/**
 * 与 Go 侧 `store.Encrypt` 的封装格式逐字节一致（册子 §7.1 / §9 交汇点 1）：
 * `nonce(12) || ciphertext || tag(16)`。
 *
 * 手机本地库列级加密与节点静态加密共用本文件——§9 交汇点 1 的"格式必须一致"靠这里落地，
 * 不靠两边各写一遍。改本文件 = 同时改节点与手机端，必须同步 Go 侧 crypto.go。
 */
export const GCM_NONCE_BYTES = 12;
export const GCM_TAG_BYTES = 16;
export const AES_KEY_BYTES = 32;

function assertKey(key: Uint8Array): void {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`aead: 密钥必须 ${AES_KEY_BYTES} 字节，实得 ${key.length}`);
  }
}

function assertNonce(nonce: Uint8Array): void {
  if (nonce.length !== GCM_NONCE_BYTES) {
    throw new Error(`aead: nonce 必须 ${GCM_NONCE_BYTES} 字节，实得 ${nonce.length}`);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** 封装为 `nonce(12) || ciphertext || tag(16)`；不传 nonce 则随机生成。 */
export function seal(key: Uint8Array, plain: Uint8Array, nonce?: Uint8Array): Uint8Array {
  assertKey(key);
  const n = nonce ?? randomBytes(GCM_NONCE_BYTES);
  assertNonce(n);
  return concat(n, gcm(key, n).encrypt(plain));
}

/** 拆开 `nonce(12) || ciphertext || tag(16)`；认证失败即抛错，不做任何降级。 */
export function open(key: Uint8Array, blob: Uint8Array): Uint8Array {
  assertKey(key);
  if (blob.length < GCM_NONCE_BYTES + GCM_TAG_BYTES) {
    throw new Error(`aead: 密文过短（${blob.length} 字节）`);
  }
  return gcm(key, blob.subarray(0, GCM_NONCE_BYTES)).decrypt(blob.subarray(GCM_NONCE_BYTES));
}

/** escrow 专用：源码约定 nonce 独立成列（册子 §4.1），故本体只有 `ciphertext || tag`。 */
export function sealWithNonce(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array): Uint8Array {
  assertKey(key);
  assertNonce(nonce);
  return gcm(key, nonce).encrypt(plain);
}

export function openWithNonce(key: Uint8Array, nonce: Uint8Array, ct: Uint8Array): Uint8Array {
  assertKey(key);
  assertNonce(nonce);
  return gcm(key, nonce).decrypt(ct);
}
```

创建 `e:\code\base\packages\protocol-ts\src\kdf.ts`：

```ts
import { argon2id } from "@noble/hashes/argon2";

import { utf8 } from "./hash";

/**
 * 密码托管用的 KDF 参数（册子 §4.1 / §5.3）。
 *
 * **参数由客户端决定并随密文一起上传，节点原样存原样返**（§4.1「参数的归属」）。
 * 换设备必须拿回同一组参数才能派生同一 kek，因此字段名与取值即线上契约，
 * 与服务端 `escrow.kdf_json` 逐字段对应，不可改。
 */
export interface KdfParams {
  alg: "argon2id";
  /** 内存成本，单位 KiB */
  m: number;
  /** 迭代次数 */
  t: number;
  /** 并行度 */
  p: number;
  /** 派生长度，字节 */
  len: number;
}

/** 册子 §4.1 规定的唯一默认值：m=65536 KiB, t=3, p=1, len=32。 */
export const DEFAULT_KDF: KdfParams = { alg: "argon2id", m: 65536, t: 3, p: 1, len: 32 };

/** 从口令与盐派生 KEK。`salt` 长度由调用方决定（册子 §4.1 用随机 16 字节）。 */
export function deriveKek(password: string, salt: Uint8Array, kdf: KdfParams = DEFAULT_KDF): Uint8Array {
  if (kdf.alg !== "argon2id") {
    throw new Error(`kdf: 不支持的算法 ${kdf.alg}`);
  }
  if (salt.length === 0) {
    throw new Error("kdf: 盐不能为空");
  }
  return argon2id(utf8(password), salt, { t: kdf.t, m: kdf.m, p: kdf.p, dkLen: kdf.len });
}

/** 校验从节点取回的 kdf_json 形状；坏值必须显式报错，不能静默退回默认参数。 */
export function parseKdfParams(raw: unknown): KdfParams {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("kdf: 参数必须是对象");
  }
  const o = raw as Record<string, unknown>;
  if (o.alg !== "argon2id") {
    throw new Error(`kdf: 不支持的算法 ${String(o.alg)}`);
  }
  const nums: Array<"m" | "t" | "p" | "len"> = ["m", "t", "p", "len"];
  for (const k of nums) {
    const v = o[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new Error(`kdf: 字段 ${k} 必须是正整数，实得 ${String(v)}`);
    }
  }
  return { alg: "argon2id", m: o.m as number, t: o.t as number, p: o.p as number, len: o.len as number };
}
```

- [ ] **Step 5: 补 `hash.ts` 与 `index.ts` 导出**

改动 A —— `packages/protocol-ts/src/hash.ts` 最后一行：

```ts
export { bytesToHex, hexToBytes, randomBytes };
```

（替换原有的 `export { hexToBytes };`）

改动 B —— `packages/protocol-ts/src/index.ts` 追加两行：

```ts
export * from "./aead";
export * from "./kdf";
```

- [ ] **Step 6: 运行 aead 测试确认通过**

```powershell
Set-Location e:\code\base
npx vitest run packages/protocol-ts/src/aead.test.ts
```

Expected: 5 个测试全部 PASS。

- [ ] **Step 7: 写移动端身份测试（失败测试）**

创建 `e:\code\base\apps\mobile\src\core\identity.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { deriveIdentityId, sha256Hex, utf8, verify, requestSignBytes, type RequestMeta } from "@base/protocol-ts";

import { MemoryStorage } from "./fakes";
import {
  buildEscrowPayload,
  createIdentity,
  deviceKek,
  identityFromSeed,
  loadLocalIdentity,
  openEscrowPayload,
  exportIdentityBackup,
  importIdentityBackup,
  saveLocalIdentity,
  signRequestHeaders,
  type KdfParams,
} from "./identity";

// 测试用低成本参数：参数随密文走，故测试可自由选值而不影响生产默认（DEFAULT_KDF）。
const FAST_KDF: KdfParams = { alg: "argon2id", m: 8, t: 1, p: 1, len: 32 };

describe("identity", () => {
  it("id 由公钥派生且自证：同一 seed 恒得同一 id", () => {
    const a = createIdentity();
    expect(a.alg).toBe("ed25519");
    expect(a.pubHex).toHaveLength(64);
    expect(a.id).toHaveLength(32);
    expect(a.id).toBe(deriveIdentityId(a.pubHex));
    expect(identityFromSeed(a.seedHex).id).toBe(a.id);
  });

  it("两次生成的身份互不相同", () => {
    expect(createIdentity().id).not.toBe(createIdentity().id);
  });

  it("deviceKek 幂等：同一存储返回同一 KEK，且为 32 字节", async () => {
    const st = new MemoryStorage();
    const k1 = await deviceKek(st);
    const k2 = await deviceKek(st);
    expect(k1.length).toBe(32);
    expect(Array.from(k1)).toEqual(Array.from(k2));
  });

  it("本机密文往返：解锁得到同一身份", async () => {
    const st = new MemoryStorage();
    const kek = await deviceKek(st);
    const ident = createIdentity();
    await saveLocalIdentity(st, ident, kek, "device", "alice");
    const back = await loadLocalIdentity(st, kek);
    expect(back?.id).toBe(ident.id);
    expect(back?.seedHex).toBe(ident.seedHex);
  });

  it("私钥不明文落盘：存储里搜不到 seedHex", async () => {
    const st = new MemoryStorage();
    const kek = await deviceKek(st);
    const ident = createIdentity();
    await saveLocalIdentity(st, ident, kek, "device");
    for (const v of st.map.values()) {
      expect(v.includes(ident.seedHex)).toBe(false);
    }
  });

  it("错误 KEK 解不开本机密文", async () => {
    const st = new MemoryStorage();
    const ident = createIdentity();
    await saveLocalIdentity(st, ident, await deviceKek(st), "device");
    await expect(loadLocalIdentity(st, new Uint8Array(32))).rejects.toThrow();
  });

  it("无本地记录时返回 null（不抛错）", async () => {
    await expect(loadLocalIdentity(new MemoryStorage(), new Uint8Array(32))).resolves.toBeNull();
  });

  it("托管闭环：设密码上传 → 用同一密码取回 → 同一 id", () => {
    const ident = createIdentity();
    const payload = buildEscrowPayload(ident, "正确的马匹电池订书钉", FAST_KDF);
    expect(payload.id).toBe(ident.id);
    expect(payload.alg).toBe("ed25519");
    expect(payload.salt).toHaveLength(32); // 16 字节 → 32 hex
    expect(payload.encNonce).toHaveLength(24); // 12 字节 → 24 hex
    expect(payload.privCipher.length).toBeGreaterThan(64);
    expect(payload.kdf).toEqual(FAST_KDF);

    const back = openEscrowPayload(payload, "正确的马匹电池订书钉");
    expect(back.id).toBe(ident.id);
    expect(back.seedHex).toBe(ident.seedHex);
  });

  it("托管：错误密码解不开（客户端判定）", () => {
    const payload = buildEscrowPayload(createIdentity(), "right", FAST_KDF);
    expect(() => openEscrowPayload(payload, "wrong")).toThrow(/密码错误/);
  });

  it("托管：篡改 priv_cipher 即认证失败", () => {
    const payload = buildEscrowPayload(createIdentity(), "right", FAST_KDF);
    const flipped = (payload.privCipher[0] === "0" ? "1" : "0") + payload.privCipher.slice(1);
    expect(() => openEscrowPayload({ ...payload, privCipher: flipped }, "right")).toThrow(/密码错误/);
  });

  it("托管：篡改 id 会被识破（解出的私钥与 id 不符）", () => {
    const payload = buildEscrowPayload(createIdentity(), "right", FAST_KDF);
    const other = createIdentity();
    expect(() => openEscrowPayload({ ...payload, id: other.id }, "right")).toThrow(/不符/);
  });

  it("签名头：5 个头齐全，且能被公钥验过", () => {
    const ident = createIdentity();
    const body = utf8('{"type":"ping"}');
    const ts = 1_700_000_000_000;
    const h = signRequestHeaders(ident, { method: "post", path: "/v1/event", body }, ts);

    expect(Object.keys(h).sort()).toEqual([
      "X-Base-Alg",
      "X-Base-Id",
      "X-Base-Nonce",
      "X-Base-Sig",
      "X-Base-Ts",
    ]);
    expect(h["X-Base-Id"]).toBe(ident.id);
    expect(h["X-Base-Alg"]).toBe("ed25519");
    expect(h["X-Base-Ts"]).toBe(String(ts));
    expect(h["X-Base-Nonce"]).toHaveLength(24);

    const meta: RequestMeta = {
      method: "POST",
      path: "/v1/event",
      query: "",
      bodySha256: sha256Hex(body),
      ts,
      nonce: h["X-Base-Nonce"],
    };
    expect(verify(ident.pubHex, requestSignBytes(meta), h["X-Base-Sig"])).toBe(true);
  });

  it("签名头：无请求体时 body_sha256 用空体固定值", () => {
    const ident = createIdentity();
    const ts = 1_700_000_000_100;
    const h = signRequestHeaders(ident, { method: "GET", path: "/v1/me" }, ts);
    const meta: RequestMeta = {
      method: "GET",
      path: "/v1/me",
      query: "",
      bodySha256: sha256Hex(new Uint8Array(0)),
      ts,
      nonce: h["X-Base-Nonce"],
    };
    expect(verify(ident.pubHex, requestSignBytes(meta), h["X-Base-Sig"])).toBe(true);
  });

  it("签名头：每次 nonce 不同（防重放前提）", () => {
    const ident = createIdentity();
    const a = signRequestHeaders(ident, { method: "GET", path: "/v1/me" }, 1000);
    const b = signRequestHeaders(ident, { method: "GET", path: "/v1/me" }, 1000);
    expect(a["X-Base-Nonce"]).not.toBe(b["X-Base-Nonce"]);
  });

  it("私钥可主动备份并完整还原（册子 §2.2）", () => {
    const ident = createIdentity();
    const backup = exportIdentityBackup(ident);
    expect(backup).toBe(ident.seedHex);
    expect(identityFromSeed(backup).id).toBe(ident.id);
    // 手抄/扫码会有首尾空白与大小写噪声
    expect(importIdentityBackup("  " + backup.toUpperCase() + "\n").id).toBe(ident.id);
    expect(() => importIdentityBackup("not-a-seed")).toThrow(/64 位 hex/);
  });
  });
});
```

- [ ] **Step 8: 运行确认失败**

```powershell
Set-Location e:\code\base
npx vitest run apps/mobile/src/core/identity.test.ts
```

Expected: 失败，报 `Failed to resolve import "./identity"`。

- [ ] **Step 9: 实现 `identity.ts`**

创建 `e:\code\base\apps\mobile\src\core\identity.ts`：

```ts
/**
 * 客户端身份：密钥生成、id 派生、本机密文存储、密码托管封装、签名头构造。
 *
 * 只依赖注入的 `StorageAdapter`，不 import 'uni' / 'plus'，因此可在 Node 下用
 * `core/fakes.ts` 的假适配器完整测试（与 core/sync.ts 同一约定）。
 */
import {
  ALG_ED25519,
  bytesToHex,
  DEFAULT_KDF,
  deriveIdentityId,
  deriveKek,
  hexToBytes,
  keyPairFromSeed,
  openWithNonce,
  randomBytes,
  sealWithNonce,
  sign,
  requestSignBytes,
  sha256Hex,
  type KdfParams,
  type RequestMeta,
} from "@base/protocol-ts";

import type { StorageAdapter } from "../platform/adapter";

/** KEK 来源（册子 §8 的 `kek_source`）。spike(#4) 结论回填后此枚举才可能收缩。 */
export type KekSource = "device" | "password" | "device+password";

export const LOCAL_IDENTITY_KEY = "identity.meta";
export const LOCAL_PRIV_CIPHER_KEY = "identity.privkey_cipher";
export const LOCAL_DEVICE_KEK_KEY = "identity.device_kek";

/** 本机身份记录（册子 §8 的 `identity` 表；这里是 StorageAdapter 上的等价表示）。 */
export interface LocalIdentityRecord {
  id: string;
  alg: string;
  pubHex: string;
  kekSource: KekSource;
  escrowUsername?: string;
  createdAt: number;
}

export interface Identity {
  id: string;
  alg: string;
  pubHex: string;
  seedHex: string;
}

/** 按册子 §2.1 从种子派生完整身份。id 自证，节点不参与。 */
export function identityFromSeed(seedHex: string): Identity {
  const { pubHex } = keyPairFromSeed(seedHex);
  return { id: deriveIdentityId(pubHex), alg: ALG_ED25519, pubHex, seedHex };
}

/** 首次需要写入时本地生成身份：无需注册、无需节点审批、无需联网（册子 §2.2）。 */
export function createIdentity(): Identity {
  return identityFromSeed(bytesToHex(randomBytes(32)));
}

/**
 * 设备侧 KEK。
 *
 * **S1 期实现（修正 8）**：随机 32 字节，存应用私有存储。KEK 与密文同库，
 * 不抗有 root/越狱能力的本地读取——这是 spike(#4) 结论回填前的最低可用形态。
 * spike 落地后只替换本函数（改走设备安全存储 / 用户口令派生），调用方契约不变。
 */
export async function deviceKek(storage: StorageAdapter): Promise<Uint8Array> {
  const existing = await storage.get(LOCAL_DEVICE_KEK_KEY);
  if (existing) {
    const kek = hexToBytes(existing);
    if (kek.length !== 32) {
      throw new Error(`identity: 设备 KEK 长度异常（${kek.length} 字节）`);
    }
    return kek;
  }
  const kek = randomBytes(32);
  await storage.set(LOCAL_DEVICE_KEK_KEY, bytesToHex(kek));
  return kek;
}

/**
 * 本机身份落盘。私钥只以 `nonce:ct` 形态写入，**永不落明文**（册子 §8）。
 * 与 §5 的 escrow 是两个独立密文，可各用不同 KEK，互不替代。
 */
export async function saveLocalIdentity(
  storage: StorageAdapter,
  ident: Identity,
  kek: Uint8Array,
  kekSource: KekSource,
  escrowUsername?: string,
): Promise<void> {
  const nonce = randomBytes(12);
  const ct = sealWithNonce(kek, nonce, hexToBytes(ident.seedHex));
  await storage.set(LOCAL_PRIV_CIPHER_KEY, `${bytesToHex(nonce)}:${bytesToHex(ct)}`);
  const rec: LocalIdentityRecord = {
    id: ident.id,
    alg: ident.alg,
    pubHex: ident.pubHex,
    kekSource,
    createdAt: Date.now(),
  };
  if (escrowUsername) {
    rec.escrowUsername = escrowUsername;
  }
  await storage.set(LOCAL_IDENTITY_KEY, JSON.stringify(rec));
}

/** 载入本机身份；无记录返回 null（首次启动的正常路径）。KEK 不匹配即抛错。 */
export async function loadLocalIdentity(storage: StorageAdapter, kek: Uint8Array): Promise<Identity | null> {
  const metaRaw = await storage.get(LOCAL_IDENTITY_KEY);
  const cipherRaw = await storage.get(LOCAL_PRIV_CIPHER_KEY);
  if (!metaRaw || !cipherRaw) {
    return null;
  }
  const [nonceHex, ctHex] = cipherRaw.split(":");
  if (!nonceHex || !ctHex) {
    throw new Error("identity: 本机密文格式损坏");
  }
  const rec = JSON.parse(metaRaw) as LocalIdentityRecord;
  const ident = identityFromSeed(bytesToHex(openWithNonce(kek, hexToBytes(nonceHex), hexToBytes(ctHex))));
  if (ident.id !== rec.id) {
    throw new Error(`identity: 本机记录 id 与私钥不符（${rec.id} != ${ident.id}）`);
  }
  return ident;
}

/** `PUT /v1/identity/escrow/{username}` 的请求体（册子 §5.3）。 */
export interface EscrowPayload {
  id: string;
  alg: string;
  salt: string;
  kdf: KdfParams;
  encNonce: string;
  privCipher: string;
}

/**
 * 构造托管请求体：客户端侧加密，节点只存不解释（册子 §4.1 / §4.2）。
 * `salt` 与全部 KDF 参数随密文一起上传，换设备才能派生同一 KEK。
 */
export function buildEscrowPayload(
  ident: Identity,
  password: string,
  kdf: KdfParams = DEFAULT_KDF,
  salt?: Uint8Array,
): EscrowPayload {
  const s = salt ?? randomBytes(16);
  const kek = deriveKek(password, s, kdf);
  const nonce = randomBytes(12);
  const ct = sealWithNonce(kek, nonce, hexToBytes(ident.seedHex));
  return {
    id: ident.id,
    alg: ident.alg,
    salt: bytesToHex(s),
    kdf,
    encNonce: bytesToHex(nonce),
    privCipher: bytesToHex(ct),
  };
}

/**
 * 换设备取回：用同一口令解出私钥。密码错误与密文损坏在密码学上不可区分，
 * 统一报同一条消息（客户端判定，节点无从判断——册子 §4.2）。
 */
export function openEscrowPayload(p: EscrowPayload, password: string): Identity {
  const kek = deriveKek(password, hexToBytes(p.salt), p.kdf);
  let seedHex: string;
  try {
    seedHex = bytesToHex(openWithNonce(kek, hexToBytes(p.encNonce), hexToBytes(p.privCipher)));
  } catch {
    throw new Error("identity: 密码错误或托管密文损坏");
  }
  const ident = identityFromSeed(seedHex);
  if (ident.id !== p.id) {
    throw new Error(`identity: 解出的私钥与托管 id 不符（${ident.id} != ${p.id}）`);
  }
  return ident;
}

/**
 * 私钥导出（册子 §2.2「主动备份」）：返回可直接编成二维码 / 抄写的备份串。
 *
 * **调用即明文出设备**，只应在用户显式操作时触发；调用方负责不进日志、不被后台截图。
 * 不做助记词：BIP-39 要引入词表依赖，而 S1 的备份目的只是「换设备前把种子带走」，
 * 32 字节种子的 hex 已足够；若后续要做助记词，只改这两个函数。
 */
export function exportIdentityBackup(ident: Identity): string {
  return ident.seedHex;
}

/** 从备份串还原身份；容忍首尾空白与大小写差异（手抄/扫码的必然噪声）。 */
export function importIdentityBackup(backup: string): Identity {
  const seedHex = backup.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(seedHex)) {
    throw new Error("identity: 备份串必须是 64 位 hex 种子");
  }
  return identityFromSeed(seedHex);
}

/** 5 个签名头（册子 §3.1）。键名即线上契约。 */
export interface SignedHeaders {
  "X-Base-Id": string;
  "X-Base-Alg": string;
  "X-Base-Ts": string;
  "X-Base-Nonce": string;
  "X-Base-Sig": string;
}

/**
 * 为一次请求构造签名头。`ts` 可注入以便测试；生产不传即用当前毫秒。
 * `body` 传原始字节（不传 = 无请求体，用 `sha256("")`）。
 */
export function signRequestHeaders(
  ident: Identity,
  req: { method: string; path: string; query?: string; body?: Uint8Array },
  ts: number = Date.now(),
): SignedHeaders {
  const meta: RequestMeta = {
    method: req.method.toUpperCase(),
    path: req.path,
    query: req.query ?? "",
    bodySha256: sha256Hex(req.body ?? new Uint8Array(0)),
    ts,
    nonce: bytesToHex(randomBytes(16)),
  };
  return {
    "X-Base-Id": ident.id,
    "X-Base-Alg": ident.alg,
    "X-Base-Ts": String(meta.ts),
    "X-Base-Nonce": meta.nonce,
    "X-Base-Sig": sign(ident.seedHex, requestSignBytes(meta)),
  };
}
```

- [ ] **Step 10: 运行全部前端测试确认通过**

```powershell
Set-Location e:\code\base
npx vitest run apps/mobile packages/protocol-ts
npm run typecheck
```

Expected: `apps/mobile` 原有的 `sql.test.ts` / `sync.test.ts` 与新增 `identity.test.ts` 全部 PASS；`protocol-ts` 的 `vectors.test.ts` 与 `aead.test.ts` 全部 PASS；`typecheck` 无错误。

- [ ] **Step 11: 提交**

```bash
git -C e:/code/base add packages/protocol-ts/package.json packages/protocol-ts/package-lock.json packages/protocol-ts/src/aead.ts packages/protocol-ts/src/aead.test.ts packages/protocol-ts/src/kdf.ts packages/protocol-ts/src/hash.ts packages/protocol-ts/src/index.ts apps/mobile/src/core/identity.ts apps/mobile/src/core/identity.test.ts
git -C e:/code/base commit -m "feat(mobile): 客户端身份、AEAD/KDF 契约与签名头构造"
```

---

### Task 15: 端到端验收与文档回填

**Files:**
- Modify: `packages/protocol-ts/src/aead.test.ts`（追加黄金向量只读消费）
- Create: `vectors/v1/aead.json`
- Modify: `internal/store/crypto_test.go`（追加 `TestAEADGoldenVector`）
- Create: `internal/httpapi/s1_acceptance_test.go`
- Modify: `docs/superpowers/specs/2026-09-26-base-identity-tls-design.md`（6 处修正 + §3.2 去重）
- Modify: `docs/superpowers/specs/2026-09-25-base-distributed-learning-design.md`（L4a′ 密钥路径与目录布局）

**为什么必须先做黄金向量**：修正 7 把 AEAD 封装格式的唯一实现放在 TS 侧（`aead.ts`），节点侧是 Go。两侧格式一旦漂移，只有「跨语言读对方密文」才暴露。用 `vectors/v1/aead.json` 把字节锁死，与 `identity.json` / `reqsig.json` 同一套路——**测试只读该文件，不重新生成**，否则黄金向量就失去意义。

- [ ] **Step 1: 写 TS 侧的只读消费测试**

在 `e:\code\base\packages\protocol-ts\src\aead.test.ts` 顶部 import 区追加：

```ts
import { readFileSync } from "node:fs";

import { bytesToHex } from "./hash";
```

在 `describe("aead", ...)` 内追加：

```ts
  it("消费 vectors/v1/aead.json：seal/open 与黄金向量逐字节一致", () => {
    const raw = readFileSync(new URL("../../../vectors/v1/aead.json", import.meta.url), "utf8");
    const v = JSON.parse(raw) as {
      key_hex: string;
      nonce_hex: string;
      plaintext_hex: string;
      ciphertext_hex: string;
    };
    const key = hexToBytes(v.key_hex);
    const nonce = hexToBytes(v.nonce_hex);
    const plain = hexToBytes(v.plaintext_hex);
    expect(bytesToHex(sealWithNonce(key, nonce, plain))).toBe(v.ciphertext_hex);
    expect(bytesToHex(openWithNonce(key, nonce, hexToBytes(v.ciphertext_hex)))).toBe(v.plaintext_hex);
    // 拼接形态也必须一致：nonce || ct || tag
    expect(bytesToHex(seal(key, plain, nonce))).toBe(v.nonce_hex + v.ciphertext_hex);
  });
```

- [ ] **Step 2: 运行确认失败**

```powershell
Set-Location e:\code\base
npx vitest run packages/protocol-ts/src/aead.test.ts
```

Expected: 1 个用例 FAIL，报 `ENOENT: no such file or directory ... vectors\v1\aead.json`。

- [ ] **Step 3: 一次性生成黄金向量，然后删掉生成器**

创建临时文件 `e:\code\base\packages\protocol-ts\src\__gen_aead_vector.test.ts`：

```ts
import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sealWithNonce } from "./aead";
import { bytesToHex, hexToBytes } from "./hash";

describe("一次性生成器", () => {
  it("写 vectors/v1/aead.json", () => {
    const key = hexToBytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    const nonce = hexToBytes("0f0e0d0c0b0a090807060504");
    const plain = new TextEncoder().encode("base L4a′ 封装格式黄金向量 v1");
    const vector = {
      note:
        "封装格式 = nonce(12) || ciphertext || tag(16)；ciphertext_hex 只含 ciphertext || tag。",
      key_hex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      nonce_hex: "0f0e0d0c0b0a090807060504",
      plaintext_hex: bytesToHex(plain),
      ciphertext_hex: bytesToHex(sealWithNonce(key, nonce, plain)),
    };
    writeFileSync(
      new URL("../../../vectors/v1/aead.json", import.meta.url),
      JSON.stringify(vector, null, 2) + "\n",
    );
    expect(vector.ciphertext_hex.length).toBe((plain.length + 16) * 2);
  });
});
```

```powershell
Set-Location e:\code\base
npx vitest run packages/protocol-ts/src/__gen_aead_vector.test.ts
Get-Content e:\code\base\vectors\v1\aead.json
```

Expected: 生成器 PASS；文件含 5 个字段（`note` / `key_hex` / `nonce_hex` / `plaintext_hex` / `ciphertext_hex`）。

```powershell
Remove-Item e:\code\base\packages\protocol-ts\src\__gen_aead_vector.test.ts
```

生成器必须删除——留着它每次跑测试都会重写黄金向量。

- [ ] **Step 4: 运行 TS 消费测试确认通过**

```powershell
Set-Location e:\code\base
npx vitest run packages/protocol-ts/src/aead.test.ts
```

Expected: 6 个测试全部 PASS。

- [ ] **Step 5: Go 侧消费同一向量**

把下面内容**追加**到 `e:\code\base\internal\store\crypto_test.go`：

```go
// TestAEADGoldenVector 消费 vectors/v1/aead.json：TS 侧 aead.ts 与 Go 侧 Encrypt/Decrypt
// 必须是同一种封装格式，否则跨语言读不了对方的密文（修正 7）。
// 失败时改代码，不许改向量——向量是两侧的共同契约。
func TestAEADGoldenVector(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "aead.json"))
	if err != nil {
		t.Fatalf("读黄金向量: %v", err)
	}
	var v struct {
		KeyHex        string `json:"key_hex"`
		NonceHex      string `json:"nonce_hex"`
		PlaintextHex  string `json:"plaintext_hex"`
		CiphertextHex string `json:"ciphertext_hex"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("解析黄金向量: %v", err)
	}

	dir := t.TempDir()
	if err := os.WriteFile(defaultStoreKeyPath(dir), []byte(v.KeyHex+"\n"), 0o600); err != nil {
		t.Fatalf("预置密钥: %v", err)
	}
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()

	if got := st.StoreKeyHex(); got != v.KeyHex {
		t.Fatalf("密钥 = %s, want %s", got, v.KeyHex)
	}

	nonce, err := hex.DecodeString(v.NonceHex)
	if err != nil {
		t.Fatalf("nonce 不是 hex: %v", err)
	}
	if len(nonce) != gcmNonceSize {
		t.Fatalf("向量 nonce 长度 = %d, want %d", len(nonce), gcmNonceSize)
	}
	plain, err := hex.DecodeString(v.PlaintextHex)
	if err != nil {
		t.Fatalf("plaintext 不是 hex: %v", err)
	}
	wantCT, err := hex.DecodeString(v.CiphertextHex)
	if err != nil {
		t.Fatalf("ciphertext 不是 hex: %v", err)
	}

	// 同 nonce 下 Go 的封装必须逐字节等于 TS 的 ciphertext||tag。
	if got := st.aead.Seal(nil, nonce, plain, nil); !bytes.Equal(got, wantCT) {
		t.Fatalf("Go 封装与 TS 不一致:\n got %x\nwant %x", got, wantCT)
	}
	// 反向：Go 必须能解开 TS 的密文。
	gotPlain, err := st.aead.Open(nil, nonce, wantCT, nil)
	if err != nil {
		t.Fatalf("Go 解 TS 密文失败: %v", err)
	}
	if !bytes.Equal(gotPlain, plain) {
		t.Fatalf("解出的明文不一致:\n got %x\nwant %x", gotPlain, plain)
	}
	// 完整拼接形态 nonce || ct || tag（与 TS 的 seal 一致）：Encrypt 自带随机 nonce，
	// 故只比对 nonce 之后的 ct||tag，长度也必须与向量一致。
	gotBlob, err := st.Encrypt(plain)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if want := gcmNonceSize + len(wantCT); len(gotBlob) != want {
		t.Fatalf("封装长度 = %d, want %d", len(gotBlob), want)
	}
	if !bytes.Equal(gotBlob[gcmNonceSize:], wantCT) {
		t.Fatalf("Encrypt 的 ct||tag 与向量不一致:\n got %x\nwant %x", gotBlob[gcmNonceSize:], wantCT)
	}
}
```

- [ ] **Step 6: 运行 Go 向量测试**

```powershell
Set-Location e:\code\base
go test ./internal/store/ -run TestAEADGoldenVector -v
```

Expected: PASS。

- [ ] **Step 7: 写 S1 验收测试**

创建 `e:\code\base\internal\httpapi\s1_acceptance_test.go`：

```go
package httpapi

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// s1Node 是册子 §10 验收用的单节点——走真实 Handler()，不手搭 mux，
// 因此路由总装、CORS、中间件挂载位置也一并被验收覆盖。
type s1Node struct {
	data string
	st   *store.Store
	srv  *Server
	url  string
}

// newS1Node 起一个节点，并把 seed 对应的身份预登记（否则签名请求会撞 403 identity_unregistered）。
func newS1Node(t *testing.T, seed string) *s1Node {
	t.Helper()
	data := t.TempDir()
	st, err := store.Open(data, store.WithStoreKey(identityTestStoreKey))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	srv, err := New(st, Options{Issuer: "base-node-1", SignKeyHex: seed, Version: "test"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	n := &s1Node{data: data, st: st, srv: srv, url: ts.URL}

	if seed != "" {
		id, pub := identityFromSeed(t, seed)
		if status, body := doIdentityJSON(t, http.MethodPost, n.url+"/v1/identity/register", "", registerBody(id, pub)); status != http.StatusOK {
			t.Fatalf("预登记 status=%d body=%v", status, body)
		}
	}
	return n
}

func flipFirstHexChar(s string) string {
	if s == "" {
		return "0"
	}
	if s[0] == '0' {
		return "1" + s[1:]
	}
	return "0" + s[1:]
}

func errCode(t *testing.T, body map[string]any) string {
	t.Helper()
	v, ok := body["code"].(string)
	if !ok {
		t.Fatalf("错误体缺少 code 字段: %v", body)
	}
	return v
}

// 验收 1：跨节点身份。A 节点登记 → B 节点（无共享状态）取到同一公钥并验签通过。
func TestS1Acceptance01CrossNodeIdentity(t *testing.T) {
	a := newS1Node(t, testSeed)
	b := newS1Node(t, "")
	b.srv.knownEventTypes = map[string]struct{}{"ping": {}}

	clientSeed := strings.Repeat("11", 32)
	id, pub := identityFromSeed(t, clientSeed)

	for name, n := range map[string]*s1Node{"A": a, "B": b} {
		if status, body := doIdentityJSON(t, http.MethodPost, n.url+"/v1/identity/register", "", registerBody(id, pub)); status != http.StatusOK {
			t.Fatalf("%s 登记 status=%d body=%v", name, status, body)
		}
	}

	status, body := doIdentityJSON(t, http.MethodGet, b.url+"/v1/identity/"+id, "", "")
	if status != http.StatusOK {
		t.Fatalf("B 取公钥 status=%d body=%v", status, body)
	}
	if body["pubkey"] != pub || body["id"] != id || body["alg"] != "ed25519" {
		t.Fatalf("B 返回字段不符: %v", body)
	}

	req := signedRequest(t, clientSeed, http.MethodPost, b.url+"/v1/event", `{"type":"ping","body":{}}`)
	if status, body := sendAuth(t, req); status != http.StatusOK {
		t.Fatalf("B 验签 status=%d body=%v（应通过）", status, body)
	}
}

// 验收 2：篡改拒绝。签名改 1 bit → 401 auth_bad_signature。
func TestS1Acceptance02TamperRejected(t *testing.T) {
	n := newS1Node(t, testSeed)
	req := signedRequest(t, testSeed, http.MethodGet, n.url+"/v1/me", "")
	req.Header.Set("X-Base-Sig", flipFirstHexChar(req.Header.Get("X-Base-Sig")))
	status, body := sendAuth(t, req)
	if status != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%v, want 401", status, body)
	}
	if got := errCode(t, body); got != "auth_bad_signature" {
		t.Fatalf("code=%s, want auth_bad_signature", got)
	}
}

// 验收 3：重放拒绝。同一 nonce 二次提交 → 401 auth_nonce_replay。
func TestS1Acceptance03NonceReplay(t *testing.T) {
	n := newS1Node(t, testSeed)
	first := signedRequest(t, testSeed, http.MethodGet, n.url+"/v1/me", "")
	if status, body := sendAuth(t, first); status != http.StatusOK {
		t.Fatalf("首次 status=%d body=%v", status, body)
	}
	replay := signedRequest(t, testSeed, http.MethodGet, n.url+"/v1/me", "")
	copyAuthHeaders(first, replay)
	status, body := sendAuth(t, replay)
	if status != http.StatusUnauthorized {
		t.Fatalf("重放 status=%d body=%v, want 401", status, body)
	}
	if got := errCode(t, body); got != "auth_nonce_replay" {
		t.Fatalf("code=%s, want auth_nonce_replay", got)
	}
}

// 验收 4：时间窗。ts 偏移 10 分钟（两个方向）→ 401 auth_ts_out_of_window。
func TestS1Acceptance04TimestampWindow(t *testing.T) {
	n := newS1Node(t, testSeed)
	for name, ts := range map[string]int64{
		"过旧": time.Now().Add(-10 * time.Minute).UnixMilli(),
		"过新": time.Now().Add(10 * time.Minute).UnixMilli(),
	} {
		req := signedRequestAt(t, testSeed, http.MethodGet, n.url+"/v1/me", "", ts)
		status, body := sendAuth(t, req)
		if status != http.StatusUnauthorized {
			t.Fatalf("%s status=%d body=%v, want 401", name, status, body)
		}
		if got := errCode(t, body); got != "auth_ts_out_of_window" {
			t.Fatalf("%s code=%s, want auth_ts_out_of_window", name, got)
		}
	}
}

// 验收 5：未登记拒绝。未登记 id 发起写请求 → 403 identity_unregistered。
func TestS1Acceptance05UnregisteredRejected(t *testing.T) {
	n := newS1Node(t, testSeed)
	req := signedRequest(t, strings.Repeat("22", 32), http.MethodGet, n.url+"/v1/me", "")
	status, body := sendAuth(t, req)
	if status != http.StatusForbidden {
		t.Fatalf("status=%d body=%v, want 403", status, body)
	}
	if got := errCode(t, body); got != "identity_unregistered" {
		t.Fatalf("code=%s, want identity_unregistered", got)
	}
}

// 验收 6：id 自证。id 与 sha256(pubkey)[0:32] 不符 → 400 identity_id_mismatch。
func TestS1Acceptance06IDSelfProving(t *testing.T) {
	n := newS1Node(t, testSeed)
	_, pub := identityFromSeed(t, testSeed)
	badID := strings.Repeat("00", 16)
	status, body := doIdentityJSON(t, http.MethodPost, n.url+"/v1/identity/register", "", registerBody(badID, pub))
	if status != http.StatusBadRequest {
		t.Fatalf("status=%d body=%v, want 400", status, body)
	}
	if got := errCode(t, body); got != "identity_id_mismatch" {
		t.Fatalf("code=%s, want identity_id_mismatch", got)
	}
}

// 验收 7：密码托管闭环（节点侧）。签名上传 → 匿名取回 → 字段原样返回。
// 「用密码解得同一 id / 错误密码解得失败」是客户端行为，由 apps/mobile 的 identity.test.ts 覆盖。
func TestS1Acceptance07EscrowRoundTrip(t *testing.T) {
	n := newS1Node(t, testSeed)
	id, _ := identityFromSeed(t, testSeed)

	req := signedRequest(t, testSeed, http.MethodPut, n.url+"/v1/identity/escrow/alice", escrowBody(id))
	if status, resp := sendAuth(t, req); status != http.StatusOK {
		t.Fatalf("上传 status=%d resp=%v", status, resp)
	}

	status, got := doIdentityJSON(t, http.MethodGet, n.url+"/v1/identity/escrow/alice", "", "")
	if status != http.StatusOK {
		t.Fatalf("取回 status=%d body=%v", status, got)
	}
	if got["id"] != id || got["alg"] != "ed25519" {
		t.Fatalf("取回 id/alg 不符: %v", got)
	}
	if got["salt"] != strings.Repeat("cd", 16) || got["enc_nonce"] != strings.Repeat("ef", 12) {
		t.Fatalf("节点必须原样返 salt/enc_nonce: %v", got)
	}
	if got["priv_cipher"] != strings.Repeat("ab", 48) {
		t.Fatalf("节点必须原样返 priv_cipher（只存不解释）: %v", got["priv_cipher"])
	}
}

// 验收 8：escrow 冲突。同 username 换 id 写入 → 409 escrow_conflict。
func TestS1Acceptance08EscrowConflict(t *testing.T) {
	n := newS1Node(t, testSeed)
	idA, _ := identityFromSeed(t, testSeed)
	if status, resp := sendAuth(t, signedRequest(t, testSeed, http.MethodPut, n.url+"/v1/identity/escrow/bob", escrowBody(idA))); status != http.StatusOK {
		t.Fatalf("首次上传 status=%d resp=%v", status, resp)
	}

	seedB := strings.Repeat("33", 32)
	idB, pubB := identityFromSeed(t, seedB)
	if status, body := doIdentityJSON(t, http.MethodPost, n.url+"/v1/identity/register", "", registerBody(idB, pubB)); status != http.StatusOK {
		t.Fatalf("登记 B status=%d body=%v", status, body)
	}
	status, body := sendAuth(t, signedRequest(t, seedB, http.MethodPut, n.url+"/v1/identity/escrow/bob", escrowBody(idB)))
	if status != http.StatusConflict {
		t.Fatalf("status=%d body=%v, want 409", status, body)
	}
	if got := errCode(t, body); got != "escrow_conflict" {
		t.Fatalf("code=%s, want escrow_conflict", got)
	}
}

// 验收 11（新增，守修正 4）：密钥文件必须在 data 目录之外。
func TestS1Acceptance11StoreKeyOutsideDataDir(t *testing.T) {
	n := newS1Node(t, testSeed)
	keyPath := defaultStoreKeyPath(n.data)
	if _, err := os.Stat(keyPath); err != nil {
		t.Fatalf("密钥文件应存在于 %s: %v", keyPath, err)
	}
	if _, err := os.Stat(filepath.Join(n.data, "store.key")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("密钥文件不得落在 data 目录内——cp -r data 会连密钥一起拷走")
	}
}

// 验收 13（新增，守 §7.3 不变量 2）：blob 接口返回明文，长度不得暴露封装长度。
func TestS1Acceptance13BlobPlaintextOverWire(t *testing.T) {
	n := newS1Node(t, testSeed)
	plain := []byte("S1-ACCEPTANCE-PLAINTEXT-内容-0123456789")
	blobID := protocol.BlobID(plain)
	if err := n.st.PutBlob(blobID, plain); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}

	res, err := http.Get(n.url + "/v1/blob/" + blobID)
	if err != nil {
		t.Fatalf("GET blob: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	got, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("GET blob 必须返回明文，got %d 字节", len(got))
	}
	if len(got) != len(plain) {
		t.Fatalf("明文长度 = %d, want %d（不得暴露封装长度）", len(got), len(plain))
	}
}
```

**验收 9 / 10 / 12 不在此文件重复**：
- 9（TLS 指纹）→ `TestPeerVerifierHandshake` + `TestClientTLSConfigPinsFingerprint`（Task 12）
- 10（L4a′ 落盘断言）→ `assertPlaintextAbsent`（Task 6 / 7 / 8）
- 12（`catalog` / `manifest` / `pack` 与加密前逐字节一致）→ Task 7 / 8 的既有断言

- [ ] **Step 8: 运行验收测试**

```powershell
Set-Location e:\code\base
go test ./internal/httpapi/ -run 'TestS1Acceptance' -v
```

Expected: 9 个测试全部 PASS。

- [ ] **Step 9: 全量回归（P0 与 S1 都要绿）**

```powershell
Set-Location e:\code\base
go build ./...
go test ./...
npm test
npm run typecheck
```

Expected: Go 全包 `ok`；npm workspaces 测试全绿；typecheck 无错。

- [ ] **Step 10: 双节点人工验收（运维视角）**

```powershell
Set-Location e:\code\base
$a = Start-Process -PassThru -NoNewWindow go -ArgumentList 'run','./cmd/based','serve','-data','nodeA','-addr','127.0.0.1:18081'
$b = Start-Process -PassThru -NoNewWindow go -ArgumentList 'run','./cmd/based','serve','-data','nodeB','-addr','127.0.0.1:18082'
Start-Sleep -Seconds 8
(go run ./cmd/based tls-cert show -data nodeA) | Select-String 'pairing_code'
(go run ./cmd/based tls-cert show -data nodeB) | Select-String 'pairing_code'
Stop-Process -Id $a.Id,$b.Id -Force -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force nodeA,nodeB,nodeA.key,nodeB.key -ErrorAction SilentlyContinue
```

Expected: 两节点各自打印**不同**的配对码（自签证书独立，绝不共用）；`nodeA.key` / `nodeB.key` 位于仓库根，不在 `nodeA/` / `nodeB/` 内。

- [ ] **Step 11: 文档回填——S1 册子**

逐条改 `docs/superpowers/specs/2026-09-26-base-identity-tls-design.md`：

| # | 定位 | 现状 | 改成 |
|---|---|---|---|
| 1 | §3.2 末段 | 同一句「固定向量写入 `vectors/v1/reqsig.json`（…），Go 与 TS 两侧测试同时消费。」**连续出现两次** | 删掉多余的一次（去重） |
| 2 | §7.1 密钥来源 | `BASE_STORE_KEY`（hex64）→ `data/store.key`（0600）→ 两者皆无则首启自动生成 | 改为四级优先级：`WithStoreKey`（代码/测试）→ `BASE_STORE_KEY` → `BASE_STORE_KEY_FILE` → 默认文件 **`<data>.key`（data 目录的兄弟文件，刻意置于 data 之外）** 0600，首启自动生成；补残余风险：备份**整个安装目录**仍可解密，只有 env 注入能根除 |
| 3 | §7.2 表格 | `data/base.db` 的 `articles.body_md` / `segments.text` / `quizzes.question_json`，处理列写「逐列封装，列值以 hex 文本存」 | 只列 `articles.body_md`（`segments` / `quizzes` 在 P0 只有 DDL、无任何读写代码路径，无实现位置）；处理列改为「逐列封装，列值以 **`enc:v1:` 前缀 + base64** 存，便于识别历史明文行」 |
| 4 | §10 验收表 | 10 条 | 追加 **11** 密钥文件位于 data 目录之外；**12** `catalog` / `manifest` / `pack` 输出与加密前逐字节一致；**13** `GET /v1/blob/{blob_id}` 返回明文且长度 = `blobs.size` |
| 5 | §8 表格下第一条 | `kek_source` 记录 KEK 来源，供 spike 结论回填 | 补 S1 期实际取值：随机 32 字节存应用私有存储，`kek_source = "device"`；**明写残余风险**（与密文同库，不抗 root/越狱本地读取），注明 spike 落地后只替换 `deviceKek()` 实现、调用契约不变 |
| 6 | §6.1 与 §1 | 假定客户端能接受自签证书 | **已定案 F1（2026-09-26）**：改为「客户端↔节点走 HTTP + 签名头，TLS 只保节点↔节点」，并同步总纲 §0.1 改版说明、§4「传输」行、§12.2 |

- [ ] **Step 12: 文档回填——总纲**

逐条改 `docs/superpowers/specs/2026-09-25-base-distributed-learning-design.md`：

| # | 定位 | 改成 |
|---|---|---|
| 1 | §12.1.1 L4a′ 密钥路径 | 与 Step 11 第 2 条一致（`<data>.key`，刻意置于 data 之外；四级优先级 + 残余风险） |
| 2 | §7.2 目录布局 | 目录树中把 L4a′ 密钥标注为 `data.key`（与 `data/` 同级），加注「不在 data 目录内」 |
| 3 | §8.2 手机本地库加密 | `kek_source` 补 S1 期取值与残余风险，与 Step 11 第 5 条一致 |

- [ ] **Step 13: 提交**

```bash
git -C e:/code/base add vectors/v1/aead.json packages/protocol-ts/src/aead.test.ts internal/store/crypto_test.go internal/httpapi/s1_acceptance_test.go docs/superpowers/specs/2026-09-26-base-identity-tls-design.md docs/superpowers/specs/2026-09-25-base-distributed-learning-design.md
git -C e:/code/base commit -m "test: S1 端到端验收与规格回填"
```

---

## 计划自检（spec 覆盖 / 占位符 / 类型一致性）

### 1. spec 覆盖：册子每一节 → 落地任务

| 册子节 | 任务 | 状态 |
|---|---|---|
| §2.1 id 派生（不可变契约） | Task 2（`deriveIdentityId` / `IdentityID`）+ `vectors/v1/identity.json` | 覆盖 |
| §2.2 客户端密钥生命周期（生成/使用/本地存储） | Task 14（`createIdentity` / `saveLocalIdentity` / `loadLocalIdentity`） | 覆盖 |
| §2.2 主动备份（助记词或二维码） | Task 14（`exportIdentityBackup` / `importIdentityBackup`，二维码编码由调用方负责） | 覆盖 |
| §2.2 换设备取回 / 丢失不可找回 | Task 14（`openEscrowPayload`）；「不可找回」是模型前提，无代码 | 覆盖 |
| §2.3 节点只登记公钥 | Task 5（`RegisterIdentity` / `LookupIdentity`）+ Task 9 | 覆盖 |
| §3.1 签名头与待签字节 | Task 3（`RequestSignBytes`）+ Task 10（解析）+ Task 14（构造）+ `vectors/v1/reqsig.json` | 覆盖 |
| §3.2 验签 7 步（顺序固定、先验后读体） | Task 10（`requireAuth`）+ Task 5（`UseNonce` / `PruneNonces`） | 覆盖 |
| §3.3 错误体（`writeError` 不变 + `writeAuthErr`） | Task 10 | 覆盖 |
| §4.1 客户端侧加密 | Task 14（`kdf.ts` + `aead.ts` + `buildEscrowPayload`） | 覆盖 |
| §4.2 节点侧契约（只存不解释、username 约束、写入规则、匿名读取 + 限速） | Task 5（`PutEscrow` / `GetEscrow`）+ Task 9（`validUsername` / `ipLimiter`） | 覆盖 |
| §4.3 失联代价写进隐私政策与 App 首次引导 | **不在本计划** | 见下方「明确不覆盖」 |
| §5.1–§5.6 六个接口 | Task 9（身份 5 个）+ Task 11（事件 1 个）+ Task 11 Step 3（路由总装） | 覆盖 |
| §6.1 自签 + 指纹固定 + 配对码 + 无忽略开关 | Task 12（`LoadOrCreateTLSCert` / `PeerVerifier` / `ClientTLSConfig`）+ Task 13（首页展示） | 覆盖 |
| §6.2 换证书（`rotate` 后全部重新配对） | Task 13（`tls-cert rotate`）| 覆盖 |
| §6.3 节点↔节点（`BASE_PEERS` + `X-Base-Node-Key`） | Task 12（`requireNodeKey`）+ Task 13（peer 监听 + `-peers` / `-node-key`） | 覆盖 |
| §7.1 密钥与封装（AES-256-GCM、密钥优先级） | Task 6 + 修正 4 + 修正 7（TS 侧同一格式）+ `vectors/v1/aead.json` | 覆盖 |
| §7.2 加密范围 | Task 7（blobs）+ Task 8（`articles.body_md`）；其余各行均为「不加密」，由 Task 7/8 的断言守住 | 覆盖 |
| §7.3 落点与不变量 | Task 7/8（透明封装、零上层改动、明文 `blob_id`）+ Task 15 验收 11/12/13 | 覆盖 |
| §7.4 已知代价 | 文档项，Task 15 Step 11 回填 | 覆盖 |
| §7.5 不做密钥轮换 | 无任务（明确不做） | 正确 |
| §8 手机端身份与私钥存放（`identity` 表） | Task 14（`StorageAdapter` 上的等价表示）+ 修正 8 | 覆盖 |
| §8 手机端 `nodes` 表（已配对节点与固定指纹） | **F1 下不做（2026-09-26 定案）** | 见下方「明确不覆盖」 |
| §9 交汇点 1（格式/算法/参数一致） | `aead.ts` 唯一实现 + `vectors/v1/aead.json` 双侧消费 | 覆盖 |
| §9 交汇点 2（KEK 来源结论回填） | 修正 8 记录 S1 期取值；最终结论回填册子 §8 | 部分覆盖（结论待 spike） |
| §9 交汇点 3（开关语义：全量重写 + 校验 + 旧文件安全删除） | 属 spike(#4) 范围 | 见下方「明确不覆盖」 |
| §10 验收 1–10 | Task 15（1–8、11、13 自动化；9、10、12 引用既有断言） | 覆盖 |

### 2. 明确不覆盖（避免"看起来都做了"）

1. **§4.3 文案与首次引导**：`apps/mobile/src/pages/` 下没有引导页，隐私政策也不是代码产物。本计划的文件结构表里没有它们的位置，硬塞会破坏「每个 Task 产出可独立测试的软件」。S1 完成后单开一个小任务（或并入 B 阶段册子）。
2. **§8 `nodes` 表与配对流程**：它存在的前提是「客户端能对节点做 TLS 指纹固定」。**2026-09-26 已定案 F1（客户端↔节点走 HTTP + 签名头）→ 没有客户端侧指纹可存，这张表不做**。节点指纹只存在于节点侧 `BASE_PEERS` 白名单。
3. **§9 交汇点 3（本地库加密开关）**：册子 §9 自己写明属 spike(#4) 的退路，本节只负责「格式与算法一致」（交汇点 1）。开关切换的全量重写与旧文件安全删除在 spike 里做。

### 3. 占位符扫描

已按 writing-plans 的「No Placeholders」清单扫全文：

| 模式 | 命中 |
|---|---|
| `TBD` / `TODO` / `待补` / `后面再定` | 0 |
| 「类似 Task N」式省略（不重复代码） | 0 |
| 「适当处理错误」/「加校验」/「处理边界」无代码 | 0 |
| 引用未在任何 Task 中定义的类型/函数 | 0 |

每处代码步骤都给了完整可粘贴内容与精确命令、期望输出。

### 4. 类型一致性

| 契约 | 定义处 | 使用处 | 一致性 |
|---|---|---|---|
| `Options.FingerprintHex` / `Options.PairingCode`（扁平，非嵌套 `TLS`） | Task 12 Step 4 | Task 13 Step 7（`serve.go`）、Step 9（`web.go`）、头部文件结构表 | 一致 |
| `TLSInfo{CertFile, KeyFile, FingerprintHex, PairingCode}` | Task 12 Step 3 | Task 13 Step 6（`tlscert.go`）、Step 7 | 一致 |
| `StoreKeyStatus(dataDir string, opts ...Option) (path, hexKey string, exists bool, err error)` | Task 13 Step 3 | Task 13 Step 1 测试、Step 5（`storekey.go`） | 一致（4 个返回值顺序一致） |
| `defaultStoreKeyPath(dataDir) = dataDir + ".key"` | Task 6 | Task 13 Step 1、Task 15 验收 11 | 一致 |
| `gcmNonceSize` / `gcmTagSize` / `encPrefix` | Task 6 | Task 7/8/15 | 一致 |
| `RequestMeta{method, path, query, bodySha256, ts, nonce}` | Task 3 | Task 10（Go）、Task 14（TS）、Task 15 helper | 一致（Go 导出名 `BodySHA256`，TS 驼峰，JSON 键 `body_sha256`） |
| `KdfParams{alg, m, t, p, len}` + `DEFAULT_KDF` | Task 14 Step 4（`kdf.ts`） | Task 14 Step 9（`identity.ts`）、册子 §5.3 的 `kdf` 字段 | 一致 |
| `EscrowPayload{id, alg, salt, kdf, encNonce, privCipher}` | Task 14 Step 9 | 册子 §5.3 请求体（JSON 键 `enc_nonce` / `priv_cipher`，见 Task 9 解析） | 一致 |
| `identityFromSeed(t, seed) (id, pub string)`（httpapi 测试 helper） | Task 4 | Task 10 / 12 / 13 / 15 测试 | 一致 |
| `requireAuth(next http.HandlerFunc) http.Handler` | Task 10 | Task 11 Step 3 路由总装 | 一致 |
| `withIdentity` / `identityFrom`（`ctxKeyIdentity`） | Task 9 | Task 10 Step 3、Task 11 | 一致 |

### 5. P0 兼容性（不能破坏既有验收）

| 项 | 做法 |
|---|---|
| 既有错误体 | `writeError` 原样保留 `{"error": "..."}`；新错误码只走 `writeAuthErr`（Task 10） |
| 既有路由 | Task 11 只在 `Handler()` 末尾追加 6 条，不改既有 9 条的语义 |
| 既有 CORS | `withCommon` 只**扩大**允许的方法与头，不删除既有值 |
| 既有测试 | `store_test.go` 的 `openTemp` 由 `Open(t.TempDir())` 改为注入固定测试密钥（Task 6），行为不变 |
| `internal/packexport` / `internal/sync` | 零改动；`pack` 不复制 blob 字节，故无密文外溢 |

---

## 执行记录（2026-09-26，Task 0–15 全部落地）

本计划 15 个 Task 已全部实现并提交。以下是**与计划原文的偏离项**（计划代码照抄会编译不过或断言必假，均已按实际契约修正）：

| 位置 | 计划原文 | 实际做法与原因 |
|---|---|---|
| Task 12 `ClientTLSConfig` | `ClientTLSConfig(info, fp) *tls.Config` | 改为 `ClientTLSConfig(own TLSInfo, peerFingerprintHex string) (*tls.Config, error)`：对端 `RequireAnyClientCert` 会直接拒绝不带证书的客户端，故必须加载本节点证书；生产证书可能加载失败，故返回 error |
| Task 13 子命令 flag | `fs.Parse(args)` 后取 `fs.Arg(0)` 当子命令 | Go 的 flag 包遇首个非 flag 参数即停止解析，`store-key show -data x` 的 `-data` 会被静默忽略并泄漏式地在仓库根生成 `data.key`。改为先取 `args[0]` 为子命令、再 `fs.Parse(args[1:])`，并拒绝多余位置参数 |
| Task 14 签名头 nonce | 测试断言 `toHaveLength(24)` | 服务端契约是 `X-Base-Nonce 必须是 16 字节 hex`（32 hex 字符），故断言改为 32；GCM 的 12 字节 nonce 与它不是一回事 |
| Task 15 Go 向量测试 | 断言 `Encrypt` 的 `ct‖tag` 等于向量的 `ct‖tag` | GCM 密文与 nonce 绑定，`Encrypt` 自带随机 nonce，该断言必假。改为：同 nonce 下 `st.aead.Seal` 逐字节对齐向量；`Encrypt` 只锁长度与往返；再正向把 TS 的 `nonce‖ct‖tag` 喂给 `Decrypt` |
| Task 15 验收 1 | 事件体 `{"type":"ping","body":{}}` | `handleEventPost` 要求 `event_id`（16 字节 hex）与 `created_at > 0`，故补 `eventBody()` helper |
| Task 15 验收 6 / 8 | 断言 `code` 字段 | 这两个错误由既有 `writeError` 输出，按契约 §3.3 只有 `{"error": ...}`；带 `code` 的只有 `writeAuthErr` 的验签类错误 |
| Task 15 验收 11 | `defaultStoreKeyPath(n.data)` + 用 `WithStoreKey` 起的节点 | ① `defaultStoreKeyPath` 是 `store` 包私有函数，跨包改用公开的 `StoreKeyStatus`；② `WithStoreKey` 不落密钥文件，故该用例单独 `Open` 走「首启自动生成」路径，并自行清理兄弟文件 |
| Task 15 验收 13 | `n.st.PutBlob(blobID, plain)` | `PutBlob(blobID, data, itemID, seq)` 是四参数 |
| Task 15 Step 7 | `httptest.NewServer(srv.Handler())` | 本机同进程回环 TCP 不可用（见「已核实的环境事实」），改用 `newInprocServer` |
| Task 15 Step 10 双节点验收 | 起两个 serve + `tls-cert show` | 已执行（`dist/based.exe`，18081/18082）：配对码 `FAJS-EFKQ-O76F-73E5` ≠ `2ALR-75AI-QQAZ-IMEO`，`nodeA.key` / `nodeB.key` 均在仓库根、不在 `nodeA/` / `nodeB/` 内 |
| Task 1 spike | 需真机/ROM 验证客户端自签 TLS | **未执行，2026-09-26 直接定案 F1**（本机无可验设备；三条退路的比较不依赖实测结果，且 `SPIKE_SUCCESS` 也等于无 pinning）。总纲 §0.1 + §4/§10/§11/§12.1/§12.2、册子 §1/§6.1/§8/§10/§11/§12/§13 已回填；生产双节点真机验证通过 |
| Task 15 Step 11/12 回填 | 6 条 + 3 条 | 另修同源残留：册子 §3.2 重复句、§11 红线重复编号 2、§7.1「首启打印离线恢复码」（实际只回显前 8 hex，全量走 `based store-key show`）、§12 已确认项与总纲 §12.1.1 加密范围（只 `articles.body_md`） |

**验证**：`go build ./...` + `go test ./...` 全包 ok（含 10 个 `TestS1Acceptance*` 与 `TestAEADGoldenVector`）；`npx vitest run apps/mobile packages/protocol-ts` 73/73 PASS；`npm run typecheck` 无错。
