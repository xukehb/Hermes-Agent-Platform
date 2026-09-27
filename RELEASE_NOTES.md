# Hermes Agent Platform v0.1.25 发布说明 / Release Notes

## 🌟 核心更新亮点 (Highlights)

### 1. ⚡ 【机器人消息网关】与【聊天托管 / 数字分身】彻底解耦
- **双引擎分立架构**：彻底隔离【通道设置 -> 微信通道】（面向团队协同/群聊的独立专业 AI 助手，如 iLink Bot / 企业微信等）与【聊天托管】（面向真实微信联系人的第一人称数字分身代管）。两套系统拥有独立的后端服务实例、生命周期与启停控制，支持完全独立或同时并行运行；
- **人设防污染 (Persona Isolation)**：非托管模式下的机器人通道严格锁定使用专业智能体（如 `coder`），绝对禁止继承聊天托管中的第一人称数字分身 Prompt（“你就是我，代我聊天...”）；在保存分身偏好时，严禁篡改 `config.toml` 中的全局通道配置；
- **联系人库保护与纯净性**：微信机器人通道在群聊或私聊中交互的临时用户与群聊，绝不写入 `universal_contacts.json`，彻底保障真实好友列表的纯净；
- **GUI 交互优化**：从微信机器人通道接入模式中彻底移除了容易混淆的“桌面视觉代管”选项，并新增架构解耦说明横幅；聊天托管卡片与机器人服务卡片分别具备独立的启停与运行状态指示。

### 2. 🛡️ 模型连通性测试与 Markdown 渲染防御强化
- **空响应有效性校验**：在模型连通性探测流程中，精确判断响应内容是否包含非空文本。杜绝流式响应正常闭合但没有实际正文输出时误报“连接成功”的问题；
- **Markdown 内容安全转义**：强化普通段落文本行的安全过滤与 HTML 转义，防止大模型输出的原始 HTML 代码直接进入 DOM 树，杜绝潜在的跨站脚本注入风险。

### 3. 👁️ 桌面微信原生视觉代管稳定性与体验升级
- **气泡坐标判定调优**：修复微信边缘聊天气泡被误判或截断的临界阈值问题；
- **回音抑制与死循环防护**：引入基于编辑距离的文本相似度去重与自言自语死循环熔断机制；
- **人工介入接管实时识别**：支持毫秒级识别用户在微信客户端亲自回复并进入防撞车冷静期，防止 AI 与真人抢发消息。

### 4. 📦 Windows 标准 Setup 安装向导与全平台矩阵打包
- **Windows NSIS 安装向导（Setup）**：提供标准的 Windows 安装程序（`.exe`），支持自由选择安装目录、自动创建桌面快捷方式与开始菜单入口，并支持 Windows 卸载向导；
- **多平台自动化构建**：覆盖 Windows (Setup + Portable)、macOS (Apple Silicon dmg/zip + Intel x64 dmg/zip)、Ubuntu Linux (.deb)。

---

## 📦 各系统安装包与下载安装指南 (Download & Installation Guide)

> **安全提示 / Security Notice**：  
> 本项目属于开源软件，安装包未购买商业代码签名证书。在 Windows 或 macOS 首次启动时若出现系统拦截提示，属于正常系统安全策略，请按以下说明放心放行即可。

### 🪟 Windows (x64)
- **安装文件**：
  - **标准安装向导（推荐）**：[`Hermes-Agent-Platform-0.1.25-Windows-x64-Setup.exe`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.25/Hermes-Agent-Platform-0.1.25-Windows-x64-Setup.exe) (经典安装向导，支持选择安装路径、创建桌面快捷方式与开始菜单入口)
  - **绿色便携免安装版**：[`Hermes-Agent-Platform-0.1.25-Windows-x64-Portable.exe`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.25/Hermes-Agent-Platform-0.1.25-Windows-x64-Portable.exe) (单文件解压即用)
- **安装与运行说明**：
  1. 下载 `Hermes-Agent-Platform-0.1.25-Windows-x64-Setup.exe` 并双击启动安装向导；
  2. 按照向导提示选择安装目录（如 `D:\Program Files\Hermes Agent Platform`）并勾选创建桌面快捷方式，点击“下一步”直到完成；
  3. 若遇到 **Windows Defender SmartScreen** 弹出“Windows 已保护你的电脑 / 未知发布者”提示：
     - 点击提示框中的 **「更多信息」 (More info)**；
     - 再点击右下角出现的 **「仍要运行」 (Run anyway)** 即可正常进入主界面。

### 🍎 macOS (Apple Silicon & Intel)
- **安装文件**：
  - **Apple Silicon (M1 / M2 / M3 / M4 / M系列芯片)**：
    - DMG 安装镜像：[`Hermes-Agent-Platform-0.1.25-macOS-arm64.dmg`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.25/Hermes-Agent-Platform-0.1.25-macOS-arm64.dmg)
    - 免安装压缩包：[`Hermes-Agent-Platform-0.1.25-macOS-arm64.zip`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.25/Hermes-Agent-Platform-0.1.25-macOS-arm64.zip)
  - **Intel x64 芯片**：
    - DMG 安装镜像：[`Hermes-Agent-Platform-0.1.25-macOS-x64.dmg`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.25/Hermes-Agent-Platform-0.1.25-macOS-x64.dmg)
    - 免安装压缩包：[`Hermes-Agent-Platform-0.1.25-macOS-x64.zip`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.25/Hermes-Agent-Platform-0.1.25-macOS-x64.zip)
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
  - DEB 安装包：[`Hermes-Agent-Platform-0.1.25-Ubuntu-amd64.deb`](https://github.com/xukehb/Hermes-Agent-Platform/releases/download/v0.1.25/Hermes-Agent-Platform-0.1.25-Ubuntu-amd64.deb)
- **安装与运行说明**：
  1. 下载 `.deb` 安装包至本地；
  2. 终端运行：
     ```bash
     sudo dpkg -i Hermes-Agent-Platform-0.1.25-Ubuntu-amd64.deb
     sudo apt-get install -f
     ```
  3. 安装完成后在应用程序列表启动，或在终端输入 `hermes-agent-platform`。
