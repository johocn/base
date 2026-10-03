// TlsAdapter：自签生成 + 指纹固定 + 配对码（镜像 internal/httpapi/tlscfg.go）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  X509Certificate,
} from "node:crypto";
import type { TlsAdapter, TlsConfig, TlsInfo, TlsMaterial } from "@base/core-ts";
import {
  bitString,
  bool,
  explicit,
  int,
  oid,
  octet,
  pem,
  seq,
  set,
  time,
  tlv,
  utf8,
} from "./der";

// 指纹前 10 字节 → Base32 无填充恰好 16 字符（80 bit / 5 bit = 16）。
const PAIRING_BYTES = 10;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
// 与 tlscfg.go 的 certValidity 一致：10 * 365 天。
const CERT_VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const OID_EC_PUBLIC_KEY_SHA256 = "1.2.840.10045.4.3.2";
const OID_AT_ORGANIZATION = "2.5.4.10";
const OID_AT_COMMON_NAME = "2.5.4.3";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_EKU_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const OID_EKU_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

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

/** 白名单只做 trim + 小写统一；**不剔空项**——空项留在名单里才保持 fail-closed（剔掉会退化成「不校验」）。 */
function normalizeFingerprints(list: string[]): string[] {
  return list.map((f) => f.trim().toLowerCase());
}

/**
 * 自签证书 DER：ECDSA P-256，CN=base-node / O=base，IsCA（同一张证书兼作服务端与客户端），
 * KeyUsage=digitalSignature|certSign，ExtKeyUsage=serverAuth|clientAuth，
 * SAN=dns:base-node,ip:127.0.0.1,ip:::1。字段集合对齐 tlscfg.go:104-147。
 */
function selfSignedDer(): { certDer: Buffer; keyDer: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const keyDer = privateKey.export({ type: "sec1", format: "der" });

  const name = seq(
    set(seq(oid(OID_AT_ORGANIZATION), utf8("base"))),
    set(seq(oid(OID_AT_COMMON_NAME), utf8("base-node"))),
  );
  const extensions = explicit(
    3,
    seq(
      seq(oid(OID_BASIC_CONSTRAINTS), bool(true), octet(seq(bool(true)))),
      // digitalSignature = bit0、keyCertSign = bit5 ⇒ 0x84（末 2 位未用）；与 Go marshalKeyUsage 同形。
      seq(oid(OID_KEY_USAGE), bool(true), octet(bitString(2, Buffer.from([0x84])))),
      seq(oid(OID_EXT_KEY_USAGE), octet(seq(oid(OID_EKU_SERVER_AUTH), oid(OID_EKU_CLIENT_AUTH)))),
      seq(
        oid(OID_SUBJECT_ALT_NAME),
        octet(
          seq(
            tlv(0x82, Buffer.from("base-node", "ascii")),
            tlv(0x87, Buffer.from([127, 0, 0, 1])),
            tlv(0x87, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])),
          ),
        ),
      ),
    ),
  );

  const now = Date.now();
  const sigAlg = seq(oid(OID_EC_PUBLIC_KEY_SHA256));
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))), // version = v3
    int(randomBytes(16)), // serialNumber：128-bit 随机（非负）
    sigAlg,
    name, // issuer（自签：与 subject 同）
    seq(time(new Date(now - 3600_000)), time(new Date(now + CERT_VALIDITY_MS))),
    name, // subject
    spki,
    extensions,
  );
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  return { certDer: seq(tbs, sigAlg, bitString(0, signature)), keyDer };
}

/** 生成并落盘自签证书：证书 0644、私钥 0600，父目录 0755（对齐 tlscfg.go:134-146）。 */
export function generateSelfSigned(certFile: string, keyFile: string): void {
  const { certDer, keyDer } = selfSignedDer();
  mkdirSync(dirname(certFile), { recursive: true, mode: 0o755 });
  writeFileSync(certFile, pem("CERTIFICATE", certDer), { mode: 0o644 });
  writeFileSync(keyFile, pem("EC PRIVATE KEY", keyDer), { mode: 0o600 });
}

/** `-tls-cert=off` 的语义 = 主监听不加密（**不是**本节点没有身份）；对齐 peerconfig.go:68-71 的判定。 */
export function isTlsOff(tlsCertRaw: string): boolean {
  return tlsCertRaw.trim().toLowerCase() === "off";
}

/**
 * 是否需要加载本节点 TLS 身份（计划 #77 §2 定案 2，超集语义）：
 * 主监听要 TLS（`tls-cert` 非 off）**或** 对端监听要身份（`-peer-addr` 非空）**或** 出站要身份（`-peers` 非空）。
 * 三因子全假才不加载——该格与 Go 一致；第三因子是 Go `serve.go:61-76` 的漏判（与其 `tlsInfo()` 自身文档矛盾），**刻意不复刻**。
 */
export function needsTlsIdentity(
  tlsCertRaw: string,
  peerAddr: string,
  peerCount: number,
): boolean {
  return !isTlsOff(tlsCertRaw) || peerAddr !== "" || peerCount > 0;
}

export function createTlsAdapter(): TlsAdapter {
  return {
    async loadOrCreate(info: TlsMaterial): Promise<TlsInfo> {
      if (info.certFile.trim() === "" || info.keyFile.trim() === "") {
        throw new Error("tls: 证书与私钥路径都不能为空");
      }
      if (!existsSync(info.certFile)) {
        generateSelfSigned(info.certFile, info.keyFile);
      }
      let cert: X509Certificate;
      try {
        cert = new X509Certificate(readFileSync(info.certFile));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`tls: 解析 ${info.certFile} 失败: ${msg}`);
      }
      const digest = createHash("sha256").update(cert.raw).digest();
      const code = base32NoPad(digest.subarray(0, PAIRING_BYTES));
      return {
        certFile: info.certFile,
        keyFile: info.keyFile,
        fingerprintHex: digest.toString("hex"),
        pairingCode: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12, 16)}`,
      };
    },

    serverConfig(info: TlsInfo, peerFingerprints: string[]): TlsConfig {
      const allowed = normalizeFingerprints(peerFingerprints);
      return {
        certFile: info.certFile,
        keyFile: info.keyFile,
        peerFingerprints: allowed,
        // 空名单 = 不做对端校验（对齐 Go：len(peerFingerprints) == 0 时不设 ClientAuth）。
        trustPeerByFingerprint: allowed.length > 0,
      };
    },

    clientConfig(own: TlsInfo, peerFingerprintHex: string): TlsConfig {
      return {
        certFile: own.certFile,
        keyFile: own.keyFile,
        peerFingerprints: normalizeFingerprints([peerFingerprintHex]),
        // 出站恒为 InsecureSkipVerify + 指纹固定：信任完全由对端指纹承担。
        trustPeerByFingerprint: true,
      };
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
