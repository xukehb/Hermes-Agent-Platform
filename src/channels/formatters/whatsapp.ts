/**
 * WhatsApp 平台轻量 Markdown 策略格式化器。
 */

import { BaseChannelFormatter } from './base.js';
import { AGENT_PATTERNS } from './patterns.js';
import type { PlaceholderManager } from './placeholder.js';
import type { FormatterOptions } from './types.js';

export class WhatsAppFormatter extends BaseChannelFormatter {
  readonly channel = 'whatsapp' as const;

  protected override formatCodeBlocks(content: string, pm: PlaceholderManager): string {
    return content.replace(AGENT_PATTERNS.codeBlock, (_match, lang, code) => {
      const cleanCode = code.endsWith('\n') ? code.slice(0, -1) : code;
      const cleanLang = (lang || '').trim().toLowerCase();
      const prefix = cleanLang ? `💻 *${cleanLang}*\n` : '';
      return pm.wrap(`${prefix}\`\`\`\n${cleanCode}\n\`\`\``);
    });
  }

  protected override formatInlineCode(content: string, pm: PlaceholderManager): string {
    return content.replace(AGENT_PATTERNS.inlineCode, (_match, code) => {
      return pm.wrap(`\`${code}\``);
    });
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
      const quoteLines = trimmed.split('\n').map((l: string) => `> ${l}`).join('\n');
      return '\n' + pm.wrap(`💭 *思考过程:*\n${quoteLines}`) + '\n';
    });
  }

  protected override formatHeadings(content: string): string {
    return content.replace(AGENT_PATTERNS.heading, (_match, _hashes, title) => {
      return `*${title.trim()}*`;
    });
  }

  protected override formatEmphasis(content: string, pm: PlaceholderManager): string {
    let result = content;
    result = result.replace(AGENT_PATTERNS.boldItalicAsterisk, (_match, text) => pm.wrap(`*_${text}_*`));
    result = result.replace(AGENT_PATTERNS.boldItalicUnderscore, (_match, text) => pm.wrap(`*_${text}_*`));
    result = result.replace(AGENT_PATTERNS.boldAsterisk, (_match, text) => pm.wrap(`*${text}*`));
    result = result.replace(AGENT_PATTERNS.boldUnderscore, (_match, text) => pm.wrap(`*${text}*`));
    result = result.replace(AGENT_PATTERNS.strikethrough, '~$1~');
    result = result.replace(AGENT_PATTERNS.italicAsterisk, '_$1_');
    return result;
  }

  protected override formatStatusIndicators(content: string): string {
    let result = content;
    result = result.replace(AGENT_PATTERNS.bracketHeader, '*$1*');
    result = result.replace(AGENT_PATTERNS.commandItem, '`$1`$2');
    result = result.replace(AGENT_PATTERNS.progressHeader, '*$1*');
    result = result.replace(AGENT_PATTERNS.toolStart, '⏳ *$1*$2');
    result = result.replace(AGENT_PATTERNS.toolSuccess, (_match, tool, args, dur) => {
      const durationPart = dur ? ` ~${dur.trim()}~` : '';
      return `✅ *$tool*${args ?? ''}${durationPart}`;
    });
    result = result.replace(AGENT_PATTERNS.toolError, '❌ *$1*$2');
    result = result.replace(AGENT_PATTERNS.modelSwitch, '↻ *$1* ➔ *$2*$3');
    result = result.replace(AGENT_PATTERNS.terminalNote, (_match, model, tokens, taskId) => {
      return `—————\n🤖 *${model}*  •  📊 *${tokens}* tokens  •  🆔 \`${taskId}\``;
    });
    return result;
  }
}
