# Hermes Agent Platform v0.1.32 发布说明 / Release Notes

## 🌟 v0.1.32 核心更新 (Highlights)

### 1. 🎙️ 贾维斯语音防重叠串行队列与优先级调度
- **单一播报队列 (`_speechQueue`)**：重构语音输出中枢，任何时刻只播报一段语音，彻底消除唤醒问候音、确认插话与大模型长文总结同时并发朗读造成的混音与乱序；
- **优先级抢占打断**：针对异常告警、用户打断等高优先级场景支持瞬间抢占当前音频，并安全结算上一个播放承诺；
- **腾讯云 / 本地双模平滑切换**：当腾讯云 TTS 发生网络波动或鉴权异常时，自动平滑回退到本地系统级语音，不再静音或卡死。

### 2. ⚡ 口述指令世代保护与任务取消打断
- **指令世代标识 (`commandGeneration`)**：为每一次语音口述任务绑定唯一生命周期世代，用户中途发起新指令时自动废弃旧任务的迟到回复；
- **即时取消控制 (`cancelCommand`)**：支持喊出“停止”、“取消”等口令，毫秒级终止后台 `chat` 会话并立即停止 TTS 发声；
- **全双工打断感知优化**：智能滤除扬声器回声，仅在检测到真实人类语音输入时打断当前播报，交谈节奏更自然。

### 3. 🛠️ 模型配置与多模态交互体验提升
- 修复模型配置与语音设置在特定条件下的状态同步；
- 完善开源许可（MIT License）及整体架构说明文档；
- 全套 105 个测试套件（1062 个用例）与生产代码质量门禁 100% 验证通过。

---

## 延续功能 (Existing features)

### 1. ⚡ 钢铁侠贾维斯 (J.A.R.V.I.S.) 核心系统
- **随时待命与专属管家人格 (Persona: "Sir")**：尊称用户为“先生 (Sir)”，语调沉稳、严谨、优雅；默认唤醒词升级为「**贾维斯**」；
- **本地 / 腾讯云双擎 TTS 语音回话**：优先匹配英国绅士男音（macOS `"Daniel"`，Windows 优雅自然音色）与自然普通话；
- **屏幕视觉感知 (Screen Vision)**：口述“*贾维斯，帮我看下屏幕*”，秒级静默捕获当前屏幕画面并由多模态大模型进行全屏代码与报错诊断；
- **钢铁侠方舟反应堆 (Arc Reactor HUD)**：三层全息反应堆结构随说话音量与声波频谱高能机械律动；
- **系统级原生控制快车道 (<50ms)**：音量调节、静音、锁屏、时间查询、启动软件毫秒级原生响应；
- **10 秒连续多轮对话窗口**：唤醒一次保持 10 秒倾听状态，无需每句重复喊唤醒词。

### 2. 🐳 多模态模型 Docker 一键部署与管理
- 9 个外部语音、图片和视频模型的 Docker 一键部署流程；
- 支持环境条件检查、模型权重本地缓存、容器健康检查、自动注册服务商、容器日志与启停管理。

---

## 📦 各系统安装包与下载安装指南 (Download & Installation Guide)

> **安全提示 / Security Notice**：  
> 本项目属于开源软件，安装包未购买商业代码签名证书。在 Windows 或 macOS 首次启动时若出现系统拦截提示，属于正常系统安全策略，请按以下说明放心放行即可。

### 🪟 Windows (x64)
- **安装文件**：
  - **标准安装向导（推荐）**：[`Hermes-Agent-Platform-0.1.32-Windows-x64-Setup.exe`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.32/Hermes-Agent-Platform-0.1.32-Windows-x64-Setup.exe) (经典安装向导，支持选择安装路径、创建桌面快捷方式与开始菜单入口)
  - **绿色便携免安装版**：[`Hermes-Agent-Platform-0.1.32-Windows-x64-Portable.exe`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.32/Hermes-Agent-Platform-0.1.32-Windows-x64-Portable.exe) (单文件解压即用)
- **安装与运行说明**：
  1. 下载 `Hermes-Agent-Platform-0.1.32-Windows-x64-Setup.exe` 并双击启动安装向导；
  2. 按照向导提示选择安装目录（如 `D:\Program Files\Hermes Agent Platform`）并勾选创建桌面快捷方式，点击“下一步”直到完成；
  3. 若遇到 **Windows Defender SmartScreen** 弹出“Windows 已保护你的电脑 / 未知发布者”提示：
     - 点击提示框中的 **「更多信息」 (More info)**；
     - 再点击右下角出现的 **「仍要运行」 (Run anyway)** 即可正常进入主界面。

### 🍎 macOS (Apple Silicon & Intel)
- **安装文件**：
  - **Apple Silicon (M1 / M2 / M3 / M4 / M系列芯片)**：
    - DMG 安装镜像：[`Hermes-Agent-Platform-0.1.32-macOS-arm64.dmg`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.32/Hermes-Agent-Platform-0.1.32-macOS-arm64.dmg)
    - 免安装压缩包：[`Hermes-Agent-Platform-0.1.32-macOS-arm64.zip`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.32/Hermes-Agent-Platform-0.1.32-macOS-arm64.zip)
  - **Intel x64 芯片**：
    - DMG 安装镜像：[`Hermes-Agent-Platform-0.1.32-macOS-x64.dmg`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.32/Hermes-Agent-Platform-0.1.32-macOS-x64.dmg)
    - 免安装压缩包：[`Hermes-Agent-Platform-0.1.32-macOS-x64.zip`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.32/Hermes-Agent-Platform-0.1.32-macOS-x64.zip)
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
  - **DEB 安装包**：[`Hermes-Agent-Platform-0.1.32-Ubuntu-amd64.deb`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.32/Hermes-Agent-Platform-0.1.32-Ubuntu-amd64.deb)
- **安装与运行说明**：
  1. 下载 `.deb` 安装包至本地；
  2. 终端运行：
     ```bash
     sudo dpkg -i Hermes-Agent-Platform-0.1.32-Ubuntu-amd64.deb
     sudo apt-get install -f
     ```
  3. 安装完成后在应用程序列表启动，或在终端输入 `hermes-agent-platform`。
