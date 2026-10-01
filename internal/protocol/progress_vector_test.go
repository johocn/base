package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type progressArticleCase struct {
	Name     string  `json:"name"`
	Fraction float64 `json:"fraction"`
	Want     int64   `json:"want"`
}

type progressVideoCase struct {
	Name    string  `json:"name"`
	Seconds float64 `json:"seconds"`
	Want    int64   `json:"want"`
}

type progressQuizCase struct {
	Name     string `json:"name"`
	Answered int64  `json:"answered"`
	Total    int64  `json:"total"`
	Want     int64  `json:"want"`
}

type progressLWWCase struct {
	Name          string `json:"name"`
	CreatedAt     int64  `json:"createdAt"`
	EventID       string `json:"eventId"`
	PrevCreatedAt int64  `json:"prevCreatedAt"`
	PrevEventID   string `json:"prevEventId"`
	Want          bool   `json:"want"`
}

// 学习进度的量纲与 LWW 判据是**双端写死口径**（#8 册子 §3.2 / §3.4），
// 本向量同时被 Go 与 TS 两侧测试消费，任一侧漂移即红。
func TestProgressVectorFile(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "progress.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var f struct {
		Version int                   `json:"version"`
		Article []progressArticleCase `json:"article"`
		Video   []progressVideoCase   `json:"video"`
		Quiz    []progressQuizCase    `json:"quiz"`
		LWW     []progressLWWCase     `json:"lww"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if f.Version != 1 || len(f.Article) == 0 || len(f.Video) == 0 || len(f.Quiz) == 0 || len(f.LWW) == 0 {
		t.Fatalf("向量文件结构错误: version=%d article=%d video=%d quiz=%d lww=%d",
			f.Version, len(f.Article), len(f.Video), len(f.Quiz), len(f.LWW))
	}

	for _, c := range f.Article {
		t.Run("article/"+c.Name, func(t *testing.T) {
			if got := ArticlePosition(c.Fraction); got != c.Want {
				t.Fatalf("got=%d want=%d fraction=%v", got, c.Want, c.Fraction)
			}
		})
	}
	for _, c := range f.Video {
		t.Run("video/"+c.Name, func(t *testing.T) {
			if got := VideoPosition(c.Seconds); got != c.Want {
				t.Fatalf("got=%d want=%d seconds=%v", got, c.Want, c.Seconds)
			}
		})
	}
	for _, c := range f.Quiz {
		t.Run("quiz/"+c.Name, func(t *testing.T) {
			if got := QuizPosition(c.Answered, c.Total); got != c.Want {
				t.Fatalf("got=%d want=%d answered=%d total=%d", got, c.Want, c.Answered, c.Total)
			}
		})
	}
	for _, c := range f.LWW {
		t.Run("lww/"+c.Name, func(t *testing.T) {
			if got := ProgressWins(c.CreatedAt, c.EventID, c.PrevCreatedAt, c.PrevEventID); got != c.Want {
				t.Fatalf("got=%v want=%v", got, c.Want)
			}
		})
	}
}
