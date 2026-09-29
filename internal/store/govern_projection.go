package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
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

// SettleGovernProposal 对一条已投影的提案做一次生效判定并落地受审动作（册子 §4.3 / §4.4）。
// 与老路径 addVoteTx 的判定同源同口径，区别只在**票权按提案快照水位**判定、且可由事件路径反复调用（幂等）。
// 提案行不存在或已定案（executed_at / voided_at 非 0）时直接返回 nil。
//
// 名册（roster）与「水位加回集合」（restored）都在**事务外**派生：本库为纯 Go SQLite 且
// SetMaxOpenConns(1)，在事务里调用 s.ListXxx / s.restoredRosterAuthors 必然死锁（拿不到连接）。
// 事务内只调用已知的 exec 版本函数（governPreconditionTx / governApplyTx / proposalVotersExec）。
func (s *Store) SettleGovernProposal(proposalID int64, roster map[string]bool) error {
	p, ok, err := s.GetProposal(proposalID)
	if err != nil {
		return err
	}
	if !ok {
		return nil // 提案行尚未投影（乱序：vote 先到）——由后续的 proposal 事件触发 settle
	}
	if p.ExecutedAt != 0 || p.VoidedAt != 0 {
		return nil // 已定案：反熵每轮重拉同一事件，这里必须幂等
	}
	voters, err := proposalVotersExec(s.db, proposalID)
	if err != nil {
		return err
	}
	restored, err := s.restoredRosterAuthors(p.RevokedRev)
	if err != nil {
		return err
	}
	effective := filterRosterAtWatermarkSet(voters, roster, restored)
	if len(effective) < GovernThreshold(p.Action) {
		return nil // 未达门槛
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// 步 1：事务内**第一件事就重读提案行**（并发乐观锁，与 addVoteTx 同强度）：
	// 另一路径可能已把本提案定案，此处读到非 0 即退出。
	cur, err := scanProposal(tx.QueryRow(`SELECT `+proposalColumns+` FROM govern_proposals WHERE proposal_id=?`, proposalID))
	if err != nil {
		return fmt.Errorf("store: 读提案 %d: %w", proposalID, err)
	}
	if cur.ExecutedAt != 0 || cur.VoidedAt != 0 {
		return tx.Commit()
	}
	now := time.Now().UnixMilli()
	met, err := governPreconditionTx(tx, cur)
	if err != nil {
		return err
	}
	if !met {
		if _, err := tx.Exec(`UPDATE govern_proposals SET voided_at=? WHERE proposal_id=?`, now, proposalID); err != nil {
			return fmt.Errorf("store: 记 voided_at: %w", err)
		}
		return tx.Commit()
	}
	result, err := governApplyTx(tx, s, cur)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE govern_proposals SET executed_at=?,executed_result=? WHERE proposal_id=?`,
		now, result, proposalID); err != nil {
		return fmt.Errorf("store: 记 executed_at: %w", err)
	}
	return tx.Commit()
}
