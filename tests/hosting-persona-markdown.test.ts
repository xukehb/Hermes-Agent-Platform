import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelContactStore } from '../src/channels/contacts-store.js';
import { WeChatContactStore } from '../src/channels/wechat-contacts.js';
import { GuiService } from '../src/gui/service.js';
import { WeChatChannel } from '../src/channels/wechat.js';
import { QQChannel } from '../src/channels/qq.js';
import type { ChannelHost } from '../src/channels/types.js';
import type { RunTaskRequest, TaskOutcome, SessionStatus, TraceSummary, UsageAggregate } from '../src/agent/index.js';

class StubHost implements ChannelHost {
  readonly requests: RunTaskRequest[] = [];
  async runTask(request: RunTaskRequest): Promise<TaskOutcome> {
    this.requests.push(request);
    return {
      taskId: 'test-task',
      agentId: request.agentId ?? 'coder',
      sessionKey: request.sessionKey ?? 'test:session',
      status: 'done',
      tracePath: '',
      text: '收到',
      reasoning: '',
      messages: [{ role: 'assistant', content: '收到' }],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      iterations: 1,
      model: 'test/model',
      protocol: 'deepseek',
      finishReason: 'stop',
      stopReason: 'stop',
      retranslations: 0,
    };
  }

  abortSession(): string[] {
    return [];
  }

  status(sessionKey: string): SessionStatus {
    return {
      sessionKey,
      agentId: 'coder',
      model: 'test/model',
      chain: ['test/model'],
      running: [],
      recent: [],
      todayTokens: 0,
      dailyTokenBudget: 100,
    };
  }

  trace(): TraceSummary | undefined {
    return undefined;
  }

  agentIds(): string[] {
    return ['coder', 'writer'];
  }

  clearSession(): void {
    /* no-op */
  }

  usageSince(): UsageAggregate[] {
    return [];
  }
}

