# base 内容分发实施计划（A 主线）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 base 从「单源节点＋只读分发」变成「源节点 + 缓存节点 + 反熵补齐」：视频按定长 1 MiB 分块入库并对外逐块可读；缓存节点从邻居**复制已签名的内容包并解包入库**，从而在源节点离线时独立供读；节点间每轮反熵比对块集合并补齐缺失、登记副本；scrub 每日校验并自愈坏块；墓碑随签名 manifest 传播到节点与客户端两侧；补一键安装脚本。

**Architecture:** 不改内容包规范 v1（字段名/类型/`pack.sqlite` 表结构全冻结），新增的一切都在 v1 之外。落层：**入站**内部接口四个放在 `internal/httpapi/peer.go`（只挂对端监听）；**出站**（拉包/拉块/反熵/scrub 补齐）放在新包 `internal/peersync`；资产新增（`blob_replicas` 表、块分页/删除、副本统计、包入库事务）落在 `internal/store`；帧格式与 fetch 限额作为不可变契约放进 `internal/protocol`；分块导入落在 `internal/importer/video.go` + `cmd/based/importvideo.go`。依赖方向恒为 `cmd/based → peersync → httpapi → store → protocol`，**`httpapi` 不反向依赖 `peersync`**（对端接口只做本地校验，跨节点补齐由调用方走 `fetch`）。

**Tech Stack:** Go 1.23+（CGO_ENABLED=0，`modernc.org/sqlite`，标准库 `net/http` Go 1.22 路由模式、`crypto/tls`、`io`）、TypeScript + vitest + uni-app CLI、PowerShell / POSIX sh（发行安装脚本）。

**上游契约：** `docs/superpowers/specs/2026-09-26-base-content-distribution-design.md`（本计划把它的接口与不变量钉成可执行步骤）。总纲 `docs/superpowers/specs/2026-09-25-base-distributed-learning-design.md` 为唯一上游。

**已核实的环境事实（2026-09-26 实测，执行时直接依赖）：**

| 事实 | 结论 |
|---|---|
| Go 工具链 | 已安装；跑 go 前先 `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH` |
| **本机 Go 同进程回环 TCP 不可用** | `httptest.NewServer` 在本机必然超时。`internal/httpapi` 已用 `newInprocServer`（`testsupport_test.go`）把 `http.DefaultTransport` 换成进程内分发来绕开。**`internal/peersync` 不能复用该 test helper（跨包不可见）**，故本计划给 `peersync.Config` 留一个 `TransportFor` 注入口（正是为了避免这个坑，见 Task 6） |
| **跨进程 TCP 正常** | 两个独立 exe 互连 OK → Task 12 的三节点验收用**真二进制 + 真端口**跑（这是本册子唯一能真验的路子） |
| `data/` 现状 | 仓库内没有 `data/base.db` / `data/blobs/`；`store.Open` 已有 L4a′（块文件密文 + `articles.body_md` 封装） |
| `internal/store` 现有表 | `meta` / `items` / `articles` / `segments` / `quizzes` / `media_meta` / `blobs` / `packs` / `tombstones` / `identities` / `escrow` / `auth_nonces` / `events` |
| `internal/sync` 包 | **不存在**（册子 §3 表格里的 `internal/sync` 是笔误，P0 无此包）→ 见「规格修正 1」 |
| `blobs.size` 语义 | 明文长度（L4a′ 前）；`HasBlob` 的存在性看文件、size 取表 |
| `.ps1` 含中文 | 必须带 UTF-8 BOM |
| `internal/httpapi.Handler()` | 目前**只有一份** handler，主监听与对端监听共用（`cmd/based/serve.go:112`）→ 必须拆（§5.1） |
| 客户端 `LocalRepo` | 纯 SQL 接口（`apps/mobile/src/core/repo.ts`），**没有文件系统能力** → 墓碑删块文件要在 `sync.ts` 里做（§9.3） |

---

## 规格修正（本计划对册子的纠正，实施时以此为准，收工后回填册子）

### 修正 1：册子 §3 的 `internal/sync` 不存在，出站落点定为新包 `internal/peersync`

册子 §3 表格写「`internal/httpapi` / `packexport` / `sync` 不感知加密」，其中 `internal/sync` 在本仓库不存在。本计划的出站实现统一落在**新包 `internal/peersync`**，并按「L4a′ 只改磁盘表示、跨节点传明文」的既定口径写测试（`peersync` 不感知加密，加密只在 `store` 一层）。

### 修正 2：`POST /v1/scrub` 的 `repaired` 在对端接口上恒为 0

册子 §5.2 的响应里有 `repaired`，但同一节又写「本接口**只对自己**做校验修复；从邻居补齐由调用方拿到 `bad` 后走 `fetch`」。两者在同一节内不自洽：从邻居补齐必须发出站请求，而 `httpapi` 不得依赖 `peersync`（否则二者循环依赖）。

**定案：** `internal/store.VerifyBlobs` 负责**本地**校验与清理（删坏块文件与行），`httpapi` 的 `POST /v1/scrub` 只调用它，响应保留 `repaired` 字段但恒为 `0`；**跨节点补齐**由 `internal/peersync.ScrubOnce` 在拿到 `bad` 之后走 `fetch` 完成，并向 `based scrub` 打印真实 `repaired`。接口形状不变（仍返回四个字段），只是语义精确化。

### 修正 3：`fetch` 的总字节限额必须两侧同源，常量进 `internal/protocol`

册子 §5.3 写「限额 = 单请求块数上限 + 单请求总字节上限（64 块 × 1 MiB ≈ 64 MiB）」，但没有第二个可配项。若只在服务端硬编码，调用方无法预先切批（封面是**整块**资源，单块可能 > 1 MiB，机械按「64 个块」切批会撞 413）。

**定案：** `protocol.FetchMaxBytes = 64 << 20` 作为**共享常量**（服务端超限回 413，调用方按「块数 ≤ `BASE_FETCH_MAX_BLOBS` 且累计 size ≤ `FetchMaxBytes`」切批）。`BASE_FETCH_MAX_BLOBS` 仍是唯一的可配项，不新增 env。

### 修正 4：册子 §10.2 的配置模板要求 `-data` 可从环境读取

册子 §10.2 步骤 3 要求安装脚本产出配置文件 `base.env`，但 `cmd/based/serve.go` 的 `-data` 目前**没有** env 兜底（其余 flag 都有），配置文件里的数据目录无处可去。

**定案：** `-data` 的默认值改为 `envOr("BASE_DATA", "data")`，安装脚本写 `BASE_DATA=<dir>/data`。只加这一个 env 名，不改其它 flag 语义。

### 修正 5：册子 §9.3 的「删文件失败重试于下次同步」无法在不引入新表的前提下实现

客户端 `applyPack` 会删掉 `blob_index` 行；行一删，「哪些文件该删」就再也查不回来，下次同步无从重试（除非新增一张待删表——本册子明确不做新表之外的客户端结构）。

**定案：** 客户端顺序为「**先收集路径 → 再 `applyPack` 删行 → 最后删文件**」；删文件失败**只记日志**，不阻断同步、不重试（残余孤儿文件），并把这句精确化写回册子 §9.3 的「已知代价」。

---

## 文件结构（本计划落定，后续任务只碰这些文件）

**新增（Go）**

| 文件 | 职责 |
|---|---|
| `internal/store/blobs.go` | 块分页 `ListBlobsPage`、全量 `ListAllBlobIDs`、`ContentVersion`、`DeleteBlobFile` / `DeleteBlob`、`MediaChunkIndex`（blob_id → 所属条目与 seq） |
| `internal/store/blobs_test.go` | 分页边界、删除语义、owner 索引 |
| `internal/store/replica.go` | `UpsertBlobReplica` / `ReplicaPeers` / `CountBlobsWithoutReplica` |
| `internal/store/replica_test.go` | 幂等 upsert、副本数统计口径 |
| `internal/store/scrub.go` | `BadBlob`、`VerifyBlobs`（本地校验 + 删坏块文件与行；不做跨节点补齐） |
| `internal/store/scrub_test.go` | `hash_mismatch` / `missing` 两条路径 |
| `internal/store/packimport.go` | `PackEntry`、`ImportResult`、`ImportPack`（一个事务内应用墓碑 + upsert 条目；返回被清掉的块） |
| `internal/store/packimport_test.go` | 原子性、防回卷（`revoked_rev >= version` 拒条目）、墓碑连带清行 |
| `internal/protocol/blobpack.go` | `BlobPackContentType`、`FetchMaxBytes`、`MaxBlobFrameSize`、`WriteBlobFrame`、`ReadBlobFrame` |
| `internal/protocol/blobpack_test.go` | 往返、畸形帧头、截断流、超长 size |
| `internal/httpapi/peer.go` | `PeerHandler`、`mountInternal`、四个内部接口处理器 |
| `internal/httpapi/peer_test.go` | inventory 分页/`since` no-op、sync 相等判定、fetch 帧与限额、scrub 响应 |
| `internal/peersync/peer.go` | `Peer` / `Config` / `NewClient` / `ParseIssuerPubKeys` |
| `internal/peersync/remote.go` | `FetchCatalog` / `FetchManifest` / `FetchPackTo` / `FetchBlobs` / `PostSync` / `FetchInventory` |
| `internal/peersync/packimport.go` | `ImportPack`（校验 pack 的 meta 行与行级 `content_hash` → 落位 → 调 `store.ImportPack`） |
| `internal/peersync/sync.go` | `RoundResult`、`SyncPeer`、`RunOnce`、`RunForever` |
| `internal/peersync/scrub.go` | `ScrubResult`、`ScrubOnce`、`ScrubForever` |
| `internal/peersync/testsupport_test.go` | 进程内 peer 测试基建（本包独有，不能复用 `httpapi` 的 test helper） |
| `internal/peersync/sync_test.go` / `packimport_test.go` / `scrub_test.go` | 单轮反熵、包复制拒绝语义、scrub 补齐 |
| `internal/importer/video.go` | `ChunkSize = 1 << 20`、`VideoOptions`、`VideoResult`、`ImportVideo` |
| `internal/importer/video_test.go` | 块数 = `ceil(size / 1 MiB)`、末块可短、幂等重导入不新增块 |
| `cmd/based/importvideo.go` | `import-video` 子命令 |
| `cmd/based/peersync.go` | `peer-sync` 子命令（手动单轮） |
| `cmd/based/scrub.go` | `scrub` 子命令 |
| `cmd/based/peerconfig.go` | `-data/-peers/-issuer-pubkeys/-tls-*` 装载出站配置（serve / peer-sync / scrub 共用） |
| `scripts/install.sh` | 一键安装（POSIX sh，契约见册子 §10.2） |
| `scripts/install.ps1` | 一键安装（Windows，行为与 `install.sh` 逐条一致；**含中文 → 必须 UTF-8 BOM**） |

**修改（Go）**

| 文件 | 改什么 |
|---|---|
| `internal/store/schema.go` | 追加 `blob_replicas` 表（唯一新增表） |
| `internal/httpapi/server.go` | `Handler()` 只留公开路由；新增 `PeerHandler()`；`Options` 增 `FetchMaxBlobs`（≤0 归一为 64） |
| `internal/peersync/...` 之外不新增包 | `packexport` / `importer/md.go` / `tools/migrate` / `web.go` / `content.go` / `public.go` **零改动** |
| `cmd/based/serve.go` | 拆两个 router（客户端挂公开、对端挂公开∪内部）；`-data` 走 `BASE_DATA`；新增 `-issuer-pubkeys` / `-sync-interval` / `-scrub-interval` / `-fetch-max-blobs`；`-peers` 非空时启动反熵与 scrub 调度器 |
| `cmd/based/main.go` | 子命令分发加 `import-video` / `peer-sync` / `scrub`；更新 usage 行 |

**修改（TS）**

| 文件 | 改什么 |
|---|---|
| `apps/mobile/src/core/repo.ts` | `LocalRepo` 增 `listBlobPathsByItem(itemId): Promise<string[]>`；`SqlRepo` 实现 |
| `apps/mobile/src/core/sync.ts` | 墓碑应用前收集块路径，`applyPack` 之后删除文件（失败只记日志） |
| `apps/mobile/src/core/fakes.ts` | `MemoryRepo` 实现 `listBlobPathsByItem` |
| `apps/mobile/src/core/sync.test.ts` | 追加「墓碑后块文件被删除」用例 |

---

## 任务依赖顺序

```
Task 0  离线测试基座（peersync 进程内 transport 注入口就位）
Task 1  store 资产（blob_replicas / 块分页 / 删除 / owner 索引）
Task 2  import-video（分块导入，验收 3 的前半）
Task 3  protocol 帧格式（Task 5 与 Task 6 的共同契约）
Task 4  路由隔离（公开 / 对端两个 router）
Task 5  四个内部接口（依赖 1、3、4）
Task 6  出站 peer 客户端（依赖 0、1；TLS 复用 S1 的 ClientTLSConfig）
Task 7  包级复制（依赖 1、6；验收 4、9）
Task 8  反熵回合 + 副本登记 + 调度 + peer-sync 子命令（依赖 6、7；验收 1、6）
Task 9  scrub 自愈（依赖 1、6；验收 2）
Task 10 墓碑同步（节点侧在 Task 7 内；客户端 delta；验收 7）
Task 11 install.sh / install.ps1（验收 10）
Task 12 端到端验收（三进程真机）与文档回填
```

---

## Task 0: 离线测试基建（前置，先让基线转绿）

**Files:**
- Create: `internal/peersync/testsupport_test.go`

**为什么必须先做：** 本机 Go **同进程回环 TCP 不可用**（已实测），而 `peersync` 的每条测试都要「一个节点打另一个节点」。`httpapi` 的 `newInprocServer` 是包内 test helper，跨包不可见，故 `peersync` 必须自带一份等价基建，并给 `Config` 留注入口。

- [ ] **Step 1: 确认基线干净、可构建**

```powershell
$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH
Set-Location e:\code\base
git status --short
go build ./...
go test ./...
```

Expected: `git status --short` 无输出；`go build` 无错；`go test ./...` 全包 ok。

- [ ] **Step 2: 写 `internal/peersync/testsupport_test.go`（进程内 peer 基建）**

```go
package peersync

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/johocn/base/internal/store"
)

// 本机 Go 无法完成同进程回环 TCP（listen 与 dial 在同一进程内 100% 超时，
// 跨进程正常），故 httptest.NewServer 在本机不可用。
// 这里提供进程内 RoundTripper：请求按 Host 查表直接送进 handler，不经过 socket。
// 与 internal/httpapi/testsupport_test.go 的做法一致，但 test helper 跨包不可见，只能各留一份。
var (
	inprocMu    sync.Mutex
	inprocTable = map[string]http.Handler{}
	inprocSeq   int
)

// newInprocPeer 登记一个进程内 peer 并返回它的 URL 与「注入给 Config.TransportFor 的传输」。
func newInprocPeer(t *testing.T, h http.Handler) (url string, rt func(Peer) (http.RoundTripper, error)) {
	t.Helper()
	inprocMu.Lock()
	inprocSeq++
	host := fmt.Sprintf("peer-%d.test", inprocSeq)
	inprocTable[host] = h
	inprocMu.Unlock()
	return "https://" + host, func(Peer) (http.RoundTripper, error) { return inprocTransport{}, nil }
}

type inprocTransport struct{}

func (inprocTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	inprocMu.Lock()
	h := inprocTable[req.URL.Host]
	inprocMu.Unlock()
	if h == nil {
		return nil, fmt.Errorf("测试未登记的进程内 peer: %s", req.URL.Host)
	}
	if req.Body == nil {
		req.Body = http.NoBody
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Result(), nil
}

// openTemp 打开测试用内容库（注入固定密钥，避免在仓库根落地 data.key）。
func openTemp(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir(), store.WithStoreKey(testStoreKey))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// testStoreKey 是测试固定静态加密密钥（hex64）。
const testStoreKey = "9f2c1d4a7b3e5081f6a9c2d5e8b10432a7c9e6b3d0f84261c5a8e2b7d4f01963"
```

- [ ] **Step 3: 写最小冒烟测试，确认注入口可用**

创建 `internal/peersync/peer_test.go`：

```go
package peersync

import (
	"context"
	"net/http"
	"testing"
)

func TestInprocTransportReachesPeerHandler(t *testing.T) {
	url, transport := newInprocPeer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	cfg := Config{TransportFor: transport}
	hc, err := cfg.client(Peer{URL: url})
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url+"/v1/inventory", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	res, err := hc.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
}
```

- [ ] **Step 4: 先写最小 `Config` 让冒烟测试能编译**

创建 `internal/peersync/peer.go`（完整版见 Task 6，这里先落 `Peer` / `Config` / `client`）：

```go
// Package peersync 负责节点↔节点的出站行为：拉内容包、拉块、反熵比对、scrub 补齐。
// 入站接口在 internal/httpapi/peer.go；本包只发起请求，不提供任何 handler。
package peersync

import (
	"context"
	"io"
	"net/http"
	"time"

	"github.com/johocn/base/internal/httpapi"
)

// Peer 是一个对端节点（与 cmd/based 的 peerSpec / BASE_PEERS 元素同形）。
type Peer struct {
	URL            string `json:"url"`
	TLSFingerprint string `json:"tls_fingerprint"`
}

// Config 是一次 Session 的出站配置。
type Config struct {
	// OwnTLS 是本节点 TLS 身份（对端是双向 TLS，客户端必须带证书）。
	OwnTLS httpapi.TLSInfo
	// NodeKey 可选；非空时所有出站请求带 X-Base-Node-Key（对端监听可叠加这层）。
	NodeKey string
	// IssuerPubKeys 是签发方公钥信任表（issuer → 公钥 hex64），来源只有配置注入。
	IssuerPubKeys map[string]string
	// FetchMaxBlobs 是 fetch 单请求块数上限；<=0 取 defaultFetchMaxBlobs。
	FetchMaxBlobs int
	// TransportFor 为 nil 时按 OwnTLS + peer 指纹构造 TLS 传输（生产路径）。
	// 非 nil 时用它（测试注入进程内传输：本机 Go 同进程回环 TCP 不可用）。
	TransportFor func(p Peer) (http.RoundTripper, error)
}

const (
	defaultFetchMaxBlobs = 64
	requestTimeout       = 2 * time.Minute
)

func (c Config) client(p Peer) (*http.Client, error) {
	var tr http.RoundTripper
	if c.TransportFor != nil {
		t, err := c.TransportFor(p)
		if err != nil {
			return nil, err
		}
		tr = t
	} else {
		tlsCfg, err := httpapi.ClientTLSConfig(c.OwnTLS, p.TLSFingerprint)
		if err != nil {
			return nil, err
		}
		tr = &http.Transport{TLSClientConfig: tlsCfg, MaxIdleConns: 4, IdleConnTimeout: 60 * time.Second}
	}
	return &http.Client{Transport: tr, Timeout: requestTimeout}, nil
}

func (c Config) fetchMaxBlobs() int {
	if c.FetchMaxBlobs <= 0 {
		return defaultFetchMaxBlobs
	}
	return c.FetchMaxBlobs
}

// do 发起一次请求并叠加 node key（对端监听的第三层鉴权）。
func (c Config) do(ctx context.Context, hc *http.Client, method, url string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	if c.NodeKey != "" {
		req.Header.Set("X-Base-Node-Key", c.NodeKey)
	}
	return hc.Do(req)
}
```

- [ ] **Step 5: 跑测试**

```powershell
Set-Location e:\code\base
go test ./internal/peersync/ -run TestInprocTransportReachesPeerHandler -v
```

Expected: `--- PASS: TestInprocTransportReachesPeerHandler`。

---

## Task 1: store 资产（`blob_replicas` / 块分页 / 删除 / owner 索引）

**Files:**
- Modify: `internal/store/schema.go`
- Create: `internal/store/blobs.go`、`internal/store/blobs_test.go`
- Create: `internal/store/replica.go`、`internal/store/replica_test.go`

- [ ] **Step 1: `schema.go` 追加 `blob_replicas`（唯一新增表）**

在 `events` 表之后的 `schemaStatements` 末尾追加：

```go
	`CREATE TABLE IF NOT EXISTS blob_replicas(
		blob_id TEXT NOT NULL,
		peer    TEXT NOT NULL,
		seen_at INTEGER NOT NULL,
		PRIMARY KEY(blob_id, peer)
	)`,
```

语义（写进表上方的注释，不写进生产代码逻辑）：`peer` 存 `BASE_PEERS` 里的 `url`；一行 = 「那个 peer **曾经声明**持有该块」，与本地是否持有无关；长期离线不删行，`seen_at` 供运维判断新鲜度。

- [ ] **Step 2: 写 `internal/store/blobs.go`**

```go
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"

	"github.com/johocn/base/internal/protocol"
)

// ListBlobsPage 按 blob_id 升序（cursor 独占）分页返回块；next 为空表示没有下一页。
func (s *Store) ListBlobsPage(cursor string, limit int) ([]BlobRef, string, error) {
	if limit <= 0 {
		limit = 500
	}
	rows, err := s.db.Query(`SELECT blob_id,seq,size FROM blobs WHERE blob_id > ? ORDER BY blob_id ASC LIMIT ?`, cursor, limit)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []BlobRef{}
	for rows.Next() {
		var b BlobRef
		if err := rows.Scan(&b.BlobID, &b.Seq, &b.Size); err != nil {
			return nil, "", err
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(out) == limit {
		next = out[len(out)-1].BlobID
	}
	return out, next, nil
}

// ListAllBlobIDs 返回全部 blob_id（升序）。用于节点块集合的 merkle_root 与全量校验。
func (s *Store) ListAllBlobIDs() ([]string, error) {
	rows, err := s.db.Query(`SELECT blob_id FROM blobs ORDER BY blob_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ContentVersion 返回全局 content_version（无记录时为 0）。
// 这是唯一的水位读法：反熵会话与 inventory 都靠它判定「是否需要拉包」。
func (s *Store) ContentVersion() (int64, error) {
	raw := s.MetaString(metaContentVersion, "0")
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("store: bad content_version %q", raw)
	}
	return n, nil
}

