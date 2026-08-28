/**
 * 提供商注册表：把 ResolvedProvider 变成可用的 ProviderClient。
 *
 * 三件事在这里收口：
 * 1. 线制分派——wire_api 决定用 Anthropic 客户端还是 OpenAI 兼容客户端，
 *    这是「新增提供商只改配置」（FR-PROV-001）的落点。
 * 2. 凭据现取现用（FR-PROV-002）——按 env_key 从 env 读取，读到即用，
 *    不落任何结构体、不进错误消息，因此没有脱敏需求。
 * 3. 闸门包装（FR-ROUTE-006）——每个提供商的客户端都套上并发/限速闸门，
 *    许可持有到流结束。
 *
 * 客户端按 provider id 缓存：SDK 实例内含连接池，反复新建会浪费握手。
 * 配置热重载时用 invalidate() 丢弃缓存。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../domain/index.js';
import type { ProviderCheckResult, ProviderClient } from '../domain/index.js';
import type { ResolvedProvider } from '../config/resolved.js';
import { AnthropicClient } from './anthropic.js';
import { GateRegistry, GatedProviderClient } from './gate.js';
import { OpenAiCompatibleClient } from './openai-compatible.js';

/** 从本地 JSON 凭据持久化文件读取已保存的 API Key 凭据 */
function loadLocalJsonEnv(): Record<string, string> {
  const map: Record<string, string> = {};
  try {
    const candidates = [
      join(homedir(), '.hap', 'gui', 'env.json'),
      join(homedir(), '.hap', 'credentials.json'),
      join(homedir(), '.hap', 'env.json'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const text = readFileSync(p, 'utf-8');
        const json = JSON.parse(text) as Record<string, unknown>;
        for (const [k, v] of Object.entries(json)) {
          if (typeof v === 'string' && v.trim() !== '') {
            map[k] = v.trim();
          }
        }
      }
    }
  } catch {
    // 忽略异常
  }
  return map;
}

/** 环境变量视图。测试一律传自造对象，不透传 process.env。 */
export type EnvLike = Record<string, string | undefined>;

/** 工厂上下文。apiKey 与 headers 已由注册表解析完毕。 */
export interface ProviderFactoryContext {
  provider: ResolvedProvider;
  apiKey: string | undefined;
  headers: Record<string, string>;
}

/** 客户端工厂。测试可注入以替换真实 SDK。 */
export type ProviderFactory = (context: ProviderFactoryContext) => ProviderClient;

/** 默认工厂：仅按 wire_api 分派，无厂商专属分支。 */
export const defaultProviderFactory: ProviderFactory = (context) => {
  const options = { provider: context.provider, apiKey: context.apiKey, headers: context.headers };
  if (context.provider.wireApi === 'anthropic-messages') return new AnthropicClient(options);
  return new OpenAiCompatibleClient(options);
};

/** 注册表构造参数。 */
export interface ProviderRegistryOptions {
  env?: EnvLike;
  /** 缺省时不套闸门（CLI 单次调用场景无需排队） */
  gates?: GateRegistry;
  factory?: ProviderFactory;
}

export class ProviderRegistry {
  private providers: Map<string, ResolvedProvider>;
  private readonly env: EnvLike;
  private readonly gates: GateRegistry | undefined;
  private readonly factory: ProviderFactory;
  private readonly clients = new Map<string, ProviderClient>();

  constructor(providers: Map<string, ResolvedProvider>, options: ProviderRegistryOptions = {}) {
    this.providers = providers;
    this.env = options.env ?? process.env;
    this.gates = options.gates;
    this.factory = options.factory ?? defaultProviderFactory;
  }

  get ids(): string[] {
    return Array.from(this.providers.keys());
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): ResolvedProvider | undefined {
    return this.providers.get(id);
  }

  provider(id: string): ResolvedProvider {
    const provider = this.providers.get(id);
    if (provider === undefined) {
      throw new ConfigError('PROVIDER_NOT_FOUND', '提供商 ' + id + ' 未配置。已配置：' + (this.ids.join('、') || '（无）'), {
        providerId: id,
        available: this.ids,
      });
    }
    return provider;
  }

