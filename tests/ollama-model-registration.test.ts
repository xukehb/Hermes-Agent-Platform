import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const setup = vi.hoisted(() => {
  const previous = process.env.HAP_GUI_DATA_DIR;
  process.env.HAP_GUI_DATA_DIR = `/tmp/hap-ollama-registration-${process.pid}`;
  return { previous, dir: process.env.HAP_GUI_DATA_DIR };
});
vi.mock('electron', () => ({ dialog: {}, shell: {} }));
vi.mock('../src/system/ollama-service.js', async (original) => ({
  ...await original<typeof import('../src/system/ollama-service.js')>(),
  pullOllamaModelStream: vi.fn(async (tag, options) => {
    options.onProgress({ modelTag: tag, done: true, status: 'success' });
  }),
}));
import { GuiService } from '../src/gui/service.js';

const dir = mkdtempSync(join(tmpdir(), 'hap-ollama-config-'));
const configPath = join(dir, 'config.toml');
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(setup.dir, { recursive: true, force: true });
  if (setup.previous === undefined) delete process.env.HAP_GUI_DATA_DIR;
  else process.env.HAP_GUI_DATA_DIR = setup.previous;
});
beforeEach(() => {
  rmSync(setup.dir, { recursive: true, force: true });
  writeFileSync(configPath, '');
});
describe('Ollama model registration', () => {
  it('shows the downloaded model even when default providers are hidden', async () => {
    const service = new GuiService(configPath);
    service.snapshot();
    await service.registerOllamaDownloadedModel('qwen2.5vl:3b');
    const snapshot = service.snapshot() as { models: { alias: string }[] };
    expect(snapshot.models.some(m => m.alias === 'ollama/qwen2.5vl:3b')).toBe(true);
  });
  it('notifies completion only after registration finishes', async () => {
    const service = new GuiService(configPath);
    let registered = false;
    vi.spyOn(service, 'registerOllamaDownloadedModel').mockImplementation(async () => { registered = true; });
    const completed: boolean[] = [];
    await service.pullOllamaModel('qwen2.5vl:3b', progress => {
      if (progress.done) completed.push(registered);
    });
    expect(completed).toEqual([true]);
  });
});
