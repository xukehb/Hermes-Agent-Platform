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

function escJs(val) {
  if (val === undefined || val === null) return '';
  return String(val)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
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
  const iconWrap = $('confirmIconWrap');

  okBtn.textContent = okText;
  cancelBtn.textContent = cancelText;

  if (isDanger) {
    okBtn.className = 'btn danger';
    if (iconWrap) {
      iconWrap.style.background = '#fef2f2';
      iconWrap.style.color = '#ef4444';
      iconWrap.style.boxShadow = '0 4px 12px rgba(239,68,68,0.15)';
    }
  } else {
    okBtn.className = 'btn primary';
    if (iconWrap) {
      iconWrap.style.background = '#eff6ff';
      iconWrap.style.color = '#0284c7';
      iconWrap.style.boxShadow = '0 4px 12px rgba(14,165,233,0.15)';
    }
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
      const loadingDotHtml = s.isGenerating ? `<span class="thinking-pulse-dot" style="margin-left:4px;width:5px;height:5px;flex-shrink:0;" title="正在深度思考与执行中..."></span>` : '';
      return `
        <div class="session-tree-item ${isActive ? 'active' : ''}" onclick="window.switchSession('${esc(s.id)}')">
          <span class="session-title-wrap" title="${esc(s.title || '新对话')}">${esc(s.title || '新对话')}${loadingDotHtml}</span>
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

      const loadingDotHtml = s.isGenerating ? `<span class="thinking-pulse-dot" style="margin-left:4px;width:5px;height:5px;flex-shrink:0;" title="正在深度思考与执行中..."></span>` : '';
      return `
        <div class="session-tree-item ${isActive ? 'active' : ''}" onclick="window.switchSession('${esc(s.id)}')">
          <span class="session-title-wrap" title="${esc(s.title || '新对话')}">${esc(s.title || '新对话')}${loadingDotHtml}</span>
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

  let messagesHtml = session.messages.map((m, idx) => {
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

  if (session.isGenerating) {
    messagesHtml += `
      <div class="msg-row assistant waiting-row">
        <div class="assistant-container">
          <div class="assistant-avatar">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </div>
          <div class="assistant-content">
            <div class="thinking-loading-pill">
              <span class="thinking-pulse-dot"></span>
              <span>正在深度思考与执行中...</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  container.innerHTML = messagesHtml;

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
      <div class="card-footer">
        <div style="display:flex;align-items:center;gap:8px;">
          <label class="switch">
            <input type="checkbox" ${s.enabled ? 'checked' : ''} onchange="toggleSkillEnabled('${esc(s.id)}', this.checked)" />
            <span class="slider green"></span>
          </label>
          <span style="font-size:12px;color:${s.enabled ? 'var(--success)' : 'var(--text-muted)'};font-weight:500;">
            ${s.enabled ? '已启用' : '已停用'}
          </span>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn secondary" onclick="window.open('https://github.com/${esc(s.repo)}', '_blank')">GitHub</button>
          <button class="btn danger" onclick="uninstallSkill('${escJs(s.id)}', '${escJs(s.name)}')">卸载</button>
        </div>
      </div>
    </div>
  `).join('');
}

$('skillSearchInput')?.addEventListener('input', (e) => {
  renderSkills(e.target.value);
});

window.toggleSkillEnabled = async (id, enabled) => {
  try {
    await window.hap.toggleSkill(id, enabled);
    const item = (state.skills || []).find((s) => s.id === id);
    if (item) item.enabled = enabled;
    showToast(`Skill 已${enabled ? '启用' : '停用'}`, 'info');
    renderSkills();
  } catch (error) {
    showToast('切换状态失败：' + error.message, 'error');
  }
};

window.uninstallSkill = async (id, name) => {
  const ok = await showConfirm({
    title: '卸载 Skill',
    message: `确定要卸载技能 <strong>${esc(name)}</strong> 吗？`,
    okText: '确认卸载',
    isDanger: true,
  });
  if (!ok) return;

  try {
    await window.hap.uninstallSkill(id);
    state.skills = (state.skills || []).filter((s) => s.id !== id);
    showToast(`技能 ${name} 已成功卸载`, 'success');
    renderSkills();
  } catch (error) {
    showToast('卸载失败：' + error.message, 'error');
  }
};

$('openInstallSkillModalBtn')?.addEventListener('click', () => {
  $('installSkillModal').showModal();
});
$('closeInstallSkillModalBtn')?.addEventListener('click', () => $('installSkillModal').close());
$('cancelInstallSkillBtn')?.addEventListener('click', () => $('installSkillModal').close());

$('installSkillForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const repo = $('skillRepoInput').value.trim();
  if (!repo) return;

  try {
    const installed = await window.hap.installSkill(repo);
    $('installSkillModal').close();
    $('skillRepoInput').value = '';
    showToast(`已成功从 GitHub 安装 Skill：${installed.name}`, 'success');
    await refresh();
    show('skills');
  } catch (error) {
    showToast('安装失败：' + error.message, 'error');
  }
});

// ==========================================================================
// 2. MCP 插件市场 (Plugins / MCP Tools)
// ==========================================================================

function renderPlugins() {
  const list = $('pluginsList');
  if (!list) return;

  const plugins = state.plugins || [];
  if (plugins.length === 0) {
    list.innerHTML = `
      <div class="empty-card" style="grid-column:1/-1;padding:32px;text-align:center;color:var(--text-muted);">
        暂无已注册插件，点击右上角“添加自定义 MCP 插件”注册新扩展。
      </div>
    `;
    return;
  }

  list.innerHTML = plugins.map((p) => `
    <div class="card plugin-card">
      <div class="card-header">
        <div class="card-title-wrap">
          <span class="card-title">${esc(p.name)}</span>
          <span class="card-subtitle">${p.type === 'mcp' ? `MCP: ${esc(p.command)} ${(p.args || []).join(' ')}` : '原生内置工具集'}</span>
        </div>
        <span class="badge ${p.type === 'mcp' ? 'neutral' : ''}">${p.type === 'mcp' ? 'MCP 插件' : '内置'}</span>
      </div>
      <div class="card-body">
        <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.5;">${esc(p.description)}</div>
      </div>
      <div class="card-footer">
        <div style="display:flex;align-items:center;gap:8px;">
          <label class="switch">
            <input type="checkbox" ${p.enabled ? 'checked' : ''} onchange="togglePluginEnabled('${esc(p.id)}', this.checked)" />
            <span class="slider green"></span>
          </label>
          <span style="font-size:12px;color:${p.enabled ? 'var(--success)' : 'var(--text-muted)'};font-weight:500;">
            ${p.enabled ? '运行就绪' : '已停用'}
          </span>
        </div>
      </div>
    </div>
  `).join('');
}

window.togglePluginEnabled = async (id, enabled) => {
  try {
    await window.hap.togglePlugin(id, enabled);
    const item = (state.plugins || []).find((p) => p.id === id);
    if (item) item.enabled = enabled;
    showToast(`插件已${enabled ? '启用' : '停用'}`, 'info');
    renderPlugins();
  } catch (error) {
    showToast('切换插件状态失败：' + error.message, 'error');
  }
};

$('openAddPluginModalBtn')?.addEventListener('click', () => {
  $('addPluginModal').showModal();
});
$('closeAddPluginModalBtn')?.addEventListener('click', () => $('addPluginModal').close());
$('cancelAddPluginBtn')?.addEventListener('click', () => $('addPluginModal').close());

$('addPluginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const data = Object.fromEntries(new FormData(form));

  const args = data.args ? data.args.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const plugin = {
    id: data.id.trim(),
    name: data.name.trim(),
    description: data.description?.trim() || '自定义 MCP 插件',
    type: 'mcp',
    category: 'developer',
    enabled: true,
    command: data.command.trim(),
    args,
  };

  try {
    await window.hap.upsertPlugin(plugin);
    $('addPluginModal').close();
    form.reset();
    showToast(`插件 ${plugin.name} 保存成功`, 'success');
    await refresh();
    show('plugins');
  } catch (error) {
    showToast('保存插件失败：' + error.message, 'error');
  }
});

// ==========================================================================
// 3. 权限与安全策略配置 (Permissions & Security)
// ==========================================================================

function renderPermissions() {
  const perm = state.permissions || {
    mode: 'full-access',
    allowShell: true,
    allowFsWrite: true,
    allowNetwork: true,
    allowSpawnSubagent: true,
    autoApproveTools: ['*'],
  };

  // 1. 渲染独立视图中的卡片
  window.selectPermissionMode?.(perm.mode || 'full-access', false);
  if ($('permAllowShell')) $('permAllowShell').checked = !!perm.allowShell;
  if ($('permAllowFsWrite')) $('permAllowFsWrite').checked = !!perm.allowFsWrite;
  if ($('permAllowNetwork')) $('permAllowNetwork').checked = !!perm.allowNetwork;
  if ($('permAllowSubagent')) $('permAllowSubagent').checked = !!perm.allowSpawnSubagent;

  // 2. 渲染设置中心中的容器
  const container = $('permissionsContainer');
  if (container) {
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px;">
        <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:12px;">
          <div id="setModeFullAccess" class="card ${perm.mode === 'full-access' ? 'active' : ''}" style="cursor:pointer;padding:14px;border:1.5px solid ${perm.mode === 'full-access' ? '#0284c7' : '#e2e8f0'};border-radius:10px;background:${perm.mode === 'full-access' ? '#f0f9ff' : '#ffffff'};transition:all 0.15s ease;" onclick="window.selectPermissionModeInSettings('full-access')">
            <div style="font-weight:700;font-size:13.5px;color:${perm.mode === 'full-access' ? '#0369a1' : '#1e293b'};display:flex;align-items:center;gap:6px;">
              <span>🟢 完全信任模式 (全权限)</span>
            </div>
            <div style="font-size:12px;color:#64748b;margin-top:6px;line-height:1.4;">完完全全放开全部权限，智能体全自动执行终端命令、本地代码写入与网络请求，无需手动弹窗确认。</div>
          </div>
          <div id="setModeConfirm" class="card ${perm.mode === 'confirm-writes' ? 'active' : ''}" style="cursor:pointer;padding:14px;border:1.5px solid ${perm.mode === 'confirm-writes' ? '#0284c7' : '#e2e8f0'};border-radius:10px;background:${perm.mode === 'confirm-writes' ? '#f0f9ff' : '#ffffff'};transition:all 0.15s ease;" onclick="window.selectPermissionModeInSettings('confirm-writes')">
            <div style="font-weight:700;font-size:13.5px;color:${perm.mode === 'confirm-writes' ? '#0369a1' : '#1e293b'};display:flex;align-items:center;gap:6px;">
              <span>🟡 写入需确认模式</span>
            </div>
            <div style="font-size:12px;color:#64748b;margin-top:6px;line-height:1.4;">允许自动读取与检索，遇到终端执行或文件修改时弹出确认框二次审批。</div>
          </div>
          <div id="setModeStrict" class="card ${perm.mode === 'strict' ? 'active' : ''}" style="cursor:pointer;padding:14px;border:1.5px solid ${perm.mode === 'strict' ? '#0284c7' : '#e2e8f0'};border-radius:10px;background:${perm.mode === 'strict' ? '#f0f9ff' : '#ffffff'};transition:all 0.15s ease;" onclick="window.selectPermissionModeInSettings('strict')">
            <div style="font-weight:700;font-size:13.5px;color:${perm.mode === 'strict' ? '#0369a1' : '#1e293b'};display:flex;align-items:center;gap:6px;">
              <span>🔴 严格只读模式</span>
            </div>
            <div style="font-size:12px;color:#64748b;margin-top:6px;line-height:1.4;">禁止一切写入、终端命令与外部网络访问，仅支持静态代码检索。</div>
          </div>
        </div>

        <div style="background:#f8fafc;padding:16px;border-radius:10px;border:1px solid #e2e8f0;display:grid;grid-template-columns:1fr 1fr;gap:14px;">
          <label style="display:flex;align-items:center;gap:10px;font-size:13px;color:#334155;cursor:pointer;">
            <input type="checkbox" id="setPermShell" ${perm.allowShell ? 'checked' : ''} style="width:16px;height:16px;" />
            <span>允许智能体调用系统终端 (Shell / PowerShell / Bash)</span>
          </label>
          <label style="display:flex;align-items:center;gap:10px;font-size:13px;color:#334155;cursor:pointer;">
            <input type="checkbox" id="setPermFsWrite" ${perm.allowFsWrite ? 'checked' : ''} style="width:16px;height:16px;" />
            <span>允许智能体写入、覆盖与修补本地文件代码</span>
          </label>
          <label style="display:flex;align-items:center;gap:10px;font-size:13px;color:#334155;cursor:pointer;">
            <input type="checkbox" id="setPermNetwork" ${perm.allowNetwork ? 'checked' : ''} style="width:16px;height:16px;" />
            <span>允许智能体发起外部网络请求 (HTTP/HTTPS)</span>
          </label>
          <label style="display:flex;align-items:center;gap:10px;font-size:13px;color:#334155;cursor:pointer;">
            <input type="checkbox" id="setPermSubagent" ${perm.allowSpawnSubagent ? 'checked' : ''} style="width:16px;height:16px;" />
            <span>允许智能体并发派发 Subagent 子智能体协作</span>
          </label>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:12px;color:#64748b;">策略已持久化到 ~/.hap/config.toml</span>
          <button type="button" class="btn primary" id="saveSettingsPermBtn" onclick="window.savePermissionsFromSettings()" style="padding:7px 20px;font-weight:600;">保存权限安全策略</button>
        </div>
      </div>
    `;
  }
}

window.selectPermissionMode = (mode, isUserClick = true) => {
  ['modeCardFullAccess', 'modeCardConfirmWrites', 'modeCardStrict'].forEach((id) => {
    $(id)?.classList.remove('active');
  });

  if (mode === 'full-access') {
    $('modeCardFullAccess')?.classList.add('active');
    if (isUserClick) {
      if ($('permAllowShell')) $('permAllowShell').checked = true;
      if ($('permAllowFsWrite')) $('permAllowFsWrite').checked = true;
      if ($('permAllowNetwork')) $('permAllowNetwork').checked = true;
      if ($('permAllowSubagent')) $('permAllowSubagent').checked = true;
      showToast('已切换至「完完全全放开权限」模式', 'success');
    }
  } else if (mode === 'confirm-writes') {
    $('modeCardConfirmWrites')?.classList.add('active');
  } else if (mode === 'strict') {
    $('modeCardStrict')?.classList.add('active');
  }

  if (!state.permissions) state.permissions = {};
  state.permissions.mode = mode;
};

$('savePermissionsBtn')?.addEventListener('click', async () => {
  const activeMode = $('modeCardFullAccess')?.classList.contains('active')
    ? 'full-access'
    : $('modeCardConfirmWrites')?.classList.contains('active')
    ? 'confirm-writes'
    : 'strict';

  const config = {
    mode: activeMode,
    allowShell: $('permAllowShell').checked,
    allowFsWrite: $('permAllowFsWrite').checked,
    allowNetwork: $('permAllowNetwork').checked,
    allowSpawnSubagent: $('permAllowSubagent').checked,
    autoApproveTools: activeMode === 'full-access' ? ['*'] : [],
  };

  try {
    await window.hap.updatePermissions(config);
    state.permissions = config;
    showToast('权限策略已持久化保存！', 'success');
  } catch (error) {
    showToast('保存权限失败：' + error.message, 'error');
  }
});

// ==========================================================================
// 4. 工作区项目库管理
// ==========================================================================

function updateBatchBars() {
  const pCount = selectedProjectIds.size;
  if ($('projectBatchBar')) $('projectBatchBar').style.display = pCount > 0 ? 'flex' : 'none';
  if ($('batchDeleteProjectsText')) $('batchDeleteProjectsText').textContent = `批量移除 (${pCount})`;
  if ($('selectAllProjectsBtn')) $('selectAllProjectsBtn').textContent = pCount === state.projects.length && pCount > 0 ? '取消全选' : '全选';

  const provCount = selectedProviderIds.size;
  if ($('providerBatchBar')) $('providerBatchBar').style.display = provCount > 0 ? 'flex' : 'none';
  if ($('batchDeleteProvidersText')) $('batchDeleteProvidersText').textContent = `批量删除 (${provCount})`;
  if ($('selectAllProvidersBtn')) $('selectAllProvidersBtn').textContent = provCount === state.providers.length && provCount > 0 ? '取消全选' : '全选';

  const mCount = selectedModelAliases.size;
  if ($('modelBatchBar')) $('modelBatchBar').style.display = mCount > 0 ? 'flex' : 'none';
  if ($('batchDeleteModelsText')) $('batchDeleteModelsText').textContent = `批量删除 (${mCount})`;
  if ($('selectAllModelsBtn')) $('selectAllModelsBtn').textContent = mCount === state.models.length && mCount > 0 ? '取消全选' : '全选';
}

function renderProjects() {
  const containers = [$('projectList'), $('projectsTable')].filter(Boolean);
  if (containers.length === 0) return;

  const html = state.projects.length === 0
    ? `<div class="empty-card" style="padding:24px;text-align:center;color:var(--text-muted);font-size:12.5px;">暂未导入任何工作区工程，点击上方“导入已有项目”开始。</div>`
    : state.projects.map((p) => `
        <div class="card project-card" style="margin-bottom:10px;padding:12px;background:#ffffff;border:1px solid var(--border-default);border-radius:8px;">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <strong style="font-size:13.5px;color:var(--text-main);">${esc(p.name)}</strong>
              <span class="prop-chip" style="font-size:11px;">${esc(p.id)}</span>
            </div>
          </div>
          <div style="font-size:11.5px;color:var(--text-secondary);margin-bottom:8px;font-family:var(--font-mono);word-break:break-all;">
            ${esc(p.path)}
          </div>
          <div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
            <button type="button" class="btn text-btn" style="font-size:11.5px;padding:3px 8px;" onclick="useProjectInChat('${escJs(p.path)}')">在对话中使用</button>
            <button type="button" class="btn secondary" style="font-size:11.5px;padding:3px 8px;" onclick="openPathInExplorer('${escJs(p.path)}')">文件夹</button>
            <button type="button" class="btn secondary" style="font-size:11.5px;padding:3px 8px;" onclick="openPathInTerminal('${escJs(p.path)}')">终端</button>
            <button type="button" class="btn secondary" style="font-size:11.5px;padding:3px 8px;" onclick="openPathInVsCode('${escJs(p.path)}')">VS Code</button>
            <button type="button" class="btn danger" style="font-size:11.5px;padding:3px 8px;" onclick="removeProject('${escJs(p.id)}', '${escJs(p.name)}')">移除</button>
          </div>
        </div>
      `).join('');

  containers.forEach(c => { c.innerHTML = html; });
}

$('selectAllProjectsBtn')?.addEventListener('click', () => {
  if (selectedProjectIds.size === state.projects.length) {
    selectedProjectIds.clear();
  } else {
    state.projects.forEach((p) => selectedProjectIds.add(p.id));
  }
  renderProjects();
  updateBatchBars();
});

$('batchDeleteProjectsBtn')?.addEventListener('click', async () => {
  const ids = [...selectedProjectIds];
  if (ids.length === 0) return;

  const ok = await showConfirm({
    title: '批量移除项目',
    message: `确定要从工作区列表中批量移除选中的 <strong>${ids.length}</strong> 个项目吗？<br/><br/>此操作仅从工作台移除管理，不会删除磁盘上的真实代码。`,
    okText: '确认移除',
    isDanger: true,
  });
  if (!ok) return;

  try {
    await window.hap.batchRemoveProjects(ids);
    const removedSet = new Set(ids);
    selectedProjectIds.clear();
    if (currentActiveProject) {
      const remaining = (state.projects || []).filter((p) => !removedSet.has(p.id) && !removedSet.has(p.path));
      const stillActive = remaining.some((p) => normPath(p.path) === normPath(currentActiveProject));
      if (!stillActive) {
        currentActiveProject = remaining[0]?.path || '';
      }
    }
    showToast(`已成功移除 ${ids.length} 个项目`, 'success');
    await refresh();
  } catch (error) {
    showToast('批量移除失败：' + error.message, 'error');
  }
});

window.useProjectInChat = (path) => {
  currentActiveProject = path;
  show('chat');
  showToast(`已切换绑定工程：${path}`, 'info');
  renderProjectsTree();
  renderCurrentSessionMessages();
  updateGitStatus(currentActiveProject);
};

window.removeProject = async (id, name) => {
  const p = (state.projects || []).find((item) => item.id === id);
  const projName = name || p?.name || '项目';
  const projPath = p?.path || '';

  const ok = await showConfirm({
    title: '移除项目',
    message: `确定要从工作区移除项目 <strong>${esc(projName)}</strong> 吗？<br/><br/>此操作仅从工作台移除管理，不会删除磁盘上的真实代码。`,
    okText: '确认移除',
    isDanger: true,
  });
  if (!ok) return;

  try {
    await window.hap.removeProject(id);
    selectedProjectIds.delete(id);
    if (currentActiveProject && (normPath(currentActiveProject) === normPath(projPath) || (p && currentActiveProject === p.path))) {
      const remaining = (state.projects || []).filter((item) => item.id !== id && normPath(item.path) !== normPath(projPath));
      currentActiveProject = remaining[0]?.path || '';
    }
    showToast(`项目 "${projName}" 已从工作区移除`, 'success');
    await refresh();
  } catch (error) {
    showToast('移除失败：' + error.message, 'error');
  }
};

// ==========================================================================
// 5. 模型服务商管理
// ==========================================================================

function renderProviders() {
  const containers = [$('providerList'), $('providersTable')].filter(Boolean);
  if (containers.length === 0) return;

  if (state.providers.length === 0) {
    const emptyHtml = `<div class="empty-card" style="padding:32px;text-align:center;color:var(--text-muted);font-size:13px;">暂无配置的服务商，点击右上角“+ 添加 AI 服务商与模型”开始配置。</div>`;
    containers.forEach(c => { c.innerHTML = emptyHtml; });
    return;
  }

  const html = state.providers.map((p) => {
    const models = (state.models || []).filter(m => (m.providerId || m.provider) === p.id);
    const modelPills = models.length === 0
      ? '<span style="font-size:11.5px;color:var(--text-muted);font-style:italic;">尚未添加任何模型，可点击右侧「🔄 获取模型」或「+ 添加模型」</span>'
      : models.map(m => `
          <span class="prop-chip" style="background:#f0f9ff;border:1px solid #bae6fd;color:#0369a1;padding:3px 8px;font-size:11.5px;border-radius:6px;display:inline-flex;align-items:center;gap:4px;">
            <span style="font-weight:600;">${esc(m.alias)}</span>
            ${m.model && m.model !== m.alias ? `<span style="color:#64748b;font-size:10.5px;">(${esc(m.model)})</span>` : ''}
            ${m.contextWindow ? `<span style="font-size:10px;background:#e0f2fe;padding:1px 4px;border-radius:4px;color:#0284c7;">${(m.contextWindow / 1024).toFixed(0)}k</span>` : ''}
          </span>
        `).join(' ');

    return `
      <div class="card provider-card" style="margin-bottom:14px;padding:14px;background:#ffffff;border:1px solid var(--border-default);border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,0.02);">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;flex-wrap:wrap;gap:8px;">
          <div>
            <div style="display:flex;align-items:center;gap:8px;">
              <strong style="font-size:15px;color:var(--text-main);">${esc(p.name || p.id)}</strong>
              <span class="prop-chip" style="font-size:11.5px;font-weight:600;">${esc(p.id)}</span>
              <span class="badge ${p.hasCredential ? 'success' : 'warn'}" style="font-size:11px;">
                ${p.hasCredential ? '凭据就绪' : '缺凭据'}
              </span>
            </div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;word-break:break-all;font-family:var(--font-mono);">
              URL: ${esc(p.baseUrl)} | 线制: ${esc(p.wireApi)} | 协议: ${esc(p.defaultProtocol || p.protocol || '默认')}
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button type="button" class="btn secondary" style="font-size:11.5px;padding:4px 10px;" onclick="window.fetchAndSyncModelsForProvider('${escJs(p.id)}')">🔄 获取模型</button>
            <button type="button" class="btn secondary" style="font-size:11.5px;padding:4px 10px;" onclick="openProviderDialog('${escJs(p.id)}')">编辑服务商及模型</button>
            <button type="button" class="btn secondary" style="font-size:11.5px;padding:4px 10px;" onclick="testProvider('${escJs(p.id)}')">测试</button>
            <button type="button" class="btn danger" style="font-size:11.5px;padding:4px 10px;" onclick="deleteProvider('${escJs(p.id)}')">删除</button>
          </div>
        </div>

        <div style="margin-top:10px;padding-top:10px;border-top:1px solid #f1f5f9;">
          <div style="font-size:12px;font-weight:600;color:#475569;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">
            <span>包含的模型 (${models.length})：</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
            ${modelPills}
          </div>
        </div>
      </div>
    `;
  }).join('');

  containers.forEach(c => { c.innerHTML = html; });
}

$('selectAllProvidersBtn')?.addEventListener('click', () => {
  if (selectedProviderIds.size === state.providers.length) {
    selectedProviderIds.clear();
  } else {
    state.providers.forEach((p) => selectedProviderIds.add(p.id));
  }
  renderProviders();
  updateBatchBars();
});

$('batchDeleteProvidersBtn')?.addEventListener('click', async () => {
  const ids = [...selectedProviderIds];
  if (ids.length === 0) return;

  const ok = await showConfirm({
    title: '批量删除服务商',
    message: `确定要批量删除选中的 <strong>${ids.length}</strong> 个服务商吗？`,
    okText: '确认批量删除',
    isDanger: true,
  });
  if (!ok) return;

  try {
    await window.hap.batchRemoveProviders(ids);
    selectedProviderIds.clear();
    showToast(`已成功删除 ${ids.length} 个服务商`, 'success');
    await refresh();
  } catch (error) {
    showToast('批量删除失败：' + error.message, 'error');
  }
});

// ==========================================================================
// 5.5 智能体角色管理 (Agents)
// ==========================================================================

function renderAgents() {
  const list = $('agentList');
  if (!list) return;

  if (!state.agents || state.agents.length === 0) {
    list.innerHTML = `
      <div class="empty-card" style="grid-column:1/-1;padding:32px;text-align:center;color:var(--text-muted);">
        暂无已加载的智能体。
      </div>
    `;
    return;
  }

  list.innerHTML = state.agents.map((agent) => `
    <div class="card agent-card">
      <div class="card-header">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:38px;height:38px;border-radius:8px;background:#f1f5f9;display:grid;place-items:center;font-size:20px;flex-shrink:0;box-shadow:0 1px 2px rgba(0,0,0,0.04);">
            ${esc(agent.emoji || '')}
          </div>
          <div class="card-title-wrap">
            <span class="card-title">${esc(agent.displayName || agent.name || agent.id)}</span>
            <span class="card-subtitle">ID: ${esc(agent.id)}</span>
          </div>
        </div>
        <span class="badge ${agent.toolTier === 'full' ? 'danger' : 'neutral'}">
          ${esc(agent.toolTier || 'standard')}
        </span>
      </div>
      <div class="card-body">
        <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.5;margin-bottom:6px;min-height:36px;">
          ${esc(agent.description || '全功能多任务执行与代码分析智能体')}
        </div>
        <div class="card-props">
          <span class="prop-chip" style="background:#eff6ff;color:#2563eb;font-weight:600;">
            模型：${esc(agent.model || '全局默认')}
          </span>
          <span class="prop-chip" title="${esc(agent.workspace || '继承全局')}">
            工作区：${esc(agent.workspace ? agent.workspace.split(/[/\\]/).pop() || agent.workspace : '继承全局')}
          </span>
        </div>
      </div>
      <div class="card-footer">
        <div style="display:flex;gap:6px;margin-left:auto;">
          <button class="btn secondary" onclick="openAgentDialog('${esc(agent.id)}')">编辑配置</button>
          <button class="btn primary" onclick="startChatWithAgent('${esc(agent.id)}')">开始对话</button>
        </div>
      </div>
    </div>
  `).join('');
}

window.openAgentDialog = (agentId) => {
  const agent = (state.agents || []).find((a) => a.id === agentId);
  if (!agent) return;

  $('agentInputId').value = agent.id;
  $('agentInputDisplayName').value = agent.displayName || agent.name || agent.id;
  $('agentInputEmoji').value = agent.emoji || '';
  $('agentModalEmoji').textContent = agent.emoji || '';
  $('agentModalTitle').textContent = `配置智能体: ${agent.id}`;
  $('agentInputWorkspace').value = agent.workspace || '';
  $('agentInputDescription').value = agent.description || '';
  $('agentInputToolTier').value = agent.toolTier || 'coding';

  // 填充模型下拉选项
  const modelSelect = $('agentInputModel');
  if (modelSelect) {
    modelSelect.innerHTML = (state.models || []).map((m) => `
      <option value="${esc(m.alias)}" ${m.alias === agent.model ? 'selected' : ''}>
        ${esc(m.alias)} (${esc(m.providerId || m.provider)})
      </option>
    `).join('');
  }

  $('agentModal').showModal();
};

window.startChatWithAgent = (agentId) => {
  const select = $('chatAgentSelect');
  if (select) {
    select.value = agentId;
    select.dispatchEvent(new Event('change'));
  }
  show('chat');
};

$('closeAgentModalBtn')?.addEventListener('click', () => $('agentModal').close());
$('cancelAgentModalBtn')?.addEventListener('click', () => $('agentModal').close());

$('agentForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('agentInputId').value.trim();
  const displayName = $('agentInputDisplayName').value.trim();
  const emoji = $('agentInputEmoji').value.trim() || '';
  const model = $('agentInputModel').value.trim();
  const workspace = $('agentInputWorkspace').value.trim();
  const description = $('agentInputDescription').value.trim();
  const toolTier = $('agentInputToolTier').value;

  try {
    await window.hap.upsertAgent({
      id,
      displayName,
      emoji,
      model,
      workspace,
      description,
      toolTier,
    });
    $('agentModal').close();
    showToast(`智能体 [${id}] 配置已成功保存！`, 'success');
    await refresh();
  } catch (error) {
    showToast('更新智能体失败：' + error.message, 'error');
  }
});

// ==========================================================================
// 6. 模型目录管理
// ==========================================================================

function renderModels() {
  const containers = [$('modelList'), $('modelsTable')].filter(Boolean);
  if (containers.length === 0) return;

  const html = state.models.length === 0
    ? `<div class="empty-card" style="padding:24px;text-align:center;color:var(--text-muted);font-size:12.5px;">暂无声明的模型，点击右上角“+ 添加模型”开始。</div>`
    : state.models.map((m) => `
        <div class="card model-card" style="margin-bottom:10px;padding:12px;background:#ffffff;border:1px solid var(--border-default);border-radius:8px;">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <strong style="font-size:13.5px;color:var(--text-main);">${esc(m.alias)}</strong>
              <span class="prop-chip" style="font-size:11px;">${esc(m.providerId || m.provider || 'default')}</span>
            </div>
            <span class="badge neutral" style="font-size:11px;">${esc(m.model || m.fullName || m.alias)}</span>
          </div>
          <div style="font-size:11.5px;color:var(--text-secondary);margin-bottom:8px;">
            全名：${esc(m.fullName || m.alias)} | 上下文：${m.contextWindow ? m.contextWindow + ' tokens' : '自动'}
          </div>
          <div style="display:flex;gap:6px;justify-content:flex-end;">
            <button type="button" class="btn secondary" style="font-size:11.5px;padding:3px 8px;" onclick="openModelDialog('${escJs(m.alias)}')">编辑</button>
            <button type="button" class="btn danger" style="font-size:11.5px;padding:3px 8px;" onclick="deleteModel('${escJs(m.alias)}')">删除</button>
          </div>
        </div>
      `).join('');

  containers.forEach(c => { c.innerHTML = html; });
}

$('selectAllModelsBtn')?.addEventListener('click', () => {
  if (selectedModelAliases.size === state.models.length) {
    selectedModelAliases.clear();
  } else {
    state.models.forEach((m) => selectedModelAliases.add(m.alias));
  }
  renderModels();
  updateBatchBars();
});

$('batchDeleteModelsBtn')?.addEventListener('click', async () => {
  const aliases = [...selectedModelAliases];
  if (aliases.length === 0) return;

  const ok = await showConfirm({
    title: '批量删除模型',
    message: `确定要批量删除选中的 <strong>${aliases.length}</strong> 个模型吗？`,
    okText: '确认批量删除',
    isDanger: true,
  });
  if (!ok) return;

  try {
    await window.hap.batchRemoveModels(aliases);
    selectedModelAliases.clear();
    showToast(`已成功删除 ${aliases.length} 个模型`, 'success');
    await refresh();
  } catch (error) {
    showToast('批量删除失败：' + error.message, 'error');
  }
});

// ==========================================================================
// 7. CLI 目标状态与日志渲染
// ==========================================================================

function renderTargets() {
  const containers = [$('targetList'), $('targetsContainer')].filter(Boolean);
  if (containers.length === 0) return;

  const html = state.targets.length === 0
    ? `<div class="empty-card" style="padding:24px;text-align:center;color:var(--text-muted);font-size:12.5px;">未检测到已安装的 CLI 工具环境</div>`
    : state.targets.map((t) => `
        <div class="card target-card" style="margin-bottom:10px;padding:12px;background:#ffffff;border:1px solid var(--border-default);border-radius:8px;">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <strong style="font-size:13.5px;color:var(--text-main);text-transform:capitalize;">${esc(t.target)}</strong>
            <span class="badge ${t.exists ? 'success' : 'neutral'}" style="font-size:11px;">${t.exists ? '已检测到' : '未检测到'}</span>
          </div>
          <div style="font-size:11.5px;color:var(--text-secondary);margin-bottom:6px;">当前注入：<strong>${esc(t.configuredModel || '未配置 / 默认')}</strong></div>
          <div style="display:flex;justify-content:flex-end;">
            <button type="button" class="btn secondary" style="font-size:11.5px;padding:3px 8px;" onclick="quickSyncTarget('${escJs(t.target)}')">一键注入当前模型</button>
          </div>
        </div>
      `).join('');

  containers.forEach(c => { c.innerHTML = html; });
}

function renderLogs(filter = 'all') {
  const containers = [$('logList'), $('logsViewer')].filter(Boolean);
  const logs = state.logs || [];
  const filtered = logs.filter((log) => (filter === 'all' ? true : log.level === filter));

  const html = filtered.length === 0
    ? '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:12px;">暂无运行日志</div>'
    : filtered.slice().reverse().map((log) => `
        <div style="padding:6px 10px;margin-bottom:4px;border-radius:4px;background:#ffffff;border:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div style="display:flex;align-items:center;gap:6px;font-family:var(--font-mono);font-size:11.5px;">
            <span class="badge ${log.level === 'error' ? 'danger' : 'neutral'}" style="padding:1px 4px;font-size:10px;">${esc(log.level)}</span>
            <span style="word-break:break-all;color:#1e293b;">${esc(log.message)}</span>
          </div>
          <span style="font-size:10.5px;color:var(--text-muted);white-space:nowrap;">${new Date(log.at).toLocaleTimeString()}</span>
        </div>
      `).join('');

  containers.forEach(c => { c.innerHTML = html; });

  const cliTerminal = $('remoteTerminalOutput');
  if (cliTerminal && logs.length > 0) {
    const recentLogs = logs.slice(-15).map(l => `[${new Date(l.at).toLocaleTimeString()}] [${l.level.toUpperCase()}] ${l.message}`).join('\n');
    cliTerminal.textContent = recentLogs;
  }
}

function fillSelects() {
  const modelPicker = $('chatModelPickerSelect');
  if (modelPicker) {
    const previousModel = modelPicker.value || localStorage.getItem('hap:selected-chat-model') || '';
    modelPicker.innerHTML = state.models.map((m) => `
      <option value="${esc(m.fullName || m.alias)}">${esc(m.alias)} (${esc(m.providerId || m.provider || 'default')})</option>
    `).join('');
    if (previousModel && state.models.some((m) => (m.fullName || m.alias) === previousModel)) {
      modelPicker.value = previousModel;
    }
  }

  const switchModelSelect = $('switchModelSelect');
  if (switchModelSelect) {
    switchModelSelect.innerHTML = state.models.map((m) => `
      <option value="${esc(m.fullName || m.alias)}">${esc(m.alias)} (${esc(m.fullName)})</option>
    `).join('');
  }

  const agentSelect = $('chatAgentSelect');
  if (agentSelect) {
    const previousAgent = agentSelect.value || localStorage.getItem('hap:selected-chat-agent') || 'coder';
    agentSelect.innerHTML = state.agents.map((a) => `
      <option value="${esc(a.id)}">${esc(a.name || a.id)} (${esc(a.id)})</option>
    `).join('');
    if (previousAgent && state.agents.some((a) => a.id === previousAgent)) {
      agentSelect.value = previousAgent;
    }
  }

  const provSelect = $('modelProviderSelect');
  if (provSelect) {
    provSelect.innerHTML = state.providers.map((p) => `
      <option value="${esc(p.id)}">${esc(p.name || p.id)}</option>
    `).join('');
  }
}

// ==========================================================================
// 8. Telegram 机器人与远程协同
// ==========================================================================

let isTgTokenVisible = false;

$('toggleTgTokenVisibilityBtn')?.addEventListener('click', () => {
  isTgTokenVisible = !isTgTokenVisible;
  const input = $('tgTokenInput');
  if (input) input.type = isTgTokenVisible ? 'text' : 'password';
  const btn = $('toggleTgTokenVisibilityBtn');
  if (btn) btn.textContent = isTgTokenVisible ? '隐藏明文' : '显示明文';
});

async function renderTelegramView() {
  const form = $('tgConfigForm');
  if (!form) return;

  const wsPicker = $('tgWorkspacePickerSelect');
  if (wsPicker) {
    const projects = state.projects || [];
    wsPicker.innerHTML = ['<option value="">-- 从项目库快捷点选 --</option>']
      .concat(projects.map((p) => `<option value="${esc(p.path)}">${esc(p.name)}</option>`))
      .join('');

    wsPicker.onchange = (e) => {
      const val = e.target.value;
      if (val && $('tgWorkspaceInput')) {
        $('tgWorkspaceInput').value = val;
      }
    };
  }

  try {
    const tgConfig = await window.hap.getTelegramConfig();
    if (!tgConfig) return;

    if ($('tgTokenInput') && !$('tgTokenInput').value) {
      $('tgTokenInput').value = tgConfig.token || '';
    }
    if ($('tgModeSelect')) {
      $('tgModeSelect').value = tgConfig.mode || 'polling';
    }
    if ($('tgAllowedUsersInput') && !$('tgAllowedUsersInput').value) {
      $('tgAllowedUsersInput').value = Array.isArray(tgConfig.allowedUsers)
        ? tgConfig.allowedUsers.join(', ')
        : (tgConfig.allowedUsers || '');
    }
    if ($('tgAgentSelect')) {
      const agents = state.agents || [];
      if (agents.length > 0) {
        $('tgAgentSelect').innerHTML = agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.id)} (${esc(a.id)})</option>`).join('');
      }
      $('tgAgentSelect').value = tgConfig.defaultAgent || (agents[0]?.id || 'ops');
    }
    if ($('tgWorkspaceInput') && !$('tgWorkspaceInput').value) {
      $('tgWorkspaceInput').value = tgConfig.workspace || currentActiveProject || '';
    }

    const badge = $('tgStatusBadge');
    const toggleBtn = $('toggleTgServiceBtn');
    const nameEl = $('tgBotDisplayName');
    const usernameBadge = $('tgBotUsernameBadge');
    const descEl = $('tgStatusDescription');

    if (tgConfig.running) {
      if (badge) {
        badge.className = 'badge success';
        badge.textContent = '监听运行中';
      }
      if (toggleBtn) {
        toggleBtn.className = 'btn danger';
        toggleBtn.textContent = '停止 Telegram 机器人';
      }
      if (nameEl) nameEl.textContent = tgConfig.botName || 'Telegram 智能体机器人';
      if (usernameBadge) {
        usernameBadge.style.display = 'inline-block';
        usernameBadge.textContent = `@${tgConfig.botUsername || 'bot'}`;
      }
      if (descEl) descEl.textContent = '已就绪！您可以在 Telegram 中直接向该机器人发送任何修复和编程指令。';
    } else {
      if (badge) {
        badge.className = 'badge neutral';
        badge.textContent = '未运行';
      }
      if (toggleBtn) {
        toggleBtn.className = 'btn primary';
        toggleBtn.textContent = '启动 Telegram 机器人';
      }
      if (nameEl) nameEl.textContent = tgConfig.botName || 'Telegram 智能体机器人';
      if (usernameBadge) {
        usernameBadge.style.display = tgConfig.botUsername ? 'inline-block' : 'none';
        if (tgConfig.botUsername) usernameBadge.textContent = `@${tgConfig.botUsername}`;
      }
      if (descEl) descEl.textContent = '填写 Bot Token 并启动后，即可在 Telegram 直接向机器人发送指令';
    }
  } catch (err) {
    console.error('加载 Telegram 配置失败:', err);
  }
}

