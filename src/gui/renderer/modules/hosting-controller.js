// ==========================================================================
// HAP Studio · 社交代管与分身托管控制器 (HostingController)
// 统一管理多平台好友代管状态、人设配置、消息气泡排版与引导视图渲染
// ==========================================================================

(function(global) {
  'use strict';

  function formatContactPlatformBadge(platform) {
    const p = String(platform || 'wechat').toLowerCase();
    switch (p) {
      case 'wechat':
        return { label: '微信', className: 'badge platform-wechat', icon: '💬' };
      case 'qq':
        return { label: 'QQ', className: 'badge platform-qq', icon: '🐧' };
      case 'telegram':
        return { label: 'Telegram', className: 'badge platform-tg', icon: '✈️' };
      case 'whatsapp':
        return { label: 'WhatsApp', className: 'badge platform-wa', icon: '📱' };
      case 'feishu':
        return { label: '飞书', className: 'badge platform-feishu', icon: '🪶' };
      default:
        return { label: p, className: 'badge platform-generic', icon: '🌐' };
    }
  }

  function formatContactStatusBadge(status) {
    const s = String(status || 'active').toLowerCase();
    if (s === 'active' || s === 'enabled' || s === 'hosted') {
      return { label: '已接管', className: 'badge success', active: true };
    }
    if (s === 'manual' || s === 'cooldown' || s === 'paused') {
      return { label: '人工接管中', className: 'badge warning', active: false };
    }
    return { label: '未接管', className: 'badge muted', active: false };
  }

  function filterContacts(contacts, query) {
    if (!Array.isArray(contacts)) return [];
    if (!query || !query.trim()) return contacts;
    const q = query.toLowerCase().trim();
    return contacts.filter((c) => {
      const name = String(c.name || c.nickname || '').toLowerCase();
      const remark = String(c.remark || '').toLowerCase();
      const id = String(c.id || c.contactId || '').toLowerCase();
      return name.includes(q) || remark.includes(q) || id.includes(q);
    });
  }

  function formatMessageBubble(msg) {
    if (!msg) return '';
    const isOut = Boolean(msg.isOutbound || msg.direction === 'outbound' || msg.fromMe);
    const content = msg.content || msg.text || '';
    const time = msg.time || (msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '');
    const sender = isOut ? (msg.agentName ? `智能体 [${msg.agentName}]` : 'AI 分身') : (msg.senderName || '对方');

    const escaped = typeof global.esc === 'function' ? global.esc : (s) => String(s || '');

    return `
      <div class="hosting-msg-item ${isOut ? 'outbound' : 'inbound'}">
        <div class="hosting-msg-meta">${escaped(sender)} · ${escaped(time)}</div>
        <div class="hosting-msg-bubble">${escaped(content)}</div>
      </div>
    `;
  }

  function renderHostingGuideMarkup() {
    return `
      <div class="hosting-empty-guide-wrap">
        <div class="hosting-guide-header">
          <div style="font-size:36px;margin-bottom:6px;"></div>
          <h3 style="font-size:16px;font-weight:700;margin:0 0 4px 0;color:var(--text-main);">微信与 QQ 全量自动托管就绪</h3>
          <p style="font-size:12.5px;color:var(--text-muted);margin:0;max-width:480px;line-height:1.5;">
            已支持全量好友自动接管，统一由默认智能体代答。当您在手机上亲自回复时，分身将自动静默避让
          </p>
        </div>
        <div style="background:var(--bg-subtle);border:1px solid var(--border-default);border-radius:8px;padding:9px 14px;margin-bottom:14px;max-width:520px;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-main);line-height:1.4;">
          <span style="font-size:16px;"></span>
          <div><strong>无需手动录入好友：</strong>启动代管后，任何好友发来消息，智能体都会<strong>自动接管回复</strong>并在此自动归档。</div>
        </div>
        <div class="hosting-guide-steps">
          <div class="hosting-guide-step">
            <div class="step-num">1</div>
            <div class="step-content">
              <div class="step-title">启动代管通道（左侧卡片）</div>
              <div class="step-desc">
                <strong>桌面视觉免扫码（推荐）</strong>：电脑打开微信，点击左侧「启动代管」即可接管，零封号风险；<br/>
                <strong>手机扫码登录</strong>：也可随时切换为扫码登录，弹出二维码使用微信扫码授权。
              </div>
            </div>
          </div>
          <div class="hosting-guide-step">
            <div class="step-num">2</div>
            <div class="step-content">
              <div class="step-title">来信自动接管与归档（零配置）</div>
              <div class="step-desc">
                启动代管后，任何微信好友或群发来消息，默认分身智能体都会自动代答并在此归档；仅在需要给特殊重要客户定制专属人设或智能体时才需添加规则。
              </div>
            </div>
          </div>
          <div class="hosting-guide-step">
            <div class="step-num">3</div>
            <div class="step-content">
              <div class="step-title">右侧分身人设与防撞车保护</div>
              <div class="step-desc">
                可在右侧策略栏随时调整默认分身人设、记忆库关联，或套用预设 Prompt；人工回复时自动触发静默冷却。
              </div>
            </div>
          </div>
        </div>
        <div class="hosting-guide-actions">
          <button type="button" class="btn primary" id="hostingGuideAddBtn" style="font-size:12.5px;padding:7px 18px;">
            + 特殊好友定制 (可选)
          </button>
          <button type="button" class="btn secondary" id="hostingGuideVisionBtn" style="font-size:12.5px;padding:7px 16px;">
            测试桌面微信识屏
          </button>
        </div>
      </div>
    `;
  }

  global.HostingController = {
    formatContactPlatformBadge,
    formatContactStatusBadge,
    filterContacts,
    formatMessageBubble,
    renderHostingGuideMarkup,
  };
})(typeof window !== 'undefined' ? window : globalThis);
