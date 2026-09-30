# Hermes Agent Platform v0.1.26 发布说明 / Release Notes

## 🌟 核心更新亮点 (Highlights)

### 1. 🚀 彻底根除 Markdown 渲染主线程死循环卡死与页面未响应
- **循环行推进不变量安全兜底 (Fail-Safe Invariant)**：彻底修复 Markdown 解析器在遇到半截流式表格（如单行表头 `| col |`）、流式标题（`# `）、列表项（`- `）或未闭合特殊语法时导致的变量指针原地踏步与主线程死循环问题（100% CPU 假死、页面转圈、系统弹窗报错未响应）；
- **流式未闭合代码块即时捕获**：流式生成过程中尚未闭合的开代码块自动先行抽取与容错，实时呈现优雅的代码卡片与高亮，避免代码行字符误流入 Markdown 普通文本扫描器造成转义异常；
- **行内斜体与加粗正则优化**：重构行内 Markdown 正则匹配策略，防止星号跨度回溯导致的极端场景性能损耗。

### 2. ⚡ 流式 Token 渲染 requestAnimationFrame 帧率批处理调度
- **60/120fps 批处理抗雪崩**：彻底移除高速 Token 吐出时对成千上万字全量文本的同步高频 Markdown 全解析与 DOM 暴力赋值，引入由浏览器屏幕刷新率调度的 `scheduleLiveContentRender`；
- **CPU 负载骤降与长文本极致丝滑**：在超长上下文对话与高速大模型输出场景下，界面交互响应零掉帧，彻底告别打字卡顿与滚动掉帧。

### 3. 🎯 模型 Token 上限约束解绑与自由配置
- 移除对大模型输出长度的人为上限截断，新增灵活的最大 Token 数自适应与“不限”配置；
- 提供智能体角色参数与服务商默认参数的完整联动与热保存。

---

## 📦 各系统安装包与下载安装指南 (Download & Installation Guide)

> **安全提示 / Security Notice**：  
> 本项目属于开源软件，安装包未购买商业代码签名证书。在 Windows 或 macOS 首次启动时若出现系统拦截提示，属于正常系统安全策略，请按以下说明放心放行即可。

### 🪟 Windows (x64)
- **安装文件**：
  - **标准安装向导（推荐）**：[`Hermes-Agent-Platform-0.1.26-Windows-x64-Setup.exe`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.26/Hermes-Agent-Platform-0.1.26-Windows-x64-Setup.exe) (经典安装向导，支持选择安装路径、创建桌面快捷方式与开始菜单入口)
  - **绿色便携免安装版**：[`Hermes-Agent-Platform-0.1.26-Windows-x64-Portable.exe`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.26/Hermes-Agent-Platform-0.1.26-Windows-x64-Portable.exe) (单文件解压即用)
- **安装与运行说明**：
  1. 下载 `Hermes-Agent-Platform-0.1.26-Windows-x64-Setup.exe` 并双击启动安装向导；
  2. 按照向导提示选择安装目录（如 `D:\Program Files\Hermes Agent Platform`）并勾选创建桌面快捷方式，点击“下一步”直到完成；
  3. 若遇到 **Windows Defender SmartScreen** 弹出“Windows 已保护你的电脑 / 未知发布者”提示：
     - 点击提示框中的 **「更多信息」 (More info)**；
     - 再点击右下角出现的 **「仍要运行」 (Run anyway)** 即可正常进入主界面。

### 🍎 macOS (Apple Silicon & Intel)
- **安装文件**：
  - **Apple Silicon (M1 / M2 / M3 / M4 / M系列芯片)**：
    - DMG 安装镜像：[`Hermes-Agent-Platform-0.1.26-macOS-arm64.dmg`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.26/Hermes-Agent-Platform-0.1.26-macOS-arm64.dmg)
    - 免安装压缩包：[`Hermes-Agent-Platform-0.1.26-macOS-arm64.zip`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.26/Hermes-Agent-Platform-0.1.26-macOS-arm64.zip)
  - **Intel x64 芯片**：
    - DMG 安装镜像：[`Hermes-Agent-Platform-0.1.26-macOS-x64.dmg`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.26/Hermes-Agent-Platform-0.1.26-macOS-x64.dmg)
    - 免安装压缩包：[`Hermes-Agent-Platform-0.1.26-macOS-x64.zip`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.26/Hermes-Agent-Platform-0.1.26-macOS-x64.zip)
- **安装与运行说明**：
  1. 双击打开 `.dmg` 镜像，将 `Hermes Agent Platform` 图标拖入 `Applications`（应用程序）文件夹；
  2. 若首次打开出现系统安全阻拦提示：
     - 前往系统 **「系统设置」 -> 「隐私与安全性」**，在下方找到“已阻止使用 Hermes Agent Platform”，点击 **「仍要打开」**；
     - 或在终端执行放行命令：
       ```bash
       sudo xattr -rd com.apple.quarantine "/Applications/Hermes Agent Platform.app"
       ```

### 🐧 Ubuntu / Debian Linux (x64)
- **安装文件**：
  - DEB 安装包：[`Hermes-Agent-Platform-0.1.26-Ubuntu-amd64.deb`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.26/Hermes-Agent-Platform-0.1.26-Ubuntu-amd64.deb)
- **安装与运行说明**：
  1. 下载 `.deb` 安装包至本地；
  2. 终端运行：
     ```bash
     sudo dpkg -i Hermes-Agent-Platform-0.1.26-Ubuntu-amd64.deb
     sudo apt-get install -f
     ```
  3. 安装完成后在应用程序列表启动，或在终端输入 `hermes-agent-platform`。
