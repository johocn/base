package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/johocn/base/internal/protocol"
)

// 三个受审动作（册子 §2.1）。门槛是**文档级常量**，校准走「改册子 + 改常量」。
const (
	GovernActionRemove = "remove"
	GovernActionEdit   = "edit"
	GovernActionRevive = "revive"

	governRemoveThreshold  = 3
	governDefaultThreshold = 2
)

// 第四个受审动作：目录词条新增（册子 #58 §3.1）。与既有三动作共用提案 / 投票管线与事件。
const (
	GovernActionDirectoryAdd = "directory_add"
	// DirectoryAddQuorum 与 #27 同档 2 票；名册 < DirectorySmallNodeRosterMax 的节点豁免为 1 票（册子 §3.2）。
	DirectoryAddQuorum          = 2
	DirectorySmallNodeRosterMax = 10
	// directoryExecutedResult 是 directory_add 生效后的 executed_result（诊断信息，不构成契约）。
	directoryExecutedResult = "directory_approved"
)

// Proposal status 的三值（册子 §4.4）。
const (
	GovernStatusPending   = "pending"
	GovernStatusEffective = "effective"
	GovernStatusVoid      = "void"
)

// GovernThreshold 返回某动作的授权门槛：remove 3 票，edit / revive / directory_add 2 票（册子 §2.1 / #58 §3.2）。
func GovernThreshold(action string) int {
	if action == GovernActionRemove {
		return governRemoveThreshold
	}
	if action == GovernActionDirectoryAdd {
		return DirectoryAddQuorum
	}
	return governDefaultThreshold
}

// GovernThresholdForRoster 在名册语境下给出门槛：directory_add 且「名册就绪且 < DirectorySmallNodeRosterMax」⇒ 1（小节点豁免）。
// 名册派生失败（rosterReady=false）**不豁免**（fail-closed，册子 #58 §9 风险 1）——否则名册抖动会把词条批量误批为公开可见。
func GovernThresholdForRoster(action string, rosterLen int, rosterReady bool) int {
	if action == GovernActionDirectoryAdd && rosterReady && rosterLen < DirectorySmallNodeRosterMax {
		return 1
	}
	return GovernThreshold(action)
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
	LinksJSON       string // 仅 tag 型 Action == GovernActionEdit 时非空（#37 册子 §3.5）
	BaseContentHash string
	CreatedAt       int64
	ExecutedAt      int64
	VoidedAt        int64
	ExecutedResult  string
	// SourceEventID 指回来源 `govern.v1` 事件；空串 = 老路径本地写入（册子 §2.5）。
	SourceEventID string
	// ContentVersion / RevokedRev 是提案建立时固化的**快照水位**（册子 §4.3）：
	// 票权按该水位复算，名册中途变化不改判（AC 12）。
	ContentVersion int64
	RevokedRev     int64
}

// ProposalView 是一条提案加上**当前有效票**与派生字段（册子 §3.3）。
type ProposalView struct {
	Proposal
	Votes     []string
	Threshold int
	Status    string
}

// proposalColumns 的列顺序必须与 scanProposal 的 Scan 参数一一对应。
// source_event_id 可空，故 COALESCE 成空串读回（NULL = 老路径本地写入）。
const proposalColumns = `proposal_id,action,item_id,proposer_id,reason,title,body_md,COALESCE(links_json,''),base_content_hash,created_at,executed_at,voided_at,executed_result,COALESCE(source_event_id,''),content_version,revoked_rev`

// rowScanner 抽象 *sql.Row 与 *sql.Rows 的 Scan。
type rowScanner interface{ Scan(dest ...any) error }

