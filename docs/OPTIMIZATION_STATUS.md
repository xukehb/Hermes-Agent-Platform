# 优化清单执行状态

更新时间：2026-09-23（Codex）

## 已完成并已推送

- 调度任务按任务 ID 和本地日期分钟去重，重启后读取任务的 `lastRunAt`，避免跨天重复或漏执行。
- 调度任务增加运行中互斥，长任务不会在下一次 tick 重叠启动。
- 微信屏幕截图在 macOS、Windows、Linux 和非 Electron 环境提供系统级降级路径。
- 生产构建使用 `tsconfig.build.json`，排除测试文件，并在构建前清理旧 `dist` 内容。
- Release 校验增加 lint 和生产构建步骤。
- 记忆存储当前使用 SQLite WAL 和写入队列，已有并发添加回归测试。

## 仍需继续处理

- GUI 交互测试仍以静态契约为主，需要补充 Electron/DOM 端到端覆盖。
- TypeScript 尚未纳入 ESLint 规则，当前依赖 `tsc --noEmit` 做类型门禁。
- GUI renderer 和 GUI service 仍需按职责拆分，属于较大范围重构。
- 长期记忆仍以本地 N-gram embedding 为离线实现，语义 embedding 接入和评测集尚未完成。

## 验证限制

当前工作环境没有 `node`/`npm` 命令，无法在本机执行 Vitest、TypeScript 编译或 Electron 打包；对应检查已加入 GitHub Release workflow，由 CI 在安装依赖后执行。
