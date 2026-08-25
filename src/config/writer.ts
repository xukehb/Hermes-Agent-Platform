/**
 * 配置写回（FR-CFG-007 / FR-PROV-005 / FR-MOD-002 / FR-AGT-004）。
 *
 * 这是「像 ocx 一样在运行时加服务商、加模型、造智能体」的落地面：
 * CLI 子命令把参数收进来，本文件负责合并进配置树、序列化、校验、原子落盘。
 *
 * 三条不变量：
 * 1. 增量合并——同名条目按字段覆盖，未提到的字段保持原样，因此改一个 base_url 不会清空其余字段；
 * 2. 写前自校验——序列化结果先按加载路径重新解析并做交叉引用检查，写出去的配置必然读得回来；
 * 3. 原子落盘——先写 .tmp 再 rename，避免写一半被配置监听器读到（FR-CFG-005）。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify as stringifyToml } from 'smol-toml';
import { ConfigError } from '../domain/index.js';
import { AGENT_TEMPLATES, BUILTIN_MODELS, BUILTIN_PROVIDERS, SCAFFOLD_CONFIG } from './defaults.js';
import { parseConfigText, validateCrossReferences } from './loader.js';
import type { AgentEntryConfig, HapConfig, ModelEntryConfig, ModelProviderConfig } from './schema.js';

/** 一次写回的结果。CLI 直接把 summary 打给用户。 */
export interface WriteResult {
  path: string;
  /** 文件此前不存在，本次是首建 */
  created: boolean;
  /** 内容确有变化；重复执行同一条命令时为 false */
  changed: boolean;
  summary: string;
}

/** smol-toml 不接受 undefined，序列化前深度剔除。 */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined).map((item) => prune(item));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) {
        continue;
      }
      result[key] = prune(item);
    }
    return result;
  }
  return value;
}

