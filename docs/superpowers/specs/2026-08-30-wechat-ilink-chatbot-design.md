# 微信 iLink Chatbot 多账号接入设计

日期：2026-08-30
状态：待书面复核
协议参考：腾讯 `openclaw-weixin` / iLink Bot API

## 背景与决策

当前 GUI 将个人微信描述为“扫码免密登录”，但默认实现实际依赖
`WECHATY_PUPPET_SERVICE_TOKEN`。GUI 没有对应凭据入口，遗留驱动还会在未建立真实
消息连接时写入伪会话并报告登录成功。因此，二维码能够显示不代表 chatbot 已连接，发送
操作也可能只写日志而未到达微信。

Hermes 将新增原生 `ilink_bot` 模式，直接实现 OpenClaw 当前使用的腾讯 iLink Bot API。
该模式扫码后绑定的是微信 chatbot，不登录个人微信账号，也不读取个人好友通讯录。现有
企业微信和微信公众号模式继续保留；基于供应商 Puppet 的个人号模式作为显式的旧版高级
选项保留，不再作为默认入口。

本设计中的 iLink 登录、凭据、同步游标和消息运行时均按 `BotAccount.id` 隔离。一个 Hermes
进程可以运行多个微信 chatbot 账号，但同一个账号只能绑定一台服务器，一台服务器也只能
绑定一个微信、Telegram 或飞书账号。服务器绑定与操作者授权由《服务器 Bot 控制平面设计》
统一管理，本设计不再创建第二套微信专属绑定状态。

不采用 OpenClaw 进程桥接，因为它会引入另一个宿主、配置文件和消息路由层；不采用本地
Wechat4u/UOS 协议，因为其账号兼容和封号风险不适合作为产品默认能力。

## 目标

- GUI 一键生成腾讯 iLink 真实二维码，并准确呈现扫码、验证、确认和连接状态。
- 支持为不同服务器分别创建微信 chatbot 账号；扫码会话、凭据和运行状态按账号隔离。
- 登录后接收微信用户发给 chatbot 的文本消息，交给现有 `ChannelDispatcher`，并把智能体
  回复真实发送回同一微信会话。
- 安全持久化账号凭据、同步游标、会话 context token 和入站去重记录；应用重启后自动恢复。
- 网络掉线后自动重连，凭据失效时明确要求重新扫码，停止服务时立即取消长轮询。
- 删除伪登录、伪发送成功和依赖日志字符串推断认证状态的行为。
- 通过协议单元测试、模拟服务集成测试、GUI 回归测试和一次真实扫码收发完成验收。

## 非目标

- 不允许一个微信账号同时绑定多台服务器，也不允许绕过控制平面的唯一绑定约束。
- 不同步个人微信好友、群通讯录或历史聊天记录；联系人列表由真实入站会话逐步形成。
- 首版保证文本消息收发。图片、语音、文件和视频需要 CDN 加密与转码，留给独立设计处理。
- 不实现或维护微信个人号逆向协议，不承诺规避微信侧产品策略或服务限制。
- 不允许用户配置扫码服务地址；扫码请求始终访问腾讯固定入口。

## 配置与兼容

`channels.wechat.mode` 增加 `ilink_bot`，作为单账号配置文件兼容入口：

```toml
[channels.wechat]
enabled = true
mode = "ilink_bot"
default_agent = "coder"
auth_dir = "~/.hap/wechat-auth"

[channels.wechat.ilink_bot]
account_id = "wechat-default"
bot_agent = "Hermes/0.1.0"
reconnect_initial_ms = 1000
reconnect_max_ms = 30000
qr_refresh_limit = 3
```

`bot_agent` 仅用于服务端可观测性，必须满足 ASCII UA 风格且不超过 256 字节。二维码 API
使用固定的 `iLink-App-Id: bot`，客户端版本由 Hermes 包版本编码。登录确认后返回的
`baseurl` 和扫码重定向主机必须使用 HTTPS，且主机为 `weixin.qq.com` 或其子域；不接受
配置文件或 GUI 输入任意后端地址。

新 GUI 不通过重复写 TOML 创建账号，而是把账号元数据交给控制平面的 `BotAccountStore`，
由 `BotRuntimeSupervisor` 为每个启用账号建立独立运行时。上面的 TOML 仅用于 CLI/旧配置
迁移；首次启动时会导入为一个稳定账号，导入成功后也遵守一对一绑定与授权规则。

已有显式 `mode = "personal"` 配置继续走 Wechaty Puppet，不静默改变其含义。GUI 将其标为
“个人微信 Puppet（需要供应商凭据）”，并把所需 Token 环境变量和 Endpoint 展示为高级
配置。README 不再声称该模式开箱即用。

## 模块边界

### `IlinkApiClient`

负责构造 iLink HTTP 请求、超时、中止、响应 Schema 校验和错误分类。它不管理登录状态，
也不接触 GUI。所有错误只携带账号 ID、端点标签、HTTP 状态和安全错误码，禁止包含
Authorization、context token、二维码 URL、查询串或原始消息正文。

