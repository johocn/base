# base 运行路径落盘根与存量台账自愈实施计划（册子 #63 → 计划 #64）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地册子 `#63` 全部诉求——① `toPlusUrl` 对 `file://` 输入先剥 scheme 再按「能折 `_doc` 就折、否则整串 `file://` 绝对路径」重排，消灭「绝对路径被当相对路径逐段下钻 ⇒ 沙盒外 mkdir ⇒ `code:15`」；② `PlusFs.rootDir()` 由固定 `_doc/base` 改为**候选链 + 实做探测**（① `getFilesDir()/base`、② `_doc/base`，首个「建目录 → 写 1 字节 → 读回 → 删」全过者胜出并进程内缓存），DB 与 pack 随之落到胜出根；③ 读路径 `create:false`（读已存在文件不再 mkdir，失败文案改「打开目录失败」）；④ 自检新增 `fs.root` 探测（展示胜出全路径）；⑤ `runLedgerHealMigration` 存量台账自愈（有 `my_submissions` 行、无 `items` 行 ⇒ 用 `toLocalContainer` 现有口径重建；还原不出落 `localOnly` 终态；独立幂等标志位、绝不抛错）；⑥ 课时 400 取证（`mapSubmitFailure` 文案追加节点 `code` 原文 + `EditStage` 增 `submit` + 两个编辑页提交失败落 `edit-surface.log`）与「加一课」入口前置检查父课程台账态；⑦ 版本 `0.20.2`/`27` 与四步发布收口。覆盖册子 §7 的 AC 1–9。

**Architecture:** 全部改动落在「平台适配层内部 + 纯函数 + 薄页面接线」三层：`platform/uni.ts` 承担路径归一化、目录下钻策略与落盘根探测三件平台职责（`FsAdapter` 接口零改动，`rootDir()` 仍是唯一入口，`core/*` 不 import `'uni'`）；`core/creator-migrate.ts` 复用既有 `containerFormFromLedger` + `toLocalContainer` 出口补一轮纯本地自愈，不新造哈希、不新表；`core/submit.ts` 只改一行文案拼装；两个编辑页只在既有失败分支加一次日志调用。**零新 HTTP 接口、零节点改动、零新配置项。**

**Tech Stack:** TypeScript + Vue 3 + uni-app（`apps/mobile`）／ HTML5+ `plus.io` / `plus.sqlite` ／ vitest ／ `core/fakes.ts`（`MemoryRepo` / `FakeHttp` / `MemoryFs`）／ `vue-tsc@^2`（`#61` 已进 `typecheck`）／ PowerShell 5.1。

**上游 spec:** `docs/superpowers/specs/2026-10-01-base-runtime-root-and-ledger-heal-design.md`（册子 `#63`，本册权威需求来源）；直接上游 `#56`（本地乐观落库 + 台账三态 + 一次性自愈迁移）、`#60`（选文件能力探针 / `toPlusUrl` 的 `file://` 处理 / 免票删除）、`#61`+`#62`（容器编辑与失败行出路，已发布 `0.20.1`/`26`）。上一计划 `docs/superpowers/plans/2026-10-01-base-container-edit-deadend-fix-plan.md`（`#62`）。

---

## 开工前已核实的现状（执行时直接用，不要重新调研）

| 事实 | 位置（仓库根 = `e:\code\base`） |
| --- | --- |
| `const DOC = '_doc'` | `apps/mobile/src/platform/uni.ts:296` |
| `toPlusUrl` 现状：`file://` 输入走 `convertLocalFileSystemURL`（**丢 scheme**） | `apps/mobile/src/platform/uni.ts:304-309` |
| `dirEntry(absDir)`：`file://` 整串 `resolveUrl`，否则 `split('/')` 逐段 `getDirectory(create:true)`，失败文案 `建目录失败 ${absDir}/${name}` | `apps/mobile/src/platform/uni.ts:323-338` |
| `fileEntry(absPath, create)` 内部调 `this.dirEntry(dir)`（**恒 create:true**），失败文案 `打开文件失败 ${absPath}` | `apps/mobile/src/platform/uni.ts:340-349` |
| `rootDir()` 固定返回 `${convertLocalFileSystemURL('_doc')}/base` | `apps/mobile/src/platform/uni.ts:351-353` |
| `ensureDir(dir)` = `dirEntry(dir)`（**不在 `FsAdapter` 接口里**，只有 `PlusFs` 有） | `apps/mobile/src/platform/uni.ts:356-358`、`apps/mobile/src/platform/adapter.ts:4-12` |
| `readFile` / `exists` / `remove` / `size` 都走 `fileEntry(path, false)` | `apps/mobile/src/platform/uni.ts:375-413` |
| `PlusRuntime` 接口（`io` / `sqlite` / 可选 `runtime`），**无 `android`** | `apps/mobile/src/platform/uni.ts:76-86` |
| `PlusLocalDb` 连接名固定 `'base'`（`LOCAL_DB`），`open()` 先 `isOpen()` 再 `close()` | `apps/mobile/src/platform/uni.ts:168-169`、`:176-183`、`:254-268` |
| `bootstrap()`：`rootDir()` → `ensureDir(root)` → `new PlusLocalDb(p, `${root}/base.db`)` → `opts.workDir = root` | `apps/mobile/src/platform/index.ts:25-28`、`:61` |
| `toPlusUrl` 既有三条断言（其中 `:41` 断言丢 scheme 的当前行为）＋ `fakeIo()`（`'_doc'` → `/storage/emulated/0/Android/data/base/doc`） | `apps/mobile/src/platform/uni.test.ts:22-51` |
| `PlusFs` 已导出、`PlusRuntime` 已导出、`resolveUrl` 私有 | `apps/mobile/src/platform/uni.ts:311-320` |
| `PROBES` 十四条；`fs.bigfile` = `:178-202`、`fs.meta` = `:203-224` | `apps/mobile/src/core/selfcheck.ts:132-383` |
| `CheckContext = { adapters, repo, db, nodeBaseUrl, workDir }`（`workDir` 已在，无需加字段）；`PROBE_DIR = 'selfcheck'` | `apps/mobile/src/core/selfcheck.ts:86-92`、`:126` |
| 自检测试：`ALL_IDS` 十四条（`:78-93`）、`new Array(14)`（`:133`）、`toHaveLength(14)`（`:178`） | `apps/mobile/src/core/selfcheck.test.ts` |
| `runCreatorVisibilityMigration(o: SubmitOptions)`；幂等键 `creator_visibility_migrated` / 版本 `'0.18.0'`；`MigrationResult` | `apps/mobile/src/core/creator-migrate.ts:13-33` |
| 容器行重建出口 `containerFormFromLedger(row)`（`itemId` 取 `row.itemId`） | `apps/mobile/src/core/my-created.ts:88-103` |
| `toLocalContainer(form, updatedAt)` → `{ item, segments }`（`contentHash = segmentsContentHash(segments)`）；`buildContainerSegments` 同模块导出 | `apps/mobile/src/core/course-edit.ts:205-225` |
| `repo.getItem` / `listSubmissions` / `upsertLocalContainer(item, segments)` / `markSubmissionLocalOnly(id, reason)` / `getConfig` / `setConfig` | `apps/mobile/src/core/repo.ts:329`、`:595`、`:627`、`:655`、`:251`、`:256` |
| 课程页自愈调用点（在 `if (opts.nodeBaseUrl !== '')` 之内，串行） | `apps/mobile/src/pages/course/course.vue:167-170`；import 在 `:87` |
| `mapSubmitFailure(status, raw, itemId)`：`errorText(code, \`提交失败（HTTP ${status}）\`)`，**码不进文案** | `apps/mobile/src/core/submit.ts:221-230` |
| `errorText` 码表（`item_id_invalid` / `item_id_taken` / `item_segments_invalid` / …） | `apps/mobile/src/core/errors.ts:13-18` |
| 既有断言会因「文案带码」失效：`submit.test.ts:137`（`item_id_taken` → `该条目已被他人创建`）、`:240`（`item_id_invalid` → `条目 id 不合法`） | `apps/mobile/src/core/submit.test.ts` |
| `EditStage = 'pick' \| 'read' \| 'upload'` | `apps/mobile/src/core/editlog.ts:20` |
| 课程编辑页：`logFail(stage: 'pick' \| 'upload', e)` `:296-301`；`addLesson()` `:372-378`；`submit()` 尾段 `:449-463`；`ctx`（`AppContext`）在 `:205`、`pickRepo` 在 `:182` | `apps/mobile/src/pages/course/edit.vue` |
| 课时编辑页：`logFail` `:341-346`；`submit()` 尾段 `:469-494` | `apps/mobile/src/pages/lesson/edit.vue` |
| 版本 `0.20.1` / `26` | `apps/mobile/src/manifest.json:5-6` |
| 文档清单表（列 `# / path / 描述 / 不做 / 依赖 / 状态`），最新 `#63` 行 | `docs/README.md:89`（表头 `:25`）；§5 本册 bullet 在 `:134` |

