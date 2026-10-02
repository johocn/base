// export：把内容库导成一个内容包（镜像 cmd/based/export.go，stdout 逐字对齐）。
// 装配纯算法在 `@base/core-ts` 的 buildPack；本文件负责读库、序号自增、落盘与打印。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliCommand, MediaMeta, StoreSegment } from "@base/core-ts";
import { buildPack } from "@base/core-ts";
import { canonicalize, keyPairFromSeed, sha256Hex, type Json, type Manifest } from "@base/protocol-ts";
import { writePackSQLite } from "../host/packsqlite";
import { openStore } from "../store/store";
import { parseFlags } from "./flags";

/** `time.Now().UTC().Format("2006-01-02T15:04:05Z")`（秒精度，无毫秒）。 */
function formatGoUTC(d: Date): string {
  return d.toISOString().slice(0, 19) + "Z";
}

export function createExportCommand(): CliCommand {
  return {
    name: "export",
    async run(args: string[]): Promise<number> {
      const { values, rest } = parseFlags(args, [
        { name: "data", def: "data" },
        { name: "sign-key", def: process.env.BASE_SIGN_KEY ?? "" },
        { name: "issuer", def: process.env.BASE_ISSUER || "base-node-1" },
        { name: "issued-at", def: "" },
      ]);
      if (rest.length > 0) throw new Error(`未知参数 "${rest[0]}"`);

      const signKey = values["sign-key"];
      if (signKey === "") {
        throw new Error(
          "export: 缺少 -sign-key（或环境变量 BASE_SIGN_KEY）：没有私钥不能签发内容包",
        );
      }
      let issuedAt: string;
      if (values["issued-at"] !== "") {
        const t = new Date(values["issued-at"]);
        if (Number.isNaN(t.getTime())) {
          throw new Error(`export: -issued-at 解析失败: 无法解析 ${values["issued-at"]}`);
        }
        issuedAt = formatGoUTC(t);
      } else {
        issuedAt = formatGoUTC(new Date());
      }

      const store = openStore(values.data);
      try {
        const version = store.bumpContentVersion();
        const items = store.listItems("active");

        const segments: Record<string, StoreSegment[]> = {};
        const mediaMeta: Record<string, MediaMeta | null> = {};
        for (const it of items) {
          if (it.sqliteTable === "segments") segments[it.itemId] = store.listSegments(it.itemId);
          if (it.sqliteTable === "media_meta") mediaMeta[it.itemId] = store.getMediaMeta(it.itemId);
        }

        const result = buildPack({
          issuer: values.issuer,
          signKeyHex: signKey,
          version,
          issuedAt,
          items,
          articles: store.listArticles(),
          quizzes: store.listQuizzes(),
          segments,
          mediaMeta,
          identities: store.lookupIdentities(),
          tombstones: store.listTombstones(),
        });

        const packDir = join(store.packsDir(), result.packId);
        mkdirSync(packDir, { recursive: true });
        const packPath = join(packDir, "pack.sqlite");
        writePackSQLite(packPath, result.rows);
        const packBytes = new Uint8Array(readFileSync(packPath));

        const manifestBytes = new Uint8Array(
          Buffer.from(canonicalize(result.manifest as unknown as Json), "utf8"),
        );
        const manifestPath = join(packDir, "manifest.json");
        writeFileSync(manifestPath, manifestBytes);

        store.insertPack({
          packId: result.packId,
          contentVersion: version,
          dir: packDir,
          merkleRoot: result.merkleRoot,
          signature: (result.manifest as Manifest).signature,
          issuedAt,
          itemCount: result.entries.length,
          createdAt: "",
        });

        const kp = keyPairFromSeed(signKey);
        process.stdout.write(
          `export: pack_id=${result.packId} content_version=${version} entries=${result.entries.length} merkle_root=${result.merkleRoot}\n`,
        );
        process.stdout.write(
          `  pack.sqlite  ${packPath}  sha256=${sha256Hex(packBytes)}\n`,
        );
        process.stdout.write(
          `  manifest.json ${manifestPath}  sha256=${sha256Hex(manifestBytes)}\n`,
        );
        process.stdout.write(`  public_key   ${kp.pubHex}\n`);
        return 0;
      } finally {
        store.close();
      }
    },
  };
}
