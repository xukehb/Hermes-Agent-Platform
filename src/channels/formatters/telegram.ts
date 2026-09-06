/**
 * Telegram 平台 HTML 策略格式化器。
 */

import { BaseChannelFormatter } from './base.js';
import { AGENT_PATTERNS } from './patterns.js';
import type { PlaceholderManager } from './placeholder.js';
import type { FormatterOptions } from './types.js';

export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function balanceHtmlTags(html: string): string {
  const allowed = ['b', 'i', 's', 'u', 'code', 'pre', 'blockquote', 'a'];
  const tagPattern = /<\/?([a-zA-Z0-9_-]+)(?:\s+[^>]*)?>/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html)) !== null) {
    const rawTag = match[0];
    const tagName = match[1]?.toLowerCase();
    if (!tagName || !allowed.includes(tagName)) continue;

    const isClosing = rawTag.startsWith('</');
    if (isClosing) {
      const idx = stack.lastIndexOf(tagName);
      if (idx !== -1) {
        stack.splice(idx, 1);
      }
    } else {
      stack.push(tagName);
    }
  }

  let balanced = html;
  while (stack.length > 0) {
    const unclosed = stack.pop();
    if (unclosed) {
      balanced += `</${unclosed}>`;
    }
  }
  return balanced;
}

export class TelegramFormatter extends BaseChannelFormatter {
  readonly channel = 'telegram' as const;

  protected override formatCodeBlocks(content: string, pm: PlaceholderManager): string {
    return content.replace(AGENT_PATTERNS.codeBlock, (_match, lang, code) => {
      const escapedCode = escapeTelegramHtml(code.endsWith('\n') ? code.slice(0, -1) : code);
      const cleanLang = (lang || '').trim().toLowerCase();
      const tag = cleanLang
        ? `<pre><code class="language-${cleanLang}">${escapedCode}</code></pre>`
        : `<pre><code>${escapedCode}</code></pre>`;
      return pm.wrap(tag);
    });
  }

  protected override formatInlineCode(content: string, pm: PlaceholderManager): string {
    return content.replace(AGENT_PATTERNS.inlineCode, (_match, code) => {
      const escaped = escapeTelegramHtml(code);
      return pm.wrap(`<code>${escaped}</code>`);
    });
  }

  protected override formatThinking(content: string, pm: PlaceholderManager, options?: FormatterOptions): string {
    if (options?.showThinking === false) {
      return content.replace(AGENT_PATTERNS.thinking, '');
    }
    return content.replace(AGENT_PATTERNS.thinking, (_match, thinking) => {
      const trimmed = thinking.trim();
      if (trimmed.length === 0) return '';
      const escaped = escapeTelegramHtml(trimmed);
      const quote = `<blockquote expandable>💭 <b>思考过程</b>\n${escaped}</blockquote>`;
      return '\n' + pm.wrap(quote) + '\n';
    });
  }

  protected override formatHeadings(content: string, _pm: PlaceholderManager): string {
    // 飞书/Telegram 普通文本转义前需注意
    return content.replace(AGENT_PATTERNS.heading, (_match, _hashes, title) => {
      return `<b>${title.trim()}</b>`;
    });
  }

  protected override formatLinks(content: string, pm: PlaceholderManager): string {
    // 标准引用块转换并使用占位符保护
    let result = content.replace(AGENT_PATTERNS.blockquote, (_match, block) => {
      const lines = block
        .split('\n')
        .map((l: string) => l.replace(/^>[ \t]?/, ''))
        .join('\n')
        .trim();
      if (lines.length === 0) return '';
      const escaped = escapeTelegramHtml(lines);
      return '\n' + pm.wrap(`<blockquote>${escaped}</blockquote>`) + '\n';
    });

    // 转义其余普通文本中的 <, >, &
    result = escapeTelegramHtml(result);

    // 转换超链接
    return result.replace(AGENT_PATTERNS.link, (_match, label, url) => {
      return `<a href="${url}">${label}</a>`;
    });
  }

  protected override formatEmphasis(content: string): string {
    let result = content;
    result = result.replace(AGENT_PATTERNS.boldItalicAsterisk, '<b><i>$1</i></b>');
    result = result.replace(AGENT_PATTERNS.boldItalicUnderscore, '<b><i>$1</i></b>');
    result = result.replace(AGENT_PATTERNS.boldAsterisk, '<b>$1</b>');
    result = result.replace(AGENT_PATTERNS.boldUnderscore, '<b>$1</b>');
    result = result.replace(AGENT_PATTERNS.italicAsterisk, '<i>$1</i>');
    result = result.replace(AGENT_PATTERNS.italicUnderscore, '<i>$1</i>');
    result = result.replace(AGENT_PATTERNS.strikethrough, '<s>$1</s>');
    return result;
  }

  protected override formatStatusIndicators(content: string): string {
    let result = content;
    result = result.replace(AGENT_PATTERNS.commandItem, '<code>$1</code>$2');
    result = result.replace(AGENT_PATTERNS.bracketHeader, '<b>$1</b>');
    result = result.replace(AGENT_PATTERNS.progressHeader, '<b>$1</b>');
    result = result.replace(AGENT_PATTERNS.toolStart, '⏳ <code>$1</code>$2');
    result = result.replace(AGENT_PATTERNS.toolSuccess, (_match, tool, args, dur) => {
      const durationPart = dur ? ` <code>${dur.trim()}</code>` : '';
      return `✅ <code>${tool}</code>${args ?? ''}${durationPart}`;
    });
    result = result.replace(AGENT_PATTERNS.toolError, '❌ <code>$1</code>$2');
    result = result.replace(AGENT_PATTERNS.modelSwitch, '↻ <code>$1</code> ➔ <code>$2</code>$3');
    result = result.replace(AGENT_PATTERNS.terminalNote, (_match, model, tokens, taskId) => {
      return `—————\n<i>🤖 <code>${model}</code>  •  📊 <b>${tokens}</b> tokens  •  🆔 <code>${taskId}</code></i>`;
    });
    return result;
  }

  protected override formatListsAndDividers(content: string): string {
    return content.replace(AGENT_PATTERNS.listBullet, '  • $1');
  }

  protected override postProcess(content: string): string {
    return balanceHtmlTags(content);
  }
}
