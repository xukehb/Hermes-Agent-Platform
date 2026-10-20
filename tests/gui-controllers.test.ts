import { describe, expect, it } from 'vitest';
import '../src/gui/renderer/modules/gateway-controller.js';
import '../src/gui/renderer/modules/hosting-controller.js';

describe('GUI 模块化控制器 (Gateway & Hosting Controllers)', () => {
  it('GatewayController 状态徽标与 API 密钥脱敏正常', () => {
    const gc = (globalThis as any).GatewayController;
    expect(gc).toBeDefined();

    const running = gc.formatGatewayStatusBadge(true, 18000);
    expect(running.className).toContain('success');
    expect(running.label).toContain('18000');

    const stopped = gc.formatGatewayStatusBadge(false);
    expect(stopped.className).toContain('muted');
    expect(stopped.label).toContain('已停止');

    expect(gc.maskApiKey('sk-1234567890abcdef')).toBe('sk-1...cdef');
    expect(gc.maskApiKey('short')).toBe('********');
    expect(gc.maskApiKey(null)).toBe('******');
  });

  it('GatewayController 日志计算与过滤指标正确', () => {
    const gc = (globalThis as any).GatewayController;
    const mockLogs = [
      { path: '/v1/models', status: 200, latencyMs: 20 },
      { path: '/v1/chat/completions', status: 200, latencyMs: 100 },
      { path: '/v1/chat/completions', status: 500, latencyMs: 120 },
    ];

    const metrics = gc.calculateGatewayMetrics(mockLogs);
    expect(metrics.total).toBe(3);
    expect(metrics.errorCount).toBe(1);
    expect(metrics.errorRate).toBe('33.3%');
    expect(metrics.avgLatency).toBe('80ms');

    const filtered = gc.filterGatewayLogs(mockLogs, 'models');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].path).toBe('/v1/models');
  });

  it('HostingController 平台与状态徽标与引导视图生成正常', () => {
    const hc = (globalThis as any).HostingController;
    expect(hc).toBeDefined();

    const wxBadge = hc.formatContactPlatformBadge('wechat');
    expect(wxBadge.label).toBe('微信');
    expect(wxBadge.icon).toBe('💬');

    const tgBadge = hc.formatContactPlatformBadge('telegram');
    expect(tgBadge.label).toBe('Telegram');

    const activeStatus = hc.formatContactStatusBadge('active');
    expect(activeStatus.active).toBe(true);
    expect(activeStatus.label).toBe('已接管');

    const pausedStatus = hc.formatContactStatusBadge('manual');
    expect(pausedStatus.active).toBe(false);
    expect(pausedStatus.label).toBe('人工接管中');

    const guideHtml = hc.renderHostingGuideMarkup();
    expect(guideHtml).toContain('微信与 QQ 全量自动托管就绪');
    expect(guideHtml).toContain('hostingGuideAddBtn');
  });
});
