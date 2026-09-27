package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestReleaseUnavailableIsNotFound(t *testing.T) {
	_, _, ts := newTestServer(t)
	resp, err := http.Get(ts.URL + "/v1/release")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("无文件时状态 = %d，期望 404", resp.StatusCode)
	}
}

func TestReleaseServedVerbatim(t *testing.T) {
	st, _, ts := newTestServer(t)
	doc := protocol.ReleaseDoc{Payload: protocol.ReleasePayload{
		SchemaVersion: 1, Issuer: "base-node-1", IssuedAt: "2026-09-27T00:00:00Z",
		VersionName: "0.2.0", MinVersionName: "0.1.0",
		ApkURL: "http://node.example.com/dl/base-0.2.0.apk", ApkSize: 12345678,
		ApkSHA256: "ab", Notes: "课程、答题与我的",
	}}
	if err := doc.SignWith(testSeed); err != nil {
		t.Fatalf("SignWith: %v", err)
	}
	raw, err := doc.MarshalCanonical()
	if err != nil {
		t.Fatalf("MarshalCanonical: %v", err)
	}
	path := filepath.Join(st.DataDir(), "release.json")
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatalf("写 release.json: %v", err)
	}

	resp, err := http.Get(ts.URL + "/v1/release")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("状态 = %d，期望 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", ct)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读响应: %v", err)
	}
	if string(body) != string(raw) {
		t.Fatalf("响应体与文件不一致\n got %s\nwant %s", body, raw)
	}
	// 客户端拿到的字节必须能验签通过（节点不做任何合成/改写）
	var back protocol.ReleaseDoc
	if err := json.Unmarshal(body, &back); err != nil {
		t.Fatalf("反序列化: %v", err)
	}
	kp, _ := protocol.KeyPairFromSeed(testSeed)
	if ok, err := back.Verify(kp.PubHex); err != nil || !ok {
		t.Fatalf("响应体验签失败: ok=%v err=%v", ok, err)
	}
}
