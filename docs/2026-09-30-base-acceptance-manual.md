# base 0.14.0 交付验收手册

- 日期：2026-09-30
- 交付版本：**App `0.14.0` / versionCode `19`**（独立发布）
- 交付内容：**#37 统一标签体系**（节点侧 `tag_links` / `type=tag` 直打 / 治理人集合 / `edit` 提案扩 `tag` 载体 / 导入回填；手机端本地派生表 · `core/tags.ts` · 标签三页与四类内容页入口）
- 上游：实施计划 `plans/2026-09-30-base-tagging-plan.md`（#38，Task 1–12 已执行）
- 本手册覆盖三组：**A 标签体系（7 条）** · **B 全站回归** · **C 节点侧接口验证**

> 本手册只写「怎么做、看什么、判什么」，不含设计契约与实现细节（契约以 `specs/2026-09-29-base-tagging-design.md` 为准）。

## 0. 本次发布产物

| 项 | 值 |
|---|---|
| App 版本 | `0.14.0`（versionCode `19`） |
| APK 下载 | <http://118.190.217.242/dl/base-0.14.0.apk> ｜ 落地页 <http://118.190.217.242/> |
| APK 字节数 / sha256 | `27424106` / `5276bdd00450c2b0c3a7b825f66a46246cf59006e1133ffa7c325e7d91a4ae4d` |
| 签名证书 SHA1 | `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`（与 0.6.0–0.13.1 一致 ⇒ 可覆盖安装） |
| 节点二进制 | `/opt/base/based` = `7cefae4733fbc3c294bf2924207f7ec98b0117ea78bf042eeb4ce87427d469bd`（`21736332` 字节） |
| release 文档 | `/opt/base-cache/data/release.json`，`version_name=0.14.0` / `min_version_name=0.8.0` / `issued_at=2026-09-30T01:01:14Z` |
| 服务 | `base`（`:8081`）、`base-cache`（`127.0.0.1:8082`） |

**本次为二次重编重发**：版本号与功能集与首次发布**完全相同**，只是重新构建后覆盖上线。故
`apk_sha256` 与首次发布（`108b1163…`）不同属正常——云打包产物含时间戳等非确定成分；`apk_size` 相同是巧合。证书指纹不变，覆盖安装不受影响。

## 1. 测试前置

| # | 步骤 | 预期 |
|---|---|---|
| 1.1 | 安装 APK（已装 0.13.x 可直接覆盖） | 安装成功，不提示签名冲突 |
| 1.2 | 首次启动 → **我的 → 设置**：确认节点地址为 `http://118.190.217.242`、公钥已预置 → 点一次**保存** | 提示保存成功 |
| 1.3 | 同页点**基座自检** → 跑完 | 随机源 / `plus.io 文件接口` / `plus.sqlite` 三项均为「有」；**「升级文档拉取并验签」为「有」**（即 `verifyRelease` 实测通过） |
| 1.4 | 进**课程** tab 点同步 | 课程列表出现内容 |
| 1.5 | **我的 → 提案与投票**，看标题右侧标注 | 显示「（名册内）」= 本机身份是治理人，可做 A1；显示「（未入名册）」= 非治理人，先做 A3，或先按 #23 规则积累可验贡献后再试 |

> **治理人身份怎么来**：名册由本节点按「可验的贡献度量」实时派生前 10 名（人数不足 10 时门槛更低）。App 不展示名册算法，**只用 1.5 的标注判断**当前身份是否在册；圈子创建者与圈内治者同样具备资格。

## 2. A 组：#37 统一标签体系（7 条）

### A1 治理人给无标签课程打标签（AC 3 / AC 10）

1. 前置：1.5 显示「（名册内）」。
2. **课程** tab → 进一个**尚无标签**的课程详情。
3. 课程标题下方出现「**待补标签 · 补标签**」，点它 → 进「补标签」页。
4. 填 **名称 / 章 / 节** 三段（如 `数学` / `第一章` / `第一节`），点提交。

**预期**：Toast「已打标」，自动返回；课程详情该位置变为**该标签**；点标签进详情页，按 `course / lesson / article / comment` 分组列出关联内容。

### A2 同一课程改标须走提案（AC 5）

1. 回到 A1 的课程详情。
2. 观察该位置。

**预期**：显示「**已有标签，改动需提案**」；点它跳**提案与投票**页。若绕过 UI 再进「补标签」页提交同一课程，节点回 `403 tag_target_tagged`，页面报错「该内容已有标签，请走治理提案」（**不得**出现半生效：课程不得新增第二个标签）。
3. 提案页按 2 票门槛走完 `edit` 提案 → 生效后该标签的关联集被**全量替换**为新提交的内容，且标签条目的作者与签名**不变**。

### A3 非治理人看不到补标签入口，但能浏览（AC 4 / AC 10）

1. 前置：用**未登记身份**（或 1.5 显示「（未入名册）」的身份）。
2. 进**有标签**与**无标签**的课程详情各一个。
3. 进 **我的 → 全部标签**。

