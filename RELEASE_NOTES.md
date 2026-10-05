# Hermes Agent Platform v0.1.31 发布说明 / Release Notes

## v0.1.31 更新

- 新增 9 个语音、图片和视频模型的 Docker 一键部署。
- 支持 Docker 条件检查、权重缓存、健康检查、自动注册服务商、日志、停止和删除。
- macOS Docker 支持 CPU Whisper；其余部署配置要求 x86_64 NVIDIA GPU 主机。安装包不包含模型权重。
- 验证范围：自动化测试、标准 Docker 镜像构建与接口冒烟测试通过；GPU 模型尚未完成真实推理验证。
- 使用方法见 [Docker 部署指南](https://github.com/xukehb/Hermes-Agent-Platform/blob/v0.1.31/docs/docker-model-deployment.md)。

## 延续的模型修复

- 修复本地 Ollama 模型因服务商隐藏及刷新时序而不显示的问题；打开模型广场时同步已安装模型。

- 修正 Qwen 2.5 VL 的 Ollama 模型标识为 `qwen2.5vl:3b` / `qwen2.5vl:7b`。
- 18 个 Ollama 模型保留一键部署；9 个外部语音、图片与视频模型改为官方仓库标识、模型主页和已部署服务配置入口。
- 后端拒绝把外部模型发送给 Ollama 下载，避免“模型不存在”错误；编辑配置时填入真实上游模型 ID。
- 外部模型的性能显示改为需专用服务实测。可使用新增的 Docker 流程部署外部推理服务，本版本不包含模型权重。

## 延续功能 (Existing features)

### 1. ⚡ 钢铁侠贾维斯 (J.A.R.V.I.S.) 核心系统全面上线
- **随时待命与专属管家人格 (Persona: "Sir")**：
  - 尊称用户为“先生 (Sir)”，语调沉稳、严谨、优雅；
  - 默认唤醒词升级为「**贾维斯**」（支持自由自定义为其他名称）；
  - 唤醒时给予标志性管家语音问候（如 *“At your service, sir.”* / *“随时为您效劳，先生。”*）。

### 2. 🎙️ 本地 TTS 语音合成回话与全双工即时打断 (Barge-in)
- **纯本地 Web Speech 驱动**：采用本地系统级语音合成引擎，零额外网络请求、零延迟；
- **智能优选管家音色**：优先匹配英国绅士男音（macOS 经典英音 `"Daniel"`，Windows 优雅自然音色）与自然普通话；
- **提炼式口述汇报**：智能体执行任务后，自动剥离 Markdown 语法与长篇代码，口述精炼的管家式汇报（*“先生，操作已执行完毕。”*）；
- **全双工打断 (Barge-in)**：当贾维斯正在朗读时，用户开口说话即可瞬间打断播报，无缝切换为新指令收音。

### 3. 👁️ 屏幕视觉感知与一键截屏诊断 (Screen Vision)
- **口述即看**：口述“*贾维斯，帮我看下屏幕*”或“*分析一下屏幕上的报错*”，系统秒级静默捕获当前屏幕画面；
- **视觉模型多模态诊断**：截屏画面与口述意图自动打包提交给配置的多模态视觉大模型（Vision LLM），完成全屏代码、界面与报错诊断。

### 4. 🌐 钢铁侠方舟反应堆 (Arc Reactor HUD) 与真实音频频谱律动
- **三层全息反应堆结构**：
  - 外层：高精度全息 12 段几何刻度环顺时针自旋；
  - 中层：点状能量导管环逆时针差速反向旋转；
  - 内层：方舟高能晶体与发光三角核心，脉冲流光；
- **真实音频频谱联动**：连接 Web Audio API AnalyserNode，反应堆旋转速度、外环扩散幅度与核心光晕随用户说话的声音大小与声波频率产生高能机械律动。

### 5. 🦾 系统级原生控制快车道 (System Control Fast Path <50ms)
对日常高频操作系统指令进行毫秒级原生拦截，秒级执行且无需等待大模型慢速思考：
- *“把音量调大 / 声音大点”* ➔ 秒调系统音量并语音反馈；
- *“调小声音 / 音量小点”* ➔ 秒降系统音量；
- *“静音 / 闭嘴”* ➔ 秒切静音；
- *“锁屏 / 锁定屏幕”* ➔ 秒级息屏锁屏；
- *“现在几点了”* ➔ 即时报时（*“现在是 X月X日 星期X XX:XX，先生。”*）；
- *“打开浏览器 / 打开 VSCode / 打开终端”* ➔ 秒级启动指定应用。

### 6. ⏳ 10 秒连续多轮对话窗口 (Continuous Dialogue)
- 唤醒一次后保持 10 秒活跃倾听窗口，用户无需每句话都重复喊唤醒词，像面对面交流一样自然连续追问，超时 10 秒无声自动恢复待机。

### 7. 🧩 多模态模型（图片/视频/语音）独立部署与默认路由
- 支持独立指定默认图片模型（Flux / SD）、默认视频模型（CogVideoX / 混元）与默认语音模型（Whisper / SenseVoice / CosyVoice）；
- 各模态模型全面支持本地私有化部署并填写自定义 URL、API Key 与 Model ID。

---

## 📦 各系统安装包与下载安装指南 (Download & Installation Guide)

> **安全提示 / Security Notice**：  
> 本项目属于开源软件，安装包未购买商业代码签名证书。在 Windows 或 macOS 首次启动时若出现系统拦截提示，属于正常系统安全策略，请按以下说明放心放行即可。

### 🪟 Windows (x64)
- **安装文件**：
  - **标准安装向导（推荐）**：[`Hermes-Agent-Platform-0.1.31-Windows-x64-Setup.exe`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.31/Hermes-Agent-Platform-0.1.31-Windows-x64-Setup.exe) (经典安装向导，支持选择安装路径、创建桌面快捷方式与开始菜单入口)
  - **绿色便携免安装版**：[`Hermes-Agent-Platform-0.1.31-Windows-x64-Portable.exe`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.31/Hermes-Agent-Platform-0.1.31-Windows-x64-Portable.exe) (单文件解压即用)
- **安装与运行说明**：
  1. 下载 `Hermes-Agent-Platform-0.1.31-Windows-x64-Setup.exe` 并双击启动安装向导；
  2. 按照向导提示选择安装目录（如 `D:\Program Files\Hermes Agent Platform`）并勾选创建桌面快捷方式，点击“下一步”直到完成；
  3. 若遇到 **Windows Defender SmartScreen** 弹出“Windows 已保护你的电脑 / 未知发布者”提示：
     - 点击提示框中的 **「更多信息」 (More info)**；
     - 再点击右下角出现的 **「仍要运行」 (Run anyway)** 即可正常进入主界面。

### 🍎 macOS (Apple Silicon & Intel)
- **安装文件**：
  - **Apple Silicon (M1 / M2 / M3 / M4 / M系列芯片)**：
    - DMG 安装镜像：[`Hermes-Agent-Platform-0.1.31-macOS-arm64.dmg`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.31/Hermes-Agent-Platform-0.1.31-macOS-arm64.dmg)
    - 免安装压缩包：[`Hermes-Agent-Platform-0.1.31-macOS-arm64.zip`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.31/Hermes-Agent-Platform-0.1.31-macOS-arm64.zip)
  - **Intel x64 芯片**：
    - DMG 安装镜像：[`Hermes-Agent-Platform-0.1.31-macOS-x64.dmg`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.31/Hermes-Agent-Platform-0.1.31-macOS-x64.dmg)
    - 免安装压缩包：[`Hermes-Agent-Platform-0.1.31-macOS-x64.zip`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.31/Hermes-Agent-Platform-0.1.31-macOS-x64.zip)
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
  - **DEB 安装包**：[`Hermes-Agent-Platform-0.1.31-Ubuntu-amd64.deb`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.31/Hermes-Agent-Platform-0.1.31-Ubuntu-amd64.deb)
- **安装与运行说明**：
  1. 下载 `.deb` 安装包至本地；
  2. 终端运行：
     ```bash
     sudo dpkg -i Hermes-Agent-Platform-0.1.31-Ubuntu-amd64.deb
     sudo apt-get install -f
     ```
  3. 安装完成后在应用程序列表启动，或在终端输入 `hermes-agent-platform`。
