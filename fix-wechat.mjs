import fs from 'node:fs';
const edit=(p,f)=>fs.writeFileSync(p,f(fs.readFileSync(p,'utf8')));
edit('src/gui/service.ts',s=>{
s="import { IlinkAccountStore } from '../channels/wechat/ilink/credential-store.js';\n"+s;
const a=s.indexOf('  async stopWeChatService():'); const b=s.indexOf('  async syncWeChatContacts()',a);
s=s.slice(0,a)+`  async stopWeChatService(): Promise<{ ok: boolean; message: string }> {
    const manager = this.wechatManager;
    this.wechatManager = undefined;
    this.wechatRunning = false;
    try {
      await manager?.stop();
      return { ok: true, message: '微信连接已断开，登录凭据已保留' };
    } catch (err) {
      throw new Error('本地微信连接已停止，但停止通知或清理失败：' + describeError(err));
    } finally {
      this.wechatStatus = 'idle';
      this.wechatError = undefined;
      this.wechatQrCode = undefined;
      this.wechatLoginUser = undefined;
      await this.saveWeChatConfig({ enabled: false });
      this.info('微信本地连接已断开');
    }
  }

  async logoutWeChat(): Promise<{ ok: boolean; message: string }> {
    const wx = this.resolver().resolveChannels().wechat;
    if (!['personal', 'ilink_bot'].includes(wx.mode) || wx.personal.puppet !== 'ilink') {
      throw new Error('当前仅支持 iLink 模式清除登录；其他模式请在对应服务商撤销授权');
    }
    let warning = '';
    try { await this.stopWeChatService(); }
    catch (error) { warning = '（' + describeError(error) + '）'; }
    new IlinkAccountStore(wx.authDir, wx.personal.ilinkAccountId).clearSession();
    return { ok: true, message: '已清除本地微信登录，下次连接需扫码；远端绑定未撤销' + warning };
  }

`+s.slice(b);
s=s.replace("        this.info(`[WeChat] ${line}`);", "        this.info(`[WeChat] ${line}`);\n        if (this.wechatManager !== manager) return;");
s=s.replace('    if (manager.qrCodeText) {', "    if (this.wechatManager !== manager) return { ok: true, message: '微信启动已取消' };\n\n    if (manager.qrCodeText) {");
return s;});
edit('src/gui/main.ts',s=>s.replace("  ipcMain.handle('gui:stopWeChatService'", "  ipcMain.handle('gui:logoutWeChat', () => invoke(() => service.logoutWeChat()));\n  ipcMain.handle('gui:stopWeChatService'"));
edit('src/gui/renderer/preload.cjs',s=>s.replace('  stopWeChatService:', "  logoutWeChat: () => call('gui:logoutWeChat'),\n  stopWeChatService:"));
edit('src/gui/renderer/index.html',s=>s.replace('<button type="button" class="btn primary" id="toggleWxServiceBtn"', '<button type="button" class="btn danger" id="logoutWxBtn" style="font-size:12px;">退出本地登录</button>\n                  <button type="button" class="btn primary" id="toggleWxServiceBtn"'));
edit('src/gui/renderer/app.js',s=>s.replace("toggleBtn.textContent = '停止微信服务';", "toggleBtn.textContent = '断开连接';").replace("showToast('微信服务已停止', 'info');", "showToast('微信连接已断开，登录凭据已保留', 'info');")+`
$('logoutWxBtn')?.addEventListener('click', async () => {
  if (!window.confirm('断开微信并清除本地登录凭据？下次连接需重新扫码。此操作不会撤销微信端绑定，也不会删除聊天记录。')) return;
  const button = $('logoutWxBtn');
  button.disabled = true;
  try {
    const result = await window.hap.logoutWeChat();
    showToast(result.message, 'info');
  } catch (error) {
    showToast('退出登录失败：' + error.message, 'error');
  } finally {
    button.disabled = false;
    await renderWeChatView();
  }
});
`);
