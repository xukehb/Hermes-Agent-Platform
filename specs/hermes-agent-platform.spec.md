# 功能规格：Hermes 多智能体平台（HAP, Hermes Agent Platform）

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v1.1.0 |
| 编写日期 | 2026-08-24（v1.0.0 初稿）／2026-08-24（v1.1.0 修订） |
| 执行者 | Codex |
| 所属仓库 | `C:/Users/xk/Documents/ChatGPT/CodexConnect` |
| 使用技能 | `feature-forge`（结构化需求 + EARS + Given/When/Then + 实施清单） |
| 需求状态 | 已定稿，可进入实现阶段 |

### 修订记录

| 版本 | 变更要点 |
| --- | --- |
| v1.0.0 | 初稿定稿：73 条功能需求、18 条验收标准、四阶段实施清单 |
| v1.1.0 | 落实两项用户决策：手机端首发通道锚定 Telegram；主力运行环境改为云端并纳入 DeepSeek / OpenAI / Anthropic / 智谱 GLM / Google Gemini 五家主流厂商。据此新增 FR-PROV-008、FR-LOOP-015、FR-CHAN-015、FR-CHAN-016 与 AC-019~AC-022，协议适配器实现清单由 3 个调整为 4 个（新增 `anthropic`），§4 参考配置整体重写 |

---

## 0. 概念澄清（必读）

用户原话中的"codex hermes""deepseek hermes"并非上游官方项目名。经检索核对，实际存在的三个参考实体如下，本规格将它们的能力合并为一个平台：

| 用户表述 | 实际对应 | 本平台采纳的能力 |
| --- | --- | --- |
| codex hermes | Hermes 提示协议（Nous Research）驱动 Codex 风格的终端智能体 | Hermes agent loop + 工具执行内核 |
| deepseek hermes | 以 DeepSeek 等第三方模型作为后端跑 Hermes 协议 | 协议适配层，让非 Hermes 模型共用同一 loop |
| opencodex | `ymichael/open-codex`（可配任意模型的 Codex CLI 分支） | 分层配置解析 + 任意提供商接入 |
| openclaw（用户补充） | `openclaw/openclaw`（自托管消息网关 + 多智能体） | 智能体生成器 + 通道插件 + 会话锚定 |

> 若此概念锚定与你的原意不同，请在"§10 待决问题"处指出，规格可按新锚定重写。

### 调研证据来源

全部结论均来自 DeepWiki 对上游仓库的实际检索（工具：`deepwiki.ask_question` / `read_wiki_structure`），逐条证据见 [.codex/context-scan.json](C:/Users/xk/Documents/ChatGPT/CodexConnect/.codex/context-scan.json)。

- `NousResearch/Hermes-Function-Calling`：ChatML 分隔符、`<tools>` 内嵌 JSON Schema、`<tool_call>`/`<tool_response>`/`<scratch_pad>` 标签语义
- `ymichael/open-codex`：`StoredConfig` 的 `provider`/`model`/`baseURL` 字段；密钥走环境变量；`loadConfig` 优先级 CLI > 环境变量 > 配置文件 > 默认值
- `openai/codex`：`[model_providers.*]` 的 `base_url`/`env_key`/`wire_api`/重试字段；`[profiles.*]` 整组切换机制
- `openclaw/openclaw`：`agents.entries.*` 的独立 workspace/状态目录/SQLite 会话库/模型与工具集/子智能体；`ChannelManager` 通道生命周期；入站归一化；`SessionKey` 回复路由锚定

**检索降级记录**：首选 `exa` 搜索返回 401（Invalid API key），已按 AGENTS.md 第 1.2/7 节降级为 `deepwiki` + `fetch`，原因已记录于 [.codex/operations-log.md](C:/Users/xk/Documents/ChatGPT/CodexConnect/.codex/operations-log.md)。

---

## 1. 概述与用户价值

HAP 是一个自托管的多智能体运行平台：用一份配置文件即可接入任意 OpenAI 兼容的模型提供商，声明式地"生成"多个智能体，让每个智能体绑定各自的模型、工具集与职责，并通过手机上的聊天软件直接下发任务、看到流式进度、收到结果。

核心用户价值三条：

1. **模型自由**：换模型只改配置，不改代码。本地 Ollama、DeepSeek、OpenRouter、Gemini、任意自建 OpenAI 兼容端点一视同仁。
2. **智能体即配置**：新增一个"专职智能体"是写一段配置，而不是复制一份代码；每个智能体自带独立工作区与会话历史，互不污染。
3. **口袋里的控制台**：人在通勤路上用手机发一句话，平台在家里的机器上跑完整的工具调用链，结果回到同一个对话里。

### 1.1 目标用户与场景

| 用户角色 | 场景 | 关键诉求 |
| --- | --- | --- |
| 个人开发者 | 手机发指令让家中机器跑代码分析/重构 | 随时下发、进度可见、结果可追溯 |
| 模型评测者 | 同一任务在多个模型间横向对比 | 一键切换 provider/profile，成本与耗时可量化 |
| 自动化爱好者 | 多个专职智能体分工（研究/编码/写作/巡检） | 智能体隔离、能力路由、失败自动降级 |

### 1.2 系统架构

平台分为三层，依赖方向严格单向（Gateway → Core → Runtime → ProviderClient），无反向依赖。

```
┌──────────────────────── Gateway 层（入口） ────────────────────────┐
│  ChannelManager                                                    │
│   ├─ TelegramChannel   ├─ WhatsAppChannel                          │
│   ├─ HttpChannel       └─ CliChannel                               │
│  InboundNormalizer → IngressQueue（有界+去重） → CommandParser      │
└─────────────────────────────────┬──────────────────────────────────┘
                                  ▼
┌──────────────────────── Core 层（决策与状态） ─────────────────────┐
│  ConfigResolver ── ProviderRegistry ── AgentRegistry               │
│  ModelRouter（四级优先级 + fallback 链）                            │
│  TaskOrchestrator（oneshot / persistent） ── SubagentSpawner        │
│  SessionStore（SQLite：会话、消息、任务、trace）                    │
└─────────────────────────────────┬──────────────────────────────────┘
                                  ▼
┌──────────────────────── Runtime 层（执行） ────────────────────────┐
│  HermesAgentLoop                                                   │
│   ├─ PromptComposer（ChatML + <tools> 注入）                        │
│   ├─ StreamTagParser（增量状态机：跨 chunk 标签还原）               │
│   ├─ ProtocolAdapter（hermes-native / openai-tools / deepseek）     │
│   └─ ToolExecutor（本地工具 + MCP 工具）                            │
└─────────────────────────────────┬──────────────────────────────────┘
                                  ▼
                     ProviderClient（OpenAI 兼容 SDK）
```

### 1.3 端到端时序（手机端下发一次任务）

```
手机 App          Gateway           Core              Runtime          模型
   │ 发消息          │                 │                  │               │
   ├────────────────>│ 归一化+入队      │                  │               │
   │                 ├────────────────>│ SessionKey 解析   │               │
   │                 │                 │ Router 选智能体   │               │
   │                 │                 ├─────────────────>│ 组装 ChatML    │
   │                 │                 │                  ├──────────────>│
   │                 │                 │                  │<─ 流式增量 ───┤
   │<── 打字机式编辑同一条消息 ─────────┤<─ <tool_call> ───┤               │
   │                 │                 │  执行工具         │               │
   │                 │                 │                  ├─ <tool_response> 回灌 ─>│
   │<── 最终结果 + 用量卡片 ───────────┤<─ 收敛 ──────────┤               │
```

---

## 2. 功能需求（EARS 格式）

需求编号规则：`FR-<模块>-<序号>`。模块代号：`CFG` 配置、`PROV` 提供商、`AGT` 智能体、`ROUTE` 路由、`LOOP` Hermes 运行时、`TOOL` 工具、`CHAN` 通道、`TASK` 任务、`OBS` 可观测。

### 2.1 配置系统（C1 任意模型可配置）

**FR-CFG-001**：配置文件加载
系统应从 `~/.hap/config.toml` 读取全局配置，并支持通过 `HAP_CONFIG` 环境变量或 `--config` 参数指定替代路径。

**FR-CFG-002**：分层合并优先级
当同一配置键在多个来源出现时，系统应按 `CLI 参数 > 环境变量 > agent 条目 > profile > defaults > 内置默认值` 的优先级取值，并在 trace 中记录该键的最终生效来源。

