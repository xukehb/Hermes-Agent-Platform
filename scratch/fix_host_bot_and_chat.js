import fs from 'node:fs';

const file = 'src/gui/renderer/app.js';
let js = fs.readFileSync(file, 'utf8');

// 1. 查找并替换 openNodeBotConfigModal, saveNodeBotConfig, testNodeBotAlertModal, testNodeBotAlert, chatWithNodeAgent
const oldBlockStart = `window.openNodeBotConfigModal = (preServerId) => {`;
const oldBlockEnd = `window.chatWithNodeAgent = () => {
  const targetId = activePanoramaTarget || 'local';
  const s = targetId === 'local' ? null : cachedServers.find(item => item.id === targetId);
  show('chat');
  const textarea = $('composerTextarea');
  if (textarea) {
    textarea.value = targetId === 'local'
      ? '请帮我巡检本机宿主系统的 CPU、内存与磁盘占用情况。'
      : \`请帮我巡检远程服务器 [\${s?.name || targetId}] (\${s?.host || ''}) 的系统健康状况与 Docker 服务。\`;
    textarea.focus();
  }
};`;

const newBlock = `// 本地宿主告警机器人配置读取与持久化
function getLocalHostBotConfig() {
  try {
    const raw = localStorage.getItem('hap_local_bot_config');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {
    enabled: true,
    agentId: 'ops',
    channel: 'feishu',
    webhookUrl: '',
    targetId: '',
    secret: '',
    alertOnHighCpu: true,
    alertOnHighMem: true,
    alertOnHighDisk: true,
    alertOnOffline: true,
    autoHealing: true,
  };
}

function saveLocalHostBotConfig(cfg) {
  try {
    localStorage.setItem('hap_local_bot_config', JSON.stringify(cfg));
  } catch (e) {}
}

window.openNodeBotConfigModal = (preServerId) => {
  try {
    const modal = $('nodeBotConfigModal');
    if (!modal) {
      showToast('未能定位机器人配置弹窗组件', 'error');
      return;
    }

    const targetId = (typeof preServerId === 'string' && preServerId && !preServerId.includes('object'))
      ? preServerId
      : (activePanoramaTarget || 'local');

    const select = $('nodeBotServerSelect');
    if (select) {
      const servers = cachedServers.length > 0 ? cachedServers : (state.servers || []);
      const opts = ['<option value="local">🖥️ 本机宿主系统 (Local Host)</option>']
        .concat(servers.map(s => \`<option value="\${esc(s.id)}">🌐 \${esc(s.name)} (\${esc(s.host)})\</option>\`))
        .join('');
      select.innerHTML = opts;
      select.value = targetId;
    }

    // 读取并回填当前节点已配置的 botConfig
    let botCfg;
    if (targetId === 'local') {
      botCfg = getLocalHostBotConfig();
    } else {
      const server = cachedServers.find(s => s.id === targetId);
      botCfg = server?.botConfig || {
        enabled: true,
        agentId: server?.agentId || 'ops',
        channel: 'feishu',
        webhookUrl: '',
        targetId: '',
        secret: '',
        alertOnHighCpu: true,
        alertOnHighMem: true,
        alertOnHighDisk: true,
        alertOnOffline: true,
        autoHealing: true,
      };
    }

    if ($('nodeBotAgentSelect')) $('nodeBotAgentSelect').value = botCfg.agentId || 'ops';
    if ($('nodeBotChannelSelect')) {
      $('nodeBotChannelSelect').value = botCfg.channel || 'feishu';
      if (typeof window.updateNodeBotChannelFields === 'function') {
        window.updateNodeBotChannelFields();
      }
    }
    if ($('nodeBotWebhookUrl')) $('nodeBotWebhookUrl').value = botCfg.webhookUrl || '';
    if ($('nodeBotTargetId')) $('nodeBotTargetId').value = botCfg.targetId || '';
    if ($('nodeBotSecret')) $('nodeBotSecret').value = botCfg.secret || '';
    if ($('nodeBotAlertCpu')) $('nodeBotAlertCpu').checked = botCfg.alertOnHighCpu !== false;
    if ($('nodeBotAlertMem')) $('nodeBotAlertMem').checked = botCfg.alertOnHighMem !== false;
    if ($('nodeBotAlertDisk')) $('nodeBotAlertDisk').checked = botCfg.alertOnHighDisk !== false;
    if ($('nodeBotAlertOffline')) $('nodeBotAlertOffline').checked = botCfg.alertOnOffline !== false;
    if ($('nodeBotAutoHealing')) $('nodeBotAutoHealing').checked = botCfg.autoHealing !== false;

    if (modal.open) {
      modal.close();
    }
    modal.showModal();
  } catch (err) {
    console.error('打开机器人配置弹窗失败:', err);
    showToast('打开弹窗异常: ' + err.message, 'error');
  }
};

window.saveNodeBotConfig = async (e) => {
  e.preventDefault();
  const serverId = $('nodeBotServerSelect')?.value || 'local';
  const agentId = $('nodeBotAgentSelect')?.value || 'ops';
  const channel = $('nodeBotChannelSelect')?.value || 'feishu';
  const webhookUrl = $('nodeBotWebhookUrl')?.value?.trim() || '';
  const targetId = $('nodeBotTargetId')?.value?.trim() || '';
  const secret = $('nodeBotSecret')?.value?.trim() || '';
  const alertOnHighCpu = $('nodeBotAlertCpu')?.checked ?? true;
  const alertOnHighMem = $('nodeBotAlertMem')?.checked ?? true;
  const alertOnHighDisk = $('nodeBotAlertDisk')?.checked ?? true;
  const alertOnOffline = $('nodeBotAlertOffline')?.checked ?? true;
  const autoHealing = $('nodeBotAutoHealing')?.checked ?? true;

  const botConfig = {
    enabled: true,
    agentId,
    channel,
    webhookUrl,
    targetId,
    secret,
    alertOnHighCpu,
    alertOnHighMem,
    alertOnHighDisk,
    alertOnOffline,
    autoHealing,
  };

  try {
    if (serverId === 'local') {
      saveLocalHostBotConfig(botConfig);
      showToast('已更新本机宿主系统的专属智能体与告警设置！', 'success');
    } else {
      const s = cachedServers.find(item => item.id === serverId);
      if (s) {
        await window.hap.upsertServer({
          ...s,
          agentId,
          botConfig,
        });
        showToast(\`服务器 [\${s.name}] 专属机器人与告警策略已保存！\`, 'success');
        await renderServers();
      }
    }

    $('nodeBotConfigModal')?.close();
    if (typeof refreshHostView === 'function') {
      refreshHostView();
    }
  } catch (err) {
    showToast('保存机器人设置失败: ' + err.message, 'error');
  }
};

window.testNodeBotAlertModal = async () => {
  const serverId = $('nodeBotServerSelect')?.value || activePanoramaTarget || 'local';
  const channel = $('nodeBotChannelSelect')?.value || 'feishu';
  const webhookUrl = $('nodeBotWebhookUrl')?.value?.trim() || '';
  const targetId = $('nodeBotTargetId')?.value?.trim() || '';
  const secret = $('nodeBotSecret')?.value?.trim() || '';
  const agentId = $('nodeBotAgentSelect')?.value || 'ops';

  if (!webhookUrl && channel !== 'telegram') {
    showToast('请先填写 Webhook 地址后再进行测试', 'warn');
    return;
  }

  showToast('正在发送测试告警消息...', 'info');
  try {
    const res = await window.hap.testServerBotAlert({
      serverId,
      botConfig: {
        enabled: true,
        agentId,
        channel,
        webhookUrl,
        targetId,
        secret,
      },
    });
    if (res.ok) {
      showToast(res.message, 'success');
    } else {
      showToast(res.message, 'error');
    }
  } catch (err) {
    showToast('测试异常：' + err.message, 'error');
  }
};

window.testNodeBotAlert = async () => {
  const targetId = activePanoramaTarget || 'local';
  let botCfg;
  if (targetId === 'local') {
    botCfg = getLocalHostBotConfig();
  } else {
    const s = cachedServers.find(item => item.id === targetId);
    botCfg = s?.botConfig || {
      enabled: true,
      agentId: s?.agentId || 'ops',
      channel: 'feishu',
      webhookUrl: '',
    };
  }

  if (!botCfg.webhookUrl && botCfg.channel !== 'telegram') {
    showToast('当前节点尚未配置机器人 Webhook，请先设置', 'info');
    window.openNodeBotConfigModal(targetId);
    return;
  }

  showToast('正在向专属机器人发送测试告警...', 'info');
  try {
    const res = await window.hap.testServerBotAlert({
      serverId: targetId,
      botConfig: botCfg,
    });
    if (res.ok) {
      showToast(res.message, 'success');
    } else {
      showToast(res.message, 'error');
    }
  } catch (err) {
    showToast('测试异常：' + err.message, 'error');
  }
};

window.chatWithNodeAgent = () => {
  const targetId = activePanoramaTarget || 'local';
  const s = targetId === 'local' ? null : cachedServers.find(item => item.id === targetId);
  const prompt = targetId === 'local'
    ? '请帮我全面巡检本机宿主系统的 CPU 拓扑、内存负载、全盘挂载与异常进程状态：'
    : \`请帮我巡检远程服务器 [\${s?.name || targetId}] (\${s?.host || ''}) 的系统健康状况与 Docker 服务：\`;

  show('chat');
  const agentSelect = $('chatAgentSelect');
  if (agentSelect) {
    agentSelect.value = 'ops';
  }
  const input = $('chatInput');
  if (input) {
    input.value = prompt;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    if (typeof updateComposerState === 'function') {
      updateComposerState();
    }
  }
  showToast(\`已在会话中激活运维智能体 (Ops Agent) 并绑定节点 [\${targetId === 'local' ? '本机宿主' : (s?.name || targetId)}]\`, 'success');
};`;

// 替换整个区块
const startIdx = js.indexOf(oldBlockStart);
const endIdx = js.indexOf(oldBlockEnd);

if (startIdx !== -1 && endIdx !== -1) {
  js = js.slice(0, startIdx) + newBlock + js.slice(endIdx + oldBlockEnd.length);
  console.log('Replaced node bot & chat block successfully');
} else {
  console.log('Could not find exact block, searching regex');
  js = js.replace(/window\.openNodeBotConfigModal[\s\S]*?window\.chatWithNodeAgent = \(\) => \{[\s\S]*?\};\n\};?/m, newBlock);
}

// 2. 更新 refreshHostView 渲染 panoramaBotCard 时读取 getLocalHostBotConfig
js = js.replace(
  `const s = isLocal ? null : cachedServers.find(item => item.id === targetId);
    const botCfg = s?.botConfig;`,
  `const s = isLocal ? null : cachedServers.find(item => item.id === targetId);
    const botCfg = isLocal ? getLocalHostBotConfig() : s?.botConfig;`
);

fs.writeFileSync(file, js, 'utf8');
console.log('Successfully upgraded host bot config & chatWithNodeAgent logic in app.js');
