/**
 * 飞书 (Feishu / Lark) 卡片与富文本格式化工具。
 *
 * 飞书平台支持 Lark Markdown 与交互式卡片 (Interactive Card)：
 * 1) 卡片标题栏模板支持配色 (template: 'turquoise' | 'red' | 'indigo' | 'wathet' | 'orange' 等)；
 * 2) 飞书 Markdown 支持 **粗体**、*斜体*、~~删除线~~、[链接](url)、```代码块```；
 * 3) 支持通过 <font color='xxx'> 进行局部色彩强化。
 */

export interface FeishuCardContent {
  config: { wide_screen_mode: boolean };
  header: {
    template: string;
    title: { tag: 'plain_text'; content: string };
  };
  elements: Array<Record<string, unknown>>;
}

/**
 * 格式化飞书 Markdown 正文。
 */
export function formatFeishuMarkdown(text: string): string {
  if (!text || text.trim().length === 0) {
    return text;
  }

  let content = text.replace(/\r\n/g, '\n');

  // 占位符缓存
  const placeholders: string[] = [];
  const makePlaceholder = (formatted: string): string => {
    const key = `\uE004P${placeholders.length}\uE004`;
    placeholders.push(formatted);
    return key;
  };

  // 1. 保留原生多行代码块
  content = content.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)(?:```|$)/g, (_match, lang, code) => {
    const cleanCode = code.endsWith('\n') ? code.slice(0, -1) : code;
    return makePlaceholder(`\`\`\`${lang || ''}\n${cleanCode}\n\`\`\``);
  });

  // 2. 单行行内代码
  content = content.replace(/`([^`\n]+)`/g, (_match, code) => {
    return makePlaceholder(`\`${code}\``);
  });

  // 3. 处理思考过程 [思考] ... 转换为飞书引用块
  content = content.replace(/(?:^|\n)\[思考\][ \t]*([\s\S]*?)(?=(?:\n\n[^\n]|(?:\n⚙ )|(?:\n· )|$))/g, (_match, thinking) => {
    const trimmed = thinking.trim();
    if (trimmed.length === 0) return '';
    const quoteLines = trimmed.split('\n').map((l: string) => `> ${l}`).join('\n');
    return '\n' + makePlaceholder(`> 💭 **思考过程**\n${quoteLines}`) + '\n';
  });

  // 4. 状态指示器高亮美化
  content = content.replace(/^(⚙ .+? 正在处理  ·  第 \d+ 轮)$/gm, '⚙️ **$1**');
  content = content.replace(/^⏳ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?/gm, '⏳ **`$1`**$2');
  content = content.replace(/^✓ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?(\s+\d+(?:\.\d+)?(?:ms|s))?/gm, (_match, tool, args, dur) => {
    const durationPart = dur ? ` <font color='grey'>${dur.trim()}</font>` : '';
    return `✅ **\`$tool\`**${args ?? ''}${durationPart}`;
  });
  content = content.replace(/^✗ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?/gm, '❌ <font color=' + "'red'>" + '**`$1`**</font>$2');
  content = content.replace(/^↻ ([^\s]+)\s*→\s*([^\s（(]+)(.*)$/gm, '↻ `$1` ➔ `$2`$3');

  // 5. 终态统计底栏
  content = content.replace(/^· ([^\s·]+) · (\d+) tokens · ([a-zA-Z0-9_-]+)$/gm, (_match, model, tokens, taskId) => {
    return `<font color='grey'>🤖 ${model}  •  📊 ${tokens} tokens  •  🆔 ${taskId}</font>`;
  });

  // 6. 还原占位符
  for (let i = 0; i < placeholders.length; i++) {
    const placeholder = `\uE004P${i}\uE004`;
    const replacement = placeholders[i] ?? '';
    content = content.split(placeholder).join(replacement);
  }

  return content.trim();
}

/**
 * 根据消息内容语义生成对应的飞书卡片配色与标题。
 */
export function buildFeishuCard(text: string): FeishuCardContent {
  let template = 'turquoise';
  let title = 'HAP 智能体协同回执';

  const isError = /✗|❌|失败|CONTROL_FORBIDDEN|异常/i.test(text);
  const isProgress = /⚙|正在处理|⏳/.test(text);
  const isHelpOrCommand = /【项目与工作区】|开发者远程协同指令|\/help/.test(text);

  if (isError) {
    template = 'red';
    title = '❌ 智能体执行异常';
  } else if (isProgress) {
    template = 'indigo';
    title = '⚙️ 智能体处理中';
  } else if (isHelpOrCommand) {
    template = 'wathet';
    title = '📋 开发者协同指令';
  } else {
    template = 'turquoise';
    title = '✅ 智能体协同回执';
  }

  const formattedMarkdown = formatFeishuMarkdown(text);

  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    elements: [
      {
        tag: 'markdown',
        content: formattedMarkdown,
      },
      {
        tag: 'hr',
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `Hermes Agent Platform · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
          },
        ],
      },
    ],
  };
}
