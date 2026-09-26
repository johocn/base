package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/johocn/base/internal/protocol"
)

// PackEntry 是已通过 manifest 与 pack 行级校验、待入库的条目行。
// 只承载 P0 真实存在的两族：articles（文章）与 media_meta（带外部字节的条目）。
type PackEntry struct {
	ItemID      string
	Source      string
	Type        string
	Title       string
	SourceRev   string
	ContentHash string
	SQLiteTable string
	DistClass   string
	UpdatedAt   string

	// SQLiteTable == "articles"
	Digest      string
	PublishedAt string
	TagsJSON    string
	BodyMD      string

	// SQLiteTable == "media_meta"
	MIME        string
	Size        int64
	Duration    int64
	ChunkSize   int64
	ChunkHashes []string
}

// ImportResult 是一次包入库的结果。
type ImportResult struct {
	Version      int64
	Entries      int      // 真正写入的条目数
	Skipped      int      // dist_class != public，跳过入库（册子 §6.2 步骤 5 的双保险）
	Rejected     []string // 防回卷拒绝的 item_id
	RemovedBlobs []string // 墓碑连带清掉的 blob_id；调用方提交后负责删文件（修正 5）
}

// ImportPack 在一个事务内应用墓碑并 upsert 条目（册子 §6.2 步骤 5、§9.2）。
// 调用方必须在事务外做完一切跨节点判断（manifest 验签、pack 行级比对）——本函数不做任何这类判断。
//
//  1. 墓碑先落地（revoked_rev 取大值覆盖），并连带删 items / articles / media_meta / blobs 行；
//     块文件本体不在事务里删，调用方拿 RemovedBlobs 在提交后删。
//  2. 条目入库前做防回卷检查：该 item_id 已有墓碑且 revoked_rev >= 本包 version → 拒该条目。
//  3. content_version 以包版本号覆盖写。
func (s *Store) ImportPack(version int64, entries []PackEntry, tombstones []protocol.Tombstone) (ImportResult, error) {
	res := ImportResult{Version: version, Rejected: []string{}, RemovedBlobs: []string{}}
	tx, err := s.db.Begin()
	if err != nil {
		return res, err
	}
	defer func() { _ = tx.Rollback() }()

	for _, t := range tombstones {
		if _, err := tx.Exec(`INSERT INTO tombstones(item_id,revoked_rev) VALUES(?,?)
			ON CONFLICT(item_id) DO UPDATE SET revoked_rev=MAX(revoked_rev,excluded.revoked_rev)`,
			t.ItemID, t.RevokedRev); err != nil {
			return res, fmt.Errorf("store: 应用墓碑 %s: %w", t.ItemID, err)
		}
		ids, err := blobIDsOfItemTx(tx, t.ItemID)
		if err != nil {
			return res, err
		}
		res.RemovedBlobs = append(res.RemovedBlobs, ids...)
		for _, q := range []string{
			`DELETE FROM media_meta WHERE item_id=?`,
			`DELETE FROM articles WHERE item_id=?`,
			`DELETE FROM items WHERE item_id=?`,
			`DELETE FROM blobs WHERE item_id=?`,
		} {
			if _, err := tx.Exec(q, t.ItemID); err != nil {
				return res, fmt.Errorf("store: 墓碑清理 %s: %w", t.ItemID, err)
			}
		}
	}

	for _, e := range entries {
		if e.DistClass != "" && e.DistClass != "public" {
			res.Skipped++
			continue
		}
		revoked, err := revokedRevOfTx(tx, e.ItemID)
		if err != nil {
			return res, err
		}
		if revoked > 0 && int64(revoked) >= version {
			res.Rejected = append(res.Rejected, e.ItemID)
			continue
		}
		updated := e.UpdatedAt
		if updated == "" {
			updated = nowUTC()
		}
		if _, err := tx.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
			VALUES(?,?,?,?,?,?,?,'public','active',?)
			ON CONFLICT(item_id) DO UPDATE SET
				source=excluded.source, type=excluded.type, title=excluded.title, source_rev=excluded.source_rev,
				content_hash=excluded.content_hash, sqlite_table=excluded.sqlite_table,
				dist_class=excluded.dist_class, state=excluded.state, updated_at=excluded.updated_at`,
			e.ItemID, e.Source, e.Type, e.Title, e.SourceRev, e.ContentHash, e.SQLiteTable, updated); err != nil {
			return res, fmt.Errorf("store: 入库 items %s: %w", e.ItemID, err)
		}
		switch e.SQLiteTable {
		case "articles":
			bodyEnc, err := s.encText(e.BodyMD)
			if err != nil {
				return res, fmt.Errorf("store: 加密 %s 正文: %w", e.ItemID, err)
			}
			if _, err := tx.Exec(`INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev)
				VALUES(?,?,?,?,?,?,?,?)
				ON CONFLICT(item_id) DO UPDATE SET
					title=excluded.title, digest=excluded.digest, published_at=excluded.published_at,
					tags_json=excluded.tags_json, body_md=excluded.body_md,
					content_hash=excluded.content_hash, source_rev=excluded.source_rev`,
				e.ItemID, e.Title, e.Digest, e.PublishedAt, e.TagsJSON, bodyEnc, e.ContentHash, e.SourceRev); err != nil {
				return res, fmt.Errorf("store: 入库 articles %s: %w", e.ItemID, err)
			}
		case "media_meta":
			hashes := e.ChunkHashes
			if hashes == nil {
				hashes = []string{}
			}
			chunkJSON, err := json.Marshal(hashes)
			if err != nil {
				return res, err
			}
			if _, err := tx.Exec(`INSERT INTO media_meta(item_id,mime,size,duration,chunk_size,chunk_hashes_json)
				VALUES(?,?,?,?,?,?)
				ON CONFLICT(item_id) DO UPDATE SET
					mime=excluded.mime, size=excluded.size, duration=excluded.duration,
					chunk_size=excluded.chunk_size, chunk_hashes_json=excluded.chunk_hashes_json`,
				e.ItemID, e.MIME, e.Size, e.Duration, e.ChunkSize, string(chunkJSON)); err != nil {
				return res, fmt.Errorf("store: 入库 media_meta %s: %w", e.ItemID, err)
			}
		default:
			return res, fmt.Errorf("store: 条目 %s 的 sqlite_table=%s 不支持入库", e.ItemID, e.SQLiteTable)
		}
		res.Entries++
	}

	if _, err := tx.Exec(`INSERT INTO meta(key,value) VALUES('content_version',?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, strconv.FormatInt(version, 10)); err != nil {
		return res, fmt.Errorf("store: 写 content_version: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return res, err
	}
	return res, nil
}

func blobIDsOfItemTx(tx *sql.Tx, itemID string) ([]string, error) {
	rows, err := tx.Query(`SELECT blob_id FROM blobs WHERE item_id=?`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func revokedRevOfTx(tx *sql.Tx, itemID string) (int, error) {
	var rev int
	err := tx.QueryRow(`SELECT revoked_rev FROM tombstones WHERE item_id=?`, itemID).Scan(&rev)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return rev, err
}
