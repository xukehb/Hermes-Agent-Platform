# Hermes Agent Platform v0.1.23 发布说明 / Release Notes

## 🌟 核心更新亮点 (Highlights)

### 1. 🤖 微信聊天托管（SightFlow 视觉代管与数字分身）无回复问题彻底修复
- **多模型自动降级链 (Primary + Fallbacks)**：为托管分身（如“小莹”）配置主备模型候选链。当主模型遭遇第三方网络抖动、HTTP 403 额度枯竭或不可恢复错误时，编排层自动沿降级链无缝切换至可用提供商（如 DeepSeek 官方通道），保留上下文对话并确保即时通讯代答永不中断；
- **全平台凭据自动热加载**：编排器与模型提供商注册表全面贯通，系统启动与运行时自动合并读取 `~/.hap/gui/env.json` 与 `credentials.json`，解决非系统环境变量下 API Key 无法穿透到子进程与编排器的隐蔽问题；
- **出站阶段系统报错智能拦截**：在消息最终出站阶段严格审查 `isErrorMessage`，严禁将“本次没有产生正文输出”、“服务商拒绝了当前凭据”或 HTTP 403/500 等调试报错文本发给真实微信联系人或记为草稿，同时向前端托管 Activity 时间线实时推送结构化的“生成失败”告警；
- **macOS 原生 OCR 智能窗口评分算法**：重构 `macos_ocr.m` 原生窗口定位机制，引入加权评分系统。优先匹配微信主会话界面（+2000 分），强力抑制并扣除 Word 需求文档、图片/视频预览弹窗（-1500 分），杜绝抓取预览文档内容导致好友身份识别错位；
- **会话指纹隔离与回音误杀修复**：短语去重指纹强制绑定 `chatTarget`，彻底解除“好的”、“在吗”、“收到”等日常高频短语跨联系人全局冲突屏蔽；优化 OCR 回音比对算法，杜绝将好友发送的 2~3 字常用语误判为我方回复的回音片段。

### 2. 🚀 桌面 GUI 多会话全并发无阻塞并行与独立中止 (Multi-Session Parallelism & Isolated Abort)
- **多会话同时生成**：彻底打破旧版单流式会话互斥阻塞与排队机制，桌面端后台引入并发任务池 (`activeChatTasks` Map)，支持用户创建并切换多个智能体对话窗口，所有会话均可在后台无阻塞、全并发运行；
- **精准事件流路由与状态隔离**：流式推送事件深度携带 `sessionKey`，界面根据当前激活会话精确路由渲染，会话切换即时展现真实流式/完成状态；
- **独立会话中止控制**：点击停止按钮仅中止当前会话的生成推理任务，绝不干扰其他正在运行的会话，同时支持工作台退出与切换时的级联批量保护。

### 3. 🎨 语义色彩体系与深浅高对比度固化 (Visual Semantics & Contrast Enhancement)
- **深浅主题对比度增强**：全面梳理 `--bg-*`、`--border-*`、`--text-*` 语义变量，修复浅色模式下边框发虚泛白以及深色模式下弱层级视觉疲劳问题；
- **无障碍与系统偏好感知**：全面适配系统的 `prefers-contrast: more`（高对比度）和 `prefers-reduced-motion: reduce`（弱动效）规范，保障长时间高强度交互的视觉舒适度与无障碍支持。

### 4. 🧩 前端大单体架构模块化解耦 (Frontend Architecture Modularization)
- **子模块独立拆分**：在 `src/gui/renderer/modules/` 中建立清晰的子模块体系：
  - `theme-controller.js`：统一掌控主题模式（light/dark/system）、高对比度切换与颜色持久化；
  - `git-controller.js`：独立接管 Git 状态监控、分支切换、Commit 提交、Remote 同步与日志渲染；
  - `terminal-controller.js`：封装内嵌终端会话、PTY 缓冲区管理与快捷命令流；
- 架构可维护性与测试解耦度大幅提升，避免庞大单体脚本的代码膨胀。

