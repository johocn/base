package main

import (
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/johocn/base/internal/packexport"
	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

func runExport(args []string) error {
	fs := flag.NewFlagSet("export", flag.ExitOnError)
	data := fs.String("data", "data", "数据目录")
	key := fs.String("sign-key", os.Getenv("BASE_SIGN_KEY"), "Ed25519 私钥种子（hex64）；源节点必备")
	issuer := fs.String("issuer", envOr("BASE_ISSUER", "base-node-1"), "签发方标识")
	issuedAt := fs.String("issued-at", "", "签发时间（RFC3339，留空取当前 UTC）")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *key == "" {
		return fmt.Errorf("export: 缺少 -sign-key（或环境变量 BASE_SIGN_KEY）：没有私钥不能签发内容包")
	}
	opt := packexport.Options{Issuer: *issuer, SignKeyHex: *key}
	if *issuedAt != "" {
		t, err := time.Parse(time.RFC3339, *issuedAt)
		if err != nil {
			return fmt.Errorf("export: -issued-at 解析失败: %w", err)
		}
		opt.IssuedAt = t
	}
	st, err := store.Open(*data)
	if err != nil {
		return err
	}
	defer st.Close()
	res, err := packexport.Export(st, opt)
	if err != nil {
		return err
	}
	kp, err := protocol.KeyPairFromSeed(*key)
	if err != nil {
		return err
	}
	fmt.Printf("export: pack_id=%s content_version=%d entries=%d merkle_root=%s\n", res.PackID, res.ContentVersion, res.Entries, res.MerkleRoot)
	fmt.Printf("  pack.sqlite  %s  sha256=%s\n", res.PackPath, res.PackSHA256)
	fmt.Printf("  manifest.json %s  sha256=%s\n", res.ManifestPath, res.ManifestSHA256)
	fmt.Printf("  public_key   %s\n", kp.PubHex)
	return nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}