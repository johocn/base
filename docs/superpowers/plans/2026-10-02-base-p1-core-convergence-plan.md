# P1 核收敛（实施计划 #71）

- 日期：2026-10-02
- 上游：册子 `#69`《铁律对齐》、路线计划 `#70`《P1–P6 迁移路线》
- 状态：**已执行**（Task 1–4 全部落地；见 §7）
- 性质：任务级计划。**契约一律回册子 / 路线计划**，本册只落执行口径。

## 0. 一句话

P1 只做**协议核**（`packages/protocol-ts`）：补两个真缺口（`blobpack` 帧 / `ValidSlug`），把四个「**位置错误**」的纯模块（`attrs` / `progress` / `markdown` / `tag` 编解码）**上提**进协议核，原路径留 **re-export 过渡**。

## 1. 对 #70 的两处执行级定死

#70 是路线级计划，§2 只给了方向。执行前取证后定死两处：

| # | #70 原口径 | 执行级取证 | 定死 |
|---|---|---|---|
| 1 | §2.4「业务核 = 新包（暂名 `packages/core-ts`）」 | 业务核全体依赖 `Adapters`；而 #70 §3 自己明言接口边界「**先锁定，后抽取**」 | **P1 不建 `core-ts`**，业务核建包随 **P2**（`Adapters` 冻结之后）。故 §2.2 四行里 `attrs` / `progress` / `markdown` **整体**入协议核；`tags` **只上提其纯编解码段**（`internal/protocol/tag.go` 的镜像），适配器侧（`submitTag` / `canGovern` / `tagsOf` / `linksOf` / `untaggedTargets` / `TAG_KIND_ORDER`）**留在原地** |
| 2 | §2.1「`ValidSlug`：先核对 `core/tags.ts` 的归一化口径，**择一**后落 `protocol-ts`」 | `core/tags.ts` 的归一化只有 `trim()`，**不含 slug 形态**；同一口径其实**内联**在 `core/course-edit.ts:106` 的私有 `ID_SEGMENT` 正则 | **择一 = 上提 `course-edit.ts` 的私有正则**为协议核 `slug.ts` 的 `isValidSlug`；`isLegalContainerId` 改调用它（**行为等价**，消除两处口径） |

> 定死 1 的判据补一句：`tags.ts` 若整体搬进 `core-ts`，会连锁拖出 `submit` / `contribution` / `group` / `fakes` —— 那就等于把整条业务核搬完，远超 P1 §2 范围，且违规于「先锁定后抽取」。

## 2. 签字区（定死，执行期不再议）

- **包与目录**：只用 `packages/protocol-ts`，**不新建包**。
- **新模块与导出名**（常量 UPPER_SNAKE、函数 camelCase，与既有 `protocol-ts` 同例）：
  - `blobpack.ts`：`BLOB_PACK_CONTENT_TYPE` / `BLOB_FRAME_HEADER_SIZE` / `FETCH_MAX_BYTES` / `MAX_BLOB_FRAME_SIZE` / `writeBlobFrame(blobId, payload): Uint8Array` / `readBlobFrame(buf, offset): { blobId; payload; next } | null`
  - `slug.ts`：`SLUG_MAX_BYTES = 64` / `isValidSlug(s): boolean`
  - `attrs.ts` / `progress.ts` / `markdown.ts` / `tag.ts`：**搬迁，导出名逐字不变**（`tag.ts` 只搬 `TAG_SEGMENT_MAX_RUNES` / `encodeTagPathSegment` / `decodeTagPathSegment` / `encodeTagPath` / `tagTitle` / `decodeTagPath` / `tagKindOfTarget`）⇒ **不新增契约面**
