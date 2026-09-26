package main

import (
	"context"
	"flag"
)

// runScrub 手动触发一次 scrub（契约 §8）。
// 只修本地：坏块按 blob_replicas 登记的邻居逐个试拉回，全部拿不到则告警并列入未修复。
func runScrub(args []string) error {
	fs := flag.NewFlagSet("scrub", flag.ExitOnError)
	pf := registerPeerFlags(fs)
	blob := fs.String("blob", "", "只校验该块（32 位 hex）；空=全量")
	if err := fs.Parse(args); err != nil {
		return err
	}
	peers, err := pf.peers()
	if err != nil {
		return err
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

	var only []string
	if *blob != "" {
		only = []string{*blob}
	}
	res, err := cfg.ScrubOnce(context.Background(), st, peers, only)
	if err != nil {
		return err
	}
	logf("based: %s", res)
	for _, id := range res.Unrepaired {
		logf("based: **告警** 块 %s 所有已知 peer 都拿不到，保留在未修复列表", id)
	}
	return nil
}
