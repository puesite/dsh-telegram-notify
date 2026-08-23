# dsh-telegram-notify 一键安装脚本
# 用法:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -BotToken "123:abc" -ChatId "123456" -Proxy "http://127.0.0.1:7897" -Profile "web-desktop"

param(
    [string]$BotToken = "",
    [string]$ChatId = "",
    [string]$Proxy = "http://127.0.0.1:7897",
    [string]$Profile = "web-desktop"
)

$ErrorActionPreference = "Stop"

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$scriptRoot = $PSScriptRoot
$pluginSrc = Join-Path $scriptRoot "plugin"
$presetSrc = Join-Path $scriptRoot "preset"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  dsh-telegram-notify 一键安装" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "DSH Home : $dshHome"
Write-Host "Profile  : $Profile"
Write-Host ""

if (-not (Test-Path -LiteralPath $dshHome)) {
    Write-Host "[错误] 找不到 DSH 目录: $dshHome" -ForegroundColor Red
    exit 1
}

if ([string]::IsNullOrWhiteSpace($BotToken)) {
    $BotToken = Read-Host "请输入 Telegram Bot Token"
}
if ([string]::IsNullOrWhiteSpace($ChatId)) {
    $ChatId = Read-Host "请输入你的 Telegram Chat ID"
}
if ([string]::IsNullOrWhiteSpace($BotToken) -or [string]::IsNullOrWhiteSpace($ChatId)) {
    Write-Host "[错误] Bot Token 和 Chat ID 不能为空" -ForegroundColor Red
    exit 1
}

# 1. 安装插件本体
$pluginTarget = Join-Path $dshHome "dsh-telegram-notify"
New-Item -ItemType Directory -Force -Path $pluginTarget | Out-Null
Copy-Item -LiteralPath (Join-Path $pluginSrc "index.js") -Destination (Join-Path $pluginTarget "index.js") -Force
Copy-Item -LiteralPath (Join-Path $pluginSrc "package.json") -Destination (Join-Path $pluginTarget "package.json") -Force

$examplePath = Join-Path $pluginSrc "cordis.patch.yml.example"
$patchTemplate = Get-Content -LiteralPath $examplePath -Raw -Encoding UTF8
$patch = $patchTemplate.Replace("YOUR_BOT_TOKEN", $BotToken).Replace("YOUR_CHAT_ID", $ChatId).Replace("http://127.0.0.1:7897", $Proxy)
[System.IO.File]::WriteAllText((Join-Path $pluginTarget "cordis.patch.yml"), $patch, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[1/4] 插件文件已安装到: $pluginTarget" -ForegroundColor Green

# 2. 安装聊天专用 Agent 预设
$presetTarget = Join-Path $dshHome ".agent-presets\chat-only"
New-Item -ItemType Directory -Force -Path $presetTarget | Out-Null
Copy-Item -LiteralPath (Join-Path $presetSrc "preset.yml") -Destination (Join-Path $presetTarget "preset.yml") -Force
Copy-Item -LiteralPath (Join-Path $presetSrc "agent.cordis.yml") -Destination (Join-Path $presetTarget "agent.cordis.yml") -Force
Write-Host "[2/4] 聊天专用预设已安装到: $presetTarget" -ForegroundColor Green

# 3. 写入 DSH profile（保留已有 bundles）
$profileDir = Join-Path $dshHome "profiles\$Profile"
$pkgPath = Join-Path $profileDir "package.json"
if (-not (Test-Path -LiteralPath $pkgPath)) {
    Write-Host "[错误] 找不到 profile: $Profile ($pkgPath)" -ForegroundColor Red
    exit 1
}

$json = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $json.dependencies) { $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
if (-not $json.dsh) { $json | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
if (-not $json.dsh.profile) { $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
if (-not $json.dsh.profile.bundles) { $json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() }

$linkValue = "link:$($pluginTarget.Replace('\','/'))"
$json.dependencies | Add-Member -NotePropertyName "dsh-telegram-notify" -NotePropertyValue $linkValue -Force
$bundles = @($json.dsh.profile.bundles)
if ($bundles -notcontains "dsh-telegram-notify") {
    $bundles += "dsh-telegram-notify"
}
$json.dsh.profile.bundles = $bundles

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($pkgPath, ($json | ConvertTo-Json -Depth 10), $utf8NoBom)
Write-Host "[3/4] 已写入 profile: $pkgPath" -ForegroundColor Green

# 4. 创建 node_modules 链接
$linkPath = Join-Path $profileDir "node_modules\dsh-telegram-notify"
if (Test-Path -LiteralPath $linkPath) {
    Remove-Item -LiteralPath $linkPath -Force
}
New-Item -ItemType Junction -Path $linkPath -Target $pluginTarget | Out-Null
Write-Host "[4/4] 已创建插件链接: $linkPath" -ForegroundColor Green

Write-Host ""
Write-Host "安装完成！请重启 EAC / DSH Web 后生效。" -ForegroundColor Cyan
Write-Host ""
Write-Host "之后你可以："
Write-Host "  - 在 Telegram 里和 Mocha 聊天"
Write-Host "  - 接收工作完成/出错/批准通知"
Write-Host "  - 在 Telegram 上点按钮批准/拒绝"
Write-Host ""