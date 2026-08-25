/**
 * agent 子命令（FR-AGT-001 ~ FR-AGT-007）。
 *
 * 智能体是「模型 + 提示 + 工具集 + 工作目录」的声明式组合，
 * 这里的每个选项都直接落到配置文件里，因此 create 之后无需重启即可被
 * hap serve 的下一次 reload 读到。写操作统一走 ConfigWriter，
 * 只有需要校验模型引用是否真实存在时才拉起 AgentRegistry。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { Command } from 'commander';
import { isCancel, cancel, intro, outro, confirm, multiselect, select, text as promptText } from '@clack/prompts';

import { CliContext, emit, fail, type GlobalOptions } from './context.js';
import { orDash, renderPairs, renderTable, yesNo } from './render.js';
import { AGENT_TEMPLATES, BUILTIN_TOOL_NAMES, type AgentPatch } from '../config/index.js';

/** 工具集档位取值，与 schema 的 toolSelectionSchema.profile 保持一致。 */
const TOOL_PROFILES = ['minimal', 'standard', 'coding', 'research', 'full'] as const;

/** 协议名取值，与 domain 的 ProtocolName 保持一致。 */
const PROTOCOLS = ['openai-tools', 'deepseek', 'anthropic', 'hermes-native'] as const;

export function registerAgentCommands(root: Command, globals: () => GlobalOptions): void {
  const agent = root.command('agent').description('管理智能体');

  agent
    .command('list')
    .description('列出全部智能体')
    .action(() => {
      const ctx = new CliContext(globals());
      const resolver = ctx.resolver();
      const defaultId = resolver.resolveDefaultAgentId();
      const agents = resolver.resolveAllAgents();
      const rows = agents.map((item) => [
        item.id + (item.id === defaultId ? ' *' : ''),
        item.identity.emoji + ' ' + item.name,
        item.model.primary,
        item.model.fallbacks.length === 0 ? '-' : String(item.model.fallbacks.length),
        item.tools.profile,
        item.runtime.mode,
      ]);
      emit(
        ctx,
        renderTable(['id', '名称', '主模型', '备选数', '工具档位', '模式'], rows) + '\n* 标记默认智能体',
        agents,
      );
    });

  agent
    .command('templates')
    .description('列出内置智能体模板')
    .action(() => {
      const ctx = new CliContext(globals());
      const rows = Object.entries(AGENT_TEMPLATES).map(([id, entry]) => [
        id,
        (entry.identity?.emoji ?? '') + ' ' + (entry.name ?? id),
        describeBinding(entry.model),
        entry.tools?.profile ?? '-',
        entry.description ?? '-',
      ]);
      emit(ctx, renderTable(['模板', '名称', '主模型', '工具档位', '说明'], rows), AGENT_TEMPLATES);
    });

  agent
    .command('show <id>')
    .description('查看单个智能体的解析结果')
    .action((id: string) => {
      const ctx = new CliContext(globals());
      const resolver = ctx.resolver();
      const resolved = resolver.resolveAllAgents().find((item) => item.id === id);
      if (resolved === undefined) {
        fail('智能体 ' + id + ' 不存在，可用：' + resolver.listAgentIds().join(' | '));
      }
      const pairs: Array<readonly [string, string]> = [
        ['id', resolved.id],
        ['名称', resolved.identity.emoji + ' ' + resolved.name],
        ['说明', orDash(resolved.description)],
        ['主模型', resolved.model.primary],
        ['备选模型', resolved.model.fallbacks.length === 0 ? '-' : resolved.model.fallbacks.join(', ')],
        ['辅助模型', orDash(resolved.utilityModel)],
        ['协议', resolved.protocol ?? '（按服务商推断）'],
        ['能力标签', resolved.capabilities.length === 0 ? '-' : resolved.capabilities.join(', ')],
        ['工具档位', resolved.tools.profile],
        ['allow', resolved.tools.allow.length === 0 ? '（档位全集）' : resolved.tools.allow.join(', ')],
        ['deny', resolved.tools.deny.length === 0 ? '-' : resolved.tools.deny.join(', ')],
        ['子智能体', resolved.subagentAllow.length === 0 ? '（禁止派生）' : resolved.subagentAllow.join(', ')],
        ['运行模式', resolved.runtime.mode + '（空闲 ' + String(resolved.runtime.idleTimeoutMs) + 'ms）'],
        ['工作目录', resolved.workspace],
        ['状态目录', resolved.agentDir],
        ['提示文件', orDash(resolved.systemPromptFile)],
        ['展示思考', yesNo(resolved.reasoningVisible)],
        ['模型参数', Object.keys(resolved.params).length === 0 ? '-' : JSON.stringify(resolved.params)],
      ];
      emit(ctx, renderPairs(pairs), resolved);
    });

  agent
    .command('create <id>')
    .description('新增智能体（不带任何选项时进入交互问答）')
    .option('--template <name>', '基于内置模板创建：' + Object.keys(AGENT_TEMPLATES).join(' | '))
    .option('--name <text>', '显示名称')
    .option('--description <text>', '职责说明')
    .option('--model <ref>', '主模型引用，如 deepseek/deepseek-chat 或模型别名')
    .option('--fallback <ref...>', '备选模型，可重复；按顺序降级', collectList, [])
    .option('--utility-model <ref>', '辅助模型（标题、压缩、意图分类）')
    .option('--protocol <name>', '强制协议：' + PROTOCOLS.join(' | '))
    .option('--tools-profile <name>', '工具档位：' + TOOL_PROFILES.join(' | '))
    .option('--allow-tool <name...>', '仅允许这些工具，可重复', collectList, [])
    .option('--deny-tool <name...>', '禁用这些工具，可重复；优先于 allow', collectList, [])
    .option('--subagent <id...>', '允许派生的子智能体 id，可重复', collectList, [])
    .option('--workspace <path>', '文件工作目录')
    .option('--mode <mode>', '运行模式：oneshot | persistent')
    .option('--emoji <char>', '通道消息前缀图标')
    .option('--prompt <text>', '职责段提示内容，写入 agent_dir/system.md 并登记 system_prompt_file')
    .option('--prompt-file <path>', '职责段提示文件路径')
    .option('--reasoning-visible', '向用户展示模型思考内容')
    .option('--param <k=v...>', '模型级默认参数，如 temperature=0.2', collectPairs, {})
    .action(async (id: string, options: AgentCreateOptions) => {
      const ctx = new CliContext(globals());
      const interactive = isInteractive(options);
      const built = interactive ? await askAgent(id, ctx) : buildAgentPatch(options);
      if (built === undefined) {
        return;
      }
      const { patch, template, promptBody } = built;
      const registry = ctx.orchestrator().agents;
      try {
        const result = registry.createAgent(id, patch, template);
        if (promptBody !== undefined) {
          const target = writePrompt(result.agent.agentDir, promptBody);
          registry.updateAgent(id, { system_prompt_file: target });
        }
        emit(
          ctx,
          '✓ 已创建智能体 ' + id + '（' + ctx.configPath + '）\n' + renderPairs(summarize(result.agent)),
          result,
        );
      } finally {
        await ctx.close();
      }
    });

  agent
    .command('update <id>')
    .description('修改已有智能体，仅覆盖显式给出的字段')
    .option('--name <text>', '显示名称')
    .option('--description <text>', '职责说明')
    .option('--model <ref>', '主模型引用')
    .option('--fallback <ref...>', '备选模型，可重复；给出即整体替换', collectList, [])
    .option('--utility-model <ref>', '辅助模型')
    .option('--protocol <name>', '强制协议')
    .option('--tools-profile <name>', '工具档位')
    .option('--allow-tool <name...>', 'allow 名单，给出即整体替换', collectList, [])
    .option('--deny-tool <name...>', 'deny 名单，给出即整体替换', collectList, [])
    .option('--subagent <id...>', '允许派生的子智能体，给出即整体替换', collectList, [])
    .option('--workspace <path>', '文件工作目录')
    .option('--mode <mode>', '运行模式：oneshot | persistent')
    .option('--emoji <char>', '通道消息前缀图标')
    .option('--prompt-file <path>', '职责段提示文件路径')
    .option('--reasoning-visible <bool>', '是否展示思考内容：true | false')
    .option('--param <k=v...>', '模型级默认参数', collectPairs, {})
    .action(async (id: string, options: AgentUpdateOptions) => {
      const ctx = new CliContext(globals());
      const patch = buildAgentPatch(options).patch;
      if (Object.keys(patch).length === 0) {
        fail('没有给出任何要修改的字段');
      }
      const registry = ctx.orchestrator().agents;
      try {
        const result = registry.updateAgent(id, patch);
        emit(ctx, '✓ 已更新智能体 ' + id + '\n' + renderPairs(summarize(result.agent)), result);
      } finally {
        await ctx.close();
      }
    });

  agent
    .command('remove <id>')
    .description('删除智能体条目（不删除其工作目录与会话库）')
    .action((id: string) => {
      const ctx = new CliContext(globals());
      const result = ctx.writer().removeAgent(id);
      emit(ctx, '✓ 已删除智能体 ' + id + '。其工作目录与会话库仍在磁盘上，可手动清理。', result);
    });
}

