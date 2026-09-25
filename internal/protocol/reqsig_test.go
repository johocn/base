package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRequestSignBytes(t *testing.T) {
	if got := EmptyBodySHA256(); got != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatalf("EmptyBodySHA256 = %s, want sha256(\"\") 的 hex", got)
	}
	m := RequestMeta{
		Method: "POST", Path: "/v1/identity/escrow/alice", Query: "a=1&b=2",
		BodySHA256: SHA256Hex([]byte("{}")), TS: 1790000000000,
		Nonce: "00112233445566778899aabbccddeeff",
	}
	got, err := RequestSignBytes(m)
	if err != nil {
		t.Fatalf("RequestSignBytes: %v", err)
	}
	want := `{"body_sha256":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","method":"POST","nonce":"00112233445566778899aabbccddeeff","path":"/v1/identity/escrow/alice","query":"a=1&b=2","ts":1790000000000}`
	if string(got) != want {
		t.Fatalf("待签字节不符:\n got = %s\nwant = %s", got, want)
	}

	// 任一字段变化 → 待签字节必变。这条测的是"有没有字段漏签"。
	base := string(got)
	muts := []struct {
		name string
		m    RequestMeta
	}{
		{"method", RequestMeta{Method: "GET", Path: m.Path, Query: m.Query, BodySHA256: m.BodySHA256, TS: m.TS, Nonce: m.Nonce}},
		{"path", RequestMeta{Method: m.Method, Path: "/v1/me", Query: m.Query, BodySHA256: m.BodySHA256, TS: m.TS, Nonce: m.Nonce}},
		{"query", RequestMeta{Method: m.Method, Path: m.Path, Query: "", BodySHA256: m.BodySHA256, TS: m.TS, Nonce: m.Nonce}},
		{"body_sha256", RequestMeta{Method: m.Method, Path: m.Path, Query: m.Query, BodySHA256: EmptyBodySHA256(), TS: m.TS, Nonce: m.Nonce}},
		{"ts", RequestMeta{Method: m.Method, Path: m.Path, Query: m.Query, BodySHA256: m.BodySHA256, TS: m.TS + 1, Nonce: m.Nonce}},
		{"nonce", RequestMeta{Method: m.Method, Path: m.Path, Query: m.Query, BodySHA256: m.BodySHA256, TS: m.TS, Nonce: "ffffffffffffffffffffffffffffffff"}},
	}
	for _, mu := range muts {
		b, err := RequestSignBytes(mu.m)
		if err != nil {
			t.Fatalf("变体 %s: %v", mu.name, err)
		}
		if string(b) == base {
			t.Fatalf("变体 %s 未改变待签字节——说明该字段没进签名", mu.name)
		}
	}

	// 签/验闭环 + 篡改拒绝
	kp, err := KeyPairFromSeed(testSeed)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := Sign(testSeed, got)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	ok, err := Verify(kp.PubHex, got, sig)
	if err != nil || !ok {
		t.Fatalf("验签失败 ok=%v err=%v", ok, err)
	}
	tampered := append([]byte(nil), got...)
	tampered[len(tampered)-2] ^= 0x01
	if ok, _ := Verify(kp.PubHex, tampered, sig); ok {
		t.Fatal("篡改 1 bit 后仍验签通过")
	}
}

func TestRequestSignBytesVectors(t *testing.T) {
	type vecCase struct {
		Name         string `json:"name"`
		Method       string `json:"method"`
		Path         string `json:"path"`
		Query        string `json:"query"`
		BodySHA256   string `json:"body_sha256"`
		TS           int64  `json:"ts"`
		Nonce        string `json:"nonce"`
		SignBytes    string `json:"sign_bytes"`
		SignatureHex string `json:"signature_hex"`
	}
	var f struct {
		Version int       `json:"version"`
		SeedHex string    `json:"seed_hex"`
		PubHex  string    `json:"pub_hex"`
		Cases   []vecCase `json:"cases"`
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "reqsig.json"))
	if err != nil {
		t.Fatalf("读向量失败: %v", err)
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("解析向量失败: %v", err)
	}
	if f.Version != 1 {
		t.Fatalf("向量 version = %d, want 1", f.Version)
	}
	if len(f.Cases) < 2 {
		t.Fatalf("向量用例数 = %d, want >= 2", len(f.Cases))
	}
	kp, err := KeyPairFromSeed(f.SeedHex)
	if err != nil {
		t.Fatal(err)
	}
	if kp.PubHex != f.PubHex {
		t.Fatalf("向量公钥与种子不符: %s != %s", kp.PubHex, f.PubHex)
	}
	for _, c := range f.Cases {
		got, err := RequestSignBytes(RequestMeta{
			Method: c.Method, Path: c.Path, Query: c.Query,
			BodySHA256: c.BodySHA256, TS: c.TS, Nonce: c.Nonce,
		})
		if err != nil {
			t.Fatalf("%s: RequestSignBytes: %v", c.Name, err)
		}
		if string(got) != c.SignBytes {
			t.Fatalf("%s: 待签字节漂移\n got = %s\nwant = %s", c.Name, got, c.SignBytes)
		}
		ok, err := Verify(f.PubHex, got, c.SignatureHex)
		if err != nil || !ok {
			t.Fatalf("%s: 向量签名验签失败 ok=%v err=%v", c.Name, ok, err)
		}
	}
}
