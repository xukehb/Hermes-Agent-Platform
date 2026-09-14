import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const rendererDir = resolve(root, 'src/gui/renderer');
const html = readFileSync(resolve(rendererDir, 'index.html'), 'utf8');
const app = readFileSync(resolve(rendererDir, 'app.js'), 'utf8');
const css = readFileSync(resolve(rendererDir, 'styles.css'), 'utf8');
const preload = readFileSync(resolve(rendererDir, 'preload.cjs'), 'utf8');
const main = readFileSync(resolve(root, 'src/gui/main.ts'), 'utf8');
const service = readFileSync(resolve(root, 'src/gui/service.ts'), 'utf8');
const server = readFileSync(resolve(root, 'src/web/server.ts'), 'utf8');
const providerOps = readFileSync(resolve(root, 'src/gui/provider-operations.ts'), 'utf8');

describe('Provider & Model GUI & Config Optimizations', () => {
  it('includes expanded preset templates with categorized groups and correct Anthropic URL', () => {
    // Anthropic base URL must be https://api.anthropic.com (without /v1)
    expect(app).toMatch(/anthropic:\s*\{[^}]*baseUrl:\s*'https:\/\/api\.anthropic\.com'/);
    expect(app).not.toMatch(/anthropic:\s*\{[^}]*baseUrl:\s*'https:\/\/api\.anthropic\.com\/v1'/);

    // Domestic providers
    expect(app).toContain('qwen:');
    expect(app).toContain('siliconflow:');
    expect(app).toContain('moonshot:');
    expect(app).toContain('minimax:');
    expect(app).toContain('zhipu:');

    // International providers
    expect(app).toContain('openai:');
    expect(app).toContain('groq:');
    expect(app).toContain('mistral:');
    expect(app).toContain('xai:');

    // Local / private deployment providers
    expect(app).toContain('ollama:');
    expect(app).toContain('lmstudio:');
    expect(app).toContain('vllm:');

    // Categorized groups in preset select
    expect(app).toContain("'国内主流大模型'");
    expect(app).toContain("'国际前沿大模型'");
    expect(app).toContain("'本地与私有化部署'");
    expect(app).toContain('<optgroup label="🌟 ${categoryName}">');
  });

  it('provides metrics dashboard, dual-view mode switcher, search, and capability filters in HTML', () => {
    // Metrics stat cards
    expect(html).toContain('id="statTotalProviders"');
    expect(html).toContain('id="statHealthyProviders"');
    expect(html).toContain('id="statTotalModels"');
    expect(html).toContain('id="statDefaultModel"');

    // View mode segmented buttons
    expect(html).toContain('id="viewModeProvidersBtn"');
    expect(html).toContain('id="viewModeModelsBtn"');

    // Search and filters
    expect(html).toContain('id="pmSearchInput"');
    expect(html).toContain('id="pmStatusFilter"');
    expect(html).toContain('id="pmCapabilityFilter"');

    // Containers
    expect(html).toContain('id="providersViewWrap"');
    expect(html).toContain('id="modelsViewWrap"');
    expect(html).toContain('id="modelsTable"');

    // Remote model filter input
    expect(html).toContain('id="remoteModelFilterInput"');
  });

  it('supports model capabilities, default model toggle, and test button in modelDialog', () => {
    expect(html).toContain('id="modelCapTools"');
    expect(html).toContain('id="modelCapVision"');
    expect(html).toContain('id="modelCapReasoning"');
    expect(html).toContain('id="modelCapStreaming"');
    expect(html).toContain('id="modelCapLongctx"');
    expect(html).toContain('id="modelSetAsDefaultCb"');
    expect(html).toContain('id="testDialogModelBtn"');
  });

  it('exposes global default model and model ping testing through preload IPC and service', () => {
    // Preload
    expect(preload).toContain('setDefaultModel:');
    expect(preload).toContain('testModel:');

    // Main IPC
    expect(main).toContain("ipcMain.handle('gui:setDefaultModel'");
    expect(main).toContain("ipcMain.handle('gui:testModel'");

    // Service methods
    expect(service).toContain('setDefaultModel(rawAlias: string)');
    expect(service).toContain('testModel(rawAlias: string)');
    expect(service).toContain('defaultModel: resolver.resolveDefaultModel()');

    // Provider operations
    expect(providerOps).toContain('export function setDefaultModel');
    expect(providerOps).toContain('export async function testModel');
  });

  it('provides web server REST API endpoints and polyfills for web parity', () => {
    expect(server).toContain("app.post('/api/models/:alias/set-default'");
    expect(server).toContain("app.post('/api/models/:alias/test'");
    expect(server).toContain('setDefaultModel:');
    expect(server).toContain('testModel:');
  });

  it('implements interactive frontend controllers in app.js', () => {
    expect(app).toContain('window.switchProviderModelView =');
    expect(app).toContain('window.onProviderModelSearch =');
    expect(app).toContain('window.onProviderModelFilterChange =');
    expect(app).toContain('window.setGlobalDefaultModel =');
    expect(app).toContain('window.testSingleModel =');
    expect(app).toContain('window.testAllProviders =');
    expect(app).toContain('function renderProviderMetrics()');
    expect(app).toContain('interactive-model-chip');
    expect(app).toContain('cap-pill');
  });

  it('defines necessary CSS rules for modern cards, segmented buttons, chips, and capability pills', () => {
    expect(css).toContain('.btn-segmented');
    expect(css).toContain('.interactive-model-chip');
    expect(css).toContain('.cap-pill');
    expect(css).toContain('.cap-pill.tools');
    expect(css).toContain('.cap-pill.vision');
    expect(css).toContain('.cap-pill.reasoning');
    expect(css).toContain('.models-catalog-table');
  });
});
