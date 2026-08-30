# 实时 Token 遥测与运行时健康设计

日期：2026-08-30
状态：待书面复核
关联审计：`dogfood-output/platform-control-audit/report.md` ISSUE-003、ISSUE-004

## 背景

智能体循环已经在每次模型调用返回后产生 `TaskEvent.type = usage`，但 GUI 的 `chat` 是一次性
IPC，请求期间没有事件订阅；持久化又只在任务结束时写入。因此页面看不到当前任务、会话、
智能体、服务器和全局用量，GUI 中的 `/usage` 还会被误送给模型。模型选择器的绿色“就绪”
也来自静态配置，不代表最近一次真实健康检查。

## 方案比较与决策

### 方案 A：GUI 定时轮询现有 `usageSince`

实现简单，但运行中任务没有持久化数据，频繁扫多个智能体 SQLite 也会放大全景页面卡顿，
只能得到任务结束后的延迟结果。

### 方案 B：只转发当前 `TaskEvent`

能更新当前对话，但应用重启后没有历史，多个窗口会丢事件，也不能可靠按服务器聚合。

### 方案 C：用量事件总线、增量持久化和快照校准

这是选定方案。所有模型用量统一生成带维度和 event ID 的增量事件，先持久化再发布；GUI
订阅节流快照；任务结束时用最终 Task 用量校准事件之和。既有 `usageSince` 继续由同一数据
读取，避免两个统计口径。

## “实时”的精确定义

Token 数必须来自提供商或本地模型返回的权威 usage，不能按字符数伪造。大多数提供商只在
一次模型请求完成或流结束时返回 usage，因此“实时”指每次收到权威 usage 后 250ms 内更新
GUI，而不是逐 token 猜测。请求尚未返回 usage 时显示“统计中”，任务结束后必须与持久化
最终值一致。

## 目标

- 当前任务运行中按模型调用增量显示 prompt、completion 和 total token。
- 可查询并展示当前会话、智能体、服务器和全局的今日/7日/30日聚合。
- 微信、Telegram、飞书控制任务自动归属绑定服务器；GUI、本地任务和计划任务有明确归属。
- 主调用、上下文压缩、子智能体和回退模型的用量不丢失、不重复。
- GUI `/usage` 走本地命令，不启动模型；消息通道 `/usage` 与 GUI 使用相同查询服务。
- 模型“就绪”只来自近期真实健康信号，失败后立即变更状态。
- 页面更新不重建大型 DOM、不重入全景刷新，也不阻塞 Electron 渲染线程。

## 用量事件模型

```ts
interface UsageTelemetryEvent {
  eventId: string;
  sequence: number;
  at: string;
  taskId: string;
  parentTaskId?: string;
  sessionKey: string;
  agentId: string;
  serverId: string;          // local、远程服务器 ID 或 unknown
  botAccountId?: string;
  providerId: string;
  model: string;
  source: 'model_turn' | 'compaction' | 'subagent' | 'reconciliation';
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
```

`eventId` 是幂等键，`sequence` 是进程内严格递增序号。Token 字段必须是非负安全整数，且
`totalTokens >= promptTokens + completionTokens`；提供商包含 cache/reasoning 等额外 token
时保留 total 的权威值。无 usage 的响应不生成猜测事件。

`RunTaskRequest` 增加显式 `executionContext`，至少包含 `serverId` 和可选 `botAccountId`。
服务器 Bot 控制任务从不可伪造的 binding 上下文取得；GUI 对话默认 `local`；远程节点对话
使用当前选择的服务器；没有可验证来源的旧任务标记 `unknown`，不能错误计入本地服务器。

## 采集链路

`UsageTelemetryService` 由主进程持有，AgentOrchestrator 通过依赖注入使用它：

