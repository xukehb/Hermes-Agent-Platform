import { describe, expect, it } from 'vitest';
import {
  ChannelFormatterRegistry,
  formatChannelMessage,
  BaseChannelFormatter,
  type ChannelFormatter,
} from '../src/channels/formatters/index.js';

describe('ChannelFormatter 架构规范性与可扩展性', () => {
  it('注册表默认包含所有内置通道格式化策略', () => {
    const channels = ChannelFormatterRegistry.listChannels();
    expect(channels).toContain('telegram');
    expect(channels).toContain('whatsapp');
    expect(channels).toContain('wechat');
    expect(channels).toContain('wecom');
    expect(channels).toContain('feishu');
    expect(channels).toContain('qq');
  });

  it('formatChannelMessage 统一分发至对应通道策略', () => {
    const tg = formatChannelMessage('telegram', '**加粗**');
    expect(tg).toBe('<b>加粗</b>');

    const wa = formatChannelMessage('whatsapp', '**加粗**');
    expect(wa).toBe('*加粗*');

    const wx = formatChannelMessage('wechat', '**加粗**');
    expect(wx).toBe('【加粗】');

    const qq = formatChannelMessage('qq', '**加粗**');
    expect(qq).toBe('【加粗】');
  });

  it('未注册通道直接返回原文本，不报错崩溃', () => {
    const raw = '一些原始文本';
    expect(formatChannelMessage('unknown_channel' as any, raw)).toBe(raw);
  });

  it('支持关闭思考过程选项 (showThinking: false)', () => {
    const input = '[思考] 思考中...\n\n最终结果';
    const result = formatChannelMessage('wechat', input, { showThinking: false });
    expect(result).not.toContain('思考过程');
    expect(result).toContain('最终结果');
  });

  it('可扩展性测试：允许运行时为新通道（如 DingTalk / 钉钉）注册格式化策略且无需修改已有代码', () => {
    class DingTalkFormatter extends BaseChannelFormatter {
      readonly channel = 'dingtalk' as const;

      protected override formatHeadings(content: string): string {
        return content.replace(/^(#{1,6})[ \t]+(.+)$/gm, '📢 钉钉标题: $2');
      }
    }

    // 动态注册钉钉策略
    ChannelFormatterRegistry.register(new DingTalkFormatter());

    expect(ChannelFormatterRegistry.listChannels()).toContain('dingtalk');
    const rendered = formatChannelMessage('dingtalk', '# 项目上线');
    expect(rendered).toContain('📢 钉钉标题: 项目上线');
  });
});
