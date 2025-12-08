$ErrorActionPreference = "Stop"

$workDir = $PSScriptRoot
$logFile = Join-Path $workDir "app.log"
$slotsFile = Join-Path $workDir "slots.json"
$runnerScript = Join-Path $workDir "start_runner.ps1"
$slotScript = Join-Path $workDir "monitor_slot.ps1"

# --- 清理环境 ---
Get-Process -Name "backend" -ErrorAction SilentlyContinue | Stop-Process -Force

# --- 初始化 (8个 Slot: 2x4) ---
try { "" | Set-Content $logFile -Force } catch { exit 1 }

$initialSlots = [ordered]@{}
for ($i=1; $i -le 8; $i++) {
    $initialSlots["Slot_$i"] = ""
}
$initialSlots | ConvertTo-Json | Set-Content $slotsFile -Encoding UTF8

Write-Host "🔥 启动 2x4 稳定网格监控 (8窗口)..." -ForegroundColor Cyan

# --- 构建 2x4 等宽布局 ---
# 策略: 先分出4个等宽列，再每列上下分
# 1. Start (Slot_1) [100%]
# 2. Split V (Slot_3) -> [50% | 50%]
# 3. Focus Left. Split V (Slot_2) -> [25% | 25% | 50%]
# 4. Focus Right (Skip Slot_2, go to Slot_3). Split V (Slot_4) -> [25% | 25% | 25% | 25%]
# 此时有4列: Slot_1, Slot_2, Slot_3, Slot_4

# 5. Focus 4. Split H (Slot_8)
# 6. Focus Left (3). Split H (Slot_7)
# 7. Focus Left (2). Split H (Slot_6)
# 8. Focus Left (1). Split H (Slot_5)

$wtArgs = @()

# 1. Tab Start (Slot_1)
$wtArgs += "new-tab"; $wtArgs += "--title"; $wtArgs += "Monitor_Grid"
$wtArgs += "-d"; $wtArgs += "$workDir"; $wtArgs += "powershell"; $wtArgs += "-NoExit"; $wtArgs += "-File"; $wtArgs += $slotScript; $wtArgs += "-SlotName"; $wtArgs += "Slot_1"; $wtArgs += "-SlotsFile"; $wtArgs += $slotsFile; $wtArgs += "-LogFile"; $wtArgs += $logFile; $wtArgs += ";"

# 2. Split V -> Slot_3 (原本想叫Slot_3，为了逻辑清晰先叫 Slot_3_Temp)
# 此时界面: [Slot_1 | Slot_3]
$wtArgs += "split-pane"; $wtArgs += "-V"
$wtArgs += "-d"; $wtArgs += "$workDir"; $wtArgs += "powershell"; $wtArgs += "-NoExit"; $wtArgs += "-File"; $wtArgs += $slotScript; $wtArgs += "-SlotName"; $wtArgs += "Slot_3"; $wtArgs += "-SlotsFile"; $wtArgs += $slotsFile; $wtArgs += "-LogFile"; $wtArgs += $logFile; $wtArgs += ";"

# 3. Focus Left -> Back to Slot_1
$wtArgs += "move-focus"; $wtArgs += "left"; $wtArgs += ";"

# 4. Split V -> Slot_2 (Insert between 1 and 3)
# 此时界面: [Slot_1 | Slot_2 | Slot_3]
$wtArgs += "split-pane"; $wtArgs += "-V"
$wtArgs += "-d"; $wtArgs += "$workDir"; $wtArgs += "powershell"; $wtArgs += "-NoExit"; $wtArgs += "-File"; $wtArgs += $slotScript; $wtArgs += "-SlotName"; $wtArgs += "Slot_2"; $wtArgs += "-SlotsFile"; $wtArgs += $slotsFile; $wtArgs += "-LogFile"; $wtArgs += $logFile; $wtArgs += ";"

# 5. Focus Right -> Go to Slot_3
# 此时焦点在 Slot_2。右边是 Slot_3。
$wtArgs += "move-focus"; $wtArgs += "right"; $wtArgs += ";"

# 6. Split V -> Slot_4 (Right of 3)
# 此时界面: [Slot_1 | Slot_2 | Slot_3 | Slot_4] (全等宽)
$wtArgs += "split-pane"; $wtArgs += "-V"
$wtArgs += "-d"; $wtArgs += "$workDir"; $wtArgs += "powershell"; $wtArgs += "-NoExit"; $wtArgs += "-File"; $wtArgs += $slotScript; $wtArgs += "-SlotName"; $wtArgs += "Slot_4"; $wtArgs += "-SlotsFile"; $wtArgs += $slotsFile; $wtArgs += "-LogFile"; $wtArgs += $logFile; $wtArgs += ";"

# --- 开始切分第二行 ---
# 此时焦点在 Slot_4 (最右)

