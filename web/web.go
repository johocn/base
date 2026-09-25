// Package web 持有节点自带只读浏览页的模板，由 go:embed 编进二进制，
// 使节点分发物仍是「单个可执行文件 + data 目录」。
package web

import "embed"

//go:embed templates/*.html
var FS embed.FS