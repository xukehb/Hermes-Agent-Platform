import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { OPEN_SOURCE_MODEL_CATALOG } from '../src/system/model-catalog.js';
import { getDockerRecipe } from '../src/system/docker-models.js';

const source = readFileSync('src/gui/renderer/app.js', 'utf8');
const render = source.slice(source.indexOf('function renderModelHubCards()'), source.indexOf('function updateHubCardProgress('));
function card(blockers: string[], status = 'absent') {
  const container = { innerHTML: '' };
  const id = 'whisper:base';
  runInNewContext(`${render}; renderModelHubCards();`, {
    $: () => container,
    hubCurrentProfile: { evaluations: [{ model: OPEN_SOURCE_MODEL_CATALOG.find(m => m.id === id), tier: 'best', tierLabel: '需独立部署', expectedTokPerSec: '需实测', rationale: 'Docker', isInstalled: false }] },
    hubDockerState: { available: true, models: [{ id, status }], recipes: [{ ...getDockerRecipe(id), blockers }] },
    hubDownloadProgressMap: new Map(), hubDockerProgress: new Map(), hubActiveCategory: 'all', hubSearchKeyword: '',
    esc: String, escJs: String,
  });
  return container.innerHTML;
}
describe('Docker model hub UI', () => {
  it('offers Docker rather than Ollama pull for an external model', () => {
    const html = card([]);
    expect(html).toContain('window.deployDockerHubModel');
    expect(html).not.toContain('window.pullHubModel');
    expect(html).toMatch(/class="btn primary"\s+onclick="window.deployDockerHubModel/);
  });
  it('disables deployment and explains an unmet prerequisite', () => {
    const html = card(['Docker 内存不足']);
    expect(html).toContain('Docker 内存不足');
    expect(html).toMatch(/disabled onclick="window.deployDockerHubModel/);
  });
  it('offers dedicated inference docs only after health is ready', () => {
    expect(card([], 'ready')).toContain('http://127.0.0.1:8202/docs');
    expect(card([], 'loading')).not.toContain('http://127.0.0.1:8202/docs');
  });
});
