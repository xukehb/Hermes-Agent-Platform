/**
 * API 分发网关类型定义
 * 参考 cockpit-tools Codex API 服务设计
 */

export interface GatewayConfig {
  /** 网关是否启用 */
  enabled: boolean;
  /** 网关监听端口，若未单独设置则默认跟随 Web 控制台端口 (如 3000) */
  port?: number | undefined;
  /** 监听地址：'127.0.0.1' (仅本机) 或 '0.0.0.0' (局域网共享) */
  bind: '127.0.0.1' | '0.0.0.0';
  /** 是否允许局域网跨域调用 */
  corsOrigins: string[];
  /** 全局默认单 Key 每分钟调用频率上限 (RPM)，0 表示不限制 */
  defaultRateLimitRpm: number;
  /** 是否允许本机无 Key 访问 (仅限 127.0.0.1) */
  allowAnonymousLocal: boolean;
  /** 本地模型调用失败时是否自动故障转移 (Failover) 至云端模型 */
  fallbackToCloud: boolean;
  /** 默认故障转移云端目标模型 (如 'deepseek/deepseek-chat') */
  defaultFallbackModel?: string | undefined;
}

export interface GatewayApiKey {
  id: string;
  name: string;
  key: string;
  createdAt: number;
  lastUsedAt?: number | undefined;
  enabled: boolean;
  /** 允许访问的模型列表，为空则表示允许所有可用模型 */
  allowedModels: string[];
  /** 专属每分钟调用速率上限 (RPM)，0 表示使用全局默认 */
  rateLimitRpm: number;
  /** 累计请求次数 */
  totalRequests: number;
  /** 累计消耗 Token 数 */
  totalTokens: number;
}

export interface ModelAliasRule {
  id: string;
  /** 外部客户端请求的模型标识 (如 'gpt-4o', 'claude-3-5-sonnet') */
  alias: string;
  /** 内部实际映射的目标模型 (如 'qwen2.5-coder:7b', 'deepseek/deepseek-chat') */
  targetModel: string;
  /** 是否启用该别名规则 */
  enabled: boolean;
  /** 描述备注 (如 'Cursor 编码重定向至本地 Qwen2.5-Coder') */
  description?: string | undefined;
  /** 当目标模型异常时的故障备选模型 */
  fallbackModel?: string | undefined;
}

export interface GatewayRequestLog {
  id: string;
  timestamp: number;
  clientIp: string;
  keyId?: string | undefined;
  keyName?: string | undefined;
  requestedModel: string;
  targetModel: string;
  status: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  stream: boolean;
  error?: string | undefined;
}

export interface GatewayStats {
  totalRequests: number;
  todayRequests: number;
  totalTokens: number;
  todayTokens: number;
  avgLatencyMs: number;
  activeKeysCount: number;
  modelDistribution: Record<string, number>;
}

export interface ClientPresetItem {
  id: string;
  name: string;
  description: string;
  icon: string;
  snippetType: 'json' | 'yaml' | 'shell' | 'python' | 'text';
  snippet: string;
  fields: {
    label: string;
    value: string;
  }[];
}

export interface GatewayOverview {
  enabled: boolean;
  bind: string;
  port: number;
  localBaseUrl: string;
  lanBaseUrls: string[];
  activeKeysCount: number;
  aliasesCount: number;
  stats: GatewayStats;
}
