// LifecycleAdapter：SIGINT/SIGTERM 时按注册逆序优雅停机（镜像 cmd/based/serve.go）。
import type { LifecycleAdapter } from "@base/core-ts";

export function createLifecycleAdapter(): LifecycleAdapter {
  const hooks: (() => Promise<void>)[] = [];
  let installed = false;

  const shutdown = async (): Promise<void> => {
    for (let i = hooks.length - 1; i >= 0; i--) {
      try {
        await (hooks[i] as () => Promise<void>)();
      } catch {
        // 单个停机钩子失败不阻断其余
      }
    }
    process.exit(0);
  };

  return {
    onShutdown(fn: () => Promise<void>): void {
      hooks.push(fn);
      if (installed) return;
      installed = true;
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
    },
    exit(code: number): void {
      process.exit(code);
    },
  };
}
