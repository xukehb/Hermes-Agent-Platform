// ==========================================================================
// HAP Studio · 远程终端与控制台控制器 (TerminalConsoleController)
// 统一管理远程执行窗口、输出流式更新、ANSI 着色、复制与清屏
// ==========================================================================

(function(global) {
  'use strict';

  function formatOutput(stdout, stderr) {
    let full = stdout || '';
    if (stderr) {
      full += (full ? '\n\n[STDERR]\n' : '') + stderr;
    }
    if (!full.trim()) {
      full = '[Command completed with no stdout output]';
    }
    return full;
  }

  function copyOutput(outputElId = 'execModalOutput') {
    const el = document.getElementById(outputElId);
    const txt = el?.textContent || '';
    if (typeof global.copyText === 'function') {
      global.copyText(txt, '终端输出内容');
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(txt);
    }
  }

  function clearOutput(outputElId = 'execModalOutput', message = '# 终端已清空\n') {
    const el = document.getElementById(outputElId);
    if (el) el.textContent = message;
  }

  function formatExitCodeBadge(exitCode) {
    if (exitCode === 0 || exitCode === undefined) {
      return {
        text: '执行成功 (Exit: 0)',
        className: 'badge success',
        html: '退出代码: <strong style="color:var(--success);">0 (成功)</strong>',
      };
    }
    return {
      text: `异常退出 (${exitCode})`,
      className: 'badge danger',
      html: `退出代码: <strong style="color:var(--danger);">${exitCode} (错误)</strong>`,
    };
  }

  global.TerminalConsoleController = {
    formatOutput,
    copyOutput,
    clearOutput,
    formatExitCodeBadge,
  };
})(typeof window !== 'undefined' ? window : globalThis);