interface AgentCreateOptions extends AgentUpdateOptions {
  template?: string;
  prompt?: string;
}

interface AgentUpdateOptions {
  name?: string;
  description?: string;
  model?: string;
  fallback: string[];
  utilityModel?: string;
  protocol?: string;
  toolsProfile?: string;
  allowTool: string[];
  denyTool: string[];
  subagent: string[];
  workspace?: string;
  mode?: string;
  emoji?: string;
  promptFile?: string;
  reasoningVisible?: boolean | string;
  param: Record<string, string>;
}

interface BuiltAgent {
  patch: AgentPatch;
  template?: string;
  promptBody?: string;
}

/** 判断是否需要进入交互问答：所有实质性选项都缺省时才问。 */
function isInteractive(options: AgentCreateOptions): boolean {
  return (
    options.template === undefined &&
    options.model === undefined &&
    options.name === undefined &&
    options.toolsProfile === undefined &&
    options.promptFile === undefined &&
    options.prompt === undefined
  );
}

/** 命令行选项 → 配置补丁。空数组与 undefined 一律不落配置，避免覆盖模板值。 */
function buildAgentPatch(options: AgentCreateOptions | AgentUpdateOptions): BuiltAgent {
  const patch: AgentPatch = {};
  if (options.name !== undefined) {
    patch.name = options.name;
  }
  if (options.description !== undefined) {
    patch.description = options.description;
  }
  if (options.model !== undefined) {
    patch.model = options.fallback.length === 0 ? options.model : { primary: options.model, fallbacks: options.fallback };
  }
  if (options.utilityModel !== undefined) {
    patch.utility_model = options.utilityModel;
  }
  if (options.protocol !== undefined) {
    patch.protocol = assertProtocol(options.protocol);
  }
  const tools = buildToolSelection(options);
  if (tools !== undefined) {
    patch.tools = tools;
  }
  if (options.subagent.length > 0) {
    patch.subagents = { allow: options.subagent };
  }
  if (options.workspace !== undefined) {
    patch.workspace = options.workspace;
  }
  if (options.mode !== undefined) {
    patch.runtime = { mode: assertMode(options.mode) };
  }
  if (options.emoji !== undefined) {
    patch.identity = { emoji: options.emoji };
  }
  if (options.promptFile !== undefined) {
    patch.system_prompt_file = options.promptFile;
  }
  if (options.reasoningVisible !== undefined) {
    patch.reasoning_visible = options.reasoningVisible === true || options.reasoningVisible === 'true';
  }
  if (Object.keys(options.param).length > 0) {
    patch.params = coerceParams(options.param);
  }
  const built: BuiltAgent = { patch };
  const template = (options as AgentCreateOptions).template;
  if (template !== undefined) {
    if (AGENT_TEMPLATES[template] === undefined) {
      fail('未知模板 ' + template + '，可用：' + Object.keys(AGENT_TEMPLATES).join(' | '));
    }
    built.template = template;
  }
  const prompt = (options as AgentCreateOptions).prompt;
  if (prompt !== undefined) {
    built.promptBody = prompt;
  }
  return built;
}