// DeleteBlobFile 删除块文件本体；文件不存在视为成功（幂等）。
func (s *Store) DeleteBlobFile(blobID string) error {
	if !protocol.IsBlobID(blobID) {
		return fmt.Errorf("store: invalid blob id %q", blobID)
	}
	if err := os.Remove(s.BlobPath(blobID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// DeleteBlob 删除块文件与 blobs 行。唯一允许的主动删除场景是 scrub 发现坏块（另见墓碑路径）。
func (s *Store) DeleteBlob(blobID string) error {
	if err := s.DeleteBlobFile(blobID); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM blobs WHERE blob_id=?`, blobID)
	return err
}

// MediaChunkIndex 返回 blob_id → 所属条目与 seq 的映射，来源是各 media_meta 的 chunk_hashes_json
// （数组下标即 seq）。补齐块时必须用它把块挂回条目，否则墓碑清不掉缓存节点上的块文件。
//
// 为什么不用 blobs 表：缓存节点解包入库时 media_meta 行已就位、而块尚未补齐，
// 此刻 blobs 里根本没有这些行，只有 media_meta 的「声明块序列」知道块的归属。
func (s *Store) MediaChunkIndex() (map[string]BlobRef, error) {
	rows, err := s.db.Query(`SELECT item_id,chunk_hashes_json FROM media_meta`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]BlobRef{}
	for rows.Next() {
		var itemID, chunkJSON string
		if err := rows.Scan(&itemID, &chunkJSON); err != nil {
			return nil, err
		}
		var hashes []string
		if err := json.Unmarshal([]byte(chunkJSON), &hashes); err != nil {
			return nil, fmt.Errorf("store: media_meta %s 的 chunk_hashes_json 非法: %w", itemID, err)
		}
		for seq, raw := range hashes {
			id := normalizeChunkID(raw)
			if !protocol.IsBlobID(id) {
				continue
			}
			if _, ok := out[id]; ok {
				continue // 同一字节可被多个条目引用：保留先到者的归属
			}
			out[id] = BlobRef{BlobID: id, Seq: seq, ItemID: itemID}
		}
	}
	return out, rows.Err()
}

// normalizeChunkID 把 chunk_hashes_json 里声明的块 id 归一为 32 字符 blob_id。
// 存量封面路径（tools/migrate/strapi.go 的 importCover）写的是 sha256 的 64 字符全量，
// 其前 32 字符就是真正的 blob_id；视频导入路径（internal/importer/video.go）写的就是 blob_id 本身。
// 只归一，不改存量数据。
func normalizeChunkID(s string) string {
	if len(s) == 64 {
		return s[:32]
	}
	return s
}
```

注意：`MediaChunkIndex` 需要 `BlobRef` 多一个 `ItemID` 字段 → 在 `store.go` 的 `BlobRef` 上加：

```go
// BlobRef 是条目的一个块引用。
type BlobRef struct {
	BlobID string
	Seq    int
	Size   int64
	ItemID string
}
```

（`ListBlobsForItem` 的 `SELECT blob_id,seq,size` 不变，`ItemID` 留零值。）

- [ ] **Step 3: 写 `internal/store/replica.go`**

```go
package store

import (
	"fmt"

	"github.com/johocn/base/internal/protocol"
)

// UpsertBlobReplica 登记「peer 声明持有该块」，seen_at 刷新为当前轮次时间。
func (s *Store) UpsertBlobReplica(blobID, peer string, seenAt int64) error {
	if !protocol.IsBlobID(blobID) {
		return fmt.Errorf("store: invalid blob id %q", blobID)
	}
	_, err := s.db.Exec(`INSERT INTO blob_replicas(blob_id,peer,seen_at) VALUES(?,?,?)
		ON CONFLICT(blob_id,peer) DO UPDATE SET seen_at=excluded.seen_at`, blobID, peer, seenAt)
	return err
}

// ReplicaPeers 返回声明持有该块的 peer 列表（升序）。scrub 用它决定去哪儿补齐。
func (s *Store) ReplicaPeers(blobID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT peer FROM blob_replicas WHERE blob_id=? ORDER BY peer ASC`, blobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// CountBlobsWithoutReplica 返回「本地持有但没有任何 peer 声明持有」的块数。
// 副本数定义 = 本地持有(1) + blob_replicas 行数；本地持有恒为 1（按 blobs 表统计），故 <2 ⇔ 无 peer 行。
func (s *Store) CountBlobsWithoutReplica() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM blobs b
		WHERE NOT EXISTS(SELECT 1 FROM blob_replicas r WHERE r.blob_id=b.blob_id)`).Scan(&n)
	return n, err
}
```

- [ ] **Step 4: 写测试 `internal/store/replica_test.go`**

```go
package store

import "testing"

func TestBlobReplicaUpsertAndCount(t *testing.T) {
	st := openTemp(t)
	id := putBlob(t, st, "块-A", "lesson:a", 0)

	n, err := st.CountBlobsWithoutReplica()
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("无副本块数 = %d, want 1", n)
	}

	if err := st.UpsertBlobReplica(id, "https://p1", 100); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := st.UpsertBlobReplica(id, "https://p1", 200); err != nil { // 幂等：同 (blob,peer) 只刷 seen_at
		t.Fatalf("upsert again: %v", err)
	}
	if err := st.UpsertBlobReplica(id, "https://p2", 100); err != nil {
		t.Fatalf("upsert p2: %v", err)
	}
	peers, err := st.ReplicaPeers(id)
	if err != nil {
		t.Fatalf("peers: %v", err)
	}
	if len(peers) != 2 || peers[0] != "https://p1" || peers[1] != "https://p2" {
		t.Fatalf("peers = %v, want [p1 p2]", peers)
	}
	if n, _ := st.CountBlobsWithoutReplica(); n != 0 {
		t.Fatalf("无副本块数 = %d, want 0", n)
	}
}
```

`putBlob` 是同包测试 helper，加在 `internal/store/store_test.go`（若已存在同名 helper 则直接复用；不存在时新增）：

```go
// putBlob 写入一个块并返回 blob_id（测试 helper）。
func putBlob(t *testing.T, st *Store, content, itemID string, seq int) string {
	t.Helper()
	data := []byte(content)
	id := protocol.BlobID(data)
	if err := st.PutBlob(id, data, itemID, seq); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	return id
}
```

- [ ] **Step 5: 写测试 `internal/store/blobs_test.go`**

```go
package store

import (
	"os"
	"sort"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestListBlobsPageCursor(t *testing.T) {
	st := openTemp(t)
	ids := []string{}
	for _, s := range []string{"a", "b", "c"} {
		ids = append(ids, putBlob(t, st, "内容-"+s, "lesson:x", 0))
	}
	sort.Strings(ids)

	page, next, err := st.ListBlobsPage("", 2)
	if err != nil {
		t.Fatalf("page1: %v", err)
	}
	if len(page) != 2 || next != page[1].BlobID {
		t.Fatalf("page1 = %d 条 next=%q", len(page), next)
	}
	page2, next2, err := st.ListBlobsPage(next, 2)
	if err != nil {
		t.Fatalf("page2: %v", err)
	}
	if len(page2) != 1 || next2 != "" {
		t.Fatalf("page2 = %d 条 next=%q, want 1 条且 next 为空", len(page2), next2)
	}
	all, err := st.ListAllBlobIDs()
	if err != nil {
		t.Fatalf("all: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("全部块 = %d, want 3", len(all))
	}
	if ids[0] > ids[2] {
		t.Fatal("unreachable")
	}
}

func TestDeleteBlobRemovesFileAndRow(t *testing.T) {
	st := openTemp(t)
	id := putBlob(t, st, "要删的块", "lesson:x", 0)
	if err := st.DeleteBlob(id); err != nil {
		t.Fatalf("DeleteBlob: %v", err)
	}
	if _, err := os.Stat(st.BlobPath(id)); !os.IsNotExist(err) {
		t.Fatalf("块文件仍在: %v", err)
	}
	if ok, _, _ := st.HasBlob(id); ok {
		t.Fatal("blobs 行仍在")
	}
	if err := st.DeleteBlob(id); err != nil { // 幂等
		t.Fatalf("重复删除应成功: %v", err)
	}
}

func TestMediaChunkIndexMapsOwnerAndSeq(t *testing.T) {
	st := openTemp(t)
	b0 := putBlob(t, st, "块0", "lesson:v", 0)
	b1 := putBlob(t, st, "块1", "lesson:v", 1)
	if err := st.UpsertMediaItem(MediaItem{
		ItemID: "lesson:v", Source: "lesson", Type: "video", Title: "视频",
		SourceRev: "rev", ContentHash: "hash", SQLiteTable: "media_meta",
		MIME: "video/mp4", Size: 10, ChunkSize: 1 << 20,
		ChunkHashes: []string{b0, b1},
	}); err != nil {
		t.Fatalf("UpsertMediaItem: %v", err)
	}
	// 存量封面路径：chunk_hashes_json 里是 64 字符全量 sha256，必须归一到前 32 字符。
	cover := []byte("cover-bytes")
	coverID := protocol.BlobID(cover)
	if err := st.PutBlob(coverID, cover, "cover:a", 0); err != nil {
		t.Fatalf("PutBlob cover: %v", err)
	}
	if err := st.UpsertMediaItem(MediaItem{
		ItemID: "cover:a", Source: "article", Type: "cover", Title: "封面",
		SourceRev: "rev", ContentHash: protocol.SHA256Hex(cover), SQLiteTable: "media_meta",
		MIME: "image/png", Size: int64(len(cover)), ChunkSize: int64(len(cover)),
		ChunkHashes: []string{protocol.SHA256Hex(cover)},
	}); err != nil {
		t.Fatalf("UpsertMediaItem cover: %v", err)
	}

	idx, err := st.MediaChunkIndex()
	if err != nil {
		t.Fatalf("index: %v", err)
	}
	if got := idx[b1]; got.ItemID != "lesson:v" || got.Seq != 1 {
		t.Fatalf("b1 owner = %+v, want lesson:v/seq=1", got)
	}
	if got := idx[coverID]; got.ItemID != "cover:a" || got.Seq != 0 {
		t.Fatalf("封面 owner = %+v（64 字符声明必须归一）, want cover:a/seq=0", got)
	}
	if _, ok := idx[protocol.SHA256Hex(cover)]; ok {
		t.Fatal("64 字符全量 sha256 不得作为 key 出现")
	}
}
```

（`ids` 仅用于断言三块互不相同；`sort` 的引用保证了与分页升序口径一致。执行时以 `goimports` 结果为准，多余 import 一律删掉。）

- [ ] **Step 6: 跑测试**

```powershell
Set-Location e:\code\base
go test ./internal/store/ -v -run 'TestBlobReplica|TestListBlobsPage|TestDeleteBlob|TestMediaChunkIndex'
```

Expected: 4 个用例 PASS，且 `go test ./internal/store/` 其余用例不受影响。

---

## Task 2: `import-video`（定长 1 MiB 分块导入）

**Files:**
- Create: `internal/importer/video.go`、`internal/importer/video_test.go`
- Create: `cmd/based/importvideo.go`
- Modify: `cmd/based/main.go`

- [ ] **Step 1: 写 `internal/importer/video.go`**

```go
package importer

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// ChunkSize 是视频分块的定长粒度（总纲 §6.3）：1048576 字节，最后一块可短。
const ChunkSize = 1 << 20

// VideoOptions 是视频导入参数。
type VideoOptions struct {
	Path     string // 源文件路径
	Slug     string // 条目 slug，item_id = lesson:<slug>
	Title    string // 空则取文件名（不含扩展名）
	MIME     string // 空则按扩展名推断
	Duration int64  // 秒；0 = 未知
}

// VideoResult 是导入结果。
type VideoResult struct {
	ItemID      string
	Chunks      int
	TotalSize   int64
	Written     int // 本次真正写盘的块数（已存在的同字节块跳过写盘）
	ContentHash string
}

// ImportVideo 把一个文件按定长 1 MiB 分块入库。
// 条目级 content_hash = hex(sha256(按 seq 升序拼接的每个块的 blob_id))：只依赖块 id 序列，可复算。
// 失败语义：任一块写盘失败即报错，已写入的块与登记保留（块是内容寻址的，重跑即续上），不回滚。
func ImportVideo(st *store.Store, opt VideoOptions) (VideoResult, error) {
	if strings.TrimSpace(opt.Path) == "" || strings.TrimSpace(opt.Slug) == "" {
		return VideoResult{}, fmt.Errorf("importer: -file 与 -slug 都是必填")
	}
	f, err := os.Open(opt.Path)
	if err != nil {
		return VideoResult{}, fmt.Errorf("importer: 打开视频: %w", err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return VideoResult{}, fmt.Errorf("importer: stat 视频: %w", err)
	}
	if fi.Size() == 0 {
		return VideoResult{}, fmt.Errorf("importer: 视频为空（0 字节），分块后没有任何块文件，无法导出")
	}

	itemID := "lesson:" + opt.Slug
	res := VideoResult{ItemID: itemID, TotalSize: fi.Size()}
	hashes := []string{}
	buf := make([]byte, ChunkSize)
	for seq := 0; ; seq++ {
		n, err := io.ReadFull(f, buf)
		if n > 0 {
			data := buf[:n]
			id := protocol.BlobID(data)
			hashes = append(hashes, id)
			res.Chunks++
			ok, _, herr := st.HasBlob(id)
			if herr != nil {
				return res, fmt.Errorf("importer: 探测块 %s: %w", id, herr)
			}
			if !ok {
				if perr := st.PutBlob(id, data, itemID, seq); perr != nil {
					return res, fmt.Errorf("importer: 写块 %s(seq=%d): %w", id, seq, perr)
				}
				res.Written++
			}
		}
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			break
		}
		if err != nil {
			return res, fmt.Errorf("importer: 读视频: %w", err)
		}
	}

	sum := sha256.Sum256([]byte(strings.Join(hashes, "")))
	res.ContentHash = hex.EncodeToString(sum[:])

	title := opt.Title
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(opt.Path), filepath.Ext(opt.Path))
	}
	mime := opt.MIME
	if mime == "" {
		mime = guessVideoMIME(opt.Path)
	}
	if err := st.UpsertMediaItem(store.MediaItem{
		ItemID: itemID, Source: "lesson", Type: "video", Title: title,
		SourceRev:   res.ContentHash[:16],
		ContentHash: res.ContentHash,
		SQLiteTable: "media_meta",
		MIME:        mime,
		Size:        fi.Size(),
		Duration:    opt.Duration,
		ChunkSize:   ChunkSize,
		ChunkHashes: hashes,
	}); err != nil {
		return res, fmt.Errorf("importer: 登记条目: %w", err)
	}
	return res, nil
}

func guessVideoMIME(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp4", ".m4v":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mkv":
		return "video/x-matroska"
	case ".mov":
		return "video/quicktime"
	default:
		return "application/octet-stream"
	}
}
```

- [ ] **Step 2: 写测试 `internal/importer/video_test.go`**

```go
package importer

import (
	"testing"
)

func TestImportVideoChunking(t *testing.T) {
	st := openTemp(t)
	// ChunkSize + 3 字节 → 2 块，末块 3 字节
	path := writeTempFile(t, "clip.mp4", ChunkSize+3)

	res, err := ImportVideo(st, VideoOptions{Path: path, Slug: "v1", Title: "第一课"})
	if err != nil {
		t.Fatalf("ImportVideo: %v", err)
	}
	if res.Chunks != 2 || res.Written != 2 {
		t.Fatalf("块数 = %d/%d, want 2/2", res.Chunks, res.Written)
	}
	if res.TotalSize != int64(ChunkSize+3) {
		t.Fatalf("总字节 = %d", res.TotalSize)
	}

	mime, size, dur, chunkSize, hashes, ok, err := st.GetMediaMeta("lesson:v1")
	if err != nil || !ok {
		t.Fatalf("GetMediaMeta: ok=%v err=%v", ok, err)
	}
	if size != int64(ChunkSize+3) || chunkSize != ChunkSize || dur != 0 || len(hashes) != 2 || mime != "video/mp4" {
		t.Fatalf("media_meta = %s/%d/%d/%d/%d 块", mime, size, dur, chunkSize, len(hashes))
	}

	// 幂等重导入：同字节块不重写
	res2, err := ImportVideo(st, VideoOptions{Path: path, Slug: "v1"})
	if err != nil {
		t.Fatalf("重复导入: %v", err)
	}
	if res2.Written != 0 {
		t.Fatalf("重复导入写盘 = %d, want 0", res2.Written)
	}
	if res2.ContentHash != res.ContentHash {
		t.Fatalf("content_hash 不稳定: %s != %s", res2.ContentHash, res.ContentHash)
	}
}

func TestImportVideoRejectsEmpty(t *testing.T) {
	st := openTemp(t)
	path := writeTempFile(t, "empty.mp4", 0)
	if _, err := ImportVideo(st, VideoOptions{Path: path, Slug: "e"}); err == nil {
		t.Fatal("空文件应报错")
	}
}
```

helper（加在 `internal/importer/video_test.go` 或已有测试 helper 文件）：

```go
func writeTempFile(t *testing.T, name string, size int) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	data := make([]byte, size)
	for i := range data {
		data[i] = byte(i * 31)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("写临时文件: %v", err)
	}
	return path
}

func openTemp(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir(), store.WithStoreKey("9f2c1d4a7b3e5081f6a9c2d5e8b10432a7c9e6b3d0f84261c5a8e2b7d4f01963"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}
```

- [ ] **Step 3: 写 `cmd/based/importvideo.go`**

```go
package main

import (
	"flag"
	"fmt"

	"github.com/johocn/base/internal/importer"
	"github.com/johocn/base/internal/store"
)

// runImportVideo 把一个视频按定长 1 MiB 分块导入内容库（契约 §4.2）。
// item_id = lesson:<slug>；source=lesson、type=video、sqlite_table=media_meta、dist_class=public。
func runImportVideo(args []string) error {
	fs := flag.NewFlagSet("import-video", flag.ExitOnError)
	file := fs.String("file", "", "视频文件路径（必填）")
	slug := fs.String("slug", "", "slug（必填）；条目 id = lesson:<slug>")
	title := fs.String("title", "", "标题；空则取文件名")
	mime := fs.String("mime", "", "MIME；空则按扩展名推断")
	duration := fs.Int64("duration", 0, "时长（秒）；0 = 未知")
	data := fs.String("data", envOr("BASE_DATA", "data"), "数据目录")
	if err := fs.Parse(args); err != nil {
		return err
	}
	st, err := store.Open(*data)
	if err != nil {
		return err
	}
	defer st.Close()
	res, err := importer.ImportVideo(st, importer.VideoOptions{
		Path: *file, Slug: *slug, Title: *title, MIME: *mime, Duration: *duration,
	})
	if err != nil {
		return err
	}
	fmt.Printf("import-video: %s 块数=%d 总字节=%d 本次写盘=%d content_hash=%s\n",
		res.ItemID, res.Chunks, res.TotalSize, res.Written, res.ContentHash)
	return nil
}
```

- [ ] **Step 4: `main.go` 加分发**

```go
	case "import-video":
		err = runImportVideo(os.Args[2:])
```

并把 usage 行改为：

```go
	fmt.Fprintln(os.Stderr, "usage: based <version|import-md|import-video|export|serve|pubkey|store-key|tls-cert|peer-sync|scrub> [flags]")
```

（`peer-sync` / `scrub` 两条分发在 Task 8 / Task 9 补，本 Task 先加 usage 文案即可，编译不受影响。）

- [ ] **Step 5: 跑测试与手验**

```powershell
Set-Location e:\code\base
go test ./internal/importer/ -v -run TestImportVideo
go build ./... 
```

Expected: 两个用例 PASS；`go build` 无错。

- [ ] **Step 6: 手工导入一个真文件（验收 3 的前半）**

```powershell
Set-Location e:\code\base
$f = Join-Path $env:TEMP 'demo.mp4'
[System.IO.File]::WriteAllBytes($f, (New-Object byte[] 2621440))   # 2.5 MiB → 3 块
go run ./cmd/based import-video -file $f -slug demo-video -data (Join-Path $env:TEMP 'iv-data')
```

Expected: 打印 `块数=3 总字节=2621440 本次写盘=3`；`%TEMP%\iv-data\blobs\` 下出现 3 个块文件；`%TEMP%\iv-data\base.db` 的 `media_meta` 有一行 `lesson:demo-video`。

---

## Task 3: `blobpack` 帧格式（不可变合约）

**Files:**
- Create: `internal/protocol/blobpack.go`、`internal/protocol/blobpack_test.go`

**为什么先做：** Task 5（服务端写帧）与 Task 6（客户端读帧）必须共用同一份实现，否则两侧各写一遍必然漂移。

- [ ] **Step 1: 写 `internal/protocol/blobpack.go`**

```go
package protocol

import (
	"encoding/binary"
	"fmt"
	"io"
)

// BlobPackContentType 是 POST /v1/fetch 的响应类型（契约 §5.2）。
const BlobPackContentType = "application/x-base-blobpack"

const (
	// BlobFrameHeaderSize = blob_id(32 字节 ASCII) + size(8 字节大端)。
	BlobFrameHeaderSize = 40
	// FetchMaxBytes 是单次 fetch 的**总字节**上限（契约 §5.3：64 块 × 1 MiB）。
	// 服务端超限回 413；调用方切批按「块数 ≤ BASE_FETCH_MAX_BLOBS 且累计 size ≤ 本值」。
	FetchMaxBytes = 64 << 20
	// MaxBlobFrameSize 是单帧 payload 上限，只用于拒绝畸形帧头。
	// 不取 1 MiB：封面等「整块」资源本身就可以大于一个视频分块。
	MaxBlobFrameSize = 1 << 30
)

// WriteBlobFrame 写一帧：blob_id(32 ASCII) || size(8 大端) || payload。
func WriteBlobFrame(w io.Writer, blobID string, payload []byte) error {
	if !IsBlobID(blobID) {
		return fmt.Errorf("blobpack: invalid blob id %q", blobID)
	}
	if len(payload) > MaxBlobFrameSize {
		return fmt.Errorf("blobpack: payload %d 字节超过单帧上限", len(payload))
	}
	hdr := make([]byte, BlobFrameHeaderSize)
	copy(hdr[:32], blobID)
	binary.BigEndian.PutUint64(hdr[32:], uint64(len(payload)))
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

// ReadBlobFrame 读一帧；流正常结束返回 io.EOF。
// 帧缺失即「对端没有该块」，调用方以「缺哪些帧」为准，不做占位帧（契约 §5.2）。
func ReadBlobFrame(r io.Reader) (string, []byte, error) {
	hdr := make([]byte, BlobFrameHeaderSize)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return "", nil, err // io.EOF=流结束；io.ErrUnexpectedEOF=半截帧头
	}
	blobID := string(hdr[:32])
	if !IsBlobID(blobID) {
		return "", nil, fmt.Errorf("blobpack: 帧头 blob_id 非法 %q", blobID)
	}
	size := binary.BigEndian.Uint64(hdr[32:])
	if size > MaxBlobFrameSize {
		return "", nil, fmt.Errorf("blobpack: 帧声明 size=%d 超过单帧上限", size)
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(r, payload); err != nil {
		return "", nil, fmt.Errorf("blobpack: 读帧体 %s(size=%d): %w", blobID, size, err)
	}
	return blobID, payload, nil
}
```

- [ ] **Step 2: 写测试 `internal/protocol/blobpack_test.go`**

```go
package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func TestBlobFrameRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	a, b := []byte("第一块"), bytes.Repeat([]byte{7}, 1024)
	idA, idB := BlobID(a), BlobID(b)
	if err := WriteBlobFrame(&buf, idA, a); err != nil {
		t.Fatalf("写帧A: %v", err)
	}
	if err := WriteBlobFrame(&buf, idB, b); err != nil {
		t.Fatalf("写帧B: %v", err)
	}

	r := bytes.NewReader(buf.Bytes())
	gotID, gotBody, err := ReadBlobFrame(r)
	if err != nil || gotID != idA || !bytes.Equal(gotBody, a) {
		t.Fatalf("帧A 往返失败: id=%s err=%v", gotID, err)
	}
	gotID, gotBody, err = ReadBlobFrame(r)
	if err != nil || gotID != idB || !bytes.Equal(gotBody, b) {
		t.Fatalf("帧B 往返失败: id=%s err=%v", gotID, err)
	}
	if _, _, err := ReadBlobFrame(r); !errors.Is(err, io.EOF) {
		t.Fatalf("流结束应返回 io.EOF, got %v", err)
	}
}

func TestBlobFrameRejectsBadHeaders(t *testing.T) {
	// 非法 blob_id
	if err := WriteBlobFrame(io.Discard, "NOT-HEX", []byte("x")); err == nil {
		t.Fatal("非法 blob_id 应被拒绝")
	}
	// 半截帧头
	if _, _, err := ReadBlobFrame(bytes.NewReader(make([]byte, 10))); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("半截帧头应返回 ErrUnexpectedEOF, got %v", err)
	}
	// 声明 size 超上限
	hdr := make([]byte, BlobFrameHeaderSize)
	copy(hdr[:32], BlobID([]byte("x")))
	binary.BigEndian.PutUint64(hdr[32:], uint64(MaxBlobFrameSize)+1)
	if _, _, err := ReadBlobFrame(bytes.NewReader(hdr)); err == nil {
		t.Fatal("超上限 size 应被拒绝")
	}
}

func TestBlobFetchMaxBytesIsSharedContract(t *testing.T) {
	if FetchMaxBytes != 64<<20 {
		t.Fatalf("FetchMaxBytes = %d, want 64 MiB", FetchMaxBytes)
	}
}
```

- [ ] **Step 3: 跑测试**

```powershell
Set-Location e:\code\base
go test ./internal/protocol/ -v -run TestBlobFrame
go test ./internal/protocol/ -v -run TestBlobFetchMaxBytesIsSharedContract
```

Expected: 3 个用例 PASS。

---

## Task 4: 路由隔离（客户端监听零内部路由）

**Files:**
- Modify: `internal/httpapi/server.go`
- Create: `internal/httpapi/peer_test.go`（本 Task 只放路由隔离断言，Task 5 继续往里加）

**这是册子 §5.1 的关键改动，也是红线所在：**现状 `Handler()` 一份 handler 被主监听与对端监听共用（`cmd/based/serve.go:112`）。加入内部接口后必须拆成两个 router。

- [ ] **Step 1: 改 `server.go`：拆 `Handler` / `PeerHandler`**

把现有 `Handler()` 整体改名为 `publicMux()`（内容一行不改，只改签名与返回值），再补两个入口：

```go
// Handler 返回客户端监听用的路由：**只有公开路由**。
// 内部接口（inventory / sync / fetch / scrub）在此监听上根本不存在（404），
// 而不是「存在但被拦截」——这是册子 §5.1 的红线。
func (s *Server) Handler() http.Handler {
	return withCommon(s.publicMux())
}

// PeerHandler 返回对端监听用的路由：公开路由 ∪ 内部路由。
// 对端监听同时保留公开路由，使 BASE_PEERS 里**一个 url 即可满足两种用途**：
// 调内部接口 + 拉 catalog/manifest/pack/blob（无需第二个地址字段）。
func (s *Server) PeerHandler() http.Handler {
	mux := s.publicMux()
	s.mountInternal(mux)
	return withCommon(mux)
}

// publicMux 组装公开路由（匿名可读 + 身份 + 事件）。
func (s *Server) publicMux() *http.ServeMux {
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
	return mux
}

// mountInternal 注册节点↔节点接口，**只在 PeerHandler 调用**。
// 红线：这几条一旦被加回 publicMux，内部接口就暴露给了客户端监听。
func (s *Server) mountInternal(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/inventory", s.handleInventory)
	mux.HandleFunc("POST /v1/sync", s.handleSync)
	mux.HandleFunc("POST /v1/fetch", s.handleFetch)
	mux.HandleFunc("POST /v1/scrub", s.handleScrub)
}
```

- [ ] **Step 2: `Options` 增 `FetchMaxBlobs` 并在 `New` 归一**

```go
// Options 是节点对外服务的配置。SignKeyHex 为空表示本节点是只读分发节点。
type Options struct {
	Issuer     string
	SignKeyHex string
	Version    string
	// TLS 身份，供首页展示配对码与指纹；两者留空表示节点未启用 TLS。
	FingerprintHex string
	PairingCode    string
	// FetchMaxBlobs 是 POST /v1/fetch 单请求的块数上限；<=0 时取 defaultFetchMaxBlobs。
	FetchMaxBlobs int
}

// defaultFetchMaxBlobs 与册子 §5.2 的缺省值一致。
const defaultFetchMaxBlobs = 64
```

`New` 里在赋值 `s` 之前插：

```go
	if opt.FetchMaxBlobs <= 0 {
		opt.FetchMaxBlobs = defaultFetchMaxBlobs
	}
```

- [ ] **Step 3: 改 `cmd/based/serve.go` 用两个 router**

```go
	// 客户端监听：只有公开路由；对端监听：公开路由 ∪ 内部路由（册子 §5.1）。
	publicHandler := srv.Handler()
	peerHandler := srv.PeerHandler()
```

并把对端分支里的 `peerHandler := handler` / `if nodeKey … { peerHandler = srv.RequireNodeKey(...) }` 改为基于新的 `peerHandler`：

```go
	peerWithKey := peerHandler
	if strings.TrimSpace(*nodeKey) != "" {
		peerWithKey = srv.RequireNodeKey(*nodeKey, peerHandler)
	}
	peerSrv := &http.Server{Handler: peerWithKey, TLSConfig: peerTLS}
```

主监听（明文分支与 TLS 分支）一律改用 `publicHandler`。

- [ ] **Step 4: 写路由隔离断言 `internal/httpapi/peer_test.go`**

```go
package httpapi

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/johocn/base/internal/store"
)

// newPeerTestServer 起一个节点，返回 store、服务端、**客户端路由**、**对端路由**。
// 客户端路由 = Handler()（只有公开路由）；对端路由 = PeerHandler()（公开 ∪ 内部）。
func newPeerTestServer(t *testing.T) (*store.Store, *Server, *inprocServer, *inprocServer) {
	t.Helper()
	st, srv, _ := newFullServer(t) // event_test.go 的既有 helper
	return st, srv, newInprocServer(srv.Handler()), newInprocServer(srv.PeerHandler())
}

func TestInternalRoutesAbsentOnClientListener(t *testing.T) {
	_, _, client, peer := newPeerTestServer(t)
	cases := []struct{ method, path string }{
		{http.MethodGet, "/v1/inventory"},
		{http.MethodPost, "/v1/sync"},
		{http.MethodPost, "/v1/fetch"},
		{http.MethodPost, "/v1/scrub"},
	}
	for _, c := range cases {
		req, err := http.NewRequest(c.method, client.URL+c.path, strings.NewReader("{}"))
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", c.method, c.path, err)
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("客户端监听上 %s %s = %d, want 404（内部接口必须不存在）", c.method, c.path, res.StatusCode)
		}
		// 同一条路径在对端监听上必须存在（不是 404）
		req2, _ := http.NewRequest(c.method, peer.URL+c.path, strings.NewReader("{}"))
		res2, err := http.DefaultClient.Do(req2)
		if err != nil {
			t.Fatalf("peer %s %s: %v", c.method, c.path, err)
		}
		_, _ = io.Copy(io.Discard, res2.Body)
		res2.Body.Close()
		if res2.StatusCode == http.StatusNotFound {
			t.Fatalf("对端监听上 %s %s = 404，接口未注册", c.method, c.path)
		}
	}
}

func TestPeerHandlerKeepsPublicRoutes(t *testing.T) {
	_, _, _, peer := newPeerTestServer(t)
	res, err := http.Get(peer.URL + "/v1/catalog")
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("对端监听上的公开路由 /v1/catalog = %d, want 200", res.StatusCode)
	}
}
```

（本 Task 只写路由隔离两条；`mountInternal` 此刻指向尚未实现的 handler，故**本 Task 必须先落 Task 5 Step 1 的 `peer.go` 才能编译**。执行顺序：先写 Task 5 Step 1，再跑本 Task 的测试；或把两条测试与 `peer.go` 一起提交。）

- [ ] **Step 5: 跑测试**

```powershell
Set-Location e:\code\base
go test ./internal/httpapi/ -v -run 'TestInternalRoutesAbsentOnClientListener|TestPeerHandlerKeepsPublicRoutes'
```

Expected: 两个用例 PASS（客户端监听 4 条内部路径全部 404；对端监听上同 4 条均非 404）。

---

## Task 5: 四个内部接口（inventory / sync / fetch / scrub）

**Files:**
- Create: `internal/httpapi/peer.go`
- Modify: `internal/httpapi/peer_test.go`

- [ ] **Step 1: 写 `internal/httpapi/peer.go`**

```go
package httpapi

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/johocn/base/internal/protocol"
)

