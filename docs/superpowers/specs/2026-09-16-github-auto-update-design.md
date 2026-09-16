# GitHub 一键更新设计规格

> 日期：2026-09-16  
> 执行者：Codex

## 目标

Hermes Agent Platform 桌面应用每次启动后自动检查一次 GitHub Releases。发现高于当前版本的正式版本时，在应用内弹窗展示版本与发行说明；用户可在弹窗中下载更新、查看进度，并在下载完成后重启安装。

首个包含该能力的版本为 `0.1.4`，更新源固定为 `xukehb/Hermes-Agent-Platform` 的公开 GitHub Releases。

## 技术方案

采用 Electron 生态的 `electron-updater`，由 Electron 主进程持有更新器并负责检查、下载和安装。Renderer 仅展示状态并发出用户命令，不直接访问 GitHub 或执行安装程序。

不自行实现版本比较、断点下载、校验和安装替换。GitHub Actions 使用 `electron-builder` 生成各平台安装包及 updater 元数据，并集中发布到同一个 GitHub Release。

## 更新生命周期

1. 主窗口完成加载后，主进程调用一次更新检查；开发模式和未打包运行静默跳过。
2. 没有更新时不弹窗，不打扰用户。
3. 检测到新版本时，主进程向 renderer 发送 `available` 状态，包含当前版本、新版本、发布时间和发行说明。
4. Renderer 打开更新弹窗。用户可以选择“稍后”或“一键更新”。
5. 点击“一键更新”后，主进程开始下载，并持续发送百分比、速度、已下载字节数和总字节数。
6. 下载完成后，弹窗显示“重启并安装”。用户点击后调用更新器退出应用并安装。
7. 检查失败只写入主进程日志，不弹窗；用户已进入下载流程后的错误在弹窗中展示，并提供重试。

## 组件边界

### 主进程更新模块

新增独立更新控制器，封装 `electron-updater`：

- 只允许执行一次启动检查，避免重复监听和重复弹窗。
- 将 updater 事件归一化为稳定的应用更新状态。
- 提供 `check`、`download` 和 `quitAndInstall` 三个操作。
- 在测试中可注入 updater 适配器，不依赖真实网络或真实安装程序。

### IPC 与 preload

新增最小 IPC 契约：

- Renderer 订阅更新状态事件。
- Renderer 请求下载更新。
- Renderer 请求退出并安装。
- Renderer 可获取当前更新状态，避免窗口加载与事件发送之间的竞态。

preload 继续通过 `contextBridge` 暴露有限 API，不向 renderer 暴露 Electron updater 实例。

### Renderer 弹窗

沿用现有原生 `<dialog>`、按钮、进度条和多语言模式，不引入新 UI 框架。弹窗包含：

- 当前版本与新版本。
- GitHub Release 更新说明。
- 下载进度、速度和大小。
- “稍后”“一键更新”“重试”“重启并安装”四种按状态出现的操作。

弹窗尺寸固定且响应式，状态变化不改变整体布局宽度，避免按钮和文本跳动。

## 平台行为

### Windows

- NSIS 安装版支持下载后重启安装。
- Portable 版本不执行原地替换；检测到更新后下载对应 Portable EXE，完成后打开文件所在位置并提示用户关闭旧版本后运行新版。
- GitHub Release 同时保留 Setup 和 Portable 两个用户可见资产。

### macOS

- 用户下载页保留 arm64/x64 DMG。
- 构建任务额外生成 updater 使用的 ZIP 和 `latest-mac.yml`。
- 下载完成后由 `electron-updater` 发起重启安装。
- 当前未签名构建可能被 Gatekeeper 拦截；更新弹窗和 Release 说明继续明确此限制。

### Ubuntu

- 保留 amd64 DEB。
- 使用当前 `electron-updater` 对 DEB 的支持与 `latest-linux.yml` 元数据进行更新。
- 若运行环境不支持自动替换，下载完成后打开 DEB 并交由系统包安装器处理，不执行提权命令。

## 发布资产

`v0.1.4` Release 至少包含：

- Windows x64 Setup EXE、Portable EXE、`latest.yml` 和对应 blockmap。
- Ubuntu amd64 DEB、`latest-linux.yml` 和适用的校验元数据。
- macOS arm64/x64 DMG、arm64/x64 ZIP、`latest-mac.yml` 和适用的 blockmap。

集中发布 job 必须上传安装包和更新元数据，并通过自动化测试验证没有 `ChatGPTConnect` 或 `CodexConnect` 命名资产。

## 错误处理

- GitHub 不可访问、限流或超时时，启动检查静默失败并写日志。
- Release 缺少当前平台资产或元数据时，进入明确错误状态，不尝试猜测下载文件。
- 下载失败允许重试，不关闭应用、不删除用户数据。
- 安装动作仅由用户点击触发，不在后台强制退出。
- 更新状态事件只携带可序列化数据，错误文本不包含凭据或请求头。

## 测试与验收

- 单元测试覆盖无更新、有更新、下载进度、下载失败、下载完成和安装命令。
- 契约测试覆盖 package 版本、GitHub publish 配置、平台目标、更新元数据上传规则和品牌白名单。
- Renderer 测试覆盖弹窗各状态、按钮行为、进度格式和错误重试。
- 类型检查、lint、全量测试和生产构建必须通过。
- 在 GitHub 原生 Windows、Ubuntu、macOS arm64 和 macOS x64 runner 上构建 `v0.1.4`。
- Release 发布后通过公共 GitHub API 验证正式版状态、所需安装包和 updater 元数据完整。

## 非目标

- 不支持预发布版本通道。
- 不做后台周期轮询。
- 不在未获用户确认时自动下载或自动重启。
- 不实现独立更新服务器、增量更新算法或自定义安装器。
- 本版本不新增代码签名或公证流程。
