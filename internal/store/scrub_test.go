package store

import (
	"os"
	"testing"
)

// missing：blobs 行在、文件没了 → 删行并记 missing（契约 §8 第 3 条）。
func TestVerifyBlobsReportsMissingAndDropsRow(t *testing.T) {
	st := openTemp(t)
	id := putBlob(t, st, "会丢的块", "lesson:s", 0)
	if err := os.Remove(st.BlobPath(id)); err != nil {
		t.Fatalf("删块文件: %v", err)
	}

	checked, bad, err := st.VerifyBlobs(nil)
	if err != nil {
		t.Fatalf("VerifyBlobs: %v", err)
	}
	if checked != 0 || len(bad) != 1 || bad[0].BlobID != id || bad[0].Reason != "missing" {
		t.Fatalf("checked=%d bad=%+v", checked, bad)
	}

	// 幂等：第二次全量校验不能再报同一块，也不该报错
	if _, bad2, err := st.VerifyBlobs(nil); err != nil || len(bad2) != 0 {
		t.Fatalf("missing 未清干净: bad=%+v err=%v", bad2, err)
	}
	if n, err := st.CountBlobsWithoutReplica(); err != nil || n != 0 {
		t.Fatalf("blobs 行必须被删除: n=%d err=%v", n, err)
	}
}

// hash_mismatch：文件在、内容被换 → 删文件与行并记 hash_mismatch（契约 §8 第 2 条）。
func TestVerifyBlobsDropsCorruptedBlobFile(t *testing.T) {
	st := openTemp(t)
	id := putBlob(t, st, "会被改坏的块", "lesson:s", 0)
	// L4a′ 下覆写块文件：解封失败与重算哈希不符两条路径都归到 hash_mismatch
	if err := os.WriteFile(st.BlobPath(id), []byte("tampered-bytes"), 0o600); err != nil {
		t.Fatalf("覆写块文件: %v", err)
	}

	checked, bad, err := st.VerifyBlobs([]string{id})
	if err != nil {
		t.Fatalf("VerifyBlobs: %v", err)
	}
	if checked != 1 || len(bad) != 1 || bad[0].BlobID != id || bad[0].Reason != "hash_mismatch" {
		t.Fatalf("checked=%d bad=%+v", checked, bad)
	}
	if _, err := os.Stat(st.BlobPath(id)); !os.IsNotExist(err) {
		t.Fatalf("坏块文件必须被删除，stat err=%v", err)
	}
	if n, err := st.CountBlobsWithoutReplica(); err != nil || n != 0 {
		t.Fatalf("blobs 行必须被删除: n=%d err=%v", n, err)
	}
}
