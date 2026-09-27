package protocol

import (
	"encoding/json"
	"fmt"
)

// ReleasePayload 是 release 文档的签名载荷（spec §8.2）。
// 继承 manifest 的签名字节约束：对象键必须 ASCII、数字必须为有限整数；值为中文没问题。
type ReleasePayload struct {
	SchemaVersion  int    `json:"schema_version"`
	Issuer         string `json:"issuer"`
	IssuedAt       string `json:"issued_at"`
	VersionName    string `json:"version_name"`
	MinVersionName string `json:"min_version_name"`
	ApkURL         string `json:"apk_url"`
	ApkSize        int64  `json:"apk_size"`
	ApkSHA256      string `json:"apk_sha256"`
	Notes          string `json:"notes"`
}

// ReleaseDoc 是签名文档本体。payload 与 signature 分离（而不是像 manifest 那样平铺 + 去字段）：
// notes 是自由文本，平铺口径要求签名方与验签方对「哪些字段参与」有一致的隐含约定，容易漂移。
type ReleaseDoc struct {
	Payload   ReleasePayload `json:"payload"`
	Signature string         `json:"signature"`
}

// ReleaseSignBytes 返回签名字节：payload 的规范化 JSON（signature 不在域内）。
func (d ReleaseDoc) ReleaseSignBytes() ([]byte, error) {
	raw, err := json.Marshal(d.Payload)
	if err != nil {
		return nil, fmt.Errorf("release sign bytes: %w", err)
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, fmt.Errorf("release sign bytes: %w", err)
	}
	return Canonicalize(obj)
}

// SignWith 用私钥种子对 ReleaseSignBytes 签名，并写入 Signature。
func (d *ReleaseDoc) SignWith(seedHex string) error {
	b, err := d.ReleaseSignBytes()
	if err != nil {
		return err
	}
	sig, err := Sign(seedHex, b)
	if err != nil {
		return err
	}
	d.Signature = sig
	return nil
}

// Verify 用公钥验签；schema_version 不是 1 直接判为不可用（未来版本不猜语义）。
func (d ReleaseDoc) Verify(pubHex string) (bool, error) {
	if d.Payload.SchemaVersion != 1 {
		return false, nil
	}
	b, err := d.ReleaseSignBytes()
	if err != nil {
		return false, err
	}
	return Verify(pubHex, b, d.Signature)
}

// MarshalCanonical 返回落盘字节：整个文档（payload + signature）的规范化 JSON。
func (d ReleaseDoc) MarshalCanonical() ([]byte, error) {
	raw, err := json.Marshal(d)
	if err != nil {
		return nil, fmt.Errorf("release marshal: %w", err)
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, fmt.Errorf("release marshal: %w", err)
	}
	return Canonicalize(obj)
}
