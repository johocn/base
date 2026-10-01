package protocol

import "math"

// 学习进度（progress.v1）的**量纲定义处**（#8 册子 §3.2）。
// 本文件是 Go 侧唯一口径；TS 镜像在 apps/mobile/src/core/progress.ts，
// 两侧测试共用 vectors/v1/progress.json（§3.4），任一侧漂移即红。
//
// **本文件不实现 `done` 谓词**：§3.2 表格的「`done` 判定」列写明判据主体是「客户端：」，
// 节点只信客户端上报的 `done`、不反推（§3.1）。在 Go 侧实现会是死代码。

// ArticlePosition 把正文滚动比例归一化为千分比：0..1000（§3.2）。
// 越界钳位；NaN 归 0（`!(fraction > 0)` 同时兜住 NaN——NaN 的比较恒为假）。
func ArticlePosition(fraction float64) int64 {
	if !(fraction > 0) {
		return 0
	}
	if fraction >= 1 {
		return 1000
	}
	return int64(math.Round(fraction * 1000))
}

// VideoPosition 把已看秒数归一化为整秒（§3.2）。负数归 0；小数向下取整。
func VideoPosition(seconds float64) int64 {
	if !(seconds > 0) {
		return 0
	}
	return int64(math.Floor(seconds))
}

// QuizPosition 把已作答题数归一化：夹到 [0, total]（§3.2）。total<=0 或 answered<=0 归 0。
func QuizPosition(answered, total int64) int64 {
	if total <= 0 || answered <= 0 {
		return 0
	}
	if answered >= total {
		return total
	}
	return answered
}

// ProgressWins 判事件 (createdAt, eventID) 是否胜过已占位的 (prevCreatedAt, prevEventID)：
// 排序 = `created_at` 降序、平局 `event_id` 升序，**首条即胜者**（#8 册子 §3.4）。
//
// 该口径与节点侧按身份读事件的既有排序（internal/store/event.go 的
// `ORDER BY created_at DESC, event_id ASC`）逐字一致；**不跟** dm 的 `event_id DESC`（§3.4）。
func ProgressWins(createdAt int64, eventID string, prevCreatedAt int64, prevEventID string) bool {
	if createdAt != prevCreatedAt {
		return createdAt > prevCreatedAt
	}
	return eventID < prevEventID
}
