/**
 * Agent 运行时标记与 Markdown 语法正则中央库。
 *
 * 保证「单一事实来源」(Single Source of Truth)，彻底解决多通道重复维护正则的问题。
 */

export const AGENT_PATTERNS = {
  /** 多行代码块 ```[lang]\n[code]\n``` */
  codeBlock: /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)(?:```|$)/g,

  /** 单行行内代码 `code` */
  inlineCode: /`([^`\n]+)`/g,

  /** 思考过程 [思考] ... */
  thinking: /(?:^|\n)\[思考\][ \t]*([\s\S]*?)(?=(?:\n\n[^\n]|(?:\n⚙ )|(?:\n· )|$))/g,

  /** 进度指示器状态行：⚙ coder 正在处理  ·  第 1 轮 */
  progressHeader: /^(⚙ .+? 正在处理  ·  第 \d+ 轮)$/gm,

  /** 工具调用开始：⏳ read_file (path="...") */
  toolStart: /^⏳ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?/gm,

  /** 工具调用成功：✓ read_file (path="...")  120ms */
  toolSuccess: /^✓ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?(\s+\d+(?:\.\d+)?(?:ms|s))?/gm,

  /** 工具调用异常：✗ write_file (path="bad") */
  toolError: /^✗ ([a-zA-Z0-9_.-]+)(\s*\(.*?\))?/gm,

  /** 模型降级或切换：↻ from → to（reason） */
  modelSwitch: /^↻ ([^\s]+)\s*→\s*([^\s（(]+)(.*)$/gm,

  /** 终态统计底栏：· model · 1234 tokens · task-1234 */
  terminalNote: /^· ([^\s·]+) · (\d+) tokens · ([a-zA-Z0-9_-]+)$/gm,

  /** 标准 Markdown 引用块：> line1\n> line2 */
  blockquote: /(?:^|\n)(>[ \t]?[^\n]*(?:\n>[ \t]?[^\n]*)*)/g,

  /** Markdown 标题：# Title 到 ###### Title */
  heading: /^(#{1,6})[ \t]+(.+)$/gm,

  /** 粗斜体：***text*** 或 ___text___ */
  boldItalicAsterisk: /\*\*\*([^\n*]+?)\*\*\*/g,
  boldItalicUnderscore: /___([^\n_]+?)___/g,

  /** 粗体：**text** 或 __text__ */
  boldAsterisk: /\*\*([^\n*]+?)\*\*/g,
  boldUnderscore: /__([^\n_]+?)__/g,

  /** 斜体：*text* 或 _text_（支持多语言标点边界，避免破坏 snake_case 变量名） */
  italicAsterisk: /(?<=^|[^\p{L}\p{N}*])\*([^\s*][^\n*]*?[^\s*]|[^\s*])\*(?=$|[^\p{L}\p{N}*])/gu,
  italicUnderscore: /(?<=^|[^\p{L}\p{N}_])_([^\s_][^\n_]*?[^\s_]|[^\s_])_(?=$|[^\p{L}\p{N}_])/gu,

  /** 删除线：~~text~~ */
  strikethrough: /~~([^\n~]+?)~~/g,

  /** 超链接：[label](url) */
  link: /\[([^\]\n]+)\]\(((?:https?|tg):\/\/[^\s\)]+)\)/g,

  /** 无序列表：- item 或 * item */
  listBullet: /^[ \t]*[-*][ \t]+(.+)$/gm,

  /** 命令小标题：【项目与工作区】 */
  bracketHeader: /(【[^】]+】)/g,

  /** 斜杠指令行首命令名：/help, /git 等 */
  commandItem: /^(\/[a-z][a-z0-9_-]*)(\b|[ \t])/gm,
} as const;
