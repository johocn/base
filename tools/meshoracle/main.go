// Command meshoracle 对拍 mesh 向量（Go consumer 侧，spec §3.8）。
// 用法：go run ./tools/meshoracle -vectors vectors/v1/mesh.json
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/johocn/base/internal/protocol"
)

type keyBlock struct {
	RootSeedHex    string `json:"root_seed_hex"`
	RootPubHex     string `json:"root_pub_hex"`
	WorkingSeedHex string `json:"working_seed_hex"`
	WorkingPubHex  string `json:"working_pub_hex"`
}

type rotationBlock struct {
	Doc       json.RawMessage `json:"doc"`
	CertID    string          `json:"cert_id"`
	SignBytes string          `json:"sign_bytes"`
}

type enrollBlock struct {
	Doc       json.RawMessage `json:"doc"`
	Canonical string          `json:"canonical"`
}

type catalogBlock struct {
	Doc       json.RawMessage `json:"doc"`
	SignBytes string          `json:"sign_bytes"`
}

type vectorsFile struct {
	Version  int           `json:"version"`
	Key      keyBlock      `json:"key"`
	Rotation rotationBlock `json:"rotation"`
	Enroll   enrollBlock   `json:"enroll"`
	Catalog  catalogBlock  `json:"catalog"`
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "meshoracle:", err)
	os.Exit(1)
}

func mustHex(what, s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		fail(fmt.Errorf("%s: bad hex: %v", what, err))
	}
	return b
}

// decodeDoc 用 UseNumber 解码 doc：JSON number 保持字面量（json.Number），
// 避免 float64 重编形变；整数值经 Canonicalize 输出与 TS 侧逐字一致。
func decodeDoc(what string, raw json.RawMessage) map[string]any {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		fail(fmt.Errorf("%s: decode doc: %v", what, err))
	}
	return m
}

// signedCanonical 取 doc 的 signature 并删键，回 canonical 字节（与 sign_bytes 对拍）。
func signedCanonical(what string, raw json.RawMessage) ([]byte, string) {
	doc := decodeDoc(what, raw)
	sigHex, ok := doc["signature"].(string)
	if !ok || sigHex == "" {
		fail(fmt.Errorf("%s: doc missing signature", what))
	}
	delete(doc, "signature")
	canonical, err := protocol.Canonicalize(doc)
	if err != nil {
		fail(fmt.Errorf("%s: canonicalize: %v", what, err))
	}
	return canonical, sigHex
}

func checkKey(k keyBlock) {
	root, err := protocol.KeyPairFromSeed(k.RootSeedHex)
	if err != nil {
		fail(fmt.Errorf("key: root seed: %v", err))
	}
	if root.PubHex != k.RootPubHex {
		fail(fmt.Errorf("key: root pub mismatch: got %s want %s", root.PubHex, k.RootPubHex))
	}
	working, err := protocol.KeyPairFromSeed(k.WorkingSeedHex)
	if err != nil {
		fail(fmt.Errorf("key: working seed: %v", err))
	}
	if working.PubHex != k.WorkingPubHex {
		fail(fmt.Errorf("key: working pub mismatch: got %s want %s", working.PubHex, k.WorkingPubHex))
	}
}

// checkRotation：canonical 字节 == sign_bytes；根钥验签；cert_id = hex(sha256(canonical))[0:16]。
func checkRotation(f vectorsFile) {
	canonical, sigHex := signedCanonical("rotation", f.Rotation.Doc)
	if string(canonical) != f.Rotation.SignBytes {
		fail(fmt.Errorf("rotation: canonical mismatch\n  go:  %s\n  vec: %s", canonical, f.Rotation.SignBytes))
	}
	pub := ed25519.PublicKey(mustHex("rotation", f.Key.RootPubHex))
	if !ed25519.Verify(pub, canonical, mustHex("rotation", sigHex)) {
		fail(fmt.Errorf("rotation: ed25519 verify failed against root pubkey"))
	}
	sum := sha256.Sum256(canonical)
	if got := hex.EncodeToString(sum[:16]); got != f.Rotation.CertID {
		fail(fmt.Errorf("rotation: cert_id mismatch: got %s want %s", got, f.Rotation.CertID))
	}
}

// checkEnroll：enroll 无签名，锁 canonical 字节。
func checkEnroll(f vectorsFile) {
	doc := decodeDoc("enroll", f.Enroll.Doc)
	canonical, err := protocol.Canonicalize(doc)
	if err != nil {
		fail(fmt.Errorf("enroll: canonicalize: %v", err))
	}
	if string(canonical) != f.Enroll.Canonical {
		fail(fmt.Errorf("enroll: canonical mismatch\n  go:  %s\n  vec: %s", canonical, f.Enroll.Canonical))
	}
}

// checkCatalog：canonical 字节 == sign_bytes；working 钥验签。
func checkCatalog(f vectorsFile) {
	canonical, sigHex := signedCanonical("catalog", f.Catalog.Doc)
	if string(canonical) != f.Catalog.SignBytes {
		fail(fmt.Errorf("catalog: canonical mismatch\n  go:  %s\n  vec: %s", canonical, f.Catalog.SignBytes))
	}
	pub := ed25519.PublicKey(mustHex("catalog", f.Key.WorkingPubHex))
	if !ed25519.Verify(pub, canonical, mustHex("catalog", sigHex)) {
		fail(fmt.Errorf("catalog: ed25519 verify failed against working pubkey"))
	}
}

func main() {
	vpath := flag.String("vectors", filepath.FromSlash("vectors/v1/mesh.json"), "向量文件")
	flag.Parse()
	raw, err := os.ReadFile(*vpath)
	if err != nil {
		fail(err)
	}
	var f vectorsFile
	if err := json.Unmarshal(raw, &f); err != nil {
		fail(err)
	}
	if f.Version != 1 {
		fail(fmt.Errorf("unsupported vectors version %d", f.Version))
	}
	checkKey(f.Key)
	checkRotation(f)
	checkEnroll(f)
	checkCatalog(f)
	fmt.Println("meshoracle: all vectors pass (rotation/enroll/catalog)")
}
