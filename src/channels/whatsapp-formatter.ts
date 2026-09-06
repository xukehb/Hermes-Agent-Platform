/**
 * WhatsApp 消息格式化工具。
 *
 * WhatsApp 拥有专属的轻量 Markdown 语法：
 * 1) 粗体：*bold*（单星号，非标准 Markdown 的双星号）
 * 2) 斜体：_italic_（下划线）
 * 3) 删除线：~strikethrough~（波浪线）
 * 4) 等宽代码块：```code```（支持三反引号等宽）
 * 5) 单行行内代码：`code`
 * 6) 引用块：> quote
 * 7) 超链接：不支持 [text](url) 语法，必须输出纯 URL text: url 才能被平台自动识别为可点击链接
 */

export function formatWhatsAppText(text: string): string {
  if (!text || text.trim().length === 0) {
    return text;
  }

  let content = text.replace(/\r\n/g, '\n');

  // 占位符缓存，用于保护代码块不被后续格式化规则误伤
  const placeholders: string[] = [];
  const makePlaceholder = (formatted: string): string => {
    const key = `\uE001P${placeholders.length}\uE001`;
    placeholders.push(formatted);
    return key;
  };

  // 1. 提取多行代码块 ```lang\ncode\n```
  content = content.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)(?:```|$)/g, (_match, lang, code) => {
    const cleanCode = code.endsWith('\n') ? code.slice(0, -1) : code;
    const cleanLang = (lang || '').trim().toLowerCase();
    const prefix = cleanLang ? `💻 *${cleanLang}*\n` : '';
    return makePlaceholder(`${prefix}\`\`\`\n${cleanCode}\n\`\`\``);
  });

  // 2. 提取单行行内代码 `code`
  content = content.replace(/`([^`\n]+)`/g, (_match, code) => {
    return makePlaceholder(`\`${code}\``);
  });

  // 3. 处理思考过程 [思考] ... 转换为 WhatsApp 引用块 >
  content = content.replace(/(?:^|\n)\[思考\][ \t]*([\s\S]*?)(?=(?:\n\n[^\n]|(?:\n⚙ )|(?:\n· )|$))/g, (_match, thinking) => {
    const trimmed = thinking.trim();
    if (trimmed.length === 0) return '';
    const quoteLines = trimmed.split('\n').map((l: string) => `> ${l}`).join('\n');
    return '\n' + makePlaceholder(`💭 *思考过程:*\n${quoteLines}`) + '\n';
  });

  // 4. 处理链接 [Title](url) -> Title: url（WhatsApp 自动为裸链接生成可点击效果）
  content = content.replace(/\[([^\]\n]+)\]\(((?:https?|tg):\/\/[^\s\)]+)\)/g, '$1: $2');

  // 5. 处理标题 (#, ##, ### 等) -> WhatsApp 粗体 *title*
  content = content.replace(/^(#{1,6})[ \t]+(.+)$/gm, (_match, _hashes, title) => {
    return `*${title.trim()}*`;
  });

  // 6. 处理粗斜体、粗体、斜体、删除线
  // 粗斜体 ***text*** 或 ___text___ -> *_text_*
  content = content.replace(/\*\*\*([^\n*]+?)\*\*\*/g, (_match, text) => makePlaceholder(`*_${text}_*`));
  content = content.replace(/___([^\n_]+?)___/g, (_match, text) => makePlaceholder(`*_${text}_*`));

  // 粗体 **text** 或 __text__ -> WhatsApp *text*（放入占位符避免被斜体逻辑处理）
  content = content.replace(/\*\*([^\n*]+?)\*\*/g, (_match, text) => makePlaceholder(`*${text}*`));
  content = content.replace(/__([^\n_]+?)__/g, (_match, text) => makePlaceholder(`*${text}*`));

  // 删除线 ~~text~~ -> ~text~
  content = content.replace(/~~([^\n~]+?)~~/g, '~$1~');

  // 斜体 *text* 或 _text_ -> WhatsApp _text_
  content = content.replace(/(?<=^|[^\p{L}\p{N}*])\*([^\s*][^\n*]*?[^\s*]|[^\s*])\*(?=$|[^\p{L}\p{N}*])/gu, '_$1_');

  // 7. 处理无序列表 (- item 或 * item) -> • item
  content = content.replace(/^[ \t]*[-*][ \t]+(.+)$/gm, '• $1');

  // 8. 针对平台内置命令帮助与状态的样式增强
  content = content.replace(/(【[^】]+】)/g, '*$1*');
  content = content.replace(/^(\/[a-z][a-z0-9_-]*)(\b|[ \t])/gm, '`$1`$2');

  // 进度指示器状态行优化
  // ⚙ coder 正在处理  ·  第 1 轮
  content = content.replace(/^(⚙ .+? 正在处理  ·  第 \d+ 轮)$/gm, '*$1*');

  // ⏳ 工具调用
  content = content.replace(/^⏳ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?/gm, '⏳ *$1*$2');

  // ✓ 工具成功完成
  content = content.replace(/^✓ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?(\s+\d+(?:\.\d+)?(?:ms|s))?/gm, (_match, tool, args, dur) => {
    const durationPart = dur ? ` ~${dur.trim()}~` : '';
    return `✅ *$tool*${args ?? ''}${durationPart}`;
  });

  // ✗ 工具执行异常
  content = content.replace(/^✗ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?/gm, '❌ *$1*$2');

  // ↻ 模型降级/切换指示
  content = content.replace(/^↻ ([^\s]+)\s*→\s*([^\s（(]+)(.*)$/gm, '↻ *$1* ➔ *$2*$3');

  // 终态统计底栏
  content = content.replace(/^· ([^\s·]+) · (\d+) tokens · ([a-zA-Z0-9_-]+)$/gm, (_match, model, tokens, taskId) => {
    return `—————\n🤖 *${model}*  •  📊 *${tokens}* tokens  •  🆔 \`${taskId}\``;
  });

  // 9. 还原占位符
  for (let i = 0; i < placeholders.length; i++) {
    const placeholder = `\uE001P${i}\uE001`;
    const replacement = placeholders[i] ?? '';
    content = content.split(placeholder).join(replacement);
  }

  return content.trim();
}
