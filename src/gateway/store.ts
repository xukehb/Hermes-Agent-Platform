import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  GatewayApiKey,
  GatewayConfig,
  GatewayRequestLog,
  GatewayStats,
  ModelAliasRule,
} from './types.js';

interface GatewayPersistedData {
  config: GatewayConfig;
  keys: GatewayApiKey[];
  aliases: ModelAliasRule[];
  logs: GatewayRequestLog[];
}

const DEFAULT_CONFIG: GatewayConfig = {
  enabled: true,
  bind: '127.0.0.1',
  corsOrigins: ['*'],
  defaultRateLimitRpm: 60,
  allowAnonymousLocal: false,
  fallbackToCloud: true,
  defaultFallbackModel: 'deepseek/deepseek-chat',
};

const DEFAULT_ALIASES: ModelAliasRule[] = [
  {
    id: 'alias-gpt-4o',
    alias: 'gpt-4o',
    targetModel: 'qwen2.5-coder:7b',
    enabled: true,
    description: '重定向至本地优质代码模型 (Qwen2.5-Coder)',
    fallbackModel: 'deepseek/deepseek-chat',
  },
  {
    id: 'alias-gpt-4o-mini',
    alias: 'gpt-4o-mini',
    targetModel: 'qwen2.5-coder:7b',
    enabled: true,
    description: '轻量模型重定向至本地 Qwen2.5-Coder',
  },
  {
    id: 'alias-claude-3-5-sonnet',
    alias: 'claude-3-5-sonnet',
    targetModel: 'deepseek/deepseek-chat',
    enabled: true,
    description: '重定向至高性价比 DeepSeek Chat',
  },
];

const MAX_LOGS_KEPT = 500;

export class GatewayStore {
  private filePath: string;
  private data: GatewayPersistedData;
  private rpmBuckets: Map<string, { count: number; windowStart: number }> = new Map();

  constructor(customPath?: string) {
    this.filePath = customPath || join(homedir(), '.hap', 'gui', 'gateway.json');
    this.data = this.load();
    // 确保若没有任何 Key 时初始化一把默认 Key
    if (this.data.keys.length === 0) {
      this.createKey({ name: 'Default Client Key' });
    }
  }