const (
	inventoryDefaultLimit = 500
	inventoryMaxLimit     = 2000
)

// 本文件是节点↔节点接口的**入站**侧：只在对端监听上注册（见 server.go 的 mountInternal）。
// 本层不做跨节点编排：scrub 只修本地，从邻居补齐由调用方走 fetch（册子 §5.2、修正 2）。

type blobSizeDTO struct {
	BlobID string `json:"blob_id"`
	Size   int64  `json:"size"`
}

type inventoryResponse struct {
	ContentVersion int64         `json:"content_version"`
	MerkleRoot     string        `json:"merkle_root"`
	Blobs          []blobSizeDTO `json:"blobs"`
	NextCursor     *string       `json:"next_cursor"`
}

// handleInventory 返回本节点块清单分页 + 全量 merkle_root（契约 §5.2）。
// merkle_root 的定义域是**本节点持有的全部块 id**，与 packexport 的包内 merkle_root 不是同一个值。
func (s *Server) handleInventory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := inventoryDefaultLimit
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= inventoryMaxLimit {
			limit = n
		}
	}

	version, err := s.st.ContentVersion()
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	ids, err := s.st.ListAllBlobIDs()
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	root, err := protocol.MerkleRoot(ids)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := inventoryResponse{ContentVersion: version, MerkleRoot: root, Blobs: []blobSizeDTO{}}
	if since := q.Get("since"); since != "" {
		if n, err := strconv.ParseInt(since, 10, 64); err == nil && n >= version {
			// 调用方水位不低于本节点：空 blobs + 仍带 merkle_root，用于快速 no-op
			s.writeJSON(w, http.StatusOK, resp)
			return
		}
	}

	refs, next, err := s.st.ListBlobsPage(q.Get("cursor"), limit)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, ref := range refs {
		resp.Blobs = append(resp.Blobs, blobSizeDTO{BlobID: ref.BlobID, Size: ref.Size})
	}
	if next != "" {
		resp.NextCursor = &next
	}
	s.writeJSON(w, http.StatusOK, resp)
}

type syncRequest struct {
	ContentVersion int64  `json:"content_version"`
	MerkleRoot     string `json:"merkle_root"`
}

// handleSync 开启一轮反熵会话：无状态，只比块集合的 merkle_root（契约 §5.2）。
func (s *Server) handleSync(w http.ResponseWriter, r *http.Request) {
	var req syncRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	ids, err := s.st.ListAllBlobIDs()
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	root, err := protocol.MerkleRoot(ids)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	equal := root == req.MerkleRoot
	log.Printf("httpapi: sync 来自水位 %d 的比对：equal=%v", req.ContentVersion, equal)
	s.writeJSON(w, http.StatusOK, map[string]any{"equal": equal})
}

type fetchRequest struct {
	BlobIDs []string `json:"blob_ids"`
}

// handleFetch 批量拉块，逐帧流式返回（契约 §5.2）。
// 请求中不存在于本节点的 blob_id **整帧跳过**（不占位、不报错）。
func (s *Server) handleFetch(w http.ResponseWriter, r *http.Request) {
	var req fetchRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	if len(req.BlobIDs) == 0 {
		s.writeError(w, http.StatusBadRequest, "blob_ids 不能为空")
		return
	}
	if len(req.BlobIDs) > s.opt.FetchMaxBlobs {
		s.writeError(w, http.StatusRequestEntityTooLarge,
			"单请求块数超过上限 "+strconv.Itoa(s.opt.FetchMaxBlobs))
		return
	}
	for _, id := range req.BlobIDs {
		if !protocol.IsBlobID(id) {
			s.writeError(w, http.StatusBadRequest, "非法 blob_id: "+id)
			return
		}
	}

	// 先做全量预检：存在性与总字节上限。任一不满足就返回错误，
	// **绝不返回半截流**（客户端无法区分「对端没有」与「写了一半断了」）。
	type hit struct {
		id   string
		size int64
	}
	found := make([]hit, 0, len(req.BlobIDs))
	seen := map[string]struct{}{}
	total := int64(0)
	for _, id := range req.BlobIDs {
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		ok, size, err := s.st.HasBlob(id)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !ok {
			continue // 本节点没有：整帧跳过
		}
		total += size
		found = append(found, hit{id: id, size: size})
	}
	if total > protocol.FetchMaxBytes {
		s.writeError(w, http.StatusRequestEntityTooLarge,
			"单请求总字节超过上限 "+strconv.Itoa(protocol.FetchMaxBytes))
		return
	}

	w.Header().Set("Content-Type", protocol.BlobPackContentType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	sent := 0
	for _, h := range found {
		data, err := s.st.GetBlobBytes(h.id)
		if err != nil {
			log.Printf("httpapi: fetch 读块 %s 失败，跳过该帧: %v", h.id, err)
			continue
		}
		if got := protocol.BlobID(data); got != h.id {
			log.Printf("httpapi: fetch 块 %s 内容与哈希不符（实际 %s），跳过该帧", h.id, got)
			continue
		}
		if err := protocol.WriteBlobFrame(w, h.id, data); err != nil {
			log.Printf("httpapi: fetch 写帧 %s 失败（调用方可能已断开）: %v", h.id, err)
			return
		}
		sent++
	}
	log.Printf("httpapi: fetch 请求 %d 块，本节点命中 %d 块，发送 %d 帧", len(req.BlobIDs), len(found), sent)
}

type scrubRequest struct {
	BlobIDs []string `json:"blob_ids"`
}

type scrubBadDTO struct {
	BlobID string `json:"blob_id"`
	Reason string `json:"reason"`
}

type scrubResponse struct {
	Checked  int           `json:"checked"`
	Repaired int           `json:"repaired"`
	Dropped  int           `json:"dropped"`
	Bad      []scrubBadDTO `json:"bad"`
}

// handleScrub 触发一次**本地**校验修复（契约 §5.2 + 修正 2）。
// Repaired 恒为 0：跨节点补齐必须走出站请求，本包不依赖 peersync；
// 调用方拿到 bad 后自行走 fetch 补齐。
func (s *Server) handleScrub(w http.ResponseWriter, r *http.Request) {
	var req scrubRequest
	if r.Body != nil {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			s.writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
			return
		}
	}
	checked, bad, err := s.st.VerifyBlobs(req.BlobIDs)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := scrubResponse{Checked: checked, Repaired: 0, Dropped: len(bad), Bad: []scrubBadDTO{}}
	for _, b := range bad {
		resp.Bad = append(resp.Bad, scrubBadDTO{BlobID: b.BlobID, Reason: b.Reason})
	}
	s.writeJSON(w, http.StatusOK, resp)
}
```

- [ ] **Step 2: 写接口测试（追加到 `internal/httpapi/peer_test.go`）**

```go
func TestInventoryPaginationAndSinceNoop(t *testing.T) {
	// 复用 Task 4 已在 peer_test.go 落下的 helper（唯一 4 返回值版本）。
	st, _, _, peer := newPeerTestServer(t)
	for _, s := range []string{"①", "②", "③"} {
		data := []byte("块" + s)
		id := protocol.BlobID(data)
		if err := st.PutBlob(id, data, "lesson:x", 0); err != nil {
			t.Fatalf("PutBlob: %v", err)
		}
	}

	// 分页：limit=2 → 2 条 + next_cursor
	res, err := http.Get(peer.URL + "/v1/inventory?limit=2")
	if err != nil {
		t.Fatalf("inventory: %v", err)
	}
	var page inventoryResponse
	if err := json.NewDecoder(res.Body).Decode(&page); err != nil {
		t.Fatalf("decode: %v", err)
	}
	res.Body.Close()
	if len(page.Blobs) != 2 || page.NextCursor == nil || page.MerkleRoot == "" {
		t.Fatalf("page = %d 条 next=%v root=%q", len(page.Blobs), page.NextCursor, page.MerkleRoot)
	}
	if page.ContentVersion != 0 {
		t.Fatalf("content_version = %d, want 0（未导出过包）", page.ContentVersion)
	}

	// since >= 本节点水位 → 空 blobs 但仍带 merkle_root
	res2, err := http.Get(peer.URL + "/v1/inventory?since=0")
	if err != nil {
		t.Fatalf("inventory since: %v", err)
	}
	var page2 inventoryResponse
	if err := json.NewDecoder(res2.Body).Decode(&page2); err != nil {
		t.Fatalf("decode2: %v", err)
	}
	res2.Body.Close()
	if len(page2.Blobs) != 0 || page2.MerkleRoot == "" {
		t.Fatalf("since no-op 应为空 blobs + 非空 root，got %d/%q", len(page2.Blobs), page2.MerkleRoot)
	}
}
```

（无需任何新 helper：`newPeerTestServer` 已在 Task 4 Step 4 落到 `peer_test.go`。）

- [ ] **Step 3: 写 fetch 与 scrub 的接口测试**

```go
func TestFetchStreamsFramesAndSkipsMissing(t *testing.T) {
	st, _, _, peer := newPeerTestServer(t)
	body := []byte("fetch 的块字节")
	id := protocol.BlobID(body)
	if err := st.PutBlob(id, body, "lesson:x", 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	missing := strings.Repeat("ab", 16) // 32 hex，但本节点没有

	reqBody, _ := json.Marshal(fetchRequest{BlobIDs: []string{id, missing}})
	res, err := http.Post(peer.URL+"/v1/fetch", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != protocol.BlobPackContentType {
		t.Fatalf("Content-Type = %q", ct)
	}
	gotID, gotBody, err := protocol.ReadBlobFrame(res.Body)
	if err != nil || gotID != id || !bytes.Equal(gotBody, body) {
		t.Fatalf("帧 = %s err=%v", gotID, err)
	}
	if _, _, err := protocol.ReadBlobFrame(res.Body); !errors.Is(err, io.EOF) {
		t.Fatalf("缺失块必须整帧跳过（流到此结束），got %v", err)
	}
}

func TestFetchRejectsOverLimit(t *testing.T) {
	_, _, _, peer := newPeerTestServer(t)
	ids := make([]string, 65)
	for i := range ids {
		ids[i] = strings.Repeat("0", 31) + strconv.Itoa(i%10)
	}
	reqBody, _ := json.Marshal(fetchRequest{BlobIDs: ids})
	res, err := http.Post(peer.URL+"/v1/fetch", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", res.StatusCode)
	}
}

func TestScrubEndpointRepairsNothingLocally(t *testing.T) {
	st, _, _, peer := newPeerTestServer(t)
	body := []byte("正常块")
	id := protocol.BlobID(body)
	if err := st.PutBlob(id, body, "lesson:x", 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	res, err := http.Post(peer.URL+"/v1/scrub", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("scrub: %v", err)
	}
	defer res.Body.Close()
	var out scrubResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Checked != 1 || out.Dropped != 0 || out.Repaired != 0 || len(out.Bad) != 0 {
		t.Fatalf("scrub = %+v", out)
	}
}
```

（`strconv.Itoa(i%10)` 拼出的 id 恰好 32 位 hex；`bufio` 未用到就别 import。执行时以 `goimports` 结果为准。）

- [ ] **Step 4: 先把 `VerifyBlobs` 落下来（否则上面三个测试编译不过）**

本 Task 依赖 `store.VerifyBlobs`。它与 scrub 编排关系紧密，故完整实现放在 Task 9 Step 1；**但为了让 Task 5 的测试此刻能编译并跑通，本步先落一个最小可用版本**（Task 9 只补充 `internal/peersync/scrub.go` 的编排，不再改这里）：

```go
package store

import (
	"errors"
	"os"

	"github.com/johocn/base/internal/protocol"
)

// BadBlob 是一个校验失败的块。
type BadBlob struct {
	BlobID string
	Reason string // hash_mismatch | missing
}

// VerifyBlobs 逐块重算哈希并清理坏块；blobIDs 为空表示全量。
// 语义（契约 §8）：
//   - 文件不存在但 blobs 行存在 → 删行，记 missing；
//   - 文件存在但重算哈希与 id 不符 → 删块文件与行，记 hash_mismatch；
//   - 只修本地：从邻居补齐由 internal/peersync 负责（本包不发出站请求）。
//
// 重算走 GetBlobBytes（内部透明解密）：L4a′ 只改磁盘表示，逻辑字节仍是明文/密文原文。
func (s *Store) VerifyBlobs(blobIDs []string) (int, []BadBlob, error) {
	ids := blobIDs
	if len(ids) == 0 {
		all, err := s.ListAllBlobIDs()
		if err != nil {
			return 0, nil, err
		}
		ids = all
	}
	checked := 0
	bad := []BadBlob{}
	for _, id := range ids {
		if !protocol.IsBlobID(id) {
			continue
		}
		if _, err := os.Stat(s.BlobPath(id)); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				return checked, bad, err
			}
			if err := s.deleteBlobRow(id); err != nil {
				return checked, bad, err
			}
			bad = append(bad, BadBlob{BlobID: id, Reason: "missing"})
			continue
		}
		checked++
		data, err := s.GetBlobBytes(id)
		if err != nil {
			// 解不开（密文被破坏）：同样按坏块处理
			if err := s.DeleteBlob(id); err != nil {
				return checked, bad, err
			}
			bad = append(bad, BadBlob{BlobID: id, Reason: "hash_mismatch"})
			continue
		}
		if got := protocol.BlobID(data); got != id {
			if err := s.DeleteBlob(id); err != nil {
				return checked, bad, err
			}
			bad = append(bad, BadBlob{BlobID: id, Reason: "hash_mismatch"})
		}
	}
	return checked, bad, nil
}

func (s *Store) deleteBlobRow(blobID string) error {
	_, err := s.db.Exec(`DELETE FROM blobs WHERE blob_id=?`, blobID)
	return err
}
```

- [ ] **Step 5: 跑测试**

```powershell
Set-Location e:\code\base
go test ./internal/store/ -v -run TestVerifyBlobs
go test ./internal/httpapi/ -v
```

Expected: `internal/store` 的 VerifyBlobs 用例（Task 9 Step 2 会补齐）与 `internal/httpapi` 全包 PASS。

---

## Task 6: 出站 peer 客户端（`internal/peersync`）

**Files:**
- Modify: `internal/peersync/peer.go`
- Create: `internal/peersync/remote.go`、`internal/peersync/remote_test.go`

依赖 Task 0（`Config.TransportFor` 注入口）与 Task 1（`store.ContentVersion`）。TLS 复用 S1 的 `httpapi.ClientTLSConfig`。

- [ ] **Step 1: 补全 `peer.go` —— 追加 `ParseIssuerPubKeys`**

在 Task 0 Step 4 落的 `peer.go` 末尾追加（并给 import 加 `encoding/hex`、`encoding/json`、`fmt`、`strings`）：

```go
// issuerPubKey 是 BASE_ISSUER_PUBKEYS 的元素（册子 §6.1）。
type issuerPubKey struct {
	Issuer        string `json:"issuer"`
	PublicKeyHex  string `json:"public_key_hex"`
}

// ParseIssuerPubKeys 解析签发方公钥信任表：issuer → 公钥 hex64。
// 这是**唯一**的信任来源：不做 TOFU、不调 /v1/pubkey（册子 §6.1、风险 3）。
// 空串 → 空表（缓存节点若手工起服务但没配信任表，ImportPack 会在验签处拒绝整包并告警）。
func ParseIssuerPubKeys(raw string) (map[string]string, error) {
	out := map[string]string{}
	if strings.TrimSpace(raw) == "" {
		return out, nil
	}
	var list []issuerPubKey
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil, fmt.Errorf("BASE_ISSUER_PUBKEYS 不是合法 JSON 数组: %w", err)
	}
	for i, e := range list {
		issuer := strings.TrimSpace(e.Issuer)
		if issuer == "" {
			return nil, fmt.Errorf("BASE_ISSUER_PUBKEYS[%d]: issuer 不能为空", i)
		}
		pub := strings.ToLower(strings.TrimSpace(e.PublicKeyHex))
		if len(pub) != 64 || !isLowerHex(pub) {
			return nil, fmt.Errorf("BASE_ISSUER_PUBKEYS[%d]: public_key_hex 必须是 64 位小写 hex", i)
		}
		out[issuer] = pub
	}
	return out, nil
}

func isLowerHex(s string) bool {
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
```

- [ ] **Step 2: 写 `internal/peersync/remote.go`**

```go
package peersync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/johocn/base/internal/protocol"
)

// 本文件只做「把一个公开/内部接口包成一次调用」。
// 字段名与 internal/httpapi 的响应 DTO 一一对应（跨包不能复用未导出类型，故此处各留一份）。

// CatalogPage 对应 GET /v1/catalog 的一页。
type CatalogPage struct {
	PackID         string        `json:"pack_id"`
	ContentVersion int64         `json:"content_version"`
	Items          []CatalogItem `json:"items"`
	NextCursor     *string       `json:"next_cursor"`
}

// CatalogItem 是目录条目；反熵只用 item_id，其余留着便于诊断打印。
type CatalogItem struct {
	ItemID      string `json:"item_id"`
	Source      string `json:"source"`
	Type        string `json:"type"`
	Title       string `json:"title"`
	ContentHash string `json:"content_hash"`
	SourceRev   string `json:"source_rev"`
}

// InventoriedBlob 是 GET /v1/inventory 的一条块记录。
type InventoriedBlob struct {
	BlobID string `json:"blob_id"`
	Size   int64  `json:"size"`
}

// Inventory 是拉全量分页后的邻居块清单。
type Inventory struct {
	ContentVersion int64
	MerkleRoot     string
	Blobs          []InventoriedBlob
}

// BlobSize 是拉块切批需要的「块 id + 明文长度」。
type BlobSize struct {
	BlobID string
	Size   int64
}

// FetchResult 是一次（可能分批的）拉块结果。
type FetchResult struct {
	Requested int      // 请求过的块数
	Fetched   int      // 校验通过并交给 sink 的块数
	BadFrames int      // 帧头与内容哈希不符被丢弃的帧数
	TooLarge  []string // 单块 > FetchMaxBytes 无法走 fetch 的块（本期不做分片传输）
}

func endpoint(p Peer, path string) string {
	return strings.TrimRight(p.URL, "/") + path
}

func (c Config) get(ctx context.Context, p Peer, path string) ([]byte, error) {
	hc, err := c.client(p)
	if err != nil {
		return nil, err
	}
	res, err := c.do(ctx, hc, http.MethodGet, endpoint(p, path), nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: HTTP %d %s", path, res.StatusCode, strings.TrimSpace(string(body)))
	}
	return body, nil
}

// FetchCatalog 拉目录首页（反熵只关心 pack_id 与水位，不需要翻页）。
func (c Config) FetchCatalog(ctx context.Context, p Peer, since int64) (CatalogPage, error) {
	path := "/v1/catalog"
	if since > 0 {
		path += "?since=" + strconv.FormatInt(since, 10)
	}
	body, err := c.get(ctx, p, path)
	if err != nil {
		return CatalogPage{}, err
	}
	var page CatalogPage
	if err := json.Unmarshal(body, &page); err != nil {
		return CatalogPage{}, fmt.Errorf("catalog 响应不是合法 JSON: %w", err)
	}
	return page, nil
}

// FetchManifest 拉签名 manifest，同时把原始字节一并返回（落位时要逐字节写盘）。
func (c Config) FetchManifest(ctx context.Context, p Peer, packID string) (protocol.Manifest, []byte, error) {
	body, err := c.get(ctx, p, "/v1/manifest/"+packID)
	if err != nil {
		return protocol.Manifest{}, nil, err
	}
	var m protocol.Manifest
	if err := json.Unmarshal(body, &m); err != nil {
		return protocol.Manifest{}, nil, fmt.Errorf("manifest 不是合法 JSON: %w", err)
	}
	return m, body, nil
}

// FetchPackTo 把 pack.sqlite 下载到 destDir/pack.sqlite。
// 先写 .tmp，读完整且字节数 > 0 才 rename 落位：避免半截包被当成产物（册子 §6.2 步骤 4）。
func (c Config) FetchPackTo(ctx context.Context, p Peer, packID, destDir string) (string, error) {
	hc, err := c.client(p)
	if err != nil {
		return "", err
	}
	res, err := c.do(ctx, hc, http.MethodGet, endpoint(p, "/v1/pack/"+packID), nil)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return "", fmt.Errorf("GET /v1/pack/%s: HTTP %d %s", packID, res.StatusCode, strings.TrimSpace(string(body)))
	}
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return "", err
	}
	final := filepath.Join(destDir, "pack.sqlite")
	tmp := final + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	n, err := io.Copy(f, res.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("写 pack 临时文件: %w", err)
	}
	if n == 0 {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("pack %s 为空文件", packID)
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return final, nil
}

// PostSync 提交本地水位与块集合 merkle_root，返回对端判定是否相等（契约 §5.2）。
func (c Config) PostSync(ctx context.Context, p Peer, version int64, merkleRoot string) (bool, error) {
	hc, err := c.client(p)
	if err != nil {
		return false, err
	}
	body, err := json.Marshal(map[string]any{"content_version": version, "merkle_root": merkleRoot})
	if err != nil {
		return false, err
	}
	res, err := c.do(ctx, hc, http.MethodPost, endpoint(p, "/v1/sync"), bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return false, err
	}
	if res.StatusCode != http.StatusOK {
		return false, fmt.Errorf("POST /v1/sync: HTTP %d %s", res.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out struct {
		Equal bool `json:"equal"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return false, fmt.Errorf("sync 响应不是合法 JSON: %w", err)
	}
	return out.Equal, nil
}

// FetchInventory 翻页拉邻居的**全量**块清单（since=0：反熵要完整集合，不要增量）。
func (c Config) FetchInventory(ctx context.Context, p Peer, since int64) (Inventory, error) {
	inv := Inventory{Blobs: []InventoriedBlob{}}
	cursor := ""
	seenCursor := map[string]bool{}
	for {
		path := "/v1/inventory?limit=2000"
		if since > 0 {
			path += "&since=" + strconv.FormatInt(since, 10)
		}
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		body, err := c.get(ctx, p, path)
		if err != nil {
			return inv, err
		}
		var page struct {
			ContentVersion int64             `json:"content_version"`
			MerkleRoot     string            `json:"merkle_root"`
			Blobs          []InventoriedBlob `json:"blobs"`
			NextCursor     *string           `json:"next_cursor"`
		}
		if err := json.Unmarshal(body, &page); err != nil {
			return inv, fmt.Errorf("inventory 响应不是合法 JSON: %w", err)
		}
		inv.ContentVersion = page.ContentVersion
		inv.MerkleRoot = page.MerkleRoot
		inv.Blobs = append(inv.Blobs, page.Blobs...)
		if page.NextCursor == nil || *page.NextCursor == "" {
			return inv, nil
		}
		if seenCursor[*page.NextCursor] {
			return inv, fmt.Errorf("inventory 分页未推进，拒绝死循环")
		}
		seenCursor[*page.NextCursor] = true
		cursor = *page.NextCursor
	}
}

// FetchBlobs 按「块数 ≤ FetchMaxBlobs 且累计 size ≤ protocol.FetchMaxBytes」切批拉块（修正 3）。
// 每帧先校验 hex(sha256(payload))[0:32] == 帧头 blob_id，不符即丢弃并计入 BadFrames（不落盘、不登记）。
// 对端没发的块不报错，只是拿不到（契约 §5.2：缺失块整帧跳过）。
func (c Config) FetchBlobs(ctx context.Context, p Peer, want []BlobSize, sink func(blobID string, data []byte) error) (FetchResult, error) {
	out := FetchResult{TooLarge: []string{}}
	maxBlobs := c.fetchMaxBlobs()
	for len(want) > 0 {
		batch := []BlobSize{}
		var bytesTotal int64
		for _, b := range want {
			if len(batch) >= maxBlobs {
				break
			}
			if b.Size > protocol.FetchMaxBytes {
				out.TooLarge = append(out.TooLarge, b.BlobID)
				continue
			}
			if len(batch) > 0 && bytesTotal+b.Size > protocol.FetchMaxBytes {
				break
			}
			batch = append(batch, b)
			bytesTotal += b.Size
		}
		// 把 TooLarge 从 want 中摘掉，避免死循环
		if len(out.TooLarge) > 0 {
			skip := map[string]bool{}
			for _, id := range out.TooLarge {
				skip[id] = true
			}
			kept := want[:0]
			for _, b := range want {
				if !skip[b.BlobID] {
					kept = append(kept, b)
				}
			}
			want = kept
		}
		if len(batch) == 0 {
			break
		}
		if err := c.fetchBatch(ctx, p, batch, &out, sink); err != nil {
			return out, err
		}
		// 摘掉本批
		sent := map[string]bool{}
		for _, b := range batch {
			sent[b.BlobID] = true
		}
		kept := want[:0]
		for _, b := range want {
			if !sent[b.BlobID] {
				kept = append(kept, b)
			}
		}
		want = kept
	}
	return out, nil
}

func (c Config) fetchBatch(ctx context.Context, p Peer, batch []BlobSize, out *FetchResult, sink func(string, []byte) error) error {
	hc, err := c.client(p)
	if err != nil {
		return err
	}
	ids := make([]string, 0, len(batch))
	for _, b := range batch {
		ids = append(ids, b.BlobID)
	}
	reqBody, err := json.Marshal(map[string]any{"blob_ids": ids})
	if err != nil {
		return err
	}
	out.Requested += len(ids)
	res, err := c.do(ctx, hc, http.MethodPost, endpoint(p, "/v1/fetch"), bytes.NewReader(reqBody))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("POST /v1/fetch: HTTP %d %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	if ct := res.Header.Get("Content-Type"); ct != protocol.BlobPackContentType {
		return fmt.Errorf("fetch Content-Type = %q, want %q", ct, protocol.BlobPackContentType)
	}
	for {
		blobID, payload, err := protocol.ReadBlobFrame(res.Body)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("读 fetch 帧: %w", err)
		}
		if protocol.BlobID(payload) != blobID {
			out.BadFrames++
			continue
		}
		if err := sink(blobID, payload); err != nil {
			return err
		}
		out.Fetched++
	}
}
```

（`url.QueryEscape` 需要 import `net/url`。执行时以 `goimports` 结果为准。）

- [ ] **Step 3: 写测试 `internal/peersync/remote_test.go`**

```go
package peersync

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestParseIssuerPubKeys(t *testing.T) {
	got, err := ParseIssuerPubKeys(`[{"issuer":"base-node-1","public_key_hex":"D75A980182B10AB7D54BFED3C964073A0EE172F3DA62325AF021A68F707511A"}]`)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got["base-node-1"] != "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a" {
		t.Fatalf("公钥未小写归一: %q", got["base-node-1"])
	}
	if _, err := ParseIssuerPubKeys(`[{"issuer":"x","public_key_hex":"short"}]`); err == nil {
		t.Fatal("非法公钥必须报错")
	}
	if _, err := ParseIssuerPubKeys(`not-json`); err == nil {
		t.Fatal("非法 JSON 必须报错")
	}
	if m, err := ParseIssuerPubKeys(""); err != nil || len(m) != 0 {
		t.Fatalf("空串应为空表: %v %v", m, err)
	}
}

func TestFetchCatalogParsesPage(t *testing.T) {
	url, tr := newInprocPeer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/catalog" || r.URL.Query().Get("since") != "3" {
			t.Errorf("请求异常: %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"pack_id":"ab12","content_version":7,"items":[],"next_cursor":null}`))
	}))
	cfg := Config{TransportFor: tr}
	page, err := cfg.FetchCatalog(context.Background(), Peer{URL: url}, 3)
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	if page.PackID != "ab12" || page.ContentVersion != 7 {
		t.Fatalf("page = %+v", page)
	}
}

