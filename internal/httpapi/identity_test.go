package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
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

func newIdentityServer(t *testing.T) (*store.Store, *Server, *inprocServer) {
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
	ts := newInprocServer(mux)
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