1. Provider 返回 usage，agent loop 生成增量事件。
2. 上下文压缩产生的 usage 也走同一入口，不能只加到内存总数。
3. 子智能体保留自身 agent/session，同时携带 parentTaskId 和相同服务器上下文。
4. 服务校验并以 eventId 幂等写入，再更新活动任务累加器并发布变更。
5. 任务完成时以该 task 已接受事件的合计写入 `TaskRow.usage`，替代现有“结束时再插入一条
   usage 总计”的路径。若旧 provider 只在最终结果提供用量，则补一条非负 `reconciliation`
   事件；若 loop 报告值小于事件合计，则保留事件合计并记录实现错误，不写负数抵消事件。
6. failed/aborted 任务仍保留已经由提供商报告的用量，不重置为零。

回退模型每次调用记录实际 provider/model。聚合时不会把回退用量错误归给初始模型。

## 持久化与兼容

沿用每个智能体 `sessions.db`，对 `usage` 表执行幂等迁移，增加 `event_id`、`task_id`、
`session_key`、`server_id`、`bot_account_id`、`source` 和 `parent_task_id`，并为 eventId、时间、
session、server、task 建索引。新事件逐条增量写入，不再等任务结束才写一条总计。

迁移前历史 usage 没有任务、会话和服务器维度，保留为 `server_id = unknown`；它计入全局和
智能体历史，不计入某台服务器或某个会话。禁止把全部旧数据假定为本地用量。

`SessionStoreRegistry` 提供一个结构化查询接口：

```ts
queryUsage({ since, until, taskId, sessionKey, agentId, serverId, botAccountId, groupBy })
```

所有 `/usage`、HTTP `/usage` 和 GUI 都调用该接口。返回值包含 prompt、completion、total、
calls、首末时间和维度键。查询使用有界时间范围；GUI 默认今日，不允许无界扫描。

## 活动任务与快照

`UsageTelemetryService` 维护活动任务 Map，只存累计数字和最近事件时间。快照包含：

```ts
interface UsageSnapshot {
  sequence: number;
  generatedAt: string;
  activeTasks: ActiveTaskUsage[];
  globalToday: UsageTotals;
  byServerToday: UsageBucket[];
  byAgentToday: UsageBucket[];
}
```

今日全局、服务器和智能体 bucket 在启动时用一次有界查询初始化，之后随接受的事件增量
更新；事件发布不会反复扫描所有 SQLite。低频后台校准发现差异时替换快照并记录告警。

任务结束后从 activeTasks 移除，但其持久化聚合仍可查询。启动时把数据库中 `running` 任务
标为 interrupted，不把它们恢复成活动任务。每次订阅先返回完整快照，后续事件只提示序号
变化；渲染器发现序号跳跃时重新拉取快照，不自行猜测缺失增量。

## Electron IPC

主进程增加：

- `gui:getUsageSnapshot`
- `gui:queryUsage`
- `gui:usageChanged` 主进程到渲染器事件
- `gui:getProviderHealth`
- `gui:refreshProviderHealth`

preload 只暴露类型化调用和返回 unsubscribe 的监听函数。窗口关闭时移除监听器，防止重复
进入页面后事件倍增。主进程最多每 250ms 向每个窗口发送一次变更通知；数据库查询不在
渲染器执行。

GUI `chat` 在启动 AgentOrchestrator 前解析 `/usage [天数]`。合法命令返回结构化 Usage
消息并打开用量详情；非法参数显示本地错误。该命令不能出现在任务表，也不能消耗 token。

## GUI 呈现

### 对话工作区

对话标题栏增加紧凑用量区域：当前任务 `P / C / Total`、本会话今日总量和统计状态。没有
权威 usage 时显示“统计中”，任务结束后显示最终值；切换会话立即切换订阅过滤器。固定宽度
数字使用等宽字体，最长数字折叠为 `12.4M` 并通过 tooltip 显示精确值，更新不能推动布局。

### 计算节点全景

选中节点后显示该服务器今日 token、活动任务数、7 日总量和按智能体分布；顶部同时保留
全局今日总量。数据与 CPU/内存刷新分离，Token 事件不能触发系统信息采集，也不能重建
全景大屏。无数据、加载、错误和 unknown 历史都有明确状态，不出现白板。

