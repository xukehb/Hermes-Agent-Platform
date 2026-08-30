# Hermes 多智能体平台（HAP）

一套「任意模型 × 任意智能体 × 手机端下发」的智能体运行时。设计取向来自三处：Codex Hermes 的流式工具协议、DeepSeek Hermes 的推理内容分离、OpenCodex 的声明式服务商/模型目录。你在一个 TOML 文件里声明服务商、模型、智能体，然后从 Telegram 发一句话，指定的智能体就用你指定的模型去干活。

日期：2026-08-24　执行者：Codex

## 它解决什么

- 模型随意换。8 家主流服务商内置预置，运行时还能像 `ocx` 那样用一条命令加新服务商、加新模型，不改代码不重启。
- 智能体各司其职。声明式生成，每个智能体绑自己的主模型、降级链、工具档位、子智能体白名单。
- 手机端就是终端。Telegram 长轮询或 webhook 双模式，`@智能体id` 开头即可定向派活。
- 跑挂了能查。每个任务落一份 JSONL 轨迹，token 用量按智能体与模型聚合。





































.

## 五分钟上手





```powershell
npm install

# 1) 写出配置骨架：8 家服务商、9 个模型、5 个智能体
npx tsx src/cli/bin.ts init

# 2) 导出你要用的 Key（只需要用到的那几家）
$env:DEEPSEEK_API_KEY = 'sk-...'
$env:ANTHROPIC_API_KEY = 'sk-ant-...'

# 3) 体检：配置可解析性、凭据齐全度、服务商连通性
npx tsx src/cli/bin.ts doctor

# 4) 单跑一次任务，确认链路通
npx tsx src/cli/bin.ts run "用三句话解释 TOML 的表数组" -a writer

# 5) 拉起手机端
$env:TELEGRAM_BOT_TOKEN = '123456:ABC...'
npx tsx src/cli/bin.ts serve
```

把 `npx tsx src/cli/bin.ts` 换成 `npm run hap --` 也一样。下文统一写作 `hap`。

## 运行时加服务商与模型

这是对齐 OpenCodex 的核心能力：服务商与模型都是配置数据，不是代码分支。

```powershell
# 自建网关：继承 deepseek 预置的线制与协议，只换地址
hap provider add mycorp --preset deepseek --base-url https://gw.example.com/v1

# 从零声明一家：线制、协议、请求头、输出上限全可指定
hap provider add acme `
  --base-url https://api.acme.ai/v1 `
  --env-key ACME_API_KEY `
  --wire-api chat `
  --protocol openai-tools `
  --header X-Title=HAP `
  --env-header X-Trace=ACME_TRACE `
  --max-tokens-default 4096

# 挂模型到这家服务商
hap model add acme-large --provider acme --model acme-large-v2 `
  --context-window 200000 --max-output-tokens 16384 `
  --capability tools --capability streaming --param temperature=0.3

# 或者直接把服务商暴露的模型列表批量导入
hap model import acme --filter large --dry-run
hap model import acme --filter large

# 查、删
hap provider list
hap provider check acme
hap model list --provider acme
hap model remove acme-large
```

不带任何选项执行 `hap provider add <id>` 或 `hap model add <alias>` 会进入交互问答，适合第一次配。脚本里请显式给参数，否则会挂在问答上。

### 内置服务商预置

| 预置 | base_url | 环境变量 | 线制 | 默认协议 |
| --- | --- | --- | --- | --- |
| deepseek | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | chat | deepseek |
| openai | `https://api.openai.com/v1` | `OPENAI_API_KEY` | responses | openai-tools |
| anthropic | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` | anthropic-messages | anthropic |
| zhipu | `https://open.bigmodel.cn/api/paas/v4` | `ZHIPU_API_KEY` | chat | openai-tools |
| gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | `GEMINI_API_KEY` | chat | openai-tools |
| openrouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | chat | openai-tools |
| nous | `https://inference-api.nousresearch.com/v1` | `NOUS_API_KEY` | chat | hermes-native |
| ollama | `http://localhost:11434/v1` | 无 | chat | hermes-native |

