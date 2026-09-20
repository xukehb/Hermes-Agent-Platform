import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererDir = resolve(process.cwd(), 'src/gui/renderer');
const html = readFileSync(resolve(rendererDir, 'index.html'), 'utf8');
const app = readFileSync(resolve(rendererDir, 'app.js'), 'utf8');
const css = readFileSync(resolve(rendererDir, 'styles.css'), 'utf8');
const preload = readFileSync(resolve(rendererDir, 'preload.cjs'), 'utf8');
const i18n = readFileSync(resolve(rendererDir, 'i18n.js'), 'utf8');
const main = readFileSync(resolve(process.cwd(), 'src/gui/main.ts'), 'utf8');
const serviceSource = readFileSync(resolve(process.cwd(), 'src/gui/service.ts'), 'utf8');

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

  it('offers style themes plus a custom accent theme', () => {
    // 用户对风格偏好差异很大：除中性深浅两套外，必须保留多风格主题与自定义强调色
    const themeIds = ['light', 'dark', 'cyber', 'aurora', 'sunset', 'glass', 'vibrant', 'custom'];
    const themeList = /const AVAILABLE_THEMES = \[([^\]]*)\]/.exec(app)?.[1] ?? '';
    for (const id of themeIds) {
      expect(themeList, `AVAILABLE_THEMES is missing ${id}`).toContain(`'${id}'`);
      expect(html, `missing quick theme chip for ${id}`).toContain(`data-theme-id="${id}"`);
      expect(i18n, `missing i18n entry for theme.${id}`).toContain(`'theme.${id}'`);
    }
    expect((html.match(/class="theme-select-card"/g) ?? []).length).toBe(themeIds.length);

    // 每套风格主题都必须带自己的真实色板，不能再被兼容层折叠成同一套深色
    expect(css).toMatch(/\[data-theme="cyber"\]\s*\{[^}]*--bg-app:\s*#070614/);
    expect(css).toMatch(/\[data-theme="aurora"\]\s*\{[^}]*--bg-app:\s*#061210/);
    expect(css).toMatch(/\[data-theme="sunset"\]\s*\{[^}]*--bg-app:\s*#120d0b/);
    expect(css).toMatch(/\[data-theme="vibrant"\]\s*\{[^}]*--bg-app:\s*#080a18/);

    // 自定义主题：底色沿用浅 / 深色板，强调色由运行时注入
    expect(css).toContain('[data-theme="custom"] {');
    expect(css).toContain('[data-theme="custom"][data-custom-base="dark"]');
    for (const token of [
      'CUSTOM_THEME_STORAGE',
      'DEFAULT_CUSTOM_ACCENT',
      'buildCustomAccentVars',
      'clearCustomThemeVars',
      'setCustomThemeAccent',
      'setCustomThemeBase',
      'initCustomThemeControls',
    ]) {
      expect(app).toContain(token);
    }
    expect(html).toContain('class="custom-theme-color-input"');
    expect(html).toContain('class="custom-theme-base-btn"');
  });

  it('pins the settings title bar and scrolls only the settings content', () => {
    // 回归：设置页此前整页滚动，标题栏会被内容推走。现在标题栏固定，
    // 左侧菜单与右侧面板各自独立滚动。
    expect(css).toMatch(/#settings\.view\.active\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/#settings\.view\.active\s*\{[^}]*overflow:\s*hidden/);
    const header = section(css, '#settings > .page-container > .page-header-row {', '.settings-layout {');
    expect(header).toContain('flex: 0 0 auto');
    expect(header).toContain('border-bottom');
    const panes = section(css, '#settings .settings-panes {', '/* 窄屏回落为横向换行标签');
    expect(panes).toContain('overflow-y: auto');
    expect(panes).toContain('min-height: 0');
    const nav = section(css, '#settings .settings-layout > .settings-nav-tabs {', '#settings .settings-panes {');
    expect(nav).toContain('overflow-y: auto');
    expect(nav).toContain('position: static');
  });

  it('keeps the header capsule group from shrinking below its content', () => {
    // 回归：顶栏空间紧张时胶囊群组被压缩，「小 i」按钮只剩 17px 文字宽度，
    // 右侧半个字被圆角边框切掉。群组与按钮都必须保持内容宽度且不换行。
    const group = section(css, '.header-capsule-group {', '.header-capsule-group .btn {');
    expect(group).toContain('flex-shrink: 0');
    const button = section(css, '.header-capsule-group .btn {', '.header-capsule-group .btn:hover');
    expect(button).toContain('white-space: nowrap !important');
    expect(button).toContain('flex-shrink: 0 !important');
  });

  it('keeps toast notifications from covering the header controls', () => {
    // 回归：提示条曾固定在 y=18px，正好压住顶栏右侧的 Git / 小 i / 外观 / 语言 /
    // 操作 按钮并吞掉点击，用户切到英文后再也点不回中文，只能刷新页面。
    const container = section(css, '.toast-container {', 'dialog .toast-container,');
    const top = Number(/top:\s*(\d+)px/.exec(container)?.[1] ?? '0');
    expect(top).toBeGreaterThanOrEqual(48);
    // 提示条本身不参与交互，避免任何位置遮挡
    expect(css).toMatch(/\.toast\s*\{[^}]*pointer-events:\s*none/);
    expect(css).not.toMatch(/\.toast\s*\{[^}]*pointer-events:\s*auto/);
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

  it('supports configurable Git commit rules with Markdown document, presets, and live preview', () => {
    expect(html).toContain('id="gitCommitRuleDialog"');
    expect(html).toContain('id="commitRuleMarkdownInput"');
    expect(html).toContain('id="commitRulePresetSelect"');
    expect(html).toContain('id="commitRuleModelSelect"');
    expect(html).toContain('id="commitRuleMarkdownRendered"');
    expect(html).toContain('id="currentCommitRuleBadge"');
    expect(html).toContain('window.openCommitRulesModal()');
    expect(html).toContain('id="saveToProjectFileBtn"');
    expect(html).toContain('id="loadFromProjectFileBtn"');

    expect(app).toContain('DEFAULT_COMMIT_RULES');
    expect(app).toContain('COMMIT_RULE_PRESETS');
    expect(app).toContain('window.openCommitRulesModal =');
    expect(app).toContain('window.switchCommitRuleTab =');
    expect(app).toContain('function updateCommitRuleBadge()');
    expect(app).toContain('saveCommitRules({ model, markdownDoc, presetKey });');
    expect(app).toContain('generateStructuredCommitFallback');
    expect(preload).toContain("getProjectCommitRule: (projectPath) => call('gui:getProjectCommitRule', projectPath)");
    expect(preload).toContain("saveProjectCommitRule: (projectPath, content, fileName) => call('gui:saveProjectCommitRule'");
    expect(main).toContain("ipcMain.handle('gui:getProjectCommitRule'");
    expect(main).toContain("ipcMain.handle('gui:saveProjectCommitRule'");
    expect(serviceSource).toContain('getProjectCommitRule(projectPath: string)');
    expect(serviceSource).toContain('saveProjectCommitRule(projectPath: string, content: string');
  });

  it('detects Git merge conflicts, renders conflict badges and alert banner with AI resolution', () => {
    expect(html).toContain('id="gitConflictAlertBanner"');
    expect(css).toContain('.git-status-badge.C');
    expect(app).toContain("badgeLabel = '冲突'");
    expect(app).toContain('window.askAiResolveConflicts =');
    expect(app).toContain('window.openVsCodeForProject =');
  });

  it('supports clearing default providers and models with one-click action and confirmation', () => {
    expect(html).toContain('id="clearDefaultProvidersBtn"');
    expect(app).toContain('window.clearDefaultProviders =');
    expect(app).toContain('window.restoreDefaultProviders =');
    expect(app).toContain('window.hap.clearDefaultProviders()');
    expect(app).toContain('window.hap.restoreDefaultProviders()');
    expect(preload).toContain("clearDefaultProviders: () => call('gui:clearDefaultProviders')");
    expect(preload).toContain("restoreDefaultProviders: () => call('gui:restoreDefaultProviders')");
    expect(main).toContain("ipcMain.handle('gui:clearDefaultProviders'");
    expect(main).toContain("ipcMain.handle('gui:restoreDefaultProviders'");
    expect(serviceSource).toContain('clearDefaultProviders(): object');
    expect(serviceSource).toContain('restoreDefaultProviders(): object');
  });

  it('ensures all modals only close on close button (X), not on backdrop click or Escape key', () => {
    // Backdrop click close must NOT exist
    expect(app).not.toMatch(/if\s*\(\s*e\.target\s*===\s*modal\s*\)\s*modal\.close\(\)/);

    // Cancel event (Escape key) must be prevented
    expect(app).toContain("modal.addEventListener('cancel'");
    expect(app).toContain('e.preventDefault()');

    // All .btn-close buttons are bound to modal.close()
    expect(app).toContain("modal.querySelectorAll('.btn-close')");
    expect(app).toContain('if (modal.open) modal.close()');
  });

  it('safely renders diff hunks with structured DiffLine objects without throwing line.startsWith error', () => {
    expect(app).toContain('buildHunkPatchString');
    expect(app).toContain('formatGitDiffToHtml');
    // Ensure hunk.lines supports object structure ({ type, content })
    expect(app).toContain("line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '");
    // Ensure hunk badge shows chunk range and header
    expect(app).toContain('const hunkBadge = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@');
  });

  it('implements the personalized background image and wallpaper system', () => {
    // 1. DOM layer presence
    expect(html).toContain('id="appWallpaperLayer"');
    expect(html).toContain('id="appWallpaperOverlay"');
    expect(html).toContain('class="theme-wallpaper-section"');
    expect(html).toContain('class="wallpaper-cards-grid"');
    expect(html).toContain('id="uploadWallpaperBtn"');
    expect(html).toContain('id="wallpaperFileInput"');
    expect(html).toContain('id="wallpaperUrlInput"');
    expect(html).toContain('id="wallpaperOpacityRange"');
    expect(html).toContain('id="wallpaperBlurRange"');
    expect(html).toContain('id="wallpaperDimRange"');
    expect(html).toContain('id="wallpaperFitSelect"');
    expect(html).toContain('id="popoverWallpaperChips"');

    // 2. CSS rules
    expect(css).toContain('.app-wallpaper-layer');
    expect(css).toContain('.app-wallpaper-overlay');
    expect(css).toContain('body.has-wallpaper');
    expect(css).toContain('.wp-preset-nebula');
    expect(css).toContain('.wp-preset-cyber');
    expect(css).toContain('.wp-preset-aurora');
    expect(css).toContain('.wp-preset-sunset');
    expect(css).toContain('.wp-preset-mesh');
    expect(css).toContain('.wp-preset-carbon');
    expect(css).toContain('.wallpaper-card');
    expect(css).toContain('.wallpaper-quick-chip');

    // 3. Controller functions in app.js
    expect(app).toContain('AVAILABLE_WALLPAPERS');
    expect(app).toContain('initWallpaperSystem()');
    expect(app).toContain('applyWallpaper(');
    expect(app).toContain('setWallpaperOpacity(');
    expect(app).toContain('setWallpaperBlur(');
    expect(app).toContain('setWallpaperDim(');
    expect(app).toContain('setWallpaperFit(');
    expect(app).toContain('compressImageForWallpaper(');

    // 4. i18n support
    expect(i18n).toContain("'wallpaper.sectionTitle'");
    expect(i18n).toContain("'wallpaper.uploadBtn'");
    expect(i18n).toContain("'wallpaper.nebula'");
    expect(i18n).toContain("'wallpaper.cyber'");
    expect(i18n).toContain("'wallpaper.aurora'");
  });

  it('derives component accent and contrast text colors from the wallpaper', () => {
    // 1. Toggle in the wallpaper section
    expect(html).toContain('id="wallpaperAdaptiveToggle"');
    expect(html).toContain('class="wallpaper-adaptive-row"');
    expect(html).toContain('data-i18n="wallpaper.adaptiveTitle"');

    // 2. Pixel analysis + accent derivation
    expect(app).toContain('function refreshWallpaperDerivedTheme(');
    expect(app).toContain('function analyzeWallpaperPixels(');
    expect(app).toContain('function wpRelativeLuminance(');
    expect(app).toContain('function buildWallpaperDerivedVars(');
    expect(app).toContain('function sampleWallpaperImage(');
    expect(app).toContain("'--wp-on-accent'");
    expect(app).toContain("'--wp-on-wallpaper'");
    expect(app).toContain('WALLPAPER_PRESET_ACCENTS');
    // 以真实对比度决定白色或黑色冲突文本色
    expect(app).toContain('function wpContrastTextForLuminance(');
    expect(app).toContain("return whiteContrast >= blackContrast ? '#ffffff' : '#09090b';");
    expect(app).toContain('wpContrastTextForLuminance(effectiveLuminance)');
    expect(app).toContain('wpContrastTextForLuminance(wpRelativeLuminance(main.r, main.g, main.b))');
    // 壁纸 / 遮罩 / 透明度变化后重新对账
    expect(app).toContain('refreshWallpaperDerivedTheme();');

    // 3. CSS 派生规则默认回退到主题强调色，仅在启用取色时生效
    expect(css).toContain('--wp-accent: var(--primary-black)');
    expect(css).toContain('--wp-on-accent: var(--bg-app)');
    expect(css).toContain('html[data-wp-adaptive="on"] body.has-wallpaper .btn.primary');
    expect(css).toContain('html[data-wp-adaptive="on"] body.has-wallpaper .theme-quick-chip.active');
    expect(css).toContain('.wallpaper-adaptive-row');

    // 4. i18n
    expect(i18n).toContain("'wallpaper.adaptiveTitle'");
    expect(i18n).toContain("'wallpaper.adaptiveDesc'");
    expect(i18n).toContain("'wallpaper.adaptiveOnToast'");
    expect(i18n).toContain("'wallpaper.adaptiveOffToast'");
  });

  it('keeps keyboard focus rings, motion preferences and theme tokens consistent', () => {
    // 1. 键盘可见焦点环：元素选择器需能压过组件里的 outline: none
    expect(css).toMatch(/button:focus-visible[\s\S]{0,400}outline: 2px solid var\(--border-focus\)/);
    expect(css).toContain('[tabindex]:not([tabindex="-1"]):focus-visible');
    expect(css).toContain('.btn.btn-danger:focus-visible');

    // 2. 尊重系统「减弱动态效果」
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,400}animation-duration: 0\.001ms !important/);
    expect(app).toContain('function prefersReducedMotion()');
    expect(app).toContain('function scrollToElementSmooth(');
    expect(app).not.toContain("scrollIntoView({ behavior: 'smooth'");

    // 3. 异步提示需要 aria-live，屏幕阅读器才会播报
    expect(html).toMatch(/id="toastContainer"[^>]*role="status"/);
    expect(html).toMatch(/id="toastContainer"[^>]*aria-live="polite"/);

    // 4. 残留的硬编码蓝色强调色已全部收敛到主题令牌
    expect(css).not.toContain('rgba(2, 132, 199');
    expect(css).not.toContain('%230284c7');
    expect(css).toContain('color-mix(in srgb, var(--border-focus) 20%, transparent)');
  });

  it('collapses the rail into an icon-only bar on narrow screens', () => {
    const narrowScreen = section(css, '@media (max-width: 768px) {', '@media (max-width: 560px) {');
    const lastBreakpoint = css.slice(css.indexOf('窄屏（≤768px）优化'));

    // 文字标签在 70px 图标栏里必须隐藏，否则会出现逐字竖排的破碎排版
    expect(lastBreakpoint).toMatch(/\.global-nav-item span[\s\S]{0,400}display: none !important/);
    expect(lastBreakpoint).toContain('.new-conversation-btn span');
    expect(lastBreakpoint).toContain('.sidebar-bottom-panel .nav span');
    expect(lastBreakpoint).toMatch(/\.global-nav-item \{[^}]*justify-content: center/);

    // 工具条与筛选项在小屏换行，防止下拉框被裁切
    expect(lastBreakpoint).toMatch(/\.provider-toolbar-filters \{[^}]*flex-wrap: wrap/);
    expect(lastBreakpoint).toMatch(/\.provider-toolbar-filters select \{[^}]*max-width: none/);
    expect(narrowScreen.length).toBeGreaterThan(0);
  });

  it('keeps placeholder text above the 4.5:1 contrast bar in every theme', () => {
    const hexLuminance = (hex: string): number => {
      const clean = hex.trim().replace('#', '');
      const channels = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
      const [r, g, b] = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string): number => {
      const [hi, lo] = [hexLuminance(a), hexLuminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };

    const themes = ['light', 'dark', 'cyber', 'aurora', 'sunset', 'vibrant'];
    themes.forEach((theme) => {
      const marker = theme === 'light'
        ? ':root,\n[data-theme="light"] {'
        : theme === 'dark'
          ? '[data-theme="dark"],\n[data-theme="custom"][data-custom-base="dark"] {'
          : `[data-theme="${theme}"] {`;
      const block = section(css, marker, '}');
      const read = (token: string): string => {
        const match = new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{3,8})`).exec(block);
        if (!match || !match[1]) throw new Error(`${theme} is missing a --${token} hex value`);
        return match[1];
      };
      const ratio = contrast(read('text-placeholder'), read('bg-app'));
      expect(ratio, `${theme} placeholder contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    });
  });

  it('polishes theme switching, text selection and touch interaction details', () => {
    // 1. 主题切换期间临时关闭过渡，避免整页元素同时补间
    expect(app).toContain('function suppressThemeTransitions()');
    expect(app).toContain("root.classList.add('theme-switching')");
    expect(css).toMatch(/html\.theme-switching \*[\s\S]{0,200}transition: none !important/);

    // 2. 选中文本跟随主题色，深色代码块与浅色正文都清晰
    expect(css).toMatch(/::selection \{[^}]*color-mix\(in srgb, currentColor 26%, transparent\)/);

    // 3. 触屏点按高光与文本自动缩放
    expect(css).toContain('-webkit-tap-highlight-color: transparent');
    expect(css).toContain('text-size-adjust: 100%');

    // 4. 数字徽标等宽数字，数值变化不抖动
    expect(css).toMatch(/\.opacity-value-badge[\s\S]{0,200}font-variant-numeric: tabular-nums/);
  });

  it('resolves every data-i18n key in both languages', () => {
    const readDict = (lang: string): Map<string, string> => {
      const start = i18n.indexOf(`'${lang}': {`);
      expect(start, `missing dictionary ${lang}`).toBeGreaterThanOrEqual(0);
      const body = i18n.slice(start, i18n.indexOf('\n    },', start));
      const map = new Map<string, string>();
      // 词条值可能用单引号，也可能因为包含撇号而改用双引号
      const re = /'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body))) map.set(m[1]!, m[2] ?? m[3] ?? '');
      return map;
    };

    const zhDict = readDict('zh-CN');
    const enDict = readDict('en-US');

    // 1. 两种语言的词条必须完全对齐，缺一条就会出现「切不回中文 / 切不到英文」
    const onlyZh = [...zhDict.keys()].filter((k) => !enDict.has(k));
    const onlyEn = [...enDict.keys()].filter((k) => !zhDict.has(k));
    expect(onlyZh, `en-US 缺少词条: ${onlyZh.join(', ')}`).toEqual([]);
    expect(onlyEn, `zh-CN 缺少词条: ${onlyEn.join(', ')}`).toEqual([]);

    // 2. 模板里用到的每一个 data-i18n* 键都必须能在词条表里解析出来
    const used = new Set<string>();
    const attrRe = /data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g;
    let hit: RegExpExecArray | null;
    while ((hit = attrRe.exec(html))) used.add(hit[1]!);
    expect(used.size).toBeGreaterThan(100);

    const missingZh = [...used].filter((k) => !zhDict.has(k));
    const missingEn = [...used].filter((k) => !enDict.has(k));
    expect(missingZh, `模板引用但 zh-CN 缺失: ${missingZh.join(', ')}`).toEqual([]);
    expect(missingEn, `模板引用但 en-US 缺失: ${missingEn.join(', ')}`).toEqual([]);
  });

  it('implements macOS frameless titlebar with traffic light avoidance and unified drag header', () => {
    // 1. Electron BrowserWindow config
    expect(main).toContain("titleBarStyle: 'hidden'");
    expect(main).toContain('trafficLightPosition: { x: 16, y: 15 }');

    // 2. Preload API
    expect(preload).toContain("isMac: process.platform === 'darwin'");

    // 3. HTML structure
    expect(html).toContain('rail-mac-spacer');
    expect(html).toContain('platform-mac');

    // 4. CSS drag regions and macOS traffic lights spacer
    expect(css).toContain('.rail-mac-spacer');
    expect(css).toContain('-webkit-app-region: drag');
  });
});