  private load(): GatewayPersistedData {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<GatewayPersistedData>;
        return {
          config: { ...DEFAULT_CONFIG, ...(parsed.config || {}) },
          keys: Array.isArray(parsed.keys) ? parsed.keys : [],
          aliases: Array.isArray(parsed.aliases) && parsed.aliases.length > 0 ? parsed.aliases : [...DEFAULT_ALIASES],
          logs: Array.isArray(parsed.logs) ? parsed.logs : [],
        };
      }
    } catch (e) {
      console.warn('[GatewayStore] 读取持久化配置异常，使用初始配置:', e);
    }

    return {
      config: { ...DEFAULT_CONFIG },
      keys: [],
      aliases: [...DEFAULT_ALIASES],
      logs: [],
    };
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const temporary = join(dir, `.${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify(this.data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, this.filePath);
      if (process.platform !== 'win32') chmodSync(this.filePath, 0o600);
    } catch (e) {
      console.error('[GatewayStore] 保存持久化配置异常:', e);
    }
  }

  // --- 配置相关 ---
  public getConfig(): GatewayConfig {
    return { ...this.data.config };
  }

  public updateConfig(patch: Partial<GatewayConfig>): GatewayConfig {
    this.data.config = { ...this.data.config, ...patch };
    this.save();
    return this.getConfig();
  }

  // --- API Key 相关 ---
  public listKeys(): GatewayApiKey[] {
    return [...this.data.keys];
  }

  public createKey(input: {
    name: string;
    allowedModels?: string[];
    rateLimitRpm?: number;
  }): GatewayApiKey {
    const rawKey = `hap-${randomBytes(16).toString('hex')}`;
    const newKey: GatewayApiKey = {
      id: randomUUID(),
      name: input.name.trim() || 'API Key',
      key: rawKey,
      createdAt: Date.now(),
      enabled: true,
      allowedModels: Array.isArray(input.allowedModels) ? input.allowedModels.map(m => m.trim()).filter(Boolean) : [],
      rateLimitRpm: typeof input.rateLimitRpm === 'number' ? Math.max(0, input.rateLimitRpm) : 0,
      totalRequests: 0,
      totalTokens: 0,
    };
    this.data.keys.unshift(newKey);
    this.save();
    return newKey;
  }

  public updateKey(
    id: string,
    patch: Partial<Omit<GatewayApiKey, 'id' | 'key' | 'createdAt'>>
  ): GatewayApiKey | null {
    const item = this.data.keys.find(k => k.id === id);
    if (!item) return null;

    if (typeof patch.name === 'string') item.name = patch.name.trim();
    if (typeof patch.enabled === 'boolean') item.enabled = patch.enabled;
    if (Array.isArray(patch.allowedModels)) {
      item.allowedModels = patch.allowedModels.map(m => m.trim()).filter(Boolean);
    }
    if (typeof patch.rateLimitRpm === 'number') {
      item.rateLimitRpm = Math.max(0, patch.rateLimitRpm);
    }

    this.save();
    return { ...item };
  }

  public deleteKey(id: string): boolean {
    const initialLen = this.data.keys.length;
    this.data.keys = this.data.keys.filter(k => k.id !== id);
    if (this.data.keys.length !== initialLen) {
      this.save();
      return true;
    }
    return false;
  }

  public validateKey(token: string): { valid: boolean; key?: GatewayApiKey; error?: string } {
    const cleanToken = token.trim().replace(/^Bearer\s+/i, '');
    if (!cleanToken) {
      return { valid: false, error: '缺少 Authorization Bearer 密钥' };
    }

    const matched = this.data.keys.find(k => k.key === cleanToken);
    if (!matched) {
      return { valid: false, error: '提供的 API Key 无效或不存在' };
    }

    if (!matched.enabled) {
      return { valid: false, error: '该 API Key 已被停用' };
    }

    return { valid: true, key: matched };
  }

  public checkRateLimit(keyId: string, customLimit?: number): boolean {
    const limit = customLimit && customLimit > 0 ? customLimit : this.data.config.defaultRateLimitRpm;
    if (limit <= 0) return true; // 不限制

    const now = Date.now();
    const bucket = this.rpmBuckets.get(keyId);
    if (!bucket || now - bucket.windowStart >= 60_000) {
      this.rpmBuckets.set(keyId, { count: 1, windowStart: now });
      return true;
    }

    if (bucket.count >= limit) {
      return false; // 超出 RPM 限流
    }

    bucket.count++;
    return true;
  }

  public recordKeyUsage(keyId: string, tokens: number): void {
    const key = this.data.keys.find(k => k.id === keyId);
    if (key) {
      key.totalRequests = (key.totalRequests || 0) + 1;
      key.totalTokens = (key.totalTokens || 0) + tokens;
      key.lastUsedAt = Date.now();
      this.save();
    }
  }

  // --- 模型别名与映射相关 ---
  public listAliases(): ModelAliasRule[] {
    return [...this.data.aliases];
  }

  public upsertAlias(input: Omit<ModelAliasRule, 'id'> & { id?: string }): ModelAliasRule {
    const id = input.id || randomUUID();
    const index = this.data.aliases.findIndex(a => a.id === id || a.alias.toLowerCase() === input.alias.trim().toLowerCase());

    const rule: ModelAliasRule = {
      id,
      alias: input.alias.trim(),
      targetModel: input.targetModel.trim(),
      enabled: input.enabled ?? true,
      description: input.description?.trim() || undefined,
      fallbackModel: input.fallbackModel?.trim() || undefined,
    };

    if (index >= 0) {
      this.data.aliases[index] = rule;
    } else {
      this.data.aliases.push(rule);
    }

    this.save();
    return rule;
  }

  public deleteAlias(id: string): boolean {
    const initialLen = this.data.aliases.length;
    this.data.aliases = this.data.aliases.filter(a => a.id !== id);
    if (this.data.aliases.length !== initialLen) {
      this.save();
      return true;
    }
    return false;
  }

  public resolveModel(aliasOrName: string): {
    resolvedModel: string;
    fallbackModel?: string | undefined;
    wasAliased: boolean;
  } {
    const clean = aliasOrName.trim();
    const matched = this.data.aliases.find(
      a => a.enabled && a.alias.toLowerCase() === clean.toLowerCase()
    );

    if (matched) {
      return {
        resolvedModel: matched.targetModel,
        fallbackModel: matched.fallbackModel || this.data.config.defaultFallbackModel,
        wasAliased: true,
      };
    }

    return {
      resolvedModel: clean,
      fallbackModel: this.data.config.defaultFallbackModel,
      wasAliased: false,
    };
  }

  // --- 请求审计日志与统计 ---
  public logRequest(entry: Omit<GatewayRequestLog, 'id' | 'timestamp'>): GatewayRequestLog {
    const fullLog: GatewayRequestLog = {
      ...entry,
      id: randomUUID(),
      timestamp: Date.now(),
    };

    this.data.logs.unshift(fullLog);
    if (this.data.logs.length > MAX_LOGS_KEPT) {
      this.data.logs = this.data.logs.slice(0, MAX_LOGS_KEPT);
    }
    this.save();
    return fullLog;
  }

  public listLogs(limit = 100): GatewayRequestLog[] {
    return this.data.logs.slice(0, Math.min(MAX_LOGS_KEPT, limit));
  }

  public clearLogs(): void {
    this.data.logs = [];
    this.save();
  }

  public getStats(): GatewayStats {
    const now = Date.now();
    const startOfToday = new Date().setHours(0, 0, 0, 0);

    let totalRequests = this.data.logs.length;
    let todayRequests = 0;
    let totalTokens = 0;
    let todayTokens = 0;
    let totalLatency = 0;
    const modelDistribution: Record<string, number> = {};

    for (const log of this.data.logs) {
      totalTokens += log.totalTokens || 0;
      totalLatency += log.latencyMs || 0;

      const m = log.requestedModel || 'unknown';
      modelDistribution[m] = (modelDistribution[m] || 0) + 1;

      if (log.timestamp >= startOfToday) {
        todayRequests++;
        todayTokens += log.totalTokens || 0;
      }
    }

    const activeKeysCount = this.data.keys.filter(k => k.enabled).length;
    const avgLatencyMs = totalRequests > 0 ? Math.round(totalLatency / totalRequests) : 0;

    return {
      totalRequests,
      todayRequests,
      totalTokens,
      todayTokens,
      avgLatencyMs,
      activeKeysCount,
      modelDistribution,
    };
  }
}
