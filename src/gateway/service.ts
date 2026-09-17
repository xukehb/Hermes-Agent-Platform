import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { GatewayStore } from './store.js';
import { GatewayRouter, type ChatCompletionRequestBody } from './router.js';
import type {
  ClientPresetItem,
  GatewayApiKey,
  GatewayConfig,
  GatewayOverview,
  GatewayRequestLog,
  GatewayStats,
  ModelAliasRule,
} from './types.js';

export function getLocalIpAddresses(): string[] {
  const ips: string[] = [];
  try {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          ips.push(net.address);
        }
      }
    }
  } catch {
    // 忽略异常
  }
  return ips.length > 0 ? ips : ['127.0.0.1'];
}

export function isLoopbackAddress(ip: string): boolean {
  const normalized = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === 'ip6-localhost') return true;
  const family = isIP(normalized);
  if (family === 4) return normalized.startsWith('127.');
  if (family === 6) return normalized === '::1' || normalized.startsWith('::ffff:127.');
  return false;
}

export class GatewayService {
  private store: GatewayStore;
  private router: GatewayRouter;

  constructor(customStorePath?: string, configPath?: string) {
    this.store = new GatewayStore(customStorePath);
    this.router = new GatewayRouter(this.store, configPath);
  }

  public getStore(): GatewayStore {
    return this.store;
  }

  public getRouter(): GatewayRouter {
    return this.router;
  }

  // --- 网关总览信息 ---
  public getOverview(currentPort = 3000): GatewayOverview {
    const config = this.store.getConfig();
    const port = config.port || currentPort;
    const stats = this.store.getStats();
    const lanIps = getLocalIpAddresses();

    const localBaseUrl = `http://127.0.0.1:${port}/v1`;
    const lanBaseUrls = lanIps.map(ip => `http://${ip}:${port}/v1`);

    return {
      enabled: config.enabled,
      bind: config.bind,
      port,
      localBaseUrl,
      lanBaseUrls,
      activeKeysCount: stats.activeKeysCount,
      aliasesCount: this.store.listAliases().filter(a => a.enabled).length,
      stats,
    };
  }

  // --- 配置与状态控制 ---
  public getConfig(): GatewayConfig {
    return this.store.getConfig();
  }

  public updateConfig(patch: Partial<GatewayConfig>): GatewayConfig {
    return this.store.updateConfig(patch);
  }

  // --- API Key 密钥管理 ---
  public listKeys(): GatewayApiKey[] {
    return this.store.listKeys();
  }

  public createKey(input: {
    name: string;
    allowedModels?: string[];
    rateLimitRpm?: number;
  }): GatewayApiKey {
    return this.store.createKey(input);
  }

  public updateKey(
    id: string,
    patch: Partial<Omit<GatewayApiKey, 'id' | 'key' | 'createdAt'>>
  ): GatewayApiKey | null {
    return this.store.updateKey(id, patch);
  }

  public deleteKey(id: string): boolean {
    return this.store.deleteKey(id);
  }

  // --- 模型别名与映射 ---
  public listAliases(): ModelAliasRule[] {
    return this.store.listAliases();
  }

  public upsertAlias(input: Omit<ModelAliasRule, 'id'> & { id?: string }): ModelAliasRule {
    return this.store.upsertAlias(input);
  }

  public deleteAlias(id: string): boolean {
    return this.store.deleteAlias(id);
  }

  // --- 审计日志与统计看板 ---
  public listLogs(limit = 100): GatewayRequestLog[] {
    return this.store.listLogs(limit);
  }

  public clearLogs(): void {
    this.store.clearLogs();
  }

  public getStats(): GatewayStats {
    return this.store.getStats();
  }

  // --- 模型目录与请求入口 ---
  public async listModels() {
    return await this.router.listModels();
  }

