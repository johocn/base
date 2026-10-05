package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/johocn/base/internal/protocol"
)

// 四个受审动作（册子 §2.1）。门槛是**文档级常量**，校准走「改册子 + 改常量」。
const (
	GovernActionRemove = "remove"
	GovernActionEdit   = "edit"
	GovernActionRevive = "revive"

	// Spec v2 §3 新增：细粒度治理动作（在原有 edit 基础上拆 + 新类型）
	GovernActionEditTitle     = "edit_title"      // 改标题（只改 items.title，保留归属）
	GovernActionEditBody      = "edit_body"       // 改正文（改 articles.body_md，清署 items.author_id）
	GovernActionEditCategory  = "edit_category"   // 改分类（items.dist_class）
	GovernActionEditTags      = "edit_tags"       // 改标签（items.tags_json 全量覆盖）
	GovernActionEditInstructor = "edit_instructor" // 改讲师（items.instructor）

	// Spec v2 §3 新增：pin_level 系列（治理层给条目分级，enhanced 门槛）
	GovernActionHighlight = "highlight" // pin_level=1 高亮
	GovernActionPin       = "pin"       // pin_level=2 置顶
	GovernActionRecommend = "recommend" // pin_level=3 推荐
	GovernActionFeature   = "feature"   // pin_level=4 精华

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

// governThresholdLegacy 返回某动作的硬编码授权门槛（册子 §2.1 / #58 §3.2）。
// Deprecated: Task 4 后应由调用方按 Spec v2 第四节自行算动态门槛，本函数暂留以兼容旧路径。
func governThresholdLegacy(action string) int {
	if action == GovernActionRemove {
		return governRemoveThreshold
	}
	if action == GovernActionDirectoryAdd {
		return DirectoryAddQuorum
	}
	return governDefaultThreshold
}

// GovernThresholdLegacy 是旧签名（只传 action）的导出 wrapper，内部调 governThresholdLegacy。
// 后续 Task 会彻底替换成新公式；httpapi handler 层尚未引入活跃度/互动度数据，暂用此函数让编译通过。
func GovernThresholdLegacy(action string) int {
	return governThresholdLegacy(action)
}

// GovernThreshold 计算门槛公式值（Spec v2 §4）。
// level: "base" | "enhanced"
// m = 活跃 7 天用户数，P = 他人学习去重数，F = 他人收藏去重数。
// 公式：
//
//	base:     10 + ⌊m/3⌋ + ⌊(P+F)/3⌋
//	enhanced: 20 + ⌊m/3⌋ + ⌊2*(P+F)/3⌋
//
// Go 整数除法对正数向零截断等于 ⌊x⌋。
func GovernThreshold(level string, m, P, F int) int {
	mPrime := m / 3 // ⌊m/3⌋
	if level == "enhanced" {
		return 20 + mPrime + 2*(P+F)/3
	}
	// base / default
	return 10 + mPrime + (P+F)/3
}

// GovernQuorum 计算法定人数（Spec v2 §4）。
// quorum = min(max(threshold, ⌈m/2⌉), m)
// ⌈m/2⌉ = (m+1)/2 在整数域（对正数）。
func GovernQuorum(threshold, m int) int {
	half := (m + 1) / 2 // ⌈m/2⌉
	if threshold > half {
		if threshold > m {
			return m
		}
		return threshold
	}
	if half > m {
		return m
	}
	return half
}

// NetWeight 净票权 = 赞成票权总和 − 反对票权总和（Spec v2 §4）。
func NetWeight(approveSum, rejectSum int) int {
	return approveSum - rejectSum
}

// GovernThresholdForRoster 在名册语境下给出门槛：directory_add 且「名册就绪且 < DirectorySmallNodeRosterMax」⇒ 1（小节点豁免）。
// 名册派生失败（rosterReady=false）**不豁免**（fail-closed，册子 #58 §9 风险 1）——否则名册抖动会把词条批量误批为公开可见。
func GovernThresholdForRoster(action string, rosterLen int, rosterReady bool) int {
	if action == GovernActionDirectoryAdd && rosterReady && rosterLen < DirectorySmallNodeRosterMax {
		return 1
	}
	return governThresholdLegacy(action)
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
	Title           string // 仅 Action == GovernActionEditTitle / GovernActionEdit 时非空
	BodyMD          string // 仅 Action == GovernActionEditBody / GovernActionEdit 时非空
	LinksJSON       string // 仅 tag 型 Action == GovernActionEdit 时非空（#37 册子 §3.5）
	TagsJSON        string // Spec v2 §3: edit_tags 载荷（items.tags_json 全量覆盖）
	DistClass       string // Spec v2 §3: edit_category 载荷
	Instructor      string // Spec v2 §3: edit_instructor 载荷
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
	// GovernanceLevel / Category / CircleID 是 V2 动态门槛的分类元信息（Spec v2 §4）。
	GovernanceLevel string
	Category        string
	CircleID        string
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
const proposalColumns = `proposal_id,action,item_id,proposer_id,reason,title,body_md,COALESCE(links_json,''),COALESCE(tags_json,''),COALESCE(dist_class,''),COALESCE(instructor,''),base_content_hash,created_at,executed_at,voided_at,executed_result,COALESCE(source_event_id,''),content_version,revoked_rev,COALESCE(governance_level,'base'),COALESCE(category,''),COALESCE(circle_id,'')`

// rowScanner 抽象 *sql.Row 与 *sql.Rows 的 Scan。
type rowScanner interface{ Scan(dest ...any) error }

func scanProposal(sc rowScanner) (Proposal, error) {
	var p Proposal
	err := sc.Scan(&p.ProposalID, &p.Action, &p.ItemID, &p.ProposerID, &p.Reason, &p.Title, &p.BodyMD,
		&p.LinksJSON, &p.TagsJSON, &p.DistClass, &p.Instructor, &p.BaseContentHash, &p.CreatedAt, &p.ExecutedAt, &p.VoidedAt, &p.ExecutedResult,
		&p.SourceEventID, &p.ContentVersion, &p.RevokedRev,
		&p.GovernanceLevel, &p.Category, &p.CircleID)
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
// Spec v2 §3.5 新增免票选快速路径：创建提案前先调 shouldFreeExec，如果作者本人 + 无互动 + active 条目 →
// 跳过投票管线，直接执行 governApplyTx 并记 executed_at=now。governed_result 记 "free_exec" 区分于
// 投票生效的 executed_result。前置条件（content_hash 匹配 / state 匹配）仍会过——漂移即记 voided_at。
//
// 正常路径：刻意**不做**生效判定：门槛最小为 2（册子 §2.1），此刻有效票恒为 1，判定必然 pending。
func (s *Store) CreateProposal(p Proposal) (int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()

	// ============ Spec v2 §3.5 免票选快速路径 ============
	free, ferr := shouldFreeExec(tx, p.ItemID, p.ProposerID, p.Action)
	if ferr != nil {
		// 查询异常 fail-closed：退回正常投票路径
		free = false
	}
	if free {
		now := time.Now().UnixMilli()
		// 跑前置条件（防止 content_hash 漂移或 state 突变）
		met, err := governPreconditionTx(tx, p)
		if err != nil {
			return 0, err
		}
		cv, _ := contentVersionTx(tx)
		rv, _ := maxRevokedRevTx(tx)
		if !met {
			// 前置不满足 → 直接记 void 提案，不执行
			res, err := tx.Exec(`INSERT INTO govern_proposals(action,item_id,proposer_id,reason,title,body_md,links_json,tags_json,dist_class,instructor,base_content_hash,created_at,voided_at,content_version,revoked_rev,governance_level,category,circle_id)
				VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				p.Action, p.ItemID, p.ProposerID, p.Reason, p.Title, p.BodyMD, p.LinksJSON,
				p.TagsJSON, p.DistClass, p.Instructor,
				p.BaseContentHash, p.CreatedAt, now, cv, rv,
				p.GovernanceLevel, p.Category, p.CircleID)
			if err != nil {
				return 0, fmt.Errorf("store: 写免票选 void 提案: %w", err)
			}
			id, _ := res.LastInsertId()
			return id, tx.Commit()
		}
		// 前置满足 → 直接执行动作
		result, err := governApplyTx(tx, s, p)
		if err != nil {
			return 0, err
		}
		res, err := tx.Exec(`INSERT INTO govern_proposals(action,item_id,proposer_id,reason,title,body_md,links_json,tags_json,dist_class,instructor,base_content_hash,created_at,executed_at,executed_result,content_version,revoked_rev,governance_level,category,circle_id)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			p.Action, p.ItemID, p.ProposerID, p.Reason, p.Title, p.BodyMD, p.LinksJSON,
			p.TagsJSON, p.DistClass, p.Instructor,
			p.BaseContentHash, p.CreatedAt, now, "free_exec:"+result, cv, rv,
			p.GovernanceLevel, p.Category, p.CircleID)
		if err != nil {
			return 0, fmt.Errorf("store: 写免票选已执行提案: %w", err)
		}
		id, _ := res.LastInsertId()
		return id, tx.Commit()
	}

	// ============ 正常投票路径 ============
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
	res, err := tx.Exec(`INSERT INTO govern_proposals(action,item_id,proposer_id,reason,title,body_md,links_json,tags_json,dist_class,instructor,base_content_hash,created_at,content_version,revoked_rev,governance_level,category,circle_id)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		p.Action, p.ItemID, p.ProposerID, p.Reason, p.Title, p.BodyMD, p.LinksJSON,
		p.TagsJSON, p.DistClass, p.Instructor,
		p.BaseContentHash, p.CreatedAt, cv, rv,
		p.GovernanceLevel, p.Category, p.CircleID)
	if err != nil {
		return 0, fmt.Errorf("store: 写提案: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	// V2: 提案人自投固定 vote_weight=1, vote_type='approve'，写 date 便于每日配额查询。
	selfVoteDate := time.UnixMilli(p.CreatedAt).Format("2006-01-02")
	if _, err := tx.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,vote_weight,vote_type,date,created_at) VALUES(?,?,?,?,?,?)`,
		id, p.ProposerID, 1, "approve", selfVoteDate, p.CreatedAt); err != nil {
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
	res, err := tx.Exec(`INSERT INTO govern_proposals(action,item_id,proposer_id,reason,title,body_md,links_json,tags_json,dist_class,instructor,base_content_hash,created_at,content_version,revoked_rev,governance_level,category,circle_id)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		p.Action, p.ItemID, p.ProposerID, p.Reason, p.Title, p.BodyMD, p.LinksJSON,
		p.TagsJSON, p.DistClass, p.Instructor,
		p.BaseContentHash, p.CreatedAt, cv, rv,
		p.GovernanceLevel, p.Category, p.CircleID)
	if err != nil {
		return 0, "", fmt.Errorf("store: 写目录提案: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, "", err
	}
	selfVoteDate := time.UnixMilli(p.CreatedAt).Format("2006-01-02")
	if _, err := tx.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,vote_weight,vote_type,date,created_at) VALUES(?,?,?,?,?,?)`,
		id, p.ProposerID, 1, "approve", selfVoteDate, p.CreatedAt); err != nil {
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
			Threshold: governThresholdLegacy(p.Action),
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

// addVoteTx 是 AddVote 的事务体（legacy）。
func addVoteTx(tx *sql.Tx, st *Store, proposalID int64, voterID string, roster map[string]bool) (VoteResult, error) {
	now := time.Now().UnixMilli()
	// 先检查是否已投票（V2 schema 下无唯一约束，需手动查）
	var exists int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM govern_votes WHERE proposal_id=? AND voter_id=?`, proposalID, voterID).Scan(&exists); err != nil {
		return VoteResult{}, fmt.Errorf("store: 查票: %w", err)
	}
	if exists > 0 {
		return VoteResult{}, ErrAlreadyVoted
	}
	if _, err := tx.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,created_at) VALUES(?,?,?)`, proposalID, voterID, now); err != nil {
		return VoteResult{}, fmt.Errorf("store: 写票: %w", err)
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
	// 免票选删除（本册 §5）：remove 提案若可免票选，门槛降为 0 并立即生效。
	// 用 **tx** 判定（本函数已在事务内，走 exec 版本查询符合 SetMaxOpenConns(1)）；异常 fail-closed 退回 3 票。
	freeResult := ""
	if p.Action == GovernActionRemove {
		if free, ferr := freeRemoveEligible(tx, p.ItemID, p.ProposerID); ferr == nil && free {
			out.Threshold = 0
			freeResult = freeRemoveExecutedResult
		}
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
	if freeResult != "" {
		result = freeResult // 免票选删除：executed_result 记 'free_remove'（仅诊断）
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

	// ============ Spec v2 §3 新增治理动作 ============
	case GovernActionEditTitle:
		// 只改 items.title，正文未变 → content_hash / 归属两列原样保留。
		if _, err := tx.Exec(`UPDATE items SET title=? WHERE item_id=?`, p.Title, p.ItemID); err != nil {
			return "", fmt.Errorf("store: edit_title %s: %w", p.ItemID, err)
		}
		return "edited_title", nil

	case GovernActionEditBody:
		// 先查载体，只对 article 生效；video/quiz 等载体没有 body_md 可改。
		var sqliteTable string
		if err := tx.QueryRow(`SELECT sqlite_table FROM items WHERE item_id=?`, p.ItemID).Scan(&sqliteTable); err != nil {
			return "", fmt.Errorf("store: 读 items 载体 %s: %w", p.ItemID, err)
		}
		if sqliteTable != "articles" {
			return "", fmt.Errorf("store: edit_body 仅支持 article 载体，不支持 %s", sqliteTable)
		}
		hash := protocol.SHA256Hex([]byte(p.BodyMD))
		bodyEnc, err := st.encText(p.BodyMD)
		if err != nil {
			return "", fmt.Errorf("store: 加密改写正文 %s: %w", p.ItemID, err)
		}
		if _, err := tx.Exec(`UPDATE articles SET body_md=?,content_hash=?,source_rev=? WHERE item_id=?`,
			bodyEnc, hash, hash[:16], p.ItemID); err != nil {
			return "", fmt.Errorf("store: edit_body articles %s: %w", p.ItemID, err)
		}
		// 正文改动 → 清署（与 GovernActionEdit 改正文同逻辑，册子 §4.2 的数学推论）。
		if _, err := tx.Exec(`UPDATE items SET content_hash=?,source_rev=?,updated_at=?,author_id='',author_sig='' WHERE item_id=?`,
			hash, hash[:16], nowUTC(), p.ItemID); err != nil {
			return "", fmt.Errorf("store: edit_body items %s: %w", p.ItemID, err)
		}
		return "edited_body_author_cleared", nil

	case GovernActionEditCategory:
		if _, err := tx.Exec(`UPDATE items SET dist_class=? WHERE item_id=?`, p.DistClass, p.ItemID); err != nil {
			return "", fmt.Errorf("store: edit_category %s: %w", p.ItemID, err)
		}
		return "edited_category", nil

	case GovernActionEditTags:
		if _, err := tx.Exec(`UPDATE items SET tags_json=? WHERE item_id=?`, p.TagsJSON, p.ItemID); err != nil {
			return "", fmt.Errorf("store: edit_tags %s: %w", p.ItemID, err)
		}
		return "edited_tags", nil

	case GovernActionEditInstructor:
		if _, err := tx.Exec(`UPDATE items SET instructor=? WHERE item_id=?`, p.Instructor, p.ItemID); err != nil {
			return "", fmt.Errorf("store: edit_instructor %s: %w", p.ItemID, err)
		}
		return "edited_instructor", nil

	case GovernActionHighlight:
		return setPinLevelTx(tx, p.ItemID, 1)
	case GovernActionPin:
		return setPinLevelTx(tx, p.ItemID, 2)
	case GovernActionRecommend:
		return setPinLevelTx(tx, p.ItemID, 3)
	case GovernActionFeature:
		return setPinLevelTx(tx, p.ItemID, 4)

	default:
		return "", fmt.Errorf("store: 不支持的治理动作 %q", p.Action)
	}
}

// setPinLevelTx 在事务内给条目设置 pin_level + pinned_at。
func setPinLevelTx(tx *sql.Tx, itemID string, level int) (string, error) {
	now := time.Now().UnixMilli()
	res, err := tx.Exec(`UPDATE items SET pin_level=?,pinned_at=? WHERE item_id=?`, level, now, itemID)
	if err != nil {
		return "", fmt.Errorf("store: set pin_level %d: %w", level, err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return "", sql.ErrNoRows
	}
	return fmt.Sprintf("pin_level_%d", level), nil
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

// ============ V2 投票管线（治理重构 Spec v2 §4）============

// VoteResultV2 是 V2 投票管线的返回结构（Spec v2 §4）。
type VoteResultV2 struct {
	ProposalID    int64  `json:"proposal_id"`
	VoterCount    int    `json:"voter_count"`    // 独立 voter 总数
	Quorum        int    `json:"quorum"`         // 当前法定人数
	Threshold     int    `json:"threshold"`      // 当前门槛公式值
	ApproveWeight int    `json:"approve_weight"` // 赞成票权总和
	RejectWeight  int    `json:"reject_weight"`  // 反对票权总和
	NetWeight     int    `json:"net_weight"`     // 净票权 = approve - reject
	Status        string `json:"status"`         // pending | effective | void
}

// AddVoteV2 投一票。voteType: "approve" | "reject"；voteWeight: 1~10（普通用户强制 1）。
// 两阶段判定：阶段 1 voter_count ≥ quorum → 阶段 2 净票权 = approve − reject > 0。
// 贡献层投 vote_weight ≥ 2 时受每日 20 票权配额约束；贡献层对单条目累计 ≤ 10。
func (s *Store) AddVoteV2(proposalID int64, voterID string, voteWeight int, voteType string) (VoteResultV2, error) {
	// 1. 参数校验
	if voteType != "approve" && voteType != "reject" {
		return VoteResultV2{}, fmt.Errorf("invalid vote_type: %s (need approve|reject)", voteType)
	}
	if voteWeight < 1 || voteWeight > 10 {
		return VoteResultV2{}, fmt.Errorf("vote_weight must be [1,10], got %d", voteWeight)
	}

	// 2. 查提案
	p, ok, err := s.GetProposal(proposalID)
	if err != nil {
		return VoteResultV2{}, err
	}
	if !ok {
		return VoteResultV2{}, fmt.Errorf("proposal not found: %d", proposalID)
	}
	if p.ExecutedAt != 0 || p.VoidedAt != 0 {
		return VoteResultV2{}, fmt.Errorf("proposal already settled (status=%s)", ProposalStatus(p.ExecutedAt, p.VoidedAt))
	}

	// 3. 贡献层资格判定
	roster, err := s.DeriveContributionRoster()
	if err != nil {
		// 名册派生失败按空名册降级（fail-closed 对资格判定）：非贡献者路径强制 voteWeight=1。
		// 但配额检查只会对贡献者发生，所以空名册下自然跳过。
	}
	isContributor := err == nil && slices.Contains(roster, voterID)

	// 4. 普通用户强制 voteWeight=1
	if !isContributor {
		voteWeight = 1
	}

	// 5. 贡献层配额检查
	if isContributor && voteWeight >= 2 {
		// 5a. 每日 20 票权配额（投 >= 2 权的累计）
		today := time.Now().Format("2006-01-02")
		var usedDaily int
		if err := s.db.QueryRow(`SELECT COALESCE(SUM(vote_weight),0) FROM govern_votes
			WHERE voter_id=? AND date=? AND vote_weight >= 2`, voterID, today).Scan(&usedDaily); err != nil {
			return VoteResultV2{}, fmt.Errorf("quota check: %w", err)
		}
		if usedDaily+voteWeight > 20 {
			return VoteResultV2{}, fmt.Errorf("quota_exceeded: daily contribution quota=%d, used=%d, add=%d", 20, usedDaily, voteWeight)
		}
	}

	// 6. 单条目累计检查（贡献层，累计 ≤ 10）
	if isContributor {
		var usedItem int
		if err := s.db.QueryRow(`SELECT COALESCE(SUM(vote_weight),0) FROM govern_votes
			WHERE voter_id=? AND proposal_id=?`, voterID, proposalID).Scan(&usedItem); err != nil {
			return VoteResultV2{}, fmt.Errorf("per-item quota check: %w", err)
		}
		if usedItem+voteWeight > 10 {
			return VoteResultV2{}, fmt.Errorf("per_item_quota_exceeded: per-item limit=10, used=%d, add=%d", usedItem, voteWeight)
		}
	}

	// 7. 事务内写票 + 两阶段判定
	return s.addVoteTxV2(proposalID, voterID, voteWeight, voteType, p.GovernanceLevel, p.ItemID, p.ProposerID)
}

// addVoteTxV2 是 AddVoteV2 的事务体。
//
// 两阶段判定（Spec v2 §4）：
//   阶段 1：独立 voter_count ≥ quorum → 进入阶段 2；否则 pending。
//   阶段 2：计算净票权 = approve_weight − reject_weight；> 0 则执行生效（需过 governPreconditionTx），≤ 0 则 void。
//
// governanceLevel 决定 base/enhanced 门槛公式；itemID + proposerID 用于实时算 P / F。
func (s *Store) addVoteTxV2(proposalID int64, voterID string, voteWeight int, voteType, governanceLevel, itemID, proposerID string) (VoteResultV2, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return VoteResultV2{}, err
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UnixMilli()
	date := time.Now().Format("2006-01-02")

	// Step A: 写 govern_votes
	if _, err := tx.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,vote_weight,vote_type,date,created_at)
		VALUES(?,?,?,?,?,?)`,
		proposalID, voterID, voteWeight, voteType, date, now); err != nil {
		return VoteResultV2{}, fmt.Errorf("insert vote: %w", err)
	}

	// Step B: 读提案（事务内）
	p, err := scanProposal(tx.QueryRow(`SELECT `+proposalColumns+` FROM govern_proposals WHERE proposal_id=?`, proposalID))
	if err != nil {
		return VoteResultV2{}, fmt.Errorf("scan proposal: %w", err)
	}

	// Step C: 实时计算 m（活跃 7 天用户数）
	var m int
	sevenDaysMs := int64(7 * 24 * 60 * 60 * 1000)
	if err := tx.QueryRow(`SELECT COUNT(DISTINCT id) FROM identities WHERE last_seen_at > ?`, now-sevenDaysMs).Scan(&m); err != nil {
		return VoteResultV2{}, fmt.Errorf("count active users: %w", err)
	}

	// Step D: 实时计算 P + F（去重，排除 author/proposer）
	var P, F int
	if itemID != "" {
		if err := tx.QueryRow(`SELECT COUNT(DISTINCT id) FROM progress WHERE item_id=? AND id != ?`, itemID, proposerID).Scan(&P); err != nil {
			return VoteResultV2{}, fmt.Errorf("count progress: %w", err)
		}
		if err := tx.QueryRow(`SELECT COUNT(DISTINCT id) FROM favorites WHERE item_id=? AND id != ?`, itemID, proposerID).Scan(&F); err != nil {
			return VoteResultV2{}, fmt.Errorf("count favorites: %w", err)
		}
	}

	// Step E: 门槛 + quorum
	threshold := GovernThreshold(governanceLevel, m, P, F)
	quorum := GovernQuorum(threshold, m)

	// Step F: 独立 voter 数（不管 vote_type）
	var voterCount int
	if err := tx.QueryRow(`SELECT COUNT(DISTINCT voter_id) FROM govern_votes WHERE proposal_id=?`, proposalID).Scan(&voterCount); err != nil {
		return VoteResultV2{}, fmt.Errorf("count voters: %w", err)
	}

	// Step G: 阶段 1 — quorum 未达 → pending
	if voterCount < quorum {
		tx.Commit()
		return VoteResultV2{
			ProposalID: proposalID, VoterCount: voterCount,
			Quorum: quorum, Threshold: threshold, Status: "pending",
		}, nil
	}

	// Step H: 进入阶段 2 — 净票权
	var approveSum, rejectSum int
	if err := tx.QueryRow(`SELECT
		COALESCE(SUM(CASE WHEN vote_type='approve' THEN vote_weight ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN vote_type='reject' THEN vote_weight ELSE 0 END),0)
		FROM govern_votes WHERE proposal_id=?`, proposalID).Scan(&approveSum, &rejectSum); err != nil {
		return VoteResultV2{}, fmt.Errorf("sum vote weights: %w", err)
	}
	net := NetWeight(approveSum, rejectSum)

	out := VoteResultV2{
		ProposalID: proposalID, VoterCount: voterCount,
		Quorum: quorum, Threshold: threshold,
		ApproveWeight: approveSum, RejectWeight: rejectSum, NetWeight: net,
	}

	if net <= 0 {
		// 失败 → void
		if _, err := tx.Exec(`UPDATE govern_proposals SET voided_at=? WHERE proposal_id=?`, now, proposalID); err != nil {
			return VoteResultV2{}, fmt.Errorf("mark void: %w", err)
		}
		out.Status = "void"
		tx.Commit()
		return out, nil
	}

	// net > 0 — 跑前置条件 + 执行动作
	met, err := governPreconditionTx(tx, p)
	if err != nil {
		return VoteResultV2{}, err
	}
	if !met {
		if _, err := tx.Exec(`UPDATE govern_proposals SET voided_at=? WHERE proposal_id=?`, now, proposalID); err != nil {
			return VoteResultV2{}, fmt.Errorf("mark void (precondition): %w", err)
		}
		out.Status = "void"
		tx.Commit()
		return out, nil
	}

	result, err := governApplyTx(tx, s, p)
	if err != nil {
		return VoteResultV2{}, err
	}
	if _, err := tx.Exec(`UPDATE govern_proposals SET executed_at=?,executed_result=? WHERE proposal_id=?`, now, result, proposalID); err != nil {
		return VoteResultV2{}, fmt.Errorf("mark executed: %w", err)
	}
	out.Status = "effective"
	return out, tx.Commit()
}