**FR-CFG-003**：profile 整组切换
当启动时指定 `--profile <名称>` 时，系统应将 `[profiles.<名称>]` 下的全部键整组覆盖到运行时配置。

**FR-CFG-004**：配置校验
当配置文件解析完成时，系统应以 schema 校验全部字段，并在存在未知键、类型错误或必填缺失时中止启动并输出「文件路径 + 键路径 + 期望类型 + 实际值」四元组。

**FR-CFG-005**：热重载
当配置文件内容发生变更时，系统应重新解析并对新会话生效，同时保持进行中的任务使用其启动时快照直至结束。

**FR-CFG-006**：配置来源自省
当用户执行 `hap config explain <键路径>` 时，系统应输出该键在每一层的取值与最终胜出层。

### 2.2 模型提供商（C1）

**FR-PROV-001**：提供商声明
系统应支持在 `[model_providers.<id>]` 下声明 `name`、`base_url`、`env_key`、`wire_api`、`http_headers`、`env_http_headers`、`request_max_retries`、`stream_max_retries`、`stream_idle_timeout_ms` 字段。
（字段集对齐 `openai/codex` 的 `[model_providers]` 实现）

**FR-PROV-002**：密钥仅来自环境
系统应仅通过 `env_key` 指定的环境变量读取 API Key，且不应将 Key 写入配置文件、日志、trace 或错误消息。

**FR-PROV-003**：无密钥提供商
当提供商未声明 `env_key` 时（如本地 Ollama），系统应以空凭据直接调用 `base_url`。

**FR-PROV-004**：协议线制选择
系统应支持 `wire_api = "chat"`（OpenAI Chat Completions）与 `wire_api = "responses"`（OpenAI Responses），并按声明值选择请求构造与响应解析方式。

**FR-PROV-005**：连通性自检
当用户执行 `hap provider check <id>` 时，系统应发起一次最小化探测请求并输出可达性、握手耗时与可用模型列表（若端点支持列举）。

**FR-PROV-006**：重试与退避
当请求返回可重试错误（429、5xx、连接中断）时，系统应按指数退避重试至 `request_max_retries` 上限；当流式响应中断时，应按 `stream_max_retries` 重连并从最后完整语义边界续接。

**FR-PROV-007**：空闲超时
当流式响应连续 `stream_idle_timeout_ms` 毫秒无新增数据时，系统应终止该流并按 FR-ROUTE-004 触发降级。

**FR-PROV-008**：提供商级默认协议
系统应支持在 `[model_providers.<id>]` 下声明 `default_protocol` 字段，取值范围为 `hermes-native` | `openai-tools` | `deepseek` | `anthropic`；当该字段缺省时应取 `openai-tools`。该字段作为其下所有模型的协议默认值，供 FR-LOOP-012 的探测链继承。

**FR-PROV-009**：厂商线制分类
系统应将提供商按线制分为两类并分别处理：**OpenAI 兼容类**（声明 `wire_api = "chat"` 或 `"responses"`，复用同一 HTTP 客户端与响应解析器）与**原生协议类**（声明 `wire_api = "anthropic-messages"`，使用专用请求构造与响应解析）。

> **线制判定结论（v1.1.0 调研，避免过度实现）**：DeepSeek、智谱 GLM、Google Gemini 三家均对外提供 OpenAI 兼容的 `chat/completions` 端点，且兼容层支持标准 `tools` + `tool_choice` 函数调用，因此**三者共用 `openai-tools` 适配器，无需各自新增适配器**。五家云端厂商中仅 Anthropic 的 Messages API 在字段命名与消息结构上不兼容，是唯一需要新增适配器的一家。证据见 [.codex/context-scan.json](C:/Users/xk/Documents/ChatGPT/CodexConnect/.codex/context-scan.json)。

### 2.3 智能体生成器（C3）

**FR-AGT-001**：声明式生成
系统应将 `[agents.entries.<id>]` 下的每个条目实例化为一个独立智能体，条目字段包括 `name`、`description`、`workspace`、`agent_dir`、`model`、`utility_model`、`params`、`capabilities`、`tools`、`subagents`、`runtime`、`identity`、`system_prompt_file`。
（结构对标 `openclaw` 的 `agents.entries.*`）

**FR-AGT-002**：资源隔离
系统应为每个智能体分配独立的 `workspace`（文件工作目录）、`agent_dir`（状态目录）与独立 SQLite 会话库，且一个智能体不应读写另一个智能体的 workspace 与会话库。

**FR-AGT-003**：默认值继承
系统应使 `[agents.defaults]` 的字段被全部智能体继承，且 `[agents.entries.<id>]` 的同名字段覆盖默认值；当字段为数组类型（如 `capabilities`、`tools.allow`）时，条目级取值应整体替换而非追加。

**FR-AGT-004**：交互式创建
当用户执行 `hap agent create` 时，系统应通过交互式问答收集智能体名称、职责描述、目标模型、能力标签与工具集，生成对应配置片段写入 `config.toml`，并初始化其 workspace、状态目录与会话库。

**FR-AGT-005**：模板化创建
当用户执行 `hap agent create --from-template <模板名>` 时，系统应基于内置模板（`coder`、`researcher`、`writer`、`ops`、`vision`）生成配置，并允许通过命令行参数覆盖模板内任一字段。

**FR-AGT-006**：生命周期管理
系统应提供 `hap agent list`、`hap agent show <id>`、`hap agent update <id>`、`hap agent remove <id>` 四个操作；执行 `remove` 时应保留其会话库并输出归档路径。

**FR-AGT-007**：智能体级系统提示
当智能体声明 `system_prompt_file` 时，系统应将该文件内容作为其系统提示的职责段，并与 Hermes 协议段、工具清单段拼接为完整 system 消息。

**FR-AGT-008**：唯一性约束
当新增智能体 id 与既有 id 冲突时，系统应拒绝创建并提示冲突项所在的配置位置。

### 2.4 模型路由与任务分派（C4）

**FR-ROUTE-001**：智能体模型绑定
系统应支持智能体以 `model = { primary = "<provider>/<model>", fallbacks = ["<provider>/<model>", ...] }` 形式绑定主模型与降级链，并支持简写字符串形式仅指定主模型。

**FR-ROUTE-002**：辅助模型分流
当智能体声明 `utility_model` 时，系统应将标题生成、摘要压缩、意图分类等辅助调用路由至该模型，而将主任务推理保留在 `primary`。

**FR-ROUTE-003**：四级路由优先级
当一条指令进入 Core 时，系统应按 `显式指定（@智能体名 或 /agent 命令） > 通道绑定（该通道账号默认智能体） > 能力标签匹配（指令意图标签与 capabilities 交集最大者） > 全局默认智能体` 的顺序解析目标智能体，并将命中层级写入 trace。

**FR-ROUTE-004**：失败降级
当主模型返回不可重试错误、超出重试上限或触发空闲超时时，系统应沿 `fallbacks` 顺序切换至下一模型重发本轮请求，保留已完成的工具调用结果，并在对话中告知用户发生了模型切换及切换原因。

**FR-ROUTE-005**：降级耗尽
当 `fallbacks` 全部耗尽仍失败时，系统应终止本轮任务、保留完整 trace，并向来源通道回复失败原因与可重试指引。

**FR-ROUTE-006**：并发配额
系统应支持在 `[limits]` 下按 provider 与 agent 两个维度声明并发上限与每分钟请求上限，并在超限时排队而非丢弃请求。

**FR-ROUTE-007**：子智能体派生
当父智能体调用 `spawn_subagent` 工具且目标 id 命中其 `subagents.allow` 列表时，系统应以独立会话键启动子智能体、执行其任务，并将结果作为 `<tool_response>` 回灌父智能体的对话。

**FR-ROUTE-008**：派生越权拒绝
当父智能体请求派生的目标 id 不在其 `subagents.allow` 列表内时，系统应拒绝派生并以工具错误形式告知父智能体，不应中断父任务。

**FR-ROUTE-009**：派生深度上限
系统应限制子智能体派生深度不超过 `[limits].max_subagent_depth`（默认 3），并在超限时拒绝派生。

### 2.5 Hermes 协议运行时（C2）