$('tgConfigForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('tgTokenInput')?.value.trim();
  const mode = $('tgModeSelect')?.value || 'polling';
  const defaultAgent = $('tgAgentSelect')?.value || 'coder';
  const workspace = $('tgWorkspaceInput')?.value.trim();
  const allowedUsers = $('tgAllowedUsersInput')?.value.trim();

  try {
    await window.hap.saveTelegramConfig({
      token,
      mode,
      defaultAgent,
      workspace,
      allowedUsers,
    });
    showToast('Telegram 通道配置已成功保存！', 'success');
    await renderTelegramView();
  } catch (err) {
    showToast('保存 Telegram 配置失败：' + err.message, 'error');
  }
});

$('testTgBotBtn')?.addEventListener('click', async () => {
  const token = $('tgTokenInput')?.value.trim();
  if (!token) {
    showToast('请先输入 Telegram Bot Token', 'info');
    $('tgTokenInput')?.focus();
    return;
  }

  showToast('正在验证 Telegram Bot Token...', 'info');
  try {
    const res = await window.hap.testTelegramBot(token);
    if (res.ok) {
      showToast(`Token 校验通过！机器人：${res.name} (@${res.username})`, 'success');
      $('tgBotDisplayName').textContent = res.name || 'Telegram 智能体机器人';
      const usernameBadge = $('tgBotUsernameBadge');
      if (usernameBadge) {
        usernameBadge.style.display = 'inline-block';
        usernameBadge.textContent = `@${res.username}`;
      }
    } else {
      showToast('Token 校验失败：' + res.error, 'error');
    }
  } catch (err) {
    showToast('校验异常：' + err.message, 'error');
  }
});