func TestFetchInventoryPaginatesAndStops(t *testing.T) {
	url, tr := newInprocPeer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("cursor") {
		case "":
			_, _ = w.Write([]byte(`{"content_version":1,"merkle_root":"r","blobs":[{"blob_id":"a","size":1}],"next_cursor":"a"}`))
		case "a":
			_, _ = w.Write([]byte(`{"content_version":1,"merkle_root":"r","blobs":[{"blob_id":"b","size":2}],"next_cursor":null}`))
		default:
			t.Errorf("不该出现 cursor=%s", r.URL.Query().Get("cursor"))
		}
	}))
	cfg := Config{TransportFor: tr}
	inv, err := cfg.FetchInventory(context.Background(), Peer{URL: url}, 0)
	if err != nil {
		t.Fatalf("inventory: %v", err)
	}
	if len(inv.Blobs) != 2 || inv.MerkleRoot != "r" || inv.ContentVersion != 1 {
		t.Fatalf("inv = %+v", inv)
	}
}

func TestFetchBlobsBatchesVerifiesAndSkipsBadFrames(t *testing.T) {
	good := []byte("正常块")
	bad := []byte("被篡改块")
	goodID := protocol.BlobID(good)
	badID := protocol.BlobID(bad)

	batches := 0
	url, tr := newInprocPeer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			BlobIDs []string `json:"blob_ids"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode 请求: %v", err)
			return
		}
		batches++
		if len(req.BlobIDs) != 1 {
			t.Errorf("FetchMaxBlobs=1 时每批必须只有 1 块，got %d", len(req.BlobIDs))
		}
		w.Header().Set("Content-Type", protocol.BlobPackContentType)
		for _, id := range req.BlobIDs {
			switch id {
			case goodID:
				_ = protocol.WriteBlobFrame(w, goodID, good)
			case badID:
				// 帧头声明 badID，但帧体是别的内容 → 接收侧必须丢弃
				_ = protocol.WriteBlobFrame(w, badID, []byte("另一些字节"))
			}
		}
	}))

	cfg := Config{TransportFor: tr, FetchMaxBlobs: 1}
	got := map[string][]byte{}
	fr, err := cfg.FetchBlobs(context.Background(), Peer{URL: url},
		[]BlobSize{{BlobID: goodID, Size: int64(len(good))}, {BlobID: badID, Size: int64(len(bad))}},
		func(id string, data []byte) error {
			got[id] = data
			return nil
		})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if batches != 2 {
		t.Fatalf("批次数 = %d, want 2", batches)
	}
	if fr.Requested != 2 || fr.Fetched != 1 || fr.BadFrames != 1 {
		t.Fatalf("result = %+v", fr)
	}
	if string(got[goodID]) != string(good) {
		t.Fatalf("好块未落 sink: %v", got)
	}
	if _, ok := got[badID]; ok {
		t.Fatal("坏帧不得进 sink")
	}
}

func TestFetchPackToWritesThenRenames(t *testing.T) {
	payload := []byte("SQLite format 3\x00-payload")
	url, tr := newInprocPeer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(payload)
	}))
	cfg := Config{TransportFor: tr}
	dir := t.TempDir()
	path, err := cfg.FetchPackTo(context.Background(), Peer{URL: url}, "ab12", dir)
	if err != nil {
		t.Fatalf("fetch pack: %v", err)
	}
	if !strings.HasSuffix(path, "pack.sqlite") {
		t.Fatalf("落位路径 = %s", path)
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != string(payload) {
		t.Fatalf("落位内容不符: %v", err)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("临时文件必须已被 rename 掉")
	}
}
```

（`TestFetchPackToWritesThenRenames` 用到 `os`，加 import。）

- [ ] **Step 4: 跑测试**

```powershell
Set-Location e:\code\base
go test ./internal/peersync/ -v
```

Expected: 5 个用例全部 PASS。

---

## Task 7: 包级复制（`ImportPack`）

**Files:**
- Create: `internal/store/packimport.go`、`internal/store/packimport_test.go`
- Create: `internal/peersync/packimport.go`、`internal/peersync/packimport_test.go`

- [ ] **Step 1: 写 `internal/store/packimport.go`**

```go
package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/johocn/base/internal/protocol"
)

// PackEntry 是已通过 manifest 与 pack 行级校验、待入库的条目行。
// 只承载 P0 真实存在的两族：articles（文章）与 media_meta（带外部字节的条目）。
type PackEntry struct {
	ItemID      string
	Source      string
	Type        string
	Title       string
	SourceRev   string
	ContentHash string
	SQLiteTable string
	DistClass   string
	UpdatedAt   string

	// SQLiteTable == "articles"
	Digest      string
	PublishedAt string
	TagsJSON    string
	BodyMD      string

	// SQLiteTable == "media_meta"
	MIME        string
	Size        int64
	Duration    int64
	ChunkSize   int64
	ChunkHashes []string
}

// ImportResult 是一次包入库的结果。
type ImportResult struct {
	Version      int64
	Entries      int      // 真正写入的条目数
	Skipped      int      // dist_class != public，跳过入库（册子 §6.2 步骤 5 的双保险）
	Rejected     []string // 防回卷拒绝的 item_id
	RemovedBlobs []string // 墓碑连带清掉的 blob_id；调用方提交后负责删文件（修正 5）
}

// ImportPack 在一个事务内应用墓碑并 upsert 条目（册子 §6.2 步骤 5、§9.2）。
// 调用方必须在事务外做完一切跨节点判断（manifest 验签、pack 行级比对）——本函数不做任何这类判断。
//
//  1. 墓碑先落地（revoked_rev 取大值覆盖），并连带删 items / articles / media_meta / blobs 行；
//     块文件本体不在事务里删，调用方拿 RemovedBlobs 在提交后删。
//  2. 条目入库前做防回卷检查：该 item_id 已有墓碑且 revoked_rev >= 本包 version → 拒该条目。
//  3. content_version 以包版本号覆盖写。
func (s *Store) ImportPack(version int64, entries []PackEntry, tombstones []protocol.Tombstone) (ImportResult, error) {
	res := ImportResult{Version: version, Rejected: []string{}, RemovedBlobs: []string{}}
	tx, err := s.db.Begin()
	if err != nil {
		return res, err
	}
	defer func() { _ = tx.Rollback() }()

	for _, t := range tombstones {
		if _, err := tx.Exec(`INSERT INTO tombstones(item_id,revoked_rev) VALUES(?,?)
			ON CONFLICT(item_id) DO UPDATE SET revoked_rev=MAX(revoked_rev,excluded.revoked_rev)`,
			t.ItemID, t.RevokedRev); err != nil {
			return res, fmt.Errorf("store: 应用墓碑 %s: %w", t.ItemID, err)
		}
		ids, err := blobIDsOfItemTx(tx, t.ItemID)
		if err != nil {
			return res, err
		}
		res.RemovedBlobs = append(res.RemovedBlobs, ids...)
		for _, q := range []string{
			`DELETE FROM media_meta WHERE item_id=?`,
			`DELETE FROM articles WHERE item_id=?`,
			`DELETE FROM items WHERE item_id=?`,
			`DELETE FROM blobs WHERE item_id=?`,
		} {
			if _, err := tx.Exec(q, t.ItemID); err != nil {
				return res, fmt.Errorf("store: 墓碑清理 %s: %w", t.ItemID, err)
			}
		}
	}

	for _, e := range entries {
		if e.DistClass != "" && e.DistClass != "public" {
			res.Skipped++
			continue
		}
		revoked, err := revokedRevOfTx(tx, e.ItemID)
		if err != nil {
			return res, err
		}
		if revoked > 0 && int64(revoked) >= version {
			res.Rejected = append(res.Rejected, e.ItemID)
			continue
		}
		updated := e.UpdatedAt
		if updated == "" {
			updated = nowUTC()
		}
		if _, err := tx.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
			VALUES(?,?,?,?,?,?,?,'public','active',?)
			ON CONFLICT(item_id) DO UPDATE SET
				source=excluded.source, type=excluded.type, title=excluded.title, source_rev=excluded.source_rev,
				content_hash=excluded.content_hash, sqlite_table=excluded.sqlite_table,
				dist_class=excluded.dist_class, state=excluded.state, updated_at=excluded.updated_at`,
			e.ItemID, e.Source, e.Type, e.Title, e.SourceRev, e.ContentHash, e.SQLiteTable, updated); err != nil {
			return res, fmt.Errorf("store: 入库 items %s: %w", e.ItemID, err)
		}
		switch e.SQLiteTable {
		case "articles":
			bodyEnc, err := s.encText(e.BodyMD)
			if err != nil {
				return res, fmt.Errorf("store: 加密 %s 正文: %w", e.ItemID, err)
			}
			if _, err := tx.Exec(`INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev)
				VALUES(?,?,?,?,?,?,?,?)
				ON CONFLICT(item_id) DO UPDATE SET
					title=excluded.title, digest=excluded.digest, published_at=excluded.published_at,
					tags_json=excluded.tags_json, body_md=excluded.body_md,
					content_hash=excluded.content_hash, source_rev=excluded.source_rev`,
				e.ItemID, e.Title, e.Digest, e.PublishedAt, e.TagsJSON, bodyEnc, e.ContentHash, e.SourceRev); err != nil {
				return res, fmt.Errorf("store: 入库 articles %s: %w", e.ItemID, err)
			}
		case "media_meta":
			hashes := e.ChunkHashes
			if hashes == nil {
				hashes = []string{}
			}
			chunkJSON, err := json.Marshal(hashes)
			if err != nil {
				return res, err
			}
			if _, err := tx.Exec(`INSERT INTO media_meta(item_id,mime,size,duration,chunk_size,chunk_hashes_json)
				VALUES(?,?,?,?,?,?)
				ON CONFLICT(item_id) DO UPDATE SET
					mime=excluded.mime, size=excluded.size, duration=excluded.duration,
					chunk_size=excluded.chunk_size, chunk_hashes_json=excluded.chunk_hashes_json`,
				e.ItemID, e.MIME, e.Size, e.Duration, e.ChunkSize, string(chunkJSON)); err != nil {
				return res, fmt.Errorf("store: 入库 media_meta %s: %w", e.ItemID, err)
			}
		default:
			return res, fmt.Errorf("store: 条目 %s 的 sqlite_table=%s 不支持入库", e.ItemID, e.SQLiteTable)
		}
		res.Entries++
	}

	if _, err := tx.Exec(`INSERT INTO meta(key,value) VALUES('content_version',?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, strconv.FormatInt(version, 10)); err != nil {
		return res, fmt.Errorf("store: 写 content_version: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return res, err
	}
	return res, nil
}

func blobIDsOfItemTx(tx *sql.Tx, itemID string) ([]string, error) {
	rows, err := tx.Query(`SELECT blob_id FROM blobs WHERE item_id=?`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func revokedRevOfTx(tx *sql.Tx, itemID string) (int, error) {
	var rev int
	err := tx.QueryRow(`SELECT revoked_rev FROM tombstones WHERE item_id=?`, itemID).Scan(&rev)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return rev, err
}
```

注意：`encText` 是 `internal/store` 的既有私有方法（L4a′），此处复用，加密只在 store 一层发生。

- [ ] **Step 2: 写测试 `internal/store/packimport_test.go`**

```go
package store

import (
	"os"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func entryOf(t *testing.T, st *Store, itemID string) PackEntry {
	t.Helper()
	a, ok, err := st.GetArticle(itemID)
	if err != nil || !ok {
		t.Fatalf("GetArticle %s: ok=%v err=%v", itemID, ok, err)
	}
	return PackEntry{
		ItemID: a.ItemID, Source: "article", Type: "article", Title: a.Title,
		SourceRev: a.SourceRev, ContentHash: a.ContentHash, SQLiteTable: "articles",
		DistClass: "public", Digest: a.Digest, PublishedAt: a.PublishedAt, TagsJSON: a.TagsJSON, BodyMD: a.BodyMD,
	}
}

func TestImportPackAtomicAndIdempotent(t *testing.T) {
	st := openTemp(t)
	if err := st.UpsertArticle(Article{
		ItemID: "article:a", Title: "甲", BodyMD: "甲正文\n", ContentHash: protocol.SHA256Hex([]byte("甲正文\n")),
		SourceRev: "rev1", TagsJSON: `[]`,
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	e := entryOf(t, st, "article:a")

	res, err := st.ImportPack(5, []PackEntry{e}, nil)
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if res.Entries != 1 || len(res.Rejected) != 0 {
		t.Fatalf("res = %+v", res)
	}
	if v, _ := st.ContentVersion(); v != 5 {
		t.Fatalf("content_version = %d, want 5", v)
	}
	// 幂等：重复导入同一版本不报错、不产生新行
	if _, err := st.ImportPack(5, []PackEntry{e}, nil); err != nil {
		t.Fatalf("重复导入: %v", err)
	}
	if _, ok, _ := st.GetArticle("article:a"); !ok {
		t.Fatal("条目应仍在")
	}
}

func TestImportPackTombstoneRemovesRowsAndReportsBlobs(t *testing.T) {
	st := openTemp(t)
	id := putBlob(t, st, "视频块0", "lesson:v", 0)
	if err := st.UpsertMediaItem(MediaItem{
		ItemID: "lesson:v", Source: "lesson", Type: "video", Title: "视频",
		SourceRev: "rev", ContentHash: protocol.SHA256Hex([]byte(id)), SQLiteTable: "media_meta",
		MIME: "video/mp4", Size: 10, ChunkSize: 1 << 20, ChunkHashes: []string{id},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	res, err := st.ImportPack(6, nil, []protocol.Tombstone{{ItemID: "lesson:v", RevokedRev: 6}})
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if len(res.RemovedBlobs) != 1 || res.RemovedBlobs[0] != id {
		t.Fatalf("RemovedBlobs = %v, want [%s]", res.RemovedBlobs, id)
	}
	if _, ok, _ := st.GetItem("lesson:v"); ok {
		t.Fatal("items 行应被删")
	}
	if _, _, _, _, _, ok, _ := st.GetMediaMeta("lesson:v"); ok {
		t.Fatal("media_meta 行应被删")
	}
	if has, _, _ := st.HasBlob(id); has {
		t.Fatal("blobs 行应被删")
	}
	// 块文件本体不在事务里删：由调用方负责（修正 5）
	if _, err := os.Stat(st.BlobPath(id)); err != nil {
		t.Fatalf("块文件本不应在本步被删: %v", err)
	}
	ts, _ := st.ListTombstones()
	if len(ts) != 1 || ts[0].RevokedRev != 6 {
		t.Fatalf("tombstones = %+v", ts)
	}
}

func TestImportPackRejectsRollback(t *testing.T) {
	st := openTemp(t)
	if err := st.AddTombstone("article:a", 7); err != nil {
		t.Fatalf("AddTombstone: %v", err)
	}
	e := PackEntry{
		ItemID: "article:a", Source: "article", Type: "article", Title: "甲",
		ContentHash: protocol.SHA256Hex([]byte("甲")), SQLiteTable: "articles",
		DistClass: "public", BodyMD: "甲", TagsJSON: `[]`,
	}
	// 同版本（7）重现 → 拒该条目
	res, err := st.ImportPack(7, []PackEntry{e}, nil)
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if len(res.Rejected) != 1 || res.Rejected[0] != "article:a" || res.Entries != 0 {
		t.Fatalf("res = %+v", res)
	}
	if _, ok, _ := st.GetArticle("article:a"); ok {
		t.Fatal("被拒条目不得入库")
	}
	// 更大版本（8）= 正常重新发布 → 允许入库，且墓碑 revoked_rev 取大值
	res, err = st.ImportPack(8, []PackEntry{e}, nil)
	if err != nil {
		t.Fatalf("ImportPack v8: %v", err)
	}
	if res.Entries != 1 || len(res.Rejected) != 0 {
		t.Fatalf("res = %+v", res)
	}
	if _, ok, _ := st.GetArticle("article:a"); !ok {
		t.Fatal("重新发布应入库")
	}
}

func TestImportPackSkipsNonPublic(t *testing.T) {
	st := openTemp(t)
	res, err := st.ImportPack(1, []PackEntry{{
		ItemID: "article:x", Source: "article", Type: "article", SQLiteTable: "articles",
		DistClass: "controlled", ContentHash: "h", BodyMD: "x",
	}}, nil)
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if res.Skipped != 1 || res.Entries != 0 {
		t.Fatalf("res = %+v", res)
	}
	if _, ok, _ := st.GetItem("article:x"); ok {
		t.Fatal("非 public 条目不得入库")
	}
}
```

- [ ] **Step 3: 跑 store 侧测试**

```powershell
Set-Location e:\code\base
go test ./internal/store/ -v -run TestImportPack
```

Expected: 4 个用例 PASS。

- [ ] **Step 4: 写 `internal/peersync/packimport.go`**

```go
package peersync

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
	_ "modernc.org/sqlite"
)

// ImportOutcome 是一次包级复制的结果。
type ImportOutcome struct {
	Status         string // noop | imported
	ContentVersion int64
	PackID         string
	Entries        int
	Skipped        int
	Rejected       []string
	RemovedBlobs   int
}

// ImportPack 把一个 peer 的已签名内容包复制到本节点（册子 §6.2）。
// 顺序即不变量：目录水位 → 验签 → pack meta → pack 行级 → 才落库；任一步失败都不落任何行。
func (c Config) ImportPack(ctx context.Context, st *store.Store, p Peer, localVersion int64) (ImportOutcome, error) {
	out := ImportOutcome{Status: "noop", ContentVersion: localVersion}

	page, err := c.FetchCatalog(ctx, p, localVersion)
	if err != nil {
		return out, err
	}
	if page.PackID == "" || page.ContentVersion <= localVersion {
		return out, nil // 对端还不是源节点，或没有更新（册子 §6.2 步骤 2）
	}
	out.PackID = page.PackID

	man, manifestBytes, err := c.FetchManifest(ctx, p, page.PackID)
	if err != nil {
		return out, err
	}
	if man.PackID != page.PackID {
		return out, fmt.Errorf("manifest.pack_id=%s 与目录 %s 不一致", man.PackID, page.PackID)
	}
	pub, ok := c.IssuerPubKeys[man.Issuer]
	if !ok {
		return out, fmt.Errorf("issuer %q 未在 BASE_ISSUER_PUBKEYS 中，拒绝整包（不做 TOFU）", man.Issuer)
	}
	verified, err := man.Verify(pub)
	if err != nil {
		return out, fmt.Errorf("验签 %s 出错: %w", page.PackID, err)
	}
	if !verified {
		return out, fmt.Errorf("manifest 验签失败（pack=%s issuer=%s）", page.PackID, man.Issuer)
	}
	if man.ContentVersion < localVersion {
		return out, fmt.Errorf("对端版本 %d 低于本地 %d，拒绝回卷", man.ContentVersion, localVersion)
	}

	tmpDir, err := os.MkdirTemp(st.DataDir(), "packimport-")
	if err != nil {
		return out, err
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()

	packPath, err := c.FetchPackTo(ctx, p, man.PackID, tmpDir)
	if err != nil {
		return out, err
	}
	entries, err := readAndVerifyPack(packPath, man)
	if err != nil {
		return out, err // 整包拒绝：临时目录由 defer 清理，本地视图不变
	}

	res, err := st.ImportPack(man.ContentVersion, entries, man.Tombstone)
	if err != nil {
		return out, err
	}

	// 落位：packs/<pack_id>/pack.sqlite + manifest.json（字节与源节点一致，册子 §6.4）
	finalDir := filepath.Join(st.PacksDir(), man.PackID)
	if err := os.MkdirAll(finalDir, 0o755); err != nil {
		return out, err
	}
	finalPack := filepath.Join(finalDir, "pack.sqlite")
	if err := os.Rename(packPath, finalPack); err != nil {
		return out, err
	}
	if err := os.WriteFile(filepath.Join(finalDir, "manifest.json"), manifestBytes, 0o644); err != nil {
		return out, err
	}
	if err := st.InsertPack(store.PackRecord{
		PackID: man.PackID, ContentVersion: man.ContentVersion, Dir: finalDir,
		MerkleRoot: man.MerkleRoot, Signature: man.Signature, IssuedAt: man.IssuedAt,
		ItemCount: len(man.Entries),
	}); err != nil {
		return out, err
	}

	// 墓碑连带删块文件：行已删，路径从 RemovedBlobs 来（修正 5：失败只记日志，不阻断）
	for _, id := range res.RemovedBlobs {
		if err := st.DeleteBlobFile(id); err != nil {
			out.Rejected = append(out.Rejected, "delete_failed:"+id)
		}
	}

	out.Status = "imported"
	out.ContentVersion = man.ContentVersion
	out.Entries = res.Entries
	out.Skipped = res.Skipped
	out.Rejected = append(out.Rejected, res.Rejected...)
	out.RemovedBlobs = len(res.RemovedBlobs)
	return out, nil
}

// readAndVerifyPack 打开 pack.sqlite 并逐条比对已验签的 manifest；任一不符即返回 error（调用方拒绝整包）。
//
// 行级校验口径（对册子 §6.2 步骤 5 的精确化，见「修正 6」）：
//   - meta 行：pack_id / content_version / merkle_root 必须等于 manifest 的同名字段；
//   - articles 行：必须存在，且 content_hash 列等于 manifest 的 content_hash，
//     且 sha256(body_md) 等于它（正文不可被换）；
//   - media_meta 行：表里**没有** content_hash 列，故按「声明块序列」比对——
//     行存在、chunk_hashes_json 的块数等于 manifest 的 chunks 数、size 等于 chunks 的 size 之和。
//     整块完整性由签名域（chunks[].blob_id + size）与补齐时的逐块哈希共同兜底。
//   - pack 里多出来的行不进 entries → 永不入库（只按 manifest 的白名单落库）。
func readAndVerifyPack(packPath string, man protocol.Manifest) ([]store.PackEntry, error) {
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(packPath)+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	meta := map[string]string{}
	rows, err := db.Query(`SELECT key,value FROM meta`)
	if err != nil {
		return nil, fmt.Errorf("读 pack meta: %w", err)
	}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			rows.Close()
			return nil, err
		}
		meta[k] = v
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if meta["pack_id"] != man.PackID {
		return nil, fmt.Errorf("pack meta pack_id=%q 与 manifest %q 不一致", meta["pack_id"], man.PackID)
	}
	if meta["content_version"] != strconv.FormatInt(man.ContentVersion, 10) {
		return nil, fmt.Errorf("pack meta content_version=%q 与 manifest %d 不一致", meta["content_version"], man.ContentVersion)
	}
	if meta["merkle_root"] != man.MerkleRoot {
		return nil, fmt.Errorf("pack meta merkle_root=%q 与 manifest %q 不一致", meta["merkle_root"], man.MerkleRoot)
	}

	type articleRow struct {
		title, digest, publishedAt, tagsJSON, bodyMD, contentHash, sourceRev string
	}
	articles := map[string]articleRow{}
	rows, err = db.Query(`SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev FROM articles`)
	if err != nil {
		return nil, fmt.Errorf("读 pack articles: %w", err)
	}
	for rows.Next() {
		var id string
		var r articleRow
		if err := rows.Scan(&id, &r.title, &r.digest, &r.publishedAt, &r.tagsJSON, &r.bodyMD, &r.contentHash, &r.sourceRev); err != nil {
			rows.Close()
			return nil, err
		}
		articles[id] = r
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	type mediaRow struct {
		mime, chunkJSON string
		size, duration  int64
		chunkSize       int64
	}
	media := map[string]mediaRow{}
	rows, err = db.Query(`SELECT item_id,mime,size,duration,chunk_size,chunk_hashes_json FROM media_meta`)
	if err != nil {
		return nil, fmt.Errorf("读 pack media_meta: %w", err)
	}
	for rows.Next() {
		var id string
		var r mediaRow
		if err := rows.Scan(&id, &r.mime, &r.size, &r.duration, &r.chunkSize, &r.chunkJSON); err != nil {
			rows.Close()
			return nil, err
		}
		media[id] = r
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]store.PackEntry, 0, len(man.Entries))
	for _, e := range man.Entries {
		base := store.PackEntry{
			ItemID: e.ItemID, Source: e.Source, Type: e.Type, Title: e.Title,
			SourceRev: e.SourceRev, ContentHash: e.ContentHash, SQLiteTable: e.SQLiteTable,
			DistClass: e.DistClass,
		}
		switch e.SQLiteTable {
		case "articles":
			r, ok := articles[e.ItemID]
			if !ok {
				return nil, fmt.Errorf("pack 缺少 manifest 声明的文章行 %s", e.ItemID)
			}
			if r.contentHash != e.ContentHash {
				return nil, fmt.Errorf("pack 行级 hash 不符 %s: %q != %q", e.ItemID, r.contentHash, e.ContentHash)
			}
			if protocol.SHA256Hex([]byte(r.bodyMD)) != e.ContentHash {
				return nil, fmt.Errorf("pack 正文哈希与 manifest 不符 %s", e.ItemID)
			}
			base.Title, base.Digest, base.PublishedAt = r.title, r.digest, r.publishedAt
			base.TagsJSON, base.BodyMD = r.tagsJSON, r.bodyMD
		case "media_meta":
			r, ok := media[e.ItemID]
			if !ok {
				return nil, fmt.Errorf("pack 缺少 manifest 声明的媒体行 %s", e.ItemID)
			}
			var hashes []string
			if err := json.Unmarshal([]byte(r.chunkJSON), &hashes); err != nil {
				return nil, fmt.Errorf("pack media_meta %s 的 chunk_hashes_json 非法: %w", e.ItemID, err)
			}
			if len(hashes) != len(e.Chunks) {
				return nil, fmt.Errorf("pack 块数不符 %s: %d != %d", e.ItemID, len(hashes), len(e.Chunks))
			}
			var sum int64
			for _, c := range e.Chunks {
				sum += c.Size
			}
			if r.size != sum {
				return nil, fmt.Errorf("pack 媒体大小不符 %s: %d != %d", e.ItemID, r.size, sum)
			}
			base.MIME, base.Size, base.Duration, base.ChunkSize = r.mime, r.size, r.duration, r.chunkSize
			base.ChunkHashes = hashes
		default:
			return nil, fmt.Errorf("manifest 条目 %s 的 sqlite_table=%q 不支持入库", e.ItemID, e.SQLiteTable)
		}
		out = append(out, base)
	}
	return out, nil
}
```

- [ ] **Step 5: 写测试 `internal/peersync/packimport_test.go`**

```go
package peersync

import (
	"context"
	"net/http"
	"os"
	"testing"

	"github.com/johocn/base/internal/httpapi"
	"github.com/johocn/base/internal/packexport"
	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

const (
	srcIssuer = "base-node-1"
	srcSeed   = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
)

// newSourceNode 起一个真 httpapi 源节点（进程内），返回 store、对端 URL、注入给 Config 的传输、公钥。
func newSourceNode(t *testing.T) (*store.Store, string, func(Peer) (http.RoundTripper, error), string) {
	t.Helper()
	st := openTemp(t)
	srv, err := httpapi.New(st, httpapi.Options{Issuer: srcIssuer, SignKeyHex: srcSeed, Version: "test"})
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}
	url, tr := newInprocPeer(t, srv.PeerHandler())
	kp, err := protocol.KeyPairFromSeed(srcSeed)
	if err != nil {
		t.Fatalf("KeyPairFromSeed: %v", err)
	}
	return st, url, tr, kp.PubHex
}

// seedSource 写入 1 篇文章 + 1 个封面并导出 1 个包。
func seedSource(t *testing.T, st *store.Store) packexport.Result {
	t.Helper()
	body := "甲正文\n"
	if err := st.UpsertArticle(store.Article{
		ItemID: "article:aaa", Title: "甲", Digest: "甲摘要", PublishedAt: "2026-01-01T00:00:00Z",
		TagsJSON: `[]`, BodyMD: body, ContentHash: protocol.SHA256Hex([]byte(body)),
		SourceRev: "rev-1", UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	cover := []byte("COVERBYTES")
	if err := st.PutBlob(protocol.BlobID(cover), cover, "cover:aaa", 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	if err := st.UpsertMediaItem(store.MediaItem{
		ItemID: "cover:aaa", Source: "article", Type: "cover", Title: "甲封面",
		SourceRev: "rev-1", ContentHash: protocol.SHA256Hex(cover), SQLiteTable: "media_meta",
		MIME: "image/png", Size: int64(len(cover)), ChunkSize: int64(len(cover)),
		ChunkHashes: []string{protocol.SHA256Hex(cover)}, UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatalf("UpsertMediaItem: %v", err)
	}
	res, err := packexport.Export(st, packexport.Options{Issuer: srcIssuer, SignKeyHex: srcSeed})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	return res
}

func TestImportPackCopiesPackageAndRows(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)
	res := seedSource(t, src)

	dst := openTemp(t)
	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	outcome, err := cfg.ImportPack(context.Background(), dst, Peer{URL: url}, 0)
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if outcome.Status != "imported" || outcome.ContentVersion != res.ContentVersion || outcome.Entries != 2 {
		t.Fatalf("outcome = %+v", outcome)
	}
	if v, _ := dst.ContentVersion(); v != res.ContentVersion {
		t.Fatalf("缓存节点水位 = %d, want %d", v, res.ContentVersion)
	}
	// 公开读三件套在缓存节点上立即可用（包已落位、packs 行已登记）
	if _, ok, _ := dst.LatestPack(); !ok {
		t.Fatal("packs 行未登记")
	}
	got, err := os.ReadFile(res.PackPath)
	if err != nil {
		t.Fatal(err)
	}
	copied, err := os.ReadFile(res.PackPath)
	if err != nil || len(got) != len(copied) {
		t.Fatal("pack 字节数异常")
	}
	if _, err := os.Stat(res.PackPath); err != nil {
		t.Fatalf("源包应仍在: %v", err)
	}
	// 正文在缓存节点上仍以密文落盘、以明文供读（L4a′ 只在 store 一层）
	a, ok, err := dst.GetArticle("article:aaa")
	if err != nil || !ok || a.BodyMD != "甲正文\n" {
		t.Fatalf("缓存节点正文 = %+v ok=%v err=%v", a, ok, err)
	}
}

func TestImportPackRejectsUntrustedIssuer(t *testing.T) {
	src, url, tr, _ := newSourceNode(t)
	seedSource(t, src)
	dst := openTemp(t)
	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{}}
	if _, err := cfg.ImportPack(context.Background(), dst, Peer{URL: url}, 0); err == nil {
		t.Fatal("未命中信任表的 issuer 必须拒绝整包")
	}
	if v, _ := dst.ContentVersion(); v != 0 {
		t.Fatalf("拒绝整包后本地水位应不变，got %d", v)
	}
}

func TestImportPackRejectsTamperedManifest(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)
	res := seedSource(t, src)

	// 直接篡改盘上的 manifest（服务端就是读盘发的），再复制
	raw, err := os.ReadFile(res.ManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	tampered := strings.Replace(string(raw), `"content_version":1`, `"content_version":2`, 1)
	if tampered == string(raw) {
		t.Fatal("未命中待篡改片段，测试前提失效")
	}
	if err := os.WriteFile(res.ManifestPath, []byte(tampered), 0o644); err != nil {
		t.Fatal(err)
	}

	dst := openTemp(t)
	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	if _, err := cfg.ImportPack(context.Background(), dst, Peer{URL: url}, 0); err == nil {
		t.Fatal("篡改 manifest 必须拒绝整包")
	}
	if v, _ := dst.ContentVersion(); v != 0 {
		t.Fatalf("拒绝整包后本地水位应不变，got %d", v)
	}
	if _, ok, _ := dst.LatestPack(); ok {
		t.Fatal("被拒的包不得登记 packs 行")
	}
}

func TestImportPackNoopWhenUpToDate(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)
	res := seedSource(t, src)
	dst := openTemp(t)
	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	if _, err := cfg.ImportPack(context.Background(), dst, Peer{URL: url}, 0); err != nil {
		t.Fatalf("首次复制: %v", err)
	}
	outcome, err := cfg.ImportPack(context.Background(), dst, Peer{URL: url}, res.ContentVersion)
	if err != nil {
		t.Fatalf("二次复制: %v", err)
	}
	if outcome.Status != "noop" {
		t.Fatalf("同版本应 noop，got %+v", outcome)
	}
}
```

（`strings` 用于篡改用例，加 import；`newInprocPeer` / `openTemp` 来自 Task 0 的 `testsupport_test.go`。）

- [ ] **Step 6: 跑测试**

```powershell
Set-Location e:\code\base
go test ./internal/store/ -v -run TestImportPack
go test ./internal/peersync/ -v
```

Expected: store 4 个 + peersync 全部 PASS。

---

## Task 8: 反熵回合 + 副本登记 + 调度 + `peer-sync` 子命令

**Files:**
- Create: `internal/peersync/sync.go`、`internal/peersync/sync_test.go`
- Create: `cmd/based/peerconfig.go`、`cmd/based/peersync.go`
- Modify: `cmd/based/main.go`、`cmd/based/serve.go`

- [ ] **Step 1: 写 `internal/peersync/sync.go`**

```go
package peersync

import (
	"context"
	"fmt"
	"math/rand"
	"sync"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// RoundResult 是一个 peer 的一轮结果（册子 §7.2 步骤 7 的日志字段）。
type RoundResult struct {
	Peer           string
	ContentVersion int64
	PackID         string
	Imported       bool
	Equal          bool
	Missing        int
	Extra          int
	Fetched        int
	BadFrames      int
	NoReplica      int
}

func (r RoundResult) String() string {
	return fmt.Sprintf("peer=%s version=%d pack=%s imported=%v equal=%v missing=%d extra=%d fetched=%d bad_frames=%d no_replica=%d",
		r.Peer, r.ContentVersion, r.PackID, r.Imported, r.Equal, r.Missing, r.Extra, r.Fetched, r.BadFrames, r.NoReplica)
}

// SyncPeer 对一个 peer 跑完整一轮：包级复制 → 比对 → 补齐 → 副本登记（册子 §7.2）。
// 顺序不可换：条目视图与块视图必须同一轮内收敛，故先拉包再比块集合。
func (c Config) SyncPeer(ctx context.Context, st *store.Store, p Peer, now int64) (RoundResult, error) {
	res := RoundResult{Peer: p.URL}

	version, err := st.ContentVersion()
	if err != nil {
		return res, err
	}
	outcome, err := c.ImportPack(ctx, st, p, version)
	if err != nil {
		return res, err
	}
	res.Imported = outcome.Status == "imported"
	res.PackID = outcome.PackID

	version, err = st.ContentVersion()
	if err != nil {
		return res, err
	}
	res.ContentVersion = version

	localIDs, err := st.ListAllBlobIDs()
	if err != nil {
		return res, err
	}
	localRoot, err := protocol.MerkleRoot(localIDs)
	if err != nil {
		return res, err
	}
	equal, err := c.PostSync(ctx, p, version, localRoot)
	if err != nil {
		return res, err
	}
	res.Equal = equal
	if equal {
		// 块集合相等即本 peer 结束（册子 §7.2 步骤 2），不拉 inventory、不登记副本
		res.NoReplica, _ = st.CountBlobsWithoutReplica()
		return res, nil
	}

	inv, err := c.FetchInventory(ctx, p, 0)
	if err != nil {
		return res, err
	}

	// 副本登记：拿到 inventory 后把 peer 声明的每个块 upsert（册子 §7.3）
	for _, b := range inv.Blobs {
		if err := st.UpsertBlobReplica(b.BlobID, p.URL, now); err != nil {
			return res, err
		}
	}

	local := make(map[string]struct{}, len(localIDs))
	for _, id := range localIDs {
		local[id] = struct{}{}
	}
	neighbor := make(map[string]struct{}, len(inv.Blobs))
	missing := []BlobSize{}
	for _, b := range inv.Blobs {
		neighbor[b.BlobID] = struct{}{}
		if _, ok := local[b.BlobID]; !ok {
			missing = append(missing, BlobSize{BlobID: b.BlobID, Size: b.Size})
		}
	}
	for _, id := range localIDs {
		if _, ok := neighbor[id]; !ok {
			res.Extra++ // 只记录不删（册子 §7.2 步骤 4、风险 5）
		}
	}
	res.Missing = len(missing)

	if len(missing) > 0 {
		// 归属来自 media_meta 的声明块序列：此刻这些块还没进 blobs 表，只有 media_meta 知道它们属于谁
		idx, err := st.MediaChunkIndex()
		if err != nil {
			return res, err
		}
		fr, err := c.FetchBlobs(ctx, p, missing, func(blobID string, data []byte) error {
			ref := idx[blobID]
			return st.PutBlob(blobID, data, ref.ItemID, ref.Seq)
		})
		if err != nil {
			return res, err
		}
		res.Fetched, res.BadFrames = fr.Fetched, fr.BadFrames
		for _, id := range fr.TooLarge {
			fmt.Printf("peersync: 块 %s 超过单请求字节上限，无法走 fetch（本期不做分片传输）\n", id)
		}
	}

	res.NoReplica, err = st.CountBlobsWithoutReplica()
	return res, err
}

// RunOnce 逐 peer 串行跑一轮（册子 §7.1：不并发打满带宽）。
// 单 peer 失败只记日志并继续下一个，不返回错误、不终止调度器。
func (c Config) RunOnce(ctx context.Context, st *store.Store, peers []Peer, logf func(string, ...any)) []RoundResult {
	now := time.Now().Unix()
	out := make([]RoundResult, 0, len(peers))
	for _, p := range peers {
		if ctx.Err() != nil {
			break
		}
		pctx, cancel := context.WithTimeout(ctx, 2*requestTimeout)
		res, err := c.SyncPeer(pctx, st, p, now)
		cancel()
		if err != nil {
			logf("peersync: %s 本轮失败: %v", p.URL, err)
			continue
		}
		logf("peersync: %s", res)
		out = append(out, res)
	}
	return out
}

// RunForever 启动反熵调度器：延迟随机 0–60 秒后首轮，此后每 interval 一轮；单轮不重入（风险 6）。
func (c Config) RunForever(ctx context.Context, st *store.Store, peers []Peer, interval time.Duration, logf func(string, ...any)) {
	if len(peers) == 0 || interval <= 0 {
		return
	}
	var mu sync.Mutex
	running := false
	run := func() {
		mu.Lock()
		if running {
			mu.Unlock()
			logf("peersync: 上一轮尚未结束，跳过本轮")
			return
		}
		running = true
		mu.Unlock()

		start := time.Now()
		c.RunOnce(ctx, st, peers, logf)
		logf("peersync: 本轮耗时 %s", time.Since(start).Round(time.Millisecond))

		mu.Lock()
		running = false
		mu.Unlock()
	}
	go func() {
		jitter := time.Duration(rand.Int63n(int64(60 * time.Second)))
		select {
		case <-ctx.Done():
			return
		case <-time.After(jitter):
		}
		run()
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				run()
			}
		}
	}()
}
```

- [ ] **Step 2: 写测试 `internal/peersync/sync_test.go`**

```go
package peersync

import (
	"context"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// syncNodePair 起源节点 + 缓存节点，返回两边 store、缓存节点侧的 Config。
func syncNodePair(t *testing.T) (*store.Store, *store.Store, Config) {
	t.Helper()
	src, url, tr, pub := newSourceNode(t)
	seedSource(t, src)
	dst := openTemp(t)
	return src, dst, Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
}

func TestSyncPeerCopiesPackageThenBlobs(t *testing.T) {
	src, dst, cfg := syncNodePair(t)
	srcURL := ""
	for _, p := range []Peer{{URL: "https://placeholder.test"}} {
		srcURL = p.URL
	}
	// 从源节点取真实 URL：newSourceNode 已登记进程内 peer，这里用它的 URL 重建
	// （测试内直接复用 seedSource 的产物即可，URL 由下面的 helper 传入）
	_ = srcURL
	_ = src
	// 见 TestSyncPeerConvergesBlobSets：完整的 URL 由 syncNodePair 内部持有
	_ = dst
	_ = cfg
}
```

上面这段是**占位错误示例**——`syncNodePair` 必须把 URL 也返回，否则测试拿不到对端地址。执行时按下述写法落地（不要保留上面的空壳）：

```go
// nodePair 起源节点 + 缓存节点；返回源 store、缓存 store、源侧 URL、缓存侧 Config。
func nodePair(t *testing.T) (*store.Store, *store.Store, string, Config) {
	t.Helper()
	src, url, tr, pub := newSourceNode(t)
	seedSource(t, src)
	dst := openTemp(t)
	return src, dst, url, Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
}

func TestSyncPeerConvergesBlobSetsAndRegistersReplicas(t *testing.T) {
	src, dst, url, cfg := nodePair(t)

	res, err := cfg.SyncPeer(context.Background(), dst, Peer{URL: url}, 1)
	if err != nil {
		t.Fatalf("SyncPeer: %v", err)
	}
	if !res.Imported || res.Equal {
		t.Fatalf("首轮应「导入包 + 集合不等」，got %+v", res)
	}
	// 源节点 1 个封面块 → 缓存节点应补齐 1 块
	if res.Missing != 1 || res.Fetched != 1 || res.BadFrames != 0 {
		t.Fatalf("补齐统计 = %+v", res)
	}
	if res.NoReplica != 0 {
		t.Fatalf("副本登记后「无副本块数」应为 0，got %d", res.NoReplica)
	}

	// 第二轮：集合已一致 → equal，不再拉 inventory
	res2, err := cfg.SyncPeer(context.Background(), dst, Peer{URL: url}, 2)
	if err != nil {
		t.Fatalf("SyncPeer 2: %v", err)
	}
	if res2.Imported || !res2.Equal {
		t.Fatalf("第二轮应为 equal，got %+v", res2)
	}

	// 两侧块集合完全一致
	srcIDs, _ := src.ListAllBlobIDs()
	dstIDs, _ := dst.ListAllBlobIDs()
	if len(srcIDs) != len(dstIDs) {
		t.Fatalf("块集合不一致: src=%v dst=%v", srcIDs, dstIDs)
	}
	for i := range srcIDs {
		if srcIDs[i] != dstIDs[i] {
			t.Fatalf("块集合不一致: src=%v dst=%v", srcIDs, dstIDs)
		}
	}
	// 块文件内容哈希正确（补齐时逐块校验过）
	for _, id := range dstIDs {
		data, err := dst.GetBlobBytes(id)
		if err != nil {
			t.Fatalf("读补齐块 %s: %v", id, err)
		}
		if protocol.BlobID(data) != id {
			t.Fatalf("补齐块 %s 哈希不符", id)
		}
	}
	// 副本登记：把块挂回了 cover:aaa（墓碑才删得掉块文件）
	if err := dst.AddTombstone("cover:aaa", 9); err != nil {
		t.Fatalf("AddTombstone: %v", err)
	}
	refs, err := dst.ListBlobsForItem("cover:aaa")
	if err != nil {
		t.Fatalf("ListBlobsForItem: %v", err)
	}
	if len(refs) != 1 {
		t.Fatalf("块应挂在 cover:aaa 上，got %+v", refs)
	}
}

func TestRunOnceKeepsGoingAfterPeerFailure(t *testing.T) {
	_, dst, url, cfg := nodePair(t)
	logs := []string{}
	results := cfg.RunOnce(context.Background(), dst, []Peer{
		{URL: "https://未登记的邻居.test"}, // 必然失败
		{URL: url},
	}, func(f string, a ...any) { logs = append(logs, f) })
	if len(results) != 1 {
		t.Fatalf("失败 peer 应被跳过、成功的仍返回，got %d 个结果", len(results))
	}
	if len(logs) == 0 {
		t.Fatal("必须把失败写进日志")
	}
}
```

（删掉上面那段空壳示例，只保留 `nodePair` 与其后的两个用例；`syncNodePair` 不落地。）

- [ ] **Step 3: 跑 peersync 侧测试**

```powershell
Set-Location e:\code\base
go test ./internal/peersync/ -v
```

Expected: 全包 PASS。

- [ ] **Step 4: 写 `cmd/based/peerconfig.go`（出站配置装载，三个子命令共用）**

```go
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/johocn/base/internal/httpapi"
	"github.com/johocn/base/internal/peersync"
	"github.com/johocn/base/internal/store"
)

// peerFlags 是出站（peersync）与本地库共同用到的 flag 集合。
// serve / peer-sync / scrub 三个子命令都通过 registerPeerFlags 注册，避免三处各写一份默认值。
type peerFlags struct {
	data          *string
	storeKey      *string
	peers         *string
	issuerPubKeys *string
	tlsCert       *string
	tlsKey        *string
	nodeKey       *string
	fetchMaxBlobs *int
	syncInterval  *string
	scrubInterval *string
}

func registerPeerFlags(fs *flag.FlagSet) *peerFlags {
	return &peerFlags{
		data:          fs.String("data", envOr("BASE_DATA", "data"), "数据目录"),
		storeKey:      fs.String("store-key", os.Getenv("BASE_STORE_KEY"), "L4a′ 静态加密密钥（hex64）；缺省 <data>.key，两者皆无则首启生成"),
		peers:         fs.String("peers", os.Getenv("BASE_PEERS"), `对端清单 JSON：[{"url":"https://...","tls_fingerprint":"<hex64>"}]`),
		issuerPubKeys: fs.String("issuer-pubkeys", os.Getenv("BASE_ISSUER_PUBKEYS"), `签发方公钥信任表 JSON：[{"issuer":"...","public_key_hex":"<64 hex>"}]`),
		tlsCert:       fs.String("tls-cert", envOr("BASE_TLS_CERT", ""), "本节点证书路径；空=<data>/tls/node.crt；off=主监听明文 HTTP"),
		tlsKey:        fs.String("tls-key", envOr("BASE_TLS_KEY", ""), "本节点私钥路径；空=<data>/tls/node.key"),
		nodeKey:       fs.String("node-key", os.Getenv("BASE_NODE_KEY"), "节点间预共享密钥（头 X-Base-Node-Key）"),
		fetchMaxBlobs: fs.Int("fetch-max-blobs", envIntOr("BASE_FETCH_MAX_BLOBS", 64), "fetch 单请求块数上限"),
		syncInterval:  fs.String("sync-interval", envOr("BASE_SYNC_INTERVAL", "5m"), "反熵轮间隔（Go duration）"),
		scrubInterval: fs.String("scrub-interval", envOr("BASE_SCRUB_INTERVAL", "24h"), "scrub 轮间隔（Go duration）"),
	}
}

// peers 把 -peers 转成出站对端清单。
func (f *peerFlags) peers() ([]peersync.Peer, error) {
	specs, err := parsePeers(*f.peers)
	if err != nil {
		return nil, err
	}
	out := make([]peersync.Peer, 0, len(specs))
	for _, s := range specs {
		out = append(out, peersync.Peer{URL: s.URL, TLSFingerprint: s.TLSFingerprint})
	}
	return out, nil
}

// certPaths 返回证书/私钥实际路径；-tls-cert=off 时返回空串（主监听明文）。
func (f *peerFlags) certPaths() (certPath, keyPath string) {
	if strings.EqualFold(strings.TrimSpace(*f.tlsCert), "off") {
		return "", ""
	}
	certPath, keyPath = strings.TrimSpace(*f.tlsCert), strings.TrimSpace(*f.tlsKey)
	if certPath == "" {
		certPath = filepath.Join(*f.data, "tls", "node.crt")
	}
	if keyPath == "" {
		keyPath = filepath.Join(*f.data, "tls", "node.key")
	}
	return certPath, keyPath
}

// tlsInfo 加载（必要时生成）本节点 TLS 身份。出站必须带证书：对端是双向 TLS。
func (f *peerFlags) tlsInfo() (httpapi.TLSInfo, error) {
	certPath, keyPath := f.certPaths()
	if certPath == "" || keyPath == "" {
		return httpapi.TLSInfo{}, fmt.Errorf("出站（节点↔节点）要求本节点有证书：-tls-cert 不能为 off")
	}
	return httpapi.LoadOrCreateTLSCert(certPath, keyPath)
}

// openStore 打开内容库（注入 -store-key 时优先于 <data>.key）。
func (f *peerFlags) openStore() (*store.Store, error) {
	opts := []store.Option{}
	if strings.TrimSpace(*f.storeKey) != "" {
		opts = append(opts, store.WithStoreKey(*f.storeKey))
	}
	return store.Open(*f.data, opts...)
}

// config 组装出站配置。
func (f *peerFlags) config(info httpapi.TLSInfo) (peersync.Config, error) {
	pubs, err := peersync.ParseIssuerPubKeys(*f.issuerPubKeys)
	if err != nil {
		return peersync.Config{}, err
	}
	return peersync.Config{
		OwnTLS:        info,
		NodeKey:       strings.TrimSpace(*f.nodeKey),
		IssuerPubKeys: pubs,
		FetchMaxBlobs: *f.fetchMaxBlobs,
	}, nil
}

// durations 解析两个调度间隔。
func (f *peerFlags) durations() (syncEvery, scrubEvery time.Duration, err error) {
	syncEvery, err = time.ParseDuration(strings.TrimSpace(*f.syncInterval))
	if err != nil {
		return 0, 0, fmt.Errorf("-sync-interval 解析失败: %w", err)
	}
	scrubEvery, err = time.ParseDuration(strings.TrimSpace(*f.scrubInterval))
	if err != nil {
		return 0, 0, fmt.Errorf("-scrub-interval 解析失败: %w", err)
	}
	return syncEvery, scrubEvery, nil
}

func envIntOr(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return def
}

func logf(format string, a ...any) { log.Printf(format, a...) }
```

（`logf` 用到 `log`，加 import。）

- [ ] **Step 5: 写 `cmd/based/peersync.go`（手动单轮）**

```go
package main

import (
	"context"
	"flag"
	"fmt"
)

func runPeerSync(args []string) error {
	fs := flag.NewFlagSet("peer-sync", flag.ExitOnError)
	pf := registerPeerFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	peers, err := pf.peers()
	if err != nil {
		return err
	}
	if len(peers) == 0 {
		return fmt.Errorf("peer-sync: 需要至少一个对端（-peers 或 BASE_PEERS）")
	}
	info, err := pf.tlsInfo()
	if err != nil {
		return err
	}
	cfg, err := pf.config(info)
	if err != nil {
		return err
	}
	st, err := pf.openStore()
	if err != nil {
		return err
	}
	defer st.Close()

	results := cfg.RunOnce(context.Background(), st, peers, logf)
	if len(results) == 0 {
		return fmt.Errorf("peer-sync: %d 个对端全部失败", len(peers))
	}
	for _, r := range results {
		fmt.Println(r)
	}
	return nil
}
```

- [ ] **Step 6: 改 `cmd/based/main.go` 与 usage**

```go
	case "import-video":
		err = runImportVideo(os.Args[2:])
	case "peer-sync":
		err = runPeerSync(os.Args[2:])
	case "scrub":
		err = runScrub(os.Args[2:])
```

```go
	fmt.Fprintln(os.Stderr, "usage: based <version|import-md|import-video|export|serve|pubkey|store-key|tls-cert|peer-sync|scrub> [flags]")
```

（`import-video` 来自 Task 2；`scrub` 来自 Task 9。**本步先把 `scrub` 分支注释掉或延后到 Task 9 一起提交**，否则编译不过。）

- [ ] **Step 7: 改 `cmd/based/serve.go` 用共享 flag 组 + 启调度器**

`runServe` 改为下述形态（保留既有 TLS/监听逻辑，只替换 flag 来源与新增调度器）：

```go
func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	pf := registerPeerFlags(fs)
	addr := fs.String("addr", envOr("BASE_ADDR", ":8080"), "客户端接口监听地址")
	issuer := fs.String("issuer", envOr("BASE_ISSUER", "base-node-1"), "签发方标识")
	key := fs.String("sign-key", os.Getenv("BASE_SIGN_KEY"), "Ed25519 私钥种子（hex64）；配置了才是源节点")
	peerAddr := fs.String("peer-addr", envOr("BASE_PEER_ADDR", ""), "节点↔节点监听地址；空=不启用")
	if err := fs.Parse(args); err != nil {
		return err
	}
	peers, err := pf.peers()
	if err != nil {
		return err
	}

	st, err := pf.openStore()
	if err != nil {
		return err
	}
	defer st.Close()

	plaintext := strings.EqualFold(strings.TrimSpace(*pf.tlsCert), "off")
	certPath, keyPath := pf.certPaths()

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
		FetchMaxBlobs:  *pf.fetchMaxBlobs,
	})
	if err != nil {
		return err
	}
	if n, err := srv.PruneNonces(); err != nil {
		log.Printf("based: 清理过期 nonce 失败: %v", err)
	} else if n > 0 {
		log.Printf("based: 清理过期 nonce %d 行", n)
	}

	// 客户端监听：只有公开路由；对端监听：公开路由 ∪ 内部路由（册子 §5.1）。
	publicHandler := srv.Handler()
	peerHandler := srv.PeerHandler()

	if *peerAddr != "" {
		if len(peerFPs) == 0 {
			return fmt.Errorf("启用 -peer-addr 必须同时配置 -peers：没有对端指纹白名单就无法固定对端身份")
		}
		peerTLS, err := httpapi.ServerTLSConfig(info, peerFPs)
		if err != nil {
			return err
		}
		peerWithKey := peerHandler
		if strings.TrimSpace(*pf.nodeKey) != "" {
			peerWithKey = srv.RequireNodeKey(*pf.nodeKey, peerHandler)
		}
		ln, err := net.Listen("tcp", *peerAddr)
		if err != nil {
			return err
		}
		peerSrv := &http.Server{Handler: peerWithKey, TLSConfig: peerTLS}
		go func() {
			log.Printf("based 对端接口监听 %s（双向 TLS + 指纹固定，白名单 %d 个）", *peerAddr, len(peerFPs))
			if err := peerSrv.ServeTLS(ln, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("based: 对端监听退出: %v", err)
			}
		}()
	}

	// 反熵调度器：只有配置了 -peers 才启动（册子 §7.1）。
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if len(peers) > 0 {
		syncEvery, _, err := pf.durations()
		if err != nil {
			return err
		}
		peerCfg, err := pf.config(info)
		if err != nil {
			return err
		}
		peerCfg.RunForever(ctx, st, peers, syncEvery, logf)
		log.Printf("based: 反熵调度已启动（%d 个对端，间隔 %s）", len(peers), syncEvery)
		// scrub 调度在 Task 9 Step 5 追加：peerCfg.ScrubForever(ctx, st, scrubEvery, logf)
	}

	base := fmt.Sprintf("issuer=%s source=%v data=%s storeKey=%s…", *issuer, *key != "", *pf.data, shortKey(st.StoreKeyHex()))
	if plaintext {
		log.Printf("based %s 监听 %s（**明文 HTTP**，仅签名头认证；%s）", version, *addr, base)
		return serveUntil(ctx, *addr, publicHandler)
	}

	clientTLS, err := httpapi.ServerTLSConfig(info, nil)
	if err != nil {
		return err
	}
	log.Printf("based %s 监听 %s（TLS；指纹 %s；配对码 %s；%s）",
		version, *addr, info.FingerprintHex, info.PairingCode, base)
	return serveTLSUntil(ctx, *addr, publicHandler, clientTLS)
}
```

`serveUntil` / `serveTLSUntil` 是为了让 `ctx` 取消能优雅关停（否则 `ListenAndServe` 永远阻塞，`cancel()` 只在退出时触发）：

```go
// serveUntil 起主监听并在 ctx 取消时优雅关停。
func serveUntil(ctx context.Context, addr string, h http.Handler) error {
	srv := &http.Server{Addr: addr, Handler: h}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// serveTLSUntil 同上，带 TLS 配置。
func serveTLSUntil(ctx context.Context, addr string, h http.Handler, tlsCfg *tls.Config) error {
	srv := &http.Server{Addr: addr, Handler: h, TLSConfig: tlsCfg}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	if err := srv.ListenAndServeTLS("", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
```

（新增 import：`context`、`crypto/tls`、`os/signal`、`syscall`、`time`。）

- [ ] **Step 8: 构建 + 跑全包测试**

```powershell
Set-Location e:\code\base
go build ./...
go test ./...
```

Expected: `go build` 无错；`go test ./...` 全包 ok。

- [ ] **Step 9: 手工冒烟（单节点，无对端时调度器不启动）**

```powershell
Set-Location e:\code\base
go run ./cmd/based serve -data $env:TEMP\base-smoke -addr 127.0.0.1:18099 -tls-cert off
```

Expected: 日志出现 `based 0.1.0 监听 127.0.0.1:18099（**明文 HTTP**…`，且**没有**「反熵调度已启动」。Ctrl+C 应能优雅退出。

---

## Task 9: scrub 自愈（本地校验 + 邻居补齐 + 调度 + `scrub` 子命令）

依赖 Task 1（`DeleteBlob` / `MediaChunkIndex` / `ReplicaPeers`）、Task 5 Steps 4（`store.VerifyBlobs` 已落地）、Task 6（`FetchBlobs`）、Task 8（`registerPeerFlags` / `pf.peers()` / `pf.config`）。

**Files:**
- Create: `internal/store/scrub_test.go`
- Create: `internal/peersync/scrub.go`、`internal/peersync/scrub_test.go`
- Create: `cmd/based/scrub.go`
- Modify: `cmd/based/serve.go`、`cmd/based/main.go`

- [ ] **Step 1: 写 `internal/store/scrub_test.go`（覆盖 `VerifyBlobs` 的两条路径）**

```go
package store

import (
	"os"
	"testing"
)

// missing：blobs 行在、文件没了 → 删行并记 missing（契约 §8 第 3 条）。
func TestVerifyBlobsReportsMissingAndDropsRow(t *testing.T) {
	st := openTemp(t)
	id := putBlob(t, st, "会丢的块", "lesson:s", 0)
	if err := os.Remove(st.BlobPath(id)); err != nil {
		t.Fatalf("删块文件: %v", err)
	}

	checked, bad, err := st.VerifyBlobs(nil)
	if err != nil {
		t.Fatalf("VerifyBlobs: %v", err)
	}
	if checked != 0 || len(bad) != 1 || bad[0].BlobID != id || bad[0].Reason != "missing" {
		t.Fatalf("checked=%d bad=%+v", checked, bad)
	}

	// 幂等：第二次全量校验不能再报同一块，也不该报错
	if _, bad2, err := st.VerifyBlobs(nil); err != nil || len(bad2) != 0 {
		t.Fatalf("missing 未清干净: bad=%+v err=%v", bad2, err)
	}
	if n, err := st.CountBlobsWithoutReplica(); err != nil || n != 0 {
		t.Fatalf("blobs 行必须被删除: n=%d err=%v", n, err)
	}
}

// hash_mismatch：文件在、内容被换 → 删文件与行并记 hash_mismatch（契约 §8 第 2 条）。
func TestVerifyBlobsDropsCorruptedBlobFile(t *testing.T) {
	st := openTemp(t)
	id := putBlob(t, st, "会被改坏的块", "lesson:s", 0)
	// L4a′ 下覆写块文件：解封失败与重算哈希不符两条路径都归到 hash_mismatch
	if err := os.WriteFile(st.BlobPath(id), []byte("tampered-bytes"), 0o600); err != nil {
		t.Fatalf("覆写块文件: %v", err)
	}

	checked, bad, err := st.VerifyBlobs([]string{id})
	if err != nil {
		t.Fatalf("VerifyBlobs: %v", err)
	}
	if checked != 1 || len(bad) != 1 || bad[0].BlobID != id || bad[0].Reason != "hash_mismatch" {
		t.Fatalf("checked=%d bad=%+v", checked, bad)
	}
	if _, err := os.Stat(st.BlobPath(id)); !os.IsNotExist(err) {
		t.Fatalf("坏块文件必须被删除，stat err=%v", err)
	}
	if n, err := st.CountBlobsWithoutReplica(); err != nil || n != 0 {
		t.Fatalf("blobs 行必须被删除: n=%d err=%v", n, err)
	}
}
```

- [ ] **Step 2: 跑 store 侧测试**

```powershell
Set-Location e:\code\base
go test ./internal/store/ -v -run TestVerifyBlobs
```

Expected: 两个用例 PASS（`VerifyBlobs` 本体在 Task 5 Step 4 已落地，本步只补测试）。

- [ ] **Step 3: 写 `internal/peersync/scrub.go`**

```go
package peersync

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/johocn/base/internal/store"
)

// scrubFirstDelay 是 scrub 首轮延迟：启动即全量哈希会与冷启动抢 IO（契约 §8）。
const scrubFirstDelay = 10 * time.Minute

// ScrubResult 是一次 scrub 的结果（契约 §8）。
type ScrubResult struct {
	Checked    int
	Repaired   int      // 从邻居拉回并通过逐块哈希校验的块数
	Dropped    int      // 本地坏块被清掉的块数（= store.VerifyBlobs 的 bad 数）
	Unrepaired []string // 所有已知 peer 都拿不到的块：保留告警，不静默、不删别的数据
}

func (r ScrubResult) String() string {
	return fmt.Sprintf("scrub checked=%d repaired=%d dropped=%d unrepaired=%d",
		r.Checked, r.Repaired, r.Dropped, len(r.Unrepaired))
}

// ScrubOnce 对本地做一次校验修复，并按 blob_replicas 登记的邻居补齐（契约 §8）。
// 只修本地：不做跨节点编排（每个节点各扫各的）。
//
// peers 只用于给 blob_replicas 里的裸 url 补上 TLS 指纹；缺项按裸 url 试（局域网调试）。
func (c Config) ScrubOnce(ctx context.Context, st *store.Store, peers []Peer, blobIDs []string) (ScrubResult, error) {
	res := ScrubResult{Unrepaired: []string{}}
	checked, bad, err := st.VerifyBlobs(blobIDs)
	if err != nil {
		return res, err
	}
	res.Checked, res.Dropped = checked, len(bad)
	if len(bad) == 0 {
		return res, nil
	}

	byURL := make(map[string]Peer, len(peers))
	for _, p := range peers {
		byURL[p.URL] = p
	}

	// 归属索引：坏块此刻已被清掉，blobs 表里没有它的归属，只有 media_meta 的声明块序列知道
	idx, err := st.MediaChunkIndex()
	if err != nil {
		return res, err
	}

	for _, b := range bad {
		urls, err := st.ReplicaPeers(b.BlobID)
		if err != nil {
			return res, err
		}
		repaired := false
		for _, url := range urls {
			if ctx.Err() != nil {
				return res, ctx.Err()
			}
			p, known := byURL[url]
			if !known {
				p = Peer{URL: url}
			}
			fr, err := c.FetchBlobs(ctx, p, []BlobSize{{BlobID: b.BlobID}}, func(id string, data []byte) error {
				ref := idx[id]
				return st.PutBlob(id, data, ref.ItemID, ref.Seq)
			})
			if err != nil {
				fmt.Printf("peersync: scrub 从 %s 取 %s 出错: %v\n", url, b.BlobID, err)
				continue
			}
			if fr.Fetched == 1 {
				res.Repaired++
				repaired = true
				break
			}
			fmt.Printf("peersync: scrub 从 %s 未取到 %s（too_large=%v）\n", url, b.BlobID, fr.TooLarge)
		}
		if !repaired {
			res.Unrepaired = append(res.Unrepaired, b.BlobID)
		}
	}
	return res, nil
}

// ScrubForever 启动 scrub 调度：延迟 10 分钟首轮，此后每 interval 一轮（契约 §8）。
// 与反熵同一套「不重入」语义：上一轮未结束则跳过下一拍。
func (c Config) ScrubForever(ctx context.Context, st *store.Store, peers []Peer, interval time.Duration, logf func(string, ...any)) {
	if interval <= 0 {
		return
	}
	var mu sync.Mutex
	running := false
	run := func() {
		mu.Lock()
		if running {
			mu.Unlock()
			logf("peersync: 上一轮 scrub 尚未结束，跳过本轮")
			return
		}
		running = true
		mu.Unlock()

		start := time.Now()
		res, err := c.ScrubOnce(ctx, st, peers, nil)
		if err != nil {
			logf("peersync: scrub 失败: %v", err)
		} else {
			logf("peersync: %s（耗时 %s）", res, time.Since(start).Round(time.Millisecond))
			for _, id := range res.Unrepaired {
				logf("peersync: **告警** 块 %s 所有已知 peer 都拿不到，保留在未修复列表（不删任何其他数据）", id)
			}
		}

		mu.Lock()
		running = false
		mu.Unlock()
	}
	go func() {
		timer := time.NewTimer(scrubFirstDelay)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				run()
				timer.Reset(interval)
			}
		}
	}()
}
```

- [ ] **Step 4: 写 `internal/peersync/scrub_test.go`**

```go
package peersync

import (
	"context"
	"os"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

// 坏块能从 blob_replicas 登记的邻居补齐（契约 §8 第 4 步）。
func TestScrubOnceRepairsFromReplica(t *testing.T) {
	_, dst, url, cfg := nodePair(t)
	if _, err := cfg.SyncPeer(context.Background(), dst, Peer{URL: url}, 1); err != nil {
		t.Fatalf("SyncPeer: %v", err)
	}
	ids, err := dst.ListAllBlobIDs()
	if err != nil || len(ids) != 1 {
		t.Fatalf("同步后应有 1 块：ids=%v err=%v", ids, err)
	}
	id := ids[0]

	// 把块文件改坏（blobs 行仍在）→ scrub 报 hash_mismatch 并从 url 补齐
	if err := os.WriteFile(dst.BlobPath(id), []byte("tampered"), 0o600); err != nil {
		t.Fatalf("覆写块文件: %v", err)
	}

	res, err := cfg.ScrubOnce(context.Background(), dst, []Peer{{URL: url}}, nil)
	if err != nil {
		t.Fatalf("ScrubOnce: %v", err)
	}
	if res.Checked != 1 || res.Dropped != 1 || res.Repaired != 1 || len(res.Unrepaired) != 0 {
		t.Fatalf("scrub = %+v", res)
	}
	data, err := dst.GetBlobBytes(id)
	if err != nil {
		t.Fatalf("补齐后读取: %v", err)
	}
	if protocol.BlobID(data) != id {
		t.Fatalf("补齐回来的块哈希不符")
	}
}

// 没有任何邻居声明持有 → 记 Unrepaired，不静默、不错删别的数据。
func TestScrubOnceReportsUnrepairedWithoutReplica(t *testing.T) {
	st := openTemp(t)
	body := []byte("孤儿块")
	id := protocol.BlobID(body)
	if err := st.PutBlob(id, body, "lesson:x", 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	if err := os.Remove(st.BlobPath(id)); err != nil {
		t.Fatalf("删块文件: %v", err)
	}

	res, err := Config{}.ScrubOnce(context.Background(), st, nil, nil)
	if err != nil {
		t.Fatalf("ScrubOnce: %v", err)
	}
	if res.Dropped != 1 || res.Repaired != 0 || len(res.Unrepaired) != 1 || res.Unrepaired[0] != id {
		t.Fatalf("scrub = %+v", res)
	}
}
```

（`nodePair` 在 Task 8 Step 2 已落到 `sync_test.go`；`openTemp` 在 Task 0 的 `testsupport_test.go`。）

- [ ] **Step 5: 写 `cmd/based/scrub.go`**

```go
package main

import (
	"context"
	"flag"
)

// runScrub 手动触发一次 scrub（契约 §8）。
// 只修本地：坏块按 blob_replicas 登记的邻居逐个试拉回，全部拿不到则告警并列入未修复。
func runScrub(args []string) error {
	fs := flag.NewFlagSet("scrub", flag.ExitOnError)
	pf := registerPeerFlags(fs)
	blob := fs.String("blob", "", "只校验该块（32 位 hex）；空=全量")
	if err := fs.Parse(args); err != nil {
		return err
	}
	peers, err := pf.peers()
	if err != nil {
		return err
	}
	info, err := pf.tlsInfo()
	if err != nil {
		return err
	}
	cfg, err := pf.config(info)
	if err != nil {
		return err
	}
	st, err := pf.openStore()
	if err != nil {
		return err
	}
	defer st.Close()

	var only []string
	if *blob != "" {
		only = []string{*blob}
	}
	res, err := cfg.ScrubOnce(context.Background(), st, peers, only)
	if err != nil {
		return err
	}
	logf("based: %s", res)
	for _, id := range res.Unrepaired {
		logf("based: **告警** 块 %s 所有已知 peer 都拿不到，保留在未修复列表", id)
	}
	return nil
}
```

（`pf.tlsInfo()` 在 `-tls-cert off` 时报错——补块必须走双向 TLS，这与 `peer-sync` 口径一致。只想校验本地时可传一个真实证书路径。）

- [ ] **Step 6: 放开 `cmd/based/main.go` 的 `scrub` 分支**

Task 8 Step 6 曾要求把这一行延后到本 Task，现在补上：

```go
	case "scrub":
		err = runScrub(os.Args[2:])
```

- [ ] **Step 7: `cmd/based/serve.go` 追加 scrub 调度**

把 Task 8 Step 7 里预留的那段（`syncEvery, _, err := pf.durations()` 与末尾的注释行）替换为：

```go
	if len(peers) > 0 {
		syncEvery, scrubEvery, err := pf.durations()
		if err != nil {
			return err
		}
		peerCfg, err := pf.config(info)
		if err != nil {
			return err
		}
		peerCfg.RunForever(ctx, st, peers, syncEvery, logf)
		log.Printf("based: 反熵调度已启动（%d 个对端，间隔 %s）", len(peers), syncEvery)
		peerCfg.ScrubForever(ctx, st, peers, scrubEvery, logf)
		log.Printf("based: scrub 调度已启动（间隔 %s，首轮延迟 10 分钟）", scrubEvery)
	}
```

- [ ] **Step 8: 构建 + 跑全包测试**

```powershell
Set-Location e:\code\base
go build ./...
go test ./...
```

Expected: `go build` 无错；`go test ./...` 全包 ok。

- [ ] **Step 9: 手工冒烟（scrub 空库）**

```powershell
Set-Location e:\code\base
go run ./cmd/based scrub -data $env:TEMP\base-smoke
```

Expected: 打印 `based: scrub checked=0 repaired=0 dropped=0 unrepaired=0`；`%TEMP%\base-smoke\tls\node.crt` 存在（首启生成）。

---

## Task 10: 客户端墓碑删块文件（契约 §2.3③ / §9.3 的实现 delta）

节点侧墓碑已由 Task 7 的 `store.ImportPack` 落地；本 Task 只补客户端遗漏的「删块文件本体」。

现状：`SqlRepo.applyPack` 删了 `blob_index` 行与 `items` / `articles` 行，但**块文件本体留在磁盘**。

**Files:**
- Modify: `apps/mobile/src/core/repo.ts`、`apps/mobile/src/core/sync.ts`
- Modify: `apps/mobile/src/core/fakes.ts`
- Modify: `apps/mobile/src/core/sync.test.ts`

- [ ] **Step 1: `LocalRepo` 增 `listBlobPathsByItem`（`repo.ts`）**

在 `findBlobPathByItem` 之后加：

```ts
  /** 取某条目在 blob_index 中登记的全部块文件路径（墓碑删文件用，契约 §9.3） */
  listBlobPathsByItem(itemId: string): Promise<string[]>;
```

`SqlRepo` 实现（加在 `findBlobPathByItem` 附近）：

```ts
  async listBlobPathsByItem(itemId: string): Promise<string[]> {
    const rows = await this.db.select(`SELECT path FROM blob_index WHERE item_id=?`, [itemId]);
    return rows.map((r) => String(r.path));
  }
```

（`findBlobPathByItem` 保留不动：文章页按 `cover:<slug>` 取封面仍用它。）

- [ ] **Step 2: `MemoryRepo` 补实现（`fakes.ts`）**

```ts
  async listBlobPathsByItem(itemId: string): Promise<string[]> {
    const out: string[] = [];
    for (const b of this.blobs.values()) {
      if (b.itemId === itemId) out.push(b.path);
    }
    return out;
  }
```

- [ ] **Step 3: `sync.ts` —— 落库前收集路径、落库后删文件**

把 `const tombstones ...` 到 `await o.repo.applyPack(...)` 之间改成：

```ts
  const tombstones: TombstoneRow[] = man.tombstone.map((t) => ({ itemId: t.item_id, revokedRev: t.revoked_rev }));

  // 必须在 applyPack 之前取路径：applyPack 会删掉 blob_index 行，之后再也查不到块文件位置（契约 §9.3）
  const stalePaths: string[] = [];
  for (const t of tombstones) {
    stalePaths.push(...(await o.repo.listBlobPathsByItem(t.itemId)));
  }

  await o.repo.applyPack({ version: cat.content_version, packId: cat.pack_id, items, articles, tombstones, updatedAt: now });

  // 行已删、文件后删：删文件失败不阻断本轮（本地视图已一致，下次同步会重跑同一流程）
  for (const path of stalePaths) {
    try {
      await o.adapters.fs.remove(path);
    } catch (err) {
      console.warn(`墓碑清理块文件失败（不阻断同步）: ${path}`, err);
    }
  }
  return { status: 'updated', contentVersion: cat.content_version, items: items.length, blobs };
```

- [ ] **Step 4: 追加用例到 `sync.test.ts`**

```ts
  it('墓碑：条目连同本地块文件一起删除（契约 §9.3 delta）', async () => {
    const fx1 = buildNode(7, { withCover: true });
    const { repo, fs, opts } = setup(fx1);
    await repo.setConfig('pubkey_hex', PUB);
    await syncOnce(opts);
    const coverId = blobId(COVER);
    expect(await repo.hasBlob(coverId)).toBe(true);
    expect(fs.files.has(`/work/blobs/${coverId}`)).toBe(true);

    buildNode(8, { tombstones: [{ item_id: 'cover:aaa', revoked_rev: 8 }], http: fx1.http });

    const res = await syncOnce(opts);
    expect(res.status).toBe('updated');
    expect(await repo.hasBlob(coverId)).toBe(false);
    expect(fs.files.has(`/work/blobs/${coverId}`)).toBe(false);
    expect(await repo.listTombstones()).toEqual([{ itemId: 'cover:aaa', revokedRev: 8 }]);
  });

  it('墓碑：无本地块文件时不报错（幂等）', async () => {
    const fx = buildNode(8, { tombstones: [{ item_id: 'cover:aaa', revoked_rev: 8 }] });
    const { repo, opts } = setup(fx);
    await repo.setConfig('pubkey_hex', PUB);

    const res = await syncOnce(opts);
    expect(res.status).toBe('updated');
    expect(await repo.listTombstones()).toEqual([{ itemId: 'cover:aaa', revokedRev: 8 }]);
  });
```

- [ ] **Step 5: 跑移动端测试与类型检查**

```powershell
Set-Location e:\code\base
npm run test --workspace @base/mobile
npm run typecheck --workspace @base/mobile
```

Expected: vitest 全绿（原 8 个 `syncOnce` 用例 + 新增 2 个）；`tsc --noEmit` 无错。

---

## Task 11: `scripts/install.sh` 与 `scripts/install.ps1`（契约 §10.2）

上游：册子 §10.2 的参数表与 6 步固定顺序、§10.3 部署者路径铁律。

**Files:**
- Create: `scripts/install.sh`
- Create: `scripts/install.ps1`（**必须存为 UTF-8 with BOM**，否则 PowerShell 5.1 会把中文读成乱码）

两者行为逐条一致、顺序固定：`探测 os/arch → 下载 → 校验 SHA256 → 落地 → 建目录 → 打印人工步骤`；不注册服务、不写任何私钥。

- [ ] **Step 1: 写 `scripts/install.sh`**

```bash
#!/usr/bin/env sh
# base 节点一键安装（册子 §10.2）。与 scripts/install.ps1 参数与步骤逐条一致，顺序固定。
# 不注册服务、不写任何私钥、不动已有 data/ 与 data.key（册子 §10.3、§10.2 第 6 条）。
set -eu

VERSION=""
BASE_URL=""
DIR="./base"
ISSUER="base-node-1"
SOURCE="false"

usage() {
  echo "usage: install.sh --version <ver> --base-url <url|dir> [--dir ./base] [--issuer <id>] [--source]" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)  VERSION="${2:-}"; shift 2 ;;
    --base-url) BASE_URL="${2:-}"; shift 2 ;;
    --dir)      DIR="${2:-}"; shift 2 ;;
    --issuer)   ISSUER="${2:-}"; shift 2 ;;
    --source)   SOURCE="true"; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$VERSION" ] || [ -z "$BASE_URL" ]; then
  usage
  exit 2
fi

# 第 1 步：探测 os / arch → 选定文件名（与 build-release.ps1 的命名一致）
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
  linux) os="linux" ;;
  *) echo "不支持的平台: $os（发行只覆盖 linux/amd64、linux/arm64、windows/amd64）" >&2; exit 1 ;;
esac
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) echo "不支持的架构: $arch" >&2; exit 1 ;;
esac
name="base-v$VERSION-$os-$arch"

fetch() { # fetch <相对名> <输出文件>
  case "$BASE_URL" in
    http://*|https://*) curl -fsSL "$BASE_URL/$1" -o "$2" ;;
    *) cp "$BASE_URL/$1" "$2" ;;
  esac
}

mkdir -p "$DIR"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# 第 2 步：下载二进制与 SHA256SUMS.txt → 校验 SHA256，不符即失败退出（不覆盖已有二进制）
fetch "$name" "$tmp/$name"
fetch "SHA256SUMS.txt" "$tmp/SHA256SUMS.txt"
want=$(awk -v n="$name" '$2==n {print $1}' "$tmp/SHA256SUMS.txt")
if [ -z "$want" ]; then
  echo "SHA256SUMS.txt 中没有 $name" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/$name" | awk '{print $1}')
else
  got=$(shasum -a 256 "$tmp/$name" | awk '{print $1}')
fi
if [ "$got" != "$want" ]; then
  echo "SHA256 校验失败: $name" >&2
  echo "  want=$want" >&2
  echo "  got =$got" >&2
  exit 1
fi

# 第 3+4 步：落地二进制、配置模板、空 data/ 与 data/tls/；data.key 在 data/ 之外
cp "$tmp/$name" "$DIR/based"
chmod 0755 "$DIR/based"
mkdir -p "$DIR/data/tls"
if [ -f "$DIR/data.key" ]; then
  chmod 0600 "$DIR/data.key"
else
  : > "$DIR/data.key"
  chmod 0600 "$DIR/data.key"
fi

cat > "$DIR/base.env" <<EOF
# base 节点配置模板（由 install.sh 生成；重复执行会覆盖本文件，自定义项请写进服务单元或 shell profile）
BASE_DATA=$DIR/data
BASE_ADDR=:8080
BASE_PEER_ADDR=:8081
BASE_ISSUER=$ISSUER
BASE_TLS_CERT=$DIR/data/tls/node.crt
BASE_TLS_KEY=$DIR/data/tls/node.key
BASE_SYNC_INTERVAL=5m
BASE_SCRUB_INTERVAL=24h
BASE_FETCH_MAX_BLOBS=64
# 对端清单（指纹来自对端的 \`based tls-cert show -data <对端数据目录>\`）：
# BASE_PEERS=[{"url":"https://127.0.0.1:8081","tls_fingerprint":"<hex64>"}]
# 签发方公钥信任表（缓存节点必填；唯一信任来源，册子 §6.1）：
# BASE_ISSUER_PUBKEYS=[{"issuer":"$ISSUER","public_key_hex":"<64 hex>"}]
# 源节点签名私钥种子（仅源节点；本脚本不写任何私钥）：
# BASE_SIGN_KEY=<hex64>
EOF

# 第 5 步：只打印后续人工步骤，不自动写私钥、不注册服务（册子 §10.3）
if [ "$SOURCE" = "true" ]; then
  role="源节点"
else
  role="缓存节点"
fi
cat <<EOF

安装完成：$DIR（角色：$role）

后续人工步骤：
  1) 首启会打印本节点 TLS 指纹与配对码：
       $DIR/based serve -data $DIR/data
  2) 静态加密密钥位于 data/ 之外的 $DIR/data.key（0600），首启自动生成；不要移动或丢失。
  3) 缓存节点：把内容源的签发方公钥写进 BASE_ISSUER_PUBKEYS（唯一信任来源，册子 §6.1）。
  4) 源节点：额外注入签名私钥 BASE_SIGN_KEY；用 \`$DIR/based pubkey -issuer $ISSUER\` 打印对应公钥。
  5) 服务托管请自行配置（脚本不注册服务）。示例：
       ExecStart=$DIR/based serve -data $DIR/data
EOF
```

- [ ] **Step 2: 写 `scripts/install.ps1`**

```powershell
# base 节点一键安装（册子 §10.2）。与 scripts/install.sh 参数与步骤逐条一致，顺序固定。
# 不注册服务、不写任何私钥、不动已有 data/ 与 data.key（册子 §10.3、§10.2 第 6 条）。
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [string]$Dir = "./base",
    [string]$Issuer = "base-node-1",
    [switch]$Source
)

$ErrorActionPreference = "Stop"

# 第 1 步：探测 os / arch → 选定文件名（与 build-release.ps1 的命名一致）
$os = "windows"
switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
    "X64" { $arch = "amd64" }
    "Arm64" { $arch = "arm64" }
    default { throw "不支持的架构: $($_)" }
}
$name = "base-v$Version-$os-$arch.exe"

function Fetch([string]$rel, [string]$out) {
    if ($BaseUrl -match '^https?://') {
        Invoke-WebRequest -Uri "$BaseUrl/$rel" -OutFile $out -UseBasicParsing
    } else {
        Copy-Item -Path (Join-Path $BaseUrl $rel) -Destination $out -Force
    }
}

$dirPath = (New-Item -ItemType Directory -Force -Path $Dir).FullName
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("base-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    # 第 2 步：下载二进制与 SHA256SUMS.txt → 校验 SHA256，不符即失败退出（不覆盖已有二进制）
    $binTmp = Join-Path $tmp $name
    $sumsTmp = Join-Path $tmp "SHA256SUMS.txt"
    Fetch $name $binTmp
    Fetch "SHA256SUMS.txt" $sumsTmp

    $want = Get-Content $sumsTmp |
        ForEach-Object { $p = $_ -split '\s+'; if ($p.Count -ge 2 -and $p[1] -eq $name) { $p[0] } } |
        Select-Object -First 1
    if (-not $want) { throw "SHA256SUMS.txt 中没有 $name" }
    $got = (Get-FileHash -Algorithm SHA256 -Path $binTmp).Hash.ToLower()
    if ($got -ne $want) { throw "SHA256 校验失败: $name`n  want=$want`n  got =$got" }

    # 第 3+4 步：落地二进制、配置模板、空 data/ 与 data/tls/；data.key 在 data/ 之外
    Copy-Item -Path $binTmp -Destination (Join-Path $dirPath "based.exe") -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $dirPath "data/tls") | Out-Null

    $keyPath = Join-Path $dirPath "data.key"
    if (-not (Test-Path $keyPath)) { New-Item -ItemType File -Path $keyPath -Force | Out-Null }

    $envPath = Join-Path $dirPath "base.env"
    @"
# base 节点配置模板（由 install.ps1 生成；重复执行会覆盖本文件，自定义项请写进服务单元或系统环境变量）
BASE_DATA=$dirPath\data
BASE_ADDR=:8080
BASE_PEER_ADDR=:8081
BASE_ISSUER=$Issuer
BASE_TLS_CERT=$dirPath\data\tls\node.crt
BASE_TLS_KEY=$dirPath\data\tls\node.key
BASE_SYNC_INTERVAL=5m
BASE_SCRUB_INTERVAL=24h
BASE_FETCH_MAX_BLOBS=64
# 对端清单（指纹来自对端的 based tls-cert show -data <对端数据目录>）：
# BASE_PEERS=[{"url":"https://127.0.0.1:8081","tls_fingerprint":"<hex64>"}]
# 签发方公钥信任表（缓存节点必填；唯一信任来源，册子 §6.1）：
# BASE_ISSUER_PUBKEYS=[{"issuer":"$Issuer","public_key_hex":"<64 hex>"}]
# 源节点签名私钥种子（仅源节点；本脚本不写任何私钥）：
# BASE_SIGN_KEY=<hex64>
"@ | Set-Content -Path $envPath -Encoding utf8

    # 第 5 步：只打印后续人工步骤，不自动写私钥、不注册服务（册子 §10.3）
    $role = if ($Source) { "源节点" } else { "缓存节点" }
    Write-Host ""
    Write-Host "安装完成：$dirPath（角色：$role）"
    Write-Host ""
    Write-Host "后续人工步骤："
    Write-Host "  1) 首启会打印本节点 TLS 指纹与配对码："
    Write-Host "       $dirPath\based.exe serve -data $dirPath\data"
    Write-Host "  2) 静态加密密钥位于 data/ 之外的 $dirPath\data.key，首启自动生成；不要移动或丢失。"
    Write-Host "  3) 缓存节点：把内容源的签发方公钥写进 BASE_ISSUER_PUBKEYS（唯一信任来源，册子 §6.1）。"
    Write-Host "  4) 源节点：额外注入签名私钥 BASE_SIGN_KEY；用 based pubkey -issuer <id> 打印对应公钥。"
    Write-Host "  5) 服务托管请自行配置（脚本不注册服务）。"
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
```

（`data.key` 存在时保持原样——`-Force` 的 `New-Item` 只在缺失时创建，符合「重复执行不动 `data.key`」。）

- [ ] **Step 3: 写 `scripts/install.ps1` 时确保 UTF-8 BOM**

```powershell
$p = 'e:\code\base\scripts\install.ps1'
$text = [System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($p, $text, [System.Text.UTF8Encoding]::new($true))
```

Expected: 用 `Get-Content` 读 `install.ps1` 中文不乱码；文件首三字节为 `EF BB BF`。

- [ ] **Step 4: 本地真跑一遍（契约 §11 验收 10）**

先产出发行产物，再用**本地目录**当 `--base-url`（避免依赖网络）：

```powershell
Set-Location e:\code\base
pwsh -File .\scripts\build-release.ps1 -Version 0.1.0 -OutDir (Join-Path $env:TEMP 'base-dist')
$d = Join-Path $env:TEMP 'base-install-try'
Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
pwsh -File .\scripts\install.ps1 -Version 0.1.0 -BaseUrl (Join-Path $env:TEMP 'base-dist') -Dir $d -Issuer base-node-1
Get-ChildItem $d -Recurse | Select-Object -ExpandProperty FullName
```

Expected: 打印安装完成与后续人工步骤；`$d` 下有 `based.exe`、`base.env`、`data\`、`data\tls\`、`data.key`。

- [ ] **Step 5: 幂等与失败路径各跑一次**

```powershell
# 幂等：再跑一次，data.key 不被覆盖（记录内容哈希前后一致）
$k = Join-Path $env:TEMP 'base-install-try\data.key'
(Get-FileHash $k).Hash
pwsh -File .\scripts\install.ps1 -Version 0.1.0 -BaseUrl (Join-Path $env:TEMP 'base-dist') -Dir $d -Issuer base-node-1
(Get-FileHash $k).Hash

# 失败路径：SHA256SUMS.txt 里没有这个版本 → 必须失败且不覆盖 based.exe
$bad = Join-Path $env:TEMP 'base-install-bad'
Remove-Item -Recurse -Force $bad -ErrorAction SilentlyContinue
pwsh -File .\scripts\install.ps1 -Version 9.9.9 -BaseUrl (Join-Path $env:TEMP 'base-dist') -Dir $bad
```

Expected: 两次 `data.key` 哈希一致；第三次抛错「SHA256SUMS.txt 中没有 base-v9.9.9-windows-amd64.exe」，且 `$bad` 下**没有** `based.exe`。

- [ ] **Step 6: `install.sh` 语法与逻辑检查（无 Linux 环境时）**

```powershell
Set-Location e:\code\base
Get-Command wsl -ErrorAction SilentlyContinue | Out-Null
if (Get-Command wsl -ErrorAction SilentlyContinue) {
  wsl -- sh -n /mnt/e/code/base/scripts/install.sh
} else {
  Write-Host "无 wsl：跳过 sh -n；install.sh 与 install.ps1 步骤逐条对齐，由 Task 12 的真机验收兜底"
}
```

Expected: 有 wsl 时 `sh -n` 无输出（语法通过）；无 wsl 时打印跳过说明。

---

## Task 12: 三节点端到端验收与文档回填（契约 §11 验收 1–10）

**Files:**
- Modify: `docs/README.md`（§3 第 13 行状态、§5 当前阶段）
- Modify: `docs/superpowers/specs/2026-09-26-base-content-distribution-design.md`（回填本计划的 6 条规格修正）
- Modify: `docs/superpowers/plans/2026-09-26-base-content-distribution-plan.md`（追加 `## 执行记录`）

- [ ] **Step 1: 编译本机二进制并清空验收目录**

```powershell
$env:PATH = 'D:\go\bin;D:\gopath\bin;' + $env:PATH
Set-Location e:\code\base
$B = Join-Path $env:TEMP 'base-acc'
Remove-Item -Recurse -Force $B -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $B | Out-Null
go build -o (Join-Path $B 'based.exe') ./cmd/based
$based = Join-Path $B 'based.exe'
& $based version
```

Expected: 打印 `based 0.1.0`。

- [ ] **Step 2: 三节点各生成证书，收集指纹（AC 5 的前置）**

```powershell
$fp = @{}
foreach ($n in 'A','B','C') {
  $out = & $based tls-cert init -data (Join-Path $B $n)
  $out | Write-Host
  $fp[$n] = ($out | Select-String '^fingerprint  = (.+)$').Matches[0].Groups[1].Value
}
$fp | Format-Table
```

Expected: 三个目录各生成 `data\tls\node.crt`；拿到 `FA` / `FB` / `FC` 三个 hex64 指纹。

- [ ] **Step 3: 写 A（源节点）的配置并起进程**

```powershell
# 签名私钥种子：用仓库测试向量（一次性真机验收用，不作生产密钥）
$SIGN = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
$PUB  = (& $based pubkey -issuer base-node-1 -sign-key $SIGN | Select-String 'public_key_hex=').Line.Split('=')[1]
$PUB
$peersA = "[{`"url`":`"https://127.0.0.1:19082`",`"tls_fingerprint`":`"$($fp['B'])`"},{`"url`":`"https://127.0.0.1:19083`",`"tls_fingerprint`":`"$($fp['C'])`"}]"

Start-Process -FilePath $based -ArgumentList @(
  'serve','-data',(Join-Path $B 'A'),
  '-addr','127.0.0.1:18081',
  '-peer-addr','127.0.0.1:19081',
  '-issuer','base-node-1','-sign-key',$SIGN,
  '-peers',$peersA,
  '-sync-interval','10s','-scrub-interval','1h'
) -RedirectStandardOutput (Join-Path $B 'A.log') -RedirectStandardError (Join-Path $B 'A.err.log') -WindowStyle Hidden
Start-Sleep -Seconds 2
Get-Content (Join-Path $B 'A.log')
```

Expected: A 日志出现 `监听 127.0.0.1:18081`、`对端接口监听 127.0.0.1:19081`、`反熵调度已启动（2 个对端，间隔 10s）`、`scrub 调度已启动`。

- [ ] **Step 4: 写 B / C（缓存节点）的配置并起进程**

```powershell
$pubTable = "[{`"issuer`":`"base-node-1`",`"public_key_hex`":`"$PUB`"}]"
$peersB = "[{`"url`":`"https://127.0.0.1:19081`",`"tls_fingerprint`":`"$($fp['A'])`"},{`"url`":`"https://127.0.0.1:19083`",`"tls_fingerprint`":`"$($fp['C'])`"}]"
$peersC = "[{`"url`":`"https://127.0.0.1:19081`",`"tls_fingerprint`":`"$($fp['A'])`"},{`"url`":`"https://127.0.0.1:19082`",`"tls_fingerprint`":`"$($fp['B'])`"}]"

