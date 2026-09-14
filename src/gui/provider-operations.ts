import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  BUILTIN_MODELS,
  BUILTIN_PROVIDERS,
  ConfigResolver,
  ConfigWriter,
  loadConfig,
  type ModelPatch,
  type ProviderPatch,
  type ResolvedProvider,
} from '../config/index.js';
import { ProviderRegistry } from '../providers/index.js';
import { describeError, type ProtocolName, type WireApi } from '../domain/index.js';
import type { GuiModelInput, GuiProviderInput } from './shared.js';

const DATA_DIR = process.env.HAP_DATA_DIR || join(homedir(), '.hap', 'gui');
const ENV_PATH = join(DATA_DIR, 'env.json');
const STATE_PATH = join(DATA_DIR, 'state.json');

export interface ProviderOperationsState {
  hiddenProviders?: string[];
  hiddenModels?: string[];
  defaultProvidersCleared?: boolean;
}

export interface GuiProviderTestInput {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  envKey?: string;
  wireApi?: string;
  protocol?: string;
}

export function readSavedEnv(): Record<string, string> {
  try {
    if (existsSync(ENV_PATH)) {
      return JSON.parse(readFileSync(ENV_PATH, 'utf8')) as Record<string, string>;
    }
  } catch {
    // 忽略异常
  }
  return {};
}

export function writeSavedEnv(env: Record<string, string>): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(ENV_PATH, JSON.stringify(env, null, 2), 'utf8');
  } catch {
    // 忽略异常
  }
}

export function readOperationsState(): ProviderOperationsState {
  try {
    if (existsSync(STATE_PATH)) {
      return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as ProviderOperationsState;
    }
  } catch {
    // 忽略异常
  }
  return {};
}

export function writeOperationsState(state: ProviderOperationsState): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // 忽略异常
  }
}

export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

export function upsertProvider(configPath: string, input: GuiProviderInput): { ok: boolean } {
  const id = input.id.trim();
  if (!id) throw new Error('服务商 ID 不能为空');
  const baseUrl = input.baseUrl.trim();
  if (!baseUrl) throw new Error('Base URL 不能为空');

  const envKey = input.envKey?.trim() || `${id.toUpperCase()}_API_KEY`;

  if (input.apiKey && input.apiKey.trim()) {
    let trimmedKey = input.apiKey.trim();
    if ((trimmedKey.startsWith('"') && trimmedKey.endsWith('"')) || (trimmedKey.startsWith("'") && trimmedKey.endsWith("'"))) {
      trimmedKey = trimmedKey.slice(1, -1).trim();
    }
    if (trimmedKey.startsWith('Bearer ')) {
      trimmedKey = trimmedKey.slice(7).trim();
    }
    if (/^https?:\/\//i.test(trimmedKey)) {
      throw new Error(`API Key 格式不正确：检测到输入内容为 URL 地址 (${trimmedKey})。API Key 应当是服务商提供的密钥令牌（例如 sk-...），请不要将 Base URL 误填入密钥字段。`);
    }
    process.env[envKey] = trimmedKey;
    const saved = readSavedEnv();
    saved[envKey] = trimmedKey;
    writeSavedEnv(saved);
  }

  const patch: ProviderPatch = {
    base_url: baseUrl,
    env_key: envKey,
    wire_api: input.wireApi,
    default_protocol: input.protocol,
  };
  if (input.name && input.name.trim()) patch.name = input.name.trim();

  const writer = new ConfigWriter(configPath);
  writer.upsertProvider(id, patch);

  const state = readOperationsState();
  if (state.hiddenProviders?.includes(id)) {
    state.hiddenProviders = state.hiddenProviders.filter((p) => p !== id);
    writeOperationsState(state);
  }

  return { ok: true };
}

export function removeProvider(configPath: string, id: string): { ok: boolean } {
  const state = readOperationsState();
  state.hiddenProviders = Array.from(new Set([...(state.hiddenProviders || []), id]));
  writeOperationsState(state);

  const writer = new ConfigWriter(configPath);
  try {
    writer.removeProvider(id);
  } catch {
    // 允许预置项不存在于 config.toml 中
  }
  return { ok: true };
}

