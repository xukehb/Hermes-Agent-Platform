/**
 * 配置 schema（zod v4）。一库两用：
 * 1. 运行时校验配置文件，未知键/类型错误/必填缺失一律在启动期中止（FR-CFG-004）；
 * 2. 工具参数 Schema 通过 z.toJSONSchema 导出为 JSON Schema，注入 Hermes 的 <tools> 段（FR-LOOP-002）。
 *
 * 设计要点：全部字段一律 optional 且不带 zod 默认值。
 * 内置默认值集中在 defaults.ts 的 BUILTIN 常量里，由 ConfigResolver 作为「第六层」参与合并，
 * 从而让 FR-CFG-002 的六层优先级只有一条真相来源（否则 zod default 会悄悄抢在 profile 之前生效）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { z } from 'zod';

/** 线制枚举（FR-PROV-004 / FR-PROV-009） */
export const wireApiSchema = z.enum(['chat', 'responses', 'anthropic-messages']);

/** 协议适配器枚举（FR-LOOP-011：实现且仅实现这 4 个） */
export const protocolSchema = z.enum(['hermes-native', 'openai-tools', 'deepseek', 'anthropic']);

/** 采样参数等透传项。键名由厂商定义，故为开放记录。 */
export const paramsSchema = z.record(z.string(), z.unknown());

/** 提供商声明（FR-PROV-001） */
export const modelProviderSchema = z.strictObject({
  name: z.string().min(1).optional(),
  base_url: z.string().min(1),
  /** 缺省表示无凭据提供商，如本地 Ollama（FR-PROV-003） */
  env_key: z.string().min(1).optional(),
  wire_api: wireApiSchema.optional(),
  /** 其下所有模型的协议默认值（FR-PROV-008） */
  default_protocol: protocolSchema.optional(),
  http_headers: z.record(z.string(), z.string()).optional(),
  /** 值为环境变量名，运行时读取后作为请求头（凭据不入配置文件，FR-PROV-002） */
  env_http_headers: z.record(z.string(), z.string()).optional(),
  request_max_retries: z.number().int().min(0).optional(),
  stream_max_retries: z.number().int().min(0).optional(),
  stream_idle_timeout_ms: z.number().int().positive().optional(),
  /** Anthropic 的 max_tokens 必填兜底值（FR-LOOP-011A 第 4 点） */
  max_tokens_default: z.number().int().positive().optional(),
});

/** 模型能力标签。vision 决定能否接图片附件（FR-CHAN-011）。 */
export const modelCapabilitySchema = z.enum(['tools', 'vision', 'streaming', 'reasoning', 'longctx']);

/**
 * 模型目录条目。对应 hap model add 写入的 [models.<alias>] 块。
 *
 * 该表并非可选装饰：上下文压缩阈值需要 context_window（FR-LOOP-013）、
 * Anthropic 请求需要 max_output_tokens（FR-LOOP-011A）、图片附件分流需要 vision 标签（FR-CHAN-011）。
 */
export const modelEntrySchema = z.strictObject({
  provider: z.string().min(1),
  /** 厂商侧真实模型标识，缺省时取 alias 本身 */
  model: z.string().min(1).optional(),
  display_name: z.string().min(1).optional(),
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  capabilities: z.array(modelCapabilitySchema).optional(),
  /** 覆盖该模型的协议推断结果，优先级高于 provider.default_protocol */
  protocol: protocolSchema.optional(),
  params: paramsSchema.optional(),
});

/** 智能体的模型绑定：支持简写字符串与 primary/fallbacks 结构（FR-ROUTE-001） */
export const modelBindingSchema = z.union([
  z.string().min(1),
  z.strictObject({
    primary: z.string().min(1),
    fallbacks: z.array(z.string().min(1)).optional(),
  }),
]);

/** 工具集裁剪三项，deny 优先于 allow（FR-TOOL-003） */
export const toolSelectionSchema = z.strictObject({
  profile: z.enum(['minimal', 'standard', 'coding', 'research', 'full']).optional(),
  allow: z.array(z.string().min(1)).optional(),
  deny: z.array(z.string().min(1)).optional(),
});

/** 运行模式（FR-TASK-001） */
export const runtimeSchema = z.strictObject({
  mode: z.enum(['oneshot', 'persistent']).optional(),
  idle_timeout_ms: z.number().int().positive().optional(),
});

export const subagentsSchema = z.strictObject({
  allow: z.array(z.string().min(1)).optional(),
});

export const identitySchema = z.strictObject({
  emoji: z.string().optional(),
  display_name: z.string().optional(),
});

