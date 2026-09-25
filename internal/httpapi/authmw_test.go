package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

func newAuthServer(t *testing.T) (*store.Store, *Server, *inprocServer) {
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
	ts := newInprocServer(mux)
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