- **blobpack 的 IO 口径**：Go 的 `io.Writer` / `io.Reader` 在协议核内不可用（禁 `node:`）。定死为**字节口径纯函数**：`writeBlobFrame` 返回整帧字节；`readBlobFrame` 以「缓冲 + 游标」读一帧 —— `offset >= buf.length` 返回 `null`（等价 `io.EOF`），半截帧头 / 非法 `blob_id` / `size > MAX_BLOB_FRAME_SIZE` **抛 `Error`**。调用方（P3 对端同步）负责把 HTTP 体读成 `Uint8Array`；`FETCH_MAX_BYTES` 已界定单次上限，整体缓冲与 Go 的切批口径一致。
- **re-export 过渡**：`core/attrs.ts` / `core/progress.ts` / `core/markdown.ts` 变**显式** `export { … } from '@base/protocol-ts'`（**不用 `export *`**，避免把 `sha256Hex` 等泄漏进 `core/*` 命名空间）；`core/tags.ts` 保留本地实现 + 显式 re-export 编解码名。过渡期**不复制逻辑**（#70 §9）。
- **测试搬迁**：`attrs.test.ts` / `progress.test.ts` / `markdown.test.ts` 随模块搬进协议核（向量相对路径 `../../../vectors/v1/…`）；`tags.test.ts` 的**纯编解码段**拆到协议核新 `tag.test.ts`，适配器段留 `apps/mobile`。新增 `blobpack.test.ts` / `slug.test.ts`，用例镜像 Go 的 `blobpack_test.go` / `id_test.go:122`。

## 3. Task 列表（TDD：先写 / 搬测试，再落地实现）

### Task 1 协议核补空：`blobpack.ts` + `slug.ts`

- 新增 `packages/protocol-ts/src/blobpack.ts`：四常量 + `writeBlobFrame` / `readBlobFrame`，判据逐条照 `internal/protocol/blobpack.go:24-60`（非法 id、payload 超限、半截帧头、size 超限、正文截断）。
- 新增 `packages/protocol-ts/src/slug.ts`：`isValidSlug` —— 字节长 1..64、首字符 `[a-z0-9]`、其余 `[a-z0-9-]`。
- 新增 `blobpack.test.ts`（往返 / 双帧 / 干净结束→`null` / 非法 id / 半截帧头 / size 超限）+ `slug.test.ts`（`ok` / `bad` 两组照 `id_test.go:122`）。
- `packages/protocol-ts/src/index.ts` 追加两行导出。
- `apps/mobile/src/core/course-edit.ts`：删私有 `ID_SEGMENT`，`isLegalContainerId` 改调 `isValidSlug`。
- 验收：`course-edit.test.ts` 既有断言**一字不改**仍全绿。

### Task 2 协议核收编三件套：`attrs.ts` / `progress.ts` / `markdown.ts`

- 搬 `core/attrs.ts` ← `packages/protocol-ts/src/attrs.ts`：`^import { sha256Hex, utf8 } from '@base/protocol-ts'` 改 `'./hash'`；`segmentsContentHash` 的 `Pick<SegmentRow, …>` 改本地 `SubmitSegmentRow`（**不碰 `core/types.ts`** —— 结构化类型下 `SegmentRow[]` 天然可赋）。
- 搬 `progress.ts` / `markdown.ts`（零依赖，逐行搬）。
- 三个原文件改 re-export shim。
- 搬三个测试（向量路径改 `../../../vectors/v1/…`）。
- 验收：协议核 vitest 覆盖 `attrs.json` / `progress.json` / `markdown.json`；mobile 既有测试全绿（`markdown-toolbar.test.ts` / `my-created.test.ts` / `course-edit.test.ts` 等经 shim **不改一字**）。

### Task 3 tag 编解码上提

- 新增 `packages/protocol-ts/src/tag.ts`：逐行搬 `core/tags.ts` 的编解码段（含私有 `normalizeTagSegment` / `isHex32`）。
- `core/tags.ts`：删已搬函数，改 `import` + `export { … } from '@base/protocol-ts'`；本地实现（`TAG_KIND_ORDER` / `tagsOf` / `linksOf` / `untaggedTargets` / `submitTag` / `canGovern`）**逻辑不变**。
- 新增 `packages/protocol-ts/src/tag.test.ts`（搬 `GO_CASES` 5 条 + 转义 / 还原 / 重建校验用例）；`apps/mobile/src/core/tags.test.ts` 删已搬段、留适配器段。
- 验收：`submitTag` 等经 shim 调用路径不变；`pages/*` 的 4 处 `from '../../core/tags'` **零改动**。