  public async dispatchChatCompletion(
    body: ChatCompletionRequestBody,
    clientIp: string,
    authHeader?: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const config = this.store.getConfig();

    if (!config.enabled) {
      return new Response(
        JSON.stringify({
          error: {
            message: 'HAP API 分发网关服务已关闭。请在系统设置中开启分发网关。',
            type: 'gateway_disabled',
            code: 'service_unavailable',
          },
        }),
        { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // 鉴权检查
    const isLocal = isLoopbackAddress(clientIp);
    let matchedKey: GatewayApiKey | undefined;

    if (!authHeader) {
      if (isLocal && config.allowAnonymousLocal) {
        // 允许本机无 Key 访问
      } else {
        return new Response(
          JSON.stringify({
            error: {
              message: '未提供有效 API Key 凭据。请在请求头附带 Authorization: Bearer hap-xxxx 访问。',
              type: 'authentication_error',
              code: 'invalid_api_key',
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        );
      }
    } else {
      const validation = this.store.validateKey(authHeader);
      if (!validation.valid || !validation.key) {
        return new Response(
          JSON.stringify({
            error: {
              message: validation.error || 'API Key 校验未通过',
              type: 'authentication_error',
              code: 'invalid_api_key',
            },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        );
      }
      matchedKey = validation.key;
    }

    // 模型白名单检查
    if (matchedKey && matchedKey.allowedModels.length > 0) {
      const requestedModel = (body.model || '').trim().toLowerCase();
      const isAllowed = matchedKey.allowedModels.some(
        m => m.toLowerCase() === requestedModel || requestedModel.includes(m.toLowerCase())
      );
      if (!isAllowed) {
        return new Response(
          JSON.stringify({
            error: {
              message: `当前 API Key 权限受限，不允许访问模型: ${body.model}`,
              type: 'permission_denied',
              code: 'model_not_allowed',
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        );
      }
    }

    // 速率限制 (RPM) 检查
    if (matchedKey) {
      const withinLimit = this.store.checkRateLimit(matchedKey.id, matchedKey.rateLimitRpm);
      if (!withinLimit) {
        return new Response(
          JSON.stringify({
            error: {
              message: `已超出此 API Key 每分钟请求速率上限 (RPM: ${matchedKey.rateLimitRpm || config.defaultRateLimitRpm})，请稍候重试。`,
              type: 'rate_limit_exceeded',
              code: 'rate_limit_reached',
            },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        );
      }
    }

    return await this.router.handleChatCompletion(body, clientIp, matchedKey, signal);
  }

  // --- 第三方客户端一键预设配置清单 ---
  public getClientPresets(currentPort = 3000, preferredKey?: string): ClientPresetItem[] {
    const config = this.store.getConfig();
    const port = config.port || currentPort;
    const localBaseUrl = `http://127.0.0.1:${port}/v1`;
    const lanIps = getLocalIpAddresses();
    const lanBaseUrl = `http://${lanIps[0] || '127.0.0.1'}:${port}/v1`;

    const keys = this.store.listKeys();
    const activeKey = preferredKey || keys.find(k => k.enabled)?.key || 'hap-your-api-key';

    return [
      {
        id: 'cursor',
        name: 'Cursor IDE',
        description: '在 Cursor 设置 -> Models -> OpenAI API Key 中填入自定义 Base URL 与 Key',
        icon: 'cursor',
        snippetType: 'text',
        fields: [
          { label: 'OpenAI Base URL', value: localBaseUrl },
          { label: 'OpenAI API Key', value: activeKey },
          { label: '推荐模型 (Model ID)', value: 'gpt-4o' },
        ],
        snippet: `Base URL: ${localBaseUrl}\nAPI Key:  ${activeKey}\nModel:    gpt-4o`,
      },
      {
        id: 'vscode-continue',
        name: 'VS Code (Continue 插件)',
        description: '在 ~/.continue/config.json 的 "models" 数组中加入 HAP 分发网关模型配置',
        icon: 'vscode',
        snippetType: 'json',
        fields: [
          { label: 'API Base', value: localBaseUrl },
          { label: 'API Key', value: activeKey },
        ],
        snippet: JSON.stringify(
          {
            title: 'HAP 本地大模型分发',
            provider: 'openai',
            model: 'gpt-4o',
            apiBase: localBaseUrl,
            apiKey: activeKey,
          },
          null,
          2
        ),
      },
      {
        id: 'cherry-studio',
        name: 'Cherry Studio / Chatbox',
        description: '在客户端设置中新建「OpenAI 兼容」提供商，直接接入已分发的所有模型',
        icon: 'cherry',
        snippetType: 'text',
        fields: [
          { label: 'API 域名 / Host', value: localBaseUrl },
          { label: 'API Key 凭据', value: activeKey },
        ],
        snippet: `API 域名: ${localBaseUrl}\nAPI Key:  ${activeKey}`,
      },
      {
        id: 'lan-device',
        name: '局域网其他设备 / 团队共享',
        description: '在同一局域网的手机、笔记本或同事电脑中直接使用局域网 IP 访问',
        icon: 'network',
        snippetType: 'text',
        fields: [
          { label: '局域网 Base URL', value: lanBaseUrl },
          { label: 'API Key', value: activeKey },
        ],
        snippet: `局域网 Base URL: ${lanBaseUrl}\nAPI Key:         ${activeKey}`,
      },
      {
        id: 'python-openai',
        name: 'Python (OpenAI 官方 SDK)',
        description: '在 Python 代码中使用官方 openai 库直接调用分发大模型',
        icon: 'python',
        snippetType: 'python',
        fields: [
          { label: 'base_url', value: localBaseUrl },
          { label: 'api_key', value: activeKey },
        ],
        snippet: `from openai import OpenAI

client = OpenAI(
    base_url="${localBaseUrl}",
    api_key="${activeKey}"
)

completion = client.chat.completions.create(
    model="gpt-4o",  # 可在 HAP 别名规则中映射至本地 Qwen2.5 或云端
    messages=[
        {"role": "system", "content": "你是由 HAP API 分发网关驱动的智能助手。"},
        {"role": "user", "content": "你好，请自我介绍！"}
    ],
    stream=True
)

for chunk in completion:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
`,
      },
      {
        id: 'curl',
        name: 'cURL 终端快速测试',
        description: '在终端一键验证网关连通性与模型推理',
        icon: 'terminal',
        snippetType: 'shell',
        fields: [],
        snippet: `curl ${localBaseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${activeKey}" \\
  -d '{
    "model": "gpt-4o",
    "messages": [
      {"role": "user", "content": "Hello HAP Gateway!"}
    ],
    "stream": false
  }'`,
      },
    ];
  }
}

// 单例实例供 Web Server 和 GUI Service 共享
let sharedGatewayService: GatewayService | null = null;

export function getGatewayService(customStorePath?: string, configPath?: string): GatewayService {
  if (!sharedGatewayService) {
    sharedGatewayService = new GatewayService(customStorePath, configPath);
  }
  return sharedGatewayService;
}
