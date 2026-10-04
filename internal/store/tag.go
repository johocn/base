package store

import (
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/johocn/base/internal/protocol"
)

// ErrTagTargetTagged 表示直打涉及的某个目标**已有标签**（册子 §3.4）：
// 整体拒绝、不部分生效、不自动合并，人读文案引导走治理提案。
var ErrTagTargetTagged = errors.New("store: tag target already tagged")

// TagLink 是 tag_links 的一行（册子 §3.2）。
type TagLink struct {
	TagID    string
	TargetID string
	Kind     string // course | lesson | article | comment
}

// TagSubmission 是一条标签直打（册子 §3.4）。
type TagSubmission struct {
	TagID     string
	Title     string // 由调用方按 protocol.TagTitle 重建好
	Links     []TagLink
	AuthorID  string
	AuthorSig string
	UpdatedAt string
}

// tagKindRank 是物化 segments 行的 kind 固定序（册子 §3.3）。
func tagKindRank(kind string) int {
	for i, k := range []string{"course", "lesson", "article", "quiz", "comment"} {
		if k == kind {
			return i
		}
	}
	return 5
}

// MaterializeTagSegments 把关联集物化成 segments 行（册子 §3.3）：seq 从 1 起，
// 先按 kind 固定序 course < lesson < article < comment，同 kind 内按 target_id 字典序升序。
// 同一 target_id 只保留一行（tag_links 的主键是 (tag_id,target_id)，重复由写入面拒绝，这里是防御）。
func MaterializeTagSegments(tagID string, links []TagLink) []Segment {
	ordered := append([]TagLink{}, links...)
	sort.Slice(ordered, func(i, j int) bool {
		ri, rj := tagKindRank(ordered[i].Kind), tagKindRank(ordered[j].Kind)
		if ri != rj {
			return ri < rj
		}
		return ordered[i].TargetID < ordered[j].TargetID
	})
	segs := make([]Segment, 0, len(ordered))
	seen := map[string]bool{}
	for _, l := range ordered {
		if seen[l.TargetID] {
			continue
		}
		seen[l.TargetID] = true
		segs = append(segs, Segment{ItemID: tagID, Seq: len(segs) + 1, Kind: l.Kind, Text: l.TargetID})
	}
	return segs
}