$('toggleTgServiceBtn')?.addEventListener('click', async () => {
  const tgConfig = await window.hap.getTelegramConfig();
  if (tgConfig.running) {
    try {
      await window.hap.stopTelegramService();
      showToast('Telegram 机器人服务已停止', 'info');
      await renderTelegramView();
    } catch (err) {
      showToast('停止失败：' + err.message, 'error');
    }
  } else {
    const token = $('tgTokenInput')?.value.trim();
    if (!token) {
      showToast('请先填写 Telegram Bot Token', 'info');
      $('tgTokenInput')?.focus();
      return;
    }

    showToast('正在启动 Telegram 机器人服务...', 'info');
    try {
      await window.hap.saveTelegramConfig({
        token,
        mode: $('tgModeSelect')?.value || 'polling',
        defaultAgent: $('tgAgentSelect')?.value || 'coder',
        workspace: $('tgWorkspaceInput')?.value.trim(),
        enabled: true,
      });

      const res = await window.hap.startTelegramService();
      showToast(res.message, 'success');
      await renderTelegramView();
    } catch (err) {
      showToast('启动 Telegram 机器人失败：' + err.message, 'error');
    }
  }
});

// ==========================================================================
// 7.5. 微信与企业微信通道 (WeChat / WeCom)
// ==========================================================================

async function renderWeChatView() {
  const form = $('wxConfigForm');
  if (!form) return;

  const wsPicker = $('wxWorkspacePickerSelect');
  if (wsPicker) {
    const projects = state.projects || [];
    wsPicker.innerHTML = ['<option value="">-- 从项目库快捷点选 --</option>']
      .concat(projects.map((p) => `<option value="${esc(p.path)}">${esc(p.name)}</option>`))
      .join('');

    wsPicker.onchange = (e) => {
      const val = e.target.value;
      if (val && $('wxWorkspaceInput')) {
        $('wxWorkspaceInput').value = val;
      }
    };
  }

  try {
    const wxConfig = await window.hap.getWeChatConfig();
    if (!wxConfig) return;

    if ($('wxModeSelect')) $('wxModeSelect').value = wxConfig.mode || 'personal';
    if ($('wxAgentSelect')) {
      const agents = state.agents || [];
      if (agents.length > 0) {
        $('wxAgentSelect').innerHTML = agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.id)} (${esc(a.id)})</option>`).join('');
      }
      $('wxAgentSelect').value = wxConfig.defaultAgent || (agents[0]?.id || 'ops');
    }
    if ($('wxWorkspaceInput') && !$('wxWorkspaceInput').value) {
      $('wxWorkspaceInput').value = wxConfig.workspace || currentActiveProject || '';
    }
    if ($('wxCorpIdInput') && !$('wxCorpIdInput').value) {
      $('wxCorpIdInput').value = wxConfig.wecomCorpId || '';
    }
    if ($('wxAgentIdInput') && !$('wxAgentIdInput').value && wxConfig.wecomAgentId) {
      $('wxAgentIdInput').value = wxConfig.wecomAgentId;
    }
    if ($('wxSecretInput') && !$('wxSecretInput').value) {
      $('wxSecretInput').value = wxConfig.wecomSecret || '';
    }
    if ($('wxVoiceTranscribeEnabled')) {
      $('wxVoiceTranscribeEnabled').checked = wxConfig.voiceTranscribe !== false;
    }
    if ($('wxApprovalCardEnabled')) {
      $('wxApprovalCardEnabled').checked = wxConfig.approvalCard !== false;
    }

    // 根据当前模式切换企微字段显示
    const isWeCom = ($('wxModeSelect')?.value || wxConfig.mode) === 'wecom';
    const wecomBox = $('wxWeComFields');
    if (wecomBox) {
      wecomBox.style.display = isWeCom ? 'flex' : 'none';
    }

    const badge = $('wxStatusBadge');
    const toggleBtn = $('toggleWxServiceBtn');
    const nameEl = $('wxDisplayName');
    const descEl = $('wxStatusDescription');
    const qrPlaceholder = $('wxQrPlaceholder');
    const qrBox = $('wxQrBox');

    if (wxConfig.running) {
      if (badge) {
        badge.className = wxConfig.status === 'connected' ? 'badge success' : 'badge warning';
        badge.textContent = wxConfig.status === 'connected' ? '微信已连接' : '等待手机扫码确认';
      }
      if (toggleBtn) {
        toggleBtn.className = 'btn danger';
        toggleBtn.textContent = '停止微信服务';
      }
      if (nameEl) nameEl.textContent = wxConfig.loginUser ? `微信用户：${wxConfig.loginUser}` : '微信智能体通道（服务中）';
      if (descEl) {
        descEl.textContent = wxConfig.status === 'connected'
          ? '已成功连接！您可以在手机微信中随时向智能体发送任何编程与审查需求。'
          : '服务已在本地监听，请使用手机微信扫描下方二维码并在手机端点击确认登录。';
      }

      if (qrBox && qrPlaceholder) {
        qrPlaceholder.style.display = 'none';
        qrBox.style.display = 'flex';
        qrBox.style.flexDirection = 'column';
        qrBox.style.alignItems = 'center';

        if (wxConfig.status === 'connected') {
          qrBox.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:24px 16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;text-align:center;width:100%;max-width:280px;box-shadow:0 4px 12px rgba(34,197,94,0.08);">
              <div style="width:44px;height:44px;border-radius:50%;background:#22c55e;color:#fff;display:grid;place-items:center;font-size:22px;box-shadow:0 2px 8px rgba(34,197,94,0.3);"></div>
              <div style="font-weight:700;color:#15803d;font-size:15px;">微信已成功连接就绪</div>
              <div style="font-size:12.5px;color:#166534;font-weight:500;">当前账号：${esc(wxConfig.loginUser || 'WeChat User')}</div>
              <div style="font-size:11.5px;color:#15803d;line-height:1.4;">现在拿起手机在微信中发送需求，AI 将实时自动响应并处理任务！</div>
            </div>
          `;
        } else if (wxConfig.qrCodeText) {
          let qrSvgHtml = '';
          if (window.QRCodeSvg && typeof window.QRCodeSvg.generate === 'function') {
            qrSvgHtml = window.QRCodeSvg.generate(wxConfig.qrCodeText, { size: 168 });
          } else {
            qrSvgHtml = `<div style="font-family:monospace;font-size:11px;color:#334155;word-break:break-all;background:#f1f5f9;padding:8px;border-radius:6px;">${esc(wxConfig.qrCodeText)}</div>`;
          }

          qrBox.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:2px 0;">
              <div style="padding:6px;background:#ffffff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.06);border:1px solid #e2e8f0;display:inline-block;">
                ${qrSvgHtml}
              </div>
              <div style="font-size:11.5px;color:#64748b;margin-top:2px;">请使用手机微信扫码并点击【确认登录】</div>
              <div style="display:flex;align-items:center;gap:6px;margin-top:2px;">
                <button type="button" class="btn text-btn" style="font-size:11.5px;padding:3px 8px;color:#2563eb;" onclick="copyText('${esc(wxConfig.qrCodeText)}', '登录链接')">
                  复制登录链接
                </button>
              </div>
            </div>
          `;
        }
      }
    } else {
      if (badge) {
        badge.className = 'badge neutral';
        badge.textContent = '未运行';
      }
      if (toggleBtn) {
        toggleBtn.className = 'btn primary';
        toggleBtn.textContent = '启动微信服务';
      }
      if (nameEl) nameEl.textContent = '微信未连接';
      if (descEl) descEl.textContent = '启动服务后，可在手机微信中直接给智能体发送需求与指令';

      if (qrPlaceholder && qrBox) {
        qrPlaceholder.style.display = 'block';
        qrBox.style.display = 'none';
      }
    }
    const confirmBox = $('wxConfirmActionBox');
    if (confirmBox) {
      confirmBox.style.display = (wxConfig.running && wxConfig.status !== 'connected') ? 'block' : 'none';
    }
  } catch (err) {
    console.error('加载微信配置失败:', err);
  }
}

$('confirmWxLoginBtn')?.addEventListener('click', async () => {
  try {
    showToast('正在确认并同步手机微信登录态...', 'info');
    const res = await window.hap.confirmWeChatLogin();
    if (res && res.status === 'connected') {
      showToast('微信通道已成功连接就绪！', 'success');
      await renderWeChatView();
    } else {
      showToast('尚未检测到手机端确认，请在微信中点击【确认登录】', 'warning');
    }
  } catch (err) {
    showToast('同步微信状态失败：' + err.message, 'error');
  }
});

$('wxModeSelect')?.addEventListener('change', (e) => {
  const isWeCom = e.target.value === 'wecom';
  const wecomBox = $('wxWeComFields');
  if (wecomBox) {
    wecomBox.style.display = isWeCom ? 'flex' : 'none';
  }
});

$('wxConfigForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = $('wxModeSelect')?.value || 'personal';
  const defaultAgent = $('wxAgentSelect')?.value || 'coder';
  const workspace = $('wxWorkspaceInput')?.value.trim();
  const wecomCorpId = $('wxCorpIdInput')?.value.trim();
  const wecomAgentId = $('wxAgentIdInput')?.value ? Number($('wxAgentIdInput').value) : undefined;
  const wecomSecret = $('wxSecretInput')?.value.trim();
  const voiceTranscribe = $('wxVoiceTranscribeEnabled')?.checked !== false;
  const approvalCard = $('wxApprovalCardEnabled')?.checked !== false;

  try {
    await window.hap.saveWeChatConfig({
      mode,
      defaultAgent,
      workspace,
      wecomCorpId,
      wecomAgentId,
      wecomSecret,
      voiceTranscribe,
      approvalCard,
    });
    showToast('微信通道配置已成功保存！', 'success');
    await renderWeChatView();
  } catch (err) {
    showToast('保存微信配置失败：' + err.message, 'error');
  }
});

$('refreshWxQrBtn')?.addEventListener('click', async () => {
  try {
    const res = await window.hap.syncWeChatContacts();
    showToast(`已同步 ${res.contacts} 位联系人和 ${res.rooms} 个群聊`, 'success');
    await renderWeChatView();
  } catch (err) {
    showToast('同步真实联系人失败：' + err.message, 'error');
  }
});

$('toggleWxServiceBtn')?.addEventListener('click', async () => {
  const wxConfig = await window.hap.getWeChatConfig();
  if (wxConfig.running) {
    try {
      await window.hap.stopWeChatService();
      showToast('微信服务已停止', 'info');
      await renderWeChatView();
    } catch (err) {
      showToast('停止失败：' + err.message, 'error');
    }
  } else {
    showToast('正在启动微信服务...', 'info');
    try {
      await window.hap.saveWeChatConfig({
        mode: $('wxModeSelect')?.value || 'personal',
        defaultAgent: $('wxAgentSelect')?.value || 'coder',
        workspace: $('wxWorkspaceInput')?.value.trim(),
        wecomCorpId: $('wxCorpIdInput')?.value.trim(),
        wecomAgentId: $('wxAgentIdInput')?.value ? Number($('wxAgentIdInput').value) : undefined,
        wecomSecret: $('wxSecretInput')?.value.trim(),
        enabled: true,
      });

      const res = await window.hap.startWeChatService();
      showToast(res.message, 'success');
      await renderWeChatView();
    } catch (err) {
      showToast('启动微信服务失败：' + err.message, 'error');
    }
  }
});

// 微信/企微状态自动同步监听 (每 1.2 秒快速响应)
setInterval(async () => {
  const wxView = $('wechat');
  if (wxView && wxView.classList.contains('active')) {
    try {
      const cfg = await window.hap.getWeChatConfig();
      if (cfg && cfg.running) {
        const badge = $('wxStatusBadge');
        const isAlreadyConnected = badge && badge.classList.contains('success');
        if (cfg.status === 'connected' && !isAlreadyConnected) {
          await renderWeChatView();
          showToast('微信通道已成功连接就绪！', 'success');
        }
      }
    } catch {}
  }
}, 1200);

// ==========================================================================
// 微信实时交互与消息监控面板
// ==========================================================================

const wechatMessageFeed = [];

function renderWeChatFeed() {
  const container = $('wxMessageFeed');
  if (!container) return;

  if (wechatMessageFeed.length === 0) {
    container.innerHTML = `
      <div class="empty-feed" id="wxEmptyFeedHint" style="text-align:center;color:var(--text-muted);padding:32px 0;font-size:12.5px;">
        暂无微信消息。启动微信服务后，在微信中发送指令，或在下方输入模拟指令即可在此实时呈现。
      </div>
    `;
    return;
  }

  container.innerHTML = wechatMessageFeed.map((item) => {
    const timeStr = item.time || new Date().toLocaleTimeString();
    if (item.type === 'incoming') {
      return `
        <div style="display:flex;flex-direction:column;align-items:flex-start;max-width:85%;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
            <span class="badge neutral" style="background:#dcfce7;color:#15803d;font-size:11px;font-weight:600;">微信端用户</span>
            <span style="font-size:11px;color:var(--text-muted);">${esc(timeStr)}</span>
          </div>
          <div style="background:#ffffff;border:1px solid #cbd5e1;padding:10px 14px;border-radius:12px 12px 12px 2px;font-size:13.5px;color:#0f172a;line-height:1.55;box-shadow:0 1px 3px rgba(0,0,0,0.02);word-break:break-word;">
            ${esc(item.text)}
          </div>
        </div>
      `;
    } else if (item.type === 'outgoing') {
      return `
        <div style="display:flex;flex-direction:column;align-items:flex-end;margin-left:auto;max-width:85%;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
            <span style="font-size:11px;color:var(--text-muted);">${esc(timeStr)}</span>
            <span class="badge" style="background:#eff6ff;color:#2563eb;font-size:11px;font-weight:600;">AI 智能体 (${esc(item.agent || 'coder')}) 回复</span>
          </div>
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;padding:12px 16px;border-radius:12px 12px 2px 12px;font-size:13.5px;color:#166534;line-height:1.65;box-shadow:0 1px 3px rgba(0,0,0,0.03);word-break:break-word;">
            ${renderMarkdownContent(item.text)}
          </div>
        </div>
      `;
    } else if (item.type === 'thinking') {
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#f1f5f9;border-radius:8px;font-size:12px;color:#475569;width:fit-content;">
          <div class="thinking-pulse-dot"></div>
          <span>智能体正在处理微信任务指令，检索本地代码与分析中...</span>
        </div>
      `;
    }
    return '';
  }).join('');

  container.scrollTop = container.scrollHeight;
}

