// 逐字对齐 internal/httpapi/public.go 的 handleHealthz + writeJSON。
import type { ServerHandler } from "@base/core-ts";
import { VERSION } from "../version";

const encoder = new TextEncoder();

export const healthzHandler: ServerHandler = async () => ({
  status: 200,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  },
  body: encoder.encode(`{"ok":true,"version":"${VERSION}"}\n`),
});
