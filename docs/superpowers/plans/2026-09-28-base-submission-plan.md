# base 投稿写入与条目更新授权实施计划（治理主线 第 2 册 #25）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已登记身份的作者把独立 `article` / `quiz` 直接投进本节点，验签通过即生效；同 `item_id` 被占（含无归属的存量条目）一律拒绝，正文改动必须重签否则拒绝。

**Architecture:** 新增一条签名写路径 `POST /v1/submit`，挂在既有 `requireAuth` 上（与评论写路径、`POST /v1/profile` 同一条鉴权路），按 `type` 判别载荷。`content_hash` 由服务端按与 `internal/importer` 逐字节同构的口径算出（article = `sha256(body_md)`、quiz = `sha256(question_json)`），再用它做 `author_sig` 验签——于是「改写必重签」不需要任何额外状态，验签数学自动成立。落库走 store 层一个新函数 `UpsertSubmission`（`items` + `articles|quizzes` 同事务），占用判定只看 `items.author_id`，与 `state` 无关。

**Tech Stack:** Go（`internal/store`、`internal/httpapi`、`internal/protocol`，SQLite via `modernc.org/sqlite`）。**本册不碰 TypeScript 与手机端**（创作 UI 归第 4 册）。

**上游册子：** [docs/superpowers/specs/2026-09-28-base-submission-design.md](file:///e:/code/base/docs/superpowers/specs/2026-09-28-base-submission-design.md)（本计划的字段名、常量、错误码、语义一律以册子为准；冲突时先改册子）

**已核实的环境事实（勿再验证）：**

- 本机 Go 不能完成同进程回环 TCP，测试基座用 `newInprocServer`（`internal/httpapi/testsupport_test.go`，`init()` 里替换 `http.DefaultTransport`）。
- 既有 `UpsertArticle` / `UpsertQuiz` 的 `ON CONFLICT` **不写** `author_id` / `author_sig` 两列，因此导入器重跑不会清空投稿写下的归属缓存——本册不需要改它们。
- `internal/importer/md.go` 的 `source_rev` 口径是 `content_hash[:16]`（文章见 `md.go` 的 `hash[:16]`，题库同）。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `internal/store/submission.go`（新） | `Submission`、`ErrItemTaken`、`UpsertSubmission`：投稿的落库与占用判定（本册唯一的写入口径） |
| `internal/store/submission_test.go`（新） | 上面三者的单测（新建 / 同作者更新 / 他人拒绝 / 空归属拒绝 / 幂等 / 归属列落库） |
| `internal/httpapi/submit.go`（新） | 常量、校验纯函数（`validSlug` / `splitSubmitItemID` / `validItemTitle` / `validQuestionJSON` / `submissionContentHash`）、`handleSubmitPost` |
| `internal/httpapi/submit_test.go`（新） | 校验纯函数单测、错误码分支单测、AC 1–10 端到端 |
| `internal/httpapi/server.go`（改） | `Server` 加两个限速器字段、`New()` 初始化、`publicMux()` 注册 `POST /v1/submit` |
| `internal/httpapi/authmw.go`（改） | `authErrText` 补本册 10 个错误码人读文案 |
| `docs/README.md`（改） | 登记本计划（#26）、依赖图、§5 当前阶段 |
| `docs/superpowers/plans/2026-09-28-base-submission-plan.md`（改） | Task 5 回填「执行实况」 |

---

## Task 1: store 层投稿写入与占用判定

**Files:**
- Create: `internal/store/submission.go`
- Test: `internal/store/submission_test.go`

- [ ] **Step 1: 写失败测试**

创建 `internal/store/submission_test.go`：

```go
package store

import (
	"errors"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

const (
	// 两个固定的 32 字节种子，仅用于造出两个不同的 author_id。
	subSeedA = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
	subSeedB = "6f1e0d9c8b7a6958473625142332415061728394a5b6c7d8e9f0a1b2c3d4e5f6"
)

// authorOf 由种子推出 author_id 与公钥（与 httpapi 测试同一算法）。
func authorOf(t *testing.T, seed string) (id, pub string) {
	t.Helper()
	kp, err := protocol.KeyPairFromSeed(seed)
	if err != nil {
		t.Fatalf("KeyPairFromSeed: %v", err)
	}
	id, err = protocol.IdentityID(kp.PubHex)
	if err != nil {
		t.Fatalf("IdentityID: %v", err)
	}
	return id, kp.PubHex
}

// signedSubmission 造一条已签名的 article 投稿（签名按治理册 §2.1 的待签字节）。
func signedSubmission(t *testing.T, seed, itemID, title, body string) Submission {
	t.Helper()
	id, _ := authorOf(t, seed)
	hash := protocol.SHA256Hex([]byte(body))
	signBytes, err := protocol.AuthorSignBytes(itemID, hash, id)
	if err != nil {
		t.Fatalf("AuthorSignBytes: %v", err)
	}
	sig, err := protocol.Sign(seed, signBytes)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	return Submission{
		ItemID: itemID, Type: "article", Title: title,
		BodyMD: body, ContentHash: hash, AuthorID: id, AuthorSig: sig,
	}
}

func TestUpsertSubmissionCreatesItemWithAttribution(t *testing.T) {
	st := openTemp(t)
	id, _ := authorOf(t, subSeedA)
	sub := signedSubmission(t, subSeedA, "article/own-1", "标题", "正文\n")

	created, err := st.UpsertSubmission(sub)
	if err != nil {
		t.Fatalf("UpsertSubmission: %v", err)
	}
	if !created {
		t.Fatal("首次投稿应 created=true")
	}
	it, ok, err := st.GetItem("article/own-1")
	if err != nil || !ok {
		t.Fatalf("GetItem: ok=%v err=%v", ok, err)
	}
	if it.Source != "article" || it.Type != "article" || it.SQLiteTable != "articles" {
		t.Fatalf("items 列不对: %+v", it)
	}
	if it.State != "active" || it.DistClass != "public" {
		t.Fatalf("state/dist_class 应为 active/public: %+v", it)
	}
	if it.AuthorID != id || it.AuthorSig != sub.AuthorSig {
		t.Fatalf("归属缓存未落库: %+v", it)
	}
	if it.SourceRev != sub.ContentHash[:16] {
		t.Fatalf("source_rev=%q want %q", it.SourceRev, sub.ContentHash[:16])
	}
	a, ok, err := st.GetArticle("article/own-1")
	if err != nil || !ok {
		t.Fatalf("GetArticle: ok=%v err=%v", ok, err)
	}
	if a.BodyMD != "正文\n" || a.ContentHash != sub.ContentHash {
		t.Fatalf("articles 行不对: %+v", a)
	}
}

func TestUpsertSubmissionUpdatesForSameAuthor(t *testing.T) {
	st := openTemp(t)
	first := signedSubmission(t, subSeedA, "article/own-2", "旧标题", "旧正文\n")
	if _, err := st.UpsertSubmission(first); err != nil {
		t.Fatalf("UpsertSubmission: %v", err)
	}
	// 同一作者改正文并重签：content_hash 与 author_sig 一起被替换。
	second := signedSubmission(t, subSeedA, "article/own-2", "新标题", "新正文\n")
	created, err := st.UpsertSubmission(second)
	if err != nil {
		t.Fatalf("UpsertSubmission: %v", err)
	}
	if created {
		t.Fatal("同作者二次投稿应 created=false")
	}
	it, _, _ := st.GetItem("article/own-2")
	if it.Title != "新标题" || it.ContentHash != second.ContentHash || it.AuthorSig != second.AuthorSig {
		t.Fatalf("更新未生效: %+v", it)
	}
	a, _, _ := st.GetArticle("article/own-2")
	if a.BodyMD != "新正文\n" {
		t.Fatalf("正文未替换: %q", a.BodyMD)
	}
}

func TestUpsertSubmissionRejectsOtherAuthor(t *testing.T) {
	st := openTemp(t)
	if _, err := st.UpsertSubmission(signedSubmission(t, subSeedA, "article/own-3", "甲", "甲的正文\n")); err != nil {
		t.Fatalf("UpsertSubmission: %v", err)
	}
	_, err := st.UpsertSubmission(signedSubmission(t, subSeedB, "article/own-3", "乙", "乙的正文\n"))
	if !errors.Is(err, ErrItemTaken) {
		t.Fatalf("他人投稿应 ErrItemTaken, got %v", err)
	}
	a, _, _ := st.GetArticle("article/own-3")
	if a.BodyMD != "甲的正文\n" {
		t.Fatalf("拒绝时不得覆盖: %q", a.BodyMD)
	}
}

// 导入器存量条目（空归属）同样算「被占」：否则任何人都能认领别人迁移进来的内容。
func TestUpsertSubmissionRejectsUnattributedExisting(t *testing.T) {
	st := openTemp(t)
	body := "运营导入的正文\n"
	if err := st.UpsertArticle(Article{
		ItemID: "article/legacy-1", Title: "存量", BodyMD: body,
		ContentHash: protocol.SHA256Hex([]byte(body)), SourceRev: "rev-1",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	_, err := st.UpsertSubmission(signedSubmission(t, subSeedA, "article/legacy-1", "认领", "认领正文\n"))
	if !errors.Is(err, ErrItemTaken) {
		t.Fatalf("空归属存量条目应 ErrItemTaken, got %v", err)
	}
}

// 导入器重跑（UpsertArticle，不带归属列）不得清空投稿写下的归属缓存。
func TestImporterRerunKeepsSubmissionAttribution(t *testing.T) {
	st := openTemp(t)
	sub := signedSubmission(t, subSeedA, "article/own-4", "标题", "正文\n")
	if _, err := st.UpsertSubmission(sub); err != nil {
		t.Fatalf("UpsertSubmission: %v", err)
	}
	// 模拟导入器重跑同一 item_id：只带 content_hash 与正文，不带归属。
	if err := st.UpsertArticle(Article{
		ItemID: "article/own-4", Title: "标题", BodyMD: "正文\n",
		ContentHash: sub.ContentHash, SourceRev: sub.ContentHash[:16],
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	it, _, _ := st.GetItem("article/own-4")
	if it.AuthorID != sub.AuthorID || it.AuthorSig != sub.AuthorSig {
		t.Fatalf("归属缓存被清空: %+v", it)
	}
}

func TestUpsertSubmissionQuizWritesSourceQuiz(t *testing.T) {
	st := openTemp(t)
	qj := `{"schema_version":1,"questions":[{"q":"1","options":["a"],"answer":0,"explain":""}]}`
	id, _ := authorOf(t, subSeedA)
	hash := protocol.SHA256Hex([]byte(qj))
	signBytes, err := protocol.AuthorSignBytes("quiz/own-1", hash, id)
	if err != nil {
		t.Fatalf("AuthorSignBytes: %v", err)
	}
	sig, err := protocol.Sign(subSeedA, signBytes)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	created, err := st.UpsertSubmission(Submission{
		ItemID: "quiz/own-1", Type: "quiz", Title: "题组", QuestionJSON: qj,
		ContentHash: hash, AuthorID: id, AuthorSig: sig,
	})
	if err != nil || !created {
		t.Fatalf("UpsertSubmission: created=%v err=%v", created, err)
	}
	it, _, _ := st.GetItem("quiz/own-1")
	if it.Source != "quiz" || it.Type != "quiz" || it.SQLiteTable != "quizzes" {
		t.Fatalf("独立题库的 source 应为 quiz: %+v", it)
	}
	q, ok, err := st.GetQuiz("quiz/own-1")
	if err != nil || !ok || q.QuestionJSON != qj {
		t.Fatalf("quizzes 行不对: ok=%v err=%v q=%+v", ok, err, q)
	}
}

func TestUpsertSubmissionRejectsUnknownType(t *testing.T) {
	st := openTemp(t)
	if _, err := st.UpsertSubmission(Submission{ItemID: "video/x", Type: "video"}); err == nil {
		t.Fatal("未支持的 type 应报错")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/store/ -run TestUpsertSubmission -v`
Expected: FAIL —— `undefined: Submission` / `undefined: ErrItemTaken`

- [ ] **Step 3: 写最小实现**

创建 `internal/store/submission.go`：

```go
package store

import (
	"database/sql"
	"errors"
	"fmt"
)

// ErrItemTaken 表示同 item_id 已被占用——含**空归属**的存量条目（册子 §3.1）。
var ErrItemTaken = errors.New("store: item_id taken")

// Submission 是一条在线投稿（册子 §2.1）：正文/题库与归属同事务落库。
type Submission struct {
	ItemID       string
	Type         string // article | quiz
	Title        string
	BodyMD       string // Type == "article"
	QuestionJSON string // Type == "quiz"
	ContentHash  string // 由调用方按册子 §2.2 算好
	AuthorID     string
	AuthorSig    string
	UpdatedAt    string // 空则由本函数取当前 UTC
}

// UpsertSubmission 写入/更新一条投稿（items + articles|quizzes 同事务），
// created=true 表示新建。占用判定只看 items.author_id（册子 §3.1）：
// 已存在且 author_id 不等于投稿者——**包括空归属的存量条目**——一律 ErrItemTaken，不写入。
func (s *Store) UpsertSubmission(sub Submission) (created bool, err error) {
	var table string
	switch sub.Type {
	case "article":
		table = "articles"
	case "quiz":
		table = "quizzes"
	default:
		return false, fmt.Errorf("store: 不支持的投稿类型 %q", sub.Type)
	}
	updated := sub.UpdatedAt
	if updated == "" {
		updated = nowUTC()
	}
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()

	var cur string
	switch err := tx.QueryRow(`SELECT author_id FROM items WHERE item_id=?`, sub.ItemID).Scan(&cur); {
	case errors.Is(err, sql.ErrNoRows):
		created = true
	case err != nil:
		return false, err
	case cur != sub.AuthorID:
		// 空归属（cur == ""）也走这里：投稿接口不是认领存量内容的口子。
		return false, ErrItemTaken
	}

	// ON CONFLICT 刻意不写 state / dist_class：墓碑条目保持其 state，
	// 不允许靠重新投稿复活（册子 §3.1，复活属第 3 册的治理动作）。
	if _, err := tx.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			title=excluded.title, source_rev=excluded.source_rev, content_hash=excluded.content_hash,
			updated_at=excluded.updated_at, author_id=excluded.author_id, author_sig=excluded.author_sig`,
		sub.ItemID, sub.Type, sub.Type, sub.Title, sub.ContentHash[:16], sub.ContentHash,
		table, "public", "active", updated, sub.AuthorID, sub.AuthorSig); err != nil {
		return false, fmt.Errorf("store: upsert submission item: %w", err)
	}

	if sub.Type == "article" {
		bodyEnc, err := s.encText(sub.BodyMD)
		if err != nil {
			return false, fmt.Errorf("store: encrypt body_md: %w", err)
		}
		if _, err := tx.Exec(`INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev)
			VALUES(?,?,?,?,?,?,?,?)
			ON CONFLICT(item_id) DO UPDATE SET
				title=excluded.title, body_md=excluded.body_md,
				content_hash=excluded.content_hash, source_rev=excluded.source_rev`,
			sub.ItemID, sub.Title, "", "", "[]", bodyEnc, sub.ContentHash, sub.ContentHash[:16]); err != nil {
			return false, fmt.Errorf("store: upsert submission article: %w", err)
		}
	} else {
		if _, err := tx.Exec(`INSERT INTO quizzes(item_id,question_json,content_hash)
			VALUES(?,?,?)
			ON CONFLICT(item_id) DO UPDATE SET question_json=excluded.question_json, content_hash=excluded.content_hash`,
			sub.ItemID, sub.QuestionJSON, sub.ContentHash); err != nil {
			return false, fmt.Errorf("store: upsert submission quiz: %w", err)
		}
	}
	return created, tx.Commit()
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/store/ -run 'TestUpsertSubmission|TestImporterRerun' -v`
Expected: PASS（6 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add internal/store/submission.go internal/store/submission_test.go
git commit -m "feat(store): 投稿写入 UpsertSubmission 与占用判定"
```

