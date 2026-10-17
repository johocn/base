// 近场分发服务端（spec §3.2）：手写 HTTP 最小子集，跑在 plus.android 非阻塞
// ServerSocketChannel 上，单线程 setInterval 轮询。
//
// NIO 三铁律（spike 定案，nearby-spike.vue 逐字沿用）：
//   ① accept() 空转返回 null 属 Java 语义，静默；单线程 setInterval 200ms 轮询；
//   ② plus bridge 的 Java 方法返回对象必须先 importClass 对应类再调用；
//   ③ close() 前必须排空入站（未读数据触发 RST 毁掉已写响应，spike 的 curl 56 教训）。
//
// 响应三要素：Connection: close + Content-Length + Range 单区间（206 + Content-Range）。
// probe=1：只回 200/404 空 body（HEAD 语义执行期定案 5 的等价替代）。
// token 校验覆盖全部路由：query.token 不符 → 403；同远端 5 次失败锁 600s；总并发连接上限 8。

import { decodeUtf8 } from '../core/sync';

/** spike 同款取 plus 引用（platform/uni 的 plusRuntime 类型不含 android 桥）。 */
function plusAny(): any {
  return (globalThis as any).plus;
}

/** 近场固定端口（spec §3.2）。 */
export const MESH_PORT = 8712;

export interface MeshRouteCtx {
  method: string;
  /** 路径（含 blob 场景的 id 段，如 /mesh/v1/blob/<id>，由 handler 自行解析）。 */
  path: string;
  query: Record<string, string>;
  body: Uint8Array;
}

export interface MeshRouteResult {
  status: number;
  body: Uint8Array;
  contentType?: string;
}

/** handler 允许 async（源端页要 await repo 读写）。 */
export type MeshRouteHandler = (
  ctx: MeshRouteCtx,
) => MeshRouteResult | null | Promise<MeshRouteResult | null>;

export interface MeshServerOpts {
  /** 传函数可在 token 续签时无需重启 server。 */
  token: string | (() => string);
  onLog?: (msg: string) => void;
  /** 连接数变化回调（源端页状态区）。 */
  onStats?: (stats: { activeConns: number }) => void;
  maxConns?: number;
}

export interface MeshServerHandle {
  stop(): void;
}

const POLL_MS = 200;
const MAX_CONNS = 8;
const MAX_FAILS = 5;
const LOCK_MS = 600_000;
/** 请求头区上限：超过仍未出现 \r\n\r\n 直接断（不用回错）。 */
const MAX_HEADER_BYTES = 8 * 1024;
/** 单请求 body 上限（gossip 批量 JSON，远小于块体积）。 */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** 非阻塞写连续 0 返回的放弃阈值。 */
const MAX_WRITE_SPINS = 2000;

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  204: 'No Content',
  206: 'Partial Content',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  416: 'Range Not Satisfiable',
  500: 'Internal Server Error',
};

interface PendingConn {
  ch: any;
  chunks: Uint8Array[];
  size: number;
  dead: boolean;
}

interface FailState {
  fails: number;
  lockedUntil: number;
}

/** token 比较：长度不泄露、逐位异或吸收差异（局域网明文场景的最低限度防护）。 */
function tokenEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseQuery(qs: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!qs) return out;
  for (const part of qs.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? '' : part.slice(i + 1);
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** 返回 \r\n\r\n 起始下标；未找到 -1。 */
function findHeaderEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

interface ParsedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  bodyStart: number;
}

/** 只解析 GET/POST/HEAD；request line/头区畸形返回 null（调用方排空后直接 close，不回错）。 */
function parseRequest(bytes: Uint8Array, headerEnd: number): ParsedRequest | null {
  let headText: string;
  try {
    headText = decodeUtf8(bytes.subarray(0, headerEnd));
  } catch {
    return null;
  }
  const lines = headText.split('\r\n');
  const reqLine = lines[0] ?? '';
  const sp1 = reqLine.indexOf(' ');
  const sp2 = reqLine.lastIndexOf(' ');
  if (sp1 <= 0 || sp2 <= sp1) return null;
  const method = reqLine.slice(0, sp1).toUpperCase();
  if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') return null;
  const target = reqLine.slice(sp1 + 1, sp2);
  const qIdx = target.indexOf('?');
  const path = qIdx < 0 ? target : target.slice(0, qIdx);
  if (!path.startsWith('/')) return null;
  const query = parseQuery(qIdx < 0 ? '' : target.slice(qIdx + 1));
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c <= 0) continue;
    headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
  }
  return { method, path, query, headers, bodyStart: headerEnd + 4 };
}

