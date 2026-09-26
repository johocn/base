package httpapi

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestPairingCode(t *testing.T) {
	// 指纹前 10 字节全 0 → Base32 无填充 16 个 'A'
	code, err := PairingCode(strings.Repeat("00", 32))
	if err != nil {
		t.Fatalf("PairingCode: %v", err)
	}
	if code != "AAAA-AAAA-AAAA-AAAA" {
		t.Fatalf("PairingCode = %s, want AAAA-AAAA-AAAA-AAAA", code)
	}
	if len(code) != 19 {
		t.Fatalf("配对码长度 = %d, want 19（4-4-4-4）", len(code))
	}
	if _, err := PairingCode("not-hex"); err == nil {
		t.Fatal("非 hex 指纹应报错")
	}
	if _, err := PairingCode("0011"); err == nil {
		t.Fatal("不足 10 字节的指纹应报错")
	}
}

func TestLoadOrCreateTLSCertIdempotent(t *testing.T) {
	dir := t.TempDir()
	certFile := filepath.Join(dir, "tls", "node.crt")
	keyFile := filepath.Join(dir, "tls", "node.key")

	first, err := LoadOrCreateTLSCert(certFile, keyFile)
	if err != nil {
		t.Fatalf("首次生成: %v", err)
	}
	if len(first.FingerprintHex) != 64 {
		t.Fatalf("指纹长度 = %d, want 64", len(first.FingerprintHex))
	}
	if first.PairingCode == "" {
		t.Fatal("配对码不应为空")
	}
	if _, err := os.Stat(filepath.Join(dir, "tls")); err != nil {
		t.Fatalf("证书目录未创建: %v", err)
	}
	// Windows 不支持 POSIX 权限位，os.WriteFile 的 0600 在 Windows 上只映射只读位，
	// 断言权限只对非 Windows 有意义。
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(keyFile)
		if err != nil {
			t.Fatalf("stat key: %v", err)
		}
		if perm := fi.Mode().Perm(); perm != 0o600 {
			t.Fatalf("私钥权限 = %o, want 600", perm)
		}
	}

	second, err := LoadOrCreateTLSCert(certFile, keyFile)
	if err != nil {
		t.Fatalf("二次加载: %v", err)
	}
	if second.FingerprintHex != first.FingerprintHex {
		t.Fatalf("二次加载指纹漂移: %s != %s", second.FingerprintHex, first.FingerprintHex)
	}
	if second.PairingCode != first.PairingCode {
		t.Fatalf("二次加载配对码漂移: %s != %s", second.PairingCode, first.PairingCode)
	}
}

func TestLoadOrCreateTLSCertRejectsEmptyPath(t *testing.T) {
	if _, err := LoadOrCreateTLSCert("", ""); err == nil {
		t.Fatal("空路径应报错")
	}
}

func TestPeerVerifierRejectsUnknown(t *testing.T) {
	if err := PeerVerifier([]string{"aa"})(nil, nil); !errors.Is(err, ErrFingerprintMismatch) {
		t.Fatalf("对端未提供证书应报指纹不匹配，got %v", err)
	}
	if err := PeerVerifier([]string{"aa"})([][]byte{{0x01}}, nil); !errors.Is(err, ErrFingerprintMismatch) {
		t.Fatalf("未知指纹应报指纹不匹配，got %v", err)
	}
	// fail-closed：空白名单必须拒绝一切，不能退化成「不校验」。
	if err := PeerVerifier(nil)([][]byte{{0x01}}, nil); !errors.Is(err, ErrFingerprintMismatch) {
		t.Fatalf("空白名单必须拒绝，got %v", err)
	}
	sum := sha256.Sum256([]byte{0x01})
	if err := PeerVerifier([]string{hex.EncodeToString(sum[:])})([][]byte{{0x01}}, nil); err != nil {
		t.Fatalf("命中白名单应通过，got %v", err)
	}
}

