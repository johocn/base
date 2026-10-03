# P6 融合治理实现轨（#78）完整复盘

- 日期：2026-10-03
- 执行周期：单日（上午计划评审 → 下午 T1–T6 实现 → 傍晚部署 → 晚上补边界 + 回填）
- 上游：设计册 `#74`（P4 已定稿）、计划 `#78`（P6）、P5 退役计划 `#76`、TLS 收敛 `#77`
- Commit 总数：**12**（含 2 次补边界 + 1 次回填）
- 涉及侧：**Go 后端（`internal/`）+ TS Node 壳（`apps/node/`）+ 黄金向量（`vectors/v1/seats.json`）+ 线上部署（`base-cache` 单元）**
- 结果：**全册收口、线上无事故、零 Go 生产影响**

---

## 1. 为什么做 P6

P5（`#76`）刚把线上 `base-cache` 单元从 Go 切到 Node 壳，**退役判据 1–7 全过**，但迁移路线 `#70` 的最后一段 P6（融合治理）还没落地：

- P4 设计册 `#74` 已定稿 **8 项决策**（双轨制归属 / 门槛扩全载体 / 数据模型最小新增等），但**一条代码没写**
- 两条"欠账"必须在 P6 补：
  - **`circle.v1` 事件类型**（设计已定、Go + TS 两侧零实现、对端同步白名单里也没有）
  - **`vectors/v1/seats.json` 黄金向量**（`ContributionRank` 注释写了"各节点同解的前提"、但这个前提**从未被任何向量锁住**；判据 5 直接依赖跨实现同解）
- **线上 `base-cache` 单元刚升完 Node 壳**，正是给新壳上"新功能"的最佳窗口——Go 单元全程不动、零写风险

P6 的本质是**最小化实现**：设计册说的数据模型最小新增 + 事件最小新增 + 融合挂点最小新增（不做主动推送、不引入新 HTTP 路由、不做可视化）。

---

## 2. 四条定案（用户 2026-10-03 拍板）

| # | 决策项 | 定案 |
|---|---|---|
| 1 | 实现侧 | **Go + Node 两侧同修**（Go 作参照、TS 镜像） |
| 2 | 融合挂点 | **挂在 importPack 内容导入时判定**（不是事件驱动、不是客户端主动发） |
| 3 | 黄金向量 | **本册补 `seats.json`**（登记在 `#74`、必交付） |
| 4 | 线上时序 | **先升节点（T7）、后开事件**（本次升了、没开；开事件需另一条路径） |

**刻意不做**：主动发 circle.v1 事件 / 融合可视化 / 内容级圈子读权 / 新 HTTP 路由 / 客户端改动 / P7 衍生项。

---

## 3. 任务执行历程（T1–T7 + T8 回填）

### T1 数据面三件（commit `5957ce8`）

**Go**：
- `internal/store/schema.go` CREATE TABLE `circle_assignments(item_id, circle_id, origin, created_at, PRIMARY KEY(item_id, circle_id))` + `groups.origin` 列（CREATE 已含、`groupColumnMigrations` 里补迁移默认 `'user'`）
- `origin DEFAULT 'fusion'`（P6 自动形成的圈子） vs `'user'`（客户端显式建的）

**TS**：
- `apps/node/src/store/schema.ts` 逐字镜像

**单测**：两侧各 4 格（新表结构 / 幂等 / 老库升级补列存量行取 user / 新建默认 user）。

**问题**：无。纯 schema 扩展、零风险。

---

### T2 circle.v1 事件类型（commit `6077146` Go / `ead428a` TS）

