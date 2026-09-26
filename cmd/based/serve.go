package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/johocn/base/internal/httpapi"
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
	pf := registerPeerFlags(fs)
	addr := fs.String("addr", envOr("BASE_ADDR", ":8080"), "客户端接口监听地址")
	issuer := fs.String("issuer", envOr("BASE_ISSUER", "base-node-1"), "签发方标识")
	key := fs.String("sign-key", os.Getenv("BASE_SIGN_KEY"), "Ed25519 私钥种子（hex64）；配置了才是源节点")
	peerAddr := fs.String("peer-addr", envOr("BASE_PEER_ADDR", ""), "节点↔节点监听地址；空=不启用")
	if err := fs.Parse(args); err != nil {
		return err
	}
	peers, err := pf.peers()
	if err != nil {
		return err
	}

	st, err := pf.openStore()
	if err != nil {
		return err
	}
	defer st.Close()

	plaintext := strings.EqualFold(strings.TrimSpace(*pf.tlsCert), "off")
	certPath, keyPath := pf.certPaths()

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
		FetchMaxBlobs:  *pf.fetchMaxBlobs,
	})
	if err != nil {
		return err
	}
	if n, err := srv.PruneNonces(); err != nil {
		log.Printf("based: 清理过期 nonce 失败: %v", err)
	} else if n > 0 {
		log.Printf("based: 清理过期 nonce %d 行", n)
	}

	// 客户端监听：只有公开路由；对端监听：公开路由 ∪ 内部路由（册子 §5.1）。
	publicHandler := srv.Handler()
	peerHandler := srv.PeerHandler()

	if *peerAddr != "" {
		if len(peerFPs) == 0 {
			return fmt.Errorf("启用 -peer-addr 必须同时配置 -peers：没有对端指纹白名单就无法固定对端身份")
		}
		peerTLS, err := httpapi.ServerTLSConfig(info, peerFPs)
		if err != nil {
			return err
		}
		peerWithKey := peerHandler
		if strings.TrimSpace(*pf.nodeKey) != "" {
			peerWithKey = srv.RequireNodeKey(*pf.nodeKey, peerHandler)
		}
		ln, err := net.Listen("tcp", *peerAddr)
		if err != nil {
			return err
		}
		peerSrv := &http.Server{Handler: peerWithKey, TLSConfig: peerTLS}
		go func() {
			log.Printf("based 对端接口监听 %s（双向 TLS + 指纹固定，白名单 %d 个）", *peerAddr, len(peerFPs))
			if err := peerSrv.ServeTLS(ln, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("based: 对端监听退出: %v", err)
			}
		}()
	}

	// 反熵调度器：只有配置了 -peers 才启动（册子 §7.1）。
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if len(peers) > 0 {
		syncEvery, scrubEvery, err := pf.durations()
		if err != nil {
			return err
		}
		peerCfg, err := pf.config(info)
		if err != nil {
			return err
		}
		peerCfg.RunForever(ctx, st, peers, syncEvery, logf)
		log.Printf("based: 反熵调度已启动（%d 个对端，间隔 %s）", len(peers), syncEvery)
		peerCfg.ScrubForever(ctx, st, peers, scrubEvery, logf)
		log.Printf("based: scrub 调度已启动（间隔 %s，首轮延迟 10 分钟）", scrubEvery)
	}

	base := fmt.Sprintf("issuer=%s source=%v data=%s storeKey=%s…", *issuer, *key != "", *pf.data, shortKey(st.StoreKeyHex()))
	if plaintext {
		log.Printf("based %s 监听 %s（**明文 HTTP**，仅签名头认证；%s）", version, *addr, base)
		return serveUntil(ctx, *addr, publicHandler)
	}

	clientTLS, err := httpapi.ServerTLSConfig(info, nil)
	if err != nil {
		return err
	}
	log.Printf("based %s 监听 %s（TLS；指纹 %s；配对码 %s；%s）",
		version, *addr, info.FingerprintHex, info.PairingCode, base)
	return serveTLSUntil(ctx, *addr, publicHandler, clientTLS)
}

// serveUntil 起主监听并在 ctx 取消时优雅关停。
func serveUntil(ctx context.Context, addr string, h http.Handler) error {
	srv := &http.Server{Addr: addr, Handler: h}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// serveTLSUntil 同上，带 TLS 配置。
func serveTLSUntil(ctx context.Context, addr string, h http.Handler, tlsCfg *tls.Config) error {
	srv := &http.Server{Addr: addr, Handler: h, TLSConfig: tlsCfg}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	if err := srv.ListenAndServeTLS("", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// shortKey 只回显密钥前 8 位 hex，避免完整密钥进日志。
func shortKey(hexKey string) string {
	if len(hexKey) < 8 {
		return "?"
	}
	return hexKey[:8]
}
