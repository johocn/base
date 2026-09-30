# base 0.15.0 交付验收手册

- 日期：2026-09-30
- 交付版本：**App `0.15.0` / versionCode `20`**（独立发布）
- 交付内容：**#40 课程与课时字段模型 + 双端编辑**（节点侧 `segments` 的 `seq<0` 属性槽位与确定性分配 · **新增 `POST /v1/blob`** · `POST /v1/submit` 解锁 `course|lesson` 两个容器形态 · 三处重建路径保留 `seq<0` · 导入器遇投稿域容器跳过 + warning；手机端 `core/attrs.ts` / `core/container-view.ts` / `core/blob.ts` / `course-edit.ts` / `submit.ts` 扩容器 · 台账扩 `segments_json` · 课程编辑页 / 课时编辑页 / **课时页（方案 A）** · 课程页改纯课时清单）
- 上游：册子 `specs/2026-09-30-base-course-lesson-edit-design.md`（#40）、实施计划 `plans/2026-09-30-base-course-lesson-edit-plan.md`（#41，Task 1–15 已执行）
- 本手册覆盖四组：**A 课程与课时编辑（11 条）** · **B 全站回归（12 条）** · **C 节点侧接口验证（4 段）** · **D 自动化门禁（可复跑）**

> 本手册只写「怎么做、看什么、判什么」，不含设计契约与实现细节（契约以册子 #40 为准）。
> 与 0.14.0 手册（`docs/2026-09-30-base-acceptance-manual.md`）的关系：**B 组沿用其全站回归骨架**，A / C 组整体替换为本次交付面。
> 需要**逐条填写签字**的用例表形态见 `docs/2026-09-30-base-acceptance-cases-0.15.0.md`（#43）；两文覆盖同一批验收点，本手册是跑法、用例表是记录载体。

## 0. 本次发布产物

| 项 | 值 |
|---|---|
| App 版本 | `0.15.0`（versionCode `20`） |
| APK 下载 | <http://118.190.217.242/dl/base-0.15.0.apk> ｜ 落地页 <http://118.190.217.242/> |
| APK 字节数 / sha256 | `27431470` / `7f18ed1c089e464f3ce6dd71db9f17cc2a4625408199b019ebeda194b1710bc7` |
| 签名证书 SHA1 | `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`（与 0.6.0–0.14.0 一致 ⇒ 可覆盖安装） |
| 节点二进制 | `/opt/base/based` = `7c2fb7abea19c19f159b95cee87287595d6828cd41445b0dd48f8f5627278596`（`21771765` 字节） |
| release 文档 | `/opt/base-cache/data/release.json`，`version_name=0.15.0` / `min_version_name=0.8.0` / `issued_at=2026-09-30T11:38:15Z` / `issuer=base-node-1` |
| 服务 | `base`（`:8081`，与 `base-cache` 共用二进制）· `base-cache`（`127.0.0.1:8082`） |

> **本次节点二进制必须换**：新增了 `POST /v1/blob` 路由，旧二进制下该路径为 `404`。

## 1. 测试前置

| # | 步骤 | 预期 |
|---|---|---|
| 1.1 | 安装 APK（已装 0.14.0 可直接覆盖） | 安装成功，不提示签名冲突 |
| 1.2 | 首次启动 → **我的 → 设置**：确认节点地址为 `http://118.190.217.242`、公钥已预置 → 点一次**保存** | 提示保存成功 |
| 1.3 | 同页点**基座自检** → 跑完 | 随机源 / `plus.io 文件接口` / `plus.sqlite` 三项均为「有」；**「升级文档拉取并验签」为「有」**（即 `verifyRelease` 实测通过） |
| 1.4 | 进**课程** tab 点同步 | 课程列表出现内容 |
| 1.5 | **我的 → 我的条目** 看是否为空 | 空 ⇒ 本机未建过任何条目，可完整跑 A 组；非空 ⇒ A1 / A7 用**新建**的课程（不要去改导入器域的课程，见 A6） |

> **A 组的关键前提**：本册的**编辑入口只在「本人建的容器」上出现**（A6 会验）。导入器域（随内容包进来的）课程 / 课时**全程只读**，其改动归 #27 提案线，不在本册。

## 2. A 组：课程与课时编辑（11 条）

### A1 新建课程（AC 10）

1. **课程** tab → 右上角**新建课程**。
2. 填：标题（如 `验收课程`）、简介、讲师、难度选「基础」、时长填 `45`（分钟）、上传一张**封面**（任意 < 8 MiB 图片）。
3. 点保存。

