/* ==========================================================================
   HAP Studio · 官方客户端前端核心驱动
   - 完全还原 Codex Desktop / ChatGPT Projects 树形项目会话导航
   - 彻底修复 Windows 路径斜杠转义与匹配问题，保证导入项目 100% 稳定渲染
   - 会话完整持久化 & 点击会话即时无缝切换打开
   - 深度集成 Git 版本协同：分支探测、未提交文件审查、AI Commit、Push 推送与 Pull 拉取
   ========================================================================== */

const $ = (id) => document.getElementById(id);

function esc(val) {
  if (val === undefined || val === null) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 规范化文件系统路径（统一正斜杠与小写比较，彻底解决 Windows 反斜杠转义与大小写不匹配）
function normPath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

function formatFileSize(bytes) {
  if (!bytes || isNaN(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function showToast(message, type = 'info') {
  // 智能查找当前处于开启状态的顶层模态框
  const openDialogs = document.querySelectorAll('dialog[open]');
  const activeDialog = openDialogs.length > 0 ? openDialogs[openDialogs.length - 1] : null;

  let container = $('toastContainer');
  if (activeDialog) {
    let dialogContainer = activeDialog.querySelector('.toast-container');
    if (!dialogContainer) {
      dialogContainer = document.createElement('div');
      dialogContainer.className = 'toast-container in-dialog';
      activeDialog.appendChild(dialogContainer);
    }
    container = dialogContainer;
  }

  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${esc(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 200);
  }, 2600);
}

function copyText(text, label = '内容') {
  navigator.clipboard.writeText(text).then(
    () => showToast(`已复制${label}到剪贴板`, 'success'),
    (err) => showToast('复制失败：' + err.message, 'error')
  );
}

async function showConfirm({ title = '确认操作', message = '确定要继续吗？', okText = '确认', cancelText = '取消', isDanger = false } = {}) {
  const dialog = $('confirmDialog');
  if (!dialog) return window.confirm(message);

  $('confirmTitle').textContent = title;
  $('confirmMessage').innerHTML = message;
  const okBtn = $('confirmOkBtn');
  const cancelBtn = $('confirmCancelBtn');

  okBtn.textContent = okText;
  cancelBtn.textContent = cancelText;

  if (isDanger) {
    okBtn.className = 'btn danger';
  } else {
    okBtn.className = 'btn primary';
  }

  return new Promise((resolve) => {
    const cleanup = () => {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onClose);
    };
    const onOk = () => {
      cleanup();
      dialog.close();
      resolve(true);
    };
    const onCancel = () => {
      cleanup();
      dialog.close();
      resolve(false);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}

// 格式化相对时间 (如刚刚, 2h, 24h, 3d, 14d, 30d) 对标截图
function getRelativeTimeStr(isoString) {
  if (!isoString) return '刚刚';
  const diffMs = Date.now() - new Date(isoString).getTime();
  if (diffMs < 0 || isNaN(diffMs)) return '刚刚';
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return '刚刚';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d`;
  const diffMonth = Math.floor(diffDay / 30);
  return `${diffMonth}mo`;
}

// ==========================================================================
// 全局状态与会话本地持久化
// ==========================================================================

const SESSIONS_STORAGE_KEY = 'hap_chat_sessions_v2';
const ACTIVE_SESSION_STORAGE_KEY = 'hap_active_session_v2';

let state = {
  configPath: '',
  projects: [],
  providers: [],
  models: [],
  skills: [],
  plugins: [],
  permissions: {
    mode: 'full-access',
    allowShell: true,
    allowFsWrite: true,
    allowNetwork: true,
    allowSpawnSubagent: true,
    autoApproveTools: ['*'],
  },
  agents: [],
  targets: [],
  logs: [],
  presets: [],
};

const selectedProjectIds = new Set();
const selectedProviderIds = new Set();
const selectedModelAliases = new Set();
let currentLogFilter = 'all';

// 项目折叠状态与“展开更多”状态
const collapsedProjectIds = new Set();
const expandedProjectAllIds = new Set();

let currentActiveProject = '';
let currentGitStatus = null;

// 从 LocalStorage 加载会话
function loadSavedSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length > 0) {
        return list;
      }
    }
  } catch (e) {
    console.error('加载本地会话历史失败:', e);
  }
  return [
    {
      id: 'session_init',
      title: 'Global Styling And Themes',
      projectPath: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pinned: false,
      messages: [],
    },
  ];
}

let sessions = loadSavedSessions();
let currentSessionId = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) || sessions[0]?.id || 'session_init';

function saveSessionsToStorage() {
  try {
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, currentSessionId);
  } catch (e) {
    console.error('保存会话失败:', e);
  }
}

function currentSession() {
  let s = sessions.find((item) => item.id === currentSessionId);
  if (!s) {
    if (sessions.length > 0) {
      currentSessionId = sessions[0].id;
      return sessions[0];
    }
    s = {
      id: 'session_' + Date.now(),
      title: '新对话',
      projectPath: currentActiveProject,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pinned: false,
      messages: [],
    };
    sessions.unshift(s);
    currentSessionId = s.id;
    saveSessionsToStorage();
  }
  return s;
}

// ==========================================================================
// VS Code 预览器与联动
// ==========================================================================

function openCodeViewer(title, code, filePath = '') {
  const modal = $('codeViewerModal');
  if (!modal) return;

  $('codeViewerTitle').textContent = title || 'code_snippet';
  const pre = $('codeViewerContent');
  pre.textContent = code;

  const lines = code.split('\n').length;
  const lineNums = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  $('codeLineNumbers').textContent = lineNums;

  $('codeViewerCopyBtn').onclick = () => copyText(code, '代码');
  $('codeViewerOpenVsCodeBtn').onclick = () => {
    if (filePath) openPathInVsCode(filePath);
    else if (currentActiveProject) openPathInVsCode(currentActiveProject);
    else showToast('未关联具体文件路径', 'info');
  };
  $('closeCodeViewerBtn').onclick = () => modal.close();

  modal.showModal();
}

async function openPathInVsCode(path) {
  if (!path) {
    showToast('未选择有效的文件或项目路径', 'info');
    return;
  }
  try {
    const res = await window.hap.openInVsCode(path);
    if (res.ok) {
      showToast(`已在 VS Code 中打开：${path}`, 'success');
    } else {
      showToast('唤起 VS Code 失败：' + (res.error || '未知错误'), 'error');
    }
  } catch (error) {
    showToast('唤起 VS Code 失败：' + error.message, 'error');
  }
}
async function openPathInExplorer(path) {
  if (!path) {
    showToast('未选择有效的文件或项目路径', 'info');
    return;
  }
  try {
    const res = await window.hap.openInExplorer(path);
    if (res.ok) {
      showToast(`已在文件资源管理器中打开`, 'success');
    } else {
      showToast('打开资源管理器失败：' + (res.error || '未知错误'), 'error');
    }
  } catch (error) {
    showToast('打开失败：' + error.message, 'error');
  }
}

async function openPathInTerminal(path) {
  if (!path) {
    showToast('未选择有效的文件或项目路径', 'info');
    return;
  }
  try {
    const res = await window.hap.openInTerminal(path);
    if (res.ok) {
      showToast(`已在终端中打开项目目录`, 'success');
    } else {
      showToast('打开终端失败：' + (res.error || '未知错误'), 'error');
    }
  } catch (error) {
    showToast('打开失败：' + error.message, 'error');
  }
}

// 统一全局上下文浮层菜单
function showContextMenu(items, mouseEvent) {
  if (mouseEvent) {
    mouseEvent.preventDefault();
    mouseEvent.stopPropagation();
  }

  // 清除旧菜单
  document.querySelectorAll('.context-menu, .context-menu-backdrop').forEach((el) => el.remove());

  const backdrop = document.createElement('div');
  backdrop.className = 'context-menu-backdrop';

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  items.forEach((item) => {
    if (item.divider) {
      const div = document.createElement('div');
      div.className = 'context-menu-divider';
      menu.appendChild(div);
      return;
    }

    const row = document.createElement('div');
    row.className = `context-menu-item ${item.danger ? 'danger' : ''}`;
    row.innerHTML = `${item.icon || ''}<span>${esc(item.label)}</span>`;
    row.onclick = (e) => {
      e.stopPropagation();
      backdrop.remove();
      menu.remove();
      item.action?.();
    };
    menu.appendChild(row);
  });

  backdrop.onclick = () => {
    backdrop.remove();
    menu.remove();
  };

  document.body.appendChild(backdrop);
  document.body.appendChild(menu);

  // 定位计算
  let x = mouseEvent ? mouseEvent.clientX : 100;
  let y = mouseEvent ? mouseEvent.clientY : 100;

  const rect = menu.getBoundingClientRect();
  if (x + rect.width > window.innerWidth - 10) {
    x = window.innerWidth - rect.width - 10;
  }
  if (y + rect.height > window.innerHeight - 10) {
    y = window.innerHeight - rect.height - 10;
  }

  menu.style.left = `${Math.max(10, x)}px`;
  menu.style.top = `${Math.max(10, y)}px`;
}

$('openProjectVsCodeTopBtn')?.addEventListener('click', () => {
  openPathInVsCode(currentActiveProject);
});

// ==========================================================================
// Markdown 与代码块解析
// ==========================================================================

function renderMarkdownContent(rawText) {
  if (!rawText) return '';

  const codeBlocks = [];
  let processed = rawText.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push({ lang: lang.trim() || 'plaintext', code });
    return placeholder;
  });

  let safe = esc(processed);

  // Markdown 表格解析 (| Header | Header |)
  safe = safe.replace(/((?:\|[^\n\r|]+\|[\r\n]+)+(?:\|[-:\s|]+\|[\r\n]+)(?:(?:\|[^\n\r|]+\|(?:[\r\n]+|$))+))/g, (match) => {
    const rows = match.trim().split('\n').map(r => r.trim()).filter(Boolean);
    if (rows.length < 2) return match;
    const headerCols = rows[0].slice(1, -1).split('|').map(c => c.trim());
    const bodyRows = rows.slice(2);
    let html = '<div style="overflow-x:auto;margin:12px 0;"><table class="md-table"><thead><tr>';
    headerCols.forEach(col => { html += `<th>${col}</th>`; });
    html += '</tr></thead><tbody>';
    bodyRows.forEach(row => {
      const cols = row.slice(1, -1).split('|').map(c => c.trim());
      html += '<tr>';
      cols.forEach(col => { html += `<td>${col}</td>`; });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
  });

  // 标题
  safe = safe.replace(/^### (.*$)/gim, '<h3 style="margin:14px 0 6px;font-size:15px;font-weight:700;color:var(--text-main);">$1</h3>');
  safe = safe.replace(/^## (.*$)/gim, '<h2 style="margin:16px 0 8px;font-size:16.5px;font-weight:700;color:var(--text-main);">$1</h2>');
  safe = safe.replace(/^# (.*$)/gim, '<h1 style="margin:18px 0 10px;font-size:18.5px;font-weight:700;color:var(--text-main);">$1</h1>');

  // 分割线
  safe = safe.replace(/^---+$/gim, '<hr style="border:none;border-top:1px solid var(--border-default);margin:14px 0;" />');

  // 引用块 (Blockquote)
  safe = safe.replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>');

  // 任务复选框 (Checklists)
  safe = safe.replace(/^[\*\-] \[ \] (.*$)/gim, '<div class="md-list-item"><span style="color:#94a3b8;font-size:14px;"></span><span>$1</span></div>');
  safe = safe.replace(/^[\*\-] \[x\] (.*$)/gim, '<div class="md-list-item"><span style="color:#16a34a;font-weight:700;font-size:14px;"></span><span style="text-decoration:line-through;color:var(--text-muted);">$1</span></div>');

  // 无序列表与有序列表
  safe = safe.replace(/^[*-] (.*$)/gim, '<div class="md-list-item"><span class="md-bullet">•</span><span>$1</span></div>');
  safe = safe.replace(/^(\d+)\. (.*$)/gim, '<div class="md-list-item"><span class="md-number">$1.</span><span>$2</span></div>');

  // 图片解析 (![alt](url))
  safe = safe.replace(/!\[(.*?)\]\((.*?)\)/g, (match, alt, src) => {
    return `<div class="user-img-card" style="margin:10px 0;max-width:320px;" onclick="window.openImageLightbox('${src}', '${alt || '图片'}')"><img src="${src}" alt="${alt || '图片'}" /><div class="img-zoom-hint">查看大图</div></div>`;
  });

  // 加粗与行内代码
  safe = safe.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  safe = safe.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');

  // 段落
  safe = safe.replace(/\n\n/g, '</p><p>');
  safe = '<p>' + safe.replace(/\n/g, '<br/>') + '</p>';

  // 清理多余空段落包裹
  safe = safe.replace(/<p><\/p>/g, '');

  // 恢复代码块
  codeBlocks.forEach((block, index) => {
    const encoded = encodeURIComponent(block.code);
    const blockHtml = `
      <div class="codeblock-wrap">
        <div class="codeblock-bar">
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="codeblock-dots">
              <span class="dot red"></span>
              <span class="dot yellow"></span>
              <span class="dot green"></span>
            </div>
            <span class="codeblock-lang">${esc(block.lang)}</span>
          </div>
          <div class="codeblock-actions">
            <button type="button" class="codeblock-btn" onclick="window.viewCodeSnippet('${esc(block.lang)}', '${encoded}')" title="在全屏窗口查看代码">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <span>查看</span>
            </button>
            <button type="button" class="codeblock-btn" onclick="window.copyCodeSnippet('${encoded}')" title="复制完整代码">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span>复制</span>
            </button>
          </div>
        </div>
        <pre class="codeblock-pre"><code>${esc(block.code)}</code></pre>
      </div>
    `;
    safe = safe.replace(`__CODE_BLOCK_${index}__`, blockHtml);
  });

  return safe;
}

window.copyCodeSnippet = (encoded) => {
  const code = decodeURIComponent(encoded);
  copyText(code, '代码');
};

window.viewCodeSnippet = (lang, encoded) => {
  const code = decodeURIComponent(encoded);
  openCodeViewer(`snippet.${lang || 'txt'}`, code);
};

// ==========================================================================
// 树形项目与会话导航系统 (Tree View Navigation · 100% 稳定显示)
// ==========================================================================

function renderProjectsTree() {
  const container = $('projectsTreeContainer');
  if (!container) return;

  const projects = state.projects || [];

  if (projects.length === 0) {
    // 渲染通用会话
    const genericSessions = sessions.map((s) => {
      const isActive = s.id === currentSessionId;
      const timeStr = getRelativeTimeStr(s.updatedAt || s.createdAt);
      return `
        <div class="session-tree-item ${isActive ? 'active' : ''}" onclick="window.switchSession('${esc(s.id)}')">
          <span class="session-title-wrap" title="${esc(s.title || '新对话')}">${esc(s.title || '新对话')}</span>
          <span class="session-time-badge">${timeStr}</span>
          <div class="session-actions-hover">
            <div class="tree-action-btn delete-btn" title="删除会话" onclick="window.deleteSession('${esc(s.id)}', event)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </div>
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = `
      <div style="padding:4px 0;">
        ${genericSessions}
        <button class="btn secondary" style="margin-top:8px;width:100%;font-size:12px;" onclick="$('importProjectQuickBtn').click()">+ 导入本地工程</button>
      </div>
    `;
    return;
  }

  // 渲染每个工程目录作为主树节点（全部通过 ID 路由，彻底避免 Windows 反斜杠转义错误）
  container.innerHTML = projects.map((p) => {
    const isCollapsed = collapsedProjectIds.has(p.id);
    const showAll = expandedProjectAllIds.has(p.id);

    // 标准化路径比对：获取该工程下的所有会话
    const pNorm = normPath(p.path);
    const activeNorm = normPath(currentActiveProject);

    const projectSessions = sessions.filter((s) => {
      const sNorm = normPath(s.projectPath);
      return sNorm === pNorm || (!sNorm && pNorm === activeNorm);
    });

    const MAX_VISIBLE = 5;
    const visibleSessions = showAll ? projectSessions : projectSessions.slice(0, MAX_VISIBLE);
    const hasMore = projectSessions.length > MAX_VISIBLE;

    const sessionsHtml = visibleSessions.map((s) => {
      const isActive = s.id === currentSessionId;
      const timeStr = getRelativeTimeStr(s.updatedAt || s.createdAt);

      return `
        <div class="session-tree-item ${isActive ? 'active' : ''}" onclick="window.switchSession('${esc(s.id)}')">
          <span class="session-title-wrap" title="${esc(s.title || '新对话')}">${esc(s.title || '新对话')}</span>
          <span class="session-time-badge">${timeStr}</span>
          <div class="session-actions-hover">
            <div class="tree-action-btn" title="更多" onclick="window.openSessionMenu('${esc(s.id)}', event)">•••</div>
            <div class="tree-action-btn ${s.pinned ? 'pinned' : ''}" title="${s.pinned ? '取消置顶' : '置顶'}" onclick="window.togglePinSession('${esc(s.id)}', event)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>
            </div>
            <div class="tree-action-btn delete-btn" title="删除会话" onclick="window.deleteSession('${esc(s.id)}', event)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </div>
          </div>
        </div>
      `;
    }).join('');

    const seeAllBtnHtml = hasMore ? `
      <div class="see-all-toggle-btn" onclick="window.toggleProjectSeeAll('${esc(p.id)}', event)">
        ${showAll ? '收起' : `See all (${projectSessions.length})`}
      </div>
    ` : '';

    return `
      <div class="project-group-node">
        <div class="project-row" onclick="window.selectProjectById('${esc(p.id)}')" oncontextmenu="window.openProjectMenu('${esc(p.id)}', event)">
          <div class="project-row-left">
            <svg class="project-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span class="project-name-text" title="${esc(p.path)}">${esc(p.name)}</span>
          </div>
          <div class="project-row-actions">
            <div class="tree-action-btn" title="项目管理与操作" onclick="window.openProjectMenu('${esc(p.id)}', event)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
            </div>
            <div class="tree-action-btn" title="在该项目下新建对话" onclick="window.createNewSessionInProjectById('${esc(p.id)}', event)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </div>
          </div>
        </div>

        <div class="project-sessions-sublist" style="${isCollapsed ? 'display:none;' : ''}">
          ${sessionsHtml || '<div style="font-size:11.5px;color:var(--text-muted);padding:4px 10px;">暂无会话，点击 + 新建</div>'}
          ${seeAllBtnHtml}
        </div>
      </div>
    `;
  }).join('');
}

window.selectProjectById = (projectId) => {
  const p = (state.projects || []).find((item) => item.id === projectId);
  if (p) {
    currentActiveProject = p.path;
    renderProjectsTree();
    renderCurrentSessionMessages();
    updateGitStatus(currentActiveProject);
  }
};

window.openProjectVsCodeById = (projectId, event) => {
  if (event) event.stopPropagation();
  const p = (state.projects || []).find((item) => item.id === projectId);
  if (p) openPathInVsCode(p.path);
};

window.createNewSessionInProjectById = (projectId, event) => {
  if (event) event.stopPropagation();
  const p = (state.projects || []).find((item) => item.id === projectId);
  if (p) {
    currentActiveProject = p.path;
    startNewChat();
  }
};

window.toggleProjectSeeAll = (projectId, event) => {
  if (event) event.stopPropagation();
  if (expandedProjectAllIds.has(projectId)) {
    expandedProjectAllIds.delete(projectId);
  } else {
    expandedProjectAllIds.add(projectId);
  }
  renderProjectsTree();
};

window.togglePinSession = (sessionId, event) => {
  if (event) event.stopPropagation();
  const session = sessions.find((s) => s.id === sessionId);
  if (session) {
    session.pinned = !session.pinned;
    saveSessionsToStorage();
    showToast(session.pinned ? '会话已置顶' : '已取消置顶', 'info');
    renderProjectsTree();
  }
};

window.renameProjectById = async (projectId) => {
  const p = (state.projects || []).find((item) => item.id === projectId);
  if (!p) return;
  const newName = prompt('请输入项目的新显示名称：', p.name);
  if (newName && newName.trim() && newName.trim() !== p.name) {
    try {
      await window.hap.addProject({ name: newName.trim(), path: p.path });
      showToast('项目已重命名', 'success');
      await refresh();
    } catch (err) {
      showToast('重命名失败：' + err.message, 'error');
    }
  }
};

window.deleteProjectById = async (projectId) => {
  const p = (state.projects || []).find((item) => item.id === projectId);
  if (!p) return;
  const ok = await showConfirm({
    title: '移除工作区项目',
    message: `确定要从工作区移除项目 <strong>${esc(p.name)}</strong> 吗？<br/><span style="font-size:12px;color:var(--text-muted);">${esc(p.path)}</span><br/><br/>此操作仅从工作台移除管理，不会删除磁盘上的真实代码。`,
    okText: '确认移除',
    isDanger: true,
  });
  if (!ok) return;
  try {
    await window.hap.removeProject(projectId);
    selectedProjectIds.delete(projectId);
    showToast(`项目 "${p.name}" 已从工作区移除`, 'success');
    if (currentActiveProject && (normPath(currentActiveProject) === normPath(p.path) || currentActiveProject === p.path)) {
      const remaining = (state.projects || []).filter((item) => item.id !== projectId && normPath(item.path) !== normPath(p.path));
      currentActiveProject = remaining[0]?.path || '';
    }
    await refresh();
  } catch (err) {
    showToast('移除项目失败：' + err.message, 'error');
  }
};

window.renameSessionById = async (sessionId) => {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;
  const newTitle = prompt('请输入会话的新标题：', session.title || '新对话');
  if (newTitle && newTitle.trim()) {
    session.title = newTitle.trim();
    saveSessionsToStorage();
    showToast('会话已重命名', 'success');
    renderProjectsTree();
  }
};

window.openProjectMenu = (projectId, event) => {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const p = (state.projects || []).find((item) => item.id === projectId);
  if (!p) return;

  const items = [
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
      label: '在资源管理器中打开',
      action: () => openPathInExplorer(p.path),
    },
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
      label: '在 VS Code 中打开',
      action: () => openPathInVsCode(p.path),
    },
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
      label: '在系统终端中打开',
      action: () => openPathInTerminal(p.path),
    },
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
      label: '在此项目下新建对话',
      action: () => {
        currentActiveProject = p.path;
        startNewChat();
      },
    },
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v12"/><path d="M18 9a9 9 0 0 0-9 9"/></svg>',
      label: '查看 Git 改动与审查',
      action: () => {
        currentActiveProject = p.path;
        window.openGitModalWithCurrentProject();
      },
    },
    { divider: true },
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
      label: '重命名项目',
      action: () => window.renameProjectById(p.id),
    },
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      label: '从工作区移除项目',
      danger: true,
      action: () => window.deleteProjectById(p.id),
    },
  ];

  showContextMenu(items, event);
};

