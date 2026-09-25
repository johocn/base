package protocol

import (
	"crypto/sha256"
	"encoding/hex"
)

// SHA256Sum 返回 32 字节原始摘要。
func SHA256Sum(b []byte) []byte {
	s := sha256.Sum256(b)
	return s[:]
}

// SHA256Hex 返回 64 字符小写十六进制摘要。
func SHA256Hex(b []byte) string {
	return hex.EncodeToString(SHA256Sum(b))
}

// BlobID 返回内容寻址 id：sha256 十六进制的前 32 个字符（128 bit）。
func BlobID(b []byte) string {
	return SHA256Hex(b)[:32]
}

// IsBlobID 校验 id 是否为合法的 32 字符小写十六进制。
func IsBlobID(id string) bool { return isHex32(id) }

// isHex32 判断 s 是否为 32 字符小写十六进制；blob_id 与身份 id 共用同一形状约束。
func isHex32(s string) bool {
	if len(s) != 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') {
			continue
		}
		return false
	}
	return true
}