---

## Task 2: 契约校验纯函数

**Files:**
- Create: `internal/httpapi/submit.go`（本 Task 只写常量与纯函数；Task 3 在同一文件追加 handler）
- Test: `internal/httpapi/submit_test.go`

- [ ] **Step 1: 写失败测试**

创建 `internal/httpapi/submit_test.go`：

```go
package httpapi

import (
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestValidSlug(t *testing.T) {
	ok := []string{"a", "abc", "a1", "0", "a-b-c", "a" + repeat("b", 63)}
	bad := []string{"", "-a", "A", "a_b", "a b", "é", "a" + repeat("b", 64), "a/b"}
	for _, s := range ok {
		if !validSlug(s) {
			t.Fatalf("应合法: %q", s)
		}
	}
	for _, s := range bad {
		if validSlug(s) {
			t.Fatalf("应非法: %q", s)
		}
	}
}

func TestSplitSubmitItemID(t *testing.T) {
	cases := []struct {
		itemID, typ, wantSlug, wantCode string
	}{
		{"article/hello", "article", "hello", ""},
		{"quiz/q-1", "quiz", "q-1", ""},
		{"article/hello", "quiz", "", "item_type_mismatch"},
		{"quiz/q-1", "article", "", "item_type_mismatch"},
		{"course/c1", "article", "", "item_id_invalid"},
		{"course/c1/lesson/l1/quiz/q1", "quiz", "", "item_id_invalid"},
		{"article/", "article", "", "item_id_invalid"},
		{"article/Bad", "article", "", "item_id_invalid"},
		{"article/a/b", "article", "", "item_id_invalid"},
		{"lesson/x", "article", "", "item_id_invalid"},
	}
	for _, c := range cases {
		slug, code := splitSubmitItemID(c.itemID, c.typ)
		if slug != c.wantSlug || code != c.wantCode {
			t.Fatalf("splitSubmitItemID(%q, %q) = (%q, %q), want (%q, %q)",
				c.itemID, c.typ, slug, code, c.wantSlug, c.wantCode)
		}
	}
}

func TestValidItemTitle(t *testing.T) {
	if !validItemTitle("a") {
		t.Fatal("1 rune 应合法")
	}
	if !validItemTitle("  标题  ") {
		t.Fatal("去首尾空白后非空应合法")
	}
	if !validItemTitle(repeat("文", 200)) {
		t.Fatal("200 rune 应合法")
	}
	bad := []string{"", "   ", repeat("文", 201), "标\x00题", "标\x1f题", "标\x7f题"}
	for _, s := range bad {
		if validItemTitle(s) {
			t.Fatalf("应非法: %q", s)
		}
	}
}

func TestValidQuestionJSON(t *testing.T) {
	ok := `{"schema_version":1,"questions":[{"q":"1","options":["a"],"answer":0,"explain":""}]}`
	if !validQuestionJSON(ok) {
		t.Fatal("合法题组应通过")
	}
	// 未知键不参与判定（与内部解析器同口径：只看 schema_version 与 questions）。
	if !validQuestionJSON(`{"schema_version":1,"questions":[{"q":"1"}],"extra":1}`) {
		t.Fatal("额外键不应导致拒绝")
	}
	bad := []string{
		"",
		"不是 JSON",
		`{"questions":[{"q":"1"}]}`,
		`{"schema_version":2,"questions":[{"q":"1"}]}`,
		`{"schema_version":1}`,
		`{"schema_version":1,"questions":[]}`,
		`{"schema_version":1,"questions":"x"}`,
	}
	for _, s := range bad {
		if validQuestionJSON(s) {
			t.Fatalf("应非法: %q", s)
		}
	}
}

// content_hash 必须与导入器逐字节同构：UTF-8 字节的 sha256，不走 canonicalize。
func TestSubmissionContentHash(t *testing.T) {
	body := "中文正文\n"
	if got, want := submissionContentHash("article", body, ""), protocol.SHA256Hex([]byte(body)); got != want {
		t.Fatalf("article content_hash = %s, want %s", got, want)
	}
	qj := `{"schema_version":1,"questions":[]}`
	if got, want := submissionContentHash("quiz", "", qj), protocol.SHA256Hex([]byte(qj)); got != want {
		t.Fatalf("quiz content_hash = %s, want %s", got, want)
	}
}

func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/httpapi/ -run 'TestValidSlug|TestSplitSubmitItemID|TestValidItemTitle|TestValidQuestionJSON|TestSubmissionContentHash' -v`
Expected: FAIL —— `undefined: validSlug`

