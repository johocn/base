package peersync

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
	_ "modernc.org/sqlite"
)

// ImportOutcome 是一次包级复制的结果。
type ImportOutcome struct {
	Status         string // noop | imported
	ContentVersion int64
	PackID         string
	Entries        int
	Skipped        int
	Rejected       []string
	RemovedBlobs   int
}

// ImportPack 把一个 peer 的已签名内容包复制到本节点。
// 顺序即不变量：目录水位 → 验签 → pack meta → pack 行级 → 才落库；任一步失败都不落任何行。
func (c Config) ImportPack(ctx context.Context, st *store.Store, p Peer, localVersion int64) (ImportOutcome, error) {
	out := ImportOutcome{Status: "noop", ContentVersion: localVersion}

	page, err := c.FetchCatalog(ctx, p, localVersion)
	if err != nil {
		return out, err
	}
	if page.PackID == "" || page.ContentVersion <= localVersion {
		return out, nil // 对端还不是源节点，或没有更新（册子 §6.2 步骤 2）
	}
	out.PackID = page.PackID

	man, manifestBytes, err := c.FetchManifest(ctx, p, page.PackID)
	if err != nil {
		return out, err
	}
	if man.PackID != page.PackID {
		return out, fmt.Errorf("manifest.pack_id=%s 与目录 %s 不一致", man.PackID, page.PackID)
	}
	pub, ok := c.IssuerPubKeys[man.Issuer]
	if !ok {
		return out, fmt.Errorf("issuer %q 未在 BASE_ISSUER_PUBKEYS 中，拒绝整包（不做 TOFU）", man.Issuer)
	}
	verified, err := man.Verify(pub)
	if err != nil {
		return out, fmt.Errorf("验签 %s 出错: %w", page.PackID, err)
	}
	if !verified {
		return out, fmt.Errorf("manifest 验签失败（pack=%s issuer=%s）", page.PackID, man.Issuer)
	}
	if man.ContentVersion < localVersion {
		return out, fmt.Errorf("对端版本 %d 低于本地 %d，拒绝回卷", man.ContentVersion, localVersion)
	}

	tmpDir, err := os.MkdirTemp(st.DataDir(), "packimport-")
	if err != nil {
		return out, err
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()

	packPath, err := c.FetchPackTo(ctx, p, man.PackID, tmpDir)
	if err != nil {
		return out, err
	}
	entries, err := readAndVerifyPack(packPath, man)
	if err != nil {
		return out, err // 整包拒绝：临时目录由 defer 清理，本地视图不变
	}

	res, err := st.ImportPack(man.ContentVersion, entries, man.Tombstone)
	if err != nil {
		return out, err
	}

	// 落位：packs/<pack_id>/pack.sqlite + manifest.json（字节与源节点一致，册子 §6.4）
	finalDir := filepath.Join(st.PacksDir(), man.PackID)
	if err := os.MkdirAll(finalDir, 0o755); err != nil {
		return out, err
	}
	finalPack := filepath.Join(finalDir, "pack.sqlite")
	if err := os.Rename(packPath, finalPack); err != nil {
		return out, err
	}
	if err := os.WriteFile(filepath.Join(finalDir, "manifest.json"), manifestBytes, 0o644); err != nil {
		return out, err
	}
	if err := st.InsertPack(store.PackRecord{
		PackID: man.PackID, ContentVersion: man.ContentVersion, Dir: finalDir,
		MerkleRoot: man.MerkleRoot, Signature: man.Signature, IssuedAt: man.IssuedAt,
		ItemCount: len(man.Entries),
	}); err != nil {
		return out, err
	}

	// 墓碑连带删块文件：行已删，路径从 RemovedBlobs 来（修正 5：失败只记日志，不阻断）
	for _, id := range res.RemovedBlobs {
		if err := st.DeleteBlobFile(id); err != nil {
			out.Rejected = append(out.Rejected, "delete_failed:"+id)
		}
	}

	out.Status = "imported"
	out.ContentVersion = man.ContentVersion
	out.Entries = res.Entries
	out.Skipped = res.Skipped
	out.Rejected = append(out.Rejected, res.Rejected...)
	out.RemovedBlobs = len(res.RemovedBlobs)
	return out, nil
}

// readAndVerifyPack 打开 pack.sqlite 并逐条比对已验签的 manifest；任一不符即返回 error（调用方拒绝整包）。
//
// 行级校验口径（对册子 §6.2 步骤 5 的精确化）：
//   - meta 行：pack_id / content_version / merkle_root 必须等于 manifest 的同名字段；
//   - articles 行：必须存在，且 content_hash 列等于 manifest 的 content_hash，
//     且 sha256(body_md) 等于它（正文不可被换）；
//   - media_meta 行：表里**没有** content_hash 列，故按「声明块序列」比对——
//     行存在、chunk_hashes_json 的块数等于 manifest 的 chunks 数、size 等于 chunks 的 size 之和。
//     整块完整性由签名域（chunks[].blob_id + size）与补齐时的逐块哈希共同兜底。
//   - pack 里多出来的行不进 entries → 永不入库（只按 manifest 的白名单落库）。
func readAndVerifyPack(packPath string, man protocol.Manifest) ([]store.PackEntry, error) {
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(packPath)+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	meta := map[string]string{}
	rows, err := db.Query(`SELECT key,value FROM meta`)
	if err != nil {
		return nil, fmt.Errorf("读 pack meta: %w", err)
	}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			rows.Close()
			return nil, err
		}
		meta[k] = v
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if meta["pack_id"] != man.PackID {
		return nil, fmt.Errorf("pack meta pack_id=%q 与 manifest %q 不一致", meta["pack_id"], man.PackID)
	}
	if meta["content_version"] != strconv.FormatInt(man.ContentVersion, 10) {
		return nil, fmt.Errorf("pack meta content_version=%q 与 manifest %d 不一致", meta["content_version"], man.ContentVersion)
	}
	if meta["merkle_root"] != man.MerkleRoot {
		return nil, fmt.Errorf("pack meta merkle_root=%q 与 manifest %q 不一致", meta["merkle_root"], man.MerkleRoot)
	}

	type articleRow struct {
		title, digest, publishedAt, tagsJSON, bodyMD, contentHash, sourceRev string
	}
	articles := map[string]articleRow{}
	rows, err = db.Query(`SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev FROM articles`)
	if err != nil {
		return nil, fmt.Errorf("读 pack articles: %w", err)
	}
	for rows.Next() {
		var id string
		var r articleRow
		if err := rows.Scan(&id, &r.title, &r.digest, &r.publishedAt, &r.tagsJSON, &r.bodyMD, &r.contentHash, &r.sourceRev); err != nil {
			rows.Close()
			return nil, err
		}
		articles[id] = r
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	type mediaRow struct {
		mime, chunkJSON string
		size, duration  int64
		chunkSize       int64
	}
	media := map[string]mediaRow{}
	rows, err = db.Query(`SELECT item_id,mime,size,duration,chunk_size,chunk_hashes_json FROM media_meta`)
	if err != nil {
		return nil, fmt.Errorf("读 pack media_meta: %w", err)
	}
	for rows.Next() {
		var id string
		var r mediaRow
		if err := rows.Scan(&id, &r.mime, &r.size, &r.duration, &r.chunkSize, &r.chunkJSON); err != nil {
			rows.Close()
			return nil, err
		}
		media[id] = r
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]store.PackEntry, 0, len(man.Entries))
	for _, e := range man.Entries {
		base := store.PackEntry{
			ItemID: e.ItemID, Source: e.Source, Type: e.Type, Title: e.Title,
			SourceRev: e.SourceRev, ContentHash: e.ContentHash, SQLiteTable: e.SQLiteTable,
			DistClass: e.DistClass,
		}
		switch e.SQLiteTable {
		case "articles":
			r, ok := articles[e.ItemID]
			if !ok {
				return nil, fmt.Errorf("pack 缺少 manifest 声明的文章行 %s", e.ItemID)
			}
			if r.contentHash != e.ContentHash {
				return nil, fmt.Errorf("pack 行级 hash 不符 %s: %q != %q", e.ItemID, r.contentHash, e.ContentHash)
			}
			if protocol.SHA256Hex([]byte(r.bodyMD)) != e.ContentHash {
				return nil, fmt.Errorf("pack 正文哈希与 manifest 不符 %s", e.ItemID)
			}
			base.Title, base.Digest, base.PublishedAt = r.title, r.digest, r.publishedAt
			base.TagsJSON, base.BodyMD = r.tagsJSON, r.bodyMD
		case "media_meta":
			r, ok := media[e.ItemID]
			if !ok {
				return nil, fmt.Errorf("pack 缺少 manifest 声明的媒体行 %s", e.ItemID)
			}
			var hashes []string
			if err := json.Unmarshal([]byte(r.chunkJSON), &hashes); err != nil {
				return nil, fmt.Errorf("pack media_meta %s 的 chunk_hashes_json 非法: %w", e.ItemID, err)
			}
			if len(hashes) != len(e.Chunks) {
				return nil, fmt.Errorf("pack 块数不符 %s: %d != %d", e.ItemID, len(hashes), len(e.Chunks))
			}
			var sum int64
			for _, c := range e.Chunks {
				sum += c.Size
			}
			if r.size != sum {
				return nil, fmt.Errorf("pack 媒体大小不符 %s: %d != %d", e.ItemID, r.size, sum)
			}
			base.MIME, base.Size, base.Duration, base.ChunkSize = r.mime, r.size, r.duration, r.chunkSize
			base.ChunkHashes = hashes
		default:
			return nil, fmt.Errorf("manifest 条目 %s 的 sqlite_table=%q 不支持入库", e.ItemID, e.SQLiteTable)
		}
		out = append(out, base)
	}
	return out, nil
}
