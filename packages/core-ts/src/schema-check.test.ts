/**
 * 本地库 SQL ↔ DDL 一致性守卫。
 *
 * 覆盖范围：跑在移动端本地库（SCHEMA_SQL）上的 SQL —— repo.ts + search.ts。
 * 故意排除：store/queries.ts（节点侧 source_rev/sqlite_table/dist_class）、
 *           sync.ts 的 readPack*（pack 文件 schema 而非本地库）、
 *           含 `${...}` 的动态列（repo.ts:617 的 `${cols}`）。
 *
 * 此前 SEARCH_SQL 写了节点侧列名 `source_rev`，而本地库只有 `rev`；
 * 查询必抛 no such column 且被页面 catch 吞掉 → 搜索页恒「没搜到」。
 * 本测试让这类列名漂移在 CI 上直接红。
 */
import { describe, expect, it } from 'vitest';

import { SCHEMA_SQL } from './repo';
import { SEARCH_SQL } from './search';

/** 从 `CREATE TABLE IF NOT EXISTS <name>(...)` 里抽表名。 */
function extractTableName(ddl: string): string | null {
  const m = ddl.match(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/i);
  return m ? m[1]! : null;
}

/** 抽列名列表：括号里、逗号分隔，列首可选 type 或 `PRIMARY KEY(col)`。 */
function extractColumns(ddl: string): Set<string> {
  const paren = ddl.indexOf('(');
  const end = ddl.lastIndexOf(')');
  if (paren < 0 || end < 0 || end <= paren) return new Set();
  const body = ddl.slice(paren + 1, end);
  const cols = new Set<string>();
  for (const line of body.split(',')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 跳过表级约束（PRIMARY KEY(a,b) / FOREIGN KEY / CHECK / UNIQUE）
    const upper = trimmed.toUpperCase();
    if (upper.startsWith('PRIMARY') || upper.startsWith('FOREIGN') || upper.startsWith('CHECK') || upper.startsWith('UNIQUE')) {
      // 仍可取出括号里的列名（表级 PK/UNIQUE）
      const m = trimmed.match(/\(([^)]+)\)/);
      if (m) {
        for (const c of m[1]!.split(',').map((s) => s.trim())) cols.add(c);
      }
      continue;
    }
    // 行级：第一 token 就是列名
    const first = trimmed.split(/\s+/)[0]!;
    cols.add(first);
  }
  return cols;
}

const TABLES: Map<string, Set<string>> = (() => {
  const m = new Map<string, Set<string>>();
  for (const ddl of SCHEMA_SQL) {
    const name = extractTableName(ddl);
    if (name) m.set(name, extractColumns(ddl));
  }
  return m;
})();

// ---------- 从 SQL 字符串里抽表名与列名 ----------

