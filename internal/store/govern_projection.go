package store

import (
	"database/sql"
	"errors"
	"fmt"
)

// GovernEventActionProposal / GovernEventActionVote 是 govern.v1 的两个动作（册子 §4.2，零新增枚举）。
const (
	GovernEventActionProposal = "proposal"
	GovernEventActionVote     = "vote"
)

// GovernProposalEvent 是 govern.v1 的提案体（册子 §4.2）。
// `ProposalID` 是 **int64**：`govern_proposals.proposal_id` 是 `INTEGER PRIMARY KEY`，
// 事件的 `proposal_id` 必须是同一空间（十进制整数字符串，解析在 parseGovernBody）。
type GovernProposalEvent struct {
	ProposalID     int64
	TargetItemID   string
	Verb           string
	ContentHash    string
	Reason         string
	Title          string
	BodyMD         string
	ContentVersion int64 // 提案快照水位之一（册子 §4.3）
	RevokedRev     int64 // 提案快照水位之二
	CreatedAt      int64
	EventID        string
	Actor          string
}

// GovernVoteEvent 是 govern.v1 的投票体（册子 §4.2）。
type GovernVoteEvent struct {
	ProposalID int64
	Choice     string
	CreatedAt  int64
	EventID    string
	Actor      string
}

// ErrGovernEventConflict 表示同 proposal_id 的投影已被占位、本次事件不是 (created_at,event_id) 首个。
// 上层（httpapi / peersync）据此**告知而不报错**：投影已收敛，事件行照落（册子 §4.3 / §6）。
var ErrGovernEventConflict = errors.New("store: govern event conflict")

// ProjectGovernProposal 把提案事件投影进 govern_proposals（册子 §4.4）。
// **并发收敛**：同 proposal_id 已有投影时，取 (created_at, event_id) 字典序**首个**——
// 后来的冲突事件不覆盖，返回 ErrGovernEventConflict 供上层告知（册子 §4.3 / §6）。
func (s *Store) ProjectGovernProposal(e GovernProposalEvent) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// 写语句置最前（沿用 addVoteTx 体例：单连接池下先拿写锁，避免并发读到旧值）。
	prevCreated, prevEventID, found, err := existingProposalWatermarkTx(tx, e.ProposalID)
	if err != nil {
		return err
	}
	if !found {
		// 首次投影：事件是权威，按事件值落库（proposal_id 也取事件值，不依赖本机自增）
		if _, err := tx.Exec(`INSERT INTO govern_proposals(
			proposal_id,action,item_id,proposer_id,reason,title,body_md,base_content_hash,created_at,source_event_id,content_version,revoked_rev)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
			e.ProposalID, e.Verb, e.TargetItemID, e.Actor, e.Reason, e.Title, e.BodyMD,
			e.ContentHash, e.CreatedAt, e.EventID, e.ContentVersion, e.RevokedRev); err != nil {
			return fmt.Errorf("store: 投影提案: %w", err)
		}
		// 提案人自投第 1 票（与 CreateProposal 同构；票的 created_at 用**事件值**，不是本机 now）
		if _, err := tx.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,created_at,source_event_id)
			VALUES(?,?,?,?) ON CONFLICT(proposal_id,voter_id) DO NOTHING`,
			e.ProposalID, e.Actor, e.CreatedAt, e.EventID); err != nil {
			return fmt.Errorf("store: 投影提案人第 1 票: %w", err)
		}
		return tx.Commit()
	}
	// 已有投影：同一条事件重放属幂等，不算冲突。
	if prevEventID == e.EventID {
		return nil
	}
	// 事件来源的行按 (created_at, event_id) 字典序收敛：本次更早则替换（「首个」语义的确定性）。
	// **本地路径写入的行（source_event_id 为 NULL）永不覆盖**——它代表本机已执行的动作，事件无权改写。
	if prevEventID != "" && (e.CreatedAt < prevCreated || (e.CreatedAt == prevCreated && e.EventID < prevEventID)) {
		if _, err := tx.Exec(`UPDATE govern_proposals SET
			action=?,item_id=?,proposer_id=?,reason=?,title=?,body_md=?,base_content_hash=?,
			created_at=?,source_event_id=?,content_version=?,revoked_rev=?
			WHERE proposal_id=?`,
			e.Verb, e.TargetItemID, e.Actor, e.Reason, e.Title, e.BodyMD, e.ContentHash,
			e.CreatedAt, e.EventID, e.ContentVersion, e.RevokedRev, e.ProposalID); err != nil {
			return fmt.Errorf("store: 收敛提案 %d: %w", e.ProposalID, err)
		}
		return tx.Commit()
	}
	return ErrGovernEventConflict
}

// existingProposalWatermarkTx 读一条提案的 (created_at, source_event_id)；无行返回 found=false。
func existingProposalWatermarkTx(tx *sql.Tx, proposalID int64) (createdAt int64, eventID string, found bool, err error) {
	err = tx.QueryRow(`SELECT created_at, COALESCE(source_event_id,'') FROM govern_proposals WHERE proposal_id=?`,
		proposalID).Scan(&createdAt, &eventID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", false, nil
	}
	if err != nil {
		return 0, "", false, err
	}
	return createdAt, eventID, true, nil
}

// ProjectGovernVote 把投票事件投影进 govern_votes（册子 §4.4）。
// 同 (proposal_id, voter_id) 取**最早**的 (created_at, event_id)；后来的不覆盖（幂等重放也不报错）。
func (s *Store) ProjectGovernVote(e GovernVoteEvent) error {
	// 「最早」按 **事件的 created_at** 比较，而不是到达顺序：先到的可能是较晚的事件，
	// 故不能只靠 PRIMARY KEY + DO NOTHING，要在占位更晚时替换。
	var prevCreated int64
	var prevEventID string
	err := s.db.QueryRow(`SELECT created_at, COALESCE(source_event_id,'') FROM govern_votes WHERE proposal_id=? AND voter_id=?`,
		e.ProposalID, e.Actor).Scan(&prevCreated, &prevEventID)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if _, err := s.db.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,created_at,source_event_id) VALUES(?,?,?,?)`,
			e.ProposalID, e.Actor, e.CreatedAt, e.EventID); err != nil {
			return fmt.Errorf("store: 投影投票: %w", err)
		}
		return nil
	case err != nil:
		return err
	}
	if prevEventID == e.EventID {
		return nil // 同一事件重放
	}
	if e.CreatedAt < prevCreated || (e.CreatedAt == prevCreated && e.EventID < prevEventID) {
		if _, err := s.db.Exec(`UPDATE govern_votes SET created_at=?, source_event_id=? WHERE proposal_id=? AND voter_id=?`,
			e.CreatedAt, e.EventID, e.ProposalID, e.Actor); err != nil {
			return fmt.Errorf("store: 收敛投票: %w", err)
		}
	}
	return nil
}