/** 智能体条目字段（FR-AGT-001） */
export const agentEntrySchema = z.strictObject({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  workspace: z.string().min(1).optional(),
  agent_dir: z.string().min(1).optional(),
  model: modelBindingSchema.optional(),
  utility_model: z.string().min(1).optional(),
  protocol: protocolSchema.optional(),
  params: paramsSchema.optional(),
  capabilities: z.array(z.string().min(1)).optional(),
  tools: toolSelectionSchema.optional(),
  subagents: subagentsSchema.optional(),
  runtime: runtimeSchema.optional(),
  identity: identitySchema.optional(),
  system_prompt_file: z.string().min(1).optional(),
  reasoning_visible: z.boolean().optional(),
});

/** 智能体默认值（FR-AGT-003）。含两个仅在默认层有意义的根目录字段。 */
export const agentDefaultsSchema = agentEntrySchema.extend({
  workspace_root: z.string().min(1).optional(),
  agent_dir_root: z.string().min(1).optional(),
});

export const agentsSchema = z.strictObject({
  defaults: agentDefaultsSchema.optional(),
  entries: z.record(z.string().min(1), agentEntrySchema).optional(),
});

/** 配额与资源上限（§3.3） */
export const limitsSchema = z.strictObject({
  max_iterations: z.number().int().positive().optional(),
  max_subagent_depth: z.number().int().min(0).optional(),
  tool_timeout_ms: z.number().int().positive().optional(),
  tool_output_max_bytes: z.number().int().positive().optional(),
  compact_threshold: z.number().gt(0).lte(1).optional(),
  daily_token_budget: z.number().int().positive().optional(),
  session_retention_days: z.number().int().positive().optional(),
  ingress_queue_size: z.number().int().positive().optional(),
  /** 按 provider 维度的并发与速率上限（FR-ROUTE-006） */
  provider_concurrency: z.record(z.string(), z.number().int().positive()).optional(),
  provider_rpm: z.record(z.string(), z.number().int().positive()).optional(),
  agent_concurrency: z.record(z.string(), z.number().int().positive()).optional(),
  agent_rpm: z.record(z.string(), z.number().int().positive()).optional(),
  default_provider_concurrency: z.number().int().positive().optional(),
  default_agent_concurrency: z.number().int().positive().optional(),
});

/** Telegram 通道（FR-CHAN-015 / FR-CHAN-016） */
export const telegramChannelSchema = z.strictObject({
  enabled: z.boolean().optional(),
  token_env: z.string().min(1).optional(),
  mode: z.enum(['polling', 'webhook']).optional(),
  default_agent: z.string().min(1).optional(),
  mention_patterns: z.array(z.string().min(1)).optional(),
  message_char_limit: z.number().int().positive().optional(),
  /** 仅 mode = 'webhook' 时允许出现，否则启动期拒绝（FR-CHAN-016） */
  webhook: z
    .strictObject({
      url: z.string().min(1),
      bind: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
    })
    .optional(),
});

/** WhatsApp 通道。使用 Baileys 连接 WhatsApp Web，多文件 auth_state 落盘保存二维码登录态。 */
export const whatsappChannelSchema = z.strictObject({
  enabled: z.boolean().optional(),
  auth_dir: z.string().min(1).optional(),
  default_agent: z.string().min(1).optional(),
  mention_patterns: z.array(z.string().min(1)).optional(),
  message_char_limit: z.number().int().positive().optional(),
  reconnect_initial_ms: z.number().int().positive().optional(),
  reconnect_max_ms: z.number().int().positive().optional(),
  qr_log: z.boolean().optional(),
});

/** 微信企业号/企业微信（WeCom）配置项 */
export const wechatWeComSchema = z.strictObject({
  corp_id: z.string().min(1).optional(),
  corp_secret_env: z.string().min(1).optional(),
  agent_id: z.number().int().positive().optional(),
  token: z.string().min(1).optional(),
  encoding_aes_key: z.string().min(1).optional(),
  webhook_url_env: z.string().min(1).optional(),
  bind: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
});

/** 微信公众号（Official Account）配置项 */
export const wechatOfficialAccountSchema = z.strictObject({
  app_id: z.string().min(1).optional(),
  app_secret_env: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
  encoding_aes_key: z.string().min(1).optional(),
  bind: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
});

export const wechatPersonalSchema = z.strictObject({
  puppet: z.enum(['ilink', 'service']).optional(),
  ilink_account_id: z.string().min(3).optional(),
  puppet_service_token_env: z.string().min(1).optional(),
  puppet_service_endpoint: z.string().url().optional(),
});

/** 微信通道（支持个人微信扫码登录、企业微信 WeCom 机器人/应用、微信公众号多模式） */
export const wechatChannelSchema = z.strictObject({
  enabled: z.boolean().optional(),
  mode: z.enum(['personal', 'ilink_bot', 'wecom', 'official_account']).optional(),
  default_agent: z.string().min(1).optional(),
  mention_patterns: z.array(z.string().min(1)).optional(),
  message_char_limit: z.number().int().positive().optional(),
  auth_dir: z.string().min(1).optional(),
  qr_log: z.boolean().optional(),
  personal: wechatPersonalSchema.optional(),
  wecom: wechatWeComSchema.optional(),
  official_account: wechatOfficialAccountSchema.optional(),
});

