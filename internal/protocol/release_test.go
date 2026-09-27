package protocol

import (
	"strings"
	"testing"
)

const releaseSeed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"

func sampleRelease() ReleaseDoc {
	return ReleaseDoc{Payload: ReleasePayload{
		SchemaVersion: 1, Issuer: "base-node-1", IssuedAt: "2026-09-27T00:00:00Z",
		VersionName: "0.2.0", MinVersionName: "0.1.0",
		ApkURL: "http://node.example.com/dl/base-0.2.0.apk", ApkSize: 12345678,
		ApkSHA256: strings.Repeat("ab", 32), Notes: "课程、答题与我的；四 tab 定稿",
	}}
}

func TestReleaseSignAndVerify(t *testing.T) {
	kp, err := KeyPairFromSeed(releaseSeed)
	if err != nil {
		t.Fatalf("KeyPairFromSeed: %v", err)
	}
	doc := sampleRelease()
	if err := doc.SignWith(releaseSeed); err != nil {
		t.Fatalf("SignWith: %v", err)
	}
	ok, err := doc.Verify(kp.PubHex)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !ok {
		t.Fatalf("自签自验失败")
	}
}

// 中文 notes 参与签名：canonicalize 只限制对象键必须 ASCII，值不限（spec §8.1）。
func TestReleaseSignBytesAllowsChineseValues(t *testing.T) {
	doc := sampleRelease()
	b, err := doc.ReleaseSignBytes()
	if err != nil {
		t.Fatalf("ReleaseSignBytes: %v", err)
	}
	s := string(b)
	if !strings.Contains(s, "课程、答题与我的；四 tab 定稿") {
		t.Fatalf("notes 未进签名载荷: %s", s)
	}
	if strings.Contains(s, `"signature"`) {
		t.Fatalf("签名域不应包含 signature: %s", s)
	}
}

func TestReleaseVerifyRejects(t *testing.T) {
	kp, _ := KeyPairFromSeed(releaseSeed)

	// 改版本号后不重签
	tampered := sampleRelease()
	if err := tampered.SignWith(releaseSeed); err != nil {
		t.Fatalf("SignWith: %v", err)
	}
	tampered.Payload.VersionName = "9.9.9"
	if ok, _ := tampered.Verify(kp.PubHex); ok {
		t.Fatalf("改版本号后仍验签通过")
	}

	// 签名被改一位
	broken := sampleRelease()
	if err := broken.SignWith(releaseSeed); err != nil {
		t.Fatalf("SignWith: %v", err)
	}
	broken.Signature = "0" + broken.Signature[1:]
	if ok, _ := broken.Verify(kp.PubHex); ok {
		t.Fatalf("签名被改后仍验签通过")
	}

	// schema_version 不是 1
	wrongSchema := sampleRelease()
	wrongSchema.Payload.SchemaVersion = 2
	if err := wrongSchema.SignWith(releaseSeed); err != nil {
		t.Fatalf("SignWith: %v", err)
	}
	if ok, _ := wrongSchema.Verify(kp.PubHex); ok {
		t.Fatalf("schema_version=2 仍验签通过")
	}
}
