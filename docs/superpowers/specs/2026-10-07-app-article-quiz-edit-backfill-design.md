# App 文章/题库编辑回填（从 items 表）设计册子

- 日期：2026-10-07
- 状态：已与用户逐节确认（入口范围、回填优先级、载体范围、实现路径、五节设计均确认）
- 前置：#56 投稿台账、#61 重投、#79/#80 提交链路与失败 Toast 均已上线（0.20.6/31）

## 1. 问题

现状：文章/题库的「编辑」只能从「我的条目」（myitems.vue）走**本机台账**重投——`getSubmission` 未命中即报「本地台账没有这条记录」。以下场景无法编辑：

- 本机清过台账 / 换机恢复后，items 表里明明有自己的已同步条目
- 从其他设备投稿、同步到本机后想改
- 从详情页看到自己的文章/题库，想就近改一笔

## 2. 取证事实（设计依据）

| 事实 | 位置 |
|---|---|
| 已同步文章正文存 `articles` 表（`ArticleRow.bodyMd`，Row 自带 title/digest）；题库存 `quizzes` 表（`QuizRow.questionJson`）；作者在 `items` 表（`ItemRow.authorId`）——ArticleRow/QuizRow 均无 authorId | `packages/core-ts/src/types.ts:18-27`、`repo.ts:36/69`（`getArticle`/`getQuiz`） |
| 签名口径 `authorSignBytes(itemId, contentHash, ident.id)`，**标题不参与**——改标题不破坏签名 | `packages/core-ts/src/submit.ts:207-218` |
| 服务端更新强制作者校验：`checkItemOwnership(itemId, authorId)`，非作者 → 403 `item_id_taken` | `apps/node/src/store/submission.ts:117`、`routes/submit.ts:361-401` |
| 台账写入 `writeLedger` 是按 `item_id` 的 upsert，保留既有 `created` 值 | `submit.ts:292-311` |
| 现有重投入口：myitems.vue「重投更新」→ `/pages/submit/submit?itemId=...` | `apps/mobile/src/pages/myitems/myitems.vue:30/83` |
| submit.vue onLoad 仅台账单一来源；quiz 反序列化走 `draftsFromQuestionJSON` | `apps/mobile/src/pages/submit/submit.vue:481-501` |
| 本机身份读取：`peekLocalIdentity(storage, kek)` + `deviceKek(storage)`，无身份返回 null | `packages/core-ts/src/identity.ts:69/134` |

## 3. 设计决策（用户确认）

1. **入口**：文章/题库详情页加「编辑」按钮（仅自己的条目显示）+ 我的条目页保留现有重投入口（不动）。
2. **回填优先级**：台账优先 → items 表回退（不丢未送达修改）。
3. **载体范围**：课时下的载体文章/题库（itemId 形如 `course/c1/lesson/l1/article/xxx`）一并支持，与独立条目同链路、无特判。
4. **实现路径**：core 新增 `loadItemDraft` + vitest；回填逻辑不内联页面（与 `loadContainerForm` 分层一致）。
5. **范围排除**：tag / course / lesson 不在本册（course/lesson 已有编辑链路；tag 走治理流程）。

## 4. 方案

### 4.1 core：`loadItemDraft`

放 `packages/core-ts/src/submit.ts`，纯读函数：

```ts
export interface ItemDraft {
  itemId: string;
  type: 'article' | 'quiz';
  title: string;
  bodyMd: string;       // quiz 恒 ''
  questionJson: string; // article 恒 ''
}

/** 从 items 表取已同步条目回填编辑；条目不存在或类型不支持返回 null。 */
export async function loadItemDraft(repo: LocalRepo, itemId: string): Promise<ItemDraft | null> {
  const item = await repo.getItem(itemId);
  if (!item) return null;
  if (item.type !== 'article' && item.type !== 'quiz') return null;
  const bodyMd = item.type === 'article' ? (await repo.getArticle(itemId))?.bodyMd ?? '' : '';
  const questionJson = item.type === 'quiz' ? (await repo.getQuiz(itemId))?.questionJson ?? '' : '';
  return { itemId, type: item.type, title: item.title, bodyMd, questionJson };
}
```

行为定义：
- `getArticle`/`getQuiz` 缺行（有 item 无正文的异常态）→ 空串，不抛错。
- 只读：不写库、不发请求、不签名。

### 4.2 页面：submit.vue 两级回退

