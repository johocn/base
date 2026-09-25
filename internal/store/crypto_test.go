package store

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const testKeyHex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

// assertPlaintextAbsent 断言 plain 不出现在 dir 下任一文件里（含 WAL/SHM）。
// 这是 L4a′ 的全部意义所在：误拷 data 目录不应泄漏内容。
func assertPlaintextAbsent(t *testing.T, dir string, plain []byte) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir(%s): %v", dir, err)
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		if bytes.Contains(b, plain) {
			t.Fatalf("明文泄漏到 %s 目录的 %s 文件", dir, e.Name())
		}
	}
}

func TestStoreKeyFromExplicitOption(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir, WithStoreKey(strings.ToUpper(testKeyHex)))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	if st.StoreKeyHex() != testKeyHex {
		t.Fatalf("StoreKeyHex = %s, want %s（应大小写归一）", st.StoreKeyHex(), testKeyHex)
	}
	if st.StoreKeyPath() != "" {
		t.Fatalf("显式注入不应有密钥文件路径，got %q", st.StoreKeyPath())
	}
	if _, err := os.Stat(defaultStoreKeyPath(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("显式注入不应写默认密钥文件，stat err=%v", err)
	}
}

func TestStoreKeyFromEnv(t *testing.T) {
	dir := t.TempDir()
	envKey := strings.Repeat("ab", 32)
	t.Setenv(envStoreKey, envKey)
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	if st.StoreKeyHex() != envKey {
		t.Fatalf("StoreKeyHex = %s, want %s", st.StoreKeyHex(), envKey)
	}
	if st.StoreKeyPath() != "" {
		t.Fatalf("env 注入不应有文件路径，got %q", st.StoreKeyPath())
	}
}

func TestStoreKeyFromEnvFile(t *testing.T) {
	dir := t.TempDir()
	keyFile := filepath.Join(t.TempDir(), "store.key")
	envKey := strings.Repeat("cd", 32)
	if err := os.WriteFile(keyFile, []byte(envKey+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(envStoreKey, "")
	t.Setenv(envStoreKeyFile, keyFile)
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	if st.StoreKeyHex() != envKey || st.StoreKeyPath() != keyFile {
		t.Fatalf("key=%s path=%s, want %s / %s", st.StoreKeyHex(), st.StoreKeyPath(), envKey, keyFile)
	}
}

func TestStoreKeyGeneratedOnceAndReused(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(envStoreKey, "")
	t.Setenv(envStoreKeyFile, "")
	st1, err := Open(dir)
	if err != nil {
		t.Fatalf("Open(1): %v", err)
	}
	first := st1.StoreKeyHex()
	keyPath := st1.StoreKeyPath()
	if len(first) != 64 {
		t.Fatalf("生成的密钥 hex 长度 = %d, want 64", len(first))
	}
	if keyPath != defaultStoreKeyPath(dir) {
		t.Fatalf("密钥路径 = %s, want %s", keyPath, defaultStoreKeyPath(dir))
	}
	if filepath.Dir(keyPath) == filepath.Clean(dir) {
		t.Fatalf("密钥文件不能放在 data 目录内: %s", keyPath)
	}
	if err := st1.Close(); err != nil {
		t.Fatal(err)
	}

	st2, err := Open(dir)
	if err != nil {
		t.Fatalf("Open(2): %v", err)
	}
	defer func() { _ = st2.Close() }()
	if st2.StoreKeyHex() != first {
		t.Fatalf("二次 Open 密钥漂移: %s != %s", st2.StoreKeyHex(), first)
	}
}

func TestStoreKeyFilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 无 POSIX 权限位，0600 由部署脚本/容器保证")
	}
	dir := t.TempDir()
	t.Setenv(envStoreKey, "")
	t.Setenv(envStoreKeyFile, "")
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()
	fi, err := os.Stat(st.StoreKeyPath())
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("密钥文件权限 = %o, want 600", perm)
	}
}

