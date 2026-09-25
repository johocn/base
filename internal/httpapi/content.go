package httpapi

import (
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"

	"github.com/johocn/base/internal/protocol"
)

var packIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// packFilePath 校验 pack_id、确认包已登记、返回包内文件路径。
func (s *Server) packFilePath(packID, name string) (string, bool) {
	rec, ok, err := s.st.GetPack(packID)
	if err != nil {
		return "", false
	}
	if !ok {
		return "", false
	}
	return filepath.Join(rec.Dir, name), true
}

// handleManifest 返回已发布包的 manifest.json 原文（客户端据此验签）。
func (s *Server) handleManifest(w http.ResponseWriter, r *http.Request) {
	packID := r.PathValue("pack_id")
	if !packIDPattern.MatchString(packID) {
		s.writeError(w, http.StatusBadRequest, "非法 pack_id")
		return
	}
	path, ok := s.packFilePath(packID, "manifest.json")
	if !ok {
		s.writeError(w, http.StatusNotFound, "包未登记")
		return
	}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		s.writeError(w, http.StatusNotFound, "manifest 文件不存在")
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer f.Close()
	if err := writeFileResponse(w, f, "application/json; charset=utf-8", false); err != nil {
		log.Printf("httpapi: 写 manifest 响应失败: %v", err)
	}
}

// handlePack 返回只读分发产物 pack.sqlite。
func (s *Server) handlePack(w http.ResponseWriter, r *http.Request) {
	packID := r.PathValue("pack_id")
	if !packIDPattern.MatchString(packID) {
		s.writeError(w, http.StatusBadRequest, "非法 pack_id")
		return
	}
	path, ok := s.packFilePath(packID, "pack.sqlite")
	if !ok {
		s.writeError(w, http.StatusNotFound, "包未登记")
		return
	}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		s.writeError(w, http.StatusNotFound, "pack 文件不存在")
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer f.Close()
	if err := writeFileResponse(w, f, "application/vnd.sqlite3", true); err != nil {
		log.Printf("httpapi: 写 pack 响应失败: %v", err)
	}
}

// handleBlob 返回内容寻址块；读出后重算哈希，磁盘坏块直接拒绝。
func (s *Server) handleBlob(w http.ResponseWriter, r *http.Request) {
	blobID := r.PathValue("blob_id")
	if !protocol.IsBlobID(blobID) {
		s.writeError(w, http.StatusBadRequest, "非法 blob_id")
		return
	}
	data, err := s.st.GetBlobBytes(blobID)
	if errors.Is(err, os.ErrNotExist) {
		s.writeError(w, http.StatusNotFound, "块不存在")
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if got := protocol.BlobID(data); got != blobID {
		log.Printf("httpapi: 块 %s 内容与哈希不符（实际 %s），拒绝返回", blobID, got)
		s.writeError(w, http.StatusInternalServerError, "块内容与哈希不符")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Length", strconv.Itoa(len(data)))
	h.Set("ETag", `"`+blobID+`"`)
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	if r.Header.Get("If-None-Match") == `"`+blobID+`"` {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(data); err != nil {
		log.Printf("httpapi: 写 blob 响应失败: %v", err)
	}
}

// handleBlobHead 只做存在性判定（近场互传秒传判定用），不读文件内容。
func (s *Server) handleBlobHead(w http.ResponseWriter, r *http.Request) {
	blobID := r.PathValue("blob_id")
	if !protocol.IsBlobID(blobID) {
		s.writeError(w, http.StatusBadRequest, "非法 blob_id")
		return
	}
	ok, size, err := s.st.HasBlob(blobID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		s.writeError(w, http.StatusNotFound, "块不存在")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Length", strconv.FormatInt(size, 10))
	h.Set("ETag", `"`+blobID+`"`)
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
}

// writeFileResponse 流式返回文件；调用前必须已确认文件可打开（因为会先写响应头）。
func writeFileResponse(w http.ResponseWriter, f *os.File, ctype string, cacheable bool) error {
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	h := w.Header()
	if ctype != "" {
		h.Set("Content-Type", ctype)
	}
	h.Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
	if cacheable {
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		h.Set("Cache-Control", "no-cache")
	}
	w.WriteHeader(http.StatusOK)
	_, err = io.Copy(w, f)
	return err
}