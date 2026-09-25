package httpapi

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// maxJSONBody 限制请求体：身份与托管请求都很小，超过即视为异常。
const maxJSONBody = 64 << 10

type ctxKey int

const ctxKeyIdentity ctxKey = iota + 1

// withIdentity 把已验签的身份 id 写入请求上下文（只由验签中间件调用）。
func withIdentity(r *http.Request, id string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), ctxKeyIdentity, id))
}

// identityFrom 取出已验签的身份 id；空串表示未挂验签中间件或未通过。
func identityFrom(r *http.Request) string {
	v, _ := r.Context().Value(ctxKeyIdentity).(string)
	return v
}

// decodeJSON 读请求体并反序列化；失败时已写好 400 响应，调用方直接 return。
func (s *Server) decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	defer func() { _ = r.Body.Close() }()
	dec := json.NewDecoder(io.LimitReader(r.Body, maxJSONBody))
	if err := dec.Decode(dst); err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_json")
		return false
	}
	return true
}

func isHexN(s string, n int) bool {
	if len(s) != n*2 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

func isHexNonEmptyEven(s string) bool {
	if len(s) == 0 || len(s)%2 != 0 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// validUsername 严格按契约 4.2：^[a-zA-Z0-9_]{3,32}$。
// 不做大小写归一：静默改写会让「用户以为的名字」与「托管键」不一致。
func validUsername(s string) bool {
	if len(s) < 3 || len(s) > 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_':
		default:
			return false
		}
	}
	return true
}

type identityRegisterReq struct {
	ID     string `json:"id"`
	Alg    string `json:"alg"`
	PubKey string `json:"pubkey"`
}

// handleIdentityRegister 匿名登记公钥（契约 5.1）。
// 不需要签名：节点重算 sha256(pubkey)[0:32] 并与 id 比对，请求自证且无可篡改。
func (s *Server) handleIdentityRegister(w http.ResponseWriter, r *http.Request) {
	var req identityRegisterReq
	if !s.decodeJSON(w, r, &req) {
		return
	}
	if req.Alg != protocol.AlgEd25519 {
		s.writeError(w, http.StatusBadRequest, "identity_alg_unsupported")
		return
	}
	wantID, err := protocol.IdentityID(req.PubKey)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, "identity_pubkey_invalid")
		return
	}
	if !strings.EqualFold(wantID, req.ID) {
		s.writeError(w, http.StatusBadRequest, "identity_id_mismatch")
		return
	}
	registered, err := s.st.RegisterIdentity(wantID, req.Alg, strings.ToLower(req.PubKey), time.Now().UnixMilli())
	if err != nil {
		if errors.Is(err, store.ErrIdentityPubKeyMismatch) {
			s.writeError(w, http.StatusConflict, "identity_pubkey_conflict")
			return
		}
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"id": wantID, "alg": req.Alg, "registered": registered})
}

// handleIdentityGet 匿名查询公钥（契约 5.2），供验签他人事件与私信发送方。
func (s *Server) handleIdentityGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !protocol.IsIdentityID(id) {
		s.writeError(w, http.StatusBadRequest, "identity_id_invalid")
		return
	}
	it, ok, err := s.st.LookupIdentity(strings.ToLower(id))
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		s.writeError(w, http.StatusNotFound, "identity_not_found")
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"id": it.ID, "alg": it.Alg, "pubkey": it.PubKey, "created_at": it.CreatedAt,
	})
}

type kdfParams struct {
	Alg string `json:"alg"`
	M   int64  `json:"m"`
	T   int64  `json:"t"`
	P   int64  `json:"p"`
	Len int64  `json:"len"`
}

type escrowPutReq struct {
	ID         string    `json:"id"`
	Alg        string    `json:"alg"`
	Salt       string    `json:"salt"`
	KDF        kdfParams `json:"kdf"`
	EncNonce   string    `json:"enc_nonce"`
	PrivCipher string    `json:"priv_cipher"`
}

