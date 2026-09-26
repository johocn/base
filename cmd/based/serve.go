package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/johocn/base/internal/httpapi"
	"github.com/johocn/base/internal/store"
)

// peerSpec 是契约 6.3 的对端清单元素。
// BASE_PEERS / -peers = [{"url":"https://...","tls_fingerprint":"<hex64>"}]
type peerSpec struct {
	URL            string `json:"url"`
	TLSFingerprint string `json:"tls_fingerprint"`
}

func parsePeers(raw string) ([]peerSpec, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var out []peerSpec
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, fmt.Errorf("BASE_PEERS 不是合法 JSON 数组: %w", err)
	}
	return out, nil
}

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	data := fs.String("data", "data", "数据目录")
	addr := fs.String("addr", envOr("BASE_ADDR", ":8080"), "客户端接口监听地址")
	issuer := fs.String("issuer", envOr("BASE_ISSUER", "base-node-1"), "签发方标识")
	key := fs.String("sign-key", os.Getenv("BASE_SIGN_KEY"), "Ed25519 私钥种子（hex64）；配置了才是源节点")
	storeKey := fs.String("store-key", os.Getenv("BASE_STORE_KEY"), "L4a′ 静态加密密钥（hex64）；缺省 <data>.key，两者皆无则首启生成")
	tlsCert := fs.String("tls-cert", envOr("BASE_TLS_CERT", ""), "客户端接口证书路径；空=<data>/tls/node.crt；off=明文 HTTP（仅 TLS spike 失败时的退路）")
	tlsKey := fs.String("tls-key", envOr("BASE_TLS_KEY", ""), "客户端接口私钥路径；空=<data>/tls/node.key")
	peerAddr := fs.String("peer-addr", envOr("BASE_PEER_ADDR", ""), "节点↔节点监听地址；空=不启用")
	peersRaw := fs.String("peers", os.Getenv("BASE_PEERS"), `对端清单 JSON：[{"url":"https://...","tls_fingerprint":"<hex64>"}]`)
	nodeKey := fs.String("node-key", os.Getenv("BASE_NODE_KEY"), "节点间预共享密钥（头 X-Base-Node-Key）")
	if err := fs.Parse(args); err != nil {
		return err
	}
	peers, err := parsePeers(*peersRaw)
	if err != nil {
		return err
	}

	opts := []store.Option{}
	if strings.TrimSpace(*storeKey) != "" {
		opts = append(opts, store.WithStoreKey(*storeKey))
	}
	st, err := store.Open(*data, opts...)
	if err != nil {
		return err
	}
	defer st.Close()

	plaintext := strings.EqualFold(strings.TrimSpace(*tlsCert), "off")
	certPath, keyPath := strings.TrimSpace(*tlsCert), strings.TrimSpace(*tlsKey)
	if !plaintext {
		if certPath == "" {
			certPath = filepath.Join(*data, "tls", "node.crt")
		}
		if keyPath == "" {
			keyPath = filepath.Join(*data, "tls", "node.key")
		}
	}

	// 节点自身 TLS 身份：主监听与对端监听共用同一张证书。
	// 客户端接口显式降级为明文时，只要启用了 -peer-addr 仍必须生成证书。
	var info httpapi.TLSInfo
	if !plaintext || *peerAddr != "" {
		info, err = httpapi.LoadOrCreateTLSCert(certPath, keyPath)
		if err != nil {
			return err
		}
	}

	// 对端指纹白名单 = -peers 声明的指纹（用于校验入站对端证书）。
	var peerFPs []string
	for _, p := range peers {
		if p.TLSFingerprint != "" {
			peerFPs = append(peerFPs, p.TLSFingerprint)
		}
	}

	srv, err := httpapi.New(st, httpapi.Options{
		Issuer:         *issuer,
		SignKeyHex:     *key,
		Version:        version,
		FingerprintHex: info.FingerprintHex,
		PairingCode:    info.PairingCode,
	})
	if err != nil {
		return err
	}
	if n, err := srv.PruneNonces(); err != nil {
		log.Printf("based: 清理过期 nonce 失败: %v", err)
	} else if n > 0 {
		log.Printf("based: 清理过期 nonce %d 行", n)
	}

	handler := srv.Handler()

	// 对端监听：强制双向 TLS + 指纹固定，可选叠加预共享密钥（契约 6.3）。
	if *peerAddr != "" {
		if len(peerFPs) == 0 {
			return fmt.Errorf("启用 -peer-addr 必须同时配置 -peers：没有对端指纹白名单就无法固定对端身份")
		}
		peerTLS, err := httpapi.ServerTLSConfig(info, peerFPs)
		if err != nil {
			return err
		}
		peerHandler := handler
		if strings.TrimSpace(*nodeKey) != "" {
			peerHandler = srv.RequireNodeKey(*nodeKey, peerHandler)
		}
		ln, err := net.Listen("tcp", *peerAddr)
		if err != nil {
			return err
		}
		peerSrv := &http.Server{Handler: peerHandler, TLSConfig: peerTLS}
		go func() {
			log.Printf("based 对端接口监听 %s（双向 TLS + 指纹固定，白名单 %d 个）", *peerAddr, len(peerFPs))
			if err := peerSrv.ServeTLS(ln, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("based: 对端监听退出: %v", err)
			}
		}()
	}

	base := fmt.Sprintf("issuer=%s source=%v data=%s storeKey=%s…", *issuer, *key != "", *data, shortKey(st.StoreKeyHex()))
	if plaintext {
		log.Printf("based %s 监听 %s（**明文 HTTP**，仅签名头认证；%s）", version, *addr, base)
		return http.ListenAndServe(*addr, handler)
	}

	clientTLS, err := httpapi.ServerTLSConfig(info, nil)
	if err != nil {
		return err
	}
	httpSrv := &http.Server{Addr: *addr, Handler: handler, TLSConfig: clientTLS}
	log.Printf("based %s 监听 %s（TLS；指纹 %s；配对码 %s；%s）",
		version, *addr, info.FingerprintHex, info.PairingCode, base)
	return httpSrv.ListenAndServeTLS("", "")
}

// shortKey 只回显密钥前 8 位 hex，避免完整密钥进日志。
func shortKey(hexKey string) string {
	if len(hexKey) < 8 {
		return "?"
	}
	return hexKey[:8]
}