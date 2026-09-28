# base 贡献度量与动态角色实施计划（治理主线首册 #23）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让任意节点独立验证「这一条内容是谁写的」，并据本节点可验数据实时派生出「贡献前 10 名」治理者名册，附一个匿名读接口与一个展示层昵称写接口。

**Architecture:** 归属的权威是**签名**（`manifest.entries[].author_id` / `author_sig` + `manifest.contributors` 内嵌公钥），节点的 `items.author_id` / `author_sig` 只是「入库时已验签」的本地缓存。名册是**派生值**：不落表、无任期、无同步，输入只吃「本节点持有且带作者签名」的内容条目。签名原语走既有 `protocol.Canonicalize` / `Sign` / `Verify`，鉴权复用既有 `requireAuth`，**不新增编码规则、不新增鉴权形态、不新增枚举值、不 bump `schema_version`**。

**Tech Stack:** Go（`internal/protocol`、`internal/store`、`internal/peersync`、`internal/packexport`、`internal/httpapi`，SQLite via `modernc.org/sqlite`）；TypeScript（`packages/protocol-ts`，`@noble/curves` / `@noble/hashes`，vitest）。

**上游册子：** [docs/superpowers/specs/2026-09-28-base-contribution-roles-design.md](file:///e:/code/base/docs/superpowers/specs/2026-09-28-base-contribution-roles-design.md)（本计划的字段名、常量、语义一律以册子为准；冲突时先改册子）

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `internal/protocol/author.go`（新） | `author_sig` 的签名字节定义与验签（唯一的编码口径） |
| `internal/protocol/manifest.go`（改） | `Entry` 加 `author_id`/`author_sig`；`Manifest` 加 `contributors`（全部 `omitempty`） |
| `internal/store/schema.go`（改） | `profiles` 建表；`items` 后加列迁移 + `idx_items_author` |
| `internal/store/contributor.go`（新） | 门槛常量、`Candidate`、`deriveRoster`、`ContributorRoster`、`profiles` 读写、`ListMediaDurations` |
| `internal/store/store.go`（改） | `Item` 加两列；三处 SELECT + `scanItem` 同步 |
| `internal/store/packimport.go`（改） | `PackEntry` 加两列；`items` 写入/覆盖带归属 |
| `internal/store/identity.go`（改） | `LookupIdentities`（批量反查公钥） |
| `internal/peersync/packimport.go`（改） | 入库验签 `resolveAuthor`：验不过只降级该条，不拒整包 |
| `internal/packexport/export.go`（改） | 导出时回填 `author_id`/`author_sig` 并按本地 `identities` 重建 `contributors` |
| `internal/httpapi/contributor.go`（新） | `GET /v1/contributors` + `POST /v1/profile` |
| `internal/httpapi/server.go` / `authmw.go`（改） | 注册两条路由；补两个错误码文案 |
| `packages/protocol-ts/src/author.ts`（新） | TS 侧 `authorSignBytes` / `verifyAuthorSig` |
| `packages/protocol-ts/src/manifest.ts` / `index.ts`（改） | `Entry`/`Manifest` 类型补字段；导出 `author.ts` |
| `vectors/v1/authorsig.json`（新） | Go 与 TS 双消费的契约向量 |
| `docs/README.md`（改） | 登记本计划（#24）与状态 |

---

## Task 1: Go 侧 author_sig 原语

**Files:**
- Create: `internal/protocol/author.go`
- Test: `internal/protocol/author_test.go`

- [ ] **Step 1: 写失败测试**

创建 `internal/protocol/author_test.go`：

```go
package protocol

import "testing"

// 固定输入下的规范化签名字节（键名与顺序即契约，勿改）。
func TestAuthorSignBytesCanonicalForm(t *testing.T) {
	got, err := AuthorSignBytes(
		"article:demo-1",
		"af7d2109429d7850f7ae542da6b0d83403846119fc160ed8060cc3814f676a48",
		"f78672b2f87ff80b248323a4be7c3da6",
	)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"alg":"ed25519","author_id":"f78672b2f87ff80b248323a4be7c3da6","content_hash":"af7d2109429d7850f7ae542da6b0d83403846119fc160ed8060cc3814f676a48","domain":"base/author-v1","item_id":"article:demo-1"}`
	if string(got) != want {
		t.Fatalf("签名字节不一致:\n got %s\nwant %s", got, want)
	}
}

