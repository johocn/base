package main

import (
	"flag"
	"log"
	"net/http"
	"os"

	"github.com/johocn/base/internal/httpapi"
	"github.com/johocn/base/internal/store"
)

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	data := fs.String("data", "data", "数据目录")
	addr := fs.String("addr", envOr("BASE_ADDR", ":8080"), "监听地址")
	issuer := fs.String("issuer", envOr("BASE_ISSUER", "base-node-1"), "签发方标识")
	key := fs.String("sign-key", os.Getenv("BASE_SIGN_KEY"), "Ed25519 私钥种子（hex64）；配置了才是源节点")
	if err := fs.Parse(args); err != nil {
		return err
	}
	st, err := store.Open(*data)
	if err != nil {
		return err
	}
	defer st.Close()
	srv, err := httpapi.New(st, httpapi.Options{Issuer: *issuer, SignKeyHex: *key, Version: version})
	if err != nil {
		return err
	}
	log.Printf("based %s listening on %s (issuer=%s source=%v data=%s)",
		version, *addr, *issuer, *key != "", *data)
	return http.ListenAndServe(*addr, srv.Handler())
}