**环境与工作区：** Windows PowerShell 5.1（**不支持 `&&` 与 heredoc**；多条命令用 `;` 分隔；`git commit` 用多个 `-m`）。手机端命令在 `e:\code\base\apps\mobile` 下跑。**工作区有其它未提交改动与未跟踪产物**（`.gitignore`、`apps/mobile/src/core/types.ts`、`internal/httpapi/web.go`、未跟踪 `based-linux-amd64`）——**本册一个都不碰、不 add**。每次只 `git add` 本任务列出的确切文件。

---

## 本计划的工程决策（册子已定死的部分不得翻案）

| # | 决策 | 理由 | 落点 |
| --- | --- | --- | --- |
| 1 | **`dirEntry` 的 `file://` 分支改为「锚定下钻」**：先整串 `resolveUrl` 试已存在的祖先前缀，命中后从该祖先逐段 `getDirectory(create)` 下钻；全段都不存在则抛 `建目录失败 … 无可解析的祖先目录` | 册子 §3.2 的候选 ① `<getFilesDir()>/base` **本身是待建目录**，纯整串 resolve 永远失败 ⇒ 探测恒失败、候选链形同虚设。锚定下钻只增不减：路径已存在时首轮整串 resolve 即命中，行为与现状逐字一致 | `platform/uni.ts` |
| 2 | **`toPlusUrl` 的返回形态逐字照册子 §3.3**（`_doc` 可折则折、其余补 `file://`、已是相对形态原样） | 决策 1 只改 `dirEntry` 的遍历策略，**不改 `toPlusUrl` 输出**，故 `uni.test.ts` 的语义变更范围与册子 §6 风险 4 完全一致 | `platform/uni.ts` |
| 3 | **`rootCandidates(io, android)` 做成导出纯函数**，`rootDir()` 只负责「依次实做探测 + 缓存胜出者」 | 候选链取值（`plus.android` 缺失 / 取值抛错要静默跳过）可直接单测，不必伪造 plus 内核 | `platform/uni.ts` |
| 4 | **探测只建目录 + 写 1 字节 + 读回 + 删，不探 SQLite** | `plus.sqlite.openDatabase` 的 `path` 现状就已是 `convertLocalFileSystemURL('_doc')` 给出的**绝对**路径（`platform/index.ts:28`）⇒ 绝对路径形态已被真机验证；候选 ① 与 ② 在 SQLite 侧同形，无新增失败面 | `platform/uni.ts` |
| 5 | **`rootDir()` 胜出者进程内缓存**（`private root: string \| null`），失败抛可读错误交 `bootstrap` 既有路径承接 | 册子 §3.2 明确「同一 `PlusFs` 实例不重复探测」；`bootstrap` 有 `cached` 单例，一次启动只探测一次 | `platform/uni.ts` |
| 6 | **`runLedgerHealMigration` 签名收窄为 `Pick<SubmitOptions, 'repo'>`**，调用点放在 `if (opts.nodeBaseUrl !== '')` **之外**（在既有迁移之后串行） | 本函数纯本地（读台账 + 写 `items`/`segments`），不需要 `adapters` / `nodeBaseUrl`；且册子 §6 风险 1 的「落盘根搬迁后节点地址丢失」场景下，把它关在 `nodeBaseUrl` 判据里等于自愈永不执行 | `core/creator-migrate.ts`、`pages/course/course.vue` |
| 7 | **自愈只补 `items` / `segments`**，不碰 `my_submissions.state` / `localOnly`；`segments.length === 0` 先走 `markSubmissionLocalOnly` 且**不建条目行** | 册子 §2.2 明文；`localOnly` 是终态单向（`#56 §2.4`） | `core/creator-migrate.ts` |
| 8 | **「加一课」提示里的状态文案用 `row.localOnly ? '仅本地留存' : statusLabelOf(row.state)`** | 与 `buildMyCreatedView`（`my-created.ts:56`）的展示口径逐字一致，同一条台账行在列表与提示里说同一句话 | `pages/course/edit.vue` |
| 9 | **`fs.root` 探测用 `c.adapters.fs.writeFile` 触发建目录，不调 `ensureDir`** | `ensureDir` **不在 `FsAdapter` 接口上**（`adapter.ts:4-12`），`CheckContext.adapters.fs` 是接口类型 ⇒ 调它 `vue-tsc` 必报错；`writeFile` 内部即 `fileEntry(create:true)`，等价且合法 | `core/selfcheck.ts` |
| 10 | **编辑页提交失败日志抽一个本地小函数 `logSubmit(msg)`**（课程页与课时页各一个），不在 `logFail` 上加分支 | `logFail` 收的是 `unknown` 异常对象，而提交失败分支拿到的是一条**字符串文案**（`out.message` / `e.message`），两处混用会退化成 `String(new Error(msg))` 这种绕圈写法 | `pages/course/edit.vue`、`pages/lesson/edit.vue` |
| 11 | **`submit.test.ts:137` 与 `:240` 两条断言必须同步改**（追加 `（<code>）`） | 文案带码是本册 AC 5 的直接要求，断言不同步会让门禁假红 | Task 5 |
| 12 | **真机 400 根因本册不下结论**：只保证「码可见 + 不注定失败的请求被入口挡住」；复测若仍 400，按码判读（册子 §6 风险 2） | 册子 §4.1 明文「不预设根因」 | Task 5/6/7、AC 5/6 |

---

## 文件结构

**新增**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| — | — | 本册**不新增任何文件**（测试全部并入既有 `*.test.ts`） |

**修改**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `apps/mobile/src/platform/uni.ts` | 修改 | `stripFileScheme` + `toPlusUrl` 重排（§3.1/§3.3）；`dirEntry(absDir, create)` 锚定下钻 + `childDir` 包装；`fileEntry` 透传 `create`；`rootCandidates` 导出 + `rootDir()` 候选链探测与缓存；`PlusRuntime.android?`（§3.2） |
| `apps/mobile/src/platform/uni.test.ts` | 修改 | `toPlusUrl` 断言更新 + 2 例新增；`dirEntry`/`fileEntry` 三例（假目录树）；`rootCandidates` 三例（AC 3/4 的纯函数面） |
| `apps/mobile/src/core/selfcheck.ts` | 修改 | `PROBES` 增 `fs.root`（紧随 `fs.meta`）；注释 14 → 15（§3.4） |
| `apps/mobile/src/core/selfcheck.test.ts` | 修改 | `ALL_IDS` 插 `fs.root`；两处 `14` → `15`；新增「落盘根明细含 `workDir`」一例 |
| `apps/mobile/src/core/creator-migrate.ts` | 修改 | 导出 `LEDGER_HEAL_KEY` / `LEDGER_HEAL_VERSION` / `HealResult` / `runLedgerHealMigration`（§2.2） |
| `apps/mobile/src/core/creator-migrate.test.ts` | 修改 | 自愈四例（AC 1/2/7 的纯函数面） |
| `apps/mobile/src/core/submit.ts` | 修改 | `mapSubmitFailure` 文案追加 `（<code>）`（§4.2.1） |
| `apps/mobile/src/core/submit.test.ts` | 修改 | `:137` / `:240` 两条断言同步 + 新增「码进文案」一例（AC 5） |
| `apps/mobile/src/core/editlog.ts` | 修改 | `EditStage` 增 `'submit'`（§4.2.2） |
| `apps/mobile/src/core/editlog.test.ts` | 修改 | 追加第三条 `submit` 阶段日志断言 |
| `apps/mobile/src/pages/course/course.vue` | 修改 | import 补 `runLedgerHealMigration`；`load()` 内、`nodeBaseUrl` 判据之外串行调一次（§2.2） |
| `apps/mobile/src/pages/course/edit.vue` | 修改 | `logFail` 签名改 `EditStage` + 新增 `logSubmit`；`submit()` 两个失败分支各落一条；`addLesson()` 前置检查父课程台账态（§4.2.2/§4.2.3） |
| `apps/mobile/src/pages/lesson/edit.vue` | 修改 | `logFail` 签名改 `EditStage` + 新增 `logSubmit`；`submit()` 两个失败分支各落一条（§4.2.2） |
| `apps/mobile/src/manifest.json` | 修改 | 版本 `0.20.2`/`27`（Task 8） |
| `docs/README.md` | 修改 | 文档清单表登记 `#64` 行（写本计划时已登记）+ §5 本册 bullet 状态回填（Task 8） |

