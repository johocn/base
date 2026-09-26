package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// L4a′：节点本地静态加密。
// 加密与解密只发生在 store 包内部（落盘前 / 读盘后）：
// 跨过 store 边界的一律是明文，因此「同一内容在两个节点上 blob_id 相同、跨节点传输零重加密」仍然成立。
//
// 密钥独立于节点签名私钥，绝不派生：签名私钥轮换不应让历史内容不可读。
const (
	storeKeySize    = 32 // AES-256
	gcmNonceSize    = 12
	gcmTagSize      = 16
	encPrefix       = "enc:v1:" // 仅用于 TEXT 列（body_md），用于识别历史明文行
	envStoreKey     = "BASE_STORE_KEY"
	envStoreKeyFile = "BASE_STORE_KEY_FILE"
)

// Option 是 Open 的可选配置。
type Option func(*openConfig) error

type openConfig struct {
	storeKeyHex string
	storeKeySet bool
}

// WithStoreKey 直接注入 64 位 hex 密钥（优先级最高；测试与代码内嵌用）。
// 显式传入空串视为配置错误而非"未设置"：否则会静默回退到默认密钥文件。
func WithStoreKey(hexKey string) Option {
	return func(c *openConfig) error {
		c.storeKeyHex = hexKey
		c.storeKeySet = true
		return nil
	}
}

// defaultStoreKeyPath 返回默认密钥文件路径：data 目录的**兄弟文件**，不是 data 目录内的文件。
// 触发威胁是「误拷/备份 data 目录」，密钥放进 data/ 等于形同虚设。
func defaultStoreKeyPath(dataDir string) string {
	return filepath.Clean(dataDir) + ".key"
}

func parseStoreKey(raw string) ([]byte, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, fmt.Errorf("store: empty store key")
	}
	key, err := hex.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("store: store key is not hex: %w", err)
	}
	if len(key) != storeKeySize {
		return nil, fmt.Errorf("store: store key must be %d bytes (hex %d chars), got %d bytes", storeKeySize, storeKeySize*2, len(key))
	}
	return key, nil
}

func newStoreKey() ([]byte, error) {
	k := make([]byte, storeKeySize)
	if _, err := rand.Read(k); err != nil {
		return nil, fmt.Errorf("store: generate store key: %w", err)
	}
	return k, nil
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("store: aes: %w", err)
	}
	return cipher.NewGCM(block)
}

// loadStoreKey 按优先级解析密钥；path 在密钥来自环境/参数时为空串。
func loadStoreKey(dataDir string, cfg openConfig) (key []byte, path string, err error) {
	if cfg.storeKeySet {
		k, err := parseStoreKey(cfg.storeKeyHex)
		return k, "", err
	}
	if v := strings.TrimSpace(os.Getenv(envStoreKey)); v != "" {
		k, err := parseStoreKey(v)
		return k, "", err
	}
	if f := strings.TrimSpace(os.Getenv(envStoreKeyFile)); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, f, fmt.Errorf("store: read %s=%s: %w", envStoreKeyFile, f, err)
		}
		k, err := parseStoreKey(string(b))
		return k, f, err
	}

	p := defaultStoreKeyPath(dataDir)
	b, err := os.ReadFile(p)
	switch {
	case err == nil:
		k, err := parseStoreKey(string(b))
		return k, p, err
	case !errors.Is(err, os.ErrNotExist):
		return nil, p, fmt.Errorf("store: read store key %s: %w", p, err)
	}
	k, err := newStoreKey()
	if err != nil {
		return nil, p, err
	}
	if err := os.WriteFile(p, []byte(hex.EncodeToString(k)+"\n"), 0o600); err != nil {
		return nil, p, fmt.Errorf("store: write store key %s: %w", p, err)
	}
	return k, p, nil
}

// StoreKeyHex 返回当前密钥 hex（仅供启动日志与运维核对，不落库）。
func (s *Store) StoreKeyHex() string { return hex.EncodeToString(s.storeKey) }

// StoreKeyPath 返回密钥文件路径；密钥来自参数/环境变量时返回空串。
func (s *Store) StoreKeyPath() string { return s.storeKeyPath }

// StoreKeyStatus 报告当前配置下的密钥状态，**不创建任何文件**（供 CLI 只读查询）。
// path 为密钥来源文件路径；密钥来自参数/环境变量时为空串。hexKey 仅在 exists=true 时非空。
func StoreKeyStatus(dataDir string, opts ...Option) (path, hexKey string, exists bool, err error) {
	cfg := openConfig{}
	for _, opt := range opts {
		if err := opt(&cfg); err != nil {
			return "", "", false, err
		}
	}

	if cfg.storeKeySet {
		k, err := parseStoreKey(cfg.storeKeyHex)
		if err != nil {
			return "", "", false, err
		}
		return "", hex.EncodeToString(k), true, nil
	}
	if v := strings.TrimSpace(os.Getenv(envStoreKey)); v != "" {
		k, err := parseStoreKey(v)
		if err != nil {
			return "", "", false, err
		}
		return "", hex.EncodeToString(k), true, nil
	}
	if f := strings.TrimSpace(os.Getenv(envStoreKeyFile)); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			return f, "", false, fmt.Errorf("store: read %s=%s: %w", envStoreKeyFile, f, err)
		}
		k, err := parseStoreKey(string(b))
		if err != nil {
			return f, "", false, err
		}
		return f, hex.EncodeToString(k), true, nil
	}

	p := defaultStoreKeyPath(dataDir)
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return p, "", false, nil
	}
	if err != nil {
		return p, "", false, fmt.Errorf("store: read store key %s: %w", p, err)
	}
	k, err := parseStoreKey(string(b))
	if err != nil {
		return p, "", false, err
	}
	return p, hex.EncodeToString(k), true, nil
}

// Encrypt 返回 nonce(12) || ciphertext || tag(16)。
func (s *Store) Encrypt(plain []byte) ([]byte, error) {
	nonce := make([]byte, gcmNonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("store: nonce: %w", err)
	}
	// dst 复用 nonce 的底层数组并追加密文，得到 nonce||ct||tag
	return s.aead.Seal(nonce, nonce, plain, nil), nil
}

// Decrypt 接受 nonce(12) || ciphertext || tag(16)。
func (s *Store) Decrypt(b []byte) ([]byte, error) {
	if len(b) < gcmNonceSize+gcmTagSize {
		return nil, fmt.Errorf("store: ciphertext too short (%d bytes)", len(b))
	}
	return s.aead.Open(nil, b[:gcmNonceSize], b[gcmNonceSize:], nil)
}

// encText 加密 TEXT 列；空串保持空串。带前缀便于识别历史明文行。
func (s *Store) encText(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	ct, err := s.Encrypt([]byte(plain))
	if err != nil {
		return "", err
	}
	return encPrefix + base64.StdEncoding.EncodeToString(ct), nil
}

// decText 解密 TEXT 列；无前缀视为历史明文行，原样返回。
func (s *Store) decText(stored string) (string, error) {
	if !strings.HasPrefix(stored, encPrefix) {
		return stored, nil
	}
	raw, err := base64.StdEncoding.DecodeString(stored[len(encPrefix):])
	if err != nil {
		return "", fmt.Errorf("store: bad base64 in encrypted text: %w", err)
	}
	pt, err := s.Decrypt(raw)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}
