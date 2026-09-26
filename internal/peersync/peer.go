// Package peersync 负责节点↔节点的出站行为：拉内容包、拉块、反熵比对、scrub 补齐。
// 入站接口在 internal/httpapi/peer.go；本包只发起请求，不提供任何 handler。
package peersync

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/johocn/base/internal/httpapi"
)

// Peer 是一个对端节点（与 cmd/based 的 peerSpec / BASE_PEERS 元素同形）。
type Peer struct {
	URL            string `json:"url"`
	TLSFingerprint string `json:"tls_fingerprint"`
}

// Config 是一次 Session 的出站配置。
type Config struct {
	// OwnTLS 是本节点 TLS 身份（对端是双向 TLS，客户端必须带证书）。
	OwnTLS httpapi.TLSInfo
	// NodeKey 可选；非空时所有出站请求带 X-Base-Node-Key（对端监听可叠加这层）。
	NodeKey string
	// IssuerPubKeys 是签发方公钥信任表（issuer → 公钥 hex64），来源只有配置注入。
	IssuerPubKeys map[string]string
	// FetchMaxBlobs 是 fetch 单请求块数上限；<=0 取 defaultFetchMaxBlobs。
	FetchMaxBlobs int
	// TransportFor 为 nil 时按 OwnTLS + peer 指纹构造 TLS 传输（生产路径）。
	// 非 nil 时用它（测试注入进程内传输：本机 Go 同进程回环 TCP 不可用）。
	TransportFor func(p Peer) (http.RoundTripper, error)
}

const (
	defaultFetchMaxBlobs = 64
	requestTimeout       = 2 * time.Minute
)

func (c Config) client(p Peer) (*http.Client, error) {
	var tr http.RoundTripper
	if c.TransportFor != nil {
		t, err := c.TransportFor(p)
		if err != nil {
			return nil, err
		}
		tr = t
	} else {
		tlsCfg, err := httpapi.ClientTLSConfig(c.OwnTLS, p.TLSFingerprint)
		if err != nil {
			return nil, err
		}
		tr = &http.Transport{TLSClientConfig: tlsCfg, MaxIdleConns: 4, IdleConnTimeout: 60 * time.Second}
	}
	return &http.Client{Transport: tr, Timeout: requestTimeout}, nil
}

func (c Config) fetchMaxBlobs() int {
	if c.FetchMaxBlobs <= 0 {
		return defaultFetchMaxBlobs
	}
	return c.FetchMaxBlobs
}

// do 发起一次请求并叠加 node key（对端监听的第三层鉴权）。
func (c Config) do(ctx context.Context, hc *http.Client, method, url string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	if c.NodeKey != "" {
		req.Header.Set("X-Base-Node-Key", c.NodeKey)
	}
	return hc.Do(req)
}

// issuerPubKey 是 BASE_ISSUER_PUBKEYS 的元素（册子 §6.1）。
type issuerPubKey struct {
	Issuer       string `json:"issuer"`
	PublicKeyHex string `json:"public_key_hex"`
}

// ParseIssuerPubKeys 解析签发方公钥信任表：issuer → 公钥 hex64。
// 这是**唯一**的信任来源：不做 TOFU、不调 /v1/pubkey（册子 §6.1、风险 3）。
// 空串 → 空表（缓存节点若手工起服务但没配信任表，ImportPack 会在验签处拒绝整包并告警）。
func ParseIssuerPubKeys(raw string) (map[string]string, error) {
	out := map[string]string{}
	if strings.TrimSpace(raw) == "" {
		return out, nil
	}
	var list []issuerPubKey
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil, fmt.Errorf("BASE_ISSUER_PUBKEYS 不是合法 JSON 数组: %w", err)
	}
	for i, e := range list {
		issuer := strings.TrimSpace(e.Issuer)
		if issuer == "" {
			return nil, fmt.Errorf("BASE_ISSUER_PUBKEYS[%d]: issuer 不能为空", i)
		}
		pub := strings.ToLower(strings.TrimSpace(e.PublicKeyHex))
		if len(pub) != 64 || !isLowerHex(pub) {
			return nil, fmt.Errorf("BASE_ISSUER_PUBKEYS[%d]: public_key_hex 必须是 64 位小写 hex", i)
		}
		out[issuer] = pub
	}
	return out, nil
}

func isLowerHex(s string) bool {
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