**不改动（硬边界）：** 节点侧一切（`internal/**` 零改动，尤其 `POST /v1/submit` 校验顺序与错误码、`store.SegmentsContentHash`、`POST /v1/proposal`、`/v1/release`）；`FsAdapter` / `StorageAdapter` / `HttpAdapter` / `PackReader` / `LocalDb` 五个接口；`core/sync.ts` 的 pack 落盘路径口径与 `applyPack`；`core/repo.ts` 与 `core/fakes.ts`（本册**不需要新仓储方法**）；`core/course-edit.ts` 的 `buildContainerSegments` / `validateContainerSegments` / `toLocalContainer` / `saveContainer` / `loadContainerForm` / `uploadAndStoreBlob`；`core/my-created.ts` 的 `containerFormFromLedger` / `buildMyCreatedView` / `ledgerActionsOf` / `canRemoveMyCreated`；`core/submit.ts` 的 `submitItem` / `enqueueOrSend` / `runFlushSubmissions` / `retrySubmission` / `writeLedger` 语义；台账三态与 `localOnly` 终态单向性；`#61 §4.2` 的「编辑 / 重试 / 删除 / 复建」矩阵；内容包规范 v1 与 `schema_version`；`attr.body_md` / `attr.category` 跨容器防御；不加配置项；不做 iOS。

---

### Task 1: `toPlusUrl` 归一化与读路径不建目录（缺陷 C 的代码级主因）

**Files:** Modify `apps/mobile/src/platform/uni.ts`；Modify `apps/mobile/src/platform/uni.test.ts`

- [ ] **Step 1: 改测试到新语义（先红）** —— 把 `apps/mobile/src/platform/uni.test.ts` 的 `describe('toPlusUrl：路径 → plus.io URL（本册 §3 附带修）')` 整段（`:37-51`）替换为：

  ```ts
  describe('toPlusUrl：路径 → plus.io URL（册子 #63 §3.1 / §3.3）', () => {
    const io = fakeIo();

    it('file:// 绝对路径（不在 _doc 下）保留 file:// 交整串 resolve —— 不再丢 scheme', () => {
      expect(toPlusUrl(io, 'file:///storage/emulated/0/DCIM/a.jpg')).toBe('file:///storage/emulated/0/DCIM/a.jpg');
    });

    it('file:// 形态落在 _doc 下 ⇒ 折成 _doc/…（相册临时图走这条）', () => {
      expect(toPlusUrl(io, 'file:///storage/emulated/0/Android/data/base/doc/uniapp_temp/a.jpg')).toBe(
        '_doc/uniapp_temp/a.jpg',
      );
    });

    it('file://x（无第三个斜杠）也归一成绝对路径', () => {
      expect(toPlusUrl(io, 'file://storage/emulated/0/DCIM/b.jpg')).toBe('file:///storage/emulated/0/DCIM/b.jpg');
    });

    it('_doc 平台路径折成 _doc/…', () => {
      expect(toPlusUrl(io, '/storage/emulated/0/Android/data/base/doc/base/pack')).toBe('_doc/base/pack');
    });

    it('其余绝对路径补 file:// 前缀，避免被当相对 URL', () => {
      expect(toPlusUrl(io, '/storage/other/x')).toBe('file:///storage/other/x');
    });

    it('已是相对形态（_doc/…）原样返回', () => {
      expect(toPlusUrl(io, '_doc/base/x')).toBe('_doc/base/x');
    });
  });

  /** 假目录树：目录 / 文件都用绝对路径集合表示；`_doc` 固定折到 `/doc`。 */
  function fakeTree(dirs: string[], files: string[] = []) {
    const D = new Set(dirs);
    const F = new Set(files);
    const entryOf = (path: string): PlusEntry =>
      ({
        getDirectory: (name: string, o: { create?: boolean }, ok: (e: PlusEntry) => void, err: (e: unknown) => void) => {
          const child = `${path}/${name}`;
          if (D.has(child)) return ok(entryOf(child));
          if (o.create === true) {
            D.add(child);
            return ok(entryOf(child));
          }
          err({ code: 15 });
        },
        getFile: (name: string, o: { create?: boolean }, ok: (e: unknown) => void, err: (e: unknown) => void) => {
          const child = `${path}/${name}`;
          if (F.has(child)) return ok({});
          if (o.create === true) {
            F.add(child);
            return ok({});
          }
          err({ code: 1 });
        },
      }) as unknown as PlusEntry;
    const io = {
      convertLocalFileSystemURL: (p: string) =>
        p === '_doc' ? '/doc' : p.startsWith('file://') ? p.slice('file://'.length) : p,
      resolveLocalFileSystemURL: (url: string, ok: (e: PlusEntry) => void, err: (e: unknown) => void) => {
        const path = url === '_doc' ? '/doc' : url.startsWith('file://') ? url.slice('file://'.length) : null;
        if (path !== null && D.has(path)) return ok(entryOf(path));
        err({ code: 5 });
      },
      FileReader: class {},
    } as unknown as PlusRuntime['io'];
    return { io, D, F };
  }

  describe('PlusFs 目录下钻（册子 #63 §3.2 / §3.3）', () => {
    function fsOf(t: { io: PlusRuntime['io'] }): PlusFs {
      return new PlusFs({ io: t.io } as unknown as PlusRuntime);
    }

    it('写路径逐段建目录（create:true 语义不变）', async () => {
      const t = fakeTree(['/doc', '/doc/base']);
      await fsOf(t).ensureDir('/doc/base/selfcheck');
      expect(t.D.has('/doc/base/selfcheck')).toBe(true);
    });

    it('读路径不建目录：exists 假且不留半截目录（AC 3 反面）', async () => {
      const t = fakeTree(['/doc', '/doc/base']);
      expect(await fsOf(t).exists('/doc/base/missing/x.bin')).toBe(false);
      expect(t.D.has('/doc/base/missing')).toBe(false);
    });

    it('file:// 绝对路径从已存在的祖先逐段建（候选 ① 落盘根探测就靠这条）', async () => {
      const t = fakeTree(['/data/user/0/pkg/files']);
      await fsOf(t).ensureDir('/data/user/0/pkg/files/base/.rootprobe');
      expect(t.D.has('/data/user/0/pkg/files/base/.rootprobe')).toBe(true);
    });
  });
  ```

  并把文件头 import 改为：`import { PlusFs, pickCapabilityOf, toPlusUrl, type PlusEntry, type PlusRuntime } from './uni';`

- [ ] **Step 2: 跑测试确认失败**

  Run（cwd `apps/mobile`）: `npx vitest run src/platform/uni.test.ts`
  Expected: 失败（`toPlusUrl` 仍丢 scheme；`dirEntry` 无 `create` 参数 ⇒ `ensureDir` 在缺段时行为与断言相反）。若 `PlusEntry` 未导出则同时报类型错——Step 3 会补导出。