### 5. 🪟 Windows 微信窗口 RECT 智能定位与精准截屏 (Windows Desktop Vision Enhancement)
- **原生窗口坐标智能定位**：深度重构 Windows 下基于 `user32.dll` / PowerShell 原生 API 的窗口检测机制，精准获取 `GetWindowRect` 几何坐标与 DPI 缩放比例；
- **自动窗口区域裁剪**：实现仅针对桌面微信窗口边界的局部高保真裁剪，告别全屏冗余截屏带来的性能消耗与多屏幕坐标漂移，大幅提升视觉代管模式的识别精确度与响应速度。

### 6. ⚡ Agent 记忆库 SQL 谓词下推与 60s LRU 内存缓存 (Memory Store SQL Pushdown & Caching)
- **底层 SQLite 谓词下推**：将原先在应用层内存循环比对的 scope / tags 过滤条件彻底下推至 SQLite 引擎 `WHERE` 子句与联合索引，消灭大数据量下的全表扫描瓶颈；
- **高性能 LRU 内存缓存**：内建 60 秒 TTL 与最大 500 条目容量的 LRU 高速缓存层，增删改自动精准失效，大幅降低磁盘 I/O 延迟与数据库加锁开销。

---

## 📦 各系统安装包与下载安装指南 (Download & Installation Guide)

> **安全提示 / Security Notice**：  
> 本项目属于社区开源软件，安装包未购买商业代码签名证书。在 Windows 或 macOS 首次启动时若出现系统拦截提示，属于正常安全机制，请按以下说明放心放行。

### 🪟 Windows (x64)
- **安装文件**：
  - `Hermes-Agent-Platform-0.1.23-Windows-Setup-x64.exe` (或 `Hermes-Agent-Platform-0.1.23-Setup.exe`)
- **安装与运行说明**：
  1. 下载后双击运行安装向导，按照提示完成安装并自动创建桌面快捷方式。
  2. 若遇到 **Windows Defender SmartScreen** 弹出“Windows 已保护你的电脑 / 未知发布者”拦截提示：
     - 点击提示框中的 **「更多信息」 (More info)**；
     - 再点击右下角出现的 **「仍要运行」 (Run anyway)** 即可正常打开。

### 🐧 Ubuntu / Debian Linux (x64)
- **安装文件**：
  - `Hermes-Agent-Platform-0.1.23-Ubuntu-x64.deb`
- **安装与运行说明**：
  1. 下载 `.deb` 安装包至本地。
  2. 打开终端运行以下命令安装：
     ```bash
     sudo dpkg -i Hermes-Agent-Platform-0.1.23-Ubuntu-x64.deb
     sudo apt-get install -f  # 若缺少依赖项，执行此命令自动修复并完成安装
     ```
  3. 安装完成后可在系统应用程序列表启动，或在终端输入 `hermes-agent-platform` 运行。

### 🍎 macOS (Apple Silicon & Intel)
- **安装文件**：
  - **Apple Silicon (M1 / M2 / M3 / M4 / M系列芯片)**：
    - DMG 安装镜像：`Hermes-Agent-Platform-0.1.23-macOS-arm64.dmg`
    - 免安装压缩包：`Hermes-Agent-Platform-0.1.23-macOS-arm64.zip`
  - **Intel x64 处理器**：
    - DMG 安装镜像：`Hermes-Agent-Platform-0.1.23-macOS-x64.dmg`
    - 免安装压缩包：`Hermes-Agent-Platform-0.1.23-macOS-x64.zip`
- **安装与运行说明**：
  1. 双击打开 `.dmg` 镜像，将 `Hermes Agent Platform` 拖拽复制到 `Applications`（应用程序）文件夹中。
  2. 若首次打开提示“无法打开，因为 Apple 无法检查其是否包含恶意软件”或“应用已损坏，移到废纸篓”：
     - **方法 A**：前往系统 **「系统设置」 -> 「隐私与安全性」**，在下方找到“已阻止使用 Hermes Agent Platform”，点击 **「仍要打开」**；
     - **方法 B（推荐）**：打开终端，输入以下命令绕过 Gatekeeper 隔离标记后即可畅快运行：
       ```bash
       sudo xattr -rd com.apple.quarantine "/Applications/Hermes Agent Platform.app"
       ```