**预期**：Toast 提交成功并返回；**课程** tab 出现该课程；进课程详情，页顶显示封面 / 简介 / 讲师 / 难度 / 时长，**时长按「约 45 分钟」量级展示**（分钟 → 秒换算正确，不是 45 秒）。

### A2 课时清单：增删与排序、「第 N 讲」（AC 10）

1. 回到 A1 的课程编辑页，在**课时清单**区连续新增三节课时，标题依次为 `第一节` `第二节` `第三节`。
2. 用**上移**把第三节移到第一位，保存。
3. 进课程详情看课时清单。

**预期**：
- 清单顺序为 `第三节 / 第一节 / 第二节`，且分别标 **第 1 讲 / 第 2 讲 / 第 3 讲**；
- 序号按**位次**重算（不是按创建时间），与清单顺序严格一致；
- 删掉中间一讲后保存，剩余两讲的序号**重排为第 1 讲 / 第 2 讲**（不留空号）。

### A3 课时编辑：正文 + 附件 + 载体清单（AC 10）

1. 从 A2 的课程编辑页点进**任一课时的编辑页**（或在课程详情点该课时进课时页后走编辑入口）。
2. 填正文 Markdown（用**两段及以上**，段间空行，例如：
   ```
   # 验收正文

   第一段文字。

   第二段文字。
   ```
3. 上传**一个附件**（任意 < 8 MiB 文件，如 `.pdf` / `.txt`）。
4. 在**载体清单**加一条：kind 选 `article`，item_id 填一个**本机已存在**的文章 id（可从「课程 → 独立内容 → 文章」页拿，形如 `article/xxx`）。
5. 保存。

**预期**：保存成功；该课时在课程页的徽标从「空课时」变为含 **`文章 1`**、**`附件 1`**、**`约 N 分钟`** 的徽标（若填了时长）。

### A4 课程页改版判读（AC 8）

1. 从**课程** tab 进 A1 的课程详情，**完整看一遍整页**。

**预期**：
- 页顶为**课程级字段**：封面 / 简介 / 讲师 / 难度 / 时长 / 附件 / 标签 chips；
- 其下是**纵向直滚的课时清单**，每行 `第 N 讲 · 标题`；
- **不存在**展开/收起的三角箭头——点课时行**不展开手风琴**，而是**跳课时页**；
- **不存在**底部「本课程测验（N 组）」汇总块；
- 课时多时**不分页、不分章**（一直滚到底即可，不出现「加载更多」）。

### A5 课时页（方案 A，新增页）（AC 7 / AC 10）

1. 点进 A3 编辑过的那节课时。

**预期**（四段齐备）：
- **标题**含「第 N 讲」；
- **正文**按段落渲染 A3 填的内容（`#` 标题行不显示井号）；正文里**没有**出现 Markdown 源码残留（如裸露的 `#`）；
- **载体清单**显示 A3 加的那条 `article`，点它可以打开文章页；
- **附件**显示 A3 上传的文件名，点它可打开（首次会落盘后调系统打开）；
- **标签 chips**（如该课时尚无标签则为空，不报错）。

### A6 编辑入口只在本人建的容器上出现（AC 7 / §6）

1. 在 A5 的课时页看**编辑入口**（页面上的「编辑」按钮）。
2. 回到**课程** tab，进一个**随内容包同步下来的**课程（非 A1 新建的）→ 再看它的课时页。

**预期**：
- A1 自建课程与其课时**有**编辑入口，能进编辑页并正确回填（标题 / 简介 / 讲师 / 正文 / 附件 / 清单都在）；
- 导入器域的课程 **看不到**编辑入口（本机台账里没有它的投稿记录 ⇒ 判定为只读）；即使从别处强开编辑页，提交时应被节点拒绝（占用口径），**不得**出现半生效。

### A7 断网保存 → 联网仅补发一条（AC 10）

1. 开**飞行模式**。
2. 进 A1 课程的**课时编辑页**，改一处可见内容（如把正文加到三段），保存。
3. 进 **我的 → 我的条目**，看「待发」区。
4. 关飞行模式，等待或手动触发补发（回到「我的条目」页会触发补发编排）。

**预期**：
- 断网保存**不报死错**，条目落入「待发」区，本机台账有该行；
- 恢复网络后**自动补发仅一条**，「已发」区出现该课时，**不重复**、无第二条同名条目；
- 补发后的载荷与在线直发**一致**（同 `item_id` 不产生第二个条目），课时页看到的是新内容。

