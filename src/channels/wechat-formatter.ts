/**
 * 微信 (WeChat / WeCom) 消息格式化工具（向后兼容门面）。
 */

import { WeChatFormatter, WeComFormatter } from './formatters/wechat.js';

const wechatFormatter = new WeChatFormatter();
const wecomFormatter = new WeComFormatter();

export function formatWeChatText(text: string): string {
  return wechatFormatter.format(text);
}

export function formatWeComMarkdown(text: string): string {
  return wecomFormatter.format(text);
}