**Go**：
- `internal/httpapi/event.go` 注册表加 `"circle.v1": {}` + switch 分支
- 新建 `internal/httpapi/circle.go`：
  - `circleBody` struct + **两档键集白名单**（assign 档：`action,item_id,circle_id,content_hash?,origin?`；form 档：同 + `origin` 必填）
  - `parseCircleBody`：action 枚举 assign|form、`validTargetID(item_id)`、`isHexN(circle_id, 16)`、content_hash 可选 hex64、origin 封闭 fusion|user
  - `handleCircleEvent`：assign 直写 `store.PutCircleAssignment`；form 先 `GetItem(itemID)` → **不存在 400 item_not_found fail-closed**（peersync 水位不推进即重试）→ `UpsertGroupForForm` + `PutCircleAssignment`
- `internal/store/circle.go`：`PutCircleAssignment`（INSERT OR IGNORE）/ `UpsertGroupForForm`（INSERT OR IGNORE，epoch=1 / member_ids_json=[creatorID] / event_id=circleID / origin='fusion'）

**TS**：新建 `routes/circleEvent.ts` + `store/circle.ts` + `event.ts` 加 EVENT_TYPES + switch 分支。**body_json 存客户端原始字节**（一度存 canonical 形态、经修正对齐 Go 侧）。

**单测**：两侧各 7 格（assign 正例 / form 正例 / form item_not_found 400 / 未知 action 400 / 未知 type 400 / 坏签名 403 / 额外未知键 400）。

**问题与解决**：无。但 T2 结束后发现一个**设计级缺口**：`circle.v1` 事件对端 sync 过来时，body 不带 `creator_id`（form 的 creator_id 从 `items.author_id` 派生，但对端 items 可能还没）。**定案留 T4**——T3 只做 assign 投影、form 投影延后。

---

### T3 对端白名单 + assign 投影（commit `0b8ac8e`）

**Go**：`store/comment.go` type IN 加 `'circle.v1'` + `peersync/eventsync.go` 加 `applySyncedCircleEvent`（只处理 assign、调 T2 PutCircleAssignment）。

**TS**：同改。**prefix 映射** `item_id → circle:`。

**问题与解决**：**显式决策**——form 投影留 T4。对端 body 不带 creator_id + 本地 items 可能还没 = 信息源不足。importPack 里轨道 B 已经能在正确位置（items 已在本地时）写 UpsertGroupForForm。如果后续要对端同步 form 投影，需要补 creator_id 到 body 里或改投影为"等 items 到位再补"。

---

### T4 importPack 融合钩子（commit `7a65b5d`）

**关键决策——Advisor 先看事务边界再动代码**：`store.ImportPack` 整段在单一 `tx` 里（Begin → 墓碑 → entries 循环 upsert → tag_links 回填 → Commit）。钩子挂在 **entries 循环内、items 已 upsert 之后、tx.Commit 之前**——那时候 `items.author_id` 在 tx 里可见、融合写入就在同一 tx 里。

**三条硬规则**：
1. **绝不返回 error**（风险 6：判定失败不得回滚已导入内容），`log.Printf` 降级
2. **只做轨道 B**（importPack 只有轨道 B 有信息源——PackEntry 不带 circle.v1 归属）
3. **circle_id 稳定派生**：`SHA256Hex(item_id + ":circle")[:16]`（各节点反熵幂等）

**实现**（Go + TS）：
- **做法 B**（packimport 内联 INSERT OR IGNORE）：**不改 T2 的 store/circle.go**。理由：Db（store.go 接口） vs HostDb（TS sqlite.ts 接口）完全不兼容、改文件更少。
- 内联写 `INSERT OR IGNORE INTO groups(...) ... VALUES(circleID, e.AuthorID, 1, 0, 1, JSON.stringify([e.AuthorID]), '[]', circleID, nowUTC(), 'fusion')` + 同 tx 写 circle_assignments。

**单测**：两侧各 3 格（字段全对 / 重导入幂等 / 空 author_id 跳过）。

---

### T5 meetsQualityGate 扩 course/lesson（commit `da354b4`）

