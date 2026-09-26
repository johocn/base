package main

import (
	"flag"
	"fmt"
	"strings"

	"github.com/johocn/base/internal/store"
)

// runStoreKey 是 L4a′ 静态加密密钥的运维入口。
//
//	store-key show —— 只读打印密钥来源与 hex（不创建任何文件）
//	store-key init —— 密钥不存在则生成（serve 首启同样会自动生成）
//
// 契约 7.5：密钥一旦确定不得变更；变更 = 全库重写，属运维事故处置。
func runStoreKey(args []string) error {
	fs := flag.NewFlagSet("store-key", flag.ExitOnError)
	data := fs.String("data", "data", "数据目录")
	// 子命令在前（based store-key show -data x），故先取子命令再解析其余 flag：
	// flag 包遇到首个非 flag 参数即停止解析，直接 Parse(args) 会静默忽略 -data。
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return fmt.Errorf("用法: based store-key <show|init> [-data <dir>]")
	}
	sub := args[0]
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("未知参数 %q；用法: based store-key <show|init> [-data <dir>]", fs.Arg(0))
	}

	path, keyHex, exists, err := store.StoreKeyStatus(*data)
	if err != nil {
		return err
	}

	switch sub {
	case "show":
		if !exists {
			return fmt.Errorf("密钥不存在（来源 %s）：先运行 based store-key init", displayPath(path))
		}
		fmt.Printf("key_path = %s\n", displayPath(path))
		fmt.Printf("key_hex  = %s\n", keyHex)
		return nil

	case "init":
		if exists {
			fmt.Printf("密钥已存在，未改动。\nkey_path = %s\nkey_hex  = %s\n", displayPath(path), keyHex)
			return nil
		}
		st, err := store.Open(*data)
		if err != nil {
			return err
		}
		defer st.Close()
		fmt.Println("已生成密钥（离线恢复码，请抄走并离线保存）：")
		fmt.Printf("key_path = %s\n", st.StoreKeyPath())
		fmt.Printf("key_hex  = %s\n", st.StoreKeyHex())
		fmt.Println("警告：丢失该密钥 = data 目录内内容永久不可读。")
		return nil

	default:
		return fmt.Errorf("未知子命令 %q；用法: based store-key <show|init>", sub)
	}
}

// displayPath 让「密钥来自环境变量」也有可读输出。
func displayPath(p string) string {
	if p == "" {
		return "(环境变量注入，无文件)"
	}
	return p
}