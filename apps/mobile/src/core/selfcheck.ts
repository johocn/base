/**
 * 基座自检：把「平台能力是否可用」从推断变成一次装机就能读到的证据。
 *
 * 全部通过注入的适配器与窄平台接口访问平台能力，不 import 'uni' 全局，
 * 因此能在 Node 下用 core/fakes.ts 完整测试（与 core/update.ts 同一惯例）。
 */
import { keyPairFromSeed, randomBytes, sign, utf8, verify } from '@base/protocol-ts';

import type { Adapters, LocalDb } from '../platform/adapter';
import { base64ToBytes, bytesToBase64, plusRuntime } from '../platform/uni';
import { CommentError, sendComment } from './comment';
import type { LocalRepo } from './repo';
import { fetchReleaseDoc } from './update';

export type Capability = 'unknown' | 'ok' | 'fail';

export interface CapabilityFlags {
  cryptoOk: Capability;
  fsOk: Capability;
  dbOk: Capability;
  writeOk: Capability;
}

/** 未探测时的初值：`unknown` 不降级，功能照常尝试（spec §4）。 */
export const UNKNOWN_FLAGS: CapabilityFlags = {
  cryptoOk: 'unknown',
  fsOk: 'unknown',
  dbOk: 'unknown',
  writeOk: 'unknown',
};

export const FLAG_KEYS: Array<keyof CapabilityFlags> = ['cryptoOk', 'fsOk', 'dbOk', 'writeOk'];

export type CheckStatus = 'ok' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  group: string;
  name: string;
  affects: string;
  status: CheckStatus;
  detail: string;
}

export interface SelfCheckReport {
  at: string;
  degraded: boolean;
  items: CheckResult[];
  flags: CapabilityFlags;
}

/** 评论发表是否可用：**只有明确 fail 才拦**，unknown 与 ok 一律照常尝试（spec §4）。 */
export function canPostComment(flags: CapabilityFlags): boolean {
  return flags.cryptoOk !== 'fail' && flags.writeOk !== 'fail';
}

/** 评论发表被拦时的原位原因；可用时返回空串。详细原因在「设置 → 基座自检」。 */
export function postBlockedReason(flags: CapabilityFlags): string {
  if (flags.cryptoOk === 'fail') return '随机源不可用，无法发表评论（设置 → 基座自检 可看原因）';
  if (flags.writeOk === 'fail') return '节点未接受写入，无法发表评论（设置 → 基座自检 可看原因）';
  return '';
}

/** 课程页同步是否可用（同步必须把 pack 写到本地文件）。 */
export function canSync(flags: CapabilityFlags): boolean {
  return flags.fsOk !== 'fail';
}

/** 自检事件的 target_id：它进节点事件表，但不进任何客户端评论列表（spec §7）。 */
export const SELFCHECK_TARGET = 'selfcheck';

/** 探测上下文：与 AppContext 同源，页面负责组装（spec §2）。 */
export interface CheckContext {
  adapters: Adapters;
  repo: LocalRepo;
  db: LocalDb;
  nodeBaseUrl: string;
  workDir: string;
}

/** 平台句柄的窄接口：只用得到 `runtime.openURL`；测试传假对象即可。 */
export interface PlusHandle {
  runtime?: { version?: string; openURL?: (url: string) => void };
}

/** 前置条件不存在（如本地还没下载 pack）：标 skip，不计入标志。 */
export class ProbeSkip extends Error {}

interface ProbeBase {
  id: string;
  group: string;
  name: string;
  affects: string;
  /** 计入哪个能力标志；不填即不参与降级判定 */
  flag?: keyof CapabilityFlags;
}

/** 需要本地库与节点地址的条目：降级模式下不跑，直接标 fail。 */
interface LocalProbe extends ProbeBase {
  scope: 'local';
  run: (c: CheckContext, plus: PlusHandle | undefined) => Promise<string>;
}

/** 不依赖本地库的条目：降级模式下仍能跑。 */
interface StandaloneProbe extends ProbeBase {
  scope: 'standalone';
  run: (plus: PlusHandle | undefined) => Promise<string>;
}

type Probe = LocalProbe | StandaloneProbe;

