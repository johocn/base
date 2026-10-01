# 基座投稿修复与免票选删除设计（本册）

**日期**：2026-10-01
**范围**：修 4 个线上缺陷 + 新增 1 条治理规则（免票选自由删除）+ 清理上一轮线上复现留下的测试数据。
**不改**：`POST /v1/submit` 的三区间铁律与错误码取值域、`POST /v1/blob` 的 `8 MiB` 上限与 `blob_too_large`、`GovernAction` 四值、`GovernThreshold*` 既有常量、`reason` 的 `1..200 rune` 契约。

---

## §1 `POST /v1/event` 缺签名头（词条提案与投票 400）

### 根因

`apps/mobile/src/core/govern.ts` 的 `postGovernEvent`（第 130–154 行）只发 `Content-Type`，**未发节点签名头**；同文件第 126 行注释「事件路径只验内容签名，不需要签名头」是错误假设。节点 `internal/httpapi/authmw.go` 的 `authenticate` 第 1 步即判缺头，返回 `400 {"code":"auth_missing_header"}`。

`createProposal` 与 `vote` 共用 `postGovernEvent`，故「提交讲师/分类词条 400」与「投票 400」是同一个洞。对照实现：`apps/mobile/src/core/comment.ts` 第 213–223 行，同一条 `/v1/event` 路径**确实**带签名头。

### 修法

- `postGovernEvent` 内：先 `const bytes = localStep('编码请求', () => utf8(wire))`，再 `const headers = localStep('签名请求', () => signRequestHeaders(ident, { method: 'POST', path: '/v1/event', body: bytes }))`，POST 时展开 `...headers`。与 `comment.ts` 逐字同构（含 `localStep` 的错误文案口径）。
- 删除第 126 行的错误注释。
- 节点侧零改动：`auth_missing_header` 的判据与文案不变。

### 影响面

仅客户端一个函数；`createProposal`、`vote`、目录词条提案（`pages/directory/apply.vue`）三条路径同时恢复。

---

## §2 nginx `client_max_body_size`（课程编辑中图片 / 附件传不上）

### 根因

线上 nginx `:80` 的 server 块**未配置** `client_max_body_size`，走内置默认 **1 MiB**。而两侧契约都是 8 MiB：客户端 `apps/mobile/src/core/blob.ts` 的 `MAX_BLOB_BYTES = 8 << 20`，节点 `internal/httpapi/server.go` 第 121 行 `requireAuthLimit(maxBlobBytes+(4<<10))`。

线上实测（打 `:80` → base-cache `:8083`）：900 KiB → `200 {"blob_id":…}`；2 MiB → `413 <html>`（由 nginx 直接返回，根本没到 Go）。

### 修法

- nginx 对应 server 块补 `client_max_body_size 12m;`（8 MiB 体 + multipart 边界与头部余量），`nginx -t` 通过后 reload。
- **两侧契约一字不动**：`MAX_BLOB_BYTES`、`maxBlobBytes`、`blob_too_large`(413) 的语义与文案保持；9 MiB 仍必须由 Go 回 `413 blob_too_large`（而不是 nginx 的 html）。
- 不把客户端上限降到 1 MiB：那会推翻 #40 已冻结的 8 MiB 契约。

---

## §3 基座自检 `uni.chooseFile` 报错

### 根因

`apps/mobile/src/core/selfcheck.ts` 第 356–378 行的两个 `pick.*` 项**无条件**断言 `uni.chooseFile` / `uni.chooseImage` 存在，其中 `pick.choose_file` 在 App 端必然 fail（App 运行时不提供 `chooseFile`）。`pickOk='fail'` 经 `canPickFile(flags) => flags.pickOk !== 'fail'` 变为假，`pickBlockedReason` 随即拦死封面 / 附件入口——与 §2 叠加，用户看到的就是「传不上」。

而 `apps/mobile/src/platform/uni.ts` 的 `pickLocalFile` 在 App 端**优先走 `chooseImage`**，两边口径不一致才是缺陷本体。

### 修法

