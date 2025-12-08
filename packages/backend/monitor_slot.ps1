param (
    [string]$SlotName,
    [string]$SlotsFile,
    [string]$LogFile
)

$ErrorActionPreference = "Stop"
$currentEncoding = [System.Text.Encoding]::UTF8

function Read-Slots {
    try {
        if (Test-Path $SlotsFile) {
            $json = Get-Content $SlotsFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
            if ($json) { return $json | ConvertFrom-Json }
        }
    } catch {
        # Ignore read errors (file lock contention)
    }
    return $null
}


Write-Host "--- Slot: $SlotName ---" -ForegroundColor Cyan
Write-Host "Waiting for assignment..." -ForegroundColor DarkGray

$currentTarget = $null
$hb = 0

while ($true) {
    # Heartbeat visualization
    if ($hb++ % 5 -eq 0) { Write-Host "." -NoNewline -ForegroundColor DarkGray }

    # 1. 如果还没有目标，轮询 slots.json
    if (-not $currentTarget) {
        $slots = Read-Slots
        
        # Verbose Debug (Only if successful read)
        # if ($slots) { Write-Host "`n[Debug] Read Slots: $($slots | ConvertTo-Json -Compress)" -ForegroundColor Gray }
        
        if ($slots) {
            # 尝试多种属性访问方式
            $assigned = $null
            
            # 方法 A: 动态属性
            try { $assigned = $slots.$SlotName } catch {}
            
            # 方法 B: PSObject 查找
            if (-not $assigned) {
                foreach ($p in $slots.PSObject.Properties) {
                    if ($p.Name -eq $SlotName) { $assigned = $p.Value; break }
                }
            }

            if (-not [string]::IsNullOrWhiteSpace($assigned)) {
                $currentTarget = $assigned
                Write-Host "`n" # Newline after dots
                Write-Host "--- Monitoring Assigned: $currentTarget ---" -ForegroundColor Green
            }
        }
        
        if (-not $currentTarget) {
            Start-Sleep -Seconds 1
            continue
        }
    }

    # 2. 有目标后，开始监控日志
    # 注意：这里我们进入一个内部循环来 tail 日志
    # 如果未来需要支持"换台"，则需要更复杂的逻辑 (如 Tail -NoWait + Sleep)。
    # 目前简化版：一旦分配，这就定死，直到窗口关闭。
    
    try {
        Write-Host "Starting log stream..." -ForegroundColor Gray
        
        # 使用类似于 monitor_pane.ps1 的 robust 循环
        # 注意: Get-Content -Wait 会阻塞，所以我们无法轻易"退出"去检查 slots.json 的变化
        # 这符合 V1 设计：一个 Slot 分配一个 Target 后就不变了。
        Get-Content $LogFile -Wait -Encoding UTF8 -Tail 100 -ErrorAction Stop | ForEach-Object {
            if ($_ -match [regex]::Escape($currentTarget)) {
                Write-Host $_
            }
        }
    } catch {
        Write-Host "Stream error: $_" -ForegroundColor Red
        Write-Host "Retrying in 2s..." -ForegroundColor Yellow
        Start-Sleep -Seconds 2
    }
}
