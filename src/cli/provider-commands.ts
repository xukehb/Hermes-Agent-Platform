/**
 * provider 子命令（FR-CFG-008、FR-PROV-*）。
 *
 * 这是「像 ocx 一样运行时加服务商」的落地点：
 * hap provider add <id> --preset deepseek 一行搞定内置预置；
 * 不带 --preset 时进入交互问答，逐项确认 base_url / wire_api / 协议。
 * 写入统一走 ConfigWriter（保留注释与格式），不手工拼 TOML。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { Command } from 'commander';
import { isCancel, cancel, intro, outro, select, text as promptText, confirm } from '@clack/prompts';

import { CliContext, emit, fail, type GlobalOptions } from './context.js';
import { orDash, renderPairs, renderTable, yesNo } from './render.js';
import { BUILTIN_PROVIDERS, type ProviderPatch } from '../config/index.js';
import type { WireApi } from '../domain/index.js';
import { ProviderRegistry } from '../providers/index.js';
import { describeError } from '../channels/index.js';

/** 支持的线制取值，用于交互选择与参数校验。 */
const WIRE_APIS: WireApi[] = ['chat', 'responses', 'anthropic-messages'];

/** 注册 provider 命令组。 */
export function registerProviderCommands(root: Command, globals: () => GlobalOptions): void {
  const provider = root.command('provider').description('管理模型服务商');

  provider
    .command('list')
    .description('列出已配置的服务商')
    .action(() => {
      const ctx = new CliContext(globals());
      const resolver = ctx.resolver();
      const providers = resolver.resolveProviders();
      const referenced = resolver.referencedProviderIds();
      const registry = new ProviderRegistry(providers, { env: process.env });
      const rows = [...providers.values()].map((item) => [
        item.id,
        item.baseUrl,
        item.wireApi,
        item.defaultProtocol,
        orDash(item.envKey),
        yesNo(registry.hasCredential(item)),
        yesNo(referenced.has(item.id)),
      ]);
      emit(
        ctx,
        renderTable(['ID', 'BASE URL', '线制', '默认协议', '环境变量', '凭据', '被引用'], rows),
        [...providers.values()],
      );
    });

  provider
    .command('presets')
    .description('列出内置服务商预置')
    .action(() => {
      const ctx = new CliContext(globals());
      const rows = Object.entries(BUILTIN_PROVIDERS).map(([id, preset]) => [
        id,
        orDash(preset.base_url),
        orDash(preset.wire_api),
        orDash(preset.default_protocol),
        orDash(preset.env_key),
      ]);
      emit(ctx, renderTable(['预置', 'BASE URL', '线制', '默认协议', '环境变量'], rows), BUILTIN_PROVIDERS);
    });

  provider
    .command('add <id>')
    .description('新增或更新服务商（不带参数时进入交互问答）')
    .option('--preset <name>', '基于内置预置创建，如 deepseek/openai/anthropic/zhipu/gemini/openrouter/nous/ollama')
    .option('--base-url <url>', 'API 基址')
    .option('--env-key <name>', '读取凭据的环境变量名')
    .option('--wire-api <kind>', '线制：chat | responses | anthropic-messages')
    .option('--protocol <name>', '默认协议：openai-tools | deepseek | anthropic | hermes-native')
    .option('--header <k=v...>', '附加 HTTP 头，可重复', collectPairs, {})
    .option('--env-header <k=v...>', '附加 HTTP 头，值取自环境变量名，可重复', collectPairs, {})
    .option('--max-tokens-default <n>', '该服务商 max_tokens 的兜底值（Anthropic 线制必填）', (value: string) => Number.parseInt(value, 10))
    .action(async (id: string, options: ProviderAddOptions) => {
      const ctx = new CliContext(globals());
      const interactive = isInteractiveRequest(options);
      const patch = interactive ? await askProvider(id) : buildProviderPatch(options);
      if (patch === undefined) {
        return;
      }
      const writer = ctx.writer();
      const result = writer.upsertProvider(id, patch, options.preset);
      emit(
        ctx,
        '✓ 已写入服务商 ' + id + '（' + ctx.configPath + '）\n' + renderPairs(describePatch(patch, options.preset)),
        result,
      );
    });

  provider
    .command('remove <id>')
    .description('删除服务商')
    .action((id: string) => {
      const ctx = new CliContext(globals());
      const result = ctx.writer().removeProvider(id);
      emit(ctx, '✓ 已删除服务商 ' + id, result);
    });

  provider
    .command('check [id]')
    .description('检查服务商可达性与凭据（不传 id 则检查全部被引用的服务商）')
    .action(async (id: string | undefined) => {
      const ctx = new CliContext(globals());
      const resolver = ctx.resolver();
      const targets =
        id === undefined
          ? [...resolver.referencedProviderIds()]
          : [id];
      if (targets.length === 0) {
        emit(ctx, '没有被任何智能体引用的服务商。', []);
        return;
      }
      const registry = new ProviderRegistry(resolver.resolveProviders(), { env: process.env });
      const rows: string[][] = [];
      const details: Array<Record<string, unknown>> = [];
      for (const target of targets) {
        try {
          const result = await registry.client(target).check();
          rows.push([
            target,
            result.reachable ? '✓ 可达' : '✗ 失败',
            result.reachable ? String(result.models.length) + ' 个模型' : (result.error ?? '未知原因'),
            String(result.handshakeMs) + 'ms',
          ]);
          details.push({ ...result });
        } catch (error) {
          rows.push([target, '✗ 失败', describeError(error), '-']);
          details.push({ providerId: target, reachable: false, error: describeError(error) });
        }
      }
      emit(ctx, renderTable(['服务商', '状态', '详情', '耗时'], rows), details);
    });

  provider
    .command('models <id>')
    .description('拉取服务商的在线模型列表（FR-CFG-009）')
    .action(async (id: string) => {
      const ctx = new CliContext(globals());
      const registry = new ProviderRegistry(ctx.resolver().resolveProviders(), { env: process.env });
      try {
        const result = await registry.client(id).check();
        if (!result.reachable) {
          fail('服务商不可达：' + (result.error ?? '未知原因'));
        }
        const models = result.models;
        emit(
          ctx,
          models.length === 0 ? '该服务商未返回任何模型。' : models.map((model) => '· ' + model).join('\n'),
          { providerId: id, models },
        );
      } catch (error) {
        fail('拉取模型列表失败：' + describeError(error));
      }
    });
}