describe('Hosting Persona Markdown Specification & Service (托管人设与语气 Markdown 文档规范)', () => {
  const testStoreDir = join(tmpdir(), `hap_test_persona_md_${Date.now()}`);
  const testStorePath = join(testStoreDir, 'contacts.json');

  beforeEach(() => {
    ChannelContactStore.resetInstance();
    WeChatContactStore.resetInstance();
  });

  afterEach(() => {
    ChannelContactStore.resetInstance();
    WeChatContactStore.resetInstance();
    if (existsSync(testStoreDir)) {
      rmSync(testStoreDir, { recursive: true, force: true });
    }
  });

  describe('GuiService 模板库与文件操作', () => {
    it('能够正确获取 6 套预设 Markdown 模板并校验其结构规范', () => {
      const service = new GuiService();
      const templates = service.getHostingPersonaTemplates();

      expect(templates.length).toBe(6);
      const keys = templates.map((t) => t.key);
      expect(keys).toContain('natural');
      expect(keys).toContain('business');
      expect(keys).toContain('tech');
      expect(keys).toContain('humor');
      expect(keys).toContain('polite');
      expect(keys).toContain('assistant');

      for (const t of templates) {
        expect(t.title).toBeTruthy();
        expect(t.emoji).toBeTruthy();
        expect(t.content).toBeTruthy();
        // 验证遵循 Markdown 规范结构
        expect(t.content).toContain('# 角色定位');
        expect(t.content).toContain('## 语气风格与口吻');
        expect(t.content).toContain('## 回复原则');
        expect(t.content).toContain('## 敏感红线与禁忌');
      }
    });

    it('支持将分身人设导出为本地 Markdown 文档并重新读取', () => {
      const service = new GuiService();
      const exportPath = join(testStoreDir, 'subfolder', 'custom-persona.md');
      const sampleMarkdown = `# 角色定位 (Identity & Persona)
- **身份**: 专属AI研发测试助理
- **核心目标**: 自动化验证测试

## 语气风格与口吻
- **口吻基调**: 严肃严谨
`;

      const exportRes = service.exportHostingPersonaMarkdown(exportPath, sampleMarkdown);
      expect(exportRes.ok).toBe(true);
      expect(existsSync(exportPath)).toBe(true);
      expect(readFileSync(exportPath, 'utf8')).toBe(sampleMarkdown);

      const loadRes = service.loadHostingPersonaMarkdown(exportPath);
      expect(loadRes.ok).toBe(true);
      expect(loadRes.content).toBe(sampleMarkdown);

      const notFoundRes = service.loadHostingPersonaMarkdown(join(testStoreDir, 'non-existent.md'));
      expect(notFoundRes.ok).toBe(false);
      expect(notFoundRes.error).toContain('文件未找到');
    });
  });

  describe('通道层 Markdown 人设指令注入与解析', () => {
    it('WeChatChannel 遇到 Markdown 文档时使用清晰的规范隔离区注入', async () => {
      const store = ChannelContactStore.getInstance(testStorePath);
      const wechatStore = WeChatContactStore.getInstance(testStorePath);
      const markdownPersona = `# 角色定位
- **身份**: 架构师分身

## 语气风格与口吻
- 控制在1句话内`;

      store.upsertContact({
        id: 'wx_user_markdown',
        channel: 'wechat',
        name: '李工',
        systemPrompt: markdownPersona,
      });

      const host = new StubHost();
      const channel = new WeChatChannel({
        host,
        channels: {
          editIntervalMs: 0,
          asyncThresholdMs: 10000,
          wechat: {
            enabled: true,
            mode: 'desktop_vision',
            authDir: testStoreDir,
            mentionPatterns: [],
            messageCharLimit: 2048,
            qrLog: false,
          },
        } as never,
        limits: {
          ingressQueueSize: 100,
        } as never,
        paths: {
          spoolDir: join(testStoreDir, 'spool'),
        } as never,
        contactStore: wechatStore,
      });

      // 模拟接收微信消息
      await channel.handlePersonalMessage({
        id: 'msg_1',
        fromId: 'wx_user_markdown',
        fromName: '李工',
        isRoom: false,
        text: '这个高并发架构怎么设计？',
      });

      expect(host.requests.length).toBe(1);
      const req = host.requests[0]!;
      const submittedPrompt = req.systemPrompt ?? req.input;
      expect(submittedPrompt).toContain('【专属分身人设、语气风格与行为规范 (Markdown 规范文档)】');
      expect(submittedPrompt).toContain(markdownPersona);
      expect(submittedPrompt).toContain('微信聊天规范：当前为微信好友即时通讯');
      expect(req.input).toBe('这个高并发架构怎么设计？');
    });

    it('WeChatChannel 遇到传统单行人设时保持向后兼容格式', async () => {
      const store = ChannelContactStore.getInstance(testStorePath);
      const singleLinePersona = '简短自然，像真人朋友一样回复';

      store.upsertContact({
        id: 'wx_user_legacy',
        channel: 'wechat',
        name: '老周',
        systemPrompt: singleLinePersona,
      });

      const host = new StubHost();
      const channel = new WeChatChannel({
        host,
        channels: {
          editIntervalMs: 0,
          asyncThresholdMs: 10000,
          wechat: {
            enabled: true,
            mode: 'desktop_vision',
            authDir: testStoreDir,
            mentionPatterns: [],
            messageCharLimit: 2048,
            qrLog: false,
          },
        } as never,
        limits: {
          ingressQueueSize: 100,
        } as never,
        paths: {
          spoolDir: join(testStoreDir, 'spool'),
        } as never,
        contactStore: WeChatContactStore.getInstance(testStorePath),
      });

      await channel.handlePersonalMessage({
        id: 'msg_2',
        fromId: 'wx_user_legacy',
        fromName: '老周',
        isRoom: false,
        text: '晚上去吃火锅吗？',
      });

      expect(host.requests.length).toBe(1);
      const req2 = host.requests[0]!;
      const submittedPrompt2 = req2.systemPrompt ?? req2.input;
      expect(submittedPrompt2).toContain(`[专属人设指令：${singleLinePersona}]`);
      expect(submittedPrompt2).not.toContain('【专属分身人设、语气风格与行为规范 (Markdown 规范文档)】');
      expect(req2.input).toBe('晚上去吃火锅吗？');
    });

    it('QQChannel 支持全局默认策略与单联系人 Markdown 人设注入', async () => {
      const store = ChannelContactStore.getInstance(testStorePath);
      const defaultMarkdown = `# 角色定位
- **身份**: QQ群技术助手`;

      store.saveDefaultPolicy('qq', {
        systemPrompt: defaultMarkdown,
      });

      store.upsertContact({
        id: 'qq_user_dev',
        channel: 'qq',
        name: '小陈',
      });

      const host = new StubHost();
      const channel = new QQChannel({
        host,
        contactStore: store,
        config: {
          mode: 'onebot',
          defaultAgent: 'coder',
        },
      });

      await channel.handleOneBotPayload(JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: 1001,
        user_id: 12345,
        sender: { user_id: 12345, nickname: '小陈' },
        raw_message: '你好，请教一个问题',
        time: Math.floor(Date.now() / 1000),
      }));

      expect(host.requests.length).toBe(1);
      const submittedPrompt = host.requests[0]!.input;
      expect(submittedPrompt).toContain('【专属托管人设、语气风格与行为规范 (Markdown 规范文档)】');
      expect(submittedPrompt).toContain(defaultMarkdown);
      expect(submittedPrompt).toContain('对方发来：“你好，请教一个问题”');
    });

    it('ChannelContactStore 完整保留多行 Markdown 人设内容而不发生数据截断或转义损坏', () => {
      const store = ChannelContactStore.getInstance(testStorePath);
      const richMarkdown = `# 角色定位 (Identity & Persona)
- **身份**: 专属数字分身
## 语气风格与口吻
- **篇幅**: 1~2 句话
## 敏感红线
- 🚫 严禁私自借钱`;

      store.saveDefaultPolicy('wechat', {
        systemPrompt: richMarkdown,
        hostingMode: 'auto',
      });

      const loaded = store.getDefaultPolicy('wechat');
      expect(loaded.systemPrompt).toBe(richMarkdown);
      expect(loaded.hostingMode).toBe('auto');

      // 重新实例化验证磁盘持久化
      ChannelContactStore.resetInstance();
      const store2 = ChannelContactStore.getInstance(testStorePath);
      const loaded2 = store2.getDefaultPolicy('wechat');
      expect(loaded2.systemPrompt).toBe(richMarkdown);
    });
  });
});
