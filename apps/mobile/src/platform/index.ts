import { hexToBytes } from '@base/protocol-ts';

import { ENTROPY_FILL_BYTES, installRandomFallback } from '../core/entropy';
import { SCHEMA_SQL, SqlRepo, type LocalRepo } from '../core/repo';
import { UNKNOWN_FLAGS, type CapabilityFlags, type SelfCheckReport } from '../core/selfcheck';
import type { SyncOptions } from '../core/sync';
import type { Adapters, LocalDb } from './adapter';
import { PlusFs, PlusHttp, PlusLocalDb, PlusPackReader, PlusStorage, assertAppRuntime } from './uni';

export interface AppContext {
  opts: SyncOptions;
  repo: LocalRepo;
  db: LocalDb;
  /** 平台能力标志：只有明确 fail 才降级，unknown 与 ok 都照常尝试（selfcheck spec §4） */
  capabilities: CapabilityFlags;
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

  // 冷启动只定 cryptoOk：随机池预填的成败就是随机源可用与否的初值；其余标志保持 unknown
  const capabilities: CapabilityFlags = { ...UNKNOWN_FLAGS };

  // 逻辑层没有 WebCrypto，随机源改由 SQLite 提供（randomblob 的种子来自系统熵源）
  try {
    await installRandomFallback(async () => {
      const rows = await db.select(`SELECT hex(randomblob(${ENTROPY_FILL_BYTES})) AS b`);
      return hexToBytes(String(rows[0]?.b ?? ''));
    });
    capabilities.cryptoOk = 'ok';
  } catch {
    // 预填失败不阻断启动：评论页据此直接禁用发表并给出原因，不再等用户点一次才报错
    capabilities.cryptoOk = 'fail';
  }

  const repo = new SqlRepo(db);
  const adapters: Adapters = {
    fs,
    storage: new PlusStorage(),
    http: new PlusHttp(),
    packReader: new PlusPackReader(p),
  };
  const nodeBaseUrl = ((await repo.getConfig('node_base_url')) ?? '').replace(/\/+$/, '');
  cached = { repo, db, opts: { adapters, repo, nodeBaseUrl, workDir: root }, capabilities };
  return cached;
}

/** 节点地址保存后刷新缓存里的 baseUrl */
export function updateNodeBaseUrl(baseUrl: string): void {
  if (cached) cached.opts.nodeBaseUrl = baseUrl.replace(/\/+$/, '');
}

/** 自检跑完后把标志写回缓存：评论页与课程页据此决定是否禁用入口。 */
export function applySelfCheck(report: SelfCheckReport): void {
  if (cached) cached.capabilities = report.flags;
}