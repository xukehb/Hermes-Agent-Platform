# 服务器 Bot 控制平面设计

日期：2026-08-30
状态：待书面复核
关联审计：`dogfood-output/platform-control-audit/report.md`

## 背景

当前系统存在三套互不一致的状态：TOML 中的全局通道、`~/.hap/gui/bots.json` 中的 GUI Bot
实例，以及远程服务器 JSON 中的 `boundBotId` 和内嵌 `botConfig`。GUI 保存 Bot 后直接显示
“运行中”，但没有启动真实通道；同一服务器可以绑定多个 Bot；Telegram 留空允许所有用户，
飞书没有操作者策略。这些状态不能组成可验证的服务器控制链路。

本设计只把微信 iLink、Telegram 和飞书纳入服务器控制平面。QQ、钉钉、Slack、Discord、
Webhook 和企业微信现有能力继续保留为普通消息或通知适配器，不能在没有完成同等授权模型
前获得服务器控制能力。

## 方案比较与决策

### 方案 A：修补现有 JSON 与全局 `ChannelManager`

优点是改动少；缺点是一个平台仍只能运行一个账号，JSON 无法可靠执行唯一约束，运行状态
继续容易和配置状态混淆，远程工具也无法知道消息绑定的服务器。该方案不能满足目标。

### 方案 B：为每个平台启动外部桥接进程

优点是可以复用 OpenClaw 等现有连接器；缺点是引入第二套配置、日志、进程生命周期和消息
路由，服务器授权难以在 Hermes 内部闭环。该方案不采用。

### 方案 C：原生账号注册表、运行时主管和服务器作用域宿主

这是选定方案。Hermes 保存统一账号元数据和一对一绑定，按账号启动原生运行时；每条入站
消息在进入智能体前附带不可伪造的服务器和操作者上下文；工具执行器在最终执行点再次执行
权限检查。它需要一次存储迁移和 ChannelManager 拆分，但能从数据层、运行时和工具层同时
保证约束。

## 目标与非目标

### 目标

- 一台本地或远程服务器最多绑定一个控制 Bot，一个 Bot 账号也最多绑定一台服务器。
- 微信、Telegram、飞书账号都具有真实连接、停止、重连、健康和错误状态。
- 默认拒绝所有发送者；完成本地发起的配对后，操作者才能查看或控制绑定服务器。
- 自然语言任务和显式命令都只能作用于绑定服务器，消息正文不能切换目标服务器。
- 同一个 Bot 同时承担入站控制和该服务器的告警回传，不再维护第二套 webhook 告警配置。
- 凭据、二维码、操作者身份、命令审批和工具调用均可审计且不泄漏敏感内容。

### 非目标

- 不实现一个 Bot 群控多台服务器；跨服务器操作必须从 GUI 发起。
- 不允许 Bot 操作者新增服务器、替换绑定、导出凭据或降低自身安全策略。
- 不把“配置已保存”展示为“运行中”，也不在连接测试失败后自动启用账号。
- 不承诺各平台支持相同的富媒体；首版控制输入和回复以文本为准。

## 统一领域模型

### `BotAccount`

```ts
interface BotAccount {
  id: string;
  platform: 'wechat_ilink' | 'telegram' | 'feishu';
  name: string;
  enabled: boolean;
  credentialRef: string;
  transport: 'ilink' | 'polling' | 'websocket' | 'webhook';
  defaultAgentId: string;
  createdAt: string;
  updatedAt: string;
}
```

账号元数据绝不包含 token、secret、context token 或二维码。`runtimeStatus` 不是数据库字段，
而是 `BotRuntimeSupervisor` 的只读快照：

```text
draft -> validating -> stopped -> starting -> online
                    \-> auth_required
starting/online -> reconnecting -> online
any runtime state -> error or stopped
```

只有适配器完成平台握手并开始接收消息后才能进入 `online`。

### `ServerBotBinding`

```ts
interface ServerBotBinding {
  id: string;
  serverId: string;       // "local" 或 RemoteServerConfig.id
  botAccountId: string;
  capabilityProfile: 'observe' | 'operate';
  approvalPolicy: 'local_for_dangerous' | 'local_for_all_mutations';
  alertPolicy: AlertPolicy;
  createdAt: string;
  updatedAt: string;
}
```

SQLite 元数据仓库位于 `~/.hap/control-plane/control-plane.db`，启用 WAL、外键和 Schema
版本。`server_id` 与 `bot_account_id` 分别有唯一索引，因此一对一关系在事务提交时强制成立，
不能依赖 GUI 下拉框。`local` 是稳定虚拟服务器 ID。远程服务器删除前必须先停止运行时并
删除绑定；账号删除同理。

`RemoteServerConfig.boundBotId` 变为只读迁移兼容字段，最终移除。`ServerBotConfig` 中的
channel/webhook/agent 字段停止写入；告警阈值迁移到 binding 的 `AlertPolicy`。所有绑定查询
只读 `ServerBotBindingStore`，杜绝双向来源。

