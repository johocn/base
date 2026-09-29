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

// ValidSlug 校验 slug 形态（册子 #25 §2.4）：[a-z0-9][a-z0-9-]{0,63}，总长 1..64。
// 这是契约级规则：投稿 item_id 的 slug 段、导入器产出的 category slug 都按它判定，
// 故落在 protocol 而非任一调用方包内，避免两处口径漂移。
func ValidSlug(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		isAlnum := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
		if i == 0 {
			if !isAlnum {
				return false
			}
			continue
		}
		if !isAlnum && c != '-' {
			return false
		}
	}
	return true
}