- [ ] **Step 3: 写最小实现**

创建 `internal/httpapi/submit.go`：

```go
package httpapi

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/johocn/base/internal/protocol"
)

// 本册的文档级常量（册子 §5）：不做配置项，校准走「改册子 + 改常量」。
const (
	// maxSubmitBytes 是单条投稿正文的 UTF-8 字节上限，远小于 authmw 的 64 KiB。
	maxSubmitBytes = 32768

	// 写限速：按已验签身份与客户端 IP 双维度，超限 429 item_rate_limited。
	submitPerMinutePerID = 6
	submitBurstPerID     = 3
	submitPerMinutePerIP = 30
	submitBurstPerIP     = 10

	// submitSignableAlgs 的两种载体：本册只收独立 article 与独立 quiz（册子 §2.4）。
	itemTypeArticle = "article"
	itemTypeQuiz    = "quiz"

	// maxTitleRunes 是标题的 rune 上限（册子 §2.1）。
	maxTitleRunes = 200
)

// validSlug 按册子 §2.4：[a-z0-9][a-z0-9-]{0,63}（总长 ≤ 64）。
func validSlug(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		isAlnum := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
		if i == 0 {
			if !isAlnum {
				return false
			}
			continue
		}
		if !isAlnum && c != '-' {
			return false
		}
	}
	return true
}

// splitSubmitItemID 校验 item_id 形态并返回 slug；code 非空即失败，
// 取值 item_id_invalid（形态/前缀/slug 不合法，含 course/ 前缀）或 item_type_mismatch（册子 §2.4）。
func splitSubmitItemID(itemID, typ string) (slug, code string) {
	prefix, rest, ok := strings.Cut(itemID, "/")
	if !ok || (prefix != itemTypeArticle && prefix != itemTypeQuiz) || !validSlug(rest) {
		return "", "item_id_invalid"
	}
	if prefix != typ {
		return "", "item_type_mismatch"
	}
	return rest, ""
}

// validItemTitle 按册子 §2.1：去首尾空白后 rune 长度 1..200，且不含控制字符（U+0000–U+001F、U+007F）。
func validItemTitle(title string) bool {
	n := utf8.RuneCountInString(strings.TrimSpace(title))
	if n < 1 || n > maxTitleRunes {
		return false
	}
	for _, r := range title {
		if r <= 0x1F || r == 0x7F {
			return false
		}
	}
	return true
}

// validQuestionJSON 按册子 §5：合法 JSON、schema_version == 1、questions 非空数组。
// 只认这两个键，其余键不参与判定。
func validQuestionJSON(raw string) bool {
	var doc struct {
		SchemaVersion int               `json:"schema_version"`
		Questions     []json.RawMessage `json:"questions"`
	}
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		return false
	}
	return doc.SchemaVersion == 1 && len(doc.Questions) > 0
}

// submissionContentHash 按册子 §2.2：与 internal/importer 的既有口径逐字节同构
// （article = sha256(body_md)、quiz = sha256(question_json)，均取 UTF-8 字节，不走 canonicalize）。
func submissionContentHash(typ, bodyMD, questionJSON string) string {
	if typ == itemTypeArticle {
		return protocol.SHA256Hex([]byte(bodyMD))
	}
	return protocol.SHA256Hex([]byte(questionJSON))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/httpapi/ -run 'TestValidSlug|TestSplitSubmitItemID|TestValidItemTitle|TestValidQuestionJSON|TestSubmissionContentHash' -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add internal/httpapi/submit.go internal/httpapi/submit_test.go
git commit -m "feat(httpapi): 投稿契约校验纯函数与文档级常量"
```