三个概念别混：**线制**是 HTTP 层长什么样（`chat` 走 Chat Completions、`responses` 走 OpenAI Responses、`anthropic-messages` 走 Anthropic Messages）；**协议**是工具调用怎么表达（`openai-tools` 原生 tools 字段、`deepseek` 兼容其推理字段、`anthropic` 走 content blocks、`hermes-native` 解析 `<tool_call>` 标签流）；**模型别名**是你在智能体里引用的名字。

九个内置模型别名：`deepseek-chat`、`deepseek-reasoner`、`claude-sonnet-4-5`、`gpt-5-codex`、`glm-4.6`、`gemini-2.5-pro`、`gemini-2.5-flash`、`hermes-4-405b`、`hermes3:8b`。

## 声明式生成智能体

```powershell
# 从模板起，覆盖主模型
hap agent create qa --template reviewer --model deepseek/deepseek-chat --name "QA 审查员" --emoji 🔍

# 完全自定义：降级链、工具档位、子智能体、职责提示
hap agent create trader `
  --model anthropic/claude-sonnet-4-5 `
  --fallback deepseek/deepseek-reasoner --fallback openrouter/glm-4.6 `
  --utility-model deepseek/deepseek-chat `
  --tools-profile research `
  --deny-tool shell `
  --subagent researcher `
  --mode persistent `
  --prompt "你负责盘面复盘，只输出结论与依据，不写代码。"

hap agent list
hap agent show trader
hap agent update trader --param temperature=0.2
hap agent remove trader   # 只删配置条目，工作目录与会话库保留
```

`--prompt` 会把内容写进该智能体状态目录下的 `system.md` 并回填 `system_prompt_file`，之后你可以直接编辑那个文件。

### 骨架自带的五个智能体

| id | 主模型 | 工具档位 | 职责 |
| --- | --- | --- | --- |
| coder | `anthropic/claude-sonnet-4-5` | coding | 写代码、改代码、跑命令；可派生 researcher / reviewer |
| researcher | `deepseek/deepseek-reasoner` | research | 查资料、读文件、汇总结论 |
| reviewer | `openai/gpt-5-codex` | coding（禁 shell/写入） | 只读式代码审查 |
| writer | `zhipu/glm-4.6` | standard | 文档与文案 |
| ops | `gemini/gemini-2.5-flash` | minimal | 轻量问答与状态查询 |

第六个模板 `vision`（`gemini/gemini-2.5-pro`）不在骨架里，需要时 `hap agent create <id> --template vision`。

### 工具档位

| 档位 | 包含工具 |
| --- | --- |
| minimal | read_file、list_dir |
| standard | read_file、write_file、list_dir、search、http_fetch |
| coding | read_file、write_file、list_dir、search、shell、apply_patch、spawn_subagent |
| research | read_file、write_file、list_dir、search、http_fetch、spawn_subagent |
| full | 全部 8 个内置工具 |

`--allow-tool` 在档位之上收窄，`--deny-tool` 优先级最高。MCP 工具名写成 `server__tool` 形式。

## 手机端：Telegram

```toml
[channels.telegram]
enabled = true
token_env = "TELEGRAM_BOT_TOKEN"
mode = "polling"          # 或 "webhook"
default_agent = "coder"
mention_patterns = ["@hap"]

# webhook 模式追加这一段
[channels.telegram.webhook]
url = "https://your.domain/hap/telegram"
bind = "0.0.0.0:8788"
path = "/hap/telegram"
```

polling 适合本地和内网，开箱即用；webhook 适合有公网域名的部署，启动时自动调 `setWebhook`。两者互斥，启动期校验。

聊天里可用的指令：

