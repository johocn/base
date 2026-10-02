import type { Listener, ServerAdapters, TlsMaterial } from "@base/core-ts";
import type { Db } from "./db";
import { healthzHandler } from "./routes/healthz";
import { catalogHandler } from "./routes/catalog";

export async function startServer(
  adapters: ServerAdapters,
  db: Db,
  opts: { host: string; port: number; tls?: TlsMaterial },
): Promise<Listener> {
  adapters.http.handle("GET /healthz", healthzHandler);
  adapters.http.handle("GET /v1/catalog", catalogHandler(db));
  const listener = await adapters.http.listen(opts);
  adapters.lifecycle.onShutdown(() => listener.close());
  return listener;
}
