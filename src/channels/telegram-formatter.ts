/**
 * Telegram 消息富文本格式化工具。
 *
 * Telegram Bot API 支持 HTML 模式，但要求极严格：
 * 1) 仅支持少量标签：<b>, <i>, <s>, <u>, <code>, <pre>, <blockquote>, <blockquote expandable>, <a>
 * 2) 正文中除标签外的 <, >, & 必须全部转义为 &lt;, &gt;, &amp;
 * 3) 不支持 <p>, <br>, <div> 等常规网页标签，换行必须用原生 \n
 * 4) 任何未闭合标签或非法实体均会导致 Telegram 抛出 400 Bad Request
 *
 * 本模块将 Agent 产生的 Markdown、代码块、思考过程、工具调用与系统提示
 * 转换为结构优雅、视觉清晰、100% 语法安全的 Telegram HTML。
 */

/** 转义 Telegram HTML 保留字符 */
export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 闭合未闭合的 HTML 标签，保证 Telegram entity 解析绝对安全 */
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

  // 从后向前闭合所有未闭合的标签
  let balanced = html;
  while (stack.length > 0) {
    const unclosed = stack.pop();
    if (unclosed) {
      balanced += `</${unclosed}>`;
    }
  }
  return balanced;
}

/**
 * 将 Markdown 与系统状态文本转换为 Telegram 原生 HTML 格式。
 */
