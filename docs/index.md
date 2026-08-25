# Hermes Agent Platform 使用说明

日期：2026-08-25　执行者：Codex

本文档说明本项目首发范围的本地启动、服务商与模型配置、智能体生成、Telegram 手机端下发指令，以及本地验证方式。详细需求规格见 [hermes-agent-platform.spec.md](../specs/hermes-agent-platform.spec.md)，完整验证留痕见 [verification.md](../verification.md)。

## 1. 初始化配置

在项目根目录执行：

```powershell
npx tsx src/cli/bin.ts init
```

命令会生成默认 TOML 配置，内置 DeepSeek、OpenAI/ChatGPT、Anthropic Claude、智谱 GLM、Google Gemini、OpenRouter、Nous、Ollama 等服务商预设，并生成一组默认智能体。

## 2. 配置服务商与模型

添加服务商：

```powershell
npx tsx src/cli/bin.ts provider add my-provider --base-url https://example.com/v1 --env-key MY_PROVIDER_API_KEY --default-protocol openai-tools
```

添加模型：

```powershell
npx tsx src/cli/bin.ts model add my-model --provider my-provider --model api-model-name --context-window 128000 --capabilities text,tools
```

批量导入远端模型目录：

```powershell
npx tsx src/cli/bin.ts model import --provider my-provider
```

配置生效来源自省：

```powershell
npx tsx src/cli/bin.ts config explain models.my-model.provider
```

## 3. 生成并绑定智能体

从模板创建智能体：

```powershell
npx tsx src/cli/bin.ts agent create analyst --from-template researcher --model deepseek-reasoner --utility-model gemini-flash
```

查看、更新、删除智能体：

```powershell
npx tsx src/cli/bin.ts agent list
npx tsx src/cli/bin.ts agent show analyst
npx tsx src/cli/bin.ts agent update analyst --model claude-sonnet
npx tsx src/cli/bin.ts agent remove analyst
```

每个智能体可独立绑定主模型、降级模型、工具档位、工作目录与允许派生的子智能体，从而实现“不同智能体指向不同模型执行不同任务”。

## 4. Telegram 手机端通道

配置环境变量：

```powershell
$env:TELEGRAM_BOT_TOKEN = "你的 Telegram Bot Token"
```

启动服务：

```powershell
npx tsx src/cli/bin.ts serve
```

Telegram 支持以下指令：

- `/agents`：列出可用智能体
- `/agent <id>`：切换当前会话默认智能体
- `/status`：查看当前任务状态
- `/trace [id]`：查看任务 trace
- `/usage [days]`：查看用量统计
- `/stop`：中止当前会话任务
- `/new`：开启新会话
- `/help`：查看帮助

普通消息也可用 `@智能体id` 显式指派，例如：

```text
@coder 帮我实现这个函数
@reviewer 审查刚才的改动
```

群聊中可先用唤起词唤醒，再交给某个智能体：

```text
@hap @researcher 查一下这个接口的行为
```

## 5. WhatsApp 手机端通道

WhatsApp 通道基于 @whiskeysockets/baileys 实现，首次启动会在终端打印二维码，用手机 WhatsApp「已链接的设备」扫码即可完成登录。登录凭据持久化在 channels.whatsapp.auth_dir（默认 ~/.hap/whatsapp-auth），重启后免扫码。

在 hap.toml 中启用：

```toml
[channels.whatsapp]
enabled = true
# auth_dir = '~/.hap/whatsapp-auth'
# default_agent = 'coder'
# mention_patterns = ['@hap']
# qr_log = true
```

群聊与 Telegram 一致：只有唤起词、@智能体id 或斜杠命令会触发响应；私聊默认全部响应。断线后自动按指数退避重连，用户主动登出不再重连。

## 6. HTTP 与 CLI 通道

本地一次性运行：

```powershell
npx tsx src/cli/bin.ts run "解释当前项目结构" --agent coder
```

HTTP 通道提供 webhook 与 SSE 流式能力，可用于将外部系统接入同一套任务编排器。

## 7. 本地验证

类型检查：

```powershell
npx tsc -p tsconfig.json --noEmit
```

全量测试：

```powershell
npx vitest run
```

当前首发范围的自动化验证覆盖配置、服务商、模型、协议、工具、智能体、路由、存储、Telegram、HTTP、CLI 与任务编排。真实 Telegram Bot、公网 webhook 与联网模型调用属于部署期验证项，需要可用 Token、公网域名与服务商额度。
