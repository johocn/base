package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func TestBlobFrameRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	a, b := []byte("第一块"), bytes.Repeat([]byte{7}, 1024)
	idA, idB := BlobID(a), BlobID(b)
	if err := WriteBlobFrame(&buf, idA, a); err != nil {
		t.Fatalf("写帧A: %v", err)
	}
	if err := WriteBlobFrame(&buf, idB, b); err != nil {
		t.Fatalf("写帧B: %v", err)
	}

	r := bytes.NewReader(buf.Bytes())
	gotID, gotBody, err := ReadBlobFrame(r)
	if err != nil || gotID != idA || !bytes.Equal(gotBody, a) {
		t.Fatalf("帧A 往返失败: id=%s err=%v", gotID, err)
	}
	gotID, gotBody, err = ReadBlobFrame(r)
	if err != nil || gotID != idB || !bytes.Equal(gotBody, b) {
		t.Fatalf("帧B 往返失败: id=%s err=%v", gotID, err)
	}
	if _, _, err := ReadBlobFrame(r); !errors.Is(err, io.EOF) {
		t.Fatalf("流结束应返回 io.EOF, got %v", err)
	}
}

func TestBlobFrameRejectsBadHeaders(t *testing.T) {
	// 非法 blob_id
	if err := WriteBlobFrame(io.Discard, "NOT-HEX", []byte("x")); err == nil {
		t.Fatal("非法 blob_id 应被拒绝")
	}
	// 半截帧头
	if _, _, err := ReadBlobFrame(bytes.NewReader(make([]byte, 10))); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("半截帧头应返回 ErrUnexpectedEOF, got %v", err)
	}
	// 声明 size 超上限
	hdr := make([]byte, BlobFrameHeaderSize)
	copy(hdr[:32], BlobID([]byte("x")))
	binary.BigEndian.PutUint64(hdr[32:], uint64(MaxBlobFrameSize)+1)
	if _, _, err := ReadBlobFrame(bytes.NewReader(hdr)); err == nil {
		t.Fatal("超上限 size 应被拒绝")
	}
}

func TestBlobFetchMaxBytesIsSharedContract(t *testing.T) {
	if FetchMaxBytes != 64<<20 {
		t.Fatalf("FetchMaxBytes = %d, want 64 MiB", FetchMaxBytes)
	}
}