  client(id: string): ProviderClient {
    const cached = this.clients.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const provider = this.provider(id);
    const apiKey = this.credential(provider);
    const headers = this.resolveHeaders(provider);
    const rawClient = this.factory({ provider, apiKey, headers });
    const wrapped = this.gates === undefined ? rawClient : new GatedProviderClient(rawClient, this.gates.gate(id));
    this.clients.set(id, wrapped);
    return wrapped;
  }

  /**
   * 读取凭据。优先匹配内存/系统环境，其次匹配本地 JSON 凭据中心；
   * env_key 缺省表示该端点无需凭据（本地 Ollama）；
   */
  credential(provider: ResolvedProvider): string | undefined {
    const envKey = provider.envKey;
    if (envKey === undefined) return undefined;
    const jsonEnv = loadLocalJsonEnv();
    const value = this.env[envKey] || jsonEnv[envKey] || (provider.id ? this.env[`${provider.id.toUpperCase()}_API_KEY`] || jsonEnv[`${provider.id.toUpperCase()}_API_KEY`] : undefined);
    if (value === undefined || value.trim() === '') {
      throw new ConfigError('CONFIG_ENV_MISSING', '提供商 ' + provider.id + ' 尚未配置 API Key 密钥凭据（' + envKey + '），请在服务商设置或凭据中心配置 API Key', {
        providerId: provider.id,
        envKey,
      });
    }
    let clean = value.trim();
    if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
      clean = clean.slice(1, -1).trim();
    }
    if (clean.startsWith('Bearer ')) {
      clean = clean.slice(7).trim();
    }
    return clean;
  }

  /**
   * 探测凭据是否就绪，不抛错。
   */
  hasCredential(provider: ResolvedProvider): boolean {
    const envKey = provider.envKey;
    if (envKey === undefined) {
      return true;
    }
    const jsonEnv = loadLocalJsonEnv();
    const value = this.env[envKey] || jsonEnv[envKey] || (provider.id ? this.env[`${provider.id.toUpperCase()}_API_KEY`] || jsonEnv[`${provider.id.toUpperCase()}_API_KEY`] : undefined);
    return value !== undefined && value.trim() !== '';
  }

  /**
   * 组装请求头：静态 http_headers 与 env_http_headers 合并，
   * 后者的值是环境变量名，运行时取值。缺失同样立即报错，
   * 因为这类头（如 OpenRouter 的 HTTP-Referer）缺失往往表现为难以定位的 4xx。
   */
  resolveHeaders(provider: ResolvedProvider): Record<string, string> {
    const headers: Record<string, string> = { ...provider.httpHeaders };
    for (const [header, envKey] of Object.entries(provider.envHttpHeaders)) {
      const value = this.env[envKey];
      if (value === undefined || value.trim() === '') {
        throw new ConfigError('CONFIG_ENV_MISSING', '提供商 ' + provider.id + ' 的请求头 ' + header + ' 需要环境变量 ' + envKey + '，当前为空', {
          providerId: provider.id,
          header,
          envKey,
        });
      }
      headers[header] = value;
    }
    return headers;
  }

  /** 单个提供商连通性自检。凭据/请求头缺失时不抛错，而是作为不可达结果返回，便于批量展示。 */
  async check(id: string, signal?: AbortSignal): Promise<ProviderCheckResult> {
    try {
      return await this.client(id).check(signal);
    } catch (error) {
      return {
        providerId: id,
        reachable: false,
        handshakeMs: 0,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 批量自检，并发执行。ids 缺省表示全部。 */
  async checkAll(ids?: readonly string[], signal?: AbortSignal): Promise<ProviderCheckResult[]> {
    const targets = ids ?? this.ids;
    return await Promise.all(targets.map((id) => this.check(id, signal)));
  }

  /** 丢弃客户端缓存。id 缺省表示全部，用于配置热重载。 */
  invalidate(id?: string): void {
    if (id === undefined) this.clients.clear();
    else this.clients.delete(id);
  }

  /** 替换提供商定义并清空缓存（配置热重载入口）。 */
  refresh(providers: Map<string, ResolvedProvider>): void {
    this.providers = providers;
    this.clients.clear();
  }
}
