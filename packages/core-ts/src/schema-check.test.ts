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

/** 把全部静态 SQL（不包含 `${}`）从 repo.ts + search.ts 源文件里抠出来。 */
function collectLocalRepoSql(): string[] {
  // 直接手列，避免再写一套源文件扫描；漏一条马上加。
  // 按调用点分组，带注释说明跳过原因。
  const out: string[] = [];

  // === search.ts ===
  out.push(SEARCH_SQL);

  // === repo.ts ===
  out.push("SELECT value FROM config WHERE key=?");
  out.push("INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  out.push("INSERT INTO tombstone(item_id,revoked_rev) VALUES(?,?) ON CONFLICT(item_id) DO UPDATE SET revoked_rev=excluded.revoked_rev");

  // tombstone: DELETE 全部下游表
  out.push("DELETE FROM blob_index WHERE item_id=?");
  out.push("DELETE FROM articles WHERE item_id=?");
  out.push("DELETE FROM quizzes WHERE item_id=?");
  out.push("DELETE FROM segments WHERE item_id=?");
  out.push("DELETE FROM tag_links WHERE tag_id=?");
  out.push("DELETE FROM items WHERE item_id=?");

  // applyPack：items / articles / quizzes 三支 INSERT + DELETE
  out.push(
    "INSERT INTO items(item_id,source,type,title,rev,content_hash,state,updated_at,author_id,author_sig) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(item_id) DO UPDATE SET source=excluded.source,type=excluded.type,title=excluded.title," +
      "rev=excluded.rev,content_hash=excluded.content_hash,state=excluded.state,updated_at=excluded.updated_at," +
      "author_id=excluded.author_id,author_sig=excluded.author_sig",
  );
  out.push(
    "INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,rev) " +
      "VALUES(?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(item_id) DO UPDATE SET title=excluded.title,digest=excluded.digest," +
      "published_at=excluded.published_at,tags_json=excluded.tags_json,body_md=excluded.body_md," +
      "content_hash=excluded.content_hash,rev=excluded.rev",
  );
  out.push(
    "INSERT INTO quizzes(item_id,question_json,content_hash) VALUES(?,?,?) " +
      "ON CONFLICT(item_id) DO UPDATE SET question_json=excluded.question_json," +
      "content_hash=excluded.content_hash",
  );
  out.push("INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)");
  out.push(
    "INSERT INTO tag_links(tag_id,target_id,kind) VALUES(?,?,?) " +
      "ON CONFLICT(tag_id,target_id,kind) DO NOTHING",
  );
  out.push("DELETE FROM segments WHERE item_id=?");
  out.push("DELETE FROM tag_links WHERE tag_id=?");

  // applyPack 的 config 版本号 upsert
  out.push("INSERT INTO config(key,value) VALUES('content_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  out.push("INSERT INTO config(key,value) VALUES('pack_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");

  // get / list items
  out.push("SELECT item_id,source,type,title,rev,content_hash,state,updated_at,author_id,author_sig FROM items WHERE item_id=?");
  out.push("SELECT item_id,source,type,title,rev,content_hash,state,updated_at,author_id,author_sig FROM items");
  // get article
  out.push("SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,rev FROM articles WHERE item_id=?");
  // getContainerSegments
  out.push("SELECT item_id,seq,kind,text,content_hash FROM segments WHERE item_id=? ORDER BY seq ASC");
  // tags：listTagLinks / getByTagIds
  out.push("SELECT tag_id,target_id,kind FROM tag_links ORDER BY tag_id ASC, kind ASC, target_id ASC");
  out.push("SELECT tag_id,target_id,kind FROM tag_links WHERE target_id IN (?) ORDER BY tag_id ASC, kind ASC, target_id ASC");

  // syncOnce：tombstone 清单 + blob_index 查
  out.push("SELECT item_id FROM items");
  out.push("DELETE FROM user_state WHERE item_id=?");
  out.push("DELETE FROM quiz_attempt WHERE item_id=?");
  out.push("SELECT blob_id FROM blob_index WHERE blob_id=?");
  out.push(
    "INSERT INTO blob_index(blob_id,item_id,path,size,verified_at) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(blob_id) DO UPDATE SET item_id=excluded.item_id,path=excluded.path," +
      "size=excluded.size,verified_at=excluded.verified_at",
  );
  out.push("SELECT item_id,revoked_rev FROM tombstone");
  out.push("SELECT path FROM blob_index WHERE item_id=?");

  // favorite
  out.push("SELECT favorited_at FROM user_state WHERE item_id=?");
  out.push(
    "INSERT INTO user_state(item_id,favorited_at) VALUES(?,?) " +
      "ON CONFLICT(item_id) DO UPDATE SET favorited_at=excluded.favorited_at",
  );
  out.push("SELECT item_id FROM user_state WHERE item_id=? AND favorited_at IS NOT NULL");
  // listFavorites JOIN（动态列 `${cols}` 不在此范围）
  out.push(
    "SELECT u.item_id AS item_id, i.title AS title, u.favorited_at AS favorited_at " +
      "FROM user_state u INNER JOIN items i ON i.item_id=u.item_id WHERE u.favorited_at IS NOT NULL ORDER BY u.favorited_at DESC",
  );
  out.push("SELECT read_at FROM user_state WHERE item_id=?");
  out.push(
    "INSERT INTO user_state(item_id,read_at) VALUES(?,?) " +
      "ON CONFLICT(item_id) DO UPDATE SET read_at=excluded.read_at",
  );

  // quiz
  out.push("SELECT item_id,source,type,title,rev,content_hash,state,updated_at FROM items WHERE type='quiz'");
  out.push("SELECT item_id,question_json,content_hash FROM quizzes WHERE item_id=?");
  out.push("INSERT INTO quiz_attempt(item_id,answered_at,correct,total) VALUES(?,?,?,?)");

  // learningStats
  out.push("SELECT count(*) AS n, MAX(read_at) AS m FROM user_state WHERE read_at IS NOT NULL");
  out.push("SELECT count(*) AS n, COALESCE(SUM(correct),0) AS c, COALESCE(SUM(total),0) AS t, MAX(answered_at) AS m FROM quiz_attempt");

  // comment_out：enqueue / list / fail / delete
  out.push(
    "INSERT INTO comment_out(event_id,target_id,text,reply_to,wire,state,reason,queued_at) VALUES(?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(event_id) DO UPDATE SET target_id=excluded.target_id,text=excluded.text," +
      "reply_to=excluded.reply_to,wire=excluded.wire,queued_at=excluded.queued_at",
  );
  out.push("SELECT event_id,target_id,text,reply_to,wire,state,reason,queued_at FROM comment_out ORDER BY queued_at ASC");
  out.push("UPDATE comment_out SET state='failed', reason=? WHERE event_id=?");
  out.push("DELETE FROM comment_out WHERE event_id=?");

  // groups / group_keys
  out.push(
    "INSERT INTO groups(group_id,name,creator_id,epoch,encrypted,roster_rev,member_ids_json,joined_at) VALUES(?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(group_id) DO UPDATE SET name=excluded.name,epoch=excluded.epoch,encrypted=excluded.encrypted," +
      "roster_rev=excluded.roster_rev,member_ids_json=excluded.member_ids_json,joined_at=excluded.joined_at",
  );
  out.push("SELECT group_id,name,creator_id,epoch,encrypted,roster_rev,member_ids_json,joined_at FROM groups ORDER BY joined_at ASC");
  out.push("SELECT group_id,name,creator_id,epoch,encrypted,roster_rev,member_ids_json,joined_at FROM groups WHERE group_id=?");
  out.push("INSERT INTO group_keys(group_id,epoch,key_cipher,created_at) VALUES(?,?,?,?) ON CONFLICT(group_id,epoch) DO NOTHING");
  out.push("SELECT group_id,epoch,key_cipher,created_at FROM group_keys WHERE group_id=? ORDER BY epoch ASC");

  // dm_keys
  out.push("INSERT INTO dm_keys(peer_id,key_cipher,created_at) VALUES(?,?,?) " +
    "ON CONFLICT(peer_id) DO UPDATE SET key_cipher=excluded.key_cipher,created_at=excluded.created_at");
  out.push("SELECT peer_id,key_cipher,created_at FROM dm_keys WHERE peer_id=?");
  out.push("SELECT peer_id,key_cipher,created_at FROM dm_keys ORDER BY created_at ASC");

  // my_submissions：upsert（长 INSERT ON CONFLICT DO UPDATE SET）
  out.push(
    "INSERT INTO my_submissions(item_id,type,title,body_md,question_json,links_json,segments_json,state,reason,created,queued_at,sent_at,local_only) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(item_id) DO UPDATE SET type=excluded.type,title=excluded.title,body_md=excluded.body_md," +
      "question_json=excluded.question_json,links_json=excluded.links_json,segments_json=excluded.segments_json," +
      "state=excluded.state,reason=excluded.reason,created=excluded.created,queued_at=excluded.queued_at," +
      "sent_at=excluded.sent_at,local_only=excluded.local_only",
  );
  // getSubmission（listSubmissions 的 `${cols}` 动态列跳过，但这里是静态的）
  out.push(
    "SELECT item_id,type,title,body_md,question_json,links_json,segments_json,state,reason,created,queued_at,sent_at,local_only FROM my_submissions WHERE item_id=?",
  );
  // submissions 的 UPDATE/DELETE
  out.push("UPDATE my_submissions SET state='sent', reason=NULL, created=?, sent_at=? WHERE item_id=?");
  out.push("UPDATE my_submissions SET state='failed', reason=? WHERE item_id=?");
  out.push("DELETE FROM my_submissions WHERE item_id=?");
  // local submission 的覆盖式 upsert（items + segments + my_submissions）
  out.push(
    "INSERT INTO items(item_id,source,type,title,rev,content_hash,state,updated_at) " +
      "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET source=excluded.source,type=excluded.type," +
      "title=excluded.title,rev=excluded.rev,content_hash=excluded.content_hash,state=excluded.state,updated_at=excluded.updated_at",
  );
  out.push("DELETE FROM segments WHERE item_id=?");
  out.push("INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)");
  out.push("DELETE FROM segments WHERE item_id=?");
  out.push("DELETE FROM items WHERE item_id=? AND source='local'");
  out.push("UPDATE my_submissions SET state='failed', reason=?, local_only=1 WHERE item_id=?");

  // progress / checkin_days
  out.push(
    "INSERT INTO progress(item_id,position,done,day,updated_at,event_id,dirty) VALUES(?,?,?,?,?,?,?) " +
      "ON CONFLICT(item_id) DO UPDATE SET position=excluded.position,done=excluded.done,day=excluded.day," +
      "updated_at=excluded.updated_at,event_id=excluded.event_id,dirty=excluded.dirty",
  );
  out.push("INSERT INTO checkin_days(day,first_event_id,created_at) VALUES(?,?,?) ON CONFLICT(day) DO NOTHING");
  out.push(
    "INSERT INTO progress(item_id,position,done,day,updated_at,event_id,dirty) VALUES(?,?,?,?,?,?,?) " +
      "ON CONFLICT(item_id,day) DO UPDATE SET position=excluded.position,done=excluded.done,day=excluded.day," +
      "updated_at=excluded.updated_at,event_id=excluded.event_id,dirty=excluded.dirty",
  );
  out.push("SELECT item_id,position,done,day,updated_at,event_id,dirty FROM progress ORDER BY item_id ASC");
  out.push("SELECT item_id,position,done,day,updated_at,event_id,dirty FROM progress WHERE item_id=?");
  out.push("SELECT day,first_event_id,created_at FROM checkin_days ORDER BY day ASC");

  // ensureItemsColumns：ALTER 语句也走本地库
  out.push("ALTER TABLE items ADD COLUMN author_id TEXT NOT NULL DEFAULT ''");
  out.push("ALTER TABLE items ADD COLUMN author_sig TEXT NOT NULL DEFAULT ''");
  out.push("ALTER TABLE groups ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 1");
  out.push("ALTER TABLE groups ADD COLUMN roster_rev INTEGER NOT NULL DEFAULT 0");

  return out;
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
      'quizzes', 'quiz_attempt', 'comment_out', 'segments', 'my_submissions',
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
});
