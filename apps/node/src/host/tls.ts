// TlsAdapter：指纹固定 + 配对码（镜像 internal/httpapi/tlscfg.go）。
// P2 只做「读已有证书」，自签生成与对端双向 TLS 留 P3。
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import type { TlsAdapter, TlsInfo, TlsMaterial } from "@base/core-ts";

// 指纹前 10 字节 → Base32 无填充恰好 16 字符（80 bit / 5 bit = 16）。
const PAIRING_BYTES = 10;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function base32NoPad(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

function fingerprintMismatch(message: string): Error {
  const err = new Error(message);
  (err as Error & { code: string }).code = "tls_fingerprint_mismatch";
  return err;
}

export function createTlsAdapter(): TlsAdapter {
  return {
    async loadOrCreate(info: TlsMaterial): Promise<TlsInfo> {
      let pem: Buffer;
      try {
        pem = readFileSync(info.certFile);
      } catch {
        throw new Error(
          `tls: 读取证书 ${info.certFile} 失败（P2 不实现自签生成，留 P3）`,
        );
      }
      const cert = new X509Certificate(pem);
      const digest = createHash("sha256").update(cert.raw).digest();
      const code = base32NoPad(digest.subarray(0, PAIRING_BYTES));
      return {
        certFile: info.certFile,
        keyFile: info.keyFile,
        fingerprintHex: digest.toString("hex"),
        pairingCode: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12, 16)}`,
      };
    },

    serverConfig(info: TlsInfo, _peerFingerprints: string[]): TlsMaterial {
      return { certFile: info.certFile, keyFile: info.keyFile };
    },

    clientConfig(own: TlsInfo, _peerFingerprintHex: string): TlsMaterial {
      return { certFile: own.certFile, keyFile: own.keyFile };
    },

    verifyPeer(rawCertsDer: Uint8Array[], allowed: string[]): void {
      if (rawCertsDer.length === 0) {
        throw fingerprintMismatch("tls_fingerprint_mismatch: 对端未提供证书");
      }
      const allowedSet = new Set(allowed.map((f) => f.trim().toLowerCase()));
      const got = sha256Hex(rawCertsDer[0]);
      if (!allowedSet.has(got)) {
        throw fingerprintMismatch(`tls_fingerprint_mismatch: 对端指纹 ${got} 不在白名单`);
      }
    },

    nodeKeyMatches(want: string, got: string): boolean {
      const a = Buffer.from(want, "utf8");
      const b = Buffer.from(got, "utf8");
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    },
  };
}