// handleEscrowPut 写入密码托管密文（契约 5.3，需签名头）。
// 节点只存不解释：不派生密钥、不解密、不校验密码，因此也无从判断 priv_cipher 是否正确。
func (s *Server) handleEscrowPut(w http.ResponseWriter, r *http.Request) {
	username := r.PathValue("username")
	if !validUsername(username) {
		s.writeError(w, http.StatusBadRequest, "escrow_username_invalid")
		return
	}
	authID := identityFrom(r)
	var req escrowPutReq
	if !s.decodeJSON(w, r, &req) {
		return
	}
	if !strings.EqualFold(req.ID, authID) {
		s.writeError(w, http.StatusForbidden, "escrow_identity_mismatch")
		return
	}
	if req.Alg != protocol.AlgEd25519 {
		s.writeError(w, http.StatusBadRequest, "identity_alg_unsupported")
		return
	}
	if !isHexN(req.Salt, 16) || !isHexN(req.EncNonce, 12) || !isHexNonEmptyEven(req.PrivCipher) {
		s.writeError(w, http.StatusBadRequest, "escrow_param_invalid")
		return
	}
	if req.KDF.Alg != "argon2id" || req.KDF.M <= 0 || req.KDF.T <= 0 || req.KDF.P <= 0 || req.KDF.Len != 32 {
		s.writeError(w, http.StatusBadRequest, "escrow_kdf_invalid")
		return
	}
	kdfJSON, err := json.Marshal(req.KDF)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now().UnixMilli()
	err = s.st.PutEscrow(store.EscrowRecord{
		Username: username, ID: strings.ToLower(req.ID), Alg: req.Alg, Salt: req.Salt,
		KDFJSON: string(kdfJSON), EncNonce: req.EncNonce,
		PrivCipher: req.PrivCipher, UpdatedAt: now,
	})
	if errors.Is(err, store.ErrEscrowConflict) {
		s.writeError(w, http.StatusConflict, "escrow_conflict")
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"username": username, "updated_at": now})
}

// handleEscrowGet 匿名取回托管密文（契约 5.4），同 IP 限速。
func (s *Server) handleEscrowGet(w http.ResponseWriter, r *http.Request) {
	username := r.PathValue("username")
	if !validUsername(username) {
		s.writeError(w, http.StatusBadRequest, "escrow_username_invalid")
		return
	}
	if !s.escrowLimiter.allow(clientIP(r)) {
		w.Header().Set("Retry-After", "60")
		s.writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	rec, ok, err := s.st.GetEscrow(username)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		s.writeError(w, http.StatusNotFound, "escrow_not_found")
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"username": rec.Username, "id": rec.ID, "alg": rec.Alg, "salt": rec.Salt,
		"kdf": json.RawMessage(rec.KDFJSON), "enc_nonce": rec.EncNonce,
		"priv_cipher": rec.PrivCipher, "updated_at": rec.UpdatedAt,
	})
}

// handleMe 返回当前身份与事件/进度骨架（契约 5.5）。
// events/progress 恒为空数组而非 null：结构先定死，客户端可无条件迭代。
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	s.writeJSON(w, http.StatusOK, map[string]any{
		"id": identityFrom(r), "events": []any{}, "progress": []any{},
	})
}

func clientIP(r *http.Request) string {
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return h
	}
	return r.RemoteAddr
}

// ipLimiter 是极简同 IP 令牌桶，只给匿名 escrow 读取用。
// 目的不是抗 DDoS，而是把「离线猜测密码哈希」的请求速率压到可控范围。
type ipLimiter struct {
	mu        sync.Mutex
	rate      float64 // 每秒补充令牌数
	burst     float64
	buckets   map[string]*ipBucket
	lastSweep time.Time
}

type ipBucket struct {
	tokens float64
	last   time.Time
}

func newIPLimiter(perMinute, burst float64) *ipLimiter {
	return &ipLimiter{
		rate: perMinute / 60, burst: burst,
		buckets: map[string]*ipBucket{}, lastSweep: time.Now(),
	}
}

func (l *ipLimiter) allow(ip string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweepLocked(now)
	b, ok := l.buckets[ip]
	if !ok {
		b = &ipBucket{tokens: l.burst, last: now}
		l.buckets[ip] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// sweepLocked 清理 10 分钟无活动的桶，避免 map 无界增长。
func (l *ipLimiter) sweepLocked(now time.Time) {
	if now.Sub(l.lastSweep) < 10*time.Minute {
		return
	}
	l.lastSweep = now
	for ip, b := range l.buckets {
		if now.Sub(b.last) > 10*time.Minute {
			delete(l.buckets, ip)
		}
	}
}
