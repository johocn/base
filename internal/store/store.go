package store

import (
	"crypto/cipher"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/johocn/base/internal/protocol"
	_ "modernc.org/sqlite"
)

const (
	metaContentVersion = "content_version"
)

// Store 是内容库（SQLite + 块文件目录）访问层。
type Store struct {
	db           *sql.DB
	dataDir      string
	storeKey     []byte
	storeKeyPath string
	aead         cipher.AEAD
}

// Item 是目录条目（catalog 的数据来源）。
type Item struct {
	ItemID      string
	Source      string
	Type        string
	Title       string
	SourceRev   string
	ContentHash string
	SQLiteTable string
	DistClass   string
	State       string
	UpdatedAt   string
}

// Article 是文章条目。
type Article struct {
	ItemID      string
	Title       string
	Digest      string
	PublishedAt string
	TagsJSON    string
	BodyMD      string
	ContentHash string
	SourceRev   string
	UpdatedAt   string
}

// MediaItem 是带外部字节的条目（type=cover / video）。
type MediaItem struct {
	ItemID      string
	Source      string
	Type        string
	Title       string
	SourceRev   string
	ContentHash string
	SQLiteTable string
	MIME        string
	Size        int64
	Duration    int64
	ChunkSize   int64
	ChunkHashes []string
	UpdatedAt   string
}

// BlobRef 是条目的一个块引用。
type BlobRef struct {
	BlobID string
	Seq    int
	Size   int64
	ItemID string
}

// PackRecord 是已发布包的登记。
type PackRecord struct {
	PackID         string
	ContentVersion int64
	Dir            string
	MerkleRoot     string
	Signature      string
	IssuedAt       string
	ItemCount      int
	CreatedAt      string
}

// Open 打开/创建数据目录下的内容库。
func Open(dataDir string, opts ...Option) (*Store, error) {
	cfg := openConfig{}
	for _, opt := range opts {
		if opt == nil {
			continue
		}
		if err := opt(&cfg); err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(filepath.Join(dataDir, "blobs"), 0o755); err != nil {
		return nil, fmt.Errorf("store: mkdir blobs: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, "packs"), 0o755); err != nil {
		return nil, fmt.Errorf("store: mkdir packs: %w", err)
	}
	key, keyPath, err := loadStoreKey(dataDir, cfg)
	if err != nil {
		return nil, err
	}
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	dbPath := filepath.Join(dataDir, "base.db")
	dsn := "file:" + filepath.ToSlash(dbPath) + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("store: open: %w", err)
	}
	db.SetMaxOpenConns(1)
	st := &Store{db: db, dataDir: dataDir, storeKey: key, storeKeyPath: keyPath, aead: aead}
	for _, stmt := range schemaStatements {
		if _, err := db.Exec(stmt); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("store: schema: %w", err)
		}
	}
	return st, nil
}

// Close 关闭内容库。
func (s *Store) Close() error { return s.db.Close() }

// DataDir 返回数据目录。
func (s *Store) DataDir() string { return s.dataDir }

// PacksDir 返回已发布包目录。
func (s *Store) PacksDir() string { return filepath.Join(s.dataDir, "packs") }

// BlobPath 返回块文件路径（契约第 10 条）。
// 用 ToSlash 归一为正斜杠，保证同一实现在 Windows/Linux 上产出完全一致的路径字符串；
// Windows 的文件 API 同样接受正斜杠（filepath.Dir/os.Stat/os.WriteFile 均正常）。
func (s *Store) BlobPath(blobID string) string {
	return filepath.ToSlash(filepath.Join(s.dataDir, "blobs", blobID[0:2], blobID[2:4], blobID))
}

func nowUTC() string { return time.Now().UTC().Format(time.RFC3339) }

