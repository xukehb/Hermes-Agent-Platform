/* ==========================================================================
   HAP Studio 路 瀹樻柟瀹㈡埛绔墠绔牳蹇冮┍鍔?   - 瀹屽叏杩樺師 Codex Desktop / ChatGPT Projects 鏍戝舰椤圭洰浼氳瘽瀵艰埅
   - 褰诲簳淇 Windows 璺緞鏂滄潬杞箟涓庡尮閰嶉棶棰橈紝淇濊瘉瀵煎叆椤圭洰 100% 绋冲畾娓叉煋
   - 浼氳瘽瀹屾暣鎸佷箙鍖?& 鐐瑰嚮浼氳瘽鍗虫椂鏃犵紳鍒囨崲鎵撳紑
   - 娣卞害闆嗘垚 Git 鐗堟湰鍗忓悓锛氬垎鏀帰娴嬨€佹湭鎻愪氦鏂囦欢瀹℃煡銆丄I Commit銆丳ush 鎺ㄩ€佷笌 Pull 鎷夊彇
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

// 瑙勮寖鍖栨枃浠剁郴缁熻矾寰勶紙缁熶竴姝ｆ枩鏉犱笌灏忓啓姣旇緝锛屽交搴曡В鍐?Windows 鍙嶆枩鏉犺浆涔変笌澶у皬鍐欎笉鍖归厤锛?function normPath(p) {
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
  // 鏅鸿兘鏌ユ壘褰撳墠澶勪簬寮€鍚姸鎬佺殑椤跺眰妯℃€佹
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

function copyText(text, label = '鍐呭') {
  navigator.clipboard.writeText(text).then(
    () => showToast(`宸插鍒?{label}鍒板壀璐存澘`, 'success'),
    (err) => showToast('澶嶅埗澶辫触锛? + err.message, 'error')
  );
}

async function showConfirm({ title = '纭鎿嶄綔', message = '纭畾瑕佺户缁悧锛?, okText = '纭', cancelText = '鍙栨秷', isDanger = false } = {}) {
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

// 鏍煎紡鍖栫浉瀵规椂闂?(濡傚垰鍒? 2h, 24h, 3d, 14d, 30d) 瀵规爣鎴浘
function getRelativeTimeStr(isoString) {
  if (!isoString) return '鍒氬垰';
  const diffMs = Date.now() - new Date(isoString).getTime();
  if (diffMs < 0 || isNaN(diffMs)) return '鍒氬垰';
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return '鍒氬垰';
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
// 鍏ㄥ眬鐘舵€佷笌浼氳瘽鏈湴鎸佷箙鍖?// ==========================================================================

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

// 椤圭洰鎶樺彔鐘舵€佷笌鈥滃睍寮€鏇村鈥濈姸鎬?const collapsedProjectIds = new Set();
const expandedProjectAllIds = new Set();

let currentActiveProject = '';
let currentGitStatus = null;

// 浠?LocalStorage 鍔犺浇浼氳瘽
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
    console.error('鍔犺浇鏈湴浼氳瘽鍘嗗彶澶辫触:', e);
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
    console.error('淇濆瓨浼氳瘽澶辫触:', e);
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
      title: '鏂板璇?,
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
// VS Code 棰勮鍣ㄤ笌鑱斿姩
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

  $('codeViewerCopyBtn').onclick = () => copyText(code, '浠ｇ爜');
  $('codeViewerOpenVsCodeBtn').onclick = () => {
    if (filePath) openPathInVsCode(filePath);
    else if (currentActiveProject) openPathInVsCode(currentActiveProject);
    else showToast('鏈叧鑱斿叿浣撴枃浠惰矾寰?, 'info');
  };
  $('closeCodeViewerBtn').onclick = () => modal.close();

  modal.showModal();
}

async function openPathInVsCode(path) {
  if (!path) {
    showToast('鏈€夋嫨鏈夋晥鐨勬枃浠舵垨椤圭洰璺緞', 'info');
    return;
  }
  try {
    const res = await window.hap.openInVsCode(path);
    if (res.ok) {
      showToast(`宸插湪 VS Code 涓墦寮€锛?{path}`, 'success');
    } else {
      showToast('鍞よ捣 VS Code 澶辫触锛? + (res.error || '鏈煡閿欒'), 'error');
    }
  } catch (error) {
    showToast('鍞よ捣 VS Code 澶辫触锛? + error.message, 'error');
  }
}
async function openPathInExplorer(path) {
  if (!path) {
    showToast('鏈€夋嫨鏈夋晥鐨勬枃浠舵垨椤圭洰璺緞', 'info');
    return;
  }
  try {
    const res = await window.hap.openInExplorer(path);
    if (res.ok) {
      showToast(`宸插湪鏂囦欢璧勬簮绠＄悊鍣ㄤ腑鎵撳紑`, 'success');
    } else {
      showToast('鎵撳紑璧勬簮绠＄悊鍣ㄥけ璐ワ細' + (res.error || '鏈煡閿欒'), 'error');
    }
  } catch (error) {
    showToast('鎵撳紑澶辫触锛? + error.message, 'error');
  }
}

async function openPathInTerminal(path) {
  if (!path) {
    showToast('鏈€夋嫨鏈夋晥鐨勬枃浠舵垨椤圭洰璺緞', 'info');
    return;
  }
  try {
    const res = await window.hap.openInTerminal(path);
    if (res.ok) {
      showToast(`宸插湪缁堢涓墦寮€椤圭洰鐩綍`, 'success');
    } else {
      showToast('鎵撳紑缁堢澶辫触锛? + (res.error || '鏈煡閿欒'), 'error');
    }
  } catch (error) {
    showToast('鎵撳紑澶辫触锛? + error.message, 'error');
  }
}

// 缁熶竴鍏ㄥ眬涓婁笅鏂囨诞灞傝彍鍗?function showContextMenu(items, mouseEvent) {
  if (mouseEvent) {
    mouseEvent.preventDefault();
    mouseEvent.stopPropagation();
  }

  // 娓呴櫎鏃ц彍鍗?  document.querySelectorAll('.context-menu, .context-menu-backdrop').forEach((el) => el.remove());

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

  // 瀹氫綅璁＄畻
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
// Markdown 涓庝唬鐮佸潡瑙ｆ瀽 (Ultra-clean Block-level Markdown Renderer)
// ==========================================================================

function renderMarkdownContent(rawText) {
  if (!rawText) return '';

  // 1. 鎶藉彇澶氳浠ｇ爜鍧?  const codeBlocks = [];
  let text = rawText.replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (match, lang, code) => {
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push({ lang: lang.trim() || 'plaintext', code });
    return `\n\n${placeholder}\n\n`;
  });

  // 2. 鎶藉彇 Markdown 琛ㄦ牸
  const tableBlocks = [];
  text = text.replace(/((?:\|[^\n\r|]+\|[\r\n]+)+(?:\|[-:\s|]+\|[\r\n]+)(?:(?:\|[^\n\r|]+\|(?:[\r\n]+|$))+))/g, (match) => {
    const rows = match.trim().split(/\r?\n/).map(r => r.trim()).filter(Boolean);
    if (rows.length < 2) return match;
    const headerCols = rows[0].slice(1, -1).split('|').map(c => c.trim());
    const bodyRows = rows.slice(2);
    let html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
    headerCols.forEach(col => { html += `<th>${esc(col)}</th>`; });
    html += '</tr></thead><tbody>';
    bodyRows.forEach(row => {
      const cols = row.slice(1, -1).split('|').map(c => c.trim());
      html += '<tr>';
      cols.forEach(col => { html += `<td>${renderInlineMarkdown(col)}</td>`; });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    const placeholder = `__TABLE_BLOCK_${tableBlocks.length}__`;
    tableBlocks.push(html);
    return `\n\n${placeholder}\n\n`;
  });

  // 3. 鎶藉彇鍥剧墖 ![alt](url)
  const imageBlocks = [];
  text = text.replace(/!\[(.*?)\]\((.*?)\)/g, (match, alt, src) => {
    const placeholder = `__IMG_BLOCK_${imageBlocks.length}__`;
    imageBlocks.push(`<div class="user-img-card" style="margin:8px 0;max-width:320px;" onclick="window.openImageLightbox('${esc(src)}', '${esc(alt || '鍥剧墖')}')"><img src="${esc(src)}" alt="${esc(alt || '鍥剧墖')}" /><div class="img-zoom-hint">鏌ョ湅澶у浘</div></div>`);
    return `\n\n${placeholder}\n\n`;
  });

  // 4. 鎸夊弻鎹㈣鍒嗗壊涓?Block 娈佃惤
  const rawBlocks = text.split(/\n{2,}/);
  const renderedBlocks = [];

  for (const block of rawBlocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // 妫€鏌ュ崰浣嶇
    if (/^__CODE_BLOCK_\d+__$/.test(trimmed)) {
      renderedBlocks.push(trimmed);
      continue;
    }
    if (/^__TABLE_BLOCK_\d+__$/.test(trimmed)) {
      renderedBlocks.push(trimmed);
      continue;
    }
    if (/^__IMG_BLOCK_\d+__$/.test(trimmed)) {
      renderedBlocks.push(trimmed);
      continue;
    }

    // 鍒嗗壊绾?    if (/^(---|___|\*\*\*)$/.test(trimmed)) {
      renderedBlocks.push('<hr class="md-hr" />');
      continue;
    }

    // 鏍囬 (#, ##, ###, ####, #####)
    const headerMatch = trimmed.match(/^(#{1,5})\s+(.*)$/);
    if (headerMatch && headerMatch[1] && headerMatch[2]) {
      const level = headerMatch[1].length;
      const content = renderInlineMarkdown(headerMatch[2]);
      renderedBlocks.push(`<h${level} class="md-h${level}">${content}</h${level}>`);
      continue;
    }

    // 寮曠敤鍧?(Blockquote)
    if (trimmed.startsWith('> ') || trimmed.startsWith('>')) {
      const quoteContent = trimmed.split(/\r?\n/).map(l => l.replace(/^>\s?/, '')).join('<br/>');
      renderedBlocks.push(`<blockquote>${renderInlineMarkdown(quoteContent)}</blockquote>`);
      continue;
    }

    // 鍒楄〃鍧?(鏃犲簭鍒楄〃 *, -, + 鎴栨湁搴忓垪琛?1., 2.)
    const lines = trimmed.split(/\r?\n/);
    const isUnordered = lines.every(l => /^[\*\-\+]\s+/.test(l.trim()));
    const isOrdered = lines.every(l => /^\d+\.\s+/.test(l.trim()));

    if (isUnordered || isOrdered) {
      const tag = isOrdered ? 'ol' : 'ul';
      const itemsHtml = lines.map(line => {
        let content = line.trim().replace(/^([\*\-\+]|\d+\.)\s+/, '');
        // 浠诲姟鍒楄〃澶嶉€夋鏀寔
        if (/^\[ \]\s+/.test(content)) {
          content = `<span class="md-todo-box">鈽?/span> ` + content.replace(/^\[ \]\s+/, '');
        } else if (/^\[x\]\s+/i.test(content)) {
          content = `<span class="md-done-box">鈽?/span> ` + content.replace(/^\[x\]\s+/i, '');
        }
        return `<li>${renderInlineMarkdown(content)}</li>`;
      }).join('');

      renderedBlocks.push(`<${tag} class="md-list">${itemsHtml}</${tag}>`);
      continue;
    }

    // 鏅€氭钀?    const paragraphContent = lines.map(l => renderInlineMarkdown(l)).join('<br/>');
    renderedBlocks.push(`<p>${paragraphContent}</p>`);
  }

  let finalHtml = renderedBlocks.join('\n');

  // 5. 杩樺師鍗犱綅绗?  codeBlocks.forEach((block, index) => {
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
            <button type="button" class="codeblock-btn" onclick="window.viewCodeSnippet('${esc(block.lang)}', '${encoded}')" title="鍦ㄥ叏灞忕獥鍙ｆ煡鐪嬩唬鐮?>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <span>鏌ョ湅</span>
            </button>
            <button type="button" class="codeblock-btn" onclick="window.copyCodeSnippet('${encoded}')" title="澶嶅埗瀹屾暣浠ｇ爜">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span>澶嶅埗</span>
            </button>
          </div>
        </div>
        <pre class="codeblock-pre"><code>${esc(block.code)}</code></pre>
      </div>
    `;
    finalHtml = finalHtml.replace(`__CODE_BLOCK_${index}__`, blockHtml);
  });

  tableBlocks.forEach((html, index) => {
    finalHtml = finalHtml.replace(`__TABLE_BLOCK_${index}__`, html);
  });

  imageBlocks.forEach((html, index) => {
    finalHtml = finalHtml.replace(`__IMG_BLOCK_${index}__`, html);
  });

  return finalHtml;
}

function renderInlineMarkdown(str) {
  let s = esc(str);
  // 鍔犵矖 **bold**
  s = s.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // 鏂滀綋 *italic*
  s = s.replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  // 鍒犻櫎绾?~~del~~
  s = s.replace(/~~(.*?)~~/g, '<del>$1</del>');
  // 琛屽唴浠ｇ爜 `code`
  s = s.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  // 閾炬帴 [text](url)
  s = s.replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer" class="md-link">$1</a>');
  return s;
}

window.copyCodeSnippet = (encoded) => {
  const code = decodeURIComponent(encoded);
  copyText(code, '浠ｇ爜');
};

window.viewCodeSnippet = (lang, encoded) => {
  const code = decodeURIComponent(encoded);
  openCodeViewer(`snippet.${lang || 'txt'}`, code);
};

// ==========================================================================
// 鏍戝舰椤圭洰涓庝細璇濆鑸郴缁?(Tree View Navigation 路 100% 绋冲畾鏄剧ず)
// ==========================================================================

function renderProjectsTree() {
  const container = $('projectsTreeContainer');
  if (!container) return;

  const projects = state.projects || [];

  if (projects.length === 0) {
    // 娓叉煋閫氱敤浼氳瘽
    const genericSessions = sessions.map((s) => {
      const isActive = s.id === currentSessionId;
      const timeStr = getRelativeTimeStr(s.updatedAt || s.createdAt);
      return `
        <div class="session-tree-item ${isActive ? 'active' : ''}" onclick="window.switchSession('${esc(s.id)}')">
          <span class="session-title-wrap" title="${esc(s.title || '鏂板璇?)}">${esc(s.title || '鏂板璇?)}</span>
          <span class="session-time-badge">${timeStr}</span>
          <div class="session-actions-hover">
            <div class="tree-action-btn delete-btn" title="鍒犻櫎浼氳瘽" onclick="window.deleteSession('${esc(s.id)}', event)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </div>
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = `
      <div style="padding:4px 0;">
        ${genericSessions}
        <button class="btn secondary" style="margin-top:8px;width:100%;font-size:12px;" onclick="$('importProjectQuickBtn').click()">+ 瀵煎叆鏈湴宸ョ▼</button>
      </div>
    `;
    return;
  }

  // 娓叉煋姣忎釜宸ョ▼鐩綍浣滀负涓绘爲鑺傜偣锛堝叏閮ㄩ€氳繃 ID 璺敱锛屽交搴曢伩鍏?Windows 鍙嶆枩鏉犺浆涔夐敊璇級
  container.innerHTML = projects.map((p) => {
    const isCollapsed = collapsedProjectIds.has(p.id);
    const showAll = expandedProjectAllIds.has(p.id);

    // 鏍囧噯鍖栬矾寰勬瘮瀵癸細鑾峰彇璇ュ伐绋嬩笅鐨勬墍鏈変細璇?    const pNorm = normPath(p.path);
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
          <span class="session-title-wrap" title="${esc(s.title || '鏂板璇?)}">${esc(s.title || '鏂板璇?)}</span>
          <span class="session-time-badge">${timeStr}</span>
          <div class="session-actions-hover">
            <div class="tree-action-btn" title="鏇村" onclick="window.openSessionMenu('${esc(s.id)}', event)">鈥⑩€⑩€?/div>
            <div class="tree-action-btn ${s.pinned ? 'pinned' : ''}" title="${s.pinned ? '鍙栨秷缃《' : '缃《'}" onclick="window.togglePinSession('${esc(s.id)}', event)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>
            </div>
            <div class="tree-action-btn delete-btn" title="鍒犻櫎浼氳瘽" onclick="window.deleteSession('${esc(s.id)}', event)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </div>
          </div>
        </div>
      `;
    }).join('');

    const seeAllBtnHtml = hasMore ? `
      <div class="see-all-toggle-btn" onclick="window.toggleProjectSeeAll('${esc(p.id)}', event)">
        ${showAll ? '鏀惰捣' : `See all (${projectSessions.length})`}
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
            <div class="tree-action-btn" title="椤圭洰绠＄悊涓庢搷浣? onclick="window.openProjectMenu('${esc(p.id)}', event)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
            </div>
            <div class="tree-action-btn" title="鍦ㄨ椤圭洰涓嬫柊寤哄璇? onclick="window.createNewSessionInProjectById('${esc(p.id)}', event)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </div>
          </div>
        </div>

        <div class="project-sessions-sublist" style="${isCollapsed ? 'display:none;' : ''}">
          ${sessionsHtml || '<div style="font-size:11.5px;color:var(--text-muted);padding:4px 10px;">鏆傛棤浼氳瘽锛岀偣鍑?+ 鏂板缓</div>'}
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
    showToast(session.pinned ? '浼氳瘽宸茬疆椤? : '宸插彇娑堢疆椤?, 'info');
    renderProjectsTree();
  }
};

window.renameProjectById = async (projectId) => {
  const p = (state.projects || []).find((item) => item.id === projectId);
  if (!p) return;
  const newName = prompt('璇疯緭鍏ラ」鐩殑鏂版樉绀哄悕绉帮細', p.name);
  if (newName && newName.trim() && newName.trim() !== p.name) {
    try {
      await window.hap.addProject({ name: newName.trim(), path: p.path });
      showToast('椤圭洰宸查噸鍛藉悕', 'success');
      await refresh();
    } catch (err) {
      showToast('閲嶅懡鍚嶅け璐ワ細' + err.message, 'error');
    }
  }
};

window.deleteProjectById = async (projectId) => {
  const p = (state.projects || []).find((item) => item.id === projectId);
  if (!p) return;
  const ok = await showConfirm({
    title: '绉婚櫎宸ヤ綔鍖洪」鐩?,
    message: `纭畾瑕佷粠宸ヤ綔鍖虹Щ闄ら」鐩?<strong>${esc(p.name)}</strong> 鍚楋紵<br/><span style="font-size:12px;color:var(--text-muted);">${esc(p.path)}</span><br/><br/>姝ゆ搷浣滀粎浠庡伐浣滃彴绉婚櫎绠＄悊锛屼笉浼氬垹闄ょ鐩樹笂鐨勭湡瀹炰唬鐮併€俙,
    okText: '纭绉婚櫎',
    isDanger: true,
  });
  if (!ok) return;
  try {
    await window.hap.removeProject(projectId);
    selectedProjectIds.delete(projectId);
    showToast(`椤圭洰 "${p.name}" 宸蹭粠宸ヤ綔鍖虹Щ闄, 'success');
    if (currentActiveProject && (normPath(currentActiveProject) === normPath(p.path) || currentActiveProject === p.path)) {
      const remaining = (state.projects || []).filter((item) => item.id !== projectId && normPath(item.path) !== normPath(p.path));
      currentActiveProject = remaining[0]?.path || '';
    }
    await refresh();
  } catch (err) {
    showToast('绉婚櫎椤圭洰澶辫触锛? + err.message, 'error');
  }
};

window.renameSessionById = async (sessionId) => {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;
  const newTitle = prompt('璇疯緭鍏ヤ細璇濈殑鏂版爣棰橈細', session.title || '鏂板璇?);
  if (newTitle && newTitle.trim()) {
    session.title = newTitle.trim();
    saveSessionsToStorage();
    showToast('浼氳瘽宸查噸鍛藉悕', 'success');
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
      label: '鍦ㄨ祫婧愮鐞嗗櫒涓墦寮€',
      action: () => openPathInExplorer(p.path),
    },
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
      label: '鍦?VS Code 涓墦寮€',
      action: () => openPathInVsCode(p.path),
    },
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
      label: '鍦ㄧ郴缁熺粓绔腑鎵撳紑',
      action: () => openPathInTerminal(p.path),
    },
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
      label: '鍦ㄦ椤圭洰涓嬫柊寤哄璇?,
      action: () => {
        currentActiveProject = p.path;
        startNewChat();
      },
    },
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v12"/><path d="M18 9a9 9 0 0 0-9 9"/></svg>',
      label: '鏌ョ湅 Git 鏀瑰姩涓庡鏌?,
      action: () => {
        currentActiveProject = p.path;
        window.openGitModalWithCurrentProject();
      },
    },
    { divider: true },
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
      label: '閲嶅懡鍚嶉」鐩?,
      action: () => window.renameProjectById(p.id),
    },
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      label: '浠庡伐浣滃尯绉婚櫎椤圭洰',
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
      label: s.pinned ? '鍙栨秷缃《' : '缃《姝や細璇?,
      action: () => window.togglePinSession(s.id),
    },
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
      label: '閲嶅懡鍚嶄細璇?,
      action: () => window.renameSessionById(s.id),
    },
    { divider: true },
    {
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      label: '鍒犻櫎浼氳瘽',
      danger: true,
      action: () => window.deleteSession(s.id),
    },
  ];

  showContextMenu(items, event);
};

// 鏍稿績锛氬垏鎹㈠苟鎵撳紑浼氳瘽
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

// 鍒犻櫎浼氳瘽
window.deleteSession = async (id, event) => {
  if (event) event.stopPropagation();

  const target = sessions.find((s) => s.id === id);
  const ok = await showConfirm({
    title: '鍒犻櫎浼氳瘽',
    message: `纭畾瑕佸垹闄や細璇?<strong>${esc(target?.title || '鏂板璇?)}</strong> 鍚楋紵鍒犻櫎鍚庝笉鍙仮澶嶃€俙,
    okText: '纭鍒犻櫎',
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
  showToast('浼氳瘽宸插垹闄?, 'info');
  renderProjectsTree();
  renderCurrentSessionMessages();
};

// 鍒犻櫎褰撳墠浼氳瘽鎸夐挳
$('deleteCurrentChatBtn')?.addEventListener('click', async () => {
  const session = currentSession();
  const ok = await showConfirm({
    title: '鍒犻櫎褰撳墠浼氳瘽',
    message: `纭畾瑕佸垹闄ゅ綋鍓嶄細璇?<strong>${esc(session.title || '鏂板璇?)}</strong> 鍚楋紵`,
    okText: '纭鍒犻櫎',
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
  showToast('褰撳墠浼氳瘽宸插垹闄?, 'info');
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
    showToast('鏂囨湰宸叉垚鍔熷鍒跺埌鍓创鏉?, 'success');
  } catch {
    showToast('澶嶅埗澶辫触', 'error');
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

// 鍏ㄥ眬鐐瑰嚮濮旀墭浠ｇ悊锛屽交搴曚繚璇佹墍鏈夋寜閽笌鍗＄墖鐐瑰嚮 100% 鐢熸晥
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

  // 鏇存柊椤堕儴宸ヤ綔鍖烘寚绀哄櫒
  const proj = state.projects.find((p) => normPath(p.path) === normPath(currentActiveProject));
  const projName = proj?.name || (currentActiveProject ? currentActiveProject.split(/[\\/]/).pop() : '榛樿宸ョ▼');
  const wsTextEl = $('currentWorkspaceNameText');
  if (wsTextEl) {
    wsTextEl.textContent = projName;
  }

  if (session.messages.length === 0) {
    const heroSubtitle = projName ? `褰撳墠缁戝畾鐨勫伐绋嬶細<strong>${esc(projName)}</strong>` : '閫夋嫨鎴栧鍏ュ伐浣滃尯椤圭洰锛屽紑鍚珮鏁堟櫤鑳界紪鎺掍笌鑷姩鍖栦慨澶?;

    container.innerHTML = `
      <div class="hero-welcome" id="heroWelcome">
        <div class="hero-logo">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
        </div>
        <h1 class="hero-title">浠婂ぉ鏈変粈涔堟垜鍙互甯綘鐨勶紵</h1>
        <p class="hero-subtitle">${heroSubtitle}</p>
        <div class="hero-grid">
          <div class="hero-card" onclick="triggerHeroPrompt('鍒嗘瀽褰撳墠缁戝畾鐨勯」鐩伐绋嬬粨鏋勫苟鍒楀嚭鍏抽敭妯″潡涓庢綔鍦ㄩ闄?)">
            <div class="hero-card-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg></div>
            <div class="hero-card-title">鍒嗘瀽宸ョ▼鏋舵瀯</div>
            <div class="hero-card-sub">姊崇悊妯″潡渚濊禆銆佽皟鐢ㄦ嫇鎵戜笌鏋舵瀯寤鸿</div>
          </div>
          <div class="hero-card" onclick="triggerHeroPrompt('瀵瑰綋鍓嶉」鐩繘琛屽叏闈㈢殑浠ｇ爜璐ㄩ噺銆佸畨鍏ㄦ紡娲炰笌娼滃湪 Bug 瀹℃煡')">
            <div class="hero-card-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>
            <div class="hero-card-title">浠ｇ爜瀹夊叏瀹℃煡</div>
            <div class="hero-card-sub">鑷姩鍖栨帓鏌ユ綔鍦ㄤ唬鐮佺己闄蜂笌鎬ц兘鐡堕</div>
          </div>
          <div class="hero-card" onclick="triggerHeroPrompt('涓哄綋鍓嶆牳蹇冨姛鑳芥ā鍧楄璁″苟缂栧啓楂樿鐩栫巼鐨勫崟鍏冩祴璇曠敤渚?)">
            <div class="hero-card-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/></svg></div>
            <div class="hero-card-title">缂栧啓娴嬭瘯濂椾欢</div>
            <div class="hero-card-sub">鐢熸垚楂樿鐩栫巼鐨勮嚜鍔ㄥ寲娴嬭瘯鐢ㄤ緥骞舵墽琛?/div>
          </div>
          <div class="hero-card" onclick="triggerHeroPrompt('瀹℃煡 Git 鍙樻洿骞跺崗鍔╃敓鎴愯鑼冪殑 Commit 鎻愪氦鍜屾帹閫佷唬鐮?)">
            <div class="hero-card-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v12"/><path d="M18 9a9 9 0 0 0-9 9"/></svg></div>
            <div class="hero-card-title">Git 鍗忓悓涓庢帹閫?/div>
            <div class="hero-card-sub">涓€閿鏌?Diff 宸紓骞惰嚜鍔ㄦ彁浜や唬鐮?/div>
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
            const safeName = esc(att.fileName || '鍥剧墖');
            return `
              <div class="user-img-card" onclick="window.openImageLightbox('${safeSrc}', '${safeName}')">
                <img src="${safeSrc}" alt="${safeName}" />
                <div class="img-zoom-hint">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                  <span>鏌ョ湅澶у浘</span>
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
              <span>${esc(att.fileName || '鏂囦欢闄勪欢')}</span>
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
              ${timeStr ? `<span>${esc(timeStr)}</span> 路 ` : ''}
              <span style="cursor:pointer;" onclick="copyMessageText('${encoded}')" title="澶嶅埗鎴戠殑鎻愰棶">澶嶅埗</span>
            </div>
          </div>
        </div>
      `;
    }

    let reasoning = (m.reasoning || '').trim();
    let content = m.content || '';

    // 濡傛灉鍐呭鍖呭惈 <think>...</think> 鏍囩锛岃嚜鍔ㄥ墺绂诲苟鎻愬彇涓烘€濊€冨崱鐗?    if (content.includes('<think>')) {
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
            <span>娣卞害鎬濊€冭繃绋?/span>
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
              <button type="button" class="msg-action-btn" onclick="copyMessageText('${encodedAnswer}')" title="澶嶅埗瀹屾暣鍥炵瓟">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span>澶嶅埗</span>
              </button>
              <button type="button" class="msg-action-btn" onclick="window.regenerateLastMessage()" title="浣跨敤褰撳墠妯″瀷閲嶆柊鐢熸垚鍥炵瓟">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                <span>閲嶆柊鐢熸垚</span>
              </button>
              ${timeStr ? `<span class="assistant-msg-time">${esc(timeStr)}</span>` : ''}
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

window.regenerateLastMessage = () => {
  const session = currentSession();
  if (!session || session.messages.length === 0) return;
  const userMsgs = session.messages.filter((m) => m.role === 'user');
  if (userMsgs.length === 0) return;
  const lastUser = userMsgs[userMsgs.length - 1];
  if (lastUser && lastUser.content) {
    const inputEl = $('chatInput');
    if (inputEl) {
      inputEl.value = lastUser.content;
      $('chatForm')?.requestSubmit();
    }
  }
};

function startNewChat() {
  const newId = 'session_' + Date.now();
  sessions.unshift({
    id: newId,
    title: '鏂板璇?,
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

// 椤堕儴 + New Conversation 鎸夐挳
$('newChatBtn')?.addEventListener('click', startNewChat);

// 鍏ㄥ眬杈呭姪鎸夐挳
$('globalHistoryBtn')?.addEventListener('click', () => {
  show('chat');
  showToast('宸叉樉绀哄叏閮ㄥ伐绋嬪璇濆垪琛?, 'info');
});

$('scheduledTasksBtn')?.addEventListener('click', () => {
  show('logs');
  showToast('鏌ョ湅鑷姩鍖栦笌杩愯浠诲姟', 'info');
});

// 蹇嵎瀵煎叆鏈湴宸ョ▼
$('importProjectQuickBtn')?.addEventListener('click', async () => {
  try {
    const project = await window.hap.importProject();
    if (project) {
      showToast(`宸叉垚鍔熷鍏ョ洰褰曪細${project.name}`, 'success');
      currentActiveProject = project.path;
      await refresh();
    }
  } catch (error) {
    showToast('瀵煎叆鐩綍澶辫触锛? + error.message, 'error');
  }
});

// ==========================================================================
// Git 鐗堟湰鎺у埗涓庡崗鍚屽伐浣滄祦 (Git Status, Commit, Push, Pull)
// ==========================================================================

async function updateGitStatus(projectPath) {
  const branchTopText = $('gitBranchTopText');
  const badgeTop = $('gitChangesTopBadge');
  if (!branchTopText) return;

  if (!projectPath) {
    branchTopText.textContent = 'Git: 鏈€夊伐绋?;
    if (badgeTop) badgeTop.style.display = 'none';
    currentGitStatus = null;
    return;
  }

  try {
    const status = await window.hap.getGitStatus(projectPath);
    currentGitStatus = status;

    if (!status.isRepo) {
      branchTopText.textContent = 'Git: 鏈垵濮嬪寲';
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
    branchTopText.textContent = 'Git: 閿欒';
    if (badgeTop) badgeTop.style.display = 'none';
  }
}

function formatGitDiffToHtml(rawDiff) {
  if (!rawDiff) return '<div class="git-diff-line normal">锛堟棤宸紓鍐呭锛?/div>';

  const lines = rawDiff.split('\n');
  let oldLine = 0;
  let newLine = 0;

  return lines.map((line) => {
    const escaped = esc(line);
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      return `<div class="git-diff-line" style="color:#6b7280;font-size:11px;font-style:italic;">${escaped}</div>`;
    }
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+).*?\+(\d+)/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      return `<div class="git-diff-line header">${escaped}</div>`;
    }
    if (line.startsWith('+')) {
      const n = newLine++;
      return `<div class="git-diff-line add"><span class="diff-line-number"></span><span class="diff-line-number">+${n}</span>${escaped}</div>`;
    }
    if (line.startsWith('-')) {
      const o = oldLine++;
      return `<div class="git-diff-line delete"><span class="diff-line-number">-${o}</span><span class="diff-line-number"></span>${escaped}</div>`;
    }
    const o = oldLine > 0 ? oldLine++ : '';
    const n = newLine > 0 ? newLine++ : '';
    return `<div class="git-diff-line normal"><span class="diff-line-number">${o}</span><span class="diff-line-number">${n}</span>${escaped}</div>`;
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
    titleEl.textContent = file ? `Diff: ${file}` : '宸ヤ綔鍖哄叏灞€宸紓琛ヤ竵 (All in one)';
  }
  if (contentEl) {
    contentEl.innerHTML = '<div class="git-diff-line normal" style="color:#858585;">姝ｅ湪鎻愬彇宸紓浠ｇ爜...</div>';
  }

  // 楂樹寒宸︿晶婵€娲绘枃浠惰
  document.querySelectorAll('.git-file-row').forEach((row) => {
    row.classList.toggle('active', row.dataset.file === (file || '__ALL__'));
  });

  try {
    const res = await window.hap.gitDiff(currentActiveProject, file);
    currentInlineDiffRaw = res.diff || '锛堟殏鏃犱唬鐮佸樊寮傦級';
    if (contentEl) {
      contentEl.innerHTML = formatGitDiffToHtml(currentInlineDiffRaw);
    }
  } catch (error) {
    currentInlineDiffRaw = error.message;
    if (contentEl) {
      contentEl.innerHTML = `<div class="git-diff-line delete">鎻愬彇宸紓澶辫触锛?{esc(error.message)}</div>`;
    }
  }
}

$('gitStageCurrentFileBtn')?.addEventListener('click', async () => {
  if (!currentActiveProject || !currentInlineDiffFile) {
    showToast('璇峰厛閫夋嫨瑕佹殏瀛樼殑鏂囦欢', 'info');
    return;
  }
  try {
    const res = await window.hap.stageFileDiff(currentActiveProject, currentInlineDiffFile);
    showToast(res.message, 'success');
    await updateGitStatus(currentActiveProject);
    renderGitModalContent();
    loadInlineDiff(currentInlineDiffFile);
  } catch (err) {
    showToast('鏆傚瓨澶辫触: ' + err.message, 'error');
  }
});

$('gitRevertCurrentFileBtn')?.addEventListener('click', async () => {
  if (!currentActiveProject || !currentInlineDiffFile) {
    showToast('璇峰厛閫夋嫨瑕佸洖婊氱殑鏂囦欢', 'info');
    return;
  }
  if (!confirm(`纭畾瑕佸洖婊氭枃浠?[${currentInlineDiffFile}] 鐨勬湭鎻愪氦淇敼鍚楋紵姝ゆ搷浣滀笉鍙挙閿€锛乣)) {
    return;
  }
  try {
    const res = await window.hap.revertFileDiff(currentActiveProject, currentInlineDiffFile);
    showToast(res.message, 'success');
    await updateGitStatus(currentActiveProject);
    renderGitModalContent();
    loadInlineDiff('');
  } catch (err) {
    showToast('鍥炴粴澶辫触: ' + err.message, 'error');
  }
});

$('gitInlineDiffCopyBtn')?.addEventListener('click', () => {
  if (currentInlineDiffRaw) copyText(currentInlineDiffRaw, 'Diff 宸紓浠ｇ爜');
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

  if ($('gitProjectPathText')) $('gitProjectPathText').textContent = currentActiveProject || '鏈€夋嫨宸ョ▼';

  if (!currentGitStatus || !currentGitStatus.isRepo) {
    if ($('gitNotRepoState')) $('gitNotRepoState').style.display = 'block';
    if ($('gitRepoState')) $('gitRepoState').style.display = 'none';
    if ($('gitBranchBadge')) $('gitBranchBadge').textContent = '鏈垵濮嬪寲';
    if ($('gitRemoteUrlText')) $('gitRemoteUrlText').textContent = '-';
    return;
  }

  if ($('gitNotRepoState')) $('gitNotRepoState').style.display = 'none';
  if ($('gitRepoState')) $('gitRepoState').style.display = 'flex';

  if ($('gitBranchBadge')) $('gitBranchBadge').textContent = currentGitStatus.branch || 'main';
  if ($('gitRemoteUrlText')) $('gitRemoteUrlText').textContent = currentGitStatus.remoteUrl || '鏃犺繙绋嬩粨搴?(鏈湴)';
  if ($('gitChangedCount')) $('gitChangedCount').textContent = String(currentGitStatus.uncommittedCount || 0);
  if ($('gitFileListCount')) $('gitFileListCount').textContent = String(currentGitStatus.uncommittedCount || 0);

  // 缁熻淇℃伅灞曠ず
  const statBadge = $('gitSummaryStatsBadge');
  if (statBadge) {
    const adds = currentGitStatus.totalAdditions || 0;
    const dels = currentGitStatus.totalDeletions || 0;
    statBadge.innerHTML = `鍏?<strong>${currentGitStatus.uncommittedCount || 0}</strong> 涓枃浠舵敼鍔?<span style="color:#2ea043;margin-left:6px;">+${adds}</span> <span style="color:#f85149;margin-left:2px;">-${dels}</span>`;
  }

  const list = $('gitChangedFilesList');
  if (!list) return;
  if (!currentGitStatus.changedFiles || currentGitStatus.changedFiles.length === 0) {
    list.innerHTML = '<div style="color:var(--text-muted);font-style:italic;padding:8px;font-size:12px;">宸ヤ綔鍖哄共鍑€锛屾殏鏃犳湭鎻愪氦鍙樻洿</div>';
    const contentEl = $('gitInlineDiffContent');
    if (contentEl) contentEl.innerHTML = '<div class="git-diff-line normal" style="color:#858585;">宸ヤ綔鍖哄共鍑€锛屾殏鏃犱唬鐮佸彉鏇淬€?/div>';
    if ($('gitInlineDiffFileTitle')) $('gitInlineDiffFileTitle').textContent = '鏃犲彉鏇?;
  } else {
    list.innerHTML = currentGitStatus.changedFiles.map((f) => {
      let badgeClass = 'M';
      let badgeLabel = '淇敼';
      if (f.status.includes('?') || f.status.includes('A')) {
        badgeClass = 'A';
        badgeLabel = '鏂板';
      } else if (f.status.includes('D')) {
        badgeClass = 'D';
        badgeLabel = '鍒犻櫎';
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

    // 榛樿鍔犺浇绗竴涓枃浠剁殑 Diff
    if (!currentInlineDiffFile || !currentGitStatus.changedFiles.some((f) => f.file === currentInlineDiffFile)) {
      loadInlineDiff(currentGitStatus.changedFiles[0].file);
    } else {
      loadInlineDiff(currentInlineDiffFile);
    }
  }
}

$('gitStatusTopBtn')?.addEventListener('click', async () => {
  if (!currentActiveProject) {
    showToast('璇峰厛閫夋嫨鎴栧鍏ヤ竴涓伐浣滃尯宸ョ▼', 'info');
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
  showToast('Git 鐘舵€佸凡鍒锋柊', 'info');
});

$('gitInitRepoBtn')?.addEventListener('click', async () => {
  if (!currentActiveProject) return;
  try {
    const res = await window.hap.gitInit(currentActiveProject);
    showToast('宸叉垚鍔熷垵濮嬪寲 Git 浠撳簱', 'success');
    await updateGitStatus(currentActiveProject);
    renderGitModalContent();
  } catch (error) {
    showToast('Git 鍒濆鍖栧け璐ワ細' + error.message, 'error');
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
  showToast('宸叉櫤鑳界敓鎴?Commit 璇存槑', 'info');
});

$('gitCommitBtn')?.addEventListener('click', async () => {
  if (!currentActiveProject) return;
  const msg = $('gitCommitMessageInput').value.trim();
  if (!msg) {
    showToast('璇疯緭鍏ユ彁浜よ鏄?(Commit Message)', 'info');
    $('gitCommitMessageInput').focus();
    return;
  }

  try {
    await window.hap.gitCommit(currentActiveProject, msg);
    $('gitCommitMessageInput').value = '';
    showToast('浠ｇ爜宸叉垚鍔熸彁浜ゅ埌鏈湴浠撳簱锛?, 'success');
    await updateGitStatus(currentActiveProject);
    renderGitModalContent();
  } catch (error) {
    showToast('Git 鎻愪氦澶辫触锛? + error.message, 'error');
  }
});

$('gitPushBtn')?.addEventListener('click', async () => {
  if (!currentActiveProject) return;
  showToast('姝ｅ湪鎺ㄩ€佸埌杩滅浠撳簱...', 'info');
  try {
    const res = await window.hap.gitPush(currentActiveProject);
    showToast('浠ｇ爜宸叉垚鍔熸帹閫佸埌杩滅▼浠撳簱锛?, 'success');
    await updateGitStatus(currentActiveProject);
    renderGitModalContent();
  } catch (error) {
    showToast('Git 鎺ㄩ€佸け璐ワ細' + error.message, 'error');
  }
});

$('gitPullBtn')?.addEventListener('click', async () => {
  if (!currentActiveProject) return;
  showToast('姝ｅ湪浠庤繙绔媺鍙栨渶鏂颁唬鐮?..', 'info');
  try {
    const res = await window.hap.gitPull(currentActiveProject);
    showToast('鎷夊彇瀹屾垚锛? + (res.summary || '浠ｇ爜宸叉槸鏈€鏂?), 'success');
    await updateGitStatus(currentActiveProject);
    renderGitModalContent();
  } catch (error) {
    showToast('Git 鎷夊彇澶辫触锛? + error.message, 'error');
  }
});

// ==========================================================================
// 鏁版嵁鍒锋柊涓庤鍥炬覆鏌?// ==========================================================================

async function refresh() {
  try {
    state = await window.hap.snapshot();

    if ($('configPathText')) $('configPathText').textContent = state.configPath || '鏈壘鍒伴厤缃?;

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
    renderFeishuView();
    renderQQView();
    renderLogs(currentLogFilter);
    await renderServers();
    await renderSchedules();
    fillSelects();
    updateBatchBars();
    renderCurrentSessionMessages();
    updateGitStatus(currentActiveProject);
  } catch (error) {
    showToast('鍒锋柊鐘舵€佸け璐ワ細' + error.message, 'error');
  }
}

$('configPathBtn')?.addEventListener('click', () => {
  if (state.configPath) copyText(state.configPath, '閰嶇疆璺緞');
});

// ==========================================================================
// 1. Skill 鎶€鑳藉競鍦?(鍏宠仈 GitHub 寮€婧愬競鍦?
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
        鏈壘鍒板尮閰嶇殑 Skill 鎶€鑳斤紝鍙偣鍑诲彸涓婅鈥滀粠 GitHub 瀹夎 Skill鈥濈洿鎺ュ鍏ヤ换鎰忓紑婧愭妧鑳姐€?      </div>
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
        <span class="skill-stars-badge">鈽?${s.stars || 100}</span>
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
            ${s.enabled ? '宸插惎鐢? : '宸插仠鐢?}
          </span>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn secondary" onclick="window.open('https://github.com/${esc(s.repo)}', '_blank')">GitHub</button>
          <button class="btn danger" onclick="uninstallSkill('${esc(s.id)}', '${esc(s.name)}')">鍗歌浇</button>
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
    showToast(`Skill 宸?{enabled ? '鍚敤' : '鍋滅敤'}`, 'info');
    renderSkills();
  } catch (error) {
    showToast('鍒囨崲鐘舵€佸け璐ワ細' + error.message, 'error');
  }
};

window.uninstallSkill = async (id, name) => {
  const ok = await showConfirm({
    title: '鍗歌浇 Skill',
    message: `纭畾瑕佸嵏杞芥妧鑳?<strong>${esc(name)}</strong> 鍚楋紵`,
    okText: '纭鍗歌浇',
    isDanger: true,
  });
  if (!ok) return;

  try {
    await window.hap.uninstallSkill(id);
    state.skills = (state.skills || []).filter((s) => s.id !== id);
    showToast(`鎶€鑳?${name} 宸叉垚鍔熷嵏杞絗, 'success');
    renderSkills();
  } catch (error) {
    showToast('鍗歌浇澶辫触锛? + error.message, 'error');
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
    showToast(`宸叉垚鍔熶粠 GitHub 瀹夎 Skill锛?{installed.name}`, 'success');
    await refresh();
    show('skills');
  } catch (error) {
    showToast('瀹夎澶辫触锛? + error.message, 'error');
  }
});

// ==========================================================================
// 2. MCP 鎻掍欢甯傚満 (Plugins / MCP Tools)
// ==========================================================================

function renderPlugins() {
  const list = $('pluginsList');
  if (!list) return;

  const plugins = state.plugins || [];
  if (plugins.length === 0) {
    list.innerHTML = `
      <div class="empty-card" style="grid-column:1/-1;padding:32px;text-align:center;color:var(--text-muted);">
        鏆傛棤宸叉敞鍐屾彃浠讹紝鐐瑰嚮鍙充笂瑙掆€滄坊鍔犺嚜瀹氫箟 MCP 鎻掍欢鈥濇敞鍐屾柊鎵╁睍銆?      </div>
    `;
    return;
  }

  list.innerHTML = plugins.map((p) => `
    <div class="card plugin-card">
      <div class="card-header">
        <div class="card-title-wrap">
          <span class="card-title">${esc(p.name)}</span>
          <span class="card-subtitle">${p.type === 'mcp' ? `MCP: ${esc(p.command)} ${(p.args || []).join(' ')}` : '鍘熺敓鍐呯疆宸ュ叿闆?}</span>
        </div>
        <span class="badge ${p.type === 'mcp' ? 'neutral' : ''}">${p.type === 'mcp' ? 'MCP 鎻掍欢' : '鍐呯疆'}</span>
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
            ${p.enabled ? '杩愯灏辩华' : '宸插仠鐢?}
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
    showToast(`鎻掍欢宸?{enabled ? '鍚敤' : '鍋滅敤'}`, 'info');
    renderPlugins();
  } catch (error) {
    showToast('鍒囨崲鎻掍欢鐘舵€佸け璐ワ細' + error.message, 'error');
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
    description: data.description?.trim() || '鑷畾涔?MCP 鎻掍欢',
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
    showToast(`鎻掍欢 ${plugin.name} 淇濆瓨鎴愬姛`, 'success');
    await refresh();
    show('plugins');
  } catch (error) {
    showToast('淇濆瓨鎻掍欢澶辫触锛? + error.message, 'error');
  }
});

// ==========================================================================
// 3. 鏉冮檺涓庡畨鍏ㄧ瓥鐣ラ厤缃?(Permissions & Security)
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

  window.selectPermissionMode(perm.mode || 'full-access', false);

  if ($('permAllowShell')) $('permAllowShell').checked = !!perm.allowShell;
  if ($('permAllowFsWrite')) $('permAllowFsWrite').checked = !!perm.allowFsWrite;
  if ($('permAllowNetwork')) $('permAllowNetwork').checked = !!perm.allowNetwork;
  if ($('permAllowSubagent')) $('permAllowSubagent').checked = !!perm.allowSpawnSubagent;
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
      showToast('宸插垏鎹㈣嚦銆屽畬瀹屽叏鍏ㄦ斁寮€鏉冮檺銆嶆ā寮?, 'success');
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
    showToast('鏉冮檺绛栫暐宸叉寔涔呭寲淇濆瓨锛?, 'success');
  } catch (error) {
    showToast('淇濆瓨鏉冮檺澶辫触锛? + error.message, 'error');
  }
});

// ==========================================================================
// 4. 宸ヤ綔鍖洪」鐩簱绠＄悊
// ==========================================================================

function updateBatchBars() {
  const pCount = selectedProjectIds.size;
  if ($('projectBatchBar')) $('projectBatchBar').style.display = pCount > 0 ? 'flex' : 'none';
  if ($('batchDeleteProjectsText')) $('batchDeleteProjectsText').textContent = `鎵归噺绉婚櫎 (${pCount})`;
  if ($('selectAllProjectsBtn')) $('selectAllProjectsBtn').textContent = pCount === state.projects.length && pCount > 0 ? '鍙栨秷鍏ㄩ€? : '鍏ㄩ€?;

  const provCount = selectedProviderIds.size;
  if ($('providerBatchBar')) $('providerBatchBar').style.display = provCount > 0 ? 'flex' : 'none';
  if ($('batchDeleteProvidersText')) $('batchDeleteProvidersText').textContent = `鎵归噺鍒犻櫎 (${provCount})`;
  if ($('selectAllProvidersBtn')) $('selectAllProvidersBtn').textContent = provCount === state.providers.length && provCount > 0 ? '鍙栨秷鍏ㄩ€? : '鍏ㄩ€?;

  const mCount = selectedModelAliases.size;
  if ($('modelBatchBar')) $('modelBatchBar').style.display = mCount > 0 ? 'flex' : 'none';
  if ($('batchDeleteModelsText')) $('batchDeleteModelsText').textContent = `鎵归噺鍒犻櫎 (${mCount})`;
  if ($('selectAllModelsBtn')) $('selectAllModelsBtn').textContent = mCount === state.models.length && mCount > 0 ? '鍙栨秷鍏ㄩ€? : '鍏ㄩ€?;
}

function renderProjects() {
  const list = $('projectList');
  if (!list) return;

  if (state.projects.length === 0) {
    list.innerHTML = `
      <div class="empty-card" style="grid-column:1/-1;padding:32px;text-align:center;color:var(--text-muted);">
        鏆傛湭瀵煎叆浠讳綍宸ヤ綔鍖哄伐绋嬶紝鐐瑰嚮涓婃柟鈥滃鍏ユ湰鍦扮洰褰曗€濆紑濮嬨€?      </div>
    `;
    return;
  }

  list.innerHTML = state.projects.map((p) => `
    <div class="card project-card">
      <div class="card-header">
        <div class="card-header-left">
          <input type="checkbox" class="item-checkbox" data-type="project" data-id="${esc(p.id)}" ${selectedProjectIds.has(p.id) ? 'checked' : ''} />
          <div class="card-title-wrap">
            <span class="card-title">${esc(p.name)}</span>
            <span class="card-subtitle" title="${esc(p.path)}">${esc(p.path)}</span>
          </div>
        </div>
      </div>
      <div class="card-footer">
        <button class="btn text-btn" onclick="useProjectInChat('${esc(p.path)}')">鍦ㄥ璇濅腑浣跨敤</button>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn secondary" onclick="openPathInExplorer('${esc(p.path)}')">鏂囦欢澶?/button>
          <button class="btn secondary" onclick="openPathInTerminal('${esc(p.path)}')">缁堢</button>
          <button class="btn secondary" onclick="openPathInVsCode('${esc(p.path)}')">VS Code</button>
          <button class="btn danger" onclick="removeProject('${esc(p.id)}', '${esc(p.name)}')">绉婚櫎</button>
        </div>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('input[data-type="project"]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) selectedProjectIds.add(id);
      else selectedProjectIds.delete(id);
      updateBatchBars();
    });
  });
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
    title: '鎵归噺绉婚櫎椤圭洰',
    message: `纭畾瑕佷粠宸ヤ綔鍖哄垪琛ㄤ腑鎵归噺绉婚櫎閫変腑鐨?<strong>${ids.length}</strong> 涓」鐩悧锛?br/><br/>姝ゆ搷浣滀粎浠庡伐浣滃彴绉婚櫎绠＄悊锛屼笉浼氬垹闄ょ鐩樹笂鐨勭湡瀹炰唬鐮併€俙,
    okText: '纭绉婚櫎',
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
    showToast(`宸叉垚鍔熺Щ闄?${ids.length} 涓」鐩甡, 'success');
    await refresh();
  } catch (error) {
    showToast('鎵归噺绉婚櫎澶辫触锛? + error.message, 'error');
  }
});

window.useProjectInChat = (path) => {
  currentActiveProject = path;
  show('chat');
  showToast(`宸插垏鎹㈢粦瀹氬伐绋嬶細${path}`, 'info');
  renderProjectsTree();
  renderCurrentSessionMessages();
  updateGitStatus(currentActiveProject);
};

window.removeProject = async (id, name) => {
  const p = (state.projects || []).find((item) => item.id === id);
  const projName = name || p?.name || '椤圭洰';
  const projPath = p?.path || '';

  const ok = await showConfirm({
    title: '绉婚櫎椤圭洰',
    message: `纭畾瑕佷粠宸ヤ綔鍖虹Щ闄ら」鐩?<strong>${esc(projName)}</strong> 鍚楋紵<br/><br/>姝ゆ搷浣滀粎浠庡伐浣滃彴绉婚櫎绠＄悊锛屼笉浼氬垹闄ょ鐩樹笂鐨勭湡瀹炰唬鐮併€俙,
    okText: '纭绉婚櫎',
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
    showToast(`椤圭洰 "${projName}" 宸蹭粠宸ヤ綔鍖虹Щ闄, 'success');
    await refresh();
  } catch (error) {
    showToast('绉婚櫎澶辫触锛? + error.message, 'error');
  }
};

// ==========================================================================
// 5. 妯″瀷鏈嶅姟鍟嗙鐞?// ==========================================================================

function renderProviders() {
  const list = $('providerList');
  if (!list) return;

  if (state.providers.length === 0) {
    list.innerHTML = `
      <div class="empty-card" style="grid-column:1/-1;padding:32px;text-align:center;color:var(--text-muted);">
        鏆傛棤閰嶇疆鐨勬湇鍔″晢锛岀偣鍑诲彸涓婅鈥滄柊澧炴湇鍔″晢鈥濆紑濮嬮厤缃€?      </div>
    `;
    return;
  }

  list.innerHTML = state.providers.map((p) => `
    <div class="card provider-card">
      <div class="card-header">
        <div class="card-header-left">
          <input type="checkbox" class="item-checkbox" data-type="provider" data-id="${esc(p.id)}" ${selectedProviderIds.has(p.id) ? 'checked' : ''} />
          <div class="card-title-wrap">
            <span class="card-title">${esc(p.name || p.id)}</span>
            <span class="card-subtitle">${esc(p.id)}</span>
          </div>
        </div>
        <span class="badge ${p.hasCredential ? '' : 'warn'}">
          ${p.hasCredential ? '鍑嵁灏辩华' : '缂哄嚟鎹?}
        </span>
      </div>
      <div class="card-body">
        <div class="card-subtitle" title="${esc(p.baseUrl)}">URL锛?{esc(p.baseUrl)}</div>
        <div class="card-props">
          <span class="prop-chip">绾垮埗锛?{esc(p.wireApi)}</span>
          <span class="prop-chip">鍗忚锛?{esc(p.defaultProtocol || p.protocol || '榛樿')}</span>
        </div>
      </div>
      <div class="card-footer">
        <div style="display:flex;gap:6px;margin-left:auto;">
          <button class="btn secondary" onclick="openModelDialogWithProvider('${esc(p.id)}')">娣诲姞妯″瀷</button>
          <button class="btn secondary" onclick="openProviderDialog('${esc(p.id)}')">缂栬緫</button>
          <button class="btn secondary" onclick="testProvider('${esc(p.id)}')">娴嬭瘯</button>
          <button class="btn danger" onclick="deleteProvider('${esc(p.id)}')">鍒犻櫎</button>
        </div>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('input[data-type="provider"]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) selectedProviderIds.add(id);
      else selectedProviderIds.delete(id);
      updateBatchBars();
    });
  });
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
    title: '鎵归噺鍒犻櫎鏈嶅姟鍟?,
    message: `纭畾瑕佹壒閲忓垹闄ら€変腑鐨?<strong>${ids.length}</strong> 涓湇鍔″晢鍚楋紵`,
    okText: '纭鎵归噺鍒犻櫎',
    isDanger: true,
  });
  if (!ok) return;

  try {
    await window.hap.batchRemoveProviders(ids);
    selectedProviderIds.clear();
    showToast(`宸叉垚鍔熷垹闄?${ids.length} 涓湇鍔″晢`, 'success');
    await refresh();
  } catch (error) {
    showToast('鎵归噺鍒犻櫎澶辫触锛? + error.message, 'error');
  }
});

// ==========================================================================
// 5.5 鏅鸿兘浣撹鑹茬鐞?(Agents)
// ==========================================================================

function renderAgents() {
  const list = $('agentList');
  if (!list) return;

  if (!state.agents || state.agents.length === 0) {
    list.innerHTML = `
      <div class="empty-card" style="grid-column:1/-1;padding:32px;text-align:center;color:var(--text-muted);">
        鏆傛棤宸插姞杞界殑鏅鸿兘浣撱€?      </div>
    `;
    return;
  }

  list.innerHTML = state.agents.map((agent) => `
    <div class="card agent-card">
      <div class="card-header">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:38px;height:38px;border-radius:8px;background:var(--bg-card);border:1px solid var(--border-default);display:grid;place-items:center;font-size:13px;font-weight:700;color:var(--text-main);flex-shrink:0;box-shadow:0 1px 2px rgba(0,0,0,0.04);">
            ${esc(agent.emoji || agent.id.slice(0, 3).toUpperCase())}
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
          ${esc(agent.description || '鍏ㄥ姛鑳藉浠诲姟鎵ц涓庝唬鐮佸垎鏋愭櫤鑳戒綋')}
        </div>
        <div class="card-props">
          <span class="prop-chip" style="background:#eff6ff;color:#2563eb;font-weight:600;">
            妯″瀷锛?{esc(agent.model || '鍏ㄥ眬榛樿')}
          </span>
          <span class="prop-chip" title="${esc(agent.workspace || '缁ф壙鍏ㄥ眬')}">
            宸ヤ綔鍖猴細${esc(agent.workspace ? agent.workspace.split(/[/\\]/).pop() || agent.workspace : '缁ф壙鍏ㄥ眬')}
          </span>
        </div>
      </div>
      <div class="card-footer">
        <div style="display:flex;gap:6px;margin-left:auto;">
          <button class="btn secondary" onclick="openAgentDialog('${esc(agent.id)}')">缂栬緫閰嶇疆</button>
          <button class="btn primary" onclick="startChatWithAgent('${esc(agent.id)}')">寮€濮嬪璇?/button>
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
  $('agentInputEmoji').value = agent.emoji || agent.id.slice(0, 3).toUpperCase();
  $('agentModalEmoji').textContent = agent.emoji || agent.id.slice(0, 3).toUpperCase();
  $('agentModalTitle').textContent = `閰嶇疆鏅鸿兘浣? ${agent.id}`;
  $('agentInputWorkspace').value = agent.workspace || '';
  $('agentInputDescription').value = agent.description || '';
  $('agentInputToolTier').value = agent.toolTier || 'coding';

  // 濉厖妯″瀷涓嬫媺閫夐」
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
  const emoji = $('agentInputEmoji').value.trim() || id.slice(0, 3).toUpperCase();
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
    showToast(`鏅鸿兘浣?[${id}] 閰嶇疆宸叉垚鍔熶繚瀛橈紒`, 'success');
    await refresh();
  } catch (error) {
    showToast('鏇存柊鏅鸿兘浣撳け璐ワ細' + error.message, 'error');
  }
});

// ==========================================================================
// 6. 妯″瀷鐩綍绠＄悊
// ==========================================================================

function renderModels() {
  const list = $('modelList');
  if (!list) return;

  if (state.models.length === 0) {
    list.innerHTML = `
      <div class="empty-card" style="grid-column:1/-1;padding:32px;text-align:center;color:var(--text-muted);">
        妯″瀷鐩綍涓虹┖锛岀偣鍑诲彸涓婅鈥滄柊澧炴ā鍨嬧€濆湪绾挎媺鍙栨垨鎵嬪姩娣诲姞銆?      </div>
    `;
    return;
  }

  list.innerHTML = state.models.map((m) => `
    <div class="card model-card">
      <div class="card-header">
        <div class="card-header-left">
          <input type="checkbox" class="item-checkbox" data-type="model" data-id="${esc(m.alias)}" ${selectedModelAliases.has(m.alias) ? 'checked' : ''} />
          <div class="card-title-wrap">
            <span class="card-title">${esc(m.alias)}</span>
            <span class="card-subtitle">${esc(m.fullName)}</span>
          </div>
        </div>
        <span class="badge neutral">${esc(m.providerId || m.provider || 'default')}</span>
      </div>
      <div class="card-body">
        <div class="card-props">
          <span class="prop-chip">涓婁笅鏂囷細${esc(m.contextWindow ? m.contextWindow + ' tokens' : '鏈瀹?)}</span>
          <span class="prop-chip">杈撳嚭涓婇檺锛?{esc(m.maxOutputTokens ? m.maxOutputTokens + ' tokens' : '鏈瀹?)}</span>
        </div>
      </div>
      <div class="card-footer">
        <div style="display:flex;gap:6px;margin-left:auto;">
          <button class="btn secondary" onclick="openModelDialog('${esc(m.alias)}')">缂栬緫</button>
          <button class="btn danger" onclick="deleteModel('${esc(m.alias)}')">鍒犻櫎</button>
        </div>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('input[data-type="model"]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const alias = e.target.dataset.id;
      if (e.target.checked) selectedModelAliases.add(alias);
      else selectedModelAliases.delete(alias);
      updateBatchBars();
    });
  });
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
    title: '鎵归噺鍒犻櫎妯″瀷',
    message: `纭畾瑕佹壒閲忓垹闄ら€変腑鐨?<strong>${aliases.length}</strong> 涓ā鍨嬪悧锛焋,
    okText: '纭鎵归噺鍒犻櫎',
    isDanger: true,
  });
  if (!ok) return;

  try {
    await window.hap.batchRemoveModels(aliases);
    selectedModelAliases.clear();
    showToast(`宸叉垚鍔熷垹闄?${aliases.length} 涓ā鍨媊, 'success');
    await refresh();
  } catch (error) {
    showToast('鎵归噺鍒犻櫎澶辫触锛? + error.message, 'error');
  }
});

// ==========================================================================
// 7. CLI 鐩爣鐘舵€佷笌鏃ュ織娓叉煋
// ==========================================================================

function renderTargets() {
  const list = $('targetList');
  if (!list) return;

  list.innerHTML = state.targets.map((t) => `
    <div class="card target-card">
      <div class="card-header">
        <div class="card-title-wrap">
          <span class="card-title" style="text-transform:capitalize;">${esc(t.target)}</span>
          <span class="card-subtitle">${esc(t.path)}</span>
        </div>
        <span class="badge ${t.exists ? '' : 'neutral'}">${t.exists ? '宸叉娴嬪埌' : '鏈娴嬪埌'}</span>
      </div>
      <div class="card-body">
        <div style="font-size:12px;color:var(--text-secondary);">
          褰撳墠娉ㄥ叆锛?strong>${esc(t.configuredModel || '鏈厤缃?/ 榛樿')}</strong>
        </div>
      </div>
      <div class="card-footer">
        <button class="btn secondary" onclick="quickSyncTarget('${esc(t.target)}')">涓€閿敞鍏ュ綋鍓嶆ā鍨?/button>
      </div>
    </div>
  `).join('');
}

window.quickSyncTarget = (targetName) => {
  const select = document.querySelector('#switchForm select[name="target"]');
  if (select) select.value = targetName;
  show('switcher');
};

function renderLogs(filter = 'all') {
  const list = $('logList');
  if (!list) return;

  const logs = state.logs || [];
  const filtered = logs.filter((log) => (filter === 'all' ? true : log.level === filter));

  if (filtered.length === 0) {
    list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">鏆傛棤鏃ュ織璁板綍</div>';
    return;
  }

  list.innerHTML = filtered.slice().reverse().map((log) => `
    <div style="padding:10px 14px;border-radius:var(--radius-sm);border:1px solid var(--border-default);background:#ffffff;display:flex;justify-content:space-between;align-items:center;gap:12px;">
      <div style="display:flex;align-items:center;gap:8px;font-family:var(--font-mono);font-size:12.5px;">
        <span class="badge ${log.level === 'error' ? 'danger' : 'neutral'}">${esc(log.level)}</span>
        <span>${esc(log.message)}</span>
      </div>
      <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;">${new Date(log.at).toLocaleTimeString()}</span>
    </div>
  `).join('');
}

function updateModelPickerLabel() {
  const modelPicker = $('chatModelPickerSelect');
  const labelEl = $('modelCurrentLabelText');
  if (modelPicker && labelEl) {
    const selectedOption = modelPicker.options[modelPicker.selectedIndex];
    if (selectedOption) {
      const txt = selectedOption.textContent || selectedOption.value;
      labelEl.textContent = txt.split(' ')[0] || txt;
    }
  }
}

window.toggleNavGroup = (headerEl) => {
  const group = headerEl.nextElementSibling;
  if (!group) return;
  const isCollapsed = headerEl.classList.toggle('collapsed');
  group.style.display = isCollapsed ? 'none' : 'flex';
};

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
    updateModelPickerLabel();
  }

  const switchModelSelect = $('switchModelSelect');
  if (switchModelSelect) {
    switchModelSelect.innerHTML = state.models.map((m) => `
      <option value="${esc(m.fullName || m.alias)}">${esc(m.alias)} (${esc(m.fullName)})</option>
    `).join('');
  }

  const agentSelect = $('chatAgentSelect');
  if (agentSelect) {
    agentSelect.innerHTML = state.agents.map((a) => `
      <option value="${esc(a.id)}">${esc(a.name || a.id)}</option>
    `).join('');
  }

  const provSelect = $('modelProviderSelect');
  if (provSelect) {
    provSelect.innerHTML = state.providers.map((p) => `
      <option value="${esc(p.id)}">${esc(p.name || p.id)}</option>
    `).join('');
  }
}

// ==========================================================================
// 8. Telegram 鏈哄櫒浜轰笌杩滅▼鍗忓悓
// ==========================================================================

let isTgTokenVisible = false;

$('toggleTgTokenVisibilityBtn')?.addEventListener('click', () => {
  isTgTokenVisible = !isTgTokenVisible;
  const input = $('tgTokenInput');
  if (input) input.type = isTgTokenVisible ? 'text' : 'password';
  const btn = $('toggleTgTokenVisibilityBtn');
  if (btn) btn.textContent = isTgTokenVisible ? '闅愯棌鏄庢枃' : '鏄剧ず鏄庢枃';
});

async function renderTelegramView() {
  const form = $('tgConfigForm');
  if (!form) return;

  const wsPicker = $('tgWorkspacePickerSelect');
  if (wsPicker) {
    const projects = state.projects || [];
    wsPicker.innerHTML = ['<option value="">-- 浠庨」鐩簱蹇嵎鐐归€?--</option>']
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
        badge.textContent = '鐩戝惉杩愯涓?;
      }
      if (toggleBtn) {
        toggleBtn.className = 'btn danger';
        toggleBtn.textContent = '鍋滄 Telegram 鏈哄櫒浜?;
      }
      if (nameEl) nameEl.textContent = tgConfig.botName || 'Telegram 鏅鸿兘浣撴満鍣ㄤ汉';
      if (usernameBadge) {
        usernameBadge.style.display = 'inline-block';
        usernameBadge.textContent = `@${tgConfig.botUsername || 'bot'}`;
      }
      if (descEl) descEl.textContent = '宸插氨缁紒鎮ㄥ彲浠ュ湪 Telegram 涓洿鎺ュ悜璇ユ満鍣ㄤ汉鍙戦€佷换浣曚慨澶嶅拰缂栫▼鎸囦护銆?;
    } else {
      if (badge) {
        badge.className = 'badge neutral';
        badge.textContent = '鏈繍琛?;
      }
      if (toggleBtn) {
        toggleBtn.className = 'btn primary';
        toggleBtn.textContent = '鍚姩 Telegram 鏈哄櫒浜?;
      }
      if (nameEl) nameEl.textContent = tgConfig.botName || 'Telegram 鏅鸿兘浣撴満鍣ㄤ汉';
      if (usernameBadge) {
        usernameBadge.style.display = tgConfig.botUsername ? 'inline-block' : 'none';
        if (tgConfig.botUsername) usernameBadge.textContent = `@${tgConfig.botUsername}`;
      }
      if (descEl) descEl.textContent = '濉啓 Bot Token 骞跺惎鍔ㄥ悗锛屽嵆鍙湪 Telegram 鐩存帴鍚戞満鍣ㄤ汉鍙戦€佹寚浠?;
    }
  } catch (err) {
    console.error('鍔犺浇 Telegram 閰嶇疆澶辫触:', err);
  }
}

$('tgConfigForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('tgTokenInput')?.value.trim();
  const mode = $('tgModeSelect')?.value || 'polling';
  const defaultAgent = $('tgAgentSelect')?.value || 'coder';
  const workspace = $('tgWorkspaceInput')?.value.trim();

  try {
    await window.hap.saveTelegramConfig({
      token,
      mode,
      defaultAgent,
      workspace,
    });
    showToast('Telegram 閫氶亾閰嶇疆宸叉垚鍔熶繚瀛橈紒', 'success');
    await renderTelegramView();
  } catch (err) {
    showToast('淇濆瓨 Telegram 閰嶇疆澶辫触锛? + err.message, 'error');
  }
});

$('testTgBotBtn')?.addEventListener('click', async () => {
  const token = $('tgTokenInput')?.value.trim();
  if (!token) {
    showToast('璇峰厛杈撳叆 Telegram Bot Token', 'info');
    $('tgTokenInput')?.focus();
    return;
  }

  showToast('姝ｅ湪楠岃瘉 Telegram Bot Token...', 'info');
  try {
    const res = await window.hap.testTelegramBot(token);
    if (res.ok) {
      showToast(`Token 鏍￠獙閫氳繃锛佹満鍣ㄤ汉锛?{res.name} (@${res.username})`, 'success');
      $('tgBotDisplayName').textContent = res.name || 'Telegram 鏅鸿兘浣撴満鍣ㄤ汉';
      const usernameBadge = $('tgBotUsernameBadge');
      if (usernameBadge) {
        usernameBadge.style.display = 'inline-block';
        usernameBadge.textContent = `@${res.username}`;
      }
    } else {
      showToast('Token 鏍￠獙澶辫触锛? + res.error, 'error');
    }
  } catch (err) {
    showToast('鏍￠獙寮傚父锛? + err.message, 'error');
  }
});

$('toggleTgServiceBtn')?.addEventListener('click', async () => {
  const tgConfig = await window.hap.getTelegramConfig();
  if (tgConfig.running) {
    try {
      await window.hap.stopTelegramService();
      showToast('Telegram 鏈哄櫒浜烘湇鍔″凡鍋滄', 'info');
      await renderTelegramView();
    } catch (err) {
      showToast('鍋滄澶辫触锛? + err.message, 'error');
    }
  } else {
    const token = $('tgTokenInput')?.value.trim();
    if (!token) {
      showToast('璇峰厛濉啓 Telegram Bot Token', 'info');
      $('tgTokenInput')?.focus();
      return;
    }

    showToast('姝ｅ湪鍚姩 Telegram 鏈哄櫒浜烘湇鍔?..', 'info');
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
      showToast('鍚姩 Telegram 鏈哄櫒浜哄け璐ワ細' + err.message, 'error');
    }
  }
});

// ==========================================================================
// 7.5. 寰俊涓庝紒涓氬井淇￠€氶亾 (WeChat / WeCom)
// ==========================================================================

async function renderWeChatView() {
  const form = $('wxConfigForm');
  if (!form) return;

  const wsPicker = $('wxWorkspacePickerSelect');
  if (wsPicker) {
    const projects = state.projects || [];
    wsPicker.innerHTML = ['<option value="">-- 浠庨」鐩簱蹇嵎鐐归€?--</option>']
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

    // 鏍规嵁褰撳墠妯″紡鍒囨崲浼佸井瀛楁鏄剧ず
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
        badge.textContent = wxConfig.status === 'connected' ? '寰俊宸茶繛鎺? : '绛夊緟鎵嬫満鎵爜纭';
      }
      if (toggleBtn) {
        toggleBtn.className = 'btn danger';
        toggleBtn.textContent = '鍋滄寰俊鏈嶅姟';
      }
      if (nameEl) nameEl.textContent = wxConfig.loginUser ? `寰俊鐢ㄦ埛锛?{wxConfig.loginUser}` : '寰俊鏅鸿兘浣撻€氶亾锛堟湇鍔′腑锛?;
      if (descEl) {
        descEl.textContent = wxConfig.status === 'connected'
          ? '宸叉垚鍔熻繛鎺ワ紒鎮ㄥ彲浠ュ湪鎵嬫満寰俊涓殢鏃跺悜鏅鸿兘浣撳彂閫佷换浣曠紪绋嬩笌瀹℃煡闇€姹傘€?
          : '鏈嶅姟宸插湪鏈湴鐩戝惉锛岃浣跨敤鎵嬫満寰俊鎵弿涓嬫柟浜岀淮鐮佸苟鍦ㄦ墜鏈虹鐐瑰嚮纭鐧诲綍銆?;
      }

      if (qrBox && qrPlaceholder) {
        qrPlaceholder.style.display = 'none';
        qrBox.style.display = 'flex';
        qrBox.style.flexDirection = 'column';
        qrBox.style.alignItems = 'center';

        if (wxConfig.status === 'connected') {
          qrBox.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:24px 16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;text-align:center;width:100%;max-width:280px;box-shadow:0 4px 12px rgba(34,197,94,0.08);">
              <div style="width:44px;height:44px;border-radius:50%;background:#22c55e;color:#fff;display:grid;place-items:center;font-size:20px;box-shadow:0 2px 8px rgba(34,197,94,0.3);">鉁?/div>
              <div style="font-weight:700;color:#15803d;font-size:15px;">寰俊宸叉垚鍔熻繛鎺ュ氨缁?/div>
              <div style="font-size:12.5px;color:#166534;font-weight:500;">褰撳墠璐﹀彿锛?{esc(wxConfig.loginUser || 'WeChat User')}</div>
              <div style="font-size:11.5px;color:#15803d;line-height:1.4;">鐜板湪鎷胯捣鎵嬫満鍦ㄥ井淇′腑鍙戦€侀渶姹傦紝AI 灏嗗疄鏃惰嚜鍔ㄥ搷搴斿苟澶勭悊浠诲姟锛?/div>
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
              <div style="font-size:11.5px;color:#64748b;margin-top:2px;">璇蜂娇鐢ㄦ墜鏈哄井淇℃壂鐮佸苟鐐瑰嚮銆愮‘璁ょ櫥褰曘€?/div>
              <div style="display:flex;align-items:center;gap:6px;margin-top:2px;">
                <button type="button" class="btn text-btn" style="font-size:11.5px;padding:3px 8px;color:#2563eb;" onclick="copyText('${esc(wxConfig.qrCodeText)}', '鐧诲綍閾炬帴')">
                  澶嶅埗鐧诲綍閾炬帴
                </button>
              </div>
            </div>
          `;
        }
      }
    } else {
      if (badge) {
        badge.className = 'badge neutral';
        badge.textContent = '鏈繍琛?;
      }
      if (toggleBtn) {
        toggleBtn.className = 'btn primary';
        toggleBtn.textContent = '鍚姩寰俊鏈嶅姟';
      }
      if (nameEl) nameEl.textContent = '寰俊鏈繛鎺?;
      if (descEl) descEl.textContent = '鍚姩鏈嶅姟鍚庯紝鍙湪鎵嬫満寰俊涓洿鎺ョ粰鏅鸿兘浣撳彂閫侀渶姹備笌鎸囦护';

      if (qrPlaceholder && qrBox) {
        qrPlaceholder.style.display = 'block';
        qrBox.style.display = 'none';
      }
    }

    const confirmBox = $('wxConfirmActionBox');
    if (confirmBox) {
      confirmBox.style.display = (wxConfig.running && wxConfig.status !== 'connected') ? 'block' : 'none';
    }

    await renderWeChatContacts();
  } catch (err) {
    console.error('鍔犺浇寰俊閰嶇疆澶辫触:', err);
  }
}

$('confirmWxLoginBtn')?.addEventListener('click', async () => {
  try {
    showToast('姝ｅ湪纭骞跺悓姝ユ墜鏈哄井淇＄櫥褰曟€?..', 'info');
    const res = await window.hap.confirmWeChatLogin();
    if (res && res.status === 'connected') {
      showToast('寰俊閫氶亾宸叉垚鍔熻繛鎺ュ氨缁紒', 'success');
      await renderWeChatView();
    } else {
      showToast('灏氭湭妫€娴嬪埌鎵嬫満绔‘璁わ紝璇峰湪寰俊涓偣鍑汇€愮‘璁ょ櫥褰曘€?, 'warning');
    }
  } catch (err) {
    showToast('鍚屾寰俊鐘舵€佸け璐ワ細' + err.message, 'error');
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

  try {
    await window.hap.saveWeChatConfig({
      mode,
      defaultAgent,
      workspace,
      wecomCorpId,
      wecomAgentId,
      wecomSecret,
    });
    showToast('寰俊閫氶亾閰嶇疆宸叉垚鍔熶繚瀛橈紒', 'success');
    await renderWeChatView();
  } catch (err) {
    showToast('淇濆瓨寰俊閰嶇疆澶辫触锛? + err.message, 'error');
  }
});

$('refreshWxQrBtn')?.addEventListener('click', async () => {
  try {
    const res = await window.hap.refreshWeChatQr();
    showToast('浜岀淮鐮佸凡鍒锋柊锛岃鎵爜鐧诲綍', 'info');
    await renderWeChatView();
  } catch (err) {
    showToast('鍒锋柊浜岀淮鐮佸け璐ワ細' + err.message, 'error');
  }
});

$('toggleWxServiceBtn')?.addEventListener('click', async () => {
  const wxConfig = await window.hap.getWeChatConfig();
  if (wxConfig.running) {
    try {
      await window.hap.stopWeChatService();
      showToast('寰俊鏈嶅姟宸插仠姝?, 'info');
      await renderWeChatView();
    } catch (err) {
      showToast('鍋滄澶辫触锛? + err.message, 'error');
    }
  } else {
    showToast('姝ｅ湪鍚姩寰俊鏈嶅姟...', 'info');
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
      showToast('鍚姩寰俊鏈嶅姟澶辫触锛? + err.message, 'error');
    }
  }
});

// 寰俊/浼佸井鐘舵€佽嚜鍔ㄥ悓姝ョ洃鍚?(姣?1.2 绉掑揩閫熷搷搴?
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
          showToast('寰俊閫氶亾宸叉垚鍔熻繛鎺ュ氨缁紒', 'success');
        }
      }
    } catch {}
  }
}, 1200);

// ==========================================================================
// 寰俊鎺ユ敹浜哄垪琛ㄤ笌鏅鸿兘浣撲笓灞炶嚜鍔ㄥ洖澶嶄腑蹇?// ==========================================================================

let cachedWeChatContacts = [];
let activeWeChatContactId = null;
let weChatContactFilter = 'all';
let weChatContactSearch = '';

async function renderWeChatContacts() {
  const listEl = $('wxContactList');
  if (!listEl) return;

  try {
    cachedWeChatContacts = await window.hap.listWeChatContacts();
  } catch {
    cachedWeChatContacts = [];
  }

  // 杩囨护
  let filtered = cachedWeChatContacts.slice();
  if (weChatContactFilter !== 'all') {
    filtered = filtered.filter(c => c.type === weChatContactFilter || (weChatContactFilter === 'room' ? c.isRoom : !c.isRoom));
  }
  if (weChatContactSearch.trim()) {
    const q = weChatContactSearch.trim().toLowerCase();
    filtered = filtered.filter(c => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q) || (c.lastMessage && c.lastMessage.toLowerCase().includes(q)));
  }

  // 纭繚鏈夐€変腑鐨勬椿璺冭仈绯讳汉
  if (!activeWeChatContactId || !cachedWeChatContacts.some(c => c.id === activeWeChatContactId)) {
    activeWeChatContactId = filtered[0]?.id || cachedWeChatContacts[0]?.id || null;
  }

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div style="text-align:center;padding:36px 14px;color:var(--text-muted);font-size:12px;line-height:1.6;">
        <div style="font-size:22px;margin-bottom:6px;">馃挰</div>
        <div style="font-weight:600;color:var(--text-secondary);">鏆傛棤寰俊鑱旂郴浜?/div>
        <div style="margin-top:4px;font-size:11px;">褰撳井淇℃敹鍒版秷鎭椂灏嗚嚜鍔ㄦ帴鍏ワ紝鎴栫偣鍑诲彸涓婅銆? 娣诲姞銆戞墜鍔ㄧ粦瀹氥€?/div>
      </div>
    `;
  } else {
    listEl.innerHTML = filtered.map((c) => {
      const isActive = c.id === activeWeChatContactId;
      const initial = (c.name || '鍙?).trim().slice(0, 1);
      const isRoom = c.isRoom || c.type === 'room';
      const isOff = !c.autoReply || c.replyMode === 'manual';
      const agentBadgeText = isOff ? '鏆傚仠鍥炲' : `鑷姩鍥炲: ${c.agentId || 'coder'}`;
      const lastText = c.lastSender ? `${c.lastSender}: ${c.lastMessage || '鏆傛棤娑堟伅'}` : (c.lastMessage || '鏆傛棤娑堟伅');

      return `
        <div class="wx-contact-item ${isActive ? 'active' : ''}" onclick="window.selectWeChatContact('${esc(c.id)}')">
          <div class="wx-contact-avatar ${isRoom ? 'room' : ''}">
            ${esc(initial)}
          </div>
          <div class="wx-contact-info">
            <div class="wx-contact-title-row">
              <span class="wx-contact-name" title="${esc(c.name)}">${esc(c.name)}</span>
              <span class="wx-contact-time">${esc(c.lastTime || '')}</span>
            </div>
            <div class="wx-contact-sub-row">
              <span class="wx-contact-snippet" title="${esc(lastText)}">${esc(lastText)}</span>
              <span class="wx-agent-badge ${isOff ? 'off' : ''}">${esc(agentBadgeText)}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // 鏇存柊鍙充晶澶撮儴閫変腑鐨勮仈绯讳汉璇︽儏涓庝笓灞炴櫤鑳戒綋閰嶇疆鏉?  const activeContact = cachedWeChatContacts.find(c => c.id === activeWeChatContactId);
  if (activeContact) {
    const avatarEl = $('wxActiveAvatar');
    if (avatarEl) {
      avatarEl.textContent = (activeContact.name || '鍙?).trim().slice(0, 1);
      avatarEl.className = `wx-contact-avatar ${activeContact.isRoom ? 'room' : ''}`;
    }
    if ($('wxActiveContactName')) $('wxActiveContactName').textContent = activeContact.name;
    if ($('wxActiveContactTypeBadge')) {
      $('wxActiveContactTypeBadge').textContent = activeContact.isRoom ? '缇よ亰' : '绉佽亰';
      $('wxActiveContactTypeBadge').className = activeContact.isRoom ? 'badge' : 'badge neutral';
    }
    if ($('wxActiveContactId')) $('wxActiveContactId').textContent = `ID: ${activeContact.id}`;

    // 濉厖鏅鸿兘浣撻€夐」
    const agentSelect = $('wxContactAgentSelect');
    if (agentSelect) {
      const agents = state.agents || [];
      agentSelect.innerHTML = agents.map(a => `<option value="${esc(a.id)}" ${a.id === (activeContact.agentId || 'coder') ? 'selected' : ''}>${esc(a.name || a.id)} (${esc(a.id)})</option>`).join('');
      if (!agents.some(a => a.id === (activeContact.agentId || 'coder'))) {
        agentSelect.value = activeContact.agentId || 'coder';
      }
    }

    if ($('wxContactReplyModeSelect')) {
      $('wxContactReplyModeSelect').value = activeContact.replyMode || (activeContact.autoReply ? 'all' : 'manual');
    }

    if ($('wxTargetRecipientHint')) {
      $('wxTargetRecipientHint').textContent = `鍙戦€佺粰 [${activeContact.name}]锛歚;
    }
    if ($('wxTestMessageInput')) {
      $('wxTestMessageInput').placeholder = `鍚?[${activeContact.name}] 鍙戦€佹秷鎭垨鎸囦护锛岃Е鍙戜笓灞炴櫤鑳戒綋鑷姩鍥炲...`;
      $('wxTestMessageInput').disabled = false;
    }
    const sendBtn = $('sendWxTestMsgBtn');
    if (sendBtn) sendBtn.disabled = false;
    const saveRuleBtn = $('saveWxContactRuleBtn');
    if (saveRuleBtn) saveRuleBtn.disabled = false;
    const delContactBtn = $('deleteWxContactBtn');
    if (delContactBtn) delContactBtn.disabled = false;
  } else {
    const avatarEl = $('wxActiveAvatar');
    if (avatarEl) {
      avatarEl.textContent = '鏃?;
      avatarEl.className = 'wx-contact-avatar';
    }
    if ($('wxActiveContactName')) $('wxActiveContactName').textContent = '鏈€夋嫨鎺ユ敹浜?;
    if ($('wxActiveContactTypeBadge')) {
      $('wxActiveContactTypeBadge').textContent = '绛夊緟鎺ュ叆';
      $('wxActiveContactTypeBadge').className = 'badge neutral';
    }
    if ($('wxActiveContactId')) $('wxActiveContactId').textContent = 'ID: -';
    if ($('wxTargetRecipientHint')) $('wxTargetRecipientHint').textContent = '鍙戦€佹秷鎭細';
    if ($('wxTestMessageInput')) {
      $('wxTestMessageInput').placeholder = '璇峰厛鍦ㄥ乏渚ч€夋嫨鑱旂郴浜烘垨鐐瑰嚮銆? 娣诲姞鎺ユ敹浜?缇よ亰銆?..';
      $('wxTestMessageInput').disabled = true;
    }
    const sendBtn = $('sendWxTestMsgBtn');
    if (sendBtn) sendBtn.disabled = true;
    const saveRuleBtn = $('saveWxContactRuleBtn');
    if (saveRuleBtn) saveRuleBtn.disabled = true;
    const delContactBtn = $('deleteWxContactBtn');
    if (delContactBtn) delContactBtn.disabled = true;
  }

  await renderWeChatFeed();
}

window.selectWeChatContact = (id) => {
  activeWeChatContactId = id;
  renderWeChatContacts();
};

async function renderWeChatFeed() {
  const container = $('wxMessageFeed');
  if (!container) return;

  if (!activeWeChatContactId) {
    container.innerHTML = `
      <div class="empty-feed" id="wxEmptyFeedHint" style="text-align:center;color:var(--text-muted);padding:44px 16px;font-size:12.5px;line-height:1.6;">
        <div style="font-size:28px;margin-bottom:8px;">馃</div>
        <div style="font-weight:600;font-size:14px;color:var(--text-primary);">寰俊娑堟伅娴佷笌鏅鸿兘浣撹嚜鍔ㄥ洖澶?/div>
        <div style="margin-top:6px;max-width:380px;margin-left:auto;margin-right:auto;color:var(--text-secondary);font-size:12px;">
          褰撳墠灏氭湭閫夋嫨鑱旂郴浜恒€傚綋寰俊濂藉弸鎴栫兢鑱婂彂閫佹秷鎭椂锛岀粦瀹氱殑涓撳睘鏅鸿兘浣撳皢瀹炴椂澶勭悊骞跺湪姝ゅ睍绀轰氦浜掕褰曘€?        </div>
      </div>
    `;
    return;
  }

  const activeContact = cachedWeChatContacts.find(c => c.id === activeWeChatContactId);
  let messages = [];
  try {
    messages = await window.hap.getWeChatMessages(activeWeChatContactId);
  } catch {
    messages = [];
  }

  if (messages.length === 0) {
    container.innerHTML = `
      <div class="empty-feed" style="text-align:center;color:var(--text-muted);padding:32px 0;font-size:12.5px;">
        鏆傛棤涓?<strong>${esc(activeContact?.name || activeWeChatContactId)}</strong> 鐨勫璇濊褰曘€?br/>
        鍦ㄤ笅鏂硅緭鍏ユ秷鎭苟鐐瑰嚮鍙戦€侊紝缁戝畾鐨勪笓灞炴櫤鑳戒綋灏嗗疄鏃跺垎鏋愬苟鑷姩鍥炲銆?      </div>
    `;
    return;
  }

  container.innerHTML = messages.map((item) => {
    const timeStr = item.time || new Date(item.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (item.sender === 'user') {
      const senderTag = item.isRoom ? `缇ゆ垚鍛? ${esc(item.fromName || '鐢ㄦ埛')} @ ${esc(item.roomName || activeContact?.name || '缇よ亰')}` : `寰俊鐢ㄦ埛: ${esc(item.fromName || activeContact?.name || '寰俊鐢ㄦ埛')}`;
      return `
        <div style="display:flex;flex-direction:column;align-items:flex-start;max-width:85%;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
            <span class="badge neutral" style="background:#dcfce7;color:#15803d;font-size:11px;font-weight:600;">${senderTag}</span>
            <span style="font-size:11px;color:var(--text-muted);">${esc(timeStr)}</span>
          </div>
          <div style="background:#ffffff;border:1px solid #cbd5e1;padding:10px 14px;border-radius:12px 12px 12px 2px;font-size:13.5px;color:#0f172a;line-height:1.55;box-shadow:0 1px 3px rgba(0,0,0,0.02);word-break:break-word;">
            ${esc(item.text)}
          </div>
        </div>
      `;
    } else if (item.sender === 'agent') {
      return `
        <div style="display:flex;flex-direction:column;align-items:flex-end;margin-left:auto;max-width:85%;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
            <span style="font-size:11px;color:var(--text-muted);">${esc(timeStr)}</span>
            <span class="badge" style="background:#eff6ff;color:#2563eb;font-size:11px;font-weight:600;">AI 鏅鸿兘浣?(${esc(item.agentId || activeContact?.agentId || 'coder')}) (宸茶嚜鍔ㄥ洖澶?</span>
          </div>
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;padding:12px 16px;border-radius:12px 12px 2px 12px;font-size:13.5px;color:#166534;line-height:1.65;box-shadow:0 1px 3px rgba(0,0,0,0.03);word-break:break-word;">
            ${renderMarkdownContent(item.text)}
          </div>
        </div>
      `;
    }
    return '';
  }).join('');

  container.scrollTop = container.scrollHeight;
}

// 杩囨护 Tab 鍒囨崲
document.querySelectorAll('.wx-filter-btn').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.wx-filter-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    weChatContactFilter = e.target.dataset.filter || 'all';
    renderWeChatContacts();
  });
});

// 鎼滅储鏍忚緭鍏?$('wxContactSearchInput')?.addEventListener('input', (e) => {
  weChatContactSearch = e.target.value;
  renderWeChatContacts();
});

// 鍒锋柊鑱旂郴浜哄垪琛?$('refreshWxContactsBtn')?.addEventListener('click', async () => {
  showToast('宸插埛鏂板井淇¤仈绯讳汉涓庝細璇濆垪琛?, 'info');
  await renderWeChatContacts();
});

// 淇濆瓨褰撳墠鑱旂郴浜虹殑鏅鸿兘浣撲笓灞炶鍒?$('saveContactRuleBtn')?.addEventListener('click', async () => {
  if (!activeWeChatContactId) {
    showToast('璇峰厛閫夋嫨涓€涓仈绯讳汉', 'warning');
    return;
  }
  const contact = cachedWeChatContacts.find(c => c.id === activeWeChatContactId);
  if (!contact) return;

  const agentId = $('wxContactAgentSelect')?.value || 'coder';
  const replyMode = $('wxContactReplyModeSelect')?.value || 'all';
  const autoReply = replyMode !== 'manual';

  try {
    await window.hap.upsertWeChatContact({
      id: contact.id,
      name: contact.name,
      type: contact.type,
      isRoom: contact.isRoom,
      agentId,
      replyMode,
      autoReply,
    });
    showToast(`宸叉垚鍔熶繚瀛?[${contact.name}] 鐨勪笓灞炴櫤鑳戒綋鑷姩鍥炲瑙勫垯锛乣, 'success');
    await renderWeChatContacts();
  } catch (err) {
    showToast(`淇濆瓨瑙勫垯澶辫触锛?{err.message}`, 'error');
  }
});

// 鍒犻櫎鑱旂郴浜?$('deleteContactBtn')?.addEventListener('click', async () => {
  if (!activeWeChatContactId) return;
  const contact = cachedWeChatContacts.find(c => c.id === activeWeChatContactId);
  if (!confirm(`纭畾瑕佺Щ闄よ仈绯讳汉/缇よ亰 [${contact ? contact.name : activeWeChatContactId}] 鍚楋紵`)) return;

  try {
    await window.hap.removeWeChatContact(activeWeChatContactId);
    activeWeChatContactId = null;
    showToast('宸叉垚鍔熺Щ闄よ仈绯讳汉', 'info');
    await renderWeChatContacts();
  } catch (err) {
    showToast(`绉婚櫎澶辫触锛?{err.message}`, 'error');
  }
});

// 娣诲姞鑱旂郴浜哄脊绐?$('openAddWxContactDialogBtn')?.addEventListener('click', () => {
  $('wxContactInputId').value = `wx_user_${Date.now().toString(36)}`;
  $('wxContactInputName').value = '';
  $('wxContactInputType').value = 'user';
  $('wxContactInputAgent').value = 'coder';
  $('wxContactInputReplyMode').value = 'all';
  $('wxContactDialog').showModal();
});

$('closeWxContactDialogBtn')?.addEventListener('click', () => $('wxContactDialog').close());
$('cancelWxContactDialogBtn')?.addEventListener('click', () => $('wxContactDialog').close());

$('wxContactForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('wxContactInputId').value.trim();
  const name = $('wxContactInputName').value.trim();
  const type = $('wxContactInputType').value;
  const isRoom = type === 'room';
  const agentId = $('wxContactInputAgent').value;
  const replyMode = $('wxContactInputReplyMode').value;
  const autoReply = replyMode !== 'manual';

  try {
    await window.hap.upsertWeChatContact({
      id,
      name,
      type,
      isRoom,
      agentId,
      replyMode,
      autoReply,
    });
    $('wxContactDialog').close();
    activeWeChatContactId = id;
    showToast(`宸叉坊鍔犺仈绯讳汉 [${name}] 骞堕厤缃笓灞炴櫤鑳戒綋 [${agentId}]锛乣, 'success');
    await renderWeChatContacts();
  } catch (err) {
    showToast(`娣诲姞澶辫触锛?{err.message}`, 'error');
  }
});

// 鍚戝綋鍓嶉€変腑鐨勮仈绯讳汉鍙戦€佹秷鎭苟鐢辨櫤鑳戒綋鑷姩鍥炲
$('sendWxTestMsgBtn')?.addEventListener('click', async () => {
  const input = $('wxTestMessageInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  if (!activeWeChatContactId) {
    showToast('璇峰厛鍦ㄥ乏渚ч€夋嫨涓€涓帴鏀朵汉鎴栫兢鑱婏紒', 'warning');
    return;
  }

  const activeContact = cachedWeChatContacts.find(c => c.id === activeWeChatContactId);
  const activeAgent = $('wxContactAgentSelect')?.value || activeContact?.agentId || 'coder';

  input.value = '';

  // 鍦ㄦ秷鎭祦涓姞鍏ユ€濊€冨崰浣?  const container = $('wxMessageFeed');
  if (container) {
    const thinkEl = document.createElement('div');
    thinkEl.id = 'wxCurrentThinkingBubble';
    thinkEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#f1f5f9;border-radius:8px;font-size:12px;color:#475569;width:fit-content;margin-top:6px;">
        <div class="thinking-pulse-dot"></div>
        <span>鏅鸿兘浣?(${esc(activeAgent)}) 姝ｅ湪澶勭悊鏉ヨ嚜 [${esc(activeContact?.name || '寰俊鐢ㄦ埛')}] 鐨勯渶姹傦紝鍒嗘瀽骞舵墽琛屼腑...</span>
      </div>
    `;
    container.appendChild(thinkEl);
    container.scrollTop = container.scrollHeight;
  }

  try {
    const res = await window.hap.sendWeChatMessage({
      targetId: activeWeChatContactId,
      text,
      agentId: activeAgent,
      workspace: activeContact?.workspace || $('wxWorkspaceInput')?.value.trim() || currentActiveProject || '',
    });

    $('wxCurrentThinkingBubble')?.remove();

    if (res.ok) {
      await renderWeChatContacts();
      showToast(`鏅鸿兘浣?(${activeAgent}) 宸叉垚鍔熷悜 [${activeContact?.name || activeWeChatContactId}] 杈撳嚭鑷姩鍥炲锛乣, 'success');
    } else {
      await renderWeChatContacts();
      showToast(`澶勭悊澶辫触锛?{res.error}`, 'error');
    }
  } catch (err) {
    $('wxCurrentThinkingBubble')?.remove();
    showToast('鎵ц寮傚父锛? + err.message, 'error');
  }
});

$('wxTestMessageInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('sendWxTestMsgBtn')?.click();
  }
});

// ==========================================================================
// 7.6. 椋炰功鏈哄櫒浜洪€氶亾 (Feishu / Lark Bot)
// ==========================================================================

let cachedFeishuContacts = [];
let activeFeishuContactId = null;
let feishuContactSearch = '';

async function renderFeishuView() {
  const form = $('feishuConfigForm');
  if (!form) return;

  const agentSelect = $('feishuAgentSelect');
  if (agentSelect) {
    const agents = state.agents || [];
    agentSelect.innerHTML = agents
      .map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.id)} (${esc(a.id)})</option>`)
      .join('');
  }

  try {
    const cfg = await window.hap.getFeishuConfig();
    if ($('feishuAppIdInput')) $('feishuAppIdInput').value = cfg.appId || '';
    if ($('feishuSecretInput')) $('feishuSecretInput').value = cfg.appSecret || '';
    if ($('feishuTokenInput')) $('feishuTokenInput').value = cfg.verificationToken || '';
    if ($('feishuEncryptKeyInput')) $('feishuEncryptKeyInput').value = cfg.encryptKey || '';
    if ($('feishuWebhookUrlInput')) $('feishuWebhookUrlInput').value = cfg.webhookUrl || '';
    if ($('feishuBindInput')) $('feishuBindInput').value = cfg.bind || '127.0.0.1:8765';
    if ($('feishuAgentSelect') && cfg.defaultAgent) $('feishuAgentSelect').value = cfg.defaultAgent;
    if ($('feishuWorkspaceInput')) $('feishuWorkspaceInput').value = cfg.workspace || currentActiveProject || '';

    const badge = $('feishuStatusBadge');
    if (badge) {
      if (cfg.running) {
        badge.className = 'badge';
        badge.style.background = '#dcfce7';
        badge.style.color = '#15803d';
        badge.textContent = '杩愯涓?(鐩戝惉浜嬩欢)';
      } else {
        badge.className = 'badge neutral';
        badge.style.background = '';
        badge.style.color = '';
        badge.textContent = '鏈繍琛?;
      }
    }

    const toggleBtn = $('toggleFeishuServiceBtn');
    if (toggleBtn) {
      if (cfg.running) {
        toggleBtn.textContent = '鍋滄椋炰功鏈嶅姟';
        toggleBtn.className = 'btn secondary';
      } else {
        toggleBtn.textContent = '鍚姩椋炰功鏈嶅姟';
        toggleBtn.className = 'btn primary';
      }
    }

    await renderFeishuContacts();
  } catch (err) {
    console.error('鍔犺浇椋炰功閰嶇疆澶辫触:', err);
  }
}

async function renderFeishuContacts() {
  const listEl = $('feishuContactList');
  if (!listEl) return;

  try {
    cachedFeishuContacts = await window.hap.listChannelContacts('feishu');
  } catch {
    cachedFeishuContacts = [];
  }

  let filtered = cachedFeishuContacts.slice();
  if (feishuContactSearch.trim()) {
    const q = feishuContactSearch.trim().toLowerCase();
    filtered = filtered.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        (c.lastMessage && c.lastMessage.toLowerCase().includes(q))
    );
  }

  if (!activeFeishuContactId || !cachedFeishuContacts.some((c) => c.id === activeFeishuContactId)) {
    activeFeishuContactId = filtered[0]?.id || cachedFeishuContacts[0]?.id || null;
  }

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div style="text-align:center;padding:36px 14px;color:var(--text-muted);font-size:12px;line-height:1.6;">
        <div style="font-weight:600;color:var(--text-secondary);">鏆傛棤椋炰功鑱旂郴浜?缇よ亰</div>
        <div style="margin-top:4px;font-size:11px;">褰撻涔︿簨浠惰闃呮敹鍒版秷鎭椂鑷姩璁板綍锛屾垨鎵嬪姩涓嬪彂娑堟伅銆?/div>
      </div>
    `;
  } else {
    listEl.innerHTML = filtered
      .map((c) => {
        const isActive = c.id === activeFeishuContactId;
        const initial = (c.name || '椋?).trim().slice(0, 1);
        const isRoom = c.isRoom || c.type === 'room';
        const isOff = !c.autoReply || c.replyMode === 'manual';
        const agentBadgeText = isOff ? '鏆傚仠鍥炲' : `鑷姩鍥炲: ${c.agentId || 'coder'}`;
        const lastText = c.lastSender ? `${c.lastSender}: ${c.lastMessage || '鏆傛棤娑堟伅'}` : c.lastMessage || '鏆傛棤娑堟伅';

        return `
        <div class="wx-contact-item ${isActive ? 'active' : ''}" onclick="window.selectFeishuContact('${esc(c.id)}')">
          <div class="wx-contact-avatar ${isRoom ? 'room' : ''}">
            ${esc(initial)}
          </div>
          <div class="wx-contact-info">
            <div class="wx-contact-title-row">
              <span class="wx-contact-name" title="${esc(c.name)}">${esc(c.name)}</span>
              <span class="wx-contact-time">${esc(c.lastTime || '')}</span>
            </div>
            <div class="wx-contact-sub-row">
              <span class="wx-contact-snippet" title="${esc(lastText)}">${esc(lastText)}</span>
              <span class="wx-agent-badge ${isOff ? 'off' : ''}">${esc(agentBadgeText)}</span>
            </div>
          </div>
        </div>
      `;
      })
      .join('');
  }

  const activeContact = cachedFeishuContacts.find((c) => c.id === activeFeishuContactId);
  if (activeContact) {
    const avatarEl = $('feishuActiveAvatar');
    if (avatarEl) {
      avatarEl.textContent = (activeContact.name || '椋?).trim().slice(0, 1);
      avatarEl.className = `wx-contact-avatar ${activeContact.isRoom ? 'room' : ''}`;
    }
    if ($('feishuActiveContactName')) $('feishuActiveContactName').textContent = activeContact.name;
    if ($('feishuActiveContactTypeBadge')) {
      $('feishuActiveContactTypeBadge').textContent = activeContact.isRoom ? '缇よ亰' : '绉佽亰';
      $('feishuActiveContactTypeBadge').className = activeContact.isRoom ? 'badge' : 'badge neutral';
    }
    if ($('feishuActiveContactId')) $('feishuActiveContactId').textContent = `ID: ${activeContact.id}`;

    const agentSelect = $('feishuContactAgentSelect');
    if (agentSelect) {
      const agents = state.agents || [];
      agentSelect.innerHTML = agents
        .map(
          (a) =>
            `<option value="${esc(a.id)}" ${a.id === (activeContact.agentId || 'coder') ? 'selected' : ''}>${esc(a.name || a.id)} (${esc(a.id)})</option>`
        )
        .join('');
    }

    if ($('feishuContactReplyModeSelect')) {
      $('feishuContactReplyModeSelect').value =
        activeContact.replyMode || (activeContact.autoReply ? 'all' : 'manual');
    }
    if ($('feishuTestMessageInput')) {
      $('feishuTestMessageInput').placeholder = `鍚?[${activeContact.name}] 鍙戦€佹秷鎭垨鎸囦护锛岃Е鍙戜笓灞炴櫤鑳戒綋鑷姩鍥炲...`;
      $('feishuTestMessageInput').disabled = false;
    }
  }

  await renderFeishuMessages();
}

window.selectFeishuContact = async function (id) {
  activeFeishuContactId = id;
  await renderFeishuContacts();
};

async function renderFeishuMessages() {
  const container = $('feishuMessageFeed');
  if (!container) return;

  if (!activeFeishuContactId) {
    container.innerHTML = `
      <div class="empty-feed" style="text-align:center;color:var(--text-muted);padding:32px 0;font-size:12.5px;">
        璇峰湪宸︿晶閫夋嫨椋炰功鑱旂郴浜烘垨缇よ亰锛屾煡鐪嬪疄鏃跺璇濅笌浜や簰璁板綍銆?      </div>
    `;
    return;
  }

  const activeContact = cachedFeishuContacts.find((c) => c.id === activeFeishuContactId);
  let messages = [];
  try {
    messages = await window.hap.getChannelMessages(activeFeishuContactId, 'feishu');
  } catch {
    messages = [];
  }

  if (messages.length === 0) {
    container.innerHTML = `
      <div class="empty-feed" style="text-align:center;color:var(--text-muted);padding:32px 0;font-size:12.5px;">
        鏆傛棤涓?<strong>${esc(activeContact?.name || activeFeishuContactId)}</strong> 鐨勫璇濊褰曘€?br/>
        鍦ㄤ笅鏂硅緭鍏ユ秷鎭苟鐐瑰嚮鍙戦€侊紝缁戝畾鐨勪笓灞炴櫤鑳戒綋灏嗗疄鏃跺垎鏋愬苟鑷姩鍥炲銆?      </div>
    `;
    return;
  }

  container.innerHTML = messages
    .map((item) => {
      const timeStr =
        item.time ||
        new Date(item.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (item.sender === 'user') {
        const senderTag = item.isRoom
          ? `缇ゆ垚鍛? ${esc(item.fromName || '鐢ㄦ埛')}`
          : `椋炰功鐢ㄦ埛: ${esc(item.fromName || activeContact?.name || '椋炰功鐢ㄦ埛')}`;
        return `
        <div style="display:flex;flex-direction:column;align-items:flex-start;max-width:85%;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
            <span class="badge neutral" style="background:#e0f2fe;color:#0369a1;font-size:11px;font-weight:600;">${senderTag}</span>
            <span style="font-size:11px;color:var(--text-muted);">${esc(timeStr)}</span>
          </div>
          <div style="background:#ffffff;border:1px solid #cbd5e1;padding:10px 14px;border-radius:12px 12px 12px 2px;font-size:13.5px;color:#0f172a;line-height:1.55;word-break:break-word;">
            ${esc(item.text)}
          </div>
        </div>
      `;
      } else if (item.sender === 'agent') {
        return `
        <div style="display:flex;flex-direction:column;align-items:flex-end;margin-left:auto;max-width:85%;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
            <span style="font-size:11px;color:var(--text-muted);">${esc(timeStr)}</span>
            <span class="badge" style="background:#f0fdf4;color:#15803d;font-size:11px;font-weight:600;">椋炰功鏅鸿兘浣?(${esc(item.agentId || activeContact?.agentId || 'coder')})</span>
          </div>
          <div style="background:#f8fafc;border:1px solid #94a3b8;padding:12px 16px;border-radius:12px 12px 2px 12px;font-size:13.5px;color:#0f172a;line-height:1.65;word-break:break-word;">
            ${renderMarkdownContent(item.text)}
          </div>
        </div>
      `;
      }
      return '';
    })
    .join('');

  container.scrollTop = container.scrollHeight;
}

$('feishuConfigForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await window.hap.saveFeishuConfig({
      appId: $('feishuAppIdInput')?.value.trim(),
      appSecret: $('feishuSecretInput')?.value.trim(),
      verificationToken: $('feishuTokenInput')?.value.trim(),
      encryptKey: $('feishuEncryptKeyInput')?.value.trim(),
      webhookUrl: $('feishuWebhookUrlInput')?.value.trim(),
      bind: $('feishuBindInput')?.value.trim(),
      defaultAgent: $('feishuAgentSelect')?.value || 'coder',
      workspace: $('feishuWorkspaceInput')?.value.trim(),
    });
    showToast('椋炰功鏈哄櫒浜洪厤缃凡鎴愬姛淇濆瓨锛?, 'success');
    await renderFeishuView();
  } catch (err) {
    showToast('淇濆瓨椋炰功閰嶇疆澶辫触锛? + err.message, 'error');
  }
});

$('toggleFeishuServiceBtn')?.addEventListener('click', async () => {
  const cfg = await window.hap.getFeishuConfig();
  if (cfg.running) {
    try {
      await window.hap.stopFeishuService();
      showToast('椋炰功鏈哄櫒浜烘湇鍔″凡鍋滄', 'info');
      await renderFeishuView();
    } catch (err) {
      showToast('鍋滄澶辫触锛? + err.message, 'error');
    }
  } else {
    showToast('姝ｅ湪鍚姩椋炰功鏈哄櫒浜烘湇鍔?..', 'info');
    try {
      await window.hap.saveFeishuConfig({
        appId: $('feishuAppIdInput')?.value.trim(),
        appSecret: $('feishuSecretInput')?.value.trim(),
        verificationToken: $('feishuTokenInput')?.value.trim(),
        encryptKey: $('feishuEncryptKeyInput')?.value.trim(),
        webhookUrl: $('feishuWebhookUrlInput')?.value.trim(),
        bind: $('feishuBindInput')?.value.trim(),
        defaultAgent: $('feishuAgentSelect')?.value || 'coder',
        workspace: $('feishuWorkspaceInput')?.value.trim(),
        enabled: true,
      });

      const res = await window.hap.startFeishuService();
      showToast(res.message, 'success');
      await renderFeishuView();
    } catch (err) {
      showToast('鍚姩椋炰功鏈嶅姟澶辫触锛? + err.message, 'error');
    }
  }
});

$('feishuContactSearchInput')?.addEventListener('input', (e) => {
  feishuContactSearch = e.target.value;
  renderFeishuContacts();
});

$('refreshFeishuContactsBtn')?.addEventListener('click', async () => {
  showToast('宸插埛鏂伴涔︽帴鏀朵汉鍒楄〃', 'info');
  await renderFeishuContacts();
});

$('openAddFeishuContactDialogBtn')?.addEventListener('click', async () => {
  const name = prompt('璇疯緭鍏ラ涔﹁仈绯讳汉/缇よ亰鍚嶇О锛堝锛氭牳蹇冩灦鏋勭兢銆佸紶宸ョ▼甯堬級锛?);
  if (!name || !name.trim()) return;
  const id = `feishu_chat_${Date.now().toString(36)}`;
  const isRoom = name.includes('缇?) || confirm('璇ヨ仈绯讳汉鏄惁涓虹兢鑱婏紵');
  try {
    await window.hap.upsertChannelContact({
      id,
      channel: 'feishu',
      name: name.trim(),
      type: isRoom ? 'room' : 'user',
      isRoom,
      agentId: 'coder',
      replyMode: isRoom ? 'mention' : 'all',
      autoReply: true,
    });
    activeFeishuContactId = id;
    showToast(`宸叉坊鍔犻涔?{isRoom ? '缇よ亰' : '鑱旂郴浜?} [${name}] 骞剁粦瀹?coder 鏅鸿兘浣擄紒`, 'success');
    await renderFeishuContacts();
  } catch (err) {
    showToast('娣诲姞澶辫触锛? + err.message, 'error');
  }
});

$('saveFeishuContactRuleBtn')?.addEventListener('click', async () => {
  if (!activeFeishuContactId) {
    showToast('璇峰厛閫夋嫨涓€涓涔﹁仈绯讳汉/缇よ亰', 'warning');
    return;
  }
  const contact = cachedFeishuContacts.find((c) => c.id === activeFeishuContactId);
  if (!contact) return;

  const agentId = $('feishuContactAgentSelect')?.value || 'coder';
  const replyMode = $('feishuContactReplyModeSelect')?.value || 'all';
  const autoReply = replyMode !== 'manual';

  try {
    await window.hap.upsertChannelContact({
      id: contact.id,
      channel: 'feishu',
      name: contact.name,
      type: contact.type,
      isRoom: contact.isRoom,
      agentId,
      replyMode,
      autoReply,
    });
    showToast(`宸叉垚鍔熶繚瀛橀涔?[${contact.name}] 鐨勪笓灞炴櫤鑳戒綋鑷姩鍥炲瑙勫垯锛乣, 'success');
    await renderFeishuContacts();
  } catch (err) {
    showToast(`淇濆瓨瑙勫垯澶辫触锛?{err.message}`, 'error');
  }
});

$('sendFeishuTestMsgBtn')?.addEventListener('click', async () => {
  const input = $('feishuTestMessageInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  if (!activeFeishuContactId) {
    showToast('璇峰厛鍦ㄥ乏渚ч€夋嫨涓€涓涔︽帴鏀朵汉鎴栫兢鑱婏紒', 'warning');
    return;
  }

  const activeContact = cachedFeishuContacts.find((c) => c.id === activeFeishuContactId);
  const activeAgent = $('feishuContactAgentSelect')?.value || activeContact?.agentId || 'coder';

  input.value = '';

  const container = $('feishuMessageFeed');
  if (container) {
    const thinkEl = document.createElement('div');
    thinkEl.id = 'feishuThinkingBubble';
    thinkEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#f1f5f9;border-radius:8px;font-size:12px;color:#475569;width:fit-content;margin-top:6px;">
        <div class="thinking-pulse-dot"></div>
        <span>椋炰功鏅鸿兘浣?(${esc(activeAgent)}) 姝ｅ湪澶勭悊骞惰嚜鍔ㄥ洖澶?..</span>
      </div>
    `;
    container.appendChild(thinkEl);
    container.scrollTop = container.scrollHeight;
  }

  try {
    const res = await window.hap.sendChannelMessage({
      channel: 'feishu',
      targetId: activeFeishuContactId,
      text,
      agentId: activeAgent,
      workspace: activeContact?.workspace || $('feishuWorkspaceInput')?.value.trim() || currentActiveProject || '',
    });

    $('feishuThinkingBubble')?.remove();

    if (res.ok) {
      await renderFeishuContacts();
      showToast(`椋炰功鏅鸿兘浣?(${activeAgent}) 宸叉垚鍔熷洖澶?[${activeContact?.name || activeFeishuContactId}]锛乣, 'success');
    } else {
      await renderFeishuContacts();
      showToast(`澶勭悊澶辫触锛?{res.error}`, 'error');
    }
  } catch (err) {
    $('feishuThinkingBubble')?.remove();
    showToast('鎵ц寮傚父锛? + err.message, 'error');
  }
});

$('feishuTestMessageInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('sendFeishuTestMsgBtn')?.click();
  }
});

// ==========================================================================
// 7.7. QQ 鏈哄櫒浜洪€氶亾 (QQ Bot / OneBot & 寮€鏀惧钩鍙?
// ==========================================================================

let cachedQQContacts = [];
let activeQQContactId = null;
let qqContactSearch = '';

async function renderQQView() {
  const form = $('qqConfigForm');
  if (!form) return;

  const agentSelect = $('qqAgentSelect');
  if (agentSelect) {
    const agents = state.agents || [];
    agentSelect.innerHTML = agents
      .map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.id)} (${esc(a.id)})</option>`)
      .join('');
  }

  try {
    const cfg = await window.hap.getQQConfig();
    if ($('qqModeSelect')) $('qqModeSelect').value = cfg.mode || 'onebot';
    if ($('qqOnebotHttpInput')) $('qqOnebotHttpInput').value = cfg.onebotHttpUrl || 'http://127.0.0.1:3000';
    if ($('qqOnebotTokenInput')) $('qqOnebotTokenInput').value = cfg.onebotAccessToken || '';
    if ($('qqBindInput')) $('qqBindInput').value = cfg.bind || '127.0.0.1:8766';
    if ($('qqAgentSelect') && cfg.defaultAgent) $('qqAgentSelect').value = cfg.defaultAgent;
    if ($('qqWorkspaceInput')) $('qqWorkspaceInput').value = cfg.workspace || currentActiveProject || '';

    const badge = $('qqStatusBadge');
    if (badge) {
      if (cfg.running) {
        badge.className = 'badge';
        badge.style.background = '#dcfce7';
        badge.style.color = '#15803d';
        badge.textContent = '杩愯涓?(鐩戝惉娑堟伅)';
      } else {
        badge.className = 'badge neutral';
        badge.style.background = '';
        badge.style.color = '';
        badge.textContent = '鏈繍琛?;
      }
    }

    const toggleBtn = $('toggleQQServiceBtn');
    if (toggleBtn) {
      if (cfg.running) {
        toggleBtn.textContent = '鍋滄 QQ 鏈嶅姟';
        toggleBtn.className = 'btn secondary';
      } else {
        toggleBtn.textContent = '鍚姩 QQ 鏈嶅姟';
        toggleBtn.className = 'btn primary';
      }
    }

    await renderQQContacts();
  } catch (err) {
    console.error('鍔犺浇 QQ 閰嶇疆澶辫触:', err);
  }
}

async function renderQQContacts() {
  const listEl = $('qqContactList');
  if (!listEl) return;

  try {
    cachedQQContacts = await window.hap.listChannelContacts('qq');
  } catch {
    cachedQQContacts = [];
  }

  let filtered = cachedQQContacts.slice();
  if (qqContactSearch.trim()) {
    const q = qqContactSearch.trim().toLowerCase();
    filtered = filtered.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        (c.lastMessage && c.lastMessage.toLowerCase().includes(q))
    );
  }

  if (!activeQQContactId || !cachedQQContacts.some((c) => c.id === activeQQContactId)) {
    activeQQContactId = filtered[0]?.id || cachedQQContacts[0]?.id || null;
  }

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div style="text-align:center;padding:36px 14px;color:var(--text-muted);font-size:12px;line-height:1.6;">
        <div style="font-weight:600;color:var(--text-secondary);">鏆傛棤 QQ 濂藉弸/缇よ亰</div>
        <div style="margin-top:4px;font-size:11px;">褰?OneBot 鎴?QQ 鏈哄櫒浜烘帴鏀跺埌娑堟伅鏃惰嚜鍔ㄨ褰曘€?/div>
      </div>
    `;
  } else {
    listEl.innerHTML = filtered
      .map((c) => {
        const isActive = c.id === activeQQContactId;
        const initial = (c.name || '浼?).trim().slice(0, 1);
        const isRoom = c.isRoom || c.type === 'room';
        const isOff = !c.autoReply || c.replyMode === 'manual';
        const agentBadgeText = isOff ? '鏆傚仠鍥炲' : `鑷姩鍥炲: ${c.agentId || 'coder'}`;
        const lastText = c.lastSender ? `${c.lastSender}: ${c.lastMessage || '鏆傛棤娑堟伅'}` : c.lastMessage || '鏆傛棤娑堟伅';

        return `
        <div class="wx-contact-item ${isActive ? 'active' : ''}" onclick="window.selectQQContact('${esc(c.id)}')">
          <div class="wx-contact-avatar ${isRoom ? 'room' : ''}">
            ${esc(initial)}
          </div>
          <div class="wx-contact-info">
            <div class="wx-contact-title-row">
              <span class="wx-contact-name" title="${esc(c.name)}">${esc(c.name)}</span>
              <span class="wx-contact-time">${esc(c.lastTime || '')}</span>
            </div>
            <div class="wx-contact-sub-row">
              <span class="wx-contact-snippet" title="${esc(lastText)}">${esc(lastText)}</span>
              <span class="wx-agent-badge ${isOff ? 'off' : ''}">${esc(agentBadgeText)}</span>
            </div>
          </div>
        </div>
      `;
      })
      .join('');
  }

  const activeContact = cachedQQContacts.find((c) => c.id === activeQQContactId);
  if (activeContact) {
    const avatarEl = $('qqActiveAvatar');
    if (avatarEl) {
      avatarEl.textContent = (activeContact.name || '浼?).trim().slice(0, 1);
      avatarEl.className = `wx-contact-avatar ${activeContact.isRoom ? 'room' : ''}`;
    }
    if ($('qqActiveContactName')) $('qqActiveContactName').textContent = activeContact.name;
    if ($('qqActiveContactTypeBadge')) {
      $('qqActiveContactTypeBadge').textContent = activeContact.isRoom ? 'QQ缇? : '绉佽亰';
      $('qqActiveContactTypeBadge').className = activeContact.isRoom ? 'badge' : 'badge neutral';
    }
    if ($('qqActiveContactId')) $('qqActiveContactId').textContent = `ID: ${activeContact.id}`;

    const agentSelect = $('qqContactAgentSelect');
    if (agentSelect) {
      const agents = state.agents || [];
      agentSelect.innerHTML = agents
        .map(
          (a) =>
            `<option value="${esc(a.id)}" ${a.id === (activeContact.agentId || 'coder') ? 'selected' : ''}>${esc(a.name || a.id)} (${esc(a.id)})</option>`
        )
        .join('');
    }

    if ($('qqContactReplyModeSelect')) {
      $('qqContactReplyModeSelect').value =
        activeContact.replyMode || (activeContact.autoReply ? 'all' : 'manual');
    }
    if ($('qqTestMessageInput')) {
      $('qqTestMessageInput').placeholder = `鍚?[${activeContact.name}] 鍙戦€佹秷鎭垨鎸囦护锛岃Е鍙戜笓灞炴櫤鑳戒綋鑷姩鍥炲...`;
      $('qqTestMessageInput').disabled = false;
    }
  }

  await renderQQMessages();
}

window.selectQQContact = async function (id) {
  activeQQContactId = id;
  await renderQQContacts();
};

async function renderQQMessages() {
  const container = $('qqMessageFeed');
  if (!container) return;

  if (!activeQQContactId) {
    container.innerHTML = `
      <div class="empty-feed" style="text-align:center;color:var(--text-muted);padding:32px 0;font-size:12.5px;">
        璇峰湪宸︿晶閫夋嫨 QQ 濂藉弸鎴栫兢鑱婏紝鏌ョ湅瀹炴椂瀵硅瘽涓庝氦浜掕褰曘€?      </div>
    `;
    return;
  }

  const activeContact = cachedQQContacts.find((c) => c.id === activeQQContactId);
  let messages = [];
  try {
    messages = await window.hap.getChannelMessages(activeQQContactId, 'qq');
  } catch {
    messages = [];
  }

  if (messages.length === 0) {
    container.innerHTML = `
      <div class="empty-feed" style="text-align:center;color:var(--text-muted);padding:32px 0;font-size:12.5px;">
        鏆傛棤涓?<strong>${esc(activeContact?.name || activeQQContactId)}</strong> 鐨勫璇濊褰曘€?br/>
        鍦ㄤ笅鏂硅緭鍏ユ秷鎭苟鐐瑰嚮鍙戦€侊紝缁戝畾鐨勪笓灞炴櫤鑳戒綋灏嗗疄鏃跺垎鏋愬苟鑷姩鍥炲銆?      </div>
    `;
    return;
  }

  container.innerHTML = messages
    .map((item) => {
      const timeStr =
        item.time ||
        new Date(item.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (item.sender === 'user') {
        const senderTag = item.isRoom
          ? `缇ゆ垚鍛? ${esc(item.fromName || '鐢ㄦ埛')}`
          : `QQ鐢ㄦ埛: ${esc(item.fromName || activeContact?.name || 'QQ鐢ㄦ埛')}`;
        return `
        <div style="display:flex;flex-direction:column;align-items:flex-start;max-width:85%;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
            <span class="badge neutral" style="background:#e0f2fe;color:#0369a1;font-size:11px;font-weight:600;">${senderTag}</span>
            <span style="font-size:11px;color:var(--text-muted);">${esc(timeStr)}</span>
          </div>
          <div style="background:#ffffff;border:1px solid #cbd5e1;padding:10px 14px;border-radius:12px 12px 12px 2px;font-size:13.5px;color:#0f172a;line-height:1.55;word-break:break-word;">
            ${esc(item.text)}
          </div>
        </div>
      `;
      } else if (item.sender === 'agent') {
        return `
        <div style="display:flex;flex-direction:column;align-items:flex-end;margin-left:auto;max-width:85%;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
            <span style="font-size:11px;color:var(--text-muted);">${esc(timeStr)}</span>
            <span class="badge" style="background:#f0fdf4;color:#15803d;font-size:11px;font-weight:600;">QQ鏅鸿兘浣?(${esc(item.agentId || activeContact?.agentId || 'coder')})</span>
          </div>
          <div style="background:#f8fafc;border:1px solid #94a3b8;padding:12px 16px;border-radius:12px 12px 2px 12px;font-size:13.5px;color:#0f172a;line-height:1.65;word-break:break-word;">
            ${renderMarkdownContent(item.text)}
          </div>
        </div>
      `;
      }
      return '';
    })
    .join('');

  container.scrollTop = container.scrollHeight;
}

$('qqConfigForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await window.hap.saveQQConfig({
      mode: $('qqModeSelect')?.value || 'onebot',
      onebotHttpUrl: $('qqOnebotHttpInput')?.value.trim(),
      onebotAccessToken: $('qqOnebotTokenInput')?.value.trim(),
      bind: $('qqBindInput')?.value.trim(),
      defaultAgent: $('qqAgentSelect')?.value || 'coder',
      workspace: $('qqWorkspaceInput')?.value.trim(),
    });
    showToast('QQ 鏈哄櫒浜洪厤缃凡鎴愬姛淇濆瓨锛?, 'success');
    await renderQQView();
  } catch (err) {
    showToast('淇濆瓨 QQ 閰嶇疆澶辫触锛? + err.message, 'error');
  }
});

$('toggleQQServiceBtn')?.addEventListener('click', async () => {
  const cfg = await window.hap.getQQConfig();
  if (cfg.running) {
    try {
      await window.hap.stopQQService();
      showToast('QQ 鏈哄櫒浜烘湇鍔″凡鍋滄', 'info');
      await renderQQView();
    } catch (err) {
      showToast('鍋滄澶辫触锛? + err.message, 'error');
    }
  } else {
    showToast('姝ｅ湪鍚姩 QQ 鏈哄櫒浜烘湇鍔?..', 'info');
    try {
      await window.hap.saveQQConfig({
        mode: $('qqModeSelect')?.value || 'onebot',
        onebotHttpUrl: $('qqOnebotHttpInput')?.value.trim(),
        onebotAccessToken: $('qqOnebotTokenInput')?.value.trim(),
        bind: $('qqBindInput')?.value.trim(),
        defaultAgent: $('qqAgentSelect')?.value || 'coder',
        workspace: $('qqWorkspaceInput')?.value.trim(),
        enabled: true,
      });

      const res = await window.hap.startQQService();
      showToast(res.message, 'success');
      await renderQQView();
    } catch (err) {
      showToast('鍚姩 QQ 鏈嶅姟澶辫触锛? + err.message, 'error');
    }
  }
});

$('qqContactSearchInput')?.addEventListener('input', (e) => {
  qqContactSearch = e.target.value;
  renderQQContacts();
});

$('refreshQQContactsBtn')?.addEventListener('click', async () => {
  showToast('宸插埛鏂?QQ 鎺ユ敹浜哄垪琛?, 'info');
  await renderQQContacts();
});

$('openAddQQContactDialogBtn')?.addEventListener('click', async () => {
  const name = prompt('璇疯緭鍏?QQ 濂藉弸鏄电О鎴栫兢鑱婂悕绉帮紙濡傦細鐮斿彂浜ゆ祦缇ゃ€丵Q濂藉弸锛夛細');
  if (!name || !name.trim()) return;
  const id = `qq_chat_${Date.now().toString(36)}`;
  const isRoom = name.includes('缇?) || confirm('璇ヤ細璇濇槸鍚︿负 QQ 缇よ亰锛?);
  try {
    await window.hap.upsertChannelContact({
      id,
      channel: 'qq',
      name: name.trim(),
      type: isRoom ? 'room' : 'user',
      isRoom,
      agentId: 'coder',
      replyMode: isRoom ? 'mention' : 'all',
      autoReply: true,
    });
    activeQQContactId = id;
    showToast(`宸叉坊鍔?QQ ${isRoom ? '缇よ亰' : '濂藉弸'} [${name}] 骞剁粦瀹?coder 鏅鸿兘浣擄紒`, 'success');
    await renderQQContacts();
  } catch (err) {
    showToast('娣诲姞澶辫触锛? + err.message, 'error');
  }
});

$('saveQQContactRuleBtn')?.addEventListener('click', async () => {
  if (!activeQQContactId) {
    showToast('璇峰厛閫夋嫨涓€涓?QQ 濂藉弸/缇よ亰', 'warning');
    return;
  }
  const contact = cachedQQContacts.find((c) => c.id === activeQQContactId);
  if (!contact) return;

  const agentId = $('qqContactAgentSelect')?.value || 'coder';
  const replyMode = $('qqContactReplyModeSelect')?.value || 'all';
  const autoReply = replyMode !== 'manual';

  try {
    await window.hap.upsertChannelContact({
      id: contact.id,
      channel: 'qq',
      name: contact.name,
      type: contact.type,
      isRoom: contact.isRoom,
      agentId,
      replyMode,
      autoReply,
    });
    showToast(`宸叉垚鍔熶繚瀛?QQ [${contact.name}] 鐨勪笓灞炴櫤鑳戒綋鑷姩鍥炲瑙勫垯锛乣, 'success');
    await renderQQContacts();
  } catch (err) {
    showToast(`淇濆瓨瑙勫垯澶辫触锛?{err.message}`, 'error');
  }
});

$('sendQQTestMsgBtn')?.addEventListener('click', async () => {
  const input = $('qqTestMessageInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  if (!activeQQContactId) {
    showToast('璇峰厛鍦ㄥ乏渚ч€夋嫨涓€涓?QQ 鎺ユ敹浜烘垨缇よ亰锛?, 'warning');
    return;
  }

  const activeContact = cachedQQContacts.find((c) => c.id === activeQQContactId);
  const activeAgent = $('qqContactAgentSelect')?.value || activeContact?.agentId || 'coder';

  input.value = '';

  const container = $('qqMessageFeed');
  if (container) {
    const thinkEl = document.createElement('div');
    thinkEl.id = 'qqThinkingBubble';
    thinkEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#f1f5f9;border-radius:8px;font-size:12px;color:#475569;width:fit-content;margin-top:6px;">
        <div class="thinking-pulse-dot"></div>
        <span>QQ 鏅鸿兘浣?(${esc(activeAgent)}) 姝ｅ湪澶勭悊骞惰嚜鍔ㄥ洖澶?..</span>
      </div>
    `;
    container.appendChild(thinkEl);
    container.scrollTop = container.scrollHeight;
  }

  try {
    const res = await window.hap.sendChannelMessage({
      channel: 'qq',
      targetId: activeQQContactId,
      text,
      agentId: activeAgent,
      workspace: activeContact?.workspace || $('qqWorkspaceInput')?.value.trim() || currentActiveProject || '',
    });

    $('qqThinkingBubble')?.remove();

    if (res.ok) {
      await renderQQContacts();
      showToast(`QQ 鏅鸿兘浣?(${activeAgent}) 宸叉垚鍔熷洖澶?[${activeContact?.name || activeQQContactId}]锛乣, 'success');
    } else {
      await renderQQContacts();
      showToast(`澶勭悊澶辫触锛?{res.error}`, 'error');
    }
  } catch (err) {
    $('qqThinkingBubble')?.remove();
    showToast('鎵ц寮傚父锛? + err.message, 'error');
  }
});

$('qqTestMessageInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('sendQQTestMsgBtn')?.click();
  }
});

// ==========================================================================
// 8. 寮圭獥浜や簰涓庢ā鏉?// ==========================================================================

const PRESET_TEMPLATES = {
  openai: { name: 'OpenAI 瀹樻柟', baseUrl: 'https://api.openai.com/v1', wireApi: 'chat', protocol: 'openai-tools' },
  deepseek: { name: 'DeepSeek 瀹樻柟', baseUrl: 'https://api.deepseek.com', wireApi: 'chat', protocol: 'deepseek' },
  openrouter: { name: 'OpenRouter 鍏ㄧ悆鑱氬悎', baseUrl: 'https://openrouter.ai/api/v1', wireApi: 'chat', protocol: 'openai-tools' },
  anthropic: { name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1', wireApi: 'anthropic-messages', protocol: 'anthropic' },
  groq: { name: 'Groq 鏋侀€熸帹鐞?, baseUrl: 'https://api.groq.com/openai/v1', wireApi: 'chat', protocol: 'openai-tools' },
  siliconflow: { name: 'SiliconFlow 纭呭熀娴佸姩', baseUrl: 'https://api.siliconflow.cn/v1', wireApi: 'chat', protocol: 'openai-tools' },
  moonshot: { name: 'Moonshot 鏈堜箣鏆楅潰', baseUrl: 'https://api.moonshot.cn/v1', wireApi: 'chat', protocol: 'openai-tools' },
  zhipu: { name: '鏅鸿氨 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', wireApi: 'chat', protocol: 'openai-tools' },
};

function initPresetSelect() {
  const select = $('providerPresetSelect');
  if (!select) return;
  const options = ['<option value="">-- 閫夋嫨棰勭疆妯℃澘锛堝 OpenAI銆丏eepSeek銆丱penRouter 绛夛級 --</option>'];
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
  $('toggleApiKeyVisibilityBtn').textContent = isApiKeyVisible ? '闅愯棌鏄庢枃' : '鏄剧ず鏄庢枃';
});

window.openProviderDialog = (id) => {
  const dialog = $('providerDialog');
  const form = $('providerForm');
  form.reset();
  isApiKeyVisible = false;
  $('providerInputApiKey').type = 'password';
  $('toggleApiKeyVisibilityBtn').textContent = '鏄剧ず鏄庢枃';

  if (id) {
    const p = state.providers.find((item) => item.id === id);
    if (!p) return;
    $('providerDialogTitle').textContent = `缂栬緫鏈嶅姟鍟嗭細${p.name || p.id}`;
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
  } else {
    $('providerDialogTitle').textContent = '鏂板鏈嶅姟鍟?;
    $('providerPresetRow').style.display = 'block';
    $('providerInputId').readOnly = false;
    $('deleteProviderBtn').style.display = 'none';
    $('testProviderBtn').style.display = 'none';
  }
  dialog.showModal();
};

$('providerForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const data = Object.fromEntries(new FormData(form));

  try {
    await window.hap.upsertProvider({
      id: data.id.trim(),
      name: data.name?.trim(),
      baseUrl: data.baseUrl.trim(),
      apiKey: data.apiKey?.trim() || undefined,
      envKey: data.envKey?.trim() || undefined,
      wireApi: data.wireApi,
      protocol: data.protocol,
    });
    $('providerDialog').close();
    showToast(`鏈嶅姟鍟?${data.id} 淇濆瓨鎴愬姛`, 'success');
    await refresh();
  } catch (error) {
    showToast('淇濆瓨鏈嶅姟鍟嗗け璐ワ細' + error.message, 'error');
  }
});

window.deleteProvider = async (targetId) => {
  const id = targetId || $('providerInputId').value.trim();
  if (!id) return;

  const ok = await showConfirm({
    title: '鍒犻櫎鏈嶅姟鍟?,
    message: `纭畾瑕佸垹闄ゆ湇鍔″晢 <strong>${esc(id)}</strong> 鍚楋紵`,
    okText: '纭鍒犻櫎',
    isDanger: true,
  });
  if (!ok) return;

  try {
    await window.hap.removeProvider(id);
    $('providerDialog').close();
    selectedProviderIds.delete(id);
    showToast(`鏈嶅姟鍟?${id} 宸插垹闄, 'success');
    await refresh();
  } catch (error) {
    showToast('鍒犻櫎澶辫触锛? + error.message, 'error');
  }
};

window.testProvider = async (targetId) => {
  const id = targetId || $('providerInputId').value.trim();
  if (!id) return;
  showToast(`姝ｅ湪娴嬭瘯杩為€氭€э細${id}...`, 'info');
  try {
    const res = await window.hap.testProvider(id);
    if (res.reachable) {
      showToast(`鏈嶅姟鍟?${id} 杩為€氭€ф祴璇曢€氳繃锛佸彲杈綻, 'success');
    } else {
      showToast(`杩炴帴澶辫触锛?{res.error || '鏃犳硶寤虹珛鎻℃墜'}`, 'error');
    }
  } catch (error) {
    showToast('娴嬭瘯寮傚父锛? + error.message, 'error');
  }
};

// 妯″瀷寮圭獥涓庡湪绾挎媺鍙?window.openModelDialog = (alias) => {
  const dialog = $('modelDialog');
  const form = $('modelForm');
  form.reset();
  $('remoteModelPicker').style.display = 'none';

  if (alias) {
    const m = state.models.find((item) => item.alias === alias);
    if (!m) return;
    $('modelDialogTitle').textContent = `缂栬緫妯″瀷锛?{m.alias}`;
    $('modelInputAlias').value = m.alias;
    $('modelInputAlias').readOnly = true;
    $('modelProviderSelect').value = m.providerId || m.provider || '';
    $('modelInputModel').value = m.modelName || m.model || '';
    $('modelInputContext').value = m.contextWindow || '';
    $('modelInputMaxOutput').value = m.maxOutputTokens || '';
    $('modelInputProtocol').value = m.protocol || '';
    $('deleteModelBtn').style.display = 'inline-block';
  } else {
    $('modelDialogTitle').textContent = '鏂板妯″瀷';
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
    showToast('璇峰厛閫夋嫨鎵€灞炴湇鍔″晢', 'info');
    return;
  }

  const btnText = $('fetchRemoteBtnText');
  btnText.textContent = '姝ｅ湪鎷夊彇杩滅妯″瀷鍒楄〃涓?..';

  try {
    const res = await window.hap.fetchProviderModels(providerId);
    if (res.ok && res.models.length > 0) {
      showToast(`鎴愬姛鑾峰彇鍒?${res.models.length} 涓彲鐢ㄦā鍨媊, 'success');
      const picker = $('remoteModelPicker');
      picker.style.display = 'block';
      const options = ['<option value="">-- 鐐瑰嚮蹇€熺偣閫夋媺鍙栧埌鐨勬ā鍨?--</option>'];
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
      showToast('鎷夊彇澶辫触锛? + (res.error || '璇ユ湇鍔″晢鏈紑鏀炬爣鍑?/v1/models 鎺ュ彛'), 'error');
    }
  } catch (error) {
    showToast('鎷夊彇寮傚父锛? + error.message, 'error');
  } finally {
    btnText.textContent = '鑾峰彇鍙敤妯″瀷鍒楄〃';
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
    showToast(`妯″瀷 ${data.alias} 淇濆瓨鎴愬姛`, 'success');
    await refresh();
  } catch (error) {
    showToast('淇濆瓨妯″瀷澶辫触锛? + error.message, 'error');
  }
});

window.deleteModel = async (targetAlias) => {
  const alias = targetAlias || $('modelInputAlias').value.trim();
  if (!alias) return;

  const ok = await showConfirm({
    title: '鍒犻櫎妯″瀷',
    message: `纭畾瑕佷粠鐩綍涓垹闄ゆā鍨?<strong>${esc(alias)}</strong> 鍚楋紵`,
    okText: '纭鍒犻櫎',
    isDanger: true,
  });
  if (!ok) return;

  try {
    await window.hap.removeModel(alias);
    $('modelDialog').close();
    selectedModelAliases.delete(alias);
    showToast(`妯″瀷 ${alias} 宸插垹闄, 'success');
    await refresh();
  } catch (error) {
    showToast('鍒犻櫎澶辫触锛? + error.message, 'error');
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
    showToast(`椤圭洰 ${project.name} 娣诲姞鎴愬姛`, 'success');
    currentActiveProject = project.path;
    await refresh();
  } catch (error) {
    showToast('娣诲姞椤圭洰澶辫触锛? + error.message, 'error');
  }
});

// ==========================================================================
// 瑙嗗浘鍒囨崲涓庡鑸?// ==========================================================================

function show(view) {
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.id === view));
  document.querySelectorAll('.nav').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  if (view === 'schedules') renderSchedules();
  if (view === 'memories') renderMemories();
  if (view === 'host') renderHostView();
  if (view === 'servers') renderServers();
  if (view === 'wechat') renderWeChatView();
  if (view === 'feishu') renderFeishuView();
  if (view === 'qq') renderQQView();
}

document.querySelectorAll('.nav').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.view) show(btn.dataset.view);
  });
});

// 寮圭獥浜嬩欢缁戝畾
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
      showToast(`宸叉垚鍔熷鍏ョ洰褰曪細${project.name}`, 'success');
      currentActiveProject = project.path;
      await refresh();
    }
  } catch (error) {
    showToast('瀵煎叆鐩綍澶辫触锛? + error.message, 'error');
  }
});

document.querySelectorAll('dialog.modal').forEach((modal) => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.close();
  });
});

$('copyPreviewBtn')?.addEventListener('click', () => {
  const content = $('syncPreview').textContent;
  copyText(content, '閰嶇疆棰勮');
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
    showToast('鏃ュ織宸叉竻绌?, 'info');
  } catch (error) {
    showToast('娓呯┖鏃ュ織澶辫触锛? + error.message, 'error');
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
    showToast(isWrite ? `宸叉垚鍔熷啓鍏ュ悓姝ュ埌 ${data.target}` : `宸茬敓鎴?${data.target} 娉ㄥ叆棰勮`, 'success');
    await refresh();
  } catch (error) {
    $('syncPreview').textContent = `// 閿欒锛歕n${error.message}`;
    showToast('鍚屾澶辫触锛? + error.message, 'error');
  }
});

// ==========================================================================
// 澶氭ā鎬侀檮浠剁鐞?(Multimodal Attachments, Paste, Drag&Drop, Lightbox)
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
        <button type="button" class="attachment-remove-btn" onclick="window.removeComposerAttachment(${index})" title="绉婚櫎闄勪欢">鉁?/button>
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
      console.error('璇诲彇闄勪欢澶辫触:', err);
    }
  }
  if (addedCount > 0) {
    renderComposerAttachments();
    showToast(`宸查檮鍔?${addedCount} 涓枃浠?鍥剧墖`, 'info');
    $('chatInput')?.focus();
  }
}

// 1. 馃搸 涓婁紶鎸夐挳鐐归€?$('chatAttachBtn')?.addEventListener('click', () => {
  $('chatFileInput')?.click();
});

$('chatFileInput')?.addEventListener('change', async (e) => {
  const files = e.target.files;
  if (files && files.length > 0) {
    await handleAddFiles(Array.from(files));
    e.target.value = '';
  }
});

// 2. 鍓创鏉挎埅鍥剧矘璐?(Ctrl+V)
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

// 3. 鎷栨嫿鏂囦欢杩涘叆鑱婂ぉ杈撳叆鍖哄煙
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

// 4. 鍥剧墖 Lightbox 鍏ㄥ睆棰勮
window.openImageLightbox = (src, title) => {
  const modal = $('imageLightboxModal');
  const img = $('lightboxImg');
  const titleEl = $('lightboxTitle');
  if (!modal || !img) return;

  img.src = src;
  if (titleEl) titleEl.textContent = title || '鍥剧墖鏌ョ湅';

  const copyBtn = $('lightboxCopyBtn');
  if (copyBtn) {
    copyBtn.onclick = () => {
      copyText(src, '鍥剧墖閾炬帴/鏁版嵁');
    };
  }

  const dlBtn = $('lightboxDownloadBtn');
  if (dlBtn) {
    dlBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = src;
      a.download = title || `hap_image_${Date.now()}.png`;
      a.click();
      showToast('宸插紑濮嬩笅杞藉浘鐗?, 'info');
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

// ChatGPT 杈撳叆妗嗚嚜閫傚簲澧為暱涓庡彂閫佹寜閽姸鎬?const chatInput = $('chatInput');
const sendBtn = $('sendChatBtn');
const chatModelPicker = $('chatModelPickerSelect');
chatModelPicker?.addEventListener('change', () => {
  localStorage.setItem('hap:selected-chat-model', chatModelPicker.value);
  updateModelPickerLabel();
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
  if (session.messages.length === 0) {
    session.title = text ? text.slice(0, 22) : (attachmentsToSend[0]?.fileName || '鍥剧墖鍒嗘瀽');
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

  const container = $('messagesInner');
  container.insertAdjacentHTML(
    'beforeend',
    `
      <div class="msg-row assistant waiting-row">
        <div class="assistant-container">
          <div class="assistant-avatar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </div>
          <div class="assistant-content">
            <div class="thinking-loading-pill">
              <span class="thinking-pulse-dot"></span>
              <span>姝ｅ湪娣卞害鎬濊€冧笌鎵ц涓?..</span>
            </div>
          </div>
        </div>
      </div>
    `
  );

  const threadContainer = $('chatThreadContainer');
  if (threadContainer) threadContainer.scrollTop = threadContainer.scrollHeight;

  try {
    const selectedModel = $('chatModelPickerSelect')?.value || undefined;
    const result = await window.hap.chat({
      input: text || '锛堣鍒嗘瀽鍜屽鏌ヤ笂鏂归檮鍔犵殑鏂囦欢鎴栧浘鐗囷級',
      agentId: $('chatAgentSelect')?.value || undefined,
      model: selectedModel,
      projectPath: currentActiveProject || undefined,
      attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
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
        reply = '宸插畬鎴愭€濊€冧笌浠诲姟鎵ц銆?;
      }

      if (!reply && outcome.iterations > 0) {
        reply = `鏅鸿兘浣撳凡椤哄埄鎵ц ${outcome.iterations} 杞伐鍏风紪鎺掑苟瀹屾垚浠诲姟銆俙;
      }

      if (!reply && outcome.error) {
        reply = `浠诲姟鎵ц鎻愮ず锛?{outcome.error}`;
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
      reply = `鏅鸿兘浣撳凡瀹屾垚鎸囦护缂栨帓銆俓n\n> **娓╅Θ鎻愮ず**锛氳嫢闇€鑾峰彇妯″瀷鐢熸垚鐨勫畬鏁村洖澶嶆鏂囷紝璇峰湪宸︿晶 **銆愭ā鍨嬫湇鍔″晢銆?* 纭繚濉叆浜嗘纭殑 API Key 骞堕€氳繃杩為€氭€ф祴璇曪紝鐒跺悗鍦?**銆愭ā鍨嬬洰褰曘€?* 閫夋嫨瀵瑰簲妯″瀷鍗冲彲銆俙;
    }

    session.messages.push({
      role: 'assistant',
      content: reply,
      reasoning: reasoningText || undefined,
    });
    session.updatedAt = new Date().toISOString();
    saveSessionsToStorage();
  } catch (error) {
    session.messages.push({ role: 'assistant', content: `**鎵ц澶辫触锛?* ${error.message}` });
    saveSessionsToStorage();
    showToast('瀵硅瘽鎵ц澶辫触锛? + error.message, 'error');
  }

  renderCurrentSessionMessages();
  renderProjectsTree();
  updateGitStatus(currentActiveProject);
  await refresh();
});

window.openGitModalWithCurrentProject = async (targetFile) => {
  if (!currentActiveProject) {
    showToast('璇峰厛閫夋嫨鎴栧鍏ュ伐浣滃尯宸ョ▼', 'info');
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
// 杩滅▼鏈嶅姟鍣ㄤ笌鑺傜偣绠＄悊鎺у埗鍣?(Remote Servers & Terminal Controller)
// ==========================================================================

let cachedServers = [];
let activeTerminalServerId = '';
let currentInstallingServerId = '';

async function renderServers() {
  const grid = $('serverCardsGrid');
  const termSelectEl = $('terminalServerSelect');
  const opsSelectEl = $('serverOpsTargetSelect');
  if (!grid) return;

  try {
    cachedServers = await window.hap.listServers();
  } catch {
    cachedServers = [];
  }

  // 鏇存柊缁堢涓庢櫤鑳借繍缁寸洰鏍囦笅鎷夐€夋嫨妗?  const targetOptions = '<option value="">-- 璇烽€夋嫨鐩爣鏈嶅姟鍣?--</option>' +
    cachedServers.map(s => `<option value="${esc(s.id)}" ${s.id === activeTerminalServerId ? 'selected' : ''}>${esc(s.name)} (${esc(s.host)})</option>`).join('');

  if (termSelectEl) {
    const currentVal = termSelectEl.value || activeTerminalServerId;
    termSelectEl.innerHTML = targetOptions;
    if (currentVal) termSelectEl.value = currentVal;
  }

  if (opsSelectEl) {
    const currentVal = opsSelectEl.value || activeTerminalServerId;
    opsSelectEl.innerHTML = targetOptions;
    if (currentVal) opsSelectEl.value = currentVal;
  }

  if (!activeTerminalServerId && cachedServers.length > 0) {
    activeTerminalServerId = cachedServers[0].id;
    if (termSelectEl) termSelectEl.value = activeTerminalServerId;
    if (opsSelectEl) opsSelectEl.value = activeTerminalServerId;
  }

  if (cachedServers.length === 0) {
    grid.innerHTML = `
      <div class="card" style="grid-column: 1 / -1; text-align: center; padding: 42px 20px; color: var(--text-secondary);">
        <div style="font-size: 32px; margin-bottom: 12px; display: flex; justify-content: center;">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
            <line x1="6" y1="6" x2="6.01" y2="6"/>
            <line x1="6" y1="18" x2="6.01" y2="18"/>
          </svg>
        </div>
        <div style="font-weight: 700; font-size: 15px; color: var(--text-main); margin-bottom: 6px;">灏氭湭娣诲姞浠讳綍杩滅▼鏈嶅姟鍣?/div>
        <div style="font-size: 13px; max-width: 440px; margin: 0 auto 18px auto; line-height: 1.5;">
          杈撳叆鏈嶅姟鍣?IP (鍏綉鎴栧眬鍩熺綉) 涓?SSH 鍑嵁锛屽嵆鍙竴閿嚜鍔ㄥ寲閮ㄧ讲 HAP 瀹堟姢杩涚▼锛岀敱涓撳睘鏅鸿兘浣撴墽琛屽叏鑷姩杩滅▼杩愮淮涓庣洃鎺с€?        </div>
        <button type="button" class="btn primary" onclick="window.openServerDialog()" style="margin:0 auto;">
          + 绔嬪嵆娣诲姞绗竴鍙版湇鍔″櫒
        </button>
      </div>
    `;
    return;
  }

  grid.innerHTML = cachedServers.map((s) => {
    const statusMap = {
      online: { text: '鍦ㄧ嚎 (Daemon 宸插氨缁?', cls: 'badge success', color: '#16a34a' },
      offline: { text: '绂荤嚎', cls: 'badge neutral', color: '#64748b' },
      installing: { text: '姝ｅ湪閮ㄧ讲...', cls: 'badge warn', color: '#d97706' },
      error: { text: '寮傚父', cls: 'badge danger', color: '#dc2626' },
      uninstalled: { text: '鏈儴缃?Daemon', cls: 'badge neutral', color: '#475569' },
    };
    const st = statusMap[s.status] || statusMap.uninstalled;

    const info = s.systemInfo;
    const cpuPercent = info ? info.cpuUsagePercent : 0;
    const memPercent = info ? info.usedMemPercent : 0;
    const memUsedGb = info ? ((info.totalMemBytes - info.freeMemBytes) / (1024 * 1024 * 1024)).toFixed(1) : '鈥?;
    const memTotalGb = info ? (info.totalMemBytes / (1024 * 1024 * 1024)).toFixed(1) : '鈥?;
    const uptimeStr = info ? `${Math.floor(info.uptimeSeconds / 3600)}h ${Math.floor((info.uptimeSeconds % 3600) / 60)}m` : '鈥?;
    const opsAgent = s.agentId || 'ops';

    return `
      <div class="card server-card" id="server-card-${esc(s.id)}">
        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-title" title="${esc(s.name)}">${esc(s.name)}</div>
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
              <span style="color:var(--text-secondary);">杩愯:</span>
              <span style="font-weight:600;">${uptimeStr}</span>
            </div>
            <div class="server-stat-pill" style="grid-column:1 / -1;display:flex;justify-content:space-between;align-items:center;">
              <span><span style="color:var(--text-secondary);">杩愮淮鏅鸿兘浣?</span> <strong style="color:var(--text-main);">馃 ${esc(opsAgent)}</strong></span>
              <button type="button" class="btn text-btn" onclick="window.startServerAgentChat('${esc(s.id)}')" style="font-size:11.5px;color:var(--accent);padding:1px 4px;" title="鍚戞涓撳睘鏅鸿兘浣撴彁闂?>鏅鸿兘浣撳璇?鈫?/button>
            </div>
          </div>

          <!-- CPU 鐩戞帶鎸囩ず鏉?-->
          <div style="margin-top:4px;">
            <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-secondary);">
              <span>CPU 鍗犵敤</span>
              <span style="font-weight:600;color:var(--text-main);">${info ? cpuPercent + '%' : '鈥?}</span>
            </div>
            <div class="server-meter-bar">
              <div class="server-meter-fill ${cpuPercent > 80 ? 'danger' : cpuPercent > 50 ? 'warn' : ''}" style="width:${info ? cpuPercent : 0}%;"></div>
            </div>
          </div>

          <!-- 鍐呭瓨 鐩戞帶鎸囩ず鏉?-->
          <div>
            <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-secondary);">
              <span>鍐呭瓨 鍗犵敤</span>
              <span style="font-weight:600;color:var(--text-main);">${info ? `${memPercent}% (${memUsedGb}/${memTotalGb}G)` : '鈥?}</span>
            </div>
            <div class="server-meter-bar">
              <div class="server-meter-fill ${memPercent > 85 ? 'danger' : memPercent > 60 ? 'warn' : ''}" style="width:${info ? memPercent : 0}%;"></div>
            </div>
          </div>

          ${s.lastError ? `
            <div style="font-size:11.5px;color:#ef4444;background:#fef2f2;border:1px solid #fecaca;padding:4px 8px;border-radius:4px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(s.lastError)}">
              ${esc(s.lastError)}
            </div>
          ` : ''}
        </div>

        <div class="card-footer" style="display:flex;flex-wrap:wrap;gap:6px;justify-content:space-between;">
          <div style="display:flex;gap:6px;">
            <button type="button" class="btn primary" onclick="window.startServerAgentChat('${esc(s.id)}')" style="padding:3px 8px;font-size:11.5px;" title="涓庤鏈嶅姟鍣ㄧ殑涓撳睘鏅鸿兘浣撶洿鎺ュ璇濊繘琛岃繍缁翠笌鍗囩骇">
              馃 鏅鸿兘杩愮淮
            </button>
            <button type="button" class="btn secondary" onclick="window.fetchServerInfoNode('${esc(s.id)}')" style="padding:3px 8px;font-size:11.5px;" title="鎷夊彇瀹炴椂绯荤粺鐩戞帶">
              鐘舵€?            </button>
            <button type="button" class="btn ${s.status === 'online' ? 'secondary' : 'primary'}" onclick="window.openInstallServerModal('${esc(s.id)}')" style="padding:3px 8px;font-size:11.5px;" title="涓€閿繙绋嬮儴缃叉垨閲嶅惎瀹堟姢鏈嶅姟">
              ${s.status === 'online' ? '閲嶆柊閮ㄧ讲' : '涓€閿畨瑁?}
            </button>
          </div>
          <div style="display:flex;gap:4px;">
            <button type="button" class="btn text-btn" onclick="window.selectTerminalServer('${esc(s.id)}')" style="padding:3px 6px;font-size:12px;" title="鍦ㄧ粓绔腑閫変腑姝ゆ満鍣?>
              缁堢
            </button>
            <button type="button" class="btn text-btn" onclick="window.openServerDialog('${esc(s.id)}')" style="padding:3px 6px;font-size:12px;" title="缂栬緫閰嶇疆">
              缂栬緫
            </button>
            <button type="button" class="btn text-btn danger" onclick="window.deleteServerNode('${esc(s.id)}')" style="padding:3px 6px;font-size:12px;" title="绉婚櫎鑺傜偣">
              鍒犻櫎
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

  $('serverDialogTitle').textContent = isEdit ? '缂栬緫杩滅▼鏈嶅姟鍣ㄩ厤缃? : '娣诲姞杩滅▼鏈嶅姟鍣?;
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

  const agentSelect = $('serverInputAgentId');
  if (agentSelect) {
    const agents = (state.agents && state.agents.length > 0) ? state.agents : [
      { id: 'ops', name: '宸℃涓庤繍缁存櫤鑳戒綋' },
      { id: 'coder', name: '缂栫爜涓庨儴缃叉櫤鑳戒綋' },
    ];
    agentSelect.innerHTML = agents.map(a => `<option value="${esc(a.id)}" ${(server?.agentId || 'ops') === a.id ? 'selected' : ''}>${esc(a.id)} (${esc(a.name || a.description || '鏅鸿兘浣?)})</option>`).join('');
  }

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
    agentId: formData.get('agentId')?.trim() || 'ops',
  };

  try {
    await window.hap.upsertServer(payload);
    $('serverDialog').close();
    showToast(`鏈嶅姟鍣?[${payload.name}] 閰嶇疆淇濆瓨鎴愬姛锛乣, 'success');
    await renderServers();
  } catch (err) {
    showToast(`淇濆瓨澶辫触锛?{err.message}`, 'error');
  }
});

window.testServerNode = async (id) => {
  showToast('姝ｅ湪鎺㈡祴鏈嶅姟鍣ㄨ繛閫氭€?..', 'info');
  try {
    const res = await window.hap.testServer(id);
    if (res.ok) {
      showToast(`杩炴帴鎴愬姛 [${res.mode.toUpperCase()}] 寤惰繜: ${res.latencyMs}ms - ${res.message}`, 'success');
    } else {
      showToast(`杩炴帴澶辫触锛?{res.message}`, 'error');
    }
    await renderServers();
  } catch (err) {
    showToast(`娴嬭瘯寮傚父锛?{err.message}`, 'error');
  }
};

window.fetchServerInfoNode = async (id) => {
  showToast('姝ｅ湪鑾峰彇瀹炴椂绯荤粺璧勬簮鏁版嵁...', 'info');
  try {
    const info = await window.hap.getServerInfo(id);
    showToast(`宸插悓姝ョ郴缁熺姸鎬? CPU ${info.cpuUsagePercent}%, 鍐呭瓨 ${info.usedMemPercent}%`, 'success');
    await renderServers();
  } catch (err) {
    showToast(`鑾峰彇澶辫触锛?{err.message}`, 'error');
  }
};

window.deleteServerNode = async (id) => {
  if (!confirm(`纭畾瑕佺Щ闄ゆ湇鍔″櫒鑺傜偣 [${id}] 鍚楋紵`)) return;
  try {
    await window.hap.removeServer(id);
    showToast(`宸茬Щ闄ゆ湇鍔″櫒鑺傜偣 [${id}]`, 'info');
    await renderServers();
  } catch (err) {
    showToast(`绉婚櫎澶辫触锛?{err.message}`, 'error');
  }
};

window.selectTerminalServer = (id) => {
  activeTerminalServerId = id;
  if ($('terminalServerSelect')) $('terminalServerSelect').value = id;
  if ($('serverOpsTargetSelect')) $('serverOpsTargetSelect').value = id;
  const s = cachedServers.find(item => item.id === id);
  if ($('terminalConsoleTitle')) $('terminalConsoleTitle').textContent = s ? `Console (${s.name} - ${s.host})` : 'Console (Ready)';
  showToast(`宸插垏鎹㈠綋鍓嶇粓绔笌杩愮淮鐩爣涓猴細${s ? s.name : id}`, 'info');
};

$('terminalServerSelect')?.addEventListener('change', (e) => {
  if (e.target.value) {
    window.selectTerminalServer(e.target.value);
  }
});

$('serverOpsTargetSelect')?.addEventListener('change', (e) => {
  if (e.target.value) {
    window.selectTerminalServer(e.target.value);
  }
});

// 蹇€熻烦杞嚦涓诲璇濇祦骞剁粦瀹氳鏈嶅姟鍣ㄧ殑涓撳睘鏅鸿兘浣?window.startServerAgentChat = (serverId, promptText) => {
  const server = cachedServers.find(s => s.id === serverId);
  if (!server) {
    showToast('鏈壘鍒版寚瀹氱殑鏈嶅姟鍣ㄤ俊鎭?, 'error');
    return;
  }

  const agentId = server.agentId || 'ops';
  const sessionTitle = `杩愮淮: ${server.name} (${server.host})`;

  // 瀵绘壘鏄惁瀛樺湪宸叉湁鐨勫悓鍚嶈繍缁翠細璇濓紝鑻ユ棤鍒欐柊寤?  let targetSession = sessions.find(sess => sess.title === sessionTitle);
  if (!targetSession) {
    const newId = 'session_ops_' + Date.now();
    targetSession = {
      id: newId,
      title: sessionTitle,
      projectPath: currentActiveProject,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pinned: true,
      messages: [],
    };
    sessions.unshift(targetSession);
    saveSessionsToStorage();
  }

  currentSessionId = targetSession.id;

  // 鍒囨崲鏅鸿兘浣撻€夋嫨鍣?  const agentSelect = $('chatAgentSelect');
  if (agentSelect) {
    agentSelect.value = agentId;
  }
  const opsAgentSelect = $('serverOpsAgentSelect');
  if (opsAgentSelect) {
    opsAgentSelect.value = agentId;
  }

  show('chat');
  renderProjectsTree();
  renderCurrentSessionMessages();

  if (promptText) {
    const inputEl = $('chatInput');
    if (inputEl) {
      inputEl.value = promptText;
      $('chatForm')?.requestSubmit();
    }
  } else {
    $('chatInput')?.focus();
    showToast(`宸插氨缁細涓撳睘鏅鸿兘浣?[${agentId}] 姝ｅ湪鎺ョ鏈嶅姟鍣?[${server.name}] 杩愮淮浠诲姟`, 'info');
  }
};

window.jumpToServerMainChat = () => {
  const targetId = $('serverOpsTargetSelect')?.value || activeTerminalServerId;
  if (!targetId) {
    showToast('璇峰厛閫夋嫨瑕佽繘琛岃繍缁寸殑鐩爣鏈嶅姟鍣?, 'info');
    return;
  }
  window.startServerAgentChat(targetId);
};

// 瑙﹀彂鏈嶅姟鍣ㄦ櫤鑳借繍缁翠氦浜掑彴鍔ㄤ綔
window.triggerServerOpsQuickAction = async (actionKey) => {
  const targetId = $('serverOpsTargetSelect')?.value || activeTerminalServerId;
  if (!targetId) {
    showToast('璇峰厛閫夋嫨瑕佹墽琛屾櫤鑳借繍缁寸殑鐩爣鏈嶅姟鍣?, 'info');
    return;
  }
  const server = cachedServers.find(s => s.id === targetId);
  if (!server) return;

  const agentId = $('serverOpsAgentSelect')?.value || server.agentId || 'ops';
  let prompt = '';

  switch (actionKey) {
    case 'inspect':
      prompt = `瀵硅繙绋嬫湇鍔″櫒 [${server.id}] (${server.name} - ${server.host}) 杩涜鍏ㄧ洏纭欢涓庤礋杞藉贰妫€锛圕PU銆佸唴瀛樸€佺郴缁熻礋杞姐€佺鐩樹娇鐢ㄧ巼涓?Node 鐜锛夛紝骞剁粰鍑虹患鍚堝仴搴疯瘎浼颁笌浼樺寲寤鸿銆俙;
      break;
    case 'upgrade_daemon':
      prompt = `璇峰府鎴戝崌绾т笌閲嶆柊閮ㄧ讲杩滅▼鏈嶅姟鍣?[${server.id}] (${server.name} - ${server.host}) 涓婄殑 HAP 瀹堟姢杩涚▼锛屼笅鍙戞渶鏂拌剼鏈苟鏍￠獙鍋ュ悍妫€鏌ョ鍙ｄ笌 Token 杩為€氭€с€俙;
      break;
    case 'check_services':
      prompt = `妫€鏌ヨ繙绋嬫湇鍔″櫒 [${server.id}] (${server.name} - ${server.host}) 鐨?systemd 瀹堟姢鏈嶅姟锛坔ap-daemon銆乶ginx銆乨ocker 绛夛級涓庣鍙ｇ洃鍚儏鍐碉紝鎺掓煡鏄惁鏈変换浣曞紓甯稿仠姝㈢殑鏈嶅姟銆俙;
      break;
    case 'clean_disk':
      prompt = `妫€鏌ヨ繙绋嬫湇鍔″櫒 [${server.id}] (${server.name} - ${server.host}) 鐨勭鐩樻寕杞界偣浣跨敤鐜囷紝骞跺府鎴戝畨鍏ㄦ竻鐞?/tmp 涓存椂鏂囦欢銆佹棫鏃ュ織涓庣郴缁熷寘缂撳瓨浠ラ噴鏀剧┖闂淬€俙;
      break;
    case 'diagnose_logs':
      prompt = `鎷夊彇杩滅▼鏈嶅姟鍣?[${server.id}] (${server.name} - ${server.host}) 鏈€杩?50 琛?HAP 瀹堟姢杩涚▼ (hap-daemon) 涓庣郴缁熸湇鍔¤繍琛屾棩蹇楋紝鍒嗘瀽鎶ラ敊鍘熷洜骞剁粰鍑轰慨澶嶆柟妗堛€俙;
      break;
  }

  if (prompt) {
    await window.executeServerOpsPrompt(server, prompt, agentId);
  }
};

window.executeServerOpsPrompt = async (server, prompt, agentId, attachments = []) => {
  const container = $('serverOpsStreamContainer');
  const contentEl = $('serverOpsStreamContent');
  const sendBtn = $('sendServerOpsBtn');
  if (!container || !contentEl) return;

  container.style.display = 'block';
  sendBtn.disabled = true;

  contentEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;color:#6366f1;font-weight:600;margin-bottom:8px;">
      <span class="thinking-pulse-dot"></span>
      <span>姝ｅ湪璋冨害鏅鸿兘浣?[${esc(agentId)}] 杩滅▼宸℃涓庢墽琛岋細${esc(server.name)} (${esc(server.host)})...</span>
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
      reply = '鏅鸿兘浣撳凡鎵ц瀹屾瘯鐩稿叧杩愮淮鎸囦护锛屾湇鍔″凡姝ｅ父鍚屾銆?;
    }

    contentEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border-default);">
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-weight:700;color:#16a34a;">鉁?鏅鸿兘浣?[${esc(agentId)}] 鎵ц瀹屾垚</span>
          <span style="font-size:11px;color:var(--text-muted);">鐩爣: ${esc(server.name)} (${esc(server.host)})</span>
        </div>
        <button type="button" class="btn text-btn" onclick="window.startServerAgentChat('${esc(server.id)}')" style="font-size:11.5px;color:var(--accent);">鍦ㄥ畬鏁翠細璇濅腑缁х画鎻愰棶 鈫?/button>
      </div>
      ${reasoning ? `
        <details class="thinking-box" open style="margin-bottom:10px;">
          <summary class="thinking-header"><span>娣卞害鎬濊€冧笌鎵ц杩囩▼</span></summary>
          <div class="thinking-content">${renderMarkdownContent(reasoning)}</div>
        </details>
      ` : ''}
      <div class="ops-agent-output">${renderMarkdownContent(reply)}</div>
    `;
    container.scrollTop = container.scrollHeight;
    await renderServers();
  } catch (err) {
    contentEl.innerHTML += `<div style="color:#ef4444;margin-top:8px;">[鎵ц澶辫触] ${esc(err.message)}</div>`;
  } finally {
    sendBtn.disabled = false;
  }
};

// 鎻愪氦鏅鸿兘浣撹繍缁磋緭鍏ユ潯
$('serverOpsChatForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const inputEl = $('serverOpsChatInput');
  const text = inputEl.value.trim();
  if (!text) return;

  const targetId = $('serverOpsTargetSelect')?.value || activeTerminalServerId;
  if (!targetId) {
    showToast('璇峰厛閫夋嫨瑕佹墽琛屾櫤鑳借繍缁寸殑鐩爣鏈嶅姟鍣?, 'info');
    return;
  }
  const server = cachedServers.find(s => s.id === targetId);
  if (!server) return;

  const agentId = $('serverOpsAgentSelect')?.value || server.agentId || 'ops';
  inputEl.value = '';
  await window.executeServerOpsPrompt(server, text, agentId);
});

// 涓€閿畨瑁呮祦绋嬮潰鏉?window.openInstallServerModal = async (id) => {
  const server = cachedServers.find(s => s.id === id);
  if (!server) return;

  currentInstallingServerId = id;
  const dialog = $('installServerDialog');
  $('installServerTitle').textContent = `姝ｅ湪涓€閿儴缃?HAP 瀹堟姢杩涚▼`;
  $('installServerSubtitle').textContent = `鐩爣涓绘満锛?{server.name} (${server.host}:${server.port}) - 瀹堟姢绔彛: ${server.daemonPort || 9527}`;
  $('installLogsConsole').textContent = `[System] 鍚姩閮ㄧ讲鍚戝锛屽噯澶囪繛鎺?${server.host}:${server.port} ...\n`;
  $('installProgressBar').style.width = '10%';
  $('installPercentText').textContent = '10%';
  $('installStepText').textContent = '姝ｅ湪鍒濆鍖?SSH 杩炴帴涓庤璇?..';
  $('finishInstallBtn').disabled = true;
  if ($('autoHealServerModalBtn')) $('autoHealServerModalBtn').style.display = 'none';

  const steps = [
    '杩炴帴杩滅▼ SSH 鏈嶅姟',
    '鎺㈡祴鏈嶅姟鍣ㄧ郴缁熸灦鏋勪笌鐜',
    '妫€娴?Node.js 杩愯鏃剁幆澧?,
    '鎸夐渶閰嶇疆/瀹夎 Node.js 杩愯鐜',
    '涓嬪彂 HAP 瀹堟姢杩涚▼鑴氭湰涓庨厤缃?,
    '娉ㄥ唽绯荤粺鏈嶅姟 (systemd / 杩涚▼瀹堟姢)',
    '鏍￠獙瀹堟姢杩涚▼鍋ュ悍鐘舵€佷笌鍙屽悜閫氫俊',
  ];

  function renderStepsUI(currentStepIdx = 0, failed = false) {
    $('installStepsList').innerHTML = steps.map((name, idx) => {
      let iconClass = 'pending';
      let iconText = (idx + 1).toString();
      if (idx < currentStepIdx) {
        iconClass = 'success';
        iconText = '鉁?;
      } else if (idx === currentStepIdx) {
        iconClass = failed ? 'failed' : 'running';
        iconText = failed ? '鉁? : '...';
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

  // 缁戝畾瀹炴椂杩涘害鐩戝惉
  window.hap.removeInstallProgressListeners?.();
  window.hap.onInstallProgress?.((event) => {
    const pct = Math.min(100, Math.round((event.stepIndex / event.totalSteps) * 100));
    $('installProgressBar').style.width = `${pct}%`;
    $('installPercentText').textContent = `${pct}%`;
    $('installStepText').textContent = `姝ラ ${event.stepIndex}/${event.totalSteps}: ${event.message}`;
    
    renderStepsUI(event.stepIndex - 1, event.status === 'failed');

    const icon = event.status === 'success' ? '[OK]' : event.status === 'failed' ? '[FAIL]' : '[RUN]';
    appendLog(`[${event.stepIndex}/${event.totalSteps}] ${icon} ${event.message}`);
    if (event.details) {
      appendLog(`    鈫?${event.details}`);
    }
  });

  try {
    appendLog(`[SSH] 姝ｅ湪閫氳繃 ${server.authType} 鏂瑰紡杩炴帴鐩爣涓绘満 ${server.host}:${server.port}...`);
    const res = await window.hap.installServer(id);
    if (res.ok) {
      $('installProgressBar').style.width = '100%';
      $('installPercentText').textContent = '100%';
      $('installStepText').textContent = '閮ㄧ讲瀹屾垚锛丠AP Agent 瀹堟姢鏈嶅姟宸插湪绾裤€?;
      renderStepsUI(steps.length);
      appendLog(`\n[Success] 閮ㄧ讲鎴愬姛锛侀€氫俊绔彛: ${res.daemonPort}, Token: ${res.token}`);
      showToast('杩滅 Agent 瀹堟姢杩涚▼閮ㄧ讲鎴愬姛锛?, 'success');
      $('finishInstallBtn').disabled = false;
      if ($('autoHealServerModalBtn')) $('autoHealServerModalBtn').style.display = 'none';
      await renderServers();
    } else {
      $('installProgressBar').style.width = '100%';
      $('installProgressBar').style.background = '#ef4444';
      $('installPercentText').textContent = '澶辫触';
      $('installStepText').textContent = `閮ㄧ讲缁堟锛?{res.error || '鏈煡寮傚父'}`;
      appendLog(`\n[Error] 閮ㄧ讲澶辫触锛?{res.error}`);
      showToast(`閮ㄧ讲澶辫触锛?{res.error}`, 'error');
      $('finishInstallBtn').disabled = false;
      if ($('autoHealServerModalBtn')) $('autoHealServerModalBtn').style.display = 'inline-block';
      await renderServers();
    }
  } catch (err) {
    appendLog(`\n[Exception] ${err.message}`);
    showToast(`閮ㄧ讲寮傚父锛?{err.message}`, 'error');
    $('finishInstallBtn').disabled = false;
    if ($('autoHealServerModalBtn')) $('autoHealServerModalBtn').style.display = 'inline-block';
    await renderServers();
  } finally {
    window.hap.removeInstallProgressListeners?.();
  }
};

window.callAgentAutoHealServer = () => {
  const dialog = $('installServerDialog');
  if (dialog) dialog.close();
  const server = cachedServers.find(s => s.id === currentInstallingServerId);
  if (!server) return;

  const logs = $('installLogsConsole')?.textContent || '';
  const prompt = `鎴戝垰鎵嶅湪閮ㄧ讲/鍗囩骇杩滅▼鏈嶅姟鍣?[${server.id}] (${server.name} - ${server.host}) 鐨?HAP 瀹堟姢杩涚▼鏃堕亣鍒伴敊璇紝璇峰府鎴戝垎鏋愪互涓嬮儴缃蹭笌绯荤粺鏃ュ織锛屾帓鏌ラ敊璇牴鍥犲苟鑷姩淇鍗囩骇锛歕n\`\`\`\n${logs}\n\`\`\``;
  window.startServerAgentChat(server.id, prompt);
};

$('closeInstallDialogBtn')?.addEventListener('click', () => $('installServerDialog').close());
$('finishInstallBtn')?.addEventListener('click', () => $('installServerDialog').close());

// 杩滅▼缁堢 Shell 鎵ц
$('remoteExecForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('remoteCommandInput');
  const command = input.value.trim();
  if (!command) return;

  const targetId = $('terminalServerSelect')?.value || activeTerminalServerId;
  if (!targetId) {
    showToast('璇峰厛閫夋嫨瑕佹墽琛屽懡浠ょ殑鐩爣鏈嶅姟鍣?, 'info');
    return;
  }

  const server = cachedServers.find(s => s.id === targetId);
  const outEl = $('remoteTerminalOutput');
  const durationEl = $('terminalDuration');
  const execBtn = $('execRemoteCmdBtn');

  execBtn.disabled = true;
  outEl.textContent = `[${server ? server.name : targetId}]$ ${command}\n姝ｅ湪鎵ц...\n`;
  durationEl.textContent = '鎵ц涓?..';

  try {
    const startTime = Date.now();
    const res = await window.hap.execServerCommand({ id: targetId, command });
    const duration = Date.now() - startTime;
    durationEl.textContent = `${duration}ms`;

    let fullOutput = '';
    if (res.stdout) fullOutput += res.stdout;
    if (res.stderr) fullOutput += (fullOutput ? '\n' : '') + '[stderr] ' + res.stderr;
    if (!fullOutput) fullOutput = `(鍛戒护宸叉墽琛屽畬姣曪紝閫€鍑虹爜: ${res.code})`;

    outEl.textContent = `[${server ? server.name : targetId}]$ ${command}\n\n${fullOutput}\n\n[Process exited with code ${res.code} in ${duration}ms]`;
    outEl.scrollTop = outEl.scrollHeight;
  } catch (err) {
    outEl.textContent += `\n[Error] 鎵ц澶辫触锛?{err.message}`;
    showToast(`鎵ц澶辫触锛?{err.message}`, 'error');
  } finally {
    execBtn.disabled = false;
  }
});

// 蹇嵎鎸囦护鎸夐挳鐐瑰嚮
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
  if ($('remoteTerminalOutput')) $('remoteTerminalOutput').textContent = '# 缁堢宸叉竻灞廫n';
  if ($('terminalDuration')) $('terminalDuration').textContent = '0ms';
});

$('addServerBtn')?.addEventListener('click', () => window.openServerDialog());
$('refreshServersBtn')?.addEventListener('click', async () => {
  showToast('姝ｅ湪鍒锋柊鏈嶅姟鍣ㄧ姸鎬?..', 'info');
  await renderServers();
  showToast('鏈嶅姟鍣ㄧ姸鎬佸凡鏇存柊', 'success');
});

// ==========================================================================
// 瀹氭椂宸ヤ綔娴佷笌涓诲姩浠诲姟璋冨害鎺у埗鍣?(Schedules Controller)
// ==========================================================================

let cachedSchedules = [];

async function renderSchedules() {
  const listEl = $('schedulesList');
  const activeCountEl = $('schedActiveCount');
  const totalCountEl = $('schedTotalCount');
  if (!listEl) return;

  try {
    cachedSchedules = await window.hap.listSchedules();
  } catch {
    cachedSchedules = [];
  }

  const activeCount = cachedSchedules.filter(j => j.enabled).length;
  if (activeCountEl) activeCountEl.textContent = String(activeCount);
  if (totalCountEl) totalCountEl.textContent = String(cachedSchedules.length);

  if (cachedSchedules.length === 0) {
    listEl.innerHTML = `
      <div class="card" style="grid-column: 1 / -1; text-align: center; padding: 42px 20px; color: var(--text-secondary);">
        <div style="font-size: 32px; margin-bottom: 12px; display: flex; justify-content: center;">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
        </div>
        <div style="font-weight: 700; font-size: 15px; color: var(--text-main); margin-bottom: 6px;">灏氭湭閰嶇疆浠讳綍瀹氭椂宸ヤ綔娴?/div>
        <div style="font-size: 13px; max-width: 440px; margin: 0 auto 18px auto; line-height: 1.5;">
          璁剧疆 Cron 鏃堕棿鍛ㄦ湡锛堝姣忓ぉ鏃╂櫒 9:00銆佸伐浣滄棩鏅氶棿鎴栨瘡鍗婂皬鏃讹級锛岃鏅鸿兘浣撲富鍔ㄦ媺鍙栦唬鐮併€佺敓鎴愬鏌ユ棩鎶ユ垨鐩戞帶鎶ヨ銆?        </div>
        <button type="button" class="btn primary" onclick="window.openScheduleModal()" style="margin:0 auto;">
          + 鍒涘缓绗竴涓畾鏃跺伐浣滄祦
        </button>
      </div>
    `;
  } else {
    listEl.innerHTML = cachedSchedules.map((j) => {
      const channelLabels = {
        wechat: '寰俊',
        telegram: 'TG',
        logs: '鏃ュ織',
      };
      const channelsHtml = (j.notifyChannels || ['logs']).map(c => `<span class="badge neutral" style="font-size:11px;">${channelLabels[c] || c}</span>`).join(' ');
      const lastRunText = j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : '鏈Е鍙戣繃';
      const statusBadge = j.lastStatus === 'success' ? '<span class="badge success" style="font-size:11px;">[鎴愬姛]</span>' :
                          j.lastStatus === 'failed' ? '<span class="badge danger" style="font-size:11px;">[澶辫触]</span>' : '<span class="badge neutral" style="font-size:11px;">寰呰繍琛?/span>';

      return `
        <div class="schedule-card ${j.enabled ? '' : 'disabled'}" id="schedule-card-${esc(j.id)}">
          <div class="schedule-card-header">
            <div>
              <div style="font-weight:700;font-size:14px;color:var(--text-main);">${esc(j.name)}</div>
              <div style="font-size:11.5px;color:var(--text-secondary);margin-top:2px;">鏅鸿兘浣? <strong>${esc(j.agent)}</strong></div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <button type="button" class="btn text-btn" onclick="window.toggleScheduleEnabled('${esc(j.id)}')" style="font-size:12px;">
                ${j.enabled ? '[杩愯涓璢' : '[宸叉殏鍋淽'}
              </button>
            </div>
          </div>

          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span class="schedule-cron-badge">${esc(j.cron)}</span>
            <div style="display:flex;gap:4px;">${channelsHtml}</div>
          </div>

          <div style="background:#f8fafc;padding:8px 10px;border-radius:6px;border:1px solid #e2e8f0;font-size:12px;color:#334155;line-height:1.5;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">
            ${esc(j.prompt)}
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:var(--text-muted);border-top:1px solid var(--border-default);padding-top:8px;margin-top:auto;">
            <div>涓婃: ${lastRunText} ${statusBadge}</div>
            <div style="display:flex;gap:6px;">
              <button type="button" class="btn secondary" onclick="window.runScheduleManually('${esc(j.id)}')" style="font-size:11.5px;padding:3px 8px;">
                绔嬪嵆杩愯
              </button>
              <button type="button" class="btn secondary" onclick="window.editScheduleJob('${esc(j.id)}')" style="font-size:11.5px;padding:3px 8px;">
                缂栬緫
              </button>
              <button type="button" class="btn text-btn" onclick="window.deleteScheduleJob('${esc(j.id)}')" style="font-size:11.5px;padding:3px 6px;color:#dc2626;">
                鍒犻櫎
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // 娓叉煋鍘嗗彶璁板綍
  await renderScheduleHistory();
}

async function renderScheduleHistory() {
  const historyListEl = $('scheduleHistoryList');
  if (!historyListEl) return;

  try {
    const history = await window.hap.getScheduleHistory();
    if (!history || history.length === 0) {
      historyListEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">鏆傛棤鍘嗗彶鎵ц璁板綍</div>';
      return;
    }

    historyListEl.innerHTML = history.slice(0, 30).map((h) => {
      const isSuccess = h.status === 'success';
      return `
        <div class="schedule-history-item">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="badge ${isSuccess ? 'success' : 'danger'}" style="font-size:11px;">
              ${isSuccess ? '鉁?鎴愬姛' : '鉁?澶辫触'}
            </span>
            <strong>${esc(h.scheduleName)}</strong>
            <span style="color:var(--text-muted);font-size:11.5px;">(${esc(h.agent)})</span>
          </div>
          <div style="display:flex;align-items:center;gap:12px;font-size:11.5px;color:var(--text-secondary);">
            <span>鑰楁椂: ${h.durationMs}ms</span>
            <span>${new Date(h.finishedAt).toLocaleString()}</span>
          </div>
        </div>
      `;
    }).join('');
  } catch {
    historyListEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">鑾峰彇鍘嗗彶璁板綍澶辫触</div>';
  }
}

window.openScheduleModal = (jobId) => {
  const modal = $('scheduleModal');
  const form = $('scheduleForm');
  const agentSelect = $('schedInputAgent');
  const wsSelect = $('schedWorkspaceSelect');
  const delBtn = $('deleteScheduleBtn');
  if (!modal || !form) return;

  // 濉厖 agents 涓?workspaces 涓嬫媺鍒楄〃
  if (agentSelect) {
    const agents = state?.agents || [];
    agentSelect.innerHTML = agents.map(a => `<option value="${esc(a.id)}">${esc(a.name || a.id)} (${esc(a.id)})</option>`).join('');
  }
  if (wsSelect) {
    const projects = state?.projects || [];
    wsSelect.innerHTML = '<option value="">-- 鍏ㄥ眬/涓嶇粦瀹氱壒瀹氬伐绋?--</option>' +
      projects.map(p => `<option value="${esc(p.path)}">${esc(p.name)} (${esc(p.path)})</option>`).join('');
  }

  const job = jobId ? cachedSchedules.find(j => j.id === jobId) : null;
  if (job) {
    $('scheduleModalTitle').textContent = `缂栬緫瀹氭椂宸ヤ綔娴? ${job.name}`;
    $('schedInputId').value = job.id;
    $('schedInputName').value = job.name;
    if (agentSelect) agentSelect.value = job.agent;
    $('schedInputCron').value = job.cron;
    $('schedInputPrompt').value = job.prompt;
    if (wsSelect && job.workspace) wsSelect.value = job.workspace;
    if ($('schedNotifyWeChat')) $('schedNotifyWeChat').checked = (job.notifyChannels || []).includes('wechat');
    if ($('schedNotifyTelegram')) $('schedNotifyTelegram').checked = (job.notifyChannels || []).includes('telegram');
    if ($('schedNotifyLogs')) $('schedNotifyLogs').checked = (job.notifyChannels || []).includes('logs');
    if (delBtn) delBtn.style.display = 'block';
  } else {
    $('scheduleModalTitle').textContent = '鍒涘缓瀹氭椂宸ヤ綔娴?(Cron Workflow)';
    form.reset();
    $('schedInputId').value = '';
    $('schedInputCron').value = '0 9 * * *';
    if ($('schedNotifyWeChat')) $('schedNotifyWeChat').checked = true;
    if ($('schedNotifyLogs')) $('schedNotifyLogs').checked = true;
    if (delBtn) delBtn.style.display = 'none';
  }

  modal.showModal();
};

window.editScheduleJob = (id) => window.openScheduleModal(id);

window.toggleScheduleEnabled = async (id) => {
  try {
    const job = await window.hap.toggleSchedule(id);
    showToast(`瀹氭椂浠诲姟 [${job.name}] 宸?{job.enabled ? '鍚敤' : '鏆傚仠'}`, 'success');
    await renderSchedules();
  } catch (err) {
    showToast('鐘舵€佹洿鏂板け璐? ' + err.message, 'error');
  }
};

window.runScheduleManually = async (id) => {
  showToast('姝ｅ湪鎵嬪姩鎷夎捣瀹氭椂宸ヤ綔娴?..', 'info');
  try {
    const res = await window.hap.runScheduleNow(id);
    if (res.status === 'success') {
      showToast(`浠诲姟鎵ц鎴愬姛 (鑰楁椂: ${res.durationMs}ms)`, 'success');
    } else {
      showToast(`浠诲姟鎵ц澶辫触: ${res.error}`, 'error');
    }
    await renderSchedules();
  } catch (err) {
    showToast('鎵ц澶辫触: ' + err.message, 'error');
  }
};

window.deleteScheduleJob = async (id) => {
  if (!confirm('纭畾瑕佸垹闄ゆ瀹氭椂宸ヤ綔娴佸悧锛?)) return;
  try {
    await window.hap.removeSchedule(id);
    showToast('瀹氭椂浠诲姟宸插垹闄?, 'success');
    await renderSchedules();
  } catch (err) {
    showToast('鍒犻櫎澶辫触: ' + err.message, 'error');
  }
};

$('openAddScheduleModalBtn')?.addEventListener('click', () => window.openScheduleModal());
$('closeScheduleModalBtn')?.addEventListener('click', () => $('scheduleModal')?.close());
$('cancelScheduleModalBtn')?.addEventListener('click', () => $('scheduleModal')?.close());
$('refreshScheduleHistoryBtn')?.addEventListener('click', () => renderScheduleHistory());

$('deleteScheduleBtn')?.addEventListener('click', async () => {
  const id = $('schedInputId')?.value;
  if (id) {
    await window.deleteScheduleJob(id);
    $('scheduleModal')?.close();
  }
});

$('schedCronPresetSelect')?.addEventListener('change', (e) => {
  const val = e.target.value;
  if (val && $('schedInputCron')) {
    $('schedInputCron').value = val;
  }
});

$('scheduleForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('schedInputId')?.value || undefined;
  const name = $('schedInputName')?.value || '';
  const agent = $('schedInputAgent')?.value || 'coder';
  const cron = $('schedInputCron')?.value || '0 9 * * *';
  const prompt = $('schedInputPrompt')?.value || '';
  const workspace = $('schedWorkspaceSelect')?.value || undefined;

  const notifyChannels = [];
  if ($('schedNotifyWeChat')?.checked) notifyChannels.push('wechat');
  if ($('schedNotifyTelegram')?.checked) notifyChannels.push('telegram');
  if ($('schedNotifyLogs')?.checked) notifyChannels.push('logs');

  try {
    await window.hap.upsertSchedule({
      id,
      name,
      agent,
      cron,
      prompt,
      workspace,
      notifyChannels,
      enabled: true,
    });
    showToast(`瀹氭椂宸ヤ綔娴?[${name}] 宸叉垚鍔熶繚瀛橈紒`, 'success');
    $('scheduleModal')?.close();
    await renderSchedules();
  } catch (err) {
    showToast('淇濆瓨澶辫触: ' + err.message, 'error');
  }
});

// ==========================================================================
// MCP 宸ュ叿鍙鍖栬皟璇曞彴鎺у埗鍣?(MCP Tool Playground)
// ==========================================================================

let mcpPlaygroundServers = [];

window.openMcpPlayground = async () => {
  const modal = $('mcpPlaygroundModal');
  const serverSelect = $('mcpPlaygroundServerSelect');
  if (!modal || !serverSelect) return;

  try {
    const plugins = state?.plugins || [];
    mcpPlaygroundServers = plugins.filter(p => p.enabled);
  } catch {
    mcpPlaygroundServers = [];
  }

  if (mcpPlaygroundServers.length === 0) {
    showToast('鏆傛棤鍚敤鐨?MCP 鎻掍欢锛岃鍏堝湪鎻掍欢甯傚満鍚敤鎴栨坊鍔?MCP 鎻掍欢', 'info');
    return;
  }

  serverSelect.innerHTML = mcpPlaygroundServers.map(s => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.id)})</option>`).join('');
  updateMcpToolsDropdown();
  modal.showModal();
};

function updateMcpToolsDropdown() {
  const toolSelect = $('mcpPlaygroundToolSelect');
  const descEl = $('mcpToolDescriptionText');
  const argsInput = $('mcpToolArgsInput');
  if (!toolSelect) return;

  const sampleTools = [
    { name: 'read_file', desc: '璇诲彇鎸囧畾宸ョ▼鏂囦欢鍐呭', sample: { path: 'package.json' } },
    { name: 'list_dir', desc: '鍒楀嚭鎸囧畾鐩綍缁撴瀯涓庢枃浠?, sample: { path: 'src' } },
    { name: 'search', desc: '鍦ㄥ綋鍓嶄唬鐮佸簱涓悳绱㈠叧閿瘝', sample: { query: 'export function' } },
    { name: 'shell', desc: '鍦ㄥ綋鍓嶉」鐩伐浣滃尯鎵ц鍛戒护', sample: { command: 'git status' } },
    { name: 'http_fetch', desc: '鍙戣捣 HTTP 璇锋眰鎶撳彇缃戠粶鍐呭', sample: { url: 'https://httpbin.org/get' } },
  ];

  toolSelect.innerHTML = sampleTools.map(t => `<option value="${esc(t.name)}">${esc(t.name)} - ${esc(t.desc)}</option>`).join('');

  if (descEl) descEl.textContent = sampleTools[0]?.desc || '宸ュ叿璋冪敤鍙傛暟璋冭瘯';
  if (argsInput) argsInput.value = JSON.stringify(sampleTools[0]?.sample || {}, null, 2);
}

$('mcpPlaygroundServerSelect')?.addEventListener('change', updateMcpToolsDropdown);
$('mcpPlaygroundToolSelect')?.addEventListener('change', () => {
  const toolSelect = $('mcpPlaygroundToolSelect');
  const argsInput = $('mcpToolArgsInput');
  const descEl = $('mcpToolDescriptionText');
  if (!toolSelect) return;

  const sampleMap = {
    read_file: { desc: '璇诲彇鎸囧畾宸ョ▼鏂囦欢鍐呭', sample: { path: 'package.json' } },
    list_dir: { desc: '鍒楀嚭鎸囧畾鐩綍缁撴瀯涓庢枃浠?, sample: { path: 'src' } },
    search: { desc: '鍦ㄥ綋鍓嶄唬鐮佸簱涓悳绱㈠叧閿瘝', sample: { query: 'export function' } },
    shell: { desc: '鍦ㄥ綋鍓嶉」鐩伐浣滃尯鎵ц鍛戒护', sample: { command: 'git status' } },
    http_fetch: { desc: '鍙戣捣 HTTP 璇锋眰鎶撳彇缃戠粶鍐呭', sample: { url: 'https://httpbin.org/get' } },
  };

  const selected = sampleMap[toolSelect.value];
  if (selected) {
    if (descEl) descEl.textContent = selected.desc;
    if (argsInput) argsInput.value = JSON.stringify(selected.sample, null, 2);
  }
});

$('openMcpPlaygroundBtn')?.addEventListener('click', () => window.openMcpPlayground());
$('closeMcpPlaygroundBtn')?.addEventListener('click', () => $('mcpPlaygroundModal')?.close());
$('closeMcpPlaygroundFooterBtn')?.addEventListener('click', () => $('mcpPlaygroundModal')?.close());

$('mcpFillSampleJsonBtn')?.addEventListener('click', () => {
  const toolSelect = $('mcpPlaygroundToolSelect');
  const argsInput = $('mcpToolArgsInput');
  if (toolSelect && argsInput) {
    const sampleMap = {
      read_file: { path: 'package.json' },
      list_dir: { path: 'src' },
      search: { query: 'export' },
      shell: { command: 'git log -n 3' },
      http_fetch: { url: 'https://httpbin.org/get' },
    };
    argsInput.value = JSON.stringify(sampleMap[toolSelect.value] || {}, null, 2);
  }
});

$('executeMcpToolBtn')?.addEventListener('click', async () => {
  const toolSelect = $('mcpPlaygroundToolSelect');
  const argsInput = $('mcpToolArgsInput');
  const outputBox = $('mcpToolOutputBox');
  const durationText = $('mcpExecDurationText');
  if (!toolSelect || !argsInput || !outputBox) return;

  const toolName = toolSelect.value;
  let parsedArgs = {};
  try {
    parsedArgs = JSON.parse(argsInput.value || '{}');
  } catch (err) {
    showToast('JSON 鍙傛暟瑙ｆ瀽澶辫触: ' + err.message, 'error');
    return;
  }

  outputBox.textContent = '// 姝ｅ湪鍙戣捣宸ュ叿璋冪敤...';
  const start = Date.now();

  try {
    const res = await window.hap.chat({
      input: `/tool ${toolName} ${JSON.stringify(parsedArgs)}`,
      projectPath: currentActiveProject || undefined,
    });
    const dur = Date.now() - start;
    if (durationText) durationText.textContent = `鑰楁椂: ${dur}ms`;
    outputBox.textContent = typeof res === 'object' ? JSON.stringify(res, null, 2) : String(res);
    showToast('宸ュ叿璋冭瘯璋冪敤鎴愬姛锛?, 'success');
  } catch (err) {
    const dur = Date.now() - start;
    if (durationText) durationText.textContent = `鑰楁椂: ${dur}ms (閿欒)`;
    outputBox.textContent = `Error: ${err.message}`;
    showToast('璋冪敤澶辫触锛? + err.message, 'error');
  }
});

// ==========================================================================
// 鍚戦噺闀挎湡璁板繂搴撲笌鍋忓ソ鐭ヨ瘑鎺у埗鍣?(Vector Memory Controller)
// ==========================================================================

let cachedMemories = [];
let activeMemoryCategoryFilter = '';

async function renderMemories(searchQuery = '', categoryFilter = activeMemoryCategoryFilter) {
  const listEl = $('memoriesList');
  if (!listEl) return;

  try {
    if (searchQuery && searchQuery.trim()) {
      const searchResults = await window.hap.searchMemories(searchQuery.trim(), 20);
      cachedMemories = (searchResults || []).map(r => ({ ...r.memory, score: r.score }));
    } else {
      cachedMemories = await window.hap.listMemories(categoryFilter || undefined);
    }
  } catch {
    cachedMemories = [];
  }

  if (categoryFilter) {
    cachedMemories = cachedMemories.filter(m => m.category === categoryFilter);
  }

  if (cachedMemories.length === 0) {
    listEl.innerHTML = `
      <div class="card" style="grid-column: 1 / -1; text-align: center; padding: 42px 20px; color: var(--text-secondary);">
        <div style="font-size: 32px; margin-bottom: 12px; display: flex; justify-content: center;">
          <span style="font-size:36px;">馃</span>
        </div>
        <div style="font-weight: 700; font-size: 15px; color: var(--text-main); margin-bottom: 6px;">闀挎湡璁板繂搴撴殏鏃犲尮閰嶈褰?/div>
        <div style="font-size: 13px; max-width: 440px; margin: 0 auto 18px auto; line-height: 1.5;">
          鏅鸿兘浣撲細鏍规嵁姣忔瀵硅瘽鑷姩鎻愮偧鐢ㄦ埛涔犳儻涓庢灦鏋勭害瀹氾紝鎮ㄤ篃鍙互鐐瑰嚮涓嬫柟鎸夐挳涓诲姩娣诲姞銆?        </div>
        <button type="button" class="btn primary" onclick="window.openMemoryModal()" style="margin:0 auto;">
          + 娣诲姞绗竴鏉″亸濂戒笌瑙勮寖
        </button>
      </div>
    `;
    return;
  }

  const categoryMap = {
    preference: { text: '鐢ㄦ埛涔犳儻', color: '#10a37f', bg: '#ecfdf5' },
    architecture: { text: '鏋舵瀯绾﹀畾', color: '#2563eb', bg: '#eff6ff' },
    fact: { text: '棰嗗煙浜嬪疄', color: '#d97706', bg: '#fffbeb' },
    case: { text: '鏃㈠線妗堜緥', color: '#7c3aed', bg: '#f5f3ff' },
  };

  listEl.innerHTML = cachedMemories.map((m) => {
    const cat = categoryMap[m.category] || { text: m.category, color: '#475569', bg: '#f1f5f9' };
    const tagsHtml = (m.tags || []).map(t => `<span class="badge neutral" style="font-size:11px;">#${esc(t)}</span>`).join(' ');
    const scoreBadge = m.score !== undefined ? `<span class="badge success" style="font-size:11px;">鐩镐技搴? ${(m.score * 100).toFixed(0)}%</span>` : '';

    return `
      <div class="card" style="display:flex;flex-direction:column;gap:10px;padding:16px;" id="memory-card-${esc(m.id)}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div>
            <div style="font-weight:700;font-size:14px;color:var(--text-main);">${esc(m.title)}</div>
            <div style="display:flex;gap:6px;align-items:center;margin-top:4px;">
              <span class="badge" style="background:${cat.bg};color:${cat.color};border:1px solid ${cat.color};font-size:11px;font-weight:600;">${cat.text}</span>
              ${scoreBadge}
            </div>
          </div>
          <button type="button" class="btn text-btn" onclick="window.deleteMemoryCard('${esc(m.id)}')" style="font-size:11.5px;color:#dc2626;padding:2px 6px;">
            鍒犻櫎
          </button>
        </div>

        <div style="background:#f8fafc;padding:10px 12px;border-radius:6px;border:1px solid #e2e8f0;font-size:12.5px;color:#334155;line-height:1.55;white-space:pre-wrap;word-break:break-all;">
          ${esc(m.content)}
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:var(--text-muted);border-top:1px solid var(--border-default);padding-top:8px;margin-top:auto;">
          <div style="display:flex;gap:4px;flex-wrap:wrap;">${tagsHtml || '<span style="font-style:italic;">鏃犳爣绛?/span>'}</div>
          <div>鍛戒腑 ${m.accessCount || 0} 娆?/div>
        </div>
      </div>
    `;
  }).join('');
}

window.openMemoryModal = () => {
  const modal = $('memoryModal');
  const form = $('memoryForm');
  if (!modal || !form) return;
  form.reset();
  modal.showModal();
};

window.deleteMemoryCard = async (id) => {
  if (!confirm('纭畾瑕佸垹闄ゆ鏉￠暱鏈熻蹇嗗悧锛?)) return;
  try {
    await window.hap.removeMemory(id);
    showToast('璁板繂宸插垹闄?, 'success');
    await renderMemories();
  } catch (err) {
    showToast('鍒犻櫎澶辫触: ' + err.message, 'error');
  }
};

$('openAddMemoryModalBtn')?.addEventListener('click', () => window.openMemoryModal());
$('closeMemoryModalBtn')?.addEventListener('click', () => $('memoryModal')?.close());
$('cancelMemoryModalBtn')?.addEventListener('click', () => $('memoryModal')?.close());

let memorySearchTimer = null;
$('memorySearchInput')?.addEventListener('input', (e) => {
  if (memorySearchTimer) clearTimeout(memorySearchTimer);
  memorySearchTimer = setTimeout(() => {
    renderMemories(e.target.value);
  }, 250);
});

document.querySelectorAll('#memoryCategoryFilters .filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#memoryCategoryFilters .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeMemoryCategoryFilter = btn.dataset.category || '';
    renderMemories($('memorySearchInput')?.value || '', activeMemoryCategoryFilter);
  });
});

$('memoryForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('memoryInputTitle')?.value || '';
  const category = $('memoryInputCategory')?.value || 'preference';
  const tagsStr = $('memoryInputTags')?.value || '';
  const content = $('memoryInputContent')?.value || '';

  const tags = tagsStr.split(/[,锛孿s]+/).map(t => t.trim()).filter(Boolean);

  try {
    await window.hap.addMemory({
      title,
      category,
      tags,
      content,
      workspace: currentActiveProject || undefined,
    });
    showToast(`闀挎湡璁板繂 [${title}] 宸叉垚鍔熶繚瀛橈紒`, 'success');
    $('memoryModal')?.close();
    await renderMemories();
  } catch (err) {
    showToast('淇濆瓨澶辫触: ' + err.message, 'error');
  }
});

// ==========================================================================
// 瀹夸富涓绘満瀹炴椂鐘舵€佺洃鎺ф帶鍒跺櫒 (Host System Status Controller)
// ==========================================================================

function fmtHostBytes(bytes, decimals = 1) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

function fmtHostUptime(seconds) {
  if (!seconds || seconds <= 0) return '0绉?;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}澶ー);
  if (h > 0 || d > 0) parts.push(`${h}灏忔椂`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}鍒哷);
  parts.push(`${s}绉抈);
  return parts.join(' ');
}

async function renderHostView() {
  try {
    const info = await window.hap.getHostSysInfo();
    if (!info || !info.cpu || !info.memory) return;

    // CPU 鎸囨爣
    const cpuPct = info.cpu.usagePercent || 0;
    if ($('hostCpuPercent')) $('hostCpuPercent').textContent = `${cpuPct}%`;
    if ($('hostCpuBar')) {
      $('hostCpuBar').style.width = `${cpuPct}%`;
      $('hostCpuBar').style.background = cpuPct > 85 ? '#ef4444' : cpuPct > 60 ? '#f59e0b' : '#3b82f6';
    }
    if ($('hostCpuCoresBadge')) $('hostCpuCoresBadge').textContent = `${info.cpu.cores} 鏍稿績 (${info.cpu.speedMHz} MHz)`;
    if ($('hostCpuModel')) $('hostCpuModel').textContent = info.cpu.model;

    // 鍐呭瓨鎸囨爣
    const memPct = info.memory.usedPercent || 0;
    if ($('hostMemUsed')) $('hostMemUsed').textContent = fmtHostBytes(info.memory.usedBytes);
    if ($('hostMemTotal')) $('hostMemTotal').textContent = `鎬婚噺: ${fmtHostBytes(info.memory.totalBytes)} | 绌洪棽: ${fmtHostBytes(info.memory.freeBytes)}`;
    if ($('hostMemPercentBadge')) {
      $('hostMemPercentBadge').textContent = `${memPct}%`;
      $('hostMemPercentBadge').className = `badge ${memPct > 85 ? 'danger' : memPct > 60 ? 'warn' : 'success'}`;
    }
    if ($('hostMemBar')) {
      $('hostMemBar').style.width = `${memPct}%`;
      $('hostMemBar').style.background = memPct > 85 ? '#ef4444' : memPct > 60 ? '#f59e0b' : '#10b981';
    }

    // 杩涚▼鍐呭瓨
    if ($('hostProcessRss')) $('hostProcessRss').textContent = fmtHostBytes(info.memory.processRssBytes);
    if ($('hostProcessHeap')) $('hostProcessHeap').textContent = `鍫嗙敤閲? ${fmtHostBytes(info.memory.processHeapUsedBytes)} / ${fmtHostBytes(info.memory.processHeapTotalBytes)}`;
    if ($('hostProcessPid')) $('hostProcessPid').textContent = `杩涚▼ PID: ${info.os.pid}`;

    // Uptime
    if ($('hostSystemUptime')) $('hostSystemUptime').textContent = fmtHostUptime(info.os.uptimeSeconds);
    if ($('hostProcessUptime')) $('hostProcessUptime').textContent = `Codex 鏈嶅姟杩愯: ${fmtHostUptime(info.os.processUptimeSeconds)}`;
    if ($('hostTimestamp')) $('hostTimestamp').textContent = `鏇存柊浜? ${new Date(info.timestamp).toLocaleTimeString()}`;

    // 鎿嶄綔绯荤粺涓庣幆澧冭鎯?    if ($('hostHostname')) $('hostHostname').textContent = info.network.hostname;
    if ($('hostUsername')) $('hostUsername').textContent = info.os.user;
    if ($('hostOsFull')) $('hostOsFull').textContent = `${info.os.type} ${info.os.release} (${info.os.platform})`;
    if ($('hostArch')) $('hostArch').textContent = info.os.arch;
    if ($('hostNodeVersion')) $('hostNodeVersion').textContent = info.os.nodeVersion;

    // 缃戠粶 IP 鍒楄〃
    const netListEl = $('hostNetworkList');
    if (netListEl) {
      if (!info.network.ips || info.network.ips.length === 0) {
        netListEl.innerHTML = '<div style="color:var(--text-muted); font-size:12px; padding:6px 0;">鏃犳椿璺冪墿鐞嗘垨灞€鍩熺綉 IPv4 鎺ュ彛</div>';
      } else {
        netListEl.innerHTML = info.network.ips.map(ip => `
          <div style="display:flex; justify-content:space-between; align-items:center; background:#f8fafc; padding:8px 12px; border-radius:6px; border:1px solid #e2e8f0; font-size:12.5px;">
            <span style="font-weight:600; color:var(--text-main);">${esc(ip.interface)}</span>
            <span style="font-family:monospace; background:#e0f2fe; color:#0369a1; padding:2px 8px; border-radius:4px; font-weight:600;">${esc(ip.address)}</span>
          </div>
        `).join('');
      }
    }

    // 鍔犺浇 IP 鍦扮悊浣嶇疆锛堝垵娆℃垨瀹氭椂鍒锋柊锛?    loadHostIpGeo().catch(() => {});
  } catch (err) {
    console.error('鑾峰彇涓绘満鐘舵€佸け璐?', err);
  }
}

let lastHostIpGeo = null;
async function loadHostIpGeo() {
  try {
    const geo = await window.hap.getIpGeoInfo();
    lastHostIpGeo = geo;
    if ($('hostIpGeoBadge')) {
      $('hostIpGeoBadge').textContent = geo.isPrivate ? '灞€鍩熺綉' : '鍏綉鍦ㄧ嚎';
      $('hostIpGeoBadge').className = `badge ${geo.isPrivate ? 'neutral' : 'success'}`;
    }
    if ($('hostIpGeoDetails')) {
      const parts = [];
      parts.push(`<div><strong>鍑哄彛 IP:</strong> <code class="md-inline-code">${esc(geo.ip)}</code> ${geo.isPrivate ? '(绉佺綉)' : ''}</div>`);
      parts.push(`<div><strong>鍦扮悊浣嶇疆:</strong> ${esc(geo.formattedLocation)}</div>`);
      if (geo.isp) parts.push(`<div><strong>缃戠粶杩愯惀鍟?</strong> ${esc(geo.isp)} ${geo.asn ? '(' + esc(geo.asn) + ')' : ''}</div>`);
      if (geo.timezone) parts.push(`<div><strong>鏃跺尯鏍囪瘑:</strong> ${esc(geo.timezone)}</div>`);
      $('hostIpGeoDetails').innerHTML = parts.join('');
    }
  } catch (err) {
    if ($('hostIpGeoBadge')) $('hostIpGeoBadge').textContent = '鎺㈡祴澶辫触';
  }
}

// ==========================================================================
// AI 鏅鸿兘纾佺洏鍒嗘瀽涓庡畨鍏ㄦ竻鐞嗘帶鍒跺櫒 (Smart Disk Cleaner Controller)
// ==========================================================================

let currentDiskScanReport = null;

async function handleScanDisk(server) {
  try {
    showToast('姝ｅ湪鎵弿鍒嗘瀽纾佺洏鍐椾綑鍨冨溇涓庣紦瀛?..', 'info');
    if ($('scanDiskBtn')) $('scanDiskBtn').disabled = true;
    const report = await window.hap.scanDiskCleanable(server);
    currentDiskScanReport = report;
    renderDiskScanResult(report);
    showToast(`鎵弿瀹屾垚锛佸彂鐜?${fmtHostBytes(report.totalCleanableBytes)} 鍙噴鏀剧┖闂碻, 'success');
  } catch (err) {
    showToast('纾佺洏鎵弿澶辫触: ' + err.message, 'error');
  } finally {
    if ($('scanDiskBtn')) $('scanDiskBtn').disabled = false;
  }
}

function renderDiskScanResult(report) {
  if (!report) return;
  if ($('diskEmptyState')) $('diskEmptyState').style.display = 'none';
  if ($('diskScanResultContainer')) $('diskScanResultContainer').style.display = 'block';

  if ($('diskCleanableTotalBadge')) {
    $('diskCleanableTotalBadge').style.display = 'inline-flex';
    $('diskCleanableTotalBadge').textContent = `鍙噴鏀? ${fmtHostBytes(report.totalCleanableBytes)}`;
  }
  if ($('diskSafeSize')) $('diskSafeSize').textContent = fmtHostBytes(report.safeCleanableBytes);
  if ($('diskReviewSize')) $('diskReviewSize').textContent = fmtHostBytes(report.reviewCleanableBytes);

  const listEl = $('diskItemsList');
  if (!listEl) return;

  if (!report.items || report.items.length === 0) {
    listEl.innerHTML = '<div style="color:#16a34a; font-weight:600; text-align:center; padding:16px;">馃帀 纾佺洏闈炲父骞插噣锛屾湭鍙戠幇鍐椾綑缂撳瓨鍨冨溇锛?/div>';
    return;
  }

  listEl.innerHTML = report.items.map(item => `
    <div style="display:flex; justify-content:space-between; align-items:center; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:10px 14px;">
      <div style="display:flex; align-items:center; gap:10px;">
        <span class="badge ${item.safety === 'safe' ? 'success' : 'warn'}">${item.safety === 'safe' ? '馃煝 瀹夊叏' : '馃煛 纭'}</span>
        <div>
          <div style="font-weight:600; font-size:13.5px; color:var(--text-main);">${esc(item.name)}</div>
          <div style="font-size:12px; color:var(--text-muted);">${esc(item.description)} <code style="font-size:11px;">(${esc(item.path)})</code></div>
        </div>
      </div>
      <div style="font-size:14px; font-weight:700; color:var(--text-main); font-family:var(--font-mono);">
        ${fmtHostBytes(item.sizeBytes)}
      </div>
    </div>
  `).join('');
}

async function handleCleanDisk(type) {
  if (!currentDiskScanReport) {
    await handleScanDisk();
  }
  if (!currentDiskScanReport || currentDiskScanReport.items.length === 0) {
    showToast('褰撳墠娌℃湁闇€瑕佹竻鐞嗙殑鍨冨溇椤?, 'info');
    return;
  }

  const targetIds = type === 'all'
    ? ['all']
    : currentDiskScanReport.items.filter(i => i.safety === 'safe').map(i => i.id);

  if (targetIds.length === 0) {
    showToast('鏈彂鐜板睘浜庤绾у埆鐨勫瀮鍦炬枃浠?, 'info');
    return;
  }

  const confirmMsg = type === 'all'
    ? `纭畾鍏ㄩ噺娓呯悊鍏ㄩ儴鍙洖鏀堕」 (鍚瀯寤轰骇鐗?dist/target锛岄璁￠噴鏀?${fmtHostBytes(currentDiskScanReport.totalCleanableBytes)}) 鍚楋紵`
    : `纭畾鎵ц瀹夊叏娓呯悊 (浠呮竻鐞嗗畨鍏ㄧ紦瀛樹笌涓存椂鏃ュ織锛岄璁￠噴鏀?${fmtHostBytes(currentDiskScanReport.safeCleanableBytes)}) 鍚楋紵`;

  if (!confirm(confirmMsg)) return;

  try {
    showToast('姝ｅ湪鎵ц纾佺洏瀹夊叏娓呯悊...', 'info');
    const result = await window.hap.executeDiskCleanup({
      server: currentDiskScanReport.target === 'local' ? undefined : currentDiskScanReport.target,
      itemIds: targetIds,
    });
    showToast(`娓呯悊鎴愬姛锛侀噴鏀句簡 ${fmtHostBytes(result.cleanedBytes)} 绌洪棿锛乣, 'success');
    await handleScanDisk();
    await renderHostView();
  } catch (err) {
    showToast('娓呯悊澶辫触: ' + err.message, 'error');
  }
}

$('scanDiskBtn')?.addEventListener('click', () => handleScanDisk());
$('safeCleanDiskBtn')?.addEventListener('click', () => handleCleanDisk('safe'));
$('allCleanDiskBtn')?.addEventListener('click', () => handleCleanDisk('all'));

$('refreshHostBtn')?.addEventListener('click', async () => {
  await renderHostView();
  showToast('瀹夸富涓绘満绯荤粺鐘舵€佸凡鍒锋柊锛?, 'info');
});

let hostPollingTimer = null;
function startHostPolling() {
  if (hostPollingTimer) clearInterval(hostPollingTimer);
  hostPollingTimer = setInterval(() => {
    const hostView = $('host');
    const autoRefresh = $('hostAutoRefreshToggle');
    if (hostView && hostView.classList.contains('active') && autoRefresh && autoRefresh.checked) {
      renderHostView().catch(() => {});
    }
  }, 3000);
}

startHostPolling();

// 鍒濆鍖栧姞杞?refresh().catch((error) => showToast('鍒濆鍖栧姞杞藉け璐ワ細' + error.message, 'error'));