| 指令 | 作用 |
| --- | --- |
| `/agents` | 列出全部智能体 |
| `/agent <id>` | 查看某个智能体的模型与工具集 |
| `/status` | 当前会话状态与今日用量 |
| `/trace [任务id]` | 任务执行轨迹 |
| `/usage [天数]` | 用量聚合，默认 7 天 |
| `/stop` | 中止当前会话正在跑的任务 |
| `/new` | 清空当前会话历史 |
| `/help` | 显示帮助 |

直接发消息即下发任务。`@researcher 查一下 TOML 1.0 的日期类型` 这样以 `@智能体id` 开头就能定向派活，不写则用 `default_agent`。长任务会先回一条占位消息，随后按 `edit_interval_ms` 节流地编辑同一条消息推进度；超过 `async_threshold_ms` 的任务转为异步模式，完成后再推终态。

## 手机端：微信与企业微信 (WeChat / WeCom)

平台原生支持四种微信接入模式：**个人微信扫码绑定 iLink Bot**、**Wechaty Puppet Service**、**企业微信（WeCom）机器人与自建应用**、**微信公众号**。

```toml
[channels.wechat]
enabled = true
mode = "ilink_bot"            # 可选 "ilink_bot" | "personal" | "wecom" | "official_account"
default_agent = "coder"
mention_patterns = ["@hap"]
message_char_limit = 2048
auth_dir = "~/.hap/wechat-auth"
qr_log = true                 # 启动时是否在终端打印扫码二维码

# iLink Bot 模式不需要 WECHATY_PUPPET_SERVICE_TOKEN。
# 手机微信扫码后绑定的是腾讯 iLink Chatbot 身份，不是把个人微信账号本身登录成自动回复客户端。
[channels.wechat.personal]
puppet = "ilink"
ilink_account_id = "bot-local"

# 企业微信 WeCom 模式可选配置
[channels.wechat.wecom]
corp_id = "ww1234567890abcdef"
corp_secret_env = "WECHAT_WECOM_CORP_SECRET"
agent_id = 1000002
token = "your_wecom_token"
encoding_aes_key = "your_encoding_aes_key"
webhook_url_env = "WECHAT_WECOM_WEBHOOK_URL"
bind = "0.0.0.0:8789"
path = "/wecom"
```

### 使用方式：
1. **个人微信扫码绑定 iLink Bot**：执行 `hap serve` 或在 GUI 控制台点选「微信 / 企微连接」→「启动微信服务」，使用手机微信扫码绑定机器人身份，凭据自动持久化，支持私聊指令。
2. **Wechaty Puppet Service**：仅在显式配置 `mode = "personal"` 且 `[channels.wechat.personal].puppet = "service"` 时启用，需要供应商提供 `WECHATY_PUPPET_SERVICE_TOKEN`。
3. **企业微信 WeCom**：在企业微信后台配置应用或群机器人 Webhook，支持富文本 Markdown 进度与代码输出，企业级稳定免封号。

## HTTP 通道

```toml
[channels.http]
enabled = true
bind = "127.0.0.1:8787"
default_agent = "coder"
```

| 方法与路径 | 作用 |
| --- | --- |
| `GET /health` | 存活探测，返回智能体 id 列表 |
| `GET /agents` | 智能体 id 列表 |
| `GET /status/:session` | 会话状态（结构化 + 文本两份） |
| `GET /trace/:taskId` | 任务轨迹摘要，找不到返回 404 |
| `GET /usage?days=7` | 用量聚合 |
| `POST /stop/:session` | 中止该会话的任务 |
| `POST /run` | 同步执行，一次性返回终态 |
| `POST /stream` | SSE 流式返回事件 |
| `POST /message` | 走通道调度器，与 Telegram 同一套渲染逻辑 |

请求体形如 `{ "prompt": "...", "agent": "researcher", "session": "http:demo" }`。

## CLI 全景