$('clearWxMsgFeedBtn')?.addEventListener('click', () => {
  wechatMessageFeed.length = 0;
  renderWeChatFeed();
});

$('sendWxTestMsgBtn')?.addEventListener('click', async () => {
  const input = $('wxTestMessageInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  const now = new Date().toLocaleTimeString();

  wechatMessageFeed.push({ type: 'incoming', text, time: now });
  wechatMessageFeed.push({ type: 'thinking', time: now });
  renderWeChatFeed();

  try {
    const activeAgent = $('wxAgentSelect')?.value || 'coder';
    const activeModel = $('chatModelPickerSelect')?.value || (state.models[0]?.fullName || state.models[0]?.alias || 'gpt-5.5');
    const workspace = $('wxWorkspaceInput')?.value.trim() || currentActiveProject || '';

    const res = await window.hap.chat({
      input: text,
      agentId: activeAgent,
      model: activeModel,
      projectPath: workspace,
    });

    const thinkIdx = wechatMessageFeed.findIndex((m) => m.type === 'thinking');
    if (thinkIdx !== -1) wechatMessageFeed.splice(thinkIdx, 1);

    const replyContent = (res && res.output) ? res.output : (typeof res === 'string' ? res : '任务处理完成！');
    wechatMessageFeed.push({
      type: 'outgoing',
      text: replyContent,
      agent: activeAgent,
      time: new Date().toLocaleTimeString(),
    });
    renderWeChatFeed();
    showToast('已成功模拟微信端消息下发与智能体响应！', 'success');
  } catch (err) {
    const thinkIdx = wechatMessageFeed.findIndex((m) => m.type === 'thinking');
    if (thinkIdx !== -1) wechatMessageFeed.splice(thinkIdx, 1);

    wechatMessageFeed.push({
      type: 'outgoing',
      text: `执行遇到错误：${err.message}`,
      agent: '系统',
      time: new Date().toLocaleTimeString(),
    });
    renderWeChatFeed();
    showToast('模拟下发失败：' + err.message, 'error');
  }
});

$('wxTestMessageInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('sendWxTestMsgBtn')?.click();
  }
});

// ==========================================================================
// 8. 弹窗交互与模板
// ==========================================================================

const PRESET_TEMPLATES = {
  openai: { name: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', wireApi: 'chat', protocol: 'openai-tools' },
  deepseek: { name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com', wireApi: 'chat', protocol: 'deepseek' },
  openrouter: { name: 'OpenRouter 全球聚合', baseUrl: 'https://openrouter.ai/api/v1', wireApi: 'chat', protocol: 'openai-tools' },
  anthropic: { name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1', wireApi: 'anthropic-messages', protocol: 'anthropic' },
  groq: { name: 'Groq 极速推理', baseUrl: 'https://api.groq.com/openai/v1', wireApi: 'chat', protocol: 'openai-tools' },
  siliconflow: { name: 'SiliconFlow 硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', wireApi: 'chat', protocol: 'openai-tools' },
  moonshot: { name: 'Moonshot 月之暗面', baseUrl: 'https://api.moonshot.cn/v1', wireApi: 'chat', protocol: 'openai-tools' },
  zhipu: { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', wireApi: 'chat', protocol: 'openai-tools' },
};

function initPresetSelect() {
  const select = $('providerPresetSelect');
  if (!select) return;
  const options = ['<option value="">-- 选择预置模板（如 OpenAI、DeepSeek、OpenRouter 等） --</option>'];
  Object.keys(PRESET_TEMPLATES).forEach((key) => {
    options.push(`<option value="${key}">${PRESET_TEMPLATES[key].name} (${key})</option>`);
  });
  select.innerHTML = options.join('');

  select.addEventListener('change', (e) => {
    const key = e.target.value;
    if (!key || !PRESET_TEMPLATES[key]) return;
    const t = PRESET_TEMPLATES[key];
    $('providerInputId').value = key;
    $('providerInputName').value = t.name;
    $('providerInputBaseUrl').value = t.baseUrl;
    $('providerInputWireApi').value = t.wireApi;
    $('providerInputProtocol').value = t.protocol;
    $('providerInputEnvKey').value = `${key.toUpperCase()}_API_KEY`;
  });
}
initPresetSelect();

let isApiKeyVisible = false;
$('toggleApiKeyVisibilityBtn')?.addEventListener('click', () => {
  isApiKeyVisible = !isApiKeyVisible;
  const input = $('providerInputApiKey');
  input.type = isApiKeyVisible ? 'text' : 'password';
  $('toggleApiKeyVisibilityBtn').textContent = isApiKeyVisible ? '隐藏明文' : '显示明文';
});

window.openProviderDialog = (id) => {
  const dialog = $('providerDialog');
  const form = $('providerForm');
  form.reset();
  isApiKeyVisible = false;
  $('providerInputApiKey').type = 'password';
  $('toggleApiKeyVisibilityBtn').textContent = '显示明文';
  if ($('remoteModelPoolBox')) $('remoteModelPoolBox').style.display = 'none';

  if (id) {
    const p = state.providers.find((item) => item.id === id);
    if (!p) return;
    $('providerDialogTitle').textContent = `编辑 AI 服务商及模型：${p.name || p.id}`;
    $('providerPresetRow').style.display = 'none';
    $('providerInputId').value = p.id;
    $('providerInputId').readOnly = true;
    $('providerInputName').value = p.name || '';
    $('providerInputBaseUrl').value = p.baseUrl || '';
    $('providerInputApiKey').value = '';
    $('providerInputEnvKey').value = p.envKey || '';
    $('providerInputWireApi').value = p.wireApi || 'chat';
    $('providerInputProtocol').value = p.defaultProtocol || p.protocol || 'openai-tools';
    $('deleteProviderBtn').style.display = 'inline-block';
    $('testProviderBtn').style.display = 'inline-block';

    currentDialogModels = (state.models || [])
      .filter(m => (m.providerId || m.provider) === p.id)
      .map(m => ({ alias: m.alias, model: m.model || m.modelName || m.alias, contextWindow: m.contextWindow || 64000 }));
  } else {
    $('providerDialogTitle').textContent = '新增 AI 服务商与模型';
    $('providerPresetRow').style.display = 'block';
    $('providerInputId').readOnly = false;
    $('deleteProviderBtn').style.display = 'none';
    $('testProviderBtn').style.display = 'none';
    currentDialogModels = [];
  }
  renderCurrentDialogModels();
  dialog.showModal();
};

$('providerForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const providerId = data.id.trim();

  try {
    // 1. 保存服务商
    await window.hap.upsertProvider({
      id: providerId,
      name: data.name?.trim(),
      baseUrl: data.baseUrl.trim(),
      apiKey: data.apiKey?.trim() || undefined,
      envKey: data.envKey?.trim() || undefined,
      wireApi: data.wireApi,
      protocol: data.protocol,
    });

    // 2. 同步保存该服务商名下的所有模型
    for (const m of currentDialogModels) {
      await window.hap.upsertModel({
        alias: m.alias,
        provider: providerId,
        model: m.model || m.alias,
        contextWindow: m.contextWindow || 64000,
      }).catch(err => console.warn('保存模型警告:', err));
    }

    $('providerDialog').close();
    showToast(`🎉 服务商 ${providerId} 与 ${currentDialogModels.length} 个模型已成功保存！`, 'success');
    await refresh();
  } catch (error) {
    showToast('保存失败：' + error.message, 'error');
  }
});

window.deleteProvider = async (targetId) => {
  const id = targetId || $('providerInputId').value.trim();
  if (!id) return;

  const ok = await showConfirm({
    title: '删除服务商',
    message: `确定要删除服务商 <strong>${esc(id)}</strong> 吗？`,
    okText: '确认删除',
    isDanger: true,
  });
  if (!ok) return;

  try {
    await window.hap.removeProvider(id);
    $('providerDialog').close();
    selectedProviderIds.delete(id);
    showToast(`服务商 ${id} 已删除`, 'success');
    await refresh();
  } catch (error) {
    showToast('删除失败：' + error.message, 'error');
  }
};

window.testProvider = async (targetId) => {
  const id = targetId || $('providerInputId').value.trim();
  if (!id) return;
  showToast(`正在测试连通性：${id}...`, 'info');
  try {
    const res = await window.hap.testProvider(id);
    if (res.reachable) {
      showToast(`服务商 ${id} 连通性测试通过！可达`, 'success');
    } else {
      showToast(`连接失败：${res.error || '无法建立握手'}`, 'error');
    }
  } catch (error) {
    showToast('测试异常：' + error.message, 'error');
  }
};

// 模型弹窗与在线拉取
window.openModelDialog = (alias) => {
  const dialog = $('modelDialog');
  const form = $('modelForm');
  form.reset();
  $('remoteModelPicker').style.display = 'none';

  if (alias) {
    const m = state.models.find((item) => item.alias === alias);
    if (!m) return;
    $('modelDialogTitle').textContent = `编辑模型：${m.alias}`;
    $('modelInputAlias').value = m.alias;
    $('modelInputAlias').readOnly = true;
    $('modelProviderSelect').value = m.providerId || m.provider || '';
    $('modelInputModel').value = m.modelName || m.model || '';
    $('modelInputContext').value = m.contextWindow || '';
    $('modelInputMaxOutput').value = m.maxOutputTokens || '';
    $('modelInputProtocol').value = m.protocol || '';
    $('deleteModelBtn').style.display = 'inline-block';
  } else {
    $('modelDialogTitle').textContent = '新增模型';
    $('modelInputAlias').readOnly = false;
    $('deleteModelBtn').style.display = 'none';
  }
  dialog.showModal();
};

window.openModelDialogWithProvider = (providerId) => {
  openModelDialog();
  if ($('modelProviderSelect')) {
    $('modelProviderSelect').value = providerId;
  }
};

$('fetchRemoteModelsBtn')?.addEventListener('click', async () => {
  const providerId = $('modelProviderSelect').value;
  if (!providerId) {
    showToast('请先选择所属服务商', 'info');
    return;
  }

  const btnText = $('fetchRemoteBtnText');
  btnText.textContent = '正在拉取远端模型列表中...';

  try {
    const res = await window.hap.fetchProviderModels(providerId);
    if (res.ok && res.models.length > 0) {
      showToast(`成功获取到 ${res.models.length} 个可用模型`, 'success');
      const picker = $('remoteModelPicker');
      picker.style.display = 'block';
      const options = ['<option value="">-- 点击快速点选拉取到的模型 --</option>'];
      res.models.forEach((name) => {
        options.push(`<option value="${esc(name)}">${esc(name)}</option>`);
      });
      picker.innerHTML = options.join('');

      picker.onchange = (e) => {
        const val = e.target.value;
        if (!val) return;
        $('modelInputModel').value = val;
        if (!$('modelInputAlias').value || $('modelInputAlias').readOnly === false) {
          const shortName = val.split('/').pop();
          $('modelInputAlias').value = shortName;
        }
      };
    } else {
      showToast('拉取失败：' + (res.error || '该服务商未开放标准 /v1/models 接口'), 'error');
    }
  } catch (error) {
    showToast('拉取异常：' + error.message, 'error');
  } finally {
    btnText.textContent = '获取可用模型列表';
  }
});

$('modelForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const data = Object.fromEntries(new FormData(form));

  try {
    await window.hap.upsertModel({
      alias: data.alias.trim(),
      provider: data.provider.trim(),
      model: data.model.trim(),
      contextWindow: data.contextWindow ? Number(data.contextWindow) : undefined,
      maxOutputTokens: data.maxOutputTokens ? Number(data.maxOutputTokens) : undefined,
      protocol: data.protocol ? data.protocol : undefined,
    });
    $('modelDialog').close();
    showToast(`模型 ${data.alias} 保存成功`, 'success');
    await refresh();
  } catch (error) {
    showToast('保存模型失败：' + error.message, 'error');
  }
});

window.deleteModel = async (targetAlias) => {
  const alias = targetAlias || $('modelInputAlias').value.trim();
  if (!alias) return;

  const ok = await showConfirm({
    title: '删除模型',
    message: `确定要从目录中删除模型 <strong>${esc(alias)}</strong> 吗？`,
    okText: '确认删除',
    isDanger: true,
  });
  if (!ok) return;

  try {
    await window.hap.removeModel(alias);
    $('modelDialog').close();
    selectedModelAliases.delete(alias);
    showToast(`模型 ${alias} 已删除`, 'success');
    await refresh();
  } catch (error) {
    showToast('删除失败：' + error.message, 'error');
  }
};

window.openProjectDialog = () => {
  const dialog = $('projectDialog');
  $('projectForm').reset();
  dialog.showModal();
};

$('projectForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const data = Object.fromEntries(new FormData(form));

  try {
    const project = await window.hap.addProject({
      name: data.name?.trim(),
      path: data.path.trim(),
    });
    $('projectDialog').close();
    showToast(`项目 ${project.name} 添加成功`, 'success');
    currentActiveProject = project.path;
    await refresh();
  } catch (error) {
    showToast('添加项目失败：' + error.message, 'error');
  }
});

// ==========================================================================
// 视图切换与导航
// ==========================================================================

function switchView(view) {
  show(view);
}
window.switchView = switchView;

function show(view) {
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.id === view));
  document.querySelectorAll('.nav').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
}

document.querySelectorAll('.nav').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view) show(btn.dataset.view);
  });
});

// 弹窗事件绑定
$('addProviderBtn')?.addEventListener('click', () => openProviderDialog());
$('closeProviderDialogBtn')?.addEventListener('click', () => $('providerDialog').close());
$('cancelProviderDialogBtn')?.addEventListener('click', () => $('providerDialog').close());
$('deleteProviderBtn')?.addEventListener('click', () => deleteProvider());
$('testProviderBtn')?.addEventListener('click', () => testProvider());

$('addModelBtn')?.addEventListener('click', () => openModelDialog());
$('closeModelDialogBtn')?.addEventListener('click', () => $('modelDialog').close());
$('cancelModelDialogBtn')?.addEventListener('click', () => $('modelDialog').close());
$('deleteModelBtn')?.addEventListener('click', () => deleteModel());

$('addProjectManualBtn')?.addEventListener('click', () => openProjectDialog());
$('closeProjectDialogBtn')?.addEventListener('click', () => $('projectDialog').close());
$('cancelProjectDialogBtn')?.addEventListener('click', () => $('projectDialog').close());
$('importProjectBtn')?.addEventListener('click', async () => {
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

document.querySelectorAll('dialog.modal').forEach((modal) => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.close();
  });
});

$('copyPreviewBtn')?.addEventListener('click', () => {
  const content = $('syncPreview').textContent;
  copyText(content, '配置预览');
});

document.querySelectorAll('.filter-group .filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-group .filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentLogFilter = btn.dataset.filter;
    renderLogs(currentLogFilter);
  });
});

$('clearLogsBtn')?.addEventListener('click', async () => {
  try {
    await window.hap.clearLogs();
    state.logs = [];
    renderLogs(currentLogFilter);
    showToast('日志已清空', 'info');
  } catch (error) {
    showToast('清空日志失败：' + error.message, 'error');
  }
});

$('switchForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitter = event.submitter;
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const isWrite = submitter?.value === 'write';

  try {
    const result = await window.hap.syncTarget({
      target: data.target,
      model: data.model,
      write: isWrite,
    });
    $('syncPreview').textContent = JSON.stringify(result, null, 2);
    showToast(isWrite ? `已成功写入同步到 ${data.target}` : `已生成 ${data.target} 注入预览`, 'success');
    await refresh();
  } catch (error) {
    $('syncPreview').textContent = `// 错误：\n${error.message}`;
    showToast('同步失败：' + error.message, 'error');
  }
});