**预期**：
- 无标签课程**看不到**「待补标签 · 补标签」字样；有标签课程**看不到**「已有标签，改动需提案」（两者都只对治理人显示）。
- 「全部标签」列表**可正常浏览**（登录与否都可看）。
- 若强行进入补标签页提交：页面顶部提示「本机身份不在治理人名册…」，节点回 `403 tag_not_governor`，且**不产生**该标签条目。

### A4 评论页只读标签（§3.6 / AC 10）

1. **评论** tab → 选一个内容 → 查看评论列表。

**预期**：**只有已打标的评论**在其下方显示标签；未打标的评论**不出现**「待补」「补标签」任何字样（评论页无待补分支）。点评论上的标签可进标签详情。

### A5 断网打标 → 恢复后仅补发一条（AC 11）

1. 开**飞行模式**。
2. 课程详情 → 对一个无标签课程点「补标签」→ 填三段 → 提交。
3. 进 **我的 → 我的条目**，看「待发」区。
4. 关飞行模式，等待或手动触发补发（回到「我的条目」页会触发补发编排）。

**预期**：
- 断网提交**不报死错**，条目落入「待发」区，本机台账有该行；
- 恢复网络后**自动补发仅一条**，「已发」区出现该标签，**不重复**、无第二条；
- 补发重建的草稿与在线直发的载荷**一致**（同 `item_id` 不产生第二条目）。

### A6 ② 类内容零标签入口（§3.7 红线）

1. 进**圈子** tab → 小组会话页；进 **我的 → 好友与私信** → 任意会话页。

**预期**：两处均**没有任何**标签字样、标签入口、标签占位。② 类内容在节点侧也无 `kind`（C3 会验）。

### A7 「我的条目」里 `tag` 行无「修改 / 重投更新」

1. 在 A1 或 A5 之后进 **我的 → 我的条目** → 找到类型为标签的条目。
2. 点「查看」。

**预期**：进入**标签详情**页；该行**没有**「修改」「重投更新」按钮（标签改动只能走提案，见 A2）。

## 3. B 组：全站回归

> 目的：确认本次换二进制与重编客户端**未回归**既有功能。每项只需跑一次主路径。

| # | 范围 | 操作 | 预期 |
|---|---|---|---|
| B1 | 课程四级浏览 | 课程 tab → 分类 → 课程 → 课时 → 载体 | 分类可筛；「未归类」分组存在；课时可展开/收起；文章可打开 |
| B2 | 搜索 | 课程 tab 的搜索入口 → 输入关键词 | 返回结果，点进可打开 |
| B3 | 文章与收藏 | 打开一篇文章 → 收藏 → **我的 → 我的收藏** | 该文章出现在收藏列表 |
| B4 | 答题 | 从课程页 / 课时页 / 文章页三个入口各进一次「答题」 | 题目可作答，提交后有结果；三入口均可进 |
| B5 | 评论发表 | 评论 tab → 选内容 → 输入 → 发表 | 发表成功并出现在列表；换设备可见同一条 |
| B6 | 评论离线队列 | 开飞行模式发表一条评论 → **我的条目**看「待发」→ 关飞行模式 | 断网不丢，恢复后补发**仅一条** |
| B7 | 圈子建组 / 入组 / 发言 | 圈子 tab → 新建小组 → 复制邀请码；另一台设备加入小组；进会话页发言 | 双方看到同一条发言（内容对节点是密文） |
| B8 | 圈子形态与治者面板 | 建一个**封闭圈**与一个**开放圈**各一个 → 进小组会话页看治者面板 | 封闭圈需邀请码；开放圈可自助加入；封闭圈邀请码带密钥可解密；治者面板显示席位 |
| B9 | 私信 | **我的 → 好友与私信** → 复制好友码 → 另一台粘码加好友 → 会话页发言 | 双方互通（全离线可用，内容对节点是密文） |
| B10 | 投稿 | **我的 → 新建投稿** → 投一条 article 与一条 quiz | 有网直发成功；断网则入「待发」并可在恢复后补发 |
| B11 | 治理看板 | 浏览器打开 <http://118.190.217.242/governance> | 只读流水看板可打开，无报错 |
| B12 | 升级通道 | **我的 → 设置 → 检查更新** | 不弹强更（本机已是 0.14.0，min 为 0.8.0）；无异常提示 |

## 4. C 组：节点侧接口验证

> 全部为**只读或幂等探活**，不写业务数据。在部署机（能 `ssh me`）上执行。

### C1 写入并执行只读探活脚本

