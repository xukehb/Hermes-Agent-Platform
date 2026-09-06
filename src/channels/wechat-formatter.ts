/**
 * 微信 (WeChat / WeCom) 消息格式化工具。
 *
 * 平台特性：
 * 1) 微信个人端 (Mobile / Desktop) 无法直接解析 Markdown 语法，
 *    原始的 ```、**加粗**、# 标题 会导致消息界面充斥杂乱标点符号。
 *    针对个人微信，提供基于 ASCII 线框盒、装饰符号与原生可点击链接的极佳排版。
 * 2) 企业微信 (WeCom) Webhook 原生支持特定子集的 Markdown，
 *    支持 <font color="info">、<font color="warning"> 强调色。
 */

/**
 * 格式化微信个人端/桌面端消息（纯文本排版美化）。
 */
export function formatWeChatText(text: string): string {
  if (!text || text.trim().length === 0) {
    return text;
  }

  let content = text.replace(/\r\n/g, '\n');

  const placeholders: string[] = [];
  const makePlaceholder = (formatted: string): string => {
    const key = `\uE002P${placeholders.length}\uE002`;
    placeholders.push(formatted);
    return key;
  };

  // 1. 将代码块转化为精美的 ASCII 方框容器
  content = content.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)(?:```|$)/g, (_match, lang, code) => {
    const cleanCode = code.endsWith('\n') ? code.slice(0, -1) : code;
    const cleanLang = (lang || '代码').trim().toLowerCase();
    const lines = cleanCode.split('\n');
    const header = `┌─ [${cleanLang}] ──────────────────`;
    const body = lines.map((l: string) => `│ ${l}`).join('\n');
    const footer = `└──────────────────────────────`;
    return makePlaceholder(`${header}\n${body}\n${footer}`);
  });

  // 2. 行内代码转为中文引号包装
  content = content.replace(/`([^`\n]+)`/g, '「$1」');

  // 3. 超链接 [Title](url) 转为 Title: url（微信支持识别裸链接为可点击蓝色链接）
  content = content.replace(/\[([^\]\n]+)\]\(((?:https?|tg):\/\/[^\s\)]+)\)/g, '$1: $2');

  // 4. 处理思考过程 [思考] ...
  content = content.replace(/(?:^|\n)\[思考\][ \t]*([\s\S]*?)(?=(?:\n\n[^\n]|(?:\n⚙ )|(?:\n· )|$))/g, (_match, thinking) => {
    const trimmed = thinking.trim();
    if (trimmed.length === 0) return '';
    return '\n' + makePlaceholder(`💭【思考过程】\n${trimmed}`) + '\n';
  });

  // 5. 标题层级符号化
  content = content.replace(/^#[ \t]+(.+)$/gm, '📌 $1');
  content = content.replace(/^##[ \t]+(.+)$/gm, '🔹 $1');
  content = content.replace(/^###[ \t]+(.+)$/gm, '▫️ $1');
  content = content.replace(/^#{4,6}[ \t]+(.+)$/gm, '· $1');

  // 6. 粗体与斜体
  content = content.replace(/\*\*\*([^\n*]+?)\*\*\*/g, '【$1】');
  content = content.replace(/\*\*([^\n*]+?)\*\*/g, '【$1】');
  content = content.replace(/__([^\n_]+?)__/g, '【$1】');
  content = content.replace(/(?<=^|[^\p{L}\p{N}*])\*([^\s*][^\n*]*?[^\s*]|[^\s*])\*(?=$|[^\p{L}\p{N}*])/gu, '$1');
  content = content.replace(/~~([^\n~]+?)~~/g, '~$1~');

  // 7. 列表圆点化
  content = content.replace(/^[ \t]*[-*][ \t]+(.+)$/gm, '• $1');

  // 8. 进度状态指示器美化
  // ⚙ coder 正在处理  ·  第 1 轮
  content = content.replace(/^(⚙ .+? 正在处理  ·  第 \d+ 轮)$/gm, '🤖 $1');

  // ⏳ 工具调用
  content = content.replace(/^⏳ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?/gm, '⏳ 正在调用 [$1]$2');

  // ✓ 工具成功完成
  content = content.replace(/^✓ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?(\s+\d+(?:\.\d+)?(?:ms|s))?/gm, (_match, tool, args, dur) => {
    const durationPart = dur ? ` (耗时 ${dur.trim()})` : '';
    return `✅ [$tool]${args ?? ''}${durationPart}`;
  });

  // ✗ 工具执行异常
  content = content.replace(/^✗ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?/gm, '❌ [$1] 执行异常$2');

  // ↻ 模型切换
  content = content.replace(/^↻ ([^\s]+)\s*→\s*([^\s（(]+)(.*)$/gm, '↻ 模型切换：$1 ➔ $2$3');

  // 终态统计底栏
  content = content.replace(/^· ([^\s·]+) · (\d+) tokens · ([a-zA-Z0-9_-]+)$/gm, (_match, model, tokens, taskId) => {
    return `————————————\n🤖 模型: ${model}  |  📊 用量: ${tokens} tokens  |  🆔 任务: ${taskId}`;
  });

  // 9. 还原占位符
  for (let i = 0; i < placeholders.length; i++) {
    const placeholder = `\uE002P${i}\uE002`;
    const replacement = placeholders[i] ?? '';
    content = content.split(placeholder).join(replacement);
  }

  return content.trim();
}

/**
 * 格式化企业微信 (WeCom) Markdown 消息。
 */
export function formatWeComMarkdown(text: string): string {
  if (!text || text.trim().length === 0) {
    return text;
  }

  let content = text.replace(/\r\n/g, '\n');

  // 占位符保护
  const placeholders: string[] = [];
  const makePlaceholder = (formatted: string): string => {
    const key = `\uE003P${placeholders.length}\uE003`;
    placeholders.push(formatted);
    return key;
  };

  // 1. 保留原生代码块
  content = content.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)(?:```|$)/g, (_match, lang, code) => {
    const cleanCode = code.endsWith('\n') ? code.slice(0, -1) : code;
    return makePlaceholder(`\`\`\`${lang || ''}\n${cleanCode}\n\`\`\``);
  });

  // 2. 行内代码
  content = content.replace(/`([^`\n]+)`/g, (_match, code) => {
    return makePlaceholder(`\`${code}\``);
  });

  // 3. 思考过程
  content = content.replace(/(?:^|\n)\[思考\][ \t]*([\s\S]*?)(?=(?:\n\n[^\n]|(?:\n⚙ )|(?:\n· )|$))/g, (_match, thinking) => {
    const trimmed = thinking.trim();
    if (trimmed.length === 0) return '';
    const quoteLines = trimmed.split('\n').map((l: string) => `> ${l}`).join('\n');
    return '\n' + makePlaceholder(`> <font color="comment">💭 思考过程：</font>\n${quoteLines}`) + '\n';
  });

  // 4. 状态指示器高亮色
  content = content.replace(/^(⚙ .+? 正在处理  ·  第 \d+ 轮)$/gm, '<font color="info"><b>$1</b></font>');
  content = content.replace(/^⏳ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?/gm, '⏳ <font color="info"><b>$1</b></font>$2');
  content = content.replace(/^✓ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?(\s+\d+(?:\.\d+)?(?:ms|s))?/gm, (_match, tool, args, dur) => {
    const durationPart = dur ? ` <font color="comment">${dur.trim()}</font>` : '';
    return `<font color="info">✅</font> <b>$tool</b>${args ?? ''}${durationPart}`;
  });
  content = content.replace(/^✗ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?/gm, '<font color="warning">❌</font> <b>$1</b>$2');

  // 5. 还原占位符
  for (let i = 0; i < placeholders.length; i++) {
    const placeholder = `\uE003P${i}\uE003`;
    const replacement = placeholders[i] ?? '';
    content = content.split(placeholder).join(replacement);
  }

  return content.trim();
}