| 命令 | 作用 |
| --- | --- |
| `hap init [--force]` | 写入配置骨架 |
| `hap serve [--with-cli]` | 拉起全部启用的通道 |
| `hap run <prompt...>` | 单次执行，支持 `-a` 指定智能体、`-s` 指定会话、`--quiet`、`--no-persist` |
| `hap chat` | 本地交互式对话 |
| `hap config path|keys|explain <key>|limits|channels` | 配置自省 |
| `hap provider list|presets|add|remove|check|models` | 服务商管理 |
| `hap model list|presets|add|remove|import` | 模型目录管理 |
| `hap agent list|templates|show|create|update|remove` | 智能体管理 |
| `hap status [session]` / `hap trace <taskId>` / `hap stop <session>` | 运行时观测与干预 |
| `hap usage [-d n]` / `hap prune [-d n]` | 用量统计与记录清理 |
| `hap doctor [--skip-network]` | 全面体检 |

全局选项：`-c/--config` 指定配置文件、`-p/--profile` 切档位、`--json` 输出结构化结果给脚本消费。

`hap config explain` 值得单独提一句。配置走六层覆盖（`cli` → `env` → `agent` → `profile` → `defaults` → `builtin`），排查「为什么这个智能体用的不是我想要的模型」时：

```powershell
hap config explain model -a coder
```

会把六层各自的取值、出处、以及哪一层胜出全列出来。

## 配置档位

`profiles` 用来整体切换一批默认值，最典型的是云端与本地离线两套：

```toml
active_profile = "cloud"

[profiles.cloud]
default_model = "deepseek/deepseek-chat"

[profiles.local]
default_model = "ollama/hermes3:8b"
utility_model = "ollama/hermes3:8b"
protocol = "hermes-native"
```

`hap -p local run "..."` 即可临时切到本地模型跑，不动配置文件。

## 目录约定

| 配置键 | 缺省值 | 存什么 |
| --- | --- | --- |
| `paths.data_dir` | `~/.hap` | SQLite 会话库与派生目录的根 |
| `paths.trace_dir` | `<data_dir>/traces` | 每任务一份 JSONL 轨迹 |
| `paths.overflow_dir` | `<data_dir>/overflow` | 超长工具输出的落盘副本 |
| `paths.spool_dir` | `<data_dir>/spool` | 出站消息暂存，用于断连重投 |
| `agents.defaults.workspace_root` | `~/.hap/workspaces` | 各智能体的文件工作目录父级 |
| `agents.defaults.agent_dir_root` | `~/.hap/agents` | 各智能体的状态目录父级（含 `system.md`） |

## 配额上限

`limits` 表控制运行时边界，全部可按智能体覆盖：`max_iterations`（默认 24）、`max_subagent_depth`（3）、`tool_timeout_ms`（120000）、`tool_output_max_bytes`（262144，超出落 overflow）、`compact_threshold`（0.8，触发历史压缩）、`daily_token_budget`（5000000）、`session_retention_days`（30）、`ingress_queue_size`（1000）、`default_provider_concurrency`（4）、`default_agent_concurrency`（2）。

`hap config limits` 看生效值。

## MCP 工具接入

```toml
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "D:/work"]
```

启动时自动发现工具并注册成 `filesystem__read_file` 这类名字，在智能体的 `--allow-tool` / `--deny-tool` 里按这个名字引用。`hap doctor` 会报告加载失败的服务器。

## 开发

```powershell
npm run typecheck   # tsc --noEmit
npm test            # vitest run，404 项
npm run lint        # eslint
```

源码分层：`src/domain` 纯类型与错误、`src/config` 加载/校验/解析/写回、`src/providers` 服务商客户端与连通性、`src/protocol` 四套协议适配与流式解析、`src/tools` 8 个内置工具与 MCP 桥接、`src/agent` 任务循环与编排、`src/storage` SQLite 与轨迹、`src/channels` 三个通道与统一调度、`src/cli` 命令行。
