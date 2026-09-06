/**
 * 通道格式化器抽象基类（模板方法模式 Template Method Pattern）。
 *
 * 定义了消息富文本转换的标准化 10 阶段流水线。
 * 具体平台只需按需覆盖对应阶段的虚方法，即可实现符合该平台特性的排版，
 * 极大降低新增通道的开发与维护成本（开闭原则 OCP）。
 */

import { AGENT_PATTERNS } from './patterns.js';
import { PlaceholderManager } from './placeholder.js';
import type { ChannelFormatter, FormatterChannel, FormatterOptions } from './types.js';

export abstract class BaseChannelFormatter implements ChannelFormatter {
  abstract readonly channel: FormatterChannel;

  /**
   * 模板方法：组织 10 阶段标准化转换流程。
   */
  format(text: string, options?: FormatterOptions): string {
    if (!text || text.trim().length === 0) {
      return text;
    }

    const pm = this.createPlaceholderManager();
    let content = text.replace(/\r\n/g, '\n');

    // 1. 多行代码块保护与转换
    content = this.formatCodeBlocks(content, pm, options);

    // 2. 单行行内代码保护与转换
    content = this.formatInlineCode(content, pm, options);

    // 3. 超链接处理
    content = this.formatLinks(content, pm, options);

    // 4. 思考过程处理
    content = this.formatThinking(content, pm, options);

    // 5. 标题层级处理
    content = this.formatHeadings(content, pm, options);

    // 6. 强调标记（粗体/斜体/删除线）
    content = this.formatEmphasis(content, pm, options);

    // 7. 运行时状态行与工具调用美化
    content = this.formatStatusIndicators(content, pm, options);

    // 8. 列表与分割线
    content = this.formatListsAndDividers(content, pm, options);

    // 9. 还原所有受保护占位符
    content = pm.restore(content);

    // 10. 平台特有后置处理（如 HTML 标签平衡检查）
    return this.postProcess(content.trim(), options);
  }

  protected createPlaceholderManager(): PlaceholderManager {
    return new PlaceholderManager('\uE000');
  }

  /** 阶段 1：格式化代码块，默认保留 Markdown 语法 */
  protected formatCodeBlocks(content: string, pm: PlaceholderManager, _options?: FormatterOptions): string {
    return content.replace(AGENT_PATTERNS.codeBlock, (_match, lang, code) => {
      const cleanCode = code.endsWith('\n') ? code.slice(0, -1) : code;
      return pm.wrap(`\`\`\`${lang || ''}\n${cleanCode}\n\`\`\``);
    });
  }

  /** 阶段 2：格式化行内代码，默认保留 `code` */
  protected formatInlineCode(content: string, pm: PlaceholderManager, _options?: FormatterOptions): string {
    return content.replace(AGENT_PATTERNS.inlineCode, (_match, code) => {
      return pm.wrap(`\`${code}\``);
    });
  }

  /** 阶段 3：格式化超链接，默认保留 [label](url) */
  protected formatLinks(content: string, _pm: PlaceholderManager, _options?: FormatterOptions): string {
    return content;
  }

  /** 阶段 4：格式化思考过程 [思考] ... */
  protected formatThinking(content: string, pm: PlaceholderManager, options?: FormatterOptions): string {
    if (options?.showThinking === false) {
      return content.replace(AGENT_PATTERNS.thinking, '');
    }
    return content.replace(AGENT_PATTERNS.thinking, (_match, thinking) => {
      const trimmed = thinking.trim();
      if (trimmed.length === 0) return '';
      return '\n' + pm.wrap(`> 💭 **思考过程**\n${trimmed}`) + '\n';
    });
  }

  /** 阶段 5：格式化标题 # Title */
  protected formatHeadings(content: string, _pm: PlaceholderManager, _options?: FormatterOptions): string {
    return content.replace(AGENT_PATTERNS.heading, (_match, _hashes, title) => {
      return `**${title.trim()}**`;
    });
  }

  /** 阶段 6：格式化粗体、斜体、删除线 */
  protected formatEmphasis(content: string, _pm: PlaceholderManager, _options?: FormatterOptions): string {
    return content;
  }

  /** 阶段 7：格式化状态指示器 */
  protected formatStatusIndicators(content: string, _pm: PlaceholderManager, _options?: FormatterOptions): string {
    return content;
  }

  /** 阶段 8：格式化列表与分割线 */
  protected formatListsAndDividers(content: string, _pm: PlaceholderManager, _options?: FormatterOptions): string {
    return content.replace(AGENT_PATTERNS.listBullet, '• $1');
  }

  /** 阶段 10：平台特有后置处理 */
  protected postProcess(content: string, _options?: FormatterOptions): string {
    return content;
  }
}