### `BotOperator`

```ts
interface BotOperator {
  id: string;
  botAccountId: string;
  platformUserId: string;
  displayName?: string;
  role: 'viewer' | 'operator' | 'admin';
  pairedAt: string;
  revokedAt?: string;
}
```

唯一键为 `(bot_account_id, platform_user_id)`。平台身份使用 Telegram 数字 user ID、飞书
tenant 作用域内的 `open_id`、微信账号作用域内的 `from_user_id`，不使用可修改的昵称或
用户名。群消息仍以实际发送者身份授权，群 ID 不能代表操作者。

## 凭据存储与迁移

`BotCredentialStore` 位于 `~/.hap/control-plane/credentials/`。目录权限为 `0700`，每个
账号一个 `0600` 文件，使用同目录临时文件、`fsync` 和原子 `rename`。渲染进程只能提交
新凭据，不能读回完整值；编辑页只显示“已配置”和脱敏标识。日志、IPC 返回值和错误禁止
携带凭据。

迁移器按以下顺序执行一次：

1. 备份但不删除现有 `bots.json`、TOML 通道和 `RemoteServerConfig`。
2. 只导入字段完整且平台受支持的账号，合成或空凭据导入为 `draft`，不能启用。
3. 对重复服务器绑定保留服务器当前 `boundBotId` 指向的账号；其余账号保持未绑定并记录
   可见迁移告警，不能随意选择赢家。
4. 将节点 `botConfig` 的告警阈值迁移到已有绑定；没有真实账号时只保留为待配置草稿。
5. 迁移事务成功后写 Schema 版本，重复启动必须幂等。

## 账号运行时

`BotRuntimeSupervisor` 维护 `Map<accountId, BotRuntime>`，负责验证、启动、停止、重启和状态
发布。它不保存业务配置，也不直接执行智能体任务。每个 runtime 由平台适配器、账号专属
`ChannelDispatcher`、`ScopedChannelHost` 和出站缓冲组成。`enabled` 只控制持久消息 runtime；
未启用的草稿账号仍可启动一个有界的临时验证/扫码 session，验证完成后回到 `stopped`，不会
在后台接收普通消息。

- 微信：使用《微信 iLink Chatbot 多账号接入设计》的原生 driver。
- Telegram：使用 Grammy polling，启动前调用 `getMe`；同 token 被另一个进程占用时进入
  明确错误，不显示在线。Webhook 作为高级部署选项。
- 飞书：桌面默认使用官方 SDK 长连接，App ID/Secret 换取 tenant token 后再开始接收事件；
  webhook 只作为具备公网回调条件的高级选项。

启动失败不会影响其他账号。短暂网络问题进入 `reconnecting` 并指数退避；认证失败进入
`auth_required`；手动停止通过 AbortSignal 结束所有循环并等待有界 drain。账号配置变化
使用 generation ID，旧异步结果不能覆盖新状态。

## 配对与授权

新绑定默认没有操作者，除 `/pair <code>` 外的所有入站消息均返回固定拒绝提示且不进入
智能体。管理员在本地 GUI 生成一次性配对码，配对码使用安全随机数、只存哈希、十分钟
过期、成功一次即失效，并绑定具体账号和预期角色。不能从聊天端生成或提升配对权限。

角色能力如下：

| 角色 | 能力 |
| --- | --- |
| viewer | 查看绑定服务器状态、告警、任务状态和 Token 用量 |
| operator | viewer 能力、发起普通智能体任务、执行策略允许的可变更操作 |
| admin | operator 能力、批准非破坏性变更、查看审计；仍不能改变绑定或导出凭据 |

`observe` profile 只允许 viewer 能力，即使操作者角色更高也不能写入。`operate` profile 才能
执行变更。授权取角色与 profile 的交集。

## 服务器作用域和工具执行

每条被接受的入站消息生成只读 `ControlExecutionContext`：

```ts
interface ControlExecutionContext {
  accountId: string;
  bindingId: string;
  serverId: string;
  operatorId: string;
  role: BotOperator['role'];
  capabilityProfile: ServerBotBinding['capabilityProfile'];
  requestId: string;
}
```

该上下文由 runtime 根据数据库绑定创建，不解析消息正文。它被显式传入 `RunTaskRequest`、
工具选择和 `ToolExecutor`。控制会话中的远程工具忽略模型提供的 server 参数并强制使用
context.serverId；`remote_list_servers` 不暴露其他服务器。本地 `serverId = local` 使用同一
策略包装本地工具。工作区、Shell、文件和进程能力均由绑定 profile 限制。

在最终工具执行点执行第二次授权检查，防止提示注入、错误路由或直接调用绕过。没有上下文、
绑定已变更、操作者被撤销或 requestId 过期时，执行立即拒绝。Bot 无权调用账号管理、凭据、
绑定、权限策略和任意跨服务器工具。

