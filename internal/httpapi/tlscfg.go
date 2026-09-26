package httpapi

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base32"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrFingerprintMismatch 是指纹固定失败的哨兵错误（契约 6.1 的 tls_fingerprint_mismatch）。
// 调用方用 errors.Is 判定；**没有忽略路径**——不匹配即断。
var ErrFingerprintMismatch = errors.New("tls_fingerprint_mismatch")

const (
	// 指纹前 10 字节 → Base32 无填充恰好 16 字符（80 bit / 5 bit = 16）。
	pairingBytes = 10
	certValidity = 10 * 365 * 24 * time.Hour
)

// TLSInfo 描述节点自身的 TLS 身份。证书一旦生成，四个字段同时固定；
// 轮换会换掉全部值，所有客户端需重新配对（契约 6.2）。
type TLSInfo struct {
	CertFile       string
	KeyFile        string
	FingerprintHex string // 证书 DER 的 sha256 hex（小写 64 字符）
	PairingCode    string // 指纹前 10 字节 → Base32 → 4-4-4-4
}

// LoadOrCreateTLSCert 加载自签证书；证书文件不存在则生成（ECDSA P-256）。
// 生成写两个文件：证书 0644、私钥 0600。
func LoadOrCreateTLSCert(certFile, keyFile string) (TLSInfo, error) {
	if strings.TrimSpace(certFile) == "" || strings.TrimSpace(keyFile) == "" {
		return TLSInfo{}, errors.New("tls: 证书与私钥路径都不能为空")
	}
	switch _, err := os.Stat(certFile); {
	case errors.Is(err, os.ErrNotExist):
		if err := generateSelfSigned(certFile, keyFile); err != nil {
			return TLSInfo{}, err
		}
	case err != nil:
		return TLSInfo{}, fmt.Errorf("tls: stat %s: %w", certFile, err)
	}

	pemBytes, err := os.ReadFile(certFile)
	if err != nil {
		return TLSInfo{}, fmt.Errorf("tls: read %s: %w", certFile, err)
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return TLSInfo{}, fmt.Errorf("tls: %s 不是 PEM", certFile)
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return TLSInfo{}, fmt.Errorf("tls: parse %s: %w", certFile, err)
	}
	fp := FingerprintHex(cert)
	code, err := PairingCode(fp)
	if err != nil {
		return TLSInfo{}, err
	}
	return TLSInfo{CertFile: certFile, KeyFile: keyFile, FingerprintHex: fp, PairingCode: code}, nil
}

// FingerprintHex 返回证书 DER 的 sha256 hex（小写 64 字符）。
func FingerprintHex(cert *x509.Certificate) string {
	sum := sha256.Sum256(cert.Raw)
	return hex.EncodeToString(sum[:])
}

// PairingCode 把指纹前 10 字节编成 16 字符 Base32，按 4-4-4-4 分组（契约 6.1）。
func PairingCode(fingerprintHex string) (string, error) {
	raw, err := hex.DecodeString(strings.TrimSpace(fingerprintHex))
	if err != nil {
		return "", fmt.Errorf("tls: 指纹不是 hex: %w", err)
	}
	if len(raw) < pairingBytes {
		return "", fmt.Errorf("tls: 指纹至少 %d 字节，got %d", pairingBytes, len(raw))
	}
	enc := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw[:pairingBytes])
	if len(enc) != 16 {
		return "", fmt.Errorf("tls: 配对码长度 %d, want 16", len(enc))
	}
	return enc[0:4] + "-" + enc[4:8] + "-" + enc[8:12] + "-" + enc[12:16], nil
}

// generateSelfSigned 生成 ECDSA P-256 自签证书；IsCA 是为了让同一张证书
// 既能做服务端也能做客户端（节点↔节点双向 TLS 用同一张）。
func generateSelfSigned(certFile, keyFile string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("tls: 生成密钥: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return fmt.Errorf("tls: 生成序列号: %w", err)
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "base-node", Organization: []string{"base"}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(certValidity),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		DNSNames:              []string{"base-node"},
		IPAddresses:           []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return fmt.Errorf("tls: 自签证书: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return fmt.Errorf("tls: 序列化私钥: %w", err)
	}
	dir := filepath.Dir(certFile)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("tls: mkdir %s: %w", dir, err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(certFile, certPEM, 0o644); err != nil {
		return fmt.Errorf("tls: 写 %s: %w", certFile, err)
	}
	if err := os.WriteFile(keyFile, keyPEM, 0o600); err != nil {
		return fmt.Errorf("tls: 写 %s: %w", keyFile, err)
	}
	return nil
}

// PeerVerifier 返回指纹固定回调：只接受 DER 的 sha256 命中白名单的证书。
// 空白名单 = 拒绝一切（fail-closed），绝不退化成「不校验」。
func PeerVerifier(allowed []string) func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
	set := make(map[string]struct{}, len(allowed))
	for _, f := range allowed {
		set[strings.ToLower(strings.TrimSpace(f))] = struct{}{}
	}
	return func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		if len(rawCerts) == 0 {
			return fmt.Errorf("%w: 对端未提供证书", ErrFingerprintMismatch)
		}
		sum := sha256.Sum256(rawCerts[0])
		got := hex.EncodeToString(sum[:])
		if _, ok := set[got]; !ok {
			return fmt.Errorf("%w: 对端指纹 %s 不在白名单", ErrFingerprintMismatch, got)
		}
		return nil
	}
}

// ServerTLSConfig 构造服务端配置。peerFingerprints 非空时启用双向 TLS 并要求对端指纹命中白名单。
func ServerTLSConfig(info TLSInfo, peerFingerprints []string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(info.CertFile, info.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("tls: 加载密钥对: %w", err)
	}
	cfg := &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	if len(peerFingerprints) > 0 {
		// RequireAnyClientCert：不依赖系统 CA 链，信任完全由下方指纹固定承担。
		cfg.ClientAuth = tls.RequireAnyClientCert
		cfg.VerifyPeerCertificate = PeerVerifier(peerFingerprints)
	}
	return cfg, nil
}

// ClientTLSConfig 构造出站配置：跳过系统 CA 校验，信任完全由指纹固定承担；
// 同时带上本节点证书，供对端做双向 TLS 校验（契约 6.1 的节点↔节点互认，
// 否则对端 RequireAnyClientCert 会直接拒绝「未提供证书」的客户端）。
// 这是自签 + 指纹固定的标准写法——InsecureSkipVerify 在此**不**等于不安全。
func ClientTLSConfig(own TLSInfo, peerFingerprintHex string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(own.CertFile, own.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("tls: 加载本节点密钥对: %w", err)
	}
	return &tls.Config{
		Certificates:          []tls.Certificate{cert},
		InsecureSkipVerify:    true,
		VerifyPeerCertificate: PeerVerifier([]string{peerFingerprintHex}),
		MinVersion:            tls.VersionTLS12,
	}, nil
}

// RequireNodeKey 校验节点间预共享密钥头（契约 6.3：与 TLS 指纹是两层，互不替代）。
func (s *Server) RequireNodeKey(key string, next http.Handler) http.Handler {
	want := []byte(key)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := []byte(r.Header.Get("X-Base-Node-Key"))
		if len(got) != len(want) || subtle.ConstantTimeCompare(got, want) != 1 {
			s.writeAuthErr(w, http.StatusUnauthorized, "node_key_mismatch")
			return
		}
		next.ServeHTTP(w, r)
	})
}
