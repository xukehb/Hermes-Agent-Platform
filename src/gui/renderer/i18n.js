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
      'rail.chatHosting': '聊天托管',
      'rail.chatHostingTooltip': '聊天托管与数字分身 (Chat Hosting)',

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
      'header.languageTooltip': '切换界面语言 (Switch Language)',

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
      'more.aboutVersion': '关于与版本更新',
      'more.aboutVersionTooltip': '查看软件版本、运行环境、系统日志与检查更新',

      // 外观弹出层 (Appearance & Opacity Popover)
      'popover.languageTitle': '界面语言 (Language)',
      'popover.langZh': '中文 (简体)',
      'popover.langEn': 'English',
      'popover.themeTitle': '色彩主题快速切换',
      'theme.dark': '深色',
      'theme.light': '浅色',
      'popover.themeDetails': '查看 7 款主题设计详情 ▾',
      'popover.opacityTitle': '半透明与毛玻璃',
      'popover.opacityClear': '40% 通透',
      'popover.opacityFrosted': '70% 磨砂',
      'popover.opacitySolid': '100% 实色',
      'popover.opacitySlight': '90% 微透',
      'popover.opacityAurora': '60% 极光',
      'popover.backdropBlur': '启用背景高斯模糊滤镜 (Backdrop Blur)',

      // 主题弹窗详情 (Theme Modal)
      'themeModal.title': '外观、背景与透明度',
      'themeModal.subtitle': '选择浅色或深色主题，并可选配背景图片与透明度',
      'themeModal.done': '完成设置',

      // 背景图片与壁纸系统 (Wallpaper)
      'popover.wallpaperTitle': '背景图片与壁纸',
      'popover.wallpaperDetails': '壁纸与磨砂柔焦详细配置 ▾',
      'wallpaper.none': '纯净无壁纸',
      'wallpaper.nebula': '深空星云',
      'wallpaper.cyber': '赛博霓虹',
      'wallpaper.aurora': '北欧极光',
      'wallpaper.sunset': '落日流金',
      'wallpaper.mesh': '流光拟彩',
      'wallpaper.carbon': '极客碳纤',
      'wallpaper.custom': '自定义图片',
      'wallpaper.sectionTitle': '个性化背景图片与动态壁纸',
      'wallpaper.sectionSubtitle': '精选 7 款高质感视觉壁纸或上传本地图片，可自由调节透明度、磨砂柔焦与暗化遮罩',
      'wallpaper.uploadBtn': '+ 上传本地图片',
      'wallpaper.uploadHint': '支持 PNG, JPG, WebP, SVG，自动轻量优化',
      'wallpaper.urlPlaceholder': '或输入外部图片 URL 地址...',
      'wallpaper.urlApply': '应用',
      'wallpaper.clearBtn': '清除壁纸',
      'wallpaper.opacityLabel': '壁纸不透明度 (Opacity)',
      'wallpaper.blurLabel': '磨砂模糊度 (Frosted Blur)',
      'wallpaper.dimLabel': '遮罩对比度 (Anti-Glare)',
      'wallpaper.fitModeLabel': '图像适配模式',
      'wallpaper.fitCover': '撑满铺满 (Cover)',
      'wallpaper.fitContain': '等比完整 (Contain)',
      'wallpaper.fitTile': '平铺纹理 (Tile)',

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
      'hero.cardArchitecture': '分析工程结构',
      'hero.cardArchitectureDesc': '梳理核心依赖与潜在架构风险',
      'hero.cardSecurity': '代码与安全审查',
      'hero.cardSecurityDesc': '排查缺陷、漏洞与性能隐患',
      'hero.cardTests': '编写单元测试',
      'hero.cardTestsDesc': '覆盖边界条件与异常分支',
      'hero.cardGit': 'Git 变更与提交',
      'hero.cardGitDesc': '生成规范提交并推送远程',
      'hero.boundProject': '当前绑定的工程：',

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
      'settings.tabGateway': 'API 分发网关',
      'settings.tabSystem': '版本更新与系统日志',

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
      'update.download': '确认升级',
      'update.downloadingBtn': '正在准备升级...',
      'update.connecting': '正在连接升级服务器并拉取新版本...',
      'update.retry': '重新下载',
      'update.install': '重启并安装',
      'update.installingBtn': '正在重启应用...',
      'update.restartingStatus': '正在关闭客户端并启动升级安装程序，请稍候...',
      'update.restartingToast': '正在准备重启并安装，客户端稍后将自动重新打开...',
      'update.installFailed': '更新安装失败',

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
      'rail.chatHosting': 'Chat Hosting',
      'rail.chatHostingTooltip': 'Chat Delegation & Digital Twin (Chat Hosting)',

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
      'header.languageTooltip': 'Switch Language (切换界面语言)',
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
      'more.aboutVersion': 'About & Version Updates',
      'more.aboutVersionTooltip': 'View app version, runtime environment, logs & check updates',

      // 外观弹出层 (Appearance & Opacity Popover)
      'popover.languageTitle': 'Interface Language',
      'popover.langZh': '中文 (简体)',
      'popover.langEn': 'English',
      'popover.themeTitle': 'Theme Presets',
      'theme.dark': 'Dark',
      'theme.light': 'Light',
      'popover.themeDetails': 'View 7 Theme Design Details ▾',
      'popover.opacityTitle': 'Opacity & Backdrop Blur',
      'popover.opacityClear': '40% Clear',
      'popover.opacityFrosted': '70% Frosted',
      'popover.opacitySolid': '100% Solid',
      'popover.opacitySlight': '90% Slight',
      'popover.opacityAurora': '60% Aurora',
      'popover.backdropBlur': 'Enable Backdrop Blur Filter',

      // 主题弹窗详情 (Theme Modal)
      'themeModal.title': 'Appearance, Background & Opacity',
      'themeModal.subtitle': 'Choose a light or dark theme, optionally with a background image and opacity',
      'themeModal.done': 'Done',

      // 背景图片与壁纸系统 (Wallpaper)
      'popover.wallpaperTitle': 'Background Wallpaper',
      'popover.wallpaperDetails': 'Configure Wallpaper & Blur ▾',
      'wallpaper.none': 'Pure Color',
      'wallpaper.nebula': 'Cosmic Nebula',
      'wallpaper.cyber': 'Cyber Grid',
      'wallpaper.aurora': 'Nordic Aurora',
      'wallpaper.sunset': 'Golden Sunset',
      'wallpaper.mesh': 'Modern Mesh',
      'wallpaper.carbon': 'Carbon Texture',
      'wallpaper.custom': 'Custom Image',
      'wallpaper.sectionTitle': 'Personalized Background Image & Wallpaper',
      'wallpaper.sectionSubtitle': 'Select from 7 curated aesthetic wallpapers or upload local images with blur and opacity controls',
      'wallpaper.uploadBtn': '+ Upload Local Image',
      'wallpaper.uploadHint': 'Supports PNG, JPG, WebP, SVG with automatic optimization',
      'wallpaper.urlPlaceholder': 'Or paste image URL...',
      'wallpaper.urlApply': 'Apply',
      'wallpaper.clearBtn': 'Clear Wallpaper',
      'wallpaper.opacityLabel': 'Wallpaper Opacity',
      'wallpaper.blurLabel': 'Frosted Blur (Soft Focus)',
      'wallpaper.dimLabel': 'Mask Contrast (Anti-Glare)',
      'wallpaper.fitModeLabel': 'Image Fit Mode',
      'wallpaper.fitCover': 'Cover',
      'wallpaper.fitContain': 'Contain',
      'wallpaper.fitTile': 'Tile Pattern',

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
      'hero.cardArchitecture': 'Analyze Architecture',
      'hero.cardArchitectureDesc': 'Review core dependencies and structural risks',
      'hero.cardSecurity': 'Code & Security Review',
      'hero.cardSecurityDesc': 'Find defects, vulnerabilities and hotspots',
      'hero.cardTests': 'Write Unit Tests',
      'hero.cardTestsDesc': 'Cover boundary and failure branches',
      'hero.cardGit': 'Git Changes & Commit',
      'hero.cardGitDesc': 'Generate a conventional commit and push',
      'hero.boundProject': 'Active project: ',

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
      'settings.tabGateway': 'API Gateway',
      'settings.tabSystem': 'Version Updates & Logs',

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
      'update.download': 'Confirm Upgrade',
      'update.downloadingBtn': 'Preparing Upgrade...',
      'update.connecting': 'Connecting to update server and fetching release...',
      'update.retry': 'Retry Download',
      'update.install': 'Restart and Install',
      'update.installingBtn': 'Restarting App...',
      'update.restartingStatus': 'Closing client and starting upgrade installer, please wait...',
      'update.restartingToast': 'Preparing to restart and install, app will reopen shortly...',
      'update.installFailed': 'Failed to install update',

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

  // ==========================================================================
  // 源文案词典 (Source Text Dictionary)
  // --------------------------------------------------------------------------
  // data-i18n 属性只能覆盖静态标记，而本平台的绝大多数文案既包含未标注的静态
  // 文本，也包含 app.js 运行时注入的模板字符串。这里以「中文原文 -> 英文译文」
  // 的方式提供第二层翻译：凡是文本节点内容与词典键完全一致，即替换为译文，
  // 因此静态与动态文案都能被同一份词典覆盖。
  // 仅在英文模式下生效，中文（默认语言）不产生任何遍历开销。
  // ==========================================================================
  const SOURCE_TEXT_EN = (typeof globalThis !== 'undefined' && globalThis.HAP_SOURCE_TEXT_EN) || {};
  // 带插值的模板（如「共 3 个文件变更」）无法用静态键命中，改用正则规则匹配。
  const SOURCE_TEXT_PATTERNS = (typeof globalThis !== 'undefined' && globalThis.HAP_SOURCE_TEXT_PATTERNS) || [];

  // 先精确匹配，再退回模式匹配；两者都未命中则保留原文。
  function lookupSourceTranslation(source) {
    const exact = SOURCE_TEXT_EN[source];
    if (exact !== undefined) return exact;
    for (let i = 0; i < SOURCE_TEXT_PATTERNS.length; i++) {
      const rule = SOURCE_TEXT_PATTERNS[i];
      if (!rule[0].test(source)) continue;
      let out = source.replace(rule[0], rule[1]);
      // 捕获到的片段本身若正好是一条词典（例如「... 自愈: 已开启」里的「已开启」），
      // 说明它是内置文案而非用户数据，这里一并翻译。
      const groups = source.match(rule[0]);
      for (let g = 1; g < groups.length; g++) {
        const fragment = groups[g];
        if (!fragment) continue;
        const fragmentEn = SOURCE_TEXT_EN[fragment];
        if (fragmentEn !== undefined && out.indexOf(fragment) !== -1) {
          out = out.split(fragment).join(fragmentEn);
        }
      }
      return out;
    }
    return undefined;
  }

  // 这些区域承载用户/智能体产出的内容，绝不能被界面词典改写。
  const TRANSLATE_SKIP_SELECTOR = [
    '[data-i18n-skip]',
    '#messagesInner',
    '.chat-thread-container',
    '.message-content',
    'code',
    'pre',
    'script',
    'style',
    'textarea',
  ].join(', ');

  function normalizeSourceText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  // data-i18n-allow 用于在跳过区域内显式放行：像 <code>/chat &lt;内容&gt;</code>
  // 这类既带命令语法又带中文占位符的界面文案，需要参与翻译。
  const TRANSLATE_ALLOW_SELECTOR = '[data-i18n-allow]';

  function isInsideSkippedRegion(node) {
    let el = node.parentNode;
    while (el && el.nodeType === 1) {
      if (typeof el.matches === 'function') {
        if (el.matches(TRANSLATE_ALLOW_SELECTOR)) return false;
        if (el.matches(TRANSLATE_SKIP_SELECTOR)) return true;
      }
      el = el.parentNode;
    }
    return false;
  }

  // 保留原始首尾空白，避免破坏内联排版。
  function withPreservedWhitespace(original, replacement) {
    const leading = original.match(/^\s*/)[0];
    const trailing = original.match(/\s*$/)[0];
    return leading + replacement + trailing;
  }

  function translateTextNode(node, lang) {
    const original = node.nodeValue;
    if (!original) return;
    const source = normalizeSourceText(original);
    if (!source || !/[\u4e00-\u9fa5]/.test(source)) return;

    if (lang === 'en-US') {
      const translated = lookupSourceTranslation(source);
      if (translated === undefined) return;
      if (node.__hapSourceText === undefined) node.__hapSourceText = original;
      const next = withPreservedWhitespace(node.__hapSourceText, translated);
      if (node.nodeValue !== next) node.nodeValue = next;
      return;
    }

    if (node.__hapSourceText !== undefined) {
      node.nodeValue = node.__hapSourceText;
      delete node.__hapSourceText;
    }
  }

  function translateSourceAttributes(root, lang) {
    const attrs = ['placeholder', 'title', 'aria-label'];
    const targets = root.querySelectorAll
      ? root.querySelectorAll(attrs.map(a => `[${a}]`).join(','))
      : [];
    targets.forEach(el => {
      if (el.closest && el.closest('[data-i18n-skip]')) return;
      attrs.forEach(attr => {
        const current = el.getAttribute(attr);
        if (!current) return;
        const storeKey = `hapSource${attr.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase())}`;
        const original = el.dataset ? el.dataset[storeKey] : undefined;
        if (lang === 'en-US') {
          const translated = lookupSourceTranslation(normalizeSourceText(current));
          if (translated === undefined) return;
          if (original === undefined && el.dataset) el.dataset[storeKey] = current;
          el.setAttribute(attr, translated);
        } else if (original !== undefined) {
          el.setAttribute(attr, original);
          delete el.dataset[storeKey];
        }
      });
    });
  }

  function translateSourceTree(lang) {
    if (typeof document === 'undefined' || !document.body) return;
    if (lang !== 'en-US') {
      stopSourceObserver();
    }

    if (typeof document.createTreeWalker === 'function' && typeof NodeFilter !== 'undefined') {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      const nodes = [];
      let node = walker.nextNode();
      while (node) {
        nodes.push(node);
        node = walker.nextNode();
      }
      nodes.forEach(n => {
        if (!isInsideSkippedRegion(n)) translateTextNode(n, lang);
      });
    }

    translateSourceAttributes(document.body, lang);

    if (lang === 'en-US') startSourceObserver();
  }

  let sourceObserver = null;
  function startSourceObserver() {
    if (sourceObserver || typeof MutationObserver === 'undefined' || typeof document === 'undefined' || !document.body) return;
    let scheduled = false;
    sourceObserver = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      const flush = () => {
        scheduled = false;
        if (currentLang !== 'en-US') return;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node = walker.nextNode();
        while (node) {
          if (!isInsideSkippedRegion(node)) translateTextNode(node, 'en-US');
          node = walker.nextNode();
        }
        translateSourceAttributes(document.body, 'en-US');
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
      else setTimeout(flush, 16);
    });
    sourceObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function stopSourceObserver() {
    if (sourceObserver) {
      sourceObserver.disconnect();
      sourceObserver = null;
    }
  }

  function getLanguage() {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved && TRANSLATIONS[saved]) {
          return saved;
        }
      }
    } catch {
      // Fallback if storage access is restricted
    }
    // 默认语言固定为简体中文。此前会依据 navigator.language 回退到 en-US，
    // 导致中文用户在英文环境的浏览器里首次打开即被切换为英文界面。
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
        if (!key) return;
        const text = TRANSLATIONS[lang][key];
        if (text === undefined) return;
        // 仅替换叶子节点文本，避免 textContent 覆盖掉内部的图标/子元素结构。
        const nodes = el.childNodes;
        const hasElementChild = nodes && typeof nodes.length === 'number'
          ? Array.prototype.some.call(nodes, n => n && n.nodeType === 1)
          : false;
        if (hasElementChild) {
          if (el.dataset) el.dataset.i18nText = text;
        } else {
          el.textContent = text;
        }
      });

      // 3. 遍历带有 data-i18n-placeholder 的元素
      document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (key && TRANSLATIONS[lang][key] !== undefined) {
          el.setAttribute('placeholder', TRANSLATIONS[lang][key]);
        }
      });

      // 4. 遍历带有 data-i18n-title 的元素
      document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (key && TRANSLATIONS[lang][key] !== undefined) {
          el.setAttribute('title', TRANSLATIONS[lang][key]);
        }
      });

      // 4b. 遍历带有 data-i18n-aria 的元素 (无障碍标签)
      document.querySelectorAll('[data-i18n-aria]').forEach(el => {
        const key = el.getAttribute('data-i18n-aria');
        if (key && TRANSLATIONS[lang][key] !== undefined) {
          el.setAttribute('aria-label', TRANSLATIONS[lang][key]);
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

    // 7. 更新语言切换按钮文字 (More 菜单项 + 顶栏快捷切换按钮)
    const nextLangLabel = lang === 'zh-CN' ? 'English' : '中文';
    const toggleLangSpan = typeof document.querySelector === 'function' ? document.querySelector('#toggleLangMoreBtn span') : null;
    if (toggleLangSpan) {
      toggleLangSpan.textContent = lang === 'zh-CN' ? '切换语言 (English)' : 'Switch language (中文)';
    }
    document.querySelectorAll('[data-lang-current]').forEach(el => {
      el.textContent = nextLangLabel;
    });
    document.querySelectorAll('.lang-option-item').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-lang') === lang);
    });

    // 6b. 源文案词典翻译 (覆盖未标注 data-i18n 的静态与动态文案)
    translateSourceTree(lang);

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
    SOURCE_TEXT_EN,
    SOURCE_TEXT_PATTERNS,
    lookupSourceTranslation,
    STORAGE_KEY,
    getLanguage,
    setLanguage,
    toggleLanguage,
    applyLanguage,
    translateSourceTree,
    t,
    init
  };
});