window.openSessionMenu = (sessionId, event) => {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const s = sessions.find((item) => item.id === sessionId);
  if (!s) return;

  const items = [
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>',
      label: s.pinned ? '取消置顶' : '置顶此会话',
      action: () => window.togglePinSession(s.id),
    },
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
      label: '重命名会话',
      action: () => window.renameSessionById(s.id),
    },
    { divider: true },
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      label: '删除会话',
      danger: true,
      action: () => window.deleteSession(s.id),
    },
  ];

  showContextMenu(items, event);
};

// 核心：切换并打开会话
window.switchSession = (id) => {
  currentSessionId = id;
  const target = sessions.find((s) => s.id === id);
  if (target) {
    if (target.projectPath && target.projectPath !== currentActiveProject) {
      currentActiveProject = target.projectPath;
    }
  }
  saveSessionsToStorage();
  show('chat');
  renderProjectsTree();
  renderCurrentSessionMessages();
  updateGitStatus(currentActiveProject);
  $('chatInput')?.focus();
};

// 删除会话
window.deleteSession = async (id, event) => {
  if (event) event.stopPropagation();

  const target = sessions.find((s) => s.id === id);
  const ok = await showConfirm({
    title: '删除会话',
    message: `确定要删除会话 <strong>${esc(target?.title || '新对话')}</strong> 吗？删除后不可恢复。`,
    okText: '确认删除',
    isDanger: true,
  });
  if (!ok) return;

  sessions = sessions.filter((s) => s.id !== id);
  if (currentSessionId === id) {
    if (sessions.length > 0) {
      currentSessionId = sessions[0].id;
    } else {
      startNewChat();
      return;
    }
  }
  saveSessionsToStorage();
  showToast('会话已删除', 'info');
  renderProjectsTree();
  renderCurrentSessionMessages();
};

