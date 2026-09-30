package store

import (
	"database/sql"
	"errors"
	"fmt"
	"sort"

	"github.com/johocn/base/internal/protocol"
)

// ErrItemTaken 表示同 item_id 已被占用——含**空归属**的存量条目（册子 §3.1）。
var ErrItemTaken = errors.New("store: item_id taken")

// Submission 是一条在线投稿（册子 §2.1）：正文/题库与归属同事务落库。
type Submission struct {
	ItemID       string
	Type         string // article | quiz
	Title        string
	BodyMD       string // Type == "article"
	QuestionJSON string // Type == "quiz"
	ContentHash  string // 由调用方按册子 §2.2 算好
	AuthorID     string
	AuthorSig    string
	UpdatedAt    string // 空则由本函数取当前 UTC
}

// UpsertSubmission 写入/更新一条投稿（items + articles|quizzes 同事务），
// created=true 表示新建。占用判定只看 items.author_id（册子 §3.1）：
// 已存在且 author_id 不等于投稿者——**包括空归属的存量条目**——一律 ErrItemTaken，不写入。
func (s *Store) UpsertSubmission(sub Submission) (created bool, err error) {
	var table string
	switch sub.Type {
	case "article":
		table = "articles"
	case "quiz":
		table = "quizzes"
	default:
		return false, fmt.Errorf("store: 不支持的投稿类型 %q", sub.Type)
	}
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
	switch err := tx.QueryRow(`SELECT author_id FROM items WHERE item_id=?`, sub.ItemID).Scan(&cur); {
	case errors.Is(err, sql.ErrNoRows):
		created = true
	case err != nil:
		return false, err
	case cur != sub.AuthorID:
		// 空归属（cur == ""）也走这里：投稿接口不是认领存量内容的口子。
		return false, ErrItemTaken
	}

	// ON CONFLICT 刻意不写 state / dist_class：墓碑条目保持其 state，
	// 不允许靠重新投稿复活（册子 §3.1，复活属第 3 册的治理动作）。
	if _, err := tx.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			title=excluded.title, source_rev=excluded.source_rev, content_hash=excluded.content_hash,
			updated_at=excluded.updated_at, author_id=excluded.author_id, author_sig=excluded.author_sig`,
		sub.ItemID, sub.Type, sub.Type, sub.Title, sub.ContentHash[:16], sub.ContentHash,
		table, "public", "active", updated, sub.AuthorID, sub.AuthorSig); err != nil {
		return false, fmt.Errorf("store: upsert submission item: %w", err)
	}

	if sub.Type == "article" {
		bodyEnc, err := s.encText(sub.BodyMD)
		if err != nil {
			return false, fmt.Errorf("store: encrypt body_md: %w", err)
		}
		if _, err := tx.Exec(`INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev)
			VALUES(?,?,?,?,?,?,?,?)
			ON CONFLICT(item_id) DO UPDATE SET
				title=excluded.title, body_md=excluded.body_md,
				content_hash=excluded.content_hash, source_rev=excluded.source_rev`,
			sub.ItemID, sub.Title, "", "", "[]", bodyEnc, sub.ContentHash, sub.ContentHash[:16]); err != nil {
			return false, fmt.Errorf("store: upsert submission article: %w", err)
		}
	} else {
		if _, err := tx.Exec(`INSERT INTO quizzes(item_id,question_json,content_hash)
			VALUES(?,?,?)
			ON CONFLICT(item_id) DO UPDATE SET question_json=excluded.question_json, content_hash=excluded.content_hash`,
			sub.ItemID, sub.QuestionJSON, sub.ContentHash); err != nil {
			return false, fmt.Errorf("store: upsert submission quiz: %w", err)
		}
	}
	return created, tx.Commit()
}

// SegmentSubmission 是一条容器（course / lesson）投稿（本册 §2.3 / §4.1）。
// Segments 必须是**完整行集**：含 seq<0 属性行、seq=0 简介行（可省）、seq>=1 清单行。
type SegmentSubmission struct {
	ItemID    string
	Type      string // course | lesson
	Title     string
	Segments  []Segment
	AuthorID  string
	AuthorSig string
	UpdatedAt string // 空则取当前 UTC
}

// UpsertSegmentSubmission 写入/更新一条容器投稿（items + segments 同事务），created=true 表示新建。
// 占用判定与 #25 逐字同口径：已存在且 author_id 不等于投稿者——**包括空归属的存量条目**——
// 一律 ErrItemTaken，不写入。content_hash 走容器口径（SegmentsContentHash，本册 §2.3）。
func (s *Store) UpsertSegmentSubmission(sub SegmentSubmission) (created bool, err error) {
	if sub.Type != "course" && sub.Type != "lesson" {
		return false, fmt.Errorf("store: 不支持的容器类型 %q", sub.Type)
	}
	ordered := append([]Segment{}, sub.Segments...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Seq < ordered[j].Seq })
	hash := SegmentsContentHash(ordered)
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
	switch err := tx.QueryRow(`SELECT author_id FROM items WHERE item_id=?`, sub.ItemID).Scan(&cur); {
	case errors.Is(err, sql.ErrNoRows):
		created = true
	case err != nil:
		return false, err
	case cur != sub.AuthorID:
		return false, ErrItemTaken
	}

	// ON CONFLICT 刻意不写 state / dist_class：墓碑条目保持其 state，不允许靠重新投稿复活（与 #25 同口径）。
	if _, err := tx.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
		VALUES(?,?,?,?,?,?,?,'public','active',?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			title=excluded.title, source_rev=excluded.source_rev, content_hash=excluded.content_hash,
			updated_at=excluded.updated_at, author_id=excluded.author_id, author_sig=excluded.author_sig`,
		sub.ItemID, sub.Type, sub.Type, sub.Title, hash[:16], hash, "segments",
		updated, sub.AuthorID, sub.AuthorSig); err != nil {
		return false, fmt.Errorf("store: upsert segment submission item: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM segments WHERE item_id=?`, sub.ItemID); err != nil {
		return false, fmt.Errorf("store: 清旧 segments: %w", err)
	}
	for _, seg := range ordered {
		if _, err := tx.Exec(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`,
			sub.ItemID, seg.Seq, seg.Kind, seg.Text, protocol.SHA256Hex([]byte(seg.Text))); err != nil {
			return false, fmt.Errorf("store: 写 segments %s seq=%d: %w", sub.ItemID, seg.Seq, err)
		}
	}
	return created, tx.Commit()
}
