const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, payload) {
  const result = await ipcRenderer.invoke(channel, payload);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

contextBridge.exposeInMainWorld('hap', {
  snapshot: () => call('gui:snapshot'),
  importProject: () => call('gui:importProject'),
  addProject: (input) => call('gui:addProject', input),
  removeProject: (id) => call('gui:removeProject', id),
  batchRemoveProjects: (ids) => call('gui:batchRemoveProjects', ids),
  upsertProvider: (input) => call('gui:upsertProvider', input),
  removeProvider: (id) => call('gui:removeProvider', id),
  batchRemoveProviders: (ids) => call('gui:batchRemoveProviders', ids),
  upsertModel: (input) => call('gui:upsertModel', input),
  removeModel: (alias) => call('gui:removeModel', alias),
  batchRemoveModels: (aliases) => call('gui:batchRemoveModels', aliases),
  upsertAgent: (input) => call('gui:upsertAgent', input),
  openInVsCode: (path) => call('gui:openInVsCode', path),
  openInExplorer: (path) => call('gui:openInExplorer', path),
  openInTerminal: (path) => call('gui:openInTerminal', path),
  testProvider: (id) => call('gui:testProvider', id),
  fetchProviderModels: (providerId, options) => call('gui:fetchProviderModels', { providerId, options }),
  listSkills: () => call('gui:listSkills'),
  installSkill: (repoUrl) => call('gui:installSkill', repoUrl),
  toggleSkill: (id, enabled) => call('gui:toggleSkill', { id, enabled }),
  uninstallSkill: (id) => call('gui:uninstallSkill', id),
  listPlugins: () => call('gui:listPlugins'),
  togglePlugin: (id, enabled) => call('gui:togglePlugin', { id, enabled }),
  upsertPlugin: (plugin) => call('gui:upsertPlugin', plugin),
  getPermissions: () => call('gui:getPermissions'),
  updatePermissions: (config) => call('gui:updatePermissions', config),
  getGitStatus: (projectPath) => call('gui:getGitStatus', projectPath),
  gitCommit: (projectPath, message) => call('gui:gitCommit', { projectPath, message }),
  gitPush: (projectPath) => call('gui:gitPush', projectPath),
  gitPull: (projectPath) => call('gui:gitPull', projectPath),
  gitDiff: (projectPath, file) => call('gui:gitDiff', { projectPath, file }),
  getTelegramConfig: () => call('gui:getTelegramConfig'),
  saveTelegramConfig: (config) => call('gui:saveTelegramConfig', config),
  testTelegramBot: (token) => call('gui:testTelegramBot', token),
  startTelegramService: () => call('gui:startTelegramService'),
  stopTelegramService: () => call('gui:stopTelegramService'),
  getWeChatConfig: () => call('gui:getWeChatConfig'),
  saveWeChatConfig: (config) => call('gui:saveWeChatConfig', config),
  startWeChatService: () => call('gui:startWeChatService'),
  stopWeChatService: () => call('gui:stopWeChatService'),
  refreshWeChatQr: () => call('gui:refreshWeChatQr'),
  listServers: () => call('gui:listServers'),
  upsertServer: (input) => call('gui:upsertServer', input),
  removeServer: (id) => call('gui:removeServer', id),
  testServer: (id) => call('gui:testServer', id),
  installServer: (id) => call('gui:installServer', id),
  onInstallProgress: (callback) => {
    ipcRenderer.on('gui:installProgress', (_event, data) => callback(data));
  },
  removeInstallProgressListeners: () => {
    ipcRenderer.removeAllListeners('gui:installProgress');
  },
  getServerInfo: (id) => call('gui:getServerInfo', id),
  execServerCommand: (payload) => call('gui:execServerCommand', payload),
  syncTarget: (input) => call('gui:syncTarget', input),
  chat: (input) => call('gui:chat', input),
  logs: () => call('gui:logs'),
  clearLogs: () => call('gui:clearLogs'),
  toggleDevTools: () => call('gui:toggleDevTools'),
});
