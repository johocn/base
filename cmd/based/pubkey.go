package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/johocn/base/internal/protocol"
)

func runPubkey(args []string) error {
	fs := flag.NewFlagSet("pubkey", flag.ExitOnError)
	issuer := fs.String("issuer", envOr("BASE_ISSUER", "base-node-1"), "签发方标识")
	key := fs.String("sign-key", os.Getenv("BASE_SIGN_KEY"), "Ed25519 私钥种子（hex64）")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *key == "" {
		return fmt.Errorf("pubkey: 缺少 -sign-key（或环境变量 BASE_SIGN_KEY）")
	}
	kp, err := protocol.KeyPairFromSeed(*key)
	if err != nil {
		return err
	}
	fmt.Printf("issuer=%s\npublic_key_hex=%s\n", *issuer, kp.PubHex)
	return nil
}