/**
 * model 子命令（FR-CFG-009、FR-ROUTE-001）。
 *
 * 模型目录不是装饰性配置：上下文压缩要读 context_window，
 * Anthropic 请求要读 max_output_tokens，图片附件分流要读 vision 能力标签。
 * 因此 model add 会强制要求 provider 与真实模型名，其余项给合理缺省。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { Command } from 'commander';
import { isCancel, cancel, intro, outro, multiselect, select, text as promptText } from '@clack/prompts';

import { CliContext, emit, fail, type GlobalOptions } from './context.js';
import { orDash, renderPairs, renderTable } from './render.js';
import { BUILTIN_MODELS, type ModelPatch } from '../config/index.js';
import { ProviderRegistry } from '../providers/index.js';
import { describeError } from '../channels/index.js';

/** 能力标签取值，与 schema 的 modelCapabilitySchema 保持一致。 */
const CAPABILITIES = ['tools', 'vision', 'streaming', 'reasoning', 'longctx'] as const;

export function registerModelCommands(root: Command, globals: () => GlobalOptions): void {
  const model = root.command('model').description('管理模型目录');

  model
    .command('list')
    .description('列出模型目录')
    .option('--provider <id>', '只看某个服务商的模型')
    .action((options: { provider?: string }) => {
      const ctx = new CliContext(globals());
      const models = [...ctx.resolver().resolveModels().values()].filter(
        (item) => options.provider === undefined || item.providerId === options.provider,
      );
      const rows = models.map((item) => [
        item.alias,
        item.fullName,
        orDash(item.contextWindow),
        orDash(item.maxOutputTokens),
        item.capabilities.length === 0 ? '-' : item.capabilities.join(','),
        orDash(item.protocol),
      ]);
      emit(ctx, renderTable(['别名', '全名', '上下文', '输出上限', '能力', '协议'], rows), models);
    });

  model
    .command('presets')
    .description('列出内置模型预置')
    .action(() => {
      const ctx = new CliContext(globals());
      const rows = Object.entries(BUILTIN_MODELS).map(([alias, entry]) => [
        alias,
        entry.provider + '/' + entry.model,
        orDash(entry.context_window),
        orDash(entry.max_output_tokens),
        (entry.capabilities ?? []).join(',') || '-',
      ]);
      emit(ctx, renderTable(['别名', '全名', '上下文', '输出上限', '能力'], rows), BUILTIN_MODELS);
    });

  model
    .command('add <alias>')
    .description('新增或更新模型条目（不带参数时进入交互问答）')
    .option('--provider <id>', '所属服务商 id')
    .option('--model <name>', '服务商侧的真实模型名')
    .option('--context-window <n>', '上下文窗口 token 数', parseIntArg)
    .option('--max-output-tokens <n>', '单次输出上限 token 数', parseIntArg)
    .option('--capability <name...>', '能力标签，可重复：tools/vision/streaming/reasoning/longctx', collectList, [])
    .option('--protocol <name>', '覆盖服务商默认协议')
    .option('--param <k=v...>', '模型级默认参数，如 temperature=0.2', collectPairs, {})
    .action(async (alias: string, options: ModelAddOptions) => {
      const ctx = new CliContext(globals());
      const patch =
        options.provider === undefined && options.model === undefined
          ? await askModel(alias, ctx)
          : buildModelPatch(alias, options);
      if (patch === undefined) {
        return;
      }
      const result = ctx.writer().upsertModel(alias, patch);
      emit(
        ctx,
        '✓ 已写入模型 ' + alias + '（' + ctx.configPath + '）\n' + renderPairs(pairsOf(patch)),
        result,
      );
    });

  model
    .command('remove <alias>')
    .description('从目录中删除模型')
    .action((alias: string) => {
      const ctx = new CliContext(globals());
      const result = ctx.writer().removeModel(alias);
      emit(ctx, '✓ 已删除模型 ' + alias, result);
    });

  model
    .command('import <providerId>')
    .description('从服务商在线列表批量导入模型条目')
    .option('--filter <substring>', '只导入名字包含该子串的模型')
    .option('--context-window <n>', '为导入的模型统一设置上下文窗口', parseIntArg)
    .option('--dry-run', '只打印将要导入的条目，不写配置')
    .action(async (providerId: string, options: { filter?: string; contextWindow?: number; dryRun?: boolean }) => {
      const ctx = new CliContext(globals());
      const resolver = ctx.resolver();
      const registry = new ProviderRegistry(resolver.resolveProviders(), { env: process.env });
      let names: string[];
      try {
        const result = await registry.client(providerId).check();
        if (!result.reachable) {
          fail('服务商不可达：' + (result.error ?? '未知原因'));
        }
        names = result.models;
      } catch (error) {
        fail('拉取模型列表失败：' + describeError(error));
      }
      const filtered = names.filter(
        (name) => options.filter === undefined || name.toLowerCase().includes(options.filter.toLowerCase()),
      );
      if (filtered.length === 0) {
        emit(ctx, '没有匹配的模型。', { providerId, imported: [] });
        return;
      }
      if (options.dryRun === true) {
        emit(
          ctx,
          '将导入 ' + String(filtered.length) + ' 个模型：\n' + filtered.map((name) => '· ' + name).join('\n'),
          { providerId, models: filtered, dryRun: true },
        );
        return;
      }
      const writer = ctx.writer();
      const imported: string[] = [];
      for (const name of filtered) {
        const alias = providerId + '-' + name.replace(/[^A-Za-z0-9._-]/g, '-');
        const patch: ModelPatch = { provider: providerId, model: name };
        if (options.contextWindow !== undefined) {
          patch.context_window = options.contextWindow;
        }
        writer.upsertModel(alias, patch);
        imported.push(alias);
      }
      emit(
        ctx,
        '✓ 已导入 ' + String(imported.length) + ' 个模型条目：\n' + imported.map((item) => '· ' + item).join('\n'),
        { providerId, imported },
      );
    });
}

