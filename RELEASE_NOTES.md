# Hermes Agent Platform v0.1.27 发布说明 / Release Notes

## 🌟 核心更新亮点 (Highlights)

### 1. 👁️ 开源大模型库全面扩容「多模态视觉 (Vision)」专题分类
- **引入主流开源多模态视觉旗舰**：在本地/开源模型库（Model Catalog）中正式加入独立的多模态视觉分类，收录：
  - **Qwen 2.5 VL (7B)**：全能开源多模态旗舰，专精发票/文档/复杂表格 OCR、高精度图表结构提取与桌面截屏 UI 视觉免扫码代答；
  - **Qwen 2.5 VL (3B)**：轻量端侧视觉小钢炮，极低显存占用（~3GB），可在轻薄本上毫秒级响应截屏速读；
  - **LLaVA (7B)**：经典图文对话模型，生态成熟；
  - **MiniCPM-V 2.6 (8B)**：端侧全能高分辨率视觉标杆，支持高清切片与细节对比分析。
- **界面沉浸式视觉标识**：
  - 模型广场顶部新增「👁️ 多模态视觉」快捷筛选 Tab 与数量实时统计；
  - 模型服务商列表、模型管理表格以及智能体角色配置下拉框中，全链路高亮显示「👁️ 视觉」渐变专属徽章胶囊，一眼识别模型图文能力。

### 2. 🧠 多模态与推理能力自动推断识别引擎 (inferModelCapabilities)
- **智能特征匹配**：配置解析引擎（ConfigResolver）在遇到未显式配置 `capabilities` 的模型时，自动根据模型名称和别名（包含 `vl`、`vision`、`omni`、`minicpm`、`llava`、`internvl`、`gpt-4o/5`、`claude`、`gemini` 等关键词）智能识别并自动补全 `vision` 标签，保障与图片附件上传、桌面截图代管等上层业务的无缝互通；
- **Ollama 本地拉取能力自动对齐**：通过 GUI 一键拉取或保存 Ollama 模型时，自动为视觉类模型绑定 `['tools', 'vision', 'streaming']` 能力。

### 3. 🚀 Markdown 渲染主线程死循环彻底修复与 RAF 流式批处理
- **循环行推进不变量安全兜底 (Fail-Safe Invariant)**：彻底根除 Markdown 解析器在遇到半截流式表格（如单行表头 `| col |`）、流式标题（`# `）、列表项（`- `）或未闭合特殊语法时导致的变量指针原地踏步与主线程死循环问题（100% CPU 假死、页面转圈、系统弹窗报错未响应）；
- **流式未闭合代码块即时捕获**：流式生成过程中尚未闭合的开代码块自动先行抽取与容错，实时呈现优雅的代码卡片与高亮，避免代码行字符误流入 Markdown 普通文本扫描器造成转义异常；
- **60/120fps 批处理抗雪崩**：彻底移除高速 Token 吐出时对成千上万字全量文本的同步高频 Markdown 全解析与 DOM 暴力赋值，引入由浏览器屏幕刷新率调度的 `scheduleLiveContentRender`，长文本生成零掉帧。

---

## 📦 各系统安装包与下载安装指南 (Download & Installation Guide)

> **安全提示 / Security Notice**：  
> 本项目属于开源软件，安装包未购买商业代码签名证书。在 Windows 或 macOS 首次启动时若出现系统拦截提示，属于正常系统安全策略，请按以下说明放心放行即可。

### 🪟 Windows (x64)
- **安装文件**：
  - **标准安装向导（推荐）**：[`Hermes-Agent-Platform-0.1.27-Windows-x64-Setup.exe`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.27/Hermes-Agent-Platform-0.1.27-Windows-x64-Setup.exe) (经典安装向导，支持选择安装路径、创建桌面快捷方式与开始菜单入口)
  - **绿色便携免安装版**：[`Hermes-Agent-Platform-0.1.27-Windows-x64-Portable.exe`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.27/Hermes-Agent-Platform-0.1.27-Windows-x64-Portable.exe) (单文件解压即用)
- **安装与运行说明**：
  1. 下载 `Hermes-Agent-Platform-0.1.27-Windows-x64-Setup.exe` 并双击启动安装向导；
  2. 按照向导提示选择安装目录（如 `D:\Program Files\Hermes Agent Platform`）并勾选创建桌面快捷方式，点击“下一步”直到完成；
  3. 若遇到 **Windows Defender SmartScreen** 弹出“Windows 已保护你的电脑 / 未知发布者”提示：
     - 点击提示框中的 **「更多信息」 (More info)**；
     - 再点击右下角出现的 **「仍要运行」 (Run anyway)** 即可正常进入主界面。

### 🍎 macOS (Apple Silicon & Intel)
- **安装文件**：
  - **Apple Silicon (M1 / M2 / M3 / M4 / M系列芯片)**：
    - DMG 安装镜像：[`Hermes-Agent-Platform-0.1.27-macOS-arm64.dmg`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.27/Hermes-Agent-Platform-0.1.27-macOS-arm64.dmg)
    - 免安装压缩包：[`Hermes-Agent-Platform-0.1.27-macOS-arm64.zip`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.27/Hermes-Agent-Platform-0.1.27-macOS-arm64.zip)
  - **Intel x64 芯片**：
    - DMG 安装镜像：[`Hermes-Agent-Platform-0.1.27-macOS-x64.dmg`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.27/Hermes-Agent-Platform-0.1.27-macOS-x64.dmg)
    - 免安装压缩包：[`Hermes-Agent-Platform-0.1.27-macOS-x64.zip`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.27/Hermes-Agent-Platform-0.1.27-macOS-x64.zip)
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
  - DEB 安装包：[`Hermes-Agent-Platform-0.1.27-Ubuntu-amd64.deb`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.27/Hermes-Agent-Platform-0.1.27-Ubuntu-amd64.deb)
- **安装与运行说明**：
  1. 下载 `.deb` 安装包至本地；
  2. 终端运行：
     ```bash
     sudo dpkg -i Hermes-Agent-Platform-0.1.27-Ubuntu-amd64.deb
     sudo apt-get install -f
     ```
  3. 安装完成后在应用程序列表启动，或在终端输入 `hermes-agent-platform`。