/** 抽 FROM/JOIN 里出现的表名（带可选别名，只用第一个 token）。 */
interface SqlTables {
  /** 真实表名列表（含 UPDATE/DELETE/INSERT INTO） */
  tables: string[];
  /** 别名 → 真实表名（例如 `FROM user_state u INNER JOIN items i` → {u: user_state, i: items}） */
  aliases: Record<string, string>;
}
function extractSqlTables(sql: string): SqlTables {
  const tables: string[] = [];
  const aliases: Record<string, string> = {};
  // FROM table [alias] / JOIN table [alias] —— 后者紧跟一个裸标识符即别名
  const re = /\b(?:FROM|JOIN)\s+(\w+)(?:\s+(\w+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const t = m[1]!;
    tables.push(t);
    if (m[2]) aliases[m[2]!] = t;
  }
  const um = sql.match(/\bUPDATE\s+(\w+)/i);
  if (um) tables.push(um[1]!);
  const im = sql.match(/\bINSERT\s+INTO\s+(\w+)/i);
  if (im) tables.push(im[1]!);
  const dm = sql.match(/\bDELETE\s+FROM\s+(\w+)/i);
  if (dm) tables.push(dm[1]!);
  return { tables: [...new Set(tables)], aliases };
}

/**
 * 从 SELECT 列表片段里抽裸列名（支持聚合 / 限定 / 别名）。
 * 例：`COALESCE(SUM(correct),0) AS c` → ['correct']
 *     `u.item_id AS item_id` → ['item_id']
 *     `COUNT(*)` → []
 *     `t.d` → ['d']
 */
function extractSelectColumns(sql: string): string[] {
  const m = sql.match(/SELECT\s+([\s\S]+?)\s+FROM\b/i);
  if (!m) return [];
  const raw = m[1]!.trim();
  if (raw === '*') return [];
  const cols: string[] = [];
  for (const piece of splitTopLevelCommas(raw)) {
    const col = extractColumnIdentifiers(piece);
    for (const c of col) cols.push(c);
  }
  return cols;
}

/**
 * 从一个 SELECT 片段里递归抽出列名：
 * - 去掉最右的 `AS alias`
 * - 去掉 `table.` 限定（取右半）
 * - 跳过函数名（标识符后紧跟 `(` 的不算列）
 * - 跳过 `*` / 数字 / `?` / 字符串字面量
 */
function extractColumnIdentifiers(piece: string): string[] {
  let p = piece.replace(/\s+AS\s+\w+$/i, '').trim();
  // 把所有字符串字面量、数字、?、* 清掉，免得被当标识符
  p = p.replace(/'[^']*'/g, '');
  p = p.replace(/\*/g, '');
  p = p.replace(/\?/g, '');
  p = p.replace(/\b\d+(?:\.\d+)?\b/g, '');
  // 抽所有标识符 + 是否紧接 `(`（是则为函数名）
  const out: string[] = [];
  const identRe = /([A-Za-z_]\w*)(\s*\()?/g;
  let m: RegExpExecArray | null;
  while ((m = identRe.exec(p))) {
    const name = m[1]!;
    const isFunc = m[2] !== undefined;
    if (isFunc) continue; // COUNT( / SUM( / MAX( ... 这些是函数，不是列
    const qm = name.match(/\.(\w+)$/);
    if (qm) out.push(qm[1]!);
    else out.push(name);
  }
  return out;
}

/** `INSERT INTO t(a,b,c)` → ['a','b','c']；支持 ON CONFLICT 的额外列。 */
function extractInsertColumns(sql: string): string[] {
  const cols: string[] = [];
  const re = /\bINSERT\s+INTO\s+\w+\s*\(([^)]+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    for (const c of splitTopLevelCommas(m[1]!.trim())) cols.push(c.trim());
  }
  // ON CONFLICT(col)
  const cm = sql.match(/\bON\s+CONFLICT\s*\(([^)]+)\)/i);
  if (cm) {
    for (const c of splitTopLevelCommas(cm[1]!.trim())) cols.push(c.trim());
  }
  return cols;
}

/** `UPDATE t SET a=?, b=? WHERE ...` → ['a','b']；以及 ON CONFLICT ... DO UPDATE SET。 */
function extractSetColumns(sql: string): string[] {
  const cols: string[] = [];
  // 第一个 SET（常规 UPDATE）
  const re = /\bSET\s+([\s\S]*?)(?:\bWHERE\b|\bON\s+CONFLICT\b|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    for (const ass of splitTopLevelCommas(m[1]!.trim())) {
      const eq = ass.indexOf('=');
      if (eq > 0) {
        const lhs = ass.slice(0, eq).trim();
        const first = lhs.split(/\s+/)[0]!; // `col =` 或 `col = excluded.col`
        cols.push(first);
      }
    }
  }
  // ON CONFLICT ... DO UPDATE SET 的列
  const dre = /\bDO\s+UPDATE\s+SET\s+([\s\S]+?)(?:\bWHERE\b|$)/gi;
  while ((m = dre.exec(sql))) {
    for (const ass of splitTopLevelCommas(m[1]!.trim())) {
      const eq = ass.indexOf('=');
      if (eq > 0) {
        const lhs = ass.slice(0, eq).trim();
        cols.push(lhs.split(/\s+/)[0]!);
      }
    }
  }
  return cols;
}

/** 只按顶层逗号切（跳过括号内的逗号）。 */
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// SQL 关键字 / 函数名 —— 不把它们当列名校验
const RESERVED = new Set<string>([
  // 连接器 / 谓词
  'AND', 'OR', 'NOT', 'IS', 'NULL', 'IN', 'LIKE', 'ESCAPE', 'BETWEEN', 'EXISTS',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  // 聚合 / 函数
  'COUNT', 'SUM', 'MAX', 'MIN', 'AVG', 'COALESCE', 'IFNULL', 'GROUP_CONCAT',
  'TRUE', 'FALSE',
]);

function normalizeIdent(s: string): string {
  // 去掉括号、参数标记、字符串字面量残留
  return s.toUpperCase().trim();
}

function isReservedWord(col: string): boolean {
  return RESERVED.has(normalizeIdent(col));
}

/**
 * 把全部静态 SQL（不含 `${...}` 动态片段）从 repo.ts + search.ts 源文件里抠出来。
 * 读源文件 + 正则，而非手抄清单——新增 SQL 自动被覆盖，不会因为忘了补测试产生虚假安全感。
 */
function collectLocalRepoSql(): string[] {
  const out: string[] = [];

  // SEARCH_SQL 是直接导出的常量
  out.push(SEARCH_SQL);

  // repo.ts 的 SQL：读源文件，抽 `this.db.select/execute(...)` 和 `{ sql: ... }` 模板字符串
  const repoSrc = readSource('repo.ts');
  out.push(...extractSqlTemplates(repoSrc));

  // 跳过：store/*（节点侧）、sync.ts（pack 读，不是本地库）、fakes.ts（FakePackReader 是测试替身）
  // —— 这三处表/列名都按节点 schema 写 source_rev/sqlite_table/dist_class，对 SCHEMA_SQL 必红。

  return Array.from(new Set(out));
}

/** 以本文件为锚点，取同目录下另一份源码的文本（vitest 跑在 ts 上，__dirname 用的是 cwd；这里用显式相对路径）。 */
function readSource(name: string): string {
  // 运行时文件在 packages/core-ts/src/ 下，用 __dirname 取基目录
  // vitest 的 __dirname 就是源文件目录（因为 transform 后直接跑 ts）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  // __filename 在 ESM+vitest 下不可用；用相对路径定位
  // 实际上 vitest 把本文件放在 packages/core-ts/src/schema-check.test.ts，
  // repo.ts 就在同目录。所以直接用 packages/core-ts/src/ 作为基。
  const base = join(process.cwd(), 'src');
  return readFileSync(join(base, name), 'utf8');
}

/**
 * 从源码里抽所有反引号模板字符串内以 SQL 关键字开头的内容。
 * 跳过含 `${` 的（动态片段，我们不知道最终形态）、PRAGMA/空串。
 *
 * 同时抽 `${cols}` 这种动态列的出现次数，用于条数守卫。
 */
function extractSqlTemplates(src: string): string[] {
  const out: string[] = [];
  // 反引号模板：`...`，简单匹配（不处理嵌套反引号，源码里没有）
  const re = /`([^`]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const body = m[1]!;
    if (body.includes('${')) continue; // 跳过动态
    const trimmed = body.trim();
    if (!trimmed) continue;
    // 只认 SQL 语句
    if (/^(SELECT|INSERT|UPDATE|DELETE|ALTER)\s/i.test(trimmed)) {
      out.push(normalizeWhitespace(trimmed));
    }
  }
  return out;
}

