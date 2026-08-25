<div align="center">

# 🐱 dsh-telegram-notify

**让 DeepSeek Harness / EAC 通过 Telegram 通知你、陪你聊天、让你远程批准**

![Version](https://img.shields.io/badge/version-0.4.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![DSH](https://img.shields.io/badge/DSH-Plugin-orange)
![Telegram](https://img.shields.io/badge/Telegram-Bot-2CA5E0)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D6)

</div>

---

## ✨ 功能一览

| 功能 | 说明 |
|---|---|
| 🔔 **Telegram 远程批准** | 需要权限时，手机点 `✅ 批准 / ❌ 拒绝` 即可 |
| ✅ **工作完成通知** | 任务跑完自动推送到 Telegram |
| ❌ **出错通知** | 工具报错时第一时间告诉你 |
| 💬 **猫娘聊天** | 在 Telegram 里和 Mocha 聊天 |
| 🚫 **禁止远程派活** | Telegram 只能聊天/审批，不能执行工作 |
| 🔒 **单人独占** | 只允许你的 Chat ID 使用 |

---

## 🚀 快速开始

### 一键安装（Windows）

```powershell
# 1. 下载 / Clone 本仓库
# 2. 双击 install.bat
# 3. 输入 Bot Token / Chat ID / 代理
# 4. 重启 EAC
```

或命令行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  -BotToken "123456789:ABC..." `
  -ChatId "123456789" `
  -Proxy "http://127.0.0.1:7897" `
  -Profile "web-desktop"
```

> 普通 DSH Web 用户把 `-Profile` 改成 `web`。

---

## 📦 目录结构

```text
dsh-telegram-notify/
├── install.bat                 # 双击一键安装
├── install.ps1                 # 一键安装脚本
├── README.md                   # 本教程
├── LICENSE
├── plugin/                     # DSH 插件本体
│   ├── index.js
│   ├── package.json
│   └── cordis.patch.yml.example
└── preset/                     # Telegram 聊天专用 Agent 预设
    ├── preset.yml
    └── agent.cordis.yml
```

---

## 🤖 准备 Telegram Bot

1. Telegram 搜索 `@BotFather`
2. 发送 `/newbot`
3. 按提示设置名称和用户名
4. 拿到 **Bot Token**
5. 打开你的 Bot，点 `Start`
6. 获取你的 **Chat ID**（可用 `@userinfobot`）

---

## 📱 使用说明

### 聊天

直接给 Bot 发消息即可。

| 命令 | 说明 |
|---|---|
| `/start` / `/help` | 显示帮助 |
| `/menu` | 打开高级 UI 主菜单 |
| `/status` | 查看 DSH 当前状态、最近完成/错误 |
| `/stats` | 今日统计：运行时长、完成任务、工具调用、错误 |
| `/daily` | 今日日报（也可每天自动推送） |
| `/notify on/off` | 开关全部 Telegram 通知 |
| `/notify status` | 查看当前通知开关 |
| `/token` | 查询 DeepSeek API 余额 |
| `/new` | 开启新聊天 |

### 远程批准

桌面端需要批准时，Telegram 会收到：

```text
🔔 需要你批准
工具：...
理由：...

[ ✅ 批准 ]  [ ❌ 拒绝 ]
```

### 通知

- ✅ 工作完成
- ❌ 工具出错
- 🔔 需要批准
- 📋 进度更新（默认关闭，可在配置里打开）

---

## 📨 通知格式

### 主 Agent 开始工作

```text
🚀 🤖 主 Agent · 开始工作
任务：<任务名称>
会话：<session_id>
```

### 子 Agent 开始工作

```text
🚀 🧩 子 Agent #1 · 开始工作
任务：<子任务名称>
会话：<session_id>
```

### 主 Agent 完成

```text
✅ 🤖 主 Agent · 工作完成
任务：<任务名称>
结果：<简短结果摘要>
会话：<session_id>
```

### 子 Agent 完成

```text
✅ 🧩 子 Agent #1 · 工作完成
任务：<子任务名称>
结果：<简短结果摘要>
会话：<session_id>
父任务：<parent_session_id>
```

> 如果任务名称或结果摘要缺失，会显示“未提供任务名称”/“未提供结果摘要”，不会出现 `[object Object]`。


## 🔒 安全说明

- ⚠️ **Bot Token 是敏感信息，切勿提交到 GitHub**
- 本仓库只包含 `cordis.patch.yml.example` 占位符
- 安装脚本会生成你本地的 `cordis.patch.yml`
- Telegram 聊天使用 `chat-only` 预设，**不挂载任何工作工具**
- 只有配置的 `chatId` 才能操作 Bot

---

## 🗑️ 卸载

```powershell
$pkg = "$env:USERPROFILE\.dsh\profiles\web-desktop\package.json"
$json = Get-Content $pkg -Raw | ConvertFrom-Json
$json.dependencies.PSObject.Properties.Remove("dsh-telegram-notify")
$json.dsh.profile.bundles = @($json.dsh.profile.bundles | Where-Object { $_ -ne "dsh-telegram-notify" })
$json | ConvertTo-Json -Depth 10 | Set-Content $pkg -Encoding UTF8

Remove-Item "$env:USERPROFILE\.dsh\profiles\web-desktop\node_modules\dsh-telegram-notify" -Force
Remove-Item "$env:USERPROFILE\.dsh\dsh-telegram-notify" -Recurse -Force
Remove-Item "$env:USERPROFILE\.dsh\.agent-presets\chat-only" -Recurse -Force
```

---

## 📄 License

MIT