/** 把 patch 合并进基底：patch 里为 undefined 的键不参与覆盖，于是「没传的参数」不会清空既有值。 */
function mergeDefined<T extends object>(base: T | undefined, patch: Partial<T>): T {
  const result: Record<string, unknown> = { ...((base ?? {}) as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

/** 提供商写入参数。base_url 对新建条目必填，除非用 preset 带出预置值。 */
export type ProviderPatch = Partial<ModelProviderConfig>;

/** 模型写入参数。provider 对新建条目必填。 */
export type ModelPatch = Partial<ModelEntryConfig>;

/** 智能体写入参数。 */
export type AgentPatch = Partial<AgentEntryConfig>;

export class ConfigWriter {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** 读出当前配置树。文件不存在时以空树起步。 */
  read(): { config: HapConfig; exists: boolean; raw: string } {
    if (!existsSync(this.path)) {
      return { config: {}, exists: false, raw: '' };
    }
    const raw = readFileSync(this.path, 'utf8');
    return { config: parseConfigText(raw, this.path), exists: true, raw };
  }

  private commit(config: HapConfig, exists: boolean, raw: string, summary: string): WriteResult {
    const text = stringifyToml(prune(config) as Record<string, unknown>) + '\n';
    validateCrossReferences(parseConfigText(text, this.path), this.path);
    if (text === raw) {
      return { path: this.path, created: false, changed: false, summary: summary + '（内容无变化）' };
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = this.path + '.tmp';
    writeFileSync(temp, text, 'utf8');
    renameSync(temp, this.path);
    return { path: this.path, created: !exists, changed: true, summary };
  }

  /** hap init：写入规格第 4 节的参考配置骨架。已存在时需显式 force。 */
  initScaffold(force = false): WriteResult {
    const exists = existsSync(this.path);
    if (exists && !force) {
      throw new ConfigError('CONFIG_CONFLICT', '配置文件已存在：' + this.path + '（如需覆盖请加 --force）', { path: this.path });
    }
    const summary =
      'hap init：写入配置骨架到 ' + this.path + '（' +
      String(Object.keys(SCAFFOLD_CONFIG.model_providers ?? {}).length) + ' 家提供商、' +
      String(Object.keys(SCAFFOLD_CONFIG.models ?? {}).length) + ' 个模型、' +
      String(Object.keys(SCAFFOLD_CONFIG.agents?.entries ?? {}).length) + ' 个智能体）';
    return this.commit(SCAFFOLD_CONFIG, exists, '', summary);
  }

  /**
   * 新增或更新提供商（FR-PROV-005）。
   *
   * 基底优先级：配置文件已有同名条目 > 显式 preset 预置 > 同名预置。
   * 于是 hap provider add deepseek 无需任何参数即可落地，
   * 而 hap provider add mycorp --preset openai --base-url https://... 也能一行搞定自建网关。
   */
  upsertProvider(id: string, patch: ProviderPatch, preset?: string): WriteResult {
    const { config, exists, raw } = this.read();
    const existing = config.model_providers?.[id];
    let base: ModelProviderConfig | undefined = existing;
    if (base === undefined) {
      if (preset !== undefined) {
        const found = BUILTIN_PROVIDERS[preset];
        if (found === undefined) {
          throw new ConfigError('CONFIG_INVALID', '未知预置提供商 "' + preset + '"。可用预置：' + Object.keys(BUILTIN_PROVIDERS).join(', '), { preset });
        }
        base = found;
      } else {
        base = BUILTIN_PROVIDERS[id];
      }
    }
    const merged = mergeDefined(base, patch);
    if (merged.base_url === undefined || merged.base_url === '') {
      throw new ConfigError(
        'CONFIG_INVALID',
        '新增提供商 "' + id + '" 必须提供 --base-url，或用 --preset 指定预置（可用：' + Object.keys(BUILTIN_PROVIDERS).join(', ') + '）',
        { providerId: id },
      );
    }
    const next: HapConfig = { ...config, model_providers: { ...(config.model_providers ?? {}), [id]: merged } };
    const verb = existing === undefined ? '新增' : '更新';
    return this.commit(next, exists, raw, verb + '提供商 ' + id + '（base_url=' + merged.base_url + '，wire_api=' + (merged.wire_api ?? 'chat') + '）');
  }

  removeProvider(id: string): WriteResult {
    const { config, exists, raw } = this.read();
    if (config.model_providers?.[id] === undefined) {
      throw new ConfigError('PROVIDER_NOT_FOUND', '配置文件中没有提供商 "' + id + '"', { providerId: id });
    }
    const providers = { ...config.model_providers };
    delete providers[id];
    const models = { ...(config.models ?? {}) };
    const dropped: string[] = [];
    for (const [alias, entry] of Object.entries(models)) {
      if (entry.provider === id) {
        delete models[alias];
        dropped.push(alias);
      }
    }
    const next: HapConfig = { ...config, model_providers: providers, models };
    const tail = dropped.length > 0 ? '，同时移除其下模型 ' + dropped.join(', ') : '';
    return this.commit(next, exists, raw, '移除提供商 ' + id + tail);
  }

  /** 新增或更新模型目录条目（FR-MOD-002）。provider 必须已声明或属于预置，否则给出可执行的修复提示。 */
  upsertModel(alias: string, patch: ModelPatch): WriteResult {
    const { config, exists, raw } = this.read();
    const existing = config.models?.[alias];
    const base = existing ?? BUILTIN_MODELS[alias];
    const merged = mergeDefined(base, patch);
    if (merged.provider === undefined || merged.provider === '') {
      throw new ConfigError('CONFIG_INVALID', '新增模型 "' + alias + '" 必须提供 --provider', { alias });
    }
    const declared = config.model_providers?.[merged.provider] !== undefined || BUILTIN_PROVIDERS[merged.provider] !== undefined;
    if (!declared) {
      throw new ConfigError(
        'PROVIDER_NOT_FOUND',
        '模型 "' + alias + '" 指向的提供商 "' + merged.provider + '" 尚未声明。先执行：hap provider add ' + merged.provider + ' --base-url <地址> --env-key <环境变量>',
        { alias, providerId: merged.provider },
      );
    }
    const next: HapConfig = { ...config, models: { ...(config.models ?? {}), [alias]: merged } };
    const verb = existing === undefined ? '新增' : '更新';
    return this.commit(next, exists, raw, verb + '模型 ' + alias + '（' + merged.provider + '/' + (merged.model ?? alias) + '）');
  }

  removeModel(alias: string): WriteResult {
    const { config, exists, raw } = this.read();
    if (config.models?.[alias] === undefined) {
      throw new ConfigError('MODEL_NOT_FOUND', '配置文件中没有模型 "' + alias + '"', { alias });
    }
    const models = { ...config.models };
    delete models[alias];
    return this.commit({ ...config, models }, exists, raw, '移除模型 ' + alias);
  }

  /**
   * 新增或更新智能体（FR-AGT-004 / FR-AGT-005）。
   *
   * 从模板创建时会把 subagents.allow 收窄到「写入后确实存在」的智能体：
   * 模板里的派生白名单指向的是一套完整编队，单独创建一个 coder 时若原样落盘会直接触发交叉引用失败，
   * 那种失败对用户毫无信息量。被丢弃的项写进 summary，用户想要就再补建。
   */
  upsertAgent(id: string, patch: AgentPatch, template?: string): WriteResult {
    const { config, exists, raw } = this.read();
    const entries = { ...(config.agents?.entries ?? {}) };
    const existing = entries[id];
    let base: AgentEntryConfig | undefined = existing;
    if (base === undefined && template !== undefined) {
      const found = AGENT_TEMPLATES[template];
      if (found === undefined) {
        throw new ConfigError('CONFIG_INVALID', '未知智能体模板 "' + template + '"。可用模板：' + Object.keys(AGENT_TEMPLATES).join(', '), { template });
      }
      base = found;
    }
    const merged = mergeDefined(base, patch);
    entries[id] = merged;

    const notes: string[] = [];
    const allow = merged.subagents?.allow;
    if (allow !== undefined) {
      const kept = allow.filter((target) => entries[target] !== undefined);
      const removed = allow.filter((target) => entries[target] === undefined);
      if (removed.length > 0) {
        entries[id] = { ...merged, subagents: { ...merged.subagents, allow: kept } };
        notes.push('派生白名单中 ' + removed.join('、') + ' 尚未声明，已暂时移除');
      }
    }

    const next: HapConfig = { ...config, agents: { ...(config.agents ?? {}), entries } };
    const verb = existing === undefined ? '创建' : '更新';
    const from = existing === undefined && template !== undefined ? '（基于模板 ' + template + '）' : '';
    const tail = notes.length > 0 ? '；' + notes.join('；') : '';
    return this.commit(next, exists, raw, verb + '智能体 ' + id + from + tail);
  }

  /**
   * 移除智能体，并顺手清掉所有指向它的引用。
   * 不清理的话交叉引用校验会立刻把这次删除顶回来，用户得手工改三处才能删掉一个智能体。
   */
  removeAgent(id: string): WriteResult {
    const { config, exists, raw } = this.read();
    const entries = { ...(config.agents?.entries ?? {}) };
    if (entries[id] === undefined) {
      throw new ConfigError('AGENT_NOT_FOUND', '配置文件中没有智能体 "' + id + '"', { agentId: id });
    }
    delete entries[id];

    const notes: string[] = [];
    for (const [otherId, entry] of Object.entries(entries)) {
      const allow = entry.subagents?.allow;
      if (allow !== undefined && allow.includes(id)) {
        entries[otherId] = { ...entry, subagents: { ...entry.subagents, allow: allow.filter((target) => target !== id) } };
        notes.push('从 ' + otherId + '.subagents.allow 摘除');
      }
    }

    const next: HapConfig = { ...config, agents: { ...(config.agents ?? {}), entries } };
    if (next.default_agent === id) {
      delete next.default_agent;
      notes.push('清空 default_agent');
    }
    const channels = next.channels;
    if (channels !== undefined) {
      const patched = { ...channels };
      if (patched.telegram?.default_agent === id) {
        patched.telegram = { ...patched.telegram };
        delete patched.telegram.default_agent;
        notes.push('清空 channels.telegram.default_agent');
      }
      if (patched.http?.default_agent === id) {
        patched.http = { ...patched.http };
        delete patched.http.default_agent;
        notes.push('清空 channels.http.default_agent');
      }
      if (patched.cli?.default_agent === id) {
        patched.cli = { ...patched.cli };
        delete patched.cli.default_agent;
        notes.push('清空 channels.cli.default_agent');
      }
      next.channels = patched;
    }
    const profiles = next.profiles;
    if (profiles !== undefined) {
      const patched: Record<string, (typeof profiles)[string]> = { ...profiles };
      for (const [name, profile] of Object.entries(patched)) {
        if (profile.default_agent === id) {
          const copy = { ...profile };
          delete copy.default_agent;
          patched[name] = copy;
          notes.push('清空 profiles.' + name + '.default_agent');
        }
      }
      next.profiles = patched;
    }

    const tail = notes.length > 0 ? '；同时' + notes.join('、') : '';
    return this.commit(next, exists, raw, '移除智能体 ' + id + tail);
  }

  /** 设置全局默认项。用于 hap agent create --set-default 与 hap init 之后的调档。 */
  setGlobals(patch: { defaultAgent?: string; defaultModel?: string; activeProfile?: string }): WriteResult {
    const { config, exists, raw } = this.read();
    const next: HapConfig = { ...config };
    const notes: string[] = [];
    if (patch.defaultAgent !== undefined) {
      next.default_agent = patch.defaultAgent;
      notes.push('default_agent=' + patch.defaultAgent);
    }
    if (patch.defaultModel !== undefined) {
      next.default_model = patch.defaultModel;
      notes.push('default_model=' + patch.defaultModel);
    }
    if (patch.activeProfile !== undefined) {
      next.active_profile = patch.activeProfile;
      notes.push('active_profile=' + patch.activeProfile);
    }
    if (notes.length === 0) {
      return { path: this.path, created: false, changed: false, summary: '未指定任何全局默认项' };
    }
    return this.commit(next, exists, raw, '设置 ' + notes.join('，'));
  }
}
