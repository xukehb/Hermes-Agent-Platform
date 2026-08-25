/**
 * 智能体路由（FR-ROUTE-003）与模型链解析（FR-ROUTE-001/002）。
 *
 * 四级优先级：显式指定（@名字 或 /agent 命令）> 通道绑定 > 能力标签匹配 > 全局默认。
 * 能力标签匹配刻意做得简单：把指令按关键词映射到标签，再取交集最大者。
 * 不引入分类模型，因为一次路由判断的成本必须远低于任务本身，
 * 且误判的代价（换个智能体）远小于误判带来的延迟与费用。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import type { ProtocolName, RouteLayer } from '../domain/index.js';
import { ConfigError } from '../domain/index.js';
import type { ConfigResolver, ResolvedAgent, ResolvedModel, ResolvedProvider } from '../config/index.js';
import { detectProtocol } from '../protocol/index.js';

/** 路由结果。 */
export interface RouteDecision {
  agentId: string;
  layer: RouteLayer;
  /** 命中依据的可读描述，写入 trace */
  detail: string;
  /** 剥掉 @提及 与 /agent 前缀后的纯指令正文 */
  input: string;
}

/** 路由输入。 */
export interface RouteInput {
  text: string;
  /** 通道绑定的默认智能体（FR-ROUTE-003 第二级） */
  channelDefaultAgent?: string | undefined;
  /** 调用方显式指定（CLI --agent），优先级等同 @提及 */
  explicitAgent?: string | undefined;
  /** 额外的提及模式，来自 channels.telegram.mention_patterns */
  mentionPatterns?: readonly string[];
}

/** 能力标签的关键词表。键为标签名，值为触发该标签的中英文关键词。 */
const CAPABILITY_KEYWORDS: Record<string, readonly string[]> = {
  coding: ['代码', '函数', '重构', '编译', '报错', '实现', '修复', 'bug', 'code', 'refactor', 'compile', 'implement', 'fix'],
  debugging: ['调试', '排查', '崩溃', '堆栈', '复现', 'debug', 'stack', 'crash', 'trace'],
  testing: ['测试', '用例', '覆盖率', '断言', 'test', 'spec', 'coverage'],
  review: ['评审', '审查', '检视', '代码质量', 'review', 'audit'],
  research: ['调研', '查一下', '搜索', '资料', '对比', '综述', 'research', 'search', 'compare', 'survey'],
  writing: ['写一篇', '文案', '文档', '润色', '翻译', '总结', 'write', 'doc', 'polish', 'translate', 'summary'],
  analysis: ['分析', '统计', '数据', '指标', 'analyze', 'analysis', 'metric', 'data'],
  ops: ['部署', '运维', '服务器', '容器', '日志', '监控', 'deploy', 'ops', 'docker', 'k8s', 'log', 'monitor'],
  vision: ['图片', '截图', '图像', '看图', 'image', 'screenshot', 'ocr', 'vision'],
  planning: ['规划', '计划', '拆分', '排期', 'plan', 'roadmap', 'breakdown'],
};

/** 从指令文本推断意图标签集合。 */
export function inferIntentTags(text: string): string[] {
  const lower = text.toLowerCase();
  const tags: string[] = [];
  for (const [tag, keywords] of Object.entries(CAPABILITY_KEYWORDS)) {
    if (keywords.some((keyword) => lower.includes(keyword))) tags.push(tag);
  }
  return tags;
}

/** 默认提及模式：@名字 与 /agent 名字。 */
const DEFAULT_MENTION_PATTERNS: readonly string[] = ['^@(?<agent>[\\w-]+)\\s*', '^/agent\\s+(?<agent>[\\w-]+)\\s*'];

/** 提及解析结果。 */
interface MentionMatch {
  agent: string;
  rest: string;
  pattern: string;
}

/** 按模式集合尝试提取开头的智能体提及。命名捕获组 agent 缺省时取第 1 组。 */
export function parseMention(text: string, patterns: readonly string[] = DEFAULT_MENTION_PATTERNS): MentionMatch | undefined {
  for (const pattern of patterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'u');
    } catch {
      // 配置里写坏的正则不应让整条消息无法路由，跳过该模式
      continue;
    }
    const match = regex.exec(text);
    if (match === null) continue;
    const named = match.groups?.agent;
    const captured = named ?? match[1];
    if (captured === undefined || captured === '') continue;
    return { agent: captured, rest: text.slice(match[0].length).trimStart(), pattern };
  }
  return undefined;
}

export class AgentRouter {
  private readonly resolver: ConfigResolver;

  constructor(resolver: ConfigResolver) {
    this.resolver = resolver;
  }

  /** 已声明的智能体 id。 */
  get agentIds(): string[] {
    return this.resolver.listAgentIds();
  }

  /**
   * 解析目标智能体。
   *
   * 显式指定了不存在的 id 时直接报错而不静默回退：用户明确说了 @foo，
   * 悄悄换成默认智能体去执行会造成更难察觉的错误结果。
   */
  route(input: RouteInput): RouteDecision {
    const known = new Set(this.agentIds);

    if (input.explicitAgent !== undefined && input.explicitAgent !== '') {
      this.assertKnown(input.explicitAgent, known);
      return { agentId: input.explicitAgent, layer: 'explicit', detail: '调用方显式指定', input: input.text };
    }

    const patterns = input.mentionPatterns !== undefined && input.mentionPatterns.length > 0
      ? [...input.mentionPatterns, ...DEFAULT_MENTION_PATTERNS]
      : DEFAULT_MENTION_PATTERNS;
    const mention = parseMention(input.text, patterns);
    if (mention !== undefined) {
      this.assertKnown(mention.agent, known);
      return {
        agentId: mention.agent,
        layer: 'explicit',
        detail: '消息提及 ' + mention.pattern,
        input: mention.rest,
      };
    }

    if (input.channelDefaultAgent !== undefined && known.has(input.channelDefaultAgent)) {
      return {
        agentId: input.channelDefaultAgent,
        layer: 'channel-binding',
        detail: '通道绑定默认智能体',
        input: input.text,
      };
    }

    const byCapability = this.matchByCapability(input.text);
    if (byCapability !== undefined) return { ...byCapability, input: input.text };

    return {
      agentId: this.resolver.resolveDefaultAgentId(),
      layer: 'global-default',
      detail: '全局默认智能体',
      input: input.text,
    };
  }

