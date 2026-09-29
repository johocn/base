package peersync

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/johocn/base/internal/store"
)

const (
	// eventSyncPageLimit 单请求条数；与 httpapi 的 eventSyncDefaultLimit 一致。
	eventSyncPageLimit = 200
	// maxEventPages 是单轮单 peer 单 kind 的翻页上限，防止对端持续增长时本轮永不结束
	// （下一轮从已推进的游标继续，不丢数据）。
	maxEventPages = 20
)

// EventSyncResult 是一轮事件增量同步的结果（日志字段）。
type EventSyncResult struct {
	Events     int
	Tombstones int
}

func (r EventSyncResult) String() string {
	return fmt.Sprintf("event_sync events=%d tombstones=%d", r.Events, r.Tombstones)
}

type eventSyncCursor struct {
	TS int64  `json:"ts"`
	ID string `json:"id"`
}

type eventSyncItem struct {
	EventID    string `json:"event_id"`
	ID         string `json:"id"`
	Type       string `json:"type"`
	BodyJSON   string `json:"body_json"`
	CreatedAt  int64  `json:"created_at"`
	ReceivedAt int64  `json:"received_at"`
}

type tombstoneItem struct {
	EventID    string `json:"event_id"`
	PayloadCID string `json:"payload_cid"`
	Reason     string `json:"reason"`
	At         int64  `json:"at"`
	ReceivedAt int64  `json:"received_at"`
}

type eventSyncPage struct {
	Items []eventSyncItem  `json:"items"`
	Next  *eventSyncCursor `json:"next"`
}

type tombstonePage struct {
	Items []tombstoneItem  `json:"items"`
	Next  *eventSyncCursor `json:"next"`
}

// SyncEvents 对一个 peer 拉一轮事件增量与墓碑增量（册子 §4.4）。
// 先事件后墓碑：墓碑到达即删本地块，若反过来则同一轮可能先落块再删，白跑一趟。
func (c Config) SyncEvents(ctx context.Context, st *store.Store, p Peer) (EventSyncResult, error) {
	var res EventSyncResult
	hc, err := c.client(p)
	if err != nil {
		return res, err
	}
	if res.Events, err = c.pullEvents(ctx, st, hc, p); err != nil {
		return res, err
	}
	res.Tombstones, err = c.pullTombstones(ctx, st, hc, p)
	return res, err
}

func (c Config) pullEvents(ctx context.Context, st *store.Store, hc *http.Client, p Peer) (int, error) {
	cur := eventSyncCursor{}
	cur.TS, cur.ID, _ = st.GetPeerCursor(p.URL, "event")
	total := 0
	for page := 0; page < maxEventPages; page++ {
		var out eventSyncPage
		if err := c.postEventSync(ctx, hc, p, "event", cur, &out); err != nil {
			return total, err
		}
		for _, it := range out.Items {
			proj := parseEventProjection(it.Type, it.BodyJSON)
			// 本地 received_at 用本机 now（不落对端的值）：游标口径必须与本地读接口一致。
			if err := st.PutEvent(store.Event{
				EventID: it.EventID, ID: it.ID, Type: it.Type, BodyJSON: it.BodyJSON,
				CreatedAt: it.CreatedAt,
				TargetID:  proj.TargetID, PayloadCID: proj.PayloadCID, ReplyTo: proj.ReplyTo,
			}); err != nil {
				return total, err
			}
			if _, err := applySyncedGroupEvent(st, it); err != nil {
				return total, err
			}
			total++
		}
		if len(out.Items) == 0 {
			return total, nil // 空页：本 kind 已拉完
		}
		// 用本页末条推进游标：对端只在满页时给 next，不满页同样要推进，否则每轮重拉尾部。
		last := out.Items[len(out.Items)-1]
		next := eventSyncCursor{TS: last.ReceivedAt, ID: last.EventID}
		if err := st.PutPeerCursor(p.URL, "event", next.TS, next.ID); err != nil {
			return total, err
		}
		cur = next
		if out.Next == nil {
			return total, nil
		}
	}
	return total, nil
}

