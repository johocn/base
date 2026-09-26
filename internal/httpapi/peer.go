package httpapi

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/johocn/base/internal/protocol"
)

const (
	inventoryDefaultLimit = 500
	inventoryMaxLimit     = 2000
)

// 本文件是节点↔节点接口的**入站**侧：只在对端监听上注册（见 server.go 的 mountInternal）。
// 本层不做跨节点编排：scrub 只修本地，从邻居补齐由调用方走 fetch（册子 §5.2、修正 2）。

type blobSizeDTO struct {
	BlobID string `json:"blob_id"`
	Size   int64  `json:"size"`
}

type inventoryResponse struct {
	ContentVersion int64         `json:"content_version"`
	MerkleRoot     string        `json:"merkle_root"`
	Blobs          []blobSizeDTO `json:"blobs"`
	NextCursor     *string       `json:"next_cursor"`
}

// handleInventory 返回本节点块清单分页 + 全量 merkle_root（契约 §5.2）。
// merkle_root 的定义域是**本节点持有的全部块 id**，与 packexport 的包内 merkle_root 不是同一个值。
func (s *Server) handleInventory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := inventoryDefaultLimit
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= inventoryMaxLimit {
			limit = n
		}
	}

	version, err := s.st.ContentVersion()
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	ids, err := s.st.ListAllBlobIDs()
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	root, err := protocol.MerkleRoot(ids)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := inventoryResponse{ContentVersion: version, MerkleRoot: root, Blobs: []blobSizeDTO{}}
	if since := q.Get("since"); since != "" {
		if n, err := strconv.ParseInt(since, 10, 64); err == nil && n >= version {
			// 调用方水位不低于本节点：空 blobs + 仍带 merkle_root，用于快速 no-op
			s.writeJSON(w, http.StatusOK, resp)
			return
		}
	}

	refs, next, err := s.st.ListBlobsPage(q.Get("cursor"), limit)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, ref := range refs {
		resp.Blobs = append(resp.Blobs, blobSizeDTO{BlobID: ref.BlobID, Size: ref.Size})
	}
	if next != "" {
		resp.NextCursor = &next
	}
	s.writeJSON(w, http.StatusOK, resp)
}

type syncRequest struct {
	ContentVersion int64  `json:"content_version"`
	MerkleRoot     string `json:"merkle_root"`
}

// handleSync 开启一轮反熵会话：无状态，只比块集合的 merkle_root（契约 §5.2）。
func (s *Server) handleSync(w http.ResponseWriter, r *http.Request) {
	var req syncRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	ids, err := s.st.ListAllBlobIDs()
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	root, err := protocol.MerkleRoot(ids)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	equal := root == req.MerkleRoot
	log.Printf("httpapi: sync 来自水位 %d 的比对：equal=%v", req.ContentVersion, equal)
	s.writeJSON(w, http.StatusOK, map[string]any{"equal": equal})
}

type fetchRequest struct {
	BlobIDs []string `json:"blob_ids"`
}

// handleFetch 批量拉块，逐帧流式返回（契约 §5.2）。
// 请求中不存在于本节点的 blob_id **整帧跳过**（不占位、不报错）。
func (s *Server) handleFetch(w http.ResponseWriter, r *http.Request) {
	var req fetchRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	if len(req.BlobIDs) == 0 {
		s.writeError(w, http.StatusBadRequest, "blob_ids 不能为空")
		return
	}
	if len(req.BlobIDs) > s.opt.FetchMaxBlobs {
		s.writeError(w, http.StatusRequestEntityTooLarge,
			"单请求块数超过上限 "+strconv.Itoa(s.opt.FetchMaxBlobs))
		return
	}
	for _, id := range req.BlobIDs {
		if !protocol.IsBlobID(id) {
			s.writeError(w, http.StatusBadRequest, "非法 blob_id: "+id)
			return
		}
	}

	// 先做全量预检：存在性与总字节上限。任一不满足就返回错误，
	// **绝不返回半截流**（客户端无法区分「对端没有」与「写了一半断了」）。
	type hit struct {
		id   string
		size int64
	}
	found := make([]hit, 0, len(req.BlobIDs))
	seen := map[string]struct{}{}
	total := int64(0)
	for _, id := range req.BlobIDs {
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		ok, size, err := s.st.HasBlob(id)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !ok {
			continue // 本节点没有：整帧跳过
		}
		total += size
		found = append(found, hit{id: id, size: size})
	}
	if total > protocol.FetchMaxBytes {
		s.writeError(w, http.StatusRequestEntityTooLarge,
			"单请求总字节超过上限 "+strconv.Itoa(protocol.FetchMaxBytes))
		return
	}

	w.Header().Set("Content-Type", protocol.BlobPackContentType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	sent := 0
	for _, h := range found {
		data, err := s.st.GetBlobBytes(h.id)
		if err != nil {
			log.Printf("httpapi: fetch 读块 %s 失败，跳过该帧: %v", h.id, err)
			continue
		}
		if got := protocol.BlobID(data); got != h.id {
			log.Printf("httpapi: fetch 块 %s 内容与哈希不符（实际 %s），跳过该帧", h.id, got)
			continue
		}
		if err := protocol.WriteBlobFrame(w, h.id, data); err != nil {
			log.Printf("httpapi: fetch 写帧 %s 失败（调用方可能已断开）: %v", h.id, err)
			return
		}
		sent++
	}
	log.Printf("httpapi: fetch 请求 %d 块，本节点命中 %d 块，发送 %d 帧", len(req.BlobIDs), len(found), sent)
}

type scrubRequest struct {
	BlobIDs []string `json:"blob_ids"`
}

type scrubBadDTO struct {
	BlobID string `json:"blob_id"`
	Reason string `json:"reason"`
}

type scrubResponse struct {
	Checked  int           `json:"checked"`
	Repaired int           `json:"repaired"`
	Dropped  int           `json:"dropped"`
	Bad      []scrubBadDTO `json:"bad"`
}

// handleScrub 触发一次**本地**校验修复（契约 §5.2 + 修正 2）。
// Repaired 恒为 0：跨节点补齐必须走出站请求，本包不依赖 peersync；
// 调用方拿到 bad 后自行走 fetch 补齐。
func (s *Server) handleScrub(w http.ResponseWriter, r *http.Request) {
	var req scrubRequest
	if r.Body != nil {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			s.writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
			return
		}
	}
	checked, bad, err := s.st.VerifyBlobs(req.BlobIDs)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := scrubResponse{Checked: checked, Repaired: 0, Dropped: len(bad), Bad: []scrubBadDTO{}}
	for _, b := range bad {
		resp.Bad = append(resp.Bad, scrubBadDTO{BlobID: b.BlobID, Reason: b.Reason})
	}
	s.writeJSON(w, http.StatusOK, resp)
}
