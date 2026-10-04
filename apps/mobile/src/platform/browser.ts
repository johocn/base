// @ts-ignore - sql.js 没官方类型声明，运行时从 node_modules 加载
import initSqlJs from 'sql.js';
import type {
  Adapters,
  FsAdapter,
  HttpAdapter,
  LocalDb,
  PackReader,
  SqliteConnection,
  StorageAdapter,
} from '@base/core-ts/platform/adapter';

/** 单例 sql.js initPromise（WASM 加载一次即可）。 */
let sqlInitPromise: ReturnType<typeof initSqlJs> | null = null;

async function getSqlJs() {
  if (!sqlInitPromise) {
    // locateFile 让 sql.js 在 H5/Vite 下能找到 .wasm（public 目录或 node_modules）
    sqlInitPromise = initSqlJs({
      locateFile: (file: string) =>
        new URL(`../../node_modules/sql.js/dist/${file}`, import.meta.url).toString(),
    });
  }
  return sqlInitPromise;
}

/**
 * H5 本地库（sql.js / WASM SQLite）。
 * 每次 openDb 都从 localStorage 读 + 每次写都同步回 localStorage，
 * 保证刷新不丢数据（H5 没有 plus.io 的文件系统）。
 */
export class SqlJsLocalDb implements LocalDb {
  private static SQL: any = null;

  constructor(private readonly storageKey: string = 'base-h5-db') {}

  private async getDb(): Promise<any> {
    if (!SqlJsLocalDb.SQL) SqlJsLocalDb.SQL = await getSqlJs();
    const raw = localStorage.getItem(this.storageKey);
    if (raw) {
      const bytes = new Uint8Array(JSON.parse(raw));
      return new SqlJsLocalDb.SQL.Database(bytes);
    }
    return new SqlJsLocalDb.SQL.Database();
  }

  private save(db: any) {
    const bytes = db.export();
    localStorage.setItem(this.storageKey, JSON.stringify(Array.from(bytes)));
  }

  async select(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    const db = await this.getDb();
    try {
      const stmt = db.prepare(sql);
      if (params && params.length > 0) stmt.bind(params);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    } finally {
      db.close();
    }
  }

  async execute(sql: string, params?: unknown[]): Promise<void> {
    const db = await this.getDb();
    try {
      if (params && params.length > 0) {
        db.run(sql, params);
      } else {
        db.run(sql);
      }
      this.save(db);
    } finally {
      db.close();
    }
  }

  async tx(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void> {
    const db = await this.getDb();
    try {
      db.run('BEGIN');
      for (const s of statements) {
        if (s.params && s.params.length > 0) db.run(s.sql, s.params);
        else db.run(s.sql);
      }
      db.run('COMMIT');
      this.save(db);
    } catch (e) {
      db.run('ROLLBACK');
      throw e;
    } finally {
      db.close();
    }
  }
}

/**
 * H5 文件系统降级：用 localStorage 存 Uint8Array。
 * key 前缀 'base-fs:' + 完整路径；字节 JSON 序列化成 Array.from。
 * 空间限制 ~5MB（localStorage 上限），足够编辑器图片上传用。
 */
export class BrowserFs implements FsAdapter {
  private static PREFIX = 'base-fs:';

  async rootDir(): Promise<string> {
    return '/base-h5';
  }

  private key(path: string): string {
    return BrowserFs.PREFIX + path;
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    try {
      localStorage.setItem(this.key(path), JSON.stringify(Array.from(data)));
    } catch (e: any) {
      throw new Error(`H5 localStorage 写入失败（可能超出 5MB 上限）: ${e.message}`);
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const raw = localStorage.getItem(this.key(path));
    if (!raw) throw new Error(`文件不存在: ${path}`);
    return new Uint8Array(JSON.parse(raw));
  }

  async exists(path: string): Promise<boolean> {
    return localStorage.getItem(this.key(path)) !== null;
  }

  async remove(path: string): Promise<void> {
    localStorage.removeItem(this.key(path));
  }

  async size(path: string): Promise<number> {
    const raw = localStorage.getItem(this.key(path));
    if (!raw) return 0;
    return JSON.parse(raw).length;
  }
}

/** window.localStorage 的 StorageAdapter 包装。 */
export class BrowserStorage implements StorageAdapter {
  async get(key: string): Promise<string | null> {
    return localStorage.getItem(key);
  }
  async set(key: string, value: string): Promise<void> {
    localStorage.setItem(key, value);
  }
}

/**
 * 浏览器原生 fetch() 实现 HttpAdapter。
 * plusRuntime 的 PlusHttp 用 uni.request，这里走标准 fetch，
 * 非 2xx 不抛错（契约：调用方按 status 判定）。
 */
export class FetchHttp implements HttpAdapter {
  private async fetchBytes(url: string, init: RequestInit): Promise<{ status: number; body: Uint8Array }> {
    const res = await fetch(url, init);
    const buf = await res.arrayBuffer();
    return { status: res.status, body: new Uint8Array(buf) };
  }

  async get(url: string, headers?: Record<string, string>): Promise<{ status: number; body: Uint8Array }> {
    return this.fetchBytes(url, { method: 'GET', headers });
  }

  async post(url: string, body: Uint8Array, headers?: Record<string, string>): Promise<{ status: number; body: Uint8Array }> {
    const buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    return this.fetchBytes(url, { method: 'POST', headers: { ...headers }, body: buf });
  }

  async put(url: string, body: Uint8Array, headers?: Record<string, string>): Promise<{ status: number; body: Uint8Array }> {
    const buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    return this.fetchBytes(url, { method: 'PUT', headers: { ...headers }, body: buf });
  }
}

/** H5 PackReader：sql.js 直接读 Uint8Array 形式的 pack.sqlite。 */
export class SqlJsPackReader implements PackReader {
  async open(path: string): Promise<SqliteConnection> {
    const bytes = await new BrowserFs().readFile(path);
    const SQL = await getSqlJs();
    const db = new SQL.Database(bytes);
    return new SqlJsPackConnection(db);
  }
  async close(_conn: SqliteConnection): Promise<void> {
    // 连接已自动释放（SqlJsPackConnection 内部持有 db）
  }
}

class SqlJsPackConnection implements SqliteConnection {
  constructor(private readonly db: any) {}

  async select(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    const stmt = this.db.prepare(sql);
    if (params && params.length > 0) stmt.bind(params);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  async execute(sql: string, params?: unknown[]): Promise<void> {
    if (params && params.length > 0) this.db.run(sql, params);
    else this.db.run(sql);
  }
}

/** H5 BrowserAdapter：供 platform/index.ts 的 h5Bootstrap() 调用。 */
export function h5Adapters(): Adapters {
  return {
    fs: new BrowserFs(),
    storage: new BrowserStorage(),
    http: new FetchHttp(),
    packReader: new SqlJsPackReader(),
  };
}