---

## Task 3: `POST /v1/submit` 写路径

**Files:**
- Modify: `internal/httpapi/submit.go`（追加 `submitReq` 与 `handleSubmitPost`）
- Modify: `internal/httpapi/server.go`（`Server` 字段 + `New()` 初始化 + 路由注册）
- Modify: `internal/httpapi/authmw.go`（`authErrText` 补 10 条）
- Test: `internal/httpapi/submit_test.go`（追加）

- [ ] **Step 1: 写失败测试**

在 `internal/httpapi/submit_test.go` 追加：

```go
const (
	// subOtherSeed 是第二个身份（「他人」场景）。
	subOtherSeed = "6f1e0d9c8b7a6958473625142332415061728394a5b6c7d8e9f0a1b2c3d4e5f6"
	// subUnregSeed 未在任何节点登记过（authmw 的 identity_unregistered 场景）。
	subUnregSeed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f61"
)

// submitNode 是投稿验收用的测试节点。
type submitNode struct {
	st     *store.Store
	public string
}

// newSubmitNode 起一个真 httpapi 节点（进程内），并预登记 testSeed 的身份。
func newSubmitNode(t *testing.T) *submitNode {
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
	pub := newInprocServer(srv.Handler())
	t.Cleanup(pub.Close)
	n := &submitNode{st: st, public: pub.URL}
	n.registerSeed(t, testSeed)
	return n
}

// registerSeed 登记一个身份（testSeed 已由 newSubmitNode 登记）。
func (n *submitNode) registerSeed(t *testing.T, seed string) string {
	t.Helper()
	id, pk := identityFromSeed(t, seed)
	if status, body := doIdentityJSON(t, http.MethodPost, n.public+"/v1/identity/register", "", registerBody(id, pk)); status != http.StatusOK {
		t.Fatalf("登记身份 status=%d body=%v", status, body)
	}
	return id
}

// rosterCount 读匿名名册里某个 id 的条数；不在名册返回 0。
func (n *submitNode) rosterCount(t *testing.T, id string) int {
	t.Helper()
	code, body := getJSON(t, n.public+"/v1/contributors")
	if code != http.StatusOK {
		t.Fatalf("GET /v1/contributors code=%d", code)
	}
	list, _ := body["contributors"].([]any)
	for _, item := range list {
		m, _ := item.(map[string]any)
		if m["id"] == id {
			c, _ := m["count"].(float64)
			return int(c)
		}
	}
	return 0
}

// submitBody 造一份投稿体：content_hash 按册子 §2.2 算、author_sig 按 §2.3 签。
// contentKey 取 "body_md" 或 "question_json"。
func submitBody(t *testing.T, seed, typ, itemID, title, contentKey, content string) string {
	t.Helper()
	id, _ := identityFromSeed(t, seed)
	hash := protocol.SHA256Hex([]byte(content))
	signBytes, err := protocol.AuthorSignBytes(itemID, hash, id)
	if err != nil {
		t.Fatalf("AuthorSignBytes: %v", err)
	}
	sig, err := protocol.Sign(seed, signBytes)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	return mustJSON(t, map[string]any{
		"type": typ, "item_id": itemID, "title": title, contentKey: content, "author_sig": sig,
	})
}

// withExtraKey 在已造好的投稿体上追加一个键（用于「请求体携带 author_id」与「携带 content_hash」场景）。
func withExtraKey(t *testing.T, body, key string, val any) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	m[key] = val
	return mustJSON(t, m)
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return string(raw)
}

// postSubmit 发一条投稿，返回 (HTTP 状态, 响应体)。
func postSubmit(t *testing.T, n *submitNode, seed, body string) (int, map[string]any) {
	t.Helper()
	return sendAuth(t, signedRequest(t, seed, http.MethodPost, n.public+"/v1/submit", body))
}

func TestSubmitRejectsAuthorIDInBody(t *testing.T) {
	n := newSubmitNode(t)
	body := withExtraKey(t, submitBody(t, testSeed, "article", "article/a1", "标题", "body_md", "正文\n"), "author_id", "00000000000000000000000000000000")
	code, out := postSubmit(t, n, testSeed, body)
	if code != http.StatusBadRequest || out["code"] != "author_id_forbidden" {
		t.Fatalf("code=%d out=%v", code, out)
	}
	if _, ok, _ := n.st.GetItem("article/a1"); ok {
		t.Fatal("拒绝时不得写入")
	}
}

func TestSubmitRejectsTypeAndItemID(t *testing.T) {
	n := newSubmitNode(t)
	cases := []struct {
		body string
		want string
	}{
		{submitBody(t, testSeed, "video", "article/a1", "标题", "body_md", "正文\n"), "item_type_unsupported"},
		{submitBody(t, testSeed, "article", "course/c1", "标题", "body_md", "正文\n"), "item_id_invalid"},
		{submitBody(t, testSeed, "article", "article/Bad", "标题", "body_md", "正文\n"), "item_id_invalid"},
		{submitBody(t, testSeed, "quiz", "article/a1", "标题", "question_json", `{"schema_version":1,"questions":[{"q":"1"}]}`), "item_type_mismatch"},
	}
	for _, c := range cases {
		code, out := postSubmit(t, n, testSeed, c.body)
		if code != http.StatusBadRequest || out["code"] != c.want {
			t.Fatalf("want %s, got code=%d out=%v", c.want, code, out)
		}
	}
}

func TestSubmitRejectsInvalidTitle(t *testing.T) {
	n := newSubmitNode(t)
	for _, title := range []string{"", "   ", repeat("文", 201), "标\x00题"} {
		body := submitBody(t, testSeed, "article", "article/a2", title, "body_md", "正文\n")
		code, out := postSubmit(t, n, testSeed, body)
		if code != http.StatusBadRequest || out["code"] != "item_title_invalid" {
			t.Fatalf("title=%q code=%d out=%v", title, code, out)
		}
	}
}

func TestSubmitRejectsOversizeBody(t *testing.T) {
	n := newSubmitNode(t)
	body := submitBody(t, testSeed, "article", "article/a3", "标题", "body_md", repeat("a", maxSubmitBytes+1))
	code, out := postSubmit(t, n, testSeed, body)
	if code != http.StatusRequestEntityTooLarge || out["code"] != "item_body_too_large" {
		t.Fatalf("code=%d out=%v", code, out)
	}
}

func TestSubmitRejectsInvalidQuestionJSON(t *testing.T) {
	n := newSubmitNode(t)
	for _, qj := range []string{"", "不是 JSON", `{"schema_version":2,"questions":[{"q":"1"}]}`, `{"schema_version":1,"questions":[]}`} {
		body := submitBody(t, testSeed, "quiz", "quiz/q2", "题组", "question_json", qj)
		code, out := postSubmit(t, n, testSeed, body)
		if code != http.StatusBadRequest || out["code"] != "item_question_invalid" {
			t.Fatalf("qj=%q code=%d out=%v", qj, code, out)
		}
	}
}

// 正文改动但沿用旧签名 → 服务端按新字节算 content_hash → 验签必然失败（册子 §3.2）。
func TestSubmitRejectsStaleSigAfterBodyChange(t *testing.T) {
	n := newSubmitNode(t)
	first := submitBody(t, testSeed, "article", "article/a4", "标题", "body_md", "第一版正文\n")
	if code, out := postSubmit(t, n, testSeed, first); code != http.StatusOK {
		t.Fatalf("首投 code=%d out=%v", code, out)
	}
	// 只换正文，author_sig 仍是第一版的。
	tampered := withExtraKey(t, first, "body_md", "第二版正文\n")
	code, out := postSubmit(t, n, testSeed, tampered)
	if code != http.StatusBadRequest || out["code"] != "author_sig_invalid" {
		t.Fatalf("code=%d out=%v", code, out)
	}
	a, _, _ := n.st.GetArticle("article/a4")
	if a.BodyMD != "第一版正文\n" {
		t.Fatalf("拒绝时不得覆盖: %q", a.BodyMD)
	}
}

// author_sig 不是 hex 同样按 author_sig_invalid 拒绝。
func TestSubmitRejectsMalformedSig(t *testing.T) {
	n := newSubmitNode(t)
	body := withExtraKey(t, submitBody(t, testSeed, "article", "article/a5", "标题", "body_md", "正文\n"), "author_sig", "zz")
	code, out := postSubmit(t, n, testSeed, body)
	if code != http.StatusBadRequest || out["code"] != "author_sig_invalid" {
		t.Fatalf("code=%d out=%v", code, out)
	}
}

// 请求体若携带 content_hash 一律忽略：错的 hash 只会让验签失败，绕不过去（册子 §2.1）。
func TestSubmitIgnoresContentHashInBody(t *testing.T) {
	n := newSubmitNode(t)
	body := withExtraKey(t, submitBody(t, testSeed, "article", "article/a6", "标题", "body_md", "正文\n"), "content_hash", "00")
	code, out := postSubmit(t, n, testSeed, body)
	if code != http.StatusOK {
		t.Fatalf("携带 content_hash 应被忽略并正常通过: code=%d out=%v", code, out)
	}
	it, _, _ := n.st.GetItem("article/a6")
	if it.ContentHash != protocol.SHA256Hex([]byte("正文\n")) {
		t.Fatalf("落库的 content_hash 应为服务端算出的值: %q", it.ContentHash)
	}
}

func TestSubmitAuthPaths(t *testing.T) {
	n := newSubmitNode(t)
	body := submitBody(t, testSeed, "article", "article/a7", "标题", "body_md", "正文\n")

	// 无签名头：requireAuth 第 1 步。
	code, out := doJSONMap(t, http.MethodPost, n.public+"/v1/submit", body, nil)
	if code != http.StatusBadRequest || out["code"] != "auth_missing_header" {
		t.Fatalf("无签名头 code=%d out=%v", code, out)
	}
	// 未登记身份：requireAuth 第 3 步。
	code, out = postSubmit(t, n, subUnregSeed, body)
	if code != http.StatusForbidden || out["code"] != "identity_unregistered" {
		t.Fatalf("未登记身份 code=%d out=%v", code, out)
	}
}

// 限速：按身份的 burst 是 3，第 4 条必须 429 item_rate_limited。
func TestSubmitRateLimited(t *testing.T) {
	n := newSubmitNode(t)
	var code int
	var out map[string]any
	for i := 0; i < submitBurstPerID+1; i++ {
		body := submitBody(t, testSeed, "article", fmt.Sprintf("article/rl%d", i), "标题", "body_md", "正文\n")
		code, out = postSubmit(t, n, testSeed, body)
		if i < submitBurstPerID && code != http.StatusOK {
			t.Fatalf("第 %d 条应通过: code=%d out=%v", i+1, code, out)
		}
	}
	if code != http.StatusTooManyRequests || out["code"] != "item_rate_limited" {
		t.Fatalf("超限应 429: code=%d out=%v", code, out)
	}
}
```

