# base mesh 一期实时面实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec `2026-10-17-base-mesh-community-design.md` 一期实时面：信任锚与向量、代报审计、本地库扩展、近场协议（NIO server + 六接口）、TOFU 入网、gossip 收发与代上报、权威序 failover 与仲裁、Go oracle 对拍。

**Architecture:** 协议核进 `packages/protocol-ts`（canonical/签名/向量）；纯逻辑（catalog 构建/合并、gossip 存取、权威序仲裁、mesh 客户端）进 `packages/core-ts`（fakes 可测）；平台面（NIO server、plus API、页面）进 `apps/mobile`；节点侧只加 relay 审计列与头校验。**不碰 `internal/**`、不改内容包规范 v1、不 bump schema_version、不做 iOS 源端、不做息屏保活、不做快照降级（二期）。**

**Tech Stack:** TypeScript / vitest（protocol-ts、core-ts、node）、uni-app Vue3 + plus.android NIO（mobile）、Go（tools/meshoracle 只读消费 vectors）。

**执行环境注意（PowerShell）：** 不支持 `&&`；多命令用 `;` 分隔。提交只 add 本册文件。

**向量化密钥约定（全册统一）：** root = RFC 8032 TEST1 seed `9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60`；working = RFC 8032 TEST2 seed `4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb`（均与 `internal/packexport` genvectors 惯例同源）。

**执行期定案（偏离 spec 的最小裁剪，已在计划内写死）：**
1. 入网二维码一期落为**配对码文本**（enroll JSON 全文复制/粘贴 + `uni.scanCode` 扫码入口留位）：mobile 无二维码生成库，引入生成器超预算；`base-node-enroll` canonical 格式仍按 spec 写死进向量。
2. mesh catalog 的 `rev` 定为**整数**（`source_rev` 可 `parseInt` 时取值，否则 0）；`content_hash` 参与判等。canonical 里 `rev` 为整数满足 canonicalize 整数约束。
3. catalog 分页 = 传输切分：签名对象 `entries` 恒为全量，客户端拉完所有页后用全量 entries 验签。
4. `hello` 失败锁按**连接远端地址**（`SocketChannel.getRemoteAddress()`，bridge 异常时降级为空串=全局计数）。

---

## Task 1: protocol-ts mesh 签名对象 + vectors

**Files:**
- Create: `packages/protocol-ts/src/mesh.ts`
- Create: `packages/protocol-ts/src/mesh.test.ts`
- Modify: `packages/protocol-ts/src/index.ts`（追加一行 export）
- Create: `vectors/v1/mesh.json`
- Modify: `packages/protocol-ts/src/vectors.test.ts`（追加 describe）

- [ ] **Step 1: 写 mesh.ts**

```ts
// mesh 一期签名对象：node-key-rotation 证书 / base-node-enroll 入网 / mesh-catalog 目录。
// canonical 字节与签名进 vectors/v1/mesh.json，Go oracle（tools/meshoracle）同消费。
import { canonicalize, sha256Hex, sign, utf8, verify, isIdentityId, type Json } from "./index";

export interface NodeKeyRotationDoc {
  type: "node-key-rotation";
  v: 1;
  node_id: string;
  old_pubkey: string;
  new_pubkey: string;
  effective_at: string;
  issued_at: string;
  signature: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?$/;

export function nodeKeyRotationSignBytes(doc: Omit<NodeKeyRotationDoc, "signature">): string {
  return canonicalize({
    type: doc.type,
    v: doc.v,
    node_id: doc.node_id,
    old_pubkey: doc.old_pubkey,
    new_pubkey: doc.new_pubkey,
    effective_at: doc.effective_at,
    issued_at: doc.issued_at,
  });
}

export function signNodeKeyRotation(doc: Omit<NodeKeyRotationDoc, "signature">, rootSeedHex: string): NodeKeyRotationDoc {
  return { ...doc, signature: sign(rootSeedHex, utf8(nodeKeyRotationSignBytes(doc))) };
}

/** cert_id = hex(sha256(canonical 字节))[0:32]（spec §1.2 写死）。 */
export function nodeKeyRotationCertId(doc: Omit<NodeKeyRotationDoc, "signature">): string {
  return sha256Hex(utf8(nodeKeyRotationSignBytes(doc))).slice(0, 32);
}

/**
 * 单级规则（spec §1.2）：cert 必须由根密钥亲签（sig 对 root_pubkey 验证）；
 * old_pubkey ∈ {root_pubkey, 当前生效工作密钥公钥}；字段形态全检。
 */
export function verifyNodeKeyRotation(
  doc: NodeKeyRotationDoc,
  rootPubHex: string,
  currentWorkingPubHex: string,
): boolean {
  if (doc.type !== "node-key-rotation" || doc.v !== 1) return false;
  if (!isIdentityId(doc.node_id)) return false;
  if (!HEX64.test(doc.old_pubkey) || !HEX64.test(doc.new_pubkey)) return false;
  if (!ISO_RE.test(doc.effective_at) || !ISO_RE.test(doc.issued_at)) return false;
  if (doc.old_pubkey !== rootPubHex && doc.old_pubkey !== currentWorkingPubHex) return false;
  if (!HEX64.test(doc.signature)) return false;
  return verify(rootPubHex, utf8(nodeKeyRotationSignBytes(doc)), doc.signature);
}

export interface NodeEnrollDoc {
  v: 1;
  kind: "base-node-enroll";
  node_id: string;
  url: string;
  sign_pubkey: string;
  tls_fingerprint: string;
  expires_at: string;
  /** 分享会话期 token（spec §3.3：同一次扫码完成 TOFU + 入网）；纯入网码可缺省。 */
  token?: string;
}

/** enroll 二维码（一期为配对码文本）：canonical JSON，缺一不收；token 可选。 */
export function parseNodeEnroll(raw: string): NodeEnrollDoc | null {
  let p: unknown;
  try {
    p = JSON.parse(raw);
  } catch {
    return null;
  }
  if (p === null || typeof p !== "object" || Array.isArray(p)) return null;
  const m = p as Record<string, unknown>;
  if (m.v !== 1 || m.kind !== "base-node-enroll") return null;
  if (typeof m.node_id !== "string" || !isIdentityId(m.node_id)) return null;
  if (typeof m.url !== "string" || !/^https:\/\/.+/.test(m.url)) return null;
  if (typeof m.sign_pubkey !== "string" || !HEX64.test(m.sign_pubkey)) return null;
  if (typeof m.tls_fingerprint !== "string" || !HEX64.test(m.tls_fingerprint)) return null;
  if (typeof m.expires_at !== "string" || !ISO_RE.test(m.expires_at)) return null;
  const doc: NodeEnrollDoc = {
    v: 1,
    kind: "base-node-enroll",
    node_id: m.node_id,
    url: m.url,
    sign_pubkey: m.sign_pubkey,
    tls_fingerprint: m.tls_fingerprint,
    expires_at: m.expires_at,
  };
  if (m.token !== undefined) {
    if (typeof m.token !== "string" || !/^[0-9a-f]{64}$/.test(m.token)) return null;
    doc.token = m.token;
  }
  return doc;
}

export interface MeshCatalogEntry {
  item_id: string;
  rev: number;
  content_hash: string;
  size: number;
}

export interface MeshCatalogDoc {
  type: "mesh-catalog";
  v: 1;
  node_id: string;
  catalog_version: number;
  entries: MeshCatalogEntry[];
  signed_at: string;
  signature: string;
}

export function meshCatalogSignBytes(doc: Omit<MeshCatalogDoc, "signature">): string {
  return canonicalize({
    type: doc.type,
    v: doc.v,
    node_id: doc.node_id,
    catalog_version: doc.catalog_version,
    entries: doc.entries.map((e) => ({
      item_id: e.item_id,
      rev: e.rev,
      content_hash: e.content_hash,
      size: e.size,
    })),
    signed_at: doc.signed_at,
  } satisfies Json as Json);
}

export function signMeshCatalog(doc: Omit<MeshCatalogDoc, "signature">, seedHex: string): MeshCatalogDoc {
  return { ...doc, signature: sign(seedHex, utf8(meshCatalogSignBytes(doc))) };
}

/** 验签集合 = {root_pubkey, 当前生效 cert 的 new_pubkey, TOFU 锚点 sign_pubkey}，调用方逐个试。 */
export function verifyMeshCatalog(doc: MeshCatalogDoc, pubHex: string): boolean {
  if (doc.type !== "mesh-catalog" || doc.v !== 1) return false;
  if (!isIdentityId(doc.node_id)) return false;
  if (!Number.isInteger(doc.catalog_version) || doc.catalog_version < 0) return false;
  if (!Array.isArray(doc.entries)) return false;
  for (const e of doc.entries) {
    if (typeof e.item_id !== "string" || e.item_id === "") return false;
    if (!Number.isInteger(e.rev) || e.rev < 0) return false;
    if (!HEX64.test(e.content_hash)) return false;
    if (!Number.isInteger(e.size) || e.size < 0) return false;
  }
  if (!ISO_RE.test(doc.signed_at)) return false;
  if (!HEX64.test(doc.signature)) return false;
  return verify(pubHex, utf8(meshCatalogSignBytes(doc)), doc.signature);
}
```