- [ ] **Step 3: 改实现** —— 在 `apps/mobile/src/platform/uni.ts`：

  1）把 `:36` 的 `interface PlusEntry` 改为 `export interface PlusEntry`（测试要拿它当类型）；并在 `PlusRuntime` 接口内、`runtime?`（`:85`）之后插入：

  ```ts
    /** Android 侧运行时（plus.android）：取应用运行路径用；H5 / 老内核缺失（册子 #63 §3.2） */
    android?: {
      runtimeMainActivity(): { getFilesDir(): { getAbsolutePath(): string } };
    };
  ```

  2）把 `const DOC = '_doc';` 到 `toPlusUrl` 整段（`:296-309`）替换为：

  ```ts
  const DOC = '_doc';

  /** 只留绝对路径：剥掉 `file://` 并补前导 `/`（`file:///x` 与 `file://x` 都要归一）。 */
  function stripFileScheme(p: string): string {
    if (!p.startsWith('file://')) return p;
    const rest = p.slice('file://'.length);
    return rest.startsWith('/') ? rest : `/${rest}`;
  }

  /**
   * 路径 → plus.io 认的 URL（册子 #63 §3.1 / §3.3）。先归一成无 scheme 的绝对路径，再三分支：
   *  1. 落在 `_doc` 平台根之下 ⇒ 折成 `_doc/…`（官方支持的相对形态，可安全下钻）；
   *  2. 其余绝对路径 ⇒ 补 `file://`（裸 `/storage/…` 会被 plus.io 当相对 URL 读失败）；
   *  3. 本就不是绝对路径（已是 `_doc/…` 形态）⇒ 原样返回。
   */
  export function toPlusUrl(io: PlusRuntime['io'], absPath: string): string {
    const abs = stripFileScheme(absPath);
    if (!abs.startsWith('/')) return abs;
    const doc = stripFileScheme(io.convertLocalFileSystemURL(DOC));
    if (abs.startsWith(doc)) return DOC + abs.slice(doc.length);
    return `file://${abs}`;
  }
  ```

  3）把 `dirEntry` + `fileEntry` 两个方法（`:322-349`）整体替换为：

  ```ts
    /**
     * 目录入口。`_doc/…` 相对形态逐段下钻；`file://` 绝对路径先试整串解析（已存在即命中），
     * 失败则向上找第一个可解析的祖先前缀，再从该祖先逐段 `create` 下钻——候选落盘根本身就是
     * 待建目录，纯整串解析会让它恒失败（册子 #63 §3.2 / §3.3）。
     */
    private async dirEntry(absDir: string, create = true): Promise<PlusEntry> {
      const url = toPlusUrl(this.p.io, absDir);
      if (url.startsWith('file://')) {
        const segs = url.slice('file://'.length).split('/').filter(Boolean);
        for (let i = segs.length; i >= 1; i--) {
          let anchor: PlusEntry;
          try {
            anchor = await resolveUrl(this.p.io, `file:///${segs.slice(0, i).join('/')}`);
          } catch {
            continue; // 前缀不存在，继续向上退
          }
          let entry = anchor;
          for (const name of segs.slice(i)) entry = await this.childDir(entry, name, create, absDir);
          return entry;
        }
        throw new Error(`${create ? '建目录' : '打开目录'}失败 ${absDir}: 无可解析的祖先目录`);
      }
      const parts = url.split('/').filter(Boolean);
      let entry = await resolveUrl(this.p.io, parts[0] as string);
      for (const name of parts.slice(1)) entry = await this.childDir(entry, name, create, absDir);
      return entry;
    }

    /** `getDirectory` 的 Promise 包装；`create === false` 只打开、不建目录（册子 #63 §3.3）。 */
    private childDir(parent: PlusEntry, name: string, create: boolean, absDir: string): Promise<PlusEntry> {
      return new Promise<PlusEntry>((resolve, reject) => {
        parent.getDirectory(name, { create, exclusive: false }, resolve, (e) =>
          reject(new Error(`${create ? '建目录' : '打开目录'}失败 ${absDir}/${name}: ${JSON.stringify(e)}`)),
        );
      });
    }

    private async fileEntry(absPath: string, create: boolean): Promise<PlusEntry> {
      const cut = absPath.lastIndexOf('/');
      const dir = await this.dirEntry(absPath.slice(0, cut), create);
      const name = absPath.slice(cut + 1);
      return new Promise<PlusEntry>((resolve, reject) => {
        dir.getFile(name, { create, exclusive: false }, resolve, (e) =>
          reject(new Error(`打开文件失败 ${absPath}: ${JSON.stringify(e)}`)),
        );
      });
    }
  ```

- [ ] **Step 4: 跑测试确认通过**

  Run（cwd `apps/mobile`）: `npx vitest run src/platform/uni.test.ts`
  Expected: 全绿（`toPlusUrl` 六例 + 下钻三例）。

- [ ] **Step 5: Commit**

  ```powershell
  git add apps/mobile/src/platform/uni.ts apps/mobile/src/platform/uni.test.ts
  git commit -m "fix(mobile): toPlusUrl 剥 scheme 归一化 + 读路径不建目录" -m "册子 #63 §3.1/§3.3；目录下钻改锚定式（file:// 绝对路径先找已存在祖先）"
  ```

---

### Task 2: 落盘根候选链与实做探测

**Files:** Modify `apps/mobile/src/platform/uni.ts`；Modify `apps/mobile/src/platform/uni.test.ts`

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/mobile/src/platform/uni.test.ts` 末尾（`fakeIo` 已在文件内）：

  ```ts
  describe('rootCandidates：落盘根候选链（册子 #63 §3.2）', () => {
    const ANDROID = {
      runtimeMainActivity: () => ({ getFilesDir: () => ({ getAbsolutePath: () => '/data/user/0/uni.app.x/files' }) }),
    };

    it('① 应用运行路径在前、② _doc/base 兜底在后', () => {
      expect(rootCandidates(fakeIo(), ANDROID)).toEqual([
        '/data/user/0/uni.app.x/files/base',
        '/storage/emulated/0/Android/data/base/doc/base',
      ]);
    });

    it('无 plus.android（H5 / 老内核）⇒ 只剩 ②', () => {
      expect(rootCandidates(fakeIo(), undefined)).toEqual(['/storage/emulated/0/Android/data/base/doc/base']);
    });

    it('android 取值抛错 ⇒ 静默跳过 ①，不抛', () => {
      const boom = {
        runtimeMainActivity: () => {
          throw new Error('no android');
        },
      };
      expect(rootCandidates(fakeIo(), boom)).toEqual(['/storage/emulated/0/Android/data/base/doc/base']);
    });
  });
  ```

  并在文件头 import 里补 `rootCandidates`。

- [ ] **Step 2: 跑测试确认失败**

  Run（cwd `apps/mobile`）: `npx vitest run src/platform/uni.test.ts`
  Expected: 失败（`rootCandidates` 未定义）。

- [ ] **Step 3: 实现** —— 在 `apps/mobile/src/platform/uni.ts` 的 `toPlusUrl` 之后插入：

  ```ts
  /**
   * 落盘根候选链（册子 #63 §3.2）：① 应用运行路径（沙盒内，`getFilesDir()`）+ `/base`；
   * ② `_doc/base` 兜底（现状）。`plus.android` 缺失或取值抛错一律静默跳过 ①。
   */
  export function rootCandidates(io: PlusRuntime['io'], android: PlusRuntime['android']): string[] {
    const out: string[] = [];
    try {
      const files = android?.runtimeMainActivity().getFilesDir().getAbsolutePath();
      if (typeof files === 'string' && files !== '') out.push(`${stripFileScheme(files)}/base`);
    } catch {
      // plus.android 不可用：只留兜底候选
    }
    out.push(`${stripFileScheme(io.convertLocalFileSystemURL(DOC))}/base`);
    return out;
  }
  ```

  并把 `PlusFs` 的 `rootDir()`（`:351-353`）替换为（同时在类字段区加一行 `private root: string | null = null;`）：

  ```ts
    /** 唯一入口（`FsAdapter` 接口零改动）：候选链依次实做一次，首个全过者胜出并进程内缓存。 */
    async rootDir(): Promise<string> {
      if (this.root !== null) return this.root;
      const errs: string[] = [];
      for (const cand of rootCandidates(this.p.io, this.p.android)) {
        try {
          await this.probeRoot(cand);
          this.root = cand;
          return cand;
        } catch (e) {
          errs.push(`${cand}: ${(e as Error).message ?? String(e)}`);
        }
      }
      throw new Error(`落盘根不可用（${errs.join('；')}）`);
    }

    /** 「建目录 → 写 1 字节 → 读回 → 删」全过才算该候选可用（册子 #63 §3.2）。 */
    private async probeRoot(root: string): Promise<void> {
      const path = `${root}/.rootprobe/p.bin`;
      await this.writeFile(path, new Uint8Array([1]));
      try {
        const back = await this.readFile(path);
        if (back.length !== 1 || back[0] !== 1) throw new Error(`读回 ${back.length} 字节，期望 1`);
      } finally {
        await this.remove(path);
      }
    }
  ```

- [ ] **Step 4: 跑测试确认通过**

  Run（cwd `apps/mobile`）: `npx vitest run src/platform/uni.test.ts`
  Expected: 全绿（新增三例）。

