package store

import (
	"database/sql"
	"fmt"
)

// MigrateSchemaV2 对已有数据库补 V2 新列与 favorites 新表。幂等（列/表已存在时跳过）。
// 所有 ALTER TABLE 走列存在性检查；新表走 CREATE TABLE IF NOT EXISTS。
func MigrateSchemaV2(db *sql.DB) error {
	// govern_votes: vote_weight / vote_type / date
	{
		cols, err := tableColumns(db, "govern_votes")
		if err != nil {
			return fmt.Errorf("migrate schema v2: govern_votes columns: %w", err)
		}
		if !cols["vote_weight"] {
			if _, err := db.Exec(`ALTER TABLE govern_votes ADD COLUMN vote_weight INTEGER NOT NULL DEFAULT 1`); err != nil {
				return fmt.Errorf("migrate govern_votes.vote_weight: %w", err)
			}
		}
		if !cols["vote_type"] {
			if _, err := db.Exec(`ALTER TABLE govern_votes ADD COLUMN vote_type TEXT NOT NULL DEFAULT 'approve'`); err != nil {
				return fmt.Errorf("migrate govern_votes.vote_type: %w", err)
			}
		}
		if !cols["date"] {
			if _, err := db.Exec(`ALTER TABLE govern_votes ADD COLUMN date TEXT NOT NULL DEFAULT ''`); err != nil {
				return fmt.Errorf("migrate govern_votes.date: %w", err)
			}
		}
		for _, stmt := range []string{
			`CREATE INDEX IF NOT EXISTS idx_gv_voter_date_weight ON govern_votes(voter_id, date, vote_weight)`,
			`CREATE INDEX IF NOT EXISTS idx_gv_proposal_type ON govern_votes(proposal_id, vote_type)`,
		} {
			if _, err := db.Exec(stmt); err != nil {
				return fmt.Errorf("migrate govern_votes index: %w", err)
			}
		}
	}

	// govern_proposals: governance_level / category / circle_id
	{
		cols, err := tableColumns(db, "govern_proposals")
		if err != nil {
			return fmt.Errorf("migrate schema v2: govern_proposals columns: %w", err)
		}
		if !cols["governance_level"] {
			if _, err := db.Exec(`ALTER TABLE govern_proposals ADD COLUMN governance_level TEXT NOT NULL DEFAULT 'base'`); err != nil {
				return fmt.Errorf("migrate govern_proposals.governance_level: %w", err)
			}
		}
		if !cols["category"] {
			if _, err := db.Exec(`ALTER TABLE govern_proposals ADD COLUMN category TEXT`); err != nil {
				return fmt.Errorf("migrate govern_proposals.category: %w", err)
			}
		}
		if !cols["circle_id"] {
			if _, err := db.Exec(`ALTER TABLE govern_proposals ADD COLUMN circle_id TEXT`); err != nil {
				return fmt.Errorf("migrate govern_proposals.circle_id: %w", err)
			}
		}
	}

	// items: pin_level / pinned_at / highlight_until
	{
		cols, err := tableColumns(db, "items")
		if err != nil {
			return fmt.Errorf("migrate schema v2: items columns: %w", err)
		}
		if !cols["pin_level"] {
			if _, err := db.Exec(`ALTER TABLE items ADD COLUMN pin_level INTEGER NOT NULL DEFAULT 0`); err != nil {
				return fmt.Errorf("migrate items.pin_level: %w", err)
			}
		}
		if !cols["pinned_at"] {
			if _, err := db.Exec(`ALTER TABLE items ADD COLUMN pinned_at INTEGER`); err != nil {
				return fmt.Errorf("migrate items.pinned_at: %w", err)
			}
		}
		if !cols["highlight_until"] {
			if _, err := db.Exec(`ALTER TABLE items ADD COLUMN highlight_until INTEGER`); err != nil {
				return fmt.Errorf("migrate items.highlight_until: %w", err)
			}
		}
	}

	// favorites 表（CREATE TABLE IF NOT EXISTS 幂等）
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS favorites(
		id TEXT NOT NULL, item_id TEXT NOT NULL, created_at INTEGER NOT NULL,
		PRIMARY KEY(id, item_id))`); err != nil {
		return fmt.Errorf("migrate favorites: %w", err)
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_favorites_item ON favorites(item_id)`); err != nil {
		return fmt.Errorf("migrate favorites index: %w", err)
	}

	return nil
}