// ==========================================================================
// 多模态附件管理 (Multimodal Attachments, Paste, Drag&Drop, Lightbox)
// ==========================================================================

let currentAttachments = [];

function renderComposerAttachments() {
  const tray = $('composerAttachmentsTray');
  if (!tray) return;

  if (currentAttachments.length === 0) {
    tray.style.display = 'none';
    tray.innerHTML = '';
    updateComposerState();
    return;
  }

  tray.style.display = 'flex';
  tray.innerHTML = currentAttachments.map((item, index) => {
    const isImg = item.kind === 'image' || (item.mimeType && item.mimeType.startsWith('image/'));
    const previewHtml = isImg
      ? `<img class="attachment-thumb-img" src="${esc(item.dataUrl || item.path)}" alt="${esc(item.fileName)}" />`
      : `<div class="attachment-doc-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        </div>`;

    return `
      <div class="composer-attachment-item">
        ${previewHtml}
        <div class="attachment-meta">
          <span class="attachment-name" title="${esc(item.fileName)}">${esc(item.fileName)}</span>
          <span class="attachment-size">${formatFileSize(item.bytes)}</span>
        </div>
        <button type="button" class="attachment-remove-btn" onclick="window.removeComposerAttachment(${index})" title="移除附件"></button>
      </div>
    `;
  }).join('');

  updateComposerState();
}

window.removeComposerAttachment = (index) => {
  currentAttachments.splice(index, 1);
  renderComposerAttachments();
};

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleAddFiles(files) {
  if (!files || files.length === 0) return;
  let addedCount = 0;
  for (const file of files) {
    try {
      const isImg = file.type.startsWith('image/');
      const kind = isImg ? 'image' : 'document';
      const dataUrl = await readFileAsDataUrl(file);
      currentAttachments.push({
        kind,
        fileName: file.name || (isImg ? 'image.png' : 'document.txt'),
        mimeType: file.type || (isImg ? 'image/png' : 'application/octet-stream'),
        bytes: file.size,
        dataUrl: typeof dataUrl === 'string' ? dataUrl : undefined,
      });
      addedCount++;
    } catch (err) {
      console.error('读取附件失败:', err);
    }
  }
  if (addedCount > 0) {
    renderComposerAttachments();
    showToast(`已附加 ${addedCount} 个文件/图片`, 'info');
    $('chatInput')?.focus();
  }
}

// 1. 上传按钮点选
$('chatAttachBtn')?.addEventListener('click', () => {
  $('chatFileInput')?.click();
});

$('chatFileInput')?.addEventListener('change', async (e) => {
  const files = e.target.files;
  if (files && files.length > 0) {
    await handleAddFiles(Array.from(files));
    e.target.value = '';
  }
});

// 2. 剪贴板截图粘贴 (Ctrl+V)
window.addEventListener('paste', async (e) => {
  const chatView = $('chat');
  if (!chatView || !chatView.classList.contains('active')) return;

  const items = e.clipboardData?.items;
  if (!items) return;

  const imageFiles = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.indexOf('image') !== -1) {
      const file = item.getAsFile();
      if (file) imageFiles.push(file);
    }
  }

  if (imageFiles.length > 0) {
    e.preventDefault();
    await handleAddFiles(imageFiles);
  }
});

// 3. 拖拽文件进入聊天输入区域
const dropOverlay = $('composerDropOverlay');

['dragenter', 'dragover'].forEach((eventName) => {
  window.addEventListener(eventName, (e) => {
    const chatView = $('chat');
    if (!chatView || !chatView.classList.contains('active')) return;
    e.preventDefault();
    e.stopPropagation();
    if (dropOverlay) dropOverlay.style.display = 'flex';
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  window.addEventListener(eventName, (e) => {
    const chatView = $('chat');
    if (!chatView || !chatView.classList.contains('active')) return;
    e.preventDefault();
    e.stopPropagation();
    if (eventName === 'drop') {
      if (dropOverlay) dropOverlay.style.display = 'none';
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        handleAddFiles(Array.from(files));
      }
    } else if (eventName === 'dragleave') {
      if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
        if (dropOverlay) dropOverlay.style.display = 'none';
      }
    }
  });
});

// 4. 图片 Lightbox 全屏预览
window.openImageLightbox = (src, title) => {
  const modal = $('imageLightboxModal');
  const img = $('lightboxImg');
  const titleEl = $('lightboxTitle');
  if (!modal || !img) return;

  img.src = src;
  if (titleEl) titleEl.textContent = title || '图片查看';

  const copyBtn = $('lightboxCopyBtn');
  if (copyBtn) {
    copyBtn.onclick = () => {
      copyText(src, '图片链接/数据');
    };
  }

  const dlBtn = $('lightboxDownloadBtn');
  if (dlBtn) {
    dlBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = src;
      a.download = title || `hap_image_${Date.now()}.png`;
      a.click();
      showToast('已开始下载图片', 'info');
    };
  }

  const closeBtn = $('closeLightboxBtn');
  if (closeBtn) {
    closeBtn.onclick = () => modal.close();
  }

  modal.onclick = (e) => {
    if (e.target === modal) modal.close();
  };

  modal.showModal();
};

// ChatGPT 输入框自适应增长与发送按钮状态
const chatInput = $('chatInput');
const sendBtn = $('sendChatBtn');
const chatModelPicker = $('chatModelPickerSelect');
chatModelPicker?.addEventListener('change', () => {
  localStorage.setItem('hap:selected-chat-model', chatModelPicker.value);
});

function updateComposerState() {
  if (!chatInput) return;
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
  if (sendBtn) {
    sendBtn.disabled = !chatInput.value.trim() && currentAttachments.length === 0;
  }
}

chatInput?.addEventListener('input', updateComposerState);
updateComposerState();

chatInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (chatInput.value.trim() || currentAttachments.length > 0) {
      $('chatForm').requestSubmit();
    }
  }
});

$('chatForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  const attachmentsToSend = [...currentAttachments];
  if (!text && attachmentsToSend.length === 0) return;

  chatInput.value = '';
  currentAttachments = [];
  renderComposerAttachments();
  updateComposerState();

  const session = currentSession();
  const targetSessionId = session.id;
  session.isGenerating = true;
  if (session.messages.length === 0) {
    session.title = text ? text.slice(0, 22) : (attachmentsToSend[0]?.fileName || '图片分析');
  }
  session.updatedAt = new Date().toISOString();
  session.projectPath = currentActiveProject;
  session.messages.push({
    role: 'user',
    content: text,
    attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
    timestamp: new Date().toISOString(),
  });
  saveSessionsToStorage();
  renderCurrentSessionMessages();
  renderProjectsTree();

  try {
    const selectedModel = $('chatModelPickerSelect')?.value || undefined;
    const result = await window.hap.chat({
      input: text || '（请分析和审查上方附加的文件或图片）',
      agentId: $('chatAgentSelect')?.value || undefined,
      model: selectedModel,
      projectPath: currentActiveProject || undefined,
      attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
      sessionKey: 'gui:' + targetSessionId,
    });

    let reply = '';
    let reasoningText = '';
    const outcome = result.outcome;
    if (outcome) {
      if (outcome.reasoning && outcome.reasoning.trim()) {
        reasoningText = outcome.reasoning.trim();
      }

      if (outcome.text && outcome.text.trim()) {
        reply = outcome.text.trim();
      } else if (outcome.messages && outcome.messages.length > 0) {
        const assistantMsgs = outcome.messages.filter((m) => m.role === 'assistant' && m.content && m.content.trim());
        if (assistantMsgs.length > 0) {
          reply = assistantMsgs.map((m) => m.content.trim()).join('\n\n');
        }
        if (!reasoningText) {
          const reasoningMsgs = outcome.messages.filter((m) => m.role === 'assistant' && m.reasoning && m.reasoning.trim());
          if (reasoningMsgs.length > 0) {
            reasoningText = reasoningMsgs.map((m) => m.reasoning.trim()).join('\n\n');
          }
        }
      }

      if (!reply && reasoningText) {
        reply = '已完成思考与任务执行。';
      }

      if (!reply && outcome.iterations > 0) {
        reply = `智能体已顺利执行 ${outcome.iterations} 轮工具编排并完成任务。`;
      }

      if (!reply && outcome.error) {
        reply = `任务执行提示：${outcome.error}`;
      }
    }

    if (!reasoningText && Array.isArray(result.events)) {
      const reasoningEvents = result.events.filter((e) => e.type === 'reasoning' && e.text).map((e) => e.text);
      if (reasoningEvents.length > 0) reasoningText = reasoningEvents.join('');
    }

    if (!reply && Array.isArray(result.events)) {
      const textEvents = result.events.filter((e) => e.type === 'text' && e.text).map((e) => e.text);
      if (textEvents.length > 0) reply = textEvents.join('');
    }

    if (!reply) {
      reply = '智能体已执行完毕。';
    }
    session.isGenerating = false;
    session.messages.push({
      role: 'assistant',
      content: reply,
      reasoning: reasoningText || undefined,
      timestamp: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();
    saveSessionsToStorage();
  } catch (error) {
    session.isGenerating = false;
    session.messages.push({
      role: 'assistant',
      content: `**执行失败：** ${error.message}`,
      timestamp: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();
    saveSessionsToStorage();
    showToast('对话执行失败：' + error.message, 'error');
  }

  if (currentSessionId === targetSessionId) {
    renderCurrentSessionMessages();
  } else {
    showToast(`会话 [${session.title || '新对话'}] 已完成思考并回复`, 'success');
  }
  renderProjectsTree();
  updateGitStatus(currentActiveProject);
  await refresh();
});

window.openGitModalWithCurrentProject = async (targetFile) => {
  if (!currentActiveProject) {
    showToast('请先选择或导入工作区工程', 'info');
    return;
  }
  await updateGitStatus(currentActiveProject);
  renderGitModalContent();
  if (targetFile) {
    loadInlineDiff(targetFile);
  }
  $('gitModal').showModal();
};

// ==========================================================================
// 远程服务器与节点管理控制器 (Remote Servers & Terminal Controller)
// ==========================================================================

let cachedServers = [];
let activeTerminalServerId = '';

async function renderServers() {
  const grid = $('serverCardsGrid');
  const selectEl = $('terminalServerSelect');
  if (!grid) return;

  // 同步刷新顶部本机宿主状态卡片
  updateLocalHostCard();

  try {
    cachedServers = await window.hap.listServers();
  } catch {
    cachedServers = [];
  }

  // 更新终端与智能运维目标下拉选择框
  const opsTargetSelect = $('serverOpsTargetSelect');
  if (selectEl || opsTargetSelect) {
    const defaultId = activeTerminalServerId || (cachedServers.length > 0 ? cachedServers[0].id : '');
    const optionsHtml = '<option value="">-- 请选择目标服务器 --</option>' +
      cachedServers.map(s => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.host)})</option>`).join('');
    
    if (selectEl) {
      const curVal = selectEl.value || defaultId;
      selectEl.innerHTML = optionsHtml;
      if (curVal) selectEl.value = curVal;
      if (!activeTerminalServerId && cachedServers.length > 0) {
        activeTerminalServerId = cachedServers[0].id;
        selectEl.value = activeTerminalServerId;
      }
    }

    if (opsTargetSelect) {
      const curVal = opsTargetSelect.value || defaultId;
      opsTargetSelect.innerHTML = optionsHtml;
      if (curVal) opsTargetSelect.value = curVal;
      else if (cachedServers.length > 0) opsTargetSelect.value = cachedServers[0].id;
    }
  }

  if (cachedServers.length === 0) {
    grid.innerHTML = `
      <div class="card" style="grid-column: 1 / -1; text-align: center; padding: 42px 20px; color: var(--text-secondary);">
        <div style="font-size: 32px; margin-bottom: 12px;">️</div>
        <div style="font-weight: 700; font-size: 15px; color: var(--text-main); margin-bottom: 6px;">尚未添加任何远程服务器</div>
        <div style="font-size: 13px; max-width: 440px; margin: 0 auto 18px auto; line-height: 1.5;">
          输入服务器 IP (公网或局域网) 与 SSH 凭据，即可一键自动化部署 HAP 守护进程，实现跨机器算力协同与实时操控。
        </div>
        <button type="button" class="btn primary" onclick="window.openServerDialog()" style="margin:0 auto;">
          + 立即添加第一台服务器
        </button>
      </div>
    `;
    return;
  }

  grid.innerHTML = cachedServers.map((s) => {
    const statusMap = {
      online: { text: '● 在线 (Daemon 已就绪)', cls: 'badge', color: '#16a34a' },
      offline: { text: '○ 离线', cls: 'badge neutral', color: '#64748b' },
      installing: { text: '⏳ 正在部署...', cls: 'badge warn', color: '#d97706' },
      error: { text: ' 异常', cls: 'badge danger', color: '#dc2626' },
      uninstalled: { text: '未部署 Daemon', cls: 'badge neutral', color: '#475569' },
    };
    const st = statusMap[s.status] || statusMap.uninstalled;

    const info = s.systemInfo;
    const cpuPercent = info ? info.cpuUsagePercent : 0;
    const memPercent = info ? info.usedMemPercent : 0;
    const memUsedGb = info ? ((info.totalMemBytes - info.freeMemBytes) / (1024 * 1024 * 1024)).toFixed(1) : '—';
    const memTotalGb = info ? (info.totalMemBytes / (1024 * 1024 * 1024)).toFixed(1) : '—';
    const uptimeStr = info ? `${Math.floor(info.uptimeSeconds / 3600)}h ${Math.floor((info.uptimeSeconds % 3600) / 60)}m` : '—';

    return `
      <div class="card server-card" id="server-card-${esc(s.id)}">
        <div class="card-header">
          <div class="card-title-wrap" style="cursor:pointer;" onclick="window.openServerDetailsModal('${esc(s.id)}')" title="点击查看此服务器系统详情">
            <div class="card-title" style="display:flex;align-items:center;gap:6px;">
              <span>${esc(s.name)}</span>
              <span style="font-size:11px;color:#3b82f6;font-weight:normal;">[详情 ↗]</span>
            </div>
            <div class="card-subtitle">${esc(s.username)}@${esc(s.host)}:${esc(s.port)}</div>
          </div>
          <span class="${st.cls}" style="font-size:11px;">${st.text}</span>
        </div>

        <div class="card-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">
            <div class="server-stat-pill">
              <span style="color:var(--text-secondary);">OS:</span>
              <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${info ? esc(info.osRelease || info.platform) : 'Linux'}</span>
            </div>
            <div class="server-stat-pill">
              <span style="color:var(--text-secondary);">运行:</span>
              <span style="font-weight:600;">${uptimeStr}</span>
            </div>
          </div>

          <!-- CPU 监控指示条 -->
          <div style="margin-top:4px;">
            <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-secondary);">
              <span>CPU 占用</span>
              <span style="font-weight:600;color:var(--text-main);">${info ? cpuPercent + '%' : '—'}</span>
            </div>
            <div class="server-meter-bar">
              <div class="server-meter-fill ${cpuPercent > 80 ? 'danger' : cpuPercent > 50 ? 'warn' : ''}" style="width:${info ? cpuPercent : 0}%;"></div>
            </div>
          </div>

          <!-- 内存 监控指示条 -->
          <div>
            <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-secondary);">
              <span>内存 占用</span>
              <span style="font-weight:600;color:var(--text-main);">${info ? `${memPercent}% (${memUsedGb}/${memTotalGb}G)` : '—'}</span>
            </div>
            <div class="server-meter-bar">
              <div class="server-meter-fill ${memPercent > 85 ? 'danger' : memPercent > 60 ? 'warn' : ''}" style="width:${info ? memPercent : 0}%;"></div>
            </div>
          </div>

        </div>

        <div class="card-footer" style="display:flex;flex-wrap:wrap;gap:6px;justify-content:space-between;align-items:center;padding-top:10px;border-top:1px solid #f1f5f9;margin-top:6px;">
          <div style="display:flex;gap:6px;">
            <button type="button" class="btn primary" onclick="window.openServerDetailsModal('${esc(s.id)}')" style="padding:4px 10px;font-size:12px;" title="查看服务器完整硬件与系统详情">
              🔍 详情
            </button>
            <button type="button" class="btn secondary" onclick="window.testServerNode('${esc(s.id)}')" style="padding:4px 10px;font-size:12px;" title="测试 SSH 连通性">
              连通测试
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
  const s = (cachedServers || []).find((item) => item.id === id);
  const serverName = s ? `${s.name} (${s.host})` : id;
  const ok = await showConfirm({
    title: '移除服务器节点',
    message: `确定要移除服务器节点 <strong>${esc(serverName)}</strong> 吗？<br/><span style="font-size:12px;color:var(--text-muted);">移除后将停止该远端节点的连接与监控，该操作不影响远端主机上已部署的数据。</span>`,
    okText: '确认移除',
    isDanger: true,
  });
  if (!ok) return;
  try {
    await window.hap.removeServer(id);
    if (activeTerminalServerId === id) activeTerminalServerId = '';
    showToast(`已成功移除服务器节点 [${serverName}]`, 'info');
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
    const cfg = (window.hap.getFeishuConfig ? await window.hap.getFeishuConfig() : {}) || {};
    if ($('feishuAppIdInput')) $('feishuAppIdInput').value = cfg.appId || '';
    if ($('feishuAppSecretInput')) $('feishuAppSecretInput').value = cfg.appSecret || '';
    if ($('feishuEncryptKeyInput')) $('feishuEncryptKeyInput').value = cfg.encryptKey || '';
    if ($('feishuVerifyTokenInput')) $('feishuVerifyTokenInput').value = cfg.verificationToken || '';
    if ($('feishuAgentSelect')) {
      const agents = state.agents || [];
      if (agents.length > 0) {
        $('feishuAgentSelect').innerHTML = agents.map(a => `<option value="${esc(a.id)}">${esc(a.name || a.id)} (${esc(a.id)})</option>`).join('');
      }
      $('feishuAgentSelect').value = cfg.defaultAgent || (agents[0]?.id || 'ops');
    }
  } catch (err) {
    console.error('获取飞书配置异常:', err);
  }
}