支持的协议调用：

- `POST /ilink/bot/get_bot_qrcode?bot_type=3`
- `GET /ilink/bot/get_qrcode_status?qrcode=...`
- `POST /ilink/bot/msg/notifystart`
- `POST /ilink/bot/msg/notifystop`
- `POST /ilink/bot/getupdates`
- `POST /ilink/bot/sendmessage`

`POST` 请求包含 `Content-Type`、`AuthorizationType`、随机 `X-WECHAT-UIN` 和 iLink 客户端
标识；登录后的请求再携带 Bearer bot token，并在请求体中加入 `base_info`。

### `IlinkCredentialStore`

只负责持久化，不发起网络请求。数据位于 `auth_dir/ilink-bot/<account-id>/`；`account-id`
必须由平台生成，不能包含路径字符：

| 文件 | 内容 |
| --- | --- |
| `account.json` | Schema 版本、账号 ID、bot token、后端 URL、用户 ID、保存时间 |
| `sync.json` | `getupdates` 同步游标 |
| `context-tokens.json` | 每个真实对端的 context token 与更新时间 |
| `inbound-dedupe.json` | 最近 24 小时已接纳的消息 ID，防止重放 |

目录权限设为 `0700`，文件权限设为 `0600`。写入流程使用同目录临时文件、`fsync`、权限设置
和原子 `rename`，避免崩溃留下半写文件。二维码、验证码和进行中的登录 session 只保存在
内存中。损坏文件不被当作空凭据静默忽略，而是隔离并报告可操作错误。

### `IlinkLoginSession`

负责单次扫码生命周期。创建二维码后长轮询状态，并通过类型化事件向上层报告：

```text
idle
  -> qr_ready
  -> scanned
  -> verification_required
  -> confirming
  -> connected
```

每个登录会话必须持有 `BotAccount.id` 和 generation ID。`verification_required` 时暂停常规
轮询，等待 GUI 为同一账号提交手机显示的数字验证码。二维码过期会
自动刷新，最多达到配置次数；`scaned_but_redirect` 只切换到经白名单校验的 HTTPS 主机；
`binded_redirect` 显示“该 chatbot 已绑定”，不能伪装成新登录成功。确认响应必须同时包含
bot token、账号 ID 和有效后端地址，之后才原子保存账号并进入 `connected`。

刷新二维码会取消旧登录会话并生成新会话。手动停止或切换模式使用 `AbortController`
立即结束所有在途请求，旧请求返回后不得覆盖新状态。

### `IlinkBotDriver`

实现微信通道需要的登录、状态、入站和发送接口。启动时先加载账号凭据：

- 无凭据：创建 `IlinkLoginSession` 并发布二维码。
- 有凭据：调用 `notifystart`，成功后进入消息 monitor。
- token 无效：进入 `auth_expired`，停止 monitor 并要求重新扫码。

每个账号最多运行一个 monitor。monitor 将该账号 `sync.json` 中的游标传给 `getupdates`。
响应到达后，按以下顺序处理：

1. 校验响应并保存新的同步游标。
2. 对每条用户消息先保存该对端最新 context token。
3. 使用消息 ID 查询 24 小时去重记录，重放消息不再次执行智能体。
4. 将文本条目归一化为现有微信入站消息，附加不可由消息正文覆盖的 `accountId` 与绑定
   `serverId`，再提交账号自己的 `WeChatChannel`。
5. 消息被通道接纳后写入去重记录。

出站回复根据目标 ID 读取该账号下的 context token，构造 `message_type = BOT`、
`message_state = FINISH` 的文本消息。context token 不存在或已失效时必须返回明确错误，
不能写本地“发送成功”。这意味着用户至少需要先向 chatbot 发送一条消息，Hermes 才能
向该会话主动回复。

### `WeChatChannel` 与 GUI 服务

`WeChatChannel` 继续负责智能体路由、会话键、联系人规则和 `ChannelDispatcher`，不直接
处理 iLink HTTP。iLink 私聊使用 `wechat:user:<from_user_id>`；若协议返回群组 ID，则使用
`wechat:room:<group_id>`，持久化会话键增加账号作用域，避免两个账号碰到相同对端 ID 时
串话。联系人存储只记录真实入站对端，保留已有的智能体、工作区和
自动回复规则。

`BotRuntimeSupervisor` 按账号创建 `IlinkBotDriver`，GUI 服务只读取类型化 runtime 快照，
不再解析日志字符串判断是否出现二维码或登录成功。
状态快照至少包含：`phase`、脱敏账号标识、二维码内容、是否需要验证码、最近错误、重连
次数和上次消息时间。IPC 操作包括：启动、停止、刷新二维码、提交验证码、退出并清除凭据、
同步状态和发送已建立会话的测试消息。

## GUI 行为

- 新建微信账号显示“微信 Chatbot（扫码连接，推荐）”，无需填写 API Key 或 Puppet Token，
  但必须先选择一台尚未绑定 Bot 的服务器。
