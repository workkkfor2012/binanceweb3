param (
    [string]$LogFile,
    [string]$Target
)

$ErrorActionPreference = "Continue"

Write-Host "--- Monitor Pane ---" -ForegroundColor Cyan
Write-Host "Monitoring Target: $Target" -ForegroundColor Magenta
Write-Host "Reading Log: $LogFile" -ForegroundColor DarkGray

if (-not (Test-Path $LogFile)) {
    Write-Host "Error: Log file does not exist!" -ForegroundColor Red
    exit 1
}

# 循环读取，带有重试机制
while ($true) {
    try {
        Get-Content $LogFile -Wait -Encoding UTF8 -Tail 100 -ErrorAction Stop | ForEach-Object {
            if ($_ -match [regex]::Escape($Target)) {
                Write-Host $_
            }
        }
    } catch {
        Write-Host "Read error (retrying in 1s): $($_.Exception.Message)" -ForegroundColor Yellow
        Start-Sleep -Seconds 1
    }
}
