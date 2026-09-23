# Hermes Agent Platform v0.1.20 发布说明 / Release Notes

## 🌟 核心更新亮点 (Highlights)

### 1. 🖥️ 跨平台桌面视窗与屏幕捕获增强
- **全平台屏幕截屏捕获**：增强 Windows、macOS 与 Linux 下的屏幕截屏能力，保障视觉代管与桌面控制的跨平台一致性。
- **进程探测与类型安全**：增强微信等应用进程探测的跨平台安全性与健壮性，防止非预期崩溃。

### 2. ⏱️ 任务调度引擎深度优化 (Scheduler Engine)
- **精确时间戳与日期级 Tick 去重**：引入包含日期的精确周期去重，杜绝定时任务同一分钟内重复触发。
- **服务重启状态保护**：全面优化重启恢复逻辑，避免系统重启后对已调度任务进行重复执行。
- **并发重叠守卫机制 (Overlapping Job Guard)**：针对执行时间长于调度间隔的复杂任务，自动防止重叠并发执行，杜绝任务互相踩踏与内存占用飙升。

### 3. ⚡ 生产打包精简与研发效率提升
- **构建体积轻量化**：生产编译配置自动剥离所有测试用例文件，构建前自动清理过时的 `dist` 产物。
- **GUI 研发启动提速**：优化本地调试启动循环，避免常规代码热重载时不必要的原生模块重复编译。
- **CI 发版流水线质量加固**：发版自动化矩阵严格接入 `npm run lint` 与 `npm run build` 生产构建完整性校验。

### 4. 🧠 平台核心能力延续 (v0.1.19+ 架构特性)
- **模型上下文升级**：拉取的云端/本地模型默认窗口统一扩展至 **1024k (1,048,576 tokens)**。
- **微信代管多轮记忆解耦**：彻底隔离代管记忆与普通会话，防止人设污染；智能滑动修剪与好友事实画像沉淀，根治“前言不搭后语”。
- **智能体生态**：自动加载 `~/.agents/.skills` 本地技能、`@` / `/` 快速补全菜单、规划模式 (Plan Mode)、生命周期 Hooks 机制、工作区沙箱守卫。

---

## 📦 各系统安装包与下载安装指南 (Download & Installation Guide)

> **安全提示 / Security Notice**：  
> 本项目属于社区开源软件，安装包未购买商业代码签名证书。在 Windows 或 macOS 首次启动时若出现系统拦截提示，属于正常安全机制，请按以下说明放心放行。

### 🪟 Windows (x64)
- **安装文件**：
  - `Hermes-Agent-Platform-0.1.20-Windows-Setup-x64.exe` (或 `Hermes-Agent-Platform-0.1.20-Setup.exe`)
- **安装与运行说明**：
  1. 下载后双击运行安装向导，按照提示完成安装并自动创建桌面快捷方式。
  2. 若遇到 **Windows Defender SmartScreen** 弹出“Windows 已保护你的电脑 / 未知发布者”拦截提示：
     - 点击提示框中的 **「更多信息」 (More info)**；
     - 再点击右下角出现的 **「仍要运行」 (Run anyway)** 即可正常打开。

### 🐧 Ubuntu / Debian Linux (x64)
- **安装文件**：
  - `Hermes-Agent-Platform-0.1.20-Ubuntu-x64.deb`
- **安装与运行说明**：
  1. 下载 `.deb` 安装包至本地。
  2. 打开终端运行以下命令安装：
     ```bash
     sudo dpkg -i Hermes-Agent-Platform-0.1.20-Ubuntu-x64.deb
     sudo apt-get install -f  # 若缺少依赖项，执行此命令自动修复并完成安装
     ```
  3. 安装完成后可在系统应用程序列表启动，或在终端输入 `hermes-agent-platform` 运行。

### 🍎 macOS (Apple Silicon & Intel)
- **安装文件**：
  - **Apple Silicon (M1 / M2 / M3 / M4 / M系列芯片)**：
    - DMG 安装镜像：`Hermes-Agent-Platform-0.1.20-macOS-arm64.dmg`
    - 免安装压缩包：`Hermes-Agent-Platform-0.1.20-macOS-arm64.zip`
  - **Intel (x64 处理器)**：
    - DMG 安装镜像：`Hermes-Agent-Platform-0.1.20-macOS-x64.dmg`
    - 免安装压缩包：`Hermes-Agent-Platform-0.1.20-macOS-x64.zip`
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