同时在文件顶部的 import 块补齐本 Task 用到的包（Task 4 还要再加 `os` 与 `packexport`）：

```go
import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/httpapi/ -run TestSubmit -v`
Expected: FAIL —— 投稿路由不存在，`doJSONMap` / `sendAuth` 拿到 404 或 `undefined: submitNode`、`postSubmit` 里的 `n.st` 未定义

- [ ] **Step 3: 写最小实现**

**3a.** 在 `internal/httpapi/submit.go` 追加：

```go
type submitReq struct {
	Type         string          `json:"type"`
	ItemID       string          `json:"item_id"`
	Title        string          `json:"title"`
	BodyMD       string          `json:"body_md"`
	QuestionJSON string          `json:"question_json"`
	AuthorSig    string          `json:"author_sig"`
	AuthorID     json.RawMessage `json:"author_id"`
}

// handleSubmitPost 是签名写路径 POST /v1/submit（册子 §2.1）：已登记身份的作者
// 把自己写的独立 article / quiz 直投本节点，验签通过即生效。任何失败都不写入。
func (s *Server) handleSubmitPost(w http.ResponseWriter, r *http.Request) {
	actor := identityFrom(r)
	var req submitReq
	if !s.decodeJSON(w, r, &req) {
		return
	}
	// author_id 只能取自鉴权身份：请求体携带即等于替他人署名（册子 §2.1 硬约束）。
	if len(req.AuthorID) > 0 {
		s.writeAuthErr(w, http.StatusBadRequest, "author_id_forbidden")
		return
	}
	if req.Type != itemTypeArticle && req.Type != itemTypeQuiz {
		s.writeAuthErr(w, http.StatusBadRequest, "item_type_unsupported")
		return
	}
	if _, code := splitSubmitItemID(req.ItemID, req.Type); code != "" {
		s.writeAuthErr(w, http.StatusBadRequest, code)
		return
	}
	title := strings.TrimSpace(req.Title)
	if !validItemTitle(req.Title) {
		s.writeAuthErr(w, http.StatusBadRequest, "item_title_invalid")
		return
	}
	content := req.BodyMD
	if req.Type == itemTypeQuiz {
		content = req.QuestionJSON
	}
	if len(content) > maxSubmitBytes {
		s.writeAuthErr(w, http.StatusRequestEntityTooLarge, "item_body_too_large")
		return
	}
	if !s.submitLimiterByID.allow(actor) || !s.submitLimiterByIP.allow(clientIP(r)) {
		s.writeAuthErr(w, http.StatusTooManyRequests, "item_rate_limited")
		return
	}
	if req.Type == itemTypeQuiz && !validQuestionJSON(req.QuestionJSON) {
		s.writeAuthErr(w, http.StatusBadRequest, "item_question_invalid")
		return
	}
	// content_hash 一律由服务端算（册子 §2.2）：请求体带的那个已在上文被忽略。
	contentHash := submissionContentHash(req.Type, req.BodyMD, req.QuestionJSON)

	it, ok, err := s.st.LookupIdentity(actor)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		s.writeAuthErr(w, http.StatusForbidden, "identity_unregistered")
		return
	}
	if !isHexN(req.AuthorSig, 64) {
		s.writeAuthErr(w, http.StatusBadRequest, "author_sig_invalid")
		return
	}
	// 作者公钥取本节点 identities 表：内容被搬到别的节点后，验签改走包内 contributors（#24 已落地）。
	valid, err := protocol.VerifyAuthorSig(it.PubKey, req.ItemID, contentHash, actor, req.AuthorSig)
	if err != nil || !valid {
		s.writeAuthErr(w, http.StatusBadRequest, "author_sig_invalid")
		return
	}
	created, err := s.st.UpsertSubmission(store.Submission{
		ItemID: req.ItemID, Type: req.Type, Title: title,
		BodyMD: req.BodyMD, QuestionJSON: req.QuestionJSON,
		ContentHash: contentHash, AuthorID: actor, AuthorSig: req.AuthorSig,
	})
	if errors.Is(err, store.ErrItemTaken) {
		s.writeAuthErr(w, http.StatusForbidden, "item_id_taken")
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"item_id": req.ItemID, "type": req.Type,
		"content_hash": contentHash, "author_id": actor, "created": created,
	})
}
```