- `platform/uni.ts` 新增并导出唯一能力探针 `pickCapability(): 'album' | 'chooseFile' | 'none'`：
  `plusRuntime() !== undefined && typeof uni.chooseImage === 'function'` → `'album'`；否则 `typeof uni.chooseFile === 'function'` → `'chooseFile'`；否则 `'none'`。
- `pickLocalFile` 改为直接读该探针（行为不变，只是判定同源，不再各写一份）。
- `selfcheck.ts` 的 `pick.choose_file` 改名为按分支断言：探针为 `'album'` 时断言 `uni.chooseImage` 存在并回「App 端以相册选取为准」；探针为 `'chooseFile'` 时断言 `uni.chooseFile` 存在。`pick.album` 项同样按探针分支断言。两项 `flag: 'pickOk'`、`scope: 'standalone'` 不变。
- `canPickFile` / `pickBlockedReason` 的签名与语义不变（自检仍是用户主动触发的提示源）。
- **附带修同一处的真机缺陷**：`platform/uni.ts` 的 `toPlusUrl` 目前只处理 `_doc` 前缀，`file:///storage/...` 这类绝对 URL 会被原样交给 `io.resolveLocalFileSystemURL` 而读取失败。改为对 `file://` 前缀统一走 `convertLocalFileSystemURL`。

---

## §4 编辑课程提交 400

### 根因（已定案）

报错原文是 `提交失败（HTTP 400）`，即 `apps/mobile/src/core/errors.ts` 的**兜底串**（`errorText(code, '提交失败（HTTP ${status}）')`）。逐个排除：

| 候选 | 排除依据 |
|---|---|
| `auth_body_too_large`(413) | 状态码不是 400；且 `requireAuth` 先于业务判定并回 413 |
| `bad_json`(400，无 `code`) | `decodeJSON` 用 64 KiB `LimitReader`，超限已被 `requireAuth` 拦成 413 ⇒ 客户端合法载荷打不出它 |
| 其余 6 个容器 400 码 | `author_id_forbidden` / `item_type_unsupported` / `item_id_invalid` / `item_type_mismatch` / `item_title_invalid` / `author_sig_invalid` **均已有中文文案**，不会是兜底串 |

⇒ **`code` 只能是 `item_segments_invalid`**，即在 `internal/httpapi/submit.go` 第 213–217 行被 `validateSubmitSegments` 判否。

`validateSubmitSegments` 的 5 个判否条件里，客户端可自行排除 3 个：属性行经 `assignAttrSeqs` 排布（`apps/mobile/src/core/course-edit.ts` 第 130 行，与 Go 侧规则同源）、`seq=0` 恒为 `DIGEST_KIND`、`seq` 由代码生成不重复。剩下唯一可行来源是**已存在的清单行 kind 不在本容器词表内**（`course` 只收 `lesson`；`lesson` 只收 `article|video|audio|quiz`，`internal/httpapi/submit.go` 第 71–76 行）：客户端新增行恒合法（`pages/course/edit.vue` 的 `addLesson` 固定 `'lesson'`、候选面板按 kind 过滤），而 `loadContainerForm` 会把库里**原样的 kind** 带进表单并原样发回。

### 修法（不放宽节点契约）

1. `errors.ts` 补两条映射：`item_segments_invalid` → 「课程 / 课时的行集不合法：请检查属性与子项清单」；`auth_body_too_large` → 「提交内容超过 64KB」。这是当前唯一落回裸兜底串的码，补上等于把「无线索 400」变成可读原因。
2. `apps/mobile/src/core/course-edit.ts` 新增 `validateContainerSegments(type, rows): { ok: boolean; message: string }`，判据与 `validateSubmitSegments` **同构**：重复 seq、`seq<0` 须属性行、`seq=0` 须 digest、`seq>=1` 须容器词表、属性行须 `attrSeqsCanonical`。新增客户端镜像常量 `childKindsByContainer`（与 Go 同值）。由 `saveContainer` 在 `enqueueOrSend` **之前**调用：失败**指名到行**（例：「第 3 个子项的 kind=article 不合法：课程只能挂课时」），直接返回 `ledgerState: 'failed'` 并写台账 `reason`，**不发网络请求**。
3. 节点侧 `validateSubmitSegments`、`childKindsByContainer`、错误码一字不改。

