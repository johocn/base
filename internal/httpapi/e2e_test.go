package httpapi

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/johocn/base/internal/protocol"
)

func getBytes(t *testing.T, url string) (int, []byte) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, b
}

func TestAnonymousEndToEndPull(t *testing.T) {
	_, _, ts := newTestServer(t)

	// ---- 1) 目录：无 token ----
	code, raw := getBytes(t, ts.URL+"/v1/catalog")
	if code != http.StatusOK {
		t.Fatalf("catalog 状态 = %d", code)
	}
	var cat struct {
		PackID         string `json:"pack_id"`
		ContentVersion int64  `json:"content_version"`
		Items          []struct {
			ItemID      string `json:"item_id"`
			ContentHash string `json:"content_hash"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &cat); err != nil {
		t.Fatalf("catalog 解析: %v (%s)", err, raw)
	}
	if cat.PackID == "" || cat.ContentVersion == 0 || len(cat.Items) != 3 {
		t.Fatalf("目录内容异常: %s", raw)
	}

	// ---- 2) 公钥 + manifest 验签 ----
	code, raw = getBytes(t, ts.URL+"/v1/pubkey")
	if code != http.StatusOK {
		t.Fatalf("pubkey 状态 = %d", code)
	}
	var pk struct {
		PublicKeyHex string `json:"public_key_hex"`
	}
	if err := json.Unmarshal(raw, &pk); err != nil {
		t.Fatal(err)
	}

	code, manRaw := getBytes(t, ts.URL+"/v1/manifest/"+cat.PackID)
	if code != http.StatusOK {
		t.Fatalf("manifest 状态 = %d", code)
	}
	var m protocol.Manifest
	if err := json.Unmarshal(manRaw, &m); err != nil {
		t.Fatalf("manifest 解析: %v", err)
	}
	if m.PackID != cat.PackID || m.ContentVersion != cat.ContentVersion {
		t.Fatalf("manifest 与目录不一致: pack=%s/%s version=%d/%d",
			m.PackID, cat.PackID, m.ContentVersion, cat.ContentVersion)
	}
	ok, err := m.Verify(pk.PublicKeyHex)
	if err != nil {
		t.Fatalf("manifest 验签报错: %v", err)
	}
	if !ok {
		t.Fatalf("manifest 验签不通过（公钥 %s）", pk.PublicKeyHex)
	}
	wantRoot, err := protocol.MerkleRoot(protocol.ManifestBlobIDs(m.Entries))
	if err != nil {
		t.Fatalf("MerkleRoot: %v", err)
	}
	if m.MerkleRoot != wantRoot {
		t.Fatalf("merkle_root 与条目块不自洽: %s != %s", m.MerkleRoot, wantRoot)
	}

	// ---- 3) pack.sqlite：逐行校验 content_hash ----
	code, packRaw := getBytes(t, ts.URL+"/v1/pack/"+cat.PackID)
	if code != http.StatusOK {
		t.Fatalf("pack 状态 = %d", code)
	}
	if len(packRaw) < 512 {
		t.Fatalf("pack 体积异常: %d 字节", len(packRaw))
	}
	packPath := filepath.Join(t.TempDir(), "pack.sqlite")
	if err := os.WriteFile(packPath, packRaw, 0o644); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(packPath)+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	rows, err := db.Query(`SELECT item_id, body_md, content_hash FROM articles ORDER BY item_id`)
	if err != nil {
		t.Fatalf("查 articles: %v", err)
	}
	seen := 0
	for rows.Next() {
		var itemID, body, want string
		if err := rows.Scan(&itemID, &body, &want); err != nil {
			t.Fatal(err)
		}
		if got := protocol.SHA256Hex([]byte(body)); got != want {
			t.Fatalf("%s 行级 content_hash 不符: %s != %s", itemID, got, want)
		}
		seen++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	if seen != 2 {
		t.Fatalf("pack 内文章数 = %d, want 2", seen)
	}

	var metaPackID, metaRoot string
	if err := db.QueryRow(`SELECT value FROM meta WHERE key='pack_id'`).Scan(&metaPackID); err != nil {
		t.Fatalf("meta.pack_id: %v", err)
	}
	if err := db.QueryRow(`SELECT value FROM meta WHERE key='merkle_root'`).Scan(&metaRoot); err != nil {
		t.Fatalf("meta.merkle_root: %v", err)
	}
	if metaPackID != cat.PackID || metaRoot != m.MerkleRoot {
		t.Fatalf("pack.meta 与 manifest 不一致: %s/%s root=%s/%s", metaPackID, cat.PackID, metaRoot, m.MerkleRoot)
	}

	// ---- 4) blob：重算哈希与大小 ----
	blobs := 0
	for _, e := range m.Entries {
		for _, c := range e.Chunks {
			code, data := getBytes(t, ts.URL+"/v1/blob/"+c.BlobID)
			if code != http.StatusOK {
				t.Fatalf("blob %s 状态 = %d", c.BlobID, code)
			}
			if int64(len(data)) != c.Size {
				t.Fatalf("blob %s 大小 = %d, want %d", c.BlobID, len(data), c.Size)
			}
			if got := protocol.BlobID(data); got != c.BlobID {
				t.Fatalf("blob %s 内容哈希不符: %s", c.BlobID, got)
			}
			blobs++
		}
	}
	if blobs != 1 {
		t.Fatalf("本轮块数 = %d, want 1（甲封面）", blobs)
	}

	// ---- 5) 篡改检测：改一个字节即验签失败 ----
	var tampered protocol.Manifest
	if err := json.Unmarshal(manRaw, &tampered); err != nil {
		t.Fatal(err)
	}
	tampered.Entries[0].Title = "被篡改的标题"
	ok, err = tampered.Verify(pk.PublicKeyHex)
	if err != nil {
		t.Fatalf("篡改后验签报错: %v", err)
	}
	if ok {
		t.Fatal("篡改后的 manifest 竟然验签通过")
	}
}