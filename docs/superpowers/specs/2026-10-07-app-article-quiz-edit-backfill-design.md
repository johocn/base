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
