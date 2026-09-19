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
});
