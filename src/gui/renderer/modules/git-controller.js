// ==========================================================================
// HAP Studio · Git 协同工作流控制器 (GitWorkflowController)
// 统一管理工作区变更状态、Diff 解析渲染、提交历史追踪与提交规范
// ==========================================================================

(function(global) {
  'use strict';

  function formatGitStatusBadge(status) {
    const s = String(status || '').toUpperCase();
    if (s === 'M') {
      return { label: '修改', className: 'git-status-badge M' };
    }
    if (s === 'A' || s === '?' || s === 'UNTRACKED') {
      return { label: '新增', className: 'git-status-badge A' };
    }
    if (s === 'D') {
      return { label: '删除', className: 'git-status-badge D' };
    }
    if (s === 'C' || s === 'CONFLICT') {
      return { label: '冲突', className: 'git-status-badge C' };
    }
    return { label: s || '未变', className: 'git-status-badge' };
  }

  function formatGitDiffLine(line) {
    if (!line) return '<div class="git-diff-line normal">&nbsp;</div>';
    const text = typeof line === 'string' ? line : (line.content || line.text || '');
    const type = typeof line === 'object' && line.type ? line.type : (
      text.startsWith('+') ? 'add' : (text.startsWith('-') ? 'del' : (text.startsWith('@') ? 'hunk' : 'normal'))
    );
    const escaped = typeof global.esc === 'function' ? global.esc(text) : text;
    return `<div class="git-diff-line ${type}">${escaped || '&nbsp;'}</div>`;
  }

  global.GitWorkflowController = {
    formatGitStatusBadge,
    formatGitDiffLine,
  };
})(typeof window !== 'undefined' ? window : globalThis);
