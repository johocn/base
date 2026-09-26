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

/** plus.io 的目录/文件对象（HTML5+ 里两者是同一族 duck-typed 对象） */
interface PlusEntry {
  isFile?: boolean;
  isDirectory?: boolean;
  getDirectory(
    path: string,
    flag: { create: boolean; exclusive?: boolean },
    success: (entry: PlusEntry) => void,
    error: (e: unknown) => void,
  ): void;
  getFile(
    path: string,
    flag: { create: boolean; exclusive?: boolean },
    success: (entry: PlusEntry) => void,
    error: (e: unknown) => void,
  ): void;
  createWriter(success: (writer: PlusWriter) => void, error: (e: unknown) => void): void;
  file(success: (file: { size?: number }) => void, error: (e: unknown) => void): void;
  getMetadata(success: (meta: { size?: number }) => void, error: (e: unknown) => void): void;
  remove(success?: () => void, error?: (e: unknown) => void): void;
}

/**
 * plus.io 的写文件对象。writeAsBinary 收的是 **base64 串**（不是 Uint8Array）——
 * 依据是 DCloud 自家 uni-h5 的 app-plus/helpers/save-image.js：`writer.writeAsBinary(base64)`。
 */
interface PlusWriter {
  onwrite?: () => void;
  onerror?: (e: unknown) => void;
  seek(position: number): void;
  writeAsBinary(data: string): void;
}

/** plus.io 的读文件对象：只有 readAsDataURL / readAsText，二进制只能走 dataURL */
interface PlusReader {
  result?: string;
  onloadend?: () => void;
  onerror?: (e: unknown) => void;
  readAsDataURL(file: { size?: number }): void;
}

export interface PlusRuntime {
  io: {
    convertLocalFileSystemURL(path: string): string;
    /** url 支持相对 URL（_doc/…）与本地绝对 URL（file:///…），见 HTML5+ io 文档 */
    resolveLocalFileSystemURL(url: string, success: (entry: PlusEntry) => void, error: (e: unknown) => void): void;
    FileReader: new () => PlusReader;
  };
  sqlite: PlusSqlite;
}

interface UniGlobal {
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

const DOC = '_doc';

/** 绝对平台路径 → plus.io 认的 URL（_doc/…）：plus.io 不认裸平台路径 */
function toPlusUrl(io: PlusRuntime['io'], absPath: string): string {
  const doc = io.convertLocalFileSystemURL(DOC);
  return absPath.startsWith(doc) ? DOC + absPath.slice(doc.length) : absPath;
}

function resolveUrl(io: PlusRuntime['io'], url: string): Promise<PlusEntry> {
  return new Promise((resolve, reject) => {
    io.resolveLocalFileSystemURL(url, resolve, (e) =>
      reject(new Error(`解析路径失败 ${url}: ${JSON.stringify(e)}`)),
    );
  });
}

export class PlusFs implements FsAdapter {
  constructor(private readonly p: PlusRuntime) {}

  /** 逐段下钻建目录，缺失的段一律 create —— 调用方不必先建父目录 */
  private async dirEntry(absDir: string): Promise<PlusEntry> {
    const parts = toPlusUrl(this.p.io, absDir).split('/').filter(Boolean);
    let entry = await resolveUrl(this.p.io, parts[0] as string);
    for (const name of parts.slice(1)) {
      const parent = entry;
      entry = await new Promise<PlusEntry>((resolve, reject) => {
        parent.getDirectory(name, { create: true, exclusive: false }, resolve, (e) =>
          reject(new Error(`建目录失败 ${absDir}/${name}: ${JSON.stringify(e)}`)),
        );
      });
    }
    return entry;
  }

  private async fileEntry(absPath: string, create: boolean): Promise<PlusEntry> {
    const cut = absPath.lastIndexOf('/');
    const dir = await this.dirEntry(absPath.slice(0, cut));
    const name = absPath.slice(cut + 1);
    return new Promise<PlusEntry>((resolve, reject) => {
      dir.getFile(name, { create, exclusive: false }, resolve, (e) =>
        reject(new Error(`打开文件失败 ${absPath}: ${JSON.stringify(e)}`)),
      );
    });
  }

  async rootDir(): Promise<string> {
    return `${this.p.io.convertLocalFileSystemURL(DOC)}/base`;
  }

  /** 目录必须显式创建：SQLite 会建库文件，但不会建父目录 */
  async ensureDir(dir: string): Promise<void> {
    await this.dirEntry(dir);
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    // 先删旧文件：覆盖写时残留的尾巴会让上一次更长的内容混进来
    await this.remove(path);
    const entry = await this.fileEntry(path, true);
    const writer = await new Promise<PlusWriter>((resolve, reject) => {
      entry.createWriter(resolve, (e) => reject(new Error(`createWriter 失败 ${path}: ${JSON.stringify(e)}`)));
    });
    await new Promise<void>((resolve, reject) => {
      writer.onwrite = () => resolve();
      writer.onerror = (e) => reject(new Error(`写文件失败 ${path}: ${JSON.stringify(e)}`));
      writer.seek(0);
      writer.writeAsBinary(bytesToBase64(data));
    });
  }

  async readFile(path: string): Promise<Uint8Array> {
    const entry = await this.fileEntry(path, false);
    const file = await new Promise<{ size?: number }>((resolve, reject) => entry.file(resolve, reject));
    const reader = new this.p.io.FileReader();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      reader.onloadend = () => {
        if (typeof reader.result === 'string') resolve(reader.result);
        else reject(new Error(`读文件无结果 ${path}`));
      };
      reader.onerror = (e) => reject(new Error(`读文件失败 ${path}: ${JSON.stringify(e)}`));
      reader.readAsDataURL(file);
    });
    const comma = dataUrl.indexOf(',');
    return base64ToBytes(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.fileEntry(path, false);
      return true;
    } catch {
      return false;
    }
  }

  async remove(path: string): Promise<void> {
    try {
      const entry = await this.fileEntry(path, false);
      await new Promise<void>((resolve, reject) => entry.remove(resolve, (e) => reject(e)));
    } catch {
      // 文件本就不存在
    }
  }

  async size(path: string): Promise<number> {
    const entry = await this.fileEntry(path, false);
    const meta = await new Promise<{ size?: number }>((resolve, reject) => entry.getMetadata(resolve, reject));
    return meta.size ?? 0;
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

/** Uint8Array → base64：plus.io 的 writeAsBinary 只收 base64 串 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000; // 分块喂 fromCharCode，避免超参数上限
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toUint8(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return new Uint8Array(0);
}