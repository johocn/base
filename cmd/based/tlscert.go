package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/johocn/base/internal/httpapi"
)

// runTLSCert 管理节点自签证书（契约 6.1 / 6.2）。
//
//	tls-cert init   —— 不存在则生成；已存在则报错（避免误换指纹）
//	tls-cert show   —— 打印证书路径、完整指纹 hex、配对码
//	tls-cert rotate —— 备份旧证书后生成新证书（所有客户端需重新配对）
func runTLSCert(args []string) error {
	fs := flag.NewFlagSet("tls-cert", flag.ExitOnError)
	data := fs.String("data", "data", "数据目录")
	cert := fs.String("cert", "", "证书路径；空=<data>/tls/node.crt")
	key := fs.String("key", "", "私钥路径；空=<data>/tls/node.key")
	// 子命令在前（based tls-cert show -data x），故先取子命令再解析其余 flag：
	// flag 包遇到首个非 flag 参数即停止解析，直接 Parse(args) 会静默忽略 -data。
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return fmt.Errorf("用法: based tls-cert <init|show|rotate> [-data <dir>]")
	}
	sub := args[0]
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("未知参数 %q；用法: based tls-cert <init|show|rotate> [-data <dir>]", fs.Arg(0))
	}

	certPath, keyPath := *cert, *key
	if certPath == "" {
		certPath = filepath.Join(*data, "tls", "node.crt")
	}
	if keyPath == "" {
		keyPath = filepath.Join(*data, "tls", "node.key")
	}

	switch sub {
	case "init":
		if _, err := os.Stat(certPath); err == nil {
			return fmt.Errorf("证书已存在：%s；如需换新请用 tls-cert rotate", certPath)
		}
	case "show":
		if _, err := os.Stat(certPath); err != nil {
			return fmt.Errorf("证书不存在：%s；先运行 based tls-cert init", certPath)
		}
	case "rotate":
		stamp := time.Now().Format("20060102T150405")
		for _, p := range []string{certPath, keyPath} {
			if _, err := os.Stat(p); err != nil {
				continue
			}
			bak := p + "." + stamp + ".bak"
			if err := os.Rename(p, bak); err != nil {
				return fmt.Errorf("备份 %s: %w", p, err)
			}
			fmt.Printf("已备份 %s → %s\n", p, bak)
		}
	default:
		return fmt.Errorf("未知子命令 %q；用法: based tls-cert <init|show|rotate>", sub)
	}

	info, err := httpapi.LoadOrCreateTLSCert(certPath, keyPath)
	if err != nil {
		return err
	}
	fmt.Printf("cert         = %s\n", info.CertFile)
	fmt.Printf("key          = %s\n", info.KeyFile)
	fmt.Printf("fingerprint  = %s\n", info.FingerprintHex)
	fmt.Printf("pairing_code = %s\n", info.PairingCode)
	if sub == "rotate" {
		fmt.Println("注意：指纹已变，所有客户端需删除旧记录并重新配对（契约 6.2，不提供忽略开关）。")
	}
	return nil
}