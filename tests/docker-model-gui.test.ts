import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const isolated = vi.hoisted(() => {
  const original = process.env.HAP_GUI_DATA_DIR;
  process.env.HAP_GUI_DATA_DIR = `/tmp/hap-docker-gui-${process.pid}`;
  return { original, path: process.env.HAP_GUI_DATA_DIR };
});
vi.mock('electron', () => ({ dialog: {}, shell: {} }));
import { GuiService } from '../src/gui/service.js';
import { DockerDeploymentManager } from '../src/system/docker-deployment.js';
import { getDockerRecipe } from '../src/system/docker-models.js';
const dir = mkdtempSync(join(tmpdir(), 'hap-docker-gui-config-'));
const path = join(dir, 'config.toml');
beforeEach(() => { writeFileSync(path, ''); rmSync(isolated.path, { recursive: true, force: true }); });
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  rmSync(dir, { recursive: true, force: true }); rmSync(isolated.path, { recursive: true, force: true });
  if (isolated.original === undefined) delete process.env.HAP_GUI_DATA_DIR;
  else process.env.HAP_GUI_DATA_DIR = isolated.original;
});
describe('Docker GUI registration', () => {
  it('registers a healthy model with the real repository and endpoint', async () => {
    const recipe = getDockerRecipe('whisper:base');
    vi.spyOn(DockerDeploymentManager.prototype, 'deploy').mockResolvedValue(recipe);
    const service = new GuiService(path);
    await service.deployDockerModel({ id: recipe.id }, () => {});
    const snapshot = service.snapshot() as { models: { model: string; providerId: string; capabilities: string[] }[]; providers: { id: string; baseUrl: string }[] };
    expect(snapshot.providers).toContainEqual(expect.objectContaining({ id: recipe.container, baseUrl: 'http://127.0.0.1:8202/v1', hasCredential: true }));
    expect(snapshot.models).toContainEqual(expect.objectContaining({ model: recipe.repo, providerId: recipe.container, capabilities: ['audio'] }));
    const fresh = new GuiService(path).snapshot() as typeof snapshot;
    expect(fresh.models).toContainEqual(expect.objectContaining({ model: recipe.repo }));
  });
  it('does not register a failed deployment', async () => {
    vi.spyOn(DockerDeploymentManager.prototype, 'deploy').mockRejectedValue(new Error('Model load failed'));
    const service = new GuiService(path);
    const register = vi.spyOn(service, 'upsertModel');
    await expect(service.deployDockerModel({ id: 'whisper:base' }, () => {})).rejects.toThrow('Model load failed');
    expect(register).not.toHaveBeenCalled();
  });
  it('does not send TTS models to the transcription endpoint', async () => {
    vi.spyOn(DockerDeploymentManager.prototype, 'deploy').mockResolvedValue(getDockerRecipe('cosyvoice:latest'));
    const service = new GuiService(path);
    await service.deployDockerModel({ id: 'cosyvoice:latest' }, () => {});
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await service.transcribeAudio({ audioBase64: 'AAAA', modelAlias: 'hap-model-8204/model' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不能用于转写');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('tests a managed audio service with health, without sending chat completions', async () => {
    vi.spyOn(DockerDeploymentManager.prototype, 'deploy').mockResolvedValue(getDockerRecipe('whisper:base'));
    const service = new GuiService(path);
    await service.deployDockerModel({ id: 'whisper:base' }, () => {});
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ phase: 'ready', model: 'openai/whisper-base' }), { status: 200 }));
    const result = await service.testModel('hap-model-8202/model');
    expect(result.ok).toBe(true);
    expect(result.preview).toContain('具体推理');
    expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8202/health');
  });

});
