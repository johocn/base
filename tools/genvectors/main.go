// Command genvectors 生成协议黄金向量。用法：go run ./tools/genvectors -out vectors/v1
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/johocn/base/internal/packexport"
	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// 与 RFC 8032 §7.1 TEST 1 相同的确定性测试密钥。
const testSeed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"

func main() {
	out := flag.String("out", filepath.Join("vectors", "v1"), "向量输出目录")
	flag.Parse()
	if err := os.MkdirAll(*out, 0o755); err != nil {
		fail(err)
	}
	if err := writeMerkle(*out); err != nil {
		fail(err)
	}
	if err := writeManifest(*out); err != nil {
		fail(err)
	}
	if err := writeIdentity(*out); err != nil {
		fail(err)
	}
	if err := writeRequestSig(*out); err != nil {
		fail(err)
	}
}

func writeMerkle(out string) error {
	ids := []string{
		"00000000000000000000000000000001",
		"00000000000000000000000000000002",
		"00000000000000000000000000000003",
		"00000000000000000000000000000004",
		"00000000000000000000000000000005",
	}
	type merkleCase struct {
		Name    string   `json:"name"`
		BlobIDs []string `json:"blob_ids"`
		Root    string   `json:"merkle_root"`
	}
	cases := make([]merkleCase, 0, len(ids)+1)
	empty, err := protocol.MerkleRoot(nil)
	if err != nil {
		return err
	}
	cases = append(cases, merkleCase{Name: "empty", BlobIDs: []string{}, Root: empty})
	for n := 1; n <= len(ids); n++ {
		root, err := protocol.MerkleRoot(ids[:n])
		if err != nil {
			return err
		}
		cases = append(cases, merkleCase{Name: fmt.Sprintf("leaves_%d", n), BlobIDs: ids[:n], Root: root})
	}
	return writeJSON(filepath.Join(out, "merkle.json"), map[string]any{"version": 1, "cases": cases})
}