把 `submit.go` 的 import 块补成：

```go
import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)
```

**3b.** `internal/httpapi/server.go`：`Server` 结构体加两个字段。

```go
	eventLimiterByID *ipLimiter
	eventLimiterByIP *ipLimiter
	submitLimiterByID *ipLimiter
	submitLimiterByIP *ipLimiter
```

`New()` 里初始化（紧跟既有两个事件限速器之后）：

```go
		submitLimiterByID: newIPLimiter(submitPerMinutePerID, submitBurstPerID),
		submitLimiterByIP: newIPLimiter(submitPerMinutePerIP, submitBurstPerIP),
```

`publicMux()` 里注册（紧跟 `POST /v1/profile` 一行之后）：

```go
	mux.Handle("POST /v1/submit", s.requireAuth(s.handleSubmitPost))
```

**3c.** `internal/httpapi/authmw.go` 的 `authErrText` 追加本册 10 条：

```go
	"item_id_invalid":       "item_id 必须形如 article/<slug> 或 quiz/<slug>，slug 为 [a-z0-9][a-z0-9-]{0,63}",
	"item_type_unsupported": "type 只能是 article 或 quiz",
	"item_type_mismatch":    "type 与 item_id 前缀不一致",
	"item_title_invalid":    "标题必须是去首尾空白后 1..200 个字符，且不含控制字符",
	"item_body_too_large":   "正文超过 32768 字节",
	"item_question_invalid": "question_json 不是合法 JSON、schema_version 非 1，或 questions 缺失/为空",
	"author_id_forbidden":   "请求体不得携带 author_id",
	"author_sig_invalid":    "作者归属签名验证失败",
	"item_id_taken":         "该 item_id 已被占用",
	"item_rate_limited":     "投稿过于频繁",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/httpapi/ -run TestSubmit -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add internal/httpapi/submit.go internal/httpapi/server.go internal/httpapi/authmw.go internal/httpapi/submit_test.go
git commit -m "feat(httpapi): 新增签名写路径 POST /v1/submit"
```

---

## Task 4: 端到端 AC（含名册与导出联动）

**Files:**
- Modify: `internal/httpapi/submit_test.go`（追加验收用例）

- [ ] **Step 1: 写验收测试**

在 `internal/httpapi/submit_test.go` 追加：