func (c Config) pullTombstones(ctx context.Context, st *store.Store, hc *http.Client, p Peer) (int, error) {
	cur := eventSyncCursor{}
	cur.TS, cur.ID, _ = st.GetPeerCursor(p.URL, "tombstone")
	total := 0
	for page := 0; page < maxEventPages; page++ {
		var out tombstonePage
		if err := c.postEventSync(ctx, hc, p, "tombstone", cur, &out); err != nil {
			return total, err
		}
		for _, it := range out.Items {
			// 墓碑 upsert 幂等；收到即删本地副本（反熵护栏 3 的同一条语义）。
			if err := st.PutCommentTombstone(store.CommentTombstone{
				EventID: it.EventID, PayloadCID: it.PayloadCID, Reason: it.Reason, At: it.At,
			}); err != nil {
				return total, err
			}
			if ok, _, err := st.HasBlob(it.PayloadCID); err != nil {
				return total, err
			} else if ok {
				if err := st.DeleteBlob(it.PayloadCID); err != nil {
					return total, err
				}
			}
			total++
		}
		if len(out.Items) == 0 {
			return total, nil
		}
		last := out.Items[len(out.Items)-1]
		next := eventSyncCursor{TS: last.ReceivedAt, ID: last.EventID}
		if err := st.PutPeerCursor(p.URL, "tombstone", next.TS, next.ID); err != nil {
			return total, err
		}
		cur = next
		if out.Next == nil {
			return total, nil
		}
	}
	return total, nil
}

// postEventSync 发一次 event-sync 请求并把响应解析进 out。
func (c Config) postEventSync(ctx context.Context, hc *http.Client, p Peer, kind string, cur eventSyncCursor, out any) error {
	body, err := json.Marshal(map[string]any{"kind": kind, "after": cur, "limit": eventSyncPageLimit})
	if err != nil {
		return err
	}
	res, err := c.do(ctx, hc, http.MethodPost, endpoint(p, "/v1/event-sync"), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("POST /v1/event-sync: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("POST /v1/event-sync: HTTP %d %s", res.StatusCode, strings.TrimSpace(string(raw)))
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("event-sync 响应不是合法 JSON: %w", err)
	}
	return nil
}

// commentProjection 是 comment.v1 的 body_json 减化形态在接收侧的投影字段（册子 §3.3）。
type commentProjection struct {
	TargetID   string
	PayloadCID string
	ReplyTo    string
}

// parseEventProjection 从 body_json 还原投影列（收到的对端事件只有 body_json，
// 索引列必须在本地重建，否则读接口与块归属都会落空）。
// 非已知类型返回零值（保持原语义：不认识的事件仍然落行，只是没有索引）。
func parseEventProjection(typ, bodyJSON string) commentProjection {
	switch typ {
	case "comment.v1":
		var m struct {
			TargetID   string `json:"target_id"`
			PayloadCID string `json:"payload_cid"`
			ReplyTo    string `json:"reply_to"`
		}
		if err := json.Unmarshal([]byte(bodyJSON), &m); err != nil {
			return commentProjection{}
		}
		return commentProjection{TargetID: m.TargetID, PayloadCID: m.PayloadCID, ReplyTo: m.ReplyTo}
	case "group.v1":
		// 小组事件的减化 body 是 {group_id,action,epoch,payload_cid,reply_to}（发言）
		// 或 {group_id,action,epoch,member_ids,name}（名单）；target_id 由 group_id 拼回来。
		var m struct {
			GroupID    string `json:"group_id"`
			PayloadCID string `json:"payload_cid"`
			ReplyTo    string `json:"reply_to"`
		}
		if err := json.Unmarshal([]byte(bodyJSON), &m); err != nil || m.GroupID == "" {
			return commentProjection{}
		}
		return commentProjection{TargetID: "group/" + m.GroupID, PayloadCID: m.PayloadCID, ReplyTo: m.ReplyTo}
	default:
		return commentProjection{}
	}
}

// applySyncedGroupEvent 把对端来的 roster 事件落进本地名单投影（册子 §4.4 的延伸）。
// 用 ForceGroupRoster：**不校验 owner**——对端数据在信任域内，且本地可能只收到 epoch>1 的名单；
// 只接受更大的 epoch，旧值静默忽略。发言事件不改变投影，直接返回。
func applySyncedGroupEvent(st *store.Store, it eventSyncItem) (bool, error) {
	if it.Type != "group.v1" {
		return false, nil
	}
	var m struct {
		GroupID   string   `json:"group_id"`
		Action    string   `json:"action"`
		Epoch     int64    `json:"epoch"`
		MemberIDs []string `json:"member_ids"`
	}
	if err := json.Unmarshal([]byte(it.BodyJSON), &m); err != nil || m.GroupID == "" {
		return false, nil
	}
	if m.Action != "roster" || m.Epoch < 1 || len(m.MemberIDs) == 0 {
		return false, nil
	}
	membersJSON, err := json.Marshal(m.MemberIDs)
	if err != nil {
		return false, err
	}
	return st.ForceGroupRoster(store.GroupRoster{
		GroupID: m.GroupID, CreatorID: it.ID, Epoch: m.Epoch,
		MemberIDsJSON: string(membersJSON), EventID: it.EventID,
	})
}