// 删除当前会话按钮
$('deleteCurrentChatBtn')?.addEventListener('click', async () => {
  const session = currentSession();
  const ok = await showConfirm({
    title: '删除当前会话',
    message: `确定要删除当前会话 <strong>${esc(session.title || '新对话')}</strong> 吗？`,
    okText: '确认删除',
    isDanger: true,
  });
  if (!ok) return;

  sessions = sessions.filter((s) => s.id !== currentSessionId);
  if (sessions.length > 0) {
    currentSessionId = sessions[0].id;
  } else {
    startNewChat();
    return;
  }
  saveSessionsToStorage();
  showToast('当前会话已删除', 'info');
  renderProjectsTree();
  renderCurrentSessionMessages();
});

window.insertPromptPrefix = (prefix) => {
  const input = $('chatInput');
  if (!input) return;
  input.value = prefix;
  input.focus();
  if (typeof updateComposerState === 'function') updateComposerState();
};

window.copyMessageText = (encodedText) => {
  try {
    const text = decodeURIComponent(encodedText);
    navigator.clipboard.writeText(text);
    showToast('文本已成功复制到剪贴板', 'success');
  } catch {
    showToast('复制失败', 'error');
  }
};

window.triggerHeroPrompt = (promptText) => {
  const input = $('chatInput');
  if (!input) return;
  input.value = promptText;
  if (typeof updateComposerState === 'function') updateComposerState();
  const form = $('chatForm');
  if (form) {
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
    } else {
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }
  }
};

// 全局点击委托代理，彻底保证所有按钮与卡片点击 100% 生效
document.addEventListener('click', (e) => {
  const heroCard = e.target.closest('[data-hero-prompt]');
  if (heroCard) {
    const prompt = heroCard.getAttribute('data-hero-prompt');
    if (prompt) triggerHeroPrompt(prompt);
    return;
  }

  const quickChip = e.target.closest('[data-quick-prefix]');
  if (quickChip) {
    const prefix = quickChip.getAttribute('data-quick-prefix');
    if (prefix) insertPromptPrefix(prefix);
    return;
  }
});

