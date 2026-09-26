// Package packexport 把源节点内容库导出为可分发内容包：
// packs/<pack_id>/pack.sqlite（只读分发产物）+ packs/<pack_id>/manifest.json（Ed25519 签名清单）。
package packexport

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
	_ "modernc.org/sqlite"
)

// packDDL 与 internal/store/schema.go 中这五张表的列顺序必须一致。
var packDDL = []string{
	`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS articles(
		item_id      TEXT PRIMARY KEY,
		title        TEXT NOT NULL DEFAULT '',
		digest       TEXT NOT NULL DEFAULT '',
		published_at TEXT NOT NULL DEFAULT '',
		tags_json    TEXT NOT NULL DEFAULT '[]',
		body_md      TEXT NOT NULL,
		content_hash TEXT NOT NULL,
		source_rev   TEXT NOT NULL DEFAULT ''
	)`,
	`CREATE TABLE IF NOT EXISTS segments(
		item_id      TEXT NOT NULL,
		seq          INTEGER NOT NULL,
		kind         TEXT NOT NULL DEFAULT '',
		text         TEXT NOT NULL,
		content_hash TEXT NOT NULL,
		PRIMARY KEY(item_id, seq)
	)`,
	`CREATE TABLE IF NOT EXISTS quizzes(
		item_id       TEXT PRIMARY KEY,
		question_json TEXT NOT NULL,
		content_hash  TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS media_meta(
		item_id           TEXT PRIMARY KEY,
		mime              TEXT NOT NULL DEFAULT '',
		size              INTEGER NOT NULL DEFAULT 0,
		duration          INTEGER NOT NULL DEFAULT 0,
		chunk_size        INTEGER NOT NULL DEFAULT 0,
		chunk_hashes_json TEXT NOT NULL DEFAULT '[]'
	)`,
}

// Options 是导出参数；Version 与 IssuedAt 注入固定值时导出结果确定（契约第 9 条）。
type Options struct {
	Issuer     string
	SignKeyHex string
	Version    int64     // 0 = 使用全局 content_version 计数器自增
	IssuedAt   time.Time // 零值 = 当前 UTC 时间
	PacksDir   string    // 空 = data/packs
}

// Result 是导出结果。
type Result struct {
	PackID         string
	ContentVersion int64
	MerkleRoot     string
	Entries        int
	PackPath       string
	ManifestPath   string
	PackSHA256     string
	ManifestSHA256 string
	Manifest       protocol.Manifest
}

// Export 导出并登记一个新包。
func Export(st *store.Store, opt Options) (Result, error) {
	if opt.Issuer == "" {
		return Result{}, fmt.Errorf("packexport: issuer 不能为空")
	}
	if opt.SignKeyHex == "" {
		return Result{}, fmt.Errorf("packexport: 缺少签名私钥（BASE_SIGN_KEY），无私钥不能签发内容包")
	}
	items, err := st.ListItems("active")
	if err != nil {
		return Result{}, err
	}
	for _, it := range items {
		if it.DistClass != "public" {
			return Result{}, fmt.Errorf("packexport: 条目 %s dist_class=%s，受控内容不得进入内容包", it.ItemID, it.DistClass)
		}
		if it.SQLiteTable != "articles" && it.SQLiteTable != "media_meta" {
			return Result{}, fmt.Errorf("packexport: 条目 %s 的 sqlite_table=%s 在 P0 未支持导出", it.ItemID, it.SQLiteTable)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ItemID < items[j].ItemID })

	entries := make([]protocol.Entry, 0, len(items))
	blobIDs := []string{}
	for _, it := range items {
		e := protocol.Entry{
			ItemID: it.ItemID, Source: it.Source, Type: it.Type, Title: it.Title,
			SourceRev: it.SourceRev, ContentHash: it.ContentHash, SQLiteTable: it.SQLiteTable, DistClass: it.DistClass,
		}
		if it.SQLiteTable == "media_meta" {
			// 块序列以 media_meta 的声明为准（下标即 seq）：块级去重后 blobs 行会变少，
			// 用它填 chunks 会与 chunk_hashes_json 长度不一致（契约 §4.1、验收 3）。
			refs, err := st.DeclaredChunks(it.ItemID)
			if err != nil {
				return Result{}, err
			}
			if len(refs) == 0 {
				return Result{}, fmt.Errorf("packexport: 条目 %s 没有任何块文件", it.ItemID)
			}
			for _, r := range refs {
				e.Chunks = append(e.Chunks, protocol.Chunk{BlobID: r.BlobID, Size: r.Size, Seq: r.Seq})
				blobIDs = append(blobIDs, r.BlobID)
			}
		}
		entries = append(entries, e)
	}
	merkle, err := protocol.MerkleRoot(blobIDs)
	if err != nil {
		return Result{}, err
	}

	version := opt.Version
	if version <= 0 {
		version, err = st.BumpContentVersion()
		if err != nil {
			return Result{}, err
		}
	}
	issuedAt := opt.IssuedAt
	if issuedAt.IsZero() {
		issuedAt = time.Now().UTC()
	}
	issuedAtStr := issuedAt.UTC().Format("2006-01-02T15:04:05Z")

	packID := protocol.DerivePackID(opt.Issuer, version, merkle)
	packsDir := opt.PacksDir
	if packsDir == "" {
		packsDir = st.PacksDir()
	}
	packDir := filepath.Join(packsDir, packID)
	if err := os.MkdirAll(packDir, 0o755); err != nil {
		return Result{}, err
	}
	packPath := filepath.Join(packDir, "pack.sqlite")
	if err := writePackSQLite(packPath, packID, version, merkle, entries, st); err != nil {
		return Result{}, err
	}
	packBytes, err := os.ReadFile(packPath)
	if err != nil {
		return Result{}, err
	}

	tombstones, err := st.ListTombstones()
	if err != nil {
		return Result{}, err
	}
	m := protocol.Manifest{
		PackID: packID, SchemaVersion: 1, Issuer: opt.Issuer, IssuedAt: issuedAtStr,
		ContentVersion: version, Entries: entries, Tombstone: tombstones, MerkleRoot: merkle,
	}
	if err := m.SignWith(opt.SignKeyHex); err != nil {
		return Result{}, err
	}
	manifestBytes, err := protocol.Canonicalize(m)
	if err != nil {
		return Result{}, err
	}
	manifestPath := filepath.Join(packDir, "manifest.json")
	if err := os.WriteFile(manifestPath, manifestBytes, 0o644); err != nil {
		return Result{}, err
	}
	if err := st.InsertPack(store.PackRecord{
		PackID: packID, ContentVersion: version, Dir: packDir, MerkleRoot: merkle,
		Signature: m.Signature, IssuedAt: issuedAtStr, ItemCount: len(entries),
	}); err != nil {
		return Result{}, err
	}
	return Result{
		PackID: packID, ContentVersion: version, MerkleRoot: merkle, Entries: len(entries),
		PackPath: packPath, ManifestPath: manifestPath,
		PackSHA256: protocol.SHA256Hex(packBytes), ManifestSHA256: protocol.SHA256Hex(manifestBytes),
		Manifest: m,
	}, nil
}

