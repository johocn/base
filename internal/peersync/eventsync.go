package peersync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
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
		// 治理事件才派生名册，且**整页只派生一次**（册子 §4.3）：派生要扫 items + articles + quizzes + videos，
		// 纯评论 / 圈子页不该付这笔开销；本页只写事件与投影，不碰名册输入，故页内复用同一份安全。
		var govRoster map[string]bool
		var govRosterOK bool
		for _, it := range out.Items {
			if it.Type == "govern.v1" {
				govRoster, govRosterOK = deriveGovernRoster(st)
				break
			}
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
			// progress.v1 投影失败**阻断整页**（与 group 同强度：进度投影是纯本地双写，失败即真异常）。
			if _, err := applySyncedProgressEvent(st, it); err != nil {
				return total, err
			}
			// govern.v1 投影失败**不阻断整页反熵**：事件行才是权威来源，读接口可从事件重算。
			if _, err := applySyncedGovernEvent(st, it, govRoster, govRosterOK); err != nil {
				log.Printf("peersync: govern.v1 投影失败（事件行已落，读接口可从事件重算）: %v", err)
			}
			// circle.v1 assign 投影（融合治理册 §2.2 的轨道 A）：写 circle_assignments 一行。
			// form 投影留 T4——对端事件 body 不带 creator_id，本地 items 可能还没。
			if _, err := applySyncedCircleEvent(st, it); err != nil {
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
	case "like.v1", "report.v1":
		// #79 §6：无 payload 事件，投影只填 target_id（EventBlobIndex 白名单不动，同 progress.v1 先例）。
		var m struct {
			TargetID string `json:"target_id"`
		}
		if err := json.Unmarshal([]byte(bodyJSON), &m); err != nil || m.TargetID == "" {
			return commentProjection{}
		}
		return commentProjection{TargetID: m.TargetID}
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
	case "dm.v1":
		// 私信的减化 body 是 {to, payload_cid}；target_id 由 to 拼回来（册子 §3.3）。
		var m struct {
			To         string `json:"to"`
			PayloadCID string `json:"payload_cid"`
		}
		if err := json.Unmarshal([]byte(bodyJSON), &m); err != nil || m.To == "" {
			return commentProjection{}
		}
		return commentProjection{TargetID: "dm/" + m.To, PayloadCID: m.PayloadCID}
	case "progress.v1":
		// 进度的减化 body 是 {item_id,position,done,day}；target_id 直接取 item_id（#8 册子 §3.1）。
		// 进度**不带正文块**，payload_cid 恒空（§3.1）——故 EventBlobIndex 的 type 白名单不用动。
		var m struct {
			ItemID string `json:"item_id"`
		}
		if err := json.Unmarshal([]byte(bodyJSON), &m); err != nil || m.ItemID == "" {
			return commentProjection{}
		}
		return commentProjection{TargetID: m.ItemID}
	case "circle.v1":
		// circle.v1 的减化 body 是 {action,item_id,circle_id,origin?,content_hash?}，
		// 不带 target_id / payload_cid / reply_to——三列全空（融合治理册 §2.2）。
		return commentProjection{}
	default:
		return commentProjection{}
	}
}

// applySyncedGroupEvent 把对端来的 roster 事件落进本地名单投影（册子 §4.4 的延伸）。
// 用 ForceGroupRoster：**不校验 owner**——对端数据在信任域内，且本地可能只收到 epoch>1 的名单；
// 只接受更大的 epoch，旧值静默忽略。发言事件不改变投影，直接返回。
// v2 事件另带 roster_rev / encrypted / key_envelopes（#33 §3.8），一并无损搬运。
func applySyncedGroupEvent(st *store.Store, it eventSyncItem) (bool, error) {
	if it.Type != "group.v1" {
		return false, nil
	}
	var m struct {
		GroupID   string            `json:"group_id"`
		Action    string            `json:"action"`
		Sub       string            `json:"sub"`
		Epoch     int64             `json:"epoch"`
		RosterRev int64             `json:"roster_rev"`
		Encrypted *int64            `json:"encrypted"`
		MemberIDs []string          `json:"member_ids"`
		Envelopes []json.RawMessage `json:"envelopes"`
	}
	if err := json.Unmarshal([]byte(it.BodyJSON), &m); err != nil || m.GroupID == "" {
		return false, nil
	}
	// 空名单只放行解散（sub=dissolve）。若空名单一律丢弃，解散事件会消失，对端永远保留旧名单，
	// 已解散/被移出的成员在对端仍能读封闭圈；v1 键集没有 sub，故不会误放垃圾事件。
	if m.Action != "roster" || m.Epoch < 1 || (len(m.MemberIDs) == 0 && m.Sub != "dissolve") {
		return false, nil
	}
	membersJSON, err := json.Marshal(m.MemberIDs)
	if err != nil {
		return false, err
	}
	// encrypted 缺省必须显式给 1（封闭）：v1 老事件没有该键，用 int64 时零值 0 会把老事件
	// 误判成开放圈（匿名可读，安全漏洞），故用指针区分「缺键」与「显式 0」。
	enc := int64(1)
	if m.Encrypted != nil {
		enc = *m.Encrypted
	}
	// 信封列必须与写路径同形态：包装对象 {"envelopes":[...]}。读接口按
	// struct{Envelopes []json.RawMessage `json:"envelopes"`} 解包，裸数组会 Unmarshal 失败
	// 并被静默忽略，对端信封恒为空 ⇒ 成员无法从缓存节点解密。
	envelopesJSON := "[]"
	if len(m.Envelopes) > 0 {
		raw, err := json.Marshal(map[string]any{"envelopes": m.Envelopes})
		if err != nil {
			return false, err
		}
		envelopesJSON = string(raw)
	}
	return st.ForceGroupRoster(store.GroupRoster{
		GroupID: m.GroupID, CreatorID: it.ID, Epoch: m.Epoch, RosterRev: m.RosterRev,
		Encrypted: enc, MemberIDsJSON: string(membersJSON), KeyEnvelopesJSON: envelopesJSON,
		EventID: it.EventID,
	})
}

