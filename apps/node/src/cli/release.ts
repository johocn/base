// release：用源节点私钥签发 release 升级文档（镜像 cmd/based/release.go:19-79，stdout 逐字对齐）。
// -apk-file 用于算 apk_size 与 apk_sha256，避免手填出错。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CliCommand } from "@base/core-ts";
import { canonicalize, keyPairFromSeed, sha256Hex, signRelease, type Json, type ReleasePayload } from "@base/protocol-ts";
import { parseFlags } from "./flags";

/** `time.Now().UTC().Format("2006-01-02T15:04:05Z")`（秒精度，无毫秒）。 */
function formatGoUTC(d: Date): string {
  return d.toISOString().slice(0, 19) + "Z";
}

export function createReleaseCommand(): CliCommand {
  return {
    name: "release",
    async run(args: string[]): Promise<number> {
      const { values } = parseFlags(args, [
        { name: "version-name", def: "" },
        { name: "min-version-name", def: "" },
        { name: "apk-url", def: "" },
        { name: "apk-file", def: "" },
        { name: "notes", def: "" },
        { name: "out", def: "" },
        { name: "data", def: process.env.BASE_DATA || "data" },
        { name: "issuer", def: process.env.BASE_ISSUER || "base-node-1" },
        { name: "sign-key", def: process.env.BASE_SIGN_KEY ?? "" },
      ]);

      const versionName = values["version-name"];
      const minVersionName = values["min-version-name"];
      const apkURL = values["apk-url"];
      const apkFile = values["apk-file"];
      if (versionName === "" || minVersionName === "" || apkURL === "" || apkFile === "") {
        throw new Error("release: -version-name、-min-version-name、-apk-url、-apk-file 均为必填");
      }
      const signKey = values["sign-key"];
      if (signKey === "") {
        throw new Error(
          "release: 缺少 -sign-key（或环境变量 BASE_SIGN_KEY）：没有私钥不能签发升级文档",
        );
      }

      let apkBytes: Buffer;
      try {
        apkBytes = readFileSync(apkFile);
      } catch (err) {
        throw new Error(`release: 读取 APK 失败: ${String(err)}`);
      }
      const size = apkBytes.length;
      const sum = sha256Hex(new Uint8Array(apkBytes));

      const payload: ReleasePayload = {
        schema_version: 1,
        issuer: values.issuer,
        issued_at: formatGoUTC(new Date()),
        version_name: versionName,
        min_version_name: minVersionName,
        apk_url: apkURL,
        apk_size: size,
        apk_sha256: sum,
        notes: values.notes,
      };
      const doc = signRelease(payload, signKey);

      const path = values.out === "" ? join(values.data, "release.json") : values.out;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(canonicalize(doc as unknown as Json), "utf8"));

      const kp = keyPairFromSeed(signKey);
      process.stdout.write(
        `release: version_name=${versionName} min_version_name=${minVersionName} → ${path}\n`,
      );
      process.stdout.write(`  apk_size=${size} apk_sha256=${sum}\n`);
      process.stdout.write(`  public_key   ${kp.pubHex}\n`);
      return 0;
    },
  };
}
