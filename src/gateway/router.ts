import { loadConfig, resolveConfigPath, BUILTIN_PROVIDERS, BUILTIN_MODELS } from '../config/index.js';
import { readSavedEnv } from '../gui/provider-operations.js';
import type { GatewayStore } from './store.js';
import type { GatewayApiKey, GatewayRequestLog } from './types.js';

export interface ChatMessage {
  role: string;
  content: string | unknown[];
  name?: string | undefined;
}

export interface ChatCompletionRequestBody {
  model: string;
  messages: ChatMessage[];
  stream?: boolean | undefined;
  temperature?: number | undefined;
  max_tokens?: number | undefined;
  top_p?: number | undefined;
  frequency_penalty?: number | undefined;
  presence_penalty?: number | undefined;
  stop?: string | string[] | undefined;
  [key: string]: unknown;
}

export interface ResolvedTarget {
  kind: 'ollama' | 'openai-compatible';
  url: string;
  apiKey?: string | undefined;
  model: string;
  providerId: string;
}

function approximateTokens(text: string): number {
  if (!text) return 0;
  // 中文每个字符大约 1-2 token，英文约 4 字符 1 token
  let tokenEstimate = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 255) {
      tokenEstimate += 1.5;
    } else {
      tokenEstimate += 0.25;
    }
  }
  return Math.max(1, Math.round(tokenEstimate));
}

function estimatePromptTokens(messages: ChatMessage[]): number {
  let chars = '';
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content;
    } else if (Array.isArray(m.content)) {
      chars += JSON.stringify(m.content);
    }
  }
  return approximateTokens(chars);
}

export class GatewayRouter {
  constructor(
    private store: GatewayStore,
    private configPath?: string
  ) {}

