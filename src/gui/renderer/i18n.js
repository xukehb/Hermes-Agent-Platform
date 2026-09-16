/**
 * Hermes Agent Platform (HAP) - Desktop GUI Internationalization (i18n)
 * Provides seamless bilingual (zh-CN <-> en-US) switching with zero emojis.
 */

(function (root, factory) {
  const instance = factory();
  root.I18N = instance;
  if (typeof window !== 'undefined') {
    window.I18N = instance;
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = instance;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TRANSLATIONS = {
    'zh-CN': {
      // 侧边栏 (Rail)
      'rail.newConversation': '新建会话',
      'rail.history': '会话历史',
      'rail.scheduledTasks': '定时任务',
      'rail.projects': '项目工程',
      'rail.filterTooltip': '过滤/搜索工程',
      'rail.importTooltip': '导入或新建项目工程',
      'rail.filterPlaceholder': '过滤项目或会话...',
      'rail.settings': '系统设置',
      'rail.settingsTooltip': '系统设置中心 (Settings)',

      // 顶部工具栏 (Header)
      'header.sidebarToggle': '折叠/展开侧边栏 (Ctrl/Cmd+B)',
      'header.modelPickerTooltip': '切换当前对话模型',
      'header.workspaceTooltip': '当前对话绑定的工作区目录',
      'header.defaultWorkspace': '默认工作区',
      'header.gitTooltip': 'Git 关联、提交与推送代码',
      'header.miniITooltip': '展开小 i 交互弹窗 (快捷问答与状态)',
      'header.miniI': '小 i',
      'header.miniModeTooltip': '缩小为桌面悬浮小窗模式 (Alt+M)',
      'header.miniMode': '缩小化',
      'header.restoreMode': '还原',
      'header.appearanceTooltip': '调整界面主题色彩与窗口半透明度',
      'header.appearance': '外观',
      'header.moreTooltip': '更多工具与会话管理',
      'header.more': '操作',

      // 更多操作下拉菜单 (Header More Menu)
      'more.currentAgent': '当前智能体:',
      'more.agentTooltip': '切换处理智能体',
      'more.tokenConsumption': 'Token 消耗:',
      'more.tokenTooltip': '今日实时 Token 消耗',
      'more.openVsCode': '在 VS Code 中打开',
      'more.openVsCodeTooltip': '在 VS Code 中打开当前绑定的项目',
      'more.exportMarkdown': '导出 Markdown',
      'more.exportMarkdownTooltip': '导出当前会话为 Markdown 文档',
      'more.clearContext': '清空当前上下文',
      'more.clearContextTooltip': '清空上下文开启新对话 (/new)',
      'more.deleteChat': '删除当前会话',
      'more.deleteChatTooltip': '删除当前会话',
      'more.switchLanguage': '切换语言 (English)',
      'more.switchLanguageTooltip': '切换中英文界面 (Switch to English)',

      // 外观弹出层 (Appearance & Opacity Popover)
      'popover.languageTitle': '界面语言 (Language)',
      'popover.langZh': '中文 (简体)',
      'popover.langEn': 'English',
      'popover.themeTitle': '色彩主题快速切换',
      'theme.dark': '曜石深空',
      'theme.light': '极简冷玉',
      'theme.cyber': '赛博霓虹',
      'theme.aurora': '极光松岭',
      'theme.sunset': '落日熔金',
      'theme.glass': '流光玻璃',
      'popover.themeDetails': '查看 6 款主题设计详情 ▾',
      'popover.opacityTitle': '半透明与毛玻璃',
      'popover.opacityClear': '40% 通透',
      'popover.opacityFrosted': '70% 磨砂',
      'popover.opacitySolid': '100% 实色',
      'popover.opacitySlight': '90% 微透',
      'popover.opacityAurora': '60% 极光',
      'popover.backdropBlur': '启用背景高斯模糊滤镜 (Backdrop Blur)',

      // 主题弹窗详情 (Theme Modal)
      'themeModal.title': '主题与透明度详细配置',
      'themeModal.subtitle': '自由定制视觉主题与窗口背景半透明特效',
      'themeModal.done': '完成设置',

      // 输入悬浮岛 (Composer)
      'composer.quickGit': '/git 状态',
      'composer.quickDiff': '/diff 变更',
      'composer.quickCommit': '/commit 提交',
      'composer.quickSh': '/sh 执行命令',
      'composer.quickModels': '/models 列表',
      'composer.placeholder': '给智能体下发开发、修复或审查任务... (支持输入 @ 选择插件/智能体, Enter 发送)',
      'composer.dropOverlay': '拖拽图片或代码文件到此处附加',
      'composer.attachBtn': '图片/附件',
      'composer.attachTooltip': '附加图片或文件 (支持拖拽/截图粘贴)',
      'composer.aiGenBtn': 'AI 生图',
      'composer.aiGenTooltip': '一键生成 AI 图像 (插画、架构概念图、UI 设计图、壁纸等)',
      'composer.enterHint': '发送',
      'composer.shiftEnterHint': '换行',
      'composer.stopBtn': '停止生成',
      'composer.stopTooltip': '停止生成任务 (ESC)',
      'composer.sendTooltip': '发送指令 (Enter)',
      'composer.disclaimer': 'HAP 智能体自主编排执行。请审查关键代码与指令变更。',

      // 会话欢迎屏 (Hero Screen)
      'hero.title': '今天有什么我可以帮你的？',
      'hero.subtitle': '选择或导入工作区项目，开启高效智能编排与自动化修复',
      'hero.card1Title': '分析工程拓扑结构，自动梳理核心依赖与潜在架构风险',
      'hero.card1Badge': '11:09 就绪',
      'hero.card1Legend': '100% | P1 | 全模块',
      'hero.card1Chain': '解析拓扑',

      // 会话流与建议回复 (Chat Thread & Suggested Replies)
      'chat.suggestedReplies': '建议快捷回复',
      'chat.clickToSend': '点击直接发送此回复',
      'chat.copyCode': '复制代码',
      'chat.copied': '已复制',
      'chat.executeCommand': '执行命令',
      'chat.applyDiff': '应用变更',
      'chat.diffApplied': '已应用变更',
      'chat.revertDiff': '还原变更',
      'chat.userRole': '用户',
      'chat.assistantRole': '智能体',
      'chat.systemRole': '系统',

      // 小 i 交互弹窗 (Mini \'i\' Popover & Mini Window)
      'mini.brand': 'Hermes 小 i',
      'mini.subtext': '智能副驾 · 随行待命',
      'mini.statusReady': '系统正常就绪',
      'mini.placeholder': '快速向小 i 提问或派发指令...',
      'mini.sendTooltip': '发送 (Enter)',
      'mini.restoreFull': '还原完整工作台界面',
      'mini.pinTooltip': '置顶窗口',
      'mini.minimizeTooltip': '最小化窗口',
      'mini.closeTooltip': '关闭窗口',

      // 设置中心 (Settings Center)
      'settings.title': '系统设置中心',
      'settings.subtitle': '集中管理模型服务商、智能体角色、Skill & MCP 扩展、消息通道、定时任务、计算节点与安全策略',
      'settings.backToChat': '返回对话工作台',
      'settings.tabProviders': '模型与服务商',
      'settings.tabAgents': '智能体角色',
      'settings.tabSkills': 'Skill & MCP 市场',
      'settings.tabChannels': '机器人与消息通道',
      'settings.tabSchedules': '自动化定时任务',
      'settings.tabMemory': '智能体记忆库',
      'settings.tabHost': '计算节点全景大盘',
      'settings.tabServers': '远程服务器集群',
      'settings.tabProjects': '工作区项目库',
      'settings.tabPermissions': '权限与安全策略',
      'settings.tabSystem': 'CLI 同步与运行日志',

      // 任务与历史弹窗 (Modals)
      'modal.historyTitle': '全局会话历史记录 (Conversation History)',
      'modal.scheduledTasksTitle': '定时与周期任务调度 (Scheduled Tasks)',
      'modal.gitCommitTitle': 'Git 代码提交与推送',

      // 桌面更新弹窗
      'update.title': '发现新版本',
      'update.available': '新版本已准备好下载',
      'update.downloading': '正在从 GitHub 下载更新',
      'update.downloaded': '更新已下载完成',
      'update.failed': '更新下载失败',
      'update.currentVersion': '当前版本',
      'update.newVersion': '最新版本',
      'update.releaseNotes': '更新内容',
      'update.noNotes': '本次更新包含功能改进和问题修复。',
      'update.later': '稍后',
      'update.download': '一键更新',
      'update.retry': '重新下载',
      'update.install': '重启并安装',

      // 通用提示与操作 (Common)
      'common.save': '保存',
      'common.cancel': '取消',
      'common.confirm': '确认',
      'common.delete': '删除',
      'common.edit': '编辑',
      'common.refresh': '刷新',
      'common.copy': '复制',
      'common.copied': '已复制',
      'common.close': '关闭',
      'common.loading': '加载中...',
      'common.success': '操作成功',
      'common.error': '操作失败',
      'common.warning': '警告',
      'common.info': '提示'
    },
    'en-US': {
      // 侧边栏 (Rail)
      'rail.newConversation': 'New Conversation',
      'rail.history': 'Conversation History',
      'rail.scheduledTasks': 'Scheduled Tasks',
      'rail.projects': 'Projects',
      'rail.filterTooltip': 'Filter / Search Projects',
      'rail.importTooltip': 'Import or Create Project',
      'rail.filterPlaceholder': 'Filter projects or conversations...',
      'rail.settings': 'Settings',
      'rail.settingsTooltip': 'System Settings Center',

      // 顶部工具栏 (Header)
      'header.sidebarToggle': 'Toggle Sidebar (Ctrl/Cmd+B)',
      'header.modelPickerTooltip': 'Switch Active Model',
      'header.workspaceTooltip': 'Bound Workspace Directory',
      'header.defaultWorkspace': 'Default Workspace',
      'header.gitTooltip': 'Git Commit & Push',
      'header.miniITooltip': 'Open Mini i Copilot (Quick Q&A & Status)',
      'header.miniI': 'Mini i',
      'header.miniModeTooltip': 'Shrink to Floating Mini Mode (Alt+M)',
      'header.miniMode': 'Mini Mode',
      'header.restoreMode': 'Restore',
      'header.appearanceTooltip': 'Adjust Theme Colors & Opacity',
      'header.appearance': 'Appearance',
      'header.moreTooltip': 'More Tools & Conversation Management',
      'header.more': 'Actions',

      // 更多操作下拉菜单 (Header More Menu)
      'more.currentAgent': 'Active Agent:',
      'more.agentTooltip': 'Switch Processing Agent',
      'more.tokenConsumption': 'Token Usage:',
      'more.tokenTooltip': "Today's Real-time Token Usage",
      'more.openVsCode': 'Open in VS Code',
      'more.openVsCodeTooltip': 'Open bound project in VS Code',
      'more.exportMarkdown': 'Export Markdown',
      'more.exportMarkdownTooltip': 'Export conversation as Markdown',
      'more.clearContext': 'Clear Context',
      'more.clearContextTooltip': 'Clear context and start new conversation (/new)',
      'more.deleteChat': 'Delete Conversation',
      'more.deleteChatTooltip': 'Delete current conversation',
      'more.switchLanguage': 'Switch Language (中文)',
      'more.switchLanguageTooltip': 'Toggle Chinese / English interface (切换为中文)',

      // 外观弹出层 (Appearance & Opacity Popover)
      'popover.languageTitle': 'Interface Language',
      'popover.langZh': '中文 (简体)',
      'popover.langEn': 'English',
      'popover.themeTitle': 'Theme Presets',
      'theme.dark': 'Obsidian',
      'theme.light': 'Frost',
      'theme.cyber': 'Cyber',
      'theme.aurora': 'Aurora',
      'theme.sunset': 'Sunset',
      'theme.glass': 'Glass',
      'popover.themeDetails': 'View 6 Theme Design Details ▾',
      'popover.opacityTitle': 'Opacity & Backdrop Blur',
      'popover.opacityClear': '40% Clear',
      'popover.opacityFrosted': '70% Frosted',
      'popover.opacitySolid': '100% Solid',
      'popover.opacitySlight': '90% Slight',
      'popover.opacityAurora': '60% Aurora',
      'popover.backdropBlur': 'Enable Backdrop Blur Filter',

      // 主题弹窗详情 (Theme Modal)
      'themeModal.title': 'Theme & Opacity Settings',
      'themeModal.subtitle': 'Customize visual themes and translucent background blur effects',
      'themeModal.done': 'Done',

      // 输入悬浮岛 (Composer)
      'composer.quickGit': '/git Status',
      'composer.quickDiff': '/diff Review',
      'composer.quickCommit': '/commit Commit',
      'composer.quickSh': '/sh Run Command',
      'composer.quickModels': '/models List',
      'composer.placeholder': 'Assign development, fix, or review tasks to agents... (type @ for plugins/agents, Enter to send)',
      'composer.dropOverlay': 'Drop images or code files here to attach',
      'composer.attachBtn': 'Attach Files',
      'composer.attachTooltip': 'Attach images or files (drag & drop / clipboard supported)',
      'composer.aiGenBtn': 'AI Image',
      'composer.aiGenTooltip': 'Generate AI images (illustrations, architecture diagrams, UI mockups, wallpapers)',
      'composer.enterHint': 'Send',
      'composer.shiftEnterHint': 'New Line',
      'composer.stopBtn': 'Stop',
      'composer.stopTooltip': 'Stop generation task (ESC)',
      'composer.sendTooltip': 'Send instruction (Enter)',
      'composer.disclaimer': 'Autonomous agent execution by HAP. Please review critical code and command changes.',

      // 会话欢迎屏 (Hero Screen)
      'hero.title': 'How can I help you today?',
      'hero.subtitle': 'Select or import a workspace project to begin autonomous agent orchestration and automated fixes',
      'hero.card1Title': 'Analyze project topology, inspect dependencies and architecture risks',
      'hero.card1Badge': '11:09 Ready',
      'hero.card1Legend': '100% | P1 | All Modules',
      'hero.card1Chain': 'Analyze Topology',

      // 会话流与建议回复 (Chat Thread & Suggested Replies)
      'chat.suggestedReplies': 'Suggested Replies',
      'chat.clickToSend': 'Click to send this reply',
      'chat.copyCode': 'Copy Code',
      'chat.copied': 'Copied',
      'chat.executeCommand': 'Run Command',
      'chat.applyDiff': 'Apply Diff',
      'chat.diffApplied': 'Diff Applied',
      'chat.revertDiff': 'Revert Diff',
      'chat.userRole': 'User',
      'chat.assistantRole': 'Assistant',
      'chat.systemRole': 'System',

      // 小 i 交互弹窗 (Mini \'i\' Popover & Mini Window)
      'mini.brand': 'Hermes Mini i',
      'mini.subtext': 'AI Copilot · On Standby',
      'mini.statusReady': 'System Ready',
      'mini.placeholder': 'Ask Mini i or dispatch instructions...',
      'mini.sendTooltip': 'Send (Enter)',
      'mini.restoreFull': 'Restore Full Workspace',
      'mini.pinTooltip': 'Always on Top',
      'mini.minimizeTooltip': 'Minimize Window',
      'mini.closeTooltip': 'Close Window',

      // 设置中心 (Settings Center)
      'settings.title': 'Settings Center',
      'settings.subtitle': 'Centrally manage model providers, agent personas, Skill & MCP extensions, channels, scheduled tasks, compute nodes, and security policies',
      'settings.backToChat': 'Back to Chat',
      'settings.tabProviders': 'Providers & Models',
      'settings.tabAgents': 'Agent Personas',
      'settings.tabSkills': 'Skill & MCP Marketplace',
      'settings.tabChannels': 'Bots & Channels',
      'settings.tabSchedules': 'Scheduled Tasks',
      'settings.tabMemory': 'Agent Memories',
      'settings.tabHost': 'Host Dashboard',
      'settings.tabServers': 'Remote Clusters',
      'settings.tabProjects': 'Workspace Projects',
      'settings.tabPermissions': 'Security & Permissions',
      'settings.tabSystem': 'CLI Sync & Logs',

      // 任务与历史弹窗 (Modals)
      'modal.historyTitle': 'Conversation History',
      'modal.scheduledTasksTitle': 'Scheduled Tasks',
      'modal.gitCommitTitle': 'Git Commit & Push',

      // Desktop update dialog
      'update.title': 'Update Available',
      'update.available': 'A new version is ready to download',
      'update.downloading': 'Downloading the update from GitHub',
      'update.downloaded': 'The update is ready to install',
      'update.failed': 'Update download failed',
      'update.currentVersion': 'Current Version',
      'update.newVersion': 'Latest Version',
      'update.releaseNotes': 'Release Notes',
      'update.noNotes': 'This release includes improvements and bug fixes.',
      'update.later': 'Later',
      'update.download': 'Update Now',
      'update.retry': 'Retry Download',
      'update.install': 'Restart and Install',

      // 通用提示与操作 (Common)
      'common.save': 'Save',
      'common.cancel': 'Cancel',
      'common.confirm': 'Confirm',
      'common.delete': 'Delete',
      'common.edit': 'Edit',
      'common.refresh': 'Refresh',
      'common.copy': 'Copy',
      'common.copied': 'Copied',
      'common.close': 'Close',
      'common.loading': 'Loading...',
      'common.success': 'Success',
      'common.error': 'Failed',
      'common.warning': 'Warning',
      'common.info': 'Info'
    }
  };

  const STORAGE_KEY = 'hap_lang';
  let currentLang = 'zh-CN';

  function getLanguage() {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved && TRANSLATIONS[saved]) {
          return saved;
        }
      }
      if (currentLang && TRANSLATIONS[currentLang]) {
        return currentLang;
      }
      if (typeof navigator !== 'undefined' && navigator.language) {
        if (!navigator.language.toLowerCase().startsWith('zh')) {
          return 'en-US';
        }
      }
    } catch {
      // Fallback if storage access is restricted
    }
    return currentLang || 'zh-CN';
  }

  function t(key, fallback) {
    const dict = TRANSLATIONS[currentLang] || TRANSLATIONS['zh-CN'];
    if (dict && dict[key] !== undefined) {
      return dict[key];
    }
    const defaultDict = TRANSLATIONS['zh-CN'];
    if (defaultDict && defaultDict[key] !== undefined) {
      return defaultDict[key];
    }
    return fallback !== undefined ? fallback : key;
  }

  function applyLanguage(lang) {
    if (!TRANSLATIONS[lang]) return;
    currentLang = lang;

    if (typeof document === 'undefined') return;

    // 1. 设置 html lang
    if (document.documentElement) {
      document.documentElement.lang = lang;
    }

    // 2. 遍历带有 data-i18n 的元素
    if (typeof document.querySelectorAll === 'function') {
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (key && TRANSLATIONS[lang][key]) {
          el.textContent = TRANSLATIONS[lang][key];
        }
      });

      // 3. 遍历带有 data-i18n-placeholder 的元素
      document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (key && TRANSLATIONS[lang][key]) {
          el.setAttribute('placeholder', TRANSLATIONS[lang][key]);
        }
      });

      // 4. 遍历带有 data-i18n-title 的元素
      document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (key && TRANSLATIONS[lang][key]) {
          el.setAttribute('title', TRANSLATIONS[lang][key]);
        }
      });

      // 5. 更新外观中心与菜单里的语言高亮芯片状态
      document.querySelectorAll('.lang-quick-chip').forEach(chip => {
        const chipLang = chip.getAttribute('data-lang');
        chip.classList.toggle('active', chipLang === lang);
      });
    }

    // 6. 更新顶部外观文字 (保持透明度数字同步)
    if (typeof document.getElementById === 'function') {
      const appearanceLabel = document.getElementById('appearanceDisplayLabel');
      if (appearanceLabel) {
        const opacity = parseInt(document.getElementById('opacityRangeInput')?.value || '100', 10);
        const baseText = t('header.appearance', '外观');
        appearanceLabel.textContent = opacity < 100 ? `${baseText} (${opacity}%)` : baseText;
      }
    }

    // 7. 更新 More 菜单中的语言切换按钮文字
    const toggleLangSpan = typeof document.querySelector === 'function' ? document.querySelector('#toggleLangMoreBtn span') : null;
    if (toggleLangSpan) {
      toggleLangSpan.textContent = lang === 'zh-CN' ? '切换语言 (English)' : '切换语言 (中文)';
    }

    // 8. 派发自定义全局事件
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('languagechange', { detail: { lang } }));
    }
  }

  function setLanguage(lang) {
    if (!TRANSLATIONS[lang]) return;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, lang);
      }
    } catch {}
    applyLanguage(lang);
  }

  function toggleLanguage() {
    const nextLang = currentLang === 'zh-CN' ? 'en-US' : 'zh-CN';
    setLanguage(nextLang);
    return nextLang;
  }

  function init() {
    currentLang = getLanguage();
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          applyLanguage(currentLang);
        });
      } else {
        applyLanguage(currentLang);
      }
    }
  }

  // 自动初始化
  init();

  return {
    TRANSLATIONS,
    STORAGE_KEY,
    getLanguage,
    setLanguage,
    toggleLanguage,
    applyLanguage,
    t,
    init
  };
});