### Task 4 门禁与实况回填

- **G1**：`npm test`（根，workspace 全跑）全绿。
- **G2**：`npm run typecheck`（`protocol-ts` 的 `tsc` + mobile 的 `vue-tsc`）干净。
- **G3**：协议核**非测试**源码零宿主依赖 —— Grep `plus\.|from ['"]node:|from ['"]uni|@dcloudio`，path `packages/protocol-ts/src`，glob `!*.test.ts` ⇒ **零命中**。
- **G4**：`vectors/v1/` **13 个向量全部由协议核消费** —— 逐个核对向量名在 `packages/protocol-ts/src/*.test.ts` 出现（`canonical` / `hash` / `merkle` / `ed25519` / `aead` / `identity` / `manifest` / `reqsig` / `release` / `authorsig` / `markdown` / `attrs` / `progress`）。
- **G5**：**零 Go 改动 + 不碰禁碰文件** —— `git status --short` 不出现 `internal/`、`.gitignore`、`apps/mobile/src/core/types.ts`、`based-linux-amd64`。
- 回填本册「§7 执行实况」+ `docs/README.md`（本册行置「已执行」、#70 行状态 → P1 已执行、§5 追加一条）。

## 4. 不做

- 不建 `packages/core-ts`（随 P2）、不动 `Adapters`、不动 Go、不改内容包规范 v1、不 bump `schema_version`、不加配置项、不动 `apps/mobile/src/platform/*`、不做 iOS。
- 不为兼容复制双份核心（过渡只用 re-export）。
- 不给 `tags.ts` 新增「Go 有而 TS 无」的导出名（`tagItemId` / `parseTagItemId` / `tagKindAllowed`）—— 不在 P1 契约面，避免顺手扩面。

## 5. 风险与回退

| # | 风险 | 处置 |
|---|---|---|
| 1 | `export *` 造成命名空间污染 | 定死**显式** re-export |
| 2 | 搬测试后 mobile 侧用例数下降被误判为回归 | 执行实况**如实记录迁移前后两侧用例数** |
| 3 | `attrs.ts` 的 `SegmentRow` 依赖把 `core/types.ts` 卷进来 | 用本地 `SubmitSegmentRow` 结构化类型，**不碰 `types.ts`** |
| 4 | blobpack 的 IO 口径与 Go 不等价 | 用例逐条镜像 `blobpack_test.go`；不等价即阻塞 P3 |

## 6. 文件清单

- 新增（协议核）：`src/blobpack.ts` / `src/slug.ts` / `src/attrs.ts` / `src/progress.ts` / `src/markdown.ts` / `src/tag.ts`，以及同名 `*.test.ts`（其中 `attrs` / `progress` / `markdown` / `tag` 为搬迁）
- 改：`packages/protocol-ts/src/index.ts`；`apps/mobile/src/core/attrs.ts` / `progress.ts` / `markdown.ts` / `tags.ts` / `course-edit.ts`
- 删：`apps/mobile/src/core/attrs.test.ts` / `progress.test.ts` / `markdown.test.ts`

## 7. 执行实况

**结论：Task 1–4 全部落地，五道门禁（G1–G5）逐条通过。**

### 7.1 实际改动

**新增（协议核）**
- `packages/protocol-ts/src/blobpack.ts` —— `BLOB_PACK_CONTENT_TYPE` / `BLOB_FRAME_HEADER_SIZE` / `FETCH_MAX_BYTES` / `MAX_BLOB_FRAME_SIZE` / `writeBlobFrame` / `readBlobFrame`（字节口径纯函数，逐条镜像 `internal/protocol/blobpack.go`）
- `packages/protocol-ts/src/slug.ts` —— `SLUG_MAX_BYTES` / `isValidSlug`
- `packages/protocol-ts/src/attrs.ts` / `progress.ts` / `markdown.ts` / `tag.ts` —— 搬迁（导出名逐字不变；`attrs.ts` 仅两处必要改：`@base/protocol-ts`→`./hash`、`Pick<SegmentRow,…>`→`Pick<SubmitSegmentRow,…>`）
- 同名 `*.test.ts` 六个：`blobpack` / `slug` 为新写，`attrs` / `progress` / `markdown` / `tag` 为搬迁