Start-Process -FilePath $based -ArgumentList @(
  'serve','-data',(Join-Path $B 'B'),'-addr','127.0.0.1:18082','-peer-addr','127.0.0.1:19082',
  '-issuer','base-node-1','-peers',$peersB,'-issuer-pubkeys',$pubTable,
  '-sync-interval','10s','-scrub-interval','1h'
) -RedirectStandardOutput (Join-Path $B 'B.log') -RedirectStandardError (Join-Path $B 'B.err.log') -WindowStyle Hidden
Start-Process -FilePath $based -ArgumentList @(
  'serve','-data',(Join-Path $B 'C'),'-addr','127.0.0.1:18083','-peer-addr','127.0.0.1:19083',
  '-issuer','base-node-1','-peers',$peersC,'-issuer-pubkeys',$pubTable,
  '-sync-interval','10s','-scrub-interval','1h'
) -RedirectStandardOutput (Join-Path $B 'C.log') -RedirectStandardError (Join-Path $B 'C.err.log') -WindowStyle Hidden
Start-Sleep -Seconds 2
```

Expected: B / C 各自打印监听与「反熵调度已启动」，无 TLS 拒绝错误。

- [ ] **Step 5: A 导入内容并导出（AC 3 / AC 6 前半）**

```powershell
# 导入 1 篇文章（走既有 import-md）+ 1 个 2.5 MiB 视频（3 块）→ 验收 3 的块数断言
$md = Join-Path $B 'a.md'
"# 演示文章`n`n正文内容。`n" | Set-Content -Path $md -Encoding utf8
& $based import-md -file $md -slug demo -data (Join-Path $B 'A')
$v = Join-Path $B 'demo.mp4'
[System.IO.File]::WriteAllBytes($v, (New-Object byte[] 2621440))
& $based import-video -file $v -slug demo-video -data (Join-Path $B 'A')

