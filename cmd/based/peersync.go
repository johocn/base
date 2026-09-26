package main

import (
	"context"
	"flag"
	"fmt"
)

func runPeerSync(args []string) error {
	fs := flag.NewFlagSet("peer-sync", flag.ExitOnError)
	pf := registerPeerFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	peers, err := pf.peers()
	if err != nil {
		return err
	}
	if len(peers) == 0 {
		return fmt.Errorf("peer-sync: 需要至少一个对端（-peers 或 BASE_PEERS）")
	}
	info, err := pf.tlsInfo()
	if err != nil {
		return err
	}
	cfg, err := pf.config(info)
	if err != nil {
		return err
	}
	st, err := pf.openStore()
	if err != nil {
		return err
	}
	defer st.Close()

	results := cfg.RunOnce(context.Background(), st, peers, logf)
	if len(results) == 0 {
		return fmt.Errorf("peer-sync: %d 个对端全部失败", len(peers))
	}
	for _, r := range results {
		fmt.Println(r)
	}
	return nil
}
