// node-sqlite3-wasm 的同步封装：只暴露路由层需要的最小三方法。
import sqlite3 from "node-sqlite3-wasm";

type BindValue = string | number | bigint | boolean | Uint8Array | null;

export interface Db {
  select(sql: string, params?: unknown[]): Record<string, unknown>[];
  execute(sql: string, params?: unknown[]): void;
  close(): void;
}

export function openDb(path: string): Db {
  const db = new sqlite3.Database(path);
  return {
    select(sql, params = []) {
      return db.all(sql, params as BindValue[]) as Record<string, unknown>[];
    },
    execute(sql, params = []) {
      db.run(sql, params as BindValue[]);
    },
    close() {
      db.close();
    },
  };
}