onLoad 改为（伪代码级描述，实施计划给完整代码）：

```
const row = await ctx.repo.getSubmission(raw);
if (row) → 现有台账回填分支（零改动，return）
const item = await loadItemDraft(ctx.repo, raw);
if (!item) → error.value = '本地没有这条记录'（return）
itemId/type/title/bodyMd ← item；quiz 用 draftsFromQuestionJSON(questionJson)，
  空结果回退 [emptyDraft()]（与台账分支同防守）
```

提交链路 `submit()` / `enqueueOrSend` / 失败 Toast / blob_references 刷新**零改动**。页面标题沿用现有 `isUpdate ? '重投更新' : '新建投稿'`（带 itemId 进入即更新模式）。

### 4.3 页面：详情页编辑按钮

- article.vue 与 quiz.vue 各加「编辑」按钮：`uni.navigateTo('/pages/submit/submit?itemId=' + encodeURIComponent(itemId))`。
- 显隐 `canEdit`：`item.authorId === 本机身份 id`。身份读取：`peekLocalIdentity(adapters.storage, await deviceKek(adapters.storage))`；无身份 → 不显示。article.vue onLoad 已持有 item 行（authorId 直接取）；quiz.vue 无 item 行，需补 `repo.getItem(itemId)` 取 authorId（title 仍由 loadItemDraft 统一供）。
- 载体条目不特判：article.vue 对载体文章同样显示（`lessonOfCarrier` 只影响课时上下文展示，不影响编辑入口）。
- myitems.vue 不动。

### 4.4 mobile core re-export 壳

`apps/mobile/src/core/` 为 1:1 re-export 壳（#72 口径，均为 `export *`，已核实 identity/submit 两壳）：`loadItemDraft`/`ItemDraft`、`peekLocalIdentity`/`deviceKek` 均自动可用，**壳零改动**。

## 5. 边界与预期行为

| 场景 | 行为 |
|---|---|
| 非作者强行进编辑页（直接输 URL） | 前端不拦；提交时服务端 403 `item_id_taken`，现有失败 Toast 展示 |
| 从 items 回填编辑后提交 | `writeLedger` upsert 出台账行（created=0），「我的条目」自然多一条更新记录——预期行为 |
| 内容未改动直接提交 | 服务端同 hash 覆盖，无害 |
| 回填的 questionJson 反序列化为空 | 回退 `[emptyDraft()]`，与台账分支同防守 |
| quiz 提交 | 沿用 `buildQuestionJSON(drafts)` 重建口径，与台账路径一致 |
| 文章提交后 | 沿用 `refreshBlobRefs` 刷新，零改动 |

## 6. 测试（vitest，core 层）

1. article 回填：items+articles 有行 → 返回 `{title, bodyMd, type:'article', questionJson:''}`。
2. quiz 回填：items+quizzes 有行 → 返回 `{title, questionJson, type:'quiz', bodyMd:''}`。
3. 条目不存在 → null。
4. type=course / tag → null。
5. 有 item 无 articles 行 → bodyMd='' 不抛错。

页面行为（两级回退、canEdit 显隐）以真机验收为主，core 测试锁函数契约。

## 7. 验收清单

1. 独立文章详情页：自己的条目显示「编辑」，他人条目不显示。
2. 点编辑 → submit 页标题/正文已回填（含 Markdown 标记、图片 blob 引用）。
3. 修改后提交 → 成功 Toast「已更新」，详情页刷新可见新内容。
4. 题库同理：题干/选项/正确项/解析完整回填。
5. 台账 pending/failed 未送达的修改优先于 items 版本显示。
6. 无台账记录的已同步自有条目可编辑（items 回退生效）。
7. 课时下载体文章/题库详情页可编辑并回填。
8. 「我的条目」页现有重投不受影响；新提交后该条目出现在台账。
9. 门禁：`packages/core-ts` vitest 全绿、`apps/mobile` vitest 全绿、vue-tsc 通过、`build:h5` 通过。

## 8. 风险

1. **身份读取依赖 storage 适配器**：H5 与 App 的 storage/kek 链路已由 selfcheck/身份备份验证过，风险低；若 peekLocalIdentity 在某端异常，按钮不显示（fail-closed），不阻塞页面。
2. **created=0 的台账行语义**：同步来的自有条目更新后进台账、`created` 恒 0——与「这是我本机新建的」语义不冲突（它确实不是本机新建），myitems 展示无歧义。
3. **未来 tag 编辑需求**：本册明确排除；tag 有治理流程，届时另立册子。

