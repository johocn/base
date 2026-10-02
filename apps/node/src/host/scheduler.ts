// SchedulerAdapter：镜像 cmd/based/scrub.go 的 ScrubForever（立即跑一次 + 周期跑）。
import type { SchedulerAdapter } from "@base/core-ts";

export function createSchedulerAdapter(): SchedulerAdapter {
  return {
    every(intervalMs, fn) {
      const run = (): void => {
        void Promise.resolve().then(fn).catch(() => {});
      };
      run();
      const timer = setInterval(run, intervalMs);
      return {
        cancel() {
          clearInterval(timer);
        },
      };
    },
  };
}