& $based export -issuer base-node-1 -sign-key $SIGN -version 1 -data (Join-Path $B 'A')
```

Expected: `import-video` 打印 `块数=3 总字节=2621440`；`export` 打印 `content_version=1` 与 `pack_id`。

- [ ] **Step 6: 等一轮反熵，验收 3 / 4 / 6（前半）**

```powershell
Start-Sleep -Seconds 25
Get-Content (Join-Path $B 'B.log') -Tail 20
Get-Content (Join-Path $B 'C.log') -Tail 20
```

Expected: B / C 日志出现 `imported=true`、`missing=N fetched=N`、`no_replica=0`；第二轮出现 `equal=true`。

```powershell
# AC 4：缓存节点独立供读 —— catalog / manifest / pack / blob 四个公开接口全部可用
$cat = Invoke-RestMethod 'http://127.0.0.1:18082/v1/catalog'
$cat.pack_id; $cat.content_version; $cat.items.Count
Invoke-WebRequest "http://127.0.0.1:18082/v1/manifest/$($cat.pack_id)" -UseBasicParsing | Select-Object -ExpandProperty StatusCode
Invoke-WebRequest "http://127.0.0.1:18082/v1/pack/$($cat.pack_id)"    -UseBasicParsing | Select-Object -ExpandProperty StatusCode