  /** 能力标签交集最大者胜出；并列时取 id 字典序最小者，保证同一指令路由稳定。 */
  private matchByCapability(text: string): Omit<RouteDecision, 'input'> | undefined {
    const tags = inferIntentTags(text);
    if (tags.length === 0) return undefined;

    let best: { agentId: string; hits: string[] } | undefined;
    for (const agentId of [...this.agentIds].sort((left, right) => left.localeCompare(right))) {
      let capabilities: readonly string[];
      try {
        capabilities = this.resolver.resolveAgent(agentId).capabilities;
      } catch {
        // 单个智能体配置有问题不应阻断路由，交由后续实例化阶段报错
        continue;
      }
      const hits = tags.filter((tag) => capabilities.includes(tag));
      if (hits.length === 0) continue;
      if (best === undefined || hits.length > best.hits.length) best = { agentId, hits };
    }
    if (best === undefined) return undefined;
    return {
      agentId: best.agentId,
      layer: 'capability',
      detail: '意图标签 ' + tags.join('/') + ' 命中能力 ' + best.hits.join('/'),
    };
  }

  private assertKnown(agentId: string, known: ReadonlySet<string>): void {
    if (known.has(agentId)) return;
    const list = [...known].sort((left, right) => left.localeCompare(right)).join('、');
    throw new ConfigError('AGENT_NOT_FOUND', '智能体 ' + agentId + ' 未配置。已配置：' + (list === '' ? '（无）' : list), {
      agentId,
    });
  }
}

/** 一个候选模型的完整解析结果，供循环直接发请求。 */
export interface ModelPlan {
  /** provider/model 全名 */
  fullName: string;
  providerId: string;
  /** 厂商侧模型标识 */
  model: string;
  provider: ResolvedProvider;
  /** 目录条目；未登记的模型为 undefined（拿不到 context_window） */
  entry: ResolvedModel | undefined;
  protocol: ProtocolName;
  /** 协议命中层级，写入 trace */
  protocolSource: ReturnType<typeof detectProtocol>['source'];
  /** 模型级 params 与智能体级 params 合并后的结果，智能体级优先 */
  params: Record<string, unknown>;
  /** 输出上限：模型 max_output_tokens > 提供商 max_tokens_default */
  maxTokens: number;
  /** 上下文窗口；未登记时给保守默认值以便压缩判断仍可工作 */
  contextWindow: number;
}

/** 未登记模型的上下文窗口保守估计。宁可提前压缩，也不要撞上下文上限。 */
const FALLBACK_CONTEXT_WINDOW = 32000;

/** 把一个模型引用解析为可执行计划。 */
export function planModel(
  resolver: ConfigResolver,
  agent: ResolvedAgent,
  ref: string,
): ModelPlan {
  const entry = resolver.findModel(ref);
  const fullName = entry?.fullName ?? resolver.normalizeModelRef(ref);
  const slash = fullName.indexOf('/');
  if (slash <= 0 || slash === fullName.length - 1) {
    throw new ConfigError('MODEL_NOT_FOUND', '模型引用 ' + ref + ' 无法解析为 provider/model 形式', { ref });
  }
  const providerId = entry?.providerId ?? fullName.slice(0, slash);
  const model = entry?.model ?? fullName.slice(slash + 1);
  const provider = resolver.resolveProvider(providerId);

  const detection = detectProtocol({
    agentProtocol: agent.protocol,
    modelProtocol: entry?.protocol,
    providerDefault: provider.defaultProtocol,
    model,
  });

  return {
    fullName: providerId + '/' + model,
    providerId,
    model,
    provider,
    entry,
    protocol: detection.protocol,
    protocolSource: detection.source,
    params: { ...(entry?.params ?? {}), ...agent.params },
    maxTokens: entry?.maxOutputTokens ?? provider.maxTokensDefault,
    contextWindow: entry?.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
  };
}

/** 解析智能体的完整候选链：primary followed by fallbacks（FR-ROUTE-001/004）。 */
export function planModelChain(resolver: ConfigResolver, agent: ResolvedAgent): ModelPlan[] {
  const refs = [agent.model.primary, ...agent.model.fallbacks];
  const plans: ModelPlan[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const plan = planModel(resolver, agent, ref);
    if (seen.has(plan.fullName)) continue;
    seen.add(plan.fullName);
    plans.push(plan);
  }
  if (plans.length === 0) {
    throw new ConfigError('MODEL_NOT_FOUND', '智能体 ' + agent.id + ' 未绑定任何可用模型', { agentId: agent.id });
  }
  return plans;
}

/** 解析辅助模型（FR-ROUTE-002）：未声明时复用 primary。 */
export function planUtilityModel(resolver: ConfigResolver, agent: ResolvedAgent): ModelPlan {
  return planModel(resolver, agent, agent.utilityModel ?? agent.model.primary);
}
