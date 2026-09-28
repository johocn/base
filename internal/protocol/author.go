package protocol

// AuthorSigDomain 是作者归属签名的域分隔串，避免与其他签名场景交叉复用（治理册 §2.1）。
const AuthorSigDomain = "base/author-v1"

// AuthorSigInput 是 author_sig 的签名字节结构（键名即契约，勿改）。
type AuthorSigInput struct {
	Alg         string `json:"alg"`
	Domain      string `json:"domain"`
	ItemID      string `json:"item_id"`
	ContentHash string `json:"content_hash"`
	AuthorID    string `json:"author_id"`
}

// AuthorSignBytes 返回 author_sig 的规范化签名字节。
// 编码走既有 Canonicalize，不新增编码规则（册子 §2.1）。
func AuthorSignBytes(itemID, contentHash, authorID string) ([]byte, error) {
	return Canonicalize(AuthorSigInput{
		Alg: AlgEd25519, Domain: AuthorSigDomain,
		ItemID: itemID, ContentHash: contentHash, AuthorID: authorID,
	})
}

// VerifyAuthorSig 用作者公钥验证条目归属；签名不合法即返回 (false, nil)。
func VerifyAuthorSig(pubHex, itemID, contentHash, authorID, sigHex string) (bool, error) {
	b, err := AuthorSignBytes(itemID, contentHash, authorID)
	if err != nil {
		return false, err
	}
	return Verify(pubHex, b, sigHex)
}