function renderCurrentSessionMessages() {
  const container = $('messagesInner');
  if (!container) return;

  const session = currentSession();

  // 更新顶部工作区指示器
  const proj = state.projects.find((p) => normPath(p.path) === normPath(currentActiveProject));
  const projName = proj?.name || (currentActiveProject ? currentActiveProject.split(/[\\/]/).pop() : '默认工程');
  const wsTextEl = $('currentWorkspaceNameText');
  if (wsTextEl) {
    wsTextEl.textContent = projName;
  }

  if (session.messages.length === 0) {
    const heroSubtitle = projName ? `当前绑定的工程：<strong>${esc(projName)}</strong>` : '选择或导入工作区项目，开启高效智能编排与自动化修复';

    container.innerHTML = `
      <div class="hero-welcome" id="heroWelcome">
        <div class="hero-logo">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
        </div>
        <h1 class="hero-title">今天有什么我可以帮你的？</h1>
        <p class="hero-subtitle">${heroSubtitle}</p>
        <div class="hero-grid">
          <div class="hero-card" onclick="triggerHeroPrompt('分析当前绑定的项目工程结构并列出关键模块与潜在风险')">
            <div class="hero-card-icon"></div>
            <div class="hero-card-title">分析工程架构</div>
            <div class="hero-card-sub">梳理模块依赖、调用拓扑与架构建议</div>
          </div>
          <div class="hero-card" onclick="triggerHeroPrompt('对当前项目进行全面的代码质量、安全漏洞与潜在 Bug 审查')">
            <div class="hero-card-icon"></div>
            <div class="hero-card-title">代码安全审查</div>
            <div class="hero-card-sub">自动化排查潜在代码缺陷与性能瓶颈</div>
          </div>
          <div class="hero-card" onclick="triggerHeroPrompt('为当前核心功能模块设计并编写高覆盖率的单元测试用例')">
            <div class="hero-card-icon"></div>
            <div class="hero-card-title">编写测试套件</div>
            <div class="hero-card-sub">生成高覆盖率的自动化测试用例并执行</div>
          </div>
          <div class="hero-card" onclick="triggerHeroPrompt('审查 Git 变更并协助生成规范的 Commit 提交和推送代码')">
            <div class="hero-card-icon"></div>
            <div class="hero-card-title">Git 协同与推送</div>
            <div class="hero-card-sub">一键审查 Diff 差异并自动提交代码</div>
          </div>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = session.messages.map((m, idx) => {
    const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

    if (m.role === 'user') {
      const encoded = encodeURIComponent(m.content || '');

      let attachmentsHtml = '';
      if (Array.isArray(m.attachments) && m.attachments.length > 0) {
        const itemsHtml = m.attachments.map((att) => {
          const isImg = att.kind === 'image' || (att.mimeType && att.mimeType.startsWith('image/'));
          const src = att.dataUrl || att.path;
          if (isImg && src) {
            const safeSrc = esc(src);
            const safeName = esc(att.fileName || '图片');
            return `
              <div class="user-img-card" onclick="window.openImageLightbox('${safeSrc}', '${safeName}')">
                <img src="${safeSrc}" alt="${safeName}" />
                <div class="img-zoom-hint">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                  <span>查看大图</span>
                </div>
              </div>
            `;
          }
          return `
            <div class="user-doc-card">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              <span>${esc(att.fileName || '文件附件')}</span>
              <span style="font-size:10.5px;color:var(--text-muted);">${formatFileSize(att.bytes)}</span>
            </div>
          `;
        }).join('');

        attachmentsHtml = `<div class="user-attachments-grid">${itemsHtml}</div>`;
      }

      return `
        <div class="msg-row user">
          <div class="user-bubble-wrapper">
            ${attachmentsHtml}
            ${m.content ? `<div class="user-bubble">${esc(m.content)}</div>` : ''}
            <div class="user-meta-row">
              ${timeStr ? `<span>${esc(timeStr)}</span> · ` : ''}
              <span style="cursor:pointer;" onclick="copyMessageText('${encoded}')" title="复制我的提问">复制</span>
            </div>
          </div>
        </div>
      `;
    }

    let reasoning = (m.reasoning || '').trim();
    let content = m.content || '';

    // 如果内容包含 <think>...</think> 标签，自动剥离并提取为思考卡片
    if (content.includes('<think>')) {
      const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/i);
      if (thinkMatch) {
        if (!reasoning) {
          reasoning = thinkMatch[1].trim();
        }
        content = content.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
      }
    }

    const reasoningHtml = reasoning ? `
      <details class="thinking-box" open>
        <summary class="thinking-header">
          <div class="thinking-title-row">
            <svg class="thinking-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z"/>
              <line x1="9" y1="21" x2="15" y2="21"/>
            </svg>
            <span>深度思考过程</span>
          </div>
          <svg class="thinking-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </summary>
        <div class="thinking-content">
          ${renderMarkdownContent(reasoning)}
        </div>
      </details>
    ` : '';

    const encodedAnswer = encodeURIComponent(content || '');

    return `
      <div class="msg-row assistant">
        <div class="assistant-container">
          <div class="assistant-avatar">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </div>
          <div class="assistant-content">
            ${reasoningHtml}
            ${renderMarkdownContent(content)}
            <div class="assistant-footer-actions">
              <button type="button" class="msg-action-btn" onclick="copyMessageText('${encodedAnswer}')" title="复制完整回答">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span>复制回答</span>
              </button>
              ${timeStr ? `<span style="font-size:11px;color:var(--text-muted);margin-left:auto;">${esc(timeStr)}</span>` : ''}
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  const threadContainer = $('chatThreadContainer');
  if (threadContainer) {
    setTimeout(() => {
      threadContainer.scrollTop = threadContainer.scrollHeight;
    }, 50);
  }
}

function startNewChat() {
  const newId = 'session_' + Date.now();
  sessions.unshift({
    id: newId,
    title: '新对话',
    projectPath: currentActiveProject,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pinned: false,
    messages: [],
  });
  currentSessionId = newId;
  saveSessionsToStorage();
  show('chat');
  renderProjectsTree();
  renderCurrentSessionMessages();
  $('chatInput').focus();
}

// 顶部 + New Conversation 按钮
$('newChatBtn')?.addEventListener('click', startNewChat);

// 全局辅助按钮
$('globalHistoryBtn')?.addEventListener('click', () => {
  show('chat');
  showToast('已显示全部工程对话列表', 'info');
});

$('scheduledTasksBtn')?.addEventListener('click', () => {
  show('logs');
  showToast('查看自动化与运行任务', 'info');
});

// 快捷导入本地工程
$('importProjectQuickBtn')?.addEventListener('click', async () => {
  try {
    const project = await window.hap.importProject();
    if (project) {
      showToast(`已成功导入目录：${project.name}`, 'success');
      currentActiveProject = project.path;
      await refresh();
    }
  } catch (error) {
    showToast('导入目录失败：' + error.message, 'error');
  }
});

// ==========================================================================
// Git 版本控制与协同工作流 (Git Status, Commit, Push, Pull)
// ==========================================================================

async function updateGitStatus(projectPath) {
  const branchTopText = $('gitBranchTopText');
  const badgeTop = $('gitChangesTopBadge');
  if (!branchTopText) return;

  if (!projectPath) {
    branchTopText.textContent = 'Git: 未选工程';
    if (badgeTop) badgeTop.style.display = 'none';
    currentGitStatus = null;
    return;
  }

  try {
    const status = await window.hap.getGitStatus(projectPath);
    currentGitStatus = status;

    if (!status.isRepo) {
      branchTopText.textContent = 'Git: 未初始化';
      if (badgeTop) badgeTop.style.display = 'none';
      return;
    }

    branchTopText.textContent = `Git: ${status.branch}`;
    if (badgeTop) {
      if (status.uncommittedCount > 0) {
        badgeTop.textContent = String(status.uncommittedCount);
        badgeTop.style.display = 'inline-block';
      } else {
        badgeTop.style.display = 'none';
      }
    }
  } catch (error) {
    branchTopText.textContent = 'Git: 错误';
    if (badgeTop) badgeTop.style.display = 'none';
  }
}

function formatGitDiffToHtml(rawDiff) {
  if (!rawDiff) return '<div class="git-diff-line normal">（无差异内容）</div>';

  const lines = rawDiff.split('\n');
  return lines.map((line) => {
    const escaped = esc(line);
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      return `<div class="git-diff-line meta">${escaped}</div>`;
    }
    if (line.startsWith('@@')) {
      return `<div class="git-diff-line chunk">${escaped}</div>`;
    }
    if (line.startsWith('+')) {
      return `<div class="git-diff-line add">${escaped}</div>`;
    }
    if (line.startsWith('-')) {
      return `<div class="git-diff-line del">${escaped}</div>`;
    }
    return `<div class="git-diff-line normal">${escaped}</div>`;
  }).join('');
}

let currentInlineDiffRaw = '';
let currentInlineDiffFile = '';

async function loadInlineDiff(file) {
  if (!currentActiveProject) return;

  currentInlineDiffFile = file || '';
  const titleEl = $('gitInlineDiffFileTitle');
  const contentEl = $('gitInlineDiffContent');

  if (titleEl) {
    titleEl.textContent = file ? `Diff: ${file}` : '工作区全局差异补丁 (All in one)';
  }
  if (contentEl) {
    contentEl.innerHTML = '<div class="git-diff-line normal" style="color:#858585;">正在提取差异代码...</div>';
  }

  // 高亮左侧激活文件行
  document.querySelectorAll('.git-file-row').forEach((row) => {
    row.classList.toggle('active', row.dataset.file === (file || '__ALL__'));
  });

  try {
    const res = await window.hap.gitDiff(currentActiveProject, file);
    currentInlineDiffRaw = res.diff || '（暂无代码差异）';
    if (contentEl) {
      contentEl.innerHTML = formatGitDiffToHtml(currentInlineDiffRaw);
    }
  } catch (error) {
    currentInlineDiffRaw = error.message;
    if (contentEl) {
      contentEl.innerHTML = `<div class="git-diff-line del">提取差异失败：${esc(error.message)}</div>`;
    }
  }
}

$('gitInlineDiffCopyBtn')?.addEventListener('click', () => {
  if (currentInlineDiffRaw) copyText(currentInlineDiffRaw, 'Diff 差异代码');
});

$('gitInlineDiffOpenVsCodeBtn')?.addEventListener('click', () => {
  if (currentActiveProject) {
    const target = currentInlineDiffFile ? `${currentActiveProject}/${currentInlineDiffFile}` : currentActiveProject;
    openPathInVsCode(target);
  }
});

$('viewAllDiffsBtn')?.addEventListener('click', () => {
  loadInlineDiff('');
});

function renderGitModalContent() {
  const modal = $('gitModal');
  if (!modal) return;

  if ($('gitProjectPathText')) $('gitProjectPathText').textContent = currentActiveProject || '未选择工程';

  if (!currentGitStatus || !currentGitStatus.isRepo) {
    if ($('gitNotRepoState')) $('gitNotRepoState').style.display = 'block';
    if ($('gitRepoState')) $('gitRepoState').style.display = 'none';
    if ($('gitBranchBadge')) $('gitBranchBadge').textContent = '未初始化';
    if ($('gitRemoteUrlText')) $('gitRemoteUrlText').textContent = '-';
    return;
  }

  if ($('gitNotRepoState')) $('gitNotRepoState').style.display = 'none';
  if ($('gitRepoState')) $('gitRepoState').style.display = 'flex';

  if ($('gitBranchBadge')) $('gitBranchBadge').textContent = currentGitStatus.branch || 'main';
  if ($('gitRemoteUrlText')) $('gitRemoteUrlText').textContent = currentGitStatus.remoteUrl || '无远程仓库 (本地)';
  if ($('gitChangedCount')) $('gitChangedCount').textContent = String(currentGitStatus.uncommittedCount || 0);
  if ($('gitFileListCount')) $('gitFileListCount').textContent = String(currentGitStatus.uncommittedCount || 0);

  // 统计信息展示
  const statBadge = $('gitSummaryStatsBadge');
  if (statBadge) {
    const adds = currentGitStatus.totalAdditions || 0;
    const dels = currentGitStatus.totalDeletions || 0;
    statBadge.innerHTML = `共 <strong>${currentGitStatus.uncommittedCount || 0}</strong> 个文件改动 <span style="color:#2ea043;margin-left:6px;">+${adds}</span> <span style="color:#f85149;margin-left:2px;">-${dels}</span>`;
  }

  const list = $('gitChangedFilesList');
  if (!list) return;
  if (!currentGitStatus.changedFiles || currentGitStatus.changedFiles.length === 0) {
    list.innerHTML = '<div style="color:var(--text-muted);font-style:italic;padding:8px;font-size:12px;">工作区干净，暂无未提交变更</div>';
    const contentEl = $('gitInlineDiffContent');
    if (contentEl) contentEl.innerHTML = '<div class="git-diff-line normal" style="color:#858585;">工作区干净，暂无代码变更。</div>';
    if ($('gitInlineDiffFileTitle')) $('gitInlineDiffFileTitle').textContent = '无变更';
  } else {
    list.innerHTML = currentGitStatus.changedFiles.map((f) => {
      let badgeClass = 'M';
      let badgeLabel = '修改';
      if (f.status.includes('?') || f.status.includes('A')) {
        badgeClass = 'A';
        badgeLabel = '新增';
      } else if (f.status.includes('D')) {
        badgeClass = 'D';
        badgeLabel = '删除';
      }

      const adds = f.additions ? `<span style="color:#2ea043;font-size:11px;font-weight:600;">+${f.additions}</span>` : '';
      const dels = f.deletions ? `<span style="color:#f85149;font-size:11px;font-weight:600;">-${f.deletions}</span>` : '';
      const statSpan = (adds || dels) ? `<span style="display:flex;gap:3px;margin-left:auto;margin-right:6px;">${adds}${dels}</span>` : '';

      return `
        <div class="git-file-row" data-file="${esc(f.file)}" onclick="loadInlineDiff('${esc(f.file)}')">
          <div style="display:flex;align-items:center;gap:6px;overflow:hidden;flex:1;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;" title="${esc(f.file)}">${esc(f.file)}</span>
          </div>
          ${statSpan}
          <div class="git-file-row-actions">
            <span class="git-status-badge ${badgeClass}">${badgeLabel}</span>
          </div>
        </div>
      `;
    }).join('');

    // 默认加载第一个文件的 Diff
    if (!currentInlineDiffFile || !currentGitStatus.changedFiles.some((f) => f.file === currentInlineDiffFile)) {
      loadInlineDiff(currentGitStatus.changedFiles[0].file);
    } else {
      loadInlineDiff(currentInlineDiffFile);
    }
  }
}