### 智能体与用量详情

智能体列表显示今日 token 和活动任务；用量详情提供今日、7 日、30 日选项，以及按服务器、
智能体、模型和会话的表格。只做有界查询和分页，首版不增加成本估算，避免没有价格版本的
情况下展示错误金额。

所有新增控件复用现有 CSS 变量、按钮尺寸、表格和状态色，不使用内联白色卡片。状态色语义
固定：绿色仅代表已验证健康，黄色代表检查中/重连，红色代表失败，灰色代表未检查或停止。

## 提供商和模型健康

新增 `ProviderHealthService`，状态为 `unchecked | checking | ready | degraded | unavailable`。
绿色“就绪”必须满足以下任一条件：最近 60 秒真实健康探测成功，或最近 60 秒该 provider
完成过真实模型请求。静态配置存在只能显示“未检查”。

本地 OpenAI-compatible/Ollama 服务使用有超时的模型列表或轻量探测；云 provider 使用其
现有连接测试。探测采用单飞和短缓存，不随三秒大屏刷新重复请求。真实请求出现连接或认证
错误时立即转为 unavailable；限流/临时 5xx 为 degraded。健康状态与模型回退事件都发布到
GUI，但不影响 Token 序列。

## 错误与边界

- usage 写入失败时任务继续，但 GUI 显示遥测降级并记录不含正文的错误；不能静默显示零。
- IPC 订阅断开后可用快照恢复；重复 eventId 不增加总量。
- 负数、NaN、超安全整数或 provider schema 不合法的 usage 被拒绝并告警。
- 任务中止只移除活动状态，不删除已报告用量。
- 数据保留沿用会话策略；prune 在事务中同步删除过期 usage，活动任务不受影响。
- Token 事件和健康检查不得包含 prompt、completion 文本、API Key 或 Bot 身份凭据。

## 测试

### 单元与集成

- 模型 turn、压缩、子智能体、回退和 failed/aborted 的用量事件完整性。
- eventId 幂等、sequence、Schema 校验、迁移、历史 unknown 处理和最终校准。
- task/session/agent/server/global 的查询边界与总数守恒。
- IPC 初始快照、250ms 节流、序号跳跃恢复、取消订阅和多窗口隔离。
- GUI `/usage` 不调用模型，消息通道和 HTTP 使用同一查询结果。
- provider 健康 TTL、单飞、成功、认证失败、网络失败和真实请求反馈。
- Token 更新与全景硬件刷新互不触发，快速页面切换不泄漏定时器或监听器。

### 端到端验收

1. 在 GUI 发起一个至少包含两次模型调用的任务，观察当前任务数字分次增长并与最终值一致。
2. 刷新或重启 GUI，历史会话、智能体和全局总数保持一致，活动任务状态不伪造。
3. 从绑定到远程服务器的微信、Telegram、飞书各执行一个任务，用量只计入对应服务器。
4. 在 GUI 输入 `/usage 7`，确认未创建 Agent 任务且展示值与数据库查询一致。
5. 启动不可用本地模型，选择器显示未检查/不可用而非绿色；服务恢复并探测成功后变为就绪。
6. 在桌面、900x700 和 720x600 视口持续运行任务并切换页面，计数不溢出、页面不卡死、不白屏。

## 完成标准

- 当前任务、会话、智能体、服务器和全局五个层级均有权威 Token 数据入口和 GUI 展示。
- 运行中用量在 provider 报告后 250ms 内可见，最终值与持久化查询严格一致。
- `/usage` 在 GUI、消息通道和 HTTP 中含义一致，GUI 调用不消耗 token。
- 绿色模型状态必有近期真实健康证据，首次请求失败会立即反映到 UI。
- 全量测试、类型检查、构建和三视口 Electron 回归通过，无新增卡死、重叠或白板。