func TestAuthorSigRoundTrip(t *testing.T) {
	const seed = "6f1e0d9c8b7a6958473625142332415061728394a5b6c7d8e9f0a1b2c3d4e5f6"
	kp, err := KeyPairFromSeed(seed)
	if err != nil {
		t.Fatal(err)
	}
	id, err := IdentityID(kp.PubHex)
	if err != nil {
		t.Fatal(err)
	}
	const contentHash = "af7d2109429d7850f7ae542da6b0d83403846119fc160ed8060cc3814f676a48"
	b, err := AuthorSignBytes("article:demo-1", contentHash, id)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := Sign(seed, b)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := VerifyAuthorSig(kp.PubHex, "article:demo-1", contentHash, id, sig)
	if err != nil || !ok {
		t.Fatalf("本人签名应通过: ok=%v err=%v", ok, err)
	}
	// 内容改了（content_hash 变）→ 归属失效（册子 §8 风险 7）
	ok, err = VerifyAuthorSig(kp.PubHex, "article:demo-1", "00"+contentHash[2:], id, sig)
	if err != nil || ok {
		t.Fatalf("改内容后不应通过: ok=%v err=%v", ok, err)
	}
	// 换公钥 → 不通过
	other, err := KeyPairFromSeed("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
	if err != nil {
		t.Fatal(err)
	}
	ok, err = VerifyAuthorSig(other.PubHex, "article:demo-1", contentHash, id, sig)
	if err != nil || ok {
		t.Fatalf("换公钥不应通过: ok=%v err=%v", ok, err)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/protocol/ -run TestAuthorSig -v`
Expected: FAIL —— `undefined: AuthorSignBytes`

- [ ] **Step 3: 写最小实现**

创建 `internal/protocol/author.go`：

```go
package protocol

// AuthorSigDomain 是作者归属签名的域分隔串，避免与其他签名场景交叉复用（治理册 §2.1）。
const AuthorSigDomain = "base/author-v1"

// AuthorSigInput 是 author_sig 的签名字节结构（键名即契约，勿改）。
type AuthorSigInput struct {
	Alg         string `json:"alg"`
	Domain      string `json:"domain"`
	ItemID      string `json:"item_id"`
	ContentHash string `json:"content_hash"`
	AuthorID    string `json:"author_id"`
}

// AuthorSignBytes 返回 author_sig 的规范化签名字节。
// 编码走既有 Canonicalize，不新增编码规则（册子 §2.1）。
func AuthorSignBytes(itemID, contentHash, authorID string) ([]byte, error) {
	return Canonicalize(AuthorSigInput{
		Alg: AlgEd25519, Domain: AuthorSigDomain,
		ItemID: itemID, ContentHash: contentHash, AuthorID: authorID,
	})
}

// VerifyAuthorSig 用作者公钥验证条目归属；签名不合法即返回 (false, nil)。
func VerifyAuthorSig(pubHex, itemID, contentHash, authorID, sigHex string) (bool, error) {
	b, err := AuthorSignBytes(itemID, contentHash, authorID)
	if err != nil {
		return false, err
	}
	return Verify(pubHex, b, sigHex)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/protocol/ -run TestAuthorSig -v`
Expected: PASS（两个用例）

- [ ] **Step 5: 提交**

```bash
git add internal/protocol/author.go internal/protocol/author_test.go
git commit -m "feat(protocol): author_sig 签名字节定义与验签原语"
```

---

## Task 2: 契约向量 authorsig.json（Go 侧消费）

**Files:**
- Create: `vectors/v1/authorsig.json`
- Test: `internal/protocol/authorsig_vector_test.go`

- [ ] **Step 1: 写向量文件**

创建 `vectors/v1/authorsig.json`（值由 Task 1 的实现产出，已核验）：

```json
{
  "cases": [
    {
      "author_id": "f78672b2f87ff80b248323a4be7c3da6",
      "content_hash": "af7d2109429d7850f7ae542da6b0d83403846119fc160ed8060cc3814f676a48",
      "item_id": "article:demo-1",
      "name": "article-demo-1",
      "sign_bytes": "{\"alg\":\"ed25519\",\"author_id\":\"f78672b2f87ff80b248323a4be7c3da6\",\"content_hash\":\"af7d2109429d7850f7ae542da6b0d83403846119fc160ed8060cc3814f676a48\",\"domain\":\"base/author-v1\",\"item_id\":\"article:demo-1\"}",
      "signature_hex": "4d60b2e2e4f998bea25bd0124dffcdf0fb44ccf2db886ae2cac9764d9e03d06668dfa029440cc3554e93737644bb5b1c1601505c14d22c672bed235b41c85203"
    }
  ],
  "key": {
    "pub_hex": "9471ed98cfff058f9b91cd3d1df44f1a78230d8e3ceb2311981307a04c5be6d0",
    "seed_hex": "6f1e0d9c8b7a6958473625142332415061728394a5b6c7d8e9f0a1b2c3d4e5f6"
  },
  "version": 1
}
```

- [ ] **Step 2: 写失败测试**

创建 `internal/protocol/authorsig_vector_test.go`（结构与 `manifest_vector_test.go` 一致）：

```go
package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAuthorSigVectorFile(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "authorsig.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var f struct {
		Version int `json:"version"`
		Key     struct {
			SeedHex string `json:"seed_hex"`
			PubHex  string `json:"pub_hex"`
		} `json:"key"`
		Cases []struct {
			Name         string `json:"name"`
			ItemID       string `json:"item_id"`
			ContentHash  string `json:"content_hash"`
			AuthorID     string `json:"author_id"`
			SignBytes    string `json:"sign_bytes"`
			SignatureHex string `json:"signature_hex"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if f.Version != 1 || len(f.Cases) == 0 {
		t.Fatalf("向量文件结构错误: version=%d cases=%d", f.Version, len(f.Cases))
	}
	kp, err := KeyPairFromSeed(f.Key.SeedHex)
	if err != nil {
		t.Fatal(err)
	}
	if kp.PubHex != f.Key.PubHex {
		t.Fatalf("向量公钥与种子不匹配: %s != %s", kp.PubHex, f.Key.PubHex)
	}
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			// 自证：author_id 必须由公钥派生（册子 §2.1）
			id, err := IdentityID(f.Key.PubHex)
			if err != nil {
				t.Fatal(err)
			}
			if id != c.AuthorID {
				t.Fatalf("author_id 与公钥失配: %s != %s", id, c.AuthorID)
			}
			sb, err := AuthorSignBytes(c.ItemID, c.ContentHash, c.AuthorID)
			if err != nil {
				t.Fatal(err)
			}
			if string(sb) != c.SignBytes {
				t.Fatalf("签名字节不一致:\n got %s\nwant %s", sb, c.SignBytes)
			}
			ok, err := VerifyAuthorSig(f.Key.PubHex, c.ItemID, c.ContentHash, c.AuthorID, c.SignatureHex)
			if err != nil || !ok {
				t.Fatalf("向量验签失败: ok=%v err=%v", ok, err)
			}
			sig, err := Sign(f.Key.SeedHex, sb)
			if err != nil {
				t.Fatal(err)
			}
			if sig != c.SignatureHex {
				t.Fatalf("签名复算 = %s, want %s", sig, c.SignatureHex)
			}
		})
	}
}
```

- [ ] **Step 3: 跑测试**

Run: `go test ./internal/protocol/ -run TestAuthorSigVectorFile -v`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add vectors/v1/authorsig.json internal/protocol/authorsig_vector_test.go
git commit -m "test(protocol): 新增 authorsig 契约向量与 Go 侧消费"
```

---

## Task 3: TS 侧 author_sig 与向量消费

**Files:**
- Create: `packages/protocol-ts/src/author.ts`
- Modify: `packages/protocol-ts/src/index.ts`, `packages/protocol-ts/src/manifest.ts`, `packages/protocol-ts/src/vectors.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/protocol-ts/src/vectors.test.ts` 顶部的 import 列表里补上 `authorSignBytes`、`verifyAuthorSig`（保持字母序插入）：

```ts
import {
  ALG_ED25519,
  authorSignBytes,
  blobId,
  canonicalize,
  deriveIdentityId,
  derivePackId,
  emptyBodySha256,
  isIdentityId,
  keyPairFromSeed,
  manifestBlobIds,
  merkleRoot,
  releaseDocSha256,
  releaseSignBytes,
  requestSignBytes,
  sha256Hex,
  sign,
  signBytes,
  signRelease,
  utf8,
  verify,
  verifyAuthorSig,
  verifyManifest,
  verifyRelease,
  type Manifest,
  type ReleaseDoc,
} from "./index";
```

在同文件末尾追加：

```ts
describe("authorsig.json", () => {
  const f = load("authorsig.json");
  it("version 与密钥", () => {
    expect(f.version).toBe(1);
    expect(keyPairFromSeed(f.key.seed_hex).pubHex).toBe(f.key.pub_hex);
  });
  for (const c of f.cases) {
    it(c.name, () => {
      expect(deriveIdentityId(f.key.pub_hex)).toBe(c.author_id);
      expect(authorSignBytes(c.item_id, c.content_hash, c.author_id)).toBe(c.sign_bytes);
      expect(sign(f.key.seed_hex, utf8(c.sign_bytes))).toBe(c.signature_hex);
      expect(verifyAuthorSig(f.key.pub_hex, c.item_id, c.content_hash, c.author_id, c.signature_hex)).toBe(true);
    });
  }
  it("篡改签名或内容后拒收", () => {
    const c = f.cases[0];
    expect(verifyAuthorSig(f.key.pub_hex, c.item_id, c.content_hash, c.author_id, "0" + c.signature_hex.slice(1))).toBe(false);
    expect(verifyAuthorSig(f.key.pub_hex, c.item_id, "0" + c.content_hash.slice(1), c.author_id, c.signature_hex)).toBe(false);
  });
});
```

在 `packages/protocol-ts/src/manifest.ts` 的 `Entry` 与 `Manifest` 上补两个**可选**字段（缺省即无归属，不 bump `schema_version`）：

```ts
export interface Entry {
  item_id: string;
  source: string;
  type: string;
  title: string;
  source_rev: string;
  content_hash: string;
  sqlite_table: string;
  chunks?: Chunk[];
  dist_class: string;
  author_id?: string;
  author_sig?: string;
}

export interface Manifest {
  pack_id: string;
  schema_version: number;
  issuer: string;
  issued_at: string;
  content_version: number;
  entries: Entry[];
  tombstone: Tombstone[];
  contributors?: Record<string, string>;
  merkle_root: string;
  signature: string;
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/protocol-ts && npx vitest run src/vectors.test.ts -t authorsig`
Expected: FAIL —— `authorSignBytes is not a function`（或 typecheck 报未导出）

- [ ] **Step 3: 写最小实现**

创建 `packages/protocol-ts/src/author.ts`：

```ts
import { canonicalize, type Json } from "./canonical";
import { verify } from "./ed25519";
import { utf8 } from "./hash";
import { ALG_ED25519 } from "./identity";

/** 作者归属签名的域分隔串（与 Go 侧 protocol.AuthorSigDomain 逐字节一致）。 */
export const AUTHOR_SIG_DOMAIN = "base/author-v1";

export interface AuthorSigInput {
  alg: string;
  domain: string;
  item_id: string;
  content_hash: string;
  author_id: string;
}

/** 返回 author_sig 的规范化签名字节（治理册 §2.1）。 */
export function authorSignBytes(itemId: string, contentHash: string, authorId: string): string {
  const input: AuthorSigInput = {
    alg: ALG_ED25519,
    domain: AUTHOR_SIG_DOMAIN,
    item_id: itemId,
    content_hash: contentHash,
    author_id: authorId,
  };
  return canonicalize(input as unknown as Json);
}

/** 用作者公钥验证条目归属；任一步不成立即 false。 */
export function verifyAuthorSig(
  pubHex: string,
  itemId: string,
  contentHash: string,
  authorId: string,
  sigHex: string,
): boolean {
  return verify(pubHex, utf8(authorSignBytes(itemId, contentHash, authorId)), sigHex);
}
```

在 `packages/protocol-ts/src/index.ts` 追加一行（保持既有分组顺序）：

```ts
export * from "./author";
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `cd packages/protocol-ts && npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS，tsc 无输出

- [ ] **Step 5: 提交**

```bash
git add packages/protocol-ts/src/author.ts packages/protocol-ts/src/index.ts packages/protocol-ts/src/manifest.ts packages/protocol-ts/src/vectors.test.ts
git commit -m "feat(protocol-ts): author_sig 签名与验签并消费契约向量"
```

---

## Task 4: Manifest 结构新增可选字段（Go）与回归

**Files:**
- Modify: `internal/protocol/manifest.go`
- Test: `internal/protocol/manifest_test.go`（追加）

- [ ] **Step 1: 写失败测试**

在 `internal/protocol/manifest_test.go` 末尾追加：

```go
// 归属字段是可选的：空值不进签名字节，非空值进——这是「不 bump schema_version」的依据。
func TestManifestAuthorFieldsInSignBytes(t *testing.T) {
	base := Manifest{
		PackID: "p", SchemaVersion: 1, Issuer: "base-node-1", IssuedAt: "2026-01-02T03:04:05Z",
		ContentVersion: 7, Tombstone: []Tombstone{}, MerkleRoot: "m",
		Entries: []Entry{{ItemID: "article:demo-1", Source: "article", Type: "article",
			Title: "演示一", SourceRev: "rev-1", ContentHash: "h", SQLiteTable: "articles", DistClass: "public"}},
	}
	empty, err := base.SignBytes()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(empty), "author_id") || strings.Contains(string(empty), "contributors") {
		t.Fatalf("空归属/空名册不得进入签名字节: %s", empty)
	}

	withAuthor := base
	withAuthor.Entries = []Entry{{ItemID: "article:demo-1", Source: "article", Type: "article",
		Title: "演示一", SourceRev: "rev-1", ContentHash: "h", SQLiteTable: "articles", DistClass: "public",
		AuthorID: "f78672b2f87ff80b248323a4be7c3da6", AuthorSig: "00"}}
	withAuthor.Contributors = map[string]string{"f78672b2f87ff80b248323a4be7c3da6": "9471ed98cfff058f9b91cd3d1df44f1a78230d8e3ceb2311981307a04c5be6d0"}
	got, err := withAuthor.SignBytes()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"author_id":"f78672b2f87ff80b248323a4be7c3da6"`, `"author_sig":"00"`, `"contributors":{`} {
		if !strings.Contains(string(got), want) {
			t.Fatalf("签名字节缺少 %s: %s", want, got)
		}
	}
}
```

若该文件尚未 import `strings`，在 import 块补上。

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/protocol/ -run TestManifestAuthorFieldsInSignBytes -v`
Expected: FAIL —— `unknown field AuthorID`

- [ ] **Step 3: 改结构**

`internal/protocol/manifest.go` 的 `Entry` 末尾（`DistClass` 之后）加：

```go
	// 作者归属（治理册 §2.1）：空 = 无归属、不计贡献；全部可选，故不 bump schema_version。
	AuthorID  string `json:"author_id,omitempty"`
	AuthorSig string `json:"author_sig,omitempty"`
```

`Manifest` 加：

```go
	// contributors 内嵌作者公钥（author_id → pubkey_hex），使验证者无需信任发行节点（治理册 §2.1）。
	Contributors map[string]string `json:"contributors,omitempty"`
```

- [ ] **Step 4: 跑全包测试（含既有 manifest 向量回归）**

Run: `go test ./internal/protocol/ -v`
Expected: 全部 PASS，特别是 `TestManifestVectorFile`（既有向量的 `sign_bytes` 与 `manifest_sha256` 不变，证明加字段未破坏历史包）

- [ ] **Step 5: 提交**

```bash
git add internal/protocol/manifest.go internal/protocol/manifest_test.go
git commit -m "feat(protocol): manifest 新增 author_id/author_sig/contributors 可选字段"
```

---

## Task 5: store 迁移——items 归属缓存列 + profiles 表

**Files:**
- Modify: `internal/store/schema.go`
- Test: `internal/store/contributor_test.go`（本 Task 建文件，先放迁移用例）

- [ ] **Step 1: 写失败测试**

创建 `internal/store/contributor_test.go`：

```go
package store

import "testing"

func TestMigrateAddsAuthorColumnsAndProfiles(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	cols, err := tableColumns(st.db, "items")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []string{"author_id", "author_sig"} {
		if !cols[c] {
			t.Fatalf("items 缺少列 %s", c)
		}
	}
	if !cols["state"] {
		t.Fatal("items 既有列丢失")
	}
	pcols, err := tableColumns(st.db, "profiles")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []string{"id", "name", "updated_at"} {
		if !pcols[c] {
			t.Fatalf("profiles 缺少列 %s", c)
		}
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	// 二次打开：列已存在时迁移必须幂等（对应老库补列的路径）
	st2, err := Open(dir)
	if err != nil {
		t.Fatalf("二次 Open: %v", err)
	}
	defer func() { _ = st2.Close() }()
	if _, err := st2.db.Exec(`SELECT author_id, author_sig FROM items LIMIT 1`); err != nil {
		t.Fatalf("补列后仍不可查询: %v", err)
	}
	if _, err := st2.db.Exec(`SELECT id, name, updated_at FROM profiles LIMIT 1`); err != nil {
		t.Fatalf("profiles 不可查询: %v", err)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/store/ -run TestMigrateAddsAuthorColumnsAndProfiles -v`
Expected: FAIL —— `items 缺少列 author_id`

- [ ] **Step 3: 改迁移**

`internal/store/schema.go`：在 `schemaStatements` 末尾（`peer_sync_cursor` 之后）加 `profiles`：

```go
	// profiles：身份**主动设置**的公开昵称（治理册 §3.2）。
	// 展示层：不跨节点同步、不进 events、不参与反熵；与 escrow.username 无关，不复用、不因本册公开。
	`CREATE TABLE IF NOT EXISTS profiles(
		id         TEXT PRIMARY KEY,
		name       TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
```

在 `eventColumnMigrations` 之后加：

```go
// itemColumnMigrations 是 items 表的**后加列**（治理册 §3.1 的归属缓存）。
// 与 events 同因：schemaStatements 全是 CREATE TABLE IF NOT EXISTS，对既有表不补列。
var itemColumnMigrations = []struct{ column, ddl string }{
	{"author_id", `ALTER TABLE items ADD COLUMN author_id TEXT NOT NULL DEFAULT ''`},
	{"author_sig", `ALTER TABLE items ADD COLUMN author_sig TEXT NOT NULL DEFAULT ''`},
}
```

`migrate()` 在 events 索引之后追加一段：

```go
	itemCols, err := tableColumns(db, "items")
	if err != nil {
		return err
	}
	for _, m := range itemColumnMigrations {
		if itemCols[m.column] {
			continue
		}
		if _, err := db.Exec(m.ddl); err != nil {
			return fmt.Errorf("store: migrate items.%s: %w", m.column, err)
		}
	}
	// 索引必须在补列之后建：idx_items_author 引用新列。
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_items_author ON items(author_id, state)`); err != nil {
		return fmt.Errorf("store: migrate items index: %w", err)
	}
	return nil
```

（原 `migrate()` 末尾的 `return nil` 由上句取代，勿留两个。）

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/store/ -run TestMigrateAddsAuthorColumnsAndProfiles -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add internal/store/schema.go internal/store/contributor_test.go
git commit -m "feat(store): items 归属缓存列与 profiles 表迁移"
```

---

## Task 6: 归属缓存的读写（Item 结构 + ImportPack）

**Files:**
- Modify: `internal/store/store.go`, `internal/store/packimport.go`
- Test: `internal/store/packimport_test.go`（追加）

- [ ] **Step 1: 写失败测试**

在 `internal/store/packimport_test.go` 末尾追加：

```go
// 同一包内「归属通过」与「归属为空」的条目各自独立处理：空归属只是不计贡献，不影响入库。
func TestImportPackStoresAuthorColumns(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	const (
		authorID = "f78672b2f87ff80b248323a4be7c3da6"
		sigHex   = "4d60b2e2e4f998bea25bd0124dffcdf0fb44ccf2db886ae2cac9764d9e03d06668dfa029440cc3554e93737644bb5b1c1601505c14d22c672bed235b41c85203"
	)
	body := "正文"
	hash := protocol.SHA256Hex([]byte(body))
	entries := []PackEntry{
		{ItemID: "article:with-author", Source: "article", Type: "article", Title: "有归属",
			ContentHash: hash, SQLiteTable: "articles", DistClass: "public", BodyMD: body,
			AuthorID: authorID, AuthorSig: sigHex},
		{ItemID: "article:no-author", Source: "article", Type: "article", Title: "无归属",
			ContentHash: hash, SQLiteTable: "articles", DistClass: "public", BodyMD: body},
	}
	if _, err := st.ImportPack(3, entries, []protocol.Tombstone{}); err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	it, ok, err := st.GetItem("article:with-author")
	if err != nil || !ok {
		t.Fatalf("GetItem: ok=%v err=%v", ok, err)
	}
	if it.AuthorID != authorID || it.AuthorSig != sigHex {
		t.Fatalf("归属缓存未落库: %+v", it)
	}
	it2, _, err := st.GetItem("article:no-author")
	if err != nil {
		t.Fatal(err)
	}
	if it2.AuthorID != "" || it2.AuthorSig != "" {
		t.Fatalf("无归属条目两列应为空: %+v", it2)
	}

	// 再次导入同一 item 且不带归属 → 覆盖为空（避免陈旧归属残留）
	if _, err := st.ImportPack(4, []PackEntry{{
		ItemID: "article:with-author", Source: "article", Type: "article", Title: "有归属",
		ContentHash: hash, SQLiteTable: "articles", DistClass: "public", BodyMD: body,
	}}, []protocol.Tombstone{}); err != nil {
		t.Fatalf("二次 ImportPack: %v", err)
	}
	it3, _, err := st.GetItem("article:with-author")
	if err != nil {
		t.Fatal(err)
	}
	if it3.AuthorID != "" || it3.AuthorSig != "" {
		t.Fatalf("重导后归属应被覆盖为空: %+v", it3)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/store/ -run TestImportPackStoresAuthorColumns -v`
Expected: FAIL —— `unknown field AuthorID in struct literal`

- [ ] **Step 3: 改实现**

`internal/store/store.go` 的 `Item` 加两字段：

```go
	// 归属缓存（治理册 §3.1）：权威在签名里，这两列是「入库时已验签通过」的本地缓存。
	AuthorID  string
	AuthorSig string
```

三处 SELECT 与 `scanItem` 同步加上 `author_id,author_sig`：

- `GetItem`：`SELECT item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig FROM items WHERE item_id=?`
- `ListItems`：同列顺序，`FROM items`
- `ListItemsPage`：同列顺序
- `scanItem`：`&it.SQLiteTable, &it.DistClass, &it.State, &it.UpdatedAt, &it.AuthorID, &it.AuthorSig`

`internal/store/packimport.go` 的 `PackEntry` 加：

```go
	// 归属（治理册 §3.1）：由调用方（peersync）验签后填入；验不过则为空串。
	AuthorID  string
	AuthorSig string
```

`ImportPack` 的 items 写入改为：

```go
		if _, err := tx.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
			VALUES(?,?,?,?,?,?,?,'public','active',?,?,?)
			ON CONFLICT(item_id) DO UPDATE SET
				source=excluded.source, type=excluded.type, title=excluded.title, source_rev=excluded.source_rev,
				content_hash=excluded.content_hash, sqlite_table=excluded.sqlite_table,
				dist_class=excluded.dist_class, state=excluded.state, updated_at=excluded.updated_at,
				author_id=excluded.author_id, author_sig=excluded.author_sig`,
			e.ItemID, e.Source, e.Type, e.Title, e.SourceRev, e.ContentHash, e.SQLiteTable, updated, e.AuthorID, e.AuthorSig); err != nil {
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/store/ -v`
Expected: 全部 PASS（`Item` 加字段后 `ListItems` 等调用的回归一并在此暴露）

- [ ] **Step 5: 提交**

```bash
git add internal/store/store.go internal/store/packimport.go internal/store/packimport_test.go
git commit -m "feat(store): items 归属缓存列读写"
```

---

## Task 7: 入库验签（peersync）

**Files:**
- Modify: `internal/peersync/packimport.go`
- Test: `internal/peersync/author_test.go`（新建，纯函数用例）

- [ ] **Step 1: 写失败测试**

创建 `internal/peersync/author_test.go`：

```go
package peersync

import (
	"testing"

	"github.com/johocn/base/internal/protocol"
)

const (
	authorSeed = "6f1e0d9c8b7a6958473625142332415061728394a5b6c7d8e9f0a1b2c3d4e5f6"
	authorHash = "af7d2109429d7850f7ae542da6b0d83403846119fc160ed8060cc3814f676a48"
)

func signedEntry(t *testing.T, itemID string) protocol.Entry {
	t.Helper()
	kp, err := protocol.KeyPairFromSeed(authorSeed)
	if err != nil {
		t.Fatal(err)
	}
	id, err := protocol.IdentityID(kp.PubHex)
	if err != nil {
		t.Fatal(err)
	}
	sb, err := protocol.AuthorSignBytes(itemID, authorHash, id)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := protocol.Sign(authorSeed, sb)
	if err != nil {
		t.Fatal(err)
	}
	return protocol.Entry{
		ItemID: itemID, Source: "article", Type: "article", Title: "演示",
		ContentHash: authorHash, SQLiteTable: "articles", DistClass: "public",
		AuthorID: id, AuthorSig: sig,
	}
}

func authorPub(t *testing.T) (id, pub string) {
	t.Helper()
	kp, err := protocol.KeyPairFromSeed(authorSeed)
	if err != nil {
		t.Fatal(err)
	}
	id, err = protocol.IdentityID(kp.PubHex)
	if err != nil {
		t.Fatal(err)
	}
	return id, kp.PubHex
}

func TestResolveAuthorAcceptsValid(t *testing.T) {
	id, pub := authorPub(t)
	e := signedEntry(t, "article:demo-1")
	man := protocol.Manifest{Contributors: map[string]string{id: pub}}
	gotID, gotSig := resolveAuthor(man, e)
	if gotID != id || gotSig != e.AuthorSig {
		t.Fatalf("合法归属应保留: %q %q", gotID, gotSig)
	}
}

func TestResolveAuthorDegradesWithoutRejecting(t *testing.T) {
	id, pub := authorPub(t)

	// 1) 缺 contributors
	if gotID, gotSig := resolveAuthor(protocol.Manifest{}, signedEntry(t, "article:demo-1")); gotID != "" || gotSig != "" {
		t.Fatalf("缺公告钥应降级: %q %q", gotID, gotSig)
	}
	// 2) 公钥与 author_id 失配（篡改公钥）
	other, err := protocol.KeyPairFromSeed("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
	if err != nil {
		t.Fatal(err)
	}
	if gotID, gotSig := resolveAuthor(protocol.Manifest{Contributors: map[string]string{id: other.PubHex}}, signedEntry(t, "article:demo-1")); gotID != "" || gotSig != "" {
		t.Fatalf("公钥失配应降级: %q %q", gotID, gotSig)
	}
	// 3) 篡改 author_sig
	bad := signedEntry(t, "article:demo-1")
	bad.AuthorSig = "0" + bad.AuthorSig[1:]
	if gotID, gotSig := resolveAuthor(protocol.Manifest{Contributors: map[string]string{id: pub}}, bad); gotID != "" || gotSig != "" {
		t.Fatalf("验签失败应降级: %q %q", gotID, gotSig)
	}
	// 4) 内容变了（content_hash 不再是签名里的那个）
	moved := signedEntry(t, "article:demo-1")
	moved.ContentHash = "00" + moved.ContentHash[2:]
	if gotID, gotSig := resolveAuthor(protocol.Manifest{Contributors: map[string]string{id: pub}}, moved); gotID != "" || gotSig != "" {
		t.Fatalf("内容变更应重签，否则降级: %q %q", gotID, gotSig)
	}
	// 5) 本就无归属
	plain := signedEntry(t, "article:demo-1")
	plain.AuthorID, plain.AuthorSig = "", ""
	if gotID, gotSig := resolveAuthor(protocol.Manifest{Contributors: map[string]string{id: pub}}, plain); gotID != "" || gotSig != "" {
		t.Fatalf("无归属应保持空: %q %q", gotID, gotSig)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/peersync/ -run TestResolveAuthor -v`
Expected: FAIL —— `undefined: resolveAuthor`

- [ ] **Step 3: 写实现**

`internal/peersync/packimport.go`：import 块加 `"log"`，文件末尾加：

```go
// resolveAuthor 用该包内嵌的 contributors 公钥验证条目归属（治理册 §2.1、§6）。
// 任一步不成立即**降级为无归属**，绝不影响该包的其余条目、也不拒绝整包。
// 归属只在入库前验这一次；运行期名册计算只读缓存列，不重验（册子 §3.1）。
func resolveAuthor(man protocol.Manifest, e protocol.Entry) (string, string) {
	if e.AuthorID == "" || e.AuthorSig == "" {
		return "", ""
	}
	pub := man.Contributors[e.AuthorID]
	if pub == "" {
		log.Printf("peersync: 条目 %s 的归属公钥未随包提供（author_id=%s），降级为无归属", e.ItemID, e.AuthorID)
		return "", ""
	}
	derived, err := protocol.IdentityID(pub)
	if err != nil || derived != e.AuthorID {
		log.Printf("peersync: 条目 %s 的归属公钥与 author_id 失配，降级为无归属", e.ItemID)
		return "", ""
	}
	ok, err := protocol.VerifyAuthorSig(pub, e.ItemID, e.ContentHash, e.AuthorID, e.AuthorSig)
	if err != nil || !ok {
		log.Printf("peersync: 条目 %s 的归属验签失败，降级为无归属", e.ItemID)
		return "", ""
	}
	return e.AuthorID, e.AuthorSig
}
```

并在 `readAndVerifyPack` 里，`for _, e := range man.Entries` 构造 `base` 之后、`out = append(out, base)` 之前插入：

```go
		base.AuthorID, base.AuthorSig = resolveAuthor(man, e)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/peersync/ ./internal/store/ -v`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add internal/peersync/packimport.go internal/peersync/author_test.go
git commit -m "feat(peersync): 入库时按包内公钥验归属，失败仅降级该条"
```

---

## Task 8: 导出侧回填归属与 contributors

**Files:**
- Modify: `internal/store/identity.go`（加 `LookupIdentities`）, `internal/packexport/export.go`
- Test: `internal/store/identity_test.go`（追加）, `internal/packexport/export_test.go`（追加）

- [ ] **Step 1: 写失败测试**

在 `internal/store/identity_test.go` 末尾追加：

```go
func TestLookupIdentities(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	kp, err := protocol.KeyPairFromSeed("6f1e0d9c8b7a6958473625142332415061728394a5b6c7d8e9f0a1b2c3d4e5f6")
	if err != nil {
		t.Fatal(err)
	}
	id, err := protocol.IdentityID(kp.PubHex)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.RegisterIdentity(id, protocol.AlgEd25519, kp.PubHex, 1); err != nil {
		t.Fatal(err)
	}
	got, err := st.LookupIdentities([]string{id, "00000000000000000000000000000000"})
	if err != nil {
		t.Fatal(err)
	}
	if got[id] != kp.PubHex {
		t.Fatalf("公钥反查失败: %v", got)
	}
	if _, ok := got["00000000000000000000000000000000"]; ok {
		t.Fatal("未登记的身份不应出现在结果里")
	}
	// ids 为空 = 全部
	all, err := st.LookupIdentities(nil)
	if err != nil {
		t.Fatal(err)
	}
	if all[id] != kp.PubHex {
		t.Fatalf("空 ids 应返回全部: %v", all)
	}
}
```

在 `internal/packexport/export_test.go` 末尾追加（沿用该文件既有的临时目录 + 直写 SQL 手法）：

```go
// 归属字段与 contributors 必须同口径出现在 manifest 里；本地 identities 查不到公钥的条目降级为无归属。
func TestExportCarriesAuthorAndContributors(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	const body = "正文"
	add := func(itemID string) {
		if err := st.UpsertArticle(store.Article{
			ItemID: itemID, Title: itemID, BodyMD: body,
			ContentHash: protocol.SHA256Hex([]byte(body)), SourceRev: "rev-1", UpdatedAt: "2026-01-02T00:00:00Z",
		}); err != nil {
			t.Fatal(err)
		}
	}
	add("article/with-author")
	add("article/unknown-author")

	kp, err := protocol.KeyPairFromSeed("6f1e0d9c8b7a6958473625142332415061728394a5b6c7d8e9f0a1b2c3d4e5f6")
	if err != nil {
		t.Fatal(err)
	}
	authorID, err := protocol.IdentityID(kp.PubHex)
	if err != nil {
		t.Fatal(err)
	}
	// 投稿必然先登记身份（册子 §2.1「零新表」的依据）
	if _, err := st.RegisterIdentity(authorID, protocol.AlgEd25519, kp.PubHex, 1); err != nil {
		t.Fatal(err)
	}

	sb, err := protocol.AuthorSignBytes("article/with-author", protocol.SHA256Hex([]byte(body)), authorID)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := protocol.Sign("6f1e0d9c8b7a6958473625142332415061728394a5b6c7d8e9f0a1b2c3d4e5f6", sb)
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(st.DataDir(), "base.db"))+"?mode=rw")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(`UPDATE items SET author_id=?, author_sig=? WHERE item_id=?`, authorID, sig, "article/with-author"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE items SET author_id=? WHERE item_id=?`, "00000000000000000000000000000000", "article/unknown-author"); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	res, err := Export(st, Options{Issuer: "base-node-1", SignKeyHex: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"})
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]protocol.Entry{}
	for _, e := range res.Manifest.Entries {
		byID[e.ItemID] = e
	}
	if got := byID["article/with-author"]; got.AuthorID != authorID || got.AuthorSig != sig {
		t.Fatalf("归属未随包导出: %+v", got)
	}
	if got := byID["article/unknown-author"]; got.AuthorID != "" || got.AuthorSig != "" {
		t.Fatalf("查不到公钥的条目应降级为无归属: %+v", got)
	}
	if res.Manifest.Contributors[authorID] != kp.PubHex {
		t.Fatalf("contributors 未内嵌公钥: %v", res.Manifest.Contributors)
	}
	if len(res.Manifest.Contributors) != 1 {
		t.Fatalf("contributors 只应含已解析出的作者: %v", res.Manifest.Contributors)
	}
	// 导出结果仍必须通过既有验签（含新增字段）
	ok, err := res.Manifest.Verify("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
	if err != nil || !ok {
		t.Fatalf("含归属字段的 manifest 验签失败: ok=%v err=%v", ok, err)
	}
}
```

（若 `export_test.go` 缺 `database/sql` / `modernc.org/sqlite` / `filepath` / `store` / `protocol` 的 import，按需补齐。）

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/store/ -run TestLookupIdentities -v`；`go test ./internal/packexport/ -run TestExportCarriesAuthorAndContributors -v`
Expected: 前者 FAIL `undefined: LookupIdentities`；后者 FAIL（归属未导出）

- [ ] **Step 3: 写实现**

`internal/store/identity.go` 末尾加（沿用该文件既有的 `placeholders` 用法与 `LookupIdentity` 口径）：

```go
// LookupIdentities 批量反查公钥（治理册 §2.1「再导出时按本地 identities 重建 contributors」）。
// ids 为空表示全部；未登记的身份不出现在结果里。
func (s *Store) LookupIdentities(ids []string) (map[string]string, error) {
	q := `SELECT id,pubkey FROM identities`
	args := []any{}
	if len(ids) > 0 {
		q += ` WHERE id IN (` + placeholders(len(ids)) + `)`
		for _, id := range ids {
			args = append(args, id)
		}
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, pub string
		if err := rows.Scan(&id, &pub); err != nil {
			return nil, err
		}
		out[id] = pub
	}
	return out, rows.Err()
}
```

`internal/packexport/export.go`：把 `entries` 的构造循环拆成「先查公钥、再建条目」两步——

在 `sort.Slice(items, ...)` 之后插入：

```go
	// 归属公钥按本地 identities 反查（册子 §2.1）：查不到即该条降级为无归属，不影响其余条目。
	needed := []string{}
	seen := map[string]bool{}
	for _, it := range items {
		if it.AuthorID != "" && it.AuthorSig != "" && !seen[it.AuthorID] {
			seen[it.AuthorID] = true
			needed = append(needed, it.AuthorID)
		}
	}
	pubs, err := st.LookupIdentities(needed)
	if err != nil {
		return Result{}, err
	}
```

把原循环改成：

```go
	entries := make([]protocol.Entry, 0, len(items))
	contributors := map[string]string{}
	blobIDs := []string{}
	for _, it := range items {
		e := protocol.Entry{
			ItemID: it.ItemID, Source: it.Source, Type: it.Type, Title: it.Title,
			SourceRev: it.SourceRev, ContentHash: it.ContentHash, SQLiteTable: it.SQLiteTable, DistClass: it.DistClass,
		}
		if pub, ok := pubs[it.AuthorID]; it.AuthorID != "" && it.AuthorSig != "" && ok {
			e.AuthorID, e.AuthorSig = it.AuthorID, it.AuthorSig
			contributors[it.AuthorID] = pub
		}
		if it.SQLiteTable == "media_meta" {
			// 块序列以 media_meta 的声明为准（下标即 seq）：块级去重后 blobs 行会变少，
			// 用它填 chunks 会与 chunk_hashes_json 长度不一致（契约 §4.1、验收 3）。
			refs, err := st.DeclaredChunks(it.ItemID)
			if err != nil {
				return Result{}, err
			}
			if len(refs) == 0 {
				return Result{}, fmt.Errorf("packexport: 条目 %s 没有任何块文件", it.ItemID)
			}
			for _, r := range refs {
				e.Chunks = append(e.Chunks, protocol.Chunk{BlobID: r.BlobID, Size: r.Size, Seq: r.Seq})
				blobIDs = append(blobIDs, r.BlobID)
			}
		}
		entries = append(entries, e)
	}
```

`m := protocol.Manifest{...}` 造 manifest 时加一项：

```go
		ContentVersion: version, Entries: entries, Tombstone: tombstones, MerkleRoot: merkle,
		Contributors: contributors,
```

（`contributors` 为空 map 时，`omitempty` 会把它整个省掉——保证无作者的节点导出的 manifest 字节与改造前完全一致。）

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/packexport/ ./internal/store/ ./internal/peersync/ ./internal/httpapi/ -v`
Expected: 全部 PASS（`httpapi` 的包级 e2e 会连带覆盖「导出→manifest 字节」的回归）

- [ ] **Step 5: 提交**

```bash
git add internal/store/identity.go internal/store/identity_test.go internal/packexport/export.go internal/packexport/export_test.go
git commit -m "feat(packexport): 导出回填归属并重建 contributors"
```

---

## Task 9: 名册派生（纯逻辑 + 数据装配）

**Files:**
- Create: `internal/store/contributor.go`
- Test: `internal/store/contributor_test.go`（追加）

- [ ] **Step 1: 写失败测试**

在 `internal/store/contributor_test.go` 末尾追加：

```go
const (
	authorA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	authorB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	authorC = "cccccccccccccccccccccccccccccccc"
)

func longBody() string { return strings.Repeat("字", 200) }

func TestDeriveRosterQualityGates(t *testing.T) {
	cands := []Candidate{
		{ItemID: "article:a", AuthorID: authorA, Type: "article", BodyMD: longBody()},
		{ItemID: "article:b", AuthorID: authorB, Type: "article", BodyMD: strings.Repeat("字", 199)},
		{ItemID: "article:c", AuthorID: authorC, Type: "article", BodyMD: " \n" + longBody() + "\t"},
		{ItemID: "video:a", AuthorID: authorA, Type: "video", DurationSeconds: 60},
		{ItemID: "video:b", AuthorID: authorB, Type: "video", DurationSeconds: 59},
		{ItemID: "video:z", AuthorID: authorC, Type: "video", DurationSeconds: 0},
		{ItemID: "quiz:a", AuthorID: authorA, Type: "quiz", QuestionCount: 3},
		{ItemID: "quiz:b", AuthorID: authorB, Type: "quiz", QuestionCount: 2},
		{ItemID: "cover:a", AuthorID: authorC, Type: "cover"},
		{ItemID: "article:d", AuthorID: "", Type: "article", BodyMD: longBody()},
	}
	got := deriveRoster(cands)
	want := []Contributor{{ID: authorA, Count: 3}, {ID: authorC, Count: 1}}
	if len(got) != len(want) {
		t.Fatalf("名册 = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("名册第 %d 名 = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestDeriveRosterTieBreakAndTruncation(t *testing.T) {
	cands := []Candidate{}
	// 12 个身份，条数依次 12,11,...,1（无并列）
	for i := 0; i < 12; i++ {
		id := fmt.Sprintf("%032x", i+1)
		for n := 0; n <= 11-i; n++ {
			cands = append(cands, Candidate{
				ItemID: fmt.Sprintf("article:%02d-%02d", i, n), AuthorID: id, Type: "article", BodyMD: longBody(),
			})
		}
	}
	got := deriveRoster(cands)
	if len(got) != RosterTopN {
		t.Fatalf("截断后应 10 条，实得 %d", len(got))
	}
	if got[0].Count != 12 || got[len(got)-1].Count != 3 {
		t.Fatalf("名次边界错误: %+v", got)
	}
	for i := 1; i < len(got); i++ {
		if got[i-1].Count < got[i].Count {
			t.Fatalf("不是条数降序: %+v", got)
		}
	}

	// 同条数按 author_id 字典序升序
	tie := deriveRoster([]Candidate{
		{ItemID: "article:1", AuthorID: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Type: "article", BodyMD: longBody()},
		{ItemID: "article:2", AuthorID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Type: "article", BodyMD: longBody()},
	})
	if len(tie) != 2 || tie[0].ID != authorA || tie[1].ID != authorB {
		t.Fatalf("并列 tiebreak 错误: %+v", tie)
	}

	// 空输入 → 空名册（不足 10 人就有几名，0 人返回空数组）
	if n := len(deriveRoster(nil)); n != 0 {
		t.Fatalf("空输入应返回空名册，实得 %d", n)
	}

	// 柔性名额：只有 3 人时返回 3 条（≥1 条即入选）
	few := deriveRoster([]Candidate{
		{ItemID: "article:1", AuthorID: authorA, Type: "article", BodyMD: longBody()},
		{ItemID: "article:2", AuthorID: authorB, Type: "article", BodyMD: longBody()},
		{ItemID: "article:3", AuthorID: authorC, Type: "article", BodyMD: longBody()},
	})
	if len(few) != 3 {
		t.Fatalf("不足 10 人应返回实际人数: %+v", few)
	}
}

// 名册只吃本节点可独立验证的数据：state != active、空归属、未达门槛一律跳过；同一 item 重写多次只计 1 条。
func TestContributorRosterFromStore(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	put := func(itemID, body string) {
		if err := st.UpsertArticle(Article{
			ItemID: itemID, Title: itemID, BodyMD: body,
			ContentHash: protocol.SHA256Hex([]byte(body)), UpdatedAt: "2026-01-02T00:00:00Z",
		}); err != nil {
			t.Fatal(err)
		}
	}
	setAuthor := func(itemID, authorID string) {
		if _, err := st.db.Exec(`UPDATE items SET author_id=?, author_sig='00' WHERE item_id=?`, authorID, itemID); err != nil {
			t.Fatal(err)
		}
	}
	put("article/long", longBody())
	setAuthor("article/long", authorA)
	put("article/short", "短")
	setAuthor("article/short", authorB)
	put("article/removed", longBody())
	setAuthor("article/removed", authorB)
	if err := st.RetireItem("article/removed", 9); err != nil {
		t.Fatal(err)
	}
	put("article/no-author", longBody())

	got, err := st.ContributorRoster()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != authorA || got[0].Count != 1 {
		t.Fatalf("名册 = %+v, want 仅 %s 一条", got, authorA)
	}

	// 同一 item 连续重写 5 次 → 仍只计 1 条
	for i := 0; i < 5; i++ {
		put("article/long", longBody()+fmt.Sprintf("%d", i))
		setAuthor("article/long", authorA)
	}
	got, err = st.ContributorRoster()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Count != 1 {
		t.Fatalf("重写后计数应仍为 1: %+v", got)
	}
}

func TestPutProfileAndNames(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if err := st.PutProfile(authorA, "阿茶", 1); err != nil {
		t.Fatal(err)
	}
	if err := st.PutProfile(authorA, "阿茶二", 2); err != nil {
		t.Fatal(err)
	}
	if err := st.PutProfile(authorB, "无属性", 3); err != nil {
		t.Fatal(err)
	}
	names, err := st.ProfileNames([]string{authorA, authorC})
	if err != nil {
		t.Fatal(err)
	}
	if names[authorA] != "阿茶二" {
		t.Fatalf("昵称覆盖失败: %v", names)
	}
	if _, ok := names[authorC]; ok {
		t.Fatalf("未设置的 id 不应出现: %v", names)
	}
}
```

（该文件 import 块需要 `fmt`、`strings`、`github.com/johocn/base/internal/protocol`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/store/ -run 'TestDeriveRoster|TestContributorRoster|TestPutProfile' -v`
Expected: FAIL —— `undefined: Candidate` / `undefined: deriveRoster`

- [ ] **Step 3: 写实现**

创建 `internal/store/contributor.go`：

```go
package store

import (
	"encoding/json"
	"sort"
	"unicode"

	"github.com/johocn/base/internal/protocol"
)

// 质量门槛是**文档级常量**（治理册 §4.3）：不做配置项，校准走「改册子 + 改常量」。
const (
	ArticleMinRunes  = 200
	VideoMinSeconds  = 60
	QuizMinQuestions = 3
	// RosterTopN 是名册截断长度（治理册 §4.4）。
	RosterTopN = 10
)

// Contributor 是名册里的一行。名册是派生值，不落表、无任期、不跨节点同步（治理册 §3.3）。
type Contributor struct {
	ID    string
	Count int
}

// Candidate 是一条已带归属缓存的候选条目，以及它在所属载体上的度量输入。
type Candidate struct {
	ItemID          string
	AuthorID        string
	Type            string // article | video | quiz（其余载体不计贡献）
	BodyMD          string // Type == "article"
	DurationSeconds int64  // Type == "video"
	QuestionCount   int    // Type == "quiz"
}

// meetsQualityGate 判定一条候选是否达到其载体的质量门槛（治理册 §4.3）。
func meetsQualityGate(c Candidate) bool {
	switch c.Type {
	case "article":
		return countNonSpaceRunes(c.BodyMD) >= ArticleMinRunes
	case "video":
		// duration = 0 表示未知（导入器 -duration 默认 0），不计贡献。
		return c.DurationSeconds >= VideoMinSeconds
	case "quiz":
		return c.QuestionCount >= QuizMinQuestions
	default:
		// cover / course / lesson 等不是贡献载体。
		return false
	}
}

// countNonSpaceRunes 统计去除全部空白后的字符数（rune 计）。
func countNonSpaceRunes(s string) int {
	n := 0
	for _, r := range s {
		if unicode.IsSpace(r) {
			continue
		}
		n++
	}
	return n
}

// deriveRoster 把候选条目折算成名册（治理册 §4.3、§4.4）：
// 空归属与未达门槛者跳过；条数降序 + author_id 升序 tiebreak；取前 RosterTopN。
func deriveRoster(cands []Candidate) []Contributor {
	counts := map[string]int{}
	for _, c := range cands {
		if c.AuthorID == "" || !meetsQualityGate(c) {
			continue
		}
		counts[c.AuthorID]++
	}
	out := make([]Contributor, 0, len(counts))
	for id, n := range counts {
		out = append(out, Contributor{ID: id, Count: n})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].ID < out[j].ID
	})
	if len(out) > RosterTopN {
		out = out[:RosterTopN]
	}
	return out
}

// ContributorRoster 实时派生本节点贡献前 10 名名册（治理册 §4）。
// 只读 items 的归属缓存列，不重验签名；只看 state='active' 的条目。
func (s *Store) ContributorRoster() ([]Contributor, error) {
	rows, err := s.db.Query(`SELECT item_id,author_id,type FROM items
		WHERE state='active' AND author_id<>'' ORDER BY item_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cands []Candidate
	articleIDs, videoIDs, quizIDs := []string{}, []string{}, []string{}
	index := map[string]int{}
	for rows.Next() {
		var c Candidate
		if err := rows.Scan(&c.ItemID, &c.AuthorID, &c.Type); err != nil {
			return nil, err
		}
		index[c.ItemID] = len(cands)
		cands = append(cands, c)
		switch c.Type {
		case "article":
			articleIDs = append(articleIDs, c.ItemID)
		case "video":
			videoIDs = append(videoIDs, c.ItemID)
		case "quiz":
			quizIDs = append(quizIDs, c.ItemID)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// 注意：ListArticles / ListQuizzes / ListMediaDurations 的「ids 为空 = 全部」语义，
	// 在无该类载体时必须整个跳过，否则会把全部行卷进来覆盖错位。
	if len(articleIDs) > 0 {
		articles, err := s.ListArticles(articleIDs)
		if err != nil {
			return nil, err
		}
		for id, a := range articles {
			if i, ok := index[id]; ok {
				cands[i].BodyMD = a.BodyMD
			}
		}
	}
	if len(quizIDs) > 0 {
		quizzes, err := s.ListQuizzes(quizIDs)
		if err != nil {
			return nil, err
		}
		for id, q := range quizzes {
			i, ok := index[id]
			if !ok {
				continue
			}
			var doc struct {
				Questions []json.RawMessage `json:"questions"`
			}
			// 题组 JSON 不可解析即计 0 题 → 未达门槛 → 跳过，不中断整张名册（治理册 §6）。
			if err := json.Unmarshal([]byte(q.QuestionJSON), &doc); err == nil {
				cands[i].QuestionCount = len(doc.Questions)
			}
		}
	}
	if len(videoIDs) > 0 {
		durations, err := s.ListMediaDurations(videoIDs)
		if err != nil {
			return nil, err
		}
		for id, d := range durations {
			if i, ok := index[id]; ok {
				cands[i].DurationSeconds = d
			}
		}
	}
	return deriveRoster(cands), nil
}

// ListMediaDurations 批量读取媒体条目时长（秒）；ids 为空表示全部。
func (s *Store) ListMediaDurations(ids []string) (map[string]int64, error) {
	q := `SELECT item_id,duration FROM media_meta`
	args := []any{}
	if len(ids) > 0 {
		q += ` WHERE item_id IN (` + placeholders(len(ids)) + `)`
		for _, id := range ids {
			args = append(args, id)
		}
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var id string
		var d int64
		if err := rows.Scan(&id, &d); err != nil {
			return nil, err
		}
		out[id] = d
	}
	return out, rows.Err()
}

// PutProfile 覆盖写一个身份的公开昵称（幂等；治理册 §3.2）。
func (s *Store) PutProfile(id, name string, updatedAt int64) error {
	_, err := s.db.Exec(`INSERT INTO profiles(id,name,updated_at) VALUES(?,?,?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`, id, name, updatedAt)
	return err
}

// ProfileNames 返回指定 id 的昵称；ids 为空表示全部。缺该身份即不在结果里（调用方回退展示）。
func (s *Store) ProfileNames(ids []string) (map[string]string, error) {
	q := `SELECT id,name FROM profiles`
	args := []any{}
	if len(ids) > 0 {
		q += ` WHERE id IN (` + placeholders(len(ids)) + `)`
		for _, id := range ids {
			args = append(args, id)
		}
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}
```

（`contributor.go` 里未用到 `protocol` 时，如实删掉该 import——不要留无用 import。）

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/store/ -v`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add internal/store/contributor.go internal/store/contributor_test.go
git commit -m "feat(store): 名册实时派生与 profiles 读写"
```

---

## Task 10: `GET /v1/contributors`（匿名开放）

**Files:**
- Create: `internal/httpapi/contributor.go`
- Modify: `internal/httpapi/server.go`
- Test: `internal/httpapi/contributor_test.go`

- [ ] **Step 1: 写失败测试**

创建 `internal/httpapi/contributor_test.go`：

```go
package httpapi

import (
	"database/sql"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// 归属缓存列只由导入/投稿产生，httpapi 侧没有公开写路径，故测试直写库。
func setCachedAuthor(t *testing.T, st *store.Store, itemID, authorID, sig string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(st.DataDir(), "base.db"))+"?mode=rw")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(`UPDATE items SET author_id=?, author_sig=? WHERE item_id=?`, authorID, sig, itemID); err != nil {
		t.Fatalf("set author: %v", err)
	}
}

func TestContributorsEndpointAnonymous(t *testing.T) {
	st, _, ts := newTestServer(t)
	const authorID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	long := strings.Repeat("字", 200)
	if err := st.UpsertArticle(store.Article{
		ItemID: "article/long", Title: "长文", BodyMD: long,
		ContentHash: protocol.SHA256Hex([]byte(long)), UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}
	setCachedAuthor(t, st, "article/long", authorID, "00")

	// 无签名头亦 200（治理册 §5.1）
	code, body := getJSON(t, ts.URL+"/v1/contributors")
	if code != http.StatusOK {
		t.Fatalf("status=%d body=%v", code, body)
	}
	list, ok := body["contributors"].([]any)
	if !ok || len(list) != 1 {
		t.Fatalf("名册结构错误: %v", body)
	}
	row := list[0].(map[string]any)
	if row["id"] != authorID || row["count"].(float64) != 1 {
		t.Fatalf("名册行错误: %v", row)
	}
	// 未设置昵称 → 回退 id 前 8 位
	if row["name"] != authorID[:8] {
		t.Fatalf("昵称回退错误: %v", row["name"])
	}
}

func TestContributorsEndpointEmptyRoster(t *testing.T) {
	_, _, ts := newTestServer(t)
	// 种子内容都无归属 → 空名册 + 200，不报错（治理册 §6）
	code, body := getJSON(t, ts.URL+"/v1/contributors")
	if code != http.StatusOK {
		t.Fatalf("status=%d body=%v", code, body)
	}
	list, ok := body["contributors"].([]any)
	if !ok || len(list) != 0 {
		t.Fatalf("应为空数组而非 null: %v", body)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/httpapi/ -run TestContributorsEndpoint -v`
Expected: FAIL —— 404（路由未注册）

- [ ] **Step 3: 写实现**

创建 `internal/httpapi/contributor.go`：

```go
package httpapi

import (
	"net/http"
)

type contributorDTO struct {
	ID    string `json:"id"`
	Count int    `json:"count"`
	Name  string `json:"name"`
}

type contributorsResponse struct {
	Contributors []contributorDTO `json:"contributors"`
}

// handleContributors 匿名返回本节点实时派生的贡献前 10 名名册（治理册 §5.1）。
// 不返回条目清单、不返回投稿时间、不返回任何内容 id；空名册返回 []（不是 null）。
func (s *Server) handleContributors(w http.ResponseWriter, r *http.Request) {
	rows, err := s.st.ContributorRoster()
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	ids := make([]string, 0, len(rows))
	for _, c := range rows {
		ids = append(ids, c.ID)
	}
	names, err := s.st.ProfileNames(ids)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := contributorsResponse{Contributors: []contributorDTO{}}
	for _, c := range rows {
		name := names[c.ID]
		if name == "" {
			name = c.ID[:8] // 展示层回退，不影响任何判定（治理册 §5.1）
		}
		resp.Contributors = append(resp.Contributors, contributorDTO{ID: c.ID, Count: c.Count, Name: name})
	}
	s.writeJSON(w, http.StatusOK, resp)
}
```

`internal/httpapi/server.go` 的 `publicMux` 里，评论公开读那一行之后加：

```go
	// 名册公开读（匿名，治理册 §5.1）：与 catalog / manifest / pack 同级。
	mux.HandleFunc("GET /v1/contributors", s.handleContributors)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/httpapi/ -run TestContributorsEndpoint -v`
Expected: PASS（两个用例）

- [ ] **Step 5: 提交**

```bash
git add internal/httpapi/contributor.go internal/httpapi/contributor_test.go internal/httpapi/server.go
git commit -m "feat(httpapi): 新增匿名名册读接口 GET /v1/contributors"
```

---

## Task 11: `POST /v1/profile`（签名写路径）

**Files:**
- Modify: `internal/httpapi/contributor.go`, `internal/httpapi/authmw.go`, `internal/httpapi/server.go`
- Test: `internal/httpapi/contributor_test.go`（追加）

- [ ] **Step 1: 写失败测试**

在 `internal/httpapi/contributor_test.go` 末尾追加：

```go
func TestProfilePut(t *testing.T) {
	st, _, ts := newTestServer(t)
	id, pub := identityFromSeed(t, testSeed)
	if status, body := doIdentityJSON(t, http.MethodPost, ts.URL+"/v1/identity/register", "", registerBody(id, pub)); status != http.StatusOK {
		t.Fatalf("预登记 status=%d body=%v", status, body)
	}

	// 合法昵称
	code, body := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/profile", `{"name":"  阿茶  "}`))
	if code != http.StatusOK {
		t.Fatalf("status=%d body=%v", code, body)
	}
	if body["id"] != id || body["name"] != "阿茶" {
		t.Fatalf("入库值应为去空白后的昵称: %v", body)
	}
	names, err := st.ProfileNames([]string{id})
	if err != nil {
		t.Fatal(err)
	}
	if names[id] != "阿茶" {
		t.Fatalf("昵称未落库: %v", names)
	}

	// 幂等覆盖
	if code, _ := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/profile", `{"name":"阿茶二"}`)); code != http.StatusOK {
		t.Fatalf("覆盖写入失败: %d", code)
	}
	names, _ = st.ProfileNames([]string{id})
	if names[id] != "阿茶二" {
		t.Fatalf("覆盖失败: %v", names)
	}

	// 请求体携带 id → 400，且不写入他人昵称（治理册 §5.2 硬约束）
	other := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	code, body = sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/profile",
		`{"name":"冒名","id":"`+other+`"}`))
	if code != http.StatusBadRequest {
		t.Fatalf("带 id 应 400: %d %v", code, body)
	}
	names, _ = st.ProfileNames([]string{other})
	if len(names) != 0 {
		t.Fatalf("不得写入他人昵称: %v", names)
	}

	// 超长 / 空 / 控制字符 → 400
	for _, bad := range []string{
		`{"name":"` + strings.Repeat("字", 33) + `"}`,
		`{"name":"   "}`,
		`{"name":"阿\u0000茶"}`,
	} {
		if code, _ := sendAuth(t, signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/profile", bad)); code != http.StatusBadRequest {
			t.Fatalf("非法昵称应 400: %s", bad)
		}
	}

	// 缺签名头 → 400 auth_missing_header（契约 §3.2 第 1 步）
	if code, body := doJSONMap(t, http.MethodPost, ts.URL+"/v1/profile", `{"name":"无签名"}`, nil); code != http.StatusBadRequest || body["code"] != "auth_missing_header" {
		t.Fatalf("缺签名头应 400 auth_missing_header: %d %v", code, body)
	}

	// 重放（同 nonce 同 ts）→ 401
	replay := signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/profile", `{"name":"重放"}`)
	if code, _ := sendAuth(t, replay); code != http.StatusOK {
		t.Fatalf("首次应成功: %d", code)
	}
	dup := signedRequest(t, testSeed, http.MethodPost, ts.URL+"/v1/profile", `{"name":"重放"}`)
	copyAuthHeaders(replay, dup)
	if code, body := sendAuth(t, dup); code != http.StatusUnauthorized || body["code"] != "auth_nonce_replay" {
		t.Fatalf("重放应 401 auth_nonce_replay: %d %v", code, body)
	}
}

func TestContributorNameFollowsProfile(t *testing.T) {
	st, _, ts := newTestServer(t)
	const authorID = "cccccccccccccccccccccccccccccccc"
	long := strings.Repeat("字", 200)
	if err := st.UpsertArticle(store.Article{
		ItemID: "article/long2", Title: "长文", BodyMD: long,
		ContentHash: protocol.SHA256Hex([]byte(long)), UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}
	setCachedAuthor(t, st, "article/long2", authorID, "00")
	if err := st.PutProfile(authorID, "阿茶", 1); err != nil {
		t.Fatal(err)
	}
	code, body := getJSON(t, ts.URL+"/v1/contributors")
	if code != http.StatusOK {
		t.Fatalf("status=%d", code)
	}
	list := body["contributors"].([]any)
	if list[0].(map[string]any)["name"] != "阿茶" {
		t.Fatalf("名册未取到昵称: %v", list[0])
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/httpapi/ -run 'TestProfilePut|TestContributorNameFollowsProfile' -v`
Expected: FAIL —— 404（路由未注册）

- [ ] **Step 3: 写实现**

`internal/httpapi/contributor.go` 追加：

```go
type profilePutReq struct {
	Name string          `json:"name"`
	ID   json.RawMessage `json:"id"`
}

// validProfileName 按治理册 §5.2：去首尾空白后 rune 长度 1..32，且不含控制字符。
func validProfileName(s string) bool {
	n := utf8.RuneCountInString(s)
	if n < 1 || n > 32 {
		return false
	}
	for _, r := range s {
		if r <= 0x1F || r == 0x7F {
			return false
		}
	}
	return true
}

// handleProfilePut 写入调用者自己的公开昵称（治理册 §5.2），与评论写路径同一条鉴权路。
// 硬约束：id 只能取自鉴权中间件解析出的身份，请求体不得携带 id——否则等于伪造他人昵称。
func (s *Server) handleProfilePut(w http.ResponseWriter, r *http.Request) {
	var req profilePutReq
	if !s.decodeJSON(w, r, &req) {
		return
	}
	if len(req.ID) > 0 {
		s.writeAuthErr(w, http.StatusBadRequest, "profile_id_forbidden")
		return
	}
	name := strings.TrimSpace(req.Name)
	if !validProfileName(name) {
		s.writeAuthErr(w, http.StatusBadRequest, "profile_name_invalid")
		return
	}
	id := identityFrom(r)
	if err := s.st.PutProfile(id, name, time.Now().UnixMilli()); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"id": id, "name": name})
}
```

该文件 import 块改为：

```go
import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)
```

`internal/httpapi/authmw.go` 的 `authErrText` 加两条：

```go
	"profile_name_invalid":     "昵称必须是去首尾空白后 1..32 个字符，且不含控制字符",
	"profile_id_forbidden":     "请求体不得携带 id",
```

`internal/httpapi/server.go` 的 `publicMux` 里，`POST /v1/event` 那一行之后加：

```go
	mux.Handle("POST /v1/profile", s.requireAuth(s.handleProfilePut))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/httpapi/ -v`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add internal/httpapi/contributor.go internal/httpapi/contributor_test.go internal/httpapi/authmw.go internal/httpapi/server.go
git commit -m "feat(httpapi): 新增签名写路径 POST /v1/profile"
```

---

## Task 12: 门禁、验收与文档回填

**Files:**
- Modify: `docs/README.md`, `docs/superpowers/specs/2026-09-28-base-contribution-roles-design.md`（§0 改版说明）
- Modify: 本计划文件（追加「执行实况」）

- [ ] **Step 1: 全量门禁**

Run: `go build ./... && go vet ./... && go test ./...`
Expected: 全包 PASS，无 vet 报错

Run: `cd packages/protocol-ts && npx tsc --noEmit && npx vitest run`
Expected: tsc 无输出；vitest 全绿（含新增 authorsig 用例）

- [ ] **Step 2: 逐条核对册子 §7.4 验收条件**

| AC | 落点 | 判定方式 |
|---|---|---|
| 1 12 身份 → 严格前 10 | Task 9 `TestDeriveRosterTieBreakAndTruncation` | 自动 |
| 2 置 `state='removed'` → 名册实时 -1 | Task 9 `TestContributorRosterFromStore` | 自动 |
| 3 篡改 `author_sig` 后入库 → 该条留空、其余不受影响 | Task 7 `TestResolveAuthorDegradesWithoutRejecting`（第 3 例）+ Task 6 独立条目用例 | 自动 |
| 4 篡改 `contributors` 公钥 → 该 id 名下全不计入 | Task 7（第 2 例：公钥失配） | 自动 |
| 5 存量 `import-md` 内容不产生名册条目 | Task 10 `TestContributorsEndpointEmptyRoster` | 自动 |
| 6 同一 `item_id` 重写 5 次计数仍 1 | Task 9 `TestContributorRosterFromStore` | 自动 |
| 7 无签名头访问 `GET /v1/contributors` → 200 | Task 10 `TestContributorsEndpointAnonymous` | 自动 |
| 8 `POST /v1/profile` 带 `id` → 400 且未写入他人昵称 | Task 11 `TestProfilePut` | 自动 |
| 9 两节点同内容 → `id`/`count`/顺序完全一致，`name` 允许不同 | **需人工**：两台节点导入同一包后 `curl /v1/contributors` 比对（`name` 可不同） | 人工 |
| 10 `authorsig` 向量 Go 与 TS 双侧同过 | Task 2 + Task 3 | 自动 |

- [ ] **Step 3: 回写册子 §0 改版说明（执行期更正）**

在册子 `## 0. 改版说明` 下追加一节：

```markdown
### 0.2 2026-09-28 执行期更正（计划 #24 落实施时）

1. §5.2 只写了「请求体携带 `id` → 400」，未定错误码。实施定为 `profile_id_forbidden`
   （`profile_name_invalid` 仍只用于 `name` 校验失败），两者都按契约 §3.3 的 `{error, code}` 形状返回。
2. §4.3 的「去除全部空白」明确为：按 `unicode.IsSpace` 判定空白（含全角空格 U+3000），再按 rune 计数。
3. §4.3 的三种载体按 `items.type` 分流（`article` / `video` / `quiz`）；`cover` / `course` / `lesson` 不计贡献。
4. §7.3 写的「缺签名头 → 401」与既有鉴权契约（总纲 / 契约 §3.2 第 1 步：缺任一头 → `400 auth_missing_header`）冲突。
   本册遵守「写路径一律走既有 `authmw.go`、不新增鉴权形态」，故实施按 **400 `auth_missing_header`**，§7.3 该处数字作废。
```

- [ ] **Step 4: 更新 `docs/README.md`**

- §3 文档清单追加一行（#24 = 本计划），格式与既有行一致：职责、明确不做什么、依赖（册子 #23）、状态。
- §4 依赖图「治理主线」分支下补 `贡献度量与动态角色 (#23 → #24)`。
- §5「当前阶段」：新增一行「已完成：治理主线首册（#23 册子 + #24 计划）已落地」并写清门禁结果；把「`#23` 待出实施计划」从「下一步」移除；把 AC 9 的两节点比对列入「待人工」。

- [ ] **Step 5: 在本计划文件末尾追加「执行实况」**

```markdown
## 执行实况

- 2026-09-28 计划落定（#24），由册子 #23 派生。
```

任务执行过程中，每个 Task 完成后在此追加一行：提交哈希 + 实际改动 + 与计划的偏差。

- [ ] **Step 6: 提交**

```bash
git add docs/README.md docs/superpowers/specs/2026-09-28-base-contribution-roles-design.md docs/superpowers/plans/2026-09-28-base-contribution-roles-plan.md
git commit -m "docs(plans): 治理主线首册实施计划与执行期更正回填"
```

---

## 风险与边界（执行时不得突破）

1. **`entries[].author_id` 与 `authorsig` 的字节定义是契约出口**：签名域串 `base/author-v1`、五个键名与顺序、`canonical_json` 规则一旦落地，下游（第 2/3/4 册）不得改。
2. **不 bump `schema_version`**：三个新字段全部 `omitempty`。Task 4 的回归以「既有 `vectors/v1/manifest.json` 的 `sign_bytes` / `manifest_sha256` 不变」为准绳；一旦有变，说明违反了 §2.2。
3. **归属失败绝不拒整包**：`resolveAuthor` 只降级单条；任何情况下不许把它写进 `readAndVerifyPack` 的 error 分支。
4. **名册是派生值**：不得为它建表、不得把它写进 events、不得加配置项、不得引入任何跨节点互动数据（点赞/浏览/评论热度）。门槛数值只在 `internal/store/contributor.go` 的常量里。
5. **`id` 只能来自鉴权中间件**：`POST /v1/profile` 不得从请求体接受 `id`，也不得接受路径参数。
6. **中继节点再导出的固有缺口**：`contributors` 按**本地** `identities` 重建，而中继节点未登记作者身份 → 该节点再导出时归属会降级为无归属。本册按册子 §2.1 实现，不做补救（真源节点因「投稿必先登记身份」不受影响）。若后续要求跨跳保持归属，需先改册子。