- [ ] **Step 5: Commit**

  ```powershell
  git add apps/mobile/src/platform/uni.ts apps/mobile/src/platform/uni.test.ts
  git commit -m "feat(mobile): 落盘根候选链与实做探测" -m "册子 #63 §3.2；rootDir 由固定 _doc/base 改为候选链胜出者并缓存"
  ```

---

### Task 3: 自检新增「落盘根可用」探测

**Files:** Modify `apps/mobile/src/core/selfcheck.ts`；Modify `apps/mobile/src/core/selfcheck.test.ts`

- [ ] **Step 1: 写失败测试** —— 在 `apps/mobile/src/core/selfcheck.test.ts`：

  1）`ALL_IDS`（`:78-93`）在 `'fs.meta',` 之后插入 `'fs.root',`，并把注释改为 `/** 15 条探测的展示顺序（spec §3）。 */`；
  2）用例 1 的 `new Array(14).fill('ok')`（`:133`）改为 `new Array(15).fill('ok')`；
  3）用例 3 的 `expect(r.items).toHaveLength(14);`（`:178`）改为 `15`；
  4）在 `describe('runSelfCheck')` 内追加：

  ```ts
    it('用例 15：落盘根明细 ok 且给出胜出全路径（册子 #63 §3.4）', async () => {
      const env = makeEnv({ withPack: true });
      const r = await runSelfCheck(env.ctx, { plus: FAKE_PLUS, pick: FAKE_PICK });

      const p = r.items.find((i) => i.id === 'fs.root');
      expect(p?.status).toBe('ok');
      expect(p?.detail).toContain('/work');
      // 污染控制：探测文件已删
      expect([...env.fs.files.keys()]).toEqual(['/work/pack-p1.sqlite']);
    });
  ```

- [ ] **Step 2: 跑测试确认失败**

  Run（cwd `apps/mobile`）: `npx vitest run src/core/selfcheck.test.ts`
  Expected: 失败（`ALL_IDS` 与真实顺序不一致 / `fs.root` 不存在）。

- [ ] **Step 3: 实现** —— 在 `apps/mobile/src/core/selfcheck.ts` 的 `fs.meta` 探测（`:203-224`）之后插入（并把 `:131` 的注释 `14 条探测` 改为 `15 条探测`）：

  ```ts
    {
      id: 'fs.root',
      group: '文件/库',
      name: '落盘根可用（建目录 / 写 / 读回 / 删）',
      affects: '封面 / 附件上传、编辑面日志',
      flag: 'fsOk',
      scope: 'local',
      async run(c, _plus, _pick) {
        // 落盘根候选链（册子 #63 §3.2）的胜出结果就在 c.workDir 里；此处再实做一次证明它可写可读。
        // 用 writeFile 而非 ensureDir：ensureDir 不在 FsAdapter 接口上（adapter.ts:4-12）。
        const path = `${c.workDir}/${PROBE_DIR}-root/root.bin`;
        await c.adapters.fs.writeFile(path, new Uint8Array([1]));
        try {
          const back = await c.adapters.fs.readFile(path);
          if (back.length !== 1 || back[0] !== 1) throw new Error(`读回 ${back.length} 字节，期望 1`);
        } finally {
          await c.adapters.fs.remove(path);
        }
        return `落盘根 ${c.workDir}`;
      },
    },
  ```

- [ ] **Step 4: 跑测试确认通过**

  Run（cwd `apps/mobile`）: `npx vitest run src/core/selfcheck.test.ts`
  Expected: 全绿。

- [ ] **Step 5: Commit**

  ```powershell
  git add apps/mobile/src/core/selfcheck.ts apps/mobile/src/core/selfcheck.test.ts
  git commit -m "feat(mobile): 自检新增落盘根可用明细" -m "册子 #63 §3.4；detail 给出胜出全路径，便于真机判读内部路径 vs _doc 路径"
  ```

---

### Task 4: 存量台账自愈（缺陷 A / B 同一根因）

