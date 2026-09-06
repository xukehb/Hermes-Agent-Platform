/**
 * Telegram 消息富文本格式化工具（向后兼容门面）。
 */

import { TelegramFormatter, escapeTelegramHtml, balanceHtmlTags } from './formatters/telegram.js';

export { escapeTelegramHtml, balanceHtmlTags };

const defaultFormatter = new TelegramFormatter();

export function formatTelegramHtml(text: string): string {
  return defaultFormatter.format(text);
}
