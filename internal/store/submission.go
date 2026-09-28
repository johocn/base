package store

import (
	"database/sql"
	"errors"
	"fmt"
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