### 待坐实的一步（执行期）

拿下用户那门课的 `item_id`，直接读线上节点 segments 把那行揪出来，确认它是「导入课程」还是「App 建的历史课程」，再决定是否需要数据修复。此为**核实**，不是设计前提：即使不修数据，第 2 步也能让用户看到到底是哪一行、自己移除后即可保存。

---

## §5 免票选自由删除（方案 A：治理管线内旁路，零新端点 / 零新表）

### 目标

课程在「无课时」**或**「无其他用户参与学习」时，**创建者**可不经票选直接删除；只要涉及其他用户，一律回落到既有 3 票票选。

### 判据（节点侧新增 `store.FreeRemoveEligible`）

置于 `internal/store/govern.go`（与 settle 同文件），签名 `FreeRemoveEligible(tx, itemID, actor) (bool, error)`，在 remove 提案的 settle 生效判定**之前**调用：

1. **主体（已收紧）**：`actor` 必须是该条目的**创建者**。创建者取 `items.author_id`（与 `UpsertSegmentSubmission` 落库同源）；为空（如导入器产出的课程）⇒ 免票选不成立。**名册内治理者不享免票选**，一律走既有 3 票——他们已有投票权，且 `progress` 只有本节点数据，放任会让治理者瞬时下架任意对端新课。
2. **无课时**（`itemID` 形态为 `course/<cid>`）：该 course 的 `segments` 中不存在 `seq >= 1` 行 ⇒ 真。
3. **无他人学习**：`progress` 表中 `item_id ∈ {course 自身} ∪ {该 course 全部课时 id}` 的行，扣掉 `id == actor` 的行后为空 ⇒ 真。课时 id 取该 course 的 `seq >= 1` 行的 `text`。
4. **课时同规则（已收紧）**：`itemID` 形态为 `course/<cid>/lesson/<lid>` 时同样适用，只是条件 2 不适用（课时没有「课时」），退化为只看条件 3（以其自身 `item_id` 为准）。这两处一致，避免「删课程免票选、删课时仍需票选」的割裂。
5. **fail-closed**：任何查询异常、名册 / 创建者不可得 ⇒ 返回 error，调用方**退回既有 3 票**，绝不因异常放行。

### 生效路径

- 为真 ⇒ 该 `remove` 提案门槛降为 0、**立即 effective**（与既有 `ProposalStatus` / `nextContentVersionExec` / `retireItemExec` 完全复用），`executed_result` 记 `'free_remove'`（仅诊断，不影响任何既有读路径）。
- 为假 ⇒ 一字不动走既有 `GovernThresholdForRoster(GovernActionRemove, rosterLen, rosterReady)`（= 3）。
- **语义不变**：仍是 `govern.v1` 的 `remove` 提案 + 墓碑，因此**可 `revive` 复活**、经既有反熵传播到对端。跨节点盲区（对端有人学过而本端 `progress` 为空）由「墓碑可复活」兜底，不在本册解决。

### 客户端

- **唯一新增 UI**：课程详情页加「删除」按钮。点击即复用 `createProposal({ action: 'remove', itemId, reason })`（`core/govern.ts`，随 §1 修好签名头后可用）。
- `reason` **由客户端自动填**「创建者删除」（用户不必手打），`1..200 rune` 契约不变。
- 返回 `effective` ⇒ toast「已删除」；`pending` ⇒ toast「已提交，需 3 票」。
- 治理页 `pages/governance/governance.vue` 不动；其 `ACTION_LABEL` 缺 `directory_add` 键一事本册不修（与本册诉求无关，不扩大范围）。

---

## §6 测试数据清理（线上）

上一轮线上复现留下约 10 个测试身份、4 门测试课程（`复现用课程` / `复现E` / `复现F` / `复现J全属性`）、1 个约 900 KiB 的 blob。属不可逆生产写操作，已获用户批准清理。

