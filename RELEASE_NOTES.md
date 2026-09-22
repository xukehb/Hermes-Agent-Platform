# Hermes Agent Platform v0.1.19 发布说明 / Release Notes

## 🌟 核心更新亮点 (Highlights)

### 1. 🧠 模型默认上下文窗口扩展至 1024k
- 从各服务商拉取的模型配置默认上下文窗口统一升级为 **1024k (1,048,576 tokens)**。
- 彻底解除长文本问答、海量代码分析与复杂逻辑链处理的窗口限制。

### 2. 💬 微信托管与多轮长记忆解耦架构
- **会话与代管深度解耦**：微信托管的上下文与应用内常规对话隔离存储，防止人设与代管 System Prompt 相互污染。
- **多轮上下文连贯性优化**：彻底解决微信代管多轮后出现的“前言不搭后语”与历史丢失问题，增加滑动剪裁与关键记忆摘要机制。
- **稳定重连与桌面识别**：优化微信 OCR 视觉代管与多协议支持，增强心跳检测与异常自愈能力。

### 3. 🛠️ 智能体交互与生态扩展全面增强
- **用户目录技能自动发现**：自动扫描加载 `~/.agents/.skills` 目录下的用户自定义 Skill 技能包。
- **全局唤起与命令补全**：
  - 输入 `@` 快速唤起智能体、插件与会话上下文；
  - 输入 `/` 快速唤起斜杠命令与技能菜单。
- **规划模式 (Planning Mode) 与目标模式 (Goal Mode)**：支持长时间攻坚与多步复杂研发规划。
- **生命周期 Hooks 机制**：内置前后置拦截器，支持自定义请求校验与中间件扩展。
- **沙箱环境与敏感操作守卫**：支持命令执行安全审计与敏感操作自动化/手动多级审批。
- **电脑控制与浏览器自动化**：支持系统级桌面操控与无头浏览器智能操控。

---

## 📦 各系统安装包与下载安装指南 (Download & Installation Guide)

> **安全提示 / Security Notice**：  
> 本项目属于社区开源软件，安装包未购买商业代码签名证书。在 Windows 或 macOS 首次启动时若出现系统拦截提示，属于正常安全机制，请按以下说明放心放行。

### 🪟 Windows (x64)
- **安装文件**：
  - `Hermes-Agent-Platform-0.1.19-Windows-Setup-x64.exe` (或 `Hermes-Agent-Platform-0.1.19-Setup.exe`)
- **安装与运行说明**：
  1. 下载后双击运行安装向导，按照提示完成安装并自动创建桌面快捷方式。
  2. 若遇到 **Windows Defender SmartScreen** 弹出“Windows 已保护你的电脑 / 未知发布者”拦截提示：
     - 点击提示框中的 **「更多信息」 (More info)**；
     - 再点击右下角出现的 **「仍要运行」 (Run anyway)** 即可正常打开。

### 🐧 Ubuntu / Debian Linux (x64)
- **安装文件**：
  - `Hermes-Agent-Platform-0.1.19-Ubuntu-x64.deb`
- **安装与运行说明**：
  1. 下载 `.deb` 安装包至本地。
  2. 打开终端运行以下命令安装：
     ```bash
     sudo dpkg -i Hermes-Agent-Platform-0.1.19-Ubuntu-x64.deb
     sudo apt-get install -f  # 若缺少依赖项，执行此命令自动修复并完成安装
     ```
  3. 安装完成后可在系统应用程序列表启动，或在终端输入 `hermes-agent-platform` 运行。

### 🍎 macOS (Apple Silicon & Intel)
- **安装文件**：
  - **Apple Silicon (M1 / M2 / M3 / M4 / M系列芯片)**：
    - DMG 安装镜像：`Hermes-Agent-Platform-0.1.19-macOS-arm64.dmg`
    - 免安装压缩包：`Hermes-Agent-Platform-0.1.19-macOS-arm64.zip`
  - **Intel (x64 处理器)**：
    - DMG 安装镜像：`Hermes-Agent-Platform-0.1.19-macOS-x64.dmg`
    - 免安装压缩包：`Hermes-Agent-Platform-0.1.19-macOS-x64.zip`
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
