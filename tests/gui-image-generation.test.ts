import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ dialog: {}, shell: {} }));
import { GuiService } from '../src/gui/service.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'hap-image-'));
  dirs.push(dir);
  const service = Object.create(GuiService.prototype) as GuiService;
  Object.assign(service, { info: vi.fn(), error: vi.fn() });
  const provider = { baseUrl: 'https://images.example/api/v4', envKey: 'HAP_IMAGE_TEST_KEY' };
  Object.assign(service, { resolver: () => ({ resolveProviders: () => new Map([['image-vendor', provider]]) }) });
  return { service, dir };
}

it('rejects an unknown provider without silently using a public image engine', async () => {
  const { service, dir } = setup();
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const result = await service.generateImage({ prompt: 'test', providerId: 'missing-vendor', model: 'vendor-image', workspace: dir });
  expect(result.ok).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('uses the selected provider base URL and exact model without DALL-E parameters', async () => {
  const { service, dir } = setup();
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })));
  vi.stubGlobal('fetch', fetchMock);
  const result = await service.generateImage({ prompt: 'test', providerId: 'image-vendor', model: 'vendor/flux-custom', workspace: dir });
  expect(result.ok).toBe(true);
  const [url, options] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://images.example/api/v4/images/generations');
  expect(JSON.parse(options.body)).toEqual({ prompt: 'test', model: 'vendor/flux-custom', n: 1, size: '1024x1024' });
  expect(readFileSync(result.localFilePath!, 'utf8')).toBe('image');
});

it('discovers models under the configured provider version path', async () => {
  const { service } = setup();
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'vendor/image' }] })));
  vi.stubGlobal('fetch', fetchMock);
  expect(await service.fetchProviderModels('image-vendor')).toEqual({ ok: true, models: ['vendor/image'] });
  expect(fetchMock.mock.calls[0]![0]).toBe('https://images.example/api/v4/models');
});

function renderer(fetchModels: ReturnType<typeof vi.fn>) {
  const source = readFileSync('src/gui/renderer/app.js', 'utf8');
  const elements: Record<string, any> = {};
  for (const id of ['imageGenProviderSelect', 'imageGenModelSelect', 'doGenerateImageBtn', 'manualImageModelInlineBox', 'manualImageModelInput', 'imageModelStatusChip']) {
    elements[id] = { value: '', innerHTML: '', disabled: false, style: {} };
  }
  elements.imageGenProviderSelect.value = 'vendor-a';
  const context = {
    $: (id: string) => elements[id],
    state: { models: [{ providerId: 'vendor-a', model: 'private-image' }, { providerId: 'vendor-b', model: 'other-model' }] },
    window: { hap: { fetchProviderModels: fetchModels } },
    esc: (value: string) => value,
  };
  const api = runInNewContext('let isGeneratingImage = false;\n' + source.slice(source.indexOf('let imageGenModelsRequest'), source.indexOf('function initAiImageStudio()')) + '\n({ populateImageGenModels, updateImageGenModelChip })', context);
  return { api, elements };
}

it('loads the selected vendor models and keeps configured model names', async () => {
  const fetchModels = vi.fn().mockResolvedValue({ ok: true, models: ['flux-vendor', 'private-image'] });
  const { api, elements } = renderer(fetchModels);
  await api.populateImageGenModels();
  expect(fetchModels).toHaveBeenCalledWith('vendor-a');
  expect(elements.imageGenModelSelect.innerHTML).toContain('flux-vendor');
  expect(elements.imageGenModelSelect.innerHTML).toContain('private-image');
  expect(elements.imageGenModelSelect.innerHTML).not.toContain('other-model');
  expect(elements.imageGenModelSelect.innerHTML).not.toContain('dall-e-3');
});

it('ignores model responses from a previously selected vendor', async () => {
  let resolveFirst!: (value: unknown) => void;
  const fetchModels = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
    .mockResolvedValueOnce({ ok: true, models: ['new-model'] });
  const { api, elements } = renderer(fetchModels);
  const first = api.populateImageGenModels();
  elements.imageGenProviderSelect.value = 'vendor-b';
  await api.populateImageGenModels();
  resolveFirst({ ok: true, models: ['stale-model'] });
  await first;
  expect(elements.imageGenModelSelect.innerHTML).toContain('new-model');
  expect(elements.imageGenModelSelect.innerHTML).not.toContain('stale-model');
});

it('allows a manual model on the selected vendor when model discovery fails', async () => {
  const { api, elements } = renderer(vi.fn().mockRejectedValue(new Error('offline')));
  elements.imageGenProviderSelect.value = 'vendor-c';
  await api.populateImageGenModels();
  expect(elements.imageGenModelSelect.value).toBe('manual:manual');
  expect(elements.doGenerateImageBtn.disabled).toBe(true);
  elements.manualImageModelInput.value = 'custom-image';
  api.updateImageGenModelChip();
  expect(elements.doGenerateImageBtn.disabled).toBe(false);
});