// applySyncedProgressEvent 把对端来的 progress.v1 事件投影进本地 progress + checkin_days（#8 册子 §4.3）。
// 投影**幂等**（同 event_id 重放 no-op；输者静默 no-op，见 store.PutProgressProjection）。
//
// 与 group 同强度：投影失败**阻断整页反熵**。理由：进度投影是一次纯本地 SQL 双写，
// 失败即真异常（磁盘 / schema），不像 govern 那样有「事件是权威、读接口可重算」的退路。
func applySyncedProgressEvent(st *store.Store, it eventSyncItem) (bool, error) {
	if it.Type != "progress.v1" {
		return false, nil
	}
	var m struct {
		ItemID   string `json:"item_id"`
		Position int64  `json:"position"`
		Done     bool   `json:"done"`
		Day      string `json:"day"`
	}
	if err := json.Unmarshal([]byte(it.BodyJSON), &m); err != nil || m.ItemID == "" {
		return false, nil // 形态不认识的事件：落行但不投影（与 parseEventProjection 的零值口径一致）
	}
	if err := st.PutProgressProjection(store.ProgressEvent{
		ID: it.ID, ItemID: m.ItemID, Position: m.Position, Done: m.Done, Day: m.Day,
		CreatedAt: it.CreatedAt, EventID: it.EventID,
	}); err != nil {
		return false, err
	}
	return true, nil
}

// applySyncedGovernEvent 把对端来的 govern.v1 事件投影进本地 govern_* 两表（册子 §4.3）。
// 投影是**幂等**的：重复事件静默忽略；冲突事件（已被更早的 (created_at,event_id) 占位）**不算错**；
// 投影失败**不阻断事件行落地**（事件行才是权威来源，读接口可以从事件重算）。
// roster 由调用方**每页派生一次**传入（见 pullEvents）；nil 视作空名册（settle 停在 pending）。
// rosterReady 是名册就绪位，透传给 settle（目录提案的小节点豁免要它，册子 #58 §3.2）。
func applySyncedGovernEvent(st *store.Store, it eventSyncItem, roster map[string]bool, rosterReady bool) (bool, error) {
	if it.Type != "govern.v1" {
		return false, nil
	}
	// body_json 是**客户端原始键集**（httpapi 存的就是 req.Body 原文），故这里能取到全部字段。
	var m struct {
		Action               string `json:"action"`
		ProposalID           string `json:"proposal_id"`
		TargetItemID         string `json:"target_item_id"`
		Verb                 string `json:"verb"`
		ContentHash          string `json:"content_hash"`
		ContentVersion       int64  `json:"content_version"`
		RevokedRev           int64  `json:"revoked_rev"`
		Reason               string `json:"reason"`
		Title                string `json:"title"`
		BodyMD               string `json:"body_md"`
		Choice               string `json:"choice"`
		DirectoryKind        string `json:"directory_kind"`
		DirectoryTermKey     string `json:"directory_term_key"`
		DirectoryDisplayName string `json:"directory_display_name"`
	}
	if err := json.Unmarshal([]byte(it.BodyJSON), &m); err != nil || m.ProposalID == "" {
		return false, nil // 形态不认识的事件：落行但不投影（与 parseEventProjection 的零值口径一致）
	}
	pid, err := strconv.ParseInt(m.ProposalID, 10, 64)
	if err != nil || pid <= 0 {
		return false, nil
	}
	switch m.Action {
	case "proposal":
		// 与 httpapi.parseGovernBody 同口径的镜像校验（双端对同一事件必须同信心，册子 #58 §3.1）：
		// directory_add 形态不认识 ⇒ 落行不投影（与 default 口径一致）。
		title, body := m.Title, m.BodyMD
		if m.Verb == store.GovernActionDirectoryAdd {
			if _, ok := store.DirectoryKindOfItemID(m.TargetItemID); !ok {
				return false, nil
			}
			tk, ok2 := store.NormalizeTermKey(m.DirectoryDisplayName)
			if !ok2 || tk != m.DirectoryTermKey {
				return false, nil
			}
			title, body = m.DirectoryDisplayName, m.DirectoryTermKey
		}
		err := st.ProjectGovernProposal(store.GovernProposalEvent{
			ProposalID: pid, TargetItemID: m.TargetItemID, Verb: m.Verb, ContentHash: m.ContentHash,
			Reason: m.Reason, Title: title, BodyMD: body,
			ContentVersion: m.ContentVersion, RevokedRev: m.RevokedRev,
			CreatedAt: it.CreatedAt, EventID: it.EventID, Actor: it.ID,
		})
		if err != nil && !errors.Is(err, store.ErrGovernEventConflict) {
			return false, err
		}
	case "vote":
		if err := st.ProjectGovernVote(store.GovernVoteEvent{
			ProposalID: pid, Choice: m.Choice,
			CreatedAt: it.CreatedAt, EventID: it.EventID, Actor: it.ID,
		}); err != nil {
			return false, err
		}
	default:
		return false, nil
	}
	// 投影后 settle（册子 §4.3 / §4.4）：proposal 与 vote **两支都要**——反熵不保证
	// proposal 事件先于 vote 事件到达。settle 失败只记日志、**不阻断整页反熵**
	//（事件行才是权威来源，读接口可从事件重算）。
	if err := st.SettleGovernProposal(pid, roster, rosterReady); err != nil {
		log.Printf("peersync: 治理提案 %d 生效判定失败（事件行已落，读接口可从事件重算）: %v", pid, err)
	}
	return true, nil
}