function buildToolSelection(options: AgentUpdateOptions): AgentPatch['tools'] {
  const selection: NonNullable<AgentPatch['tools']> = {};
  if (options.toolsProfile !== undefined) {
    selection.profile = assertProfile(options.toolsProfile);
  }
  if (options.allowTool.length > 0) {
    selection.allow = options.allowTool.map(assertToolName);
  }
  if (options.denyTool.length > 0) {
    selection.deny = options.denyTool.map(assertToolName);
  }
  return Object.keys(selection).length === 0 ? undefined : selection;
}

/**
 * 交互式创建智能体。
 *
 * 模型候选来自当前配置的模型目录，因此 provider add → model add → agent create
 * 是天然的顺序；目录为空时直接报错而不是让用户手输一个注定解析失败的引用。
 */
async function askAgent(id: string, ctx: CliContext): Promise<BuiltAgent | undefined> {
  const resolver = ctx.resolver();
  const models = [...resolver.resolveModels().values()];
  if (models.length === 0) {
    fail('模型目录为空，请先执行 hap model add <别名> --provider <服务商> --model <模型名>');
  }
  intro('新增智能体 ' + id);

  const templateChoice = await select({
    message: '基于哪个模板',
    options: [
      { value: '', label: '不用模板（从空白开始）' },
      ...Object.entries(AGENT_TEMPLATES).map(([key, entry]) => ({
        value: key,
        label: key + ' — ' + (entry.description ?? ''),
      })),
    ],
  });
  if (isCancel(templateChoice)) {
    cancel('已取消');
    return undefined;
  }
  const template = String(templateChoice);

  const name = await promptText({
    message: '显示名称',
    initialValue: template === '' ? id : (AGENT_TEMPLATES[template]?.name ?? id),
  });
  if (isCancel(name)) {
    cancel('已取消');
    return undefined;
  }

  const modelOptions = models.map((item) => ({ value: item.alias, label: item.alias + ' → ' + item.fullName }));
  const primary = await select({ message: '主模型', options: modelOptions });
  if (isCancel(primary)) {
    cancel('已取消');
    return undefined;
  }

  const fallbacks = await multiselect({
    message: '备选模型（按顺序降级，可不选）',
    options: modelOptions.filter((item) => item.value !== String(primary)),
    required: false,
  });
  if (isCancel(fallbacks)) {
    cancel('已取消');
    return undefined;
  }

  const profile = await select({
    message: '工具档位',
    options: TOOL_PROFILES.map((value) => ({ value, label: value })),
    initialValue: (AGENT_TEMPLATES[template]?.tools?.profile ?? 'standard') as string,
  });
  if (isCancel(profile)) {
    cancel('已取消');
    return undefined;
  }

  const mode = await select({
    message: '运行模式',
    options: [
      { value: 'persistent', label: 'persistent — 跨消息保留会话历史' },
      { value: 'oneshot', label: 'oneshot — 每条消息独立上下文' },
    ],
  });
  if (isCancel(mode)) {
    cancel('已取消');
    return undefined;
  }

  const prompt = await promptText({
    message: '职责段提示（留空则用模板或全局默认）',
    placeholder: '你负责……',
    defaultValue: '',
  });
  if (isCancel(prompt)) {
    cancel('已取消');
    return undefined;
  }

  const showReasoning = await confirm({ message: '在通道里展示模型思考内容？', initialValue: false });
  if (isCancel(showReasoning)) {
    cancel('已取消');
    return undefined;
  }

  const chosenFallbacks = (fallbacks as string[]).filter((item) => item.length > 0);
  const patch: AgentPatch = {
    name: String(name),
    model: chosenFallbacks.length === 0 ? String(primary) : { primary: String(primary), fallbacks: chosenFallbacks },
    tools: { profile: assertProfile(String(profile)) },
    runtime: { mode: assertMode(String(mode)) },
    reasoning_visible: showReasoning === true,
  };
  const built: BuiltAgent = { patch };
  if (template !== '') {
    built.template = template;
  }
  const promptBody = String(prompt).trim();
  if (promptBody.length > 0) {
    built.promptBody = promptBody;
  }
  outro('智能体配置已就绪');
  return built;
}