/** 飞书 (Feishu / Lark) 通道配置项 */
export const feishuChannelSchema = z.strictObject({
  enabled: z.boolean().optional(),
  app_id: z.string().min(1).optional(),
  app_secret_env: z.string().min(1).optional(),
  verification_token: z.string().min(1).optional(),
  encrypt_key_env: z.string().min(1).optional(),
  webhook_url_env: z.string().min(1).optional(),
  bind: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  default_agent: z.string().min(1).optional(),
  mention_patterns: z.array(z.string().min(1)).optional(),
  message_char_limit: z.number().int().positive().optional(),
});

/** QQ 机器人通道配置项 (支持 OneBot v11/v12 与 QQ 官方开放平台) */
export const qqChannelSchema = z.strictObject({
  enabled: z.boolean().optional(),
  mode: z.enum(['onebot', 'official']).optional(),
  onebot_ws_url: z.string().min(1).optional(),
  onebot_access_token_env: z.string().min(1).optional(),
  onebot_http_url: z.string().min(1).optional(),
  bind: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  official_app_id: z.string().min(1).optional(),
  official_token_env: z.string().min(1).optional(),
  official_secret_env: z.string().min(1).optional(),
  default_agent: z.string().min(1).optional(),
  mention_patterns: z.array(z.string().min(1)).optional(),
  message_char_limit: z.number().int().positive().optional(),
});

export const httpChannelSchema = z.strictObject({
  enabled: z.boolean().optional(),
  bind: z.string().min(1).optional(),
  default_agent: z.string().min(1).optional(),
});

export const cliChannelSchema = z.strictObject({
  enabled: z.boolean().optional(),
  default_agent: z.string().min(1).optional(),
});

export const channelsSchema = z.strictObject({
  edit_interval_ms: z.number().int().positive().optional(),
  async_threshold_ms: z.number().int().positive().optional(),
  telegram: telegramChannelSchema.optional(),
  whatsapp: whatsappChannelSchema.optional(),
  wechat: wechatChannelSchema.optional(),
  feishu: feishuChannelSchema.optional(),
  qq: qqChannelSchema.optional(),
  http: httpChannelSchema.optional(),
  cli: cliChannelSchema.optional(),
});

/** 外部 MCP 服务器（FR-TOOL-002） */
export const mcpServerSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().min(1).optional(),
  startup_timeout_ms: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

/** profile 是一个可整组覆盖的顶层片段（FR-CFG-003） */
export const profileSchema = z.strictObject({
  default_agent: z.string().min(1).optional(),
  default_model: z.string().min(1).optional(),
  utility_model: z.string().min(1).optional(),
  protocol: protocolSchema.optional(),
  params: paramsSchema.optional(),
  limits: limitsSchema.optional(),
  agent_defaults: agentDefaultsSchema.optional(),
});

/** 数据目录。缺省全部从 data_dir 派生。 */
export const pathsSchema = z.strictObject({
  data_dir: z.string().min(1).optional(),
  trace_dir: z.string().min(1).optional(),
  overflow_dir: z.string().min(1).optional(),
  spool_dir: z.string().min(1).optional(),
});

/** 配置文件根结构。 */
export const hapConfigSchema = z.strictObject({
  default_agent: z.string().min(1).optional(),
  default_model: z.string().min(1).optional(),
  active_profile: z.string().min(1).optional(),
  paths: pathsSchema.optional(),
  limits: limitsSchema.optional(),
  model_providers: z.record(z.string().min(1), modelProviderSchema).optional(),
  models: z.record(z.string().min(1), modelEntrySchema).optional(),
  profiles: z.record(z.string().min(1), profileSchema).optional(),
  agents: agentsSchema.optional(),
  channels: channelsSchema.optional(),
  mcp_servers: z.record(z.string().min(1), mcpServerSchema).optional(),
});

export type HapConfig = z.infer<typeof hapConfigSchema>;
export type ModelProviderConfig = z.infer<typeof modelProviderSchema>;
export type ModelEntryConfig = z.infer<typeof modelEntrySchema>;
export type AgentEntryConfig = z.infer<typeof agentEntrySchema>;
export type AgentDefaultsConfig = z.infer<typeof agentDefaultsSchema>;
export type LimitsConfig = z.infer<typeof limitsSchema>;
export type ProfileConfig = z.infer<typeof profileSchema>;
export type ChannelsConfig = z.infer<typeof channelsSchema>;
export type TelegramChannelConfig = z.infer<typeof telegramChannelSchema>;
export type WhatsAppChannelConfig = z.infer<typeof whatsappChannelSchema>;
export type WeChatChannelConfig = z.infer<typeof wechatChannelSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type ToolSelectionConfig = z.infer<typeof toolSelectionSchema>;
export type ModelBindingConfig = z.infer<typeof modelBindingSchema>;
export type PathsConfig = z.infer<typeof pathsSchema>;
