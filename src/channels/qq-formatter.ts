/**
 * QQ (OneBot v11/v12) 消息格式化工具。
 *
 * QQ 移动端与桌面端不直接渲染 Markdown 标签，
 * 针对 QQ 群与私聊场景，将代码块转为精美 ASCII 线框盒，
 * 标题、状态、链接转换为视觉直观、整洁的纯文本排版。
 */

export function formatQQText(text: string): string {
  if (!text || text.trim().length === 0) {
    return text;
  }

  let content = text.replace(/\r\n/g, '\n');

  const placeholders: string[] = [];
  const makePlaceholder = (formatted: string): string => {
    const key = `\uE005P${placeholders.length}\uE005`;
    placeholders.push(formatted);
    return key;
  };

  // 1. 代码块转化为 ASCII 线框盒
  content = content.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)(?:```|$)/g, (_match, lang, code) => {
    const cleanCode = code.endsWith('\n') ? code.slice(0, -1) : code;
    const cleanLang = (lang || '代码').trim().toLowerCase();
    const lines = cleanCode.split('\n');
    const header = `┌─ [${cleanLang}] ──────────────────`;
    const body = lines.map((l: string) => `│ ${l}`).join('\n');
    const footer = `└──────────────────────────────`;
    return makePlaceholder(`${header}\n${body}\n${footer}`);
  });

  // 2. 行内代码转中文引号
  content = content.replace(/`([^`\n]+)`/g, '「$1」');

  // 3. 超链接 [Title](url) -> Title: url (QQ 平台自动识别为可点击蓝链)
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

  // 6. 粗体、斜体、删除线
  content = content.replace(/\*\*\*([^\n*]+?)\*\*\*/g, '【$1】');
  content = content.replace(/\*\*([^\n*]+?)\*\*/g, '【$1】');
  content = content.replace(/__([^\n_]+?)__/g, '【$1】');
  content = content.replace(/(?<=^|[^\p{L}\p{N}*])\*([^\s*][^\n*]*?[^\s*]|[^\s*])\*(?=$|[^\p{L}\p{N}*])/gu, '$1');
  content = content.replace(/~~([^\n~]+?)~~/g, '~$1~');

  // 7. 列表圆点化
  content = content.replace(/^[ \t]*[-*][ \t]+(.+)$/gm, '• $1');

  // 8. 进度状态指示器美化
  content = content.replace(/^(⚙ .+? 正在处理  ·  第 \d+ 轮)$/gm, '🤖 $1');
  content = content.replace(/^⏳ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?/gm, '⏳ 正在调用 [$1]$2');
  content = content.replace(/^✓ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?(\s+\d+(?:\.\d+)?(?:ms|s))?/gm, (_match, tool, args, dur) => {
    const durationPart = dur ? ` (耗时 ${dur.trim()})` : '';
    return `✅ [$tool]${args ?? ''}${durationPart}`;
  });
  content = content.replace(/^✗ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?/gm, '❌ [$1] 执行异常$2');
  content = content.replace(/^↻ ([^\s]+)\s*→\s*([^\s（(]+)(.*)$/gm, '↻ 模型切换：$1 ➔ $2$3');

  // 终态统计底栏
  content = content.replace(/^· ([^\s·]+) · (\d+) tokens · ([a-zA-Z0-9_-]+)$/gm, (_match, model, tokens, taskId) => {
    return `————————————\n🤖 模型: ${model}  |  📊 用量: ${tokens} tokens  |  🆔 任务: ${taskId}`;
  });

  // 9. 还原占位符
  for (let i = 0; i < placeholders.length; i++) {
    const placeholder = `\uE005P${i}\uE005`;
    const replacement = placeholders[i] ?? '';
    content = content.split(placeholder).join(replacement);
  }

  return content.trim();
}
