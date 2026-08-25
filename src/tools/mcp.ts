/**
 * MCP 外部工具接入（FR-TOOL-002）。
 *
 * 三条约定：
 * 1. 全部 MCP 工具名统一加 <serverId>__ 前缀，避免不同服务器之间以及与内置工具撞名；
 *    原名记在 ToolModule.renamedFrom，注册表据此写入 trace（FR-TOOL-006）；
 * 2. MCP 工具不做本地参数校验——schema 由服务器给出、校验也由服务器负责，
 *    本地再校验一遍只会因 JSON Schema 方言差异产生假错；
 * 3. 任何服务器连接失败都不阻断启动，只记录 failure，其余服务器与内置工具照常可用。
 *
 * 凭据处理：配置里的 env 值支持 $VAR 与花括号包裹两种环境变量引用写法，
 * 在 spawn 时才从环境变量取值，因此明文凭据既不进配置文件也不进 McpServerSpec。
 *
 * 日期：2026-08-24  执行者：Codex
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { expandHome } from '../config/loader.js';
import type { HapConfig } from '../config/schema.js';
import { RecoverableError, describeError } from '../domain/index.js';
import type { JsonSchema, ToolDefinition } from '../domain/index.js';
import { asRecord, asString } from '../providers/read.js';
import type { ToolContext, ToolModule, ToolOutput, ToolSource } from './types.js';

/** MCP 工具名前缀分隔符。双下划线在各家模型的分词里都不易被切碎。 */
export const MCP_NAME_SEPARATOR = '__';

/** 未显式配置时的启动握手超时。 */
export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 20000;

/** 归一化后的 MCP 服务器声明。 */
export interface McpServerSpec {
  id: string;
  command: string;
  args: string[];
  /** 原始 env 声明，值里可能含环境变量引用，连接时才展开 */
  env: Record<string, string>;
  cwd?: string;
  startupTimeoutMs: number;
  enabled: boolean;
}

/** 单台服务器的加载失败记录。 */
export interface McpLoadFailure {
  serverId: string;
  message: string;
}

/** 全部服务器的加载结果。 */
export interface McpLoadResult {
  modules: ToolModule[];
  failures: McpLoadFailure[];
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** 展开 env 值里的环境变量引用，缺失的变量展开为空串（交由服务器自行报错）。 */
export function expandEnvRefs(value: string, env: Record<string, string | undefined>): string {
  return value.replace(ENV_REF, (_match: string, braced: string | undefined, bare: string | undefined) => {
    const key = braced ?? bare;
    if (key === undefined) return '';
    return env[key] ?? '';
  });
}

/** 把配置里的 [mcp_servers.*] 段归一化为 spec 列表，enabled=false 的条目保留但打标。 */
export function resolveMcpServers(config: HapConfig): McpServerSpec[] {
  const specs: McpServerSpec[] = [];
  for (const [id, entry] of Object.entries(config.mcp_servers ?? {})) {
    const spec: McpServerSpec = {
      id,
      command: entry.command,
      args: entry.args === undefined ? [] : [...entry.args],
      env: entry.env === undefined ? {} : { ...entry.env },
      startupTimeoutMs: entry.startup_timeout_ms ?? DEFAULT_MCP_STARTUP_TIMEOUT_MS,
      enabled: entry.enabled ?? true,
    };
    if (entry.cwd !== undefined) spec.cwd = path.resolve(expandHome(entry.cwd));
    specs.push(spec);
  }
  return specs;
}

/** MCP 返回的 inputSchema 兜底：缺失或非对象时给一个空对象 schema，避免适配器拿到 undefined。 */
function normalizeMcpSchema(value: unknown): JsonSchema {
  const record = asRecord(value);
  if (record === undefined) return { type: 'object', properties: {} };
  if (record.type === undefined) return { ...record, type: 'object' } as JsonSchema;
  return record as JsonSchema;
}

/**
 * 把 MCP 的 content 数组压成纯文本。
 * 非文本块不静默丢弃——模型需要知道「确实返回了一张图 / 一个资源」才能正确追问。
 */
export function mcpContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === undefined) continue;
    const type = asString(record.type) ?? 'text';
    if (type === 'text') {
      parts.push(asString(record.text) ?? '');
      continue;
    }
    if (type === 'image' || type === 'audio') {
      const mime = asString(record.mimeType) ?? '未知类型';
      const size = typeof record.data === 'string' ? record.data.length : 0;
      parts.push('（' + (type === 'image' ? '图片' : '音频') + '输出：' + mime + '，base64 长度 ' + size + '）');
      continue;
    }
    if (type === 'resource') {
      const resource = asRecord(record.resource) ?? {};
      const uri = asString(resource.uri) ?? '未知资源';
      const text = asString(resource.text);
      parts.push(text === undefined ? '（资源：' + uri + '）' : '【资源 ' + uri + '】\n' + text);
      continue;
    }
    if (type === 'resource_link') {
      parts.push('（资源链接：' + (asString(record.uri) ?? '未知') + '）');
      continue;
    }
    parts.push('（' + type + ' 类型输出）');
  }
  return parts.filter((part) => part.length > 0).join('\n');
}