/** 把职责段提示写进智能体状态目录，返回绝对路径供配置登记。 */
function writePrompt(agentDir: string, body: string): string {
  const target = isAbsolute(agentDir) ? resolve(agentDir, 'system.md') : resolve(process.cwd(), agentDir, 'system.md');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body.endsWith('\n') ? body : body + '\n', 'utf8');
  return target;
}

function summarize(agent: {
  id: string;
  name: string;
  model: { primary: string; fallbacks: string[] };
  tools: { profile: string; allow: string[]; deny: string[] };
  runtime: { mode: string };
  workspace: string;
  agentDir: string;
}): Array<readonly [string, string]> {
  return [
    ['id', agent.id],
    ['名称', agent.name],
    ['主模型', agent.model.primary],
    ['备选模型', agent.model.fallbacks.length === 0 ? '-' : agent.model.fallbacks.join(', ')],
    ['工具档位', agent.tools.profile],
    ['deny', agent.tools.deny.length === 0 ? '-' : agent.tools.deny.join(', ')],
    ['运行模式', agent.runtime.mode],
    ['工作目录', agent.workspace],
    ['状态目录', agent.agentDir],
  ];
}

function describeBinding(binding: unknown): string {
  if (typeof binding === 'string') {
    return binding;
  }
  if (binding !== null && typeof binding === 'object' && 'primary' in binding) {
    return String((binding as { primary: unknown }).primary);
  }
  return '-';
}

