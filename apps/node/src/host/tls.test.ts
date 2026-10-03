import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTlsCertCommand } from "../cli/tls-cert";
import { createTlsAdapter, generateSelfSigned, isTlsOff, needsTlsIdentity, verifyPeerFingerprint } from "./tls";

const BASED_EXE = fileURLToPath(new URL("../../../../based.exe", import.meta.url));

const tls = createTlsAdapter();
const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "base-tls-"));
  dirs.push(dir);
  return dir;
}

function certPaths(dir: string): { certFile: string; keyFile: string } {
  return { certFile: join(dir, "tls", "node.crt"), keyFile: join(dir, "tls", "node.key") };
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe("verifyPeer：指纹固定 fail-closed", () => {
  const der = new Uint8Array([1, 2, 3]);
  const hex = createHash("sha256").update(der).digest("hex");

  it("对端未提供证书即断", () => {
    expect(() => tls.verifyPeer([], [hex])).toThrowError(/对端未提供证书/);
  });

  it("空白名单拒绝一切（不退化成不校验）", () => {
    expect(() => tls.verifyPeer([der], [])).toThrowError(/不在白名单/);
  });

  it("命中白名单放过；大小写与空白不影响判定", () => {
    expect(() => tls.verifyPeer([der], [hex])).not.toThrow();
    expect(() => tls.verifyPeer([der], [`  ${hex.toUpperCase()}  `])).not.toThrow();
  });

  it("不匹配抛 tls_fingerprint_mismatch", () => {
    try {
      tls.verifyPeer([der], ["00".repeat(32)]);
      expect.unreachable("应当抛错");
    } catch (err) {
      expect((err as Error & { code: string }).code).toBe("tls_fingerprint_mismatch");
    }
  });
});

describe("verifyPeerFingerprint：单一实现三格（计划 #77 T2）", () => {
  const der = new Uint8Array([9, 8, 7]);
  const hex = createHash("sha256").update(der).digest("hex");

  it("空 raw（未提供证书）⇒ 报错，绝不放过", () => {
    const missing = verifyPeerFingerprint(undefined, [hex]);
    expect(missing).not.toBeNull();
    expect(missing?.message).toMatch(/对端未提供证书/);
    expect(verifyPeerFingerprint(new Uint8Array(0), [hex])).not.toBeNull();
  });

  it("指纹不在白名单 ⇒ 报错", () => {
    expect(verifyPeerFingerprint(der, ["00".repeat(32)])?.message).toMatch(/不在白名单/);
  });

  it("命中白名单 ⇒ null（大小写与空白不影响判定）", () => {
    expect(verifyPeerFingerprint(der, [hex])).toBeNull();
    expect(verifyPeerFingerprint(der, [`  ${hex.toUpperCase()}  `])).toBeNull();
  });
});

describe("nodeKeyMatches：等长 + 常量时间比较", () => {
  it("相同为真", () => {
    expect(tls.nodeKeyMatches("abc123", "abc123")).toBe(true);
  });

  it("同长不同为假", () => {
    expect(tls.nodeKeyMatches("abc123", "abc124")).toBe(false);
  });

  it("长度不同为假（不进入常量时间比较）", () => {
    expect(tls.nodeKeyMatches("abc", "abcd")).toBe(false);
    expect(tls.nodeKeyMatches("", "a")).toBe(false);
  });
});

describe("loadOrCreate：自签生成", () => {
  it("证书不存在时生成，可被 X509Certificate 解析且 DER sha256 自洽", async () => {
    const dir = tmpDir();
    const paths = certPaths(dir);
    const info = await tls.loadOrCreate(paths);

    const pem = readFileSync(paths.certFile, "utf8");
    expect(pem).toContain("-----BEGIN CERTIFICATE-----");
    expect(readFileSync(paths.keyFile, "utf8")).toContain("-----BEGIN EC PRIVATE KEY-----");

    const cert = new X509Certificate(pem);
    expect(createHash("sha256").update(cert.raw).digest("hex")).toBe(info.fingerprintHex);
    expect(info.fingerprintHex).toMatch(/^[0-9a-f]{64}$/);
    expect(info.pairingCode).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);

    // 生成时无涉敏感 keyFile 权限（Windows 不落 POSIX 位，仅非 win32 断言）。
    if (process.platform !== "win32") {
      expect(statSync(paths.keyFile).mode & 0o777).toBe(0o600);
      expect(statSync(paths.certFile).mode & 0o777).toBe(0o644);
    }
  });

  it("证书字段对齐 tlscfg.go 模板（CN/O/IsCA/EKU/SAN）", async () => {
    const dir = tmpDir();
    await tls.loadOrCreate(certPaths(dir));
    const cert = new X509Certificate(readFileSync(certPaths(dir).certFile));

    expect(cert.ca).toBe(true);
    expect(cert.subject).toContain("CN=base-node");
    expect(cert.subject).toContain("O=base");
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.subjectAltName).toContain("DNS:base-node");
    expect(cert.subjectAltName).toContain("IP Address:127.0.0.1");
    // Extended Key Usage：serverAuth + clientAuth
    expect(cert.keyUsage).toContain("1.3.6.1.5.5.7.3.1");
    expect(cert.keyUsage).toContain("1.3.6.1.5.5.7.3.2");
  });

  it("幂等：二次调用不重写文件、指纹不变", async () => {
    const dir = tmpDir();
    const paths = certPaths(dir);
    const first = await tls.loadOrCreate(paths);
    const before = readFileSync(paths.certFile, "utf8");
    const second = await tls.loadOrCreate(paths);
    expect(readFileSync(paths.certFile, "utf8")).toBe(before);
    expect(second.fingerprintHex).toBe(first.fingerprintHex);
    expect(second.pairingCode).toBe(first.pairingCode);
  });

  it("路径为空即报错", async () => {
    await expect(tls.loadOrCreate({ certFile: "", keyFile: "k" })).rejects.toThrowError(
      /都不能为空/,
    );
    await expect(tls.loadOrCreate({ certFile: "c", keyFile: " " })).rejects.toThrowError(
      /都不能为空/,
    );
  });
});

