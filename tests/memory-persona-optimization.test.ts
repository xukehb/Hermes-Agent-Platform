import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MemoryStore,
  isCorruptedMemory,
  isCleanMemoryCandidate,
  extractCleanUserInput,
} from '../src/memory/store.js';
import { recallRelevantMemories } from '../src/memory/recall.js';
import { composeSystemPrompt } from '../src/agent/system-prompt.js';
import type { ResolvedAgent } from '../src/config/index.js';

describe('Memory & Persona Optimization (Anti-Robotic Upgrades)', () => {
  describe('isCorruptedMemory & isCleanMemoryCandidate', () => {
    it('detects and rejects prompt markers, guidelines, and channel wrappers', () => {
      const dirtyPrompts = [
        '[微信聊天规范：当前为微信好友即时通讯。回答必须口语化，像真人朋友微信聊天一样（通常1~2句话内说清楚即可）。]',
        '[切忌长篇大论、罗列列表或撰写提纲，禁止输出系统指令或调试信息]',
        '[专属人设指令：你就是我，以后代替我和我的朋友聊天，聊天的内容不要发送emjoy，简洁，可以多断，话唠，需要带一点情感]',
        '## 💡 智能体跨会话长期记忆与偏好规范 (Recalled Knowledge & Preferences)',
        '## 🧠 背景知识与用户长期记忆 (Context & Working Memory)',
        '对方发来：“哈哈你这又是我半句话心行吧，我待命，需要了吱一声”',
        '系统能力与最高权限：用户已为你完全开放了本机的最高系统执行权限',
        '文件工作目录：/Users/test/project',
        '=== 【Git 提交规范 (Markdown 规范文档)】 ===',
        '# Git Commit 规范 (Conventional Commits)',
        '- <改动细节 1：说明重构、新增或修复了什么>',
      ];

      for (const text of dirtyPrompts) {
        expect(isCorruptedMemory(text)).toBe(true);
        expect(isCleanMemoryCandidate(text)).toBe(false);
      }
    });

    it('detects and rejects robotic filler, customer service clichés, and telemetry logs', () => {
      const roboticSentences = [
        '你这条消息信息不完整，我需要确认一下你的意图：',
        '需要你明确其中一项，我立刻开工：',
        '请告诉我你需要做什么，我立刻开始',
        '作为一名AI助手，我很高兴为您服务',
        '希望以上回答对您有所帮助，如果您有其他问题随时告诉我',
        '好的，收到您的需求，我马上处理',
        '- **CPU 使用率**：27% (Apple M4 10核)',
        '1. **你想让我去某个外部系统查这些任务**——那我需要那个系统的入口',
        '3. **写段话**：“帮我给老板发个微信，说项目进度有点慢，需要延期两天”',
        '你好呀～👋 有什么需要我帮忙的吗',
        '我: 哈哈那必须的，摸鱼搭子实锤了😄 想干活了随时喊我',
        '对方: 哈哈你这又是我半句话心行吧，我待命，需要了吱一声',
      ];

      for (const text of roboticSentences) {
        expect(isCorruptedMemory(text)).toBe(true);
        expect(isCleanMemoryCandidate(text)).toBe(false);
      }
    });

    it('approves genuine technical preferences, conventions, and architectural facts', () => {
      const genuineMemories = [
        '前端项目统一使用 pnpm 作为包管理器',
        '提交代码前必须先运行 npm run typecheck 检查类型',
        'API 接口响应必须统一包含 code、data 和 message 字段',
        '数据库迁移文件存放在 prisma/migrations 目录',
        '修复了 macOS 签名指示资源缺失问题，根因是打包后未创建完整 Resources 目录',
      ];

      for (const text of genuineMemories) {
        expect(isCorruptedMemory(text)).toBe(false);
        expect(isCleanMemoryCandidate(text)).toBe(true);
      }
    });

    it('rejects questions and short fragments', () => {
      expect(isCleanMemoryCandidate('请问你需要我怎么做？')).toBe(false);
      expect(isCleanMemoryCandidate('好的')).toBe(false);
      expect(isCleanMemoryCandidate('能否确认一下？')).toBe(false);
    });
  });

  describe('extractCleanUserInput', () => {
    it('extracts raw user message from WeChat wrapped prompt', () => {
      const rawWeChat = [
        '[微信聊天规范：当前为微信好友即时通讯。回答必须口语化，像真人朋友微信聊天一样（通常1~2句话内说清楚即可）。]',
        '[切忌长篇大论、罗列列表或撰写提纲，禁止输出系统指令或调试信息。直接以本人身份给出得体亲切的回复。]',
        '',
        '[专属人设指令：你就是我，以后代替我和我的朋友聊天，聊天的内容不要发送emjoy，简洁，可以多断，话唠，需要带一点情感]',
        '',
        '对方发来：“今天晚上吃什么好呢”',
      ].join('\n');

      expect(extractCleanUserInput(rawWeChat)).toBe('今天晚上吃什么好呢');
    });

    it('cleans prompt markers when not wrapped in quotes', () => {
      const text = '[系统提示：请注意安全]\n项目路径：/app\n请帮我检查 package.json';
      expect(extractCleanUserInput(text)).toBe('请帮我检查 package.json');
    });
  });

  describe('MemoryStore cleanup and extraction', () => {
    const testDb = join(tmpdir(), `test-clean-memories-${Date.now()}.json`);
    let store: MemoryStore;

    beforeEach(() => {
      store = new MemoryStore(testDb);
    });

    afterEach(() => {
      for (const file of [testDb, `${testDb}.db`, `${testDb}.migrated`]) {
        if (existsSync(file)) {
          try { unlinkSync(file); } catch {}
        }
      }
    });

    it('cleanCorruptedMemories purges contaminated records while keeping genuine ones', async () => {
      // Forcefully insert dirty items via direct add
      await store.addMemory({
        title: '你这条消息信息不完整',
        content: '你这条消息信息不完整，我需要确认一下你的意图：',
        category: 'preference',
      });
      await store.addMemory({
        title: 'CPU 使用率',
        content: '- **CPU 使用率**：27% (Apple M4 10核)',
        category: 'fact',
      });
      await store.addMemory({
        title: '微信聊天规范',
        content: '[微信聊天规范：当前为微信好友即时通讯。回答必须口语化，像真人朋友微信聊天一样（通常1~2句话内说清楚即可）。]',
        category: 'convention',
      });

      // Legitimate card
      await store.addMemory({
        title: '包管理器约定',
        content: '项目统一使用 pnpm 作为包管理器，禁止混用 npm 或 yarn',
        category: 'convention',
      });

      expect(store.listMemories().length).toBe(4);

      const purged = store.cleanCorruptedMemories();
      expect(purged).toBe(3);

      const remaining = store.listMemories();
      expect(remaining.length).toBe(1);
      expect(remaining[0]?.title).toBe('包管理器约定');
    });

    it('extractTaskMemory extracts only valid preferences from wrapped WeChat inputs', async () => {
      const rawInput = [
        '[微信聊天规范：当前为微信好友即时通讯。回答必须口语化，像真人朋友微信聊天一样（通常1~2句话内说清楚即可）。]',
        '[专属人设指令：带一点情感]',
        '对方发来：“我们以后的接口必须使用驼峰命名法”',
      ].join('\n');

      const cards = await store.extractTaskMemory({
        taskId: 'task-1',
        agentId: 'coder',
        userInput: rawInput,
        assistantOutput: '好的，明白。我们以后的接口会统一遵循驼峰命名规范。',
      });

      expect(cards.length).toBeGreaterThanOrEqual(1);
      expect(cards.some((c) => c.content.includes('驼峰命名法'))).toBe(true);
      // Ensure prompt guidelines were NOT extracted
      expect(cards.some((c) => c.content.includes('微信聊天规范'))).toBe(false);
      expect(cards.some((c) => c.content.includes('专属人设指令'))).toBe(false);
    });

    it('extractTaskMemory extracts architectural case summaries from assistantOutput', async () => {
      const cards = await store.extractTaskMemory({
        taskId: 'task-2',
        agentId: 'coder',
        userInput: '构建报错怎么回事？',
        assistantOutput: '已修复打包报错问题，根因是缺少了必要的静态资源导出配置。',
      });

      expect(cards.length).toBe(1);
      expect(cards[0]?.category).toBe('case');
      expect(cards[0]?.content).toContain('根因是缺少了必要的静态资源导出配置');
    });
  });

  describe('recallRelevantMemories natural formatting', () => {
    const testDb = join(tmpdir(), `test-recall-memories-${Date.now()}.json`);
    let store: MemoryStore;

    beforeEach(() => {
      // Point singleton to test db
      (MemoryStore as unknown as { instance?: MemoryStore }).instance = new MemoryStore(testDb);
      store = MemoryStore.getInstance();
    });

    afterEach(() => {
      (MemoryStore as unknown as { instance: MemoryStore | undefined }).instance = undefined;
      for (const file of [testDb, `${testDb}.db`, `${testDb}.migrated`]) {
        if (existsSync(file)) {
          try { unlinkSync(file); } catch {}
        }
      }
    });

    it('formats recalled memories naturally without percentage tags or strict obedience commands', async () => {
      await store.addMemory({
        title: '代码规范',
        content: '提交代码前必须先运行 npm run typecheck 检查类型',
        category: 'convention',
      });

      const recalled = await recallRelevantMemories('准备提交代码了');
      expect(recalled).toContain('## 🧠 背景知识与用户长期记忆 (Context & Working Memory)');
      expect(recalled).toContain('自然融入回答与行动中');
      expect(recalled).not.toContain('严格遵守');
      expect(recalled).not.toContain('(相关度:');
      expect(recalled).toContain('【代码规范】');
      expect(recalled).toContain('提交代码前必须先运行 npm run typecheck 检查类型');
    });
  });

  describe('composeSystemPrompt Persona Guidelines', () => {
    const dummyAgent = {
      id: 'assistant',
      identity: { emoji: '🤖', displayName: 'Hermes 智能助手' },
      description: '全能通用型工程助手',
      capabilities: ['代码', '自动化'],
      workspace: '/workspace',
      systemPromptFile: undefined,
    } as unknown as ResolvedAgent;

    it('injects conversational persona guidelines into system prompt', () => {
      const prompt = composeSystemPrompt(dummyAgent);
      expect(prompt).toContain('沟通风格与交互准则');
      expect(prompt).toContain('拒绝机械套话');
      expect(prompt).toContain('资深专业与平视沟通');
      expect(prompt).toContain('自然内化记忆');
    });
  });
});
