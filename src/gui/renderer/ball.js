(function () {
  const $ = (id) => document.getElementById(id);

  let isAlwaysOnTop = true;
  let isSending = false;
  let currentModel = 'HAP';
  let currentAgent = '小 i';

  // 0. 主题同步与配色跟随控制器 (Theme Synchronizer)
  function applyBallTheme(themeName, customAccent, customBase) {
    const root = document.documentElement;
    const finalTheme = themeName || localStorage.getItem('hap_theme') || 'dark';
    root.setAttribute('data-theme', finalTheme);

    if (finalTheme === 'custom') {
      const accent = customAccent || localStorage.getItem('hap_theme_custom_accent') || '#38bdf8';
      const base = customBase || localStorage.getItem('hap_theme_custom_base') || 'dark';
      root.setAttribute('data-custom-base', base);
      root.style.setProperty('--primary', accent);
      root.style.setProperty('--accent', accent);
      root.style.setProperty('--ball-primary', accent);
      root.style.setProperty('--ball-glow', accent + '40');
    } else {
      root.removeAttribute('data-custom-base');
      root.style.removeProperty('--primary');
      root.style.removeProperty('--accent');
      root.style.removeProperty('--ball-primary');
      root.style.removeProperty('--ball-glow');
    }
  }

  // 立即初始化主题
  applyBallTheme();

  // 监听来自主进程的主题变更通知
  window.hap?.onThemeChanged?.((payload) => {
    if (payload && payload.theme) {
      applyBallTheme(payload.theme, payload.customAccent, payload.customBase);
    }
  });

  // 监听 localStorage 存储变动
  window.addEventListener('storage', (e) => {
    if (e.key === 'hap_theme' || e.key === 'hap_theme_custom_accent' || e.key === 'hap_theme_custom_base') {
      applyBallTheme();
    }
  });

  // 1. 小球拖拽与点击/双击交互
  const ballWidget = $('ballWidget');
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let dragThresholdPassed = false;

  ballWidget?.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // 仅左键
    isDragging = true;
    dragThresholdPassed = false;
    startX = e.screenX;
    startY = e.screenY;
    lastX = e.screenX;
    lastY = e.screenY;

    const onMouseMove = (moveEvt) => {
      if (!isDragging) return;
      const totalMoved = Math.hypot(moveEvt.screenX - startX, moveEvt.screenY - startY);
      if (totalMoved > 4) {
        dragThresholdPassed = true;
      }
      if (dragThresholdPassed) {
        const deltaX = moveEvt.screenX - lastX;
        const deltaY = moveEvt.screenY - lastY;
        lastX = moveEvt.screenX;
        lastY = moveEvt.screenY;
        window.hap?.moveBallWindow?.(deltaX, deltaY);
      }
    };

    const onMouseUp = () => {
      isDragging = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);

      // 如果未发生明显拖动，则判定为单击：展开发送面板
      if (!dragThresholdPassed) {
        toggleExpand(true);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });

  // 双击直接放大还原
  ballWidget?.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    restoreMainWindow();
  });

  // 2. 展开与收起逻辑
  async function toggleExpand(expand) {
    if (expand) {
      document.body.classList.remove('ball-mode-collapsed');
      document.body.classList.add('ball-mode-expanded');
      try {
        await window.hap?.setBallExpanded?.(true);
      } catch (err) {
        console.error('Failed to expand ball window:', err);
      }
      setTimeout(() => {
        $('ballInputText')?.focus();
      }, 50);
    } else {
      document.body.classList.remove('ball-mode-expanded');
      document.body.classList.add('ball-mode-collapsed');
      try {
        await window.hap?.setBallExpanded?.(false);
      } catch (err) {
        console.error('Failed to collapse ball window:', err);
      }
    }
  }

  function resetToCollapsed() {
    document.body.classList.remove('ball-mode-expanded');
    document.body.classList.add('ball-mode-collapsed');
    const input = $('ballInputText');
    if (input) input.value = '';
  }

  // 监听来自主进程的折叠重置通知
  window.hap?.onBallReset?.(() => {
    resetToCollapsed();
  });

  window.addEventListener('pageshow', () => {
    resetToCollapsed();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      toggleExpand(false);
    }
  });

  // 放大还原核心方法
  async function restoreMainWindow() {
    try {
      resetToCollapsed();
      await window.hap?.restoreFromBall?.();
    } catch (err) {
      console.error('Failed to restore main window:', err);
    }
  }

  // 绑定收起与还原按钮
  $('ballCollapseBtn')?.addEventListener('click', () => {
    toggleExpand(false);
  });

  $('ballRestoreMainBtn')?.addEventListener('click', () => {
    restoreMainWindow();
  });

  // 3. 置顶切换
  const pinBtn = $('ballPinBtn');
  pinBtn?.addEventListener('click', async () => {
    isAlwaysOnTop = !isAlwaysOnTop;
    pinBtn.classList.toggle('active', isAlwaysOnTop);
    try {
      await window.hap?.setAlwaysOnTop?.(isAlwaysOnTop);
    } catch (err) {
      console.error('Failed to set always on top:', err);
    }
  });

  // 4. 真正最小化到任务栏
  $('ballMinimizeTaskbarBtn')?.addEventListener('click', async () => {
    try {
      await window.hap?.minimizeToTaskbar?.();
    } catch (err) {
      console.error('Failed to minimize to taskbar:', err);
    }
  });

  // 5. 新建会话与清空
  const clearChat = () => {
    const stream = $('ballChatMessages');
    if (stream) {
      stream.innerHTML = `
        <div class="ball-welcome-tip" id="ballWelcomeTip">
          <span>随时输入指令，小 i 将立即为你解答或执行任务。</span>
        </div>
      `;
    }
  };

  $('ballClearChatBtn')?.addEventListener('click', clearChat);
  $('ballNewChatBtn')?.addEventListener('click', () => {
    clearChat();
    const input = $('ballInputText');
    if (input) {
      input.value = '';
      input.focus();
    }
  });

  // 6. 快捷流式输入交互
  async function sendPrompt() {
    if (isSending) return;
    const input = $('ballInputText');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    const stream = $('ballChatMessages');
    const welcome = $('ballWelcomeTip');
    if (welcome) welcome.remove();

    // 渲染用户输入
    const userMsg = document.createElement('div');
    userMsg.className = 'ball-chat-msg user';
    userMsg.textContent = text;
    stream?.appendChild(userMsg);

    // 渲染 AI 回复占位
    const aiMsg = document.createElement('div');
    aiMsg.className = 'ball-chat-msg assistant';
    aiMsg.innerHTML = '<span class="streaming-cursor"></span>';
    stream?.appendChild(aiMsg);

    stream?.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' });

    isSending = true;
    let fullReply = '';

    try {
      await window.hap?.chat?.(
        {
          message: text,
          model: currentModel,
          agent: currentAgent,
        },
        (event) => {
          if (!event) return;
          if (event.type === 'token' && typeof event.content === 'string') {
            fullReply += event.content;
            aiMsg.innerHTML = escapeHtml(fullReply) + '<span class="streaming-cursor"></span>';
            stream?.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' });
          } else if (event.type === 'done' || event.type === 'error') {
            aiMsg.innerHTML = escapeHtml(fullReply || (event.error ? '发生错误：' + event.error : ''));
            stream?.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' });
          }
        }
      );
    } catch (err) {
      aiMsg.innerHTML = '发送异常：' + (err instanceof Error ? err.message : String(err));
    } finally {
      const cursor = aiMsg.querySelector('.streaming-cursor');
      if (cursor) cursor.remove();
      isSending = false;
    }
  }

  $('ballSendBtn')?.addEventListener('click', sendPrompt);

  $('ballInputText')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // 7. 初始化信息同步
  async function loadSnapshot() {
    try {
      const res = await window.hap?.snapshot?.();
      if (res && res.ok && res.data) {
        if (res.data.currentModel) {
          currentModel = res.data.currentModel;
          const chip = $('ballModelName');
          if (chip) chip.textContent = currentModel;
        }
        if (res.data.currentAgent) {
          currentAgent = res.data.currentAgent;
          const badge = $('ballAgentBadge');
          if (badge) badge.textContent = currentAgent;
        }
      }
    } catch (err) {
      console.warn('Load snapshot error:', err);
    }
  }

  loadSnapshot();
})();
