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