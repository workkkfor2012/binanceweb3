# 自动化生成 mkcert 证书
# 检测并安装 mkcert (通过 Chocolatey)
if (!(Get-Command mkcert -ErrorAction SilentlyContinue)) {
    Write-Host "正在安装 mkcert..."
    if (!(Get-Command choco -ErrorAction SilentlyContinue)) {
        Write-Error "请先安装 Chocolatey: https://chocolatey.org/install"
        exit 1
    }
    choco install mkcert -y
}

# 安装本地 CA (首次需要管理员权限)
Write-Host "正在安装本地 CA（可能需要管理员权限）..."
mkcert -install

# 生成证书
$certDir = "packages/backend"
if (!(Test-Path $certDir)) {
    New-Item -ItemType Directory -Path $certDir -Force
}

Write-Host "正在生成证书..."
Set-Location $certDir
mkcert -key-file key.pem -cert-file cert.pem localhost
Set-Location ../..

Write-Host ""
Write-Host "✅ 证书生成成功！" -ForegroundColor Green
Write-Host "   证书位置: packages/backend/cert.pem" -ForegroundColor Cyan
Write-Host "   私钥位置: packages/backend/key.pem" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步：运行 'cd packages\backend && cargo build' 编译后端" -ForegroundColor Yellow
