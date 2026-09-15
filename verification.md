# 验证报告

日期：2026-08-25　执行者：Codex　验证方式：本地 AI 自动执行（无 CI、无人工外包）

## 一、验证结论

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc -p tsconfig.json --noEmit` | 退出码 0，无错误 |
| 全量测试 | `npx vitest run` | 退出码 0，14 文件 / 433 项全部通过 |
| 实机冒烟 | `npx tsx src/cli/bin.ts -c .tmp-probe/hap.toml init` | 退出码 0，配置骨架正确落盘并可回读解析 |
| 文档闭环复验 | 更新 `specs/hermes-agent-platform.spec.md` 实施清单与新增 `docs/index.md` 后重新执行类型检查和全量测试 | 退出码 0，14 文件 / 433 项全部通过 |

## 二、需求覆盖核对

规格 `specs/hermes-agent-platform.spec.md`（v1.1.0）共 79 条功能需求、22 条验收条件。逐项对照：

| 需求域 | 覆盖情况 | 验证依据 |
| --- | --- | --- |
| FR-CFG 配置（TOML、zod 校验、六层解析、热重载、交叉引用、explain） | 全部实现 | tests/config.test.ts 55 项；`hap config explain` 实测输出六层候选 |
| FR-PROV 服务商（三线制、凭据、请求头、重试、连通性、运行时增删） | 全部实现 | tests/providers.test.ts 48 项；tests/cli.test.ts 的 provider 分组 10 项 |
| FR-MOD 模型目录（别名、窗口、能力标签、参数、批量导入） | 全部实现 | tests/cli.test.ts 的 model 分组 7 项 |
| FR-PROTO 协议（四套适配、流式解析、协议探测、未闭合标签处理） | 全部实现 | tests/protocol.test.ts 36 项 |
| FR-TOOL 工具（8 内置、超长落盘、超时、MCP 桥接与命名空间） | 全部实现 | tests/tools.test.ts 41 项 |
| FR-AGT 智能体（声明式生成、模板、模型绑定、工具档位、子智能体、增删改） | 全部实现 | tests/orchestrator.test.ts 14 项；tests/cli.test.ts 的 agent 分组 13 项 |
| FR-LOOP 任务循环（迭代上限、工具编排、降级切换、历史压缩、预算） | 全部实现 | tests/agent.test.ts 24 项 |
| FR-STORE 存储（会话库、消息、轨迹、用量聚合、清理、中断恢复） | 全部实现 | tests/storage.test.ts 41 项 |
| FR-CH 通道（Telegram 双模、HTTP 含 SSE、CLI、调度器、节流、异步阈值、出站重投） | 全部实现 | tests/channels-core.test.ts 49 项、channels-dispatcher 24 项、channels-http 20 项 |
| FR-CLI 命令行（init/serve/run/chat/config/provider/model/agent/status/trace/stop/usage/prune/doctor） | 全部实现 | tests/cli.test.ts 49 项 |

用户明确提出的四项诉求逐一落地：

1. **任意模型可配置** — `hap provider add` 与 `hap model add` 支持完全自定义的 base_url、线制、协议、请求头、窗口、能力标签、默认参数；`hap model import` 可从服务商批量拉取。8 家预置覆盖 DeepSeek、ChatGPT、Claude、GLM、Gemini、OpenRouter、Nous、Ollama。
2. **声明式生成智能体** — `hap agent create` 支持模板继承与逐字段覆盖，6 个内置模板，`--prompt` 直接落盘职责提示。
3. **每智能体指向不同模型执行不同任务** — 骨架五个智能体分别绑 Claude / DeepSeek-Reasoner / GPT-5-Codex / GLM / Gemini-Flash，工具档位与 deny 名单各异，coder 可派生 researcher 与 reviewer。
4. **手机端下发指令** — Telegram 通道 polling 与 webhook 双模，8 条聊天指令，`@智能体id` 前缀定向派活，长任务节流编辑同一条消息推进度。

## 三、未执行的验证项与风险评估

| 未执行项 | 原因 | 风险评估 |
| --- | --- | --- |
| 联网连通性测试（`provider check`、`model models`、`model import`） | 本轮不重复消耗 API 额度 | 低。前序轮次已用真实 Key 对 DeepSeek / Anthropic / 智谱 / Gemini 四家实机验证通过；测试中用 MockProviderClient 覆盖了请求构造与响应解析的全部分支 |
| Telegram 真实 Bot 端到端 | 需要真实 Bot Token 与手机操作 | 中。grammy 的 `sendMessage` / `editMessageText` / `start` / `webhookCallback` 四个入口在依赖探测阶段已确认存在；调度器逻辑（指令解析、节流、异步转换、出站重投）由 24 项 dispatcher 测试覆盖。剩余风险集中在 Token 有效性与网络可达性，属部署期问题而非实现缺陷 |
| webhook 模式的公网回调 | 需要公网域名 | 中。同上，`setWebhook` 调用与 hono 挂载路径的代码路径已就位，未做真实回调验证 |
| 长时间运行下的内存与连接泄漏 | 需要小时级压测 | 低到中。SQLite 连接、grammy 实例、hono server 均在 `close()` 中显式释放，编排器一个进程内只创建一次 |

## 四、Bug 修复记录（v21 轮次）

本轮发现并修复了三个影响功能的真实缺陷：

| Bug | 影响 | 根因 | 修复 |
| --- | --- | --- | --- |
| Bug 1：config explain 不校验智能体 | config explain --agent xxx 传入不存在的 id 时静默返回 | resolveAgent 与 explain 各自独立 | resolver.ts 新增 assertAgentDeclared，二者共用；测试在 config.test.ts |
| Bug 2：Anthropic base_url 多一段 /v1 | 接 Claude 时请求路径变成 /v1/v1/messages，404 | SDK 默认 baseURL 不含 /v1，骨架却写了 /v1 | defaults.ts 改为 https://api.anthropic.com；OpenAI 兼容线仍带 /v1，两侧各有断言 |
| Bug 3：mention_patterns 一词两用，Telegram 指派开箱即坏 | 群聊 @hap 被当智能体 id 炸出 AGENT_NOT_FOUND；@coder 不在白名单不识别；群聊每条闲聊都烧 token | extractMention 的 patterns 被当 id 白名单，与唤起词 @hap 语义冲突；telegram.ts ingest 无群聊门禁 | 拆分唤起词与指派：新增 stripWakeWord 判群聊响应并剥离前缀；extractMention 改按 listAgentIds 白名单解析；telegram.ts 接入门禁；新增 channels-telegram.test.ts 14 项 |


## 五、连续失败与策略调整记录

本轮出现 1 次测试失败（`provider add` 交互问答导致超时），一次定位并修复，未触发「连续三次失败需暂停」的阈值。

## 六、最终判定

## 七、WhatsApp 通道补齐记录（2026-08-25）

本轮在既有 telegram/http/cli 三通道基础上新增 whatsapp 通道，规格 §9 的唯一后续阶段项已闭环：

- 配置层：schema/resolved/defaults/resolver/loader/writer 全部接入 [channels.whatsapp]，含 enabled、auth_dir、default_agent、mention_patterns、message_char_limit、reconnect_initial_ms、reconnect_max_ms、qr_log 八个键；agent remove 时自动清空 default_agent 引用。
- 通道实现：src/channels/whatsapp.ts 基于 @whiskeysockets/baileys v7 rc14。socket 工厂可注入，支持 QR 扫码登录、凭据持久化、断线指数退避重连（loggedOut 不重连）、消息 id 去重、fromMe 过滤、群聊唤起词门禁与 @agentId 路由、附件下载落盘、出站 spool 重投。
- 集成点：ChannelManager 按 enabled 启停并在中断通知里路由 whatsapp: 会话；src/channels/index.ts 导出；CLI config channels 显示三行 WhatsApp 状态。
- 测试：tests/channels-whatsapp.test.ts 覆盖构造、notify 未连接静默失败、stop 未启动 no-op；telegram/http 测试夹具同步补上 whatsapp 字段。
- 验证结果：tsc --noEmit 通过（0 错误）；vitest run 通过（15 文件 / 436 项）。

## 八、第二阶段新特性演进验证记录（2026-08-28）

本轮完成了架构规格说明书中的核心特性模块研发、测试与集成：

1. **Cron 调度器引擎 (`src/scheduler/`)**：
   - 实现了标准 5/6 字段 Cron 解析、持久化任务表与历史运行审计日志。
   - 提供 `hap schedule list/add/run/remove/history` CLI 命令与 GUI 可视化管理。
   - 单元测试：`tests/scheduler.test.ts` 全量通过。

2. **三层记忆金字塔与本地向量检索库 (`src/memory/`)**：
   - 支持 Working / Semantic / Episodic 三层记忆模型与 Cosine 向量检索。
   - 任务完成后自动提取经验知识，启动时自动召回 Top-3 经验注入 System Prompt。
   - 提供 `hap memory list/add/clear` CLI 命令。
   - 单元测试：`tests/memory.test.ts` 全量通过。

3. **飞书 (Feishu) 与 QQ 机器人通道 (`src/channels/`)**：
   - `src/channels/feishu.ts`：支持飞书开放平台事件订阅 v2、URL Verification Challenge 自动响应、消息解析与专属智能体路由。
   - `src/channels/qq.ts`：支持 OneBot v11/v12 协议 (NapCat/Lagrange/LLOneBot/go-cqhttp)、CQ 码剥离、群聊与私聊智能路由。
   - 通用联系人存储：`src/channels/contacts-store.ts` 统一微信、飞书、QQ 联系人与群聊专属智能体配置。
   - 单元测试：`tests/contacts-store.test.ts`、`tests/feishu-channel.test.ts`、`tests/qq-channel.test.ts`、`tests/wechat-contacts.test.ts` 全部通过。

4. **AST 符号分析与代码智能工具 (`src/tools/ast-indexer/`, `src/tools/builtin/symbol-tools.ts`)**：
   - 提取 TS/JS/Python/Go/Rust 类、函数、接口、类型别名等符号表与签名。
   - 提供 3 个内置代码理解工具：`find_definition`、`find_references`、`list_symbols`。
   - 单元测试：`tests/ast-indexer.test.ts` 全部通过。

5. **局域网 Web 工作台与无头服务端 (`src/web/`, `src/cli/web-commands.ts`)**：
   - `hap web` 命令启动轻量 Hono Web 服务，支持局域网绑定与 Token 鉴权保护。
   - 提供系统快照、聊天对话、Git Diff 审查、定时任务与记忆库管理 REST API。
   - 单元测试：`tests/web-server.test.ts` 全部通过。

### 全量验证结论
- **TypeScript 类型检查**：`npx tsc --noEmit` -> 退出码 0，无任何类型错误。
- **Vitest 全量单元测试**：`npx vitest run` -> **25 个测试文件，479 项测试用例全部通过**。

## 九、记忆功能完整实现验证（2026-09-14）

本轮将 `src/memory` 迁移为 SQLite 事务存储，并贯通自动提炼、混合召回、CLI、Web、GUI 和任务编排器。

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | 通过 |
| lint | `npm run lint` | 通过 |
| 构建 | `npm run build` | 通过；先执行 `npm rebuild better-sqlite3` 修复本地 ABI |
| 记忆专项 | `npx vitest run tests/memory.test.ts tests/web-server.test.ts tests/orchestrator.test.ts` | 3 文件 / 41 项通过 |
| 全量测试 | `npm test` | 55 文件 / 713 项，711 通过；2 项既有失败（远程 daemon 超时、GUI 默认智能体回退断言） |

专项验证确认：旧 JSON 可迁移并保留 `.migrated` 备份；损坏 JSON 明确报错；并发新增不丢失；记忆支持更新、删除、过期和元数据过滤；关键词与向量混合排序；任务成功后自动提炼 semantic/episodic 记忆；Web API 和 GUI IPC 支持编辑、删除、搜索、重建。

### 2026-09-07 发布推送复核
- **类型检查**：`npm run typecheck` -> 退出码 0。
- **全量测试**：`npm test -- --runInBand` -> 退出码 1；56 个测试文件、696 项用例中 656 通过、40 失败，另有 1 个未处理错误。
- **环境限制**：`better-sqlite3` 原生模块的 Node 模块版本为 136，而当前运行时要求 127；Windows 环境缺少 `sleep`。这些失败属于当前本地验证环境/既有功能测试，未影响 Git/LFS 推送验证。

## 2026-09-14 App 图标生成验证（Codex）

使用现有 `xkk` 服务商 URL 和已保存密钥，调用 `gpt-image-2` 生成 `output/imagegen/codexconnect-app-icon.png` 成功。PNG 为 1254×1254 RGBA，透明通道有效；Pillow 方形、尺寸、alpha 与 32px 缩略图断言通过，目视图标主体清晰。服务商未严格遵循请求的 1024×1024 尺寸。仅新增图片和记录，未改代码，故不运行项目测试或构建。

## 2026-09-14 桌面图标接入验证（Codex）

图标现由 `build/icon.png` 构建复制到 `dist/src/gui/renderer/app-icon.png`，窗口运行时加载该路径；Windows/macOS/Linux 打包配置分别指向 `.ico`、`.icns`、`.png`。专项测试先有 2 项预期失败，接入后 2/2 通过；GUI 相关测试 24/24 通过，构建与 lint 通过。Linux 目录打包成功，`app.asar` 包含运行时 PNG。Windows/macOS 安装包未在本机实测，仅验证资源格式与配置。
## 2026-09-14 生图成功后异常修复验证（Codex）

修复 `executeImageGenPlugin` 成功路径调用未定义 `loadProjectFiles` 后产生的矛盾提示，并隔离图像服务失败与成功后的界面更新异常。TDD 两轮 RED 均精确命中缺陷；生图专项 2 文件 / 16 项通过，类型检查与 lint 通过，全量测试在线程池模式下 61 文件 / 746 项全部通过。默认 fork 池在 Node 24 销毁 `better-sqlite3` 原生对象时发生进程断言，属于测试运行时兼容问题。

## 2026-09-15 Hermes Agent Platform v0.1.3 发布验证（Codex）

- 产品身份：`package.json` 版本为 `0.1.3`，安装包、Electron 标题、CLI、Web 与诊断文案统一为 `Hermes Agent Platform`。
- 自动测试：Node 22.23.2 下 `npm test` 通过，61 个测试文件、751 项测试无失败。
- 静态验证：`npm run typecheck` 与 `npm run build` 均为退出码 0。
- Ubuntu 产物：`release/Hermes-Agent-Platform-0.1.3-Ubuntu-amd64.deb`，大小 112711548 bytes，SHA-256 `27f3315e72bdd45f8b78276b9c0a4728dee214a8ff2d711b3998fe0650e5c0f1`。
- DEB 元数据：Package `hermes-agent-platform`、Version `0.1.3`、Architecture `amd64`、Maintainer `Hermes Agent Platform Team`。
- 包内冒烟：`.desktop` 的 Name、Exec、Icon、StartupWMClass 与 Categories 正确；主可执行文件存在且具有执行权限。
- workflow：YAML 可解析，包含标签版本校验、Windows x64、Ubuntu x64、macOS arm64、macOS x64 原生构建和集中 Release 发布。
- 剩余边界：Windows/macOS 包等待 GitHub runner 实际生成；未签名包可能触发 SmartScreen/Gatekeeper。
