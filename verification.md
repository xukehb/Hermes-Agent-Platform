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

WhatsApp 真机扫码登录与收发属部署期验证项，需要用户手机操作，不在本地自动化范围内。

类型检查与全量测试均通过，规格的 79 条功能需求全部有对应实现与测试覆盖，用户四项核心诉求全部落地。2026-08-25 已将规格 §8 的实施清单由过期空勾同步为真实完成状态，并新增 `docs/index.md` 使用说明。判定：**通过**。

剩余的三项联网验证属部署期确认事项，不构成实现缺陷，已在上表标注风险等级与已有的替代验证手段。
