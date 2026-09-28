package store

import (
	"encoding/json"
	"sort"
	"unicode"
)

// 质量门槛是**文档级常量**（治理册 §4.3）：不做配置项，校准走「改册子 + 改常量」。
const (
	ArticleMinRunes  = 200
	VideoMinSeconds  = 60
	QuizMinQuestions = 3
	// RosterTopN 是名册截断长度（治理册 §4.4）。
	RosterTopN = 10
)

// Contributor 是名册里的一行。名册是派生值，不落表、无任期、不跨节点同步（治理册 §3.3）。
type Contributor struct {
	ID    string
	Count int
}

// Candidate 是一条已带归属缓存的候选条目，以及它在所属载体上的度量输入。
type Candidate struct {
	ItemID          string
	AuthorID        string
	Type            string // article | video | quiz（其余载体不计贡献）
	BodyMD          string // Type == "article"
	DurationSeconds int64  // Type == "video"
	QuestionCount   int    // Type == "quiz"
}

// meetsQualityGate 判定一条候选是否达到其载体的质量门槛（治理册 §4.3）。
func meetsQualityGate(c Candidate) bool {
	switch c.Type {
	case "article":
		return countNonSpaceRunes(c.BodyMD) >= ArticleMinRunes
	case "video":
		// duration = 0 表示未知（导入器 -duration 默认 0），不计贡献。
		return c.DurationSeconds >= VideoMinSeconds
	case "quiz":
		return c.QuestionCount >= QuizMinQuestions
	default:
		// cover / course / lesson 等不是贡献载体。
		return false
	}
}

// countNonSpaceRunes 统计去除全部空白后的字符数（rune 计）。
func countNonSpaceRunes(s string) int {
	n := 0
	for _, r := range s {
		if unicode.IsSpace(r) {
			continue
		}
		n++
	}
	return n
}

// deriveRoster 把候选条目折算成名册（治理册 §4.3、§4.4）：
// 空归属与未达门槛者跳过；条数降序 + author_id 升序 tiebreak；取前 RosterTopN。
func deriveRoster(cands []Candidate) []Contributor {
	counts := map[string]int{}
	for _, c := range cands {
		if c.AuthorID == "" || !meetsQualityGate(c) {
			continue
		}
		counts[c.AuthorID]++
	}
	out := make([]Contributor, 0, len(counts))
	for id, n := range counts {
		out = append(out, Contributor{ID: id, Count: n})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].ID < out[j].ID
	})
	if len(out) > RosterTopN {
		out = out[:RosterTopN]
	}
	return out
}

// ContributorRoster 实时派生本节点贡献前 10 名名册（治理册 §4）。
// 只读 items 的归属缓存列，不重验签名；只看 state='active' 的条目。
func (s *Store) ContributorRoster() ([]Contributor, error) {
	rows, err := s.db.Query(`SELECT item_id,author_id,type FROM items
		WHERE state='active' AND author_id<>'' ORDER BY item_id ASC`)
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

	// 注意：ListArticles / ListQuizzes / ListMediaDurations 的「ids 为空 = 全部」语义，
	// 在无该类载体时必须整个跳过，否则会把全部行卷进来覆盖错位。
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
			// 题组 JSON 不可解析即计 0 题 → 未达门槛 → 跳过，不中断整张名册（治理册 §6）。
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
	return deriveRoster(cands), nil
}

// ListMediaDurations 批量读取媒体条目时长（秒）；ids 为空表示全部。
func (s *Store) ListMediaDurations(ids []string) (map[string]int64, error) {
	q := `SELECT item_id,duration FROM media_meta`
	args := []any{}
	if len(ids) > 0 {
		q += ` WHERE item_id IN (` + placeholders(len(ids)) + `)`
		for _, id := range ids {
			args = append(args, id)
		}
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var id string
		var d int64
		if err := rows.Scan(&id, &d); err != nil {
			return nil, err
		}
		out[id] = d
	}
	return out, rows.Err()
}

// PutProfile 覆盖写一个身份的公开昵称（幂等；治理册 §3.2）。
func (s *Store) PutProfile(id, name string, updatedAt int64) error {
	_, err := s.db.Exec(`INSERT INTO profiles(id,name,updated_at) VALUES(?,?,?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`, id, name, updatedAt)
	return err
}

// ProfileNames 返回指定 id 的昵称；ids 为空表示全部。缺该身份即不在结果里（调用方回退展示）。
func (s *Store) ProfileNames(ids []string) (map[string]string, error) {
	q := `SELECT id,name FROM profiles`
	args := []any{}
	if len(ids) > 0 {
		q += ` WHERE id IN (` + placeholders(len(ids)) + `)`
		for _, id := range ids {
			args = append(args, id)
		}
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}
