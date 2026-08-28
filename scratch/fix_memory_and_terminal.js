import fs from 'node:fs';

const htmlPath = 'src/gui/renderer/index.html';
const jsPath = 'src/gui/renderer/app.js';

// 1. 注入 memoryDialog 到 index.html
let html = fs.readFileSync(htmlPath, 'utf8');

const memoryDialogHtml = `
    <!-- 弹窗: 添加智能体记忆条目 (Memory Dialog) -->
    <dialog id="memoryDialog" class="modal modal-md">
      <form id="memoryForm" class="modal-form-wrap">
        <div class="modal-header-row">
          <h2 id="memoryDialogTitle">添加智能体记忆条目</h2>
          <button type="button" class="btn-close" id="closeMemoryDialogBtn"></button>
        </div>

        <div class="form-grid">
          <div class="form-group">
            <label>记忆类型 / 范畴 *</label>
            <select id="memoryInputCategory" required>
              <option value="preference">用户习惯与偏好 (Preference)</option>
              <option value="architecture">架构与工程约束 (Architecture)</option>
              <option value="convention">代码规范与风格 (Convention)</option>
              <option value="domain">业务背景与专有名词 (Domain)</option>
              <option value="custom">自定义知识点 (Custom)</option>
            </select>
          </div>

          <div class="form-group">
            <label>指定生效智能体 (可选)</label>
            <select id="memoryAgentSelect">
              <option value="">全部智能体通用</option>
            </select>
          </div>

          <div class="form-group full-width">
            <label>记忆内容 *</label>
            <textarea id="memoryInputContent" rows="4" placeholder="例如：前端代码一律采用 TypeScript + ESM 规范；项目构建必须使用 pnpm 等..." required></textarea>
          </div>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:8px;padding-top:14px;border-top:1px solid var(--border-default);">
          <button type="button" class="btn secondary" id="cancelMemoryDialogBtn">取消</button>
          <button type="submit" class="btn primary">保存记忆</button>
        </div>
      </form>
    </dialog>
`;

if (!html.includes('id="memoryDialog"')) {
  html = html.replace('</main>', '</main>\n' + memoryDialogHtml);
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log('Added memoryDialog to index.html');
}

// 2. 注入 terminal 与 memory 逻辑到 app.js
let js = fs.readFileSync(jsPath, 'utf8');

