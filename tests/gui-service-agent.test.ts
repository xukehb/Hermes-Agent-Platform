import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

import { ConfigResolver, loadConfig } from '../src/config/index.js';
import { GuiService } from '../src/gui/service.js';
import { AgentOrchestrator } from '../src/agent/index.js';
import { ProviderRegistry } from '../src/providers/index.js';
import { MockProviderClient, textTurn } from '../src/providers/mock.js';

const initialConfig = [
  'default_agent = "helper"',
  '',
  '[agents.defaults]',
  'model = { primary = "deepseek/deepseek-chat", fallbacks = ["anthropic/claude-sonnet-4-5"] }',
  'workspace_root = "__WORKSPACE_ROOT__"',
  'agent_dir_root = "__AGENT_DIR_ROOT__"',
  '',
  '[agents.entries.helper]',
  'description = "Temporary helper"',
  '',
  '[agents.entries.coder]',
  'description = "Coder"',
  '',
  '[agents.entries.coder.subagents]',
  'allow = ["helper"]',
  '',
].join('\n');

describe('GuiService agent role management', () => {
  let testDir: string;
  let configPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'hap-gui-agent-'));
    configPath = join(testDir, 'config.toml');
    const text = initialConfig
      .replace('__WORKSPACE_ROOT__', join(testDir, 'workspaces'))
      .replace('__AGENT_DIR_ROOT__', join(testDir, 'agents'));
    writeFileSync(configPath, `${text}\n\n[paths]\ndata_dir = "${join(testDir, 'data')}"\n`, 'utf8');
  });

  afterEach(() => { vi.restoreAllMocks(); rmSync(testDir, { recursive: true, force: true }); });

  it('leaves model selection to the agent when no override is supplied', async () => {
    const run = vi.spyOn(AgentOrchestrator.prototype, 'runTask').mockResolvedValue({ text: 'ok' } as never);
    await new GuiService(configPath).chat({ input: 'hello', agentId: 'helper' });
    expect(run.mock.calls[0]?.[0].model).toBeUndefined();
  });

  it('passes an explicitly selected model to the orchestrator', async () => {
    const run = vi.spyOn(AgentOrchestrator.prototype, 'runTask').mockResolvedValue({ text: 'ok' } as never);
    await new GuiService(configPath).chat({ input: 'hello', agentId: 'helper', model: 'openai/gpt-5' });
    expect(run.mock.calls[0]?.[0].model).toBe('openai/gpt-5');
  });

  it('falls back to the configured default agent when the UI sends a deleted agent id', async () => {
    const run = vi.spyOn(AgentOrchestrator.prototype, 'runTask').mockResolvedValue({ text: 'ok' } as never);
    await new GuiService(configPath).chat({ input: 'hello', agentId: 'coder' });
    expect(run.mock.calls[0]?.[0].agentId).toBe('helper');
  });

  it('tests the exact model with a generation request without listing models', async () => {
    const client = new MockProviderClient({ turns: [textTurn('OK')] });
    vi.spyOn(ProviderRegistry.prototype, 'client').mockReturnValue(client);
    const check = vi.spyOn(client, 'check');
    const result = await new GuiService(configPath).testProvider({ id: 'custom', baseUrl: 'http://localhost:9/v1', model: 'org/model' } as never);
    expect(result.reachable).toBe(true);
    expect(client.requests[0]?.model).toBe('org/model');
    expect(check).not.toHaveBeenCalled();
  });

  it('rejects a model test without a user supplied model', async () => {
    const result = await new GuiService(configPath).testProvider({ id: 'custom', baseUrl: 'http://localhost:9/v1' });
    expect(result.error).toContain('模型');
  });

  it('rejects a duplicate id when creating but still allows editing', () => {
    const service = new GuiService(configPath);

    expect(() => service.upsertAgent({ id: 'helper', create: true }))
      .toThrow('智能体 ID "helper" 已存在');
    expect(() => service.upsertAgent({ id: 'helper', description: 'Updated' }))
      .not.toThrow();
  });

  it('creates a role through the existing upsert boundary', () => {
    const service = new GuiService(configPath);

    service.upsertAgent({ id: 'data-analyst', create: true, description: 'Analyze data' });

    expect(loadConfig({ path: configPath }).config.agents?.entries?.['data-analyst']?.description)
      .toBe('Analyze data');
  });

  it('sets an existing agent as the global default', () => {
    const service = new GuiService(configPath);
    service.setDefaultAgent('coder');
    expect(loadConfig({ path: configPath }).config.default_agent).toBe('coder');
    expect((service.snapshot() as { defaultAgentId: string }).defaultAgentId).toBe('coder');
  });

  it('rejects setting an unknown agent as the global default', () => {
    expect(() => new GuiService(configPath).setDefaultAgent('missing')).toThrow('不存在');
  });

  it('creates a role with system prompt and advanced settings', () => {
    const service = new GuiService(configPath);

    service.upsertAgent({
      id: 'planner',
      create: true,
      displayName: 'Planner',
      model: 'openai/gpt-5',
      fallbackModels: 'deepseek/deepseek-chat, anthropic/claude-sonnet-4-5',
      workspace: join(testDir, 'workspace'),
      description: 'Plan work',
      toolTier: 'research',
      runtimeMode: 'persistent',
      reasoningVisible: true,
      paramsJson: '{"temperature":0.2,"top_p":0.9}',
      systemPrompt: '你负责拆解任务。',
    });

    const agent = loadConfig({ path: configPath }).config.agents?.entries?.planner;
    expect(agent?.name).toBe('Planner');
    expect(agent?.model).toEqual({
      primary: 'openai/gpt-5',
      fallbacks: ['deepseek/deepseek-chat', 'anthropic/claude-sonnet-4-5'],
    });
    expect(agent?.workspace).toBe(join(testDir, 'workspace'));
    expect(agent?.tools?.profile).toBe('research');
    expect(agent?.runtime?.mode).toBe('persistent');
    expect(agent?.reasoning_visible).toBe(true);
    expect(agent?.params).toEqual({ temperature: 0.2, top_p: 0.9 });
    expect(agent?.system_prompt_file).toBeDefined();
    expect(existsSync(agent!.system_prompt_file!)).toBe(true);
    expect(readFileSync(agent!.system_prompt_file!, 'utf8')).toBe('你负责拆解任务。\n');
  });

  it('editing a role can clear model and workspace back to inherited defaults', () => {
    const service = new GuiService(configPath);
    service.upsertAgent({
      id: 'helper',
      model: 'openai/gpt-5',
      workspace: join(testDir, 'custom-workspace'),
      paramsJson: '{"temperature":0.4}',
    });

    service.upsertAgent({ id: 'helper', model: '', workspace: '', paramsJson: '' });

    const agent = loadConfig({ path: configPath }).config.agents?.entries?.helper;
    expect(agent?.model).toBeUndefined();
    expect(agent?.workspace).toBeUndefined();
    expect(agent?.params).toBeUndefined();
  });

  it('saving a primary model without fallback models preserves inherited fallbacks', () => {
    const service = new GuiService(configPath);

    service.upsertAgent({ id: 'helper', model: 'openai/gpt-5', fallbackModels: '' });

    const loaded = loadConfig({ path: configPath });
    const rawModel = loaded.config.agents?.entries?.helper?.model;
    expect(rawModel).toBe('openai/gpt-5');
    expect(new ConfigResolver(loaded, {}, {}).resolveAgent('helper').model.fallbacks)
      .toEqual(['anthropic/claude-sonnet-4-5']);
  });

  it('removes a role and lets ConfigWriter clear its references', () => {
    const service = new GuiService(configPath);

    service.removeAgent('helper');

    const config = loadConfig({ path: configPath }).config;
    expect(config.agents?.entries?.helper).toBeUndefined();
    expect(config.agents?.entries?.coder?.subagents?.allow).toEqual([]);
    expect(config.default_agent).toBeUndefined();
  });

  it('reports an unknown role without changing the config', () => {
    const service = new GuiService(configPath);

    expect(() => service.removeAgent('missing')).toThrow('没有智能体 "missing"');
    expect(loadConfig({ path: configPath }).config.agents?.entries?.helper).toBeDefined();
  });
});
