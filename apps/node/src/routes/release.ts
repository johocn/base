// 逐行对齐 internal/httpapi/release.go 的 handleRelease（:14-27）。
import { join } from "node:path";
import type { ServerHandler } from "@base/core-ts";
import { fileResponse, jsonResponse } from "./json";

export function releaseHandler(deps: { dataDir?: string }): ServerHandler {
  return async () => {
    if (deps.dataDir === undefined || deps.dataDir === "") {
      return jsonResponse(404, { error: "本节点无升级信息" });
    }
    return fileResponse(
      join(deps.dataDir, "release.json"),
      "application/json; charset=utf-8",
      false,
      "本节点无升级信息",
    );
  };
}
