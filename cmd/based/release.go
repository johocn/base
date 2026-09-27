package main

import (
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/johocn/base/internal/protocol"
)

// runRelease 用源节点私钥签发 release 文档（spec §8.3）。
// -apk-file 用于计算 apk_size 与 apk_sha256，避免手填出错。
// -min-version-name 刻意不给默认值：它进签名载荷，一旦签高会让所有老客户端立刻被强更拦住（spec §11 风险 3）。
func runRelease(args []string) error {
	fs := flag.NewFlagSet("release", flag.ExitOnError)
	versionName := fs.String("version-name", "", "最新版本名 x.y.z（必填）")
	minVersionName := fs.String("min-version-name", "", "最低可用版本 x.y.z（必填；高于客户端本地版本即强制更新）")
	apkURL := fs.String("apk-url", "", "APK 下载地址，绝对 URL（必填）")
	apkFile := fs.String("apk-file", "", "本地 APK 路径（必填，用于算 size 与 sha256）")
	notes := fs.String("notes", "", "版本说明（允许中文，参与签名）")
	out := fs.String("out", "", "输出路径；空 = <data>/release.json")
	data := fs.String("data", envOr("BASE_DATA", "data"), "数据目录")
	issuer := fs.String("issuer", envOr("BASE_ISSUER", "base-node-1"), "签发方标识")
	key := fs.String("sign-key", os.Getenv("BASE_SIGN_KEY"), "Ed25519 私钥种子（hex64）；与签发 manifest 同一把")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *versionName == "" || *minVersionName == "" || *apkURL == "" || *apkFile == "" {
		return fmt.Errorf("release: -version-name、-min-version-name、-apk-url、-apk-file 均为必填")
	}
	if *key == "" {
		return fmt.Errorf("release: 缺少 -sign-key（或环境变量 BASE_SIGN_KEY）：没有私钥不能签发升级文档")
	}
	size, sum, err := fileSHA256(*apkFile)
	if err != nil {
		return fmt.Errorf("release: 读取 APK 失败: %w", err)
	}
	doc := protocol.ReleaseDoc{Payload: protocol.ReleasePayload{
		SchemaVersion:  1,
		Issuer:         *issuer,
		IssuedAt:       time.Now().UTC().Format("2006-01-02T15:04:05Z"),
		VersionName:    *versionName,
		MinVersionName: *minVersionName,
		ApkURL:         *apkURL,
		ApkSize:        size,
		ApkSHA256:      sum,
		Notes:          *notes,
	}}
	if err := doc.SignWith(*key); err != nil {
		return err
	}
	raw, err := doc.MarshalCanonical()
	if err != nil {
		return err
	}
	path := *out
	if path == "" {
		path = filepath.Join(*data, "release.json")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		return err
	}
	kp, err := protocol.KeyPairFromSeed(*key)
	if err != nil {
		return err
	}
	fmt.Printf("release: version_name=%s min_version_name=%s → %s\n", *versionName, *minVersionName, path)
	fmt.Printf("  apk_size=%d apk_sha256=%s\n", size, sum)
	fmt.Printf("  public_key   %s\n", kp.PubHex)
	return nil
}

func fileSHA256(path string) (int64, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return 0, "", err
	}
	return n, hex.EncodeToString(h.Sum(nil)), nil
}
