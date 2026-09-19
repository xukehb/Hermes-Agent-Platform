import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { loadConfig } from '../../../config/index.js';
import { parseWeChatScreenViaOcr } from './ocr-parser.js';

export interface WeChatVisionLastMessage {
  sender: string;
  isFromMe: boolean;
  text: string;
  timestamp?: string | undefined;
}

export interface WeChatVisionParseResult {
  ok: boolean;
  hasWeChatWindow: boolean;
  chatTarget?: string | undefined;
  chatTargetCoords?: [number, number] | undefined;
  isGroup?: boolean | undefined;
  lastMessage?: WeChatVisionLastMessage | undefined;
  needsReply: boolean;
  summary?: string | undefined;
  rawResponse?: string | undefined;
  error?: string | undefined;
}

export interface VisionParserOptions {
  model?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  client?: OpenAI | undefined;
}

/** 从本地存储读取已保存的 API Key 凭据 */
function loadSavedCredentials(): Record<string, string> {
  const map: Record<string, string> = {};
  const candidates = [
    join(homedir(), '.hap', 'gui', 'env.json'),
    join(homedir(), '.hap', 'credentials.json'),
    join(homedir(), '.hap', 'env.json'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const text = readFileSync(p, 'utf-8');
        const json = JSON.parse(text) as Record<string, unknown>;
        for (const [k, v] of Object.entries(json)) {
          if (typeof v === 'string' && v.trim() !== '') {
            map[k] = v.trim();
          }
        }
      }
    } catch {
      // 忽略读取错误
    }
  }
  return map;
}

/** 解析适用于视觉多模态模型的配置（模型名、API Key、Base URL） */
export function resolveVisionModelConfig(options?: VisionParserOptions): {
  model: string;
  apiKey: string;
  baseUrl?: string | undefined;
} {
  const savedEnv = loadSavedCredentials();
  const getEnv = (key: string): string | undefined => process.env[key] || savedEnv[key];

  let configTree;
  try {
    configTree = loadConfig().config;
  } catch {
    configTree = undefined;
  }

  // 1. 如果 options 显式提供了完整配置
  if (options?.apiKey && options?.model) {
    return {
      model: options.model,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
    };
  }

  // 2. 查看配置中的 channels.wechat.personal.vision_model 或 options.model
  const modelKey = options?.model || configTree?.channels?.wechat?.personal?.vision_model;

  if (modelKey && configTree?.models?.[modelKey]) {
    const modelEntry = configTree.models[modelKey];
    if (modelEntry) {
      const providerEntry = configTree.model_providers?.[modelEntry.provider];
      const envKey = providerEntry?.env_key || `${modelEntry.provider.toUpperCase()}_API_KEY`;
      const key = options?.apiKey || getEnv(envKey) || getEnv('OPENAI_API_KEY');
      if (key) {
        return {
          model: modelEntry.model || modelKey,
          apiKey: key,
          baseUrl: options?.baseUrl || providerEntry?.base_url,
        };
      }
    }
  }

  // 3. 优先匹配 default_agent 的 primary 模型，或寻找带有视觉能力的多模态模型
  if (configTree?.models) {
    const candidateKeys = Object.keys(configTree.models).filter((k) =>
      !/audio|realtime|voice|tts|embedding/i.test(k)
    );

    const defaultAgent = configTree?.channels?.wechat?.default_agent;
    const rawModelConfig = defaultAgent ? configTree?.agents?.entries?.[defaultAgent]?.model : undefined;
    const agentModel = typeof rawModelConfig === 'string'
      ? rawModelConfig
      : rawModelConfig?.primary;

    const preferredKey = (agentModel && configTree.models[agentModel])
      ? agentModel
      : candidateKeys.find((k) => /gpt-5|gpt-4o|vl|vision|qwen|gemini|claude/i.test(k)) || candidateKeys[0];

    if (preferredKey && configTree.models[preferredKey]) {
      const modelEntry = configTree.models[preferredKey];
      if (modelEntry) {
        const providerEntry = configTree.model_providers?.[modelEntry.provider];
        const envKey = providerEntry?.env_key || `${modelEntry.provider.toUpperCase()}_API_KEY`;
        const key = options?.apiKey || getEnv(envKey) || getEnv('OPENAI_API_KEY');
        if (key) {
          return {
            model: modelEntry.model || preferredKey,
            apiKey: key,
            baseUrl: options?.baseUrl || providerEntry?.base_url,
          };
        }
      }
    }
  }

  // 4. 回退默认：检测环境变量
  const fallbackKey = options?.apiKey || getEnv('OPENAI_API_KEY') || getEnv('OLLAMA_API_KEY') || getEnv('DEEPSEEK_API_KEY');
  if (!fallbackKey) {
    throw new Error('未检测到可用的多模态大模型 API Key，请在设置中配置服务商凭据');
  }

  if (getEnv('OLLAMA_API_KEY')) {
    return {
      model: options?.model || 'deepseek-v4',
      apiKey: getEnv('OLLAMA_API_KEY')!,
      baseUrl: options?.baseUrl || 'https://me.xuke.uno/v1',
    };
  }

  return {
    model: options?.model || 'gpt-4o-mini',
    apiKey: fallbackKey,
    baseUrl: options?.baseUrl || undefined,
  };
}