注意：`index.ts` 里 `export * from "./canonical"` 等已存在，`mesh.ts` 从 `"./index"` import 会造成循环导出——改为直接从各模块具名导入：`import { canonicalize } from "./canonical"; import { sha256Hex, utf8 } from "./hash"; import { sign, verify } from "./ed25519"; import { isIdentityId } from "./identity"; import type { Json } from "./canonical";`（以上代码块的 import 行按此替换）。

- [ ] **Step 2: 写失败测试 mesh.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { keyPairFromSeed } from "./ed25519";
import {
  nodeKeyRotationCertId,
  parseNodeEnroll,
  signMeshCatalog,
  signNodeKeyRotation,
  verifyMeshCatalog,
  verifyNodeKeyRotation,
  type MeshCatalogDoc,
} from "./mesh";

const ROOT_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const WORK_SEED = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";
const NODE_ID = keyPairFromSeed(WORK_SEED).pubHex; // 节点 id 由公钥派生（spec §1.2 hex32 形态即可）

describe("node-key-rotation", () => {
  const doc = signNodeKeyRotation({
    type: "node-key-rotation",
    v: 1,
    node_id: NODE_ID,
    old_pubkey: keyPairFromSeed(ROOT_SEED).pubHex,
    new_pubkey: keyPairFromSeed(WORK_SEED).pubHex,
    effective_at: "2026-10-17T00:00:00Z",
    issued_at: "2026-10-17T00:00:00Z",
  }, ROOT_SEED);
  it("根密钥亲签通过 + cert_id 32 hex", () => {
    expect(verifyNodeKeyRotation(doc, keyPairFromSeed(ROOT_SEED).pubHex, keyPairFromSeed(WORK_SEED).pubHex)).toBe(true);
    expect(nodeKeyRotationCertId(doc)).toMatch(/^[0-9a-f]{32}$/);
  });
  it("工作密钥签发（单级约束）必须失败", () => {
    const bad = signNodeKeyRotation({ ...doc, signature: "" } as never, WORK_SEED);
    expect(verifyNodeKeyRotation(bad, keyPairFromSeed(ROOT_SEED).pubHex, keyPairFromSeed(WORK_SEED).pubHex)).toBe(false);
  });
  it("篡改 new_pubkey 拒绝", () => {
    const bad = { ...doc, new_pubkey: "0" + doc.new_pubkey.slice(1) };
    expect(verifyNodeKeyRotation(bad as never, keyPairFromSeed(ROOT_SEED).pubHex, keyPairFromSeed(WORK_SEED).pubHex)).toBe(false);
  });
});

describe("base-node-enroll", () => {
  const ok = {
    v: 1,
    kind: "base-node-enroll",
    node_id: NODE_ID,
    url: "https://node.example.com",
    sign_pubkey: keyPairFromSeed(WORK_SEED).pubHex,
    tls_fingerprint: "aa".repeat(32),
    expires_at: "2026-12-31T00:00:00Z",
    token: "bb".repeat(32),
  };
  it("合法 + 带 token 通过", () => {
    expect(parseNodeEnroll(JSON.stringify(ok))?.node_id).toBe(NODE_ID);
  });
  it("缺 tls_fingerprint 拒收（双锚缺一不收）", () => {
    const { tls_fingerprint: _drop, ...rest } = ok;
    expect(parseNodeEnroll(JSON.stringify(rest))).toBeNull();
  });
  it("坏 token 形态拒收", () => {
    expect(parseNodeEnroll(JSON.stringify({ ...ok, token: "zz" }))).toBeNull();
  });
});