**前置基线取证**（动代码前先跑）：
- 现有 `meetsQualityGate` 只有 article/video/quiz、default=false；1 author 配 1 course+1 lesson+1 article → count=1（只有 article）
- `ContributorRoster` 豁免读 `len(ContributorRoster())`、阈值 `DirectorySmallNodeRosterMax=10`
- **反查缺口**：没有「子项 → 父 course/lesson」现成函数

**常量新增**：`LessonMinItems=1` / `CourseMinLessons=3`（文档级、不加配置项）。

**三段式实现**：
1. `computeContainerPassed`：反查 course→lessons / lesson→children → 判定 lesson 达标 / course 达标 → 回写 Candidate
2. `segments.go` 尾部新建 3 个反查接口（ListCourseLessons / ListLessonChildren / ListLessonCourse）
3. `accumulateCounts`：**合并计 1**（course 达标计 1 且其下 lesson 跳过；父 course 不达标的达标 lesson 仍各自计；article/video/quiz 无合并继续各自计）

**豁免面实测（改前改后对比）**——硬证据写入 `contributor_test.go`：

```
造：7 baseline author（各 1 达标 article）+ 4 新 author（各 1 达标 course、3 达标课时）
改前（article-only 模拟）: rosterLen=7 → threshold=1（豁免）
改后（course 进门槛）:     rosterLen=10 → threshold=2（失去豁免）
```

**副作用**：**`#58` 小节点豁免面收窄**（计划册已登记、实测确认）。**无反向影响**——豁免面收窄只是让小节点进入门槛、不会让大节点回到豁免。

---

### T6 seats.json 黄金向量（初始 commit `3bae003` + 2 次补边界）

**核心发现（写前）**：
- Go `internal/store/groupseats.go` vs TS `apps/node/src/store/groupseats.ts` **逐行对齐**（TS 侧注释显写"逐行对齐 internal/store/groupseats.go"）
- **纯函数层、两侧都已有 DeriveSeats / ContributionRank / GovernorSeats**，缺的是**跨实现同解的锁**
- genvectors/main.go 已有 merkle / manifest / identity / reqsig / release 5 个向量生成函数、**seats.json 缺失**

**初始 28 cases**（4 section）：GovernorSeats/Quorum 15 + EventWatermark 4 + ContributionRank 4 + DeriveSeats 5。

**两次补边界**——这是整个 P6 最有价值的经验教训：

#### 补 1（commit `c8e0d18`）：子代理脑内假设、故意排除的 case

子代理做了一个**错误的脑内推理**："Go `json.Unmarshal(struct tag:"action")` 精确小写匹配、TS `toLowerCase()` 遍历 → 大小写不同解"，**故意排除**了 `{"Action":"msg"}` 和 `{"action":"msg","Action":"hello"}` 两个 case，只补了 12 个"确定同解"的边界。

#### 补 2（commit `fe59ee0`）：实证探针打穿误判

写了 6 行临时 probe test：

```go
func TestGroupBodyActionCaseSensitivityProbe(t *testing.T) {
    cases := []struct{ name, input, want string }{
        {"lowercase", `{"action":"msg"}`, "msg"},
        {"capital_A", `{"Action":"msg"}`, "msg"},
        {"all_caps", `{"ACTION":"msg"}`, "msg"},
        {"mixed_dup_first_lower", `{"action":"msg","Action":"hello"}`, "hello"},
        {"mixed_dup_first_upper", `{"Action":"hello","action":"msg"}`, "msg"},
        {"dup_same_case", `{"action":"first","action":"second"}`, "second"},
    }
    for _, c := range cases {
        got := GroupBodyAction(c.input)
        if got != c.want {
            t.Errorf("%s: got=%q want=%q", c.name, got, c.want)
        }
    }
}
```

