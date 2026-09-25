// 所有 plus.* / uni.* 调用只允许出现在本文件。
// H5 下没有 plus 运行时：bootstrap() 会抛出可读提示（H5 只用于界面预览）。
import { sqlWithParams } from '../core/sql';
import type {
  Adapters,
  FsAdapter,
  HttpResponse,
  HttpAdapter,
  LocalDb,
  PackReader,
  SqliteConnection,
  StorageAdapter,
} from './adapter';

interface PlusSqlite {
  isOpenDatabase(name: string): boolean;
  openDatabase(o: { name: string; path: string; success: () => void; fail: (e: unknown) => void }): void;
  closeDatabase(o: { name: string; success: () => void; fail: (e: unknown) => void }): void;
  selectSql(o: {
    name: string;
    sql: string;
    success: (rows: Record<string, unknown>[]) => void;
    fail: (e: unknown) => void;
  }): void;
  executeSql(o: { name: string; sql: string | string[]; success: () => void; fail: (e: unknown) => void }): void;
  transaction(o: {
    name: string;
    operation: 'begin' | 'commit' | 'rollback';
    success: () => void;
    fail: (e: unknown) => void;
  }): void;
}

export interface PlusRuntime {
  io: { convertLocalFileSystemURL(path: string): string };
  sqlite: PlusSqlite;
}

interface FsManager {
  mkdirSync(path: string, recursive?: boolean): void;
  writeFileSync(path: string, data: ArrayBuffer, encoding?: string): void;
  readFileSync(path: string, encoding?: string): ArrayBuffer | string;
  accessSync(path: string): void;
  unlinkSync(path: string): void;
  statSync(path: string): { size: number };
}

interface UniGlobal {
  getFileSystemManager?: () => FsManager;
  getStorageSync(key: string): string;
  setStorageSync(key: string, value: string): void;
  request(o: {
    url: string;
    method: 'GET';
    header?: Record<string, string>;
    responseType: 'arraybuffer';
    success: (res: { statusCode: number; data: unknown }) => void;
    fail: (e: unknown) => void;
  }): void;
}

function g(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

export function plusRuntime(): PlusRuntime | undefined {
  return g().plus as PlusRuntime | undefined;
}

function uniGlobal(): UniGlobal {
  const u = g().uni as UniGlobal | undefined;
  if (!u) throw new Error('uni 运行时不可用');
  return u;
}

/** H5 下没有 plus：给可读提示，而不是 TypeError。 */
export function assertAppRuntime(): PlusRuntime {
  const p = plusRuntime();
  if (!p) {
    throw new Error('当前环境不支持本地库与文件读写（H5 仅用于界面预览），请在 App 或真机上运行');
  }
  return p;
}

const LOCAL_DB = 'base';
const PACK_DB = 'pack';

class PlusConn implements SqliteConnection {
  constructor(private readonly p: PlusRuntime, private readonly name: string) {}

  async open(path: string): Promise<void> {
    if (this.p.sqlite.isOpenDatabase(this.name)) await this.close();
    await new Promise<void>((resolve, reject) => {
      this.p.sqlite.openDatabase({
        name: this.name,
        path,
        success: () => resolve(),
        fail: (e) => reject(new Error(`openDatabase(${this.name}, ${path}) 失败: ${JSON.stringify(e)}`)),
      });
    });
  }

  async close(): Promise<void> {
    if (!this.p.sqlite.isOpenDatabase(this.name)) return;
    await new Promise<void>((resolve, reject) => {
      this.p.sqlite.closeDatabase({
        name: this.name,
        success: () => resolve(),
        fail: (e) => reject(new Error(`closeDatabase(${this.name}) 失败: ${JSON.stringify(e)}`)),
      });
    });
  }

  async select(sql: string, params: readonly unknown[] = []): Promise<Record<string, unknown>[]> {
    const full = sqlWithParams(sql, params);
    return new Promise((resolve, reject) => {
      this.p.sqlite.selectSql({
        name: this.name,
        sql: full,
        success: (rows) => resolve(rows ?? []),
        fail: (e) => reject(new Error(`selectSql 失败: ${JSON.stringify(e)} sql=${full}`)),
      });
    });
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
    await this.execMany([sqlWithParams(sql, params)]);
  }

  async execMany(sqls: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.p.sqlite.executeSql({
        name: this.name,
        sql: sqls,
        success: () => resolve(),
        fail: (e) => reject(new Error(`executeSql 失败: ${JSON.stringify(e)}`)),
      });
    });
  }

  async begin(): Promise<void> {
    await this.op('begin');
  }
  async commit(): Promise<void> {
    await this.op('commit');
  }
  async rollback(): Promise<void> {
    await this.op('rollback');
  }

  private async op(operation: 'begin' | 'commit' | 'rollback'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.p.sqlite.transaction({
        name: this.name,
        operation,
        success: () => resolve(),
        fail: (e) => reject(new Error(`transaction(${operation}) 失败: ${JSON.stringify(e)}`)),
      });
    });
  }
}

