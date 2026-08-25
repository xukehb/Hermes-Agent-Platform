# 测试执行记录

日期：2026-08-25　执行者：Codex　执行方式：本地 AI 自动执行（无 CI）

## 一、类型检查

命令：`npx tsc -p tsconfig.json --noEmit`

结果：退出码 0，无任何输出（TypeScript 7.0.2 原生编译器成功时静默）。

覆盖范围：`src/**/*.ts` 与 `tests/**/*.ts`，编译选项含 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noEmitOnError`。

## 二、单元 / 功能测试

命令：`npx vitest run`（vitest 4.1.11）

结果：退出码 0，**14 个测试文件、433 项全部通过**，耗时 2.85s。

| 测试文件 | 用例数 | 耗时 | 覆盖对象 |
| --- | --- | --- | --- |
| tests/config.test.ts | 55 | 248ms | 配置加载、schema 校验、交叉引用、六层解析、写回 |
| tests/channels-core.test.ts | 47 | 205ms | 指令解析、消息规整、出站队列、bind 解析、渲染 |
| tests/cli.test.ts | 49 | 615ms | 全部 CLI 命令（init/config/provider/model/agent/doctor/ops/main） |
| tests/providers.test.ts | 48 | 158ms | 三种线制客户端、凭据解析、请求头、连通性、Mock |
| tests/storage.test.ts | 41 | 869ms | SQLite 会话库、消息持久化、轨迹 JSONL、用量聚合、清理 |
| tests/tools.test.ts | 41 | 1021ms | 8 个内置工具、超长输出落盘、MCP 桥接 |
| tests/protocol.test.ts | 36 | 54ms | 四套协议的请求构造与流式解析、协议探测、token 估算 |
| tests/agent.test.ts | 24 | 51ms | 任务循环、工具编排、降级切换、迭代上限 |
| tests/channels-dispatcher.test.ts | 24 | 131ms | 通道调度器、同步/异步模式、编辑节流、指令分发 |
| tests/channels-http.test.ts | 20 | 188ms | 9 个 HTTP 端点、SSE 流式、错误响应 |
| tests/channels-telegram.test.ts | 14 | 22ms | Telegram 通道端到端：收发闭环、唤起词剥离、群聊门禁、智能体指派、分片回写、编辑幂等、附件识别 |
| tests/orchestrator.test.ts | 14 | 430ms | 编排器、智能体注册表、热重载、中断恢复 |

## 三、CLI 测试的设计约束

`tests/cli.test.ts` 在进程内调用 `buildProgram().parseAsync`，不起子进程，因此有三条硬约束，改动该文件时必须遵守：

1. **不能让命令进入交互问答。** `provider add` / `model add` / `agent create` 在「所有实质性选项都缺省」时会进入 @clack 交互，测试进程会挂到超时。验证「缺 base_url 报错」这类用例时必须至少给一个无关选项（例如 `--env-key`）把交互分支挡掉。此坑已实际触发过一次超时并修复。
2. **不能触网。** `provider check`、`provider models`、`model import`、不带 `--skip-network` 的 `doctor` 都会发真实请求，一律排除。
3. **不能跑常驻命令。** `serve` 与 `chat` 会阻塞。

另有两处环境适配：

- `process.exitCode` 在每个用例后复位。`fail()` 会置 1，不复位会污染 vitest 自身的退出码。
- 临时配置里的目录重定向采用「smol-toml 解析成对象 → 改字段 → 整体回写」，不做文本追加。骨架配置已含 `[agents.defaults]` 表，文本追加会触发 smol-toml 的重复表报错；同时 Windows 路径带反斜杠，走对象回写可避开 TOML 转义问题。

## 四、实机验证（离线部分）

```powershell
npx tsx src/cli/bin.ts -c .tmp-probe/hap.toml init
# → ✓ hap init：写入配置骨架到 ...（8 家提供商、9 个模型、5 个智能体），退出码 0
```

回读生成的 TOML 确认：8 个 `[model_providers.*]` 表齐全，`openrouter` 的 `http_headers` 正确嵌套为子表，`limits` 6 项落盘，`default_agent = "coder"`、`active_profile = "cloud"`。

联网部分（`provider check`、`model import`、真实模型对话）在前序轮次已用真实 Key 验证通过，本轮不重复消耗额度。

## 五、结论

类型检查与全量测试均通过，无已知失败项。2026-08-25 在同步规格实施清单并新增 `docs/index.md` 后复跑 `npx tsc -p tsconfig.json --noEmit` 与 `npx vitest run --reporter dot`，结果仍为 14 个测试文件、433 项全部通过。测试覆盖了配置、协议、服务商、工具、编排、存储、三个通道与命令行九个层次的正常流程、边界条件与错误恢复路径。
