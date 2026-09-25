// 平台适配层：把所有 uni-app / HTML5+ 能力收进这一组接口。
// 同步与离线核心（src/core）只依赖这些接口，不直接 import 'uni' 或 'plus'，
// 这样核心逻辑可以在 Node 下用假实现跑测试（见 Task 18）。
export interface FsAdapter {
  /** 应用私有可写根目录（如 _doc/base） */
  rootDir(): Promise<string>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  size(path: string): Promise<number>;
}

export interface StorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface HttpResponse {
  status: number;
  body: Uint8Array;
}

export interface HttpAdapter {
  /** 非 2xx 不抛错，由调用方按 status 判定 */
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
}

export interface SqliteConnection {
  select(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
}

export interface PackReader {
  /** 以只读方式打开下载下来的 pack.sqlite */
  open(path: string): Promise<SqliteConnection>;
  close(conn: SqliteConnection): Promise<void>;
}

/** 本地库连接（Task 19 用 plus.sqlite 实现，交给 SqlRepo 使用） */
export interface LocalDb {
  select(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  /** 在事务内执行 statements，任一失败整体回滚 */
  tx(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void>;
}

/** 同步核心只依赖这四项能力（故 Node 下可用假实现完整测试） */
export interface Adapters {
  fs: FsAdapter;
  storage: StorageAdapter;
  http: HttpAdapter;
  packReader: PackReader;
}