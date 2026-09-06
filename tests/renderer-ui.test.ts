import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererDir = resolve(process.cwd(), 'src/gui/renderer');
const html = readFileSync(resolve(rendererDir, 'index.html'), 'utf8');
const app = readFileSync(resolve(rendererDir, 'app.js'), 'utf8');
const css = readFileSync(resolve(rendererDir, 'styles.css'), 'utf8');
const preload = readFileSync(resolve(rendererDir, 'preload.cjs'), 'utf8');
const main = readFileSync(resolve(process.cwd(), 'src/gui/main.ts'), 'utf8');

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

  it('derives disk scanner copy from the active platform and roots', () => {
    expect(app).toContain('function getDiskScanContext');
    expect(app).toContain('platformLabel');
    expect(app).toContain('formatDiskRoots');
    expect(app).not.toContain('C:\\\\, D:\\\\ 等');
    expect(app).not.toContain('C:\\\\, D:\\\\ 等)');
  });

  it('does not show providers as ready based only on stored credentials', () => {
    expect(app).toContain('healthStatus');
    expect(app).not.toContain("Boolean(p.hasCredential) || p.id === 'ollama' || p.envKey === undefined");
    expect(app).not.toContain("p.hasCredential;");
  });

  it('exposes remote process diagnostics and kill operations through IPC', () => {
    expect(main).toContain("ipcMain.handle('gui:getServerProcesses'");
    expect(main).toContain("ipcMain.handle('gui:killServerProcess'");
    expect(preload).toContain('getServerProcesses:');
    expect(preload).toContain('killServerProcess:');
    expect(preload).toContain('ipcRenderer.invoke(channel, ...payload)');
  });

  it('keeps disk operations bound to the active panorama target', () => {
    const scan = section(app, 'async function handleScanDisk(server)', 'function filterDiskItemsByCategory');
    expect(scan).toContain('activePanoramaTarget');
    expect(scan).toContain('scanDiskCleanable');

    const cleanup = section(app, 'async function handleCleanDisk(type)', 'window.cleanSingleDiskItem');
    expect(cleanup).toContain('activePanoramaTarget');
    expect(cleanup).toContain('executeDiskCleanup');
  });

  it('renders detailed remote process rows with refresh and guarded TERM/KILL controls', () => {
    expect(html).toContain('hostProcessRefreshBtn');
    expect(html).toContain('hostProcessListTitle');
    expect(app).toContain('getServerProcesses');
    expect(app).toContain('killServerProcess');
    expect(app).toContain('expectedStartTime');
    expect(app).toContain("'TERM'");
    expect(app).toContain("'KILL'");
    expect(app).toContain('showConfirm');
    expect(app).toMatch(/activePanoramaTarget[^\n]*===\s*['"]local['"]/);
  });

  it('does not let a stale node refresh overwrite the newly selected target', () => {
    const refresh = section(
      app,
      'window.refreshHostView = async () => {',
      '// 快捷运维脚本库与工具箱控制器',
    );
    expect(refresh).toContain('hostRefreshQueued');
    expect(refresh).toContain("if (targetId !== (activePanoramaTarget || 'local')) return;");
    expect(refresh).toContain('void window.refreshHostView()');
  });

  it('shows a useful remote process runtime when only startTime is available', () => {
    expect(app).toContain('function getRemoteProcessElapsedSeconds');
    expect(app).toContain('Date.now()');
    expect(app).toContain('getRemoteProcessElapsedSeconds(proc)');
  });

  it('does not synthesize remote health values when fields are unavailable', () => {
    expect(app).not.toContain("'0.12, 0.18, 0.15'");
    expect(app).not.toContain("'0.15, 0.22, 0.18'");
    expect(app).not.toContain("'v18+'");
    expect(app).not.toContain('diskPct || 25');
    expect(app).toContain("'未知'");
  });

  it('supports one-click model clearing in both provider dialog and provider card', () => {
    expect(html).toContain('id="clearAllProviderModelsBtn"');
    expect(html).toContain('id="currentDialogModelsCount"');
    expect(app).toContain("$('clearAllProviderModelsBtn')?.addEventListener('click'");
    expect(app).toContain('window.clearModelsForProvider');
    expect(app).toContain('batchRemoveModels(toDeleteAliases)');
  });

  it('supports configurable Git commit rules with model selection, presets, and live preview', () => {
    expect(html).toContain('id="gitCommitRuleDialog"');
    expect(html).toContain('id="commitRuleEngineSelect"');
    expect(html).toContain('id="commitRuleModelSelect"');
    expect(html).toContain('id="commitRuleLangSelect"');
    expect(html).toContain('id="commitRuleConventionSelect"');
    expect(html).toContain('id="commitRuleDetailSelect"');
    expect(html).toContain('id="commitRuleScopeSelect"');
    expect(html).toContain('id="commitRuleCustomPromptInput"');
    expect(html).toContain('id="commitRulePreviewBox"');
    expect(html).toContain('commit-preset-chip');
    expect(html).toContain('id="currentCommitRuleBadge"');
    expect(html).toContain('window.openCommitRulesModal()');

    expect(app).toContain('DEFAULT_COMMIT_RULES');
    expect(app).toContain('window.openCommitRulesModal =');
    expect(app).toContain('window.updateCommitRulePreview =');
    expect(app).toContain('function updateCommitRuleBadge()');
    expect(app).toContain('saveCommitRules({ engine, model, lang, convention, detailLevel, scope, customPrompt });');
    expect(app).toContain('generateStructuredCommitFallback');
    expect(app).toContain("rules.convention === 'angular'");
    expect(app).toContain("rules.lang === 'bilingual'");
  });

  it('detects Git merge conflicts, renders conflict badges and alert banner with AI resolution', () => {
    expect(html).toContain('id="gitConflictAlertBanner"');
    expect(css).toContain('.git-status-badge.C');
    expect(app).toContain("badgeLabel = '冲突'");
    expect(app).toContain('window.askAiResolveConflicts =');
    expect(app).toContain('window.openVsCodeForProject =');
  });
});


