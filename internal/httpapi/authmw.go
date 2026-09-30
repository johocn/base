package httpapi

import (
	"bytes"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/johocn/base/internal/protocol"
)

// 契约 3.2：时间窗 300 秒；nonce 去重窗口 10 分钟（时间窗的两倍）。
const (
	authTsWindowMs = 300_000
	nonceWindowMs  = 600_000
)

// authErrText 只给人读；客户端必须只依赖 code（契约 3.3）。
var authErrText = map[string]string{
	"auth_missing_header":      "缺少签名头",
	"auth_ts_invalid":          "X-Base-Ts 不是十进制毫秒时间戳",
	"auth_nonce_invalid":       "X-Base-Nonce 必须是 16 字节 hex",
	"auth_sig_invalid":         "X-Base-Sig 必须是 hex",
	"auth_ts_out_of_window":    "时间戳超出 ±300 秒窗口",
	"auth_nonce_replay":        "nonce 在 10 分钟内已使用过",
	"auth_bad_signature":       "签名验证失败",
	"auth_body_read_failed":    "请求体读取失败",
	"auth_body_too_large":      "请求体超过本接口上限",
	"blob_too_large":           "上传块超过 8 MiB",
	"bad_multipart":            "请求必须是 multipart/form-data，且含字段 file",
	"auth_sign_meta_invalid":   "待签字节构造失败",
	"identity_id_invalid":      "身份 id 必须是 32 位 hex",
	"identity_alg_unsupported": "算法不受支持",
	"identity_unregistered":    "身份未登记",
	"node_key_mismatch":        "节点间预共享密钥不匹配",
	"event_sig_invalid":        "事件内容签名验证失败",
	"event_revoked":            "该评论已被审核删除",
	"event_rate_limited":       "发言过于频繁",
	"profile_name_invalid":     "昵称必须是去首尾空白后 1..32 个字符，且不含控制字符",
	"profile_id_forbidden":     "请求体不得携带 id",
	"item_id_invalid":          "item_id 必须形如 article/<slug>、quiz/<slug>、course/<cid> 或 course/<cid>/lesson/<lid>",
	"item_type_unsupported":    "type 只能是 article、quiz、tag、course 或 lesson",
	"item_segments_invalid":    "segments 不合法：seq<0 只放 attr.* 属性行且须按确定性规则排布，seq=0 只放 digest，seq>=1 只放本容器允许的子项 kind",
	"item_type_mismatch":       "type 与 item_id 前缀不一致",
	"item_title_invalid":       "标题必须是去首尾空白后 1..200 个字符，且不含控制字符",
	"item_body_too_large":      "正文超过 32768 字节",
	"item_question_invalid":    "question_json 不是合法 JSON、schema_version 非 1，或 questions 缺失/为空",
	"author_id_forbidden":      "请求体不得携带身份字段（author_id / proposer_id / id 等）",
	"author_sig_invalid":       "作者归属签名验证失败",
	"item_id_taken":            "该 item_id 已被占用",
	"item_rate_limited":        "投稿过于频繁",

	"proposal_action_unsupported": "action 只能是 remove / edit / revive",
	"proposal_reason_invalid":     "reason 必须是去首尾空白后 1..200 个字符，且不含控制字符",
	"proposal_edit_invalid":       "edit 载荷不合法：title 须为去首尾空白后 1..200 个字符且不含控制字符，body_md 必填，且目标必须是 article 载体",
	"proposal_too_large":          "title 与 body_md 的字节之和超过 32768",
	"item_not_found":              "目标 item_id 不存在",
	"item_self_owned":             "不能治理自己的条目，请改用 POST /v1/submit",
	"item_state_mismatch":         "动作与目标当前 state 不匹配",
	"proposer_not_governor":       "提案人不在本节点名册内",
	"proposal_not_found":          "提案不存在",
	"voter_not_governor":          "投票人不在本节点名册内",
	"already_voted":               "已对本提案投过票",
	"govern_rate_limited":         "治理操作过于频繁",

	"group_read_denied":               "圈子不存在或不可见",
	"group_invite_required":           "该圈子仅接受邀请码加入",
	"group_roster_quorum_missing":     "签名数不足门槛",
	"group_proposal_proposer_missing": "解散圈子需治理者发起",
	"group_roster_epoch_stale":        "密钥已轮换，请先同步圈内状态",
	"govern_event_conflict":           "同一提案存在并发冲突，已按确定性规则收敛",

	"tag_not_governor":     "只有治理人（全站名册或圈子治者）能给无标签内容打标签",
	"tag_target_tagged":    "该内容已有标签，改动请走治理提案",
	"tag_links_invalid":    "links 不合法：kind 必须与 target_id 形态一致，且同一 target_id 不得重复",
	"tag_target_not_found": "打标目标不存在或已下架",
}

// writeAuthErr 按契约 3.3 输出 {"error": "<人读消息>", "code": "<机器码>"}。
// 既有 writeError 的 {"error": "..."} 形状保持不变，不破坏 P0 验收。
func (s *Server) writeAuthErr(w http.ResponseWriter, status int, code string) {
	text := authErrText[code]
	if text == "" {
		text = code
	}
	s.writeJSON(w, status, map[string]any{"error": text, "code": code})
}

// PruneNonces 清理过期 nonce 行；serve 启动时与定时任务调用（契约 3.2 第 5 步）。
func (s *Server) PruneNonces() (int64, error) {
	return s.st.PruneNonces(time.Now().UnixMilli() - nonceWindowMs)
}

