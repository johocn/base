package store

import (
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/johocn/base/internal/protocol"
)

// Segment 是 segments 表的一行（册子 §3.1）。
// seq=0 固定留给简介（kind=digest），seq>=1 固定为子项清单；text 是子项的 item_id。
type Segment struct {
	ItemID      string
	Seq         int
	Kind        string
	Text        string
	ContentHash string
}

// SegmentItem 是一个待写入的 segments 类条目（course 或 lesson 容器）。
// Segments 必须按 seq 升序、seq 从 0 起连续；缺简介时可省略 seq=0，子项仍从 1 起。
type SegmentItem struct {
	ItemID    string
	Source    string // course | lesson
	Type      string // course | lesson
	Title     string
	Segments  []Segment
	UpdatedAt string
}

// SegmentsContentHash 是条目级 content_hash：按 seq 升序拼接 "<kind>\t<text>\n" 的 UTF-8 字节（册子 §3.3）。
// 拼接形状写死是确定性导出的前提，勿改。
func SegmentsContentHash(segs []Segment) string {
	ordered := append([]Segment{}, segs...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Seq < ordered[j].Seq })
	var b strings.Builder
	for _, s := range ordered {
		b.WriteString(s.Kind)
		b.WriteByte('\t')
		b.WriteString(s.Text)
		b.WriteByte('\n')
	}
	return protocol.SHA256Hex([]byte(b.String()))
}

// UpsertSegmentItem 幂等写入一个容器条目（items + segments 同事务）：
// 先 upsert items，再删同 item_id 的旧 segments 行，最后按 seq 升序逐行写入。
func (s *Store) UpsertSegmentItem(it SegmentItem) error {
	if strings.TrimSpace(it.ItemID) == "" {
		return fmt.Errorf("store: segment item_id 不能为空")
	}
	ordered := append([]Segment{}, it.Segments...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Seq < ordered[j].Seq })
	hash := SegmentsContentHash(ordered)
	updated := it.UpdatedAt
	if updated == "" {
		updated = nowUTC()
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
		VALUES(?,?,?,?,?,?,?,'public','active',?)
		ON CONFLICT(item_id) DO UPDATE SET
			source=excluded.source, type=excluded.type, title=excluded.title, source_rev=excluded.source_rev,
			content_hash=excluded.content_hash, sqlite_table=excluded.sqlite_table,
			dist_class=excluded.dist_class, state=excluded.state, updated_at=excluded.updated_at`,
		it.ItemID, it.Source, it.Type, it.Title, hash[:16], hash, "segments", updated); err != nil {
		return fmt.Errorf("store: upsert segment item: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM segments WHERE item_id=?`, it.ItemID); err != nil {
		return fmt.Errorf("store: 清旧 segments: %w", err)
	}
	for _, seg := range ordered {
		if _, err := tx.Exec(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`,
			it.ItemID, seg.Seq, seg.Kind, seg.Text, protocol.SHA256Hex([]byte(seg.Text))); err != nil {
			return fmt.Errorf("store: 写 segments %s seq=%d: %w", it.ItemID, seg.Seq, err)
		}
	}
	return tx.Commit()
}

// ListSegments 按 seq 升序返回某条目的 segments 行。
func (s *Store) ListSegments(itemID string) ([]Segment, error) {
	rows, err := s.db.Query(`SELECT item_id,seq,kind,text,content_hash FROM segments WHERE item_id=? ORDER BY seq ASC`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Segment{}
	for rows.Next() {
		var seg Segment
		if err := rows.Scan(&seg.ItemID, &seg.Seq, &seg.Kind, &seg.Text, &seg.ContentHash); err != nil {
			return nil, err
		}
		out = append(out, seg)
	}
	return out, rows.Err()
}

// RetireItem 退役一个条目：写墓碑（revoked_rev 取大值覆盖）并置 state='removed'（册子 §2.2）。
// 只置状态不删行：内容行与块文件保留在源节点，旧条目自此不进 active 列表、不参与导出；
// 接收侧按 manifest 里的墓碑走既有删除路径。
func (s *Store) RetireItem(itemID string, revokedRev int64) error {
	return retireItemExec(s.db, itemID, revokedRev)
}

// retireItemExec 是 RetireItem 的语句本体，供 *sql.Tx 复用（治理册 §4.4 的生效事务）。
func retireItemExec(e sqlExec, itemID string, revokedRev int64) error {
	if _, err := e.Exec(`INSERT INTO tombstones(item_id,revoked_rev) VALUES(?,?)
		ON CONFLICT(item_id) DO UPDATE SET revoked_rev=MAX(revoked_rev,excluded.revoked_rev)`, itemID, revokedRev); err != nil {
		return fmt.Errorf("store: 退役写墓碑 %s: %w", itemID, err)
	}
	if _, err := e.Exec(`UPDATE items SET state='removed' WHERE item_id=?`, itemID); err != nil {
		return fmt.Errorf("store: 退役置状态 %s: %w", itemID, err)
	}
	return nil
}

// NextContentVersion 返回下一次导出将使用的全局 content_version（只读，不递增）。
// 用于把「退役生效版本」与紧随其后的那次导出版本对齐（册子 §2.2）。
func (s *Store) NextContentVersion() (int64, error) {
	return nextContentVersionExec(s.db)
}

// nextContentVersionExec 是 NextContentVersion 的语句本体，供 *sql.Tx 复用。
func nextContentVersionExec(e sqlExec) (int64, error) {
	var raw string
	err := e.QueryRow(`SELECT value FROM meta WHERE key=?`, metaContentVersion).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return 1, nil
	}
	if err != nil {
		return 0, err
	}
	cur, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("store: bad content_version %q", raw)
	}
	return cur + 1, nil
}