- 未连接时主操作为“生成二维码”；二维码生成后显示倒计时、刷新和取消。
- 已扫码后立即显示“请在手机确认”，不能要求用户点击桌面端“确认登录”。
- 需要数字验证时才展示验证码输入和提交按钮；验证码不会写入日志或磁盘。
- 已连接时显示脱敏账号、绑定服务器、连接时长、最近收信时间以及“停止服务”和“退出登录”。
- `reconnecting` 保持当前账号信息并显示重试次数；网络恢复后自动回到 `connected`。
- `auth_expired` 清晰提示重新扫码；普通网络错误不能误报为凭据失效。
- 原“同步联系人”按钮在 iLink 模式改为“刷新会话”；列表只展示实际产生过入站消息的
  用户或群，不提供虚拟联系人作为发送目标。
- 状态轮询只更新发生变化的区域，不重复重建整个页面，也不弹出重复成功通知。

## 断线恢复与并发

`getupdates` 采用服务端建议超时，客户端超时略高于该值。短暂超时被视为正常长轮询结束；
DNS、连接和 5xx 错误进入 `reconnecting`，按带抖动的指数退避重试，间隔限制在配置的
最小值与最大值之间。每个账号只允许一个 monitor 和一个登录会话，通过 generation ID
拒绝过期异步结果。

HTTP `401/403` 或 iLink `errcode = -14` 归类为认证失效，不参与无限重试。停止服务先中止
monitor，再尽力调用 `notifystop`；即使停止通知失败，本地也必须在有限时间内完成停止。
应用重启会恢复最后成功保存的游标和 context token，避免重复消费和重启后无法回复。

## 错误与安全

- 使用结构化响应 Schema，缺失关键字段时拒绝进入下一状态。
- API 基址和重定向执行 HTTPS 与微信域名校验，阻止 SSRF。
- 所有凭据按账号作用域保存；context token 不能跨对端、跨账号或跨服务器复用。
- INFO/WARN/ERROR 日志仅记录事件名、状态码、计数和耗时。DEBUG 也只能显示短脱敏前缀。
- 渲染进程不能读取 bot token、context token、同步游标或凭据文件路径。
- “退出登录并清除凭据”需要二次确认；停止服务不删除任何持久化状态。
- 测试、截图和文档只使用合成账号、二维码和消息文本。

## 测试设计

### 单元测试

- API Header、客户端版本、Bearer 使用条件、超时、中止、HTTP/iLink 错误分类和响应校验。
- 登录状态覆盖 `wait`、`scaned`、验证码、过期刷新、验证阻塞、重定向、已绑定和确认。
- 凭据原子写入、权限、损坏文件、游标恢复、context token 隔离和去重过期。
- monitor 正常长轮询、服务端超时、网络重试、停止中止、token 失效和 generation 竞争。
- 文本消息映射、私聊/群聊会话键、无 context token 拒发和真实发送响应。

### 集成与 GUI 测试

测试通过依赖注入使用本地模拟 iLink 服务，不向产品配置暴露自定义后端地址。覆盖从生成
二维码、扫码状态、确认保存、绑定服务器、收取一条消息、智能体回复、重启恢复到退出登录
的完整流程，并并行启动两个合成账号验证状态、游标、context token 和消息会话不串线。
渲染器测试验证各状态只显示合法控件，验证码和错误不会导致页面卡死，旧请求不能覆盖新
二维码，重复状态更新不会重复通知。

### 真实验收

1. 在无本地凭据时启动 GUI，生成并扫描真实 iLink 二维码。
2. 手机确认后 GUI 显示已连接，磁盘只出现权限受限的凭据文件。
3. 从微信向 chatbot 发送一条唯一文本，Hermes 只执行一次并在同一会话返回回复。
4. 重启 Hermes，无需再次扫码；再发送一条消息并成功回复。
5. 临时断网后 GUI 显示重连，恢复网络后自动继续收发。
6. 停止服务应立即结束轮询；再次启动恢复原账号和游标。
7. 清除登录后旧 token 不再使用，GUI 返回生成二维码状态。
8. 检查日志、IPC 和截图，确认不存在二维码 URL、token、原始查询串或私聊正文泄漏。
9. 创建第二个微信账号并绑定另一台测试服务器，确认两个账号可同时收发；尝试重复绑定任一
   账号或服务器必须收到冲突错误，不能产生半写状态。

## 验收标准

- 未真实收到 iLink `confirmed` 响应时，任何路径都不能显示“已连接”。
- 未收到 `sendmessage` 成功响应时，任何路径都不能记录“发送成功”。
- 登录、收信、回复、重启恢复、断线恢复和退出登录均有自动化覆盖。
- GUI 中每个按钮都有明确的运行中、成功、失败和重复点击行为，不会阻塞渲染线程。
- `npm test`、`npm run typecheck` 和 `npm run build` 通过；全仓 lint 若仍被既有 TypeScript
  parser 配置阻塞，需要单独记录，新增文件不得引入新的 lint 问题。
- README 和示例配置准确区分 iLink chatbot、个人微信 Puppet、企业微信和公众号。
