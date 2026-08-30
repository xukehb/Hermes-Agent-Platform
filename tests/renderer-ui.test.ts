import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererDir = resolve(process.cwd(), 'src/gui/renderer');
const html = readFileSync(resolve(rendererDir, 'index.html'), 'utf8');
const app = readFileSync(resolve(rendererDir, 'app.js'), 'utf8');
const css = readFileSync(resolve(rendererDir, 'styles.css'), 'utf8');

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing section end: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('Electron renderer UI contracts', () => {
  it('keeps every dialog at the top level instead of nesting modal dialogs', () => {
    const dialogTokens = html.matchAll(/<\/?dialog\b[^>]*>/gi);
    let openDialogId: string | null = null;

    for (const match of dialogTokens) {
      const token = match[0];
      if (token.startsWith('</')) {
        expect(openDialogId, 'found a closing dialog without an open dialog').not.toBeNull();
        openDialogId = null;
        continue;
      }

      const id = token.match(/\bid="([^"]+)"/)?.[1] ?? '(unnamed)';
      expect(openDialogId, `dialog ${id} is nested inside ${openDialogId}`).toBeNull();
      openDialogId = id;
    }

    expect(openDialogId, `dialog ${openDialogId} is not closed`).toBeNull();
  });

  it('gives every modal close button one accessible name and tooltip', () => {
    const closeButtons = [...html.matchAll(/<button\b[^>]*class="[^"]*\bbtn-close\b[^"]*"[^>]*>/gi)]
      .map(match => match[0]);

    expect(closeButtons.length).toBeGreaterThan(0);
    for (const button of closeButtons) {
      expect(button).toContain('aria-label="关闭"');
      expect(button).toContain('title="关闭"');
    }
    expect(css).toMatch(/\.btn-close::before\s*{/);
  });

  it('routes Scheduled Tasks to the schedules view', () => {
    const handler = section(app, "$('scheduledTasksBtn')?.addEventListener", '// 快捷导入本地工程');
    expect(handler).toContain("show('schedules')");
    expect(handler).not.toContain("show('logs')");
  });

  it('starts a new conversation with an empty composer', () => {
    const startNewChat = section(app, 'function startNewChat()', '// 顶部 + New Conversation 按钮');
    expect(startNewChat).toMatch(/chatInput[^\n]*value\s*=\s*''/);
    expect(startNewChat).toContain('currentAttachments = []');
    expect(startNewChat).toContain('renderComposerAttachments()');
    expect(startNewChat).toContain('updateComposerState()');
  });

  it('keeps exactly one active tab inside the settings navigation', () => {
    const switchSettingsTab = section(app, 'window.switchSettingsTab =', 'window.switchSettingsSubTab =');
    expect(switchSettingsTab).toContain("document.querySelectorAll('.settings-nav-tabs .settings-tab-btn')");
    expect(switchSettingsTab).toContain("classList.toggle('active', btn.dataset.tab === tabId)");
    expect(switchSettingsTab).not.toContain('btn.style.background');
  });

  it('uses one panorama refresh controller with complete local rendering', () => {
    const assignments = app.match(/window\.refreshHostView\s*=\s*async\s*\(\)\s*=>/g) ?? [];
    expect(assignments).toHaveLength(1);

    const refresh = section(
      app,
      'window.refreshHostView = async () => {',
      '// 快捷运维脚本库与工具箱控制器',
    );
    const localRenderer = section(app, 'function renderLocalHostView(info)', 'let lastHostIpGeo');
    expect(refresh).toContain('renderLocalHostView(info)');
    expect(localRenderer).toContain('p.usedPercent');
    expect(localRenderer).not.toContain('p.usagePercent');
    expect(localRenderer).toContain("$('hostTopProcessList')");
    expect(localRenderer).toContain("$('hostNetworkList')");
    expect(localRenderer).toContain('loadHostIpGeo()');
  });

  it('deduplicates public IP requests across dashboard polling', () => {
    expect(app).toContain('hostIpGeoInFlight');
    expect(app).toContain('HOST_IP_GEO_CACHE_MS');
  });

  it('clears disk scan progress timer on both success and failure paths', () => {
    const scan = section(app, 'async function handleScanDisk(server)', 'function filterDiskItemsByCategory(category)');
    expect(scan).toMatch(/let\s+stepTimer/);
    const finallyBlock = section(scan, '} finally {', '}\n}\n');
    expect(finallyBlock).toContain('clearInterval(stepTimer)');
  });

  it('does not show providers as ready based only on stored credentials', () => {
    expect(app).toContain('healthStatus');
    expect(app).not.toContain("Boolean(p.hasCredential) || p.id === 'ollama' || p.envKey === undefined");
    expect(app).not.toContain("p.hasCredential;");
  });
});
