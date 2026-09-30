package httpapi

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

// multipartBody 造一个单块 multipart 体（字段名 field），返回体与 Content-Type。
func multipartBody(t *testing.T, field, filename string, data []byte) (string, string) {
	t.Helper()
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	fw, err := mw.CreateFormFile(field, filename)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := fw.Write(data); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	return b.String(), mw.FormDataContentType()
}

// postBlob 发一条签名 blob 上传，返回 (HTTP 状态, 响应体)。
func postBlob(t *testing.T, n *submitNode, seed, body, contentType string) (int, map[string]any) {
	t.Helper()
	req := signedRequest(t, seed, http.MethodPost, n.public+"/v1/blob", body)
	req.Header.Set("Content-Type", contentType)
	return sendAuth(t, req)
}

// 往返 + 内容寻址幂等：同内容重复上传返回同一 blob_id，块只落一份。
func TestBlobPostRoundTripAndIdempotent(t *testing.T) {
	n := newSubmitNode(t)
	data := []byte("hello blob\n")
	body, ct := multipartBody(t, "file", "a.txt", data)
	want := protocol.BlobID(data)
	for i := 1; i <= 2; i++ {
		code, out := postBlob(t, n, testSeed, body, ct)
		if code != http.StatusOK || out["blob_id"] != want {
			t.Fatalf("第 %d 次: code=%d out=%v want=%s", i, code, out, want)
		}
	}
	ok, size, err := n.st.HasBlob(want)
	if err != nil || !ok || size != int64(len(data)) {
		t.Fatalf("HasBlob: ok=%v size=%d err=%v", ok, size, err)
	}
}

// 超限（> 8 MiB）→ 413 blob_too_large。
func TestBlobPostTooLarge(t *testing.T) {
	n := newSubmitNode(t)
	data := bytes.Repeat([]byte("x"), maxBlobBytes+1)
	body, ct := multipartBody(t, "file", "big.bin", data)
	code, out := postBlob(t, n, testSeed, body, ct)
	if code != http.StatusRequestEntityTooLarge || out["code"] != "blob_too_large" {
		t.Fatalf("code=%d out=%v", code, out)
	}
}

// 无签名头 → 400 auth_missing_header（blob 与其它写路径同auth 口径）。
func TestBlobPostRequiresAuth(t *testing.T) {
	n := newSubmitNode(t)
	body, ct := multipartBody(t, "file", "a.txt", []byte("x"))
	req, err := http.NewRequest(http.MethodPost, n.public+"/v1/blob", strings.NewReader(body))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", ct)
	code, out := sendAuth(t, req)
	if code != http.StatusBadRequest || out["code"] != "auth_missing_header" {
		t.Fatalf("code=%d out=%v", code, out)
	}
}

// 缺 file 字段 → 400 bad_multipart。
func TestBlobPostRejectsMissingFileField(t *testing.T) {
	n := newSubmitNode(t)
	body, ct := multipartBody(t, "other", "a.txt", []byte("x"))
	code, out := postBlob(t, n, testSeed, body, ct)
	if code != http.StatusBadRequest || out["code"] != "bad_multipart" {
		t.Fatalf("code=%d out=%v", code, out)
	}
}