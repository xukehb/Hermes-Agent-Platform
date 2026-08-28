import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuiService } from './service.js';

const service = new GuiService();
const __dirname = fileURLToPath(new URL('.', import.meta.url));

function rendererPath(file: string): string {
  return join(__dirname, 'renderer', file);
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
  ipcMain.handle('gui:snapshot', () => invoke(() => service.snapshot()));
  ipcMain.handle('gui:importProject', () => invoke(() => service.importProject()));
  ipcMain.handle('gui:addProject', (_event, input) => invoke(() => service.addProject(input)));
  ipcMain.handle('gui:removeProject', (_event, id) => invoke(() => service.removeProject(id)));
  ipcMain.handle('gui:batchRemoveProjects', (_event, ids) => invoke(() => service.batchRemoveProjects(ids)));
  ipcMain.handle('gui:upsertProvider', (_event, input) => invoke(() => service.upsertProvider(input)));
  ipcMain.handle('gui:removeProvider', (_event, id) => invoke(() => service.removeProvider(id)));
  ipcMain.handle('gui:batchRemoveProviders', (_event, ids) => invoke(() => service.batchRemoveProviders(ids)));
  ipcMain.handle('gui:upsertModel', (_event, input) => invoke(() => service.upsertModel(input)));
  ipcMain.handle('gui:removeModel', (_event, alias) => invoke(() => service.removeModel(alias)));
  ipcMain.handle('gui:upsertAgent', (_event, input) => invoke(() => service.upsertAgent(input)));
  ipcMain.handle('gui:openInVsCode', (_event, path) => invoke(() => service.openInVsCode(path)));
  ipcMain.handle('gui:openInExplorer', (_event, path) => invoke(() => service.openInExplorer(path)));
  ipcMain.handle('gui:openInTerminal', (_event, path) => invoke(() => service.openInTerminal(path)));
  ipcMain.handle('gui:testProvider', (_event, id) => invoke(() => service.testProvider(id)));
  ipcMain.handle('gui:fetchProviderModels', (_event, payload) => invoke(() => service.fetchProviderModels(payload.providerId, payload.options)));
  ipcMain.handle('gui:listSkills', () => invoke(() => service.listSkills()));
  ipcMain.handle('gui:installSkill', (_event, repoUrl) => invoke(() => service.installSkill(repoUrl)));
  ipcMain.handle('gui:toggleSkill', (_event, payload) => invoke(() => service.toggleSkill(payload.id, payload.enabled)));
  ipcMain.handle('gui:uninstallSkill', (_event, id) => invoke(() => service.uninstallSkill(id)));
  ipcMain.handle('gui:listPlugins', () => invoke(() => service.listPlugins()));
  ipcMain.handle('gui:togglePlugin', (_event, payload) => invoke(() => service.togglePlugin(payload.id, payload.enabled)));
  ipcMain.handle('gui:upsertPlugin', (_event, plugin) => invoke(() => service.upsertPlugin(plugin)));
  ipcMain.handle('gui:getPermissions', () => invoke(() => service.getPermissions()));
  ipcMain.handle('gui:updatePermissions', (_event, config) => invoke(() => service.updatePermissions(config)));
  ipcMain.handle('gui:getGitStatus', (_event, projectPath) => invoke(() => service.getGitStatus(projectPath)));
  ipcMain.handle('gui:gitCommit', (_event, payload) => invoke(() => service.gitCommit(payload.projectPath, payload.message)));
  ipcMain.handle('gui:gitPush', (_event, projectPath) => invoke(() => service.gitPush(projectPath)));
  ipcMain.handle('gui:gitDiff', (_event, payload) => invoke(() => service.gitDiff(payload.projectPath, payload.file)));
  ipcMain.handle('gui:getVisualDiff', (_event, payload) => invoke(() => service.getVisualDiff(payload.projectPath, payload.file)));
  ipcMain.handle('gui:revertFileDiff', (_event, payload) => invoke(() => service.revertFileDiff(payload.projectPath, payload.file)));
  ipcMain.handle('gui:stageFileDiff', (_event, payload) => invoke(() => service.stageFileDiff(payload.projectPath, payload.file)));
  ipcMain.handle('gui:listSchedules', () => invoke(() => service.listSchedules()));
  ipcMain.handle('gui:upsertSchedule', (_event, input) => invoke(() => service.upsertSchedule(input)));
  ipcMain.handle('gui:removeSchedule', (_event, id) => invoke(() => service.removeSchedule(id)));
  ipcMain.handle('gui:toggleSchedule', (_event, payload) => invoke(() => service.toggleSchedule(payload.id, payload.enabled)));
  ipcMain.handle('gui:getScheduleHistory', (_event, scheduleId) => invoke(() => service.getScheduleHistory(scheduleId)));
  ipcMain.handle('gui:listMemories', (_event, category) => invoke(() => service.listMemories(category)));
  ipcMain.handle('gui:addMemory', (_event, input) => invoke(() => service.addMemory(input)));
  ipcMain.handle('gui:searchMemories', (_event, payload) => invoke(() => service.searchMemories(payload.query, payload.limit)));
  ipcMain.handle('gui:removeMemory', (_event, id) => invoke(() => service.removeMemory(id)));
  ipcMain.handle('gui:findDefinition', (_event, payload) => invoke(() => service.findDefinition(payload.symbol, payload.workspace)));
  ipcMain.handle('gui:findReferences', (_event, payload) => invoke(() => service.findReferences(payload.symbol, payload.workspace)));
  ipcMain.handle('gui:listSymbols', (_event, file) => invoke(() => service.listSymbols(file)));
  ipcMain.handle('gui:getWebInfo', () => invoke(() => service.getWebInfo()));
  ipcMain.handle('gui:getHostSysInfo', () => invoke(() => service.getHostSysInfo()));
  ipcMain.handle('gui:getTelegramConfig', () => invoke(() => service.getTelegramConfig()));
  ipcMain.handle('gui:saveTelegramConfig', (_event, config) => invoke(() => service.saveTelegramConfig(config)));
  ipcMain.handle('gui:testTelegramBot', (_event, token) => invoke(() => service.testTelegramBot(token)));
  ipcMain.handle('gui:startTelegramService', () => invoke(() => service.startTelegramService()));
  ipcMain.handle('gui:stopTelegramService', () => invoke(() => service.stopTelegramService()));
  ipcMain.handle('gui:getWeChatConfig', () => invoke(() => service.getWeChatConfig()));
  ipcMain.handle('gui:saveWeChatConfig', (_event, config) => invoke(() => service.saveWeChatConfig(config)));
  ipcMain.handle('gui:startWeChatService', () => invoke(() => service.startWeChatService()));
  ipcMain.handle('gui:stopWeChatService', () => invoke(() => service.stopWeChatService()));
  ipcMain.handle('gui:refreshWeChatQr', () => invoke(() => service.refreshWeChatQr()));
  ipcMain.handle('gui:confirmWeChatLogin', () => invoke(() => service.confirmWeChatLogin()));
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
  ipcMain.handle('gui:sendChannelMessage', (_event, payload) => invoke(() => service.sendChannelMessage(payload)));
  ipcMain.handle('gui:listServers', () => invoke(() => service.listServers()));
  ipcMain.handle('gui:upsertServer', (_event, input) => invoke(() => service.upsertServer(input)));
  ipcMain.handle('gui:removeServer', (_event, id) => invoke(() => service.removeServer(id)));
  ipcMain.handle('gui:testServer', (_event, id) => invoke(() => service.testServer(id)));
  ipcMain.handle('gui:installServer', (event, id) => invoke(() => service.installServer(id, (progress) => {
    event.sender.send('gui:installProgress', progress);
  })));
  ipcMain.handle('gui:getServerInfo', (_event, id) => invoke(() => service.getServerInfo(id)));
  ipcMain.handle('gui:execServerCommand', (_event, payload) => invoke(() => service.execServerCommand(payload)));
  ipcMain.handle('gui:scanDiskCleanable', (_event, server) => invoke(() => service.scanDiskCleanable(server)));
  ipcMain.handle('gui:executeDiskCleanup', (_event, payload) => invoke(() => service.executeDiskCleanup(payload)));
  ipcMain.handle('gui:getIpGeoInfo', (_event, ip) => invoke(() => service.getIpGeoInfo(ip)));
  ipcMain.handle('gui:syncTarget', (_event, input) => invoke(() => service.syncTarget(input)));
  ipcMain.handle('gui:chat', (_event, input) => invoke(() => service.chat(input)));
  ipcMain.handle('gui:logs', () => invoke(() => service.logsSnapshot()));
  ipcMain.handle('gui:clearLogs', () => invoke(() => service.clearLogs()));
  ipcMain.handle('gui:toggleDevTools', (event) => {
    event.sender.toggleDevTools();
    return { ok: true, data: undefined };
  });
}

async function createWindow(): Promise<void> {
  // 隐藏老旧的系统原生菜单栏 (File Edit View Window Help)，由桌面端内置导航统一管理
  Menu.setApplicationMenu(null);

  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    title: 'ChatGPT · HAP Studio',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: rendererPath('preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
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
void app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
