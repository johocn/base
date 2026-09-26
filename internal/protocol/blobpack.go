package protocol

import (
	"encoding/binary"
	"fmt"
	"io"
)

// BlobPackContentType 是 POST /v1/fetch 的响应类型（契约 §5.2）。
const BlobPackContentType = "application/x-base-blobpack"

const (
	// BlobFrameHeaderSize = blob_id(32 字节 ASCII) + size(8 字节大端)。
	BlobFrameHeaderSize = 40
	// FetchMaxBytes 是单次 fetch 的**总字节**上限（契约 §5.3：64 块 × 1 MiB）。
	// 服务端超限回 413；调用方切批按「块数 ≤ BASE_FETCH_MAX_BLOBS 且累计 size ≤ 本值」。
	FetchMaxBytes = 64 << 20
	// MaxBlobFrameSize 是单帧 payload 上限，只用于拒绝畸形帧头。
	// 不取 1 MiB：封面等「整块」资源本身就可以大于一个视频分块。
	MaxBlobFrameSize = 1 << 30
)

// WriteBlobFrame 写一帧：blob_id(32 ASCII) || size(8 大端) || payload。
func WriteBlobFrame(w io.Writer, blobID string, payload []byte) error {
	if !IsBlobID(blobID) {
		return fmt.Errorf("blobpack: invalid blob id %q", blobID)
	}
	if len(payload) > MaxBlobFrameSize {
		return fmt.Errorf("blobpack: payload %d 字节超过单帧上限", len(payload))
	}
	hdr := make([]byte, BlobFrameHeaderSize)
	copy(hdr[:32], blobID)
	binary.BigEndian.PutUint64(hdr[32:], uint64(len(payload)))
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

// ReadBlobFrame 读一帧；流正常结束返回 io.EOF。
// 帧缺失即「对端没有该块」，调用方以「缺哪些帧」为准，不做占位帧（契约 §5.2）。
func ReadBlobFrame(r io.Reader) (string, []byte, error) {
	hdr := make([]byte, BlobFrameHeaderSize)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return "", nil, err // io.EOF=流结束；io.ErrUnexpectedEOF=半截帧头
	}
	blobID := string(hdr[:32])
	if !IsBlobID(blobID) {
		return "", nil, fmt.Errorf("blobpack: 帧头 blob_id 非法 %q", blobID)
	}
	size := binary.BigEndian.Uint64(hdr[32:])
	if size > MaxBlobFrameSize {
		return "", nil, fmt.Errorf("blobpack: 帧声明 size=%d 超过单帧上限", size)
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(r, payload); err != nil {
		return "", nil, fmt.Errorf("blobpack: 读帧体 %s(size=%d): %w", blobID, size, err)
	}
	return blobID, payload, nil
}
