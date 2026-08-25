/**
 * 配置文件加载与校验（FR-CFG-001 / FR-CFG-004 / FR-CFG-005）。
 *
 * 职责边界：本文件只负责「把磁盘上的 TOML 变成一棵校验过的配置树」，
 * 不负责分层取值（那是 resolver.ts 的事），也不负责写回（那是 writer.ts 的事）。
 *
 * 校验分两道：
 * 1. schema 校验（zod strictObject）——未知键、类型错误、必填缺失，输出四元组；
 * 2. 交叉引用校验——模型指向的 provider、智能体指向的模型、派生白名单指向的智能体、
 *    active_profile 指向的 profile、Telegram 的 polling/webhook 互斥（FR-CHAN-016）。
 * 两道都在启动期中止，避免把错误配置带进运行时（第 6 节）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { existsSync, readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { TomlError, parse as parseToml } from 'smol-toml';
import { ZodError } from 'zod';
import { ConfigError } from '../domain/index.js';
import { BUILTIN, BUILTIN_MODELS, BUILTIN_PROVIDERS, BUILTIN_TOOL_NAMES } from './defaults.js';
import { type HapConfig, hapConfigSchema } from './schema.js';

/** 一次加载的结果快照。热重载时整体替换，进行中的任务继续持有旧快照（FR-CFG-005）。 */
export interface LoadedConfig {
  /** 配置文件绝对路径 */
  path: string;
  /** 文件是否存在；不存在时 config 为空对象，全部取内置默认值 */
  exists: boolean;
  /** 校验通过的配置树 */
  config: HapConfig;
  /** 原始文本，供 writer 判断是否需要重新读取 */
  raw: string;
  /** 加载时刻，用于热重载去重 */
  loadedAt: number;
}

/** 把开头的 ~ 展开为用户主目录，并归一化为绝对路径。 */
export function expandHome(input: string): string {
  if (input === '~') {
    return homedir();
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(homedir(), input.slice(2));
  }
  return isAbsolute(input) ? input : resolvePath(input);
}

/** 解析配置文件路径：--config 参数 > HAP_CONFIG 环境变量 > ~/.hap/config.toml（FR-CFG-001）。 */
export function resolveConfigPath(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['HAP_CONFIG'];
  const chosen = explicit ?? (fromEnv !== undefined && fromEnv !== '' ? fromEnv : BUILTIN.configPath);
  return expandHome(chosen);
}

/** 按键路径取值，用于在报错时回显「实际值」。 */
function readPath(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<PropertyKey, unknown>)[segment];
  }
  return cursor;
}

/** 把值压成单行短文本，避免报错信息里塞进整棵子树。 */
function briefValue(value: unknown, maxLength = 120): string {
  if (value === undefined) {
    return '(缺失)';
  }
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxLength ? text.slice(0, maxLength) + '…' : text;
}

/** 把 zod 的 issue 列表格式化为「文件路径 + 键路径 + 期望类型 + 实际值」四元组（FR-CFG-004）。 */
function formatIssues(error: ZodError, root: unknown, filePath: string): string {
  const lines: string[] = ['配置校验失败（' + String(error.issues.length) + ' 项）', '  文件：' + filePath];
  error.issues.forEach((issue, index) => {
    const keyPath = issue.path.length > 0 ? issue.path.map((s) => String(s)).join('.') : '(根)';
    const expected = 'expected' in issue && issue.expected !== undefined ? String(issue.expected) : issue.code;
    lines.push('  [' + String(index + 1) + '] 键路径：' + keyPath);
    if ('keys' in issue && Array.isArray(issue.keys)) {
      lines.push('      未知键：' + issue.keys.map((k) => String(k)).join(', '));
      lines.push('      期望类型：该表下不接受此键');
    } else {
      lines.push('      期望类型：' + expected);
    }
    lines.push('      实际值：' + briefValue(readPath(root, issue.path)));
    lines.push('      说明：' + issue.message);
  });
  return lines.join('\n');
}

