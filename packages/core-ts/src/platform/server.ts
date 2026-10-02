// 服务端侧适配层：与客户端 Adapters 独立的一组能力接口（监听/路由、TLS、定时、CLI、进程信号）。
// 纯类型声明，零 `node:` 依赖；实现归各节点壳（P2 = apps/node）。
// 接口于 P2 一次冻结（依据路线计划 #70 §3.2 / 任务级计划 #72 §2.2）；
// P3 首批（计划 #73 §3.1）只做一处复议：TlsConfig 补上对端指纹白名单与「信任由指纹承担」，
// 以承载 Go `ServerTLSConfig` / `ClientTLSConfig` 的两项策略。此后这组边界为终态。

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

/**
 * TLS 配置描述符：Go `*tls.Config` 的可断言形状（P3 二次冻结，之后不得再改）。
 * - `peerFingerprints` 非空 ⇒ 要求对端提供证书，且其 DER 的 sha256 命中白名单
 *   （服务端 = RequireAnyClientCert + 指纹固定；出站 = 单元素白名单）
 * - `trustPeerByFingerprint` ⇒ 对端证书**不**由系统 CA 校验，信任完全由 `peerFingerprints` 承担
 */
export interface TlsConfig extends TlsMaterial {
  peerFingerprints: string[];
  trustPeerByFingerprint: boolean;
}

export interface ListenOptions {
  host: string;
  port: number;
  tls?: TlsConfig;
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
  /** 非空白名单 ⇒ 双向 TLS（要求对端证书并固定指纹） */
  serverConfig(info: TlsInfo, peerFingerprints: string[]): TlsConfig;
  /** 出站：信任由对端指纹固定承担，不受系统 CA 约束 */
  clientConfig(own: TlsInfo, peerFingerprintHex: string): TlsConfig;
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