interface ModelAddOptions {
  provider?: string;
  model?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capability: string[];
  protocol?: string;
  param: Record<string, string>;
}

/** 命令行选项 → 配置补丁。 */
function buildModelPatch(alias: string, options: ModelAddOptions): ModelPatch {
  if (options.provider === undefined) {
    fail('缺少 --provider：模型必须归属某个服务商');
  }
  const patch: ModelPatch = {
    provider: options.provider,
    model: options.model ?? alias,
  };
  if (options.contextWindow !== undefined) {
    patch.context_window = options.contextWindow;
  }
  if (options.maxOutputTokens !== undefined) {
    patch.max_output_tokens = options.maxOutputTokens;
  }
  if (options.capability.length > 0) {
    patch.capabilities = options.capability.map(assertCapability);
  }
  if (options.protocol !== undefined) {
    patch.protocol = assertProtocol(options.protocol);
  }
  if (Object.keys(options.param).length > 0) {
    patch.params = coerceParams(options.param);
  }
  return patch;
}

/**
 * 交互式新增模型。
 *
 * 服务商列表直接从当前配置读，因此用户必须先 provider add；
 * 这个顺序约束是刻意的：模型脱离服务商没有意义。
 */
async function askModel(alias: string, ctx: CliContext): Promise<ModelPatch | undefined> {
  const providers = [...ctx.resolver().resolveProviders().keys()];
  if (providers.length === 0) {
    fail('还没有配置任何服务商，请先执行 hap provider add <id> --preset <预置>');
  }
  intro('新增模型 ' + alias);
  const provider = await select({
    message: '所属服务商',
    options: providers.map((id) => ({ value: id, label: id })),
  });
  if (isCancel(provider)) {
    cancel('已取消');
    return undefined;
  }
  const modelName = await promptText({
    message: '服务商侧的真实模型名',
    initialValue: alias,
  });
  if (isCancel(modelName)) {
    cancel('已取消');
    return undefined;
  }
  const contextWindow = await promptText({
    message: '上下文窗口（token 数，留空表示不声明）',
    initialValue: '128000',
  });
  if (isCancel(contextWindow)) {
    cancel('已取消');
    return undefined;
  }
  const maxOutput = await promptText({
    message: '单次输出上限（token 数，留空表示不声明）',
    initialValue: '8192',
  });
  if (isCancel(maxOutput)) {
    cancel('已取消');
    return undefined;
  }
  const capabilities = await multiselect({
    message: '能力标签（空格选择，回车确认）',
    options: CAPABILITIES.map((value) => ({ value, label: value })),
    initialValues: ['tools', 'streaming'],
    required: false,
  });
  if (isCancel(capabilities)) {
    cancel('已取消');
    return undefined;
  }
  const patch: ModelPatch = {
    provider: String(provider),
    model: String(modelName),
  };
  const ctxWindow = Number.parseInt(String(contextWindow), 10);
  if (Number.isFinite(ctxWindow) && ctxWindow > 0) {
    patch.context_window = ctxWindow;
  }
  const output = Number.parseInt(String(maxOutput), 10);
  if (Number.isFinite(output) && output > 0) {
    patch.max_output_tokens = output;
  }
  const caps = capabilities as string[];
  if (caps.length > 0) {
    patch.capabilities = caps.map(assertCapability);
  }
  outro('模型条目已就绪');
  return patch;
}

function pairsOf(patch: ModelPatch): Array<readonly [string, string]> {
  return Object.entries(patch).map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)] as const);
}

/** --param temperature=0.2 → { temperature: 0.2 }，数字与布尔自动转型。 */
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

function parseIntArg(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    fail('期望整数，实际收到：' + value);
  }
  return parsed;
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

function assertCapability(value: string): (typeof CAPABILITIES)[number] {
  if ((CAPABILITIES as readonly string[]).includes(value)) {
    return value as (typeof CAPABILITIES)[number];
  }
  fail('未知能力标签 ' + value + '，可选：' + CAPABILITIES.join(' | '));
}

function assertProtocol(value: string): 'openai-tools' | 'deepseek' | 'anthropic' | 'hermes-native' {
  const allowed = ['openai-tools', 'deepseek', 'anthropic', 'hermes-native'];
  if (allowed.includes(value)) {
    return value as 'openai-tools' | 'deepseek' | 'anthropic' | 'hermes-native';
  }
  fail('未知协议 ' + value + '，可选：' + allowed.join(' | '));
}