// deriveGovernRoster 派生本节点治者名册（册子 §4.3）；失败返回 ok=false，按空名册降级（settle 停在 pending）。
// 返回的 nil map 与空集等价（Go 的 nil map 读为假），调用方无需再判空。
func deriveGovernRoster(st *store.Store) (map[string]bool, bool) {
	rows, err := st.ContributorRoster()
	if err != nil {
		log.Printf("peersync: 治理名册派生失败，按空名册降级（settle 停在 pending）: %v", err)
		return nil, false
	}
	set := make(map[string]bool, len(rows))
	for _, c := range rows {
		set[c.ID] = true
	}
	return set, true
}

// applySyncedCircleEvent 把对端来的 circle.v1 事件投影进本地 circle_assignments +（form 时）groups。
// action=assign → 写一行 circle_assignments（轨道 A 归属声明）。
// action=form   → 写 UpsertGroupForForm + PutCircleAssignment（轨道 B 成圈）。
// form 投影用本地 items 表取 author_id（handleCircleEvent 同口径）；
// 本地 items 不存在 → 静默跳过（对端发事件前已 fail-closed 校验 item_not_found，
// 反熵时若本地 items 仍缺失则等后续反熵补齐后再重放事件）。
// 投影失败**阻断整页反熵**（与 group / progress 同强度：纯本地 SQL 双写，失败即真异常）。
func applySyncedCircleEvent(st *store.Store, it eventSyncItem) (bool, error) {
	if it.Type != "circle.v1" {
		return false, nil
	}
	var m struct {
		Action   string `json:"action"`
		ItemID   string `json:"item_id"`
		CircleID string `json:"circle_id"`
		Origin   string `json:"origin"`
	}
	if err := json.Unmarshal([]byte(it.BodyJSON), &m); err != nil {
		return false, nil
	}
	if m.ItemID == "" || m.CircleID == "" {
		return false, nil
	}
	origin := m.Origin
	if origin == "" {
		origin = "fusion"
	}
	switch m.Action {
	case "assign":
		if err := st.PutCircleAssignment(m.ItemID, m.CircleID, origin, it.CreatedAt); err != nil {
			return false, err
		}
		return true, nil
	case "form":
		// 本地 items 取 author_id；不存在 → 静默跳过（等补齐后重放）。
		item, found, err := st.GetItem(m.ItemID)
		if err != nil {
			return false, err
		}
		if !found {
			return false, nil // 事件行已落、投影等重放
		}
		if err := st.UpsertGroupForForm(m.CircleID, item.AuthorID, it.CreatedAt, origin); err != nil {
			return false, err
		}
		if err := st.PutCircleAssignment(m.ItemID, m.CircleID, origin, it.CreatedAt); err != nil {
			return false, err
		}
		return true, nil
	}
	return false, nil
}
