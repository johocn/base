package store

import (
	"database/sql"
	"encoding/json"
	"sort"
	"unicode"
)

// 质量门槛是**文档级常量**（治理册 §4.3）：不做配置项，校准走「改册子 + 改常量」。
const (
	ArticleMinRunes = 200
	VideoMinSeconds = 60
	QuizMinQuestions = 3
	// LessonMinItems 是 lesson 里需要达标子项的下限（T5 扩 course/lesson 贡献）。
	LessonMinItems = 1
	// CourseMinLessons 是 course 里需要达标课时的下限。
	CourseMinLessons = 3
	// RosterTopN 是名册截断长度（治理册 §4.4）。
	RosterTopN = 10
)

// Contributor 是名册里的一行。名册是派生值，不落表、无任期、不跨节点同步（治理册 §3.3）。
type Contributor struct {
	ID    string
	Count int
}

// Candidate 是一条已带归属缓存的候选条目，以及它在所属载体上的度量输入。
// Type ∈ {article, video, quiz}：填 BodyMD / DurationSeconds / QuestionCount。
// Type == "lesson"：填 ChildPassedCount（达标子项数）。
// Type == "course"：填 ChildPassedLessons（达标课时数）。
// 其余 Type → meetsQualityGate 恒 false。
type Candidate struct {
	ItemID              string
	AuthorID            string
	Type                string // article | video | quiz | lesson | course
	BodyMD              string // Type == "article"
	DurationSeconds     int64  // Type == "video"
	QuestionCount       int    // Type == "quiz"
	ChildPassedCount    int    // Type == "lesson"：达标子项数
	ChildPassedLessons  int    // Type == "course"：达标课时数
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
	case "lesson":
		return c.ChildPassedCount >= LessonMinItems
	case "course":
		return c.ChildPassedLessons >= CourseMinLessons
	default:
		// cover / dm / comment 等不是贡献载体。
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
// T5 扩展：article/video/quiz 之外，新增 course / lesson 两类贡献载体，
// 按「合并计 1」规则把父 course 与子 lesson 折叠（course 达标 → course 计 1，课时不再计）。
func (s *Store) ContributorRoster() ([]Contributor, error) {
	rows, err := s.db.Query(`SELECT item_id,author_id,type FROM items
		WHERE state='active' AND author_id<>'' ORDER BY item_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cands []Candidate
	articleIDs, videoIDs, quizIDs := []string{}, []string{}, []string{}
	courseIDs, lessonIDs := []string{}, []string{}
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
		case "course":
			courseIDs = append(courseIDs, c.ItemID)
		case "lesson":
			lessonIDs = append(lessonIDs, c.ItemID)
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

	// T5 新增：course / lesson 按合并计 1 规则装配候选度量。
	// computeContainerPassed 内部已回写 ChildPassedCount / ChildPassedLessons 到各自 Candidate。
	if len(courseIDs) > 0 || len(lessonIDs) > 0 {
		if _, _, err := s.computeContainerPassed(courseIDs, lessonIDs, cands, index); err != nil {
			return nil, err
		}
	}

	// 先算 counts map[string]int（Course/Lesson 走合并计 1 规则），再折成排序截断的 Contributor[]。
	counts := s.accumulateCounts(cands)
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
	return out, nil
}

// accumulateCounts 把候选条目折算成 author→count（合并计 1 规则由调用方预先处理：
// course 达标时，cands 会同时包含 course 和它下面的达标 lesson——这里统一累计）。
// 为让合并计 1 生效，传入的 cands 已经按 computeContainerPassed 合并：
// course 达标 + course 自身 Candidate 保留 + 其下的 lesson Candidate 也保留；
// 计数时 course 计 1，父 course 达标的 lesson 不再计（见 accumulateCounts 内部）。
func (s *Store) accumulateCounts(cands []Candidate) map[string]int {
	// 先把 course→达标布尔 和 lesson→达标布尔算出来（已由 computeContainerPassed 回写 ChildPassedLessons/ChildPassedCount）。
	// 然后再 ListLessonCourse 反查 lesson→父 course，决定是否跳过 lesson。
	coursePassed := map[string]bool{}
	lessonPassed := map[string]bool{}
	for _, c := range cands {
		switch c.Type {
		case "course":
			coursePassed[c.ItemID] = meetsQualityGate(c)
		case "lesson":
			lessonPassed[c.ItemID] = meetsQualityGate(c)
		}
	}

	// 收集所有 lesson IDs 用于反查父 course。
	allLessonIDs := make([]string, 0, len(lessonPassed))
	for id := range lessonPassed {
		allLessonIDs = append(allLessonIDs, id)
	}
	lessonCourse, _ := s.ListLessonCourse(allLessonIDs) // 忽略错误：空 map 降级为「无归属」

	counts := map[string]int{}
	for _, c := range cands {
		if c.AuthorID == "" {
			continue
		}
		switch c.Type {
		case "article", "video", "quiz":
			if meetsQualityGate(c) {
				counts[c.AuthorID]++
			}
		case "lesson":
			// 父 course 达标 → 课时不计（父 course 已经计了 1）。
			if parentCourse := lessonCourse[c.ItemID]; parentCourse != "" && coursePassed[parentCourse] {
				continue
			}
			if meetsQualityGate(c) {
				counts[c.AuthorID]++
			}
		case "course":
			if meetsQualityGate(c) {
				counts[c.AuthorID]++
			}
		}
	}
	return counts
}

// computeContainerPassed 反查 segments 批量计算 lesson→达标布尔 与 course→达标布尔。
// 只返回达标 map（true=达标）；不达标者不在 map 中。
func (s *Store) computeContainerPassed(
	courseIDs, lessonIDs []string,
	cands []Candidate,
	index map[string]int,
) (map[string]bool, map[string]bool, error) {
	courseLessons, err := s.ListCourseLessons(courseIDs)
	if err != nil {
		return nil, nil, err
	}
	lessonChildren, err := s.ListLessonChildren(lessonIDs)
	if err != nil {
		return nil, nil, err
	}

	// 收集所有子项 item_id（来自 lesson→children 与 course→lessons 里的 lesson 的子项）去批量查指标。
	childIDs := map[string]bool{}
	for _, children := range lessonChildren {
		for _, ch := range children {
			childIDs[ch.ChildItemID] = true
		}
	}
	childList := make([]string, 0, len(childIDs))
	for id := range childIDs {
		childList = append(childList, id)
	}

	// 批量查子项 type（来自 items 表，type 列）。
	childType := map[string]string{}
	if len(childList) > 0 {
		q := `SELECT item_id,type FROM items WHERE item_id IN (` + placeholders(len(childList)) + `)`
		args := make([]any, len(childList))
		for i, id := range childList {
			args[i] = id
		}
		rows, err := s.db.Query(q, args...)
		if err != nil {
			return nil, nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var itemID, t string
			if err := rows.Scan(&itemID, &t); err != nil {
				return nil, nil, err
			}
			childType[itemID] = t
		}
	}

	// 批量查 article body / quiz question_json / video duration。
	articleBatch := []string{}
	videoBatch := []string{}
	quizBatch := []string{}
	for _, id := range childList {
		switch childType[id] {
		case "article":
			articleBatch = append(articleBatch, id)
		case "video":
			videoBatch = append(videoBatch, id)
		case "quiz":
			quizBatch = append(quizBatch, id)
		}
	}
	articleBody := map[string]string{}
	if len(articleBatch) > 0 {
		articles, err := s.ListArticles(articleBatch)
		if err != nil {
			return nil, nil, err
		}
		for id, a := range articles {
			articleBody[id] = a.BodyMD
		}
	}
	quizCount := map[string]int{}
	if len(quizBatch) > 0 {
		quizzes, err := s.ListQuizzes(quizBatch)
		if err != nil {
			return nil, nil, err
		}
		for id, q := range quizzes {
			var doc struct {
				Questions []json.RawMessage `json:"questions"`
			}
			if err := json.Unmarshal([]byte(q.QuestionJSON), &doc); err == nil {
				quizCount[id] = len(doc.Questions)
			}
		}
	}
	videoDur := map[string]int64{}
	if len(videoBatch) > 0 {
		durations, err := s.ListMediaDurations(videoBatch)
		if err != nil {
			return nil, nil, err
		}
		videoDur = durations
	}

	// 判定每个子项是否达标（复用 Candidate + meetsQualityGate）。
	childPassed := map[string]bool{}
	for _, id := range childList {
		c := Candidate{ItemID: id, Type: childType[id], BodyMD: articleBody[id],
			DurationSeconds: videoDur[id], QuestionCount: quizCount[id]}
		childPassed[id] = meetsQualityGate(c)
	}

	// 判定每个 lesson 是否达标（≥ LessonMinItems 达标子项）。
	lessonPassed := map[string]bool{}
	lessonPassedCount := map[string]int{} // lesson→达标子项数（回写到 Candidate.ChildPassedCount 用）
	for lessonID, children := range lessonChildren {
		n := 0
		for _, ch := range children {
			if childPassed[ch.ChildItemID] {
				n++
			}
		}
		lessonPassedCount[lessonID] = n
		if n >= LessonMinItems {
			lessonPassed[lessonID] = true
		}
	}

	// 判定每个 course 是否达标（≥ CourseMinLessons 达标课时）。
	coursePassed := map[string]bool{}
	for courseID, lessons := range courseLessons {
		n := 0
		for _, l := range lessons {
			if lessonPassed[l] {
				n++
			}
		}
		if n >= CourseMinLessons {
			coursePassed[courseID] = true
		}
	}

	// 回写 lesson Candidate 的 ChildPassedCount，让 meetsQualityGate 可测。
	for lessonID, i := range index {
		if cands[i].Type != "lesson" {
			continue
		}
		cands[i].ChildPassedCount = lessonPassedCount[lessonID]
	}
	// 回写 course Candidate 的 ChildPassedLessons（course→达标课时数）。
	for courseID, lessons := range courseLessons {
		coursePassedLessons := 0
		for _, l := range lessons {
			if lessonPassed[l] {
				coursePassedLessons++
			}
		}
		if i, ok := index[courseID]; ok && cands[i].Type == "course" {
			cands[i].ChildPassedLessons = coursePassedLessons
		}
	}

	return coursePassed, lessonPassed, nil
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

// GetProfile 单条查询昵称：found=false 表示 profiles 表里没有该 id（调用方应返回 404）。
func (s *Store) GetProfile(id string) (name string, found bool, err error) {
	row := s.db.QueryRow(`SELECT name FROM profiles WHERE id=?`, id)
	if err := row.Scan(&name); err != nil {
		if err == sql.ErrNoRows {
			return "", false, nil
		}
		return "", false, err
	}
	return name, true, nil
}