describe("serverConfig / clientConfig：策略回落 TlsConfig", () => {
  it("服务端：白名单非空 ⇒ 要求对端证书 + 信任由指纹承担", async () => {
    const dir = tmpDir();
    const info = await tls.loadOrCreate(certPaths(dir));
    const cfg = tls.serverConfig(info, [`  ${"AB".repeat(32)}  `]);
    expect(cfg.certFile).toBe(info.certFile);
    expect(cfg.peerFingerprints).toEqual(["ab".repeat(32)]);
    expect(cfg.trustPeerByFingerprint).toBe(true);
  });

  it("服务端：空名单 ⇒ 不做对端校验", async () => {
    const dir = tmpDir();
    const info = await tls.loadOrCreate(certPaths(dir));
    expect(tls.serverConfig(info, []).trustPeerByFingerprint).toBe(false);
    // 空项留在名单里（长度不减），保持 fail-closed。
    const blank = tls.serverConfig(info, ["  "]);
    expect(blank.peerFingerprints).toHaveLength(1);
    expect(blank.trustPeerByFingerprint).toBe(true);
  });

  it("出站：单元素白名单 + 恒不做系统 CA 校验", async () => {
    const dir = tmpDir();
    const info = await tls.loadOrCreate(certPaths(dir));
    const cfg = tls.clientConfig(info, "CD".repeat(32));
    expect(cfg.peerFingerprints).toEqual(["cd".repeat(32)]);
    expect(cfg.trustPeerByFingerprint).toBe(true);
  });
});

describe.skipIf(!existsSync(BASED_EXE))("跨实现互认（G5：based.exe）", () => {
  function show(dir: string): { fingerprint: string; pairingCode: string } {
    const res = spawnSync(BASED_EXE, ["tls-cert", "show", "-data", dir], { encoding: "utf8" });
    expect(res.status, `based.exe stderr: ${res.stderr}`).toBe(0);
    const pick = (key: string): string =>
      (res.stdout.split("\n").find((l) => l.startsWith(key)) ?? "").split("=")[1]?.trim() ?? "";
    return { fingerprint: pick("fingerprint"), pairingCode: pick("pairing_code") };
  }

  it("Node 生成的证书，Go 读出的指纹与配对码逐字一致", async () => {
    const dir = tmpDir();
    const info = await tls.loadOrCreate(certPaths(dir));
    const got = show(dir);
    expect(got.fingerprint).toBe(info.fingerprintHex);
    expect(got.pairingCode).toBe(info.pairingCode);
  });

  it("Go 生成的证书，Node 读出的指纹与配对码逐字一致", async () => {
    const dir = tmpDir();
    const res = spawnSync(BASED_EXE, ["tls-cert", "init", "-data", dir], { encoding: "utf8" });
    expect(res.status, `based.exe stderr: ${res.stderr}`).toBe(0);
    const go = show(dir);
    const info = await tls.loadOrCreate(certPaths(dir));
    expect(info.fingerprintHex).toBe(go.fingerprint);
    expect(info.pairingCode).toBe(go.pairingCode);
  });

  it("tls-cert show 的 stdout 与 Go 逐字相同（同一证书目录）", async () => {
    const dir = tmpDir();
    const res = spawnSync(BASED_EXE, ["tls-cert", "init", "-data", dir], { encoding: "utf8" });
    expect(res.status, `based.exe stderr: ${res.stderr}`).toBe(0);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk): boolean => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const code = await createTlsCertCommand(tls).run(["show", "-data", dir]);
      expect(code).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).toBe(res.stdout);
  });
});

describe("generateSelfSigned：直连落盘", () => {
  it("父目录不存在时按 0755 递归创建", () => {
    const dir = tmpDir();
    const paths = certPaths(dir);
    generateSelfSigned(paths.certFile, paths.keyFile);
    expect(existsSync(paths.certFile)).toBe(true);
    expect(existsSync(paths.keyFile)).toBe(true);
  });
});

describe("isTlsOff / needsTlsIdentity：身份加载判定（计划 #77 G4 五格矩阵）", () => {
  it("off 判定：大小写与首尾空白等价", () => {
    expect(isTlsOff(" off ")).toBe(true);
    expect(isTlsOff("OFF")).toBe(true);
    expect(isTlsOff("")).toBe(false);
    expect(isTlsOff("/p/node.crt")).toBe(false);
  });

  // 矩阵顺序：tls-cert 非 off / off × 有无 -peer-addr × 有无 -peers。
  it.each([
    { tls: "/p/node.crt", addr: "", peers: 0, want: true, note: "主监听要 TLS（B-② 修复格）" },
    { tls: "/p/node.crt", addr: ":8081", peers: 0, want: true, note: "对齐 Go !plaintext" },
    { tls: "off", addr: ":8081", peers: 0, want: true, note: "对齐 Go plaintext + peer-addr" },
    { tls: "off", addr: "", peers: 1, want: true, note: "超集格：Go 漏判 -peers（#77 定案 2）" },
    { tls: "off", addr: "", peers: 0, want: false, note: "唯一不加载格，与 Go 一致" },
  ])("$note", ({ tls: tlsCert, addr, peers, want }) => {
    expect(needsTlsIdentity(tlsCert, addr, peers)).toBe(want);
  });
});