// UpsertArticle 幂等写入文章（items + articles 同事务）。
func (s *Store) UpsertArticle(a Article) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	updated := a.UpdatedAt
	if updated == "" {
		updated = nowUTC()
	}
	if _, err := tx.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			title=excluded.title, source_rev=excluded.source_rev, content_hash=excluded.content_hash,
			sqlite_table=excluded.sqlite_table, dist_class=excluded.dist_class, state=excluded.state, updated_at=excluded.updated_at`,
		a.ItemID, "article", "article", a.Title, a.SourceRev, a.ContentHash, "articles", "public", "active", updated); err != nil {
		return fmt.Errorf("store: upsert item: %w", err)
	}
	bodyEnc, err := s.encText(a.BodyMD)
	if err != nil {
		return fmt.Errorf("store: encrypt body_md: %w", err)
	}
	if _, err := tx.Exec(`INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev)
		VALUES(?,?,?,?,?,?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			title=excluded.title, digest=excluded.digest, published_at=excluded.published_at,
			tags_json=excluded.tags_json, body_md=excluded.body_md, content_hash=excluded.content_hash, source_rev=excluded.source_rev`,
		a.ItemID, a.Title, a.Digest, a.PublishedAt, a.TagsJSON, bodyEnc, a.ContentHash, a.SourceRev); err != nil {
		return fmt.Errorf("store: upsert article: %w", err)
	}
	return tx.Commit()
}

// UpsertMediaItem 幂等写入带外部字节的条目（items + media_meta 同事务）。
func (s *Store) UpsertMediaItem(m MediaItem) error {
	chunkHashes := m.ChunkHashes
	if chunkHashes == nil {
		chunkHashes = []string{}
	}
	chunkJSON, err := json.Marshal(chunkHashes)
	if err != nil {
		return err
	}
	updated := m.UpdatedAt
	if updated == "" {
		updated = nowUTC()
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			source=excluded.source, type=excluded.type, title=excluded.title, source_rev=excluded.source_rev,
			content_hash=excluded.content_hash, sqlite_table=excluded.sqlite_table, dist_class=excluded.dist_class,
			state=excluded.state, updated_at=excluded.updated_at`,
		m.ItemID, m.Source, m.Type, m.Title, m.SourceRev, m.ContentHash, "media_meta", "public", "active", updated); err != nil {
		return fmt.Errorf("store: upsert media item: %w", err)
	}
	if _, err := tx.Exec(`INSERT INTO media_meta(item_id,mime,size,duration,chunk_size,chunk_hashes_json)
		VALUES(?,?,?,?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			mime=excluded.mime, size=excluded.size, duration=excluded.duration,
			chunk_size=excluded.chunk_size, chunk_hashes_json=excluded.chunk_hashes_json`,
		m.ItemID, m.MIME, m.Size, m.Duration, m.ChunkSize, string(chunkJSON)); err != nil {
		return fmt.Errorf("store: upsert media_meta: %w", err)
	}
	return tx.Commit()
}