### A8 空课时 / 悬空引用占位不错位（AC 8）

1. 建一个**只有课时清单、不填正文与载体**的课时（空课时）。
2. 在它**后面**再加一节正常课时。
3. 进课程详情看清单。

**预期**：
- 空课时**不被隐藏**，该行标「**空课时**」，且**照占位次**——后面那节的序号是「第 2 讲」（**不是**第 1 讲）；
- 若清单里存在指向**本地不存在**的课时（例如另一台设备建过、本机未同步到），该行仍占位、标题退化为 `item_id`，**序号不错位**（本机不易造，可跳过并记 BLOCKED）。

### A9 封面与附件的上传行为（AC 3 的客户端侧）

1. 回 A1 课程编辑页，把**封面**换成**同一张图**再保存一次。
2. 再上传一张**超过 8 MiB** 的图片当封面。

**预期**：
- 同图重传**成功**且封面不变（内容寻址幂等：同字节得到同一个 `blob_id`，块只落一份）；页面不报错；
- 超 8 MiB 在**上传前**被客户端拦下并给出「文件超过 8 MiB」类提示；**不得**卡住、不得白屏；若绕过客户端提交，节点回 `413 blob_too_large`（C 组验）。

### A10 内容包导入不覆盖自建课程（§4.3 / AC 5）

> 需部署机 + 一次导入动作，可由工程侧代跑；也可判 BLOCKED 转 C3。

1. 在部署机上对同一份 md 源**再跑一次导入**。
2. 观察导入输出与 A1 课程详情。

**预期**：
- 输出里出现形如 `skipped: course/<cid> 投稿域，导入器不覆盖` 的 **warning**（不是 error、不阻断整批导入）；
- A1 课程的**封面 / 讲师 / 难度 / 时长 / 课时清单全部不变**（导入器没有覆盖投稿域容器）。

### A11 导出到第二节点后顺序与内容一致（AC 10 后半，需第二节点）

1. 在节点 A 导出一个包，在节点 B 导入。
2. 手机端把节点地址切到 B，同步 → 重跑 A2 / A5 的观察项。

**预期**：B 上看到的课时**顺序、序号、正文、载体、附件**与 A 完全一致；`segments` 里 `seq<0` 的属性行原样到达。

## 3. B 组：全站回归

> 目的：确认本次**换二进制 + 重编客户端**未回归既有功能。每项只跑一次主路径。
> **注意 B1 / B2 已随本册改版**（课程页不再有手风琴）。

| # | 范围 | 操作 | 预期 |
|---|---|---|---|
| B1 | 升级通道 | **我的 → 设置 → 检查更新** | 不弹强更（本机已是 0.15.0，min 为 0.8.0）；无异常提示 |
| B2 | 课程浏览（改版后） | 课程 tab → 分类分组 → 课程 → **课时页** → 载体 | 分类可筛；「未归类」分组存在；课时行**点进去直接是课时页**；文章 / 答题可打开 |
| B3 | 搜索 | 课程 tab 的搜索入口 → 输入关键词 | 返回结果，点进可打开 |
| B4 | 文章与收藏 | 打开一篇文章 → 收藏 → **我的 → 我的收藏** | 该文章出现在收藏列表 |
| B5 | 答题三入口 | 从课程页 / 课时页 / 文章页三个入口各进一次「答题」 | 三入口均可进；题目可作答，提交后有结果 |
| B6 | 评论发表 | 评论 tab → 选内容 → 输入 → 发表 | 发表成功并出现在列表；换设备可见同一条 |
| B7 | 评论离线队列 | 开飞行模式发表一条评论 → **我的条目**看「待发」→ 关飞行模式 | 断网不丢，恢复后补发**仅一条** |
| B8 | 圈子建组 / 入组 / 发言 | 圈子 tab → 新建小组 → 复制邀请码；另一台设备加入小组；进会话页发言 | 双方看到同一条发言（内容对节点是密文） |
| B9 | 圈子形态与治者面板 | 建一个**封闭圈**与一个**开放圈**各一个 → 进小组会话页看治者面板 | 封闭圈需邀请码；开放圈可自助加入；治者面板显示席位 |
| B10 | 私信 | **我的 → 好友与私信** → 复制好友码 → 另一台粘码加好友 → 会话页发言 | 双方互通（全离线可用，内容对节点是密文） |
| B11 | 投稿编辑器（既有载体） | **我的 → 新建投稿** → 投一条 article 与一条 quiz | 有网直发成功；断网则入「待发」并可在恢复后补发 |
| B12 | 治理 + 标签兜底 | 浏览器打开 <http://118.190.217.242/governance>；App 内进**全部标签**与一个已打标课程 | 看板可打开无报错；标签列表可浏览，已打标课程仍显示其标签（0.14.0 面未回归） |

