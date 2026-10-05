package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// freeRemoveExecutedResult 是免票选删除生效后的 executed_result（诊断信息，不构成契约，本册 §5）。
const freeRemoveExecutedResult = "free_remove"

// shouldFreeExec 判定某治理提案是否可不经票选直接执行（Spec v2 §3.5 免票选重写）。
// 判据（全部满足才返回 true，fail-open 查询异常返回 false）：
//  1. action != directory_add（目录条款永远不免票选）
//  2. items.author_id == proposerID（作者本人）
//  3. items.state == 'active'（目标条目必须 active）
//  4. P = 0 — progress 中无他人学习（course 容器扩展到 course + 所有 lessons）
//  5. F = 0 — favorites 中无他人收藏（course 容器扩展到 course + 所有 lessons）
// 免票选仅适用于 active 条目（所有 pin/edit 类 action 的 GovernRequiredState 都是 active）；
// remove 动作也可用免票选（同老 freeRemoveEligible 语义，只是范围更广不限于容器）。
func shouldFreeExec(e sqlExec, itemID, proposerID, action string) (bool, error) {
	// 1. 目录条款永不免票选
	if action == GovernActionDirectoryAdd {
		return false, nil
	}
	// 2+3: 读 items.author_id + state
	var authorID, state string
	err := e.QueryRow(`SELECT author_id,state FROM items WHERE item_id=?`, itemID).Scan(&authorID, &state)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("store: shouldFreeExec 读 items: %w", err)
	}
	// 必须有归属（导入/老数据 author_id 为空 → 不免）且与 proposer 一致
	if authorID == "" || authorID != proposerID {
		return false, nil
	}
	if state != "active" {
		return false, nil
	}
	// 构造 progress/favorites 的查询范围：目标自身 + course 容器的所有 lessons
	targets := []string{itemID}
	if isCourseID(itemID) {
		lessons, lerr := courseLessonIDs(e, itemID)
		if lerr != nil {
			return false, lerr
		}
		targets = append(targets, lessons...)
	}
	// 4: P = 0（无他人学习，course 容器查 course + 所有 lessons）
	P, perr := otherLearnerCount(e, targets, proposerID)
	if perr != nil {
		return false, perr
	}
	if P > 0 {
		return false, nil
	}
	// 5: F = 0（无他人收藏 —— 同容器范围）
	otherFavs, ferr := otherFavoriteCount(e, targets, proposerID)
	if ferr != nil {
		return false, ferr
	}
	if otherFavs > 0 {
		return false, nil
	}
	return true, nil
}

// otherFavoriteCount 统计 favorites 中「item_id IN targets 且 id != proposer」的行数。
func otherFavoriteCount(e sqlExec, targets []string, proposer string) (int, error) {
	placeholders := make([]string, len(targets))
	args := make([]any, 0, len(targets)+1)
	for i, id := range targets {
		placeholders[i] = "?"
		args = append(args, id)
	}
	args = append(args, proposer)
	q := `SELECT COUNT(*) FROM favorites WHERE item_id IN (` + strings.Join(placeholders, ",") + `) AND id<>?`
	var n int
	if err := e.QueryRow(q, args...).Scan(&n); err != nil {
		return 0, fmt.Errorf("store: 统计他人收藏: %w", err)
	}
	return n, nil
}

// freeRemoveEligible 判定一条 remove 提案是否可不经票选直接生效（本册 §5「免票选自由删除」）。
// Deprecated: Spec v2 §3.5 已被 shouldFreeExec 取代（适用所有 action，不再仅限 remove 且仅限容器）。
// 保留以兼容老投票路径（addVoteTx 里的 remove 免票选旁路）；新代码统一走 shouldFreeExec。
//
// 判据（顺序即短路顺序）：
//  1. 目标须是容器（course/<cid> 或 course/<cid>/lesson/<lid>），否则 false；
//  2. actor 必须是创建者：items.author_id 为空（导入器产出 / 老数据）或不等于 actor ⇒ false；
//  3. course 且无任何 seq>=1 行（无课时）⇒ true（**短路**，不再查 progress）；
//  4. 否则：progress 中 item_id ∈ {目标自身 ∪ 课程全部课时 id} 且 id != actor 的行为空 ⇒ true。
//
// 课时（条件 3 不适用）退化为只看条件 4。任何查询异常 ⇒ 返回 error，调用方 fail-closed 退回既有 3 票。
// 第一参数取 sqlExec：settle 传 s.db（事务外）、vote 传 tx（事务内）——SetMaxOpenConns(1) 下两者不可互换。
func freeRemoveEligible(e sqlExec, itemID, actor string) (bool, error) {
	if !isCourseID(itemID) && !isLessonID(itemID) {
		return false, nil
	}
	// 条件 2：创建者判定。
	var authorID string
	err := e.QueryRow(`SELECT author_id FROM items WHERE item_id=?`, itemID).Scan(&authorID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("store: 读创建者 %s: %w", itemID, err)
	}
	if authorID == "" || authorID != actor {
		return false, nil
	}
	targets := []string{itemID}
	if isCourseID(itemID) {
		lessons, err := courseLessonIDs(e, itemID)
		if err != nil {
			return false, err
		}
		// 条件 3：无课时 ⇒ true（短路跳过 progress 检查）。
		if len(lessons) == 0 {
			return true, nil
		}
		targets = append(targets, lessons...)
	}
	// 条件 4：无他人学习。
	others, err := otherLearnerCount(e, targets, actor)
	if err != nil {
		return false, err
	}
	return others == 0, nil
}

// isCourseID 判 item_id 是否为 course/<cid>（两段）。
func isCourseID(itemID string) bool {
	parts := strings.Split(itemID, "/")
	return len(parts) == 2 && parts[0] == "course" && parts[1] != ""
}

// isLessonID 判 item_id 是否为 course/<cid>/lesson/<lid>（四段）。
func isLessonID(itemID string) bool {
	parts := strings.Split(itemID, "/")
	return len(parts) == 4 && parts[0] == "course" && parts[2] == "lesson" && parts[1] != "" && parts[3] != ""
}

// courseLessonIDs 读一门课程的全部课时 id（segments 中 seq>=1 行的 text，按 seq 升序）。
func courseLessonIDs(e sqlExec, courseID string) ([]string, error) {
	rows, err := e.Query(`SELECT text FROM segments WHERE item_id=? AND seq>=1 ORDER BY seq ASC`, courseID)
	if err != nil {
		return nil, fmt.Errorf("store: 读课时清单 %s: %w", courseID, err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// otherLearnerCount 统计 progress 中「item_id ∈ targets 且 id != actor」的行数。
func otherLearnerCount(e sqlExec, targets []string, actor string) (int, error) {
	placeholders := make([]string, len(targets))
	args := make([]any, 0, len(targets)+1)
	for i, id := range targets {
		placeholders[i] = "?"
		args = append(args, id)
	}
	args = append(args, actor)
	q := `SELECT COUNT(*) FROM progress WHERE item_id IN (` + strings.Join(placeholders, ",") + `) AND id<>?`
	var n int
	if err := e.QueryRow(q, args...).Scan(&n); err != nil {
		return 0, fmt.Errorf("store: 统计他人学习: %w", err)
	}
	return n, nil
}
