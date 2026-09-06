/**
 * QQ (OneBot v11/v12) 策略格式化器。
 */

import { BaseChannelFormatter } from './base.js';
import { AGENT_PATTERNS } from './patterns.js';
import type { PlaceholderManager } from './placeholder.js';
import type { FormatterOptions } from './types.js';

export class QQFormatter extends BaseChannelFormatter {
  readonly channel = 'qq' as const;

  protected override formatCodeBlocks(content: string, pm: PlaceholderManager): string {
    return content.replace(AGENT_PATTERNS.codeBlock, (_match, lang, code) => {
      const cleanCode = code.endsWith('\n') ? code.slice(0, -1) : code;
      const cleanLang = (lang || '代码').trim().toLowerCase();
      const lines = cleanCode.split('\n');
      const header = `┌─ [${cleanLang}] ──────────────────`;
      const body = lines.map((l: string) => `│ ${l}`).join('\n');
      const footer = `└──────────────────────────────`;
      return pm.wrap(`${header}\n${body}\n${footer}`);
    });
  }

  protected override formatInlineCode(content: string): string {
    return content.replace(AGENT_PATTERNS.inlineCode, '「$1」');
  }

  protected override formatLinks(content: string): string {
    return content.replace(AGENT_PATTERNS.link, '$1: $2');
  }

  protected override formatThinking(content: string, pm: PlaceholderManager, options?: FormatterOptions): string {
    if (options?.showThinking === false) {
      return content.replace(AGENT_PATTERNS.thinking, '');
    }
    return content.replace(AGENT_PATTERNS.thinking, (_match, thinking) => {
      const trimmed = thinking.trim();
      if (trimmed.length === 0) return '';
      return '\n' + pm.wrap(`💭【思考过程】\n${trimmed}`) + '\n';
    });
  }

  protected override formatHeadings(content: string): string {
    let result = content;
    result = result.replace(/^#[ \t]+(.+)$/gm, '📌 $1');
    result = result.replace(/^##[ \t]+(.+)$/gm, '🔹 $1');
    result = result.replace(/^###[ \t]+(.+)$/gm, '▫️ $1');
    result = result.replace(/^#{4,6}[ \t]+(.+)$/gm, '· $1');
    return result;
  }

  protected override formatEmphasis(content: string): string {
    let result = content;
    result = result.replace(AGENT_PATTERNS.boldItalicAsterisk, '【$1】');
    result = result.replace(AGENT_PATTERNS.boldAsterisk, '【$1】');
    result = result.replace(AGENT_PATTERNS.boldUnderscore, '【$1】');
    result = result.replace(AGENT_PATTERNS.italicAsterisk, '$1');
    result = result.replace(AGENT_PATTERNS.strikethrough, '~$1~');
    return result;
  }

  protected override formatStatusIndicators(content: string): string {
    let result = content;
    result = result.replace(AGENT_PATTERNS.progressHeader, '🤖 $1');
    result = result.replace(AGENT_PATTERNS.toolStart, '⏳ 正在调用 [$1]$2');
    result = result.replace(AGENT_PATTERNS.toolSuccess, (_match, tool, args, dur) => {
      const durationPart = dur ? ` (耗时 ${dur.trim()})` : '';
      return `✅ [$tool]${args ?? ''}${durationPart}`;
    });
    result = result.replace(AGENT_PATTERNS.toolError, '❌ [$1] 执行异常$2');
    result = result.replace(AGENT_PATTERNS.modelSwitch, '↻ 模型切换：$1 ➔ $2$3');
    result = result.replace(AGENT_PATTERNS.terminalNote, (_match, model, tokens, taskId) => {
      return `————————————\n🤖 模型: ${model}  |  📊 用量: ${tokens} tokens  |  🆔 任务: ${taskId}`;
    });
    return result;
  }
}