$('gitStatusTopBtn')?.addEventListener('click', async () => {
  if (!currentActiveProject) {
    showToast('请先选择或导入一个工作区工程', 'info');
    return;
  }
  await updateGitStatus(currentActiveProject);
  renderGitModalContent();
  $('gitModal').showModal();
});

$('closeGitModalBtn')?.addEventListener('click', () => $('gitModal').close());
$('cancelGitModalBtn')?.addEventListener('click', () => $('gitModal').close());

$('refreshGitStatusBtn')?.addEventListener('click', async () => {
  if (!currentActiveProject) return;
  await updateGitStatus(currentActiveProject);
  renderGitModalContent();
  showToast('Git 状态已刷新', 'info');
});

$('gitInitRepoBtn')?.addEventListener('click', async () => {
  if (!currentActiveProject) return;
  try {
    const res = await window.hap.gitInit(currentActiveProject);
    showToast('已成功初始化 Git 仓库', 'success');
    await updateGitStatus(currentActiveProject);
    renderGitModalContent();
  } catch (error) {
    showToast('Git 初始化失败：' + error.message, 'error');
  }
});

$('aiGenerateCommitBtn')?.addEventListener('click', () => {
  if (!currentGitStatus || currentGitStatus.changedFiles.length === 0) {
    $('gitCommitMessageInput').value = 'chore: minor updates';
    return;
  }
  const files = currentGitStatus.changedFiles.map((f) => f.file);
  const sample = files.slice(0, 2).map((f) => f.split(/[\\/]/).pop()).join(', ');
  $('gitCommitMessageInput').value = `feat: update ${sample}${files.length > 2 ? ` and ${files.length - 2} other files` : ''}`;
  showToast('已智能生成 Commit 说明', 'info');
});

$('gitCommitBtn')?.addEventListener('click', async () => {
  if (!currentActiveProject) return;
  const msg = $('gitCommitMessageInput').value.trim();
  if (!msg) {
    showToast('请输入提交说明 (Commit Message)', 'info');
    $('gitCommitMessageInput').focus();
    return;
  }

  try {
    await window.hap.gitCommit(currentActiveProject, msg);
    $('gitCommitMessageInput').value = '';
    showToast('代码已成功提交到本地仓库！', 'success');
    await updateGitStatus(currentActiveProject);
    renderGitModalContent();
  } catch (error) {
    showToast('Git 提交失败：' + error.message, 'error');
  }
});

$('gitPushBtn')?.addEventListener('click', async () => {
  if (!currentActiveProject) return;
  showToast('正在推送到远端仓库...', 'info');
  try {
    const res = await window.hap.gitPush(currentActiveProject);
    showToast('代码已成功推送到远程仓库！', 'success');
    await updateGitStatus(currentActiveProject);
    renderGitModalContent();
  } catch (error) {
    showToast('Git 推送失败：' + error.message, 'error');
  }
});

$('gitPullBtn')?.addEventListener('click', async () => {
  if (!currentActiveProject) return;
  showToast('正在从远端拉取最新代码...', 'info');
  try {
    const res = await window.hap.gitPull(currentActiveProject);
    showToast('拉取完成：' + (res.summary || '代码已是最新'), 'success');
    await updateGitStatus(currentActiveProject);
    renderGitModalContent();
  } catch (error) {
    showToast('Git 拉取失败：' + error.message, 'error');
  }
});

// ==========================================================================
// 数据刷新与视图渲染
// ==========================================================================

async function refresh() {
  try {
    state = await window.hap.snapshot();

    if ($('configPathText')) $('configPathText').textContent = state.configPath || '未找到配置';

    const projects = state.projects || [];
    if (currentActiveProject) {
      const stillExists = projects.some((p) => normPath(p.path) === normPath(currentActiveProject));
      if (!stillExists) {
        currentActiveProject = projects[0]?.path || '';
      }
    } else if (projects.length > 0) {
      currentActiveProject = projects[0].path;
    }

    renderProjects();
    renderProjectsTree();
    renderSkills();
    renderPlugins();
    renderPermissions();
    renderAgents();
    renderProviders();
    renderModels();
    renderTargets();
    renderTelegramView();
    renderWeChatView();
    renderLogs(currentLogFilter);
    await renderServers();
    fillSelects();
    updateBatchBars();
    renderCurrentSessionMessages();
    updateGitStatus(currentActiveProject);
  } catch (error) {
    showToast('刷新状态失败：' + error.message, 'error');
  }
}

$('configPathBtn')?.addEventListener('click', () => {
  if (state.configPath) copyText(state.configPath, '配置路径');
});

// ==========================================================================
// 1. Skill 技能市场 (关联 GitHub 开源市场)
// ==========================================================================

function renderSkills(searchQuery = '') {
  const list = $('skillsList');
  if (!list) return;

  const skills = state.skills || [];
  const query = (searchQuery || $('skillSearchInput')?.value || '').toLowerCase().trim();

  const filtered = skills.filter((s) => {
    if (!query) return true;
    return (
      s.name.toLowerCase().includes(query) ||
      s.description.toLowerCase().includes(query) ||
      s.repo.toLowerCase().includes(query) ||
      (s.tags && s.tags.some((t) => t.toLowerCase().includes(query)))
    );
  });

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="empty-card" style="grid-column:1/-1;padding:32px;text-align:center;color:var(--text-muted);">
        未找到匹配的 Skill 技能，可点击右上角“从 GitHub 安装 Skill”直接导入任意开源技能。
      </div>
    `;
    return;
  }

  list.innerHTML = filtered.map((s) => `
    <div class="card skill-card">
      <div class="skill-card-top">
        <div class="card-title-wrap">
          <span class="card-title">${esc(s.name)}</span>
          <span class="card-subtitle">GitHub: ${esc(s.repo)}</span>
        </div>
        <span class="skill-stars-badge"> ${s.stars || 100}</span>
      </div>
      <div class="card-body">
        <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.5;">${esc(s.description)}</div>
        <div class="card-props" style="margin-top:4px;">
          ${(s.tags || []).map((t) => `<span class="skill-tag-pill">${esc(t)}</span>`).join('')}
          <span class="skill-tag-pill" style="color:var(--text-muted);">by ${esc(s.author || 'Community')}</span>
        </div>
      </div>
      <div class="card-footer" style="display:flex;flex-wrap:wrap;gap:6px;justify-content:space-between;align-items:center;padding-top:10px;border-top:1px solid #f1f5f9;margin-top:6px;">
          <div style="display:flex;gap:6px;">
            <button type="button" class="btn secondary" onclick="window.testServerNode('${esc(s.id)}')" style="padding:4px 10px;font-size:12px;" title="测试 SSH 连通性">
              连通测试
            </button>
            <button type="button" class="btn secondary" onclick="window.fetchServerInfoNode('${esc(s.id)}')" style="padding:4px 10px;font-size:12px;" title="拉取实时系统监控">
              刷新状态
            </button>
            <button type="button" class="btn ${s.status === 'online' ? 'secondary' : 'primary'}" onclick="window.openInstallServerModal('${esc(s.id)}')" style="padding:4px 10px;font-size:12px;" title="一键远程部署守护服务">
              ${s.status === 'online' ? '重新部署' : '一键安装'}
            </button>
          </div>
          <div style="display:flex;gap:6px;">
            <button type="button" class="btn secondary" onclick="window.selectTerminalServer('${esc(s.id)}')" style="padding:4px 8px;font-size:12px;" title="在下方终端中选中此机器">
              终端
            </button>
            <button type="button" class="btn secondary" onclick="window.openServerDialog('${esc(s.id)}')" style="padding:4px 8px;font-size:12px;" title="编辑配置">
              编辑
            </button>
            <button type="button" class="btn secondary" onclick="window.deleteServerNode('${esc(s.id)}')" style="padding:4px 8px;font-size:12px;color:#ef4444;border-color:#fecaca;background:#fef2f2;" title="移除此服务器">
              删除
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

window.openServerDialog = (id) => {
  const dialog = $('serverDialog');
  const form = $('serverForm');
  if (!dialog || !form) return;

  const isEdit = !!id;
  const server = isEdit ? cachedServers.find(s => s.id === id) : null;

  $('serverDialogTitle').textContent = isEdit ? '编辑远程服务器配置' : '添加远程服务器';
  $('serverInputId').value = server ? server.id : '';
  $('serverInputId').disabled = isEdit;
  $('serverInputName').value = server ? server.name : '';
  $('serverInputHost').value = server ? server.host : '';
  $('serverInputPort').value = server ? server.port : 22;
  $('serverInputUsername').value = server ? server.username : 'root';
  $('serverInputAuthType').value = server ? server.authType : 'password';
  $('serverInputPassword').value = server && server.password ? server.password : '';
  $('serverInputPrivateKey').value = server && server.privateKey ? server.privateKey : '';
  $('serverInputDaemonPort').value = server ? server.daemonPort : 9527;
  $('serverInputToken').value = server && server.token ? server.token : '';

  const isKey = (server ? server.authType : 'password') === 'privateKey';
  $('serverPasswordGroup').style.display = isKey ? 'none' : 'block';
  $('serverPrivateKeyGroup').style.display = isKey ? 'block' : 'none';

  $('deleteServerModalBtn').style.display = isEdit ? 'inline-block' : 'none';
  $('deleteServerModalBtn').onclick = () => {
    if (id) window.deleteServerNode(id);
    dialog.close();
  };

  dialog.showModal();
};

$('serverInputAuthType')?.addEventListener('change', (e) => {
  const isKey = e.target.value === 'privateKey';
  $('serverPasswordGroup').style.display = isKey ? 'none' : 'block';
  $('serverPrivateKeyGroup').style.display = isKey ? 'block' : 'none';
});

$('closeServerDialogBtn')?.addEventListener('click', () => $('serverDialog').close());
$('cancelServerModalBtn')?.addEventListener('click', () => $('serverDialog').close());

$('serverForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const formData = new FormData(form);

  const payload = {
    id: formData.get('id').trim(),
    name: formData.get('name')?.trim() || formData.get('host').trim(),
    host: formData.get('host').trim(),
    port: parseInt(formData.get('port'), 10) || 22,
    username: formData.get('username').trim() || 'root',
    authType: formData.get('authType'),
    password: formData.get('password') || undefined,
    privateKey: formData.get('privateKey') || undefined,
    daemonPort: parseInt(formData.get('daemonPort'), 10) || 9527,
    token: formData.get('token')?.trim() || undefined,
  };

  try {
    await window.hap.upsertServer(payload);
    $('serverDialog').close();
    showToast(`服务器 [${payload.name}] 配置保存成功！`, 'success');
    await renderServers();
  } catch (err) {
    showToast(`保存失败：${err.message}`, 'error');
  }
});