export class PlusLocalDb implements LocalDb {
  private readonly conn: PlusConn;
  private ready = false;

  constructor(private readonly p: PlusRuntime, private readonly dbPath: string) {
    this.conn = new PlusConn(p, LOCAL_DB);
  }

  private async ensure(): Promise<PlusConn> {
    if (!this.ready) {
      await this.conn.open(this.dbPath);
      this.ready = true;
    }
    return this.conn;
  }

  async select(sql: string, params: readonly unknown[] = []): Promise<Record<string, unknown>[]> {
    return (await this.ensure()).select(sql, params);
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
    return (await this.ensure()).execute(sql, params);
  }

  async tx(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void> {
    const conn = await this.ensure();
    const sqls = statements.map((s) => sqlWithParams(s.sql, s.params ?? []));
    await conn.begin();
    try {
      await conn.execMany(sqls);
      await conn.commit();
    } catch (e) {
      try {
        await conn.rollback();
      } catch {
        // 回滚失败不覆盖原始错误
      }
      throw e;
    }
  }
}

export class PlusFs implements FsAdapter {
  constructor(private readonly p: PlusRuntime) {}

  private mgr(): FsManager {
    const m = uniGlobal().getFileSystemManager?.();
    if (!m) throw new Error('当前运行时不支持 uni.getFileSystemManager（文件读写不可用）');
    return m;
  }

  /** 目录必须显式创建：SQLite 会建库文件，但不会建父目录 */
  ensureDir(dir: string): void {
    const m = this.mgr();
    try {
      m.accessSync(dir);
    } catch {
      m.mkdirSync(dir, true);
    }
  }

  async rootDir(): Promise<string> {
    return `${this.p.io.convertLocalFileSystemURL('_doc')}/base`;
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.ensureDir(path.slice(0, path.lastIndexOf('/')));
    this.mgr().writeFileSync(path, toArrayBuffer(data), 'binary');
  }

  async readFile(path: string): Promise<Uint8Array> {
    return toUint8(this.mgr().readFileSync(path, 'binary'));
  }

  async exists(path: string): Promise<boolean> {
    try {
      this.mgr().accessSync(path);
      return true;
    } catch {
      return false;
    }
  }

  async remove(path: string): Promise<void> {
    try {
      this.mgr().unlinkSync(path);
    } catch {
      // 文件本就不存在
    }
  }

  async size(path: string): Promise<number> {
    return this.mgr().statSync(path).size;
  }
}

export class PlusHttp implements HttpAdapter {
  async get(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
    const res = await new Promise<{ statusCode: number; data: unknown }>((resolve, reject) => {
      uniGlobal().request({
        url,
        method: 'GET',
        header: headers,
        responseType: 'arraybuffer',
        success: resolve,
        fail: (e) => reject(new Error(`请求失败 ${url}: ${JSON.stringify(e)}`)),
      });
    });
    return { status: res.statusCode ?? 0, body: toUint8(res.data) };
  }
}

export class PlusStorage implements StorageAdapter {
  async get(key: string): Promise<string | null> {
    const v = uniGlobal().getStorageSync(key);
    return v === undefined || v === null || v === '' ? null : String(v);
  }
  async set(key: string, value: string): Promise<void> {
    uniGlobal().setStorageSync(key, value);
  }
}

/** 用 plus.sqlite 直接打开下载下来的 pack.sqlite（它是真 SQLite 文件）。 */
export class PlusPackReader implements PackReader {
  constructor(private readonly p: PlusRuntime) {}

  async open(path: string): Promise<SqliteConnection> {
    const conn = new PlusConn(this.p, PACK_DB);
    await conn.open(path);
    return conn;
  }

  async close(conn: SqliteConnection): Promise<void> {
    await (conn as PlusConn).close();
  }
}

export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export function toUint8(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return new Uint8Array(0);
}