const SYSTEM_PROMPT = `你是一个专业的微信桌面端 (WeChat Desktop) 界面视觉识别引擎（类似 SightFlow RPA 视觉大脑）。
你的任务是观察提供的桌面/微信窗口截图，精确提取当前正在进行的聊天信息。

请仔细观察聊天窗口的特征：
1. 顶部标题栏通常是当前打开会话的联系人昵称或群聊名称。
   - 若右侧主聊天区域空白，请查看左侧会话列表中置顶或带有红色未读角标/数字项（如“我”、“文件传输助手”或好友昵称）。
2. 聊天气泡区域：
   - 【左侧白色/浅灰气泡】：来自对方/群内其他好友的新消息，气泡左侧有对方头像。最新消息在左侧意味着需要我们关注并回复！
   - 【右侧绿色气泡】：我方本人已发送出的消息，气泡右侧有我方头像。如果最新消息在右侧，说明我方刚刚已回复，不需要重复回答！
   - 【用户自测模式】：如果会话是“我”或“文件传输助手”，且最新一条消息在左侧，说明是用户在用手机自测发来消息，needsReply 设为 true。
3. 请按以下严格 JSON 格式输出分析结果：
{
  "hasWeChatWindow": true,
  "chatTarget": "当前激活会话的联系人或群名称（若右侧空白则从左侧最新未读项提取）",
  "isGroup": false,
  "lastMessage": {
    "sender": "最新一条消息的发送者名字",
    "isFromMe": false,
    "text": "最新一条消息的完整文字内容",
    "timestamp": "消息附近显示的时间（若可见）"
  },
  "needsReply": true,
  "summary": "简短的一句话描述"
}

重要规则：
- 严格只输出合法的 JSON 对象，不要用 \`\`\`json 包裹，不要添加任何额外的解释文本。
- 若最新消息确为右侧绿色我方已发气泡 (isFromMe 为 true)，needsReply 必须为 false。
- 若没有打开聊天窗口或不是微信界面，hasWeChatWindow 设为 false，needsReply 设为 false。`;

/** 云端多模态大模型截屏理解 (OpenAI / Claude / Qwen / Gemini 等) */
export async function parseWeChatScreenViaVlm(
  imageInput: Buffer | string,
  options: VisionParserOptions = {}
): Promise<WeChatVisionParseResult> {
  try {
    const base64Data = typeof imageInput === 'string'
      ? imageInput.replace(/^data:image\/\w+;base64,/, '')
      : imageInput.toString('base64');

    const config = resolveVisionModelConfig(options);
    const client = options.client ?? new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl || undefined,
    });

    const response = await client.chat.completions.create({
      model: config.model,
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '请仔细观察截屏中的微信聊天界面并输出标准 JSON：',
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${base64Data}`,
                detail: 'high',
              },
            },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 600,
    });

    const raw = response.choices[0]?.message?.content?.trim() || '{}';
    let cleaned = raw;
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    const parsed = JSON.parse(cleaned) as {
      hasWeChatWindow?: boolean;
      chatTarget?: string;
      isGroup?: boolean;
      lastMessage?: {
        sender?: string;
        isFromMe?: boolean;
        text?: string;
        timestamp?: string;
      };
      needsReply?: boolean;
      summary?: string;
    };

    const hasWeChatWindow = Boolean(parsed.hasWeChatWindow);
    const isFromMe = Boolean(parsed.lastMessage?.isFromMe);
    const text = (parsed.lastMessage?.text || '').trim();
    const needsReply = Boolean(parsed.needsReply && !isFromMe && text.length > 0);

    const lastMsg: WeChatVisionLastMessage | undefined = parsed.lastMessage ? {
      sender: parsed.lastMessage.sender || parsed.chatTarget || '未知好友',
      isFromMe,
      text,
      timestamp: parsed.lastMessage.timestamp,
    } : undefined;

    return {
      ok: true,
      hasWeChatWindow,
      chatTarget: parsed.chatTarget || '',
      isGroup: Boolean(parsed.isGroup),
      lastMessage: lastMsg,
      needsReply,
      summary: parsed.summary,
      rawResponse: raw,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      hasWeChatWindow: false,
      needsReply: false,
      error: `视觉多模态分析失败: ${msg}`,
    };
  }
}

/**
 * 分析微信窗口截屏，提取当前活跃对话与最新消息
 * （在 macOS 环境下优先采用 ~50ms 零消耗、纯本地隐私原生 OCR，支持云端多模态 VLM 自动降级与切换）
 */
export async function parseWeChatScreen(
  imageInput: Buffer | string,
  options: VisionParserOptions = {}
): Promise<WeChatVisionParseResult> {
  // 1. 在 macOS 桌面环境下，若未显式指定自定义测试客户端，优先使用毫秒级本地原生 OCR
  if (process.platform === 'darwin' && !options.client) {
    try {
      const ocrResult = await parseWeChatScreenViaOcr(imageInput);
      if (ocrResult.ok && ocrResult.hasWeChatWindow) {
        return ocrResult;
      }
    } catch {
      // 降级使用云端 VLM
    }
  }

  // 2. 云端多模态大模型深度识别
  return await parseWeChatScreenViaVlm(imageInput, options);
}