window.testServerNode = async (id) => {
  showToast('正在探测服务器连通性...', 'info');
  try {
    const res = await window.hap.testServer(id);
    if (res.ok) {
      showToast(` 连接成功 [${res.mode.toUpperCase()}] 延迟: ${res.latencyMs}ms - ${res.message}`, 'success');
    } else {
      showToast(` 连接失败：${res.message}`, 'error');
    }
    await renderServers();
  } catch (err) {
    showToast(`测试异常：${err.message}`, 'error');
  }
};

window.fetchServerInfoNode = async (id) => {
  showToast('正在获取实时系统资源数据...', 'info');
  try {
    const info = await window.hap.getServerInfo(id);
    showToast(` 已同步系统状态: CPU ${info.cpuUsagePercent}%, 内存 ${info.usedMemPercent}%`, 'success');
    await renderServers();
  } catch (err) {
    showToast(`获取失败：${err.message}`, 'error');
  }
};

window.deleteServerNode = async (id) => {
  if (!confirm(`确定要移除服务器节点 [${id}] 吗？`)) return;
  try {
    await window.hap.removeServer(id);
    showToast(`已移除服务器节点 [${id}]`, 'info');
    await renderServers();
  } catch (err) {
    showToast(`移除失败：${err.message}`, 'error');
  }
};

window.selectTerminalServer = (id) => {
  activeTerminalServerId = id;
  if ($('terminalServerSelect')) $('terminalServerSelect').value = id;
  const s = cachedServers.find(item => item.id === id);
  if ($('terminalConsoleTitle')) $('terminalConsoleTitle').textContent = s ? `Console (${s.name} - ${s.host})` : 'Console (Ready)';
  showToast(`已切换当前终端控制目标为：${s ? s.name : id}`, 'info');
};

$('terminalServerSelect')?.addEventListener('change', (e) => {
  if (e.target.value) {
    window.selectTerminalServer(e.target.value);
  }
});

// 一键安装流程面板
window.openInstallServerModal = async (id) => {
  const server = cachedServers.find(s => s.id === id);
  if (!server) return;

  const dialog = $('installServerDialog');
  $('installServerTitle').textContent = `正在一键部署 HAP 守护进程`;
  $('installServerSubtitle').textContent = `目标主机：${server.name} (${server.host}:${server.port}) - 守护端口: ${server.daemonPort || 9527}`;
  $('installLogsConsole').textContent = `[System] 启动部署向导，准备连接 ${server.host}:${server.port} ...\n`;
  $('installProgressBar').style.width = '10%';
  $('installPercentText').textContent = '10%';
  $('installStepText').textContent = '正在初始化 SSH 连接与认证...';
  $('finishInstallBtn').disabled = true;

  const steps = [
    '连接远程 SSH 服务',
    '探测服务器系统架构与环境',
    '检测 Node.js 运行时环境',
    '按需配置/安装 Node.js 运行环境',
    '下发 HAP 守护进程脚本与配置',
    '注册系统服务 (systemd / 进程守护)',
    '校验守护进程健康状态与双向通信',
  ];

  function renderStepsUI(currentStepIdx = 0, failed = false) {
    $('installStepsList').innerHTML = steps.map((name, idx) => {
      let iconClass = 'pending';
      let iconText = (idx + 1).toString();
      if (idx < currentStepIdx) {
        iconClass = 'success';
        iconText = '';
      } else if (idx === currentStepIdx) {
        iconClass = failed ? 'failed' : 'running';
        iconText = failed ? '' : '⏳';
      }
      return `
        <div class="step-item">
          <div class="step-icon ${iconClass}">${iconText}</div>
          <span style="font-weight:${idx === currentStepIdx ? '600' : '400'};color:${idx === currentStepIdx ? 'var(--text-main)' : 'var(--text-secondary)'};">
            ${esc(name)}
          </span>
        </div>
      `;
    }).join('');
  }

  renderStepsUI(0);
  dialog.showModal();

  function appendLog(line) {
    const consoleEl = $('installLogsConsole');
    consoleEl.textContent += line + '\n';
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  // 绑定实时进度监听
  window.hap.removeInstallProgressListeners?.();
  window.hap.onInstallProgress?.((event) => {
    const pct = Math.min(100, Math.round((event.stepIndex / event.totalSteps) * 100));
    $('installProgressBar').style.width = `${pct}%`;
    $('installPercentText').textContent = `${pct}%`;
    $('installStepText').textContent = `步骤 ${event.stepIndex}/${event.totalSteps}: ${event.message}`;
    
    renderStepsUI(event.stepIndex - 1, event.status === 'failed');

    const icon = event.status === 'success' ? '' : event.status === 'failed' ? '' : '⏳';
    appendLog(`[${event.stepIndex}/${event.totalSteps}] ${icon} ${event.message}`);
    if (event.details) {
      appendLog(`    ↳ ${event.details}`);
    }
  });

  try {
    appendLog(`[SSH] 正在通过 ${server.authType} 方式连接目标主机 ${server.host}:${server.port}...`);
    const res = await window.hap.installServer(id);
    if (res.ok) {
      $('installProgressBar').style.width = '100%';
      $('installPercentText').textContent = '100%';
      $('installStepText').textContent = '部署完成！HAP Agent 守护服务已在线。';
      renderStepsUI(steps.length);
      appendLog(`\n[Success] 部署成功！通信端口: ${res.daemonPort}, Token: ${res.token}`);
      showToast('远端 Agent 守护进程部署成功！', 'success');
      $('finishInstallBtn').disabled = false;
      await renderServers();
    } else {
      $('installProgressBar').style.width = '100%';
      $('installProgressBar').style.background = '#ef4444';
      $('installPercentText').textContent = '失败';
      $('installStepText').textContent = `部署终止：${res.error || '未知异常'}`;
      appendLog(`\n[Error] 部署失败：${res.error}`);
      showToast(`部署失败：${res.error}`, 'error');
      $('finishInstallBtn').disabled = false;
      await renderServers();
    }
  } catch (err) {
    appendLog(`\n[Exception] ${err.message}`);
    showToast(`部署异常：${err.message}`, 'error');
    $('finishInstallBtn').disabled = false;
    await renderServers();
  } finally {
    window.hap.removeInstallProgressListeners?.();
  }
};

$('closeInstallDialogBtn')?.addEventListener('click', () => $('installServerDialog').close());
$('finishInstallBtn')?.addEventListener('click', () => $('installServerDialog').close());

// 远程终端 Shell 执行
$('remoteExecForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('remoteCommandInput');
  const command = input.value.trim();
  if (!command) return;

  const targetId = $('terminalServerSelect')?.value || activeTerminalServerId;
  if (!targetId) {
    showToast('请先选择要执行命令的目标服务器', 'info');
    return;
  }

  const server = cachedServers.find(s => s.id === targetId);
  const outEl = $('remoteTerminalOutput');
  const durationEl = $('terminalDuration');
  const execBtn = $('execRemoteCmdBtn');

  execBtn.disabled = true;
  outEl.textContent = `[${server ? server.name : targetId}]$ ${command}\n正在执行...\n`;
  durationEl.textContent = '执行中...';

  try {
    const startTime = Date.now();
    const res = await window.hap.execServerCommand({ id: targetId, command });
    const duration = Date.now() - startTime;
    durationEl.textContent = `${duration}ms`;

    let fullOutput = '';
    if (res.stdout) fullOutput += res.stdout;
    if (res.stderr) fullOutput += (fullOutput ? '\n' : '') + '[stderr] ' + res.stderr;
    if (!fullOutput) fullOutput = `(命令已执行完毕，退出码: ${res.code})`;

    outEl.textContent = `[${server ? server.name : targetId}]$ ${command}\n\n${fullOutput}\n\n[Process exited with code ${res.code} in ${duration}ms]`;
    outEl.scrollTop = outEl.scrollHeight;
  } catch (err) {
    outEl.textContent += `\n[Error] 执行失败：${err.message}`;
    showToast(`执行失败：${err.message}`, 'error');
  } finally {
    execBtn.disabled = false;
  }
});

// 快捷指令按钮点击
document.querySelectorAll('.quick-cmd-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const cmd = btn.dataset.cmd;
    if (cmd && $('remoteCommandInput')) {
      $('remoteCommandInput').value = cmd;
      $('remoteExecForm')?.requestSubmit();
    }
  });
});

$('clearTerminalOutputBtn')?.addEventListener('click', () => {
  if ($('remoteTerminalOutput')) $('remoteTerminalOutput').textContent = '# 终端已清屏\n';
  if ($('terminalDuration')) $('terminalDuration').textContent = '0ms';
});

$('addServerBtn')?.addEventListener('click', () => window.openServerDialog());
$('refreshServersBtn')?.addEventListener('click', async () => {
  showToast('正在刷新服务器状态...', 'info');
  await renderServers();
  showToast('服务器状态已更新', 'success');
});

// 初始化加载
refresh().catch((error) => showToast('初始化加载失败：' + error.message, 'error'));


// ============================================================================
// 1. 多通道通信中心切换 (微信 / 飞书 / QQ)
// ============================================================================
window.switchChannelTab = (tab) => {
  ['WeChat', 'Feishu', 'QQ'].forEach(t => {
    const pane = document.getElementById('channelPane' + t);
    const btn = document.getElementById('tabBtn' + t);
    if (pane) pane.style.display = t.toLowerCase() === tab.toLowerCase() ? 'block' : 'none';
    if (btn) {
      if (t.toLowerCase() === tab.toLowerCase()) {
        btn.style.background = '#0284c7';
        btn.style.color = '#ffffff';
      } else {
        btn.style.background = '#ffffff';
        btn.style.color = '#374151';
      }
    }
  });
  if (tab === 'feishu') renderFeishuView();
  else if (tab === 'qq') renderQQView();
  else renderWeChatView();
};