/** provider add 的选项。 */
interface ProviderAddOptions {
  preset?: string;
  baseUrl?: string;
  envKey?: string;
  wireApi?: string;
  protocol?: string;
  header: Record<string, string>;
  envHeader: Record<string, string>;
  maxTokensDefault?: number;
}

/** 判断是否需要进入交互问答：既没预置也没关键参数时才问。 */
function isInteractiveRequest(options: ProviderAddOptions): boolean {
  return (
    options.preset === undefined &&
    options.baseUrl === undefined &&
    options.envKey === undefined &&
    options.wireApi === undefined &&
    options.protocol === undefined
  );
}

/** 把命令行选项折成配置补丁。 */
function buildProviderPatch(options: ProviderAddOptions): ProviderPatch {
  const patch: ProviderPatch = {};
  if (options.baseUrl !== undefined) {
    patch.base_url = options.baseUrl;
  }
  if (options.envKey !== undefined) {
    patch.env_key = options.envKey;
  }
  if (options.wireApi !== undefined) {
    patch.wire_api = assertWireApi(options.wireApi);
  }
  if (options.protocol !== undefined) {
    patch.default_protocol = assertProtocol(options.protocol);
  }
  if (Object.keys(options.header).length > 0) {
    patch.http_headers = options.header;
  }
  if (Object.keys(options.envHeader).length > 0) {
    patch.env_http_headers = options.envHeader;
  }
  if (options.maxTokensDefault !== undefined && Number.isFinite(options.maxTokensDefault)) {
    patch.max_tokens_default = options.maxTokensDefault;
  }
  return patch;
}

/**
 * 交互式新增服务商。
 *
 * 问答顺序按「越通用越先问」排列：先 base_url，再线制，最后协议，
 * 因为线制决定了协议的合理取值范围（responses 只配 openai-tools 才有意义）。
 */