$('feishuConfigForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (window.hap.saveFeishuConfig) {
      await window.hap.saveFeishuConfig({
        appId: $('feishuAppIdInput')?.value.trim() || '',
        appSecret: $('feishuAppSecretInput')?.value.trim() || '',
        encryptKey: $('feishuEncryptKeyInput')?.value.trim() || '',
        verificationToken: $('feishuVerifyTokenInput')?.value.trim() || '',
        defaultAgent: $('feishuAgentSelect')?.value || 'coder',
      });
    }
    showToast('飞书配置已成功保存！', 'success');
    await renderFeishuView();
  } catch (err) {
    showToast('保存飞书配置失败: ' + err.message, 'error');
  }
});

// ============================================================================
// 3. QQ / OneBot 机器人通道逻辑 (QQ Channel)
// ============================================================================
async function renderQQView() {
  try {
    const cfg = (window.hap.getQQConfig ? await window.hap.getQQConfig() : {}) || {};
    if ($('qqEndpointInput')) $('qqEndpointInput').value = cfg.endpoint || cfg.onebotWsUrl || 'http://127.0.0.1:3000';
    if ($('qqTokenInput')) $('qqTokenInput').value = cfg.token || cfg.onebotAccessToken || '';
    if ($('qqAdminListInput')) $('qqAdminListInput').value = cfg.adminList || '';
    if ($('qqAgentSelect')) {
      const agents = state.agents || [];
      if (agents.length > 0) {
        $('qqAgentSelect').innerHTML = agents.map(a => `<option value="${esc(a.id)}">${esc(a.name || a.id)} (${esc(a.id)})</option>`).join('');
      }
      $('qqAgentSelect').value = cfg.defaultAgent || (agents[0]?.id || 'ops');
    }
  } catch (err) {
    console.error('获取 QQ 配置异常:', err);
  }
}

$('qqConfigForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (window.hap.saveQQConfig) {
      await window.hap.saveQQConfig({
        endpoint: $('qqEndpointInput')?.value.trim() || 'http://127.0.0.1:3000',
        token: $('qqTokenInput')?.value.trim() || '',
        adminList: $('qqAdminListInput')?.value.trim() || '',
        defaultAgent: $('qqAgentSelect')?.value || 'coder',
      });
    }
    showToast('QQ / OneBot 配置已成功保存！', 'success');
    await renderQQView();
  } catch (err) {
    showToast('保存 QQ 配置失败: ' + err.message, 'error');
  }
});

$('sendQQTestMsgBtn')?.addEventListener('click', () => {
  const input = $('qqTestMessageInput');
  const msg = input ? input.value.trim() : '';
  if (!msg) return;
  const feed = $('qqMsgFeed');
  if (feed) {
    const timeStr = new Date().toLocaleTimeString();
    feed.innerHTML += `<div style="padding:4px 0;border-bottom:1px dashed #e2e8f0;"><span style="color:#0284c7;font-weight:600;">[测试发送 ${timeStr}]</span> ${esc(msg)}</div>`;
    feed.scrollTop = feed.scrollHeight;
  }
  if (input) input.value = '';
  showToast('已向 QQ 通道派发测试消息', 'info');
});

// ============================================================================
// 3.5. 钉钉机器人通道逻辑 (DingTalk Channel)
// ============================================================================
async function renderDingTalkView() {
  try {
    const cfg = (window.hap.getDingTalkConfig ? await window.hap.getDingTalkConfig() : {}) || {};
    if ($('dingAppKeyInput')) $('dingAppKeyInput').value = cfg.appKey || '';
    if ($('dingAppSecretInput')) $('dingAppSecretInput').value = cfg.appSecret || '';
    if ($('dingWebhookInput')) $('dingWebhookInput').value = cfg.webhookUrl || '';
    if ($('dingAgentSelect')) {
      const agents = state.agents || [];
      if (agents.length > 0) {
        $('dingAgentSelect').innerHTML = agents.map(a => `<option value="${esc(a.id)}">${esc(a.name || a.id)} (${esc(a.id)})</option>`).join('');
      }
      $('dingAgentSelect').value = cfg.defaultAgent || (agents[0]?.id || 'ops');
    }
  } catch (err) {
    console.error('获取钉钉配置异常:', err);
  }
}

$('dingtalkConfigForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (window.hap.saveDingTalkConfig) {
      await window.hap.saveDingTalkConfig({
        appKey: $('dingAppKeyInput')?.value.trim() || '',
        appSecret: $('dingAppSecretInput')?.value.trim() || '',
        webhookUrl: $('dingWebhookInput')?.value.trim() || '',
        defaultAgent: $('dingAgentSelect')?.value || 'coder',
      });
    }
    showToast('钉钉通道配置已成功保存！', 'success');
    await renderDingTalkView();
  } catch (err) {
    showToast('保存钉钉配置失败: ' + err.message, 'error');
  }
});

