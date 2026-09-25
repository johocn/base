package store

import (
	"database/sql"
	"errors"
	"fmt"
)

// Identity 是一条已登记的身份公钥。节点只存公钥，永不接触明文私钥。
type Identity struct {
	ID         string
	Alg        string
	PubKey     string
	CreatedAt  int64
	LastSeenAt int64
}

// EscrowRecord 是一条密码托管记录。节点只存不解释：不派生密钥、不解密、不校验密码。
type EscrowRecord struct {
	Username   string
	ID         string
	Alg        string
	Salt       string // 客户端生成，随密文上传，节点原样存原样返
	KDFJSON    string // 客户端决定的 KDF 参数，换设备必须能原样取回
	EncNonce   string // 独立列，不与 priv_cipher 混为一体
	PrivCipher string // ciphertext || tag，节点无从解读
	UpdatedAt  int64
}

// ErrIdentityPubKeyMismatch 表示同一 id 提交了不同公钥或不同算法。
var ErrIdentityPubKeyMismatch = errors.New("store: identity pubkey mismatch")

// ErrEscrowConflict 表示该用户名已绑定到另一个 id。
var ErrEscrowConflict = errors.New("store: escrow username bound to another identity")

// RegisterIdentity 幂等登记公钥。registered=false 表示此前已登记同 id 同公钥。
// 同 id 换公钥或换算法一律返回 ErrIdentityPubKeyMismatch，不静默改写。
func (s *Store) RegisterIdentity(id, alg, pubKey string, now int64) (bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()

	var existPub, existAlg string
	err = tx.QueryRow(`SELECT pubkey, alg FROM identities WHERE id=?`, id).Scan(&existPub, &existAlg)
	switch {
	case err == nil:
		if existPub != pubKey || existAlg != alg {
			return false, ErrIdentityPubKeyMismatch
		}
		if _, err := tx.Exec(`UPDATE identities SET last_seen_at=? WHERE id=?`, now, id); err != nil {
			return false, err
		}
		return false, tx.Commit()
	case !errors.Is(err, sql.ErrNoRows):
		return false, err
	}
	if _, err := tx.Exec(`INSERT INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
		id, alg, pubKey, now, now); err != nil {
		return false, fmt.Errorf("store: register identity: %w", err)
	}
	return true, tx.Commit()
}

// LookupIdentity 读取已登记的身份。
func (s *Store) LookupIdentity(id string) (Identity, bool, error) {
	var it Identity
	err := s.db.QueryRow(`SELECT id,alg,pubkey,created_at,last_seen_at FROM identities WHERE id=?`, id).
		Scan(&it.ID, &it.Alg, &it.PubKey, &it.CreatedAt, &it.LastSeenAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Identity{}, false, nil
	}
	if err != nil {
		return Identity{}, false, err
	}
	return it, true, nil
}

// TouchIdentity 更新 last_seen_at。
func (s *Store) TouchIdentity(id string, now int64) error {
	_, err := s.db.Exec(`UPDATE identities SET last_seen_at=? WHERE id=?`, now, id)
	return err
}

// UseNonce 原子登记 (id, nonce)；used=true 表示该 nonce 已被用过（重放）。
//
// 去重键必须含 id：否则任一身份可以抢先占用他人的 nonce，
// 使合法请求被误判为重放而遭拒绝。
func (s *Store) UseNonce(id, nonce string, now int64) (bool, error) {
	res, err := s.db.Exec(
		`INSERT INTO auth_nonces(id,nonce,seen_at) VALUES(?,?,?) ON CONFLICT(id,nonce) DO NOTHING`,
		id, nonce, now)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n == 0, nil
}

// PruneNonces 删除 seen_at 早于 before 的行，返回删除条数。
func (s *Store) PruneNonces(before int64) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM auth_nonces WHERE seen_at < ?`, before)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// PutEscrow 写入或覆盖密码托管记录。同 username 只允许同一 id 覆盖。
func (s *Store) PutEscrow(e EscrowRecord) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var owner string
	err = tx.QueryRow(`SELECT id FROM escrow WHERE username=?`, e.Username).Scan(&owner)
	switch {
	case err == nil && owner != e.ID:
		return ErrEscrowConflict
	case err != nil && !errors.Is(err, sql.ErrNoRows):
		return err
	}
	if _, err := tx.Exec(`INSERT INTO escrow(username,id,alg,salt,kdf_json,enc_nonce,priv_cipher,updated_at)
		VALUES(?,?,?,?,?,?,?,?)
		ON CONFLICT(username) DO UPDATE SET
			id=excluded.id, alg=excluded.alg, salt=excluded.salt, kdf_json=excluded.kdf_json,
			enc_nonce=excluded.enc_nonce, priv_cipher=excluded.priv_cipher, updated_at=excluded.updated_at`,
		e.Username, e.ID, e.Alg, e.Salt, e.KDFJSON, e.EncNonce, e.PrivCipher, e.UpdatedAt); err != nil {
		return fmt.Errorf("store: put escrow: %w", err)
	}
	return tx.Commit()
}

// GetEscrow 读取密码托管记录。
func (s *Store) GetEscrow(username string) (EscrowRecord, bool, error) {
	var e EscrowRecord
	err := s.db.QueryRow(`SELECT username,id,alg,salt,kdf_json,enc_nonce,priv_cipher,updated_at
		FROM escrow WHERE username=?`, username).
		Scan(&e.Username, &e.ID, &e.Alg, &e.Salt, &e.KDFJSON, &e.EncNonce, &e.PrivCipher, &e.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return EscrowRecord{}, false, nil
	}
	if err != nil {
		return EscrowRecord{}, false, err
	}
	return e, true, nil
}