// requireAuth 包装需要签名头的处理器：体上限取默认的 maxJSONBody（64 KiB）。
func (s *Server) requireAuth(next http.HandlerFunc) http.Handler {
	return s.requireAuthLimit(maxJSONBody)(next)
}

// requireAuthLimit 同 requireAuth，但显式指定体上限（POST /v1/blob 需要 8 MiB 量级的体）。
func (s *Server) requireAuthLimit(maxBody int64) func(http.HandlerFunc) http.Handler {
	return func(next http.HandlerFunc) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, ok := s.authenticate(w, r, maxBody)
			if !ok {
				return
			}
			next(w, withIdentity(r, id))
		})
	}
}

// optionalAuth 供按形态分支的读接口用：5 个签名头**全缺**即按匿名放行；
// 缺一半仍按 auth_missing_header 拒（避免「半带头的请求」被静默降级为匿名）。
func (s *Server) optionalAuth(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hasAnyAuthHeader(r) {
			next(w, r)
			return
		}
		id, ok := s.authenticate(w, r, maxJSONBody)
		if !ok {
			return
		}
		next(w, withIdentity(r, id))
	})
}

// hasAnyAuthHeader 判 5 个头是否至少出现了一个。
func hasAnyAuthHeader(r *http.Request) bool {
	for _, k := range []string{"X-Base-Id", "X-Base-Alg", "X-Base-Ts", "X-Base-Nonce", "X-Base-Sig"} {
		if r.Header.Get(k) != "" {
			return true
		}
	}
	return false
}

// authenticate 执行契约 3.2 的 1..7 步；maxBody 是本请求的体上限（超出回 413 auth_body_too_large）。
// 返回已验签身份 id 与是否放行（失败时响应已写好）。
// 结果具名（且**不用 ok**，避免与第 3 步的局部 ok 相撞），使 1..6 步的裸 return 原样保留：
// 裸 return 交回零值，即「不放行」。
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request, maxBody int64) (actorID string, authed bool) {
	// 1. 缺任一头
	id := r.Header.Get("X-Base-Id")
	alg := r.Header.Get("X-Base-Alg")
	tsRaw := r.Header.Get("X-Base-Ts")
	nonce := r.Header.Get("X-Base-Nonce")
	sig := r.Header.Get("X-Base-Sig")
	if id == "" || alg == "" || tsRaw == "" || nonce == "" || sig == "" {
		s.writeAuthErr(w, http.StatusBadRequest, "auth_missing_header")
		return
	}
	// 2. 算法与格式（全部在查库之前，避免用坏输入打库）
	if alg != protocol.AlgEd25519 {
		s.writeAuthErr(w, http.StatusBadRequest, "identity_alg_unsupported")
		return
	}
	if !protocol.IsIdentityID(id) {
		s.writeAuthErr(w, http.StatusBadRequest, "identity_id_invalid")
		return
	}
	ts, err := strconv.ParseInt(tsRaw, 10, 64)
	if err != nil {
		s.writeAuthErr(w, http.StatusBadRequest, "auth_ts_invalid")
		return
	}
	if !isHexN(nonce, 16) {
		s.writeAuthErr(w, http.StatusBadRequest, "auth_nonce_invalid")
		return
	}
	if !isHexNonEmptyEven(sig) {
		s.writeAuthErr(w, http.StatusBadRequest, "auth_sig_invalid")
		return
	}
	// 3. 取公钥
	it, ok, err := s.st.LookupIdentity(id)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		s.writeAuthErr(w, http.StatusForbidden, "identity_unregistered")
		return
	}
	// 4. 时间窗
	now := time.Now().UnixMilli()
	if delta := now - ts; delta > authTsWindowMs || delta < -authTsWindowMs {
		s.writeAuthErr(w, http.StatusUnauthorized, "auth_ts_out_of_window")
		return
	}
	// 5. nonce 去重（键含 id，否则可被抢注导致合法请求被误判重放）
	// UseNonce 返回 used：true 表示该 nonce 此前已被同一 id 用过（重放）。
	used, err := s.st.UseNonce(id, nonce, now)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if used {
		s.writeAuthErr(w, http.StatusUnauthorized, "auth_nonce_replay")
		return
	}
	// 6. 读体 → 算 body_sha256 → 组待签字节 → 验签
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		s.writeAuthErr(w, http.StatusBadRequest, "auth_body_read_failed")
		return
	}
	_ = r.Body.Close()
	if int64(len(body)) > maxBody {
		s.writeAuthErr(w, http.StatusRequestEntityTooLarge, "auth_body_too_large")
		return
	}
	signBytes, err := protocol.RequestSignBytes(protocol.RequestMeta{
		Method:     r.Method,
		Path:       r.URL.Path,
		Query:      r.URL.RawQuery,
		BodySHA256: protocol.SHA256Hex(body),
		TS:         ts,
		Nonce:      nonce,
	})
	if err != nil {
		s.writeAuthErr(w, http.StatusBadRequest, "auth_sign_meta_invalid")
		return
	}
	valid, err := protocol.Verify(it.PubKey, signBytes, sig)
	if err != nil || !valid {
		s.writeAuthErr(w, http.StatusUnauthorized, "auth_bad_signature")
		return
	}
	// 7. 通过：把体还给 handler，写入已验签身份
	r.Body = io.NopCloser(bytes.NewReader(body))
	_ = s.st.TouchIdentity(id, now)
	return id, true
}
