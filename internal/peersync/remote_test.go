package peersync

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestParseIssuerPubKeys(t *testing.T) {
	got, err := ParseIssuerPubKeys(`[{"issuer":"base-node-1","public_key_hex":"D75A980182B10AB7D54BFED3C964073A0EE172F3DAA62325AF021A68F707511A"}]`)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got["base-node-1"] != "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a" {
		t.Fatalf("公钥未小写归一: %q", got["base-node-1"])
	}
	if _, err := ParseIssuerPubKeys(`[{"issuer":"x","public_key_hex":"short"}]`); err == nil {
		t.Fatal("非法公钥必须报错")
	}
	if _, err := ParseIssuerPubKeys(`not-json`); err == nil {
		t.Fatal("非法 JSON 必须报错")
	}
	if m, err := ParseIssuerPubKeys(""); err != nil || len(m) != 0 {
		t.Fatalf("空串应为空表: %v %v", m, err)
	}
}

func TestFetchCatalogParsesPage(t *testing.T) {
	url, tr := newInprocPeer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/catalog" || r.URL.Query().Get("since") != "3" {
			t.Errorf("请求异常: %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"pack_id":"ab12","content_version":7,"items":[],"next_cursor":null}`))
	}))
	cfg := Config{TransportFor: tr}
	page, err := cfg.FetchCatalog(context.Background(), Peer{URL: url}, 3)
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	if page.PackID != "ab12" || page.ContentVersion != 7 {
		t.Fatalf("page = %+v", page)
	}
}

func TestFetchInventoryPaginatesAndStops(t *testing.T) {
	url, tr := newInprocPeer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("cursor") {
		case "":
			_, _ = w.Write([]byte(`{"content_version":1,"merkle_root":"r","blobs":[{"blob_id":"a","size":1}],"next_cursor":"a"}`))
		case "a":
			_, _ = w.Write([]byte(`{"content_version":1,"merkle_root":"r","blobs":[{"blob_id":"b","size":2}],"next_cursor":null}`))
		default:
			t.Errorf("不该出现 cursor=%s", r.URL.Query().Get("cursor"))
		}
	}))
	cfg := Config{TransportFor: tr}
	inv, err := cfg.FetchInventory(context.Background(), Peer{URL: url}, 0)
	if err != nil {
		t.Fatalf("inventory: %v", err)
	}
	if len(inv.Blobs) != 2 || inv.MerkleRoot != "r" || inv.ContentVersion != 1 {
		t.Fatalf("inv = %+v", inv)
	}
}

func TestFetchBlobsBatchesVerifiesAndSkipsBadFrames(t *testing.T) {
	good := []byte("正常块")
	bad := []byte("被篡改块")
	goodID := protocol.BlobID(good)
	badID := protocol.BlobID(bad)

	batches := 0
	url, tr := newInprocPeer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			BlobIDs []string `json:"blob_ids"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode 请求: %v", err)
			return
		}
		batches++
		if len(req.BlobIDs) != 1 {
			t.Errorf("FetchMaxBlobs=1 时每批必须只有 1 块，got %d", len(req.BlobIDs))
		}
		w.Header().Set("Content-Type", protocol.BlobPackContentType)
		for _, id := range req.BlobIDs {
			switch id {
			case goodID:
				_ = protocol.WriteBlobFrame(w, goodID, good)
			case badID:
				// 帧头声明 badID，但帧体是别的内容 → 接收侧必须丢弃
				_ = protocol.WriteBlobFrame(w, badID, []byte("另一些字节"))
			}
		}
	}))

	cfg := Config{TransportFor: tr, FetchMaxBlobs: 1}
	got := map[string][]byte{}
	fr, err := cfg.FetchBlobs(context.Background(), Peer{URL: url},
		[]BlobSize{{BlobID: goodID, Size: int64(len(good))}, {BlobID: badID, Size: int64(len(bad))}},
		func(id string, data []byte) error {
			got[id] = data
			return nil
		})
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if batches != 2 {
		t.Fatalf("批次数 = %d, want 2", batches)
	}
	if fr.Requested != 2 || fr.Fetched != 1 || fr.BadFrames != 1 {
		t.Fatalf("result = %+v", fr)
	}
	if string(got[goodID]) != string(good) {
		t.Fatalf("好块未落 sink: %v", got)
	}
	if _, ok := got[badID]; ok {
		t.Fatal("坏帧不得进 sink")
	}
}

func TestFetchPackToWritesThenRenames(t *testing.T) {
	payload := []byte("SQLite format 3\x00-payload")
	url, tr := newInprocPeer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(payload)
	}))
	cfg := Config{TransportFor: tr}
	dir := t.TempDir()
	path, err := cfg.FetchPackTo(context.Background(), Peer{URL: url}, "ab12", dir)
	if err != nil {
		t.Fatalf("fetch pack: %v", err)
	}
	if !strings.HasSuffix(path, "pack.sqlite") {
		t.Fatalf("落位路径 = %s", path)
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != string(payload) {
		t.Fatalf("落位内容不符: %v", err)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("临时文件必须已被 rename 掉")
	}
}
