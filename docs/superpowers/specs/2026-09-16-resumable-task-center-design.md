# 可恢复任务中心设计

- 日期：2026-09-16
- 执行者：Codex
- 状态：待用户确认

## 目标

为被平台崩溃或进程退出打断的任务提供安全恢复能力。恢复操作创建一个新任务，沿用原任务的智能体、会话、工作目录、模型覆盖和原始请求，并记录新旧任务的来源关系。

恢复不会盲目重放崩溃前未确认完成的工具调用。新任务会先检查当前工作区和会话状态，再继续尚未完成的目标，从而降低重复写文件、重复执行命令或重复发送外部请求的风险。

## 范围

首期实现以下能力：

1. 持久化任务的原始执行请求和恢复关系。
2. 将异常退出后残留的 `running` 任务标记为 `interrupted`，并保留为可恢复任务。
3. 通过编排器 API 恢复指定任务，生成新的任务 ID。
4. 提供 `/resume <taskId>` 通道命令和 HTTP 恢复端点。
5. 在状态与 trace 中展示来源任务和恢复任务关系。
6. 防止运行中、已完成或不存在的任务被错误恢复。

首期不保存 JavaScript 调用栈，也不从某个工具调用内部继续。工具是否已产生副作用在进程崩溃后无法可靠证明，因此恢复边界固定在“重新进入 Agent Loop 前”。

## 数据模型

在 `tasks` 表中新增以下字段：

```typescript
interface TaskRow {
  // 现有字段省略
  input?: string;
  workspace?: string;
  requestedModel?: string;
  requestedTools?: string[];
  parentTaskId?: string;
  resumeCount?: number;
}
```

- `input`：用户最初提交给编排器的有效指令。
- `workspace`：任务执行目录。
- `requestedModel`：调用时显式覆盖的模型。
- `requestedTools`：调用时显式覆盖的工具集合。
- `parentTaskId`：恢复任务指向直接来源任务。
- `resumeCount`：当前恢复链的恢复次数，用于限制循环恢复和展示。

SQLite 初始化使用 `ALTER TABLE` 兼容已有数据库。内存存储沿用同一 `TaskRow`，保持测试和 `--no-persist` 行为一致。

## 恢复契约

编排器新增：

```typescript
resumeTask(taskId: string, options?: {
  onEvent?: TaskEventSink;
  signal?: AbortSignal;
}): Promise<TaskOutcome>
```

恢复前验证：

- 找不到任务：返回 `TASK_NOT_FOUND`。
- 状态不是 `interrupted`、`failed` 或 `aborted`：返回 `TASK_NOT_RESUMABLE`。
- 缺少持久化的原始指令：返回 `TASK_RESUME_DATA_MISSING`。
- 同一来源任务已有运行中的恢复任务：返回 `TASK_ALREADY_RESUMING`。

恢复时调用现有 `runTask`，但传入持久化请求，并附加内部恢复元数据。新任务的用户消息不是原始指令的机械副本，而是以下恢复指令：

```text
恢复任务 <旧任务ID>。原始目标：<原始指令>

请先检查当前工作区、会话历史与已有产物，判断中断前哪些步骤已经完成；只继续未完成部分。不要重复执行已产生副作用的工具操作。完成后说明复用了哪些现有结果以及继续完成了什么。
```

原任务保留终态；新任务记录 `parentTaskId`。恢复成功或失败都不会改写原任务，便于审计和再次选择恢复点。

## 执行流程

```mermaid
sequenceDiagram
    participant User as 用户/通道
    participant Orch as AgentOrchestrator
    participant Store as SessionStore
    participant Loop as AgentLoop

    User->>Orch: resumeTask(oldTaskId)
    Orch->>Store: 读取原任务与恢复链
    Store-->>Orch: interrupted + 持久化请求
    Orch->>Orch: 验证状态与并发恢复
    Orch->>Loop: runTask(恢复提示 + 原执行参数)
    Loop->>Store: 创建新任务(parentTaskId=oldTaskId)
    Loop-->>User: 新任务结果与新 taskId
```

## 外部入口

### 通道命令

新增 `/resume <taskId>`。命令缺少 ID 时返回用法提示；成功后使用现有流式消息机制展示恢复任务进度和结果。

### HTTP 通道

新增：

```http
POST /tasks/:taskId/resume
```

返回新任务的 `taskId`、状态、输出、错误和 trace 路径，格式与现有消息执行结果保持一致。

### 编排器状态

`status()` 返回的最近任务行包含 `parentTaskId` 和 `resumeCount`。`trace()` 摘要增加来源任务 ID，便于界面和通道展示恢复链。

## 错误处理

恢复校验错误使用 `HapError`，保证 CLI、HTTP 和聊天通道获得一致的用户可读提示。恢复任务执行阶段仍沿用现有模型重试、降级链、中止和 trace 逻辑。

平台启动时继续将残留 `running` 任务标记为 `interrupted`。标记过程不得清除输入、工作区和模型覆盖信息。

## 测试

采用测试先行，覆盖：

1. SQLite 新字段写入、读取和旧库迁移。
2. `markInterrupted` 保留恢复数据。
3. 中断任务恢复后生成新任务，并正确记录 `parentTaskId`。
4. 恢复任务继承 agent、session、workspace、model 和工具限制。
5. 已完成、运行中、不存在及缺少输入的任务被拒绝。
6. `/resume` 命令解析与通道分派。
7. HTTP 恢复端点成功与失败响应。
8. 完整类型检查、相关测试、全量测试和构建。

## 后续演进

后续可在该数据模型上增加任务队列、自动重试策略、幂等工具声明、步骤级检查点和 GUI 任务中心。只有工具能够提供幂等键或结果确认协议后，才考虑自动恢复到具体工具调用之后。
