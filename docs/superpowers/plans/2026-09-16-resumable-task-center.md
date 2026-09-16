# Resumable Task Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让异常中断、失败或主动取消的任务能够安全创建一个继承原执行参数的新任务继续完成，并通过聊天命令和 HTTP API 调用。

**Architecture:** 在现有每智能体 SQLite 任务表中保存可重建 `RunTaskRequest` 的最小字段，并用 `parentTaskId` 记录恢复链。`AgentOrchestrator.resumeTask()` 负责校验来源任务、生成防重复副作用的恢复提示并复用 `runTask()`；通道层仅转发恢复请求和渲染现有任务事件。

**Tech Stack:** TypeScript、better-sqlite3、Hono、Vitest、现有 AgentOrchestrator 与 ChannelHost。

---

### Task 1: 持久化任务恢复元数据

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/storage/session-store.ts`
- Test: `tests/storage.test.ts`

- [ ] **Step 1: 写入失败测试**

在存储测试中创建带 `input`、`workspace`、`requestedModel`、`requestedTools`、`parentTaskId` 和 `resumeCount` 的任务，关闭并重新打开 SQLite 后断言字段完整；再创建旧版 tasks 表，断言构造存储时自动补列。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run tests/storage.test.ts`

Expected: 新字段不存在或读取结果缺少恢复数据。

- [ ] **Step 3: 实现数据结构与迁移**

给 `TaskRow` 增加可选恢复字段；tasks 表新增对应列；增加 `migrateTaskColumns()`；在 `beginTask()`、`updateTask()` 和 `toTaskRow()` 中完成 JSON 工具数组的序列化与反序列化。

- [ ] **Step 4: 运行存储测试确认 GREEN**

Run: `npx vitest run tests/storage.test.ts`

Expected: PASS。

### Task 2: 编排器恢复 API

**Files:**
- Modify: `src/domain/errors.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/orchestrator.ts`
- Test: `tests/orchestrator.test.ts`

- [ ] **Step 1: 写入失败测试**

覆盖以下行为：

```typescript
const resumed = await orchestrator.resumeTask(sourceTaskId);
expect(resumed.taskId).not.toBe(sourceTaskId);
expect(orchestrator.findTask(resumed.taskId)?.parentTaskId).toBe(sourceTaskId);
expect(orchestrator.findTask(resumed.taskId)?.resumeCount).toBe(1);
```

同时断言恢复任务继承 agent、session、workspace、model、tools，并拒绝不存在、运行中、已完成和缺少原始输入的任务。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run tests/orchestrator.test.ts`

Expected: `resumeTask` 不存在。

- [ ] **Step 3: 实现恢复 API**

新增三个错误码：`TASK_NOT_FOUND`、`TASK_NOT_RESUMABLE`、`TASK_RESUME_DATA_MISSING`。扩展内部 `RunTaskRequest` 元数据，使 `runTask()` 在开始时保存原始输入和执行覆盖参数。实现 `resumeTask()`，只允许 `interrupted`、`failed`、`aborted`，检查恢复链中没有运行任务，然后使用如下提示创建新任务：

```text
恢复任务 <id>。原始目标：<input>

请先检查当前工作区、会话历史与已有产物，判断中断前哪些步骤已经完成；只继续未完成部分。不要重复执行已产生副作用的工具操作。完成后说明复用了哪些现有结果以及继续完成了什么。
```

- [ ] **Step 4: 运行编排器测试确认 GREEN**

Run: `npx vitest run tests/orchestrator.test.ts`

Expected: PASS。

### Task 3: `/resume` 聊天命令

**Files:**
- Modify: `src/channels/command-parser.ts`
- Modify: `src/channels/types.ts`
- Modify: `src/channels/manager.ts`
- Test: `tests/channels-core.test.ts`
- Test: `tests/channels-dispatcher.test.ts`

- [ ] **Step 1: 写入失败测试**

断言 `/resume abc-123` 解析为 `{ kind: 'resume', taskId: 'abc-123' }`，缺少 ID 时仍进入 resume 分支并返回用法提示。分派测试使用桩 `ChannelHost.resumeTask()`，断言事件和结果通过现有 renderer 输出。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run tests/channels-core.test.ts tests/channels-dispatcher.test.ts`

Expected: 命令落入 unknown，ChannelHost 缺少恢复能力。

- [ ] **Step 3: 实现命令与宿主连接**

扩展 `ChannelCommand` 和 `ChannelHost`；`createChannelHost()` 转发到 orchestrator；命令处理复用普通任务的事件 renderer，不另建执行协议。

- [ ] **Step 4: 运行通道测试确认 GREEN**

Run: `npx vitest run tests/channels-core.test.ts tests/channels-dispatcher.test.ts`

Expected: PASS。

### Task 4: HTTP 恢复端点与最终验证

**Files:**
- Modify: `src/channels/http.ts`
- Test: `tests/channels-http.test.ts`
- Modify: `README.md`
- Modify: `verification.md`

- [ ] **Step 1: 写入失败测试**

为 `POST /tasks/:taskId/resume` 增加成功测试，断言宿主收到 taskId 并返回新任务结果；增加 HapError 失败响应测试。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run tests/channels-http.test.ts`

Expected: 404。

- [ ] **Step 3: 实现端点与文档**

HTTP 端点调用 `host.resumeTask()` 并返回现有 TaskOutcome 字段。README 的通道命令和 HTTP 示例增加恢复说明；verification.md 记录验证命令、日期和执行者。

- [ ] **Step 4: 运行相关测试**

Run: `npx vitest run tests/storage.test.ts tests/orchestrator.test.ts tests/channels-core.test.ts tests/channels-dispatcher.test.ts tests/channels-http.test.ts`

Expected: PASS。

- [ ] **Step 5: 运行完整验证**

Run: `npm run typecheck && npm test && npm run build`

Expected: 三个命令退出码均为 0。