## 审批和危险操作

命令先被规范化并计算参数摘要。需要审批时只保存摘要、操作者、服务器、到期时间和风险级别，
回复一个审批 ID，不立即执行。

- 读取状态、日志摘要和 Token 用量无需审批。
- 普通写操作按 binding policy 要求同一操作者二次确认或本地 GUI 批准。
- 递归删除、凭据/权限修改、Git push、守护进程升级、系统服务变更和任意未分类 shell 默认
  必须本地 GUI 批准；聊天端单人确认不能放行。
- 审批五分钟过期，参数或绑定变化后失效；审批不能重放。

当前 `ChannelDispatcher` 的 `/sh`、`/commit`、`/push` 和自然语言工具调用都必须走同一策略，
不能存在命令分支绕过 ToolExecutor 的路径。

## 告警与回复数据流

服务器监控产生结构化告警后，根据 `serverId` 查询唯一 binding，通过同一个账号 runtime
发送给配置的会话目标。告警目标必须是已配对操作者或经本地 GUI 明确选择的群；空目标不
视为已启用。发送结果来自平台响应，不以写日志代表成功。

入站数据流为：

```text
平台事件 -> 账号适配器 -> 去重/身份提取 -> OperatorAuthorizer
        -> binding + ControlExecutionContext -> ScopedChannelHost
        -> AgentOrchestrator -> ToolExecutor 最终授权 -> 本地或固定远程服务器
        -> 账号适配器回复 + AuditLog
```

## GUI

- “Bot 与通道”只显示统一账号列表，卡片分开呈现配置状态、绑定服务器和真实运行状态。
- 新建账号流程依次为：选择平台、选择未绑定服务器、配置/扫码、真实验证、设置操作者、启用。
- 第二个账号选择已绑定服务器时显示冲突并提供显式“替换绑定”；替换是一个停止旧 runtime、
  修改绑定、启动新 runtime 的事务工作流，失败时恢复旧绑定。
- 节点全景大屏的“Bot 设置”直接打开该服务器的 binding，不再使用 localStorage webhook 表单。
- 未配置凭据、未验证连接、没有操作者或 runtime 未在线时，不显示绿色在线和自动修复已启用。
- 所有异步按钮有 pending、成功、错误和重复点击锁；关闭页面不取消后台 runtime。

## 错误与审计

错误分为 `validation`、`binding_conflict`、`auth_required`、`network`、`policy_denied`、
`approval_required` 和 `runtime`，GUI 据此显示可操作提示。账号运行时错误互相隔离。

审计记录账号、服务器、操作者、请求 ID、规范化命令类型、工具名、风险级别、审批结果、
执行状态、耗时和 Token 数，不记录私聊正文、完整参数、凭据、二维码或 context token。
审计文件设置 `0600` 并按保留期轮转。

## 测试与验收

### 自动化

- SQLite 唯一约束、事务替换、级联删除、幂等迁移和损坏数据隔离。
- 三个平台身份提取、默认拒绝、配对过期/重放、角色/profile 交集和撤销即时生效。
- 运行时真实状态、并行账号隔离、停止中止、认证失效、退避重连和 generation 竞争。
- 服务器作用域贯穿 RunTaskRequest 与 ToolExecutor，恶意正文和工具参数不能切换服务器。
- 所有命令与自然语言工具路径经过授权和审批；危险操作无法仅从聊天端放行。
- GUI 重复绑定、虚假运行状态、独立 botConfig、重复点击和错误恢复回归。

### 真实验收

1. 分别连接一个微信、Telegram、飞书测试账号并绑定三台不同测试服务器。
2. 未配对用户发送状态或任务均被拒绝；三平台分别完成一次性配对后才可使用。
3. 每个 Bot 查询到的主机名与绑定服务器一致，要求操作其他服务器必须被策略层拒绝。
4. 执行一次只读查询、一次需确认写操作和一次必须本地审批的危险操作，结果符合策略。
5. 重启应用后绑定、操作者和凭据恢复，runtime 重新连接，状态不提前显示在线。
6. 制造 token 失效、网络中断和重复 polling，GUI 显示准确错误并可恢复。
7. 对同一服务器或账号发起重复绑定，数据库拒绝且原绑定仍完整。
8. 节点告警只由绑定 Bot 发给授权目标；检查日志和 IPC 不含敏感数据。

## 完成标准

- `bots.json` 和 `RemoteServerConfig.botConfig` 不再是运行时事实来源。
- 任意时刻数据库中每个服务器和每个控制 Bot 最多各有一个有效绑定。
- Bot 卡片的 `online` 必须对应活跃平台连接；保存配置不能制造在线状态。
- 未授权发送者、跨服务器参数和未批准危险操作在最终执行点均被拒绝。
- 三个平台都完成真实连接、入站任务、绑定服务器操作和出站回复验收。