// TestPeerVerifierHandshake 用 net.Pipe 跑真实 TLS 握手，覆盖「指纹命中才连得上」。
func TestPeerVerifierHandshake(t *testing.T) {
	dirA, dirB := t.TempDir(), t.TempDir()
	a, err := LoadOrCreateTLSCert(filepath.Join(dirA, "a.crt"), filepath.Join(dirA, "a.key"))
	if err != nil {
		t.Fatalf("A 证书: %v", err)
	}
	b, err := LoadOrCreateTLSCert(filepath.Join(dirB, "b.crt"), filepath.Join(dirB, "b.key"))
	if err != nil {
		t.Fatalf("B 证书: %v", err)
	}

	cases := []struct {
		name        string
		serverTrust []string // 服务端接受的对端（客户端）指纹
		clientWants string   // 客户端固定期望的服务端指纹
		wantErr     bool
	}{
		{"指纹互相命中", []string{b.FingerprintHex}, a.FingerprintHex, false},
		{"客户端指纹不在白名单", []string{strings.Repeat("ab", 32)}, a.FingerprintHex, true},
		{"服务端指纹不匹配", []string{b.FingerprintHex}, strings.Repeat("cd", 32), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srvCfg, err := ServerTLSConfig(a, tc.serverTrust)
			if err != nil {
				t.Fatalf("ServerTLSConfig: %v", err)
			}
			cliCfg, err := ClientTLSConfig(b, tc.clientWants)
			if err != nil {
				t.Fatalf("ClientTLSConfig: %v", err)
			}

			c1, c2 := net.Pipe()
			defer c1.Close()
			defer c2.Close()
			_ = c1.SetDeadline(time.Now().Add(5 * time.Second))
			_ = c2.SetDeadline(time.Now().Add(5 * time.Second))

			errCh := make(chan error, 1)
			go func() { errCh <- tls.Client(c1, cliCfg).Handshake() }()
			srvErr := tls.Server(c2, srvCfg).Handshake()

			// TLS 1.3 下服务端校验客户端证书发生在客户端 Handshake() 返回之后，
			// 因此「服务端拒绝客户端指纹」只能从服务端侧观察到；两侧都看。
			var cliErr error
			select {
			case cliErr = <-errCh:
			case <-time.After(5 * time.Second):
				t.Fatal("握手超时")
			}
			if tc.wantErr {
				if cliErr == nil && srvErr == nil {
					t.Fatalf("期望至少一侧握手失败，实际双方都成功")
				}
				return
			}
			if cliErr != nil || srvErr != nil {
				t.Fatalf("期望握手成功，实际 cli=%v srv=%v", cliErr, srvErr)
			}
		})
	}
}

func TestClientTLSConfigPinsFingerprint(t *testing.T) {
	dir := t.TempDir()
	info, err := LoadOrCreateTLSCert(filepath.Join(dir, "n.crt"), filepath.Join(dir, "n.key"))
	if err != nil {
		t.Fatalf("证书: %v", err)
	}
	cfg, err := ClientTLSConfig(info, info.FingerprintHex)
	if err != nil {
		t.Fatalf("ClientTLSConfig: %v", err)
	}
	if len(cfg.Certificates) != 1 {
		t.Fatal("出站配置必须带上本节点证书，否则对端双向 TLS 无法完成")
	}
	if !cfg.InsecureSkipVerify {
		t.Fatal("自签证书必须跳过系统 CA 校验，改由指纹固定承担信任")
	}
	if cfg.VerifyPeerCertificate == nil {
		t.Fatal("必须设置 VerifyPeerCertificate，否则指纹固定形同虚设")
	}
	if err := cfg.VerifyPeerCertificate([][]byte{[]byte("other")}, nil); !errors.Is(err, ErrFingerprintMismatch) {
		t.Fatalf("错误证书应被拒，got %v", err)
	}
}

func TestRequireNodeKey(t *testing.T) {
	s := &Server{}
	h := s.RequireNodeKey("s3cret", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	cases := []struct {
		name string
		key  string
		want int
	}{
		{"密钥匹配", "s3cret", http.StatusOK},
		{"密钥不匹配", "wrong", http.StatusUnauthorized},
		{"密钥缺失", "", http.StatusUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/v1/healthz", nil)
			if tc.key != "" {
				req.Header.Set("X-Base-Node-Key", tc.key)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("状态码 = %d, want %d", rec.Code, tc.want)
			}
			if tc.want == http.StatusUnauthorized && !strings.Contains(rec.Body.String(), "node_key_mismatch") {
				t.Fatalf("错误体应含机器码 node_key_mismatch，got %s", rec.Body.String())
			}
		})
	}
}