// PutBlob 写入块文件并登记。
// blob_id 在**明文**上校验；落盘的是密文（L4a′）；blobs.size 记明文长度。
func (s *Store) PutBlob(blobID string, data []byte, itemID string, seq int) error {
	if !protocol.IsBlobID(blobID) {
		return fmt.Errorf("store: invalid blob id %q", blobID)
	}
	if got := protocol.BlobID(data); got != blobID {
		return fmt.Errorf("store: blob id mismatch: %s != %s", got, blobID)
	}
	enc, err := s.Encrypt(data)
	if err != nil {
		return fmt.Errorf("store: encrypt blob %s: %w", blobID, err)
	}
	p := s.BlobPath(blobID)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(p, enc, 0o644); err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO blobs(blob_id,size,item_id,seq,created_at) VALUES(?,?,?,?,?)
		ON CONFLICT(blob_id) DO UPDATE SET item_id=excluded.item_id, seq=excluded.seq`,
		blobID, int64(len(data)), itemID, seq, nowUTC())
	return err
}

// HasBlob 返回块是否存在及其**明文**大小。
// size 必须取自 blobs 表：磁盘文件是密文，比明文多 28 字节（nonce 12 + tag 16），
// 用 os.Stat 会让 HEAD /v1/blob/:id 的 Content-Length 多 28，改变既定接口语义。
func (s *Store) HasBlob(blobID string) (bool, int64, error) {
	if !protocol.IsBlobID(blobID) {
		return false, 0, fmt.Errorf("store: invalid blob id %q", blobID)
	}
	var size int64
	err := s.db.QueryRow(`SELECT size FROM blobs WHERE blob_id=?`, blobID).Scan(&size)
	if errors.Is(err, sql.ErrNoRows) {
		return false, 0, nil
	}
	if err != nil {
		return false, 0, err
	}
	if _, err := os.Stat(s.BlobPath(blobID)); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, 0, nil
		}
		return false, 0, err
	}
	return true, size, nil
}

// GetBlobBytes 读取块文件并解密，返回明文。
func (s *Store) GetBlobBytes(blobID string) ([]byte, error) {
	if !protocol.IsBlobID(blobID) {
		return nil, fmt.Errorf("store: invalid blob id %q", blobID)
	}
	raw, err := os.ReadFile(s.BlobPath(blobID))
	if err != nil {
		return nil, err
	}
	plain, err := s.Decrypt(raw)
	if err != nil {
		return nil, fmt.Errorf("store: decrypt blob %s: %w", blobID, err)
	}
	return plain, nil
}

// GetItem 读取目录条目。
func (s *Store) GetItem(itemID string) (Item, bool, error) {
	row := s.db.QueryRow(`SELECT item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at
		FROM items WHERE item_id=?`, itemID)
	it, err := scanItem(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Item{}, false, nil
	}
	if err != nil {
		return Item{}, false, err
	}
	return it, true, nil
}

// ListItems 按 item_id 升序返回指定状态的条目；state 为空表示全部。
func (s *Store) ListItems(state string) ([]Item, error) {
	q := `SELECT item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at FROM items`
	args := []any{}
	if state != "" {
		q += ` WHERE state=?`
		args = append(args, state)
	}
	q += ` ORDER BY item_id ASC`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanItems(rows)
}

// ListItemsPage 按 cursor（独占）分页返回条目，next 为空表示没有下一页。
func (s *Store) ListItemsPage(cursor string, limit int) ([]Item, string, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := s.db.Query(`SELECT item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at
		FROM items WHERE item_id > ? ORDER BY item_id ASC LIMIT ?`, cursor, limit)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	items, err := scanItems(rows)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(items) == limit {
		next = items[len(items)-1].ItemID
	}
	return items, next, nil
}

func scanItem(row interface{ Scan(...any) error }) (Item, error) {
	var it Item
	err := row.Scan(&it.ItemID, &it.Source, &it.Type, &it.Title, &it.SourceRev, &it.ContentHash,
		&it.SQLiteTable, &it.DistClass, &it.State, &it.UpdatedAt)
	return it, err
}

func scanItems(rows *sql.Rows) ([]Item, error) {
	out := []Item{}
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// GetArticle 读取文章。
func (s *Store) GetArticle(itemID string) (Article, bool, error) {
	row := s.db.QueryRow(`SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev
		FROM articles WHERE item_id=?`, itemID)
	var a Article
	err := row.Scan(&a.ItemID, &a.Title, &a.Digest, &a.PublishedAt, &a.TagsJSON, &a.BodyMD, &a.ContentHash, &a.SourceRev)
	if errors.Is(err, sql.ErrNoRows) {
		return Article{}, false, nil
	}
	if err != nil {
		return Article{}, false, err
	}
	body, err := s.decText(a.BodyMD)
	if err != nil {
		return Article{}, false, fmt.Errorf("store: decrypt body_md %s: %w", itemID, err)
	}
	a.BodyMD = body
	return a, true, nil
}

// ListArticles 返回指定 id 的文章；ids 为空表示全部。
func (s *Store) ListArticles(ids []string) (map[string]Article, error) {
	q := `SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev FROM articles`
	args := []any{}
	if len(ids) > 0 {
		q += ` WHERE item_id IN (` + placeholders(len(ids)) + `)`
		for _, id := range ids {
			args = append(args, id)
		}
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Article{}
	for rows.Next() {
		var a Article
		if err := rows.Scan(&a.ItemID, &a.Title, &a.Digest, &a.PublishedAt, &a.TagsJSON, &a.BodyMD, &a.ContentHash, &a.SourceRev); err != nil {
			return nil, err
		}
		body, err := s.decText(a.BodyMD)
		if err != nil {
			return nil, fmt.Errorf("store: decrypt body_md %s: %w", a.ItemID, err)
		}
		a.BodyMD = body
		out[a.ItemID] = a
	}
	return out, rows.Err()
}

// GetMediaMeta 读取 media_meta。
func (s *Store) GetMediaMeta(itemID string) (mime string, size, duration, chunkSize int64, chunkHashes []string, ok bool, err error) {
	var chunkJSON string
	row := s.db.QueryRow(`SELECT mime,size,duration,chunk_size,chunk_hashes_json FROM media_meta WHERE item_id=?`, itemID)
	scanErr := row.Scan(&mime, &size, &duration, &chunkSize, &chunkJSON)
	if errors.Is(scanErr, sql.ErrNoRows) {
		return "", 0, 0, 0, nil, false, nil
	}
	if scanErr != nil {
		return "", 0, 0, 0, nil, false, scanErr
	}
	if err := json.Unmarshal([]byte(chunkJSON), &chunkHashes); err != nil {
		return "", 0, 0, 0, nil, false, err
	}
	return mime, size, duration, chunkSize, chunkHashes, true, nil
}

// ListBlobsForItem 返回条目的块引用（按 seq 升序）。
func (s *Store) ListBlobsForItem(itemID string) ([]BlobRef, error) {
	rows, err := s.db.Query(`SELECT blob_id,seq,size FROM blobs WHERE item_id=? ORDER BY seq ASC`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BlobRef{}
	for rows.Next() {
		var b BlobRef
		if err := rows.Scan(&b.BlobID, &b.Seq, &b.Size); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// MetaString 读取 meta；不存在时返回 def。
func (s *Store) MetaString(key, def string) string {
	var v string
	if err := s.db.QueryRow(`SELECT value FROM meta WHERE key=?`, key).Scan(&v); err != nil {
		return def
	}
	return v
}

// SetMeta 写入 meta。
func (s *Store) SetMeta(key, value string) error {
	_, err := s.db.Exec(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

// BumpContentVersion 递增并返回全局 content_version（从 1 开始）。
func (s *Store) BumpContentVersion() (int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	cur := int64(0)
	var raw string
	err = tx.QueryRow(`SELECT value FROM meta WHERE key=?`, metaContentVersion).Scan(&raw)
	if err == nil {
		cur, err = strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("store: bad content_version %q", raw)
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	next := cur + 1
	if _, err := tx.Exec(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
		metaContentVersion, strconv.FormatInt(next, 10)); err != nil {
		return 0, err
	}
	return next, tx.Commit()
}

// InsertPack 登记已发布包（同 pack_id 覆盖）。
func (s *Store) InsertPack(rec PackRecord) error {
	if rec.CreatedAt == "" {
		rec.CreatedAt = nowUTC()
	}
	_, err := s.db.Exec(`INSERT INTO packs(pack_id,content_version,dir,merkle_root,signature,issued_at,item_count,created_at)
		VALUES(?,?,?,?,?,?,?,?)
		ON CONFLICT(pack_id) DO UPDATE SET
			content_version=excluded.content_version, dir=excluded.dir, merkle_root=excluded.merkle_root,
			signature=excluded.signature, issued_at=excluded.issued_at, item_count=excluded.item_count`,
		rec.PackID, rec.ContentVersion, rec.Dir, rec.MerkleRoot, rec.Signature, rec.IssuedAt, rec.ItemCount, rec.CreatedAt)
	return err
}

// GetPack 读取包登记。
func (s *Store) GetPack(packID string) (PackRecord, bool, error) {
	row := s.db.QueryRow(`SELECT pack_id,content_version,dir,merkle_root,signature,issued_at,item_count,created_at
		FROM packs WHERE pack_id=?`, packID)
	rec, err := scanPack(row)
	if errors.Is(err, sql.ErrNoRows) {
		return PackRecord{}, false, nil
	}
	if err != nil {
		return PackRecord{}, false, err
	}
	return rec, true, nil
}

// LatestPack 返回 content_version 最大的包登记。
func (s *Store) LatestPack() (PackRecord, bool, error) {
	row := s.db.QueryRow(`SELECT pack_id,content_version,dir,merkle_root,signature,issued_at,item_count,created_at
		FROM packs ORDER BY content_version DESC, created_at DESC LIMIT 1`)
	rec, err := scanPack(row)
	if errors.Is(err, sql.ErrNoRows) {
		return PackRecord{}, false, nil
	}
	if err != nil {
		return PackRecord{}, false, err
	}
	return rec, true, nil
}

func scanPack(row interface{ Scan(...any) error }) (PackRecord, error) {
	var rec PackRecord
	err := row.Scan(&rec.PackID, &rec.ContentVersion, &rec.Dir, &rec.MerkleRoot, &rec.Signature,
		&rec.IssuedAt, &rec.ItemCount, &rec.CreatedAt)
	return rec, err
}

// AddTombstone 记录撤回。
func (s *Store) AddTombstone(itemID string, revokedRev int) error {
	_, err := s.db.Exec(`INSERT INTO tombstones(item_id,revoked_rev) VALUES(?,?)
		ON CONFLICT(item_id) DO UPDATE SET revoked_rev=excluded.revoked_rev`, itemID, revokedRev)
	return err
}

// ListTombstones 返回全部撤回记录（按 item_id 升序）。
func (s *Store) ListTombstones() ([]protocol.Tombstone, error) {
	rows, err := s.db.Query(`SELECT item_id,revoked_rev FROM tombstones ORDER BY item_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []protocol.Tombstone{}
	for rows.Next() {
		var t protocol.Tombstone
		if err := rows.Scan(&t.ItemID, &t.RevokedRev); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}
