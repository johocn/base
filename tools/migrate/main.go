// Command migrate 一次性把 Strapi（zhao-website 文章）迁移进 base 内容库。
// 可重跑、幂等：以 (source, item_id) 为幂等键，重跑覆盖同一条目并刷新 source_rev。
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/johocn/base/internal/store"
)

type headerFlags map[string]string

func (h headerFlags) String() string { return "" }

func (h headerFlags) Set(v string) error {
	i := strings.IndexByte(v, ':')
	if i <= 0 {
		return fmt.Errorf("header 需为 'Name: value' 形式，收到 %q", v)
	}
	h[strings.TrimSpace(v[:i])] = strings.TrimSpace(v[i+1:])
	return nil
}

func main() {
	strapi := flag.String("strapi", os.Getenv("STRAPI"), "Strapi 基址，如 http://39.97.54.5")
	data := flag.String("data", "data", "内容库数据目录")
	pageSize := flag.Int("page-size", 50, "分页大小")
	limit := flag.Int("limit", 0, "最多导入多少篇（0 = 不限）")
	timeout := flag.Duration("timeout", 60*time.Second, "单请求超时")
	dryRun := flag.Bool("dry-run", false, "只打印将要导入的条目，不写库")
	hdrs := headerFlags{}
	flag.Var(hdrs, "H", "附加请求头（可重复），如 -H \"Host: v.joho.cn\"")
	flag.Parse()

	st, err := store.Open(*data)
	if err != nil {
		fmt.Fprintln(os.Stderr, "migrate: "+err.Error())
		os.Exit(1)
	}
	defer st.Close()

	res, err := Run(st, Options{
		BaseURL: *strapi, Headers: hdrs, PageSize: *pageSize,
		Limit: *limit, HTTPTimeout: *timeout, DryRun: *dryRun,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "migrate: "+err.Error())
		os.Exit(1)
	}
	fmt.Printf("migrate: seen=%d published=%d skipped=%d imported=%d covers=%d\n",
		res.Seen, res.Published, res.Skipped, res.Imported, res.Covers)
	// 源端为空库是正常情况（实测 zhao_website_articles = 0），不算失败
}