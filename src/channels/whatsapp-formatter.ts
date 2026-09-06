/**
 * WhatsApp 消息格式化工具（向后兼容门面）。
 */

import { WhatsAppFormatter } from './formatters/whatsapp.js';

const defaultFormatter = new WhatsAppFormatter();

export function formatWhatsAppText(text: string): string {
  return defaultFormatter.format(text);
}