// replaceTagLinksTx 全量替换一个标签的关联集，返回新的**条目级** content_hash。
// 这是直打（§3.4）与提案生效（§3.5）**共用的唯一写函数**：删旧 tag_links 行 → 写新行 →
// 重算物化 segments 行。只碰 tag_links 与 segments，**不碰 items**——items 的归属列由两个调用方各自决定。
func replaceTagLinksTx(tx *sql.Tx, tagID string, links []TagLink) (string, error) {
	if _, err := tx.Exec(`DELETE FROM tag_links WHERE tag_id=?`, tagID); err != nil {
		return "", fmt.Errorf("store: 清旧 tag_links %s: %w", tagID, err)
	}
	segs := MaterializeTagSegments(tagID, links)
	for _, s := range segs {
		if _, err := tx.Exec(`INSERT INTO tag_links(tag_id,target_id,kind,created_at) VALUES(?,?,?,?)`,
			tagID, s.Text, s.Kind, nowUTC()); err != nil {
			return "", fmt.Errorf("store: 写 tag_links %s→%s: %w", tagID, s.Text, err)
		}
	}
	if _, err := tx.Exec(`DELETE FROM segments WHERE item_id=? AND seq>=1`, tagID); err != nil {
		return "", fmt.Errorf("store: 清旧 segments %s: %w", tagID, err)
	}
	for _, s := range segs {
		if _, err := tx.Exec(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`,
			tagID, s.Seq, s.Kind, s.Text, protocol.SHA256Hex([]byte(s.Text))); err != nil {
			return "", fmt.Errorf("store: 写 segments %s seq=%d: %w", tagID, s.Seq, err)
		}
	}
	return SegmentsContentHash(segs), nil
}

// UpsertTagSubmission 写入/更新一条标签直打（items + tag_links + segments 同事务）。
// 占用判定与 #25 同口径（只看 items.author_id，空归属存量条目也拒）；直打条件见册子 §3.4。
func (s *Store) UpsertTagSubmission(sub TagSubmission) (created bool, err error) {
	updated := sub.UpdatedAt
	if updated == "" {
		updated = nowUTC()
	}
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()

	var cur string
	switch err := tx.QueryRow(`SELECT author_id FROM items WHERE item_id=?`, sub.TagID).Scan(&cur); {
	case errors.Is(err, sql.ErrNoRows):
		created = true
	case err != nil:
		return false, err
	case cur != sub.AuthorID:
		return false, ErrItemTaken
	}
	// 直打条件（册子 §3.4）：本次涉及的**每一个**目标当前都不得被**别的标签**占用。
	// 排除自身（tag_id<>?）是为了让同标签的重试/全量替换幂等：
	// 其余标签已占用该目标 → 整体拒绝（ErrTagTargetTagged），不部分生效、不合并。
	for _, l := range sub.Links {
		var n int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM tag_links WHERE target_id=? AND tag_id<>?`, l.TargetID, sub.TagID).Scan(&n); err != nil {
			return false, err
		}
		if n > 0 {
			return false, ErrTagTargetTagged
		}
	}
	hash, err := replaceTagLinksTx(tx, sub.TagID, sub.Links)
	if err != nil {
		return false, err
	}
	// ON CONFLICT 刻意不写 state / dist_class：墓碑条目保持其 state（与 #25 同口径）。
	if _, err := tx.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
		VALUES(?,?,?,?,?,?,?,'public','active',?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			title=excluded.title, source_rev=excluded.source_rev, content_hash=excluded.content_hash,
			updated_at=excluded.updated_at, author_id=excluded.author_id, author_sig=excluded.author_sig`,
		sub.TagID, "tag", "tag", sub.Title, hash[:16], hash, "segments", updated, sub.AuthorID, sub.AuthorSig); err != nil {
		return false, fmt.Errorf("store: upsert tag item: %w", err)
	}
	return created, tx.Commit()
}

// ListTagLinks 按 (kind 固定序, target_id 升序) 返回一个标签的关联集（§3.3 的渲染序）。
func (s *Store) ListTagLinks(tagID string) ([]TagLink, error) {
	rows, err := s.db.Query(`SELECT tag_id,target_id,kind FROM tag_links WHERE tag_id=?`, tagID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TagLink{}
	for rows.Next() {
		var l TagLink
		if err := rows.Scan(&l.TagID, &l.TargetID, &l.Kind); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sortTagLinks(out)
	return out, nil
}

// ListTagsOf 反查：指向某目标的全部 tag_id（升序）。悬空引用（标签条目已退役）由调用方过滤。
func (s *Store) ListTagsOf(targetID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT tag_id FROM tag_links WHERE target_id=? ORDER BY tag_id ASC`, targetID)
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

// HasCommentEvent 判定 event_id 是否为本节点已收到的 comment.v1 事件（册子 §3.2）。
// 硬过滤 type='comment.v1'：② 类（group.v1 / dm.v1）由此**天然被排除**（§3.7 红线）。
func (s *Store) HasCommentEvent(eventID string) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM events WHERE type='comment.v1' AND event_id=?`, eventID).Scan(&n)
	return n > 0, err
}

// sortTagLinks 按 §3.3 的渲染序就地排序。
func sortTagLinks(links []TagLink) {
	sort.Slice(links, func(i, j int) bool {
		ri, rj := tagKindRank(links[i].Kind), tagKindRank(links[j].Kind)
		if ri != rj {
			return ri < rj
		}
		return links[i].TargetID < links[j].TargetID
	})
}

// listSegmentsTx 是 ListSegments 的事务内版本（导入回填要在同一事务里读自己的写入）。
func listSegmentsTx(tx *sql.Tx, itemID string) ([]Segment, error) {
	rows, err := tx.Query(`SELECT item_id,seq,kind,text,content_hash FROM segments WHERE item_id=? ORDER BY seq ASC`, itemID)
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

// backfillTagLinksTx 把一条已入库标签条目的 segments 行幂等回填进 tag_links（册子 §3.3）。
// 回填**不校验目标存在性**（评论事件未必已同步，引用允许悬空）；非四类 kind 的行丢弃
// （防御：导出侧只产出四类，但包里来的数据不由本节点保证）。
func backfillTagLinksTx(tx *sql.Tx, tagID string) error {
	segs, err := listSegmentsTx(tx, tagID)
	if err != nil {
		return err
	}
	links := make([]TagLink, 0, len(segs))
	for _, s := range segs {
		if !protocol.TagKindAllowed(s.Kind) || strings.TrimSpace(s.Text) == "" {
			continue
		}
		links = append(links, TagLink{TagID: tagID, TargetID: s.Text, Kind: s.Kind})
	}
	_, err = replaceTagLinksTx(tx, tagID, links)
	return err
}

// ReplaceTagLinks 公开入口：在独立事务里全量替换一个 tag 的关联集（importer 重建 tag 容器用）。
// 返回新的 content_hash。只碰 tag_links + segments + items.content_hash，不碰 items.author_id。
func (s *Store) ReplaceTagLinks(tagID string, links []TagLink) (string, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()
	hash, err := replaceTagLinksTx(tx, tagID, links)
	if err != nil {
		return "", err
	}
	if _, err := tx.Exec(`UPDATE items SET content_hash=?,source_rev=?,updated_at=? WHERE item_id=?`,
		hash, hash[:16], nowUTC(), tagID); err != nil {
		return "", err
	}
	return hash, tx.Commit()
}

// EnsureTagItem 幂等创建一个 tag item 行（items 表）。已存在则不写 author_id/author_sig。
// importer 重建 tag 容器时：author_id="" 表示"可被 governance 认领"。
func (s *Store) EnsureTagItem(tagID, title string, contentHash string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
		VALUES(?,?,?,?,?,?,?,?,?,'',?)
		ON CONFLICT(item_id) DO UPDATE SET title=excluded.title, source_rev=excluded.source_rev, content_hash=excluded.content_hash, updated_at=excluded.updated_at`,
		tagID, "tag", "tag", title, contentHash[:16], contentHash, "segments", "public", "active", nowUTC()); err != nil {
		return fmt.Errorf("store: ensure tag item %s: %w", tagID, err)
	}
	return tx.Commit()
}