```go
// longBody 造一段 ≥ 200 rune 的正文（跨过名册的 article 质量门槛）。
func longBody(marker string) string { return marker + repeat("文", 200) }

const quizJSON3 = `{"schema_version":1,"questions":[{"q":"1","options":["a"],"answer":0,"explain":""},{"q":"2","options":["b"],"answer":0,"explain":""},{"q":"3","options":["c"],"answer":0,"explain":""}]}`
const quizJSON2 = `{"schema_version":1,"questions":[{"q":"1","options":["a"],"answer":0,"explain":""},{"q":"2","options":["b"],"answer":0,"explain":""}]}`

// AC 1：投 article/<aid>（body_md ≥ 200 rune）→ 200，归属落库，名册 +1。
func TestSubmitAC1Create(t *testing.T) {
	n := newSubmitNode(t)
	id, _ := identityFromSeed(t, testSeed)
	body := submitBody(t, testSeed, "article", "article/ac1", "标题", "body_md", longBody("甲"))
	code, out := postSubmit(t, n, testSeed, body)
	if code != http.StatusOK || out["created"] != true || out["author_id"] != id {
		t.Fatalf("code=%d out=%v", code, out)
	}
	if out["content_hash"] != protocol.SHA256Hex([]byte(longBody("甲"))) {
		t.Fatalf("content_hash=%v", out["content_hash"])
	}
	it, ok, _ := n.st.GetItem("article/ac1")
	if !ok || it.AuthorID != id {
		t.Fatalf("归属未落库: ok=%v it=%+v", ok, it)
	}
	if got := n.rosterCount(t, id); got != 1 {
		t.Fatalf("名册条数=%d want 1", got)
	}
}

// AC 2：同请求体重复提交 → 200、content_hash 不变、名册仍 1 条。
func TestSubmitAC2Idempotent(t *testing.T) {
	n := newSubmitNode(t)
	id, _ := identityFromSeed(t, testSeed)
	body := submitBody(t, testSeed, "article", "article/ac2", "标题", "body_md", longBody("乙"))
	code, first := postSubmit(t, n, testSeed, body)
	if code != http.StatusOK || first["created"] != true {
		t.Fatalf("首投 code=%d out=%v", code, first)
	}
	code, second := postSubmit(t, n, testSeed, body)
	if code != http.StatusOK || second["created"] != false {
		t.Fatalf("重投 code=%d out=%v", code, second)
	}
	if second["content_hash"] != first["content_hash"] {
		t.Fatalf("content_hash 变了: %v → %v", first["content_hash"], second["content_hash"])
	}
	if got := n.rosterCount(t, id); got != 1 {
		t.Fatalf("名册条数=%d want 1", got)
	}
}

// AC 3 / AC 4：改正文不重签必失败；改正文并重签则通过且名册仍 1 条。
func TestSubmitAC3AC4Resign(t *testing.T) {
	n := newSubmitNode(t)
	id, _ := identityFromSeed(t, testSeed)
	oldBody := longBody("丙")
	body := submitBody(t, testSeed, "article", "article/ac3", "标题", "body_md", oldBody)
	if code, out := postSubmit(t, n, testSeed, body); code != http.StatusOK {
		t.Fatalf("首投 code=%d out=%v", code, out)
	}

	// AC 3：换正文、沿用旧签名。
	stale := withExtraKey(t, body, "body_md", longBody("丁"))
	code, out := postSubmit(t, n, testSeed, stale)
	if code != http.StatusBadRequest || out["code"] != "author_sig_invalid" {
		t.Fatalf("AC3 code=%d out=%v", code, out)
	}
	a, _, _ := n.st.GetArticle("article/ac3")
	if a.BodyMD != oldBody {
		t.Fatalf("AC3 拒绝时不得覆盖: %q", a.BodyMD)
	}

	// AC 4：换正文并重签。
	re := submitBody(t, testSeed, "article", "article/ac3", "标题", "body_md", longBody("丁"))
	code, out = postSubmit(t, n, testSeed, re)
	if code != http.StatusOK || out["created"] != false {
		t.Fatalf("AC4 code=%d out=%v", code, out)
	}
	if out["content_hash"] != protocol.SHA256Hex([]byte(longBody("丁"))) {
		t.Fatalf("AC4 content_hash=%v", out["content_hash"])
	}
	if got := n.rosterCount(t, id); got != 1 {
		t.Fatalf("AC4 名册条数=%d want 1", got)
	}
}

// AC 5：他人投同一 item_id → 403，原条目与归属不变。
func TestSubmitAC5OtherAuthorRejected(t *testing.T) {
	n := newSubmitNode(t)
	idA, _ := identityFromSeed(t, testSeed)
	idB := n.registerSeed(t, subOtherSeed)
	bodyA := submitBody(t, testSeed, "article", "article/ac5", "甲标题", "body_md", longBody("甲"))
	if code, out := postSubmit(t, n, testSeed, bodyA); code != http.StatusOK {
		t.Fatalf("甲投稿 code=%d out=%v", code, out)
	}
	bodyB := submitBody(t, subOtherSeed, "article", "article/ac5", "乙标题", "body_md", longBody("乙"))
	code, out := postSubmit(t, n, subOtherSeed, bodyB)
	if code != http.StatusForbidden || out["code"] != "item_id_taken" {
		t.Fatalf("AC5 code=%d out=%v", code, out)
	}
	it, _, _ := n.st.GetItem("article/ac5")
	if it.AuthorID != idA || it.Title != "甲标题" {
		t.Fatalf("AC5 原条目被改: %+v", it)
	}
	if n.rosterCount(t, idB) != 0 {
		t.Fatal("AC5 被拒的投稿不得计入名册")
	}
}

// AC 6：占用导入器产出的空归属存量条目 → 403。
func TestSubmitAC6LegacyUnattributedRejected(t *testing.T) {
	n := newSubmitNode(t)
	legacy := "运营导入的正文\n"
	if err := n.st.UpsertArticle(store.Article{
		ItemID: "article/ac6", Title: "存量", BodyMD: legacy,
		ContentHash: protocol.SHA256Hex([]byte(legacy)), SourceRev: "rev-1",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	body := submitBody(t, testSeed, "article", "article/ac6", "认领", "body_md", longBody("认领"))
	code, out := postSubmit(t, n, testSeed, body)
	if code != http.StatusForbidden || out["code"] != "item_id_taken" {
		t.Fatalf("AC6 code=%d out=%v", code, out)
	}
	a, _, _ := n.st.GetArticle("article/ac6")
	if a.BodyMD != legacy {
		t.Fatalf("AC6 存量正文被覆盖: %q", a.BodyMD)
	}
}

// AC 8：无签名头 400；未登记身份 403（AC 8 的第二半）。
func TestSubmitAC8AuthErrors(t *testing.T) {
	n := newSubmitNode(t)
	body := submitBody(t, testSeed, "article", "article/ac8", "标题", "body_md", longBody("戊"))
	code, out := doJSONMap(t, http.MethodPost, n.public+"/v1/submit", body, nil)
	if code != http.StatusBadRequest || out["code"] != "auth_missing_header" {
		t.Fatalf("AC8 无签名头 code=%d out=%v", code, out)
	}
	code, out = postSubmit(t, n, subUnregSeed, body)
	if code != http.StatusForbidden || out["code"] != "identity_unregistered" {
		t.Fatalf("AC8 未登记 code=%d out=%v", code, out)
	}
	if _, ok, _ := n.st.GetItem("article/ac8"); ok {
		t.Fatal("AC8 拒绝时不得写入")
	}
}

// AC 9：3 题题库计贡献；2 题题库入库但不计贡献（名册条数仍为 1）。
func TestSubmitAC9QuizGate(t *testing.T) {
	n := newSubmitNode(t)
	id, _ := identityFromSeed(t, testSeed)
	body3 := submitBody(t, testSeed, "quiz", "quiz/ac9a", "三题", "question_json", quizJSON3)
	if code, out := postSubmit(t, n, testSeed, body3); code != http.StatusOK {
		t.Fatalf("AC9 三题 code=%d out=%v", code, out)
	}
	if got := n.rosterCount(t, id); got != 1 {
		t.Fatalf("AC9 三题名册条数=%d want 1", got)
	}
	body2 := submitBody(t, testSeed, "quiz", "quiz/ac9b", "两题", "question_json", quizJSON2)
	code, out := postSubmit(t, n, testSeed, body2)
	if code != http.StatusOK || out["created"] != true {
		t.Fatalf("AC9 两题 code=%d out=%v", code, out)
	}
	if _, ok, _ := n.st.GetQuiz("quiz/ac9b"); !ok {
		t.Fatal("AC9 两题题库应已入库")
	}
	if got := n.rosterCount(t, id); got != 1 {
		t.Fatalf("AC9 两题不应计贡献: 名册条数=%d want 1", got)
	}
}

// AC 10：导出后 entries[] 带作者归属、contributors 带公钥，且用包内公钥可独立复验通过。
func TestSubmitAC10ExportCarriesAttribution(t *testing.T) {
	n := newSubmitNode(t)
	id, pub := identityFromSeed(t, testSeed)
	body := submitBody(t, testSeed, "article", "article/ac10", "标题", "body_md", longBody("己"))
	if code, out := postSubmit(t, n, testSeed, body); code != http.StatusOK {
		t.Fatalf("投稿 code=%d out=%v", code, out)
	}
	res, err := packexport.Export(n.st, packexport.Options{Issuer: "base-node-1", SignKeyHex: testSeed})
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	raw, err := os.ReadFile(res.ManifestPath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var mf protocol.Manifest
	if err := json.Unmarshal(raw, &mf); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if mf.Contributors[id] != pub {
		t.Fatalf("contributors 缺该 id 的公钥: %v", mf.Contributors)
	}
	found := false
	for _, e := range mf.Entries {
		if e.ItemID != "article/ac10" {
			continue
		}
		found = true
		if e.AuthorID != id || !isHexN(e.AuthorSig, 64) {
			t.Fatalf("entries 归属未回填: %+v", e)
		}
		ok, err := protocol.VerifyAuthorSig(mf.Contributors[e.AuthorID], e.ItemID, e.ContentHash, e.AuthorID, e.AuthorSig)
		if err != nil || !ok {
			t.Fatalf("用包内公钥复验应通过: ok=%v err=%v", ok, err)
		}
	}
	if !found {
		t.Fatal("manifest 里没有 article/ac10")
	}
}
```