## 4. C 组：节点侧接口验证

> 全部为**只读或幂等探活**，不写业务数据。在部署机（能 `ssh me`）上执行。
> 端口以 `systemctl cat base` 的 `ExecStart` 实测为准（先例为 `127.0.0.1:8081`）。

### C1 只读探活脚本

```sh
cat > /tmp/verify15.sh <<'EOF'
#!/bin/sh
DB=/opt/base/data/base.db
echo "== release doc =="
curl -s http://118.190.217.242/v1/release; echo
echo "== apk head =="
curl -s -I http://118.190.217.242/dl/base-0.15.0.apk | grep -iE 'HTTP/|content-length'
echo "== landing page residual 0.14.x (expect 0) =="
grep -c '0\.14\.[0-9]' /opt/appdl/index.html || echo "0 hits"
grep -o 'base-0\.15\.0\.apk' /opt/appdl/index.html | head -1
echo "== blob route (expect 400, NOT 404/500) =="
curl -s -o /dev/null -w 'blob_post=%{http_code}\n' -X POST http://127.0.0.1:8081/v1/blob
curl -s -o /dev/null -w 'blob_get_ctl=%{http_code}\n' http://127.0.0.1:8081/v1/blob
curl -s -o /dev/null -w 'blob_404_ctl=%{http_code}\n' http://127.0.0.1:8081/v1/blobzzz
echo "== submit route (expect 400, NOT 404/500) =="
curl -s -o /dev/null -w 'course=%{http_code}\n' -X POST http://127.0.0.1:8081/v1/submit \
  -H 'Content-Type: application/json' \
  -d '{"type":"course","item_id":"course/x","title":"x","segments":[],"author_sig":"00"}'
curl -s -o /dev/null -w 'article=%{http_code}\n' -X POST http://127.0.0.1:8081/v1/submit \
  -H 'Content-Type: application/json' \
  -d '{"type":"article","item_id":"article/x","title":"x","body_md":"y","author_sig":"00"}'
echo "== existing routes (no regression) =="
curl -s -o /dev/null -w 'comment=%{http_code}\n' http://127.0.0.1:8081/v1/comment
curl -s -o /dev/null -w 'proposal=%{http_code}\n' http://127.0.0.1:8081/v1/proposal
echo "== services =="
systemctl is-active base base-cache
sha256sum /opt/base/based
EOF
sh /tmp/verify15.sh
```

**逐行判读**：

| 探针 | 预期 |
|---|---|
| `release doc` | `version_name` = `0.15.0`、`apk_size` = `27431470`、`apk_sha256` = `7f18ed1c…0bc7`、`min_version_name` = `0.8.0` |
| `apk head` | `HTTP/1.1 200 OK` + `Content-Length: 27431470`（与本地一致） |
| 落地页残留 | `0` 命中；且命中 `base-0.15.0.apk`（**不得**出现 `0.14.x`） |
| `blob route` | `blob_post=400`（鉴权先于 multipart 解析，回 `auth_missing_header`）；对照 `blob_get_ctl=405`、`blob_404_ctl=404` ⇒ **证明新路由已上线**（不是 404） |
| `submit route` | `course=400`、`article=400`（既有鉴权拒绝）；**不得**是 `404`（路由缺失）或 `500`（handler panic） |
| `existing routes` | `comment=200`、`proposal=200` |
| `services` | 两个 `active`；`based` 的 sha256 = `7c2fb7ab…8596` |

> **本册新增路由的四条完整判据**（上传幂等 / 超限 413 / 无签名 401 / 读回字节一致）需**带签名头**才能测，**不在 curl 层验**——由 D 组的 `go test ./internal/httpapi -run Blob` 覆盖（AC 3）。

### C2 `segments` 三区间与 `seq<0` 抽查（有 A 组数据后执行）

```sh
sqlite3 /opt/base/data/base.db \
  "SELECT seq, kind, substr(text,1,40) FROM segments WHERE item_id='course/<cid>' ORDER BY seq;"
sqlite3 /opt/base/data/base.db \
  "SELECT seq, kind, substr(text,1,32) FROM segments WHERE item_id='course/<cid>/lesson/<lid>' ORDER BY seq;"
sqlite3 /opt/base/data/base.db \
  "SELECT item_id, seq, kind FROM segments WHERE kind LIKE 'attr.%' ORDER BY item_id, seq LIMIT 20;"
```

