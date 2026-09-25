# tools/migrate —— 一次性迁移工具

把 Strapi 的 `zhao-website` 文章搬进 base 内容库（`data/base.db`）。**迁移后 base 与 Strapi 零依赖、零同步。**

## 实测探测结论（2026-09-25 于 `39.97.54.5`）

| 项 | 结论 |
|---|---|
| 列表 | `GET /api/zhao-website/v1/articles?page=&pageSize=&sort=` → HTTP 200，**body 为裸数组**（不是 Strapi 5 的 `{data,meta}`） |
| 详情 | `GET /api/zhao-website/v1/articles/:slug` |
| 必需 header | `Host: v.joho.cn`（`joho.cn` / `www.shenglin.vip` 返回 404，`h.joho.cn` 返回 301） |
| token | 匿名可用（无需 API token），但路由挂了 `plugin::zhao-auth.has-channel-scope` 策略；若日后需要 token，用 `-H "Authorization: Bearer <token>"` 传入 |
| 正文字段 | `content`，类型 `text`（**不是** blocks JSON），原样存入 `articles.body_md` |
| 内容库现状 | `zhao_website_articles = 0`（空库）→ 迁移 0 条属正常，退出码 0 |

DB 直查（需要时）：`ssh joho` 后 `docker exec -i 1Panel-postgresql-pIe0 psql -U youshaop -d strapi -c "select count(*) from zhao_website_articles;"`

## 用法

```powershell
go run ./tools/migrate -strapi http://39.97.54.5 -data data -H "Host: v.joho.cn" -dry-run
go run ./tools/migrate -strapi http://39.97.54.5 -data data -H "Host: v.joho.cn"
```

参数：`-strapi`（或环境变量 `STRAPI`）、`-data`、`-page-size`、`-limit`、`-timeout`、`-dry-run`、`-H`（可重复）。

## 迁移边界（P0）

- 只迁移 `status = published`；`status` 字段缺失时视为已发布（自定义列表端点可能已过滤）。
- 正文原样搬运，不做格式转换；正文内嵌图片保留原始 URL，**离线不保证显示**（P1 处理）。
- `coverImage` 导出为 `type=cover` 条目并按内容寻址入库；缺失或下载失败只打印提示，不阻塞迁移。
- 幂等键为 `item_id`（`article:<slug>`、`cover:<slug>`），重跑覆盖并刷新 `source_rev`。
- 迁移不递增 `content_version`；版本由 `based export` 负责。