// ============================================================================
// 2. 飞书机器人通道逻辑 (Feishu Channel)
// ============================================================================
async function renderFeishuView() {
  try {
    const cfg = await window.hap.getFeishuConfig();
    if ($('feishuAppIdInput')) $('feishuAppIdInput').value = cfg.appId || '';
    if ($('feishuAppSecretInput')) $('feishuAppSecretInput').value = cfg.appSecret || '';
    if ($('feishuEncryptKeyInput')) $('feishuEncryptKeyInput').value = cfg.encryptKey || '';
    if ($('feishuVerificationTokenInput')) $('feishuVerificationTokenInput').value = cfg.verificationToken || '';
    const btn = $('toggleFeishuServiceBtn');
    if (btn) {
      btn.textContent = cfg.running ? '停止飞书服务' : '启动飞书服务';
      btn.className = cfg.running ? 'btn danger' : 'btn primary';
    }
  } catch (err) {
    console.error('获取飞书配置异常:', err);
  }
}

$('feishuConfigForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await window.hap.saveFeishuConfig({
      appId: $('feishuAppIdInput')?.value.trim() || '',
      appSecret: $('feishuAppSecretInput')?.value.trim() || '',
      encryptKey: $('feishuEncryptKeyInput')?.value.trim() || '',
      verificationToken: $('feishuVerificationTokenInput')?.value.trim() || '',
    });
    showToast('飞书配置已成功保存！', 'success');
  } catch (err) {
    showToast('保存飞书配置失败: ' + err.message, 'error');
  }
});

$('toggleFeishuServiceBtn')?.addEventListener('click', async () => {
  const btn = $('toggleFeishuServiceBtn');
  const isRunning = btn && btn.textContent.includes('停止');
  try {
    if (isRunning) {
      await window.hap.stopFeishuService();
      showToast('飞书服务已停止', 'info');
    } else {
      await window.hap.startFeishuService();
      showToast('飞书服务已成功启动！', 'success');
    }
    await renderFeishuView();
  } catch (err) {
    showToast('切换飞书服务状态失败: ' + err.message, 'error');
  }
});

// ============================================================================
// 3. QQ / OneBot 机器人通道逻辑 (QQ Channel)
// ============================================================================
async function renderQQView() {
  try {
    const cfg = await window.hap.getQQConfig();
    if ($('qqEndpointInput')) $('qqEndpointInput').value = cfg.endpoint || 'http://127.0.0.1:3000';
    if ($('qqTokenInput')) $('qqTokenInput').value = cfg.token || '';
    const btn = $('toggleQQServiceBtn');
    if (btn) {
      btn.textContent = cfg.running ? '停止 QQ 服务' : '启动 QQ 服务';
      btn.className = cfg.running ? 'btn danger' : 'btn primary';
    }
  } catch (err) {
    console.error('获取 QQ 配置异常:', err);
  }
}

$('qqConfigForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await window.hap.saveQQConfig({
      endpoint: $('qqEndpointInput')?.value.trim() || 'http://127.0.0.1:3000',
      token: $('qqTokenInput')?.value.trim() || '',
    });
    showToast('QQ / OneBot 配置已成功保存！', 'success');
  } catch (err) {
    showToast('保存 QQ 配置失败: ' + err.message, 'error');
  }
});

$('toggleQQServiceBtn')?.addEventListener('click', async () => {
  const btn = $('toggleQQServiceBtn');
  const isRunning = btn && btn.textContent.includes('停止');
  try {
    if (isRunning) {
      await window.hap.stopQQService();
      showToast('QQ 服务已停止', 'info');
    } else {
      await window.hap.startQQService();
      showToast('QQ 服务已成功启动！', 'success');
    }
    await renderQQView();
  } catch (err) {
    showToast('切换 QQ 服务状态失败: ' + err.message, 'error');
  }
});

// ============================================================================
// 4. 本机系统监控与智能桌面 (Host Desktop & Status)
// ============================================================================
function fmtHostBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

window.refreshHostView = async () => {
  try {
    const info = await window.hap.getServerInfo();
    if ($('hostOsText')) $('hostOsText').textContent = `${info.os.platform} (${info.os.release})`;
    if ($('hostArchText')) $('hostArchText').textContent = `架构: ${info.os.arch} / 主机: ${info.os.hostname}`;
    if ($('hostCpuText')) $('hostCpuText').textContent = info.cpu.model || 'CPU 核心';
    if ($('hostCpuCoresText')) $('hostCpuCoresText').textContent = `核心数: ${info.cpu.cores} 核 (${info.cpuUsagePercent || 0}% 占用)`;
    if ($('hostMemText')) $('hostMemText').textContent = `${fmtHostBytes(info.memory.used)} / ${fmtHostBytes(info.memory.total)}`;
    if ($('hostMemFreeText')) $('hostMemFreeText').textContent = `空闲: ${fmtHostBytes(info.memory.free)} (${info.memory.usagePercent}% 已用)`;
    
    // 渲染磁盘存储指标
    if (info.disk && info.disk.totalBytes > 0) {
      if ($('hostDiskText')) $('hostDiskText').textContent = `${fmtHostBytes(info.disk.used)} / ${fmtHostBytes(info.disk.totalBytes)}`;
      if ($('hostDiskFreeText')) $('hostDiskFreeText').textContent = `可用: ${fmtHostBytes(info.disk.freeBytes)} (${info.disk.usedPercent}% 已用 · 挂载: ${info.disk.mount || '/'})`;
    } else if (info.diskTotalBytes) {
      const free = info.diskFreeBytes || 0;
      const total = info.diskTotalBytes;
      const used = total - free;
      const pct = Math.round((used / total) * 100);
      if ($('hostDiskText')) $('hostDiskText').textContent = `${fmtHostBytes(used)} / ${fmtHostBytes(total)}`;
      if ($('hostDiskFreeText')) $('hostDiskFreeText').textContent = `可用: ${fmtHostBytes(free)} (${pct}% 已用)`;
    } else {
      if ($('hostDiskText')) $('hostDiskText').textContent = '系统驱动器正常';
      if ($('hostDiskFreeText')) $('hostDiskFreeText').textContent = '点击下方按钮可深度扫描';
    }

    if ($('hostProcessUptime')) $('hostProcessUptime').textContent = `运行时间: ${Math.floor(info.uptime / 60)} 分钟`;

    try {
      const geo = await window.hap.getIpGeoInfo();
      if ($('hostIpText')) $('hostIpText').textContent = geo.ip || '127.0.0.1';
      if ($('hostIpGeoBadge')) {
        if (geo.formattedLocation) {
          $('hostIpGeoBadge').textContent = geo.formattedLocation;
        } else {
          const loc = [geo.country, geo.region, geo.city].filter(Boolean).join(' · ') || '公网出口';
          const isp = geo.isp ? ` (${geo.isp})` : '';
          $('hostIpGeoBadge').textContent = `${loc}${isp}`;
        }
      }
    } catch (e) {
      console.warn('获取公网 IP 定位失败:', e);
      if ($('hostIpGeoBadge')) $('hostIpGeoBadge').textContent = '局域网环境 / 本地网络';
    }
  } catch (err) {
    console.error('刷新宿主机监控失败:', err);
  }
};

window.handleScanDisk = async () => {
  const resultEl = $('diskScanResult');
  const cleanBtn = $('cleanDiskBtn');
  if (resultEl) resultEl.innerHTML = '⏳ 正在扫描系统临时构建残余与缓存...';
  try {
    const res = await window.hap.scanDiskCleanable();
    if (resultEl) {
      resultEl.innerHTML = `
        <div style="color:#16a34a;font-weight:600;margin-bottom:4px;"> 扫描完成！共发现可清理项：<strong>${fmtHostBytes(res.totalCleanableBytes)}</strong></div>
        <div style="font-size:11.5px;color:#64748b;">包含 npm/yarn/pnpm 缓存、临时编译产物与运行日志。</div>
      `;
    }
    if (cleanBtn && res.totalCleanableBytes > 0) cleanBtn.style.display = 'inline-block';
  } catch (err) {
    if (resultEl) resultEl.textContent = '扫描异常: ' + err.message;
  }
};

window.handleCleanDisk = async () => {
  const resultEl = $('diskScanResult');
  const cleanBtn = $('cleanDiskBtn');
  if (resultEl) resultEl.innerHTML = '⏳ 正在执行安全磁盘清理...';
  try {
    const res = await window.hap.executeDiskCleanup();
    if (resultEl) {
      resultEl.innerHTML = `<div style="color:#16a34a;font-weight:600;"> 清理成功！已释放 <strong>${fmtHostBytes(res.cleanedBytes)}</strong> 磁盘空间。</div>`;
    }
    if (cleanBtn) cleanBtn.style.display = 'none';
    showToast('磁盘清理完成！', 'success');
  } catch (err) {
    if (resultEl) resultEl.textContent = '清理异常: ' + err.message;
  }
};

// ============================================================================
// 5. 导航切换监听补充 (Host / Schedules / Memory)
// ============================================================================
document.addEventListener('click', (e) => {
  const navItem = e.target.closest('.nav');
  if (!navItem) return;
  const view = navItem.getAttribute('data-view');
  if (view === 'host') window.refreshHostView();
  else if (view === 'wechat') window.switchChannelTab('wechat');
});

// ============================================================================
// 6. 远程服务器智能体运维交互台 (Server Ops Agent Console)
// ============================================================================
let currentServerOpsAttachments = [];

function renderServerOpsAttachments() {
  const tray = document.getElementById('serverOpsAttachmentsTray');
  if (!tray) return;
  if (currentServerOpsAttachments.length === 0) {
    tray.style.display = 'none';
    tray.innerHTML = '';
    return;
  }
  tray.style.display = 'flex';
  tray.innerHTML = currentServerOpsAttachments.map((item, index) => {
    const isImg = item.kind === 'image' || (item.mimeType && item.mimeType.startsWith('image/'));
    const previewHtml = isImg
      ? `<img src="${esc(item.dataUrl || item.path)}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;border:1px solid #cbd5e1;flex-shrink:0;" />`
      : `<div style="width:32px;height:32px;border-radius:6px;background:#eff6ff;color:#2563eb;display:grid;place-items:center;flex-shrink:0;"></div>`;
    return `<div style="position:relative;display:inline-flex;align-items:center;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:4px 8px;gap:8px;max-width:220px;flex-shrink:0;">
      ${previewHtml}
      <div style="display:flex;flex-direction:column;overflow:hidden;font-size:11.5px;line-height:1.3;">
        <span style="font-weight:600;color:#1e293b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(item.fileName)}</span>
      </div>
      <button type="button" onclick="window.removeServerOpsAttachment(${index})" style="width:18px;height:18px;border-radius:50%;background:rgba(15,23,42,0.6);color:#fff;border:none;font-size:10px;cursor:pointer;margin-left:auto;"></button>
    </div>`;
  }).join('');
}

