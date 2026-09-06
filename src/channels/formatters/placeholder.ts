/**
 * 工业级占位符隔离引擎。
 *
 * 核心职责：
 * 在进行富文本（HTML、Markdown、线框盒等）解析转换前，
 * 将代码块、行内代码等原始文本置换为不会与任何平台标记冲突的占位符，
 * 转换完成后一次性安全还原，杜绝代码内容被二次转义破坏。
 */

export class PlaceholderManager {
  private readonly placeholders: string[] = [];
  private readonly prefix: string;

  /**
   * @param delimiterKey 用于生成私有区占位符的唯一标记，默认 \uE000
   */
  constructor(delimiterKey: string = '\uE000') {
    this.prefix = delimiterKey;
  }

  /**
   * 将一段内容包装为占位符并缓存。
   * @param content 待保护的内容
   * @returns 占位符字符串
   */
  wrap(content: string): string {
    const id = this.placeholders.length;
    this.placeholders.push(content);
    return `${this.prefix}P${id}${this.prefix}`;
  }

  /**
   * 一次性还原所有占位符为原始保护内容。
   * @param text 包含占位符的文本
   * @returns 还原后的完整文本
   */
  restore(text: string): string {
    let result = text;
    for (let i = 0; i < this.placeholders.length; i++) {
      const placeholder = `${this.prefix}P${i}${this.prefix}`;
      const replacement = this.placeholders[i] ?? '';
      result = result.split(placeholder).join(replacement);
    }
    return result;
  }

  /** 当前缓存的占位符数量 */
  get count(): number {
    return this.placeholders.length;
  }
}