// writeManifest 用一次确定性的真实导出产出 manifest 黄金向量。
func writeManifest(out string) error {
	kp, err := protocol.KeyPairFromSeed(testSeed)
	if err != nil {
		return err
	}
	if kp.PubHex != "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a" {
		return fmt.Errorf("测试密钥与 RFC 8032 TEST 1 不符: %s", kp.PubHex)
	}
	dir, err := os.MkdirTemp("", "genvectors-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	st, err := store.Open(dir)
	if err != nil {
		return err
	}
	defer st.Close()

	write := func(id, title, body string) error {
		return st.UpsertArticle(store.Article{
			ItemID: id, Title: title, Digest: title, PublishedAt: "2026-01-01T00:00:00Z",
			TagsJSON: `["演示","向量"]`, BodyMD: body, ContentHash: protocol.SHA256Hex([]byte(body)),
			SourceRev: "rev-1", UpdatedAt: "2026-01-02T03:04:05Z",
		})
	}
	if err := write("article:demo-1", "演示一", "demo body 1\n"); err != nil {
		return err
	}
	if err := write("article:demo-2", "演示二", "demo body 2\n"); err != nil {
		return err
	}
	cover := []byte("\x89PNG\r\n\x1a\n0123456789")
	if err := st.PutBlob(protocol.BlobID(cover), cover, "cover:demo-1", 0); err != nil {
		return err
	}
	if err := st.UpsertMediaItem(store.MediaItem{
		ItemID: "cover:demo-1", Source: "article", Type: "cover", Title: "封面",
		SourceRev: "rev-1", ContentHash: protocol.SHA256Hex(cover), MIME: "image/png",
		Size: int64(len(cover)), ChunkSize: int64(len(cover)),
		ChunkHashes: []string{protocol.SHA256Hex(cover)}, UpdatedAt: "2026-01-02T03:04:05Z",
	}); err != nil {
		return err
	}
	if err := st.AddTombstone("article:retired", 2); err != nil {
		return err
	}

	res, err := packexport.Export(st, packexport.Options{
		Issuer: "base-node-1", SignKeyHex: testSeed, Version: 7,
		IssuedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
	})
	if err != nil {
		return err
	}
	signBytes, err := res.Manifest.SignBytes()
	if err != nil {
		return err
	}
	case0 := map[string]any{
		"name": "sample_pack_v7",
		"pack_id": res.PackID,
		"content_version": res.ContentVersion,
		"merkle_root": res.MerkleRoot,
		"entries": res.Entries,
		"pack_sha256": res.PackSHA256,
		"manifest_sha256": res.ManifestSHA256,
		"sign_bytes": string(signBytes),
		"manifest": res.Manifest,
	}
	return writeJSON(filepath.Join(out, "manifest.json"), map[string]any{
		"version": 1,
		"key": map[string]any{"seed_hex": testSeed, "pub_hex": kp.PubHex},
		"cases": []any{case0},
	})
}

// writeIdentity 产出身份 id 黄金向量：固定种子 → 期望公钥 → 期望 id。
func writeIdentity(out string) error {
	seeds := []struct{ name, seed string }{
		{"rfc8032_test1", testSeed},
		{"second_key", "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7"},
	}
	type identityCase struct {
		Name    string `json:"name"`
		SeedHex string `json:"seed_hex"`
		PubHex  string `json:"pub_hex"`
		Alg     string `json:"alg"`
		ID      string `json:"id"`
	}
	cases := make([]identityCase, 0, len(seeds))
	for _, s := range seeds {
		kp, err := protocol.KeyPairFromSeed(s.seed)
		if err != nil {
			return err
		}
		id, err := protocol.IdentityID(kp.PubHex)
		if err != nil {
			return err
		}
		cases = append(cases, identityCase{
			Name: s.name, SeedHex: kp.SeedHex, PubHex: kp.PubHex, Alg: protocol.AlgEd25519, ID: id,
		})
	}
	return writeJSON(filepath.Join(out, "identity.json"), map[string]any{"version": 1, "cases": cases})
}

// writeRequestSig 产出请求签名黄金向量：固定请求元组 → 期望待签字节 + 期望签名。
func writeRequestSig(out string) error {
	kp, err := protocol.KeyPairFromSeed(testSeed)
	if err != nil {
		return err
	}
	type reqCase struct {
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
	metas := []struct {
		name string
		m    protocol.RequestMeta
	}{
		{"get_me_no_body", protocol.RequestMeta{
			Method: "GET", Path: "/v1/me", Query: "",
			BodySHA256: protocol.EmptyBodySHA256(),
			TS:         1790000000000, Nonce: "00112233445566778899aabbccddeeff",
		}},
		{"put_escrow_with_query_and_body", protocol.RequestMeta{
			Method: "PUT", Path: "/v1/identity/escrow/alice", Query: "force=1",
			BodySHA256: protocol.SHA256Hex([]byte(`{"id":"aa"}`)),
			TS:         1790000000123, Nonce: "ffeeddccbbaa99887766554433221100",
		}},
	}
	cases := make([]reqCase, 0, len(metas))
	for _, it := range metas {
		sb, err := protocol.RequestSignBytes(it.m)
		if err != nil {
			return err
		}
		sig, err := protocol.Sign(testSeed, sb)
		if err != nil {
			return err
		}
		cases = append(cases, reqCase{
			Name: it.name, Method: it.m.Method, Path: it.m.Path, Query: it.m.Query,
			BodySHA256: it.m.BodySHA256, TS: it.m.TS, Nonce: it.m.Nonce,
			SignBytes: string(sb), SignatureHex: sig,
		})
	}
	return writeJSON(filepath.Join(out, "reqsig.json"), map[string]any{
		"version": 1, "seed_hex": kp.SeedHex, "pub_hex": kp.PubHex, "cases": cases,
	})
}

func writeJSON(path string, doc any) error {
	buf, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, append(buf, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Println("wrote " + path)
	return nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "genvectors: "+err.Error())
	os.Exit(1)
}
