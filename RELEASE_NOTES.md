# Hermes Agent Platform v0.1.21 发布说明 / Release Notes

## 🌟 核心更新亮点 (Highlights)

### 1. 💬 微信通道连接态与接入逻辑深度重构 (WeChat Channel & Connection Redesign)
- **双接入模式彻底解耦**：
  - **桌面视觉代管模式 (SightFlow)**：明确为**免扫码无侵入接管电脑桌面端微信窗口**。界面提示与状态彻底与手机扫码解耦，不再产生“虚假连接”或“应该用手机扫码”的困惑；
  - **个人微信扫码接入模式 (iLink Bot)**：基于腾讯官方无侵入扫码协议，专用于手机微信直接与智能体多轮会话。
- **电脑桌面微信进程实时感知**：
  - 启动视觉代管时动态检测桌面端微信进程：若运行中显示“桌面微信已接管”，若未启动显示“等待打开桌面微信”，并清晰指引用户在电脑端打开微信；
  - 右侧面板提供便捷的 **【切换为手机微信扫码登录 (iLink)】** 按钮，一键无缝切换模式。
- **本地有效凭据透明化感知与一键重扫 (`reloginWeChat`)**：
  - 未启动微信服务时，自动检测本地历史会话凭据（`~/.hap/wechat-auth/`），明确提示“上次登录凭据有效，启动将免扫码自动恢复连接”，并提供 **【清除凭据并重新扫码】** 按钮；
  - 运行就绪后，明确展示已绑定的账号，并提供 **【重新扫码 / 切换微信号】** 按钮；
  - 点击后自动停止服务、安全清空历史会话、校准模式并重启拉取**全新二维码**呈现给用户。
- **模式切换即时联动与自动持久化**：
  - 下拉框选择不同模式时，在未启动状态下自动静默持久化配置，无需点击保存表单即可直接生效，彻底避免配置漂移。

### 2. 🖥️ 跨平台桌面视窗与屏幕捕获增强 (v0.1.20 延续)
- 全平台屏幕截屏捕获保障 Windows、macOS 与 Linux 下的视觉代管与桌面控制跨平台一致性。
- 精确周期与日期级任务调度引擎（Scheduler Engine），支持并发重叠守卫机制（Overlapping Guard）。

### 3. 🧠 平台核心架构能力
- **模型上下文统一升级**：默认支持 **1024k (1,048,576 tokens)** 超大上下文窗口。
- **代管长记忆多轮解耦**：彻底隔离代管记忆与普通会话，防止人设污染；智能滑动修剪与好友事实画像沉淀，根治对话前言不搭后语。
- **智能体生态**：自动加载本地技能、`@` / `/` 快速补全菜单、规划模式 (Plan Mode)、生命周期 Hooks 机制、工作区沙箱守卫。

---

## 📦 各系统安装包与下载安装指南 (Download & Installation Guide)

> **安全提示 / Security Notice**：  
> 本项目属于社区开源软件，安装包未购买商业代码签名证书。在 Windows 或 macOS 首次启动时若出现系统拦截提示，属于正常安全机制，请按以下说明放心放行。

### 🪟 Windows (x64)
- **安装文件**：
  - `Hermes-Agent-Platform-0.1.21-Windows-Setup-x64.exe` (或 `Hermes-Agent-Platform-0.1.21-Setup.exe`)
- **安装与运行说明**：
  1. 下载后双击运行安装向导，按照提示完成安装并自动创建桌面快捷方式。
  2. 若遇到 **Windows Defender SmartScreen** 弹出“Windows 已保护你的电脑 / 未知发布者”拦截提示：
     - 点击提示框中的 **「更多信息」 (More info)**；
     - 再点击右下角出现的 **「仍要运行」 (Run anyway)** 即可正常打开。

### 🐧 Ubuntu / Debian Linux (x64)
- **安装文件**：
  - `Hermes-Agent-Platform-0.1.21-Ubuntu-x64.deb`
- **安装与运行说明**：
  1. 下载 `.deb` 安装包至本地。
  2. 打开终端运行以下命令安装：
     ```bash
     sudo dpkg -i Hermes-Agent-Platform-0.1.21-Ubuntu-x64.deb
     sudo apt-get install -f  # 若缺少依赖项，执行此命令自动修复并完成安装
     ```
  3. 安装完成后可在系统应用程序列表启动，或在终端输入 `hermes-agent-platform` 运行。

### 🍎 macOS (Apple Silicon & Intel)
- **安装文件**：
  - **Apple Silicon (M1 / M2 / M3 / M4 / M系列芯片)**：
    - DMG 安装镜像：`Hermes-Agent-Platform-0.1.21-macOS-arm64.dmg`
    - 免安装压缩包：`Hermes-Agent-Platform-0.1.21-macOS-arm64.zip`
  - **Intel (x64 处理器)**：
    - DMG 安装镜像：`Hermes-Agent-Platform-0.1.21-macOS-x64.dmg`
    - 免安装压缩包：`Hermes-Agent-Platform-0.1.21-macOS-x64.zip`
- **安装与 Gatekeeper 安全放行说明**：
  1. 双击打开 `.dmg` 镜像，将 `Hermes Agent Platform` 拖动至 `Applications`（应用程序）文件夹。
  2. 首次启动时若弹出 **“无法打开，因为 Apple 无法检查其是否包含恶意软件”** 或 **“来自未识别的开发者”**：
     - **推荐方式（终端一行命令彻底放行）**：
       打开终端（Terminal）执行：
       ```bash
       sudo xattr -cr /Applications/"Hermes Agent Platform.app"
       ```
     - **图形界面方式**：
       前往 macOS **「系统设置」 (System Settings)** -> **「隐私与安全性」 (Privacy & Security)**，向下滑动找到“安全性”一栏，点击右侧的 **「仍要打开」 (Open Anyway)**。

---

## 🔄 自动更新说明 (Auto Update)
Hermes Agent Platform 客户端内置 GitHub Releases 检查能力。当发布新版本后，客户端启动时会自动检测并在右下角提示更新。