**修改**
- `packages/protocol-ts/src/index.ts` —— 追加 6 行导出（`blobpack` / `slug` / `attrs` / `progress` / `markdown` / `tag`）
- `apps/mobile/src/core/attrs.ts` / `progress.ts` / `markdown.ts` —— 整体改为**显式** re-export 转发（无 `export *`、无逻辑残留）
- `apps/mobile/src/core/tags.ts` —— 编解码段删实现，加**显式** re-export 7 名 + `import` 本地所需的 4 名；适配器侧逻辑一字未动
- `apps/mobile/src/core/tags.test.ts` —— 删已搬的编解码段（15 例 → 10 例）
- `apps/mobile/src/core/course-edit.ts` —— 删私有 `ID_SEGMENT`，`isLegalContainerId` 改调 `isValidSlug`（行为等价）

**删除**
- `apps/mobile/src/core/attrs.test.ts` / `progress.test.ts` / `markdown.test.ts`（内容已搬进协议核）

`pages/**` 的 4 处 `from '../../core/tags'` 与 `core/*` 的全部 `from './attrs'` / `'./progress'` / `'./markdown'` 调用点**零改动**（经转发 shim 工作）。

### 7.2 门禁（真实输出）

| # | 门禁 | 结果 |
|---|---|---|
| G1 | 根 `npm test` | **全绿**：`@base/protocol-ts` **9 文件 / 156 用例**；`@base/mobile` **35 文件 / 376 用例**（迁移前为 38 文件 / 460 用例，差 −3 文件 / **−79 用例 = 18+18+43**，与三测试搬走逐字吻合；`tags.test.ts` 另 15→10 例，差 5 例同步落在协议核 `tag.test.ts`） |
| G2 | 根 `npm run typecheck` | `@base/protocol-ts` **干净**；`@base/mobile` **仅 2 条既有册外 `.vue` 错误**（`pages/governance/governance.vue:58` `TS2741`、`pages/submit/submit.vue:178` `TS2322`）——与 `#62` 决策 12 登记逐字一致，**本次未引入新错误**；故根命令 exit 2 是该既有基线，非回归 |
| G3 | 协议核非测试源码零宿主依赖 | Grep `plus\.\|from ['"]node:\|from ['"]uni\|@dcloudio`，path `packages/protocol-ts/src`，glob `!*.test.ts` ⇒ **零命中** |
| G4 | `vectors/v1/` 13 个向量全部由协议核消费 | **13/13**：`canonical` / `hash` / `merkle` / `ed25519` / `manifest` / `identity` / `reqsig` / `release` / `authorsig`（`vectors.test.ts`）+ `aead`（`aead.test.ts`）+ `markdown` / `attrs` / `progress`（本次搬入的三测试） |
| G5 | 零 Go 改动 + 不碰禁碰文件 | `git diff --stat -- internal/` **无输出**；`.gitignore` / `apps/mobile/src/core/types.ts` / `internal/httpapi/web.go` / `based-linux-amd64` **均未触碰** |

### 7.3 执行期说明（4 条）

1. **`tags` 未整体入协议核**——按 §1 定死 1：只上提编解码段；整体搬走会连锁拖出 `submit` / `contribution` / `group` / `fakes`，等于把业务核搬完。适配器侧留在 `apps/mobile/src/core/tags.ts`，业务核建包随 **P2**。
2. **`tags.ts` 未新增「Go 有而 TS 无」的导出名**——原 TS 无 `tagItemId` / `parseTagItemId` / `tagKindAllowed`，按 §4 不顺手扩面；`normalizeTagSegment` / `isHex32` / `TAG_ESCAPE` 在核内**保持私有**。
3. **未为凑数造测试**——原 `tags.test.ts` 本就没有 `TAG_SEGMENT_MAX_RUNES` 的断言，故协议核 `tag.test.ts` 不新造该用例。
4. **一处过时注释保留未改**——`progress.test.ts` 内「层深 4」的说明随搬迁已不准确（属注释，不影响行为；如需清理另开）。