**Files:** Modify `apps/mobile/src/core/creator-migrate.ts`；Modify `apps/mobile/src/core/creator-migrate.test.ts`；Modify `apps/mobile/src/pages/course/course.vue`

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/mobile/src/core/creator-migrate.test.ts` 末尾（`courseRow` / `segmentsContentHash` / `MemoryRepo` 已在文件内）：

  ```ts
  describe('runLedgerHealMigration：存量台账自愈（册子 #63 §2）', () => {
    it('有台账行、无条目行 ⇒ 按现行口径重建本地乐观条目，并写独立幂等标志位', async () => {
      const repo = new MemoryRepo();
      await repo.saveSubmission(courseRow());

      const res = await runLedgerHealMigration({ repo });

      expect(res).toEqual({ skipped: false, scanned: 1, healed: 1, localOnly: 0 });
      const item = (await repo.getItem('course/c1'))!;
      expect(item.source).toBe('local');
      expect(item.contentHash).toBe(segmentsContentHash(await repo.listSegments('course/c1')));
      expect(await repo.getConfig(LEDGER_HEAL_KEY)).toBe('0.20.2');
      // 状态一无所改（本函数只补 items / segments）
      const row = (await repo.getSubmission('course/c1'))!;
      expect(row.state).toBe('failed');
      expect(row.localOnly).toBe(false);
    });

    it('幂等：标志位已存在 ⇒ 零动作', async () => {
      const repo = new MemoryRepo();
      await repo.setConfig(LEDGER_HEAL_KEY, '0.20.2');
      await repo.saveSubmission(courseRow());

      expect(await runLedgerHealMigration({ repo })).toEqual({ skipped: true, scanned: 0, healed: 0, localOnly: 0 });
      expect(await repo.getItem('course/c1')).toBe(null);
    });

    it('行集还原不出（空 segments_json）⇒ 落 localOnly 终态、不建条目行', async () => {
      const repo = new MemoryRepo();
      await repo.saveSubmission(courseRow({ segmentsJson: '' }));

      const res = await runLedgerHealMigration({ repo });

      expect(res).toEqual({ skipped: false, scanned: 1, healed: 0, localOnly: 1 });
      const row = (await repo.getSubmission('course/c1'))!;
      expect(row.localOnly).toBe(true);
      expect(row.reason).toBe('本地数据无法还原，仅本地留存');
      expect(await repo.getItem('course/c1')).toBe(null);
    });

    it('tag 行不参与；已有条目行的容器跳过、内容一字不改', async () => {
      const repo = new MemoryRepo();
      await repo.saveSubmission(courseRow({ itemId: 'tag/x', type: 'tag' }));
      await repo.upsertLocalContainer(
        { itemId: 'course/c1', type: 'course', title: '既有标题', contentHash: 'h', updatedAt: 't' },
        [{ seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1' }],
      );
      await repo.saveSubmission(courseRow());

      const res = await runLedgerHealMigration({ repo });

      expect(res).toEqual({ skipped: false, scanned: 1, healed: 0, localOnly: 0 });
      expect((await repo.getItem('course/c1'))!.title).toBe('既有标题');
    });
  });
  ```

  并把 import 行改为：`import { CREATOR_VISIBILITY_MIGRATION_KEY, LEDGER_HEAL_KEY, runCreatorVisibilityMigration, runLedgerHealMigration } from './creator-migrate';`

- [ ] **Step 2: 跑测试确认失败**

  Run（cwd `apps/mobile`）: `npx vitest run src/core/creator-migrate.test.ts`
  Expected: 失败（`runLedgerHealMigration` / `LEDGER_HEAL_KEY` 未导出）。

- [ ] **Step 3: 实现** —— 在 `apps/mobile/src/core/creator-migrate.ts`：

  1）import 行 `import { buildContainerSegments } from './course-edit';` 改为 `import { buildContainerSegments, toLocalContainer } from './course-edit';`

  2）在 `const CREATOR_VISIBILITY_MIGRATION_VERSION`（`:16`）之后插入：

  ```ts
  /** 存量台账自愈的独立幂等标志位键（册子 #63 §2.2）。值 = 本册版本号。 */
  export const LEDGER_HEAL_KEY = 'ledger_heal_migrated';
  /** 标志位记录的版本号（与 `manifest.json` 同批版本）。 */
  export const LEDGER_HEAL_VERSION = '0.20.2';

  export interface HealResult {
    /** 已自愈过（标志位存在）⇒ 本轮零动作 */
    skipped: boolean;
    /** 参与扫描的容器台账行数 */
    scanned: number;
    /** 补齐条目行的行数 */
    healed: number;
    /** 行集还原不出、转「仅本地留存」终态的行数 */
    localOnly: number;
  }
  ```

  3）在文件末尾追加：

  ```ts
  /**
   * 存量台账自愈（册子 #63 §2）：`#56` 的本地乐观落库上线前产生的行只有 `my_submissions`、没有 `items`，
   * 于是「我创建的」删除取不到 `content_hash`、编辑页回填全空。这里按**现行口径**补一轮：
   * 缺条目行的容器行 → `containerFormFromLedger` → `toLocalContainer` → `upsertLocalContainer`；
   * 行集还原不出 ⇒ 沿用既有 `localOnly` 终态。**纯本地、幂等、绝不抛错、不改台账状态。**
   * 只读台账 + 写本地库，故只要 `repo`（调用点放在 `nodeBaseUrl` 判据之外）。
   */
  export async function runLedgerHealMigration(o: Pick<SubmitOptions, 'repo'>): Promise<HealResult> {
    if ((await o.repo.getConfig(LEDGER_HEAL_KEY)) !== null) {
      return { skipped: true, scanned: 0, healed: 0, localOnly: 0 };
    }
    const rows = (await o.repo.listSubmissions()).filter((r) => r.type === 'course' || r.type === 'lesson');
    let healed = 0;
    let localOnly = 0;
    for (const row of rows) {
      if ((await o.repo.getItem(row.itemId)) !== null) continue; // 已有条目行即跳过（幂等核心）
      const { item, segments } = toLocalContainer(containerFormFromLedger(row), new Date().toISOString());
      if (segments.length === 0) {
        await o.repo.markSubmissionLocalOnly(row.itemId, '本地数据无法还原，仅本地留存');
        localOnly += 1;
        continue;
      }
      await o.repo.upsertLocalContainer(item, segments);
      healed += 1;
    }
    await o.repo.setConfig(LEDGER_HEAL_KEY, LEDGER_HEAL_VERSION);
    return { skipped: false, scanned: rows.length, healed, localOnly };
  }
  ```

- [ ] **Step 4: 跑测试确认通过**

  Run（cwd `apps/mobile`）: `npx vitest run src/core/creator-migrate.test.ts`
  Expected: 全绿（原 5 例 + 新 4 例）。

- [ ] **Step 5: 接线 `pages/course/course.vue`** —— import 行 `:87` 改为：

  ```ts
  import { runCreatorVisibilityMigration, runLedgerHealMigration } from '../../core/creator-migrate';
  ```

  并把 `load()` 里 `:167-170` 整段替换为：

  ```ts
    // 一次性自愈迁移（册子 #56 §2.4）：幂等——标志位已存在即零动作；未配置节点则跳过。
    if (opts.nodeBaseUrl !== '') {
      await runCreatorVisibilityMigration(opts);
    }
    // 存量台账自愈（册子 #63 §2.2）：纯本地、不依赖节点地址 ⇒ 放在上面判据之外，串行执行。
    await runLedgerHealMigration({ repo });
  ```

- [ ] **Step 6: 静态自检 + Commit**

  Run（cwd `apps/mobile`）: `npx vitest run src/core/creator-migrate.test.ts`
  Expected: 全绿。

  ```powershell
  git add apps/mobile/src/core/creator-migrate.ts apps/mobile/src/core/creator-migrate.test.ts apps/mobile/src/pages/course/course.vue
  git commit -m "feat(mobile): 存量台账自愈，补齐缺失的本地条目行" -m "册子 #63 §2；修「我创建的」删除报内容哈希缺失 + 编辑页回填空"
  ```

---

### Task 5: 提交失败文案贯通节点 `code`（缺陷 D 的一半）

**Files:** Modify `apps/mobile/src/core/submit.ts`；Modify `apps/mobile/src/core/submit.test.ts`

- [ ] **Step 1: 改测试（先红）** —— 在 `apps/mobile/src/core/submit.test.ts`：

  1）`:137` 一行改为：

  ```ts
      expect((await repo.getSubmission('article/taken1'))!.reason).toBe('该条目已被他人创建（item_id_taken）');
  ```

  2）`:240` 一行改为：

  ```ts
      expect((await repo.getSubmission('course/c1/lesson/l1/quiz/q1'))!.reason).toBe('条目 id 不合法（item_id_invalid）');
  ```

  3）追加一例（`describe` 内，与 `:436` 那例同区）：

  ```ts
    it('码原文进文案：无码走裸兜底、有码追加（<code>）（册子 #63 §4.2.1）', async () => {
      const a = env();
      a.http.postRoutes.set(`${BASE}/v1/submit`, { status: 400, body: utf8('{"error":"boom"}') });
      await a.repo.saveSubmission(containerRow({ state: 'failed', reason: '旧' }));
      expect((await retrySubmission(a.o, 'course/c1')).message).toBe('提交失败（HTTP 400）');

      const b = env();
      b.http.postRoutes.set(`${BASE}/v1/submit`, { status: 400, body: utf8('{"code":"item_title_invalid"}') });
      await b.repo.saveSubmission(containerRow({ state: 'failed', reason: '旧' }));
      expect((await retrySubmission(b.o, 'course/c1')).message).toBe('标题需 1–200 字且不含控制字符（item_title_invalid）');
    });
  });

  > 中文部分取自 `apps/mobile/src/core/errors.ts:10`，逐字照抄。

- [ ] **Step 2: 跑测试确认失败**

  Run（cwd `apps/mobile`）: `npx vitest run src/core/submit.test.ts`
  Expected: 三条断言失败（现文案不带码）。

- [ ] **Step 3: 实现** —— 把 `apps/mobile/src/core/submit.ts:221-230` 整段替换为：

  ```ts
  /** 节点错误码 → 用户可读错误；`code` 决定它是「暂时」还是「永久」（本册 §9.3）。 */
  function mapSubmitFailure(status: number, raw: string, itemId: string): SubmitError {
    const code = errorCodeOf(raw);
    if (status === 429 || code === 'item_rate_limited') {
      return new SubmitError('rate_limited', errorText(code, '提交过于频繁，请稍后再试'));
    }
    // 码原文一并进文案（册子 #63 §4.2.1）：toast / 台账 reason / 编辑面日志一处改动全链路可见。
    const base = errorText(code, `提交失败（HTTP ${status}）`);
    const message = code === '' ? base : `${base}（${code}）`;
    // 4xx（除 429）= 永久失败；5xx = 节点侧问题，视为暂时（本计划口径填空 4）
    return new SubmitError(status >= 400 && status < 500 ? 'rejected' : 'server', message);
  }
  ```

- [ ] **Step 4: 跑测试确认通过**

  Run（cwd `apps/mobile`）: `npx vitest run src/core/submit.test.ts`
  Expected: 全绿。

- [ ] **Step 5: Commit**

  ```powershell
  git add apps/mobile/src/core/submit.ts apps/mobile/src/core/submit.test.ts
  git commit -m "feat(mobile): 提交失败文案贯通节点 code 原文" -m "册子 #63 §4.2.1；真机上可直接判读是 item_* 哪一条"
  ```

---

### Task 6: `EditStage` 增 `submit` 阶段 + 两个编辑页提交失败落日志

**Files:** Modify `apps/mobile/src/core/editlog.ts`；Modify `apps/mobile/src/core/editlog.test.ts`；Modify `apps/mobile/src/pages/course/edit.vue`；Modify `apps/mobile/src/pages/lesson/edit.vue`

- [ ] **Step 1: 改测试（先红）** —— 把 `apps/mobile/src/core/editlog.test.ts` 的「两次失败追加而非覆盖」用例（`:42-50`）替换为：

  ```ts
    it('三次失败追加而非覆盖（含 submit 阶段，册子 #63 §4.2.2）', async () => {
      const fs = new MemoryFs();
      await recordEditFailure(fs, WORK_DIR, 'read', '读文件失败');
      await recordEditFailure(fs, WORK_DIR, 'upload', '上传失败');
      await recordEditFailure(fs, WORK_DIR, 'submit', '条目 id 不合法（item_id_invalid）');
      const lines = logText(fs).split('\n').filter((l) => l !== '');
      expect(lines).toHaveLength(3);
      expect((JSON.parse(lines[0]!) as { stage: string }).stage).toBe('read');
      expect((JSON.parse(lines[1]!) as { stage: string }).stage).toBe('upload');
      expect((JSON.parse(lines[2]!) as { stage: string }).stage).toBe('submit');
    });
  ```