/** 单台 MCP 服务器作为一个工具来源。连接惰性建立，进程生命周期内复用。 */
export class McpToolSource implements ToolSource {
  readonly id: string;

  private readonly spec: McpServerSpec;
  private readonly env: Record<string, string | undefined>;
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;

  constructor(spec: McpServerSpec, env: Record<string, string | undefined> = process.env) {
    this.spec = spec;
    this.env = env;
    this.id = spec.id;
  }

  /** 列出该服务器提供的全部工具，名称已加前缀。 */
  async list(): Promise<ToolModule[]> {
    const client = await this.connect();
    const listed = await client.listTools();
    return listed.tools.map((tool) => this.toModule(tool));
  }

  /** 关闭连接，用于配置热重载与进程退出。 */
  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    if (client !== undefined) {
      await client.close().catch(() => undefined);
      return;
    }
    if (transport !== undefined) await transport.close().catch(() => undefined);
  }

  private resolveEnv(): Record<string, string> {
    const declared: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.spec.env)) {
      declared[key] = expandEnvRefs(value, this.env);
    }
    return { ...getDefaultEnvironment(), ...declared };
  }

  private async connect(): Promise<Client> {
    if (this.client !== undefined) return this.client;
    const client = new Client({ name: 'hap', version: '1.0.0' });
    const parameters: StdioServerParameters = {
      command: this.spec.command,
      args: [...this.spec.args],
      env: this.resolveEnv(),
    };
    if (this.spec.cwd !== undefined) parameters.cwd = this.spec.cwd;
    const transport = new StdioClientTransport(parameters);
    try {
      await client.connect(transport, { timeout: this.spec.startupTimeoutMs });
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw new RecoverableError('TOOL_FAILED', 'MCP 服务器 ' + this.spec.id + ' 启动失败：' + describeError(error), {
        context: { serverId: this.spec.id, command: this.spec.command },
        cause: error,
      });
    }
    this.client = client;
    this.transport = transport;
    return client;
  }

  private toModule(tool: { name: string; description?: string | undefined; inputSchema?: unknown }): ToolModule {
    const prefixed = this.spec.id + MCP_NAME_SEPARATOR + tool.name;
    const definition: ToolDefinition = {
      name: prefixed,
      description: tool.description ?? ('MCP 服务器 ' + this.spec.id + ' 提供的工具 ' + tool.name),
      parameters: normalizeMcpSchema(tool.inputSchema),
      source: this.spec.id,
    };
    return {
      definition,
      renamedFrom: tool.name,
      handler: async (args, ctx) => this.call(tool.name, args, ctx),
    };
  }

  private async call(originalName: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
    const client = await this.connect();
    const raw = await client.callTool({ name: originalName, arguments: args }, undefined, {
      signal: ctx.signal,
      timeout: ctx.agent.limits.toolTimeoutMs,
    });
    const record = asRecord(raw) ?? {};
    const text = mcpContentText(record.content);
    const output: ToolOutput = { content: text.length > 0 ? text : '（MCP 工具无文本输出）' };
    if (record.isError === true) output.isError = true;
    return output;
  }
}

/**
 * 多台 MCP 服务器的统一入口。
 * listAll 并发连接：一台服务器卡住不影响其他服务器，失败只落 failures。
 */
export class McpManager {
  private readonly sources: McpToolSource[];

  constructor(specs: readonly McpServerSpec[], env: Record<string, string | undefined> = process.env) {
    this.sources = specs.filter((spec) => spec.enabled).map((spec) => new McpToolSource(spec, env));
  }

  /** 直接从配置构造。 */
  static fromConfig(config: HapConfig, env: Record<string, string | undefined> = process.env): McpManager {
    return new McpManager(resolveMcpServers(config), env);
  }

  get serverIds(): string[] {
    return this.sources.map((source) => source.id);
  }

  /** 拉取全部服务器的工具清单。 */
  async listAll(): Promise<McpLoadResult> {
    const settled = await Promise.allSettled(this.sources.map((source) => source.list()));
    const modules: ToolModule[] = [];
    const failures: McpLoadFailure[] = [];
    for (let index = 0; index < settled.length; index += 1) {
      const outcome = settled[index];
      const source = this.sources[index];
      if (outcome === undefined || source === undefined) continue;
      if (outcome.status === 'fulfilled') {
        modules.push(...outcome.value);
        continue;
      }
      failures.push({ serverId: source.id, message: describeError(outcome.reason) });
    }
    return { modules, failures };
  }

  async close(): Promise<void> {
    await Promise.all(this.sources.map((source) => source.close()));
  }
}