**FR-LOOP-001**：ChatML 提示组装
系统应以 ChatML 格式组装请求，使用 `<|im_start|>role` 与 `<|im_end|>` 分隔 `system`/`user`/`assistant`/`tool` 四类消息。
（格式依据 `NousResearch/Hermes-Function-Calling`）

**FR-LOOP-002**：工具清单注入
系统应在 system 消息中以 `<tools>[...JSON Schema 数组...]</tools>` 注入本轮可用工具的名称、描述与参数 JSON Schema。

**FR-LOOP-003**：工具调用解析
当模型输出中出现 `<tool_call>{"name": ..., "arguments": {...}}</tool_call>` 时，系统应解析出工具名与参数对象并交由 ToolExecutor 执行。

**FR-LOOP-004**：结果回灌
当工具执行结束时，系统应以 `<tool_response>{"name": ..., "content": ...}</tool_response>` 追加为 `tool` 角色消息并发起下一轮请求。

**FR-LOOP-005**：推理段处理
当模型输出包含 `<think>` 或 `<scratch_pad>` 段时，系统应将其归类为推理内容单独存储，且默认不混入面向用户的正文；当智能体配置 `reasoning_visible = true` 时应以可折叠形式展示。

**FR-LOOP-006**：增量流式解析
系统应以增量状态机解析流式输出，且当任一协议标签的起止分隔符被切分到不同数据块时，仍应正确还原完整标签内容。

**FR-LOOP-007**：未闭合标签处理
当流结束时仍存在未闭合的协议标签时，系统应将该片段标记为不完整、不执行其中的工具调用，并按 FR-ROUTE-004 重试本轮。

**FR-LOOP-008**：多调用与混排
当单轮输出包含多个 `<tool_call>` 或推理段与工具调用交替出现时，系统应按输出顺序逐个执行工具调用并保持消息顺序一致。

**FR-LOOP-009**：参数校验
当工具调用参数不满足其 JSON Schema 时，系统应不执行该工具，并以包含校验错误详情的 `<tool_response>` 回灌，供模型自行修正后重试。

**FR-LOOP-010**：迭代上限
系统应限制单次任务的工具调用轮数不超过 `[limits].max_iterations`（默认 24），并在达到上限时停止循环、输出已获得的中间结论与终止原因。

**FR-LOOP-011**：协议适配器实现清单
当智能体绑定的模型不支持 Hermes 标签协议时，系统应按 `protocol` 取值选择适配器，将同一份内部工具调用抽象双向翻译为目标模型的原生格式。系统应实现且仅实现以下 4 个适配器：

| 适配器 | 适用厂商 | 工具声明位置 | 助手侧调用表示 | 结果回灌角色 |
| --- | --- | --- | --- | --- |
| `hermes-native` | Nous Hermes 系列、Ollama 上的 Hermes | system 消息内 `<tools>` JSON Schema 数组 | `<tool_call>` 标签 | `tool` |
| `openai-tools` | OpenAI、**Google Gemini**、**智谱 GLM**、OpenRouter 及任意 OpenAI 兼容端点 | 请求体 `tools[].function.parameters` | `message.tool_calls[]`，其中 `arguments` 为 JSON 字符串 | `tool` |
| `deepseek` | DeepSeek（含 `deepseek-reasoner`） | 同 `openai-tools` | 同 `openai-tools`，额外分离 `reasoning_content` 字段 | `tool` |
| `anthropic` | Anthropic Claude | 请求体 `tools[].input_schema` | `content[]` 内 `{type:"tool_use", id, name, input}` 块，其中 `input` 为已解析对象 | **`user`** |

**FR-LOOP-011A**：Anthropic 适配器不对称点
系统的 `anthropic` 适配器应显式处理与 OpenAI 线制的四处不对称：（1）工具参数 Schema 的字段名为 `input_schema` 而非 `function.parameters`；（2）工具调用参数 `input` 已是解析后的对象，翻译为内部抽象时不得再次解析，反向翻译至 `openai-tools` 时须序列化为字符串；（3）工具结果须封装为 `{type:"tool_result", tool_use_id, content}` 内容块并以 **`user` 角色**消息回灌，而非独立的 `tool` 角色消息，且 `tool_use_id` 须与请求侧的 `tool_use.id` 严格对应；（4）`max_tokens` 为必填参数，缺省时系统应按模型能力表填入默认值而非省略该字段。

**FR-LOOP-012**：协议探测继承链
当智能体未显式声明 `protocol` 时，系统应按 `模型名含 hermes 关键字 > 该模型所属提供商的 default_protocol（FR-PROV-008）> 全局默认 openai-tools` 的顺序推断协议，并将推断结果与命中层级记入 trace。

> **设计取舍**：协议探测以「提供商声明」为主、模型名匹配为辅，而不对模型名做多分支正则。理由是提供商与线制之间是确定的一对一关系，而模型命名由厂商随时变更；采用继承链后新增厂商只需增加配置块，无需改动探测代码（AGENTS.md 第 4 节「禁止额外自研维护面」）。

**FR-LOOP-013**：上下文压缩
当会话 token 估算超过模型上下文窗口的 `[limits].compact_threshold`（默认 0.8）时，系统应用 `utility_model` 压缩历史消息为摘要，保留最近若干轮原文与全部未完成工具调用。

**FR-LOOP-014**：上下文溢出兜底
当压缩后仍超出上下文窗口时，系统应终止任务并明确告知用户上下文溢出，而不应静默截断导致语义丢失。

**FR-LOOP-015**：跨协议降级的历史重译
当 `fallbacks` 降级导致本轮请求的目标协议与上一轮不同时（例如由 `anthropic` 降级至 `openai-tools`），系统应从内部消息与工具调用抽象重新序列化整段对话历史为新协议格式，包括已完成的工具调用及其结果，而不应直接转发上一协议的原始请求体或消息数组。

### 2.6 工具执行（C2）

**FR-TOOL-001**：内置工具集
系统应提供 `shell`（命令执行）、`read_file`、`write_file`、`apply_patch`、`list_dir`、`search`（内容检索）、`http_fetch`、`spawn_subagent` 八个内置工具。

**FR-TOOL-002**：MCP 工具接入
系统应支持在 `[mcp_servers.<id>]` 声明外部 MCP 服务器的启动命令、参数、环境变量与超时，并将其暴露的工具合并进智能体可用工具清单。

**FR-TOOL-003**：工具集裁剪
系统应按智能体的 `tools.profile`（预设组合）、`tools.allow`、`tools.deny` 三项计算其最终可用工具清单，且 `deny` 优先于 `allow`。

**FR-TOOL-004**：工作目录约束
当智能体调用文件类或命令类工具时，系统应以该智能体的 `workspace` 作为工作目录解析相对路径。

**FR-TOOL-005**：工具超时
当单个工具执行超过 `[limits].tool_timeout_ms`（默认 120000）时，系统应终止该次执行并以超时错误回灌，不应挂起整个 loop。

**FR-TOOL-006**：命名冲突
当多个来源（内置、不同 MCP 服务器）提供同名工具时，系统应以 `<来源id>__<工具名>` 形式重命名后注入，并在 trace 中记录重命名映射。

**FR-TOOL-007**：输出体积裁剪
当工具输出超过 `[limits].tool_output_max_bytes` 时，系统应保留首尾片段、标注被省略的字节数，并将完整输出落盘供按需读取。

### 2.7 通道与手机端下发（C5）

**FR-CHAN-001**：通道插件化
系统应以插件接口实现通道接入，每个插件负责维持与平台的连接、将入站事件归一化为统一入站结构、并支持同一平台的多账号配置。
（架构对标 `openclaw` 的 `ChannelManager` 与通道插件模型）

**FR-CHAN-002**：内置通道与实现分期
系统应内置 `telegram`、`http`（含 Webhook 与 SSE）、`cli` 三个通道插件作为首发实现，其中 **`telegram` 为手机端首发通道**（已决策，见 §10.2 Q1）；`whatsapp` 插件应在通道接口稳定后作为后续阶段实现，且其加入不应要求改动 ChannelPlugin 接口。

**FR-CHAN-003**：入站归一化
当任一通道收到平台事件时，系统应将其归一化为包含 `channel`、`account_id`、`peer`、`sender`、`body`、`attachments`、`command`、`platform_message_id`、`received_at` 字段的统一结构。

