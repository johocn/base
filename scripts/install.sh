#!/usr/bin/env sh
# base 节点一键安装（册子 §10.2）。与 scripts/install.ps1 参数与步骤逐条一致，顺序固定。
# 不注册服务、不写任何私钥、不动已有 data/ 与 data.key（册子 §10.3、§10.2 第 6 条）。
set -eu

VERSION=""
BASE_URL=""
DIR="./base"
ISSUER="base-node-1"
SOURCE="false"

usage() {
  echo "usage: install.sh --version <ver> --base-url <url|dir> [--dir ./base] [--issuer <id>] [--source]" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)  VERSION="${2:-}"; shift 2 ;;
    --base-url) BASE_URL="${2:-}"; shift 2 ;;
    --dir)      DIR="${2:-}"; shift 2 ;;
    --issuer)   ISSUER="${2:-}"; shift 2 ;;
    --source)   SOURCE="true"; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$VERSION" ] || [ -z "$BASE_URL" ]; then
  usage
  exit 2
fi

# 第 1 步：探测 os / arch → 选定文件名（与 build-release.ps1 的命名一致）
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
  linux) os="linux" ;;
  *) echo "不支持的平台: $os（发行只覆盖 linux/amd64、linux/arm64、windows/amd64）" >&2; exit 1 ;;
esac
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) echo "不支持的架构: $arch" >&2; exit 1 ;;
esac
name="base-v$VERSION-$os-$arch"

fetch() { # fetch <相对名> <输出文件>
  case "$BASE_URL" in
    http://*|https://*) curl -fsSL "$BASE_URL/$1" -o "$2" ;;
    *) cp "$BASE_URL/$1" "$2" ;;
  esac
}

mkdir -p "$DIR"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# 第 2 步：下载二进制与 SHA256SUMS.txt → 校验 SHA256，不符即失败退出（不覆盖已有二进制）
fetch "$name" "$tmp/$name"
fetch "SHA256SUMS.txt" "$tmp/SHA256SUMS.txt"
want=$(awk -v n="$name" '$2==n {print $1}' "$tmp/SHA256SUMS.txt")
if [ -z "$want" ]; then
  echo "SHA256SUMS.txt 中没有 $name" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/$name" | awk '{print $1}')
else
  got=$(shasum -a 256 "$tmp/$name" | awk '{print $1}')
fi
if [ "$got" != "$want" ]; then
  echo "SHA256 校验失败: $name" >&2
  echo "  want=$want" >&2
  echo "  got =$got" >&2
  exit 1
fi

# 第 3+4 步：落地二进制、配置模板、空 data/ 与 data/tls/；data.key 在 data/ 之外
cp "$tmp/$name" "$DIR/based"
chmod 0755 "$DIR/based"
mkdir -p "$DIR/data/tls"
# data.key **不预建**：store 只在「文件不存在」时生成，预建空文件会让首启直接报 `store: empty store key`
# （避免误拷 data/ 的威胁模型下密钥必须在 data/ 之外，见总纲 §7.2）
if [ -f "$DIR/data.key" ]; then
  chmod 0600 "$DIR/data.key"
fi

cat > "$DIR/base.env" <<EOF
# base 节点配置模板（由 install.sh 生成；重复执行会覆盖本文件，自定义项请写进服务单元或 shell profile）
BASE_DATA=$DIR/data
BASE_ADDR=:8080
# 对端监听（节点↔节点）默认不启用：serve 的硬校验是「BASE_PEER_ADDR 非空 ⇒ BASE_PEERS 必须非空」，
# 四个内部接口只挂对端监听、客户端监听上根本不存在。备好对端指纹后按第 5 步写进服务单元再启用。
# BASE_PEER_ADDR=:8081
BASE_ISSUER=$ISSUER
# 客户端监听是否加密：留路径 = TLS（默认）；置 off = 明文 HTTP。
# 客户端↔节点走明文是已定案的退路 F1（总纲 §12.2）：off 只关主监听，节点自身身份仍在，
# 启用对端监听时仍从下面的默认路径加载/生成证书。对端监听（节点↔节点）永远 TLS。
BASE_TLS_CERT=$DIR/data/tls/node.crt
BASE_TLS_KEY=$DIR/data/tls/node.key
BASE_SYNC_INTERVAL=5m
BASE_SCRUB_INTERVAL=24h
BASE_FETCH_MAX_BLOBS=64
# 下面两项是 JSON，且本文件每次执行都会被覆盖（见首行说明），故连同 -peer-addr 一起写在服务单元 ExecStart（见第 5 步）。
#   BASE_PEERS           对端清单，指纹来自对端 \`based tls-cert show -data <对端数据目录>\`
#   BASE_ISSUER_PUBKEYS  签发方公钥信任表（缓存节点必填；唯一信任来源，册子 §6.1）
# 源节点签名私钥种子（仅源节点；本脚本不写任何私钥）：
# BASE_SIGN_KEY=<hex64>
EOF

# 第 5 步：只打印后续人工步骤，不自动写私钥、不注册服务（册子 §10.3）
if [ "$SOURCE" = "true" ]; then
  role="源节点"
else
  role="缓存节点"
fi
cat <<EOF

安装完成：$DIR（角色：$role）

后续人工步骤：
  1) 首启会打印本节点 TLS 指纹与配对码：
       $DIR/based serve -data $DIR/data
  2) 静态加密密钥位于 data/ 之外的 $DIR/data.key（0600），首启自动生成；不要移动或丢失。
  3) 缓存节点：把内容源的签发方公钥写进 BASE_ISSUER_PUBKEYS（唯一信任来源，册子 §6.1）。
  4) 源节点：额外注入签名私钥 BASE_SIGN_KEY；用 \`$DIR/based pubkey -issuer $ISSUER\` 打印对应公钥。
  5) 服务托管请自行配置（脚本不注册服务）。示例（JSON 参数走命令行：单引号内的双引号是字面量）：
       [Service]
       EnvironmentFile=$DIR/base.env
       EnvironmentFile=$DIR/base.secret.env
       ExecStart=$DIR/based serve -peer-addr :8081 -peers '[{"url":"https://<对端IP>:8081","tls_fingerprint":"<对端 hex64>"}]' -issuer-pubkeys '[{"issuer":"<内容源 issuer>","public_key_hex":"<内容源公钥 hex64>"}]'
     不启用对端监听时一并去掉 -peer-addr / -peers / -issuer-pubkeys：ExecStart=$DIR/based serve
     $DIR/base.secret.env 由你自建（0600），只放一行 BASE_SIGN_KEY=<hex64>，仅源节点需要。
EOF