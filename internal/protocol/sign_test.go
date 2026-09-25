package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type ed25519Vector struct {
	Version int `json:"version"`
	Cases   []struct {
		Name         string `json:"name"`
		SeedHex      string `json:"seed_hex"`
		PubHex       string `json:"pub_hex"`
		MessageUTF8  string `json:"message_utf8"`
		SignatureHex string `json:"signature_hex"`
	} `json:"cases"`
}

func loadEd25519Vectors(t *testing.T) ed25519Vector {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "ed25519.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var f ed25519Vector
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("vectors empty")
	}
	return f
}

func TestEd25519Vectors(t *testing.T) {
	for _, c := range loadEd25519Vectors(t).Cases {
		t.Run(c.Name, func(t *testing.T) {
			kp, err := KeyPairFromSeed(c.SeedHex)
			if err != nil {
				t.Fatalf("KeyPairFromSeed: %v", err)
			}
			if kp.PubHex != c.PubHex {
				t.Fatalf("PubHex = %s, want %s", kp.PubHex, c.PubHex)
			}
			sig, err := Sign(c.SeedHex, []byte(c.MessageUTF8))
			if err != nil {
				t.Fatalf("Sign: %v", err)
			}
			if sig != c.SignatureHex {
				t.Fatalf("Sign = %s, want %s", sig, c.SignatureHex)
			}
			ok, err := Verify(c.PubHex, []byte(c.MessageUTF8), sig)
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if !ok {
				t.Fatal("Verify = false, want true")
			}
		})
	}
}

func TestVerifyRejectsTampered(t *testing.T) {
	c := loadEd25519Vectors(t).Cases[0]
	sig, _ := Sign(c.SeedHex, []byte(c.MessageUTF8))
	t.Run("消息被改", func(t *testing.T) {
		ok, _ := Verify(c.PubHex, []byte("x"), sig)
		if ok {
			t.Fatal("篡改消息后仍验签通过")
		}
	})
	t.Run("签名被改", func(t *testing.T) {
		bad := "0" + sig[1:]
		ok, _ := Verify(c.PubHex, []byte(c.MessageUTF8), bad)
		if ok {
			t.Fatal("篡改签名后仍验签通过")
		}
	})
	t.Run("换公钥", func(t *testing.T) {
		other, err := KeyPairFromSeed("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7")
		if err != nil {
			t.Fatal(err)
		}
		ok, _ := Verify(other.PubHex, []byte(c.MessageUTF8), sig)
		if ok {
			t.Fatal("换公钥后仍验签通过")
		}
	})
}

func TestDerivePackID(t *testing.T) {
	got := DerivePackID("base-node-1", 7, "aaaa")
	if !IsBlobID(got) {
		t.Fatalf("DerivePackID = %q, want 32 位小写 hex", got)
	}
	if again := DerivePackID("base-node-1", 7, "aaaa"); again != got {
		t.Fatalf("DerivePackID 不稳定: %s != %s", again, got)
	}
	if other := DerivePackID("base-node-1", 8, "aaaa"); other == got {
		t.Fatal("content_version 不同却得到同一 pack_id")
	}
}