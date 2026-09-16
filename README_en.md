# Hermes Agent Platform (HAP)

A modern multi-agent workbench built with Electron and TypeScript that unifies model configuration, project chat, agent personas, messaging channels, and host management into a single desktop application. It also supports task execution via CLI or HTTP APIs, and manages providers, models, and agents through TOML configuration files.

The official desktop application is branded as **Hermes Agent Platform**, while the source code and CLI retain the **HAP** nomenclature.

The packaged desktop app checks GitHub Releases once after startup. When a newer stable version is available, the in-app update dialog shows release notes and download progress, then offers a restart-and-install action. Development runs do not check for updates.

[简体中文](README.md) · [English](README_en.md)

[UI Preview](#ui-preview) · [Quick Start](#quick-start) · [Packaging](#packaging) · [CLI Overview](#cli-overview) · [Development](#development)

## What It Solves

- **Multi-Model Integration**: Built-in presets for 8 major model providers. Manage providers and models via UI or CLI at runtime without touching source code.
- **Dedicated Agent Personas**: Declarative generation where each agent binds its own primary model, fallback chains, tool profile tier, and subagent whitelist.
- **Your Phone as a Terminal**: Dual-mode Telegram (long polling or webhook) and WeChat / WeCom iLink bot integration. Direct tasks using `@agent_id` prefixes.
- **Traceability & Auditing**: Every executed task records a structured JSONL execution trace, with token usage aggregated by agent and model.

## UI Preview

The following screenshots depict actual interfaces from the development version (configuration paths cropped). Interface details may evolve across releases.

### Chat Workspace

Organize conversations by workspace projects, select agent personas, upload text, images, or files, and access Git and developer tools directly.

![HAP Chat Workspace: Project Sidebar, Agent Selector, and Chat Composer](docs/images/chat-workspace.png)

### Host Monitoring

Monitor CPU, memory, disk, and operating system metrics at a glance, and configure node bots and alerting endpoints.

![HAP Host Monitoring: CPU, Memory, Disk, and Node Bot Configuration](docs/images/host-dashboard.png)

## Quick Start

### Prerequisites

- Recommended: Node.js 22 LTS and npm. The project declares Node.js >=20; some dependencies may require newer minor versions.
- Electron is used for the desktop GUI. Model execution requires an API key from the respective provider, or an accessible local Ollama service.
- `better-sqlite3` is a native C++ dependency. When precompiled binaries are unavailable, macOS requires Xcode Command Line Tools, and Windows requires Python and Visual Studio Build Tools with the "Desktop development with C++" workload.

### Launching the Desktop App

Run in the project root (works on macOS terminal, Linux bash, and Windows PowerShell):

```bash
npm install
npm run gui
```

`gui` will compile TypeScript, copy frontend assets, rebuild SQLite for Electron, and launch the desktop window. The first launch and native module rebuild may take a moment.

Navigate to System Settings to configure providers, API keys, and models, specify models in Agent Personas, and return to the Chat Workspace to begin collaborating.

### Using the Command Line (CLI)

The CLI and desktop application utilize different Node.js runtimes. Before switching from desktop to CLI, execute `npm run rebuild:node`. The following example demonstrates using the default DeepSeek-backed `researcher` agent.

macOS / Linux:

```bash
npm run rebuild:node
npm run hap -- init
export DEEPSEEK_API_KEY='your-api-key-here'
npm run hap -- doctor --skip-network
npm run hap -- run "Explain TOML array of tables in three concise sentences" -a researcher
```

Windows PowerShell:

```powershell
npm run rebuild:node

# 1) Generate configuration skeleton: 8 providers, 9 models, 5 agents
npx tsx src/cli/bin.ts init

# 2) Export your API key (only for providers you intend to use)
$env:DEEPSEEK_API_KEY = 'sk-...'

# 3) Health check: config parsing, credential availability, provider connectivity
npx tsx src/cli/bin.ts doctor --skip-network

# 4) Run a single task to verify the pipeline
npx tsx src/cli/bin.ts run "Explain TOML array of tables in three concise sentences" -a researcher

# 5) Launch messaging channels
$env:TELEGRAM_BOT_TOKEN = '123456:ABC...'
# Set channels.telegram.default_agent to researcher in config.toml first
npx tsx src/cli/bin.ts serve
```

The default configuration file is stored at `~/.hap/config.toml`. Do not casually use `init --force` on an existing setup, as it will overwrite current configurations. `doctor` may report missing credentials for unused providers; configure them as needed. Omit `--skip-network` to perform live network connectivity checks.

In the documentation below, `hap` is shorthand for `npm run hap --` (it is not automatically installed into global PATH). For example, `hap agent list` corresponds to `npm run hap -- agent list`. Multi-line PowerShell examples use backticks (`` ` ``) for line continuations; on macOS/Linux, substitute backslashes (`\`) or combine lines into a single command.

## Packaging

Hermes Agent Platform uses pinned versions of `electron-builder` to produce distributables, writing artifacts to `release/`. Run the appropriate command on your target OS to ensure `better-sqlite3` compiles for the correct platform and architecture:

```bash
# Windows x64: NSIS installer and Portable executable
npm run dist:win -- --x64

# Ubuntu x64: Debian package
npm run dist:linux -- --x64

# macOS: Select Apple Silicon or Intel based on your target hardware
npm run dist:mac -- --arm64
npm run dist:mac -- --x64
```

The release file names for v0.1.3 are:

- `Hermes-Agent-Platform-0.1.3-Windows-x64-Setup.exe`
- `Hermes-Agent-Platform-0.1.3-Windows-x64-Portable.exe`
- `Hermes-Agent-Platform-0.1.3-Ubuntu-amd64.deb`
- `Hermes-Agent-Platform-0.1.3-macOS-arm64.dmg`
- `Hermes-Agent-Platform-0.1.3-macOS-x64.dmg`

Pushing a `v*` tag matching the version in `package.json` triggers GitHub Actions to run tests and builds across native Windows, Ubuntu, macOS arm64, and macOS Intel runners. Only when all builds succeed will the workflow draft a GitHub Release and attach all installer packages.

v0.1.3 does not come pre-configured with Apple Developer ID or Windows Authenticode code signing certificates. Windows SmartScreen or macOS Gatekeeper may display an unrecognized publisher prompt on initial launch. Prior to signing production binaries, always verify installation, launch, model invocation, SQLite session persistence, and uninstallation workflows on the target systems.

### Troubleshooting

| Issue | Resolution |
| --- | --- |
| `NODE_MODULE_VERSION` mismatch or SQLite module load failure | Run `npm run rebuild:node` before CLI/tests; run `npm run gui` for desktop (it auto-rebuilds Electron modules) |
| Native module compilation failure | On macOS run `xcode-select --install`; on Windows install Python and Visual Studio C++ Build Tools |
| Missing API key or model invocation failure | Verify provider, model alias, and environment variables bound to the agent, then run `npm run hap -- doctor` |
| Packaging command executed on wrong platform | Use the corresponding `dist:win`, `dist:linux`, or `dist:mac` script for your current operating system |
| Electron or builder asset download timeouts | Verify network proxy and npm registry settings, then retry |

## Runtime Providers and Models Configuration

A core architecture principle: providers and models are configuration data, not code branches.

```powershell
# Custom internal gateway: inherit deepseek wire format and protocol, override base URL
hap provider add mycorp --preset deepseek --base-url https://gw.example.com/v1

# Declare a provider from scratch: configure wire API, protocol, headers, and token limits
hap provider add acme `
  --base-url https://api.acme.ai/v1 `
  --env-key ACME_API_KEY `
  --wire-api chat `
  --protocol openai-tools `
  --header X-Title=HAP `
  --env-header X-Trace=ACME_TRACE `
  --max-tokens-default 4096

# Bind a model to this provider
hap model add acme-large --provider acme --model acme-large-v2 `
  --context-window 200000 --max-output-tokens 16384 `
  --capability tools --capability streaming --param temperature=0.3

# Or batch-import model catalogs exposed by the provider
hap model import acme --filter large --dry-run
hap model import acme --filter large

# Inspect and delete
hap provider list
hap provider check acme
hap model list --provider acme
hap model remove acme-large
```

Executing `hap provider add <id>` or `hap model add <alias>` without options launches an interactive questionnaire suitable for initial setup. Provide explicit arguments in automated scripts to avoid blocking on interactive prompts.

### Built-in Provider Presets

| Preset | base_url | Environment Variable | Wire API | Default Protocol |
| --- | --- | --- | --- | --- |
| deepseek | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | chat | deepseek |
| openai | `https://api.openai.com/v1` | `OPENAI_API_KEY` | responses | openai-tools |
| anthropic | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` | anthropic-messages | anthropic |
| zhipu | `https://open.bigmodel.cn/api/paas/v4` | `ZHIPU_API_KEY` | chat | openai-tools |
| gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | `GEMINI_API_KEY` | chat | openai-tools |
| openrouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | chat | openai-tools |
| nous | `https://inference-api.nousresearch.com/v1` | `NOUS_API_KEY` | chat | hermes-native |
| ollama | `http://localhost:11434/v1` | None | chat | hermes-native |

Three distinct concepts to clarify:
- **Wire API**: The HTTP wire format (`chat` for Chat Completions, `responses` for OpenAI Responses, `anthropic-messages` for Anthropic Messages).
- **Protocol**: How tool calls are framed and parsed (`openai-tools` for standard tools schema, `deepseek` with reasoning field support, `anthropic` for content blocks, `hermes-native` for raw `<tool_call>` tag stream extraction).
- **Model Alias**: The logical name referenced across agent definitions.

Nine built-in model aliases: `deepseek-chat`, `deepseek-reasoner`, `claude-sonnet-4-5`, `gpt-5-codex`, `glm-4.6`, `gemini-2.5-pro`, `gemini-2.5-flash`, `hermes-4-405b`, `hermes3:8b`.

## Declarative Agent Generation

```powershell
# Create from template, overriding primary model
hap agent create qa --template reviewer --model deepseek/deepseek-chat --name "QA Reviewer"

# Full custom configuration: fallback chain, tool tier, subagents, system prompt
hap agent create trader `
  --model anthropic/claude-sonnet-4-5 `
  --fallback deepseek/deepseek-reasoner --fallback openrouter/glm-4.6 `
  --utility-model deepseek/deepseek-chat `
  --tools-profile research `
  --deny-tool shell `
  --subagent researcher `
  --mode persistent `
  --prompt "You are responsible for market analysis. Output conclusions and evidence only; do not write code."

hap agent list
hap agent show trader
hap agent update trader --param temperature=0.2
hap agent remove trader   # Deletes config entry only; workspace and session history are preserved
```

`--prompt` writes content into `system.md` inside the agent's state directory and populates `system_prompt_file`, allowing you to edit the markdown file directly thereafter.

### Five Built-in Skeleton Agents

| ID | Primary Model | Tool Tier | Responsibility |
| --- | --- | --- | --- |
| coder | `anthropic/claude-sonnet-4-5` | coding | Code development, bug fixing, shell execution; can spawn researcher / reviewer |
| researcher | `deepseek/deepseek-reasoner` | research | Information lookup, document parsing, research synthesis |
| reviewer | `openai/gpt-5-codex` | coding (deny shell/write) | Read-only code review and inspection |
| writer | `zhipu/glm-4.6` | standard | Documentation and copywriting |
| ops | `gemini/gemini-2.5-flash` | minimal | Lightweight Q&A and system health inspection |

A sixth template `vision` (`gemini/gemini-2.5-pro`) is available on demand: `hap agent create <id> --template vision`.

### Tool Profiles

| Tier | Included Tools |
| --- | --- |
| minimal | `read_file`, `list_dir` |
| standard | File read/write, search, HTTP requests, host information, symbol retrieval, image generation |
| coding | File read/write, shell execution, patch applications, subagents, remote ops, and developer utilities |
| research | File read/write, search, HTTP requests, subagents, and knowledge querying |
| full | All built-in tools |

The authoritative tool catalog is defined in [src/config/defaults.ts](src/config/defaults.ts) under `TOOL_PROFILES`.

`--allow-tool` narrows allowed tools on top of the profile; `--deny-tool` has highest priority. MCP tools are referenced as `server__tool`.

## Mobile Channels: Telegram

```toml
[channels.telegram]
enabled = true
token_env = "TELEGRAM_BOT_TOKEN"
mode = "polling"          # or "webhook"
default_agent = "coder"
mention_patterns = ["@hap"]

# Append this block for webhook mode
[channels.telegram.webhook]
url = "https://your.domain/hap/telegram"
bind = "0.0.0.0:8788"
path = "/hap/telegram"
```

Polling is zero-config and ideal for local machines and private networks; webhook is suited for production deployments with public domains (calls `setWebhook` on startup). The two modes are mutually exclusive and validated at launch.

Commands available in chat:

| Command | Description |
| --- | --- |
| `/agents` | List all available agents |
| `/agent <id>` | Inspect an agent's model and toolset |
| `/status` | Current session status and today's token usage |
| `/trace [taskId]` | Task execution trace |
| `/usage [days]` | Aggregated token usage (default 7 days) |
| `/stop` | Abort active task in the current session |
| `/new` | Clear session conversation history |
| `/help` | Show command reference |

Sending messages directly dispatches tasks. Prefixing with `@agent_id` (e.g., `@researcher Summarize TOML 1.0 datetime specs`) routes to a specific persona; omitting it falls back to `default_agent`. Long-running tasks return an initial placeholder message, throttled via `edit_interval_ms` to update progress on the same message; tasks exceeding `async_threshold_ms` transition to async mode and push final results upon completion.

## Mobile Channels: WeChat and WeCom

The platform natively supports four WeChat integration modes: **Personal WeChat QR Scan via iLink Bot**, **Wechaty Puppet Service**, **WeCom (Enterprise WeChat) Bots & Custom Apps**, and **WeChat Official Accounts**.

```toml
[channels.wechat]
enabled = true
mode = "ilink_bot"            # Options: "ilink_bot" | "personal" | "wecom" | "official_account"
default_agent = "coder"
mention_patterns = ["@hap"]
message_char_limit = 2048
auth_dir = "~/.hap/wechat-auth"
qr_log = true                 # Print terminal QR code on launch

# iLink Bot mode does not require WECHATY_PUPPET_SERVICE_TOKEN.
# Scanning the QR code binds the Tencent iLink Chatbot persona rather than converting your personal account into an auto-reply client.
[channels.wechat.personal]
puppet = "ilink"
ilink_account_id = "bot-local"

# WeCom optional configuration
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

### Setup Instructions:
1. **Personal WeChat QR Scan via iLink Bot**: Run `hap serve` or click "WeChat / WeCom Connection" → "Start WeChat Service" in the GUI. Scan the QR code using your mobile WeChat app. Credentials persist automatically, and private chat commands are supported.
2. **Wechaty Puppet Service**: Only enabled when explicitly configured with `mode = "personal"` and `[channels.wechat.personal].puppet = "service"`. Requires a provider-supplied `WECHATY_PUPPET_SERVICE_TOKEN`.
3. **WeCom (Enterprise WeChat)**: Configure an application or group bot webhook in the WeCom admin portal, setting the corresponding credentials and callback URL.

## HTTP Channel

```toml
[channels.http]
enabled = true
bind = "127.0.0.1:8787"
default_agent = "coder"
```

| Method & Path | Description |
| --- | --- |
| `GET /health` | Liveness probe returning available agent IDs |
| `GET /agents` | List available agent IDs |
| `GET /status/:session` | Session status (both structured JSON and text) |
| `GET /trace/:taskId` | Task trace summary (404 if not found) |
| `GET /usage?days=7` | Aggregated token usage |
| `POST /stop/:session` | Abort active task for this session |
| `POST /run` | Synchronous execution returning final response |
| `POST /stream` | Server-Sent Events (SSE) streaming output |
| `POST /message` | Channel dispatcher using the same rendering pipeline as Telegram |

Request body format: `{ "prompt": "...", "agent": "researcher", "session": "http:demo" }`.

## CLI Overview

| Command | Description |
| --- | --- |
| `hap init [--force]` | Initialize configuration skeleton |
| `hap serve [--with-cli]` | Launch all enabled messaging channels |
| `hap run <prompt...>` | Single task execution; supports `-a` agent, `-s` session, `--quiet`, `--no-persist` |
| `hap chat` | Interactive local terminal chat |
| `hap config path|keys|explain <key>|limits|channels` | Configuration introspection |
| `hap provider list|presets|add|remove|check|models` | Provider management |
| `hap model list|presets|add|remove|import` | Model catalog management |
| `hap agent list|templates|show|create|update|remove` | Agent persona management |
| `hap status [session]` / `hap trace <taskId>` / `hap stop <session>` | Runtime observation and intervention |
| `hap usage [-d n]` / `hap prune [-d n]` | Token usage statistics and trace pruning |
| `hap doctor [--skip-network]` | Comprehensive system health check |

Global flags: `-c/--config` specifies a custom configuration file path; `-p/--profile` selects a configuration profile; `--json` formats structured output for script consumption.

`hap config explain` deserves special mention. Configuration undergoes a 6-layer override resolution (`cli` → `env` → `agent` → `profile` → `defaults` → `builtin`). When troubleshooting why an agent is not using the expected model:

```powershell
hap config explain model -a coder
```

This displays the resolved value, provenance, and winning layer across all six tiers.

## Configuration Profiles

`profiles` allow switching groups of default values collectively, most typically between cloud and offline local environments:

```toml
active_profile = "cloud"

[profiles.cloud]
default_model = "deepseek/deepseek-chat"

[profiles.local]
default_model = "ollama/hermes3:8b"
utility_model = "ollama/hermes3:8b"
protocol = "hermes-native"
```

Execute `hap -p local run "..."` to run tasks against the local model profile without modifying the configuration file.

## Directory Conventions

| Configuration Key | Default Value | Contents |
| --- | --- | --- |
| `paths.data_dir` | `~/.hap` | Root directory for SQLite databases and derived storage |
| `paths.trace_dir` | `<data_dir>/traces` | JSONL execution trace for each task |
| `paths.overflow_dir` | `<data_dir>/overflow` | Disk backups for oversized tool call outputs |
| `paths.spool_dir` | `<data_dir>/spool` | Outbound message spool for reconnection retries |
| `agents.defaults.workspace_root` | `~/.hap/workspaces` | Parent directory for agent workspace file trees |
| `agents.defaults.agent_dir_root` | `~/.hap/agents` | Parent directory for agent state and `system.md` |

## Limits & Quotas

The `limits` table defines runtime execution boundaries, all overridable per agent: `max_iterations` (default 24), `max_subagent_depth` (3), `tool_timeout_ms` (120000), `tool_output_max_bytes` (262144, overflows saved to disk), `compact_threshold` (0.8, triggers history compression), `daily_token_budget` (5000000), `session_retention_days` (30), `ingress_queue_size` (1000), `default_provider_concurrency` (4), `default_agent_concurrency` (2).

Run `hap config limits` to view active resolved limits.

## MCP Tool Integration

```toml
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "D:/work"]
```

Tools are discovered on startup and registered as `filesystem__read_file`. Reference them by this identifier in `--allow-tool` and `--deny-tool`. `hap doctor` identifies servers that failed to connect.

## Development

```powershell
npm run typecheck    # tsc --noEmit
npm run rebuild:node # Switch back to Node.js native modules from Electron
npm test             # vitest run
npm run lint         # eslint
npm run build        # Compile TypeScript and copy desktop GUI assets
```

### Source Code Architecture

| Directory | Responsibility |
| --- | --- |
| `src/gui` | Electron main process, IPC handlers, desktop renderer UI, and app services |
| `src/cli` / `src/web` | CLI entry points and Web server interfaces |
| `src/config` | TOML loading, validation, schema parsing, and write-back |
| `src/providers` / `src/protocol` | Provider adapters, streaming parsers, and wire protocols |
| `src/agent` / `src/tools` | Multi-agent orchestration, built-in tool suite, and MCP integration |
| `src/channels` | Telegram, WeChat, Feishu, QQ, WhatsApp, and HTTP channel implementations |
| `src/remote` / `src/system` | SSH remote management and local system diagnostics |
| `src/storage` / `src/memory` / `src/scheduler` | Session persistence, agent memories, and scheduled cron jobs |
| `src/control-plane` / `src/security` | Authorization, policies, and network security control |
| `src/telemetry` / `src/domain` | Usage telemetry, domain models, and error definitions |
| `tests` | Automated test suites |

Refer to [Project Specifications](specs/hermes-agent-platform.spec.md) for architectural blueprints. Execute typecheck, tests, and lint prior to submitting changes. Screenshots are archived under `docs/images/`.