  /**
   * 列出所有当前可分发的模型 (OpenAI /v1/models 标准接口)
   */
  public async listModels(): Promise<{ id: string; object: string; created: number; owned_by: string }[]> {
    const modelMap = new Map<string, { id: string; object: string; created: number; owned_by: string }>();

    // 1. 本地 Ollama 模型列表探测 (若 Ollama 运行中)
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) {
        const json = (await res.json()) as { models?: { name: string; modified_at?: string }[] };
        if (Array.isArray(json.models)) {
          for (const m of json.models) {
            if (m.name) {
              const created = m.modified_at ? Math.floor(new Date(m.modified_at).getTime() / 1000) : 1700000000;
              modelMap.set(m.name, {
                id: m.name,
                object: 'model',
                created,
                owned_by: 'ollama (local)',
              });
              // 同时提供带 ollama/ 前缀的格式
              modelMap.set(`ollama/${m.name}`, {
                id: `ollama/${m.name}`,
                object: 'model',
                created,
                owned_by: 'ollama (local)',
              });
            }
          }
        }
      }
    } catch {
      // Ollama 未启动或探测超时，忽略
    }

    // 2. 平台配置与内置模型列表
    try {
      const cfgPath = resolveConfigPath(this.configPath);
      const cfg = loadConfig({ path: cfgPath });
      if (cfg.config.models) {
        for (const [id, m] of Object.entries(cfg.config.models)) {
          modelMap.set(id, {
            id,
            object: 'model',
            created: 1700000000,
            owned_by: m.provider || 'hap-config',
          });
        }
      }
    } catch {
      // 忽略配置读取异常
    }

    // 3. 内置知名云端推荐模型 (若已配置好 Provider Key)
    const env = readSavedEnv();
    for (const [modelId, modelMeta] of Object.entries(BUILTIN_MODELS)) {
      if (!modelMap.has(modelId)) {
        modelMap.set(modelId, {
          id: modelId,
          object: 'model',
          created: 1700000000,
          owned_by: modelMeta.provider,
        });
      }
    }

    // 4. 用户设置的模型别名 (Model Aliases)
    for (const alias of this.store.listAliases()) {
      if (alias.enabled) {
        modelMap.set(alias.alias, {
          id: alias.alias,
          object: 'model',
          created: 1700000000,
          owned_by: `alias -> ${alias.targetModel}`,
        });
      }
    }

    return Array.from(modelMap.values());
  }

  /**
   * 解析具体模型对应的后端请求地址与认证信息
   */
  public resolveBackendTarget(modelIdentifier: string): ResolvedTarget {
    const raw = modelIdentifier.trim();

    // A. 判定是否为 Ollama 本地模型
    // 包含 'ollama/' 前缀，或者属于格式如 'qwen2.5-coder:7b' 且不含云端厂商前缀
    const isExplicitOllama = raw.toLowerCase().startsWith('ollama/');
    const isLikelyLocalTag = raw.includes(':') && !raw.includes('/');

    if (isExplicitOllama || isLikelyLocalTag) {
      const cleanModel = isExplicitOllama ? raw.slice(7) : raw;
      return {
        kind: 'ollama',
        url: 'http://127.0.0.1:11434/v1/chat/completions',
        model: cleanModel,
        providerId: 'ollama',
      };
    }

    // B. 云端模型商解析
    let providerId = 'deepseek';
    let targetModel = raw;

    if (raw.includes('/')) {
      const parts = raw.split('/');
      providerId = parts[0] || 'deepseek';
      targetModel = parts.slice(1).join('/');
    } else {
      // 在 BUILTIN_MODELS 或 BUILTIN_PROVIDERS 查找对应 provider
      for (const [builtinId, meta] of Object.entries(BUILTIN_MODELS)) {
        if (builtinId === raw || meta.model === raw) {
          providerId = meta.provider;
          targetModel = meta.model || raw;
          break;
        }
      }
    }

    // 获取 Provider 的 base_url
    let baseUrl = 'https://api.deepseek.com';
    const builtinProvider = BUILTIN_PROVIDERS[providerId];
    if (builtinProvider?.base_url) {
      baseUrl = builtinProvider.base_url;
    }

    // 尝试从配置文件中读取用户自定义 base_url
    try {
      const cfg = loadConfig({ path: resolveConfigPath(this.configPath) });
      const configuredProvider = cfg.config.model_providers?.[providerId];
      if (configuredProvider?.base_url) {
        baseUrl = configuredProvider.base_url;
      }
    } catch {
      // 忽略
    }

    // 获取 Provider 对应的 API Key
    const env = readSavedEnv();
    let apiKey: string | undefined;

    // 先查标准环境变量映射
    const envKeyName = builtinProvider?.env_key || `${providerId.toUpperCase()}_API_KEY`;
    apiKey = env[envKeyName] || process.env[envKeyName] || env[providerId] || env[`${providerId}_api_key`];

    // 格式化 OpenAI 兼容 chat/completions 端点
    const cleanBase = baseUrl.replace(/\/+$/, '');
    const finalUrl = cleanBase.endsWith('/v1')
      ? `${cleanBase}/chat/completions`
      : cleanBase.includes('/chat/completions')
        ? cleanBase
        : `${cleanBase}/v1/chat/completions`;

    return {
      kind: 'openai-compatible',
      url: finalUrl,
      apiKey,
      model: targetModel,
      providerId,
    };
  }

  /**
   * 处理 /v1/chat/completions 请求转发与代理
   */
  public async handleChatCompletion(
    body: ChatCompletionRequestBody,
    clientIp: string,
    key?: GatewayApiKey,
    signal?: AbortSignal
  ): Promise<Response> {
    const startTime = Date.now();
    const requestedModel = body.model || 'unknown';

    // 1. 模型别名解析
    const { resolvedModel, fallbackModel } = this.store.resolveModel(requestedModel);

    // 2. 解析主目标与备用目标
    const primaryTarget = this.resolveBackendTarget(resolvedModel);
    const fallbackTarget = fallbackModel ? this.resolveBackendTarget(fallbackModel) : undefined;

    const stream = Boolean(body.stream);
    const estimatedPromptTokens = estimatePromptTokens(body.messages || []);

    // 尝试执行调用（支持主通道失败时自动故障转移至备选通道）
    try {
      return await this.executeUpstreamCall({
        target: primaryTarget,
        fallbackTarget,
        body,
        stream,
        clientIp,
        key,
        requestedModel,
        resolvedModel,
        estimatedPromptTokens,
        startTime,
        signal,
      });
    } catch (err: unknown) {
      const latencyMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);

      // 记录失败审计日志
      this.store.logRequest({
        clientIp,
        keyId: key?.id,
        keyName: key?.name,
        requestedModel,
        targetModel: primaryTarget.model,
        status: 500,
        latencyMs,
        promptTokens: estimatedPromptTokens,
        completionTokens: 0,
        totalTokens: estimatedPromptTokens,
        stream,
        error: errorMsg,
      });

      return new Response(
        JSON.stringify({
          error: {
            message: `[HAP API Gateway] 模型调用异常: ${errorMsg}`,
            type: 'gateway_upstream_error',
            param: null,
            code: 'upstream_failed',
          },
        }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }
      );
    }
  }

  private async executeUpstreamCall(ctx: {
    target: ResolvedTarget;
    fallbackTarget?: ResolvedTarget | undefined;
    body: ChatCompletionRequestBody;
    stream: boolean;
    clientIp: string;
    key?: GatewayApiKey | undefined;
    requestedModel: string;
    resolvedModel: string;
    estimatedPromptTokens: number;
    startTime: number;
    signal?: AbortSignal | undefined;
  }): Promise<Response> {
    const {
      target,
      fallbackTarget,
      body,
      stream,
      clientIp,
      key,
      requestedModel,
      estimatedPromptTokens,
      startTime,
      signal,
    } = ctx;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (target.apiKey) {
      headers['Authorization'] = `Bearer ${target.apiKey}`;
    }

    const upstreamPayload = {
      ...body,
      model: target.model,
    };

    let response: Response;
    let usedTarget = target;

    try {
      response = await fetch(target.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamPayload),
        signal: signal ?? null,
      });

      // 如果目标是本地 Ollama 且连不上/返回 5xx，且配置了故障转移 fallback
      if (!response.ok && response.status >= 500 && fallbackTarget && this.store.getConfig().fallbackToCloud) {
        console.warn(`[HAP Gateway] 主目标 ${target.model} (${target.url}) 响应 ${response.status}，正在故障转移至 ${fallbackTarget.model}...`);
        const fallbackHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (fallbackTarget.apiKey) {
          fallbackHeaders['Authorization'] = `Bearer ${fallbackTarget.apiKey}`;
        }
        response = await fetch(fallbackTarget.url, {
          method: 'POST',
          headers: fallbackHeaders,
          body: JSON.stringify({ ...body, model: fallbackTarget.model }),
          signal: signal ?? null,
        });
        usedTarget = fallbackTarget;
      }
    } catch (e) {
      if (fallbackTarget && this.store.getConfig().fallbackToCloud) {
        console.warn(`[HAP Gateway] 主目标 ${target.model} 连接失败 (${e})，触发自动故障转移至 ${fallbackTarget.model}...`);
        const fallbackHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (fallbackTarget.apiKey) {
          fallbackHeaders['Authorization'] = `Bearer ${fallbackTarget.apiKey}`;
        }
        response = await fetch(fallbackTarget.url, {
          method: 'POST',
          headers: fallbackHeaders,
          body: JSON.stringify({ ...body, model: fallbackTarget.model }),
          signal: signal ?? null,
        });
        usedTarget = fallbackTarget;
      } else {
        throw e;
      }
    }

    // 错误响应透传
    if (!response.ok) {
      const errorText = await response.text();
      const latencyMs = Date.now() - startTime;
      this.store.logRequest({
        clientIp,
        keyId: key?.id,
        keyName: key?.name,
        requestedModel,
        targetModel: usedTarget.model,
        status: response.status,
        latencyMs,
        promptTokens: estimatedPromptTokens,
        completionTokens: 0,
        totalTokens: estimatedPromptTokens,
        stream,
        error: errorText.slice(0, 300),
      });

      return new Response(errorText, {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('content-type') || 'application/json; charset=utf-8',
        },
      });
    }

    // 非流式响应处理
    if (!stream) {
      const data = await response.json();
      const latencyMs = Date.now() - startTime;

      let completionTokens = 0;
      let totalTokens = estimatedPromptTokens;

      if (data?.usage) {
        completionTokens = Number(data.usage.completion_tokens) || 0;
        totalTokens = Number(data.usage.total_tokens) || (estimatedPromptTokens + completionTokens);
      } else {
        const replyText = data?.choices?.[0]?.message?.content || '';
        completionTokens = approximateTokens(replyText);
        totalTokens = estimatedPromptTokens + completionTokens;
      }

      // 记录审计与 Token
      this.store.logRequest({
        clientIp,
        keyId: key?.id,
        keyName: key?.name,
        requestedModel,
        targetModel: usedTarget.model,
        status: 200,
        latencyMs,
        promptTokens: estimatedPromptTokens,
        completionTokens,
        totalTokens,
        stream: false,
      });

      if (key?.id) {
        this.store.recordKeyUsage(key.id, totalTokens);
      }

      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    }

    // 流式响应 (SSE) 处理
    let accumulatedText = '';
    const upstreamBody = response.body;

    if (!upstreamBody) {
      throw new Error('上游未返回流式响应体');
    }

    const reader = upstreamBody.getReader();
    const textDecoder = new TextDecoder();

    const self = this;
    const sseStream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();

            const latencyMs = Date.now() - startTime;
            const completionTokens = approximateTokens(accumulatedText);
            const totalTokens = estimatedPromptTokens + completionTokens;

            self.store.logRequest({
              clientIp,
              keyId: key?.id,
              keyName: key?.name,
              requestedModel,
              targetModel: usedTarget.model,
              status: 200,
              latencyMs,
              promptTokens: estimatedPromptTokens,
              completionTokens,
              totalTokens,
              stream: true,
            });

            if (key?.id) {
              self.store.recordKeyUsage(key.id, totalTokens);
            }
            return;
          }

          const chunkText = textDecoder.decode(value, { stream: true });
          accumulatedText += chunkText;
          controller.enqueue(value);
        } catch (streamErr) {
          controller.error(streamErr);
        }
      },
      cancel() {
        reader.cancel().catch(() => {});
      },
    });

    return new Response(sseStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }
}