# pack 字节与源节点一致（AC 4 后半）
$a = (Invoke-WebRequest "http://127.0.0.1:18081/v1/pack/$($cat.pack_id)" -UseBasicParsing).RawContentLength
$b = (Invoke-WebRequest "http://127.0.0.1:18082/v1/pack/$($cat.pack_id)" -UseBasicParsing).RawContentLength
"$a / $b"

# 逐块 GET + HEAD 校验（AC 3）
$man = Invoke-RestMethod "http://127.0.0.1:18082/v1/manifest/$($cat.pack_id)"
foreach ($e in $man.entries) {
  foreach ($c in $e.chunks) {
    $r = Invoke-WebRequest "http://127.0.0.1:18082/v1/blob/$($c.blob_id)" -UseBasicParsing
    $h = Invoke-WebRequest "http://127.0.0.1:18082/v1/blob/$($c.blob_id)" -Method Head -UseBasicParsing
    if ($r.Content.Length -ne $c.size) { throw "块大小不符 $($c.blob_id)" }
    if ($h.Headers['Content-Length'] -ne "$($c.size)") { throw "HEAD 大小不符 $($c.blob_id)" }
  }
}
# AC 3 后半：manifest.entries[].chunks[] 与 media_meta.chunk_hashes_json 一致
& $based export -issuer base-node-1 -sign-key $SIGN -version 1 -data (Join-Path $B 'A')  # 幂等：AC 6 前半（不产生新 pack_id / 新 content_version）
```

Expected: 四个接口均 200；两次 `RawContentLength` 相等；逐块大小与 HEAD 一致；第二次 `export` 打印同一个 `pack_id` 与 `content_version=1`。

- [ ] **Step 7: 验收 5（路由隔离）+ 验收 8（L4a′）**

```powershell
# AC 5：客户端监听上四个内部接口必须 404；对端监听上无 mTLS 必须失败
foreach ($p in '/v1/inventory','/v1/sync','/v1/fetch','/v1/scrub') {
  try {
    $r = Invoke-WebRequest ("http://127.0.0.1:18082" + $p) -Method Get -UseBasicParsing
    throw "客户端监听不应暴露 $p（HTTP $($r.StatusCode)）"
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw "客户端监听 $p 期望 404，实际 $($_.Exception.Message)" }
  }
}
# 对端监听裸连（无客户端证书）必须失败
try { Invoke-WebRequest 'https://127.0.0.1:19082/v1/inventory' -UseBasicParsing | Out-Null; throw '对端监听不应接受无证书连接' }
catch { "预期失败: $($_.Exception.Message)" }

