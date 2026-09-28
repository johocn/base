/**
 * 服务端错误码 → 中文提示（本册 §9.2）。界面不直接显示英文码。
 *
 * 只读响应体的 `code`：本节点的 `writeAuthErr` 把 `error` 写成英文文案（不是码），
 * `writeError` 则只有 `error` 没有 `code`——两者都留给调用方的兜底文案处理。
 */

/** 逐条对齐册子 §9.2 的映射表。 */
const SERVER_ERROR_TEXT: Record<string, string> = {
  item_title_invalid: '标题需 1–200 字且不含控制字符',
  item_body_too_large: '正文超过 32KB',
  item_question_invalid: '题组内容不合法（需合法 JSON、schema_version 为 1、questions 非空）',
  item_id_invalid: '条目 id 不合法',
  item_type_unsupported: '载体只能是文章或题库',
  item_type_mismatch: '载体与 id 前缀不一致',
  item_id_taken: '该条目已被他人创建',
  author_id_forbidden: '请求体不得携带身份字段',
  author_sig_invalid: '作者归属签名验证失败',
  identity_unregistered: '身份未在本节点登记，请稍后重试',
  item_rate_limited: '操作过于频繁，请稍后再试',
  event_rate_limited: '操作过于频繁，请稍后再试',
  govern_rate_limited: '操作过于频繁，请稍后再试',
  profile_name_invalid: '昵称需 1–32 字且不含控制字符',
  profile_id_forbidden: '请求体不得携带身份字段',
  proposal_action_unsupported: '只能选择下架 / 改写 / 复活三个动作',
  proposal_reason_invalid: '理由需 1–200 字且不含控制字符',
  proposal_edit_invalid: '改写提案需填标题与正文，且只支持文章',
  proposal_too_large: '标题与正文合计超过 32KB',
  item_not_found: '目标条目不存在',
  item_self_owned: '这是你自己的条目，请直接改用投稿',
  item_state_mismatch: '条目的当前状态不支持该动作',
  proposer_not_governor: '不在本节点治理者名册内',
  voter_not_governor: '不在本节点治理者名册内',
  proposal_not_found: '提案不存在',
  already_voted: '你已投过票',
};

/** 从响应体里取错误码；取不到返回空串。 */
export function errorCodeOf(raw: string): string {
  try {
    const body = JSON.parse(raw) as { code?: string };
    return body.code ?? '';
  } catch {
    return '';
  }
}

/**
 * 码 → 中文提示。`auth_*` / `identity_*`（除已单列的 `identity_unregistered`）属
 * 客户端实现异常，统一一条提示（册子 §9.2 末行）；其余未知码用调用方给的兜底文案。
 */
export function errorText(code: string, fallback: string): string {
  const hit = SERVER_ERROR_TEXT[code];
  if (hit) return hit;
  if (code.startsWith('auth_') || code.startsWith('identity_')) return '签名校验失败，请重试';
  return fallback;
}