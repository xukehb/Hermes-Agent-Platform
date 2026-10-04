import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, screen, session, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopUpdateController, type DesktopUpdaterAdapter } from './desktop-updater.js';
import { installMacUpdateInPlace } from './mac-updater.js';
import { GuiService } from './service.js';

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

// 修复 Linux (特别是 NVIDIA / Nouveau 显卡驱动环境) 下 Chromium GL VSync 报错与崩溃问题
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('disable-features', 'UseChromeOSDirectVideoDecoder');
}

const service = new GuiService();
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const { autoUpdater } = electronUpdater;
const updaterAdapter: DesktopUpdaterAdapter = {
  get autoDownload() { return autoUpdater.autoDownload; },
  set autoDownload(value) { autoUpdater.autoDownload = value; },
  get autoInstallOnAppQuit() { return autoUpdater.autoInstallOnAppQuit; },
  set autoInstallOnAppQuit(value) { autoUpdater.autoInstallOnAppQuit = value; },
  on(event, listener) {
    autoUpdater.on(event, listener as never);
    return this;
  },
  checkForUpdates: () => autoUpdater.checkForUpdates(),
  downloadUpdate: () => autoUpdater.downloadUpdate(),
  quitAndInstall: (isSilent, isForceRunAfter) => autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
};
const desktopUpdater = new DesktopUpdateController({
  updater: updaterAdapter,
  isPackaged: app.isPackaged,
  currentVersion: app.getVersion(),
  onCheckError: (error) => service.error(`检查 GitHub 更新失败：${error.message}`),
  customInstall: async () => {
    if (process.platform === 'darwin' && app.isPackaged) {
      try {
        const ok = await installMacUpdateInPlace({
          appExit: () => app.exit(0),
        });
        if (ok) return true;
      } catch (error) {
        service.error(
          `macOS 原生平滑更新执行失败: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return false;
  },
});

let mainWindow: BrowserWindow | null = null;
let isMiniMode = false;
let normalBounds: Electron.Rectangle | null = null;

// 悬浮小球 (Floating Ball) 窗口状态管理
let ballWindow: BrowserWindow | null = null;
let isBallMode = false;
let bypassMinimizeToBall = false;
let ballPos = { x: -1, y: -1 };
let isBallExpanded = false;

const BALL_SIZE = 64;
const PANEL_WIDTH = 306;
const PANEL_HEIGHT = 470;

function rendererPath(file: string): string {
  return join(__dirname, 'renderer', file);
}

function ensureBallWindow(): BrowserWindow {
  if (ballWindow && !ballWindow.isDestroyed()) {
    return ballWindow;
  }
  const isMac = process.platform === 'darwin';
  ballWindow = new BrowserWindow({
    width: BALL_SIZE,
    height: BALL_SIZE,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: rendererPath('preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isMac) {
    ballWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    ballWindow.setAlwaysOnTop(true, 'floating');
  } else {
    ballWindow.setAlwaysOnTop(true, 'screen-saver');
  }

  ballWindow.on('closed', () => {
    ballWindow = null;
  });

  void ballWindow.loadFile(rendererPath('ball.html'));
  return ballWindow;
}

function switchToBallMode(): void {
  if (isBallMode) return;
  isBallMode = true;
  isBallExpanded = false;

  const win = ensureBallWindow();
  const targetBounds = mainWindow ? mainWindow.getBounds() : { x: 0, y: 0, width: 1000, height: 700 };
  const currentDisplay = screen.getDisplayMatching(targetBounds);
  const workArea = currentDisplay.workArea;

  if (ballPos.x === -1 || ballPos.y === -1) {
    ballPos.x = Math.round(workArea.x + workArea.width - BALL_SIZE - 30);
    ballPos.y = Math.round(workArea.y + workArea.height - BALL_SIZE - 100);
  } else {
    ballPos.x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - BALL_SIZE, ballPos.x));
    ballPos.y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - BALL_SIZE, ballPos.y));
  }

  win.setBounds({ x: ballPos.x, y: ballPos.y, width: BALL_SIZE, height: BALL_SIZE });

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
  win.webContents.send('gui:ball:resetCollapsed');
  win.show();
  mainWindow?.webContents.send('gui:ball:modeChanged', true);
}

function restoreFromBall(): void {
  if (!isBallMode) return;
  isBallMode = false;
  isBallExpanded = false;

  if (ballWindow && !ballWindow.isDestroyed()) {
    ballWindow.webContents.send('gui:ball:resetCollapsed');
    ballWindow.setBounds({ x: ballPos.x, y: ballPos.y, width: BALL_SIZE, height: BALL_SIZE });
    ballWindow.hide();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
    mainWindow.webContents.send('gui:ball:modeChanged', false);
  }
}

function minimizeToTaskbar(): void {
  isBallMode = false;
  isBallExpanded = false;

  if (ballWindow && !ballWindow.isDestroyed()) {
    ballWindow.webContents.send('gui:ball:resetCollapsed');
    ballWindow.setBounds({ x: ballPos.x, y: ballPos.y, width: BALL_SIZE, height: BALL_SIZE });
    ballWindow.hide();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    bypassMinimizeToBall = true;
    mainWindow.show();
    mainWindow.minimize();
    mainWindow.webContents.send('gui:ball:modeChanged', false);
  }
}

function setBallExpanded(expanded: boolean): void {
  if (!ballWindow || ballWindow.isDestroyed()) return;
  isBallExpanded = expanded;
  const currentDisplay = screen.getDisplayMatching({ x: ballPos.x, y: ballPos.y, width: BALL_SIZE, height: BALL_SIZE });
  const workArea = currentDisplay.workArea;

  if (expanded) {
    const targetX = Math.max(
      workArea.x + 10,
      Math.min(workArea.x + workArea.width - PANEL_WIDTH - 10, ballPos.x - (PANEL_WIDTH - BALL_SIZE))
    );
    const targetY = Math.max(
      workArea.y + 10,
      Math.min(workArea.y + workArea.height - PANEL_HEIGHT - 10, ballPos.y - (PANEL_HEIGHT - BALL_SIZE))
    );
    ballWindow.setBounds({ x: targetX, y: targetY, width: PANEL_WIDTH, height: PANEL_HEIGHT });
  } else {
    ballWindow.setBounds({ x: ballPos.x, y: ballPos.y, width: BALL_SIZE, height: BALL_SIZE });
  }
}

function moveBallWindow(deltaX: number, deltaY: number): void {
  if (!ballWindow || ballWindow.isDestroyed() || isBallExpanded) return;
  ballPos.x += Math.round(deltaX);
  ballPos.y += Math.round(deltaY);

  const currentDisplay = screen.getDisplayMatching({ x: ballPos.x, y: ballPos.y, width: BALL_SIZE, height: BALL_SIZE });
  const workArea = currentDisplay.workArea;
  ballPos.x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - BALL_SIZE, ballPos.x));
  ballPos.y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - BALL_SIZE, ballPos.y));

  ballWindow.setPosition(ballPos.x, ballPos.y);
}

async function invoke<T>(handler: () => Promise<T> | T): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await handler() };
  } catch (error) {
    service.error(error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function registerIpc(): void {
  ipcMain.handle('gui:update:getState', () => invoke(() => desktopUpdater.getState()));
  ipcMain.handle('gui:update:check', () => invoke(() => desktopUpdater.checkForUpdates()));
  ipcMain.handle('gui:update:download', () => invoke(() => desktopUpdater.download()));
  ipcMain.handle('gui:update:install', () => invoke(() => desktopUpdater.quitAndInstall()));
  ipcMain.handle('gui:snapshot', () => invoke(() => service.snapshot()));
  ipcMain.handle('gui:importProject', () => invoke(() => service.importProject()));
  ipcMain.handle('gui:addProject', (_event, input) => invoke(() => service.addProject(input)));
  ipcMain.handle('gui:removeProject', (_event, id) => invoke(() => service.removeProject(id)));
  ipcMain.handle('gui:batchRemoveProjects', (_event, ids) => invoke(() => service.batchRemoveProjects(ids)));
  ipcMain.handle('gui:upsertProvider', (_event, input) => invoke(() => service.upsertProvider(input)));
  ipcMain.handle('gui:removeProvider', (_event, id) => invoke(() => service.removeProvider(id)));
  ipcMain.handle('gui:batchRemoveProviders', (_event, ids) => invoke(() => service.batchRemoveProviders(ids)));
  ipcMain.handle('gui:clearDefaultProviders', () => invoke(() => service.clearDefaultProviders()));
  ipcMain.handle('gui:restoreDefaultProviders', () => invoke(() => service.restoreDefaultProviders()));
  ipcMain.handle('gui:upsertModel', (_event, input) => invoke(() => service.upsertModel(input)));
  ipcMain.handle('gui:removeModel', (_event, alias) => invoke(() => service.removeModel(alias)));
  ipcMain.handle('gui:batchRemoveModels', (_event, aliases) => invoke(() => service.batchRemoveModels(aliases)));
  ipcMain.handle('gui:setDefaultModel', (_event, alias) => invoke(() => service.setDefaultModel(alias)));
  ipcMain.handle('gui:setDefaultModelCategory', (_event, payload: { category: string; alias: string }) =>
    invoke(() => service.setDefaultModelCategory(payload.category, payload.alias))
  );
  ipcMain.handle('gui:getVoiceWakeSettings', () => invoke(() => service.getVoiceWakeSettings()));
  ipcMain.handle('gui:updateVoiceWakeSettings', (_event, patch: Record<string, unknown>) =>
    invoke(() => service.updateVoiceWakeSettings(patch))
  );
  ipcMain.handle('gui:transcribeAudio', (_event, payload: { audioBase64: string; mimeType?: string; modelAlias?: string }) =>
    invoke(() => service.transcribeAudio(payload))
  );
  ipcMain.handle('gui:captureScreen', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 },
      });
      if (sources && sources.length > 0 && sources[0]) {
        const primary = sources[0];
        const dataUrl = primary.thumbnail.toDataURL();
        return { ok: true, data: dataUrl, dataUrl };
      }
      return { ok: false, error: '未能获取屏幕截图' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('gui:systemControl', (_event, payload: { action: string; param?: unknown }) =>
    invoke(() => service.systemControl(payload))
  );
  ipcMain.handle('gui:voiceWake:broadcast', (_event, payload: { type: string; data?: unknown }) => {
    if (ballWindow && !ballWindow.isDestroyed()) {
      ballWindow.webContents.send('gui:voiceWake:event', payload);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gui:voiceWake:event', payload);
    }
    return { ok: true, data: true };
  });
  ipcMain.handle('gui:testModel', (_event, alias) => invoke(() => service.testModel(alias)));
  ipcMain.handle('gui:upsertAgent', (_event, input) => invoke(() => service.upsertAgent(input)));
  ipcMain.handle('gui:setDefaultAgent', (_event, id) => invoke(() => service.setDefaultAgent(id)));
  ipcMain.handle('gui:removeAgent', (_event, id) => invoke(() => service.removeAgent(id)));
  ipcMain.handle('gui:openInVsCode', (_event, path) => invoke(() => service.openInVsCode(path)));
  ipcMain.handle('gui:openInExplorer', (_event, path) => invoke(() => service.openInExplorer(path)));
  ipcMain.handle('gui:openInTerminal', (_event, path) => invoke(() => service.openInTerminal(path)));
  ipcMain.handle('gui:testProvider', (_event, idOrConfig) => invoke(() => service.testProvider(idOrConfig)));
  ipcMain.handle('gui:fetchProviderModels', (_event, payload) => invoke(() => service.fetchProviderModels(payload.providerId, payload.options)));
  ipcMain.handle('gui:getProviderApiKey', (_event, providerId) => invoke(() => service.getProviderApiKey(providerId)));
  ipcMain.handle('gui:getEnvVars', () => invoke(() => service.getEnvVars()));
  ipcMain.handle('gui:saveEnvVar', (_event, input) => invoke(() => service.saveEnvVar(input)));
  ipcMain.handle('gui:deleteEnvVar', (_event, key) => invoke(() => service.deleteEnvVar(key)));
  ipcMain.handle('gui:batchSaveEnvVars', (_event, entries) => invoke(() => service.batchSaveEnvVars(entries)));
  ipcMain.handle('gui:generateImage', (_event, payload) => invoke(() => service.generateImage(payload)));
  ipcMain.handle('gui:listSkills', () => invoke(() => service.listSkills()));
  ipcMain.handle('gui:rescanSkills', () => invoke(() => service.rescanSkills()));
  ipcMain.handle('gui:installSkill', (_event, repoUrl) => invoke(() => service.installSkill(repoUrl)));
  ipcMain.handle('gui:importSkill', (_event, payload) => invoke(() => service.importSkill(payload)));
  ipcMain.handle('gui:toggleSkill', (_event, payload) => invoke(() => service.toggleSkill(payload.id, payload.enabled)));
  ipcMain.handle('gui:uninstallSkill', (_event, id) => invoke(() => service.uninstallSkill(id)));
  ipcMain.handle('gui:listPlugins', () => invoke(() => service.listPlugins()));
  ipcMain.handle('gui:togglePlugin', (_event, payload) => invoke(() => service.togglePlugin(payload.id, payload.enabled)));
  ipcMain.handle('gui:upsertPlugin', (_event, plugin) => invoke(() => service.upsertPlugin(plugin)));
  ipcMain.handle('gui:getPermissions', () => invoke(() => service.getPermissions()));
  ipcMain.handle('gui:updatePermissions', (_event, config) => invoke(() => service.updatePermissions(config)));
  ipcMain.handle('gui:getGitStatus', (_event, projectPath) => invoke(() => service.getGitStatus(projectPath)));
  ipcMain.handle('gui:gitCommit', (_event, payload) => invoke(() => service.gitCommit(payload.projectPath, payload.message)));
  ipcMain.handle('gui:gitStashCommit', (_event, payload) => invoke(() => service.gitStashCommit(payload.projectPath, payload.message)));
  ipcMain.handle('gui:gitGetCommitHistory', (_event, payload) => invoke(() => service.gitGetCommitHistory(payload.projectPath, payload.limit)));
  ipcMain.handle('gui:gitRollbackCommit', (_event, payload) => invoke(() => service.gitRollbackCommit(payload.projectPath, payload.commitHash, payload.mode)));
  ipcMain.handle('gui:gitRevertCommit', (_event, payload) => invoke(() => service.gitRevertCommit(payload.projectPath, payload.commitHash)));
  ipcMain.handle('gui:gitShowCommit', (_event, payload) => invoke(() => service.gitShowCommit(payload.projectPath, payload.commitHash)));
  ipcMain.handle('gui:gitPush', (_event, projectPath) => invoke(() => service.gitPush(projectPath)));
  ipcMain.handle('gui:gitPull', (_event, projectPath) => invoke(() => service.gitPull(projectPath)));
  ipcMain.handle('gui:getGitAuthInfo', (_event, projectPath) => invoke(() => service.getGitAuthInfo(projectPath)));
  ipcMain.handle('gui:configureGitSsh', (_event, projectPath) => invoke(() => service.configureGitSsh(projectPath)));
  ipcMain.handle('gui:configureGitToken', (_event, payload) => invoke(() => service.configureGitToken(payload.projectPath, payload.username, payload.token)));
  ipcMain.handle('gui:gitListBranches', (_event, projectPath) => invoke(() => service.gitListBranches(projectPath)));
  ipcMain.handle('gui:gitCheckoutBranch', (_event, payload) => invoke(() => service.gitCheckoutBranch(payload.projectPath, payload.branchName, payload.createNew)));
  ipcMain.handle('gui:gitMergeBranch', (_event, payload) => invoke(() => service.gitMergeBranch(payload.projectPath, payload.targetBranch, payload.options)));
  ipcMain.handle('gui:gitMergeAbort', (_event, projectPath) => invoke(() => service.gitMergeAbort(projectPath)));
  ipcMain.handle('gui:gitRebaseBranch', (_event, payload) => invoke(() => service.gitRebaseBranch(payload.projectPath, payload.targetBranch)));
  ipcMain.handle('gui:gitRebaseAbort', (_event, projectPath) => invoke(() => service.gitRebaseAbort(projectPath)));
  ipcMain.handle('gui:gitRebaseContinue', (_event, projectPath) => invoke(() => service.gitRebaseContinue(projectPath)));
  ipcMain.handle('gui:gitDiff', (_event, payload) => invoke(() => service.gitDiff(payload.projectPath, payload.file, payload.isStaged)));
  ipcMain.handle('gui:getVisualDiff', (_event, payload) => invoke(() => service.getVisualDiff(payload.projectPath, payload.file, payload.isStaged)));
  ipcMain.handle('gui:revertFileDiff', (_event, payload) => invoke(() => service.revertFileDiff(payload.projectPath, payload.file)));
  ipcMain.handle('gui:revertAllFiles', (_event, projectPath) => invoke(() => service.revertAllFiles(projectPath)));
  ipcMain.handle('gui:stageFileDiff', (_event, payload) => invoke(() => service.stageFileDiff(payload.projectPath, payload.file)));
  ipcMain.handle('gui:unstageFileDiff', (_event, payload) => invoke(() => service.unstageFileDiff(payload.projectPath, payload.file)));
  ipcMain.handle('gui:stageAllFiles', (_event, projectPath) => invoke(() => service.stageAllFiles(projectPath)));
  ipcMain.handle('gui:unstageAllFiles', (_event, projectPath) => invoke(() => service.unstageAllFiles(projectPath)));
  ipcMain.handle('gui:stageHunk', (_event, payload) => invoke(() => service.stageHunk(payload.projectPath, payload.file, payload.patch)));
  ipcMain.handle('gui:revertHunk', (_event, payload) => invoke(() => service.revertHunk(payload.projectPath, payload.file, payload.patch)));
  ipcMain.handle('gui:getProjectCommitRule', (_event, projectPath) => invoke(() => service.getProjectCommitRule(projectPath)));
  ipcMain.handle('gui:saveProjectCommitRule', (_event, payload) => invoke(() => service.saveProjectCommitRule(payload.projectPath, payload.content, payload.fileName)));
  ipcMain.handle('gui:listSchedules', () => invoke(() => service.listSchedules()));
  ipcMain.handle('gui:upsertSchedule', (_event, input) => invoke(() => service.upsertSchedule(input)));
  ipcMain.handle('gui:removeSchedule', (_event, id) => invoke(() => service.removeSchedule(id)));
  ipcMain.handle('gui:toggleSchedule', (_event, payload) => invoke(() => service.toggleSchedule(payload.id, payload.enabled)));
  ipcMain.handle('gui:runScheduleNow', (_event, id) => invoke(() => service.runScheduleNow(id)));
  ipcMain.handle('gui:getScheduleHistory', (_event, scheduleId) => invoke(() => service.getScheduleHistory(scheduleId)));
  ipcMain.handle('gui:listMemories', (_event, category) => invoke(() => service.listMemories(category)));
  ipcMain.handle('gui:addMemory', (_event, input) => invoke(() => service.addMemory(input)));
  ipcMain.handle('gui:searchMemories', (_event, payload) => invoke(() => service.searchMemories(payload.query, payload.limit)));
  ipcMain.handle('gui:removeMemory', (_event, id) => invoke(() => service.removeMemory(id)));
  ipcMain.handle('gui:updateMemory', (_event, payload) => invoke(() => service.updateMemory(payload.id, payload.patch)));
  ipcMain.handle('gui:rebuildMemoryEmbeddings', () => invoke(() => service.rebuildMemoryEmbeddings()));
  ipcMain.handle('gui:findDefinition', (_event, payload) => invoke(() => service.findDefinition(payload.symbol, payload.workspace)));
  ipcMain.handle('gui:findReferences', (_event, payload) => invoke(() => service.findReferences(payload.symbol, payload.workspace)));
  ipcMain.handle('gui:listSymbols', (_event, file) => invoke(() => service.listSymbols(file)));
  ipcMain.handle('gui:getWebInfo', () => invoke(() => service.getWebInfo()));
  ipcMain.handle('gui:getHostSysInfo', () => invoke(() => service.getHostSysInfo()));
  ipcMain.handle('gui:ollama:getStatus', () => invoke(() => service.getOllamaStatus()));
  ipcMain.handle('gui:docker:status', () => invoke(() => service.getDockerModels()));
  ipcMain.handle('gui:docker:stop', (_event, id) => invoke(() => service.stopDockerModel(id)));
  ipcMain.handle('gui:docker:remove', (_event, input) => invoke(() => service.removeDockerModel(input)));
  ipcMain.handle('gui:docker:logs', (_event, id) => invoke(() => service.dockerModelLogs(id)));
  ipcMain.handle('gui:docker:deploy', (_event, input) => invoke(() => service.deployDockerModel(input, progress => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('gui:docker:progress', progress);
  })));
  ipcMain.handle('gui:ollama:getRecommendedModels', (_event, categoryFilter) => invoke(() => service.getRecommendedModels(categoryFilter)));
  ipcMain.handle('gui:ollama:startService', () => invoke(() => service.startOllamaService()));
  ipcMain.handle('gui:ollama:cancelPull', (_event, modelTag) => invoke(() => service.cancelOllamaPull(modelTag)));
  ipcMain.handle('gui:ollama:deleteModel', (_event, modelTag) => invoke(() => service.deleteOllamaModel(modelTag)));
  ipcMain.handle('gui:ollama:pullModel', (_event, modelTag) => invoke(() => service.pullOllamaModel(modelTag, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gui:ollama:pullProgress', progress);
    }
  })));
  ipcMain.handle('gui:getTelegramConfig', () => invoke(() => service.getTelegramConfig()));
  ipcMain.handle('gui:saveTelegramConfig', (_event, config) => invoke(() => service.saveTelegramConfig(config)));
  ipcMain.handle('gui:testTelegramBot', (_event, token) => invoke(() => service.testTelegramBot(token)));
  ipcMain.handle('gui:startTelegramService', () => invoke(() => service.startTelegramService()));
  ipcMain.handle('gui:stopTelegramService', () => invoke(() => service.stopTelegramService()));
  ipcMain.handle('gui:getWeChatConfig', () => invoke(() => service.getWeChatConfig()));
  ipcMain.handle('gui:saveWeChatConfig', (_event, config) => invoke(() => service.saveWeChatConfig(config)));
  ipcMain.handle('gui:startWeChatService', () => invoke(() => service.startWeChatService()));
  ipcMain.handle('gui:logoutWeChat', () => invoke(() => service.logoutWeChat()));
  ipcMain.handle('gui:reloginWeChat', () => invoke(() => service.reloginWeChat()));
  ipcMain.handle('gui:stopWeChatService', () => invoke(() => service.stopWeChatService()));
  ipcMain.handle('gui:refreshWeChatQr', () => invoke(() => service.refreshWeChatQr()));
  ipcMain.handle('gui:confirmWeChatLogin', () => invoke(() => service.confirmWeChatLogin()));
  ipcMain.handle('gui:syncWeChatContacts', () => invoke(() => service.syncWeChatContacts()));
  ipcMain.handle('gui:listWeChatContacts', () => invoke(() => service.listWeChatContacts()));
  ipcMain.handle('gui:getWeChatMessages', (_event, contactId) => invoke(() => service.getWeChatMessages(contactId)));
  ipcMain.handle('gui:upsertWeChatContact', (_event, input) => invoke(() => service.upsertWeChatContact(input)));
  ipcMain.handle('gui:removeWeChatContact', (_event, id) => invoke(() => service.removeWeChatContact(id)));
  ipcMain.handle('gui:sendWeChatMessage', (_event, payload) => invoke(() => service.sendWeChatMessage(payload)));
  ipcMain.handle('gui:getFeishuConfig', () => invoke(() => service.getFeishuConfig()));
  ipcMain.handle('gui:saveFeishuConfig', (_event, config) => invoke(() => service.saveFeishuConfig(config)));
  ipcMain.handle('gui:startFeishuService', () => invoke(() => service.startFeishuService()));
  ipcMain.handle('gui:stopFeishuService', () => invoke(() => service.stopFeishuService()));
  ipcMain.handle('gui:getQQConfig', () => invoke(() => service.getQQConfig()));
  ipcMain.handle('gui:saveQQConfig', (_event, config) => invoke(() => service.saveQQConfig(config)));
  ipcMain.handle('gui:startQQService', () => invoke(() => service.startQQService()));
  ipcMain.handle('gui:stopQQService', () => invoke(() => service.stopQQService()));
  ipcMain.handle('gui:listChannelContacts', (_event, channel) => invoke(() => service.listChannelContacts(channel)));
  ipcMain.handle('gui:getChannelMessages', (_event, contactId, channel) => invoke(() => service.getChannelMessages(contactId, channel)));
  ipcMain.handle('gui:upsertChannelContact', (_event, input) => invoke(() => service.upsertChannelContact(input)));
  ipcMain.handle('gui:removeChannelContact', (_event, id, channel) => invoke(() => service.removeChannelContact(id, channel)));
  ipcMain.handle('gui:clearAllChannelContacts', (_event, channel) => invoke(() => service.clearAllChannelContacts(channel)));
  ipcMain.handle('gui:sendChannelMessage', (_event, payload) => invoke(() => service.sendChannelMessage(payload)));

  // 聊天托管与数字分身代管 IPC 接口
  ipcMain.handle('gui:hosting:getOverview', () => invoke(() => service.getHostingOverview()));
  ipcMain.handle('gui:hosting:startWeChat', () => invoke(() => service.startWeChatHostingService()));
  ipcMain.handle('gui:hosting:stopWeChat', () => invoke(() => service.stopWeChatHostingService()));
  ipcMain.handle('gui:hosting:sendHumanMessage', (_event, payload) => invoke(() => service.sendHumanMessage(payload)));
  ipcMain.handle('gui:hosting:approveDraft', (_event, messageId) => invoke(() => service.approveDraft(messageId)));
  ipcMain.handle('gui:hosting:discardDraft', (_event, messageId) => invoke(() => service.discardDraft(messageId)));
  ipcMain.handle('gui:hosting:generateQuickReplies', (_event, payload) => invoke(() => service.generateQuickReplies(payload)));
  ipcMain.handle('gui:hosting:triggerTakeover', (_event, payload) => invoke(() => service.triggerContactTakeover(payload)));
  ipcMain.handle('gui:hosting:releaseTakeover', (_event, payload) => invoke(() => service.releaseContactTakeover(payload)));
  ipcMain.handle('gui:hosting:testVisionCapture', () => invoke(() => service.testVisionCapture()));
  ipcMain.handle('gui:hosting:switchPuppet', (_event, puppet) => invoke(() => service.switchWeChatHostingPuppet(puppet)));
  ipcMain.handle('gui:hosting:getDefaultPolicy', (_event, channel) => invoke(() => service.getChannelDefaultPolicy(channel)));
  ipcMain.handle('gui:hosting:saveDefaultPolicy', (_event, payload) => invoke(() => service.saveChannelDefaultPolicy(payload.channel, payload.policy)));
  ipcMain.handle('gui:hosting:getPersonaTemplates', () => invoke(() => service.getHostingPersonaTemplates()));
  ipcMain.handle('gui:hosting:loadPersonaMarkdown', (_event, filePath) => invoke(() => service.loadHostingPersonaMarkdown(filePath)));
  ipcMain.handle('gui:hosting:exportPersonaMarkdown', (_event, payload) => invoke(() => service.exportHostingPersonaMarkdown(payload.filePath, payload.content)));
  ipcMain.handle('gui:hosting:showOpenDialog', async (_event, options) => {
    const win = BrowserWindow.getFocusedWindow();
    return dialog.showOpenDialog(win ?? undefined as never, options || {
      title: '导入分身人设 Markdown 文档',
      filters: [{ name: 'Markdown 文档', extensions: ['md', 'markdown', 'txt'] }],
      properties: ['openFile'],
    });
  });
  ipcMain.handle('gui:hosting:showSaveDialog', async (_event, options) => {
    const win = BrowserWindow.getFocusedWindow();
    return dialog.showSaveDialog(win ?? undefined as never, options || {
      title: '导出分身人设为 Markdown 文档',
      defaultPath: 'hosting-persona.md',
      filters: [{ name: 'Markdown 文档', extensions: ['md'] }],
    });
  });
  ipcMain.handle('gui:hosting:getActivities', (_event, limit) => invoke(() => service.getHostingActivities(limit)));
  ipcMain.handle('gui:hosting:clearActivities', () => invoke(() => service.clearHostingActivities()));
  ipcMain.handle('gui:hosting:pruneGarbage', (_event, channel) => invoke(() => service.pruneGarbageChannelContacts(channel)));
  ipcMain.handle('gui:listBots', () => invoke(() => service.listBots()));
  ipcMain.handle('gui:upsertBot', (_event, bot) => invoke(() => service.upsertBot(bot)));
  ipcMain.handle('gui:deleteBot', (_event, id) => invoke(() => service.deleteBot(id)));
  ipcMain.handle('gui:toggleBotStatus', (_event, payload) => invoke(() => service.toggleBotStatus(payload.id, payload.enabled)));
  ipcMain.handle('gui:testBotConnection', (_event, bot) => invoke(() => service.testBotConnection(bot)));
  ipcMain.handle('gui:listServers', () => invoke(() => service.listServers()));
  ipcMain.handle('gui:upsertServer', (_event, input) => invoke(() => service.upsertServer(input)));
  ipcMain.handle('gui:removeServer', (_event, id) => invoke(() => service.removeServer(id)));
  ipcMain.handle('gui:testServerBotAlert', (_event, payload) => invoke(() => service.testServerBotAlert(payload)));
  ipcMain.handle('gui:testServer', (_event, id) => invoke(() => service.testServer(id)));
  ipcMain.handle('gui:installServer', (event, id) => invoke(() => service.installServer(id, (progress) => {
    event.sender.send('gui:installProgress', progress);
  })));
  ipcMain.handle('gui:getServerInfo', (_event, id) => invoke(() => service.getServerInfo(id)));
  ipcMain.handle('gui:getServerProcesses', (_event, id, options) => invoke(() => service.getServerProcesses(id, options)));
  ipcMain.handle('gui:killServerProcess', (_event, payload) => invoke(() => service.killServerProcess(payload)));
  ipcMain.handle('gui:execServerCommand', (_event, payload) => invoke(() => service.execServerCommand(payload)));
  ipcMain.handle('gui:scanDiskCleanable', (_event, server) => invoke(() => service.scanDiskCleanable(server)));
  ipcMain.handle('gui:executeDiskCleanup', (_event, payload) => invoke(() => service.executeDiskCleanup(payload)));
  ipcMain.handle('gui:getIpGeoInfo', (_event, ip) => invoke(() => service.getIpGeoInfo(ip)));
  ipcMain.handle('gui:syncTarget', (_event, input) => invoke(() => service.syncTarget(input)));
  ipcMain.handle('gui:chat', (event, input) => invoke(() => service.chat(input, (streamEvent) => {
    event.sender.send('gui:chat:stream', streamEvent);
  })));
  ipcMain.handle('gui:chat:abort', (_event, sessionKey?: string) => invoke(() => service.abortChat(sessionKey)));
  ipcMain.handle('gui:mcp:listTools', (_event, payload) => invoke(() => service.listMcpPlaygroundTools(payload?.refresh)));
  ipcMain.handle('gui:mcp:callTool', (_event, payload) => invoke(() => service.callMcpPlaygroundTool(payload)));
  ipcMain.handle('gui:logs', () => invoke(() => service.logsSnapshot()));
  ipcMain.handle('gui:clearLogs', () => invoke(() => service.clearLogs()));
  ipcMain.handle('gui:toggleDevTools', (event) => {
    event.sender.toggleDevTools();
    return { ok: true, data: undefined };
  });
  ipcMain.handle('gui:openExternal', async (_event, url: unknown) => {
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      await shell.openExternal(url);
      return { ok: true, data: true };
    }
    return { ok: false, error: '非法 URL 地址' };
  });

  // API 分发网关 (Gateway) IPC 接口
  ipcMain.handle('gui:getGatewayOverview', () => invoke(() => service.getGatewayOverview()));
  ipcMain.handle('gui:getGatewayConfig', () => invoke(() => service.getGatewayConfig()));
  ipcMain.handle('gui:updateGatewayConfig', (_event, patch) => invoke(() => service.updateGatewayConfig(patch)));
  ipcMain.handle('gui:listGatewayKeys', () => invoke(() => service.listGatewayKeys()));
  ipcMain.handle('gui:createGatewayKey', (_event, input) => invoke(() => service.createGatewayKey(input)));
  ipcMain.handle('gui:updateGatewayKey', (_event, payload) => invoke(() => service.updateGatewayKey(payload.id, payload.patch)));
  ipcMain.handle('gui:deleteGatewayKey', (_event, id) => invoke(() => service.deleteGatewayKey(id)));
  ipcMain.handle('gui:listGatewayAliases', () => invoke(() => service.listGatewayAliases()));
  ipcMain.handle('gui:upsertGatewayAlias', (_event, input) => invoke(() => service.upsertGatewayAlias(input)));
  ipcMain.handle('gui:deleteGatewayAlias', (_event, id) => invoke(() => service.deleteGatewayAlias(id)));
  ipcMain.handle('gui:listGatewayLogs', (_event, limit) => invoke(() => service.listGatewayLogs(limit)));
  ipcMain.handle('gui:clearGatewayLogs', () => invoke(() => service.clearGatewayLogs()));
  ipcMain.handle('gui:getGatewayClientPresets', (_event, key) => invoke(() => service.getGatewayClientPresets(key)));

  // 悬浮小球 (Floating Ball) 控制 IPC 接口
  ipcMain.handle('gui:ball:enter', () => {
    switchToBallMode();
    return { ok: true, data: true };
  });
  ipcMain.handle('gui:ball:restore', () => {
    restoreFromBall();
    return { ok: true, data: true };
  });
  ipcMain.handle('gui:ball:minimizeToTaskbar', () => {
    minimizeToTaskbar();
    return { ok: true, data: true };
  });
  ipcMain.handle('gui:ball:setExpanded', (_event, payload: { expanded: boolean }) => {
    setBallExpanded(Boolean(payload?.expanded));
    return { ok: true, data: isBallExpanded };
  });
  ipcMain.handle('gui:ball:move', (_event, payload: { deltaX: number; deltaY: number }) => {
    moveBallWindow(Number(payload?.deltaX) || 0, Number(payload?.deltaY) || 0);
    return { ok: true, data: ballPos };
  });
  ipcMain.handle('gui:ball:getState', () => {
    return { ok: true, data: { isBallMode, isBallExpanded, ballPos } };
  });
  ipcMain.handle('gui:theme:sync', (_event, payload: { theme: string; customAccent?: string; customBase?: string }) => {
    if (ballWindow && !ballWindow.isDestroyed()) {
      ballWindow.webContents.send('gui:theme:changed', payload);
    }
    return { ok: true, data: true };
  });

  // 窗口系统控制、透明度调节与 Mini 模式 IPC 接口
  ipcMain.handle('gui:window:minimize', () => {
    switchToBallMode();
    return { ok: true, data: true };
  });
  ipcMain.handle('gui:window:maximize', () => {
    if (!mainWindow) return { ok: false, error: 'Window not ready' };
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
    return { ok: true, data: mainWindow.isMaximized() };
  });
  ipcMain.handle('gui:window:close', () => {
    mainWindow?.close();
    return { ok: true, data: true };
  });
  ipcMain.handle('gui:window:setOpacity', (_event, opacity: number) => {
    if (!mainWindow) return { ok: false, error: 'Window not ready' };
    const clamped = Math.max(0.3, Math.min(1.0, Number(opacity) || 1.0));
    mainWindow.setOpacity(clamped);
    return { ok: true, data: clamped };
  });
  ipcMain.handle('gui:window:getOpacity', () => {
    if (!mainWindow) return { ok: true, data: 1.0 };
    return { ok: true, data: mainWindow.getOpacity() };
  });
  ipcMain.handle('gui:window:setAlwaysOnTop', (_event, flag: boolean) => {
    if (!mainWindow) return { ok: false, error: 'Window not ready' };
    mainWindow.setAlwaysOnTop(Boolean(flag), flag ? 'floating' : 'normal');
    return { ok: true, data: Boolean(flag) };
  });
  ipcMain.handle('gui:window:setMiniMode', (_event, enable: boolean) => {
    if (!mainWindow) return { ok: true, data: isMiniMode };
    if (enable && !isMiniMode) {
      normalBounds = mainWindow.getBounds();
      isMiniMode = true;
      mainWindow.setMinimumSize(320, 240);
      try {
        const display = screen.getDisplayMatching(normalBounds);
        const workArea = display.workArea;
        const miniWidth = 360;
        const miniHeight = 520;
        const x = Math.round(workArea.x + workArea.width - miniWidth - 30);
        const y = Math.round(workArea.y + workArea.height - miniHeight - 30);
        mainWindow.setBounds({ x, y, width: miniWidth, height: miniHeight });
      } catch {
        mainWindow.setSize(360, 520);
      }
      mainWindow.setAlwaysOnTop(true, 'floating');
      mainWindow.webContents.send('gui:window:miniModeChanged', true);
    } else if (!enable && isMiniMode) {
      isMiniMode = false;
      mainWindow.setAlwaysOnTop(false);
      mainWindow.setMinimumSize(1080, 720);
      if (normalBounds) {
        mainWindow.setBounds(normalBounds);
      } else {
        mainWindow.setSize(1320, 860);
        mainWindow.center();
      }
      mainWindow.webContents.send('gui:window:miniModeChanged', false);
    }
    return { ok: true, data: isMiniMode };
  });
  ipcMain.handle('gui:window:getMiniMode', () => {
    return { ok: true, data: isMiniMode };
  });
}

async function createWindow(): Promise<void> {
  // 隐藏老旧的系统原生菜单栏 (File Edit View Window Help)，由桌面端内置导航统一管理
  Menu.setApplicationMenu(null);

  const isMac = process.platform === 'darwin';

  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    title: 'Hermes Agent Platform',
    icon: rendererPath('app-icon.png'),
    backgroundColor: '#0b0f19',
    autoHideMenuBar: true,
    ...(isMac
      ? {
          titleBarStyle: 'hidden' as const,
          trafficLightPosition: { x: 16, y: 15 },
        }
      : {}),
    webPreferences: {
      preload: rendererPath('preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = window;
  window.on('minimize', () => {
    if (bypassMinimizeToBall) {
      bypassMinimizeToBall = false;
      return;
    }
    switchToBallMode();
  });

  const unsubscribeUpdater = desktopUpdater.subscribe((state) => {
    if (!window.isDestroyed()) window.webContents.send('gui:update:state', state);
  });
  const unsubscribeHosting = service.onHostingActivity((activity) => {
    if (!window.isDestroyed()) window.webContents.send('gui:hosting:activity', activity);
  });
  mainWindow.on('closed', () => {
    unsubscribeUpdater();
    unsubscribeHosting();
    mainWindow = null;
    if (ballWindow && !ballWindow.isDestroyed()) {
      ballWindow.close();
      ballWindow = null;
    }
  });

  window.webContents.once('did-finish-load', () => {
    void desktopUpdater.checkOnStartup();
  });

  // 监听键盘输入事件，支持 Ctrl+Shift+I / F12 开关控制台，Ctrl+R / F5 快速刷新
  window.webContents.on('before-input-event', (event, input) => {
    const isDevTools =
      (input.key.toLowerCase() === 'i' && input.control && input.shift) ||
      (input.key.toLowerCase() === 'i' && input.meta && input.alt) ||
      input.key === 'F12';

    if (isDevTools) {
      window.webContents.toggleDevTools();
      event.preventDefault();
      return;
    }

    const isReload =
      (input.key.toLowerCase() === 'r' && (input.control || input.meta) && !input.shift) ||
      input.key === 'F5';

    if (isReload) {
      window.webContents.reload();
      event.preventDefault();
      return;
    }

    const isForceReload =
      input.key.toLowerCase() === 'r' && (input.control || input.meta) && input.shift;

    if (isForceReload) {
      window.webContents.reloadIgnoringCache();
      event.preventDefault();
      return;
    }
  });

  await window.loadFile(rendererPath('index.html'));
}

registerIpc();
void app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === 'media') return true;
    return true;
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') return callback(true);
    callback(true);
  });
  return createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
