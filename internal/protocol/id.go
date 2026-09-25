package protocol

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"strings"
)

// AlgEd25519 是身份签名算法标识；一期只允许该值，其余一律拒绝。
const AlgEd25519 = "ed25519"

// IdentityID 由公钥派生身份 id：sha256(公钥原始 32 字节) 的前 32 个十六进制字符。
//
// 这是不可变契约：节点不分配 id——任何人拿公钥都能算出同一个 id，
// 节点的"登记"只是"记录下来并可被邻居核对"，不是发号。
// 改本函数的算法或其输入，会同时破坏登记幂等、验签与跨节点一致性。
func IdentityID(pubHex string) (string, error) {
	pub, err := hex.DecodeString(strings.ToLower(strings.TrimSpace(pubHex)))
	if err != nil {
		return "", fmt.Errorf("identity id: 公钥不是合法 hex: %w", err)
	}
	if len(pub) != ed25519.PublicKeySize {
		return "", fmt.Errorf("identity id: 期望 %d 字节公钥，实得 %d", ed25519.PublicKeySize, len(pub))
	}
	return SHA256Hex(pub)[:32], nil
}

// IsIdentityID 校验身份 id 是否为 32 字符小写十六进制。
func IsIdentityID(id string) bool { return isHex32(id) }
