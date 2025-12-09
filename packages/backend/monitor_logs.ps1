$ErrorActionPreference = "Stop"

# 获取脚本所在目录作为基准
$workDir = $PSScriptRoot
$logFile = Join-Path $workDir "app.log"

# 初始化/清空日志文件，确保文件存在，防止 Get-Content 报错
"" | Set-Content $logFile -Force

Write-Host "正在启动 Rust 后端监控面板..."
Write-Host "工作目录: $workDir"
Write-Host "日志文件: $logFile"

# 定义查看命令生成函数
function Get-MonitorCmd($title, $pattern) {
    # 打印标题，然后持续读取日志并过滤高亮
    # Select-String 默认会高亮匹配项
    return "Write-Host 'Monitoring: $title' -ForegroundColor Cyan; Get-Content '$logFile' -Wait -Tail 20 | Select-String '$pattern'"
}

# 定义各个窗格的命令
# 1. 运行器: 负责运行 cargo run 并将输出重定向到文件
# 使用 cmd /c 运行以确保重定向编码(UTF-8)处理更稳定，且保留原始输出
# 2>&1 确保错误日志也被捕获
# 注意: 我们将在 wt 中直接调用 cmd，所以这里只需准备命令字符串
$cmdRunner = "cargo run  > ""$logFile"" 2>&1"

# 2. 各个监控过滤命令
$cmdSocket  = Get-MonitorCmd "Socket Handlers" "socket_handlers"
$cmdBinance = Get-MonitorCmd "Binance Task" "binance_task"
$cmdKline   = Get-MonitorCmd "Kline Handler" "kline_handler"
$cmdWarn    = Get-MonitorCmd "Warnings/Errors" "WARN|ERROR"

# 构建 wt (Windows Terminal) 参数列表
# 使用分号 ; 分隔不同的 wt 操作
$wtArgs = @()

# --- Tab 1: 运行器 ---
$wtArgs += "new-tab"
$wtArgs += "--title", "Rust Backend Runner"
$wtArgs += "-d", "$workDir"
# 使用 cmd 防止 PowerShell 编码干扰
$wtArgs += "cmd"
$wtArgs += "/k" 
$wtArgs += "$cmdRunner"
$wtArgs += ";"

# --- Tab 2: 监控面板 (2x2 布局) ---
# 1. 创建新标签页，作为左上角 (Pane 1: Socket)
$wtArgs += "new-tab"
$wtArgs += "--title", "Log Monitor"
$wtArgs += "-d", "$workDir"
$wtArgs += "powershell"
$wtArgs += "-NoExit"
$wtArgs += "-Command", "$cmdSocket"
$wtArgs += ";"

# 2. 水平分割 (Split Horizontal) -> 下方窗格 (Pane 3: Kline)
# 此时焦点在 下方 (Pane 3)
$wtArgs += "split-pane"
$wtArgs += "-H"
$wtArgs += "-d", "$workDir"
$wtArgs += "powershell"
$wtArgs += "-NoExit"
$wtArgs += "-Command", "$cmdKline"
$wtArgs += ";"

# 3. 移动焦点回到 上方 (Pane 1)
$wtArgs += "move-focus"
$wtArgs += "up"
$wtArgs += ";"

# 4. 垂直分割 (Split Vertical) -> 右侧窗格 (Pane 2: Binance)
# 此时焦点在 右上 (Pane 2)
$wtArgs += "split-pane"
$wtArgs += "-V"
$wtArgs += "-d", "$workDir"
$wtArgs += "powershell"
$wtArgs += "-NoExit"
$wtArgs += "-Command", "$cmdBinance"
$wtArgs += ";"

# 5. 移动焦点到 下方左侧? 不，我们需要在 Pane 3 的右侧建立 Pane 4
# 目前布局:
# [ Socket  | Binance ]
# [ Kline   ]
# 之前的 Kline 是全宽的吗？
# 当我们在 Pane 1 做 Split-H 时，Pane 1 变成了 上下两个。
# [ Socket ]
# [ Kline  ]
# 此时都是 100% 宽。
# 然后 Move Up 到 Socket。
# Split V。
# [ Socket | Binance ]
# [ Kline            ]
# Kline 仍然是全宽。
# 我们希望 Kline 也是半宽，或者 Warn 在 Kline 右侧。
# 所以我们需要定位到 Kline，然后 Split V。

# 修正：
# 6. 移动焦点到 下方 (Kline)
$wtArgs += "move-focus"
$wtArgs += "down"
$wtArgs += ";"

# 7. 垂直分割 (Split Vertical) -> 右下窗格 (Pane 4: Warn)
$wtArgs += "split-pane"
$wtArgs += "-V"
$wtArgs += "-d", "$workDir"
$wtArgs += "powershell"
$wtArgs += "-NoExit"
$wtArgs += "-Command", "$cmdWarn"

# 执行 wt 命令
Write-Host "Launching Windows Terminal..."
Start-Process wt -ArgumentList $wtArgs
