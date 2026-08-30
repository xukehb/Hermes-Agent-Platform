import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

import { loadConfig } from '../src/config/index.js';
import { GuiService } from '../src/gui/service.js';

const initialConfig = [
  'default_agent = "helper"',
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
    writeFileSync(configPath, initialConfig, 'utf8');
  });

  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

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
