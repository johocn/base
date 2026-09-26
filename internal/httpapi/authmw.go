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
	"auth_body_too_large":      "请求体超过 64 KiB",
	"auth_sign_meta_invalid":   "待签字节构造失败",
	"identity_id_invalid":      "身份 id 必须是 32 位 hex",
	"identity_alg_unsupported": "算法不受支持",
	"identity_unregistered":    "身份未登记",
	"node_key_mismatch":        "节点间预共享密钥不匹配",
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

// requireAuth 包装需要签名头的处理器：严格按契约 3.2 的 1→7 顺序，先验后读体。
func (s *Server) requireAuth(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
		body, err := io.ReadAll(io.LimitReader(r.Body, maxJSONBody+1))
		if err != nil {
			s.writeAuthErr(w, http.StatusBadRequest, "auth_body_read_failed")
			return
		}
		_ = r.Body.Close()
		if int64(len(body)) > maxJSONBody {
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
		next(w, withIdentity(r, id))
	})
}
