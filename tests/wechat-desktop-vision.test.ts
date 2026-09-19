import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DesktopVisionPersonalDriver,
  type CapturedWindow,
  type WeChatVisionParseResult,
  parseWeChatScreen,
  isWeChatRunning,
} from '../src/channels/wechat/desktop-vision/index.js';

describe('WeChat Desktop Vision Agent (SightFlow 模式视觉代管)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('DesktopVisionPersonalDriver 正常启动与安全登出', async () => {
    const onLogin = vi.fn();
    const onLogout = vi.fn();

    const driver = new DesktopVisionPersonalDriver({
      pollIntervalMs: 10000,
      isWeChatRunningFn: async () => true,
      captureFn: async () => ({ ok: false, sourceType: 'none' }),
    });

    driver.onLogin = onLogin;
    driver.onLogout = onLogout;

    await driver.start();
    expect(onLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'desktop_wechat_host',
        name: expect.stringContaining('SightFlow'),
      })
    );

    await driver.stop();
    expect(onLogout).toHaveBeenCalled();
  });

  it('识屏探测循环 (See & Think) 成功捕获好友消息并派发上层', async () => {
    const onMessage = vi.fn();

    const mockCaptureRes: CapturedWindow = {
      ok: true,
      buffer: Buffer.from('fake-image-bytes'),
      sourceType: 'screencapture',
    };

    const mockParseRes: WeChatVisionParseResult = {
      ok: true,
      hasWeChatWindow: true,
      chatTarget: '张三 (架构师)',
      isGroup: false,
      lastMessage: {
        sender: '张三 (架构师)',
        isFromMe: false, // 对方发来
        text: '下午两点有空对一下接口设计吗？',
      },
      needsReply: true,
      summary: '张三约接口设计对齐会议',
    };

    const driver = new DesktopVisionPersonalDriver({
      pollIntervalMs: 5000,
      captureFn: async () => mockCaptureRes,
      parseFn: async () => mockParseRes,
    });

    driver.onMessage = onMessage;
    await driver.start();

    // 第一次 tick 应该触发 onMessage
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        fromId: '张三 (架构师)',
        fromName: '张三 (架构师)',
        isRoom: false,
        text: '下午两点有空对一下接口设计吗？',
      })
    );

    // 消息防重复机制测试：下一次 tick 捕获相同指纹消息，不应重复触发
    await driver.tick();
    expect(onMessage).toHaveBeenCalledTimes(1);

    await driver.stop();
  });

  it('我方发送的消息 (右侧绿色气泡) 不触发自动回复', async () => {
    const onMessage = vi.fn();

    const driver = new DesktopVisionPersonalDriver({
      pollIntervalMs: 5000,
      captureFn: async () => ({
        ok: true,
        buffer: Buffer.from('fake-img'),
        sourceType: 'electron_capturer',
      }),
      parseFn: async () => ({
        ok: true,
        hasWeChatWindow: true,
        chatTarget: '李四',
        lastMessage: {
          sender: '我',
          isFromMe: true, // 我方已发送
          text: '好的，稍后发你。',
        },
        needsReply: false,
      }),
    });

    driver.onMessage = onMessage;
    await driver.start();

    expect(onMessage).not.toHaveBeenCalled();
    await driver.stop();
  });

  it('sendMessage 模拟执行动作 (Do) 成功并防止自己的回复引起循环', async () => {
    const sendFn = vi.fn().mockResolvedValue({ ok: true });

    const driver = new DesktopVisionPersonalDriver({
      sendFn,
      captureFn: async () => ({ ok: false, sourceType: 'none' }),
      isWeChatRunningFn: async () => true,
    });

    await driver.start();
    const result = await driver.sendMessage('张三 (架构师)', '没问题，下午两点准时开会！');
    expect(result).toBeDefined();
    expect(sendFn).toHaveBeenCalledWith(
      expect.objectContaining({
        targetName: '张三 (架构师)',
        text: '没问题，下午两点准时开会！',
      })
    );

    await driver.stop();
  });

  it('parseWeChatScreen 正确解析包含 markdown 格式的 VLM JSON 响应', async () => {
    const mockJson = {
      hasWeChatWindow: true,
      chatTarget: '产品项目组',
      isGroup: true,
      lastMessage: {
        sender: '王经理',
        isFromMe: false,
        text: '明天发布新版本',
      },
      needsReply: true,
      summary: '王经理同步明天发布新版本',
    };

    const mockOpenAIClient: any = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: `\`\`\`json\n${JSON.stringify(mockJson)}\n\`\`\``,
                },
              },
            ],
          }),
        },
      },
    };

    const res = await parseWeChatScreen(Buffer.from('test-image'), {
      client: mockOpenAIClient,
      apiKey: 'test-key',
      model: 'gpt-5.5',
    });

    expect(res.ok).toBe(true);
    expect(res.hasWeChatWindow).toBe(true);
    expect(res.chatTarget).toBe('产品项目组');
    expect(res.isGroup).toBe(true);
    expect(res.lastMessage?.sender).toBe('王经理');
    expect(res.lastMessage?.text).toBe('明天发布新版本');
    expect(res.needsReply).toBe(true);
  });

  it('isWeChatRunning 能够在系统环境下安全调用检测', async () => {
    const running = await isWeChatRunning();
    expect(typeof running).toBe('boolean');
  });

  it('parseWeChatOcrItems 准确识别聊天视窗中的最新来信与自测发信', async () => {
    const { parseWeChatOcrItems } = await import('../src/channels/wechat/desktop-vision/ocr-parser.js');
    const mockItems = [
      { text: 'Q 搜索', x: 0.12, y: 0.91, width: 0.04, height: 0.02 },
      { text: '我', x: 0.36, y: 0.91, width: 0.02, height: 0.02 }, // 标题栏
      { text: '你好', x: 0.84, y: 0.66, width: 0.03, height: 0.02 }, // 我方右侧发出的气泡
      { text: '你好', x: 0.43, y: 0.58, width: 0.03, height: 0.02 }, // 对方左侧气泡
      { text: '请回复我', x: 0.43, y: 0.44, width: 0.06, height: 0.02 }, // 对方左侧气泡
      { text: '请回复收到', x: 0.43, y: 0.30, width: 0.07, height: 0.02 }, // 最新对方左侧气泡 (最低 y)
    ];

    const res = parseWeChatOcrItems(mockItems);
    expect(res.ok).toBe(true);
    expect(res.hasWeChatWindow).toBe(true);
    expect(res.chatTarget).toBe('我');
    expect(res.lastMessage?.text).toBe('请回复收到');
    expect(res.lastMessage?.isFromMe).toBe(false);
    expect(res.needsReply).toBe(true);
  });

  it('parseWeChatOcrItems 我方最新发出的绿色气泡不触发 needsReply', async () => {
    const { parseWeChatOcrItems } = await import('../src/channels/wechat/desktop-vision/ocr-parser.js');
    const mockItems = [
      { text: '张三', x: 0.36, y: 0.91, width: 0.02, height: 0.02 }, // 标题栏
      { text: '明天开会吗？', x: 0.43, y: 0.58, width: 0.06, height: 0.02 }, // 对方气泡
      { text: '好的，准时参加。', x: 0.84, y: 0.30, width: 0.08, height: 0.02 }, // 我方最新气泡 (最低 y, x >= 0.70)
    ];

    const res = parseWeChatOcrItems(mockItems);
    expect(res.ok).toBe(true);
    expect(res.chatTarget).toBe('张三');
    expect(res.lastMessage?.text).toBe('好的，准时参加。');
    expect(res.lastMessage?.isFromMe).toBe(true);
    expect(res.needsReply).toBe(false);
  });

  it('parseWeChatOcrItems 遇到当前会话已发但左侧列表有其他联系人待办时，自动切换会话触发回复', async () => {
    const { parseWeChatOcrItems } = await import('../src/channels/wechat/desktop-vision/ocr-parser.js');
    const mockItems = [
      { text: '十一', x: 0.36, y: 0.91, width: 0.02, height: 0.02, isTitle: true }, // 显式标题栏
      { text: '优化它的主题配色', x: 0.84, y: 0.30, width: 0.08, height: 0.02 }, // 我方右侧绿色气泡
      { text: '我', x: 0.16, y: 0.82, width: 0.04, height: 0.02 }, // 会话列表联系人
      { text: '请回复 1', x: 0.16, y: 0.79, width: 0.08, height: 0.02 }, // 会话列表预览
    ];

    const res = parseWeChatOcrItems(mockItems);
    expect(res.ok).toBe(true);
    // 应该识别出需要自动切换到联系人“我”
    expect(res.chatTarget).toBe('我');
    expect(res.lastMessage?.text).toBe('请回复 1');
    expect(res.lastMessage?.isFromMe).toBe(false);
    expect(res.needsReply).toBe(true);
  });

  it('parseWeChatOcrItems 准确识别长文本我方绿色气泡 (向左延展至 x=0.52)，绝不误判为对方来信导致死循环', async () => {
    const { parseWeChatOcrItems } = await import('../src/channels/wechat/desktop-vision/ocr-parser.js');
    const mockItems = [
      { text: '好友小王', x: 0.36, y: 0.91, width: 0.04, height: 0.02 }, // 标题栏
      { text: '啥也不做', x: 0.43, y: 0.65, width: 0.05, height: 0.02 }, // 对方气泡
      // 我方回复的 35 字长文本：气泡靠右贴齐头像 (x+width=0.92)，但起始 x 延伸到了 0.52
      {
        text: '哈哈你这也是复读机附体了吧别光陪我的话呀有活儿你倒是说一个',
        x: 0.52,
        y: 0.30,
        width: 0.40,
        height: 0.02,
      },
    ];

    const res = parseWeChatOcrItems(mockItems);
    expect(res.ok).toBe(true);
    expect(res.chatTarget).toBe('好友小王');
    expect(res.lastMessage?.isFromMe).toBe(true); // 必须精准识别为我方发出
    expect(res.needsReply).toBe(false); // 必须判定为无需回复，彻底杜绝自言自语死循环
  });

  it('parseWeChatOcrItems 能够对多行绿色气泡进行聚类，尾行极短字符（如“至更直接，我也能顶住～”、“定～”）绝不误判为对方来信', async () => {
    const { parseWeChatOcrItems } = await import('../src/channels/wechat/desktop-vision/ocr-parser.js');
    // 真实复现用户截图中的场景：
    // 我方发出多行绿色气泡，前两行很长靠右贴齐头像 (rightEdge=0.92)，尾行仅有 10 个字，居左偏中间 (x=0.44, width=0.18, rightEdge=0.62)
    const mockItems = [
      { text: '我', x: 0.36, y: 0.91, width: 0.02, height: 0.02, isTitle: true },
      { text: '定个锤子——出题都我来定嘛', x: 0.44, y: 0.38, width: 0.48, height: 0.02 },
      { text: '快选一个，开始考试 或者你直接甩给我一个具体任务', x: 0.44, y: 0.34, width: 0.48, height: 0.02 },
      { text: '至更直接，我也能顶住～', x: 0.44, y: 0.30, width: 0.18, height: 0.02 },
    ];

    const res = parseWeChatOcrItems(mockItems);
    expect(res.ok).toBe(true);
    expect(res.chatTarget).toBe('我');
    // 必须通过聚类判定为我方发出
    expect(res.lastMessage?.isFromMe).toBe(true);
    expect(res.needsReply).toBe(false);
  });

  it('isTextSentByMe 能够准确通过模糊与归一化子串拦截回复尾行片段', async () => {
    const { isTextSentByMe } = await import('../src/channels/wechat/desktop-vision/ocr-parser.js');
    const sentHistory = new Set([
      '要是做不到，算我输！😎 来，请出题～',
      '快选一个，开始考试👉 或者你直接甩给我一个具体任务甚至更直接，我也能顶住～',
      '我随时准备执行～ 😎',
      '我 6 的，随时准备接锅～😎',
    ]);

    expect(isTextSentByMe('出题～', sentHistory)).toBe(true);
    expect(isTextSentByMe('至更直接，我也能顶住～', sentHistory)).toBe(true);
    expect(isTextSentByMe('我随时准备执行～', sentHistory)).toBe(true);
    expect(isTextSentByMe('我6的，随时准备接锅～', sentHistory)).toBe(true);
    expect(isTextSentByMe('你好，请问这个功能怎么用？', sentHistory)).toBe(false);
  });

  it('DesktopVisionPersonalDriver 启用基线像素比对 (SightFlow 模式) 时，若聊天区域无变化则完全跳过 OCR 分析', async () => {
    const parseFn = vi.fn().mockResolvedValue({
      ok: true,
      hasWeChatWindow: true,
      chatTarget: '好友小李',
      lastMessage: { sender: '好友小李', text: '在吗？', isFromMe: false },
      needsReply: true,
    });

    const mockBuffer = Buffer.from('screenshot-data');
    let diffCalls = 0;
    const checkDiffFn = vi.fn().mockImplementation(async () => {
      diffCalls++;
      // 模拟图像对比：无变化
      return { hasDiff: false, diffRatio: 0 };
    });

    const driver = new DesktopVisionPersonalDriver({
      pollIntervalMs: 5000,
      captureFn: vi.fn().mockResolvedValue({
        ok: true,
        buffer: mockBuffer,
        sourceType: 'electron_capturer',
      }),
      parseFn,
      sendFn: vi.fn().mockResolvedValue({ ok: true }),
      isWeChatRunningFn: vi.fn().mockResolvedValue(true),
      checkDiffFn,
    });

    await driver.start();

    // 模拟发送消息建立基线
    await driver.sendMessage('好友小李', '在的，请讲！');
    parseFn.mockClear();

    // 执行下一次轮询扫描
    await driver.tick();

    // 应该调用 checkDiffFn 进行基线比对
    expect(checkDiffFn).toHaveBeenCalled();
    // 由于 hasDiff 为 false，parseFn 应该完全被跳过，不消耗算力与 Token
    expect(parseFn).not.toHaveBeenCalled();

    await driver.stop();
  });
});

