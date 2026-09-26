package main

import (
	"flag"
	"path/filepath"
	"testing"
)

func peerFlagsForTest(t *testing.T, args ...string) *peerFlags {
	t.Helper()
	// 隔离环境变量，避免外部 BASE_* 影响默认值
	for _, k := range []string{"BASE_DATA", "BASE_TLS_CERT", "BASE_TLS_KEY"} {
		t.Setenv(k, "")
	}
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	pf := registerPeerFlags(fs)
	if err := fs.Parse(args); err != nil {
		t.Fatalf("解析参数失败: %v", err)
	}
	return pf
}

// -tls-cert=off 的语义是「主监听不加密」，不是「本节点没有身份」：
// 主监听要空路径（走明文），但对端监听必须能拿到默认证书路径。
func TestOffTLSMeansPlaintextClientListenerButKeepsDefaultCertPaths(t *testing.T) {
	pf := peerFlagsForTest(t, "-data", "/d", "-tls-cert", "off")

	certPath, keyPath := pf.certPaths()
	if certPath != "" || keyPath != "" {
		t.Fatalf("off 时主监听应为空路径（明文），got %q %q", certPath, keyPath)
	}

	dc, dk := pf.defaultCertPaths()
	if dc != filepath.Join("/d", "tls", "node.crt") || dk != filepath.Join("/d", "tls", "node.key") {
		t.Fatalf("对端监听应落回默认证书路径，got %q %q", dc, dk)
	}
}

// off 时出站（节点↔节点）仍要证书：不能报错，要落回默认路径。
func TestOffTLSStillLoadsCertForOutbound(t *testing.T) {
	dir := t.TempDir()
	pf := peerFlagsForTest(t, "-data", dir, "-tls-cert", "off")

	info, err := pf.tlsInfo()
	if err != nil {
		t.Fatalf("off 时出站应落回默认证书路径，实际报错: %v", err)
	}
	if info.FingerprintHex == "" {
		t.Fatalf("出站证书指纹为空")
	}
	// 落盘位置必须在 data/ 的 tls/ 下（总纲 §7.2）
	if _, err := filepath.Glob(filepath.Join(dir, "tls", "node.crt")); err != nil {
		t.Fatalf("默认证书未落地: %v", err)
	}
}

// 非 off 时的两种取值：缺省 <data>/tls/node.crt|key，显式则用显式。
func TestCertPathsDefaultAndExplicit(t *testing.T) {
	pf := peerFlagsForTest(t, "-data", "/d")
	c, k := pf.certPaths()
	if c != filepath.Join("/d", "tls", "node.crt") || k != filepath.Join("/d", "tls", "node.key") {
		t.Fatalf("缺省路径不对: %q %q", c, k)
	}

	pf = peerFlagsForTest(t, "-data", "/d", "-tls-cert", "/x/n.crt", "-tls-key", "/x/n.key")
	c, k = pf.certPaths()
	if c != "/x/n.crt" || k != "/x/n.key" {
		t.Fatalf("显式路径未被采用: %q %q", c, k)
	}
}