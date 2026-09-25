# 交叉编译 base 节点发行二进制。只在开发机执行；
# 服务器/贡献者只接收二进制，禁止在部署机 go build（见 spec §7.6）。
param(
    [string]$Version = "0.1.0",
    [string]$OutDir = "dist"
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
    if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
    New-Item -ItemType Directory -Path $OutDir | Out-Null

    $env:CGO_ENABLED = "0"          # 纯 Go SQLite，必须关掉 CGO 才能静态交叉编译
    $targets = @(
        @{ OS = "linux";   Arch = "amd64" },
        @{ OS = "linux";   Arch = "arm64" },
        @{ OS = "windows"; Arch = "amd64" }
    )

    $lines = @()
    foreach ($t in $targets) {
        $ext = ""
        if ($t.OS -eq "windows") { $ext = ".exe" }
        $name = "base-v$Version-$($t.OS)-$($t.Arch)$ext"
        $out = Join-Path $OutDir $name

        $env:GOOS = $t.OS
        $env:GOARCH = $t.Arch
        Write-Host "building $name"
        go build -trimpath -ldflags "-s -w -X main.version=$Version" -o $out ./cmd/based
        if ($LASTEXITCODE -ne 0) { throw "go build 失败: $name" }

        $item = Get-Item $out
        $hash = (Get-FileHash -Algorithm SHA256 -Path $out).Hash.ToLower()
        $lines += "$hash  $name"
        Write-Host ("  {0} bytes  sha256={1}" -f $item.Length, $hash)
    }

    $sums = Join-Path $OutDir "SHA256SUMS.txt"
    [System.IO.File]::WriteAllText($sums, ($lines -join "`n") + "`n")

    Write-Host ""
    Write-Host "SHA256SUMS.txt"
    Get-Content $sums
}
finally {
    Remove-Item Env:GOOS   -ErrorAction SilentlyContinue
    Remove-Item Env:GOARCH -ErrorAction SilentlyContinue
    Pop-Location
}