package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
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
		// 提案人自投第 1 票（幂等：先查是否已投）
		var cnt int
		tx.QueryRow(`SELECT COUNT(*) FROM govern_votes WHERE proposal_id=? AND voter_id=?`, e.ProposalID, e.Actor).Scan(&cnt)
		if cnt == 0 {
			if _, err := tx.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,created_at,source_event_id)
				VALUES(?,?,?,?)`, e.ProposalID, e.Actor, e.CreatedAt, e.EventID); err != nil {
				return fmt.Errorf("store: 投影提案人第 1 票: %w", err)
			}
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
// Choice 字段映射到 vote_type（"yes"/"approve" → approve, "no"/"reject" → reject）。
func (s *Store) ProjectGovernVote(e GovernVoteEvent) error {
	voteType := mapGovernChoice(e.Choice)
	// 「最早」按 **事件的 created_at** 比较，而不是到达顺序：先到的可能是较晚的事件，
	// 故不能只靠 PRIMARY KEY + DO NOTHING，要在占位更晚时替换。
	var prevCreated int64
	var prevEventID string
	err := s.db.QueryRow(`SELECT created_at, COALESCE(source_event_id,'') FROM govern_votes WHERE proposal_id=? AND voter_id=?`,
		e.ProposalID, e.Actor).Scan(&prevCreated, &prevEventID)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if _, err := s.db.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,created_at,source_event_id,vote_type) VALUES(?,?,?,?,?)`,
			e.ProposalID, e.Actor, e.CreatedAt, e.EventID, voteType); err != nil {
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
		if _, err := s.db.Exec(`UPDATE govern_votes SET created_at=?, source_event_id=?, vote_type=? WHERE proposal_id=? AND voter_id=?`,
			e.CreatedAt, e.EventID, voteType, e.ProposalID, e.Actor); err != nil {
			return fmt.Errorf("store: 收敛投票: %w", err)
		}
	}
	return nil
}

// mapGovernChoice 把 govern.v1 的 Choice 字段归一到 vote_type。
func mapGovernChoice(choice string) string {
	switch strings.ToLower(strings.TrimSpace(choice)) {
	case "yes", "approve", "赞成", "同意":
		return "approve"
	case "no", "reject", "反对", "驳回":
		return "reject"
	default:
		return "approve"
	}
}

