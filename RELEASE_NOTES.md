# Hermes Agent Platform v0.1.22 发布说明 / Release Notes

## 🌟 核心更新亮点 (Highlights)

### 1. 🚀 桌面 GUI 多会话全并发无阻塞并行与独立中止 (Multi-Session Parallelism & Isolated Abort)
- **多会话同时生成**：彻底打破旧版单流式会话互斥阻塞与排队机制，桌面端后台引入并发任务池 (`activeChatTasks` Map)，支持用户创建并切换多个智能体对话窗口，所有会话均可在后台无阻塞、全并发运行；
- **精准事件流路由与状态隔离**：流式推送事件深度携带 `sessionKey`，界面根据当前激活会话精确路由渲染，会话切换即时展现真实流式/完成状态；
- **独立会话中止控制**：点击停止按钮仅中止当前会话的生成推理任务，绝不干扰其他正在运行的会话，同时支持工作台退出与切换时的级联批量保护。

### 2. 🎨 语义色彩体系与深浅高对比度固化 (Visual Semantics & Contrast Enhancement)
- **深浅主题对比度增强**：全面梳理 `--bg-*`、`--border-*`、`--text-*` 语义变量，修复浅色模式下边框发虚泛白以及深色模式下弱层级视觉疲劳问题；
- **无障碍与系统偏好感知**：全面适配系统的 `prefers-contrast: more`（高对比度）和 `prefers-reduced-motion: reduce`（弱动效）规范，保障长时间高强度交互的视觉舒适度与无障碍支持。

### 3. 🧩 前端大单体架构模块化解耦 (Frontend Architecture Modularization)
- **子模块独立拆分**：在 `src/gui/renderer/modules/` 中建立清晰的子模块体系：
  - `theme-controller.js`：统一掌控主题模式（light/dark/system）、高对比度切换与颜色持久化；
  - `git-controller.js`：独立接管 Git 状态监控、分支切换、Commit 提交、Remote 同步与日志渲染；
  - `terminal-controller.js`：封装内嵌终端会话、PTY 缓冲区管理与快捷命令流；
- 架构可维护性与测试解耦度大幅提升，避免庞大单体脚本的代码膨胀。

### 4. 🪟 Windows 微信窗口 RECT 智能定位与精准截屏 (Windows Desktop Vision Enhancement)
- **原生窗口坐标智能定位**：深度重构 Windows 下基于 `user32.dll` / PowerShell 原生 API 的窗口检测机制，精准获取 `GetWindowRect` 几何坐标与 DPI 缩放比例；
- **自动窗口区域裁剪**：实现仅针对桌面微信窗口边界的局部高保真裁剪，告别全屏冗余截屏带来的性能消耗与多屏幕坐标漂移，大幅提升视觉代管模式的识别精确度与响应速度。

### 5. ⚡ Agent 记忆库 SQL 谓词下推与 60s LRU 内存缓存 (Memory Store SQL Pushdown & Caching)
- **底层 SQLite 谓词下推**：将原先在应用层内存循环比对的 scope / tags 过滤条件彻底下推至 SQLite 引擎 `WHERE` 子句与联合索引，消灭大数据量下的全表扫描瓶颈；
- **高性能 LRU 内存缓存**：内建 60 秒 TTL 与最大 500 条目容量的 LRU 高速缓存层，增删改自动精准失效，大幅降低磁盘 I/O 延迟与数据库加锁开销。

---

## 📦 各系统安装包与下载安装指南 (Download & Installation Guide)

> **安全提示 / Security Notice**：  
> 本项目属于社区开源软件，安装包未购买商业代码签名证书。在 Windows 或 macOS 首次启动时若出现系统拦截提示，属于正常安全机制，请按以下说明放心放行。

### 🪟 Windows (x64)
- **安装文件**：
  - `Hermes-Agent-Platform-0.1.22-Windows-Setup-x64.exe` (或 `Hermes-Agent-Platform-0.1.22-Setup.exe`)
- **安装与运行说明**：
  1. 下载后双击运行安装向导，按照提示完成安装并自动创建桌面快捷方式。
  2. 若遇到 **Windows Defender SmartScreen** 弹出“Windows 已保护你的电脑 / 未知发布者”拦截提示：
     - 点击提示框中的 **「更多信息」 (More info)**；
     - 再点击右下角出现的 **「仍要运行」 (Run anyway)** 即可正常打开。

### 🐧 Ubuntu / Debian Linux (x64)
- **安装文件**：
  - `Hermes-Agent-Platform-0.1.22-Ubuntu-x64.deb`
- **安装与运行说明**：
  1. 下载 `.deb` 安装包至本地。
  2. 打开终端运行以下命令安装：
     ```bash
     sudo dpkg -i Hermes-Agent-Platform-0.1.22-Ubuntu-x64.deb
     sudo apt-get install -f  # 若缺少依赖项，执行此命令自动修复并完成安装
     ```
  3. 安装完成后可在系统应用程序列表启动，或在终端输入 `hermes-agent-platform` 运行。

### 🍎 macOS (Apple Silicon & Intel)
- **安装文件**：
  - **Apple Silicon (M1 / M2 / M3 / M4 / M系列芯片)**：
    - DMG 安装镜像：`Hermes-Agent-Platform-0.1.22-macOS-arm64.dmg`
    - 免安装压缩包：`Hermes-Agent-Platform-0.1.22-macOS-arm64.zip`
  - **Intel (x64 处理器)**：
    - DMG 安装镜像：`Hermes-Agent-Platform-0.1.22-macOS-x64.dmg`
    - 免安装压缩包：`Hermes-Agent-Platform-0.1.22-macOS-x64.zip`
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