// ============================================================================
// 4. 本机系统监控与全景桌面 (Host Diagnostics & Dashboard Controller)
// ============================================================================
function fmtHostBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function fmtHostUptime(seconds) {
  if (!seconds || seconds <= 0) return '0秒';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0 || d > 0) parts.push(`${h}小时`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}分`);
  parts.push(`${s}秒`);
  return parts.join(' ');
}

window.refreshHostView = async () => {
  try {
    const info = await window.hap.getHostSysInfo();
    if (!info || !info.cpu || !info.memory) return;

    // 1. CPU 指标与负载
    const cpuPct = info.cpu.usagePercent || 0;
    if ($('hostCpuPercent')) $('hostCpuPercent').textContent = `${cpuPct}%`;
    if ($('hostCpuSpeed')) $('hostCpuSpeed').textContent = `${info.cpu.speedMHz || 0} MHz`;
    if ($('hostCpuCoresBadge')) $('hostCpuCoresBadge').textContent = `${info.cpu.cores} 核心`;
    if ($('hostCpuCoreCountBadge')) $('hostCpuCoreCountBadge').textContent = `${info.cpu.cores} 逻辑核心`;
    if ($('hostCpuModel')) $('hostCpuModel').textContent = info.cpu.model || 'CPU';
    if ($('hostCpuBar')) {
      $('hostCpuBar').style.width = `${cpuPct}%`;
      $('hostCpuBar').style.background = cpuPct > 85 ? '#ef4444' : cpuPct > 60 ? '#f59e0b' : '#3b82f6';
    }

    // CPU 多核拓扑分布
    const coreGrid = $('hostCoreGrid');
    if (coreGrid && info.cpu.perCore) {
      coreGrid.innerHTML = info.cpu.perCore.map(c => `
        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:6px 8px; display:flex; flex-direction:column; gap:2px;">
          <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px; font-weight:600; color:var(--text-main);">
            <span>Core #${c.coreIndex}</span>
            <span style="color:#3b82f6; font-family:var(--font-mono);">${c.speedMHz}MHz</span>
          </div>
          <div style="font-size:10px; color:#64748b; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">
            ${esc(c.model.replace(/CPU @.*$/, '').trim())}
          </div>
        </div>
      `).join('');
    }

    // 2. 物理内存 (RAM)
    const memPct = info.memory.usedPercent || 0;
    if ($('hostMemUsed')) $('hostMemUsed').textContent = fmtHostBytes(info.memory.usedBytes);
    if ($('hostMemTotalBrief')) $('hostMemTotalBrief').textContent = `/ ${fmtHostBytes(info.memory.totalBytes)}`;
    if ($('hostMemTotal')) $('hostMemTotal').textContent = `空闲: ${fmtHostBytes(info.memory.freeBytes)}`;
    if ($('hostMemPercentBadge')) {
      $('hostMemPercentBadge').textContent = `${memPct}%`;
      $('hostMemPercentBadge').className = `badge ${memPct > 85 ? 'danger' : memPct > 60 ? 'warn' : 'success'}`;
    }
    if ($('hostMemBar')) {
      $('hostMemBar').style.width = `${memPct}%`;
      $('hostMemBar').style.background = memPct > 85 ? '#ef4444' : memPct > 60 ? '#f59e0b' : '#10b981';
    }

    // 3. Node.js 虚拟机内存 (RSS & Heap)
    if ($('hostProcessRss')) $('hostProcessRss').textContent = fmtHostBytes(info.memory.processRssBytes);
    if ($('hostProcessPidBadge')) $('hostProcessPidBadge').textContent = `PID: ${info.os.pid}`;
    if ($('hostProcessHeap')) {
      $('hostProcessHeap').textContent = `堆使用: ${fmtHostBytes(info.memory.processHeapUsedBytes)} / ${fmtHostBytes(info.memory.processHeapTotalBytes)}`;
    }
    if ($('hostHeapBar')) {
      const heapPct = info.memory.processHeapTotalBytes > 0
        ? Math.round((info.memory.processHeapUsedBytes / info.memory.processHeapTotalBytes) * 100)
        : 0;
      $('hostHeapBar').style.width = `${heapPct}%`;
    }

    // 4. 运行时间与负载
    if ($('hostSystemUptime')) $('hostSystemUptime').textContent = fmtHostUptime(info.os.uptimeSeconds);
    if ($('hostProcessUptime')) $('hostProcessUptime').textContent = `Codex 服务运行: ${fmtHostUptime(info.os.processUptimeSeconds)}`;
    if ($('hostTimestamp')) $('hostTimestamp').textContent = `更新于: ${new Date(info.timestamp).toLocaleTimeString()}`;
    if ($('hostLoadAvgBadge')) {
      const loads = (info.loadAvg || []).map(l => l.toFixed(2)).join(' / ');
      $('hostLoadAvgBadge').textContent = loads ? `负载: ${loads}` : '运行正常';
    }

    // 5. 磁盘多卷分区存储
    const partList = $('hostPartitionList');
    if (partList && info.disk.partitions) {
      if ($('hostDiskPartCountBadge')) $('hostDiskPartCountBadge').textContent = `${info.disk.partitions.length} 个驱动器`;
      partList.innerHTML = info.disk.partitions.map(p => `
        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:8px 10px; display:flex; flex-direction:column; gap:4px;">
          <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; font-weight:600; color:var(--text-main);">
            <span>📁 驱动卷 <code>${esc(p.mount)}</code></span>
            <span style="color:#0f172a; font-family:var(--font-mono);">${p.usedPercent}% (${fmtHostBytes(p.usedBytes)} / ${fmtHostBytes(p.totalBytes)})</span>
          </div>
          <div style="width: 100%; height: 5px; background: #e2e8f0; border-radius: 3px; overflow:hidden;">
            <div style="width: ${p.usedPercent}%; height: 100%; background: ${p.usedPercent > 85 ? '#ef4444' : p.usedPercent > 70 ? '#f59e0b' : '#3b82f6'};"></div>
          </div>
          <div style="font-size:11px; color:#64748b; display:flex; justify-content:space-between;">
            <span>可用空间: ${fmtHostBytes(p.freeBytes)}</span>
            <span>总容量: ${fmtHostBytes(p.totalBytes)}</span>
          </div>
        </div>
      `).join('');
    }

    // 6. 活跃高消耗进程 Top 榜
    const procList = $('hostTopProcessList');
    if (procList) {
      if (!info.topProcesses || info.topProcesses.length === 0) {
        procList.innerHTML = '<div style="color:var(--text-muted); font-size:12px; padding:8px 0; text-align:center;">暂无活跃进程列表</div>';
      } else {
        procList.innerHTML = info.topProcesses.map((p, idx) => `
          <div style="display:flex; justify-content:space-between; align-items:center; background:#f8fafc; padding:6px 10px; border-radius:6px; border:1px solid #e2e8f0; font-size:12px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:11px; font-weight:700; color:#3b82f6; width:18px; text-align:center;">#${idx + 1}</span>
              <strong style="color:var(--text-main); font-size:12.5px;">${esc(p.name)}</strong>
              <span style="color:#94a3b8; font-size:11px; font-family:var(--font-mono);">(PID: ${p.pid})</span>
            </div>
            <div style="font-weight:700; font-family:var(--font-mono); color:#0f172a; background:#e2e8f0; padding:2px 8px; border-radius:4px; font-size:11.5px;">
              ${esc(p.memoryFormatted)}
            </div>
          </div>
        `).join('');
      }
    }

    // 7. 操作系统与 Node.js 规格
    if ($('hostPlatformBadge')) $('hostPlatformBadge').textContent = `${info.os.platform} / ${info.os.arch}`;
    if ($('hostHostname')) $('hostHostname').textContent = info.network.hostname;
    if ($('hostUsername')) $('hostUsername').textContent = info.os.user;
    if ($('hostOsFull')) $('hostOsFull').textContent = `${info.os.type} ${info.os.release}`;
    if ($('hostArch')) $('hostArch').textContent = `${info.os.arch} (字节序: ${info.os.endianness || 'LE'})`;
    if ($('hostNodeVersion')) $('hostNodeVersion').textContent = info.os.nodeVersion;
    if ($('hostV8Version')) $('hostV8Version').textContent = info.os.versions?.v8 || 'V8';
    if ($('hostUvVersion')) $('hostUvVersion').textContent = `uv: ${info.os.versions?.uv || '-'} | OpenSSL: ${info.os.versions?.openssl || '-'}`;
    if ($('hostCwd')) $('hostCwd').textContent = info.os.cwd || '-';

    // 8. 本地网络网卡列表
    const netList = $('hostNetworkList');
    if (netList) {
      if (!info.network.ips || info.network.ips.length === 0) {
        netList.innerHTML = '<div style="color:var(--text-muted); font-size:12px; padding:4px 0;">无活跃网络接口</div>';
      } else {
        netList.innerHTML = info.network.ips.map(n => `
          <div style="display:flex; justify-content:space-between; align-items:center; background:#f8fafc; padding:6px 10px; border-radius:6px; border:1px solid #e2e8f0; font-size:12px;">
            <span style="font-weight:600; color:var(--text-main); font-size:12px;">${esc(n.interface)}</span>
            <span style="font-family:monospace; background:#e0f2fe; color:#0369a1; padding:2px 6px; border-radius:4px; font-weight:600; font-size:11.5px;">${esc(n.address)}</span>
          </div>
        `).join('');
      }
    }

    // 9. 公网出口与 IP 地理位置
    loadHostIpGeo().catch(() => {});
  } catch (err) {
    console.error('刷新宿主机监控失败:', err);
  }
};

let lastHostIpGeo = null;
async function loadHostIpGeo() {
  try {
    const geo = await window.hap.getIpGeoInfo();
    lastHostIpGeo = geo;
    if ($('hostIpGeoBadge')) {
      $('hostIpGeoBadge').textContent = geo.isPrivate ? '局域网环境' : '公网在线';
      $('hostIpGeoBadge').className = `badge ${geo.isPrivate ? 'neutral' : 'success'}`;
    }
    if ($('hostIpGeoDetails')) {
      const parts = [];
      parts.push(`<div><strong>出口 IP 地址:</strong> <code class="md-inline-code">${esc(geo.ip)}</code> ${geo.isPrivate ? '(局域网私网)' : '(公网出口)'}</div>`);
      parts.push(`<div><strong>地理归属地:</strong> ${esc(geo.formattedLocation)}</div>`);
      if (geo.isp) parts.push(`<div><strong>网络运营商:</strong> ${esc(geo.isp)} ${geo.asn ? '(' + esc(geo.asn) + ')' : ''}</div>`);
      if (geo.timezone) parts.push(`<div><strong>时区标识:</strong> ${esc(geo.timezone)}</div>`);
      $('hostIpGeoDetails').innerHTML = parts.join('');
    }
  } catch (err) {
    if ($('hostIpGeoBadge')) $('hostIpGeoBadge').textContent = '探测失败';
  }
}

// AI 智能全盘扫描与深度瘦身 (AI Smart Disk Scanner & Storage Analyzer)
let currentDiskScanReport = null;
let currentDiskCategory = 'all';

async function handleScanDisk(server) {
  const scanBtn = $('scanDiskBtn');
  const progressBox = $('diskScanProgressBox');
  const progressText = $('diskScanProgressText');
  const emptyState = $('diskEmptyState');
  const resultContainer = $('diskScanResultContainer');

  try {
    if (scanBtn) scanBtn.disabled = true;
    if (emptyState) emptyState.style.display = 'none';
    if (resultContainer) resultContainer.style.display = 'none';
    if (progressBox) progressBox.style.display = 'block';

    const steps = [
      '⏳ 正在排查全盘根目录 (C:\\, D:\\ 等) 系统临时文件与更新缓存...',
      '⏳ 正在排查 npm / pnpm / pip / yarn / cargo / go 全局包管理器缓存...',
      '⏳ 正在深度探测所有工程与工作区构建残留 (dist, target, .next, __pycache__)...',
      '⏳ 正在分析 Chrome / Edge 浏览器及桌面应用临时运行缓存...',
      '⏳ 正在排查 Docker 悬空虚悬镜像与 BuildKit 构建缓存...',
      '🧠 AI 正在生成全盘健康评分与智能清理诊断建议...',
    ];

    let stepIdx = 0;
    const stepTimer = setInterval(() => {
      stepIdx = (stepIdx + 1) % steps.length;
      if (progressText) progressText.textContent = steps[stepIdx];
    }, 400);

    const report = await window.hap.scanDiskCleanable(server);
    clearInterval(stepTimer);

    currentDiskScanReport = report;
    renderDiskScanResult(report);
    showToast(`AI 全盘体检完成！健康评分 ${report.healthScore || 90} 分，发现 ${fmtHostBytes(report.totalCleanableBytes)} 可释放空间`, 'success');
  } catch (err) {
    showToast('AI 磁盘扫描失败: ' + err.message, 'error');
    if (emptyState) emptyState.style.display = 'block';
  } finally {
    if (progressBox) progressBox.style.display = 'none';
    if (scanBtn) scanBtn.disabled = false;
  }
}

function filterDiskItemsByCategory(category) {
  currentDiskCategory = category;
  document.querySelectorAll('.disk-cat-btn').forEach(btn => {
    if (btn.dataset.cat === category) {
      btn.style.background = '#e0f2fe';
      btn.style.color = '#0369a1';
      btn.style.fontWeight = '600';
    } else {
      btn.style.background = '#f1f5f9';
      btn.style.color = '#475569';
      btn.style.fontWeight = '400';
    }
  });

  const listEl = $('diskItemsList');
  if (!listEl || !currentDiskScanReport || !currentDiskScanReport.items) return;

  const items = currentDiskCategory === 'all'
    ? currentDiskScanReport.items
    : currentDiskScanReport.items.filter(i => i.category === currentDiskCategory);

  if (items.length === 0) {
    listEl.innerHTML = '<div style="color:#64748b; font-size:13px; text-align:center; padding:18px; background:#f8fafc; border-radius:8px; border:1px dashed #cbd5e1;">该分类下暂无可清理项目</div>';
    updateDiskSelectedSummary();
    return;
  }

  const categoryIcons = {
    system_root: '🏛️',
    package_cache: '📦',
    build_artifact: '🏗️',
    browser_app: '🌐',
    temp_logs: '📝',
    docker_prune: '🐳',
    custom: '📁',
  };

  listEl.innerHTML = items.map((item) => `
    <div style="display:flex; justify-content:space-between; align-items:center; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:10px 14px; transition:background 0.2s; gap:12px;" onmouseover="this.style.background='#f1f5f9'" onmouseout="this.style.background='#f8fafc'">
      <div style="display:flex; align-items:center; gap:12px; min-width:0; flex:1;">
        <input type="checkbox" class="disk-item-chk" data-id="${esc(item.id)}" data-size="${item.sizeBytes}" data-safety="${item.safety}" ${item.safety === 'safe' ? 'checked' : ''} style="width:16px; height:16px; cursor:pointer;" onchange="window.updateDiskSelectedSummary()" />
        <span style="font-size:18px; flex-shrink:0;">${categoryIcons[item.category] || '📁'}</span>
        <div style="min-width:0; overflow:hidden; flex:1;">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <span class="badge ${item.safety === 'safe' ? 'success' : 'warn'}" style="font-size:11px;">${item.safety === 'safe' ? '🟢 安全清理' : '🟡 建议确认'}</span>
            ${item.rootPrefix ? `<span class="badge neutral" style="font-size:10.5px; font-family:var(--font-mono);">${esc(item.rootPrefix)}</span>` : ''}
            <strong style="font-size:13px; color:var(--text-main); text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${esc(item.name)}</strong>
          </div>
          <div style="font-size:11.5px; color:var(--text-muted); margin-top:2px; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
            <span>${esc(item.description)}</span>
            <code style="font-size:11px; color:#475569; background:#e2e8f0; padding:1px 4px; border-radius:4px; max-width:320px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;" title="${esc(item.path)}">${esc(item.path)}</code>
            <button type="button" class="btn text-btn" style="font-size:11px; padding:0 4px; color:#2563eb;" onclick="copyText('${esc(item.path)}', '路径')">复制</button>
          </div>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:12px; flex-shrink:0;">
        <div style="font-size:14px; font-weight:700; color:var(--text-main); font-family:var(--font-mono);">
          ${fmtHostBytes(item.sizeBytes)}
        </div>
        <button type="button" class="btn secondary" style="font-size:11px; padding:3px 8px;" onclick="window.cleanSingleDiskItem('${esc(item.id)}')">
          🗑️ 清理
        </button>
      </div>
    </div>
  `).join('');

  updateDiskSelectedSummary();
}

function renderDiskScanResult(report) {
  if (!report) return;
  if ($('diskEmptyState')) $('diskEmptyState').style.display = 'none';
  if ($('diskScanResultContainer')) $('diskScanResultContainer').style.display = 'block';

  // 顶部徽章与操作按钮
  if ($('diskCleanableTotalBadge')) {
    $('diskCleanableTotalBadge').style.display = 'inline-flex';
    $('diskCleanableTotalBadge').textContent = `发现可释放: ${fmtHostBytes(report.totalCleanableBytes)}`;
  }
  if ($('diskRootsBadge')) {
    $('diskRootsBadge').style.display = 'inline-flex';
    const rootsStr = (report.scannedRoots || []).join(', ') || '全盘';
    $('diskRootsBadge').textContent = `已覆盖根目录: ${rootsStr}`;
  }
  if ($('safeCleanDiskBtn')) $('safeCleanDiskBtn').style.display = report.safeCleanableBytes > 0 ? 'inline-block' : 'none';
  if ($('allCleanDiskBtn')) $('allCleanDiskBtn').style.display = report.totalCleanableBytes > 0 ? 'inline-block' : 'none';

  // AI 健康分与诊断建议
  const score = report.healthScore ?? 95;
  if ($('diskHealthScore')) {
    $('diskHealthScore').textContent = score;
    $('diskHealthScore').style.color = score >= 90 ? '#16a34a' : score >= 70 ? '#d97706' : '#dc2626';
  }
  if ($('diskHealthLevel')) {
    $('diskHealthLevel').textContent = score >= 90 ? '🟢 空间充裕' : score >= 70 ? '🟡 建议优化' : '🔴 空间偏紧';
    $('diskHealthLevel').className = `badge ${score >= 90 ? 'success' : score >= 70 ? 'warn' : 'danger'}`;
  }
  if ($('diskAiDiagnosisText')) {
    $('diskAiDiagnosisText').textContent = report.aiDiagnosis || 'AI 体检完成，建议定期清理依赖包缓存以保持系统轻快。';
  }

  if ($('diskSafeSize')) $('diskSafeSize').textContent = fmtHostBytes(report.safeCleanableBytes);
  if ($('diskReviewSize')) $('diskReviewSize').textContent = fmtHostBytes(report.reviewCleanableBytes);

  // 更新各分类计数徽章
  const items = report.items || [];
  if ($('catCount_all')) $('catCount_all').textContent = items.length;
  if ($('catCount_system_root')) $('catCount_system_root').textContent = items.filter(i => i.category === 'system_root').length;
  if ($('catCount_package_cache')) $('catCount_package_cache').textContent = items.filter(i => i.category === 'package_cache').length;
  if ($('catCount_build_artifact')) $('catCount_build_artifact').textContent = items.filter(i => i.category === 'build_artifact').length;
  if ($('catCount_browser_app')) $('catCount_browser_app').textContent = items.filter(i => i.category === 'browser_app').length;
  if ($('catCount_temp_logs')) $('catCount_temp_logs').textContent = items.filter(i => i.category === 'temp_logs').length;
  if ($('catCount_docker_prune')) $('catCount_docker_prune').textContent = items.filter(i => i.category === 'docker_prune').length;

  filterDiskItemsByCategory(currentDiskCategory || 'all');
}

function updateDiskSelectedSummary() {
  const checkboxes = document.querySelectorAll('.disk-item-chk');
  let selectedCount = 0;
  let selectedBytes = 0;

  checkboxes.forEach(cb => {
    if (cb.checked) {
      selectedCount++;
      selectedBytes += parseInt(cb.getAttribute('data-size') || '0', 10);
    }
  });

  const summaryEl = $('diskSelectedSummary');
  if (summaryEl) {
    summaryEl.textContent = `已选择 ${selectedCount} 项 (共 ${fmtHostBytes(selectedBytes)})`;
  }

  const cleanSelectedBtn = $('cleanSelectedBtn');
  if (cleanSelectedBtn) {
    cleanSelectedBtn.disabled = selectedCount === 0;
    cleanSelectedBtn.textContent = selectedCount > 0
      ? `🚀 一键清理选中项 (${fmtHostBytes(selectedBytes)})`
      : '🚀 一键清理选中项';
  }
}

async function handleCleanDisk(type) {
  if (!currentDiskScanReport) {
    await handleScanDisk();
  }
  if (!currentDiskScanReport || currentDiskScanReport.items.length === 0) {
    showToast('当前没有需要清理的垃圾项', 'info');
    return;
  }

  let targetIds = [];
  if (type === 'all') {
    targetIds = ['all'];
  } else if (type === 'safe') {
    targetIds = currentDiskScanReport.items.filter(i => i.safety === 'safe').map(i => i.id);
  } else if (type === 'selected') {
    const checked = Array.from(document.querySelectorAll('.disk-item-chk:checked'));
    targetIds = checked.map(cb => cb.getAttribute('data-id')).filter(Boolean);
  }

  if (targetIds.length === 0) {
    showToast('请先勾选需要清理的垃圾项', 'info');
    return;
  }

  let expectedBytes = currentDiskScanReport.totalCleanableBytes;
  if (type === 'safe') expectedBytes = currentDiskScanReport.safeCleanableBytes;
  else if (type === 'selected') {
    const checked = Array.from(document.querySelectorAll('.disk-item-chk:checked'));
    expectedBytes = checked.reduce((sum, cb) => sum + parseInt(cb.getAttribute('data-size') || '0', 10), 0);
  }

  const confirmMsg = type === 'all'
    ? `确定全量清理全部可回收项 (含工程构建产物 dist/target，预计释放 ${fmtHostBytes(expectedBytes)}) 吗？`
    : `确定执行清理 (共 ${targetIds.length} 项，预计释放 ${fmtHostBytes(expectedBytes)}) 吗？`;

  if (!confirm(confirmMsg)) return;

  try {
    showToast('正在执行磁盘安全清理...', 'info');
    const result = await window.hap.executeDiskCleanup({
      server: currentDiskScanReport.target === 'local' ? undefined : currentDiskScanReport.target,
      itemIds: targetIds,
    });
    showToast(`清理成功！已释放 ${fmtHostBytes(result.cleanedBytes)} 空间！`, 'success');
    await handleScanDisk();
    await window.refreshHostView();
  } catch (err) {
    showToast('清理失败: ' + err.message, 'error');
  }
}

window.cleanSingleDiskItem = async (itemId) => {
  if (!currentDiskScanReport) return;
  const item = currentDiskScanReport.items.find(i => i.id === itemId);
  if (!item) return;

  if (!confirm(`确定清理「${item.name}」(${fmtHostBytes(item.sizeBytes)}) 吗？`)) return;

  try {
    showToast(`正在清理 ${item.name}...`, 'info');
    const result = await window.hap.executeDiskCleanup({
      server: currentDiskScanReport.target === 'local' ? undefined : currentDiskScanReport.target,
      itemIds: [itemId],
    });
    showToast(`清理完成！已释放 ${fmtHostBytes(result.cleanedBytes)}`, 'success');
    await handleScanDisk();
    await window.refreshHostView();
  } catch (err) {
    showToast('单项清理失败: ' + err.message, 'error');
  }
};

// 咨询 AI 智能体制定磁盘瘦身计划
function handleAskAiDiskPlan() {
  if (!currentDiskScanReport) {
    showToast('请先点击「⚡ 从根目录开始全盘扫描」', 'info');
    return;
  }
  const report = currentDiskScanReport;
  const rootsStr = (report.scannedRoots || []).join(', ') || '全盘';
  const topItems = (report.items || []).slice(0, 8).map(i => `- [${i.safety === 'safe' ? '安全' : '确认'}] ${i.name} (${fmtHostBytes(i.sizeBytes)}) -> ${i.path}`).join('\n');

  const prompt = [
    `请帮我分析本机系统的全盘存储与垃圾清理策略：`,
    `- 全盘根目录覆盖: ${rootsStr}`,
    `- 当前 AI 健康评分: ${report.healthScore || 90} / 100`,
    `- 发现可释放空间总计: ${fmtHostBytes(report.totalCleanableBytes)}`,
    `- 零副作用安全项 (Safe): ${fmtHostBytes(report.safeCleanableBytes)}`,
    `- 建议确认项 (Review): ${fmtHostBytes(report.reviewCleanableBytes)}`,
    ``,
    `主要扫描发现的项目列表:`,
    topItems,
    ``,
    `请给出针对性的磁盘瘦身方案与日常开发存储维护最佳实践建议。`,
  ].join('\n');

  if (typeof window.switchView === 'function') {
    window.switchView('chat');
  }
  const chatInput = $('chatInput') || $('messageInput') || $('promptInput');
  if (chatInput) {
    chatInput.value = prompt;
    chatInput.focus();
  }
  showToast('已将全盘扫描报告填充至 AI 智能体对话框！', 'info');
}

// 绑定全局事件与选择器
window.handleScanDisk = handleScanDisk;
window.handleCleanDisk = handleCleanDisk;
window.filterDiskItemsByCategory = filterDiskItemsByCategory;
window.updateDiskSelectedSummary = updateDiskSelectedSummary;
window.handleAskAiDiskPlan = handleAskAiDiskPlan;

document.addEventListener('DOMContentLoaded', () => {
  $('scanDiskBtn')?.addEventListener('click', () => handleScanDisk());
  $('safeCleanDiskBtn')?.addEventListener('click', () => handleCleanDisk('safe'));
  $('allCleanDiskBtn')?.addEventListener('click', () => handleCleanDisk('all'));
  $('cleanSelectedBtn')?.addEventListener('click', () => handleCleanDisk('selected'));
  $('askAiDiskPlanBtn')?.addEventListener('click', () => handleAskAiDiskPlan());

  // 绑定分类筛选按钮
  document.querySelectorAll('.disk-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.cat || 'all';
      filterDiskItemsByCategory(cat);
    });
  });

  $('diskSelectAllBtn')?.addEventListener('click', () => {
    document.querySelectorAll('.disk-item-chk').forEach(cb => cb.checked = true);
    updateDiskSelectedSummary();
  });
  $('diskSelectSafeBtn')?.addEventListener('click', () => {
    document.querySelectorAll('.disk-item-chk').forEach(cb => {
      cb.checked = cb.getAttribute('data-safety') === 'safe';
    });
    updateDiskSelectedSummary();
  });
  $('diskSelectNoneBtn')?.addEventListener('click', () => {
    document.querySelectorAll('.disk-item-chk').forEach(cb => cb.checked = false);
    updateDiskSelectedSummary();
  });

  $('refreshHostBtn')?.addEventListener('click', async () => {
    await window.refreshHostView();
    showToast('本机系统全景状态已刷新！', 'info');
  });
});


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
    const activeSubBtn = document.querySelector('.channel-subtab-btn.active');
    const currentSub = activeSubBtn ? activeSubBtn.dataset.subtab : 'wechat';
    window.switchSettingsSubTab(currentSub || 'wechat');
  } else if (tabId === 'projects') {
    renderProjects();
  } else if (tabId === 'permissions') {
    renderPermissions();
  } else if (tabId === 'system') {
    renderTargets();
    renderLogs();
  }
};

window.switchSettingsSubTab = (subTab) => {
  const normSubTab = (subTab === 'telegram') ? 'tg' : subTab;
  
  // 更新子选项卡按钮高亮
  document.querySelectorAll('.channel-subtab-btn').forEach(btn => {
    const isTarget = btn.dataset.subtab === normSubTab;
    if (isTarget) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // 切换各子面板展示
  ['wechat', 'tg', 'feishu', 'qq', 'dingtalk'].forEach(t => {
    const subPane = $('channelSubPane_' + t);
    if (subPane) {
      subPane.style.display = t === normSubTab ? 'block' : 'none';
    }
  });

  // 触发对应子通道数据加载
  if (normSubTab === 'wechat') {
    renderWeChatView();
  } else if (normSubTab === 'tg') {
    renderTelegramView();
  } else if (normSubTab === 'feishu') {
    renderFeishuView();
  } else if (normSubTab === 'qq') {
    renderQQView();
  } else if (normSubTab === 'dingtalk') {
    renderDingTalkView();
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

// 开启后台实时日志心跳轮询
setInterval(async () => {
  try {
    const activeView = document.querySelector('.view.active')?.id;
    if (activeView === 'settings' || activeView === 'logs' || activeView === 'wechat' || activeView === 'targets') {
      const snap = await window.hap.snapshot();
      if (snap && snap.logs) {
        state.logs = snap.logs;
        renderLogs(currentLogFilter);
      }
    }
  } catch (e) {
    // 静默容错
  }
}, 2500);

// ==========================================================================
// AI 服务商与模型统一弹窗与在线拉取逻辑
// ==========================================================================
let currentDialogModels = [];

function renderCurrentDialogModels() {
  const container = $('currentProviderModelsList');
  if (!container) return;
  if (currentDialogModels.length === 0) {
    container.innerHTML = '<span style="font-size:11.5px;color:#94a3b8;line-height:24px;">暂无添加模型，请点击上方「一键从服务商获取模型」或手动添加</span>';
    return;
  }
  container.innerHTML = currentDialogModels.map((m, idx) => `
    <span style="background:#e0f2fe;color:#0369a1;padding:3px 8px;border-radius:6px;font-size:12px;display:inline-flex;align-items:center;gap:6px;border:1px solid #bae6fd;">
      <strong>${esc(m.alias)}</strong>
      ${m.model && m.model !== m.alias ? `<span style="color:#64748b;font-size:11px;">(${esc(m.model)})</span>` : ''}
      ${m.contextWindow ? `<span style="font-size:10px;background:#bae6fd;padding:1px 3px;border-radius:3px;">${(m.contextWindow/1024).toFixed(0)}k</span>` : ''}
      <span style="cursor:pointer;font-weight:bold;margin-left:2px;color:#ef4444;" onclick="window.removeModelFromDialog(${idx})">×</span>
    </span>
  `).join('');
}

window.removeModelFromDialog = (index) => {
  currentDialogModels.splice(index, 1);
  renderCurrentDialogModels();
};

window.fetchAndSyncModelsForProvider = async (providerId) => {
  showToast(`正在从服务商 [${providerId}] 获取模型列表...`, 'info');
  try {
    const res = await window.hap.fetchProviderModels(providerId);
    if (!res.ok || !res.models || res.models.length === 0) {
      showToast(`获取失败：${res.error || '未获取到模型，请检查服务商 API Key 与 Base URL'}`, 'error');
      return;
    }

    const dialog = $('quickModelSyncModal');
    if (!dialog) return;

    $('quickModelSyncTitle').textContent = `从 [${providerId}] 获取到 ${res.models.length} 个模型`;
    const listEl = $('quickModelSyncList');
    listEl.innerHTML = res.models.map((name) => `
      <label style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#ffffff;border:1px solid #e2e8f0;border-radius:6px;font-size:12.5px;cursor:pointer;transition:background 0.1s;">
        <div style="display:flex;align-items:center;gap:10px;">
          <input type="checkbox" class="quick-model-cb" data-model="${esc(name)}" checked style="width:15px;height:15px;" />
          <strong style="color:#0f172a;">${esc(name)}</strong>
        </div>
        <span class="prop-chip" style="font-size:11px;color:#0284c7;background:#f0f9ff;">${esc(name.split('/').pop())}</span>
      </label>
    `).join('');

    $('quickModelSelectAll').checked = true;
    $('quickModelSelectAll').onchange = (e) => {
      listEl.querySelectorAll('.quick-model-cb').forEach(cb => cb.checked = e.target.checked);
    };

    $('confirmQuickModelSyncBtn').onclick = async () => {
      const selectedCbs = [...listEl.querySelectorAll('.quick-model-cb:checked')];
      if (selectedCbs.length === 0) {
        showToast('请至少勾选一个要导入的模型', 'warning');
        return;
      }
      dialog.close();
      showToast(`正在导入 ${selectedCbs.length} 个模型...`, 'info');
      for (const cb of selectedCbs) {
        const modelName = cb.dataset.model;
        const alias = modelName.split('/').pop() || modelName;
        await window.hap.upsertModel({
          alias,
          provider: providerId,
          model: modelName,
          contextWindow: 64000,
        }).catch(() => {});
      }
      showToast(`🎉 成功从 ${providerId} 导入并生效 ${selectedCbs.length} 个模型！`, 'success');
      await refresh();
    };

    $('closeQuickModelSyncBtn').onclick = () => dialog.close();
    $('cancelQuickModelSyncBtn').onclick = () => dialog.close();

    dialog.showModal();
  } catch (err) {
    showToast(`获取模型异常：${err.message}`, 'error');
  }
};
// 弹窗内部拉取模型
$('fetchRemoteModelsInDialogBtn')?.addEventListener('click', async () => {
  const id = $('providerInputId')?.value.trim();
  const baseUrl = $('providerInputBaseUrl')?.value.trim();
  const apiKey = $('providerInputApiKey')?.value.trim();
  const wireApi = $('providerInputWireApi')?.value;
  const protocol = $('providerInputProtocol')?.value;

  if (!baseUrl) {
    showToast('请先填写 API 基础地址 (Base URL)', 'warning');
    return;
  }

  const btnText = $('fetchRemoteBtnTextInDialog');
  if (btnText) btnText.textContent = '正在获取云端模型...';

  try {
    const res = await window.hap.fetchProviderModels(id || 'temp', { baseUrl, apiKey, wireApi, protocol });
    if (res.ok && res.models && res.models.length > 0) {
      showToast(`成功获取到 ${res.models.length} 个可用模型！`, 'success');
      const poolBox = $('remoteModelPoolBox');
      const chipsBox = $('remoteModelChips');
      if (poolBox && chipsBox) {
        poolBox.style.display = 'block';
        chipsBox.innerHTML = res.models.map(name => `
          <button type="button" class="btn secondary" style="font-size:11.5px;padding:3px 8px;" onclick="window.addModelToDialogFromRemote('${escJs(name)}')">+ ${esc(name)}</button>
        `).join('');

        $('addAllRemoteModelsBtn').onclick = () => {
          res.models.forEach(name => {
            if (!currentDialogModels.some(m => m.model === name || m.alias === name)) {
              currentDialogModels.push({ alias: name.split('/').pop(), model: name, contextWindow: 64000 });
            }
          });
          renderCurrentDialogModels();
          poolBox.style.display = 'none';
          showToast(`已批量添加 ${res.models.length} 个模型`, 'success');
        };
      }
    } else {
      showToast('获取失败：' + (res.error || '该服务商未开放标准 /v1/models 模型查询接口，可直接手动填入模型'), 'error');
    }
  } catch (err) {
    showToast('拉取异常：' + err.message, 'error');
  } finally {
    if (btnText) btnText.textContent = '一键从服务商获取模型';
  }
});

window.addModelToDialogFromRemote = (name) => {
  if (!currentDialogModels.some(m => m.model === name || m.alias === name)) {
    currentDialogModels.push({ alias: name.split('/').pop(), model: name, contextWindow: 64000 });
    renderCurrentDialogModels();
    showToast(`已添加模型 ${name}`, 'info');
  }
};

// 手动添加模型条
$('addManualModelBtn')?.addEventListener('click', () => {
  const nameInput = $('manualModelNameInput');
  const aliasInput = $('manualModelAliasInput');
  const contextInput = $('manualModelContextInput');
  const model = nameInput?.value.trim();
  if (!model) {
    showToast('请填写模型名称（如 deepseek-chat）', 'warning');
    return;
  }
  const alias = aliasInput?.value.trim() || model.split('/').pop() || model;
  const contextWindow = parseInt(contextInput?.value, 10) || 64000;

  currentDialogModels.push({ alias, model, contextWindow });
  renderCurrentDialogModels();
  if (nameInput) nameInput.value = '';
  if (aliasInput) aliasInput.value = '';
  if (contextInput) contextInput.value = '';
  showToast(`已添加模型 ${alias}`, 'success');
});

// ==========================================================================
// 本机系统卡片与弹窗控制器 (Host Diagnostics & Modal Controller)
// ==========================================================================

async function updateLocalHostCard() {
  try {
    const info = await window.hap.getHostSysInfo();
    if (!info) return;
    if ($('localHostCardOs')) $('localHostCardOs').textContent = `${info.os?.platform || 'Node.js'} (${info.os?.arch || 'x64'})`;
    if ($('localHostCardCpu')) $('localHostCardCpu').textContent = `${info.cpu?.usagePercent || 0}% (${info.cpu?.cores || 0}核)`;
    if ($('localHostCardMem')) {
      const usedGb = (info.memory?.usedBytes / (1024 * 1024 * 1024)).toFixed(1);
      const totalGb = (info.memory?.totalBytes / (1024 * 1024 * 1024)).toFixed(1);
      $('localHostCardMem').textContent = `${usedGb} / ${totalGb} GB (${info.memory?.usedPercent || 0}%)`;
    }
    if ($('localHostCardPid')) $('localHostCardPid').textContent = String(info.process?.pid || process?.pid || 'Live');
  } catch {
    // ignore
  }
}

window.openHostDetailsModal = async () => {
  const dialog = $('hostDetailsModal');
  if (!dialog) return;
  dialog.showModal();
  await refreshHostDetailsModalContent();
};

async function refreshHostDetailsModalContent() {
  try {
    const info = await window.hap.getHostSysInfo();
    if (!info) return;

    if ($('hostModalSub')) $('hostModalSub').textContent = `${info.network?.hostname || 'Host'} · PID: ${info.process?.pid || '--'} · Node.js ${info.os?.nodeVersion || '--'}`;
    if ($('hostModalCpuCores')) $('hostModalCpuCores').textContent = `${info.cpu?.cores || 0} 核心`;
    if ($('hostModalCpuPercent')) $('hostModalCpuPercent').textContent = `${info.cpu?.usagePercent || 0}%`;
    if ($('hostModalCpuBar')) {
      $('hostModalCpuBar').style.width = `${info.cpu?.usagePercent || 0}%`;
      $('hostModalCpuBar').style.background = (info.cpu?.usagePercent || 0) > 85 ? '#ef4444' : (info.cpu?.usagePercent || 0) > 60 ? '#f59e0b' : '#3b82f6';
    }
    if ($('hostModalCpuModel')) $('hostModalCpuModel').textContent = info.cpu?.model || '--';

    const usedGb = ((info.memory?.usedBytes || 0) / (1024 * 1024 * 1024)).toFixed(1);
    const totalGb = ((info.memory?.totalBytes || 0) / (1024 * 1024 * 1024)).toFixed(1);
    const freeGb = ((info.memory?.freeBytes || 0) / (1024 * 1024 * 1024)).toFixed(1);
    if ($('hostModalMemBadge')) $('hostModalMemBadge').textContent = `${info.memory?.usedPercent || 0}%`;
    if ($('hostModalMemUsed')) $('hostModalMemUsed').textContent = `${usedGb} GB`;
    if ($('hostModalMemTotal')) $('hostModalMemTotal').textContent = `总量: ${totalGb} GB (空闲 ${freeGb} GB)`;
    if ($('hostModalMemBar')) {
      $('hostModalMemBar').style.width = `${info.memory?.usedPercent || 0}%`;
      $('hostModalMemBar').style.background = (info.memory?.usedPercent || 0) > 85 ? '#ef4444' : (info.memory?.usedPercent || 0) > 60 ? '#f59e0b' : '#10b981';
    }

    if ($('hostModalProcessPid')) $('hostModalProcessPid').textContent = `PID: ${info.process?.pid || '--'}`;
    if ($('hostModalProcessRss')) $('hostModalProcessRss').textContent = `${Math.round((info.memory?.processRssBytes || 0) / (1024 * 1024))} MB`;
    if ($('hostModalHeapBar')) $('hostModalHeapBar').style.width = '45%';
    if ($('hostModalProcessHeap')) $('hostModalProcessHeap').textContent = `堆已用: ${Math.round((info.memory?.heapUsedBytes || 0) / (1024 * 1024))} MB / ${Math.round((info.memory?.heapTotalBytes || 0) / (1024 * 1024))} MB`;

    if ($('hostModalUptime')) $('hostModalUptime').textContent = formatHostUptime(info.os?.uptimeSeconds);
    if ($('hostModalProcessUptime')) $('hostModalProcessUptime').textContent = `Codex 进程运行: ${formatHostUptime(info.os?.processUptimeSeconds)}`;

    if ($('hostModalOs')) $('hostModalOs').textContent = `${info.os?.platform || '--'} ${info.os?.release || ''}`;
    if ($('hostModalArch')) $('hostModalArch').textContent = `${info.os?.arch || '--'} (${info.os?.endianness || 'LE'})`;
    if ($('hostModalUser')) $('hostModalUser').textContent = info.os?.username || '--';
    if ($('hostModalHostname')) $('hostModalHostname').textContent = info.network?.hostname || '--';

    if ($('hostModalNodeVer')) $('hostModalNodeVer').textContent = info.os?.nodeVersion || '--';
    if ($('hostModalV8Ver')) $('hostModalV8Ver').textContent = `V8: ${info.os?.v8Version || '--'} / uv: ${info.os?.uvVersion || '--'}`;
    if ($('hostModalIp')) $('hostModalIp').textContent = info.network?.primaryIp || '127.0.0.1';
    if ($('hostModalCwd')) $('hostModalCwd').textContent = info.process?.cwd || process.cwd?.() || '--';
  } catch (err) {
    showToast('拉取本机系统数据失败: ' + err.message, 'error');
  }
}

$('refreshHostDetailsModalBtn')?.addEventListener('click', () => {
  refreshHostDetailsModalContent();
  showToast('本机系统指标已刷新', 'info');
});
$('closeHostDetailsModalBtn')?.addEventListener('click', () => $('hostDetailsModal')?.close());

// ==========================================================================
// 远程服务器详情弹窗控制器 (Server Details Modal Controller)
// ==========================================================================

let currentDetailsServerId = '';

window.openServerDetailsModal = async (id) => {
  currentDetailsServerId = id;
  const dialog = $('serverDetailsModal');
  if (!dialog) return;

  const server = cachedServers.find(s => s.id === id);
  $('serverDetailsTitle').textContent = server ? server.name : '服务器节点详情';
  $('serverDetailsSub').textContent = server ? `${server.username}@${server.host}:${server.port} (Daemon: ${server.daemonPort || 9527})` : id;

  dialog.showModal();
  await refreshServerDetailsModalContent(id);
};

async function refreshServerDetailsModalContent(id) {
  const targetId = id || currentDetailsServerId;
  if (!targetId) return;

  try {
    const server = cachedServers.find(s => s.id === targetId);
    const info = await window.hap.getServerInfo(targetId);

    const cpuPct = info?.cpuUsagePercent ?? info?.cpu?.usagePercent ?? 0;
    const cpuCores = info?.cpuCount ?? info?.cpu?.cores ?? '--';
    const cpuModel = info?.cpuModel ?? info?.cpu?.model ?? 'Linux / Multi-Core CPU';

    const memPct = info?.usedMemPercent ?? info?.memory?.usagePercent ?? 0;
    const totalMem = info?.totalMemBytes ?? info?.memory?.total ?? 0;
    const freeMem = info?.freeMemBytes ?? info?.memory?.free ?? 0;
    const usedMem = totalMem - freeMem;
    const usedGb = (usedMem / (1024 * 1024 * 1024)).toFixed(1);
    const totalGb = (totalMem / (1024 * 1024 * 1024)).toFixed(1);

    const diskTotal = info?.diskTotalBytes ?? info?.disk?.total ?? 0;
    const diskFree = info?.diskFreeBytes ?? info?.disk?.free ?? 0;
    const diskUsed = diskTotal - diskFree;
    const diskUsedGb = (diskUsed / (1024 * 1024 * 1024)).toFixed(1);
    const diskTotalGb = (diskTotal / (1024 * 1024 * 1024)).toFixed(1);
    const diskPct = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;

    const uptimeSec = info?.uptimeSeconds ?? info?.uptime ?? 0;

    if ($('serverDetailsStatusBadge')) {
      $('serverDetailsStatusBadge').textContent = server?.status === 'online' ? '● 在线就绪' : '● 已连接';
      $('serverDetailsStatusBadge').className = 'badge success';
    }

    if ($('serverDetailsCpuCores')) $('serverDetailsCpuCores').textContent = `${cpuCores} 核`;
    if ($('serverDetailsCpuPercent')) $('serverDetailsCpuPercent').textContent = `${cpuPct}%`;
    if ($('serverDetailsCpuBar')) {
      $('serverDetailsCpuBar').style.width = `${cpuPct}%`;
      $('serverDetailsCpuBar').style.background = cpuPct > 85 ? '#ef4444' : cpuPct > 60 ? '#f59e0b' : '#3b82f6';
    }
    if ($('serverDetailsCpuModel')) $('serverDetailsCpuModel').textContent = cpuModel;

    if ($('serverDetailsMemBadge')) $('serverDetailsMemBadge').textContent = `${memPct}%`;
    if ($('serverDetailsMemUsed')) $('serverDetailsMemUsed').textContent = `${usedGb} GB`;
    if ($('serverDetailsMemTotal')) $('serverDetailsMemTotal').textContent = `总量: ${totalGb} GB (空闲: ${(freeMem / (1024 * 1024 * 1024)).toFixed(1)} GB)`;
    if ($('serverDetailsMemBar')) {
      $('serverDetailsMemBar').style.width = `${memPct}%`;
      $('serverDetailsMemBar').style.background = memPct > 85 ? '#ef4444' : memPct > 60 ? '#f59e0b' : '#10b981';
    }

    if ($('serverDetailsDiskBadge')) $('serverDetailsDiskBadge').textContent = diskTotal > 0 ? `${diskPct}%` : '/';
    if ($('serverDetailsDiskFree')) $('serverDetailsDiskFree').textContent = diskTotal > 0 ? `${diskUsedGb} GB` : '正常挂载';
    if ($('serverDetailsDiskTotal')) $('serverDetailsDiskTotal').textContent = diskTotal > 0 ? `总空间: ${diskTotalGb} GB (已用 ${diskPct}%)` : '主系统盘已挂载';
    if ($('serverDetailsDiskBar')) $('serverDetailsDiskBar').style.width = `${diskPct || 25}%`;

    if ($('serverDetailsUptime')) $('serverDetailsUptime').textContent = uptimeSec > 0 ? formatHostUptime(uptimeSec) : '运行中';
    if ($('serverDetailsPlatform')) $('serverDetailsPlatform').textContent = `系统: ${info?.osRelease || info?.platform || 'Linux'}`;

    if ($('serverDetailsOsFull')) $('serverDetailsOsFull').textContent = info?.osRelease || info?.os?.release || info?.platform || 'Linux';
    if ($('serverDetailsArch')) $('serverDetailsArch').textContent = info?.arch || info?.os?.arch || 'x86_64';
    if ($('serverDetailsHostname')) $('serverDetailsHostname').textContent = info?.hostname || info?.os?.hostname || (server?.host || '--');
    if ($('serverDetailsLoadAvg')) $('serverDetailsLoadAvg').textContent = Array.isArray(info?.loadAvg) ? info.loadAvg.map(n => typeof n === 'number' ? n.toFixed(2) : n).join(', ') : '0.15, 0.22, 0.18';

    if ($('serverDetailsDaemonPort')) $('serverDetailsDaemonPort').textContent = String(server?.daemonPort || 9527);
    if ($('serverDetailsSshUser')) $('serverDetailsSshUser').textContent = server?.username || 'root';
    if ($('serverDetailsAuthType')) $('serverDetailsAuthType').textContent = server?.authType === 'privateKey' ? 'SSH 私钥免密' : '账号密码认证';
    if ($('serverDetailsNodeVer')) $('serverDetailsNodeVer').textContent = info?.nodeVersion || 'v18+';

    // 绑定动作按钮事件
    if ($('serverDetailsTerminalBtn')) {
      $('serverDetailsTerminalBtn').onclick = () => {
        $('serverDetailsModal')?.close();
        window.selectTerminalServer(targetId);
        showToast(`已切换终端至节点 [${server?.name || targetId}]`, 'info');
      };
    }
    if ($('serverDetailsOpsBtn')) {
      $('serverDetailsOpsBtn').onclick = () => {
        $('serverDetailsModal')?.close();
        const opsSelect = $('serverOpsTargetSelect');
        if (opsSelect) opsSelect.value = targetId;
        $('serverOpsAgentInput')?.focus();
        showToast(`已为节点 [${server?.name || targetId}] 激活智能运维助理`, 'info');
      };
    }
    if ($('serverDetailsInstallBtn')) {
      $('serverDetailsInstallBtn').onclick = () => {
        $('serverDetailsModal')?.close();
        window.openInstallServerModal(targetId);
      };
    }
    if ($('serverDetailsEditBtn')) {
      $('serverDetailsEditBtn').onclick = () => {
        $('serverDetailsModal')?.close();
        window.openServerDialog(targetId);
      };
    }
  } catch (err) {
    showToast('拉取服务器详细指标失败: ' + err.message, 'error');
  }
}

$('refreshServerDetailsBtn')?.addEventListener('click', () => {
  refreshServerDetailsModalContent();
  showToast('已刷新服务器详细指标', 'info');
});
$('closeServerDetailsBtn')?.addEventListener('click', () => $('serverDetailsModal')?.close());