- [ ] **Step 2: 跑测试确认失败**

  Run（cwd `apps/mobile`）: `npx vitest run src/core/editlog.test.ts`
  Expected: 类型错（`'submit'` 不在 `EditStage` 里）。

- [ ] **Step 3: 实现** —— `apps/mobile/src/core/editlog.ts:19-20` 替换为：

  ```ts
  /** 编辑面四个失败阶段（`submit` 为册子 #63 §4.2.2 新增）。 */
  export type EditStage = 'pick' | 'read' | 'upload' | 'submit';
  ```

- [ ] **Step 4: 跑测试确认通过**

  Run（cwd `apps/mobile`）: `npx vitest run src/core/editlog.test.ts`
  Expected: 全绿。

- [ ] **Step 5: 课程编辑页接线** —— `apps/mobile/src/pages/course/edit.vue`：

  1）import 行 `:160` 改为：

  ```ts
  import { recordEditFailure, type EditStage } from '../../core/editlog';
  ```

  2）`logFail` 签名（`:296-301`）改为：

  ```ts
  /** 失败落本地日志（`workDir/edit-surface.log`）；取消不落，日志写失败静默不影响主流程。 */
  async function logFail(stage: EditStage, e: unknown) {
    if (!ctx) return;
    // 适配器在 `ctx.opts.adapters`（`AppContext` 没有 `adapters`）——写错会二次抛错掩码真实失败（册子 #61 §3）
    await recordEditFailure(ctx.opts.adapters.fs, ctx.opts.workDir, stage, String((e as Error)?.message ?? e));
  }

  /** 提交失败现场（册子 #63 §4.2.2）：手里已是字符串文案，直接落 `submit` 阶段。 */
  async function logSubmit(msg: string) {
    if (!ctx) return;
    await recordEditFailure(ctx.opts.adapters.fs, ctx.opts.workDir, 'submit', msg);
  }
  ```

  3）`submit()` 尾段（`:456-463`）改为：

  ```ts
      // pending 会自动补发；failed 需回「我的条目」删除后重投
      notice.value = out.message;
      await logSubmit(out.message);
    } catch (e) {
      error.value = (e as Error).message;
      await logSubmit(error.value);
    } finally {
      busy.value = false;
    }
  ```

- [ ] **Step 6: 课时编辑页接线** —— `apps/mobile/src/pages/lesson/edit.vue`：

  1）import 行 `:182` 改为：

  ```ts
  import { recordEditFailure, type EditStage } from '../../core/editlog';
  ```

  2）`logFail`（`:341-346`）替换为与课程页逐字相同的 `logFail` + `logSubmit` 两函数（Step 5 的第 2 条）。

  3）`submit()` 尾段（`:487-493`）改为：

  ```ts
      notice.value = out.message;
      await logSubmit(out.message);
    } catch (e) {
      error.value = (e as Error).message;
      await logSubmit(error.value);
    } finally {
      busy.value = false;
    }
  ```

- [ ] **Step 7: 静态自检 + Commit**

  Run（cwd `apps/mobile`）: `npx vitest run src/core/editlog.test.ts; npm run typecheck`
  Expected: 测试全绿、`vue-tsc` 无输出。

  ```powershell
  git add apps/mobile/src/core/editlog.ts apps/mobile/src/core/editlog.test.ts apps/mobile/src/pages/course/edit.vue apps/mobile/src/pages/lesson/edit.vue
  git commit -m "feat(mobile): 提交失败落 edit-surface.log（新增 submit 阶段）" -m "册子 #63 §4.2.2；toast 与日志同时可见节点 code 原文"
  ```

---

### Task 7: 「加一课」前置检查父课程台账态

**Files:** Modify `apps/mobile/src/pages/course/edit.vue`

- [ ] **Step 1: import 补齐** —— `:159` 一行改为：

  ```ts
  import { containerFormFromLedger, statusLabelOf } from '../../core/my-created';
  ```

- [ ] **Step 2: `addLesson()` 整段替换**（`:372-378`）：

  ```ts
  /**
   * 加一课：父课程台账非 `sent` 时先在入口阻断（册子 #63 §4.2.3）——节点不校验父存在，
   * 课时会变成孤立条目；先给可操作原因，比再发一次注定失败的请求更有信息量。
   */
  async function addLesson() {
    if (pickRepo) {
      const row = await pickRepo.getSubmission(form.value.itemId);
      if (row && row.state !== 'sent') {
        const label = row.localOnly ? '仅本地留存' : statusLabelOf(row.state);
        error.value = `课程尚未提交成功（当前：${label}）。请先保存课程，提交成功后再添加课时`;
        return;
      }
    }
    const id = newLessonID(form.value.itemId);
    const row: ChildRow = { kind: 'lesson', itemId: id };
    form.value.children.push(row);
    openLesson(row);
  }
  ```

- [ ] **Step 3: 静态自检**

  Run（cwd `apps/mobile`）: `npm run typecheck`
  Expected: 无输出。
  Run（仓库根）: `git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- apps/mobile/src/pages`
  Expected: 无输出。

- [ ] **Step 4: Commit**

  ```powershell
  git add apps/mobile/src/pages/course/edit.vue
  git commit -m "feat(mobile): 加一课前置检查父课程台账态" -m "册子 #63 §4.2.3；父课程非 sent 时给可操作提示且不发请求"
  ```

---

### Task 8: 门禁、版本号、文档回填与四步发布

**Files:** Modify `apps/mobile/src/manifest.json`；Modify `docs/README.md`；Modify 本计划文末「执行实况」

- [ ] **Step 1: 门禁全跑（发布前）**

  Run（cwd `apps/mobile`）: `npx vitest run`
  Expected: 全绿，用例数只增不减。
  Run（cwd `apps/mobile`）: `npm run typecheck`
  Expected: 无输出。
  Run（cwd `apps/mobile`）: `npm run build:h5`
  Expected: 构建成功。
  Run（cwd `apps/mobile`）: `npm run build:app`
  Expected: 构建成功。
  Run（cwd `apps/mobile`）: `git grep -nE '理目录|ensureDir' -- src/core src/platform`
  Expected: 仅 `platform/uni.ts` 的 `ensureDir` 定义/调用（`core/*` 不得出现目录 API）。
  Run（仓库根）: `go test ./...`
  Expected: 全包 ok。
  Run（仓库根）: `git diff --stat -- internal/`
  Expected: **无输出**（本册零节点改动，故不交叉编译、不部署节点二进制）。

- [ ] **Step 2: 版本号** —— 把 `apps/mobile/src/manifest.json:5-6` 替换为：

  ```json
      "versionName" : "0.20.2",
      "versionCode" : "27",
  ```

- [ ] **Step 3: 文档回填** —— 把 `docs/README.md:134`（本册 bullet）末尾的状态句替换为：

  ```markdown
  状态：**已发布 `0.20.2`/`27`**（实施计划 `#64` 见 `plans/2026-10-01-base-runtime-root-and-ledger-heal-plan.md`，Task 1–8；执行实况见其文末）。
  ```

  并在本计划文末「执行实况」回填：逐 Task commit、门禁实测输出、APK 字节数 / sha256 / 证书 SHA1、线上三处核对原文。

- [ ] **Step 4: Commit + push**

  ```powershell
  git add apps/mobile/src/manifest.json docs/README.md docs/superpowers/plans/2026-10-01-base-runtime-root-and-ledger-heal-plan.md
  git commit -m "chore: 版本 0.20.2/27 并回填计划 #64 执行实况" -m "仅动 apps/mobile 与 docs，零节点改动"
  git push
  ```

- [ ] **Step 5: 四步发布（沿用 `0.20.1` 已验证口径，一气呵成）**

  1. HBuilderX `cli pack` 云打包：

     ```powershell
     & 'D:\HBuilderX\cli.exe' pack --project e:\code\base\apps\mobile --platform android --android.packagename uni.app.UNI936A667 --android.androidpacktype 3
     ```

     产物核对以**包内** `version.name=0.20.2` / `version.code=27` 为准，不看构建目录。
  2. `scp` 上传到 `/opt/appdl/base-0.20.2.apk`（核对远端 sha256 与本地逐字一致）。
  3. `/opt/appdl/index.html` **整页重写**改指 `0.20.2`（不得残留 `0.20.1`）。
  4. 服务器上 `based release -version-name 0.20.2 -min-version-name 0.8.0 -apk-url http://118.190.217.242/dl/base-0.20.2.apk -apk-file /opt/appdl/base-0.20.2.apk -notes <备注> -out /opt/base-cache/data/release.json`（确认无游离副本）。
  5. 线上核对：`GET /v1/release` → `0.20.2`（`apk_size` / `apk_sha256` 与本地逐字一致）、`HEAD /dl/base-0.20.2.apk` = 200（`Content-Length` 与本地一致）、`GET /` 指向 `0.20.2`；证书 SHA1 = `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`（与 `0.6.0`–`0.20.1` 一致 ⇒ 可覆盖安装）。
  6. 只读探活无回归：`/v1/comment` → 200、`/v1/proposal` → 200、`POST /v1/blob` → 400、`/v1/blobzzz` → 404。

  证据全部回填到本计划文末「执行实况」，**不落仓库产物**。

