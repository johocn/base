package protocol

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 第二个密钥用于证明"不同公钥必得不同 id"，与 Rfc8032 测试密钥无关。
const idTestSeedB = "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7"

func TestIdentityIDDerivation(t *testing.T) {
	kpA, err := KeyPairFromSeed(testSeed)
	if err != nil {
		t.Fatal(err)
	}
	kpB, err := KeyPairFromSeed(idTestSeedB)
	if err != nil {
		t.Fatal(err)
	}
	idA, err := IdentityID(kpA.PubHex)
	if err != nil {
		t.Fatalf("IdentityID: %v", err)
	}
	if len(idA) != 32 {
		t.Fatalf("len(id) = %d, want 32", len(idA))
	}
	if !IsIdentityID(idA) {
		t.Fatalf("IsIdentityID(%q) = false", idA)
	}
	// 独立复算，不复用实现内部逻辑
	raw, err := hex.DecodeString(kpA.PubHex)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	if want := hex.EncodeToString(sum[:])[:32]; idA != want {
		t.Fatalf("IdentityID = %s, 独立复算 = %s", idA, want)
	}
	// 确定性
	if again, _ := IdentityID(kpA.PubHex); again != idA {
		t.Fatalf("同一公钥两次派生不一致: %s vs %s", idA, again)
	}
	// 大写十六进制归一到同一 id
	if up, err := IdentityID(strings.ToUpper(kpA.PubHex)); err != nil || up != idA {
		t.Fatalf("大写公钥应归一到同一 id: %s vs %s err=%v", up, idA, err)
	}
	// 不同公钥 → 不同 id
	idB, err := IdentityID(kpB.PubHex)
	if err != nil {
		t.Fatal(err)
	}
	if idA == idB {
		t.Fatalf("不同公钥派生出相同 id: %s", idA)
	}
	// 非法输入必须报错而不是静默产出 id
	if _, err := IdentityID("zz"); err == nil {
		t.Fatal("非 hex 公钥应报错")
	}
	if _, err := IdentityID("9d61b19d"); err == nil {
		t.Fatal("长度不足的公钥应报错")
	}
	if _, err := IdentityID(""); err == nil {
		t.Fatal("空公钥应报错")
	}
	// id 形状校验
	if IsIdentityID("ABCDEF") || IsIdentityID(idA+"0") || IsIdentityID("A"+idA[1:]) || IsIdentityID("") {
		t.Fatal("IsIdentityID 应拒绝非 32 字符小写 hex")
	}
}

func TestIdentityIDVectors(t *testing.T) {
	type vecCase struct {
		Name    string `json:"name"`
		SeedHex string `json:"seed_hex"`
		PubHex  string `json:"pub_hex"`
		Alg     string `json:"alg"`
		ID      string `json:"id"`
	}
	var f struct {
		Version int       `json:"version"`
		Cases   []vecCase `json:"cases"`
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "identity.json"))
	if err != nil {
		t.Fatalf("读向量失败: %v", err)
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("解析向量失败: %v", err)
	}
	if f.Version != 1 {
		t.Fatalf("向量 version = %d, want 1", f.Version)
	}
	if len(f.Cases) < 2 {
		t.Fatalf("向量用例数 = %d, want >= 2", len(f.Cases))
	}
	for _, c := range f.Cases {
		kp, err := KeyPairFromSeed(c.SeedHex)
		if err != nil {
			t.Fatalf("%s: KeyPairFromSeed: %v", c.Name, err)
		}
		if kp.PubHex != c.PubHex {
			t.Fatalf("%s: 公钥不符 %s != %s", c.Name, kp.PubHex, c.PubHex)
		}
		if c.Alg != AlgEd25519 {
			t.Fatalf("%s: alg = %q, want %q", c.Name, c.Alg, AlgEd25519)
		}
		got, err := IdentityID(c.PubHex)
		if err != nil {
			t.Fatalf("%s: IdentityID: %v", c.Name, err)
		}
		if got != c.ID {
			t.Fatalf("%s: id 漂移 %s != %s（改了派生算法就必须同步全部消费方）", c.Name, got, c.ID)
		}
	}
}