**逐行判读**：

| 探针 | 预期 |
|---|---|
| 课程行集 | `seq<0` **只有** `kind` 以 `attr.` 开头的行（封面 / 讲师 / 难度 / 时长 / 附件）；`seq=0` 至多一行 `digest`；`seq>=1` **只有** lesson 子项 |
| 课时行集 | 同上，且**多一行** `attr.body_md`；**`seq=0` 通常不存在**（新写路径不产课时简介行，§2.2） |
| 附件多行 | 同一课时的 `attr.attachment` 占**连续递减区间**（如 `-1,-2`），不断号、不跳号 |
| 三区间不混 | **没有**任何 `seq<0` 却 `kind` 不以 `attr.` 开头的行；也**没有**属性行落在 `seq>=1` |

### C3 导入器跳过 + warning（可选，需 md 源与一次导入）

```sh
# 前提：库中已有 A1 自建课程；对同一 md 源再跑一次导入
/opt/base/based import -dir <md 源目录> 2>&1 | grep -i 'skipped\|投稿域'
```

**预期**：出现 `skipped: course/<cid> 投稿域，导入器不覆盖` 形态的 **warning** 行；导入**未被阻断**（同批其它条目照常入库）；A1 课程的 `segments` 行集与导入前**逐字一致**。

### C4 二进制替换与回滚的安全姿势（回滚同理）

```sh
# 不要用 cp：多单元共用 /opt/base/based，cp 会报 Text file busy
mv -f /opt/base/based-0.15.0 /opt/base/based && chmod 0755 /opt/base/based
systemctl restart base && systemctl restart base-cache
sha256sum /opt/base/based
```

回滚：`mv -f /opt/base/based.bak-0.14.0 /opt/base/based && chmod 0755 /opt/base/based && systemctl restart base && systemctl restart base-cache`

> `mv` 后必须 `chmod 0755`：scp 落地的文件是 `0644`，缺执行位会让两个单元以 `203/EXEC` 起不来。

## 5. D 组：自动化门禁（可复跑）

> AC 1–9 的自动面。**本机**即可跑，不需部署机；全绿是本手册的可信前提。
>
> 一键复跑：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/acceptance-d.ps1`（逐条执行下表 D1–D7，末尾打印 PASS/FAIL 汇总，任一失败退出码 1）。

| # | 命令（cwd） | 对应 AC |
|---|---|---|
| D1 | `go build ./... ; go vet ./... ; go test ./...`（仓库根） | 1 / 2 / 3 / 4 / 5 / 6 |
| D2 | `go test ./internal/protocol -run Attr -v` | 1 / 2（契约向量：同一字段集两端一致） |
| D3 | `go test ./internal/httpapi -run Blob -v` | 3（上传幂等 / 超限 413 / 无签名 401 / 读回一致） |
| D4 | `go test ./internal/importer -run 'Preserve\|Submitted' -v` | 5 / 6（三处保留 `seq<0`、投稿域跳过） |
| D5 | `npx vitest run ; npx tsc --noEmit ; npm run build:h5`（`apps/mobile`） | 1（TS 侧共读同一向量） |
| D6 | `grep -nE '="[^"]*\.value\|{{[^}]*\.value' apps/mobile/src/pages/*/*.vue`（仓库根） | 发布前硬检查（**必须无输出**；#31 更正 14 的教训） |
| D7 | `git log --oneline -1`（仓库根） | 打包源码树须含 `8f969d3` 及其全部祖先 |

**基线**：D1 全包 ok；D5 为 **23 个测试文件 / 229 个用例全绿**；D6 无输出。

## 6. 结果记录

| 组 | 条目 | 结论（PASS / FAIL / BLOCKED） | 备注 |
|---|---|---|---|
| A | A1–A11 | | |
| B | B1–B12 | | |
| C | C1–C4 | | |
| D | D1–D7 | | |

**判定口径**：

- 任一 **FAIL** 必须附：设备型号 + 系统版本 + App 版本 + 复现步骤 + 截图/日志 + 是否可稳定复现；
- **BLOCKED** 必须写清卡在哪一步、缺什么前置（如「无第二节点」「无 md 源」）；
- A 组与 D 组**都必须跑**才可判交付；B 组可抽样但**不得整组跳过**。