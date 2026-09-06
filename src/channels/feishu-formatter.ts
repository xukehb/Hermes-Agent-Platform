/**
 * 飞书 (Feishu / Lark) 卡片与富文本格式化工具（向后兼容门面）。
 */

import { FeishuFormatter, buildFeishuCard, type FeishuCardContent } from './formatters/feishu.js';

export { buildFeishuCard, type FeishuCardContent };

const defaultFormatter = new FeishuFormatter();

export function formatFeishuMarkdown(text: string): string {
  return defaultFormatter.format(text);
}
