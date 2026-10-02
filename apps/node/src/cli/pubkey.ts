// pubkey：打印签发方标识与对应公钥（镜像 cmd/based/pubkey.go，stdout 逐字对齐）。
import type { CliCommand } from "@base/core-ts";
import { keyPairFromSeed } from "@base/protocol-ts";
import { parseFlags } from "./flags";

export function createPubkeyCommand(): CliCommand {
  return {
    name: "pubkey",
    async run(args: string[]): Promise<number> {
      const { values } = parseFlags(args, [
        { name: "issuer", def: process.env.BASE_ISSUER || "base-node-1" },
        { name: "sign-key", def: process.env.BASE_SIGN_KEY ?? "" },
      ]);
      const signKey = values["sign-key"];
      if (signKey === "") {
        throw new Error("pubkey: 缺少 -sign-key（或环境变量 BASE_SIGN_KEY）");
      }
      const kp = keyPairFromSeed(signKey);
      process.stdout.write(`issuer=${values.issuer}\n`);
      process.stdout.write(`public_key_hex=${kp.pubHex}\n`);
      return 0;
    },
  };
}
