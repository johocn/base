// 节点 store 密钥文件（逻辑镜像 internal/store/crypto.go:48-178）：
// 密钥是 data 目录的**兄弟文件**（`<data>.key`），内容 = 64 位 hex + "\n"，权限 0600。
// 优先级：显式参数 → BASE_STORE_KEY → BASE_STORE_KEY_FILE → `<data>.key`（缺失即生成并写盘）。
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { normalize } from "node:path";

export const STORE_KEY_BYTES = 32;

const ENV_STORE_KEY = "BASE_STORE_KEY";
const ENV_STORE_KEY_FILE = "BASE_STORE_KEY_FILE";

export interface StoreKeyOptions {
  /** 显式注入 64 位 hex 密钥（优先级最高）。传空串视为配置错误，不回退默认文件。 */
  storeKeyHex?: string;
}

export interface StoreKeyResult {
  key: Uint8Array;
  /** 密钥来源文件路径；来自参数/环境变量时为空串。 */
  path: string;
}

export interface StoreKeyStatusResult {
  path: string;
  /** 仅在 exists=true 时非空。 */
  hexKey: string;
  exists: boolean;
}

/** 默认密钥文件路径：data 目录的**兄弟文件**（不是 data 目录内）。 */
export function defaultStoreKeyPath(dataDir: string): string {
  return normalize(dataDir) + ".key";
}

function trimEnv(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** 解析 64 位 hex 密钥；空串 / 非 hex / 非 32 字节一律抛错。 */
export function parseStoreKey(raw: string): Uint8Array {
  const s = raw.trim();
  if (s === "") throw new Error("store: empty store key");
  if (!/^[0-9a-fA-F]+$/.test(s)) throw new Error("store: store key is not hex");
  if (s.length !== STORE_KEY_BYTES * 2) {
    throw new Error(
      `store: store key must be ${STORE_KEY_BYTES} bytes (hex ${STORE_KEY_BYTES * 2} chars), got ${Math.floor(s.length / 2)} bytes`,
    );
  }
  return new Uint8Array(Buffer.from(s, "hex"));
}

/** 生成 32 字节随机密钥。 */
export function newStoreKey(): Uint8Array {
  return new Uint8Array(randomBytes(STORE_KEY_BYTES));
}

export function toHex(key: Uint8Array): string {
  return Buffer.from(key).toString("hex");
}

/** 按四档优先级解析密钥；默认档缺失时生成并写盘（hex + "\n"，0600）。 */
export function loadStoreKey(dataDir: string, opts: StoreKeyOptions = {}): StoreKeyResult {
  if (opts.storeKeyHex !== undefined) {
    return { key: parseStoreKey(opts.storeKeyHex), path: "" };
  }
  const envKey = trimEnv(ENV_STORE_KEY);
  if (envKey !== "") {
    return { key: parseStoreKey(envKey), path: "" };
  }
  const envFile = trimEnv(ENV_STORE_KEY_FILE);
  if (envFile !== "") {
    let raw: string;
    try {
      raw = readFileSync(envFile, "utf8");
    } catch (err) {
      throw new Error(`store: read ${ENV_STORE_KEY_FILE}=${envFile}: ${String(err)}`);
    }
    return { key: parseStoreKey(raw), path: envFile };
  }

  const p = defaultStoreKeyPath(dataDir);
  let raw: string | null = null;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`store: read store key ${p}: ${String(err)}`);
    }
  }
  if (raw !== null) {
    return { key: parseStoreKey(raw), path: p };
  }
  const key = newStoreKey();
  try {
    writeFileSync(p, toHex(key) + "\n", { mode: 0o600 });
  } catch (err) {
    throw new Error(`store: write store key ${p}: ${String(err)}`);
  }
  return { key, path: p };
}

/** 报告当前密钥状态，**不创建任何文件**（供 CLI 只读查询）。 */
export function storeKeyStatus(
  dataDir: string,
  opts: StoreKeyOptions = {},
): StoreKeyStatusResult {
  if (opts.storeKeyHex !== undefined) {
    return { path: "", hexKey: toHex(parseStoreKey(opts.storeKeyHex)), exists: true };
  }
  const envKey = trimEnv(ENV_STORE_KEY);
  if (envKey !== "") {
    return { path: "", hexKey: toHex(parseStoreKey(envKey)), exists: true };
  }
  const envFile = trimEnv(ENV_STORE_KEY_FILE);
  if (envFile !== "") {
    let raw: string;
    try {
      raw = readFileSync(envFile, "utf8");
    } catch (err) {
      throw new Error(`store: read ${ENV_STORE_KEY_FILE}=${envFile}: ${String(err)}`);
    }
    return { path: envFile, hexKey: toHex(parseStoreKey(raw)), exists: true };
  }

  const p = defaultStoreKeyPath(dataDir);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: p, hexKey: "", exists: false };
    }
    throw new Error(`store: read store key ${p}: ${String(err)}`);
  }
  return { path: p, hexKey: toHex(parseStoreKey(raw)), exists: true };
}