## 9. 发布实况（2026-10-07，0.20.7/32）

**版本**：`apps/mobile/src/manifest.json` `0.20.6`/`31` → **`0.20.7`/`32`**（每版 patch+1 / code+1 口径）；发布前线上 `GET /v1/release` 旧值 = `0.20.6` / 27494402 字节 / sha256 `4a6bf744…5dab`。

**实施**：T1–T5 全部完成（commits `c2cd972` / `12023fc` / `3d8281a` / `34be07a` / `3c1f8a5`），门禁全绿：`packages/core-ts` vitest 511/511（其中 `submit.test.ts` 新增 5 条 31/31）、`apps/mobile` vitest 37/37、vue-tsc 零错、`build:h5` 通过。

**发布四步（既证口径，#79 册子 T18 手法）**：

1. **云打包**：`cli pack` 三轮攻坚——首跑约 7 分钟 0 输出 0 连接，终止重试；重试 exit -1 仍 0 输出，`cli open` 恢复 IDE 运行态后重建通道；第三次遇交互提示「检测到本项目已有正在制作的安装包在云端队列中…是否继续提交？」卡住，改管道应答 `Write-Output "y" | cli pack …` 自动接管旧队列重新排队，13:05:47 打包成功。云端未自动落盘（同 #64/#79 现象），经临时下载地址取回落 `apps/mobile/dist/release/apk/base-0.20.7.apk`。产物四项核对：**27494708 字节** / sha256 `1a6b441a63c79bafa4ac012eacf73d7be2bca65c81e2c1b01c8e0547a70092fb` / 包内 versionCode **32** versionName **0.20.7** / 证书 SHA1 `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`（与 0.20.6 基线一致 ⇒ 可覆盖安装）。
2. **上传**：scp → `/opt/appdl/base-0.20.7.apk`，远端 `sha256sum` 与 `stat -c %s` = 27494708，与本地**逐字一致**。
3. **落地页**：`/opt/appdl/index.html` 整页重写改指 `base-0.20.7.apk`（meta 行 `版本 0.20.7（versionCode 31→32）· 2026-10-07 · 文章 / 题库编辑回填上线…` + 新增编辑回填使用说明一条 li；旧页备份 `index.html.bak-0.20.6`）；线上 `grep -c '0.20.6'` = **0**、`grep -c '0.20.7'` = 2。
4. **签发**：`set -a; . /opt/base/base.secret.env; set +a; /opt/base/based release -version-name 0.20.7 -min-version-name 0.8.0 -apk-url http://118.190.217.242/dl/base-0.20.7.apk -apk-file /opt/appdl/base-0.20.7.apk -notes '文章题库编辑回填' -out /opt/base-cache/data/release.json` → 输出 `apk_size=27494708`、`apk_sha256=1a6b441a…`、`public_key 48c33db9…24f4`。

**G8 线上核对（公网 :80，逐条实测输出）**：

| 检查 | 结果 |
| --- | --- |
| `GET /v1/release` | `version_name=0.20.7`、`min_version_name=0.8.0`、`apk_size=27494708`、`apk_sha256=1a6b441a…92fb`（与本地逐字一致）、`apk_url=…/dl/base-0.20.7.apk`、`issuer=base-node-1`、`issued_at=2026-10-07T05:11:51Z`、`notes=文章题库编辑回填`、signature 已签发 |
| `HEAD /dl/base-0.20.7.apk` | `200` / `Content-Type: application/octet-stream` / `Content-Length: 27494708`（与本地字节数一致） |
| `verifyRelease` | **true**——一次性 vitest 用例 fetch 线上 `/v1/release` 后 `verifyRelease(doc, '48c33db9…24f4')` = true（#28/#59 手法，跑完即删、未入库） |

**真机 9 条（§7）：待人工**（登记不阻塞，同 #59–#80 口径）。

**执行期更正（2 条）**：

1. **云打包接管队列新口径**：遇「已有正在制作的安装包在云端队列中」交互提示，CLI 会等 stdin 而非超时退出；`Write-Output "y" | cli pack …` 管道应答可自动接管旧队列重新排队。
2. **身份读取签名单参**：计划稿写 `peekLocalIdentity(storage, kek)` 双参，取证证实实际签名单参（`identity.ts:133` 内部自调 `deviceKek`）——T3/T4 均按单参实施。
