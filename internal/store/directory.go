package store

import (
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/johocn/base/internal/protocol"
)

// 目录词条的 kind 三值（册子 #58 §2.1）。
const (
	DirectoryKindCategory   = "category"
	DirectoryKindInstructor = "instructor"
	DirectoryKindTag        = "tag"
)

// 目录词条的两个状态（册子 #58 §2.1）。
const (
	DirectoryStateApproved = "approved"
	DirectoryStatePending  = "pending"
)

// TermKeyMaxRunes 是词条键的 rune 上限（册子 #58 §2.2 步 6，与 #37 标签段同上限）。
const TermKeyMaxRunes = 64

// metaDirectorySeeded 标记存量词条 seed 已完成（幂等短路键，册子 #58 §2.3）。
const metaDirectorySeeded = "directory_seeded"

// DirectoryTerm 是 directory_terms 的一行（册子 #58 §2.1）。
type DirectoryTerm struct {
	Kind          string
	TermKey       string
	DisplayName   string
	State         string
	FirstAuthorID string
	CreatedAt     string
	UpdatedAt     string
}

// NormalizeTermKey 按册子 #58 §2.2 六步规范化词条键（双端同构）。ok=false 表示结果非法。
//
// 顺序定死：TrimSpace → 全角折半角 → 空白折叠 → ASCII 小写 → 剥离控制字符 → 长度 1..64 rune。
// 不做 Unicode NFC 归一化（仓库无 golang.org/x/text，与 #37/#38 的收窄口径一致）。
func NormalizeTermKey(raw string) (string, bool) {
	s := foldFullWidthASCII(strings.TrimSpace(raw))
	s = collapseSpaces(s)
	s = foldASCIILower(s)
	s = stripControl(s)
	n := utf8.RuneCountInString(s)
	if n < 1 || n > TermKeyMaxRunes {
		return "", false
	}
	return s, true
}

// CleanDisplayName 清洗展示名：stripControl(collapseSpaces(TrimSpace(raw)))。
// **故意不做全角折叠与大小写折叠**——展示名保留原文（含全角、大小写），便于阅读（册子 §2.2）。
func CleanDisplayName(raw string) string {
	return stripControl(collapseSpaces(strings.TrimSpace(raw)))
}

// foldFullWidthASCII 把全角可见字符（U+FF01..U+FF5E）折为半角，全角空格 U+3000 折为半角空格（§2.2 步 2）。
func foldFullWidthASCII(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r >= 0xFF01 && r <= 0xFF5E:
			b.WriteRune(r - 0xFEE0)
		case r == 0x3000:
			b.WriteRune(' ')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// collapseSpaces 把连续空白折叠为单个半角空格（§2.2 步 3）。
func collapseSpaces(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			if !prevSpace {
				b.WriteRune(' ')
				prevSpace = true
			}
			continue
		}
		b.WriteRune(r)
		prevSpace = false
	}
	return b.String()
}

// foldASCIILower 只折 ASCII 大写字母为小写（§2.2 步 4）；非 ASCII 字符不动。
func foldASCIILower(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r >= 'A' && r <= 'Z' {
			r += 'a' - 'A'
		}
		b.WriteRune(r)
	}
	return b.String()
}

