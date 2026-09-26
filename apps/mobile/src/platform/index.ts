import { SCHEMA_SQL, SqlRepo, type LocalRepo } from '../core/repo';
import type { SyncOptions } from '../core/sync';
import type { Adapters, LocalDb } from './adapter';
import { PlusFs, PlusHttp, PlusLocalDb, PlusPackReader, PlusStorage, assertAppRuntime } from './uni';

export interface AppContext {
  opts: SyncOptions;
  repo: LocalRepo;
  db: LocalDb;
}

let cached: AppContext | null = null;

/** 建表 + 组装适配器；重复调用复用同一实例。 */
export async function bootstrap(): Promise<AppContext> {
  if (cached) return cached;
  const p = assertAppRuntime();
  const fs = new PlusFs(p);
  const root = await fs.rootDir();
  await fs.ensureDir(root);

  const db = new PlusLocalDb(p, `${root}/base.db`);
  for (const sql of SCHEMA_SQL) await db.execute(sql);

  const repo = new SqlRepo(db);
  const adapters: Adapters = {
    fs,
    storage: new PlusStorage(),
    http: new PlusHttp(),
    packReader: new PlusPackReader(p),
  };
  const nodeBaseUrl = ((await repo.getConfig('node_base_url')) ?? '').replace(/\/+$/, '');
  cached = { repo, db, opts: { adapters, repo, nodeBaseUrl, workDir: root } };
  return cached;
}

/** 节点地址保存后刷新缓存里的 baseUrl */
export function updateNodeBaseUrl(baseUrl: string): void {
  if (cached) cached.opts.nodeBaseUrl = baseUrl.replace(/\/+$/, '');
}