export function formatTelegramHtml(text: string): string {
  if (!text || text.trim().length === 0) {
    return text;
  }

  let content = text.replace(/\r\n/g, '\n');

  // 占位符缓存，用于保护已转换的代码块与特定元素，避免被后续步骤重复处理
  const placeholders: string[] = [];
  const makePlaceholder = (html: string): string => {
    const key = `\uE000P${placeholders.length}\uE000`;
    placeholders.push(html);
    return key;
  };

  // 1. 提取多行代码块 ```lang\ncode\n```
  content = content.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)(?:```|$)/g, (_match, lang, code) => {
    const escapedCode = escapeTelegramHtml(code.endsWith('\n') ? code.slice(0, -1) : code);
    const cleanLang = (lang || '').trim().toLowerCase();
    const tag = cleanLang
      ? `<pre><code class="language-${cleanLang}">${escapedCode}</code></pre>`
      : `<pre><code>${escapedCode}</code></pre>`;
    return makePlaceholder(tag);
  });

  // 2. 提取单行行内代码 `code`
  content = content.replace(/`([^`\n]+)`/g, (_match, code) => {
    const escaped = escapeTelegramHtml(code);
    return makePlaceholder(`<code>${escaped}</code>`);
  });

  // 3. 处理思考过程 [思考] ...
  // 支持将模型推理过程转换为可折叠的 blockquote expandable
  content = content.replace(/(?:^|\n)\[思考\][ \t]*([\s\S]*?)(?=(?:\n\n[^\n]|(?:\n⚙ )|(?:\n· )|$))/g, (_match, thinking) => {
    const trimmed = thinking.trim();
    if (trimmed.length === 0) return '';
    const escaped = escapeTelegramHtml(trimmed);
    const quote = `<blockquote expandable>💭 <b>思考过程</b>\n${escaped}</blockquote>`;
    return '\n' + makePlaceholder(quote) + '\n';
  });

  // 4. 处理标准 Markdown 引用块 > quote
  content = content.replace(/(?:^|\n)(>[ \t]?[^\n]*(?:\n>[ \t]?[^\n]*)*)/g, (_match, block) => {
    const lines = block
      .split('\n')
      .map((l: string) => l.replace(/^>[ \t]?/, ''))
      .join('\n')
      .trim();
    if (lines.length === 0) return '';
    const escaped = escapeTelegramHtml(lines);
    return '\n' + makePlaceholder(`<blockquote>${escaped}</blockquote>`) + '\n';
  });

  // 5. 对剩余普通文本中的 <, >, & 进行实体转义
  content = escapeTelegramHtml(content);

  // 6. 处理标题 (#, ##, ### 等) -> 加粗并视觉分段
  content = content.replace(/^(#{1,6})[ \t]+(.+)$/gm, (_match, _hashes, title) => {
    return `<b>${title.trim()}</b>`;
  });

  // 7. 处理粗斜体、粗体、斜体、删除线
  // 粗斜体 ***text*** 或 ___text___
  content = content.replace(/\*\*\*([^\n*]+?)\*\*\*/g, '<b><i>$1</i></b>');
  content = content.replace(/___([^\n_]+?)___/g, '<b><i>$1</i></b>');

  // 粗体 **text** 或 __text__
  content = content.replace(/\*\*([^\n*]+?)\*\*/g, '<b>$1</b>');
  content = content.replace(/__([^\n_]+?)__/g, '<b>$1</b>');

  // 斜体 *text* 或 _text_（使用非单词边界，避免误匹配 snake_case 变量名，支持中文/多语言标点）
  content = content.replace(/(?<=^|[^\p{L}\p{N}*])\*([^\s*][^\n*]*?[^\s*]|[^\s*])\*(?=$|[^\p{L}\p{N}*])/gu, '<i>$1</i>');
  content = content.replace(/(?<=^|[^\p{L}\p{N}_])_([^\s_][^\n_]*?[^\s_]|[^\s_])_(?=$|[^\p{L}\p{N}_])/gu, '<i>$1</i>');

  // 删除线 ~~text~~
  content = content.replace(/~~([^\n~]+?)~~/g, '<s>$1</s>');

  // 8. 处理链接 [text](url)
  content = content.replace(/\[([^\]\n]+)\]\(((?:https?|tg):\/\/[^\s\)]+)\)/g, (_match, label, url) => {
    return `<a href="${url}">${label}</a>`;
  });

  // 9. 处理无序列表 (- item 或 * item) -> 使用整洁的圆点符号 •
  content = content.replace(/^[ \t]*[-*][ \t]+(.+)$/gm, '  • $1');

  // 10. 针对平台内置命令帮助与状态的样式增强
  // 识别命令列表中的指令，如 /help, /git, /model 并赋予等宽徽标效果
  content = content.replace(/^(\/[a-z][a-z0-9_-]*)(\b|[ \t])/gm, '<code>$1</code>$2');

  // 识别小标题【...】赋予加粗效果
  content = content.replace(/(【[^】]+】)/g, '<b>$1</b>');

  // 进度指示器状态行优化
  // ⚙ coder 正在处理  ·  第 1 轮
  content = content.replace(/^(⚙ .+? 正在处理  ·  第 \d+ 轮)$/gm, '<b>$1</b>');

  // ⏳ 工具调用
  content = content.replace(/^⏳ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?/gm, '⏳ <code>$1</code>$2');

  // ✓ 工具成功完成
  content = content.replace(/^✓ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?(\s+\d+(?:\.\d+)?(?:ms|s))?/gm, (_match, tool, args, dur) => {
    const durationPart = dur ? ` <code>${dur.trim()}</code>` : '';
    return `✅ <code>${tool}</code>${args ?? ''}${durationPart}`;
  });

  // ✗ 工具执行异常
  content = content.replace(/^✗ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?/gm, '❌ <code>$1</code>$2');

  // ↻ 模型降级/切换指示
  content = content.replace(/^↻ ([^\s]+)\s*→\s*([^\s（(]+)(.*)$/gm, '↻ <code>$1</code> ➔ <code>$2</code>$3');

  // 终态统计底栏（如 · deepseek/deepseek-chat · 1234 tokens · task-1234）
  content = content.replace(/^· ([^\s·]+) · (\d+) tokens · ([a-zA-Z0-9_-]+)$/gm, (_match, model, tokens, taskId) => {
    return `—————\n<i>🤖 <code>${model}</code>  •  📊 <b>${tokens}</b> tokens  •  🆔 <code>${taskId}</code></i>`;
  });

  // 11. 还原代码块与特定元素占位符
  for (let i = 0; i < placeholders.length; i++) {
    const placeholder = `\uE000P${i}\uE000`;
    const replacement = placeholders[i] ?? '';
    content = content.split(placeholder).join(replacement);
  }

  // 12. 确保 HTML 标签闭合配对
  return balanceHtmlTags(content.trim());
}