async function askProvider(id: string): Promise<ProviderPatch | undefined> {
  intro('新增服务商 ' + id);
  const presetChoice = await select({
    message: '选择起始预置',
    options: [
      { value: '', label: '自定义（手动填写）' },
      ...Object.keys(BUILTIN_PROVIDERS).map((key) => ({ value: key, label: key })),
    ],
  });
  if (isCancel(presetChoice)) {
    cancel('已取消');
    return undefined;
  }
  const preset = presetChoice === '' ? undefined : BUILTIN_PROVIDERS[presetChoice as string];
  const baseUrl = await promptText({
    message: 'API 基址',
    placeholder: preset?.base_url ?? 'https://api.example.com/v1',
    initialValue: preset?.base_url ?? '',
  });
  if (isCancel(baseUrl)) {
    cancel('已取消');
    return undefined;
  }
  const envKey = await promptText({
    message: '读取凭据的环境变量名（留空表示无需凭据，如本地 ollama）',
    initialValue: preset?.env_key ?? '',
  });
  if (isCancel(envKey)) {
    cancel('已取消');
    return undefined;
  }
  const wireApi = await select({
    message: '线制',
    options: WIRE_APIS.map((value) => ({ value, label: value })),
    initialValue: preset?.wire_api ?? 'chat',
  });
  if (isCancel(wireApi)) {
    cancel('已取消');
    return undefined;
  }
  const protocol = await select({
    message: '默认协议',
    options: [
      { value: 'openai-tools', label: 'openai-tools（原生 tool_calls）' },
      { value: 'deepseek', label: 'deepseek（reasoning_content + tool_calls）' },
      { value: 'anthropic', label: 'anthropic（tool_use 块）' },
      { value: 'hermes-native', label: 'hermes-native（<tool_call> 标签）' },
    ],
    initialValue: preset?.default_protocol ?? 'openai-tools',
  });
  if (isCancel(protocol)) {
    cancel('已取消');
    return undefined;
  }
  const patch: ProviderPatch = {
    base_url: String(baseUrl),
    wire_api: assertWireApi(String(wireApi)),
    default_protocol: assertProtocol(String(protocol)),
  };
  const envKeyText = String(envKey).trim();
  if (envKeyText.length > 0) {
    patch.env_key = envKeyText;
    if (process.env[envKeyText] === undefined) {
      const proceed = await confirm({
        message: '环境变量 ' + envKeyText + ' 当前未设置，仍要写入配置吗？',
        initialValue: true,
      });
      if (isCancel(proceed) || proceed !== true) {
        cancel('已取消');
        return undefined;
      }
    }
  }
  outro('配置已就绪');
  return patch;
}

/** 展示写入摘要。 */
function describePatch(patch: ProviderPatch, preset: string | undefined): Array<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [];
  if (preset !== undefined) {
    pairs.push(['preset', preset]);
  }
  for (const [key, value] of Object.entries(patch)) {
    pairs.push([key, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  }
  return pairs;
}

/** --header k=v 的收集器。 */
function collectPairs(value: string, previous: Record<string, string>): Record<string, string> {
  const index = value.indexOf('=');
  if (index <= 0) {
    fail('参数格式应为 key=value，实际收到：' + value);
  }
  return { ...previous, [value.slice(0, index)]: value.slice(index + 1) };
}

function assertWireApi(value: string): WireApi {
  if ((WIRE_APIS as string[]).includes(value)) {
    return value as WireApi;
  }
  fail('未知线制 ' + value + '，可选：' + WIRE_APIS.join(' | '));
}

function assertProtocol(value: string): 'openai-tools' | 'deepseek' | 'anthropic' | 'hermes-native' {
  const allowed = ['openai-tools', 'deepseek', 'anthropic', 'hermes-native'];
  if (allowed.includes(value)) {
    return value as 'openai-tools' | 'deepseek' | 'anthropic' | 'hermes-native';
  }
  fail('未知协议 ' + value + '，可选：' + allowed.join(' | '));
}