/** 解析 TOML 文本并做 schema 校验。解析错误带上行列号，校验错误带上四元组。 */
export function parseConfigText(text: string, filePath: string): HapConfig {
  let tree: unknown;
  try {
    tree = parseToml(text);
  } catch (error) {
    if (error instanceof TomlError) {
      throw new ConfigError(
        'CONFIG_PARSE',
        'TOML 解析失败：' + filePath + ' 第 ' + String(error.line) + ' 行第 ' + String(error.column) + ' 列 —— ' + error.message,
        { path: filePath, line: error.line, column: error.column, codeblock: error.codeblock },
      );
    }
    throw new ConfigError('CONFIG_PARSE', 'TOML 解析失败：' + filePath + ' —— ' + String(error), { path: filePath });
  }
  const parsed = hapConfigSchema.safeParse(tree);
  if (!parsed.success) {
    throw new ConfigError('CONFIG_INVALID', formatIssues(parsed.error, tree, filePath), {
      path: filePath,
      issues: parsed.error.issues.map((issue) => ({
        key: issue.path.map((s) => String(s)).join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

/**
 * 判断一个模型引用能否解析。
 *
 * 预置目录（BUILTIN_MODELS / BUILTIN_PROVIDERS）与配置文件里的声明同等有效：
 * resolver 会把预置表作为基底注册，若此处只认配置文件，零配置引用 deepseek/deepseek-chat 会被误判为冲突。
 */
function isResolvableModelRef(config: HapConfig, ref: string): boolean {
  if (config.models?.[ref] !== undefined || BUILTIN_MODELS[ref] !== undefined) {
    return true;
  }
  const slash = ref.indexOf('/');
  if (slash <= 0) {
    return false;
  }
  const providerId = ref.slice(0, slash);
  return config.model_providers?.[providerId] !== undefined || BUILTIN_PROVIDERS[providerId] !== undefined;
}

/** 收集一个智能体条目声明的全部模型引用。 */
function collectAgentModelRefs(entry: { model?: unknown; utility_model?: string | undefined }): string[] {
  const refs: string[] = [];
  const binding = entry.model;
  if (typeof binding === 'string') {
    refs.push(binding);
  } else if (binding !== null && typeof binding === 'object') {
    const shaped = binding as { primary?: unknown; fallbacks?: unknown };
    if (typeof shaped.primary === 'string') {
      refs.push(shaped.primary);
    }
    if (Array.isArray(shaped.fallbacks)) {
      for (const item of shaped.fallbacks) {
        if (typeof item === 'string') {
          refs.push(item);
        }
      }
    }
  }
  if (typeof entry.utility_model === 'string') {
    refs.push(entry.utility_model);
  }
  return refs;
}

/**
 * 交叉引用校验。任一项不成立即中止启动，错误码统一为 CONFIG_CONFLICT。
 * 这些检查无法交给 zod：它们依赖表与表之间的相互指向。
 */
export function validateCrossReferences(config: HapConfig, filePath: string): void {
  const problems: string[] = [];
  const providers = config.model_providers ?? {};
  const models = config.models ?? {};
  const entries = config.agents?.entries ?? {};
  const agentIds = new Set(Object.keys(entries));
  const knownTools = new Set<string>(BUILTIN_TOOL_NAMES);

  if (config.active_profile !== undefined && config.profiles?.[config.active_profile] === undefined) {
    problems.push('active_profile = "' + config.active_profile + '" 未在 [profiles] 下声明');
  }

  for (const [alias, entry] of Object.entries(models)) {
    if (providers[entry.provider] === undefined && BUILTIN_PROVIDERS[entry.provider] === undefined) {
      problems.push('models.' + alias + '.provider = "' + entry.provider + '" 未在 [model_providers] 下声明');
    }
  }

  const globalRefs: Array<[string, string | undefined]> = [
    ['default_model', config.default_model],
    ['agents.defaults.utility_model', config.agents?.defaults?.utility_model],
  ];
  for (const [profileName, profile] of Object.entries(config.profiles ?? {})) {
    globalRefs.push(['profiles.' + profileName + '.default_model', profile.default_model]);
    globalRefs.push(['profiles.' + profileName + '.utility_model', profile.utility_model]);
  }
  for (const [keyPath, ref] of globalRefs) {
    if (ref !== undefined && !isResolvableModelRef(config, ref)) {
      problems.push(keyPath + ' = "' + ref + '" 既不是 [models] 别名，其 provider 段也未声明');
    }
  }

  for (const [id, entry] of Object.entries(entries)) {
    for (const ref of collectAgentModelRefs(entry)) {
      if (!isResolvableModelRef(config, ref)) {
        problems.push('agents.entries.' + id + ' 引用的模型 "' + ref + '" 既不是 [models] 别名，其 provider 段也未声明');
      }
    }
    for (const target of entry.subagents?.allow ?? []) {
      if (!agentIds.has(target)) {
        problems.push('agents.entries.' + id + '.subagents.allow 含未声明的智能体 "' + target + '"');
      }
    }
    for (const name of [...(entry.tools?.allow ?? []), ...(entry.tools?.deny ?? [])]) {
      if (!knownTools.has(name) && !name.includes('__')) {
        problems.push('agents.entries.' + id + '.tools 含未知工具 "' + name + '"（内置工具：' + BUILTIN_TOOL_NAMES.join(', ') + '；MCP 工具须写作 <服务器>__<工具>）');
      }
    }
  }

  const agentPointers: Array<[string, string | undefined]> = [
    ['default_agent', config.default_agent],
    ['channels.telegram.default_agent', config.channels?.telegram?.default_agent],
    ['channels.whatsapp.default_agent', config.channels?.whatsapp?.default_agent],
    ['channels.http.default_agent', config.channels?.http?.default_agent],
    ['channels.cli.default_agent', config.channels?.cli?.default_agent],
  ];
  for (const [profileName, profile] of Object.entries(config.profiles ?? {})) {
    agentPointers.push(['profiles.' + profileName + '.default_agent', profile.default_agent]);
  }
  for (const [keyPath, id] of agentPointers) {
    if (id !== undefined && agentIds.size > 0 && !agentIds.has(id)) {
      problems.push(keyPath + ' = "' + id + '" 未在 [agents.entries] 下声明');
    }
  }

  const telegram = config.channels?.telegram;
  if (telegram !== undefined) {
    if (telegram.mode === 'webhook' && telegram.webhook === undefined) {
      problems.push('channels.telegram.mode = "webhook" 但缺少 [channels.telegram.webhook] 块（FR-CHAN-016）');
    }
    if (telegram.mode !== 'webhook' && telegram.webhook !== undefined) {
      problems.push('channels.telegram 同时声明了 polling 模式与 webhook 块，二者互斥（FR-CHAN-016）');
    }
  }

  if (problems.length > 0) {
    const detail = problems.map((p, i) => '  [' + String(i + 1) + '] ' + p).join('\n');
    throw new ConfigError('CONFIG_CONFLICT', '配置交叉引用校验失败（' + String(problems.length) + ' 项）\n  文件：' + filePath + '\n' + detail, {
      path: filePath,
      problems,
    });
  }
}

/** 读取并完整校验配置文件。文件不存在时返回空配置树，让内置默认值独自生效。 */
export function loadConfig(options: { path?: string; env?: NodeJS.ProcessEnv } = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const path = resolveConfigPath(options.path, env);
  if (!existsSync(path)) {
    return { path, exists: false, config: {}, raw: '', loadedAt: Date.now() };
  }
  const raw = readFileSync(path, 'utf8');
  const config = parseConfigText(raw, path);
  validateCrossReferences(config, path);
  return { path, exists: true, config, raw, loadedAt: Date.now() };
}

/**
 * 监听配置文件变更（FR-CFG-005）。
 *
 * 监听所在目录而非文件本身：编辑器多以「写临时文件 + 重命名」方式保存，直接监听文件会丢失 inode。
 * 回调只在解析成功时触发；解析失败时把错误交给 onError，旧快照继续服务。
 */
export function watchConfig(
  path: string,
  onChange: (loaded: LoadedConfig) => void,
  onError: (error: unknown) => void,
  debounceMs = 300,
): () => void {
  const dir = resolvePath(path, '..');
  const base = path.slice(dir.length).replace(/^[\\/]/, '');
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(dir, (_event, filename) => {
    if (filename !== null && filename !== base) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      try {
        onChange(loadConfig({ path }));
      } catch (error) {
        onError(error);
      }
    }, debounceMs);
  });
  return (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    watcher.close();
  };
}
