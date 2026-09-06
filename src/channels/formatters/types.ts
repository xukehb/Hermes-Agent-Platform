/**
 * 通道消息排版格式化器契约与类型定义。
 *
 * 遵循策略模式 (Strategy Pattern)：
 * 每个聊天渠道对应一个具体的 ChannelFormatter 实现。
 */

import type { ChannelName } from '../types.js';

export type FormatterChannel = ChannelName | 'wecom';

export interface FormatterOptions {
  /** 是否展示思考过程（若为 false 则剔除 [思考] 块），缺省 true */
  showThinking?: boolean;
  /** 单行截断字符数（<=0 表示不限制） */
  maxLineLength?: number;
}

/**
 * 通道格式化器抽象策略接口。
 */
export interface ChannelFormatter {
  /** 该格式化器适用的通道标识 */
  readonly channel: FormatterChannel;

  /**
   * 将 Agent 输出的 Markdown、思考过程与运行时状态格式化为目标平台最适宜的展现格式。
   * @param text 原始文本内容
   * @param options 可选排版参数
   */
  format(text: string, options?: FormatterOptions): string;
}
