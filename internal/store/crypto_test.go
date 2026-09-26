package store

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
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

func TestStoreKeyStatus(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(envStoreKey, "")
	t.Setenv(envStoreKeyFile, "")

	// 1. 无密钥文件：只报告路径，不创建文件。
	path, keyHex, exists, err := StoreKeyStatus(dir)
	if err != nil {
		t.Fatalf("StoreKeyStatus: %v", err)
	}
	if path != defaultStoreKeyPath(dir) {
		t.Fatalf("path = %s, want %s", path, defaultStoreKeyPath(dir))
	}
	if exists || keyHex != "" {
		t.Fatalf("密钥不应存在，got exists=%v hex=%q", exists, keyHex)
	}
	if _, err := os.Stat(defaultStoreKeyPath(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("StoreKeyStatus 不得创建密钥文件")
	}

	// 2. 已有密钥文件。
	if err := os.WriteFile(defaultStoreKeyPath(dir), []byte(testKeyHex+"\n"), 0o600); err != nil {
		t.Fatalf("预置密钥: %v", err)
	}
	path, keyHex, exists, err = StoreKeyStatus(dir)
	if err != nil {
		t.Fatalf("StoreKeyStatus: %v", err)
	}
	if !exists || keyHex != testKeyHex || path != defaultStoreKeyPath(dir) {
		t.Fatalf("got path=%s exists=%v hex=%s", path, exists, keyHex)
	}

	// 3. 环境变量注入：无文件路径。
	envKey := strings.Repeat("ab", 32)
	t.Setenv(envStoreKey, envKey)
	path, keyHex, exists, err = StoreKeyStatus(dir)
	if err != nil {
		t.Fatalf("StoreKeyStatus(env): %v", err)
	}
	if !exists || keyHex != envKey || path != "" {
		t.Fatalf("got path=%q exists=%v hex=%s", path, exists, keyHex)
	}
	t.Setenv(envStoreKey, "")

	// 4. 代码注入：无文件路径。
	path, keyHex, exists, err = StoreKeyStatus(dir, WithStoreKey(testKeyHex))
	if err != nil {
		t.Fatalf("StoreKeyStatus(opt): %v", err)
	}
	if !exists || keyHex != testKeyHex || path != "" {
		t.Fatalf("got path=%q exists=%v hex=%s", path, exists, keyHex)
	}

	// 5. 坏密钥文件：报错而不是静默当不存在。
	badDir := t.TempDir()
	if err := os.WriteFile(defaultStoreKeyPath(badDir), []byte("not-hex"), 0o600); err != nil {
		t.Fatalf("预置坏密钥: %v", err)
	}
	if _, _, _, err := StoreKeyStatus(badDir); err == nil {
		t.Fatal("坏密钥文件应报错")
	}
}

// TestAEADGoldenVector 消费 vectors/v1/aead.json：TS 侧 aead.ts 与 Go 侧 Encrypt/Decrypt
// 必须是同一种封装格式，否则跨语言读不了对方的密文（修正 7）。
// 失败时改代码，不许改向量——向量是两侧的共同契约。
func TestAEADGoldenVector(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "aead.json"))
	if err != nil {
		t.Fatalf("读黄金向量: %v", err)
	}
	var v struct {
		KeyHex        string `json:"key_hex"`
		NonceHex      string `json:"nonce_hex"`
		PlaintextHex  string `json:"plaintext_hex"`
		CiphertextHex string `json:"ciphertext_hex"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("解析黄金向量: %v", err)
	}

	dir := t.TempDir()
	if err := os.WriteFile(defaultStoreKeyPath(dir), []byte(v.KeyHex+"\n"), 0o600); err != nil {
		t.Fatalf("预置密钥: %v", err)
	}
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = st.Close() }()

	if got := st.StoreKeyHex(); got != v.KeyHex {
		t.Fatalf("密钥 = %s, want %s", got, v.KeyHex)
	}

	nonce, err := hex.DecodeString(v.NonceHex)
	if err != nil {
		t.Fatalf("nonce 不是 hex: %v", err)
	}
	if len(nonce) != gcmNonceSize {
		t.Fatalf("向量 nonce 长度 = %d, want %d", len(nonce), gcmNonceSize)
	}
	plain, err := hex.DecodeString(v.PlaintextHex)
	if err != nil {
		t.Fatalf("plaintext 不是 hex: %v", err)
	}
	wantCT, err := hex.DecodeString(v.CiphertextHex)
	if err != nil {
		t.Fatalf("ciphertext 不是 hex: %v", err)
	}

	// 同 nonce 下 Go 的封装必须逐字节等于 TS 的 ciphertext||tag。
	if got := st.aead.Seal(nil, nonce, plain, nil); !bytes.Equal(got, wantCT) {
		t.Fatalf("Go 封装与 TS 不一致:\n got %x\nwant %x", got, wantCT)
	}
	// 反向：Go 必须能解开 TS 的密文。
	gotPlain, err := st.aead.Open(nil, nonce, wantCT, nil)
	if err != nil {
		t.Fatalf("Go 解 TS 密文失败: %v", err)
	}
	if !bytes.Equal(gotPlain, plain) {
		t.Fatalf("解出的明文不一致:\n got %x\nwant %x", gotPlain, plain)
	}
	// 完整拼接形态 nonce || ct || tag（与 TS 的 seal 一致）：Encrypt 自带随机 nonce，
	// 而 GCM 的密文与 nonce 绑定，故 ct||tag 不会等于向量——这里只锁长度与「能解开」。
	gotBlob, err := st.Encrypt(plain)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if want := gcmNonceSize + len(wantCT); len(gotBlob) != want {
		t.Fatalf("封装长度 = %d, want %d", len(gotBlob), want)
	}
	back, err := st.Decrypt(gotBlob)
	if err != nil {
		t.Fatalf("Decrypt 自己的封装失败: %v", err)
	}
	if !bytes.Equal(back, plain) {
		t.Fatalf("往返明文不一致:\n got %x\nwant %x", back, plain)
	}
	// 跨语言正向：把 TS 的 seal 输出（nonce || ct || tag）原样喂给 Go，必须解得开。
	tsBlob := make([]byte, 0, gcmNonceSize+len(wantCT))
	tsBlob = append(tsBlob, nonce...)
	tsBlob = append(tsBlob, wantCT...)
	if back, err := st.Decrypt(tsBlob); err != nil || !bytes.Equal(back, plain) {
		t.Fatalf("Go 解 TS 的拼接密文失败: err=%v got=%x", err, back)
	}
}