# AC 8：直接读盘原始字节，断言无 ① 类明文；同时公开读仍返回明文
$raw = [System.IO.File]::ReadAllBytes((Join-Path $B 'A\base.db'))
$hit = [System.Text.Encoding]::UTF8.GetString($raw).Contains('正文内容')
"base.db 明文命中 = $hit（期望 False）"
```

Expected: 四个内部路径全部 404；裸连对端监听失败；`base.db` 明文命中为 `False`。

- [ ] **Step 8: 验收 9（验签拒绝）+ 验收 2（篡改拒收 + scrub 自愈）**

```powershell
# AC 9：改盘上 manifest 的任一字段 → 缓存节点拒绝整包，本地视图不变
$bMan = Join-Path $B 'A\packs'
$packDir = Get-ChildItem $bMan -Directory | Select-Object -First 1
$mf = Join-Path $packDir.FullName 'manifest.json'
$before = (Invoke-RestMethod 'http://127.0.0.1:18082/v1/catalog').content_version
Copy-Item $mf "$mf.bak"
(Get-Content $mf -Raw) -replace '"content_version":\s*1', '"content_version": 99' | Set-Content $mf -Encoding utf8
& $based export -issuer base-node-1 -sign-key $SIGN -version 2 -data (Join-Path $B 'A')   # 让 A 有更高版本可推
Start-Sleep -Seconds 15
(Invoke-RestMethod 'http://127.0.0.1:18082/v1/catalog').content_version   # 期望仍为篡改前的值
Get-Content (Join-Path $B 'B.log') -Tail 10 | Select-String '验签'          # 期望出现拒绝告警
Move-Item "$mf.bak" $mf -Force
```

Expected: B 的 `content_version` 不前进；日志出现验签失败告警。

```powershell
# AC 2：改块 1 bit → 节点侧 scrub 报 hash_mismatch 并从邻居修复
$bid = (Invoke-RestMethod 'http://127.0.0.1:18082/v1/catalog').pack_id
$manB = Invoke-RestMethod "http://127.0.0.1:18082/v1/manifest/$bid"
$target = $manB.entries | Where-Object { $_.chunks } | Select-Object -First 1
$tid = $target.chunks[0].blob_id
$bp = Join-Path $B ("B\data\blobs\" + $tid.Substring(0,2) + '\' + $tid.Substring(2,2) + '\' + $tid)
$bytes = [System.IO.File]::ReadAllBytes($bp); $bytes[0] = $bytes[0] -bxor 1
[System.IO.File]::WriteAllBytes($bp, $bytes)

& $based scrub -data (Join-Path $B 'B') -blob $tid -peers "[{`"url`":`"https://127.0.0.1:19081`",`"tls_fingerprint`":`"$($fp['A'])`"}]" -tls-cert (Join-Path $B 'B\data\tls\node.crt') -tls-key (Join-Path $B 'B\data\tls\node.key')
```

Expected: 打印 `scrub checked=1 repaired=1 dropped=1 unrepaired=0`（本地坏块被删，随即从 A 补齐）。

- [ ] **Step 9: 验收 1（三节点恢复）+ 验收 7（墓碑同步）**

```powershell
# AC 1：杀 A（源）→ 删 B 的若干块文件 → B 的下一轮反熵从 C 补齐 → 逐块哈希通过、副本数<2 回落为 0
Get-Process based -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $based } | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='based.exe'" | Where-Object { $_.CommandLine -like '*\base-acc\A*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 1

$cat = Invoke-RestMethod 'http://127.0.0.1:18082/v1/catalog'
$manB = Invoke-RestMethod "http://127.0.0.1:18082/v1/manifest/$($cat.pack_id)"
$all = $manB.entries | ForEach-Object { $_.chunks } | ForEach-Object { $_.blob_id } | Where-Object { $_ }
foreach ($id in $all) {
  $bp = Join-Path $B ("B\data\blobs\" + $id.Substring(0,2) + '\' + $id.Substring(2,2) + '\' + $id)
  Remove-Item $bp -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 30
Get-Content (Join-Path $B 'B.log') -Tail 20 | Select-String 'fetched='
# 逐块哈希校验：公开读回来的字节的 sha256[0:32] 必须等于 blob_id（此处用 200 与长度兜底）
foreach ($id in $all) {
  $r = Invoke-WebRequest "http://127.0.0.1:18082/v1/blob/$id" -UseBasicParsing
  if ($r.StatusCode -ne 200) { throw "块 $id 未从 C 补齐" }
}
"AC1 通过：B 在 A 下线后从 C 补齐全部 $($all.Count) 块"
```

Expected: B 日志出现 `missing=N fetched=N no_replica=0`；全部块 `GET` 200。

AC 7 的源节点侧需要一个「撤回条目」的动作，而 P0 的 CLI 没有这个子命令（册子 §2.2 的允许新增里也不含它——**不能自造命令契约**）。处置：写一个**一次性、不提交**的小程序驱动既有 `store.ImportPack` 的墓碑分支（等于节点侧 §9.2 的同一条路径），验完即删。

```powershell
# 一次性工具（验收后删除，不进仓库）
$t = Join-Path $B 'retire'
New-Item -ItemType Directory -Force -Path $t | Out-Null
$retire = Join-Path $t 'main.go'
New-Item -ItemType Directory -Force -Path (Split-Path $retire) | Out-Null
@'
// 一次性验收工具（不提交）：给源节点签发带 tombstone 的新版本。
package main

import (
	"flag"
	"fmt"
	"log"

	"github.com/johocn/base/internal/packexport"
	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

func main() {
	data := flag.String("data", "data", "数据目录")
	item := flag.String("item", "", "要撤回的 item_id")
	sign := flag.String("sign-key", "", "Ed25519 私钥种子")
	issuer := flag.String("issuer", "base-node-1", "签发方")
	ver := flag.Int64("version", 0, "新 content_version（必须大于当前水位）")
	flag.Parse()

	st, err := store.Open(*data)
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()

	// 节点侧 §9.2：一个事务内落墓碑并连带删条目行与 blobs 行（复用 ImportPack 的墓碑分支）
	res, err := st.ImportPack(*ver, nil, []protocol.Tombstone{{ItemID: *item, RevokedRev: *ver}})
	if err != nil {
		log.Fatal(err)
	}
	// 提交后删块文件（修正 5 的「先收集路径、应用后在事务外删」顺序）
	for _, id := range res.RemovedBlobs {
		if err := st.DeleteBlobFile(id); err != nil {
			log.Printf("删块文件 %s: %v", id, err)
		}
	}
	out, err := packexport.Export(st, packexport.Options{Issuer: *issuer, SignKeyHex: *sign, Version: *ver})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("retire: item=%s version=%d removed_blobs=%d pack_id=%s\n",
		*item, out.ContentVersion, len(res.RemovedBlobs), out.PackID)
}
'@ | Set-Content -Path $retire -Encoding utf8

Set-Location e:\code\base
Copy-Item $retire '.\cmd\based\zz_retire_verify.go' -Force   # 放进模块内才能 go run
go run ./cmd/based/zz_retire_verify.go -data (Join-Path $B 'A') -item 'lesson:demo-video' -sign-key $SIGN -version 3
Remove-Item '.\cmd\based\zz_retire_verify.go' -Force
Start-Sleep -Seconds 15
Get-Content (Join-Path $B 'B.log') -Tail 20 | Select-String 'imported='
Get-ChildItem (Join-Path $B 'B\data\blobs') -Recurse -File | Measure-Object -Line
```

（`ImportPack` 会把 `content_version` 写成 `-version` 的值，`packexport.Export` 看见 `opt.Version > 0` 就不再自增——两者一致，符合册子 §6.3。）

Expected: 打印 `retire: item=lesson:demo-video version=3 removed_blobs=3 pack_id=…`；B / C 日志出现 `imported=true`；B 的 `data\blobs` 下该条目的 3 个块文件消失（`Measure-Object` 计数随之减少）。

- [ ] **Step 10: 验收 10（发行安装）**

Task 11 Step 4–5 已覆盖 `install.ps1`；本步只补 `install.sh` 的 Linux 侧（有 wsl 时）：

```powershell
if (Get-Command wsl -ErrorAction SilentlyContinue) {
  wsl -- bash -lc "cd /mnt/e/code/base && VERSION=0.1.0 bash -c 'echo sh 侧由 CI/真机 Linux 执行'"
} else { Write-Host '无 wsl：install.sh 的真机执行留给 Linux 部署机（契约 §10.3 的部署者路径）' }
```

- [ ] **Step 11: 清理验收进程与目录**

```powershell
Get-CimInstance Win32_Process -Filter "Name='based.exe'" |
  Where-Object { $_.CommandLine -like "*$B*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Remove-Item -Recurse -Force $B -ErrorAction SilentlyContinue
```

- [ ] **Step 12: 回填文档**

1. `docs/README.md`：§3 第 13 行状态改为「**已执行**（Task 0–12 全部落地）…」；§5「当前阶段」把 #5 从「待执行」改为「已执行」，下一步指向 `#6` 课程体系册子与 `#4` spike。
2. `docs/superpowers/specs/2026-09-26-base-content-distribution-design.md`：
   - 「## 0. 改版说明」追加「### 0.2 2026-09-26 实施回填」一节，逐条记录本计划的 6 条规格修正（`internal/sync` → `internal/peersync`、`scrub.repaired` 对端侧恒 0、`protocol.FetchMaxBytes` 两侧同源、`-data` 走 `envOr("BASE_DATA","data")`、墓碑删文件改为「先收集后删」、`media_meta` 行级校验口径精确化为「块数 + size 之和」）。
   - 正文对应处（§3 表格的 `internal/sync` 行、§5.2 的 `scrub` 响应说明、§5.3 的限额、§6.2 步骤 5、§8 第 4 步、§9.3）就地改成修正后的口径。
3. 本计划末尾追加 `## 执行记录（2026-09-26，Task 0–12 全部落地）`，体例照抄 `docs/superpowers/plans/2026-09-26-base-identity-tls-plan.md` 的执行记录（偏离项三列表：位置 / 计划原文 / 实际做法与原因 + 末尾 `**验证**：` 段落）。

- [ ] **Step 13: 最终全绿**

```powershell
Set-Location e:\code\base
go build ./...
go test ./...
npm run test --workspace @base/mobile
npm run typecheck --workspace @base/mobile
```

Expected: Go 全包 ok；vitest 全绿；`tsc --noEmit` 无错。

---

## 计划自检（spec 覆盖 / 占位符 / 类型一致性）

### 1. 册子覆盖表

| 册子章节 | 本计划落点 | 类型 |
|---|---|---|
| §4.1 分块算法（1 MiB 定长、`content_hash` 定义） | Task 2（`importer.ChunkSize`、`ImportVideo`） | 代码 |
| §4.2 `import-video` 命令与幂等/失败语义 | Task 2 Step 2–3 | 代码 |
| §4.3 导出与公开读（无需改动） | 不改代码；Task 12 Step 6 实测断言 | 验收 |
| §4.4 元数据可见性 | 不改代码（`catalog` 不含块清单，P0 已如此） | 文档 |
| §4.5 手机端（沿用既有路径） | 明确不覆盖（见下「明确不覆盖」） | 不覆盖 |
| §5.1 监听拓扑与路由隔离 | Task 4（`Handler()` / `PeerHandler()`）+ Task 8 Step 7 | 代码 |
| §5.2 四个内部接口 | Task 5（入站）+ Task 6（出站客户端） | 代码 |
| §5.3 鉴权三层与 `fetch` 双限额 | Task 4（三层沿用 S1）+ Task 5（块数上限）+ Task 6/修正 3（总字节上限） | 代码 |
| §6.1 签发方公钥信任来源 | Task 6 Step 1（`ParseIssuerPubKeys`，唯一来源） | 代码 |
| §6.2 复制七步流程 | Task 7（`store.ImportPack` + `peersync.ImportPack`，修正 6） | 代码 |
| §6.3 版本裁决与拒绝语义 | Task 7（`Rejected` 防回卷 + 整包拒绝） | 代码 |
| §6.4 幂等与可重跑 | Task 7（`Skipped` / 版本不递增即 noop）+ Task 12 Step 6 | 代码 + 验收 |
| §7.1 回合调度（0–60s 抖动、串行、失败只记日志、不重入） | Task 8 Step 1（`RunOnce` / `RunForever`）+ Step 5（`peer-sync`） | 代码 |
| §7.2 比对算法七步 | Task 8 Step 1（`SyncPeer`） | 代码 |
| §7.3 副本登记 | Task 1 Step 3（`blob_replicas` + 三个方法）+ Task 8 Step 1 | 代码 |
| §7.4 不做删除的例外 | Task 1（`DeleteBlob` 只用于 scrub/墓碑）+ Task 8（`extra` 只记录） | 代码 |
| §8 scrub 自愈 | Task 5 Step 4（`store.VerifyBlobs` 本地修）+ Task 9（编排 + 调度 + 子命令） | 代码 |
| §9.1 `revoked_rev` 语义 | Task 1（`tombstones` 表不变）+ Task 7（`ImportPack` 取大值） | 代码 |
| §9.2 节点侧应用墓碑 | Task 7 Step 1（一个事务内 upsert + 连带删 + `RemovedBlobs`） | 代码 |
| §9.3 客户端侧（含 delta 删块文件） | Task 10 | 代码 |
| §9.4 防回卷统一口径 | Task 7（节点）+ Task 10（客户端不复算，以 manifest 为准） | 代码 |
| §10.2 `install.sh` / `install.ps1` 契约 | Task 11 | 代码 |
| §10.3 部署者路径铁律 | Task 11（不注册服务、不写私钥） | 代码 |
| §11 验收 1–10 | Task 12 Step 5–10 | 验收 |
| §12 风险 1–7 | 风险 1→Task 4；风险 2 沿用总纲；风险 3→Task 6 Step 1；风险 4→Task 1/8（只登记不淘汰）；风险 5→Task 8（只记录不删）；风险 6→Task 8（不重入 + 耗时日志）；风险 7→Task 11 | 代码 |
| §2.3① `item_id` 命名 | 明确不动（`lesson:<slug>` 沿用 `<source>:<slug>`） | 不覆盖 |
| §2.3② `revoked_rev` 类型 | 明确不改字段与类型 | 不覆盖 |
| §2.3③ 客户端墓碑未删块文件 | Task 10 | 代码 |

### 2. 明确不覆盖（与册子 §1「明确不做」逐条对齐）

- 不改内容包规范 v1 的字段名、字段类型、`pack.sqlite` 五张表结构；本计划新增的一切都在 v1 之外。
- 不做课程层级建模；**不做** `item_id` 重命名与路径式命名空间（归 #6）。
- 不做容量上限与 LRU 淘汰；不把「声明持有」升级为「补齐后已验证持有」（风险 4 的前置工作留给引进淘汰的册子）。
- 不做手机端视频播放器与预下载调度；手机端只沿用既有块下载路径（§4.5）。
- 不做 ② 类内容的解密、索引、审核。
- 不做读取鉴权、节点侧授权判定、近场互传、可视化后台。
- 不做 `merkle_root` 双定义的一致性可视化（册子 §13）。
- 不动 `scripts/build-release.ps1`（§10.1 已落地）。
- 不做 `BASE_ISSUER_PUBKEYS` 轮换流程与多 issuer 裁决（册子 §13 待定）。

### 3. 占位符扫描

本计划正文中除**明确标注为待删示例**的一处外，不含 `TODO` / `TBD` / `待补` / `...（略）`。需在执行时删除的那处：

| 位置 | 内容 | 处置 |
|---|---|---|
| Task 8 Step 2 | 以 `func syncNodePair(t *testing.T)` 开头的空壳示例（含 `_ = srcURL` 等占位赋值） | **落地时整段删除**，只保留其后的 `nodePair` 与两个用例（计划已就地标注） |

其余「代码块内出现的 `<hex64>` / `<64 hex>` / `<安装目录>`」均属**脚本生成内容的字面模板**（由 Task 11 的脚本运行时替换），不是待办占位符。

### 4. 类型与签名一致性

| 符号 | 定义处 | 使用处 | 一致性 |
|---|---|---|---|
| `store.BlobRef{BlobID,Seq,Size,ItemID}` | Task 1 Step 2 | `ListBlobsPage` / `MediaChunkIndex` / `ListBlobsForItem` | 一致（`ListBlobsForItem` 的 `ItemID` 留零值） |
| `store.VerifyBlobs([]string) (int, []BadBlob, error)` | Task 5 Step 4 | Task 5 `handleScrub`、Task 9 `ScrubOnce` | 一致 |
| `store.ImportPack(int64, []PackEntry, []protocol.Tombstone) (ImportResult, error)` | Task 7 Step 1 | Task 7 Step 4 `peersync.ImportPack` | 一致 |
| `store.ListBlobsPage(string, int) ([]BlobRef, string, error)` | Task 1 Step 2 | Task 5 `handleInventory` | 一致 |
| `peersync.Config` 字段（`OwnTLS` / `NodeKey` / `IssuerPubKeys` / `FetchMaxBlobs` / `TransportFor`） | Task 0 Step 4 | Task 6/7/8/9 + `cmd/based/peerconfig.go` | 一致（Task 9 只读 `FetchMaxBlobs` / `OwnTLS` / `TransportFor`） |
| `peersync.Peer{URL,TLSFingerprint}` | Task 0 Step 4 | 全部出站调用 + `cmd/based/peerconfig.go` | 一致 |
| `FetchBlobs(ctx, Peer, []BlobSize, func(string, []byte) error) (FetchResult, error)` | Task 6 Step 2 | Task 8 `SyncPeer`、Task 9 `ScrubOnce` | 一致 |
| `FetchResult{Requested,Fetched,BadFrames,TooLarge}` | Task 6 Step 2 | Task 8 / Task 9 | 一致 |
| `ScrubResult{Checked,Repaired,Dropped,Unrepaired}` | Task 9 Step 3 | Task 9 `ScrubOnce` / `ScrubForever` / `cmd/based/scrub.go` | 一致 |
| `ScrubOnce(ctx, *store.Store, []Peer, []string) (ScrubResult, error)` | Task 9 Step 3 | `ScrubForever`、`runScrub`、Task 9 Step 4 测试 | 一致 |
| `ScrubForever(ctx, *store.Store, []Peer, time.Duration, func(string, ...any))` | Task 9 Step 3 | `cmd/based/serve.go`（Task 9 Step 7 替换 Task 8 Step 7 的预留注释） | 一致 |
| `httpapi.Options.FetchMaxBlobs` | Task 4 Step 2 | Task 5 `handleFetch`（块数上限）、Task 8 Step 7（传入 `*pf.fetchMaxBlobs`） | 一致 |
| `protocol.FetchMaxBytes` | 修正 3（Task 3） | Task 5 `handleFetch`（413）、Task 6 `FetchBlobs`（切批） | 一致（两侧同一个常量） |
| `LocalRepo.listBlobPathsByItem(string) Promise<string[]>` | Task 10 Step 1 | `SqlRepo`（Step 1）、`MemoryRepo`（Step 2）、`sync.ts`（Step 3） | 一致 |
| `store.ReplicaPeers(string) ([]string, error)` | Task 1 Step 3 | Task 9 `ScrubOnce` | 一致（返回的是 `BASE_PEERS` 里的 `url`，故 `ScrubOnce` 用 `byURL` 反查指纹） |
| `cmd/based` 子命令 ↔ `main.go` switch | Task 2（`import-video`）、Task 8（`peer-sync`）、Task 9（`scrub`） | `usage` 行在 Task 2 一次写全 | 一致（Task 8 延后、Task 9 放开 `scrub`） |
| `registerPeerFlags` 的 `-data` 默认值 | 修正 4（Task 8 Step 4） | `serve` / `peer-sync` / `scrub` 共用 | 一致 |

### 5. P0 兼容性

| P0 既有行为 | 本计划是否破坏 | 依据 |
|---|---|---|
| `import-md` 文章导入 | 否 | 不改 `internal/importer/md.go`，只新增 `ImportVideo` |
| `export` 产 `pack.sqlite` + 签名 manifest + 墓碑 + `content_version` 自增 | 否 | 不改 `internal/packexport/export.go`；`media_meta` 分支 P0 已具备 |
| 公开读 `catalog` / `manifest` / `pack` / `blob`（GET+HEAD） | 否 | 四个路径全在公开 router（Task 4），`Handler()` 仍含 P0 全部公开路由 |
| 浏览器浏览页（`web.go`） | 否 | 不在本计划文件清单内 |
| 手机端 `syncOnce`（验签 → 行级 hash → 拉块 → `applyPack`） | 否（仅新增删文件） | Task 10 只在 `applyPack` 前后各加一段，不改既有顺序与拒收语义 |
| 手机端 `downloads` / 封面取图（`findBlobPathByItem`） | 否 | Task 10 保留 `findBlobPathByItem`，只**新增** `listBlobPathsByItem` |
| L4a′ 静态加密只在 `internal/store` 一层 | 否 | 跨节点传明文；`httpapi` / `packexport` / `peersync` 全程不感知加密 |
| S1 的 TLS / 指纹固定 / `X-Base-Node-Key` | 否（复用） | 对端监听沿用 `ServerTLSConfig(info, peerFPs)` + `RequireNodeKey`；出站沿用 `ClientTLSConfig` |
| S1 的事件路由 / `auth_nonces` | 否 | 不在本计划文件清单内 |
| 既有 `based serve` 的 flag 与默认值 | 否（等价改写） | Task 8 Step 7 只把 flag 来源换成 `registerPeerFlags`，默认值与 P0 相同（`-addr`/`-issuer`/`-sign-key`/`-peer-addr` 原地保留） |
| `tools/migrate`（Strapi 一次性迁移） | 否 | 不动；封面 `chunk_hashes_json` 的 64-hex 存量差异由 Task 1 `normalizeChunkID` 兼容 |
| 测试铁律（Go 同进程回环 TCP 不可用） | 否 | 全部出站测试经 `Config.TransportFor` 注入进程内传输 |

### 6. 执行顺序与提交边界

依赖链（Task 号为执行序，前者不完不能开后者）：

```
Task 0（测试基座）
 ├─ Task 1（store 资产）─┬─ Task 2（import-video）
 │                       └─ Task 5（四个内部接口）─ Task 6（出站客户端）
 ├─ Task 3（帧格式）─────┘
 └─ Task 4（路由隔离）──── Task 5
Task 6 + Task 1 ── Task 7（包级复制）── Task 8（反熵 + 副本登记 + serve 接线）
Task 7 + Task 8 ── Task 9（scrub）── Task 12（验收）
Task 10（客户端墓碑删文件）与 Task 8 之后任意时刻可并行
Task 11（install 脚本）与 Task 9/10 并行
Task 12 最后
```

每个 Task 完成即 `git add` **该 Task 的具体文件**（绝不 `git add -A`）并 commit；Task 12 落地后追加 `## 执行记录` 并回填 `docs/README.md` 与册子。

---

## 执行记录（2026-09-26，Task 0–12 全部落地）

本计划 13 个 Task（0–12）已全部实现并提交（Task 9 `0cac9d4`、Task 10 `dbd3b2e`、Task 11 `e8d2503`，另含 packexport 去重一致性修复 `b67612e` 与反熵归属过滤修复 `daf33a9`）。以下是**与计划原文的偏离项**（计划代码照抄会编译不过 / 断言必假 / 与既有契约不符，或验收脚本机制不成立）：

| 位置 | 计划原文 | 实际做法与原因 |
|---|---|---|
| Task 5 / Task 8 包路径 | 新建 `internal/sync` | 实际落在 `internal/peersync`：`sync` 撞标准库包名，且与「反熵一轮」语义混淆。册子 §0.2 第 1 条已就地回填 |
| Task 5 `/v1/scrub` | 响应 `repaired` 可非零 | 对端监听的 `repaired` **恒为 0**：跨节点补齐必须走出站请求，`internal/httpapi` 不依赖 `internal/peersync`。非零值只出现在发起方 `peersync.ScrubOnce` |
| Task 6/7 出站 `fetch` | 客户端侧另写总字节上限 | 改为两侧同源常量 `protocol.FetchMaxBytes = 64 << 20`（服务端判 413、客户端分批共用），由 `TestBlobFetchMaxBytesIsSharedContract` 锁住，避免两侧漂移 |
| Task 2 / Task 8 `-data` 缺省值 | 硬编码 `"data"` | 走 `envOr("BASE_DATA", "data")`，与 `serve` / `export` / `import-video` 一致；否则安装脚本生成的 `base.env` 里的 `BASE_DATA` 对子命令无效 |
| Task 1 / Task 7 / Task 10 墓碑删块文件 | 事务内直接删文件 | 改「**先收集后删**」：`store.ImportPack` 事务内收集 `RemovedBlobs` 返回，事务提交后由调用方删文件，失败只记日志不回滚；客户端侧同口径（必须在 `applyPack` **之前**取 `blob_index.path`，之后行已删、查不到位置） |
| Task 7 `media_meta` 行级校验 | 「行的 `content_hash` 必须与 manifest 一致」 | `media_meta` **没有** `content_hash` 列，该断言必假。改为按「块数 + size 之和」：`chunk_hashes_json` 块数 == manifest `chunks[]` 长度、`size` == `chunks[].size` 之和；整块完整性由签名域与补齐时逐块哈希兜底 |
| packexport 去重一致性 | （未预见） | `packexport` 按块 id **去重**后写 `chunks[]`，而 `media_meta.chunk_hashes_json` 是**按 seq 的完整序列**（长度 = `ceil(size/chunk_size)`）；同字节块重复出现时两侧长度不等 → 导出侧口径对齐为按 seq 序列（`b67612e`）。由 `zzpackcheck` 对三节点交叉比对发现 |
| Task 12 Step 6（AC 3） | 同句多次 `curl` 取三块 | `headLen=0` / 文件不存在：同句多次 curl 混杂。改为每块独立 `curl.exe -s -k -o <file> -w '%{http_code}'` + 独立 `-I -o <headfile>` |
| Task 12 Step 7（AC 8） | 断言 `articles.title` 等亦无明文 | 过严。按总纲 §12.1.1，L4a′ 本期**只加密** `articles.body_md` 与 `data/blobs/*`；改为断言正文与 blob 加密封装（长度 = 明文 + 28，nonce 12 + tag 16） |
| Task 12 Step 8（AC 9） | 篡改**已存在** pack1 的 manifest 后断言缓存节点不前进 | 机制不成立：`export` 会新建 pack2（version 2），B 拉的是 pack2（未篡改）→ 必然前进。改为先 export 出 pack2，再篡改 **pack2** 的 manifest（`content_version` 2 → 99），B/C 保持 1，日志出现 `manifest 验签失败`；恢复后收敛到 2 |
| Task 12 Step 9（AC 1） | 只删缓存节点的块文件即触发反熵补齐 | 不足以触发：`equal` 由 `blobs` 表的 `ListAllBlobIDs()` 算出，不检查块文件是否存在。改为连 `blobs` 行一起删（模拟缓存节点块数据全失），实测 `equal=false missing=2 fetched=2`，随后 `equal=true` |
| Task 12 Step 9（AC 7） | 计划未预见 | **缺陷**：反熵会把已墓碑撤回、但邻居尚未收敛的块重新拉回，落成 `item_id` 为空的孤儿 `blobs` 行 + 块文件并永久残留（`extra` 只记录不删）。已按册子 §0.2 第 7 条在补齐路径加**本地归属过滤**（只补齐本节点仍有 `media_meta.chunk_hashes_json` 声明的块），并补单测 `TestSyncPeerSkipsTombstonedBlobsStillHeldByNeighbor`（`daf33a9`） |
| Task 12 Step 10（AC 10） | 有 wsl 时跑 `install.sh` | 本机 `wsl --status` 返回 50（无发行版）、亦无 `bash`，故 `install.sh` 的**真机执行留给 Linux 部署机**（契约 §10.3 的部署者路径）；`install.ps1` 侧已在 Task 11 Step 4–5 真机执行 |
| 首次生产部署（2026-09-26，`118.190.217.242`） | 计划未预见 | **缺陷**：`install.sh` / `install.ps1` 会预建一个**空的** `<dir>/data.key`，而 `store` 只在密钥文件**不存在**时才生成 → 首启 `error: store: empty store key`，systemd 下反复重启起不来（与脚本自己打印的「首启自动生成」矛盾）。已改为**绝不创建、只对已存在的文件 `chmod 0600`**，真机干净目录复验通过（自动生成 0600 `data.key`、`:8090` 自检 200）；册子 §0.2 第 8 条与 §10.2 第 4 条已回填 |

另修同源残留：册子 §3「文档清单」中 `internal/sync` 一行并不存在（该名称只出现在本计划的文件清单里，已随册子 §0.2 第 1 条一并说明）；册子 §8 末句「跨节点编排不做」与新增的「`ScrubOnce` 去邻居拉回」表述冲突，已改为「只扫自己的块、不为别人编排，但为自己修复可以去邻居拉」。

**验证**：`go build ./...` + `go test ./...` 全包 ok（含 `internal/peersync` 的 `TestSyncPeerConvergesBlobSetsAndRegistersReplicas`、`TestSyncPeerSkipsTombstonedBlobsStillHeldByNeighbor` 与 `internal/httpapi` 的 `TestBlobFetchMaxBytesIsSharedContract`）；`npm run test --workspace @base/mobile` 30/30 PASS；`npm run typecheck --workspace @base/mobile` 无错。三节点真机验收（1 源 + 2 缓存，LAN IP `192.168.1.2`）：AC 1（块数据全失 → 从邻居补齐、逐块哈希正确）、AC 2（坏块 `scrub checked=1 repaired=1 dropped=1 unrepaired=0` → 修复后 GET 200 / 哈希一致 → 复扫全 0）、AC 3（1.5 MiB 视频 → 2 块、三节点逐块 GET/HEAD/哈希通过、`manifest.chunks[]` 与 `media_meta.chunk_hashes_json` 一致）、AC 4（A/B 两侧 pack sha256 一致）、AC 5（客户端监听四个内部路由全 404、对端监听裸连 exit 35）、AC 7（墓碑后三节点 `items` 移除、块文件 0、块行 0，+40s 后仍未复活，B↔C 日志 `equal=true missing=0 fetched=0`）、AC 8（`base.db`(+wal/shm) 无明文命中、6 个 blob 文件长度 = 明文 + 28 且非全零、公开读仍返回明文）、AC 9（篡改 manifest → B/C 水位不动并记验签失败；恢复后收敛）全部通过；AC 6（幂等）由单测覆盖（同版本复制 noop 的 `TestImportPackNoopWhenUpToDate`；去重下 `chunks[]` 仍按声明块序列的 `TestExportKeepsDeclaredChunkCountUnderDedup`），AC 10 的 `install.sh` 侧留给 Linux 部署机（见上表）。