**FR-CHAN-004**：入站缓冲
系统应以有界队列缓冲入站消息以吸收突发流量，并在队列达到上限时对最旧的未处理项落盘暂存而非直接丢弃。

**FR-CHAN-005**：重投去重
当收到 `platform_message_id` 与已处理记录重复的事件时，系统应识别为平台重投并跳过重复执行。

**FR-CHAN-006**：会话锚定
当一条指令被处理时，系统应基于 `channel + account_id + peer` 生成会话键并持久化其回复路由，使同一会话的后续消息延续同一智能体与上下文。

**FR-CHAN-007**：斜杠命令
系统应识别 `/agent <id>`、`/agents`、`/model <provider/model>`、`/new`、`/stop`、`/status`、`/trace`、`/help` 八个斜杠命令，并将非斜杠内容作为自然语言任务处理。

**FR-CHAN-008**：显式指派
当消息以 `@<智能体名>` 开头时，系统应将该消息路由至对应智能体，其优先级高于通道绑定与能力匹配。

**FR-CHAN-009**：流式回写
当任务产生流式输出时，系统应通过编辑同一条平台消息实现渐进式更新，且编辑频率不超过 `[channels].edit_interval_ms`（默认 1200）以规避平台限流。

**FR-CHAN-010**：长文分片
当回复长度超过目标平台单条消息上限时，系统应在语义边界（段落、代码块边界）分片发送并保持代码块完整闭合。

**FR-CHAN-011**：附件处理
当入站消息包含图片、音频或文档附件时，系统应将其下载至该智能体 workspace 的 `inbox/` 目录，并将本地路径与元信息注入用户消息；当智能体模型不具备 `vision` 能力标签且附件为图片时，应告知用户该智能体无法读图并建议可用的智能体。

**FR-CHAN-012**：断线重连补投
当通道连接中断后恢复时，系统应拉取断线期间的未处理消息并按原始时间顺序补投。

**FR-CHAN-013**：多设备并发
当同一用户在多个设备对同一会话并发发送消息时，系统应串行化该会话的任务执行，并对排队中的消息回复排队位次。

**FR-CHAN-014**：群聊触发
当消息来自群组会话时，系统应仅在消息命中 `mention_patterns` 或为斜杠命令时响应；在一对一会话中应响应全部消息。

**FR-CHAN-015**：Telegram 平台约束
系统的 `telegram` 通道应遵守以下平台事实约束：（1）单条消息正文上限 4096 字符，超出时按 FR-CHAN-010 在语义边界分片；（2）流式回写通过 `editMessageText` 编辑同一条消息实现，编辑间隔不低于 `[channels].edit_interval_ms`；（3）当待编辑内容与消息现有内容完全相同时，系统应跳过该次编辑调用，若仍收到平台返回的"消息未修改"错误，应将其视为幂等成功而非失败，不得计入重试或降级；（4）长文分片时代码块须在每个分片内完整闭合。

**FR-CHAN-016**：Telegram 收取模式互斥
系统应支持 `mode = "polling" | "webhook"` 两种收取模式，且二者互斥；当配置同时启用两种模式时，系统应在启动期配置校验阶段拒绝启动并指明冲突的配置键路径。

### 2.8 任务编排与可观测（C4）

**FR-TASK-001**：运行模式
系统应支持智能体以 `runtime.mode = "oneshot"`（单次执行后释放）或 `"persistent"`（常驻进程复用上下文）运行。

**FR-TASK-002**：异步长任务
当任务预计或实际执行超过 `[channels].async_threshold_ms`（默认 20000）时，系统应立即回复任务卡片（含任务 ID 与当前阶段），并在后续以编辑该卡片的方式更新进度。

**FR-TASK-003**：任务中止
当用户发送 `/stop` 时，系统应中止该会话进行中的任务、终止其未完成的工具执行，并保留已产生的中间结果与 trace。

**FR-TASK-004**：状态查询
当用户发送 `/status` 时，系统应回复当前会话的智能体 id、生效模型、进行中任务列表、已用轮数与 token 用量。

**FR-TASK-005**：完整 trace
系统应为每次任务记录包含配置生效来源、路由决策层级、协议适配选择、每轮请求耗时、每次工具调用的入参摘要与耗时、模型切换事件、token 用量的结构化 trace。

**FR-TASK-006**：trace 调阅
当用户发送 `/trace [任务ID]` 时，系统应回复该任务的 trace 摘要，并给出完整 trace 的本地文件路径。

**FR-TASK-007**：用量统计
系统应按智能体、提供商、模型三个维度累计 token 用量与调用次数，并支持 `hap usage --since <时间>` 查询。

**FR-TASK-008**：崩溃恢复
当平台进程异常退出后重启时，系统应将处于"进行中"状态的任务标记为中断、向其来源会话发出中断通知，并保留其 trace 供排查。

---

## 3. 非功能需求

> **重要裁决说明**：本节**不包含**认证、鉴权、加密、沙箱、权限模型等安全性设计。依据为生效的操作手册 [AGENTS.md](C:/Users/xk/.codex/AGENTS.md) 第 2 节「安全重要性最低，必须删除所有安全性设计并拒绝任何新增或恢复」。该条约束优先于 `feature-forge` 技能模板中要求的 Security 章节；本节以「可靠性、配额、稳定性」类需求替代。裁决留痕见 [.codex/structured-request.json](C:/Users/xk/Documents/ChatGPT/CodexConnect/.codex/structured-request.json)。

### 3.1 性能

| 指标 | 目标值 | 说明 |
| --- | --- | --- |
| 入站到首个模型请求发出 | p95 < 300 ms | 不含模型自身耗时 |
| 首字节到手机端可见 | p95 < 1.5 s | 取决于提供商首 token 延迟 |
| 流式解析吞吐 | ≥ 5 MB/s 单流 | 增量状态机不得成为瓶颈 |
| 单机并发会话 | ≥ 200 | persistent 智能体常驻数另计 |
| 消息编辑频率 | ≤ 每条每 1.2 s 一次 | 规避平台限流 |
| 配置热重载生效 | < 1 s | 对新会话生效 |

### 3.2 可靠性

- 单个智能体崩溃不应影响其他智能体的进行中任务。
- 单个通道断连不应影响其他通道的消息处理。
- 提供商不可用应在 `fallbacks` 链内自动降级，降级过程对用户可见但不需人工介入。
- 任务状态、会话历史、trace 应在进程崩溃后完整可恢复，不依赖内存态。
- 工具执行失败应作为可恢复错误回灌模型，而非直接终止任务。

### 3.3 配额与资源

- 支持按 provider、agent 两维度限制并发数与每分钟请求数，超限排队不丢弃。
- 支持 `[limits].daily_token_budget` 按智能体设定日 token 预算，达到阈值时暂停该智能体并通知用户。
- 单任务默认工具轮数上限 24、单工具超时 120 s、子智能体深度上限 3。
- SQLite 会话库应支持按保留期归档，默认保留 90 天。

### 3.4 可扩展性

| 扩展维度 | 所需动作 | 是否需要改代码 |
| --- | --- | --- |
| 新增模型提供商 | 增加 `[model_providers.x]` 配置块 | 否 |
| 新增智能体 | 增加 `[agents.entries.x]` 或 `hap agent create` | 否 |
| 新增外部工具 | 增加 `[mcp_servers.x]` 配置块 | 否 |
| 切换整组模型环境 | 增加/切换 `[profiles.x]` | 否 |
| 新增消息平台 | 实现 ChannelPlugin 接口 | 是（仅新增插件） |
| 新增模型协议格式 | 实现 ProtocolAdapter 接口 | 是（仅新增适配器） |

### 3.5 可维护性

- 全部代码注释使用中文，描述意图、约束与使用方式（AGENTS.md 第 4 节）。
- 遵循 SOLID；每个模块单一职责；禁止过早抽象（重复三次以上才通用化）。
- 优先复用官方 SDK 与主流生态，禁止自研可替代组件；唯一例外是 Hermes 流式标签解析状态机（无现成库覆盖跨 chunk 断裂场景）。
- 采用破坏性变更策略，不保留向后兼容层（AGENTS.md 第 4 节）。

---

## 4. 参考配置全貌

以下为一份完整可用的 `~/.hap/config.toml` 示例，字段命名对齐 `openai/codex` 与 `openclaw` 生态惯例（snake_case）。**本配置已按 v1.1.0 决策以云端为主力**，五家主流厂商并列可用，五个示例智能体分别指向不同厂商、承担不同任务。