export function batchRemoveProviders(configPath: string, ids: string[]): { ok: boolean; count: number } {
  const state = readOperationsState();
  state.hiddenProviders = Array.from(new Set([...(state.hiddenProviders || []), ...ids]));
  writeOperationsState(state);

  const writer = new ConfigWriter(configPath);
  for (const id of ids) {
    try {
      writer.removeProvider(id);
    } catch {
      // 忽略
    }
  }
  return { ok: true, count: ids.length };
}

export function upsertModel(configPath: string, input: GuiModelInput): { ok: boolean } {
  const alias = input.alias.trim();
  if (!alias) throw new Error('模型别名不能为空');
  const provider = input.provider.trim();
  if (!provider) throw new Error('所属服务商不能为空');
  const model = input.model.trim();
  if (!model) throw new Error('模型真实名称不能为空');

  const patch: ModelPatch = {
    provider,
    model,
    context_window: input.contextWindow,
    max_output_tokens: input.maxOutputTokens,
    protocol: input.protocol,
    capabilities: input.capabilities,
  };
  const writer = new ConfigWriter(configPath);
  writer.upsertModel(alias, patch);

  const state = readOperationsState();
  if (state.hiddenModels?.includes(alias)) {
    state.hiddenModels = state.hiddenModels.filter((m) => m !== alias);
    writeOperationsState(state);
  }

  return { ok: true };
}

export function removeModel(configPath: string, alias: string): { ok: boolean } {
  const state = readOperationsState();
  state.hiddenModels = Array.from(new Set([...(state.hiddenModels || []), alias]));
  writeOperationsState(state);

  const writer = new ConfigWriter(configPath);
  try {
    writer.removeModel(alias);
  } catch {
    // 允许预置项不存在于 config.toml 中
  }
  return { ok: true };
}

export function batchRemoveModels(configPath: string, aliases: string[]): { ok: boolean; count: number } {
  const state = readOperationsState();
  state.hiddenModels = Array.from(new Set([...(state.hiddenModels || []), ...aliases]));
  writeOperationsState(state);

  const writer = new ConfigWriter(configPath);
  for (const alias of aliases) {
    try {
      writer.removeModel(alias);
    } catch {
      // 忽略
    }
  }
  return { ok: true, count: aliases.length };
}

export function setDefaultModel(configPath: string, rawAlias: string): object {
  const alias = rawAlias.trim();
  if (!alias) throw new Error('模型标识不能为空');
  const loaded = loadConfig({ path: configPath });
  const resolver = new ConfigResolver(loaded, {}, process.env);
  const models = resolver.resolveModels();
  const found = models.get(alias) || [...models.values()].find((m) => m.alias === alias || m.fullName === alias);
  if (!found) {
    throw new Error(`模型 "${alias}" 未在已注册模型目录中找到，无法设为默认模型`);
  }
  const result = new ConfigWriter(configPath).setGlobals({ defaultModel: alias });
  return result;
}

export function getProviderApiKey(configPath: string, providerId: string): { isSet: boolean; envKey: string; maskedValue: string; value: string } {
  const loaded = loadConfig({ path: configPath });
  const resolver = new ConfigResolver(loaded, {}, process.env);
  const existing = resolver.resolveProviders().get(providerId);
  const envKey = existing?.envKey || `${providerId.toUpperCase()}_API_KEY`;
  const saved = readSavedEnv();
  const rawVal = process.env[envKey] || saved[envKey] || '';
  const isSet = Boolean(rawVal && rawVal.trim().length > 0);
  return {
    isSet,
    envKey,
    maskedValue: isSet ? maskApiKey(rawVal) : '',
    value: rawVal,
  };
}