文件 import 块补 `os`、`github.com/johocn/base/internal/packexport`、`github.com/johocn/base/internal/store`。

- [ ] **Step 2: 跑验收测试**

Run: `go test ./internal/httpapi/ -run 'TestSubmitAC' -v`
Expected: PASS（AC 1、2、3+4、5、6、8、9、10 共 8 个用例）

- [ ] **Step 3: 全量门禁**

依次执行并确认输出：

```bash
go build ./...
go vet ./...
go test ./...
```

Expected：`go build` / `go vet` 无输出；`go test ./...` 全包 `ok`（含 `internal/store`、`internal/httpapi`、`internal/peersync`、`internal/packexport`）。

- [ ] **Step 4: 提交**

```bash
git add internal/httpapi/submit_test.go
git commit -m "test(httpapi): 投稿写路径 AC 1-10 端到端验收"
```

---

## Task 5: 文档回填与计划执行实况

**Files:**
- Modify: `docs/README.md`
- Modify: `docs/superpowers/plans/2026-09-28-base-submission-plan.md`（本文件）
- Modify（仅当出现执行期偏差）: `docs/superpowers/specs/2026-09-28-base-submission-design.md`

- [ ] **Step 1: README 把本计划（#26）的状态翻为已执行**

本计划创建时已在 `docs/README.md` §3 文档清单登记 #26（状态「已出（待执行）」），符合 README 的「新增文档必须先登记」硬规则。执行完 Task 1–4 后，把该行的最后一列改为：

```markdown
| 已执行（完整度见计划「执行实况」；AC 11 待人工） |
```

- [ ] **Step 2: README 依赖图与当前阶段**

§4 依赖图里把治理主线一行改为：

```
贡献度量与动态角色 (#23 → #24) ── 投稿写入 (#25 → #26) ─┬─ 审批治理（第 3 册，未立册）
                                                       └─ 创作 UI（第 4 册，未立册）
```

§5 的「下一步（关键路径）」里，把 `**#25 待评审通过后出实施计划**（出口依赖其 §8 登记的两处上游回写：#14 形态表补 `quiz/<qid>`、#23 §9 标注第 2 册已出）` 整段替换为：

```markdown
`#26` 投稿写入已落地（两处上游回写 `#14` / `#23 §9` 已在 `03281cd` 完成）；AC 11 两节点名册比对待人工
```

- [ ] **Step 3: 回填本计划的「执行实况」**

在本文件末尾追加下面一节，并把尖括号处替换为实际值与结论（不留空）：

```markdown
## 执行实况

- Task 1–4 提交：<逐个列出 commit 短哈希与标题>
- 门禁：`go build ./...` / `go vet ./...` 无输出；`go test ./...` 全包 ok
- AC 1–10：自动通过；**AC 11（两节点名册比对）待人工**，流程沿用 #23 AC 9
- 执行期更正：<「无」；或逐条写「册子原文 → 实际做法 → 原因」，并在册子 §0.2 同步>
```

若出现与册子的偏差，先在册子 `docs/superpowers/specs/2026-09-28-base-submission-design.md` 的 `## 0. 改版说明` 下追加 `### 0.2 <日期> 执行期更正`，再在本计划里引用该节。

- [ ] **Step 4: 提交**

```bash
git add docs/README.md docs/superpowers/plans/2026-09-28-base-submission-plan.md
git commit -m "docs(plans): 治理主线第 2 册实施计划与执行实况回填"
```

---

## 手工验收（不属于任何 Task，交由人工执行）

**AC 11（两节点名册比对）**：两台节点各投不同 `item_id` 后互相导入（`peersync` 或手工分发包），分别 `curl <node>/v1/contributors`，比对 `id` / `count` / 顺序完全一致（`name` 允许不同，因 `profiles` 不跨节点）。流程与 #23 AC 9 相同。

---

## 风险与边界（实施时勿越界）

1. **不改 `author_sig` 签名域**：`title` / `digest` / `tags` 不在签名内，这是册子 §7.1 明确登记的缺口，本册只标注不修。任何「顺手把 title 加进待签字节」的改动都会作废已发布向量与存量 `author_sig`，属于改契约。
2. **不改 `UpsertArticle` / `UpsertQuiz` 的 ON CONFLICT 列表**：它们不写 `author_id` / `author_sig` 正是「导入器重跑不清空归属」的前提（Task 1 有测试守这条）。
3. **不新增表、不新增列、不 bump `schema_version`**：本册零迁移。
4. **不给投稿条目可见性选择**：一律 `dist_class='public'`（册子 §0.1）。
5. **不设内容下限**：1 个字的文章、1 道题的题库都能入库（只是不计贡献）；只设上限 `maxSubmitBytes`。

---

## 执行实况

- Task 1–4 提交：`5d39a9c` 投稿写入 UpsertSubmission 与占用判定；`730cb8f` 投稿契约校验纯函数与文档级常量；`8b56726` 新增签名写路径 POST /v1/submit；`8261004` 投稿写路径 AC 1-10 端到端验收
- 门禁：`go build ./...` / `go vet ./...` 无输出；`go test ./...` 全包 ok
- AC 1–10：自动通过；**AC 11（两节点名册比对）待人工**，流程沿用 #23 AC 9
- 执行期更正：无册子级更正。计划内一处自相矛盾已就地修正——Task 3 的 `handleSubmitPost` 原把「限速」置于「quiz 题组校验」之前，会与计划自带的 `TestSubmitRejectsInvalidQuestionJSON`（连发 4 条、`submitBurstPerID=3`）冲突；实际把 `validQuestionJSON` 校验提前到限速之前，错误码与状态语义未变，两个用例同时成立。