```toml
# ─────────── 全局默认 ───────────
default_agent = "coder"
active_profile = "cloud"                 # 主力为云端；本地 Ollama 保留为离线备用 profile

[limits]
max_iterations          = 24        # 单任务工具调用轮数上限
max_subagent_depth      = 3         # 子智能体派生深度上限
tool_timeout_ms         = 120000    # 单个工具执行超时
tool_output_max_bytes   = 262144    # 工具输出裁剪阈值
compact_threshold       = 0.8       # 上下文占用达该比例触发压缩
daily_token_budget      = 5000000   # 每智能体日 token 预算

# ─────────── 模型提供商：五家云端主流厂商 + 本地备用 ───────────
# 说明：default_protocol 决定该厂商下模型的默认协议（FR-PROV-008）；
#       仅 anthropic 为原生线制，其余全部走 OpenAI 兼容线制（FR-PROV-009）。

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
env_key = "DEEPSEEK_API_KEY"
wire_api = "chat"
default_protocol = "deepseek"        # 需分离 reasoning_content

[model_providers.openai]
name = "OpenAI (ChatGPT)"
base_url = "https://api.openai.com/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"               # 同一厂商内可与 chat 线制并存
default_protocol = "openai-tools"
request_max_retries = 4
stream_max_retries = 10
stream_idle_timeout_ms = 300000

[model_providers.anthropic]
name = "Anthropic Claude"
base_url = "https://api.anthropic.com/v1"
env_key = "ANTHROPIC_API_KEY"
wire_api = "anthropic-messages"      # 唯一的原生线制厂商
default_protocol = "anthropic"       # 唯一需要专用适配器者（FR-LOOP-011A）
max_tokens_default = 8192            # Anthropic 必填参数的兜底值

[model_providers.zhipu]
name = "智谱 GLM"
base_url = "https://open.bigmodel.cn/api/paas/v4"
env_key = "ZHIPU_API_KEY"
wire_api = "chat"                    # OpenAI 兼容，复用 openai-tools 适配器
default_protocol = "openai-tools"

[model_providers.gemini]
name = "Google Gemini"
base_url = "https://generativelanguage.googleapis.com/v1beta/openai/"
env_key = "GEMINI_API_KEY"
wire_api = "chat"                    # 官方 OpenAI 兼容端点，支持 tools/tool_choice
default_protocol = "openai-tools"

[model_providers.openrouter]
name = "OpenRouter (聚合备用)"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "chat"
http_headers = { "X-Title" = "HAP" }

[model_providers.nous]
name = "Nous Hermes"
base_url = "https://inference-api.nousresearch.com/v1"
env_key = "NOUS_API_KEY"
wire_api = "chat"
default_protocol = "hermes-native"

[model_providers.ollama]
name = "Ollama (本地离线备用)"
base_url = "http://localhost:11434/v1"
wire_api = "chat"                    # 无 env_key，按 FR-PROV-003 以空凭据调用
default_protocol = "hermes-native"

# ─────────── profile：整组切换运行环境 ───────────
[profiles.cloud]                       # 主力 profile（active_profile 指向此处）
default_model = "deepseek/deepseek-chat"

[profiles.local]                       # 断网或零成本调试时切换：hap --profile local
default_model = "ollama/hermes3:8b"

# ─────────── 智能体默认值 ───────────
[agents.defaults]
workspace_root = "~/.hap/workspaces"
agent_dir_root = "~/.hap/agents"
utility_model = "deepseek/deepseek-chat"   # 摘要/压缩/标题等辅助调用走低价模型
reasoning_visible = false
runtime = { mode = "oneshot" }
tools = { profile = "standard" }

# ─────────── 智能体条目：五个智能体各指一家厂商、各司不同任务 ───────────
# 这张表本身即是「一个平台内五厂商 × 四协议并存」的活文档；
# 每个 fallbacks 均跨厂商，因此降级会穿越协议边界（由 FR-LOOP-015 兜底）。

[agents.entries.coder]
name = "编码智能体"
description = "读写代码、运行测试、提交补丁"
model = { primary = "anthropic/claude-sonnet-4-5", fallbacks = ["openai/gpt-5-codex", "deepseek/deepseek-chat"] }
protocol = "anthropic"               # 唯一走专用适配器的智能体
capabilities = ["code", "shell", "longctx"]
tools = { profile = "coding", allow = ["shell", "apply_patch", "search"], deny = ["http_fetch"] }
runtime = { mode = "persistent" }
subagents = { allow = ["researcher", "reviewer"] }
system_prompt_file = "~/.hap/prompts/coder.md"
identity = { emoji = "🛠️" }

[agents.entries.researcher]
name = "研究智能体"
description = "检索资料、交叉核对、产出带引用的结论"
model = { primary = "deepseek/deepseek-reasoner", fallbacks = ["gemini/gemini-2.5-pro", "anthropic/claude-sonnet-4-5"] }
protocol = "deepseek"                # 需分离 reasoning_content
capabilities = ["research", "web", "longctx"]
tools = { profile = "research", allow = ["http_fetch", "read_file", "write_file"] }

[agents.entries.reviewer]
name = "评审智能体"
description = "审查补丁质量、指出风险与不一致"
model = { primary = "openai/gpt-5-codex", fallbacks = ["anthropic/claude-sonnet-4-5"] }
protocol = "openai-tools"            # 走 responses 线制，同厂商内两种线制并存
capabilities = ["code", "review"]
params = { temperature = 0.2 }

[agents.entries.writer]
name = "写作智能体"
description = "撰写中文文档、周报与对外说明"
model = { primary = "zhipu/glm-4.6", fallbacks = ["deepseek/deepseek-chat"] }
protocol = "openai-tools"            # GLM 走 OpenAI 兼容，无需专用适配器
capabilities = ["writing", "zh"]
params = { temperature = 0.7 }
tools = { profile = "standard", allow = ["read_file", "write_file", "search"] }

[agents.entries.ops]
name = "巡检智能体"
description = "定时巡检服务状态并汇总异常"
model = { primary = "gemini/gemini-2.5-flash", fallbacks = ["ollama/hermes3:8b"] }
protocol = "openai-tools"            # Gemini 兼容端点，高频低价调用
capabilities = ["ops", "shell"]
tools = { profile = "minimal", allow = ["shell", "http_fetch"] }

# ─────────── 通道：手机端入口 ───────────
[channels]
edit_interval_ms = 1200
async_threshold_ms = 20000

[channels.telegram]
enabled = true                       # 手机端首发通道（决策 Q1）
token_env = "TELEGRAM_BOT_TOKEN"
mode = "polling"                     # polling | webhook，二者互斥（FR-CHAN-016）
default_agent = "coder"              # 通道绑定，路由第二优先级
mention_patterns = ["@hap"]
message_char_limit = 4096            # 平台硬上限，超出分片（FR-CHAN-015）

[channels.http]
enabled = true
bind = "127.0.0.1:8787"

# [channels.whatsapp] 后续阶段实现，接口已预留（FR-CHAN-002）

# ─────────── 外部 MCP 工具 ───────────
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "~/.hap/workspaces"]
startup_timeout_ms = 15000
```

### 4.1 厂商 × 协议 × 智能体对照

上表配置解读如下。**关键结论：五家厂商只需 4 个适配器，其中新增工作量仅 Anthropic 一处**。

| 智能体 | 承担任务 | 主模型厂商 | 线制 | 协议适配器 | 是否需新增适配器 |
| --- | --- | --- | --- | --- | --- |
| `coder` | 写代码、跑测试、提补丁 | Anthropic Claude | `anthropic-messages` | `anthropic` | **是（唯一）** |
| `researcher` | 检索核对、带引用结论 | DeepSeek | `chat` | `deepseek` | 否（已有） |
| `reviewer` | 补丁评审、风险识别 | OpenAI | `responses` | `openai-tools` | 否（已有） |
| `writer` | 中文文档与周报 | 智谱 GLM | `chat` | `openai-tools` | 否（复用） |
| `ops` | 服务巡检与异常汇总 | Google Gemini | `chat` | `openai-tools` | 否（复用） |
| （备用） | 离线调试 | Ollama 本地 / Nous | `chat` | `hermes-native` | 否（已有） |