func scanProposal(sc rowScanner) (Proposal, error) {
	var p Proposal
	err := sc.Scan(&p.ProposalID, &p.Action, &p.ItemID, &p.ProposerID, &p.Reason, &p.Title, &p.BodyMD,
		&p.LinksJSON, &p.BaseContentHash, &p.CreatedAt, &p.ExecutedAt, &p.VoidedAt, &p.ExecutedResult,
		&p.SourceEventID, &p.ContentVersion, &p.RevokedRev)
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

// filterRosterAtWatermark 过滤出「在提案快照水位下仍在名册内」的投票人（册子 §4.3，取代 #27 的实时复判）。
// 以传入的**当前名册**为基线，再加回「水位之后才退役」的作者——与「当前名册」解耦（AC 12）。
// content_version 记入口径但当前无 per-item 版本可 gate，可实施的杠杆只有 revoked_rev。
func (s *Store) filterRosterAtWatermark(ids []string, roster map[string]bool, revokedRev int64) ([]string, error) {
	restored, err := s.restoredRosterAuthors(revokedRev)
	if err != nil {
		return nil, err
	}
	return filterRosterAtWatermarkSet(ids, roster, restored), nil
}

// filterRosterAtWatermarkSet 是 filterRosterAtWatermark 的纯函数核心（roster ∪ restored）：
// 同一口径被 ListProposalViews 与 SettleGovernProposal 共用，避免漂移。
func filterRosterAtWatermarkSet(ids []string, roster, restored map[string]bool) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if roster[id] || restored[id] {
			out = append(out, id)
		}
	}
	return out
}