# 7. Slot_4 Split H -> Slot_8
$wtArgs += "split-pane"; $wtArgs += "-H"
$wtArgs += "-d"; $wtArgs += "$workDir"; $wtArgs += "powershell"; $wtArgs += "-NoExit"; $wtArgs += "-File"; $wtArgs += $slotScript; $wtArgs += "-SlotName"; $wtArgs += "Slot_8"; $wtArgs += "-SlotsFile"; $wtArgs += $slotsFile; $wtArgs += "-LogFile"; $wtArgs += $logFile; $wtArgs += ";"

# 上一步切分后焦点在 Slot_8 (右下角)
# 8. Move Left -> Slot_7 (Expected position under Slot_3)
# 但是 wait，左边目前是 Slot_3（全高）。
# 移动左边会到 Slot_3。
$wtArgs += "move-focus"; $wtArgs += "left"; $wtArgs += ";"

# 9. Slot_3 Split H -> Slot_7
$wtArgs += "split-pane"; $wtArgs += "-H"
$wtArgs += "-d"; $wtArgs += "$workDir"; $wtArgs += "powershell"; $wtArgs += "-NoExit"; $wtArgs += "-File"; $wtArgs += $slotScript; $wtArgs += "-SlotName"; $wtArgs += "Slot_7"; $wtArgs += "-SlotsFile"; $wtArgs += $slotsFile; $wtArgs += "-LogFile"; $wtArgs += $logFile; $wtArgs += ";"

# 10. Move Left -> Slot_2
$wtArgs += "move-focus"; $wtArgs += "left"; $wtArgs += ";"

# 11. Slot_2 Split H -> Slot_6
$wtArgs += "split-pane"; $wtArgs += "-H"
$wtArgs += "-d"; $wtArgs += "$workDir"; $wtArgs += "powershell"; $wtArgs += "-NoExit"; $wtArgs += "-File"; $wtArgs += $slotScript; $wtArgs += "-SlotName"; $wtArgs += "Slot_6"; $wtArgs += "-SlotsFile"; $wtArgs += $slotsFile; $wtArgs += "-LogFile"; $wtArgs += $logFile; $wtArgs += ";"

# 12. Move Left -> Slot_1
$wtArgs += "move-focus"; $wtArgs += "left"; $wtArgs += ";"

# 13. Slot_1 Split H -> Slot_5
$wtArgs += "split-pane"; $wtArgs += "-H"
$wtArgs += "-d"; $wtArgs += "$workDir"; $wtArgs += "powershell"; $wtArgs += "-NoExit"; $wtArgs += "-File"; $wtArgs += $slotScript; $wtArgs += "-SlotName"; $wtArgs += "Slot_5"; $wtArgs += "-SlotsFile"; $wtArgs += $slotsFile; $wtArgs += "-LogFile"; $wtArgs += $logFile; $wtArgs += ";"

# --- Tab 2: Runner ---
$wtArgs += "new-tab"
$wtArgs += "--title", "Rust_Runner"
$wtArgs += "-d", "$workDir"
$wtArgs += "powershell"
$wtArgs += "-NoExit"
$wtArgs += "-File", $runnerScript, "-LogFile", $logFile
$wtArgs += ";"

Start-Process wt -ArgumentList $wtArgs

# --- Coordinator Loop ---
$seenTargets = @{}
$targetPrefix = "backend" 

Write-Host "Monitoring started (2x4 Grid). Close to stop assignment." -ForegroundColor Green
Write-Host "Tip: Press [Ctrl] + [-] (Minus) or use [Ctrl] + [Mouse Wheel] to zoom out and reduce font size." -ForegroundColor Yellow

Get-Content $logFile -Wait -Encoding UTF8 | ForEach-Object {
    $line = $_
    $cleanLine = $line -replace "`e\[[0-9;]*m", ""
    
    # 打印 Raw 以便调试
    if (-not [string]::IsNullOrWhiteSpace($cleanLine)) {
        Write-Host "Raw: $cleanLine" -ForegroundColor DarkGray
    }
    
    if ($cleanLine -match "(${targetPrefix}::[a-zA-Z0-9_]+)") {
        $target = $matches[1]
        
        if (-not $seenTargets.ContainsKey($target)) {
            $seenTargets[$target] = $true
            
            $slots = Get-Content $slotsFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $assigned = $false
            
            foreach ($prop in $slots.PSObject.Properties) {
                if ([string]::IsNullOrWhiteSpace($prop.Value)) {
                    Write-Host "Assigning [$target] -> $($prop.Name)" -ForegroundColor Magenta
                    $slots.($prop.Name) = $target
                    $assigned = $true
                    break
                }
            }
            
            if ($assigned) {
                $slots | ConvertTo-Json | Set-Content $slotsFile -Encoding UTF8
            }
        }
    }
}