const FIXED_SEED = '00'.repeat(32);
const PROBE_DIR = 'selfcheck';
const LOAD_DB_DOWN = '本地库不可用，未探测';
const RENDER_SEGMENTS = 800;
const B64_BYTES = 100 * 1024;

/** 12 条探测（spec §3）。顺序即自检页的展示顺序。 */
const PROBES: Probe[] = [
  {
    id: 'crypto.sqlite_random',
    group: '随机源',
    name: 'SQLite 随机源（randomblob）',
    affects: '发表评论、身份生成',
    flag: 'cryptoOk',
    scope: 'local',
    async run(c) {
      const rows = await c.db.select('SELECT hex(randomblob(32)) AS b');
      const hex = String(rows[0]?.b ?? '');
      // SQLite 的 hex() 输出**大写**（真机 randomblob(32) → 64 个大写字符）；此处只判形态，大小写都合法。
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`randomblob 返回异常（${hex.length} 字符）`);
      return '64 位 hex';
    },
  },
  {
    id: 'crypto.pool',
    group: '随机源',
    name: '随机池同步取数',
    affects: '发表评论、身份生成',
    flag: 'cryptoOk',
    scope: 'local',
    async run() {
      // 走真实链路：App 端 randomBytes 的兜底源就是启动预填的那个池
      const b = randomBytes(32);
      if (b.length !== 32) throw new Error(`取到 ${b.length} 字节，期望 32`);
      if (b.every((x) => x === 0)) throw new Error('取到全零字节');
      return '32 字节非全零';
    },
  },
  {
    id: 'crypto.sign',
    group: '随机源',
    name: 'ed25519 签名自洽',
    affects: '发表评论、升级验签',
    flag: 'cryptoOk',
    scope: 'standalone',
    async run() {
      // 固定种子：只验算法链路自洽，不消耗随机池（自检不能破坏被测对象）
      const kp = keyPairFromSeed(FIXED_SEED);
      const msg = utf8('selfcheck');
      if (!verify(kp.pubHex, msg, sign(FIXED_SEED, msg))) throw new Error('签名自验未通过');
      return '签名自验通过';
    },
  },
  {
    id: 'fs.bigfile',
    group: '文件/库',
    name: '大文件写读一致（1 MiB）',
    affects: '同步 pack、封面缓存',
    flag: 'fsOk',
    scope: 'local',
    async run(c) {
      const path = `${c.workDir}/${PROBE_DIR}/probe.bin`;
      // 不能用 randomBytes：App 端它会走随机池，1 MiB 会把池抽干
      const data = new Uint8Array(1 << 20);
      for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 8)) & 0xff;
      try {
        await c.adapters.fs.writeFile(path, data);
        const back = await c.adapters.fs.readFile(path);
        if (back.length !== data.length) throw new Error(`读回 ${back.length} 字节，写入 ${data.length} 字节`);
        for (let i = 0; i < data.length; i++) {
          if (back[i] !== data[i]) throw new Error(`第 ${i} 字节不符`);
        }
      } finally {
        await c.adapters.fs.remove(path);
      }
      return `${data.length} 字节读回一致`;
    },
  },
  {
    id: 'fs.meta',
    group: '文件/库',
    name: '文件元信息与删除',
    affects: '缓存清理、断点',
    flag: 'fsOk',
    scope: 'local',
    async run(c) {
      const path = `${c.workDir}/${PROBE_DIR}/meta.bin`;
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
      await c.adapters.fs.writeFile(path, data);
      try {
        if (!(await c.adapters.fs.exists(path))) throw new Error('写入后 exists 为假');
        const size = await c.adapters.fs.size(path);
        if (size !== data.length) throw new Error(`size 报 ${size}，写入 ${data.length}`);
      } finally {
        await c.adapters.fs.remove(path);
      }
      if (await c.adapters.fs.exists(path)) throw new Error('remove 后 exists 仍为真');
      return 'size / exists / remove 一致';
    },
  },
  {
    id: 'db.tx',
    group: '文件/库',
    name: '事务原子性（失败即回滚）',
    affects: 'applyPack 原子性',
    flag: 'dbOk',
    scope: 'local',
    async run(c) {
      await c.db.execute('CREATE TABLE IF NOT EXISTS selfcheck_probe(k TEXT)');
      const before = Number((await c.db.select('SELECT count(*) AS n FROM selfcheck_probe'))[0]?.n ?? 0);
      let failed = false;
      try {
        await c.db.tx([
          { sql: 'INSERT INTO selfcheck_probe(k) VALUES(?)', params: ['probe'] },
          { sql: 'INSERT INTO selfcheck_no_such_table(k) VALUES(?)', params: ['probe'] },
        ]);
      } catch {
        failed = true;
      }
      if (!failed) throw new Error('第二条语句本应失败，事务却成功了');
      const after = Number((await c.db.select('SELECT count(*) AS n FROM selfcheck_probe'))[0]?.n ?? 0);
      if (after !== before) throw new Error(`未回滚：行数 ${before} → ${after}`);
      return `回滚后行数不变（${before}）`;
    },
  },
  {
    id: 'db.pack',
    group: '文件/库',
    name: '已下载 pack 可只读打开',
    affects: '离线读书',
    flag: 'dbOk',
    scope: 'local',
    async run(c) {
      const packId = await c.repo.getConfig('pack_id');
      if (!packId) throw new ProbeSkip('本地尚无 pack（未同步过）');
      const path = `${c.workDir}/pack-${packId}.sqlite`;
      if (!(await c.adapters.fs.exists(path))) throw new ProbeSkip(`本地无 pack 文件 ${path}`);
      const conn = await c.adapters.packReader.open(path);
      let rows = 0;
      try {
        rows = Number((await conn.select('SELECT count(*) AS n FROM articles'))[0]?.n ?? 0);
      } finally {
        await c.adapters.packReader.close(conn);
      }
      return `articles ${rows} 行`;
    },
  },
  {
    id: 'net.tls_get',
    group: '网络',
    name: '节点读接口可访问',
    affects: '评论列表',
    scope: 'local',
    async run(c) {
      if (!c.nodeBaseUrl) throw new ProbeSkip('未配置节点地址');
      const res = await c.adapters.http.get(`${c.nodeBaseUrl}/v1/comment?limit=1`);
      if (res.status !== 200) throw new Error(`GET /v1/comment 返回 HTTP ${res.status}`);
      return 'HTTP 200';
    },
  },
  {
    id: 'net.release_verify',
    group: '网络',
    name: '升级文档拉取并验签',
    affects: '升级提示',
    scope: 'local',
    async run(c) {
      if (!c.nodeBaseUrl) throw new ProbeSkip('未配置节点地址');
      const pubHex = await c.repo.getConfig('pubkey_hex');
      if (!pubHex) throw new ProbeSkip('未配置节点公钥');
      const doc = await fetchReleaseDoc(c.adapters.http, c.nodeBaseUrl, pubHex);
      if (!doc) throw new Error('release 文档拉取或验签失败');
      return `version_name ${doc.payload.version_name}`;
    },
  },
  {
    id: 'net.event_write',
    group: '网络',
    name: '写入一条自检事件',
    affects: '发表评论',
    flag: 'writeOk',
    scope: 'local',
    async run(c) {
      if (!c.nodeBaseUrl) throw new ProbeSkip('未配置节点地址');
      // 走真实发送链路：身份 → 签名 → POST /v1/event，正是 0.4.1 修坏过的那条。
      // 用 sendComment（纯发送）而不是 postComment：探针不得把 selfcheck 事件写进用户待发队列。
      try {
        const r = await sendComment(
          { adapters: c.adapters, repo: c.repo, nodeBaseUrl: c.nodeBaseUrl },
          { targetId: SELFCHECK_TARGET, text: SELFCHECK_TARGET },
        );
        return `200 回执 event_id ${r.eventId.slice(0, 8)}`;
      } catch (e) {
        // 网络不可达 ≠ 内容不可写：判 skip（不计入 writeOk），否则离线时自检会禁掉离线入队本身（本册 §7）
        if (e instanceof CommentError && e.code === 'network') throw new ProbeSkip('节点不可达，未探测');
        throw e;
      }
    },
  },
  {
    id: 'net.open_url',
    group: '网络',
    name: '外部链接打开能力',
    affects: '升级下载',
    scope: 'standalone',
    async run(plus) {
      if (typeof plus?.runtime?.openURL !== 'function') throw new Error('plus.runtime.openURL 不存在');
      return 'plus.runtime.openURL 可用';
    },
  },
  {
    id: 'render.memory',
    group: '渲染',
    name: '长正文分段与 base64 往返',
    affects: '阅读器、封面',
    scope: 'standalone',
    async run() {
      const body = Array.from({ length: RENDER_SEGMENTS }, (_, i) => `p${i}${'x'.repeat(60)}`).join('\n\n');
      const segs = body.split('\n\n').length;
      if (segs !== RENDER_SEGMENTS) throw new Error(`分段数不符：${segs}`);
      const bin = new Uint8Array(B64_BYTES);
      for (let i = 0; i < bin.length; i++) bin[i] = (i * 31 + (i >> 8)) & 0xff;
      const back = base64ToBytes(bytesToBase64(bin));
      if (back.length !== bin.length) throw new Error(`base64 往返长度不符：${back.length} != ${bin.length}`);
      for (let i = 0; i < bin.length; i++) {
        if (back[i] !== bin[i]) throw new Error(`base64 往返第 ${i} 字节不符`);
      }
      return `${utf8(body).length} 字节正文分 ${segs} 段；${bin.length} 字节 base64 往返一致`;
    },
  },
];