// SettleGovernProposal 对一条已投影的提案做一次生效判定并落地受审动作。
//
// 改造点（对比老册 §4.3/§4.4）：
//  - 从老名册门槛 + 容器免票选旁路，切换到 Spec v2 §4 两阶段判定
//  - 实时算 m（活跃身份 7 天）、P（他人 progress）、F（他人 favorites）
//  - 用 GovernThreshold + GovernQuorum 算门槛；阶段 1 quorum 达标 → 阶段 2 净票权 > 0
//  - voter_count = COUNT(DISTINCT voter_id)（V2 管线里所有人都算，不再按 roster 过滤）
//  - approve_sum / reject_sum = SUM(vote_weight) GROUP BY vote_type
//
// roster / rosterReady 入参保留（签名兼容），但 V2 管线不再使用（有效票 = 所有 voter_id）。
func (s *Store) SettleGovernProposal(proposalID int64, roster map[string]bool, rosterReady bool) error {
	// 前置检查：提案存在 / 已定案 → return nil（幂等）
	p, ok, err := s.GetProposal(proposalID)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	if p.ExecutedAt != 0 || p.VoidedAt != 0 {
		return nil
	}

	// 快速路径：shouldFreeExec（Spec v2 §3.5）——事件路径也支持免票选
	// 在 Begin 之前用 s.db 判定（单连接池下事务内再发查询会死锁）
	if free, ferr := shouldFreeExec(s.db, p.ItemID, p.ProposerID, p.Action); ferr == nil && free {
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback() }()
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
				return fmt.Errorf("mark void: %w", err)
			}
			return tx.Commit()
		}
		result, err := governApplyTx(tx, s, cur)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE govern_proposals SET executed_at=?,executed_result=? WHERE proposal_id=?`,
			now, "free_exec:"+result, proposalID); err != nil {
			return fmt.Errorf("mark free_exec: %w", err)
		}
		return tx.Commit()
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UnixMilli()

	// Step A: 事务内重读提案（并发乐观锁）
	cur, err := scanProposal(tx.QueryRow(`SELECT `+proposalColumns+` FROM govern_proposals WHERE proposal_id=?`, proposalID))
	if err != nil {
		return fmt.Errorf("store: 读提案 %d: %w", proposalID, err)
	}
	if cur.ExecutedAt != 0 || cur.VoidedAt != 0 {
		return tx.Commit()
	}

	// Step B: 实时算 m（7 天活跃身份数）
	var m int
	sevenDaysMs := int64(7 * 24 * 60 * 60 * 1000)
	if err := tx.QueryRow(`SELECT COUNT(DISTINCT id) FROM identities WHERE last_seen_at > ?`, now-sevenDaysMs).Scan(&m); err != nil {
		return fmt.Errorf("count active users: %w", err)
	}

	// Step C: 实时算 P + F（排除 proposer）
	var P, F int
	if cur.ItemID != "" {
		if err := tx.QueryRow(`SELECT COUNT(DISTINCT id) FROM progress WHERE item_id=? AND id != ?`, cur.ItemID, cur.ProposerID).Scan(&P); err != nil {
			return fmt.Errorf("count progress: %w", err)
		}
		if err := tx.QueryRow(`SELECT COUNT(DISTINCT id) FROM favorites WHERE item_id=? AND id != ?`, cur.ItemID, cur.ProposerID).Scan(&F); err != nil {
			return fmt.Errorf("count favorites: %w", err)
		}
	}

	// Step D: 门槛 + quorum
	threshold := GovernThreshold(cur.GovernanceLevel, m, P, F)
	// 小节点豁免（目录动作，名册 < DirectorySmallNodeRosterMax）——老册 §65 逻辑保留
	if rosterReady && cur.Action == GovernActionDirectoryAdd && len(roster) < DirectorySmallNodeRosterMax {
		threshold = 0
	}
	quorum := GovernQuorum(threshold, m)

	// Step E: 独立 voter 数
	var voterCount int
	if err := tx.QueryRow(`SELECT COUNT(DISTINCT voter_id) FROM govern_votes WHERE proposal_id=?`, proposalID).Scan(&voterCount); err != nil {
		return fmt.Errorf("count voters: %w", err)
	}

	// Step F: 阶段 1 — quorum 未达 → pending
	if voterCount < quorum {
		return tx.Commit()
	}

	// Step G: 阶段 2 — 净票权
	var approveSum, rejectSum int
	if err := tx.QueryRow(`SELECT
		COALESCE(SUM(CASE WHEN vote_type='approve' THEN vote_weight ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN vote_type='reject' THEN vote_weight ELSE 0 END),0)
		FROM govern_votes WHERE proposal_id=?`, proposalID).Scan(&approveSum, &rejectSum); err != nil {
		return fmt.Errorf("sum vote weights: %w", err)
	}
	net := NetWeight(approveSum, rejectSum)

	if net <= 0 {
		// 净票权不达标 → void
		if _, err := tx.Exec(`UPDATE govern_proposals SET voided_at=? WHERE proposal_id=?`, now, proposalID); err != nil {
			return fmt.Errorf("mark void: %w", err)
		}
		return tx.Commit()
	}

	// Step H: 净票权 > 0 — 跑前置条件 + 执行动作
	met, err := governPreconditionTx(tx, cur)
	if err != nil {
		return err
	}
	if !met {
		if _, err := tx.Exec(`UPDATE govern_proposals SET voided_at=? WHERE proposal_id=?`, now, proposalID); err != nil {
			return fmt.Errorf("mark void (precondition): %w", err)
		}
		return tx.Commit()
	}

	result, err := governApplyTx(tx, s, cur)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE govern_proposals SET executed_at=?,executed_result=? WHERE proposal_id=?`, now, result, proposalID); err != nil {
		return fmt.Errorf("mark executed: %w", err)
	}
	return tx.Commit()
}