// stripControl 剥离控制字符 U+0000–U+001F 与 U+007F（§2.2 步 5）。
func stripControl(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if (r >= 0x00 && r <= 0x1F) || r == 0x7F {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// DirectoryPayloadHash 是 (kind,term_key) 的载荷哈希（64 hex，纯 ASCII）。
// **导出**：httpapi 写路径与事件校验要按同一公式计算，双端必须逐字节同构（决策 1）。
func DirectoryPayloadHash(kind, termKey string) string {
	return protocol.SHA256Hex([]byte("dir\x00" + kind + "\x00" + termKey))
}

// DirectoryProposalItemID 由 (kind,term_key) 确定性派生提案 item_id：dir/<kind>/<hash16>。
// 纯 ASCII 且 ≤256 字节，满足 validTargetID 约束（册子 §3.3）；term_key 不落进路径，避免中文非法。
func DirectoryProposalItemID(kind, termKey string) string {
	return "dir/" + kind + "/" + DirectoryPayloadHash(kind, termKey)[:16]
}

// DirectoryKindOfItemID 反向解析 item_id = dir/<kind>/<hash16>；形态不符返回 ("",false)。
func DirectoryKindOfItemID(itemID string) (string, bool) {
	parts := strings.Split(itemID, "/")
	if len(parts) != 3 || parts[0] != "dir" || parts[1] == "" || parts[2] == "" {
		return "", false
	}
	return parts[1], true
}

// directoryTermColumns 的列顺序必须与 scanDirectoryTerm 的 Scan 参数一一对应。
const directoryTermColumns = `kind,term_key,display_name,state,first_author_id,created_at,updated_at`

// rowScan 抽象 *sql.Row 与 *sql.Rows 的 Scan（本包已有 rowScanner，此处直接复用）。
func scanDirectoryTerm(sc rowScanner) (DirectoryTerm, error) {
	var t DirectoryTerm
	err := sc.Scan(&t.Kind, &t.TermKey, &t.DisplayName, &t.State, &t.FirstAuthorID, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

// GetDirectoryTerm 读取单个词条；不存在返回 ok=false（册子 §3.3 同键归并的 approved 短路）。
func (s *Store) GetDirectoryTerm(kind, termKey string) (DirectoryTerm, bool, error) {
	t, err := scanDirectoryTerm(s.db.QueryRow(`SELECT `+directoryTermColumns+` FROM directory_terms WHERE kind=? AND term_key=?`, kind, termKey))
	if errors.Is(err, sql.ErrNoRows) {
		return DirectoryTerm{}, false, nil
	}
	if err != nil {
		return DirectoryTerm{}, false, err
	}
	return t, true, nil
}

// ListDirectory 按 (kind,term_key) 升序返回全部词条，按 state 分流 approved / pending。
// 空结果返回非 nil 空切片（响应侧要输出 [] 而非 null）；pending 项的票数 / 门槛由调用方补。
func (s *Store) ListDirectory() (approved, pending []DirectoryTerm, err error) {
	rows, err := s.db.Query(`SELECT ` + directoryTermColumns + ` FROM directory_terms ORDER BY kind ASC, term_key ASC`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	approved = []DirectoryTerm{}
	pending = []DirectoryTerm{}
	for rows.Next() {
		t, err := scanDirectoryTerm(rows)
		if err != nil {
			return nil, nil, err
		}
		if t.State == DirectoryStateApproved {
			approved = append(approved, t)
		} else {
			// 非 approved 一律按 pending（fail-closed：宁可显示待票选，也不误显示已通过）。
			pending = append(pending, t)
		}
	}
	return approved, pending, rows.Err()
}

// DirectoryVersion 读取当前目录版本（meta 缺省视为 0，册子 §4.1）。
func (s *Store) DirectoryVersion() (int64, error) {
	var raw string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key=?`, metaDirectoryVersion).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("store: bad directory_version %q", raw)
	}
	return n, nil
}

// FindPendingDirectoryProposal 查 (kind,term_key) 对应的**未定案**目录提案 id（册子 §3.3 同键归并）。
// item_id 由 (kind,term_key) 确定性派生，故无需额外索引；未定案 = executed_at=0 AND voided_at=0。
func (s *Store) FindPendingDirectoryProposal(itemID string) (int64, bool, error) {
	var pid int64
	err := s.db.QueryRow(`SELECT proposal_id FROM govern_proposals
		WHERE item_id=? AND executed_at=0 AND voided_at=0 ORDER BY proposal_id ASC LIMIT 1`, itemID).Scan(&pid)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return pid, true, nil
}

// DirectoryPendingVotes 返回词条对应 pending 提案的**名册内有效票数**（册子 §4.1 响应体的 votes）。
// 票权按提案快照水位复算（复用 filterRosterAtWatermarkSet，与 ListProposalViews 同口径）。
// 无 pending 提案 ⇒ 0。**全在 s.db 上，事务内不得调用**（单连接池会死锁）。
func (s *Store) DirectoryPendingVotes(itemID string, roster map[string]bool) (int, error) {
	pid, ok, err := s.FindPendingDirectoryProposal(itemID)
	if err != nil || !ok {
		return 0, err
	}
	p, err := scanProposal(s.db.QueryRow(`SELECT `+proposalColumns+` FROM govern_proposals WHERE proposal_id=?`, pid))
	if err != nil {
		return 0, err
	}
	voters, err := proposalVotersExec(s.db, pid)
	if err != nil {
		return 0, err
	}
	restored, err := s.restoredRosterAuthors(p.RevokedRev)
	if err != nil {
		return 0, err
	}
	return len(filterRosterAtWatermarkSet(voters, roster, restored)), nil
}

// upsertDirectoryTermExec 幂等写入词条（sqlExec，事务内可调用）。
// **first_author_id 保留首次值**（冲突时不覆盖，册子 §2.1「首次提交者」）；display_name/state/updated_at 以本次为准。
func upsertDirectoryTermExec(e sqlExec, kind, termKey, display, author, state, now string) error {
	_, err := e.Exec(`INSERT INTO directory_terms(kind,term_key,display_name,state,first_author_id,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(kind,term_key) DO UPDATE SET
			display_name=excluded.display_name, state=excluded.state, updated_at=excluded.updated_at`,
		kind, termKey, display, state, author, now, now)
	if err != nil {
		return fmt.Errorf("store: 写目录词条 %s/%s: %w", kind, termKey, err)
	}
	return nil
}

// approveDirectoryTermExec 把词条置为 approved（册子 §3.2/§3.4 生效分支），事务内可调用。
func approveDirectoryTermExec(e sqlExec, kind, termKey, display, author string) error {
	return upsertDirectoryTermExec(e, kind, termKey, display, author, DirectoryStateApproved, nowUTC())
}

// bumpDirectoryVersionExec 递增目录版本并返回新值（缺省 0 起，首次 bump 得 1）。
// 照 nextContentVersionExec 体例的「读-自增-写」，对 meta.directory_version 操作（册子 §4.1）。
func bumpDirectoryVersionExec(e sqlExec) (int64, error) {
	cur := int64(0)
	var raw string
	err := e.QueryRow(`SELECT value FROM meta WHERE key=?`, metaDirectoryVersion).Scan(&raw)
	if err == nil {
		cur, err = strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("store: bad directory_version %q", raw)
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	next := cur + 1
	if _, err := e.Exec(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
		metaDirectoryVersion, strconv.FormatInt(next, 10)); err != nil {
		return 0, err
	}
	return next, nil
}

// seedDirectoryFromExisting 把存量内容里已经存在的分类/讲师/标签名称一次性登记为 approved 词条
// （册子 #58 §2.3）。幂等：靠 meta 键 directory_seeded 短路；失败由调用方记日志、不阻断 Open。
//
// 采三组名称（kind, term_key 归并去重，同键只写一次）：
//   - attr.category / attr.instructor：segments.seq<0 的属性取值，名称取 text；
//   - 分类容器 slug：items.source='category' 的 item_id 去 'category/' 前缀；
//   - 标签名称段：items.item_id LIKE 'tag/%' 的第二段。
//
// 只有确有写入（≥1 条）时才 bumpDirectoryVersionExec 一次并落 directory_seeded；
// 空库/全新安装一条都没有则不 bump、也不落短路键，避免无谓 churn，也让后续补入的存量内容仍能被 seed。
func seedDirectoryFromExisting(db *sql.DB) error {
	// 幂等短路：收 *sql.DB（不能用 Store 方法），故裸 SQL 读 meta。ErrNoRows 视为未 seed。
	var seeded string
	err := db.QueryRow(`SELECT value FROM meta WHERE key=?`, metaDirectorySeeded).Scan(&seeded)
	switch {
	case err == nil:
		if seeded != "" {
			return nil
		}
	case errors.Is(err, sql.ErrNoRows):
		// 未 seed，继续。
	default:
		return fmt.Errorf("store: 读 directory_seeded: %w", err)
	}

	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("store: 开启目录 seed 事务: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// (kind, term_key) → display：map 去重，保证同键只写一次。
	seen := map[[2]string]string{}
	add := func(kind, raw string) {
		termKey, ok := NormalizeTermKey(raw)
		if !ok {
			return
		}
		display := CleanDisplayName(raw)
		if display == "" {
			return
		}
		key := [2]string{kind, termKey}
		if _, dup := seen[key]; dup {
			return
		}
		seen[key] = display
	}

	// 1) 属性取值的词条：segments.seq<0 的 attr.category / attr.instructor。
	attrRows, err := tx.Query(`SELECT DISTINCT kind,text FROM segments WHERE seq<0 AND kind IN ('attr.category','attr.instructor')`)
	if err != nil {
		return fmt.Errorf("store: 读存量属性段: %w", err)
	}
	for attrRows.Next() {
		var kind, text string
		if err := attrRows.Scan(&kind, &text); err != nil {
			attrRows.Close()
			return fmt.Errorf("store: 扫描存量属性段: %w", err)
		}
		switch kind {
		case "attr.category":
			add(DirectoryKindCategory, text)
		case "attr.instructor":
			add(DirectoryKindInstructor, text)
		}
	}
	err = attrRows.Err()
	attrRows.Close()
	if err != nil {
		return fmt.Errorf("store: 遍历存量属性段: %w", err)
	}

	// 2) 分类容器 slug：items.source='category' 的 item_id 去 'category/' 前缀。
	catRows, err := tx.Query(`SELECT item_id FROM items WHERE source='category'`)
	if err != nil {
		return fmt.Errorf("store: 读存量分类容器: %w", err)
	}
	for catRows.Next() {
		var itemID string
		if err := catRows.Scan(&itemID); err != nil {
			catRows.Close()
			return fmt.Errorf("store: 扫描存量分类容器: %w", err)
		}
		name := strings.TrimPrefix(itemID, "category/")
		if name == "" {
			continue
		}
		add(DirectoryKindCategory, name)
	}
	err = catRows.Err()
	catRows.Close()
	if err != nil {
		return fmt.Errorf("store: 遍历存量分类容器: %w", err)
	}

	// 3) 标签名称段：items.item_id LIKE 'tag/%' 的第二段。
	tagRows, err := tx.Query(`SELECT item_id FROM items WHERE item_id LIKE 'tag/%'`)
	if err != nil {
		return fmt.Errorf("store: 读存量标签条目: %w", err)
	}
	for tagRows.Next() {
		var itemID string
		if err := tagRows.Scan(&itemID); err != nil {
			tagRows.Close()
			return fmt.Errorf("store: 扫描存量标签条目: %w", err)
		}
		parts := strings.Split(itemID, "/")
		if len(parts) < 2 || parts[1] == "" {
			continue
		}
		add(DirectoryKindTag, parts[1])
	}
	err = tagRows.Err()
	tagRows.Close()
	if err != nil {
		return fmt.Errorf("store: 遍历存量标签条目: %w", err)
	}

	if len(seen) == 0 {
		// 无存量词条：不 bump、不落短路键，避免空库无谓 churn（收窄计划原文的「无条件 bump」）。
		return nil
	}

	// 按 (kind, term_key) 升序写入，抵消 map 迭代无序，保证 determinism。
	keys := make([][2]string, 0, len(seen))
	for k := range seen {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i][0] != keys[j][0] {
			return keys[i][0] < keys[j][0]
		}
		return keys[i][1] < keys[j][1]
	})
	for _, k := range keys {
		// 存量数据没有签名作者，first_author_id 传空串（册子 §2.1 允许为空）。
		if err := approveDirectoryTermExec(tx, k[0], k[1], seen[k], ""); err != nil {
			return err
		}
	}
	// 仅在确有写入时递增目录版本，避免空库无谓 churn（册子 #58 §4.1）。
	if _, err := bumpDirectoryVersionExec(tx); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO meta(key,value) VALUES(?,?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, metaDirectorySeeded, "1"); err != nil {
		return fmt.Errorf("store: 写 directory_seeded: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: 提交目录 seed 事务: %w", err)
	}
	return nil
}