window.removeServerOpsAttachment = (index) => {
  currentServerOpsAttachments.splice(index, 1);
  renderServerOpsAttachments();
};

async function handleServerOpsAddFiles(files) {
  if (!files || files.length === 0) return;
  let addedCount = 0;
  for (const file of files) {
    try {
      const isImg = file.type.startsWith('image/');
      const dataUrl = await readFileAsDataUrl(file);
      currentServerOpsAttachments.push({
        kind: isImg ? 'image' : 'document',
        fileName: file.name || (isImg ? 'image.png' : 'document.txt'),
        mimeType: file.type || (isImg ? 'image/png' : 'application/octet-stream'),
        bytes: file.size,
        dataUrl: typeof dataUrl === 'string' ? dataUrl : undefined,
      });
      addedCount++;
    } catch (e) {
      console.error(e);
    }
  }
  if (addedCount > 0) {
    renderServerOpsAttachments();
    showToast('已附加 ' + addedCount + ' 个文件', 'info');
  }
}

document.getElementById('serverOpsAttachBtn')?.addEventListener('click', () => {
  document.getElementById('serverOpsFileInput')?.click();
});

document.getElementById('serverOpsFileInput')?.addEventListener('change', async (e) => {
  if (e.target.files && e.target.files.length > 0) {
    await handleServerOpsAddFiles(Array.from(e.target.files));
    e.target.value = '';
  }
});

// 跳转至全屏主对话工作台
window.jumpToServerMainChat = () => {
  const targetId = $('serverOpsTargetSelect')?.value || activeTerminalServerId;
  if (!targetId) {
    showToast('请先选择要跳转的目标服务器', 'info');
    return;
  }
  window.startServerAgentChat(targetId);
};

// 为指定服务器开启专属运维会话
window.startServerAgentChat = (serverId) => {
  const server = cachedServers.find(s => s.id === serverId);
  if (!server) return;

  const agentId = server.agentId || 'ops';
  if ($('chatAgentSelect')) {
    $('chatAgentSelect').value = agentId;
  }
  const sessionTitle = `${server.name} 运维`;
  const sess = state.sessions.find(s => s.title === sessionTitle);
  if (sess) {
    state.activeSessionId = sess.id;
  } else {
    const newSess = {
      id: 'sess_server_' + server.id + '_' + Date.now(),
      title: sessionTitle,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          role: 'assistant',
          content: `您好！我是服务器 **${server.name}** (${server.host}:${server.port}) 的专属智能体 **[${agentId}]**。已为您打通双向通道，您可以随时发送指令让我执行运维巡检、诊断日志、排查 Docker 或自动修复故障。`,
          timestamp: new Date().toISOString(),
        }
      ],
    };
    state.sessions.unshift(newSess);
    state.activeSessionId = newSess.id;
  }
  saveSessionsToStorage();
  
  // 切换到对话工作台
  const navChatBtn = $('navChatBtn');
  if (navChatBtn) navChatBtn.click();
  else {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    $('chat')?.classList.add('active');
  }
  renderCurrentSessionMessages();
  showToast(`已就绪：专属智能体 [${agentId}] 正在接管服务器 [${server.name}] 运维任务`, 'info');
};

// 触发快捷运维动作
window.triggerServerOpsQuickAction = async (actionKey) => {
  const targetId = $('serverOpsTargetSelect')?.value || activeTerminalServerId;
  if (!targetId) {
    showToast('请先选择要执行智能运维的目标服务器', 'info');
    return;
  }
  const server = cachedServers.find(s => s.id === targetId);
  if (!server) return;

  const agentId = $('serverOpsAgentSelect')?.value || server.agentId || 'ops';
  let prompt = '';

  switch (actionKey) {
    case 'inspect':
      prompt = `对远程服务器 [${server.id}] (${server.name} - ${server.host}) 进行全盘硬件与负载巡检（CPU、内存、系统负载、磁盘使用率与 Node 环境），并给出综合健康评估与优化建议。`;
      break;
    case 'upgrade_daemon':
      prompt = `请帮我升级与重新部署远程服务器 [${server.id}] (${server.name} - ${server.host}) 上的 HAP 守护进程，下发最新脚本并校验健康检查端口与 Token 连通性。`;
      break;
    case 'check_services':
      prompt = `检查远程服务器 [${server.id}] (${server.name} - ${server.host}) 的 systemd 守护服务（hap-daemon、nginx、docker 等）与端口监听情况，排查是否有任何异常停止的服务。`;
      break;
    case 'clean_disk':
      prompt = `分析远程服务器 [${server.id}] (${server.name} - ${server.host}) 上的临时垃圾文件、过期的 systemd journal 日志与悬空 Docker 镜像，并协助安全释放磁盘空间。`;
      break;
    case 'diagnose_logs':
      prompt = `拉取远程服务器 [${server.id}] (${server.name} - ${server.host}) 最近 50 行 HAP 守护进程 (hap-daemon) 运行日志，诊断是否存在任何潜在的 Warning 或 Error。`;
      break;
    default:
      prompt = `对远程服务器 [${server.id}] 执行常规状态巡检。`;
      break;
  }

  await window.executeServerOpsPrompt(server, prompt, agentId);
};

// 执行智能体运维 Prompt
window.executeServerOpsPrompt = async (server, prompt, agentId, attachments = []) => {
  const container = $('serverOpsStreamContainer');
  const contentEl = $('serverOpsStreamContent');
  const sendBtn = $('sendServerOpsBtn');
  if (!container || !contentEl) return;

  container.style.display = 'block';
  if (sendBtn) sendBtn.disabled = true;

  contentEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;color:#6366f1;font-weight:600;margin-bottom:8px;">
      <span class="thinking-pulse-dot"></span>
      <span>正在调度智能体 [${esc(agentId)}] 远程巡检与执行：${esc(server.name)} (${esc(server.host)})...</span>
    </div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;border-left:2px solid var(--border-default);padding-left:8px;">${esc(prompt)}</div>
  `;
  container.scrollTop = container.scrollHeight;

  try {
    const selectedModel = $('chatModelPickerSelect')?.value || undefined;
    const res = await window.hap.chat({
      input: prompt,
      agentId: agentId || 'ops',
      attachments: attachments.length > 0 ? attachments : undefined,
      model: selectedModel,
      projectPath: undefined,
    });

    let reply = '';
    let reasoning = '';
    if (res.outcome) {
      reply = res.outcome.text || '';
      reasoning = res.outcome.reasoning || '';
    }

    if (!reply && Array.isArray(res.events)) {
      const texts = res.events.filter(e => e.type === 'text' && e.text).map(e => e.text);
      if (texts.length > 0) reply = texts.join('');
    }

    if (!reply) {
      reply = '智能体已执行完毕相关运维指令，服务已正常同步。';
    }

    contentEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <span style="font-weight:700;color:#16a34a;"> 智能体 [${esc(agentId)}] 执行完成</span>
        <span style="font-size:11px;color:var(--text-muted);">目标：${esc(server.name)}</span>
      </div>
      ${reasoning ? `
        <details class="thinking-box" style="margin-bottom:8px;" open>
          <summary class="thinking-header" style="font-size:11.5px;"><span>思考与推理链</span></summary>
          <div class="thinking-content">${renderMarkdownContent(reasoning)}</div>
        </details>
      ` : ''}
      <div class="ops-agent-output">${renderMarkdownContent(reply)}</div>
    `;
    await renderServers();
  } catch (err) {
    contentEl.innerHTML += `<div style="color:#ef4444;margin-top:8px;">[执行失败] ${esc(err.message)}</div>`;
  } finally {
    if (sendBtn) sendBtn.disabled = false;
  }
};

// 提交智能体运维输入条
$('serverOpsChatForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const inputEl = $('serverOpsChatInput');
  const text = inputEl ? inputEl.value.trim() : '';
  const attachmentsToSend = [...currentServerOpsAttachments];
  if (!text && attachmentsToSend.length === 0) return;

  const targetId = $('serverOpsTargetSelect')?.value || activeTerminalServerId;
  if (!targetId) {
    showToast('请先选择要执行智能运维的目标服务器', 'info');
    return;
  }
  const server = cachedServers.find(s => s.id === targetId);
  if (!server) return;

  const agentId = $('serverOpsAgentSelect')?.value || server.agentId || 'ops';
  if (inputEl) inputEl.value = '';
  currentServerOpsAttachments = [];
  renderServerOpsAttachments();
  await window.executeServerOpsPrompt(server, text, agentId, attachmentsToSend);
});


// ============================================================================
// 7. 综合设置中心 Tab 切换与数据分发 (Settings Hub Controller)
// ============================================================================
window.switchSettingsTab = (tabId) => {
  document.querySelectorAll('.settings-tab-btn').forEach(btn => {
    if (btn.dataset.tab === tabId) {
      btn.style.background = 'linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%)';
      btn.style.color = '#0369a1';
      btn.style.borderColor = '#7dd3fc';
      btn.style.fontWeight = '600';
    } else {
      btn.style.background = '#ffffff';
      btn.style.color = '#334155';
      btn.style.borderColor = '#cbd5e1';
      btn.style.fontWeight = '500';
    }
  });

  ['providers', 'channels', 'projects', 'permissions', 'system'].forEach(t => {
    const pane = $('settingsPane_' + t);
    if (pane) pane.style.display = t === tabId ? 'block' : 'none';
  });

  if (tabId === 'providers') {
    renderProviders();
    renderModels();
  } else if (tabId === 'channels') {
    renderWeChatView();
    renderTelegramView();
  } else if (tabId === 'projects') {
    renderProjects();
  } else if (tabId === 'permissions') {
    renderPermissions();
  } else if (tabId === 'system') {
    renderTargets();
    renderLogs();
  }
};

// 监听进入设置中心
document.addEventListener('click', (e) => {
  const navItem = e.target.closest('.nav');
  if (!navItem) return;
  const view = navItem.getAttribute('data-view');
  if (view === 'settings') {
    window.switchSettingsTab('providers');
  }
});