func writePackSQLite(path, packID string, version int64, merkle string, entries []protocol.Entry, st *store.Store) error {
	tmp := path + ".tmp"
	_ = os.Remove(tmp)
	_ = os.Remove(path)

	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(tmp)+"?_pragma=journal_mode(OFF)&_pragma=synchronous(OFF)&_pragma=page_size(4096)")
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(1)
	for _, stmt := range packDDL {
		if _, err := db.Exec(stmt); err != nil {
			_ = db.Close()
			return fmt.Errorf("packexport: pack ddl: %w", err)
		}
	}
	tx, err := db.Begin()
	if err != nil {
		_ = db.Close()
		return err
	}
	articleIDs := []string{}
	for _, e := range entries {
		if e.SQLiteTable == "articles" {
			articleIDs = append(articleIDs, e.ItemID)
		}
	}
	articles, err := st.ListArticles(articleIDs)
	if err != nil {
		_ = tx.Rollback()
		_ = db.Close()
		return err
	}
	// 按 entries 顺序写入，保证确定性
	for _, e := range entries {
		switch e.SQLiteTable {
		case "articles":
			a, ok := articles[e.ItemID]
			if !ok {
				_ = tx.Rollback()
				_ = db.Close()
				return fmt.Errorf("packexport: 条目 %s 在 articles 表缺失", e.ItemID)
			}
			if _, err := tx.Exec(`INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev)
				VALUES(?,?,?,?,?,?,?,?)`,
				a.ItemID, a.Title, a.Digest, a.PublishedAt, a.TagsJSON, a.BodyMD, a.ContentHash, a.SourceRev); err != nil {
				_ = tx.Rollback()
				_ = db.Close()
				return err
			}
		case "media_meta":
			mime, size, duration, chunkSize, chunkHashes, ok, err := st.GetMediaMeta(e.ItemID)
			if err != nil {
				_ = tx.Rollback()
				_ = db.Close()
				return err
			}
			if !ok {
				_ = tx.Rollback()
				_ = db.Close()
				return fmt.Errorf("packexport: 条目 %s 在 media_meta 表缺失", e.ItemID)
			}
			chunkJSON, err := json.Marshal(chunkHashes)
			if err != nil {
				_ = tx.Rollback()
				_ = db.Close()
				return err
			}
			if _, err := tx.Exec(`INSERT INTO media_meta(item_id,mime,size,duration,chunk_size,chunk_hashes_json)
				VALUES(?,?,?,?,?,?)`, e.ItemID, mime, size, duration, chunkSize, string(chunkJSON)); err != nil {
				_ = tx.Rollback()
				_ = db.Close()
				return err
			}
		}
	}
	for _, kv := range [][2]string{
		{"schema_version", "1"},
		{"pack_id", packID},
		{"content_version", strconv.FormatInt(version, 10)},
		{"merkle_root", merkle},
	} {
		if _, err := tx.Exec(`INSERT INTO meta(key,value) VALUES(?,?)`, kv[0], kv[1]); err != nil {
			_ = tx.Rollback()
			_ = db.Close()
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		_ = db.Close()
		return err
	}
	if err := db.Close(); err != nil {
		return err
	}

	// VACUUM INTO 产出紧凑且可复现的最终文件
	vac, err := sql.Open("sqlite", "file:"+filepath.ToSlash(tmp)+"?_pragma=journal_mode(OFF)")
	if err != nil {
		return err
	}
	vac.SetMaxOpenConns(1)
	target := strings.ReplaceAll(filepath.ToSlash(path), "'", "''")
	if _, err := vac.Exec("VACUUM INTO '" + target + "'"); err != nil {
		_ = vac.Close()
		return fmt.Errorf("packexport: vacuum into: %w", err)
	}
	if err := vac.Close(); err != nil {
		return err
	}
	return os.Remove(tmp)
}
