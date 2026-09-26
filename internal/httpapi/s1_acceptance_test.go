package httpapi

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// s1Node 是册子 §10 验收用的单节点——走真实 Handler()，不手搭 mux，
// 因此路由总装、CORS、中间件挂载位置也一并被验收覆盖。
//
// 相对计划的一处偏离：本机同进程回环 TCP 不可用（见 testsupport_test.go），
// 故 httptest.NewServer 换成 newInprocServer，断言与 URL 拼接方式完全不变。
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
	ts := newInprocServer(srv.Handler())
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

// eventBody 造一个能过 event_param_invalid 校验的事件体（event_id 必须是 16 字节 hex、created_at > 0）。
func eventBody(typ string) string {
	return `{"event_id":"` + strings.Repeat("ab", 16) + `","type":"` + typ + `","created_at":` +
		strconv.FormatInt(time.Now().UnixMilli(), 10) + `,"body":{}}`
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

	req := signedRequest(t, clientSeed, http.MethodPost, b.url+"/v1/event", eventBody("ping"))
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
// 偏离计划：本错误由既有 writeError 输出，按契约 §3.3 只有 {"error": ...}、没有 code 字段，
// 故断言 error 而非 code（带 code 的只有 writeAuthErr 的验签类错误）。
func TestS1Acceptance06IDSelfProving(t *testing.T) {
	n := newS1Node(t, testSeed)
	_, pub := identityFromSeed(t, testSeed)
	badID := strings.Repeat("00", 16)
	status, body := doIdentityJSON(t, http.MethodPost, n.url+"/v1/identity/register", "", registerBody(badID, pub))
	if status != http.StatusBadRequest {
		t.Fatalf("status=%d body=%v, want 400", status, body)
	}
	if got := body["error"]; got != "identity_id_mismatch" {
		t.Fatalf("error=%v, want identity_id_mismatch", got)
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
// 偏离计划：同验收 6——writeError 的形状只有 error 字段，故断言 error。
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
	if got := body["error"]; got != "escrow_conflict" {
		t.Fatalf("error=%v, want escrow_conflict", got)
	}
}

// 验收 11（新增，守修正 4）：密钥文件必须在 data 目录之外。
//
// 相对计划的两处偏离（为让断言真正成立）：
//  1. newS1Node 用 WithStoreKey 显式注入密钥，根本不落密钥文件，故本用例单独 Open 一次走「首启自动生成」路径；
//  2. defaultStoreKeyPath 是 store 包内部函数，跨包改用公开的 StoreKeyStatus 取路径。
func TestS1Acceptance11StoreKeyOutsideDataDir(t *testing.T) {
	data := t.TempDir()
	keyPath, _, exists, err := store.StoreKeyStatus(data)
	if err != nil {
		t.Fatalf("StoreKeyStatus: %v", err)
	}
	if exists {
		t.Fatalf("密钥文件不应预先存在: %s", keyPath)
	}
	if strings.HasPrefix(keyPath, filepath.Clean(data)+string(os.PathSeparator)) {
		t.Fatalf("默认密钥路径 %s 落在 data 目录内——cp -r data 会连密钥一起拷走", keyPath)
	}
	// 自动生成的密钥落在 data 的兄弟位置，不在 t.TempDir() 的清理范围内，需自行收拾。
	t.Cleanup(func() { _ = os.Remove(keyPath) })

	st, err := store.Open(data)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	if got := st.StoreKeyPath(); got != keyPath {
		t.Fatalf("加密所用密钥路径 = %s, want %s", got, keyPath)
	}
	if _, err := os.Stat(keyPath); err != nil {
		t.Fatalf("密钥文件应存在于 %s: %v", keyPath, err)
	}
	if _, _, exists, err := store.StoreKeyStatus(data); err != nil || !exists {
		t.Fatalf("StoreKeyStatus 应报 exists=true: exists=%v err=%v", exists, err)
	}
	if _, err := os.Stat(filepath.Join(data, "store.key")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("密钥文件不得落在 data 目录内")
	}
}

// 验收 13（新增，守 §7.3 不变量 2）：blob 接口返回明文，长度不得暴露封装长度。
func TestS1Acceptance13BlobPlaintextOverWire(t *testing.T) {
	n := newS1Node(t, testSeed)
	plain := []byte("S1-ACCEPTANCE-PLAINTEXT-内容-0123456789")
	blobID := protocol.BlobID(plain)
	if err := n.st.PutBlob(blobID, plain, "", 0); err != nil {
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