export const DEFAULT_TIMEOUT_MS = 5000;

export interface SelfCheckOptions {
  /** 单条探测超时（毫秒），默认 5000：自签 TLS 挂死不能卡住整页 */
  timeoutMs?: number;
  /** plus 句柄；默认取 platform/uni 的 plusRuntime()，Node 测试传假对象 */
  plus?: PlusHandle | undefined;
}

class ProbeTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeout(`超时（>${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 把一次探测的成败收敛成一条结果：抛错即 fail，`ProbeSkip` 即 skip。 */
async function settle(
  base: Omit<CheckResult, 'status' | 'detail'>,
  work: () => Promise<string>,
  timeoutMs: number,
): Promise<CheckResult> {
  try {
    return { ...base, status: 'ok', detail: await withTimeout(work(), timeoutMs) };
  } catch (e) {
    if (e instanceof ProbeSkip) return { ...base, status: 'skip', detail: e.message };
    if (e instanceof ProbeTimeout) return { ...base, status: 'fail', detail: e.message };
    return { ...base, status: 'fail', detail: (e as Error).message ?? String(e) };
  }
}

/**
 * 跑一遍自检。
 *
 * `ctx` 为 null 即降级模式（bootstrap 失败）：只跑不依赖本地库的条目（3、11、12），
 * 其余标 fail 并写明原因——本地库坏了也要能出报告（spec §4）。
 */
export async function runSelfCheck(ctx: CheckContext | null, o: SelfCheckOptions = {}): Promise<SelfCheckReport> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const plus = 'plus' in o ? o.plus : plusRuntime();

  const items: CheckResult[] = [];
  for (const p of PROBES) {
    const base = { id: p.id, group: p.group, name: p.name, affects: p.affects };
    if (p.scope === 'standalone') {
      items.push(await settle(base, () => p.run(plus), timeoutMs));
    } else if (ctx === null) {
      items.push({ ...base, status: 'fail', detail: LOAD_DB_DOWN });
    } else {
      items.push(await settle(base, () => p.run(ctx, plus), timeoutMs));
    }
  }

  // 一个标志覆盖多条探测：任一条 fail → fail；skip 不影响；全部未跑 → 保持 unknown（spec §3）
  const byFlag: Record<keyof CapabilityFlags, CheckStatus[]> = {
    cryptoOk: [],
    fsOk: [],
    dbOk: [],
    writeOk: [],
  };
  PROBES.forEach((p, i) => {
    if (p.flag) byFlag[p.flag].push(items[i].status);
  });
  const flags: CapabilityFlags = { ...UNKNOWN_FLAGS };
  for (const key of FLAG_KEYS) {
    const st = byFlag[key].filter((s) => s !== 'skip');
    if (st.length === 0) continue;
    flags[key] = st.includes('fail') ? 'fail' : 'ok';
  }

  return { at: new Date().toISOString(), degraded: ctx === null, items, flags };
}