function coerceParams(raw: Record<string, string>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === 'true' || value === 'false') {
      params[key] = value === 'true';
      continue;
    }
    const numeric = Number(value);
    params[key] = Number.isFinite(numeric) && value.trim().length > 0 ? numeric : value;
  }
  return params;
}

function collectList(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectPairs(value: string, previous: Record<string, string>): Record<string, string> {
  const index = value.indexOf('=');
  if (index <= 0) {
    fail('参数格式应为 key=value，实际收到：' + value);
  }
  return { ...previous, [value.slice(0, index)]: value.slice(index + 1) };
}

function assertProfile(value: string): (typeof TOOL_PROFILES)[number] {
  if ((TOOL_PROFILES as readonly string[]).includes(value)) {
    return value as (typeof TOOL_PROFILES)[number];
  }
  fail('未知工具档位 ' + value + '，可选：' + TOOL_PROFILES.join(' | '));
}

function assertProtocol(value: string): (typeof PROTOCOLS)[number] {
  if ((PROTOCOLS as readonly string[]).includes(value)) {
    return value as (typeof PROTOCOLS)[number];
  }
  fail('未知协议 ' + value + '，可选：' + PROTOCOLS.join(' | '));
}

function assertMode(value: string): 'oneshot' | 'persistent' {
  if (value === 'oneshot' || value === 'persistent') {
    return value;
  }
  fail('未知运行模式 ' + value + '，可选：oneshot | persistent');
}

function assertToolName(value: string): string {
  if ((BUILTIN_TOOL_NAMES as readonly string[]).includes(value)) {
    return value;
  }
  // MCP 工具名形如 server__tool，无法在此校验存在性，放行并交由运行时裁剪。
  if (value.includes('__')) {
    return value;
  }
  fail('未知工具 ' + value + '，内置工具：' + BUILTIN_TOOL_NAMES.join(' | ') + '；MCP 工具请写 server__tool');
}
