/**
 * QQ (OneBot v11/v12) 消息格式化工具（向后兼容门面）。
 */

import { QQFormatter } from './formatters/qq.js';

const defaultFormatter = new QQFormatter();

export function formatQQText(text: string): string {
  return defaultFormatter.format(text);
}
