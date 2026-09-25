package httpapi

import (
	"net/http"
	"strings"
	"testing"

	"github.com/johocn/base/internal/store"
)

// newFullServer 用真实 srv.Handler()，因此同时覆盖「路由是否挂上」。
func newFullServer(t *testing.T) (*store.Store, *Server, *inprocServer) {
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
	ts := newInprocServer(srv.Handler())
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
