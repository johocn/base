package store

import (
	"database/sql"
	"errors"
	"fmt"
)

// 三个受审动作（册子 §2.1）。门槛是**文档级常量**，校准走「改册子 + 改常量」。
const (
	GovernActionRemove = "remove"
	GovernActionEdit   = "edit"
	GovernActionRevive = "revive"

	governRemoveThreshold  = 3
	governDefaultThreshold = 2
)

// Proposal status 的三值（册子 §4.4）。
const (
	GovernStatusPending   = "pending"
	GovernStatusEffective = "effective"
	GovernStatusVoid      = "void"
)

// GovernThreshold 返回某动作的授权门槛：remove 3 票，edit / revive 2 票（册子 §2.1）。
func GovernThreshold(action string) int {
	if action == GovernActionRemove {
		return governRemoveThreshold
	}
	return governDefaultThreshold
}

// GovernRequiredState 返回某动作要求的目标 state（册子 §2.1）。
func GovernRequiredState(action string) string {
	if action == GovernActionRevive {
		return "removed"
	}
	return "active"
}

// ProposalStatus 由两个一次性事实派生 status（册子 §4.4）。
func ProposalStatus(executedAt, voidedAt int64) string {
	switch {
	case executedAt != 0:
		return GovernStatusEffective
	case voidedAt != 0:
		return GovernStatusVoid
	default:
		return GovernStatusPending
	}
}

// Proposal 是 govern_proposals 的一行（册子 §5.1）。
type Proposal struct {
	ProposalID      int64
	Action          string
	ItemID          string
	ProposerID      string
	Reason          string
	Title           string // 仅 Action == GovernActionEdit 时非空
	BodyMD          string // 仅 Action == GovernActionEdit 时非空
	BaseContentHash string
	CreatedAt       int64
	ExecutedAt      int64
	VoidedAt        int64
	ExecutedResult  string
}

// ProposalView 是一条提案加上**当前有效票**与派生字段（册子 §3.3）。
type ProposalView struct {
	Proposal
	Votes     []string
	Threshold int
	Status    string
}

// proposalColumns 的列顺序必须与 scanProposal 的 Scan 参数一一对应。
const proposalColumns = `proposal_id,action,item_id,proposer_id,reason,title,body_md,base_content_hash,created_at,executed_at,voided_at,executed_result`

// rowScanner 抽象 *sql.Row 与 *sql.Rows 的 Scan。
type rowScanner interface{ Scan(dest ...any) error }

func scanProposal(sc rowScanner) (Proposal, error) {
	var p Proposal
	err := sc.Scan(&p.ProposalID, &p.Action, &p.ItemID, &p.ProposerID, &p.Reason, &p.Title, &p.BodyMD,
		&p.BaseContentHash, &p.CreatedAt, &p.ExecutedAt, &p.VoidedAt, &p.ExecutedResult)
	return p, err
}

// proposalVotersExec 按 voter_id 升序读某提案的全部投票人（未过滤名册）。
func proposalVotersExec(e sqlExec, proposalID int64) ([]string, error) {
	rows, err := e.Query(`SELECT voter_id FROM govern_votes WHERE proposal_id=? ORDER BY voter_id ASC`, proposalID)
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

// filterRoster 过滤出当前仍在名册内的投票人（册子 §2.3 实时复判）。空名册 ⇒ 空结果。
func filterRoster(ids []string, roster map[string]bool) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if roster[id] {
			out = append(out, id)
		}
	}
	return out
}

// CreateProposal 单事务写入提案行与提案人的第 1 票（册子 §2.3），返回新 proposal_id。
//
// 刻意**不做**生效判定：门槛最小为 2（册子 §2.1），此刻有效票恒为 1，判定必然 pending。
func (s *Store) CreateProposal(p Proposal) (int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.Exec(`INSERT INTO govern_proposals(action,item_id,proposer_id,reason,title,body_md,base_content_hash,created_at)
		VALUES(?,?,?,?,?,?,?,?)`,
		p.Action, p.ItemID, p.ProposerID, p.Reason, p.Title, p.BodyMD, p.BaseContentHash, p.CreatedAt)
	if err != nil {
		return 0, fmt.Errorf("store: 写提案: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,created_at) VALUES(?,?,?)`,
		id, p.ProposerID, p.CreatedAt); err != nil {
		return 0, fmt.Errorf("store: 写提案人第 1 票: %w", err)
	}
	return id, tx.Commit()
}

// GetProposal 读一行提案；不存在返回 ok=false（册子 §3.2 的 404 分支）。
func (s *Store) GetProposal(id int64) (Proposal, bool, error) {
	p, err := scanProposal(s.db.QueryRow(`SELECT `+proposalColumns+` FROM govern_proposals WHERE proposal_id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Proposal{}, false, nil
	}
	if err != nil {
		return Proposal{}, false, err
	}
	return p, true, nil
}

// ListProposalViews 按 proposal_id 升序返回全部提案（含已生效与 void 的历史，册子 §3.3），
// 票已按 roster **实时复判**过滤。roster 传空 map 即册子 §6.2 的降级口径（有效票 = 0）。
func (s *Store) ListProposalViews(roster map[string]bool) ([]ProposalView, error) {
	rows, err := s.db.Query(`SELECT ` + proposalColumns + ` FROM govern_proposals ORDER BY proposal_id ASC`)
	if err != nil {
		return nil, err
	}
	// 先把提案行读尽并关闭游标，再逐条取票：连接池为单连接（store.go SetMaxOpenConns(1)），
	// 若在游标未闭合时嵌套查 govern_votes 会因拿不到连接而死锁。
	proposals := []Proposal{}
	for rows.Next() {
		p, err := scanProposal(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		proposals = append(proposals, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	out := []ProposalView{}
	for _, p := range proposals {
		voters, err := proposalVotersExec(s.db, p.ProposalID)
		if err != nil {
			return nil, err
		}
		out = append(out, ProposalView{
			Proposal:  p,
			Votes:     filterRoster(voters, roster),
			Threshold: GovernThreshold(p.Action),
			Status:    ProposalStatus(p.ExecutedAt, p.VoidedAt),
		})
	}
	return out, nil
}
