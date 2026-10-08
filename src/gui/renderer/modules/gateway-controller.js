// ==========================================================================
// HAP Studio · API 网关与路由控制器 (GatewayController)
// 统一管理多端模型路由网关状态、密钥脱敏、请求日志排版、延迟与错误率统计
// ==========================================================================

(function(global) {
  'use strict';

  function formatGatewayStatusBadge(isRunning, port) {
    if (isRunning) {
      return {
        label: `运行中 (端口: ${port || 8080})`,
        className: 'badge success',
        html: `<span class="badge success">● 运行中 (:${port || 8080})</span>`,
      };
    }
    return {
      label: '已停止',
      className: 'badge muted',
      html: '<span class="badge muted">○ 已停止</span>',
    };
  }

  function maskApiKey(key) {
    if (!key || typeof key !== 'string') return '******';
    if (key.length <= 8) return '********';
    return key.slice(0, 4) + '...' + key.slice(-4);
  }

  function formatGatewayLogLine(log) {
    if (!log) return '';
    const time = log.timestamp || log.time || new Date().toLocaleTimeString();
    const method = (log.method || 'POST').toUpperCase();
    const path = log.path || log.url || '/v1/chat/completions';
    const status = Number(log.status || 200);
    const latency = log.latencyMs ? `${log.latencyMs}ms` : (log.duration ? `${log.duration}ms` : '');
    const model = log.model ? `[${log.model}]` : '';

    const statusClass = status >= 500 ? 'status-err' : (status >= 400 ? 'status-warn' : 'status-ok');
    const escaped = typeof global.esc === 'function' ? global.esc : (s) => String(s || '');

    return `<div class="gw-log-row ${statusClass}">
      <span class="gw-time">${escaped(time)}</span>
      <span class="gw-method ${method}">${escaped(method)}</span>
      <span class="gw-path">${escaped(path)}</span>
      <span class="gw-model">${escaped(model)}</span>
      <span class="gw-status ${statusClass}">${status}</span>
      <span class="gw-latency">${escaped(latency)}</span>
    </div>`;
  }

  function filterGatewayLogs(logs, query) {
    if (!Array.isArray(logs)) return [];
    if (!query || !query.trim()) return logs;
    const q = query.toLowerCase().trim();
    return logs.filter((l) => {
      const path = String(l.path || l.url || '').toLowerCase();
      const model = String(l.model || '').toLowerCase();
      const status = String(l.status || '');
      return path.includes(q) || model.includes(q) || status.includes(q);
    });
  }

  function calculateGatewayMetrics(logs) {
    if (!Array.isArray(logs) || logs.length === 0) {
      return { total: 0, errorCount: 0, errorRate: '0.0%', avgLatency: '0ms' };
    }
    const total = logs.length;
    let errors = 0;
    let totalLatency = 0;
    let validLatencyCount = 0;

    for (const log of logs) {
      const status = Number(log.status || 200);
      if (status >= 400) errors++;
      const lat = Number(log.latencyMs || log.duration);
      if (!isNaN(lat) && lat > 0) {
        totalLatency += lat;
        validLatencyCount++;
      }
    }

    const errorRate = ((errors / total) * 100).toFixed(1) + '%';
    const avgLatency = validLatencyCount > 0 ? `${Math.round(totalLatency / validLatencyCount)}ms` : '-';

    return { total, errorCount: errors, errorRate, avgLatency };
  }

  global.GatewayController = {
    formatGatewayStatusBadge,
    maskApiKey,
    formatGatewayLogLine,
    filterGatewayLogs,
    calculateGatewayMetrics,
  };
})(typeof window !== 'undefined' ? window : globalThis);
