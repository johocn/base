package protocol

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
)

// KeyPair 是种子派生的密钥对（均为小写 hex）。
type KeyPair struct {
	SeedHex string
	PubHex  string
}

// KeyPairFromSeed 由 32 字节种子（hex64）派生 Ed25519 密钥对。
func KeyPairFromSeed(seedHex string) (KeyPair, error) {
	seed, err := hex.DecodeString(strings.ToLower(strings.TrimSpace(seedHex)))
	if err != nil {
		return KeyPair{}, fmt.Errorf("sign key: %w", err)
	}
	if len(seed) != ed25519.SeedSize {
		return KeyPair{}, fmt.Errorf("sign key: want %d bytes seed, got %d", ed25519.SeedSize, len(seed))
	}
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)
	return KeyPair{SeedHex: strings.ToLower(seedHex), PubHex: hex.EncodeToString(pub)}, nil
}

// Sign 返回 64 字节签名的 hex128。
func Sign(seedHex string, msg []byte) (string, error) {
	seed, err := hex.DecodeString(strings.ToLower(strings.TrimSpace(seedHex)))
	if err != nil {
		return "", fmt.Errorf("sign: %w", err)
	}
	if len(seed) != ed25519.SeedSize {
		return "", fmt.Errorf("sign: want %d bytes seed, got %d", ed25519.SeedSize, len(seed))
	}
	return hex.EncodeToString(ed25519.Sign(ed25519.NewKeyFromSeed(seed), msg)), nil
}

// Verify 校验签名；sigHex 非法长度返回 (false, nil)。
func Verify(pubHex string, msg []byte, sigHex string) (bool, error) {
	pub, err := hex.DecodeString(strings.ToLower(strings.TrimSpace(pubHex)))
	if err != nil {
		return false, fmt.Errorf("verify: %w", err)
	}
	if len(pub) != ed25519.PublicKeySize {
		return false, fmt.Errorf("verify: want %d bytes pubkey, got %d", ed25519.PublicKeySize, len(pub))
	}
	sig, err := hex.DecodeString(strings.ToLower(strings.TrimSpace(sigHex)))
	if err != nil {
		return false, nil
	}
	if len(sig) != ed25519.SignatureSize {
		return false, nil
	}
	return ed25519.Verify(pub, msg, sig), nil
}

// DerivePackID 按契约第 5 条派生 pack_id。
func DerivePackID(issuer string, contentVersion int64, merkleRoot string) string {
	seed := "pack:" + issuer + ":" + strconv.FormatInt(contentVersion, 10) + ":" + merkleRoot
	return SHA256Hex([]byte(seed))[:32]
}