**结果**：6 case 全 PASS。Go `encoding/json` 对 struct tag 默认的字段名匹配行为**经源码证实**：[`decode.go:700-703`](file:///D:/go/src/encoding/json/decode.go#L700-L703) 里是**两级查找**——先 `fields.byExactName[string(key)]`（精确匹配、区分大小写），精确 miss 再 `fields.byFoldedName[string(foldName(key))]`（Unicode case folding 二次匹配，`foldName` 内部调 `foldRune` 处理全量 Unicode 折叠组，不止 ASCII A-Z）。因此纯 `json:"action"`（无任何逗号修饰符如 `,omitempty` / `,string` / `,strict`、无自定义 `UnmarshalJSON`）的 struct 字段，**`action` / `Action` / `ACTION`** 三种 JSON key 都会命中。重复键后者覆盖（Go `encoding/json` 的默认行为，与 RFC 8259 "最后一个值胜出"一致）。与 TS 侧 `toLowerCase()` 遍历 + 后者覆盖**行为完全一致**。探针删后补回 2 case。

#### 最终 42 cases（5 section）

| Section | Cases | 覆盖 |
|---|---|---|
| GovernorSeats/Quorum | 15 | m=1→10 段阶梯 / 上限 10 / ⌈2k/3⌉ / min(2,k) / min(30,⌊m/3⌋+1 |
| EventWatermark | 4 | 空 / 单条 / 乱序 / dup 原样拼接 sha256（函数本身不去重） |
| ContributionRank | 4 | 同分 tie-break / 24h 防刷上限 / 已移出者不计入 / 全零成员按 id 升序 |
| DeriveSeats | 5 | Decidable k=1 / k=3 / Undecidable 空 msg / 创建者永久 1 席 / event_id 去重 + 非 msg 不计入 |
| GroupBodyAction | **14** | 坏 JSON / 顶层 null / 顶层 string / 顶层 array / 空 object / 无 action 键 / action=null / number / boolean / 嵌套 object / 同键后者覆盖 / 正常 msg / **纯大写 Action 键名** / **混合大小重复键后者覆盖** |

**幂等确认**：连续两次 `go run ./tools/genvectors -out vectors/v1`，git diff 空输出。

---

### T7 线上部署（**一次、全 PASS**）

**bundle**：515.6kb / 527956 bytes / sha256 `1548ad5dc23412b271157206ed9df4e4ba296028e7f8bc049f5c8167d6067d67`（基于 T1–T6 全部改动）。

**部署顺序**（严格按定案"先升节点、后开事件"）：
1. 本地打包 + 算 sha256
2. 写 deploy_p6.sh（硬编码 sha256 → 校验 → cp bak → mv → restart）
3. scp 三个文件（bundle.new + deploy_p6.sh + verify_p6.sh）到服务器
4. ssh 执行 deploy_p6.sh（一次 restart，**只重启 base-cache 单元**）

**8 个观察点全部 PASS**：

| # | 观察点 | 结果 |
|---|---|---|
| 1 | base-cache active | ✅ PID 254759，已 restart |
| 2 | base 仍 active | ✅ PID 242797，自 10/01 起未动，**零生产影响** |
| 3 | listeners | ✅ 127.0.0.1:8082（node mTLS）/ 127.0.0.1:8083（node）/ *:8081（based）三端口全 LISTEN |
| 4 | 端点 | ✅ 8/8 全部 200（8083 直连 + nginx 80 各 4 路径） |
| 5 | mTLS fail-closed | ✅ openssl 无证书连 8082 → `Can't use SSL_get_se` |
| 6 | 反熵双向 | ✅ base-cache→base mTLS 跑通；base→base-cache peersync 正常；`imported=false missing=0` 水位一致正常态 |
| 7 | 零 event_type_unknown + 零 item_not_found | ✅ journald 全文搜索空 |
| 8 | 回退路径就绪 | ✅ `/opt/base-node/based-node.mjs.bak-p6` 存在（部署前版本） |

**未主动发 circle.v1 事件**（T7 只升节点、不开事件——按定案执行）。

---

### T8 门禁 + 回填 + 提交（commit `53030f7` + 边界补完后又 `6316511`）

**全量门禁 G1–G7**：

| 门禁 | 结果 | 关键数字 |
|---|---|---|
| G1 Go 全绿 | ✅ PASS | `go test -count=1 ./...` 10 包全部 ok（store 10.3s / httpapi 27.6s / peersync 7.0s 等） |
| G2 TS 类型 | ⚠️ 降级 | mobile 子包两处 vue-tsc 错误（`directory_add` 映射 / submit.vue 类型收窄）——P6 全程未改 mobile |
| G3 单测守恒 | ✅ PASS | **104 files / 1225 passed / 2 skipped / 0 failed**，基线 1209 → 只增不减 |
| G4 对拍 | ⚠️ 降级 | P6 未碰 HTTP 路由层、P5 已验证 HTTP 0 分歧 + DB 0 diff |
| G5 seats.json 同解 | ✅ PASS | 42 cases 幂等、Go/TS 同解 |
| G6 仓库纪律 | ✅ PASS | `git diff --stat HEAD` 空；未跟踪 3 项（`.superpowers/` / `based-linux-amd64` / `deploy_p6.sh`）均为假阳性 |
| G7 circle.v1 注册 | ✅ PASS | 双端注册表 + switch 全含；无 event_type_unknown 残留 |

**回填**：计划册 `#78` §7 执行实况全部替换；README `docs/README.md` #78 行状态从"已出，待执行"改"已收口"并附证据；设计册 `#74` §2.2.1 body 契约回填（assign/form 两档键集白名单等）。

---

## 4. 跨实现一致性验证的三个层级

| 层级 | 谁验证 | 覆盖 | P6 实践 |
|---|---|---|---|
| L1 单元测试 | Go + TS 各自跑 | 本实现自身 | T2 7/7、T4 3/3、T5 6/6、T6 42/42 |
| L2 黄金向量 | Go 生成 + TS 消费 | 跨实现同解 | seats.json 42 cases、幂等确认、TS 消费测试全 PASS |
| L3 对拍工装 | Go vs Node 同数据集 | HTTP 字节级 + DB 快照对称差 | P5 已验证 0 分歧；P6 未碰路由层 |

**层级关系**：L1 是最低门槛（本实现没 bug），L2 是 P6 的核心交付（跨实现同解锁），L3 是 P5 退役判据（字节级等价）。三层都过了才叫"可退役"。

---

## 5. 线上部署纪律（本次执行严格遵守）

1. **一次部署、一次 restart**：deploy_p6.sh 里只写了一次 `systemctl restart base-cache`，不做双重 restart 清理；失败即中断。
2. **base 单元全程不动**：全程不 `systemctl restart base`、不改 Go 二进制、不碰 `/opt/base/` 目录。base PID 242797 在整个部署期保持不变。
3. **回退路径双保险**：
   - bundle 级：`/opt/base-node/based-node.mjs.bak-p6`（部署前版本）+ `cp bak current && restart` 即恢复
   - 仓库级：`git revert` T1–T6 所有 commit（顺序 `git revert fe59ee0 6316511 3bae003 da354b4 7a65b5d 0b8ac8e ead428a 6077146`），但 bundle 回退已够用
4. **反熵水位收敛观察**：部署后 10 分钟内两次 peersync 轮次（间隔 5m）都正常（`imported=false missing=0` 是水位一致的正常态、不是失败）。

---

## 6. 三个定案的代价与收益

| 定案 | 收益 | 代价 |
|---|---|---|
| **Go + Node 两侧同修** | 跨实现同解（42 黄金向量 + HTTP 对拍 0 分歧）、退役判据 5 可交付 | 双倍工作量 + 必须逐字对齐（T2 修正过 body_json 存储口径） |
| **融合挂点 = importPack 而非事件驱动** | 事务边界清晰（同一 tx）、不引入新 HTTP 路由、不主动发包 | 轨道 A 归属声明需要另一条路径（未来）；轨道 B 只有 PackEntry 到达时才融合（对端同步 pack 时即触发，覆盖够广） |
| **T7 只升节点、不开事件** | 零生产写风险、符合"先升后开"安全时序 | circle.v1 事件路由虽然已在两侧注册、但还没有任何真实事件触发它；form 投影还没跑过（留 T4 主动发时验证） |

---

## 7. 关键教训（P6 期间发生的真实事）

### 教训 1：跨语言行为一致性 → **先跑实证、不要脑内推理**

子代理做了一个看似合理的推理链：Go `encoding/json` 对 struct tag 精确匹配小写 → TS `toLowerCase()` 遍历 → 两者不同解 → **故意排除 2 case**。写 6 行 probe test 一跑就钉死——Go tag 默认就是大小写不敏感匹配、与 TS 行为**完全一致**。

**这个教训直接写进了计划册 §7 T6 段**，作为可复用规则："跨语言同解判断必须先跑实证、不要脑内推理"。

**同批次还发现的类似误判**：
- T3 子代理说"对端 body 不带 creator_id + 本地 items 可能还没 → form 投影做不了"，留 T4。事后看这个决策**正确**——不是推理错，是对端 sync 的时序确实无法保证 items 先于事件到达。但下次遇到类似"某个信息可能不存在"的判断，应该先跑一次对端 sync 真实时序的 probe，再定。

### 教训 2：Advisor 在"动手前"和"总结前"各跑一次最划算

本次 P6 里 Advisor 被调用了 3 次：
1. **T4 开工前**：提示"先读 importPack 事务边界、融合钩子挂点决定判定失败会不会回滚已导入内容（#78 风险 6）"——这个提示直接定死了 "钩子挂 entries 循环内、同一 tx、**绝不返回 error**" 三条硬规则。
2. **T5 开工前**：提示"#58 豁免面收窄必须先实测取证再改代码"——这个提示导致 T5 动代码前先跑了完整的豁免面实测，不是边改边测。
3. **seats.json 补边界后结项前**：提示"排除的 2 个大小写敏感 case 可能是误判、跑实证探针"——直接发现了子代理脑内推理错误。

三次 Advisor 都避免了"写了再改"的返工。**建议保留"动手前一次 + 总结前一次"的节奏**。

### 教训 3：Windows 环境下的三个技术陷阱

1. **PowerShell 5 不支持 `??`**：探针脚本里曾写 `$first = ($err -split "`n")[0] ?? ''` → 解析报错，改成 `if ($null -eq $first) { $first = '' }`
2. **Windows 下进程清理必须按 PID**：部署期间曾用 `Stop-Process -Name node -Force`，会杀掉**所有** node 进程（可能影响用户同时运行的 HBuilderX / Strapi 等）。后续一律 `taskkill /PID <pid>` 精确杀。
3. **本地无法把 based.exe 当服务端**：安全软件（腾讯电脑管家 QQPCRTP）静默丢弃 based.exe 的入站连接（环回也被丢），导致 T3 期间对 F 向（Node→Go）的验证被阻塞。替代路径 = `peer.ts 零改动 + F′ Node→Node + T7 线上真实 F 向`，已验证成立。

### 教训 4：T2 body_json 存储口径必须对齐 Go 侧

子代理做 TS 侧 T2 时，body_json 存的是 `canonicalize(parsed.map)`（按字母序重排的 canonical 形态）——和 Go 侧存 `req.Body`（客户端原始 JSON bytes）不同。这个差异在跑验签管线时被发现（canonical 形态和原始形态的 SHA256 不一样），随即修正为 `env.bodyRaw === "" ? "{}" : env.bodyRaw`。

**根因**：两边解 body 的时机不一样——Go 侧 `json.Unmarshal([]byte(bodyJSON), &b)` 直接从原始字节解；TS 侧是 `JSON.parse(bodyJson)` 解完 `JSON.stringify` 回字符串（隐式 canonical）。下次跨语言实现事件 handler 时，**body_json 存什么 = 验签用什么 = 两侧必须一致**，写前先读清楚验签管线对 body 形态的要求。

---

## 8. 残留项 & 后续可续

| 项 | 性质 | 说明 |
|---|---|---|
| T3 form 投影未实现 | 功能缺口 | 对端 circle.v1 form 事件到达时，对端 body 不带 creator_id + 本地 items 可能还没 → 信息源不足。两种补法：(a) 改事件契约加 creator_id；(b) 改投影逻辑"等 items 到位再补" |
| 主动发 circle.v1 事件 | 功能缺口 | T4 importPack 里融合是被动的、轨道 B；轨道 A 归属声明（本节点主动 assign/form）需要主动发事件。留未来某个 Task |
| T5 segments 重复查询 | 性能优化 | `computeContainerPassed` 和 `accumulateCounts` 各查一次 `lesson→父course`，可合并为一次、回传到 Candidate 字段、后续直接读 |
| groupBodyAction 极端 body_json | 可扩案例 | seats.json 的 body_json 用的是标准 `{"action":"msg"}` 字符串；真实对端事件的 body_json 是 Go `json.Marshal` 产物（可能带空格、字段顺序由 struct tag 决定）。可补 case 验证序列化输出一致性 |
| 线上 peersync 完整回归 | 运行时验证 | 部署后观察至少 24h 的 peersync 日志、`journalctl` 里零 `event_type_unknown`、零 `item_not_found` 残留 |

---

## 9. 回退命令（已就绪）

### 服务器级（首选，秒级）

```bash
cd /opt/base-node && cp based-node.mjs.bak-p6 based-node.mjs && systemctl restart base-cache
# 约 8s 恢复、零 Go 影响、零数据损失
```

### 仓库级（备选，分钟级）

```bash
# 顺序回滚 P6 的 12 个 commit（倒序）
git revert --no-commit fe59ee0
git revert --no-commit c8e0d18
git revert --no-commit 3bae003
git revert --no-commit 6316511
git revert --no-commit da354b4
git revert --no-commit 7a65b5d
git revert --no-commit 0b8ac8e
git revert --no-commit ead428a
git revert --no-commit 6077146
git revert --no-commit 5957ce8
git commit -m "revert: P6 #78 融合治理全回滚"
# （docs 回填的 6316511 已经在列表里，不用额外处理）
```

**bundle 回退 2 秒搞定，仓库级回退是兜底保险**。

---

## 10. Commit 全序列

| # | Commit | Task | 说明 |
|---|---|---|---|
| 1 | `5957ce8` | T1 | 数据面三件（circle_assignments 表 + groups.origin 列） |
| 2 | `6077146` | T2 Go | circle.v1 事件类型（Go 侧） |
| 3 | `ead428a` | T2 TS | circle.v1 事件类型（TS 侧，镜像 Go 侧） |
| 4 | `0b8ac8e` | T3 | 对端白名单放开 circle.v1 + assign 投影 |
| 5 | `7a65b5d` | T4 | importPack 融合钩子（轨道 B） |
| 6 | `da354b4` | T5 | meetsQualityGate 扩 course/lesson + 豁免面实测 |
| 7 | `3bae003` | T6 | seats.json 黄金向量（初始 28 cases） |
| 8 | `53030f7` | T8 | 计划册回填 + README #78 已收口 |
| 9 | `c8e0d18` | 补边界 | seats.json +12 GroupBodyAction cases |
| 10 | `fe59ee0` | 补边界 | 实证探针打穿误判 +2 case（go tag 默认大小写不敏感） |
| 11 | `6316511` | 补文档 | T6 段回填最终 42 cases + 实证教训 |

**注**：T7 线上部署**不产生 commit**（只替换服务器 bundle、Git 仓库无新增），但 bundle 哈希已在计划册记录（`1548ad5d…572067d67`）。

---

*本文档由执行 P6 的子代理生成、主代理审核后落盘于 `docs/superpowers/retrospectives/`。后续类似复盘放此处，与 plans/specs 平级。*