const additionalLogic = `
// ==========================================================================
// 专属服务器 SSH 交互终端控制器 (Dedicated Server Terminal)
// ==========================================================================

window.sdClearTerminal = () => {
  const out = $('sdTerminalOutput');
  if (out) out.textContent = '终端已清屏。请输入命令后按回车执行...\\n';
};

window.sdSendTerminalCmd = async () => {
  const input = $('sdTerminalInput');
  const out = $('sdTerminalOutput');
  if (!input || !out) return;
  const cmd = input.value.trim();
  if (!cmd) return;

  out.textContent += \`\\n$ \${cmd}\\n\`;
  out.scrollTop = out.scrollHeight;
  input.value = '';
  input.disabled = true;

  try {
    const sId = activeDedicatedServerId || cachedServers[0]?.id;
    if (!sId) {
      out.textContent += '[Error] 未选定目标远程服务器\\n';
      return;
    }
    const res = await window.hap.execServerCommand({ id: sId, command: cmd });
    const output = (res.stdout || '') + (res.stderr ? \`\\n[stderr] \${res.stderr}\` : '');
    out.textContent += (output.trim() || '(无输出返回)') + '\\n';
  } catch (err) {
    out.textContent += \`[执行异常] \${err.message}\\n\`;
  } finally {
    input.disabled = false;
    input.focus();
    out.scrollTop = out.scrollHeight;
  }
};

$('sdTerminalInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    window.sdSendTerminalCmd();
  }
});

// ==========================================================================
// 智能体持久化多层记忆库控制器 (Agent Memory Manager)
// ==========================================================================

let cachedMemories = [];

async function renderMemories(searchQuery = '') {
  const listEl = $('memoryList');
  const filterSelect = $('memoryAgentFilter');
  if (!listEl) return;

  try {
    const selectedAgent = filterSelect ? filterSelect.value : '';
    const memories = await window.hap.listMemories?.() || [];
    cachedMemories = memories;

    // 填充智能体筛选器
    if (filterSelect && filterSelect.options.length <= 1) {
      const agents = state.agents || [];
      agents.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.name || a.id;
        filterSelect.appendChild(opt);
      });
    }

    let filtered = memories;
    if (selectedAgent) {
      filtered = filtered.filter(m => !m.agentId || m.agentId === selectedAgent);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(m => (m.content || '').toLowerCase().includes(q) || (m.category || '').toLowerCase().includes(q));
    }

    if (filtered.length === 0) {
      listEl.innerHTML = \`
        <div style="padding:32px;text-align:center;background:#ffffff;border:1px dashed #cbd5e1;border-radius:10px;color:var(--text-muted);font-size:13px;">
          暂无符合条件的记忆条目。点击右上角「+ 添加记忆条目」为智能体沉淀偏好与规则。
        </div>
      \`;
      return;
    }

    const catMap = {
      preference: { label: '用户偏好', color: '#0284c7', bg: '#f0f9ff' },
      architecture: { label: '架构约束', color: '#7c3aed', bg: '#f5f3ff' },
      convention: { label: '代码规范', color: '#16a34a', bg: '#f0fdf4' },
      domain: { label: '业务背景', color: '#ea580c', bg: '#fff7ed' },
      custom: { label: '自定义', color: '#475569', bg: '#f8fafc' },
    };

    listEl.innerHTML = filtered.map(m => {
      const cat = catMap[m.category] || catMap.custom;
      return \`
        <div class="card" style="padding:12px 16px;background:#ffffff;border:1px solid var(--border-default);border-radius:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
          <div style="flex:1;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <span class="prop-chip" style="background:\${cat.bg};color:\${cat.color};font-weight:600;font-size:11px;">\${cat.label}</span>
              \${m.agentId ? \`<span class="prop-chip" style="font-size:11px;">🤖 \${esc(m.agentId)}</span>\` : '<span class="prop-chip" style="font-size:11px;color:#94a3b8;">🌐 全局通用</span>'}
              <span style="font-size:11px;color:#94a3b8;margin-left:auto;">\${new Date(m.createdAt || m.updatedAt || Date.now()).toLocaleDateString()}</span>
            </div>
            <div style="font-size:13px;color:var(--text-main);line-height:1.5;white-space:pre-wrap;word-break:break-all;">\${esc(m.content)}</div>
          </div>
          <button type="button" class="btn danger" style="padding:3px 8px;font-size:11.5px;" onclick="window.deleteMemoryItem('\${escJs(m.id)}')">删除</button>
        </div>
      \`;
    }).join('');
  } catch (err) {
    console.warn('渲染记忆库失败:', err);
  }
}

window.openAddMemoryDialog = () => {
  const dialog = $('memoryDialog');
  const form = $('memoryForm');
  if (!dialog || !form) return;
  form.reset();
  const agentSelect = $('memoryAgentSelect');
  if (agentSelect) {
    agentSelect.innerHTML = '<option value="">全部智能体通用</option>' + (state.agents || []).map(a => \`<option value="\${esc(a.id)}">\${esc(a.name || a.id)} (\${esc(a.id)})\</option>\`).join('');
  }
  dialog.showModal();
};

$('memoryForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const category = $('memoryInputCategory').value;
  const agentId = $('memoryAgentSelect').value || undefined;
  const content = $('memoryInputContent').value.trim();

  if (!content) return;

  try {
    await window.hap.addMemory({ category, agentId, content });
    $('memoryDialog')?.close();
    showToast('记忆条目已成功添加', 'success');
    await renderMemories();
  } catch (err) {
    showToast('添加记忆失败：' + err.message, 'error');
  }
});

$('closeMemoryDialogBtn')?.addEventListener('click', () => $('memoryDialog')?.close());
$('cancelMemoryDialogBtn')?.addEventListener('click', () => $('memoryDialog')?.close());

$('memorySearchInput')?.addEventListener('input', (e) => renderMemories(e.target.value));
$('memoryAgentFilter')?.addEventListener('change', () => renderMemories($('memorySearchInput')?.value || ''));

window.deleteMemoryItem = async (id) => {
  const ok = await showConfirm({
    title: '删除记忆条目',
    message: '确定要删除该条记忆吗？删除后智能体将不再自动参考该规则。',
    okText: '确认删除',
    isDanger: true,
  });
  if (!ok) return;

  try {
    await window.hap.removeMemory(id);
    showToast('记忆条目已删除', 'success');
    await renderMemories();
  } catch (err) {
    showToast('删除失败：' + err.message, 'error');
  }
};
`;

if (!js.includes('window.sdClearTerminal')) {
  js += '\n' + additionalLogic;
}

// 在 refresh 中加入 renderMemories
js = js.replace(
  'renderSchedules();',
  'renderSchedules();\n    renderMemories();'
);

fs.writeFileSync(jsPath, js, 'utf8');
console.log('Successfully injected terminal and memory controllers to app.js');