describe("mesh-catalog", () => {
  const base = {
    type: "mesh-catalog" as const,
    v: 1 as const,
    node_id: NODE_ID,
    catalog_version: 7,
    entries: [
      { item_id: "article/hello", rev: 3, content_hash: "cc".repeat(32), size: 1234 },
      { item_id: "course/c1", rev: 1, content_hash: "dd".repeat(32), size: 0 },
    ],
    signed_at: "2026-10-17T00:00:00Z",
  };
  it("签名/验签往返", () => {
    const doc = signMeshCatalog(base, WORK_SEED);
    expect(verifyMeshCatalog(doc, keyPairFromSeed(WORK_SEED).pubHex)).toBe(true);
  });
  it("换锚公钥拒绝（TOFU 不匹配）", () => {
    const doc: MeshCatalogDoc = signMeshCatalog(base, ROOT_SEED);
    expect(verifyMeshCatalog(doc, keyPairFromSeed(WORK_SEED).pubHex)).toBe(false);
  });
  it("非整数 rev 拒绝", () => {
    const doc = signMeshCatalog({ ...base, entries: [{ ...base.entries[0]!, rev: 1.5 }] }, WORK_SEED);
    expect(verifyMeshCatalog(doc, keyPairFromSeed(WORK_SEED).pubHex)).toBe(false);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test -w @base/protocol-ts`
Expected: FAIL（`./mesh` 不存在）

- [ ] **Step 4: 实现 mesh.ts（Step 1 代码），index.ts 追加 `export * from "./mesh";`，跑测试通过**

Run: `npm test -w @base/protocol-ts` → 全绿。

- [ ] **Step 5: 生成 vectors/v1/mesh.json**

手写（不跑 genvectors——Go 侧不动）：

```json
{
  "version": 1,
  "key": {
    "root_seed_hex": "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "root_pub_hex": "<keyPairFromSeed(root) 的 pubHex>",
    "working_seed_hex": "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    "working_pub_hex": "<keyPairFromSeed(working) 的 pubHex>"
  },
  "rotation": {
    "doc": {
      "type": "node-key-rotation", "v": 1,
      "node_id": "<working_pub_hex>",
      "old_pubkey": "<root_pub_hex>", "new_pubkey": "<working_pub_hex>",
      "effective_at": "2026-10-17T00:00:00Z", "issued_at": "2026-10-17T00:00:00Z",
      "signature": "<signNodeKeyRotation 输出>"
    },
    "cert_id": "<nodeKeyRotationCertId 输出>",
    "sign_bytes": "<nodeKeyRotationSignBytes 输出字符串>"
  },
  "enroll": {
    "doc": {
      "v": 1, "kind": "base-node-enroll",
      "node_id": "<working_pub_hex>",
      "url": "https://node.example.com",
      "sign_pubkey": "<working_pub_hex>",
      "tls_fingerprint": "<64 个 'aa'>",
      "expires_at": "2026-12-31T00:00:00Z",
      "token": "<64 个 'bb'>"
    },
    "canonical": "<canonicalize(enroll.doc) 输出字符串>"
  },
  "catalog": {
    "doc": {
      "type": "mesh-catalog", "v": 1,
      "node_id": "<working_pub_hex>",
      "catalog_version": 7,
      "entries": [
        { "item_id": "article/hello", "rev": 3, "content_hash": "<32 个 'cc'>", "size": 1234 },
        { "item_id": "course/c1", "rev": 1, "content_hash": "<32 个 'dd'>", "size": 0 }
      ],
      "signed_at": "2026-10-17T00:00:00Z",
      "signature": "<signMeshCatalog(working) 输出>"
    },
    "sign_bytes": "<meshCatalogSignBytes 输出字符串>"
  }
}
```

占位值由一次性 Node 脚本算出后粘进文件（`node -e` 调 protocol-ts 源码；或先写向量加载测试的期望断言从实现跑一遍取得）。**禁止手算 hex。**

- [ ] **Step 6: vectors.test.ts 追加 describe**

```ts
describe("mesh.json", () => {
  const f = load("mesh.json");
  it("version 与密钥", () => {
    expect(f.version).toBe(1);
    expect(keyPairFromSeed(f.key.root_seed_hex).pubHex).toBe(f.key.root_pub_hex);
    expect(keyPairFromSeed(f.key.working_seed_hex).pubHex).toBe(f.key.working_pub_hex);
  });
  it("rotation：canonical 字节 / 签名 / cert_id 对拍", () => {
    const doc = f.rotation.doc;
    expect(nodeKeyRotationSignBytes(doc)).toBe(f.rotation.sign_bytes);
    expect(verifyNodeKeyRotation(doc, f.key.root_pub_hex, f.key.working_pub_hex)).toBe(true);
    expect(doc.signature).toBe(sign(f.key.root_seed_hex, utf8(f.rotation.sign_bytes)));
    expect(nodeKeyRotationCertId(doc)).toBe(f.rotation.cert_id);
  });
  it("rotation：用工作密钥签发（违反单级）拒绝", () => {
    const forged = signNodeKeyRotation({ ...f.rotation.doc, signature: undefined }, f.key.working_seed_hex);
    expect(verifyNodeKeyRotation(forged, f.key.root_pub_hex, f.key.working_pub_hex)).toBe(false);
  });
  it("enroll：canonical 字节对拍 + 缺一不收", () => {
    expect(canonicalize(f.enroll.doc)).toBe(f.enroll.canonical);
    const parsed = parseNodeEnroll(f.enroll.canonical);
    expect(parsed?.sign_pubkey).toBe(f.key.working_pub_hex);
    expect(parseNodeEnroll(JSON.stringify({ ...f.enroll.doc, tls_fingerprint: undefined }))).toBeNull();
  });
  it("catalog：canonical 字节 / 签名对拍 + 篡改拒绝", () => {
    const doc = f.catalog.doc;
    expect(meshCatalogSignBytes(doc)).toBe(f.catalog.sign_bytes);
    expect(verifyMeshCatalog(doc, f.key.working_pub_hex)).toBe(true);
    expect(sign(f.key.working_seed_hex, utf8(f.catalog.sign_bytes))).toBe(doc.signature);
    const bad = { ...doc, entries: [{ ...doc.entries[0], size: doc.entries[0].size + 1 }] };
    expect(verifyMeshCatalog(bad, f.key.working_pub_hex)).toBe(false);
  });
});
```

（vectors.test.ts 头部 import 区追加 `nodeKeyRotationSignBytes, nodeKeyRotationCertId, parseNodeEnroll, signNodeKeyRotation, meshCatalogSignBytes, signMeshCatalog, verifyMeshCatalog, verifyNodeKeyRotation`。）

- [ ] **Step 7: 全量测试 + typecheck**

Run: `npm test -w @base/protocol-ts; npm run typecheck -w @base/protocol-ts`
Expected: 全绿，vectors/v1 13→14 个文件被协议核消费。

- [ ] **Step 8: Commit**

```powershell
git add packages/protocol-ts/src/mesh.ts packages/protocol-ts/src/mesh.test.ts packages/protocol-ts/src/index.ts packages/protocol-ts/src/vectors.test.ts vectors/v1/mesh.json
git commit -m "feat(mesh): node-key-rotation/enroll/mesh-catalog canonical objects + vectors"
```

---

## Task 2: node 侧代报审计（relay 列 + 头校验）

**Files:**
- Modify: `apps/node/src/store/schema.ts:276-280`（eventColumnMigrations 追加）
- Modify: `apps/node/src/store/events.ts:9-77`（EventRow/putEvent/getEventById 扩列）
- Modify: `apps/node/src/routes/event.ts`（头校验 + relay 传递）
- Create: `apps/node/src/routes/event.relay.test.ts`

- [ ] **Step 1: schema.ts eventColumnMigrations 追加两列**

```ts
// #82 mesh 一期（spec §4.3）：代上报审计列。列不删、不 bump schema_version。
{ column: "relay_channel", ddl: `ALTER TABLE events ADD COLUMN relay_channel TEXT NOT NULL DEFAULT 'direct'` },
{ column: "relay_device_id", ddl: `ALTER TABLE events ADD COLUMN relay_device_id TEXT` },
```

- [ ] **Step 2: events.ts 扩 EventRow 与 putEvent**

EventRow 追加 `relayChannel: string; relayDeviceId: string;`；putEvent：

```ts
export function putEvent(db: Db, e: EventRow): void {
  let receivedAt = e.receivedAt;
  if (receivedAt === 0) receivedAt = Date.now();
  db.execute(
    `INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to,relay_channel,relay_device_id)
		VALUES(?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(event_id) DO UPDATE SET
			id=excluded.id, type=excluded.type, body_json=excluded.body_json, created_at=excluded.created_at,
			target_id=excluded.target_id, payload_cid=excluded.payload_cid, reply_to=excluded.reply_to`,
    [e.eventId, e.id, e.type, e.bodyJson, e.createdAt, receivedAt, e.targetId, e.payloadCid, e.replyTo, e.relayChannel, e.relayDeviceId],
  );
}
```

要点：**ON CONFLICT 不更新 relay 两列**——同 event_id 重放保留首次审计值。getEventById SELECT 加两列并回填（老库无列时用 try/catch 回退缺省 `'direct'`/`''`，与现有补列时序兼容）。所有现有 `putEvent` 调用点补 `relayChannel: "direct", relayDeviceId: ""`（`routes/peer.ts` 等如有）。

- [ ] **Step 3: routes/event.ts 头校验与验签主体切换**

`eventPostHandler` 内、`decodeStrict` 成功后：

```ts
// #82 mesh 代报（spec §4.3）：X-Base-Relay-For = 原签名者 id，X-Base-Relay-Device = 代报设备 id。
// 事件归属验签查 Relay-For 的公钥；请求签名头仍以代报设备身份（requireAuth 的 actor）。
const relayFor = (req.headers["x-base-relay-for"] ?? "").toLowerCase();
const relayDevice = (req.headers["x-base-relay-device"] ?? "").toLowerCase();
if (relayDevice !== "" && relayFor === "") return jsonResponse(400, { error: "relay_header_invalid" });
if (relayFor !== "" && (!isIdentityId(relayFor) || relayDevice === "" || !isIdentityId(relayDevice))) {
  return jsonResponse(400, { error: "relay_header_invalid" });
}
```

`handleCommentEvent` / `putBareEvent` 增加形参 `relay: { channel: "direct" | "mesh"; deviceId: string }`；comment 分支把 `verifyEventSig(deps, actor, ...)` 的 actor 改为 `relayFor !== "" ? relayFor : actor`；putEvent 行 `relayChannel: relay.channel, relayDeviceId: relay.deviceId`。直连路径 `relay = { channel: "direct", deviceId: "" }`；mesh 路径 `relay = { channel: "mesh", deviceId: actor }`。其余类型分支（group/dm/progress/…）mesh 一期不代报：`relayFor !== ""` 时直接 `jsonResponse(400, { error: "relay_type_unsupported" })`（仅 comment.v1 放行）。

`authmw.ts` 的 `authErrText` 追加：`relay_header_invalid: "代报头不合法（X-Base-Relay-For/Device 须为 32 位 hex 且成对出现）"`、`relay_type_unsupported: "该事件类型不支持代报"`。

- [ ] **Step 4: 写测试 event.relay.test.ts（先写，确认失败，再实现）**

用例（复用 `event.test.ts` 的构造手法——子代理先读该文件沿用其 fake/依赖注入方式）：
1. 代报正例：设备 B 签名头 + `X-Base-Relay-For: A_id` + A 签名的 comment 事件 → 200，库行 `relay_channel='mesh'`、`relay_device_id=B_id`、`id=A_id`。
2. `Relay-For` 与事件签名者不一致 → 403 `event_sig_invalid`（验签查的是 A 的公钥，sig 不对）。
3. 只带 Device 不带 For → 400 `relay_header_invalid`。
4. 直连（无头）→ `relay_channel='direct'`、`relay_device_id` 空。
5. mesh 头 + `type=progress.v1` → 400 `relay_type_unsupported`。
6. 同 event_id 直连先到、mesh 重放 → 审计列保持首次（direct）。

- [ ] **Step 5: 跑包测试**

Run: `npm test -w @base/node; npm run typecheck -w @base/node`
Expected: 全绿。

- [ ] **Step 6: Commit**

```powershell
git add apps/node/src/store/schema.ts apps/node/src/store/events.ts apps/node/src/routes/event.ts apps/node/src/routes/authmw.ts apps/node/src/routes/event.relay.test.ts
git commit -m "feat(node): mesh relay audit columns + X-Base-Relay-For/Device validation"
```

---

## Task 3: core-ts 本地库扩展（nodes / gossip_events / conflicted）

**Files:**
- Modify: `packages/core-ts/src/repo.ts`（SCHEMA_SQL 追加两表 + ensureItemsColumns 补 conflicted + LocalRepo 接口与 SqlRepo 实现追加方法）
- Modify: `packages/core-ts/src/platform/index.ts`（mobile 装配两处 L29-31/L60-62 调 ensureMeshColumns——即 ensureItemsColumns 扩展后自动覆盖）
- Modify: `packages/core-ts/src/repo.test.ts`（新表/新方法用例）

- [ ] **Step 1: 先读 `packages/core-ts/src/schema-check.test.ts` 确认其锁定范围**

若其只锁 pack 五表（`notes` 等本地表在 SCHEMA_SQL 而不在 Go schema，已是先例）则直接继续；若锁全表集合，按其模式登记新表。

- [ ] **Step 2: SCHEMA_SQL 追加**

```ts
  // #82 mesh 一期（spec §1.2/§2.2/§4.2）：节点锚点表（TOFU 双锚 + 权威序）。
  `CREATE TABLE IF NOT EXISTS nodes(
     node_id TEXT PRIMARY KEY, url TEXT NOT NULL, tls_fingerprint TEXT NOT NULL,
     sign_pubkey TEXT NOT NULL, authority_order INTEGER NOT NULL DEFAULT 2147483647,
     last_seen_at TEXT NOT NULL DEFAULT '')`,
  // gossip 收件表：只存收到的他人事件（本机所发走 comment_out）。
  `CREATE TABLE IF NOT EXISTS gossip_events(
     event_id TEXT PRIMARY KEY, type TEXT NOT NULL, target_id TEXT NOT NULL,
     actor TEXT NOT NULL, created_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
     payload_cid TEXT NOT NULL DEFAULT '', payload_path TEXT NOT NULL DEFAULT '',
     sig TEXT NOT NULL, relayed INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_gossip_received ON gossip_events(received_at, event_id)`,
```

- [ ] **Step 3: items 表补 conflicted 列**

`ensureItemsColumns` 追加：

```ts
  if (!cols.has('conflicted')) {
    await db.execute(`ALTER TABLE items ADD COLUMN conflicted INTEGER NOT NULL DEFAULT 0`);
  }
```

（新装库走 SCHEMA_SQL 的 items 建表——把 `conflicted INTEGER NOT NULL DEFAULT 0` 同步写进 SCHEMA_SQL 的 items 建表语句，存量库靠 ensure 补列。）

- [ ] **Step 4: LocalRepo 接口与 SqlRepo 实现**

```ts
export interface NodeRow {
  nodeId: string;
  url: string;
  tlsFingerprint: string;
  signPubkey: string;
  authorityOrder: number;
  lastSeenAt: string;
}
export interface GossipRow {
  eventId: string; type: string; targetId: string; actor: string;
  createdAt: number; receivedAt: number; payloadCid: string; payloadPath: string; sig: string; relayed: number;
}
```

LocalRepo 追加方法（SqlRepo 同步实现，SQL 全部幂等）：

```ts
  // nodes 锚点：TOFU 首落 + 更新（更新保留已配 authority_order，除非显式传值）。
  upsertNode(row: NodeRow, opts?: { keepAuthorityOrder?: boolean }): Promise<void>;
  getNode(nodeId: string): Promise<NodeRow | null>;
  listNodesByOrder(): Promise<NodeRow[]>; // authority_order ASC
  touchNode(nodeId: string, at: string): Promise<void>;
  // gossip 收件：event_id 先到先得；返回 false = 重复（幂等丢弃）。
  insertGossipEvent(row: GossipRow): Promise<boolean>;
  listGossipSince(cursorReceivedAt: number, cursorEventId: string, limit: number): Promise<GossipRow[]>;
  countGossip(): Promise<number>;
  /** 缓存上限（spec §4.2：500 条 / 7 天 LRU，双条件任一触顶驱逐最旧；已落本地库展示不受影响）。 */
  evictGossip(maxRows: number, maxAgeMs: number, now: number): Promise<number>;
  markGossipRelayed(eventId: string): Promise<void>;
```

实现要点：
- `upsertNode` keepAuthorityOrder 时 `ON CONFLICT DO UPDATE SET url=excluded.url, tls_fingerprint=excluded.tls_fingerprint, sign_pubkey=excluded.sign_pubkey, last_seen_at=excluded.last_seen_at`（不动 authority_order）。
- `listGossipSince` 游标体例同 event-sync：`WHERE (received_at > ?) OR (received_at = ? AND event_id > ?) ORDER BY received_at ASC, event_id ASC LIMIT ?`。
- `evictGossip`：`DELETE FROM gossip_events WHERE event_id IN (SELECT event_id FROM gossip_events ORDER BY received_at DESC, event_id DESC LIMIT -1 OFFSET ?)`（保留最新 maxRows 条）+ `DELETE FROM gossip_events WHERE received_at < ?`；两删合计返回数。

- [ ] **Step 5: repo.test.ts 用例**

1. upsertNode 首落/更新（keepAuthorityOrder=true 不覆盖已配序位）。
2. insertGossipEvent 同 id 两次 → 第二次 false；listGossipSince 游标翻页不重不漏。
3. evictGossip：灌 600 条 → 收敛 500；旧于 7 天被逐。
4. markGossipRelayed 后 relayed=1。
5. items.conflicted 老库补列（PRAGMA 断言）。

- [ ] **Step 6: 跑包测试**

Run: `npm test -w @base/core-ts; npm run typecheck -w @base/core-ts`
Expected: 全绿。

- [ ] **Step 7: Commit**

```powershell
git add packages/core-ts/src/repo.ts packages/core-ts/src/repo.test.ts packages/core-ts/src/platform/index.ts packages/core-ts/src/schema-check.test.ts
git commit -m "feat(core-ts): local nodes/gossip_events tables + items.conflicted"
```

---

## Task 4: mesh 协议核（catalog 构建/合并 + gossip 消息 + 六接口客户端）

**Files:**
- Create: `packages/core-ts/src/mesh/catalog.ts`
- Create: `packages/core-ts/src/mesh/gossip.ts`
- Create: `packages/core-ts/src/mesh/client.ts`
- Create: `packages/core-ts/src/mesh/catalog.test.ts`
- Create: `packages/core-ts/src/mesh/gossip.test.ts`
- Create: `packages/core-ts/src/mesh/client.test.ts`
- Modify: `packages/core-ts/src/index.ts`（导出 mesh/*）

- [ ] **Step 1: catalog.ts（构建 + 合并 + 仲裁）**

```ts
// mesh catalog 构建/合并/仲裁（spec §2.2 断网区铁律 + §3.3/§3.4）。
import { verifyMeshCatalog, type MeshCatalogDoc, type MeshCatalogEntry } from '@base/protocol-ts';
import type { LocalRepo } from '../repo';

/** 源端构建 entries：items(active) × blob_index 聚合 size（禁 N+1，单条 GROUP BY）。 */
export async function buildMeshCatalogEntries(repo: LocalRepo): Promise<MeshCatalogEntry[]> {
  const rows = await (repo as unknown as { select: (sql: string, p?: unknown[]) => Promise<Record<string, unknown>[]> })
    .select(
      `SELECT i.item_id AS item_id, i.source_rev AS source_rev, i.content_hash AS content_hash,
              COALESCE(SUM(b.size), 0) AS total_size
       FROM items i LEFT JOIN blob_index b ON b.item_id = i.item_id
       WHERE i.state = 'active'
       GROUP BY i.item_id ORDER BY i.item_id ASC`,
    );
  return rows.map((r) => ({
    item_id: String(r.item_id),
    rev: parseRev(String(r.source_rev ?? '')),
    content_hash: String(r.content_hash),
    size: Number(r.total_size ?? 0),
  }));
}

export function parseRev(sourceRev: string): number {
  const n = Number.parseInt(sourceRev, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** 验签集合内任一公钥通过即可（spec §1.2）。 */
export function verifyCatalogPubs(doc: MeshCatalogDoc, pubs: string[]): boolean {
  return pubs.some((p) => verifyMeshCatalog(doc, p));
}

export interface MergeDecision {
  itemId: string;
  action: 'fetch' | 'current' | 'conflicted' | 'rev_regression';
  remoteRev: number;
}

/**
 * 目录合并（spec §3.4 步骤 3/5）：
 * - 远端 rev > 本地 rev → fetch；
 * - rev 相等且 content_hash 相等 → current；
 * - rev 相等、hash 异 → 本地保留 + conflicted=1（终局仲裁在 Task 7 arbitrateCatalogEntry）；
 * - 远端 rev < 本地 rev → rev_regression（拒绝，签名合法的回退只可能来自根密钥泄露 → 全屏告警）。
 */
export async function mergeMeshCatalog(
  repo: LocalRepo,
  entries: MeshCatalogEntry[],
): Promise<MergeDecision[]> {
  const out: MergeDecision[] = [];
  for (const e of entries) {
    const local = await repo.getItem(e.item_id);
    const localRev = local ? parseRev(local.rev) : -1;
    if (!local) {
      out.push({ itemId: e.item_id, action: 'fetch', remoteRev: e.rev });
    } else if (e.rev > localRev) {
      out.push({ itemId: e.item_id, action: 'fetch', remoteRev: e.rev });
    } else if (e.rev === localRev) {
      if (local.contentHash === e.content_hash) {
        out.push({ itemId: e.item_id, action: 'current', remoteRev: e.rev });
      } else {
        await repo.markItemConflicted(e.item_id);
        out.push({ itemId: e.item_id, action: 'conflicted', remoteRev: e.rev });
      }
    } else {
      out.push({ itemId: e.item_id, action: 'rev_regression', remoteRev: e.rev });
    }
  }
  return out;
}
```

`LocalRepo` 需补 `markItemConflicted(itemId: string): Promise<void>`（`UPDATE items SET conflicted=1 WHERE item_id=?`；Task 3 已加列）与 `getItem` 已有（`ItemRow.rev`/`contentHash` 字段名以现有 types.ts 为准，子代理核对后落地）。

- [ ] **Step 2: gossip.ts（消息形状 + 验证 + 白名单）**

```ts
// gossip 消息（spec §4.2 写死）：event 原样 + actor_pubkey + payload_b64。
// 一期只接受 comment.v1，其余类型静默丢弃。
import { blobId, canonicalize, verify, utf8, type Json } from '@base/protocol-ts';

export const GOSSIP_TYPES: ReadonlySet<string> = new Set(['comment.v1']);
export const GOSSIP_CACHE_MAX_ROWS = 500;
export const GOSSIP_CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export interface GossipMessage {
  event: { event_id: string; type: string; created_at: number; body: Json; sig: string };
  actor_pubkey: string;
  payload_b64: string;
}

export interface GossipVerified {
  msg: GossipMessage;
  payloadCid: string;
  payloadText: string;
}

/** 验 sig（canonical({event_id,type,created_at,body})，总纲 §7.3 逐字）+ 类型白名单；非法返回 null（静默丢）。 */
export function verifyGossipMessage(msg: unknown): GossipVerified | null {
  if (msg === null || typeof msg !== 'object') return null;
  const m = msg as Partial<GossipMessage>;
  const ev = m.event;
  if (!ev || typeof ev !== 'object') return null;
  if (typeof ev.event_id !== 'string' || !/^[0-9a-f]{16}$/.test(ev.event_id)) return null;
  if (!GOSSIP_TYPES.has(ev.type)) return null;
  if (!Number.isInteger(ev.created_at) || (ev.created_at as number) <= 0) return null;
  if (typeof ev.sig !== 'string' || ev.sig.length !== 128) return null;
  if (typeof m.actor_pubkey !== 'string' || m.actor_pubkey.length !== 64) return null;
  if (typeof m.payload_b64 !== 'string') return null;
  let ok: boolean;
  let payloadText = '';
  try {
    const bytes = Uint8Array.from(atob(m.payload_b64), (c) => c.charCodeAt(0));
    payloadText = new TextDecoder().decode(bytes);
    ok = verify(m.actor_pubkey, utf8(canonicalize({ event_id: ev.event_id, type: ev.type, created_at: ev.created_at, body: ev.body as Json })), ev.sig);
    if (blobId(bytes) !== voidVerify(payloadCidOf(m))) ok = false;
  } catch {
    return null;
  }
  if (!ok) return null;
  return { msg: m as GossipMessage, payloadCid: payloadCidOf(m), payloadText };
}

// payload_cid = blobId(payload 明文)——上面 voidVerify/payloadCidOf 由实现内联展开（不引入这两个名字）：
// 实现时直接：const cid = blobId(bytes); if (m.payload_cid_expected !== undefined) ... 一期简化为
// verifyGossipMessage 返回 { payloadCid: blobId(bytes), payloadText }，块哈希在落库时自证。
```

**注意：上段伪行（voidVerify/payloadCidOf）是实现提示，落地时删除**，最终形状：

```ts
export function verifyGossipMessage(msg: unknown): GossipVerified | null {
  // 1) 形态校验（同上）；
  // 2) bytes = base64 decode(payload_b64)，payloadText = utf8 解码（老 WebView 无 TextDecoder 时用 core/sync.ts 的 decodeUtf8）；
  // 3) payloadCid = blobId(bytes)；
  // 4) sig 验签：verify(actor_pubkey, utf8(canonicalize({event_id,type,created_at,body})), sig)；
  // 5) 任一步失败 → null（静默丢弃，不断连）。
}
```

- [ ] **Step 3: client.ts（六接口客户端，跑在接收端/双向 gossip）**

```ts
// mesh 六接口客户端（spec §3.3）。HttpAdapter 明文局域网请求（manifest cleartext 放行）。
import { sha256Hex, utf8 } from '@base/protocol-ts';
import { decodeUtf8 } from '../sync';
import type { Adapters } from '../platform/adapter';
import { verifyCatalogPubs } from './catalog';
import type { MeshCatalogDoc, MeshCatalogEntry } from '@base/protocol-ts';

export interface MeshHello {
  node_id: string;
  sign_pubkey: string;
  protocol_version: number;
  catalog_version: number;
  gossip_cursor: string;
}

export class MeshClient {
  constructor(private readonly http: Adapters['http']) {}

  async hello(baseUrl: string, token: string): Promise<MeshHello> {
    const res = await this.http.get(`${baseUrl}/mesh/v1/hello?token=${encodeURIComponent(token)}`);
    if (res.status === 403) throw new Error('mesh_token_rejected');
    if (res.status !== 200) throw new Error(`mesh_hello_failed: HTTP ${res.status}`);
    const h = JSON.parse(decodeUtf8(res.body)) as MeshHello;
    if (h.protocol_version !== 1) throw new Error('mesh_protocol_version_unsupported');
    return h;
  }

  /** 分页拉全 entries（体例沿用 /v1/catalog：cursor=最后 item_id），拉完用全量验签（执行期定案 3）。 */
  async pullCatalog(baseUrl: string, token: string, verifyPubs: string[]): Promise<MeshCatalogDoc> {
    const entries: MeshCatalogEntry[] = [];
    let catalogVersion = 0;
    let signedAt = '';
    let nodeId = '';
    let signature = '';
    let cursor: string | null = null;
    for (;;) {
      const q = [`token=${encodeURIComponent(token)}`];
      if (cursor !== null) q.push(`cursor=${encodeURIComponent(cursor)}`);
      const res = await this.http.get(`${baseUrl}/mesh/v1/catalog?${q.join('&')}`);
      if (res.status !== 200) throw new Error(`mesh_catalog_failed: HTTP ${res.status}`);
      const page = JSON.parse(decodeUtf8(res.body)) as {
        node_id: string; catalog_version: number; signed_at: string; signature: string;
        entries: MeshCatalogEntry[]; next_cursor: string | null;
      };
      nodeId = page.node_id; catalogVersion = page.catalog_version;
      signedAt = page.signed_at; signature = page.signature;
      entries.push(...(page.entries ?? []));
      const next = page.next_cursor ?? null;
      if (next === null) break;
      if (next === cursor) throw new Error('mesh_catalog_pagination_stuck');
      cursor = next;
    }
    const doc: MeshCatalogDoc = {
      type: 'mesh-catalog', v: 1, node_id: nodeId, catalog_version: catalogVersion,
      entries, signed_at: signedAt, signature,
    };
    if (!verifyCatalogPubs(doc, verifyPubs)) throw new Error('mesh_catalog_sig_invalid');
    return doc;
  }

  async headBlob(baseUrl: string, token: string, blobIdHex: string): Promise<boolean> {
    const res = await this.http.get(`${baseUrl}/mesh/v1/blob/${blobIdHex}?token=${encodeURIComponent(token)}&probe=1`);
    return res.status === 200;
  }

  /** 取块 + sha256 自证；失败重拉一次，再失败抛错（调用方标记坏块跳过）。 */
  async fetchBlob(baseUrl: string, token: string, blobIdHex: string): Promise<Uint8Array> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.http.get(`${baseUrl}/mesh/v1/blob/${blobIdHex}?token=${encodeURIComponent(token)}`);
      if (res.status === 200 && sha256Hex(res.body) === blobIdHex) return res.body;
    }
    throw new Error(`mesh_blob_invalid: ${blobIdHex}`);
  }

  async postGossip(baseUrl: string, token: string, messages: unknown[]): Promise<void> {
    const body = utf8(JSON.stringify({ messages }));
    const res = await this.http.post(`${baseUrl}/mesh/v1/gossip?token=${encodeURIComponent(token)}`, body, {
      'Content-Type': 'application/json',
    });
    if (res.status !== 200) throw new Error(`mesh_gossip_post_failed: HTTP ${res.status}`);
  }

  /** 增量拉 gossip：since=<received_at>_<event_id>（体例同 event-sync）。 */
  async fetchGossip(baseUrl: string, token: string, since: string): Promise<unknown[]> {
    const res = await this.http.get(`${baseUrl}/mesh/v1/gossip?token=${encodeURIComponent(token)}&since=${encodeURIComponent(since)}`);
    if (res.status !== 200) throw new Error(`mesh_gossip_fetch_failed: HTTP ${res.status}`);
    const page = JSON.parse(decodeUtf8(res.body)) as { messages?: unknown[]; next_cursor?: string | null };
    return page.messages ?? [];
  }
}
```

（HEAD 语义：HttpAdapter 只有 get/post——`headBlob` 用 `probe=1` 的 GET 轻量探测，server 侧识别 `probe=1` 只回 200/404 不带 body。此为执行期定案 5：**HEAD 用 GET probe 等价替代**，`Connection: close` 下省一次连接重建。）

- [ ] **Step 4: 测试（fakes 注入）**

`catalog.test.ts`：
1. buildMeshCatalogEntries：两 item、blob_index 各若干行 → size 聚合正确、inactive 排除。
2. mergeMeshCatalog：新条目 fetch / 同 rev 同 hash current / 同 rev 异 hash conflicted=1 / 低 rev rev_regression。

`gossip.test.ts`：
1. 正例：真签名（`sign(seed, utf8(canonicalize(payload)))`）+ base64 payload → 通过且 payloadCid=blobId。
2. 篡改 body 1 字节 → null。
3. `type='like.v1'` → null（静默丢）。
4. actor_pubkey 换人 → null。

`client.test.ts`：用 fakes 的 http adapter（`packages/core-ts/src/fakes.ts` 已有 FakeHttp 则复用；没有则就地造 20 行 fake）覆盖：hello 403 抛错；catalog 三页拼接后验签成功、篡改任一页 entries 验签失败；fetchBlob 坏块重拉一次后抛错。

- [ ] **Step 5: 跑包测试**

Run: `npm test -w @base/core-ts; npm run typecheck -w @base/core-ts`
Expected: 全绿。

- [ ] **Step 6: Commit**

```powershell
git add packages/core-ts/src/mesh packages/core-ts/src/index.ts
git commit -m "feat(core-ts): mesh catalog build/merge, gossip verify, six-endpoint client"
```

---

## Task 5: NIO server + 源端分享页 + 接收端入网页（mobile）

**Files:**
- Create: `apps/mobile/src/mesh/nio-server.ts`
- Create: `apps/mobile/src/mesh/share.ts`
- Create: `apps/mobile/src/mesh/sign-key.ts`
- Create: `apps/mobile/src/pages/mesh/share.vue`
- Create: `apps/mobile/src/pages/mesh/receive.vue`
- Modify: `apps/mobile/src/pages.json`（注册两页）
- Modify: `apps/mobile/src/manifest.json`（versionCode 47→48 + cleartext）
- Delete: `apps/mobile/src/pages/dev/nearby-spike.vue`（pages.json 同步移除注册项）

- [ ] **Step 1: nio-server.ts（手写 HTTP 最小子集，NIO 三铁律逐字沿用 spike）**

从 `apps/mobile/src/pages/dev/nearby-spike.vue:142-215` 提炼，替换 serve 为路由分发。骨架（完整实现按此展开）：

```ts
// 手写 HTTP（spec §3.2）：GET/POST/HEAD；request line + \r\n headers；Content-Length 截 body。
// 响应三要素：Connection: close + Content-Length + Range 单区间（206 + Content-Range）。
// NIO 铁律（spike 定案）：①accept() null 静默轮询 200ms；②importClass 先行；③close 前排空入站。
export interface MeshRouteCtx {
  method: string;
  path: string;        // /mesh/v1/hello
  query: URLSearchParamsLike; // 手写解析：a=1&b=2 → Record<string,string>（老 WebView 无 URLSearchParams）
  body: Uint8Array;
}
export type MeshRouteHandler = (ctx: MeshRouteCtx) => { status: number; body: Uint8Array; contentType?: string } | null;

export const MESH_PORT = 8712;

export function startMeshServer(handlers: Record<string, MeshRouteHandler>, opts: {
  token: string;
  onLog?: (msg: string) => void;
  maxConns?: number; // 总并发上限 8（spec §3.2/S7）
}): { stop: () => void } {
  // startServer（nearby-spike.vue:169-200 同款）：StrictMode 放行 + importClass + bind(:8712) + setInterval(pollAccept, 200)
  // pollAccept：ch = ssc.accept(); ch 为 null 静默 return；否则 serveChannel(ch)
  // serveChannel(ch)：
  //   1) 读循环 rxBuf(8KB)：收满「\r\n\r\n 头部结束 + Content-Length 字节」或 8KB 上限/连接关；
  //      解析失败（非 GET/POST/HEAD 或无 request line）→ 排空后 ch.close()（不回错，spec §3.2）
  //   2) 路由 key = `${method} ${path}`；query 解析后进 ctx
  //   3) hello/catalog 须 token 校验：query.token !== opts.token → 403（计数：同远端 5 次失败锁 600s；
  //      远端取 ch.getRemoteAddress() 字符串前缀，异常降级 ""）
  //   4) 响应写回：status line + Content-Type + Content-Length + Connection: close + \r\n\r\n + body
  //      blob 路由支持 Range: bytes=start-end（单区间，命中回 206 + Content-Range: bytes s-e/total）
  //   5) 写完 ch.read(rxBuf) 一次排空入站（RST 教训），再 ch.close()
  //   6) 并发计数：activeConns ≥ 8 时 accept 到的直接 close
}
```

实现须遵守：所有 Java 类先 `plus.android.importClass(...)`；`ByteBuffer.allocate/wrap`；body 与响应均 `java.lang.String(...).getBytes('UTF-8')` 或 `ByteBuffer.wrap(uint8ArrayToJavaBytes)`（用 `java.nio.ByteBuffer` + `array()` 往返时注意签名；**推荐**：响应体统一先在 JS 侧 `String.fromCharCode` 成 latin1 字符串再 getBytes('UTF-8') 仅用于 UTF-8 文本；二进制块用 `ByteBuffer.wrap(javaByteArray)`，javaByteArray 由 `java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, len)` 填充——spike 已验证字符串路径，二进制路径以真机自检页验证）。

- [ ] **Step 2: sign-key.ts（mesh 信任锚私钥存储）**

复用 `core/identity.ts` 的 KEK 存储模式（`deviceKek` + AES 存储）：`loadMeshSignKey() / saveMeshSignKey(seedHex)`，storage key `mesh.sign_key`；另存 `mesh.node_id`（= 节点 id，hex32，部署者录入或从 sign_pubkey 派生——**定案**：node_id = deriveIdentityId(sign_pubkey)，同 identity 派生规则，减少一个录入项）。

- [ ] **Step 3: share.ts（源端会话）**

```ts
// 源端「开始分享」会话（spec §3.3 token 30min 续签 / §0.3 亮屏插电约束）。
import { bytesToHex, randomBytes } from '@base/protocol-ts';

export function newShareToken(): string {
  return bytesToHex(randomBytes(32));
}

/** 二维码/配对码内容：enroll canonical JSON + token + 近场地址（执行期定案 1）。 */
export function buildShareCode(input: {
  nodeId: string; url: string; signPubkey: string; tlsFingerprint: string;
  token: string; ip: string; port: number; expiresAt: string;
}): string {
  return JSON.stringify({
    v: 1, kind: 'base-node-enroll',
    node_id: input.nodeId, url: input.url,
    sign_pubkey: input.signPubkey, tls_fingerprint: input.tlsFingerprint,
    expires_at: input.expiresAt, token: input.token,
    mesh_ip: input.ip, mesh_port: input.port,
  });
}
```

（`mesh_ip/mesh_port` 为入网扩展字段——enroll 解析侧 `parseNodeEnroll` 不认识的键直接忽略其 schema 校验，接收端另行读取；规格上属二维码承载，不入签名体系。）

- [ ] **Step 4: pages/mesh/share.vue（源端页）**

- 前置条件区：`plus.device.setWakelock(true)` 开关（默认开）+ 充电检测（`plus.device.getBatteryInfo()`：`isCharging` false → 阻塞提示「请插电后分享」；`level < 20` → 非阻塞提示）。
- 「开始分享」：生成 token（30min 有效，`setInterval` 到期续签并提示）、`startMeshServer`（挂六接口 handler，见 Step 6）、展示配对码文本（`buildShareCode` 输出，textarea + 复制按钮 `uni.setClipboardData`）+ 本机 IP（`plus.networkinfo.getCurrentIPAddress()`）。
- 状态区：连接数、gossip 收发计数、日志（spike 的 logs 样式）。
- 离开页面 `onUnmounted` → stop + wakelock(false)。

- [ ] **Step 5: pages/mesh/receive.vue（接收端页）**

- 输入配对码（textarea 粘贴）或 `uni.scanCode`（扫码结果同 JSON——执行期定案 1 双通道）。
- 解析：`parseNodeEnroll`（校验失败 → 提示拒收）；读 `mesh_ip/mesh_port` 得 `http://<ip>:<port>`。
- TOFU：repo.getNode(node_id) → 有：比对 sign_pubkey 不匹配 → `uni.showModal` 全屏告警（换锚攻击）并中止；无：`uni.showModal('新节点，确认信任？')` 确认后 `upsertNode`（authorityOrder 默认 2147483647）。
- `hello` → 失败锁提示；`pullCatalog`（verifyPubs=[锚 sign_pubkey]）→ `mergeMeshCatalog` → 对 fetch 项并发 4 下载缺失块（`fetchBlob` → 写 `_doc/blobs/<b0>/<b2>/<blob_id>`（plus.io）→ blob_index 落行：复用 repo 既有块落库函数，若无则在 repo 补 `saveLocalBlob(blobId, path, size, itemId)`）→ 全部完成后 `uni.showToast('同步完成')`。
- 进度：已下载块数 / 总数。

- [ ] **Step 6: 六接口 server handler 接线（share.vue 内组装）**

| 路由 | 行为 |
|---|---|
| `GET /mesh/v1/hello` | token 校验后回 `{node_id, sign_pubkey, protocol_version:1, catalog_version, gossip_cursor}`（gossip_cursor = 本端 gossip 收件最新 `<received_at>_<event_id>`，空表 `0_`） |
| `GET /mesh/v1/catalog` | `buildMeshCatalogEntries` + `signMeshCatalog`（sign-key 私钥）；一期全量单页（entries < 1000 不分页，next_cursor=null；超 1000 按 item_id 切页） |
| `GET /mesh/v1/blob/:id` | 读 `_doc/blobs/...` 文件回字节；支持 Range；`probe=1` 回 200/404 空 body |
| `POST /mesh/v1/gossip` | `verifyGossipMessage` 逐条：通过 → `insertGossipEvent` + payload 落盘；失败静默丢 |
| `GET /mesh/v1/gossip` | `listGossipSince(since)` → `{messages, next_cursor}`；`since` 缺省 `0_` |

- [ ] **Step 7: pages.json 注册 + 删 spike + manifest**

pages.json 追加（pages 数组尾）：

```json
{ "path": "pages/mesh/share", "style": { "navigationBarTitleText": "近场分享" } },
{ "path": "pages/mesh/receive", "style": { "navigationBarTitleText": "近场接收" } }
```

移除 `pages/dev/nearby-spike` 注册项并删除该文件。manifest.json：`versionCode` 47→48；`app-plus.distribute.android` 追加 `"usesCleartextTraffic": true`（HBuilderX 云打包 manifest 源码视图键）。

- [ ] **Step 8: typecheck + 全量测试**

Run: `npm run typecheck -w @base/mobile; npm test`
Expected: typecheck 无**新增**错误（既有册外 `.vue` 错误照旧）；测试全绿（mobile 测试不覆盖 plus 真机路径，靠 core-ts 单测 + 真机验收）。

- [ ] **Step 9: Commit**

```powershell
git add apps/mobile/src/mesh apps/mobile/src/pages/mesh apps/mobile/src/pages.json apps/mobile/src/manifest.json
git rm apps/mobile/src/pages/dev/nearby-spike.vue
git commit -m "feat(mobile): mesh NIO server + share/receive pages, drop R2 spike"
```

---

## Task 6: gossip 收发 + 缓存 + 回连代上报接线

**Files:**
- Create: `apps/mobile/src/mesh/gossip-engine.ts`
- Create: `apps/mobile/src/mesh/relay.ts`
- Modify: `apps/mobile/src/core/sync`（sync 成功后触发 relay flush——找 `packages/core-ts/src/sync.ts` 的调用方 `apps/mobile/src/core/` 内 sync 触发点接线）

- [ ] **Step 1: gossip-engine.ts（收发引擎，接收端/源端共用）**

```ts
// gossip 收发（spec §4.2）：收 → 验 → 落 gossip_events + payload 落盘 + blob_index；
// 发 → comment_out(queued) 转 gossip 消息 + 收件缓存按 since 增量交换。
import { blobId, bytesToHex, utf8 } from '@base/protocol-ts';
import { decodeUtf8 } from '@base/core-ts';
import { verifyGossipMessage, GOSSIP_CACHE_MAX_ROWS, GOSSIP_CACHE_MAX_AGE_MS, type GossipMessage } from '@base/core-ts';
import type { Adapters, LocalRepo } from '@base/core-ts';

/** 收一条 gossip：验签 → payload 写 <workDir>/gossip/<payload_cid> → insertGossipEvent（先到先得）。 */
export async function ingestGossip(input: {
  adapters: Adapters; repo: LocalRepo; workDir: string; msg: unknown; now: number;
}): Promise<'stored' | 'duplicate' | 'rejected'> {
  const v = verifyGossipMessage(input.msg);
  if (v === null) return 'rejected';
  const path = `${input.workDir}/gossip/${v.payloadCid}`;
  await writeFileSafe(input.adapters, path, utf8(v.payloadText)); // plus.io：mkdir 递归 + write，已存在跳过
  const ok = await input.repo.insertGossipEvent({
    eventId: v.msg.event.event_id, type: v.msg.event.type,
    targetId: String((v.msg.event.body as Record<string, unknown>).target_id ?? ''),
    actor: bytesToHex(new Uint8Array(0)) === '' ? actorIdOf(v.msg.actor_pubkey) : '',
    createdAt: v.msg.event.created_at, receivedAt: input.now,
    payloadCid: v.payloadCid, payloadPath: path, sig: v.msg.event.sig, relayed: 0,
  });
  if (!ok) return 'duplicate';
  await input.repo.evictGossip(GOSSIP_CACHE_MAX_ROWS, GOSSIP_CACHE_MAX_AGE_MS, input.now);
  return 'stored';
}

// actorIdOf(pubHex)：与 core/identity 的 deriveIdentityId 同规则（sha256? 派生算法以 protocol-ts identity.ts 为准，
// 直接 import { deriveIdentityId } from '@base/protocol-ts' 使用，勿重写）。
// 上面的三元占位是防笔误提示，落地时：actor: deriveIdentityId(v.msg.actor_pubkey)。

/** 本端待交换消息集：本机 comment_out(queued/state='pending') 转消息 + 收件缓存增量。 */
export async function outgoingGossip(input: { repo: LocalRepo; myPubHex: string; since: string }): Promise<GossipMessage[]> {
  // 1) comment_out 行（state 未发送）：body = {target_id, text, reply_to?}，payload_b64 = base64(text)，
  //    sig 取 wire 内 sig，event 三元组取 wire 内字段；received_at 语义=created_at（spec §4.2）
  // 2) gossip_events since 游标行：body 从 payload_path 读文件重建（{target_id, text, reply_to}），
  //    actor_pubkey 需查 identities——本地无 identities 表 → gossip_events 存 actor(id) 而非 pubkey，
  //    一期转发以 actor_pubkey 缺失为限：**转发只转本机所发**（comment_out），
  //    收件缓存转发列入二期（登记执行期定案 6：spec §4.2「每端转发缓存 500/7 天」的转发面后置，
  //    收件缓存保留面已实现，供回连代报与本地展示用）
}
```

（执行期定案 6 的理由：gossip_events 未存 actor_pubkey（表已定型，id 可由 pubkey 派生但逆推不可行）；补 pubkey 列属二期 schema 变更，一期不 bump。）

- [ ] **Step 2: relay.ts（回连代上报，spec §4.3）**

```ts
// 回连代上报：两路并行。
// 路 1 本机所发：沿用 core comment 的补发路径（sendComment wire 重放，不带 Relay 头）。
// 路 2 代报：gossip_events(relayed=0) 逐条 POST /v1/event，事件体原样
//   {event_id,type,created_at,body,sig}，body 从 payload_path 读回重建（{target_id,text,reply_to?}），
//   带 X-Base-Relay-For: <actor> 与 X-Base-Relay-Device: <myId>；请求签名头 = 本机身份
//   （signRequestHeaders(ident, {method:'POST', path:'/v1/event', body})）。
export async function flushRelay(input: { adapters: Adapters; repo: LocalRepo; nodeBaseUrl: string }): Promise<{
  ownSent: number; relaySent: number; failed: number;
}> {
  // 幂等：节点按 event_id 去重；代报成功（200）→ markGossipRelayed(eventId)。
  // 风控同权：节点 4xx/5xx 记 failed，不重试死循环（下次回连再试 relayed=0 行）。
}
```

（body 重建注意：事件 body 必须与原签名字节一致——gossip 侧 `{target_id,text,reply_to?}` 键集与 comment_out wire 相同；reply_to 空时不补键，与 `buildCommentWire`（comment.ts:221-228）一致。）

- [ ] **Step 3: 接线触发点**

在 mobile 既有 sync 成功路径后调用 `flushRelay`（grep `fetchCatalog|syncFromNode|performSync` 找 mobile 侧调用点，于其成功分支追加 `flushRelay(...).catch(() => {})`——不阻塞 UI）；近场在线期间（share/receive 页面存活时）每 30s 一轮 `outgoingGossip → postGossip` 与 `fetchGossip → ingestGossip` 双向交换。

- [ ] **Step 4: typecheck + 测试**

Run: `npm run typecheck -w @base/mobile; npm run typecheck -w @base/core-ts; npm test`
Expected: 通过。gossip 引擎纯逻辑部分（outgoingGossip 的 wire→消息转换）若可注入 fakes 则补 core-ts 单测；plus 依赖部分靠真机验收（Task 8 场景）。

- [ ] **Step 5: Commit**

```powershell
git add apps/mobile/src/mesh/gossip-engine.ts apps/mobile/src/mesh/relay.ts apps/mobile/src/core
git commit -m "feat(mobile): gossip ingest/outgoing + reconnect relay reporting"
```

---

## Task 7: 权威序 failover + 仲裁

**Files:**
- Create: `packages/core-ts/src/mesh/authority.ts`
- Create: `packages/core-ts/src/mesh/authority.test.ts`
- Modify: `packages/core-ts/src/index.ts`（导出）
- Modify: `packages/core-ts/src/mesh/catalog.ts`（mergeMeshCatalog 接仲裁函数）

- [ ] **Step 1: authority.ts**

```ts
// 多节点权威序（spec §2.2）：写序 = 只写序首可达；读序 = 序首超时 3s 才 failover。
// 断网区仲裁铁律（spec §2.2 写死）：rev 高者 → 签名者 authority_order 小者 → content_hash 字典序。
import type { LocalRepo, NodeRow } from '../repo';

export const READ_FAILOVER_TIMEOUT_MS = 3000;

/** authority_order ASC（缺省 2147483647 = +∞ 语义；未知节点视作序位 +∞，spec §2.2）。 */
export function sortNodesByAuthority(rows: NodeRow[]): NodeRow[] {
  return [...rows].sort((a, b) => a.authorityOrder - b.authorityOrder);
}

export interface WriteOutcome { nodeId: string; degradedFrom: string | null }

/**
 * 写路径：逐序位探测（探测函数由调用方注入，通常 = hello 或 HEAD /healthz）；
 * 序 1 可达只写序 1；写失败降级序 2 且记录降级（degradedFrom）。
 */
export async function pickWriteNode(input: {
  repo: LocalRepo;
  probe: (node: NodeRow) => Promise<boolean>;
  write: (node: NodeRow) => Promise<boolean>; // 真写；false = 该节点写失败
}): Promise<WriteOutcome | null> {
  const nodes = sortNodesByAuthority(await input.repo.listNodesByOrder());
  let degradedFrom: string | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (!(await input.probe(n))) continue;
    if (i > 0 && degradedFrom === null) degradedFrom = nodes[0]!.nodeId;
    if (await input.write(n)) return { nodeId: n.nodeId, degradedFrom };
    if (degradedFrom === null) degradedFrom = nodes[0]!.nodeId;
  }
  return null;
}

export interface CatalogCandidate {
  rev: number;
  contentHash: string;
  signerAuthorityOrder: number; // 未知节点 = 2147483647
}

/** 断网区仲裁（spec §2.2 铁律 1-3，确定性收尾）。返回胜者索引；平局不可能（hash 字典序全序）。 */
export function arbitrateCatalogEntry(candidates: CatalogCandidate[]): number {
  let best = 0;
  for (let i = 1; i < candidates.length; i++) {
    const a = candidates[best]!;
    const b = candidates[i]!;
    if (b.rev > a.rev) best = i;
    else if (b.rev === a.rev) {
      if (b.signerAuthorityOrder < a.signerAuthorityOrder) best = i;
      else if (b.signerAuthorityOrder === a.signerAuthorityOrder && b.contentHash > a.contentHash) best = i;
    }
  }
  return best;
}
```

- [ ] **Step 2: mergeMeshCatalog 接仲裁**

`catalog.ts` 的 `conflicted` 分支改为：同 rev 异 hash 时若调用方提供了候选（`mergeMeshCatalog(repo, entries, opts?: { arbitrate?: boolean })`），两候选（本地 vs 远端）走 `arbitrateCatalogEntry`：
- 远端胜 → action `'fetch'`（覆盖写入）；
- 本地胜 → action `'conflicted'`（保留本地 + conflicted=1 + UI 弱提示「内容已在权威节点修正」由页面按 conflicted 列渲染）。
rev 回退（rev_regression）恒拒绝，不分仲裁。

- [ ] **Step 3: 测试**

1. sortNodesByAuthority：乱序 + 两个缺省值 → 稳定升序。
2. pickWriteNode：序 1 可达 → 只调 write(序1)（spy 断言序 2 未被调用）；序 1 probe 失败 → 降级序 2 且 degradedFrom=序1；全失败 → null。
3. arbitrateCatalogEntry：
   - rev 高者胜（3 候选乱序）；
   - 同 rev：序位小胜；
   - 同 rev 同序位：hash 字典序大者胜（确定性）；
4. mergeMeshCatalog 接仲裁：远端序位小 → fetch 覆盖；本地序位小 → conflicted。

- [ ] **Step 4: 跑包测试**

Run: `npm test -w @base/core-ts; npm run typecheck -w @base/core-ts`
Expected: 全绿。

- [ ] **Step 5: Commit**

```powershell
git add packages/core-ts/src/mesh/authority.ts packages/core-ts/src/mesh/authority.test.ts packages/core-ts/src/mesh/catalog.ts packages/core-ts/src/index.ts
git commit -m "feat(core-ts): authority-order failover write path + mesh arbitration"
```

---

## Task 8: Go oracle 对拍 + 门禁 + 总纲回写 + README 登记

**Files:**
- Create: `tools/meshoracle/main.go`
- Modify: `docs/superpowers/specs/2026-09-25-base-distributed-learning-design.md`（§8 回写清单）
- Modify: `docs/README.md`（#82 行执行实况更新）
- Modify: `docs/superpowers/plans/2026-10-17-base-mesh-realtime-phase1-plan.md`（本册执行实况，如有偏差登记）

- [ ] **Step 1: tools/meshoracle/main.go（Go consumer 侧对拍）**

```go
// Command meshoracle 对拍 mesh 向量（Go consumer 侧，spec §3.8）。
// 用法：go run ./tools/meshoracle -vectors vectors/v1/mesh.json
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/johocn/base/internal/protocol"
)

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		fail(fmt.Errorf("bad hex: %v", err))
	}
	return b
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "meshoracle:", err)
	os.Exit(1)
}

func main() {
	vpath := flag.String("vectors", filepath.FromSlash("vectors/v1/mesh.json"), "向量文件")
	flag.Parse()
	raw, err := os.ReadFile(*vpath)
	if err != nil {
		fail(err)
	}
	var f struct {
		Version int `json:"version"`
		Key     struct {
			RootSeedHex   string `json:"root_seed_hex"`
			RootPubHex    string `json:"root_pub_hex"`
			WorkingSeedHex string `json:"working_seed_hex"`
			WorkingPubHex string `json:"working_pub_hex"`
		} `json:"key"`
		Rotation struct {
			Doc       json.RawMessage `json:"doc"`
			CertID    string          `json:"cert_id"`
			SignBytes string          `json:"sign_bytes"`
		} `json:"rotation"`
		Enroll struct {
			Doc       json.RawMessage `json:"doc"`
			Canonical string          `json:"canonical"`
		} `json:"enroll"`
		Catalog struct {
			Doc       json.RawMessage `json:"doc"`
			SignBytes string          `json:"sign_bytes"`
		} `json:"catalog"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		fail(err)
	}
	if f.Version != 1 {
		fail(fmt.Errorf("unsupported vectors version %d", f.Version))
	}
	checkKey(f.Key)
	checkRotation(f)
	checkEnroll(f)
	checkCatalog(f)
	fmt.Println("meshoracle: all vectors pass (rotation/enroll/catalog)")
}

// checkKey：seed→pub 与向量一致（RFC 8032 双钥）。
// checkRotation：protocol.Canonicalize(doc 去掉 signature) 与 SignBytes 逐字节相等；
//   ed25519.Verify(rootPub, canonicalBytes, sig) 成立；sha256(canonical)[0:16] hex == CertID。
// checkEnroll：protocol.Canonicalize(enroll.doc) == Canonical 字符串（enroll 无签名，锁 canonical 字节）。
// checkCatalog：同 rotation（working 钥验签）。
```

（Go 侧 canonical：`internal/protocol.Canonicalize` 输入为 `map[string]any`/`json.RawMessage` 反序列化值；doc 先 `json.Unmarshal` 进 `map[string]any`、**删 signature 键**再 Canonicalize。rev 为 JSON number → Go float64，Canonicalize 对整数值 float64 的输出形态须与 TS 一致——由 vectors 对拍直接验证，不一致即阻塞并修 Go 侧调用形态（如改用 json.Number 解码）。）

- [ ] **Step 2: 跑 oracle**

Run: `go run ./tools/meshoracle`
Expected: `meshoracle: all vectors pass (rotation/enroll/catalog)`，exit 0。

- [ ] **Step 3: 全量门禁**

Run: `npm test; npm run typecheck; go run ./tools/meshoracle; git diff --stat -- internal/`
Expected: 测试全绿；typecheck protocol-ts/core-ts/node 0 错误（mobile 仅册外既有 `.vue` 错误）；oracle exit 0；`internal/` 零改动。

- [ ] **Step 4: 总纲回写（spec §8 清单）**

`docs/superpowers/specs/2026-09-25-base-distributed-learning-design.md`：
1. §8.4 末补一句：「近场互传定案见 `2026-10-17-base-mesh-community-design.md`；一期范围 = 其实时面（C1）。」
2. §7.3 `POST /v1/event` 小节补：代报审计头 `X-Base-Relay-For` / `X-Base-Relay-Device` 与 events 表 `relay_channel` / `relay_device_id` 两列（M3，留存 ≥6 个月）。
3. §8.1 本地表清单补：`nodes(node_id, url, tls_fingerprint, sign_pubkey, authority_order, last_seen_at)`、`gossip_events(event_id, type, target_id, actor, created_at, received_at, payload_cid, payload_path, sig, relayed)`。
4. §10 C 阶段拆分：C1 = mesh 一期实时面；C2 = mesh 二期降级面（快照）。

- [ ] **Step 5: README #82 登记执行实况**

`docs/README.md` 登记表 #82 行（计划批准时已建骨架）的「执行实况」列补：Task 1–8 逐条落地情况、门禁结果（含 vectors 14 文件、oracle 输出）、执行期定案 1–6（二维码→配对码、rev 整数化、catalog 分页切分、失败锁远端地址、HEAD→GET probe、gossip 转发面后置）、真机验收待办清单（热点/同 Wi-Fi 全流程、Range 续传、篡改拒收、token 过期 403、吞吐 R7 实测回写 spec §3.2）。

- [ ] **Step 6: Commit**

```powershell
git add tools/meshoracle/main.go docs/superpowers/specs/2026-09-25-base-distributed-learning-design.md docs/README.md docs/superpowers/plans/2026-10-17-base-mesh-realtime-phase1-plan.md
git commit -m "feat(mesh): go oracle for mesh vectors + master-plan backfill + registry"
```

---

## 验收门禁汇总

1. `npm test` 全绿（vectors/v1 14 个文件全被协议核消费）。
2. `npm run typecheck`：protocol-ts / core-ts / node 0 错误；mobile 无新增错误。
3. `go run ./tools/meshoracle` exit 0。
4. `git diff --stat -- internal/` 无输出；不 bump `schema_version`；不改内容包规范 v1。
5. 真机验收（Task 8 登记为待办，云打包 versionCode 48）：热点 + 同 Wi-Fi 两场景全流程（分发 / 断网读 / 互发评论 / 回连代上报 / 第三端经节点可见）；篡改 1 bit 块拒收；token 过期 403；Range 断点续传（杀进程重连）；吞吐 R7 并发 2 vs 4 实测回写 spec §3.2。
