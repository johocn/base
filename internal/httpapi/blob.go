package httpapi

import (
	"errors"
	"io"
	"net/http"

	"github.com/johocn/base/internal/protocol"
)

// maxBlobBytes 是单块上传的明文上限（本册 §5）：8 MiB，与正文 32 KiB 不同量级，不复用 maxSubmitBytes。
const maxBlobBytes = 8 << 20

// handleBlobPost 是签名写路径 POST /v1/blob（本册 §2.4）：multipart/form-data 单块、字段名 file、
// 上限 maxBlobBytes、内容寻址幂等——同一内容重复上传返回同一 blob_id，块只落一份。
// 块在明文上算出 blob_id 后加密落盘（store.PutBlob），故客户端可自行预知 blob_id。
func (s *Server) handleBlobPost(w http.ResponseWriter, r *http.Request) {
	mr, err := r.MultipartReader()
	if err != nil {
		s.writeAuthErr(w, http.StatusBadRequest, "bad_multipart")
		return
	}
	var data []byte
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			s.writeAuthErr(w, http.StatusBadRequest, "bad_multipart")
			return
		}
		if part.FormName() != "file" {
			_ = part.Close()
			continue
		}
		buf, err := io.ReadAll(io.LimitReader(part, maxBlobBytes+1))
		_ = part.Close()
		if err != nil {
			s.writeAuthErr(w, http.StatusBadRequest, "bad_multipart")
			return
		}
		if len(buf) > maxBlobBytes {
			s.writeAuthErr(w, http.StatusRequestEntityTooLarge, "blob_too_large")
			return
		}
		data = buf
		break
	}
	if len(data) == 0 {
		s.writeAuthErr(w, http.StatusBadRequest, "bad_multipart")
		return
	}
	blobID := protocol.BlobID(data)
	// item_id / seq 留空：这是「先传块、后投稿」的两步上传，块与条目的关联由投稿时的 attr.attachment 行建立。
	if err := s.st.PutBlob(blobID, data, "", 0); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"blob_id": blobID, "size": len(data)})
}