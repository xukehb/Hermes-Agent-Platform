import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GUI 桌面悬浮小球模式 (Floating Ball Mode)', () => {
  const root = join(__dirname, '..');
  const rendererDir = join(root, 'src', 'gui', 'renderer');

  it('ball.html, ball.css, ball.js 模板文件均已就绪且完整', () => {
    const htmlPath = join(rendererDir, 'ball.html');
    const cssPath = join(rendererDir, 'ball.css');
    const jsPath = join(rendererDir, 'ball.js');

    expect(existsSync(htmlPath)).toBe(true);
    expect(existsSync(cssPath)).toBe(true);
    expect(existsSync(jsPath)).toBe(true);

    const html = readFileSync(htmlPath, 'utf8');
    const css = readFileSync(cssPath, 'utf8');
    const js = readFileSync(jsPath, 'utf8');

    // 核心悬浮球与展开面板元素
    expect(html).toContain('id="ballWidget"');
    expect(html).toContain('id="ballPanel"');
    expect(html).toContain('id="ballRestoreMainBtn"');
    expect(html).toContain('id="ballChatMessages"');
    expect(html).toContain('id="ballInputText"');
    expect(html).toContain('id="ballSendBtn"');
    expect(html).toContain('id="ballClearChatBtn"');
    expect(html).toContain('id="ballNewChatBtn"');
    expect(html).toContain('id="ballPinBtn"');
    expect(html).toContain('id="ballCollapseBtn"');
    expect(html).toContain('id="ballMinimizeTaskbarBtn"');

    // CSS 样式具备小球折叠与展开面板的样式规则
    expect(css).toContain('.ball-widget');
    expect(css).toContain('.ball-panel');
    expect(css).toContain('.btn-restore-full');
    expect(css).toContain('.ball-glow-ring');
    expect(css).toContain('ball-mode-collapsed');
    expect(css).toContain('ball-mode-expanded');

    // JS 具备拖拽、放大还原、快捷对话流、收起展开逻辑
    expect(js).toContain('moveBallWindow');
    expect(js).toContain('restoreFromBall');
    expect(js).toContain('setBallExpanded');
    expect(js).toContain('minimizeToTaskbar');
    expect(js).toContain('restoreMainWindow');
  });

  it('preload.cjs 完整暴露悬浮球与主题同步相关 IPC 接口', () => {
    const preloadPath = join(rendererDir, 'preload.cjs');
    const preloadContent = readFileSync(preloadPath, 'utf8');

    expect(preloadContent).toContain("enterBallMode: () => call('gui:ball:enter')");
    expect(preloadContent).toContain("restoreFromBall: () => call('gui:ball:restore')");
    expect(preloadContent).toContain("minimizeToTaskbar: () => call('gui:ball:minimizeToTaskbar')");
    expect(preloadContent).toContain("setBallExpanded: (expanded) => call('gui:ball:setExpanded'");
    expect(preloadContent).toContain("moveBallWindow: (deltaX, deltaY) => call('gui:ball:move'");
    expect(preloadContent).toContain("getBallState: () => call('gui:ball:getState')");
    expect(preloadContent).toContain("onBallModeChanged: (callback) =>");
    expect(preloadContent).toContain("syncThemeToBall: (payload) => call('gui:theme:sync'");
    expect(preloadContent).toContain("onThemeChanged: (callback) =>");
  });

  it('main.ts 包含拦截最小化为小球、显瘦尺寸定义及放大还原处理', () => {
    const mainPath = join(root, 'src', 'gui', 'main.ts');
    const mainContent = readFileSync(mainPath, 'utf8');

    expect(mainContent).toContain("ipcMain.handle('gui:ball:enter'");
    expect(mainContent).toContain("ipcMain.handle('gui:ball:restore'");
    expect(mainContent).toContain("ipcMain.handle('gui:ball:minimizeToTaskbar'");
    expect(mainContent).toContain("ipcMain.handle('gui:ball:setExpanded'");
    expect(mainContent).toContain("ipcMain.handle('gui:ball:move'");
    expect(mainContent).toContain("ipcMain.handle('gui:theme:sync'");
    expect(mainContent).toContain("window.on('minimize'");
    expect(mainContent).toContain('switchToBallMode();');
    expect(mainContent).toContain('restoreFromBall();');

    // 显瘦尺寸验证：小球收紧至 64，展开面板修长收窄至 306
    expect(mainContent).toContain('const BALL_SIZE = 64;');
    expect(mainContent).toContain('const PANEL_WIDTH = 306;');
    expect(mainContent).toContain('const PANEL_HEIGHT = 470;');
  });

  it('小球与面板完全跟随系统配色体系，并具备显瘦轻量样式规范', () => {
    const htmlPath = join(rendererDir, 'ball.html');
    const cssPath = join(rendererDir, 'ball.css');
    const jsPath = join(rendererDir, 'ball.js');

    const html = readFileSync(htmlPath, 'utf8');
    const css = readFileSync(cssPath, 'utf8');
    const js = readFileSync(jsPath, 'utf8');

    // 1. 引入 styles.css 确保继承全部 8 套主题配色变量
    expect(html).toContain('href="./styles.css"');

    // 2. CSS 中全面引用语义化主题变量
    expect(css).toContain('var(--primary');
    expect(css).toContain('var(--accent');
    expect(css).toContain('var(--accent-glow');
    expect(css).toContain('var(--glass-bg');
    expect(css).toContain('[data-theme="light"]');

    // 3. 小球瘦身与修长流线比例验证
    expect(css).toContain('width: 44px;');
    expect(css).toContain('height: 44px;');

    // 4. JS 中包含动态跟随当前主题的控制器
    expect(js).toContain('applyBallTheme');
    expect(js).toContain('onThemeChanged');
    expect(js).toContain("localStorage.getItem('hap_theme')");
  });

  it('index.html 顶栏提供直达悬浮小球的快捷胶囊按钮', () => {
    const indexPath = join(rendererDir, 'index.html');
    const indexContent = readFileSync(indexPath, 'utf8');

    expect(indexContent).toContain('id="floatingBallToggleBtn"');
    expect(indexContent).toContain('data-i18n="header.ballMode"');
    expect(indexContent).toContain('data-i18n-title="header.ballModeTooltip"');
  });

  it('多次缩小/还原时，小球折叠状态保持重置与防穿透防护', () => {
    const mainPath = join(root, 'src', 'gui', 'main.ts');
    const mainContent = readFileSync(mainPath, 'utf8');
    const jsPath = join(rendererDir, 'ball.js');
    const jsContent = readFileSync(jsPath, 'utf8');
    const preloadPath = join(rendererDir, 'preload.cjs');
    const preloadContent = readFileSync(preloadPath, 'utf8');

    // 主进程在每次进入小球或还原时均发送 resetCollapsed 重置状态并重置窗口尺寸
    expect(mainContent).toContain("win.webContents.send('gui:ball:resetCollapsed')");
    expect(mainContent).toContain("ballWindow.webContents.send('gui:ball:resetCollapsed')");

    // preload 和渲染进程正确监听并重置 DOM 为 ball-mode-collapsed
    expect(preloadContent).toContain("onBallReset: (callback) =>");
    expect(jsContent).toContain('resetToCollapsed');
    expect(jsContent).toContain('window.hap?.onBallReset');
  });
});
