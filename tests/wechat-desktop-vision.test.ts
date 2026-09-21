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

  it('DesktopVisionPersonalDriver 实时上报来信识别、动作模拟与成功发送等 Live Feed 动态', async () => {
    const activities: any[] = [];
    const onActivity = vi.fn((act) => activities.push(act));

    const driver = new DesktopVisionPersonalDriver({
      onActivity,
      isWeChatRunningFn: vi.fn().mockResolvedValue(true),
      captureFn: vi.fn().mockResolvedValue({
        ok: true,
        buffer: Buffer.from('fake'),
        sourceType: 'electron_capturer',
      }),
      parseFn: vi.fn().mockResolvedValue({
        ok: true,
        hasWeChatWindow: true,
        chatTarget: '产品经理小王',
        isGroup: false,
        lastMessage: {
          sender: '产品经理小王',
          isFromMe: false,
          text: '帮我查一下这周排期',
        },
        needsReply: true,
      }),
      sendFn: vi.fn().mockResolvedValue({ ok: true }),
    });

    await driver.start();
    expect(activities.some((a) => a.stage === 'system' && a.tag === '静默巡检')).toBe(true);

    // 触发单次扫描
    await driver.tick();
    const detected = activities.find((a) => a.stage === 'detected');
    expect(detected).toBeDefined();
    expect(detected.tag).toBe('微信来信');
    expect(detected.title).toContain('产品经理小王');
    expect(detected.title).toContain('帮我查一下这周排期');

    // 模拟回复发送
    await driver.sendMessage('产品经理小王', '排期已整理完毕，请看文档。');
    const executing = activities.find((a) => a.stage === 'executing');
    expect(executing).toBeDefined();
    expect(executing.tag).toBe('动作模拟');
    expect(executing.title).toContain('产品经理小王');

    const sent = activities.find((a) => a.stage === 'sent');
    expect(sent).toBeDefined();
    expect(sent.tag).toBe('发送成功');
    expect(sent.detail).toContain('排期已整理完毕');

    await driver.stop();
  });

  it('Ubuntu Linux 环境下通过 xwininfo 解析微信窗口几何边界', async () => {
    const { getWeChatWindowBounds } = await import('../src/channels/wechat/desktop-vision/action-driver.js');
    const bounds = await getWeChatWindowBounds();
    // 本机若是 Linux 且运行着微信，应解析出有效边界结构
    if (process.platform === 'linux' && bounds) {
      expect(bounds.wid).toBeGreaterThan(0);
      expect(bounds.width).toBeGreaterThan(200);
      expect(bounds.height).toBeGreaterThan(200);
      expect(typeof bounds.x).toBe('number');
      expect(typeof bounds.y).toBe('number');
    }
  });

  it('isWeChatRunning 支持在 Linux / Windows / macOS 跨平台安全探测', async () => {
    const running = await isWeChatRunning();
    expect(typeof running).toBe('boolean');
  });

  it('clickScreenCoords 与 sendWeChatReply 参数校验健全', async () => {
    const { clickScreenCoords, sendWeChatReply } = await import('../src/channels/wechat/desktop-vision/action-driver.js');
    // 空内容回复应拦截返回错误
    const emptyRes = await sendWeChatReply({ text: '   ' });
    expect(emptyRes.ok).toBe(false);
    expect(emptyRes.error).toContain('不能为空');

    // 坐标有效数值传递
    const clickRes = await clickScreenCoords(100, 200);
    expect(typeof clickRes).toBe('boolean');
  });

  it('parseWeChatScreen 在未就绪原生 OCR 平台能自动降级至 VLM 解析', async () => {
    const mockClient: any = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    hasWeChatWindow: true,
                    chatTarget: '测试好友',
                    needsReply: false,
                    summary: '已成功识别微信界面',
                  }),
                },
              },
            ],
          }),
        },
      },
    };

    const res = await parseWeChatScreen(Buffer.from('dummy-image'), { client: mockClient, apiKey: 'test' });
    expect(res.ok).toBe(true);
    expect(res.hasWeChatWindow).toBe(true);
    expect(res.chatTarget).toBe('测试好友');
  });
});

