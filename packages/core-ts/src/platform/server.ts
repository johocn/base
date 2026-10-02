// 服务端侧适配层：与客户端 Adapters 独立的一组能力接口（监听/路由、TLS、定时、CLI、进程信号）。
// 纯类型声明，零 `node:` 依赖；实现归各节点壳（P2 = apps/node）。
// 接口于 P2 一次冻结（依据路线计划 #70 §3.2 / 任务级计划 #72 §2.2）；P3 起不得再改这组边界。

export interface ServerRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface ServerResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

export type ServerHandler = (req: ServerRequest) => Promise<ServerResponse>;

/** 1. 监听 / 路由 */
export interface Listener {
  addr(): string;
  close(): Promise<void>;
}

export interface TlsMaterial {
  certFile: string;
  keyFile: string;
}

export interface ListenOptions {
  host: string;
  port: number;
  tls?: TlsMaterial;
}

export interface HttpServerAdapter {
  /** pattern 沿用 Go http.ServeMux 体例："GET /v1/catalog"、"GET /v1/manifest/{pack_id}"、"GET /a/{item_id...}" */
  handle(pattern: string, handler: ServerHandler): void;
  listen(opts: ListenOptions): Promise<Listener>;
}

/** 2. TLS / 指纹固定 / X-Base-Node-Key（镜像 internal/httpapi/tlscfg.go） */
export interface TlsInfo extends TlsMaterial {
  fingerprintHex: string;
  pairingCode: string;
}

export interface TlsAdapter {
  loadOrCreate(info: TlsMaterial): Promise<TlsInfo>;
  serverConfig(info: TlsInfo, peerFingerprints: string[]): TlsMaterial;
  clientConfig(own: TlsInfo, peerFingerprintHex: string): TlsMaterial;
  /** 空名单 = 拒绝一切（fail-closed） */
  verifyPeer(rawCertsDer: Uint8Array[], allowed: string[]): void;
  /** 常量时间比较 */
  nodeKeyMatches(want: string, got: string): boolean;
}

/** 3. 定时调度（镜像 cmd/based/scrub.go 的 ScrubForever） */
export interface ScheduledHandle {
  cancel(): void;
}

export interface SchedulerAdapter {
  every(intervalMs: number, fn: () => Promise<void>): ScheduledHandle;
}

/** 4. CLI 子命令（镜像 cmd/based/main.go 的分发表） */
export interface CliCommand {
  name: string;
  run(args: string[]): Promise<number>;
}

export interface CliHost {
  register(cmd: CliCommand): void;
  run(argv: string[]): Promise<number>;
}

/** 5. 进程信号 / 优雅停机（镜像 cmd/based/serve.go） */
export interface LifecycleAdapter {
  /** SIGINT/SIGTERM 时按注册逆序执行 */
  onShutdown(fn: () => Promise<void>): void;
  exit(code: number): void;
}

export interface ServerAdapters {
  http: HttpServerAdapter;
  tls: TlsAdapter;
  scheduler: SchedulerAdapter;
  cli: CliHost;
  lifecycle: LifecycleAdapter;
}
