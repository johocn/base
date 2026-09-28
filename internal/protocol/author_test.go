package protocol

import "testing"

// 固定输入下的规范化签名字节（键名与顺序即契约，勿改）。
func TestAuthorSignBytesCanonicalForm(t *testing.T) {
	got, err := AuthorSignBytes(
		"article:demo-1",
		"af7d2109429d7850f7ae542da6b0d83403846119fc160ed8060cc3814f676a48",
		"f78672b2f87ff80b248323a4be7c3da6",
	)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"alg":"ed25519","author_id":"f78672b2f87ff80b248323a4be7c3da6","content_hash":"af7d2109429d7850f7ae542da6b0d83403846119fc160ed8060cc3814f676a48","domain":"base/author-v1","item_id":"article:demo-1"}`
	if string(got) != want {
		t.Fatalf("签名字节不一致:\n got %s\nwant %s", got, want)
	}
}

func TestAuthorSigRoundTrip(t *testing.T) {
	const seed = "6f1e0d9c8b7a6958473625142332415061728394a5b6c7d8e9f0a1b2c3d4e5f6"
	kp, err := KeyPairFromSeed(seed)
	if err != nil {
		t.Fatal(err)
	}
	id, err := IdentityID(kp.PubHex)
	if err != nil {
		t.Fatal(err)
	}
	const contentHash = "af7d2109429d7850f7ae542da6b0d83403846119fc160ed8060cc3814f676a48"
	b, err := AuthorSignBytes("article:demo-1", contentHash, id)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := Sign(seed, b)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := VerifyAuthorSig(kp.PubHex, "article:demo-1", contentHash, id, sig)
	if err != nil || !ok {
		t.Fatalf("本人签名应通过: ok=%v err=%v", ok, err)
	}
	// 内容改了（content_hash 变）→ 归属失效（册子 §8 风险 7）
	ok, err = VerifyAuthorSig(kp.PubHex, "article:demo-1", "00"+contentHash[2:], id, sig)
	if err != nil || ok {
		t.Fatalf("改内容后不应通过: ok=%v err=%v", ok, err)
	}
	// 换公钥 → 不通过
	other, err := KeyPairFromSeed("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
	if err != nil {
		t.Fatal(err)
	}
	ok, err = VerifyAuthorSig(other.PubHex, "article:demo-1", contentHash, id, sig)
	if err != nil || ok {
		t.Fatalf("换公钥不应通过: ok=%v err=%v", ok, err)
	}
}
