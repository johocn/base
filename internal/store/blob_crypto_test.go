package store

import (
	"bytes"
	"os"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestPutBlobStoresCiphertext(t *testing.T) {
	st := openTemp(t)
	plain := []byte("块明文内容-blob-唯一标记")
	id := protocol.BlobID(plain)
	if err := st.PutBlob(id, plain, "cover:demo", 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	onDisk, err := os.ReadFile(st.BlobPath(id))
	if err != nil {
		t.Fatalf("读裸文件: %v", err)
	}
	if bytes.Contains(onDisk, plain) {
		t.Fatal("磁盘上出现了明文块内容")
	}
	if len(onDisk) != len(plain)+gcmNonceSize+gcmTagSize {
		t.Fatalf("磁盘文件大小 = %d, want %d", len(onDisk), len(plain)+gcmNonceSize+gcmTagSize)
	}
	got, err := st.GetBlobBytes(id)
	if err != nil {
		t.Fatalf("GetBlobBytes: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("GetBlobBytes = %q, want %q", got, plain)
	}
	if protocol.BlobID(got) != id {
		t.Fatalf("解密后重算的 blob_id 与原 id 不一致，会破坏 handleBlob 的坏块校验")
	}
}

func TestPutBlobStillRejectsIdMismatch(t *testing.T) {
	st := openTemp(t)
	plain := []byte("真实内容")
	wrong := protocol.BlobID([]byte("别的内容"))
	if err := st.PutBlob(wrong, plain, "", 0); err == nil {
		t.Fatal("blob_id 与明文不匹配时应报错（校验必须在明文上做）")
	}
}

func TestHasBlobReportsPlaintextSize(t *testing.T) {
	st := openTemp(t)
	plain := []byte("0123456789")
	id := protocol.BlobID(plain)
	if err := st.PutBlob(id, plain, "", 0); err != nil {
		t.Fatal(err)
	}
	ok, size, err := st.HasBlob(id)
	if err != nil || !ok {
		t.Fatalf("HasBlob ok=%v err=%v", ok, err)
	}
	if size != int64(len(plain)) {
		t.Fatalf("HasBlob size = %d, want %d（必须取 blobs 表的明文长度）", size, len(plain))
	}
}

func TestHasBlobFalseWhenFileDeleted(t *testing.T) {
	st := openTemp(t)
	plain := []byte("gone")
	id := protocol.BlobID(plain)
	if err := st.PutBlob(id, plain, "", 0); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(st.BlobPath(id)); err != nil {
		t.Fatal(err)
	}
	ok, size, err := st.HasBlob(id)
	if err != nil || ok || size != 0 {
		t.Fatalf("删文件后 HasBlob ok=%v size=%d err=%v, want false/0/nil", ok, size, err)
	}
}

func TestHasBlobFalseWhenNeverWritten(t *testing.T) {
	st := openTemp(t)
	ok, size, err := st.HasBlob(protocol.BlobID([]byte("nope")))
	if err != nil || ok || size != 0 {
		t.Fatalf("未写入的块 ok=%v size=%d err=%v, want false/0/nil", ok, size, err)
	}
}

func TestBlobPlaintextAbsentFromDataDir(t *testing.T) {
	st := openTemp(t)
	marker := []byte("BLOCK-PLAINTEXT-MARKER-9f3a")
	id := protocol.BlobID(marker)
	if err := st.PutBlob(id, marker, "", 0); err != nil {
		t.Fatal(err)
	}
	assertPlaintextAbsent(t, st.DataDir(), marker)
}