---

## 自检（写完计划后已核）

**1. 册子覆盖：** §2 → Task 4（自愈 + 接线）；§3.1 → Task 1 Step 3（`toPlusUrl` 剥 scheme）；§3.2 → Task 2（候选链 + 探测 + 缓存）；§3.3 → Task 1（`create` 透传 + 文案分流）；§3.4 → Task 3（`fs.root` 探测）；§4.2.1 → Task 5；§4.2.2 → Task 6（`EditStage` + 两个编辑页）；§4.2.3 → Task 7；§5 → Task 8。**无遗漏。**

**2. 占位符扫描：** 无 TBD / TODO / 「类似 Task N」；每个改代码的步骤都给了完整替换文本与确切行号（所有期望文案均取自仓库现状，无「以实际为准」的活口）。

**3. 类型一致性：** `stripFileScheme`（Task 1 私有）/ `toPlusUrl`（Task 1 改签名不变）/ `dirEntry(absDir, create = true)`、`childDir(parent, name, create, absDir)`、`fileEntry(absPath, create)`（Task 1）/ `rootCandidates(io, android)`、`PlusRuntime.android?`、`PlusFs.root`、`probeRoot(root)`（Task 2）/ `fs.root`（Task 3）/ `LEDGER_HEAL_KEY`、`LEDGER_HEAL_VERSION`、`HealResult`、`runLedgerHealMigration(o: Pick<SubmitOptions,'repo'>)`（Task 4，接线在 `course.vue`）/ `EditStage` 含 `'submit'`、`logSubmit(msg)`（Task 6，两页签名逐字一致）/ `statusLabelOf`（Task 7）——**定义处与使用处逐字一致。**

**4. 与本册硬边界核对：** 未改任何 `FsAdapter` / `LocalRepo` / `LocalDb` 接口；未新增仓储方法；未动 `internal/**`；未新增 HTTP 接口；未改内容包规范；未加配置项；`core/*` 不 import `'uni'`（`rootCandidates` 收的是注入的 `io` 与 `android` 句柄）。

---

## AC 对照（册子 §7）

| AC | 内容 | 落点 |
|---|---|---|
| 1 | 删除不再报「本地缺少该条目的内容哈希」 | Task 4 Step 1 第 1 例（`contentHash` 与 `segments` 同哈希口径）+ 真机 |
| 2 | 编辑课程标题 / 简介 / 课时清单回填 | Task 4 Step 1 第 1 例 + 真机（`toLocalContainer` 写的就是 `loadContainerForm` 读的同一套行） |
| 3 | 选图 → 上传成功；自检不再出现 `建目录失败` | Task 1（`toPlusUrl` + 锚定下钻 + 读不建目录）+ 真机 |
| 4 | 自检「落盘根可用」ok 且 detail 给出胜出全路径 | Task 2 Step 1（候选链三例）+ Task 3 Step 1（`fs.root` 明细） |
| 5 | 课时 400 的 toast 与 `edit-surface.log` 均含节点 `code` 原文 | Task 5 Step 1（文案带码）+ Task 6 Step 1/5/6（`submit` 阶段落日志） |
| 6 | 父课程台账非 `sent` ⇒ 「加一课」给提示且**不发请求**；`sent` / 无台账行照常 | Task 7 Step 2 |
| 7 | 幂等：二次启动零动作；已有条目行的 id 一字不改 | Task 4 Step 1 第 2、4 例 |
| 8 | Go 全包 ok、mobile 全用例绿、`vue-tsc` 干净、`build:h5` / `build:app` 通过 | Task 8 Step 1 |
| 9 | `0.20.2`/`27` 上线，`GET /v1/release`、`HEAD /dl/base-0.20.2.apk`、`GET /` 三处一致 | Task 8 Step 5 |

**真机验收（用户侧，本计划不含自动化）**：升级后先看「设置 → 基座自检」的**落盘根明细**——它直接告诉本次是哪条候选胜出（内部路径 = 走候选 ①，`_doc` 路径 = 走了兜底）。若为候选 ①，须按册子 §6 风险 1 重填节点地址 → 同步 → 核对台账；随后复验 AC 1/2/3；若课时仍 400，把 toast 或 `edit-surface.log` 里的 `（<code>）` 原文回传（**不在无码的情况下猜改节点或客户端校验**，册子 §6 风险 2）。

---

## 执行实况

**执行方式：** 子代理驱动（每 Task 一个 fresh `general-purpose` 子代理；Task 间两阶段审查 ＝ 查 diff + 跑门禁）。

**逐 Task commit（均在 `apps/mobile` 侧，按序）：**

| Task | commit | 说明 |
| --- | --- | --- |
| 1 | `b8455f5` | `toPlusUrl` 剥 `file://` scheme 归一化 + 读路径不建目录 |
| 2 | `1c9b01f` | 落盘根候选链与实做探测 |
| 3 | `c48d964` | 自检新增落盘根可用明细 |
| 4 | `b5dc0b3` | 存量台账自愈，补齐缺失的本地条目行 |
| 5 | `650e488` | 提交失败文案贯通节点 code 原文 |
| 6 | `b24310a` | 提交失败落 `edit-surface.log`（新增 `submit` 阶段） |
| 7 | `d74d27e` | 加一课前置检查父课程台账态 |

**各 Task 门禁实测：**
- Task 1–3（平台层）：`npx vitest run src/platform/uni.test.ts` **15/15** 全绿；`src/core/selfcheck.test.ts` **14/14** 全绿。
- Task 4：`src/core/creator-migrate.test.ts` 由 5 例 → **9/9** 全绿；先红证据 `TypeError: runLedgerHealMigration is not a function`（`4 failed | 5 passed`）。
- Task 5：`src/core/submit.test.ts` **25/25** 全绿；先红 `3 failed | 22 passed`（`item_id_taken` / `item_id_invalid` / 新例三条断言不带码）。
- Task 6：`src/core/editlog.test.ts` **6/6** 全绿；`'submit'` 的类型红由 `npm run typecheck` 证实（`vitest` 走 esbuild 仅剥类型，不跑类型检查）。
- Task 7：模板 `.value` 硬检查（`git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- apps/mobile/src/pages`）**无输出**；`typecheck` 无新增。

**Task 8 门禁全跑（2026-10-01）：**
- `npx vitest run`（cwd `apps/mobile`）：**36 文件 / 451 用例全绿**。
- `npm run typecheck`（cwd `apps/mobile`）：**仅 2 条册外既有错误、无新增** —— `src/pages/governance/governance.vue(58,7)` TS2741、`src/pages/submit/submit.vue(156,5)` TS2322（沿用 #62 登记惯例，按决策 12 不修、仅登记）。
- `npm run build:h5`：`DONE  Build complete.`
- `npm run build:app`：`DONE  Build complete.`
- `git grep -nE '理目录|ensureDir' -- src/core src/platform`：仅 `platform/uni.ts`（定义）与 `platform/index.ts`（调用）；`core/*` 无目录 API。
- `go test ./...`（仓库根）：全包 `ok`。
- `git diff --stat -- internal/`：**无输出** —— 本册零节点改动，故不交叉编译、不部署节点二进制。

**版本：** `apps/mobile/src/manifest.json` → `0.20.2` / `27`。

**发布证据（四步 + 线上核对）：**（待回填）
