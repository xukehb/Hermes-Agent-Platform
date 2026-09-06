import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import {
  ConfigResolver,
  ConfigWriter,
  loadConfig,
  type AgentPatch,
} from '../config/index.js';

export interface GuiAgentInput {
  id: string;
  create?: boolean;
  displayName?: string;
  emoji?: string;
  model?: string;
  fallbackModels?: string | string[];
  utilityModel?: string;
  protocol?: 'openai-tools' | 'deepseek' | 'anthropic' | 'hermes-native' | '';
  workspace?: string;
  description?: string;
  toolTier?: 'minimal' | 'standard' | 'coding' | 'research' | 'full';
  allowTools?: string | string[];
  denyTools?: string | string[];
  subagents?: string | string[];
  runtimeMode?: 'oneshot' | 'persistent';
  reasoningVisible?: boolean;
  paramsJson?: string;
  systemPrompt?: string;
}

function parseCsv(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }
  if (value === undefined) {
    return [];
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseParamsJson(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('模型参数必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

function writeAgentPrompt(agentDir: string, body: string): string {
  const target = isAbsolute(agentDir) ? resolvePath(agentDir, 'system.md') : resolvePath(process.cwd(), agentDir, 'system.md');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body.endsWith('\n') ? body : body + '\n', 'utf8');
  return target;
}

function resolverFor(configPath: string): ConfigResolver {
  return new ConfigResolver(loadConfig({ path: configPath }), {}, process.env);
}

export function upsertAgent(configPath: string, input: GuiAgentInput): object {
  const id = input.id.trim();
  if (!id) throw new Error('智能体 ID 不能为空');
  if (input.create && resolverFor(configPath).listAgentIds().includes(id)) {
    throw new Error(`智能体 ID "${id}" 已存在`);
  }

  const writer = new ConfigWriter(configPath);
  const patch: AgentPatch = {};
  if (input.displayName !== undefined || input.emoji !== undefined) {
    if (input.displayName !== undefined) {
      patch.name = input.displayName.trim();
    }
    patch.identity = {
      display_name: input.displayName?.trim(),
      emoji: input.emoji?.trim(),
    };
  }
  if (input.model !== undefined) {
    const primary = input.model.trim();
    const fallbacks = parseCsv(input.fallbackModels);
    patch.model = primary ? (fallbacks.length > 0 ? { primary, fallbacks } : primary) : null as never;
  } else if (input.fallbackModels !== undefined) {
    patch.model = { primary: resolverFor(configPath).resolveAgent(id).model.primary, fallbacks: parseCsv(input.fallbackModels) };
  }
  if (input.utilityModel !== undefined) {
    patch.utility_model = input.utilityModel.trim() || null as never;
  }
  if (input.protocol !== undefined) {
    patch.protocol = input.protocol || null as never;
  }
  if (input.workspace !== undefined) {
    patch.workspace = input.workspace.trim() || null as never;
  }
  if (input.description !== undefined) {
    patch.description = input.description.trim();
  }
  if (input.toolTier !== undefined) {
    patch.tools = {
      profile: input.toolTier,
      allow: parseCsv(input.allowTools),
      deny: parseCsv(input.denyTools),
    };
  } else if (input.allowTools !== undefined || input.denyTools !== undefined) {
    patch.tools = {
      allow: parseCsv(input.allowTools),
      deny: parseCsv(input.denyTools),
    };
  }
  if (input.subagents !== undefined) {
    patch.subagents = { allow: parseCsv(input.subagents) };
  }
  if (input.runtimeMode !== undefined) {
    patch.runtime = { mode: input.runtimeMode };
  }
  if (input.reasoningVisible !== undefined) {
    patch.reasoning_visible = input.reasoningVisible;
  }
  if (input.paramsJson !== undefined) {
    patch.params = parseParamsJson(input.paramsJson) as never;
  }

  writer.upsertAgent(id, patch);
  if (input.systemPrompt !== undefined) {
    const prompt = input.systemPrompt.trim();
    if (prompt) {
      const agent = resolverFor(configPath).resolveAgent(id);
      writer.upsertAgent(id, { system_prompt_file: writeAgentPrompt(agent.agentDir, prompt) });
    } else {
      writer.upsertAgent(id, { system_prompt_file: null as never });
    }
  }
  return { ok: true };
}

export function removeAgent(configPath: string, rawId: string): object {
  const id = rawId.trim();
  if (!id) throw new Error('智能体 ID 不能为空');
  new ConfigWriter(configPath).removeAgent(id);
  return { ok: true };
}
