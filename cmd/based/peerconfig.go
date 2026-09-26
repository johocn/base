package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/johocn/base/internal/httpapi"
	"github.com/johocn/base/internal/peersync"
	"github.com/johocn/base/internal/store"
)

// peerFlags 是出站（peersync）与本地库共同用到的 flag 集合。
// serve / peer-sync / scrub 三个子命令都通过 registerPeerFlags 注册，避免三处各写一份默认值。
type peerFlags struct {
	data          *string
	storeKey      *string
	peersRaw      *string
	issuerPubKeys *string
	tlsCert       *string
	tlsKey        *string
	nodeKey       *string
	fetchMaxBlobs *int
	syncInterval  *string
	scrubInterval *string
}

func registerPeerFlags(fs *flag.FlagSet) *peerFlags {
	return &peerFlags{
		data:          fs.String("data", envOr("BASE_DATA", "data"), "数据目录"),
		storeKey:      fs.String("store-key", os.Getenv("BASE_STORE_KEY"), "L4a′ 静态加密密钥（hex64）；缺省 <data>.key，两者皆无则首启生成"),
		peersRaw:      fs.String("peers", os.Getenv("BASE_PEERS"), `对端清单 JSON：[{"url":"https://...","tls_fingerprint":"<hex64>"}]`),
		issuerPubKeys: fs.String("issuer-pubkeys", os.Getenv("BASE_ISSUER_PUBKEYS"), `签发方公钥信任表 JSON：[{"issuer":"...","public_key_hex":"<64 hex>"}]`),
		tlsCert:       fs.String("tls-cert", envOr("BASE_TLS_CERT", ""), "本节点证书路径；空=<data>/tls/node.crt；off=主监听明文 HTTP"),
		tlsKey:        fs.String("tls-key", envOr("BASE_TLS_KEY", ""), "本节点私钥路径；空=<data>/tls/node.key"),
		nodeKey:       fs.String("node-key", os.Getenv("BASE_NODE_KEY"), "节点间预共享密钥（头 X-Base-Node-Key）"),
		fetchMaxBlobs: fs.Int("fetch-max-blobs", envIntOr("BASE_FETCH_MAX_BLOBS", 64), "fetch 单请求块数上限"),
		syncInterval:  fs.String("sync-interval", envOr("BASE_SYNC_INTERVAL", "5m"), "反熵轮间隔（Go duration）"),
		scrubInterval: fs.String("scrub-interval", envOr("BASE_SCRUB_INTERVAL", "24h"), "scrub 轮间隔（Go duration）"),
	}
}

// peers 把 -peers 转成出站对端清单。
func (f *peerFlags) peers() ([]peersync.Peer, error) {
	specs, err := parsePeers(*f.peersRaw)
	if err != nil {
		return nil, err
	}
	out := make([]peersync.Peer, 0, len(specs))
	for _, s := range specs {
		out = append(out, peersync.Peer{URL: s.URL, TLSFingerprint: s.TLSFingerprint})
	}
	return out, nil
}

// defaultCertPaths 返回默认证书/私钥路径（<data>/tls/node.crt|key）。
// 与 -tls-cert=off 无关：off 只说「主监听不加密」，节点本身份仍然存在。
func (f *peerFlags) defaultCertPaths() (certPath, keyPath string) {
	return filepath.Join(*f.data, "tls", "node.crt"), filepath.Join(*f.data, "tls", "node.key")
}

// certPaths 返回主监听要用的证书/私钥路径；-tls-cert=off 时返回空串（主监听明文）。
func (f *peerFlags) certPaths() (certPath, keyPath string) {
	if strings.EqualFold(strings.TrimSpace(*f.tlsCert), "off") {
		return "", ""
	}
	certPath, keyPath = strings.TrimSpace(*f.tlsCert), strings.TrimSpace(*f.tlsKey)
	defCert, defKey := f.defaultCertPaths()
	if certPath == "" {
		certPath = defCert
	}
	if keyPath == "" {
		keyPath = defKey
	}
	return certPath, keyPath
}

// tlsInfo 加载（必要时生成）本节点 TLS 身份。
// 出站（节点↔节点）必须带证书，且**与主监听是否明文无关**：F1 退路下主监听走 HTTP，
// 但节点↔节点仍是双向 TLS + 指纹固定，故 off 时落回默认证书路径，而不是报错。
func (f *peerFlags) tlsInfo() (httpapi.TLSInfo, error) {
	certPath, keyPath := f.certPaths()
	if certPath == "" && keyPath == "" {
		certPath, keyPath = f.defaultCertPaths()
	}
	return httpapi.LoadOrCreateTLSCert(certPath, keyPath)
}

// openStore 打开内容库（注入 -store-key 时优先于 <data>.key）。
func (f *peerFlags) openStore() (*store.Store, error) {
	opts := []store.Option{}
	if strings.TrimSpace(*f.storeKey) != "" {
		opts = append(opts, store.WithStoreKey(*f.storeKey))
	}
	return store.Open(*f.data, opts...)
}

// config 组装出站配置。
func (f *peerFlags) config(info httpapi.TLSInfo) (peersync.Config, error) {
	pubs, err := peersync.ParseIssuerPubKeys(*f.issuerPubKeys)
	if err != nil {
		return peersync.Config{}, err
	}
	return peersync.Config{
		OwnTLS:        info,
		NodeKey:       strings.TrimSpace(*f.nodeKey),
		IssuerPubKeys: pubs,
		FetchMaxBlobs: *f.fetchMaxBlobs,
	}, nil
}

// durations 解析两个调度间隔。
func (f *peerFlags) durations() (syncEvery, scrubEvery time.Duration, err error) {
	syncEvery, err = time.ParseDuration(strings.TrimSpace(*f.syncInterval))
	if err != nil {
		return 0, 0, fmt.Errorf("-sync-interval 解析失败: %w", err)
	}
	scrubEvery, err = time.ParseDuration(strings.TrimSpace(*f.scrubInterval))
	if err != nil {
		return 0, 0, fmt.Errorf("-scrub-interval 解析失败: %w", err)
	}
	return syncEvery, scrubEvery, nil
}

func envIntOr(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return def
}

func logf(format string, a ...any) { log.Printf(format, a...) }
