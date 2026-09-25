package protocol

// RequestMeta 是一次请求中参与签名的元数据（不含请求体本身）。
// 无 JWT、无 session：节点验签通过即放行，身份由公钥派生 id 自证。
type RequestMeta struct {
	Method     string // 大写，如 "POST"
	Path       string // 不含 query，如 "/v1/identity/escrow/alice"
	Query      string // 原始 query string（r.URL.RawQuery），无则空串
	BodySHA256 string // 请求体原始字节的 sha256 hex；无请求体时用 EmptyBodySHA256()
	TS         int64  // 客户端 Unix 毫秒
	Nonce      string // 每次请求唯一的随机值，16 字节 hex
}

// RequestSignBytes 返回待签字节：canonical({method,path,query,body_sha256,ts,nonce})。
//
// 这是不可变契约：Go 与 TS 两侧必须产出完全一致的字节，
// 由 vectors/v1/reqsig.json 同时消费来锁死。字段增删即协议破坏。
func RequestSignBytes(m RequestMeta) ([]byte, error) {
	return Canonicalize(map[string]any{
		"method":      m.Method,
		"path":        m.Path,
		"query":       m.Query,
		"body_sha256": m.BodySHA256,
		"ts":          m.TS,
		"nonce":       m.Nonce,
	})
}

// EmptyBodySHA256 是无请求体请求的固定 body_sha256 取值。
// 固定值而非省略字段：让"无请求体"也有确定的签名输入，避免歧义。
func EmptyBodySHA256() string { return SHA256Hex(nil) }
