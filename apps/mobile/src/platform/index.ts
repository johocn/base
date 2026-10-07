import { hexToBytes } from '@base/protocol-ts';

import { purgeIllegalContainers } from '../core/course-edit';
import { ENTROPY_FILL_BYTES, installRandomFallback } from '../core/entropy';
import { SCHEMA_SQL, SqlRepo, ensureBlobColumns, ensureGroupColumns, ensureItemsColumns, ensureProgressColumns, ensureSubmissionColumns, type LocalRepo } from '../core/repo';
import { UNKNOWN_FLAGS, type CapabilityFlags, type SelfCheckReport } from '../core/selfcheck';
import type { SyncOptions } from '../core/sync';
import type { Adapters, LocalDb } from './adapter';
import { h5Adapters, SqlJsLocalDb } from './browser';
import { PlusFs, PlusHttp, PlusLocalDb, PlusPackReader, PlusStorage, pickHandle, plusRuntime } from './uni';

export interface AppContext {
  opts: SyncOptions;
  repo: LocalRepo;
  db: LocalDb;
  /** 平台能力标志：只有明确 fail 才降级，unknown 与 ok 都照常尝试（selfcheck spec §4） */
  capabilities: CapabilityFlags;
  /** 'app' 有 plus runtime；'h5' 走 BrowserAdapter */
  platform: 'app' | 'h5';
}

let cached: AppContext | null = null;

/** H5 bootstrap：sql.js（WASM SQLite）+ localStorage + fetch()。 */
async function h5Bootstrap(): Promise<AppContext> {
  const db = new SqlJsLocalDb();
  for (const sql of SCHEMA_SQL) await db.execute(sql);
  await ensureGroupColumns(db);
  await ensureItemsColumns(db);
  await ensureSubmissionColumns(db);
  await ensureProgressColumns(db);
  await ensureBlobColumns(db);

  const repo = new SqlRepo(db);
  const adapters = h5Adapters();
  const root = await adapters.fs.rootDir();
  const nodeBaseUrl = ((await repo.getConfig('node_base_url')) ?? '').replace(/\/+$/, '');

  // H5 没有 pickOk —— 原生 <input type="file"> 在 pickLocalFile() 里动态创建，
  // 这里只把能力标志设为 ok（页面据此不阻塞入口）
  const capabilities: CapabilityFlags = { ...UNKNOWN_FLAGS, pickOk: 'ok' };

  // sql.js 没有 randomblob，跳过 crypto 预填
  capabilities.cryptoOk = 'fail';

  cached = { repo, db, opts: { adapters, repo, nodeBaseUrl, workDir: root }, capabilities, platform: 'h5' };
  return cached;
}

/** App bootstrap：plus.io + plus.sqlite + uni.request（原有逻辑）。 */
async function appBootstrap(): Promise<AppContext> {
  const p = plusRuntime()!;
  const fs = new PlusFs(p);
  const root = await fs.rootDir();
  await fs.ensureDir(root);

  const db = new PlusLocalDb(p, `${root}/base.db`);
  for (const sql of SCHEMA_SQL) await db.execute(sql);
  await ensureGroupColumns(db);
  await ensureItemsColumns(db);
  await ensureSubmissionColumns(db);
  await ensureProgressColumns(db);
  await ensureBlobColumns(db);

  const capabilities: CapabilityFlags = { ...UNKNOWN_FLAGS };

  try {
    await installRandomFallback(async () => {
      const rows = await db.select(`SELECT hex(randomblob(${ENTROPY_FILL_BYTES})) AS b`);
      return hexToBytes(String(rows[0]?.b ?? ''));
    });
    capabilities.cryptoOk = 'ok';
  } catch {
    capabilities.cryptoOk = 'fail';
  }

  const pick = pickHandle();
  capabilities.pickOk = typeof pick.chooseFile === 'function' || typeof pick.chooseImage === 'function' ? 'ok' : 'fail';

  const repo = new SqlRepo(db);
  const adapters: Adapters = {
    fs,
    storage: new PlusStorage(),
    http: new PlusHttp(),
    packReader: new PlusPackReader(p),
  };
  const nodeBaseUrl = ((await repo.getConfig('node_base_url')) ?? '').replace(/\/+$/, '');
  cached = { repo, db, opts: { adapters, repo, nodeBaseUrl, workDir: root }, capabilities, platform: 'app' };
  return cached;
}

/** 建表 + 组装适配器；重复调用复用同一实例。 */
export async function bootstrap(): Promise<AppContext> {
  if (cached) return cached;
  const ctx = plusRuntime() !== undefined ? await appBootstrap() : await h5Bootstrap();
  // 一次性清理编码态孤儿容器行（#80 §3.3）：先于任何列表页读到脏行；失败不阻塞启动，下次启动重试
  try {
    await purgeIllegalContainers(ctx.repo);
  } catch {
    // 清理失败不阻塞启动
  }
  return ctx;
}

/** 节点地址保存后刷新缓存里的 baseUrl */
export function updateNodeBaseUrl(baseUrl: string): void {
  if (cached) cached.opts.nodeBaseUrl = baseUrl.replace(/\/+$/, '');
}

/** 自检跑完后把标志写回缓存：评论页与课程页据此决定是否禁用入口。 */
export function applySelfCheck(report: SelfCheckReport): void {
  if (cached) cached.capabilities = report.flags;
}
