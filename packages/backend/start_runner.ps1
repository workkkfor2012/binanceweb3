param(
    [string]$LogFile
)

# 确保 RUST_LOG_STYLE=never
$Env:RUST_LOG_STYLE = "never"

Write-Host "--- Backend Runner ---" -ForegroundColor Cyan
Write-Host "Target Log File: $LogFile" -ForegroundColor Gray
Write-Host "Starting 'cargo run --release'..." -ForegroundColor Green

# 使用 cmd /c 执行重定向，因为 PowerShell 的重定向有时候会有编码问题
# 并且我们需要 capture stderr
cmd /c "cargo run --release > ""$LogFile"" 2>&1"

# 如果 cargo run 意外退出，保持窗口开启，显示错误
Write-Host "`nProcess exited." -ForegroundColor Yellow
if ($LASTEXITCODE -ne 0) {
    Write-Host "Exited with error code: $LASTEXITCODE" -ForegroundColor Red
}
Read-Host "Press Enter to close window..."