执行口径（先取证后删除，全程可回溯）：

1. 定位线上库文件路径与 `base` / `base-cache` 两个 systemd 单元的实际数据目录，确认**只清一处**（缓存节点由源节点重建，不单独动）。
2. **先导出**受影响的 `identities` / `items` / `segments` / `progress` / `submissions` / `blobs` 行到 `/tmp` 备份，再按**已知测试标题与身份 id**精确定位删除；**禁用**任何按前缀 / 模糊匹配的批量删除。
3. 删除后核对：测试课程查不到、正式课程与词条目录（`GET /v1/directory`）不受影响、`GET /v1/release` 仍为当前版本。
4. 备份文件留在服务器 `/tmp`，在用户确认无误前不删。

---

## §7 风险与取舍

| 风险 | 处置 |
|---|---|
| 免票选判定只看**本节点** `progress`，对端有学习者时本端仍可能判「无人学过」 | 落的是墓碑不是永久删除，可 `revive`；事件经反熵传播。用户已确认接受 |
| 课程被学过后课时被删光，「或」会让它重新落入免票选 | 以**实时** `progress` 与**实时** `segments` 为准，不缓存、不做历史推断 |
| 判定放在 settle 前会给治理读路径加查询 | 仅 `remove` 提案走该分支；查询失败 fail-closed，最坏退化为既有 3 票 |
| §4 的第 2 步是「同构镜像」，两端漂移会变成客户端误拦 | 镜像判据以 `internal/httpapi/submit.go` 为唯一正本；新增的客户端用例与 Go 侧表驱动用例同表同值 |
| 清理生产测试数据误伤正式数据 | 先备份、按已知 id 精确删、删后核对目录与 release |

---

## §8 验收判据（AC）

| # | 判据 | 验证 |
|---|---|---|
| AC 1 | 词条提案与投票不再 400 | core 用例：fake http 断言 `POST /v1/event` 请求头含 `X-Base-Id/Alg/Ts/Nonce/Sig` 五项；线上真机提交一个讲师词条成功 |
| AC 2 | 2 MiB 图片 / 附件可上传，9 MiB 仍被拒 | 线上 `curl` 2 MiB → `200`；9 MiB → `413 blob_too_large`（**非** nginx html） |
| AC 3 | App 端基座自检不再因 `chooseFile` 报错，封面 / 附件入口可用 | 真机跑自检 `pick.*` 两项通过；课程编辑页可成功选封面与附件 |
| AC 4 | 编辑课程若行集非法，报错**指名到行**；合法则提交成功 | core 用例：构造 `kind=article` 的子项行 ⇒ 断言消息含行号与 kind、且**未发出网络请求**；用户那门课修复后保存成功 |
| AC 5 | 无课时 / 无他人学习的课程，创建者可一步删除，不产生票选 | 节点用例：`FreeRemoveEligible` 四组（仅创建者 / 有他人 progress / 有课时且无 progress / 非创建者治理者）各断言；线上删一门自建空课程，返回 effective |
| AC 6 | 有他人参与学习的课程，创建者仍需 3 票 | 节点用例：`progress` 存在他人行 ⇒ 提案停留 pending，门槛为 3 |
| AC 7 | 测试数据清理完成且无副作用 | 测试课程查不到；`GET /v1/directory`、`GET /v1/release`、正式课程读取均正常 |
| AC 8 | 既有门禁回归全绿 | `go test ./...`、`apps/mobile` 下 `npx vitest run` |

---

## §9 本册不做（YAGNI）

- 不新增删除专用端点、不新增资格读接口（方案 B 已否决）。
- 不做客户端本地隐藏式「伪删除」（方案 C 已否决）。
- 不改 `remove` 的既有门槛常量与 `GovernAction` 取值域；不为免票选引入配置开关。
- 不同步修 `governance.vue` 的 `ACTION_LABEL` 缺键、不为 `attr.body_md` / `attr.category` 的跨容器丢行问题做防御（属既有边界，与本册诉求无关）。