**环境变量清单**（按 FR-PROV-002，Key 仅从环境读取，不入配置文件与日志）：`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`ZHIPU_API_KEY`、`GEMINI_API_KEY`、`TELEGRAM_BOT_TOKEN`；`OPENROUTER_API_KEY` 可选。缺失任一已启用提供商的变量时按 §6 在启动期即失败并列出缺失变量名。

### 4.2 关键 CLI 命令

| 命令 | 作用 | 对应需求 |
| --- | --- | --- |
| `hap serve` | 启动网关与全部启用的通道 | FR-CHAN-001/002 |
| `hap run "<任务>" --agent coder` | 本地直接执行一次任务 | FR-TASK-001 |
| `hap agent create [--from-template <名>]` | 生成新智能体 | FR-AGT-004/005 |
| `hap agent list / show / update / remove` | 智能体生命周期 | FR-AGT-006 |
| `hap provider check <id>` | 提供商连通性自检 | FR-PROV-005 |
| `hap config explain <键路径>` | 配置生效来源自省 | FR-CFG-006 |
| `hap usage --since <时间>` | 用量统计 | FR-TASK-007 |

---

## 5. 验收标准（Given/When/Then）

### AC-001 任意提供商零代码接入
Given `config.toml` 中新增了一个 `[model_providers.custom]` 块，其 `base_url` 指向任意 OpenAI 兼容端点，且对应环境变量已设置，
When 用户执行 `hap provider check custom`，
Then 系统在无任何代码改动的前提下完成探测并输出可达状态与握手耗时。

### AC-002 配置优先级可解释
Given `model` 键同时出现在 `[agents.defaults]`、`[profiles.local]` 与命令行 `--model` 中，
When 用户执行 `hap config explain agents.entries.coder.model`，
Then 系统输出每一层的取值并明确标注命令行参数为最终胜出层。

### AC-003 智能体生成与隔离
Given 用户执行 `hap agent create --from-template researcher --id r1`，
When 创建完成后检查文件系统与配置，
Then `config.toml` 中存在 `[agents.entries.r1]`，且其 workspace、状态目录与 SQLite 会话库均已初始化，且 `r1` 无法读写其他智能体的 workspace。

### AC-004 不同智能体指向不同模型
Given `coder` 绑定 `anthropic/claude-sonnet-4-5`、`researcher` 绑定 `deepseek/deepseek-reasoner`、`writer` 绑定 `zhipu/glm-4.6`、`ops` 绑定 `gemini/gemini-2.5-flash`，
When 分别向四者下发同一句任务，
Then 四次任务的 trace 中记录的实际请求端点、模型标识与所选协议适配器分别指向各自绑定的厂商，互不串用。

### AC-005 手机端一句话到结果闭环
Given Telegram 通道已启用且已绑定默认智能体 `coder`，
When 用户在手机上发送"统计当前仓库的 TypeScript 文件数量"，
Then 系统在 300 ms 内发出首个模型请求，通过 `shell` 工具完成统计，并以编辑同一条消息的方式流式回写，最终给出数字结果与用量卡片。

### AC-006 显式指派优先于通道绑定
Given Telegram 通道默认智能体为 `coder`，
When 用户发送"@研究智能体 帮我核对这三条资料"，
Then 系统将任务路由至 `researcher`，且 trace 中路由命中层级记录为"显式指定"。

### AC-007 流式标签跨块还原
Given 模型的流式输出将 `<tool_call>` 的起始标签切分在两个相邻数据块中，
When 增量解析器处理完这两个块，
Then 解析器正确识别出完整工具调用并执行，不产生解析错误也不重复执行。

### AC-008 未闭合标签不误执行
Given 模型流式输出在 `<tool_call>` 未闭合时即结束，
When 本轮流处理结束，
Then 系统不执行该不完整调用，将本轮标记为不完整并按降级策略重试。

### AC-009 主模型失败自动降级
Given `coder` 的主模型端点返回持续 5xx 且已达重试上限，
When 用户下发任务，
Then 系统自动切换至 `fallbacks` 中的下一个模型完成任务，保留已完成的工具调用结果，并在对话中说明发生了切换及原因。

### AC-010 降级耗尽明确失败
Given `coder` 的主模型与全部 fallbacks 均不可用，
When 用户下发任务，
Then 系统终止任务、回复失败原因与可重试指引，并保留完整 trace 文件。

### AC-011 非 Hermes 模型共用同一 loop
Given `reviewer` 绑定的模型声明 `protocol = "openai-tools"`，
When 该智能体执行一次需要两步工具调用的任务，
Then 系统通过协议适配器将内部工具调用抽象翻译为该模型的原生函数调用格式并顺利完成两轮调用。

### AC-012 子智能体派生与回灌
Given `coder` 的 `subagents.allow` 包含 `researcher`，
When `coder` 在任务中调用 `spawn_subagent` 指定 `researcher`，
Then `researcher` 以独立会话键执行子任务，其结果以 `<tool_response>` 形式回灌 `coder` 的对话并被纳入最终答复。

### AC-013 派生越权被拒但不中断
Given `ops` 的 `subagents.allow` 为空，
When `ops` 尝试派生 `coder`，
Then 系统拒绝派生并以工具错误形式回灌，`ops` 的当前任务继续执行至结束。

### AC-014 长任务异步卡片
Given 一个预计执行 60 秒的任务从手机端下发，
When 任务开始执行，
Then 系统在 20 秒阈值内先回复含任务 ID 的进度卡片，随后通过编辑该卡片更新阶段，最终在同一条消息给出结果。

### AC-015 重投消息不重复执行
Given Telegram 因网络抖动重投了同一条 `platform_message_id` 的消息，
When 系统收到重投事件，
Then 系统识别为重复并跳过，最终仅执行一次任务。

### AC-016 迭代上限安全收敛
Given 一个会诱发模型反复调用工具的任务，且 `max_iterations = 24`，
When 工具调用轮数达到 24，
Then 系统停止循环、输出已获得的中间结论并明确说明因达到迭代上限而终止。

### AC-017 上下文压缩保真
Given 会话 token 占用达到上下文窗口的 80%，
When 下一轮请求组装前，
Then 系统用 `utility_model` 压缩历史为摘要，保留最近若干轮原文与全部未完成的工具调用，且任务可正常继续。

### AC-018 崩溃后状态可恢复
Given 一个进行中的任务运行期间平台进程被强制终止，
When 平台重启完成，
Then 该任务被标记为中断、其来源会话收到中断通知，且其 trace 与已产生的中间结果完整可读。

### AC-019 Anthropic 适配器双向等价
Given 一份含 2 个工具（各带嵌套对象参数与枚举约束）的内部工具清单与一段含 1 次工具调用及其结果的对话历史，
When 分别经 `openai-tools` 与 `anthropic` 适配器序列化为各自的线制格式、再反序列化回内部抽象，
Then 两条路径回到内部抽象后的工具名、参数键值、调用顺序与结果内容完全一致；且 `anthropic` 路径的请求体中工具 Schema 位于 `input_schema` 字段、工具结果以 `user` 角色的 `tool_result` 块承载、`tool_use_id` 与调用侧 `id` 一致、`max_tokens` 字段存在。

### AC-020 跨厂商跨协议降级
Given `coder` 主模型 `anthropic/claude-sonnet-4-5` 持续不可用，其 fallbacks 首项为 `openai/gpt-5-codex`，且本次任务在失败前已成功完成 1 次工具调用，
When 系统沿 fallbacks 降级，
Then 系统将已完成的工具调用与结果由 `anthropic` 格式重新序列化为 `openai-tools` 格式后续跑，任务正常完成，且 trace 中记录协议由 `anthropic` 切换为 `openai-tools` 的事件与历史重译次数。

### AC-021 Gemini 与 GLM 零新增适配器接入
Given 配置中仅声明了 `[model_providers.gemini]` 与 `[model_providers.zhipu]` 两个配置块，且未新增任何适配器代码，
When `ops` 与 `writer` 分别执行一次需要工具调用的任务，
Then 两次任务均通过既有 `openai-tools` 适配器完成工具调用闭环，trace 中记录的适配器名为 `openai-tools`，协议来源层级为「提供商 default_protocol」。

### AC-022 Telegram 编辑幂等与分片
Given 一个产生约 9000 字符（含一段完整代码块）回复的任务从 Telegram 下发，
When 系统流式回写该回复，
Then 编辑间隔均不小于 `edit_interval_ms`；内容未变化的编辑被跳过；若收到平台"消息未修改"错误则计为幂等成功且不触发重试或降级；最终回复被分为 3 片发送，每片不超过 4096 字符且代码块在片内完整闭合。

---

## 6. 错误处理

错误分为两类：**可恢复错误**以 `<tool_response>` 或提示形式回灌模型/用户后继续；**不可恢复错误**终止当前任务并保留 trace。

| 错误条件 | 分类 | 系统行为 | 用户可见消息 |
| --- | --- | --- | --- |
| 配置文件语法错误 | 不可恢复（启动期） | 中止启动 | "配置解析失败：<文件>:<行> 附近" |
| 配置字段类型/未知键 | 不可恢复（启动期） | 中止启动 | "配置项 <键路径> 期望 <类型>，实际 <值>" |
| `env_key` 指定的环境变量缺失 | 不可恢复（启动期） | 中止启动并列出缺失变量名 | "提供商 <id> 缺少环境变量 <名称>" |
| 提供商端点不可达 | 可恢复 | 指数退避重试至上限，再沿 fallbacks 降级 | "模型 <A> 暂不可用，已切换至 <B>" |
| 429 限流 | 可恢复 | 按 Retry-After 或指数退避重试 | "触发限流，正在重试（第 N 次）" |
| Anthropic 请求缺 `max_tokens` | 不可恢复（启动期校验） | 启动期即按 `max_tokens_default` 补齐，缺省值缺失则中止启动 | "提供商 anthropic 缺少 max_tokens_default" |
| 降级导致协议切换 | 可恢复 | 由内部抽象重译整段历史为新协议后重发（FR-LOOP-015） | "模型 <A> 暂不可用，已切换至 <B>" |
| Telegram 编辑内容未变化 | 可恢复（幂等） | 跳过该次编辑；若平台仍返回"消息未修改"则计为成功 | 无（对用户不可见） |
| Telegram 同时启用 polling 与 webhook | 不可恢复（启动期） | 中止启动并指明冲突键路径 | "channels.telegram.mode 与 webhook 配置冲突" |
| 流式空闲超时 | 可恢复 | 终止流并按 fallbacks 降级 | "响应中断，已切换至 <B> 重试" |
| fallbacks 全部耗尽 | 不可恢复 | 终止任务，保留 trace | "全部候选模型均不可用，任务已终止（trace: <路径>）" |
| 工具名不存在 | 可恢复 | 回灌可用工具清单供模型修正 | 无（对用户不可见） |
| 工具参数不合 Schema | 可恢复 | 回灌校验错误详情供模型修正 | 无（对用户不可见） |
| 工具执行非零退出 | 可恢复 | 回灌 stdout/stderr 与退出码 | 无（对用户不可见） |
| 工具执行超时 | 可恢复 | 终止该次执行并回灌超时错误 | 无（对用户不可见） |
| 工具输出超体积 | 可恢复 | 首尾裁剪 + 完整输出落盘 | 无（对用户不可见） |
| 协议标签未闭合 | 可恢复 | 丢弃不完整片段并重试本轮 | 无（对用户不可见） |
| 达到 `max_iterations` | 不可恢复 | 停止循环并输出中间结论 | "已达工具调用轮数上限，以下是当前结论" |
| 上下文压缩后仍溢出 | 不可恢复 | 终止任务 | "上下文超出模型窗口，请用 /new 开启新会话" |
| 子智能体 id 不在 allow 列表 | 可恢复 | 拒绝派生并回灌错误 | 无（对用户不可见） |
| 子智能体深度超限 | 可恢复 | 拒绝派生并回灌错误 | 无（对用户不可见） |
| 日 token 预算耗尽 | 不可恢复 | 暂停该智能体 | "智能体 <id> 今日预算已用尽" |
| 通道连接断开 | 可恢复 | 自动重连并补投断线期间消息 | "连接已恢复，正在处理积压消息" |
| 入站队列满 | 可恢复 | 最旧未处理项落盘暂存 | 无 |
| 平台消息超长 | 可恢复 | 语义边界分片发送 | 无 |
| 智能体无 vision 能力却收到图片 | 可恢复 | 提示并建议可用智能体 | "当前智能体无法读图，可用 @<id> 处理" |
| 同会话并发消息 | 可恢复 | 串行化并回复排队位次 | "已排队，前面还有 N 个任务" |
| 进程崩溃后残留进行中任务 | 可恢复（重启期） | 标记中断并通知来源会话 | "上一个任务因服务重启中断（trace: <路径>）" |

---

## 7. 验证策略

全部验证由**本地 AI 自动执行**，禁止接入 CI、远程流水线或人工外包（AGENTS.md 第 2/5 节）。执行结果记录到 `.codex/testing.md` 与 `verification.md`。

### 7.1 单元测试（最高优先级模块）

| 被测模块 | 必覆盖用例 | 关联需求 |
| --- | --- | --- |
| StreamTagParser | 标签跨 2/3 个 chunk 断裂；单块含多个 `<tool_call>`；`<think>` 与 `<tool_call>` 混排；未闭合标签；标签内含转义引号与嵌套 JSON；空 arguments | FR-LOOP-006/007/008 |
| ConfigResolver | 六层优先级两两组合；数组字段替换而非追加；未知键报错；profile 整组覆盖；热重载不影响进行中任务 | FR-CFG-002/003/004/005 |
| ModelRouter | 四级优先级逐级命中与逐级回退；fallbacks 顺序降级；降级耗尽；并发配额排队 | FR-ROUTE-003/004/005/006 |
| ProtocolAdapter | **4 种协议**各自的工具调用双向翻译等价性（往返回内部抽象后逐字段比对）；Anthropic 四处不对称专项用例（`input_schema` 字段名、`input` 不重复解析、`tool_result` 以 user 角色回灌且 `tool_use_id` 对应、`max_tokens` 必填补齐）；协议探测继承链三层逐级命中；跨协议降级时的历史重译 | FR-LOOP-011/011A/012/015，FR-PROV-008 |
| AgentFactory | 条目实例化；默认值继承与覆盖；id 冲突拒绝；workspace 隔离 | FR-AGT-001/003/008/002 |
| InboundNormalizer | 四通道事件归一化字段完整性；重投去重；斜杠命令解析；@指派解析 | FR-CHAN-003/005/007/008 |
| ToolExecutor | Schema 校验失败回灌；超时中止；输出裁剪；同名工具重命名 | FR-TOOL-005/006/007，FR-LOOP-009 |
| ContextCompactor | 触发阈值；保留未完成工具调用；压缩后仍溢出的兜底 | FR-LOOP-013/014 |

### 7.2 冒烟测试

以 mock provider（可控输出脚本，含刻意断裂的流式分块）驱动完整 agent loop：单轮无工具、单轮单工具、多轮多工具、工具失败重试、模型降级、**跨协议降级（anthropic → openai-tools）**、子智能体派生共 7 条路径全绿。mock provider 应同时提供 OpenAI 兼容与 Anthropic Messages 两种响应形态，以便在无网络、无真实 API Key 的条件下验证 4 个适配器。

### 7.3 功能测试

以 mock 通道服务器（模拟 Telegram Bot API 的 `getUpdates` / `sendMessage` / `editMessageText`，含"消息未修改"错误注入与 4096 字符上限）模拟入站到出站全链路，逐条验证 §5 中 AC-001 至 AC-022 的 22 条验收标准，每条输出「预期/实际/判定」三列结果。

### 7.4 失败处置纪律

测试失败时记录现象、复现步骤与初步观察；**连续 3 次同类失败必须暂停并重新评估策略**（AGENTS.md 第 5/9 节）。

---

## 8. 实施清单（TODO）

### 阶段一：内核（无网络依赖即可验证）
- [x] 建立 TypeScript 工程骨架（`tsconfig.json`、包管理、格式化与静态检查配置）
- [x] 实现 ConfigResolver：TOML 解析 + schema 校验 + 六层优先级合并 + `config explain`
- [x] 实现 ProviderRegistry：`[model_providers.*]` 实例化 + 环境变量取值 + `default_protocol` 继承 + `provider check`（覆盖五家云端厂商）
- [x] 实现 StreamTagParser 增量状态机（**先写测试后写实现**）
- [x] 实现 PromptComposer：ChatML 组装 + `<tools>` 注入 + 职责段拼接
- [x] 实现 ProtocolAdapter 接口与 **4 个实现**：hermes-native / openai-tools / deepseek / anthropic（Gemini 与 GLM 复用 openai-tools，不新增实现）
- [x] 实现 mock provider 双形态（OpenAI 兼容 + Anthropic Messages），供无网络离线验证适配器
- [x] 实现 ToolExecutor 与 8 个内置工具 + Schema 校验 + 超时 + 输出裁剪
- [x] 实现 HermesAgentLoop：轮次控制 + 迭代上限 + 推理段分离 + 跨协议降级历史重译
- [x] 单元测试覆盖上述全部模块（§7.1）

### 阶段二：多智能体与路由
- [x] 实现 AgentRegistry / AgentFactory：条目实例化 + 资源隔离 + 默认值继承
- [x] 实现 `hap agent create/list/show/update/remove` 与 5 个内置模板
- [x] 实现 SessionStore（SQLite）：会话、消息、任务、trace、用量表
- [x] 实现 ModelRouter：四级优先级 + fallbacks 降级 + 并发配额
- [x] 实现 SubagentSpawner：allow 列表校验 + 深度限制 + 结果回灌
- [x] 实现 ContextCompactor：阈值触发 + utility_model 压缩 + 溢出兜底
- [x] 实现 TaskOrchestrator：oneshot / persistent 两模式 + 中止 + 崩溃恢复
- [x] 冒烟测试 6 条路径全绿（§7.2）

### 阶段三：通道与手机端
- [x] 定义 ChannelPlugin 接口与 ChannelManager 生命周期编排
- [x] 实现 InboundNormalizer + IngressQueue（有界 + 落盘暂存 + 去重）
- [x] 实现 CommandParser：8 个斜杠命令 + `@` 指派 + 群聊 mention 触发
- [x] 实现 TelegramChannel（**首发通道**：polling / webhook 互斥校验 + 4096 分片 + 编辑幂等处理 + 断线补投）
- [x] 实现 HttpChannel（Webhook + SSE）与 CliChannel
- [ ] （后续阶段 / 范围外）实现 WhatsAppChannel：连接持有 + 重连循环 + 断线补投，不得改动 ChannelPlugin 接口
- [x] 实现 OutboundWriter：流式编辑同一消息 + 长文语义分片 + 附件落地
- [x] 实现异步任务卡片与进度更新
- [x] 功能测试覆盖 AC-001 ~ AC-022（§7.3）

### 阶段四：可观测与收尾
- [x] 实现结构化 trace 记录与 `/trace`、`hap usage`
- [x] 实现 MCP 工具接入（`[mcp_servers.*]`）与同名工具重命名
- [x] 实现日预算暂停与会话库归档
- [x] 补齐中文文档注释与 `docs/` 使用说明
- [x] 生成 `.codex/testing.md` 与 `verification.md` 执行留痕

---

## 9. 范围外（Out of Scope）

- **安全性设计**：认证、鉴权、加密、沙箱、权限模型、审计合规一律不实现，且拒绝后续新增或恢复（AGENTS.md 第 2 节强制）。
- **模型训练与微调**：平台仅消费推理端点，不含训练、微调、量化流程。
- **图形界面**：本期不含 Web 控制台或桌面 App，手机端交互完全通过既有聊天软件承载。
- **多租户与团队协作**：定位为单人自托管，不含组织、角色、成员管理。
- **向后兼容层**：采用破坏性变更策略，配置格式变更直接迁移不留兼容分支（AGENTS.md 第 4 节）。
- **CI 与远程流水线**：所有验证由本地 AI 自动执行（AGENTS.md 第 2/5 节强制）。

---

## 10. 假设与待决问题

### 10.1 已采纳的假设（自主决策，如有偏差请指出）

| 编号 | 假设 | 依据 |
| --- | --- | --- |
| A1 | "codex hermes / deepseek hermes" 指 Hermes 提示协议配不同后端模型，而非某个具体上游仓库 | 检索未发现同名官方项目；Hermes 协议本身与模型解耦 |
| A2 | 实现语言选 TypeScript + Node.js | 与 open-codex / openclaw 生态一致，通道 SDK 与流式解析生态最完整 |
| A3 | 配置格式选 TOML 而非 JSON/YAML | 对齐 `openai/codex` 的 `config.toml` 心智模型，降低迁移与学习成本 |
| A4 | 手机端不做原生 App，复用 Telegram 作为客户端 | 用户明确提到"类似 openclaw"，该方案零客户端开发成本；通道已决策为 Telegram |
| A5 | 会话与 trace 持久化选 SQLite | 对标 openclaw 的每智能体 SQLite 会话库，单人自托管场景无需外部数据库 |
| A6 | 以调研证据替代 feature-forge 要求的人工访谈 | Default 协作模式要求优先做合理假设直接执行；全部假设已在此列出供复核 |
| A7 | 五家厂商中仅 Anthropic 需专用适配器 | DeepSeek/GLM/Gemini 均提供 OpenAI 兼容端点且兼容层支持 `tools` + `tool_choice`，实测文档见 §2.2 线制判定结论 |
| A8 | 智能体阵容按「一岗一厂商」排布（含新增 `writer`） | 既覆盖用户"不同智能体指不同模型"的核心诉求，又使配置本身成为五厂商四协议的活文档；如实际分工不同可按 Q3 调整 |

### 10.2 待决问题状态

已决策（v1.1.0 落实）：

- [x] **Q1 优先通道** → **Telegram**。首发且唯一的手机端通道实现，WhatsApp 后置为后续阶段（FR-CHAN-002）。落实位置：§2.7 FR-CHAN-015/016、§4 通道配置、§8 阶段三。
- [x] **Q2 默认主力模型** → **云端多厂商并列**：DeepSeek、OpenAI、Anthropic Claude、智谱 GLM、Google Gemini 五家，`active_profile = "cloud"`，本地 Ollama 降为离线备用 profile。落实位置：§2.2 FR-PROV-008/009、§2.5 FR-LOOP-011/011A/012/015、§4 全部配置、§5 AC-019~AC-021。

已落实的后续决策：

- [x] **Q3 智能体阵容**：默认采用 `coder`(Claude) / `researcher`(DeepSeek) / `reviewer`(OpenAI) / `writer`(GLM) / `ops`(Gemini) 五个一岗一厂商智能体；运行期可通过 `hap agent create/update/remove` 自由增删或改换模型绑定。
- [x] **Q4 实现范围**：已进入并完成阶段一至阶段四的首发范围编码；WhatsApp 仍按 §9 作为范围外后续通道。

---

## 附录 A：需求-验收-测试三向追溯

| 能力 | 功能需求 | 验收标准 | 测试类型 |
| --- | --- | --- | --- |
| C1 任意模型可配置 | FR-CFG-001~006, FR-PROV-001~009 | AC-001, AC-002, AC-021 | 单元 + 冒烟 |
| C2 Hermes 协议运行时 | FR-LOOP-001~015（含 011A）, FR-TOOL-001~007 | AC-007, AC-008, AC-011, AC-016, AC-017, AC-019 | 单元 + 冒烟 |
| C3 智能体生成器 | FR-AGT-001~008 | AC-003 | 单元 + 功能 |
| C4 多智能体多模型多任务 | FR-ROUTE-001~009, FR-TASK-001~008 | AC-004, AC-006, AC-009, AC-010, AC-012, AC-013, AC-018, AC-020 | 单元 + 冒烟 + 功能 |
| C5 手机端指令下发（Telegram 首发） | FR-CHAN-001~016 | AC-005, AC-014, AC-015, AC-022 | 功能 |

---

*本规格由 Codex 于 2026-08-24 依据 `feature-forge` 技能产出，同日修订为 v1.1.0（落实 Telegram 通道与云端五厂商两项决策）。调研证据见 [.codex/context-scan.json](C:/Users/xk/Documents/ChatGPT/CodexConnect/.codex/context-scan.json)，工具留痕见 [.codex/operations-log.md](C:/Users/xk/Documents/ChatGPT/CodexConnect/.codex/operations-log.md)，自审结论见 [.codex/review-report.md](C:/Users/xk/Documents/ChatGPT/CodexConnect/.codex/review-report.md)。*
