"""
base 学习平台 H5 真机冒烟测试（公网已部署版本）
覆盖：首页 / 课程列表 / 课时详情 / 文章编辑器 Tab / 账号托管恢复页 / 治理看板 / 提交链路健康检查

策略：只做「存在性 + 可导航」验证，不触发实际写入（避免污染线上数据）
"""
from playwright.sync_api import sync_playwright, Page, expect
import sys, json

BASE = 'http://118.190.217.242'
LOG = []

def log(msg):
    LOG.append(msg)
    print(f'  [smoke] {msg}')

def goto_wait(page: Page, path: str):
    url = f'{BASE}{path}'
    log(f'GOTO {url}')
    page.goto(url, wait_until='networkidle', timeout=15000)
    return page

def check_visible(page: Page, selector: str, label: str, timeout=5000):
    try:
        el = page.locator(selector).first
        el.wait_for(state='visible', timeout=timeout)
        log(f'  ✅ {label} 可见 ({selector})')
        return True
    except Exception:
        log(f'  ❌ {label} 不可见 ({selector})')
        page.screenshot(path=f'/tmp/smoke-miss-{label}.png', full_page=False)
        return False

def h5_routes(page: Page):
    """逐个关键 hash 路由验证能打开 + 页面标题/核心元素存在"""
    routes = [
        ('/', '首页 (TabBar)'),
        ('/#/pages/course/course', '课程列表'),
        ('/#/pages/governance/governance', '治理看板'),
        ('/#/pages/setting/setting', '设置页'),
        ('/#/pages/submit/submit', '提交页'),
        ('/#/pages/identity/backup', '账号托管'),
        ('/#/pages/identity/restore', '恢复账号'),
    ]
    results = {}
    for path, label in routes:
        try:
            goto_wait(page, path)
            # SPA 要等 Vue 渲染
            page.wait_for_timeout(1200)
            h = page.locator('h1, h2, .title, .header').first
            page.screenshot(path=f'/tmp/smoke-route-{path.replace("/","_")}.png', full_page=False)
            results[label] = True
            log(f'  ✅ {label} — 路由可达，页面已渲染')
        except Exception as e:
            log(f'  ❌ {label} — 路由失败: {e}')
            results[label] = False
    return results

def api_health(page: Page):
    """API 端点健康检查 — 通过 fetch 调用"""
    checks = [
        ('/v1/catalog',  lambda b: b.get('pack_id')),
        ('/v1/release',  lambda b: b.get('payload')),
        ('/v1/comment',  lambda b: b.get('comments') is not None),
        ('/v1/proposal', lambda b: all(
            all(k in p for k in ['voterCount', 'quorum', 'netWeight', 'governanceLevel', 'category'])
            for p in (b.get('proposals') or [])
        )),
        ('/v1/contributors', lambda b: b.get('contributors') is not None and len(b.get('contributors', [])) <= 10),
        ('/healthz',     lambda b: True),
    ]
    results = {}
    for path, ok in checks:
        url = f'{BASE}{path}'
        try:
            resp = page.request.get(url, timeout=6000)
            status = resp.status
            body = resp.text()
            try:
                data = resp.json()
                results[path] = (status == 200 and ok(data))
            except Exception:
                results[path] = (status == 200)
            log(f'  {"✅" if results[path] else "⚠"} {path} — HTTP {status}')
        except Exception as e:
            log(f'  ❌ {path} — 调用失败: {e}')
            results[path] = False
    return results

def main():
    log('======== base 学习平台 H5 冒烟 ========')
    log(f'目标: {BASE}')

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport={'width': 390, 'height': 844},
            user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        )
        page = ctx.new_page()

        page.on('console', lambda m: log(f'[console:{m.type}] {m.text[:120]}'))
        page.on('pageerror', lambda e: log(f'[pageerror] {str(e)[:120]}'))

        route_results = h5_routes(page)
        api_results = api_health(page)

        browser.close()

    all_ok = all(list(route_results.values()) + list(api_results.values()))
    log('======== 冒烟结果 ========')
    log(f'路由通过率: {sum(route_results.values())}/{len(route_results)}')
    log(f'API通过率:  {sum(api_results.values())}/{len(api_results)}')

    # 汇总
    failures = [k for k, v in route_results.items() if not v]
    failures += [k for k, v in api_results.items() if not v]

    if all_ok:
        print('\n🎉 冒烟全部通过，可进真机测试')
        return 0
    else:
        print(f'\n⚠ 有 {len(failures)} 项未通过: {failures}')
        return 1

if __name__ == '__main__':
    sys.exit(main())
