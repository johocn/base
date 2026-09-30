# D 组自动化门禁复跑脚本（对应手册 #42 §5 与用例表 #43 的 TC-D01–TC-D07）。
# 只在开发机执行；不需部署机、不写业务数据。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/acceptance-d.ps1
# 注意：本文件须存为「带 BOM 的 UTF-8」——PS 5.1 对无 BOM 的 UTF-8 按 ANSI 读，中文注释会把脚本拆坏。
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$mobile = Join-Path $repo "apps/mobile"
$results = [ordered]@{}
$failed = $false

function Assert-Ok([string]$what) {
    if ($LASTEXITCODE -ne 0) { throw "$what 退出码 $LASTEXITCODE" }
}

function Step([string]$id, [scriptblock]$body) {
    Write-Host ""
    Write-Host "== $id ==" -ForegroundColor Cyan
    try {
        & $body
        $script:results[$id] = "PASS"
    }
    catch {
        $script:results[$id] = "FAIL"
        $script:failed = $true
        Write-Host "!! $id : $_" -ForegroundColor Red
        Set-Location $repo
    }
}

Push-Location $repo
try {
    # D1 / TC-D01 Go 全量门禁（AC 1/2/3/4/5/6）
    Step "D1 / TC-D01" {
        go build ./...; Assert-Ok "go build ./..."
        go vet ./...;   Assert-Ok "go vet ./..."
        go test ./...;  Assert-Ok "go test ./..."
    }

    # D2 / TC-D02 契约向量：同一字段集两端一致（AC 1/2）
    Step "D2 / TC-D02" {
        go test ./internal/protocol -run Attr -v; Assert-Ok "go test ./internal/protocol -run Attr"
    }

    # D3 / TC-D03 上传面：幂等 / 超限 413 / 无签名 401 / 读回一致（AC 3）
    Step "D3 / TC-D03" {
        go test ./internal/httpapi -run Blob -v; Assert-Ok "go test ./internal/httpapi -run Blob"
    }

    # D4 / TC-D04 三处保留 seq<0、投稿域跳过（AC 5/6）
    Step "D4 / TC-D04" {
        go test ./internal/importer -run 'Preserve|Submitted' -v; Assert-Ok "go test ./internal/importer -run 'Preserve|Submitted'"
    }

    # D5 / TC-D05 手机端门禁：vitest + tsc + h5 构建（AC 1，TS 侧共读同一向量）
    Step "D5 / TC-D05" {
        Push-Location $mobile
        try {
            npx vitest run;      Assert-Ok "npx vitest run"
            npx tsc --noEmit;    Assert-Ok "npx tsc --noEmit"
            npm run build:h5;    Assert-Ok "npm run build:h5"
        }
        finally { Pop-Location }
    }

    # D6 / TC-D06 发布前硬检查：模板不得出现 .value（必须无输出；#31 更正 14 的教训）
    Step "D6 / TC-D06" {
        $files = @(Get-ChildItem -Path (Join-Path $repo "apps/mobile/src/pages/*/*.vue"))
        if ($files.Count -eq 0) { throw "未匹配到 apps/mobile/src/pages/*/*.vue，检查路径" }
        $hits = @($files | Select-String -Pattern '="[^"]*\.value|\{\{[^}]*\.value')
        if ($hits.Count -gt 0) {
            $hits | ForEach-Object {
                Write-Host ("  {0}:{1}: {2}" -f $_.Path, $_.LineNumber, $_.Line.Trim()) -ForegroundColor Red
            }
            throw "模板 .value 硬检查命中 $($hits.Count) 处（必须无输出）"
        }
        Write-Host ("  扫描 {0} 个 .vue，无命中" -f $files.Count)
    }

    # D7 / TC-D07 源码树须含 8f969d3 及其全部祖先
    Step "D7 / TC-D07" {
        git log --oneline -1; Assert-Ok "git log"
        git merge-base --is-ancestor 8f969d3 HEAD
        Assert-Ok "8f969d3 不是 HEAD 的祖先（打包源码树缺本次交付）"
    }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "== D 组结果（可直接填入用例表 #43 §4）==" -ForegroundColor Cyan
foreach ($k in $results.Keys) {
    $color = if ($results[$k] -eq "PASS") { "Green" } else { "Red" }
    Write-Host ("  {0,-14} {1}" -f $k, $results[$k]) -ForegroundColor $color
}

if ($failed) { exit 1 }
Write-Host "TC-D01–TC-D07 全绿" -ForegroundColor Green