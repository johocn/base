package httpapi

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestPortalOracleGenerate 是门户黄金字节对拍的 Go 预言机：
// 读 apps/node/src/routes/__fixtures__/portal/pagedata.json，
// 用与线上一致的 html/template（indexTmpl / articleTmpl）渲染并覆写同名 .html，
// 作为 Node 侧 portal.test.ts 的字节真值来源。
//
// 平时跳过；重生成 fixture：
//
//	PORTAL_ORACLE=1 go test ./internal/httpapi -run TestPortalOracleGenerate
//
// governance 两组 fixture 为 V1 数据（V2 fixture 待重生成），此处不触碰。
func TestPortalOracleGenerate(t *testing.T) {
	if os.Getenv("PORTAL_ORACLE") == "" {
		t.Skip("设置 PORTAL_ORACLE=1 才执行 fixture 重生成")
	}
	const dir = "../../apps/node/src/routes/__fixtures__/portal"
	raw, err := os.ReadFile(filepath.Join(dir, "pagedata.json"))
	if err != nil {
		t.Fatalf("读 pagedata.json: %v", err)
	}
	var pages map[string]pageData
	if err := json.Unmarshal(raw, &pages); err != nil {
		t.Fatalf("解析 pagedata.json: %v", err)
	}
	for _, key := range []string{"index", "index-empty", "index-url", "article", "article-url"} {
		data, ok := pages[key]
		if !ok {
			t.Fatalf("pagedata.json 缺少 %s", key)
		}
		tmpl := indexTmpl
		if strings.HasPrefix(key, "article") {
			tmpl = articleTmpl
		}
		var buf bytes.Buffer
		if err := tmpl.ExecuteTemplate(&buf, "base.html", data); err != nil {
			t.Fatalf("%s 渲染: %v", key, err)
		}
		if err := os.WriteFile(filepath.Join(dir, key+".html"), buf.Bytes(), 0o644); err != nil {
			t.Fatalf("%s 写 fixture: %v", key, err)
		}
		t.Logf("%s: %d 字节", key, buf.Len())
	}
}
