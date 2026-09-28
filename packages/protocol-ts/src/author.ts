import { canonicalize, type Json } from "./canonical";
import { verify } from "./ed25519";
import { utf8 } from "./hash";
import { ALG_ED25519 } from "./identity";

/** 作者归属签名的域分隔串（与 Go 侧 protocol.AuthorSigDomain 逐字节一致）。 */
export const AUTHOR_SIG_DOMAIN = "base/author-v1";

export interface AuthorSigInput {
  alg: string;
  domain: string;
  item_id: string;
  content_hash: string;
  author_id: string;
}

/** 返回 author_sig 的规范化签名字节（治理册 §2.1）。 */
export function authorSignBytes(itemId: string, contentHash: string, authorId: string): string {
  const input: AuthorSigInput = {
    alg: ALG_ED25519,
    domain: AUTHOR_SIG_DOMAIN,
    item_id: itemId,
    content_hash: contentHash,
    author_id: authorId,
  };
  return canonicalize(input as unknown as Json);
}

/** 用作者公钥验证条目归属；任一步不成立即 false。 */
export function verifyAuthorSig(
  pubHex: string,
  itemId: string,
  contentHash: string,
  authorId: string,
  sigHex: string,
): boolean {
  return verify(pubHex, utf8(authorSignBytes(itemId, contentHash, authorId)), sigHex);
}
