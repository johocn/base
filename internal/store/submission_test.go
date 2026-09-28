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