export async function testProvider(configPath: string, idOrConfig: string | GuiProviderTestInput): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const loaded = loadConfig({ path: configPath });
    const resolver = new ConfigResolver(loaded, {}, process.env);

    if (typeof idOrConfig === 'string') {
      const id = idOrConfig;
      const registry = new ProviderRegistry(resolver.resolveProviders(), { env: process.env });
      const result = await registry.check(id, controller.signal);
      return { ...result };
    }

    const config = idOrConfig;
    const id = config.id?.trim() || 'custom';
    const baseUrl = config.baseUrl?.trim() || '';
    const testModel = config.model?.trim() || '';
    if (!baseUrl) {
      return { providerId: id, reachable: false, error: '未配置 Base URL' };
    }
    if (!testModel) {
      return { providerId: id, reachable: false, error: '请先指定要测试的模型 ID' };
    }

    const existing = resolver.resolveProviders().get(id);
    const envKey = config.envKey?.trim() || existing?.envKey || `${id.toUpperCase()}_API_KEY`;
    const saved = readSavedEnv();
    const apiKey = config.apiKey?.trim() || (existing?.envKey ? process.env[existing.envKey] || saved[existing.envKey] : undefined) || process.env[envKey] || saved[envKey] || process.env[`${id.toUpperCase()}_API_KEY`];
    if (apiKey && /^https?:\/\//i.test(apiKey)) {
      return {
        providerId: id,
        reachable: false,
        error: `API Key 格式错误：当前保存或输入的密钥内容为 URL 地址 (${maskApiKey(apiKey)})，请修改为服务商提供的实际 API 密钥凭据（如 sk-...）后再测试`,
      };
    }
    const wireApi = (config.wireApi || existing?.wireApi || 'chat') as WireApi;
    const defaultProtocol = (config.protocol || existing?.defaultProtocol || 'openai-tools') as ProtocolName;

    const tempProvider: ResolvedProvider = {
      id,
      name: id,
      baseUrl,
      envKey: apiKey ? envKey : undefined,
      wireApi,
      defaultProtocol,
      httpHeaders: existing?.httpHeaders || {},
      envHttpHeaders: existing?.envHttpHeaders || {},
      requestMaxRetries: 1,
      streamMaxRetries: 1,
      streamIdleTimeoutMs: 10_000,
      maxTokensDefault: 4096,
    };

    const tempEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (apiKey) {
      tempEnv[envKey] = apiKey;
    }

    const tempMap = new Map<string, ResolvedProvider>([[id, tempProvider]]);
    const registry = new ProviderRegistry(tempMap, { env: tempEnv });
    const started = Date.now();
    let received = false;
    for await (const event of registry.client(id).send({ model: testModel, messages: [{ role: 'user', content: 'Reply with OK.' }], params: {}, maxTokens: 16 }, controller.signal)) {
      if (event.type === 'text_delta' || event.type === 'finish') received = true;
    }
    return { providerId: id, reachable: received, handshakeMs: Date.now() - started, models: [testModel], ...(received ? {} : { error: '模型未返回有效响应' }) };
  } catch (error) {
    const pId = typeof idOrConfig === 'string' ? idOrConfig : (idOrConfig.id || 'custom');
    return { providerId: pId, reachable: false, error: describeError(error) };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function testModel(configPath: string, rawAlias: string): Promise<{ ok: boolean; latencyMs?: number; preview?: string; error?: string }> {
  const alias = rawAlias.trim();
  if (!alias) return { ok: false, error: '请指定要测试的模型名称' };

  const loaded = loadConfig({ path: configPath });
  const resolver = new ConfigResolver(loaded, {}, process.env);
  const models = resolver.resolveModels();
  const modelEntry = models.get(alias) || [...models.values()].find((m) => m.alias === alias || m.fullName === alias);
  if (!modelEntry) {
    return { ok: false, error: `未在模型目录中找到模型 "${alias}"` };
  }

  const providerId = modelEntry.providerId;
  const provider = resolver.resolveProviders().get(providerId);
  if (!provider) {
    return { ok: false, error: `模型所属服务商 "${providerId}" 未找到` };
  }

  const saved = readSavedEnv();
  const envKey = provider.envKey || `${providerId.toUpperCase()}_API_KEY`;
  const apiKey = (provider.envKey ? process.env[provider.envKey] || saved[provider.envKey] : undefined)
    || process.env[envKey] || saved[envKey] || process.env[`${providerId.toUpperCase()}_API_KEY`];
  if (apiKey && /^https?:\/\//i.test(apiKey)) {
    return {
      ok: false,
      error: `服务商 API Key 配置异常：当前密钥为 URL 地址 (${maskApiKey(apiKey)})，请先在服务商设置中修改为实际密钥凭据`,
    };
  }

  const tempEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (apiKey) {
    tempEnv[envKey] = apiKey;
  }

  const tempMap = new Map<string, ResolvedProvider>([[providerId, provider]]);
  const registry = new ProviderRegistry(tempMap, { env: tempEnv });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);
  const started = Date.now();

  try {
    let preview = '';
    const realModelName = modelEntry.model || modelEntry.alias;
    for await (const event of registry.client(providerId).send(
      {
        model: realModelName,
        messages: [{ role: 'user', content: 'Say "OK"' }],
        params: {},
        maxTokens: 16,
      },
      controller.signal
    )) {
      if (event.type === 'text_delta') {
        preview += event.text;
      } else if (event.type === 'finish') {
        break;
      }
    }
    const latencyMs = Date.now() - started;
    return {
      ok: true,
      latencyMs,
      preview: preview.trim() || 'OK',
    };
  } catch (err) {
    const msg = describeError(err);
    const isTimeout = msg.includes('aborted') || msg.includes('timeout') || controller.signal.aborted;
    const errorText = isTimeout ? '模型请求超时 (12s)' : msg;
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: errorText,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchProviderModels(
  configPath: string,
  providerId: string,
  customOptions?: { baseUrl?: string; apiKey?: string; wireApi?: string; protocol?: string }
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const loaded = loadConfig({ path: configPath });
    const resolver = new ConfigResolver(loaded, {}, process.env);
    const existing = resolver.resolveProviders().get(providerId);

    const baseUrl = customOptions?.baseUrl || existing?.baseUrl;
    const envKey = existing?.envKey || `${providerId.toUpperCase()}_API_KEY`;
    const saved = readSavedEnv();
    const apiKey = customOptions?.apiKey || (existing?.envKey ? process.env[existing.envKey] || saved[existing.envKey] : undefined) || process.env[envKey] || saved[envKey] || process.env[`${providerId.toUpperCase()}_API_KEY`];

    if (!baseUrl) return { ok: false, models: [], error: '未配置 Base URL' };

    const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
    let modelsEndpoint: string;
    try {
      const u = new URL(cleanBaseUrl);
      modelsEndpoint = u.pathname === '/' || u.pathname === '' ? `${cleanBaseUrl}/v1/models` : `${cleanBaseUrl}/models`;
    } catch {
      modelsEndpoint = `${cleanBaseUrl}/models`;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      let cleanKey = apiKey.trim();
      if ((cleanKey.startsWith('"') && cleanKey.endsWith('"')) || (cleanKey.startsWith("'") && cleanKey.endsWith("'"))) {
        cleanKey = cleanKey.slice(1, -1).trim();
      }
      if (cleanKey.startsWith('Bearer ')) {
        cleanKey = cleanKey.slice(7).trim();
      }
      headers['Authorization'] = `Bearer ${cleanKey}`;
    }

    if (providerId === 'anthropic' || cleanBaseUrl.includes('anthropic')) {
      if (apiKey) headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }

    const res = await fetch(modelsEndpoint, { headers, method: 'GET', signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, models: [], error: `远端返回 HTTP ${res.status}: ${text.slice(0, 120) || res.statusText}` };
    }

    const json = await res.json() as { data?: Array<{ id?: string; name?: string }> | Record<string, unknown> };
    if (json.data && Array.isArray(json.data)) {
      const list = json.data.map((item) => item.id || item.name).filter((x): x is string => Boolean(x));
      return { ok: true, models: list };
    } else if (Array.isArray(json)) {
      const list = json.map((item) => (typeof item === 'string' ? item : item.id || item.name)).filter((x): x is string => Boolean(x));
      return { ok: true, models: list };
    }
    return { ok: false, models: [], error: '响应格式中未包含标准的 models 数组列表' };
  } catch (err) {
    const msg = describeError(err);
    const isTimeout = msg.includes('aborted') || msg.includes('timeout') || controller.signal.aborted;
    const errorText = isTimeout ? '请求远端模型列表超时 (12s)，请检查服务商地址是否可达' : msg;
    return { ok: false, models: [], error: errorText };
  } finally {
    clearTimeout(timeoutId);
  }
}