/** Range: bytes=start-end 单区间（总纲 §8.1 断点续传）；不合法/越界返回 null（按 200 全量回）。 */
function parseRange(header: string | undefined, total: number): { start: number; end: number } | null {
  if (!header || total <= 0) return null;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const start = Number(m[1]);
  if (!Number.isSafeInteger(start) || start >= total) return null;
  let end = m[2] === '' ? total - 1 : Number(m[2]);
  if (!Number.isSafeInteger(end) || end >= total) end = total - 1;
  if (end < start) return null;
  return { start, end };
}

/** 每字节一字符的 latin1 串 → JString.getBytes('ISO-8859-1') 一对一还原 byte[]（二进制安全写回路径）。 */
function bytesToLatin1(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return out;
}

export function startMeshServer(handlers: Record<string, MeshRouteHandler>, opts: MeshServerOpts): MeshServerHandle {
  const plus = plusAny();
  if (!plus?.android) {
    throw new Error('近场服务需要 Android 真机（plus.android）');
  }
  const log = opts.onLog ?? (() => {});
  const maxConns = opts.maxConns ?? MAX_CONNS;
  const currentToken = (): string => (typeof opts.token === 'function' ? opts.token() : opts.token);

  // 铁律②：所有 Java 类先 importClass
  try {
    // permitNetwork 保险（本地局域网 socket 不走StrictMode网络检查）；失败不阻断
    const StrictMode = plus.android.importClass('android.os.StrictMode') as any;
    const policy = new StrictMode.ThreadPolicy.Builder().permitNetwork().build();
    StrictMode.setThreadPolicy(policy);
  } catch {
    /* 老内核忽略 */
  }
  plus.android.importClass('java.nio.channels.ServerSocketChannel');
  plus.android.importClass('java.nio.channels.SocketChannel');
  plus.android.importClass('java.nio.ByteBuffer');
  plus.android.importClass('java.net.InetSocketAddress');
  plus.android.importClass('java.lang.String');
  const SCh = plus.android.importClass('java.nio.channels.ServerSocketChannel') as any;
  const BB = plus.android.importClass('java.nio.ByteBuffer') as any;
  const ISA = plus.android.importClass('java.net.InetSocketAddress') as any;
  const JString = plus.android.importClass('java.lang.String') as any;

  let stopped = false;
  let busy = false;
  let ssc: any = null;
  let activeConns = 0;
  const pending: PendingConn[] = [];
  const fails = new Map<string, FailState>();
  const rxBuf = BB.allocate(8192);

  const notifyStats = (): void => opts.onStats?.({ activeConns });

  function closeConn(ch: any): void {
    try {
      ch.close();
    } catch {
      /* 已关 */
    }
  }

  function remoteKeyOf(ch: any): string {
    try {
      const s = String(ch.getRemoteAddress() ?? '');
      const cut = s.lastIndexOf(':');
      return cut > 0 ? s.slice(0, cut) : s;
    } catch {
      return ''; // 异常降级：并入全局计数桶
    }
  }

  /** 非阻塞写可能部分写入：循环写净；连续 0 返回达阈值则放弃（对端收不全即视为失败）。 */
  function writeAll(ch: any, jbytes: any): void {
    const buf = BB.wrap(jbytes);
    for (let spin = 0; buf.hasRemaining() && spin < MAX_WRITE_SPINS; spin++) {
      ch.write(buf);
    }
  }

  function sendResponse(ch: any, status: number, body: Uint8Array, contentType: string, extraHeaders?: string[]): void {
    const reason = STATUS_TEXT[status] ?? 'OK';
    let head = `HTTP/1.1 ${status} ${reason}\r\nContent-Type: ${contentType}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n`;
    for (const h of extraHeaders ?? []) head += `${h}\r\n`;
    head += '\r\n';
    writeAll(ch, new JString(head).getBytes('UTF-8'));
    if (body.length > 0) {
      // 二进制安全：latin1 字符串 → ISO-8859-1 byte[]（每字节无损）
      writeAll(ch, new JString(bytesToLatin1(body)).getBytes('ISO-8859-1'));
    }
  }

  function findHandler(method: string, path: string): MeshRouteHandler | null {
    const exact = handlers[`${method} ${path}`];
    if (exact) return exact;
    let bestKey: string | null = null;
    for (const key of Object.keys(handlers)) {
      const sp = key.indexOf(' ');
      if (sp < 0 || key.slice(0, sp) !== method) continue;
      const kp = key.slice(sp + 1);
      if (!kp.endsWith('/') || !path.startsWith(kp)) continue;
      if (bestKey === null || kp.length > bestKey.length) bestKey = key;
    }
    return bestKey === null ? null : handlers[bestKey] ?? null;
  }

  async function dispatchAndClose(entry: PendingConn, req: ParsedRequest): Promise<void> {
    const { ch } = entry;
    try {
      const key = remoteKeyOf(ch);
      // 失败锁：同远端 5 次失败锁 600s（key 异常时并入全局 "" 桶）
      const state = fails.get(key);
      const now = Date.now();
      if (state && state.lockedUntil > now) {
        sendResponse(ch, 403, new Uint8Array(0), 'application/json');
        log(`403 locked: ${key || 'unknown'}`);
        return;
      }
      if (!tokenEquals(req.query.token ?? '', currentToken())) {
        const st = fails.get(key) ?? { fails: 0, lockedUntil: 0 };
        st.fails += 1;
        if (st.fails >= MAX_FAILS) {
          st.lockedUntil = now + LOCK_MS;
          st.fails = 0;
        }
        fails.set(key, st);
        sendResponse(ch, 403, new Uint8Array(0), 'application/json');
        log(`403 token 不符: ${key || 'unknown'}`);
        return;
      }
      fails.delete(key);

      const handler = findHandler(req.method, req.path);
      const result = handler ? await handler({ method: req.method, path: req.path, query: req.query, body: bytesUntil(req, entry) }) : null;

      // probe=1：只回 200/404 空 body（HEAD 语义执行期定案 5）
      if (req.query.probe === '1') {
        const status = result && result.status === 200 ? 200 : 404;
        sendResponse(ch, status, new Uint8Array(0), 'application/json');
        return;
      }
      if (!result) {
        sendResponse(ch, 404, new Uint8Array(0), 'application/json');
        return;
      }

      let status = result.status;
      let body = result.body;
      const extra: string[] = [];
      if (req.method === 'GET' && status === 200) {
        const range = parseRange(req.headers.range, body.length);
        if (range) {
          body = body.subarray(range.start, range.end + 1);
          status = 206;
          extra.push(`Content-Range: bytes ${range.start}-${range.end}/${result.body.length}`);
        }
      }
      sendResponse(ch, status, body, result.contentType ?? 'application/json');
    } catch (err) {
      log(`serve 异常: ${String(err)}`);
      try {
        sendResponse(ch, 500, new Uint8Array(0), 'application/json');
      } catch {
        /* 连接可能已死 */
      }
    } finally {
      // 铁律③：close 前排空入站（一次即可，未读数据触发 RST 会毁掉已写响应）
      try {
        rxBuf.clear();
        ch.read(rxBuf);
      } catch {
        /* 已断 */
      }
      closeConn(ch);
      activeConns -= 1;
      notifyStats();
    }
  }

  function bytesUntil(req: ParsedRequest, entry: PendingConn): Uint8Array {
    const need = req.bodyStart + contentLengthOf(req);
    return concatChunks(entry.chunks, Math.min(entry.size, need)).subarray(req.bodyStart);
  }

  function contentLengthOf(req: ParsedRequest): number {
    const n = Number.parseInt(req.headers['content-length'] ?? '0', 10);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }

  function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      if (off >= total) break;
      const take = Math.min(c.length, total - off);
      out.set(c.subarray(0, take), off);
      off += take;
    }
    return out;
  }

  /** 推进一步读取；返回 'done'（已派发）/ 'wait'（继续等）/ 'dead'（连接作废）。 */
  function step(entry: PendingConn): 'done' | 'wait' | 'dead' {
    if (entry.dead) return 'dead';
    try {
      for (;;) {
        rxBuf.clear();
        const n = entry.ch.read(rxBuf);
        if (n === null || n === undefined || n < 0) {
          entry.dead = true;
          return 'dead';
        }
        if (n === 0) break;
        const arr = rxBuf.array() as number[];
        const chunk = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          const v = arr[i] ?? 0;
          chunk[i] = v < 0 ? v + 256 : v;
        }
        entry.chunks.push(chunk);
        entry.size += n;
        if (entry.size > MAX_BODY_BYTES + MAX_HEADER_BYTES) {
          entry.dead = true;
          return 'dead';
        }
      }
      const headerEnd = findHeaderEnd(concatChunks(entry.chunks, entry.size));
      if (headerEnd < 0) {
        if (entry.size > MAX_HEADER_BYTES) {
          entry.dead = true;
          return 'dead';
        }
        return 'wait';
      }
      const req = parseRequest(concatChunks(entry.chunks, entry.size), headerEnd);
      if (!req) {
        // 解析失败：排空入站后直接 close，不回错
        entry.dead = true;
        try {
          rxBuf.clear();
          entry.ch.read(rxBuf);
        } catch {
          /* 忽略 */
        }
        return 'dead';
      }
      const need = req.bodyStart + contentLengthOf(req);
      if (entry.size < need) return 'wait';
      void dispatchAndClose(entry, req).catch((err) => log(`dispatch 异常: ${String(err)}`));
      return 'done';
    } catch (err) {
      log(`read 异常: ${String(err)}`);
      entry.dead = true;
      return 'dead';
    }
  }

  function poll(): void {
    if (stopped || busy) return;
    busy = true;
    try {
      // 先推进未读完的连接
      for (let i = pending.length - 1; i >= 0; i--) {
        const entry = pending[i]!;
        const st = step(entry);
        if (st !== 'wait') {
          pending.splice(i, 1);
          if (st === 'dead') {
            closeConn(entry.ch);
            activeConns -= 1;
            notifyStats();
          }
        }
      }
      if (!ssc) return;
      // 铁律①：accept() 返回 null = 暂无连接，静默
      for (;;) {
        const ch = ssc.accept();
        if (!ch) break;
        if (activeConns >= maxConns) {
          closeConn(ch);
          log('并发上限，拒绝连接');
          continue;
        }
        try {
          ch.configureBlocking(false);
        } catch {
          /* 老内核降级：阻塞模式下 read 立即有数据可用 */
        }
        activeConns += 1;
        notifyStats();
        const entry: PendingConn = { ch, chunks: [], size: 0, dead: false };
        const st = step(entry);
        if (st === 'wait') pending.push(entry);
        else if (st === 'dead') {
          closeConn(entry.ch);
          activeConns -= 1;
          notifyStats();
        }
      }
    } catch (err) {
      log(`poll 异常: ${String(err)}`);
    } finally {
      busy = false;
    }
  }

  try {
    ssc = SCh.open();
    ssc.configureBlocking(false);
    ssc.bind(new ISA(MESH_PORT));
  } catch (err) {
    throw new Error(`近场服务启动失败（端口 ${MESH_PORT} 可能被占用）: ${String(err)}`);
  }

  const timer = setInterval(poll, POLL_MS);

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
      for (const entry of pending.splice(0, pending.length)) {
        closeConn(entry.ch);
        activeConns -= 1;
      }
      if (ssc) {
        try {
          ssc.close();
        } catch {
          /* 已关 */
        }
        ssc = null;
      }
      fails.clear();
      notifyStats();
    },
  };
}