/** 把多空白 / 换行收敛成单空格，保证相同 SQL 不因为换行格式不同重复入队。 */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** repo.ts 里 `this.db.select/execute` / `{ sql: ... }` 的调用次数（含动态 `\`\${cols}\``）。 */
function repoSqlInvocationCount(): number {
  const src = readSource('repo.ts');
  const patterns = [
    /this\.db\.select\s*\(/g,
    /this\.db\.execute\s*\(/g,
    /\{[^}]*\bsql\s*:\s*`/g, // stmts.push({ sql: `...`, params: [...] })
  ];
  let n = 0;
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) n++;
  }
  return n;
}

// ---------- 校验 ----------

interface Violation {
  sql: string;
  column: string;
  table: string | '?';
}

function validateSql(sql: string): Violation[] {
  const violations: Violation[] = [];
  const st = extractSqlTables(sql);
  const tables = st.tables;
  const knownTables = tables.filter((t) => TABLES.has(t));
  // JOIN FROM 别名：例如 `FROM user_state u` → {'u': 'user_state'}
  // 抽列名时剥别名前缀；抽完之后再把别名本身过滤掉（防止裸别名误入列名清单）
  const aliasSet = new Set<string>(Object.keys(st.aliases));

  // ALTER TABLE 单独处理（列名就在 ALTER 里）
  const alterMatch = sql.match(/\bALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i);
  if (alterMatch) {
    const [, table, col] = alterMatch;
    if (TABLES.has(table!) && !TABLES.get(table!)!.has(col!)) {
      violations.push({ sql, column: col!, table: table! });
    }
    return violations;
  }

  const cols = new Set<string>();
  extractSelectColumns(sql).forEach((c) => cols.add(c));
  extractInsertColumns(sql).forEach((c) => cols.add(c));
  extractSetColumns(sql).forEach((c) => cols.add(c));

  for (const col of cols) {
    if (!col) continue;
    if (isReservedWord(col)) continue;
    // JOIN 别名（如 u / i）不是列
    if (aliasSet.has(col)) continue;
    // 占位 / 函数调用残留
    if (/^\d+$/.test(col)) continue;
    if (col === '?') continue;
    const bare = col.replace(/^excluded\./, '');
    if (knownTables.length === 0) {
      // 这张 SQL 没命中任何已知表（例如 PRAGMA table_info / count(*)），跳过
      continue;
    }
    const ok = knownTables.some((t) => TABLES.get(t)!.has(bare));
    if (!ok) {
      violations.push({ sql, column: bare, table: knownTables.join('|') });
    }
  }
  return violations;
}

describe('本地库 SQL 列名 ↔ DDL 一致性', () => {
  it('SCHEMA_SQL 自身的建表语句能被解析成 table→columns 映射', () => {
    // 至少要覆盖 repo.ts 里实际用到的表
    const expectedTables = [
      'config', 'items', 'articles', 'blob_index', 'tombstone', 'user_state',
      'quizzes', 'quiz_attempt', 'comment_out', 'like_out', 'segments', 'my_submissions',
      'groups', 'group_keys', 'dm_keys', 'tag_links', 'progress', 'checkin_days',
    ];
    for (const t of expectedTables) {
      expect(TABLES.has(t), `${t} 必须在 SCHEMA_SQL 里有建表`).toBe(true);
      expect(TABLES.get(t)!.size, `${t} 不能是空建表`).toBeGreaterThan(0);
    }
  });

  it('repo.ts + search.ts 的全部静态 SQL 列名均在对应表的 DDL 内', () => {
    const sqls = collectLocalRepoSql();
    const all: Violation[] = [];
    for (const s of sqls) {
      const v = validateSql(s);
      for (const x of v) all.push(x);
    }
    if (all.length > 0) {
      const msg = all
        .map(({ sql, column, table }) => `  [${table}] 列 ${column} 不在 DDL 内\n    SQL: ${sql.slice(0, 120)}${sql.length > 120 ? '…' : ''}`)
        .join('\n');
      throw new Error(`发现 ${all.length} 条列名漂移：\n${msg}`);
    }
    // 断言通过
    expect(all).toEqual([]);
  });

  // 回归守卫：SEARCH_SQL 的 SELECT 列必须逐项出现在 SCHEMA_SQL articles DDL
  it('SEARCH_SQL 的每列都在本地库 articles 建表内（直接对齐 search.test.ts 里的单条守卫）', () => {
    const ddl = SCHEMA_SQL.find((s) => s.includes('CREATE TABLE IF NOT EXISTS articles')) ?? '';
    expect(ddl).not.toBe('');
    const cols = SEARCH_SQL.slice(0, SEARCH_SQL.indexOf(' FROM '))
      .replace(/^SELECT\s+/, '')
      .split(',')
      .map((c) => c.trim());
    for (const c of cols) expect(ddl).toContain(c);
  });

  // 结构性守卫：手维护 SQL 清单是已知弱点——改为源文件扫描后，断言抽取出的静态 SQL 数
  // 与 repo.ts 里实际存在的模板串数一致，新增 SQL 会被自动纳入。
  it('静态 SQL 源文件抽取：repo.ts 里每条不含 ${ 的 SQL 模板都被 collectLocalRepoSql 抓到', () => {
    const repoSrc = readSource('repo.ts');
    const re = /`([^`]*)`/g;
    let m;
    const staticSqLsFromSource: string[] = [];
    while ((m = re.exec(repoSrc))) {
      const body = m[1]!;
      if (body.includes('${')) continue;
      const trimmed = body.trim();
      if (!trimmed) continue;
      if (/^(SELECT|INSERT|UPDATE|DELETE|ALTER)\s/i.test(trimmed)) {
        staticSqLsFromSource.push(normalizeWhitespace(trimmed));
      }
    }
    const scanned = new Set(collectLocalRepoSql().map(normalizeWhitespace));
    for (const s of staticSqLsFromSource) {
      expect(scanned.has(s), `repo.ts 里这条静态 SQL 没被扫描器抓到：${s.slice(0, 80)}`).toBe(true);
    }
    // 另外 search.ts 里的 SEARCH_SQL 也必须被覆盖
    expect(scanned.has(normalizeWhitespace(SEARCH_SQL)), 'SEARCH_SQL 被扫描器漏掉').toBe(true);

    // repo.ts 里的含 ${ 的 SQL 模板必须 ≤ 3 条（已知：listSubmissions 两条 `${cols}`、
    //                                 getByTagIds 一条 `${marks}`）。
    // 新增动态 SQL 意味着必须显式在扫描器里加跳过逻辑——否则下次改动就出意外。
    let dyn = 0;
    while ((m = re.exec(repoSrc))) {
      if (!m[1]!.includes('${')) continue;
      if (/^(SELECT|INSERT|UPDATE|DELETE|ALTER)\s/i.test(m[1]!.trim())) dyn++;
    }
    expect(dyn, 'repo.ts 里含 ${ 的 SQL 模板条数（已知 3 条）').toBe(3);
  });
});
