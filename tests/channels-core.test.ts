/**
 * 通道层纯函数与组件测试：命令解析、mention 抽取、串行队列、分片与重投缓冲、
 * 事件渲染、监听地址解析。这些单元不依赖编排层，因此不需要桩宿主。
 *
 * 日期：2026-08-24  执行者：Codex
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OutboundSender,
  SessionQueue,
  TaskRenderer,
  extractMention,
  parseBind,
  parseCommand,
  splitForChannel,
} from '../src/channels/index.js';
import type { OutboundTarget } from '../src/channels/index.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hap-chan-'));
  roots.push(root);
  return root;
}

/** 记录发送内容的桩目标；failFirst 用于验证失败落盘。 */
function stubTarget(options: { failAll?: boolean } = {}): OutboundTarget & { sent: string[] } {
  const sent: string[] = [];
  return {
    channel: 'telegram',
    targetId: 'chat:1',
    sent,
    async send(text: string): Promise<string | undefined> {
      if (options.failAll === true) throw new Error('网络不通');
      sent.push(text);
      return 'msg-' + String(sent.length);
    },
  };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('parseCommand', () => {
  it('非斜杠开头视为提示词并 trim', () => {
    expect(parseCommand('  帮我写个函数  ')).toEqual({ kind: 'prompt', text: '帮我写个函数' });
  });

  it('句中出现斜杠不会被误判为命令', () => {
    expect(parseCommand('用 a/b 这个路径')).toEqual({ kind: 'prompt', text: '用 a/b 这个路径' });
  });

  it('stop 与 cancel 等价', () => {
    expect(parseCommand('/stop')).toEqual({ kind: 'stop' });
    expect(parseCommand('/cancel')).toEqual({ kind: 'stop' });
  });

  it('new 与 reset 等价，help 与 start 等价', () => {
    expect(parseCommand('/new')).toEqual({ kind: 'new' });
    expect(parseCommand('/reset')).toEqual({ kind: 'new' });
    expect(parseCommand('/help')).toEqual({ kind: 'help' });
    expect(parseCommand('/start')).toEqual({ kind: 'help' });
  });

  it('status 与 agents 无参数', () => {
    expect(parseCommand('/status')).toEqual({ kind: 'status' });
    expect(parseCommand('/agents')).toEqual({ kind: 'agents' });
  });

  it('trace 可带任务 id', () => {
    expect(parseCommand('/trace')).toEqual({ kind: 'trace' });
    expect(parseCommand('/trace abc-123')).toEqual({ kind: 'trace', taskId: 'abc-123' });
  });

  it('agent 可带智能体 id', () => {
    expect(parseCommand('/agent')).toEqual({ kind: 'agent' });
    expect(parseCommand('/agent coder')).toEqual({ kind: 'agent', agentId: 'coder' });
  });

  it('usage 天数非法时回落 7 天', () => {
    expect(parseCommand('/usage')).toEqual({ kind: 'usage', days: 7 });
    expect(parseCommand('/usage 30')).toEqual({ kind: 'usage', days: 30 });
    expect(parseCommand('/usage abc')).toEqual({ kind: 'usage', days: 7 });
    expect(parseCommand('/usage -3')).toEqual({ kind: 'usage', days: 7 });
    expect(parseCommand('/usage 0')).toEqual({ kind: 'usage', days: 7 });
  });

  it('剥离群聊里的 @botname 后缀并忽略大小写', () => {
    expect(parseCommand('/Status@hap_bot')).toEqual({ kind: 'status' });
    expect(parseCommand('/TRACE@hap_bot xyz')).toEqual({ kind: 'trace', taskId: 'xyz' });
  });

  it('多余空格不影响解析', () => {
    expect(parseCommand('/trace    abc    额外参数')).toEqual({ kind: 'trace', taskId: 'abc' });
  });

  it('未知命令返回命令名', () => {
    expect(parseCommand('/nosuch')).toEqual({ kind: 'unknown', name: 'nosuch' });
    expect(parseCommand('/')).toEqual({ kind: 'unknown', name: '' });
  });
});

describe('extractMention', () => {
 it('knownAgents 为空时 token 即智能体 id（CLI 单人场景）', () => {
    expect(extractMention('@coder 帮我改代码', [])).toEqual({ agentId: 'coder', text: '帮我改代码' });
  });

 it('knownAgents 白名单忽略大小写精确匹配，不在列表里的 token 原样保留', () => {
   expect(extractMention('@Coder 做事', ['coder'])).toEqual({ agentId: 'coder', text: '做事' });
   expect(extractMention('@other 做事', ['coder'])).toEqual({ text: '@other 做事' });
 });

 it('只识别开头的 mention', () => {
    expect(extractMention('请问 @coder 是谁', [])).toEqual({ text: '请问 @coder 是谁' });
  });

  it('仅有 mention 没有正文时正文为空', () => {
    expect(extractMention('@coder', [])).toEqual({ agentId: 'coder', text: '' });
  });
});

describe('SessionQueue', () => {
  it('同一会话严格串行', async () => {
    const order: string[] = [];
    const queue = new SessionQueue<string>({
      capacity: 10,
      handler: async (payload) => {
        order.push('开始' + payload);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('结束' + payload);
      },
    });

    queue.enqueue('s1', 'A');
    queue.enqueue('s1', 'B');
    await queue.drain();

    expect(order).toEqual(['开始A', '结束A', '开始B', '结束B']);
  });

  it('不同会话并行推进', async () => {
    const running: string[] = [];
    let maxConcurrent = 0;
    const queue = new SessionQueue<string>({
      capacity: 10,
      handler: async (payload) => {
        running.push(payload);
        maxConcurrent = Math.max(maxConcurrent, running.length);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running.splice(running.indexOf(payload), 1);
      },
    });

    queue.enqueue('s1', 'A');
    queue.enqueue('s2', 'B');
    await queue.drain();

    expect(maxConcurrent).toBe(2);
  });

  it('容量满时丢弃全局最旧的待处理项', async () => {
    const dropped: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handled: string[] = [];
    const queue = new SessionQueue<string>({
      capacity: 1,
      handler: async (payload) => {
        handled.push(payload);
        await gate;
      },
      onDrop: (payload) => dropped.push(payload),
    });

    queue.enqueue('s1', 'A');
    expect(queue.isRunning('s1')).toBe(true);
    queue.enqueue('s1', 'B');
    expect(queue.size()).toBe(1);
    const third = queue.enqueue('s1', 'C');

    expect(third.accepted).toBe(true);
    expect(third.droppedKey).toBe('s1');
    expect(dropped).toEqual(['B']);
    expect(queue.pending('s1')).toBe(1);

    release();
    await queue.drain();
    expect(handled).toEqual(['A', 'C']);
  });

  it('capacity 至少为 1', () => {
    const queue = new SessionQueue<string>({ capacity: 0, handler: async () => {} });
    expect(queue.enqueue('s1', 'A').accepted).toBe(true);
  });

  it('handler 抛错走 onError 且不影响后续项', async () => {
    const errors: string[] = [];
    const done: string[] = [];
    const queue = new SessionQueue<string>({
      capacity: 10,
      handler: async (payload) => {
        if (payload === 'bad') throw new Error('处理失败');
        done.push(payload);
      },
      onError: (payload) => errors.push(payload),
    });

    queue.enqueue('s1', 'bad');
    queue.enqueue('s1', 'good');
    await queue.drain();

    expect(errors).toEqual(['bad']);
    expect(done).toEqual(['good']);
  });

  it('drain 在空队列上立即返回', async () => {
    const queue = new SessionQueue<string>({ capacity: 4, handler: async () => {} });
    await expect(queue.drain()).resolves.toBeUndefined();
  });
});

describe('splitForChannel', () => {
  it('短文本原样返回，空串返回空数组', () => {
    expect(splitForChannel('短文本', 100)).toEqual(['短文本']);
    expect(splitForChannel('', 100)).toEqual([]);
  });

  it('优先在空行处切分', () => {
    const text = 'A'.repeat(60) + '\n\n' + 'B'.repeat(60);
    const chunks = splitForChannel(text, 100);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('A'.repeat(60));
    expect(chunks[1]).toBe('B'.repeat(60));
  });

  it('无空行时退到换行处切分', () => {
    const text = 'A'.repeat(60) + '\n' + 'B'.repeat(60);
    const chunks = splitForChannel(text, 100);
    expect(chunks[0]).toBe('A'.repeat(60));
  });

  it('无换行时退到空格处切分', () => {
    const text = 'A'.repeat(60) + ' ' + 'B'.repeat(60);
    const chunks = splitForChannel(text, 100);
    expect(chunks[0]).toBe('A'.repeat(60));
  });

  it('无任何边界时硬切且每片不超过上限', () => {
    const chunks = splitForChannel('X'.repeat(250), 100);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
    expect(chunks.join('')).toBe('X'.repeat(250));
  });

  it('切开代码块时补齐围栏', () => {
    const fence = '\u0060\u0060\u0060';
    const text = '说明文字\n\n' + fence + 'ts\n' + 'const a = 1;\n'.repeat(20) + fence + '\n';
    const chunks = splitForChannel(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const count = chunk.split(fence).length - 1;
      expect(count % 2).toBe(0);
    }
  });

  it('上限过小时按 16 兜底', () => {
    const chunks = splitForChannel('Y'.repeat(40), 1);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(16);
  });
});

describe('OutboundSender', () => {
  it('按上限分片发送并返回最后一片 id', async () => {
    const sender = new OutboundSender(join(tempRoot(), 'spool'));
    const target = stubTarget();
    const id = await sender.send(target, 'Z'.repeat(250), 100);

    expect(target.sent).toHaveLength(3);
    expect(id).toBe('msg-3');
    expect(sender.list()).toEqual([]);
  });

  it('limit<=0 时整段发送', async () => {
    const sender = new OutboundSender(join(tempRoot(), 'spool'));
    const target = stubTarget();
    await sender.send(target, 'Z'.repeat(250), 0);
    expect(target.sent).toHaveLength(1);
  });

  it('构造时自动创建 spool 目录', () => {
    const dir = join(tempRoot(), 'nested', 'spool');
    new OutboundSender(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('发送失败时把剩余文本落盘并向上抛错', async () => {
    const sender = new OutboundSender(join(tempRoot(), 'spool'));
    const target = stubTarget({ failAll: true });
    await expect(sender.send(target, '一条重要结论', 4096)).rejects.toThrow('网络不通');

    const entries = sender.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.channel).toBe('telegram');
    expect(entries[0]?.targetId).toBe('chat:1');
    expect(entries[0]?.text).toBe('一条重要结论');
    expect(entries[0]?.attempts).toBe(0);
  });

  it('flush 重投成功后删除缓冲条目', async () => {
    const sender = new OutboundSender(join(tempRoot(), 'spool'));
    const failing = stubTarget({ failAll: true });
    await expect(sender.send(failing, '待重投内容', 4096)).rejects.toThrow();

    const healthy = stubTarget();
    const sent = await sender.flush('telegram', () => healthy, 4096);

    expect(sent).toBe(1);
    expect(healthy.sent).toEqual(['待重投内容']);
    expect(sender.list()).toEqual([]);
  });

  it('flush 时目标不可用则保留条目', async () => {
    const sender = new OutboundSender(join(tempRoot(), 'spool'));
    const failing = stubTarget({ failAll: true });
    await expect(sender.send(failing, '保留内容', 4096)).rejects.toThrow();

    expect(await sender.flush('telegram', () => undefined, 4096)).toBe(0);
    expect(await sender.flush('http', () => stubTarget(), 4096)).toBe(0);
    expect(sender.list()).toHaveLength(1);
  });

  it('flush 再次失败时累加尝试次数', async () => {
    const sender = new OutboundSender(join(tempRoot(), 'spool'));
    const failing = stubTarget({ failAll: true });
    await expect(sender.send(failing, '始终失败', 4096)).rejects.toThrow();

    expect(await sender.flush('telegram', () => stubTarget({ failAll: true }), 4096)).toBe(0);
    expect(sender.list()).toHaveLength(1);
    expect(sender.list()[0]?.attempts).toBe(1);
  });

  it('remove 可手工清除条目', async () => {
    const sender = new OutboundSender(join(tempRoot(), 'spool'));
    const entry = sender.spool(stubTarget(), '手工入队');
    expect(sender.list()).toHaveLength(1);
    sender.remove(entry.id);
    expect(sender.list()).toEqual([]);
    expect(() => sender.remove('不存在的 id')).not.toThrow();
  });
});

describe('TaskRenderer', () => {
  it('进度视图包含轮次、工具行与正文预览', () => {
    const renderer = new TaskRenderer({ header: '⚙ coder', reasoningVisible: false });
    expect(renderer.push({ type: 'iteration', index: 1 })).toBe(true);
    renderer.push({ type: 'tool_start', name: 'read_file', args: { path: 'a.md' } });
    renderer.push({
      type: 'tool_end',
      result: { callId: 'c1', name: 'read_file', content: 'ok', isError: false, durationMs: 12 },
    });
    renderer.push({ type: 'text', text: '我读完了。' });

    const view = renderer.progress();
    expect(view).toContain('⚙ coder  ·  第 1 轮');
    expect(view).toContain('✓ read_file');
    expect(view).toContain('12ms');
    expect(view).toContain('我读完了。');
    expect(renderer.body).toBe('我读完了。');
  });

  it('usage 事件不触发重绘', () => {
    const renderer = new TaskRenderer({ header: 'h', reasoningVisible: false });
    renderer.progress();
    expect(renderer.hasChanges).toBe(false);
    expect(renderer.push({ type: 'usage', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })).toBe(false);
    expect(renderer.hasChanges).toBe(false);
  });

  it('工具失败标记为 ✗', () => {
    const renderer = new TaskRenderer({ header: 'h', reasoningVisible: false });
    renderer.push({ type: 'tool_start', name: 'shell', args: { command: 'ls' } });
    renderer.push({
      type: 'tool_end',
      result: { callId: 'c1', name: 'shell', content: '不可用', isError: true },
    });
    expect(renderer.progress()).toContain('✗ shell');
  });

  it('超出尾窗时提示省略条数', () => {
    const renderer = new TaskRenderer({ header: 'h', reasoningVisible: false, toolTailSize: 2 });
    for (let index = 0; index < 5; index += 1) {
      renderer.push({ type: 'tool_start', name: 'tool' + String(index), args: {} });
      renderer.push({
        type: 'tool_end',
        result: { callId: 'c' + String(index), name: 'tool' + String(index), content: 'ok', isError: false },
      });
    }
    const view = renderer.progress();
    expect(view).toContain('已省略 3 条工具调用');
    expect(view).toContain('tool4');
    expect(view).not.toContain('tool0');
  });

  it('降级与提示都出现在进度与终态视图里', () => {
    const renderer = new TaskRenderer({ header: 'h', reasoningVisible: false });
    renderer.push({ type: 'model_switch', from: 'a/x', to: 'b/y', reason: '超时' });
    renderer.push({ type: 'notice', message: '已转后台执行' });
    renderer.push({ type: 'text', text: '结论' });

    expect(renderer.progress()).toContain('↻ a/x → b/y（超时）');
    expect(renderer.progress()).toContain('⚠ 已转后台执行');
    expect(renderer.final()).toContain('↻ a/x → b/y（超时）');
  });

  it('reasoningVisible 控制推理段展示', () => {
    const hidden = new TaskRenderer({ header: 'h', reasoningVisible: false });
    hidden.push({ type: 'reasoning', text: '内部思考' });
    hidden.push({ type: 'text', text: '答案' });
    expect(hidden.progress()).not.toContain('内部思考');

    const shown = new TaskRenderer({ header: 'h', reasoningVisible: true });
    shown.push({ type: 'reasoning', text: '内部思考' });
    shown.push({ type: 'text', text: '答案' });
    expect(shown.progress()).toContain('[思考] 内部思考');
    expect(shown.final()).toContain('[思考] 内部思考');
  });

  it('终态无正文时给出占位说明并附加收尾提示', () => {
    const renderer = new TaskRenderer({ header: 'h', reasoningVisible: false });
    const text = renderer.final('⏹ 任务已中止。');
    expect(text).toContain('（本次没有产生正文输出）');
    expect(text).toContain('⏹ 任务已中止。');
  });

  it('正文超过预览上限时从尾部保留', () => {
    const renderer = new TaskRenderer({ header: 'h', reasoningVisible: false, previewLimit: 20 });
    renderer.push({ type: 'text', text: 'A'.repeat(30) + '结尾' });
    const view = renderer.progress();
    expect(view).toContain('…');
    expect(view).toContain('结尾');
    expect(renderer.final()).toContain('A'.repeat(30));
  });
});

describe('parseBind', () => {
  it('解析 host:port', () => {
    expect(parseBind('127.0.0.1:8787')).toEqual({ host: '127.0.0.1', port: 8787 });
    expect(parseBind('0.0.0.0:9000')).toEqual({ host: '0.0.0.0', port: 9000 });
  });

  it('缺 host 时按本机处理', () => {
    expect(parseBind('8787')).toEqual({ host: '127.0.0.1', port: 8787 });
    expect(parseBind(':8080')).toEqual({ host: '127.0.0.1', port: 8080 });
  });

  it('端口非法时抛 CONFIG_INVALID', () => {
    for (const bad of ['127.0.0.1:abc', 'abc', '127.0.0.1:0', '-1']) {
      try {
        parseBind(bad);
        expect.unreachable('应当抛出 CONFIG_INVALID：' + bad);
      } catch (error) {
        expect((error as { code?: string }).code).toBe('CONFIG_INVALID');
      }
    }
  });
});
