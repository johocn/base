/**
 * plus.sqlite 没有参数绑定，只能把值拼进 SQL。
 * 这里做唯一一处转义：字符串单引号加倍、数字校验有限性。
 * 注意：本项目的 SQL 里不会出现字符串字面量中的 '?'，故顺序替换是安全的。
 */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`sqlLiteral: 非有限数 ${v}`);
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function sqlWithParams(sql: string, params: readonly unknown[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => (i < params.length ? sqlLiteral(params[i++]) : '?'));
}