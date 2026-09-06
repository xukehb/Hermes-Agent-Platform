/**
 * 通道排版策略注册表与统一分发中心（工厂模式与策略模式）。
 *
 * 规范性：统一根据 ChannelName 分发对应格式化器；
 * 可扩展性：第三方或新增通道可通过 `register()` 动态挂载新策略，对修改关闭，对扩展开放 (OCP)。
 */

import type { ChannelName } from '../types.js';
import type { ChannelFormatter, FormatterChannel, FormatterOptions } from './types.js';
import { TelegramFormatter } from './telegram.js';
import { WhatsAppFormatter } from './whatsapp.js';
import { WeChatFormatter, WeComFormatter } from './wechat.js';
import { FeishuFormatter } from './feishu.js';
import { QQFormatter } from './qq.js';

export class ChannelFormatterRegistry {
  private static readonly registry = new Map<string, ChannelFormatter>();

  static {
    // 默认内置注册支持的通道格式化策略
    this.register(new TelegramFormatter());
    this.register(new WhatsAppFormatter());
    this.register(new WeChatFormatter());
    this.register(new WeComFormatter());
    this.register(new FeishuFormatter());
    this.register(new QQFormatter());
  }

  /**
   * 注册或覆写通道格式化策略。
   * 支持运行时为已有或新通道挂载自定义策略。
   */
  static register(formatter: ChannelFormatter): void {
    this.registry.set(formatter.channel, formatter);
  }

  /**
   * 获取指定通道的格式化器。若未注册则回退返回通用兜底或 undefined。
   */
  static get(channel: FormatterChannel | string): ChannelFormatter | undefined {
    return this.registry.get(channel);
  }

  /**
   * 列出所有已注册的通道标识。
   */
  static listChannels(): string[] {
    return Array.from(this.registry.keys());
  }

  /**
   * 统一快捷格式化入口。
   * @param channel 通道名称
   * @param text 待格式化文本
   * @param options 可选参数
   */
  static format(channel: ChannelName | string, text: string, options?: FormatterOptions): string {
    const formatter = this.get(channel);
    if (!formatter) {
      return text;
    }
    return formatter.format(text, options);
  }
}

/** 快捷分发函数 */
export function formatChannelMessage(channel: ChannelName | string, text: string, options?: FormatterOptions): string {
  return ChannelFormatterRegistry.format(channel, text, options);
}
