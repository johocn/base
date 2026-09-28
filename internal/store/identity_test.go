package store

import (
	"errors"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestRegisterIdentityIdempotent(t *testing.T) {
	st := openTemp(t)
	const id = "00112233445566778899aabbccddeeff"
	const pubA = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"

	created, err := st.RegisterIdentity(id, "ed25519", pubA, 1000)
	if err != nil || !created {
		t.Fatalf("首次登记 created=%v err=%v, want true/nil", created, err)
	}
	// 幂等：同 id 同公钥重放不报错、created=false，且刷新 last_seen_at
	created2, err := st.RegisterIdentity(id, "ed25519", pubA, 2000)
	if err != nil || created2 {
		t.Fatalf("重复登记 created=%v err=%v, want false/nil", created2, err)
	}
	got, ok, err := st.LookupIdentity(id)
	if err != nil || !ok {
		t.Fatalf("LookupIdentity ok=%v err=%v", ok, err)
	}
	if got.PubKey != pubA || got.Alg != "ed25519" || got.CreatedAt != 1000 || got.LastSeenAt != 2000 {
		t.Fatalf("identity 字段不符: %+v", got)
	}
	// 同 id 换公钥必须硬失败，不允许悄悄改写已有登记
	const pubB = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"
	if _, err := st.RegisterIdentity(id, "ed25519", pubB, 3000); !errors.Is(err, ErrIdentityPubKeyMismatch) {
		t.Fatalf("换公钥 err=%v, want ErrIdentityPubKeyMismatch", err)
	}
	// 换算法同样硬失败
	if _, err := st.RegisterIdentity(id, "secp256k1", pubA, 3000); !errors.Is(err, ErrIdentityPubKeyMismatch) {
		t.Fatalf("换算法 err=%v, want ErrIdentityPubKeyMismatch", err)
	}
	// 未登记 id
	if _, ok, err := st.LookupIdentity("ffffffffffffffffffffffffffffffff"); err != nil || ok {
		t.Fatalf("未登记 id ok=%v err=%v, want false/nil", ok, err)
	}
}

func TestEscrowConflictAndOverwrite(t *testing.T) {
	st := openTemp(t)
	base := EscrowRecord{
		Username: "alice", ID: "id-1", Alg: "ed25519",
		Salt: "00112233445566778899aabbccddeeff", KDFJSON: `{"alg":"argon2id","m":65536,"t":3,"p":1,"len":32}`,
		EncNonce: "ffeeddccbbaa998877665544", PrivCipher: "deadbeef", UpdatedAt: 1000,
	}
	if err := st.PutEscrow(base); err != nil {
		t.Fatalf("PutEscrow: %v", err)
	}
	// 同 username 同 id → 允许覆盖（改密码场景）
	base.PrivCipher = "cafebabe"
	base.UpdatedAt = 2000
	if err := st.PutEscrow(base); err != nil {
		t.Fatalf("同 id 覆盖失败: %v", err)
	}
	got, ok, err := st.GetEscrow("alice")
	if err != nil || !ok || got.PrivCipher != "cafebabe" || got.UpdatedAt != 2000 {
		t.Fatalf("覆盖后记录不符: ok=%v err=%v got=%+v", ok, err, got)
	}
	// 同 username 换 id → 冲突
	other := base
	other.ID = "id-2"
	if err := st.PutEscrow(other); !errors.Is(err, ErrEscrowConflict) {
		t.Fatalf("换 id err=%v, want ErrEscrowConflict", err)
	}
	// 冲突时原记录不得被改动
	after, _, _ := st.GetEscrow("alice")
	if after.ID != "id-1" || after.PrivCipher != "cafebabe" {
		t.Fatalf("冲突后原记录被改坏: %+v", after)
	}
	// 未登记用户名
	if _, ok, err := st.GetEscrow("nobody"); err != nil || ok {
		t.Fatalf("未登记 username ok=%v err=%v, want false/nil", ok, err)
	}
}

func TestUseNonceIsScopedByIdAndPrunable(t *testing.T) {
	st := openTemp(t)
	const nonce = "00112233445566778899aabbccddeeff"
	used, err := st.UseNonce("id-1", nonce, 1000)
	if err != nil || used {
		t.Fatalf("首次使用 used=%v err=%v, want false/nil", used, err)
	}
	// 同 id 同 nonce 第二次 → 重放
	used2, err := st.UseNonce("id-1", nonce, 1001)
	if err != nil || !used2 {
		t.Fatalf("重放 used=%v err=%v, want true/nil", used2, err)
	}
	// 不同 id 用同一 nonce 互不影响：否则任一身份可抢先占用他人 nonce
	used3, err := st.UseNonce("id-2", nonce, 1002)
	if err != nil || used3 {
		t.Fatalf("另一 id 使用同 nonce used=%v err=%v, want false/nil", used3, err)
	}
	// 清理
	n, err := st.PruneNonces(1001)
	if err != nil || n != 1 {
		t.Fatalf("PruneNonces = %d err=%v, want 1/nil", n, err)
	}
	// 清理后原 nonce 可再用（窗口已过）
	used4, err := st.UseNonce("id-1", nonce, 2000)
	if err != nil || used4 {
		t.Fatalf("清理后重用 used=%v err=%v, want false/nil", used4, err)
	}
}

func TestLookupIdentities(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	kp, err := protocol.KeyPairFromSeed("6f1e0d9c8b7a6958473625142332415061728394a5b6c7d8e9f0a1b2c3d4e5f6")
	if err != nil {
		t.Fatal(err)
	}
	id, err := protocol.IdentityID(kp.PubHex)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.RegisterIdentity(id, protocol.AlgEd25519, kp.PubHex, 1); err != nil {
		t.Fatal(err)
	}
	got, err := st.LookupIdentities([]string{id, "00000000000000000000000000000000"})
	if err != nil {
		t.Fatal(err)
	}
	if got[id] != kp.PubHex {
		t.Fatalf("公钥反查失败: %v", got)
	}
	if _, ok := got["00000000000000000000000000000000"]; ok {
		t.Fatal("未登记的身份不应出现在结果里")
	}
	// ids 为空 = 全部
	all, err := st.LookupIdentities(nil)
	if err != nil {
		t.Fatal(err)
	}
	if all[id] != kp.PubHex {
		t.Fatalf("空 ids 应返回全部: %v", all)
	}
}