```sh
cat > /tmp/verify.sh <<'EOF'
#!/bin/sh
DB=/opt/base/data/base.db
echo "== release doc =="
curl -s http://118.190.217.242/v1/release; echo
echo "== apk head =="
curl -s -I http://118.190.217.242/dl/base-0.14.0.apk | grep -iE 'HTTP/|content-length'
echo "== landing page residual 0.13.x (expect 0) =="
grep -c '0\.13\.[0-9]' /opt/appdl/index.html || echo "0 hits"
grep -o 'base-0\.14\.0\.apk' /opt/appdl/index.html | head -1
echo "== db structures =="
sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='tag_links';"
sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tag_links_target';"
sqlite3 "$DB" "PRAGMA table_info(govern_proposals);" | grep links_json
echo "== submit route (expect 400, NOT 404/500) =="
curl -s -o /dev/null -w 'tag=%{http_code}\n' -X POST http://127.0.0.1:8081/v1/submit \
  -H 'Content-Type: application/json' \
  -d '{"type":"tag","item_id":"tag/a/b/c","title":"a · b · c","links":[],"author_sig":"00"}'
curl -s -o /dev/null -w 'article=%{http_code}\n' -X POST http://127.0.0.1:8081/v1/submit \
  -H 'Content-Type: application/json' \
  -d '{"type":"article","item_id":"article/x","title":"x","body_md":"y","author_sig":"00"}'
echo "== services =="
systemctl is-active base base-cache
sha256sum /opt/base/based
EOF
sh /tmp/verify.sh
```

**逐行判读**：

| 探针 | 预期 |
|---|---|
| `release doc` | `version_name` = `0.14.0`、`apk_size` = `27424106`、`apk_sha256` = `5276bdd0…4ae4d`、`min_version_name` = `0.8.0` |
| `apk head` | `HTTP/1.1 200 OK` + `Content-Length: 27424106`（与本地一致） |
| 落地页残留 | `0` 命中；且命中 `base-0.14.0.apk`（**不得**出现 `0.13.x`） |
| 库结构 | 输出 `tag_links`、`idx_tag_links_target`、含 `links_json` 的一行（`TEXT NOT NULL DEFAULT ''`） |
| `submit route` | `tag=400`、`article=400`（**既有鉴权拒绝**）；**不得**是 `404`（路由缺失）或 `500`（handler panic） |
| `services` | 两个 `active`；`based` 的 sha256 = `7cefae47…69bd` |

### C2 `tag_links` 内容抽查（有 A 组数据后执行）

```sh
sqlite3 /opt/base/data/base.db \
  "SELECT tag_id, target_id, kind FROM tag_links ORDER BY tag_id, target_id LIMIT 20;"
sqlite3 /opt/base/data/base.db \
  "SELECT seq, kind, substr(text,1,60) FROM segments WHERE item_id LIKE 'tag/%' ORDER BY item_id, seq LIMIT 20;"
```

**预期**：
- A1 打的标签在 `tag_links` 有行，`kind` 与目标形态匹配（`course/<cid>` → `course`，`course/<cid>/lesson/<lid>` → `lesson`，`article/...` → `article`，`comment/<32hex>` → `comment`）；
- 同一 `tag_id` 在 `segments` 中按 **`kind` 固定序（course < lesson < article < comment）→ 同 kind 内 `target_id` 升序** 物化，`seq` 从 `1` 连续；
- **没有任何** `kind` 为 `group` / `dm` 的行（② 类红线）。

### C3 验收后重签 release（如有需要）

仅当重新打包了 APK 才需执行；密钥从部署机环境取，**不写进任何文档**：

```sh
BASE_SIGN_KEY=<部署机环境变量> /opt/base/based release \
  -version-name 0.14.0 -min-version-name 0.8.0 \
  -apk-url http://118.190.217.242/dl/base-0.14.0.apk \
  -apk-file /opt/appdl/base-0.14.0.apk \
  -notes <不含空格的一个 token> \
  -out /opt/base-cache/data/release.json
```

> `-min-version-name` 进签名载荷：**签高会让老客户端立刻被强更拦住**，非明确要求不得抬高（本次沿用 `0.8.0`）。`-notes` 必须是**不含空格**的单个 token。

### C4 二进制替换的安全姿势（回滚同理）

```sh
# 不要用 cp：accept-node-1.service(:8090) 也持有 /opt/base/based，cp 会报 Text file busy
mv -f /opt/base/based-0.14.0 /opt/base/based && chmod 0755 /opt/base/based
systemctl restart base && systemctl restart base-cache
sha256sum /opt/base/based
```

回滚：`mv -f /opt/base/based.bak-0.14.0-b1 /opt/base/based && systemctl restart base && systemctl restart base-cache`
（更早的 `based.bak-0.13.1` 亦在 `/opt/base/`）

## 5. 结果记录

| 组 | 条目 | 结论（PASS / FAIL / BLOCKED） | 备注 |
|---|---|---|---|
| A | A1–A7 | | |
| B | B1–B12 | | |
| C | C1–C4 | | |

> A5 / B6 需**真机飞行模式**，模拟器上行为可能不同，以真机为准。
> 任一 FAIL 请记录：节点、机型、App 版本、复现步骤、实际结果与截图。
