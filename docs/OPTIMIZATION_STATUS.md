# 优化清单执行状态

更新时间：2026-09-23（Codex）

## 已完成并已推送

- 调度任务按任务 ID 和本地日期分钟去重，并持久化独立的 `lastTriggeredAt`，避免长任务完成时间影响跨天或重启去重。
- 调度任务增加运行中互斥，长任务不会在下一次 tick 重叠启动。
- 微信屏幕截图在 macOS、Windows、Linux 和非 Electron 环境提供系统级降级路径。
- 生产构建使用 `tsconfig.build.json`，排除测试文件，并在构建前清理旧 `dist` 内容。
- Release 校验增加 lint 和生产构建步骤。
- 普通 `gui:dev` 启动不再每次重建原生模块，需重建时使用 `gui:dev:rebuild`。
- 记忆存储当前使用 SQLite WAL 和写入队列，已有并发添加回归测试。

## 仍需继续处理

- GUI 交互测试仍以静态契约为主，需要补充 Electron/DOM 端到端覆盖。
- ESLint 当前通过 `npm run typecheck` 纳入 TypeScript 类型门禁；更细粒度的 TypeScript ESLint 规则仍需额外依赖。
- GUI renderer 和 GUI service 仍需按职责拆分，属于较大范围重构。
- 长期记忆仍以本地 N-gram embedding 为离线实现，语义 embedding 接入和评测集尚未完成。

## 验证限制

当前环境通过运行时路径可执行 TypeScript 编译；完整 `tsc -p tsconfig.json --noEmit`、ESLint 和调度/构建契约测试已通过。完整 Vitest 仍受 pnpm 安装策略跳过 `better-sqlite3` 等原生构建脚本影响，相关失败属于运行时原生绑定缺失；Release workflow 会在标准依赖安装环境中执行完整检查。