// restoredRosterAuthors 返回「按快照水位应加回名册」的作者集合（册子 §4.3）：
// 作者有一条**在水位之后才退役**（tombstone.revoked_rev > revokedRev）且当前仍达质量门槛的条目。
// 派生口径与 ContributorRoster 完全同源（deriveRoster / meetsQualityGate），只在 state 判定上放宽退役条目。
func (s *Store) restoredRosterAuthors(revokedRev int64) (map[string]bool, error) {
	rows, err := s.db.Query(`SELECT item_id,author_id,type FROM items
		WHERE author_id<>'' AND state<>'active'
		  AND EXISTS(SELECT 1 FROM tombstones t WHERE t.item_id=items.item_id AND t.revoked_rev>?)
		ORDER BY item_id ASC`, revokedRev)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cands []Candidate
	articleIDs, videoIDs, quizIDs := []string{}, []string{}, []string{}
	index := map[string]int{}
	for rows.Next() {
		var c Candidate
		if err := rows.Scan(&c.ItemID, &c.AuthorID, &c.Type); err != nil {
			return nil, err
		}
		index[c.ItemID] = len(cands)
		cands = append(cands, c)
		switch c.Type {
		case "article":
			articleIDs = append(articleIDs, c.ItemID)
		case "video":
			videoIDs = append(videoIDs, c.ItemID)
		case "quiz":
			quizIDs = append(quizIDs, c.ItemID)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(articleIDs) > 0 {
		articles, err := s.ListArticles(articleIDs)
		if err != nil {
			return nil, err
		}
		for id, a := range articles {
			if i, ok := index[id]; ok {
				cands[i].BodyMD = a.BodyMD
			}
		}
	}
	if len(quizIDs) > 0 {
		quizzes, err := s.ListQuizzes(quizIDs)
		if err != nil {
			return nil, err
		}
		for id, q := range quizzes {
			i, ok := index[id]
			if !ok {
				continue
			}
			var doc struct {
				Questions []json.RawMessage `json:"questions"`
			}
			if err := json.Unmarshal([]byte(q.QuestionJSON), &doc); err == nil {
				cands[i].QuestionCount = len(doc.Questions)
			}
		}
	}
	if len(videoIDs) > 0 {
		durations, err := s.ListMediaDurations(videoIDs)
		if err != nil {
			return nil, err
		}
		for id, d := range durations {
			if i, ok := index[id]; ok {
				cands[i].DurationSeconds = d
			}
		}
	}
	set := map[string]bool{}
	for _, c := range deriveRoster(cands) {
		set[c.ID] = true
	}
	return set, nil
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
	// 提案建时固化快照水位（册子 §4.3）：content_version 记当前版本，revoked_rev 记当前墓碑高水位。
	// 之后票权按此水位复算，名册中途变化不改判（AC 12）。老路径不产事件，source_event_id 留 NULL。
	cv, err := contentVersionTx(tx)
	if err != nil {
		return 0, err
	}
	rv, err := maxRevokedRevTx(tx)
	if err != nil {
		return 0, err
	}
	res, err := tx.Exec(`INSERT INTO govern_proposals(action,item_id,proposer_id,reason,title,body_md,links_json,base_content_hash,created_at,content_version,revoked_rev)
		VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		p.Action, p.ItemID, p.ProposerID, p.Reason, p.Title, p.BodyMD, p.LinksJSON,
		p.BaseContentHash, p.CreatedAt, cv, rv)
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

// CreateDirectoryProposal 单事务写目录提案 + 提案人第 1 票；autoApprove=true（小节点豁免）时
// **同事务**批准词条、推 directory_version、记 executed_at（册子 #58 §3.2）。返回 (proposal_id, status)。
//
// 与 CreateProposal 的唯一差别是 autoApprove 分支把「生效」也收进同一事务，使名册 < 10 的节点
// 提交即 approved（避免自己投自己）。item_id / title / body_md / base_content_hash 由调用方
// 按目录契约填好（term_key 落 body_md、display_name 落 title），本函数只负责持久化与版本推进。
func (s *Store) CreateDirectoryProposal(p Proposal, autoApprove bool) (int64, string, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = tx.Rollback() }()
	// 与 CreateProposal 同口径固化快照水位（册子 §4.3）。
	cv, err := contentVersionTx(tx)
	if err != nil {
		return 0, "", err
	}
	rv, err := maxRevokedRevTx(tx)
	if err != nil {
		return 0, "", err
	}
	res, err := tx.Exec(`INSERT INTO govern_proposals(action,item_id,proposer_id,reason,title,body_md,links_json,base_content_hash,created_at,content_version,revoked_rev)
		VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		p.Action, p.ItemID, p.ProposerID, p.Reason, p.Title, p.BodyMD, p.LinksJSON,
		p.BaseContentHash, p.CreatedAt, cv, rv)
	if err != nil {
		return 0, "", fmt.Errorf("store: 写目录提案: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, "", err
	}
	if _, err := tx.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,created_at) VALUES(?,?,?)`,
		id, p.ProposerID, p.CreatedAt); err != nil {
		return 0, "", fmt.Errorf("store: 写目录提案人第 1 票: %w", err)
	}
	if !autoApprove {
		return id, GovernStatusPending, tx.Commit()
	}
	kind, ok := DirectoryKindOfItemID(p.ItemID)
	if !ok {
		return 0, "", fmt.Errorf("store: 目录提案 item_id 形态非法 %q", p.ItemID)
	}
	if err := approveDirectoryTermExec(tx, kind, p.BodyMD, p.Title, p.ProposerID); err != nil {
		return 0, "", err
	}
	if _, err := bumpDirectoryVersionExec(tx); err != nil {
		return 0, "", err
	}
	if _, err := tx.Exec(`UPDATE govern_proposals SET executed_at=?,executed_result=? WHERE proposal_id=?`,
		time.Now().UnixMilli(), directoryExecutedResult, id); err != nil {
		return 0, "", fmt.Errorf("store: 记 executed_at: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, "", err
	}
	return id, GovernStatusEffective, nil
}

// contentVersionTx 读当前全局 content_version（meta 缺省视为 0），供 CreateProposal 固化水位。
func contentVersionTx(tx *sql.Tx) (int64, error) {
	var n int64
	err := tx.QueryRow(`SELECT CAST(value AS INTEGER) FROM meta WHERE key=?`, metaContentVersion).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return n, err
}

// maxRevokedRevTx 读当前墓碑 revoked_rev 的高水位（无墓碑视为 0），供 CreateProposal 固化水位。
func maxRevokedRevTx(tx *sql.Tx) (int64, error) {
	var n int64
	err := tx.QueryRow(`SELECT COALESCE(MAX(revoked_rev),0) FROM tombstones`).Scan(&n)
	return n, err
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
		// 票权按提案**快照水位**判定（册子 §4.3），与「当前名册」解耦（AC 12）。
		effective, err := s.filterRosterAtWatermark(voters, roster, p.RevokedRev)
		if err != nil {
			return nil, err
		}
		out = append(out, ProposalView{
			Proposal:  p,
			Votes:     effective,
			Threshold: GovernThreshold(p.Action),
			Status:    ProposalStatus(p.ExecutedAt, p.VoidedAt),
		})
	}
	return out, nil
}

// ErrAlreadyVoted 表示该身份已对本提案投过票（册子 §3.2 的 409）。
var ErrAlreadyVoted = errors.New("store: already voted")

// VoteResult 是一次投票落库后的判定结果，字段与 §3.2 的响应一一对应。
type VoteResult struct {
	ProposalID int64
	VoteCount  int
	Threshold  int
	Status     string
}

// AddVote 写入一张票，并在**同一事务内**做生效判定（册子 §4.4）：
// 有效票达门槛则执行动作并记 executed_at；前置条件不满足则记 voided_at。
//
// roster 由调用方在**事务外**派生（ContributorRoster）。空 map ⇒ 有效票 = 0，
// 即册子 §6.2「名册派生失败按空名册降级」的口径，提案停在 pending。
func (s *Store) AddVote(proposalID int64, voterID string, roster map[string]bool) (VoteResult, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return VoteResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := addVoteTx(tx, s, proposalID, voterID, roster)
	if err != nil {
		return VoteResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return VoteResult{}, err
	}
	return res, nil
}

// addVoteTx 是 AddVote 的事务体。
//
// **写语句刻意置于最前**：它让 SQLite 先取写锁、把并发投票串行化，
// 之后的读必然看到此前已提交的 executed_at / voided_at——这是册子 §4.4 步 1 成立的前提。
func addVoteTx(tx *sql.Tx, st *Store, proposalID int64, voterID string, roster map[string]bool) (VoteResult, error) {
	now := time.Now().UnixMilli()
	ins, err := tx.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,created_at) VALUES(?,?,?)
		ON CONFLICT(proposal_id,voter_id) DO NOTHING`, proposalID, voterID, now)
	if err != nil {
		return VoteResult{}, fmt.Errorf("store: 写票: %w", err)
	}
	n, err := ins.RowsAffected()
	if err != nil {
		return VoteResult{}, err
	}
	if n == 0 {
		return VoteResult{}, ErrAlreadyVoted
	}

	p, err := scanProposal(tx.QueryRow(`SELECT `+proposalColumns+` FROM govern_proposals WHERE proposal_id=?`, proposalID))
	if err != nil {
		return VoteResult{}, fmt.Errorf("store: 读提案 %d: %w", proposalID, err)
	}
	voters, err := proposalVotersExec(tx, proposalID)
	if err != nil {
		return VoteResult{}, err
	}
	out := VoteResult{
		ProposalID: proposalID,
		VoteCount:  len(filterRoster(voters, roster)),
		// HTTP 投票路径的名册由 handler 派生；派生失败按空名册参与（rosterReady 恒 true，不因空名册而豁免）。
		Threshold: GovernThresholdForRoster(p.Action, len(roster), true),
	}

	// 步 1：已定案（两个一次性事实任一非 0）→ 票已落库，不再判。
	if p.ExecutedAt != 0 || p.VoidedAt != 0 {
		out.Status = ProposalStatus(p.ExecutedAt, p.VoidedAt)
		return out, nil
	}
	// 步 3：未达门槛。
	if out.VoteCount < out.Threshold {
		out.Status = GovernStatusPending
		return out, nil
	}
	// 步 4 / 步 5：门槛已到，判前置条件（册子 §4.4）。
	met, err := governPreconditionTx(tx, p)
	if err != nil {
		return VoteResult{}, err
	}
	if !met {
		if _, err := tx.Exec(`UPDATE govern_proposals SET voided_at=? WHERE proposal_id=?`, now, proposalID); err != nil {
			return VoteResult{}, fmt.Errorf("store: 记 voided_at: %w", err)
		}
		out.Status = GovernStatusVoid
		return out, nil
	}
	result, err := governApplyTx(tx, st, p)
	if err != nil {
		return VoteResult{}, err
	}
	if _, err := tx.Exec(`UPDATE govern_proposals SET executed_at=?,executed_result=? WHERE proposal_id=?`,
		now, result, proposalID); err != nil {
		return VoteResult{}, fmt.Errorf("store: 记 executed_at: %w", err)
	}
	out.Status = GovernStatusEffective
	return out, nil
}

// governPreconditionTx 判前置条件（册子 §4.4）：目标仍在、state 与动作匹配、content_hash 未变。
// 第 3 条是本册的乐观锁：授权针对的是**某一版内容**，那一版没了授权就永久作废。
func governPreconditionTx(tx *sql.Tx, p Proposal) (bool, error) {
	// directory_add 的目标不是内容条目，items 表无对应行（决策 3）：旧前置条件会因 ErrNoRows 恒判 false，
	// 故直接放行——目录动作没有可锁定的目标版本。
	if p.Action == GovernActionDirectoryAdd {
		return true, nil
	}
	var state, hash string
	err := tx.QueryRow(`SELECT state,content_hash FROM items WHERE item_id=?`, p.ItemID).Scan(&state, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if state != GovernRequiredState(p.Action) {
		return false, nil
	}
	return hash == p.BaseContentHash, nil
}

// governApplyTx 在事务内执行受审动作，返回 executed_result（诊断信息，不构成契约，册子 §5.1）。
func governApplyTx(tx *sql.Tx, st *Store, p Proposal) (string, error) {
	switch p.Action {
	case GovernActionRemove:
		rev, err := nextContentVersionExec(tx)
		if err != nil {
			return "", err
		}
		if err := retireItemExec(tx, p.ItemID, rev); err != nil {
			return "", err
		}
		return "removed", nil
	case GovernActionRevive:
		// 内容行与块一直在（remove 只置状态），复活 = 删墓碑 + 回 active（册子 §4.3）。
		if _, err := tx.Exec(`DELETE FROM tombstones WHERE item_id=?`, p.ItemID); err != nil {
			return "", fmt.Errorf("store: 复活删墓碑 %s: %w", p.ItemID, err)
		}
		if _, err := tx.Exec(`UPDATE items SET state='active' WHERE item_id=?`, p.ItemID); err != nil {
			return "", fmt.Errorf("store: 复活置状态 %s: %w", p.ItemID, err)
		}
		return "revived", nil
	case GovernActionEdit:
		return editItemTx(tx, st, p)
	case GovernActionDirectoryAdd:
		// 生效分支写目录（册子 #58 §3.4）：item_id = dir/<kind>/<hash16>，term_key 落 body_md、名落 title。
		kind, ok := DirectoryKindOfItemID(p.ItemID)
		if !ok {
			return "", fmt.Errorf("store: 目录提案 item_id 形态非法 %q", p.ItemID)
		}
		if err := approveDirectoryTermExec(tx, kind, p.BodyMD, p.Title, p.ProposerID); err != nil {
			return "", err
		}
		if _, err := bumpDirectoryVersionExec(tx); err != nil {
			return "", err
		}
		return directoryExecutedResult, nil
	default:
		return "", fmt.Errorf("store: 不支持的治理动作 %q", p.Action)
	}
}

// editItemTx 执行改写（册子 §4.2）：全量覆盖 title / body_md，按 content_hash 是否变化决定归属后果。
// 只对 article 载体成立，受理阶段已挡住其余载体（册子 §0.3）。
func editItemTx(tx *sql.Tx, st *Store, p Proposal) (string, error) {
	if strings.HasPrefix(p.ItemID, "tag/") {
		return editTagItemTx(tx, p)
	}
	hash := protocol.SHA256Hex([]byte(p.BodyMD))
	var oldHash string
	if err := tx.QueryRow(`SELECT content_hash FROM items WHERE item_id=?`, p.ItemID).Scan(&oldHash); err != nil {
		return "", fmt.Errorf("store: 读目标 content_hash %s: %w", p.ItemID, err)
	}
	bodyEnc, err := st.encText(p.BodyMD)
	if err != nil {
		return "", fmt.Errorf("store: 加密改写正文 %s: %w", p.ItemID, err)
	}
	if _, err := tx.Exec(`UPDATE articles SET title=?,body_md=?,content_hash=?,source_rev=? WHERE item_id=?`,
		p.Title, bodyEnc, hash, hash[:16], p.ItemID); err != nil {
		return "", fmt.Errorf("store: 改写 articles %s: %w", p.ItemID, err)
	}
	if oldHash == hash {
		// 正文逐字节未变（只改了标题）→ title 不在签名域内，旧签名仍成立 → 归属列原样保留。
		if _, err := tx.Exec(`UPDATE items SET title=?,content_hash=?,source_rev=?,updated_at=? WHERE item_id=?`,
			p.Title, hash, hash[:16], nowUTC(), p.ItemID); err != nil {
			return "", fmt.Errorf("store: 改写 items %s: %w", p.ItemID, err)
		}
		return "edited", nil
	}
	// 正文被改动 → author_sig 绑定的是旧 content_hash，旧签名必然失效（#23 §2.1 的数学推论）
	// → 两列清空、该作者贡献 −1（册子 §4.2）。治理改写不提供认领路径。
	if _, err := tx.Exec(`UPDATE items SET title=?,content_hash=?,source_rev=?,updated_at=?,author_id='',author_sig='' WHERE item_id=?`,
		p.Title, hash, hash[:16], nowUTC(), p.ItemID); err != nil {
		return "", fmt.Errorf("store: 改写 items %s: %w", p.ItemID, err)
	}
	return "edited_author_cleared", nil
}

// EncodeTagLinks 把关联集编成可持久化的规范 JSON（tag 型 edit 的载荷，#37 册子 §3.5）。
func EncodeTagLinks(links []TagLink) (string, error) {
	b, err := json.Marshal(links)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// DecodeTagLinks 解出关联集；空串按「空关联集」处理（合法：标签可以没有任何关联）。
func DecodeTagLinks(raw string) ([]TagLink, bool) {
	if raw == "" {
		return []TagLink{}, true
	}
	var links []TagLink
	if err := json.Unmarshal([]byte(raw), &links); err != nil {
		return nil, false
	}
	return links, true
}

// editTagItemTx 执行标签条目的关联集改写（#37 册子 §3.5）：全量覆盖 → 重算物化行与 content_hash。
// **author_id / author_sig 两列不动**——标签的归属不随关联集变化而失效（与 article 的 edit 语义不同）。
func editTagItemTx(tx *sql.Tx, p Proposal) (string, error) {
	links, ok := DecodeTagLinks(p.LinksJSON)
	if !ok {
		return "", fmt.Errorf("store: 标签提案 %d 的 links_json 不可解析", p.ProposalID)
	}
	hash, err := replaceTagLinksTx(tx, p.ItemID, links)
	if err != nil {
		return "", err
	}
	if _, err := tx.Exec(`UPDATE items SET content_hash=?,source_rev=?,updated_at=? WHERE item_id=?`,
		hash, hash[:16], nowUTC(), p.ItemID); err != nil {
		return "", fmt.Errorf("store: 改写 items %s: %w", p.ItemID, err)
	}
	return "edited_links", nil
}