func TestStoreKeyRejectsBadInput(t *testing.T) {
	dir := t.TempDir()
	for _, bad := range []string{"", "   ", "zz", strings.Repeat("ab", 31), strings.Repeat("ab", 33)} {
		if _, err := Open(dir, WithStoreKey(bad)); err == nil {
			t.Fatalf("WithStoreKey(%q) 期望报错", bad)
		}
	}
	st, err := Open(dir, WithStoreKey(testKeyHex))
	if err != nil {
		t.Fatalf("合法密钥被拒: %v", err)
	}
	_ = st.Close() // Windows 上不关会锁住 base.db，导致 TempDir 清理失败
}

func TestEncryptDecryptRoundTrip(t *testing.T) {
	st := openTemp(t)
	for _, plain := range []string{"", "a", strings.Repeat("中文内容", 1000)} {
		ct, err := st.Encrypt([]byte(plain))
		if err != nil {
			t.Fatalf("Encrypt: %v", err)
		}
		if len(ct) != len(plain)+gcmNonceSize+gcmTagSize {
			t.Fatalf("密文长度 = %d, want %d", len(ct), len(plain)+gcmNonceSize+gcmTagSize)
		}
		got, err := st.Decrypt(ct)
		if err != nil {
			t.Fatalf("Decrypt: %v", err)
		}
		if string(got) != plain {
			t.Fatalf("往返不一致: %q != %q", got, plain)
		}
	}
}

func TestEncryptUsesFreshNonce(t *testing.T) {
	st := openTemp(t)
	a, err := st.Encrypt([]byte("same"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.Encrypt([]byte("same"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(a, b) {
		t.Fatal("两次加密结果相同，nonce 未随机化")
	}
	if bytes.Equal(a[:gcmNonceSize], b[:gcmNonceSize]) {
		t.Fatal("nonce 前缀相同")
	}
}

func TestDecryptRejectsTamperWrongKeyShort(t *testing.T) {
	st := openTemp(t)
	ct, err := st.Encrypt([]byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	bad := append([]byte(nil), ct...)
	bad[len(bad)-1] ^= 0x01
	if _, err := st.Decrypt(bad); err == nil {
		t.Fatal("篡改密文后仍解密成功")
	}

	other, err := Open(t.TempDir(), WithStoreKey(strings.Repeat("ff", 32)))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = other.Close() }()
	if _, err := other.Decrypt(ct); err == nil {
		t.Fatal("换密钥后仍解密成功")
	}

	for _, short := range [][]byte{{}, []byte("short"), make([]byte, gcmNonceSize+gcmTagSize-1)} {
		if _, err := st.Decrypt(short); err == nil {
			t.Fatalf("过短密文（%d 字节）未报错", len(short))
		}
	}
}

func TestEncTextPrefixAndLegacyPlaintext(t *testing.T) {
	st := openTemp(t)
	enc, err := st.encText("正文内容")
	if err != nil {
		t.Fatalf("encText: %v", err)
	}
	if !strings.HasPrefix(enc, encPrefix) {
		t.Fatalf("密文缺少前缀: %q", enc)
	}
	if strings.Contains(enc, "正文内容") {
		t.Fatal("密文里出现了明文")
	}
	got, err := st.decText(enc)
	if err != nil || got != "正文内容" {
		t.Fatalf("decText = %q err=%v", got, err)
	}
	if got, err := st.decText("历史明文"); err != nil || got != "历史明文" {
		t.Fatalf("历史明文行应原样返回, got %q err=%v", got, err)
	}
	if s, err := st.encText(""); err != nil || s != "" {
		t.Fatalf("空串应保持空, got %q err=%v", s, err)
	}
	if _, err := st.decText(encPrefix + "!!!not-base64!!!"); err == nil {
		t.Fatal("坏 base64 未报错")
	}
}
