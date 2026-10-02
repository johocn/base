// node-sqlite3-wasm 的宿主封装：读写 / 只读两种打开方式 + 最小执行面。
// 只读打开用于取证；读写打开用于 normal 的 store。
import { closeSync, existsSync, openSync, readSync, writeSync } from "node:fs";
import sqlite3 from "node-sqlite3-wasm";

export type SqlValue = string | number | bigint | boolean | Uint8Array | null;

export interface HostDb {
  /** 执行不带参数的 SQL（可含多条语句；用于 DDL 与 BEGIN/COMMIT）。 */
  exec(sql: string): void;
  run(sql: string, params?: SqlValue[]): void;
  get(sql: string, params?: SqlValue[]): Record<string, SqlValue> | undefined;
  all(sql: string, params?: SqlValue[]): Record<string, SqlValue>[];
  close(): void;
}

export interface OpenDbOptions {
  /** true = 只读且必须已存在。 */
  readOnly?: boolean;
}

/**
 * WAL → rollback 头归一化（Node 驱动的硬约束）。
 *
 * Go store 固定 `journal_mode(WAL)`，而 node-sqlite3-wasm 的 WASM VFS 没有 `xShmMap`，
 * 对任何 WAL 库（只读或读写）都直接报 `unable to open database file`（已实测；URI
 * `?immutable=1` / `?mode=ro` 同样不通）。
 *
 * 干净退出的 WAL 库内容已全部 checkpoint 回主文件，把主库头 [18,19] 由 (2,2) 改成 (1,1)
 * 即等价于 `PRAGMA journal_mode=DELETE` 的落地状态——一次性格式迁移，幂等，不碰任何数据页。
 *
 * 若存在 `-wal` / `-shm` 兄弟文件（对端未干净退出或正在并发写），主文件不完整，拒绝打开。
 */
export function normalizeJournalMode(dbPath: string): void {
  let fd: number;
  try {
    fd = openSync(dbPath, "r+");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // 新库，交给驱动创建
    throw err;
  }
  try {
    const hdr = Buffer.alloc(2);
    readSync(fd, hdr, 0, 2, 18);
    if (hdr[0] !== 2 || hdr[1] !== 2) return;
    for (const side of ["-wal", "-shm"]) {
      if (existsSync(dbPath + side)) {
        throw new Error(
          `store: ${dbPath} 是 WAL 库且存在 ${side} 残留（对端未干净退出或正在写入），` +
            `驱动无法打开；请先让 Go 节点正常停止`,
        );
      }
    }
    writeSync(fd, Buffer.from([1, 1]), 0, 2, 18);
  } finally {
    closeSync(fd);
  }
}

export function openHostDb(path: string, opts: OpenDbOptions = {}): HostDb {
  const readOnly = opts.readOnly === true;
  const db = new sqlite3.Database(path, { readOnly, fileMustExist: readOnly });
  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    run(sql: string, params: SqlValue[] = []): void {
      db.run(sql, params);
    },
    get(sql: string, params: SqlValue[] = []): Record<string, SqlValue> | undefined {
      const row = db.get(sql, params);
      return row === null ? undefined : (row as Record<string, SqlValue>);
    },
    all(sql: string, params: SqlValue[] = []): Record<string, SqlValue>[] {
      return db.all(sql, params) as Record<string, SqlValue>[];
    },
    close(): void {
      db.close();
    },
  };
}
