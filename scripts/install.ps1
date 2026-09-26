# base 节点一键安装（册子 §10.2）。与 scripts/install.sh 参数与步骤逐条一致，顺序固定。
# 不注册服务、不写任何私钥、不动已有 data/ 与 data.key（册子 §10.3、§10.2 第 6 条）。
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [string]$Dir = "./base",
    [string]$Issuer = "base-node-1",
    [switch]$Source
)

$ErrorActionPreference = "Stop"

# 第 1 步：探测 os / arch → 选定文件名（与 build-release.ps1 的命名一致）
$os = "windows"
switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
    "X64" { $arch = "amd64" }
    "Arm64" { $arch = "arm64" }
    default { throw "不支持的架构: $($_)" }
}
$name = "base-v$Version-$os-$arch.exe"

function Fetch([string]$rel, [string]$out) {
    if ($BaseUrl -match '^https?://') {
        Invoke-WebRequest -Uri "$BaseUrl/$rel" -OutFile $out -UseBasicParsing
    } else {
        Copy-Item -Path (Join-Path $BaseUrl $rel) -Destination $out -Force
    }
}

$dirPath = (New-Item -ItemType Directory -Force -Path $Dir).FullName
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("base-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    # 第 2 步：下载二进制与 SHA256SUMS.txt → 校验 SHA256，不符即失败退出（不覆盖已有二进制）
    $binTmp = Join-Path $tmp $name
    $sumsTmp = Join-Path $tmp "SHA256SUMS.txt"
    Fetch $name $binTmp
    Fetch "SHA256SUMS.txt" $sumsTmp

    $want = Get-Content $sumsTmp |
        ForEach-Object { $p = $_ -split '\s+'; if ($p.Count -ge 2 -and $p[1] -eq $name) { $p[0] } } |
        Select-Object -First 1
    if (-not $want) { throw "SHA256SUMS.txt 中没有 $name" }
    $got = (Get-FileHash -Algorithm SHA256 -Path $binTmp).Hash.ToLower()
    if ($got -ne $want) { throw "SHA256 校验失败: $name`n  want=$want`n  got =$got" }

    # 第 3+4 步：落地二进制、配置模板、空 data/ 与 data/tls/；data.key 在 data/ 之外
    Copy-Item -Path $binTmp -Destination (Join-Path $dirPath "based.exe") -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $dirPath "data/tls") | Out-Null

    $keyPath = Join-Path $dirPath "data.key"
    if (-not (Test-Path $keyPath)) { New-Item -ItemType File -Path $keyPath -Force | Out-Null }

    $envPath = Join-Path $dirPath "base.env"
    @"
# base 节点配置模板（由 install.ps1 生成；重复执行会覆盖本文件，自定义项请写进服务单元或系统环境变量）
BASE_DATA=$dirPath\data
BASE_ADDR=:8080
BASE_PEER_ADDR=:8081
BASE_ISSUER=$Issuer
BASE_TLS_CERT=$dirPath\data\tls\node.crt
BASE_TLS_KEY=$dirPath\data\tls\node.key
BASE_SYNC_INTERVAL=5m
BASE_SCRUB_INTERVAL=24h
BASE_FETCH_MAX_BLOBS=64
# 对端清单（指纹来自对端的 based tls-cert show -data <对端数据目录>）：
# BASE_PEERS=[{"url":"https://127.0.0.1:8081","tls_fingerprint":"<hex64>"}]
# 签发方公钥信任表（缓存节点必填；唯一信任来源，册子 §6.1）：
# BASE_ISSUER_PUBKEYS=[{"issuer":"$Issuer","public_key_hex":"<64 hex>"}]
# 源节点签名私钥种子（仅源节点；本脚本不写任何私钥）：
# BASE_SIGN_KEY=<hex64>
"@ | Set-Content -Path $envPath -Encoding utf8

    # 第 5 步：只打印后续人工步骤，不自动写私钥、不注册服务（册子 §10.3）
    $role = if ($Source) { "源节点" } else { "缓存节点" }
    Write-Host ""
    Write-Host "安装完成：$dirPath（角色：$role）"
    Write-Host ""
    Write-Host "后续人工步骤："
    Write-Host "  1) 首启会打印本节点 TLS 指纹与配对码："
    Write-Host "       $dirPath\based.exe serve -data $dirPath\data"
    Write-Host "  2) 静态加密密钥位于 data/ 之外的 $dirPath\data.key，首启自动生成；不要移动或丢失。"
    Write-Host "  3) 缓存节点：把内容源的签发方公钥写进 BASE_ISSUER_PUBKEYS（唯一信任来源，册子 §6.1）。"
    Write-Host "  4) 源节点：额外注入签名私钥 BASE_SIGN_KEY；用 based pubkey -issuer <id> 打印对应公钥。"
    Write-Host "  5) 服务托管请自行配置（脚本不注册服务）。"
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}